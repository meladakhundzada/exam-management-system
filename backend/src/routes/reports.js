// Reports, statistics, notifications, audit logs & exports (PDF / Excel).
// Exports stream real data from the DB — no placeholder rows.
const express = require('express');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { param } = require('express-validator');
const { studentGpa } = require('../utils/gpa');

const router = express.Router();
router.use(authenticate);
const STAFF = requireRole('super_admin', 'exam_officer');

// GET /api/reports/dashboard — counts + charts data for the dashboard.
router.get('/dashboard', async (req, res, next) => {
  try {
    const counts = await query(
      `SELECT (SELECT count(*)::int FROM students WHERE status='active') AS total_students,
              (SELECT count(*)::int FROM lecturers WHERE is_active) AS total_lecturers,
              (SELECT count(*)::int FROM departments) AS total_departments,
              (SELECT count(*)::int FROM subjects WHERE is_active) AS total_subjects,
              (SELECT count(*)::int FROM examinations WHERE status IN ('scheduled','ongoing')) AS upcoming_exams,
              (SELECT count(*)::int FROM examinations WHERE status='completed') AS completed_exams,
              (SELECT count(*)::int FROM results WHERE is_published) AS published_results,
              (SELECT count(*)::int FROM marks WHERE status='submitted') AS pending_marks,
              (SELECT count(*)::int FROM complaints WHERE status='pending') AS pending_complaints`);
    const byDept = await query(
      `SELECT d.name AS department, count(s.id)::int AS students FROM departments d
        LEFT JOIN students s ON s.department_id = d.id GROUP BY d.name ORDER BY students DESC`);
    const gradeDist = await query(
      `SELECT grade, count(*)::int AS count FROM results WHERE is_published GROUP BY grade ORDER BY grade`);
    // Privacy rule (same as GET /api/dashboard/activity): Super Admin sees
    // everyone's recent activity; every other role sees only their own
    // entries, so one user's logins/actions never leak to another role.
    const recentParams = [];
    let recentClause = '';
    if (req.user.role !== 'super_admin') {
      recentParams.push(req.user.id);
      recentClause = 'WHERE a.user_id = $1';
    }
    const recent = await query(
      `SELECT a.action, a.entity_type, a.created_at, u.full_name AS user_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${recentClause} ORDER BY a.created_at DESC LIMIT 10`,
      recentParams);
    return res.json({ success: true, data: { ...counts.rows[0], students_by_department: byDept.rows, grade_distribution: gradeDist.rows, recent_activities: recent.rows } });
  } catch (err) { return next(err); }
});

// GET /api/reports/students/export?format=xlsx|pdf&department_id=
router.get('/students/export', STAFF, async (req, res, next) => {
  try {
    const { format = 'xlsx', department_id } = req.query;
    const params = [];
    let clause = '';
    if (department_id) { params.push(department_id); clause = 'WHERE s.department_id = $1'; }
    const { rows } = await query(
      `SELECT s.student_id, s.full_name, s.email, s.phone, s.gender, s.admission_year,
              s.current_semester, s.status, d.name AS department
         FROM students s JOIN departments d ON d.id = s.department_id ${clause} ORDER BY s.full_name`, params);
    if (format === 'pdf') return sendPdf(res, 'Student List', ['ID', 'Name', 'Email', 'Department', 'Semester', 'Status'],
      rows.map((r) => [r.student_id, r.full_name, r.email, r.department, String(r.current_semester), r.status]));
    return sendXlsx(res, 'students.xlsx', 'Students',
      ['Student ID', 'Full Name', 'Email', 'Phone', 'Gender', 'Admission Year', 'Semester', 'Department', 'Status'],
      rows.map((r) => [r.student_id, r.full_name, r.email, r.phone, r.gender, r.admission_year, r.current_semester, r.department, r.status]));
  } catch (err) { return next(err); }
});

