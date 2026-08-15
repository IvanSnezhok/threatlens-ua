import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * The community aerial-alert mirror against live PostgreSQL: `syncAerialMirror` end to end.
 *
 * `src/sources/aerial-mirror.test.ts` covers the two parsers in isolation. What can only be shown
 * here is what their refusals do to stored state — and the property worth the whole file is that a
 * mirror which has frozen leaves `alert_periods` exactly as it found them. A unit test can assert a
 * throw; only this one can assert that nothing was cleared.
 *
 * The adapter is driven through its exported entry point with `fetch` stubbed, the same shape
 * `alert-reconciliation.test.ts` uses for the two token APIs, so URL handling, the staleness gate and
 * the source-health bookkeeping are all on the path under test. The stub answers by URL, because
 * this adapter now has two of them: `?source=ual&raw` is the primary and the bare URL is the
 * fallback, and half the behaviour under test is the choice between them.
 *
 * ## Why this file seeds raions
 *
 * The raion tier is written by the KATOTTG importer at runtime (`src/services/location-catalog.ts`),
 * not by a migration, so a migrated-but-never-synced database — which is what the integration
 * harness gives every file — carries oblasts, cities and exactly two raions. The rows seeded below
 * are built the way `planCatalogImport` builds them, `raionAliases` included, so the hromada
 * spellings under test are the catalogue's own convention rather than a shape invented here. Every
 * seeded id starts `test-`, which is what `resetDatabase()` deletes.
 */

const MIRROR_URL = 'https://ubilling.net.ua/aerialalerts/';
const RAW_URL = 'https://ubilling.net.ua/aerialalerts/?source=ual&raw=';
const SOURCE = 'aerial-alerts-mirror';

/** Oblasts the aggregated fixture reports alight, and their catalogue ids. */
const DONETSK = 'ua-14';
const LUHANSK = 'ua-44';
const SUMY = 'ua-59';
const KYIV_CITY = 'ua-80';
const CRIMEA = 'ua-43';
const KHARKIV_CITY = 'ua-city-kharkiv';

/** Seeded raions, by the label the `ual` feed prints for them. */
const SUMY_RAION = 'test-raion-sumskyi';
const KHARKIV_RAION = 'test-raion-kharkivskyi';
const CHUHUIV_RAION = 'test-raion-chuhuivskyi';
const POKROVSK_RAION = 'test-raion-pokrovskyi';
const SYNELNYKOVE_RAION = 'test-raion-synelnykivskyi';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/aerial-mirror-snapshot.json', import.meta.url), 'utf8')
) as { source: string; cachedat: string; states: Record<string, { alertnow: boolean; changed: string }> };

/**
 * A real `?source=ual&raw` capture, unedited. See the unit test for what it contains and why that
 * one capture was kept.
 */
const RAW_FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/aerial-mirror-raw-ual.json', import.meta.url), 'utf8')
) as { source: string; cachedat: string; raw: Array<Record<string, unknown>> };

/**
 * The captured payload with `cachedat` moved to now, so the staleness gate sees a live mirror.
 *
 * Every test that wants a *fresh* response has to go through this: the fixture's own stamp is from
 * the day it was captured and would be refused, which is the gate working.
 */
function fresh(overrides: Record<string, { alertnow: boolean; changed: string }> = {}): unknown {
  return { ...FIXTURE, cachedat: kyivNow(0), states: { ...FIXTURE.states, ...overrides } };
}

/** «YYYY-MM-DD HH:MM:SS» in Europe/Kyiv, `secondsAgo` in the past — the format the feed prints. */
function kyivNow(secondsAgo: number): string {
  const at = new Date(Date.now() - secondsAgo * 1000);
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Every region quiet — a valid all-clear when the stamp is fresh, a catastrophe when it is not. */
function allQuiet(cachedat: string): unknown {
  return {
    ...FIXTURE,
    cachedat,
    states: Object.fromEntries(
      Object.keys(FIXTURE.states).map((name) => [name, { alertnow: false, changed: kyivNow(120) }])
    )
  };
}

/** The captured `?source=ual&raw` payload with its stamp moved to now, and an optional `raw` list. */
function freshRaw(raw: unknown = RAW_FIXTURE.raw): unknown {
  return { source: RAW_FIXTURE.source, cachedat: kyivNow(0), raw };
}

/** One `raw[]` entry the way the `ual` passthrough spells them. */
function rawEntry(
  regionName: string, regionType: string, types: string[] = ['AIR']
): Record<string, unknown> {
  const lastUpdate = new Date(Date.now() - 600_000).toISOString();
  return {
    regionId: '1', regionType, regionName, regionEngName: '', lastUpdate,
    activeAlerts: types.map((type) => ({ regionId: '1', regionType, type, lastUpdate }))
  };
}

interface StubResponse { ok: boolean; status: number; body: unknown }

/** The bare URL's answer — the aggregated oblast feed. */
let response: StubResponse;
/** The `?source=ual&raw` answer. */
let rawResponse: StubResponse;

async function poll(): Promise<void> {
  const { syncAerialMirror } = await import('../../src/services/ingestion.js');
  await syncAerialMirror();
}

async function activePeriods(): Promise<string[]> {
  const rows = await sql<{ location_id: string }>(
    `SELECT location_id FROM alert_periods WHERE status='active' ORDER BY location_id`
  );
  return rows.rows.map((row) => row.location_id);
}

async function holdingLocations(): Promise<string[]> {
  const rows = await sql<{ location_id: string }>(
    `SELECT location_id FROM alert_source_states WHERE source_id=$1 AND active ORDER BY location_id`,
    [SOURCE]
  );
  return rows.rows.map((row) => row.location_id);
}

async function sourceHealth(): Promise<{ health_status: string; last_error: string | null }> {
  const rows = await sql<{ health_status: string; last_error: string | null }>(
    `SELECT health_status,last_error FROM sources WHERE id=$1`, [SOURCE]
  );
  return rows.rows[0]!;
}

/** Ages recorded absences past `ALERT_END_DEBOUNCE_SECONDS`; see alert-reconciliation.test.ts. */
async function ageAbsencesPastDebounce(): Promise<void> {
  await sql(
    `UPDATE alert_source_states SET missing_since=now()-interval '1 hour'
     WHERE missing_since IS NOT NULL AND source_id=$1`, [SOURCE]
  );
}

async function withConfig<T>(overrides: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const { config } = await import('../../src/config.js');
  const mutable = config as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, mutable[key]]));
  Object.assign(mutable, overrides);
  try {
    return await body();
  } finally {
    Object.assign(mutable, saved);
  }
}

