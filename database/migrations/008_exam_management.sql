-- ============================================================================
-- University Examination Department Management System
-- Migration 008 — Exam management gaps: registrations, invigilator
-- assignments, incident reports, per-student seating
-- PostgreSQL 14+  |  UTF-8
-- Run AFTER 001_init.sql (it references examinations, exam_schedules,
-- students, lecturers, users, exam_rooms and enrollments).
--   psql "$DATABASE_URL" -f 008_exam_management.sql
-- Idempotent: safe to run more than once (CREATE TABLE IF NOT EXISTS,
-- CREATE UNIQUE INDEX IF NOT EXISTS, DO blocks, ON CONFLICT DO NOTHING).
-- Creates no login accounts and seeds no rows.
--
-- Design notes / assumptions (configurable, not official policy):
-- * Registration is STAFF-ONLY (super_admin / exam_officer, plus a
--   lecturer for exams containing one of their own subjects). Students
--   do NOT self-register: self-registration would let a student
--   register for an exam whose subjects they are not enrolled in, and
--   there is no payment / eligibility gate to check against yet. If
--   self-registration is ever wanted, add it as a separate, explicit
--   decision with an eligibility check (enrolled in a scheduled
--   subject of the exam).
-- * A registration is one row per (exam, student). Status flow:
--   registered -> cancelled. Re-registering a cancelled row flips it
--   back to 'registered' (the API upserts on the unique key) instead
--   of creating a duplicate row.
-- * Bulk registration registers only ACTIVE students who are enrolled
--   (status 'enrolled') in at least one subject scheduled in the exam.
--   That is the eligibility rule: a department/admission-year/semester
--   filter only narrows the candidate set, it never registers a
--   student with no scheduled subject in the exam.
-- * Invigilators: today the system has NO 'invigilator' role — the
--   existing room_allocations.invigilator_id points at lecturers(id),
--   and lecturers are the people who invigilate. invigilator_assignments
--   therefore accepts EITHER a lecturer_id (the path used today) OR a
--   user_id (for a future user whose role is 'invigilator' or
--   'lecturer'), exactly one of them, enforced by a CHECK. This
--   migration also inserts the 'invigilator' role row (ON CONFLICT DO
--   NOTHING) so that user can be created later; it creates no user.
--   NOTE: backend/src/utils/roles.js SYSTEM_ROLES does not list
--   'invigilator' yet — the coordinator should add it there so
--   ensureRoles() keeps the row present. Until then the row inserted
--   here is the only source of the role.
-- * Incidents: type misconduct / absence / other. reported_by is the
--   signed-in user (staff, or the lecturer/invigilator assigned to the
--   session). Status flow: open -> under_review -> resolved. Only
--   staff may change status; the reporting invigilator sees only the
--   incidents they reported, staff see all incidents for a schedule.
-- * Seating: one seat per (schedule, student), seat_number unique per
--   schedule (UNIQUE (exam_schedule_id, seat_number)). A seat may only
--   be assigned to a student REGISTERED for the exam (enforced by the
--   API; the DB cannot express "registered for the parent exam" as a
--   plain FK, so the API checks exam_registrations before inserting).
--   The API also refuses to assign more seats than the schedule's
--   total allocated seat_capacity (sum over room_allocations), when
--   allocations exist.
-- * Conflict detection itself lives in the API (backend/src/routes/
--   exams.js), not as DB triggers: the overlap rules need the
--   enrolment/registration graph, which is clearer — and its error
--   messages more specific — in application code. The UNIQUE
--   constraints below are the backstop, not the check.
-- No login accounts are created by this migration.
-- ============================================================================

BEGIN;

-- 'invigilator' role row (see header: no users are created here).
INSERT INTO roles (name, description, is_system)
VALUES ('invigilator', 'Invigilates examination sessions they are assigned to', TRUE)
ON CONFLICT (name) DO NOTHING;

