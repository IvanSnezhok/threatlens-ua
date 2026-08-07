import { describe, expect, it } from 'vitest';
import { normalizeAlarmResponse } from './ingestion.js';

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
