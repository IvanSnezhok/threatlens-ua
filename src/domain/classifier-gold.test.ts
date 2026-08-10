import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyMessage, significanceRejection, type LocationLexeme } from './classifier.js';

/**
 * Precision and recall of the deterministic classifier against a hand-labelled corpus.
 *
 * ## Why a fixture and not the model
 *
 * The shadow classifier produces agreement, and agreement with a model is not accuracy: two readers
 * can be wrong together, and the model has never seen the operational conventions these channels
 * write in. The only thing that can say whether a rule change made the classifier better is a set of
 * messages somebody read and labelled by hand. `tests/fixtures/classifier-gold.json` is that set —
 * 191 real messages pulled from the production archive, each one read and labelled by a reviewer,
 * with the labelling date, method and conventions recorded in the file's own header.
 *
 * ## What the numbers mean, and why the thresholds are floors
 *
 * The assertions below are **minimums pinned at the values this classifier actually achieves**, not
 * targets. They exist so that a future edit which quietly loses recall fails here instead of failing
 * on somebody's phone at three in the morning. Raising a floor after an improvement is expected;
 * lowering one is a decision that has to be argued for in a review, which is the whole point.
 *
 * Three axes, matching the three the replay diff compares:
 *
 *   * **significance** — binary, over every sampled message. The axis that decides whether anybody
 *     is told anything at all.
 *   * **threat type** — over the messages both sides agree are significant. A class is only ever
 *     read by a subscriber for a message that became an event, so scoring it on messages that raise
 *     nothing would measure something nobody sees.
 *   * **locations** — micro-averaged over the id sets of messages significant on either side, which
 *     is exactly the set whose locations reach a map.
 *
 * ## The gap the fixture keeps separate
 *
 * `gold.assertsThreat` is the reviewer's reading of the text; `gold.significant` additionally
 * requires that the place named exists in the location catalogue. The difference between the two is
 * the catalogue's coverage, not the rules' — "Пара реактивних на Згурівку" was a correct report
 * about a settlement the catalogue did not contain. Counting those as classifier misses would blame
 * the regexes for a data problem and hide the real one, so they are reported separately below.
 *
 * Migration 024 closed twenty of the twenty-one, which is why the corpus's own labels moved with it:
 * a place that is now in the catalogue belongs in `gold.locations`, not in `outsideCatalogue`, and
 * the message that names it is now `significant`. The header records both the move and the two
 * label corrections it turned up, so the fixture still says exactly where each number came from.
 *
 * ## What is deliberately not in this file
 *
 * The corpus is a labelled sample of a specific archive snapshot: every entry carries a real
 * `sourceMessageId` and the decision the archive actually recorded for it, and the header pins the
 * window, the sample size and the distribution those entries produce. A synthetic message has
 * neither an id nor an archived decision, so inventing an `archived` block for one would be putting
 * fabricated history into the file whose only value is that its history is real. The two `v6`
 * false-positive reproductions — «Кабмін ухвалив постанову про виплати для Харківщини» and «Кабінет
 * Міністрів затвердив бюджет для Одещини» — are therefore pinned in `classifier.test.ts` instead,
 * beside the verbatim archived message that reproduces the same defect with a real id.
 *
 * ## `v5` changed no label in this file
 *
 * The retrospective veto is measured entirely against labels the reviewer wrote in 2026-08-08, when
 * `v2` was the current version and nothing in the rules read tense at all. The two messages it
 * refuses were already marked `significant: false` with the notes «нічний підсумок, ретроспектива»
 * and «ретроспективний підсумок» — the corpus had been saying the classifier was wrong about them
 * for two versions. Nothing was relabelled to make the numbers move, which is what makes the move
 * evidence of anything.
 */

interface GoldMessage {
  sourceMessageId: string;
  sourceId: string;
  text: string;
  gold: {
    assertsThreat: boolean;
    significant: boolean;
    threatType: string;
    locations: string[];
    outsideCatalogue: string[];
  };
  archived: { classifierVersion: string; decision: string; threatType: string | null; locations: string[] };
}

interface GoldFixture {
  header: Record<string, unknown>;
  catalogue: LocationLexeme[];
  messages: GoldMessage[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/classifier-gold.json', import.meta.url), 'utf8')
) as GoldFixture;

interface Scored {
  message: GoldMessage;
  predicted: {
    significant: boolean;
    threatType: string;
    locations: string[];
    /** Which of the four conditions the message failed, so a refusal can be scored on its reason. */
    rejection: string | null;
  };
}

const scored: Scored[] = fixture.messages.map((message) => {
  const classified = classifyMessage(message.text, fixture.catalogue);
  const rejection = significanceRejection(classified);
  return {
    message,
    predicted: {
      significant: rejection === null,
      threatType: classified.threatType,
      locations: classified.locations.map((location) => location.id).sort(),
      rejection
    }
  };
});

interface Counts { truePositives: number; falsePositives: number; falseNegatives: number }

const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 1 : numerator / denominator);
const precision = (counts: Counts) => ratio(counts.truePositives, counts.truePositives + counts.falsePositives);
const recall = (counts: Counts) => ratio(counts.truePositives, counts.truePositives + counts.falseNegatives);
const f1 = (counts: Counts) => {
  const [p, r] = [precision(counts), recall(counts)];
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
};
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const significance: Counts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
for (const { message, predicted } of scored) {
  if (predicted.significant && message.gold.significant) significance.truePositives += 1;
  else if (predicted.significant) significance.falsePositives += 1;
  else if (message.gold.significant) significance.falseNegatives += 1;
}

