-- ============================================================================
-- University Examination Department Management System
-- Migration 005 — Reference data missing on the live database
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f 005_reference_data.sql
-- Idempotent: safe to run more than once. Run AFTER 001_init.sql and
-- 004_departments.sql (it needs the Computer Science department, code 'CS').
--   npm run migrate:schema   (runs 001 + 003 + 004 + 005)
--   npm run migrate          (runs 001 + 003 + 004 + 002_seed + 005 — see note)
--   run.bat (Windows)        (runs 001 + 003 + 004 + 005)
--
-- What it seeds (and nothing else — no login accounts, no roles):
--   1. Academic year 2026-2027 (2026-09-01 to 2027-06-30), made current.
--   2. Its Fall (semester 1) and Spring (semester 2) terms, Fall current.
--   3. The grade scale A–F, copied exactly from 002_seed.sql — the same
--      rows gradeForMarks() in backend/src/utils/gpa.js reads from the DB
--      (A 90–100 / 4.00, B 80–89.99 / 3.00, C 70–79.99 / 2.00,
--      D 60–69.99 / 1.00, E 50–59.99 / 0.50, F 0–49.99 / 0.00).
--   4. Lecturer Irfan's (LEC-007) five BCS subjects, all under the
--      Computer Science department: CS-101, CS-201, CS-301, SE-101, SE-201.
--   5. Enrolment of student Zahid (STU-2026-001) in those five subjects
--      for Fall 2026-2027.
--
-- Deliberate limits (do not "fix" by adding rows without changing 001):
--   * Semesters: 001_init.sql defines
--       semester_number INTEGER CHECK (semester_number BETWEEN 1 AND 4)
--     plus UNIQUE (academic_year_id, semester_number), so one academic
--     year can hold at most four numbered terms. Semester numbers 5–8
--     therefore CANNOT be rows of 2026-2027 — inserting them would
--     violate the CHECK and abort this whole migration. The 1–8 range
--     is the student's current_semester (programme semester, 001
--     students.current_semester CHECK 1–8), not semesters.semester_number.
--     This file seeds the two terms 002_seed.sql uses (Fall 1, Spring 2);
--     programme semesters 3–8 belong to later academic years
--     (2027-2028 onwards) and are seeded with those years.
--   * Current year/term: partial unique indexes (ux_academic_years_one_
--     current, ux_semesters_one_current) allow only one current row each.
--     The UPDATEs below demote any other current year/term first, so
--     this file is safe even if 002_seed.sql already made 2025-2026 /
--     Fall 2025-2026 current. For the same reason 005 runs AFTER
--     002_seed.sql in `npm run migrate`: 002 inserts 2025-2026 as
--     current, which would fail if 2026-2027 were already current.
--   * Subjects: if a subject code already exists (e.g. 002_seed.sql ran
--     first), ON CONFLICT (code) DO NOTHING leaves the existing row
--     untouched — it is NOT moved to CS / Fall 2026-2027. On the live
--     database (never seeded) all five are created under CS as intended.
--     If the CS department does not exist, the subject inserts insert
--     zero rows instead of failing on the NOT NULL department_id.
--   * Enrolments: the whole step inserts zero rows if student
--     STU-2026-001 does not exist yet, and a single missing subject is
--     skipped while the others still enrol.
-- No login accounts are created by this migration.
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 1. Academic year 2026-2027, current.
--    Demote any other current year first (partial unique index allows one).
-- --------------------------------------------------------------------------
UPDATE academic_years SET is_current = FALSE
 WHERE is_current AND name <> '2026-2027';

INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES
  ('2026-2027', '2026-09-01', '2027-06-30', TRUE)
ON CONFLICT (name) DO NOTHING;

-- If the row already existed as non-current, make it current now.
UPDATE academic_years SET is_current = TRUE WHERE name = '2026-2027';

-- --------------------------------------------------------------------------
-- 2. Semesters for 2026-2027: Fall (1) and Spring (2), Fall current.
--    Same dates/naming as 002_seed.sql, shifted one year. See header for
--    why semester_number 5–8 are not (and cannot be) rows of this year.
-- --------------------------------------------------------------------------
UPDATE semesters SET is_current = FALSE WHERE is_current;

INSERT INTO semesters (academic_year_id, name, semester_number, start_date, end_date, is_current) VALUES
  ((SELECT id FROM academic_years WHERE name = '2026-2027'), 'Fall',   1, '2026-09-01', '2027-01-31', TRUE),
  ((SELECT id FROM academic_years WHERE name = '2026-2027'), 'Spring', 2, '2027-02-01', '2027-06-30', FALSE)
ON CONFLICT DO NOTHING;

-- If the Fall row already existed as non-current, make it current now.
UPDATE semesters SET is_current = TRUE
 WHERE academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027')
   AND semester_number = 1;

-- --------------------------------------------------------------------------
-- 3. Grade scale A–F — exact copy of the 002_seed.sql rows, which are the
--    ranges gradeForMarks() (backend/src/utils/gpa.js) matches with
--    min_marks <= marks <= max_marks. Note the E grade (50–59.99, 0.50,
--    passing): 001_init.sql's comment "pass mark = 40 (grade D and above)"
--    does not match the seeded scale, and the seeded scale wins because
--    that is what the code actually reads.
-- --------------------------------------------------------------------------
INSERT INTO grade_scales (grade, min_marks, max_marks, grade_point, remarks, is_passing) VALUES
  ('A', 90, 100, 4.00, 'Excellent', TRUE),
  ('B', 80, 89.99, 3.00, 'Very Good', TRUE),
  ('C', 70, 79.99, 2.00, 'Good', TRUE),
  ('D', 60, 69.99, 1.00, 'Satisfactory', TRUE),
  ('E', 50, 59.99, 0.50, 'Marginal Pass', TRUE),
  ('F', 0, 49.99, 0.00, 'Fail', FALSE)
