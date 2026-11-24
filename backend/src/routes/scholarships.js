// Scholarships and financial discounts.
// A scholarship is a percentage discount or a fixed AFN amount (never
// both — enforced by the CHECK in migrations/006_scholarships.sql).
// Approval workflow on student_scholarships (one award per student per
// scholarship per year/semester):
//   pending → approved (Super Admin only) | rejected (Super Admin only)
//   approved → revoked (staff)
// Only an APPROVED award ever discounts a fee. A pending award discounts
// nothing, so Finance can record an award and the Super Admin approves it
// before any money moves.
//
// Discount application — BOTH paths, so no fee is missed whichever order
// things happen in:
//   1. Assign time: fees.js (POST /api/fees/assign) calls
//      findApprovedAward()/calcDiscount() from this file and stores the
//      fee net of the discount (amount_due = gross - discount,
//      discount_amount, student_scholarship_id).
//   2. Approval time: approving an award retroactively discounts the
//      student's already-assigned unpaid/partial fees for the matching
//      year/semester (same helpers, in one transaction as the approval).
// Revoking an award restores exactly the discount it applied, because
// only one approved award per student per period exists (partial unique
// index) and a fee's discount is attributable to one award via
// student_fees.student_scholarship_id.
//
// 003_fees.sql constrains student_fees.amount_due > 0, so a discount is
// clamped to leave at least 0.01 AFN due (a 100% scholarship leaves a
// 0.01 AFN balance; relaxing that CHECK is a 003 change, not made here).
// amount_paid and status are always re-derived from the (net) amount_due,
// exactly as fees.js does on payment/correction, so the books cannot drift.
//
// Route note: in POST /:id/approve, /:id/revoke and /:id/reject the :id is
// the AWARD id (student_scholarships.id), not the scholarship id — the
// action is taken on an award. The frontend passes award ids.
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const STAFF = ['super_admin', 'exam_officer', 'finance'];

// ---------------------------------------------------------------------------
// Shared discount helpers (also used by fees.js at assign time)
// ---------------------------------------------------------------------------

// Discount in AFN for a gross amount under one scholarship row.
// Percent: gross * pct / 100, rounded to 2dp. Fixed: the fixed amount,
// capped at the gross so the discount never exceeds the fee.
function calcDiscount(gross, scholarship) {
  const g = Number(gross);
  if (!scholarship || !(g > 0)) return 0;
  if (scholarship.discount_percent != null) {
    return Math.round(g * Number(scholarship.discount_percent)) / 100;
  }
  if (scholarship.fixed_amount != null) {
    return Math.min(Number(scholarship.fixed_amount), g);
  }
  return 0;
}

// The student's approved award that applies to a fee for this year /
// semester. An award with a NULL year/semester applies to any year /
// semester; an award with a set year/semester only matches that one.
// queryFn is `query` (pool) or a transaction client's bound query.
async function findApprovedAward(queryFn, studentId, academicYearId, semesterId) {
  const { rows } = await queryFn(
    `SELECT ss.*, s.discount_percent, s.fixed_amount, s.name AS scholarship_name
       FROM student_scholarships ss
       JOIN scholarships s ON s.id = ss.scholarship_id
      WHERE ss.student_id = $1 AND ss.status = 'approved'
        AND (ss.academic_year_id IS NULL OR ss.academic_year_id = $2)
        AND (ss.semester_id IS NULL OR ss.semester_id = $3)
      ORDER BY ss.approved_at DESC NULLS LAST, ss.id DESC
      LIMIT 1`,
    [studentId, academicYearId || null, semesterId || null],
  );
  return rows[0] || null;
}

// Status re-derived from paid vs (net) due, mirroring fees.js.
// A stored 'overdue' stays overdue unless the fee is now fully paid.
function deriveStatus(amountPaid, amountDue, currentStatus) {
  if (amountPaid >= amountDue) return 'paid';
  if (amountPaid > 0) return 'partial';
  return currentStatus === 'overdue' ? 'overdue' : 'unpaid';
}

