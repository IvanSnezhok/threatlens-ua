-- ================================================================================================
-- Runtime settings an operator changes while watching the output, and the trail of who changed what
-- ================================================================================================
--
-- Why this is not more environment variables
-- ------------------------------------------
-- `PUBLICATION_DELAY_SECONDS` and `ANALYTICS_EVENT_DRIVEN_ENABLED` exist in `src/config.ts` and are
-- the right shape for what they do: deployment decisions, made once by whoever owns the container,
-- and — critically — a kill switch that must keep working when the database does not. What they
-- cannot express is the decision this table holds: "publish with a fifteen-second hold for the next
-- two hours", "raise the debounce, the wave is saturating the recompute", "stop spending Codex
-- calls". Those are operational judgements made mid-attack by the person already looking at /ops. An
-- operational judgement that requires editing .env and restarting the container is a judgement that
-- will not be made in time. This is the same argument migration 018 makes for `codex_settings`.
--
-- Why a second singleton table rather than more columns on codex_settings
-- ----------------------------------------------------------------------
-- 018 scopes its row to one question: "which parts of the system may speak to a model". Migration
-- 020 added a fifth switch to it precisely because a fourth Codex call site is the same question
-- again. Publication mode is not that question, and neither is the recompute cadence. An operator
-- looking for "why is the map fifteen seconds behind" must not have to read a table named after a
-- model vendor.
--
-- Why the defaults are `live` and event-driven-on
-- -----------------------------------------------
-- `live` is what the system does today; a migration must not silently change what a running
-- deployment publishes. Event-driven recomputation defaults ON because its alternative is the
-- existing fifteen-minute timer, which is strictly worse and still runs as the floor.

-- ------------------------------------------------------------------------------------------------
-- Why this file lifts the statement timeout for its own transaction
-- ------------------------------------------------------------------------------------------------
-- `src/db/migrate.ts` runs each migration inside a transaction it opened itself, on the ordinary
-- application connection — whose session GUC is `statement_timeout = 15s` (`src/db/pool.ts`, sent as
-- a startup parameter by node-pg, so it applies to DDL too). This is the first migration in the repo
-- to rewrite whole tables that have no retention policy: the `alert_periods.published_at` backfill
-- below matches every row, the `threat_event_locations.created_at` backfill matches every
-- pre-existing row (PG11+ takes the fast-default path for `DEFAULT now()`, stamping them all with
-- transaction-start time, so the `>` guard is true for all of them), and `SET NOT NULL` adds a full
-- verification scan under ACCESS EXCLUSIVE. `src/index.ts` awaits `migrate()` BEFORE `buildServer()`,
-- so a timeout here is not a slow deploy — it is a container that never reaches listen(), retried
-- forever by `restart: unless-stopped`, each attempt slower than the last because the rolled-back
-- UPDATE left its dead tuples behind. Migration 015 already reasons about this timeout for reads;
-- this is the same argument for a write.
--
-- `SET LOCAL` reverts at COMMIT, so its scope is this migration's transaction: no other migration
-- and no runtime statement loses the 15 s bound. `lock_timeout` is the companion the lift makes
-- necessary — without a statement timeout the `SET NOT NULL` below could otherwise queue on an
-- ACCESS EXCLUSIVE lock indefinitely, and failing fast on the lock is strictly better than hanging
-- the boot on it.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS runtime_settings (
  singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  publication_mode       text        NOT NULL DEFAULT 'live'
                                     CHECK (publication_mode IN ('live','delayed_15s')),
  -- When the mode in force was last CHANGED (not when the row was last written). The publication
  -- cutoff is clamped to this instant — `GREATEST(now() - delay, mode_changed_at)` — because
  -- `now() - delay` is NOT monotonic across a live→delayed_15s flip: at the instant of the flip it
  -- jumps fifteen seconds into the past and retracts rows that were already on the public map.
  -- Retracting an active alert, even for one second, is the one thing this system may never do
  -- (docs/ARCHITECTURE.md §Consistency rules). With the clamp the hold ramps in over `delaySeconds`
  -- instead of jumping backwards: nothing already published is withdrawn, and the hub's head is
  -- monotone for free. Persisted rather than kept in a process variable so it survives a restart and
  -- is the same value for every reader.
  mode_changed_at        timestamptz NOT NULL DEFAULT now(),
  analytics_event_driven boolean     NOT NULL DEFAULT true,
  -- Trailing-edge debounce. Floor 5 s, not 1 s: a debounce shorter than a recompute pass turns
  -- `execute()`'s re-arm into back-to-back passes over the same pool the ingestion tick and every
  -- snapshot share, i.e. one ops PUT becomes a self-inflicted denial of service. The independent
  -- `ANALYTICS_MIN_PASS_INTERVAL_MS` floor (§8.2) is the real guard; this bound stops the operator
  -- from asking for something the guard would then have to refuse. Ceiling 10 min because a
  -- recompute starved longer than the existing fifteen-minute timer is worse than that timer.
  analytics_debounce_ms  integer     NOT NULL DEFAULT 20000
                                     CHECK (analytics_debounce_ms BETWEEN 5000 AND 600000),
  -- Hard ceiling on how long a *continuously* re-armed debounce may postpone the recompute. Without
  -- it a mass attack — the exact case the analytics exist for — postpones the recompute forever.
  analytics_max_delay_ms integer     NOT NULL DEFAULT 120000
                                     CHECK (analytics_max_delay_ms BETWEEN 5000 AND 1800000),
  -- Minimum interval between two Codex calls on the analytics path. 0 disables the cooldown.
  codex_cooldown_ms      integer     NOT NULL DEFAULT 900000
                                     CHECK (codex_cooldown_ms BETWEEN 0 AND 86400000),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             text        NOT NULL DEFAULT 'system',
  CONSTRAINT runtime_settings_delay_order CHECK (analytics_max_delay_ms >= analytics_debounce_ms)
);

