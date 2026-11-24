// Dashboard stats + recent activity for the frontend Dashboard page.
// The frontend calls GET /api/dashboard/stats and GET /api/dashboard/activity
// and expects camelCase fields (see DashboardStats / ActivityItem in
// frontend/src/services/api.ts). The existing GET /api/reports/dashboard
// returns snake_case counts and different chart shapes, so this router
// returns exactly the frontend's shape instead of reshaping the client.
const express = require('express');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { studentGpa } = require('../utils/gpa');

const router = express.Router();
router.use(authenticate);

const { getDepartmentIdForUser, getInvigilatorScheduleIds } = require('../utils/scopes');

// Resolve the caller's lecturer / student row id (null for staff),
// plus — for the master-prompt roles — the department head's linked
// department and the invigilator's assigned schedule ids. A missing
// link means an empty scope (null / []), never system-wide data.
async function scopedIds(req) {
  if (req.user.role === 'lecturer') {
    const t = await query('SELECT id FROM lecturers WHERE user_id = $1', [req.user.id]);
    return { lecturerId: t.rows[0]?.id ?? -1, studentId: null, departmentId: null, invigilatorScheduleIds: null };
  }
  if (req.user.role === 'student') {
    const s = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
    return { lecturerId: null, studentId: s.rows[0]?.id ?? -1, departmentId: null, invigilatorScheduleIds: null };
  }
  if (req.user.role === 'department_head') {
    return {
      lecturerId: null, studentId: null,
      departmentId: await getDepartmentIdForUser(req.user.id),
      invigilatorScheduleIds: null,
    };
  }
  if (req.user.role === 'invigilator') {
    return {
      lecturerId: null, studentId: null, departmentId: null,
      invigilatorScheduleIds: await getInvigilatorScheduleIds(req.user.id),
    };
  }
  return { lecturerId: null, studentId: null, departmentId: null, invigilatorScheduleIds: null };
}

// All-zero stats shape: what a department head with no linked
// department, or an invigilator with no assigned sessions, gets —
// never system-wide totals.
function zeroStats() {
  return {
    totalStudents: 0, totalLecturers: 0, totalDepartments: 0, totalSubjects: 0,
    upcomingExams: 0, completedExams: 0, publishedResults: 0, pendingMarks: 0,
    examsByStatus: [], resultsByDepartment: [], monthlyExams: [],
  };
}

