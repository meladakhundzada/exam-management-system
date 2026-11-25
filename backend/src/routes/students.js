// Students — CRUD + profile + admit card + complaints.
// Roles: super_admin & exam_officer manage; lecturer reads; a student may
// only read their OWN record (enforced by studentIdMatchesSelf below).
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { ensureRoles, getRoleId } = require('../utils/roles');
const { studentGpa } = require('../utils/gpa');
const { personName, phone, admissionYear } = require('../utils/validation');
const { getLecturerScope, studentInLecturerScope } = require('../utils/lecturerScope');
const { getDepartmentIdForUser, getInvigilatorScheduleIds } = require('../utils/scopes');

const router = express.Router();
router.use(authenticate);

async function studentIdMatchesSelf(req, res, next) {
  if (req.user.role !== 'student') return next();
  const { rows } = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  if (!rows[0] || rows[0].id !== Number(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Students can only view their own record' });
  }
  return next();
}

const studentValidators = [
  body('student_id').trim().notEmpty().withMessage('student_id required'),
  body('full_name').trim().custom(personName),
  body('email').isEmail().withMessage('Enter a valid email address.'),
  body('phone').optional({ values: 'falsy' }).custom(phone),
  body('guardian_name').optional({ values: 'falsy' }).custom(personName),
  body('guardian_phone').optional({ values: 'falsy' }).custom(phone),
  body('department_id').isInt({ min: 1 }),
  body('admission_year').custom(admissionYear),
  body('current_semester').optional().isInt({ min: 1, max: 8 }),
  body('gender').optional().isIn(['male', 'female', 'other']),
];

// GET /api/students?page&limit&search&department_id&status
router.get('/', requireRole('super_admin', 'exam_officer', 'lecturer', 'department_head', 'invigilator'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search = '', department_id, status } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.student_id ILIKE $${params.length} OR s.email ILIKE $${params.length})`); }
    if (department_id) { params.push(department_id); where.push(`s.department_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
    // Lecturers see only students in their department or enrolled in one
    // of their assigned subjects. No linked lecturer row → empty list.
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope) return res.json(paginatedResponse([], 0, { page, limit }));
      params.push(scope.lecturerId);
      where.push(`(s.department_id = (SELECT department_id FROM lecturers WHERE id = $${params.length})
                   OR EXISTS (SELECT 1 FROM enrollments en WHERE en.student_id = s.id AND en.status = 'enrolled'
                              AND en.subject_id IN (SELECT id FROM subjects WHERE lecturer_id = $${params.length})))`);
    }
    // Department heads see only students of their own department (the
    // caller's department is forced, whatever ?department_id= says).
    // No linked department → empty list.
    if (req.user.role === 'department_head') {
      const deptId = await getDepartmentIdForUser(req.user.id);
      if (deptId == null) return res.json(paginatedResponse([], 0, { page, limit }));
      params.push(deptId);
      where.push(`s.department_id = $${params.length}`);
    }
    // Invigilators see only students enrolled in a subject scheduled in
    // one of their assigned sessions. No assignment → empty list, never
    // the whole student table.
    if (req.user.role === 'invigilator') {
      const scheduleIds = await getInvigilatorScheduleIds(req.user.id);
      if (!scheduleIds.length) return res.json(paginatedResponse([], 0, { page, limit }));
      params.push(scheduleIds);
      where.push(`EXISTS (SELECT 1 FROM enrollments en
                    JOIN exam_schedules es ON es.subject_id = en.subject_id
                   WHERE en.student_id = s.id AND en.status = 'enrolled'
                     AND es.id = ANY($${params.length}::int[]))`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM students s ${clause}`, params);
    const { rows } = await query(
      `SELECT s.*, d.name AS department_name, d.code AS department_code
         FROM students s JOIN departments d ON d.id = s.department_id ${clause}
        ORDER BY s.full_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/students/:id — full profile + GPA/CGPA (published results only).
router.get('/:id', requireRole('super_admin', 'exam_officer', 'lecturer', 'student', 'department_head'),
  param('id').isInt(), validate, studentIdMatchesSelf, async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT s.*, d.name AS department_name, f.name AS faculty_name
           FROM students s JOIN departments d ON d.id = s.department_id
           JOIN faculties f ON f.id = d.faculty_id WHERE s.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      // A lecturer may view a single student only when that student is in
      // scope (own department or enrolled in one of their subjects).
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await studentInLecturerScope(scope.lecturerId, rows[0].id))) {
          return res.status(403).json({ success: false, error: 'Student is not in your department or enrolled in your subjects' });
        }
      }
      // A department head may view a single student only when that
      // student is in their department. No linked department → 403.
      if (req.user.role === 'department_head') {
        const deptId = await getDepartmentIdForUser(req.user.id);
        if (deptId == null || rows[0].department_id !== deptId) {
          return res.status(403).json({ success: false, error: 'Student is not in your department' });
        }
      }
      const cgpa = await studentGpa({ query: (t, p) => query(t, p) }, rows[0].id).catch(() => null);
      return res.json({ success: true, data: { ...rows[0], cgpa } });
    } catch (err) { return next(err); }
  });

