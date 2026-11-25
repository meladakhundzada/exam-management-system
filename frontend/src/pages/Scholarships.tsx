import { useEffect, useMemo, useState } from 'react';
import api, {
  ApiResponse, apiErrorMessage, formatAfn, referenceApi,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

// Scholarships & financial discounts (staff only page).
// API helpers live in this file on purpose — services/api.ts is owned by
// the coordinator's wiring pass, so this page must not depend on edits
// there. Endpoints are implemented in backend/src/routes/scholarships.js:
//   GET    /scholarships                 list scholarships
//   POST   /scholarships                 create a scholarship
//   PATCH  /scholarships/:id             edit / activate / deactivate
//   GET    /scholarships/students        student picker (Finance cannot
//                                        use GET /api/students, so the
//                                        picker has its own endpoint)
//   GET    /scholarships/awards          award list (?status=, ?student_id=)
//   POST   /scholarships/:id/award       create a PENDING award (staff)
//   POST   /scholarships/:id/approve     approve a pending award
//                                        (Super Admin only; :id is the
//                                        AWARD id, not the scholarship id)
//   POST   /scholarships/:id/reject      reject a pending award
//                                        (Super Admin only; :id is the award id)
//   POST   /scholarships/:id/revoke      revoke an approved award (staff)
export interface Scholarship {
  id: number;
  name: string;
  description?: string | null;
  discount_percent: number | null;
  fixed_amount: number | null;
  is_active: boolean;
  pending_count?: number;
  approved_count?: number;
}

export type AwardStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface StudentScholarshipAward {
  id: number;
  student_id: number;
  scholarship_id: number;
  academic_year_id?: number | null;
  semester_id?: number | null;
  status: AwardStatus;
  approved_by?: number | null;
  approved_at?: string | null;
  created_at: string;
  scholarship_name: string;
  discount_percent: number | null;
  fixed_amount: number | null;
  student_no: string;
  student_name: string;
  academic_year_name?: string | null;
  semester_name?: string | null;
  approved_by_name?: string | null;
  // Returned by approve / revoke alongside the award row.
  fees_updated?: number;
  total_discount?: number;
  fees_restored?: number;
  total_restored?: number;
}

export interface StudentPickerRow {
  id: number;
  student_id: string;
  full_name: string;
  email: string;
  status: string;
  department_name: string;
}

const scholarshipsApi = {
  list: () => api.get<ApiResponse<Scholarship[]>>('/scholarships'),
  create: (payload: { name: string; description?: string; discount_percent?: number; fixed_amount?: number }) =>
    api.post<ApiResponse<Scholarship>>('/scholarships', payload),
  update: (id: number, payload: { name?: string; description?: string; discount_percent?: number; fixed_amount?: number; is_active?: boolean }) =>
    api.patch<ApiResponse<Scholarship>>(`/scholarships/${id}`, payload),
  students: (search?: string) =>
    api.get<ApiResponse<StudentPickerRow[]>>(
      `/scholarships/students${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  awards: (status?: string) =>
    api.get<ApiResponse<StudentScholarshipAward[]>>(
      `/scholarships/awards?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
  award: (scholarshipId: number, payload: { student_id: number; academic_year_id?: number; semester_id?: number }) =>
    api.post<ApiResponse<StudentScholarshipAward>>(`/scholarships/${scholarshipId}/award`, payload),
  approve: (awardId: number) =>
    api.post<ApiResponse<StudentScholarshipAward>>(`/scholarships/${awardId}/approve`),
  reject: (awardId: number) =>
    api.post<ApiResponse<StudentScholarshipAward>>(`/scholarships/${awardId}/reject`),
  revoke: (awardId: number) =>
    api.post<ApiResponse<StudentScholarshipAward>>(`/scholarships/${awardId}/revoke`),
};

const STATUS_BADGE: Record<AwardStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-slate-200 text-slate-600',
  revoked: 'bg-red-100 text-red-700',
};

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

function discountLabel(s: Pick<Scholarship, 'discount_percent' | 'fixed_amount'>): string {
  if (s.discount_percent != null) return `${s.discount_percent}% off`;
  if (s.fixed_amount != null) return `${formatAfn(s.fixed_amount)} off`;
  return '—';
}

export default function Scholarships() {
  const { hasRole } = useAuth();
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE');
  const isSuperAdmin = hasRole('SUPER_ADMIN');

  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [awards, setAwards] = useState<StudentScholarshipAward[]>([]);
  const [students, setStudents] = useState<StudentPickerRow[]>([]);
  const [studentSearch, setStudentSearch] = useState('');
  const [years, setYears] = useState<Array<{ id: number; name: string }>>([]);
  const [semesters, setSemesters] = useState<Array<{ id: number; name: string; academic_year?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [awardFilter, setAwardFilter] = useState('');

  const [createForm, setCreateForm] = useState({ name: '', description: '', kind: 'percent', value: '' });
  const [awardForm, setAwardForm] = useState({ scholarship_id: '', student_id: '', academic_year_id: '', semester_id: '' });
  const [editing, setEditing] = useState<{ id: number; kind: 'percent' | 'fixed'; value: string; description: string } | null>(null);

  const load = async () => {
    const [s, a] = await Promise.all([scholarshipsApi.list(), scholarshipsApi.awards()]);
    setScholarships(s.data.data);
    setAwards(a.data.data);
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      await load();
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (!isStaff) return;
    referenceApi.get()
      .then(({ data }) => {
        const d = data.data as unknown as Record<string, Array<Record<string, unknown>>>;
        setYears((d.academic_years ?? []).map((y) => ({ id: Number(y.id), name: String(y.name) })));
        setSemesters((d.semesters ?? []).map((s) => ({
          id: Number(s.id),
          name: String(s.name),
          academic_year: String(s.academic_year ?? ''),
        })));
      })
      .catch(() => { setYears([]); setSemesters([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff]);
  useEffect(() => {
    if (!isStaff) return;
    const t = setTimeout(() => {
      scholarshipsApi.students(studentSearch || undefined)
        .then(({ data }) => setStudents(data.data))
        .catch(() => setStudents([]));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentSearch, isStaff]);

  const pendingAwards = useMemo(() => awards.filter((a) => a.status === 'pending'), [awards]);
  const filteredAwards = useMemo(
    () => (awardFilter ? awards.filter((a) => a.status === awardFilter) : awards),
    [awards, awardFilter],
  );

  const createScholarship = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createForm.name.trim().length < 3) { setFormError('Scholarship name must be at least 3 characters.'); return; }
    const value = Number(createForm.value);
    if (!(value > 0)) { setFormError('Discount value must be greater than 0.'); return; }
    if (createForm.kind === 'percent' && value > 100) { setFormError('A percentage discount cannot exceed 100%.'); return; }
    setSaving(true);
    try {
      await scholarshipsApi.create({
        name: createForm.name.trim(),
        description: createForm.description || undefined,
        ...(createForm.kind === 'percent' ? { discount_percent: value } : { fixed_amount: value }),
      });
      setNotice(`Scholarship "${createForm.name.trim()}" created.`);
      setCreateForm({ name: '', description: '', kind: 'percent', value: '' });
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const value = Number(editing.value);
    if (!(value > 0)) { setFormError('Discount value must be greater than 0.'); return; }
    if (editing.kind === 'percent' && value > 100) { setFormError('A percentage discount cannot exceed 100%.'); return; }
    setSaving(true);
    try {
      await scholarshipsApi.update(editing.id, {
        description: editing.description || undefined,
        ...(editing.kind === 'percent' ? { discount_percent: value } : { fixed_amount: value }),
      });
      setNotice('Scholarship updated.');
      setEditing(null);
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const toggleActive = async (s: Scholarship) => {
    setSaving(true);
    try {
      await scholarshipsApi.update(s.id, { is_active: !s.is_active });
      setNotice(`Scholarship "${s.name}" ${s.is_active ? 'deactivated' : 'activated'}.`);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const createAward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!awardForm.scholarship_id) { setFormError('Choose a scholarship.'); return; }
    if (!awardForm.student_id) { setFormError('Choose a student.'); return; }
    setSaving(true);
    try {
      await scholarshipsApi.award(Number(awardForm.scholarship_id), {
        student_id: Number(awardForm.student_id),
        academic_year_id: awardForm.academic_year_id ? Number(awardForm.academic_year_id) : undefined,
        semester_id: awardForm.semester_id ? Number(awardForm.semester_id) : undefined,
      });
      setNotice('Award created as pending — it discounts nothing until the Super Admin approves it.');
      setAwardForm({ scholarship_id: '', student_id: '', academic_year_id: '', semester_id: '' });
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const approveAward = async (a: StudentScholarshipAward) => {
    setSaving(true);
    try {
      const { data } = await scholarshipsApi.approve(a.id);
      const d = data.data;
      setNotice(
        `Award approved for ${a.student_name} (${a.scholarship_name}).` +
        (d.fees_updated ? ` Discount applied to ${d.fees_updated} existing fee(s): ${formatAfn(d.total_discount ?? 0)}.` : ' No existing unpaid fees were discounted.'),
      );
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const rejectAward = async (a: StudentScholarshipAward) => {
    setSaving(true);
    try {
      await scholarshipsApi.reject(a.id);
      setNotice(`Award for ${a.student_name} (${a.scholarship_name}) rejected.`);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const revokeAward = async (a: StudentScholarshipAward) => {
    if (!window.confirm(`Revoke the approved ${a.scholarship_name} award for ${a.student_name}? Any discount it applied will be added back to their unpaid fees.`)) return;
    setSaving(true);
    try {
      const { data } = await scholarshipsApi.revoke(a.id);
      const d = data.data;
      setNotice(
        `Award revoked for ${a.student_name}.` +
        (d.fees_restored ? ` Discount of ${formatAfn(d.total_restored ?? 0)} restored on ${d.fees_restored} fee(s).` : ''),
      );
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  if (loading) return <p className="p-4">Loading scholarships…</p>;

  if (!isStaff) {
    return (
      <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">Scholarships are managed by the Super Admin, Examination Officer and Finance Officer. Students see their own awards on the Fees page once approved.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Scholarships &amp; Discounts</h1>
        <p className="text-sm text-slate-500">Create scholarships, award them to students, and approve them. Only an approved award discounts a student&apos;s fees — a pending award discounts nothing.</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <form onSubmit={createScholarship} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">New scholarship</h2>
          {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
          <label className="mt-4 block text-sm font-medium">Name
            <input required value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="e.g. Merit Scholarship" className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Description
            <input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} placeholder="Who qualifies for this scholarship?" className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="mt-3 block text-sm font-medium">Discount type
              <select value={createForm.kind} onChange={(e) => setCreateForm({ ...createForm, kind: e.target.value })} className={inputCls}>
                <option value="percent">Percentage (%)</option>
                <option value="fixed">Fixed amount (AFN)</option>
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">{createForm.kind === 'percent' ? 'Percent (1–100)' : 'Amount (AFN)'}
              <input required type="number" min={0.01} step={0.01} max={createForm.kind === 'percent' ? 100 : undefined} value={createForm.value} onChange={(e) => setCreateForm({ ...createForm, value: e.target.value })} className={inputCls} />
            </label>
          </div>
          <button type="submit" disabled={saving} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Create scholarship</button>
          <p className="mt-3 text-xs text-slate-500">A scholarship is either a percentage or a fixed amount — never both. A 100% scholarship leaves a 0.01 AFN balance on each fee (the fee table requires amount due above zero).</p>

          <div className="mt-6">
            <h3 className="text-sm font-semibold">Existing scholarships</h3>
            <ul className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
              {scholarships.map((s) => (
                <li key={s.id}>
                  {editing?.id === s.id ? (
                    <form onSubmit={saveEdit} className="space-y-2 rounded-lg border p-3">
                      <p className="font-medium">{s.name}</p>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block text-xs">Discount type
                          <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as 'percent' | 'fixed' })} className={inputCls}>
                            <option value="percent">Percentage (%)</option>
                            <option value="fixed">Fixed amount (AFN)</option>
                          </select>
                        </label>
                        <label className="block text-xs">{editing.kind === 'percent' ? 'Percent (1–100)' : 'Amount (AFN)'}
                          <input type="number" min={0.01} step={0.01} required value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} className={inputCls} />
                        </label>
                      </div>
                      <label className="block text-xs">Description
                        <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} className={inputCls} />
                      </label>
                      <div className="flex gap-2">
                        <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Save</button>
                        <button type="button" onClick={() => setEditing(null)} className="rounded-lg border px-3 py-1 text-xs">Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{s.name} — {discountLabel(s)}{s.is_active ? '' : ' (inactive)'}</span>
                      <span className="text-xs text-slate-500">{s.approved_count ?? 0} approved · {s.pending_count ?? 0} pending</span>
                      <button type="button" onClick={() => setEditing({ id: s.id, kind: s.discount_percent != null ? 'percent' : 'fixed', value: String(s.discount_percent ?? s.fixed_amount ?? ''), description: s.description ?? '' })} className="text-navy-600 hover:underline">Edit</button>
                      <button type="button" onClick={() => toggleActive(s)} className="text-navy-600 hover:underline">{s.is_active ? 'Deactivate' : 'Activate'}</button>
                    </span>
                  )}
                </li>
              ))}
              {!scholarships.length && <li className="text-slate-500">No scholarships yet.</li>}
            </ul>
          </div>
        </form>

        <form onSubmit={createAward} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">Award a scholarship</h2>
          <p className="text-sm text-slate-500">The award starts as pending. Only the Super Admin can approve it, and only approval discounts the student&apos;s fees.</p>
          <label className="mt-4 block text-sm font-medium">Scholarship
            <select required value={awardForm.scholarship_id} onChange={(e) => setAwardForm({ ...awardForm, scholarship_id: e.target.value })} className={inputCls}>
              <option value="">Choose a scholarship…</option>
              {scholarships.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name} — {discountLabel(s)}</option>)}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium">Student — search by name, student number or email
            <input value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} placeholder="e.g. Zahid or 001" className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Student
            <select required value={awardForm.student_id} onChange={(e) => setAwardForm({ ...awardForm, student_id: e.target.value })} className={inputCls}>
              <option value="">Choose a student…</option>
              {students.map((st) => <option key={st.id} value={st.id}>{st.full_name} ({st.student_id}) — {st.department_name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="mt-3 block text-sm font-medium">Academic year (optional)
              <select value={awardForm.academic_year_id} onChange={(e) => setAwardForm({ ...awardForm, academic_year_id: e.target.value })} className={inputCls}>
                <option value="">Any year</option>
                {years.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">Semester (optional)
              <select value={awardForm.semester_id} onChange={(e) => setAwardForm({ ...awardForm, semester_id: e.target.value })} className={inputCls}>
                <option value="">Any semester</option>
                {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}{s.academic_year ? ` (${s.academic_year})` : ''}</option>)}
              </select>
            </label>
          </div>
          <button type="submit" disabled={saving} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Create pending award</button>
          <p className="mt-3 text-xs text-slate-500">Leave year/semester blank for a scholarship that applies to any term. A student can hold only one approved scholarship per year/semester — approving a second one for the same term is rejected.</p>
        </form>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Pending approvals</h2>
        {!isSuperAdmin && <p className="mt-1 text-sm text-slate-500">Only the Super Admin can approve or reject awards. Finance and the Examination Officer create awards; approval is a Super Admin action.</p>}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Student</th><th className="px-2 py-3">Scholarship</th><th className="px-2 py-3">Discount</th><th className="px-2 py-3">Year / Semester</th><th className="px-2 py-3">Requested</th><th className="px-2 py-3">Action</th></tr></thead>
            <tbody>
              {pendingAwards.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{a.student_name}<span className="block text-xs text-slate-500">{a.student_no}</span></td>
                  <td className="px-2 py-3">{a.scholarship_name}</td>
                  <td className="px-2 py-3">{discountLabel(a)}</td>
                  <td className="px-2 py-3">{a.academic_year_name ?? 'Any year'} / {a.semester_name ?? 'Any semester'}</td>
                  <td className="px-2 py-3">{new Date(a.created_at).toLocaleDateString()}</td>
                  <td className="px-2 py-3">
                    {isSuperAdmin ? (
                      <span className="flex gap-3">
                        <button onClick={() => approveAward(a)} disabled={saving} className="font-medium text-emerald-600 hover:underline disabled:opacity-50">Approve</button>
                        <button onClick={() => rejectAward(a)} disabled={saving} className="font-medium text-red-600 hover:underline disabled:opacity-50">Reject</button>
                      </span>
                    ) : <span className="text-slate-500">Awaiting Super Admin</span>}
                  </td>
                </tr>
              ))}
              {!pendingAwards.length && <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-500">No awards awaiting approval.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">All awards</h2>
          <select value={awardFilter} onChange={(e) => setAwardFilter(e.target.value)} className="ml-auto rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Student</th><th className="px-2 py-3">Scholarship</th><th className="px-2 py-3">Discount</th><th className="px-2 py-3">Year / Semester</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Approved by</th><th className="px-2 py-3">Action</th></tr></thead>
            <tbody>
              {filteredAwards.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{a.student_name}<span className="block text-xs text-slate-500">{a.student_no}</span></td>
                  <td className="px-2 py-3">{a.scholarship_name}</td>
                  <td className="px-2 py-3">{discountLabel(a)}</td>
                  <td className="px-2 py-3">{a.academic_year_name ?? 'Any year'} / {a.semester_name ?? 'Any semester'}</td>
                  <td className="px-2 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[a.status]}`}>{a.status.toUpperCase()}</span></td>
                  <td className="px-2 py-3">{a.approved_by_name ?? '—'}{a.approved_at ? <span className="block text-xs text-slate-500">{new Date(a.approved_at).toLocaleDateString()}</span> : null}</td>
                  <td className="px-2 py-3">
                    {a.status === 'approved'
                      ? <button onClick={() => revokeAward(a)} disabled={saving} className="font-medium text-red-600 hover:underline disabled:opacity-50">Revoke</button>
                      : <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              ))}
              {!filteredAwards.length && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-500">No awards match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
