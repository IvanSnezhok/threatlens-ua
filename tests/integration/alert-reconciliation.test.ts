import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OBLAST, OTHER_OBLAST, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers `persistOfficialAlertSnapshot` in `src/services/ingestion.ts`.
 *
 * The rule under test comes from docs/ARCHITECTURE.md: alert sources keep independent state rows and
 * a global alert ends only when no configured source still reports it active — and, since
 * `008_alert_end_debounce.sql`, only once that source has been silent about it for the whole
 * `ALERT_END_DEBOUNCE_SECONDS` window. The function is module-private, so both official adapters are
 * driven through their exported `sync*` entry points with `fetch` stubbed — which also covers
 * URL/auth handling and the source-health bookkeeping.
 */

const UKRAINE_ALARM_URL = 'https://api.ukrainealarm.com/api/v3/alerts';
const ALERTS_IN_UA_URL = 'https://api.alerts.in.ua/v1/alerts/active.json';

const ALERT_START = '2026-02-01T20:00:00.000Z';

interface RegionAlert { regionId: string; regionName: string; types: string[]; startedAt?: string }

function alarmBody(regions: RegionAlert[]): unknown {
  return regions.map((region) => ({
    regionId: region.regionId,
    regionName: region.regionName,
    activeAlerts: region.types.map((type) => ({ type, lastUpdate: region.startedAt ?? ALERT_START }))
  }));
}

/** Per-URL response queue; each adapter reads only its own entry. */
const responses = new Map<string, unknown>();

function respondWith(url: string, body: unknown): void {
  responses.set(url, body);
}

async function loadIngestion() {
  return import('../../src/services/ingestion.js');
}

async function syncUkraineAlarm(body: unknown): Promise<void> {
  respondWith(UKRAINE_ALARM_URL, body);
  const { syncOfficialAlerts } = await loadIngestion();
  await syncOfficialAlerts();
}

async function syncAlertsInUa(body: unknown): Promise<void> {
  respondWith(ALERTS_IN_UA_URL, body);
  const { syncAlertsInUa: sync } = await loadIngestion();
  await sync();
}

async function alertPeriods(): Promise<Array<{ id: string; status: string; started_at: string; ended_at: string | null }>> {
  const rows = await sql<{ id: string; status: string; started_at: string; ended_at: string | null }>(
    `SELECT id,status,started_at::text,ended_at::text FROM alert_periods ORDER BY started_at,id`
  );
  return rows.rows;
}

async function alertEvents(): Promise<Array<{ event_type: string; payload: Record<string, unknown> }>> {
  const rows = await sql<{ event_type: string; payload: Record<string, unknown> }>(
    `SELECT event_type,payload FROM system_event_log WHERE event_type LIKE 'alert.%' ORDER BY version`
  );
  return rows.rows;
}

async function sourceStates(): Promise<Array<{ source_id: string; active: boolean }>> {
  const rows = await sql<{ source_id: string; active: boolean }>(
    `SELECT source_id,active FROM alert_source_states ORDER BY source_id`
  );
  return rows.rows;
}

/** The moment the reconciler first noticed this source had stopped reporting; NULL while it holds. */
async function missingSince(sourceId = 'ukraine-alarm'): Promise<string | null> {
  const rows = await sql<{ missing_since: string | null }>(
    `SELECT missing_since::text FROM alert_source_states WHERE source_id=$1`, [sourceId]
  );
  return rows.rows[0]?.missing_since ?? null;
}

/**
 * Ages every recorded absence past the debounce window.
 *
 * The window is wall-clock and evaluated inside PostgreSQL (`now()`), so vitest fake timers cannot
 * move it and sleeping through it would add a real minute to each of these tests. Backdating the
 * marker the reconciler itself writes is the same thing as waiting: the decision that reads it stays
 * entirely inside `persistOfficialAlertSnapshot`, which is still driven through the exported entry
 * points. No timer runs behind it — the alert ends on the next poll, exactly as in production.
 */
async function ageAbsencesPastDebounce(): Promise<void> {
  await sql(`UPDATE alert_source_states SET missing_since=now()-interval '1 hour' WHERE missing_since IS NOT NULL`);
}

