import type { ClassifiedMessage } from '../types.js';
import { significanceRejection } from './classifier.js';

/**
 * The regression harness for {@link ./classifier.ts}, as pure functions.
 *
 * `message_classifications` was designed to be a golden corpus — one row per decision, stamped with
 * the version of the rules that made it, unique on (message, version) so two versions can hold an
 * opinion about the same message at once. Nothing ever read it that way. Editing a regex meant
 * shipping and watching, and the archive that existed precisely to answer "what did that change do
 * to the last three months of traffic" answered nothing, because no code compared its rows.
 *
 * This module is the comparison. It is deliberately free of SQL and of the classifier's own
 * internals: it takes the stored verdict and the fresh one as data and says how they differ.
 * `scripts/classifier-replay.ts` supplies the rows; the tests supply fixtures. That split is what
 * lets the diff be tested without a database, which matters because a broken diff would report a
 * clean replay for a change that broke everything.
 *
 * ## What counts as a difference
 *
 * Three axes, because they are the three things downstream consumers act on:
 *
 *   * **class** — `threat_type`, the label under which an event is filed and the thing a subscriber
 *     sees. Includes the aggregate `combined`.
 *   * **locations** — the set of asserted location ids, compared as a set: order is an artefact of
 *     the resolution loop, not a decision.
 *   * **significance** — whether the message raises anything at all. This is the axis that matters
 *     most and is the easiest to move by accident: a new pattern that makes a previously ignored
 *     message significant is a new event on somebody's phone.
 *
 * Intent is folded into significance rather than reported separately: a change from `threat` to
 * `none` always shows up as a significance change, and a change between `threat` and `redirect`
 * changes no event that a reader would notice.
 */

/** One archived decision, as the replay script reads it out of `message_classifications`. */
export interface ArchivedVerdict {
  sourceMessageId: string;
  sourceId: string;
  text: string;
  classifierVersion: string;
  threatType: string | null;
  /** Asserted locations only. A retracted location is not a claim about where a threat is. */
  locationIds: string[];
  /** Whether the archived run raised or merged an event, i.e. whether it was significant. */
  significant: boolean;
}

/**
 * Whether an archived `decision` word means the message raised or sustained an event.
 *
 * Read off `decision` rather than off `created_event`, which is false for a message that merged into
 * an existing event — merging is still a significant message, and treating it as insignificant would
 * report a fake "newly significant" for every restatement in the corpus.
 *
 * `coalesced` counts for the same reason and is the more important of the two. A coalesced message
 * *was* significant; the burst window is why no second event was created for it. Excluding it did
 * not merely inflate `newlySignificant` — it made the opposite finding **invisible**: a coalesced
 * message that a new version stops recognising went from `false` to `false` and was reported as
 * unchanged, which is precisely the loss this whole tool exists to surface. Lives here rather than in
 * the script so it can be tested; a wrong answer here reports a clean replay for a change that
 * silenced part of the corpus.
 */
const SIGNIFICANT_DECISIONS: ReadonlySet<string> =
  new Set(['event_created', 'event_merged', 'redirect', 'coalesced']);

export function archivedWasSignificant(decision: string): boolean {
  return SIGNIFICANT_DECISIONS.has(decision);
}

export type DiffAxis = 'threat_type' | 'locations' | 'significance';

export interface VerdictDiff {
  sourceMessageId: string;
  sourceId: string;
  text: string;
  changed: DiffAxis[];
  before: { threatType: string | null; locationIds: string[]; significant: boolean };
  after: { threatType: string; locationIds: string[]; significant: boolean };
}

export interface ReplayReport {
  fromVersion: string[];
  toVersion: string;
  total: number;
  unchanged: number;
  changed: number;
  /** How many messages moved on each axis. A message can appear in more than one counter. */
  byAxis: Record<DiffAxis, number>;
  /**
   * The two directions of a significance change, kept apart because they are not equally serious.
   * `newlySignificant` is a new alert that nobody used to receive; `newlyIgnored` is an alert that
   * silently stopped arriving, which is the failure this project cannot afford.
   */
  newlySignificant: number;
  newlyIgnored: number;
  /** Class-to-class movements, as `"uav → combined"` counted. */
  threatTypeMoves: Array<{ from: string; to: string; count: number }>;
  /** Why the new run declined to raise anything, for the messages it now ignores. */
  rejectionReasons: Array<{ reason: string; count: number }>;
  examples: VerdictDiff[];
}

/**
 * The separator inside the `from → to` key of {@link ReplayReport.threatTypeMoves}.
 *
 * A control character rather than an arrow or a pipe because a threat type is a free-form string in
 * the archive and any printable separator could occur inside one, silently splitting a class name in
 * two. Written as an escape and never as a literal byte: a raw NUL in a source file makes git treat
 * the file as binary, which costs every diff, blame and merge on the module that has to stay
 * reviewable.
 */
const MOVE_KEY_SEPARATOR = '\u0000';

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((value) => seen.has(value));
}

/** The fresh verdict for one message, reduced to the three axes the diff compares. */
export function projectClassification(classified: ClassifiedMessage): {
  threatType: string; locationIds: string[]; significant: boolean; rejection: string | null;
} {
  const rejection = significanceRejection(classified);
  return {
    threatType: classified.threatType,
    locationIds: classified.locations.map((location) => location.id).sort(),
    significant: rejection === null,
    rejection
  };
}

