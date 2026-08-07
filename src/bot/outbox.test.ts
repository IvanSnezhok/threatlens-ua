import { describe, expect, it } from 'vitest';
import { formatMessage } from './outbox.js';

describe('Telegram notification formatting', () => {
  it('escapes source-controlled HTML', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: '<b>Київ</b>', threatType: 'uav', evidenceLevel: 'monitoring',
      summary: '<script>alert(1)</script>', validUntil: 'soon', mapUrl: 'https://example.test'
    } });
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;b&gt;Київ&lt;/b&gt;');
  });

  it('labels nightly percentages as indicative rather than statistical probability', () => {
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      generatedTime: '23:20', assessments: [{ locationName: 'Полтава', threatType: 'ballistic_missile',
        level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }], omitted: 0,
      mapUrl: 'https://example.test/analytics'
    } });
    expect(text).toContain('35% індикативного рівня');
    expect(text).toContain('не статистична ймовірність');
  });
});
