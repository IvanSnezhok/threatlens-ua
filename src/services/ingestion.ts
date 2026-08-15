import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Counter, Gauge, type Histogram, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { parseAlertChannelMessage } from '../domain/alert-parser.js';
import { classifyMessage, CLASSIFIER_VERSION, isDeEscalation, significanceRejection } from '../domain/classifier.js';
import {
  applyDeEscalation, cachedLocationLexemes, ingestThreat, recordClassification,
  type ClassificationDecision, type ClassificationLogEntry
} from '../repositories/events.js';
import {
  AERIAL_MIRROR_SOURCE_ID, AERIAL_MIRROR_USER_AGENT, aerialMirrorRawUrl, parseAerialMirrorPayload,
  parseAerialMirrorRawPayload, toAlarmSnapshotBody,
  type AerialMirrorRawSnapshot, type AerialMirrorSnapshot
} from '../sources/aerial-mirror.js';
import type { NormalizedMessage } from '../types.js';
import { alertPokeMetrics, pokeAlertStarted } from './alert-poke.js';
import { legSchedulerMetrics, startLegScheduler, type SchedulerLeg } from './leg-scheduler.js';
import { markSourceError, markSourceSuccess } from './operations.js';
// One-way import, on purpose: the observations are ops instrumentation and this file stays free of
// ops code by calling four named functions rather than by growing a second metrics block.
import {
  countChannelError, observeAlertPropagation, observeClassificationDuration, observeIngestionLag,
  observeSourceCacheAge
} from './publication.js';
import { retrospectiveGate, retrospectiveGateMetrics } from './retrospective-gate.js';
import { scheduleShadowClassification, shadowClassifierMetrics } from './shadow-classifier.js';

interface AlarmRecord {
  externalId: string;
  locationKey: string;
  locationName: string;
  alertType: string;
  active: boolean;
  startedAt: Date;
}

