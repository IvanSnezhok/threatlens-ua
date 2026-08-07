import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CITY_IN_OBLAST, OBLAST, OTHER_OBLAST,
  ensureMigrated, integrationDatabaseAvailable, resetDatabase, seedThreatEvent, sql
} from '../helpers/db.js';

/**
 * The read side of the location hierarchy: `/api/v1/history`, `/api/v1/locations/:id/timeline` and
 * the risk-signal roll-up inside `ingestThreat`.
 *
 * Every case drives a real exported entry point — the Fastify app built by `buildServer`, the
 * `locationTimeline` repository function, `ingestThreat` — rather than a copy of the SQL, so what is
 * asserted is the statement that actually runs in production.
 *
 * The catalogue these tests build is `oblast -> raion -> city`: the three-tier shape the KATOTTG
 * import produces, in which an oblast and a city sit two `parent_id` edges apart. Matching a single
 * edge, which is what this replaced, drops the far end of that chain in both directions.
 */

interface Branch { oblast: string; raion: string; city: string }

async function seedBranch(name: string): Promise<Branch> {
  const branch: Branch = { oblast: `test-${name}-oblast`, raion: `test-${name}-raion`, city: `test-${name}-city` };
  await sql(
    `INSERT INTO locations(id,parent_id,type,name_uk) VALUES
       ($1,NULL,'oblast',$1),($2,$1,'raion',$2),($3,$2,'city',$3)`,
    [branch.oblast, branch.raion, branch.city]
  );
  return branch;
}

