import { readFileSync } from 'node:fs';
import { Registry } from 'prom-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * `alerts.in.ua` against live PostgreSQL: a recorded `/v1/alerts/active.json` response driven
 * through `syncAlertsInUa` end to end — the normalizer, the type gate, the catalogue lookup, the
 * snapshot pass and the source-health bookkeeping.
 *
 * ## Why this file exists
 *
 * Until 22.09.2026 this source had never once completed a poll. The normalizer read the row's `id`
 * — the ALERT's id — as the location key and never read `location_title`, so every row reached
 * `resolveLocationId` as a bare number, nothing resolved, and `sources.last_error` carried «no
 * provider locations matched local locations (8757, 28288, 76016, 76017, 185413)» for as long as a
 * token was configured. Every existing test fed the adapter a hand-written `region_id`/`region_name`
 * body, which is a shape alerts.in.ua does not send, so the suite was green over a source that could
 * not work. This file feeds it the shape it DOES send
 * (`tests/fixtures/alerts-in-ua-active-levels.json`, seven rows cut unedited from a live 43-alert
 * response) and asserts where each row lands. `src/services/ingestion.test.ts` pins the normalizer
 * on the same fixture; what only this file can show is the catalogue row each label becomes.
 *
 * ## Why this file seeds raions
 *
 * The same reason as `aerial-mirror.test.ts`: the raion and hromada tiers are written by the KATOTTG
 * importer at runtime, so a migrated-but-never-synced database has the oblasts and nothing beneath
 * them. The rows below are built with the importer's own `raionAliases`/`hromadaAliases`, and every
 * id starts `test-`, which is what `resetDatabase()` deletes. The seeding is IDENTICAL in every test
 * on purpose: `resolveLocationId` memoises answers for as long as the lexeme cache lives, and a test
 * that seeded a different catalogue would read the previous test's answers.
 *
 * Two rows are decoys, and say so in their ids. Each shares its name with a real row, so the name
 * alone is a tie `pickLocationMatch` refuses; the only thing that can break the tie is the parent the
 * feed files the row under. That is how these tests tell «resolved by the right parent» apart from
 * «resolved because there was only one candidate».
 */

const ALERTS_IN_UA_URL = 'https://api.alerts.in.ua/v1/alerts/active.json';
const SOURCE = 'alerts-in-ua';

/** Oblast rows seeded by `001_init.sql`. */
const LUHANSK = 'ua-44';
const DONETSK = 'ua-14';
const KIROVOHRAD = 'ua-35';
const KHARKIV = 'ua-63';
const DNIPRO = 'ua-12';

const POKROVSK_RAION = 'test-raion-pokrovskyi';
const OLEKSANDRIIA_RAION = 'test-raion-oleksandriiskyi';
const KHARKIV_RAION = 'test-raion-kharkivskyi';
const CHUHUIV_RAION = 'test-raion-chuhuivskyi';
const VOVCHANSK = 'test-hromada-vovchanska';
/**
 * Покровський район Дніпропетровщини існував до реформи 2020 року, тож назва сама по собі не
 * однозначна; розводить їх лише `location_oblast`.
 */
const POKROVSK_RAION_DECOY = 'test-decoy-raion-pokrovskyi-ua-12';
/**
 * Вигадана: друга Вовчанська громада в ТІЙ САМІЙ області, але в іншому районі. `location_oblast` її
 * не відрізняє — відрізняє лише `location_raion`, і саме це вона тут доводить.
 */
const VOVCHANSK_DECOY = 'test-decoy-hromada-vovchanska-kharkivskyi';

/** `[raion id, oblast id, raion stem, [[hromada id, hromada stem], …]]`. */
const SEEDED: Array<[string, string, string, Array<[string, string]>]> = [
  [POKROVSK_RAION, DONETSK, 'Покровський', []],
  [POKROVSK_RAION_DECOY, DNIPRO, 'Покровський', []],
  [OLEKSANDRIIA_RAION, KIROVOHRAD, 'Олександрійський', []],
  [KHARKIV_RAION, KHARKIV, 'Харківський', [[VOVCHANSK_DECOY, 'Вовчанська']]],
  [CHUHUIV_RAION, KHARKIV, 'Чугуївський', [[VOVCHANSK, 'Вовчанська']]]
];

