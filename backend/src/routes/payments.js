// Online payments — provider-agnostic core with a HesabPay adapter.
// Hosted checkout ONLY: no card fields exist anywhere in our UI, no card
// numbers or CVV are ever collected, stored or logged. Amounts are AFN.
//
// HesabPay (verified against https://docs.hesab.com/ on 2026-11-24):
//   * Create session: POST {base}/api/v1/payment/create-session,
//     header `Authorization: API-KEY <key>`, body { items: [{id, name,
//     price}], user_id: <our payment reference> }. Returns a hosted
//     checkout URL; sessions expire after 15 minutes. Amounts are AFN,
//     1-20 items, max 999,999.99 AFN per session.
//   * Webhook signature verification (the ONLY documented verification
//     method — there is NO HMAC/webhook-secret scheme in the HesabPay
//     docs): POST {base}/api/v1/hesab/webhooks/verify-signature with
//     { signature, timestamp } and the same API-KEY header; the response
//     is verified when `success === true`. Docs:
//     https://docs.hesab.com/webhooks/verify-signatures/ and
//     https://docs.hesab.com/webhooks/overview/ (validation test +
//     payment_success / payment_failure events, up to 5 retries).
//     A webhook is therefore NEVER trusted on its payload alone, and a
//     browser redirect is NEVER proof of payment.
//   * The webhook payload matches a payment by `user_id` — the payment
//     reference we passed at session creation — and `transaction_id`
//     is HesabPay's gateway transaction id (docs:
//     https://docs.hesab.com/webhooks/event-payloads/). A success event
//     carries `success: true` and `status_code: 10`.
//   * Transaction-check / refund endpoints: the public docs pages
//     readable without a portal login do NOT publish the exact
//     transaction-check or provider-refund path/body in fetchable text,
//     so this file does NOT guess one. GET /verify/:reference calls a
//     transaction check ONLY when HESABPAY_TRANSACTION_CHECK_URL is set
//     (full URL, from the HesabPay developer portal); otherwise it
//     reports the local status and says the provider check is not
//     configured. Refunds go through the existing fee-refund approval
//     flow (see POST /:id/refund) and the provider-side money return is
//     done in the HesabPay portal until a refund endpoint is confirmed.
//     Do NOT invent a HesabPay path here — confirm it in the portal
//     first and set the env var.
//
// Configuration (env only — NEVER hardcode a key, NEVER send one to the
// frontend; see backend/.env.example additions reported with this work):
//   HESABPAY_API_KEY       sandbox/production API key (no key = 503, no
//                          fake checkout URL, no simulated payment)
//   HESABPAY_BASE_URL      default https://api-sandbox.hesab.com
//   HESABPAY_TRANSACTION_CHECK_URL  (optional, see above)
//
// Money moves in exactly one place: applySuccessfulPayment(), called
// only from the verified webhook and from a verified transaction check.
// It posts a real fee_payments row (receipt REC-YYYY-NNNN from
// fee_receipt_seq, payment_method 'other' — the fee_payments CHECK in
// migration 003 only allows cash|bank|mobile_money|other — with the
// HesabPay reference in the note) and re-totals the student fee, in the
// same transaction that marks the payment_transactions row successful.
// A duplicate webhook/verify for the same transaction is a no-op.
const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { body, param } = require('express-validator');
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, pagination, paginatedResponse } = require('../middleware/validate');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const STAFF = ['super_admin', 'exam_officer', 'finance'];
const CURRENCY = 'AFN';
const MAX_SESSION_AMOUNT = 999999.99;
const SESSION_TTL_MINUTES = 15;

// ---------------------------------------------------------------------------
// HesabPay adapter (provider-agnostic core: swap `hesabPay` for another
// adapter object with the same three methods to add a provider).
// ---------------------------------------------------------------------------
function hesabPayConfig() {
  const apiKey = process.env.HESABPAY_API_KEY || '';
  const baseUrl = (process.env.HESABPAY_BASE_URL || 'https://api-sandbox.hesab.com').replace(/\/$/, '');
  return { apiKey, baseUrl, configured: Boolean(apiKey) };
}

