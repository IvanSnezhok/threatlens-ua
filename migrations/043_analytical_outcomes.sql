-- What became of the events the model was allowed to publish.
--
-- Migration 040 gave a high-confidence shadow verdict the right to create one unverified analytical
-- event and recorded the link in `shadow_classifications.analytical_event_id`. That column answers
-- exactly one question — «which event did this verdict create» — and stops there. When the event's
-- thirty-minute validity window expires (the `valid_until` written at INSERT in
-- `src/repositories/events.ts`), the row simply stops being live: nothing records whether an
-- official alert followed it, whether an independent human source said the same thing, or whether it
-- was a guess that nobody ever corroborated.
--
-- That missing record is the calibration input for `ANALYTICAL_THREAT_MIN_CONFIDENCE`
-- (`src/config.ts:271`). The floor ships at 0.9, and 0.9 was picked by judgement rather than
-- measured: no query in this installation can answer «of the promotions above 0.9, what share was
-- followed by an official alert, and would 0.95 have been better». Without that answer an operator
-- has two moves — leave the feature off, or switch it on and hope — and neither is acceptable for a
-- surface that publishes to a public map and to a Telegram channel. This table is what turns the
-- threshold into a number somebody can defend.
--
-- One row per promoted event, written once, after the fact, by `src/services/analytical-outcomes.ts`.
-- The direction of the dependency is the safety property: an outcome is a statement ABOUT a finished
-- event and never a statement that changes one. Nothing that writes here touches `threat_events`,
-- `alert_periods`, `alert_source_states`, `risk_signals` or `notification_outbox`, and no public
-- read joins this table — it exists for `/ops` and for `/metrics` alone.
CREATE TABLE IF NOT EXISTS analytical_outcomes (
  -- The event, as the primary key rather than beside a surrogate id. A promoted event has exactly
  -- one fate, the evaluation runs once per event and re-running it must be a no-op, so the natural
  -- key is also the idempotency guard: the scheduler inserts with ON CONFLICT DO NOTHING and a pass
  -- that crashes half way through cannot double-count anything on its retry.
  event_id uuid PRIMARY KEY REFERENCES threat_events(id) ON DELETE CASCADE,

  -- The audit root the verdict came from, for the reading list in `/ops`: from here an operator
  -- reaches the message text, the model's own analysis and the deterministic verdict it overrode.
  -- Nullable and ON DELETE SET NULL because `shadow_classifications.source_message_id` cascades from
  -- `source_messages` (migration 020), so a purged message takes its verdict with it — while the
  -- measurement derived from it must survive, or every retention pass would silently improve the
  -- precision figure by deleting its own evidence.
  shadow_classification_id uuid REFERENCES shadow_classifications(id) ON DELETE SET NULL,

  -- ---- the promotion, copied rather than joined ---------------------------------------------
  -- These four are denormalised from the verdict and the event on purpose. The precision query is
  -- «group every promotion of the last N days by confidence threshold», and answering it through
  -- `shadow_classifications` would mean a join to a table that grows with every ingested message,
  -- keyed on a column whose index (migration 040) is partial on the promoted rows only. Copying also
  -- makes the row self-contained: a measurement whose meaning depends on two other tables still
  -- being intact is a measurement that quietly changes when either is pruned.
  model text NOT NULL,
  confidence numeric(4,3) NOT NULL,
  threat_type text NOT NULL,
  published_at timestamptz NOT NULL,
  -- The deadline the event itself carried. Kept so that a later change to the validity window is
  -- visible in the data instead of silently reinterpreting every historical row.
  valid_until timestamptz NOT NULL,

  -- ---- the verdict on the verdict ------------------------------------------------------------
  --   'confirmed_official'    — an official alert started over the same territory inside the window
  --   'confirmed_independent' — a different independence group asserted the same threat class there
  --   'unconfirmed'           — the window closed and nothing corroborated it
  outcome text NOT NULL CHECK (outcome IN ('confirmed_official','confirmed_independent','unconfirmed')),
  -- When the corroborating signal appeared. `confirmed_at - published_at` is the lead time, which is
  -- the second question an operator asks after precision: a promotion confirmed one minute before
  -- the official alert bought a minute of warning, one confirmed twenty-nine minutes after it bought
  -- nothing but noise on the map.
  confirmed_at timestamptz,
  -- Where and by what, so a confirmation can be checked by hand rather than trusted. For an official
  -- confirmation this is the alert's own location, which may be an ancestor (the oblast) or a
  -- descendant (a city) of the location the model named — see `relatedLocationsCte` in
  -- `src/repositories/events.ts`. `confirmed_by` holds the alert type for an official confirmation
  -- and the independence group for an independent one.
  confirmed_location_id text REFERENCES locations(id),
  confirmed_by text,
  -- Was the territory ALREADY under an official alert when the model published?
  --
  -- This is the honesty column, and the reason the precision figure is worth reading at all. During
  -- a mass attack an oblast can sit under a continuous alert for hours; counting «an alert is
  -- active» as corroboration would confirm essentially every promotion and report a precision near
  -- 100% that measures nothing but the length of the alert. So corroboration requires an alert that
  -- STARTED after the promotion, which under-counts in the opposite direction: a correct promotion
  -- made during a standing alert can never be confirmed officially. Recording the condition instead
  -- of guessing lets `/ops` take those rows out of the denominator and say how many they were,
  -- rather than folding an undecidable case into either bucket.
  alert_active_at_publication boolean NOT NULL DEFAULT false,

  evaluated_at timestamptz NOT NULL DEFAULT now(),

  -- The two halves of a confirmation move together or the row is a lie: a confirmed outcome with no
  -- timestamp cannot yield a lead time, and an unconfirmed outcome with one is a confirmation that
  -- lost its label. Enforced here rather than in the writer because this table is the one place the
  -- measurement is allowed to be wrong in a way nobody would notice for weeks.
  CHECK ((outcome = 'unconfirmed') = (confirmed_at IS NULL))
);

