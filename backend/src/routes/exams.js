// Examinations, timetables (exam_schedules), rooms & allocations, attendance.
// Workflow steps 4–7: officer creates exam → schedules subjects → assigns
// rooms → attendance is recorded. Lecturers/students read schedules only.
const express = require('express');
const { body, param } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const MANAGE = requireRole('super_admin', 'exam_officer');

// ---- Examinations ---------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search = '', status, semester_id } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`e.title ILIKE $${params.length}`); }
    if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
    if (semester_id) { params.push(semester_id); where.push(`e.semester_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM examinations e ${clause}`, params);
    const { rows } = await query(
      `SELECT e.*, ay.name AS academic_year, s.name AS semester_name,
              (SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id) AS schedule_count,
              (SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published) AS published_results
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
    const schedules = await query(
      `SELECT es.*, sub.code AS subject_code, sub.title AS subject_title,
              er.name AS room_name, t.full_name AS invigilator
         FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
         LEFT JOIN lecturers t ON t.id = ra.invigilator_id
        WHERE es.exam_id = $1 ORDER BY es.exam_date, es.start_time`, [req.params.id]);
    return res.json({ success: true, data: { ...rows[0], schedules: schedules.rows } });
  } catch (err) { return next(err); }
});

router.post('/', MANAGE,
  [body('academic_year_id').isInt({ min: 1 }), body('semester_id').isInt({ min: 1 }),
   body('title').trim().notEmpty(), body('exam_type').isIn(['midterm', 'final', 'quiz', 'supplementary', 'entry']),
   body('start_date').isISO8601(), body('end_date').isISO8601()], validate,
  async (req, res, next) => {
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
router.post('/:id/schedules', MANAGE, param('id').isInt(),
  [body('subject_id').isInt({ min: 1 }), body('exam_date').isISO8601(),
   body('start_time').matches(/^\d{2}:\d{2}/), body('end_time').matches(/^\d{2}:\d{2}/)],
  validate, async (req, res, next) => {
    try {
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
router.post('/schedules/:scheduleId/attendance', MANAGE, param('scheduleId').isInt(),
  [body('records').isArray({ min: 1 }),
   body('records.*.student_id').isInt({ min: 1 }),
   body('records.*.status').isIn(['present', 'absent', 'late'])], validate,
  async (req, res, next) => {
    try {
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
    const { rows } = await query(
      `SELECT a.*, s.student_id, s.full_name FROM attendance a
        JOIN students s ON s.id = a.student_id
       WHERE a.exam_schedule_id = $1 ORDER BY s.full_name`, [req.params.scheduleId]);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

module.exports = router;
