// Fines and penalties — record a fine for a student, waive it, mark it
// paid, and report outstanding fines. Amounts are in AFN (display
// convention; the DB stores plain NUMERIC).
// A fine lives in its own `fines` table, NOT in student_fees (see
// migrations/006_fines.sql): reusing student_fees would pollute fee
// totals and the Fees report. Payment is recorded on the fines row
// itself (status 'paid' + paid_at) — fee_payments.student_fee_id is
// NOT NULL and references student_fees, so routing a fine payment
// through it would require fabricating a student_fees row per fine.
// Fine receipts (migration 009): a fine payment DOES get a receipt
// number now — REC-YYYY-NNNN from the SAME fee_receipt_seq sequence as
// fee payments, so a receipt number is never issued twice across fees
// and fines. No separate fine receipt sequence.
// Status flow: outstanding → paid, or outstanding → waived. A waived
// fine is excluded from every outstanding total (all totals sum only
// status = 'outstanding'). "Overdue" is computed from due_date, never
// stored. No late-fee automation and no scheduled jobs exist anywhere
// in this module: fines are only created manually by staff.
// Students see ONLY their own fines, via GET /api/fines/mine below —
// staff endpoints stay staff-only.
const express = require('express');
const { body, param } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const STAFF = ['super_admin', 'exam_officer', 'finance'];

// One fine row with student / fee-type / department names and the user
// who waived it; overdue is derived from due_date so it needs no job.
const FINE_SELECT = `
  SELECT f.*, s.student_id AS student_no, s.full_name AS student_name,
         s.email AS student_email, d.name AS department_name,
         ft.name AS fee_type_name,
         w.full_name AS waived_by_name, c.full_name AS created_by_name,
         CASE WHEN f.due_date < CURRENT_DATE AND f.status = 'outstanding'
              THEN 'overdue' ELSE f.status END AS display_status
    FROM fines f
    JOIN students s ON s.id = f.student_id
    LEFT JOIN departments d ON d.id = s.department_id
    LEFT JOIN fee_types ft ON ft.id = f.fee_type_id
    LEFT JOIN users w ON w.id = f.waived_by
    LEFT JOIN users c ON c.id = f.created_by`;

function toFine(r) {
  return { ...r, amount: Number(r.amount) };
}

// GET /api/fines/outstanding — outstanding totals (staff only).
// Filters: ?department_id=. Always returns totals plus a per-department
// breakdown (grouped by the student's department). Waived and paid fines
// are never counted here — only status = 'outstanding'.
// NOTE: this route must stay above GET /:id, or "outstanding" would be
// parsed as an :id.
router.get('/outstanding', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { department_id } = req.query;
    const where = [`f.status = 'outstanding'`];
    const params = [];
    if (department_id) {
      params.push(department_id);
      where.push(`s.department_id = $${params.length}`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const totals = await query(
      `SELECT COUNT(*)::int AS outstanding_count,
              COALESCE(SUM(f.amount),0)::float AS outstanding_amount,
              COUNT(*) FILTER (WHERE f.due_date < CURRENT_DATE)::int AS overdue_count,
              COALESCE(SUM(f.amount) FILTER (WHERE f.due_date < CURRENT_DATE),0)::float AS overdue_amount
         FROM fines f JOIN students s ON s.id = f.student_id ${clause}`,
      params,
    );
    const byDepartment = await query(
      `SELECT d.id AS department_id, d.name AS department_name,
              COUNT(*)::int AS outstanding_count,
              COALESCE(SUM(f.amount),0)::float AS outstanding_amount,
              COUNT(*) FILTER (WHERE f.due_date < CURRENT_DATE)::int AS overdue_count
         FROM fines f JOIN students s ON s.id = f.student_id
         LEFT JOIN departments d ON d.id = s.department_id
        ${clause}
        GROUP BY d.id, d.name ORDER BY outstanding_amount DESC`,
      params,
    );
    return res.json({
      success: true,
      data: { totals: totals.rows[0], by_department: byDepartment.rows },
    });
  } catch (err) { return next(err); }
});

