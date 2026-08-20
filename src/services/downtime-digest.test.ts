import { describe, expect, it } from 'vitest';
import {
  downtimeLine, renderDowntimeForModel, summariseByLocation, type DowntimeMessage
} from './downtime-digest.js';

/**
 * Чисті частини зведення після простою: перелік для моделі й підсумок для людини. Обидві не бачать
 * бази — саме тому їх і винесено окремими функціями, і саме тому їхні межі перевіряються тут, а не
 * в інтеграційному тесті, де вони б потонули в підготовці даних.
 */
const message = (over: Partial<DowntimeMessage> = {}): DowntimeMessage => ({
  publishedAt: new Date('2026-08-19T23:14:00.000Z'),
  sourceId: 'osint-napalm',
  sourceName: 'Napalm',
  url: 'https://t.me/napalm/9931',
  threatType: 'uav',
  directionText: null,
  createdEvent: true,
  locationId: 'ua-32',
  locationName: 'Київська область',
  locationType: 'oblast',
  ...over
});

describe('перелік простою для моделі', () => {
  it('пише рядок у форматі «повідомлення N : час, канал, посилання»', () => {
    const listing = renderDowntimeForModel([
      message(),
      message({ sourceId: 'osint-eradar', sourceName: 'eRadar', url: 'https://t.me/eradar/12', publishedAt: new Date('2026-08-19T23:31:00.000Z') })
    ]);
    expect(listing.split('\n')).toEqual([
      'повідомлення 1 : час 02:14, Napalm, https://t.me/napalm/9931;',
      'повідомлення 2 : час 02:31, eRadar, https://t.me/eradar/12;'
    ]);
  });

  it('не вигадує посилання джерелу, у якого немає публічної адреси', () => {
    const listing = renderDowntimeForModel([message({ url: null })]);
    expect(listing).toBe('повідомлення 1 : час 02:14, Napalm;');
  });

  it('рахує одне повідомлення один раз, хоч би скільки місць воно зачепило', () => {
    // Один пост, що назвав три райони, приходить із бази трьома рядками. Модель, яка побачила б їх
    // як три повідомлення, прочитала б одне свідчення як три незалежні.
    const listing = renderDowntimeForModel([
      message({ locationId: 'ua-32', locationName: 'Київська область' }),
      message({ locationId: 'ua-32-01', locationName: 'Бровари' }),
      message({ locationId: 'ua-32-02', locationName: 'Вишневе' })
    ]);
    expect(listing.split('\n')).toHaveLength(1);
  });

  it('обмежує перелік, а не віддає моделі всю ніч', () => {
    const many = Array.from({ length: 80 }, (_, index) => message({
      publishedAt: new Date(Date.UTC(2026, 7, 19, 20, index)), sourceId: `s-${index}`
    }));
    expect(renderDowntimeForModel(many, 10).split('\n')).toHaveLength(10);
  });
});

describe('підсумок для людини', () => {
  it('рахує повідомлення на місце, а не рядки бази', () => {
    const summaries = summariseByLocation([
      message(),
      message({ locationId: 'ua-32-01', locationName: 'Бровари' }),
      message({ sourceId: 'osint-eradar', sourceName: 'eRadar', publishedAt: new Date('2026-08-19T23:31:00.000Z') }),
      message({ threatType: 'ballistic_missile', sourceId: 'osint-x', publishedAt: new Date('2026-08-19T23:50:00.000Z') })
    ]);
    const oblast = summaries.find((summary) => summary.locationId === 'ua-32')!;
    expect(oblast.messages).toBe(3);
    expect(oblast.classes).toEqual(['ударні БпЛА', 'балістика']);
    expect(summaries.find((summary) => summary.locationId === 'ua-32-01')!.messages).toBe(1);
  });

  it('називає числа повідомленнями, ніколи не цілями', () => {
    const [summary] = summariseByLocation([message(), message({ sourceId: 'b', publishedAt: new Date('2026-08-19T23:31:00.000Z') })]);
    const line = downtimeLine(summary!);
    expect(line).toBe('Київська область — 2 повідомлення (ударні БпЛА), 02:14–02:31');
    expect(line).not.toContain('ціл');
  });

  it('відмінює «повідомлення» правильно', () => {
    const at = (index: number) => message({ sourceId: `s-${index}`, publishedAt: new Date(Date.UTC(2026, 7, 19, 20, index)) });
    const forCount = (count: number) => downtimeLine(summariseByLocation(
      Array.from({ length: count }, (_, index) => at(index))
    )[0]!);
    expect(forCount(1)).toContain('1 повідомлення (');
    expect(forCount(3)).toContain('3 повідомлення (');
    expect(forCount(7)).toContain('7 повідомлень (');
    expect(forCount(12)).toContain('12 повідомлень (');
    expect(forCount(21)).toContain('21 повідомлення (');
  });
});
