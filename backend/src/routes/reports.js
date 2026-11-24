// Reports, statistics, notifications, audit logs & exports (PDF / Excel).
// Exports stream real data from the DB — no placeholder rows.
const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
// QR codes on admit cards: the `qrcode` package renders the verification
// payload to a PNG buffer, embedded in the PDF with pdfkit. No external
// API is used — everything is generated locally. If the package is ever
// missing, the require fails soft and admit cards are issued without a
// QR code (reference text only) instead of crashing the route.
let QRCode = null;
try {
  QRCode = require('qrcode');
} catch {
  console.warn('[reports] qrcode package not available — admit cards will be issued without a QR code');
}
const { query } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { param } = require('express-validator');
const { studentGpa, calculateGpa } = require('../utils/gpa');
const { getLecturerScope, studentInLecturerScope } = require('../utils/lecturerScope');
const { getDepartmentIdForUser } = require('../utils/scopes');

const router = express.Router();
router.use(authenticate);
const STAFF = requireRole('super_admin', 'exam_officer');
// Finance is deliberately NOT in STAFF: the student-list, exam-schedule
// and published-results exports below are academic records, not financial
// ones, and Finance must not receive them. Finance gets exactly one
// export — GET /api/reports/financial/export — guarded by FINANCE_EXPORTS.
const FINANCE_EXPORTS = requireRole('super_admin', 'exam_officer', 'finance');

// ---- Admit-card verification ------------------------------------------------
// The QR code on an admit card encodes a verification payload, so an
// invigilator can check the card against the system without trusting the
// paper alone. The reference is deterministic (student code + exam id +
// a short checksum) so the same card always carries the same reference.
function buildAdmitCardRef(studentCode, examId) {
  const checksum = crypto.createHash('sha256')
    .update(`${studentCode}:${examId}:admit-card`)
    .digest('hex').slice(0, 8).toUpperCase();
  return `ADM-${studentCode}-${examId}-${checksum}`;
}

function buildAdmitCardPayload({ ref, studentCode, studentName, examId }) {
  return JSON.stringify({
    type: 'admit-card',
    ref,
    student_id: studentCode,
    student_name: studentName,
    exam_id: Number(examId),
  });
}

