// Departments & faculties — the reference data the whole system depends
// on. There was no departments route at all: /departments was a frontend
// placeholder, and the Users form loaded its department list from
// GET /api/reference, so on an unseeded database the dropdown was empty
// and a lecturer/student account could never be created (department_id
// is required for those roles). These endpoints let a Super Admin (or
// Exam Officer) create the first department even when the database holds
// zero faculties and zero departments.
const express = require('express');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/departments — every authenticated user: forms need the list.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, f.name AS faculty_name, f.code AS faculty_code
         FROM departments d JOIN faculties f ON f.id = d.faculty_id
        ORDER BY d.name`,
    );
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// GET /api/departments/faculties — faculty list for the department form.
router.get('/faculties', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM faculties ORDER BY name');
    return res.json({ success: true, data: rows });
  } catch (err) { return next(err); }
});

// Derive a faculty code from its name, e.g. "Faculty of Business &
// Economics" -> "FBE". Only a fallback when the caller gives no code.
function deriveFacultyCode(name) {
  const words = name.split(/[^A-Za-z]+/).filter((w) => w && !/^(of|and|the)$/i.test(w));
  return words.map((w) => w[0].toUpperCase()).join('').slice(0, 10) || 'FAC';
}

// Find a faculty by code (or create it), inside the caller's transaction.
// Used when the department form names a faculty that does not exist yet.
async function findOrCreateFaculty(client, name, code) {
  const wanted = (code || deriveFacultyCode(name)).toUpperCase();
  const existing = await client.query(
    'SELECT * FROM faculties WHERE code = $1 OR name = $2', [wanted, name]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await client.query(
    'INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING *',
    [name, wanted]);
  return created.rows[0];
}

const createValidators = [
  body('name').trim().notEmpty().withMessage('Department name is required'),
  body('code').trim().notEmpty().withMessage('Department code is required')
    .isLength({ max: 20 }).withMessage('Department code is at most 20 characters'),
  body('faculty_id').optional().isInt({ min: 1 }),
  body('faculty_name').optional().trim(),
  body('faculty_code').optional().trim(),
  body('head_name').optional().trim(),
  body('description').optional().trim(),
];

// POST /api/departments — create a department. The faculty can be picked
// (faculty_id), named (faculty_name + optional faculty_code — created if
// it does not exist), or omitted entirely: then the department is put
// under the default "Faculty of Computer Science" (FOCS, as in the seed),
// created on the fly if the database was never seeded. That is what
// makes the very first department creatable on an empty database.
router.post('/', requireRole('super_admin', 'exam_officer'), createValidators, validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      const result = await withTransaction(async (client) => {
        let faculty;
        if (b.faculty_id) {
          const found = await client.query('SELECT * FROM faculties WHERE id = $1', [b.faculty_id]);
          if (!found.rows[0]) {
            throw Object.assign(new Error('Faculty not found'), { status: 400 });
          }
          faculty = found.rows[0];
        } else if (b.faculty_name) {
          faculty = await findOrCreateFaculty(client, b.faculty_name, b.faculty_code);
        } else {
          faculty = await findOrCreateFaculty(client, 'Faculty of Computer Science', 'FOCS');
        }
        const { rows } = await client.query(
          `INSERT INTO departments (faculty_id, name, code, head_name, description)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [faculty.id, b.name, b.code.toUpperCase(), b.head_name || null, b.description || null]);
        return { ...rows[0], faculty_name: faculty.name, faculty_code: faculty.code };
      });
      await logAudit({ userId: req.user.id, action: 'departments.create', entityType: 'departments', entityId: result.id, newValues: result, req });
      return res.status(201).json({ success: true, data: result, message: 'Department created.' });
    } catch (err) { return next(err); }
  });

// DELETE /api/departments/:id — Super Admin only. Fails with a 400 if
// lecturers, students or subjects still reference the department.
router.delete('/:id', requireRole('super_admin'), param('id').isInt(), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'DELETE FROM departments WHERE id = $1 RETURNING id, name, code', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Department not found' });
      await logAudit({ userId: req.user.id, action: 'departments.delete', entityType: 'departments', entityId: rows[0].id, req });
      return res.json({ success: true, message: `Department ${rows[0].name} deleted` });
    } catch (err) { return next(err); }
  });

module.exports = router;
