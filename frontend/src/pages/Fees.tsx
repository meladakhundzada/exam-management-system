import { useEffect, useMemo, useState } from 'react';
import {
  feesApi, referenceApi, formatAfn, apiErrorMessage, downloadBlob,
  FeeType, StudentFee, FeeReport, FeePayment, FeePaymentRecord,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE: Record<string, string> = {
  unpaid: 'bg-red-100 text-red-700',
  partial: 'bg-amber-100 text-amber-700',
  paid: 'bg-emerald-100 text-emerald-700',
  overdue: 'bg-red-200 text-red-800',
};

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'other', label: 'Other' },
];

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

export default function Fees() {
  const { user, hasRole } = useAuth();
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE');
  const isStudent = hasRole('STUDENT');

  const [types, setTypes] = useState<FeeType[]>([]);
  const [due, setDue] = useState<StudentFee[]>([]);
  const [report, setReport] = useState<FeeReport | null>(null);
  const [myFees, setMyFees] = useState<StudentFee[]>([]);
  const [myTotals, setMyTotals] = useState({ total_due: 0, total_paid: 0, outstanding: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [typeForm, setTypeForm] = useState({ name: '', amount: '', description: '' });
  const [semesters, setSemesters] = useState<Array<{ id: number; name: string; academic_year?: string }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string }>>([]);
  const [reportDept, setReportDept] = useState('');
  const [assignForm, setAssignForm] = useState({ fee_type_id: '', target: 'student', student_id: '', department_id: '', semester_id: '', due_date: '' });
  const [payTarget, setPayTarget] = useState<StudentFee | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', payment_method: 'cash', payment_date: new Date().toISOString().slice(0, 10), note: '' });
  const [lastPayment, setLastPayment] = useState<FeePayment | null>(null);
  // Student financial profile lookup (staff): one student's full record.
  const [profileId, setProfileId] = useState('');
  const [profile, setProfile] = useState<{ fees: StudentFee[]; totals: { total_due: number; total_paid: number; outstanding: number } } | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  // Payment history (staff): all payments, searchable, correctable.
  const [payments, setPayments] = useState<FeePaymentRecord[]>([]);
  const [paySearch, setPaySearch] = useState('');
  const [payMethod, setPayMethod] = useState('');
  // Fee-type edit (amount/description) and activate/deactivate.
  const [editingType, setEditingType] = useState<{ id: number; amount: string; description: string } | null>(null);
  // Payment correction.
  const [editingPayment, setEditingPayment] = useState<{ id: number; amount: string; payment_method: string; payment_date: string; note: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadStaff = async () => {
    const [t, d, r, p] = await Promise.all([
      feesApi.types(),
      feesApi.due({ limit: 100, status: statusFilter || undefined, search: search || undefined }),
      feesApi.report(reportDept ? { department_id: Number(reportDept) } : {}),
      feesApi.payments({ limit: 50, search: paySearch || undefined, payment_method: payMethod || undefined }),
    ]);
    setTypes(t.data.data);
    setDue(d.data.data);
    setReport(r.data.data);
    setPayments(p.data.data);
  };

  const loadStudent = async () => {
    if (!user?.studentId) { setError('No student profile is linked to your account. Contact the Examination Office.'); return; }
    const { data } = await feesApi.byStudent(user.studentId);
    setMyFees(data.data.fees);
    setMyTotals(data.data.totals);
  };

  const load = async () => {
    setLoading(true);
    try {
      if (isStaff) await loadStaff();
      else if (isStudent) await loadStudent();
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (!isStaff) return;
    referenceApi.get()
      .then(({ data }) => {
        const d = data.data as unknown as Record<string, Array<Record<string, unknown>>>;
        setSemesters((d.semesters ?? []).map((s) => ({
          id: Number(s.id),
          name: String(s.name),
          academic_year: String(s.academic_year ?? ''),
        })));
        setDepartments((d.departments ?? []).map((dep) => ({ id: Number(dep.id), name: String(dep.name) })));
      })
      .catch(() => { setSemesters([]); setDepartments([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff]);
  useEffect(() => {
    if (!isStaff || loading) return;
    const t = setTimeout(() => { loadStaff().catch((e) => setError(apiErrorMessage(e))); }, 400);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [search, statusFilter, paySearch, payMethod, reportDept]);

  const filteredDue = useMemo(() => due, [due]);

  const createType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typeForm.name.trim().length < 3) { setFormError('Fee type name must be at least 3 characters.'); return; }
    if (Number(typeForm.amount) <= 0) { setFormError('Amount must be greater than 0 AFN.'); return; }
    setSaving(true);
    try {
      await feesApi.createType({ name: typeForm.name.trim(), amount: Number(typeForm.amount), description: typeForm.description || undefined });
      setNotice(`Fee type "${typeForm.name.trim()}" created.`);
      setTypeForm({ name: '', amount: '', description: '' });
      setFormError(null);
      await loadStaff();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const assignFee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignForm.fee_type_id) { setFormError('Choose a fee type.'); return; }
    if (assignForm.target === 'student' && !assignForm.student_id) { setFormError('Enter a student ID (the number from the Students page, e.g. 12).'); return; }
    if (assignForm.target === 'department' && !assignForm.department_id) { setFormError('Enter a department ID.'); return; }
    setSaving(true);
    try {
      const payload: Parameters<typeof feesApi.assign>[0] = {
        fee_type_id: Number(assignForm.fee_type_id),
        due_date: assignForm.due_date || undefined,
        semester_id: assignForm.semester_id ? Number(assignForm.semester_id) : undefined,
      };
      if (assignForm.target === 'student') payload.student_id = Number(assignForm.student_id);
      else payload.department_id = Number(assignForm.department_id);
      const { data } = await feesApi.assign(payload);
      setNotice(`${data.count} fee record(s) assigned.`);
      setFormError(null);
      await loadStaff();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const openPay = (fee: StudentFee) => {
    setPayTarget(fee);
    setPayForm({ amount: String(fee.balance), payment_method: 'cash', payment_date: new Date().toISOString().slice(0, 10), note: '' });
    setLastPayment(null);
    setFormError(null);
  };

  const recordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    if (Number(payForm.amount) <= 0) { setFormError('Amount must be greater than 0 AFN.'); return; }
    if (Number(payForm.amount) > payTarget.balance) { setFormError(`Payment cannot exceed the remaining balance (${formatAfn(payTarget.balance)}).`); return; }
    setSaving(true);
    try {
      const { data } = await feesApi.pay(payTarget.id, {
        amount: Number(payForm.amount),
        payment_method: payForm.payment_method,
        payment_date: payForm.payment_date,
        note: payForm.note || undefined,
      });
      setLastPayment(data.data.payment);
      setNotice(`Payment recorded. Receipt ${data.data.payment.receipt_no}.`);
      setFormError(null);
      await loadStaff();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const printReceipt = (payment: FeePayment, fee: StudentFee) => {
    // A real receipt document in its own window — not window.print() of
    // the whole Fees page.
    const w = window.open('', '_blank', 'width=640,height=720');
    if (!w) { setFormError('Allow pop-ups to print the receipt.'); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>Receipt ${payment.receipt_no}</title>
      <style>body{font-family:Arial,sans-serif;margin:40px;color:#111}h1{font-size:20px}table{border-collapse:collapse;margin-top:16px}td{padding:6px 16px 6px 0}hr{margin:20px 0}</style>
      </head><body>
      <h1>University Examination Department</h1><p>Official Payment Receipt</p><hr>
      <table>
      <tr><td><strong>Receipt No.</strong></td><td>${payment.receipt_no}</td></tr>
      <tr><td><strong>Student</strong></td><td>${fee.student_name ?? ''}</td></tr>
      <tr><td><strong>Fee</strong></td><td>${fee.fee_type_name}</td></tr>
      <tr><td><strong>Amount paid</strong></td><td>${formatAfn(payment.amount)}</td></tr>
      <tr><td><strong>Method</strong></td><td>${payment.payment_method}</td></tr>
      <tr><td><strong>Date</strong></td><td>${payment.payment_date}</td></tr>
      <tr><td><strong>Balance remaining</strong></td><td>${formatAfn(fee.balance)}</td></tr>
      </table><hr><p>Keep this receipt as proof of payment.</p>
      <script>window.onload = () => window.print();</script>
      </body></html>`);
    w.document.close();
  };

  const loadProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileId) { setProfileError('Enter a student record ID (the number from the Students page).'); return; }
    setSaving(true);
    try {
      const { data } = await feesApi.byStudent(Number(profileId));
      setProfile(data.data);
      setProfileError(null);
    } catch (err) { setProfile(null); setProfileError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const saveTypeEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingType) return;
    if (Number(editingType.amount) <= 0) { setFormError('Amount must be greater than 0 AFN.'); return; }
    setSaving(true);
    try {
      await feesApi.updateType(editingType.id, { amount: Number(editingType.amount), description: editingType.description || undefined });
      setNotice('Fee type updated.');
      setEditingType(null);
      setFormError(null);
      await loadStaff();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const toggleTypeActive = async (t: FeeType) => {
    setSaving(true);
    try {
      await feesApi.updateType(t.id, { is_active: !t.is_active });
      setNotice(`Fee type "${t.name}" ${t.is_active ? 'deactivated' : 'activated'}.`);
      await loadStaff();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const savePaymentEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPayment) return;
    if (Number(editingPayment.amount) <= 0) { setFormError('Amount must be greater than 0 AFN.'); return; }
    setSaving(true);
    try {
      await feesApi.updatePayment(editingPayment.id, {
        amount: Number(editingPayment.amount),
        payment_method: editingPayment.payment_method,
        payment_date: editingPayment.payment_date,
        note: editingPayment.note || undefined,
      });
      setNotice('Payment record updated.');
      setEditingPayment(null);
      setFormError(null);
      await loadStaff();
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  const exportPaymentsCsv = async () => {
    setSaving(true);
    try {
      const res = await feesApi.exportPayments({ search: paySearch || undefined, payment_method: payMethod || undefined });
      downloadBlob(res.data, 'payment-history.csv');
      setNotice('Downloaded payment-history.csv.');
    } catch (err) { setFormError(apiErrorMessage(err)); } finally { setSaving(false); }
  };

  if (loading) return <p className="p-4">Loading fees…</p>;

  // --- Student view: only their own fees -----------------------------------
  if (isStudent) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">My Fees</h1>
          <p className="text-sm text-slate-500">Your fee charges and payments. All amounts are in AFN.</p>
        </div>
        {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Total due</p><p className="text-xl font-bold">{formatAfn(myTotals.total_due)}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Total paid</p><p className="text-xl font-bold text-emerald-600">{formatAfn(myTotals.total_paid)}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Outstanding</p><p className="text-xl font-bold text-red-600">{formatAfn(myTotals.outstanding)}</p></div>
        </div>
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-4 py-3">Fee</th><th className="px-4 py-3">Due date</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Paid</th><th className="px-4 py-3">Balance</th><th className="px-4 py-3">Status</th></tr></thead>
            <tbody>
              {myFees.map((f) => (
                <tr key={f.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{f.fee_type_name}</td>
                  <td className="px-4 py-3">{f.due_date ? new Date(f.due_date).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-3">{formatAfn(f.amount_due)}</td>
                  <td className="px-4 py-3">{formatAfn(f.amount_paid)}</td>
                  <td className="px-4 py-3 font-semibold">{formatAfn(f.balance)}</td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[f.display_status]}`}>{f.display_status.toUpperCase()}</span></td>
                </tr>
              ))}
              {!myFees.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">No fees assigned to you yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-slate-500">Pay at the Examination Office and keep your receipt. If a fee looks wrong, contact the Examination Office.</p>
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">Fees are managed by the Super Admin and Examination Officer. Students see only their own fees.</p>
      </div>
    );
  }

  // --- Staff view ------------------------------------------------------------
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Fees</h1>
        <p className="text-sm text-slate-500">Fee types, assignments, payments and receipts. All amounts are in AFN.</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {report && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium">Financial report for
              <select value={reportDept} onChange={(e) => setReportDept(e.target.value)} className="ml-2 rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
                <option value="">Whole university</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Total due</p><p className="text-xl font-bold">{formatAfn(report.totals.total_due)}</p><p className="text-xs text-slate-500">{report.totals.fee_count} fee records</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Collected</p><p className="text-xl font-bold text-emerald-600">{formatAfn(report.totals.total_collected)}</p><p className="text-xs text-slate-500">{report.totals.paid_count} fully paid</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Outstanding</p><p className="text-xl font-bold text-red-600">{formatAfn(report.totals.outstanding)}</p><p className="text-xs text-slate-500">{report.totals.unpaid_count} unpaid / partial</p></div>
        </div>
        </>
      )}

      {report && report.by_fee_type.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-4 py-3">Fee type</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Collected</th><th className="px-4 py-3">Outstanding</th></tr></thead>
            <tbody>
              {report.by_fee_type.map((r) => (
                <tr key={r.fee_type} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{r.fee_type}</td>
                  <td className="px-4 py-3">{formatAfn(r.total_due)}</td>
                  <td className="px-4 py-3">{formatAfn(r.total_collected)}</td>
                  <td className="px-4 py-3 font-semibold">{formatAfn(r.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <form onSubmit={createType} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">New fee type</h2>
          {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
          <label className="mt-4 block text-sm font-medium">Name
            <input required value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} placeholder="e.g. Tuition" className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Default amount (AFN)
            <input required type="number" min={0.01} step={0.01} value={typeForm.amount} onChange={(e) => setTypeForm({ ...typeForm, amount: e.target.value })} className={inputCls} />
          </label>
          <label className="mt-3 block text-sm font-medium">Description
            <input value={typeForm.description} onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })} className={inputCls} />
          </label>
          <button type="submit" disabled={saving} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Create fee type</button>
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Existing fee types</h3>
            <ul className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
              {types.map((t) => (
                <li key={t.id}>
                  {editingType?.id === t.id ? (
                    <form onSubmit={saveTypeEdit} className="space-y-2 rounded-lg border p-3">
                      <p className="font-medium">{t.name}</p>
                      <label className="block text-xs">Default amount (AFN)
                        <input type="number" min={0.01} step={0.01} required value={editingType.amount} onChange={(e) => setEditingType({ ...editingType, amount: e.target.value })} className={inputCls} />
                      </label>
                      <label className="block text-xs">Description
                        <input value={editingType.description} onChange={(e) => setEditingType({ ...editingType, description: e.target.value })} className={inputCls} />
                      </label>
                      <div className="flex gap-2">
                        <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Save</button>
                        <button type="button" onClick={() => setEditingType(null)} className="rounded-lg border px-3 py-1 text-xs">Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{t.name} — {formatAfn(t.amount)}{t.is_active ? '' : ' (inactive)'}</span>
                      <button type="button" onClick={() => setEditingType({ id: t.id, amount: String(t.amount), description: t.description ?? '' })} className="text-navy-600 hover:underline">Edit</button>
                      <button type="button" onClick={() => toggleTypeActive(t)} className="text-navy-600 hover:underline">{t.is_active ? 'Deactivate' : 'Activate'}</button>
                    </span>
                  )}
                </li>
              ))}
              {!types.length && <li className="text-slate-500">No fee types yet — run migration 003_fees.sql to load the standard five (Tuition, Exam Fee, Admission, Library, Other).</li>}
            </ul>
          </div>
        </form>

        <form onSubmit={assignFee} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">Assign a fee</h2>
          <label className="mt-4 block text-sm font-medium">Fee type
            <select required value={assignForm.fee_type_id} onChange={(e) => setAssignForm({ ...assignForm, fee_type_id: e.target.value })} className={inputCls}>
              <option value="">Choose a fee type…</option>
              {types.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name} — {formatAfn(t.amount)}</option>)}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium">Assign to
            <select value={assignForm.target} onChange={(e) => setAssignForm({ ...assignForm, target: e.target.value })} className={inputCls}>
              <option value="student">One student</option>
              <option value="department">Whole department (active students)</option>
            </select>
          </label>
          {assignForm.target === 'student' ? (
            <label className="mt-3 block text-sm font-medium">Student ID (number from the Students page)
              <input type="number" min={1} value={assignForm.student_id} onChange={(e) => setAssignForm({ ...assignForm, student_id: e.target.value })} className={inputCls} />
            </label>
          ) : (
            <label className="mt-3 block text-sm font-medium">Department ID
              <input type="number" min={1} value={assignForm.department_id} onChange={(e) => setAssignForm({ ...assignForm, department_id: e.target.value })} className={inputCls} />
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="mt-3 block text-sm font-medium">Semester (optional)
              <select value={assignForm.semester_id} onChange={(e) => setAssignForm({ ...assignForm, semester_id: e.target.value })} className={inputCls}>
                <option value="">Any semester</option>
                {semesters.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{s.academic_year ? ` (${s.academic_year})` : ''}</option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">Due date
              <input type="date" value={assignForm.due_date} onChange={(e) => setAssignForm({ ...assignForm, due_date: e.target.value })} className={inputCls} />
            </label>
          </div>
          <button type="submit" disabled={saving} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Assign fee</button>
          <p className="mt-3 text-xs text-slate-500">Assigning the same fee twice to the same student (same year/semester) is rejected. For a department, only students who do not already have it are charged.</p>
        </form>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Student financial profile</h2>
        <p className="text-sm text-slate-500">Look up one student&apos;s full fee record — charges, payments and outstanding balance.</p>
        <form onSubmit={loadProfile} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">Student record ID
            <input type="number" min={1} value={profileId} onChange={(e) => setProfileId(e.target.value)} placeholder="e.g. 1" className={`${inputCls} w-40`} />
          </label>
          <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Load profile</button>
        </form>
        {profileError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{profileError}</p>}
        {profile && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div><p className="text-sm text-slate-500">Total due</p><p className="text-xl font-bold">{formatAfn(profile.totals.total_due)}</p></div>
              <div><p className="text-sm text-slate-500">Total paid</p><p className="text-xl font-bold text-emerald-600">{formatAfn(profile.totals.total_paid)}</p></div>
              <div><p className="text-sm text-slate-500">Outstanding</p><p className="text-xl font-bold text-red-600">{formatAfn(profile.totals.outstanding)}</p></div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead><tr className="border-b text-slate-500"><th className="px-2 py-2">Fee</th><th className="px-2 py-2">Due</th><th className="px-2 py-2">Paid</th><th className="px-2 py-2">Balance</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Payments</th><th className="px-2 py-2">Action</th></tr></thead>
                <tbody>
                  {profile.fees.map((f) => (
                    <tr key={f.id} className="border-b align-top last:border-0">
                      <td className="px-2 py-2 font-medium">{f.fee_type_name}<span className="block text-xs font-normal text-slate-500">{f.student_name} ({f.student_id})</span></td>
                      <td className="px-2 py-2">{formatAfn(f.amount_due)}</td>
                      <td className="px-2 py-2">{formatAfn(f.amount_paid)}</td>
                      <td className="px-2 py-2 font-semibold">{formatAfn(f.balance)}</td>
                      <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[f.display_status]}`}>{f.display_status.toUpperCase()}</span></td>
                      <td className="px-2 py-2 text-xs">
                        {(f.payments ?? []).map((p) => (
                          <p key={p.id}>{p.receipt_no} — {formatAfn(p.amount)} · {p.payment_method} · {p.payment_date}</p>
                        ))}
                        {!(f.payments ?? []).length && <span className="text-slate-500">No payments yet.</span>}
                      </td>
                      <td className="px-2 py-2">{f.balance > 0 && <button onClick={() => openPay(f)} className="text-navy-600 hover:underline">Record payment</button>}</td>
                    </tr>
                  ))}
                  {!profile.fees.length && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-500">No fees assigned to this student yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">Due fees</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search student name or number…" className="ml-auto rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
            <option value="">Unpaid / partial</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="overdue">Overdue</option>
            <option value="paid">Paid</option>
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Student</th><th className="px-2 py-3">Fee</th><th className="px-2 py-3">Due date</th><th className="px-2 py-3">Due</th><th className="px-2 py-3">Paid</th><th className="px-2 py-3">Balance</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Action</th></tr></thead>
            <tbody>
              {filteredDue.map((f) => (
                <tr key={f.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{f.student_name}<span className="block text-xs text-slate-500">{f.department_name ?? ''}</span></td>
                  <td className="px-2 py-3">{f.fee_type_name}</td>
                  <td className="px-2 py-3">{f.due_date ? new Date(f.due_date).toLocaleDateString() : '—'}</td>
                  <td className="px-2 py-3">{formatAfn(f.amount_due)}</td>
                  <td className="px-2 py-3">{formatAfn(f.amount_paid)}</td>
                  <td className="px-2 py-3 font-semibold">{formatAfn(f.balance)}</td>
                  <td className="px-2 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[f.display_status]}`}>{f.display_status.toUpperCase()}</span></td>
                  <td className="px-2 py-3">{f.balance > 0 && <button onClick={() => openPay(f)} className="text-navy-600 hover:underline">Record payment</button>}</td>
                </tr>
              ))}
              {!filteredDue.length && <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-500">No fees match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">Payment history</h2>
          <input value={paySearch} onChange={(e) => setPaySearch(e.target.value)} placeholder="Search student, number or receipt…" className="ml-auto rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
          <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button onClick={exportPaymentsCsv} disabled={saving} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">Download CSV</button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Receipt</th><th className="px-2 py-3">Date</th><th className="px-2 py-3">Student</th><th className="px-2 py-3">Fee</th><th className="px-2 py-3">Method</th><th className="px-2 py-3">Amount</th><th className="px-2 py-3">Received by</th><th className="px-2 py-3">Action</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{p.receipt_no}</td>
                  <td className="px-2 py-3">{p.payment_date}</td>
                  <td className="px-2 py-3">{p.student_name}<span className="block text-xs text-slate-500">{p.student_no}</span></td>
                  <td className="px-2 py-3">{p.fee_type_name}</td>
                  <td className="px-2 py-3">{p.payment_method}</td>
                  <td className="px-2 py-3 font-semibold">{formatAfn(p.amount)}</td>
                  <td className="px-2 py-3">{p.received_by_name ?? '—'}</td>
                  <td className="px-2 py-3"><button onClick={() => setEditingPayment({ id: p.id, amount: String(p.amount), payment_method: p.payment_method, payment_date: p.payment_date, note: p.note ?? '' })} className="text-navy-600 hover:underline">Correct</button></td>
                </tr>
              ))}
              {!payments.length && <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-500">No payments recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editingPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Correct payment">
          <form onSubmit={savePaymentEdit} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Correct payment record</h2>
            <p className="mt-1 text-sm text-slate-500">Fix a wrong amount, method or date. The student&apos;s fee totals are re-calculated automatically.</p>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <label className="mt-4 block text-sm font-medium">Amount (AFN)
              <input required type="number" min={0.01} step={0.01} value={editingPayment.amount} onChange={(e) => setEditingPayment({ ...editingPayment, amount: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Payment method
              <select value={editingPayment.payment_method} onChange={(e) => setEditingPayment({ ...editingPayment, payment_method: e.target.value })} className={inputCls}>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">Payment date
              <input type="date" value={editingPayment.payment_date} onChange={(e) => setEditingPayment({ ...editingPayment, payment_date: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Note
              <input value={editingPayment.note} onChange={(e) => setEditingPayment({ ...editingPayment, note: e.target.value })} className={inputCls} />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingPayment(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save correction'}</button>
            </div>
          </form>
        </div>
      )}

      {payTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Record payment">
          <form onSubmit={recordPayment} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Record payment</h2>
            <p className="mt-1 text-sm text-slate-500">{payTarget.student_name} — {payTarget.fee_type_name} · balance {formatAfn(payTarget.balance)}</p>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <label className="mt-4 block text-sm font-medium">Amount (AFN)
              <input required type="number" min={0.01} step={0.01} max={payTarget.balance} value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Payment method
              <select value={payForm.payment_method} onChange={(e) => setPayForm({ ...payForm, payment_method: e.target.value })} className={inputCls}>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">Payment date
              <input type="date" value={payForm.payment_date} onChange={(e) => setPayForm({ ...payForm, payment_date: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Note
              <input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} placeholder="e.g. second instalment" className={inputCls} />
            </label>
            {lastPayment && (
              <div className="mt-4 rounded-lg border p-4 text-sm">
                <p className="font-bold">Receipt {lastPayment.receipt_no}</p>
                <p>{payTarget.student_name} — {payTarget.fee_type_name}</p>
                <p>Amount: {formatAfn(lastPayment.amount)} · Method: {lastPayment.payment_method} · Date: {lastPayment.payment_date}</p>
                <button type="button" onClick={() => lastPayment && printReceipt(lastPayment, payTarget)} className="mt-3 rounded-lg border px-4 py-2 text-sm">Print receipt</button>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setPayTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Close</button>
              {!lastPayment && <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Record payment'}</button>}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
