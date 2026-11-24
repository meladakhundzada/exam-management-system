const express = require('express');
const bcrypt = require('bcryptjs');
const { body } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { signToken, authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { ensureRoles, getRoleId } = require('../utils/roles');

const router = express.Router();

// POST /api/auth/login — any role. Returns { token, user }.
// Rate-limit this route in production (e.g. express-rate-limit).
router.post(
  '/login',
  [body('email').isEmail().withMessage('Valid email required'),
   body('password').notEmpty().withMessage('Password required')],
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const { rows } = await query(
        `SELECT u.id, u.full_name, u.email, u.password_hash, u.is_active, r.name AS role
           FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`,
        [email.toLowerCase()],
      );
      const user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }
      if (!(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }
      await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await logAudit({ userId: user.id, action: 'auth.login', entityType: 'users', entityId: user.id, req });
      const token = signToken(user);
      return res.json({ success: true, token, user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
    } catch (err) { return next(err); }
  },
);

// POST /api/auth/setup-first-admin — one-time bootstrap. Only works when
// NO users exist yet; afterwards it returns 403. Use this in production
// instead of the seeded demo admin, then delete/rotate the demo account.
router.post(
  '/setup-first-admin',
  [body('full_name').trim().notEmpty(), body('email').isEmail(),
   body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')],
  validate,
  async (req, res, next) => {
    try {
      const { full_name, email, password } = req.body;
      // One-time guard + role seeding + insert in one transaction. The
      // roles table is empty on a database that ran 001_init.sql without
      // the 002 seed, so ensureRoles() first inserts the standard roles
      // (super_admin, exam_officer, lecturer, student); without it the
      // old `(SELECT id FROM roles ...)` subselect returned NULL and the
      // users.role_id NOT NULL constraint failed.
      const created = await withTransaction(async (client) => {
        const count = await client.query('SELECT count(*)::int AS n FROM users');
        if (count.rows[0].n > 0) return null;
        await ensureRoles(client);
        const roleId = await getRoleId(client, 'super_admin');
        const hash = await bcrypt.hash(password, 10);
        const { rows } = await client.query(
          `INSERT INTO users (role_id, full_name, email, password_hash)
           VALUES ($1, $2, $3, $4) RETURNING id, full_name, email`,
          [roleId, full_name, email.toLowerCase(), hash],
        );
        return rows[0];
      });
      if (!created) {
        return res.status(403).json({ success: false, error: 'Setup already completed: users exist' });
      }
      return res.status(201).json({ success: true, data: created });
    } catch (err) { return next(err); }
  },
);

// POST /api/auth/change-password — logged-in user, old password required.
router.post(
  '/change-password',
  authenticate,
  [body('current_password').notEmpty(), body('new_password').isLength({ min: 8 })],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0] || !(await bcrypt.compare(req.body.current_password, rows[0].password_hash))) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
      }
      const hash = await bcrypt.hash(req.body.new_password, 10);
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
      await logAudit({ userId: req.user.id, action: 'auth.change_password', entityType: 'users', entityId: req.user.id, req });
      return res.json({ success: true, message: 'Password changed' });
    } catch (err) { return next(err); }
  },
);

// GET /api/auth/me — current user + role + permissions.
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.email, u.phone, r.name AS role,
              COALESCE(array_agg(p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS permissions
         FROM users u JOIN roles r ON r.id = u.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = $1 GROUP BY u.id, r.name`,
      [req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { return next(err); }
});

module.exports = router;