async function seedCatalogue(): Promise<void> {
  const { hromadaAliases, hromadaName, raionAliases } = await import('../../src/services/location-catalog.js');
  for (const [id, parent, stem, hromadas] of SEEDED) {
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,aliases) VALUES ($1,$2,'raion',$3,$4)`,
      [id, parent, `${stem} район`, raionAliases(stem)]
    );
    for (const [hromadaId, hromadaStem] of hromadas) {
      await sql(
        `INSERT INTO locations(id,parent_id,type,name_uk,aliases) VALUES ($1,$2,'hromada',$3,$4)`,
        [hromadaId, id, hromadaName(hromadaStem), hromadaAliases(hromadaStem)]
      );
    }
  }
}

type FixtureAlert = Record<string, unknown> & { id: number; alert_type: string };

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/alerts-in-ua-active-levels.json', import.meta.url), 'utf8')
) as { alerts: FixtureAlert[]; meta: Record<string, unknown> };

/** The recorded body, with any row replaced wholesale by `rewrite`. Never mutates the fixture. */
function recorded(rewrite: (alert: FixtureAlert) => FixtureAlert = (alert) => alert): unknown {
  return { ...FIXTURE, alerts: FIXTURE.alerts.map((alert) => rewrite({ ...alert })) };
}

let body: unknown;

async function poll(): Promise<void> {
  const { syncAlertsInUa } = await import('../../src/services/ingestion.js');
  await syncAlertsInUa();
}

interface StateRow {
  location_id: string;
  parent_id: string | null;
  alert_type: string;
  active: boolean;
  external_id: string;
  alert_level: string | null;
  alert_kind: string | null;
}

async function sourceStates(): Promise<StateRow[]> {
  const rows = await sql<StateRow>(
    `SELECT s.location_id,l.parent_id,s.alert_type,s.active,s.external_id,s.alert_level,s.alert_kind
       FROM alert_source_states s JOIN locations l ON l.id=s.location_id
      WHERE s.source_id=$1 ORDER BY s.location_id,s.alert_type`,
    [SOURCE]
  );
  return rows.rows;
}

async function sourceHealth(): Promise<{ health_status: string; last_error: string | null }> {
  const rows = await sql<{ health_status: string; last_error: string | null }>(
    `SELECT health_status,last_error FROM sources WHERE id=$1`, [SOURCE]
  );
  return rows.rows[0]!;
}

/** `threatlens_alarm_records_dropped_total` for this source, by reason. Module-level, so read deltas. */
async function droppedByReason(): Promise<Record<string, number>> {
  const { registerPublicationMetrics } = await import('../../src/services/publication.js');
  const registry = new Registry();
  registerPublicationMetrics(registry);
  const metric = await registry.getSingleMetric('threatlens_alarm_records_dropped_total')!.get();
  return Object.fromEntries(metric.values
    .filter((value) => value.labels.source === SOURCE)
    .map((value) => [String(value.labels.reason), value.value]));
}

describe.skipIf(!integrationDatabaseAvailable)('alerts.in.ua as the live API sends it', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    await seedCatalogue();
    body = recorded();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url !== ALERTS_IN_UA_URL) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => body };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lands every air-raid row of the recorded response on its own catalogue row', async () => {
    await poll();

    // Чотири повітряні тривоги — чотири рядки каталогу, кожен під тією областю, яку назвав фід.
    // Покровський район — донецький, а не дніпровський двійник: розвела їх лише `location_oblast`.
    expect(await sourceStates()).toEqual([
      { location_id: KHARKIV_RAION, parent_id: KHARKIV, alert_type: 'air_raid', active: true,
        external_id: '265568', alert_level: 'yellow', alert_kind: null },
      { location_id: OLEKSANDRIIA_RAION, parent_id: KIROVOHRAD, alert_type: 'air_raid', active: true,
        external_id: '265383', alert_level: 'yellow', alert_kind: 'drones' },
      { location_id: POKROVSK_RAION, parent_id: DONETSK, alert_type: 'air_raid', active: true,
        external_id: '264928', alert_level: 'red', alert_kind: 'missiles' },
      // Область, а не Луганськ: місто несе відмінкову форму «луганська» як аліас і колись саме так
      // перехоплювало область. `001_init.sql` лишає областям `parent_id` порожнім.
      { location_id: LUHANSK, parent_id: null, alert_type: 'air_raid', active: true,
        external_id: '8757', alert_level: 'red', alert_kind: null }
    ]);
  });

  it('reports the source healthy with nothing left unmapped — the old error is gone', async () => {
    await poll();

    expect(await sourceHealth()).toEqual({ health_status: 'current', last_error: null });
    const { unresolvedLocationReports } = await import('../../src/services/ingestion.js');
    expect(unresolvedLocationReports().find((report) => report.sourceId === SOURCE))
      .toMatchObject({ count: 0, samples: [] });
  });

  it('opens an air-raid period per location and nothing for shelling or urban fighting', async () => {
    const before = await droppedByReason();
    await poll();
    const after = await droppedByReason();

    const periods = await sql<{ location_id: string; alert_type: string; status: string; started_at: string }>(
      `SELECT location_id,alert_type,status,started_at::text FROM alert_periods ORDER BY location_id`
    );
    expect(periods.rows.map(({ location_id, alert_type, status }) => ({ location_id, alert_type, status }))).toEqual([
      { location_id: KHARKIV_RAION, alert_type: 'air_raid', status: 'active' },
      { location_id: OLEKSANDRIIA_RAION, alert_type: 'air_raid', status: 'active' },
      { location_id: POKROVSK_RAION, alert_type: 'air_raid', status: 'active' },
      { location_id: LUHANSK, alert_type: 'air_raid', status: 'active' }
    ]);
    // Луганщина стоїть з 04.04.2022, і період каже саме це, а не «з моменту першого опитування».
    expect(new Date(periods.rows.at(-1)!.started_at).toISOString()).toBe('2022-04-04T16:45:39.000Z');
    // Три рядки, яких система свідомо не пише, — видимі на лічильнику, а не зниклі мовчки.
    expect((after.artillery ?? 0) - (before.artillery ?? 0)).toBe(2);
    expect((after.urban_fighting ?? 0) - (before.urban_fighting ?? 0)).toBe(1);
  });

  it('narrows a hromada by its raion, which its oblast alone cannot', async () => {
    // Той самий рядок Вовчанської, якби він був повітряною тривогою. Дві Вовчанські лежать в одній
    // області, тож `location_oblast` лишив би нічию і рядок не ліг би нікуди; `location_raion` —
    // Чугуївський — розводить їх.
    body = recorded((alert) => (alert.id === 76016 ? { ...alert, alert_type: 'air_raid' } : alert));

    await poll();

    const hromadas = (await sourceStates()).filter((row) => row.location_id.includes('hromada'));
    expect(hromadas).toEqual([
      { location_id: VOVCHANSK, parent_id: CHUHUIV_RAION, alert_type: 'air_raid', active: true,
        external_id: '76016', alert_level: 'red', alert_kind: null }
    ]);
    expect(await sourceHealth()).toEqual({ health_status: 'current', last_error: null });
  });

  it('still refuses a snapshot whose air-raid rows all miss the catalogue', async () => {
    // Запобіжник мусить пережити виправлення: «прийшли тривоги, і жодна не лягла» — це зламане
    // читання, а не тихий нуль. І тепер він називає МІСЦЯ, а не номери тривог.
    body = recorded((alert) => (alert.alert_type === 'air_raid'
      ? { ...alert, location_title: `Неіснуючий район ${alert.id}`, location_oblast: 'Неіснуюча область' }
      : alert));

    await expect(poll()).rejects.toThrow(
      /^alerts-in-ua: no provider locations matched local locations \(Неіснуючий район 8757, /
    );

    expect(await sourceStates()).toEqual([]);
    expect((await sql(`SELECT 1 FROM alert_periods`)).rowCount).toBe(0);
    const health = await sourceHealth();
    expect(health.health_status).toBe('error');
    expect(health.last_error).toMatch(/no provider locations matched/);
  });

  it('accepts a snapshot that carries only shelling and urban fighting', async () => {
    // Запобіжник рахує від ВІДФІЛЬТРОВАНИХ рядків: відповідь, у якій були самі обстріли, нічого не
    // втратила — у ній просто немає повітряних тривог — і падати не повинна.
    body = { ...FIXTURE, alerts: FIXTURE.alerts.filter((alert) => alert.alert_type !== 'air_raid') };

    await poll();

    expect(await sourceStates()).toEqual([]);
    expect(await sourceHealth()).toEqual({ health_status: 'current', last_error: null });
  });
});