/**
 * Applies config overrides for the enclosing `describe` and puts them back afterwards.
 *
 * The block form of `withConfig`, needed because whole sections of this file describe one *mode* of
 * the adapter rather than one call: `AERIAL_MIRROR_RAW_SOURCE=''` is the oblast-only path this
 * source shipped with, and it has to keep working unchanged.
 */
function useConfig(overrides: Record<string, unknown>): void {
  let saved: Record<string, unknown> = {};
  beforeEach(async () => {
    const { config } = await import('../../src/config.js');
    const mutable = config as unknown as Record<string, unknown>;
    saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, mutable[key]]));
    Object.assign(mutable, overrides);
  });
  afterEach(async () => {
    const { config } = await import('../../src/config.js');
    Object.assign(config as unknown as Record<string, unknown>, saved);
  });
}

/**
 * The raion rows this file needs, built the way the KATOTTG importer builds them.
 *
 * `raionAliases` is imported rather than reproduced: the Community→raion fold under test is exactly
 * the aliases that function emits («Вовчанська територіальна громада» on Чугуївський район), and a
 * hand-written alias list here would be a test of itself. Покровська appears on TWO raions on
 * purpose — Донеччина and Дніпропетровщина both have one, which makes that hromada name genuinely
 * ambiguous, and ambiguity resolving to nothing is a property this file asserts.
 */
