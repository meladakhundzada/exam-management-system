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

const router = express.Router();
router.use(authenticate);

const STAFF = ['super_admin', 'exam_officer', 'finance'];

// The students.id for the signed-in student user (null for other roles).
async function ownStudentId(req) {
  if (req.user.role !== 'student') return null;
  const { rows } = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  return rows[0]?.id || null;
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
router.get('/student/:studentId', param('studentId').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const studentId = Number(req.params.studentId);
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
// Exactly one of student_id / department_id is required.
router.post('/assign', requireRole(...STAFF),
  [body('fee_type_id').isInt({ min: 1 }),
   body('amount').optional().isFloat({ min: 0.01 }),
   body('student_id').optional().isInt({ min: 1 }),
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
      const amount = b.amount || Number(type.rows[0].amount);
      let created;
      if (b.student_id) {
        const { rows } = await query(
          `INSERT INTO student_fees (student_id, fee_type_id, amount_due, due_date, academic_year_id, semester_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (student_id, fee_type_id, COALESCE(academic_year_id,0), COALESCE(semester_id,0)) DO NOTHING
           RETURNING *`,
          [b.student_id, b.fee_type_id, amount, b.due_date || null,
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
          const { rows } = await query(
            `INSERT INTO student_fees (student_id, fee_type_id, amount_due, due_date, academic_year_id, semester_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (student_id, fee_type_id, COALESCE(academic_year_id,0), COALESCE(semester_id,0)) DO NOTHING
             RETURNING *`,
            [s.id, b.fee_type_id, amount, b.due_date || null,
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

module.exports = router;