// GET /api/reports/dashboard — counts + charts data for the dashboard.
// Lecturers get the same shape but scoped to their own courses: students
// in their department / enrolled in their subjects, their subjects and
// exams, and results/marks/complaints for their subjects only. Every
// other role keeps the existing global counts.
router.get('/dashboard', async (req, res, next) => {
  try {
    let counts; let byDept; let gradeDist;
    // Privacy rule: a student must NEVER see system-wide totals, so for
    // students this endpoint returns ONLY personal numbers (own subjects,
    // own exams, own published results, own CGPA, own outstanding fees).
    // Students cannot open the Reports page in the UI, but the endpoint
    // itself must not leak global counts to them either.
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      const sid = s.rows[0]?.id ?? -1;
      const myCgpa = await studentGpa({ query: (t, p) => query(t, p) }, sid);
      counts = await query(
        `SELECT (SELECT count(*)::int FROM enrollments
                  WHERE student_id = $1 AND status = 'enrolled') AS my_subjects,
                (SELECT count(*)::int FROM examinations e
                  WHERE e.status IN ('scheduled', 'ongoing')
                    AND EXISTS (SELECT 1 FROM exam_schedules es
                                 JOIN enrollments en ON en.subject_id = es.subject_id
                                WHERE es.exam_id = e.id AND en.student_id = $1
                                  AND en.status = 'enrolled')) AS my_upcoming_exams,
                (SELECT count(*)::int FROM results
                  WHERE student_id = $1 AND is_published) AS my_published_results,
                (SELECT COALESCE(SUM(amount_due - amount_paid), 0)::float FROM student_fees
                  WHERE student_id = $1 AND status IN ('unpaid', 'partial', 'overdue')) AS my_fees_due`,
        [sid]);
      byDept = await query('SELECT 1 WHERE FALSE');
      gradeDist = await query(
        `SELECT grade, count(*)::int AS count FROM results
          WHERE student_id = $1 AND is_published GROUP BY grade ORDER BY grade`, [sid]);
      const recentParams = [req.user.id];
      const recent = await query(
        `SELECT a.action, a.entity_type, a.created_at, u.full_name AS user_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 10`,
        recentParams);
      return res.json({
        success: true,
        data: { ...counts.rows[0], my_cgpa: myCgpa, students_by_department: byDept.rows, grade_distribution: gradeDist.rows, recent_activities: recent.rows },
      });
    }
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      const p = [scope?.lecturerId ?? -1];
      const ownSubjects = 'subject_id IN (SELECT id FROM subjects WHERE lecturer_id = $1)';
      const ownExam = `EXISTS (SELECT 1 FROM exam_schedules es WHERE es.exam_id = e.id AND es.${ownSubjects})`;
      counts = await query(
        `SELECT (SELECT count(*)::int FROM students s WHERE s.status='active' AND (
                    s.department_id = (SELECT department_id FROM lecturers WHERE id = $1)
                    OR EXISTS (SELECT 1 FROM enrollments en WHERE en.student_id = s.id AND en.status = 'enrolled'
                               AND en.subject_id IN (SELECT id FROM subjects WHERE lecturer_id = $1)))) AS total_students,
                1 AS total_lecturers,
                (SELECT count(DISTINCT department_id)::int FROM subjects WHERE lecturer_id = $1) AS total_departments,
                (SELECT count(*)::int FROM subjects WHERE is_active AND lecturer_id = $1) AS total_subjects,
                (SELECT count(*)::int FROM examinations e WHERE e.status IN ('scheduled','ongoing') AND ${ownExam}) AS upcoming_exams,
                (SELECT count(*)::int FROM examinations e WHERE e.status='completed' AND ${ownExam}) AS completed_exams,
                (SELECT count(*)::int FROM results WHERE is_published AND ${ownSubjects}) AS published_results,
                (SELECT count(*)::int FROM marks WHERE status='submitted' AND ${ownSubjects}) AS pending_marks,
                (SELECT count(*)::int FROM complaints WHERE status='pending' AND ${ownSubjects}) AS pending_complaints`,
        p);
      byDept = await query(
        `SELECT d.name AS department, count(s.id)::int AS students FROM departments d
          LEFT JOIN students s ON s.department_id = d.id
         WHERE d.id IN (SELECT department_id FROM subjects WHERE lecturer_id = $1)
         GROUP BY d.name ORDER BY students DESC`, p);
      gradeDist = await query(
        `SELECT grade, count(*)::int AS count FROM results WHERE is_published AND ${ownSubjects} GROUP BY grade ORDER BY grade`, p);
    } else if (req.user.role === 'department_head') {
      // Department head: the same shape, scoped to their department
      // only. No linked department (deptId -1) matches nothing, so the
      // counts come back 0 instead of system-wide.
      const deptId = await getDepartmentIdForUser(req.user.id);
      const p = [deptId ?? -1];
      const ownSubjects = 'subject_id IN (SELECT id FROM subjects WHERE department_id = $1)';
      const ownExam = `EXISTS (SELECT 1 FROM exam_schedules es WHERE es.exam_id = e.id AND es.${ownSubjects})`;
      counts = await query(
        `SELECT (SELECT count(*)::int FROM students WHERE status='active' AND department_id = $1) AS total_students,
                (SELECT count(*)::int FROM lecturers WHERE is_active AND department_id = $1) AS total_lecturers,
                1 AS total_departments,
                (SELECT count(*)::int FROM subjects WHERE is_active AND department_id = $1) AS total_subjects,
                (SELECT count(*)::int FROM examinations e WHERE e.status IN ('scheduled','ongoing') AND ${ownExam}) AS upcoming_exams,
                (SELECT count(*)::int FROM examinations e WHERE e.status='completed' AND ${ownExam}) AS completed_exams,
                (SELECT count(*)::int FROM results WHERE is_published AND ${ownSubjects}) AS published_results,
                (SELECT count(*)::int FROM marks WHERE status='submitted' AND ${ownSubjects}) AS pending_marks,
                (SELECT count(*)::int FROM complaints WHERE status='pending' AND ${ownSubjects}) AS pending_complaints`,
        p);
      byDept = await query(
        `SELECT d.name AS department, count(s.id)::int AS students FROM departments d
          LEFT JOIN students s ON s.department_id = d.id
         WHERE d.id = $1
         GROUP BY d.name ORDER BY students DESC`, p);
      gradeDist = await query(
        `SELECT grade, count(*)::int AS count FROM results WHERE is_published AND ${ownSubjects} GROUP BY grade ORDER BY grade`, p);
    } else {
      counts = await query(
        `SELECT (SELECT count(*)::int FROM students WHERE status='active') AS total_students,
                (SELECT count(*)::int FROM lecturers WHERE is_active) AS total_lecturers,
                (SELECT count(*)::int FROM departments) AS total_departments,
                (SELECT count(*)::int FROM subjects WHERE is_active) AS total_subjects,
                (SELECT count(*)::int FROM examinations WHERE status IN ('scheduled','ongoing')) AS upcoming_exams,
                (SELECT count(*)::int FROM examinations WHERE status='completed') AS completed_exams,
                (SELECT count(*)::int FROM results WHERE is_published) AS published_results,
                (SELECT count(*)::int FROM marks WHERE status='submitted') AS pending_marks,
                (SELECT count(*)::int FROM complaints WHERE status='pending') AS pending_complaints`);
      byDept = await query(
        `SELECT d.name AS department, count(s.id)::int AS students FROM departments d
          LEFT JOIN students s ON s.department_id = d.id GROUP BY d.name ORDER BY students DESC`);
      gradeDist = await query(
        `SELECT grade, count(*)::int AS count FROM results WHERE is_published GROUP BY grade ORDER BY grade`);
    }
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
    if (format === 'pdf') return sendPdf(res, {
      title: 'Student List', subtitle: 'Registered students',
      filename: 'student-list.pdf',
      headers: ['ID', 'Name', 'Email', 'Department', 'Semester', 'Status'],
      rows: rows.map((r) => [r.student_id, r.full_name, r.email, r.department, String(r.current_semester), r.status]),
    });
    return sendXlsx(res, 'students.xlsx', 'Students',
      ['Student ID', 'Full Name', 'Email', 'Phone', 'Gender', 'Admission Year', 'Semester', 'Department', 'Status'],
      rows.map((r) => [r.student_id, r.full_name, r.email, r.phone, r.gender, r.admission_year, r.current_semester, r.department, r.status]));
  } catch (err) { return next(err); }
});

