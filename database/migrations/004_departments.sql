-- ============================================================================
-- University Examination Department Management System
-- Migration 004 — The five real departments (faculties + departments)
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f 004_departments.sql
-- Idempotent: safe to run more than once. Run AFTER 001_init.sql.
--   npm run migrate:schema   (runs 001_init.sql + 003_fees.sql + 004_departments.sql)
--   run.bat (Windows)        (same three files)
--
-- The live database was never seeded, so it holds zero faculties and zero
-- departments — and without a department, no lecturer or student account
-- can be created (department_id is required for those roles). This file
-- creates the five departments the university actually needs, under
-- their faculties. Faculty/department codes match the 002 seed file
-- where they overlap (FOCS/CS, FOBE/ECON), so running the full seed
-- later will not create duplicates.
-- No login accounts are created by this migration.
-- ============================================================================

BEGIN;

-- Faculties (insert only if the code does not exist yet).
INSERT INTO faculties (name, code) VALUES
  ('Faculty of Computer Science', 'FOCS'),
  ('Faculty of Business & Economics', 'FOBE'),
  ('Faculty of Journalism', 'FOJ'),
  ('Faculty of Social Sciences', 'FOSS')
ON CONFLICT (code) DO NOTHING;

-- Departments (insert only if the code does not exist yet).
-- Lecturer Irfan (Eng Irfan, LEC-007) belongs to Computer Science.
INSERT INTO departments (faculty_id, name, code) VALUES
  ((SELECT id FROM faculties WHERE code = 'FOCS'), 'Computer Science', 'CS'),
  ((SELECT id FROM faculties WHERE code = 'FOBE'), 'Economics', 'ECON'),
  ((SELECT id FROM faculties WHERE code = 'FOJ'), 'Journalism', 'JOUR'),
  ((SELECT id FROM faculties WHERE code = 'FOSS'), 'Political Science', 'POLS'),
  ((SELECT id FROM faculties WHERE code = 'FOSS'), 'International Relations', 'IR')
ON CONFLICT (code) DO NOTHING;

COMMIT;
