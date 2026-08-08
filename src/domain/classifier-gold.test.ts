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
 * the catalogue's coverage, not the rules' — "Пара реактивних на Згурівку" is a correct report about
 * a settlement the catalogue does not contain. Counting those as classifier misses would blame the
 * regexes for a data problem and hide the real one, so they are reported separately below.
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
  predicted: { significant: boolean; threatType: string; locations: string[] };
}

const scored: Scored[] = fixture.messages.map((message) => {
  const classified = classifyMessage(message.text, fixture.catalogue);
  return {
    message,
    predicted: {
      significant: significanceRejection(classified) === null,
      threatType: classified.threatType,
      locations: classified.locations.map((location) => location.id).sort()
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
  // Floors, each pinned just under what `v3` measures on this corpus today (2026-08-08):
  //
  //   significance  P=97.2% (103/106)  R=88.8% (103/116)  F1=92.8%
  //   threat type   accuracy=100% over the 103 messages both sides call significant
  //   locations     P=R=89.4% (193 correct ids, 23 wrong, 23 missed)
  //
  // See the module comment before changing one.
  // ----------------------------------------------------------------------------------------------

  it('keeps significance precision at or above the v3 measurement', () => {
    expect(precision(significance)).toBeGreaterThanOrEqual(0.97);
  });

  it('keeps significance recall at or above the v3 measurement', () => {
    expect(recall(significance)).toBeGreaterThanOrEqual(0.88);
  });

  it('keeps threat-type accuracy at or above the v3 measurement', () => {
    // 100% today. The floor allows exactly one disagreement out of a hundred before it fails, which
    // is the tolerance for a genuinely hard message being added to the corpus — not for a rule
    // change that starts filing drones as missiles.
    expect(threatTypeAccuracy).toBeGreaterThanOrEqual(0.99);
  });

  it('keeps UAV precision and recall at or above the v3 measurement', () => {
    // The class that carries almost all of the traffic: losing it is losing the product.
    const uav = perClass.find((row) => row.threatType === 'uav')!;
    expect(recall(uav.counts)).toBeGreaterThanOrEqual(0.98);
    expect(precision(uav.counts)).toBeGreaterThanOrEqual(0.98);
  });

  it('keeps ballistic recall at or above the v3 measurement', () => {
    const ballistic = perClass.find((row) => row.threatType === 'ballistic_missile')!;
    expect(recall(ballistic.counts)).toBeGreaterThanOrEqual(0.98);
  });

  it('keeps location precision and recall at or above the v3 measurement', () => {
    expect(precision(locations)).toBeGreaterThanOrEqual(0.89);
    expect(recall(locations)).toBeGreaterThanOrEqual(0.89);
  });

  it('never publishes a threat the reviewer read as a withdrawal or as noise', () => {
    // The one class of error this project cannot trade away: a false alert teaches subscribers to
    // ignore the app, and an app that is ignored cannot warn anybody. The three that remain are a
    // settlement resolved to the wrong catalogue row ("на Обухівку" -> Обухів) and two retrospective
    // night summaries; the message text is in the failure so a fourth names itself.
    const falsePositives = scored
      .filter(({ message, predicted }) => predicted.significant && !message.gold.significant)
      .map(({ message }) => message.text.slice(0, 80));
    expect(falsePositives).toHaveLength(3);
  });

  it('reports the catalogue gap separately from the rules', () => {
    // Pinned so that a rule change cannot silently absorb a location-coverage problem, and so that
    // fixing the catalogue shows up here as this number falling.
    expect(catalogueGaps.length).toBeGreaterThan(0);
    for (const message of catalogueGaps) {
      expect(message.gold.outsideCatalogue.length, message.text).toBeGreaterThan(0);
    }
  });
});
