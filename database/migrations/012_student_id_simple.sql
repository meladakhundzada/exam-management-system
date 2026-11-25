-- ============================================================================
-- 012_student_id_simple.sql — simplify student IDs to plain numbers.
-- ============================================================================
-- Rewrites every existing student_id from the old "STU-YYYY-NNN" format to
-- a plain zero-padded number, preserving each student's sequence number:
--   STU-2026-001 -> 001,  STU-2024-007 -> 007, ...
-- Idempotent: only rows still in the old format are touched, so re-running
-- this file is a no-op. No other table needs changing: every other table
-- references students by the numeric students.id foreign key, and admit
-- card references, receipt lines and report rows are generated at runtime
-- from the current student code (see backend/src/routes/reports.js).
-- Collision guard: if a plain target code already belongs to a different
-- student, that row is left untouched and a NOTICE is raised instead of
-- failing the whole migration.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  target_code TEXT;
BEGIN
  FOR r IN
    SELECT id, student_id FROM students
    WHERE student_id ~ '^STU-[0-9]{4}-[0-9]+$'
    ORDER BY id
  LOOP
    target_code := lpad(split_part(r.student_id, '-', 3), 3, '0');
    IF EXISTS (SELECT 1 FROM students WHERE student_id = target_code AND id <> r.id) THEN
      RAISE NOTICE '012: skipping student % (%) — target code % already exists', r.id, r.student_id, target_code;
    ELSE
      UPDATE students SET student_id = target_code WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
