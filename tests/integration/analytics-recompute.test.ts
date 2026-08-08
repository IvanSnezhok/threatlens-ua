import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OBLAST, count, delay, ensureMigrated, integrationDatabaseAvailable, outboxRows,
  resetDatabase, runFanout, seedSubscription, seedUser, sql, waitFor
} from '../helpers/db.js';

/**
 * A relevant event recomputes the analytics once, a burst recomputes them once, and neither the
 * recompute nor its event ever reaches a subscriber's phone.
 *
 * Before this delivery the analytics had three unrelated clocks and no invalidation of any kind: a
 * threat observed at 10:00:01 could first appear in the map's аналітична оцінка at 10:15:00. What is
 * pinned here is the missing trigger and its three guards — the debounce that turns a wave into one
 * pass, the starvation ceiling that stops a continuously re-armed window from postponing the pass
 * for ever, and the operator switch that turns the whole thing off without a restart. Plus the
 * boundary that makes the feature safe: the recompute reads the **recorded** feed, so it is not held
 * by the publication cutoff, and it never produces a notification.
 *
 * **Harness (b) of CONTRACT §12 wave 3**: a bare `Fastify({ logger: false })` with
 * `app.register(analyticsRoutes)`, copied from `tests/integration/analytics-routes.test.ts:20-27`.
 *
 * **Wall clock is exercised by writing real rows and shortening the settings, never by fake timers**,
 * because the decisions are spread across PostgreSQL `now()` and a real `setTimeout` — vitest can
 * move neither. `minPassIntervalMs` is threaded through `startAnalyticsRecomputeScheduler`'s deps
 * bag, which exists for exactly this: a case that has to observe two passes cannot wait a real
 * minute, and shortening the *debounce* instead would leave the interval guard refusing the second
 * pass, which is what that guard is for.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const WINDOW = 'from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z&bucket=month';
const OTHER_WINDOW = 'from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&bucket=month';

/** The debounce CHECK floor in migration 022. Nothing shorter can be stored, so nothing shorter can
 *  be tested through the row the worker actually reads. */
const DEBOUNCE_FLOOR_MS = 5000;

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const analyticsRoutes = (await import('../../src/api/analytics-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(analyticsRoutes);
  await app.ready();
  return app;
}

async function configure(fields: {
  debounceMs?: number; maxDelayMs?: number; eventDriven?: boolean;
  mode?: 'live' | 'delayed_15s'; cooldownMs?: number;
}): Promise<void> {
  await sql(
    `UPDATE runtime_settings SET
       analytics_debounce_ms = COALESCE($1::int, analytics_debounce_ms),
       analytics_max_delay_ms = COALESCE($2::int, analytics_max_delay_ms),
       analytics_event_driven = COALESCE($3::boolean, analytics_event_driven),
       publication_mode = COALESCE($4::text, publication_mode),
       codex_cooldown_ms = COALESCE($5::int, codex_cooldown_ms),
       mode_changed_at = now() - interval '1 hour', updated_at = now()`,
    [fields.debounceMs ?? null, fields.maxDelayMs ?? null, fields.eventDriven ?? null,
      fields.mode ?? null, fields.cooldownMs ?? null]
  );
  // The harness pool is not the application pool, so the memo in `runtime-settings.ts` has to be
  // told; the worker reads it on every event.
  (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
}

/**
 * Starts the hub and the worker, and hands back one closure that stops both.
 *
 * The hub is started FIRST and given a full tick before anything is written: the first poll
 * initialises the internal cursor to the unbounded `max(version)`, so a row inserted before that
 * tick lands *below* the cursor and is never delivered — and the `waitFor` below it would then time
 * out for a reason that has nothing to do with the debounce.
 */
async function startWorker(deps: { minPassIntervalMs?: number } = {}): Promise<() => void> {
  const { eventHub } = await import('../../src/services/sse.js');
  const { startAnalyticsRecomputeScheduler } = await import('../../src/services/analytics-scheduler.js');
  const stop = startAnalyticsRecomputeScheduler(
    { info: () => undefined, error: () => undefined },
    { minPassIntervalMs: deps.minPassIntervalMs ?? 200 }
  );
  eventHub.start();
  await delay(1300);
  return () => { stop(); eventHub.stop(); };
}

async function appendTrigger(index = 0): Promise<void> {
  await sql(
    `INSERT INTO system_event_log(event_type,payload) VALUES ('threat.created',$1::jsonb)`,
    [JSON.stringify({ eventId: `recompute-${index}` })]
  );
}

async function recomputes(): Promise<Array<{ trigger: string; codex: string }>> {
  const rows = await sql<{ payload: { trigger: string; codex: string } }>(
    `SELECT payload FROM system_event_log WHERE event_type='analytics.updated' ORDER BY version`
  );
  return rows.rows.map((row) => row.payload);
}

const recomputeCount = () => count('system_event_log', `event_type='analytics.updated'`);

/** Overrides parsed config for one body. `src/config.ts` freezes nothing, and every consumer reads
 *  the live object, so this is the only seam a route-level Codex test has. */
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

const CODEX_ON = {
  ANALYTICS_NARRATIVE_ENABLED: true,
  CODEX_BASE_URL: 'https://codex.test/v1',
  CODEX_API_KEY: 'integration-token',
  CODEX_MODEL: 'gpt-test'
};

/** A model endpoint that is reachable in configuration and unreachable in fact. */
function stubBrokenCodex(): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', async () => {
    state.calls += 1;
    throw new Error('codex is unreachable');
  });
  return state;
}

