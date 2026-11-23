# Deployment Guide — Putting the System on the Internet
# د سیسټم په انټرنټ کې ځای پر ځای کول

This guide takes the source code in this folder and puts it on the
internet so students and staff can open it in Chrome with a link.
No passwords or secrets are written in this file — use your own.

> **What I cannot do for you:** I have no Render/hosting account and no
> payment method, so I cannot create the hosting account or deploy it
> myself. You (or someone you trust) must create a free Render account
> and connect this code to it. The steps below are written so anyone
> can follow them. If you give me access to the hosting account later,
> I can walk through the steps with you.

## Before you start — read this first

1. **Two versions exist.** The app inside Muse (usernames melad, abas,
   Irfan, Zahid) is a demo that lives only in Muse. The code in this
   folder is the production version: it logs in with **email**
   addresses, not those usernames. After deploying, create the same
   people again in the deployed system (step 5 below) using the names
   and passwords you already chose. Do not paste your passwords
   anywhere except the login / setup screens.
2. **No login accounts are seeded in this code.** The seed adds sample
   academic data only. Create the real accounts in step 5 below, and
   give each person the password they choose (minimum 8 characters).
   Do not paste your passwords anywhere except the login / setup screens.
3. **`VITE_API_URL` must end in `/api`, not `/api`.** The backend
   mounts its routes at `/api` (`/api/auth/login`, `/api/students`,
   …). The values in `render.yaml` and `docker-compose.yml` already
   use `/api`. If the frontend shows "Network Error" after deploy,
   this is the first thing to check.
4. **Render free plan limits:** free web services sleep after about
   15 minutes without traffic (the first visit after that takes
   30–60 seconds to wake up), and the free PostgreSQL database is
   deleted after 90 days. For a real university system, use a paid
   database or export regular backups (see "Backups" below).

---

## Option A — Deploy on Render (recommended, free to start)
## لومړی انتخاب — په Render کې ځای پر ځای کول

### Step 1 — Put the code on GitHub
### ۱ ګام — کوډ په GitHub کې واچوئ

Render deploys from a Git repository. On your computer, inside the
project folder:

```bash
git init
git add .
git commit -m "University Examination Management System"
```

Create a free account at https://github.com, make a new **private**
repository, then push (GitHub shows the exact commands after you
create the repo — they look like this):

```bash
git remote add origin https://github.com/YOUR-USERNAME/exam-management-system.git
git branch -M main
git push -u origin main
```

> Never commit a real `.env` file. Only `.env.example` (no secrets)
> is in this repo.

### Step 2 — Create a Render account and deploy the Blueprint
### ۲ ګام — په Render کې حساب جوړ کړئ

1. Create a free account at https://render.com (sign up with
   GitHub — easiest, it connects your repositories automatically).
2. Dashboard → **New → Blueprint** → choose the repository you just
   pushed → Render reads `render.yaml` and shows three things it
   will create: a PostgreSQL database (`exam-db`), a backend web
   service (`exam-api`) and a frontend static site (`exam-frontend`).
3. Click **Apply**. Wait a few minutes. The backend will start, the
   frontend will build, and each service gets a URL like
   `https://exam-api.onrender.com` and
   `https://exam-frontend.onrender.com`.
4. If the frontend build fails, open the `exam-frontend` service →
   **Logs** and look for the error. The build was verified locally
   (`npm run build` passes), so a failure usually means the
   `VITE_API_URL` value or a missing file in the push — check that
   `git status` is clean and everything was pushed.

### Step 3 — Run the database migrations
### ۳ ګام — ډیټابېس جوړ کړئ

The database is empty until you run the migrations. In the Render
dashboard, open the `exam-api` service → **Shell** tab and run:

```bash
npm run migrate:schema
```

This creates all tables. **For a production system, stop here** —
do not run the seed. For a demo/test system, also run:

```bash
npm run seed
```

which adds sample faculties, departments, subjects, lecturers,
students and exams. It creates **no login accounts** — create them
in step 5.

### Step 4 — Point the frontend at the real backend URL
### ۴ ګام — فرانټ‌اېنډ له بېک‌اېنډ سره وصل کړئ

`VITE_API_URL` is baked into the frontend when it is built, so
changing it needs a rebuild:

1. Copy the backend URL from the `exam-api` service, e.g.
   `https://exam-api.onrender.com`, and add `/api`:
   `https://exam-api.onrender.com/api`.
2. In the `exam-frontend` service → **Environment**, set
   `VITE_API_URL` to that value, then **Manual Deploy → Deploy
   latest commit** (this rebuilds the frontend).
3. In the `exam-api` service → **Environment**, set `CORS_ORIGIN`
   to the frontend URL, e.g. `https://exam-frontend.onrender.com`,
   and save (the backend restarts automatically).

### Step 5 — Create the first Super Admin (melad)
### ۵ ګام — لومړی Super Admin جوړ کړئ

The one-time setup endpoint only works when **no users exist yet**,
so do this before seeding or before anyone registers. From any
computer with `curl` (or Postman), replace the backend URL and use
your own email and the password you chose for melad:

```bash
curl -X POST https://exam-api.onrender.com/api/auth/setup-first-admin \
  -H "Content-Type: application/json" \
  -d '{"full_name": "melad", "email": "meladakhundzada@gmail.com", "password": "YOUR-PASSWORD-HERE"}'
```

