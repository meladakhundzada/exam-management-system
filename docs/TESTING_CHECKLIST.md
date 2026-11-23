# Testing Checklist — University Examination Department Management System

Run this checklist against a **staging** environment seeded with demo data
(`npm run seed`) before every release and before go-live. Tick each item only
when you have observed the expected result; note the build/date and tester
next to any failure.

**How to use:** copy this file into your test run, mark `[x]` / `[ ]`, and file
bugs with the section number (e.g. `T-3.4`).

---

## 1. Setup & smoke

- [ ] `npm install` succeeds in `backend/` and `frontend/` on Node 20+.
- [ ] `npm run migrate` + `npm run seed` complete without errors.
- [ ] Backend `GET /api/health` returns 200.
- [ ] Frontend `npm run dev` serves the login page at http://localhost:5173.
- [ ] `npm run build` succeeds in both packages (no TypeScript errors).

## 2. Authentication & RBAC

- [ ] Valid demo credentials sign in for all four roles (see `USER_GUIDE.md` §2).
- [ ] Wrong password shows "Invalid email or password" and does **not** reveal whether the email exists.
- [ ] Empty email / password is rejected by client-side validation.
- [ ] Refreshing the page keeps the session (token restore via `/auth/me`).
- [ ] Signing out clears tokens and returns to `/login`.
- [ ] Expired access token is refreshed silently once; a bad refresh token redirects to `/login`.
- [ ] **Super Admin** can open Users, Audit Logs and Settings; other roles get "Access denied" (and the API returns 403, not just a hidden menu item).
- [ ] **Exam Officer** cannot open `/users` or `/settings`.
- [ ] **Lecturer** cannot open `/students` or `/reports`; can open `/marks`, `/subjects`, `/results`.
- [ ] **Student** cannot open `/students`, `/marks`, `/users`; can open `/timetable`, `/results`, `/admit-card`, `/complaints`.
- [ ] Directly typing a forbidden URL (e.g. student → `/users`) is blocked — not just hidden from the sidebar.
- [ ] A deactivated user cannot sign in.
- [ ] Changing your password requires the current password; the old password stops working afterwards.
- [ ] Every login, logout, failed login and role change appears in Audit Logs.

## 3. CRUD — Students, Lecturers, Departments, Subjects

- [ ] Create a student with valid data → appears in the table; student number and email are stored as entered.
- [ ] Create a student with a **duplicate student number** → rejected with a clear error; no second record is created.
- [ ] Create a student with a **duplicate email** → rejected.
- [ ] Create a student with an invalid email / semester 0 or 9 / name under 3 chars → client validation error, no API call.
- [ ] Edit a student → changes persist after refresh.
- [ ] Delete a student → confirmation dialog appears; Cancel keeps the record; Delete removes it.
- [ ] Delete a student who has marks/results → blocked (or handled per the backend rule) with a message naming the dependency.
- [ ] Search filters the table as you type (name, student number, email).
- [ ] Status filter chips (Active / Suspended / Graduated) filter correctly; "All" restores the full list.
- [ ] Sorting by Student No. / Name / Department toggles asc/desc.
- [ ] Pagination: Previous/Next move pages; page count matches the record count.
- [ ] Export CSV downloads a file with the visible students.
- [ ] Create/edit/delete a lecturer, department, faculty and subject follow the same pattern (validation, uniqueness, delete confirmation).
- [ ] A department cannot be deleted while students or subjects belong to it.

## 4. Exam workflow — end to end (the 12 steps)

Do this in order, with the roles named in `USER_GUIDE.md` §3:

- [ ] 1. Super Admin creates academic year `2025-2026` and Semester 1.
- [ ] 2. Officer registers a student in a department.
- [ ] 3. Officer creates a subject for Semester 1 and assigns a lecturer.
- [ ] 4. Officer creates an exam for that subject (date, 09:00–12:00, total 100).
- [ ] 4a. Creating a **second exam for the same subject + semester** is rejected (unique constraint).
- [ ] 5. Officer assigns a room; a second exam in the same room at an overlapping time is rejected with the clash named.
- [ ] 5a. End time ≤ start time is rejected by the form.
- [ ] 6. Student sees the exam in Timetable with the correct room; admit-card PDF downloads and shows the right student, subject, date and room.
- [ ] 7. Officer records attendance (one Present, one Absent) and saves; reloading shows the saved values.
- [ ] 8. Lecturer enters marks for the exam and submits for approval; marks are editable before submission.
- [ ] 9. Officer approves the marks; the lecturer can no longer edit them.
- [ ] 9a. Officer rejects a different exam's marks with a reason; the lecturer sees it as Rejected with that reason and can correct it.
- [ ] 10. Grades/GPA are calculated from the configured grade scale (see §5).
- [ ] 11. Officer publishes the results; before publication the student sees "No published results".
- [ ] 12. Student sees the published result, GPA/CGPA, and can download the transcript PDF.

## 5. GPA / CGPA calculation cases

Use the seeded grade scale (confirm the thresholds in Settings → Grade Scale first; the cases below assume A=90–100/4.0, B=80–89/3.0, C=70–79/2.0, D=60–69/1.0, F<60/0.0 — adjust the expected values if your scale differs):

