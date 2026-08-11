-- The rows a risk pass stops writing, and the three scans it stops paying for.
--
-- ================================================================================================
-- What was measured
-- ================================================================================================
--
-- Against a database seeded to the shape this deployment grows into — 200 516 `risk_assessments`,
-- 301 800 `risk_signals`, 300 000 `risk_assessment_signals`, 288 live groups, PostgreSQL 18,
-- `EXPLAIN (ANALYZE, BUFFERS)` — the three statements a pass and a public snapshot run most often
-- cost this before the indexes below existed:
--
--   * the previous published assessment of one group
--     (`WHERE location_id=$1 AND threat_type=$2 AND published AND superseded_by IS NULL
--       ORDER BY generated_at DESC LIMIT 1`, once per group per pass — 288 times):
--     bitmap scan on `risk_assessments_live_idx` reading 776 heap blocks to keep ONE row,
--     788 buffers, 1.53 ms. Per pass: ~227 000 buffer touches to answer 288 one-row questions.
--
--   * `currentAssessments()` — the map snapshot, run for EVERY public reader:
--     parallel sequential scan over the whole table, 66 588 rows discarded per worker,
--     4 220 buffers, 14.1 ms.
--
--   * the live signal grouping that opens every pass:
--     bitmap scan on `risk_signals_live_group_idx` with 259 separate index searches (the index
--     leads with `location_id`, so `expires_at > now()` can only be applied per distinct location),
--     1 094 buffers, 5.0 ms.
--
-- With the three indexes below: 4 buffers / 0.08 ms, 198 buffers / 0.83 ms, 60 buffers / 0.85 ms.
-- The sequential scan under the public snapshot is gone, and the grouping does one index search
-- instead of 259.
--
-- All three tables are append-only and have no retention policy, so every one of these numbers is a
-- number that grows without bound. That is the actual argument for this file: not that 14 ms is slow
-- today, but that it is 14 ms *per public reader* and it is proportional to how long the deployment
-- has been running.
--
-- ================================================================================================
-- Why `extended_at` exists
-- ================================================================================================
--
-- `runRiskAssessmentsPass` used to INSERT a complete assessment plus one `risk_assessment_signals`
-- row per contributing signal on EVERY pass, including the passes that changed nothing: the score
-- moved by less than half a point, the level was the same, the wording was the same. Those rows were
-- written with `published=false` and no consumer has ever read them — every reader in `src/` filters
-- `published=true`. With the event-driven recompute running up to once a minute over every oblast
-- under a nationwide wave, that is thousands of unread rows an hour in two tables that are never
-- pruned.
--
-- The pass now extends the row that is still saying the right thing instead of duplicating it, and
-- `extended_at` is how an operator can tell the difference between «this assessment is five minutes
-- old» and «this assessment was stated at 03:14, has been re-confirmed since, and still stands».
-- Without the column the only visible trace of a re-confirmation would be an `expires_at` that no
-- longer matches `generated_at + 6 hours`, which reads as data corruption rather than as the design.
--
-- The extension is bounded in the service, not here, and the bounds are the safety argument:
-- a row is extended only while it is still live (an expired horizon is republished, never revived)
-- and only while `generated_at` is inside the six hours the row itself claims (past that the pass
-- states the assessment afresh with current wording and supersedes the old one normally). Nothing
-- about the claim changes on an extension — not the score, not the level, not the explanation, not
-- `generated_at` — so nothing becomes visible to a reader earlier than it already was and the
-- publication cutoff is untouched.
--
-- NULL means «never extended», which is what every existing row is. `ADD COLUMN` of a nullable
-- column without a default rewrites nothing and takes ACCESS EXCLUSIVE for the length of a catalogue
-- update.
--
-- ================================================================================================
-- Why the 15 s statement timeout is lifted, and why no index is added to risk_assessment_signals
-- ================================================================================================
--
-- `src/db/pool.ts` sends `statement_timeout = 15s` as a startup parameter, so it binds DDL too, and
-- `src/index.ts` awaits `migrate()` BEFORE `buildServer()` — a migration that times out is not a slow
-- deploy, it is a container that never reaches listen(), retried forever. `CREATE INDEX` over an
-- append-only table with no retention is exactly the statement whose duration is proportional to how
-- long the installation has been running, so it must not be bound by the timeout the application
-- chose for its own queries. This is the argument migration 022 makes, applied to an index build.
-- `lock_timeout` is the companion the lift makes necessary: `CREATE INDEX` takes SHARE on the table,
-- and failing fast on a lock is strictly better than hanging the boot on it.
--
-- `risk_assessment_signals.signal_id` is an un-indexed foreign key and it stays that way, on purpose.
-- Measured: deleting ONE `risk_signals` row costs 10.3 ms, essentially all of it the
-- `risk_assessment_signals_signal_id_fkey` trigger sequentially scanning 300 000 link rows. That
-- number is real but it is the cost of an operation nothing in `src/` performs — risk signals are
-- expired (`UPDATE … SET expires_at`), never deleted, precisely so the row stays auditable. An index
-- costs an entry on every link INSERT, which IS on the hot path, to make faster a DELETE that does
-- not happen. It is recorded here rather than added so that whoever eventually writes a retention
-- pass over these tables knows to create it in the same migration as the DELETE, and knows the price
-- of not doing so.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '10s';

