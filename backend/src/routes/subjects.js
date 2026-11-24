// Subjects — CRUD. The subjects table already exists in the schema
// (code, title, department_id, semester_id, lecturer_id, credit_hours,
// description, is_active). There is no plain `semester` or `credits`
// column: `semester` maps to semester_id (FK to semesters, optional) and
// `credits` maps to credit_hours. Roles: super_admin & exam_officer
// manage; lecturer reads; students have no access to this route.
const express = require('express');
const { body, param } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { getLecturerScope } = require('../utils/lecturerScope');

const router = express.Router();
router.use(authenticate);
const MANAGE = requireRole('super_admin', 'exam_officer');

// Joined row: department / semester / lecturer names for the list UI.
const SELECT_JOINED = `
  SELECT sub.*, d.name AS department_name, d.code AS department_code,
         s.name AS semester_name, t.full_name AS lecturer_name
    FROM subjects sub
    JOIN departments d ON d.id = sub.department_id
    LEFT JOIN semesters s ON s.id = sub.semester_id
    LEFT JOIN lecturers t ON t.id = sub.lecturer_id`;

// GET /api/subjects?page&limit&search&department_id&lecturer_id
router.get('/', requireRole('super_admin', 'exam_officer', 'lecturer'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search = '', department_id, lecturer_id } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(sub.code ILIKE $${params.length} OR sub.title ILIKE $${params.length})`); }
    if (department_id) { params.push(department_id); where.push(`sub.department_id = $${params.length}`); }
    if (lecturer_id) { params.push(lecturer_id); where.push(`sub.lecturer_id = $${params.length}`); }
    // Lecturers already had access here but saw every subject; restrict
    // them to their assigned subjects only. No linked row → empty list.
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope) return res.json(paginatedResponse([], 0, { page, limit }));
      params.push(scope.lecturerId); where.push(`sub.lecturer_id = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM subjects sub ${clause}`, params);
    const { rows } = await query(
      `${SELECT_JOINED} ${clause}
        ORDER BY sub.code LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/subjects/:id
router.get('/:id', requireRole('super_admin', 'exam_officer', 'lecturer'),
  param('id').isInt(), validate, async (req, res, next) => {
    try {
      const { rows } = await query(`${SELECT_JOINED} WHERE sub.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Subject not found' });
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || rows[0].lecturer_id !== scope.lecturerId) {
          return res.status(403).json({ success: false, error: 'Subject is not assigned to you' });
        }
      }
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

const subjectValidators = [
  body('code').trim().notEmpty().withMessage('Subject code is required')
    .isLength({ max: 20 }).withMessage('Subject code is at most 20 characters'),
  body('title').trim().notEmpty().withMessage('Subject title is required'),
  body('department_id').isInt({ min: 1 }).withMessage('department_id is required'),
  body('credit_hours').optional().isFloat({ min: 0.5, max: 6 }).withMessage('Credit hours must be between 0.5 and 6'),
  body('semester_id').optional().isInt({ min: 1 }),
  body('lecturer_id').optional().isInt({ min: 1 }),
  body('description').optional().trim(),
  body('is_active').optional().isBoolean(),
];

// POST /api/subjects
router.post('/', MANAGE, subjectValidators, validate, async (req, res, next) => {
  try {
    const b = req.body;
    const { rows } = await query(
      `INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title,
          credit_hours, description, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.department_id, b.semester_id || null, b.lecturer_id || null,
       b.code.trim().toUpperCase(), b.title.trim(), b.credit_hours ?? 3,
       b.description || null, b.is_active !== false]);
    const created = await query(`${SELECT_JOINED} WHERE sub.id = $1`, [rows[0].id]);
    await logAudit({ userId: req.user.id, action: 'subjects.create', entityType: 'subjects', entityId: rows[0].id, newValues: created.rows[0], req });
    return res.status(201).json({ success: true, data: created.rows[0], message: 'Subject created.' });
  } catch (err) { return next(err); }
});

// PUT /api/subjects/:id
// PUT /api/subjects/:id — every field optional (unlike POST, where
// code / title / department_id are required).
const updateValidators = [
  body('code').optional().trim().notEmpty().isLength({ max: 20 }),
  body('title').optional().trim().notEmpty(),
  body('department_id').optional().isInt({ min: 1 }),
  body('credit_hours').optional().isFloat({ min: 0.5, max: 6 }),
  body('semester_id').optional().isInt({ min: 1 }),
  body('lecturer_id').optional().isInt({ min: 1 }),
  body('description').optional().trim(),
  body('is_active').optional().isBoolean(),
];

router.put('/:id', MANAGE, param('id').isInt(), updateValidators, validate, async (req, res, next) => {
    try {
      const b = req.body;
      const { rows } = await query(
        `UPDATE subjects SET department_id = COALESCE($1, department_id),
           semester_id = COALESCE($2, semester_id), lecturer_id = COALESCE($3, lecturer_id),
           code = COALESCE($4, code), title = COALESCE($5, title),
           credit_hours = COALESCE($6, credit_hours), description = COALESCE($7, description),
           is_active = COALESCE($8, is_active), updated_at = now()
         WHERE id = $9 RETURNING id`,
        [b.department_id || null, b.semester_id || null, b.lecturer_id || null,
         b.code ? b.code.trim().toUpperCase() : null, b.title ? b.title.trim() : null,
         b.credit_hours ?? null, b.description ?? null,
         b.is_active === undefined ? null : b.is_active, req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Subject not found' });
      const updated = await query(`${SELECT_JOINED} WHERE sub.id = $1`, [rows[0].id]);
      await logAudit({ userId: req.user.id, action: 'subjects.update', entityType: 'subjects', entityId: rows[0].id, newValues: updated.rows[0], req });
      return res.json({ success: true, data: updated.rows[0] });
    } catch (err) { return next(err); }
  });

// DELETE /api/subjects/:id — super_admin only; RESTRICTed if exams,
// marks, results, schedules or enrolments reference the subject.
router.delete('/:id', requireRole('super_admin'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query('DELETE FROM subjects WHERE id = $1 RETURNING id, code', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Subject not found' });
      await logAudit({ userId: req.user.id, action: 'subjects.delete', entityType: 'subjects', entityId: rows[0].id, req });
      return res.json({ success: true, message: `Subject ${rows[0].code} deleted` });
    } catch (err) { return next(err); }
  });

module.exports = router;
