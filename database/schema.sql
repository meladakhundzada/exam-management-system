-- ============================================================================
-- University Examination Department Management System
-- PostgreSQL schema — schema.sql (canonical, idempotent)
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f schema.sql
-- Migrations 001_init.sql is a copy of this file for versioned deploys;
-- 002_seed.sql loads the demo data. This file alone creates an empty DB.
--
-- Design notes / assumptions (configurable, not official policy):
-- * Grading is a configurable grade_scales table (A=4.0 … F=0.0, see seed).
--   GPA = Σ(grade_point × credit_hours) / Σ(credit_hours); CGPA is the same
--   formula over all published results for the student. Pass mark = 40
--   (grade D and above) unless a row in grade_scales says otherwise.
-- * Marks are entered per subject per exam (0–100). A mark row is unique
--   per (exam_id, student_id, subject_id). Status flow:
--   draft → submitted → approved → published (via results.is_published).
-- * A student is identified by student_id (e.g. 001) AND email;
--   both are UNIQUE so duplicate registration is impossible at the DB level.
-- * Soft-delete is NOT used: deletes are restricted (ON DELETE RESTRICT)
--   on master data so history/audit is never orphaned; users are
--   deactivated via users.is_active instead.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --------------------------------------------------------------------------
-- Helper: keep updated_at current
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. RBAC — roles, permissions, role_permissions, users
-- ============================================================================
CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(50)  NOT NULL UNIQUE,          -- super_admin, exam_officer, lecturer, student
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,         -- system roles cannot be deleted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,          -- e.g. students.create
  resource    VARCHAR(50)  NOT NULL,                 -- students, exams, marks …
  action      VARCHAR(50)  NOT NULL,                 -- create, read, update, delete, publish …
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  uuid          UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  full_name     VARCHAR(150) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,                -- bcrypt ($2b$…), never plaintext
  phone         VARCHAR(30),
  avatar_url    TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- ============================================================================
-- 2. Academic structure — faculties, departments, academic_years, semesters
-- ============================================================================
CREATE TABLE IF NOT EXISTS faculties (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL UNIQUE,
  code        VARCHAR(20)  NOT NULL UNIQUE,          -- e.g. FOCS
  dean_name   VARCHAR(150),
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id          SERIAL PRIMARY KEY,
  faculty_id  INTEGER NOT NULL REFERENCES faculties(id) ON DELETE RESTRICT,
  name        VARCHAR(150) NOT NULL,
  code        VARCHAR(20)  NOT NULL UNIQUE,          -- e.g. CS, SE, BBA
  head_name   VARCHAR(150),
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT departments_name_faculty_unique UNIQUE (faculty_id, name)
);

