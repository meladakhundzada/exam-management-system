// Shared scoping helpers for the master-prompt roles (department_head,
// invigilator). Used by dashboard, exams, results, students, lecturers,
// subjects and reports so every route resolves the same scope the same
// way — and so a missing link always means an EMPTY scope, never the
// whole system.
//
// Department link: a user's department comes from their linked
// lecturers/students row — the same source as linkedProfiles() in
// routes/auth.js (and the same value the frontend reads as
// AuthUser.departmentId). There is no department_heads table and no
// users.department_id column, so a department_head with no linked
// lecturers/students row has NO department and sees nothing.
// Invigilator link: invigilator_assignments by user_id or lecturer_id,
// plus the legacy room_allocations.invigilator_id (a lecturers id).
const { query } = require('../config/db');

// Department id for a user, from their linked lecturers row first,
// then their students row. Null when the user has no linked row.
async function getDepartmentIdForUser(userId) {
  const { rows } = await query(
    `SELECT department_id FROM lecturers WHERE user_id = $1
      UNION ALL
     SELECT department_id FROM students WHERE user_id = $1 LIMIT 1`,
    [userId]);
  return rows[0]?.department_id ?? null;
}

// Lecturers row id for a user (null when the user has no linked row).
async function getLecturerIdForUser(userId) {
  const { rows } = await query('SELECT id FROM lecturers WHERE user_id = $1', [userId]);
  return rows[0]?.id ?? null;
}

// Exam schedule ids assigned to an invigilator: the new
// invigilator_assignments table (by user_id or lecturer_id) plus the
// legacy room_allocations.invigilator_id. Returns [] when the user has
// no assignment. If migration 008 has not run yet the new table does
// not exist (42P01) — fall back to the legacy allocations only instead
// of failing the whole request.
async function getInvigilatorScheduleIds(userId) {
  const lectId = await getLecturerIdForUser(userId);
  try {
    const params = [userId];
    let sql = 'SELECT exam_schedule_id FROM invigilator_assignments WHERE user_id = $1';
    if (lectId != null) {
      params.push(lectId);
      sql += ` UNION SELECT exam_schedule_id FROM invigilator_assignments WHERE lecturer_id = $${params.length}`
        + ` UNION SELECT exam_schedule_id FROM room_allocations WHERE invigilator_id = $${params.length}`;
    }
    const { rows } = await query(sql, params);
    return rows.map((r) => r.exam_schedule_id);
  } catch (err) {
    if (err.code !== '42P01' || lectId == null) throw err;
    const { rows } = await query(
      'SELECT exam_schedule_id FROM room_allocations WHERE invigilator_id = $1', [lectId]);
    return rows.map((r) => r.exam_schedule_id);
  }
}

module.exports = { getDepartmentIdForUser, getLecturerIdForUser, getInvigilatorScheduleIds };
