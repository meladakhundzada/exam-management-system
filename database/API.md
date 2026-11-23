# University Examination Department Management System — API Documentation

**Version:** 1.0.0 · **Base URL:** `http://localhost:5000/api` (production: replace host/port and use HTTPS)
**Auth:** JWT Bearer token · **Content-Type:** `application/json` unless noted
**Response envelope:** success → `{ "success": true, "data": … }` (lists add `pagination`);
error → `{ "success": false, "error": "…", "details": […] }` (validation errors only).

## Authentication

All routes except `POST /api/auth/login`, `POST /api/auth/setup-first-admin`
and `GET /api/health` require:

```
Authorization: Bearer <jwt>
```

Obtain a token by logging in. Tokens expire after `JWT_EXPIRES_IN` (default 8h).

### Roles

| Role | Value in token (`role`) | Typical access |
|---|---|---|
| Super Admin | `super_admin` | Everything, incl. user deletion, grade scales, audit logs |
| Examination Officer | `exam_officer` | Students, exams, schedules, rooms, attendance, marks approval, results publication, reports |
| Lecturer | `lecturer` | Own subjects/students, marks entry + submit, read exams/results |
| Student | `student` | Own profile, timetable, admit card, **published** results only, own complaints |

## Error codes

| HTTP | Meaning | Example |
|---|---|---|
| 400 | Validation / constraint failure | Missing field, `obtained_marks` > 100, bad FK |
| 401 | Missing / invalid / expired token, wrong password | `{"error":"Authentication required"}` |
| 403 | Authenticated but role/ownership forbids it | Student requesting another student's results |
| 404 | Record or route not found | Unknown student id |
| 409 | Conflict — duplicate unique value, or wrong status transition | Duplicate `student_id`; approving a draft mark |
| 500 | Unexpected server error | DB unreachable (check `/api/health`) |
| 503 | Health check: DB unreachable | `GET /api/health` |

Pagination (list endpoints): `?page=1&limit=20&search=…` — `limit` is capped at 100.
Response: `{ "success": true, "data": [...], "pagination": { "page": 1, "limit": 20, "total": 12, "totalPages": 1 } }`.

---

## 1. Health & reference data

### `GET /api/health` — public
```json
// 200
{ "success": true, "status": "ok", "db": "connected", "time": "2026-01-05T09:00:00.000Z" }
```

### `GET /api/reference` — any authenticated role
Faculties, departments, academic years, semesters and subjects for form dropdowns.
```json
// 200 — data: { faculties: […], departments: […], academic_years: […], semesters: […], subjects: […] }
```

## 2. Auth — `/api/auth`

### `POST /api/auth/login` — public
```json
// Request — use the Super Admin account created via setup-first-admin.
{ "email": "meladakhundzada@gmail.com", "password": "<your-password>" }
// 200
{ "success": true, "token": "eyJhbGciOiJIUzI1NiIs…",
  "user": { "id": 1, "full_name": "melad", "email": "meladakhundzada@gmail.com", "role": "super_admin" } }
// 401 — { "success": false, "error": "Invalid email or password" }
```

### `POST /api/auth/setup-first-admin` — public, one-time only
Works only while the `users` table is empty; afterwards `403 {"error":"Setup already completed: users exist"}`.
```json
// Request — first Super Admin (melad). Password is chosen by melad here,
// minimum 8 characters; it is never written down anywhere else.
{ "full_name": "melad", "email": "meladakhundzada@gmail.com", "password": "<choose-a-password-of-8-or-more-characters>" }
// 201 — { "success": true, "data": { "id": 1, "full_name": "melad", "email": "meladakhundzada@gmail.com" } }
```

### `POST /api/auth/change-password` — any role
```json
// Request
{ "current_password": "<current-password>", "new_password": "<new-password-of-8-or-more-characters>" }
// 200 — { "success": true, "message": "Password changed" }
// 401 if current_password is wrong.
```

### `GET /api/auth/me` — any role
Returns the current user plus their permission names.
```json
// 200 — data: { "id": 1, "full_name": "…", "email": "…", "phone": "…", "role": "super_admin", "permissions": ["users.create", "students.read", …] }
```

## 3. Students — `/api/students`

