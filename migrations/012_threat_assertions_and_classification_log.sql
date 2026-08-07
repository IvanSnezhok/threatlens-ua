-- Per-source threat assertions, and the archive of every classifier decision.
--
-- Two tables that share one link: a message either **asserts** a threat or **withdraws** the
-- assertion its own source made earlier, and both facts have to survive the process that produced
-- them.
--
-- ================================================================================================
-- 1. threat_assertions — the state axis of a threat event
-- ================================================================================================
--
-- ## Why a new table and not a column on `event_evidence`
--
-- `event_evidence` answers "which messages support this event, and how strongly" — it is the
-- *evidence* axis, keyed (event_id, source_message_id), and the corroboration query counts distinct
-- independence groups over it to promote an event to `confirmed`. Three things make it the wrong
-- place to record withdrawal:
--
--   * **Different key.** A withdrawal names a place and a threat class ("нічого не летить на
--     Полтавщину", "відбій загрози ударних БпЛА") and has to match assertions on (source, location,
--     threat type). `event_evidence` carries none of those columns, and the message that withdraws
--     is almost never the message that asserted, so there is no row to update.
--   * **Different axis.** docs/ARCHITECTURE.md states that evidence never downgrades when a weaker
--     message is merged. Adding `withdrawn_at` to evidence would put a lifecycle on the very rows
--     the corroboration count reads, and a withdrawal would start silently *lowering* an evidence
--     level. State and evidence must be able to disagree: an event withdrawn by its only source is
--     still an event that two monitors once confirmed.
--   * **Different cardinality.** One message asserts over several locations and several threat
--     classes at once; evidence is one row per message.
--
-- The shape chosen instead is the one the official alert domain already uses and that this project
-- reasons about correctly: `alert_source_states` holds one row per (source, location, alert type)
-- and the aggregate is `bool_or(holds)`. `threat_assertions` is the same idea for threat events —
-- one row per (event, source, location, threat type), an event holds while any row holds, and a
-- source can only ever change its own rows. Having one mental model for "who still says this is
-- true" across both domains is worth more than the table it costs.
--
-- ## The safety rule, in the schema
--
-- Withdrawal is always `WHERE source_id = <the withdrawing source>`. A source that never asserted
-- owns no rows, so its withdrawal matches nothing and changes nothing — the guarantee is a
-- consequence of the key, not of a check somewhere in the application. Nothing in this file, and
-- nothing that writes to it, touches `alert_source_states` or `alert_periods`: an OSINT withdrawal
-- is not an "Офіційний відбій" and has no route to becoming one.
CREATE TABLE IF NOT EXISTS threat_assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  -- The publisher, not its independence group. A repost aggregator shares `independence_group` with
  -- the channel it copies (see `osint-vanek-nikolaev` / `air-force` in 011), and an all-clear from
  -- the copy must never retract the original's reporting. The group is denormalised alongside it so
  -- corroboration questions can be asked of this table without a join.
  source_id text NOT NULL REFERENCES sources(id),
  independence_group text NOT NULL,
  -- `ua` for a country-wide assertion, matching `threat_event_locations`.
  location_id text NOT NULL REFERENCES locations(id),
  -- A constituent threat class (`uav`, `ballistic_missile`, …), never the aggregate `combined`.
  -- Assertions and retractions then speak the same vocabulary: a message that denies drones inside a
  -- combined event withdraws the drone assertion and leaves the ballistic one standing.
  threat_type text NOT NULL,
  asserted_at timestamptz NOT NULL,
  asserted_message_id uuid REFERENCES source_messages(id) ON DELETE SET NULL,
  -- The window this source vouches for, mirroring `threat_events.valid_until`. An event's validity
  -- is recomputed as the maximum over the assertions that still hold, so one source taking its claim
  -- back can never shorten the window another source is still supporting.
  valid_until timestamptz NOT NULL,
  withdrawn_at timestamptz,
  withdrawn_message_id uuid REFERENCES source_messages(id) ON DELETE SET NULL,
  withdrawal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, source_id, location_id, threat_type)
);

-- Serves the withdrawal statement, which is always scoped to one source and optionally to a set of
-- locations and threat classes. Partial on the open rows: a withdrawal only ever reads those.
CREATE INDEX IF NOT EXISTS threat_assertions_open_idx
  ON threat_assertions (source_id, location_id, threat_type) WHERE withdrawn_at IS NULL;
-- Serves the aggregate "does anything still hold this event?" recomputation.
CREATE INDEX IF NOT EXISTS threat_assertions_event_idx ON threat_assertions (event_id);
-- Serves the "where are threats lost?" analysis: the withdrawal side of the join, newest first.
CREATE INDEX IF NOT EXISTS threat_assertions_withdrawn_idx
  ON threat_assertions (withdrawn_at DESC) WHERE withdrawn_at IS NOT NULL;
-- Serves per-location assertion history over a time range.
CREATE INDEX IF NOT EXISTS threat_assertions_location_idx
  ON threat_assertions (location_id, asserted_at DESC);