async function seedAlert(locationId: string): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at) VALUES ($1,'air_raid','active',now())
     RETURNING id`, [locationId]
  );
  return row.rows[0]!.id;
}

describe.skipIf(!integrationDatabaseAvailable)('location hierarchy', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetDatabase);

  describe('relatedLocationIds', () => {
    it('returns the whole chain from any tier of it', async () => {
      const branch = await seedBranch('kyiv');
      const { relatedLocationIds } = await import('../../src/repositories/events.js');
      const expected = [branch.city, branch.oblast, branch.raion];

      for (const anchor of [branch.oblast, branch.raion, branch.city]) {
        expect((await relatedLocationIds(anchor)).sort()).toEqual(expected);
      }
    });

    it('excludes a sibling branch and a sibling raion', async () => {
      const branch = await seedBranch('kyiv');
      await seedBranch('lviv');
      await sql(
        `INSERT INTO locations(id,parent_id,type,name_uk) VALUES ('test-kyiv-raion-2',$1,'raion','test-kyiv-raion-2')`,
        [branch.oblast]
      );
      const { relatedLocationIds } = await import('../../src/repositories/events.js');

      // From the raion, its sibling raion is neither an ancestor nor a descendant.
      expect((await relatedLocationIds(branch.raion)).sort()).toEqual([branch.city, branch.oblast, branch.raion]);
      // From the oblast the sibling raion is a descendant, but the other branch never is.
      expect((await relatedLocationIds(branch.oblast)).sort())
        .toEqual([branch.city, branch.oblast, branch.raion, 'test-kyiv-raion-2']);
    });

    it('returns nothing for a location that is not in the catalogue', async () => {
      const { relatedLocationIds } = await import('../../src/repositories/events.js');
      expect(await relatedLocationIds('test-does-not-exist')).toEqual([]);
    });

    it('terminates on a cycle instead of walking it forever', async () => {
      const branch = await seedBranch('kyiv');
      await sql(`UPDATE locations SET parent_id=$1 WHERE id=$2`, [branch.city, branch.oblast]);
      const { relatedLocationIds } = await import('../../src/repositories/events.js');

      // Every member of the cycle is reachable, and each is reported once.
      expect((await relatedLocationIds(branch.raion)).sort()).toEqual([branch.city, branch.oblast, branch.raion]);
    });

    it('stops at the depth ceiling on a pathologically deep chain', async () => {
      const { LOCATION_HIERARCHY_MAX_DEPTH, relatedLocationIds } = await import('../../src/repositories/events.js');
      const depth = LOCATION_HIERARCHY_MAX_DEPTH + 4;
      await sql(`INSERT INTO locations(id,parent_id,type,name_uk) VALUES ('test-deep-0',NULL,'oblast','test-deep-0')`);
      for (let level = 1; level <= depth; level += 1) {
        await sql(
          `INSERT INTO locations(id,parent_id,type,name_uk) VALUES ($1,$2,'hromada',$1)`,
          [`test-deep-${level}`, `test-deep-${level - 1}`]
        );
      }

      const fromRoot = await relatedLocationIds('test-deep-0');
      const fromLeaf = await relatedLocationIds(`test-deep-${depth}`);

      // Anchor plus MAX_DEPTH edges in the reachable direction, and nothing beyond it.
      expect(fromRoot.length).toBe(LOCATION_HIERARCHY_MAX_DEPTH + 1);
      expect(fromRoot).toContain(`test-deep-${LOCATION_HIERARCHY_MAX_DEPTH}`);
      expect(fromRoot).not.toContain(`test-deep-${LOCATION_HIERARCHY_MAX_DEPTH + 1}`);
      expect(fromLeaf.length).toBe(LOCATION_HIERARCHY_MAX_DEPTH + 1);
    });
  });

  describe('locationTimeline', () => {
    it('shows a city event on the oblast timeline two edges above it', async () => {
      const branch = await seedBranch('kyiv');
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });
      const { locationTimeline } = await import('../../src/repositories/events.js');

      const timeline = await locationTimeline(branch.oblast);

      expect(timeline!.counts.threats).toBe(1);
      expect(timeline!.items.map((item) => item.id)).toEqual([eventId]);
    });

    it('shows an oblast event on the city timeline two edges below it', async () => {
      const branch = await seedBranch('kyiv');
      const eventId = await seedThreatEvent({ locationIds: [branch.oblast] });
      const { locationTimeline } = await import('../../src/repositories/events.js');

      const timeline = await locationTimeline(branch.city);

      expect(timeline!.counts.threats).toBe(1);
      expect(timeline!.items.map((item) => item.id)).toEqual([eventId]);
    });

    it('counts alerts through the whole chain in both directions', async () => {
      const branch = await seedBranch('kyiv');
      await seedAlert(branch.oblast);
      await seedAlert(branch.raion);
      await seedAlert(branch.city);
      const { locationTimeline } = await import('../../src/repositories/events.js');

      for (const anchor of [branch.oblast, branch.raion, branch.city]) {
        expect((await locationTimeline(anchor))!.counts.alerts).toBe(3);
      }
    });

    it('leaves a sibling branch out of the timeline', async () => {
      const branch = await seedBranch('kyiv');
      const other = await seedBranch('lviv');
      await seedThreatEvent({ locationIds: [other.city] });
      await seedAlert(other.raion);
      const { locationTimeline } = await import('../../src/repositories/events.js');

      const timeline = await locationTimeline(branch.oblast);

      expect(timeline!.counts).toMatchObject({ threats: 0, alerts: 0, assessments: 0 });
      expect(timeline!.items).toEqual([]);
    });

    it('terminates on a cycle in parent_id', async () => {
      const branch = await seedBranch('kyiv');
      await sql(`UPDATE locations SET parent_id=$1 WHERE id=$2`, [branch.city, branch.oblast]);
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });
      const { locationTimeline } = await import('../../src/repositories/events.js');

      const timeline = await locationTimeline(branch.oblast);

      expect(timeline!.items.map((item) => item.id)).toEqual([eventId]);
    });

    it('still returns null for a location that is not in the catalogue', async () => {
      const { locationTimeline } = await import('../../src/repositories/events.js');
      expect(await locationTimeline('test-does-not-exist')).toBeNull();
    });
  });

  describe('GET /api/v1/history', () => {
    let app: Awaited<ReturnType<typeof import('../../src/api/server.js')['buildServer']>>;

    beforeAll(async () => {
      const { buildServer } = await import('../../src/api/server.js');
      app = await buildServer();
      await app.ready();
    });
    afterAll(async () => { await app?.close(); });

    async function historyIds(query: string): Promise<string[]> {
      const response = await app.inject({ method: 'GET', url: `/api/v1/history${query}` });
      expect(response.statusCode).toBe(200);
      return (response.json().items as Array<{ id: string }>).map((item) => item.id);
    }

    it('returns a city event when filtering by the oblast two edges above it', async () => {
      const branch = await seedBranch('kyiv');
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });

      expect(await historyIds(`?location=${branch.oblast}`)).toEqual([eventId]);
    });

    it('returns an oblast event when filtering by a city two edges below it', async () => {
      const branch = await seedBranch('kyiv');
      const eventId = await seedThreatEvent({ locationIds: [branch.oblast] });

      expect(await historyIds(`?location=${branch.city}`)).toEqual([eventId]);
    });

    it('returns a raion event from either neighbouring tier', async () => {
      const branch = await seedBranch('kyiv');
      const eventId = await seedThreatEvent({ locationIds: [branch.raion] });

      expect(await historyIds(`?location=${branch.oblast}`)).toEqual([eventId]);
      expect(await historyIds(`?location=${branch.city}`)).toEqual([eventId]);
    });

    it('returns each matching event once even when it is attached to every tier', async () => {
      const branch = await seedBranch('kyiv');
      const eventId = await seedThreatEvent({ locationIds: [branch.oblast, branch.raion, branch.city] });

      expect(await historyIds(`?location=${branch.oblast}`)).toEqual([eventId]);
    });

    it('excludes a sibling branch', async () => {
      const branch = await seedBranch('kyiv');
      const other = await seedBranch('lviv');
      await seedThreatEvent({ locationIds: [other.city] });

      expect(await historyIds(`?location=${branch.oblast}`)).toEqual([]);
    });

    it('keeps working on the two-tier catalogue shipped by the migrations', async () => {
      const eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });

      expect(await historyIds(`?location=${OBLAST}`)).toEqual([eventId]);
      expect(await historyIds(`?location=${CITY_IN_OBLAST}`)).toEqual([eventId]);
      expect(await historyIds(`?location=${OTHER_OBLAST}`)).toEqual([]);
    });

    it('returns every event when no location filter is given', async () => {
      const branch = await seedBranch('kyiv');
      const other = await seedBranch('lviv');
      const first = await seedThreatEvent({ locationIds: [branch.city] });
      const second = await seedThreatEvent({ locationIds: [other.city] });

      expect((await historyIds('')).sort()).toEqual([first, second].sort());
    });

    it('returns nothing for a location that is not in the catalogue', async () => {
      await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });

      expect(await historyIds('?location=test-does-not-exist')).toEqual([]);
    });

    it('terminates on a cycle in parent_id', async () => {
      const branch = await seedBranch('kyiv');
      await sql(`UPDATE locations SET parent_id=$1 WHERE id=$2`, [branch.city, branch.oblast]);
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });

      expect(await historyIds(`?location=${branch.oblast}`)).toEqual([eventId]);
    });
  });

  describe('ingestThreat risk-signal roll-up', () => {
    it('attaches the oblast signal of a city that hangs off a raion', async () => {
      // `signalTargets` promotes a city threat to its oblast so oblast-level risk assessments keep
      // seeing it. That lookup used to join one `parent_id` edge and filter on `type='oblast'`,
      // which finds nothing once the direct parent is a raion.
      const branch = await seedBranch('kyiv');
      const { ingestThreat } = await import('../../src/repositories/events.js');

      await ingestThreat(
        {
          sourceId: 'demo', externalId: 'hierarchy-1', publishedAt: new Date(),
          text: 'Загроза для міста', rawPayload: {}
        },
        {
          threatType: 'uav', signalThreatTypes: ['uav'],
          locations: [{ id: branch.city, relationType: 'explicit_threat', name: branch.city }],
          nationalScope: false, indicators: ['uav_group'],
          title: 'Тест', summary: 'Тест'
        }
      );

      const signals = await sql<{ location_id: string; relation_type: string }>(
        `SELECT location_id FROM risk_signals ORDER BY location_id`
      );
      expect(signals.rows.map((row) => row.location_id).sort()).toEqual([branch.oblast, branch.city].sort());
    });

    it('does not treat an oblast as its own parent', async () => {
      const branch = await seedBranch('kyiv');
      const { ingestThreat } = await import('../../src/repositories/events.js');

      await ingestThreat(
        {
          sourceId: 'demo', externalId: 'hierarchy-2', publishedAt: new Date(),
          text: 'Загроза для області', rawPayload: {}
        },
        {
          threatType: 'uav', signalThreatTypes: ['uav'],
          locations: [{ id: branch.oblast, relationType: 'explicit_threat', name: branch.oblast }],
          nationalScope: false, indicators: ['uav_group'],
          title: 'Тест', summary: 'Тест'
        }
      );

      const signals = await sql<{ location_id: string }>(`SELECT location_id FROM risk_signals`);
      expect(signals.rows.map((row) => row.location_id)).toEqual([branch.oblast]);
    });
  });
});
