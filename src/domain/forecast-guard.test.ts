import { describe, expect, it } from 'vitest';
import { firstForecastLexeme, forecastLexeme, FORECAST_LEXEMES } from './forecast-guard.js';

/**
 * The two halves of this file are not symmetrical, and that is the point.
 *
 * The positives are the sentences a model actually writes when it is handed a table of past counts
 * and asked for prose — every one of them is arithmetically true about the past and forecasting in
 * its second clause, which is exactly the failure the grounding check cannot see.
 *
 * The negatives are the price of the guard. They are ordinary sentences about the past that share a
 * root with a lexeme, and each one names a specific way this file could be written so bluntly that
 * it turns the model off for honest text as well.
 */

const FORECASTS: Array<[string, string]> = [
  ['прогноз', 'Наш прогноз на ніч: масований наліт на Київщину.'],
  ['прогноз', 'Модель прогнозує зміщення на південь.'],
  ['спрогноз', 'Спрогнозувати наступний наліт за цими даними неможливо.'],
  ['передбачаєм', 'Передбачаємо повторення такої самої хвилі.'],
  ['очікуєть', 'Найближчим часом очікується удар по енергетиці.'],
  ['очікуват', 'Слід очікувати повторення нальоту тієї самої тривалості.'],
  ['очікуєм', 'Очікуємо, що частка «шахедів» зростатиме.'],
  ['очікуй', 'Очікуйте продовження хвилі до ранку.'],
  ['завдад', 'За такої динаміки завдадуть удару по тій самій області.'],
  ['атакуват', 'Найімовірніше, будуть атакувати ту саму підстанцію.'],
  ['буде атак', 'Наступною буде атака на Полтавщину.'],
  ['будуть атак', 'Сьогодні вночі будуть атаки на прифронтові області.'],
  ['буде удар', 'Далі буде удар по тому самому вузлу.'],
  ['планує', 'Противник планує розширити географію.'],
  ['планують', 'Планують перенести пуски на ранок.'],
  ['готує удар', 'Ворог готує удар по західних областях.'],
  ['намір', 'Наміри ворога — вивести з ладу підстанції на заході.'],
  ['наступн ціл', 'Наступна ціль — Дніпропетровська область.'],
  ['наступн ціл', 'Наступними цілями стануть прифронтові райони.'],
  ['цілі на', 'Цілі на ніч — енергетика центру країни.'],
  ['ризик влучан', 'Ризик влучання по Харківщині зростає.'],
  ['ймовірн ціл', 'Ймовірна ціль — Одещина.'],
  ['ймовірн удар', 'Ймовірний удар по портовій інфраструктурі.'],
  ['ймовірн атак', 'Ймовірні атаки на прифронтові громади.'],
  ['ймовірн приліт', 'Ймовірний приліт по Київщині.'],
  ['ймовірн прильот', 'Ймовірні прильоти на Київщині.'],
  ['ймовірн напрям', 'Ймовірний напрямок — на північ від міста.'],
  ['найімовірніш', 'Найімовірніше, наліт повториться.'],
  ['найближч годин', 'У найближчі години інтенсивність зросте.'],
  ['найближч доб', 'За найближчу добу картина зміниться.'],
  ['найближч ноч', 'Найближчої ночі активність збережеться.'],
  ['під загроз буд', 'Під загрозою будуть ті самі три області.']
];

/**
 * Sentences the tactical pass and the research memo genuinely produce. Each one is a *near miss*:
 * it shares a root with a lexeme above and says nothing about the future.
 */
const PAST_TENSE: readonly string[] = [
  // The three the design names by hand.
  'За добу зафіксовано 34 повідомлення про загрозу.',
  'Ймовірна стратегія противника цієї ночі читається з розподілу класів.',
  'Очікувана тривалість хвилі — це медіана, порахована за 15 днів.',
  // The rest of a deterministic tactics sentence set: numbers, shares, oblasts, hours.
  'Частка «шахедів» зросла з 0.31 до 0.52 за добу.',
  'Уперше за 15 днів зафіксовано клас «балістика»: 7 повідомлень.',
  'Нічна частка (22:00–06:00) зросла з 0.41 до 0.68.',
  'Медіана тривалості хвилі скоротилася з 240 до 130 хвилин.',
  'Три області з чотирьох — прифронтові; торік їх не було в цій вибірці.',
  'Найбільше повідомлень припало на Харківську область — 41 із 118.',
  'Перенаправлень з Полтавщини на Дніпропетровщину — 5 за добу.',
  'Ціль перенаправлення названо у п’яти повідомленнях дослівно.',
  'Ці числа — підрахунок минулого, а не передбачення майбутнього.',
  'Атакували переважно вночі: 68% повідомлень між 22:00 і 06:00.',
  'Планування маршрутів ми не відновлюємо і не намагаємося.',
  'Загроза для області фіксувалася 12 разів за 30 днів.'
];

