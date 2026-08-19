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
//
// Memoised on the zone rather than built at module load, which is what keeps the key `hot` in
// `APP_SETTINGS`. The three formatters were constants here, so an operator changing the timezone
// from /ops would have moved every other surface (the digest, the analytics, `/api/v1/config`) and
// left the bot's own messages on the old clock until a restart — a one-line difference nobody would
// look for. Rebuilt only when the zone actually changes, so the steady state is one string compare
// per formatted timestamp and not three `Intl.DateTimeFormat` constructions.
let formatters: {
  zone: string;
  clock: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  // Calendar-day identity is compared on an ISO-ordered rendering rather than on `Date` fields,
  // because `getDate()` answers in the *server's* zone: a container running UTC would call 01:30
  // Kyiv "yesterday" and stamp a date on a time that is happening right now.
  calendarDay: Intl.DateTimeFormat;
} | null = null;

function zoned() {
  const timeZone = config.APP_TIMEZONE;
  if (!formatters || formatters.zone !== timeZone) {
    formatters = {
      zone: timeZone,
      clock: new Intl.DateTimeFormat('uk-UA', {
        timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }),
      day: new Intl.DateTimeFormat('uk-UA', { timeZone, day: 'numeric', month: 'long' }),
      calendarDay: new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
      })
    };
  }
  return formatters;
}

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
  unverified: 'Непідтверджене повідомлення — поставтеся до нього обережно'
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
  // Never echoes the unknown key back: an enum the dictionary has not learned yet would reach the
  // reader as the English word this whole module exists to keep out of the message.
  return evidenceStatements[key] ?? 'Рівень доказовості не визначено';
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

/**
 * «03:38» for today, «8 серпня о 03:38» otherwise — a bare time on another day reads as *this* day.
 *
 * The year is spelled out only when it differs from the current one. It almost never does for a live
 * warning, but `/status` will happily show a stale `valid_until`, and "8 серпня" for a timestamp from
 * last year is the same lie the bare time tells about the day.
 */
export function humanMoment(value: unknown, now: Date = new Date()): string | null {
  const date = toDate(value);
  if (!date) return null;
  const format = zoned();
  const time = format.clock.format(date);
  const day = format.calendarDay.format(date);
  const today = format.calendarDay.format(now);
  if (day === today) return time;
  const year = day.slice(0, 4) === today.slice(0, 4) ? '' : ` ${day.slice(0, 4)} року`;
  return `${format.day.format(date)}${year} о ${time}`;
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

// ------------------------------------------------------------------------------------------------
// Actuality and probability (migration 049)
// ------------------------------------------------------------------------------------------------
//
// Очікувана загроза — те, що джерело сказало про найближчі години, а не про зараз. Вона йде іншим
// маркером, іншим заголовком і без заклику в укриття; ймовірність — оцінка моделі, і підписана як
// оцінка, не як факт. Для події правил (`timing: 'now'`, `probability: null`) усі три функції
// нижче мовчать, і повідомлення лишається точно таким, яким було завжди.

const TIMING_BADGES: Record<string, string> = {
  within_hour: 'очікується протягом години',
  evening: 'очікується увечері',
  within_day: 'очікується протягом доби',
  within_two_days: 'очікується протягом двох діб'
};

export function isExpectedTiming(value: unknown): value is keyof typeof TIMING_BADGES {
  return typeof value === 'string' && value in TIMING_BADGES;
}

export function timingBadge(value: unknown): string {
  return isExpectedTiming(value) ? TIMING_BADGES[value]! : '';
}

/** «Оцінка ймовірності моделлю: ≈60 %» — або нічого, коли ймовірності немає (подія правил). */
export function probabilityLine(value: unknown): string | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return `Оцінка ймовірності моделлю: ≈${Math.round(number * 100)} %`;
}

