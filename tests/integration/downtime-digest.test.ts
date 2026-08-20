import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureMigrated, integrationDatabaseAvailable, outboxRows, resetDatabase, seedSubscription,
  seedUser, sql
} from '../helpers/db.js';

/**
 * Зведення після простою, наскрізь.
 *
 * Чотири властивості, кожна з яких без живої бази недоказова:
 *
 *  1. **Одне повідомлення на чат, а не одне на кожне пропущене.** Це вся суть зміни: сто
 *     попереджень про те, що вже скінчилося, — шум, який вчить читача вимикати бота.
 *  2. **Читач бачить лише свої місця.** Підписаний на Полтавщину не має читати про Харківщину, у
 *     якій тієї ночі теж було гучно.
 *  3. **Свіже в зведення не потрапляє.** Повідомлення, про яке людину вже попередили окремо, у
 *     підсумку простою було б другою копією того самого.
 *  4. **Той самий простій лягає в контекст локації переліком для моделі** — у форматі
 *     «повідомлення N : час, канал, посилання».
 */
const ERADAR = 'osint-eradar';
const WAR_MONITOR = 'osint-war-monitor';
const POLTAVA_OBLAST = 'ua-53';
const KHARKIV_OBLAST = 'ua-63';
const MINUTE = 60_000;

describe.skipIf(!integrationDatabaseAvailable)('зведення після простою', () => {
  /**
   * Інтеграційні файли ділять один форк і один процес, тож `config` — спільний стан. Файл, що
   * лишив по собі змінене налаштування, ламає сусіда, який його не чіпав, і робить це тим
   * підступним чином, коли поодинці зелені всі.
   */
  const booted = {
    SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES: undefined as unknown,
    MODEL_CONTEXT_ENABLED: undefined as unknown
  };
  beforeAll(async () => { await ensureMigrated();
    const { config } = await import('../../src/config.js');
    booted.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = (config as any).SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
    booted.MODEL_CONTEXT_ENABLED = (config as any).MODEL_CONTEXT_ENABLED;
  });
  afterAll(async () => {
    const { config } = await import('../../src/config.js');
    (config as any).SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = booted.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
    (config as any).MODEL_CONTEXT_ENABLED = booted.MODEL_CONTEXT_ENABLED;
  });

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/ingestion.js')).resetMonitorCoalescing();
    const { config } = await import('../../src/config.js');
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 60;
    config.MODEL_CONTEXT_ENABLED = true;
  });

  const ingest = async (sourceId: string, text: string, minutesAgo: number, externalId: string) => {
    const { processMessage, resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
    resetMonitorCoalescing();
    return processMessage({
      sourceId, externalId, publishedAt: new Date(Date.now() - minutesAgo * MINUTE), text,
      rawPayload: { channel: sourceId, test: true }
    }, { monitor: true, historical: true });
  };

  const digest = async () => (await import('../../src/services/downtime-digest.js')).publishDowntimeDigest();

  it('дає одне повідомлення на чат про всі його місця', async () => {
    await seedUser(7301);
    await seedSubscription({ chatId: 7301, locationId: POLTAVA_OBLAST });
    await seedSubscription({ chatId: 7301, locationId: KHARKIV_OBLAST });

    await ingest(ERADAR, 'Шахед курсом на Полтавщину.', 180, 'gap-1');
    await ingest(WAR_MONITOR, 'Ударні БпЛА на Полтавщині.', 150, 'gap-2');
    await ingest(ERADAR, 'Балістична загроза для Харківщини.', 120, 'gap-3');

    const result = await digest();
    expect(result.chats).toBe(1);

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notification_type).toBe('downtime_digest');
    // Тихо й найнижчим пріоритетом: це довідка про ніч, а не сигнал.
    expect(rows[0]!.priority).toBe(4);
    expect((rows[0]!.payload as any).silent).toBe(true);
    const lines: string[] = ((rows[0]!.payload as any).locations ?? []).map((entry: any) => entry.line);
    expect(lines.join(' ')).toContain('Полтавська область — 2 повідомлення');
    expect(lines.join(' ')).toContain('Харківська область — 1 повідомлення');
  });

  it('показує читачеві лише ті місця, на які він підписаний', async () => {
    await seedUser(7302);
    await seedSubscription({ chatId: 7302, locationId: POLTAVA_OBLAST });

    await ingest(ERADAR, 'Шахед курсом на Полтавщину.', 180, 'scope-1');
    await ingest(ERADAR, 'Балістична загроза для Харківщини.', 150, 'scope-2');

    await digest();
    const payload = (await outboxRows())[0]!.payload as any;
    const names = payload.locations.map((entry: any) => entry.locationName);
    expect(names).toContain('Полтавська область');
    expect(names).not.toContain('Харківська область');
  });

  it('не переказує того, про що людину вже попередили', async () => {
    await seedUser(7303);
    await seedSubscription({ chatId: 7303, locationId: POLTAVA_OBLAST });

    // Свіже повідомлення — воно пішло звичайним попередженням і в підсумок простою не належить.
    const { processMessage, resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
    resetMonitorCoalescing();
    await processMessage({
      sourceId: ERADAR, externalId: 'fresh-1', publishedAt: new Date(Date.now() - 2 * MINUTE),
      text: 'Шахед курсом на Полтавщину.', rawPayload: {}
    }, { monitor: true });

    const result = await digest();
    expect(result.chats).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('кладе простій у контекст локації переліком для моделі', async () => {
    await ingest(ERADAR, 'Шахед курсом на Полтавщину.', 180, 'ctx-1');
    await ingest(WAR_MONITOR, 'Ударні БпЛА на Полтавщині.', 150, 'ctx-2');
    await digest();

    const context = await sql<{ content: string }>(
      `SELECT content FROM model_location_contexts WHERE location_id=$1`, [POLTAVA_OBLAST]
    );
    const content = context.rows[0]?.content ?? '';
    expect(content).toContain('дозбір після простою');
    expect(content).toMatch(/повідомлення 1 : час \d{2}:\d{2}, /);
    expect(content).toMatch(/повідомлення 2 : час \d{2}:\d{2}, /);
  });

  it('не називає простоєм те, що дозбір і не читав би — місячної давнини архів', async () => {
    // Перший бойовий прохід 20.08.2026 заявив вікно «з 12 травня»: у добу, з якої почав курсор,
    // потрапили рядки архіву з тримісячної давнини публікаціями. Простій не може бути довшим, ніж
    // дозбір узагалі сягає назад, і саме це тут і перевіряється.
    await seedUser(7304);
    await seedSubscription({ chatId: 7304, locationId: POLTAVA_OBLAST });
    const { config } = await import('../../src/config.js');
    // Дозбір читає назад шість годин; повідомлення тижневої давнини — архів, а не пропущене.
    expect(config.CLASSIFIER_BACKFILL_MAX_AGE_SECONDS).toBe(21_600);
    await ingest(ERADAR, 'Шахед курсом на Полтавщину.', 7 * 24 * 60, 'ancient-1');

    const result = await digest();
    expect(result.chats).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('другий прохід над тим самим простоєм не шле другої копії', async () => {
    await seedUser(7305);
    await seedSubscription({ chatId: 7305, locationId: POLTAVA_OBLAST });
    await ingest(ERADAR, 'Шахед курсом на Полтавщину.', 180, 'once-1');

    await digest();
    const afterFirst = await outboxRows();
    const second = await digest();

    expect(second.chats).toBe(0);
    expect(await outboxRows()).toHaveLength(afterFirst.length);
  });
});
