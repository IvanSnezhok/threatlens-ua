import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { parseAlertChannelMessage } from '../domain/alert-parser.js';
import { classifyMessage, CLASSIFIER_VERSION, isDeEscalation, significanceRejection } from '../domain/classifier.js';
import {
  applyDeEscalation, ingestThreat, listLocationLexemes, recordClassification,
  type ClassificationLogEntry
} from '../repositories/events.js';
import {
  AERIAL_MIRROR_SOURCE_ID, AERIAL_MIRROR_USER_AGENT, parseAerialMirrorPayload, toAlarmSnapshotBody
} from '../sources/aerial-mirror.js';
import type { NormalizedMessage } from '../types.js';
import { markSourceError, markSourceSuccess } from './operations.js';
// One-way import, on purpose: the observations are ops instrumentation and this file stays free of
// ops code by calling three named functions rather than by growing a second metrics block.
import {
  countChannelError, observeClassificationDuration, observeIngestionLag
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
async function reconcileAggregateAlert(
  client: PoolClient, locationId: string, alertType: string, sourceId: string
): Promise<void> {
  // A source still holds the alert while it reports it, and for ALERT_END_DEBOUNCE_SECONDS after
  // it stops: one missed poll must never produce an "Офіційний відбій". The two-source rule is
  // unchanged — bool_or still means "no configured source holds it any more".
  //
  // The debounce is keyed on `missing_since`, which only the snapshot path ever sets. A source that
  // publishes an explicit all-clear leaves it NULL, so its rows drop out of the aggregate the moment
  // the all-clear lands: the window is for sources that go quiet, not for sources that speak.
  const aggregate = await client.query<{ active: boolean; started_at: Date | null }>(
    `SELECT bool_or(holds) AS active,min(provider_started_at) FILTER (WHERE holds) AS started_at
     FROM (
       SELECT active OR COALESCE(missing_since > now()-($3::int * interval '1 second'),false) AS holds,
              provider_started_at
       FROM alert_source_states WHERE location_id=$1 AND alert_type=$2
     ) source_state`,
    [locationId, alertType, config.ALERT_END_DEBOUNCE_SECONDS]
  );
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
      await client.query(`INSERT INTO system_event_log(event_type,payload) VALUES ('alert.started',$1)`,
        [JSON.stringify({ alertId: created.rows[0]!.id, locationId, sourceId })]);
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
    for (const record of resolved) {
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
    for (const key of affectedKeys) {
      const [locationId, alertType] = key.split(':');
      await reconcileAggregateAlert(client, locationId!, alertType!, sourceId);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { resolved: resolved.length, unresolved };
}

export async function syncOfficialAlerts(log?: { warn: Function }): Promise<void> {
  if (!config.UKRAINE_ALARM_API_TOKEN) return;
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
  try {
    await pool.query(`UPDATE sources SET enabled=true WHERE id='alerts-in-ua'`);
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
 */
export async function syncAerialMirror(log?: { warn: Function }): Promise<void> {
  if (!config.AERIAL_MIRROR_ENABLED) return;
  try {
    const response = await fetch(config.AERIAL_MIRROR_URL, {
      headers: { Accept: 'application/json', 'User-Agent': AERIAL_MIRROR_USER_AGENT },
      signal: AbortSignal.timeout(10_000)
    });
    // 429 included: the published limit is two requests per second per host and the scheduler polls
    // every fifteen, so a 429 means something else is sharing the egress IP — a source error, not a
    // reason to touch alert state.
    if (!response.ok) throw new Error(`Aerial alert mirror ${response.status}`);
    const snapshot = parseAerialMirrorPayload(
      await response.json(), new Date(), config.AERIAL_MIRROR_STALE_SECONDS
    );
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
 * The national channel https://t.me/air_alert_ua.
 *
 * Named because it is the row `config.ALERT_CHANNEL_USERNAME` falls back to when the registry cannot
 * be read, and because the operational documentation refers to it by id. It carries no privilege
 * over the other rows: it is read from the registry like all of them.
 */
export const ALERT_CHANNEL_SOURCE_ID = 'air-alert-ua';

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
  const metrics: ReadonlyArray<[string, Counter<string>]> = [
    ['threatlens_alert_channel_messages_total', alertChannelMessages],
    ['threatlens_alert_channel_stuck_alerts_total', alertChannelStuckAlerts],
    ['threatlens_monitor_messages_total', monitorMessages],
    ['threatlens_classification_log_failures_total', classificationLogFailures],
    ['threatlens_threat_withdrawals_total', threatWithdrawals],
    ['threatlens_classifications_total', classificationDecisions],
    ['threatlens_classification_rejections_total', classificationRejections],
    ['threatlens_threat_to_de_escalation_total', threatToDeEscalation],
    ...shadowClassifierMetrics(),
    ...retrospectiveGateMetrics()
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
      await reconcileAggregateAlert(client, state.locationId, state.alertType, sourceId);
    }
    await client.query('COMMIT');
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
    for (const row of stuck.rows) {
      await reconcileAggregateAlert(client, row.location_id, row.alert_type, row.source_id);
      alertChannelStuckAlerts.inc({ source: row.source_id });
      log?.warn({
        sourceId: row.source_id, locationId: row.location_id, alertType: row.alert_type,
        startedAt: row.started_at, maximumSeconds: config.ALERT_CHANNEL_MAX_ALERT_SECONDS
      }, 'alert channel state cleared by the maximum alert duration guard: an all-clear was missed');
    }
    await client.query('COMMIT');
    return stuck.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
 *  * **Disabled monitors.** `enabled=false` really stops collection here. It does not for the two
 *    HTTP official adapters — `syncOfficialAlerts` gates on a token and `syncAlertsInUa` sets the
 *    flag to true itself, so for those rows the column reports configuration rather than
 *    controlling it. That known defect is not carried into this path. The Air Force row is left on
 *    its existing behaviour on purpose: it is an official source that must keep working exactly as
 *    it does now, so it is not gated on a flag nothing currently sets.
 */
export async function loadMonitoredTelegramChannels(): Promise<MonitoredTelegramChannel[]> {
  if (!config.OSINT_MONITOR_ENABLED) {
    // The kill switch stops the OSINT monitors only; the Air Force channel is not OSINT.
    const airForce = await pool.query<{ id: string; telegram_username: string; adapter_type: string }>(
      `SELECT id,lower(telegram_username) AS telegram_username,adapter_type FROM sources
       WHERE telegram_username IS NOT NULL AND adapter_type='mtproto'
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
       AND (adapter_type <> $3 OR enabled = true)
       AND lower(telegram_username) NOT IN (${ALERT_CHANNEL_HANDLES_SQL})
     ORDER BY id`,
    [ALERT_CHANNEL_ADAPTER_TYPE, [...CLASSIFIER_ADAPTER_TYPES], MONITOR_ADAPTER_TYPE]
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
  // The text handed over is `classified.summary`: the same message, whitespace-collapsed and capped
  // at 500 characters. That is what the classifier itself read as far as any human review is
  // concerned, and taking it from here avoids threading the raw message through four call sites for
  // a feature that must never be load-bearing.
  scheduleShadowClassification({
    sourceMessageId: entry.sourceMessageId,
    publishedAt: entry.publishedAt,
    text: entry.classified.summary,
    classified: entry.classified
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
  const locations = await listLocationLexemes();
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
      publishedAt: message.publishedAt, classified, decision: 'de_escalation',
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
      decision: 'coalesced', ignoredReason: 'restated_within_coalesce_window'
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
        decision: 'ignored_retrospective_model', ignoredReason: 'retrospective_model'
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
    publishedAt: message.publishedAt, classified,
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

export function startIngestionScheduler(log: { info: Function; warn: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // `allSettled`, not `all`: `all` settles at the FIRST rejection and leaves the other legs
      // running, so `finally { running = false }` would release the overlap guard with a nationwide
      // snapshot still half-applied — and a rejection is the *normal* case, because both sync
      // functions rethrow after `markSourceError`. The next tick would then start a second
      // `persistOfficialAlertSnapshot` concurrently with the first, and two snapshots interleaving
      // their `alert_source_states` writes can compute the aggregate from a half-applied snapshot
      // and produce a spurious «Офіційний відбій» / re-open pair. Each rejected result is logged
      // individually; `markSourceError` has already run inside the leg that produced it, so nothing
      // is lost by not rethrowing.
      const results = await Promise.allSettled([
        syncOfficialAlerts(log), syncAlertsInUa(log),
        // Same fifteen-second cadence and the same overlap guard as the two token APIs, for the same
        // reason: it is a snapshot source, and two snapshots interleaving their writes can reconcile
        // from a half-applied picture. The published rate limit is two requests per second per host,
        // so fifteen seconds is three orders of magnitude inside it.
        syncAerialMirror(log),
        // The channel is pushed to, not polled; the only thing the scheduler owes it is the
        // maximum-duration backstop, which has to run whether or not any message arrives.
        expireStuckAlertChannelAlerts(log)
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          log.error({ error: result.reason }, 'official alert synchronization leg failed');
        }
      }
    }
    catch (error) { log.error({ error }, 'official alert synchronization failed'); }
    finally { running = false; }
  };
  const timer = setInterval(run, 15_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