// POST /api/students — creates BOTH the login user (role=student) and the
// student row in one transaction. The caller supplies the student's
// password (minimum 8 characters) in the request body — there is no
// default password. Duplicate student_id/email → 409.
router.post('/', requireRole('super_admin', 'exam_officer'),
  [...studentValidators, body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const result = await withTransaction(async (client) => {
        const hash = await bcrypt.hash(b.password, 10);
        // Roles may be empty if the seed never ran — ensure them first,
        // otherwise the role subselect returns NULL and the insert fails
        // on users.role_id NOT NULL (same bug as setup-first-admin).
        await ensureRoles(client);
        const roleId = await getRoleId(client, 'student');
        const user = await client.query(
          `INSERT INTO users (role_id, full_name, email, password_hash, phone)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [roleId, b.full_name, b.email.toLowerCase(), hash, b.phone || null]);
        const student = await client.query(
          `INSERT INTO students (user_id, department_id, student_id, full_name, email, phone, gender,
              date_of_birth, address, guardian_name, guardian_phone, admission_year, current_semester)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [user.rows[0].id, b.department_id, b.student_id, b.full_name, b.email.toLowerCase(),
           b.phone || null, b.gender || null, b.date_of_birth || null, b.address || null,
           b.guardian_name || null, b.guardian_phone || null, b.admission_year, b.current_semester || 1]);
        return student.rows[0];
      });
      await logAudit({ userId: req.user.id, action: 'students.create', entityType: 'students', entityId: result.id, newValues: result, req });
      return res.status(201).json({ success: true, data: result, message: 'Student registered.' });
    } catch (err) { return next(err); }
  });

