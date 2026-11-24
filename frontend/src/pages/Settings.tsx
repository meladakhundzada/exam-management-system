import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import {
  authApi, gradeScalesApi, GradeScale, apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

type GradeRow = Omit<GradeScale, 'id'> & { id: string };

export default function Settings() {
  // Grade scale and backup are Super Admin only; every other role that
  // can open this page (students and lecturers) sees only the Change
  // password section. Change password (POST /auth/change-password) allows
  // any authenticated role, so lecturers can use this page without a 403.
  const { hasRole } = useAuth();
  const isAdmin = hasRole('SUPER_ADMIN');
  // Change password.
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  // Grade scale.
  const [scales, setScales] = useState<GradeRow[]>([]);
  const [scalesLoading, setScalesLoading] = useState(true);
  const [scalesError, setScalesError] = useState<string | null>(null);
  const [scalesNotice, setScalesNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<GradeRow | null>(null);
  const [editForm, setEditForm] = useState({ min: 0, max: 0, point: 0, passing: true });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const loadScales = async () => {
    setScalesLoading(true);
    try {
      const { data } = await gradeScalesApi.list();
      setScales((data.data as unknown as GradeScale[]).map((g) => ({ ...g, id: g.grade })));
      setScalesError(null);
    } catch (err) {
      setScalesError(apiErrorMessage(err));
    } finally {
      setScalesLoading(false);
    }
  };

  useEffect(() => { if (isAdmin) loadScales(); }, [isAdmin]);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwForm.next.length < 8) { setPwError('The new password must be at least 8 characters.'); return; }
    if (pwForm.next !== pwForm.confirm) { setPwError('The new passwords do not match.'); return; }
    setPwSaving(true);
    try {
      await authApi.changePassword(pwForm.current, pwForm.next);
      setPwNotice('Password changed.');
      setPwError(null);
      setPwForm({ current: '', next: '', confirm: '' });
    } catch (err) {
      setPwError(apiErrorMessage(err));
      setPwNotice(null);
    } finally {
      setPwSaving(false);
    }
  };

  const openEdit = (g: GradeRow) => {
    setEditing(g);
    setEditForm({
      min: Number(g.min_marks), max: Number(g.max_marks),
      point: Number(g.grade_point), passing: g.is_passing !== false,
    });
    setEditError(null);
  };

  const saveGrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    if (editForm.max < editForm.min) { setEditError('Max marks must be at least min marks.'); return; }
    if (editForm.point < 0 || editForm.point > 4) { setEditError('Grade point must be between 0 and 4.'); return; }
    setEditSaving(true);
    try {
      await gradeScalesApi.update(editing.grade, {
        min_marks: editForm.min,
        max_marks: editForm.max,
        grade_point: editForm.point,
        is_passing: editForm.passing,
      });
      setScalesNotice(`Grade ${editing.grade} updated.`);
      setEditing(null);
      await loadScales();
    } catch (err) {
      setEditError(apiErrorMessage(err));
    } finally {
      setEditSaving(false);
    }
  };

  const columns: Column<GradeRow>[] = [
    { key: 'grade', header: 'Grade', sortable: true, accessor: (r) => r.grade },
    { key: 'min', header: 'Min marks', sortable: true, accessor: (r) => Number(r.min_marks) },
    { key: 'max', header: 'Max marks', sortable: true, accessor: (r) => Number(r.max_marks) },
    { key: 'point', header: 'Grade point', sortable: true, accessor: (r) => Number(r.grade_point) },
    {
      key: 'passing', header: 'Passing', accessor: (r) => (r.is_passing ? 'Yes' : 'No'),
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.is_passing ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
          {r.is_passing ? 'Passing' : 'Failing'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings{isAdmin ? ', Grade Scale & Backup' : ''}</h1>
        <p className="text-sm text-slate-500">
          {isAdmin ? 'Super Admin only.' : 'Change the password of the account you are signed in with.'}
        </p>
      </div>

      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Change password</h2>
        <p className="text-sm text-slate-500">Change the password of the account you are signed in with.</p>
        {pwError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{pwError}</p>}
        {pwNotice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{pwNotice}</p>}
        <form onSubmit={changePassword} className="mt-4 grid max-w-lg grid-cols-1 gap-4">
          <label className="text-sm font-medium">Current password
            <input required type="password" autoComplete="current-password" value={pwForm.current} onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })} className={inputCls} />
          </label>
          <label className="text-sm font-medium">New password (at least 8 characters)
            <input required type="password" minLength={8} autoComplete="new-password" value={pwForm.next} onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })} className={inputCls} />
          </label>
          <label className="text-sm font-medium">Confirm new password
            <input required type="password" autoComplete="new-password" value={pwForm.confirm} onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })} className={inputCls} />
          </label>
          <div>
            <button type="submit" disabled={pwSaving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {pwSaving ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </section>

      {isAdmin && (
      <>
      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Grade scale</h2>
        <p className="text-sm text-slate-500">The bands used to convert marks into grades and grade points. Editing a band affects future result calculations.</p>
        {scalesError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{scalesError}</p>}
        {scalesNotice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{scalesNotice}</p>}
        <div className="mt-4">
          <DataTable<GradeRow>
            columns={columns}
            data={scales}
            loading={scalesLoading}
            emptyMessage="No grade scale rows found."
            actions={(row) => (
              <button onClick={() => openEdit(row)} className="text-navy-600 hover:underline">Edit</button>
            )}
          />
        </div>
      </section>

      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Backup</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          <strong>Not available in the app:</strong> the API has no backup / export endpoint
          (no <code>/api/*/backup</code> route exists), so there is no in-app backup button.
          Back up the PostgreSQL database directly instead — for example with{' '}
          <code>pg_dump</code> against <code>DATABASE_URL</code>, or from the Render dashboard
          for the hosted database. Keep the backup file somewhere safe and never paste
          database credentials into this app.
        </p>
      </section>
      </>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Edit grade band">
          <form onSubmit={saveGrade} className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Edit grade {editing.grade}</h2>
            {editError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{editError}</p>}
            <div className="mt-4 grid grid-cols-2 gap-4">
              <label className="text-sm font-medium">Min marks
                <input required type="number" min={0} max={100} step={0.01} value={editForm.min} onChange={(e) => setEditForm({ ...editForm, min: Number(e.target.value) })} className={inputCls} />
              </label>
              <label className="text-sm font-medium">Max marks
                <input required type="number" min={0} max={100} step={0.01} value={editForm.max} onChange={(e) => setEditForm({ ...editForm, max: Number(e.target.value) })} className={inputCls} />
              </label>
              <label className="text-sm font-medium">Grade point (0–4)
                <input required type="number" min={0} max={4} step={0.01} value={editForm.point} onChange={(e) => setEditForm({ ...editForm, point: Number(e.target.value) })} className={inputCls} />
              </label>
              <label className="flex items-center gap-2 self-end text-sm font-medium">
                <input type="checkbox" checked={editForm.passing} onChange={(e) => setEditForm({ ...editForm, passing: e.target.checked })} />
                Passing grade
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={editSaving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {editSaving ? 'Saving…' : 'Save grade'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
