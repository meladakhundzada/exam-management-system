// JWT authentication + role-based access control (RBAC).
// Token payload: { id, email, role, full_name } — signed with JWT_SECRET,
// expires in JWT_EXPIRES_IN (default 8h). Role names come from roles.name:
// super_admin | exam_officer | lecturer | student.
//
// JWT_SECRET hygiene: in production the server refuses to start without
// an explicit JWT_SECRET — there is NO fallback secret in production.
// In development only, a clearly-marked dev fallback is used so the app
// can run locally without configuration; it must never be used with
// real data. routes/auth.js imports JWT_SECRET from here instead of
// carrying its own inline fallback.
const jwt = require('jsonwebtoken');

const DEV_FALLBACK_SECRET = 'dev-only-change-me-in-production';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production (no fallback secret is used in production)');
}

const JWT_SECRET = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;

if (!process.env.JWT_SECRET) {
  // Reached only outside production (production throws above).
  console.warn('[auth] WARNING: JWT_SECRET is not set — using a development-only fallback secret. Never use this in production.');
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

// requireRole('super_admin', 'exam_officer') — 403 unless req.user.role matches.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: `Forbidden: requires ${roles.join(' or ')}` });
    }
    return next();
  };
}

// Optional permission check against role_permissions (used where a route
// needs finer granularity than role alone). Requires a DB lookup.
const { query } = require('../config/db');
function requirePermission(permissionName) {
  return async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT 1 FROM role_permissions rp
            JOIN roles r ON r.id = rp.role_id
            JOIN permissions p ON p.id = rp.permission_id
          WHERE r.name = $1 AND p.name = $2 LIMIT 1`,
        [req.user.role, permissionName],
      );
      if (!rows.length) return res.status(403).json({ success: false, error: `Forbidden: missing permission ${permissionName}` });
      return next();
    } catch (err) { return next(err); }
  };
}

module.exports = { signToken, authenticate, requireRole, requirePermission, JWT_SECRET };
