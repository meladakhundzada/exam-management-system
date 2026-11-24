// Online Transactions — Finance / staff view of online payments.
// NEW page file (not wired into App.tsx / Sidebar.tsx yet — the
// coordinator adds the route + sidebar entry; see the delivery report).
// Lists payment_transactions with search (student ID / reference) and
// date + status filters, a detail view, and refund requests. Refunds go
// through the existing fee-refund approval flow: a request created here
// stays PENDING until a Super Admin / Exam Officer approves it on the
// Fees page — no money moves from this page. API helpers live in this
// file (services/api.ts is not edited).
import { useEffect, useState } from 'react';
import api, {
  ApiResponse, apiErrorMessage, formatAfn,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import type { PaymentTransaction } from './OnlinePayment';

export interface FeeRefundRequest {
  id: number;
  fee_payment_id: number;
  amount: number;
  reason: string;
  status: string;
  payment_reference?: string;
  fee_payment_receipt_no?: string;
}

const buildQuery = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

const paymentsApi = {
  list: (params: { search?: string; status?: string; date_from?: string; date_to?: string; page?: number; limit?: number } = {}) =>
    api.get<ApiResponse<PaymentTransaction[]> & { summary?: { total: number; successful_count: number; successful_amount: number; pending_count: number; failed_count: number } }>(
      `/payments?${buildQuery(params)}`,
    ),
  get: (id: number) => api.get<ApiResponse<PaymentTransaction>>(`/payments/${id}`),
  verify: (reference: string) =>
    api.get<ApiResponse<PaymentTransaction> & { provider_check?: string; error?: string }>(
      `/payments/verify/${encodeURIComponent(reference)}`,
    ),
  refund: (id: number, payload: { amount: number; reason: string }) =>
    api.post<ApiResponse<FeeRefundRequest>>(`/payments/${id}/refund`, payload),
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  processing: 'bg-amber-100 text-amber-700',
  successful: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-200 text-slate-600',
  refunded: 'bg-violet-100 text-violet-700',
  partially_refunded: 'bg-violet-100 text-violet-700',
};

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

export default function OnlineTransactions() {
  const { hasRole } = useAuth();
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE');

  const [txns, setTxns] = useState<PaymentTransaction[]>([]);
  const [summary, setSummary] = useState<{ total: number; successful_count: number; successful_amount: number; pending_count: number; failed_count: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [detail, setDetail] = useState<PaymentTransaction | null>(null);
  const [refundTarget, setRefundTarget] = useState<PaymentTransaction | null>(null);
  const [refundForm, setRefundForm] = useState({ amount: '', reason: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    const { data } = await paymentsApi.list({
      limit: 100,
      search: search || undefined,
      status: statusFilter || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    });
    setTxns(data.data);
    setSummary(data.summary ?? null);
  };

  const loadAll = async () => {
    setLoading(true);
    try { await load(); setError(null); }
    catch (err) { setError(apiErrorMessage(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (!isStaff || loading) return;
    const t = setTimeout(() => { load().catch((e) => setError(apiErrorMessage(e))); }, 400);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [search, statusFilter, dateFrom, dateTo]);

  const openDetail = async (txn: PaymentTransaction) => {
    try {
      const { data } = await paymentsApi.get(txn.id);
      setDetail(data.data);
    } catch (err) { setError(apiErrorMessage(err)); }
  };

  const verifyTxn = async (txn: PaymentTransaction) => {
    setSaving(true);
    try {
      const { data } = await paymentsApi.verify(txn.payment_reference);
      if (data.data.status === 'successful') setNotice(`Payment ${txn.payment_reference} confirmed successful with HesabPay.`);
      else if (data.provider_check === 'transaction_check_url_not_configured' || data.provider_check === 'not_configured') setNotice(`Payment ${txn.payment_reference} is ${data.data.status}. The provider transaction check is not configured on the server, so this is the local record only.`);
      else setNotice(`Payment ${txn.payment_reference} is ${data.data.status}.`);
      await load();
      if (detail?.id === txn.id) setDetail(data.data);
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setSaving(false); }
  };

  const openRefund = (txn: PaymentTransaction) => {
    setRefundTarget(txn);
    setRefundForm({ amount: String(txn.amount), reason: '' });
    setFormError(null);
  };

  const submitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundTarget) return;
    if (Number(refundForm.amount) <= 0) { setFormError('Refund amount must be greater than 0 AFN.'); return; }
    if (Number(refundForm.amount) > refundTarget.amount) { setFormError(`Refund cannot exceed the payment amount (${formatAfn(refundTarget.amount)}).`); return; }
    if (refundForm.reason.trim().length < 3) { setFormError('Give a reason for the refund (at least 3 characters).'); return; }
    setSaving(true);
    try {
      await paymentsApi.refund(refundTarget.id, { amount: Number(refundForm.amount), reason: refundForm.reason.trim() });
      setNotice(`Refund of ${formatAfn(Number(refundForm.amount))} requested for ${refundTarget.payment_reference}. It stays pending until the Super Admin or Examination Officer approves it on the Fees page — no money has moved yet, and the provider-side return must be made in the HesabPay portal.`);
      setRefundTarget(null);
      setFormError(null);
      await load();
    } catch (err) { setFormError(apiErrorMessage(err)); }
    finally { setSaving(false); }
  };

  if (loading) return <p className="p-4">Loading online transactions…</p>;

  if (!isStaff) {
    return (
      <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">Online transactions are visible to the Super Admin, Examination Officer and Finance Officer. Students see only their own payments on the Pay Online page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Online Transactions</h1>
        <p className="text-sm text-slate-500">
          Every online payment attempt through HesabPay. A payment counts as paid only after HesabPay verifies it
          (webhook signature or transaction check) — a student returning from checkout proves nothing on its own.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {summary && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Total attempts</p><p className="text-xl font-bold">{summary.total}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Successful</p><p className="text-xl font-bold text-emerald-600">{summary.successful_count} · {formatAfn(summary.successful_amount)}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Pending / processing</p><p className="text-xl font-bold text-amber-600">{summary.pending_count}</p></div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Failed</p><p className="text-xl font-bold text-red-600">{summary.failed_count}</p></div>
        </div>
      )}

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">Transactions</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search student, number or reference…" className="ml-auto rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="successful">Successful</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="refunded">Refunded</option>
            <option value="partially_refunded">Partially refunded</option>
          </select>
          <label className="text-sm">From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" /></label>
          <label className="text-sm">To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" /></label>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Reference</th><th className="px-2 py-3">Student</th><th className="px-2 py-3">Fee</th><th className="px-2 py-3">Amount</th><th className="px-2 py-3">Date</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Verified</th><th className="px-2 py-3">Actions</th></tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{t.payment_reference}<span className="block text-xs text-slate-500">{t.provider} · {t.provider_transaction_id ?? 'no provider transaction yet'}</span></td>
                  <td className="px-2 py-3">{t.student_name ?? '—'}<span className="block text-xs text-slate-500">{t.student_no ?? ''}</span></td>
                  <td className="px-2 py-3">{t.fee_type_name ?? '—'}</td>
                  <td className="px-2 py-3 font-semibold">{formatAfn(t.amount)}</td>
                  <td className="px-2 py-3">{new Date(t.created_at).toLocaleDateString()}</td>
                  <td className="px-2 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status]}`}>{t.status.toUpperCase().replace('_', ' ')}</span></td>
                  <td className="px-2 py-3">{t.webhook_verified ? <span className="text-emerald-600">Yes</span> : <span className="text-slate-500">No</span>}</td>
                  <td className="px-2 py-3">
                    <span className="flex flex-wrap gap-2">
                      <button onClick={() => openDetail(t)} className="text-navy-600 hover:underline">Details</button>
                      {t.status !== 'successful' && <button onClick={() => verifyTxn(t)} disabled={saving} className="text-navy-600 hover:underline disabled:opacity-50">Re-check</button>}
                      {t.status === 'successful' && <button onClick={() => openRefund(t)} className="text-navy-600 hover:underline">Request refund</button>}
                    </span>
                  </td>
                </tr>
              ))}
              {!txns.length && <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-500">No online transactions match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Transaction details">
          <div className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Transaction {detail.payment_reference}</h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Student</dt><dd className="font-medium">{detail.student_name} ({detail.student_no})</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Fee</dt><dd>{detail.fee_type_name ?? '—'} ({formatAfn(detail.amount_due ?? detail.amount)})</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Amount</dt><dd className="font-semibold">{formatAfn(detail.amount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd>{detail.status}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Provider</dt><dd>{detail.provider}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Provider session</dt><dd className="break-all">{detail.provider_session_id ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Provider transaction</dt><dd className="break-all">{detail.provider_transaction_id ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Payment method</dt><dd>{detail.payment_method ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Verified by HesabPay</dt><dd>{detail.webhook_verified ? 'Yes' : 'No'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Created</dt><dd>{new Date(detail.created_at).toLocaleString()}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Fee paid / balance</dt><dd>{formatAfn(detail.amount_paid ?? 0)} paid · fee {detail.fee_status ?? '—'}</dd></div>
            </dl>
            <div className="mt-6 flex justify-end gap-2">
              {detail.status !== 'successful' && <button onClick={() => verifyTxn(detail)} disabled={saving} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">Re-check with HesabPay</button>}
              <button onClick={() => setDetail(null)} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white">Close</button>
            </div>
          </div>
        </div>
      )}

      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Request refund">
          <form onSubmit={submitRefund} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Request refund</h2>
            <p className="mt-1 text-sm text-slate-500">
              {refundTarget.student_name} ({refundTarget.student_no}) — {refundTarget.payment_reference} ({formatAfn(refundTarget.amount)}).
              This creates a pending refund in the existing approval flow; the Super Admin or Examination Officer approves it on the Fees page.
              No money moves yet, and the provider-side return must be made in the HesabPay portal.
            </p>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <label className="mt-4 block text-sm font-medium">Refund amount (AFN)
              <input required type="number" min={0.01} step={0.01} max={refundTarget.amount} value={refundForm.amount} onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })} className={inputCls} />
            </label>
            <label className="mt-3 block text-sm font-medium">Reason
              <input required value={refundForm.reason} onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })} placeholder="e.g. duplicate online payment" className={inputCls} />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setRefundTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Request refund'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