async function providerFetch(url, apiKey, payload, timeoutMs = 15000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `API-KEY ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function pickCheckoutUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [data, data.data].filter(Boolean);
  for (const obj of candidates) {
    for (const key of ['payment_url', 'checkout_url', 'session_url', 'payment_session_url', 'redirect_url', 'url']) {
      if (typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
    }
  }
  return null;
}

function pickSessionId(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [data, data.data].filter(Boolean);
  for (const obj of candidates) {
    for (const key of ['session_id', 'id']) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key];
    }
  }
  return null;
}

const hesabPay = {
  name: 'hesabpay',

  // Create a hosted-checkout session for one fee. Returns
  // { checkoutUrl, sessionId, raw } or throws an Error with a safe message.
  async createSession({ reference, amount, feeTypeName, feeId, studentEmail }) {
    const { apiKey, baseUrl } = hesabPayConfig();
    const payload = {
      items: [{ id: String(feeId), name: feeTypeName.slice(0, 100), quantity: 1, price: Number(amount) }],
      user_id: reference,
      email: studentEmail || undefined,
      memo: `Fee payment ${reference}`,
    };
    const { ok, status, data } = await providerFetch(`${baseUrl}/api/v1/payment/create-session`, apiKey, payload);
    if (!ok) {
      const msg = data?.message || data?.error || `HesabPay create-session failed (HTTP ${status})`;
      throw new Error(String(msg).slice(0, 300));
    }
    const checkoutUrl = pickCheckoutUrl(data);
    if (!checkoutUrl) throw new Error('HesabPay did not return a checkout URL');
    return { checkoutUrl, sessionId: pickSessionId(data), raw: data };
  },

  // Verify a webhook signature through HesabPay's documented endpoint.
  // Returns { verified: boolean, reason?: string }.
  async verifySignature(signature, timestamp) {
    const { apiKey, baseUrl, configured } = hesabPayConfig();
    if (!configured) return { verified: false, reason: 'not_configured' };
    if (!signature || !timestamp) return { verified: false, reason: 'missing_signature' };
    try {
      const { ok, data } = await providerFetch(
        `${baseUrl}/api/v1/hesab/webhooks/verify-signature`, apiKey, { signature, timestamp });
      if (!ok) return { verified: false, reason: 'provider_rejected' };
      return { verified: data?.success === true };
    } catch {
      return { verified: false, reason: 'provider_unreachable' };
    }
  },

  // Re-check one transaction with the provider. ONLY used when the
  // operator has set HESABPAY_TRANSACTION_CHECK_URL (full URL, from the
  // HesabPay developer portal). No path is guessed here.
  // Returns { checked, successful?, raw?, reason? }.
  async checkTransaction(providerTransactionId) {
    const { apiKey, configured } = hesabPayConfig();
    const checkUrl = process.env.HESABPAY_TRANSACTION_CHECK_URL || '';
    if (!configured) return { checked: false, reason: 'not_configured' };
    if (!checkUrl) return { checked: false, reason: 'transaction_check_url_not_configured' };
    if (!providerTransactionId) return { checked: false, reason: 'no_provider_transaction_id' };
    const { ok, data } = await providerFetch(checkUrl, apiKey, { transaction_id: providerTransactionId });
    if (!ok) return { checked: false, reason: 'provider_rejected' };
    const success = data?.success === true || data?.status_code === 10
      || String(data?.status || '').toLowerCase() === 'success'
      || String(data?.data?.status || '').toLowerCase() === 'success';
    return { checked: true, successful: success, raw: data };
  },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
async function ownStudentId(req) {
  if (req.user.role !== 'student') return null;
  const { rows } = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  return rows[0]?.id || null;
}

function toTxn(r) {
  return r ? { ...r, amount: Number(r.amount) } : r;
}

// Next PAY-YYYY-NNNNNN reference (sequence from migration 009).
async function nextReference(client) {
  const { rows } = await client.query(
    `SELECT 'PAY-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('payment_reference_seq')::text, 6, '0') AS ref`);
  return rows[0].ref;
}

