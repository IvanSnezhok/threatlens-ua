import { describe, expect, it } from 'vitest';
import {
  COMPASS_TOKEN, inflections, isBlockedPlaceToken, nameTokens, paradigmName, sameLexeme, tokenize
} from './place-morphology.js';

/**
 * The declension table, read out loud.
 *
 * This module's whole claim is that it is auditable: a reviewer should be able to see what the rules
 * generate rather than trust that they generate the right thing. The first block below prints the
 * paradigm and its forms for every shape the archive uses, and the rest are the assertions that
 * matter — the forms that must be reachable, and the ones that must not be.
 */
describe('the generated declension table', () => {
  it('prints what each paradigm claims for the names the archive uses', () => {
    const sample = [
      'київ', 'фастів', 'обухів', 'харків', 'самар', 'бориспіль', 'коростень', 'тростянець',
      'кропивницький', 'броварський', 'березне', 'озерне', 'запоріжжя', 'зазимя', 'полтава',
      'обухівка', 'димерка', 'глеваха', 'суми', 'бровари', 'дігтярі', 'дніпро', 'ріг', 'бар'
    ];
    const table = sample.map((word) =>
      `  ${word.padEnd(16)} ${paradigmName(word).padEnd(30)} ${[...inflections(word)].join(' ')}`);
    console.log(`\n${table.join('\n')}\n`);
    expect(table).toHaveLength(sample.length);
  });
});

describe('tokenize', () => {
  it('keeps a hyphenated word whole', () => {
    // The single most important tokenisation decision in the module: split here and "південно" is a
    // word of its own, one step away from the settlement Південне.
    expect(tokenize('курс південно-західний').map((token) => token.key))
      .toEqual(['курс', 'південно-західний']);
    expect(tokenize('івано-франківськ').map((token) => token.key)).toEqual(['івано-франківськ']);
  });

  it('folds every apostrophe the feeds use into one key', () => {
    for (const spelling of ["зазим'я", 'зазим’я', 'зазимʼя', 'зазим`я']) {
      expect(tokenize(spelling).map((token) => token.key), spelling).toEqual(['зазимя']);
    }
  });

  it('reports spans into the text it was given', () => {
    const [first, second] = tokenize('на київ');
    expect('на київ'.slice(first!.start, first!.end)).toBe('на');
    expect('на київ'.slice(second!.start, second!.end)).toBe('київ');
  });

  it('splits an abbreviated prefix off the name', () => {
    expect(tokenize('м.київ, н.п. бровари').map((token) => token.key))
      .toEqual(['м', 'київ', 'н', 'п', 'бровари']);
  });

  it('reads a compound name as its words', () => {
    expect(nameTokens('Біла Церква')).toEqual(['біла', 'церква']);
    expect(nameTokens('Мала Дівиця')).toEqual(['мала', 'дівиця']);
  });
});

