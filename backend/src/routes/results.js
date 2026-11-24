// Results — calculation from approved marks, publication, student view,
// complaints review. CRITICAL: students only ever receive is_published=true
// rows (enforced in every student-facing query here).
const express = require('express');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { getGradeScale, gradeForMarks, studentGpa, calculateGpa } = require('../utils/gpa');
const { getLecturerScope, lecturerSubjectSql } = require('../utils/lecturerScope');

const router = express.Router();
router.use(authenticate);
const OFFICER = requireRole('super_admin', 'exam_officer');

// POST /api/results/calculate/:examId — build results from APPROVED marks.
// Idempotent: re-running updates existing result rows for the exam.
router.post('/calculate/:examId', OFFICER, param('examId').isInt(), validate,
  async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      const created = await withTransaction(async (client) => {
        const scale = await getGradeScale(client);
        const { rows: marks } = await client.query(
          `SELECT m.*, sub.credit_hours FROM marks m JOIN subjects sub ON sub.id = m.subject_id
            WHERE m.exam_id = $1 AND m.status = 'approved'`, [examId]);
        const out = [];
        for (const m of marks) {
          const grade = gradeForMarks(m.obtained_marks, scale);
          if (!grade) continue; // no grade band covers this mark — skip, do not invent one
          const { rows } = await client.query(
            `INSERT INTO results (exam_id, student_id, subject_id, mark_id, obtained_marks, grade, grade_point)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (exam_id, student_id, subject_id)
             DO UPDATE SET mark_id = EXCLUDED.mark_id, obtained_marks = EXCLUDED.obtained_marks,
                           grade = EXCLUDED.grade, grade_point = EXCLUDED.grade_point, updated_at = now()
             RETURNING *`,
            [examId, m.student_id, m.subject_id, m.id, m.obtained_marks, grade.grade, grade.grade_point]);
          out.push(rows[0]);
        }
        // Snapshot each student's GPA for this exam onto their result rows.
        const studentIds = [...new Set(out.map((r) => r.student_id))];
        for (const sid of studentIds) {
          const gpa = await studentGpa(client, sid, examId);
          await client.query('UPDATE results SET gpa = $1 WHERE exam_id = $2 AND student_id = $3', [gpa, examId, sid]);
        }
        return out;
      });
      await logAudit({ userId: req.user.id, action: 'results.calculate', entityType: 'examinations', entityId: examId, newValues: { count: created.length }, req });
      return res.json({ success: true, data: created, message: `${created.length} result(s) calculated from approved marks` });
    } catch (err) { return next(err); }
  });

