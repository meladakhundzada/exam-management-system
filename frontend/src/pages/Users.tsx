import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  usersApi, studentsApi, departmentsApi, apiErrorMessage,
  AppUser, UserRole, CreateUserPayload,
} from '../services/api';
import { useAuth, ROLE_LABELS } from '../context/AuthContext';
import { nextStudentId } from '../utils/studentId';

const CURRENT_YEAR = new Date().getFullYear();

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'exam_officer', label: 'Examination Officer' },
  { value: 'finance', label: 'Finance Officer' },
  { value: 'lecturer', label: 'Lecturer' },
  { value: 'student', label: 'Student' },
  { value: 'exam_controller', label: 'Examination Controller' },
  { value: 'department_head', label: 'Department Head' },
  { value: 'invigilator', label: 'Examination Invigilator' },
];

const ROLE_BADGE: Record<UserRole, string> = {
  super_admin: 'bg-navy-100 text-navy-800',
  exam_officer: 'bg-blue-100 text-blue-700',
  finance: 'bg-amber-100 text-amber-700',
  lecturer: 'bg-violet-100 text-violet-700',
  student: 'bg-emerald-100 text-emerald-700',
  exam_controller: 'bg-teal-100 text-teal-700',
  department_head: 'bg-orange-100 text-orange-700',
  invigilator: 'bg-cyan-100 text-cyan-700',
};

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

