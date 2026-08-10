import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CITY_IN_OBLAST,
  OBLAST,
  OTHER_OBLAST,
  ensureMigrated,
  integrationDatabaseAvailable,
  resetDatabase,
  seedThreatEvent,
  sql
} from '../helpers/db.js';

/**
 * `GET /ops/api/coverage`, end to end against a live PostgreSQL.
 *
 * The property this file pins is the one the console's new block promises: «оператор бачить, з
 * яких областей до нас узагалі щось надходить, і з яких — ні». That promise has a load-bearing
 * caveat, because **the schema declares no source→oblast mapping at all** — the route derives
 * coverage from observed behaviour. So the assertions here are about the derivation:
 *
 *  - all 27 regions are always present, even the ones nothing has ever mentioned, because a table
 *    that lists only the covered oblasts cannot answer the question it exists to answer;
 *  - a message naming a *city* counts for the oblast above it (the `oblast_of` climb), which is
 *    what makes «повідомлень за годину» a regional number rather than a settlement number;
 *  - a message naming three places in one oblast is one message of that oblast, and a second
 *    classifier version over the same message is still one message — otherwise switching the
 *    shadow classifier on would silently double every region's traffic;
 *  - `national_scope` and anything that rolls up to the country land in the «Загальнодержавні»
 *    row rather than being smeared across all 27 or dropped;
 *  - a disabled source still shows as coverage, in its own column: «канал є, але вимкнений» and
 *    «каналу немає» are different operational findings.
 *
 * **Harness (b) of CONTRACT §12 wave 3**: a bare `Fastify({ logger: false })` with
 * `app.register(opsCoverageRoutes)`, the same shape as `tests/integration/ops-runtime.test.ts`.
 * The plugin carries its own auth guard, so nothing here needs the rest of the server to exist.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

/** Two seeded monitors from the catalogue — one enabled, one that the test disables. */
const WAR = 'osint-war-monitor';
const OSINT = 'osint-eradar';

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const opsCoverageRoutes = (await import('../../src/api/ops-coverage-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(opsCoverageRoutes);
  await app.ready();
  return app;
}

async function get(app: FastifyInstance, url = '/ops/api/coverage', headers: Record<string, string> = { authorization: OPS }) {
  return app.inject({ method: 'GET', url, headers });
}

interface CoverageRow {
  locationId: string;
  name: string;
  kind: string;
  sourcesEnabled: number;
  sourcesDisabled: number;
  messagesLastHour: number;
  messagesWindow: number;
  lastMessageAt: string | null;
  activeAlerts: number;
  activeThreats: number;
}

function row(body: { rows: CoverageRow[] }, locationId: string): CoverageRow {
  const found = body.rows.find((item) => item.locationId === locationId);
  if (!found) throw new Error(`no coverage row for ${locationId}: ${body.rows.map((r) => r.locationId).join(',')}`);
  return found;
}

/** One classified message from `sourceId`, asserted at `locationIds`, published `minutesAgo`. */
async function seedMessage(options: {
  sourceId: string;
  externalId: string;
  minutesAgo: number;
  locationIds?: string[];
  nationalScope?: boolean;
  classifierVersions?: string[];
}): Promise<void> {
  const messageId = (await sql<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash,processing_status)
     VALUES ($1,$2,now() - ($3::int * interval '1 minute'),'fixture',$2,'processed') RETURNING id`,
    [options.sourceId, options.externalId, options.minutesAgo]
  )).rows[0]!.id;

  for (const version of options.classifierVersions ?? ['v1']) {
    const classificationId = (await sql<{ id: string }>(
      `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
         decision,intent,created_event,threat_type,candidate_threat_types,national_scope)
       VALUES ($1,$2,$3,now() - ($4::int * interval '1 minute'),'event_created','threat',true,'uav',
               ARRAY['uav'],$5) RETURNING id`,
      [messageId, options.sourceId, version, options.minutesAgo, options.nationalScope ?? false]
    )).rows[0]!.id;
    for (const locationId of options.locationIds ?? []) {
      await sql(
        `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
         VALUES ($1,$2,'asserted','explicit_threat')`,
        [classificationId, locationId]
      );
    }
  }
}

describe.skipIf(!integrationDatabaseAvailable)('GET /ops/api/coverage', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    await sql(`UPDATE sources SET enabled=true WHERE id = ANY($1)`, [[WAR, OSINT]]);
  });

  it('is closed without operator credentials and rejects an out-of-range window', async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/ops/api/coverage' })).statusCode).toBe(401);
      const wrong = await get(app, '/ops/api/coverage', {
        authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}`
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.headers['www-authenticate']).toContain('Basic');

      for (const bad of ['0', '31', 'seven', '7.5']) {
        const response = await get(app, `/ops/api/coverage?windowDays=${bad}`);
        expect(response.statusCode, `windowDays=${bad}`).toBe(400);
        expect(response.json().error).toBe('invalid_window_days');
      }
      expect((await get(app, '/ops/api/coverage?windowDays=30')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('lists every region plus the national row on an empty database, all at zero', async () => {
    const app = await buildApp();
    try {
      const response = await get(app);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.windowDays).toBe(7);
      expect(body.derivation).toBe('observed');
      // The caveat is part of the payload, not of some documentation the operator will not read:
      // a number whose derivation is invisible is a number that gets trusted for the wrong reason.
      expect(body.notice).toContain('виведене зі спостереженої');

      const regions = body.rows.filter((item: CoverageRow) => item.kind !== 'country');
      expect(regions.length).toBeGreaterThanOrEqual(27);
      expect(regions.every((item: CoverageRow) => ['oblast', 'special_city'].includes(item.kind))).toBe(true);
      // «Нічого не надходить» is the finding, so the row has to exist to carry it.
      expect(regions.every((item: CoverageRow) => item.sourcesEnabled === 0 && item.messagesLastHour === 0)).toBe(true);
      expect(body.totals.uncovered).toBe(regions.length);

      const national = body.rows.filter((item: CoverageRow) => item.kind === 'country');
      expect(national).toHaveLength(1);
      expect(national[0].locationId).toBe('ua');
      expect(national[0].name).toBe('Загальнодержавні');
    } finally {
      await app.close();
    }
  });

  it('counts a city message for its oblast, once per message, whatever the classifier version', async () => {
    // Same message named by two classifier versions and pointing at both the oblast and a city
    // inside it. The oblast is owed exactly one message, not four.
    await seedMessage({
      sourceId: WAR,
      externalId: 'coverage-rollup',
      minutesAgo: 10,
      locationIds: [OBLAST, CITY_IN_OBLAST],
      classifierVersions: ['v1', 'shadow-v2']
    });
    // A second, older message inside the window but outside the hour.
    await seedMessage({ sourceId: WAR, externalId: 'coverage-old', minutesAgo: 60 * 30, locationIds: [CITY_IN_OBLAST] });

    const app = await buildApp();
    try {
      const body = (await get(app)).json();
      const kyiv = row(body, OBLAST);
      expect(kyiv.messagesLastHour).toBe(1);
      expect(kyiv.messagesWindow).toBe(2);
      expect(kyiv.sourcesEnabled).toBe(1);
      expect(kyiv.sourcesDisabled).toBe(0);
      expect(Date.parse(kyiv.lastMessageAt!)).not.toBeNaN();

      // Nothing leaked sideways.
      expect(row(body, OTHER_OBLAST).messagesWindow).toBe(0);
      expect(row(body, 'ua').messagesWindow).toBe(0);
      expect(body.totals.messagesLastHour).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('keeps a disabled source visible in its own column and out of the enabled count', async () => {
    await seedMessage({ sourceId: WAR, externalId: 'coverage-enabled', minutesAgo: 5, locationIds: [OBLAST] });
    await seedMessage({ sourceId: OSINT, externalId: 'coverage-disabled', minutesAgo: 5, locationIds: [OBLAST] });
    await sql(`UPDATE sources SET enabled=false WHERE id=$1`, [OSINT]);

    const app = await buildApp();
    try {
      const kyiv = row((await get(app)).json(), OBLAST);
      expect(kyiv.sourcesEnabled).toBe(1);
      // «Канал є, але вимкнений» is not «каналу немає», and the console shows them apart.
      expect(kyiv.sourcesDisabled).toBe(1);
      expect(kyiv.messagesLastHour).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('sends national-scope traffic to the «Загальнодержавні» row, not across the 27', async () => {
    await seedMessage({ sourceId: WAR, externalId: 'coverage-national', minutesAgo: 3, nationalScope: true });

    const app = await buildApp();
    try {
      const body = (await get(app)).json();
      const national = row(body, 'ua');
      expect(national.messagesLastHour).toBe(1);
      expect(national.sourcesEnabled).toBe(1);
      expect(body.rows.filter((item: CoverageRow) => item.kind !== 'country')
        .every((item: CoverageRow) => item.messagesLastHour === 0)).toBe(true);
      // The national row is a scope, not a region, so it must not inflate «областей без каналів».
      expect(body.totals.uncovered).toBe(body.rows.length - 1);
    } finally {
      await app.close();
    }
  });

  it('reports the live alert and threat load per oblast, rolled up from the named location', async () => {
    await sql(
      `INSERT INTO alert_periods(location_id,alert_type,status,started_at) VALUES ($1,'air_raid','active',now())`,
      [OBLAST]
    );
    // An ended period must not keep the oblast lit.
    await sql(
      `INSERT INTO alert_periods(location_id,alert_type,status,started_at,ended_at)
       VALUES ($1,'air_raid','ended',now() - interval '3 hours',now() - interval '2 hours')`,
      [OTHER_OBLAST]
    );
    await seedThreatEvent({ locationIds: [CITY_IN_OBLAST], status: 'confirmed' });
    await seedThreatEvent({ locationIds: [OTHER_OBLAST], status: 'expired' });

    const app = await buildApp();
    try {
      const body = (await get(app)).json();
      expect(row(body, OBLAST).activeAlerts).toBe(1);
      expect(row(body, OBLAST).activeThreats).toBe(1);
      expect(row(body, OTHER_OBLAST).activeAlerts).toBe(0);
      expect(row(body, OTHER_OBLAST).activeThreats).toBe(0);
      expect(body.totals.activeAlerts).toBe(1);
      expect(body.totals.activeThreats).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('treats a held official alert state as coverage even with no classified message', async () => {
    // The alert path never goes through the classifier, so a source that only holds alert state
    // would otherwise read as covering nothing at all.
    await sql(
      `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at)
       VALUES ($1,$2,'air_raid',false,now() - interval '2 days')`,
      [WAR, OTHER_OBLAST]
    );

    const app = await buildApp();
    try {
      const poltava = row((await get(app)).json(), OTHER_OBLAST);
      expect(poltava.sourcesEnabled).toBe(1);
      expect(poltava.messagesLastHour).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('honours the window: a message older than it stops counting as coverage', async () => {
    await seedMessage({ sourceId: WAR, externalId: 'coverage-stale', minutesAgo: 60 * 24 * 5, locationIds: [OBLAST] });

    const app = await buildApp();
    try {
      expect(row((await get(app, '/ops/api/coverage?windowDays=7')).json(), OBLAST).sourcesEnabled).toBe(1);
      expect(row((await get(app, '/ops/api/coverage?windowDays=1')).json(), OBLAST).sourcesEnabled).toBe(0);
    } finally {
      await app.close();
    }
  });
});