/** Compares one archived verdict with one fresh classification. `null` when nothing moved. */
export function diffVerdict(archived: ArchivedVerdict, fresh: ClassifiedMessage): VerdictDiff | null {
  const after = projectClassification(fresh);
  const before = {
    threatType: archived.threatType,
    locationIds: [...archived.locationIds].sort(),
    significant: archived.significant
  };
  const changed: DiffAxis[] = [];
  // A stored `null` class and a fresh `unknown` are the same statement — the archive writes NULL for
  // a decision that filed the message under no class — so they must not read as a difference.
  if ((before.threatType ?? 'unknown') !== after.threatType) changed.push('threat_type');
  if (!sameSet(before.locationIds, after.locationIds)) changed.push('locations');
  if (before.significant !== after.significant) changed.push('significance');
  if (!changed.length) return null;
  return {
    sourceMessageId: archived.sourceMessageId,
    sourceId: archived.sourceId,
    text: archived.text,
    changed,
    before,
    after: { threatType: after.threatType, locationIds: after.locationIds, significant: after.significant }
  };
}

export interface ReplayInput {
  archived: ArchivedVerdict;
  fresh: ClassifiedMessage;
}

/**
 * The whole replay, summarised.
 *
 * `exampleLimit` caps what is *kept*, not what is counted: a replay over a hundred thousand messages
 * has to report exact totals and a readable handful of cases, and holding every diff in memory to
 * print twenty of them is how a maintenance tool becomes the reason the box ran out of RAM.
 * Examples are taken in arrival order, which for a query ordered by `published_at DESC` means the
 * most recent — the traffic whose shape the operator still remembers.
 */
export function replayReport(inputs: ReplayInput[], toVersion: string, exampleLimit = 20): ReplayReport {
  const byAxis: Record<DiffAxis, number> = { threat_type: 0, locations: 0, significance: 0 };
  const moves = new Map<string, number>();
  const reasons = new Map<string, number>();
  const versions = new Set<string>();
  const examples: VerdictDiff[] = [];
  let changed = 0;
  let newlySignificant = 0;
  let newlyIgnored = 0;

  for (const { archived, fresh } of inputs) {
    versions.add(archived.classifierVersion);
    const diff = diffVerdict(archived, fresh);
    if (!diff) continue;
    changed += 1;
    for (const axis of diff.changed) byAxis[axis] += 1;
    if (diff.changed.includes('threat_type')) {
      const key = `${diff.before.threatType ?? 'unknown'}${MOVE_KEY_SEPARATOR}${diff.after.threatType}`;
      moves.set(key, (moves.get(key) ?? 0) + 1);
    }
    if (diff.changed.includes('significance')) {
      if (diff.after.significant) newlySignificant += 1;
      else {
        newlyIgnored += 1;
        const reason = projectClassification(fresh).rejection ?? 'unknown';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    if (examples.length < exampleLimit) examples.push(diff);
  }

  const descending = <T extends { count: number }>(rows: T[]) => rows.sort((a, b) => b.count - a.count);
  return {
    fromVersion: [...versions].sort(),
    toVersion,
    total: inputs.length,
    unchanged: inputs.length - changed,
    changed,
    byAxis,
    newlySignificant,
    newlyIgnored,
    threatTypeMoves: descending([...moves].map(([key, count]) => {
      const [from = 'unknown', to = 'unknown'] = key.split(MOVE_KEY_SEPARATOR);
      return { from, to, count };
    })),
    rejectionReasons: descending([...reasons].map(([reason, count]) => ({ reason, count }))),
    examples
  };
}

/** The report as the lines the CLI prints. Separated so the formatting is testable too. */
export function formatReplayReport(report: ReplayReport): string {
  const percent = (value: number) => report.total ? `${((value / report.total) * 100).toFixed(1)}%` : '—';
  const lines = [
    `Класифікатор: ${report.fromVersion.join(', ') || '—'} → ${report.toVersion}`,
    `Повідомлень у вибірці: ${report.total}`,
    `Без змін: ${report.unchanged} (${percent(report.unchanged)})`,
    `Змінилися: ${report.changed} (${percent(report.changed)})`,
    `  клас загрози: ${report.byAxis.threat_type}`,
    `  локації: ${report.byAxis.locations}`,
    `  значущість: ${report.byAxis.significance}`,
    `    стали значущими (нові події): ${report.newlySignificant}`,
    `    перестали бути значущими (втрачені події): ${report.newlyIgnored}`
  ];
  if (report.threatTypeMoves.length) {
    lines.push('', 'Переходи між класами:');
    for (const move of report.threatTypeMoves) lines.push(`  ${move.from} → ${move.to}: ${move.count}`);
  }
  if (report.rejectionReasons.length) {
    lines.push('', 'Чому нова версія нічого не піднімає:');
    for (const row of report.rejectionReasons) lines.push(`  ${row.reason}: ${row.count}`);
  }
  if (report.examples.length) {
    lines.push('', `Приклади (${report.examples.length}):`);
    for (const example of report.examples) {
      lines.push(
        '',
        `  [${example.sourceId}] ${example.text.replace(/\s+/gu, ' ').slice(0, 200)}`,
        `    змінилося: ${example.changed.join(', ')}`,
        `    було: ${example.before.threatType ?? 'unknown'} | ${example.before.locationIds.join(', ') || 'без локацій'} | ${example.before.significant ? 'значуще' : 'проігноровано'}`,
        `    стало: ${example.after.threatType} | ${example.after.locationIds.join(', ') || 'без локацій'} | ${example.after.significant ? 'значуще' : 'проігноровано'}`
      );
    }
  }
  return lines.join('\n');
}