// GET /api/reports/exams/:examId/schedule/export?format=xlsx|pdf
router.get('/exams/:examId/schedule/export', STAFF, param('examId').isInt(), validate, async (req, res, next) => {
  try {
    const { format = 'xlsx' } = req.query;
    const { rows } = await query(
      `SELECT es.exam_date, es.start_time, es.end_time, sub.code, sub.title, er.name AS room
         FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
        WHERE es.exam_id = $1 ORDER BY es.exam_date, es.start_time`, [req.params.examId]);
    if (format === 'pdf') return sendPdf(res, 'Examination Schedule', ['Date', 'Time', 'Subject', 'Title', 'Room'],
      rows.map((r) => [String(r.exam_date).slice(0, 10), `${r.start_time}–${r.end_time}`, r.code, r.title, r.room || '—']));
    return sendXlsx(res, 'schedule.xlsx', 'Schedule', ['Date', 'Start', 'End', 'Subject Code', 'Subject', 'Room'],
      rows.map((r) => [r.exam_date, r.start_time, r.end_time, r.code, r.title, r.room]));
  } catch (err) { return next(err); }
});

// GET /api/reports/results/:examId/export?format=xlsx|pdf — published only.
router.get('/results/:examId/export', STAFF, param('examId').isInt(), validate, async (req, res, next) => {
  try {
    const { format = 'xlsx', department_id } = req.query;
    const params = [req.params.examId];
    let extra = '';
    if (department_id) { params.push(department_id); extra = ' AND s.department_id = $2'; }
    const { rows } = await query(
      `SELECT s.student_id, s.full_name, sub.code, sub.title, r.obtained_marks, r.grade, r.grade_point, r.gpa
         FROM results r JOIN students s ON s.id = r.student_id JOIN subjects sub ON sub.id = r.subject_id
        WHERE r.exam_id = $1 AND r.is_published ${extra} ORDER BY s.full_name, sub.code`, params);
    if (format === 'pdf') return sendPdf(res, 'Published Results', ['Student ID', 'Name', 'Subject', 'Marks', 'Grade', 'GPA'],
      rows.map((r) => [r.student_id, r.full_name, `${r.code} ${r.title}`, String(r.obtained_marks), r.grade, String(r.gpa ?? '')]));
    return sendXlsx(res, 'results.xlsx', 'Results', ['Student ID', 'Name', 'Subject Code', 'Subject', 'Marks', 'Grade', 'Grade Point', 'GPA'],
      rows.map((r) => [r.student_id, r.full_name, r.code, r.title, r.obtained_marks, r.grade, r.grade_point, r.gpa]));
  } catch (err) { return next(err); }
});

