import { describe, expect, it } from 'vitest';
import { EVENT_LOG_GAP_GRACE_MS, deliverableRun } from './event-log-cursor.js';

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