async function seedRaions(): Promise<void> {
  const { raionAliases } = await import('../../src/services/location-catalog.js');
  const rows: Array<[string, string, string, string, string[]]> = [
    [SUMY_RAION, 'ua-59', 'Сумський район', 'Сумський', ['Сумська', 'Краснопільська']],
    [KHARKIV_RAION, 'ua-63', 'Харківський район', 'Харківський', ['Липецька', 'Пісочинська']],
    [CHUHUIV_RAION, 'ua-63', 'Чугуївський район', 'Чугуївський', ['Вовчанська', 'Печенізька']],
    [POKROVSK_RAION, 'ua-14', 'Покровський район', 'Покровський', ['Покровська', 'Гродівська']],
    [SYNELNYKOVE_RAION, 'ua-12', 'Синельниківський район', 'Синельниківський', ['Покровська']]
  ].map(([id, parent, nameUk, stem, hromadas]) => [
    id as string, parent as string, nameUk as string, stem as string,
    raionAliases(stem as string, hromadas as string[])
  ]);
  for (const [id, parent, nameUk, , aliases] of rows) {
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,aliases) VALUES ($1,$2,'raion',$3,$4)`,
      [id, parent, nameUk, aliases]
    );
  }
}

describe.skipIf(!integrationDatabaseAvailable)('community aerial-alert mirror', () => {
  let fetchCalls: string[];

  beforeAll(ensureMigrated);

  // Zero gap between the two requests: the sequencing is asserted by one test that sets a real
  // value, and every other test would only be paying for it.
  useConfig({ AERIAL_MIRROR_REQUEST_GAP_MS: 0 });

  beforeEach(async () => {
    await resetDatabase();
    await seedRaions();
    fetchCalls = [];
    response = { ok: true, status: 200, body: fresh() };
    rawResponse = { ok: true, status: 200, body: freshRaw() };
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      fetchCalls.push(url);
      const chosen = url.includes('raw') ? rawResponse : response;
      return { ok: chosen.ok, status: chosen.status, json: async () => chosen.body };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('registration', () => {
    it('registers one enabled, tier A snapshot source in its own independence group', async () => {
      const rows = await sql<Record<string, unknown>>(
        `SELECT tier,official,enabled,source_type,adapter_type,independence_group,
                expected_update_interval_seconds,stale_after_seconds,public_url
           FROM sources WHERE id=$1`, [SOURCE]
      );
      expect(rows.rows[0]).toMatchObject({
        tier: 'A', official: true, enabled: true, source_type: 'api',
        adapter_type: 'aerial_alerts_mirror', independence_group: 'community-alert-mirror',
        expected_update_interval_seconds: 15, stale_after_seconds: 300,
        public_url: MIRROR_URL
      });
    });

    it('shares its independence group with no other source', async () => {
      // The point of the group. `?source=default` may be serving Alerts.in.ua or Ukraine Alarm on
      // any given poll, so pooling it with `official-civil-alerts` would let one upstream
      // corroborate itself.
      const rows = await sql<{ id: string }>(
        `SELECT id FROM sources WHERE independence_group='community-alert-mirror'`
      );
      expect(rows.rows.map((row) => row.id)).toEqual([SOURCE]);
    });
  });

  // ============================================================================================
  // Oblast-only mode: the path this source shipped with, kept working
  // ============================================================================================

  /**
   * `AERIAL_MIRROR_RAW_SOURCE=''` is the documented full retreat — one request per poll against the
   * aggregated `states` object, twenty-five oblast rows, no raion and no hromada. It exists so that
   * an upstream reshaping its native body is a config change rather than an outage, which is only
   * true if this path stays exercised. Every test in this section predates the granularity upgrade
   * and is unchanged by it.
   */
  describe("oblast-only mode (AERIAL_MIRROR_RAW_SOURCE='')", () => {
    useConfig({ AERIAL_MIRROR_RAW_SOURCE: '' });
    describe('polling', () => {
      it('raises an alert for every region the mirror reports alight', async () => {
        await poll();

        expect(fetchCalls).toEqual([MIRROR_URL]);
        // The seven the captured fixture has alight, mapped to oblast ids.
        expect(await holdingLocations()).toEqual(
          ['ua-12', DONETSK, 'ua-23', LUHANSK, SUMY, 'ua-63', 'ua-74'].sort()
        );
        expect(await activePeriods()).toEqual(
          ['ua-12', DONETSK, 'ua-23', LUHANSK, SUMY, 'ua-63', 'ua-74'].sort()
        );
        expect((await sourceHealth()).health_status).toBe('current');
      });

      /**
       * The regression guard for the resolution bug this source uncovered.
       *
       * The catalogue gives the occupied oblast capitals their declined forms as aliases — `донецька`
       * on Донецьк, `луганська` on Луганськ — and the resolver used to strip «область» BEFORE
       * querying, so «Донецька область» became `донецька`, hit the city alias exactly, and outranked
       * the oblast it actually names. Донеччина and Луганщина are alight in almost every snapshot this
       * feed serves, so the wrong row was one of the loudest on the map.
       */
      it('resolves «<X>ська область» to the oblast, never to the oblast capital', async () => {
        await poll();

        const held = await holdingLocations();
        expect(held).toContain(DONETSK);
        expect(held).toContain(LUHANSK);
        expect(held).not.toContain('ua-city-donetsk');
        expect(held).not.toContain('ua-city-luhansk');

        const types = await sql<{ type: string }>(
          `SELECT DISTINCT l.type FROM alert_source_states s JOIN locations l ON l.id=s.location_id
            WHERE s.source_id=$1`, [SOURCE]
        );
        // Kyiv city is the one non-oblast row the feed carries, and it is a special_city.
        expect(types.rows.map((row) => row.type).sort()).toEqual(['oblast', 'special_city']);
      });

      it('reads «м. Київ» as the city and holds all twenty-five regions as state rows', async () => {
        await poll();

        const all = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM alert_source_states WHERE source_id=$1`, [SOURCE]
        );
        // Every region is forwarded, alight or not, so name resolution is exercised for all of them
        // on every poll rather than only for whatever happens to be alight.
        expect(Number(all.rows[0]!.n)).toBe(25);
        const kyiv = await sql<{ active: boolean }>(
          `SELECT active FROM alert_source_states WHERE source_id=$1 AND location_id=$2`,
          [SOURCE, KYIV_CITY]
        );
        expect(kyiv.rows[0]!.active).toBe(false);
      });

      it('clears an alert only after the end debounce has elapsed', async () => {
        await poll();
        expect(await activePeriods()).toContain(SUMY);

        // The mirror now says Sumy is quiet. The alert must survive the poll that says so.
        response.body = fresh({ 'Сумська область': { alertnow: false, changed: kyivNow(30) } });
        await poll();
        expect(await holdingLocations()).not.toContain(SUMY);
        expect(await activePeriods()).toContain(SUMY);

        await ageAbsencesPastDebounce();
        await poll();
        expect(await activePeriods()).not.toContain(SUMY);

        const ended = await sql<{ event_type: string }>(
          `SELECT event_type FROM system_event_log WHERE event_type='alert.ended'`
        );
        expect(ended.rowCount).toBeGreaterThan(0);
      });

      it('accepts a genuine nationwide all-clear when the stamp is fresh', async () => {
        // The mirror is allowed to end everything — that is what a quiet country looks like. Only the
        // freshness of the claim separates this test from the one below it.
        await poll();
        expect(await activePeriods()).not.toHaveLength(0);

        response.body = allQuiet(kyivNow(2));
        await poll();
        await ageAbsencesPastDebounce();
        await poll();

        expect(await activePeriods()).toEqual([]);
        expect((await sourceHealth()).health_status).toBe('current');
      });
    });

    describe('a frozen mirror must never mass-clear', () => {
      /**
       * The safety property the source exists under.
       *
       * A mirror whose upstream has died keeps answering 200 with a structurally perfect body in which
       * every region is quiet. Believed, it clears the whole country. The staleness gate turns it into
       * a source error before `persistOfficialAlertSnapshot` is ever entered, so the alerts stay held
       * and the operator sees an unhealthy source instead of a quiet map.
       */
      it('refuses a stale all-quiet payload and leaves every alert standing', async () => {
        await poll();
        const raisedPeriods = await activePeriods();
        const raisedStates = await holdingLocations();
        expect(raisedPeriods).toHaveLength(7);

        // Same body as the accepted all-clear above; only `cachedat` is old.
        response.body = allQuiet(kyivNow(600));
        await expect(poll()).rejects.toThrow(/stale/);

        expect(await activePeriods()).toEqual(raisedPeriods);
        expect(await holdingLocations()).toEqual(raisedStates);
        const health = await sourceHealth();
        expect(health.health_status).toBe('error');
        expect(health.last_error).toMatch(/aerial mirror is stale/);
        // Nothing was written to the source's rows at all: no absence was even recorded, so the
        // debounce cannot start counting down while the mirror is frozen.
        const missing = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM alert_source_states WHERE source_id=$1 AND missing_since IS NOT NULL`,
          [SOURCE]
        );
        expect(Number(missing.rows[0]!.n)).toBe(0);
      });

      it('does not let a frozen mirror expire alerts by repetition', async () => {
        await poll();
        response.body = allQuiet(kyivNow(3600));
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await expect(poll()).rejects.toThrow(/stale/);
        }
        await ageAbsencesPastDebounce();
        await expect(poll()).rejects.toThrow(/stale/);

        expect(await activePeriods()).toHaveLength(7);
      });

      it('recovers on the first fresh response after a freeze', async () => {
        await poll();
        response.body = allQuiet(kyivNow(900));
        await expect(poll()).rejects.toThrow(/stale/);
        expect((await sourceHealth()).health_status).toBe('error');

        response.body = allQuiet(kyivNow(1));
        await poll();
        await ageAbsencesPastDebounce();
        await poll();

        expect(await activePeriods()).toEqual([]);
        expect((await sourceHealth()).health_status).toBe('current');
      });

      it('treats an HTTP failure as a source error and holds its alerts', async () => {
        await poll();
        response = { ok: false, status: 429, body: null };
        await expect(poll()).rejects.toThrow(/Aerial alert mirror 429/);

        expect(await activePeriods()).toHaveLength(7);
        expect((await sourceHealth()).health_status).toBe('error');
      });

      it('treats a truncated body as a source error, not as an empty snapshot', async () => {
        // Observed during research: two requests inside the same second and the endpoint's 2 rps limit
        // cut the response short. A partial body must never read as «no alerts anywhere».
        await poll();
        response.body = { source: 'Mørk Skogen API (default)', cachedat: kyivNow(1) };
        await expect(poll()).rejects.toThrow(/carries no `states` object/);

        expect(await activePeriods()).toHaveLength(7);
        expect((await sourceHealth()).health_status).toBe('error');
      });
    });

    describe('unknown regions', () => {
      it('refuses a region it cannot map and reports it as a catalogue gap', async () => {
        response.body = fresh({ 'Верхньодвінська область': { alertnow: true, changed: kyivNow(60) } });
        await poll();

        const { unresolvedLocationReports } = await import('../../src/services/ingestion.js');
        const report = unresolvedLocationReports().find((entry) => entry.sourceId === SOURCE);
        expect(report?.samples).toContain('Верхньодвінська область');
        // A gap is not an outage: the rest of the snapshot still applied and the source stays healthy.
        expect((await sourceHealth()).health_status).toBe('current');
        expect(await holdingLocations()).toContain(SUMY);
      });

      it('fails the whole poll when nothing in the response maps, rather than clearing', async () => {
        await poll();
        response.body = {
          source: 'x', cachedat: kyivNow(1),
          states: { 'Атлантида': { alertnow: true, changed: kyivNow(60) } }
        };
        await expect(poll()).rejects.toThrow(/no provider locations matched/);

        expect(await activePeriods()).toHaveLength(7);
      });
    });

    describe('kill switch', () => {
      it('does not poll at all when AERIAL_MIRROR_ENABLED is off', async () => {
        await withConfig({ AERIAL_MIRROR_ENABLED: false }, async () => {
          await poll();
        });

        expect(fetchCalls).toEqual([]);
        expect(await activePeriods()).toEqual([]);
        const states = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM alert_source_states WHERE source_id=$1`, [SOURCE]
        );
        expect(Number(states.rows[0]!.n)).toBe(0);
        expect((await sourceHealth()).health_status).toBe('unknown');
      });

      it('leaves the alerts it was holding in place when switched off mid-flight', async () => {
        // Documented in docs/OPERATIONS.md: the switch stops the source being READ, it does not
        // withdraw what it was holding — `expireStuckAlertChannelAlerts` sweeps alert channels only.
        await poll();
        expect(await activePeriods()).toHaveLength(7);

        await withConfig({ AERIAL_MIRROR_ENABLED: false }, async () => {
          await poll();
        });

        expect(await activePeriods()).toHaveLength(7);
        expect(fetchCalls).toEqual([MIRROR_URL]);
      });

      it('honours a configured URL', async () => {
        await withConfig({ AERIAL_MIRROR_URL: 'https://mirror.test/alerts' }, async () => {
          await poll();
        });
        expect(fetchCalls).toEqual(['https://mirror.test/alerts']);
      });

      it('honours a tightened staleness bound', async () => {
        response.body = fresh();
        (response.body as { cachedat: string }).cachedat = kyivNow(90);
        await withConfig({ AERIAL_MIRROR_STALE_SECONDS: 60 }, async () => {
          await expect(poll()).rejects.toThrow(/stale/);
        });
        // The same response is accepted under the default 300s bound.
        await poll();
        expect((await sourceHealth()).health_status).toBe('current');
      });
    });
  });
  // ============================================================================================
  // Full granularity: the `?source=ual&raw` passthrough
  // ============================================================================================

  /**
   * What the upgrade is for.
   *
   * The aggregated feed can say «Харківська область» and nothing finer, so an alert over one raion
   * lit the whole oblast on the map. The `ual` passthrough publishes `State`, `District` and
   * `Community` entries, and the catalogue already knows how to read all three: the resolver's
   * literal-first lookup handles «X район», and `raionAliases` folds «X територіальна громада» into
   * the raion that contains it. Nothing about resolution was changed for this — the labels simply
   * started arriving.
   */
  describe('raion and hromada granularity', () => {
    it('runs against a catalogue with no KATOTTG import, which the counts below assume', async () => {
      // The precondition, asserted rather than assumed, because failing it would look like a bug in
      // the adapter. `KATOTTG_SYNC_ENABLED=false` in the harness and no integration file imports the
      // workbook, so the only non-seeded raions are migration 026's two renamed ones. A database
      // that HAS been synced would resolve far more of the capture's District labels and every exact
      // count in this section would be measuring a different catalogue.
      const rows = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM locations WHERE type='raion' AND id NOT LIKE 'test-%'`
      );
      expect(Number(rows.rows[0]!.n)).toBe(2);
    });

    it('holds raions, hromadas-folded-to-raions and oblasts from one real capture', async () => {
      await poll();

      // One request. The aggregated feed is consulted only when the raw one comes back empty or is
      // refused, so the steady state costs exactly what the old oblast-only poll cost.
      expect(fetchCalls).toEqual([RAW_URL]);

      // Nine of the capture's thirty-one air-raid labels name a location this database carries; they
      // fold to seven distinct rows (see the dedupe test below for the two that collide).
      expect(await holdingLocations()).toEqual([
        CHUHUIV_RAION, KHARKIV_RAION, POKROVSK_RAION, SUMY_RAION, CRIMEA, KHARKIV_CITY, LUHANSK
      ].sort());
      expect(await activePeriods()).toEqual([
        CHUHUIV_RAION, KHARKIV_RAION, POKROVSK_RAION, SUMY_RAION, CRIMEA, KHARKIV_CITY, LUHANSK
      ].sort());
      expect((await sourceHealth()).health_status).toBe('current');
    });

    it('puts alerts on rows the aggregated feed cannot address at all', async () => {
      await poll();

      const types = await sql<{ type: string; n: string }>(
        `SELECT l.type,count(*)::text AS n FROM alert_source_states s JOIN locations l ON l.id=s.location_id
          WHERE s.source_id=$1 GROUP BY l.type ORDER BY l.type`, [SOURCE]
      );
      // Before this change every row here was `oblast` or `special_city`, because those were the only
      // labels the feed had. Four raions is the whole point.
      expect(types.rows).toEqual([
        { type: 'city', n: '1' }, { type: 'oblast', n: '2' }, { type: 'raion', n: '4' }
      ]);
    });

    it('carries Crimea, which the aggregated feed has no row for in any state', async () => {
      await poll();
      expect(await holdingLocations()).toContain(CRIMEA);
      expect(Object.keys(FIXTURE.states)).not.toContain('Автономна Республіка Крим');
    });

    it('resolves a hromada to its raion through the catalogue aliases', async () => {
      // «Вовчанська територіальна громада» is not a catalogue row — the catalogue is deliberately
      // three-tier — so it lands on Чугуївський район, which contains it. No District entry for that
      // raion is present here: the hromada alone raises it.
      rawResponse.body = freshRaw([rawEntry('Вовчанська територіальна громада', 'Community')]);
      await poll();

      expect(await holdingLocations()).toEqual([CHUHUIV_RAION]);
      expect(await activePeriods()).toEqual([CHUHUIV_RAION]);
    });

    it('reports how old the data in the feed was, per feed', async () => {
      // Ціна деталізації, зроблена видимою. Виміряно на бойовому дзеркалі 15.08.2026: агрегований
      // фід оновлюється за ~3 с, а `?source=ual&raw` — рівно раз на 121 с. Тобто громадна
      // деталізація коштує в середньому хвилини затримки попередження, і доти це число ніде не
      // зберігалося: `ageSeconds` рахувався лише для того, щоб кинути виняток на замерзлому
      // дзеркалі, і зникав.
      const { registerPublicationMetrics } = await import('../../src/services/publication.js');
      rawResponse.body = { source: RAW_FIXTURE.source, cachedat: kyivNow(90), raw: RAW_FIXTURE.raw };
      await poll();

      const registry = new Registry();
      registerPublicationMetrics(registry);
      const text = await registry.metrics();
      const sample = new RegExp(
        `threatlens_source_cache_age_seconds\\{source="${SOURCE}",feed="raw"\\} (\\d+)`
      ).exec(text);
      expect(sample).not.toBeNull();
      // Не рівність: `cachedat` друкується з точністю до секунди, тож між ним і `now` завжди є
      // дробовий залишок, і `Math.round` дає 90 або 91 залежно від того, о котрій частці секунди
      // почався тест. Перша редакція вимагала рівно 90 і падала в повному прогоні, а поодинці
      // проходила — рівність тут була б не суворістю, а невідтворюваністю.
      expect(Number(sample![1])).toBeGreaterThanOrEqual(90);
      expect(Number(sample![1])).toBeLessThanOrEqual(91);
    });

    it('resolves an ambiguous hromada name to nothing, and says so', async () => {
      // Донеччина and Дніпропетровщина both have a Покровська hromada, so both raions carry the
      // alias and `pickLocationMatch` refuses to guess. Silence is the safe outcome: raising the
      // wrong raion is worse than raising none, and the unresolved report makes the gap visible.
      rawResponse.body = freshRaw([
        rawEntry('Покровська територіальна громада', 'Community'),
        rawEntry('Сумський район', 'District')
      ]);
      await poll();

      expect(await holdingLocations()).toEqual([SUMY_RAION]);
      const { unresolvedLocationReports } = await import('../../src/services/ingestion.js');
      const report = unresolvedLocationReports().find((entry) => entry.sourceId === SOURCE);
      expect(report?.samples).toContain('Покровська територіальна громада');
      expect((await sourceHealth()).health_status).toBe('current');
    });

    it('reports every label this database has no row for as a catalogue gap, not an outage', async () => {
      await poll();

      const { unresolvedLocationReports } = await import('../../src/services/ingestion.js');
      const report = unresolvedLocationReports().find((entry) => entry.sourceId === SOURCE);
      // 31 air-raid labels, 9 of which name something this database carries.
      expect(report?.count).toBe(22);
      expect(report?.samples).toContain('Одеський район');
      // The artillery-only hromadas are not in here: they never reached resolution at all.
      expect(report?.samples).not.toContain('Червоногригорівська територіальна громада');
    });
  });

  describe('dedupe — one location, however many labels name it', () => {
    it('folds a District and a Community of that District into one row', async () => {
      // Real, and present in the captured payload: Чугуївський район is alight as a District, and
      // Вовчанська громада — inside it — is alight as a Community. Two labels, one catalogue row.
      const earlier = new Date(Date.now() - 3_600_000).toISOString();
      const later = new Date(Date.now() - 600_000).toISOString();
      rawResponse.body = freshRaw([
        { ...rawEntry('Чугуївський район', 'District'), activeAlerts: [{ type: 'AIR', lastUpdate: later }] },
        { ...rawEntry('Вовчанська територіальна громада', 'Community'), activeAlerts: [{ type: 'AIR', lastUpdate: earlier }] }
      ]);
      await poll();

      const rows = await sql<{ location_id: string; provider_started_at: Date }>(
        `SELECT location_id,provider_started_at FROM alert_source_states WHERE source_id=$1`, [SOURCE]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.location_id).toBe(CHUHUIV_RAION);
      // The earlier of the two starts wins, so the period's start does not depend on the order the
      // upstream happened to list two labels in.
      expect(rows.rows[0]!.provider_started_at.toISOString()).toBe(earlier);
    });

    it('folds two Communities of the same raion', async () => {
      rawResponse.body = freshRaw([
        rawEntry('Вовчанська територіальна громада', 'Community'),
        rawEntry('Печенізька територіальна громада', 'Community')
      ]);
      await poll();

      expect(await holdingLocations()).toEqual([CHUHUIV_RAION]);
      const periods = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM alert_periods WHERE location_id=$1`, [CHUHUIV_RAION]
      );
      expect(Number(periods.rows[0]!.n)).toBe(1);
    });

    it('keeps a location held when one of the labels naming it is alight', async () => {
      // The aggregated feed emits inactive rows and the raw feed does not, so the two can meet in one
      // poll only through the fallback — but the fold has to take the over-warning direction either
      // way, and this pins it.
      rawResponse.body = freshRaw([rawEntry('Харківський район', 'District')]);
      await poll();
      expect(await holdingLocations()).toEqual([KHARKIV_RAION]);
    });
  });

  describe('alert types — this source moves air raids and nothing else', () => {
    it('ignores a region whose only declarations are artillery or street fighting', async () => {
      rawResponse.body = freshRaw([
        rawEntry('Червоногригорівська територіальна громада', 'Community', ['ARTILLERY']),
        rawEntry('Вовчанська територіальна громада', 'Community', ['ARTILLERY', 'URBAN_FIGHTS']),
        rawEntry('Сумський район', 'District', ['AIR'])
      ]);
      await poll();

      // Вовчанська is under shelling and street fighting and is NOT under an air raid. This source
      // holds `air_raid` state; putting a siren on the map for a different declaration would misstate
      // what the authorities said.
      expect(await holdingLocations()).toEqual([SUMY_RAION]);
      const types = await sql<{ alert_type: string }>(
        `SELECT DISTINCT alert_type FROM alert_source_states WHERE source_id=$1`, [SOURCE]
      );
      expect(types.rows.map((row) => row.alert_type)).toEqual(['air_raid']);
    });

    it('releases a raion whose air raid ended while another declaration continues', async () => {
      rawResponse.body = freshRaw([rawEntry('Сумський район', 'District', ['AIR', 'ARTILLERY'])]);
      await poll();
      expect(await activePeriods()).toEqual([SUMY_RAION]);

      // Same region, still listed, but the air raid is over and only the shelling warning remains.
      // For this source that is an all-clear, and the debounce runs exactly as if the region had
      // dropped out of the list.
      rawResponse.body = freshRaw([rawEntry('Сумський район', 'District', ['ARTILLERY'])]);
      response.body = allQuiet(kyivNow(2));
      await poll();
      expect(await holdingLocations()).toEqual([]);
      expect(await activePeriods()).toEqual([SUMY_RAION]);

      await ageAbsencesPastDebounce();
      await poll();
      expect(await activePeriods()).toEqual([]);
    });
  });

  // ============================================================================================
  // Empty because quiet, or empty because broken
  // ============================================================================================

  /**
   * The ambiguity at the heart of the fallback, and the rule that resolves it.
   *
   * A raw payload with nothing alight is what a calm night looks like AND what a half-dead upstream
   * looks like. Refusing it would make the source unhealthy every time the country was at peace;
   * believing it would clear every raion the mirror holds the moment its upstream stalls. So the
   * adapter asks the aggregated feed — which is a DIFFERENT upstream inside the same mirror — and
   * lets the two answers decide.
   */
  describe('quiet versus broken', () => {
    it('accepts an empty raw list when the aggregated feed also reports nothing alight', async () => {
      await poll();
      expect(await activePeriods()).not.toHaveLength(0);

      rawResponse.body = freshRaw([]);
      response.body = allQuiet(kyivNow(2));
      fetchCalls = [];
      await poll();

      // Sequenced, never together: the raw feed first, the witness second.
      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      expect(await holdingLocations()).toEqual([]);
      expect((await sourceHealth()).health_status).toBe('current');

      await ageAbsencesPastDebounce();
      await poll();
      expect(await activePeriods()).toEqual([]);
    });

    it('falls back to the aggregated feed when the raw list is empty but the country is not', async () => {
      // The dangerous case. `cachedat` is fresh, the envelope is intact, `raw` is `[]` — and seven
      // oblasts are alight according to the other upstream. Believing the empty list would publish
      // «Офіційний відбій» for every raion this source holds.
      rawResponse.body = freshRaw([]);
      response.body = fresh();
      const warnings: Array<Record<string, unknown>> = [];
      const { syncAerialMirror } = await import('../../src/services/ingestion.js');
      await syncAerialMirror({ warn: (fields: Record<string, unknown>) => warnings.push(fields) });

      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      // Oblast granularity for this poll — degraded, and far better than a wrong all-clear.
      expect(await holdingLocations()).toEqual(
        ['ua-12', DONETSK, 'ua-23', LUHANSK, SUMY, 'ua-63', 'ua-74'].sort()
      );
      // Falling back is the adapter working, not failing: the source stays healthy and the operator
      // is told through the log and `threatlens_aerial_mirror_polls_total{mode="unified_fallback"}`.
      expect((await sourceHealth()).health_status).toBe('current');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ sourceId: SOURCE, upstream: 'ual', unifiedActive: 7 });
      expect(String(warnings[0]!.reason)).toMatch(/no air-raid region while the aggregated feed reports 7/);
    });

    it('treats a raw list of only non-air declarations exactly like an empty one', async () => {
      // Also "nothing alight" as far as this source is concerned, and it gets the same cross-check
      // rather than being believed on its own.
      rawResponse.body = freshRaw([rawEntry('Вовчанська територіальна громада', 'Community', ['ARTILLERY'])]);
      response.body = fresh();
      await poll();

      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      expect(await holdingLocations()).toContain(SUMY);
    });

    it('never treats an unreadable raw body as quiet, cross-check or not', async () => {
      // A reshaped upstream is not an empty one. This goes down the fallback path because the raw
      // feed is unusable, not because it reported peace — and if the aggregated feed says the country
      // is quiet, the fallback still applies THAT, from a feed that was actually read.
      await poll();
      rawResponse.body = { source: 'ukrainealarm.com API', cachedat: kyivNow(1), raw: [{ nope: 1 }] };
      response.body = fresh();
      fetchCalls = [];
      await poll();

      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      expect(await holdingLocations()).toContain(SUMY);
      expect((await sourceHealth()).health_status).toBe('current');
    });
  });

  describe('the fallback, and the point past which nothing is believed', () => {
    it.each([
      ['a stale stamp', () => ({ ...(freshRaw() as object), cachedat: kyivNow(600) })],
      ['a body that is not the passthrough shape', () => fresh()],
      ['a raw list that is not an array', () => ({ source: 'x', cachedat: kyivNow(1), raw: 'nope' })],
      ['null', () => null]
    ])('falls back to the aggregated feed when the raw feed answers with %s', async (_label, body) => {
      rawResponse.body = body();
      response.body = fresh();
      await poll();

      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      expect(await holdingLocations()).toContain(SUMY);
      expect((await sourceHealth()).health_status).toBe('current');
    });

    it('falls back when the raw feed is rate limited', async () => {
      // 429 on the passthrough only. Two requests per second per host is the published limit and the
      // scheduler polls every fifteen, so this means the egress IP is shared — the aggregated feed is
      // usually still answering, and one oblast-granularity poll beats a source error.
      rawResponse = { ok: false, status: 429, body: null };
      response.body = fresh();
      await poll();

      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      expect(await holdingLocations()).toContain(SUMY);
      expect((await sourceHealth()).health_status).toBe('current');
    });

    /**
     * The stale-freeze property, unchanged by any of this.
     *
     * Two feeds mean two chances to be believed, not a lower bar. When neither can be read the throw
     * escapes, `markSourceError` runs, `alert_source_states` is never opened, and every alert this
     * source holds stays exactly where it was. Adding a fallback must not have turned "hold" into
     * "clear on the second opinion".
     */
    it('holds every alert when BOTH feeds are refused', async () => {
      await poll();
      const raised = await activePeriods();
      expect(raised).toHaveLength(7);

      rawResponse.body = { ...(freshRaw() as object), cachedat: kyivNow(600) };
      response.body = allQuiet(kyivNow(900));
      await expect(poll()).rejects.toThrow(/stale/);

      expect(await activePeriods()).toEqual(raised);
      expect(await holdingLocations()).toEqual(raised);
      const health = await sourceHealth();
      expect(health.health_status).toBe('error');
      expect(health.last_error).toMatch(/aerial mirror is stale/);
      // Not one absence recorded, so the debounce cannot start counting down while both feeds are
      // frozen — the mirror holds until it recovers, however many polls that takes.
      const missing = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM alert_source_states WHERE source_id=$1 AND missing_since IS NOT NULL`,
        [SOURCE]
      );
      expect(Number(missing.rows[0]!.n)).toBe(0);
    });

    it('holds every alert when both feeds are rate limited', async () => {
      await poll();
      rawResponse = { ok: false, status: 429, body: null };
      response = { ok: false, status: 429, body: null };
      await expect(poll()).rejects.toThrow(/Aerial alert mirror 429/);

      expect(await activePeriods()).toHaveLength(7);
      expect((await sourceHealth()).health_status).toBe('error');
    });

    it('does not let a frozen pair expire alerts by repetition', async () => {
      await poll();
      rawResponse.body = { ...(freshRaw() as object), cachedat: kyivNow(3600) };
      response.body = allQuiet(kyivNow(3600));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(poll()).rejects.toThrow(/stale/);
      }
      await ageAbsencesPastDebounce();
      await expect(poll()).rejects.toThrow(/stale/);

      expect(await activePeriods()).toHaveLength(7);
    });

    it('recovers at full granularity on the first good raw response', async () => {
      rawResponse.body = { ...(freshRaw() as object), cachedat: kyivNow(900) };
      response.body = allQuiet(kyivNow(900));
      await expect(poll()).rejects.toThrow(/stale/);
      expect((await sourceHealth()).health_status).toBe('error');

      rawResponse.body = freshRaw();
      fetchCalls = [];
      await poll();

      expect(fetchCalls).toEqual([RAW_URL]);
      expect(await holdingLocations()).toContain(CHUHUIV_RAION);
      expect((await sourceHealth()).health_status).toBe('current');
    });
  });

  describe('the two-requests-per-second limit', () => {
    it('never issues the two requests together, and spaces them', async () => {
      // The failure this prevents was observed during research: two requests inside one second and
      // the endpoint answered with a truncated body — the exact thing the parsers now refuse. So the
      // cross-check is sequenced behind the raw poll, never fired alongside it.
      let inFlight = 0;
      let concurrent = 0;
      const startedAt: number[] = [];
      vi.stubGlobal('fetch', async (input: unknown) => {
        const url = String(input);
        fetchCalls.push(url);
        startedAt.push(Date.now());
        inFlight += 1;
        concurrent = Math.max(concurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const chosen = url.includes('raw') ? rawResponse : response;
        return { ok: chosen.ok, status: chosen.status, json: async () => chosen.body };
      });

      rawResponse.body = freshRaw([]);
      response.body = fresh();
      await withConfig({ AERIAL_MIRROR_REQUEST_GAP_MS: 120 }, poll);

      expect(fetchCalls).toEqual([RAW_URL, MIRROR_URL]);
      expect(concurrent).toBe(1);
      expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(120);
    });

    it('spends one request per poll while the raw feed is answering', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) await poll();
      expect(fetchCalls).toEqual([RAW_URL, RAW_URL, RAW_URL]);
    });

    it('reads a configured base URL for both requests', async () => {
      rawResponse.body = freshRaw([]);
      response.body = allQuiet(kyivNow(2));
      await withConfig({ AERIAL_MIRROR_URL: 'https://mirror.test/alerts' }, poll);
      expect(fetchCalls).toEqual([
        'https://mirror.test/alerts?source=ual&raw=', 'https://mirror.test/alerts'
      ]);
    });

    it('honours a configured upstream', async () => {
      rawResponse.body = freshRaw([rawEntry('Сумський район', 'District')]);
      await withConfig({ AERIAL_MIRROR_RAW_SOURCE: 'klimenko' }, poll);
      expect(fetchCalls).toEqual([`${MIRROR_URL}?source=klimenko&raw=`]);
      expect(await holdingLocations()).toEqual([SUMY_RAION]);
    });

    it('does not poll at all when the kill switch is off, in either mode', async () => {
      await withConfig({ AERIAL_MIRROR_ENABLED: false }, poll);
      expect(fetchCalls).toEqual([]);
      expect(await activePeriods()).toEqual([]);
    });
  });
});