| Case | Marks (100) | Expected grade | Expected point |
| --- | --- | --- | --- |
| Boundary A | 90 | A | 4.0 |
| Boundary B | 89 | B | 3.0 |
| Boundary C | 79 | C | 2.0 |
| Boundary D | 60 | D | 1.0 |
| Fail | 59 | F | 0.0 |
| Zero | 0 | F | 0.0 |
| Perfect | 100 | A | 4.0 |

- [ ] Each boundary case above produces the expected grade/point.
- [ ] GPA: two subjects, 3 credits each, grades A (4.0) and C (2.0) → GPA = (4×3 + 2×3) / 6 = **3.00**.
- [ ] GPA weights credits: 3-credit A + 1-credit F → (12 + 0) / 4 = **3.00** (not 2.00).
- [ ] CGPA spans semesters: Semester 1 GPA 3.00 (6 credits) + Semester 2 GPA 4.00 (6 credits) → CGPA **3.50**.
- [ ] A failed subject (F) still counts its credits in the GPA denominator.
- [ ] Changing the grade scale in Settings changes newly calculated grades; already-published results are **not** silently rewritten.
- [ ] Marks of 0.5 steps (e.g. 89.5) are stored and graded correctly.

## 6. Marks entry

- [ ] Marks above the total (e.g. 101/100) are rejected with "between 0 and …".
- [ ] Negative marks are rejected.
- [ ] A blank mark blocks submission and names the student.
- [ ] Non-numeric input is rejected.
- [ ] Submitting marks for an exam with no enrolled students shows a clear empty state.
- [ ] Approving marks shows a confirmation dialog; Cancel does not approve.
- [ ] After approval, the marks sheet shows status APPROVED.

## 7. Admit card & complaints

- [ ] Admit card PDF contains the student's name/number, exam title, date, time and room — and no other student's data.
- [ ] Admit card for a cancelled exam is not generated (error, not a blank card).
- [ ] Student submits a rechecking complaint → it appears in the officer's Complaints list as Received.
- [ ] Officer changes status to Under review, then Resolved, with an outcome note; the student sees the updated status.
- [ ] A student cannot see another student's complaints (API returns 403 / empty).

## 8. Results & publication

- [ ] Unpublished results: student API call returns no rows (check via the UI **and** a direct `curl` with the student's token).
- [ ] Published results appear immediately for the student after publication.
- [ ] Unpublishing hides them again.
- [ ] A student requesting **another** student's results by ID gets 403.
- [ ] Transcript PDF downloads and matches the on-screen results.

## 9. Reports & exports

- [ ] Student list exports (CSV) with the current filter applied.
- [ ] Exam schedule exports (PDF) — dates, times and rooms are correct.
- [ ] Attendance report exports and matches the saved attendance.
- [ ] Marks sheet exports (Excel) — one row per student, marks as numbers.
- [ ] Department-wise results report shows the right department only.
- [ ] Semester performance report shows GPA and pass rate per department.
- [ ] Exporting with no data shows an empty report, not a crash.

## 10. Security

- [ ] **SQL injection:** entering `' OR '1'='1` in the login email and in the student search does not log in / does not return all rows.
- [ ] **XSS:** a student name containing `<script>alert(1)</script>` is stored and rendered as text, never executed (check the Students table and the admit card).
- [ ] **Unpublished results:** see §8 — no student can read them via UI or direct API call.
- [ ] **IDOR:** a student cannot fetch another student's profile, marks or admit card by changing the ID in the URL / API call.
- [ ] Passwords are never returned by any API response (inspect `/auth/me` and `/users` payloads).
- [ ] JWTs are not accepted after logout (refresh token revoked) — sign in again is required.
- [ ] File uploads (if enabled) reject executables and oversized files.
- [ ] Audit log records creates, updates, deletes, approvals, publications and failed logins with actor + timestamp.

## 11. Dashboard & charts

- [ ] KPI cards match the database counts (spot-check total students against `SELECT count(*) FROM students`).
- [ ] "Pending Marks" equals the number of exams with unsubmitted marks.
- [ ] Monthly exams bar chart, status pie chart and department GPA line chart render with seeded data and show no console errors.
- [ ] Recent activity lists the latest actions in reverse-chronological order.
- [ ] Dashboard loads in under 3 s on the staging data set.

## 12. Responsive, dark mode & i18n

- [ ] Desktop (1280px): sidebar visible, tables full-width, no horizontal overflow.
- [ ] Tablet (768px): sidebar collapses to a hamburger; cards stack to 2 columns.
- [ ] Mobile (390px): tables scroll horizontally inside their card; forms are single-column; no text is clipped.
- [ ] Dark mode toggle works on Dashboard, Students, Exams, Marks and Results; no unreadable (light-on-light / dark-on-dark) text.
- [ ] Dark-mode choice persists after refresh.
- [ ] Language switch to Pashto: UI strings change, layout flips to RTL (`dir="rtl"`), sidebar moves to the right.
- [ ] Language switch to Dari: same RTL check.
- [ ] Switching back to English restores LTR.

## 13. Regression after fixes

- [ ] Re-run §2, §4 and §8 after any auth, marks or results change.
- [ ] Re-run §10 after any API change.
- [ ] Record build, date, tester and result below.

| Date | Build / commit | Tester | Pass / Fail | Notes |
| --- | --- | --- | --- | --- |
| | | | | |
