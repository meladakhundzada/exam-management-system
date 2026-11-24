import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import {
  subjectsApi, departmentsApi, lecturersApi, referenceApi,
  Subject, SubjectPayload, Department, apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

type SubjectRow = Omit<Subject, 'id'> & { id: string; subjectId: number };

const mapSubject = (r: Subject): SubjectRow => ({ ...r, id: String(r.id), subjectId: r.id });

interface FormState {
  code: string;
  title: string;
  departmentId: string;
  creditHours: number;
  semesterId: string;
  lecturerId: string;
  description: string;
  isActive: boolean;
}

const emptyForm: FormState = {
  code: '', title: '', departmentId: '', creditHours: 3,
  semesterId: '', lecturerId: '', description: '', isActive: true,
};

export default function Subjects() {
  const { hasRole, user } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const canDelete = hasRole('SUPER_ADMIN');
  // Lecturers see only their own assigned subjects, read-only.
  const isLecturer = hasRole('LECTURER');
  const myLecturerId = user?.lecturerId ? Number(user.lecturerId) : null;
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [semesters, setSemesters] = useState<Array<{ id: number; name: string; semester_number: number }>>([]);
  const [lecturers, setLecturers] = useState<Array<{ id: number; full_name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SubjectRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubjectRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // The backend does NOT scope GET /api/subjects to the caller — it
      // returns every subject unless ?lecturer_id= is passed, so pass it
      // for lecturers and also filter client-side (by lecturer_id, falling
      // back to lecturer name when the account has no linked lecturer id).
      const params = isLecturer && myLecturerId
        ? { limit: 500, lecturer_id: myLecturerId }
        : { limit: 500 };
      const { data } = await subjectsApi.list(params);
      let rows = (data.data as unknown as Subject[]).map(mapSubject);
      if (isLecturer) {
        const byId = myLecturerId !== null ? rows.filter((r) => r.lecturer_id === myLecturerId) : [];
        const byName = user?.fullName ? rows.filter((r) => r.lecturer_name === user.fullName) : [];
        const mine = byId.length > 0 ? byId : byName;
        // Only narrow the list when the link resolves; if neither the id
        // nor the name matches anything, keep the server-filtered list
        // rather than showing an empty page because of a missing link.
        if (mine.length > 0) rows = mine;
      }
      setSubjects(rows);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    departmentsApi.list().then(({ data }) => setDepartments(data.data)).catch(() => setDepartments([]));
    referenceApi.get()
      .then(({ data }) => setSemesters(data.data.semesters))
      .catch(() => setSemesters([]));
    // Lecturer dropdown is staff-only (GET /api/lecturers is
    // super_admin / exam_officer); lecturers see a read-only list here.
    if (canManage) {
      lecturersApi.list({ limit: 500 })
        .then(({ data }) => setLecturers(data.data as unknown as Array<{ id: number; full_name: string }>))
        .catch(() => setLecturers([]));
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (s: SubjectRow) => {
    setEditing(s);
    setForm({
      code: s.code,
      title: s.title,
      departmentId: String(s.department_id),
      creditHours: Number(s.credit_hours ?? 3),
      semesterId: s.semester_id ? String(s.semester_id) : '',
      lecturerId: s.lecturer_id ? String(s.lecturer_id) : '',
      description: s.description ?? '',
      isActive: s.is_active !== false,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const validate = () => {
    if (!/^[A-Za-z0-9-]{2,20}$/.test(form.code.trim())) return 'Subject code must be 2–20 letters, digits or hyphens (e.g. CS-101).';
    if (form.title.trim().length < 2) return 'Subject title is required.';
    if (!form.departmentId) return 'Choose a department.';
    if (form.creditHours < 0.5 || form.creditHours > 6) return 'Credit hours must be between 0.5 and 6.';
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) { setFormError(v); return; }
    setSaving(true);
    try {
      const payload: SubjectPayload = {
        code: form.code.trim().toUpperCase(),
        title: form.title.trim(),
        department_id: Number(form.departmentId),
        credit_hours: form.creditHours,
        semester_id: form.semesterId ? Number(form.semesterId) : undefined,
        lecturer_id: form.lecturerId ? Number(form.lecturerId) : undefined,
        description: form.description.trim() || undefined,
        is_active: form.isActive,
      };
      if (editing) {
        await subjectsApi.update(editing.subjectId, payload);
        setNotice(`Subject ${payload.code} updated.`);
      } else {
        await subjectsApi.create(payload);
        setNotice(`Subject ${payload.code} created.`);
      }
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
      await subjectsApi.remove(deleteTarget.subjectId);
      setNotice(`Subject ${deleteTarget.code} deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
      setDeleteTarget(null);
    }
  };

  const columns: Column<SubjectRow>[] = [
    { key: 'code', header: 'Code', sortable: true, accessor: (r) => r.code },
    { key: 'title', header: 'Title', sortable: true, accessor: (r) => r.title },
    { key: 'department', header: 'Department', sortable: true, accessor: (r) => r.department_name ?? '—' },
    { key: 'credits', header: 'Credits', sortable: true, accessor: (r) => Number(r.credit_hours ?? 0) },
    { key: 'semester', header: 'Semester', accessor: (r) => r.semester_name ?? '—' },
    { key: 'lecturer', header: 'Lecturer', accessor: (r) => r.lecturer_name ?? '—' },
    {
      key: 'status', header: 'Status', accessor: (r) => (r.is_active === false ? 'Inactive' : 'Active'),
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.is_active === false ? 'bg-slate-100 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>
          {r.is_active === false ? 'Inactive' : 'Active'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Subjects &amp; Courses</h1>
          <p className="text-sm text-slate-500">{isLecturer ? 'Your assigned subjects (read-only).' : 'Manage subjects by department. Lecturers see this list read-only.'}</p>
        </div>
        {canManage && (
          <button onClick={openCreate} className="ml-auto rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700">+ Add Subject</button>
        )}
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <DataTable<SubjectRow>
        columns={columns}
        data={subjects}
        loading={loading}
        emptyMessage={isLecturer ? 'No subjects assigned to you yet.' : 'No subjects yet — create the first one with + Add Subject above.'}
        searchableKeys={[(r) => r.code, (r) => r.title, (r) => r.department_name ?? '']}
        filters={[
          { label: 'Active', value: 'active', test: (r) => r.is_active !== false },
          { label: 'Inactive', value: 'inactive', test: (r) => r.is_active === false },
        ]}
        actions={canManage ? (row) => (
          <span className="flex gap-2">
            <button onClick={() => openEdit(row)} className="text-navy-600 hover:underline">Edit</button>
            {canDelete && <button onClick={() => setDeleteTarget(row)} className="text-red-600 hover:underline">Delete</button>}
          </span>
        ) : undefined}
      />

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Subject form">
          <form onSubmit={submit} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">{editing ? 'Edit subject' : 'Add subject'}</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Subject code
                <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. CS-101" className={inputCls} />
              </label>
              <label className="text-sm font-medium">Title
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Introduction to Programming" className={inputCls} />
              </label>
              <label className="text-sm font-medium">Department
                <select required value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} className={inputCls}>
                  <option value="">Choose a department…</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.code})</option>)}
                </select>
              </label>
              <label className="text-sm font-medium">Credit hours (0.5–6)
                <input required type="number" min={0.5} max={6} step={0.5} value={form.creditHours} onChange={(e) => setForm({ ...form, creditHours: Number(e.target.value) })} className={inputCls} />
              </label>
              <label className="text-sm font-medium">Semester (optional)
                <select value={form.semesterId} onChange={(e) => setForm({ ...form, semesterId: e.target.value })} className={inputCls}>
                  <option value="">Not assigned</option>
                  {semesters.map((s) => <option key={s.id} value={s.id}>{s.name} (Semester {s.semester_number})</option>)}
                </select>
              </label>
              <label className="text-sm font-medium">Lecturer (optional)
                <select value={form.lecturerId} onChange={(e) => setForm({ ...form, lecturerId: e.target.value })} className={inputCls}>
                  <option value="">Not assigned</option>
                  {lecturers.map((l) => <option key={l.id} value={l.id}>{l.full_name}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium sm:col-span-2">Description (optional)
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} />
              </label>
              {editing && (
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                  Active
                </label>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create subject'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Delete subject?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This deletes {deleteTarget.code} — {deleteTarget.title}. It will fail if exams, marks,
              results, schedules or enrolments still reference it. This cannot be undone.
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
