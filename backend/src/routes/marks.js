// Marks entry & approval.
// Status flow: draft → submitted (lecturer) → approved | rejected (officer).
// Only approved marks can be turned into results (see results.js).
// Lecturers may only enter marks for subjects assigned to them (lecturer_id
// on subjects); the check below enforces that at the API layer.
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { getGradeScale, gradeForMarks, studentGpa } = require('../utils/gpa');
const { getLecturerScope, lecturerSubjectSql, lecturerOwnsSubject: lecturerOwnsSubjectId } = require('../utils/lecturerScope');

const router = express.Router();
router.use(authenticate);

// Best-effort write to marks_history (migration 010): who changed a mark,
// from which value to which, and why. `queryFn` is the pool `query` outside
// a transaction or a bound `client.query` inside one. A history failure must
// never break the mark change itself, so it is logged, not thrown.
async function recordHistory(queryFn, { markId, changedBy, oldValue, newValue, reason }) {
  try {
    await queryFn(
      `INSERT INTO marks_history (mark_id, changed_by, old_value, new_value, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [markId, changedBy ?? null, oldValue ?? null, newValue ?? null, reason ?? null]);
  } catch (err) {
    console.warn('[marks_history] insert failed (migration 010 not applied?):', err.message);
  }
}

// Locked-mark rule: an approved mark can never be overwritten by the entry
// upserts, and a submitted mark is locked until an officer rejects it back.
// Returns an error string when the existing row blocks the change, else null.
function lockedMarkError(existing) {
  if (!existing) return null;
  if (existing.status === 'approved') {
    return 'This mark is approved and locked. Request a correction (POST /api/marks/:id/corrections) instead of re-entering it.';
  }
  if (existing.status === 'submitted') {
    return 'This mark has been submitted for approval. Ask an Examination Officer to reject it back before changing it.';
  }
  return null;
}

async function lecturerOwnsSubject(req, res, next) {
  if (req.user.role !== 'lecturer') return next();
  const { rows } = await query('SELECT id FROM lecturers WHERE user_id = $1', [req.user.id]);
  if (!rows[0]) return res.status(403).json({ success: false, error: 'Lecturer profile not found' });
  const subjectId = req.body.subject_id || req.query.subject_id;
  if (!subjectId) return next();
  const owned = await query('SELECT 1 FROM subjects WHERE id = $1 AND lecturer_id = $2', [subjectId, rows[0].id]);
  if (!owned.rows.length) return res.status(403).json({ success: false, error: 'You can only enter marks for your own subjects' });
  req.lecturerId = rows[0].id;
  return next();
}

// GET /api/marks?exam_id&subject_id&student_id&status — paginated.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { exam_id, subject_id, student_id, status } = req.query;
    const where = []; const params = [];
    if (exam_id) { params.push(exam_id); where.push(`m.exam_id = $${params.length}`); }
    if (subject_id) { params.push(subject_id); where.push(`m.subject_id = $${params.length}`); }
    if (student_id) { params.push(student_id); where.push(`m.student_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`m.status = $${params.length}`); }
    if (req.user.role === 'lecturer') {
      // Scope by assigned subject, not by marks.lecturer_id: marks entered
      // by an officer for the lecturer's subject must be visible too, and
      // marks for other subjects must never be. No linked row → empty list.
      const scope = await getLecturerScope(req.user.id);
      params.push(scope?.lecturerId ?? -1);
      where.push(lecturerSubjectSql('m.subject_id', params.length));
    }
    if (req.user.role === 'student') {
      // Students must never see marks here: this endpoint returns drafts,
      // submitted and rejected marks as well as approved ones. Students see
      // only PUBLISHED results, via GET /api/results (which enforces
      // is_published = TRUE). 403, not a filtered list, so no caller can
      // mistake a filtered response for "no marks exist yet".
      return res.status(403).json({
        success: false,
        error: 'Students can only view published results (GET /api/results). Marks, including drafts and unpublished marks, are not visible to students.',
      });
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM marks m ${clause}`, params);
    const { rows } = await query(
      `SELECT m.id, m.exam_id, m.subject_id, m.student_id AS student_pk,
              m.lecturer_id, m.obtained_marks, m.total_marks, m.status, m.remarks,
              m.entered_at, m.updated_at,
              s.student_id AS student_no, s.full_name AS student_name,
              sub.code AS subject_code, sub.title AS subject_title
         FROM marks m JOIN students s ON s.id = m.student_id JOIN subjects sub ON sub.id = m.subject_id
         ${clause} ORDER BY m.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/marks/roster?exam_id&subject_id — students enrolled in the
// subject, each with their existing mark row for the exam (if any).
// Marks entry needs a roster, not just existing rows: on a fresh exam
// GET /api/marks returns nothing, so the page would have nobody to enter
// marks for. student_pk is the internal students.id (what /bulk needs);
// student_no is the public STU-… number shown in the UI.
// Staff + the subject's own lecturer only: a lecturer may not pull the
// roster (names + existing marks) for another lecturer's subject.
router.get('/roster', requireRole('super_admin', 'exam_officer', 'lecturer'), async (req, res, next) => {
  try {
    const { exam_id, subject_id } = req.query;
    if (!exam_id || !subject_id) {
      return res.status(400).json({ success: false, error: 'exam_id and subject_id query parameters are required' });
    }
    if (req.user.role === 'lecturer') {
      const scope = await getLecturerScope(req.user.id);
      if (!scope || !(await lecturerOwnsSubjectId(scope.lecturerId, subject_id))) {
        return res.status(403).json({ success: false, error: 'You can only view rosters for your own subjects' });
      }
    }
    const { rows } = await query(
      `SELECT s.id AS student_pk, s.student_id AS student_no, s.full_name AS student_name,
              m.id AS mark_id, m.obtained_marks, m.total_marks, m.status
         FROM enrollments en JOIN students s ON s.id = en.student_id
         LEFT JOIN marks m ON m.student_id = s.id AND m.exam_id = $1 AND m.subject_id = $2
        WHERE en.subject_id = $2 AND en.status = 'enrolled' AND s.status = 'active'
        ORDER BY s.full_name`,
      [exam_id, subject_id]);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// POST /api/marks — single mark (draft). Use /bulk for a whole class.
router.post('/', requireRole('super_admin', 'exam_officer', 'lecturer'), lecturerOwnsSubject,
  [body('exam_id').isInt({ min: 1 }), body('subject_id').isInt({ min: 1 }),
   body('student_id').isInt({ min: 1 }),
   body('obtained_marks').isFloat({ min: 0, max: 100 }),
   body('total_marks').optional().isFloat({ min: 1 })], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      // The upsert below must never silently re-open a locked mark: an
      // approved mark is changed only through the correction flow, and a
      // submitted mark only after an officer rejects it back.
      const existing = await query(
        'SELECT id, status, total_marks, obtained_marks FROM marks WHERE exam_id = $1 AND subject_id = $2 AND student_id = $3',
        [b.exam_id, b.subject_id, b.student_id]);
      const locked = lockedMarkError(existing.rows[0]);
      if (locked) return res.status(409).json({ success: false, error: locked });
      const total = Number(b.total_marks ?? existing.rows[0]?.total_marks ?? 100);
      if (Number(b.obtained_marks) > total) {
        return res.status(400).json({
          success: false,
          error: `Obtained marks (${b.obtained_marks}) exceed the maximum for this exam (${total}).`,
        });
      }
      const { rows } = await query(
        `INSERT INTO marks (exam_id, subject_id, student_id, lecturer_id, obtained_marks, total_marks, status, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
         ON CONFLICT (exam_id, subject_id, student_id)
         DO UPDATE SET obtained_marks = EXCLUDED.obtained_marks, total_marks = EXCLUDED.total_marks,
                       remarks = EXCLUDED.remarks, status = 'draft', updated_at = now()
         RETURNING *`,
        [b.exam_id, b.subject_id, b.student_id, req.lecturerId || b.lecturer_id || null,
         b.obtained_marks, total, b.remarks || null]);
      await recordHistory(query, {
        markId: rows[0].id, changedBy: req.user.id,
        oldValue: existing.rows[0]?.obtained_marks ?? null, newValue: rows[0].obtained_marks,
        reason: existing.rows[0] ? 'mark updated' : 'mark created',
      });
      await logAudit({ userId: req.user.id, action: 'marks.create', entityType: 'marks', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/marks/bulk — upsert many marks for one exam+subject in one call.
// Body: { exam_id, subject_id, marks: [{ student_id, obtained_marks }] }
router.post('/bulk', requireRole('super_admin', 'exam_officer', 'lecturer'), lecturerOwnsSubject,
  [body('exam_id').isInt({ min: 1 }), body('subject_id').isInt({ min: 1 }),
   body('marks').isArray({ min: 1 }),
   body('marks.*.student_id').isInt({ min: 1 }),
   body('marks.*.obtained_marks').isFloat({ min: 0, max: 100 })], validate,
  async (req, res, next) => {
    try {
      // Locked rows (approved/submitted) and over-maximum rows are SKIPPED
      // and reported in `skipped` — never silently overwritten, and never
      // failing the whole class save because of one row. The caller must
      // show the skipped list: a skipped approved mark needs a correction
      // request, a skipped submitted mark needs an officer to reject it.
      const studentIds = req.body.marks.map((m) => m.student_id);
      const { rows: existingRows } = await query(
        `SELECT student_id, status, total_marks, obtained_marks FROM marks
          WHERE exam_id = $1 AND subject_id = $2 AND student_id = ANY($3)`,
        [req.body.exam_id, req.body.subject_id, studentIds]);
      const byStudent = new Map(existingRows.map((r) => [Number(r.student_id), r]));
      const saved = [];
      const skipped = [];
      for (const m of req.body.marks) {
        const ex = byStudent.get(Number(m.student_id));
        const locked = lockedMarkError(ex);
        if (locked) { skipped.push({ student_id: m.student_id, error: locked }); continue; }
        const total = Number(ex?.total_marks ?? 100);
        if (Number(m.obtained_marks) > total) {
          skipped.push({
            student_id: m.student_id,
            error: `Obtained marks (${m.obtained_marks}) exceed the maximum for this exam (${total}).`,
          });
          continue;
        }
        const { rows } = await query(
          `INSERT INTO marks (exam_id, subject_id, student_id, lecturer_id, obtained_marks, total_marks, status)
           VALUES ($1,$2,$3,$4,$5,100,'draft')
           ON CONFLICT (exam_id, subject_id, student_id)
           DO UPDATE SET obtained_marks = EXCLUDED.obtained_marks, status = 'draft', updated_at = now()
           RETURNING *`,
          [req.body.exam_id, req.body.subject_id, m.student_id, req.lecturerId || null, m.obtained_marks]);
        await recordHistory(query, {
          markId: rows[0].id, changedBy: req.user.id,
          oldValue: ex?.obtained_marks ?? null, newValue: rows[0].obtained_marks,
          reason: ex ? 'mark updated (bulk)' : 'mark created (bulk)',
        });
        saved.push(rows[0]);
      }
      await logAudit({ userId: req.user.id, action: 'marks.bulk_create', entityType: 'marks', newValues: { exam_id: req.body.exam_id, subject_id: req.body.subject_id, count: saved.length, skipped: skipped.length }, req });
      return res.status(201).json({ success: true, data: saved, skipped });
    } catch (err) { return next(err); }
  });

// POST /api/marks/:id/submit — lecturer submits draft marks for approval.
router.post('/:id/submit', requireRole('super_admin', 'exam_officer', 'lecturer'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      // A lecturer may submit only marks for their own subjects; without
      // this, any lecturer could submit any mark row by id.
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        const mark = await query('SELECT subject_id FROM marks WHERE id = $1', [req.params.id]);
        if (mark.rows[0] && (!scope || !(await lecturerOwnsSubjectId(scope.lecturerId, mark.rows[0].subject_id)))) {
          return res.status(403).json({ success: false, error: 'You can only submit marks for your own subjects' });
        }
      }
      const { rows } = await query(
        `UPDATE marks SET status = 'submitted' WHERE id = $1 AND status = 'draft' RETURNING *`, [req.params.id]);
      if (!rows[0]) return res.status(409).json({ success: false, error: 'Mark not found or not in draft status' });
      await recordHistory(query, {
        markId: rows[0].id, changedBy: req.user.id,
        oldValue: rows[0].obtained_marks, newValue: rows[0].obtained_marks, reason: 'submitted for approval',
      });
      await logAudit({ userId: req.user.id, action: 'marks.submit', entityType: 'marks', entityId: rows[0].id, req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/marks/:id/approve — officer approves a SUBMITTED mark only.
// A draft must be submitted first (400); approving drafts would skip the
// lecturer's submit step and the review queue entirely.
router.post('/:id/approve', requireRole('super_admin', 'exam_officer', 'exam_controller'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const existing = await query('SELECT id, status, obtained_marks FROM marks WHERE id = $1', [req.params.id]);
      if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'Mark not found' });
      if (existing.rows[0].status !== 'submitted') {
        return res.status(400).json({
          success: false,
          error: `Only submitted marks can be approved (current status: ${existing.rows[0].status}). Draft marks must be submitted first.`,
        });
      }
      const { rows } = await query(
        `UPDATE marks SET status = 'approved' WHERE id = $1 AND status = 'submitted' RETURNING *`, [req.params.id]);
      if (!rows[0]) return res.status(409).json({ success: false, error: 'Mark changed while approving — please retry' });
      await recordHistory(query, {
        markId: rows[0].id, changedBy: req.user.id,
        oldValue: rows[0].obtained_marks, newValue: rows[0].obtained_marks, reason: 'approved',
      });
      await logAudit({ userId: req.user.id, action: 'marks.approve', entityType: 'marks', entityId: rows[0].id, req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// POST /api/marks/:id/reject — officer rejects a SUBMITTED mark with a reason
// (marks.remarks). Drafts cannot be rejected: there is nothing to send back.
router.post('/:id/reject', requireRole('super_admin', 'exam_officer', 'exam_controller'), param('id').isInt(),
  [body('reason').optional().trim()], validate, async (req, res, next) => {
    try {
      const existing = await query('SELECT id, status, obtained_marks FROM marks WHERE id = $1', [req.params.id]);
      if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'Mark not found' });
      if (existing.rows[0].status !== 'submitted') {
        return res.status(400).json({
          success: false,
          error: `Only submitted marks can be rejected (current status: ${existing.rows[0].status}).`,
        });
      }
      const { rows } = await query(
        `UPDATE marks SET status = 'rejected', remarks = $2 WHERE id = $1 AND status = 'submitted' RETURNING *`,
        [req.params.id, req.body.reason || null]);
      if (!rows[0]) return res.status(409).json({ success: false, error: 'Mark changed while rejecting — please retry' });
      await recordHistory(query, {
        markId: rows[0].id, changedBy: req.user.id,
        oldValue: rows[0].obtained_marks, newValue: rows[0].obtained_marks,
        reason: `rejected${req.body.reason ? `: ${req.body.reason}` : ''}`,
      });
      await logAudit({ userId: req.user.id, action: 'marks.reject', entityType: 'marks', entityId: rows[0].id, req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// ---- Correction workflow for APPROVED marks ---------------------------------
// An approved mark is locked: it can only change through a correction
// request, reviewed by a Super Admin or Exam Officer. On approval the mark
// is updated (it stays 'approved'), the old value goes to marks_history,
// and any not-yet-published result row for the mark is re-graded. A
// published result blocks approval until the exam is unpublished first,
// so a published transcript can never change silently.

// POST /api/marks/:id/corrections — lecturer/officer requests a correction.
router.post('/:id/corrections', requireRole('super_admin', 'exam_officer', 'lecturer'), param('id').isInt(),
  [body('proposed_value').isFloat({ min: 0 }),
   body('reason').trim().isLength({ min: 1, max: 1000 })], validate,
  async (req, res, next) => {
    try {
      const { rows: markRows } = await query(
        'SELECT id, subject_id, status, obtained_marks, total_marks FROM marks WHERE id = $1', [req.params.id]);
      const mark = markRows[0];
      if (!mark) return res.status(404).json({ success: false, error: 'Mark not found' });
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSubjectId(scope.lecturerId, mark.subject_id))) {
          return res.status(403).json({ success: false, error: 'You can only request corrections for your own subjects' });
        }
      }
      if (mark.status !== 'approved') {
        return res.status(400).json({
          success: false,
          error: `Corrections apply only to approved marks (current status: ${mark.status}). Draft and submitted marks can still be edited directly.`,
        });
      }
      if (Number(req.body.proposed_value) > Number(mark.total_marks)) {
        return res.status(400).json({
          success: false,
          error: `Proposed value (${req.body.proposed_value}) exceeds the maximum for this exam (${mark.total_marks}).`,
        });
      }
      const { rows } = await query(
        `INSERT INTO mark_corrections (mark_id, requested_by, proposed_value, reason)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [mark.id, req.user.id, req.body.proposed_value, req.body.reason]);
      await logAudit({ userId: req.user.id, action: 'marks.correction_request', entityType: 'mark_corrections', entityId: rows[0].id, newValues: rows[0], req });
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      // The partial unique index allows only one pending correction per mark.
      if (err.code === '23505') {
        return res.status(409).json({ success: false, error: 'A correction request for this mark is already pending review.' });
      }
      return next(err);
    }
  });

// GET /api/marks/corrections?status=pending — list correction requests.
// Officers see all; lecturers see only requests they made.
router.get('/corrections', requireRole('super_admin', 'exam_officer', 'lecturer'), async (req, res, next) => {
  try {
    const where = []; const params = [];
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
    if (req.user.role === 'lecturer') { params.push(req.user.id); where.push(`c.requested_by = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT c.*, m.obtained_marks AS current_value, m.total_marks,
              m.exam_id, m.subject_id, m.student_id,
              s.full_name AS student_name, s.student_id AS student_no,
              sub.code AS subject_code, e.title AS exam_title
         FROM mark_corrections c JOIN marks m ON m.id = c.mark_id
         JOIN students s ON s.id = m.student_id JOIN subjects sub ON sub.id = m.subject_id
         JOIN examinations e ON e.id = m.exam_id
        ${clause} ORDER BY c.created_at DESC`,
      params);
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// POST /api/marks/corrections/:correctionId/approve — apply the correction.
router.post('/corrections/:correctionId/approve', requireRole('super_admin', 'exam_officer'),
  param('correctionId').isInt(), [body('review_note').optional().trim()], validate,
  async (req, res, next) => {
    try {
      const updated = await withTransaction(async (client) => {
        const q = (t, p) => client.query(t, p);
        const { rows: corrRows } = await client.query(
          'SELECT * FROM mark_corrections WHERE id = $1 FOR UPDATE', [req.params.correctionId]);
        const corr = corrRows[0];
        if (!corr) { const e = new Error('Correction request not found'); e.status = 404; throw e; }
        if (corr.status !== 'pending') { const e = new Error(`Correction request already ${corr.status}`); e.status = 400; throw e; }
        const { rows: markRows } = await client.query(
          'SELECT * FROM marks WHERE id = $1 FOR UPDATE', [corr.mark_id]);
        const mark = markRows[0];
        if (!mark) { const e = new Error('Mark no longer exists'); e.status = 404; throw e; }
        if (mark.status !== 'approved') { const e = new Error(`Mark is no longer approved (status: ${mark.status})`); e.status = 400; throw e; }
        // A published result must never change silently: unpublish first.
        const { rows: published } = await client.query(
          'SELECT id FROM results WHERE mark_id = $1 AND is_published', [mark.id]);
        if (published.length) {
          const e = new Error('This mark already has a published result. Unpublish the exam results before approving the correction.');
          e.status = 409; throw e;
        }
        const oldValue = Number(mark.obtained_marks);
        const { rows: updatedMark } = await client.query(
          `UPDATE marks SET obtained_marks = $1, updated_at = now() WHERE id = $2 RETURNING *`,
          [corr.proposed_value, mark.id]);
        await recordHistory(q, {
          markId: mark.id, changedBy: req.user.id,
          oldValue, newValue: Number(corr.proposed_value),
          reason: `correction #${corr.id} approved: ${corr.reason}`,
        });
        // Re-grade any not-yet-published result row for this mark, and
        // refresh the student's GPA snapshot for the exam.
        const { rows: resultRows } = await client.query(
          'SELECT id FROM results WHERE mark_id = $1', [mark.id]);
        if (resultRows.length) {
          const scale = await getGradeScale(client);
          const grade = gradeForMarks(corr.proposed_value, mark.total_marks, scale);
          if (!grade) { const e = new Error('Corrected value has no grade band — cannot update the result'); e.status = 400; throw e; }
          await client.query(
            `UPDATE results SET obtained_marks = $1, grade = $2, grade_point = $3, updated_at = now()
              WHERE mark_id = $4`,
            [corr.proposed_value, grade.grade, grade.grade_point, mark.id]);
          const gpa = await studentGpa(client, mark.student_id, mark.exam_id);
          await client.query(
            'UPDATE results SET gpa = $1 WHERE exam_id = $2 AND student_id = $3',
            [gpa, mark.exam_id, mark.student_id]);
        }
        const { rows: done } = await client.query(
          `UPDATE mark_corrections SET status = 'approved', reviewed_by = $1, reviewed_at = now(),
             review_note = $2, updated_at = now() WHERE id = $3 RETURNING *`,
          [req.user.id, req.body.review_note || null, corr.id]);
        return { correction: done[0], mark: updatedMark[0] };
      });
      await logAudit({ userId: req.user.id, action: 'marks.correction_approve', entityType: 'mark_corrections', entityId: updated.correction.id, newValues: updated.correction, req });
      return res.json({ success: true, data: updated });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, error: err.message });
      return next(err);
    }
  });

// POST /api/marks/corrections/:correctionId/reject — decline the correction.
router.post('/corrections/:correctionId/reject', requireRole('super_admin', 'exam_officer'),
  param('correctionId').isInt(), [body('review_note').optional().trim()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE mark_corrections SET status = 'rejected', reviewed_by = $1, reviewed_at = now(),
           review_note = $2, updated_at = now()
          WHERE id = $3 AND status = 'pending' RETURNING *`,
        [req.user.id, req.body.review_note || null, req.params.correctionId]);
      if (!rows[0]) {
        const exists = await query('SELECT id FROM mark_corrections WHERE id = $1', [req.params.correctionId]);
        if (!exists.rows[0]) return res.status(404).json({ success: false, error: 'Correction request not found' });
        return res.status(400).json({ success: false, error: 'Correction request is no longer pending' });
      }
      await logAudit({ userId: req.user.id, action: 'marks.correction_reject', entityType: 'mark_corrections', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

// GET /api/marks/:id/history — who changed this mark, from what to what, when.
router.get('/:id/history', requireRole('super_admin', 'exam_officer', 'lecturer'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const mark = await query('SELECT subject_id FROM marks WHERE id = $1', [req.params.id]);
      if (!mark.rows[0]) return res.status(404).json({ success: false, error: 'Mark not found' });
      if (req.user.role === 'lecturer') {
        const scope = await getLecturerScope(req.user.id);
        if (!scope || !(await lecturerOwnsSubjectId(scope.lecturerId, mark.rows[0].subject_id))) {
          return res.status(403).json({ success: false, error: 'You can only view history for your own subjects' });
        }
      }
      const { rows } = await query(
        `SELECT h.*, u.full_name AS changed_by_name
           FROM marks_history h LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.mark_id = $1 ORDER BY h.created_at DESC, h.id DESC`,
        [req.params.id]);
      return res.json({ success: true, data: rows });
    } catch (err) { return next(err); }
  });

// GET /api/marks/pending — count + list of submitted marks awaiting approval.
router.get('/pending/list', requireRole('super_admin', 'exam_officer', 'exam_controller'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*, s.full_name AS student_name, sub.code AS subject_code, e.title AS exam_title
         FROM marks m JOIN students s ON s.id = m.student_id
         JOIN subjects sub ON sub.id = m.subject_id JOIN examinations e ON e.id = m.exam_id
        WHERE m.status = 'submitted' ORDER BY m.updated_at DESC`);
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (err) { return next(err); }
});

module.exports = router;