Password must be at least 8 characters. If it answers
`"Setup already completed: users exist"`, users were already
created — log in with the existing Super Admin instead.

Then open the frontend URL, log in as the Super Admin, and create
the other people from **Users**: the Examination Officer (abas),
the Lecturer (Eng Irfan) and students (including Zahid), each with
the password you chose for them. Give each person their correct
role — the dashboards and permissions follow the role.

### Step 6 — Test the live system
### ۶ ګام — سیستم وازمایئ

Open the frontend URL in Chrome and check:

- [ ] Login page loads (no errors).
- [ ] Super Admin (melad) logs in and sees the full dashboard.
- [ ] Examination Officer (abas) logs in and sees the operations
      dashboard (exams, approvals, complaints).
- [ ] Lecturer (Irfan) logs in and sees only their own subjects —
      their BCS subjects (CS-101, CS-201, CS-301, SE-101, SE-201)
      are already assigned in the seed.
- [ ] Student (Zahid) logs in and sees only their own timetable,
      results and CGPA.
- [ ] Create one exam, enter one mark, approve it, publish the
      result — the student must see it only after publication.
- [ ] `https://exam-api.onrender.com/api/health` returns
      `{"status": "ok", "db": "connected"}`.

If login fails with "Network Error", check `VITE_API_URL` (step 4)
and `CORS_ORIGIN` (step 4.3) first.

---

## Option B — Run it on your own computer with Docker
## دویم انتخاب — په خپل کمپیوټر کې د Docker په مرسته چلول

Good for testing the full system locally, or for running it on a
university server that has Docker.

Prerequisites: Docker and Docker Compose installed
(https://docs.docker.com/get-docker/).

```bash
cd exam-management-system-source
docker compose up --build -d
docker compose exec backend npm run migrate   # schema + seed, first time only
```

- Frontend: http://localhost:8080
- Backend API: http://localhost:5000 (health: /api/health)
- Database: PostgreSQL on localhost:5432 (database `exam_management`)

Create the Super Admin with `setup-first-admin` as in Option A step 5,
then the other accounts from the Users page — the seed creates no
login accounts.

Stop it with `docker compose down` (your data stays in the Docker
volume; add `-v` to delete the database completely).

> Before sharing a Docker install with other people, change
> `JWT_SECRET` in `docker-compose.yml` to a long random value and
> change `CORS_ORIGIN` to the address people will actually use.

---

## Option C — Railway (alternative to Render)

Railway (https://railway.app) works the same way and is a good
alternative if Render's free limits are a problem:

1. Create a Railway account, **New Project → Deploy from GitHub**,
   choose this repo.
2. **New → Database → PostgreSQL**. Copy its `DATABASE_URL`.
3. Add a service from the `backend` folder: set `DATABASE_URL`,
   `JWT_SECRET` (generate a random value), `JWT_EXPIRES_IN=8h`,
   `CORS_ORIGIN` (your frontend URL) and `NODE_ENV=production`.
   Start command: `npm start`.
4. Add a service from the `frontend` folder with
   `VITE_API_URL=https://YOUR-BACKEND-URL/api`, build command
   `npm install && npm run build`, publish directory `dist`.
5. Run the migrations from Railway's service shell or from your
   computer with the database URL, then create the Super Admin as
   in Option A step 5.

There is no `railway.json` in this repo because Railway is
configured in its dashboard, not in a file — `render.yaml` is the
primary, file-based blueprint.

---

## Before going live — checklist
## له خپرولو مخکې — چک‌لېست

- [ ] `JWT_SECRET` is a long random value, different from any example
      (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
- [ ] No login accounts are seeded — only the accounts created in
      step 5 exist; delete or deactivate any that are not needed.
- [ ] Every real user has the correct role (Super Admin / Officer /
      Lecturer / Student) — permissions follow the role.
- [ ] `CORS_ORIGIN` contains only your real frontend URL(s).
- [ ] The site is served over HTTPS (Render and Railway do this
      automatically; for Docker, put it behind a reverse proxy with
      a certificate).
- [ ] The grade scale and pass mark in Settings match the university's
      real rules (the seed scale is illustrative only).
- [ ] A backup plan exists (below) and someone has tested restoring it.
- [ ] The login page does not list any passwords.

## Backups
## بېک‌اپ

```bash
# Backup (from your computer, using the database URL from Render)
pg_dump "$DATABASE_URL" -F c -f exam-backup.dump

# Restore into an empty database
pg_restore -d "$DATABASE_URL" exam-backup.dump
```

On Render, you can also download backups from the database page.
Test a restore at least once before real students depend on the
system.

## If something breaks

| Problem | Check first |
| --- | --- |
| Frontend shows "Network Error" on login | `VITE_API_URL` ends in `/api`; frontend was redeployed after changing it |
| Login works but API calls fail with CORS errors | `CORS_ORIGIN` on the backend equals the frontend URL exactly |
| `/api/health` says `db: unreachable` | `DATABASE_URL` is set; database service is running; `?sslmode=require` is on the Render URL |
| First page load is very slow | Normal on Render free plan — the service was asleep and is waking up |
| "Setup already completed" | Users already exist — log in as the existing Super Admin instead of re-running setup |
| Frontend build fails on Render | Check the deploy logs; make sure the whole repo (including `frontend/index.html`, `src/main.tsx`, `vite.config.ts`) was pushed to GitHub |
