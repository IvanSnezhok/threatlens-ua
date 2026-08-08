import { describe, expect, it } from 'vitest';
import { THREAT_TYPES, type ThreatType } from '../types.js';
import {
  compareThreatIcons, freshnessBucket, iconAriaLabel, iconImageId, rankThreatIcons,
  DANGER_RANK, ICON_TONES, ICON_TONE_ARIA_UK, MAX_ICON_SLOTS, THREAT_ICON_KEYS,
  THREAT_ICON_LABELS_UK, THREAT_ICON_PATHS,
  type IconCandidate
} from './threat-icons.js';

/**
 * The whole point of this module is that its output does not depend on when it runs, so every
 * vector below is written against one pinned clock. `now` is passed explicitly for the same reason
 * the production code takes it as a parameter: a test that reached for `Date.now()` would be
 * testing the machine's clock, not the order.
 */
const T = new Date('2026-08-08T12:00:00.000Z');
const ago = (ms: number): string => new Date(T.getTime() - ms).toISOString();

const c = (over: Partial<IconCandidate> = {}): IconCandidate => ({
  threatType: 'uav', tone: 'reported', evidenceLevel: 'monitoring', relationType: 'mentioned',
  lastConfirmedAt: ago(5 * 60_000), eventCount: 1, riskScore: null, ...over
});

const compare = (a: IconCandidate, b: IconCandidate): number => compareThreatIcons(a, b, T);

