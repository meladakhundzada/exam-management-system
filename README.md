# University Examination Department Management System

A centralized digital system for a university Examination Department:
student and lecturer management, subjects, exam timetables and room
allocation, attendance, marks entry and approval, GPA/CGPA results,
admit cards, rechecking complaints, reports and audit logs — with
role-based access for Super Admin, Examination Officer, Lecturer and Student.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
│  React 18 + TypeScript + Vite + Tailwind CSS                    │
│  React Router 6 · Recharts · Axios (JWT interceptor)            │
│  frontend/src/{pages,components,services,context,i18n}          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS / JSON (REST, /api)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node.js 20 + Express (JavaScript)                              │
│  JWT auth · bcrypt · express-validator                            │
│  RBAC middleware · audit logging · PDF (pdfkit) / Excel (ExcelJS)│
│  backend/src/{routes,middleware,config,utils}                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ SQL (parameterised queries)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL 15+                                                 │
│  users · roles · students · lecturers · faculties · departments  │
│  subjects · examinations · rooms · attendance · marks · results │
│  grade_scales · complaints · notifications · audit_logs         │
└─────────────────────────────────────────────────────────────────┘
```

The frontend never talks to the database directly; every request goes
through the Express API, which re-checks the caller's role on each route.
Frontend route guards are a UX convenience only.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS 3, React Router 6, Recharts, Axios |
| Backend | Node.js 20, Express (JavaScript), JWT, bcrypt, express-validator |
| Database | PostgreSQL 15+ (normalized, FKs, unique indexes) |
| Charts | Recharts |
| Exports | PDF (pdfkit), Excel (ExcelJS) |
| i18n | JSON locales: English (`en`), Pashto (`ps`), Dari (`fa`) — Pashto/Dari are RTL |

## Project structure

```
exam-management-system-source/
├── README.md                  # this file
├── frontend/
│   ├── package.json           # react, typescript, tailwind, react-router-dom, recharts, axios
│   ├── tailwind.config.js     # navy/blue theme, class-based dark mode
│   ├── README.md              # frontend quick start, structure, auth/RBAC notes
│   └── src/
│       ├── App.tsx            # router, RequireAuth guard, login, layout
│       ├── context/AuthContext.tsx   # session, login/logout, ROLE_ROUTES matrix
│       ├── services/api.ts    # axios + JWT/refresh interceptors, typed API clients
│       ├── components/
│       │   ├── Sidebar.tsx    # role-filtered navigation
│       │   ├── StatCard.tsx   # dashboard KPI card
│       │   └── DataTable.tsx  # search / sort / filter / pagination
│       ├── pages/
│       │   ├── Dashboard.tsx  # KPIs + Recharts charts + recent activity
│       │   ├── Students.tsx   # student CRUD, validation, delete confirm, CSV export
│       │   ├── Exams.tsx      # exam create/list, room + time validation
│       │   ├── Marks.tsx      # marks entry, range checks, submit → approve
│       │   └── Results.tsx    # published-only results, GPA/CGPA, transcript PDF
│       └── i18n/en.json  ps.json  fa.json
├── backend/                   # Express API (companion package)
│   └── src/                   # routes, middleware, config, utils
├── database/                  # schema, migrations + seed, API docs
│   ├── schema.sql             # canonical schema (001_init.sql is a copy)
│   ├── migrations/            # 001_init.sql (schema), 002_seed.sql (sample data)
│   └── API.md                 # full API documentation
└── docs/
    ├── SETUP_GUIDE.md         # install, env, migrate+seed, admin setup, backup/restore
    ├── USER_GUIDE.md          # step-by-step guide for all 4 roles, 12-step workflow
    └── TESTING_CHECKLIST.md   # auth/RBAC, CRUD, workflow, GPA cases, security, responsive
```

> The `backend/` package is the companion to this frontend. If it is not in
> your copy, the API contract it must implement is defined by
> `frontend/src/services/api.ts`.

## Quick start

```bash
# Backend
cd backend && npm install && cp .env.example .env
# edit .env (DATABASE_URL, JWT secrets), then:
npm run migrate && npm run dev   # http://localhost:5000 (migrate runs schema + seed)

# Frontend
cd ../frontend && npm install
npm run dev                                      # http://localhost:5173
```

Full instructions: [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md).
Demo logins and the 12-step exam workflow: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
Release gate: [docs/TESTING_CHECKLIST.md](docs/TESTING_CHECKLIST.md).

## Deployment (put it on the internet)

- **Render (recommended):** `render.yaml` is a one-click Blueprint
  (PostgreSQL + backend API + frontend static site). Full steps:
  [docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md).
- **Docker (local or your own server):** `docker compose up --build -d`,
  then `docker compose exec backend npm run migrate`. Frontend on
  http://localhost:8080, API on http://localhost:5000.
- **Railway:** alternative hosting, also covered in the deploy guide.

After the first deploy: run the migrations, create the first Super
Admin with `POST /api/auth/setup-first-admin` (only works when no
users exist), set the frontend's `VITE_API_URL` to
`https://<your-backend>/api` (note: `/api`, not `/api`), and set
the backend's `CORS_ORIGIN` to the frontend URL. No passwords are
stored in this repo — the deploy guide explains how to create the
real accounts (melad, abas, Irfan, Zahid) in the deployed system.

## Roles

- **Super Admin** — full access: users, permissions, departments, settings, backup, audit logs.
- **Examination Officer** — students, exams, schedules, rooms, attendance, marks review, result publication, reports.
- **Lecturer** — assigned subjects/students, timetable, marks entry and submission.
- **Student** — profile, timetable, admit card, published results, rechecking complaints.

## Assumptions (no official policy invented)

Where university-specific information was not supplied, the system uses
**configurable settings** instead of inventing official policy:

- **Grade scale is configurable** (Settings → Grade Scale). The seed uses a
  common illustrative scale (A 90–100 / 4.0, B 80–89 / 3.0, C 70–79 / 2.0,
  D 60–69 / 1.0, F <60 / 0.0) — confirm the real thresholds with the
  Examination Department before publishing results.
- **Pass mark, credit weighting and GPA formula** come from the same settings;
  the frontend displays what the API calculates and does not hard-code them.
- **Admit-card wording, transcript layout and notification text** are
  templates in the backend, to be approved by the department.
- **Demo data** (faculties, departments, students, exams) is realistic sample
  data for demonstration only and must be replaced before production use.
- Language strings in `ps.json` / `fa.json` are interface translations;
  official university wording should be confirmed by the department.
