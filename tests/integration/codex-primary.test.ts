import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OBLAST, ensureMigrated, integrationDatabaseAvailable, outboxRows,
  resetDatabase, seedSubscription, seedUser, sql
} from '../helpers/db.js';
import type { CodexChatRequest, CodexChatResult } from '../../src/services/codex-client.js';

/**
 * Codex як основний класифікатор (міграція 049) проти справжнього Postgres: режим, подія з
 * актуальністю й ймовірністю, запасний шлях правил, придушення, звірка, контексти по локаціях і їх
 * стискання, очікувана загроза на карті та в боті.
 *
 * Модель — заглушка через `setCodexClassifierDefaults` і `setModelContextDefaults`: те, що пінять, —
 * не відповідь моделі, а що з нею робить конвеєр.
 */

const ERADAR = 'osint-eradar';
const POLTAVA = 'ua-53';
let sequence = 0;

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    threatType: 'ballistic_missile', significant: true, confidence: 0.9, locations: ['Полтавщина'], nationalScope: false,
    originLocations: [], destinationLocations: [], directionText: null, threatState: 'asserted',
    timing: 'now', probability: 0.75, expectedFrom: null, expectedUntil: null, note: 'Джерело пише прямо.',
    ...overrides
  };
}

const chatReturning = (value: unknown) => async (_request: CodexChatRequest): Promise<CodexChatResult> =>
  ({ ok: true, content: JSON.stringify(value), model: 'gpt-5.2', durationMs: 4 });
const chatFailing = async (): Promise<CodexChatResult> =>
  ({ ok: false, reason: 'transport_error', detail: 'ECONNRESET', model: null, durationMs: 1 });

async function ingest(text: string, publishedAt = new Date(), sourceId = ERADAR) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId, externalId: `codex-primary-${sequence}`, publishedAt, text, rawPayload: { test: true }
  }, { monitor: true });
}

async function codexMode(on: boolean): Promise<void> {
  await sql(`UPDATE codex_settings SET classifier_mode=$1 WHERE singleton`, [on ? 'codex' : 'rules']);
}

