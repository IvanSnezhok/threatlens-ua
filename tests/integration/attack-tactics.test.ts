import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * The tactical block, end to end: a fortnight of real classification rows, the pass that compares
 * them with the last day, the row it writes and the public payload it ends up in.
 *
 * The unit suite already proves the seven detections fire where they should — it feeds
 * `detectTactics` fixtures and checks both sides of every threshold. What only a live PostgreSQL can
 * prove is the rest of the chain: that the two windows really are half-open and really do not
 * overlap, that a second identical pass writes no second row, that the publication hold reaches this
 * surface, and that a day too thin to compare produces an honest refusal rather than a page of
 * shares over five messages.
 *
 * `attack_tactic_passes` and `attack_tactic_detections` are truncated here rather than in the shared
 * harness list: this is the only file that writes them, and a table that one file owns is a table
 * that file should clear.
 */

const WAR = 'osint-war-monitor';
const OBLAST = 'ua-32';

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const attackAnalyticsRoutes = (await import('../../src/api/attack-analytics-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(attackAnalyticsRoutes);
  await app.ready();
  return app;
}

async function attacksPayload(): Promise<Record<string, never>> {
  (await import('../../src/services/attack-analytics.js')).resetAttackAnalyticsCache();
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/attacks?period=day' });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

/** One classified message, asserted over one oblast, with the classes it matched. */
async function seedMessage(
  externalId: string, publishedAt: Date, types: string[], oblastId = OBLAST
): Promise<void> {
  const messageId = (await sql<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash,processing_status)
     VALUES ($1,$2,$3,'fixture',$2,'processed') RETURNING id`,
    [WAR, externalId, publishedAt]
  )).rows[0]!.id;
  const classificationId = (await sql<{ id: string }>(
    `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
       decision,intent,created_event,threat_type,candidate_threat_types)
     VALUES ($1,$2,'v1',$3,'event_created','threat',true,$4,$5::text[]) RETURNING id`,
    [messageId, WAR, publishedAt, types[0], types]
  )).rows[0]!.id;
  await sql(
    `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
     VALUES ($1,$2,'asserted','explicit_threat')`,
    [classificationId, oblastId]
  );
}

const HOUR = 3_600_000;

/**
 * Fourteen days of three messages each — two cruise, one drone — and then one cluster of twenty in
 * the current day, fifteen of which are drones.
 *
 * Every message is placed at the same time of day, so the hour histogram has the same shape in both
 * windows and the hour detections stay silent: the case under test is the weapon mix, and a fixture
 * that also tripped three other detections would not show which of them the assertion belongs to.
 */
async function seedFortnight(now: Date): Promise<void> {
  for (let day = 1; day <= 14; day += 1) {
    const at = new Date(now.getTime() - (24 * day + 2) * HOUR);
    await seedMessage(`base-${day}-a`, at, ['cruise_missile']);
    await seedMessage(`base-${day}-b`, new Date(at.getTime() + 120_000), ['cruise_missile']);
    await seedMessage(`base-${day}-c`, new Date(at.getTime() + 240_000), ['uav']);
  }
  for (let index = 0; index < 20; index += 1) {
    const at = new Date(now.getTime() - 2 * HOUR + index * 60_000);
    await seedMessage(`current-${index}`, at, [index < 15 ? 'uav' : 'cruise_missile']);
  }
}

async function passRows(): Promise<Array<{
  id: string; digest: string; computed_at: Date; last_confirmed_at: Date;
  current_messages: number; baseline_messages: number; commentary_origin: string;
}>> {
  return (await sql(`SELECT id,digest,computed_at,last_confirmed_at,current_messages,
                            baseline_messages,commentary_origin
                       FROM attack_tactic_passes ORDER BY computed_at`)).rows as never;
}

describe.skipIf(!integrationDatabaseAvailable)('attack tactics', () => {
  beforeAll(async () => { await ensureMigrated(); });

  beforeEach(async () => {
    await resetDatabase();
    await sql(`TRUNCATE attack_tactic_detections, attack_tactic_passes CASCADE`);
    const [{ resetRuntimeSettingsCache }, { resetAnalyticsScheduler }, { resetTacticsCommentaryClock }] =
      await Promise.all([
        import('../../src/services/runtime-settings.js'),
        import('../../src/services/analytics-scheduler.js'),
        import('../../src/services/attack-tactics-commentary.js')
      ]);
    resetRuntimeSettingsCache();
    resetAnalyticsScheduler();
    resetTacticsCommentaryClock();
    (await import('../../src/services/attack-analytics.js')).resetAttackAnalyticsCache();
  });

  it('reads a weapon-mix shift out of a real fortnight, with the arithmetic to check it', async () => {
    const now = new Date();
    await seedFortnight(now);
    const { runTacticsPass } = await import('../../src/services/attack-tactics.js');

    const result = await runTacticsPass('manual', { now });
    expect([result.outcome, result.detections, result.currentMessages]).toEqual(['changed', 2, 20]);

    const detections = (await sql(
      `SELECT detection_type,subject_key,unit,current_value::float8 AS current_value,
              baseline_value::float8 AS baseline_value,current_support,baseline_support,
              effect::float8 AS effect,sentence,rank,data_nature
         FROM attack_tactic_detections ORDER BY rank`
    )).rows as Array<Record<string, never>>;

    // 15 of 20 current class mentions against 14 of 42 in the fortnight.
    expect(detections[0]).toMatchObject({
      detection_type: 'weapon_mix_shift', subject_key: 'uav', unit: 'share',
      current_value: 0.75, baseline_value: 0.3333, current_support: 15, baseline_support: 14,
      effect: 0.4167, rank: 1, data_nature: 'derived'
    });
    expect(String(detections[0]!.sentence)).toContain('75% проти 33.3%');
    expect(detections[1]).toMatchObject({
      detection_type: 'weapon_mix_shift', subject_key: 'cruise_missile',
      current_value: 0.25, baseline_value: 0.6667, current_support: 5, baseline_support: 28
    });

    const [pass] = await passRows();
    expect([pass!.current_messages, pass!.baseline_messages, pass!.commentary_origin])
      .toEqual([20, 42, 'deterministic']);
  }, 60_000);

  it('confirms an unchanged picture instead of writing a second row', async () => {
    const now = new Date();
    await seedFortnight(now);
    const { runTacticsPass } = await import('../../src/services/attack-tactics.js');

    const first = await runTacticsPass('schedule', { now });
    const before = (await passRows())[0]!;

    const later = new Date(now.getTime() + 6 * 60_000);
    const second = await runTacticsPass('schedule', { now: later });

    expect([second.outcome, second.digest]).toEqual(['unchanged', first.digest]);
    const rows = await passRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.computed_at.toISOString()).toBe(before.computed_at.toISOString());
    expect(rows[0]!.last_confirmed_at.getTime()).toBeGreaterThan(before.last_confirmed_at.getTime());
    // The detections are the ones the first pass wrote; nothing was rewritten under them.
    expect((await sql(`SELECT count(*)::int AS n FROM attack_tactic_detections`)).rows[0]!.n).toBe(2);
  }, 60_000);

  it('serves the block on the public attacks endpoint, beside the period aggregates', async () => {
    const now = new Date();
    await seedFortnight(now);
    await (await import('../../src/services/attack-tactics.js')).runTacticsPass('manual', { now });

    const body = await attacksPayload() as never as {
      totals: { messages: number };
      tactics: {
        available: boolean; dataNature: string; methodologyVersion: string;
        totals: { currentMessages: number; baselineMessages: number };
        windows: { currentHours: number; baselineDays: number };
        classifierVersions: string[];
        detections: Array<{ detectionType: string; sentence: string; rank: number }>;
        commentary: { headline: string; findings: string[]; aiGenerated: boolean; model: string | null };
      };
    };

    // The aggregates the page already had are untouched by the block riding beside them.
    expect(body.totals.messages).toBe(20);
    expect([body.tactics.available, body.tactics.dataNature, body.tactics.methodologyVersion])
      .toEqual([true, 'derived', 'tactics-v1']);
    expect(body.tactics.totals).toEqual({ currentMessages: 20, baselineMessages: 42 });
    expect(body.tactics.windows).toMatchObject({ currentHours: 24, baselineDays: 14 });
    expect(body.tactics.classifierVersions).toEqual(['v1']);
    expect(body.tactics.detections.map((row) => row.rank)).toEqual([1, 2]);
    expect(body.tactics.commentary.findings).toEqual(body.tactics.detections.map((row) => row.sentence));
    expect([body.tactics.commentary.aiGenerated, body.tactics.commentary.model]).toEqual([false, null]);
  }, 60_000);

  it('does not serve a pass computed inside the publication hold', async () => {
    const now = new Date();
    await seedFortnight(now);
    // Computed five seconds ago: newer than a `now()-15s` cutoff and older than the request.
    await (await import('../../src/services/attack-tactics.js')).runTacticsPass('manual', {
      now: new Date(Date.now() - 5000)
    });

    const setMode = async (mode: string) => {
      await sql(
        `UPDATE runtime_settings SET publication_mode=$1, mode_changed_at=now() - interval '1 hour',
                updated_at=now()`,
        [mode]
      );
      (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    };

    await setMode('delayed_15s');
    const held = await attacksPayload() as never as { tactics: { available: boolean; reason: string } };
    expect([held.tactics.available, held.tactics.reason]).toEqual([false, 'insufficient_data']);

    await setMode('live');
    const live = await attacksPayload() as never as { tactics: { available: boolean } };
    expect(live.tactics.available).toBe(true);
  }, 60_000);

  it('refuses to compare a day too thin to compare', async () => {
    const now = new Date();
    // A fortnight of baseline and only five messages today: every share would have a single-digit
    // denominator, so the pass emits nothing at all rather than a page of confident fractions.
    for (let day = 1; day <= 14; day += 1) {
      await seedMessage(`thin-base-${day}`, new Date(now.getTime() - (24 * day + 2) * HOUR), ['uav']);
    }
    for (let index = 0; index < 5; index += 1) {
      await seedMessage(`thin-${index}`, new Date(now.getTime() - 2 * HOUR), ['ballistic_missile']);
    }

    const { runTacticsPass } = await import('../../src/services/attack-tactics.js');
    const result = await runTacticsPass('event', { now });
    expect([result.outcome, result.currentMessages, result.passId]).toEqual(['insufficient', 5, null]);
    expect(await passRows()).toEqual([]);

    const body = await attacksPayload() as never as {
      tactics: { available: boolean; reason: string; detections: unknown[]; commentary: unknown };
    };
    expect([body.tactics.available, body.tactics.reason]).toEqual([false, 'insufficient_data']);
    expect([body.tactics.detections, body.tactics.commentary]).toEqual([[], null]);
  }, 60_000);

  it('runs as a leg of the recompute, behind its own five-minute floor', async () => {
    const now = new Date();
    await seedFortnight(now);
    const { recomputeAnalytics } = await import('../../src/services/analytics-scheduler.js');

    // `minPassIntervalMs: 0` disables the RECOMPUTE's own guard, which would otherwise refuse the
    // second call for a reason that has nothing to do with the leg under test.
    const first = await recomputeAnalytics('manual', { minPassIntervalMs: 0 });
    expect(first.skipped).toBeNull();
    const after = await passRows();
    expect(after).toHaveLength(1);

    const second = await recomputeAnalytics('event', { minPassIntervalMs: 0 });
    expect(second.skipped).toBeNull();
    const unchanged = await passRows();
    // The floor refused the leg outright: not even `last_confirmed_at` moved, which is what
    // separates «the pass did not run» from «the pass ran and found nothing new».
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]!.last_confirmed_at.toISOString())
      .toBe(after[0]!.last_confirmed_at.toISOString());

    // An operator pressing «Оновити зараз» overrides the floor, exactly like every other leg here.
    await recomputeAnalytics('manual', { minPassIntervalMs: 0 });
    const confirmed = await passRows();
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.last_confirmed_at.getTime())
      .toBeGreaterThan(after[0]!.last_confirmed_at.getTime());
  }, 90_000);
});