// GET /api/reports/exams/:examId/schedule/export?format=xlsx|pdf
// Lecturers may export it too, but only the rows for their own subjects.
// The Exam Controller exports the whole schedule; a Department Head
// exports only rows for subjects in their department.
router.get('/exams/:examId/schedule/export', requireRole('super_admin', 'exam_officer', 'lecturer', 'exam_controller', 'department_head'), param('examId').isInt(), validate, async (req, res, next) => {
  try {
    const { format = 'xlsx' } = req.query;
    const params = [req.params.examId];
    let extra = '';
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      params.push(scope?.lecturerId ?? -1);
      extra = ` AND sub.id IN (SELECT id FROM subjects WHERE lecturer_id = $${params.length})`;
    }
    if (req.user.role === 'department_head') {
      const deptId = await getDepartmentIdForUser(req.user.id);
      params.push(deptId ?? -1);
      extra += ` AND sub.department_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT es.exam_date, es.start_time, es.end_time, sub.code, sub.title, er.name AS room
         FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
        WHERE es.exam_id = $1${extra} ORDER BY es.exam_date, es.start_time`, params);
    if (format === 'pdf') return sendPdf(res, {
      title: 'Examination Schedule', subtitle: `Examination #${req.params.examId}`,
      filename: 'examination-schedule.pdf',
      headers: ['Date', 'Time', 'Subject', 'Title', 'Room'],
      rows: rows.map((r) => [String(r.exam_date).slice(0, 10), `${r.start_time}–${r.end_time}`, r.code, r.title, r.room || '—']),
    });
    return sendXlsx(res, 'schedule.xlsx', 'Schedule', ['Date', 'Start', 'End', 'Subject Code', 'Subject', 'Room'],
      rows.map((r) => [r.exam_date, r.start_time, r.end_time, r.code, r.title, r.room]));
  } catch (err) { return next(err); }
});

