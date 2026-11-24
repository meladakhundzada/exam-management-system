const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { signToken, authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { ensureRoles, getRoleId } = require('../utils/roles');

const router = express.Router();

// Linked profile ids for a user: the students/lecturers row (if any) plus
// its department. The frontend AuthContext reads student_id / lecturer_id /
// department_id off the login and /auth/me responses (AuthUser.studentId
// etc.) — without these, students could never resolve their own fees or
// results. Returns nulls when the user has no linked profile row.
async function linkedProfiles(userId) {
  const [student, lecturer] = await Promise.all([
    query('SELECT id, department_id FROM students WHERE user_id = $1', [userId]),
    query('SELECT id, department_id FROM lecturers WHERE user_id = $1', [userId]),
  ]);
  const s = student.rows[0] || null;
  const l = lecturer.rows[0] || null;
  return {
    student_id: s ? s.id : null,
    lecturer_id: l ? l.id : null,
    department_id: s ? s.department_id : (l ? l.department_id : null),
  };
}

function publicUser(row, links) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    role: row.role,
    // avatar_url holds a downscaled JPEG data URL (see PUT /auth/photo);
    // null when the user has no photo. Returned here so the UI can show
    // it without an extra call.
    avatar_url: row.avatar_url ?? null,
    student_id: links ? links.student_id : null,
    lecturer_id: links ? links.lecturer_id : null,
    department_id: links ? links.department_id : null,
  };
}

// Validate a profile-photo data URL. Accepts only JPEG/PNG/WebP images
// no larger than 200 KB, verified by magic bytes (not just the claimed
// MIME type) so a renamed non-image cannot be stored. Returns the byte
// length on success, or an error message string on failure.
const MAX_PHOTO_BYTES = 200 * 1024;
function validatePhotoDataUrl(value) {
  if (typeof value !== 'string') return 'Photo must be a data URL string';
  const m = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return 'Photo must be a JPEG, PNG or WebP image data URL';
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return 'Photo is not valid base64'; }
  if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) return 'Photo must be 200 KB or smaller';
  // Magic bytes: JPEG FF D8 FF, PNG 89 50 4E 47, WebP "RIFF....WEBP".
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.length > 11 && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP';
  const ok = (m[1] === 'jpeg' && isJpeg) || (m[1] === 'png' && isPng) || (m[1] === 'webp' && isWebp);
  if (!ok) return 'Photo content does not match its image type';
  return null;
}

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
        `SELECT u.id, u.full_name, u.email, u.password_hash, u.is_active, u.avatar_url, r.name AS role
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
      const links = await linkedProfiles(user.id);
      return res.json({ success: true, token, user: publicUser(user, links) });
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

// PUT /api/auth/photo — set the signed-in user's own profile photo.
// Body: { photo: "data:image/jpeg;base64,..." } (client-downscaled to
// at most 512px, JPEG). The photo is stored as a data URL in
// users.avatar_url — the database, not disk, because Render's free-plan
// filesystem is ephemeral and disk files vanish on restart/redeploy.
// A user can change ONLY their own photo: the row updated is always
// req.user.id, so there is no target-user parameter to abuse.
router.put(
  '/photo',
  authenticate,
  [body('photo').isString().notEmpty().withMessage('Photo data URL required')],
  validate,
  async (req, res, next) => {
    try {
      const problem = validatePhotoDataUrl(req.body.photo);
      if (problem) return res.status(400).json({ success: false, error: problem });
      await query('UPDATE users SET avatar_url = $1, updated_at = now() WHERE id = $2', [req.body.photo, req.user.id]);
      await logAudit({ userId: req.user.id, action: 'auth.photo_update', entityType: 'users', entityId: req.user.id, req });
      return res.json({ success: true, data: { avatar_url: req.body.photo } });
    } catch (err) { return next(err); }
  },
);

// DELETE /api/auth/photo — remove the signed-in user's own photo.
router.delete('/photo', authenticate, async (req, res, next) => {
  try {
    await query('UPDATE users SET avatar_url = NULL, updated_at = now() WHERE id = $1', [req.user.id]);
    await logAudit({ userId: req.user.id, action: 'auth.photo_remove', entityType: 'users', entityId: req.user.id, req });
    return res.json({ success: true, data: { avatar_url: null } });
  } catch (err) { return next(err); }
});

// GET /api/auth/me — current user + role + permissions.
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.avatar_url, r.name AS role,
              COALESCE(array_agg(p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS permissions
         FROM users u JOIN roles r ON r.id = u.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = $1 GROUP BY u.id, r.name`,
      [req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    const links = await linkedProfiles(rows[0].id);
    return res.json({ success: true, data: { ...rows[0], ...links } });
  } catch (err) { return next(err); }
});

// POST /api/auth/refresh — mint a fresh access token from the current one.
//
// Why this exists (and why it is implemented this way): the frontend
// interceptor calls POST /auth/refresh on every 401 and expects
// { data: { accessToken } } back, but the backend never issued refresh
// tokens — login returns a single stateless 8h JWT and there is no
// refresh-token table (adding one would need a migration). So instead of
// inventing a second token scheme, refresh re-issues an access token from
// the presented JWT: the token is verified (signature + still belonging to
// an active user) with expiration ignored, but only if it expired less
// than 24h ago — a token older than that must sign in again. The client
// sends the current access token in the Authorization header (the
// interceptor does this) or as body.token / body.refreshToken. A logout
// is client-side only (tokenStore.clear), so /logout below is a no-op
// success that never fails on an expired token.
router.post('/refresh', async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7)
      : (req.body?.token || req.body?.refreshToken || null);
    if (!presented) return res.status(401).json({ success: false, error: 'No token provided' });
    let decoded;
    try {
      decoded = jwt.verify(presented, process.env.JWT_SECRET || 'dev-only-change-me-in-production', { ignoreExpiration: true });
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    const expiredAgoMs = Date.now() - (decoded.exp * 1000);
    if (expiredAgoMs > 24 * 60 * 60 * 1000) {
      return res.status(401).json({ success: false, error: 'Token expired too long ago — please sign in again' });
    }
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.email, u.is_active, u.avatar_url, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [decoded.id],
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    const token = signToken(user);
    const links = await linkedProfiles(user.id);
    return res.json({ success: true, data: { accessToken: token, refreshToken: null, user: publicUser(user, links) } });
  } catch (err) { return next(err); }
});

// POST /api/auth/logout — stateless JWTs cannot be revoked server-side
// without a denylist table, so logout is the client clearing its token.
// This endpoint exists so the frontend's authApi.logout() call succeeds
// instead of 404ing; it takes no auth so it never fails on an expired token.
router.post('/logout', (req, res) => res.json({ success: true, message: 'Logged out' }));

module.exports = router;
