// Fees — fee types, student fees, payments, due list and report.
// Amounts are in AFN (display convention; the DB stores plain NUMERIC).
// Status flow: unpaid → partial → paid. "overdue" is computed by the
// read endpoints (due_date passed, still unpaid/partial) — it is stored
// only if an operator explicitly marks it, and the API never relies on
// a nightly job. A fee may be paid in instalments; a payment can never
// exceed the remaining balance. Receipt numbers are REC-YYYY-NNNN from
// the fee_receipt_seq sequence (see migrations/003_fees.sql).
// Students may only see their own fees; lecturers have no access here.
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
// Scholarship discount at assign time (see routes/scholarships.js: the
// same discount is applied retroactively when an award is approved, so a
// fee is discounted whichever happens first — assignment or approval).
const { findApprovedAward, calcDiscount } = require('./scholarships');

const router = express.Router();
router.use(authenticate);

const STAFF = ['super_admin', 'exam_officer', 'finance'];

// The students.id for the signed-in student user (null for other roles).
async function ownStudentId(req) {
  if (req.user.role !== 'student') return null;
  const { rows } = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  return rows[0]?.id || null;
}

// Resolve a student identifier to the internal students.id: the public
// student number ("001") wins when it matches, otherwise a bare number is
// the internal record id. Returns null when nothing matches.
async function resolveStudentPk(raw) {
  const byCode = await query('SELECT id FROM students WHERE student_id = $1', [raw]);
  if (byCode.rows.length) return byCode.rows[0].id;
  if (/^\d+$/.test(raw)) return Number(raw);
  return null;
}

// One fee row with student/fee-type names and the computed balance;
// overdue is derived from due_date so it needs no background job.
const FEE_SELECT = `
  SELECT sf.*, s.student_id, s.full_name AS student_name, s.email AS student_email,
         d.name AS department_name, ft.name AS fee_type_name,
         (sf.amount_due - sf.amount_paid) AS balance,
         CASE WHEN sf.due_date < CURRENT_DATE AND sf.status IN ('unpaid','partial')
              THEN 'overdue' ELSE sf.status END AS display_status
    FROM student_fees sf
    JOIN students s ON s.id = sf.student_id
    JOIN fee_types ft ON ft.id = sf.fee_type_id
    LEFT JOIN departments d ON d.id = s.department_id`;

