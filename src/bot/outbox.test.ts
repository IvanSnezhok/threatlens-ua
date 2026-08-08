import { describe, expect, it } from 'vitest';
import { formatMessage } from './outbox.js';
import { cleanSummary, evidenceStatement, humanMoment, validUntilLine } from './humanize.js';

// 2026-08-08T00:13:46Z is 03:13 in Kyiv (UTC+3 in summer), which is the whole point of the fixture:
// a naive formatter would print 00:13 and send people to a shelter an hour off.
const now = new Date('2026-08-08T00:13:46.000Z');

describe('Telegram notification formatting', () => {
  it('escapes source-controlled HTML', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: '<b>Київ</b>', threatType: 'uav', evidenceLevel: 'monitoring',
      summary: '<script>alert(1)</script>', validUntil: 'soon'
    } }, now);
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;b&gt;Київ&lt;/b&gt;');
  });

  it('labels nightly percentages as indicative rather than statistical probability', () => {
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      generatedTime: '23:20', assessments: [{ locationName: 'Полтава', threatType: 'ballistic_missile',
        level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }], omitted: 0
    } }, now);
    expect(text).toContain('35% індикативного рівня');
    expect(text).toContain('не статистична ймовірність');
  });

  it('states validity in Kyiv time with a remaining-time hint instead of an ISO string', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      summary: 'Загроза застосування балістики', validUntil: '2026-08-08T00:38:46.000Z'
    } }, now);
    expect(text).toContain('Актуально до 03:38 (ще ~25 хв)');
    expect(text).not.toContain('2026-08-08T00:38:46.000Z');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('spells out the evidence level instead of leaking the database enum', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed', summary: 'Пуски'
    } }, now);
    expect(text).toContain('Підтверджено кількома джерелами');
    expect(text).not.toContain('confirmed');
  });

  it('never emits a dead link: no source in the payload means no link at all', () => {
    for (const row of [
      { notification_type: 'alert_start', payload: { locationName: 'Київ', startedAt: now.toISOString() } },
      { notification_type: 'alert_end', payload: { locationName: 'Київ', endedAt: now.toISOString() } },
      { notification_type: 'threat_update', payload: { locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди' } },
      { notification_type: 'assessment_update', payload: { locationName: 'Київ', threatType: 'uav', level: 'elevated', score: 3.5, indicativePercent: 35, confidence: 'medium', explanation: {} } },
      { notification_type: 'nightly_digest', payload: { generatedTime: '23:20', omitted: 0, assessments: [
        { locationName: 'Київ', threatType: 'uav', level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }
      ] } }
    ]) {
      const text = formatMessage(row, now);
      expect(text).not.toContain('<a href');
      expect(text).not.toContain('Карта та джерела');
      expect(text).not.toContain('undefined');
    }
  });

  it('links the originating channel message when the payload carries one', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди',
      sourceUrl: 'https://t.me/monitor/1234', sourceName: 'Моніторинг'
    } }, now);
    expect(text).toContain('<a href="https://t.me/monitor/1234">Першоджерело: Моніторинг</a>');
  });

  it('ignores a source value that is not an http link', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди',
      sourceUrl: 'javascript:alert(1)', sourceName: 'Моніторинг'
    } }, now);
    expect(text).not.toContain('<a href');
  });

  it('puts the action before the details in a threat message', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      summary: 'Загроза балістики', validUntil: '2026-08-08T00:38:46.000Z'
    } }, now);
    expect(text.indexOf('перейдіть до укриття')).toBeGreaterThan(text.indexOf('Загроза балістики'));
    expect(text.indexOf('Підтверджено кількома джерелами')).toBeGreaterThan(text.indexOf('перейдіть до укриття'));
  });

  it('cleans channel formatting out of the summary and keeps a single leading emoji', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      summary: '⚠️Загроза  застосування балістики триває..'
    } }, now);
    expect(text).toContain('⚠️ <b>Київ — балістичні ракети</b>');
    expect(text).toContain('Загроза застосування балістики триває.');
    expect(text).not.toContain('триває..');
    expect(text.match(/⚠️/g)).toHaveLength(1);
  });

  it('translates the assessment confidence enum', () => {
    const text = formatMessage({ notification_type: 'assessment_update', payload: {
      locationName: 'Київ', threatType: 'uav', level: 'elevated', score: 3.5,
      indicativePercent: 35, confidence: 'medium', explanation: { raisingFactors: ['зліт МіГ-31К'] },
      horizonEnd: '2026-08-08T03:13:46.000Z'
    } }, now);
    expect(text).toContain('Впевненість оцінки: середня');
    expect(text).toContain('Оцінка чинна до 06:13');
    expect(text).not.toContain('medium');
  });
});

describe('humanised wording helpers', () => {
  it('formats a Kyiv time without a date for today and with a spelled-out date otherwise', () => {
    expect(humanMoment('2026-08-08T00:38:46.000Z', now)).toBe('03:38');
    expect(humanMoment('2026-08-09T05:00:00.000Z', now)).toBe('9 серпня о 08:00');
  });

  it('returns nothing for a missing or unparsable timestamp', () => {
    expect(humanMoment(null, now)).toBeNull();
    expect(humanMoment('soon', now)).toBeNull();
    expect(validUntilLine(undefined, now)).toBeNull();
  });

  it('switches to past tense once the validity window has closed', () => {
    expect(validUntilLine('2026-08-08T00:00:00.000Z', now)).toBe('Орієнтир діяв до 03:00');
  });

  it('counts hours and minutes for a long window', () => {
    expect(validUntilLine('2026-08-08T02:23:46.000Z', now)).toBe('Актуально до 05:23 (ще ~2 год 10 хв)');
  });

  it('covers every evidence level defined by the schema', () => {
    for (const level of ['official', 'confirmed', 'monitoring', 'unverified']) {
      expect(evidenceStatement(level)).toMatch(/[а-яїієґ]/i);
      expect(evidenceStatement(level)).not.toBe(level);
    }
    expect(evidenceStatement('щось нове')).toBe('Джерело повідомлення не класифіковане');
  });

  it('softly cleans a summary without rewriting its wording', () => {
    expect(cleanSummary('⚠️  Шахеди курсом на Полтавщину..\n\n\n\nСтежте  за  повідомленнями !!'))
      .toBe('Шахеди курсом на Полтавщину.\n\nСтежте за повідомленнями!');
    expect(cleanSummary('Ціль зникла з радарів...')).toBe('Ціль зникла з радарів…');
    expect(cleanSummary(null)).toBe('');
  });
});