// Apply one approved award's discount to one fee row (already locked /
// inside a transaction via client). The discount is computed on the fee's
// current amount_due and clamped so amount_due stays >= 0.01 (003 CHECK).
// Returns { discount, fee } — discount 0 means nothing was applied
// (already discounted, fully paid, or nothing left to discount).
async function applyDiscountToFee(client, fee, award) {
  const due = Number(fee.amount_due);
  const paid = Number(fee.amount_paid);
  if (fee.student_scholarship_id) return { discount: 0, fee };
  if (due - paid <= 0.01) return { discount: 0, fee };
  const raw = calcDiscount(due, award);
  const discount = Math.max(0, Math.min(raw, due - paid - 0.01));
  if (discount <= 0) return { discount: 0, fee };
  const newDue = Math.round((due - discount) * 100) / 100;
  const newDiscountTotal = Math.round((Number(fee.discount_amount || 0) + discount) * 100) / 100;
  const newStatus = deriveStatus(paid, newDue, fee.status);
  const { rows } = await client.query(
    `UPDATE student_fees
        SET amount_due = $2, discount_amount = $3,
            student_scholarship_id = $4, status = $5
      WHERE id = $1 RETURNING *`,
    [fee.id, newDue, newDiscountTotal, award.id, newStatus],
  );
  return { discount, fee: rows[0] };
}

// Reverse a discount applied by one award: restore amount_due from the
// fee's own discount_amount (which, by the one-approved-award-per-period
// rule, belongs entirely to this award) and clear the attribution.
async function restoreDiscountFromFee(client, fee) {
  const discount = Number(fee.discount_amount || 0);
  if (!discount) return { restored: 0, fee };
  const newDue = Math.round((Number(fee.amount_due) + discount) * 100) / 100;
  const newStatus = deriveStatus(Number(fee.amount_paid), newDue, fee.status);
  const { rows } = await client.query(
    `UPDATE student_fees
        SET amount_due = $2, discount_amount = 0,
            student_scholarship_id = NULL, status = $3
      WHERE id = $1 RETURNING *`,
    [fee.id, newDue, newStatus],
  );
  return { restored: discount, fee: rows[0] };
}

// Expose the helpers on the router so fees.js can require them without a
// circular import (this file never requires fees.js).
router.calcDiscount = calcDiscount;
router.findApprovedAward = findApprovedAward;
router.applyDiscountToFee = applyDiscountToFee;
router.restoreDiscountFromFee = restoreDiscountFromFee;

// The students.id for the signed-in student user (null for other roles).
async function ownStudentId(req) {
  if (req.user.role !== 'student') return null;
  const { rows } = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  return rows[0]?.id || null;
}

// One award with student / scholarship / approver names.
const AWARD_SELECT = `
  SELECT ss.*, s.name AS scholarship_name, s.discount_percent, s.fixed_amount,
         st.student_id AS student_no, st.full_name AS student_name,
         ay.name AS academic_year_name, sem.name AS semester_name,
         u.full_name AS approved_by_name
    FROM student_scholarships ss
    JOIN scholarships s ON s.id = ss.scholarship_id
    JOIN students st ON st.id = ss.student_id
    LEFT JOIN academic_years ay ON ay.id = ss.academic_year_id
    LEFT JOIN semesters sem ON sem.id = ss.semester_id
    LEFT JOIN users u ON u.id = ss.approved_by`;

function toAward(row) {
  if (!row) return row;
  return {
    ...row,
    discount_percent: row.discount_percent == null ? null : Number(row.discount_percent),
    fixed_amount: row.fixed_amount == null ? null : Number(row.fixed_amount),
  };
}

function toScholarship(row) {
  if (!row) return row;
  return {
    ...row,
    discount_percent: row.discount_percent == null ? null : Number(row.discount_percent),
    fixed_amount: row.fixed_amount == null ? null : Number(row.fixed_amount),
  };
}