describe('forecast lexemes', () => {
  it.each(FORECASTS)('rejects %s: %s', (lexeme, sentence) => {
    expect(forecastLexeme(sentence)).toBe(lexeme);
  });

  it.each(PAST_TENSE)('lets past-tense text through: %s', (sentence) => {
    expect(forecastLexeme(sentence)).toBeNull();
  });

  it('matches across inflection rather than by exact word', () => {
    // Prefix matching is what stands in for Ukrainian morphology here, and it is the only reason a
    // single stem covers the forms a model will actually write.
    for (const form of ['завдадуть', 'завдадуться', 'ЗАВДАДУТЬ']) {
      expect(forecastLexeme(`Вони ${form} удару.`), form).toBe('завдад');
    }
    for (const form of ['наступна ціль', 'наступної цілі', 'наступними цілями']) {
      expect(forecastLexeme(`Отже, ${form}.`), form).toBe('наступн ціл');
    }
  });

  it('is not fooled by punctuation, quotes or the apostrophe sitting between the words', () => {
    expect(forecastLexeme('Наступна — ціль Полтава')).toBe('наступн ціл');
    expect(forecastLexeme('«Наступна» «ціль»')).toBe('наступн ціл');
    expect(forecastLexeme('Ймовірний удар')).toBe('ймовірн удар');
  });

  it('requires the words of a multi-token lexeme to be adjacent and in order', () => {
    // Otherwise «ймовірн» — an ordinary word about the past — would eat any sentence that also
    // mentions a strike anywhere, which is most of them.
    expect(forecastLexeme('Ймовірна причина — погода; ударів було вісім.')).toBeNull();
    expect(forecastLexeme('Удар ймовірний')).toBeNull();
  });

  it('answers null for text that has no words at all', () => {
    expect(forecastLexeme('')).toBeNull();
    expect(forecastLexeme('— — —')).toBeNull();
  });

  it('reports the same lexeme whichever offending sentence carries it', () => {
    // The answer is written into a rejection reason, so it has to be stable enough to group on.
    expect(forecastLexeme('Очікується наліт.')).toBe(forecastLexeme('Очікується повторення.'));
  });
});

describe('checking a whole structured answer', () => {
  it('finds an offender wherever it hides, including the last caveat', () => {
    const answer = [
      'За добу зафіксовано 34 повідомлення про загрозу.',
      'Частка «шахедів» зросла з 0.31 до 0.52.',
      null,
      'Дані неповні: частина каналів мовчала.',
      'Найближчої ночі активність збережеться.'
    ];
    expect(firstForecastLexeme(answer)).toBe('найближч ноч');
  });

  it('passes an answer that is entirely about the past', () => {
    expect(firstForecastLexeme(PAST_TENSE)).toBeNull();
  });

  it('ignores absent fields rather than treating them as text', () => {
    expect(firstForecastLexeme([null, undefined, ''])).toBeNull();
  });
});

describe('the list itself', () => {
  it('is closed, non-empty and free of blank stems', () => {
    // A blank stem would be a prefix of every token and would reject every text ever written; an
    // empty lexeme would match at any position. Both are silent, so they are asserted here rather
    // than discovered when the commentary stops appearing.
    expect(FORECAST_LEXEMES.length).toBeGreaterThan(0);
    for (const lexeme of FORECAST_LEXEMES) {
      expect(lexeme.length, JSON.stringify(lexeme)).toBeGreaterThan(0);
      for (const stem of lexeme) {
        expect(stem.trim(), JSON.stringify(lexeme)).not.toBe('');
        expect(stem, JSON.stringify(lexeme)).toBe(stem.toLowerCase());
      }
    }
  });

  it('names each lexeme exactly once', () => {
    const labels = FORECAST_LEXEMES.map((lexeme) => lexeme.join(' '));
    expect(labels).toEqual([...new Set(labels)]);
  });

  it('detects every lexeme it declares, through the public function', () => {
    // The list and the matcher could drift — a stem could be added in a form the tokeniser never
    // produces (with a hyphen, with an apostrophe) and would then be dead code that reads as cover.
    for (const lexeme of FORECAST_LEXEMES) {
      const sentence = lexeme.join(' ');
      expect(forecastLexeme(sentence), sentence).not.toBeNull();
    }
  });
});