-- Serves «precision by confidence threshold over the last N days»: the window is a range on
-- `published_at`, and the thresholds (0.85 / 0.9 / 0.95) are then applied to `confidence` inside it.
-- Leading with the time column and not with confidence is deliberate — every reading of this table
-- is windowed, the thresholds are compared several times per request against the same window, and a
-- confidence-first index would scan promotions from every night the installation has ever had.
CREATE INDEX IF NOT EXISTS idx_analytical_outcomes_precision
  ON analytical_outcomes(published_at DESC, confidence);

-- Serves «the last N promotions that came to nothing», which is the reading list an operator opens
-- after seeing the precision number. Partial for the same reason the promotion index in migration
-- 040 is: once the feature is calibrated the failures should be the minority of the table, and an
-- index over every outcome would be mostly entries this query never asks for. Planner note: the
-- predicate has to be written as `outcome='unconfirmed'` to match; `outcome <> 'confirmed_official'`
-- does not.
CREATE INDEX IF NOT EXISTS idx_analytical_outcomes_unconfirmed
  ON analytical_outcomes(published_at DESC)
  WHERE outcome = 'unconfirmed';

COMMENT ON TABLE analytical_outcomes IS
  'What followed each promoted model verdict: official alert, independent source, or nothing. Read only by /ops and /metrics; never mutates events or alerts.';
COMMENT ON COLUMN analytical_outcomes.event_id IS
  'The promoted unverified event this outcome describes; also the idempotency key of the evaluation';
COMMENT ON COLUMN analytical_outcomes.shadow_classification_id IS
  'Audit root of the model verdict, nullable because a purged source message takes its verdict with it';
COMMENT ON COLUMN analytical_outcomes.confidence IS
  'Model confidence at promotion time, copied from the verdict; the axis ANALYTICAL_THREAT_MIN_CONFIDENCE is calibrated on';
COMMENT ON COLUMN analytical_outcomes.outcome IS
  'confirmed_official | confirmed_independent | unconfirmed, decided after the event validity window closed';
COMMENT ON COLUMN analytical_outcomes.confirmed_at IS
  'When corroboration appeared; minus published_at it is the warning time the promotion actually bought';
COMMENT ON COLUMN analytical_outcomes.confirmed_by IS
  'Alert type for an official confirmation, independence group for an independent one';
COMMENT ON COLUMN analytical_outcomes.alert_active_at_publication IS
  'Territory was already under an official alert, so an official confirmation was unobtainable; /ops excludes these from the precision denominator';
