import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSystemEvent, ensureMigrated, integrationDatabaseAvailable, outboxRows, resetDatabase,
  runFanout, seedSubscription, seedUser, sql
} from '../helpers/db.js';

/**
 * Розбір атаки після відбою, наскрізь.
 *
 * Що доводиться саме тут, а не в юніт-тесті на текст:
 *
 *  1. **Відбій приходить першим, розбір — після нього і тихо.** Порядок у черзі є частиною змісту:
 *     розбір, доставлений перед відбоєм, читається як повідомлення про те, що все ще триває.
 *  2. **Розбір бачить те, що було в межах вікна тривоги, і не бачить того, що було поза ним.**
 *     Вікно — це `alert_periods.started_at..ended_at`, і повідомлення за годину до тривоги в розбір
 *     потрапити не може.
 *  3. **Тривога, за час якої каналів не було чути, не породжує нічого.** Порожній розбір — лист
 *     заради листа, і його не має існувати.
 */
const ERADAR = 'osint-eradar';
const POLTAVA_OBLAST = 'ua-53';
const MINUTE = 60_000;

async function seedEndedAlert(startedMinutesAgo: number, endedMinutesAgo: number): Promise<string> {
  const inserted = await sql<{ id: string }>(
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at,ended_at)
     VALUES ($1,'air_raid','ended',now() - ($2::int * interval '1 minute'), now() - ($3::int * interval '1 minute'))
     RETURNING id`,
    [POLTAVA_OBLAST, startedMinutesAgo, endedMinutesAgo]
  );
  return inserted.rows[0]!.id;
}

describe.skipIf(!integrationDatabaseAvailable)('розбір атаки після відбою', () => {
  /**
   * Інтеграційні файли ділять один форк і один процес, тож `config` — спільний стан. Файл, що
   * лишив по собі змінене налаштування, ламає сусіда, який його не чіпав, і робить це тим
   * підступним чином, коли поодинці зелені всі.
   */
  const booted = {
    SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES: undefined as unknown,
    ATTACK_DEBRIEF_ENABLED: undefined as unknown,
    ATTACK_DEBRIEF_MIN_MESSAGES: undefined as unknown
  };
  beforeAll(async () => { await ensureMigrated();
    const { config } = await import('../../src/config.js');
    booted.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = (config as any).SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
    booted.ATTACK_DEBRIEF_ENABLED = (config as any).ATTACK_DEBRIEF_ENABLED;
    booted.ATTACK_DEBRIEF_MIN_MESSAGES = (config as any).ATTACK_DEBRIEF_MIN_MESSAGES;
  });
  afterAll(async () => {
    const { config } = await import('../../src/config.js');
    (config as any).SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = booted.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
    (config as any).ATTACK_DEBRIEF_ENABLED = booted.ATTACK_DEBRIEF_ENABLED;
    (config as any).ATTACK_DEBRIEF_MIN_MESSAGES = booted.ATTACK_DEBRIEF_MIN_MESSAGES;
  });

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/ingestion.js')).resetMonitorCoalescing();
    const { config } = await import('../../src/config.js');
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 0;
    config.ATTACK_DEBRIEF_ENABLED = true;
    config.ATTACK_DEBRIEF_MIN_MESSAGES = 3;
  });

  const ingest = async (text: string, minutesAgo: number, externalId: string) => {
    const { processMessage } = await import('../../src/services/ingestion.js');
    (await import('../../src/services/ingestion.js')).resetMonitorCoalescing();
    return processMessage({
      sourceId: ERADAR, externalId, publishedAt: new Date(Date.now() - minutesAgo * MINUTE), text,
      rawPayload: { channel: ERADAR, test: true }
    }, { monitor: true });
  };

  it('надсилає відбій, а після нього — тихий розбір', async () => {
    await seedUser(7201);
    await seedSubscription({ chatId: 7201, locationId: POLTAVA_OBLAST });
    const alertId = await seedEndedAlert(95, 5);

    await ingest('10 шахедів курсом на Полтавщину.', 80, 'raid-1');
    await ingest('Вибухи в Полтаві.', 60, 'raid-2');
    await ingest('Працює ППО на Полтавщині.', 40, 'raid-3');

    await appendSystemEvent('alert.ended', { alertId, locationId: POLTAVA_OBLAST });
    await runFanout();

    const rows = await outboxRows();
    const kinds = rows.map((row) => row.notification_type);
    expect(kinds).toContain('alert_end');
    expect(kinds).toContain('attack_debrief');

    const debrief = rows.find((row) => row.notification_type === 'attack_debrief')!;
    // Тихо й найнижчим пріоритетом: розбір потрібен зранку, а не о 04:10.
    expect(debrief.priority).toBe(4);
    expect((debrief.payload as any).silent).toBe(true);
    const lines: string[] = (debrief.payload as any).lines;
    expect(lines[0]).toContain('Тривога тривала');
    expect(lines.join(' ')).toContain('ударні БпЛА');
    // Число — цитата джерела, зі стелею і без суми.
    expect(lines.join(' ')).toContain('до 10');
    expect(lines.join(' ')).toContain('Повідомляли про вибухи');
    expect(lines.join(' ')).toContain('Повідомляли про роботу ППО');
  });

  it('не бачить того, що було поза вікном тривоги', async () => {
    await seedUser(7202);
    await seedSubscription({ chatId: 7202, locationId: POLTAVA_OBLAST });
    const alertId = await seedEndedAlert(30, 5);

    // Три повідомлення ЗА ГОДИНУ до початку тривоги: вікно їх не накриває, і розбору бути не має.
    await ingest('Шахед курсом на Полтавщину.', 95, 'outside-1');
    await ingest('Шахед курсом на Полтавщину.', 90, 'outside-2');
    await ingest('Шахед курсом на Полтавщину.', 85, 'outside-3');

    await appendSystemEvent('alert.ended', { alertId, locationId: POLTAVA_OBLAST });
    await runFanout();

    const kinds = (await outboxRows()).map((row) => row.notification_type);
    expect(kinds).toContain('alert_end');
    expect(kinds).not.toContain('attack_debrief');
  });

  it('мовчить про тривогу, за час якої каналів майже не було чути', async () => {
    await seedUser(7203);
    await seedSubscription({ chatId: 7203, locationId: POLTAVA_OBLAST });
    const alertId = await seedEndedAlert(95, 5);
    await ingest('Шахед курсом на Полтавщину.', 80, 'quiet-1');

    await appendSystemEvent('alert.ended', { alertId, locationId: POLTAVA_OBLAST });
    await runFanout();

    const kinds = (await outboxRows()).map((row) => row.notification_type);
    expect(kinds).toEqual(['alert_end']);
  });

  it('вимкнена розсилка не породжує розбору в черзі', async () => {
    const { config } = await import('../../src/config.js');
    config.ATTACK_DEBRIEF_ENABLED = false;
    await seedUser(7204);
    await seedSubscription({ chatId: 7204, locationId: POLTAVA_OBLAST });
    const alertId = await seedEndedAlert(95, 5);
    await ingest('10 шахедів курсом на Полтавщину.', 80, 'off-1');
    await ingest('Вибухи в Полтаві.', 60, 'off-2');
    await ingest('Працює ППО на Полтавщині.', 40, 'off-3');

    await appendSystemEvent('alert.ended', { alertId, locationId: POLTAVA_OBLAST });
    await runFanout();

    const kinds = (await outboxRows()).map((row) => row.notification_type);
    expect(kinds).toEqual(['alert_end']);
  });

  it('початок тривоги розбору не породжує — тільки відбій', async () => {
    await seedUser(7205);
    await seedSubscription({ chatId: 7205, locationId: POLTAVA_OBLAST });
    const started = await sql<{ id: string }>(
      `INSERT INTO alert_periods(location_id,alert_type,status,started_at)
       VALUES ($1,'air_raid','active',now() - interval '5 minutes') RETURNING id`,
      [POLTAVA_OBLAST]
    );
    await ingest('10 шахедів курсом на Полтавщину.', 3, 'start-1');

    await appendSystemEvent('alert.started', { alertId: started.rows[0]!.id, locationId: POLTAVA_OBLAST });
    await runFanout();

    const kinds = (await outboxRows()).map((row) => row.notification_type);
    expect(kinds).not.toContain('attack_debrief');
  });
});
