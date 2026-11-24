-- ============================================================================
-- University Examination Department Management System
-- Migration 003 — Fees module (fee_types, student_fees, fee_payments)
-- PostgreSQL 14+  |  UTF-8  |  Run:  psql "$DATABASE_URL" -f 003_fees.sql
-- Idempotent: safe to run more than once. Run AFTER 001_init.sql.
--   npm run migrate:schema   (runs 001_init.sql + 003_fees.sql)
--   run.bat (Windows)        (runs 001_init.sql + 003_fees.sql)
--
-- Design notes / assumptions (configurable, not official policy):
-- * Amounts are in AFN (Afghan Afghani) by default — see the frontend,
--   which labels every amount "AFN". The database stores plain NUMERIC
--   amounts; the currency is a display convention, not a column.
-- * A student_fee is one fee type charged to one student for one
--   academic year / semester. amount_due is fixed at assignment time;
--   amount_paid grows with each payment. status is maintained by the
--   API on every payment: unpaid → partial → paid. A row whose due_date
--   has passed while still unpaid/partial is reported as "overdue" by
--   the API (computed, not stored), so no nightly job is needed.
-- * Receipt numbers come from a sequence: REC-2026-0001, REC-2026-0002 …
--   (year of the payment, zero-padded). receipt_no is UNIQUE.
-- * No login accounts are created by this migration.
-- ============================================================================

BEGIN;

-- Sequence for receipt numbers (one sequence; the year prefix is added
-- by the API when the receipt number is built).
CREATE SEQUENCE IF NOT EXISTS fee_receipt_seq START WITH 1;

-- --------------------------------------------------------------------------
-- Fee types — Tuition, Exam Fee, Admission, Library, Other …
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_types (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(100) NOT NULL UNIQUE,          -- e.g. Tuition
  description      TEXT,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),  -- default charge, AFN
  department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  semester_id      INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Standard fee types (reference data only — no amounts are enforced here;
-- the officer can edit the amount when creating/assigning a fee type).
-- Amounts are placeholders in AFN; the university sets its real fees.
INSERT INTO fee_types (name, description, amount) VALUES
  ('Tuition',   'Semester tuition fee',              15000),
  ('Exam Fee',  'Examination fee per semester',       2500),
  ('Admission', 'One-time admission fee',             5000),
  ('Library',   'Library fee per semester',           1000),
  ('Other',     'Other charges (specify in the note)', 1000)
ON CONFLICT (name) DO NOTHING;

-- --------------------------------------------------------------------------
-- Student fees — one charge per student per fee type per year/semester
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_fees (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  fee_type_id      INTEGER NOT NULL REFERENCES fee_types(id) ON DELETE RESTRICT,
  amount_due       NUMERIC(12,2) NOT NULL CHECK (amount_due > 0),   -- AFN
  amount_paid      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  due_date         DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'unpaid'
                   CHECK (status IN ('unpaid','partial','paid','overdue')),
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  semester_id      INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_fees_paid_le_due CHECK (amount_paid <= amount_due)
);

-- One charge per student + fee type + year + semester (NULL year/semester
-- count as 0, so the rule also applies to charges without a year/semester).
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_fees_unique
  ON student_fees (student_id, fee_type_id,
                   COALESCE(academic_year_id, 0), COALESCE(semester_id, 0));

-- --------------------------------------------------------------------------
-- Fee payments — one row per payment; a fee can be paid in instalments
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_payments (
  id            SERIAL PRIMARY KEY,
  student_fee_id INTEGER NOT NULL REFERENCES student_fees(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),          -- AFN
  payment_method VARCHAR(20) NOT NULL DEFAULT 'cash'
                CHECK (payment_method IN ('cash','bank','mobile_money','other')),
  receipt_no    VARCHAR(30) NOT NULL UNIQUE,                        -- e.g. REC-2026-0001
  received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,    -- officer who took it
  payment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Indexes (search / filter / FK hot paths)
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_fee_types_active     ON fee_types(is_active);
CREATE INDEX IF NOT EXISTS idx_fee_types_dept       ON fee_types(department_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_student ON student_fees(student_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_type    ON student_fees(fee_type_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_status  ON student_fees(status);
CREATE INDEX IF NOT EXISTS idx_student_fees_due     ON student_fees(due_date);
CREATE INDEX IF NOT EXISTS idx_fee_payments_fee     ON fee_payments(student_fee_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_receipt ON fee_payments(receipt_no);
CREATE INDEX IF NOT EXISTS idx_fee_payments_date    ON fee_payments(payment_date);

-- --------------------------------------------------------------------------
-- updated_at triggers (uses set_updated_at() from 001_init.sql)
-- --------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_types','student_fees'] LOOP
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
--   ('fee_types','student_fees','fee_payments');
-- Expected: 3
--   SELECT name, amount FROM fee_types ORDER BY id;
-- Expected: Tuition, Exam Fee, Admission, Library, Other
