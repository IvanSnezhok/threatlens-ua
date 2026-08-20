import { describe, expect, it } from 'vitest';
import {
  describeAge, expectedWindow, isThreatTiming, momentIn, nearerTiming, TIMING_LABELS, TIMING_BADGES
} from './threat-timing.js';

/**
 * Актуальність загрози в часі: вікно рахується з київського календаря, «увечері» — київський вечір,
 * явне вікно від моделі може звузити, не розширити. Усе чисте, без бази.
 */
const KYIV = 'Europe/Kyiv';

describe('expectedWindow', () => {
  it('keeps «now» at the thirty-minute validity every rule-made event always had', () => {
    const at = new Date('2026-08-18T10:00:00Z');
    const window = expectedWindow('now', at, KYIV);
    expect(window.from.toISOString()).toBe('2026-08-18T10:00:00.000Z');
    expect(window.until.toISOString()).toBe('2026-08-18T10:30:00.000Z');
  });

  it('gives «within the hour» ninety minutes, a day twenty-four hours, two days forty-eight', () => {
    const at = new Date('2026-08-18T10:00:00Z');
    expect(expectedWindow('within_hour', at, KYIV).until.toISOString()).toBe('2026-08-18T11:30:00.000Z');
    expect(expectedWindow('within_day', at, KYIV).until.toISOString()).toBe('2026-08-19T10:00:00.000Z');
    expect(expectedWindow('within_two_days', at, KYIV).until.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('reads «увечері» as the Kyiv evening of that calendar day: 18:00 to 23:59 local, not UTC', () => {
    // 12:00 UTC = 15:00 Kyiv in August (UTC+3): the evening is still ahead.
    const afternoon = expectedWindow('evening', new Date('2026-08-18T12:00:00Z'), KYIV);
    expect(afternoon.from.toISOString()).toBe('2026-08-18T15:00:00.000Z');   // 18:00 Kyiv
    expect(afternoon.until.toISOString()).toBe('2026-08-18T20:59:00.000Z');  // 23:59 Kyiv
    // 17:30 UTC = 20:30 Kyiv: the evening has started, the window opens at publication.
    const evening = expectedWindow('evening', new Date('2026-08-18T17:30:00Z'), KYIV);
    expect(evening.from.toISOString()).toBe('2026-08-18T17:30:00.000Z');
    expect(evening.until.toISOString()).toBe('2026-08-18T20:59:00.000Z');
  });

  it('uses the winter offset when the calendar says so', () => {
    // 10:00 UTC = 12:00 Kyiv in January (UTC+2) → evening starts 16:00 UTC, ends 21:59 UTC.
    const window = expectedWindow('evening', new Date('2026-01-15T10:00:00Z'), KYIV);
    expect(window.from.toISOString()).toBe('2026-01-15T16:00:00.000Z');
    expect(window.until.toISOString()).toBe('2026-01-15T21:59:00.000Z');
  });

  it('lets the model narrow the window with explicit times, never widen it', () => {
    const at = new Date('2026-08-18T12:00:00Z');
    const narrowed = expectedWindow('evening', at, KYIV, {
      from: new Date('2026-08-18T17:00:00Z'), until: new Date('2026-08-18T19:00:00Z')
    });
    expect(narrowed.from.toISOString()).toBe('2026-08-18T17:00:00.000Z');
    expect(narrowed.until.toISOString()).toBe('2026-08-18T19:00:00.000Z');
    const widened = expectedWindow('evening', at, KYIV, {
      from: new Date('2026-08-18T09:00:00Z'), until: new Date('2026-08-19T12:00:00Z')
    });
    expect(widened.from.toISOString()).toBe('2026-08-18T15:00:00.000Z');
    expect(widened.until.toISOString()).toBe('2026-08-18T20:59:00.000Z');
  });
});

describe('the vocabulary', () => {
  it('recognises the five values and nothing else', () => {
    for (const value of ['now', 'within_hour', 'evening', 'within_day', 'within_two_days']) expect(isThreatTiming(value)).toBe(true);
    expect(isThreatTiming('tomorrow')).toBe(false);
    expect(isThreatTiming(null)).toBe(false);
  });

  it('merges to the nearer timing, which is what a «летить зараз» after an «увечері» means', () => {
    expect(nearerTiming('evening', 'now')).toBe('now');
    expect(nearerTiming('within_day', 'evening')).toBe('evening');
    expect(nearerTiming('within_two_days', 'within_two_days')).toBe('within_two_days');
  });

  it('labels every value in Ukrainian, and badges every expected one', () => {
    expect(Object.keys(TIMING_LABELS)).toHaveLength(5);
    expect(TIMING_BADGES.evening).toBe('очікується увечері');
    expect('now' in TIMING_BADGES).toBe(false);
  });
});

/**
 * Час, яким його бачить модель (рішення власника 20.08.2026). Обидві функції існують заради одного
 * рішення — «зараз» це чи вже ні, — і обидві мають давати той самий рядок обом класифікаторам,
 * основному й тіньовому, бо їхні вердикти порівнюють між собою.
 */
describe('час у запиті до моделі', () => {
  const publishedAt = new Date('2026-08-20T20:41:00.000Z');

  it('називає київський момент словами, а не ISO-рядком', () => {
    const moment = momentIn(publishedAt, 'Europe/Kyiv');
    // 20:41 UTC — це 23:41 за Києвом улітку, і саме цю годину бачить джерело у своєму пості.
    expect(moment).toContain('23:41');
    expect(moment).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('дає вік повідомлення готовим рядком — щоб модель його читала, а не рахувала', () => {
    const at = (minutes: number) => describeAge(publishedAt, new Date(publishedAt.getTime() + minutes * 60_000));
    expect(at(0)).toBe('менше хвилини тому');
    expect(at(3)).toBe('3 хв тому');
    expect(at(59)).toBe('59 хв тому');
    expect(at(60)).toBe('1 год тому');
    expect(at(130)).toBe('2 год 10 хв тому');
  });

  it('не падає й не бреше, коли годинник джерела попереду нашого', () => {
    // Канали ставлять час своїм годинником. Секунди розходження — щоденна норма й читаються як
    // «щойно»; помітний розбіг має бути названий, а не показаний як відʼємний вік.
    expect(describeAge(publishedAt, new Date(publishedAt.getTime() - 30_000))).toBe('менше хвилини тому');
    expect(describeAge(publishedAt, new Date(publishedAt.getTime() - 5 * 60_000)))
      .toBe('щойно (мітка часу джерела попереду нашого годинника)');
  });
});
