-- Codex over ChatGPT OAuth: credentials obtained in a browser, not pasted into .env.
--
-- ================================================================================================
-- Why this is a table and not four more environment variables
-- ================================================================================================
--
-- `CODEX_API_KEY` already exists and holds an OAuth *access token*. Access tokens expire — hours,
-- not months — so the only way that variable stays true is if a human notices the narrative went
-- quiet, re-runs `codex login`, edits `.env` and restarts the container. That is not a
-- configuration value; it is a session, and a session belongs in storage that can be rewritten
-- without a deploy.
--
-- One row, enforced by the primary key. There is exactly one Codex identity for the installation,
-- the same way there is exactly one Telegram collector session. A table that permitted two rows
-- would immediately raise the question of which one the narrative uses, and there is no answer to
-- it that is better than "there is only one".
--
-- ================================================================================================
-- What is stored, and what that means for whoever holds the database
-- ================================================================================================
--
-- `access_token` and `refresh_token` are bearer credentials for a ChatGPT account, stored as text.
-- Anyone who can read this table can act as that account until the tokens are revoked. That is the
-- same exposure `TELEGRAM_SESSION` already carries in `.env`, and it is deliberately not hidden
-- behind encryption here: the key would have to live beside the data in the same compose file, so
-- it would document a protection that does not exist. The honest controls are the ones that do:
--
--   * the token never leaves the server — `/ops/codex` returns account id and expiry, never the
--     token itself, and no public route reads this table at all;
--   * `docs/PRIVACY.md` and `docs/EXTERNAL_SETUP.md` name the exposure;
--   * revocation is one click in ChatGPT settings, and `DELETE /ops/codex` drops the row.
--
-- `last_error` holds the reason the most recent refresh failed. It is a diagnostic, not a state:
-- the narrative falls back to deterministic text whether or not anybody reads it.

CREATE TABLE IF NOT EXISTS codex_credentials (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_id    text,
  access_token  text        NOT NULL,
  refresh_token text,
  id_token      text,
  scope         text,
  expires_at    timestamptz,
  obtained_at   timestamptz NOT NULL DEFAULT now(),
  refreshed_at  timestamptz,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE codex_credentials IS
  'Single ChatGPT OAuth session used by the analytics narrative. Bearer credentials in plaintext; see migration header.';
COMMENT ON COLUMN codex_credentials.expires_at IS
  'Access token expiry as reported by the token endpoint. NULL means unknown, which is treated as "refresh before every use".';
