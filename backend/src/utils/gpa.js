// GPA / CGPA calculation — single source of truth, shared by marks.js,
// results.js and reports.js. Grade scale is read from the DB (grade_scales),
// never hard-coded, so the university can change bands without a deploy.
//
// GPA  = Σ(grade_point × credit_hours) / Σ(credit_hours)   (one exam/semester)
// CGPA = same formula over ALL published results for the student.
// Pass mark is grade_scale.is_passing (default: D/E and above pass, F fails).

function gradeForMarks(marks, gradeScale) {
  // gradeScale: [{grade, min_marks, max_marks, grade_point, is_passing}]
  const row = gradeScale.find(
    (g) => Number(marks) >= Number(g.min_marks) && Number(marks) <= Number(g.max_marks),
  );
  return row || null;
}

function calculateGpa(rows) {
  // rows: [{grade_point, credit_hours}] — credit_hours defaults to 3.
  let points = 0;
  let credits = 0;
  for (const r of rows) {
    const ch = Number(r.credit_hours ?? 3);
    points += Number(r.grade_point) * ch;
    credits += ch;
  }
  if (credits === 0) return null;
  return Math.round((points / credits) * 1000) / 1000; // 3 decimals
}

async function getGradeScale(client) {
  const { rows } = await client.query(
    'SELECT grade, min_marks, max_marks, grade_point, is_passing FROM grade_scales ORDER BY min_marks DESC',
  );
  return rows;
}

// Compute (and return) a student's GPA for one exam and CGPA overall,
// from published results only. Students must never see unpublished results.
async function studentGpa(client, studentId, examId = null) {
  const params = [studentId];
  let examFilter = '';
  if (examId) { params.push(examId); examFilter = 'AND r.exam_id = $2'; }
  const { rows } = await client.query(
    `SELECT r.grade_point, s.credit_hours
       FROM results r JOIN subjects s ON s.id = r.subject_id
      WHERE r.student_id = $1 AND r.is_published ${examFilter}`,
    params,
  );
  return calculateGpa(rows);
}

module.exports = { gradeForMarks, calculateGpa, getGradeScale, studentGpa };
