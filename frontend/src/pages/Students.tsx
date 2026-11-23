import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import { studentsApi, Student, apiErrorMessage, downloadBlob } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE: Record<Student['status'], string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SUSPENDED: 'bg-amber-100 text-amber-700',
  GRADUATED: 'bg-blue-100 text-blue-700',
  WITHDRAWN: 'bg-red-100 text-red-700',
};

export default function Students() {
  const { hasRole } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Student | null>(null);
  const [form, setForm] = useState({ studentNo: '', fullName: '', email: '', phone: '', departmentId: '', academicYear: '2025-2026', semester: 1 });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await studentsApi.list({ limit: 500 });
      setStudents(data.data);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ studentNo: '', fullName: '', email: '', phone: '', departmentId: '', academicYear: '2025-2026', semester: 1 });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (s: Student) => {
    setEditing(s);
    setForm({ studentNo: s.studentNo, fullName: s.fullName, email: s.email, phone: s.phone ?? '', departmentId: s.departmentId, academicYear: s.academicYear, semester: s.semester });
    setFormError(null);
    setFormOpen(true);
  };

  const validate = () => {
    if (!/^[A-Za-z0-9-]{4,20}$/.test(form.studentNo)) return 'Student number must be 4–20 letters, digits or hyphens.';
    if (form.fullName.trim().length < 3) return 'Full name is required (at least 3 characters).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address.';
    if (!form.departmentId) return 'Choose a department.';
    if (form.semester < 1 || form.semester > 8) return 'Semester must be between 1 and 8.';
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) { setFormError(v); return; }
    setSaving(true);
    try {
      if (editing) await studentsApi.update(editing.id, { ...form, status: editing.status });
      else await studentsApi.create({ ...form, status: 'ACTIVE', enrollmentDate: new Date().toISOString().slice(0, 10) });
      setNotice(editing ? `Student ${form.studentNo} updated.` : `Student ${form.studentNo} registered.`);
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
      await studentsApi.remove(deleteTarget.id);
      setNotice(`Student ${deleteTarget.studentNo} deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
      setDeleteTarget(null);
    }
  };

  const exportCsv = async () => {
    try {
      const res = await studentsApi.exportCsv();
      downloadBlob(res.data, 'students.csv');
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const columns: Column<Student>[] = [
    { key: 'studentNo', header: 'Student No.', sortable: true, accessor: (r) => r.studentNo },
    { key: 'fullName', header: 'Name', sortable: true, accessor: (r) => r.fullName },
    { key: 'email', header: 'Email', accessor: (r) => r.email },
    { key: 'departmentName', header: 'Department', sortable: true, accessor: (r) => r.departmentName },
    { key: 'semester', header: 'Semester', sortable: true, accessor: (r) => r.semester },
    {
      key: 'status', header: 'Status', accessor: (r) => r.status,
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>{r.status}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Students</h1>
          <p className="text-sm text-slate-500">Register and manage students. Student numbers and emails must be unique.</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={exportCsv} className="rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-800">Export CSV</button>
          {canManage && (
            <button onClick={openCreate} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700">+ Add Student</button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <DataTable<Student>
        columns={columns}
        data={students}
        loading={loading}
        searchableKeys={[(r) => r.fullName, (r) => r.studentNo, (r) => r.email]}
        filters={[
          { label: 'Active', value: 'ACTIVE', test: (r) => r.status === 'ACTIVE' },
          { label: 'Suspended', value: 'SUSPENDED', test: (r) => r.status === 'SUSPENDED' },
          { label: 'Graduated', value: 'GRADUATED', test: (r) => r.status === 'GRADUATED' },
        ]}
        actions={canManage ? (row) => (
          <span className="flex gap-2">
            <button onClick={() => openEdit(row)} className="text-navy-600 hover:underline">Edit</button>
            <button onClick={() => setDeleteTarget(row)} className="text-red-600 hover:underline">Delete</button>
          </span>
        ) : undefined}
      />

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Student form">
          <form onSubmit={submit} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">{editing ? 'Edit student' : 'Register student'}</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Student No.
                <input required value={form.studentNo} onChange={(e) => setForm({ ...form, studentNo: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Full name
                <input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Email
                <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Phone
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Department ID
                <input required value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} placeholder="e.g. dept-cs-01" className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Semester (1–8)
                <input required type="number" min={1} max={8} value={form.semester} onChange={(e) => setForm({ ...form, semester: Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Register'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Delete student?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This deletes {deleteTarget.fullName} ({deleteTarget.studentNo}) and their enrolments.
              Marks and results already published are kept in the audit log but the student record is removed. This cannot be undone.
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
