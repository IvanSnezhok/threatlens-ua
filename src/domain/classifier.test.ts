import { describe, expect, it } from 'vitest';
import { classifyMessage, riskLevel } from './classifier.js';

const locations = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-59', name: 'Сумська область', aliases: ['сумщина', 'сумщині'] }
];

describe('classifyMessage', () => {
  it('recognizes a reported direction without claiming a target', () => {
    const result = classifyMessage('Ударні БпЛА у напрямку Києва', locations);
    expect(result.threatType).toBe('uav');
    expect(result.locations[0]).toMatchObject({ id: 'ua-80', relationType: 'reported_direction' });
    expect(result.directionText).toContain('у напрямку Києва');
  });

  it('recognizes ballistic threat and regional alias', () => {
    const result = classifyMessage('Загроза балістики для Сумщини', locations);
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.locations[0]?.id).toBe('ua-59');
  });

  it('turns strategic aviation activity into a national cruise-missile signal', () => {
    const result = classifyMessage('Зафіксовано зліт групи Ту-95МС з аеродрому на території РФ.', locations);
    expect(result.threatType).toBe('cruise_missile');
    expect(result.signalThreatTypes).toContain('cruise_missile');
    expect(result.nationalScope).toBe(true);
    expect(result.indicators).toContain('зліт стратегічної авіації');
  });

  it('keeps all component threat types for combined signals', () => {
    const result = classifyMessage('Робота ворожої ППО та активність установок С-400.', locations);
    expect(result.threatType).toBe('combined');
    expect(result.signalThreatTypes).toEqual(expect.arrayContaining(['ballistic_missile', 'cruise_missile']));
  });

  it('maps risk levels deterministically', () => {
    expect(riskLevel(0)).toBe('background');
    expect(riskLevel(3.5)).toBe('elevated');
    expect(riskLevel(8)).toBe('very_high');
  });
});
