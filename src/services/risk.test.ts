import { describe, expect, it } from 'vitest';
import { clampAssessment, effectiveContribution, type ModelAssessment, type RiskSignalRow } from './risk.js';

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
