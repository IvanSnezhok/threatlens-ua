-- Who authored the claim, as a column instead of an inference.
--
-- `evidence_level` answers "how well is this corroborated", and both a Tier C human channel and a
-- model promotion land on `unverified` there (src/repositories/events.ts). That collapses two
-- different statements into one word on the map: «джерело повідомило, підтвердження ще немає» and
-- «модель припустила, людина цього не писала». A reader deciding whether to move to a shelter is
-- entitled to know which one they are looking at, and today they cannot: the only trace of model
-- authorship is `classified.indicators = ['model_analytical_threat']`, which is consumed inside the
-- ingest transaction and never stored on the event, plus `source_messages.raw_payload ->
-- 'analyticalThreat'`, which is one join and one JSON path away from every read the public API makes.
--
-- The same two words, the same CHECK and the same default as
-- `attack_tactic_passes.commentary_origin` (migrations/034_attack_tactics.sql:100-101) and
-- `ops_threat_vector_projections.narrative_origin` (migrations/016_threat_vectors.sql:113-116). A
-- third vocabulary for the same distinction would mean a third mapping table in the web layer and a
-- third chance to get the fallback wrong; consumers already know that `deterministic` means "the
-- rules wrote this" and `model` means "a model did".
--
-- DEFAULT 'deterministic' is what keeps this migration invisible to everything that already exists.
-- Every writer other than the promotion path leaves the column alone, so no row silently becomes a
-- model claim, and a deployment that rolls back to the previous application binary keeps inserting
-- correct rows without knowing the column is there.
ALTER TABLE threat_events
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'deterministic'
    CHECK (origin IN ('deterministic','model'));

COMMENT ON COLUMN threat_events.origin IS
  'Who authored the event: deterministic rules over a source message, or a promoted model verdict';

-- Backfill from the audit root rather than from the message payload. `shadow_classifications`
-- (migration 040) is the only place that records the promotion decision itself, and its
-- `analytical_event_id` FK was created for exactly this question in exactly this direction: "which
-- event did this verdict create". Reading `raw_payload -> 'analyticalThreat'` instead would be a
-- guess about the writer's intent from a blob the collector also controls, and it would sweep in
-- every event a promoted message was later merged into.
--
-- Events promoted before this migration are rare-to-nonexistent in practice — `analytical_threats_enabled`
-- ships as false (migration 040) — but a database where an operator switched it on for an hour must
-- not end up describing those hours as deterministic work.
--
-- Driven FROM `shadow_classifications`, not from a scan of `threat_events` with an EXISTS on the
-- verdicts. The two are logically identical and operationally are not: the id list comes off
-- `idx_shadow_classifications_analytical_event` (migration 040), which is partial on
-- `analytical_event_id IS NOT NULL` and therefore holds only promoted rows, and the update then
-- reaches `threat_events` by primary key. The runner hands this file to the ordinary application
-- connection, whose session `statement_timeout` is 15s (see migration 022's note on lifting it), so
-- a whole-table scan on a grown installation would not be a slow deploy — it would be a container
-- that never reaches listen(), retried forever.
UPDATE threat_events e SET origin='model'
WHERE e.origin <> 'model'
  AND e.id IN (
    SELECT sc.analytical_event_id FROM shadow_classifications sc
    WHERE sc.analytical_event_id IS NOT NULL
  );

-- Partial on purpose. Model events are the small minority by construction — the promotion path is
-- gated on a switch that defaults to off, on a confidence floor, and on the deterministic rules
-- having already declined the message — so an index over the whole table would be almost entirely
-- `deterministic` entries no reader ever asks for. Every query that will use this index asks the
-- same way: "the model events", never "the deterministic ones". Planner note: a predicate written as
-- `origin='model'` matches this index; `origin <> 'deterministic'` does not.
CREATE INDEX IF NOT EXISTS idx_threat_events_model_origin
  ON threat_events(last_observed_at DESC)
  WHERE origin='model';
