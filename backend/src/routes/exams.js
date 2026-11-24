// Examinations, timetables (exam_schedules), rooms & allocations, attendance.
// Workflow steps 4–7: officer creates exam → schedules subjects → assigns
// rooms → attendance is recorded. Lecturers create exams (incl. quizzes)
// and schedule/mark attendance for their own subjects only; students read
// schedules only.
const express = require('express');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { getLecturerScope, lecturerSubjectSql, lecturerOwnsExam, lecturerOwnsSchedule, lecturerOwnsSubject } = require('../utils/lecturerScope');
const { getDepartmentIdForUser, getInvigilatorScheduleIds } = require('../utils/scopes');

const router = express.Router();
router.use(authenticate);
// Exam Controller approves schedules (PUT /:id status change) and
// allocates rooms/invigilators (POST /schedules/:scheduleId/allocate).
// It shares MANAGE with the other exam-operation routes (rooms,
// registrations, invigilator assignment, incident status) — those are
// exam operations too. It does NOT get DELETE /:id (super_admin only).
const MANAGE = requireRole('super_admin', 'exam_officer', 'exam_controller');
const MANAGE_OR_LECTURER = requireRole('super_admin', 'exam_officer', 'lecturer');
// Attendance marking only: the Exam Controller and an assigned
// invigilator may also mark attendance. Deliberately NOT added to
// MANAGE_OR_LECTURER — that guard also covers exam/schedule creation
// and registration, which invigilators must never do.
const ATTENDANCE_MARKERS = requireRole('super_admin', 'exam_officer', 'lecturer', 'exam_controller', 'invigilator');

// ---- Exam-management helpers (migration 008) ------------------------------
// Schedule conflict detection. Two sessions clash when they share the
// same exam_date and their time windows overlap; end == start is NOT an
// overlap (a session ending at 10:00 and one starting at 10:00 do not
// clash). Times are 'HH:MM' from the request or 'HH:MM:SS' from
// Postgres — comparing the first five characters is a correct
// chronological comparison for zero-padded 24-hour times.
async function getSchedule(scheduleId) {
  const { rows } = await query(
    `SELECT es.*, e.title AS exam_title FROM exam_schedules es
        JOIN examinations e ON e.id = es.exam_id WHERE es.id = $1`,
    [scheduleId]);
  return rows[0] || null;
}

// (a) Room double-booking: another schedule already allocated this room
// for an overlapping window on the same date.
async function findRoomConflict(roomId, examDate, startTime, endTime, excludeScheduleId) {
  const params = [roomId, examDate, startTime, endTime];
  let exclude = '';
  if (excludeScheduleId != null) {
    params.push(excludeScheduleId);
    exclude = ` AND es.id <> $${params.length}`;
  }
  const { rows } = await query(
    `SELECT es.id AS schedule_id, es.exam_date, es.start_time, es.end_time,
            e.title AS exam_title, sub.code AS subject_code, er.name AS room_name
       FROM room_allocations ra
       JOIN exam_schedules es ON es.id = ra.exam_schedule_id
       JOIN examinations e ON e.id = es.exam_id
       JOIN subjects sub ON sub.id = es.subject_id
       JOIN exam_rooms er ON er.id = ra.room_id
      WHERE ra.room_id = $1 AND es.exam_date = $2
        AND es.start_time < $4 AND es.end_time > $3${exclude}
      ORDER BY es.start_time LIMIT 1`,
    params);
  return rows[0] || null;
}

// (b) Student double-booking: any of the given students is enrolled in
// a subject scheduled in an overlapping window on the same date (in any
// examination). Returns up to 10 conflicting students, named.
async function findStudentConflicts(studentIds, examDate, startTime, endTime, excludeScheduleId) {
  if (!studentIds.length) return [];
  const params = [examDate, startTime, endTime, studentIds];
  let exclude = '';
  if (excludeScheduleId != null) {
    params.push(excludeScheduleId);
    exclude = ` AND es.id <> $${params.length}`;
  }
  const { rows } = await query(
    `SELECT DISTINCT s.id AS student_id, s.student_id AS student_no, s.full_name,
            es.id AS schedule_id, e.title AS exam_title, sub.code AS subject_code
       FROM exam_schedules es
       JOIN examinations e ON e.id = es.exam_id
       JOIN subjects sub ON sub.id = es.subject_id
       JOIN enrollments en ON en.subject_id = es.subject_id AND en.status = 'enrolled'
       JOIN students s ON s.id = en.student_id
      WHERE es.exam_date = $1 AND es.start_time < $3 AND es.end_time > $2
        AND en.student_id = ANY($4::int[])${exclude}
      ORDER BY s.full_name LIMIT 10`,
    params);
  return rows;
}

// (c) Invigilator double-booking: the same lecturer (via the legacy
// room_allocations.invigilator_id or invigilator_assignments.lecturer_id)
// or the same user (invigilator_assignments.user_id) is already assigned
// to an overlapping session on the same date.
async function findInvigilatorConflict({ lecturerId, userId }, examDate, startTime, endTime, excludeScheduleId) {
  const params = [examDate, startTime, endTime];
  const conditions = [];
  if (lecturerId != null) {
    params.push(lecturerId);
    conditions.push(`(ra.invigilator_id = $${params.length} OR ia.lecturer_id = $${params.length})`);
  }
  if (userId != null) {
    params.push(userId);
    conditions.push(`(ia.user_id = $${params.length})`);
  }
  if (!conditions.length) return null;
  let exclude = '';
  if (excludeScheduleId != null) {
    params.push(excludeScheduleId);
    exclude = ` AND es.id <> $${params.length}`;
  }
  const { rows } = await query(
    `SELECT DISTINCT es.id AS schedule_id, es.exam_date, es.start_time, es.end_time,
            e.title AS exam_title, sub.code AS subject_code
       FROM exam_schedules es
       JOIN examinations e ON e.id = es.exam_id
       JOIN subjects sub ON sub.id = es.subject_id
       LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
       LEFT JOIN invigilator_assignments ia ON ia.exam_schedule_id = es.id
      WHERE es.exam_date = $1 AND es.start_time < $3 AND es.end_time > $2
        AND (${conditions.join(' OR ')})${exclude}
      ORDER BY es.start_time LIMIT 1`,
    params);
  return rows[0] || null;
}

