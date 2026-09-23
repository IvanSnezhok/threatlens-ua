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

/**
 * Тіло `alerts.in.ua`: колір стоїть НА ТРИВОЗІ, поруч із `alert_type`, а різновид виводиться з
 * `threats[]`. Значення `threat_type` — ті, що їх віддає живий API (зріз 22.09.2026: `drones` і
 * `unspecified_missiles`).
 *
 * Те саме тіло подається і на URL Ukraine Alarm там, де тестові потрібні ДВА джерела з РІЗНИМИ
 * кольорами. Це скорочення гарнесу, а не твердження про v3: у бойовій системі другим кольоровим
 * джерелом є дзеркало. Правило, яке тут перевіряється, — зведення, і воно не питає, хто саме
 * назвав колір.
 */
interface LevelledAlert {
  regionId: string;
  regionName: string;
  level?: 'yellow' | 'red';
  threats?: string[];
  startedAt?: string;
}

function levelBody(alerts: LevelledAlert[]): unknown {
  return {
    alerts: alerts.map((alert) => ({
      region_id: alert.regionId,
      region_name: alert.regionName,
      alert_type: 'air_raid',
      status: 'active',
      started_at: alert.startedAt ?? ALERT_START,
      ...(alert.level ? { alert_level: alert.level } : {}),
      ...(alert.threats ? { threats: alert.threats.map((threat) => ({ threat_type: threat })) } : {})
    }))
  };
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

interface PeriodRow {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  alert_level: string | null;
  alert_kind: string | null;
  alert_level_changed_at: string | null;
}

async function alertPeriods(): Promise<PeriodRow[]> {
  const rows = await sql<PeriodRow>(
    `SELECT id,status,started_at::text,ended_at::text,alert_level,alert_kind,
            alert_level_changed_at::text
       FROM alert_periods ORDER BY started_at,id`
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

/** Те саме, але з кольором: що САМЕ сказало кожне джерело про цю пару. */
async function sourceLevels(): Promise<Array<{
  source_id: string; active: boolean; alert_level: string | null; alert_kind: string | null;
}>> {
  const rows = await sql<{
    source_id: string; active: boolean; alert_level: string | null; alert_kind: string | null;
  }>(`SELECT source_id,active,alert_level,alert_kind FROM alert_source_states ORDER BY source_id`);
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

  it('writes only the air raid when a location also reports another alert type', async () => {
    // `alert_periods` holds air raids and nothing else (`INGESTED_ALERT_TYPE` in ingestion.ts):
    // every `alert_start` downstream is rendered as «🔴 Повітряна тривога», so an artillery row
    // written here would be announced to subscribers as an air raid. The other type is dropped
    // before the location lookup, counted on `threatlens_alarm_records_dropped_total`, and never
    // becomes a source row that could hold anything.
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['AIR', 'ARTILLERY'] }
    ]));

    const rows = await sql<{ alert_type: string; status: string }>(
      `SELECT alert_type,status FROM alert_periods ORDER BY alert_type`
    );
    expect(rows.rows).toEqual([{ alert_type: 'air_raid', status: 'active' }]);
    expect(await sourceStates()).toEqual([{ source_id: 'ukraine-alarm', active: true }]);

    // Nor can the dropped type keep the air raid alive: once only shelling is reported, the air raid
    // is debounced and ended exactly as if the location had gone quiet.
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['ARTILLERY'] }
    ]));
    await ageAbsencesPastDebounce();
    await syncUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', types: ['ARTILLERY'] }
    ]));

    const after = await sql<{ alert_type: string; status: string }>(
      `SELECT alert_type,status FROM alert_periods ORDER BY alert_type`
    );
    expect(after.rows).toEqual([{ alert_type: 'air_raid', status: 'ended' }]);
    expect(await sourceStates()).toEqual([{ source_id: 'ukraine-alarm', active: false }]);
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

  // ------------------------------------------------------------------------------------------
  // Рівень тривоги: прикмета, яка не має права стати тотожністю
  // ------------------------------------------------------------------------------------------
  //
  // Диференційоване оповіщення, чинне з 06.09.2026. Усе нижче перевіряє одну межу: колір описує
  // тривогу, яку вже визнали ввімкненою, і не бере участі в рішенні «тривога є чи немає».

  const kyiv = (level?: 'yellow' | 'red', threats?: string[]) => levelBody([{
    regionId: OBLAST, regionName: 'Київська область',
    ...(level ? { level } : {}), ...(threats ? { threats } : {})
  }]);

  it('replaces the colour inside one standing period instead of opening a second one', async () => {
    await syncAlertsInUa(kyiv('yellow', ['drones']));
    const opened = await alertPeriods();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      status: 'active', alert_level: 'yellow', alert_kind: 'drones', alert_level_changed_at: null
    });

    await syncAlertsInUa(kyiv('red', ['unspecified_missiles']));

    const periods = await alertPeriods();
    // ОДИН період, той самий рядок, той самий старт, без відбою. Це і є вся суть зміни: якби колір
    // жив у `alert_type`, тут було б два періоди і «⚪ Відбій тривоги» посеред посилення.
    expect(periods).toHaveLength(1);
    expect(periods[0]!.id).toBe(opened[0]!.id);
    expect(periods[0]!.started_at).toBe(opened[0]!.started_at);
    expect(periods[0]).toMatchObject({ status: 'active', ended_at: null, alert_level: 'red', alert_kind: 'missiles' });
    expect(periods[0]!.alert_level_changed_at).not.toBeNull();

    const events = await alertEvents();
    expect(events.map((event) => event.event_type)).toEqual(['alert.started', 'alert.level_changed']);
    expect(events[0]!.payload).toMatchObject({ level: 'yellow', kind: 'drones' });
    expect(events[1]!.payload).toMatchObject({
      alertPeriodId: periods[0]!.id, locationId: OBLAST,
      level: 'red', previousLevel: 'yellow', kind: 'missiles', previousKind: 'drones'
    });
    expect(events[1]!.payload.changedAt).toEqual(expect.any(String));
  });

  it('does not repeat alert.level_changed when the same colour is re-reported', async () => {
    await syncAlertsInUa(kyiv('red', ['unspecified_missiles']));
    await syncAlertsInUa(kyiv('red', ['unspecified_missiles']));
    await syncAlertsInUa(kyiv('red', ['unspecified_missiles']));

    expect((await alertEvents()).map((event) => event.event_type)).toEqual(['alert.started']);
  });

  it('takes the strongest colour when two sources holding the alert disagree', async () => {
    const red = levelBody([{
      regionId: OBLAST, regionName: 'Київська область', level: 'red', threats: ['unspecified_missiles']
    }]);
    await syncAlertsInUa(kyiv('yellow', ['drones']));
    await syncUkraineAlarm(red);
    // Друге опитування — не повтор заради повтору. `markSourceSuccess` пишеться ПІСЛЯ знімка, тож
    // під час свого найпершого проходу джерело ще виглядає мертвим і правило живості не дає йому
    // голосу — а разом із голосом і кольору. Щоб перевірялося саме «найсильніший СЕРЕД ТИХ, ХТО
    // ТРИМАЄ», обидва джерела мусять бути живими.
    await syncUkraineAlarm(red);

    // Кожне джерело зберігає СВІЙ колір — саме з цих двох рядків зведення й рахує найсильніший.
    expect(await sourceLevels()).toEqual([
      { source_id: 'alerts-in-ua', active: true, alert_level: 'yellow', alert_kind: 'drones' },
      { source_id: 'ukraine-alarm', active: true, alert_level: 'red', alert_kind: 'missiles' }
    ]);
    const periods = await alertPeriods();
    // Обережність дорожча за консенсус: більшість каже «жовтий», період червоний.
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ status: 'active', alert_level: 'red', alert_kind: 'missiles' });
  });

  it('refuses the colour of a source that is too dead to hold the alert', async () => {
    // Та сама межа, з якої починається все інше: рівень рахується РІВНО з тих рядків, що тримають
    // тривогу. Рядок, який правило живості відкинуло, не голосує — отже й не фарбує. Інакше
    // джерело, яке замовкло годину тому, могло б лишити на карті червоний, якого вже ніхто не
    // підтверджує.
    const red = levelBody([{
      regionId: OBLAST, regionName: 'Київська область', level: 'red', threats: ['unspecified_missiles']
    }]);
    await syncUkraineAlarm(red);
    await syncUkraineAlarm(red);
    // Друге джерело приходить живим і слабшим: поки обидва живі, перемагає червоний.
    await syncAlertsInUa(kyiv('yellow', ['drones']));
    await syncAlertsInUa(kyiv('yellow', ['drones']));
    expect((await alertPeriods())[0]).toMatchObject({ alert_level: 'red', alert_kind: 'missiles' });

    // Тепер Ukraine Alarm мертвий, alerts.in.ua живий. Живий виграє не тому, що він гучніший, — а
    // тому, що мертвого взагалі не рахують. Правило `any_alive` при цьому не вимикається: живе
    // джерело в наборі є, тож відкидання мертвого дозволене.
    await sql(`UPDATE sources SET last_success_at=now()-interval '2 hours' WHERE id='ukraine-alarm'`);
    await syncAlertsInUa(kyiv('yellow', ['drones']));

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    // Тривога СТОЇТЬ — її тримає живе джерело, — а колір знизився до жовтого. Зниження кольору не
    // є відбоєм і ніколи ним не підписується: `ended_at` лишається NULL, події `alert.ended` немає.
    expect(periods[0]).toMatchObject({ status: 'active', ended_at: null, alert_level: 'yellow', alert_kind: 'drones' });
    expect((await alertEvents()).map((event) => event.event_type))
      .toEqual(['alert.started', 'alert.level_changed']);
  });

  it('keeps the alert standing when the colour disappears from every source', async () => {
    await syncAlertsInUa(kyiv('red', ['unspecified_missiles']));
    const opened = await alertPeriods();

    // Те саме джерело, та сама тривога, кольору більше не називають. Це НЕ відбій і навіть не
    // послаблення — джерело перестало уточнювати, а не перестало тримати.
    await syncAlertsInUa(kyiv());

    const periods = await alertPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ id: opened[0]!.id, status: 'active', ended_at: null });
    expect(periods[0]!.alert_level).toBeNull();
    expect(periods[0]!.alert_kind).toBeNull();
    // Зникнення кольору — це зміна прикмети, а не завершення: подія є, відбою немає.
    const events = await alertEvents();
    expect(events.map((event) => event.event_type)).toEqual(['alert.started', 'alert.level_changed']);
    expect(events[1]!.payload).toMatchObject({ level: null, previousLevel: 'red', kind: null });
  });

  it('never puts a colour on a period that is not active', async () => {
    await syncAlertsInUa(kyiv('red', ['unspecified_missiles']));
    await syncAlertsInUa(levelBody([]));
    await ageAbsencesPastDebounce();
    await syncAlertsInUa(levelBody([]));

    const ended = await alertPeriods();
    expect(ended[0]!.status).toBe('ended');
    const levelAtEnd = ended[0]!.alert_level;

    // Джерело знову називає колір — але воно ОДНЕ й нічого не тримає між опитуваннями, тож
    // завершений період кольору не набуває: гілка зміни рівня вимагає активного періоду, а гілка
    // створення відкриває НОВИЙ період зі своїм кольором. Старий рядок не рухається взагалі.
    await syncAlertsInUa(levelBody([{
      regionId: OBLAST, regionName: 'Київська область', level: 'yellow', threats: ['drones'],
      startedAt: '2026-02-01T23:15:00.000Z'
    }]));

    const periods = await alertPeriods();
    expect(periods.map((period) => period.status)).toEqual(['ended', 'active']);
    // Завершений рядок лишився таким, яким був у мить відбою — це запис про те, якою тривога БУЛА,
    // і жодна зміна рівня його більше не торкається.
    expect(periods[0]!.alert_level).toBe(levelAtEnd);
    expect(periods[0]!.alert_level_changed_at).toBeNull();
    expect(periods[1]).toMatchObject({ status: 'active', alert_level: 'yellow', alert_kind: 'drones' });

    // Жодного `alert.level_changed` про завершений період.
    const changes = (await alertEvents())
      .filter((event) => event.event_type === 'alert.level_changed')
      .map((event) => event.payload.alertPeriodId);
    expect(changes).not.toContain(periods[0]!.id);
  });

  it('leaves an uncoloured alert exactly as it was before differentiated alerting', async () => {
    // Найчастіший випадок і єдиний, який не має права змінитися: жодного кольору ніде, рядок
    // періоду такий самий, як був, подія `alert.started` несе два `null`.
    await syncUkraineAlarm(kyivAlert());

    const periods = await alertPeriods();
    expect(periods[0]).toMatchObject({
      status: 'active', alert_level: null, alert_kind: null, alert_level_changed_at: null
    });
    const events = await alertEvents();
    expect(events.map((event) => event.event_type)).toEqual(['alert.started']);
    expect(events[0]!.payload).toMatchObject({ locationId: OBLAST, level: null, kind: null });
  });
});