// PUT /api/students/:id — also syncs the login (users) email when the
// student's email changes, so the login and the academic record stay in
// step (the Users edit does the same in reverse). The whole change is
// one transaction: a duplicate login email rolls everything back.
router.put('/:id', requireRole('super_admin', 'exam_officer'),
  param('id').isInt(), studentValidators, validate, async (req, res, next) => {
    try {
      const b = req.body;
      const newEmail = b.email.toLowerCase();
      const student = await withTransaction(async (client) => {
        const current = await client.query(
          'SELECT user_id, email FROM students WHERE id = $1', [req.params.id]);
        if (!current.rows[0]) return null;
        const { rows } = await client.query(
          `UPDATE students SET department_id=$1, full_name=$2, email=$3, phone=$4, gender=$5,
           date_of_birth=$6, address=$7, guardian_name=$8, guardian_phone=$9,
           admission_year=$10, current_semester=$11, status=$12
         WHERE id=$13 RETURNING *`,
          [b.department_id, b.full_name, newEmail, b.phone || null, b.gender || null,
           b.date_of_birth || null, b.address || null, b.guardian_name || null, b.guardian_phone || null,
           b.admission_year, b.current_semester || 1, b.status || 'active', req.params.id]);
        if (rows[0].user_id && newEmail !== String(current.rows[0].email || '').toLowerCase()) {
          const dup = await client.query(
            'SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [newEmail, rows[0].user_id]);
          if (dup.rows[0]) {
            throw Object.assign(new Error('This email is already used by another user.'), { status: 400 });
          }
          await client.query('UPDATE users SET email = $1, updated_at = now() WHERE id = $2',
            [newEmail, rows[0].user_id]);
        }
        return rows[0];
      });
      if (!student) return res.status(404).json({ success: false, error: 'Student not found' });
      await logAudit({ userId: req.user.id, action: 'students.update', entityType: 'students', entityId: student.id, newValues: student, req });
      return res.json({ success: true, data: student });
    } catch (err) { return next(err); }
  });

// DELETE /api/students/:id — super_admin only; RESTRICTed if marks/results exist.
router.delete('/:id', requireRole('super_admin'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query('DELETE FROM students WHERE id = $1 RETURNING id, student_id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      await logAudit({ userId: req.user.id, action: 'students.delete', entityType: 'students', entityId: rows[0].id, req });
      return res.json({ success: true, message: `Student ${rows[0].student_id} deleted` });
    } catch (err) { return next(err); }
  });

// GET /api/students/:id/admit-card — timetable + room allocation for the
// student's enrolled subjects in a given exam (?exam_id=). Data only;
// the PDF itself is rendered by GET /api/reports/admit-card/:studentId.
router.get('/:id/admit-card', requireRole('super_admin', 'exam_officer', 'student'),
  param('id').isInt(), validate, studentIdMatchesSelf, async (req, res, next) => {
    try {
      const { exam_id } = req.query;
      if (!exam_id) return res.status(400).json({ success: false, error: 'exam_id query parameter is required' });
      const student = await query(
        `SELECT s.*, d.name AS department_name FROM students s
          JOIN departments d ON d.id = s.department_id WHERE s.id = $1`, [req.params.id]);
      if (!student.rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
      const { rows } = await query(
        `SELECT es.exam_date, es.start_time, es.end_time, sub.code AS subject_code, sub.title AS subject_title,
                er.name AS room_name, er.building, e.title AS exam_title
           FROM enrollments en
           JOIN exam_schedules es ON es.subject_id = en.subject_id AND es.exam_id = $2
           JOIN subjects sub ON sub.id = es.subject_id
           JOIN examinations e ON e.id = es.exam_id
           LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
           LEFT JOIN exam_rooms er ON er.id = ra.room_id
          WHERE en.student_id = $1 ORDER BY es.exam_date, es.start_time`,
        [req.params.id, exam_id]);
      return res.json({ success: true, data: { student: student.rows[0], exam_id: Number(exam_id), timetable: rows } });
    } catch (err) { return next(err); }
  });

// GET /api/students/:id/enrollments — the student's enrolled courses
// (subjects with lecturer, semester and academic year). A student sees
// only their own enrolments.
router.get('/:id/enrollments', requireRole('super_admin', 'exam_officer', 'student'),
  param('id').isInt(), validate, studentIdMatchesSelf, async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT en.id, en.status, en.enrolled_at, sub.id AS subject_id, sub.code AS subject_code,
                sub.title AS subject_title, sub.credit_hours, sem.name AS semester_name,
                ay.name AS academic_year, t.full_name AS lecturer_name
           FROM enrollments en
           JOIN subjects sub ON sub.id = en.subject_id
           JOIN semesters sem ON sem.id = en.semester_id
           JOIN academic_years ay ON ay.id = en.academic_year_id
           LEFT JOIN lecturers t ON t.id = sub.lecturer_id
          WHERE en.student_id = $1 ORDER BY sub.code`, [req.params.id]);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

// GET /api/students/:id/attendance — the student's own examination
// attendance records (exam, subject, date/time, room, status).
// A student sees only their own records.
router.get('/:id/attendance', requireRole('super_admin', 'exam_officer', 'student'),
  param('id').isInt(), validate, studentIdMatchesSelf, async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT a.id, a.status, a.marked_at, es.exam_date, es.start_time, es.end_time,
                sub.code AS subject_code, sub.title AS subject_title, e.title AS exam_title,
                e.exam_type, er.name AS room_name
           FROM attendance a
           JOIN exam_schedules es ON es.id = a.exam_schedule_id
           JOIN examinations e ON e.id = es.exam_id
           JOIN subjects sub ON sub.id = es.subject_id
           LEFT JOIN exam_rooms er ON er.id = a.room_id
          WHERE a.student_id = $1 ORDER BY es.exam_date DESC, es.start_time`, [req.params.id]);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

// POST /api/students/:id/complaints — student files a rechecking complaint.
router.post('/:id/complaints', requireRole('super_admin', 'exam_officer', 'student'),
  [param('id').isInt(), body('type').isIn(['rechecking', 'marks_correction', 'absent_marked', 'other']),
   body('description').trim().notEmpty()], validate, studentIdMatchesSelf, async (req, res, next) => {
    try {
      const { rows } = await query(
        `INSERT INTO complaints (student_id, exam_id, subject_id, result_id, type, description)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, req.body.exam_id || null, req.body.subject_id || null,
         req.body.result_id || null, req.body.type, req.body.description]);
      await logAudit({ userId: req.user.id, action: 'complaints.create', entityType: 'complaints', entityId: rows[0].id, req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// GET /api/students/:id/complaints
router.get('/:id/complaints', requireRole('super_admin', 'exam_officer', 'student'),
  param('id').isInt(), validate, studentIdMatchesSelf, async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT c.*, sub.code AS subject_code, e.title AS exam_title FROM complaints c
          LEFT JOIN subjects sub ON sub.id = c.subject_id LEFT JOIN examinations e ON e.id = c.exam_id
         WHERE c.student_id = $1 ORDER BY c.created_at DESC`, [req.params.id]);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

module.exports = router;