function roomConflictMessage(c) {
  return `Room ${c.room_name} is already booked for ${c.exam_title} (${c.subject_code}) on ${String(c.exam_date).slice(0, 10)} ${String(c.start_time).slice(0, 5)}–${String(c.end_time).slice(0, 5)}`;
}

function studentConflictMessage(conflicts) {
  const names = conflicts.slice(0, 3).map((c) => `${c.full_name} (${c.student_no})`).join(', ');
  const first = conflicts[0];
  const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more student(s)` : '';
  return `Schedule overlaps ${first.exam_title} (${first.subject_code}): ${names}${more} would have two exams at the same time`;
}

function invigilatorConflictMessage(c) {
  return `Invigilator is already assigned to ${c.exam_title} (${c.subject_code}) on ${String(c.exam_date).slice(0, 10)} ${String(c.start_time).slice(0, 5)}–${String(c.end_time).slice(0, 5)}`;
}

// Lecturers row for a user (null when the user has no linked row).
async function lecturerIdForUser(userId) {
  const { rows } = await query('SELECT id FROM lecturers WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

// True when the user invigilates this session: an assignment by user_id,
// or by lecturer_id / legacy room_allocations.invigilator_id via their
// linked lecturers row.
async function isAssignedInvigilator(userId, scheduleId) {
  const lectId = await lecturerIdForUser(userId);
  const params = [scheduleId, userId];
  let extra = '';
  if (lectId) {
    params.push(lectId);
    extra = ' OR ia.lecturer_id = $3 OR ra.invigilator_id = $3';
  }
  const { rows } = await query(
    `SELECT 1 FROM exam_schedules es
       LEFT JOIN invigilator_assignments ia ON ia.exam_schedule_id = es.id
       LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
      WHERE es.id = $1 AND (ia.user_id = $2${extra}) LIMIT 1`,
    params);
  return rows.length > 0;
}

// Student row id for the signed-in student user (null when none).
async function studentIdForUser(userId) {
  const { rows } = await query('SELECT id FROM students WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

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
    // Department heads see only exams with a schedule in a subject of
    // their department. No linked department → empty list.
    let deptId = null;
    if (req.user.role === 'department_head') {
      deptId = await getDepartmentIdForUser(req.user.id);
      if (deptId == null) return res.json(paginatedResponse([], 0, { page, limit }));
      params.push(deptId);
      where.push(`EXISTS (SELECT 1 FROM exam_schedules es WHERE es.exam_id = e.id
                          AND es.subject_id IN (SELECT id FROM subjects WHERE department_id = $${params.length}))`);
    }
    // Invigilators see only exams containing one of their assigned
    // sessions. No assignment → empty list.
    let invScheduleIds = null;
    if (req.user.role === 'invigilator') {
      invScheduleIds = await getInvigilatorScheduleIds(req.user.id);
      if (!invScheduleIds.length) return res.json(paginatedResponse([], 0, { page, limit }));
      params.push(invScheduleIds);
      where.push(`EXISTS (SELECT 1 FROM exam_schedules es WHERE es.exam_id = e.id
                          AND es.id = ANY($${params.length}::int[]))`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM examinations e ${clause}`, params);
    // The two aggregate counts are scoped the same way for lecturers, so
    // an exam row never leaks how many other subjects / published results
    // it has. lecturerId / deptId come from the DB (never user input), as in
    // dashboard.js; invigilator ids are DB-derived ints, interpolated the
    // same way (they cannot come from a request parameter here).
    const invIdList = invScheduleIds !== null
      ? invScheduleIds.map((n) => Number(n)).join(',')
      : null;
    const scheduleCountSql = lecturerId !== null
      ? `(SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id AND subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${lecturerId}))`
      : deptId !== null
        ? `(SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id AND subject_id IN (SELECT id FROM subjects WHERE department_id = ${deptId}))`
        : invScheduleIds !== null
          ? `(SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id AND id IN (${invIdList}))`
          : '(SELECT count(*)::int FROM exam_schedules WHERE exam_id = e.id)';
    const publishedSql = lecturerId !== null
      ? `(SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published AND subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${lecturerId}))`
      : deptId !== null
        ? `(SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published AND subject_id IN (SELECT id FROM subjects WHERE department_id = ${deptId}))`
        : invScheduleIds !== null
          ? `(SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published AND subject_id IN (SELECT subject_id FROM exam_schedules WHERE id IN (${invIdList})))`
          : '(SELECT count(*)::int FROM results WHERE exam_id = e.id AND is_published)';
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
    // A department head may open an exam only when it has a schedule in
    // a subject of their department; no linked department → 403.
    let deptId = null;
    if (req.user.role === 'department_head') {
      deptId = await getDepartmentIdForUser(req.user.id);
      const owns = deptId != null && (await query(
        `SELECT 1 FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
          WHERE es.exam_id = $1 AND sub.department_id = $2 LIMIT 1`,
        [req.params.id, deptId])).rows.length > 0;
      if (!owns) {
        return res.status(403).json({ success: false, error: 'Examination has no scheduled subject in your department' });
      }
    }
    // An invigilator may open an exam only when it contains one of
    // their assigned sessions.
    let invScheduleIds = null;
    if (req.user.role === 'invigilator') {
      invScheduleIds = await getInvigilatorScheduleIds(req.user.id);
      const owns = (await query(
        'SELECT 1 FROM exam_schedules WHERE exam_id = $1 AND id = ANY($2::int[]) LIMIT 1',
        [req.params.id, invScheduleIds.length ? invScheduleIds : [-1]])).rows.length > 0;
      if (!owns) {
        return res.status(403).json({ success: false, error: 'You are not assigned to any session of this examination' });
      }
    }
    const scheduleParams = [req.params.id];
    let scheduleClause = 'WHERE es.exam_id = $1';
    if (lecturerId !== null) {
      scheduleParams.push(lecturerId);
      scheduleClause += ` AND ${lecturerSubjectSql('es.subject_id', scheduleParams.length)}`;
    }
    if (deptId !== null) {
      scheduleParams.push(deptId);
      scheduleClause += ` AND es.subject_id IN (SELECT id FROM subjects WHERE department_id = $${scheduleParams.length})`;
    }
    if (invScheduleIds !== null) {
      scheduleParams.push(invScheduleIds.length ? invScheduleIds : [-1]);
      scheduleClause += ` AND es.id = ANY($${scheduleParams.length}::int[])`;
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
      if (req.body.end_time <= req.body.start_time) {
        return res.status(400).json({ success: false, error: 'end_time must be after start_time' });
      }
      // (b) Student conflict: a student enrolled in this subject who is
      // also enrolled in a subject scheduled at an overlapping time on
      // the same date would have two exams at once — reject.
      const enrolled = await query(
        "SELECT student_id FROM enrollments WHERE subject_id = $1 AND status = 'enrolled'",
        [req.body.subject_id]);
      const conflicts = await findStudentConflicts(
        enrolled.rows.map((r) => r.student_id),
        req.body.exam_date, req.body.start_time, req.body.end_time, null);
      if (conflicts.length) {
        return res.status(400).json({ success: false, error: studentConflictMessage(conflicts), conflicts });
      }
      const { rows } = await query(
        `INSERT INTO exam_schedules (exam_id, subject_id, exam_date, start_time, end_time)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, req.body.subject_id, req.body.exam_date, req.body.start_time, req.body.end_time]);
      await logAudit({ userId: req.user.id, action: 'schedules.create', entityType: 'exam_schedules', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// PUT /api/exams/:examId/schedules/:scheduleId — move / retime a schedule.
// Runs all three conflict checks against the NEW window: (a) every room
// already allocated to this schedule, (b) students enrolled in the
// schedule's subject, (c) every invigilator on this schedule (legacy
// room_allocations.invigilator_id and invigilator_assignments).
router.put('/:examId/schedules/:scheduleId', MANAGE_OR_LECTURER,
  param('examId').isInt(), param('scheduleId').isInt(),
  [body('exam_date').optional().isISO8601(),
   body('start_time').optional().matches(/^\d{2}:\d{2}/),
   body('end_time').optional().matches(/^\d{2}:\d{2}/)], validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule || Number(schedule.exam_id) !== Number(req.params.examId)) {
        return res.status(404).json({ success: false, error: 'Schedule not found' });
      }
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId))) {
          return res.status(403).json({ success: false, error: 'Schedule is not for one of your assigned subjects' });
        }
      }
      const examDate = req.body.exam_date || String(schedule.exam_date).slice(0, 10);
      const startTime = req.body.start_time || String(schedule.start_time).slice(0, 5);
      const endTime = req.body.end_time || String(schedule.end_time).slice(0, 5);
      if (endTime <= startTime) {
        return res.status(400).json({ success: false, error: 'end_time must be after start_time' });
      }
      // (a) Rooms already allocated to this schedule.
      const rooms = await query('SELECT room_id FROM room_allocations WHERE exam_schedule_id = $1', [schedule.id]);
      for (const r of rooms.rows) {
        const c = await findRoomConflict(r.room_id, examDate, startTime, endTime, schedule.id);
        if (c) return res.status(400).json({ success: false, error: roomConflictMessage(c), conflict: c });
      }
      // (b) Students enrolled in this schedule's subject.
      const enrolled = await query(
        "SELECT student_id FROM enrollments WHERE subject_id = $1 AND status = 'enrolled'",
        [schedule.subject_id]);
      const studentConflicts = await findStudentConflicts(
        enrolled.rows.map((r) => r.student_id), examDate, startTime, endTime, schedule.id);
      if (studentConflicts.length) {
        return res.status(400).json({ success: false, error: studentConflictMessage(studentConflicts), conflicts: studentConflicts });
      }
      // (c) Invigilators on this schedule (legacy + new assignments).
      const invigilators = await query(
        `SELECT invigilator_id AS lecturer_id, NULL::int AS user_id FROM room_allocations
          WHERE exam_schedule_id = $1 AND invigilator_id IS NOT NULL
          UNION SELECT lecturer_id, user_id FROM invigilator_assignments WHERE exam_schedule_id = $1`,
        [schedule.id]);
      for (const inv of invigilators.rows) {
        const c = await findInvigilatorConflict(
          { lecturerId: inv.lecturer_id, userId: inv.user_id }, examDate, startTime, endTime, schedule.id);
        if (c) return res.status(400).json({ success: false, error: invigilatorConflictMessage(c), conflict: c });
      }
      const { rows } = await query(
        `UPDATE exam_schedules SET exam_date = $1, start_time = $2, end_time = $3
          WHERE id = $4 RETURNING *`,
        [examDate, startTime, endTime, schedule.id]);
      await logAudit({ userId: req.user.id, action: 'schedules.update', entityType: 'exam_schedules', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
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
// Conflict checks: (a) the room must not already be booked for an
// overlapping session that day; (c) the invigilator must not already be
// assigned to an overlapping session. seat_capacity may not exceed the
// room's capacity.
router.post('/schedules/:scheduleId/allocate', MANAGE, param('scheduleId').isInt(),
  [body('room_id').isInt({ min: 1 }), body('seat_capacity').isInt({ min: 1 }),
   body('invigilator_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      const room = await query('SELECT * FROM exam_rooms WHERE id = $1', [req.body.room_id]);
      if (!room.rows[0]) return res.status(404).json({ success: false, error: 'Room not found' });
      if (req.body.seat_capacity > room.rows[0].capacity) {
        return res.status(400).json({ success: false, error: `seat_capacity (${req.body.seat_capacity}) exceeds room capacity (${room.rows[0].capacity})` });
      }
      const examDate = String(schedule.exam_date).slice(0, 10);
      const startTime = String(schedule.start_time).slice(0, 5);
      const endTime = String(schedule.end_time).slice(0, 5);
      const roomConflict = await findRoomConflict(req.body.room_id, examDate, startTime, endTime, schedule.id);
      if (roomConflict) {
        return res.status(400).json({ success: false, error: roomConflictMessage(roomConflict), conflict: roomConflict });
      }
      if (req.body.invigilator_id) {
        const lecturer = await query('SELECT id FROM lecturers WHERE id = $1', [req.body.invigilator_id]);
        if (!lecturer.rows[0]) return res.status(404).json({ success: false, error: 'Invigilator (lecturer) not found' });
        const invConflict = await findInvigilatorConflict(
          { lecturerId: req.body.invigilator_id, userId: null }, examDate, startTime, endTime, schedule.id);
        if (invConflict) {
          return res.status(400).json({ success: false, error: invigilatorConflictMessage(invConflict), conflict: invConflict });
        }
      }
      const { rows } = await query(
        `INSERT INTO room_allocations (exam_schedule_id, room_id, invigilator_id, seat_capacity)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.scheduleId, req.body.room_id, req.body.invigilator_id || null, req.body.seat_capacity]);
      await logAudit({ userId: req.user.id, action: 'schedules.allocate', entityType: 'room_allocations', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// ---- Attendance ------------------------------------------------------------
// POST /api/exams/schedules/:scheduleId/attendance — bulk upsert.
// Body: { records: [{ student_id, status: present|absent|late, room_id? }] }
// Officers/admins/controller mark any schedule; lecturers only schedules in their
// own subjects (checked below via lecturerOwnsSchedule); invigilators only
// sessions they are assigned to (checked below via isAssignedInvigilator).
router.post('/schedules/:scheduleId/attendance', ATTENDANCE_MARKERS, param('scheduleId').isInt(),
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
      // Invigilator-assignment check, mirroring the lecturer check
      // above: the new invigilator_assignments table first (via
      // isAssignedInvigilator), falling back to the legacy
      // room_allocations.invigilator_id name match inside that helper.
      if (req.user.role === 'invigilator' && !(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
        return res.status(403).json({ success: false, error: 'You are not assigned to this session' });
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
    // students see only their own row. Officers/admins/controller see the
    // full list. Department heads see only schedules in their department;
    // invigilators only sessions they are assigned to.
    const params = [req.params.scheduleId];
    let extra = '';
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope || !(await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId))) {
        return res.status(403).json({ success: false, error: 'Schedule is not for one of your assigned subjects' });
      }
    }
    if (req.user.role === 'invigilator' && !(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
      return res.status(403).json({ success: false, error: 'You are not assigned to this session' });
    }
    if (req.user.role === 'department_head') {
      const deptId = await getDepartmentIdForUser(req.user.id);
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      const owns = deptId != null && (await query(
        'SELECT 1 FROM subjects WHERE id = $1 AND department_id = $2',
        [schedule.subject_id, deptId])).rows.length > 0;
      if (!owns) {
        return res.status(403).json({ success: false, error: 'Schedule is not in your department' });
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

// ---- Exam registration (migration 008) ------------------------------------
// Registration is STAFF-ONLY (super_admin / exam_officer, plus a lecturer
// for exams containing one of their own subjects). Students do NOT
// self-register: there is no eligibility/payment gate yet, and an
// open self-registration would let a student register for an exam whose
// subjects they are not enrolled in.
async function lecturerMayManageExam(req, examId) {
  if (req.user.role !== 'lecturer') return true;
  const scope = await getLecturerScope(req.user.id);
  return Boolean(scope && (await lecturerOwnsExam(scope.lecturerId, examId)));
}

// POST /api/exams/:id/registrations — register one student.
router.post('/:id/registrations', MANAGE_OR_LECTURER, param('id').isInt(),
  [body('student_id').isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const exam = await query('SELECT id FROM examinations WHERE id = $1', [req.params.id]);
      if (!exam.rows[0]) return res.status(404).json({ success: false, error: 'Examination not found' });
      if (!(await lecturerMayManageExam(req, req.params.id))) {
        return res.status(403).json({ success: false, error: 'Examination is not for one of your assigned subjects' });
      }
      const student = await query("SELECT id, status FROM students WHERE id = $1", [req.body.student_id]);
      if (!student.rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      if (student.rows[0].status !== 'active') {
        return res.status(400).json({ success: false, error: 'Student is not active' });
      }
      const existing = await query(
        'SELECT status FROM exam_registrations WHERE exam_id = $1 AND student_id = $2',
        [req.params.id, req.body.student_id]);
      if (existing.rows[0]?.status === 'registered') {
        return res.status(409).json({ success: false, error: 'Student is already registered for this examination' });
      }
      // A student registered for another exam whose sessions overlap this
      // exam's sessions would have two exams at once — reject.
      const examSchedules = await query(
        'SELECT exam_date, start_time, end_time FROM exam_schedules WHERE exam_id = $1', [req.params.id]);
      for (const s of examSchedules.rows) {
        const conflicts = await findStudentConflicts(
          [req.body.student_id], String(s.exam_date).slice(0, 10),
          String(s.start_time).slice(0, 5), String(s.end_time).slice(0, 5), null);
        if (conflicts.length) {
          return res.status(400).json({ success: false, error: studentConflictMessage(conflicts), conflicts });
        }
      }
      const { rows } = await query(
        `INSERT INTO exam_registrations (exam_id, student_id, status, registered_by)
         VALUES ($1,$2,'registered',$3)
         ON CONFLICT (exam_id, student_id)
         DO UPDATE SET status = 'registered', registered_by = EXCLUDED.registered_by
         RETURNING *`,
        [req.params.id, req.body.student_id, req.user.id]);
      await logAudit({ userId: req.user.id, action: 'exams.register', entityType: 'exam_registrations', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/exams/:id/registrations/bulk — register a cohort: by
// department, admission year and/or current semester, or an explicit
// student_ids list. Only ACTIVE students enrolled in at least one subject
// scheduled in this exam are registered; students whose other exams
// overlap this exam's sessions are skipped and reported.
router.post('/:id/registrations/bulk', MANAGE_OR_LECTURER, param('id').isInt(),
  [body('department_id').optional().isInt({ min: 1 }),
   body('admission_year').optional().isInt({ min: 2000, max: 2100 }),
   body('current_semester').optional().isInt({ min: 1, max: 8 }),
   body('student_ids').optional().isArray(),
   body('student_ids.*').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const exam = await query('SELECT id FROM examinations WHERE id = $1', [req.params.id]);
      if (!exam.rows[0]) return res.status(404).json({ success: false, error: 'Examination not found' });
      if (!(await lecturerMayManageExam(req, req.params.id))) {
        return res.status(403).json({ success: false, error: 'Examination is not for one of your assigned subjects' });
      }
      const b = req.body;
      if (b.department_id == null && b.admission_year == null && b.current_semester == null
          && !(Array.isArray(b.student_ids) && b.student_ids.length)) {
        return res.status(400).json({ success: false, error: 'Provide at least one selector: department_id, admission_year, current_semester or student_ids' });
      }
      const params = [req.params.id];
      const filters = [];
      if (b.department_id != null) { params.push(b.department_id); filters.push(`s.department_id = $${params.length}`); }
      if (b.admission_year != null) { params.push(b.admission_year); filters.push(`s.admission_year = $${params.length}`); }
      if (b.current_semester != null) { params.push(b.current_semester); filters.push(`s.current_semester = $${params.length}`); }
      if (Array.isArray(b.student_ids) && b.student_ids.length) { params.push(b.student_ids); filters.push(`s.id = ANY($${params.length}::int[])`); }
      const candidates = await query(
        `SELECT DISTINCT s.id, s.student_id, s.full_name FROM students s
           JOIN enrollments en ON en.student_id = s.id AND en.status = 'enrolled'
           JOIN exam_schedules es ON es.subject_id = en.subject_id AND es.exam_id = $1
          WHERE s.status = 'active'${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
          ORDER BY s.full_name`,
        params);
      const candidateIds = candidates.rows.map((r) => r.id);
      // Students whose enrolments in OTHER exams overlap this exam's
      // sessions are skipped (they would have two exams at once).
      const clashing = candidateIds.length ? (await query(
        `SELECT DISTINCT s.id FROM students s
           JOIN enrollments en2 ON en2.student_id = s.id AND en2.status = 'enrolled'
           JOIN exam_schedules es2 ON es2.subject_id = en2.subject_id AND es2.exam_id <> $1
           JOIN exam_schedules es1 ON es1.exam_id = $1
             AND es1.exam_date = es2.exam_date
             AND es2.start_time < es1.end_time AND es2.end_time > es1.start_time
          WHERE s.id = ANY($2::int[])`,
        [req.params.id, candidateIds])).rows.map((r) => r.id) : [];
      const clashSet = new Set(clashing);
      const already = await query(
        "SELECT student_id FROM exam_registrations WHERE exam_id = $1 AND status = 'registered' AND student_id = ANY($2::int[])",
        [req.params.id, candidateIds.length ? candidateIds : [-1]]);
      const alreadySet = new Set(already.rows.map((r) => r.student_id));
      const toRegister = candidates.rows.filter((r) => !clashSet.has(r.id) && !alreadySet.has(r.id));
      const registered = await withTransaction(async (client) => {
        let n = 0;
        for (const r of toRegister) {
          await client.query(
            `INSERT INTO exam_registrations (exam_id, student_id, status, registered_by)
             VALUES ($1,$2,'registered',$3)
             ON CONFLICT (exam_id, student_id)
             DO UPDATE SET status = 'registered', registered_by = EXCLUDED.registered_by`,
            [req.params.id, r.id, req.user.id]);
          n += 1;
        }
        return n;
      });
      await logAudit({ userId: req.user.id, action: 'exams.register_bulk', entityType: 'exam_registrations', entityId: Number(req.params.id), newValues: { registered, already_registered: alreadySet.size, skipped_conflict: clashSet.size }, req });
      return res.status(201).json({
        success: true,
        data: {
          registered,
          already_registered: alreadySet.size,
          skipped_conflict: clashSet.size,
          total_candidates: candidates.rows.length,
        },
      });
    } catch (err) { return next(err); }
  });

// GET /api/exams/:id/registrations — registered students for an exam.
// Lecturers: only exams with one of their subjects. Students: own row only.
router.get('/:id/registrations', param('id').isInt(), validate, async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    if (req.user.role === 'lecturer' && !(await lecturerMayManageExam(req, req.params.id))) {
      return res.status(403).json({ success: false, error: 'Examination is not for one of your assigned subjects' });
    }
    const params = [req.params.id];
    let extra = '';
    if (req.user.role === 'student') {
      const sid = await studentIdForUser(req.user.id);
      params.push(sid || -1);
      extra = ` AND er.student_id = $${params.length}`;
    }
    const total = await query(
      `SELECT count(*)::int AS n FROM exam_registrations er WHERE er.exam_id = $1${extra}`, params);
    const { rows } = await query(
      `SELECT er.*, s.student_id AS student_no, s.full_name, s.email,
              d.name AS department_name
         FROM exam_registrations er
         JOIN students s ON s.id = er.student_id
         JOIN departments d ON d.id = s.department_id
        WHERE er.exam_id = $1${extra}
        ORDER BY s.full_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// DELETE /api/exams/:id/registrations/:studentId — cancel a registration.
router.delete('/:id/registrations/:studentId', MANAGE,
  param('id').isInt(), param('studentId').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE exam_registrations SET status = 'cancelled'
          WHERE exam_id = $1 AND student_id = $2 AND status = 'registered' RETURNING *`,
        [req.params.id, req.params.studentId]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Active registration not found' });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// ---- Invigilator assignment (migration 008) --------------------------------
// An invigilator is a lecturer (the path used today — see
// room_allocations.invigilator_id) or a user whose role is 'invigilator'
// or 'lecturer' (the future path; the 'invigilator' role row is created
// by migration 008). Exactly one of lecturer_id / user_id is accepted.
router.post('/schedules/:scheduleId/invigilators', MANAGE, param('scheduleId').isInt(),
  [body('lecturer_id').optional().isInt({ min: 1 }),
   body('user_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const { lecturer_id: lecturerId, user_id: userId } = req.body;
      if ((lecturerId == null) === (userId == null)) {
        return res.status(400).json({ success: false, error: 'Provide exactly one of lecturer_id or user_id' });
      }
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      if (lecturerId != null) {
        const lect = await query('SELECT id FROM lecturers WHERE id = $1', [lecturerId]);
        if (!lect.rows[0]) return res.status(404).json({ success: false, error: 'Lecturer not found' });
      } else {
        const u = await query(
          `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.id = $1 AND r.name IN ('lecturer', 'invigilator')`,
          [userId]);
        if (!u.rows[0]) return res.status(404).json({ success: false, error: 'User not found or user is not a lecturer / invigilator' });
      }
      // (c) Invigilator conflict: overlapping session on the same date.
      const conflict = await findInvigilatorConflict(
        { lecturerId: lecturerId ?? null, userId: userId ?? null },
        String(schedule.exam_date).slice(0, 10),
        String(schedule.start_time).slice(0, 5), String(schedule.end_time).slice(0, 5),
        schedule.id);
      if (conflict) {
        return res.status(400).json({ success: false, error: invigilatorConflictMessage(conflict), conflict });
      }
      const { rows } = await query(
        `INSERT INTO invigilator_assignments (exam_schedule_id, lecturer_id, user_id, assigned_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.scheduleId, lecturerId ?? null, userId ?? null, req.user.id]);
      await logAudit({ userId: req.user.id, action: 'schedules.assign_invigilator', entityType: 'invigilator_assignments', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

router.get('/schedules/:scheduleId/invigilators', param('scheduleId').isInt(), validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      if (req.user.role === 'student') {
        return res.status(403).json({ success: false, error: 'Students cannot view invigilator assignments' });
      }
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        const owns = scope && (await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId));
        if (!owns && !(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
          return res.status(403).json({ success: false, error: 'Schedule is not one of your assigned subjects or sessions' });
        }
      }
      if (req.user.role === 'invigilator' && !(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
        return res.status(403).json({ success: false, error: 'You are not assigned to this session' });
      }
      const { rows } = await query(
        `SELECT ia.*, l.full_name AS lecturer_name, l.employee_id,
                u.full_name AS user_name, u.email AS user_email
           FROM invigilator_assignments ia
           LEFT JOIN lecturers l ON l.id = ia.lecturer_id
           LEFT JOIN users u ON u.id = ia.user_id
          WHERE ia.exam_schedule_id = $1 ORDER BY ia.created_at`,
        [req.params.scheduleId]);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

router.delete('/schedules/:scheduleId/invigilators/:assignmentId', MANAGE,
  param('scheduleId').isInt(), param('assignmentId').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'DELETE FROM invigilator_assignments WHERE id = $1 AND exam_schedule_id = $2 RETURNING id',
        [req.params.assignmentId, req.params.scheduleId]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Invigilator assignment not found' });
      return res.json({ success: true, message: 'Invigilator assignment removed' });
    } catch (err) { return next(err); }
  });

// GET /api/exams/invigilator/my-sessions — sessions assigned to the
// signed-in invigilator (via invigilator_assignments by user or lecturer,
// or the legacy room_allocations.invigilator_id). Anyone else gets an
// empty list, never the whole table.
router.get('/invigilator/my-sessions', async (req, res, next) => {
  try {
    const lectId = await lecturerIdForUser(req.user.id);
    const params = [req.user.id];
    const assignmentConds = ['ia.user_id = $1'];
    if (lectId) {
      params.push(lectId);
      assignmentConds.push(`ia.lecturer_id = $${params.length}`);
    }
    const legacyCond = lectId
      ? ` OR es.id IN (SELECT exam_schedule_id FROM room_allocations WHERE invigilator_id = $${params.length})`
      : '';
    const { rows } = await query(
      `SELECT es.*, e.title AS exam_title, sub.code AS subject_code,
              sub.title AS subject_title, er.name AS room_name
         FROM exam_schedules es
         JOIN examinations e ON e.id = es.exam_id
         JOIN subjects sub ON sub.id = es.subject_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
        WHERE es.id IN (SELECT exam_schedule_id FROM invigilator_assignments ia
                        WHERE ${assignmentConds.join(' OR ')})${legacyCond}
        ORDER BY es.exam_date, es.start_time`,
      params);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// ---- Incident / misconduct reports (migration 008) --------------------------
// Filed by staff, or by the lecturer / invigilator assigned to the
// session. reported_by is always the signed-in user — never taken from
// the request body.
const INCIDENT_ROLES = requireRole('super_admin', 'exam_officer', 'lecturer', 'invigilator');

router.post('/schedules/:scheduleId/incidents', INCIDENT_ROLES, param('scheduleId').isInt(),
  [body('type').isIn(['misconduct', 'absence', 'other']),
   body('description').trim().isLength({ min: 3 }),
   body('student_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        const owns = scope && (await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId));
        if (!owns && !(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
          return res.status(403).json({ success: false, error: 'Schedule is not one of your assigned subjects or sessions' });
        }
      }
      if (req.user.role === 'invigilator' && !(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
        return res.status(403).json({ success: false, error: 'You are not assigned to this session' });
      }
      if (req.body.student_id != null) {
        const s = await query('SELECT id FROM students WHERE id = $1', [req.body.student_id]);
        if (!s.rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      }
      const { rows } = await query(
        `INSERT INTO exam_incidents (exam_schedule_id, student_id, type, description, reported_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.scheduleId, req.body.student_id || null, req.body.type, req.body.description, req.user.id]);
      await logAudit({ userId: req.user.id, action: 'incidents.file', entityType: 'exam_incidents', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// GET incidents for a schedule. Staff see all; a lecturer who owns the
// schedule sees all; an assigned invigilator sees only the incidents
// they reported. Students cannot view incidents.
router.get('/schedules/:scheduleId/incidents', param('scheduleId').isInt(), validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      if (req.user.role === 'student') {
        return res.status(403).json({ success: false, error: 'Students cannot view incident reports' });
      }
      const isStaff = ['super_admin', 'exam_officer'].includes(req.user.role);
      let scopeClause = '';
      const params = [req.params.scheduleId];
      if (!isStaff) {
        let seesAll = false;
        if (req.user.role === 'lecturer') {
          const scope = await getLecturerScope(req.user.id);
          seesAll = Boolean(scope && (await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId)));
        }
        if (!seesAll) {
          if (!(await isAssignedInvigilator(req.user.id, req.params.scheduleId))) {
            return res.status(403).json({ success: false, error: 'You are not assigned to this session' });
          }
          params.push(req.user.id);
          scopeClause = ` AND ei.reported_by = $${params.length}`;
        }
      }
      const { rows } = await query(
        `SELECT ei.*, s.student_id AS student_no, s.full_name AS student_name,
                u.full_name AS reported_by_name
           FROM exam_incidents ei
           LEFT JOIN students s ON s.id = ei.student_id
           LEFT JOIN users u ON u.id = ei.reported_by
          WHERE ei.exam_schedule_id = $1${scopeClause}
          ORDER BY ei.created_at DESC`,
        params);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

// PATCH incident status (staff only): open -> under_review -> resolved.
router.patch('/schedules/:scheduleId/incidents/:incidentId', MANAGE,
  param('scheduleId').isInt(), param('incidentId').isInt(),
  [body('status').isIn(['open', 'under_review', 'resolved'])], validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE exam_incidents SET status = $1 WHERE id = $2 AND exam_schedule_id = $3 RETURNING *`,
        [req.body.status, req.params.incidentId, req.params.scheduleId]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Incident not found' });
      await logAudit({ userId: req.user.id, action: 'incidents.update', entityType: 'exam_incidents', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// ---- Per-student seating (migration 008) ------------------------------------
// Seats are assigned only to students REGISTERED for the exam (status
// 'registered'), one seat_number per student, unique per schedule. The
// total number of seated students may not exceed the schedule's total
// allocated seat_capacity (when rooms have been allocated).
router.post('/schedules/:scheduleId/seating', MANAGE_OR_LECTURER, param('scheduleId').isInt(),
  [body('assignments').isArray({ min: 1 }),
   body('assignments.*.student_id').isInt({ min: 1 }),
   body('assignments.*.seat_number').trim().notEmpty(),
   body('assignments.*.room_id').optional().isInt({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId))) {
          return res.status(403).json({ success: false, error: 'Schedule is not for one of your assigned subjects' });
        }
      }
      const assignments = req.body.assignments;
      const studentIds = assignments.map((a) => a.student_id);
      const seatNumbers = assignments.map((a) => String(a.seat_number).trim());
      if (new Set(studentIds).size !== studentIds.length) {
        return res.status(400).json({ success: false, error: 'Duplicate student in seating assignments' });
      }
      if (new Set(seatNumbers).size !== seatNumbers.length) {
        return res.status(400).json({ success: false, error: 'Duplicate seat number in seating assignments' });
      }
      const students = await query('SELECT id FROM students WHERE id = ANY($1::int[])', [studentIds]);
      if (students.rows.length !== studentIds.length) {
        return res.status(400).json({ success: false, error: 'One or more students do not exist' });
      }
      const registered = await query(
        "SELECT student_id FROM exam_registrations WHERE exam_id = $1 AND status = 'registered' AND student_id = ANY($2::int[])",
        [schedule.exam_id, studentIds]);
      const registeredSet = new Set(registered.rows.map((r) => r.student_id));
      const unregistered = studentIds.filter((id) => !registeredSet.has(id));
      if (unregistered.length) {
        return res.status(400).json({ success: false, error: `Students not registered for this examination: ${unregistered.join(', ')} — register them first` });
      }
      // Seat number already taken by a DIFFERENT student on this schedule.
      const taken = await query(
        `SELECT seat_number, student_id FROM seat_assignments
          WHERE exam_schedule_id = $1 AND seat_number = ANY($2::text[])`,
        [schedule.id, seatNumbers]);
      const seatOwner = new Map(taken.rows.map((r) => [r.seat_number, r.student_id]));
      for (const a of assignments) {
        const owner = seatOwner.get(String(a.seat_number).trim());
        if (owner != null && owner !== a.student_id) {
          return res.status(400).json({ success: false, error: `Seat ${a.seat_number} is already assigned to another student on this schedule` });
        }
      }
      // Rooms in the payload must be allocated to this schedule (when any
      // allocation exists), and the seat count must fit total capacity.
      const allocations = await query(
        'SELECT room_id, seat_capacity FROM room_allocations WHERE exam_schedule_id = $1', [schedule.id]);
      if (allocations.rows.length) {
        const allocatedRooms = new Set(allocations.rows.map((r) => r.room_id));
        for (const a of assignments) {
          if (a.room_id != null && !allocatedRooms.has(a.room_id)) {
            return res.status(400).json({ success: false, error: `Room ${a.room_id} is not allocated to this schedule` });
          }
        }
        const totalCapacity = allocations.rows.reduce((sum, r) => sum + r.seat_capacity, 0);
        const seated = await query(
          'SELECT count(*)::int AS n FROM seat_assignments WHERE exam_schedule_id = $1', [schedule.id]);
        const alreadySeated = await query(
          'SELECT student_id FROM seat_assignments WHERE exam_schedule_id = $1 AND student_id = ANY($2::int[])',
          [schedule.id, studentIds]);
        const newSeats = studentIds.length - alreadySeated.rows.length;
        if (seated.rows[0].n + newSeats > totalCapacity) {
          return res.status(400).json({ success: false, error: `Seating would exceed the schedule's allocated capacity (${totalCapacity} seats)` });
        }
      }
      const saved = await withTransaction(async (client) => {
        const out = [];
        for (const a of assignments) {
          const { rows } = await client.query(
            `INSERT INTO seat_assignments (exam_schedule_id, student_id, room_id, seat_number, assigned_by)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (exam_schedule_id, student_id)
             DO UPDATE SET seat_number = EXCLUDED.seat_number, room_id = EXCLUDED.room_id,
                           assigned_by = EXCLUDED.assigned_by
             RETURNING *`,
            [schedule.id, a.student_id, a.room_id || null, String(a.seat_number).trim(), req.user.id]);
          out.push(rows[0]);
        }
        return out;
      });
      await logAudit({ userId: req.user.id, action: 'seating.assign', entityType: 'seat_assignments', entityId: schedule.id, newValues: { count: saved.length }, req });
      return res.status(201).json({ success: true, data: saved });
    } catch (err) { return next(err); }
  });

router.get('/schedules/:scheduleId/seating', param('scheduleId').isInt(), validate,
  async (req, res, next) => {
    try {
      const schedule = await getSchedule(req.params.scheduleId);
      if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSchedule(scope.lecturerId, req.params.scheduleId))) {
          return res.status(403).json({ success: false, error: 'Schedule is not for one of your assigned subjects' });
        }
      }
      const params = [req.params.scheduleId];
      let extra = '';
      if (req.user.role === 'student') {
        const sid = await studentIdForUser(req.user.id);
        params.push(sid || -1);
        extra = ` AND sa.student_id = $${params.length}`;
      }
      const { rows } = await query(
        `SELECT sa.*, s.student_id AS student_no, s.full_name AS student_name,
                er.name AS room_name
           FROM seat_assignments sa
           JOIN students s ON s.id = sa.student_id
           LEFT JOIN exam_rooms er ON er.id = sa.room_id
          WHERE sa.exam_schedule_id = $1${extra}
          ORDER BY sa.seat_number`,
        params);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

router.delete('/schedules/:scheduleId/seating/:studentId', MANAGE,
  param('scheduleId').isInt(), param('studentId').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'DELETE FROM seat_assignments WHERE exam_schedule_id = $1 AND student_id = $2 RETURNING id',
        [req.params.scheduleId, req.params.studentId]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Seat assignment not found' });
      return res.json({ success: true, message: 'Seat assignment removed' });
    } catch (err) { return next(err); }
  });

module.exports = router;
