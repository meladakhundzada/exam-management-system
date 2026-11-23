# Setup Guide — University Examination Department Management System

## 1. What you are installing

| Layer | Technology | Folder |
| --- | --- | --- |
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS 3, React Router 6, Recharts, Axios | `frontend/` |
| Backend | Node.js 20 + Express (JavaScript), JWT auth, bcrypt, express-validator | `backend/` |
| Database | PostgreSQL 15+ | — (external service) |
| Exports | PDF (pdfkit) and Excel (ExcelJS) on the backend | `backend/src/utils/` |

> If the `backend/` folder is not in your copy yet, it is the companion package
> to this frontend: the frontend will not work without it. The API contract it
> must implement is in `database/API.md` (or, if absent, in `frontend/src/services/api.ts`).

## 2. Prerequisites

- **Node.js 20+** and npm 10+ — check with `node -v && npm -v`.
- **PostgreSQL 15+** running locally or on a reachable server — check with `psql --version`.
- **Git**.
- A terminal (bash / PowerShell). Commands below are bash; PowerShell equivalents
  are noted where they differ.

## 3. Clone and install

```bash
git clone <your-repo-url> exam-management-system
cd exam-management-system

# Backend
cd backend
npm install
cp .env.example .env
# edit .env (see §4)

# Frontend (new terminal, or after the backend step)
cd ../frontend
npm install
cp .env.example .env        # if the file exists; otherwise create .env by hand
```

Frontend `.env`:

```env
VITE_API_URL=http://localhost:5000/api
```

## 4. Backend environment (`.env`)

```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgres://uems:CHANGE_ME@localhost:5432/uems
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_EXPIRES_IN=8h
CORS_ORIGIN=http://localhost:5173
# Optional: SMTP for notifications (leave unset to log emails to console in dev)
# SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASS= SMTP_FROM=noreply@university.edu
```

**Never commit `.env`.** Rotate `JWT_SECRET` if it was
ever shared. In production set it from your secret manager, not from a file
in the repo.

## 5. Database: create, migrate, seed

```bash
# 1. Create the database and user (run once)
psql -U postgres -c "CREATE USER uems WITH PASSWORD 'CHANGE_ME';"
psql -U postgres -c "CREATE DATABASE uems OWNER uems;"

# 2. Run migrations (creates all tables, keys, indexes — see §6)
cd backend
npm run migrate          # schema (001_init.sql) + seed (002_seed.sql)
# Schema only:  npm run migrate:schema
# Seed only:    npm run seed

# 3. Seed sample academic data: faculties, departments, subjects, rooms,
#    lecturers, students, an academic year + semester, exams and a grade scale.
#    The seed creates NO login accounts — create them in §7 below.

Verify:

```bash
psql "postgres://uems:CHANGE_ME@localhost:5432/uems" -c "\dt"
psql "postgres://uems:CHANGE_ME@localhost:5432/uems" -c "SELECT count(*) FROM students;"
```

### What the migrations create

Normalized tables with primary/foreign keys and unique constraints that
prevent duplicate registrations and duplicate exam records:

`users, roles, permissions, role_permissions, faculties, departments,
academic_years, semesters, lecturers, students, subjects, enrollments,
examinations, examination_schedules, examination_rooms, room_allocations,
attendance, marks, results, grade_scales, complaints, notifications,
audit_logs` — plus unique indexes on `students(student_no)`,
`students(email)`, `examinations(subject_id, semester_id)` and
`marks(exam_id, student_id)`.

## 6. Run the app (development)

```bash
# Terminal 1 — backend on http://localhost:5000
cd backend
npm run dev

