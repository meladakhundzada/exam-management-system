-- ============================================================================
-- University Examination Department Management System
-- Migration 006 — Finance modules: Scholarships, Fines, Refunds
-- PostgreSQL 14+  |  UTF-8
-- Run AFTER 001_init.sql, 003_fees.sql and 005_reference_data.sql.
--   psql "$DATABASE_URL" -f 006_finance_modules.sql
-- Idempotent: safe to run more than once (CREATE TABLE IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS, DO blocks).
-- Three sequential transactions, one per module, in dependency order:
--   1. Scholarships — scholarships + student_scholarships tables, and
--      discount_amount / student_scholarship_id columns on student_fees.
--   2. Fines — fines table (dedicated; fines are NOT stored in
--      student_fees, so fee totals stay clean).
--   3. Refunds — fee_refunds table + is_refund flag on fee_payments and
--      a re-tied amount CHECK so only approved refunds can post a
--      negative reversal row (see the refunds section header).
-- Creates no login accounts and seeds no rows.
-- ============================================================================

-- ============================================================================
-- University Examination Department Management System
-- Migration 006 — Scholarships and financial discounts
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f 006_scholarships.sql
-- Idempotent: safe to run more than once. Run AFTER 001_init.sql and
-- 003_fees.sql (it adds columns to student_fees and references students,
-- users, academic_years and semesters).
--
-- NOTE FOR THE COORDINATOR: this file is a fragment to be assembled into
-- 006_finance_modules.sql together with the fines/refunds fragments.
-- It is complete and self-contained: BEGIN…COMMIT, CREATE TABLE IF NOT
-- EXISTS, ALTER TABLE … ADD COLUMN IF NOT EXISTS, DO blocks for the
-- updated_at triggers. It creates no login accounts and seeds no rows.
--
-- Design notes / assumptions (configurable, not official policy):
-- * A scholarship is EITHER a percentage discount (discount_percent,
--   0 < pct <= 100) OR a fixed AFN amount (fixed_amount > 0) — never
--   both, never neither. Enforced by a CHECK on scholarships.
-- * A student_scholarships row is one award of one scholarship to one
--   student for one academic year / semester. academic_year_id and
--   semester_id are NULLABLE: NULL means "applies to any year/semester"
--   (e.g. a full-programme scholarship). The API matches an award to a
--   fee only when the award's year/semester is NULL or equals the fee's.
-- * Approval workflow: pending → approved (Super Admin only) or
--   rejected (Super Admin only, pending only); approved → revoked
--   (staff). Only an APPROVED award ever discounts a fee. A pending
--   award discounts nothing.
-- * One approved award per student per year/semester (partial unique
--   index ux_student_scholarships_one_approved). This keeps the
--   discount on any one fee attributable to exactly one award, so
--   revoking an award can restore the exact discount it applied.
--   A student may hold several pending awards for the same period, but
--   approving a second one for that period is rejected (409).
-- * Discount storage: student_fees.discount_amount (AFN already taken
--   off) and student_fees.student_scholarship_id (the award that
--   applied it, NULL when no discount). amount_due is NET of the
--   discount: gross = amount_due + discount_amount. amount_paid and
--   status are always re-derived from the (net) amount_due, exactly as
--   fees.js does on payment/correction.
-- * 003_fees.sql constrains student_fees.amount_due > 0, so a discount
--   can never reduce a fee to exactly 0. The API clamps the discount so
--   at least 0.01 AFN remains due; a 100% scholarship therefore leaves
--   a 0.01 AFN balance. If the university wants fully-waived fees, the
--   CHECK in 003 must be relaxed to amount_due >= 0 (a 003 change, not
--   made here).
-- * Amounts are in AFN (display convention, as in 003_fees.sql).
-- No login accounts are created by this migration.
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Scholarships — the discount definitions (percent OR fixed amount)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scholarships (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(100) NOT NULL UNIQUE,          -- e.g. Merit Scholarship
  description      TEXT,
  discount_percent NUMERIC(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
  fixed_amount     NUMERIC(12,2) CHECK (fixed_amount > 0), -- AFN
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scholarships_one_discount_type CHECK (
    (discount_percent IS NOT NULL AND fixed_amount IS NULL) OR
    (discount_percent IS NULL AND fixed_amount IS NOT NULL)
  )
);

-- --------------------------------------------------------------------------
-- Student scholarships — one award per student per scholarship per period
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_scholarships (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  scholarship_id   INTEGER NOT NULL REFERENCES scholarships(id) ON DELETE RESTRICT,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  semester_id      INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','revoked')),
  approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live (pending or approved) award of the same scholarship to the same
-- student for the same year/semester. Rejected/revoked rows do not block a
-- fresh award.
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_scholarships_live
  ON student_scholarships (student_id, scholarship_id,
                           COALESCE(academic_year_id, 0), COALESCE(semester_id, 0))
  WHERE status IN ('pending', 'approved');

-- One approved award per student per year/semester (see header: this is
-- what makes a fee's discount attributable to exactly one award).
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_scholarships_one_approved
  ON student_scholarships (student_id,
                           COALESCE(academic_year_id, 0), COALESCE(semester_id, 0))
  WHERE status = 'approved';

-- --------------------------------------------------------------------------
-- Discount columns on student_fees (added here, not in 003 — see header)
-- --------------------------------------------------------------------------
ALTER TABLE student_fees
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0
    CHECK (discount_amount >= 0);

ALTER TABLE student_fees
  ADD COLUMN IF NOT EXISTS student_scholarship_id INTEGER
    REFERENCES student_scholarships(id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- Indexes (search / filter / FK hot paths)
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_scholarships_active   ON scholarships(is_active);
CREATE INDEX IF NOT EXISTS idx_student_scholarships_student ON student_scholarships(student_id);
CREATE INDEX IF NOT EXISTS idx_student_scholarships_scholarship ON student_scholarships(scholarship_id);
CREATE INDEX IF NOT EXISTS idx_student_scholarships_status ON student_scholarships(status);
CREATE INDEX IF NOT EXISTS idx_student_fees_scholarship ON student_fees(student_scholarship_id);

-- --------------------------------------------------------------------------
-- updated_at triggers (uses set_updated_at() from 001_init.sql)
-- --------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['scholarships','student_scholarships'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %s;
       CREATE TRIGGER trg_%s_updated_at
         BEFORE UPDATE ON %s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t);
  END LOOP;
END $$;

COMMIT;

-- Verification (run after applying):
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name IN
--   ('scholarships','student_scholarships');
-- Expected: 2
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='student_fees'
--      AND column_name IN ('discount_amount','student_scholarship_id');
-- Expected: discount_amount, student_scholarship_id

-- ============================================================================
-- University Examination Department Management System
-- Migration 006 — Fines and penalties module (fines table)
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f 006_fines.sql
-- Idempotent: safe to run more than once. Run AFTER 001_init.sql and
-- 003_fees.sql (it references students, fee_types and users).
-- NOTE: this file is a fragment — the coordinator assembles it into
-- 006_finance_modules.sql together with the other finance modules.
--   (No coordinator step is needed to run it standalone: it is a
--   complete BEGIN…COMMIT script on its own.)
--
-- Design notes / assumptions (configurable, not official policy):
-- * Amounts are in AFN (Afghan Afghani) by default — see the frontend,
--   which labels every amount "AFN". The database stores plain NUMERIC
--   amounts; the currency is a display convention, not a column.
-- * Fines live in their OWN table, NOT in student_fees. A fine is a
--   one-off penalty (e.g. late return, damaged book, misconduct), not a
--   recurring fee type charged per year/semester, so reusing
--   student_fees would pollute fee totals, the fee report and the
--   "one charge per student + fee type + year + semester" rule in 003.
-- * Status flow: outstanding → paid, or outstanding → waived. There is
--   no partial payment for a fine: a fine is paid in full in one step
--   (POST /api/fines/:id/pay sets status 'paid' and paid_at). A waived
--   fine is excluded from every outstanding total by the API, which
--   only ever sums status = 'outstanding'.
-- * Payment is recorded ON THE FINES ROW ITSELF (status + paid_at),
--   NOT through fee_payments. fee_payments.student_fee_id is NOT NULL
--   and references student_fees, so routing a fine payment through it
--   would require fabricating a student_fees row for every fine —
--   which would then appear in fee totals, the Fees report and the
--   student's fee balance. No receipt number is issued for a fine
--   payment (receipts belong to the fee_payments flow, REC-YYYY-NNNN);
--   if receipts for fines are ever required, that is a separate
--   decision for the coordinator, not a silent reuse of the fee flow.
-- * "Overdue" is computed by the API (due_date passed while still
--   outstanding), never stored and never enforced by a job.
-- * No late-fee automation and no scheduled jobs: fines are only ever
--   created by a staff member recording one manually. Nothing in this
--   migration creates, schedules or enables any automation.
-- * No login accounts are created by this migration.
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Fines — one row per penalty charged to one student.
-- fee_type_id is optional: a fine may be linked to a fee type (e.g. the
-- "Library" type for a lost-book fine) or stand alone with only a reason.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fines (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  fee_type_id      INTEGER REFERENCES fee_types(id) ON DELETE SET NULL,
  reason           TEXT NOT NULL,                                   -- why the fine was issued
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),       -- AFN
  due_date         DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'outstanding'
                   CHECK (status IN ('outstanding','paid','waived')),
  waived_by        INTEGER REFERENCES users(id) ON DELETE SET NULL, -- staff who waived it
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL, -- staff who recorded it
  paid_at          TIMESTAMPTZ,                                     -- set when status becomes 'paid'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Indexes (search / filter / FK hot paths)
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_fines_student ON fines(student_id);
CREATE INDEX IF NOT EXISTS idx_fines_fee_type ON fines(fee_type_id);
CREATE INDEX IF NOT EXISTS idx_fines_status  ON fines(status);
CREATE INDEX IF NOT EXISTS idx_fines_due     ON fines(due_date);
CREATE INDEX IF NOT EXISTS idx_fines_created ON fines(created_at);

-- --------------------------------------------------------------------------
-- updated_at trigger (uses set_updated_at() from 001_init.sql)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE
    'DROP TRIGGER IF EXISTS trg_fines_updated_at ON fines;
     CREATE TRIGGER trg_fines_updated_at
       BEFORE UPDATE ON fines
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();';
END $$;

COMMIT;

-- Verification (run after applying):
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name = 'fines';
-- Expected: 1
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'fines' ORDER BY ordinal_position;
-- Expected columns: id, student_id, fee_type_id, reason, amount,
--   due_date, status, waived_by, created_by, paid_at, created_at,
--   updated_at

-- ============================================================================
-- University Examination Department Management System
-- Migration 006 — Refunds (with authorization)
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f 006_refunds.sql
-- Idempotent: safe to run more than once. Run AFTER 003_fees.sql
-- (it needs fee_payments, student_fees and the fee_receipt_seq sequence).
--
-- NOTE: this file is a fragment the coordinator assembles into
-- 006_finance_modules.sql — it is complete and self-contained as written.
-- No login accounts are created by this migration.
--
-- What it adds:
--   1. fee_refunds — one row per refund request, with an approval workflow:
--      a staff member (finance included) requests, a Super Admin or Exam
--      Officer approves or rejects. Requesting changes NOTHING yet —
--      totals move only when an approval is posted.
--   2. A reversal payment in fee_payments when a refund is approved, so
--      the books stay reconcilable: student_fees.amount_paid always equals
--      the sum of that fee's fee_payments rows (see "CHECK handling" below).
--
-- CHECK handling — approach (a), hardened:
--   003_fees.sql gave fee_payments.amount CHECK (amount > 0), so a
--   reversal (negative) row could not be posted there. This migration
--   drops that check and re-adds it as:
--     CHECK ((amount > 0 AND NOT is_refund) OR (amount < 0 AND is_refund))
--   i.e. amount <> 0, with the sign tied to a new is_refund flag.
--   Why this is safe:
--   * Ordinary payments are unchanged: POST /api/fees/:id/pay and
--     PATCH /api/fees/payments/:id still validate amount >= 0.01 and
--     never set is_refund, so they can only insert/update positive rows
--     (is_refund defaults to FALSE). No existing code path can create a
--     negative row by accident.
--   * Only POST /api/fees/refunds/:id/approve inserts a negative row,
--     with is_refund = TRUE, inside the same transaction that re-totals
--     the parent fee — and only after a Super Admin / Exam Officer has
--     authorised it. Finance may request a refund but may NOT approve
--     their own (or anyone's) request.
--   * student_fees is NOT weakened at all: amount_paid >= 0 and
--     amount_paid <= amount_due still hold, because the approve route
--     refuses any refund that would drive amount_paid below 0, and
--     re-computes status (paid / partial / unpaid) from the new total,
--     exactly like the payment-correction route does.
--   * The reversal row is a normal fee_payments row (own receipt number
--     REC-YYYY-NNNN from fee_receipt_seq, original payment_method,
--     received_by = approver), so payment history, the receipt view and
--     the report keep working, and the refund is visible as a negative
--     line instead of silently editing the original payment away.
--   * Idempotency: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT re-applies
--     cleanly on a second run, and ADD COLUMN IF NOT EXISTS is a no-op.
--     No pre-existing negative rows can exist (the old CHECK forbade
--     them), so re-adding the check can never fail on live data.
--   * No other constraint is touched.
--
-- Amounts are in AFN (display convention; the DB stores plain NUMERIC).
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 1. fee_refunds — one row per refund request.
--    status: pending -> approved | rejected. Only 'approved' ever moves
--    money (via the reversal payment); 'rejected' changes nothing.
--    refund_payment_id links the reversal fee_payments row once approved.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_refunds (
  id                SERIAL PRIMARY KEY,
  fee_payment_id    INTEGER NOT NULL REFERENCES fee_payments(id) ON DELETE CASCADE,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),   -- AFN, refunded part
  reason            TEXT NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  requested_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  authorized_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  authorized_at     TIMESTAMPTZ,
  refund_payment_id INTEGER REFERENCES fee_payments(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_refunds_payment      ON fee_refunds(fee_payment_id);
CREATE INDEX IF NOT EXISTS idx_fee_refunds_status       ON fee_refunds(status);
CREATE INDEX IF NOT EXISTS idx_fee_refunds_requested_by ON fee_refunds(requested_by);

-- --------------------------------------------------------------------------
-- 2. Let fee_payments hold reversal rows (see header for why this is safe).
--    is_refund marks the negative rows; ordinary payments stay positive.
-- --------------------------------------------------------------------------
ALTER TABLE fee_payments
  ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE fee_payments
  DROP CONSTRAINT IF EXISTS fee_payments_amount_check;

ALTER TABLE fee_payments
  ADD CONSTRAINT fee_payments_amount_check
  CHECK ((amount > 0 AND NOT is_refund) OR (amount < 0 AND is_refund));

-- --------------------------------------------------------------------------
-- updated_at trigger (uses set_updated_at() from 001_init.sql)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_fee_refunds_updated_at ON fee_refunds;
  CREATE TRIGGER trg_fee_refunds_updated_at
    BEFORE UPDATE ON fee_refunds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMIT;

-- Verification (run after applying):
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name = 'fee_refunds';
-- Expected: 1
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'fee_payments'::regclass AND conname = 'fee_payments_amount_check';
-- Expected: fee_payments_amount_check
--   CHECK ((amount > 0 AND NOT is_refund) OR (amount < 0 AND is_refund))
--   INSERT INTO fee_payments (student_fee_id, amount, receipt_no, is_refund)
--   VALUES (<an existing fee id>, -100, 'REC-TEST-NEG', FALSE);
-- Expected: CHECK violation (negative amount without is_refund is refused).
--   (Do NOT run the INSERT above on live data — it is a check-only example;
--   roll it back if tried in a transaction.)
