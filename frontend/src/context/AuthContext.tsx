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

export type Role = AuthUser['role'];

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  EXAM_OFFICER: 'Examination Officer',
  LECTURER: 'Lecturer',
  STUDENT: 'Student',
};

// Route-level permission matrix. Keep in sync with backend RBAC middleware.
export const ROLE_ROUTES: Record<Role, string[]> = {
  SUPER_ADMIN: ['*'],
  EXAM_OFFICER: [
    '/dashboard', '/students', '/lecturers', '/departments', '/subjects',
    '/exams', '/timetable', '/attendance', '/marks', '/results',
    '/complaints', '/reports', '/notifications', '/audit-logs',
  ],
  LECTURER: ['/dashboard', '/subjects', '/exams', '/timetable', '/marks', '/results'],
  STUDENT: ['/dashboard', '/timetable', '/results', '/admit-card', '/complaints'],
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
        if (!cancelled) setUser(data.data);
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
      tokenStore.set(data.data.accessToken, data.data.refreshToken);
      setUser(data.data.user);
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