// POST /api/results/publish/:examId — publish all results for the exam.
router.post('/publish/:examId', OFFICER, param('examId').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE results SET is_published = TRUE, published_at = now(), published_by = $2
          WHERE exam_id = $1 AND NOT is_published RETURNING id`,
        [req.params.examId, req.user.id]);
      await query(`UPDATE examinations SET status = 'completed' WHERE id = $1`, [req.params.examId]);
      await logAudit({ userId: req.user.id, action: 'results.publish', entityType: 'examinations', entityId: Number(req.params.examId), newValues: { published: rows.length }, req });
      return res.json({ success: true, message: `${rows.length} result(s) published`, published: rows.length });
    } catch (err) { return next(err); }
  });

// POST /api/results/unpublish/:examId — withdraw publication (admin/officer).
router.post('/unpublish/:examId', OFFICER, param('examId').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'UPDATE results SET is_published = FALSE, published_at = NULL WHERE exam_id = $1 AND is_published RETURNING id',
        [req.params.examId]);
      await logAudit({ userId: req.user.id, action: 'results.unpublish', entityType: 'examinations', entityId: Number(req.params.examId), newValues: { unpublished: rows.length }, req });
      return res.json({ success: true, message: `${rows.length} result(s) unpublished` });
    } catch (err) { return next(err); }
  });

// GET /api/results?exam_id&student_id&department_id&published_only
// Students are force-filtered to their own published results.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { exam_id, student_id, department_id } = req.query;
    const where = []; const params = [];
    if (exam_id) { params.push(exam_id); where.push(`r.exam_id = $${params.length}`); }
    if (student_id) { params.push(student_id); where.push(`r.student_id = $${params.length}`); }
    if (department_id) { params.push(department_id); where.push(`s.department_id = $${params.length}`); }
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      params.push(s.rows[0]?.id || -1); where.push(`r.student_id = $${params.length}`);
      where.push('r.is_published = TRUE');
    }
    if (req.user.role === 'lecturer') {
      // Lecturers see results only for their assigned subjects (published
      // or not — marks/results for other subjects must never leak).
      // No linked lecturer row → empty list.
      const scope = await getLecturerScope(req.user.id);
      params.push(scope?.lecturerId ?? -1);
      where.push(lecturerSubjectSql('r.subject_id', params.length));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(
      `SELECT count(*)::int AS n FROM results r JOIN students s ON s.id = r.student_id ${clause}`, params);
    const { rows } = await query(
      `SELECT r.*, r.student_id AS student_pk, s.student_id AS student_no, s.full_name AS student_name, sub.code AS subject_code,
              sub.title AS subject_title, sub.credit_hours, e.title AS exam_title
         FROM results r JOIN students s ON s.id = r.student_id
         JOIN subjects sub ON sub.id = r.subject_id JOIN examinations e ON e.id = r.exam_id
         ${clause} ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/results/student/:studentId — transcript: published results + CGPA.
// A student may only call this for themselves; staff may call it for anyone.
router.get('/student/:studentId', param('studentId').isInt(), validate, async (req, res, next) => {
  try {
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      if (!s.rows[0] || s.rows[0].id !== Number(req.params.studentId)) {
        return res.status(403).json({ success: false, error: 'Students can only view their own results' });
      }
    }
    // A lecturer sees only the student's results in their own subjects,
    // and the CGPA is computed over those rows only — the student's
    // overall CGPA (which covers other lecturers' subjects) must not leak.
    const lecturerParams = [req.params.studentId];
    let lecturerClause = '';
    const isLecturer = req.user.role === 'lecturer';
    if (isLecturer) {
      const scope = await getLecturerScope(req.user.id);
      lecturerParams.push(scope?.lecturerId ?? -1);
      lecturerClause = ` AND ${lecturerSubjectSql('r.subject_id', lecturerParams.length)}`;
    }
    const { rows } = await query(
      `SELECT r.*, s.student_id AS student_no, s.full_name AS student_name, sub.code AS subject_code, sub.title AS subject_title, sub.credit_hours,
              e.title AS exam_title, e.exam_type
         FROM results r JOIN students s ON s.id = r.student_id
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN examinations e ON e.id = r.exam_id
        WHERE r.student_id = $1 AND r.is_published = TRUE${lecturerClause} ORDER BY e.start_date, sub.code`,
      lecturerParams);
    const cgpa = isLecturer
      ? calculateGpa(rows)
      : await studentGpa({ query: (t, p) => query(t, p) }, Number(req.params.studentId));
    return res.json({ success: true, data: { results: rows, cgpa, total_subjects: rows.length } });
  } catch (err) { return next(err); }
});

// GET /api/results/grade-scales — the configurable grading table.
router.get('/grade-scales/list', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM grade_scales ORDER BY min_marks DESC');
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// PUT /api/results/grade-scales/:grade — super_admin updates a grade band.
router.put('/grade-scales/:grade', requireRole('super_admin'), param('grade').isLength({ min: 1, max: 5 }),
  [body('min_marks').optional().isFloat({ min: 0, max: 100 }),
   body('max_marks').optional().isFloat({ min: 0, max: 100 }),
   body('grade_point').optional().isFloat({ min: 0, max: 4 })], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const { rows } = await query(
        `UPDATE grade_scales SET min_marks = COALESCE($1, min_marks), max_marks = COALESCE($2, max_marks),
           grade_point = COALESCE($3, grade_point), is_passing = COALESCE($4, is_passing) WHERE grade = $5 RETURNING *`,
        [b.min_marks ?? null, b.max_marks ?? null, b.grade_point ?? null, b.is_passing ?? null, req.params.grade.toUpperCase()]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Grade not found' });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// ---- Complaints review ------------------------------------------------------
router.get('/complaints/list', OFFICER, async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let clause = '';
    if (status) { params.push(status); clause = 'WHERE c.status = $1'; }
    const { rows } = await query(
      `SELECT c.*, s.student_id, s.full_name AS student_name, sub.code AS subject_code
         FROM complaints c JOIN students s ON s.id = c.student_id
         LEFT JOIN subjects sub ON sub.id = c.subject_id ${clause} ORDER BY c.created_at DESC`, params);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

router.put('/complaints/:id', OFFICER, param('id').isInt(),
  [body('status').isIn(['pending', 'under_review', 'resolved', 'rejected']),
   body('resolution').optional().trim()], validate, async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE complaints SET status = $1, resolution = $2, resolved_by = $3 WHERE id = $4 RETURNING *`,
        [req.body.status, req.body.resolution || null, req.user.id, req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Complaint not found' });
      await logAudit({ userId: req.user.id, action: 'complaints.resolve', entityType: 'complaints', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

module.exports = router;