| Method & path | Roles | Description |
|---|---|---|
| `GET /api/students?page&limit&search&department_id&status` | super_admin, exam_officer, lecturer | Paginated list; `search` matches name / student_id / email |
| `GET /api/students/:id` | all (students: own record only) | Profile + `cgpa` (published results) |
| `POST /api/students` | super_admin, exam_officer | Register student (+ login user; the caller supplies `password`, minimum 8 characters) |
| `PUT /api/students/:id` | super_admin, exam_officer | Update student |
| `DELETE /api/students/:id` | super_admin | Delete (blocked if marks/results reference the student) |
| `GET /api/students/:id/admit-card?exam_id=` | super_admin, exam_officer, student (own) | Admit-card data: student + timetable with rooms |
| `POST /api/students/:id/complaints` | super_admin, exam_officer, student (own) | File a rechecking complaint |
| `GET /api/students/:id/complaints` | super_admin, exam_officer, student (own) | List a student's complaints |

```json
// POST /api/students — request (password is supplied by the caller, minimum 8 characters)
{ "student_id": "STU-2025-010", "full_name": "Ahmad Farid", "email": "ahmad.farid@student.university.edu",
  "department_id": 1, "admission_year": 2025, "current_semester": 1, "gender": "male",
  "phone": "+93 700 200 020", "date_of_birth": "2005-03-01", "guardian_name": "Karim Farid",
  "password": "<choose-a-password-of-8-or-more-characters>" }
// 201 — { "success": true, "data": { "id": 13, "student_id": "STU-2025-010", … },
//         "message": "Student registered." }
// 409 on duplicate student_id or email.

// GET /api/students/1/admit-card?exam_id=2 — 200 (excerpt)
{ "success": true, "data": { "student": { "student_id": "STU-2024-002", "full_name": "Fatima Noori", "department_name": "Computer Science" },
  "exam_id": 2, "timetable": [ { "exam_date": "2026-01-05", "start_time": "09:00:00", "end_time": "12:00:00",
  "subject_code": "CS-101", "subject_title": "Introduction to Programming", "room_name": "Hall A", "building": "Main Building" } ] } }

// POST /api/students/1/complaints — request
{ "type": "rechecking", "exam_id": 1, "subject_id": 1, "description": "Question 5 was marked incorrectly, please recheck." }
// 201 — { "success": true, "data": { "id": 3, "student_id": 1, "type": "rechecking", "status": "pending", … } }
```

## 4. Lecturers — `/api/lecturers`

| Method & path | Roles | Description |
|---|---|---|
| `GET /api/lecturers?page&limit&search&department_id` | super_admin, exam_officer | Paginated list |
| `GET /api/lecturers/:id` | super_admin, exam_officer, lecturer | Lecturer + assigned `subjects: […]` |
| `POST /api/lecturers` | super_admin, exam_officer | Create lecturer (+ login user; the caller supplies `password`, minimum 8 characters) |
| `PUT /api/lecturers/:id` | super_admin, exam_officer | Update lecturer |
| `DELETE /api/lecturers/:id` | super_admin | Delete |

```json
// POST /api/lecturers — request (password is supplied by the caller, minimum 8 characters)
{ "employee_id": "LEC-008", "full_name": "Dr. Omar Farid", "email": "omar.farid@university.edu",
  "department_id": 1, "designation": "Lecturer", "qualification": "MSc Computer Science", "gender": "male", "joining_date": "2025-09-01",
  "password": "<choose-a-password-of-8-or-more-characters>" }
// 201 — { "success": true, "data": { "id": 7, "employee_id": "LEC-008", … } }
```

## 5. Examinations, schedules, rooms, attendance — `/api/exams`