/** «Вікно: з 18:00 до 23:59» / «Вікно: до 06:40 (ще ~5 год)». */
export function expectedWindowLine(from: unknown, until: unknown, now: Date = new Date()): string | null {
  const untilMoment = humanMoment(until, now);
  if (!untilMoment) return null;
  const fromDate = toDate(from);
  const fromMoment = fromDate && fromDate.getTime() > now.getTime() ? humanMoment(from, now) : null;
  const countdown = humanCountdown(until, now);
  return fromMoment
    ? `Вікно: з ${fromMoment} до ${untilMoment}`
    : `Вікно: до ${untilMoment}${countdown ? ` (${countdown})` : ''}`;
}

// ------------------------------------------------------------------------------------------------
// Update lines
// ------------------------------------------------------------------------------------------------

/**
 * Wording for a message that follows an earlier one about the same thing.
 *
 * A second message about a standing threat is not a second warning: the reader already knows there
 * are Shaheds over the oblast. The only reason to interrupt them again is that something moved, so
 * every line below states exactly the thing that moved and nothing else. Restating the warning is
 * what turns a monitoring feed into noise a person mutes — and a muted bot warns nobody.
 *
 * Like everything else in this module the output is plain text; escaping belongs to the caller.
 */

/**
 * Lowercases the first letter so a full-sentence phrase can be pasted after a dash.
 *
 * The evidence dictionary above is written as standalone statements («Підтверджено кількома
 * джерелами») because that is how a first message shows it. Inside «Доказовість підвищено — …» the
 * same phrase is a subordinate clause, and a capital there reads like two sentences welded together.
 */
function asClause(phrase: string): string {
  return phrase ? phrase[0]!.toLowerCase() + phrase.slice(1) : phrase;
}

/** «⏱ Загрозу продовжено до 05:10 (ще ~35 хв)» — the whole content of a soft update. */
export function extensionLine(value: unknown, now: Date = new Date()): string | null {
  const moment = humanMoment(value, now);
  if (!moment) return null;
  const countdown = humanCountdown(value, now);
  return `⏱ Загрозу продовжено до ${moment}${countdown ? ` (${countdown})` : ''}`;
}

/** «⬆️ Доказовість підвищено — підтверджено кількома джерелами». */
export function evidenceRaisedLine(value: unknown): string {
  return `⬆️ Доказовість підвищено — ${asClause(evidenceStatement(value))}`;
}

/** «🔀 Характер загрози уточнено: ударні БпЛА → крилаті ракети». */
export function threatTypeChangedLine(previous: unknown, next: unknown): string {
  return `🔀 Характер загрози уточнено: ${threatLabel(previous)} → ${threatLabel(next)}`;
}

/**
 * «📍 Оновлено перелік напрямків: Київська область, Біла Церква».
 *
 * The label is the threat's *whole* current geography, not just the additions: a person who reads
 * only this line must end up with the same picture as one who received the first message.
 */
export function geographyChangedLine(locationLabel: string): string {
  return `📍 Оновлено перелік напрямків: ${locationLabel}`;
}

/** «🔽 Рівень знижено: значний → підвищений» / «⬆️ Рівень підвищено: …». */
export function riskLevelChangedLine(previous: unknown, next: unknown, direction: 'up' | 'down'): string {
  const movement = direction === 'up' ? '⬆️ Рівень підвищено' : '🔽 Рівень знижено';
  return `${movement}: ${levelLabel(previous)} → ${levelLabel(next)}`;
}

// ------------------------------------------------------------------------------------------------
// The public channel (model analysis)
// ------------------------------------------------------------------------------------------------