-- ================================================================================================
-- 2. message_classifications — one row per classifier decision, including the decisions to do
--    nothing
-- ================================================================================================
--
-- `source_messages` keeps the raw text and a single `processing_status` word. Everything the
-- classifier concluded — which indicators fired, which threat classes were candidates, which places
-- resolved and in what relation, what a withdrawal actually withdrew — was computed in memory and
-- thrown away, so "why was this message ignored?" had no answer at all.
--
-- The row is written for **every** message that reaches the classifier, not only the ones that
-- produced an event. The two questions the product owner wants to be able to ask later both live in
-- the discarded majority: how strike tactics change over time needs the whole stream, and where
-- threats are lost needs the messages that ended a threat rather than the ones that raised it.
--
-- ## Why `classifier_version` is mandatory
--
-- Without it an improvement to the classifier is indistinguishable from a change in enemy tactics.
-- Both show up as "fewer ballistic events in March than February", and there is no way to tell a
-- better regex from a quieter month. The column separates the two axes: any analysis that compares
-- periods must either hold the version constant or say that it did not.
--
-- The side benefit is that this archive becomes a golden corpus. A new classifier can be replayed
-- over the stored `source_messages` and its decisions compared with the ones recorded here, because
-- `UNIQUE (source_message_id, classifier_version)` lets both versions coexist for the same message
-- while making a replay of the *same* version a no-op.
CREATE TABLE IF NOT EXISTS message_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL REFERENCES source_messages(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id),
  classifier_version text NOT NULL,
  -- Publication time, not receipt time: the analytics group by when the enemy acted, and a backfill
  -- must land in the night it describes rather than the night it was replayed.
  published_at timestamptz NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now(),
  -- What the pipeline did. `redirect` keeps its own value rather than collapsing into
  -- created/merged, because it is the only decision that asserts and withdraws in one message;
  -- `created_event` below still says whether the event was new.
  decision text NOT NULL CHECK (decision IN (
    'event_created','event_merged','redirect','de_escalation','ignored','unrecognized','coalesced'
  )),
  -- What the message was doing, as opposed to what the pipeline did with it.
  intent text NOT NULL CHECK (intent IN ('threat','redirect','de_escalation','none')),
  created_event boolean NOT NULL DEFAULT false,
  -- Why nothing was raised. Free-form so a new rejection reason needs no migration, but the values
  -- the classifier emits today are `not_an_assertion`, `no_threat_recognised`, `no_location` and
  -- `restated_within_coalesce_window`.
  ignored_reason text,
  -- The class the event was filed under, including the aggregate `combined`.
  threat_type text,
  -- Every class the message matched, before the aggregate collapse. This is the column that shows a
  -- change in strike composition.
  candidate_threat_types text[] NOT NULL DEFAULT '{}',
  -- Strategic and contextual indicator names, exactly as the classifier reports them.
  indicators text[] NOT NULL DEFAULT '{}',
  national_scope boolean NOT NULL DEFAULT false,
  direction_text text,
  event_id uuid REFERENCES threat_events(id) ON DELETE SET NULL,
  -- ---- withdrawal detail; NULL for a message that withdrew nothing ------------------------------
  retraction_coverage text CHECK (retraction_coverage IS NULL OR retraction_coverage IN ('located','unspecified')),
  retracted_threat_types text[],
  -- How many of this source's assertions the decision actually took back. Zero is a meaningful
  -- value and is recorded: it is what a source withdrawing something it never asserted looks like.
  withdrawn_assertions integer,
  withdrawn_event_ids uuid[],
  -- The newest assertion this source still held immediately before the withdrawal. Answers "what
  -- was the last thing they said before they said it was over" without replaying the archive.
  last_assertion_at timestamptz,
  decayed_risk_signals integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_message_id, classifier_version)
);

-- The three analytical questions this table has to answer in one statement each, and the index that
-- serves each of them:
--   1. events per threat class per oblast per month, split by classifier version
--      -> message_classifications_version_time_idx + message_classifications_event_idx
--   2. for withdrawn threats: last assertion, withdrawal, elapsed time
--      -> threat_assertions_withdrawn_idx + threat_assertions_event_idx
--   3. messages ignored per source per day, with the reason
--      -> message_classifications_source_time_idx + message_classifications_decision_idx
CREATE INDEX IF NOT EXISTS message_classifications_time_idx
  ON message_classifications (published_at DESC);
CREATE INDEX IF NOT EXISTS message_classifications_source_time_idx
  ON message_classifications (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS message_classifications_version_time_idx
  ON message_classifications (classifier_version, published_at DESC);
CREATE INDEX IF NOT EXISTS message_classifications_decision_idx
  ON message_classifications (decision, published_at DESC);
CREATE INDEX IF NOT EXISTS message_classifications_event_idx
  ON message_classifications (event_id) WHERE event_id IS NOT NULL;

-- Locations are a separate table rather than a jsonb blob because "how often was this place named,
-- and in what relation" is the shape of nearly every question asked of this archive, and because the
-- foreign key keeps the ids honest against the catalogue.
--
-- `role` is what a jsonb column could not state cleanly: a redirect names the same message's places
-- in two opposite roles — the place being passed is withdrawn, the place being approached is
-- asserted — so the primary key carries the role.
CREATE TABLE IF NOT EXISTS message_classification_locations (
  classification_id uuid NOT NULL REFERENCES message_classifications(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id),
  role text NOT NULL CHECK (role IN ('asserted','retracted')),
  -- NULL for a retracted location: a withdrawal resolves places but states no relation to a threat
  -- it is denying.
  relation_type text CHECK (relation_type IS NULL OR relation_type IN (
    'explicit_threat','mentioned','reported_direction','official_alert','aftermath'
  )),
  PRIMARY KEY (classification_id, location_id, role)
);
CREATE INDEX IF NOT EXISTS message_classification_locations_location_idx
  ON message_classification_locations (location_id, role);
