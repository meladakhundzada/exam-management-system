-- 011_refresh_tokens.sql — server-side refresh tokens (rotation + revocation).
-- Idempotent: safe to run more than once.
--
-- Why: access tokens used to be "refreshed" by re-issuing from an expired
-- access token, which cannot be revoked — logout was client-side only.
-- Login now stores a hashed refresh token here; /auth/refresh rotates it
-- (old token revoked, new one issued) and /auth/logout revokes it.
-- Only the SHA-256 hash is stored, never the raw token, so a database
-- leak does not hand out usable refresh tokens.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  replaced_by_id INTEGER REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent TEXT,
  ip_address INET
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
