// PostgreSQL connection pool. All queries in routes use parameterized
// statements ($1, $2, …) through this pool — never string-concatenated SQL.
const { Pool } = require('pg');

if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
  throw new Error('DATABASE_URL is required in production');
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/exam_management',
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
// Hosted PostgreSQL (e.g. Render) requires SSL. Enable it whenever the
// connection string asks for it (sslmode=require) instead of hard-coding
// it, so local Docker / localhost development keeps working unchanged.
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on('error', (err) => console.error('[pg] idle client error', err));

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.LOG_QUERIES === '1') {
    console.log('[sql]', `${Date.now() - start}ms`, text.slice(0, 120));
  }
  return res;
}

// Run fn(client) inside a transaction; rolls back on any error.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
