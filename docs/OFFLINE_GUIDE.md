# Offline Guide — Run the System on a Windows Computer Without Internet

## لنډه پېژندنه (What this guide is)

This guide explains how to run the University Examination Department
Management System on **one Windows computer with no internet**, after a
one-time download step done while you are online.

- The system runs only on that computer: frontend at
  `http://localhost:8080` (Docker) or `http://localhost:5173`
  (manual dev mode), backend API at `http://localhost:5000`.
- No internet is needed after the install is finished.
- The Render link (`https://exam-frontend-b6rb.onrender.com/`) is a
  **separate online copy** with **separate accounts**. Accounts you
  create offline do not exist on Render, and Render accounts do not
  exist offline. The first Super Admin must be created again on each
  copy (see §3 below).
- Do **not** run the seed file (`002_seed.sql`). Run only the schema
  migration (`001_init.sql`). The seed creates no login accounts.

> Never write a real password in a file or in chat. Everywhere below,
> `<choose-a-password-of-8-or-more-characters>` means: pick your own
> password, at least 8 characters, and type it yourself.

---

## ۱. یو ځل ډاونلوډ (One-time downloads — while online)

Do this once, while the computer has internet. After this step, the
computer does not need internet again for this system.

| Download | Why | Where |
| --- | --- | --- |
| Source ZIP (`exam-management-system-source.zip`) | The whole project: backend, frontend, database, docs | The ZIP file given with this package |
| Node.js 20 LTS (Windows installer, `.msi`) | Runs the backend and builds the frontend | https://nodejs.org (LTS, version 20) |
| PostgreSQL 15 (Windows installer) | The database — **only for the manual route** (§4); skip it if you use Docker (§3) | https://www.postgresql.org/download/windows/ |
| Docker Desktop for Windows | The easiest route (§3) — it provides Node, PostgreSQL and the app in containers | https://www.docker.com/products/docker-desktop/ |

Also, while still online, run `npm install` once in `backend/` and once
in `frontend/` (see §4). That downloads all packages; after that, no
more downloads are needed.

Check the installs in PowerShell:

```powershell
node -v        # expect v20.x
npm -v         # expect 10.x
docker --version
docker compose version
psql --version # manual route only
```

---

## ۲. فایلونه خلاصول (Extract the source)

1. Right-click `exam-management-system-source.zip` → **Extract All**.
2. Open the extracted folder. You should see: `backend/`,
   `frontend/`, `database/`, `docs/`, `docker-compose.yml`,
   `render.yaml`, `README.md`.
3. Open **PowerShell** in that folder (Shift + right-click in the
   folder → **Open PowerShell window here**).

All commands below run from this folder unless stated otherwise.

---

## ۳. اسانه لار: Docker (Docker route — recommended)

Docker Desktop must be installed and running (its icon in the taskbar
says "Engine running").

### Start

```powershell
docker compose up --build -d
docker compose ps        # all three services should say "Up" / "healthy"
```

Services (from `docker-compose.yml`):

| Service | Address on your computer |
| --- | --- |
| Frontend | http://localhost:8080 |
| Backend API | http://localhost:5000 |
| Database (PostgreSQL 15) | localhost:5432, database `exam_management` |

### Create the database tables (first time only)

The backend container has no `psql` client and the migration files are
not copied into it, so run the migration **through the database
container**, piping the file in from your computer:

```powershell
Get-Content database/migrations/001_init.sql | docker compose exec -T db psql -U postgres -d exam_management
```

This creates all tables. Do **not** run `002_seed.sql`.

Check the backend answers:

```powershell
curl.exe http://localhost:5000/api/health
# expect: {"status":"ok","db":"connected",...}
```

### Create the first Super Admin (melad)

Only while the `users` table is empty. In PowerShell:

```powershell
curl.exe -X POST http://localhost:5000/api/auth/setup-first-admin -H "Content-Type: application/json" -d "{\"full_name\":\"melad\",\"email\":\"meladakhundzada@gmail.com\",\"password\":\"<choose-a-password-of-8-or-more-characters>\"}"
```

Then open http://localhost:8080 and sign in with
`meladakhundzada@gmail.com` and the password you chose. Create the
other accounts from the **Users** page inside the app: Examination
Officer (abas), Lecturer (Eng Irfan) and students (including Zahid),
each with their own email and a password they choose (minimum
8 characters). For Irfan, set his email on his existing lecturer
record (employee_id `LEC-007`) instead of creating a second lecturer
record — his BCS subjects are already assigned to that record.

