import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * `snapshot.territories[]` against a real catalogue: «карта показує агрегований стан території, а не
 * набір маркерів», and its one hard constraint — **no invented geography**.
 *
 * `src/domain/territory-state.test.ts` proves the fold is right about rows handed to it. What this
 * file proves is the part a unit test structurally cannot: that the rows the server actually hands
 * it — `activeAlerts(cutoff)`, `liveThreats(cutoff)`, `currentAssessments(cutoff)` and the ancestry
 * closure of exactly the ids they reference — carry the hierarchy the fold needs, that the
 * publication cutoff reaches the territories as well as the events they are made of, and that a
 * warning nobody localised (`location_id = 'ua'`) still lights nothing at all.
 *
 * **Harness (a) of CONTRACT §12 wave 3**: `/api/v1/snapshot` is declared inline inside
 * `buildServer()`, so the server is built once, listened on an ephemeral port and read with a real
 * `fetch` — the shape copied from `tests/integration/threat-vector.test.ts`.
 *
 * Wall clock is exercised by backdating the column the code itself wrote (`threat_events.created_at`,
 * `threat_event_locations.created_at`), never by fake timers.
 */

interface Branch { oblast: string; raion: string; city: string }

let app: FastifyInstance;
let baseUrl = '';

/**
 * The three-tier shape the KATOTTG import produces: `oblast -> raion -> city`, with the oblast and
 * the city two `parent_id` edges apart. Ids are prefixed `test-` because `resetDatabase()` clears
 * exactly that prefix and leaves the migration-seeded catalogue alone.
 */
async function seedBranch(name: string): Promise<Branch> {
  const branch: Branch = {
    oblast: `test-${name}-oblast`, raion: `test-${name}-raion`, city: `test-${name}-city`
  };
  await sql(
    `INSERT INTO locations(id,parent_id,type,name_uk) VALUES
       ($1,NULL,'oblast',$1),($2,$1,'raion',$2),($3,$2,'city',$3)`,
    [branch.oblast, branch.raion, branch.city]
  );
  return branch;
}

async function seedRaion(oblastId: string, name: string): Promise<string> {
  const id = `test-${name}-raion`;
  await sql(`INSERT INTO locations(id,parent_id,type,name_uk) VALUES ($1,$2,'raion',$1)`, [id, oblastId]);
  return id;
}

async function seedAlert(locationId: string): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at,published_at)
     VALUES ($1,'air_raid','active', now() - interval '10 minutes', now() - interval '10 minutes')
     RETURNING id`,
    [locationId]
  );
  return row.rows[0]!.id;
}

async function seedThreat(fields: {
  threatType?: string; evidenceLevel?: string; createdAgoSeconds?: number;
}): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,
       last_observed_at,valid_until,created_at,updated_at)
     VALUES ($1,'observed',$2,'Територіальна перевірка','Територіальна перевірка',
             now() - interval '5 minutes', now() - interval '1 minute', now() + interval '2 hours',
             now() - make_interval(secs => $3::int), now())
     RETURNING id`,
    [fields.threatType ?? 'uav', fields.evidenceLevel ?? 'confirmed', fields.createdAgoSeconds ?? 120]
  );
  return row.rows[0]!.id;
}

async function attachLocation(
  eventId: string, locationId: string, relationType = 'explicit_threat', createdAgoSeconds = 120
): Promise<void> {
  await sql(
    `INSERT INTO threat_event_locations(event_id,location_id,relation_type,created_at)
     VALUES ($1,$2,$3, now() - make_interval(secs => $4::int))`,
    [eventId, locationId, relationType, createdAgoSeconds]
  );
}

