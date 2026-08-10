import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Operator research, end to end, against a live PostgreSQL.
 *
 * Three things are being proved, and the third is why the file is long.
 *
 *  1. **A memo is arithmetic over the real archive.** Messages go in through `processMessage`, and
 *     the counts, the bands and the confidence that come out are the ones the classification archive
 *     supports — not fixtures, not a hand-written row.
 *  2. **Every governance path writes a row, and the refusals are the interesting ones.** The switch,
 *     the daily cap and the per-oblast cooldown each refuse with their own status, each refusal is
 *     recorded, and a request the switch turned away spends nothing — including no `ai_runs` row.
 *  3. **None of it can be observed from outside `/ops`.** A marker is planted inside a stored memo
 *     and every public surface the product has, SSE replay included, is read and searched for it.
 *     `src/api/vector-isolation.test.ts` proves the CODE cannot reach the memo; this proves the
 *     RESPONSES do not contain it, which is the property a reader depends on.
 *
 * Nothing here touches the network. There is no Codex session in the test environment, so the model
 * path resolves to its pre-flight refusal — which is itself one of the behaviours under test.
 */

const WAR = 'osint-war-monitor';
const ERADAR = 'osint-eradar';
const AERIS = 'osint-aeris-rimor';
const POLTAVA = 'ua-53';
const KHARKIV = 'ua-63';

/** Planted into a stored memo so a leak is a string match rather than a judgement call. */
const MARKER = 'RESEARCH-LEAK-CANARY-4b71ce';

const OPS_AUTH = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

let sequence = 0;

/**
 * An instant `daysAgo` days back, at 21:00 UTC.
 *
 * 21:00 UTC is 00:00 Kyiv in summer and 23:00 Kyiv in winter, so it lands inside the night band
 * (22, 23, 0–5) whichever side of the daylight-saving change the suite runs on. The day counterpart
 * below is 09:00 UTC — noon or 11:00 in Kyiv, inside the day band and outside the night one — for the
 * same reason. Pinning the hour in UTC and asserting the band membership rather than the clock is
 * what keeps this file from failing twice a year.
 */
function nightInstant(daysAgo: number): Date {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - daysAgo);
  at.setUTCHours(21, 0, 0, 0);
  return at;
}

function dayInstant(daysAgo: number): Date {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - daysAgo);
  at.setUTCHours(9, 0, 0, 0);
  return at;
}

