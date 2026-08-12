-- What the model saw ON TOP of an event the rules already published, kept strictly beside that event.
--
-- ================================================================================================
-- The gap this closes, and the one it deliberately does not
-- ================================================================================================
--
-- Migration 040 gave a high-confidence shadow verdict one narrow right: to CREATE an unverified
-- event where the deterministic rules created nothing. Three independent guards keep it to that
-- shape — `allowAnalyticalPromotion` is set only for `ignored`/`unrecognized` decisions
-- (`src/services/ingestion.ts`), `promoteAnalyticalThreat` exits when the deterministic verdict was
-- significant after all, and `ingestThreat` returns `published:false` when an event of the same
-- class already stands over the same place (`src/repositories/events.ts`). The model is a
-- gap-filler and nothing else.
--
-- The cost is everything the model sees that is MORE than what was published. The rules recognised
-- «Шахеди на Полтавщину» and raised the event; the same post also said «курс на Кременчук» and the
-- model read both. The direction, the second settlement and the sharper weapon class all land in
-- the same place today: nowhere. They are not in the event, because the promotion path refused it;
-- they are not in `/ops`, because `shadow_classifications` only records the comparison the model was
-- asked to make, and on a published message the two sides usually AGREE — the extra reading is not
-- a disagreement, so no row in the reading list points at it.
--
-- This migration adds a place for it, and the whole design is about what that place may NOT be.
--
-- ================================================================================================
-- Why a separate table rather than columns on `threat_events`
-- ================================================================================================
--
-- The obvious implementation is to let the model widen the event: append the extra location to
-- `threat_event_locations`, write `direction_text` when the rules left it null, raise `threat_type`
-- when the model recognised a sharper class. Every one of those is refused here, and not by
-- convention — by there being no column to write.
--
-- An enrichment that lived on the event could not be prevented from doing four things:
--
--   1. **Raising evidence.** `strongestEvidence` in `src/repositories/events.ts` merges the incoming
--      level into the row on every merge; a model-authored write travelling that path is one edit
--      away from carrying a level with it.
--   2. **Extending life.** The same statement writes
--      `valid_until=GREATEST(valid_until, published_at + 30 minutes)` and moves `last_observed_at`.
--      A model reading a post as a restatement would then keep a HUMAN source's warning standing
--      past the point that source vouched for — analysis extending the life of an official-adjacent
--      claim, which `CONTEXT.md` §Межі безпеки puts outside what analysis may do.
--   3. **Notifying.** `decideThreatNotification` (`src/bot/notification-policy.ts`) reads exactly two
--      things this would change: `geographyKey`, which is the sorted location id list — so an added
--      district is `geography_changed` and a fresh push to every subscriber — and `evidenceRank`,
--      which is `evidence_raised` and a push that must arrive with a sound. Neither decision has any
--      idea a model authored the change.
--   4. **Redrawing the map.** `threat_event_locations` IS the polygon and the icon stack in
--      `liveThreats`; a row there is not metadata, it is what a reader sees.
--
-- A row in a table that `liveThreats`, `threatDetails`, `locationTimeline`, the SSE relay and
-- `fanoutNewEvents` do not read cannot do any of the four, whatever a future writer intends. The FK
-- points from the enrichment to the event and never the other way: the event is a fact, the
-- enrichment is a remark about it, and the direction of that dependency is the safety property.
--
-- Publishing enrichments is therefore a decision nobody has taken. `/ops` reads this table; no
-- public surface joins it. When somebody does decide to show them, that will be a new migration, a
-- new read path and a new argument — not a flag flip on this one.
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS analytical_enrichment_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.analytical_enrichment_enabled IS
  'Allow a model verdict to record a direction, an extra location or a sharper threat class beside an event the deterministic rules published; read by /ops only, never joined by a public surface';

CREATE TABLE IF NOT EXISTS analytical_enrichments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The event this is a remark ABOUT. `ON DELETE CASCADE` because a remark about a purged event is
  -- not a measurement anybody can check — unlike `analytical_outcomes` (migration 043), which
  -- survives the purge of its audit root on purpose, this row has no meaning without the claim it
  -- annotates.
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,

  -- The audit root: the message both the rules and the model read. Together with
  -- `classifier_version` it is the key of the `shadow_classifications` row that holds the model's
  -- full analysis, so `/ops` reaches the verdict, the deterministic side and the raw text from here
  -- without this table having to copy any of them. Not a FK to `shadow_classifications` because
  -- that row is written on a best-effort path (`ON CONFLICT DO NOTHING` on a suppressed corpus) and
  -- an enrichment must not be lost because the comparison row was.
  source_message_id uuid NOT NULL REFERENCES source_messages(id) ON DELETE CASCADE,
  classifier_version text NOT NULL,

  model text NOT NULL,
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- ---- what the model added ------------------------------------------------------------------
  --   'direction'           — the source stated a course and the rules stored none
  --   'additional_location' — a place the rules did not attach to the event
  --   'threat_class'        — a strictly MORE severe class than the event carries; see
  --                           `src/services/analytical-enrichment.ts` for why downgrades are silence
  kind text NOT NULL CHECK (kind IN ('direction','additional_location','threat_class')),

  -- The FK is the second half of "the model may name a place but never an id": the writer resolves
  -- every model-written NAME through the production classifier over the production catalogue, and
  -- this constraint is what makes an id that survived that resolution the only thing storable.
  location_id text REFERENCES locations(id),
  threat_type text,
  direction_text text CHECK (direction_text IS NULL OR length(btrim(direction_text)) BETWEEN 1 AND 500),

  -- ---- what the event said at the time, copied from the event row itself ----------------------
  -- The reading list's question is «what did the rules publish, and what did the model see beyond
  -- it», and the second half is unanswerable after the fact: `threat_events.threat_type` may be
  -- raised by a later merge, and the evidence level almost always moves. These two are written by
  -- `INSERT ... SELECT ... FROM threat_events` — the values come out of the row being annotated,
  -- not out of the caller — and the trigger below re-reads the event and refuses any row where they
  -- disagree with it. So they are a snapshot no writer can forge, not a caller's assertion.
  event_threat_type text NOT NULL,
  event_evidence_level text NOT NULL CHECK (event_evidence_level <> 'official'),

  recorded_at timestamptz NOT NULL DEFAULT now(),

  -- Each kind carries exactly its own payload and nothing else. Without this a `direction` row could
  -- also carry a `location_id`, and `/ops` would render a place the model never proposed as a place
  -- the model proposed — the one way a table read by a human can lie without any column being wrong.
  CONSTRAINT analytical_enrichments_payload_matches_kind CHECK (
       (kind = 'direction'
          AND direction_text IS NOT NULL AND location_id IS NULL AND threat_type IS NULL)
    OR (kind = 'additional_location'
          AND location_id IS NOT NULL AND direction_text IS NULL AND threat_type IS NULL)
    OR (kind = 'threat_class'
          AND threat_type IS NOT NULL AND location_id IS NULL AND direction_text IS NULL)
  )
);

