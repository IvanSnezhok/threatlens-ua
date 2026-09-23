-- ================================================================================================
-- 053 — the index debt of the hot read paths
-- ================================================================================================
--
-- Every index below serves a statement that runs on a timer or on every notification fan-out, and
-- every one of them currently runs without an index that can answer it. Nothing here changes what
-- any query MEANS: an index cannot make a predicate match a row it did not match before, so none of
-- the alert precedence, debounce or publication-cutoff rules is touched by this file.
--
-- Why the 15 s statement timeout is lifted for the length of this migration: `src/db/pool.ts` sends
-- `statement_timeout = 15s` as a startup parameter, so it binds DDL too, and `src/index.ts` awaits
-- `migrate()` BEFORE `buildServer()` — a migration that times out is not a slow deploy, it is a
-- container that never reaches listen(), retried forever. The builds below are proportional to how
-- long the installation has been running (`threat_events`, `notification_outbox`), which is exactly
-- the statement that must not be bound by the timeout the application chose for its own queries.
-- `lock_timeout` is the companion the lift makes necessary: `CREATE INDEX` takes SHARE on the table,
-- and failing fast on a lock is strictly better than hanging the boot on it. This is the argument
-- migration 036 makes, applied to six more index builds.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '10s';

-- ------------------------------------------------------------------------------------------------
-- 1. Name resolution: the alert path's one sequential scan
-- ------------------------------------------------------------------------------------------------
--
-- `LOCATION_MATCH_SQL` (`src/services/ingestion.ts`) is the statement `resolveLocationId` issues one
-- to four times per published location label, for every label in every snapshot, on every poll of
-- every alert adapter — the aerial mirror alone polls two feeds every four seconds. Its three
-- predicates are an EXACT normalised name, an EXACT normalised alias and a normalised-name PREFIX:
--
--     translate(lower(name_uk),$3,'') = $1
--     $1 = ANY(location_aliases_normalized(aliases,$3))
--     translate(lower(name_uk),$3,'') LIKE $2 || '%'
--
-- `locations` carries three indexes — `locations_official_code_uidx`, `locations_parent_idx`,
-- `locations_type_name_idx(type,name_uk)` — and not one of them can serve a predicate on a
-- TRANSFORMED column. So every call was a sequential scan of the whole catalogue: 31 000 KATOTTG
-- rows after migration 051, with `lower()` plus `translate()` evaluated per row and, on the alias
-- branch, an `unnest()` set-returning function called per row on top of that.
--
-- An OR-chain is all-or-nothing for the planner: it can only build a BitmapOr when EVERY branch is
-- indexable, so all three are given an index here or none of them would be used.
--
-- The `$3` fold characters are a compile-time constant in TypeScript (`APOSTROPHE_CHARACTERS` in
-- `src/services/ingestion.ts`) and the literal below is the SAME six characters in the same order:
-- U+0027 apostrophe, U+2018, U+2019, U+02BC, U+0060 grave, U+00B4 acute — the spellings the KATOTTG
-- workbook, the alert APIs and the Telegram channels each use for the apostrophe in Кам'янський.
-- They must stay identical: an index built on a different fold is an index the planner will silently
-- decline to use, which costs performance and nothing else, but is invisible without EXPLAIN.
--
-- ONE btree on the normalised name, and it carries `text_pattern_ops`. That opclass is required for
-- `LIKE 'prefix%'` under any collation other than C — only a pattern opclass orders text the way
-- LIKE needs — and it also contains `texteq`, so the equality predicate is served by the same
-- index. Measured on a 31 000-row catalogue: with both a default-opclass and a pattern-opclass
-- index present, the planner chose the PATTERN index for the equality branch as well and never
-- touched the other one, so the second index was 1.5 MB and an entry per catalogue import buying
-- nothing.

