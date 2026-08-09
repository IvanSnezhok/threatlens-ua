import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * The community aerial-alert mirror against live PostgreSQL: `syncAerialMirror` end to end.
 *
 * `src/sources/aerial-mirror.test.ts` covers the parser in isolation. What can only be shown here is
 * what the parser's refusals do to stored state — and the property worth the whole file is that a
 * mirror which has frozen leaves `alert_periods` exactly as it found them. A unit test can assert a
 * throw; only this one can assert that nothing was cleared.
 *
 * The adapter is driven through its exported entry point with `fetch` stubbed, the same shape
 * `alert-reconciliation.test.ts` uses for the two token APIs, so URL handling, the staleness gate and
 * the source-health bookkeeping are all on the path under test.
 */

const MIRROR_URL = 'https://ubilling.net.ua/aerialalerts/';
const SOURCE = 'aerial-alerts-mirror';

/** Oblasts the fixture reports alight, and their catalogue ids. */
const DONETSK = 'ua-14';
const LUHANSK = 'ua-44';
const SUMY = 'ua-59';
const KYIV_CITY = 'ua-80';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/aerial-mirror-snapshot.json', import.meta.url), 'utf8')
) as { source: string; cachedat: string; states: Record<string, { alertnow: boolean; changed: string }> };

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

let response: { ok: boolean; status: number; body: unknown };

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

describe.skipIf(!integrationDatabaseAvailable)('community aerial-alert mirror', () => {
  let fetchCalls: string[];

  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    fetchCalls = [];
    response = { ok: true, status: 200, body: fresh() };
    vi.stubGlobal('fetch', async (input: unknown) => {
      fetchCalls.push(String(input));
      return { ok: response.ok, status: response.status, json: async () => response.body };
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