describe.skipIf(!integrationDatabaseAvailable)('codex as the primary classifier', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    const { resetMonitorCoalescing, resetSourceDescriptors } = await import('../../src/services/ingestion.js');
    resetMonitorCoalescing();
    resetSourceDescriptors();
    const { resetCodexClassifier, setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
    resetCodexClassifier();
    setCodexClassifierDefaults({ chat: chatReturning(verdict()), loadPrevious: async () => [] });
    const { resetModelContextWorker } = await import('../../src/services/model-context.js');
    resetModelContextWorker();
  });

  // ----------------------------------------------------------------------------------------------
  describe('the mode', () => {
    it('ships as rules: the model is not asked, the event is a rules event as before', async () => {
      let asked = 0;
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: async (request) => { asked += 1; return chatReturning(verdict())(request); } });
      const result = await ingest('Шахеди на Полтавщині.') as { id: string };
      expect(asked).toBe(0);
      const row = await sql<{ classified_by: string; timing: string; probability: string | null }>(
        `SELECT classified_by, timing, probability FROM threat_events WHERE id=$1`, [result.id]
      );
      expect(row.rows[0]).toEqual({ classified_by: 'rules', timing: 'now', probability: null });
      const archive = await sql<{ classifier_version: string; model: string | null }>(
        `SELECT classifier_version, model FROM message_classifications`
      );
      expect(archive.rows[0]!.model).toBeNull();
    });

    it('in codex mode writes the event from the model verdict, with the source’s evidence and classified_by=codex', async () => {
      await codexMode(true);
      const result = await ingest('Повідомляють про пуски на Полтавщину.') as { id: string; created: boolean };
      expect(result.created).toBe(true);
      const row = await sql<{ threat_type: string; classified_by: string; timing: string; probability: string; evidence_level: string; origin: string; assessment_note: string }>(
        `SELECT threat_type, classified_by, timing, probability, evidence_level, origin, assessment_note FROM threat_events WHERE id=$1`, [result.id]
      );
      expect(row.rows[0]).toMatchObject({
        threat_type: 'ballistic_missile', classified_by: 'codex', timing: 'now', probability: '0.750',
        // Доказовість — джерела (eRadar — моніторинговий канал), а не «unverified» промоції; origin — не model.
        evidence_level: 'monitoring', origin: 'deterministic', assessment_note: 'Джерело пише прямо.'
      });
      const locations = await sql<{ location_id: string }>(`SELECT location_id FROM threat_event_locations WHERE event_id=$1`, [result.id]);
      expect(locations.rows.map((location) => location.location_id)).toEqual([POLTAVA]);
      // Архів: версія класифікатора моделі, модель і впевненість; рядок звірки «правила проти моделі».
      const archive = await sql<{ classifier_version: string; model: string; model_confidence: string; timing: string; decision: string }>(
        `SELECT classifier_version, model, model_confidence, timing, decision FROM message_classifications`
      );
      expect(archive.rows[0]).toMatchObject({ classifier_version: 'codex-primary-v1', model: 'gpt-5.2', model_confidence: '0.900', timing: 'now', decision: 'event_created' });
      const comparison = await sql<{ model_threat_type: string; deterministic_threat_type: string; agrees: boolean }>(
        `SELECT model_threat_type, deterministic_threat_type, agrees FROM shadow_classifications`
      );
      expect(comparison.rows[0]).toMatchObject({ model_threat_type: 'ballistic_missile', deterministic_threat_type: 'unknown', agrees: false });
    });

    it('hands the message to the rules when the model fails, and records that nothing was suppressed', async () => {
      await codexMode(true);
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: chatFailing, loadPrevious: async () => [] });
      const result = await ingest('Шахеди на Полтавщині.') as { id: string };
      const row = await sql<{ classified_by: string; threat_type: string }>(`SELECT classified_by, threat_type FROM threat_events WHERE id=$1`, [result.id]);
      expect(row.rows[0]).toEqual({ classified_by: 'rules', threat_type: 'uav' });
      const archive = await sql<{ classifier_version: string }>(`SELECT classifier_version FROM message_classifications`);
      expect(archive.rows[0]!.classifier_version).not.toBe('codex-primary-v1');
    });

    it('lets a confident model suppress a message the rules would have published, and says so in the archive', async () => {
      await codexMode(true);
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: chatReturning(verdict({ significant: false, confidence: 0.95, probability: null })), loadPrevious: async () => [] });
      const result = await ingest('Шахеди на Полтавщині — переказ вчорашньої ночі.') as { ignored?: boolean };
      expect(result.ignored).toBe(true);
      expect((await sql(`SELECT 1 FROM threat_events`)).rowCount).toBe(0);
      const archive = await sql<{ decision: string; ignored_reason: string; classifier_version: string }>(
        `SELECT decision, ignored_reason, classifier_version FROM message_classifications`
      );
      expect(archive.rows[0]).toMatchObject({ decision: 'unrecognized', ignored_reason: 'model_not_significant', classifier_version: 'codex-primary-v1' });
    });

    it('never lets the model withdraw: a source all-clear is handled by the rules before the model is asked', async () => {
      await codexMode(true);
      let asked = 0;
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: async (request) => { asked += 1; return chatReturning(verdict())(request); }, loadPrevious: async () => [] });
      await ingest('Шахеди на Полтавщині.');
      const before = asked;
      const result = await ingest('Відбій, Полтавщина: ціль знищена, загрози більше немає.') as { deEscalation?: boolean };
      expect(result.deEscalation).toBe(true);
      expect(asked).toBe(before);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('expected threats', () => {
    it('lives until the end of its Kyiv evening, not thirty minutes', async () => {
      await codexMode(true);
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: chatReturning(verdict({ timing: 'evening', probability: 0.6 })), loadPrevious: async () => [] });
      const at = new Date('2026-08-18T12:00:00Z'); // 15:00 за Києвом
      const result = await ingest('Увечері очікується масований удар балістикою по Полтавщині.', at) as { id: string };
      const row = await sql<{ timing: string; valid_until: Date; expected_from: Date; expected_until: Date }>(
        `SELECT timing, valid_until, expected_from, expected_until FROM threat_events WHERE id=$1`, [result.id]
      );
      expect(row.rows[0]!.timing).toBe('evening');
      expect(row.rows[0]!.expected_from.toISOString()).toBe('2026-08-18T15:00:00.000Z');
      expect(row.rows[0]!.expected_until.toISOString()).toBe('2026-08-18T20:59:00.000Z');
      expect(row.rows[0]!.valid_until.toISOString()).toBe('2026-08-18T20:59:00.000Z');
    });

    it('is live for its whole window and stays out of the territory fill, listed as expected instead', async () => {
      await codexMode(true);
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: chatReturning(verdict({ timing: 'within_day', probability: 0.6 })), loadPrevious: async () => [] });
      const result = await ingest('Протягом доби очікується удар балістикою по Полтавщині.', new Date()) as { id: string };
      const { liveThreats } = await import('../../src/repositories/events.js');
      const live = await liveThreats(new Date());
      const event = live.find((item) => item.id === result.id)!;
      expect(event).toMatchObject({ timing: 'within_day', probability: 0.6, classifiedBy: 'codex' });

      const { composeTerritoryStates } = await import('../../src/domain/territory-state.js');
      const nodes = await sql<{ id: string; parent_id: string | null; type: string; name_uk: string }>(
        `SELECT id,parent_id,type,name_uk FROM locations WHERE type IN ('country','oblast','special_city','raion')`
      );
      const states = composeTerritoryStates({
        nodes: nodes.rows.map((node) => ({ id: node.id, parentId: node.parent_id, type: node.type, nameUk: node.name_uk })) as never,
        alerts: [], threats: live, assessments: [], now: new Date(), publishedAt: new Date().toISOString()
      } as never);
      const poltava = states.find((state) => state.locationId === POLTAVA)!;
      expect(poltava.threatActive).toBe(false);
      expect(poltava.threats).toEqual([]);
      expect(poltava.expected.map((item) => [item.eventId, item.timing, item.probability])).toEqual([[result.id, 'within_day', 0.6]]);
    });

    it('merges a later «now» message into the expected event and makes it current', async () => {
      await codexMode(true);
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: chatReturning(verdict({ timing: 'evening', probability: 0.6 })), loadPrevious: async () => [] });
      const first = await ingest('Увечері очікується удар балістикою по Полтавщині.', new Date(Date.now() - 60 * 60_000)) as { id: string };
      setCodexClassifierDefaults({ chat: chatReturning(verdict({ timing: 'now', probability: 0.9 })), loadPrevious: async () => [] });
      // Інше джерело: те саме джерело в тому ж вікні злилося б як повтор (coalesce), а не як злиття.
      const second = await ingest('Пуски балістики на Полтавщину!', new Date(), 'osint-war-monitor') as { id: string; created: boolean };
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
      const row = await sql<{ timing: string; probability: string }>(`SELECT timing, probability FROM threat_events WHERE id=$1`, [first.id]);
      expect(row.rows[0]).toEqual({ timing: 'now', probability: '0.900' });
    });

    it('reaches subscribers as a soft, quiet «очікується» message rather than a warning', async () => {
      await codexMode(true);
      await seedUser(5); await seedSubscription({ chatId: 5, locationId: POLTAVA, minimumEvidenceLevel: 'monitoring' });
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({ chat: chatReturning(verdict({ timing: 'within_hour', probability: 0.55 })), loadPrevious: async () => [] });
      await ingest('МіГ-31К у повітрі, загроза балістики для Полтавщини протягом години.');
      const { runFanout } = await import('../helpers/db.js');
      await runFanout();
      const rows = await outboxRows();
      const threat = rows.find((row) => row.notification_type === 'threat_update') as { payload: any; priority: number } | undefined;
      expect(threat).toBeDefined();
      expect(threat!.payload.timing).toBe('within_hour');
      expect(threat!.payload.probability).toBe(0.55);
      expect(threat!.priority).toBe(4);
      const { deliveryClass } = await import('../../src/bot/delivery-governor.js');
      expect(deliveryClass(threat)).toBe('soft');
      const { formatMessage } = await import('../../src/bot/outbox.js');
      const text = formatMessage(threat, new Date());
      expect(text).toContain('🕒');
      expect(text).toContain('очікується протягом години');
      expect(text).toContain('Оцінка ймовірності моделлю: ≈55 %');
      expect(text).not.toContain('перейдіть до укриття');
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('location contexts', () => {
    it('are written for the named location, its oblast and never the country, in every mode', async () => {
      await ingest('Шахеди на Полтавщині.');
      const rows = await sql<{ location_id: string; entries: number; content: string }>(
        `SELECT location_id, entries, content FROM model_location_contexts ORDER BY location_id`
      );
      expect(rows.rows.map((row) => row.location_id)).toEqual([POLTAVA]);
      expect(rows.rows[0]!.entries).toBe(1);
      expect(rows.rows[0]!.content).toContain('«Шахеди на Полтавщині.» → event_created');
      expect(rows.rows[0]!.content).toContain('правила: threat/uav');
      // Друге повідомлення дописується в кінець; країна без місця — у «ua».
      await ingest('Злетіли носії Кинджалів.');
      const after = await sql<{ location_id: string; entries: number }>(`SELECT location_id, entries FROM model_location_contexts ORDER BY location_id`);
      expect(after.rows.map((row) => [row.location_id, row.entries])).toEqual([['ua', 1], [POLTAVA, 1]]);
    });

    it('are handed to the model in codex mode and grow with its verdicts', async () => {
      await codexMode(true);
      let seen = '';
      const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
      setCodexClassifierDefaults({
        chat: async (request) => { seen = request.user; return chatReturning(verdict())(request); }, loadPrevious: async () => []
      });
      await ingest('Балістика на Полтавщину.');
      await ingest('Знову балістика на Полтавщину.');
      expect(seen).toContain('### Контекст: Полтавська область');
      expect(seen).toContain('«Балістика на Полтавщину.» → event_created');
      expect(seen).toContain('модель: ballistic_missile/asserted, now, p=0.75');
    });

    it('are compacted by the model once over the ceiling, keeping what was appended meanwhile, and trimmed when it will not answer', async () => {
      const { config } = await import('../../src/config.js');
      const { appendLocationContext, compactLocationContext, setModelContextDefaults, loadLocationContexts } = await import('../../src/services/model-context.js');
      const maxTokens = config.MODEL_CONTEXT_MAX_TOKENS;
      const compactTo = config.MODEL_CONTEXT_COMPACT_TO_TOKENS;
      try {
        config.MODEL_CONTEXT_MAX_TOKENS = 200;
        config.MODEL_CONTEXT_COMPACT_TO_TOKENS = 60;
        // Стискання, яке будить append, іде в заглушку-мовчанку: ми викликаємо його самі нижче.
        setModelContextDefaults({ chat: async () => new Promise(() => undefined) });
        for (let index = 0; index < 12; index += 1) {
          await appendLocationContext([POLTAVA], `[2026-08-18 0${index % 10}:00] eRadar: «шахеди на Полтавщину, запис ${index}» → event_created; правила: threat/uav`);
        }
        const before = await sql<{ estimated_tokens: number; compacting_since: Date | null }>(`SELECT estimated_tokens, compacting_since FROM model_location_contexts WHERE location_id=$1`, [POLTAVA]);
        expect(before.rows[0]!.estimated_tokens).toBeGreaterThan(200);
        // Знімаємо заявку мовчазної заглушки й стискаємо з моделлю, яка відповідає — і дописуємо під час стискання.
        await sql(`UPDATE model_location_contexts SET compacting_since=NULL WHERE location_id=$1`, [POLTAVA]);
        const outcome = await compactLocationContext(POLTAVA, {
          chat: async () => {
            await appendLocationContext([POLTAVA], '[2026-08-18 11:00] eRadar: «дописано під час стискання» → event_created');
            return { ok: true, content: '[зведення] за добу 12 записів про шахеди на Полтавщину', model: 'gpt-5.2', durationMs: 1 };
          }
        });
        expect(outcome).toBe('compacted');
        const after = await sql<{ content: string; compactions: number; estimated_tokens: number }>(`SELECT content, compactions, estimated_tokens FROM model_location_contexts WHERE location_id=$1`, [POLTAVA]);
        expect(after.rows[0]!.content.startsWith('[зведення] за добу 12 записів')).toBe(true);
        expect(after.rows[0]!.content).toContain('дописано під час стискання');
        expect(after.rows[0]!.content).not.toContain('запис 3');
        expect(after.rows[0]!.compactions).toBe(1);
        expect(after.rows[0]!.estimated_tokens).toBeLessThan(200);
        // Модель мовчить — ріжемо детерміновано до стелі.
        for (let index = 0; index < 12; index += 1) {
          await appendLocationContext([POLTAVA], `[2026-08-18 1${index % 10}:00] eRadar: «ще запис ${index} про шахеди на Полтавщину» → event_created; правила: threat/uav`);
        }
        await sql(`UPDATE model_location_contexts SET compacting_since=NULL WHERE location_id=$1`, [POLTAVA]);
        const trimmed = await compactLocationContext(POLTAVA, { chat: chatFailing });
        expect(trimmed).toBe('trimmed');
        const final = await sql<{ estimated_tokens: number; content: string }>(`SELECT estimated_tokens, content FROM model_location_contexts WHERE location_id=$1`, [POLTAVA]);
        expect(final.rows[0]!.estimated_tokens).toBeLessThanOrEqual(200);
        expect(final.rows[0]!.content.endsWith('правила: threat/uav')).toBe(true);
        // Читання в запит поважає бюджет і віддає хвіст.
        const loaded = await loadLocationContexts([POLTAVA], 30);
        expect(loaded[0]!.truncated).toBe(true);
        expect(loaded[0]!.tokens).toBeLessThanOrEqual(30);
      } finally {
        config.MODEL_CONTEXT_MAX_TOKENS = maxTokens;
        config.MODEL_CONTEXT_COMPACT_TO_TOKENS = compactTo;
      }
    });

    it('note official alert starts and ends from the internal event feed', async () => {
      const { startModelContextScheduler } = await import('../../src/services/model-context.js');
      const { eventHub } = await import('../../src/services/sse.js');
      const stop = startModelContextScheduler({ info() {}, error() {} });
      try {
        eventHub.emit('internal-event', { version: 1, eventType: 'alert.started', payload: { locationId: OBLAST }, createdAt: new Date().toISOString() });
        eventHub.emit('internal-event', { version: 2, eventType: 'alert.ended', payload: { locationId: OBLAST }, createdAt: new Date().toISOString() });
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const rows = await sql<{ entries: number }>(`SELECT entries FROM model_location_contexts WHERE location_id=$1`, [OBLAST]);
          if ((rows.rows[0]?.entries ?? 0) >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const row = await sql<{ content: string }>(`SELECT content FROM model_location_contexts WHERE location_id=$1`, [OBLAST]);
        expect(row.rows[0]!.content).toContain('ОФІЦІЙНА ТРИВОГА: початок — Київська область');
        expect(row.rows[0]!.content).toContain('ОФІЦІЙНА ТРИВОГА: відбій — Київська область');
      } finally {
        stop();
      }
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the console', () => {
    it('lets the operator switch the mode and the risk switch, and reads the context overview', async () => {
      const { buildServer } = await import('../../src/api/server.js');
      const app = await buildServer();
      try {
        const auth = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
        const put = await app.inject({
          method: 'PUT', url: '/ops/codex/settings', headers: { authorization: auth },
          payload: { classifierMode: 'codex', features: { risk: true } }
        });
        expect(put.statusCode).toBe(200);
        expect(put.json().settings.classifierMode).toBe('codex');
        expect(put.json().settings.features.risk).toBe(true);
        const bad = await app.inject({ method: 'PUT', url: '/ops/codex/settings', headers: { authorization: auth }, payload: { classifierMode: 'magic' } });
        expect(bad.statusCode).toBe(400);
        await ingest('Шахеди на Полтавщині.');
        const contexts = await app.inject({ method: 'GET', url: '/ops/model-contexts', headers: { authorization: auth } });
        expect(contexts.statusCode).toBe(200);
        expect(contexts.json().rows).toBeGreaterThanOrEqual(1);
        expect(contexts.json().largest[0].locationId).toBe(POLTAVA);
        expect(contexts.json().settings.maxTokens).toBe(100_000);
        expect((await app.inject({ method: 'GET', url: '/ops/model-contexts' })).statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });
});