const agreedSignificant = scored.filter(({ message, predicted }) => message.gold.significant && predicted.significant);
const threatTypeHits = agreedSignificant.filter(({ message, predicted }) => message.gold.threatType === predicted.threatType);
const threatTypeAccuracy = ratio(threatTypeHits.length, agreedSignificant.length);

/** Per-class precision/recall for the threat type, over the same agreed-significant subset. */
const threatTypeClasses = [...new Set(agreedSignificant.flatMap(({ message, predicted }) =>
  [message.gold.threatType, predicted.threatType]))].sort();
const perClass = threatTypeClasses.map((threatType) => {
  const counts: Counts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
  for (const { message, predicted } of agreedSignificant) {
    const isGold = message.gold.threatType === threatType;
    const isPredicted = predicted.threatType === threatType;
    if (isGold && isPredicted) counts.truePositives += 1;
    else if (isPredicted) counts.falsePositives += 1;
    else if (isGold) counts.falseNegatives += 1;
  }
  return { threatType, counts };
});

const locationScope = scored.filter(({ message, predicted }) => message.gold.significant || predicted.significant);
const locations: Counts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
for (const { message, predicted } of locationScope) {
  const gold = new Set(message.gold.locations);
  const guessed = new Set(predicted.locations);
  for (const id of guessed) {
    if (gold.has(id)) locations.truePositives += 1;
    else locations.falsePositives += 1;
  }
  for (const id of gold) if (!guessed.has(id)) locations.falseNegatives += 1;
}

/** Messages the reviewer read as real threats that no rule change can rescue: the place is missing. */
const catalogueGaps = fixture.messages.filter((message) =>
  message.gold.assertsThreat && !message.gold.significant && message.gold.outsideCatalogue.length > 0);

const summary = [
  '',
  `gold corpus: ${fixture.messages.length} повідомлень, ${fixture.catalogue.length} рядків каталогу`,
  `significance  P=${percent(precision(significance))} R=${percent(recall(significance))} F1=${percent(f1(significance))}`
    + `  (TP=${significance.truePositives} FP=${significance.falsePositives} FN=${significance.falseNegatives})`,
  `threat type   accuracy=${percent(threatTypeAccuracy)} на ${agreedSignificant.length} спільно значущих`,
  ...perClass.map(({ threatType, counts }) =>
    `  ${threatType.padEnd(18)} P=${percent(precision(counts))} R=${percent(recall(counts))}`
    + ` (TP=${counts.truePositives} FP=${counts.falsePositives} FN=${counts.falseNegatives})`),
  `locations     P=${percent(precision(locations))} R=${percent(recall(locations))}`
    + `  (TP=${locations.truePositives} FP=${locations.falsePositives} FN=${locations.falseNegatives})`,
  `catalogue gaps: ${catalogueGaps.length} повідомлень стверджують загрозу для місця, якого немає в каталозі`,
  ''
].join('\n');