describe.skipIf(!integrationDatabaseAvailable)('official alert reconciliation', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    responses.clear();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (!responses.has(url)) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => responses.get(url) };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const kyivAlert = () => alarmBody([{ regionId: OBLAST, regionName: 'Київська область', types: ['AIR'] }]);
  const nothing = () => alarmBody([]);

  it('creates one aggregated alert period when two sources report the same alert', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncAlertsInUa(kyivAlert());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]!.status).toBe('active');
    expect(await sourceStates()).toEqual([
      { source_id: 'alerts-in-ua', active: true },
      { source_id: 'ukraine-alarm', active: true }
    ]);
    // Exactly one alert.started, even though two providers reported it.
    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started']);
  });

  it('keeps the alert active while any single source still reports it', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncAlertsInUa(kyivAlert());

    await syncUkraineAlarm(nothing());

    expect(await sourceStates()).toEqual([
      { source_id: 'alerts-in-ua', active: true },
      { source_id: 'ukraine-alarm', active: false }
    ]);
    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]!.status).toBe('active');
    expect(periods[0]!.ended_at).toBeNull();
    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started']);
  });

  it('ends the alert and logs alert.ended only after the last source clears it', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncAlertsInUa(kyivAlert());
    await syncUkraineAlarm(nothing());
    await syncAlertsInUa(nothing());
    await ageAbsencesPastDebounce();
    await syncAlertsInUa(nothing());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]!.status).toBe('ended');
    expect(periods[0]!.ended_at).not.toBeNull();

    const events = await alertEvents();
    expect(events.map((event) => event.event_type)).toEqual(['alert.started', 'alert.ended']);
    expect(events[1]!.payload).toMatchObject({ alertId: periods[0]!.id, locationId: OBLAST, sourceId: 'alerts-in-ua' });
  });

  it('does not end the alert or emit alert.ended after a single missed poll', async () => {
    // One incomplete response or one failed provider call is the whole defect this window exists for:
    // it used to be enough to push an "Офіційний відбій" to every subscriber.
    await syncUkraineAlarm(kyivAlert());
    await syncUkraineAlarm(nothing());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]!.status).toBe('active');
    expect(periods[0]!.ended_at).toBeNull();
    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started']);
    // The source row stays honest about the gap: inactive, with the absence timestamped.
    expect(await sourceStates()).toEqual([{ source_id: 'ukraine-alarm', active: false }]);
    expect(await missingSince()).not.toBeNull();
  });

  it('timestamps the absence once instead of restarting the window on every missed poll', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncUkraineAlarm(nothing());
    const firstAbsence = await missingSince();

    await syncUkraineAlarm(nothing());
    await syncUkraineAlarm(nothing());

    // The window is measured from the first absence; refreshing it per poll would keep an alert that
    // a source genuinely dropped alive forever.
    expect(await missingSince()).toBe(firstAbsence);
    expect((await alertPeriods())[0]!.status).toBe('active');
  });

  it('emits neither alert.ended nor a second alert.started when the alert returns inside the window', async () => {
    await syncUkraineAlarm(kyivAlert());
    const started = (await alertPeriods())[0]!;

    await syncUkraineAlarm(nothing());
    await syncUkraineAlarm(kyivAlert());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ id: started.id, status: 'active', ended_at: null });
    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started']);
    expect(await missingSince()).toBeNull();
  });

  it('ends the alert once the only source has been silent for the whole debounce window', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncUkraineAlarm(nothing());
    expect((await alertPeriods())[0]!.status).toBe('active');

    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(nothing());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]!.status).toBe('ended');
    expect(periods[0]!.ended_at).not.toBeNull();
    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started', 'alert.ended']);
  });

  it('keeps the two-source rule intact: an expired window on one source cannot end what the other holds', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncAlertsInUa(kyivAlert());

    await syncUkraineAlarm(nothing());
    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(nothing());

    expect(await sourceStates()).toEqual([
      { source_id: 'alerts-in-ua', active: true },
      { source_id: 'ukraine-alarm', active: false }
    ]);
    expect((await alertPeriods())[0]!.status).toBe('active');
    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started']);

    // Only the second source going quiet for its own full window ends it.
    await syncAlertsInUa(nothing());
    expect((await alertPeriods())[0]!.status).toBe('active');
    await ageAbsencesPastDebounce();
    await syncAlertsInUa(nothing());
    expect((await alertPeriods())[0]!.status).toBe('ended');
  });

  it('never debounces a source row that only ever reported "no alert"', async () => {
    // An explicitly inactive region must not be treated as a source that just went quiet, or the
    // window would invent an alert nobody reported.
    await syncUkraineAlarm([
      { regionId: OBLAST, regionName: 'Київська область', status: 'no_alert', lastUpdate: ALERT_START }
    ]);
    expect(await alertPeriods()).toEqual([]);
    expect(await missingSince()).toBeNull();

    await syncUkraineAlarm(nothing());

    expect(await alertPeriods()).toEqual([]);
    expect(await alertEvents()).toEqual([]);
    expect(await missingSince()).toBeNull();
  });

  it('reconciles the two sources in the opposite order without creating a second period', async () => {
    await syncAlertsInUa(kyivAlert());
    await syncUkraineAlarm(kyivAlert());
    await syncAlertsInUa(nothing());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]!.status).toBe('active');
  });

  it('tracks alert types independently for the same location', async () => {
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR', 'ARTILLERY'] }
    ]));

    const rows = await sql<{ alert_type: string }>(
      `SELECT alert_type FROM alert_periods ORDER BY alert_type`
    );
    expect(rows.rows.map((row) => row.alert_type)).toEqual(['air_raid', 'artillery']);

    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR'] }
    ]));
    // The dropped type is debounced on its own, independently of the type that is still reported.
    const debounced = await sql<{ alert_type: string; status: string }>(
      `SELECT alert_type,status FROM alert_periods ORDER BY alert_type`
    );
    expect(debounced.rows).toEqual([
      { alert_type: 'air_raid', status: 'active' },
      { alert_type: 'artillery', status: 'active' }
    ]);

    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR'] }
    ]));

    const after = await sql<{ alert_type: string; status: string }>(
      `SELECT alert_type,status FROM alert_periods ORDER BY alert_type`
    );
    expect(after.rows).toEqual([
      { alert_type: 'air_raid', status: 'active' },
      { alert_type: 'artillery', status: 'ended' }
    ]);
  });

  it('adopts the earliest provider start timestamp across sources', async () => {
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR'], startedAt: '2026-02-01T21:30:00.000Z' }
    ]));
    const first = await alertPeriods();
    expect(new Date(first[0]!.started_at).toISOString()).toBe('2026-02-01T21:30:00.000Z');
  });

  it('resolves provider locations by name when no code matches', async () => {
    await syncUkraineAlarm([
      { regionName: 'Полтавська область', activeAlerts: [{ type: 'AIR', lastUpdate: ALERT_START }] }
    ]);

    const rows = await sql<{ location_id: string }>(`SELECT location_id FROM alert_periods`);
    expect(rows.rows[0]!.location_id).toBe('ua-53');
  });

  it('marks the source healthy after a successful snapshot', async () => {
    await syncUkraineAlarm(kyivAlert());
    const source = await sql<{ health_status: string; last_error: string | null }>(
      `SELECT health_status,last_error FROM sources WHERE id='ukraine-alarm'`
    );
    expect(source.rows[0]).toEqual({ health_status: 'current', last_error: null });
  });

  it('refuses the snapshot and records a source error when nothing could be mapped', async () => {
    const { syncOfficialAlerts } = await loadIngestion();
    respondWith(UKRAINE_ALARM_URL, alarmBody([
      { regionId: 'zz-999', regionName: 'Неіснуюча область', types: ['AIR'] }
    ]));

    await expect(syncOfficialAlerts()).rejects.toThrow(/no provider locations matched/);

    expect(await alertPeriods()).toEqual([]);
    const source = await sql<{ health_status: string }>(`SELECT health_status FROM sources WHERE id='ukraine-alarm'`);
    expect(source.rows[0]!.health_status).toBe('error');
  });

  it('keeps mapped locations and reports the unmapped ones without failing the snapshot', async () => {
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR'] },
      { regionId: 'zz-999', regionName: 'Неіснуюча область', types: ['AIR'] }
    ]));

    expect(await alertPeriods()).toHaveLength(1);
    const source = await sql<{ health_status: string }>(`SELECT health_status FROM sources WHERE id='ukraine-alarm'`);
    expect(source.rows[0]!.health_status).toBe('current');
  });

  it('does not disturb a location the snapshot never mentions', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncUkraineAlarm(alarmBody([
      { regionId: OTHER_OBLAST, regionName: 'Полтавська область', types: ['AIR'] }
    ]));
    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(alarmBody([
      { regionId: OTHER_OBLAST, regionName: 'Полтавська область', types: ['AIR'] }
    ]));

    const rows = await sql<{ location_id: string; status: string }>(
      `SELECT location_id,status FROM alert_periods ORDER BY location_id`
    );
    // Kyiv oblast stopped being reported by the only source and its window has run out, so it ends;
    // Poltava is untouched by the other location's reconciliation.
    expect(rows.rows).toEqual([
      { location_id: 'ua-32', status: 'ended' },
      { location_id: 'ua-53', status: 'active' }
    ]);
  });

  it('reopens the period instead of aborting the snapshot when an identical alert is re-reported', async () => {
    // alert_periods carries UNIQUE (location_id, alert_type, started_at) and the reconciler inserts a
    // new period using min(provider_started_at). A provider that ends an alert and later re-lists it
    // with the same start time used to collide with the period it just closed: the whole transaction
    // rolled back, every other location in that snapshot was lost and the source flipped to 'error'.
    // The conflict now reopens the period, so the unique index can neither discard a snapshot nor
    // hide an active alert.
    await syncUkraineAlarm(kyivAlert());
    await syncUkraineAlarm(nothing());
    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(nothing());
    const closed = await alertPeriods();
    expect(closed[0]!.status).toBe('ended');

    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR'] },
      { regionId: OTHER_OBLAST, regionName: 'Полтавська область', types: ['AIR'] }
    ]));

    const rows = await sql<{ id: string; location_id: string; status: string; ended_at: string | null }>(
      `SELECT id,location_id,status,ended_at::text FROM alert_periods ORDER BY location_id`
    );
    // The re-reported alert is visible again, and the unrelated location in the same snapshot — the
    // blast radius of the old rollback — is persisted normally.
    expect(rows.rows.map(({ location_id, status, ended_at }) => ({ location_id, status, ended_at }))).toEqual([
      { location_id: 'ua-32', status: 'active', ended_at: null },
      { location_id: 'ua-53', status: 'active', ended_at: null }
    ]);
    // Reopened, not duplicated: the row keeps its identity and its original start timestamp.
    expect(rows.rows[0]!.id).toBe(closed[0]!.id);

    const kyivEvents = (await alertEvents())
      .filter((event) => String(event.payload.locationId) === OBLAST)
      .map((event) => event.event_type);
    expect(kyivEvents).toEqual(['alert.started', 'alert.ended', 'alert.started']);

    const source = await sql<{ health_status: string; last_error: string | null }>(
      `SELECT health_status,last_error FROM sources WHERE id='ukraine-alarm'`
    );
    expect(source.rows[0]).toEqual({ health_status: 'current', last_error: null });
  });

  it('recovers when the provider re-reports the alert with a fresh start timestamp', async () => {
    await syncUkraineAlarm(kyivAlert());
    await syncUkraineAlarm(nothing());
    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(nothing());
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR'], startedAt: '2026-02-01T23:15:00.000Z' }
    ]));

    const periods = await alertPeriods();
    expect(periods.map((period) => period.status)).toEqual(['ended', 'active']);
    expect((await alertEvents()).map((event) => event.event_type))
      .toEqual(['alert.started', 'alert.ended', 'alert.started']);
  });
});
