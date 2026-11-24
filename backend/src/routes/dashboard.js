// Dashboard stats + recent activity for the frontend Dashboard page.
// The frontend calls GET /api/dashboard/stats and GET /api/dashboard/activity
// and expects camelCase fields (see DashboardStats / ActivityItem in
// frontend/src/services/api.ts). The existing GET /api/reports/dashboard
// returns snake_case counts and different chart shapes, so this router
// returns exactly the frontend's shape instead of reshaping the client.
const express = require('express');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Resolve the caller's lecturer / student row id (null for staff).
async function scopedIds(req) {
  if (req.user.role === 'lecturer') {
    const t = await query('SELECT id FROM lecturers WHERE user_id = $1', [req.user.id]);
    return { lecturerId: t.rows[0]?.id ?? -1, studentId: null };
  }
  if (req.user.role === 'student') {
    const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
    return { lecturerId: null, studentId: s.rows[0]?.id ?? -1 };
  }
  return { lecturerId: null, studentId: null };
}

// GET /api/dashboard/stats — counts + chart data, role-scoped.
// Staff see the whole system; lecturers see only their subjects, students
// only their own enrolments/results (same scoping as marks.js/results.js).
router.get('/stats', async (req, res, next) => {
  try {
    const ids = await scopedIds(req);
    const isLecturer = ids.lecturerId !== null;
    const isStudent = ids.studentId !== null;

    // Subject set the caller may see: lecturer's own subjects, student's
    // enrolled subjects, or all subjects for staff.
    const subjectFilter = isLecturer
      ? `lecturer_id = ${ids.lecturerId}`
      : isStudent
        ? `id IN (SELECT subject_id FROM enrollments WHERE student_id = ${ids.studentId} AND status = 'enrolled')`
        : 'TRUE';
    // Exams visible: those with a schedule in a visible subject (all for staff).
    const examFilterFor = (alias) => (isLecturer || isStudent
      ? `${alias}id IN (SELECT exam_id FROM exam_schedules WHERE subject_id IN (SELECT id FROM subjects WHERE ${subjectFilter}))`
      : 'TRUE');
    const examFilter = examFilterFor('');
    const marksFilter = isLecturer ? `lecturer_id = ${ids.lecturerId}` : isStudent ? `student_id = ${ids.studentId}` : 'TRUE';
    const resultsFilter = isLecturer
      ? `subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${ids.lecturerId})`
      : isStudent ? `student_id = ${ids.studentId}` : 'TRUE';
    const totalStudentsSql = isLecturer
      ? `SELECT count(DISTINCT student_id)::int FROM enrollments WHERE subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${ids.lecturerId}) AND status = 'enrolled'`
      : isStudent ? 'SELECT 1' : `SELECT count(*)::int FROM students WHERE status = 'active'`;
    const totalLecturersSql = isLecturer
      ? 'SELECT 1'
      : isStudent
        ? `SELECT count(DISTINCT lecturer_id)::int FROM subjects WHERE id IN (SELECT subject_id FROM enrollments WHERE student_id = ${ids.studentId} AND status = 'enrolled')`
        : `SELECT count(*)::int FROM lecturers WHERE is_active`;
    const totalDepartmentsSql = isLecturer
      ? `SELECT count(DISTINCT department_id)::int FROM subjects WHERE lecturer_id = ${ids.lecturerId}`
      : isStudent ? 'SELECT 1' : 'SELECT count(*)::int FROM departments';

    const counts = await query(
      `SELECT (${totalStudentsSql}) AS "totalStudents",
              (${totalLecturersSql}) AS "totalLecturers",
              (${totalDepartmentsSql}) AS "totalDepartments",
              (SELECT count(*)::int FROM subjects WHERE is_active AND ${subjectFilter}) AS "totalSubjects",
              (SELECT count(*)::int FROM examinations WHERE status IN ('scheduled','ongoing') AND ${examFilter}) AS "upcomingExams",
              (SELECT count(*)::int FROM examinations WHERE status = 'completed' AND ${examFilter}) AS "completedExams",
              (SELECT count(*)::int FROM results WHERE is_published AND ${resultsFilter}) AS "publishedResults",
              (SELECT count(*)::int FROM marks WHERE status = 'submitted' AND ${marksFilter}) AS "pendingMarks"`);
    const stats = counts.rows[0];

    const byStatus = await query(
      `SELECT UPPER(status) AS status, count(*)::int AS count
         FROM examinations WHERE ${examFilter} GROUP BY status ORDER BY status`);
    const byDept = await query(
      `SELECT d.name AS department,
              ROUND(AVG(r.grade_point)::numeric, 2)::float AS "averageGpa",
              ROUND(100.0 * count(*) FILTER (WHERE r.grade_point >= 1) / NULLIF(count(*), 0), 1)::float AS "passRate"
         FROM results r
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN departments d ON d.id = sub.department_id
        WHERE r.is_published AND ${resultsFilter}
        GROUP BY d.name ORDER BY "averageGpa" DESC`);
    const monthly = await query(
      `WITH months AS (
         SELECT date_trunc('month', CURRENT_DATE - INTERVAL '5 months' + (n || ' months')::interval) AS m
           FROM generate_series(0, 5) n
       )
       SELECT to_char(months.m, 'Mon YYYY') AS month,
              count(e.id) FILTER (WHERE e.status IN ('draft', 'scheduled'))::int AS scheduled,
              count(e.id) FILTER (WHERE e.status = 'completed')::int AS completed
         FROM months
         LEFT JOIN examinations e
           ON date_trunc('month', e.start_date) = months.m
          AND ${examFilterFor('e.')}
        GROUP BY months.m ORDER BY months.m`);

    return res.json({
      success: true,
      data: {
        ...stats,
        examsByStatus: byStatus.rows,
        resultsByDepartment: byDept.rows,
        monthlyExams: monthly.rows,
      },
    });
  } catch (err) { return next(err); }
});

// GET /api/dashboard/activity?limit=10 — recent audit-log entries.
// Privacy rule: every role sees ONLY their own activity entries, except
// Super Admin who sees all entries (e.g. the Exam Officer must not see
// the Super Admin's logins or user-management actions).
router.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const params = [limit];
    let clause = '';
    if (req.user.role !== 'super_admin') {
      params.push(req.user.id);
      clause = 'WHERE a.user_id = $2';
    }
    const { rows } = await query(
      `SELECT a.id, COALESCE(u.full_name, 'System') AS "actorName", a.action,
              COALESCE(a.entity_type, '') AS entity, a.created_at AS "createdAt"
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        ${clause} ORDER BY a.created_at DESC LIMIT $1`, params);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

module.exports = router;
