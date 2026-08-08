import { describe, expect, it } from 'vitest';
import { clampAssessment, effectiveContribution, fallbackAssessment, signalTypeLabel, type ModelAssessment, type RiskSignalRow } from './risk.js';

const candidate: ModelAssessment = {
  locationId: 'wrong', threatType: 'wrong', horizonHours: 6, score: 9,
  confidence: 'high', supportingSignalIds: ['one', 'invented'],
  raisingFactors: ['signal'], limitingFactors: [], summary: 'summary'
};

function signal(overrides: Partial<RiskSignalRow> = {}): RiskSignalRow {
  return {
    id: 'one', signal_type: 'reported_direction', source_tier: 'C',
    independence_group: 'same', reliability: 0.4, freshness: 1,
    geographic_relevance: 1, contribution: 2, observed_at: new Date(), ...overrides
  };
}

describe('risk guardrails', () => {
  it('caps a single C-tier source and forces low confidence', () => {
    const result = clampAssessment(candidate, [signal()], 'ua-80', 'uav');
    expect(result.score).toBe(3.9);
    expect(result.confidence).toBe('low');
    expect(result.locationId).toBe('ua-80');
    expect(result.threatType).toBe('uav');
    expect(result.supportingSignalIds).toEqual(['one']);
  });

  it('caps assessments without an A-tier source', () => {
    const result = clampAssessment(candidate, [
      signal({ source_tier: 'B', independence_group: 'a' }),
      signal({ id: 'two', source_tier: 'B', independence_group: 'b' })
    ], 'ua-53', 'ballistic_missile');
    expect(result.score).toBe(5.9);
    expect(result.confidence).toBe('medium');
  });

  it('decays older signals with a two-hour half life', () => {
    const now = Date.now();
    const current = effectiveContribution(signal({ reliability: 1, contribution: 2, observed_at: new Date(now) }), now);
    const old = effectiveContribution(signal({ reliability: 1, contribution: 2, observed_at: new Date(now - 2 * 3_600_000) }), now);
    expect(current).toBeCloseTo(2, 3);
    expect(old).toBeCloseTo(1, 3);
  });
});

const location = { id: 'ua-80', name_uk: 'Київ' };

describe('пояснення оцінки читається людиною', () => {
  it('перекладає технічні типи сигналу і лишає назви індикаторів як є', () => {
    expect(signalTypeLabel('child_location_signal')).toBe('сигнал із населеного пункту всередині території');
    expect(signalTypeLabel('зліт стратегічної авіації')).toBe('зліт стратегічної авіації');
  });

  it('не пропускає жодного технічного ідентифікатора у чинники й підсумок', () => {
    const result = fallbackAssessment(location, 'uav', [
      signal({ id: 'a', signal_type: 'child_location_signal', independence_group: 'one' }),
      signal({ id: 'b', signal_type: 'child_location_signal', independence_group: 'one' }),
      signal({ id: 'c', signal_type: 'explicit_threat', independence_group: 'two', source_tier: 'A', reliability: 1 })
    ]);
    const text = [result.summary, ...result.raisingFactors, ...result.limitingFactors].join(' ');
    expect(text).not.toMatch(/child_location_signal|explicit_threat|reported_direction/);
    expect(result.summary).toContain('Київ');
    expect(result.summary).toContain('ударних БпЛА');
  });

  it('групує однотипні повідомлення в один чинник із правильним відмінюванням', () => {
    const result = fallbackAssessment(location, 'uav', [
      signal({ id: 'a', signal_type: 'reported_direction' }),
      signal({ id: 'b', signal_type: 'reported_direction' }),
      signal({ id: 'c', signal_type: 'reported_direction' })
    ]);
    const grouped = result.raisingFactors.filter((factor) => factor.startsWith('Ціль рухається в цьому напрямку —'));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toContain('3 повідомлення');
  });

  it('називає офіційне джерело і друге незалежне підтвердження окремими чинниками', () => {
    const result = fallbackAssessment(location, 'ballistic_missile', [
      signal({ id: 'a', source_tier: 'A', independence_group: 'one', reliability: 1 }),
      signal({ id: 'b', source_tier: 'B', independence_group: 'two', reliability: 0.75 })
    ]);
    expect(result.raisingFactors).toContain('Серед джерел є офіційне повідомлення.');
    expect(result.raisingFactors).toContain('Повідомлення надійшли щонайменше з двох незалежних груп джерел.');
    expect(result.confidence).toBe('medium');
  });

  it('кожен чинник — завершене речення в межах ліміту схеми', () => {
    const result = fallbackAssessment(location, 'uav', [signal()]);
    for (const factor of [...result.raisingFactors, ...result.limitingFactors]) {
      expect(factor).toMatch(/[.!?]$/);
      expect(factor.length).toBeLessThanOrEqual(240);
    }
  });

  it('обмеження індексу пояснює причину словами, а не кодом рівня', () => {
    const result = clampAssessment(candidate, [signal()], 'ua-80', 'uav');
    expect(result.limitingFactors.some((factor) => factor.includes('допоміжних каналів'))).toBe(true);
    expect(result.limitingFactors.join(' ')).not.toMatch(/tier|рівня C/i);
  });
});
