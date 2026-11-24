-- ============================================================================
-- University Examination Department Management System
-- Migration 007 — Profile photos (avatar_url on users)
-- PostgreSQL 14+  |  UTF-8
-- Run AFTER 001_init.sql (it adds the column to users).
--   psql "$DATABASE_URL" -f 007_profile_photos.sql
-- Idempotent: safe to run more than once (ADD COLUMN IF NOT EXISTS,
-- DO block adds the CHECK only if it is not already there).
--
-- Design: photos are stored IN the database as a downscaled JPEG data URL
-- (TEXT) in users.avatar_url — never as files on disk. The live site runs
-- on Render's free plan, where the server filesystem is ephemeral: any
-- file written to disk vanishes on restart/redeploy, but a database value
-- survives. The client downscales the image to at most 512px and JPEG
-- quality 0.8 before upload; the backend rejects anything that is not a
-- JPEG/PNG/WebP data URL or is larger than 200 KB. The CHECK below caps
-- the stored value at 300,000 characters (~225 KB of image data once
-- base64-decoded), so a bad client cannot bloat the row.
-- The column already exists in 001_init.sql (users.avatar_url TEXT), so
-- on a database that ran 001 this migration is a no-op for the column and
-- only adds the CHECK. It creates no login accounts and seeds no rows.
-- ============================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Guard the column: only image data URLs, and bounded in size.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_url_format'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_avatar_url_format CHECK (
      avatar_url IS NULL
      OR (
        avatar_url LIKE 'data:image/%'
        AND LENGTH(avatar_url) <= 300000
      )
    );
  END IF;
END $$;

COMMIT;
