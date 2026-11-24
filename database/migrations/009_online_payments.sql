-- ============================================================================
-- University Examination Department Management System
-- Migration 009 — Online payments (HesabPay hosted checkout) + fine receipts
-- PostgreSQL 14+  |  UTF-8
-- Run AFTER 001_init.sql, 003_fees.sql and 006_finance_modules.sql.
--   psql "$DATABASE_URL" -f 009_online_payments.sql
-- Idempotent: safe to run more than once (CREATE TABLE IF NOT EXISTS,
-- CREATE SEQUENCE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DO blocks).
-- Creates no login accounts and seeds no rows.
--
-- What it adds:
--   1. payment_transactions — one row per online payment attempt.
--      An "invoice" is NOT a table: it is a document generated on demand
--      from a student_fees record (GET /api/payments/invoice/:feeId).
--      No duplicate invoices table is created, by design.
--   2. payment_reference_seq — numbers the PAY-YYYY-NNNNNN references
--      (e.g. PAY-2026-000001) handed to HesabPay as `user_id`, so a
--      webhook can be matched back to exactly one local transaction.
--   3. fines.receipt_no + fines.payment_method — fine payments now get a
--      receipt number from the SAME fee_receipt_seq sequence as fee
--      payments (REC-YYYY-NNNN), so a receipt number is never issued
--      twice across fees and fines. No separate fine receipt sequence.
--
-- Security notes:
--   * No card data is ever stored here: HesabPay hosted checkout takes
--     the card; we store only the provider session/transaction ids, the
--     amount and the provider's JSON response. No card number / CVV
--     column exists, and none must ever be added.
--   * payment_reference and idempotency_key are UNIQUE: a retried
--     create with the same idempotency key returns the same transaction
--     instead of charging twice.
--   * Only a verified successful payment (webhook signature verified
--     through HesabPay's verify-signature endpoint, or a transaction
--     check) may move money — the API enforces that, not this migration.
-- Amounts are in AFN (display convention, as in 003_fees.sql).
-- ============================================================================

BEGIN;

-- Sequence for PAY-YYYY-NNNNNN payment references.
CREATE SEQUENCE IF NOT EXISTS payment_reference_seq START WITH 1;

-- --------------------------------------------------------------------------
-- payment_transactions — one row per online payment attempt.
-- provider is 'hesabpay' today; the column is a plain VARCHAR so a second
-- provider can be added later without a schema change (the backend
-- adapter is provider-agnostic; only the HesabPay adapter exists now).
-- status: pending -> processing -> successful | failed | cancelled, and
-- successful -> refunded | partially_refunded (via the fee-refund flow).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                     SERIAL PRIMARY KEY,
  student_id             INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  student_fee_id         INTEGER REFERENCES student_fees(id) ON DELETE SET NULL,
  payment_reference      VARCHAR(30) NOT NULL UNIQUE,          -- e.g. PAY-2026-000001
  provider               VARCHAR(30) NOT NULL DEFAULT 'hesabpay',
  provider_session_id    VARCHAR(100),                          -- HesabPay session id
  provider_transaction_id VARCHAR(100),                         -- HesabPay transaction_id (after payment)
  amount                 NUMERIC(12,2) NOT NULL CHECK (amount > 0),  -- AFN
  currency               VARCHAR(10) NOT NULL DEFAULT 'AFN',
  status                 VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','processing','successful','failed','cancelled','refunded','partially_refunded')),
  payment_method         VARCHAR(30),                           -- e.g. hesabpay_wallet, international_card (as reported by the provider)
  idempotency_key        VARCHAR(100) NOT NULL UNIQUE,
  webhook_verified       BOOLEAN NOT NULL DEFAULT FALSE,        -- TRUE only after verify-signature (or a transaction check) passed
  raw_provider_response  JSONB,                                 -- full HesabPay session/webhook payload (never contains card data)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_reference
  ON payment_transactions(payment_reference);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_student
  ON payment_transactions(student_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_fee
  ON payment_transactions(student_fee_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
  ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_txn
  ON payment_transactions(provider_transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_created
  ON payment_transactions(created_at DESC);

-- --------------------------------------------------------------------------
-- Fine receipts — receipt number + method on the fines row itself.
-- Reuses fee_receipt_seq (migration 003), so REC-YYYY-NNNN numbers are
-- unique across fee payments AND fine payments with no second sequence.
-- --------------------------------------------------------------------------
ALTER TABLE fines
  ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(30) UNIQUE;

ALTER TABLE fines
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'cash'
    CHECK (payment_method IN ('cash','bank','mobile_money','other','online'));

-- --------------------------------------------------------------------------
-- updated_at trigger (uses set_updated_at() from 001_init.sql)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_payment_transactions_updated_at ON payment_transactions;
  CREATE TRIGGER trg_payment_transactions_updated_at
    BEFORE UPDATE ON payment_transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMIT;

-- Verification (run after applying):
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name = 'payment_transactions';
-- Expected: 1
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'payment_transactions' ORDER BY ordinal_position;
-- Expected columns: id, student_id, student_fee_id, payment_reference,
--   provider, provider_session_id, provider_transaction_id, amount,
--   currency, status, payment_method, idempotency_key, webhook_verified,
--   raw_provider_response, created_at, updated_at
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'fines' AND column_name IN ('receipt_no','payment_method');
-- Expected: receipt_no, payment_method