/** Deterministic shuffle: a Math.random() here would make a failure impossible to reproduce. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const swap = result[i]!;
    result[i] = result[j]!;
    result[j] = swap;
  }
  return result;
}

describe('compareThreatIcons — the eight keys', () => {
  it('ranks state above evidence, freshness, danger and count', () => {
    // V1: `a` loses every other key and still wins on tone alone.
    const a = c({
      threatType: 'unknown', tone: 'consequence', evidenceLevel: 'unverified',
      relationType: 'aftermath', lastConfirmedAt: ago(90 * 60_000), eventCount: 1
    });
    const b = c({
      threatType: 'ballistic_missile', tone: 'confirmed', evidenceLevel: 'official',
      relationType: 'explicit_threat', lastConfirmedAt: ago(60_000), eventCount: 9
    });
    expect(compare(a, b)).toBeLessThan(0);
  });

  it('ranks evidence above danger', () => {
    // V2: мінометний обстріл з офіційного джерела важить більше за балістику «за даними моніторингу».
    const a = c({ threatType: 'mortar', tone: 'confirmed', evidenceLevel: 'official', relationType: 'mentioned' });
    const b = c({
      threatType: 'ballistic_missile', tone: 'confirmed', evidenceLevel: 'confirmed',
      relationType: 'explicit_threat'
    });
    expect(compare(a, b)).toBeLessThan(0);
  });

  it('buckets freshness instead of comparing timestamps', () => {
    // V3: два кошики — 9 хв 59 с проти 10 хв 1 с; свіжість перемагає небезпеку.
    const fresher = c({ threatType: 'artillery', lastConfirmedAt: ago(9 * 60_000 + 59_000) });
    const older = c({ threatType: 'ballistic_missile', lastConfirmedAt: ago(10 * 60_000 + 1_000) });
    expect(compare(fresher, older)).toBeLessThan(0);

    // V4: усередині одного кошика мілісекунди не важать — вирішує небезпека, а не ключ 7.
    const ballistic = c({ threatType: 'ballistic_missile', lastConfirmedAt: ago(9 * 60_000) });
    const uav = c({ threatType: 'uav', lastConfirmedAt: ago(60_000) });
    expect(freshnessBucket(ballistic.lastConfirmedAt, T)).toBe(freshnessBucket(uav.lastConfirmedAt, T));
    expect(compare(ballistic, uav)).toBeLessThan(0);
  });

  it('treats ten minutes as the exclusive edge of the freshest bucket', () => {
    // V5: `age < 10 min` — строго менше.
    const onTheEdge = c({ lastConfirmedAt: ago(600_000) });
    const insideIt = c({ lastConfirmedAt: ago(599_999) });
    expect(freshnessBucket(onTheEdge.lastConfirmedAt, T)).toBe(2);
    expect(freshnessBucket(insideIt.lastConfirmedAt, T)).toBe(3);
    expect(compare(onTheEdge, insideIt)).toBeGreaterThan(0);
  });

  it('falls back to the reported relation when the class is the same', () => {
    // V6
    const explicit = c({ relationType: 'explicit_threat' });
    const direction = c({ relationType: 'reported_direction' });
    expect(compare(explicit, direction)).toBeLessThan(0);

    // V6b: відсутній звʼязок — найслабший, слабший навіть за `mentioned`.
    const mentioned = c({ relationType: 'mentioned' });
    const none = c({ relationType: null });
    expect(compare(mentioned, none)).toBeLessThan(0);
  });

  it('prefers the class with more events when everything else ties', () => {
    // V7
    const many = c({ threatType: 'mlrs', eventCount: 4 });
    const one = c({ threatType: 'mlrs', eventCount: 1 });
    expect(compare(many, one)).toBeLessThan(0);
  });

  it('resolves a one-millisecond difference inside one bucket', () => {
    // V8: останній змістовний ключ.
    const newer = c({ threatType: 'mlrs', eventCount: 2, lastConfirmedAt: ago(300_000) });
    const older = c({ threatType: 'mlrs', eventCount: 2, lastConfirmedAt: ago(300_001) });
    expect(freshnessBucket(newer.lastConfirmedAt, T)).toBe(freshnessBucket(older.lastConfirmedAt, T));
    expect(compare(newer, older)).toBeLessThan(0);
  });

  it('returns zero only for an identical candidate', () => {
    // V9
    expect(compare(c(), c())).toBe(0);
    expect(compare(c(), c({ eventCount: 2 }))).not.toBe(0);
    expect(compare(c(), c({ threatType: 'mortar' }))).not.toBe(0);
  });

  it('is a strict total order over the ten classes', () => {
    // V10: усі 45 невпорядкованих пар, решта полів однакова.
    const pairs: Array<[ThreatType, ThreatType]> = [];
    for (let i = 0; i < THREAT_TYPES.length; i += 1) {
      for (let j = i + 1; j < THREAT_TYPES.length; j += 1) {
        pairs.push([THREAT_TYPES[i]!, THREAT_TYPES[j]!]);
      }
    }
    expect(pairs).toHaveLength(45);
    for (const [left, right] of pairs) {
      const a = c({ threatType: left });
      const b = c({ threatType: right });
      expect(compare(a, b)).not.toBe(0);
      expect(Math.sign(compare(a, b))).toBe(-Math.sign(compare(b, a)));
    }
  });

  it('never lets an analytic candidate outrank a reported one', () => {
    // V11: «аналітична оцінка ніколи не виглядає як тривога», зроблене порядковим.
    const analytic = c({
      threatType: 'ballistic_missile', tone: 'analytic', evidenceLevel: null,
      relationType: null, lastConfirmedAt: ago(60_000), eventCount: 0
    });
    const reported = c({
      threatType: 'unknown', tone: 'reported', evidenceLevel: 'unverified',
      relationType: 'mentioned', lastConfirmedAt: ago(100 * 60_000)
    });
    expect(compare(analytic, reported)).toBeGreaterThan(0);
  });

  it('clamps a future timestamp instead of ranking it ahead of now', () => {
    // V12: розбіжність годинника на джерелі — це не свіжість із майбутнього.
    const future = c({ lastConfirmedAt: new Date(T.getTime() + 30_000).toISOString() });
    const recent = c({ lastConfirmedAt: ago(60_000) });
    expect(freshnessBucket(future.lastConfirmedAt, T)).toBe(3);
    expect(Number.isFinite(compare(future, recent))).toBe(true);
    expect(compare(future, recent)).toBeLessThan(0);
  });

  it('sorts an unparseable timestamp into the oldest bucket', () => {
    // V13
    const broken = c({ lastConfirmedAt: 'не дата' });
    const old = c({ lastConfirmedAt: ago(3 * 60 * 60_000) });
    expect(freshnessBucket(broken.lastConfirmedAt, T)).toBe(0);
    expect(Number.isFinite(compare(broken, old))).toBe(true);
    expect(compare(broken, old)).toBeGreaterThan(0);
  });

  it('sorts identically across 100 shuffles', () => {
    const seven: IconCandidate[] = [
      c({ threatType: 'ballistic_missile', tone: 'confirmed', evidenceLevel: 'official', relationType: 'explicit_threat' }),
      c({ threatType: 'guided_air_bomb', tone: 'consequence', evidenceLevel: 'confirmed', relationType: 'aftermath' }),
      c({ threatType: 'cruise_missile', tone: 'reported', evidenceLevel: 'monitoring', lastConfirmedAt: ago(45 * 60_000) }),
      c({ threatType: 'mlrs', tone: 'confirmed', evidenceLevel: 'confirmed', eventCount: 3 }),
      c({ threatType: 'uav', tone: 'reported', evidenceLevel: 'unverified', lastConfirmedAt: ago(3 * 60_000) }),
      c({ threatType: 'artillery', tone: 'analytic', evidenceLevel: null, relationType: null, eventCount: 0 }),
      c({ threatType: 'unknown', tone: 'reported', evidenceLevel: 'monitoring', lastConfirmedAt: ago(150 * 60_000) })
    ];
    const order = (candidates: IconCandidate[]): string[] =>
      [...candidates].sort((a, b) => compare(a, b)).map((one) => iconImageId(one.threatType, one.tone));

    const expected = order(seven);
    for (let seed = 1; seed <= 100; seed += 1) {
      expect(order(shuffled(seven, seed))).toEqual(expected);
    }
  });
});

describe('rankThreatIcons', () => {
  const distinct = (count: number): IconCandidate[] =>
    THREAT_TYPES.slice(0, count).map((threatType) => c({ threatType }));

  it('slots at most three icons and reports the rest as overflow', () => {
    // R1–R6
    const cases: Array<[number, number, number]> = [[1, 1, 0], [2, 2, 0], [3, 3, 0], [4, 3, 1], [9, 3, 6], [0, 0, 0]];
    for (const [given, slotted, overflow] of cases) {
      const stack = rankThreatIcons(distinct(given), T);
      expect(stack.icons).toHaveLength(slotted);
      expect(stack.overflow).toBe(overflow);
      expect(stack.icons.length).toBeLessThanOrEqual(MAX_ICON_SLOTS);
    }
  });

  it('does not mutate the candidate array it was given', () => {
    const input = distinct(6);
    const before = structuredClone(input);
    rankThreatIcons(input, T);
    expect(input).toEqual(before);
  });

  it('assigns rank, image id, label and ARIA label to every slotted icon', () => {
    const stack = rankThreatIcons([
      c({ threatType: 'ballistic_missile', tone: 'consequence' }),
      c({ threatType: 'uav', tone: 'confirmed', evidenceLevel: 'official' }),
      c({ threatType: 'mortar', tone: 'reported' })
    ], T);
    expect(stack.icons).toHaveLength(3);
    stack.icons.forEach((icon, index) => {
      expect(icon.rank).toBe(index);
      expect(icon.iconId).toBe(iconImageId(icon.threatType, icon.tone));
      expect(icon.labelUk).toBe(THREAT_ICON_LABELS_UK[icon.threatType]);
      expect(icon.ariaLabelUk).toBe(iconAriaLabel(icon.threatType, icon.tone));
      expect(icon.ariaLabelUk.endsWith(ICON_TONE_ARIA_UK[icon.tone])).toBe(true);
    });
  });
});

describe('the icon catalogue', () => {
  it('gives every class a distinct danger rank', () => {
    expect(new Set(Object.values(DANGER_RANK)).size).toBe(10);
  });

  it('covers every threat class with a glyph, a label and a danger rank', () => {
    const expected = [...THREAT_TYPES].sort();
    for (const table of [THREAT_ICON_PATHS, THREAT_ICON_LABELS_UK, DANGER_RANK, THREAT_ICON_KEYS]) {
      expect(Object.keys(table).sort()).toEqual(expected);
    }
  });

  it('builds forty unique image ids', () => {
    const ids = THREAT_TYPES.flatMap((threatType) => ICON_TONES.map((tone) => iconImageId(threatType, tone)));
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    for (const id of ids) expect(id).toMatch(/^ti-[a-z_]+-[a-z]+$/);
  });

  it('names every tone in Ukrainian', () => {
    expect(iconAriaLabel('uav', 'confirmed')).toBe('Ударні БпЛА — підтверджене джерело');
    for (const tone of ICON_TONES) {
      expect(iconAriaLabel('uav', tone).endsWith(ICON_TONE_ARIA_UK[tone])).toBe(true);
    }
    expect(Object.values(ICON_TONE_ARIA_UK)).toEqual([
      'повідомлено наслідки', 'підтверджене джерело', 'повідомлення моніторингу',
      'аналітична оцінка, не тривога'
    ]);
  });
});