// GET /api/reports/admit-card/:studentId?exam_id= — PDF admit card.
router.get('/admit-card/:studentId', param('studentId').isInt(), validate, async (req, res, next) => {
  try {
    const { exam_id } = req.query;
    if (!exam_id) return res.status(400).json({ success: false, error: 'exam_id query parameter is required' });
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      if (!s.rows[0] || s.rows[0].id !== Number(req.params.studentId)) {
        return res.status(403).json({ success: false, error: 'Students can only download their own admit card' });
      }
    }
    const student = await query(
      `SELECT s.*, d.name AS department_name FROM students s JOIN departments d ON d.id = s.department_id WHERE s.id = $1`,
      [req.params.studentId]);
    if (!student.rows[0]) return res.status(404).json({ success: false, error: 'Student not found' });
    const { rows } = await query(
      `SELECT es.exam_date, es.start_time, es.end_time, sub.code, sub.title, er.name AS room, e.title AS exam_title
         FROM enrollments en JOIN exam_schedules es ON es.subject_id = en.subject_id AND es.exam_id = $2
         JOIN subjects sub ON sub.id = es.subject_id JOIN examinations e ON e.id = es.exam_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
        WHERE en.student_id = $1 ORDER BY es.exam_date, es.start_time`, [req.params.studentId, exam_id]);
    const st = student.rows[0];
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="admit-card-${st.student_id}.pdf"`);
    doc.pipe(res);
    doc.fontSize(18).text('University Examination Department', { align: 'center' });
    doc.fontSize(14).text('Examination Admit Card', { align: 'center' }).moveDown();
    doc.fontSize(12).text(`Student: ${st.full_name} (${st.student_id})`);
    doc.text(`Department: ${st.department_name}`);
    doc.text(`Exam: ${rows[0]?.exam_title || `Exam #${exam_id}`}`).moveDown();
    rows.forEach((r) => doc.text(`${String(r.exam_date).slice(0, 10)}  ${r.start_time}–${r.end_time}  ${r.code} — ${r.title}  [${r.room || 'Room TBA'}]`));
    if (!rows.length) doc.text('No scheduled subjects found for this exam.');
    doc.moveDown().fontSize(10).text('Bring this card and a valid ID to every examination. Arrive 30 minutes early.');
    doc.end();
  } catch (err) { return next(err); }
});

// GET /api/reports/student/:studentId/result-pdf — individual result sheet (published only).
router.get('/student/:studentId/result-pdf', param('studentId').isInt(), validate, async (req, res, next) => {
  try {
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      if (!s.rows[0] || s.rows[0].id !== Number(req.params.studentId)) return res.status(403).json({ success: false, error: 'Students can only download their own results' });
    }
    const { rows } = await query(
      `SELECT r.*, sub.code, sub.title, sub.credit_hours, e.title AS exam_title, s.full_name, s.student_id
         FROM results r JOIN subjects sub ON sub.id = r.subject_id JOIN examinations e ON e.id = r.exam_id
         JOIN students s ON s.id = r.student_id
        WHERE r.student_id = $1 AND r.is_published ORDER BY e.start_date, sub.code`, [req.params.studentId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No published results found' });
    const cgpa = await studentGpa({ query: (t, p) => query(t, p) }, Number(req.params.studentId));
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="result-${rows[0].student_id}.pdf"`);
    doc.pipe(res);
    doc.fontSize(18).text('University Examination Department', { align: 'center' });
    doc.fontSize(14).text('Official Result Sheet', { align: 'center' }).moveDown();
    doc.fontSize(12).text(`Student: ${rows[0].full_name} (${rows[0].student_id})`);
    doc.text(`CGPA: ${cgpa ?? '—'}`).moveDown();
    rows.forEach((r) => doc.text(`${r.code} — ${r.title}: ${r.obtained_marks}  Grade ${r.grade} (${r.grade_point})`));
    doc.end();
  } catch (err) { return next(err); }
});

// ---- Notifications ---------------------------------------------------------
router.get('/notifications', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT n.* FROM notifications n WHERE n.user_id = $1 OR n.role_id = (SELECT role_id FROM users WHERE id = $1) OR (n.user_id IS NULL AND n.role_id IS NULL)
        ORDER BY n.created_at DESC LIMIT 50`, [req.user.id]);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

router.post('/notifications', STAFF, async (req, res, next) => {
  try {
    const { title, message, type = 'announcement', role_id, user_id } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, error: 'title and message are required' });
    const { rows } = await query(
      `INSERT INTO notifications (user_id, role_id, title, message, type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id || null, role_id || null, title, message, type, req.user.id]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { return next(err); }
});

// ---- Audit logs (super_admin only) -----------------------------------------
router.get('/audit-logs', requireRole('super_admin'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const total = await query('SELECT count(*)::int AS n FROM audit_logs');
    const { rows } = await query(
      `SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [Number(limit), offset]);
    return res.json({ success: true, data: rows, pagination: { page: Number(page), limit: Number(limit), total: total.rows[0].n } });
  } catch (err) { return next(err); }
});

// ---- Export helpers ---------------------------------------------------------
function sendPdf(res, title, headers, rows) {
  const doc = new PDFDocument({ margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${title.toLowerCase().replace(/\s+/g, '-')}.pdf"`);
  doc.pipe(res);
  doc.fontSize(16).text(title, { align: 'center' }).moveDown();
  doc.fontSize(10).text(headers.join(' | ')).moveDown(0.5);
  rows.forEach((r) => doc.text(r.map(String).join(' | ')));
  doc.end();
}

async function sendXlsx(res, filename, sheetName, headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c) => { c.width = 22; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = router;
