import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { parseAlertChannelMessage } from '../domain/alert-parser.js';
import { classifyMessage } from '../domain/classifier.js';
import { ingestThreat, listLocationLexemes } from '../repositories/events.js';
import type { NormalizedMessage } from '../types.js';
import { markSourceError, markSourceSuccess } from './operations.js';

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
    const normalized = normalizeForCatalogue(candidate);
    if (!normalized) continue;
    const rows = await pool.query<LocationCandidate>(
      LOCATION_MATCH_SQL, [normalized, escapeLikePattern(normalized), APOSTROPHE_CHARACTERS]
    );
    const matched = pickLocationMatch(rows.rows);
    if (matched) return matched;
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
    const created = await client.query<{ id: string }>(
      `INSERT INTO alert_periods(location_id,alert_type,status,started_at,external_id)
       VALUES ($1,$2,'active',COALESCE($3,now()),$4)
       ON CONFLICT (location_id,alert_type,started_at) DO UPDATE
         SET status='active',ended_at=NULL,updated_at=now()
         WHERE alert_periods.status<>'active'
       RETURNING id`,
      [locationId, alertType, aggregate.rows[0].started_at, `aggregate:${locationId}:${alertType}:${Date.now()}`]
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
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------
// Event-driven official alert source: the @air_alert_ua Telegram channel
// ------------------------------------------------------------------------------------------------

/**
 * The channel is an official Tier A source that happens to publish over MTProto instead of HTTPS.
 * What it is *not* is a snapshot: `persistOfficialAlertSnapshot` clears every state this source
 * holds before re-raising the reported ones, which is correct for an API that returns the complete
 * national picture on every poll and catastrophic for a channel that says "an alert started in one
 * raion" — every other raion would be cleared by the next message about a single oblast.
 *
 * So this path is per-location and additive: 🔴 raises exactly the rows it names, 🟢 lowers exactly
 * the rows it names, and every other row of the same source is left untouched.
 */
export const ALERT_CHANNEL_SOURCE_ID = 'air-alert-ua';

const alertChannelMessages = new Counter({
  name: 'threatlens_alert_channel_messages_total',
  help: 'Messages read from the official alert Telegram channel, by parse outcome',
  labelNames: ['outcome'],
  registers: []
});
const alertChannelStuckAlerts = new Counter({
  name: 'threatlens_alert_channel_stuck_alerts_total',
  help: 'Alert-channel states force-cleared because no all-clear arrived within the maximum duration',
  registers: []
});

/**
 * Attaches the alert-channel metrics to a Prometheus registry, mirroring
 * `registerOccupationMetrics`. Nothing in `src/services` owns the HTTP registry, so the wiring lives
 * wherever the registry is created.
 */
export function registerAlertChannelMetrics(registry: Registry): void {
  const metrics: ReadonlyArray<[string, Counter<string>]> = [
    ['threatlens_alert_channel_messages_total', alertChannelMessages],
    ['threatlens_alert_channel_stuck_alerts_total', alertChannelStuckAlerts]
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
async function recordAlertChannelMessage(message: AlertChannelMessage, status: string): Promise<void> {
  const hash = createHash('sha256').update(message.text).digest('hex');
  await pool.query(
    `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,
       content_hash,processing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_id,external_id,content_hash) DO NOTHING`,
    [ALERT_CHANNEL_SOURCE_ID, message.externalId, message.publishedAt, message.editedAt ?? null,
      message.text, JSON.stringify(message.rawPayload ?? {}), hash, status]
  );
}

async function applyAlertChannelStates(
  states: AlertChannelState[]
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
        [ALERT_CHANNEL_SOURCE_ID, state.locationId, state.alertType, state.active,
          state.observedAt, state.externalId]
      );
      if (!upsert.rowCount) { skippedStale += 1; continue; }
      applied += 1;
      await reconcileAggregateAlert(client, state.locationId, state.alertType, ALERT_CHANNEL_SOURCE_ID);
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
 * Applies a batch of channel messages.
 *
 * The live collector passes one message; the reconnect backfill passes a bounded history window.
 * Both go through the same code because the batch is first **folded to one terminal state per
 * location** — the newest event wins — and only that state is written. Replaying a window therefore
 * converges on the situation as it stands right now instead of re-emitting an hours-old alert and
 * its all-clear as a fresh pair of notifications.
 */
export async function ingestAlertChannelMessages(
  messages: AlertChannelMessage[], log?: { warn: Function }
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
    const parsed = parseAlertChannelMessage(message.text, message.publishedAt);
    if (parsed.kind === 'unrecognized') {
      summary.unrecognized += 1;
      alertChannelMessages.inc({ outcome: 'unrecognized' });
      await recordAlertChannelMessage(message, 'unrecognized');
      // A channel that changes its wording must make this loud. Silently reporting no alerts is the
      // one outcome an alert source is never allowed to have.
      log?.warn(
        { sourceId: ALERT_CHANNEL_SOURCE_ID, externalId: message.externalId, headline: parsed.headline },
        'alert channel message matched no known format and was not applied'
      );
      continue;
    }
    if (parsed.kind === 'ignored') {
      summary.ignored += 1;
      alertChannelMessages.inc({ outcome: `ignored:${parsed.reason}` });
      await recordAlertChannelMessage(message, 'ignored');
      continue;
    }
    summary.events += 1;
    alertChannelMessages.inc({ outcome: parsed.event.action });
    await recordAlertChannelMessage(message, 'alert');
    for (const name of parsed.event.locationNames) {
      const locationId = await resolveLocationId({ locationName: name });
      if (!locationId) { unresolved.push(name); continue; }
      desired.set(`${locationId}:${parsed.event.alertType}`, {
        locationId,
        alertType: parsed.event.alertType,
        active: parsed.event.action === 'start',
        observedAt: parsed.event.observedAt,
        externalId: `${ALERT_CHANNEL_SOURCE_ID}:${message.externalId}`
      });
    }
  }

  const outcome = await applyAlertChannelStates([...desired.values()]);
  summary.applied = outcome.applied;
  summary.skippedStale = outcome.skippedStale;
  summary.unresolved = unresolved;
  // Reported only when there is something to report: unlike a poll, a single message is not a
  // statement about every location, so a resolvable message must not erase the standing gap report.
  if (unresolved.length) recordUnresolvedLocations(ALERT_CHANNEL_SOURCE_ID, unresolved, log);
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
 */
export async function expireStuckAlertChannelAlerts(log?: { warn: Function }): Promise<number> {
  if (!config.ALERT_CHANNEL_ENABLED) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stuck = await client.query<{ location_id: string; alert_type: string; started_at: string }>(
      `UPDATE alert_source_states
          SET active=false,missing_since=NULL,last_seen_at=now(),updated_at=now()
        WHERE source_id=$1 AND active=true
          AND COALESCE(provider_started_at,last_event_at,updated_at)
              < now()-($2::int * interval '1 second')
        RETURNING location_id,alert_type,
                  COALESCE(provider_started_at,last_event_at,updated_at)::text AS started_at`,
      [ALERT_CHANNEL_SOURCE_ID, config.ALERT_CHANNEL_MAX_ALERT_SECONDS]
    );
    for (const row of stuck.rows) {
      await reconcileAggregateAlert(client, row.location_id, row.alert_type, ALERT_CHANNEL_SOURCE_ID);
      alertChannelStuckAlerts.inc();
      log?.warn({
        sourceId: ALERT_CHANNEL_SOURCE_ID, locationId: row.location_id, alertType: row.alert_type,
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

/** Marks the channel source as configured once its collector is actually connected. */
export async function enableAlertChannelSource(): Promise<void> {
  await pool.query(`UPDATE sources SET enabled=true WHERE id=$1`, [ALERT_CHANNEL_SOURCE_ID]);
}

export async function processMessage(message: NormalizedMessage) {
  const locations = await listLocationLexemes();
  const classified = classifyMessage(message.text, locations);
  if (classified.threatType === 'unknown' && classified.indicators.length === 0) {
    const hash = createHash('sha256').update(message.text).digest('hex');
    await pool.query(
      `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,content_hash,processing_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ignored') ON CONFLICT (source_id,external_id,content_hash) DO NOTHING`,
      [message.sourceId, message.externalId, message.publishedAt, message.editedAt ?? null, message.text, JSON.stringify(message.rawPayload), hash]
    );
    return { ignored: true as const };
  }
  return ingestThreat(message, classified);
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
      await Promise.all([
        syncOfficialAlerts(log), syncAlertsInUa(log),
        // The channel is pushed to, not polled; the only thing the scheduler owes it is the
        // maximum-duration backstop, which has to run whether or not any message arrives.
        expireStuckAlertChannelAlerts(log)
      ]);
    }
    catch (error) { log.error({ error }, 'official alert synchronization failed'); }
    finally { running = false; }
  };
  const timer = setInterval(run, 15_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