// GET /api/fines — list fines (staff only).
// Filters: ?status=outstanding|paid|waived|overdue, ?student_id=,
// ?department_id=, ?search= (student name / STU number / reason),
// ?page&limit.
router.get('/', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { status, student_id, department_id, search } = req.query;
    const where = [];
    const params = [];
    if (status) {
      if (status === 'overdue') {
        where.push(`f.due_date < CURRENT_DATE AND f.status = 'outstanding'`);
      } else if (['outstanding', 'paid', 'waived'].includes(status)) {
        params.push(status);
        where.push(`f.status = $${params.length}`);
      } else {
        return res.status(400).json({ success: false, error: 'Invalid status filter: use outstanding, paid, waived or overdue' });
      }
    }
    if (student_id) { params.push(student_id); where.push(`f.student_id = $${params.length}`); }
    if (department_id) { params.push(department_id); where.push(`s.department_id = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(s.full_name ILIKE $${params.length} OR s.student_id ILIKE $${params.length} OR f.reason ILIKE $${params.length})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(
      `SELECT count(*)::int AS n FROM fines f JOIN students s ON s.id = f.student_id ${clause}`,
      params,
    );
    const { rows } = await query(
      `${FINE_SELECT} ${clause} ORDER BY f.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return res.json(paginatedResponse(rows.map(toFine), total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/fines/mine — the signed-in student's OWN fines only
// (any status; outstanding totals included). Staff must use GET /api/fines.
// NOTE: this route must stay above GET /:id, or "mine" would be parsed
// as an :id.
router.get('/mine', async (req, res, next) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ success: false, error: 'Students only' });
    const { rows: me } = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
    const mine = me[0]?.id;
    if (!mine) return res.status(404).json({ success: false, error: 'No student profile is linked to your account' });
    const { page, limit, offset } = pagination(req);
    const where = ['f.student_id = $1'];
    const params = [mine];
    if (req.query.status) {
      if (req.query.status === 'overdue') {
        where.push(`f.due_date < CURRENT_DATE AND f.status = 'outstanding'`);
      } else if (['outstanding', 'paid', 'waived'].includes(req.query.status)) {
        params.push(req.query.status);
        where.push(`f.status = $${params.length}`);
      } else {
        return res.status(400).json({ success: false, error: 'Invalid status filter: use outstanding, paid, waived or overdue' });
      }
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = await query(
      `SELECT count(*)::int AS n FROM fines f ${clause}`, params);
    const { rows } = await query(
      `${FINE_SELECT} ${clause} ORDER BY f.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const totals = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'outstanding')::int AS outstanding_count,
              COALESCE(SUM(amount) FILTER (WHERE status = 'outstanding'), 0)::float AS outstanding_amount,
              COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count
         FROM fines WHERE student_id = $1`, [mine]);
    return res.json({ ...paginatedResponse(rows.map(toFine), total.rows[0].n, { page, limit }), totals: totals.rows[0] });
  } catch (err) { return next(err); }
});

// GET /api/fines/:id — one fine (staff only).
router.get('/:id', requireRole(...STAFF), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(`${FINE_SELECT} WHERE f.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Fine not found' });
      return res.json({ success: true, data: toFine(rows[0]) });
    } catch (err) { return next(err); }
  });

// POST /api/fines — record a fine for a student (staff only).
// Body: { student_id, reason, amount, due_date?, fee_type_id? }
router.post('/', requireRole(...STAFF),
  [body('student_id').isInt({ min: 1 }),
   body('reason').trim().isLength({ min: 3, max: 500 }),
   body('amount').isFloat({ min: 0.01 }),
   body('due_date').optional().isISO8601(),
   body('fee_type_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const student = await query('SELECT id, student_id, full_name FROM students WHERE id = $1', [b.student_id]);
      if (!student.rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      if (b.fee_type_id) {
        const type = await query('SELECT id FROM fee_types WHERE id = $1 AND is_active = TRUE', [b.fee_type_id]);
        if (!type.rows[0]) return res.status(404).json({ success: false, error: 'Fee type not found or inactive' });
      }
      const { rows } = await query(
        `INSERT INTO fines (student_id, fee_type_id, reason, amount, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.student_id, b.fee_type_id || null, b.reason.trim(), b.amount,
         b.due_date || null, req.user.id]);
      await logAudit({ userId: req.user.id, action: 'fines.create', entityType: 'fines', entityId: rows[0].id, newValues: rows[0], req });
      const created = await query(`${FINE_SELECT} WHERE f.id = $1`, [rows[0].id]);
      return res.status(201).json({ success: true, data: toFine(created.rows[0]) });
    } catch (err) { return next(err); }
  });

// POST /api/fines/:id/waive — waive an outstanding fine (staff only).
// Sets status 'waived' + waived_by. Only an outstanding fine can be
// waived; a paid or already-waived fine is rejected (409).
router.post('/:id/waive', requireRole(...STAFF), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE fines SET status = 'waived', waived_by = $2
          WHERE id = $1 AND status = 'outstanding' RETURNING *`,
        [req.params.id, req.user.id]);
      if (!rows[0]) {
        const existing = await query('SELECT id, status FROM fines WHERE id = $1', [req.params.id]);
        if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'Fine not found' });
        return res.status(409).json({ success: false, error: `Only an outstanding fine can be waived (this fine is ${existing.rows[0].status})` });
      }
      await logAudit({ userId: req.user.id, action: 'fines.waive', entityType: 'fines', entityId: rows[0].id, newValues: rows[0], req });
      const waived = await query(`${FINE_SELECT} WHERE f.id = $1`, [rows[0].id]);
      return res.json({ success: true, data: toFine(waived.rows[0]) });
    } catch (err) { return next(err); }
  });

// POST /api/fines/:id/pay — mark an outstanding fine paid in full
// (staff only). Payment is recorded on the fines row itself
// (status 'paid' + paid_at); no fee_payments row is created — see the
// header note. A receipt IS issued now (migration 009): REC-YYYY-NNNN
// from the shared fee_receipt_seq sequence, stored in fines.receipt_no,
// together with the payment method (default 'cash'). Only an
// outstanding fine can be paid.
router.post('/:id/pay', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('payment_method').optional().isIn(['cash', 'bank', 'mobile_money', 'other', 'online'])], validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE fines SET status = 'paid', paid_at = now(),
                receipt_no = (SELECT 'REC-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('fee_receipt_seq')::text, 4, '0')),
                payment_method = $2
          WHERE id = $1 AND status = 'outstanding' RETURNING *`,
        [req.params.id, req.body.payment_method || 'cash']);
      if (!rows[0]) {
        const existing = await query('SELECT id, status FROM fines WHERE id = $1', [req.params.id]);
        if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'Fine not found' });
        return res.status(409).json({ success: false, error: `Only an outstanding fine can be marked paid (this fine is ${existing.rows[0].status})` });
      }
      await logAudit({ userId: req.user.id, action: 'fines.pay', entityType: 'fines', entityId: rows[0].id, newValues: rows[0], req });
      const paid = await query(`${FINE_SELECT} WHERE f.id = $1`, [rows[0].id]);
      return res.json({ success: true, data: toFine(paid.rows[0]) });
    } catch (err) { return next(err); }
  });

module.exports = router;
