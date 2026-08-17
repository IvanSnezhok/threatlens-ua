import { describe, expect, it } from 'vitest';
import { attackStatsRefusal, planAttackStatsTask } from './attack-stats.js';

/**
 * Чиста частина сервісу статистики ударів. Черга, воркер і читання — в
 * `tests/integration/attack-stats.test.ts` проти справжнього Postgres; тут лише те, що вирішується
 * без бази: порядок відмов і календар завдання.
 */

describe('the refusal order', () => {
  const open = { enabled: true, requestedBy: 'public' as const, publicRequests: true, perDay: 30, usedToday: 0 };

  it('lets a public request through when the switch is on, the door is open and the cap has room', () => {
    expect(attackStatsRefusal(open)).toBeNull();
  });

  it('refuses the switch first: no amount of waiting changes it', () => {
    expect(attackStatsRefusal({ ...open, enabled: false, publicRequests: false, usedToday: 99 })).toBe('refused_disabled');
  });

  it('closes the public door before counting the cap, and only for the public', () => {
    expect(attackStatsRefusal({ ...open, publicRequests: false })).toBe('refused_public_closed');
    expect(attackStatsRefusal({ ...open, publicRequests: false, requestedBy: 'operator' })).toBeNull();
    expect(attackStatsRefusal({ ...open, publicRequests: false, requestedBy: 'scheduler' })).toBeNull();
  });

  it('refuses on the daily cap last, and treats zero as a closed surface', () => {
    expect(attackStatsRefusal({ ...open, usedToday: 30 })).toBe('refused_daily_cap');
    expect(attackStatsRefusal({ ...open, usedToday: 29 })).toBeNull();
    expect(attackStatsRefusal({ ...open, perDay: 0 })).toBe('refused_daily_cap');
  });
});

describe('planning the task', () => {
  it('ends the collection period yesterday and starts the forecast today, in Kyiv, not UTC', () => {
    // 21:30 UTC on the 17th is already 00:30 on the 18th in Kyiv (UTC+3 in August).
    const task = planAttackStatsTask({ id: 'ua-80', name: 'Київ' }, new Date('2026-08-17T21:30:00Z'), 'Europe/Kyiv');
    expect(task.today).toBe('2026-08-18');
    expect(task.periodTo).toBe('2026-08-17');
    // 45 days ending yesterday: 2026-07-04 … 2026-08-17.
    expect(task.periodFrom).toBe('2026-07-04');
    expect(task.forecastFrom).toBe('2026-08-18');
    // 14 days starting today: 18.08 … 31.08.
    expect(task.forecastTo).toBe('2026-08-31');
    expect(task.lastEpisodes).toBe(15);
    expect(task.regionName).toBe('Київ');
  });

  it('crosses a month boundary without a calendar library', () => {
    const task = planAttackStatsTask({ id: 'ua-53', name: 'Полтавська область' }, new Date('2026-09-01T10:00:00Z'), 'Europe/Kyiv');
    expect(task.periodTo).toBe('2026-08-31');
    expect(task.forecastFrom).toBe('2026-09-01');
    expect(task.forecastTo).toBe('2026-09-14');
  });
});
