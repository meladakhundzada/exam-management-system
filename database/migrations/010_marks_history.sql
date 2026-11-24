-- ============================================================================
-- 010_marks_history.sql — marks audit trail + approved-mark correction flow
-- ============================================================================
-- Marks hardening (2026-11-24):
--  * marks_history records every value/status change to a mark: who changed
--    what, from which value to which, when, and why. Approved marks can no
--    longer be silently overwritten by the marks upsert, so this table is
--    the only record of a value change.
--  * mark_corrections is the correction workflow for APPROVED marks: a
--    lecturer (or officer) requests a change with a reason; a Super Admin
--    or Exam Officer approves/rejects it; only on approval is the mark
--    updated (and the old value written to marks_history).
-- Idempotent: safe to re-run (IF NOT EXISTS / IF NOT EXISTS indexes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS marks_history (
  id          SERIAL PRIMARY KEY,
  mark_id     INTEGER NOT NULL REFERENCES marks(id) ON DELETE CASCADE,
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  old_value   NUMERIC(5,2),          -- obtained_marks before the change (NULL on creation)
  new_value   NUMERIC(5,2),          -- obtained_marks after the change
  reason      TEXT,                   -- e.g. 'created', 'approved', 'correction #12 approved'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marks_history_mark_idx ON marks_history (mark_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mark_corrections (
  id              SERIAL PRIMARY KEY,
  mark_id         INTEGER NOT NULL REFERENCES marks(id) ON DELETE CASCADE,
  requested_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_value  NUMERIC(5,2) NOT NULL CHECK (proposed_value >= 0),
  reason          TEXT NOT NULL,      -- why the approved mark is wrong
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,               -- officer's note on approve/reject
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one pending correction per mark: a second request while one is
-- awaiting review is rejected by the API (409) and by this index.
CREATE UNIQUE INDEX IF NOT EXISTS mark_corrections_one_pending_idx
  ON mark_corrections (mark_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS mark_corrections_status_idx ON mark_corrections (status, created_at DESC);
CREATE INDEX IF NOT EXISTS mark_corrections_mark_idx ON mark_corrections (mark_id, created_at DESC);