/**
 * Wording for the one thing the project's own Telegram channel publishes: an unverified estimate a
 * model produced from a message the deterministic rules refused (`threat_events.origin='model'`,
 * migration 041, promoted by `promoteAnalyticalThreat` in `src/services/shadow-classifier.ts`).
 *
 * ## Why this is a different voice and not a re-used one
 *
 * Every other message in this file is addressed to somebody who ASKED for it: a subscriber picked a
 * territory, a threat type and an evidence threshold, and the wording can assume that context. A
 * channel post is read by whoever happens to see it — forwarded, screenshotted, quoted without the
 * line above it. So the disclaimer is not a footnote here, it is the first line: whatever survives
 * the forward has to carry «це не тривога» with it.
 *
 * ## Why the format has to LOOK different from an alert, not merely say so
 *
 * `CONTEXT.md` puts official signals above analysis, and the way a reader applies that ordering at
 * 03:00 is by shape, not by reading. An official alert opens with 🔴 and a bold «Повітряна тривога —
 * <місце>»; a threat warning opens with ⚠️. Neither marker may appear here, and the heading is
 * deliberately NOT «<місце> — <загроза>»: a post that shares its silhouette with an alert is a post
 * that gets read as one, and the disclaimer underneath does not undo that.
 *
 * ## What is deliberately absent
 *
 * The model's own confidence, although the promotion path has it (`ANALYTICAL_THREAT_MIN_CONFIDENCE`
 * gates on it and `analytical_outcomes` records it). A self-reported 0.93 printed next to a place
 * name reads as «93% що прилетить», which is not what it means and not something this system can
 * claim; the same argument `indicativePercent` carries the word «індикативний» for. It stays in
 * `/ops`, where the audience knows what it is measuring.
 *
 * Like everything else in this module the output is plain text; escaping belongs to the caller —
 * here `formatMessage` in `src/bot/outbox.ts`, which is also where the HTML layout lives.
 */
export const MODEL_CHANNEL_DISCLAIMER =
  'Оцінка моделі. Не підтверджено джерелом. Не є офіційною тривогою.';

/** «Аналітична оцінка · ударні БпЛА» — the class of threat, never the place, on the heading line. */
export function modelAnalysisHeading(threatType: unknown): string {
  return `Аналітична оцінка · ${threatLabel(threatType)}`;
}

/**
 * What the reader should do, which is nothing.
 *
 * The subscriber-facing threat message says «перейдіть до укриття», because it is built from a
 * source a human wrote. This one must not: acting on a model guess is the behaviour that makes the
 * next real warning ignorable, and naming the official signal as the trigger is the only way to say
 * so without also implying that the estimate is worthless.
 */
export const MODEL_CHANNEL_ACTION =
  'Дій за цією оцінкою вживати не потрібно. Підстава для укриття — офіційне сповіщення про '
  + 'тривогу та сирена.';

/**
 * What the channel is, stated in the channel itself.
 *
 * A reader who finds a channel that posts about air threats will assume it warns them; a channel
 * that only ever carries model estimates and never an official alert or an all-clear has to say so
 * in every post, because the post that is forwarded is the only one somebody sees.
 */
export const MODEL_CHANNEL_STANDING =
  'Публікується автоматично, без перевірки людиною. Офіційні тривоги й відбої в цей канал не '
  + 'потрапляють.';

// A leading run of emoji, bullets and dashes is how monitoring channels open almost every post. The
// bot already prints its own status emoji, so keeping theirs produces "⚠️ Київ … ⚠️Загроза".
// Written as an alternation rather than one character class on purpose: an emoji is a sequence
// (base + variation selector, or two bases joined by a zero-width joiner), and a class would match
// its halves independently and could cut a sequence in the middle.
//
// `Regional_Indicator` is listed separately because flag emoji — "🇷🇺 Зліт МіГ-31К" is a routine
// opening for these channels — are *not* `Extended_Pictographic`. The broader `\p{So}` would cover
// them, but it also swallows ordinary typography: `№` is `So`, so "№5 борт зафіксовано" lost its
// number sign and started a sentence with a bare digit.
const leadingDecoration = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|️|‍|[\s•·*|>\-–—])+/u;

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
    // Horizontal whitespace only. `\s` here would eat the newline too, welding "Ціль зникла" and
    // "… далі буде" into one line and destroying the separation the channel put between two claims.
    .replace(/[^\S\n]+([,.!?;:…])/g, '$1')
    .trim();
}
