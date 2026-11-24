import { useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Students from './pages/Students';
import Exams from './pages/Exams';
import Marks from './pages/Marks';
import Results from './pages/Results';
import Fees from './pages/Fees';
import Users from './pages/Users';
import Departments from './pages/Departments';
import Setup from './pages/Setup';

function LoginPage() {
  const { login, error, loading, clearError, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    try { await login(email, password); } catch { /* error shown from context */ }
  };

  // After a successful sign-in, leave the login page.
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-900 px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl dark:bg-slate-800">
        <h1 className="text-2xl font-bold text-navy-900 dark:text-white">University Exams</h1>
        <p className="mt-1 text-sm text-slate-500">Examination Department Management System</p>
        {error && (
          <div role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </div>
        )}
        <label className="mt-6 block text-sm font-medium" htmlFor="email">Email</label>
        <input id="email" type="email" required autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" placeholder="meladakhundzada@gmail.com" />
        <label className="mt-4 block text-sm font-medium" htmlFor="password">Password</label>
        <div className="relative">
          <input id="password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 pr-16 dark:border-slate-600 dark:bg-slate-900" />
          <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-navy-600">
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
        <button type="submit" disabled={loading} className="mt-6 w-full rounded-lg bg-navy-600 py-2.5 font-semibold text-white hover:bg-navy-700 disabled:opacity-50">
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="mt-4 text-center text-sm">
          <Link to="/setup" className="text-navy-600 hover:underline">Create the first Super Admin</Link>
        </p>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          Demo accounts are listed in docs/USER_GUIDE.md. Change the default Super Admin
          password on first login (Settings → Change password).
        </p>
      </form>
    </div>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">
        This module is wired to the matching backend API (see docs/USER_GUIDE.md for the workflow).
        It follows the same DataTable + form pattern as Students and Exams.
      </p>
    </div>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isAuthenticated, loading, canAccess } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!canAccess(location.pathname)) {
    return (
      <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">
          Your role does not have permission to open {location.pathname}. Contact the Super Admin if this is wrong.
        </p>
      </div>
    );
  }
  return children;
}

function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('uems-theme', next ? 'dark' : 'light');
  };
  return (
    <div className="flex min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-800">
          <button className="rounded-lg border px-3 py-1.5 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">☰</button>
          <h2 className="text-sm font-semibold sm:text-base">Examination Department</h2>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={toggleDark} className="rounded-lg border px-3 py-1.5 text-sm" aria-label="Toggle dark mode">
              {dark ? '☀️ Light' : '🌙 Dark'}
            </button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/students" element={<Students />} />
            <Route path="/exams" element={<Exams />} />
            <Route path="/marks" element={<Marks />} />
            <Route path="/marks/:examId" element={<Marks />} />
            <Route path="/results" element={<Results />} />
            <Route path="/fees" element={<Fees />} />
            <Route path="/lecturers" element={<Placeholder title="Lecturers" />} />
            <Route path="/departments" element={<Departments />} />
            <Route path="/subjects" element={<Placeholder title="Subjects & Courses" />} />
            <Route path="/timetable" element={<Placeholder title="Examination Timetable" />} />
            <Route path="/attendance" element={<Placeholder title="Examination Attendance" />} />
            <Route path="/admit-card" element={<Placeholder title="Admit Card" />} />
            <Route path="/complaints" element={<Placeholder title="Complaints & Rechecking" />} />
            <Route path="/reports" element={<Placeholder title="Reports & Statistics" />} />
            <Route path="/notifications" element={<Placeholder title="Notifications & Announcements" />} />
            <Route path="/users" element={<Users />} />
            <Route path="/audit-logs" element={<Placeholder title="Audit Logs" />} />
            <Route path="/settings" element={<Placeholder title="Settings, Grade Scale & Backup" />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/*" element={<RequireAuth><Layout /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
