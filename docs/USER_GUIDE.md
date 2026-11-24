# User Guide — University Examination Department Management System

## 1. Overview

This system centralises everything the Examination Department does: student
and lecturer records, subjects, exam timetables and rooms, attendance, marks,
GPA/CGPA results, admit cards, rechecking complaints, reports and audit logs.

**Four roles, one login page** — what you see depends on your role:

| Role | Sees |
| --- | --- |
| Super Admin | Everything, including Users, Audit Logs and Settings/Backup. |
| Examination Officer | Students, Lecturers, Departments, Subjects, Exams, Timetable, Attendance, Marks, Results, Complaints, Reports, Notifications. |
| Lecturer | Assigned subjects and students, exam timetable, marks entry, results. |
| Student | Personal timetable, admit card, published results, complaints. |

> Screenshots are described in text below (e.g. *[Screenshot: Dashboard — eight
> KPI cards across the top, two charts below]*), because this guide is shipped
> as text with the source code.

## 2. Signing in — accounts

Open the app (development: http://localhost:5173) and sign in with your
email address and the password you chose. **No login accounts are seeded**
— the seed file contains sample academic data only (faculties,
departments, lecturers, students, subjects, exams). Create the accounts
once, after migrating:

| Role | Person | How the account is created |
| --- | --- | --- |
| Super Admin | melad | One-time setup: `POST /api/auth/setup-first-admin` with full name `melad`, email `meladakhundzada@gmail.com`, and a password of at least 8 characters that melad chooses himself. Only works while no users exist yet. See `docs/SETUP_GUIDE.md` §7. |
| Examination Officer | abas | Super Admin → Users → create the user with role Examination Officer, once abas's email is known. |
| Lecturer | Eng Irfan | Super Admin → Users → create the user with role Lecturer, once Irfan's email is known. His lecturer record (employee_id `LEC-007`) and his BCS subjects (CS-101, CS-201, CS-301, SE-101, SE-201) are already in the seed — set his email on that row instead of creating a second lecturer record. |
| Student | Zahid | Super Admin / Officer → Users (or Students → Add Student) with role Student, once Zahid's email is known. |

Each person chooses their own password at account creation (minimum
8 characters). **Never share passwords in chat or email.** If you forget
your password, ask the Super Admin to reset it (Users → Reset
password). There is no self-service reset.

## 3. The 12-step examination workflow

This is the full cycle the system is built around. Each step names the role
that does it and where to click.

1. **Admin creates an academic year and semester.**
   Super Admin (or Officer) → Settings / Academic Years → *Add academic year*
   (e.g. `2025-2026`), then *Add semester* (Semester 1, start/end dates).
   Nothing else can be scheduled until a semester exists.
2. **Students are registered and assigned to departments.**
   Officer → Students → *+ Add Student*. Fill student number, name, email,
   department and semester. The student number and email must be unique —
   the form shows an error if either already exists.
   *[Screenshot: Students — table with search box, status filter chips, pagination; "Add Student" opens a modal form.]*
3. **Subjects are assigned to semesters.**
   Officer → Subjects → *+ Add Subject* (code, name, credits, department,
   semester). Then assign a lecturer to each subject.
4. **Examination Officer creates examinations.**
   Officer → Examinations → *+ Create Exam*. Pick the subject, date, start/end
   time and total marks. A subject can have only one exam per semester.
5. **Examination schedules and rooms are assigned.**
   In the same exam form, choose a room (Room ID). The system rejects a room
   that is already booked at an overlapping time. Students see the result in
   Timetable.
6. **Students receive timetables and admit cards.**
   Student → Timetable: date, time, subject and room for every exam.
   Student → Admit Card → *Download admit card (PDF)*. The card lists the
   student, the exam and the room; it is only generated for scheduled exams.
7. **Attendance is recorded during examinations.**
   Officer → Attendance → choose the exam → tick Present / Absent per student
   → *Save*. Absent students are flagged on the marks sheet.
8. **Lecturers enter examination marks.**
   Lecturer → Marks Entry → choose the exam → type each student's marks
   (0 – total marks; anything outside is rejected) → *Submit for approval*.
   Marks can be edited until they are submitted.
   *[Screenshot: Marks Entry — exam picker at the top, a table of students with a marks input per row, "Submit for approval" and (officers only) "Approve marks".]*
9. **Examination Officer reviews and approves marks.**
   Officer → Marks Entry → choose the exam → check the marks → *Approve
   marks* (confirmation dialog). Approved marks are locked for lecturers.
   To send them back, use *Reject* with a reason.
10. **The system calculates grades, GPA and results.**
    Grades and GPA are calculated automatically from the **configurable grade
    scale** (Settings → Grade Scale) when marks are approved — e.g. a typical
    scale is A = 90–100 (4.0), B = 80–89 (3.0), C = 70–79 (2.0), D = 60–69
    (1.0), F = below 60 (0.0). The exact thresholds are a university setting,
    not hard-coded in the app; confirm them with your department.
    GPA = Σ(grade point × credits) ÷ Σ(credits) for the semester;
    CGPA is the same over all semesters.
11. **Admin authorizes result publication.**
    Officer / Super Admin → Results → choose the exam → *Publish results*
    (confirmation dialog). Until publication, students **cannot** see the
    results — the API refuses unpublished results even if a student guesses
    the URL.
12. **Students view and download their results.**
    Student → Results: subject, marks, grade, grade point, semester GPA and
    CGPA. *Download transcript (PDF)* for a printable copy.

## 4. Super Admin

- **Dashboard** — KPIs (students, lecturers, departments, subjects, upcoming /
  completed exams, published results, pending marks) and charts.
  *[Screenshot: Dashboard — eight stat cards; "Exams per month" bar chart; "Exams by status" pie chart; department GPA line chart; recent activity list.]*
- **Users** — create users, assign one of the four roles, deactivate accounts,
  reset passwords. Deactivating a user immediately invalidates their sessions.
  Create the Exam Officer from here: full name `abas`, email
  `abbasaziz07825@gmail.com`, role Examination Officer, with a password
  abas chooses himself (at least 8 characters). A lecturer account also
  creates (or links) the lecturer record — for Eng Irfan use employee_id
  `LEC-007` so his existing record and BCS subjects are linked, not
  duplicated. A student account also creates (or links) the student
  record (needs department, student ID and admission year). You cannot
  delete yourself or the last Super Admin, and you cannot deactivate
  your own account.
- **Departments & Faculties** — create faculties, then departments inside them.
  A department cannot be deleted while students or subjects still belong to it.
- **Settings** — grade scale, academic year/semester, pass thresholds, system
  name. **Backup** — download a database backup; restore from a backup file
  (see `SETUP_GUIDE.md` §9 for the `pg_dump` / `pg_restore` commands).
- **Audit Logs** — every login, create, update, delete, approval and
  publication, with who did it and when. Filter by user, action or date.
- **Fees** — create fee types (Tuition, Exam Fee, Admission, Library,
  Other), assign a fee to one student or a whole department, record
  payments (cash / bank / mobile money), print receipts
  (`REC-2026-0001` …), and see the fee report: total due, collected
  and outstanding, broken down by fee type.

## 5. Examination Officer

- **Students / Lecturers / Subjects** — full CRUD, search, sort, filter and
  pagination; CSV export from Students.
- **Examinations** — create, edit (draft/scheduled only), cancel. Room
  conflicts are rejected with a message naming the clash.
- **Timetable** — the published schedule, printable and exportable (PDF/Excel).
- **Attendance** — record per exam; export the attendance report.
- **Marks** — review lecturer submissions, approve or reject with a reason.
- **Results** — publish / unpublish (unpublishing hides results from students
  again), view department-wise and semester performance reports.
- **Complaints** — see student rechecking requests, change status
  (Received → Under review → Resolved / Rejected), record the outcome.
- **Fees** — assign fee types to students or departments, record
  payments and print receipts, and follow up the Due list
  (unpaid / partial / overdue). A payment can never exceed the
  remaining balance; a fee may be paid in instalments.
- **Reports** — student lists, exam schedules, attendance, marks sheets,
  department-wise results, semester performance, exam statistics — PDF and
  Excel export.
- **Notifications** — post announcements visible on every role's dashboard.

## 6. Lecturer

1. Sign in → Dashboard shows your assigned subjects and pending marks.
2. **Subjects** — your subjects and the students enrolled in each.
3. **Timetable** — when and where your exams run.
4. **Marks Entry** — pick the exam, enter marks, *Submit for approval*.
   - Marks must be between 0 and the exam total (e.g. 0–100).
   - You can edit marks until you submit; after submission, only an officer
     can return them to you (they will appear as Rejected with a reason).
   - Do **not** share marks with students before publication — students only
     see published results.
5. **Results** — view published results for your subjects.

## 7. Student

1. Sign in → Dashboard shows your next exam and any announcements.
2. **Timetable** — your exams with date, time and room. Check it the day
   before each exam; room changes appear here first.
3. **Admit Card** — download and print your admit card (PDF). Bring it to
   every exam. If your name, student number or photo is wrong, contact the
   Examination Office before the exam — do not wait until exam day.
4. **Results** — only **published** results appear, with GPA and CGPA.
   *Download transcript (PDF)* for an official-looking copy.
5. **Complaints / Rechecking** — *New complaint*: choose the subject/exam,
   explain the issue (e.g. "request rechecking"), submit. Track its status;
   the officer's decision and any corrected mark appear there.
6. **Fees** — see your own fee charges (Tuition, Exam Fee, …) with due
   dates, what you have paid and what is still outstanding — all in AFN.
   Pay at the Examination Office and keep the receipt number
   (`REC-2026-0001` …). You cannot see any other student's fees.

## 8. Common tasks

| Task | How |
| --- | --- |
| Search a table | Type in the search box above any table; it filters as you type. |
| Sort a table | Click a column header (↑ / ↓). |
| Filter | Use the filter chips (e.g. Active / Suspended / Graduated on Students). |
| Export | *Export CSV* on Students; PDF/Excel buttons on Reports and Results. |
| Switch language | Header language menu: English / پښتو / دری. Pashto and Dari switch the layout to right-to-left (RTL). |
| Dark mode | Header ☀️/🌙 toggle; your choice is remembered on this device. |
| Change password | Your name menu → Change password (current + new password). |

## 9. Rules and limits to know

- Student numbers and emails are unique; duplicate registration is rejected.
- One exam per subject per semester.
- A room cannot be double-booked at overlapping times.
- Marks are 0 – total marks only, and only the assigned lecturer (or an officer)
  can enter them.
- Unpublished results are invisible to students, including via direct links.
- Deleting a student, lecturer or department is blocked if other records
  depend on it; the error message names the dependency.
- Everything important is written to the audit log.

## 10. Getting help

- Technical problem (login fails, page errors): contact the Super Admin with
  the exact error message and what you clicked.
- Academic question (wrong marks, timetable clash, admit card error): contact
  the Examination Office — use Complaints in the app so there is a record.
- Setup / installation problems: see `docs/SETUP_GUIDE.md`; testing problems:
  see `docs/TESTING_CHECKLIST.md`.