// Post a verified successful payment to the fee, in the caller's
// transaction. Idempotent: if the transaction is already successful, or
// a fee payment for this reference already exists, nothing moves twice.
// Returns { alreadyPosted: boolean, feePayment }.
async function applySuccessfulPayment(client, txn, providerTransactionId, raw) {
  const fresh = await client.query('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [txn.id]);
  const row = fresh.rows[0];
  if (!row) throw new Error('Payment transaction not found');
  if (row.status === 'successful') return { alreadyPosted: true, feePayment: null };
  if (!row.student_fee_id) throw new Error('Payment transaction has no linked fee');
  const fee = await client.query('SELECT * FROM student_fees WHERE id = $1 FOR UPDATE', [row.student_fee_id]);
  if (!fee.rows[0]) throw new Error('Fee not found');
  const balance = Number(fee.rows[0].amount_due) - Number(fee.rows[0].amount_paid);
  const amount = Number(row.amount);
  if (amount > balance) throw new Error(`Verified payment (${amount} AFN) exceeds the fee balance (${balance} AFN)`);
  const receipt = await client.query(
    `SELECT 'REC-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('fee_receipt_seq')::text, 4, '0') AS receipt_no`);
  const receiptNo = receipt.rows[0].receipt_no;
  const pay = await client.query(
    `INSERT INTO fee_payments (student_fee_id, amount, payment_method, receipt_no, received_by, payment_date, note)
     VALUES ($1,$2,'other',$3,NULL,CURRENT_DATE,$4) RETURNING *`,
    [row.student_fee_id, amount, receiptNo, `Online payment via HesabPay — ${row.payment_reference}`]);
  const newPaid = Number(fee.rows[0].amount_paid) + amount;
  const newStatus = newPaid >= Number(fee.rows[0].amount_due) ? 'paid' : 'partial';
  await client.query('UPDATE student_fees SET amount_paid = $2, status = $3 WHERE id = $1',
    [row.student_fee_id, newPaid, newStatus]);
  await client.query(
    `UPDATE payment_transactions
        SET status = 'successful', provider_transaction_id = COALESCE($2, provider_transaction_id),
            webhook_verified = TRUE, raw_provider_response = $3
      WHERE id = $1`,
    [row.id, providerTransactionId || null, raw ? JSON.stringify(raw) : null]);
  return { alreadyPosted: false, feePayment: { ...pay.rows[0], amount: Number(pay.rows[0].amount) } };
}

const TXN_SELECT = `
  SELECT pt.*, s.student_id AS student_no, s.full_name AS student_name,
         s.email AS student_email, d.name AS department_name,
         ft.name AS fee_type_name, sf.amount_due, sf.amount_paid,
         sf.status AS fee_status
    FROM payment_transactions pt
    JOIN students s ON s.id = pt.student_id
    LEFT JOIN student_fees sf ON sf.id = pt.student_fee_id
    LEFT JOIN fee_types ft ON ft.id = sf.fee_type_id
    LEFT JOIN departments d ON d.id = s.department_id`;

// ---------------------------------------------------------------------------
// Webhook — PUBLIC (HesabPay calls it server-to-server; no JWT exists for
// it). Defined BEFORE authenticate() so the provider is not blocked by
// login. Signature verification is mandatory before any balance moves.
// ---------------------------------------------------------------------------
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    // 1. Receiver validation test — acknowledge, never touch money.
    if (event.type === 'webhook.validation' && event.test === true) {
      const check = await hesabPay.verifySignature(event.signature, event.timestamp);
      if (!check.verified) {
        return res.status(401).json({ success: false, error: 'Webhook signature verification failed' });
      }
      return res.status(200).json({ success: true });
    }
    // 2. Payment events must carry a signature + timestamp to verify.
    const check = await hesabPay.verifySignature(event.signature, event.timestamp);
    if (!check.verified) {
      // Non-200 so HesabPay retries (up to 5 retries per its docs);
      // a 401 here must never mark anything paid.
      return res.status(check.reason === 'not_configured' ? 503 : 401).json({
        success: false,
        error: check.reason === 'not_configured'
          ? 'HesabPay API key is not configured — webhook cannot be verified'
          : 'Webhook signature verification failed',
      });
    }
    // 3. Match by user_id = our payment reference (never by amount alone).
    const reference = event.user_id;
    const providerTxId = event.transaction_id ? String(event.transaction_id) : null;
    if (!reference) return res.status(400).json({ success: false, error: 'Webhook carries no user_id (payment reference)' });
    const { rows } = await query('SELECT * FROM payment_transactions WHERE payment_reference = $1', [reference]);
    const txn = rows[0];
    if (!txn) return res.status(404).json({ success: false, error: 'No payment transaction matches this reference' });
    // 4. Failure events: record failure, but NEVER downgrade an already
    // verified successful payment (docs: a later failure must not undo
    // a verified paid order).
    const isSuccess = event.success === true || event.status_code === 10;
    if (!isSuccess) {
      if (txn.status === 'successful') return res.status(200).json({ success: true, data: { already_successful: true } });
      await query(
        `UPDATE payment_transactions SET status = 'failed', provider_transaction_id = COALESCE($2, provider_transaction_id),
                webhook_verified = TRUE, raw_provider_response = $3 WHERE id = $1`,
        [txn.id, providerTxId, JSON.stringify(event)]);
      await logAudit({ userId: null, action: 'payments.webhook_failed', entityType: 'payment_transactions', entityId: txn.id, newValues: { payment_reference: txn.payment_reference, provider_transaction_id: providerTxId }, req });
      return res.status(200).json({ success: true, data: { status: 'failed' } });
    }
    // 5. Success events: the amount must match what we charged.
    if (event.amount !== undefined && Number(event.amount) !== Number(txn.amount)) {
      return res.status(400).json({ success: false, error: `Webhook amount (${event.amount} AFN) does not match the transaction amount (${Number(txn.amount)} AFN)` });
    }
    const result = await withTransaction(async (client) => applySuccessfulPayment(client, txn, providerTxId, event));
    if (!result.alreadyPosted) {
      await logAudit({ userId: null, action: 'payments.webhook_success', entityType: 'payment_transactions', entityId: txn.id, newValues: { payment_reference: txn.payment_reference, provider_transaction_id: providerTxId, receipt_no: result.feePayment?.receipt_no }, req });
    }
    return res.status(200).json({ success: true, data: { status: 'successful', already_posted: result.alreadyPosted, receipt_no: result.feePayment?.receipt_no || null } });
  } catch (err) {
    console.error('[payments webhook]', err);
    return res.status(500).json({ success: false, error: err.message || 'Webhook processing failed' });
  }
});

