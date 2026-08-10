import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers `src/api/analytics-routes.ts` — the operator-only surface over the classification archive —
 * and the optional model layer behind `/ops/api/analytics/narrative`.
 *
 * The plugin is registered onto a bare Fastify instance rather than onto `buildServer()`. That is
 * the property worth pinning: it is self-contained, carries its own auth check, and is attached to
 * the real server with one `app.register(analyticsRoutes)` line that does not have to be threaded
 * through anything else.
 *
 * The narrative tests are the acceptance criterion for "the model is optional": the numbers are
 * identical with the model off, with the model returning nonsense, and with the model timing out.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const WAR = 'osint-war-monitor';
const POLTAVA = 'ua-53';

async function buildApp() {
  const Fastify = (await import('fastify')).default;
  const analyticsRoutes = (await import('../../src/api/analytics-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(analyticsRoutes);
  await app.ready();
  return app;
}

/** One drone event over Poltava, raised and then stood down by the same monitor. */
async function seedMinimalArchive(): Promise<void> {
  const event = (await sql<{ id: string }>(
    `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,last_observed_at,valid_until)
     VALUES ('uav','withdrawn','monitoring','Fixture','Fixture',
             '2026-02-05T20:00:00Z','2026-02-05T20:00:00Z','2026-02-05T20:30:00Z') RETURNING id`
  )).rows[0]!.id;
  const messages: string[] = [];
  for (const [index, at] of ['2026-02-05T20:00:00Z', '2026-02-05T21:00:00Z'].entries()) {
    messages.push((await sql<{ id: string }>(
      `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash,processing_status)
       VALUES ($1,$2,$3,'fixture',$2,'processed') RETURNING id`,
      [WAR, `route-fixture-${index}`, at]
    )).rows[0]!.id);
  }
  const classification = (await sql<{ id: string }>(
    `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
       decision,intent,created_event,threat_type,candidate_threat_types,event_id)
     VALUES ($1,$2,'v1','2026-02-05T20:00:00Z','event_created','threat',true,'uav',ARRAY['uav'],$3)
     RETURNING id`, [messages[0], WAR, event]
  )).rows[0]!.id;
  await sql(
    `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
     VALUES ($1,$2,'asserted','explicit_threat')`, [classification, POLTAVA]
  );
  await sql(
    `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
       decision,intent,created_event,threat_type,candidate_threat_types,retraction_coverage,
       retracted_threat_types,withdrawn_assertions)
     VALUES ($1,$2,'v1','2026-02-05T21:00:00Z','de_escalation','de_escalation',false,NULL,ARRAY[]::text[],
             'located',ARRAY['uav'],1)`, [messages[1], WAR]
  );
  await sql(
    `INSERT INTO threat_assertions(event_id,source_id,independence_group,location_id,threat_type,
       asserted_at,asserted_message_id,valid_until,withdrawn_at,withdrawn_message_id,withdrawal_reason)
     VALUES ($1,$2,$2,$3,'uav','2026-02-05T20:00:00Z',$4,'2026-02-05T20:30:00Z',
             '2026-02-05T21:00:00Z',$5,'de_escalation')`,
    [event, WAR, POLTAVA, messages[0], messages[1]]
  );
}

const WINDOW = 'from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z&bucket=month';

describe.skipIf(!integrationDatabaseAvailable)('analytics routes', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    const { resetAnalyticsCaches } = await import('../../src/services/analytics-archive.js');
    resetAnalyticsCaches();
    await seedMinimalArchive();
  });

  it('refuses every route without operator credentials', async () => {
    const app = await buildApp();
    try {
      for (const path of [
        '/ops/api/analytics/coverage', '/ops/api/analytics/threat-dynamics',
        '/ops/api/analytics/geography-shift', '/ops/api/analytics/loss-points',
        '/ops/api/analytics/sources', '/ops/api/analytics/strike-composition',
        '/ops/api/analytics/classifier-versions', '/ops/api/analytics/overview',
        '/ops/api/analytics/narrative'
      ]) {
        const response = await app.inject({ method: 'GET', url: path });
        expect([path, response.statusCode]).toEqual([path, 401]);
        expect(response.headers['www-authenticate']).toBe('Basic realm="ThreatLens Ops"');
      }
      const wrong = await app.inject({
        method: 'GET', url: '/ops/api/analytics/coverage',
        headers: { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` }
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  /**
   * This plugin refuses from an `onRequest` hook rather than from inside each handler — the other
   * shape of the same guard, and the one that would have been missed had the fix been applied
   * handler by handler. It must suppress `WWW-Authenticate` for the console's own fetch for the
   * same reason: Chrome honours the challenge on a `fetch()` too, and the analytics tab is drawn
   * by the same console that the challenge locks out.
   */
  it('drops the challenge for the console fetch while still refusing it', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET', url: '/ops/api/analytics/coverage',
        headers: { 'x-requested-with': 'XMLHttpRequest' }
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.json()).toEqual({ error: 'unauthorized' });

      // Bad credentials plus the mark are still bad credentials.
      const wrong = await app.inject({
        method: 'GET', url: '/ops/api/analytics/coverage',
        headers: {
          authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}`,
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.headers['www-authenticate']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('keeps its auth hook inside its own encapsulation context', async () => {
    // The plugin is registered without fastify-plugin, so the `onRequest` hook that demands operator
    // credentials applies to its routes and nothing else. This is what makes
    // `await app.register(analyticsRoutes)` safe to drop into `buildServer()` next to the public API
    // — without encapsulation that one line would put a 401 in front of the whole site.
    const Fastify = (await import('fastify')).default;
    const analyticsRoutes = (await import('../../src/api/analytics-routes.js')).default;
    const app = Fastify({ logger: false });
    app.get('/api/v1/public', async () => ({ ok: true }));
    await app.register(analyticsRoutes);
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/public' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/ops/api/analytics/coverage' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('serves each slice to an authenticated operator', async () => {
    const app = await buildApp();
    try {
      const dynamics = await app.inject({
        method: 'GET', url: `/ops/api/analytics/threat-dynamics?${WINDOW}`, headers: { authorization: OPS }
      });
      expect(dynamics.statusCode).toBe(200);
      expect(dynamics.json().series).toEqual([
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', messages: 1, eventsRaised: 1, events: 1 }
      ]);

      const loss = await app.inject({
        method: 'GET', url: `/ops/api/analytics/loss-points?${WINDOW}`, headers: { authorization: OPS }
      });
      expect(loss.json().interception).toMatchObject({ asserted: 1, withdrawn: 1, withdrawnShare: 1 });
      expect(loss.json().closedEvents).toHaveLength(1);

      const coverage = await app.inject({
        method: 'GET', url: '/ops/api/analytics/coverage', headers: { authorization: OPS }
      });
      expect(coverage.json().versions).toEqual([expect.objectContaining({ classifierVersion: 'v1', messages: 2 })]);

      for (const path of ['geography-shift', 'sources', 'strike-composition', 'overview']) {
        const response = await app.inject({
          method: 'GET', url: `/ops/api/analytics/${path}?${WINDOW}`, headers: { authorization: OPS }
        });
        expect([path, response.statusCode]).toEqual([path, 200]);
      }
    } finally {
      await app.close();
    }
  });

  it('accepts a repeated or comma-separated version filter', async () => {
    const app = await buildApp();
    try {
      for (const query of ['version=v1&version=v9', 'version=v1,v9']) {
        const response = await app.inject({
          method: 'GET', url: `/ops/api/analytics/threat-dynamics?${WINDOW}&${query}`, headers: { authorization: OPS }
        });
        expect(response.json().window.classifierVersions).toEqual(['v1', 'v9']);
        expect(response.json().series).toHaveLength(1);
      }
    } finally {
      await app.close();
    }
  });

  it('answers a bad window with a named 400 rather than a 500', async () => {
    const app = await buildApp();
    try {
      const cases: Array<[string, string]> = [
        ['from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'window_too_long'],
        ['from=2026-03-01T00:00:00Z&to=2026-02-01T00:00:00Z', 'invalid_range'],
        ['from=not-a-date', 'invalid_from'],
        [`${WINDOW}&bucket=fortnight`, 'invalid_bucket'],
        [`${WINDOW}&limit=0`, 'invalid_limit']
      ];
      for (const [query, code] of cases) {
        const response = await app.inject({
          method: 'GET', url: `/ops/api/analytics/threat-dynamics?${query}`, headers: { authorization: OPS }
        });
        expect([query, response.statusCode, response.json().error]).toEqual([query, 400, code]);
      }
      const missing = await app.inject({
        method: 'GET', url: `/ops/api/analytics/classifier-versions?${WINDOW}`, headers: { authorization: OPS }
      });
      expect([missing.statusCode, missing.json().error]).toEqual([400, 'missing_versions']);
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  describe('the narrative endpoint', () => {
    async function withNarrativeEnabled<T>(
      settings: Record<string, string | boolean>, body: () => Promise<T>
    ): Promise<T> {
      const { config } = await import('../../src/config.js');
      const mutable = config as unknown as Record<string, unknown>;
      const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, mutable[key]]));
      Object.assign(mutable, settings);
      try {
        return await body();
      } finally {
        Object.assign(mutable, saved);
      }
    }

    it('returns the full overview and a deterministic narrative when no model is configured', async () => {
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: 'GET', url: `/ops/api/analytics/narrative?${WINDOW}`, headers: { authorization: OPS }
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        // Identical numbers to /overview — the narrative is an extra field, never a substitute.
        expect(body.dynamics.series).toHaveLength(1);
        expect(body.narrative.generatedBy).toBe('deterministic');
        expect(body.narrative.facts.interception.withdrawnPercent).toBe(100);
        expect(body.narrative.caveats.join(' ')).toContain('модель не залучалася');
      } finally {
        await app.close();
      }
    });

    it('uses a model answer that stays inside the numbers it was given', async () => {
      const { narrateOverview } = await import('../../src/services/analytics-narrative.js');
      const { resolveWindow, strategicOverview } = await import('../../src/services/analytics-archive.js');
      const overview = await strategicOverview(resolveWindow({ from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }));

      const narrative = await withNarrativeEnabled({
        ANALYTICS_NARRATIVE_ENABLED: true, CODEX_BASE_URL: 'https://codex.test/v1',
        CODEX_API_KEY: 'oauth-token', CODEX_MODEL: 'gpt-test', CODEX_ACCOUNT_ID: 'acct-1'
      }, async () => {
        let seen: { url: string; headers: Record<string, string> } | null = null;
        const fetchImpl = (async (url: string, init: RequestInit) => {
          seen = { url: String(url), headers: init.headers as Record<string, string> };
          return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              headline: 'Знято 1 з 1 тверджень.',
              findings: ['Єдина подія за вікно — БпЛА, знята за 60 хв.'],
              caveats: ['Версія класифікатора v1.']
            }) } }]
          }), { status: 200 });
        }) as unknown as typeof fetch;
        const result = await narrateOverview(overview, { fetchImpl });
        expect(seen!.url).toBe('https://codex.test/v1/chat/completions');
        // The OAuth access token travels as a bearer, and the account header is only sent when set.
        expect(seen!.headers.Authorization).toBe('Bearer oauth-token');
        expect(seen!.headers['ChatGPT-Account-Id']).toBe('acct-1');
        return result;
      });

      expect(narrative.generatedBy).toBe('model');
      expect(narrative.model).toBe('gpt-test');
      expect(narrative.rejectionReason).toBeNull();
      expect(narrative.headline).toBe('Знято 1 з 1 тверджень.');
      const run = await sql<{ status: string; model: string; prompt_version: string }>(
        `SELECT status,model,prompt_version FROM ai_runs`
      );
      expect(run.rows).toEqual([{ status: 'success', model: 'gpt-test', prompt_version: 'analytics-narrative-v1' }]);
    });

    it('throws away a narrative that states a number the aggregates do not support', async () => {
      const { narrateOverview } = await import('../../src/services/analytics-narrative.js');
      const { resolveWindow, strategicOverview } = await import('../../src/services/analytics-archive.js');
      const overview = await strategicOverview(resolveWindow({ from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }));

      const narrative = await withNarrativeEnabled({
        ANALYTICS_NARRATIVE_ENABLED: true, AI_BASE_URL: 'https://ai.test/v1',
        AI_API_KEY: 'key', AI_MODEL: 'fallback-model',
        CODEX_BASE_URL: '', CODEX_API_KEY: '', CODEX_MODEL: ''
      }, async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            headline: 'Зафіксовано 47 ударних БпЛА над Полтавщиною.',
            findings: ['Активність зросла.'],
            caveats: []
          }) } }]
        }), { status: 200 })) as unknown as typeof fetch;
        return narrateOverview(overview, { fetchImpl });
      });

      expect(narrative.generatedBy).toBe('deterministic');
      expect(narrative.rejectionReason).toBe('ungrounded_number:47');
      expect(narrative.headline).not.toContain('47');
      // The numbers are untouched by the rejection: they never came from the model in the first place.
      expect(narrative.facts.interception).toEqual({
        asserted: 1, withdrawn: 1, withdrawnPercent: 100, medianHeldMinutes: 60
      });
      const run = await sql<{ status: string; error: string }>(`SELECT status,error FROM ai_runs`);
      expect(run.rows).toEqual([{ status: 'failed', error: 'ungrounded_number:47' }]);
    });

    it('falls back deterministically when the model fails outright', async () => {
      const { narrateOverview } = await import('../../src/services/analytics-narrative.js');
      const { resolveWindow, strategicOverview } = await import('../../src/services/analytics-archive.js');
      const overview = await strategicOverview(resolveWindow({ from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }));

      const narrative = await withNarrativeEnabled({
        ANALYTICS_NARRATIVE_ENABLED: true, CODEX_BASE_URL: 'https://codex.test/v1',
        CODEX_API_KEY: 'oauth-token', CODEX_MODEL: 'gpt-test'
      }, async () => {
        const fetchImpl = (async () => new Response('gateway timeout', { status: 504 })) as unknown as typeof fetch;
        return narrateOverview(overview, { fetchImpl });
      });

      expect(narrative.generatedBy).toBe('deterministic');
      expect(narrative.rejectionReason).toContain('504');
      expect(narrative.findings.length).toBeGreaterThan(0);
      const run = await sql<{ status: string }>(`SELECT status FROM ai_runs`);
      expect(run.rows).toEqual([{ status: 'failed' }]);
    });
  });
});
