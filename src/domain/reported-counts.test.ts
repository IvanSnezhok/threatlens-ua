import { describe, expect, it } from 'vitest';
import { peakReportedCounts, reportedCounts } from './reported-counts.js';

/**
 * Межа, яку цей модуль охороняє, важливіша за будь-яку його зручність: число потрапляє в розбір
 * ЛИШЕ тоді, коли його написало саме джерело, і числа з різних повідомлень не додаються. Тести
 * нижче написані так, щоб зламатися саме на порушенні цих двох правил, а не на формулюванні.
 */
describe('числа, названі джерелом', () => {
  it('читає кількість перед словом і після нього', () => {
    expect(reportedCounts('10 шахедів курсом на Київщину')).toEqual([
      { count: 10, threatType: 'uav', label: 'ударні БпЛА' }
    ]);
    expect(reportedCounts('БпЛА: 4 у напрямку міста')).toEqual([
      { count: 4, threatType: 'uav', label: 'ударні БпЛА' }
    ]);
    expect(reportedCounts('група з 5 шахедів')).toEqual([
      { count: 5, threatType: 'uav', label: 'ударні БпЛА' }
    ]);
  });

  it('мовчить, коли джерело кількості не називало', () => {
    expect(reportedCounts('Шахеди на Полтавщині')).toEqual([]);
    expect(reportedCounts('Ракетна небезпека для всієї країни')).toEqual([]);
  });

  it('не бере числа, які не є кількістю цілей', () => {
    // Рік, час і номер посту стоять поруч із загрозовою лексикою в кожному другому пості.
    expect(reportedCounts('станом на 2026 рік')).toEqual([]);
    expect(reportedCounts('о 23:40 зафіксовано пуски')).toEqual([]);
  });

  it('НЕ додає числа з різних повідомлень — бере найбільше, назване одним', () => {
    // Дві групи по пʼять, про які написали два канали, — найімовірніше одна група, описана двічі.
    // Сума перетворила б переказ на власну оцінку, і саме цього тут не має статися ніколи.
    const peaks = peakReportedCounts([
      '5 шахедів курсом на Бровари',
      'ще 5 шахедів у тому ж напрямку',
      '2 балістичні ракети з півночі'
    ]);
    expect(peaks).toEqual([
      { count: 5, threatType: 'uav', label: 'ударні БпЛА' },
      { count: 2, threatType: 'ballistic_missile', label: 'балістика' }
    ]);
  });

  it('читає узагальнені слова, якими канали називають кількість', () => {
    // Найчастіше формулювання взагалі: канал не називає класу, лише скільки їх.
    expect(reportedCounts('12 цілей у повітряному просторі')).toEqual([
      { count: 12, threatType: 'unknown', label: 'цілі' }
    ]);
    expect(reportedCounts('2 ракети з північного сходу')).toEqual([
      { count: 2, threatType: 'cruise_missile', label: 'ракети' }
    ]);
  });

  it('зводить різні написання того самого класу в один рядок', () => {
    const peaks = peakReportedCounts(['10 шахедів', '12 БпЛА']);
    expect(peaks).toEqual([{ count: 12, threatType: 'uav', label: 'ударні БпЛА' }]);
  });
});