const alarmTypeMap: Record<string, string> = {
  AIR: 'air_raid', AIR_RAID: 'air_raid', ARTILLERY: 'artillery',
  URBAN_FIGHTS: 'urban_fighting', CHEMICAL: 'chemical', NUCLEAR: 'nuclear'
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validDate(value: unknown, fallback = new Date()): Date {
  const date = value ? new Date(String(value)) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export function normalizeAlarmResponse(body: unknown): { records: AlarmRecord[]; candidateCount: number } {
  const root = asObject(body);
  const rows = Array.isArray(body) ? body
    : Array.isArray(root?.states) ? root.states
      : Array.isArray(root?.alerts) ? root.alerts
        : Array.isArray(root?.data) ? root.data : [];
  const records: AlarmRecord[] = [];
  let candidateCount = 0;
  rows.forEach((raw, regionIndex) => {
    const region = asObject(raw);
    if (!region) return;
    const nested = [region.activeAlerts, region.active_alerts, region.alarms, region.alerts]
      .find(Array.isArray) as unknown[] | undefined;
    const alertRows = nested ?? [region];
    alertRows.forEach((alertRaw, alertIndex) => {
      const alert = asObject(alertRaw);
      if (!alert) return;
      candidateCount += 1;
      const locationKey = String(alert.locationId ?? alert.regionId ?? alert.region_id
        ?? region.locationId ?? region.regionId ?? region.region_id ?? region.id ?? '');
      const locationName = String(alert.locationName ?? alert.regionName ?? alert.region_name
        ?? region.locationName ?? region.regionName ?? region.region_name ?? region.name ?? '');
      if (!locationKey && !locationName) return;
      const rawType = String(alert.alertType ?? alert.type ?? alert.alert_type ?? 'AIR').toUpperCase();
      const status = String(alert.status ?? region.status ?? '').toLowerCase();
      const activeValue = alert.active ?? alert.isActive ?? alert.is_active ?? region.active ?? region.isActive;
      const active = typeof activeValue === 'boolean' ? activeValue : nested ? true : ['active','ongoing','true','1'].includes(status);
      const startedAt = validDate(alert.startedAt ?? alert.started_at ?? alert.start ?? alert.lastUpdate
        ?? region.startedAt ?? region.started_at ?? region.lastUpdate);
      records.push({
        externalId: String(alert.id ?? `${locationKey || locationName}-${rawType}-${startedAt.toISOString()}-${regionIndex}-${alertIndex}`),
        locationKey,
        locationName,
        alertType: alarmTypeMap[rawType] ?? rawType.toLocaleLowerCase(),
        active,
        startedAt
      });
    });
  });
  return { records, candidateCount };
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface LocationCandidate {
  id: string;
  type: string;
  match_rank: number;
}

// Exact name and alias hits outrank prefix hits; an ambiguous tier is rejected instead of
// silently returning an arbitrary region.
export function pickLocationMatch(candidates: LocationCandidate[]): string | null {
  for (const rank of [0, 1, 2]) {
    const tier = candidates.filter((candidate) => Number(candidate.match_rank) === rank);
    if (!tier.length) continue;
    if (rank === 2) return tier.length === 1 ? tier[0]!.id : null;
    const administrative = tier.filter((candidate) => candidate.type === 'oblast' || candidate.type === 'special_city');
    const preferred = administrative.length ? administrative : tier;
    return preferred.length === 1 ? preferred[0]!.id : null;
  }
  return null;
}

/**
 * Apostrophe characters folded away on both sides of a name comparison.
 *
 * Ukrainian raion and hromada names carry an apostrophe — Кам'янський, Куп'янський, Слов'янський —
 * and the character used for it differs between the KATOTTG workbook, the alert APIs and the
 * Telegram channel, which prints U+2019. Passed as a bind parameter to `translate()` rather than
 * concatenated into the statement.
 */
const APOSTROPHE_CHARACTERS = "'‘’ʼ`´";

const LOCATION_MATCH_SQL = `SELECT id,type,
     CASE WHEN translate(lower(name_uk),$3,'')=$1 THEN 0
          WHEN EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE translate(lower(alias),$3,'')=$1) THEN 1
          ELSE 2 END AS match_rank
   FROM locations
   WHERE translate(lower(name_uk),$3,'')=$1
      OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE translate(lower(alias),$3,'')=$1)
      OR translate(lower(name_uk),$3,'') LIKE $2||'%' ESCAPE E'\\\\'
   LIMIT 50`;

/**
 * Progressively narrower spellings to try for one published location name.
 *
 * The alert channel publishes a city and the hromada around it as a single label —
 * "м. Харків та Харківська територіальна громада" — which matches nothing in the catalogue. The
 * full label is still tried first: if the catalogue ever gains that exact hromada row it wins, and
 * only then does the query fall back to the city inside it. This is a narrowing, not a guess; the
 * refusal-on-ambiguity rule still applies to every candidate individually.
 */
export function locationNameCandidates(raw: string): string[] {
  const base = raw.replace(/\s+/gu, ' ').trim().replace(/[.,;:!?]+$/u, '').trim();
  const candidates: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  push(base);
  const compound = /^(.+?)\s+та\s+.+територіальн[а-яіїєґ]*\s+громад[а-яіїєґ]*$/iu.exec(base);
  if (compound) push(compound[1]!);
  return candidates;
}

function normalizeForCatalogue(name: string): string {
  return name.toLocaleLowerCase('uk-UA')
    .replace(/['‘’ʼ`´]/gu, '')
    .replace(/^(м\.|місто|обл\.|область)\s*/u, '').replace(/\s+(обл\.|область)$/u, '').trim();
}

/**
 * The normalized spellings to try for one candidate, most literal first.
 *
 * `normalizeForCatalogue` strips the «область» affix, which is what lets «Київська обл.» find
 * «Київська область». Stripping it *before* the query is also how three oblasts used to resolve to
 * the wrong row: the catalogue gives the occupied oblast capitals their declined forms as aliases —
 * `донецька` on Донецьк, `луганська` on Луганськ, `івано-франківська` on Івано-Франківськ — and once
 * «Донецька область» has been cut down to `донецька` that alias is an EXACT hit at rank 1, while the
 * oblast it actually names is only a rank 2 prefix hit. `pickLocationMatch` prefers the better rank,
 * as it should, and answered Донецьк. Донеччина and Луганщина are under alert almost permanently, so
 * this was not a rare edge: it was two of the loudest rows in every snapshot landing on a city.
 *
 * The fix is to ask the literal question first. The unstripped spelling matches the oblast's own
 * `name_uk` at rank 0 and wins outright; only when nothing matches it does the stripped form run and
 * behave exactly as it did before. Names with no affix to strip — every raion the alert channel
 * publishes — produce one form, so the extra query is paid only where the two spellings differ.
 */
function catalogueLookupForms(candidate: string): string[] {
  const literal = candidate.toLocaleLowerCase('uk-UA').replace(/['‘’ʼ`´]/gu, '').trim();
  return [...new Set([literal, normalizeForCatalogue(candidate)])].filter(Boolean);
}

export interface LocationQuery {
  locationKey?: string;
  locationName: string;
}

async function resolveLocationId(query: LocationQuery): Promise<string | null> {
  if (query.locationKey) {
    const byCode = await pool.query<{ id: string }>(
      `SELECT id FROM locations WHERE id=$1 OR official_code=$1 LIMIT 1`, [query.locationKey]
    );
    if (byCode.rowCount) return byCode.rows[0]!.id;
  }
  if (!query.locationName) return null;
  for (const candidate of locationNameCandidates(query.locationName)) {
    for (const normalized of catalogueLookupForms(candidate)) {
      const rows = await pool.query<LocationCandidate>(
        LOCATION_MATCH_SQL, [normalized, escapeLikePattern(normalized), APOSTROPHE_CHARACTERS]
      );
      const matched = pickLocationMatch(rows.rows);
      if (matched) return matched;
    }
  }
  return null;
}

export interface UnresolvedLocationReport {
  sourceId: string;
  count: number;
  samples: string[];
  observedAt: string;
}

const unresolvedLocationState = new Map<string, UnresolvedLocationReport>();

export function unresolvedLocationReports(): UnresolvedLocationReport[] {
  return [...unresolvedLocationState.values()];
}

// Unmapped provider locations are a catalogue gap, not a source outage: they are counted and
// logged, but never reported through markSourceError.
function recordUnresolvedLocations(sourceId: string, unresolved: string[], log?: { warn: Function }): void {
  const samples = [...new Set(unresolved)].sort().slice(0, 20);
  const previous = unresolvedLocationState.get(sourceId);
  unresolvedLocationState.set(sourceId, {
    sourceId, count: unresolved.length, samples, observedAt: new Date().toISOString()
  });
  if (!unresolved.length || previous?.samples.join('|') === samples.join('|')) return;
  log?.warn({ sourceId, unresolvedCount: unresolved.length, unresolvedLocations: samples },
    'provider locations could not be mapped to the local location catalogue');
}

/**
 * Recomputes the global alert period for one (location, alert type) from every source state.
 *
 * Shared by both reconciliation paths — the polled snapshot adapters and the event-driven alert
 * channel — so the two-source rule has exactly one implementation. Must run inside a transaction
 * that has already written the source state it is meant to observe.
 */
/**
 * One `alert.started` row, as its writer saw it — the two instants the propagation metric is the
 * difference between.
 *
 * Reported rather than observed in place because both are true only after the COMMIT: a metric
 * recorded inside the transaction would count an alert that was rolled back, and a poke raised
 * inside it would send the hub to read a row it cannot see yet.
 */
export interface AlertStartRecord {
  alertId: string;
  locationId: string;
  /**
   * `min(provider_started_at)` over the source rows that hold this alert — i.e. the moment the
   * UPSTREAM says the alert began, which for the mirror is the `changed`/`lastUpdate` stamp its
   * payload carries and for an alert channel is the Telegram publication time. `null` when no source
   * offered one and the period was stamped `now()`; there is then nothing to measure.
   */
  upstreamStartedAt: Date | null;
  /** `system_event_log.created_at` of the row just appended — our publication instant. */
  publishedAt: Date;
}

async function reconcileAggregateAlert(
  client: PoolClient, locationId: string, alertType: string, sourceId: string
): Promise<AlertStartRecord | null> {
  // A source still holds the alert while it reports it, and for ALERT_END_DEBOUNCE_SECONDS after
  // it stops: one missed poll must never produce an "Офіційний відбій". The two-source rule is
  // unchanged — bool_or still means "no configured source holds it any more".
  //
  // The debounce is keyed on `missing_since`, which only the snapshot path ever sets. A source that
  // publishes an explicit all-clear leaves it NULL, so its rows drop out of the aggregate the moment
  // the all-clear lands: the window is for sources that go quiet, not for sources that speak.
  // ## Why a source also has to be ALIVE to hold an alert
  //
  // The debounce above is one half of a pair and, until 2026-08-12, the only half that existed. It
  // answers "a source went quiet for a moment" — hold the alert, one missed poll must not clear the
  // map. What nothing answered was the mirror image: how long may a source hold an alert while
  // showing no sign of life at all?
  //
  // On 2026-08-12 the MTProto collector stopped receiving updates while remaining subscribed and
  // connected. Its `alert_source_states` row for Kyiv stayed `active=true`, frozen at 09:53 UTC. The
  // HTTP mirror — an independent source polling the same executive-authority state — cleared Kyiv at
  // 11:33 UTC, correctly and on time. The map still showed an alert at 16:23, because `bool_or`
  // weighs a row nobody has touched in five hours exactly as heavily as one written a minute ago.
  //
  // So liveness is now a condition of holding. `sources.last_success_at` is the signal, and it is
  // usable for this ONLY because the collector heartbeat stopped lying in the same change: it used
  // to advance every minute on a timer regardless of whether anything was arriving, which made this
  // column true by construction. See `TELEGRAM_SILENCE_ALERT_SECONDS` in `src/sources/telegram.ts`.
  //
  // NOT `alert_source_states.last_seen_at`, which would look like the obvious choice and is a trap:
  // for an event-driven channel that column only moves when a message about THIS location arrives,
  // so a genuine hours-long alert nobody has posted about since it began carries a stale value.
  // Expiring on it would manufacture false all-clears on exactly the alerts that matter most.
  //
  // ## The condition that makes this safe: `any_alive`
  //
  // A dead row is discounted ONLY while some other source for the same location is alive. When
  // every source has fallen silent — a database outage, a network partition, the whole process
  // restarting, a test harness that resets `last_success_at` — the rule switches off entirely and
  // the aggregate falls back to what it always was.
  //
  // This is not caution for its own sake. The first version of this change omitted the condition,
  // and the existing alert suite answered immediately: twenty-one of twenty-six tests went red,
  // every one of them because `resetDatabase` nulls `last_success_at` and so every source looked
  // dead at once. That is the shape of the real failure too. Without `any_alive`, "we have lost
  // contact with everything" and "everyone has published an all-clear" become the same state, and
  // the map would clear itself during precisely the outage in which nobody can correct it — a
  // false "Офіційний відбій", which `CONTEXT.md` treats as the unrecoverable failure.
  //
  // With it, the rule says something much narrower and much more defensible: a source that is
  // demonstrably dead may not outvote a source that is demonstrably alive. Losing everything
  // changes nothing, which is the correct behaviour when the honest answer is "we do not know".
  //
  // `ALERT_SOURCE_LIVENESS_SECONDS` defaults to an hour — sixty times the collector heartbeat and
  // twice its own silence guard — so "dead" means comprehensively dead rather than briefly late,
  // and every discounted row increments a counter so the trade is visible rather than silent.
  // ## The API decides. Channels are the fallback, and only when there is no API at all
  //
  // An air-raid alert and its all-clear are declared from an API whenever one is reachable. A
  // Telegram channel may declare them only while EVERY alert API is unreachable.
  //
  // The two kinds of source differ in a way that decides this. An API serves a snapshot: "here is
  // the complete picture right now", a claim the next poll re-states, corrects or contradicts. A
  // channel publishes events: "an alert started in X", once, and if that sentence is missed, arrives
  // out of order, or is written in a shape the parser does not know, nothing afterwards contradicts
  // it. A missed snapshot is self-healing. A missed event is a state that stays wrong until somebody
  // notices — which is exactly what happened on 2026-08-12, when a frozen channel row held Kyiv
  // under alert for six hours while the HTTP mirror had correctly cleared it at 11:33 UTC.
  //
  // `api_available` is deliberately GLOBAL rather than per-location, and that is the whole mechanism.
  // A snapshot source that is alive and does not mention this location is not silent about it — it is
  // saying there is no alert here. Scoping the check to rows that exist for this location would
  // invert that: the moment an API cleared a location its row would go quiet, the location would
  // look API-less, and the channels would take over and re-raise what the API had just ended.
  //
  // ## What this gives up
  //
  // A channel that is right while every API is wrong can no longer correct them. That is a real
  // loss and it is the owner's explicit decision, made after watching the opposite failure: the
  // channel path is the one that can freeze undetected, and on this deployment it did.
  //
  // Note what "available" costs to satisfy: one alert API, enabled, with a success inside
  // `ALERT_SOURCE_LIVENESS_SECONDS`. If every API is down, dead or switched off, the channels take
  // over automatically and the rule below is the same one that ran before this change.
  const aggregate = await client.query<{
    active: boolean; started_at: Date | null;
    ignored_precedence: number; ignored_stale: number; api_available: boolean;
  }>(
    `WITH api AS (
       SELECT EXISTS (
         SELECT 1 FROM sources
          WHERE adapter_type = ANY($5::text[]) AND enabled
            AND last_success_at > now()-($4::int * interval '1 second')
       ) AS available
     )
     SELECT bool_or(counts AND holds) AS active,
            min(provider_started_at) FILTER (WHERE counts AND holds) AS started_at,
            -- Two different reasons a row was not allowed to hold, kept apart because they mean
            -- opposite things to whoever reads the metric: precedence is the rule working as
            -- designed and is expected whenever a channel and an API disagree, while stale means a
            -- source has gone dead and is the signal that something needs fixing.
            count(*) FILTER (WHERE NOT counts AND would_hold)::int AS ignored_precedence,
            count(*) FILTER (WHERE counts AND would_hold AND NOT holds)::int AS ignored_stale,
            bool_or(api_available) AS api_available
     FROM (
       SELECT would_hold, provider_started_at, api_available,
              -- Which rows are allowed a vote at all: API rows when an API is reachable, every row
              -- otherwise. A row that is not counted cannot hold the alert and cannot end it.
              CASE WHEN api_available THEN is_api ELSE true END AS counts,
              -- Liveness still applies inside whichever set is voting: a dead row may not outvote a
              -- live one, and when nothing is alive the aggregate keeps what it had.
              CASE WHEN bool_or(alive) FILTER (WHERE CASE WHEN api_available THEN is_api ELSE true END)
                        OVER () THEN would_hold AND alive ELSE would_hold END AS holds
       FROM (
         SELECT a.active OR COALESCE(a.missing_since > now()-($3::int * interval '1 second'),false)
                  AS would_hold,
                COALESCE(s.last_success_at > now()-($4::int * interval '1 second'),false) AS alive,
                s.adapter_type = ANY($5::text[]) AS is_api,
                a.provider_started_at,
                (SELECT available FROM api) AS api_available
         FROM alert_source_states a JOIN sources s ON s.id=a.source_id
         WHERE a.location_id=$1 AND a.alert_type=$2
       ) row_state
     ) source_state`,
    [locationId, alertType, config.ALERT_END_DEBOUNCE_SECONDS, config.ALERT_SOURCE_LIVENESS_SECONDS,
      [...ALERT_API_ADAPTER_TYPES]]
  );
  const row = aggregate.rows[0];
  const ignoredStale = row?.ignored_stale ?? 0;
  const ignoredPrecedence = row?.ignored_precedence ?? 0;
  if (ignoredStale > 0) alertStaleSourcesIgnored.inc({ location: locationId, reason: 'stale' }, ignoredStale);
  if (ignoredPrecedence > 0) {
    alertStaleSourcesIgnored.inc({ location: locationId, reason: 'api_precedence' }, ignoredPrecedence);
  }
  const global = await client.query<{ id: string }>(
    `SELECT id FROM alert_periods WHERE location_id=$1 AND alert_type=$2 AND status='active' FOR UPDATE`,
    [locationId, alertType]
  );
  if (aggregate.rows[0]?.active && !global.rowCount) {
    // `alert_periods` is unique on (location_id, alert_type, started_at). A provider that really
    // did end an alert and then re-lists it with the identical start timestamp used to collide
    // here and roll back the entire snapshot — every other location in the same poll included.
    // The conflict reopens that period instead: the alert is visible on the map either way, so
    // the unique index can never hide an active alert or discard a snapshot. Nothing is returned
    // only when the period is already active, which happens when the two adapters reconcile the
    // same location concurrently; the transaction that reopened it emits the event.
    //
    // `published_at` is refreshed here and nowhere else on this branch — but ONLY when the period
    // had genuinely stopped being public first. A period whose `ended_at` is younger than the
    // longest possible hold was still being served a millisecond ago by branch 2 of
    // `activeAlerts()` (`status='ended' AND published_at <= cutoff AND ended_at > cutoff`), so
    // stamping a fresh `published_at` on it satisfies NEITHER branch — the row is `'active'` with a
    // `published_at` newer than the cutoff — and the red oblast polygon disappears from the public
    // map for the rest of the hold. That is a retraction of an already-published official alert
    // caused by nothing but a provider flap, and `docs/ARCHITECTURE.md` §Consistency rules calls
    // that direction unrecoverable.
    //
    // Keeping the old value in that case cannot publish anything early: the row was already public
    // at that instant, which is exactly the condition being tested. A gap LONGER than the hold is a
    // genuinely new public fact — the all-clear had already been released — and still gets a fresh
    // timestamp, so a reopened alert can never look older than the cutoff it should be held behind.
    //
    // `config.PUBLICATION_DELAY_SECONDS` and not the mode in force: the bound is the widest window
    // in which `activeAlerts` could still have been serving the row, and in `live` mode the cutoff
    // is `now()` so `published_at <= cutoff` holds either way and the branch is unobservable.
    const created = await client.query<{ id: string }>(
      `INSERT INTO alert_periods(location_id,alert_type,status,started_at,external_id)
       VALUES ($1,$2,'active',COALESCE($3,now()),$4)
       ON CONFLICT (location_id,alert_type,started_at) DO UPDATE
         SET status='active',ended_at=NULL,updated_at=now(),
             published_at = CASE
               WHEN alert_periods.ended_at > now() - make_interval(secs => $5::int)
                 THEN alert_periods.published_at
               ELSE now() END
         WHERE alert_periods.status<>'active'
       RETURNING id`,
      [locationId, alertType, aggregate.rows[0].started_at, `aggregate:${locationId}:${alertType}:${Date.now()}`,
        config.PUBLICATION_DELAY_SECONDS]
    );
    if (created.rowCount) {
      // `RETURNING created_at` rather than a second read or a `Date.now()`: this column IS the
      // instant every downstream bound is measured from — the hub's head query, the publication
      // cutoff and `threatlens_sse_delivery_lag_seconds` all read it — so taking the propagation
      // metric from anything else would produce two numbers that do not compose.
      const logged = await client.query<{ created_at: Date }>(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('alert.started',$1) RETURNING created_at`,
        [JSON.stringify({ alertId: created.rows[0]!.id, locationId, sourceId })]
      );
      return {
        alertId: created.rows[0]!.id,
        locationId,
        upstreamStartedAt: aggregate.rows[0].started_at,
        publishedAt: logged.rows[0]!.created_at
      };
    }
  } else if (!aggregate.rows[0]?.active && global.rowCount) {
    const ended = await client.query<{ id: string }>(
      `UPDATE alert_periods SET status='ended',ended_at=now(),updated_at=now()
       WHERE id=ANY($1::uuid[]) RETURNING id`, [global.rows.map((row) => row.id)]
    );
    for (const row of ended.rows) {
      await client.query(`INSERT INTO system_event_log(event_type,payload) VALUES ('alert.ended',$1)`,
        [JSON.stringify({ alertId: row.id, locationId, sourceId })]);
    }
  }
  // Ends deliberately report nothing. They are not poked and not measured: the asymmetry — starts
  // fast, ends unhurried — is the product decision this whole path implements, and it is the same
  // direction `ALERT_END_DEBOUNCE_SECONDS` already takes. See `src/services/alert-poke.ts`.
  return null;
}

/**
 * What a committed reconcile pass owes the rest of the process: one metric per start, and at most
 * one poke for the batch.
 *
 * Both callers of `reconcileAggregateAlert` funnel through here so the "after COMMIT, never inside"
 * rule has one implementation rather than two that drift. Nothing here can throw into a caller that
 * has already committed: `observeAlertPropagation` is total, and `pokeAlertStarted` only arms a
 * timer.
 */
function announceAlertStarts(sourceId: string, started: readonly AlertStartRecord[]): void {
  if (!started.length) return;
  for (const record of started) {
    observeAlertPropagation(sourceId, record.publishedAt, record.upstreamStartedAt);
  }
  // ONE poke for the whole transaction, however many oblasts it raised. Bound 1 of the three in
  // `src/services/alert-poke.ts`.
  pokeAlertStarted();
}

/**
 * Folds provider rows that turned out to name the same catalogue row.
 *
 * `alert_source_states` is unique on `(source_id, location_id, alert_type)`, so duplicates were
 * never a correctness problem at rest — the upsert simply let the last write win. They became a
 * *meaning* problem when the aerial mirror moved to raion and hromada granularity, because the
 * catalogue is three-tier and folds a hromada into its raion: on one live poll «Чугуївський район»
 * and «Вовчанська територіальна громада» were both alight, and both are `katottg-ua63140…`. Last
 * write wins then makes `provider_started_at` depend on the order the upstream happened to list two
 * labels in, and the period's start time is what the timeline and the monthly analytics read.
 *
 * The fold is: a location holds if ANY row holding it says so, and it started at the EARLIEST start
 * among the rows that hold it. Both halves are the over-warning direction, which is the one this
 * project takes deliberately. When nothing holds, the earliest start still wins so an inactive row
 * carries a stable timestamp rather than a coin flip.
 *
 * Applies to every snapshot source, not only the mirror. The two APIs have never been observed to
 * emit two labels for one location, so for them this is a no-op that removes a latent nondeterminism.
 */
function dedupeResolvedRecords<T extends AlarmRecord & { locationId: string }>(records: T[]): T[] {
  const byLocation = new Map<string, T>();
  for (const record of records) {
    const key = `${record.locationId}:${record.alertType}`;
    const existing = byLocation.get(key);
    if (!existing) { byLocation.set(key, record); continue; }
    const winner = existing.active === record.active
      ? (record.startedAt < existing.startedAt ? record : existing)
      : (record.active ? record : existing);
    byLocation.set(key, {
      ...winner,
      active: existing.active || record.active,
      startedAt: winner.startedAt
    });
  }
  return [...byLocation.values()];
}

async function persistOfficialAlertSnapshot(sourceId: string, body: unknown): Promise<{ resolved: number; unresolved: string[] }> {
  const normalized = normalizeAlarmResponse(body);
  if (normalized.candidateCount > 0 && normalized.records.length === 0) {
    throw new Error(`${sourceId}: response contained alerts but none could be normalized`);
  }
  const resolved: Array<AlarmRecord & { locationId: string }> = [];
  const unresolved: string[] = [];
  for (const record of normalized.records) {
    const locationId = await resolveLocationId(
      { locationKey: record.locationKey, locationName: record.locationName }
    );
    if (locationId) resolved.push({ ...record, locationId });
    else unresolved.push(record.locationName || record.locationKey);
  }
  if (normalized.records.length > 0 && resolved.length === 0) {
    throw new Error(`${sourceId}: no provider locations matched local locations (${unresolved.slice(0, 5).join(', ')})`);
  }
  const deduped = dedupeResolvedRecords(resolved);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const affected = await client.query<{ location_id: string; alert_type: string }>(
      `SELECT location_id,alert_type FROM alert_source_states WHERE source_id=$1`, [sourceId]
    );
    const affectedKeys = new Set(affected.rows.map((row) => `${row.location_id}:${row.alert_type}`));
    // Everything this source held is provisionally missing. `missing_since` is stamped only on the
    // poll where a *holding* row goes quiet, so repeated absences never push the deadline forward,
    // and a row that was already inactive is not made to look freshly missing.
    await client.query(
      `UPDATE alert_source_states
         SET active=false,missing_since=CASE WHEN active THEN now() ELSE missing_since END,
             last_seen_at=now(),updated_at=now()
       WHERE source_id=$1`,
      [sourceId]
    );
    for (const record of deduped) {
      affectedKeys.add(`${record.locationId}:${record.alertType}`);
      await client.query(
        `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at,external_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (source_id,location_id,alert_type) DO UPDATE SET
           active=EXCLUDED.active,provider_started_at=EXCLUDED.provider_started_at,
           external_id=EXCLUDED.external_id,
           missing_since=CASE WHEN EXCLUDED.active THEN NULL ELSE alert_source_states.missing_since END,
           last_seen_at=now(),updated_at=now()`,
        [sourceId, record.locationId, record.alertType, record.active, record.startedAt, record.externalId]
      );
    }
    const started: AlertStartRecord[] = [];
    for (const key of affectedKeys) {
      const [locationId, alertType] = key.split(':');
      const record = await reconcileAggregateAlert(client, locationId!, alertType!, sourceId);
      if (record) started.push(record);
    }
    await client.query('COMMIT');
    announceAlertStarts(sourceId, started);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // Distinct catalogue rows written, not provider labels read: after the fold above those are no
  // longer the same number.
  return { resolved: deduped.length, unresolved };
}

export async function syncOfficialAlerts(log?: { warn: Function }): Promise<void> {
  if (!config.UKRAINE_ALARM_API_TOKEN) return;
  if (!await sourceCollectionEnabled('ukraine-alarm')) return;
  try {
    const response = await fetch(config.UKRAINE_ALARM_API_URL, {
      headers: { Authorization: config.UKRAINE_ALARM_API_TOKEN, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Ukraine Alarm API ${response.status}`);
    const snapshot = await persistOfficialAlertSnapshot('ukraine-alarm', await response.json());
    await markSourceSuccess('ukraine-alarm');
    recordUnresolvedLocations('ukraine-alarm', snapshot.unresolved, log);
  } catch (error) {
    await markSourceError('ukraine-alarm', error);
    countChannelError('ukraine-alarm', 'collect');
    throw error;
  }
}

export async function syncAlertsInUa(log?: { warn: Function }): Promise<void> {
  if (!config.ALERTS_IN_UA_TOKEN) return;
  if (!await sourceCollectionEnabled('alerts-in-ua')) return;
  try {
    const response = await fetch(config.ALERTS_IN_UA_URL, {
      headers: { Authorization: `Bearer ${config.ALERTS_IN_UA_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Alerts.in.ua API ${response.status}`);
    const snapshot = await persistOfficialAlertSnapshot('alerts-in-ua', await response.json());
    await markSourceSuccess('alerts-in-ua');
    recordUnresolvedLocations('alerts-in-ua', snapshot.unresolved, log);
  } catch (error) {
    await markSourceError('alerts-in-ua', error);
    countChannelError('alerts-in-ua', 'collect');
    throw error;
  }
}

/**
 * The community aerial-alert mirror — the one official-family snapshot source that needs no token.
 *
 * Structurally identical to the two adapters above: fetch, normalize, hand the whole national
 * picture to `persistOfficialAlertSnapshot`, let the aggregate decide. One thing is different, and
 * it is the reason this function exists rather than a third `config.*_URL` on the generic path.
 *
 * ## The mirror may not clear the map on the strength of a response we do not believe
 *
 * `persistOfficialAlertSnapshot` clears everything the source holds before re-raising what the
 * response reports. For an API that answers "here is the country, right now" that is correct. For a
 * third-party republication it is correct only while the republication is *live*, and a mirror has a
 * failure mode the APIs do not: it can keep answering 200 with a well-formed body long after the
 * process feeding it has stopped. Every region then reads `alertnow: false`, the snapshot is
 * structurally perfect, and running it would publish «Офіційний відбій» for the entire country
 * during an attack. That is the direction docs/ARCHITECTURE.md §Consistency rules calls
 * unrecoverable.
 *
 * `parseAerialMirrorPayload` is therefore called BEFORE anything is persisted and throws on a
 * `cachedat` older than `AERIAL_MIRROR_STALE_SECONDS`. The throw lands in the catch below, becomes
 * `markSourceError`, and `alert_source_states` is never opened — so a frozen mirror holds its alerts
 * instead of clearing them, and the operator sees an unhealthy source rather than a quiet map.
 *
 * The accepted cost of that choice, stated plainly because docs/OPERATIONS.md has to answer for it:
 * a mirror that freezes while holding alerts holds them until it recovers. There is no sweeper for
 * this source — `expireStuckAlertChannelAlerts` is scoped to `mtproto_alert_channel` rows — so an
 * over-warning map is the deliberate failure direction, and releasing a permanently dead mirror's
 * holds is a documented operator action.
 *
 * What this cannot catch: a mirror serving stale *alert state* under a fresh `cachedat`. Nothing in
 * the payload distinguishes that from a genuinely quiet country, and the debounce plus the two-source
 * aggregate are the only defences left. It is the strongest argument for not running the mirror as
 * the sole alert source.
 *
 * ## Two feeds, and the rule for choosing between them
 *
 * See `collectAerialMirrorSnapshot`. Nothing about the paragraphs above changes: whichever feed is
 * read, the result reaches `persistOfficialAlertSnapshot` only after a parser has accepted it, and
 * every refusal on every path is a throw into the catch below.
 */
export async function syncAerialMirror(log?: { warn: Function }): Promise<void> {
  if (!config.AERIAL_MIRROR_ENABLED) return;
  if (!await sourceCollectionEnabled(AERIAL_MIRROR_SOURCE_ID)) return;
  try {
    const snapshot = await collectAerialMirrorSnapshot(new Date(), log);
    const persisted = await persistOfficialAlertSnapshot(
      AERIAL_MIRROR_SOURCE_ID, toAlarmSnapshotBody(snapshot)
    );
    await markSourceSuccess(AERIAL_MIRROR_SOURCE_ID);
    recordUnresolvedLocations(AERIAL_MIRROR_SOURCE_ID, persisted.unresolved, log);
  } catch (error) {
    await markSourceError(AERIAL_MIRROR_SOURCE_ID, error);
    countChannelError(AERIAL_MIRROR_SOURCE_ID, 'collect');
    throw error;
  }
}

/** The database switch is checked immediately before a polled adapter touches its provider. */
async function sourceCollectionEnabled(sourceId: string): Promise<boolean> {
  const result = await pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM sources WHERE id=$1`, [sourceId]
  );
  return result.rows[0]?.enabled === true;
}

/** One GET against the mirror, with the identification header and the non-2xx rule. */
async function fetchAerialMirror(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': AERIAL_MIRROR_USER_AGENT },
    signal: AbortSignal.timeout(10_000)
  });
  // 429 included: the published limit is two requests per second per host and this leg's worst case
  // at its three-second floor is 0.67 rps, so a 429 means something else is sharing the egress IP —
  // a source error, not a reason to touch alert state.
  if (!response.ok) throw new Error(`Aerial alert mirror ${response.status}`);
  return response.json();
}

/**
 * Reads the mirror at the finest granularity it will give, and decides what to believe.
 *
 * The mirror serves two bodies. `?source=ual&raw` is Ukraine Alarm's own payload — `State`,
 * `District` and `Community` entries, which after resolution are oblasts, raions and (through the
 * catalogue's hromada aliases) raions again. The bare URL is the aggregator's `states` object, which
 * is twenty-five oblast rows and nothing finer. The raw feed is the primary; the aggregated one is
 * the fallback and, in one specific case, the witness.
 *
 * ## The quiet-versus-broken rule
 *
 * A raw payload that lists nothing alight is ambiguous in the worst possible way. It is what a
 * genuinely calm night looks like — and refusing it would put this source into `error` every time
 * the country was at peace, which is both wrong and would train an operator to ignore the health
 * card. It is ALSO what a half-broken upstream looks like: `cachedat` fresh, envelope intact, `raw`
 * empty because whatever fills it has stopped. Believed, that empty list clears every raion the
 * mirror was holding.
 *
 * Nothing inside the payload separates the two, so the rule reaches outside it: **when the raw feed
 * reports no air-raid region, ask the aggregated feed before believing it.**
 *
 *   - aggregated feed also reports nothing alight → the country is quiet. The empty raw snapshot is
 *     accepted and the mirror clears normally (through the end debounce, as always).
 *   - aggregated feed reports at least one oblast alight → the raw feed is not describing the
 *     present. Fall back to the aggregated body for this poll, at oblast granularity, under the same
 *     `source_id` — degraded resolution beats a wrong all-clear — and log it.
 *   - aggregated feed cannot be read either → **hold.** The throw escapes, `markSourceError` runs and
 *     `alert_source_states` is never opened. Two unreadable feeds are not evidence of peace.
 *
 * The same fallback carries a raw payload the parser REFUSED outright — stale, future, non-array,
 * unreadable entries. There the aggregated feed is a substitute rather than a witness, but the
 * ordering and the both-fail outcome are identical, so it is one path.
 *
 * ## Request budget
 *
 * The endpoint publishes two requests per second per host. The common case — the raw feed answers
 * and something is alight — is ONE request; the cross-check happens only when the raw feed found
 * nothing or was refused. The two requests are sequenced with `AERIAL_MIRROR_REQUEST_GAP_MS` between
 * them and are never issued together: during research two requests inside one second were answered
 * with a truncated body, which is the precise failure the parsers exist to refuse.
 *
 * Setting `AERIAL_MIRROR_RAW_SOURCE=''` skips the raw feed entirely and restores the original
 * oblast-only behaviour, one request per poll.
 */
async function collectAerialMirrorSnapshot(
  now: Date, log?: { warn: Function }
): Promise<AerialMirrorSnapshot> {
  const stale = config.AERIAL_MIRROR_STALE_SECONDS;
  const upstream = config.AERIAL_MIRROR_RAW_SOURCE.trim();
  // Вік того, що фід щойно віддав, — за його власним `cachedat`. Записується на КОЖНОМУ читанні, і
  // саме тому обидва тіла мають свою мітку: різниця між ними і є ціною деталізації. Виміряно на
  // ubilling.net.ua 15.08.2026: агрегований фід оновлюється за ~3 с, `?source=ual&raw` — рівно раз
  // на 121 с, тобто в середньому віддає стан хвилинної давності. Ця хвилина була найбільшим
  // доданком у затримці сповіщення й ніде не була видна.
  const record = <T extends AerialMirrorSnapshot>(feed: string, snapshot: T): T => {
    observeSourceCacheAge(AERIAL_MIRROR_SOURCE_ID, feed, snapshot.ageSeconds);
    return snapshot;
  };
  if (!upstream) {
    aerialMirrorPolls.inc({ mode: 'unified_only' });
    return record(
      'aggregated', parseAerialMirrorPayload(await fetchAerialMirror(config.AERIAL_MIRROR_URL), now, stale)
    );
  }

  let raw: AerialMirrorRawSnapshot | null = null;
  let reason = '';
  try {
    raw = record('raw', parseAerialMirrorRawPayload(
      await fetchAerialMirror(aerialMirrorRawUrl(config.AERIAL_MIRROR_URL, upstream)), now, stale
    ));
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (raw && raw.regions.length) {
    aerialMirrorPolls.inc({ mode: 'raw' });
    aerialMirrorRawRegions.set({ level: 'State' }, raw.byLevel.State);
    aerialMirrorRawRegions.set({ level: 'District' }, raw.byLevel.District);
    aerialMirrorRawRegions.set({ level: 'Community' }, raw.byLevel.Community);
    aerialMirrorRawRegions.set({ level: 'other' }, raw.byLevel.other);
    return raw;
  }

  // Second request, spaced. Anything it throws escapes this function on purpose: with the raw feed
  // already unusable, an unreadable aggregated feed leaves nothing that could justify writing.
  if (config.AERIAL_MIRROR_REQUEST_GAP_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.AERIAL_MIRROR_REQUEST_GAP_MS));
  }
  const unified = record('aggregated', parseAerialMirrorPayload(
    await fetchAerialMirror(config.AERIAL_MIRROR_URL), now, stale
  ));
  const unifiedActive = unified.regions.filter((region) => region.active).length;

  if (raw && !unifiedActive) {
    // Quiet, corroborated. The empty raw snapshot is the honest one to persist: it is what the
    // primary feed said, and the aggregated feed was consulted only as a witness.
    aerialMirrorPolls.inc({ mode: 'raw_quiet' });
    for (const level of ['State', 'District', 'Community', 'other'] as const) {
      aerialMirrorRawRegions.set({ level }, 0);
    }
    return raw;
  }

  if (raw) {
    reason = `raw feed reported no air-raid region while the aggregated feed reports ${unifiedActive}`
      + ` (${raw.entryCount} raw entries, ${raw.readableCount} readable, ${raw.nonAirRegions} non-air)`;
  }
  aerialMirrorPolls.inc({ mode: 'unified_fallback' });
  log?.warn(
    { sourceId: AERIAL_MIRROR_SOURCE_ID, upstream, reason, unifiedActive },
    'aerial mirror raw feed unusable, falling back to the aggregated oblast feed for this poll'
  );
  return unified;
}

// ------------------------------------------------------------------------------------------------
// Event-driven official alert sources: the Tier A alert Telegram channels
// ------------------------------------------------------------------------------------------------

/**
 * These are official Tier A sources that happen to publish over MTProto instead of HTTPS.
 * What they are *not* is snapshots: `persistOfficialAlertSnapshot` clears every state a source
 * holds before re-raising the reported ones, which is correct for an API that returns the complete
 * national picture on every poll and catastrophic for a channel that says "an alert started in one
 * raion" — every other raion would be cleared by the next message about a single oblast.
 *
 * So this path is per-location and additive: 🔴 raises exactly the rows it names, 🟢 lowers exactly
 * the rows it names, and every other row of the same source is left untouched.
 *
 * Every function below takes the source id from its caller. `alert_source_states` has always been
 * keyed on `(source_id, location_id, alert_type)` and `reconcileAggregateAlert` has always taken a
 * source id, so several administrations holding an alert over the same raion at the same time is
 * the storage model working as designed, not a special case: each one owns its own row, and the
 * aggregate is what the map shows.
 */

/** Adapter type of an alert channel: a channel whose messages may start and end alert periods. */
export const ALERT_CHANNEL_ADAPTER_TYPE = 'mtproto_alert_channel';

/**
 * Adapter types that read an air-raid API rather than somebody's prose.
 *
 * These decide whether a location is under alert. Telegram channels do not, unless every one of
 * these is unreachable — see {@link reconcileAggregateAlert} for the rule and for why it exists.
 *
 * `aerial_alerts_mirror` is in the list despite being a community republisher rather than an
 * authority of its own: what puts it here is the SHAPE of what it serves. It answers "here is the
 * complete national picture right now", which is a claim that can be checked, corrected and — most
 * importantly — falsified by the next poll. A channel post is an event with no such property: it
 * says what changed, once, and if the sentence is missed or misread nothing later contradicts it.
 * The distinction this list draws is snapshot versus event, not official versus unofficial.
 */
export const ALERT_API_ADAPTER_TYPES = ['alerts_in_ua', 'ukraine_alarm', 'aerial_alerts_mirror'] as const;

/**
 * The national channel https://t.me/air_alert_ua.
 *
 * Named because it is the row `config.ALERT_CHANNEL_USERNAME` falls back to when the registry cannot
 * be read, and because the operational documentation refers to it by id. It carries no privilege
 * over the other rows: it is read from the registry like all of them.
 */
export const ALERT_CHANNEL_SOURCE_ID = 'air-alert-ua';

/**
 * Which feed actually moved the mirror's alert state, per poll.
 *
 * The series an operator watches to know whether the granularity upgrade is live. `raw` is the
 * healthy steady state; a `unified_fallback` rate that stops being ~zero means the `ual` passthrough
 * is failing and the map has quietly gone back to oblast-only, which is a degradation nothing else
 * makes visible — the source stays `current` throughout, because falling back is the adapter working
 * as designed. `raw_quiet` separates "the country is calm and both feeds agree" from that.
 */
const aerialMirrorPolls = new Counter({
  name: 'threatlens_aerial_mirror_polls_total',
  help: 'Aerial mirror polls by which feed supplied the snapshot',
  labelNames: ['mode'],
  registers: []
});

/**
 * Regions the raw feed had alight at the last poll, by administrative level.
 *
 * A gauge and not a counter: it is a description of the present picture, and it is the number that
 * shows the upgrade doing what it exists for — `District` and `Community` above zero is granularity
 * the aggregated feed cannot express at all. Reset to zero on a corroborated quiet poll so a calm
 * night reads as calm rather than as the last wave, frozen.
 */
const aerialMirrorRawRegions = new Gauge({
  name: 'threatlens_aerial_mirror_raw_regions',
  help: 'Air-raid regions in the last usable raw aerial-mirror poll, by upstream region type',
  labelNames: ['level'],
  registers: []
});

const alertChannelMessages = new Counter({
  name: 'threatlens_alert_channel_messages_total',
  help: 'Messages read from the official alert Telegram channels, by source and parse outcome',
  labelNames: ['source', 'outcome'],
  registers: []
});
const alertChannelStuckAlerts = new Counter({
  name: 'threatlens_alert_channel_stuck_alerts_total',
  help: 'Alert-channel states force-cleared because no all-clear arrived within the maximum duration',
  labelNames: ['source'],
  registers: []
});
/**
 * Rows discounted from the alert aggregate because their source showed no sign of life.
 *
 * The visible price of the two precedence rules in `reconcileAggregateAlert`, split by `reason`
 * because the two readings are opposites.
 *
 * `stale` means a source is holding alerts while showing no sign of life — either the failure the
 * liveness rule exists to survive, or that rule misfiring on a source whose normal update interval
 * exceeds `ALERT_SOURCE_LIVENESS_SECONDS`. Both demand a look.
 *
 * `api_precedence` means a Telegram channel wanted to hold an alert that no API agreed with. That is
 * the rule working as designed, and a steady low rate is normal — channels lag and lead the APIs by
 * seconds all day. A sustained HIGH rate says something else: either the channels are seeing
 * something the APIs are not, or a channel is stuck, and the archive is where to look next.
 *
 * Neither number is visible anywhere else — without it the aggregate simply comes out different.
 */
const alertStaleSourcesIgnored = new Counter({
  name: 'threatlens_alert_stale_sources_ignored_total',
  help: 'Alert-holding source rows discounted from the aggregate, by why they were not counted',
  labelNames: ['location', 'reason'],
  registers: []
});
const monitorMessages = new Counter({
  name: 'threatlens_monitor_messages_total',
  help: 'Messages read from the OSINT monitoring channels, by classification outcome',
  labelNames: ['source', 'outcome'],
  registers: []
});
/**
 * Archive writes that were dropped so the pipeline could carry on.
 *
 * A non-zero value means the classification archive has holes and any count taken from it is a
 * lower bound. It is deliberately a separate signal from the ingestion error path: losing analytics
 * is not an outage, and must never be reported as one.
 */
const classificationLogFailures = new Counter({
  name: 'threatlens_classification_log_failures_total',
  help: 'Classification-archive writes that failed and were dropped without failing ingestion',
  labelNames: ['source'],
  registers: []
});
const threatWithdrawals = new Counter({
  name: 'threatlens_threat_withdrawals_total',
  help: 'Source assertion withdrawals, by outcome',
  labelNames: ['source', 'outcome'],
  registers: []
});
/**
 * Every archived decision, by the rule version that made it and what it decided.
 *
 * The version label is the point. `message_classifications` records it per row, but nothing exported
 * it, so "did the new rules change the mix of decisions" was a question that could only be answered
 * by querying the database after the fact. With this, a version bump shows up on the dashboard as
 * one series ending and another beginning, and the shapes can be compared directly.
 */
const classificationDecisions = new Counter({
  name: 'threatlens_classifications_total',
  help: 'Deterministic classifications archived, by classifier version and decision',
  labelNames: ['version', 'decision'],
  registers: []
});
/**
 * Why a message raised nothing, per source.
 *
 * The two reasons are different operational findings and must not be summed.
 * `no_threat_recognised` concentrated on one channel means its vocabulary has drifted away from the
 * rules; `no_location` concentrated on one channel means it names settlements the catalogue does not
 * hold. The first is fixed in `src/domain/classifier.ts`, the second in the location importer, and
 * before this counter existed the only way to tell them apart was to read the archive by hand.
 */
const classificationRejections = new Counter({
  name: 'threatlens_classification_rejections_total',
  help: 'Messages that raised nothing, by source and rejection reason',
  labelNames: ['source', 'reason'],
  registers: []
});
/**
 * How often the rules turn a live threat into no threat.
 *
 * The dangerous direction, and the one this project can least afford to get wrong: a wrong all-clear
 * is silent, and the reader who acts on it is the reader who is under the drone. `threat_withdrawals`
 * already counts withdrawal *outcomes*, including the ones that closed nothing; this counts only the
 * transitions that actually ended a live event, and carries the classifier version so that a rule
 * change which starts producing them is visible as a step in the series rather than as an incident
 * report weeks later.
 */
const threatToDeEscalation = new Counter({
  name: 'threatlens_threat_to_de_escalation_total',
  help: 'De-escalations that ended a live threat event, by source and classifier version',
  labelNames: ['source', 'version'],
  registers: []
});

/**
 * Attaches this module's metrics to a Prometheus registry, mirroring `registerOccupationMetrics`.
 * Nothing in `src/services` owns the HTTP registry, so the wiring lives wherever the registry is
 * created. The monitoring-channel counter rides along rather than adding a second call site, and so
 * do the shadow-classifier and retrospective-gate ones: both modules are reached only through this
 * one.
 */
export function registerAlertChannelMetrics(registry: Registry): void {
  const metrics: ReadonlyArray<[string, Counter<string> | Gauge<string> | Histogram<string>]> = [
    ['threatlens_aerial_mirror_polls_total', aerialMirrorPolls],
    ['threatlens_aerial_mirror_raw_regions', aerialMirrorRawRegions],
    ['threatlens_alert_channel_messages_total', alertChannelMessages],
    ['threatlens_alert_channel_stuck_alerts_total', alertChannelStuckAlerts],
    ['threatlens_alert_stale_sources_ignored_total', alertStaleSourcesIgnored],
    ['threatlens_monitor_messages_total', monitorMessages],
    ['threatlens_classification_log_failures_total', classificationLogFailures],
    ['threatlens_threat_withdrawals_total', threatWithdrawals],
    ['threatlens_classifications_total', classificationDecisions],
    ['threatlens_classification_rejections_total', classificationRejections],
    ['threatlens_threat_to_de_escalation_total', threatToDeEscalation],
    ...shadowClassifierMetrics(),
    ...retrospectiveGateMetrics(),
    // Same rule as the two above: both modules are reached only through this one, and a second call
    // site in `buildServer()` would be a second place to forget.
    ...legSchedulerMetrics(),
    ...alertPokeMetrics()
  ];
  for (const [name, metric] of metrics) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

export interface AlertChannelMessage {
  externalId: string;
  /** Telegram publication time. The clock printed inside the message is never used. */
  publishedAt: Date;
  editedAt?: Date | null;
  text: string;
  rawPayload?: Record<string, unknown>;
}

export interface AlertChannelIngestSummary {
  events: number;
  ignored: number;
  unrecognized: number;
  /** Source-state rows written. */
  applied: number;
  /** Rows left alone because a newer channel event had already been applied to them. */
  skippedStale: number;
  unresolved: string[];
}

interface AlertChannelState {
  locationId: string;
  alertType: string;
  active: boolean;
  observedAt: Date;
  externalId: string;
}

function compareExternalId(left: string, right: string): number {
  const a = Number(left); const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right);
}

/**
 * Keeps the raw message for provenance and for the edit trail.
 *
 * `UNIQUE (source_id, external_id, content_hash)` means a replayed message is a no-op while an
 * edited one lands as a second row against the same Telegram id — the revision history comes for
 * free, and an unrecognised format is recorded rather than only logged.
 */
async function recordAlertChannelMessage(
  sourceId: string, message: AlertChannelMessage, status: string
): Promise<void> {
  const hash = createHash('sha256').update(message.text).digest('hex');
  await pool.query(
    `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,
       content_hash,processing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_id,external_id,content_hash) DO NOTHING`,
    [sourceId, message.externalId, message.publishedAt, message.editedAt ?? null,
      message.text, JSON.stringify(message.rawPayload ?? {}), hash, status]
  );
}

async function applyAlertChannelStates(
  sourceId: string, states: AlertChannelState[]
): Promise<{ applied: number; skippedStale: number }> {
  if (!states.length) return { applied: 0, skippedStale: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    let skippedStale = 0;
    const started: AlertStartRecord[] = [];
    for (const state of states) {
      // The `WHERE` on the conflict branch is the ordering guard. Channel messages can arrive out of
      // order after a reconnect, and an all-clear from an hour ago must never overwrite an alert
      // declared five minutes ago; zero returned rows means exactly that and is not an error.
      //
      // `missing_since` is cleared on both branches. It is the marker the snapshot debounce reads,
      // and an explicit 🟢 is not a source going quiet — inheriting that window here would delay
      // every genuine all-clear this channel publishes.
      const upsert = await client.query<{ location_id: string }>(
        `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at,
           external_id,last_event_at,missing_since)
         VALUES ($1,$2,$3,$4,CASE WHEN $4 THEN $5::timestamptz ELSE NULL END,$6,$5,NULL)
         ON CONFLICT (source_id,location_id,alert_type) DO UPDATE SET
           active=EXCLUDED.active,
           provider_started_at=CASE
             WHEN EXCLUDED.active AND alert_source_states.active THEN alert_source_states.provider_started_at
             WHEN EXCLUDED.active THEN EXCLUDED.provider_started_at
             ELSE alert_source_states.provider_started_at END,
           external_id=EXCLUDED.external_id,
           last_event_at=EXCLUDED.last_event_at,
           missing_since=NULL,
           last_seen_at=now(),updated_at=now()
         WHERE alert_source_states.last_event_at IS NULL
            OR alert_source_states.last_event_at <= EXCLUDED.last_event_at
         RETURNING location_id`,
        [sourceId, state.locationId, state.alertType, state.active,
          state.observedAt, state.externalId]
      );
      if (!upsert.rowCount) { skippedStale += 1; continue; }
      applied += 1;
      const record = await reconcileAggregateAlert(client, state.locationId, state.alertType, sourceId);
      if (record) started.push(record);
    }
    await client.query('COMMIT');
    // The channel path has no acquisition lag to remove — it is pushed to, not polled — but the two
    // one-second workers downstream are the same two, and a 🔴 arriving over MTProto pays them
    // exactly as a snapshot does. `provider_started_at` here is the Telegram publication time, so
    // the propagation metric measures the same thing under a different `source` label.
    announceAlertStarts(sourceId, started);
    return { applied, skippedStale };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Applies a batch of messages from one alert channel.
 *
 * The live collector passes one message; the reconnect backfill passes a bounded history window.
 * Both go through the same code because the batch is first **folded to one terminal state per
 * location** — the newest event wins — and only that state is written. Replaying a window therefore
 * converges on the situation as it stands right now instead of re-emitting an hours-old alert and
 * its all-clear as a fresh pair of notifications.
 *
 * `sourceId` is the registry row the messages came from, and it is the whole of what keeps two
 * administrations reporting the same raion apart. Passing the wrong one would attribute one
 * authority's all-clear to another and end an alert the other body never withdrew.
 */
export async function ingestAlertChannelMessages(
  sourceId: string, messages: AlertChannelMessage[], log?: { warn: Function }
): Promise<AlertChannelIngestSummary> {
  const summary: AlertChannelIngestSummary = {
    events: 0, ignored: 0, unrecognized: 0, applied: 0, skippedStale: 0, unresolved: []
  };
  if (!config.ALERT_CHANNEL_ENABLED || !messages.length) return summary;
  const ordered = [...messages].sort((left, right) =>
    left.publishedAt.getTime() - right.publishedAt.getTime()
    || compareExternalId(left.externalId, right.externalId));

  const desired = new Map<string, AlertChannelState>();
  const unresolved: string[] = [];
  for (const message of ordered) {
    // Measured from the channel's own timestamp, not from ours: the number an operator needs is
    // "how old was this when we accepted it", and our clock cannot answer that.
    observeIngestionLag(sourceId, (Date.now() - message.publishedAt.getTime()) / 1000);
    const startedAt = Date.now();
    try {
      const parsed = parseAlertChannelMessage(message.text, message.publishedAt);
      if (parsed.kind === 'unrecognized') {
        summary.unrecognized += 1;
        alertChannelMessages.inc({ source: sourceId, outcome: 'unrecognized' });
        countChannelError(sourceId, 'parse');
        await recordAlertChannelMessage(sourceId, message, 'unrecognized');
        // A channel that changes its wording must make this loud. Silently reporting no alerts is the
        // one outcome an alert source is never allowed to have. Ordinary channel prose does not reach
        // here — the parser files it as `ignored: 'unrelated'` — so this warning stays a signal on a
        // channel that publishes news between its alerts.
        log?.warn(
          { sourceId, externalId: message.externalId, headline: parsed.headline },
          'alert channel message matched no known format and was not applied'
        );
        continue;
      }
      if (parsed.kind === 'ignored') {
        summary.ignored += 1;
        alertChannelMessages.inc({ source: sourceId, outcome: `ignored:${parsed.reason}` });
        await recordAlertChannelMessage(sourceId, message, 'ignored');
        continue;
      }
      summary.events += 1;
      alertChannelMessages.inc({ source: sourceId, outcome: parsed.event.action });
      await recordAlertChannelMessage(sourceId, message, 'alert');
      for (const name of parsed.event.locationNames) {
        const locationId = await resolveLocationId({ locationName: name });
        if (!locationId) { unresolved.push(name); continue; }
        desired.set(`${locationId}:${parsed.event.alertType}`, {
          locationId,
          alertType: parsed.event.alertType,
          active: parsed.event.action === 'start',
          observedAt: parsed.event.observedAt,
          externalId: `${sourceId}:${message.externalId}`
        });
      }
    } finally {
      // In a `finally` because two of the three branches `continue`; a per-branch call would
      // silently stop measuring the day a fourth branch is added.
      observeClassificationDuration('alert', (Date.now() - startedAt) / 1000);
    }
  }

  const outcome = await applyAlertChannelStates(sourceId, [...desired.values()]);
  summary.applied = outcome.applied;
  summary.skippedStale = outcome.skippedStale;
  summary.unresolved = unresolved;
  // Reported only when there is something to report: unlike a poll, a single message is not a
  // statement about every location, so a resolvable message must not erase the standing gap report.
  if (unresolved.length) recordUnresolvedLocations(sourceId, unresolved, log);
  return summary;
}

/**
 * Backstop for the one failure mode the event model has and the snapshot model does not.
 *
 * A 🟢 that is never delivered — a disconnect, a message the parser does not recognise, a location
 * the channel spells differently on the way out — leaves an alert active forever. This clears any
 * channel state that has been active for longer than `ALERT_CHANNEL_MAX_ALERT_SECONDS`, logs it and
 * counts it. The bound is set far above any real alert precisely so that firing is a defect signal,
 * not routine behaviour: if it fires, an all-clear was missed and the operator needs to know.
 *
 * It sweeps **every** row whose adapter type is an alert channel, deliberately including the ones
 * `enabled=false` currently switches off. Disabling a channel stops it being read; it does not
 * withdraw the alerts it was holding when it was switched off, and without this those rows would
 * hold their locations on the map with no collector left that could ever clear them.
 */
export async function expireStuckAlertChannelAlerts(log?: { warn: Function }): Promise<number> {
  if (!config.ALERT_CHANNEL_ENABLED) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stuck = await client.query<{
      source_id: string; location_id: string; alert_type: string; started_at: string;
    }>(
      `UPDATE alert_source_states
          SET active=false,missing_since=NULL,last_seen_at=now(),updated_at=now()
        WHERE source_id IN (SELECT id FROM sources WHERE adapter_type=$1) AND active=true
          AND COALESCE(provider_started_at,last_event_at,updated_at)
              < now()-($2::int * interval '1 second')
        RETURNING source_id,location_id,alert_type,
                  COALESCE(provider_started_at,last_event_at,updated_at)::text AS started_at`,
      [ALERT_CHANNEL_ADAPTER_TYPE, config.ALERT_CHANNEL_MAX_ALERT_SECONDS]
    );
    // A backstop pass only ever LOWERS a source row, so it normally reconciles alerts to an end and
    // reports nothing. It is not structurally incapable of the other direction: clearing one
    // administration's stuck row re-runs the aggregate, and if a second source still holds that
    // location while no global period is open, the same call opens one. Rare, and cheaper to handle
    // than to argue away.
    const started: Array<{ sourceId: string; record: AlertStartRecord }> = [];
    for (const row of stuck.rows) {
      const record = await reconcileAggregateAlert(client, row.location_id, row.alert_type, row.source_id);
      if (record) started.push({ sourceId: row.source_id, record });
      alertChannelStuckAlerts.inc({ source: row.source_id });
      log?.warn({
        sourceId: row.source_id, locationId: row.location_id, alertType: row.alert_type,
        startedAt: row.started_at, maximumSeconds: config.ALERT_CHANNEL_MAX_ALERT_SECONDS
      }, 'alert channel state cleared by the maximum alert duration guard: an all-clear was missed');
    }
    await client.query('COMMIT');
    for (const entry of started) announceAlertStarts(entry.sourceId, [entry.record]);
    return stuck.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The newest Telegram message id already stored for a source, or null when none is.
 *
 * Used by the reconnect backfill to tell whether its bounded window actually met the archive or
 * stopped short of it, leaving a stretch of the channel nobody has ever read. `external_id` is text
 * because other adapters put non-numeric ids there; the cast is guarded so a source that has ever
 * stored one cannot make this throw and take the backfill down with it.
 */
export async function newestStoredExternalId(sourceId: string): Promise<number | null> {
  const result = await pool.query<{ newest: string | null }>(
    `SELECT max(external_id::bigint)::text AS newest FROM source_messages
      WHERE source_id=$1 AND external_id ~ '^[0-9]+$'`,
    [sourceId]
  );
  const newest = Number(result.rows[0]?.newest ?? Number.NaN);
  return Number.isFinite(newest) ? newest : null;
}

export interface AlertTelegramChannel {
  sourceId: string;
  /** Lower-cased, without the leading `@`. */
  username: string;
}

/**
 * The Telegram channels allowed to start and end official alerts, read from `sources`.
 *
 * `enabled` is a real gate here, exactly as it is for the OSINT monitors: fifteen of the twenty-one
 * registered Tier A rows are switched off because their published wording has never been observed or
 * cannot be read safely, and the flag is the only thing that keeps alert-declaring authority away
 * from those channels. Nothing in the code writes this column — see
 * `migrations/014_multi_channel_alert_routing.sql` for why the collector no longer flips it on.
 *
 * `config.ALERT_CHANNEL_ENABLED` sits above it as the deployment-level kill switch, mirroring
 * `OSINT_MONITOR_ENABLED`: the environment decides whether this path runs at all, and the catalogue
 * decides which channels it runs over.
 */
export async function loadAlertChannels(): Promise<AlertTelegramChannel[]> {
  if (!config.ALERT_CHANNEL_ENABLED) return [];
  const result = await pool.query<{ id: string; telegram_username: string }>(
    `SELECT id,lower(telegram_username) AS telegram_username FROM sources
     WHERE adapter_type=$1 AND enabled=true AND telegram_username IS NOT NULL
     ORDER BY id`,
    [ALERT_CHANNEL_ADAPTER_TYPE]
  );
  return result.rows
    .map((row) => ({
      sourceId: row.id,
      username: (row.telegram_username ?? '').trim().replace(/^@/, '').toLowerCase()
    }))
    .filter((channel) => channel.username);
}

// ------------------------------------------------------------------------------------------------
// Monitoring Telegram channels: the classifier path, driven from `sources`
// ------------------------------------------------------------------------------------------------

/** Adapter type of an OSINT monitoring channel. Never reaches the alert reconciler — see below. */
export const MONITOR_ADAPTER_TYPE = 'mtproto_monitor';

/** Adapter type of the Air Force channel: the same classifier path, but an official Tier A source. */
const CLASSIFIER_ADAPTER_TYPES = ['mtproto', MONITOR_ADAPTER_TYPE] as const;

/**
 * Every handle claimed by an alert-channel row, `enabled` or not.
 *
 * Disabled is included on purpose: a switched-off Tier A row must not become collectable through
 * the classifier by having its handle duplicated onto a monitoring row. Interpolated into the two
 * queries below, where `$1` is the alert-channel adapter type.
 */
const ALERT_CHANNEL_HANDLES_SQL =
  `SELECT lower(telegram_username) FROM sources WHERE adapter_type=$1 AND telegram_username IS NOT NULL`;

export interface MonitoredTelegramChannel {
  sourceId: string;
  /** Lower-cased, without the leading `@`. */
  username: string;
  adapterType: string;
}

/**
 * The Telegram channels whose messages go through the classifier, read from `sources`.
 *
 * This is the whole list. Adding a monitoring channel is a row, not a code change, and the row is
 * what binds a username to the `source_id` that will own its evidence — get that wrong and the
 * independence-group rule silently attributes one publisher's reporting to another.
 *
 * Two things this deliberately does *not* return:
 *
 *  * **Any alert channel.** Their adapter type is `mtproto_alert_channel` and is not in
 *    {@link CLASSIFIER_ADAPTER_TYPES}; on top of that, a row claiming a username that *any*
 *    alert-channel row also claims is dropped outright, as is a row claiming the configured
 *    fallback username. A monitoring row can therefore never be routed to the alert reconciler,
 *    and cannot shadow an official channel by claiming its name — which matters far more now that
 *    twenty-one handles carry alert authority instead of one.
 *  * **Disabled rows.** `enabled=false` stops every classifier route, including the Air Force row.
 *    A registry read failure still gets the one-channel fallback in `resolveChannelRoutes`; a
 *    successful empty result is obeyed.
 */
export async function loadMonitoredTelegramChannels(): Promise<MonitoredTelegramChannel[]> {
  if (!config.OSINT_MONITOR_ENABLED) {
    // The kill switch stops the OSINT monitors only; the Air Force channel is not OSINT.
    const airForce = await pool.query<{ id: string; telegram_username: string; adapter_type: string }>(
      `SELECT id,lower(telegram_username) AS telegram_username,adapter_type FROM sources
       WHERE telegram_username IS NOT NULL AND adapter_type='mtproto'
         AND enabled=true
         AND lower(telegram_username) NOT IN (${ALERT_CHANNEL_HANDLES_SQL})
       ORDER BY id`,
      [ALERT_CHANNEL_ADAPTER_TYPE]
    );
    return toMonitoredChannels(airForce.rows);
  }
  const result = await pool.query<{ id: string; telegram_username: string; adapter_type: string }>(
    `SELECT id,lower(telegram_username) AS telegram_username,adapter_type FROM sources
     WHERE telegram_username IS NOT NULL
       AND adapter_type = ANY($2::text[])
       AND enabled = true
       AND lower(telegram_username) NOT IN (${ALERT_CHANNEL_HANDLES_SQL})
     ORDER BY id`,
    [ALERT_CHANNEL_ADAPTER_TYPE, [...CLASSIFIER_ADAPTER_TYPES]]
  );
  return toMonitoredChannels(result.rows);
}

function toMonitoredChannels(
  rows: Array<{ id: string; telegram_username: string; adapter_type: string }>
): MonitoredTelegramChannel[] {
  const alertChannel = config.ALERT_CHANNEL_USERNAME;
  return rows
    .map((row) => ({
      sourceId: row.id,
      username: (row.telegram_username ?? '').trim().replace(/^@/, '').toLowerCase(),
      adapterType: row.adapter_type
    }))
    .filter((channel) => channel.username && channel.username !== alertChannel);
}

/**
 * Suppression window for a monitoring channel repeating itself.
 *
 * These channels publish in bursts during an attack, and a burst is mostly restatement: the same
 * threat type over the same place, minutes apart. Every restatement that reaches `ingestThreat`
 * lands on the existing event, appends a `threat.updated` row to the system event log and therefore
 * fans out to *every* subscriber of that location again — the outbox idempotency key carries the
 * event-log version, so a repeat is a new notification, not a duplicate that collapses.
 *
 * The key is (source, threat type, locations), so this only ever collapses a source restating the
 * same thing. A different location, a different threat type, or the same report from a *different*
 * channel all pass through untouched — which matters, because corroboration between two monitors is
 * exactly what promotes an event to `confirmed`.
 *
 * In-process state, matching the documented single-replica deployment. Losing it on restart costs
 * one extra notification per active threat.
 */
const monitorCoalesceState = new Map<string, number>();

function coalesceKey(sourceId: string, classified: ReturnType<typeof classifyMessage>): string {
  const places = classified.nationalScope
    ? ['ua']
    : classified.locations.map((location) => location.id).sort();
  return `${sourceId}|${classified.threatType}|${places.join(',')}`;
}

/** Test seam: the window is wall-clock, so a suite that ingests twice in one tick needs a reset. */
export function resetMonitorCoalescing(): void {
  monitorCoalesceState.clear();
}

function shouldCoalesce(key: string, now: number): boolean {
  const windowMs = config.OSINT_MONITOR_COALESCE_SECONDS * 1000;
  if (windowMs <= 0) return false;
  for (const [existing, at] of monitorCoalesceState) {
    if (at < now - windowMs) monitorCoalesceState.delete(existing);
  }
  const previous = monitorCoalesceState.get(key);
  if (previous !== undefined && previous >= now - windowMs) return true;
  monitorCoalesceState.set(key, now);
  return false;
}

/**
 * Stores a message the pipeline is not going to act on, and returns its id.
 *
 * The conflict branch is a no-op update rather than `DO NOTHING` because the id is needed to attach
 * a classification record: a replayed message must keep its original status and still be linkable.
 */
async function recordUnprocessedMessage(message: NormalizedMessage, status: string): Promise<string> {
  const hash = createHash('sha256').update(message.text).digest('hex');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,content_hash,processing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source_id,external_id,content_hash)
       DO UPDATE SET received_at=source_messages.received_at
     RETURNING id`,
    [message.sourceId, message.externalId, message.publishedAt, message.editedAt ?? null,
      message.text, JSON.stringify(message.rawPayload), hash, status]
  );
  return result.rows[0]!.id;
}

/**
 * The decisions that put an event on the map, and therefore the only ones a model may annotate.
 *
 * `de_escalation` is absent and that is the important omission: a withdrawal carries an event id too,
 * and a model remark filed against a claim somebody has just taken back is the one shape of
 * "enrichment" that could read as an argument for putting it back. The three listed here are the
 * branches that assert something.
 */
const PUBLISHING_DECISIONS: ReadonlySet<ClassificationDecision> =
  new Set<ClassificationDecision>(['event_created', 'event_merged', 'redirect']);

/**
 * Archives one decision without ever letting the archive break the pipeline.
 *
 * The write is outside the ingestion transaction and its failure is a counter, not an exception:
 * during a mass attack the thing that must keep working is the map, and an analytics row is not
 * worth a dropped threat event. What is lost when this fails is one row of history, and the counter
 * says so.
 */
async function archiveClassification(entry: ClassificationLogEntry): Promise<void> {
  // The shadow classifier hangs off this one function rather than off the four branches that call
  // it, because "the deterministic decision is final and written down" is exactly the moment a second
  // opinion becomes meaningful and cannot influence anything. It is started before the archive write
  // is awaited on purpose — the two are independent, neither waits for the other, and the model call
  // is fire-and-forget in both directions.
  //
  // The original text and envelope are passed because an image/audio-only post can have no useful
  // deterministic summary, and because an analytical promotion must preserve its source identity.
  scheduleShadowClassification({
    sourceMessageId: entry.sourceMessageId,
    sourceId: entry.sourceId,
    publishedAt: entry.publishedAt,
    text: entry.message?.text ?? entry.classified.summary,
    classified: entry.classified,
    media: entry.media,
    message: entry.message,
    allowAnalyticalPromotion: entry.decision === 'ignored' || entry.decision === 'unrecognized',
    // The complement of the flag above, and the reason both live on this one line: a message either
    // was refused by the rules — in which case the model may fill the gap — or it was published, in
    // which case the model may only annotate what was published, into a table nothing public reads
    // (`./analytical-enrichment.ts`, migration 045). Deriving both from `entry.decision` here is what
    // makes them exclusive by construction rather than by a rule two call sites have to remember.
    //
    // `entry.eventId` is set only on the branch that ran `ingestThreat`, and the decision is checked
    // anyway: a future branch that starts carrying an event id for some other reason must not
    // silently acquire the right to have the model write remarks against it.
    ...(PUBLISHING_DECISIONS.has(entry.decision) && entry.eventId
      ? {
          publishedClaim: {
            eventId: entry.eventId,
            threatType: entry.classified.threatType,
            // What the rules took out of THIS message, not what the event holds after every merge:
            // the enrichment write re-checks each proposed place against the event as it stands, so
            // this list only has to be the honest baseline of the current reading.
            locationIds: entry.classified.locations.map((location) => location.id),
            directionText: entry.classified.directionText ?? null,
            nationalScope: entry.classified.nationalScope
          }
        }
      : {}),
    historical: entry.historical
  });
  classificationDecisions.inc({ version: CLASSIFIER_VERSION, decision: entry.decision });
  try {
    await recordClassification(entry);
  } catch (error) {
    classificationLogFailures.inc({ source: entry.sourceId });
    countChannelError(entry.sourceId, 'persist');
    console.warn(JSON.stringify({
      level: 'warn', msg: 'classification archive write failed', sourceId: entry.sourceId,
      decision: entry.decision, error: error instanceof Error ? error.message : String(error)
    }));
  }
}

export interface ProcessMessageOptions {
  /**
   * Marks the message as coming from an OSINT monitoring channel, which enables burst coalescing
   * and the per-source metric. It grants nothing: the alert reconciler is unreachable from here for
   * every caller alike.
   */
  monitor?: boolean;
  /**
   * The message is being replayed from the catch-up backfill rather than read live.
   *
   * Passed straight through to `ingestThreat`, which is where it means something: a message already
   * past its own thirty-minute validity window lands in the archive and appends nothing to
   * `system_event_log`, so it can reach neither the map nor a subscriber. Everything else on this
   * path — classification, the significance rejection, burst coalescing, the decision archive — is
   * deliberately identical for a replayed message and a live one.
   */
  historical?: boolean;
}

/**
 * The measured wrapper around the classifier path.
 *
 * The body below is unchanged and lives in {@link classifyAndIngest}; this exists only so the two
 * observations have somewhere to stand that every caller passes through. The duration is taken in a
 * `finally` because four of the five terminal branches return early, and a per-branch call would
 * silently stop measuring the day a sixth branch is added.
 */
export async function processMessage(message: NormalizedMessage, options: ProcessMessageOptions = {}) {
  // Ingestion lag is measured from the source's own timestamp, not from ours: the number an operator
  // needs is "how old was this when we accepted it", and our clock cannot answer that.
  observeIngestionLag(message.sourceId, (Date.now() - message.publishedAt.getTime()) / 1000);
  const startedAt = Date.now();
  try {
    return await classifyAndIngest(message, options);
  } finally {
    observeClassificationDuration('classifier', (Date.now() - startedAt) / 1000);
  }
}

async function classifyAndIngest(message: NormalizedMessage, options: ProcessMessageOptions = {}) {
  // Кешований і той САМИЙ масив на кожне повідомлення: `indexFor` у класифікаторі мемоїзує індекс
  // за ідентичністю масиву, тож свіжий масив на кожен виклик означав повну переіндексацію каталогу
  // (~300k записів) на кожне повідомлення — саме це роздувало контейнер до гігабайтів під час атак.
  const locations = await cachedLocationLexemes();
  const classified = classifyMessage(message.text, locations);
  const count = (outcome: string) => {
    if (options.monitor) monitorMessages.inc({ source: message.sourceId, outcome });
  };
  // A source withdrawing its own earlier claim — "ТУшки неактивні", "ціль знищена", "не відмічаємо
  // ознак застосування стратегічної авіації". This is the only evidence a publisher ever gives that
  // a threat is over; before it moved state, a threat could fade only on the 30-minute timer.
  //
  // What it retracts is bounded by the publisher: `applyDeEscalation` closes this source's own
  // assertions and decays this source's own risk signals, and an event ends only when nothing holds
  // it any more. Nothing here reaches `alert_source_states` or `alert_periods` — an OSINT channel
  // cannot publish an "Офіційний відбій".
  if (isDeEscalation(classified)) {
    const outcome = await applyDeEscalation(message, classified);
    count('de_escalation');
    threatWithdrawals.inc({
      source: message.sourceId,
      outcome: outcome.withdrawal.endedEventIds.length ? 'event_withdrawn'
        : outcome.withdrawal.withdrawnAssertions ? 'assertions_withdrawn' : 'nothing_asserted'
    });
    // Only when something was actually live and is now not: a withdrawal that closed nothing is a
    // publisher tidying up, and counting it here would bury the transitions that matter.
    if (outcome.withdrawal.endedEventIds.length) {
      threatToDeEscalation.inc({ source: message.sourceId, version: CLASSIFIER_VERSION });
    }
    await archiveClassification({
      sourceId: message.sourceId, sourceMessageId: outcome.sourceMessageId,
      publishedAt: message.publishedAt, classified, decision: 'de_escalation', media: message.media,
      message, historical: options.historical,
      withdrawal: outcome.withdrawal
    });
    return { deEscalation: true as const, classified, withdrawal: outcome.withdrawal };
  }
  const rejection = significanceRejection(classified);
  if (rejection) {
    const sourceMessageId = await recordUnprocessedMessage(message, 'ignored');
    count('ignored');
    classificationRejections.inc({ source: message.sourceId, reason: rejection });
    await archiveClassification({
      sourceId: message.sourceId, sourceMessageId, publishedAt: message.publishedAt, classified,
      media: message.media,
      message, historical: options.historical,
      // "Recognised nothing", "recognised something that is nowhere" and "recognised a report about
      // last night" are three different findings: the first says the vocabulary has drifted or the
      // message was never about a threat, the second says the place is missing from the catalogue,
      // and the third says the rules read the message as retrospective and refused it. Collapsing
      // them into one word is what made "why was this ignored?" unanswerable. `ignored_reason` keeps
      // the precise rejection either way; `decision` is the coarse split a dashboard groups on, and
      // the retrospective one is kept apart because it is the only refusal that discards a message
      // in which a threat *and* a place were both recognised.
      decision: rejection === 'retrospective' ? 'ignored_retrospective'
        : rejection === 'no_location' ? 'ignored' : 'unrecognized',
      ignoredReason: rejection
    });
    return { ignored: true as const };
  }
  if (options.monitor && shouldCoalesce(coalesceKey(message.sourceId, classified), Date.now())) {
    // Kept as provenance with its own status: the text is preserved and auditable, it simply does
    // not raise the event again.
    const sourceMessageId = await recordUnprocessedMessage(message, 'coalesced');
    count('coalesced');
    await archiveClassification({
      sourceId: message.sourceId, sourceMessageId, publishedAt: message.publishedAt, classified,
      decision: 'coalesced', ignoredReason: 'restated_within_coalesce_window', media: message.media,
      message, historical: options.historical
    });
    return { coalesced: true as const };
  }
  // The grey band, and the only model call in this codebase that is awaited on the ingestion path.
  //
  // It sits here — after coalescing, before `ingestThreat` — for three reasons. After coalescing,
  // because a restatement inside the burst window publishes nothing anyway and paying a model call
  // to suppress a suppression would be spending quota during an attack for no effect. Before
  // `ingestThreat`, because the alternative is publishing and retracting, and a threat that appears
  // on the map and in a subscriber's Telegram and then vanishes is worse than the false positive it
  // was meant to fix. And outside `ingestThreat` rather than inside it, because that function opens
  // the transaction: a slow model must not hold a database connection or a row lock.
  //
  // `retrospectiveGate` never throws and never returns `archive` for anything the classifier did not
  // already mark `suspect`. Off, over quota, unreachable, slow, or answering prose — every one of
  // those is `publish`, which is exactly what this line does when the branch is not taken. See
  // `src/services/retrospective-gate.ts` for why that is structural rather than a convention.
  if (classified.retrospective?.verdict === 'suspect') {
    const gate = await retrospectiveGate({
      sourceId: message.sourceId, text: message.text, classified
    });
    if (gate.verdict === 'archive') {
      const sourceMessageId = await recordUnprocessedMessage(message, 'ignored');
      count('ignored');
      // A rejection reason of its own, and deliberately not `retrospective`: that word means the
      // rules refused the message and a replay reproduces the refusal. This one is a model's opinion
      // at one moment and reproduces as nothing, which is precisely what somebody auditing a
      // suppression needs to be told before they read anything else.
      classificationRejections.inc({ source: message.sourceId, reason: 'retrospective_model' });
      await archiveClassification({
        sourceId: message.sourceId, sourceMessageId, publishedAt: message.publishedAt, classified,
        decision: 'ignored_retrospective_model', ignoredReason: 'retrospective_model', media: message.media,
        message, historical: options.historical
      });
      return { ignored: true as const };
    }
  }
  count('classified');
  const result = await ingestThreat(message, classified, { historical: options.historical });
  if (result.withdrawal.withdrawnAssertions || result.withdrawal.endedEventIds.length) {
    threatWithdrawals.inc({
      source: message.sourceId,
      outcome: result.withdrawal.endedEventIds.length ? 'event_withdrawn' : 'assertions_withdrawn'
    });
  }
  await archiveClassification({
    sourceId: message.sourceId, sourceMessageId: result.sourceMessageId,
    publishedAt: message.publishedAt, classified, media: message.media,
    message, historical: options.historical,
    // `redirect` keeps its own decision because it is the only message class that asserts and
    // withdraws at once; `createdEvent` still records whether the event it asserted was new.
    decision: classified.intent === 'redirect' ? 'redirect' : result.created ? 'event_created' : 'event_merged',
    eventId: result.id, createdEvent: result.created, withdrawal: result.withdrawal
  });
  return result;
}

export async function seedDemoData(): Promise<void> {
  if (!config.DEMO_SOURCE_ENABLED) return;
  const live = await pool.query(
    `SELECT 1 FROM threat_events e JOIN event_evidence ee ON ee.event_id=e.id
     JOIN source_messages sm ON sm.id=ee.source_message_id
     WHERE sm.source_id='demo' AND e.status IN ('observed','confirmed','active') AND e.valid_until>now() LIMIT 1`
  );
  if (live.rowCount) {
    await markSourceSuccess('demo');
    return;
  }
  const publishedAt = new Date();
  const demos = [
    'Ударні БпЛА у напрямку Київської області. Демонстраційне повідомлення.',
    'Загроза балістики для Полтавщини. Демонстраційне повідомлення.'
  ];
  for (const [index, text] of demos.entries()) {
    await processMessage({
      sourceId: 'demo',
      externalId: `demo-${publishedAt.getTime()}-${index}-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`,
      publishedAt: new Date(publishedAt.getTime() - index * 180_000),
      text,
      rawPayload: { demo: true }
    });
  }
  await markSourceSuccess('demo');
}

// ------------------------------------------------------------------------------------------------
// The collection scheduler
// ------------------------------------------------------------------------------------------------

/**
 * Per-provider polling floors, in seconds. Compiled constants, deliberately NOT settings.
 *
 * Each one is a property of somebody else's server: a published rate limit, or a published cache
 * duration past which a faster poll returns the byte-identical body. An operator may slow the alert
 * legs down with `ALERT_POLL_INTERVAL_SECONDS` and may not speed any of them past its provider's
 * floor, because the consequence of getting that wrong is a 429 — or a blocked token — during the
 * one hour of the year the source matters. The provenance of each number is written out beside
 * `ALERT_POLL_INTERVAL_SECONDS` in `src/config.ts`; the summary is:
 *
 *   * mirror — 3 s, its own documented cache TTL (2 rps/host published separately).
 *   * alerts.in.ua — 7 s = 8.6 req/min, inside the 8–10 soft band and the 12/min hard limit.
 *   * Ukraine Alarm — 15 s, because NOTHING is documented and an undocumented budget is not a budget
 *     to spend against.
 */
export const AERIAL_MIRROR_MIN_POLL_SECONDS = 3;
export const ALERTS_IN_UA_MIN_POLL_SECONDS = 7;
export const UKRAINE_ALARM_MIN_POLL_SECONDS = 15;

/**
 * Cadence of the legs that are not alert STATE.
 *
 * The alert-channel backstop is a sweep over `alert_source_states`, not a request to anybody: it
 * costs one statement and it exists to catch a 🟢 that never arrived, bounded by
 * `ALERT_CHANNEL_MAX_ALERT_SECONDS` — a full day. Running it four times faster would change nothing
 * about when it fires and would add a statement to the pool the fast legs now share. It stays where
 * the old shared interval had it.
 */
export const SLOW_LEG_INTERVAL_SECONDS = 15;

/**
 * Pure. The gap in force for one alert leg: the operator's cadence, clamped up by that provider's
 * floor.
 *
 * Exported because it is the whole of «чому дзеркало опитується частіше за Ukraine Alarm» and the
 * one thing a test of the floors has to be able to call without a scheduler.
 */
export function alertLegIntervalMs(floorSeconds: number): number {
  return Math.max(config.ALERT_POLL_INTERVAL_SECONDS, floorSeconds) * 1000;
}

/**
 * The legs, split by what they are: alert STATE on a fast per-provider cadence, everything else at
 * fifteen seconds.
 *
 * Exported for the unit tests, which assert the split and the floors without arming a timer.
 */
export function ingestionLegs(log: { info: Function; warn: Function; error: Function }): SchedulerLeg[] {
  return [
    // ---- alert state, fast --------------------------------------------------------------------
    {
      name: 'aerial-mirror',
      run: () => syncAerialMirror(log),
      intervalMs: () => alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)
    },
    {
      name: 'alerts-in-ua',
      run: () => syncAlertsInUa(log),
      intervalMs: () => alertLegIntervalMs(ALERTS_IN_UA_MIN_POLL_SECONDS)
    },
    {
      name: 'ukraine-alarm',
      run: () => syncOfficialAlerts(log),
      intervalMs: () => alertLegIntervalMs(UKRAINE_ALARM_MIN_POLL_SECONDS)
    },
    // ---- everything else, unchanged ------------------------------------------------------------
    // The channel is pushed to, not polled; the only thing the scheduler owes it is the
    // maximum-duration backstop, which has to run whether or not any message arrives.
    {
      name: 'alert-channel-backstop',
      run: () => expireStuckAlertChannelAlerts(log),
      intervalMs: () => SLOW_LEG_INTERVAL_SECONDS * 1000
    }
  ];
}

/**
 * Starts one self-rescheduling chain per leg.
 *
 * ## What replaced `Promise.allSettled` over one `setInterval`, and why the guarantee survived
 *
 * The old shape ran all four legs inside one tick and needed `allSettled` rather than `all` for a
 * specific reason: `all` settles at the FIRST rejection and leaves the others running, so the shared
 * `finally { running = false }` released the overlap guard with a nationwide snapshot still
 * half-applied — and a rejection is the *normal* case here, because every sync function rethrows
 * after `markSourceError`. A second `persistOfficialAlertSnapshot` starting concurrently with the
 * first can compute the aggregate from a half-applied snapshot and produce a spurious «Офіційний
 * відбій» / re-open pair.
 *
 * That hazard is unchanged and so is the protection, by a stronger mechanism: each leg's next pass
 * is armed in the `finally` of its previous one, so no timer exists while a pass is in flight and a
 * second pass of the same leg is unrepresentable rather than merely refused. What the split removes
 * is the accidental half of the old guard — one leg's slow upstream no longer suppresses the other
 * three, which is exactly the case that used to cost fifteen seconds of every leg's freshness.
 *
 * Two legs of DIFFERENT sources can now overlap, and that is safe for the reason it always was:
 * `persistOfficialAlertSnapshot` is scoped `WHERE source_id=$1`, and the only shared row is the
 * `alert_periods` one, which every path takes `FOR UPDATE` before reading the aggregate.
 */
export function startIngestionScheduler(
  log: { info: Function; warn: Function; error: Function },
  deps: Parameters<typeof startLegScheduler>[2] = {}
): () => void {
  return startLegScheduler(ingestionLegs(log), log, deps);
}
