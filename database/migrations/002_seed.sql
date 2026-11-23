-- ============================================================================
-- 002_seed.sql — sample academic data (idempotent: ON CONFLICT DO NOTHING)
-- Run after 001_init.sql:  psql "$DATABASE_URL" -f 002_seed.sql
--
-- NO LOGIN ACCOUNTS ARE SEEDED BY THIS FILE. The old demo accounts
-- (the old Super Admin account, the old Examination Officer, the
-- lecturer Maryam Karimi and the student Ali Ahmadi) were removed and
-- are not recreated here. Create the real accounts after migrating:
--   * Super Admin melad — POST /api/auth/setup-first-admin with
--     full_name "melad", email meladakhundzada@gmail.com, and a
--     password of at least 8 characters that melad chooses himself.
--     (The endpoint only works while the users table is empty.)
--   * Examination Officer abas, Lecturer Eng Irfan and Student Zahid
--     — create them from the Users page once logged in as melad.
--     Their emails are not on file yet, so they are NOT seeded here;
--     do not invent an email for them. Passwords are chosen by each
--     person at account creation (minimum 8 characters).
-- Sample lecturer/student person records below have user_id NULL
-- until their login accounts exist. Eng Irfan's lecturer record is
-- seeded with email NULL for the same reason; set his email on that
-- row (employee_id LEC-007) when it is known instead of creating a
-- second lecturer record for him.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------- roles
INSERT INTO roles (name, description, is_system) VALUES
  ('super_admin',    'Full access to the entire system', TRUE),
  ('exam_officer',   'Manages students, exams, schedules, rooms, attendance, results', TRUE),
  ('lecturer',        'Views assigned subjects/students, enters marks', TRUE),
  ('student',        'Views profile, timetable, admit card, published results', TRUE)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------- permissions
INSERT INTO permissions (name, resource, action, description) VALUES
  ('users.create','users','create','Create users'), ('users.read','users','read','View users'),
  ('users.update','users','update','Update users'), ('users.delete','users','delete','Delete users'),
  ('students.create','students','create','Register students'), ('students.read','students','read','View students'),
  ('students.update','students','update','Update students'), ('students.delete','students','delete','Delete students'),
  ('lecturers.create','lecturers','create','Create lecturers'), ('lecturers.read','lecturers','read','View lecturers'),
  ('lecturers.update','lecturers','update','Update lecturers'), ('lecturers.delete','lecturers','delete','Delete lecturers'),
  ('departments.manage','departments','manage','Manage faculties/departments'),
  ('exams.create','exams','create','Create examinations'), ('exams.read','exams','read','View examinations'),
  ('exams.update','exams','update','Update examinations'), ('exams.delete','exams','delete','Delete examinations'),
  ('schedules.manage','schedules','manage','Manage timetables and room allocation'),
  ('attendance.manage','attendance','manage','Record attendance'),
  ('marks.create','marks','create','Enter marks'), ('marks.update','marks','update','Update marks'),
  ('marks.submit','marks','submit','Submit marks for approval'), ('marks.approve','marks','approve','Approve/reject marks'),
  ('results.publish','results','publish','Publish results'), ('results.read','results','read','View results'),
  ('reports.read','reports','read','View/export reports'),
  ('complaints.manage','complaints','manage','Review complaints'),
  ('settings.manage','settings','manage','Manage system settings'),
  ('audit.read','audit','read','View audit logs')
ON CONFLICT (name) DO NOTHING;