// GET /api/dashboard/stats — counts + chart data, role-scoped.
// Staff see the whole system; lecturers see only their subjects, students
// only their own enrolments/results (same scoping as marks.js/results.js).
// Privacy rule: a student must NEVER see system-wide totals — for students
// this endpoint returns ONLY personal numbers (my subjects, my CGPA, my
// exams, my results, my outstanding fees, my attendance rate) and no
// totalStudents / totalLecturers / totalDepartments / global exam counts.
router.get('/stats', async (req, res, next) => {
  try {
    const ids = await scopedIds(req);
    const isLecturer = ids.lecturerId !== null;
    const isStudent = ids.studentId !== null;
    const isDeptHead = req.user.role === 'department_head';
    const isInvigilator = req.user.role === 'invigilator';

    // Department head with no linked department, or invigilator with
    // no assigned sessions: empty stats, never system-wide totals.
    // (The frontend does not request stats for these roles at all, but
    // the API must not serve system totals to them either.)
    if (isDeptHead && ids.departmentId == null) {
      return res.json({ success: true, data: zeroStats() });
    }
    if (isInvigilator && !ids.invigilatorScheduleIds?.length) {
      return res.json({ success: true, data: zeroStats() });
    }

    if (isStudent) {
      const personal = await query(
        `SELECT (SELECT count(*)::int FROM enrollments
                  WHERE student_id = $1 AND status = 'enrolled') AS "mySubjects",
                (SELECT count(*)::int FROM examinations e
                  WHERE e.status IN ('scheduled', 'ongoing')
                    AND EXISTS (SELECT 1 FROM exam_schedules es
                                 JOIN enrollments en ON en.subject_id = es.subject_id
                                WHERE es.exam_id = e.id AND en.student_id = $1
                                  AND en.status = 'enrolled')) AS "myUpcomingExams",
                (SELECT count(*)::int FROM examinations e
                  WHERE e.status = 'completed'
                    AND EXISTS (SELECT 1 FROM exam_schedules es
                                 JOIN enrollments en ON en.subject_id = es.subject_id
                                WHERE es.exam_id = e.id AND en.student_id = $1
                                  AND en.status = 'enrolled')) AS "myCompletedExams",
                (SELECT count(*)::int FROM results
                  WHERE student_id = $1 AND is_published) AS "myPublishedResults",
                (SELECT COALESCE(SUM(amount_due - amount_paid), 0)::float FROM student_fees
                  WHERE student_id = $1 AND status IN ('unpaid', 'partial', 'overdue')) AS "myFeesDue",
                (SELECT ROUND(100.0 * count(*) FILTER (WHERE status = 'present')
                         / NULLIF(count(*), 0), 1)::float
                   FROM attendance WHERE student_id = $1) AS "myAttendanceRate"`,
        [ids.studentId]);
      const myCgpa = await studentGpa({ query: (t, p) => query(t, p) }, ids.studentId);
      return res.json({ success: true, data: { ...personal.rows[0], myCgpa } });
    }

    // Subject set the caller may see: lecturer's own subjects, the
    // department head's department subjects, the invigilator's assigned
    // sessions' subjects, or all subjects for staff. (Students return
    // early above, so no student branch is needed here.) Department and
    // schedule ids come from the DB (never user input), as in the
    // lecturer branch — interpolating them is the existing pattern here.
    const deptId = isDeptHead ? Number(ids.departmentId) : null;
    const invScheduleList = isInvigilator
      ? ids.invigilatorScheduleIds.map((n) => Number(n)).join(',')
      : null;
    const subjectFilter = isLecturer
      ? `lecturer_id = ${ids.lecturerId}`
      : isDeptHead
        ? `department_id = ${deptId}`
        : isInvigilator
          ? `id IN (SELECT subject_id FROM exam_schedules WHERE id IN (${invScheduleList}))`
          : 'TRUE';
    // Exams visible: those with a schedule in a visible subject (all for staff).
    const examFilterFor = (alias) => (isLecturer
      ? `${alias}id IN (SELECT exam_id FROM exam_schedules WHERE subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${ids.lecturerId}))`
      : isDeptHead
        ? `${alias}id IN (SELECT exam_id FROM exam_schedules WHERE subject_id IN (SELECT id FROM subjects WHERE department_id = ${deptId}))`
        : isInvigilator
          ? `${alias}id IN (SELECT exam_id FROM exam_schedules WHERE id IN (${invScheduleList}))`
          : 'TRUE');
    const examFilter = examFilterFor('');
    // Invigilators do not review marks or results: those counts stay 0.
    const marksFilter = isLecturer ? `lecturer_id = ${ids.lecturerId}`
      : isDeptHead ? `subject_id IN (SELECT id FROM subjects WHERE department_id = ${deptId})`
      : isInvigilator ? 'FALSE' : 'TRUE';
    const resultsFilter = isLecturer
      ? `subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${ids.lecturerId})`
      : isDeptHead
        ? `subject_id IN (SELECT id FROM subjects WHERE department_id = ${deptId})`
        : isInvigilator ? 'FALSE' : 'TRUE';
    const totalStudentsSql = isLecturer
      ? `SELECT count(DISTINCT student_id)::int FROM enrollments WHERE subject_id IN (SELECT id FROM subjects WHERE lecturer_id = ${ids.lecturerId}) AND status = 'enrolled'`
      : isDeptHead
        ? `SELECT count(*)::int FROM students WHERE status = 'active' AND department_id = ${deptId}`
        : isInvigilator
          ? `SELECT count(DISTINCT student_id)::int FROM enrollments WHERE subject_id IN (SELECT subject_id FROM exam_schedules WHERE id IN (${invScheduleList})) AND status = 'enrolled'`
          : `SELECT count(*)::int FROM students WHERE status = 'active'`;
    const totalLecturersSql = isLecturer
      ? 'SELECT 1'
      : isDeptHead
        ? `SELECT count(*)::int FROM lecturers WHERE is_active AND department_id = ${deptId}`
        : isInvigilator
          ? 'SELECT 1'
          : `SELECT count(*)::int FROM lecturers WHERE is_active`;
    const totalDepartmentsSql = isLecturer
      ? `SELECT count(DISTINCT department_id)::int FROM subjects WHERE lecturer_id = ${ids.lecturerId}`
      : isDeptHead
        ? 'SELECT 1'
        : isInvigilator
          ? `SELECT count(DISTINCT department_id)::int FROM subjects WHERE id IN (SELECT subject_id FROM exam_schedules WHERE id IN (${invScheduleList}))`
          : 'SELECT count(*)::int FROM departments';

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