// GET /api/fees/types — fee types (any authenticated role; students see
// the list so they can recognise what they are being charged for).
router.get('/types', async (req, res, next) => {
  try {
    const onlyActive = req.query.active === 'true';
    const { rows } = await query(
      `SELECT ft.*, d.name AS department_name FROM fee_types ft
         LEFT JOIN departments d ON d.id = ft.department_id
        ${onlyActive ? 'WHERE ft.is_active = TRUE' : ''}
        ORDER BY ft.name`,
    );
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// POST /api/fees/types — create a fee type (staff only).
router.post('/types', requireRole(...STAFF),
  [body('name').trim().isLength({ min: 3, max: 100 }),
   body('amount').isFloat({ min: 0.01 }),
   body('description').optional().trim(),
   body('department_id').optional().isInt({ min: 1 }),
   body('semester_id').optional().isInt({ min: 1 }),
   body('academic_year_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const { rows } = await query(
        `INSERT INTO fee_types (name, description, amount, department_id, semester_id, academic_year_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.name, b.description || null, b.amount, b.department_id || null,
         b.semester_id || null, b.academic_year_id || null]);
      await logAudit({ userId: req.user.id, action: 'fees.type_create', entityType: 'fee_types', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// GET /api/fees/student/:studentId — one student's fees + their payments.
// Staff see any student; a student sees only their own record.
// Accepts the public student number ("001") or the internal record id.
router.get('/student/:studentId', param('studentId').trim().notEmpty(), validate,
  async (req, res, next) => {
    try {
      const studentId = await resolveStudentPk(req.params.studentId.trim());
      if (studentId === null) return res.status(404).json({ success: false, error: 'Student not found' });
      if (req.user.role === 'student') {
        const mine = await ownStudentId(req);
        if (mine !== studentId) return res.status(403).json({ success: false, error: 'Students can only view their own fees' });
      } else if (!STAFF.includes(req.user.role)) {
        return res.status(403).json({ success: false, error: 'Forbidden: requires super_admin, exam_officer or finance' });
      }
      const { rows } = await query(`${FEE_SELECT} WHERE sf.student_id = $1 ORDER BY sf.due_date ASC NULLS LAST, sf.created_at DESC`, [studentId]);
      const fees = rows.map((r) => ({ ...r, amount_due: Number(r.amount_due), amount_paid: Number(r.amount_paid), balance: Number(r.balance) }));
      for (const fee of fees) {
        const pays = await query(
          'SELECT * FROM fee_payments WHERE student_fee_id = $1 ORDER BY payment_date DESC, id DESC', [fee.id]);
        fee.payments = pays.rows.map((p) => ({ ...p, amount: Number(p.amount) }));
      }
      const totals = fees.reduce((t, f) => ({
        total_due: t.total_due + f.amount_due,
        total_paid: t.total_paid + f.amount_paid,
        outstanding: t.outstanding + f.balance,
      }), { total_due: 0, total_paid: 0, outstanding: 0 });
      return res.json({ success: true, data: { fees, totals } });
    } catch (err) { return next(err); }
  });

// GET /api/fees/due — unpaid / partial / overdue fees (staff only).
// Filters: ?status=unpaid|partial|overdue|paid, ?search= (name / student no.),
// ?department_id=, ?semester_id=, ?page&limit.
router.get('/due', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { status, search, department_id, semester_id } = req.query;
    const where = []; const params = [];
    if (status) {
      if (status === 'overdue') {
        where.push(`sf.due_date < CURRENT_DATE AND sf.status IN ('unpaid','partial')`);
      } else { params.push(status); where.push(`sf.status = $${params.length}`); }
    } else {
      where.push(`sf.status IN ('unpaid','partial')`);
    }
    if (search) { params.push(`%${search}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.student_id ILIKE $${params.length})`); }
    if (department_id) { params.push(department_id); where.push(`s.department_id = $${params.length}`); }
    if (semester_id) { params.push(semester_id); where.push(`sf.semester_id = $${params.length}`); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = await query(`SELECT count(*)::int AS n FROM student_fees sf JOIN students s ON s.id = sf.student_id ${clause}`, params);
    const { rows } = await query(
      `${FEE_SELECT} ${clause} ORDER BY sf.due_date ASC NULLS LAST, sf.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    const data = rows.map((r) => ({ ...r, amount_due: Number(r.amount_due), amount_paid: Number(r.amount_paid), balance: Number(r.balance) }));
    return res.json(paginatedResponse(data, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/fees/report — totals collected / due / outstanding (staff only).
// Filters: ?department_id=, ?semester_id=, ?academic_year_id=.
router.get('/report', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { department_id, semester_id, academic_year_id } = req.query;
    const where = []; const params = [];
    if (department_id) { params.push(department_id); where.push(`s.department_id = $${params.length}`); }
    if (semester_id) { params.push(semester_id); where.push(`sf.semester_id = $${params.length}`); }
    if (academic_year_id) { params.push(academic_year_id); where.push(`sf.academic_year_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totals = await query(
      `SELECT COALESCE(SUM(sf.amount_due),0)::float AS total_due,
              COALESCE(SUM(sf.amount_paid),0)::float AS total_collected,
              COALESCE(SUM(sf.amount_due - sf.amount_paid),0)::float AS outstanding,
              COUNT(*)::int AS fee_count,
              COUNT(*) FILTER (WHERE sf.status = 'paid')::int AS paid_count,
              COUNT(*) FILTER (WHERE sf.status IN ('unpaid','partial'))::int AS unpaid_count
         FROM student_fees sf JOIN students s ON s.id = sf.student_id ${clause}`, params);
    const byType = await query(
      `SELECT ft.name AS fee_type, COALESCE(SUM(sf.amount_due),0)::float AS total_due,
              COALESCE(SUM(sf.amount_paid),0)::float AS total_collected,
              COALESCE(SUM(sf.amount_due - sf.amount_paid),0)::float AS outstanding,
              COUNT(*)::int AS fee_count
         FROM student_fees sf JOIN fee_types ft ON ft.id = sf.fee_type_id
         JOIN students s ON s.id = sf.student_id ${clause}
        GROUP BY ft.name ORDER BY total_due DESC`, params);
    return res.json({ success: true, data: { totals: totals.rows[0], by_fee_type: byType.rows } });
  } catch (err) { return next(err); }
});

// POST /api/fees/assign — charge a fee type to one student, or to a whole
// department/semester cohort at once (staff only).
// Body: { fee_type_id, amount? (defaults to the fee type's amount),
//         student_id? | department_id?, semester_id?, academic_year_id?, due_date? }
// student_id accepts the public student number ("001") or the internal
// record id. Exactly one of student_id / department_id is required.
router.post('/assign', requireRole(...STAFF),
  [body('fee_type_id').isInt({ min: 1 }),
   body('amount').optional().isFloat({ min: 0.01 }),
   body('student_id').optional().trim().notEmpty(),
   body('department_id').optional().isInt({ min: 1 }),
   body('semester_id').optional().isInt({ min: 1 }),
   body('academic_year_id').optional().isInt({ min: 1 }),
   body('due_date').optional().isISO8601()], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      if ((!b.student_id && !b.department_id) || (b.student_id && b.department_id)) {
        return res.status(400).json({ success: false, error: 'Provide exactly one of student_id or department_id' });
      }
      const type = await query('SELECT * FROM fee_types WHERE id = $1 AND is_active = TRUE', [b.fee_type_id]);
      if (!type.rows[0]) return res.status(404).json({ success: false, error: 'Fee type not found or inactive' });
      // student_id may be the public student number ("001") or the
      // internal record id — resolve it to the internal id before using
      // it as a foreign key.
      let targetStudentId = null;
      if (b.student_id !== undefined && b.student_id !== null && b.student_id !== '') {
        targetStudentId = await resolveStudentPk(String(b.student_id).trim());
        if (targetStudentId === null) return res.status(404).json({ success: false, error: 'Student not found' });
      }
      const amount = b.amount || Number(type.rows[0].amount);
      // Approved scholarship for this student + year/semester? Store the
      // fee net of the discount (amount_due = gross - discount). The
      // discount is clamped so amount_due stays >= 0.01 (003 CHECK
      // amount_due > 0); a 100% scholarship leaves a 0.01 AFN balance.
      async function discounted(studentId, gross) {
        const award = await findApprovedAward(query, studentId, b.academic_year_id || null, b.semester_id || null);
        if (!award) return { net: gross, discount: 0, awardId: null };
        const discount = Math.max(0, Math.min(calcDiscount(gross, award), gross - 0.01));
        return { net: Math.round((gross - discount) * 100) / 100, discount, awardId: award.id };
      }
      let created;
      if (targetStudentId) {
        const d = await discounted(targetStudentId, amount);
        const { rows } = await query(
          `INSERT INTO student_fees (student_id, fee_type_id, amount_due, discount_amount, student_scholarship_id, due_date, academic_year_id, semester_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (student_id, fee_type_id, COALESCE(academic_year_id,0), COALESCE(semester_id,0)) DO NOTHING
           RETURNING *`,
          [targetStudentId, b.fee_type_id, d.net, d.discount, d.awardId, b.due_date || null,
           b.academic_year_id || null, b.semester_id || null]);
        created = rows;
        if (!created.length) return res.status(409).json({ success: false, error: 'This fee is already assigned to the student for that year/semester' });
      } else {
        // Cohort assign: semester_id is the semesters-table PK, but
        // students.current_semester is the programme semester number
        // (1–8), so resolve the PK to its number first — comparing the
        // two directly matched almost nobody.
        let semesterNumber = null;
        if (b.semester_id) {
          const sem = await query('SELECT semester_number FROM semesters WHERE id = $1', [b.semester_id]);
          if (!sem.rows[0]) return res.status(400).json({ success: false, error: 'Semester not found' });
          semesterNumber = sem.rows[0].semester_number;
        }
        const cohort = await query(
          `SELECT id FROM students WHERE department_id = $1 AND status = 'active'
            ${semesterNumber !== null ? 'AND current_semester = $2' : ''}`,
          semesterNumber !== null ? [b.department_id, semesterNumber] : [b.department_id]);
        created = [];
        for (const s of cohort.rows) {
          const d = await discounted(s.id, amount);
          const { rows } = await query(
            `INSERT INTO student_fees (student_id, fee_type_id, amount_due, discount_amount, student_scholarship_id, due_date, academic_year_id, semester_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (student_id, fee_type_id, COALESCE(academic_year_id,0), COALESCE(semester_id,0)) DO NOTHING
             RETURNING *`,
            [s.id, b.fee_type_id, d.net, d.discount, d.awardId, b.due_date || null,
             b.academic_year_id || null, b.semester_id || null]);
          if (rows[0]) created.push(rows[0]);
        }
      }
      await logAudit({ userId: req.user.id, action: 'fees.assign', entityType: 'student_fees', newValues: { fee_type_id: b.fee_type_id, count: created.length }, req });
      return res.status(201).json({ success: true, data: created, count: created.length });
    } catch (err) { return next(err); }
  });

// PATCH /api/fees/types/:id — edit a fee type or activate/deactivate it
// (staff only). Only the fields sent are changed.
router.patch('/types/:id', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('name').optional().trim().isLength({ min: 3, max: 100 }),
   body('amount').optional().isFloat({ min: 0.01 }),
   body('description').optional().trim(),
   body('is_active').optional().isBoolean()], validate,
  async (req, res, next) => {
    try {
      const sets = []; const params = [];
      for (const f of ['name', 'amount', 'description', 'is_active']) {
        if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
      params.push(req.params.id);
      const { rows } = await query(
        `UPDATE fee_types SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Fee type not found' });
      await logAudit({ userId: req.user.id, action: 'fees.type_update', entityType: 'fee_types', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, error: 'A fee type with that name already exists' });
      return next(err);
    }
  });

// Shared payment-history query (staff only): payments joined to the fee,
// student, fee type and the user who received the payment.
const PAYMENTS_SELECT = `
  SELECT fp.*, sf.student_id, s.student_id AS student_no, s.full_name AS student_name,
         ft.name AS fee_type_name, u.full_name AS received_by_name
    FROM fee_payments fp
    JOIN student_fees sf ON sf.id = fp.student_fee_id
    JOIN students s ON s.id = sf.student_id
    JOIN fee_types ft ON ft.id = sf.fee_type_id
    LEFT JOIN users u ON u.id = fp.received_by`;

// GET /api/fees/payments — payment history (staff only).
// Filters: ?search= (student name / student no. / receipt no.),
// ?payment_method=, ?date_from=, ?date_to=, ?student_id=, ?page&limit.
router.get('/payments', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search, payment_method, date_from, date_to, student_id } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.student_id ILIKE $${params.length} OR fp.receipt_no ILIKE $${params.length})`); }
    if (payment_method) { params.push(payment_method); where.push(`fp.payment_method = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`fp.payment_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`fp.payment_date <= $${params.length}`); }
    if (student_id) { params.push(student_id); where.push(`sf.student_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(
      `SELECT count(*)::int AS n FROM fee_payments fp JOIN student_fees sf ON sf.id = fp.student_fee_id JOIN students s ON s.id = sf.student_id ${clause}`, params);
    const { rows } = await query(
      `${PAYMENTS_SELECT} ${clause} ORDER BY fp.payment_date DESC, fp.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    const data = rows.map((r) => ({ ...r, amount: Number(r.amount) }));
    return res.json(paginatedResponse(data, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// PATCH /api/fees/payments/:id — correct a payment record (staff only).
// Changing the amount re-totals the parent fee (amount_paid + status) in
// the same transaction, so the books can never drift from the payments.
router.patch('/payments/:id', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('amount').optional().isFloat({ min: 0.01 }),
   body('payment_method').optional().isIn(['cash', 'bank', 'mobile_money', 'other']),
   body('payment_date').optional().isISO8601(),
   body('note').optional().trim()], validate,
  async (req, res, next) => {
    try {
      const result = await withTransaction(async (client) => {
        const pay = await client.query('SELECT * FROM fee_payments WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!pay.rows[0]) return { status: 404, body: { success: false, error: 'Payment not found' } };
        const old = pay.rows[0];
        const fee = await client.query('SELECT * FROM student_fees WHERE id = $1 FOR UPDATE', [old.student_fee_id]);
        if (!fee.rows[0]) return { status: 404, body: { success: false, error: 'Fee not found' } };
        const newAmount = req.body.amount !== undefined ? Number(req.body.amount) : Number(old.amount);
        const newPaid = Number(fee.rows[0].amount_paid) - Number(old.amount) + newAmount;
        if (newPaid < 0 || newPaid > Number(fee.rows[0].amount_due)) {
          return { status: 400, body: { success: false, error: `Corrected total paid (${newPaid} AFN) is outside the fee amount (${Number(fee.rows[0].amount_due)} AFN)` } };
        }
        const sets = []; const params = [];
        if (req.body.amount !== undefined) { params.push(newAmount); sets.push(`amount = $${params.length}`); }
        if (req.body.payment_method !== undefined) { params.push(req.body.payment_method); sets.push(`payment_method = $${params.length}`); }
        if (req.body.payment_date !== undefined) { params.push(req.body.payment_date); sets.push(`payment_date = $${params.length}`); }
        if (req.body.note !== undefined) { params.push(req.body.note || null); sets.push(`note = $${params.length}`); }
        if (!sets.length) return { status: 400, body: { success: false, error: 'Nothing to update' } };
        params.push(req.params.id);
        const updated = await client.query(
          `UPDATE fee_payments SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        const newStatus = newPaid >= Number(fee.rows[0].amount_due) ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';
        await client.query('UPDATE student_fees SET amount_paid = $2, status = $3 WHERE id = $1',
          [fee.rows[0].id, newPaid, newStatus]);
        return { status: 200, body: { success: true, data: { ...updated.rows[0], amount: Number(updated.rows[0].amount) } } };
      });
      if (result.status === 200) {
        await logAudit({ userId: req.user.id, action: 'fees.payment_update', entityType: 'fee_payments', entityId: Number(req.params.id), newValues: result.body.data, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

// GET /api/fees/export?format=csv — payment history as a CSV download
// (staff only). Same filters as GET /api/fees/payments.
router.get('/export', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { search, payment_method, date_from, date_to, student_id } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.student_id ILIKE $${params.length} OR fp.receipt_no ILIKE $${params.length})`); }
    if (payment_method) { params.push(payment_method); where.push(`fp.payment_method = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`fp.payment_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`fp.payment_date <= $${params.length}`); }
    if (student_id) { params.push(student_id); where.push(`sf.student_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(
      `${PAYMENTS_SELECT} ${clause} ORDER BY fp.payment_date DESC, fp.id DESC`, params);
    const csvCell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['Receipt', 'Date', 'Student ID', 'Student', 'Fee type', 'Method', 'Amount (AFN)', 'Received by', 'Note'].join(',')];
    for (const r of rows) {
      lines.push([r.receipt_no, r.payment_date, r.student_no, r.student_name, r.fee_type_name,
        r.payment_method, Number(r.amount), r.received_by_name || '', r.note || ''].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payment-history.csv"');
    return res.send(`\ufeff${lines.join('\r\n')}`);
  } catch (err) { return next(err); }
});

const APPROVERS = ['super_admin', 'exam_officer'];

// GET /api/fees/refunds — refund approval queue (staff only). Pending
// first, then decided, newest first; each row carries the original
// payment, student and fee details. Optional ?status=pending|approved|
// rejected filter.
// NOTE: this route must stay above GET /api/fees/:id — otherwise the
// word 'refunds' would match :id and fail its isInt validation.
router.get('/refunds', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { status } = req.query;
    const where = []; const params = [];
    if (status) { params.push(status); where.push(`fr.status = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query('SELECT count(*)::int AS n FROM fee_refunds fr ' + clause, params);
    const { rows } = await query(
      `SELECT fr.*, fp.receipt_no AS original_receipt_no, fp.amount AS original_amount,
              fp.student_fee_id, sf.student_id, s.student_id AS student_no,
              s.full_name AS student_name, ft.name AS fee_type_name,
              ru.full_name AS requested_by_name, au.full_name AS authorized_by_name,
              rp.receipt_no AS refund_receipt_no
         FROM fee_refunds fr
         JOIN fee_payments fp ON fp.id = fr.fee_payment_id
         JOIN student_fees sf ON sf.id = fp.student_fee_id
         JOIN students s ON s.id = sf.student_id
         JOIN fee_types ft ON ft.id = sf.fee_type_id
         LEFT JOIN users ru ON ru.id = fr.requested_by
         LEFT JOIN users au ON au.id = fr.authorized_by
         LEFT JOIN fee_payments rp ON rp.id = fr.refund_payment_id
        ${clause}
        ORDER BY CASE fr.status WHEN 'pending' THEN 0 ELSE 1 END,
                 fr.created_at DESC, fr.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    const data = rows.map((r) => ({ ...r, amount: Number(r.amount), original_amount: Number(r.original_amount) }));
    return res.json(paginatedResponse(data, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/fees/:id — one fee with its payments (used for the receipt view).
router.get('/:id', param('id').isInt({ min: 1 }), validate, async (req, res, next) => {
  try {
    const { rows } = await query(`${FEE_SELECT} WHERE sf.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Fee not found' });
    if (req.user.role === 'student') {
      const mine = await ownStudentId(req);
      if (mine !== rows[0].student_id) return res.status(403).json({ success: false, error: 'Students can only view their own fees' });
    } else if (req.user.role === 'lecturer') {
      return res.status(403).json({ success: false, error: 'Forbidden: requires super_admin, exam_officer or finance' });
    }
    const fee = { ...rows[0], amount_due: Number(rows[0].amount_due), amount_paid: Number(rows[0].amount_paid), balance: Number(rows[0].balance) };
    const pays = await query(
      `SELECT fp.*, u.full_name AS received_by_name FROM fee_payments fp
         LEFT JOIN users u ON u.id = fp.received_by
        WHERE fp.student_fee_id = $1 ORDER BY fp.payment_date DESC, fp.id DESC`, [fee.id]);
    fee.payments = pays.rows.map((p) => ({ ...p, amount: Number(p.amount) }));
    return res.json({ success: true, data: fee });
  } catch (err) { return next(err); }
});

// POST /api/fees/:id/pay — record a payment (staff only). The payment can
// never exceed the remaining balance; amount_paid and status are updated
// in the same transaction as the payment row. Receipt no. REC-YYYY-NNNN.
router.post('/:id/pay', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('amount').isFloat({ min: 0.01 }),
   body('payment_method').optional().isIn(['cash', 'bank', 'mobile_money', 'other']),
   body('payment_date').optional().isISO8601(),
   body('note').optional().trim()], validate,
  async (req, res, next) => {
    try {
      const feeId = Number(req.params.id);
      const amount = Number(req.body.amount);
      const result = await withTransaction(async (client) => {
        const fee = await client.query('SELECT * FROM student_fees WHERE id = $1 FOR UPDATE', [feeId]);
        if (!fee.rows[0]) return { status: 404, body: { success: false, error: 'Fee not found' } };
        const balance = Number(fee.rows[0].amount_due) - Number(fee.rows[0].amount_paid);
        if (amount > balance) {
          return { status: 400, body: { success: false, error: `Payment (${amount} AFN) exceeds the remaining balance (${balance} AFN)` } };
        }
        const receipt = await client.query(
          `SELECT 'REC-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('fee_receipt_seq')::text, 4, '0') AS receipt_no`);
        const receiptNo = receipt.rows[0].receipt_no;
        const pay = await client.query(
          `INSERT INTO fee_payments (student_fee_id, amount, payment_method, receipt_no, received_by, payment_date, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [feeId, amount, req.body.payment_method || 'cash', receiptNo, req.user.id,
           req.body.payment_date || new Date().toISOString().slice(0, 10), req.body.note || null]);
        const newPaid = Number(fee.rows[0].amount_paid) + amount;
        const newStatus = newPaid >= Number(fee.rows[0].amount_due) ? 'paid' : 'partial';
        const updated = await client.query(
          `UPDATE student_fees SET amount_paid = $2, status = $3 WHERE id = $1 RETURNING *`,
          [feeId, newPaid, newStatus]);
        return { status: 201, body: { success: true, data: { payment: { ...pay.rows[0], amount: Number(pay.rows[0].amount) }, fee: updated.rows[0] } } };
      });
      if (result.status === 201) {
        await logAudit({ userId: req.user.id, action: 'fees.pay', entityType: 'fee_payments', entityId: result.body.data.payment.id, newValues: result.body.data.payment, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

// --- Refunds (with authorization) ---------------------------------------
// Flow: any staff member (finance included) requests a refund against a
// payment -> the request sits PENDING and changes no totals -> a Super
// Admin or Exam Officer approves (posts a negative reversal payment and
// re-totals the parent fee, all in one transaction) or rejects it (no
// totals change). Finance may NOT approve — not even their own request.
// The reversal row is a negative fee_payments row with is_refund = TRUE,
// allowed only by the relaxed CHECK in migrations/006_refunds.sql; see
// that file's header for why the check is still safe.

// POST /api/fees/payments/:id/refund — request a refund (staff only).
// Creates a PENDING fee_refunds row. amount must be <= what is left
// refundable on the original payment (original amount minus earlier
// pending/approved refunds for it). Changes no totals yet.
router.post('/payments/:id/refund', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('amount').isFloat({ min: 0.01 }),
   body('reason').trim().isLength({ min: 3, max: 500 })], validate,
  async (req, res, next) => {
    try {
      const paymentId = Number(req.params.id);
      const amount = Number(req.body.amount);
      const result = await withTransaction(async (client) => {
        const pay = await client.query('SELECT * FROM fee_payments WHERE id = $1 FOR UPDATE', [paymentId]);
        if (!pay.rows[0]) return { status: 404, body: { success: false, error: 'Payment not found' } };
        if (Number(pay.rows[0].amount) <= 0) {
          return { status: 400, body: { success: false, error: 'A refund payment cannot itself be refunded' } };
        }
        const used = await client.query(
          `SELECT COALESCE(SUM(amount),0)::float AS used FROM fee_refunds
            WHERE fee_payment_id = $1 AND status IN ('pending','approved')`, [paymentId]);
        const remaining = Number(pay.rows[0].amount) - used.rows[0].used;
        if (amount > remaining) {
          return { status: 400, body: { success: false, error: `Refund (${amount} AFN) exceeds the refundable balance of this payment (${remaining} AFN)` } };
        }
        const { rows } = await client.query(
          `INSERT INTO fee_refunds (fee_payment_id, amount, reason, requested_by)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [paymentId, amount, req.body.reason.trim(), req.user.id]);
        return { status: 201, body: { success: true, data: { ...rows[0], amount: Number(rows[0].amount) } } };
      });
      if (result.status === 201) {
        await logAudit({ userId: req.user.id, action: 'fees.refund_request', entityType: 'fee_refunds', entityId: result.body.data.id, newValues: result.body.data, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

// Best-effort sync of a refunded fee payment back to its online
// payment_transactions row (migration 009): a fully refunded payment
// becomes 'refunded', a partially refunded one 'partially_refunded'.
// The link is the payment reference in the fee payment's note
// ("Online payment via HesabPay — PAY-YYYY-NNNNNN", written by
// applySuccessfulPayment in routes/payments.js); a cash/bank payment
// has no such reference and touches no online transaction. This runs
// AFTER the refund transaction commits, in its own try/catch, so it
// can never break the refund flow — and it is a no-op when migration
// 009 has not run yet (the table does not exist: 42P01) or when the
// payment was never online.
async function syncOnlineTransactionRefundStatus(feePaymentId) {
  try {
    const pay = await query('SELECT * FROM fee_payments WHERE id = $1', [feePaymentId]);
    if (!pay.rows[0]) return;
    const note = String(pay.rows[0].note || '');
    const ref = (note.match(/PAY-\d{4}-\d+/) || [])[0];
    if (!ref) return;
    const txn = await query(
      `SELECT * FROM payment_transactions WHERE payment_reference = $1
        AND status IN ('successful', 'partially_refunded')`,
      [ref]);
    if (!txn.rows[0]) return;
    const refunded = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM fee_refunds
        WHERE fee_payment_id = $1 AND status = 'approved'`, [feePaymentId]);
    const newStatus = Number(refunded.rows[0].total) >= Number(pay.rows[0].amount)
      ? 'refunded' : 'partially_refunded';
    await query(
      `UPDATE payment_transactions SET status = $2 WHERE id = $1
        AND status IN ('successful', 'partially_refunded')`,
      [txn.rows[0].id, newStatus]);
  } catch (err) {
    // Never break the refund flow: missing table (009 not applied),
    // missing row, anything — the refund itself already succeeded.
    console.warn('[fees] online-transaction refund sync skipped:', err.message);
  }
}

// POST /api/fees/refunds/:id/approve — approve a refund (Super Admin or
// Exam Officer only). In ONE transaction: mark the refund approved with
// authorized_by/authorized_at, post the negative reversal payment (new
// receipt REC-YYYY-NNNN from fee_receipt_seq, is_refund = TRUE), and
// re-total the parent fee's amount_paid and status. Re-checks at
// approval time that the refund is still pending, still refundable for
// the payment, and cannot drive amount_paid below 0.
router.post('/refunds/:id/approve', requireRole(...APPROVERS), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const refundId = Number(req.params.id);
      const result = await withTransaction(async (client) => {
        const ref = await client.query('SELECT * FROM fee_refunds WHERE id = $1 FOR UPDATE', [refundId]);
        if (!ref.rows[0]) return { status: 404, body: { success: false, error: 'Refund request not found' } };
        if (ref.rows[0].status !== 'pending') {
          return { status: 409, body: { success: false, error: `Refund request has already been ${ref.rows[0].status}` } };
        }
        const refund = ref.rows[0];
        const pay = await client.query('SELECT * FROM fee_payments WHERE id = $1 FOR UPDATE', [refund.fee_payment_id]);
        if (!pay.rows[0]) return { status: 404, body: { success: false, error: 'Original payment not found' } };
        const fee = await client.query('SELECT * FROM student_fees WHERE id = $1 FOR UPDATE', [pay.rows[0].student_fee_id]);
        if (!fee.rows[0]) return { status: 404, body: { success: false, error: 'Fee not found' } };
        const approved = await client.query(
          `SELECT COALESCE(SUM(amount),0)::float AS total FROM fee_refunds
            WHERE fee_payment_id = $1 AND status = 'approved'`, [refund.fee_payment_id]);
        if (Number(refund.amount) > Number(pay.rows[0].amount) - approved.rows[0].total) {
          return { status: 400, body: { success: false, error: 'Refund exceeds the amount still refundable for this payment' } };
        }
        const newPaid = Number(fee.rows[0].amount_paid) - Number(refund.amount);
        if (newPaid < 0) {
          return { status: 400, body: { success: false, error: `Refund (${Number(refund.amount)} AFN) exceeds the fee's paid total (${Number(fee.rows[0].amount_paid)} AFN)` } };
        }
        const receipt = await client.query(
          `SELECT 'REC-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('fee_receipt_seq')::text, 4, '0') AS receipt_no`);
        const reversal = await client.query(
          `INSERT INTO fee_payments (student_fee_id, amount, payment_method, receipt_no, received_by, payment_date, note, is_refund)
           VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,TRUE) RETURNING *`,
          [fee.rows[0].id, -Number(refund.amount), pay.rows[0].payment_method,
           receipt.rows[0].receipt_no, req.user.id,
           `Refund of ${pay.rows[0].receipt_no}: ${refund.reason}`]);
        const newStatus = newPaid >= Number(fee.rows[0].amount_due) ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';
        await client.query('UPDATE student_fees SET amount_paid = $2, status = $3 WHERE id = $1',
          [fee.rows[0].id, newPaid, newStatus]);
        const { rows } = await client.query(
          `UPDATE fee_refunds SET status = 'approved', authorized_by = $2, authorized_at = now(),
                  refund_payment_id = $3 WHERE id = $1 RETURNING *`,
          [refundId, req.user.id, reversal.rows[0].id]);
        return { status: 200, body: { success: true, data: { refund: { ...rows[0], amount: Number(rows[0].amount) }, reversal: { ...reversal.rows[0], amount: Number(reversal.rows[0].amount) } } } };
      });
      if (result.status === 200) {
        await logAudit({ userId: req.user.id, action: 'fees.refund_approve', entityType: 'fee_refunds', entityId: refundId, newValues: result.body.data, req });
        // Best-effort only: if the refunded payment was an online
        // (HesabPay) payment, mark its payment_transactions row refunded
        // / partially_refunded. Never throws — see the helper above.
        await syncOnlineTransactionRefundStatus(result.body.data.refund.fee_payment_id);
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

// POST /api/fees/refunds/:id/reject — reject a refund (Super Admin or
// Exam Officer only). Marks it rejected with authorized_by/authorized_at.
// No payment row, no totals change.
router.post('/refunds/:id/reject', requireRole(...APPROVERS), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const refundId = Number(req.params.id);
      const result = await withTransaction(async (client) => {
        const ref = await client.query('SELECT * FROM fee_refunds WHERE id = $1 FOR UPDATE', [refundId]);
        if (!ref.rows[0]) return { status: 404, body: { success: false, error: 'Refund request not found' } };
        if (ref.rows[0].status !== 'pending') {
          return { status: 409, body: { success: false, error: `Refund request has already been ${ref.rows[0].status}` } };
        }
        const { rows } = await client.query(
          `UPDATE fee_refunds SET status = 'rejected', authorized_by = $2, authorized_at = now()
            WHERE id = $1 RETURNING *`,
          [refundId, req.user.id]);
        return { status: 200, body: { success: true, data: { ...rows[0], amount: Number(rows[0].amount) } } };
      });
      if (result.status === 200) {
        await logAudit({ userId: req.user.id, action: 'fees.refund_reject', entityType: 'fee_refunds', entityId: refundId, newValues: result.body.data, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

module.exports = router;