CREATE TABLE IF NOT EXISTS academic_years (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(20) NOT NULL UNIQUE,           -- e.g. 2025-2026
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  is_current  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT academic_years_dates CHECK (end_date > start_date)
);
-- Only one current year at a time (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS ux_academic_years_one_current
  ON academic_years (is_current) WHERE is_current IS TRUE;

CREATE TABLE IF NOT EXISTS semesters (
  id               SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  name             VARCHAR(50) NOT NULL,             -- Fall, Spring, Summer
  semester_number  INTEGER NOT NULL CHECK (semester_number BETWEEN 1 AND 4),
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  is_current       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT semesters_dates CHECK (end_date > start_date),
  CONSTRAINT semesters_year_name_unique UNIQUE (academic_year_id, name),
  CONSTRAINT semesters_year_number_unique UNIQUE (academic_year_id, semester_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_semesters_one_current
  ON semesters (is_current) WHERE is_current IS TRUE;

-- ============================================================================
-- 3. People — lecturers, students
-- ============================================================================
CREATE TABLE IF NOT EXISTS lecturers (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL UNIQUE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  employee_id   VARCHAR(30) NOT NULL UNIQUE,         -- e.g. LEC-001
  full_name     VARCHAR(150) NOT NULL,
  email         VARCHAR(255) UNIQUE,                 -- NULL until the lecturer's login account is created (e.g. Eng Irfan, LEC-007 — email not yet known)
  phone         VARCHAR(30),
  gender        VARCHAR(10) CHECK (gender IN ('male','female','other')),
  designation   VARCHAR(100),                        -- Lecturer, Assistant Professor …
  qualification VARCHAR(150),
  joining_date  DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL UNIQUE,
  department_id    INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  student_id       VARCHAR(30) NOT NULL UNIQUE,      -- e.g. 001 (admission no.)
  full_name        VARCHAR(150) NOT NULL,
  email            VARCHAR(255) NOT NULL UNIQUE,
  phone            VARCHAR(30),
  gender           VARCHAR(10) CHECK (gender IN ('male','female','other')),
  date_of_birth    DATE,
  cnic_or_passport VARCHAR(30),
  address          TEXT,
  guardian_name    VARCHAR(150),
  guardian_phone   VARCHAR(30),
  admission_year   INTEGER NOT NULL CHECK (admission_year BETWEEN 2000 AND 2100),
  current_semester INTEGER NOT NULL DEFAULT 1 CHECK (current_semester BETWEEN 1 AND 8),
  status           VARCHAR(20) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','graduated','dropped')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 4. Subjects, enrollments
-- ============================================================================
CREATE TABLE IF NOT EXISTS subjects (
  id            SERIAL PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  semester_id   INTEGER REFERENCES semesters(id) ON DELETE RESTRICT,
  lecturer_id    INTEGER REFERENCES lecturers(id) ON DELETE SET NULL,
  code          VARCHAR(20) NOT NULL UNIQUE,         -- e.g. CS-101
  title         VARCHAR(200) NOT NULL,
  credit_hours  NUMERIC(3,1) NOT NULL DEFAULT 3 CHECK (credit_hours > 0 AND credit_hours <= 6),
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrollments (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id       INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  semester_id      INTEGER NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           VARCHAR(20) NOT NULL DEFAULT 'enrolled'
                   CHECK (status IN ('enrolled','dropped','completed')),
  CONSTRAINT enrollments_unique UNIQUE (student_id, subject_id, semester_id)
);

-- ============================================================================
-- 5. Examinations — exams, schedules, rooms, allocations, attendance
-- ============================================================================
CREATE TABLE IF NOT EXISTS examinations (
  id               SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  semester_id      INTEGER NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
  title            VARCHAR(200) NOT NULL,            -- e.g. Fall 2025 Final Examination
  exam_type        VARCHAR(30) NOT NULL CHECK (exam_type IN ('midterm','final','quiz','supplementary','entry')),
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('draft','scheduled','ongoing','completed','cancelled')),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT examinations_dates CHECK (end_date >= start_date),
  CONSTRAINT examinations_unique UNIQUE (academic_year_id, semester_id, title, exam_type)
);

CREATE TABLE IF NOT EXISTS exam_rooms (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(50) NOT NULL UNIQUE,           -- Hall A, Room 101
  building    VARCHAR(100),
  capacity    INTEGER NOT NULL CHECK (capacity > 0),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exam_schedules (
  id            SERIAL PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  exam_date     DATE NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  duration_min  INTEGER GENERATED ALWAYS AS
                  (CAST(EXTRACT(EPOCH FROM (end_time - start_time)) / 60 AS INTEGER)) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_schedules_times CHECK (end_time > start_time),
  CONSTRAINT exam_schedules_unique UNIQUE (exam_id, subject_id)
);

CREATE TABLE IF NOT EXISTS room_allocations (
  id               SERIAL PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  room_id          INTEGER NOT NULL REFERENCES exam_rooms(id) ON DELETE RESTRICT,
  invigilator_id   INTEGER REFERENCES lecturers(id) ON DELETE SET NULL,
  seat_capacity    INTEGER NOT NULL CHECK (seat_capacity > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT room_allocations_unique UNIQUE (exam_schedule_id, room_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id               SERIAL PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id          INTEGER REFERENCES exam_rooms(id) ON DELETE SET NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'present'
                   CHECK (status IN ('present','absent','late')),
  marked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  marked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  remarks          TEXT,
  CONSTRAINT attendance_unique UNIQUE (exam_schedule_id, student_id)
);

-- ============================================================================
-- 6. Marks, grade scales, results
-- ============================================================================
CREATE TABLE IF NOT EXISTS grade_scales (
  id            SERIAL PRIMARY KEY,
  grade         VARCHAR(5) NOT NULL UNIQUE,          -- A, B, C, D, F
  min_marks     NUMERIC(5,2) NOT NULL CHECK (min_marks >= 0 AND min_marks <= 100),
  max_marks     NUMERIC(5,2) NOT NULL CHECK (max_marks >= 0 AND max_marks <= 100),
  grade_point   NUMERIC(3,2) NOT NULL CHECK (grade_point >= 0 AND grade_point <= 4),
  remarks       VARCHAR(100),
  is_passing    BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT grade_scales_range CHECK (max_marks >= min_marks)
);

CREATE TABLE IF NOT EXISTS marks (
  id            SERIAL PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lecturer_id    INTEGER REFERENCES lecturers(id) ON DELETE SET NULL,
  obtained_marks NUMERIC(5,2) NOT NULL CHECK (obtained_marks >= 0 AND obtained_marks <= 100),
  total_marks   NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (total_marks > 0),
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','submitted','approved','rejected')),
  remarks       TEXT,
  entered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marks_unique UNIQUE (exam_id, subject_id, student_id),
  CONSTRAINT marks_obtained_le_total CHECK (obtained_marks <= total_marks)
);

CREATE TABLE IF NOT EXISTS results (
  id            SERIAL PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  mark_id       INTEGER REFERENCES marks(id) ON DELETE SET NULL,
  obtained_marks NUMERIC(5,2) NOT NULL CHECK (obtained_marks >= 0),
  grade         VARCHAR(5) NOT NULL REFERENCES grade_scales(grade),
  grade_point   NUMERIC(3,2) NOT NULL CHECK (grade_point >= 0 AND grade_point <= 4),
  gpa           NUMERIC(4,3),                        -- semester GPA snapshot for this row's exam
  is_published  BOOLEAN NOT NULL DEFAULT FALSE,
  published_at  TIMESTAMPTZ,
  published_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT results_unique UNIQUE (exam_id, student_id, subject_id)
);

-- ============================================================================
-- 7. Complaints, notifications, audit logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS complaints (
  id            SERIAL PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exam_id       INTEGER REFERENCES examinations(id) ON DELETE SET NULL,
  subject_id    INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  result_id     INTEGER REFERENCES results(id) ON DELETE SET NULL,
  type          VARCHAR(30) NOT NULL DEFAULT 'rechecking'
                CHECK (type IN ('rechecking','marks_correction','absent_marked','other')),
  description   TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','under_review','resolved','rejected')),
  resolution    TEXT,
  resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = broadcast to all
  role_id     INTEGER REFERENCES roles(id) ON DELETE CASCADE,  -- NULL = all roles
  title       VARCHAR(200) NOT NULL,
  message     TEXT NOT NULL,
  type        VARCHAR(30) NOT NULL DEFAULT 'info'
              CHECK (type IN ('info','exam','result','announcement','alert')),
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,                 -- e.g. marks.approve, results.publish
  entity_type VARCHAR(50),                           -- students, marks, results …
  entity_id   INTEGER,
  old_values  JSONB,
  new_values  JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 8. Indexes (search / filter / FK hot paths)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_users_role_id      ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_students_dept      ON students(department_id);
CREATE INDEX IF NOT EXISTS idx_students_status    ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_name      ON students(full_name);
CREATE INDEX IF NOT EXISTS idx_lecturers_dept      ON lecturers(department_id);
CREATE INDEX IF NOT EXISTS idx_subjects_dept      ON subjects(department_id);
CREATE INDEX IF NOT EXISTS idx_subjects_semester  ON subjects(semester_id);
CREATE INDEX IF NOT EXISTS idx_subjects_lecturer   ON subjects(lecturer_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_subject ON enrollments(subject_id);
CREATE INDEX IF NOT EXISTS idx_exams_semester     ON examinations(semester_id);
CREATE INDEX IF NOT EXISTS idx_exams_status       ON examinations(status);
CREATE INDEX IF NOT EXISTS idx_schedules_exam     ON exam_schedules(exam_id);
CREATE INDEX IF NOT EXISTS idx_schedules_date     ON exam_schedules(exam_date);
CREATE INDEX IF NOT EXISTS idx_attendance_schedule ON attendance(exam_schedule_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_marks_exam         ON marks(exam_id);
CREATE INDEX IF NOT EXISTS idx_marks_student      ON marks(student_id);
CREATE INDEX IF NOT EXISTS idx_marks_status       ON marks(status);
CREATE INDEX IF NOT EXISTS idx_results_exam       ON results(exam_id);
CREATE INDEX IF NOT EXISTS idx_results_student    ON results(student_id);
CREATE INDEX IF NOT EXISTS idx_results_published  ON results(is_published);
CREATE INDEX IF NOT EXISTS idx_complaints_student ON complaints(student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status  ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_audit_user         ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created      ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity       ON audit_logs(entity_type, entity_id);

-- ============================================================================
-- 9. updated_at triggers
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','users','faculties','departments','academic_years','semesters',
    'lecturers','students','subjects','examinations','exam_rooms',
    'exam_schedules','marks','results','complaints'
  ] LOOP
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
--   ('users','roles','permissions','role_permissions','students','lecturers',
--    'faculties','departments','academic_years','semesters','subjects',
--    'enrollments','examinations','exam_schedules','exam_rooms',
--    'room_allocations','attendance','marks','results','grade_scales',
--    'complaints','notifications','audit_logs');
-- Expected: 22
