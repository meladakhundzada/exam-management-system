// Lecturer scoping — resolve the caller's lecturers row and the subjects
// assigned to them, and test single resources against that scope.
//
// Linkage (same as linkedProfiles() in routes/auth.js): the lecturer row
// is found via lecturers.user_id = users.id, and a subject is assigned to
// a lecturer via subjects.lecturer_id. A lecturer with no linked row —
// or with no assigned subjects — has an empty scope: list endpoints
// return nothing and single-resource endpoints 403, never the whole table.
const { query } = require('../config/db');

// { lecturerId, departmentId, subjectIds } or null when the user has no
// linked lecturers row.
async function getLecturerScope(userId) {
  const { rows } = await query('SELECT id, department_id FROM lecturers WHERE user_id = $1', [userId]);
  if (!rows[0]) return null;
  const subjects = await query('SELECT id FROM subjects WHERE lecturer_id = $1', [rows[0].id]);
  return {
    lecturerId: rows[0].id,
    departmentId: rows[0].department_id,
    subjectIds: subjects.rows.map((r) => r.id),
  };
}

// SQL fragment restricting a subject-id column to the lecturer's assigned
// subjects. lecturerId -1 (no linked row) matches nothing.
function lecturerSubjectSql(column, paramIndex) {
  return `${column} IN (SELECT id FROM subjects WHERE lecturer_id = $${paramIndex})`;
}

// True when the subject is assigned to this lecturer.
async function lecturerOwnsSubject(lecturerId, subjectId) {
  const { rows } = await query(
    'SELECT 1 FROM subjects WHERE id = $1 AND lecturer_id = $2', [subjectId, lecturerId]);
  return rows.length > 0;
}

// True when the exam has at least one schedule in a subject assigned to
// this lecturer. An exam with no schedules yet is visible to no lecturer.
async function lecturerOwnsExam(lecturerId, examId) {
  const { rows } = await query(
    `SELECT 1 FROM exam_schedules es
      WHERE es.exam_id = $1 AND ${lecturerSubjectSql('es.subject_id', 2)} LIMIT 1`,
    [examId, lecturerId]);
  return rows.length > 0;
}

// True when the schedule's subject is assigned to this lecturer.
async function lecturerOwnsSchedule(lecturerId, scheduleId) {
  const { rows } = await query(
    `SELECT 1 FROM exam_schedules es
      WHERE es.id = $1 AND ${lecturerSubjectSql('es.subject_id', 2)} LIMIT 1`,
    [scheduleId, lecturerId]);
  return rows.length > 0;
}

// True when the student is in the lecturer's scope: in the lecturer's
// department, or enrolled (status 'enrolled') in one of their subjects.
async function studentInLecturerScope(lecturerId, studentId) {
  const { rows } = await query(
    `SELECT 1 FROM students s WHERE s.id = $1 AND (
       s.department_id = (SELECT department_id FROM lecturers WHERE id = $2)
       OR EXISTS (SELECT 1 FROM enrollments en WHERE en.student_id = s.id AND en.status = 'enrolled'
                  AND ${lecturerSubjectSql('en.subject_id', 2)}))`,
    [studentId, lecturerId]);
  return rows.length > 0;
}

module.exports = {
  getLecturerScope,
  lecturerSubjectSql,
  lecturerOwnsSubject,
  lecturerOwnsExam,
  lecturerOwnsSchedule,
  studentInLecturerScope,
};