| Method & path | Roles | Description |
|---|---|---|
| `GET /api/exams?search&status&semester_id` | any | List exams (with `schedule_count`, `published_results`) |
| `GET /api/exams/:id` | any | Exam + full `schedules: […]` (room + invigilator) |
| `POST /api/exams` | super_admin, exam_officer | Create exam |
| `PUT /api/exams/:id` | super_admin, exam_officer | Update exam (incl. `status`: draft/scheduled/ongoing/completed/cancelled) |
| `DELETE /api/exams/:id` | super_admin | Delete exam (cascades to schedules) |
| `POST /api/exams/:id/schedules` | super_admin, exam_officer | Add a timetable row for a subject |
| `DELETE /api/exams/:examId/schedules/:scheduleId` | super_admin, exam_officer | Remove a timetable row |
| `GET /api/exams/rooms/list` | any | List exam rooms |
| `POST /api/exams/rooms` | super_admin, exam_officer | Create a room |
| `POST /api/exams/schedules/:scheduleId/allocate` | super_admin, exam_officer | Assign room + invigilator to a schedule |
| `POST /api/exams/schedules/:scheduleId/attendance` | super_admin, exam_officer | Bulk upsert attendance records |
| `GET /api/exams/schedules/:scheduleId/attendance` | any | Attendance for a schedule |

```json
// POST /api/exams — request
{ "academic_year_id": 2, "semester_id": 1, "title": "Fall 2025 Final Examination",
  "exam_type": "final", "start_date": "2026-01-05", "end_date": "2026-01-20" }
// 201 — { "success": true, "data": { "id": 4, "title": "Fall 2025 Final Examination", "status": "scheduled", … } }
// 409 on a duplicate (academic_year_id, semester_id, title, exam_type).

// POST /api/exams/2/schedules — request
{ "subject_id": 1, "exam_date": "2026-01-05", "start_time": "09:00", "end_time": "12:00" }

// POST /api/exams/schedules/1/allocate — request
{ "room_id": 1, "seat_capacity": 60, "invigilator_id": 1 }

// POST /api/exams/schedules/1/attendance — request
{ "records": [ { "student_id": 1, "status": "present", "room_id": 1 }, { "student_id": 2, "status": "absent" } ] }
// 200 — { "success": true, "data": [ { "id": 25, "status": "present", … }, … ] }
```

## 6. Marks — `/api/marks`

Status flow: `draft → submitted → approved | rejected`. Only `approved` marks
feed result calculation. Lecturers can only enter marks for subjects assigned
to them (`subjects.lecturer_id`).

| Method & path | Roles | Description |
|---|---|---|
| `GET /api/marks?exam_id&subject_id&student_id&status` | any (scoped: lecturers see own subjects, students see own marks) | Paginated marks |
| `POST /api/marks` | super_admin, exam_officer, lecturer | Enter one mark (draft; upserts on duplicate) |
| `POST /api/marks/bulk` | super_admin, exam_officer, lecturer | Upsert a whole class: `{ exam_id, subject_id, marks: [{ student_id, obtained_marks }] }` |
| `POST /api/marks/:id/submit` | super_admin, exam_officer, lecturer | draft → submitted |
| `POST /api/marks/:id/approve` | super_admin, exam_officer | submitted/draft → approved |
| `POST /api/marks/:id/reject` | super_admin, exam_officer | submitted/draft → rejected (`{ "reason": "…" }`) |
| `GET /api/marks/pending/list` | super_admin, exam_officer | Submitted marks awaiting approval (+ `count`) |

```json
// POST /api/marks/bulk — request
{ "exam_id": 2, "subject_id": 1, "marks": [ { "student_id": 1, "obtained_marks": 85 }, { "student_id": 2, "obtained_marks": 78 } ] }
// 201 — { "success": true, "data": [ { "id": 30, "obtained_marks": 85, "status": "draft", … }, … ] }
// 400 if any obtained_marks is outside 0–100.  409 if a mark is submitted/approved and then re-approved out of order.
```

## 7. Results — `/api/results`

Grades/GPA come from the configurable `grade_scales` table
(A 90–100 → 4.00, B 80–89.99 → 3.00, C 70–79.99 → 2.00, D 60–69.99 → 1.00,
E 50–59.99 → 0.50, F 0–49.99 → 0.00). GPA = Σ(grade_point × credit_hours) / Σ(credit_hours).

