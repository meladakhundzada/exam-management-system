// In-memory rate limiting + login lockout.
//
// express-rate-limit is NOT installed, so this is a small dependency-free
// limiter (fixed window per key). It is deliberately simple: state lives
// in process memory, so limits reset on restart and are per-process, not
// shared across instances. That is fine for this deployment (single
// Render instance) and far better than no limiting at all.
//
// Wiring (server.js — coordinator owns that file, these lines are NOT
// applied here):
//   const { apiLimiter } = require('./middleware/rateLimit');
//   app.use('/api', apiLimiter);            // after express.json(), before routes
// The auth limiter is applied per-route inside routes/auth.js (login,
// setup-first-admin, refresh) so it needs no server.js change.
// NOTE: per-IP limiting keys on req.ip. Behind a proxy (Render) set
// `app.set('trust proxy', 1)` in server.js, otherwise every client looks
// like the same proxy IP and shares one bucket.

function createRateLimiter({ windowMs, max, message }) {
  // key -> { count, resetAt }
  const buckets = new Map();

  // Drop expired buckets so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  // Don't keep the event loop alive for this housekeeping timer.
  if (typeof sweep.unref === 'function') sweep.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: message || 'Too many requests — please try again later',
        retry_after_seconds: retryAfter,
      });
    }
    return next();
  };
}

// Brute-force protection for the auth endpoints that take credentials
// (login, setup-first-admin, refresh): 10 attempts per IP per 15 min.
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many sign-in attempts — please wait 15 minutes and try again',
});

// General API limiter: 300 requests per IP per 15 min. Generous on
// purpose — normal UI use is far below this; it exists to blunt floods
// and runaway scripts, not to punish real users.
const apiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests — please slow down and try again shortly',
});

// ---- Account lockout -------------------------------------------------------
// In-memory failed-login tracking, keyed by normalised email. After
// MAX_FAILED_LOGINS consecutive failures the account cannot sign in for
// LOCKOUT_MS, even with the right password — this stops password
// guessing against one account from many IPs (the IP limiter above only
// stops guessing from one IP). Like the limiter, this state resets on
// restart; that is acceptable here because the IP limiter still applies
// and a restart is rare. Used by routes/auth.js login.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// email -> { failures, lockedUntil }
const loginAttempts = new Map();

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isLockedOut(email) {
  const rec = loginAttempts.get(normaliseEmail(email));
  return Boolean(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
}

function lockoutRemainingMs(email) {
  const rec = loginAttempts.get(normaliseEmail(email));
  if (!rec || !rec.lockedUntil) return 0;
  return Math.max(0, rec.lockedUntil - Date.now());
}

function recordFailedLogin(email) {
  const key = normaliseEmail(email);
  const rec = loginAttempts.get(key) || { failures: 0, lockedUntil: null };
  rec.failures += 1;
  if (rec.failures >= MAX_FAILED_LOGINS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.failures = 0; // failures reset once the lockout starts
  }
  loginAttempts.set(key, rec);
  return rec;
}

function resetLoginAttempts(email) {
  loginAttempts.delete(normaliseEmail(email));
}

const loginLockout = {
  MAX_FAILED_LOGINS,
  LOCKOUT_MS,
  isLockedOut,
  lockoutRemainingMs,
  recordFailedLogin,
  resetLoginAttempts,
};

module.exports = { createRateLimiter, authLimiter, apiLimiter, loginLockout };