-- --------------------------------------------------------------------------
-- 1. exam_registrations — a student registered for an examination.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_registrations (
  id            SERIAL PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'registered'
                CHECK (status IN ('registered','cancelled')),
  registered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_registrations_unique UNIQUE (exam_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_registrations_exam    ON exam_registrations(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_registrations_student ON exam_registrations(student_id);
CREATE INDEX IF NOT EXISTS idx_exam_registrations_status  ON exam_registrations(status);

-- --------------------------------------------------------------------------
-- 2. invigilator_assignments — an invigilator assigned to one session.
--    Exactly one of lecturer_id / user_id must be set (see header).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invigilator_assignments (
  id               SERIAL PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  lecturer_id      INTEGER REFERENCES lecturers(id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  assigned_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invigilator_assignments_one_target CHECK (
    (lecturer_id IS NOT NULL AND user_id IS NULL) OR
    (lecturer_id IS NULL AND user_id IS NOT NULL)
  )
);

-- One assignment of the same lecturer / user to the same session.
CREATE UNIQUE INDEX IF NOT EXISTS ux_invigilator_assignments_lecturer
  ON invigilator_assignments (exam_schedule_id, lecturer_id)
  WHERE lecturer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invigilator_assignments_user
  ON invigilator_assignments (exam_schedule_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invigilator_assignments_schedule
  ON invigilator_assignments(exam_schedule_id);
CREATE INDEX IF NOT EXISTS idx_invigilator_assignments_lecturer
  ON invigilator_assignments(lecturer_id);
CREATE INDEX IF NOT EXISTS idx_invigilator_assignments_user
  ON invigilator_assignments(user_id);

-- --------------------------------------------------------------------------
-- 3. exam_incidents — misconduct / absence / other report for a session.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_incidents (
  id               SERIAL PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  student_id       INTEGER REFERENCES students(id) ON DELETE SET NULL,
  type             VARCHAR(20) NOT NULL
                   CHECK (type IN ('misconduct','absence','other')),
  description      TEXT NOT NULL CHECK (char_length(btrim(description)) >= 3),
  status           VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','under_review','resolved')),
  reported_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exam_incidents_schedule ON exam_incidents(exam_schedule_id);
CREATE INDEX IF NOT EXISTS idx_exam_incidents_student  ON exam_incidents(student_id);
CREATE INDEX IF NOT EXISTS idx_exam_incidents_status   ON exam_incidents(status);
CREATE INDEX IF NOT EXISTS idx_exam_incidents_reported ON exam_incidents(reported_by);

-- --------------------------------------------------------------------------
-- 4. seat_assignments — one seat per student per session.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seat_assignments (
  id               SERIAL PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id          INTEGER REFERENCES exam_rooms(id) ON DELETE SET NULL,
  seat_number      VARCHAR(20) NOT NULL CHECK (char_length(btrim(seat_number)) >= 1),
  assigned_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seat_assignments_unique_student UNIQUE (exam_schedule_id, student_id),
  CONSTRAINT seat_assignments_unique_seat UNIQUE (exam_schedule_id, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seat_assignments_schedule ON seat_assignments(exam_schedule_id);
CREATE INDEX IF NOT EXISTS idx_seat_assignments_student  ON seat_assignments(student_id);
CREATE INDEX IF NOT EXISTS idx_seat_assignments_room     ON seat_assignments(room_id);

-- --------------------------------------------------------------------------
-- updated_at triggers (uses set_updated_at() from 001_init.sql)
-- --------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['exam_registrations','exam_incidents','seat_assignments'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %s;
       CREATE TRIGGER trg_%s_updated_at
         BEFORE UPDATE ON %s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t);
  END LOOP;
END $$;

COMMIT;

-- Verification (run after applying):
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name IN
--   ('exam_registrations','invigilator_assignments','exam_incidents',
--    'seat_assignments');
-- Expected: 4
--   SELECT name FROM roles WHERE name = 'invigilator';
-- Expected: invigilator