### Stop and start again

```powershell
docker compose down        # stops the system; data is KEPT
docker compose up -d       # starts it again
docker compose logs -f backend   # watch the backend log (Ctrl+C to exit)
```

⚠️ `docker compose down -v` **deletes the database**. Do not use `-v`
unless you really want to erase all data.

### Where the data lives

In the Docker named volume `pgdata` (see `docker-compose.yml`,
`volumes: pgdata:`). It survives `docker compose down` and computer
restarts. Back it up with `pg_dump` — see §6.

### Change the JWT secret (before any shared use)

`docker-compose.yml` ships with the placeholder
`JWT_SECRET: change-me-to-a-long-random-secret-before-use`. Before
anyone else uses the system, edit that line to a long random string
(generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
then restart: `docker compose down` and `docker compose up -d`.
Changing it signs everyone out.

---

## ۴. لاسي لار: Node + PostgreSQL (Manual route — no Docker)

Use this route only if you do not want Docker. You need Node.js 20
and PostgreSQL 15 installed (see §1).

### 4a. Database

During the PostgreSQL install, set a password for the `postgres` user
and remember it. Then create the database (PowerShell, from the
project folder):

```powershell
psql -U postgres -c "CREATE DATABASE exam_management;"
```

If `psql` is not found, add PostgreSQL's `bin` folder to your PATH
(usually `C:\Program Files\PostgreSQL\15\bin`).

### 4b. Backend

```powershell
cd backend
npm install
Copy-Item .env.example .env
notepad .env
```

Set these values in `.env` (from `backend/.env.example`):

```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgres://postgres:<your-postgres-password>@localhost:5432/exam_management
JWT_SECRET=<a long random string — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
JWT_EXPIRES_IN=8h
CORS_ORIGIN=http://localhost:5173
```

- `CORS_ORIGIN` must match the frontend address you will open:
  `http://localhost:5173` for dev mode (§4c), or
  `http://localhost:8080` if you serve the built frontend.
- Never commit `.env`.

Run the schema migration (schema only — **not** the seed):

```powershell
psql "postgres://postgres:<your-postgres-password>@localhost:5432/exam_management" -f ..\database\migrations\001_init.sql
```

Start the backend (keep this window open):

```powershell
npm start
# Backend API: http://localhost:5000
# Health check: curl.exe http://localhost:5000/api/health
```

### 4c. Frontend

Open a **second** PowerShell window, in the project folder:

```powershell
cd frontend
npm install
```

Create `frontend\.env` (only if it does not exist) with one line:

```env
VITE_API_URL=http://localhost:5000/api
```

**Development mode** (easiest — live reload, no build step):

```powershell
npm run dev
# Frontend: http://localhost:5173
```

**Built mode** (what users should use — serves the production build):

```powershell
npm run build
npm run preview -- --port 8080 --host 127.0.0.1
# Frontend: http://localhost:8080
```

Note: `VITE_API_URL` is baked into the built JavaScript at build
time. If you change it, run `npm run build` again. If you use dev
mode, `CORS_ORIGIN` in the backend `.env` must be
`http://localhost:5173`; if you use the built mode on port 8080, it
must be `http://localhost:8080` — restart the backend after changing
it.

### 4d. First Super Admin (manual route)

Same endpoint as §3, with the backend running:

```powershell
curl.exe -X POST http://localhost:5000/api/auth/setup-first-admin -H "Content-Type: application/json" -d "{\"full_name\":\"melad\",\"email\":\"meladakhundzada@gmail.com\",\"password\":\"<choose-a-password-of-8-or-more-characters>\"}"
```

Then sign in at http://localhost:5173 (dev) or
http://localhost:8080 (built) and create the other accounts from the
Users page, as in §3.

---

## ۵. ایا انټرنټ ته اړتیا ده؟ (Offline facts)

- **After install: no.** Once Node packages are installed (or the
  Docker images are downloaded), the whole system runs on
  `localhost` with no internet.
- **Only this computer:** `localhost` means "this computer only".
  Nobody else can open it from their own computer.
- **Same Wi-Fi (optional, advanced):** other computers on the same
  Wi-Fi can reach it at `http://<your-computer-LAN-IP>:8080`
  (Docker) — find your LAN IP with `ipconfig` (look for
  "IPv4 Address", e.g. `192.168.1.10`). Two extra steps are needed:
  1. Windows Firewall must allow the port: open **Windows Defender
     Firewall → Advanced settings → Inbound Rules → New Rule → Port
     → TCP 8080 (and 5000)** → Allow.
  2. The frontend must be **built** with
     `VITE_API_URL=http://<your-LAN-IP>:5000/api` and the backend
     `CORS_ORIGIN` must include `http://<your-LAN-IP>:8080`,
     otherwise the page loads but login fails. Rebuild and restart
     after changing these.
  This is a local-network setup only — it is not a public link, and
  it stops working when the computer is off or off that Wi-Fi.
- **Render is separate:** the Render link is an online copy with its
  own database and accounts. Nothing is shared between the offline
  copy and Render.

---

## ۶. بېک اپ (Backup — offline)

### Docker route

```powershell
docker compose exec -T db pg_dump -U postgres -d exam_management -F c > "uems-backup.dump"
```

Restore into the same setup (the database must exist and be empty
first — see §7 if you need to reset it):

```powershell
Get-Content uems-backup.dump -Raw -AsByteStream | docker compose exec -T db pg_restore -U postgres -d exam_management --clean --if-exists
```

### Manual route

```powershell
pg_dump -U postgres -d exam_management -F c -f "uems-backup.dump"
pg_restore -U postgres -d exam_management --clean --if-exists "uems-backup.dump"
```

Copy the `.dump` file to a USB drive or another computer. Also keep a
copy of `backend\.env` separately (encrypted) — a database dump does
not include it. Test a restore at least once; an untested backup is
not a backup.

---

## ۷. ستونزې او حل (Troubleshooting)

| Symptom | Likely cause / fix |
| --- | --- |
| `http://localhost:8080` does not open | Docker: run `docker compose ps` — all services must be Up. If the frontend is not Up, run `docker compose logs frontend` and read the error. Manual: the frontend is not running — run `npm run dev` (port 5173) or `npm run preview` (port 8080) in `frontend/`. |
| Login page opens but login fails with a network error | The frontend was built with the wrong `VITE_API_URL`. It is baked in at build time — fix `frontend\.env` (or the Docker build arg in `docker-compose.yml`), rebuild (`npm run build` / `docker compose up --build -d`), and check the backend is running on port 5000. |
| `401` on every request after login | Token expired, or `JWT_SECRET` changed since login — sign in again. |
| `403` on a page | Your role lacks that route — ask a Super Admin. |
| `Port 5000 / 5173 / 8080 is already in use` | Another program holds the port. Find it: `netstat -ano \| findstr :5000` (note the PID), then `taskkill /PID <pid> /F` — or stop the other program, or change `PORT` in the backend `.env` (and `VITE_API_URL` to match). |
| `Connection refused` / `database connection failed` | PostgreSQL is not running. Docker: `docker compose ps` — `db` must be healthy; run `docker compose logs db`. Manual: start the PostgreSQL service (Windows Services → `postgresql-x64-15` → Start), and check `DATABASE_URL` in `backend\.env`. |
| Migration fails with `relation already exists` | The schema was already applied — do not run it again. If the database is half-migrated, drop and re-create it, then run only `001_init.sql` once. |
| `setup-first-admin` returns 403 | An account already exists — the endpoint only works while the `users` table is empty. Sign in with the existing Super Admin instead. |
| `psql` / `node` / `docker` is not recognized | The program is not installed, or its folder is not in PATH. Re-run its installer (Node.js / PostgreSQL / Docker Desktop) and open a new PowerShell window. |
| Docker Desktop says the engine is not running | Start Docker Desktop and wait until its icon says the engine is running, then run `docker compose up -d` again. |

---

## ۸. لنډیز (Quick summary)

| | Docker route | Manual route |
| --- | --- | --- |
| Install | Docker Desktop + source ZIP | Node.js 20 + PostgreSQL 15 + source ZIP |
| Start | `docker compose up -d` | Backend `npm start` + frontend `npm run dev` (or `npm run preview`) |
| Frontend | http://localhost:8080 | http://localhost:5173 (dev) / http://localhost:8080 (built) |
| Backend | http://localhost:5000 | http://localhost:5000 |
| First admin | `POST /api/auth/setup-first-admin` (melad, `meladakhundzada@gmail.com`, your own password, min 8 chars) | Same |
| Stop | `docker compose down` (data kept) | Ctrl+C in both PowerShell windows |
| Internet after install | Not needed | Not needed |
