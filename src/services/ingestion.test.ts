import { describe, expect, it } from 'vitest';
import { escapeLikePattern, normalizeAlarmResponse, pickLocationMatch } from './ingestion.js';

describe('official alert normalization', () => {
  it('normalizes a nested active-alert snapshot', () => {
    const result = normalizeAlarmResponse([{ regionId: '31', regionName: 'Київ', activeAlerts: [
      { id: 'air-1', type: 'AIR', lastUpdate: '2026-01-02T03:04:05Z' }
    ] }]);
    expect(result.candidateCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'air-1', locationKey: '31', locationName: 'Київ', alertType: 'air_raid', active: true
    });
  });

  it('normalizes explicit inactive records without inventing activity', () => {
    const result = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-53', region_name: 'Полтавська область', alert_type: 'ARTILLERY', status: 'inactive'
    }] });
    expect(result.records[0]).toMatchObject({ locationKey: 'ua-53', alertType: 'artillery', active: false });
  });
});

describe('location LIKE escaping', () => {
  it('neutralizes LIKE metacharacters supplied by the provider', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('\\')).toBe('\\\\');
    expect(escapeLikePattern('київ_%')).toBe('київ\\_\\%');
  });

  it('leaves ordinary Ukrainian names untouched', () => {
    expect(escapeLikePattern('львівська область')).toBe('львівська область');
  });
});

describe('location match resolution', () => {
  const exact = { id: 'ua-32', type: 'oblast', match_rank: 0 };
  const alias = { id: 'ua-14', type: 'oblast', match_rank: 1 };
  const prefix = { id: 'ua-51', type: 'raion', match_rank: 2 };

  it('prefers an exact name over an alias or prefix hit', () => {
    expect(pickLocationMatch([prefix, alias, exact])).toBe('ua-32');
  });

  it('prefers an alias over a prefix hit', () => {
    expect(pickLocationMatch([prefix, alias])).toBe('ua-14');
  });

  it('accepts a prefix hit only when it is unique', () => {
    expect(pickLocationMatch([prefix])).toBe('ua-51');
    expect(pickLocationMatch([prefix, { id: 'ua-53', type: 'raion', match_rank: 2 }])).toBeNull();
  });

  it('rejects an ambiguous prefix hit instead of falling back to a lower-ranked candidate', () => {
    expect(pickLocationMatch([
      { id: 'ua-51', type: 'oblast', match_rank: 2 },
      { id: 'ua-53', type: 'raion', match_rank: 2 }
    ])).toBeNull();
  });

  it('breaks exact-match ties towards a single administrative unit', () => {
    expect(pickLocationMatch([
      { id: 'ua-32-hromada', type: 'hromada', match_rank: 0 },
      { id: 'ua-32', type: 'special_city', match_rank: 0 }
    ])).toBe('ua-32');
  });

  it('rejects exact matches that stay ambiguous after the administrative tie-break', () => {
    expect(pickLocationMatch([
      { id: 'ua-32', type: 'oblast', match_rank: 0 },
      { id: 'ua-80', type: 'special_city', match_rank: 0 }
    ])).toBeNull();
    expect(pickLocationMatch([
      { id: 'ua-51-a', type: 'city', match_rank: 0 },
      { id: 'ua-53-a', type: 'city', match_rank: 0 }
    ])).toBeNull();
  });

  it('returns null when nothing matched', () => {
    expect(pickLocationMatch([])).toBeNull();
  });
});
