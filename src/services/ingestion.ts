import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
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

async function resolveLocationId(record: AlarmRecord): Promise<string | null> {
  const byCode = record.locationKey ? await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE id=$1 OR official_code=$1 LIMIT 1`, [record.locationKey]
  ) : { rows: [], rowCount: 0 } as never;
  if (byCode.rowCount) return byCode.rows[0]!.id;
  if (!record.locationName) return null;
  const normalized = record.locationName.toLocaleLowerCase('uk-UA')
    .replace(/^(м\.|місто|обл\.|область)\s*/u, '').replace(/\s+(обл\.|область)$/u, '').trim();
  if (!normalized) return null;
  const candidates = await pool.query<LocationCandidate>(
    `SELECT id,type,
       CASE WHEN lower(name_uk)=lower($1) THEN 0
            WHEN EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE lower(alias)=lower($1)) THEN 1
            ELSE 2 END AS match_rank
     FROM locations
     WHERE lower(name_uk)=lower($1)
        OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE lower(alias)=lower($1))
        OR lower(name_uk) LIKE lower($2)||'%' ESCAPE E'\\\\'
     LIMIT 50`,
    [normalized, escapeLikePattern(normalized)]
  );
  return pickLocationMatch(candidates.rows);
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

async function persistOfficialAlertSnapshot(sourceId: string, body: unknown): Promise<{ resolved: number; unresolved: string[] }> {
  const normalized = normalizeAlarmResponse(body);
  if (normalized.candidateCount > 0 && normalized.records.length === 0) {
    throw new Error(`${sourceId}: response contained alerts but none could be normalized`);
  }
  const resolved: Array<AlarmRecord & { locationId: string }> = [];
  const unresolved: string[] = [];
  for (const record of normalized.records) {
    const locationId = await resolveLocationId(record);
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
      // A source still holds the alert while it reports it, and for ALERT_END_DEBOUNCE_SECONDS after
      // it stops: one missed poll must never produce an "Офіційний відбій". The two-source rule is
      // unchanged — bool_or still means "no configured source holds it any more".
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
    try { await Promise.all([syncOfficialAlerts(log), syncAlertsInUa(log)]); }
    catch (error) { log.error({ error }, 'official alert synchronization failed'); }
    finally { running = false; }
  };
  const timer = setInterval(run, 15_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
