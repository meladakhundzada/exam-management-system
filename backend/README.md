# University Examination Department Management System — Backend

Express + PostgreSQL API for the Examination Department. Frontend lives in
`../frontend/`; the database schema and seed data live in `../database/`.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | PostgreSQL 14+ (`pg` pool, parameterized queries only) |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`, cost 10) |
| Validation | `express-validator` (server-side, every mutating route) |
| Security | `helmet`, CORS allow-list, RBAC middleware |
| Exports | `pdfkit` (PDF), `exceljs` (XLSX) |

## Prerequisites

- Node.js 18+ and npm
- PostgreSQL 14+ running locally (or a hosted instance)
- `psql` on your PATH (for the migration commands below)

## Setup

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Create the database
createdb exam_management
# — or in psql:  CREATE DATABASE exam_management;

# 3. Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL and a long random JWT_SECRET (≥32 chars).

# 4. Run migrations + seed data (one command)
npm run migrate
# Equivalent manual steps:
#   psql "$DATABASE_URL" -f ../database/migrations/001_init.sql
#   psql "$DATABASE_URL" -f ../database/migrations/002_seed.sql
# To load only the empty schema:  npm run migrate:schema
# To re-load seed data only:     npm run seed

# 5. Start the API
npm start          # production
npm run dev        # development (auto-restart on change)

# 6. Smoke test
curl http://localhost:5000/api/health
# → {"success":true,"status":"ok","db":"connected",...}
```

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `5000` | API listen port |
| `NODE_ENV` | No | `development` | `production` enforces `JWT_SECRET` + `DATABASE_URL` |
| `DATABASE_URL` | Yes in prod | `postgres://postgres:postgres@localhost:5432/exam_management` | Postgres connection string |
| `JWT_SECRET` | Yes in prod | dev-only placeholder | Long random string; rotating it logs everyone out |
| `JWT_EXPIRES_IN` | No | `8h` | Token lifetime |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Comma-separated allowed origins |
| `PG_POOL_MAX` | No | `20` | Postgres pool size |
| `LOG_QUERIES` | No | `0` | Set `1` to log SQL timings |

## Super Admin setup

Two supported paths — pick one, then **change the password immediately**:

**Option A — one-time bootstrap endpoint (recommended for production).**
With an *empty* `users` table, create the first admin via the API:

```bash
curl -X POST http://localhost:5000/api/auth/setup-first-admin \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"melad","email":"meladakhundzada@gmail.com","password":"<choose-a-password-of-8-or-more-characters>"}'
# → 201 with the created user. Later calls return 403 ("Setup already completed").
```

**Option B — no seeded login accounts (by design).**
`npm run migrate` seeds sample academic data only (faculties,
departments, lecturers, students, subjects, exams) — it creates **no**
login accounts. After migrating, create melad as above, then create
the Examination Officer (abas), Lecturer (Eng Irfan) and students
(including Zahid) from the Users page, each with the password they
choose (minimum 8 characters). Never write real passwords in files
or chat.

Log in with `POST /api/auth/login`, then change the password with
`POST /api/auth/change-password` (see `../database/API.md`).

## Project layout

```
backend/
├── package.json
├── .env.example
├── README.md                 ← this file
└── src/
    ├── server.js             ← app entry: middleware, routes, /api/health
    ├── config/db.js          ← pg pool, query(), withTransaction()
    ├── middleware/
    │   ├── auth.js           ← JWT authenticate, requireRole, requirePermission
    │   └── validate.js       ← express-validator wrapper, pagination, errorHandler
    ├── utils/
    │   ├── audit.js          ← logAudit() → audit_logs
    │   └── gpa.js            ← gradeForMarks, calculateGpa, studentGpa (DB-driven scale)
    └── routes/
        ├── auth.js           ← login, setup-first-admin, change-password, me
        ├── students.js       ← students CRUD, admit-card data, complaints
        ├── lecturers.js       ← lecturers CRUD, assigned subjects
        ├── exams.js          ← exams, schedules, rooms, allocations, attendance
        ├── marks.js          ← marks entry/bulk, submit, approve, reject, pending
        ├── results.js        ← calculate, publish/unpublish, transcript, grade scales
        └── reports.js        ← dashboard stats, PDF/XLSX exports, notifications, audit logs
```

## Examination workflow (as implemented)

1. Admin creates academic year + semester (`/api/reference` shows them; seed data includes 2025-2026 / Fall).
2. Officer registers students (`POST /api/students`) — duplicate `student_id`/`email` rejected with 409.
3. Subjects are assigned to semesters/lecturers (seeded; manage via `subjects` in the DB or the frontend).
4. Officer creates an exam (`POST /api/exams`) and its timetable (`POST /api/exams/:id/schedules`), then allocates rooms (`POST /api/exams/schedules/:scheduleId/allocate`).
5. Students fetch timetable + admit-card data (`GET /api/students/:id/admit-card?exam_id=`) and the PDF (`GET /api/reports/admit-card/:studentId?exam_id=`).
6. Attendance is recorded (`POST /api/exams/schedules/:scheduleId/attendance`).
7. Lecturers enter marks (`POST /api/marks` / `/bulk`, only for their own subjects) and submit them (`POST /api/marks/:id/submit`).
8. Officer reviews pending marks (`GET /api/marks/pending/list`) and approves/rejects them.
9. Officer calculates results (`POST /api/results/calculate/:examId`) — grades/GPA come from the configurable `grade_scales` table.
10. Officer publishes (`POST /api/results/publish/:examId`); only then can students see results (`GET /api/results/student/:studentId`).

## Security notes

- Passwords are bcrypt-hashed (cost 10); plaintext is never stored or logged.
- Every SQL statement is parameterized — no string-concatenated queries.
- JWTs expire (default 8h); protected routes require `Authorization: Bearer <token>`.
- Students are force-filtered to their own, **published** results in every query.
- All mutations are written to `audit_logs` (viewable at `GET /api/reports/audit-logs`, super_admin only).
- In production: put the API behind HTTPS, set a strong `JWT_SECRET`, restrict `CORS_ORIGIN`, add rate limiting on `/api/auth/login`. No login accounts are seeded — create them as described above.

## Testing checklist (manual smoke test)

```bash
TOKEN=$(curl -s -X POST localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"meladakhundzada@gmail.com","password":"<melad-password>"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
curl -H "Authorization: Bearer $TOKEN" localhost:5000/api/reports/dashboard
curl -H "Authorization: Bearer $TOKEN" 'localhost:5000/api/students?page=1&limit=5&search=Fatima'
curl -H "Authorization: Bearer $TOKEN" localhost:5000/api/results/student/1
curl -H "Authorization: Bearer $TOKEN" localhost:5000/api/reports/students/export?format=xlsx -o students.xlsx
```

Expected: dashboard counts `total_students: 11`, `total_lecturers: 6`,
`total_departments: 4`, `total_subjects: 8`; student 1 has published midterm
results with a CGPA; the XLSX download contains 11 student rows.
