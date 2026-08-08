import { describe, expect, it } from 'vitest';
import { classifyMessage } from './classifier.js';
import {
  diffVerdict, formatReplayReport, replayReport, type ArchivedVerdict, type ReplayInput
} from './classifier-replay.js';
import type { ClassifiedMessage } from '../types.js';

const locations = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-51', name: 'Одеська область', aliases: ['одещина', 'одещині'] },
  { id: 'ua-city-odesa', name: 'Одеса', aliases: ['одеси', 'одесі', 'одесу'] }
];

function archived(overrides: Partial<ArchivedVerdict> = {}): ArchivedVerdict {
  return {
    sourceMessageId: 'msg-1',
    sourceId: 'telegram:monitor',
    text: 'Ударні БпЛА у напрямку Києва',
    classifierVersion: 'v1',
    threatType: 'uav',
    locationIds: ['ua-80'],
    significant: true,
    ...overrides
  };
}

const fresh = (text: string): ClassifiedMessage => classifyMessage(text, locations);

describe('diffVerdict', () => {
  it('reports nothing when the new run reaches the same three answers', () => {
    expect(diffVerdict(archived(), fresh('Ударні БпЛА у напрямку Києва'))).toBeNull();
  });

  it('treats a stored NULL class and a fresh unknown as the same statement', () => {
    // The archive writes NULL for a decision filed under no class. Reading that as a difference
    // would report every ignored message in the corpus as changed.
    const diff = diffVerdict(
      archived({ threatType: null, locationIds: [], significant: false, text: 'Доброго ранку, друзі!' }),
      fresh('Доброго ранку, друзі!')
    );
    expect(diff).toBeNull();
  });

  it('names the class axis when the label moved', () => {
    const diff = diffVerdict(archived({ threatType: 'unknown' }), fresh('Ударні БпЛА у напрямку Києва'));
    expect(diff?.changed).toEqual(['threat_type']);
    expect(diff?.after.threatType).toBe('uav');
  });

  it('compares locations as a set, not as a list', () => {
    const diff = diffVerdict(
      archived({ text: 'Шахед курсом на Одесу та Київ', locationIds: ['ua-80', 'ua-city-odesa'] }),
      fresh('Шахед курсом на Одесу та Київ')
    );
    expect(diff).toBeNull();
  });

  it('names the location axis when the resolved places changed', () => {
    const diff = diffVerdict(archived({ locationIds: ['ua-city-odesa'] }), fresh('Ударні БпЛА у напрямку Києва'));
    expect(diff?.changed).toContain('locations');
    expect(diff?.after.locationIds).toEqual(['ua-80']);
  });

  it('names the significance axis in both directions', () => {
    const gained = diffVerdict(archived({ significant: false }), fresh('Ударні БпЛА у напрямку Києва'));
    expect(gained?.changed).toContain('significance');
    expect(gained?.after.significant).toBe(true);

    const lost = diffVerdict(
      archived({ text: 'Шахед', threatType: 'uav', locationIds: [], significant: true }),
      fresh('Шахед')
    );
    expect(lost?.changed).toContain('significance');
    expect(lost?.after.significant).toBe(false);
  });
});

describe('replayReport', () => {
  const inputs: ReplayInput[] = [
    // unchanged
    { archived: archived({ sourceMessageId: 'a' }), fresh: fresh('Ударні БпЛА у напрямку Києва') },
    // class moved unknown -> uav
    { archived: archived({ sourceMessageId: 'b', threatType: 'unknown' }), fresh: fresh('Ударні БпЛА у напрямку Києва') },
    // was ignored, now significant
    {
      archived: archived({ sourceMessageId: 'c', threatType: null, locationIds: [], significant: false }),
      fresh: fresh('Ударні БпЛА у напрямку Києва')
    },
    // was significant, now ignored for want of a location
    {
      archived: archived({ sourceMessageId: 'd', text: 'Шахед', locationIds: [], significant: true }),
      fresh: fresh('Шахед')
    }
  ];

  it('counts each axis and separates the two directions of a significance change', () => {
    const report = replayReport(inputs, 'v2');
    expect(report.total).toBe(4);
    expect(report.unchanged).toBe(1);
    expect(report.changed).toBe(3);
    expect(report.byAxis.significance).toBe(2);
    expect(report.newlySignificant).toBe(1);
    expect(report.newlyIgnored).toBe(1);
    expect(report.fromVersion).toEqual(['v1']);
    expect(report.toVersion).toBe('v2');
  });

  it('records why the new version now raises nothing', () => {
    const report = replayReport(inputs, 'v2');
    expect(report.rejectionReasons).toContainEqual({ reason: 'no_location', count: 1 });
  });

  it('aggregates class movements with counts', () => {
    const report = replayReport(inputs, 'v2');
    expect(report.threatTypeMoves).toContainEqual({ from: 'unknown', to: 'uav', count: 2 });
  });

  it('caps the examples it keeps without capping the counts', () => {
    const report = replayReport(inputs, 'v2', 1);
    expect(report.examples).toHaveLength(1);
    expect(report.changed).toBe(3);
  });

  it('reports an empty corpus without dividing by zero', () => {
    const report = replayReport([], 'v2');
    expect(report.total).toBe(0);
    expect(report.changed).toBe(0);
    expect(formatReplayReport(report)).toContain('Повідомлень у вибірці: 0');
  });
});

describe('formatReplayReport', () => {
  it('states both directions of the significance change in plain words', () => {
    const text = formatReplayReport(replayReport([
      {
        archived: archived({ text: 'Шахед', locationIds: [], significant: true }),
        fresh: fresh('Шахед')
      }
    ], 'v2'));
    expect(text).toContain('втрачені події): 1');
    expect(text).toContain('нові події): 0');
  });
});