ON CONFLICT (grade) DO NOTHING;

-- --------------------------------------------------------------------------
-- 4. Irfan's five BCS subjects, all under Computer Science (code 'CS').
--    lecturer_id is Eng Irfan (employee_id LEC-007) where that lecturer
--    row exists, else NULL (lecturer_id is nullable). semester_id is Fall
--    2026-2027 where it exists, else NULL (semester_id is nullable).
--    WHERE EXISTS guards the NOT NULL department_id: if the CS department
--    does not exist, the insert inserts zero rows instead of failing.
-- --------------------------------------------------------------------------
INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title, credit_hours)
SELECT
  (SELECT id FROM departments WHERE code = 'CS'),
  (SELECT id FROM semesters WHERE semester_number = 1
     AND academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027')),
  (SELECT id FROM lecturers WHERE employee_id = 'LEC-007'),
  'CS-101', 'Introduction to Programming', 3
WHERE EXISTS (SELECT 1 FROM departments WHERE code = 'CS')
ON CONFLICT (code) DO NOTHING;

INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title, credit_hours)
SELECT
  (SELECT id FROM departments WHERE code = 'CS'),
  (SELECT id FROM semesters WHERE semester_number = 1
     AND academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027')),
  (SELECT id FROM lecturers WHERE employee_id = 'LEC-007'),
  'CS-201', 'Data Structures & Algorithms', 3
WHERE EXISTS (SELECT 1 FROM departments WHERE code = 'CS')
ON CONFLICT (code) DO NOTHING;

INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title, credit_hours)
SELECT
  (SELECT id FROM departments WHERE code = 'CS'),
  (SELECT id FROM semesters WHERE semester_number = 1
     AND academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027')),
  (SELECT id FROM lecturers WHERE employee_id = 'LEC-007'),
  'CS-301', 'Database Management Systems', 3
WHERE EXISTS (SELECT 1 FROM departments WHERE code = 'CS')
ON CONFLICT (code) DO NOTHING;

INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title, credit_hours)
SELECT
  (SELECT id FROM departments WHERE code = 'CS'),
  (SELECT id FROM semesters WHERE semester_number = 1
     AND academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027')),
  (SELECT id FROM lecturers WHERE employee_id = 'LEC-007'),
  'SE-101', 'Software Engineering Fundamentals', 3
WHERE EXISTS (SELECT 1 FROM departments WHERE code = 'CS')
ON CONFLICT (code) DO NOTHING;

INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title, credit_hours)
SELECT
  (SELECT id FROM departments WHERE code = 'CS'),
  (SELECT id FROM semesters WHERE semester_number = 1
     AND academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027')),
  (SELECT id FROM lecturers WHERE employee_id = 'LEC-007'),
  'SE-201', 'Web Application Development', 3
WHERE EXISTS (SELECT 1 FROM departments WHERE code = 'CS')
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- 5. Enrol Zahid (student_id STU-2026-001) in the five subjects above,
--    for Fall 2026-2027. Inserts zero rows if the student does not exist
--    yet; a subject that does not exist is skipped, the others enrol.
--    enrollments columns (001_init.sql): student_id, subject_id,
--    semester_id, academic_year_id (all NOT NULL FKs), enrolled_at
--    (default now()), status (default 'enrolled'); unique
--    (student_id, subject_id, semester_id).
-- --------------------------------------------------------------------------
INSERT INTO enrollments (student_id, subject_id, semester_id, academic_year_id, status)
SELECT st.id, sub.id, sem.id, ay.id, 'enrolled'
FROM students st
CROSS JOIN (VALUES ('CS-101'), ('CS-201'), ('CS-301'), ('SE-101'), ('SE-201')) AS v(code)
JOIN subjects sub ON sub.code = v.code
JOIN academic_years ay ON ay.name = '2026-2027'
JOIN semesters sem ON sem.academic_year_id = ay.id AND sem.semester_number = 1
WHERE st.student_id = 'STU-2026-001'
ON CONFLICT (student_id, subject_id, semester_id) DO NOTHING;

COMMIT;

-- Verification (run after applying):
--   SELECT 'academic_years', count(*) FROM academic_years WHERE name = '2026-2027' UNION ALL
--   SELECT 'semesters', count(*) FROM semesters
--    WHERE academic_year_id = (SELECT id FROM academic_years WHERE name = '2026-2027') UNION ALL
--   SELECT 'grade_scales', count(*) FROM grade_scales UNION ALL
--   SELECT 'subjects', count(*) FROM subjects
--    WHERE code IN ('CS-101','CS-201','CS-301','SE-101','SE-201') UNION ALL
--   SELECT 'enrollments', count(*) FROM enrollments
--    WHERE student_id = (SELECT id FROM students WHERE student_id = 'STU-2026-001');
-- Expected on the live database: academic_years 1, semesters 2,
-- grade_scales 6, subjects 5, enrollments 5.
-- Also: SELECT name, is_current FROM academic_years ORDER BY name;
--   (only 2026-2027 should be current) and
--   SELECT code, title FROM subjects WHERE code IN
--   ('CS-101','CS-201','CS-301','SE-101','SE-201') ORDER BY code;
