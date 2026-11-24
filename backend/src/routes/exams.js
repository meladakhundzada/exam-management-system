// Examinations, timetables (exam_schedules), rooms & allocations, attendance.
// Workflow steps 4–7: officer creates exam → schedules subjects → assigns
// rooms → attendance is recorded. Lecturers create exams (incl. quizzes)
// and schedule/mark attendance for their own subjects only; students read
// schedules only.
const express = require('express');
const { body, param } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { getLecturerScope, lecturerSubjectSql, lecturerOwnsExam, lecturerOwnsSchedule, lecturerOwnsSubject } = require('../utils/lecturerScope');

const router = express.Router();
router.use(authenticate);
const MANAGE = requireRole('super_admin', 'exam_officer');
const MANAGE_OR_LECTURER = requireRole('super_admin', 'exam_officer', 'lecturer');

// ---- Examinations ---------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search = '', status, semester_id } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`e.title ILIKE $${params.length}`); }
    if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
    if (semester_id) { params.push(semester_id); where.push(`e.semester_id = $${params.length}`); }
    // Lecturers see only exams with a schedule in one of their assigned
    // subjects. No linked lecturer row → empty list.
    let lecturerId = null;
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope) return res.json(paginatedResponse([], 0, { page, limit }));
      lecturerId = scope.lecturerId;
      params.push(lecturerId);
      where.push(`EXISTS (SELECT 1 FROM exam_schedules es WHERE es.exam_id = e.id
                          AND ${lecturerSubjectSql('es.subject_id', params.length)})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM examinations e ${clause}`, params);
    // The two aggregate counts are scoped the same way for lecturers, so
    // an exam row never leaks how many other subjects / published results
    // it has. lecturerId comes from the DB (never user input), as in
    // dashboard.js.
    const scheduleCountSql = lecturerId === null
      ? '(SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id)'
      : `(SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id AND subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${lecturerId}))`;
    const publishedSql = lecturerId === null
      ? '(SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published)'
      : `(SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published AND subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${lecturerId}))`;
    const { rows } = await query(
      `SELECT e.*, ay.name AS academic_year, s.name AS semester_name,
              ${scheduleCountSql} AS schedule_count,
              ${publishedSql} AS published_results
         FROM examinations e JOIN academic_years ay ON ay.id = e.academic_year_id
         JOIN semesters s ON s.id = e.semester_id ${clause}
        ORDER BY e.start_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// NOTE: /rooms/list must be registered BEFORE /:id, otherwise Express
// would match "rooms" as :id and reject it with a 400.
router.get('/rooms/list', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM exam_rooms ORDER BY name');
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

router.get('/:id', param('id').isInt(), validate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, ay.name AS academic_year, s.name AS semester_name FROM examinations e
        JOIN academic_years ay ON ay.id = e.academic_year_id
        JOIN semesters s ON s.id = e.semester_id WHERE e.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Examination not found' });
    // A lecturer may open an exam only when it has a schedule in one of
    // their assigned subjects; its schedule list is filtered the same way.
    let lecturerId = null;
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope || !(await lecturerOwnsExam(scope.lecturerId, req.params.id))) {
        return res.status(403).json({ success: false, error: 'Examination is not for one of your assigned subjects' });
      }
      lecturerId = scope.lecturerId;
    }
    const scheduleParams = [req.params.id];
    let scheduleClause = 'WHERE es.exam_id = $1';
    if (lecturerId !== null) {
      scheduleParams.push(lecturerId);
      scheduleClause += ` AND ${lecturerSubjectSql('es.subject_id', scheduleParams.length)}`;
    }
    const schedules = await query(
      `SELECT es.*, sub.code AS subject_code, sub.title AS subject_title,
              er.name AS room_name, t.full_name AS invigilator
         FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
         LEFT JOIN lecturers t ON t.id = ra.invigilator_id
        ${scheduleClause} ORDER BY es.exam_date, es.start_time`, scheduleParams);
    return res.json({ success: true, data: { ...rows[0], schedules: schedules.rows } });
  } catch (err) { return next(err); }
});

router.post('/', MANAGE_OR_LECTURER,
  [body('academic_year_id').isInt({ min: 1 }), body('semester_id').isInt({ min: 1 }),
   body('title').trim().notEmpty(), body('exam_type').isIn(['midterm', 'final', 'quiz', 'supplementary', 'entry']),
   body('start_date').isISO8601(), body('end_date').isISO8601()], validate,
  async (req, res, next) => {
    // Exam headers carry no subject, so any lecturer may create one; it
    // only becomes visible to them once they schedule one of their own
    // subjects in it (GET / filters by scheduled subject).
    try {
      const b = req.body;
      const { rows } = await query(
        `INSERT INTO examinations (academic_year_id, semester_id, title, exam_type, start_date, end_date, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.academic_year_id, b.semester_id, b.title, b.exam_type, b.start_date, b.end_date, b.status || 'scheduled', req.user.id]);
      await logAudit({ userId: req.user.id, action: 'exams.create', entityType: 'examinations', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

router.put('/:id', MANAGE, param('id').isInt(),
  [body('title').optional().trim().notEmpty(), body('status').optional().isIn(['draft', 'scheduled', 'ongoing', 'completed', 'cancelled'])],
  validate, async (req, res, next) => {
    try {
      const b = req.body;
      const { rows } = await query(
        `UPDATE examinations SET title = COALESCE($1, title), exam_type = COALESCE($2, exam_type),
           start_date = COALESCE($3, start_date), end_date = COALESCE($4, end_date),
           status = COALESCE($5, status) WHERE id = $6 RETURNING *`,
        [b.title || null, b.exam_type || null, b.start_date || null, b.end_date || null, b.status || null, req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Examination not found' });
      await logAudit({ userId: req.user.id, action: 'exams.update', entityType: 'examinations', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

router.delete('/:id', requireRole('super_admin'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query('DELETE FROM examinations WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Examination not found' });
      await logAudit({ userId: req.user.id, action: 'exams.delete', entityType: 'examinations', entityId: rows[0].id, req });
      return res.json({ success: true, message: 'Examination deleted' });
    } catch (err) { return next(err); }
  });

// ---- Timetable: exam_schedules -------------------------------------------
router.post('/:id/schedules', MANAGE_OR_LECTURER, param('id').isInt(),
  [body('subject_id').isInt({ min: 1 }), body('exam_date').isISO8601(),
   body('start_time').matches(/^\d{2}:\d{2}/), body('end_time').matches(/^\d{2}:\d{2}/)],
  validate, async (req, res, next) => {
    try {
      // Lecturers may schedule only their own assigned subjects.
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSubject(scope.lecturerId, req.body.subject_id))) {
          return res.status(403).json({ success: false, error: 'Subject is not one of your assigned subjects' });
        }
      }
      const { rows } = await query(
        `INSERT INTO exam_schedules (exam_id, subject_id, exam_date, start_time, end_time)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, req.body.subject_id, req.body.exam_date, req.body.start_time, req.body.end_time]);
      await logAudit({ userId: req.user.id, action: 'schedules.create', entityType: 'exam_schedules', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

router.delete('/:examId/schedules/:scheduleId', MANAGE, async (req, res, next) => {
  try {
    const { rows } = await query('DELETE FROM exam_schedules WHERE id = $1 AND exam_id = $2 RETURNING id',
      [req.params.scheduleId, req.params.examId]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Schedule not found' });
    return res.json({ success: true, message: 'Schedule removed' });
  } catch (err) { return next(err); }
});

// ---- Rooms & allocations ---------------------------------------------------
router.post('/rooms', MANAGE,
  [body('name').trim().notEmpty(), body('capacity').isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'INSERT INTO exam_rooms (name, building, capacity) VALUES ($1,$2,$3) RETURNING *',
        [req.body.name, req.body.building || null, req.body.capacity]);
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/exams/schedules/:scheduleId/allocate — assign a room + invigilator.
router.post('/schedules/:scheduleId/allocate', MANAGE, param('scheduleId').isInt(),
  [body('room_id').isInt({ min: 1 }), body('seat_capacity').isInt({ min: 1 }),
   body('invigilator_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `INSERT INTO room_allocations (exam_schedule_id, room_id, invigilator_id, seat_capacity)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.scheduleId, req.body.room_id, req.body.invigilator_id || null, req.body.seat_capacity]);
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// ---- Attendance ------------------------------------------------------------
// POST /api/exams/schedules/:scheduleId/attendance — bulk upsert.
// Body: { records: [{ student_id, status: present|absent|late, room_id? }] }
// Officers/admins mark any schedule; lecturers only schedules in their
// own subjects (checked below via lecturerOwnsSchedule).
router.post('/schedules/:scheduleId/attendance', MANAGE_OR_LECTURER, param('scheduleId').isInt(),
  [body('records').isArray({ min: 1 }),
   body('records.*.student_id').isInt({ min: 1 }),
   body('records.*.status').isIn(['present', 'absent', 'late'])], validate,
  async (req, res, next) => {
    try {
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId))) {
          return res.status(403).json({ success: false, error: 'Schedule is not for one of your assigned subjects' });
        }
      }
      const values = [];
      for (const r of req.body.records) {
        const { rows } = await query(
          `INSERT INTO attendance (exam_schedule_id, student_id, room_id, status, marked_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (exam_schedule_id, student_id)
           DO UPDATE SET status = EXCLUDED.status, room_id = EXCLUDED.room_id, marked_by = EXCLUDED.marked_by, marked_at = now()
           RETURNING *`,
          [req.params.scheduleId, r.student_id, r.room_id || null, r.status, req.user.id]);
        values.push(rows[0]);
      }
      await logAudit({ userId: req.user.id, action: 'attendance.record', entityType: 'attendance', entityId: Number(req.params.scheduleId), newValues: { count: values.length }, req });
      return res.json({ success: true, data: values });
    } catch (err) { return next(err); }
  });

router.get('/schedules/:scheduleId/attendance', async (req, res, next) => {
  try {
    // Lecturers see attendance only for schedules in their own subjects;
    // students see only their own row. Officers/admins see the full list.
    const params = [req.params.scheduleId];
    let extra = '';
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope || !(await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId))) {
        return res.status(403).json({ success: false, error: 'Schedule is not for one of your assigned subjects' });
      }
    }
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      params.push(s.rows[0]?.id || -1);
      extra = ` AND a.student_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT a.*, s.student_id, s.full_name FROM attendance a
        JOIN students s ON s.id = a.student_id
       WHERE a.exam_schedule_id = $1${extra} ORDER BY s.full_name`, params);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

module.exports = router;