// GET /api/reports/results/:examId/export?format=xlsx|pdf — published only.
// Lecturers may export it too, but only results for their own subjects.
// The Exam Controller exports all published results; a Department Head
// exports only results for students in their department.
router.get('/results/:examId/export', requireRole('super_admin', 'exam_officer', 'lecturer', 'exam_controller', 'department_head'), param('examId').isInt(), validate, async (req, res, next) => {
  try {
    const { format = 'xlsx', department_id } = req.query;
    const params = [req.params.examId];
    let extra = '';
    if (req.user.role === 'department_head') {
      // The caller's department is forced; a ?department_id= for
      // another department must not widen the export.
      const deptId = await getDepartmentIdForUser(req.user.id);
      params.push(deptId ?? -1);
      extra = ` AND s.department_id = $${params.length}`;
    } else if (department_id) { params.push(department_id); extra = ' AND s.department_id = $2'; }
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      params.push(scope?.lecturerId ?? -1);
      extra += ` AND r.subject_id IN (SELECT id FROM subjects WHERE lecturer_id = $${params.length})`;
    }
    if (req.user.role === 'department_head') {
      // Results are already restricted to the head's department above
      // (students); also restrict to subjects of that department so a
      // cross-department enrolment cannot leak another department's
      // subject results into the export. The department id is the last
      // parameter pushed above ($2 when no ?department_id= was given).
      extra += ` AND r.subject_id IN (SELECT id FROM subjects WHERE department_id = $${params.length})`;
    }
    const { rows } = await query(
      `SELECT s.student_id, s.full_name, sub.code, sub.title, r.obtained_marks, r.grade, r.grade_point, r.gpa
         FROM results r JOIN students s ON s.id = r.student_id JOIN subjects sub ON sub.id = r.subject_id
        WHERE r.exam_id = $1 AND r.is_published ${extra} ORDER BY s.full_name, sub.code`, params);
    if (format === 'pdf') return sendPdf(res, {
      title: 'Published Results', subtitle: `Examination #${req.params.examId} — published results only`,
      filename: 'published-results.pdf',
      headers: ['Student ID', 'Name', 'Subject', 'Marks', 'Grade', 'GPA'],
      rows: rows.map((r) => [r.student_id, r.full_name, `${r.code} ${r.title}`, String(r.obtained_marks), r.grade, String(r.gpa ?? '')]),
    });
    return sendXlsx(res, 'results.xlsx', 'Results', ['Student ID', 'Name', 'Subject Code', 'Subject', 'Marks', 'Grade', 'Grade Point', 'GPA'],
      rows.map((r) => [r.student_id, r.full_name, r.code, r.title, r.obtained_marks, r.grade, r.grade_point, r.gpa]));
  } catch (err) { return next(err); }
});

