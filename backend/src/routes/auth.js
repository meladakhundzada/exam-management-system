const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { body } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { signToken, authenticate } = require('../middleware/auth');
const { authLimiter, loginLockout } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');
const { ensureRoles, getRoleId } = require('../utils/roles');

const router = express.Router();

// ---- Refresh tokens --------------------------------------------------------
// A refresh token is a random 48-byte value. Only its SHA-256 hash is
// stored (table refresh_tokens, migration 011) — a database leak never
// exposes a usable token. Lifetime: 7 days. Every refresh ROTATES the
// token: the old row is revoked and a new token is issued, so a stolen
// token is useful at most once (reuse of a revoked token is rejected and
// revokes the whole chain for that user — see /refresh below).
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Issue + store a refresh token for a user. Returns the raw token, or
// null when the refresh_tokens table does not exist yet (migration 011
// not run): login must keep working in that case, so the caller falls
// back to access-token-only auth and the missing migration is logged.
async function issueRefreshToken(userId, req) {
  const raw = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  try {
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, hashRefreshToken(raw), expiresAt.toISOString(),
       req?.headers?.['user-agent']?.slice(0, 255) || null, req?.ip || null],
    );
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[auth] refresh_tokens table missing — run migration 011_refresh_tokens.sql; continuing without a refresh token');
      return null;
    }
    throw err;
  }
  return raw;
}

// Revoke every live refresh token for a user (used on password change and
// on logout-all). Missing table (42P01) is not an error — nothing to revoke.
async function revokeAllRefreshTokens(userId) {
  try {
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  } catch (err) {
    if (err.code === '42P01') return;
    throw err;
  }
}

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

// POST /api/auth/login — any role. Returns { token, refresh_token, user }.
// Rate-limited per IP (authLimiter) and locked out per account after 5
// consecutive failures (loginLockout): a locked-out account gets 423 even
// with the right password, for 15 minutes.
router.post(
  '/login',
  authLimiter,
  [body('email').isEmail().withMessage('Valid email required'),
   body('password').notEmpty().withMessage('Password required')],
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (loginLockout.isLockedOut(email)) {
        const waitMin = Math.ceil(loginLockout.lockoutRemainingMs(email) / 60000);
        return res.status(423).json({ success: false, error: `Account temporarily locked after too many failed sign-in attempts — try again in about ${waitMin} minute(s)` });
      }
      const { rows } = await query(
        `SELECT u.id, u.full_name, u.email, u.password_hash, u.is_active, u.avatar_url, r.name AS role
           FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`,
        [email.toLowerCase()],
      );
      const user = rows[0];
      if (!user || !user.is_active) {
        loginLockout.recordFailedLogin(email);
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }
      if (!(await bcrypt.compare(password, user.password_hash))) {
        loginLockout.recordFailedLogin(email);
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }
      loginLockout.resetLoginAttempts(email);
      await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await logAudit({ userId: user.id, action: 'auth.login', entityType: 'users', entityId: user.id, req });
      const token = signToken(user);
      const refreshToken = await issueRefreshToken(user.id, req);
      const links = await linkedProfiles(user.id);
      return res.json({ success: true, token, refresh_token: refreshToken, user: publicUser(user, links) });
    } catch (err) { return next(err); }
  },
);

// POST /api/auth/setup-first-admin — one-time bootstrap. Only works when
// NO users exist yet; afterwards it returns 403. Use this in production
// instead of the seeded demo admin, then delete/rotate the demo account.
router.post(
  '/setup-first-admin',
  authLimiter,
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
      // A password change invalidates every existing session: all refresh
      // tokens are revoked, so a stolen token cannot survive the change.
      await revokeAllRefreshTokens(req.user.id);
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

// POST /api/auth/refresh — rotate a refresh token into a fresh pair.
//
// Body: { refreshToken } (the frontend interceptor sends the stored
// refresh token; { refresh_token } is accepted too). The presented token
// must exist in refresh_tokens, be unrevoked and unexpired, and belong
// to an active user. Rotation is atomic: the old row is revoked and the
// new token is inserted in one transaction, and the new row records which
// token it replaced. Reusing an already-revoked token is treated as
// possible theft: every live refresh token for that user is revoked and
// the client must sign in again.
// The old behaviour — re-issuing an access token from an expired access
// token — is gone: it could not be revoked, so logout was client-side only.
router.post('/refresh', authLimiter, async (req, res, next) => {
  try {
    const presented = req.body?.refreshToken || req.body?.refresh_token || null;
    if (!presented) return res.status(401).json({ success: false, error: 'No refresh token provided' });
    const { rows } = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.replaced_by_id,
              u.id AS uid, u.full_name, u.email, u.is_active, u.avatar_url, r.name AS role
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE rt.token_hash = $1`,
      [hashRefreshToken(presented)],
    );
    const rec = rows[0];
    if (!rec) return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    if (rec.revoked_at) {
      // Reuse of a revoked token: possible theft — revoke the whole chain
      // so every token issued to this user stops working.
      await revokeAllRefreshTokens(rec.user_id);
      return res.status(401).json({ success: false, error: 'Refresh token was already used — please sign in again' });
    }
    if (new Date(rec.expires_at) <= new Date()) {
      return res.status(401).json({ success: false, error: 'Refresh token expired — please sign in again' });
    }
    if (!rec.is_active) {
      return res.status(401).json({ success: false, error: 'Account is inactive' });
    }
    const user = { id: rec.uid, full_name: rec.full_name, email: rec.email, role: rec.role, avatar_url: rec.avatar_url };
    const newRefreshToken = await withTransaction(async (client) => {
      const raw = crypto.randomBytes(48).toString('hex');
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
      const { rows: ins } = await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [rec.user_id, hashRefreshToken(raw), expiresAt.toISOString(),
         req.headers?.['user-agent']?.slice(0, 255) || null, req.ip || null],
      );
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = $1 WHERE id = $2',
        [ins[0].id, rec.id],
      );
      return raw;
    });
    const token = signToken(user);
    const links = await linkedProfiles(user.id);
    return res.json({ success: true, data: { accessToken: token, refreshToken: newRefreshToken, user: publicUser(user, links) } });
  } catch (err) { return next(err); }
});

// POST /api/auth/logout — revoke the presented refresh token server-side,
// so it can never be used to mint a new access token again. The client
// still clears its stored tokens. Takes no auth and never fails on an
// expired access token; a missing/invalid refresh token is a no-op
// success (there is nothing to revoke).
router.post('/logout', async (req, res, next) => {
  try {
    const presented = req.body?.refreshToken || req.body?.refresh_token || null;
    if (presented) {
      await query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
        [hashRefreshToken(presented)],
      );
    }
    return res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    if (err.code === '42P01') return res.json({ success: true, message: 'Logged out' });
    return next(err);
  }
});

// POST /api/auth/logout-all — revoke every refresh token for the signed-in
// user (sign out on all devices). Access tokens already issued still live
// until they expire (max 8h, JWT_EXPIRES_IN), but no new one can be minted.
router.post('/logout-all', authenticate, async (req, res, next) => {
  try {
    await revokeAllRefreshTokens(req.user.id);
    await logAudit({ userId: req.user.id, action: 'auth.logout_all', entityType: 'users', entityId: req.user.id, req });
    return res.json({ success: true, message: 'Signed out on all devices' });
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports.hashRefreshToken = hashRefreshToken;
module.exports.REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_MS;
