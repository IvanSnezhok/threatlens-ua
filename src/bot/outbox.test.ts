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

  const digestPayload = {
    generatedTime: '23:20', assessments: [{ locationName: 'Полтава', threatType: 'ballistic_missile',
      level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }], omitted: 0,
    mapUrl: 'https://example.test/analytics'
  };

  it('names the model as the author of the summarising line', () => {
    // Читач не має способу відрізнити машинний рядок від порахованого, якщо йому цього не сказати,
    // а сказати може лише формат повідомлення: сама модель могла б цю фразу й пропустити.
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: 'Найвищий рівень — по Полтаві.', aiGenerated: true
    } });
    expect(text).toContain('написала мовна модель');
    expect(text).toContain('Найвищий рівень — по Полтаві.');
    // Оцінки лишаються тим, заради чого надіслано повідомлення: машинний рядок іде після них.
    expect(text.indexOf('Полтава')).toBeLessThan(text.indexOf('написала мовна модель'));
  });

  it('sends exactly the digest it always sent when the model was not used', () => {
    const withoutModel = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: null, aiGenerated: false
    } });
    expect(withoutModel).not.toContain('мовна модель');
    expect(withoutModel).toBe(formatMessage({ notification_type: 'nightly_digest', payload: digestPayload }));
  });

  it('never prints a stale summary that was not marked as model-written', () => {
    // Прапорець і текст їдуть разом; якщо прапорець знято, рядок не показуємо, навіть коли він є.
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: 'Щось відхилене.', aiGenerated: false
    } });
    expect(text).not.toContain('Щось відхилене.');
  });

  it('escapes a model-written line like any other untrusted text', () => {
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: '<script>alert(1)</script>', aiGenerated: true
    } });
    expect(text).not.toContain('<script>');
  });
});
