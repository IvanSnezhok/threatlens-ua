import { describe, expect, it } from 'vitest';
import { expectedWindow, isThreatTiming, nearerTiming, TIMING_LABELS, TIMING_BADGES } from './threat-timing.js';

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
