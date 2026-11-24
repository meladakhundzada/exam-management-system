import { useEffect, useState } from 'react';
import api, {
  ApiResponse, FeeType, apiErrorMessage, feesApi, formatAfn,
  referenceApi, studentsApi,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

// --- Fines API helpers (local to this page — services/api.ts is not
// edited; the coordinator wires the route/sidebar). The backend routes
// live in backend/src/routes/fines.js, mounted at /api/fines. ---------
export interface Fine {
  id: number;
  student_id: number;
  student_no: string;
  student_name: string;
  student_email?: string | null;
  department_name?: string | null;
  fee_type_id?: number | null;
  fee_type_name?: string | null;
  reason: string;
  amount: number;
  due_date?: string | null;
  status: 'outstanding' | 'paid' | 'waived';
  display_status: 'outstanding' | 'paid' | 'waived' | 'overdue';
  waived_by?: number | null;
  waived_by_name?: string | null;
  created_by_name?: string | null;
  paid_at?: string | null;
  created_at: string;
}

export interface FineOutstanding {
  totals: {
    outstanding_count: number;
    outstanding_amount: number;
    overdue_count: number;
    overdue_amount: number;
  };
  by_department: Array<{
    department_id: number | null;
    department_name: string | null;
    outstanding_count: number;
    outstanding_amount: number;
    overdue_count: number;
  }>;
}

export interface CreateFinePayload {
  student_id: number;
  reason: string;
  amount: number;
  due_date?: string;
  fee_type_id?: number;
}

const buildFineQuery = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

const finesApi = {
  list: (params: { status?: string; student_id?: number; department_id?: number; search?: string; page?: number; limit?: number } = {}) =>
    api.get<ApiResponse<Fine[]>>(`/fines?${buildFineQuery(params)}`),
  outstanding: (departmentId?: number) =>
    api.get<ApiResponse<FineOutstanding>>(
      `/fines/outstanding${departmentId ? `?department_id=${departmentId}` : ''}`,
    ),
  create: (payload: CreateFinePayload) =>
    api.post<ApiResponse<Fine>>('/fines', payload),
  waive: (id: number) => api.post<ApiResponse<Fine>>(`/fines/${id}/waive`),
  pay: (id: number) => api.post<ApiResponse<Fine>>(`/fines/${id}/pay`),
};

const STATUS_BADGE: Record<string, string> = {
  outstanding: 'bg-red-100 text-red-700',
  overdue: 'bg-red-200 text-red-800',
  paid: 'bg-emerald-100 text-emerald-700',
  waived: 'bg-slate-200 text-slate-600',
};

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

interface StudentOption {
  id: number;
  studentNo: string;
  fullName: string;
}

export default function Fines() {
  const { hasRole } = useAuth();
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE');

  const [fines, setFines] = useState<Fine[]>([]);
  const [outstanding, setOutstanding] = useState<FineOutstanding | null>(null);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [types, setTypes] = useState<FeeType[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

  const [form, setForm] = useState({ student_id: '', fee_type_id: '', reason: '', amount: '', due_date: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    const [list, out] = await Promise.all([
      finesApi.list({
        limit: 100,
        status: statusFilter || undefined,
        search: search || undefined,
        department_id: deptFilter ? Number(deptFilter) : undefined,
      }),
      finesApi.outstanding(deptFilter ? Number(deptFilter) : undefined),
    ]);
    setFines(list.data.data);
    setOutstanding(out.data.data);
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
    // Student picker + fee-type picker + department filter options.
    // The backend returns snake_case student rows (pg); map them the
    // same way Students.tsx does.
    studentsApi.list({ limit: 500 })
      .then(({ data }) => {
        const rows = data.data as unknown as Array<Record<string, unknown>>;
        setStudents(rows.map((r) => ({
          id: Number(r.id),
          studentNo: String(r.student_id ?? ''),
          fullName: String(r.full_name ?? ''),
        })));
      })
      .catch(() => setStudents([]));
    feesApi.types()
      .then(({ data }) => setTypes(data.data))
      .catch(() => setTypes([]));
    referenceApi.get()
      .then(({ data }) => {
        const d = data.data as unknown as Record<string, Array<Record<string, unknown>>>;
        setDepartments((d.departments ?? []).map((dep) => ({ id: Number(dep.id), name: String(dep.name) })));
      })
      .catch(() => setDepartments([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff]);
  useEffect(() => {
    if (!isStaff || loading) return;
    const t = setTimeout(() => { load().catch((e) => setError(apiErrorMessage(e))); }, 400);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [search, statusFilter, deptFilter]);

  const recordFine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.student_id) { setFormError('Choose a student.'); return; }
    if (form.reason.trim().length < 3) { setFormError('Reason must be at least 3 characters.'); return; }
    if (Number(form.amount) <= 0) { setFormError('Amount must be greater than 0 AFN.'); return; }
    setSaving(true);
    try {
      const payload: CreateFinePayload = {
        student_id: Number(form.student_id),
        reason: form.reason.trim(),
        amount: Number(form.amount),
        due_date: form.due_date || undefined,
        fee_type_id: form.fee_type_id ? Number(form.fee_type_id) : undefined,
      };
      const { data } = await finesApi.create(payload);
      setNotice(`Fine of ${formatAfn(data.data.amount)} recorded for ${data.data.student_name} (${data.data.student_no}).`);
      setForm({ student_id: '', fee_type_id: '', reason: '', amount: '', due_date: '' });
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const waiveFine = async (fine: Fine) => {
    if (!window.confirm(`Waive this fine of ${formatAfn(fine.amount)} for ${fine.student_name}? A waived fine is excluded from outstanding totals and cannot be undone.`)) return;
    setSaving(true);
    try {
      await finesApi.waive(fine.id);
      setNotice(`Fine for ${fine.student_name} waived.`);
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const payFine = async (fine: Fine) => {
    if (!window.confirm(`Mark this fine of ${formatAfn(fine.amount)} for ${fine.student_name} as paid in full? No receipt is issued for a fine payment.`)) return;
    setSaving(true);
    try {
      await finesApi.pay(fine.id);
      setNotice(`Fine for ${fine.student_name} marked paid.`);
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  if (loading) return <p className="p-4">Loading fines…</p>;

  if (!isStaff) {
    return (
      <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">Fines and penalties are managed by the Super Admin, Examination Officer and Finance Officer. Students and lecturers do not have access to this page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Fines &amp; Penalties</h1>
        <p className="text-sm text-slate-500">Record a fine for a student, waive it, or mark it paid. All amounts are in AFN. Fines are recorded manually — no automatic late fees.</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {outstanding && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Outstanding fines</p><p className="text-xl font-bold">{outstanding.totals.outstanding_count}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Outstanding amount</p><p className="text-xl font-bold text-red-600">{formatAfn(outstanding.totals.outstanding_amount)}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Overdue fines</p><p className="text-xl font-bold">{outstanding.totals.overdue_count}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Overdue amount</p><p className="text-xl font-bold text-red-600">{formatAfn(outstanding.totals.overdue_amount)}</p></div>
        </div>
      )}

      {outstanding && outstanding.by_department.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-4 py-3">Department</th><th className="px-4 py-3">Outstanding fines</th><th className="px-4 py-3">Outstanding amount</th><th className="px-4 py-3">Overdue</th></tr></thead>
            <tbody>
              {outstanding.by_department.map((r) => (
                <tr key={r.department_id ?? r.department_name ?? 'none'} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{r.department_name ?? 'No department'}</td>
                  <td className="px-4 py-3">{r.outstanding_count}</td>
                  <td className="px-4 py-3 font-semibold">{formatAfn(r.outstanding_amount)}</td>
                  <td className="px-4 py-3">{r.overdue_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={recordFine} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Record a fine</h2>
        {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="mt-4 block text-sm font-medium">Student
            <select required value={form.student_id} onChange={(e) => setForm({ ...form, student_id: e.target.value })} className={inputCls}>
              <option value="">Choose a student…</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.studentNo})</option>)}
            </select>
          </label>
          <label className="mt-4 block text-sm font-medium">Linked fee type (optional)
            <select value={form.fee_type_id} onChange={(e) => setForm({ ...form, fee_type_id: e.target.value })} className={inputCls}>
              <option value="">No fee type — reason only</option>
              {types.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium">Reason
            <input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Late library book return" className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">Amount (AFN)
              <input required type="number" min={0.01} step={0.01} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} />
            </label>
            <label className="block text-sm font-medium">Due date
              <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className={inputCls} />
            </label>
          </div>
        </div>
        <button type="submit" disabled={saving} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Record fine</button>
        <p className="mt-3 text-xs text-slate-500">A fine is a one-off penalty kept separate from regular fees, so it never appears in fee totals or the Fees report. A fine is paid in full in one step; waiving it removes it from outstanding totals.</p>
      </form>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">Fines</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search student, number or reason…" className="ml-auto rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
            <option value="">All statuses</option>
            <option value="outstanding">Outstanding</option>
            <option value="overdue">Overdue</option>
            <option value="paid">Paid</option>
            <option value="waived">Waived</option>
          </select>
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Student</th><th className="px-2 py-3">Reason</th><th className="px-2 py-3">Fee type</th><th className="px-2 py-3">Amount</th><th className="px-2 py-3">Due date</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Waived by</th><th className="px-2 py-3">Actions</th></tr></thead>
            <tbody>
              {fines.map((f) => (
                <tr key={f.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{f.student_name}<span className="block text-xs text-slate-500">{f.student_no}{f.department_name ? ` · ${f.department_name}` : ''}</span></td>
                  <td className="px-2 py-3">{f.reason}</td>
                  <td className="px-2 py-3">{f.fee_type_name ?? '—'}</td>
                  <td className="px-2 py-3 font-semibold">{formatAfn(f.amount)}</td>
                  <td className="px-2 py-3">{f.due_date ? new Date(f.due_date).toLocaleDateString() : '—'}</td>
                  <td className="px-2 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[f.display_status]}`}>{f.display_status.toUpperCase()}</span></td>
                  <td className="px-2 py-3">{f.waived_by_name ?? '—'}</td>
                  <td className="px-2 py-3">
                    {f.status === 'outstanding' && (
                      <span className="flex flex-wrap gap-2">
                        <button onClick={() => payFine(f)} disabled={saving} className="text-emerald-600 hover:underline disabled:opacity-50">Mark paid</button>
                        <button onClick={() => waiveFine(f)} disabled={saving} className="text-navy-600 hover:underline disabled:opacity-50">Waive</button>
                      </span>
                    )}
                    {f.status === 'paid' && <span className="text-xs text-slate-500">Paid{f.paid_at ? ` ${new Date(f.paid_at).toLocaleDateString()}` : ''}</span>}
                    {f.status === 'waived' && <span className="text-xs text-slate-500">Waived</span>}
                  </td>
                </tr>
              ))}
              {!fines.length && <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-500">No fines match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