-- ------------------------------------------------------------------------------------------------
-- 1. The trace a re-confirmed assessment leaves
-- ------------------------------------------------------------------------------------------------
ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS extended_at timestamptz;

COMMENT ON COLUMN risk_assessments.extended_at IS
  'When a risk pass last re-confirmed this published assessment without changing it: the signals still said the same thing, so expires_at and horizon_end were moved forward instead of a duplicate row being written. NULL means never extended. The claim itself — risk_score, risk_level, explanation, generated_at — is never touched by an extension, and an extension is refused once the row has expired or once generated_at falls outside the six hours the row claims to cover.';

-- ------------------------------------------------------------------------------------------------
-- 2. The one published assessment a group currently has
-- ------------------------------------------------------------------------------------------------
-- Partial on exactly the predicate the pass and the bot ask for. `risk_assessments_live_idx`
-- (migration 001) leads with the same two columns but indexes every generation ever made for the
-- pair, so answering «the current one» meant reading 776 heap blocks of superseded history. This one
-- holds only the rows that can still be an answer, ordered so the answer is the first entry.
CREATE INDEX IF NOT EXISTS risk_assessments_current_idx
  ON risk_assessments (location_id, threat_type, generated_at DESC)
  WHERE published AND superseded_by IS NULL;

-- ------------------------------------------------------------------------------------------------
-- 3. The published assessments a reader may currently see
-- ------------------------------------------------------------------------------------------------
-- `currentAssessments()` bounds by `expires_at > cutoff` with no location filter, so nothing in
-- migration 001's location-leading index can serve it and it fell back to a full scan on every
-- public request. Live published assessments are a few hundred rows against a table of hundreds of
-- thousands; the partial index is the difference between reading the live set and reading the year.
CREATE INDEX IF NOT EXISTS risk_assessments_published_window_idx
  ON risk_assessments (expires_at DESC)
  WHERE published;

-- ------------------------------------------------------------------------------------------------
-- 4. The signals a pass is allowed to score
-- ------------------------------------------------------------------------------------------------
-- `expires_at` leads because it is the selective predicate: live signals are a rounding error
-- against every signal ever ingested. `risk_signals_live_group_idx` (migration 003) leads with
-- `location_id` and stays — `src/services/attack-research.ts` filters by location and that index is
-- the right shape for it — but it forced this query into one index search per distinct location.
CREATE INDEX IF NOT EXISTS risk_signals_live_idx
  ON risk_signals (expires_at DESC, location_id, threat_type)
  WHERE location_id IS NOT NULL;