describe('classifier against the hand-labelled gold corpus', () => {
  it('prints the measured quality', () => {
    // Not an assertion: the numbers are what a reviewer needs in the run log when a floor below
    // moves, and recomputing them by hand from a failure message is how a floor gets lowered
    // without anybody looking at what moved.
    console.log(summary);
    expect(fixture.messages.length).toBeGreaterThanOrEqual(100);
  });

  // ----------------------------------------------------------------------------------------------
  // Floors, each pinned just under what `v5` measures on this corpus today (2026-08-09):
  //
  //   significance  P=100.0% (123/123)  R=90.4% (123/136)  F1=95.0%
  //   threat type   accuracy=100% over the 123 messages both sides call significant
  //   locations     P=99.6% (242 correct ids, 1 wrong)  R=93.1% (18 missed)
  //
  // `v4` measured P=98.4% R=90.4% F1=94.3% on significance and P=97.2% R=93.1% on locations, and
  // `v3` before it P=97.2% R=88.8% and P=R=89.4%. What moved between `v4` and `v5` is precision
  // alone, and only through the two false positives `v4` left: both were retrospective night
  // summaries — the Air Force's 09:00 tally and a strategic-aviation after-action write-up — and the
  // retrospective veto refuses both. Six of the seven wrong location ids went with them, because a
  // vetoed message asserts no locations at all.
  //
  // Recall did not move, and must not have: the veto is only allowed to subtract from what `v4`
  // published, so a recall floor that rose here would be evidence of a bug rather than of an
  // improvement. The thirteen misses are unchanged and are still vocabulary the rules do not read.
  //
  // `v6` measures identically — P=100.0% / R=90.4% / F1=95.0% on significance, 100.0% threat-class
  // accuracy over the same 123 messages, locations P=99.6% / R=93.1% — and no floor moves. That is
  // the expected result rather than a disappointing one: the two `guided_air_bomb` entries in this
  // corpus are «Пуск КАБ» and «🚀 КАБи на Запоріжжі», both real weapon forms that must keep their
  // class, and the words `v6` stops matching («Кабмін», «кабельні», «декабре») are not in the
  // sample at all. The corpus's job here is to prove the narrowing cost nothing; the false positive
  // it closed is pinned in `classifier.test.ts`, which is where a message that is not in this
  // snapshot belongs.
  //
  // See the module comment before changing one.
  // ----------------------------------------------------------------------------------------------

  it('keeps significance precision at or above the v5 measurement', () => {
    // 100% today, floored at 99%: the corpus is 123 predicted-significant messages, so this fails on
    // the second false positive and tolerates the first. The zero itself is pinned exactly by the
    // false-positive test below, which prints the offending text — a bare precision floor cannot.
    expect(precision(significance)).toBeGreaterThanOrEqual(0.99);
  });

  it('keeps significance recall at or above the v4 measurement', () => {
    // Deliberately still the `v4` floor. The retrospective veto can only remove significance, so the
    // question this asks is "did it remove any of the messages the reviewer said were real", and the
    // answer has to stay no.
    expect(recall(significance)).toBeGreaterThanOrEqual(0.90);
  });

  it('keeps threat-type accuracy at or above the v4 measurement', () => {
    // 100% today. The floor allows exactly one disagreement out of a hundred before it fails, which
    // is the tolerance for a genuinely hard message being added to the corpus — not for a rule
    // change that starts filing drones as missiles.
    expect(threatTypeAccuracy).toBeGreaterThanOrEqual(0.99);
  });

  it('keeps UAV precision and recall at or above the v4 measurement', () => {
    // The class that carries almost all of the traffic: losing it is losing the product.
    const uav = perClass.find((row) => row.threatType === 'uav')!;
    expect(recall(uav.counts)).toBeGreaterThanOrEqual(0.98);
    expect(precision(uav.counts)).toBeGreaterThanOrEqual(0.98);
  });

  it('keeps ballistic recall at or above the v4 measurement', () => {
    const ballistic = perClass.find((row) => row.threatType === 'ballistic_missile')!;
    expect(recall(ballistic.counts)).toBeGreaterThanOrEqual(0.98);
  });

  it('keeps location precision and recall at or above the v5 measurement', () => {
    // The axis `v4` existed for, raised again by `v5`: 0.89/0.89 in `v3`, 0.97/0.93 in `v4`, and
    // 0.996/0.931 now that the two vetoed summaries no longer assert the six places they named.
    expect(precision(locations)).toBeGreaterThanOrEqual(0.99);
    expect(recall(locations)).toBeGreaterThanOrEqual(0.93);
  });

  it('never publishes a threat the reviewer read as a withdrawal or as noise', () => {
    // The one class of error this project cannot trade away: a false alert teaches subscribers to
    // ignore the app, and an app that is ignored cannot warn anybody. `v3` left three, `v4` closed
    // the settlement resolved to the wrong catalogue row ("на Обухівку" -> Обухів) and left two
    // retrospective night summaries, and `v5`'s retrospective veto closes both of those.
    //
    // Zero, exactly. The message text is in the failure, so the day a rule change reintroduces one
    // the corpus names it rather than reporting a number.
    const falsePositives = scored
      .filter(({ message, predicted }) => predicted.significant && !message.gold.significant)
      .map(({ message }) => message.text.slice(0, 80));
    expect(falsePositives).toEqual([]);
  });

  it('refuses the two retrospective summaries as retrospective, and for no other reason', () => {
    // The specific claim `v5` makes about this corpus, pinned separately from the aggregate above.
    // A veto that fired for the *wrong* reason — a rule that happens to drop the same two messages
    // through the location logic, say — would satisfy the precision floor and silently be a
    // different change.
    const vetoed = scored
      .filter(({ predicted }) => predicted.rejection === 'retrospective')
      .map(({ message }) => message.sourceId);
    expect(vetoed.sort()).toEqual(['air-force', 'osint-strategic-aviation']);
  });

  it('reports the catalogue gap separately from the rules', () => {
    // Pinned so that a rule change cannot silently absorb a location-coverage problem, and so that
    // fixing the catalogue shows up here as this number falling. It has: migration 024 took it from
    // 21 messages to 1, and the one left names Чернігівщина as "Че", which is a shorthand and not a
    // missing row.
    expect(catalogueGaps.length).toBeGreaterThan(0);
    expect(catalogueGaps.length).toBeLessThanOrEqual(1);
    for (const message of catalogueGaps) {
      expect(message.gold.outsideCatalogue.length, message.text).toBeGreaterThan(0);
    }
  });
});
