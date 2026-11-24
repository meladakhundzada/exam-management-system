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

export type Role = AuthUser['role'] | 'FINANCE';

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  EXAM_OFFICER: 'Examination Officer',
  FINANCE: 'Finance Officer',
  LECTURER: 'Lecturer',
  STUDENT: 'Student',
};

// Route-level permission matrix. Keep in sync with backend RBAC middleware.
export const ROLE_ROUTES: Record<Role, string[]> = {
  SUPER_ADMIN: ['*'],
  EXAM_OFFICER: [
    '/dashboard', '/students', '/lecturers', '/departments', '/subjects',
    '/exams', '/timetable', '/attendance', '/marks', '/results', '/fees',
    '/complaints', '/reports', '/notifications',
  ],
  FINANCE: ['/dashboard', '/fees', '/reports'],
  LECTURER: ['/dashboard', '/students', '/subjects', '/exams', '/timetable', '/attendance', '/marks', '/results', '/reports', '/complaints', '/notifications', '/settings'],
  STUDENT: ['/dashboard', '/profile', '/my-courses', '/my-attendance', '/timetable', '/results', '/fees', '/admit-card', '/complaints', '/settings'],
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
};

function normalizeAuthUser(raw: unknown): AuthUser {
  const u = raw as Record<string, unknown>;
  const role = String(u.role ?? '');
  return {
    id: String(u.id ?? ''),
    email: String(u.email ?? ''),
    fullName: String(u.fullName ?? u.full_name ?? ''),
    role: (ROLE_MAP[role] ?? role) as Role,
    departmentId: (u.departmentId ?? u.department_id ?? null) as string | null,
    studentId: (u.studentId ?? u.student_id ?? null) as string | null,
    lecturerId: (u.lecturerId ?? u.lecturer_id ?? null) as string | null,
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
    }),
    [user, loading, error, login, logout, hasRole, canAccess],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