-- Grant: super_admin gets everything; exam_officer most; lecturer marks+read; student read-only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'super_admin'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'exam_officer'
  AND p.name IN ('students.create','students.read','students.update','exams.create','exams.read','exams.update',
    'schedules.manage','attendance.manage','marks.approve','results.publish','results.read',
    'reports.read','complaints.manage','lecturers.read')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'lecturer'
  AND p.name IN ('students.read','exams.read','marks.create','marks.update','marks.submit','results.read')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'student'
  AND p.name IN ('exams.read','results.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- users
-- No users are seeded (see header). The first Super Admin (melad,
-- meladakhundzada@gmail.com) is created via POST /api/auth/setup-first-admin;
-- abas, Irfan and Zahid are created from the Users page after that.

-- ---------------------------------------------------------------- faculties (2) & departments (4)
INSERT INTO faculties (name, code, dean_name) VALUES
  ('Faculty of Computer Science', 'FOCS', 'Prof. Dr. Abdul Rahim'),
  ('Faculty of Business & Economics', 'FOBE', 'Prof. Dr. Fatima Noori')
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (faculty_id, name, code, head_name) VALUES
  ((SELECT id FROM faculties WHERE code='FOCS'), 'Computer Science', 'CS', 'Dr. Ahmad Wali'),
  ((SELECT id FROM faculties WHERE code='FOCS'), 'Software Engineering', 'SE', 'Dr. Sara Ahmadi'),
  ((SELECT id FROM faculties WHERE code='FOBE'), 'Business Administration', 'BBA', 'Dr. Mohammad Nasir'),
  ((SELECT id FROM faculties WHERE code='FOBE'), 'Economics', 'ECON', 'Dr. Laila Habibi')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------- academic years (2) & semesters (2)
INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES
  ('2024-2025', '2024-09-01', '2025-06-30', FALSE),
  ('2025-2026', '2025-09-01', '2026-06-30', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO semesters (academic_year_id, name, semester_number, start_date, end_date, is_current) VALUES
  ((SELECT id FROM academic_years WHERE name='2025-2026'), 'Fall',   1, '2025-09-01', '2026-01-31', TRUE),
  ((SELECT id FROM academic_years WHERE name='2025-2026'), 'Spring', 2, '2026-02-01', '2026-06-30', FALSE)
ON CONFLICT (academic_year_id, name) DO NOTHING;

-- ---------------------------------------------------------------- lecturers (6)
-- Person records only — no login accounts (user_id is NULL until each
-- lecturer's account is created). Maryam Karimi was removed.
-- Eng Irfan (LEC-007, home department CS) teaches the BCS subjects
-- CS-101, CS-201, CS-301, SE-101 and SE-201 (see subjects below).
-- His email is not on file yet, so it is NULL; set it on this row
-- when known instead of creating a second lecturer record for him.
INSERT INTO lecturers (user_id, department_id, employee_id, full_name, email, gender, designation, qualification, joining_date) VALUES
  (NULL, (SELECT id FROM departments WHERE code='CS'),   'LEC-001', 'Dr. Ahmad Wali',    'ahmad.wali@university.edu',   'male',   'Associate Professor', 'PhD Computer Science', '2018-09-01'),
  (NULL, (SELECT id FROM departments WHERE code='SE'),   'LEC-002', 'Dr. Sara Ahmadi',   'sara.ahmadi@university.edu',  'female', 'Assistant Professor', 'PhD Software Engineering','2020-09-01'),
  (NULL, (SELECT id FROM departments WHERE code='CS'),   'LEC-003', 'Mr. Khalid Rahmani', 'khalid.rahmani@university.edu','male',   'Lecturer',              'MSc Computer Science',   '2021-09-01'),
  (NULL, (SELECT id FROM departments WHERE code='BBA'),  'LEC-005', 'Dr. Mohammad Nasir','nasir@university.edu',       'male',   'Associate Professor', 'PhD Business Administration','2017-09-01'),
  (NULL, (SELECT id FROM departments WHERE code='ECON'), 'LEC-006', 'Ms. Laila Habibi',  'laila.habibi@university.edu', 'female', 'Lecturer',              'MSc Economics',          '2021-09-01'),
  (NULL, (SELECT id FROM departments WHERE code='CS'),   'LEC-007', 'Eng Irfan',         NULL,                          'male',   'Lecturer',              NULL,                     NULL)
ON CONFLICT (employee_id) DO NOTHING;

-- ---------------------------------------------------------------- students (11)
-- Person records only — no login accounts (user_id is NULL until each
-- student's account is created). Ali Ahmadi (STU-2024-001) was removed.
INSERT INTO students (user_id, department_id, student_id, full_name, email, gender, date_of_birth, admission_year, current_semester, guardian_name) VALUES
  (NULL, (SELECT id FROM departments WHERE code='CS'),   'STU-2024-002', 'Fatima Noori',    'fatima.noori@student.university.edu',   'female', '2004-01-20', 2024, 3, 'Abdul Noori'),
  (NULL,    (SELECT id FROM departments WHERE code='SE'),   'STU-2024-003', 'Omar Karimi',     'omar.karimi@student.university.edu',    'male',   '2003-08-03', 2024, 3, 'Karim Karimi'),
  (NULL,  (SELECT id FROM departments WHERE code='SE'),   'STU-2024-004', 'Aisha Rahmani',   'aisha.rahmani@student.university.edu',  'female', '2004-03-15', 2024, 3, 'Rahman Rahmani'),
  (NULL,(SELECT id FROM departments WHERE code='BBA'), 'STU-2024-005', 'Hassan Mohammadi','hassan.mohammadi@student.university.edu','male', '2003-11-28', 2024, 3, 'Mohammad Mohammadi'),
  (NULL, (SELECT id FROM departments WHERE code='BBA'),  'STU-2024-006', 'Zahra Hussaini',  'zahra.hussaini@student.university.edu', 'female', '2004-06-09', 2024, 3, 'Hussain Hussaini'),
  (NULL, (SELECT id FROM departments WHERE code='ECON'),'STU-2024-007', 'Bilal Ahmadzai',  'bilal.ahmadzai@student.university.edu', 'male',   '2003-02-14', 2024, 3, 'Ahmadzai Khan'),
  (NULL,    (SELECT id FROM departments WHERE code='ECON'),'STU-2024-008', 'Nadia Popal',     'nadia.popal@student.university.edu',    'female', '2004-09-30', 2024, 3, 'Popal Jan'),
  (NULL,(SELECT id FROM departments WHERE code='CS'),   'STU-2025-001', 'Yusuf Stanikzai', 'yusuf.stanikzai@student.university.edu','male', '2005-04-22', 2025, 1, 'Stanikzai Khan'),
  (NULL,   (SELECT id FROM departments WHERE code='SE'),   'STU-2025-002', 'Lina Sultani',    'lina.sultani@student.university.edu',   'female', '2005-07-11', 2025, 1, 'Sultani Ahmad'),
  (NULL,    (SELECT id FROM departments WHERE code='BBA'),  'STU-2025-003', 'Rahimullah Azizi','rahim.azizi@student.university.edu',    'male',   '2005-12-05', 2025, 1, 'Azizi Mohammad'),
  (NULL,   (SELECT id FROM departments WHERE code='ECON'),'STU-2025-004', 'Sofia Wardak',    'sofia.wardak@student.university.edu',   'female', '2005-10-18', 2025, 1, 'Wardak Jan')
ON CONFLICT (student_id) DO NOTHING;

-- ---------------------------------------------------------------- subjects (8)
INSERT INTO subjects (department_id, semester_id, lecturer_id, code, title, credit_hours) VALUES
  ((SELECT id FROM departments WHERE code='CS'),   (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-007'), 'CS-101', 'Introduction to Programming', 3),
  ((SELECT id FROM departments WHERE code='CS'),   (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-007'), 'CS-201', 'Data Structures & Algorithms', 3),
  ((SELECT id FROM departments WHERE code='CS'),   (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-007'), 'CS-301', 'Database Management Systems', 3),
  ((SELECT id FROM departments WHERE code='SE'),   (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-007'), 'SE-101', 'Software Engineering Fundamentals', 3),
  ((SELECT id FROM departments WHERE code='SE'),   (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-007'), 'SE-201', 'Web Application Development', 3),
  ((SELECT id FROM departments WHERE code='BBA'),  (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-005'), 'BBA-101', 'Principles of Management', 3),
  ((SELECT id FROM departments WHERE code='BBA'),  (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-005'), 'BBA-201', 'Financial Accounting', 3),
  ((SELECT id FROM departments WHERE code='ECON'), (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), (SELECT id FROM lecturers WHERE employee_id='LEC-006'), 'ECON-101', 'Microeconomics', 3)
ON CONFLICT (code) DO NOTHING;

-- Enroll every student in the subjects of their own department (Fall 2025-2026).
INSERT INTO enrollments (student_id, subject_id, semester_id, academic_year_id)
SELECT s.id, sub.id,
  (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')),
  (SELECT id FROM academic_years WHERE name='2025-2026')
FROM students s JOIN subjects sub ON sub.department_id = s.department_id
ON CONFLICT (student_id, subject_id, semester_id) DO NOTHING;

-- ---------------------------------------------------------------- grade scale A–F
INSERT INTO grade_scales (grade, min_marks, max_marks, grade_point, remarks, is_passing) VALUES
  ('A', 90, 100, 4.00, 'Excellent', TRUE),
  ('B', 80, 89.99, 3.00, 'Very Good', TRUE),
  ('C', 70, 79.99, 2.00, 'Good', TRUE),
  ('D', 60, 69.99, 1.00, 'Satisfactory', TRUE),
  ('E', 50, 59.99, 0.50, 'Marginal Pass', TRUE),
  ('F', 0, 49.99, 0.00, 'Fail', FALSE)
ON CONFLICT (grade) DO NOTHING;

-- ---------------------------------------------------------------- rooms (4)
INSERT INTO exam_rooms (name, building, capacity) VALUES
  ('Hall A', 'Main Building', 120),
  ('Hall B', 'Main Building', 100),
  ('Room 101', 'CS Block', 40),
  ('Room 201', 'Business Block', 50)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------- examinations (3)
INSERT INTO examinations (academic_year_id, semester_id, title, exam_type, start_date, end_date, status, created_by) VALUES
  ((SELECT id FROM academic_years WHERE name='2025-2026'), (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), 'Fall 2025 Midterm Examination', 'midterm', '2025-11-10', '2025-11-20', 'completed', NULL),
  ((SELECT id FROM academic_years WHERE name='2025-2026'), (SELECT id FROM semesters WHERE name='Fall' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), 'Fall 2025 Final Examination', 'final', '2026-01-05', '2026-01-20', 'scheduled', NULL),
  ((SELECT id FROM academic_years WHERE name='2025-2026'), (SELECT id FROM semesters WHERE name='Spring' AND academic_year_id=(SELECT id FROM academic_years WHERE name='2025-2026')), 'Spring 2026 Final Examination', 'final', '2026-06-01', '2026-06-15', 'scheduled', NULL)
ON CONFLICT (academic_year_id, semester_id, title, exam_type) DO NOTHING;

-- ---------------------------------------------------------------- schedules for the Final exam (one per subject)
INSERT INTO exam_schedules (exam_id, subject_id, exam_date, start_time, end_time)
SELECT e.id, sub.id, d, '09:00'::time, '12:00'::time
FROM examinations e CROSS JOIN subjects sub
JOIN (VALUES ('CS-101','2026-01-05'::date),('CS-201','2026-01-07'::date),('CS-301','2026-01-09'::date),
             ('SE-101','2026-01-06'::date),('SE-201','2026-01-08'::date),('BBA-101','2026-01-05'::date),
             ('BBA-201','2026-01-07'::date),('ECON-101','2026-01-06'::date)) AS v(code, d)
  ON v.code = sub.code
WHERE e.title = 'Fall 2025 Final Examination'
ON CONFLICT (exam_id, subject_id) DO NOTHING;

-- Room allocations for the Final exam schedules.
INSERT INTO room_allocations (exam_schedule_id, room_id, invigilator_id, seat_capacity)
SELECT es.id,
  CASE WHEN sub.code LIKE 'CS%' THEN (SELECT id FROM exam_rooms WHERE name='Hall A')
       WHEN sub.code LIKE 'SE%' THEN (SELECT id FROM exam_rooms WHERE name='Hall B')
       ELSE (SELECT id FROM exam_rooms WHERE name='Room 201') END,
  sub.lecturer_id, 60
FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
JOIN examinations e ON e.id = es.exam_id AND e.title = 'Fall 2025 Final Examination'
ON CONFLICT (exam_schedule_id, room_id) DO NOTHING;

-- ---------------------------------------------------------------- midterm marks + results (published)
-- Deterministic demo marks: 62 + ((student_no + subject_no) * 7) % 38  → 62–99.
-- Insert marks for the Midterm exam for every enrolled student/subject.
INSERT INTO marks (exam_id, subject_id, student_id, lecturer_id, obtained_marks, total_marks, status)
SELECT e.id, sub.id, s.id, sub.lecturer_id,
  62 + ((CAST(right(s.student_id, 3) AS INT) + sub.id) * 7) % 38, 100, 'approved'
FROM examinations e
JOIN subjects sub ON TRUE
JOIN students s ON s.department_id = sub.department_id
WHERE e.title = 'Fall 2025 Midterm Examination'
ON CONFLICT (exam_id, subject_id, student_id) DO NOTHING;

-- Results derived from marks + grade scale; midterm results are published.
INSERT INTO results (exam_id, student_id, subject_id, mark_id, obtained_marks, grade, grade_point, is_published, published_at, published_by)
SELECT m.exam_id, m.student_id, m.subject_id, m.id, m.obtained_marks,
  g.grade, g.grade_point, TRUE, now(), NULL
FROM marks m JOIN grade_scales g ON m.obtained_marks BETWEEN g.min_marks AND g.max_marks
WHERE m.exam_id = (SELECT id FROM examinations WHERE title='Fall 2025 Midterm Examination')
ON CONFLICT (exam_id, student_id, subject_id) DO NOTHING;

-- Attendance: everyone present for the Final exam schedules.
INSERT INTO attendance (exam_schedule_id, student_id, room_id, status, marked_by)
SELECT es.id, s.id, (SELECT id FROM exam_rooms WHERE name='Hall A'), 'present',
  NULL
FROM exam_schedules es
JOIN examinations e ON e.id = es.exam_id AND e.title = 'Fall 2025 Final Examination'
JOIN students s ON s.department_id = (SELECT department_id FROM subjects WHERE id = es.subject_id)
ON CONFLICT (exam_schedule_id, student_id) DO NOTHING;

-- ---------------------------------------------------------------- complaints (2) & notifications
INSERT INTO complaints (student_id, exam_id, subject_id, type, description, status) VALUES
  ((SELECT id FROM students WHERE student_id='STU-2024-002'),
   (SELECT id FROM examinations WHERE title='Fall 2025 Midterm Examination'),
   (SELECT id FROM subjects WHERE code='CS-101'), 'rechecking',
   'I believe my answer to question 5 was marked incorrectly. Please recheck.', 'pending'),
  ((SELECT id FROM students WHERE student_id='STU-2024-005'),
   (SELECT id FROM examinations WHERE title='Fall 2025 Midterm Examination'),
   (SELECT id FROM subjects WHERE code='BBA-101'), 'marks_correction',
   'My attendance shows absent but I was present on the exam day.', 'under_review')
ON CONFLICT DO NOTHING;

INSERT INTO notifications (user_id, role_id, title, message, type, created_by) VALUES
  (NULL, (SELECT id FROM roles WHERE name='student'), 'Fall 2025 Final Examination Timetable Published',
   'The timetable for the Fall 2025 Final Examination (5–20 January 2026) is now available. Download your admit card from the student portal.',
   'exam', NULL),
  (NULL, (SELECT id FROM roles WHERE name='student'), 'Midterm Results Published',
   'Midterm results for Fall 2025 have been published. Check your results in the student portal.',
   'result', NULL),
  (NULL, NULL, 'Welcome to the Examination Management System',
   'All examination activities are now managed centrally. Contact the Examination Office for help.',
   'announcement', NULL);

COMMIT;

-- Verification:
--   SELECT 'students', count(*) FROM students UNION ALL
--   SELECT 'lecturers', count(*) FROM lecturers UNION ALL
--   SELECT 'subjects', count(*) FROM subjects UNION ALL
--   SELECT 'marks', count(*) FROM marks UNION ALL
--   SELECT 'results', count(*) FROM results;
-- Expected: students 11, lecturers 6, subjects 8, marks 21, results 21.
