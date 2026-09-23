import { Registry } from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_LOG_GAP_GRACE_MS, deliverableRun, eventLogGapBlockedAge, eventLogGapCrossed, eventLogGapStalls
} from './event-log-cursor.js';

const NOW = new Date('2026-08-14T18:00:00.000Z').getTime();

/** Рядок журналу віком `ageMs` на момент `NOW`. */
const row = (version: number, ageMs = 0) => ({ version, created_at: new Date(NOW - ageMs) });

describe('deliverableRun', () => {
  it('віддає весь безперервний відрізок', () => {
    const rows = [row(11), row(12), row(13)];
    expect(deliverableRun(rows, 10, NOW).map((r) => r.version)).toEqual([11, 12, 13]);
  });

  it('віддає порожньо, коли пропущено вже першу версію', () => {
    // Рівно відтворений інцидент: курсор на 10, версію 11 взяла довга транзакція знімка й ще не
    // закомітила, версія 12 належить короткій транзакції інжесту, що встигла першою.
    expect(deliverableRun([row(12)], 10, NOW)).toEqual([]);
  });

  it('зупиняється перед розривом усередині партії', () => {
    const rows = [row(11), row(12), row(14), row(15)];
    expect(deliverableRun(rows, 10, NOW).map((r) => r.version)).toEqual([11, 12]);
  });

  it('віддає пропущену версію наступним проходом, коли транзакція закомітилась', () => {
    const first = deliverableRun([row(12)], 10, NOW);
    expect(first).toEqual([]);
    // Курсор не зрушив, тож наступний прохід читає з тієї самої точки — і тепер бачить обидві.
    const second = deliverableRun([row(11), row(12)], 10, NOW);
    expect(second.map((r) => r.version)).toEqual([11, 12]);
  });

  it('перестрибує розрив, що пережив пільговий час', () => {
    // Відкочена транзакція спалює значення послідовності назавжди. Чекати на неї нема сенсу, і
    // єдине, що відрізняє її від ще незакоміченої, — те, що розрив не зникає.
    const stale = deliverableRun([row(12, EVENT_LOG_GAP_GRACE_MS + 1)], 10, NOW);
    expect(stale.map((r) => r.version)).toEqual([12]);
  });

  it('тримає розрив рівно до межі пільгового часу', () => {
    expect(deliverableRun([row(12, EVENT_LOG_GAP_GRACE_MS - 1)], 10, NOW)).toEqual([]);
    expect(deliverableRun([row(12, EVENT_LOG_GAP_GRACE_MS)], 10, NOW).map((r) => r.version)).toEqual([12]);
  });

  it('переживши розрив, продовжує читати далі за звичайним правилом', () => {
    const rows = [row(12, EVENT_LOG_GAP_GRACE_MS + 1), row(13, EVENT_LOG_GAP_GRACE_MS + 1), row(15)];
    // 11 згоріла й перестрибнута, 12→13 безперервні, 14 ще може з'явитися — тож 15 чекає.
    expect(deliverableRun(rows, 10, NOW).map((r) => r.version)).toEqual([12, 13]);
  });

  it('читає version як число, коли драйвер віддав bigint рядком', () => {
    const rows = [{ version: '11', created_at: new Date(NOW) }, { version: '12', created_at: new Date(NOW) }];
    expect(deliverableRun(rows, 10, NOW)).toHaveLength(2);
  });

  it('не змінює вхідний масив', () => {
    const rows = [row(11), row(13)];
    deliverableRun(rows, 10, NOW);
    expect(rows.map((r) => r.version)).toEqual([11, 13]);
  });

  it('порожній вхід дає порожній вихід', () => {
    expect(deliverableRun([], 10, NOW)).toEqual([]);
  });
});

/**
 * Стадія затримки, якої досі не було видно.
 *
 * Саме рішення перевірено вище; тут перевіряється, що воно себе називає: скільки разів читач стояв,
 * наскільки свіжий був рядок, що його тримав, і хто саме з читачів це був. Під час
 * загальнонаціональної тривоги це єдиний спосіб відрізнити «сповіщення ще не пішло, бо транзакція
 * знімка не закомічена» від «сповіщення не пішло, бо щось зламалося».
 */
describe('метрики розриву', () => {
  const registry = new Registry();
  registry.registerMetric(eventLogGapStalls);
  registry.registerMetric(eventLogGapBlockedAge);
  registry.registerMetric(eventLogGapCrossed);

  async function series(
    name: string
  ): Promise<Array<{ metricName?: string; labels: Record<string, string>; value: number }>> {
    const metric = (await registry.getMetricsAsJSON()).find((item) => item.name === name);
    return ((metric?.values ?? []) as Array<{ metricName?: string; labels: Record<string, string>; value: number }>);
  }

  beforeEach(() => {
    eventLogGapStalls.reset();
    eventLogGapBlockedAge.reset();
    eventLogGapCrossed.reset();
  });

  it('рахує стояння один раз на прохід і називає читача', async () => {
    // Два стримані рядки — один прохід, на якому читач стояв, а не два.
    deliverableRun([row(12), row(13)], 10, NOW, 'notifications');
    expect(await series('threatlens_event_log_gap_stalls_total')).toEqual([
      { labels: { reader: 'notifications' }, value: 1 }
    ]);
  });

  it('мовчить, коли відрізок безперервний', async () => {
    deliverableRun([row(11), row(12)], 10, NOW, 'sse_live');
    expect(await series('threatlens_event_log_gap_stalls_total')).toEqual([]);
    expect(await series('threatlens_event_log_gap_crossed_total')).toEqual([]);
  });

  it('записує вік рядка, що стримав — тобто наскільки близько до межі', async () => {
    deliverableRun([row(12, 30_000)], 10, NOW, 'notifications');
    const values = await series('threatlens_event_log_gap_blocked_age_seconds');
    const sum = values.find((item) => item.metricName?.endsWith('_sum'));
    const count = values.find((item) => item.metricName?.endsWith('_count'));
    expect(sum).toEqual({ metricName: 'threatlens_event_log_gap_blocked_age_seconds_sum',
      labels: { reader: 'notifications' }, value: 30 });
    expect(count?.value).toBe(1);
  });

  it('розрізняє «чекаємо» і «здалися»', async () => {
    // Пільговий час вичерпано: версія 11 згоріла разом із відкоченою транзакцією, читач її
    // перестрибує — і це інша подія, ніж стояння, бо чекати на неї більше нема сенсу.
    deliverableRun([row(12, EVENT_LOG_GAP_GRACE_MS + 1)], 10, NOW, 'sse_backfill');
    expect(await series('threatlens_event_log_gap_stalls_total')).toEqual([]);
    expect(await series('threatlens_event_log_gap_crossed_total')).toEqual([
      { labels: { reader: 'sse_backfill' }, value: 1 }
    ]);
  });

  it('виклик без мітки рахується, а не зникає', async () => {
    deliverableRun([row(12)], 10, NOW);
    expect(await series('threatlens_event_log_gap_stalls_total')).toEqual([
      { labels: { reader: 'unlabelled' }, value: 1 }
    ]);
  });
});
