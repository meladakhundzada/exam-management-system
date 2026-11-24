// Lecturers — CRUD + assigned subjects. Mirrors students.js: creating a
// lecturer also creates their login user (role=lecturer). The caller must
// supply the lecturer's password (minimum 8 characters) in the request
// body — there is no default password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { ensureRoles, getRoleId } = require('../utils/roles');

const router = express.Router();
router.use(authenticate);

const lecturerValidators = [
  body('employee_id').trim().notEmpty(),
  body('full_name').trim().notEmpty(),
  body('email').isEmail(),
  body('department_id').isInt({ min: 1 }),
  body('gender').optional().isIn(['male', 'female', 'other']),
];

router.get('/', requireRole('super_admin', 'exam_officer'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search = '', department_id } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(t.full_name ILIKE $${params.length} OR t.employee_id ILIKE $${params.length} OR t.email ILIKE $${params.length})`); }
    if (department_id) { params.push(department_id); where.push(`t.department_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM lecturers t ${clause}`, params);
    const { rows } = await query(
      `SELECT t.*, d.name AS department_name FROM lecturers t
        JOIN departments d ON d.id = t.department_id ${clause}
       ORDER BY t.full_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

router.get('/:id', requireRole('super_admin', 'exam_officer', 'lecturer'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT t.*, d.name AS department_name FROM lecturers t
          JOIN departments d ON d.id = t.department_id WHERE t.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Lecturer not found' });
      const subjects = await query(
        'SELECT id, code, title, credit_hours FROM subjects WHERE lecturer_id = $1 ORDER BY code', [req.params.id]);
      return res.json({ success: true, data: { ...rows[0], subjects: subjects.rows } });
    } catch (err) { return next(err); }
  });

router.post('/', requireRole('super_admin', 'exam_officer'),
  [...lecturerValidators, body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')], validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const result = await withTransaction(async (client) => {
        const hash = await bcrypt.hash(b.password, 10);
        // Roles may be empty if the seed never ran — ensure them first,
        // otherwise the role subselect returns NULL and the insert fails
        // on users.role_id NOT NULL (same bug as setup-first-admin).
        await ensureRoles(client);
        const roleId = await getRoleId(client, 'lecturer');
        const user = await client.query(
          `INSERT INTO users (role_id, full_name, email, password_hash, phone)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [roleId, b.full_name, b.email.toLowerCase(), hash, b.phone || null]);
        const lecturer = await client.query(
          `INSERT INTO lecturers (user_id, department_id, employee_id, full_name, email, phone, gender,
              designation, qualification, joining_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [user.rows[0].id, b.department_id, b.employee_id, b.full_name, b.email.toLowerCase(),
           b.phone || null, b.gender || null, b.designation || null, b.qualification || null, b.joining_date || null]);
        return lecturer.rows[0];
      });
      await logAudit({ userId: req.user.id, action: 'lecturers.create', entityType: 'lecturers', entityId: result.id, newValues: result, req });
      return res.status(201).json({ success: true, data: result, message: 'Lecturer created.' });
    } catch (err) { return next(err); }
  });

router.put('/:id', requireRole('super_admin', 'exam_officer'), param('id').isInt(), lecturerValidators, validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const { rows } = await query(
        `UPDATE lecturers SET department_id=$1, full_name=$2, email=$3, phone=$4, gender=$5,
           designation=$6, qualification=$7, joining_date=$8, is_active=$9 WHERE id=$10 RETURNING *`,
        [b.department_id, b.full_name, b.email.toLowerCase(), b.phone || null, b.gender || null,
         b.designation || null, b.qualification || null, b.joining_date || null, b.is_active !== false, req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Lecturer not found' });
      await logAudit({ userId: req.user.id, action: 'lecturers.update', entityType: 'lecturers', entityId: rows[0].id, newValues: rows[0], req });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { return next(err); }
  });

router.delete('/:id', requireRole('super_admin'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query('DELETE FROM lecturers WHERE id = $1 RETURNING id, employee_id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Lecturer not found' });
      await logAudit({ userId: req.user.id, action: 'lecturers.delete', entityType: 'lecturers', entityId: rows[0].id, req });
      return res.json({ success: true, message: `Lecturer ${rows[0].employee_id} deleted` });
    } catch (err) { return next(err); }
  });

module.exports = router;
