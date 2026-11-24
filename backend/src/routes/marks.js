// Marks entry & approval.
// Status flow: draft → submitted (lecturer) → approved | rejected (officer).
// Only approved marks can be turned into results (see results.js).
// Lecturers may only enter marks for subjects assigned to them (lecturer_id
// on subjects); the check below enforces that at the API layer.
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { getLecturerScope, lecturerSubjectSql, lecturerOwnsSubject: lecturerOwnsSubjectId } = require('../utils/lecturerScope');

const router = express.Router();
router.use(authenticate);

async function lecturerOwnsSubject(req, res, next) {
  if (req.user.role !== 'lecturer') return next();
  const { rows } = await query('SELECT id FROM lecturers WHERE user_id = $1', [req.user.id]);
  if (!rows[0]) return res.status(403).json({ success: false, error: 'Lecturer profile not found' });
  const subjectId = req.body.subject_id || req.query.subject_id;
  if (!subjectId) return next();
  const owned = await query('SELECT 1 FROM subjects WHERE id = $1 AND lecturer_id = $2', [subjectId, rows[0].id]);
  if (!owned.rows.length) return res.status(403).json({ success: false, error: 'You can only enter marks for your own subjects' });
  req.lecturerId = rows[0].id;
  return next();
}

// GET /api/marks?exam_id&subject_id&student_id&status — paginated.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { exam_id, subject_id, student_id, status } = req.query;
    const where = []; const params = [];
    if (exam_id) { params.push(exam_id); where.push(`m.exam_id = $${params.length}`); }
    if (subject_id) { params.push(subject_id); where.push(`m.subject_id = $${params.length}`); }
    if (student_id) { params.push(student_id); where.push(`m.student_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`m.status = $${params.length}`); }
    if (req.user.role === 'lecturer') {
      // Scope by assigned subject, not by marks.lecturer_id: marks entered
      // by an officer for the lecturer's subject must be visible too, and
      // marks for other subjects must never be. No linked row → empty list.
      const scope = await getLecturerScope(req.user.id);
      params.push(scope?.lecturerId ?? -1);
      where.push(lecturerSubjectSql('m.subject_id', params.length));
    }
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      params.push(s.rows[0]?.id || -1); where.push(`m.student_id = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM marks m ${clause}`, params);
    const { rows } = await query(
      `SELECT m.id, m.exam_id, m.subject_id, m.student_id AS student_pk,
              m.lecturer_id, m.obtained_marks, m.total_marks, m.status, m.remarks,
              m.entered_at, m.updated_at,
              s.student_id AS student_no, s.full_name AS student_name,
              sub.code AS subject_code, sub.title AS subject_title
         FROM marks m JOIN students s ON s.id = m.student_id JOIN subjects sub ON sub.id = m.subject_id
         ${clause} ORDER BY m.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/marks/roster?exam_id&subject_id — students enrolled in the
// subject, each with their existing mark row for the exam (if any).
// Marks entry needs a roster, not just existing rows: on a fresh exam
// GET /api/marks returns nothing, so the page would have nobody to enter
// marks for. student_pk is the internal students.id (what /bulk needs);
// student_no is the public STU-… number shown in the UI.
// Staff + the subject's own lecturer only: a lecturer may not pull the
// roster (names + existing marks) for another lecturer's subject.
router.get('/roster', requireRole('super_admin', 'exam_officer', 'lecturer'), async (req, res, next) => {
  try {
    const { exam_id, subject_id } = req.query;
    if (!exam_id || !subject_id) {
      return res.status(400).json({ success: false, error: 'exam_id and subject_id query parameters are required' });
    }
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope || !(await lecturerOwnsSubjectId(scope.lecturerId, subject_id))) {
        return res.status(403).json({ success: false, error: 'You can only view rosters for your own subjects' });
      }
    }
    const { rows } = await query(
      `SELECT s.id AS student_pk, s.student_id AS student_no, s.full_name AS student_name,
              m.id AS mark_id, m.obtained_marks, m.total_marks, m.status
         FROM enrollments en JOIN students s ON s.id = en.student_id
         LEFT JOIN marks m ON m.student_id = s.id AND m.exam_id = $1 AND m.subject_id = $2
        WHERE en.subject_id = $2 AND en.status = 'enrolled' AND s.status = 'active'
        ORDER BY s.full_name`,
      [exam_id, subject_id]);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// POST /api/marks — single mark (draft). Use /bulk for a whole class.
router.post('/', requireRole('super_admin', 'exam_officer', 'lecturer'), lecturerOwnsSubject,
  [body('exam_id').isInt({ min: 1 }), body('subject_id').isInt({ min: 1 }),
   body('student_id').isInt({ min: 1 }),
   body('obtained_marks').isFloat({ min: 0, max: 100 }),
   body('total_marks').optional().isFloat({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const { rows } = await query(
        `INSERT INTO marks (exam_id, subject_id, student_id, lecturer_id, obtained_marks, total_marks, status, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
         ON CONFLICT (exam_id, subject_id, student_id)
         DO UPDATE SET obtained_marks = EXCLUDED.obtained_marks, total_marks = EXCLUDED.total_marks,
                       remarks = EXCLUDED.remarks, status = 'draft', updated_at = now()
         RETURNING *`,
        [b.exam_id, b.subject_id, b.student_id, req.lecturerId || b.lecturer_id || null,
         b.obtained_marks, b.total_marks || 100, b.remarks || null]);
      await logAudit({ userId: req.user.id, action: 'marks.create', entityType: 'marks', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/marks/bulk — upsert many marks for one exam+subject in one call.
// Body: { exam_id, subject_id, marks: [{ student_id, obtained_marks }] }
router.post('/bulk', requireRole('super_admin', 'exam_officer', 'lecturer'), lecturerOwnsSubject,
  [body('exam_id').isInt({ min: 1 }), body('subject_id').isInt({ min: 1 }),
   body('marks').isArray({ min: 1 }),
   body('marks.*.student_id').isInt({ min: 1 }),
   body('marks.*.obtained_marks').isFloat({ min: 0, max: 100 })], validate,
  async (req, res, next) => {
    try {
      const saved = [];
      for (const m of req.body.marks) {
        const { rows } = await query(
          `INSERT INTO marks (exam_id, subject_id, student_id, lecturer_id, obtained_marks, total_marks, status)
           VALUES ($1,$2,$3,$4,$5,100,'draft')
           ON CONFLICT (exam_id, subject_id, student_id)
           DO UPDATE SET obtained_marks = EXCLUDED.obtained_marks, status = 'draft', updated_at = now()
           RETURNING *`,
          [req.body.exam_id, req.body.subject_id, m.student_id, req.lecturerId || null, m.obtained_marks]);
        saved.push(rows[0]);
      }
      await logAudit({ userId: req.user.id, action: 'marks.bulk_create', entityType: 'marks', newValues: { exam_id: req.body.exam_id, subject_id: req.body.subject_id, count: saved.length }, req });
      return res.status(201).json({ success: true, data: saved });
    } catch (err) { return next(err); }
  });

// POST /api/marks/:id/submit — lecturer submits draft marks for approval.
router.post('/:id/submit', requireRole('super_admin', 'exam_officer', 'lecturer'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      // A lecturer may submit only marks for their own subjects; without
      // this, any lecturer could submit any mark row by id.
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        const mark = await query('SELECT subject_id FROM marks WHERE id = $1', [req.params.id]);
        if (mark.rows[0] && (!scope || !(await lecturerOwnsSubjectId(scope.lecturerId, mark.rows[0].subject_id)))) {
          return res.status(403).json({ success: false, error: 'You can only submit marks for your own subjects' });
        }
      }
      const { rows } = await query(
        `UPDATE marks SET status = 'submitted' WHERE id = $1 AND status = 'draft' RETURNING *`, [req.params.id]);
      if (!rows[0]) return res.status(409).json({ success: false, error: 'Mark not found or not in draft status' });
      await logAudit({ userId: req.user.id, action: 'marks.submit', entityType: 'marks', entityId: rows[0].id, req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/marks/:id/approve — officer approves a submitted mark.
router.post('/:id/approve', requireRole('super_admin', 'exam_officer'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE marks SET status = 'approved' WHERE id = $1 AND status IN ('submitted','draft') RETURNING *`, [req.params.id]);
      if (!rows[0]) return res.status(409).json({ success: false, error: 'Mark not found or not awaiting approval' });
      await logAudit({ userId: req.user.id, action: 'marks.approve', entityType: 'marks', entityId: rows[0].id, req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/marks/:id/reject — officer rejects with a reason (marks.remarks).
router.post('/:id/reject', requireRole('super_admin', 'exam_officer'), param('id').isInt(),
  [body('reason').optional().trim()], validate, async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE marks SET status = 'rejected', remarks = $2 WHERE id = $1 AND status IN ('submitted','draft') RETURNING *`,
        [req.params.id, req.body.reason || null]);
      if (!rows[0]) return res.status(409).json({ success: false, error: 'Mark not found or not awaiting approval' });
      await logAudit({ userId: req.user.id, action: 'marks.reject', entityType: 'marks', entityId: rows[0].id, req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// GET /api/marks/pending — count + list of submitted marks awaiting approval.
router.get('/pending/list', requireRole('super_admin', 'exam_officer'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*, s.full_name AS student_name, sub.code AS subject_code, e.title AS exam_title
         FROM marks m JOIN students s ON s.id = m.student_id
         JOIN subjects sub ON sub.id = m.subject_id JOIN examinations e ON e.id = m.exam_id
        WHERE m.status = 'submitted' ORDER BY m.updated_at DESC`);
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (err) { return next(err); }
});

module.exports = router;
