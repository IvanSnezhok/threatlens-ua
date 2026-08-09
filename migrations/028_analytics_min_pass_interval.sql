-- ================================================================================================
-- The storm guard moves out of the compiler and into the operator's hands
-- ================================================================================================
--
-- What was reported
-- -----------------
-- «Для наживо режиму затримки мають бути мінімальні.» An operator running the map live set every
-- delay on the /ops runtime card to 0, pressed save, and got a refusal that named no field and no
-- bound. The refusal was correct — `analytics_debounce_ms` has carried a CHECK floor of 5000 since
-- migration 022 — but nothing on the card said so, and the floor itself was in the wrong place.
--
-- Why the debounce floor was 5 s, and why that reason no longer holds
-- ------------------------------------------------------------------
-- 022 argues the floor like this: a debounce shorter than a recompute pass turns `execute()`'s
-- re-arm into back-to-back passes over the pool the ingestion tick and every snapshot share, i.e.
-- one ops PUT becomes a self-inflicted denial of service. It then says, in the same comment, what
-- was actually true: «the independent `ANALYTICS_MIN_PASS_INTERVAL_MS` floor is the real guard; this
-- bound stops the operator from asking for something the guard would then have to refuse».
--
-- So the 5 s floor never protected the database. The minimum interval between two *completed* passes
-- did, and still does. The debounce floor only stopped the operator from asking a question whose
-- answer would have been «refused» — and it stopped them without saying which field, which is the
-- complaint. Removing the floor changes what the operator may ASK for; it does not change how often
-- a pass may actually run, because that is the interval's job and the interval is untouched by this
-- migration except in one respect: it stops being a compiled constant.
--
-- Why the interval becomes a column
-- ---------------------------------
-- The same argument migration 022 makes for the whole table, applied to the one number 022 left
-- behind. «Raise the debounce, the wave is saturating the recompute» is an operational judgement; so
-- is «this deployment is small, one pass every five seconds is affordable, I want the map's
-- аналітична оцінка to keep up with the alerts». The second judgement was unmakeable: sixty seconds
-- was compiled into `src/services/analytics-scheduler.ts` and the only way to change it was to edit
-- TypeScript and rebuild the image. An operational judgement that requires a rebuild is a judgement
-- that will not be made in time.
--
-- It is DB-owned rather than a new environment variable for the reason 022 already gives: .env holds
-- deployment decisions and kill switches that must keep working when the database does not
-- (`ANALYTICS_EVENT_DRIVEN_ENABLED` is exactly that and is unchanged above this column). Cadence is
-- not that; it is changed mid-attack by the person already looking at /ops.
--
-- The bounds on the new column, and what they are protecting
-- ---------------------------------------------------------
-- Floor 5000, not 0. This is the one number in the group that must not reach zero: at zero the
-- overlap guard is the *only* thing between a sustained event stream and a standing pair of
-- REFRESH MATERIALIZED VIEW CONCURRENTLY statements plus a full risk pass, on a pool of twelve, under
-- a 15 s statement_timeout — the failure 022 described and attributed to the debounce floor by
-- mistake. Five seconds is the smallest gap that still leaves a pass room to finish and be seen to
-- have finished; it is also the floor migration 022 chose for the debounce, moved to the field that
-- was doing the work. Ceiling 900000 = fifteen minutes = `ANALYTICS_RECOMPUTE_FLOOR_MS`: an interval
-- longer than the quiet-period floor would mean the floor's own pass is refused by the interval and
-- the analytics would have no cadence at all.
--
-- Default 60000, i.e. exactly what the compiled constant was. A migration must not silently change
-- what a running deployment does — the same reason 022 defaults `publication_mode` to `live`.
--
-- What is NOT changed
-- -------------------
-- `runtime_settings_delay_order CHECK (analytics_max_delay_ms >= analytics_debounce_ms)` stays
-- exactly as 022 wrote it and stays satisfiable: `analytics_max_delay_ms` keeps its own floor of
-- 5000, and 5000 >= 0, so a debounce of 0 is legal beside every legal maximum. The pair still has to
-- be checked together rather than field by field, which is why `saveRuntimeSettings()` re-checks it
-- inside the row lock and the ops route re-checks it against the STORED row rather than the patch.
--
-- Why no `SET LOCAL statement_timeout` here, unlike 022
-- ----------------------------------------------------
-- 022 lifted the 15 s session timeout because it rewrote whole tables. This file touches one table
-- with one row. `ADD COLUMN … NOT NULL DEFAULT <constant>` takes PostgreSQL's fast-default path (PG11+)
-- and rewrites nothing; the two CHECK swaps verify a single row. The ordinary application timeout is
-- ample, and leaving it in force is the safer default for a statement that takes ACCESS EXCLUSIVE on
-- a table every request reads.

-- ------------------------------------------------------------------------------------------------
-- 1. The debounce floor drops to zero
-- ------------------------------------------------------------------------------------------------
-- The constraint 022 wrote is an inline column CHECK, so PostgreSQL named it
-- `runtime_settings_analytics_debounce_ms_check`. DROP IF EXISTS + ADD is the idempotent shape: a
-- second run drops the constraint this file just created and recreates it identically.
ALTER TABLE runtime_settings DROP CONSTRAINT IF EXISTS runtime_settings_analytics_debounce_ms_check;
ALTER TABLE runtime_settings ADD CONSTRAINT runtime_settings_analytics_debounce_ms_check
  CHECK (analytics_debounce_ms BETWEEN 0 AND 600000);

COMMENT ON COLUMN runtime_settings.analytics_debounce_ms IS
  'Trailing-edge debounce: how long after the last relevant event a recompute waits. 0 means "recompute on the next event", which is what наживо режим asks for; it does NOT mean a pass per event, because analytics_min_pass_interval_ms still bounds completed passes. Ceiling 10 min because a recompute starved longer than the fifteen-minute floor is worse than that floor.';

-- ------------------------------------------------------------------------------------------------
-- 2. The interval that was compiled in becomes a column
-- ------------------------------------------------------------------------------------------------
ALTER TABLE runtime_settings
  ADD COLUMN IF NOT EXISTS analytics_min_pass_interval_ms integer NOT NULL DEFAULT 60000;

ALTER TABLE runtime_settings DROP CONSTRAINT IF EXISTS runtime_settings_analytics_min_pass_interval_check;
ALTER TABLE runtime_settings ADD CONSTRAINT runtime_settings_analytics_min_pass_interval_check
  CHECK (analytics_min_pass_interval_ms BETWEEN 5000 AND 900000);

COMMENT ON COLUMN runtime_settings.analytics_min_pass_interval_ms IS
  'Minimum wall-clock gap between two COMPLETED analytics passes, independent of the debounce. This is the storm guard: it, not the debounce floor, is what stops a sustained event stream from turning into back-to-back REFRESH MATERIALIZED VIEW CONCURRENTLY statements plus a full risk pass. A pass refused by it arms a retry at expiry rather than being dropped. Was ANALYTICS_MIN_PASS_INTERVAL_MS, compiled in at 60 s, until migration 028.';