async function publicView(cutoff: Date): Promise<string> {
  const { activeAlerts, currentAssessments, liveThreats } = await import('../../src/repositories/events.js');
  return JSON.stringify({
    alerts: await activeAlerts(cutoff),
    threats: await liveThreats(cutoff),
    assessments: await currentAssessments(cutoff)
  });
}

describe.skipIf(!integrationDatabaseAvailable)('event-driven analytics recompute', () => {
  beforeAll(async () => { await ensureMigrated(); });

  // The five in-process seams of CONTRACT §1.4 beside the TRUNCATE, in the order documented in
  // `tests/helpers/db.ts`. `resetEventHubCursor()` is not optional here: `TRUNCATE … RESTART
  // IDENTITY` restarts `version` at 1 while the hub keeps its old cursor, so from the second test
  // onward every `version > cursor` selects nothing and every `waitFor` on `analytics.updated`
  // times out. `resetAnalyticsScheduler()` also puts `lastCompletedAt` back to 0, which is what
  // makes the FIRST pass of every test run whatever the previous test spent.
  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/sse.js')).eventHub.stop();
  });

  // ----------------------------------------------------------------------------------------------
  describe('the debounce', () => {
    it('recomputes exactly once after the debounce when one threat.created is appended', async () => {
      await configure({ debounceMs: DEBOUNCE_FLOOR_MS });
      const stop = await startWorker();
      try {
        await appendTrigger();

        await waitFor(async () => await recomputeCount() >= 1, 'the debounced recompute to run', 25_000);
        // Long enough for a second, wrongly armed window to fire.
        await delay(DEBOUNCE_FLOOR_MS + 2000);

        const passes = await recomputes();
        expect(passes).toHaveLength(1);
        expect(passes[0]!.trigger).toBe('event');
      } finally {
        stop();
      }
    }, 60_000);

    it('coalesces ten appends inside one window into one recompute', async () => {
      await configure({ debounceMs: DEBOUNCE_FLOOR_MS, maxDelayMs: 600_000 });
      const stop = await startWorker();
      try {
        for (let index = 0; index < 10; index += 1) await appendTrigger(index);

        await waitFor(async () => await recomputeCount() >= 1, 'the coalesced recompute to run', 25_000);
        await delay(DEBOUNCE_FLOOR_MS + 2000);

        // Ten events, one pass. A trailing-edge debounce re-armed by every event is the whole point:
        // a mass attack is the case the analytics exist for and the case that would otherwise turn
        // into ten risk passes.
        expect(await recomputes()).toHaveLength(1);
      } finally {
        stop();
      }
    }, 60_000);

    it('fires at analyticsMaxDelayMs under a sustained burst instead of postponing for ever', async () => {
      await configure({ debounceMs: DEBOUNCE_FLOOR_MS, maxDelayMs: 8000 });
      const stop = await startWorker({ minPassIntervalMs: 200 });
      try {
        const events = 7;
        for (let index = 0; index < events; index += 1) {
          await appendTrigger(index);
          // Shorter than the debounce, so the window is re-armed every time and only the starvation
          // ceiling can ever fire it.
          if (index < events - 1) await delay(4000);
        }
        await waitFor(async () => await recomputeCount() >= 2, 'the starvation ceiling to fire twice', 30_000);

        const passes = await recomputes();
        expect(passes.length).toBeGreaterThanOrEqual(2);
        expect(passes.length).toBeLessThan(events);
        for (const pass of passes) expect(pass.trigger).toBe('event');
      } finally {
        stop();
      }
    }, 120_000);

    it('is not held by the publication cutoff in delayed_15s', async () => {
      await configure({ debounceMs: DEBOUNCE_FLOOR_MS, mode: 'delayed_15s' });
      const stop = await startWorker();
      try {
        const startedAt = Date.now();
        await appendTrigger();

        await waitFor(async () => await recomputeCount() >= 1, 'the recompute under a delayed public view', 30_000);
        const elapsed = Date.now() - startedAt;

        // The worker subscribes to `'internal-event'`, the RECORDED feed, never to `'event'`, the
        // published one. On the gated feed this would have been delaySeconds + debounce, i.e. past
        // twenty seconds, and the map would pay the hold twice — once on the presentation and once
        // on the assessment that describes it.
        expect(elapsed).toBeLessThan(13_000);
        expect((await recomputes())[0]!.trigger).toBe('event');
      } finally {
        stop();
      }
    }, 60_000);

    it('stops event-driven recomputes when the operator switch is off, but not the button', async () => {
      await configure({ debounceMs: DEBOUNCE_FLOOR_MS, eventDriven: false });
      const stop = await startWorker();
      const app = await buildApp();
      try {
        await appendTrigger();
        await delay(DEBOUNCE_FLOOR_MS + 3000);
        expect(await recomputeCount()).toBe(0);

        // An operator who pressed «Оновити зараз» has already overridden the switch by pressing it.
        const response = await app.inject({
          method: 'POST', url: '/ops/api/analytics/recalculate', headers: { authorization: OPS }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ trigger: 'manual', skipped: null });
        expect(await recomputeCount()).toBe(1);
        expect((await recomputes())[0]!.trigger).toBe('manual');
      } finally {
        await app.close();
        stop();
      }
    }, 60_000);
  });

  // ----------------------------------------------------------------------------------------------
  describe('the manual pass', () => {
    it('401s without Basic auth', async () => {
      const app = await buildApp();
      try {
        const response = await app.inject({ method: 'POST', url: '/ops/api/analytics/recalculate' });

        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Basic realm="ThreatLens Ops"');
        expect(await recomputeCount()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('runs, reports the Codex state, and always answers 200', async () => {
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: 'POST', url: '/ops/api/analytics/recalculate', headers: { authorization: OPS }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        // A status code cannot say "it ran, but there was no model": `skipped` and `codex` carry the
        // outcome, and on a deployment with nothing configured that outcome is `disabled`.
        expect(body).toMatchObject({ trigger: 'manual', codex: 'disabled', skipped: null, fallback: false });
        expect(Date.parse(body.recomputedAt)).not.toBeNaN();
        expect((await recomputes())).toEqual([
          expect.objectContaining({ trigger: 'manual', codex: 'disabled' })
        ]);
      } finally {
        await app.close();
      }
    }, 60_000);

    it('drops a concurrent second pass instead of running two', async () => {
      const { runManualRecompute } = await import('../../src/services/analytics-scheduler.js');

      // `execute()` owns `running` and sets it synchronously before its first await, which is what
      // makes the second call's check-then-act safe on a single-threaded loop.
      const [first, second] = await Promise.all([runManualRecompute(), runManualRecompute()]);

      const outcomes = [first.skipped, second.skipped].sort();
      expect(outcomes).toEqual([null, 'overlap']);
      expect(await recomputeCount()).toBe(1);
    }, 60_000);

    it('does not swallow a debounce pending underneath it', async () => {
      await configure({ debounceMs: DEBOUNCE_FLOOR_MS });
      const stop = await startWorker({ minPassIntervalMs: 200 });
      try {
        const { runManualRecompute } = await import('../../src/services/analytics-scheduler.js');
        const manual = runManualRecompute();
        await appendTrigger();
        expect((await manual).trigger).toBe('manual');

        await waitFor(async () => await recomputeCount() >= 2, 'the pending event pass to follow the manual one', 30_000);
        await delay(DEBOUNCE_FLOOR_MS + 2000);

        // Exactly ONE further pass. A manual run that bypassed `execute()` would never drain `rearm`
        // or reset `firstPendingAt`, and the burst's pending recompute would be silently dropped
        // until the fifteen-minute floor.
        const passes = await recomputes();
        expect(passes.map((pass) => pass.trigger)).toEqual(['manual', 'event']);
      } finally {
        stop();
      }
    }, 90_000);
  });

  // ----------------------------------------------------------------------------------------------
  describe('the Codex leg', () => {
    it('leaves the map alone and labels the narrative when the model is unreachable', async () => {
      await sql(
        `INSERT INTO alert_periods(location_id,alert_type,status,started_at,published_at)
         VALUES ($1,'air_raid','active', now() - interval '10 minutes', now() - interval '10 minutes')`,
        [OBLAST]
      );
      await sql(
        `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,
           last_observed_at,valid_until,created_at)
         VALUES ('uav','observed','monitoring','Фікстура','Фікстура', now() - interval '5 minutes',
                 now() - interval '1 minute', now() + interval '2 hours', now() - interval '5 minutes')`
      );
      const cutoff = new Date();
      const before = await publicView(cutoff);

      const app = await buildApp();
      try {
        await withConfig(CODEX_ON, async () => {
          const codex = stubBrokenCodex();

          const recompute = await app.inject({
            method: 'POST', url: '/ops/api/analytics/recalculate', headers: { authorization: OPS }
          });
          expect(recompute.statusCode).toBe(200);
          // The model failed; the pass did not.
          expect(recompute.json()).toMatchObject({ codex: 'failed', fallback: true, skipped: null });
          expect(codex.calls).toBeGreaterThan(0);

          const narrative = await app.inject({
            method: 'GET', url: `/ops/api/analytics/narrative?${WINDOW}`, headers: { authorization: OPS }
          });
          const overview = await app.inject({
            method: 'GET', url: `/ops/api/analytics/overview?${WINDOW}`, headers: { authorization: OPS }
          });

          expect(narrative.statusCode).toBe(200);
          expect(narrative.json().narrative.generatedBy).toBe('deterministic');
          expect(narrative.json().narrative.aiGenerated).toBe(false);
          expect(narrative.json().narrative.rejectionReason).not.toBeNull();
          expect(narrative.json().narrative.findings.length).toBeGreaterThan(0);
          // «Analytics are complete without a model»: every number is the deterministic one, and the
          // narrative is an extra field rather than a substitute.
          const { narrative: _prose, ...numbers } = narrative.json();
          expect(numbers).toEqual(overview.json());
        });

        expect(await publicView(cutoff)).toBe(before);
      } finally {
        await app.close();
      }
    }, 60_000);

    it('labels the second narrative as a cooldown without a second model call', async () => {
      await configure({ cooldownMs: 900_000 });
      const app = await buildApp();
      try {
        await withConfig(CODEX_ON, async () => {
          const codex = stubBrokenCodex();

          const first = await app.inject({
            method: 'GET', url: `/ops/api/analytics/narrative?${WINDOW}`, headers: { authorization: OPS }
          });
          expect(first.statusCode).toBe(200);
          expect(codex.calls).toBe(1);
          expect(first.json().narrative.rejectionReason).toContain('transport_error');

          // A different window, so the two-key memo (`windowKey` + `factsKey`) legitimately misses
          // and the request actually reaches the cooldown check rather than the cache.
          const second = await app.inject({
            method: 'GET', url: `/ops/api/analytics/narrative?${OTHER_WINDOW}`, headers: { authorization: OPS }
          });

          expect(second.statusCode).toBe(200);
          expect(second.json().narrative.rejectionReason).toBe('codex_cooldown');
          expect(second.json().narrative.generatedBy).toBe('deterministic');
          expect(second.json().narrative.model).toBe('gpt-test');
          // The slot is reserved BEFORE the call, so concurrency and failure are both spend.
          expect(codex.calls).toBe(1);
        });
      } finally {
        await app.close();
      }
    }, 60_000);

    it('records the four new ai_runs columns for every model attempt', async () => {
      const app = await buildApp();
      try {
        await withConfig(CODEX_ON, async () => {
          stubBrokenCodex();
          const response = await app.inject({
            method: 'GET', url: `/ops/api/analytics/narrative?${WINDOW}`, headers: { authorization: OPS }
          });
          expect(response.statusCode).toBe(200);
        });

        const runs = await sql<{
          surface: string | null; classifier_version: string | null;
          validation_status: string | null; fallback_reason: string | null;
        }>(`SELECT surface,classifier_version,validation_status,fallback_reason FROM ai_runs`);

        expect(runs.rowCount).toBeGreaterThan(0);
        for (const run of runs.rows) {
          // `surface` is the FEATURE that spent the call — the discriminator an operator reasons in
          // («the narrative stopped»), which `prompt_version` only encoded by convention.
          expect(run.surface).toBe('narrative');
          expect(run.classifier_version).not.toBeNull();
          expect(['passed', 'rejected', 'skipped']).toContain(run.validation_status);
          expect(run.fallback_reason).not.toBeNull();
        }
      } finally {
        await app.close();
      }
    }, 60_000);
  });

  // ----------------------------------------------------------------------------------------------
  describe('what a recompute must never do', () => {
    it('never turns analytics.updated or publication.changed into a notification', async () => {
      await seedUser(9801);
      await seedSubscription({ chatId: 9801, locationId: OBLAST });
      await sql(
        `INSERT INTO system_event_log(event_type,payload) VALUES
           ('analytics.updated','{"trigger":"event","durationMs":12}'::jsonb),
           ('publication.changed','{"mode":"delayed_15s","delaySeconds":15}'::jsonb)`
      );

      await runFanout();

      // The fanout's own event-type filter is what makes this true, and it is the reason the two
      // new types could be added to the log at all without spamming every subscriber.
      expect(await outboxRows()).toEqual([]);
    });
  });
});
