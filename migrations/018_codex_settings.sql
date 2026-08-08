-- Which model, and for what — decided by an operator in /ops, not by a redeploy.
--
-- ================================================================================================
-- Why this is not more environment variables
-- ================================================================================================
--
-- `CODEX_MODEL` and `ANALYTICS_NARRATIVE_ENABLED` already exist and are the right shape for what
-- they do: they are deployment decisions, set once by whoever owns the container. What they cannot
-- express is the decision this table holds — "use the model for the nightly digest but not for the
-- attack extrapolation, and switch it off again tonight if it starts writing nonsense". That is an
-- operational judgement made while watching the output, by the same person who is already looking
-- at `ai_runs` in the console. An operational judgement that requires editing `.env` and restarting
-- the container is a judgement that will not be made in time.
--
-- One row, enforced by the primary key, for the same reason `codex_credentials` has one: there is
-- exactly one Codex identity for the installation, so there is exactly one answer to "which model
-- does it use". A second row would raise a question with no good answer.
--
-- ================================================================================================
-- Everything here is off by default, and stays subordinate to the deterministic path
-- ================================================================================================
--
-- All three feature flags default to false. A model that is quietly on is a model whose failures
-- are quietly absorbed, and every one of these surfaces is contractually complete without it:
--
--   * `narrative` — `analytics-archive.ts` computes every figure in SQL; the model only writes
--     prose about numbers that already exist, and the prose is rejected wholesale if it invents a
--     digit.
--   * `digest`    — the nightly digest is a list of assessments the risk engine produced. The model
--     adds one summarising sentence beneath it, or it adds nothing.
--   * `attacks`   — the operator-only vector extrapolation is arithmetic. The model rewords the
--     accompanying note, under the same number-faithfulness check.
--
-- `model` is nullable on purpose: NULL means "whatever `CODEX_MODEL` says". That keeps a deployment
-- that never opens the console behaving exactly as it did before this table existed, and it means
-- clearing the dropdown is a real choice rather than a way to break the installation.

CREATE TABLE IF NOT EXISTS codex_settings (
  singleton         boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  model             text,
  narrative_enabled boolean     NOT NULL DEFAULT false,
  digest_enabled    boolean     NOT NULL DEFAULT false,
  attacks_enabled   boolean     NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The row exists from the first migration run so that reading settings is a plain SELECT that
-- either finds defaults or finds an operator's choice, never "no row, therefore unknown".
INSERT INTO codex_settings(singleton) VALUES (true) ON CONFLICT DO NOTHING;

COMMENT ON TABLE codex_settings IS
  'Operator-controlled Codex model and per-feature switches. Holds no credentials; see codex_credentials.';
COMMENT ON COLUMN codex_settings.model IS
  'Chosen model id, or NULL to defer to CODEX_MODEL. Never a credential.';