-- The row exists from the first migration run so that reading settings is a plain SELECT that
-- either finds defaults or finds an operator's choice, never "no row, therefore unknown".
INSERT INTO runtime_settings(singleton) VALUES (true) ON CONFLICT DO NOTHING;

COMMENT ON TABLE runtime_settings IS
  'Operator-controlled publication mode and event-driven analytics parameters. One row, enforced by the primary key.';
COMMENT ON COLUMN runtime_settings.publication_mode IS
  'live = publish as soon as processed. delayed_15s = public snapshot, SSE, map, event panel and public analytics see one shared cutoff PUBLICATION_DELAY_SECONDS old. Never gates ingestion, classification, audit, /ops, metrics or Telegram delivery.';
COMMENT ON COLUMN runtime_settings.mode_changed_at IS
  'Instant publication_mode last changed. The cutoff is GREATEST(now() - delay, mode_changed_at), which makes the cutoff monotonic across a flip so nothing already published is ever retracted.';
COMMENT ON COLUMN runtime_settings.analytics_max_delay_ms IS
  'Upper bound on debounce postponement: a continuously re-armed trailing-edge debounce would otherwise never fire during the attack it exists to describe.';
COMMENT ON COLUMN runtime_settings.updated_by IS
  'config.OPS_USER of the operator who last wrote the row, or ''system'' for the migration seed.';

-- ================================================================================================
-- Audit trail: one row per changed field, not per save
-- ================================================================================================
--
-- A whole-row snapshot per save would force every reader to diff two JSON blobs to answer the only
-- question anyone ever asks of this table — "who put it in delayed mode, and when". One row per
-- changed field answers it by reading it. The table is append-only; nothing ever updates a row here.

CREATE TABLE IF NOT EXISTS runtime_settings_audit (
  id             bigserial   PRIMARY KEY,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     text        NOT NULL,
  field          text        NOT NULL,
  previous_value text,
  new_value      text        NOT NULL,
  source         text        NOT NULL DEFAULT 'ops_api'
                             CHECK (source IN ('ops_api','migration','system'))
);
CREATE INDEX IF NOT EXISTS runtime_settings_audit_changed_idx
  ON runtime_settings_audit (changed_at DESC);

COMMENT ON TABLE runtime_settings_audit IS
  'Append-only record of every runtime_settings field change: who, when, from what, to what.';

-- ================================================================================================
-- Publication visibility timestamps
-- ================================================================================================
--
-- `alert_periods.started_at` is the PROVIDER's declared start (min(provider_started_at)) and is
-- routinely older than the moment we learned of the alert — filtering the cutoff on it would leak
-- an alert instantly whenever a provider back-dates. `created_at` is closer but is NOT refreshed by
-- the reopen branch (`ON CONFLICT (location_id,alert_type,started_at) DO UPDATE SET status='active'`,
-- src/services/ingestion.ts), so a reopened alert would look old the moment it reappears. This
-- column is the one honest answer to "when did this become publicly true", and the reopen branch
-- writes it (`src/services/ingestion.ts` `reconcileAggregateAlert`, agent A, wave 1 — §12) — but
-- CONDITIONALLY, and only when the period had genuinely stopped being public. A flap shorter than
-- `PUBLICATION_DELAY_SECONDS` never stopped being publicly true: the delayed view was still serving
-- the ended row (`status='ended' AND ended_at > cutoff`) a millisecond earlier, so a fresh
-- `published_at` there would satisfy neither branch of `activeAlerts()` and RETRACT an air-raid alert
-- from the public map for the rest of the hold. See the comment on that branch.
--
-- The backfill is BEST-EFFORT for history and says so out loud. `created_at` alone would stamp every
-- period that was reopened before this migration with its first appearance — knowingly wrong in
-- exactly the direction the column exists to prevent. For a row that is currently `active`,
-- `updated_at` carries the reopen instant, so `GREATEST(created_at, updated_at)` recovers it; for an
-- ended row the value is never read by the cutoff's first branch anyway.
ALTER TABLE alert_periods ADD COLUMN IF NOT EXISTS published_at timestamptz;
UPDATE alert_periods
   SET published_at = COALESCE(published_at,
                               CASE WHEN status = 'active' THEN GREATEST(created_at, updated_at)
                                    ELSE created_at END)
 WHERE published_at IS NULL;