export default function Users() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<CreateUserPayload>({
    full_name: '', email: '', password: '', role: 'exam_officer',
  });
  // Student numbers for auto-generation (loaded once; null = list unavailable).
  const [studentNos, setStudentNos] = useState<string[] | null>(null);
  // True while the Student ID field still holds our auto-generated value
  // (not something the user typed) — so it can be recomputed once the
  // student list finishes loading.
  const studentIdAuto = useRef(false);
  const [editTarget, setEditTarget] = useState<AppUser | null>(null);
  const [editForm, setEditForm] = useState({ full_name: '', phone: '', role: 'exam_officer' as UserRole, is_active: true });

  const load = async (p = 1) => {
    setLoading(true);
    try {
      const { data } = await usersApi.list({ page: p, limit: 20, search: search || undefined, role: roleFilter || undefined });
      setUsers(data.data);
      setTotalPages(data.pagination?.totalPages ?? 1);
      setPage(p);
      setError(null);
    } catch (err) { setError(apiErrorMessage(err)); } finally { setLoading(false); }
  };

  useEffect(() => {
    departmentsApi.list()
      .then(({ data }) => setDepartments(data.data))
      .catch(() => setDepartments([]));
    studentsApi.list({ limit: 500 })
      .then(({ data }) => setStudentNos((data.data as unknown as Array<Record<string, unknown>>).map((r) => String(r.student_id ?? ''))))
      .catch(() => setStudentNos(null));
    load(1);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  // When Student is chosen, prefill the next auto student number and the
  // current admission year — the user can still type a different ID.
  useEffect(() => {
    if (createForm.role === 'student' && !createForm.student_id) {
      studentIdAuto.current = true;
      setCreateForm((f) => ({
        ...f,
        student_id: nextStudentId(studentNos),
        admission_year: f.admission_year ?? CURRENT_YEAR,
      }));
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [createForm.role]);

  // Recompute the auto ID once the student list arrives (it may load after
  // the role was chosen); never overwrite a manually typed ID.
  useEffect(() => {
    if (createForm.role === 'student' && studentIdAuto.current && studentNos !== null) {
      setCreateForm((f) => ({ ...f, student_id: nextStudentId(studentNos) }));
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [studentNos]);

  useEffect(() => {
    const t = setTimeout(() => { load(1); }, 400);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [search, roleFilter]);

  const needsDepartment = createForm.role === 'lecturer' || createForm.role === 'student' || createForm.role === 'department_head';

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createForm.full_name.trim().length < 2) { setFormError('Full name is required.'); return; }
    if (createForm.password.length < 8) { setFormError('Password must be at least 8 characters.'); return; }
    if (needsDepartment && !createForm.department_id) { setFormError('Choose a department for a lecturer or student account.'); return; }
    // Student ID / admission year are auto-generated when left blank:
    // next plain number (001, 002, ...) from the existing students.
    const studentId = createForm.role === 'student'
      ? (createForm.student_id?.trim() || nextStudentId(studentNos))
      : undefined;
    const admissionYear = createForm.role === 'student'
      ? (createForm.admission_year ?? CURRENT_YEAR)
      : undefined;
    setSaving(true);
    try {
      const payload: CreateUserPayload = {
        full_name: createForm.full_name.trim(),
        email: createForm.email.trim().toLowerCase(),
        password: createForm.password,
        role: createForm.role,
        phone: createForm.phone || undefined,
        department_id: createForm.department_id,
        employee_id: createForm.employee_id || undefined,
        student_id: studentId,
        admission_year: admissionYear,
        current_semester: createForm.current_semester,
      };
      const { data } = await usersApi.create(payload);
      setNotice(`User ${data.data.email} created as ${ROLE_LABELS[data.data.role as keyof typeof ROLE_LABELS] ?? data.data.role}.`);
      setCreateForm({ full_name: '', email: '', password: '', role: 'exam_officer' });
      studentIdAuto.current = false;
      // Keep the auto-ID source fresh for the next student.
      if (studentId) setStudentNos((prev) => (prev ? [...prev, studentId] : prev));
      setFormError(null);
      await load(1);
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const openEdit = (u: AppUser) => {
    setEditTarget(u);
    setEditForm({ full_name: u.full_name, phone: u.phone ?? '', role: u.role, is_active: u.is_active });
    setFormError(null);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    setSaving(true);
    try {
      const isSelf = String(editTarget.id) === user?.id;
      await usersApi.update(editTarget.id, {
        full_name: editForm.full_name.trim(),
        phone: editForm.phone || undefined,
        role: isSelf ? undefined : editForm.role,
        is_active: isSelf ? undefined : editForm.is_active,
      });
      setNotice(`User ${editTarget.email} updated.`);
      setEditTarget(null);
      setFormError(null);
      await load(page);
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const deleteUser = async (u: AppUser) => {
    if (!window.confirm(`Delete user ${u.full_name} (${u.email})? This cannot be undone.`)) return;
    try {
      await usersApi.remove(u.id);
      setNotice(`User ${u.email} deleted.`);
      await load(page);
    } catch (err) { setError(apiErrorMessage(err)); }
  };

  if (loading && !users.length) return <p className="p-4">Loading users…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">User Management</h1>
        <p className="text-sm text-slate-500">Create login accounts for the Exam Officer, lecturers and students, change roles, deactivate or delete accounts. Only the Super Admin sees this page.</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <form onSubmit={createUser} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">Create user</h2>
          <p className="mt-1 text-xs text-slate-500">For the Exam Officer (abas), choose role Examination Officer. For a lecturer, the lecturer record is created (or linked, e.g. LEC-007) automatically; for a student, the student record is created the same way.</p>
          {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
          <label className="mt-4 block text-sm font-medium">Full name
            <input required value={createForm.full_name} onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })} placeholder="e.g. abas" className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Email
            <input required type="email" value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} placeholder="e.g. abbasaziz07825@gmail.com" className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Password (at least 8 characters)
            <input required type="password" minLength={8} value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} autoComplete="new-password" className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Role
            <select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as UserRole })} className={inputCls}>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium">Phone (optional)
            <input value={createForm.phone ?? ''} onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })} className={inputCls} />
          </label>
          {needsDepartment && (
            <>
              <label className="mt-3 block text-sm font-medium">Department
                <select value={createForm.department_id ?? ''} onChange={(e) => setCreateForm({ ...createForm, department_id: e.target.value ? Number(e.target.value) : undefined })} className={inputCls}>
                  <option value="">Choose a department…</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.code})</option>)}
                </select>
              </label>
              {!departments.length && (
                <p className="mt-2 text-xs text-amber-700">
                  No departments exist yet — <Link to="/departments" className="font-medium text-navy-600 hover:underline">create one on the Departments page</Link> first, then come back here.
                </p>
              )}
              {createForm.role === 'lecturer' && (
                <label className="mt-3 block text-sm font-medium">Employee ID (optional — auto-generated like LEC-008; use LEC-007 to link Eng Irfan)
                  <input value={createForm.employee_id ?? ''} onChange={(e) => setCreateForm({ ...createForm, employee_id: e.target.value })} placeholder="LEC-007" className={inputCls} />
                </label>
              )}
              {createForm.role === 'student' && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="mt-3 block text-sm font-medium">Student ID (auto — leave blank to generate)
                    <input value={createForm.student_id ?? ''} onChange={(e) => { studentIdAuto.current = false; setCreateForm({ ...createForm, student_id: e.target.value }); }} placeholder={`e.g. 002`} className={inputCls} />
                  </label>
                  <label className="mt-3 block text-sm font-medium">Admission year
                    <input type="number" min={2000} max={2100} value={createForm.admission_year ?? CURRENT_YEAR} onChange={(e) => setCreateForm({ ...createForm, admission_year: e.target.value ? Number(e.target.value) : undefined })} className={inputCls} />
                  </label>
                </div>
              )}
            </>
          )}
          <button type="submit" disabled={saving} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Creating…' : 'Create user'}</button>
          <p className="mt-3 text-xs text-slate-500">Give each person the password you chose for them yourself — never share passwords in chat. The user can change it after signing in (Settings → Change password).</p>
        </form>

        <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">All users</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email…" className="flex-1 rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">User</th><th className="px-2 py-3">Role</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Actions</th></tr></thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = String(u.id) === user?.id;
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-2 py-3 font-medium">{u.full_name}{isSelf && ' (you)'}
                        <span className="block text-xs font-normal text-slate-500">{u.email}</span>
                      </td>
                      <td className="px-2 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[u.role]}`}>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS] ?? u.role}</span></td>
                      <td className="px-2 py-3">{u.is_active ? <span className="text-emerald-600">Active</span> : <span className="text-red-600">Inactive</span>}</td>
                      <td className="px-2 py-3 space-x-3">
                        <button onClick={() => openEdit(u)} className="text-navy-600 hover:underline">Edit</button>
                        {!isSelf && <button onClick={() => deleteUser(u)} className="text-red-600 hover:underline">Delete</button>}
                      </td>
                    </tr>
                  );
                })}
                {!users.length && <tr><td colSpan={4} className="px-2 py-6 text-center text-slate-500">No users match this filter.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <button disabled={page <= 1} onClick={() => load(page - 1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-50">Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => load(page + 1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>

      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Edit user">
          <form onSubmit={saveEdit} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Edit user — {editTarget.email}</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <label className="mt-4 block text-sm font-medium">Full name
              <input required value={editForm.full_name} onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Phone
              <input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Role
              <select value={editForm.role} disabled={String(editTarget.id) === user?.id} onChange={(e) => setEditForm({ ...editForm, role: e.target.value as UserRole })} className={inputCls}>
                {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <label className="mt-3 flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={editForm.is_active} disabled={String(editTarget.id) === user?.id} onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })} />
              Account active (uncheck to deactivate — the user can no longer sign in)
            </label>
            {String(editTarget.id) === user?.id && <p className="mt-2 text-xs text-slate-500">You cannot change your own role or deactivate your own account.</p>}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setEditTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
