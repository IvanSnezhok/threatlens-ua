-- Dynamic source trust: what the archive says about a publisher, kept apart from what the catalogue
-- declares about it.
--
-- ================================================================================================
-- Why a new table instead of a column on `sources`
-- ================================================================================================
--
-- `sources.tier` is a *mandate*: 'A' means a body with the legal authority to declare an air-raid
-- alert, 'B' a serious monitoring outlet, 'C' an auxiliary channel. It is set by hand in
-- `migrations/013_source_catalog_expansion.sql` after somebody read the channel, and it changes only
-- when a human decides it should. `src/services/risk.ts` reads it for the hard guardrails — "only
-- Tier C present, cap the index at 3.9", "no Tier A present, cap at 5.9" — and those caps are the
-- reason a rumour cannot become an alert.
--
-- Trust is a different axis entirely: it is a *measurement*, recomputed nightly from the archive,
-- of how this publisher has actually behaved over the last thirty days. Writing it into `tier` would
-- destroy the only property that makes the tier caps trustworthy — that no automated process can
-- move them. So the measurement gets its own table, and `sources.tier` is never written by the
-- trust worker. The application in `src/services/risk.ts` multiplies a signal's contribution by a
-- modifier bounded to [0.6, 1.2]; the tier caps are applied afterwards and are unchanged, so a
-- Tier C source with perfect behaviour is still a Tier C source and still caps the index at 3.9.
--
-- ================================================================================================
-- Why history is appended and never updated
-- ================================================================================================
--
-- A trust number that is silently overwritten every night cannot answer the question an operator
-- will actually ask when an index looks wrong: "what did we think of this channel *at the time*?"
-- Each run appends one row per source and the current value is the newest row, so a bad night, a
-- methodology change or a corrupted window is visible as a step in a series rather than as a value
-- that was always there. `methodology_version` is stored on the row for the same reason
-- `message_classifications.classifier_version` is stored on every classification: without it, a
-- change to the formula is indistinguishable from a change in the channel's behaviour.
--
-- The table grows by (number of sources) rows per day — under a hundred rows a night for the
-- current catalogue, some tens of thousands a year. That is small enough that no retention policy
-- is worth the risk of deleting the evidence for a decision.
--
-- ================================================================================================
-- What lives in `components`
-- ================================================================================================
--
-- Every metric that went into the number, separately, so the ops console can show the arithmetic
-- instead of a bare score. A score with no breakdown is an oracle, and an operator cannot argue with
-- an oracle. The keys written by `src/services/source-trust.ts` are:
--
--   * `withdrawnShare`      — decay-weighted share of this source's assertions that it later took back
--   * `corroboratedShare`   — decay-weighted share of its events another independence group also asserted
--   * `firstReports`        — events it published before anyone else, reposts excluded (see below)
--   * `lagMedianSeconds`    — median seconds behind the first reporter, over events it did not lead
--   * `unreadableShare`     — decay-weighted share of its messages this project failed to read
--   * `sampleSize`          — distinct events it asserted on in the window
--
-- jsonb rather than columns because the metric set is the part of this design most likely to change,
-- and because nothing queries an individual metric — the whole object is read, shown and stored as a
-- unit. When a metric is added, old rows keep their old `methodology_version` and their old shape,
-- which is exactly what makes the series honest across the change.

CREATE TABLE IF NOT EXISTS source_trust (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- 0..1, where 0.5 is the neutral start every source keeps until the window holds enough of its
  -- behaviour to say anything. The scale is deliberately not 0..10 like the risk index: nothing here
  -- is comparable with a risk score and the two must never be confused on a screen.
  trust numeric(4,3) NOT NULL CHECK (trust >= 0 AND trust <= 1),
  methodology_version text NOT NULL,
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The window the metrics were measured over, recorded rather than assumed: a run over seven days
  -- and a run over thirty are not points on the same series, and the row has to say which it is.
  window_days integer NOT NULL CHECK (window_days > 0),
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- The only access pattern: "the newest row for this source", either for one source or for all of
-- them at once. `(source_id, computed_at DESC)` serves both — a single index probe for one source,
-- and an index-ordered scan that `DISTINCT ON` consumes without a sort for the catalogue-wide read
-- the risk engine does on every run.
CREATE INDEX IF NOT EXISTS source_trust_current_idx
  ON source_trust (source_id, computed_at DESC);

-- One definition of "current", shared by the risk engine, the ops API and any query written later.
-- It existed briefly as the same `DISTINCT ON` copied into three places, which is the shape of bug
-- that shows up as two screens disagreeing about a number neither of them computed.
CREATE OR REPLACE VIEW source_trust_current AS
SELECT DISTINCT ON (source_id)
       source_id, trust, methodology_version, components, window_days, computed_at
FROM source_trust
ORDER BY source_id, computed_at DESC;