async function ingest(sourceId: string, text: string, publishedAt: Date) {
  const { processMessage, resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
  resetMonitorCoalescing();
  sequence += 1;
  return processMessage({
    sourceId, externalId: `research-${sequence}`, publishedAt, text, rawPayload: { channel: sourceId }
  }, { monitor: true });
}

/**
 * Four drone messages in the night band over four different days, one in the day band, and one
 * ballistic message about a different oblast that must never reach a Poltava memo.
 */
async function seedArchive(): Promise<void> {
  await sql(`UPDATE sources SET enabled=true WHERE adapter_type='mtproto_monitor'`);
  await ingest(WAR, 'Шахед курсом на Полтавщину.', nightInstant(1));
  await ingest(ERADAR, 'БпЛА на Полтавщині.', nightInstant(3));
  await ingest(AERIS, 'Шахед курсом на Полтавщину.', nightInstant(5));
  await ingest(WAR, 'БпЛА на Полтавщині.', nightInstant(9));
  await ingest(ERADAR, 'БпЛА на Полтавщині.', dayInstant(2));
  await ingest(WAR, 'Балістика на Харків.', nightInstant(2));
}

async function enableResearch(enabled: boolean): Promise<void> {
  const { saveCodexSettings } = await import('../../src/services/codex-settings.js');
  await saveCodexSettings({ features: { attack_research: enabled } });
}

describe.skipIf(!integrationDatabaseAvailable)('operator attack research', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    const { resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
    resetMonitorCoalescing();
  });

  // ----------------------------------------------------------------------------------------------
  describe('the evidence pack', () => {
    it('counts the night band from the archive and bands every class by what it found', async () => {
      await seedArchive();
      const { buildResearchPack } = await import('../../src/services/attack-research.js');
      const pack = await buildResearchPack(POLTAVA, 'night');

      expect(pack.oblast).toEqual({ id: POLTAVA, name: 'Полтавська область' });
      expect(pack.window.hours).toEqual([22, 23, 0, 1, 2, 3, 4, 5]);
      // Four of the five Poltava messages are in the night band; the fifth is at midday.
      expect(pack.history.windowMessages).toBe(4);
      expect(pack.history.baselineMessages).toBe(5);

      const uav = pack.history.perClass.find((entry) => entry.threatType === 'uav')!;
      expect(uav.windowMessages).toBe(4);
      expect(uav.baselineSupport).toBe(5);
      expect(uav.windowShare).toBe(1);
      expect(uav.band).toBe('типово для цього вікна');
      expect(uav.observedNow).toBe(false);
      // The newest night message was planted at 21:00 UTC yesterday, so «востаннє» is 0 or 1 whole
      // days ago depending on the hour the suite happens to run at. Both are the right answer; a
      // fixed number here would be a test that passes only in the evening.
      expect(uav.lastInWindowDaysAgo).toBeGreaterThanOrEqual(0);
      expect(uav.lastInWindowDaysAgo).toBeLessThanOrEqual(1);

      // The Kharkiv ballistic message is about another oblast and is not in this pack at all.
      expect(pack.history.perClass.map((entry) => entry.threatType)).toEqual(['uav']);
      // A thin sample with nothing live can never be `medium`.
      expect(pack.confidence).toBe('low');
    });

    it('reads the oblast through the hierarchy, so a message that named a city counts', async () => {
      await sql(`UPDATE sources SET enabled=true WHERE adapter_type='mtproto_monitor'`);
      await ingest(WAR, 'Шахед курсом на Полтаву.', nightInstant(1));
      const { buildResearchPack } = await import('../../src/services/attack-research.js');
      const pack = await buildResearchPack(POLTAVA, 'night');
      expect(pack.history.windowMessages).toBe(1);
      expect(pack.history.perClass[0]!.threatType).toBe('uav');
    });

    it('separates the day band from the night one over the very same archive', async () => {
      await seedArchive();
      const { buildResearchPack } = await import('../../src/services/attack-research.js');
      const day = await buildResearchPack(POLTAVA, 'day');
      expect(day.window.hours).toContain(12);
      expect(day.window.hours).not.toContain(23);
      expect(day.history.windowMessages).toBe(1);
      // The class exists in the oblast either way — what changes is how much of the band it fills.
      expect(day.history.perClass[0]!.baselineSupport).toBe(5);
    });

    it('answers for an oblast the archive says nothing about, rather than failing', async () => {
      await seedArchive();
      const { buildResearchPack } = await import('../../src/services/attack-research.js');
      const pack = await buildResearchPack('ua-46', 'night');
      expect(pack.history.windowMessages).toBe(0);
      expect(pack.history.perClass).toEqual([]);
      expect(pack.caveats.join(' ')).toContain('архів порожній');
    });

    it('carries the public chain and never an operator extrapolation', async () => {
      await sql(`UPDATE sources SET enabled=true WHERE adapter_type='mtproto_monitor'`);
      // A live chain: two messages minutes apart leading one target towards Poltava.
      await ingest(AERIS, 'Балістика повз Суми на Полтаву.', new Date(Date.now() - 6 * 60_000));
      await ingest(WAR, 'Балістична загроза для Полтави.', new Date(Date.now() - 60_000));
      const { buildResearchPack } = await import('../../src/services/attack-research.js');
      const pack = await buildResearchPack(POLTAVA, 'next12h');

      expect(pack.now.liveThreats.length).toBeGreaterThan(0);
      // Something airborne puts its class on the top rung, whatever the archive says.
      expect(pack.history.perClass.some((entry) => entry.band === 'спостерігається')).toBe(true);
      const serialised = JSON.stringify(pack);
      for (const token of ['bearingDegrees', 'groundSpeedKmh', 'cone', 'centerline', 'candidates']) {
        expect(serialised, `the pack carried «${token}»`).not.toContain(token);
      }
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('governance', () => {
    it('refuses on the switch, records the refusal, and spends no model call', async () => {
      await seedArchive();
      await enableResearch(false);
      const { runAttackResearch } = await import('../../src/services/attack-research.js');
      const result = await runAttackResearch({ oblastId: POLTAVA, window: 'night' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe('refused_disabled');
      expect(await count('ops_attack_research_requests', `status='refused_disabled'`)).toBe(1);
      expect(await count('ops_attack_research_memos')).toBe(0);
      // The whole point of refusing before the pack is built: nothing was asked of any model.
      expect(await count('ai_runs')).toBe(0);
    });

    it('writes a memo when the switch is on, deterministic and with the model pre-flight recorded', async () => {
      await seedArchive();
      await enableResearch(true);
      const { runAttackResearch } = await import('../../src/services/attack-research.js');
      const result = await runAttackResearch({ oblastId: POLTAVA, window: 'night' });

      expect(result.ok, result.ok ? '' : `refused: ${result.detail}`).toBe(true);
      if (!result.ok) return;
      expect(result.memo.memoOrigin).toBe('deterministic');
      // No session in the test environment, so the verifier never ran on a model reply.
      expect(result.memo.verification).toBe('skipped');
      expect(result.memo.dataNature).toBe('calculated');
      expect(result.memo.framing).toContain('не прогноз');
      expect(result.memo.memo.summary.startsWith(result.memo.framing)).toBe(true);
      expect(result.memo.bands.map((band) => band.threatType)).toEqual(['uav']);

      expect(await count('ops_attack_research_requests', `status='completed'`)).toBe(1);
      expect(await count('ops_attack_research_classes')).toBe(1);
      // The pre-flight refusal IS the audit trail an operator goes looking for when the memo came
      // out deterministic and they expected prose.
      const runs = await sql<{ surface: string; status: string; fallback_reason: string }>(
        `SELECT surface,status,fallback_reason FROM ai_runs`
      );
      expect(runs.rowCount).toBe(1);
      expect(runs.rows[0]!.surface).toBe('attack_research');
      expect(runs.rows[0]!.status).toBe('failed');
      expect(result.memo.aiRunId).not.toBeNull();
    });

    it('holds the same oblast and window behind the cooldown, and says how long', async () => {
      await seedArchive();
      await enableResearch(true);
      const { runAttackResearch } = await import('../../src/services/attack-research.js');
      expect((await runAttackResearch({ oblastId: POLTAVA, window: 'night' })).ok).toBe(true);

      const second = await runAttackResearch({ oblastId: POLTAVA, window: 'night' });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.status).toBe('refused_cooldown');
      expect(second.retryAfterSeconds).toBeGreaterThan(0);

      // A different window of the same oblast is a different question and is not held.
      expect((await runAttackResearch({ oblastId: POLTAVA, window: 'day' })).ok).toBe(true);
      expect(await count('ops_attack_research_requests')).toBe(3);
      expect(await count('ops_attack_research_memos')).toBe(2);
    });

    it('refuses on the daily cap without offering a countdown nobody can wait out', async () => {
      await seedArchive();
      await enableResearch(true);
      const { config } = await import('../../src/config.js');
      const original = config.ATTACK_RESEARCH_MAX_PER_DAY;
      try {
        config.ATTACK_RESEARCH_MAX_PER_DAY = 0;
        const { runAttackResearch } = await import('../../src/services/attack-research.js');
        const result = await runAttackResearch({ oblastId: POLTAVA, window: 'night' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.status).toBe('refused_daily_cap');
        expect(result.retryAfterSeconds).toBeNull();
        expect(await count('ops_attack_research_requests', `status='refused_daily_cap'`)).toBe(1);
        expect(await count('ops_attack_research_memos')).toBe(0);
      } finally {
        config.ATTACK_RESEARCH_MAX_PER_DAY = original;
      }
    });

    /**
     * The two bounds count different things, and this is the difference.
     *
     * A refusal costs a press and nothing else — the pack was never built — so it spends the day's
     * allowance and starts no cooldown. Counting refusals in both would mean an operator who pressed
     * the button while the switch was off had to wait out a computation that never ran.
     */
    it('does not start the cooldown from a request that was refused', async () => {
      await seedArchive();
      await enableResearch(false);
      const { runAttackResearch } = await import('../../src/services/attack-research.js');
      expect((await runAttackResearch({ oblastId: POLTAVA, window: 'night' })).ok).toBe(false);

      await enableResearch(true);
      const allowed = await runAttackResearch({ oblastId: POLTAVA, window: 'night' });
      expect(allowed.ok, allowed.ok ? '' : `held by ${allowed.status}`).toBe(true);
      // …and the memo it did produce starts one.
      const held = await runAttackResearch({ oblastId: POLTAVA, window: 'night' });
      expect(held.ok).toBe(false);
      if (!held.ok) expect(held.status).toBe('refused_cooldown');
    });

    it('counts a refused request against the day, because pressing the button is what costs', async () => {
      await seedArchive();
      await enableResearch(false);
      const { runAttackResearch, researchCaps } = await import('../../src/services/attack-research.js');
      await runAttackResearch({ oblastId: POLTAVA, window: 'night' });
      await runAttackResearch({ oblastId: KHARKIV, window: 'day' });
      expect((await researchCaps()).usedToday).toBe(2);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('storage', () => {
    it('marks every stored row as a calculation by constraint, not by caption', async () => {
      await seedArchive();
      await enableResearch(true);
      const { runAttackResearch } = await import('../../src/services/attack-research.js');
      expect((await runAttackResearch({ oblastId: POLTAVA, window: 'night' })).ok).toBe(true);

      const stored = await sql<{ data_nature: string; confidence: string; verification: string }>(
        `SELECT data_nature,confidence,verification FROM ops_attack_research_memos`
      );
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0]!.data_nature).toBe('calculated');
      expect(['low', 'medium']).toContain(stored.rows[0]!.confidence);

      await expect(sql(`UPDATE ops_attack_research_memos SET data_nature='derived'`)).rejects.toThrow();
      await expect(sql(`UPDATE ops_attack_research_memos SET confidence='high'`)).rejects.toThrow();
      await expect(sql(`UPDATE ops_attack_research_classes SET data_nature='observed'`)).rejects.toThrow();
      // The band is a closed enum in the schema, so a fifth phrase cannot be filed even by hand.
      await expect(
        sql(`UPDATE ops_attack_research_classes SET band='ймовірно вночі'`)
      ).rejects.toThrow();
    });

    it('never writes to the public event, its geometry or the system event log', async () => {
      await seedArchive();
      await enableResearch(true);
      const before = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM system_event_log`
      );
      const events = await sql<{ id: string; updated_at: string }>(
        `SELECT id,updated_at::text FROM threat_events ORDER BY id`
      );

      const { runAttackResearch } = await import('../../src/services/attack-research.js');
      await runAttackResearch({ oblastId: POLTAVA, window: 'night' });

      const after = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM system_event_log`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      const eventsAfter = await sql<{ id: string; updated_at: string }>(
        `SELECT id,updated_at::text FROM threat_events ORDER BY id`
      );
      expect(eventsAfter.rows).toEqual(events.rows);
      // And no alert was created, ended or touched.
      expect(await count('alert_periods')).toBe(0);
    });

    it('takes the memos with the request row they hang off when the retention sweep runs', async () => {
      await seedArchive();
      await enableResearch(true);
      const { runAttackResearch, pruneAttackResearch } = await import('../../src/services/attack-research.js');
      await runAttackResearch({ oblastId: POLTAVA, window: 'night' });
      await sql(`UPDATE ops_attack_research_requests SET requested_at = now() - interval '200 days'`);
      expect(await pruneAttackResearch(90)).toBe(1);
      expect(await count('ops_attack_research_memos')).toBe(0);
      expect(await count('ops_attack_research_classes')).toBe(0);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the routes and the surfaces around them', () => {
    let app: FastifyInstance;
    let baseUrl = '';

    beforeAll(async () => {
      const { buildServer } = await import('../../src/api/server.js');
      app = await buildServer();
      baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    });

    afterAll(async () => { await app?.close(); });

    /** Reads whatever the stream emits, including the replay backfill, then hangs up. */
    async function readStream(millis: number): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), millis);
      try {
        const response = await fetch(`${baseUrl}/api/v1/stream`, {
          headers: { 'Last-Event-ID': '1' }, signal: controller.signal
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch { /* the abort above is the exit condition */ }
        return text;
      } catch {
        return '';
      } finally {
        clearTimeout(timer);
      }
    }

    it('refuses every research route without operator credentials', async () => {
      for (const url of ['/ops/attack-research', '/ops/attack-research/00000000-0000-4000-8000-000000000000']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
      expect((await app.inject({
        method: 'POST', url: '/ops/attack-research',
        payload: { oblastId: POLTAVA, window: 'night' }
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: 'GET', url: '/ops/attack-research',
        headers: { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` }
      })).statusCode).toBe(401);
    });

    it('offers the framing sentence before anything has been researched', async () => {
      const response = await app.inject({
        method: 'GET', url: '/ops/attack-research', headers: { authorization: OPS_AUTH }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.framing).toContain('не прогноз');
      expect(body.dataNature).toBe('calculated');
      expect(body.bands).toHaveLength(4);
      expect(body.oblasts.some((oblast: { id: string }) => oblast.id === POLTAVA)).toBe(true);
      expect(body.windows.map((window: { id: string }) => window.id)).toEqual(['night', 'day', 'next12h']);
      expect(body.caps.perDay).toBeGreaterThan(0);
      expect(body.recent).toEqual([]);
    });

    it('rejects a malformed request without writing it down as a refusal', async () => {
      for (const payload of [{ oblastId: POLTAVA, window: 'вночі' }, { oblastId: 'ua-city-poltava', window: 'night' }, {}]) {
        const response = await app.inject({
          method: 'POST', url: '/ops/attack-research', headers: { authorization: OPS_AUTH }, payload
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      // A malformed request is not a refused one: it never reached the governance, so it is not in
      // the history and it did not spend the day's allowance.
      expect(await count('ops_attack_research_requests')).toBe(0);
    });

    it('answers 409 for the switch and 429 for the cooldown, which are different sentences', async () => {
      await seedArchive();
      await enableResearch(false);
      const disabled = await app.inject({
        method: 'POST', url: '/ops/attack-research', headers: { authorization: OPS_AUTH },
        payload: { oblastId: POLTAVA, window: 'night' }
      });
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json().error).toBe('refused_disabled');
      expect(disabled.json().retryAfterSeconds).toBeUndefined();

      await enableResearch(true);
      expect((await app.inject({
        method: 'POST', url: '/ops/attack-research', headers: { authorization: OPS_AUTH },
        payload: { oblastId: POLTAVA, window: 'night' }
      })).statusCode).toBe(200);

      const held = await app.inject({
        method: 'POST', url: '/ops/attack-research', headers: { authorization: OPS_AUTH },
        payload: { oblastId: POLTAVA, window: 'night' }
      });
      expect(held.statusCode).toBe(429);
      expect(held.json().retryAfterSeconds).toBeGreaterThan(0);
      expect(held.headers['retry-after']).toBeDefined();

      // Both attempts are in the history, refusals included, which is what it is for.
      const list = await app.inject({
        method: 'GET', url: '/ops/attack-research', headers: { authorization: OPS_AUTH }
      });
      expect(list.json().recent.map((entry: { status: string }) => entry.status))
        .toEqual(['refused_cooldown', 'completed', 'refused_disabled']);
      expect(list.json().caps.usedToday).toBe(3);
    });

    it('serves one memo with the whole pack it was written from', async () => {
      await seedArchive();
      await enableResearch(true);
      const created = await app.inject({
        method: 'POST', url: '/ops/attack-research', headers: { authorization: OPS_AUTH },
        payload: { oblastId: POLTAVA, window: 'night' }
      });
      expect(created.statusCode).toBe(200);
      const memoId = created.json().id;

      const stored = await app.inject({
        method: 'GET', url: `/ops/attack-research/${memoId}`, headers: { authorization: OPS_AUTH }
      });
      expect(stored.statusCode).toBe(200);
      expect(stored.json().evidence.history.windowMessages).toBe(4);
      expect(stored.json().framing).toContain('не прогноз');
      expect(stored.json().bands[0].band).toBe('типово для цього вікна');

      expect((await app.inject({
        method: 'GET', url: '/ops/attack-research/00000000-0000-4000-8000-000000000000',
        headers: { authorization: OPS_AUTH }
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: 'GET', url: '/ops/attack-research/not-a-uuid', headers: { authorization: OPS_AUTH }
      })).statusCode).toBe(400);
    });

    it('never repeats the memo on any public surface, SSE replay included', async () => {
      await seedArchive();
      await enableResearch(true);
      const created = await app.inject({
        method: 'POST', url: '/ops/attack-research', headers: { authorization: OPS_AUTH },
        payload: { oblastId: POLTAVA, window: 'night' }
      });
      expect(created.statusCode).toBe(200);
      const memoId = created.json().id;
      // A marker inside the stored row: any payload that reproduces the memo in any shape reproduces
      // this string with it.
      await sql(`UPDATE ops_attack_research_memos SET framing = framing || $1`, [` ${MARKER}`]);

      const eventId = (await sql<{ id: string }>(`SELECT id FROM threat_events LIMIT 1`)).rows[0]?.id;
      const publicPaths = [
        '/api/v1/snapshot',
        '/api/v1/threats',
        '/api/v1/vectors',
        '/api/v1/history?limit=100',
        `/api/v1/locations/${POLTAVA}/timeline`,
        '/api/v1/alerts',
        '/api/v1/assessments',
        '/api/v1/config',
        '/api/v1/methodology',
        '/api/v1/analytics/attacks?period=month',
        ...(eventId ? [`/api/v1/threats/${eventId}`, `/api/v1/threats/${eventId}/vector`] : [])
      ];
      const bodies: Array<[string, string]> = [];
      for (const path of publicPaths) {
        const response = await app.inject({ method: 'GET', url: path });
        expect(response.statusCode, `${path} answered ${response.statusCode}`).toBe(200);
        bodies.push([path, response.body]);
      }
      bodies.push(['sse', await readStream(1200)]);

      for (const [label, body] of bodies) {
        expect(body, `${label} leaked the marker`).not.toContain(MARKER);
        expect(body, `${label} leaked the memo id`).not.toContain(memoId);
        // Vocabulary only the research memo uses. `calculated` is the load-bearing one: it is the
        // word that says a row is about a window nobody reported on.
        // Vocabulary the research memo does not share with any public payload. `methodologyVersion`
        // is deliberately NOT in this list: `/api/v1/config` has carried that field name since long
        // before this surface existed, and a token that is already public proves nothing here.
        for (const token of [
          'calculated', 'спостерігається', 'типово для цього вікна', 'нетипово, але траплялося',
          'у цьому вікні не фіксували', 'watchIndicators', 'research-v1', 'memoOrigin', 'lastInWindowDaysAgo'
        ]) {
          expect(body, `${label} leaked «${token}»`).not.toContain(token);
        }
      }
    });
  });
});
