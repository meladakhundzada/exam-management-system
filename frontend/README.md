# Frontend — University Examination Department Management System

React 18 + TypeScript + Vite + Tailwind CSS 3 + React Router 6 + Recharts + Axios.

## Quick start

```bash
cd frontend
npm install
cp .env.example .env        # if present; otherwise create .env (see below)
npm run dev                 # http://localhost:5173
npm run build               # production build (tsc + vite build)
npm test                    # vitest
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:5000/api` | Backend base URL. Must point at the Express API in `../backend`. |

Create `.env` (never commit secrets):

```env
VITE_API_URL=http://localhost:5000/api
```

## Structure

```
src/
  App.tsx                 # Router, RequireAuth guard, LoginPage, Layout (sidebar + dark-mode toggle)
  context/AuthContext.tsx # Session restore, login/logout, role + route permission matrix
  services/api.ts         # Axios instance, JWT + refresh interceptor, typed API clients
  components/
    Sidebar.tsx           # Role-filtered navigation
    StatCard.tsx          # Dashboard KPI card
    DataTable.tsx         # Search / sort / filter / pagination table (generic)
  pages/
    Dashboard.tsx         # KPIs + Recharts (monthly exams, status pie, dept GPA line)
    Students.tsx          # CRUD, validation, delete confirmation, CSV export
    Exams.tsx             # Create/list exams, room + time validation
    Marks.tsx             # Marks entry, range validation, submit → approve flow
    Results.tsx           # Published-only results, GPA/CGPA, transcript + admit-card download
  i18n/
    en.json  ps.json  fa.json   # English (LTR), Pashto + Dari (RTL)
```

Other routes (`/lecturers`, `/departments`, `/subjects`, `/timetable`, `/attendance`,
`/admit-card`, `/complaints`, `/reports`, `/notifications`, `/users`, `/audit-logs`,
`/settings`) are registered in `App.tsx` as placeholders that follow the same
DataTable + form pattern as Students/Exams; they are **not** dead links — each is
route-guarded by role and documented in `docs/USER_GUIDE.md`.

## Auth & RBAC

- JWT access token (short-lived) in `localStorage` + refresh token; the Axios
  interceptor attaches `Authorization: Bearer …`, retries once after a refresh,
  and redirects to `/login` on failure.
- `AuthContext.canAccess(path)` enforces the route matrix in `ROLE_ROUTES`.
  The backend re-checks every request — frontend guards are UX only, never the
  security boundary.
- Students can only load their own results (`user.studentId`); the API rejects
  any other student ID with 403, and unpublished results are never returned.

## i18n / RTL

- `en.json` is LTR; `ps.json` and `fa.json` are RTL (`direction: "rtl"` in `meta`).
- To activate: load the chosen JSON, set
  `document.documentElement.dir = 'rtl'` and `lang = 'ps' | 'fa'`.
- Verify sidebar, tables and modals in RTL before release; use logical
  Tailwind utilities (`ms-`, `me-`, `ps-`, `pe-`) for new components.

## Dark mode

Class-based (`darkMode: 'class'` in `tailwind.config.js`). The header toggle
adds/removes `dark` on `<html>` and persists the choice in `localStorage`
(`uems-theme`). Restore it in `index.html` / `main.tsx` on load to avoid a flash.

## Notes / assumptions

- Grade scale is configurable on the backend (Settings → Grade Scale); the
  frontend displays whatever grade/grade-point the API returns and does not
  hard-code pass marks.
- No official university policy is invented: pass thresholds, GPA scale and
  admit-card wording come from backend settings / seed data.
