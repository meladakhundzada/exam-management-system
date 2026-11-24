// Users — Super Admin only. Create/manage login accounts for all four
// roles, including the Exam Officer (abas). Creating a user with role
// lecturer/student also creates (or links) the matching lecturers /
// students row in the same transaction, so the person can actually use
// the system — a bare login user with role lecturer but no lecturers row
// would see an empty dashboard. The caller supplies the password
// (minimum 8 characters); there is no default password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { ensureRoles, getRoleId, SYSTEM_ROLES } = require('../utils/roles');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('super_admin'));

const ROLE_NAMES = SYSTEM_ROLES.map(([name]) => name);

const userSelect = `u.id, u.full_name, u.email, u.phone, u.is_active,
  u.last_login_at, u.created_at, u.updated_at, r.name AS role,
  (SELECT id FROM lecturers WHERE user_id = u.id) AS lecturer_id,
  (SELECT id FROM students WHERE user_id = u.id) AS student_id`;

// Next free employee number for auto-generated LEC-xxx ids.
async function nextEmployeeId(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(employee_id FROM '[0-9]+$') AS INT)), 0) + 1 AS n
       FROM lecturers WHERE employee_id ~ '^LEC-[0-9]+$'`,
  );
  return `LEC-${String(rows[0].n).padStart(3, '0')}`;
}

// GET /api/users?page&limit&search&role — paginated list (no password hashes).
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search = '', role } = req.query;
    const where = []; const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
    if (role) {
      if (!ROLE_NAMES.includes(role)) return res.status(400).json({ success: false, error: `Unknown role: ${role}` });
      params.push(role); where.push(`r.name = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(
      `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id ${clause}`, params);
    const { rows } = await query(
      `SELECT ${userSelect} FROM users u JOIN roles r ON r.id = u.role_id ${clause}
        ORDER BY u.full_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows, total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// GET /api/users/:id — one user (no password hash).
router.get('/:id', param('id').isInt(), validate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${userSelect} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { return next(err); }
});

const createValidators = [
  body('full_name').trim().notEmpty().withMessage('full_name required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isIn(ROLE_NAMES).withMessage(`role must be one of: ${ROLE_NAMES.join(', ')}`),
  body('phone').optional().trim(),
  body('department_id').optional().isInt({ min: 1 }),
  body('employee_id').optional().trim(),
  body('student_id').optional().trim(),
  body('admission_year').optional().isInt({ min: 2000, max: 2100 }),
  body('current_semester').optional().isInt({ min: 1, max: 8 }),
];

// POST /api/users — create a login user (+ linked lecturer/student row).
// Lecturer: department_id required; employee_id optional (auto LEC-xxx).
// If a lecturers row with that employee_id already exists without a user
// (e.g. Eng Irfan, LEC-007 from the seed), link it instead of creating
// a second row. Student: department_id, student_id and admission_year
// required; an existing unlinked students row with that student_id is
// linked the same way.
router.post('/', createValidators, validate, async (req, res, next) => {
  try {
    const b = req.body;
    if ((b.role === 'lecturer' || b.role === 'student') && !b.department_id) {
      return res.status(400).json({ success: false, error: 'department_id is required for lecturer and student accounts' });
    }
    if (b.role === 'student' && (!b.student_id || !b.admission_year)) {
      return res.status(400).json({ success: false, error: 'student_id and admission_year are required for student accounts' });
    }
    const result = await withTransaction(async (client) => {
      const hash = await bcrypt.hash(b.password, 10);
      // Roles may be empty if the seed never ran — ensure them first,
      // otherwise the role lookup returns NULL and the insert fails
      // on users.role_id NOT NULL (same bug as setup-first-admin).
      await ensureRoles(client);
      const roleId = await getRoleId(client, b.role);
      const user = await client.query(
        `INSERT INTO users (role_id, full_name, email, password_hash, phone)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name, email, phone, is_active, created_at`,
        [roleId, b.full_name, b.email.toLowerCase(), hash, b.phone || null]);
      const created = { ...user.rows[0], role: b.role };
      if (b.role === 'lecturer') {
        const employeeId = b.employee_id || await nextEmployeeId(client);
        const existing = await client.query(
          'SELECT id, user_id FROM lecturers WHERE employee_id = $1', [employeeId]);
        if (existing.rows[0] && b.employee_id) {
          if (existing.rows[0].user_id) {
            throw Object.assign(new Error('That lecturer already has a login account'), { status: 409 });
          }
          // Seed row exists without a login (e.g. LEC-007) — link it.
          await client.query(
            'UPDATE lecturers SET user_id = $1, email = $2 WHERE id = $3',
            [created.id, b.email.toLowerCase(), existing.rows[0].id]);
          created.lecturer_id = existing.rows[0].id;
        } else {
          const lecturer = await client.query(
            `INSERT INTO lecturers (user_id, department_id, employee_id, full_name, email, phone)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [created.id, b.department_id, employeeId, b.full_name, b.email.toLowerCase(), b.phone || null]);
          created.lecturer_id = lecturer.rows[0].id;
        }
      }
      if (b.role === 'student') {
        const existing = await client.query(
          'SELECT id, user_id FROM students WHERE student_id = $1', [b.student_id]);
        if (existing.rows[0]) {
          if (existing.rows[0].user_id) {
            throw Object.assign(new Error('That student already has a login account'), { status: 409 });
          }
          await client.query(
            'UPDATE students SET user_id = $1, email = $2 WHERE id = $3',
            [created.id, b.email.toLowerCase(), existing.rows[0].id]);
          created.student_id = existing.rows[0].id;
        } else {
          const student = await client.query(
            `INSERT INTO students (user_id, department_id, student_id, full_name, email, phone,
                admission_year, current_semester)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [created.id, b.department_id, b.student_id, b.full_name, b.email.toLowerCase(),
             b.phone || null, b.admission_year, b.current_semester || 1]);
          created.student_id = student.rows[0].id;
        }
      }
      return created;
    });
    await logAudit({ userId: req.user.id, action: 'users.create', entityType: 'users', entityId: result.id, newValues: { ...result, role: b.role }, req });
    return res.status(201).json({ success: true, data: result, message: 'User created.' });
  } catch (err) { return next(err); }
});

// PUT /api/users/:id — change name / phone / role / active status.
// You cannot deactivate yourself or change your own role (that would
// lock you out of the Super Admin account). Changing a role does not
// create or remove linked lecturer/student rows.
router.put('/:id', param('id').isInt(),
  [body('full_name').optional().trim().notEmpty(),
   body('phone').optional().trim(),
   body('role').optional().isIn(ROLE_NAMES),
   body('is_active').optional().isBoolean()],
  validate, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = req.body;
      if (id === req.user.id && (b.is_active === false || (b.role && b.role !== 'super_admin'))) {
        return res.status(400).json({ success: false, error: 'You cannot deactivate yourself or change your own role' });
      }
      const updated = await withTransaction(async (client) => {
        const current = await client.query(
          'SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [id]);
        if (!current.rows[0]) return null;
        let roleId = current.rows[0].role_id;
        if (b.role && b.role !== current.rows[0].role) {
          await ensureRoles(client);
          roleId = await getRoleId(client, b.role);
        }
        const { rows } = await client.query(
          `UPDATE users SET full_name = COALESCE($1, full_name), phone = $2,
             role_id = $3, is_active = COALESCE($4, is_active), updated_at = now()
           WHERE id = $5 RETURNING id, full_name, email, phone, is_active, last_login_at, created_at`,
          [b.full_name || null, b.phone ?? current.rows[0].phone, roleId,
           b.is_active === undefined ? null : b.is_active, id]);
        return rows[0];
      });
      if (!updated) return res.status(404).json({ success: false, error: 'User not found' });
      await logAudit({ userId: req.user.id, action: 'users.update', entityType: 'users', entityId: updated.id, newValues: updated, req });
      return res.json({ success: true, data: updated });
    } catch (err) { return next(err); }
  });

// DELETE /api/users/:id — Super Admin only. Cannot delete yourself, and
// cannot delete the last Super Admin. Linked lecturer/student rows stay
// (their user_id is set to NULL by the foreign key) — delete those
// records from the Lecturers/Students pages if they should go too.
router.delete('/:id', param('id').isInt(), validate, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
    }
    const target = await query(
      'SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [id]);
    if (!target.rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    if (target.rows[0].role === 'super_admin') {
      const count = await query(
        `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.name = 'super_admin' AND u.is_active`);
      if (count.rows[0].n <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the last active Super Admin' });
      }
    }
    const { rows } = await query('DELETE FROM users WHERE id = $1 RETURNING id, full_name, email', [id]);
    await logAudit({ userId: req.user.id, action: 'users.delete', entityType: 'users', entityId: rows[0].id, req });
    return res.json({ success: true, message: `User ${rows[0].email} deleted` });
  } catch (err) { return next(err); }
});

module.exports = router;
