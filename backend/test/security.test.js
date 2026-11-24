// Tests for the security fixes: refresh-token hashing, admit-card QR
// payload, PDF column layout, and the JWT-secret startup guard.
// Pure logic — no database needed. Run: node --test test/ (from backend/)
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const authRoutes = require('../src/routes/auth');
const reports = require('../src/routes/reports');

test('refresh-token hash is a deterministic SHA-256 hex digest', () => {
  const h1 = authRoutes.hashRefreshToken('token-abc');
  const h2 = authRoutes.hashRefreshToken('token-abc');
  const h3 = authRoutes.hashRefreshToken('token-abd');
  assert.equal(h1, h2, 'same token hashes the same way');
  assert.notEqual(h1, h3, 'different tokens hash differently');
  assert.match(h1, /^[0-9a-f]{64}$/, '64 hex characters');
  assert.equal(authRoutes.REFRESH_TOKEN_TTL_MS, 7 * 24 * 60 * 60 * 1000, '7-day refresh lifetime');
});

test('admit-card reference is deterministic and exam-specific', () => {
  const a = reports.buildAdmitCardRef('STU-2026-001', 2);
  const b = reports.buildAdmitCardRef('STU-2026-001', 2);
  const c = reports.buildAdmitCardRef('STU-2026-001', 3);
  const d = reports.buildAdmitCardRef('STU-2026-002', 2);
  assert.equal(a, b, 'same student + exam gives the same reference');
  assert.notEqual(a, c, 'different exam gives a different reference');
  assert.notEqual(a, d, 'different student gives a different reference');
  assert.match(a, /^ADM-STU-2026-001-2-[0-9A-F]{8}$/);
});

test('admit-card QR payload is JSON with the verification reference', () => {
  const ref = reports.buildAdmitCardRef('STU-2026-001', 2);
  const payload = JSON.parse(reports.buildAdmitCardPayload({
    ref, studentCode: 'STU-2026-001', studentName: 'Test Student', examId: 2,
  }));
  assert.equal(payload.type, 'admit-card');
  assert.equal(payload.ref, ref);
  assert.equal(payload.student_id, 'STU-2026-001');
  assert.equal(payload.student_name, 'Test Student');
  assert.equal(payload.exam_id, 2);
});

test('PDF column widths fill the page and stay readable', () => {
  const headers = ['ID', 'Name', 'Email', 'Department', 'Semester', 'Status'];
  const rows = [['STU-1', 'A very long student name here', 'student@example.com', 'Computer Science', '1', 'active']];
  const widths = reports.computeColumnWidths(headers, rows, 515);
  assert.equal(widths.length, headers.length);
  const total = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 515) < 1, `widths sum to the page width (got ${total})`);
  widths.forEach((w) => assert.ok(w >= 42, `no column narrower than 42pt (got ${w})`));
});

test('JWT secret: production without JWT_SECRET refuses to start', () => {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.JWT_SECRET;
  const res = spawnSync(
    process.execPath,
    ['-e', "require('./src/middleware/auth')"],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' },
  );
  assert.notEqual(res.status, 0, 'process must exit non-zero');
  assert.match(res.stderr, /JWT_SECRET must be set in production/);
});

test('JWT secret: production with JWT_SECRET starts fine', () => {
  // DATABASE_URL is a dummy: db.js also requires it in production, but
  // the pool only connects on first query, so a dummy value is enough to
  // prove the auth module itself loads.
  const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'test-secret-for-unit-test', DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb' };
  const res = spawnSync(
    process.execPath,
    ['-e', "require('./src/middleware/auth'); console.log('ok')"],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, `should start, stderr: ${res.stderr}`);
  assert.match(res.stdout, /ok/);
});