# Terminal 2 — frontend on http://localhost:5173
cd frontend
npm run dev
```

Open http://localhost:5173 and sign in with the Super Admin account you
created in §7 below (melad). There are no seeded demo accounts.

Health checks:

```bash
curl http://localhost:5000/api/health        # expect {"status":"ok",...}
curl http://localhost:5173                      # expect the login page HTML
```

## 7. Initial Super Admin account

No login account is seeded. Create the first Super Admin with the
one-time endpoint (it only works while the `users` table is empty):

```bash
curl -X POST http://localhost:5000/api/auth/setup-first-admin \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"melad","email":"meladakhundzada@gmail.com","password":"<choose-a-password-of-8-or-more-characters>"}'
# → 201 with the created user. Choose the password yourself (minimum 8
# characters) and never write it in a file or chat. Later calls return 403.
```

Then sign in as melad and create the other accounts from the Users
page: Examination Officer (abas), Lecturer (Eng Irfan) and students
(including Zahid), each with their own email and a password they choose
(minimum 8 characters). Irfan's lecturer record (employee_id `LEC-007`)
and his BCS subjects are already seeded — set his email on that row
instead of creating a second lecturer record for him.

If the endpoint is unavailable, create the user via SQL only as a last
resort — never store a plain-text password:

```sql
-- Generate the hash first:
--   node -e "console.log(require('bcryptjs').hashSync('<choose-a-password-of-8-or-more-characters>',10))"
INSERT INTO users (role_id, full_name, email, password_hash)
VALUES ((SELECT id FROM roles WHERE name='super_admin'), 'melad',
        'meladakhundzada@gmail.com', '<bcrypt hash>')
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;
```

## 8. Production checklist

- [ ] `NODE_ENV=production`; `npm run build` in both `backend/` and `frontend/`.
- [ ] Serve the frontend build from a static host / reverse proxy (nginx) with
      HTTPS; set `VITE_API_URL` to the public API URL **at build time**.
- [ ] PostgreSQL: strong password, TLS, restricted network access, daily backups (§9).
- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` from the secret manager; different
      values from dev.
- [ ] `CORS_ORIGIN` set to the exact frontend origin (no `*`).
- [ ] Rate-limit login (`/auth/login`) and enable security headers (helmet).
- [ ] No login accounts are seeded — the accounts in §7 exist and every
      person has the correct role; delete or disable any account that is
      not needed.
- [ ] Configure the grade scale, academic year and semester in Settings —
      do not rely on seed values for a real term.
- [ ] Set up log rotation and monitor `audit_logs` for failed logins.
- [ ] Run the full `docs/TESTING_CHECKLIST.md` against the production-like
      staging environment before go-live.

## 9. Backup and restore (PostgreSQL)

```bash
# --- Backup (run daily, e.g. cron at 02:00) ---
pg_dump -U uems -h localhost -d uems -F c -f "uems-$(date +%F).dump"
# Plain-SQL alternative:
pg_dump -U uems -h localhost -d uems -f "uems-$(date +%F).sql"

# --- Restore (custom format) ---
pg_restore -U uems -h localhost -d uems --clean --if-exists "uems-2026-11-23.dump"
# --- Restore (plain SQL) ---
psql -U uems -h localhost -d uems -f "uems-2026-11-23.sql"

# --- Restore into a fresh database (safest for a full restore) ---
dropdb -U postgres uems_new && createdb -U postgres -O uems uems_new
pg_restore -U uems -h localhost -d uems_new "uems-2026-11-23.dump"
```

Also back up uploaded files (admit cards / attachments) and `.env` (separately,
encrypted) — a database dump alone does not include them. Test a restore at
least once before go-live; an untested backup is not a backup.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Cannot reach the server` in the UI | Backend not running, or `VITE_API_URL` wrong. Rebuild the frontend after changing `.env` (Vite inlines it at build time). |
| `401` on every request after login | Expired/invalid token, or `JWT_SECRET` changed since login — sign in again. |
| `403` on a page you expect to open | Your role lacks that route (see `frontend/src/context/AuthContext.tsx` `ROLE_ROUTES`) — ask a Super Admin. |
| Migration fails with `relation already exists` | Database was partially migrated — restore from backup or drop and re-create the DB, then re-run migrate + seed. |
| Seed fails with duplicate-key errors | Seed was already run — it is idempotent only if run once per fresh DB; reset the DB or skip seeding. |
| Port 5000 / 5173 already in use | Another process holds it: `lsof -i :5000` (or `netstat -ano` on Windows) and stop it, or change `PORT`. |
| Dark mode looks wrong | Clear `localStorage` key `uems-theme`, or check `tailwind.config.js` `darkMode: 'class'`. |

## 11. Updating

```bash
git pull
cd backend && npm install && npm run migrate && npm run build
cd ../frontend && npm install && npm run build
# Restart the backend process (pm2 / systemd) and redeploy the frontend build.
```
