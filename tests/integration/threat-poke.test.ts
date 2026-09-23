import { Registry } from 'prom-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OTHER_OBLAST, delay, ensureMigrated, fakeBot, integrationDatabaseAvailable, outboxRows,
  resetDatabase, seedSubscription, seedUser, sql
} from '../helpers/db.js';
import type { CodexChatRequest, CodexChatResult } from '../../src/services/codex-client.js';

/**
 * Миттєве поширення ЖИВОЇ загрози, проти справжньої бази.
 *
 * `tests/integration/alert-poke.test.ts` пінить те саме для `alert.started`. Цей файл — окремий,
 * бо ставить інше питання: попередження моніторингового каналу — те, що існує ДО того, як влада
 * заговорила, — платило три послідовні секундні тіки (хаб SSE, фан-аут, відправник), які офіційна
 * тривога собі викупила ще в попередній поставці.
 *
 * Чотири властивості, і жодну з них не можна вичитати з коду:
 *
 *  1. **Жива загроза доходить до черги, не чекаючи на тік.** `threat.created` з `timing='now'`
 *     потрапляє в `notification_outbox` за частку секунди, а не за рівномірні [0, 1 с].
 *  2. **І далі — до Telegram, теж без тіку.** Фан-аут будить відправника тому, що ПОСТАВИВ
 *     терміновий рядок, а не тому, що подія звалася `alert.started`.
 *  3. **Очікувана загроза не будить нікого.** «Увечері очікується» за `CONTEXT.md` не є живою
 *     загрозою: вона їде тихим пріоритетом і не має права купувати собі секунду. Поштовху немає, і
 *     подія при цьому створюється як завжди.
 *  4. **Те, що не опублікувалося, не поштовхує.** Повідомлення, старше за стелю віку, не пише рядка
 *     в `system_event_log` взагалі, тож будити двох опитувачів заради порожнього SELECT нема чого.
 */

const ERADAR = 'osint-eradar';
let sequence = 0;

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    threatType: 'ballistic_missile', significant: true, confidence: 0.9, locations: ['Полтавщина'],
    nationalScope: false, originLocations: [], destinationLocations: [], directionText: null,
    threatState: 'asserted', timing: 'now', probability: 0.75, expectedFrom: null, expectedUntil: null,
    note: 'Джерело пише прямо.', ...overrides
  };
}

const chatReturning = (value: unknown) => async (_request: CodexChatRequest): Promise<CodexChatResult> =>
  ({ ok: true, content: JSON.stringify(value), model: 'gpt-5.2', durationMs: 4 });

async function ingest(text: string, publishedAt = new Date()) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId: ERADAR, externalId: `threat-poke-${sequence}`, publishedAt, text, rawPayload: { test: true }
  }, { monitor: true });
}

async function codexMode(on: boolean): Promise<void> {
  await sql(`UPDATE codex_settings SET classifier_mode=$1 WHERE singleton`, [on ? 'codex' : 'rules']);
}