/*
 * Enriching an official event is refused by the database, not by the caller.
 *
 * `src/services/analytical-enrichment.ts` already filters on `evidence_level <> 'official'` and on
 * `origin = 'deterministic'` inside the `INSERT ... SELECT`, so in normal operation this trigger
 * never fires. It exists because that filter is one writer's discipline and this is the property:
 * an official alert mirrored into an event is the state speaking, and a model remark filed against
 * it — even in a table nothing public reads — is the beginning of the annotation becoming an
 * argument about the official signal. `CONTEXT.md` §Межі безпеки settles that question in one
 * direction, and a CHECK on a copied column cannot enforce it because the copy could be wrong.
 *
 * The `origin` half refuses the other compounding case: an enrichment filed against an event the
 * MODEL itself created. That event is already an unverified model claim; a second model reading
 * stacked on top of it is one opinion cited twice, and `/ops` would show two independent-looking
 * marks where there is one.
 *
 * RAISE rather than a silent skip, and that choice is safe precisely because of where this runs: the
 * writer issues one standalone INSERT outside any other transaction, and `shadowClassify` swallows
 * its failure like every other model-path failure. Nothing user-facing is rolled back by this
 * exception, and a silent skip would leave a violated invariant looking exactly like an empty table.
 */
CREATE OR REPLACE FUNCTION analytical_enrichment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  event_row threat_events%ROWTYPE;
BEGIN
  SELECT * INTO event_row FROM threat_events WHERE id = NEW.event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analytical enrichment references unknown event %', NEW.event_id;
  END IF;
  IF event_row.evidence_level = 'official' THEN
    RAISE EXCEPTION 'analytical enrichment refused: event % is official', NEW.event_id;
  END IF;
  IF event_row.origin <> 'deterministic' THEN
    RAISE EXCEPTION 'analytical enrichment refused: event % was not authored by the deterministic rules', NEW.event_id;
  END IF;
  -- The snapshot columns must be the event's own values, or the row is a plausible-looking lie about
  -- what the rules had published at the moment the model was read.
  IF NEW.event_threat_type <> event_row.threat_type
     OR NEW.event_evidence_level <> event_row.evidence_level THEN
    RAISE EXCEPTION 'analytical enrichment snapshot disagrees with event %', NEW.event_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS analytical_enrichments_guard ON analytical_enrichments;
CREATE TRIGGER analytical_enrichments_guard
  BEFORE INSERT ON analytical_enrichments
  FOR EACH ROW EXECUTE FUNCTION analytical_enrichment_guard();

-- One remark of one kind about one thing, per message, per event.
--
-- The idempotency this buys is not theoretical: `shadowClassify` is fire-and-forget and its promise
-- is dropped (`scheduleShadowClassification`), so a message re-read after a collector restart runs
-- the whole path again. `COALESCE(...,'')` rather than a plain multi-column index because two NULL
-- payload columns are never equal to each other in a unique index, and the same remark would insert
-- as many times as the message is replayed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytical_enrichments_once
  ON analytical_enrichments(event_id, source_message_id, kind,
                            COALESCE(location_id,''), COALESCE(threat_type,''));

-- Serves the only read: «the newest remarks», bounded by a window, in `/ops`. Leading on the
-- timestamp and not on `event_id` because the per-event lookup is already served by the unique index
-- above, whose first column is `event_id`.
CREATE INDEX IF NOT EXISTS idx_analytical_enrichments_recent
  ON analytical_enrichments(recorded_at DESC);

COMMENT ON TABLE analytical_enrichments IS
  'Model readings that go beyond an event the deterministic rules published. Read by /ops only; never changes evidence, validity, geography or notifications, and cannot be attached to an official or model-authored event.';
COMMENT ON COLUMN analytical_enrichments.event_id IS
  'The deterministic event this remark annotates; the dependency points this way and never the other';
COMMENT ON COLUMN analytical_enrichments.kind IS
  'direction | additional_location | threat_class — what the model saw beyond what was published';
COMMENT ON COLUMN analytical_enrichments.location_id IS
  'A catalogue id the model never wrote: resolved from a model-written name through the production classifier';
COMMENT ON COLUMN analytical_enrichments.event_evidence_level IS
  'The event evidence level at the moment of the remark, copied from the event row and verified by trigger; never official';
