// University Examination Department Management System — API server.
// Run:  npm start  (or: npm run dev).  Requires DATABASE_URL (see README.md).
// Health check: GET /api/health  →  { success: true, status: 'ok' }
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { pool } = require('./config/db');
const { errorHandler } = require('./middleware/validate');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' })); // rejects oversized bodies
app.use(express.urlencoded({ extended: false }));

// Health check (no auth) — used by uptime monitors and `npm run` smoke tests.
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ success: false, status: 'error', db: 'unreachable' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/students', require('./routes/students'));
app.use('/api/lecturers', require('./routes/lecturers'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/marks', require('./routes/marks'));
app.use('/api/results', require('./routes/results'));
app.use('/api/fees', require('./routes/fees'));
app.use('/api/users', require('./routes/users'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/departments', require('./routes/departments'));
app.use('/api/reports', require('./routes/reports'));

// Reference data used by the frontend forms (faculties, departments,
// academic years, semesters, subjects, grade scales). Read-only for staff,
// readable by any authenticated user.
const { query } = require('./config/db');
const { authenticate } = require('./middleware/auth');
app.get('/api/reference', authenticate, async (req, res, next) => {
  try {
    const [faculties, departments, years, semesters, subjects] = await Promise.all([
      query('SELECT * FROM faculties ORDER BY name'),
      query('SELECT d.*, f.name AS faculty_name FROM departments d JOIN faculties f ON f.id = d.faculty_id ORDER BY d.name'),
      query('SELECT * FROM academic_years ORDER BY start_date DESC'),
      query('SELECT s.*, ay.name AS academic_year FROM semesters s JOIN academic_years ay ON ay.id = s.academic_year_id ORDER BY s.start_date DESC'),
      query('SELECT sub.*, d.name AS department_name, t.full_name AS lecturer_name FROM subjects sub JOIN departments d ON d.id = sub.department_id LEFT JOIN lecturers t ON t.id = sub.lecturer_id ORDER BY sub.code'),
    ]);
    res.json({ success: true, data: { faculties: faculties.rows, departments: departments.rows, academic_years: years.rows, semesters: semesters.rows, subjects: subjects.rows } });
  } catch (err) { next(err); }
});

app.use((req, res) => res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` }));
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`[exam-api] listening on http://localhost:${PORT}  (env: ${process.env.NODE_ENV || 'development'})`);
});

process.on('SIGTERM', () => server.close(() => pool.end()));
process.on('SIGINT', () => server.close(() => pool.end()));

module.exports = app;
