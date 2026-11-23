// express-validator wrapper: run the checks, then return 400 with the
// field-level errors. Every POST/PUT route uses this — server-side
// validation is mandatory even though the frontend also validates.
const { validationResult } = require('express-validator');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return res.status(400).json({
    success: false,
    error: 'Validation failed',
    details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
  });
}

// Shared pagination helper: ?page=1&limit=20&search=…&sort=…&order=asc|desc
// Returns { page, limit, offset }. Callers whitelist their own sort columns.
function pagination(req, defaults = { page: 1, limit: 20 }) {
  const page = Math.max(1, parseInt(req.query.page, 10) || defaults.page);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || defaults.limit));
  return { page, limit, offset: (page - 1) * limit };
}

function paginatedResponse(rows, total, { page, limit }) {
  return {
    success: true,
    data: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// Central error handler (mounted last in server.js).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err);
  // Postgres unique-violation → 409, FK violation → 400, everything else 500.
  if (err.code === '23505') {
    return res.status(409).json({ success: false, error: 'Duplicate record: a record with this unique value already exists', detail: err.detail });
  }
  if (err.code === '23503') {
    return res.status(400).json({ success: false, error: 'Referenced record does not exist', detail: err.detail });
  }
  if (err.code === '23514') {
    return res.status(400).json({ success: false, error: 'Value violates a database constraint', detail: err.detail });
  }
  return res.status(err.status || 500).json({ success: false, error: err.message || 'Internal server error' });
}

module.exports = { validate, pagination, paginatedResponse, errorHandler };