ALTER TABLE alert_periods ALTER COLUMN published_at SET DEFAULT now();
ALTER TABLE alert_periods ALTER COLUMN published_at SET NOT NULL;

COMMENT ON COLUMN alert_periods.published_at IS
  'When this period became publicly true. Set on insert and refreshed by the reopen branch only when the period had already been publicly cleared (a gap longer than PUBLICATION_DELAY_SECONDS); refreshing it after a shorter flap would retract an alert the delayed view was still showing. Not the provider''s declared start (started_at) and not the row''s first insert (created_at). Values older than migration 022 are a best-effort backfill.';

-- ================================================================================================
-- threat_event_locations.created_at — the cutoff has to be able to hold a NEW DISTRICT too
-- ================================================================================================
--
-- The row gate on `threat_events.created_at` holds an event's first appearance. It does not hold a
-- district attached to an already-published event by a later merge: `threat_event_locations` has no
-- timestamp, so the jsonb_agg is unfiltered and a location added two seconds ago is published
-- instantly in a mode whose entire contract is a fifteen-second hold. Under Stage 1 and 2 that
-- location IS a polygon and an icon stack — the most perceivable output on the map — so "a
-- difference nobody can perceive" stopped being true the moment territories were drawn.
--
-- The column is cheap: the table is small, the column is defaulted, and the backfill copies the
-- parent event's own timestamp so every historical row is exactly as old as the event it belongs to.
ALTER TABLE threat_event_locations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
UPDATE threat_event_locations el
   SET created_at = e.created_at
  FROM threat_events e
 WHERE e.id = el.event_id AND el.created_at > e.created_at;

COMMENT ON COLUMN threat_event_locations.created_at IS
  'When this location was attached to the event. Filtered by the publication cutoff so a district added by a later merge is held for the same fifteen seconds as a brand-new event.';

-- The delayed view must still show an alert that ended less than the cutoff ago, otherwise the
-- public snapshot would announce an all-clear before the SSE frame that carries it. That branch of
-- the query is bounded by `updated_at > now() - interval '1 hour'`; without an index it degrades
-- into a sequential scan over every alert period the installation has ever recorded.
CREATE INDEX IF NOT EXISTS alert_periods_recent_idx ON alert_periods (updated_at DESC);
CREATE INDEX IF NOT EXISTS threat_events_recent_idx ON threat_events (updated_at DESC);

-- ================================================================================================
-- ai_runs: the four things the roadmap requires and the journal did not record
-- ================================================================================================
--
-- All four are nullable. Four writers insert into this table directly (codex-client.ts,
-- analytics-narrative.ts, risk.ts, vector-projection.ts) and a NOT NULL column would break the ones
-- that are not updated in the same commit. `prompt_version` stays the transport-level discriminator
-- it already is; `surface` is the *feature* the call served, which prompt_version only encodes by
-- convention and has already drifted.
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS surface            text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS classifier_version text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS validation_status  text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS fallback_reason    text;

ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_validation_status_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_validation_status_check
  CHECK (validation_status IS NULL OR validation_status IN ('passed','rejected','skipped'));

CREATE INDEX IF NOT EXISTS ai_runs_created_idx ON ai_runs (created_at DESC);

COMMENT ON COLUMN ai_runs.surface IS
  'narrative | digest | attacks | shadow | risk — which feature spent the call.';
COMMENT ON COLUMN ai_runs.validation_status IS
  'passed = the model text survived the number-grounding check; rejected = it did not and deterministic text was published; skipped = no check applies to this surface.';
COMMENT ON COLUMN ai_runs.fallback_reason IS
  'Why the deterministic path was used: a CodexFailureReason, ''codex_cooldown'', ''feature_disabled'' or ''ungrounded_number:<token>''.';