| Method & path | Roles | Description |
|---|---|---|
| `POST /api/results/calculate/:examId` | super_admin, exam_officer | Build/update results from approved marks (idempotent) |
| `POST /api/results/publish/:examId` | super_admin, exam_officer | Publish all results for the exam; exam → `completed` |
| `POST /api/results/unpublish/:examId` | super_admin, exam_officer | Withdraw publication |
| `GET /api/results?exam_id&student_id&department_id` | any (students: own + published only) | Paginated results |
| `GET /api/results/student/:studentId` | any (students: own only) | Transcript: `results: […]`, `cgpa`, `total_subjects` |
| `GET /api/results/grade-scales/list` | any | Grading table |
| `PUT /api/results/grade-scales/:grade` | super_admin | Update a grade band (`min_marks`, `max_marks`, `grade_point`, `is_passing`) |
| `GET /api/results/complaints/list?status=` | super_admin, exam_officer | All complaints |
| `PUT /api/results/complaints/:id` | super_admin, exam_officer | Resolve: `{ "status": "resolved", "resolution": "…" }` |

```json
// POST /api/results/calculate/2 — 200
{ "success": true, "data": [ { "id": 25, "exam_id": 2, "student_id": 1, "subject_id": 1,
  "obtained_marks": 85, "grade": "B", "grade_point": 3, "gpa": 3.0, "is_published": false } ],
  "message": "1 result(s) calculated from approved marks" }

// GET /api/results/student/1 — 200 (published only)
{ "success": true, "data": { "cgpa": 3.25, "total_subjects": 3,
  "results": [ { "subject_code": "CS-101", "subject_title": "Introduction to Programming",
  "obtained_marks": 85, "grade": "B", "grade_point": 3, "exam_title": "Fall 2025 Midterm Examination" } ] } }
```

## 8. Reports, exports, notifications, audit — `/api/reports`

| Method & path | Roles | Description |
|---|---|---|
| `GET /api/reports/dashboard` | any | Counts + `students_by_department`, `grade_distribution`, `recent_activities` |
| `GET /api/reports/students/export?format=xlsx\|pdf&department_id=` | super_admin, exam_officer | Student list download (XLSX default) |
| `GET /api/reports/exams/:examId/schedule/export?format=xlsx\|pdf` | super_admin, exam_officer | Timetable download |
| `GET /api/reports/results/:examId/export?format=xlsx\|pdf&department_id=` | super_admin, exam_officer | Published results download |
| `GET /api/reports/admit-card/:studentId?exam_id=` | any (students: own only) | Admit-card **PDF** |
| `GET /api/reports/student/:studentId/result-pdf` | any (students: own only) | Individual result sheet **PDF** (published only) |
| `GET /api/reports/notifications` | any | Own + role + broadcast notifications (latest 50) |
| `POST /api/reports/notifications` | super_admin, exam_officer | Create notification (`{ title, message, type, role_id?, user_id? }`) |
| `GET /api/reports/audit-logs?page&limit` | super_admin | Audit history |

```json
// GET /api/reports/dashboard — 200 (excerpt)
{ "success": true, "data": { "total_students": 11, "total_lecturers": 6, "total_departments": 4,
  "total_subjects": 8, "upcoming_exams": 1, "completed_exams": 2, "published_results": 21,
  "pending_marks": 0, "pending_complaints": 1,
  "students_by_department": [ { "department": "Computer Science", "students": 2 } ],
  "grade_distribution": [ { "grade": "A", "count": 5 }, { "grade": "B", "count": 9 } ],
  "recent_activities": [ { "action": "auth.login", "entity_type": "users", "user_name": "melad", "created_at": "…" } ] } }
```

Export endpoints return a file download (`Content-Disposition: attachment`),
not JSON — e.g. `curl -H "Authorization: Bearer $TOKEN" "localhost:5000/api/reports/students/export?format=xlsx" -o students.xlsx`.

## Audit logging

Every mutation (login, create/update/delete, marks submit/approve/reject,
results calculate/publish, complaint resolution, attendance) writes a row to
`audit_logs` (`user_id, action, entity_type, entity_id, old_values, new_values,
ip_address, user_agent, created_at`). View it at `GET /api/reports/audit-logs`
(super_admin only). Audit-write failures are logged server-side and never
fail the user's request.

## Database backup & restore

The API does not expose backup over HTTP (a backup endpoint would leak data).
Use Postgres tooling instead:

```bash
# Backup
pg_dump "$DATABASE_URL" -Fc -f exam_management_$(date +%F).dump
# Restore into an empty database
createdb exam_management_restore
pg_restore -d exam_management_restore exam_management_2026-01-05.dump
```
