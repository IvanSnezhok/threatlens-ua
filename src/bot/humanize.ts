import { config } from '../config.js';

/**
 * Human-facing wording for everything the bot prints.
 *
 * ## Why this lives outside both bot surfaces
 *
 * Telegram has two independent writers: the outbox worker, which pushes alerts and threats, and the
 * command handlers in `bot.ts`, which answer `/status` and `/analytics`. Both read the same database
 * rows, and both used to print those rows verbatim — an `evidence_level` of `confirmed`, a
 * `valid_until` serialised as `2026-08-08T00:38:46.000Z`. A person under an air raid then has to
 * translate an English enum and convert UTC in their head before they learn anything. Keeping the
 * vocabulary in one module is what stops the two surfaces from drifting into two different dialects.
 *
 * ## Why times are formatted, never passed through
 *
 * Every timestamp that reaches a reader goes through `humanMoment`. The database stores `timestamptz`
 * and `JSON.stringify` on an outbox payload turns it into an ISO string, so "just interpolate it" is
 * always available and always wrong. Kyiv time is the only clock the audience reads.
 */

// `APP_TIMEZONE` defaults to Europe/Kyiv and exists so a deployment serving another jurisdiction can
// move the whole product to its own clock at once, rather than having each message pick its own.
const timeZone = config.APP_TIMEZONE;

const clockFormat = new Intl.DateTimeFormat('uk-UA', {
  timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const dayFormat = new Intl.DateTimeFormat('uk-UA', { timeZone, day: 'numeric', month: 'long' });
// Calendar-day identity is compared on an ISO-ordered rendering rather than on `Date` fields, because
// `getDate()` answers in the *server's* zone: a container running UTC would call 01:30 Kyiv "yesterday"
// and stamp a date on a time that is happening right now.
const calendarDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
});

export const threatLabels: Record<string, string> = {
  uav: 'ударні БпЛА', ballistic_missile: 'балістичні ракети',
  cruise_missile: 'крилаті ракети', guided_air_bomb: 'керовані авіаційні бомби',
  aviation: 'активність авіації', mlrs: 'РСЗВ', artillery: 'артилерія',
  mortar: 'мінометний обстріл', combined: 'комбінована загроза', unknown: 'невизначена загроза'
};

export const levelLabels: Record<string, string> = {
  background: 'фоновий', elevated: 'підвищений', significant: 'значний',
  high: 'високий', very_high: 'дуже високий'
};

/**
 * The four values of `threat_events.evidence_level` (migration 001), spelled out as a claim about
 * how much the reader should trust the message. The enum name alone invites the wrong reading:
 * "confirmed" sounds like the strike is confirmed, when it only means two independent publishers
 * said the same thing, and "unverified" sounds like a denial rather than "nobody has checked yet".
 */
export const evidenceStatements: Record<string, string> = {
  official: 'Офіційне повідомлення',
  confirmed: 'Підтверджено кількома джерелами',
  monitoring: 'Повідомляють моніторингові канали, підтвердження неповне',
  unverified: 'Непідтверджене повідомлення — поставтеся обережно'
};

/** The same four levels as a *filter threshold*, which is a different sentence: it describes what a
 *  subscription lets through, not what a single message is worth. */
export const evidenceThresholdLabels: Record<string, string> = {
  official: 'лише офіційні', confirmed: 'підтверджені+', monitoring: 'моніторинг+', unverified: 'усі згадки'
};

/** `risk_assessments.assessment_confidence` — low | medium | high (migration 001). */
export const confidenceLabels: Record<string, string> = {
  low: 'низька', medium: 'середня', high: 'висока'
};

export function threatLabel(value: unknown): string {
  const key = String(value ?? '');
  return threatLabels[key] ?? key;
}

export function levelLabel(value: unknown): string {
  const key = String(value ?? '');
  return levelLabels[key] ?? key;
}

export function evidenceStatement(value: unknown): string {
  const key = String(value ?? '');
  return evidenceStatements[key] ?? 'Джерело повідомлення не класифіковане';
}

export function confidenceLabel(value: unknown): string {
  const key = String(value ?? '');
  return confidenceLabels[key] ?? key;
}

/**
 * Accepts whatever a payload happens to carry — a `Date` from a direct query, an ISO string after the
 * payload made a round trip through `jsonb`, epoch millis, or junk — and returns a usable date or
 * nothing. Returning `null` rather than throwing is deliberate: a missing or malformed timestamp must
 * cost the reader one line of detail, never the whole warning.
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** «03:38» for today, «8 серпня о 03:38» otherwise — a bare time on another day reads as *this* day. */
export function humanMoment(value: unknown, now: Date = new Date()): string | null {
  const date = toDate(value);
  if (!date) return null;
  const time = clockFormat.format(date);
  if (calendarDayFormat.format(date) === calendarDayFormat.format(now)) return time;
  return `${dayFormat.format(date)} о ${time}`;
}

/**
 * «ще ~25 хв» — how much of the window is left. Approximate on purpose: the underlying `valid_until`
 * is an expiry the pipeline assigns, not a measured end of danger, and a minute-exact countdown would
 * claim a precision the data does not have.
 */
export function humanCountdown(value: unknown, now: Date = new Date()): string | null {
  const date = toDate(value);
  if (!date) return null;
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `ще ~${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `ще ~${hours} год ${rest} хв` : `ще ~${hours} год`;
}

/** «Актуально до 03:38 (ще ~25 хв)», or the past-tense form once the window has closed. */
export function validUntilLine(value: unknown, now: Date = new Date()): string | null {
  const moment = humanMoment(value, now);
  if (!moment) return null;
  const countdown = humanCountdown(value, now);
  return countdown ? `Актуально до ${moment} (${countdown})` : `Орієнтир діяв до ${moment}`;
}

// A leading run of emoji, bullets and dashes is how monitoring channels open almost every post. The
// bot already prints its own status emoji, so keeping theirs produces "⚠️ Київ … ⚠️Загроза".
// Written as an alternation rather than one character class on purpose: an emoji is a sequence
// (base + variation selector, or two bases joined by a zero-width joiner), and a class would match
// its halves independently and could cut a sequence in the middle.
const leadingDecoration = /^(?:\p{Extended_Pictographic}|\p{So}|️|‍|[\s•·*|>\-–—])+/u;

/**
 * Source summaries arrive exactly as a channel typed them: trailing "..", doubled emoji, ragged
 * spacing from a phone keyboard. The cleanup is deliberately gentle — spacing, punctuation runs and
 * decoration only. Rewriting the wording would turn a quoted source into our own claim about what is
 * flying, which is the one thing an evidence-first system must not do.
 */
export function cleanSummary(value: unknown): string {
  const raw = String(value ?? '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim());
  // Collapse runs of blank lines: channels pad posts to push the important line above the fold.
  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line && (!collapsed.length || !collapsed[collapsed.length - 1])) continue;
    collapsed.push(line);
  }
  while (collapsed.length && !collapsed[collapsed.length - 1]) collapsed.pop();
  return collapsed
    .join('\n')
    .replace(leadingDecoration, '')
    // Three dots or more is an ellipsis and carries meaning; exactly two is a typo for a full stop.
    .replace(/\.{3,}/g, '…')
    .replace(/\.{2}/g, '.')
    .replace(/([!?])\1+/g, '$1')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .trim();
}