// GET /api/reports/financial/export?format=xlsx|pdf&department_id=&date_from=&date_to=
// The ONE export Finance is entitled to: fee totals, breakdown by fee
// type, and recent payments. Guarded by FINANCE_EXPORTS (super_admin,
// exam_officer, finance) — lecturers and students get 403 here, and
// Finance still gets 403 on the academic exports above. PDF uses the
// professional layout; XLSX lists the payment history.
router.get('/financial/export', FINANCE_EXPORTS, async (req, res, next) => {
  try {
    const { format = 'xlsx', department_id, date_from, date_to } = req.query;
    const where = []; const params = [];
    if (department_id) { params.push(department_id); where.push(`s.department_id = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`fp.payment_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`fp.payment_date <= $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totals = await query(
      `SELECT COALESCE(SUM(sf.amount_due),0)::float AS total_due,
              COALESCE(SUM(sf.amount_paid),0)::float AS total_collected,
              COALESCE(SUM(sf.amount_due - sf.amount_paid),0)::float AS outstanding,
              COUNT(*)::int AS fee_count,
              COUNT(*) FILTER (WHERE sf.status = 'paid')::int AS paid_count,
              COUNT(*) FILTER (WHERE sf.status IN ('unpaid','partial'))::int AS unpaid_count
         FROM student_fees sf JOIN students s ON s.id = sf.student_id
        ${department_id ? 'WHERE s.department_id = $1' : ''}`,
      department_id ? [department_id] : []);
    const byType = await query(
      `SELECT ft.name AS fee_type, COALESCE(SUM(sf.amount_due),0)::float AS total_due,
              COALESCE(SUM(sf.amount_paid),0)::float AS total_collected,
              COALESCE(SUM(sf.amount_due - sf.amount_paid),0)::float AS outstanding,
              COUNT(*)::int AS fee_count
         FROM student_fees sf JOIN fee_types ft ON ft.id = sf.fee_type_id
         JOIN students s ON s.id = sf.student_id
        ${department_id ? 'WHERE s.department_id = $1' : ''}
        GROUP BY ft.name ORDER BY total_due DESC`,
      department_id ? [department_id] : []);
    const { rows: payments } = await query(
      `SELECT fp.receipt_no, fp.payment_date, s.student_id AS student_no, s.full_name AS student_name,
              ft.name AS fee_type_name, fp.payment_method, fp.amount::float, u.full_name AS received_by_name
         FROM fee_payments fp
         JOIN student_fees sf ON sf.id = fp.student_fee_id
         JOIN students s ON s.id = sf.student_id
         JOIN fee_types ft ON ft.id = sf.fee_type_id
         LEFT JOIN users u ON u.id = fp.received_by ${clause}
        ORDER BY fp.payment_date DESC, fp.id DESC LIMIT 200`,
      params);
    if (format === 'pdf') {
      const t = totals.rows[0];
      const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="financial-report.pdf"');
      doc.pipe(res);
      drawReportHeader(doc, 'Financial Report', 'Fees, collections and outstanding balances (AFN)');
      drawKeyValues(doc, [
        ['Total fees due', `${fmtAfn(t.total_due)} AFN`],
        ['Total collected', `${fmtAfn(t.total_collected)} AFN`],
        ['Outstanding balance', `${fmtAfn(t.outstanding)} AFN`],
        ['Fee records', `${t.fee_count} (${t.paid_count} paid, ${t.unpaid_count} unpaid / partial)`],
      ]);
      doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text('By fee type');
      renderPdfTable(doc, ['Fee type', 'Due (AFN)', 'Collected (AFN)', 'Outstanding (AFN)', 'Records'],
        byType.rows.map((r) => [r.fee_type, fmtAfn(r.total_due), fmtAfn(r.total_collected), fmtAfn(r.outstanding), String(r.fee_count)]));
      doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').fillColor('#0f172a')
        .text(`Recent payments${payments.length === 200 ? ' (latest 200)' : ''}`);
      renderPdfTable(doc, ['Receipt', 'Date', 'Student', 'Fee type', 'Method', 'Amount (AFN)'],
        payments.map((r) => [r.receipt_no, String(r.payment_date).slice(0, 10), `${r.student_name} (${r.student_no})`, r.fee_type_name, r.payment_method, fmtAfn(r.amount)]));
      finishPdf(doc);
      return;
    }
    return sendXlsx(res, 'financial-report.xlsx', 'Payments',
      ['Receipt', 'Date', 'Student ID', 'Student', 'Fee Type', 'Method', 'Amount (AFN)', 'Received by'],
      payments.map((r) => [r.receipt_no, r.payment_date, r.student_no, r.student_name, r.fee_type_name, r.payment_method, Number(r.amount), r.received_by_name || '']));
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
    // A lecturer may download an admit card only for a student enrolled in
    // one of their subjects in this exam — otherwise the card would expose
    // another lecturer's timetable to them.
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      const allowed = scope && await query(
        `SELECT 1 FROM enrollments en JOIN exam_schedules es ON es.subject_id = en.subject_id AND es.exam_id = $3
          WHERE en.student_id = $1 AND en.status = 'enrolled'
          AND en.subject_id IN (SELECT id FROM subjects WHERE lecturer_id = $2) LIMIT 1`,
        [req.params.studentId, scope.lecturerId, exam_id]);
      if (!allowed?.rows.length) {
        return res.status(403).json({ success: false, error: 'Admit card is not for one of your assigned subjects' });
      }
    }
    const { rows } = await query(
      `SELECT es.exam_date, es.start_time, es.end_time, sub.code, sub.title, er.name AS room, e.title AS exam_title
         FROM enrollments en JOIN exam_schedules es ON es.subject_id = en.subject_id AND es.exam_id = $2
         JOIN subjects sub ON sub.id = es.subject_id JOIN examinations e ON e.id = es.exam_id
         LEFT JOIN room_allocations ra ON ra.exam_schedule_id = es.id
         LEFT JOIN exam_rooms er ON er.id = ra.room_id
        WHERE en.student_id = $1 ORDER BY es.exam_date, es.start_time`, [req.params.studentId, exam_id]);
    const st = student.rows[0];
    const ref = buildAdmitCardRef(st.student_id, exam_id);
    const qrPayload = buildAdmitCardPayload({
      ref, studentCode: st.student_id, studentName: st.full_name, examId: Number(exam_id),
    });
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="admit-card-${st.student_id}.pdf"`);
    doc.pipe(res);
    drawReportHeader(doc, 'Examination Admit Card', rows[0]?.exam_title || `Examination #${exam_id}`);
    // Student details on the left, QR code on the right.
    const detailsTop = doc.y;
    const qrSize = 110;
    const qrX = doc.page.width - doc.page.margins.right - qrSize;
    drawKeyValues(doc, [
      ['Student', `${st.full_name} (${st.student_id})`],
      ['Department', st.department_name],
      ['Semester', String(st.current_semester)],
      ['Examination', rows[0]?.exam_title || `Examination #${exam_id}`],
      ['Reference', ref],
    ], doc.page.width - doc.page.margins.left - doc.page.margins.right - qrSize - 20);
    if (QRCode) {
      try {
        const qrBuf = await QRCode.toBuffer(qrPayload, { errorCorrectionLevel: 'M', margin: 1, width: 480 });
        doc.image(qrBuf, qrX, detailsTop, { width: qrSize });
        doc.fontSize(8).fillColor('#475569')
          .text('Scan to verify this card', qrX, detailsTop + qrSize + 4, { width: qrSize, align: 'center' });
        doc.y = Math.max(doc.y, detailsTop + qrSize + 20);
      } catch (err) {
        console.warn('[reports] QR code generation failed, issuing card without one:', err.message);
      }
    }
    doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text('Examination schedule');
    if (rows.length) {
      renderPdfTable(doc, ['Date', 'Time', 'Subject', 'Title', 'Room'],
        rows.map((r) => [String(r.exam_date).slice(0, 10), `${r.start_time}–${r.end_time}`, r.code, r.title, r.room || 'Room TBA']));
    } else {
      doc.moveDown(0.5).fontSize(10).fillColor('#475569').text('No scheduled subjects found for this exam.');
    }
    doc.moveDown().fontSize(10).fillColor('#0f172a')
      .text('Bring this card and a valid ID to every examination. Arrive 30 minutes early.');
    drawSignatureLines(doc, ['Student signature', 'Controller of Examinations']);
    finishPdf(doc);
  } catch (err) { return next(err); }
});

// GET /api/reports/student/:studentId/result-pdf — individual result sheet (published only).
router.get('/student/:studentId/result-pdf', param('studentId').isInt(), validate, async (req, res, next) => {
  try {
    if (req.user.role === 'student') {
      const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
      if (!s.rows[0] || s.rows[0].id !== Number(req.params.studentId)) return res.status(403).json({ success: false, error: 'Students can only download their own results' });
    }
    // A lecturer's copy contains only their own subjects' results, and
    // its CGPA is computed over those rows only.
    const isLecturer = req.user.role === 'lecturer';
    const resultParams = [req.params.studentId];
    let resultExtra = '';
    if (isLecturer) {
      const scope = await getLecturerScope(req.user.id);
      resultParams.push(scope?.lecturerId ?? -1);
      resultExtra = ` AND r.subject_id IN (SELECT id FROM subjects WHERE lecturer_id = $${resultParams.length})`;
    }
    const { rows } = await query(
      `SELECT r.*, sub.code, sub.title, sub.credit_hours, e.title AS exam_title, s.full_name, s.student_id
         FROM results r JOIN subjects sub ON sub.id = r.subject_id JOIN examinations e ON e.id = r.exam_id
         JOIN students s ON s.id = r.student_id
        WHERE r.student_id = $1 AND r.is_published${resultExtra} ORDER BY e.start_date, sub.code`, resultParams);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No published results found' });
    const cgpa = isLecturer ? calculateGpa(rows) : await studentGpa({ query: (t, p) => query(t, p) }, Number(req.params.studentId));
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="result-${rows[0].student_id}.pdf"`);
    doc.pipe(res);
    drawReportHeader(doc, 'Official Result Sheet', 'Published results only');
    drawKeyValues(doc, [
      ['Student', `${rows[0].full_name} (${rows[0].student_id})`],
      ['CGPA', cgpa ?? '—'],
      ['Subjects', String(rows.length)],
    ]);
    doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text('Results');
    renderPdfTable(doc, ['Code', 'Subject', 'Credit Hrs', 'Marks', 'Grade', 'Grade Point'],
      rows.map((r) => [r.code, r.title, String(r.credit_hours ?? ''), String(r.obtained_marks), r.grade, String(r.grade_point ?? '')]));
    doc.moveDown().fontSize(10).fillColor('#475569')
      .text('This result sheet lists published results only. Grades follow the university grade scale.');
    drawSignatureLines(doc, ['Student signature', 'Controller of Examinations']);
    finishPdf(doc);
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

// Lecturers may message one of their own students: they send student_id
// (students.id); the student's users.id is resolved here and the scope is
// checked. Lecturers cannot broadcast or target a role. Staff keep the
// existing behaviour (broadcast / user_id / role_id).
router.post('/notifications', requireRole('super_admin', 'exam_officer', 'lecturer'), async (req, res, next) => {
  try {
    const { title, message, type = 'announcement', role_id, user_id, student_id } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, error: 'title and message are required' });
    let targetUserId = user_id || null;
    let targetRoleId = role_id || null;
    if (req.user.role === 'lecturer') {
      if (role_id || user_id || !student_id) {
        return res.status(400).json({ success: false, error: 'Lecturers can only message one of their own students (student_id required)' });
      }
      const scope = await getLecturerScope(req.user.id);
      if (!scope || !(await studentInLecturerScope(scope.lecturerId, student_id))) {
        return res.status(403).json({ success: false, error: 'Student is not one of your assigned students' });
      }
      const s = await query('SELECT user_id FROM students WHERE id = $1', [student_id]);
      if (!s.rows[0]?.user_id) return res.status(400).json({ success: false, error: 'Student has no linked user account' });
      targetUserId = s.rows[0].user_id;
      targetRoleId = null;
    }
    const { rows } = await query(
      `INSERT INTO notifications (user_id, role_id, title, message, type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [targetUserId, targetRoleId, title, message, type, req.user.id]);
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
// Professional PDF layout (pdfkit): university header, title block with
// generation date, shaded table headers, alternating row colours, wrapped
// text, repeated table headers across pages, and "Page X of Y" footers.
// Previously the PDFs were pipe-joined plain text — same data, now readable
// as an official document.
const UNIVERSITY_NAME = 'University Examination Department';
const TABLE_HEADER_FILL = '#1e3a5f';
const TABLE_ROW_ALT_FILL = '#f1f5f9';

function fmtAfn(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function drawReportHeader(doc, title, subtitle) {
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a')
    .text(UNIVERSITY_NAME, { align: 'center' });
  doc.fontSize(13).text(title, { align: 'center' });
  if (subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor('#475569').text(subtitle, { align: 'center' });
  }
  doc.fontSize(9).fillColor('#64748b')
    .text(`Generated on ${new Date().toLocaleDateString('en-GB')} at ${new Date().toLocaleTimeString('en-GB')}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.strokeColor('#94a3b8').lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.5);
}

// Label/value block, e.g. student details. Labels are bold in a fixed
// left column; values wrap within maxWidth (defaults to full content width).
function drawKeyValues(doc, pairs, maxWidth) {
  const width = maxWidth || (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  const labelWidth = 130;
  const valueWidth = width - labelWidth;
  // Track y ourselves: doc.text(x, y) also moves the cursor, so never
  // rely on doc.y inside this loop.
  let y = doc.y;
  pairs.forEach(([label, value], idx) => {
    doc.font('Helvetica').fontSize(10);
    const h = Math.max(doc.heightOfString(String(value), { width: valueWidth }), 14) + 8;
    if (idx % 2 === 1) {
      doc.rect(doc.page.margins.left, y, width, h).fill(TABLE_ROW_ALT_FILL);
    }
    doc.fillColor('#475569').font('Helvetica-Bold').text(label, doc.page.margins.left + 4, y + 4, { width: labelWidth - 8 });
    doc.fillColor('#0f172a').font('Helvetica').text(String(value), doc.page.margins.left + labelWidth, y + 4, { width: valueWidth - 4 });
    y += h;
  });
  doc.y = y;
  doc.moveDown(0.5);
}

// Two signature lines at the bottom of an official document.
function drawSignatureLines(doc, labels) {
  doc.moveDown(2);
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const half = width / 2;
  labels.slice(0, 2).forEach((label, i) => {
    const x = doc.page.margins.left + i * half;
    doc.strokeColor('#0f172a').lineWidth(0.5)
      .moveTo(x, y).lineTo(x + half - 20, y).stroke();
    doc.fontSize(9).fillColor('#475569').text(label, x, y + 4, { width: half - 20 });
  });
  doc.y = y + 24;
}

// Column widths proportional to the longest content in each column
// (header or any row), clamped so no column is unreadably narrow.
function computeColumnWidths(headers, rows, totalWidth) {
  const weights = headers.map((h, i) => {
    let max = String(h).length;
    for (const row of rows) max = Math.max(max, String(row[i] ?? '').length);
    return Math.min(Math.max(max, 8), 45);
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let widths = weights.map((w) => (totalWidth * w) / sum);
  // Enforce a minimum width, taking the extra from the widest column.
  const min = 42;
  widths.forEach((w, i) => {
    if (w < min) {
      const widest = widths.indexOf(Math.max(...widths));
      const need = min - w;
      widths[widest] -= need;
      widths[i] = min;
    }
  });
  return widths;
}

function tableRowHeight(doc, cells, widths, bold) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  let height = 14;
  cells.forEach((c, i) => {
    height = Math.max(height, doc.heightOfString(String(c ?? ''), { width: widths[i] - 8 }));
  });
  return height + 8;
}

function drawTableRow(doc, cells, widths, y, { header = false, fill = null } = {}) {
  const height = tableRowHeight(doc, cells, widths, header);
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  if (fill) doc.rect(doc.page.margins.left, y, totalWidth, height).fill(fill);
  let x = doc.page.margins.left;
  cells.forEach((c, i) => {
    doc.fillColor(header ? '#ffffff' : '#0f172a')
      .font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
      .text(String(c ?? ''), x + 4, y + 4, { width: widths[i] - 8 });
    x += widths[i];
  });
  return height;
}

// A real table: shaded header row (repeated after every page break),
// alternating row colours, wrapped cells, and a "No records found" note
// when the query came back empty.
function renderPdfTable(doc, headers, rows) {
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = computeColumnWidths(headers, rows, totalWidth);
  const contentBottom = doc.page.height - 60; // keep room for the footer
  let y = doc.y;
  const drawHeader = () => {
    y += drawTableRow(doc, headers, widths, y, { header: true, fill: TABLE_HEADER_FILL });
  };
  drawHeader();
  if (!rows.length) {
    doc.font('Helvetica').fontSize(10).fillColor('#475569')
      .text('No records found.', doc.page.margins.left, y + 6);
    doc.y = y + 24;
    return;
  }
  rows.forEach((row, idx) => {
    const height = tableRowHeight(doc, row, widths, false);
    if (y + height > contentBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    y += drawTableRow(doc, row, widths, y, { fill: idx % 2 === 1 ? TABLE_ROW_ALT_FILL : null });
  });
  doc.y = y + 8;
}

// Page-number footers on every page, then close the document. Requires
// the document to have been created with bufferPages: true.
// NOTE: the footer sits below the bottom margin (page height − 30), and
// pdfkit adds a new page if text is drawn past the writable area — so
// the bottom margin is shrunk while stamping each footer, otherwise
// every document would gain a phantom blank last page.
function finishPdf(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 10;
    doc.font('Helvetica').fontSize(8).fillColor('#64748b')
      .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 30,
        { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  }
  doc.end();
}

// Generic tabular export PDF (student list, schedule, published results,
// financial report uses its own layout above but the same table renderer).
function sendPdf(res, { title, subtitle, filename, headers, rows }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  drawReportHeader(doc, title, subtitle);
  renderPdfTable(doc, headers, rows);
  finishPdf(doc);
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
// Exported for unit tests (backend/test/security.test.js).
module.exports.buildAdmitCardRef = buildAdmitCardRef;
module.exports.buildAdmitCardPayload = buildAdmitCardPayload;
module.exports.computeColumnWidths = computeColumnWidths;
// Test-only: PDF helpers exposed so backend/test/pdf.test.js can render a
// real PDF without a database. Not part of the router API.
module.exports.__test = { drawReportHeader, drawKeyValues, renderPdfTable, finishPdf, fmtAfn };