router.use(authenticate);

// ---------------------------------------------------------------------------
// Student endpoints
// ---------------------------------------------------------------------------

// GET /api/payments/mine — the signed-in student's own online payments.
// NOTE: must stay above GET /:id, or "mine" would match :id.
router.get('/mine', async (req, res, next) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ success: false, error: 'Students only' });
    const mine = await ownStudentId(req);
    if (!mine) return res.status(404).json({ success: false, error: 'No student profile is linked to your account' });
    const { page, limit, offset } = pagination(req);
    const where = ['pt.student_id = $1'];
    const params = [mine];
    if (req.query.status) { params.push(req.query.status); where.push(`pt.status = $${params.length}`); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = await query(`SELECT count(*)::int AS n FROM payment_transactions pt ${clause}`, params);
    const { rows } = await query(
      `${TXN_SELECT} ${clause} ORDER BY pt.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return res.json(paginatedResponse(rows.map(toTxn), total.rows[0].n, { page, limit }));
  } catch (err) { return next(err); }
});

// POST /api/payments/create — student pays one of their own fees online.
// Body: { student_fee_id, amount? (defaults to the remaining balance),
//         idempotency_key? (client-generated; reuse returns the same
//         transaction instead of a second charge) }.
// Without HESABPAY_API_KEY configured this returns 503 and creates
// NOTHING — no fake checkout URL, no simulated payment.
router.post('/create', requireRole('student'),
  [body('student_fee_id').isInt({ min: 1 }),
   body('amount').optional().isFloat({ min: 0.01, max: MAX_SESSION_AMOUNT }),
   body('idempotency_key').optional().trim().isLength({ min: 8, max: 100 })], validate,
  async (req, res, next) => {
    try {
      const cfg = hesabPayConfig();
      if (!cfg.configured) {
        return res.status(503).json({
          success: false,
          error: 'Online payments are not configured: the HesabPay sandbox API key (HESABPAY_API_KEY) is not set on the server. No payment was created and no checkout link exists. Ask the Examination Office to configure sandbox credentials.',
        });
      }
      const mine = await ownStudentId(req);
      if (!mine) return res.status(404).json({ success: false, error: 'No student profile is linked to your account' });
      const feeId = Number(req.body.student_fee_id);
      const fee = await query(
        `SELECT sf.*, s.full_name AS student_name, s.email AS student_email, ft.name AS fee_type_name
           FROM student_fees sf JOIN students s ON s.id = sf.student_id
           JOIN fee_types ft ON ft.id = sf.fee_type_id WHERE sf.id = $1`,
        [feeId]);
      if (!fee.rows[0]) return res.status(404).json({ success: false, error: 'Fee not found' });
      if (fee.rows[0].student_id !== mine) {
        return res.status(403).json({ success: false, error: 'Students can only pay their own fees' });
      }
      const balance = Number(fee.rows[0].amount_due) - Number(fee.rows[0].amount_paid);
      if (balance <= 0) return res.status(409).json({ success: false, error: 'This fee is already fully paid' });
      const amount = req.body.amount !== undefined ? Number(req.body.amount) : balance;
      if (amount > balance) {
        return res.status(400).json({ success: false, error: `Amount (${amount} AFN) exceeds the remaining balance (${balance} AFN)` });
      }
      const idempotencyKey = req.body.idempotency_key || crypto.randomUUID();
      // Idempotency: the same key for the same student returns the same
      // transaction — never a second charge.
      const existing = await query(
        'SELECT * FROM payment_transactions WHERE idempotency_key = $1 AND student_id = $2',
        [idempotencyKey, mine]);
      if (existing.rows[0]) {
        const prev = existing.rows[0];
        if (prev.status === 'successful') {
          return res.status(409).json({ success: false, error: 'This payment was already completed successfully', data: toTxn(prev) });
        }
        if (prev.status === 'failed' || prev.status === 'cancelled' || prev.status === 'refunded') {
          return res.status(409).json({ success: false, error: `This payment attempt already ended as ${prev.status}. Start a new payment.`, data: toTxn(prev) });
        }
        const storedUrl = pickCheckoutUrl(prev.raw_provider_response);
        if (storedUrl) {
          return res.json({ success: true, duplicate: true, data: { ...toTxn(prev), checkout_url: storedUrl, expires_in_minutes: SESSION_TTL_MINUTES } });
        }
        // Pending but no checkout URL stored (earlier session creation
        // failed before returning one): fall through and (re)create the
        // session for the SAME transaction row below.
        try {
          const session = await hesabPay.createSession({
            reference: prev.payment_reference, amount: prev.amount,
            feeTypeName: fee.rows[0].fee_type_name, feeId, studentEmail: fee.rows[0].student_email,
          });
          await query(
            `UPDATE payment_transactions SET provider_session_id = $2, raw_provider_response = $3 WHERE id = $1`,
            [prev.id, session.sessionId, JSON.stringify(session.raw)]);
          return res.json({ success: true, duplicate: true, data: { ...toTxn(prev), checkout_url: session.checkoutUrl, expires_in_minutes: SESSION_TTL_MINUTES } });
        } catch (err) {
          return res.status(502).json({ success: false, error: `HesabPay session creation failed: ${err.message}` });
        }
      }
      // New attempt: create the pending row first, then the session.
      const created = await withTransaction(async (client) => {
        const reference = await nextReference(client);
        const { rows } = await client.query(
          `INSERT INTO payment_transactions
             (student_id, student_fee_id, payment_reference, provider, amount, currency, status, idempotency_key)
           VALUES ($1,$2,$3,'hesabpay',$4,'AFN','pending',$5) RETURNING *`,
          [mine, feeId, reference, amount, idempotencyKey]);
        return rows[0];
      });
      let session;
      try {
        session = await hesabPay.createSession({
          reference: created.payment_reference, amount,
          feeTypeName: fee.rows[0].fee_type_name, feeId, studentEmail: fee.rows[0].student_email,
        });
      } catch (err) {
        // Provider call failed: no charge happened. The row stays
        // 'pending' so the same idempotency key can retry it.
        await logAudit({ userId: req.user.id, action: 'payments.create_failed', entityType: 'payment_transactions', entityId: created.id, newValues: { payment_reference: created.payment_reference, error: err.message }, req });
        return res.status(502).json({ success: false, error: `HesabPay session creation failed: ${err.message}`, data: { payment_reference: created.payment_reference } });
      }
      await query(
        `UPDATE payment_transactions SET provider_session_id = $2, status = 'processing', raw_provider_response = $3 WHERE id = $1`,
        [created.id, session.sessionId, JSON.stringify(session.raw)]);
      await logAudit({ userId: req.user.id, action: 'payments.create', entityType: 'payment_transactions', entityId: created.id, newValues: { payment_reference: created.payment_reference, amount, student_fee_id: feeId }, req });
      return res.status(201).json({
        success: true,
        data: {
          ...toTxn({ ...created, provider_session_id: session.sessionId, status: 'processing' }),
          checkout_url: session.checkoutUrl,
          expires_in_minutes: SESSION_TTL_MINUTES,
        },
      });
    } catch (err) { return next(err); }
  });

// GET /api/payments/verify/:reference — re-check one transaction.
// Students may verify only their own; staff may verify any. The local
// status is always returned; the provider is consulted only when the
// transaction has a provider_transaction_id AND the transaction-check
// URL is configured (see the file header — no provider path is guessed).
// A browser redirect is never treated as proof: only a verified
// provider success posts the payment (via applySuccessfulPayment).
router.get('/verify/:reference', param('reference').trim().isLength({ min: 3, max: 30 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(`${TXN_SELECT} WHERE pt.payment_reference = $1`, [req.params.reference]);
      const txn = rows[0];
      if (!txn) return res.status(404).json({ success: false, error: 'Payment transaction not found' });
      if (req.user.role === 'student') {
        const mine = await ownStudentId(req);
        if (mine !== txn.student_id) return res.status(403).json({ success: false, error: 'Students can only verify their own payments' });
      } else if (!STAFF.includes(req.user.role)) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      if (txn.status === 'successful') {
        return res.json({ success: true, data: { ...toTxn(txn), provider_check: 'already_successful' } });
      }
      const check = await hesabPay.checkTransaction(txn.provider_transaction_id);
      if (!check.checked) {
        return res.status(check.reason === 'not_configured' || check.reason === 'transaction_check_url_not_configured' ? 503 : 200).json({
          success: false, // the provider was NOT consulted — this is the local record only
          data: toTxn(txn),
          provider_check: check.reason,
          error: check.reason === 'transaction_check_url_not_configured'
            ? 'The HesabPay transaction-check endpoint is not configured (HESABPAY_TRANSACTION_CHECK_URL is not set). The payment status shown is the local record only — it has not been re-checked with HesabPay.'
            : check.reason === 'not_configured'
              ? 'HesabPay credentials are not configured, so the payment cannot be re-checked with the provider.'
              : check.reason === 'no_provider_transaction_id'
                ? 'This payment never reached HesabPay (no provider transaction id), so there is nothing to re-check.'
                : 'The provider could not confirm this transaction. The payment status shown is the local record only.',
        });
      }
      if (check.successful) {
        const result = await withTransaction(async (client) => {
          const fresh = await query('SELECT * FROM payment_transactions WHERE payment_reference = $1', [req.params.reference]);
          return applySuccessfulPayment(client, fresh.rows[0], txn.provider_transaction_id, check.raw);
        });
        await logAudit({ userId: req.user.id, action: 'payments.verify_success', entityType: 'payment_transactions', entityId: txn.id, newValues: { payment_reference: txn.payment_reference }, req });
        const updated = await query(`${TXN_SELECT} WHERE pt.payment_reference = $1`, [req.params.reference]);
        return res.json({ success: true, data: { ...toTxn(updated.rows[0]), provider_check: 'verified_successful', already_posted: result.alreadyPosted } });
      }
      await query(
        `UPDATE payment_transactions SET status = 'failed', raw_provider_response = $2 WHERE payment_reference = $1 AND status != 'successful'`,
        [req.params.reference, JSON.stringify(check.raw)]);
      const updated = await query(`${TXN_SELECT} WHERE pt.payment_reference = $1`, [req.params.reference]);
      return res.json({ success: true, data: { ...toTxn(updated.rows[0]), provider_check: 'verified_not_successful' } });
    } catch (err) { return next(err); }
  });

// GET /api/payments/invoice/:feeId — invoice PDF generated from the
// student_fees record (no invoices table exists, by design). Students
// get only their own; staff may get any. Uses the existing pdfkit setup.
router.get('/invoice/:feeId', param('feeId').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT sf.*, s.student_id AS student_no, s.full_name AS student_name, s.email AS student_email,
                d.name AS department_name, ft.name AS fee_type_name,
                sem.name AS semester_name, ay.name AS academic_year_name,
                (sf.amount_due - sf.amount_paid) AS balance
           FROM student_fees sf
           JOIN students s ON s.id = sf.student_id
           JOIN fee_types ft ON ft.id = sf.fee_type_id
           LEFT JOIN departments d ON d.id = s.department_id
           LEFT JOIN semesters sem ON sem.id = sf.semester_id
           LEFT JOIN academic_years ay ON ay.id = sf.academic_year_id
          WHERE sf.id = $1`,
        [req.params.feeId]);
      const fee = rows[0];
      if (!fee) return res.status(404).json({ success: false, error: 'Fee not found' });
      if (req.user.role === 'student') {
        const mine = await ownStudentId(req);
        if (mine !== fee.student_id) return res.status(403).json({ success: false, error: 'Students can only download their own invoices' });
      } else if (!STAFF.includes(req.user.role)) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      const pays = await query(
        'SELECT * FROM fee_payments WHERE student_fee_id = $1 ORDER BY payment_date DESC, id DESC', [fee.id]);
      const invoiceNo = `INV-${new Date(fee.created_at).getFullYear()}-${String(fee.id).padStart(4, '0')}`;
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${invoiceNo}.pdf"`);
      doc.pipe(res);
      doc.fontSize(18).text('University Examination Department', { align: 'center' });
      doc.fontSize(12).text('Fee Invoice', { align: 'center' }).moveDown();
      doc.fontSize(10);
      doc.text(`Invoice No: ${invoiceNo}`);
      doc.text(`Invoice date: ${new Date().toISOString().slice(0, 10)}`);
      doc.text(`Fee status: ${fee.status}`).moveDown();
      doc.fontSize(12).text('Billed to').fontSize(10);
      doc.text(`Student: ${fee.student_name} (${fee.student_no})`);
      doc.text(`Email: ${fee.student_email}`);
      doc.text(`Department: ${fee.department_name || '—'}`);
      doc.text(`Semester: ${fee.semester_name || '—'}${fee.academic_year_name ? ` (${fee.academic_year_name})` : ''}`).moveDown();
      doc.fontSize(12).text('Fee details').fontSize(10);
      doc.text(`Fee: ${fee.fee_type_name}`);
      doc.text(`Amount due: ${Number(fee.amount_due).toLocaleString('en-US', { maximumFractionDigits: 2 })} AFN`);
      if (Number(fee.discount_amount || 0) > 0) doc.text(`Scholarship discount: ${Number(fee.discount_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} AFN`);
      doc.text(`Amount paid: ${Number(fee.amount_paid).toLocaleString('en-US', { maximumFractionDigits: 2 })} AFN`);
      doc.text(`Balance outstanding: ${Number(fee.balance).toLocaleString('en-US', { maximumFractionDigits: 2 })} AFN`);
      doc.text(`Due date: ${fee.due_date ? String(fee.due_date).slice(0, 10) : '—'}`).moveDown();
      doc.fontSize(12).text('Payments received').fontSize(10);
      if (!pays.rows.length) doc.text('No payments recorded yet.');
      for (const p of pays.rows) {
        doc.text(`${p.receipt_no} — ${p.payment_date} — ${Number(p.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} AFN — ${p.payment_method}${p.note ? ` — ${p.note}` : ''}`);
      }
      doc.moveDown();
      doc.text('Pay online through the student portal (HesabPay hosted checkout) or at the Examination Office. Keep this invoice with your payment receipt as proof of payment.');
      doc.end();
    } catch (err) { return next(err); }
  });