// GET /api/scholarships/students — student picker for the award form
// (staff only). GET /api/students excludes finance, so the award form
// cannot use it; this endpoint returns the same students in a small
// picker shape. ?search= (name / student no. / email), ?limit= (default 100).
router.get('/students', requireRole(...STAFF), async (req, res, next) => {
  try {
    const search = (req.query.search || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE (s.full_name ILIKE $1 OR s.student_id ILIKE $1 OR s.email ILIKE $1)`;
    }
    const { rows } = await query(
      `SELECT s.id, s.student_id, s.full_name, s.email, s.status,
              d.name AS department_name
         FROM students s JOIN departments d ON d.id = s.department_id
        ${where} ORDER BY s.full_name LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// GET /api/scholarships — list scholarships (staff only).
// ?active=true returns only active ones (for the award-form picker).
router.get('/', requireRole(...STAFF), async (req, res, next) => {
  try {
    const onlyActive = req.query.active === 'true';
    const { rows } = await query(
      `SELECT s.*,
              (SELECT count(*)::int FROM student_scholarships ss WHERE ss.scholarship_id = s.id AND ss.status = 'pending') AS pending_count,
              (SELECT count(*)::int FROM student_scholarships ss WHERE ss.scholarship_id = s.id AND ss.status = 'approved') AS approved_count
         FROM scholarships s
        ${onlyActive ? 'WHERE s.is_active = TRUE' : ''}
        ORDER BY s.name`,
    );
    return res.json({ success: true, data: rows.map(toScholarship) });
  } catch (err) { return next(err); }
});

// GET /api/scholarships/awards — award list (staff only).
// Filters: ?status=pending|approved|rejected|revoked, ?student_id=,
// ?scholarship_id=, ?page&limit.
router.get('/awards', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { status, student_id, scholarship_id } = req.query;
    const where = []; const params = [];
    if (status) { params.push(status); where.push(`ss.status = $${params.length}`); }
    if (student_id) { params.push(student_id); where.push(`ss.student_id = $${params.length}`); }
    if (scholarship_id) { params.push(scholarship_id); where.push(`ss.scholarship_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM student_scholarships ss ${clause}`, params);
    const { rows } = await query(
      `${AWARD_SELECT} ${clause} ORDER BY ss.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return res.json(paginatedResponse(rows.map(toAward), total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/scholarships/student/:studentId — one student's awards.
// Staff see any student; a student sees only their own awards.
router.get('/student/:studentId', param('studentId').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const studentId = Number(req.params.studentId);
      if (req.user.role === 'student') {
        const mine = await ownStudentId(req);
        if (mine !== studentId) return res.status(403).json({ success: false, error: 'Students can only view their own scholarships' });
      } else if (!STAFF.includes(req.user.role)) {
        return res.status(403).json({ success: false, error: 'Forbidden: requires super_admin, exam_officer or finance' });
      }
      const { rows } = await query(`${AWARD_SELECT} WHERE ss.student_id = $1 ORDER BY ss.created_at DESC`, [studentId]);
      return res.json({ success: true, data: rows.map(toAward) });
    } catch (err) { return next(err); }
  });

// GET /api/scholarships/:id — one scholarship with its awards (staff only).
router.get('/:id', requireRole(...STAFF), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query('SELECT * FROM scholarships WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Scholarship not found' });
      const awards = await query(`${AWARD_SELECT} WHERE ss.scholarship_id = $1 ORDER BY ss.created_at DESC`, [req.params.id]);
      return res.json({ success: true, data: { ...toScholarship(rows[0]), awards: awards.rows.map(toAward) } });
    } catch (err) { return next(err); }
  });

// POST /api/scholarships — create a scholarship (staff only).
// Body: { name, description?, discount_percent? | fixed_amount?, is_active? }
// Exactly one of discount_percent / fixed_amount is required.
router.post('/', requireRole(...STAFF),
  [body('name').trim().isLength({ min: 3, max: 100 }),
   body('description').optional().trim(),
   body('discount_percent').optional().isFloat({ min: 0.01, max: 100 }),
   body('fixed_amount').optional().isFloat({ min: 0.01 }),
   body('is_active').optional().isBoolean()], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const hasPercent = b.discount_percent !== undefined && b.discount_percent !== null && b.discount_percent !== '';
      const hasFixed = b.fixed_amount !== undefined && b.fixed_amount !== null && b.fixed_amount !== '';
      if (hasPercent === hasFixed) {
        return res.status(400).json({ success: false, error: 'Provide exactly one of discount_percent or fixed_amount' });
      }
      const { rows } = await query(
        `INSERT INTO scholarships (name, description, discount_percent, fixed_amount, is_active)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.name, b.description || null, hasPercent ? b.discount_percent : null,
         hasFixed ? b.fixed_amount : null, b.is_active !== undefined ? b.is_active : true]);
      await logAudit({ userId: req.user.id, action: 'scholarships.create', entityType: 'scholarships', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: toScholarship(rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, error: 'A scholarship with that name already exists' });
      return next(err);
    }
  });

// PATCH /api/scholarships/:id — edit a scholarship or activate/deactivate
// it (staff only). Only the fields sent are changed; the one-discount-type
// rule is re-checked against the merged row.
router.patch('/:id', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('name').optional().trim().isLength({ min: 3, max: 100 }),
   body('description').optional().trim(),
   body('discount_percent').optional().isFloat({ min: 0.01, max: 100 }),
   body('fixed_amount').optional().isFloat({ min: 0.01 }),
   body('is_active').optional().isBoolean()], validate,
  async (req, res, next) => {
    try {
      const current = await query('SELECT * FROM scholarships WHERE id = $1', [req.params.id]);
      if (!current.rows[0]) return res.status(404).json({ success: false, error: 'Scholarship not found' });
      const merged = { ...current.rows[0], ...req.body };
      // Explicitly clearing one side: sending the other side replaces it.
      if (req.body.discount_percent !== undefined) merged.fixed_amount = null;
      if (req.body.fixed_amount !== undefined) merged.discount_percent = null;
      const hasPercent = merged.discount_percent != null;
      const hasFixed = merged.fixed_amount != null;
      if (hasPercent === hasFixed) {
        return res.status(400).json({ success: false, error: 'A scholarship needs exactly one of discount_percent or fixed_amount' });
      }
      const sets = []; const params = [];
      for (const f of ['name', 'description', 'discount_percent', 'fixed_amount', 'is_active']) {
        if (req.body[f] !== undefined || (f === 'discount_percent' && req.body.fixed_amount !== undefined) || (f === 'fixed_amount' && req.body.discount_percent !== undefined)) {
          params.push(merged[f] === undefined ? null : merged[f]); sets.push(`${f} = $${params.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
      params.push(req.params.id);
      const { rows } = await query(
        `UPDATE scholarships SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      await logAudit({ userId: req.user.id, action: 'scholarships.update', entityType: 'scholarships', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: toScholarship(rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, error: 'A scholarship with that name already exists' });
      return next(err);
    }
  });

// POST /api/scholarships/:id/award — create a PENDING award of this
// scholarship for a student (staff only; normally Finance).
// Body: { student_id, academic_year_id?, semester_id? }.
// The award discounts nothing until the Super Admin approves it.
router.post('/:id/award', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('student_id').isInt({ min: 1 }),
   body('academic_year_id').optional().isInt({ min: 1 }),
   body('semester_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const scholarship = await query('SELECT * FROM scholarships WHERE id = $1', [req.params.id]);
      if (!scholarship.rows[0]) return res.status(404).json({ success: false, error: 'Scholarship not found' });
      if (!scholarship.rows[0].is_active) return res.status(400).json({ success: false, error: 'Scholarship is inactive' });
      const student = await query('SELECT * FROM students WHERE id = $1', [req.body.student_id]);
      if (!student.rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      if (req.body.academic_year_id) {
        const year = await query('SELECT id FROM academic_years WHERE id = $1', [req.body.academic_year_id]);
        if (!year.rows[0]) return res.status(400).json({ success: false, error: 'Academic year not found' });
      }
      if (req.body.semester_id) {
        const sem = await query('SELECT id FROM semesters WHERE id = $1', [req.body.semester_id]);
        if (!sem.rows[0]) return res.status(400).json({ success: false, error: 'Semester not found' });
      }
      const { rows } = await query(
        `INSERT INTO student_scholarships (student_id, scholarship_id, academic_year_id, semester_id, status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
        [req.body.student_id, req.params.id, req.body.academic_year_id || null, req.body.semester_id || null]);
      await logAudit({ userId: req.user.id, action: 'scholarships.award', entityType: 'student_scholarships', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: toAward({ ...rows[0], scholarship_name: scholarship.rows[0].name, discount_percent: scholarship.rows[0].discount_percent, fixed_amount: scholarship.rows[0].fixed_amount, student_no: student.rows[0].student_id, student_name: student.rows[0].full_name }) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, error: 'This student already has a pending or approved award of this scholarship for that year/semester' });
      return next(err);
    }
  });

// POST /api/scholarships/:id/approve — approve a PENDING award
// (Super Admin only). :id is the AWARD id. Sets approved_by / approved_at
// and applies the discount to the student's already-assigned unpaid /
// partial fees for the matching year/semester, in the same transaction
// as the approval, so approval and discount can never drift apart.
router.post('/:id/approve', requireRole('super_admin'), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const result = await withTransaction(async (client) => {
        const awardRes = await client.query(
          `SELECT ss.*, s.discount_percent, s.fixed_amount, s.name AS scholarship_name
             FROM student_scholarships ss
             JOIN scholarships s ON s.id = ss.scholarship_id
            WHERE ss.id = $1 FOR UPDATE`, [req.params.id]);
        const award = awardRes.rows[0];
        if (!award) return { status: 404, body: { success: false, error: 'Award not found' } };
        if (award.status !== 'pending') {
          return { status: 409, body: { success: false, error: `Only a pending award can be approved (this one is ${award.status})` } };
        }
        // One approved award per student per period — the partial unique
        // index enforces exact-period uniqueness as a backstop; check
        // here for overlapping periods (a NULL year/semester award covers
        // every year/semester, so it clashes with any award for the
        // student) for a clear 409 message.
        const clash = await client.query(
          `SELECT id FROM student_scholarships
            WHERE student_id = $1 AND status = 'approved' AND id <> $2
              AND ($3::int IS NULL OR academic_year_id IS NULL OR academic_year_id = $3)
              AND ($4::int IS NULL OR semester_id IS NULL OR semester_id = $4) LIMIT 1`,
          [award.student_id, award.id, award.academic_year_id, award.semester_id]);
        if (clash.rows[0]) {
          return { status: 409, body: { success: false, error: 'This student already has an approved scholarship for that year/semester — revoke it before approving another' } };
        }
        const updated = await client.query(
          `UPDATE student_scholarships
              SET status = 'approved', approved_by = $2, approved_at = now()
            WHERE id = $1 RETURNING *`,
          [award.id, req.user.id]);
        const approved = { ...updated.rows[0], discount_percent: award.discount_percent, fixed_amount: award.fixed_amount, scholarship_name: award.scholarship_name };
        // Retroactive discount: the student's existing unpaid/partial fees
        // for the matching year/semester that have no discount yet.
        const fees = await client.query(
          `SELECT * FROM student_fees
            WHERE student_id = $1 AND status IN ('unpaid','partial')
              AND student_scholarship_id IS NULL
              AND ($2::int IS NULL OR academic_year_id = $2)
              AND ($3::int IS NULL OR semester_id = $3)
            ORDER BY due_date ASC NULLS LAST, id ASC FOR UPDATE`,
          [award.student_id, award.academic_year_id, award.semester_id]);
        let feesUpdated = 0;
        let totalDiscount = 0;
        for (const fee of fees.rows) {
          const { discount } = await applyDiscountToFee(client, fee, approved);
          if (discount > 0) { feesUpdated += 1; totalDiscount = Math.round((totalDiscount + discount) * 100) / 100; }
        }
        return { status: 200, body: { success: true, data: { ...toAward(approved), fees_updated: feesUpdated, total_discount: totalDiscount } } };
      });
      if (result.status === 200) {
        await logAudit({ userId: req.user.id, action: 'scholarships.approve', entityType: 'student_scholarships', entityId: Number(req.params.id), newValues: result.body.data, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, error: 'This student already has an approved scholarship for that year/semester' });
      return next(err);
    }
  });

// POST /api/scholarships/:id/reject — reject a PENDING award
// (Super Admin only). :id is the AWARD id. A rejected award discounts
// nothing and does not block a fresh award for the same scholarship.
router.post('/:id/reject', requireRole('super_admin'), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE student_scholarships SET status = 'rejected'
          WHERE id = $1 AND status = 'pending' RETURNING *`, [req.params.id]);
      if (!rows[0]) {
        const exists = await query('SELECT status FROM student_scholarships WHERE id = $1', [req.params.id]);
        if (!exists.rows[0]) return res.status(404).json({ success: false, error: 'Award not found' });
        return res.status(409).json({ success: false, error: `Only a pending award can be rejected (this one is ${exists.rows[0].status})` });
      }
      await logAudit({ userId: req.user.id, action: 'scholarships.reject', entityType: 'student_scholarships', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: toAward(rows[0]) });
    } catch (err) { return next(err); }
  });

// POST /api/scholarships/:id/revoke — revoke an APPROVED award (staff).
// :id is the AWARD id. Restores the exact discount the award applied to
// the student's fees (amount_due += discount_amount, attribution cleared,
// status re-derived), in the same transaction as the revocation.
router.post('/:id/revoke', requireRole(...STAFF), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const result = await withTransaction(async (client) => {
        const awardRes = await client.query(
          'SELECT * FROM student_scholarships WHERE id = $1 FOR UPDATE', [req.params.id]);
        const award = awardRes.rows[0];
        if (!award) return { status: 404, body: { success: false, error: 'Award not found' } };
        if (award.status !== 'approved') {
          return { status: 409, body: { success: false, error: `Only an approved award can be revoked (this one is ${award.status})` } };
        }
        const updated = await client.query(
          `UPDATE student_scholarships SET status = 'revoked' WHERE id = $1 RETURNING *`, [award.id]);
        const fees = await client.query(
          `SELECT * FROM student_fees WHERE student_scholarship_id = $1 FOR UPDATE`, [award.id]);
        let feesRestored = 0;
        let totalRestored = 0;
        for (const fee of fees.rows) {
          const { restored } = await restoreDiscountFromFee(client, fee);
          if (restored > 0) { feesRestored += 1; totalRestored = Math.round((totalRestored + restored) * 100) / 100; }
        }
        return { status: 200, body: { success: true, data: { ...toAward(updated.rows[0]), fees_restored: feesRestored, total_restored: totalRestored } } };
      });
      if (result.status === 200) {
        await logAudit({ userId: req.user.id, action: 'scholarships.revoke', entityType: 'student_scholarships', entityId: Number(req.params.id), newValues: result.body.data, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

module.exports = router;