-- PL/pgSQL and not `LANGUAGE sql`, deliberately: a simple SQL function is a candidate for planner
-- inlining, and an inlined body is no longer the expression the index was built on, so the index
-- would stop matching. PL/pgSQL is never inlined, which makes the match between the query's function
-- call and the index's function call structural rather than a property of the planner's mood.
--
-- The second argument is the fold set rather than a constant inside the body, so the ONE definition
-- of «which characters are an apostrophe» stays in TypeScript and is passed to both the query and
-- (as the literal above) to the index.
CREATE OR REPLACE FUNCTION location_aliases_normalized(aliases text[], fold text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
BEGIN
  RETURN ARRAY(SELECT translate(lower(alias), fold, '') FROM unnest(aliases) AS alias
                WHERE alias IS NOT NULL);
END;
$$;

COMMENT ON FUNCTION location_aliases_normalized(text[], text) IS
  'The aliases of a location, case-folded and stripped of every apostrophe spelling, as the array the alert-name resolver tests for containment. Exists so that predicate can be served by a GIN index; the fold set is passed in so it has exactly one definition, APOSTROPHE_CHARACTERS in src/services/ingestion.ts.';

CREATE INDEX IF NOT EXISTS locations_name_normalized_pattern_idx
  ON locations ((translate(lower(name_uk), '''‘’ʼ`´', '')) text_pattern_ops);

CREATE INDEX IF NOT EXISTS locations_aliases_normalized_gin
  ON locations USING gin ((location_aliases_normalized(aliases, '''‘’ʼ`´')));

-- ------------------------------------------------------------------------------------------------
-- 2. The alert aggregate reads EVERY source row for a pair, not only the holding ones
-- ------------------------------------------------------------------------------------------------
--
-- `reconcileAggregateAlert` (`src/services/ingestion.ts`) selects
-- `FROM alert_source_states a JOIN sources s … WHERE a.location_id=$1 AND a.alert_type=$2` and its
-- whole job is to weigh the rows that are NOT holding against the rows that are: a row that is
-- inactive with a `missing_since` inside the debounce still votes, and a row discounted for
-- staleness is counted into `ignored_stale`. It therefore needs every row for the pair.
--
-- All three existing indexes on the table are partial — `alert_source_states_active_idx`
-- (WHERE active=true), `alert_source_states_missing_idx` (WHERE missing_since IS NOT NULL),
-- `alert_source_states_active_started_idx` (WHERE active=true) — and a partial index cannot answer a
-- query that must see the rows outside its predicate. The aggregate consequently ran on a sequential
-- scan, once per (location, alert_type) pair touched by a snapshot, inside the snapshot transaction.
CREATE INDEX IF NOT EXISTS alert_source_states_pair_idx
  ON alert_source_states (location_id, alert_type);

-- ------------------------------------------------------------------------------------------------
-- 3. The notification fan-out asks «who is subscribed to this location»
-- ------------------------------------------------------------------------------------------------
--
-- `src/bot/outbox.ts` filters subscribers with `EXISTS (… WHERE r.id = s.location_id)` against the
-- related-location CTE, three times over. `subscriptions` is indexed on `(chat_id, enabled)` only,
-- which serves «what does this chat subscribe to» and cannot serve the inverse direction the fan-out
-- actually asks. Every alert start, alert end and published assessment therefore scanned the whole
-- subscription table.
--
-- Partial on `enabled` because a disabled subscription is never a fan-out candidate: the index then
-- holds only the rows the query can use, and an unsubscribe removes the entry instead of leaving
-- dead weight behind.
CREATE INDEX IF NOT EXISTS subscriptions_location_enabled_idx
  ON subscriptions (location_id) WHERE enabled;

-- ------------------------------------------------------------------------------------------------
-- 4. `/api/v1/history` orders by a column with no index
-- ------------------------------------------------------------------------------------------------
--
-- `src/repositories/events.ts` ends the history query with `ORDER BY e.started_at DESC LIMIT $2`.
-- `threat_events` has `threat_events_live_idx(status, last_observed_at DESC)` and
-- `threat_events_recent_idx(updated_at DESC)` — two other timestamps, neither of them this one — so
-- the ordering was a sort of the whole matching set to return a page of it. The cost grows with the
-- archive, which is the one thing about this table that only ever increases.
CREATE INDEX IF NOT EXISTS threat_events_started_idx
  ON threat_events (started_at DESC);

-- ------------------------------------------------------------------------------------------------
-- 5. The terminal end of the outbox — DELIBERATELY NOT INDEXED HERE
-- ------------------------------------------------------------------------------------------------
--
-- A partial index on `notification_outbox(created_at) WHERE status IN ('sent','failed','coalesced')`
-- belongs with a retention pass over finished notifications, and that pass is NOT in this change.
-- `notification_deliveries.outbox_id` references this table with no `ON DELETE` clause, i.e. with
-- the default RESTRICT: deleting a finished outbox row means deleting the delivery audit row that
-- proves what was sent and when, which is a retention DECISION about the audit trail and belongs to
-- the owner, not to an index migration. An index with no query behind it is not free — it is an
-- entry written on every outbox INSERT, i.e. on every notification to every subscriber — so it
-- arrives with the pass that reads it or it does not arrive at all.
