import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import {
  departmentsApi, facultiesApi, Department, Faculty, apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

// DataTable needs a string id; keep the numeric id alongside it.
type DepartmentRow = Omit<Department, 'id'> & { id: string; deptId: number };

const NEW_FACULTY = '__new__';

export default function Departments() {
  const { hasRole } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null);
  const [form, setForm] = useState({
    name: '', code: '', facultyChoice: '', facultyName: '', facultyCode: '', headName: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [{ data: deptRes }, { data: facRes }] = await Promise.all([
        departmentsApi.list(),
        facultiesApi.list(),
      ]);
      setDepartments(deptRes.data);
      setFaculties(facRes.data);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setForm({
      name: '', code: '', headName: '',
      // No faculties yet (unseeded database) → default to creating one.
      facultyChoice: faculties.length ? '' : NEW_FACULTY,
      facultyName: '', facultyCode: '',
    });
    setFormError(null);
    setFormOpen(true);
  };

  const validate = () => {
    if (form.name.trim().length < 2) return 'Department name is required.';
    if (!/^[A-Za-z0-9-]{2,20}$/.test(form.code.trim())) return 'Department code must be 2–20 letters, digits or hyphens (e.g. CS).';
    if (!form.facultyChoice) return 'Choose a faculty, or create a new one.';
    if (form.facultyChoice === NEW_FACULTY && form.facultyName.trim().length < 2) {
      return 'Enter the new faculty name (e.g. Faculty of Computer Science).';
    }
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) { setFormError(v); return; }
    setSaving(true);
    try {
      await departmentsApi.create({
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        faculty_id: form.facultyChoice === NEW_FACULTY ? undefined : Number(form.facultyChoice),
        faculty_name: form.facultyChoice === NEW_FACULTY ? form.facultyName.trim() : undefined,
        faculty_code: form.facultyChoice === NEW_FACULTY && form.facultyCode.trim()
          ? form.facultyCode.trim().toUpperCase() : undefined,
        head_name: form.headName.trim() || undefined,
      });
      setNotice(`Department ${form.name.trim()} (${form.code.trim().toUpperCase()}) created.`);
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await departmentsApi.remove(deleteTarget.id);
      setNotice(`Department ${deleteTarget.name} deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
      setDeleteTarget(null);
    }
  };

  const columns: Column<DepartmentRow>[] = [
    { key: 'code', header: 'Code', sortable: true, accessor: (r) => r.code },
    { key: 'name', header: 'Department', sortable: true, accessor: (r) => r.name },
    { key: 'faculty', header: 'Faculty', sortable: true, accessor: (r) => r.faculty_name },
    { key: 'head', header: 'Head of department', accessor: (r) => r.head_name ?? '—' },
  ];

  const rows: DepartmentRow[] = departments.map((d) => ({ ...d, id: String(d.id), deptId: d.id }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Departments &amp; Faculties</h1>
          <p className="text-sm text-slate-500">Manage faculties and departments. Lecturers and students belong to a department, so create one here first.</p>
        </div>
        <div className="ml-auto flex gap-2">
          {canManage && (
            <button onClick={openCreate} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700">+ Add Department</button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <DataTable<DepartmentRow>
        columns={columns}
        data={rows}
        loading={loading}
        emptyMessage="No departments yet — create the first one with + Add Department above."
        searchableKeys={[(r) => r.name, (r) => r.code, (r) => r.faculty_name]}
        actions={canManage ? (row) => (
          <span className="flex gap-2">
            <button
              onClick={() => setDeleteTarget(departments.find((d) => d.id === row.deptId) ?? null)}
              className="text-red-600 hover:underline"
            >Delete</button>
          </span>
        ) : undefined}
      />

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Department form">
          <form onSubmit={submit} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Add department</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Department name
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Computer Science" className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
              </label>
              <label className="text-sm font-medium">Department code
                <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. CS" className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
              </label>
              <label className="text-sm font-medium">Faculty
                <select value={form.facultyChoice} onChange={(e) => setForm({ ...form, facultyChoice: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                  <option value="">Choose a faculty…</option>
                  {faculties.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.code})</option>)}
                  <option value={NEW_FACULTY}>+ New faculty…</option>
                </select>
              </label>
              <label className="text-sm font-medium">Head of department (optional)
                <input value={form.headName} onChange={(e) => setForm({ ...form, headName: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
              </label>
            </div>
            {form.facultyChoice === NEW_FACULTY && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium">New faculty name
                  <input required value={form.facultyName} onChange={(e) => setForm({ ...form, facultyName: e.target.value })} placeholder="e.g. Faculty of Computer Science" className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
                </label>
                <label className="text-sm font-medium">New faculty code (optional)
                  <input value={form.facultyCode} onChange={(e) => setForm({ ...form, facultyCode: e.target.value })} placeholder="e.g. FOCS" className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
                </label>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : 'Create department'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Delete department?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This deletes {deleteTarget.name} ({deleteTarget.code}). It will fail if lecturers,
              students or subjects still belong to it. This cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button onClick={confirmDelete} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
