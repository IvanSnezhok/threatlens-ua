import { describe, expect, it } from 'vitest';
import { buildLocationLabels, scopeToSubscription, type LocationRow } from './location-label.js';

const row = (id: string, name: string, type: string, parent: string | null = null): LocationRow =>
  ({ id, name_uk: name, type, parent_id: parent });

/** Ієрархія, знята з бойового каталогу: країна → область → район → місто. */
const CATALOGUE: LocationRow[] = [
  row('ua', 'Україна', 'country'),
  row('kyiv-obl', 'Київська область', 'oblast', 'ua'),
  row('vinn-obl', 'Вінницька область', 'oblast', 'ua'),
  row('lviv-obl', 'Львівська область', 'oblast', 'ua'),
  row('myk-obl', 'Миколаївська область', 'oblast', 'ua'),
  row('kyiv', 'Київ', 'special_city', 'ua'),

  row('brovary-r', 'Броварський район', 'raion', 'kyiv-obl'),
  row('fastiv-r', 'Фастівський район', 'raion', 'kyiv-obl'),
  row('khmil-r', 'Хмільницький район', 'raion', 'vinn-obl'),
  row('lviv-r', 'Львівський район', 'raion', 'lviv-obl'),
  row('myk-r', 'Миколаївський район', 'raion', 'myk-obl'),

  row('brovary', 'Бровари', 'city', 'brovary-r'),
  // Три Калинівки: дві з них — в ОДНІЙ області.
  row('kalyn-brovary', 'Калинівка', 'city', 'brovary-r'),
  row('kalyn-fastiv', 'Калинівка', 'city', 'fastiv-r'),
  row('kalyn-khmil', 'Калинівка', 'city', 'khmil-r'),
  // Два Миколаєви — у різних областях.
  row('mykolaiv-south', 'Миколаїв', 'city', 'myk-r'),
  row('mykolaiv-lviv', 'Миколаїв', 'city', 'lviv-r')
];

describe('buildLocationLabels', () => {
  const labels = buildLocationLabels(CATALOGUE);

  it('leaves a unique name alone', () => {
    // «Бровари, Київська область» у кожному повідомленні — це шум заради восьми випадків на весь
    // каталог, і саме на обсяг тексту скаржаться читачі.
    expect(labels.get('brovary')).toBe('Бровари');
    expect(labels.get('kyiv')).toBe('Київ');
  });

  it('adds the oblast when the oblast is what distinguishes', () => {
    expect(labels.get('mykolaiv-south')).toBe('Миколаїв, Миколаївська область');
    expect(labels.get('mykolaiv-lviv')).toBe('Миколаїв, Львівська область');
  });

  it('falls through to the raion when two of them share an oblast', () => {
    // Калинівка Броварського й Калинівка Фастівського — обидві в Київській. Зупинка на області
    // лишила б два різні міста з однаковим підписом, тобто ту саму проблему, лише тихішу.
    expect(labels.get('kalyn-brovary')).toBe('Калинівка, Броварський район');
    expect(labels.get('kalyn-fastiv')).toBe('Калинівка, Фастівський район');
  });

  it('still uses the oblast for the one that its oblast does distinguish', () => {
    // Третя Калинівка — єдина у Вінницькій, тож їй району не треба: коротший підпис, який усе одно
    // однозначний, кращий за довший.
    expect(labels.get('kalyn-khmil')).toBe('Калинівка, Вінницька область');
  });

  it('never labels an oblast with its own name twice', () => {
    expect(labels.get('kyiv-obl')).toBe('Київська область');
    expect(labels.get('lviv-obl')).toBe('Львівська область');
  });

  it('covers every row it was given', () => {
    expect(labels.size).toBe(CATALOGUE.length);
    for (const entry of CATALOGUE) expect(labels.get(entry.id)).toBeTruthy();
  });

  it('survives a parent cycle instead of hanging', () => {
    // Одна зіпсована синхронізація не має вішати процес доставки сповіщень.
    const cyclic: LocationRow[] = [
      row('a', 'Коло', 'city', 'b'),
      row('b', 'Коло', 'city', 'a')
    ];
    expect(() => buildLocationLabels(cyclic)).not.toThrow();
    expect(buildLocationLabels(cyclic).size).toBe(2);
  });

  it('handles a name that no ancestor can disambiguate', () => {
    // Два однойменні міста в одному районі: уточнювати нічим, і вигадувати відмінність гірше, ніж
    // визнати, що її немає.
    const flat: LocationRow[] = [
      row('obl', 'Область', 'oblast', null),
      row('r', 'Район', 'raion', 'obl'),
      row('x1', 'Тезка', 'city', 'r'),
      row('x2', 'Тезка', 'city', 'r')
    ];
    const built = buildLocationLabels(flat);
    expect(built.get('x1')).toBe('Тезка, Район');
    expect(built.get('x2')).toBe('Тезка, Район');
  });
});

describe('scopeToSubscription', () => {
  const KYIV_CITIES = ['brovary', 'kalyn-brovary', 'kalyn-fastiv'];
  const MIXED = [...KYIV_CITIES, 'mykolaiv-south', 'mykolaiv-lviv', 'kalyn-khmil'];

  it('keeps only what lies under the subscribed oblast', () => {
    // Скарга дослівно: «треба точно розділяти інформування саме по тому напрямку, на котре
    // підписаний користувач, не згадуючи інших».
    expect(scopeToSubscription(MIXED, ['kyiv-obl'], CATALOGUE)).toEqual(KYIV_CITIES);
  });

  it('keeps only the city itself when the subscription is that city', () => {
    expect(scopeToSubscription(MIXED, ['brovary'], CATALOGUE)).toEqual(['brovary']);
  });

  it('keeps a statement made ABOUT the ancestor of the subscription', () => {
    // Підписка на Бровари мусить почути «загроза на Київську область»: це твердження накриває
    // Бровари цілком, і мовчати про нього означало б сховати найширшу з відомих заяв.
    expect(scopeToSubscription(['kyiv-obl'], ['brovary'], CATALOGUE)).toEqual(['kyiv-obl']);
  });

  it('does not leak a sibling oblast named in the same event', () => {
    expect(scopeToSubscription(MIXED, ['lviv-obl'], CATALOGUE)).toEqual(['mykolaiv-lviv']);
  });

  it('unions several subscriptions of one chat', () => {
    const scoped = scopeToSubscription(MIXED, ['lviv-obl', 'myk-obl'], CATALOGUE);
    expect(scoped).toEqual(['mykolaiv-south', 'mykolaiv-lviv']);
  });

  it('falls back to everything rather than to nothing', () => {
    // Порожній перетин можливий лише при неузгодженому каталозі. Сповіщення зовсім без назви місця
    // не можна прочитати, тож зайва назва тут — менша шкода за жодної.
    expect(scopeToSubscription(MIXED, ['unknown-id'], CATALOGUE)).toEqual(MIXED);
    expect(scopeToSubscription(MIXED, [], CATALOGUE)).toEqual(MIXED);
  });

  it('preserves the order the caller gave', () => {
    // Порядок приходить із `ORDER BY el.location_id`, і саме він робить вміст повідомлення
    // однаковим на повторному проході — від нього залежить content_hash.
    const scoped = scopeToSubscription(['kalyn-fastiv', 'brovary'], ['kyiv-obl'], CATALOGUE);
    expect(scoped).toEqual(['kalyn-fastiv', 'brovary']);
  });
});
