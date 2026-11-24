// Online Payment — student pay flow (HesabPay hosted checkout).
// NEW page file (not wired into App.tsx / Sidebar.tsx yet — the
// coordinator adds the route + sidebar entry; see the delivery report).
// No card fields exist here: the student is redirected to HesabPay's
// hosted checkout, and only a verified payment updates their balance.
// API helpers live in this file (services/api.ts is not edited).
import { useEffect, useState } from 'react';
import api, {
  ApiResponse, StudentFee, apiErrorMessage, downloadBlob, feesApi, formatAfn,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

export interface PaymentTransaction {
  id: number;
  student_id: number;
  student_no?: string | null;
  student_name?: string | null;
  student_fee_id?: number | null;
  payment_reference: string;
  provider: string;
  provider_session_id?: string | null;
  provider_transaction_id?: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'successful' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded';
  payment_method?: string | null;
  webhook_verified: boolean;
  fee_type_name?: string | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  fee_status?: string | null;
  created_at: string;
  checkout_url?: string;
  expires_in_minutes?: number;
}

const buildQuery = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

const paymentsApi = {
  create: (payload: { student_fee_id: number; amount: number; idempotency_key: string }) =>
    api.post<ApiResponse<PaymentTransaction>>('/payments/create', payload),
  mine: (params: { status?: string; page?: number; limit?: number } = {}) =>
    api.get<ApiResponse<PaymentTransaction[]>>(`/payments/mine?${buildQuery(params)}`),
  verify: (reference: string) =>
    api.get<ApiResponse<PaymentTransaction> & { provider_check?: string; error?: string }>(
      `/payments/verify/${encodeURIComponent(reference)}`,
    ),
  invoice: (feeId: number) =>
    api.get(`/payments/invoice/${feeId}`, { responseType: 'blob' }),
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

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function OnlinePayment() {
  const { user, hasRole } = useAuth();
  const isStudent = hasRole('STUDENT');

  const [fees, setFees] = useState<StudentFee[]>([]);
  const [totals, setTotals] = useState({ total_due: 0, total_paid: 0, outstanding: 0 });
  const [txns, setTxns] = useState<PaymentTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedFeeId, setSelectedFeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [creating, setCreating] = useState(false);
  const [checkout, setCheckout] = useState<PaymentTransaction | null>(null);
  const [verifyingRef, setVerifyingRef] = useState<string | null>(null);

  const selectedFee = fees.find((f) => String(f.id) === selectedFeeId) ?? null;

  const load = async () => {
    if (!user?.studentId) { setError('No student profile is linked to your account. Contact the Examination Office.'); return; }
    const [mine, payments] = await Promise.all([
      feesApi.byStudent(user.studentId),
      paymentsApi.mine({ limit: 20 }).catch(() => null),
    ]);
    setFees(mine.data.data.fees);
    setTotals(mine.data.data.totals);
    if (payments) setTxns(payments.data.data);
  };

  const loadAll = async () => {
    setLoading(true);
    try { await load(); setError(null); }
    catch (err) { setError(apiErrorMessage(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const unpaidFees = fees.filter((f) => f.balance > 0);

  const pickFee = (fee: StudentFee) => {
    setSelectedFeeId(String(fee.id));
    setAmount(String(fee.balance));
    setCheckout(null);
    setNotice(null);
  };

  const startPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFee) { setError('Choose an unpaid fee first.'); return; }
    const amt = Number(amount);
    if (!(amt > 0)) { setError('Amount must be greater than 0 AFN.'); return; }
    if (amt > selectedFee.balance) { setError(`Amount cannot exceed the remaining balance (${formatAfn(selectedFee.balance)}).`); return; }
    setCreating(true);
    setError(null);
    try {
      const { data } = await paymentsApi.create({
        student_fee_id: selectedFee.id,
        amount: amt,
        idempotency_key: newIdempotencyKey(),
      });
      setCheckout(data.data);
      setNotice(`Payment ${data.data.payment_reference} created for ${formatAfn(amt)}. Note the reference, then continue to the HesabPay checkout — the link expires in ${data.data.expires_in_minutes ?? 15} minutes.`);
      await load();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setCreating(false); }
  };

  const verifyPayment = async (reference: string) => {
    setVerifyingRef(reference);
    setError(null);
    try {
      const { data } = await paymentsApi.verify(reference);
      const txn = data.data;
      if (txn.status === 'successful') {
        setNotice(`Payment ${reference} is confirmed successful. Your fee balance has been updated.`);
      } else if (data.provider_check === 'transaction_check_url_not_configured' || data.provider_check === 'not_configured') {
        setNotice(`Payment ${reference} is still ${txn.status}. The provider could not be re-checked automatically (transaction check is not configured on the server) — ask the Finance Office to confirm it.`);
      } else {
        setNotice(`Payment ${reference} is ${txn.status}.`);
      }
      await load();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setVerifyingRef(null); }
  };

  const downloadInvoice = async (fee: StudentFee) => {
    try {
      const res = await paymentsApi.invoice(fee.id);
      downloadBlob(res.data, `invoice-${fee.id}.pdf`);
    } catch (err) { setError(apiErrorMessage(err)); }
  };

  if (loading) return <p className="p-4">Loading online payments…</p>;

  if (!isStudent) {
    return (
      <div className="rounded-xl bg-white p-8 shadow-card dark:bg-slate-800">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">Online payment is for students. Finance staff use the Online Transactions page instead.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Pay Online</h1>
        <p className="text-sm text-slate-500">
          Pay your fees online through HesabPay&apos;s secure hosted checkout. You never enter card details on this site.
          All amounts are in AFN. Only a payment confirmed by HesabPay updates your balance — simply returning from
          the checkout page does not count as payment.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Total due</p><p className="text-xl font-bold">{formatAfn(totals.total_due)}</p></div>
        <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Total paid</p><p className="text-xl font-bold text-emerald-600">{formatAfn(totals.total_paid)}</p></div>
        <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800"><p className="text-sm text-slate-500">Outstanding</p><p className="text-xl font-bold text-red-600">{formatAfn(totals.outstanding)}</p></div>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">Unpaid invoices</h2>
        <p className="text-sm text-slate-500">Choose a fee, then pay it in full or in part (never more than the balance).</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Fee</th><th className="px-2 py-3">Due date</th><th className="px-2 py-3">Due</th><th className="px-2 py-3">Paid</th><th className="px-2 py-3">Balance</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Action</th></tr></thead>
            <tbody>
              {fees.map((f) => (
                <tr key={f.id} className={`border-b last:border-0 ${selectedFee?.id === f.id ? 'bg-navy-50 dark:bg-slate-700' : ''}`}>
                  <td className="px-2 py-3 font-medium">{f.fee_type_name}</td>
                  <td className="px-2 py-3">{f.due_date ? new Date(f.due_date).toLocaleDateString() : '—'}</td>
                  <td className="px-2 py-3">{formatAfn(f.amount_due)}</td>
                  <td className="px-2 py-3">{formatAfn(f.amount_paid)}</td>
                  <td className="px-2 py-3 font-semibold">{formatAfn(f.balance)}</td>
                  <td className="px-2 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${f.display_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : f.display_status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{f.display_status.toUpperCase()}</span></td>
                  <td className="px-2 py-3">
                    <span className="flex flex-wrap gap-3">
                      {f.balance > 0 && <button onClick={() => pickFee(f)} className="text-navy-600 hover:underline">Pay online</button>}
                      <button onClick={() => downloadInvoice(f)} className="text-navy-600 hover:underline">Invoice (PDF)</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!fees.length && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-500">No fees assigned to you yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {selectedFee && (
        <form onSubmit={startPayment} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">Pay {selectedFee.fee_type_name} online</h2>
          <p className="mt-1 text-sm text-slate-500">Remaining balance: {formatAfn(selectedFee.balance)}. You will be sent to HesabPay to pay — do not pay the same fee twice; if a payment is interrupted, check its status below before starting a new one.</p>
          <label className="mt-4 block max-w-xs text-sm font-medium">Amount (AFN)
            <input required type="number" min={0.01} step={0.01} max={selectedFee.balance} value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
          </label>
          <button type="submit" disabled={creating} className="mt-4 rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {creating ? 'Creating secure checkout…' : 'Continue to secure checkout'}
          </button>
        </form>
      )}

      {checkout?.checkout_url && (
        <div className="rounded-xl border-2 border-navy-600 bg-white p-5 shadow-card dark:bg-slate-800" role="status">
          <h2 className="text-lg font-bold">Your payment is ready</h2>
          <p className="mt-2 text-sm"><strong>Payment reference: {checkout.payment_reference}</strong> — keep this reference; it is how the Finance Office finds your payment.</p>
          <p className="mt-1 text-sm text-slate-500">Amount: {formatAfn(checkout.amount)} · Provider: HesabPay · Link expires in {checkout.expires_in_minutes ?? 15} minutes.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a href={checkout.checkout_url} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white">Continue to HesabPay checkout</a>
            <button type="button" onClick={() => verifyPayment(checkout.payment_reference)} disabled={verifyingRef === checkout.payment_reference} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">
              {verifyingRef === checkout.payment_reference ? 'Checking…' : 'I have paid — check payment status'}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
        <h2 className="text-lg font-bold">My online payments</h2>
        <p className="text-sm text-slate-500">Every online payment attempt you started, newest first. A payment counts only once HesabPay confirms it.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="px-2 py-3">Reference</th><th className="px-2 py-3">Fee</th><th className="px-2 py-3">Amount</th><th className="px-2 py-3">Date</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Action</th></tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-2 py-3 font-medium">{t.payment_reference}<span className="block text-xs text-slate-500">{t.provider_transaction_id ? `HesabPay: ${t.provider_transaction_id}` : 'No provider transaction yet'}</span></td>
                  <td className="px-2 py-3">{t.fee_type_name ?? '—'}</td>
                  <td className="px-2 py-3 font-semibold">{formatAfn(t.amount)}</td>
                  <td className="px-2 py-3">{new Date(t.created_at).toLocaleDateString()}</td>
                  <td className="px-2 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status]}`}>{t.status.toUpperCase().replace('_', ' ')}</span>
                    {t.webhook_verified && <span className="block text-xs text-emerald-600">Verified by HesabPay</span>}
                  </td>
                  <td className="px-2 py-3">
                    {t.status !== 'successful' && (
                      <button onClick={() => verifyPayment(t.payment_reference)} disabled={verifyingRef === t.payment_reference} className="text-navy-600 hover:underline disabled:opacity-50">
                        {verifyingRef === t.payment_reference ? 'Checking…' : 'Check status'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!txns.length && <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-500">No online payments yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