// ---------------------------------------------------------------------------
// Staff endpoints
// ---------------------------------------------------------------------------

// GET /api/payments — Online Transactions list (staff only).
// Filters: ?search= (student ID / name / payment reference / provider
// transaction id), ?status=, ?date_from=, ?date_to=, ?provider=, ?page&limit.
router.get('/', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req);
    const { search, status, date_from, date_to, provider } = req.query;
    const where = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(s.student_id ILIKE $${params.length} OR s.full_name ILIKE $${params.length} OR pt.payment_reference ILIKE $${params.length} OR pt.provider_transaction_id ILIKE $${params.length})`);
    }
    if (status) { params.push(status); where.push(`pt.status = $${params.length}`); }
    if (provider) { params.push(provider); where.push(`pt.provider = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`pt.created_at::date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`pt.created_at::date <= $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await query(`SELECT count(*)::int AS n FROM payment_transactions pt JOIN students s ON s.id = pt.student_id ${clause}`, params);
    const { rows } = await query(
      `${TXN_SELECT} ${clause} ORDER BY pt.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    const summary = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'successful')::int AS successful_count,
              COALESCE(SUM(amount) FILTER (WHERE status = 'successful'), 0)::float AS successful_amount,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
         FROM payment_transactions`);
    return res.json({ ...paginatedResponse(rows.map(toTxn), total.rows[0].n, { page, limit }), summary: summary.rows[0] });
  } catch (err) { return next(err); }
});