async function seedAssessment(fields: {
  locationId: string; riskLevel: string; riskScore: number; threatType?: string;
}): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO risk_assessments(location_id,threat_type,horizon_start,horizon_end,risk_score,
       risk_level,assessment_confidence,model_version,indicative_percent,generated_at,expires_at,published)
     VALUES ($1,$2, now() - interval '1 hour', now() + interval '5 hours', $3, $4,
             'medium','integration-fixture',40, now() - interval '2 minutes', now() + interval '1 hour', true)
     RETURNING id`,
    [fields.locationId, fields.threatType ?? 'uav', fields.riskScore, fields.riskLevel]
  );
  return row.rows[0]!.id;
}

async function setMode(mode: 'live' | 'delayed_15s'): Promise<void> {
  await sql(
    `UPDATE runtime_settings SET publication_mode=$1, mode_changed_at=now() - interval '1 hour', updated_at=now()`,
    [mode]
  );
  (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
}

interface Snapshot {
  version: number;
  publication: { mode: string; cutoffAt: string };
  territories: Array<{
    locationId: string; tier: string; name: string; parentId: string | null;
    coverage: 'direct' | 'partial' | 'unmapped';
    alertActive: boolean; alertSince: string | null;
    alerts: Array<{ locationId: string; coverage: string }>;
    threats: Array<{ threatType: string; asserted: boolean; coverage: string; relationType: string; count: number }>;
    threatActive: boolean; consequences: boolean;
    assessment: { assessmentId: string; riskLevel: string } | null;
    analyticStatus: string;
    icons: Array<{ threatType: string; tone: string; rank: number; iconId: string; labelUk: string; ariaLabelUk: string }>;
    iconOverflow: number;
    publishedAt: string;
  }>;
}

async function snapshot(): Promise<Snapshot> {
  const response = await fetch(`${baseUrl}/api/v1/snapshot`);
  return response.json() as Promise<Snapshot>;
}

const byId = (snap: Snapshot, locationId: string) =>
  snap.territories.find((territory) => territory.locationId === locationId);

describe.skipIf(!integrationDatabaseAvailable)('territory snapshot', () => {
  beforeAll(async () => {
    await ensureMigrated();
    // buildServer() registers every plugin itself; registering any of them again here throws
    // FST_ERR_DUPLICATED_ROUTE inside beforeAll and vitest reports the suite as SKIPPED rather than
    // failed, which would silently disarm this whole file. The server is taken exactly as it ships.
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => { await app?.close(); });

  // The five in-process seams of CONTRACT §1.4 beside the TRUNCATE, in the order documented in
  // `tests/helpers/db.ts`.
  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
  });

  it('lights a raion directly and its oblast only partially', async () => {
    const branch = await seedBranch('kyiv');
    await seedAlert(branch.raion);

    const snap = await snapshot();

    expect(snap.territories.map((territory) => territory.locationId).sort())
      .toEqual([branch.oblast, branch.raion].sort());
    expect(byId(snap, branch.raion)).toMatchObject({
      tier: 'raion', coverage: 'direct', alertActive: true, parentId: branch.oblast
    });
    // `partial` is derived coverage of an explicitly named child. Without it the oblast would look
    // calm at the overview zoom while an alert runs inside it; with a `direct` polygon it would
    // claim an alert for the whole oblast, which no source said.
    expect(byId(snap, branch.oblast)).toMatchObject({ tier: 'oblast', coverage: 'partial', alertActive: true });
    expect(byId(snap, branch.raion)!.alerts[0]).toMatchObject({ locationId: branch.raion, coverage: 'direct' });
    expect(byId(snap, branch.oblast)!.alerts[0]).toMatchObject({ locationId: branch.raion, coverage: 'partial' });
  });

  it('rolls a city alert up to the nearest polygon-bearing ancestor as unmapped', async () => {
    const branch = await seedBranch('lviv');
    await seedAlert(branch.city);

    const snap = await snapshot();

    // The city itself is never a territory: it carries no polygon, and there is no more detailed
    // layer to replace the raion with as the map zooms in.
    expect(snap.territories.map((territory) => territory.locationId).sort())
      .toEqual([branch.oblast, branch.raion].sort());
    expect(byId(snap, branch.raion)).toMatchObject({ coverage: 'unmapped', alertActive: true });
    expect(byId(snap, branch.oblast)).toMatchObject({ coverage: 'partial', alertActive: true });
  });

  it('produces no territory at all for a national-scope threat', async () => {
    const eventId = await seedThreat({});
    await attachLocation(eventId, 'ua');

    const snap = await snapshot();

    // Twenty-seven lit oblasts would be a claim no source made. A warning nobody localised lights
    // nothing; the event is still in `threats[]` and still reaches the panel and the bot.
    expect(snap.territories).toEqual([]);
    expect(snap.version).toBeGreaterThanOrEqual(0);
    const threats = await (await fetch(`${baseUrl}/api/v1/threats`)).json() as Array<{ id: string }>;
    expect(threats.map((threat) => threat.id)).toEqual([eventId]);
  });

  it('spreads one five-raion event over five territories and one muted parent', async () => {
    const branch = await seedBranch('sumy');
    const raions = [branch.raion];
    for (const name of ['sumy-b', 'sumy-c', 'sumy-d', 'sumy-e']) {
      raions.push(await seedRaion(branch.oblast, name));
    }
    const eventId = await seedThreat({ threatType: 'ballistic_missile', evidenceLevel: 'confirmed' });
    for (const raion of raions) await attachLocation(eventId, raion);

    const snap = await snapshot();

    const lit = snap.territories.filter((territory) => territory.tier === 'raion');
    expect(lit.map((territory) => territory.locationId).sort()).toEqual([...raions].sort());
    for (const territory of lit) {
      expect(territory.coverage).toBe('direct');
      expect(territory.threatActive).toBe(true);
      expect(territory.icons).toHaveLength(1);
      expect(territory.icons[0]).toMatchObject({
        threatType: 'ballistic_missile',
        // `confirmed` evidence, no aftermath — the middle of the three factual tones.
        tone: 'confirmed', rank: 0, iconId: 'ti-ballistic_missile-confirmed'
      });
      expect(territory.icons[0]!.labelUk.length).toBeGreaterThan(0);
      expect(territory.icons[0]!.ariaLabelUk.length).toBeGreaterThan(0);
      expect(territory.iconOverflow).toBe(0);
    }
    // The parent is covered, not targeted: muted polygon, and no glyph claiming a weapon class for
    // the whole oblast.
    expect(byId(snap, branch.oblast)).toMatchObject({ coverage: 'partial', threatActive: true });
    expect(byId(snap, branch.oblast)!.icons).toEqual([]);
  });

  it('gives a mentioned-only location no threat polygon and no icon', async () => {
    const branch = await seedBranch('mykolaiv');
    const eventId = await seedThreat({ threatType: 'cruise_missile' });
    await attachLocation(eventId, branch.raion, 'mentioned');

    const snap = await snapshot();

    const raion = byId(snap, branch.raion)!;
    // `relationFor()` assigns `mentioned` to the transit case («повз Миколаїв») and as the
    // fall-through for any alias present in the text. The territory still appears, so the panel's
    // «Згадано джерелом» row keeps the information; what it does not get is a claim.
    expect(raion.threats).toHaveLength(1);
    expect(raion.threats[0]).toMatchObject({ relationType: 'mentioned', asserted: false });
    expect(raion.threatActive).toBe(false);
    expect(raion.icons).toEqual([]);
  });

  it('holds a district added by a later merge for the full cutoff', async () => {
    const branch = await seedBranch('poltava');
    const merged = await seedRaion(branch.oblast, 'poltava-merged');
    const eventId = await seedThreat({ createdAgoSeconds: 120 });
    await attachLocation(eventId, branch.raion, 'explicit_threat', 120);
    // Attached NOW, to an event that was published two minutes ago.
    await attachLocation(eventId, merged, 'explicit_threat', 0);

    await setMode('delayed_15s');
    const held = await snapshot();

    // Under the territory model the new district IS a polygon and an icon stack — the most
    // perceivable output the map has — so it is held for the same fifteen seconds as a new event.
    expect(held.territories.map((territory) => territory.locationId).sort())
      .toEqual([branch.oblast, branch.raion].sort());
    expect(byId(held, merged)).toBeUndefined();

    await setMode('live');
    const live = await snapshot();

    expect(live.territories.map((territory) => territory.locationId).sort())
      .toEqual([branch.oblast, branch.raion, merged].sort());
    expect(byId(live, merged)).toMatchObject({ coverage: 'direct', threatActive: true });
  });

  it('draws the analytic contour from elevated but only makes an icon from significant', async () => {
    const branch = await seedBranch('odesa');
    await seedAssessment({ locationId: branch.raion, riskLevel: 'elevated', riskScore: 3 });

    const contourOnly = byId(await snapshot(), branch.raion)!;
    // A dotted outline is a hint about a territory; a glyph is a claim about a weapon class, so the
    // icon floor sits one band higher than the contour floor.
    expect(contourOnly.analyticStatus).toBe('elevated');
    expect(contourOnly.icons).toEqual([]);

    await sql(`UPDATE risk_assessments SET risk_level='significant', risk_score=5.0`);
    const withIcon = byId(await snapshot(), branch.raion)!;

    expect(withIcon.analyticStatus).toBe('significant');
    expect(withIcon.icons).toHaveLength(1);
    expect(withIcon.icons[0]).toMatchObject({ threatType: 'uav', tone: 'analytic' });
  });

  it('stamps every territory with the slice it belongs to, and repeats itself exactly', async () => {
    const branch = await seedBranch('kharkiv');
    await seedAlert(branch.raion);
    const eventId = await seedThreat({ threatType: 'guided_air_bomb', evidenceLevel: 'official' });
    await attachLocation(eventId, branch.raion);
    await seedAssessment({ locationId: branch.raion, riskLevel: 'high', riskScore: 7, threatType: 'mlrs' });

    const first = await snapshot();
    const second = await snapshot();

    for (const territory of first.territories) {
      // `publishedAt` is the cutoff the whole payload describes, not the moment the fold ran.
      expect(territory.publishedAt).toBe(first.publication.cutoffAt);
    }
    const raion = byId(first, branch.raion)!;
    expect(raion.icons.map((icon) => `${icon.threatType}:${icon.tone}`))
      .toEqual(['guided_air_bomb:confirmed', 'mlrs:analytic']);
    // Determinism: identical rows and a snapshot-wide clock must produce a byte-identical stack, or
    // the icons would reshuffle between two reads a second apart during exactly the wave they
    // describe.
    expect(JSON.stringify(byId(second, branch.raion)!.icons)).toBe(JSON.stringify(raion.icons));
  });
});
