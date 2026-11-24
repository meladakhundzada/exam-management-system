import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { authApi, AuthUser, tokenStore, apiErrorMessage } from '../services/api';

export type Role = AuthUser['role'] | 'FINANCE' | 'EXAM_CONTROLLER' | 'DEPARTMENT_HEAD' | 'INVIGILATOR';

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  EXAM_OFFICER: 'Examination Officer',
  FINANCE: 'Finance Officer',
  LECTURER: 'Lecturer',
  STUDENT: 'Student',
  EXAM_CONTROLLER: 'Examination Controller',
  DEPARTMENT_HEAD: 'Department Head',
  INVIGILATOR: 'Examination Invigilator',
};

// Route-level permission matrix. Keep in sync with backend RBAC middleware.
// New roles (master prompt):
// - Examination Controller: exam operations, schedule + final-result
//   approval, reports, monitoring — no user/finance management.
// - Department Head: their own department's students, lecturers, subjects,
//   exams and results — read-only academic oversight, no marks entry.
// - Examination Invigilator: only their assigned sessions (see
//   MyInvigilation page), the timetable and attendance marking.
export const ROLE_ROUTES: Record<Role, string[]> = {
  SUPER_ADMIN: ['*'],
  EXAM_OFFICER: [
    '/dashboard', '/profile', '/students', '/lecturers', '/departments', '/subjects',
    '/exams', '/exam-management', '/timetable', '/attendance', '/marks', '/results', '/fees',
    '/scholarships', '/fines', '/complaints', '/reports', '/notifications',
    '/online-transactions',
  ],
  FINANCE: ['/dashboard', '/profile', '/fees', '/scholarships', '/fines', '/reports', '/online-transactions'],
  LECTURER: ['/dashboard', '/profile', '/students', '/subjects', '/exams', '/timetable', '/attendance', '/marks', '/results', '/reports', '/complaints', '/notifications', '/settings'],
  STUDENT: ['/dashboard', '/profile', '/my-courses', '/my-attendance', '/timetable', '/results', '/fees', '/admit-card', '/complaints', '/settings', '/pay-online'],
  EXAM_CONTROLLER: ['/dashboard', '/profile', '/exams', '/exam-management', '/timetable', '/attendance', '/marks', '/results', '/reports'],
  DEPARTMENT_HEAD: ['/dashboard', '/profile', '/students', '/lecturers', '/subjects', '/exams', '/timetable', '/results', '/reports'],
  INVIGILATOR: ['/dashboard', '/profile', '/my-invigilation', '/timetable', '/attendance'],
};

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
  canAccess: (path: string) => boolean;
  clearError: () => void;
  // Update the signed-in user's photo in context after an upload/remove,
  // so the sidebar and profile show it without a reload.
  setPhotoUrl: (photoUrl: string | null) => void;
}

// The backend returns snake_case users with lowercase roles
// ({ id, full_name, email, role: 'super_admin' }) and login returns a
// flat { token, user } body — not the { data: { accessToken, user } }
// shape the frontend types describe. Normalize both here so login and
// session restore actually work (without this, login throws reading
// data.accessToken and the sidebar crashes on the unknown role).
const ROLE_MAP: Record<string, Role> = {
  super_admin: 'SUPER_ADMIN',
  exam_officer: 'EXAM_OFFICER',
  finance: 'FINANCE',
  lecturer: 'LECTURER',
  student: 'STUDENT',
  exam_controller: 'EXAM_CONTROLLER',
  department_head: 'DEPARTMENT_HEAD',
  invigilator: 'INVIGILATOR',
};

function normalizeAuthUser(raw: unknown): AuthUser {
  const u = raw as Record<string, unknown>;
  const role = String(u.role ?? '');
  return {
    id: String(u.id ?? ''),
    email: String(u.email ?? ''),
    fullName: String(u.fullName ?? u.full_name ?? ''),
    // NOTE: services/api.ts AuthUser['role'] now lists the three new
    // roles (EXAM_CONTROLLER / DEPARTMENT_HEAD / INVIGILATOR), so the
    // cast below is just the backend snake_case → frontend UPPER_SNAKE
    // mapping through ROLE_MAP above.
    role: (ROLE_MAP[role] ?? role) as AuthUser['role'],
    photoUrl: (u.photoUrl ?? u.avatar_url ?? null) as string | null,
    // /auth/me returns Postgres ints for the linked ids; convert them to
    // strings for real — a bare `as string` cast leaves a number at
    // runtime, which broke strict-equality comparisons downstream
    // (e.g. Students page: "1" === 1 was false for every row).
    departmentId: ((u.departmentId ?? u.department_id ?? null) == null ? null : String(u.departmentId ?? u.department_id)),
    studentId: ((u.studentId ?? u.student_id ?? null) == null ? null : String(u.studentId ?? u.student_id)),
    lecturerId: ((u.lecturerId ?? u.lecturer_id ?? null) == null ? null : String(u.lecturerId ?? u.lecturer_id)),
  };
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restore session on load: token present -> validate via /auth/me.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.get()) { setLoading(false); return; }
      try {
        const { data } = await authApi.me();
        if (!cancelled) setUser(normalizeAuthUser(data.data));
      } catch {
        tokenStore.clear();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    try {
      const { data } = await authApi.login(email.trim().toLowerCase(), password);
      // Backend login body is { success, token, user } (flat); tolerate
      // the { data: { accessToken, user } } shape too.
      const body = data as unknown as {
        token?: string;
        user?: unknown;
        data?: { accessToken?: string; refreshToken?: string; user?: unknown };
      };
      const token = body.token ?? body.data?.accessToken;
      const rawUser = body.user ?? body.data?.user;
      if (!token || !rawUser) throw new Error('Unexpected login response from the server.');
      tokenStore.set(token, body.data?.refreshToken);
      setUser(normalizeAuthUser(rawUser));
    } catch (err) {
      setError(apiErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* token may already be expired */ }
    tokenStore.clear();
    setUser(null);
  }, []);

  const hasRole = useCallback(
    (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const canAccess = useCallback(
    (path: string) => {
      if (!user) return false;
      const allowed = ROLE_ROUTES[user.role];
      return allowed.includes('*') || allowed.some((p) => path === p || path.startsWith(`${p}/`));
    },
    [user],
  );

  const setPhotoUrl = useCallback(
    (photoUrl: string | null) => setUser((prev) => (prev ? { ...prev, photoUrl } : prev)),
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      error,
      isAuthenticated: Boolean(user),
      login,
      logout,
      hasRole,
      canAccess,
      clearError: () => setError(null),
      setPhotoUrl,
    }),
    [user, loading, error, login, logout, hasRole, canAccess, setPhotoUrl],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
