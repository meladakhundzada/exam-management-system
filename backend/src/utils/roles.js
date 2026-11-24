// System roles — names and descriptions must match
// database/migrations/002_seed.sql exactly, except 'finance', which
// lives only here: 002_seed.sql is never run in production, so
// ensureRoles() below is the source of truth that creates it.
//
// Why this helper exists: 001_init.sql creates the roles table but seeds
// NO rows; the roles only exist if 002_seed.sql was run. The live database
// ran 001 only (the seed is deliberately never run in production), so its
// roles table is empty. Every user-creation path used to set role_id with
// `(SELECT id FROM roles WHERE name='...')`, which returns NULL on an
// empty roles table — and users.role_id is NOT NULL, so the insert failed
// with: null value in column "role_id" of relation "users" violates
// not-null constraint. Call ensureRoles() inside the same transaction
// before inserting a user, then use getRoleId() for an explicit id.
const SYSTEM_ROLES = [
  ['super_admin', 'Full access to the entire system'],
  ['exam_officer', 'Manages students, exams, schedules, rooms, attendance, results'],
  ['finance', 'Manages fee types, student fees, payments and fee reports'],
  ['lecturer', 'Views assigned subjects/students, enters marks'],
  ['student', 'Views profile, timetable, admit card, published results'],
];

async function ensureRoles(client) {
  for (const [name, description] of SYSTEM_ROLES) {
    await client.query(
      `INSERT INTO roles (name, description, is_system) VALUES ($1, $2, TRUE)
       ON CONFLICT (name) DO NOTHING`,
      [name, description],
    );
  }
}

async function getRoleId(client, name) {
  const { rows } = await client.query('SELECT id FROM roles WHERE name = $1', [name]);
  if (!rows[0]) throw new Error(`Role not found: ${name}`);
  return rows[0].id;
}

module.exports = { SYSTEM_ROLES, ensureRoles, getRoleId };
