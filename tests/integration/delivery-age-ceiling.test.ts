import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  count, ensureMigrated, integrationDatabaseAvailable, outboxRows, resetDatabase, runFanout,
  seedSubscription, seedUser, sql
} from '../helpers/db.js';

/**
 * Стеля віку повідомлення, наскрізь: від `processMessage` до черги сповіщень.
 *
 * Одиничний тест на предикат уже є (`src/repositories/delivery-age.test.ts`) і доводить, що межа
 * рахується правильно. Тут доводиться зовсім інше, і без живої бази це недоказово:
 *
 *  1. **Живий шлях накрито теж.** Дірка, заради якої зроблено цю стелю, була саме в ньому:
 *     `src/sources/telegram.ts` не передає `historical`, і після реконекту MTProto віддає пачку
 *     пропущених апдейтів з їхніми СПРАВЖНІМИ датами. Годинної давнини повідомлення без прапорця
 *     має лягти в архів і не дійти до людини — так само, як і те, що прийшло з дозбору.
 *  2. **Архів і контекст лишаються повними.** Придушення тут коштує рівно одного: рядка в
 *     `system_event_log`. `source_messages`, `message_classifications` і контекст локації
 *     наповнюються так само, як для свіжого повідомлення, — саме заради цього повідомлення й
 *     обробляється.
 *  3. **Свіже поруч зі старим не постраждало.** Найважливіше: стеля не сміє глушити те, що ще
 *     стосується цієї хвилини, і сусідство зі старим повідомленням нічого не змінює.
 */
const ERADAR = 'osint-eradar';
const POLTAVA_OBLAST = 'ua-53';
const MINUTE = 60_000;

describe.skipIf(!integrationDatabaseAvailable)('стеля віку повідомлення для доставки', () => {
  /**
   * Інтеграційні файли ділять один форк і один процес, тож `config` — спільний стан. Файл, що
   * лишив по собі змінене налаштування, ламає сусіда, який його не чіпав, і робить це тим
   * підступним чином, коли поодинці зелені всі.
   */
  const booted = {
    SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES: undefined as unknown
  };
  beforeAll(async () => { await ensureMigrated();
    const { config } = await import('../../src/config.js');
    booted.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = (config as any).SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
  });
  afterAll(async () => {
    const { config } = await import('../../src/config.js');
    (config as any).SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = booted.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
  });

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/ingestion.js')).resetMonitorCoalescing();
    const { config } = await import('../../src/config.js');
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 60;
  });

  const ingest = async (text: string, minutesAgo: number, externalId: string, historical = false) => {
    const { processMessage } = await import('../../src/services/ingestion.js');
    return processMessage({
      sourceId: ERADAR, externalId, publishedAt: new Date(Date.now() - minutesAgo * MINUTE), text,
      rawPayload: { channel: ERADAR, test: true }
    }, { monitor: true, historical });
  };

  it('годинної давнини повідомлення з ЖИВОГО шляху не доходить до людини', async () => {
    await seedUser(7101);
    await seedSubscription({ chatId: 7101, locationId: POLTAVA_OBLAST });

    // Без `historical`: рівно те, що робить колектор після реконекту.
    const result = await ingest('Шахед курсом на Полтавщину.', 75, 'live-stale-1');
    await runFanout();

    expect((result as { published: boolean }).published).toBe(false);
    expect(await count('system_event_log')).toBe(0);
    expect(await count('notification_outbox')).toBe(0);
    // Подія існує — але позначена простроченою й на живій карті її немає.
    const event = await sql<{ status: string }>(`SELECT status FROM threat_events`);
    expect(event.rows[0]?.status).toBe('expired');
  });

  it('лишає повний слід в архіві й у контексті локації', async () => {
    await ingest('Шахед курсом на Полтавщину.', 75, 'live-stale-2');

    expect(await count('source_messages')).toBe(1);
    expect(await count('message_classifications')).toBe(1);
    // Контекст — те, заради чого старе повідомлення взагалі обробляється: наступний запит до моделі
    // про Полтавщину має бачити, що вночі тут щось було.
    const context = await sql<{ content: string }>(
      `SELECT content FROM model_location_contexts WHERE location_id=$1`, [POLTAVA_OBLAST]
    );
    expect(context.rows[0]?.content ?? '').toContain('Шахед курсом на Полтавщину');
    // І має бачити, що людей про це НЕ попередили: інакше воно читається як подія, на яку зреагували.
    expect(context.rows[0]?.content ?? '').toContain('не доставлялося');
  });

  it('свіже повідомлення поруч зі старим доходить як завжди', async () => {
    await seedUser(7102);
    await seedSubscription({ chatId: 7102, locationId: POLTAVA_OBLAST });

    await ingest('Шахед курсом на Полтавщину.', 75, 'mixed-old');
    (await import('../../src/services/ingestion.js')).resetMonitorCoalescing();
    const fresh = await ingest('Балістична загроза для Полтавщини.', 2, 'mixed-fresh');
    await runFanout();

    expect((fresh as { published: boolean }).published).toBe(true);
    const queued = await outboxRows();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.notification_type).toBe('threat_update');
  });

  it('нуль у налаштуванні повертає поведінку, яка була до стелі', async () => {
    const { config } = await import('../../src/config.js');
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 0;
    await seedUser(7103);
    await seedSubscription({ chatId: 7103, locationId: POLTAVA_OBLAST });

    const result = await ingest('Шахед курсом на Полтавщину.', 75, 'ceiling-off');
    await runFanout();

    // Подія публікується: рядок у `system_event_log` є, і карта з SSE його бачать.
    expect((result as { published: boolean }).published).toBe(true);
    expect(await count('system_event_log')).toBe(1);
    // А от у бот воно все одно не йде — і це НЕ стеля, а той захист, що стояв тут завжди: фан-аут
    // сам відмовляється слати попередження, чий `valid_until` уже минув. Стеля прибирає таке
    // повідомлення раніше й тихіше, але вимкнена вона не відкриває дороги хибній тривозі.
    expect(await count('notification_outbox')).toBe(0);
  });

  it('30-хвилинне правило дозбору лишилося суворішим за годинну стелю', async () => {
    await seedUser(7104);
    await seedSubscription({ chatId: 7104, locationId: POLTAVA_OBLAST });

    // Сорок хвилин: молодше за стелю, старше за власне вікно валідності. Дозбір мовчить.
    const result = await ingest('Шахед курсом на Полтавщину.', 40, 'backfill-40', true);
    await runFanout();

    expect((result as { published: boolean }).published).toBe(false);
    expect(await count('notification_outbox')).toBe(0);
  });
});