describe('inflections', () => {
  it('reaches the cases the archive writes and the substring matcher could not', () => {
    // Defect list B, one entry each. Every one of these was unresolvable under v3.
    expect(sameLexeme('київ', 'києвом')).toBe(true);
    expect(sameLexeme('кропивницький', 'кропивницьким')).toBe(true);
    expect(sameLexeme('фастів', 'фастова')).toBe(true);
    expect(sameLexeme('область', 'областей')).toBe(false); // enumerated separately, not declined
  });

  it('performs the closed-syllable alternation', () => {
    expect([...inflections('київ')]).toContain('києва');
    expect([...inflections('обухів')]).toContain('обухова');
    expect([...inflections('бориспіль')]).toContain('борисполя');
    expect([...inflections('козелець')]).toContain('козельця');
    expect([...inflections('тростянець')]).toContain('тростянця');
  });

  it('declines the feminine locative through the к→ц alternation', () => {
    expect(sameLexeme('димерка', 'димерці')).toBe(true);
    expect(sameLexeme('глеваха', 'глевасі')).toBe(true);
    expect(sameLexeme('обухівка', 'обухівку')).toBe(true);
  });

  it('declines a plural name, zero-ending genitive included', () => {
    expect(sameLexeme('суми', 'сум')).toBe(true);
    expect(sameLexeme('суми', 'сумами')).toBe(true);
    expect(sameLexeme('бровари', 'броварів')).toBe(true);
    expect(sameLexeme('дігтярі', 'дігтярів')).toBe(true);
  });

  it('never crosses from one name into a different one', () => {
    // Defect list A, stated as morphology rather than as classification. Each pair is a real
    // resolution v3 produced and a real settlement it did not name.
    expect(sameLexeme('обухів', 'обухівку')).toBe(false);
    expect(sameLexeme('бар', 'баришівку')).toBe(false);
    expect(sameLexeme('березне', 'березну')).toBe(false);
    expect(sameLexeme('південне', 'південно-західний')).toBe(false);
    expect(sameLexeme('самар', 'самарському')).toBe(false);
    expect(sameLexeme('київ', 'київської')).toBe(false);
    expect(sameLexeme('чоп', 'чоповичі')).toBe(false);
    expect(sameLexeme('брянка', 'добрянку')).toBe(false);
    expect(sameLexeme('приморськ', 'приморськ-ахтарська')).toBe(false);
    expect(sameLexeme('васильків', 'васильківку')).toBe(false);
    expect(sameLexeme('сіверськ', 'сіверський')).toBe(false);
    expect(sameLexeme('покровськ', 'покровського')).toBe(false);
    expect(sameLexeme('сум', 'суміжних')).toBe(false);
  });

  it('leaves a very short name undeclined', () => {
    // "бару"/"барі" are the noun far more often than the town, "сума" is never Суми, and "рогу" is
    // a horn. "Кривого Рогу" still resolves: the catalogue carries that spelling as an alias of its
    // own, and a two-word name needs both words to match.
    expect([...inflections('бар')]).toEqual(['бар']);
    expect([...inflections('сум')]).toEqual(['сум']);
    expect([...inflections('ріг')]).toEqual(['ріг']);
  });

  it('does not generate a vocative', () => {
    // "Львове" is a village in Kherson oblast before it is a way of addressing Львів.
    expect(sameLexeme('львів', 'львове')).toBe(false);
    expect(sameLexeme('полтава', 'полтаво')).toBe(false);
  });

  it('is a pure function of the word', () => {
    expect([...inflections('київ')]).toEqual([...inflections('київ')]);
  });
});

describe('the compass stop list', () => {
  it('covers the bearings the feeds print', () => {
    for (const bearing of [
      'південно-західний', 'північно-східному', 'південним', 'західніше', 'сході', 'півдні',
      'півночі', 'східного', 'заходу', 'пд', 'пн'
    ]) {
      expect(COMPASS_TOKEN.test(bearing), bearing).toBe(true);
    }
  });

  it('blocks a declined bearing and lets the catalogue spelling through', () => {
    // The rule in one pair: "південним курсом" is a bearing, "на Південне" is the settlement.
    expect(isBlockedPlaceToken('південним', true)).toBe(true);
    expect(isBlockedPlaceToken('південне', false)).toBe(false);
    // Same rule for the ordinary-word list: Мена is a town, "мені" is a pronoun.
    expect(isBlockedPlaceToken('мені', true)).toBe(true);
    expect(isBlockedPlaceToken('мена', false)).toBe(false);
    expect(isBlockedPlaceToken('троє', true)).toBe(true);
  });

  it('leaves an ordinary place name alone', () => {
    for (const name of ['київ', 'бровари', 'запоріжжя', 'обухівка', 'сарата']) {
      expect(COMPASS_TOKEN.test(name), name).toBe(false);
      expect(isBlockedPlaceToken(name, true), name).toBe(false);
    }
  });
});