// GET /api/payments/:id — one online transaction (staff only).
router.get('/:id', requireRole(...STAFF), param('id').isInt({ min: 1 }), validate,
  async (req, res, next) => {
    try {
      const { rows } = await query(`${TXN_SELECT} WHERE pt.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ success: false, error: 'Payment transaction not found' });
      return res.json({ success: true, data: toTxn(rows[0]) });
    } catch (err) { return next(err); }
  });

// POST /api/payments/:id/refund — refund request for an online payment
// (staff only). Implemented THROUGH the existing fee-refund approval
// flow (fee_refunds + POST /api/fees/refunds/:id/approve), NOT as a
// direct provider refund: the request stays PENDING and moves no money
// until a Super Admin / Exam Officer approves it in the Fees page, which
// posts the reversal payment and re-totals the fee. The provider-side
// money return (HesabPay) must then be done in the HesabPay portal —
// no provider refund endpoint path is documented in the public docs
// readable for this work, so no provider refund call is faked here.
// NOTE (known gap, for the coordinator): approving the refund in
// fees.js does not yet flip this payment_transactions row to
// 'refunded' / 'partially_refunded' — that cross-module update still
// needs a fees.js change or a later pass.
router.post('/:id/refund', requireRole(...STAFF), param('id').isInt({ min: 1 }),
  [body('amount').isFloat({ min: 0.01 }),
   body('reason').trim().isLength({ min: 3, max: 500 })], validate,
  async (req, res, next) => {
    try {
      const txnId = Number(req.params.id);
      const amount = Number(req.body.amount);
      const result = await withTransaction(async (client) => {
        const txn = await client.query('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [txnId]);
        if (!txn.rows[0]) return { status: 404, body: { success: false, error: 'Payment transaction not found' } };
        const t = txn.rows[0];
        if (t.status !== 'successful') {
          return { status: 409, body: { success: false, error: `Only a successful online payment can be refunded (this one is ${t.status})` } };
        }
        if (amount > Number(t.amount)) {
          return { status: 400, body: { success: false, error: `Refund (${amount} AFN) exceeds the payment amount (${Number(t.amount)} AFN)` } };
        }
        // The fee_payments row posted for this online payment carries
        // the payment reference in its note — that is the link.
        const pay = await client.query(
          `SELECT * FROM fee_payments WHERE student_fee_id = $1 AND amount = $2
            AND note ILIKE $3 ORDER BY id DESC LIMIT 1`,
          [t.student_fee_id, t.amount, `%${t.payment_reference}%`]);
        if (!pay.rows[0]) {
          return { status: 409, body: { success: false, error: 'No posted fee payment was found for this online payment, so a refund cannot be raised yet' } };
        }
        if (Number(pay.rows[0].amount) <= 0) {
          return { status: 400, body: { success: false, error: 'A refund payment cannot itself be refunded' } };
        }
        const used = await client.query(
          `SELECT COALESCE(SUM(amount),0)::float AS used FROM fee_refunds
            WHERE fee_payment_id = $1 AND status IN ('pending','approved')`, [pay.rows[0].id]);
        const remaining = Number(pay.rows[0].amount) - used.rows[0].used;
        if (amount > remaining) {
          return { status: 400, body: { success: false, error: `Refund (${amount} AFN) exceeds the refundable balance of this payment (${remaining} AFN)` } };
        }
        const { rows } = await client.query(
          `INSERT INTO fee_refunds (fee_payment_id, amount, reason, requested_by)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [pay.rows[0].id, amount, req.body.reason.trim(), req.user.id]);
        return { status: 201, body: { success: true, data: { ...rows[0], amount: Number(rows[0].amount), payment_reference: t.payment_reference, fee_payment_receipt_no: pay.rows[0].receipt_no } } };
      });
      if (result.status === 201) {
        await logAudit({ userId: req.user.id, action: 'payments.refund_request', entityType: 'fee_refunds', entityId: result.body.data.id, newValues: result.body.data, req });
      }
      return res.status(result.status).json(result.body);
    } catch (err) { return next(err); }
  });

module.exports = router;
