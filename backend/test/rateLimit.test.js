// Tests for the in-memory rate limiter + login lockout
// (backend/src/middleware/rateLimit.js). Pure logic — no database needed.
// Run: node --test test/   (from backend/)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, loginLockout } = require('../src/middleware/rateLimit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
  return res;
}

test('rate limiter allows up to max requests, then answers 429 with Retry-After', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, message: 'Slow down' });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  const req = { ip: '10.0.0.1' };

  limiter(req, mockRes(), next);
  limiter(req, mockRes(), next);
  assert.equal(nextCalls, 2);

  const res = mockRes();
  limiter(req, res, next);
  assert.equal(nextCalls, 2, 'third request must not reach next()');
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /Slow down/);
  assert.ok(res.headers['Retry-After'], 'Retry-After header is set');
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('rate limiter buckets are per IP', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  limiter({ ip: '10.0.0.1' }, mockRes(), next);
  limiter({ ip: '10.0.0.2' }, mockRes(), next);
  assert.equal(nextCalls, 2, 'a different IP gets its own bucket');
});

test('rate limiter window resets after windowMs', async () => {
  const limiter = createRateLimiter({ windowMs: 50, max: 1 });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  limiter({ ip: '10.0.0.9' }, mockRes(), next);
  limiter({ ip: '10.0.0.9' }, mockRes(), next);
  assert.equal(nextCalls, 1);
  await sleep(70);
  limiter({ ip: '10.0.0.9' }, mockRes(), next);
  assert.equal(nextCalls, 2, 'requests are allowed again after the window');
});

test('login lockout: 5 failures lock the account, fewer do not', () => {
  const email = 'lockout-test@example.com';
  loginLockout.resetLoginAttempts(email);
  assert.equal(loginLockout.isLockedOut(email), false);
  for (let i = 0; i < 4; i++) {
    loginLockout.recordFailedLogin(email);
    assert.equal(loginLockout.isLockedOut(email), false, `not locked after ${i + 1} failures`);
  }
  loginLockout.recordFailedLogin(email);
  assert.equal(loginLockout.isLockedOut(email), true, 'locked after 5 failures');
  assert.ok(loginLockout.lockoutRemainingMs(email) > 0, 'remaining lockout time is reported');
  assert.equal(loginLockout.isLockedOut('other@example.com'), false, 'lockout is per account');
  loginLockout.resetLoginAttempts(email);
  assert.equal(loginLockout.isLockedOut(email), false, 'a successful login clears the lockout');
});

test('login lockout email matching is case-insensitive', () => {
  const email = 'Case-Test@Example.com';
  loginLockout.resetLoginAttempts(email);
  for (let i = 0; i < 5; i++) loginLockout.recordFailedLogin(email.toUpperCase());
  assert.equal(loginLockout.isLockedOut(email.toLowerCase()), true);
  loginLockout.resetLoginAttempts(email);
});