async function pokeCounts(): Promise<{ threatFired: number; threatCoalesced: number }> {
  const { alertPokeMetrics } = await import('../../src/services/alert-poke.js');
  const registry = new Registry();
  for (const [, metric] of alertPokeMetrics()) registry.registerMetric(metric);
  const text = await registry.metrics();
  const read = (outcome: string) => {
    const match = new RegExp(`^threatlens_alert_pokes_total\\{outcome="${outcome}"\\} (\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : 0;
  };
  return { threatFired: read('threat_fired'), threatCoalesced: read('threat_coalesced') };
}

/** Чекає на умову, опитуючи значно частіше за те, що перевіряється, і каже, скільки це забрало. */
async function elapsedUntil(predicate: () => boolean, label: string, budgetMs = 5000): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return Date.now() - started;
    if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

async function elapsedUntilAsync(
  predicate: () => Promise<boolean>, label: string, budgetMs = 5000
): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - started;
    if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

describe.skipIf(!integrationDatabaseAvailable)('instant propagation of a live threat', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    const { resetMonitorCoalescing, resetSourceDescriptors } = await import('../../src/services/ingestion.js');
    resetMonitorCoalescing();
    resetSourceDescriptors();
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    const { resetCodexClassifier, setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
    resetCodexClassifier();
    setCodexClassifierDefaults({ chat: chatReturning(verdict()), loadPrevious: async () => [] });
    const { resetModelContextWorker } = await import('../../src/services/model-context.js');
    resetModelContextWorker();
    await seedUser(7701);
    await seedSubscription({ chatId: 7701, locationId: OTHER_OBLAST, minimumEvidenceLevel: 'monitoring' });
  });

  afterEach(async () => {
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
  });

  it('queues a rules-mode threat.created without waiting for the fan-out tick', async () => {
    const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
    const stop = startNotificationWorkers(null, { warn: () => undefined, error: () => undefined });
    try {
      // Перший прохід фан-ауту відбувається на старті; чекаємо на нього, щоб виміряти саме поштовх,
      // а не збіг зі стартовим проходом.
      await delay(60);
      const before = await pokeCounts();
      await ingest('Балістика курсом на Полтавщину!');
      const ms = await elapsedUntilAsync(
        async () => (await outboxRows()).length > 0, 'the poked fan-out pass to queue a threat_update'
      );
      console.log(`[measured] threat.created(now) → notification_outbox row: ${ms} ms`);
      expect((await outboxRows())[0]).toMatchObject({ notification_type: 'threat_update' });
      // Без поштовху тут стояв тік фан-ауту — рівномірні [0, 1000 мс], у середньому ~500.
      expect(ms).toBeLessThan(500);
      expect((await pokeCounts()).threatFired - before.threatFired).toBe(1);
    } finally { stop(); }
  });

  it('reaches Telegram without waiting for the delivery tick either', async () => {
    // Два таймери по секунді стояли послідовно: фан-аут і відправник. Офіційна тривога викупила
    // обидва; попередження моніторингового каналу — жодного, бо умова пробудження питала про тип
    // події, а не про пріоритет рядка, який пішов у чергу.
    const telegram = fakeBot();
    const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
    const stop = startNotificationWorkers(
      telegram.bot as never, { warn: () => undefined, error: () => undefined }
    );
    try {
      await delay(60);
      const before = await pokeCounts();
      await ingest('Балістика курсом на Полтавщину!');
      const ms = await elapsedUntil(
        () => telegram.calls.length > 0, 'the poked delivery pass to reach Telegram'
      );
      console.log(`[measured] threat.created(now) → Telegram sendMessage: ${ms} ms`);
      // 200 мс, а не 700. Обидва таймери тут — по секунді, і очікування на них рівномірне на
      // [0, 1000]: межа в 700 мс пропустила б зламану реалізацію приблизно в семи випадках із
      // десяти, тобто перевіряла б удачу, а не поштовх. Виміряно на цьому шляху 10 мс; двісті —
      // це двадцятикратний запас від виміряного і водночас п'ята частина найкоротшого тіку, якого
      // шлях без поштовху не може не діждатися.
      expect(ms).toBeLessThan(200);
      // І сам поштовх, а не лише його наслідок: без цього рядка тест не відрізнив би «розбудили
      // відправника» від «пощастило з фазою таймера».
      expect((await pokeCounts()).threatFired - before.threatFired).toBe(1);
    } finally { stop(); }
  });

  it('does not poke for an EXPECTED threat, which still becomes an event', async () => {
    await codexMode(true);
    const { setCodexClassifierDefaults } = await import('../../src/services/codex-classifier.js');
    setCodexClassifierDefaults({
      chat: chatReturning(verdict({ timing: 'evening', probability: 0.6 })), loadPrevious: async () => []
    });
    const before = await pokeCounts();
    const result = await ingest('Увечері очікується масований удар балістикою по Полтавщині.') as { id: string };
    await delay(60);
    // Подія є, вона жива у своєму вікні, і в журналі стоїть рядок — усе, як і раніше.
    const row = await sql<{ timing: string }>(`SELECT timing FROM threat_events WHERE id=$1`, [result.id]);
    expect(row.rows[0]!.timing).toBe('evening');
    expect((await sql(`SELECT 1 FROM system_event_log WHERE event_type='threat.created'`)).rowCount).toBe(1);
    // «Увечері очікується» не заливає територію, йде тихим повідомленням без заклику в укриття — і
    // секунди собі не купує. Асиметрія та сама, що й «початок швидко, відбій неспішно».
    expect(await pokeCounts()).toEqual(before);
  });

  it('does not poke for a message past the delivery-age ceiling, which publishes nothing', async () => {
    const before = await pokeCounts();
    const stale = new Date(Date.now() - 3 * 3_600_000);
    await ingest('Балістика курсом на Полтавщину!', stale);
    await delay(60);
    // Стеля віку тримається там, де й трималася: рядка в журналі немає, тож і будити нікого.
    expect((await sql(`SELECT 1 FROM system_event_log`)).rowCount).toBe(0);
    expect(await pokeCounts()).toEqual(before);
  });

  it('raises ONE poke per ingested message, whatever geography it touched', async () => {
    // Межа 1 `src/services/alert-poke.ts`: один поштовх на КОМІТ, не на рядок. Повідомлення, що
    // назвало дві області, — одна новина й один зайвий прохід.
    const before = await pokeCounts();
    await ingest('Балістика курсом на Полтавщину та Київщину!');
    await delay(60);
    const after = await pokeCounts();
    expect(after.threatFired - before.threatFired).toBe(1);
    expect(after.threatCoalesced - before.threatCoalesced).toBe(0);
  });

  it('does not poke for a de-escalation or for a restatement inside the coalesce window', async () => {
    await ingest('Балістика курсом на Полтавщину!');
    await delay(60);
    const before = await pokeCounts();
    // Той самий клас у тому ж місці всередині вікна: подія не піднімається вдруге, і `ingestThreat`
    // навіть не викликається — гілка повертається вище.
    await ingest('Балістика курсом на Полтавщину!');
    // Відбій джерела: правила закривають твердження, і це теж не жива загроза.
    await ingest('Відбій загрози балістики для Полтавщини, ціль знищена.');
    await delay(60);
    expect(await pokeCounts()).toEqual(before);
  });
});
