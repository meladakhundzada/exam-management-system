import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiErrorMessage, authApi } from '../services/api';

// First-time setup: creates the first Super Admin via
// POST /api/auth/setup-first-admin. The backend only allows this while
// no users exist yet (403 "Setup already completed: users exist").
// The password is chosen by the user here — never prefilled or hardcoded.
export default function Setup() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('melad');
  const [email, setEmail] = useState('meladakhundzada@gmail.com');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      await authApi.setupFirstAdmin(fullName.trim(), email.trim().toLowerCase(), password);
      setSuccess(true);
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-900 px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl dark:bg-slate-800">
        <h1 className="text-2xl font-bold text-navy-900 dark:text-white">Create the first Super Admin</h1>
        <p className="mt-1 text-sm text-slate-500">
          One-time setup. This only works before any user exists.
        </p>
        {error && (
          <div role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </div>
        )}
        {success && (
          <div role="status" className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300">
            Super Admin created. Redirecting to the login page…
          </div>
        )}
        <label className="mt-6 block text-sm font-medium" htmlFor="setup-name">Full name</label>
        <input id="setup-name" type="text" required autoComplete="name" value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
        <label className="mt-4 block text-sm font-medium" htmlFor="setup-email">Email</label>
        <input id="setup-email" type="email" required autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
        <label className="mt-4 block text-sm font-medium" htmlFor="setup-password">Password</label>
        <div className="relative">
          <input id="setup-password" type={showPassword ? 'text' : 'password'} required
            autoComplete="new-password" minLength={8} value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters"
            className="mt-1 w-full rounded-lg border px-3 py-2 pr-16 dark:border-slate-600 dark:bg-slate-900" />
          <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-navy-600">
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
        <button type="submit" disabled={loading || success} className="mt-6 w-full rounded-lg bg-navy-600 py-2.5 font-semibold text-white hover:bg-navy-700 disabled:opacity-50">
          {loading ? 'Creating…' : 'Create Super Admin'}
        </button>
        <p className="mt-4 text-center text-sm">
          <Link to="/login" className="text-navy-600 hover:underline">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
