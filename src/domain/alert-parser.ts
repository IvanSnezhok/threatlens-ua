/**
 * Parser for the official air-raid alert channels.
 *
 * These channels are fed directly by the executive authorities and the State Emergency Service and
 * are readable without an API token, which is why they are Tier A official sources rather than OSINT
 * monitoring. They publish *events* ("an alert started in X", "the all-clear was given in Y"), not
 * the periodic full snapshots the alert APIs return, so nothing in here may be read as "every
 * location not mentioned is clear".
 *
 * This module is deliberately pure: text in, decision out. It never touches the database, the
 * location catalogue or the network, so it stays testable while the raion catalogue is still being
 * imported and so a catalogue gap can never change how a message is *understood*. It is also
 * deliberately channel-agnostic: the caller supplies the source id, and every shape below is
 * accepted from every registered alert channel. Which channels are read is a catalogue decision
 * (`sources.enabled`), not a parser decision.
 *
 * ## Two published word orders, both verbatim from live channels
 *
 * **A. Phrase first** — https://t.me/s/air_alert_ua, the national channel. A printed clock, the
 * phrase, then the location either inline or as a `•` list:
 *
 *   🔴 13:47 Повітряна тривога в Новомосковський район
 *   Слідкуйте за подальшими повідомленнями.
 *   #Новомосковський_район
 *
 *   🔴 01:04 Повітряна тривога в
 *   • Вишгородський район
 *   • Бучанський район
 *   …
 *
 *   🟢 14:05 Відбій тривоги в м. Харків та Харківська територіальна громада.
 *   🟡 14:04 Відбій тривоги в Куп'янський район.
 *      Зверніть увагу, тривога ще триває у:
 *      - Куп'янський район
 *
 * **B. Location first** — the oblast and city military administrations
 * (https://t.me/s/khersonskaODA, kyivoda, VinnytsiaODA, oda_rv, slv_vca, kherson_miskrada). No
 * printed clock, one location per message, the phrase after a spaced dash, and the partial
 * all-clear says "досі триває" where the national channel says "ще триває":
 *
 *   🔴 Бериславський район - повітряна тривога!
 *   🟢 Каховський район - відбій повітряної тривоги!
 *   🟡 Скадовський район - відбій повітряної тривоги!
 *
 *      Зверніть увагу, повітряна тривога досі триває у:
 *      - Бериславський район
 *      - Генічеський район
 *
 * Note what shape B never does: it never repeats the cleared raion in its own "still under alert"
 * list — it lists the *other* raions. The subtraction that protects shape A is a no-op here, which
 * is exactly why it stays in place unchanged rather than being made conditional on the word order.
 *
 * ## Shapes that must never move alert state
 *
 *   🟠 21:56 УВАГА!!!  Загроза застосування керованих авіаційних бомб (КАБів).
 *   🔴🔴 16:02 Загроза керованих авіабомб в м. Запоріжжя та Запорізька територіальна громада!
 *   🟢 15:49 Відбій загрози ударних БпЛА
 *
 * Only "Повітряна тривога" and "Відбій (повітряної) тривоги" move the air-raid alert state. Every
 * other shape — the 🟠 advisories, the 🔴🔴 heightened-danger notices and the
 * "Загроза …"/"Відбій загрози …" family — is a threat notice published *inside* an ongoing alert.
 * Acting on those would let "🟢 Відбій загрози ударних БпЛА" cancel an air-raid alert that is still
 * running. The location-first patterns require the literal "повітрян…" before "тривог…" for the
 * same reason: it is what stops a hypothetical "Херсонський район - відбій загрози БпЛА!" from
 * reading as an all-clear now that the phrase no longer has to sit at the start of the headline.
 *
 * ## Ordinary channel prose
 *
 * The national channel publishes nothing but alerts; an administration channel publishes school-bus
 * deliveries, curfew reminders and air-quality bulletins between its alerts, and roughly a third of
 * them mention "повітряної тривоги" in passing. Those are reported as `ignored: 'unrelated'`, not as
 * `unrecognized` — see {@link IgnoreReason} for why the distinction is load-bearing.
 */

/** The only alert type this channel is allowed to start or end. */
export const AIR_RAID_ALERT_TYPE = 'air_raid';

export type AlertAction = 'start' | 'end';

export interface AlertChannelEvent {
  action: AlertAction;
  alertType: typeof AIR_RAID_ALERT_TYPE;
  /** Names exactly as printed by the channel; resolution against the catalogue happens elsewhere. */
  locationNames: string[];
  /**
   * The Telegram publication time supplied by the caller, echoed unchanged.
   *
   * The `12:29` printed in the message body carries no date and no timezone and is *not* used: a
   * message replayed after a reconnect would otherwise be timestamped as if it had just happened.
   */
  observedAt: Date;
  /** The clock printed in the message, for diagnostics only. Never a source of truth. */
  channelClock: string | null;
  /** Locations the message says are still under alert (🟡 partial all-clear), already subtracted. */
  stillActiveNames: string[];
}

export type IgnoreReason =
  /** 🟠 advisory: evacuation notices, KAB/drone warnings, "УВАГА!!!" bulletins. */
  | 'advisory'
  /** "Загроза …" / "Відбій загрози …" / "Відбій атаки …": a threat inside an alert, not the alert. */
  | 'threat_notice'
  /** "Зверніть увагу, тривога ще триває у: …" without an all-clear of its own. */
  | 'still_active_notice'
  /** A 🟡 all-clear whose every location is repeated in the "still under alert" list. */
  | 'partial_all_clear_still_active'
  /**
   * Ordinary channel prose: no status circle, and a headline that is not in the alert vocabulary.
   *
   * This is the difference between "the channel said something and we could not read it" and "the
   * channel was not talking about alerts". An oblast administration publishes both, and collapsing
   * them would bury a real wording change under a permanent stream of school-bus announcements —
   * which is the same as not having the warning at all. A headline that *does* carry the alert
   * vocabulary, or any message that carries a status circle, is still `unrecognized`.
   */
  | 'unrelated'
  /** No message text at all. */
  | 'empty';

export type AlertChannelParse =
  | { kind: 'event'; event: AlertChannelEvent }
  | { kind: 'ignored'; reason: IgnoreReason; headline: string }
  /**
   * A shape this parser does not know. Callers must log it: a channel that changes its wording must
   * make the collector loud, not silently stop reporting alerts.
   */
  | { kind: 'unrecognized'; headline: string };

type Marker = 'alert' | 'clear' | 'partial' | 'advisory';

/** Leading status circles. 🔴🔴 (heightened danger) simply repeats the `alert` marker. */
const MARKERS: Readonly<Record<string, Marker>> = {
  '\u{1F534}': 'alert',    // 🔴
  '\u{1F7E0}': 'advisory', // 🟠
  '\u{1F7E1}': 'partial',  // 🟡
  '\u{1F7E2}': 'clear'     // 🟢
};

// `\b` is useless against Cyrillic (it is defined over ASCII word characters), so the boundary after
// the preposition is expressed as an explicit whitespace-or-end alternative. The optional capture is
// what distinguishes the inline form from the bullet-list form, whose headline ends at "в".
const START_PHRASE = /^повітрян[а-яіїєґ]*\s+тривог[а-яіїєґ]*\s+[ву](?:\s+(.*))?$/iu;
const END_PHRASE = /^відбій\s+(?:повітрян[а-яіїєґ]*\s+)?тривог[а-яіїєґ]*\s+[ву](?:\s+(.*))?$/iu;

// Word order B. The location comes first and the phrase is the tail, so there is no preposition to
// anchor on — "повітрян…" before "тривог…" is the anchor instead, and it is mandatory in both
// patterns. Without it "<район> - відбій загрози БпЛА!" would read as an all-clear.
//
// The separator is a *spaced* dash: `Могилів-Подільський район` carries an unspaced hyphen inside
// the name itself and must survive intact. The lazy prefix therefore stops at the first spaced dash
// whose tail is the complete phrase and nothing else.
const START_LOCATION_FIRST = /^(.{1,120}?)\s+[-–—]\s+повітрян[а-яіїєґ]*\s+тривог[а-яіїєґ]*\s*[!.…]*$/iu;
const END_LOCATION_FIRST =
  /^(.{1,120}?)\s+[-–—]\s+відбій\s+повітрян[а-яіїєґ]*\s+тривог[а-яіїєґ]*\s*[!.…]*$/iu;

// "тривога ще триває у" (national channel) and "повітряна тривога досі триває у" (administrations).
const STILL_ACTIVE_MARKER = /тривог[а-яіїєґ]*\s+(?:ще|досі)\s+трива/iu;
const LOCATION_BULLET = /^[•·]\s*(.+)$/u;
const STILL_ACTIVE_BULLET = /^[•·\-–—]\s*(.+)$/u;
const HASHTAG_LINE = /^#\S/u;

/**
 * Headline shapes that are known *not* to be an alert transition. Order is not significant.
 *
 * `загроз` is matched anywhere in the headline rather than only at the start. The national channel
 * publishes both "Загроза керованих авіабомб в …" and "Ракетна загроза в м. Запоріжжя …", and the
 * second was reported as an unknown shape until the anchor came off. This list is only consulted
 * once {@link matchHeadline} has already declined the headline, so widening it can silence a threat
 * notice but can never swallow an alert transition.
 */
const IGNORABLE_HEADLINES: ReadonlyArray<[RegExp, IgnoreReason]> = [
  [/загроз/iu, 'threat_notice'],
  [/^відбій\s+(?:загроз|атак|по(?![а-яіїєґ]))/iu, 'threat_notice'],
  [/^атак/iu, 'threat_notice'],
  [/^каб(?![а-яіїєґa-z])/iu, 'threat_notice'],
  [/^ув[аa]г[аa]/iu, 'advisory'],
  [/^безкоштовн/iu, 'advisory'],
  [/^евакуац/iu, 'advisory']
];

const APOSTROPHES = /['‘’ʼ`´]/gu;

/**
 * Comparison key for two names printed by the same channel in two different places (headline vs the
 * "still under alert" list). Apostrophes are folded because the channel is inconsistent about
 * `’` and `'`, and trailing punctuation because only the headline carries a full stop.
 */
export function locationKey(name: string): string {
  return name
    .replace(APOSTROPHES, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[•·\-–—\s]+/u, '')
    .replace(/[.,;:!?\s]+$/u, '')
    .trim()
    .toLocaleLowerCase('uk-UA');
}

/** Strips list punctuation and the trailing full stop, keeping the name as the channel printed it. */
function cleanName(raw: string): string {
  return raw
    .replace(/\s+/gu, ' ')
    .replace(/^[•·\-–—\s]+/u, '')
    .replace(/[.,;:!\s]+$/u, '')
    .trim();
}

function normalizeLines(text: string): string[] {
  // `\s` in a Unicode regex already covers NBSP and the narrow spaces the channel occasionally
  // pastes in, so collapsing whitespace per line is enough to normalise the layout.
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0 && !HASHTAG_LINE.test(line));
}

interface Headline {
  markers: Marker[];
  clock: string | null;
  text: string;
}

/** Splits `🔴🔴 14:03 Загроза …` into its status circles, its printed clock and the rest. */
function splitHeadline(line: string): Headline {
  const characters = [...line];
  const markers: Marker[] = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index]!;
    // U+FE0F only selects the emoji presentation of the preceding circle.
    if (character === '\uFE0F' || /\s/u.test(character)) { index += 1; continue; }
    const marker = MARKERS[character];
    if (!marker) break;
    markers.push(marker);
    index += 1;
  }
  const rest = characters.slice(index).join('').trim();
  const clock = /^(\d{1,2}:\d{2})\b\s*/u.exec(rest);
  return { markers, clock: clock?.[1] ?? null, text: clock ? rest.slice(clock[0].length).trim() : rest };
}

interface Body {
  bulletLocations: string[];
  stillActiveNames: string[];
  hasStillActiveList: boolean;
}

/**
 * Reads the lines below the headline.
 *
 * A multi-location message lists its locations with `•` bullets; the "still under alert" addendum
 * that follows a 🟡 partial all-clear uses `-`. Keeping the two bullet characters apart is what
 * stops the addendum from being read as more locations to clear.
 */
function readBody(lines: string[]): Body {
  const bulletLocations: string[] = [];
  const stillActiveNames: string[] = [];
  let inStillActive = false;
  for (const line of lines) {
    if (STILL_ACTIVE_MARKER.test(line)) { inStillActive = true; continue; }
    if (inStillActive) {
      const item = STILL_ACTIVE_BULLET.exec(line);
      if (item) stillActiveNames.push(cleanName(item[1]!));
      continue;
    }
    const bullet = LOCATION_BULLET.exec(line);
    if (bullet) bulletLocations.push(cleanName(bullet[1]!));
  }
  return { bulletLocations, stillActiveNames, hasStillActiveList: inStillActive };
}

function ignorableReason(headline: string): IgnoreReason | null {
  for (const [pattern, reason] of IGNORABLE_HEADLINES) {
    if (pattern.test(headline)) return reason;
  }
  return null;
}

interface HeadlineTransition {
  action: AlertAction;
  /** The location printed in the headline itself; empty when the message uses a `•` list instead. */
  inline: string;
}

/**
 * Reads the headline in either published word order.
 *
 * The all-clear pattern of each order is tried before its start pattern. "Відбій повітряної
 * тривоги" also ends in "тривоги", and an all-clear read as a start would raise an alert at the
 * exact moment the authority said it was over — the worst available way to be wrong.
 */
function matchHeadline(headline: string): HeadlineTransition | null {
  const endPhrase = END_PHRASE.exec(headline);
  if (endPhrase) return { action: 'end', inline: endPhrase[1] ?? '' };
  const startPhrase = START_PHRASE.exec(headline);
  if (startPhrase) return { action: 'start', inline: startPhrase[1] ?? '' };
  const endLocationFirst = END_LOCATION_FIRST.exec(headline);
  if (endLocationFirst) return { action: 'end', inline: endLocationFirst[1]! };
  const startLocationFirst = START_LOCATION_FIRST.exec(headline);
  if (startLocationFirst) return { action: 'start', inline: startLocationFirst[1]! };
  return null;
}

/**
 * Turns one channel message into an alert transition, an explicit "not an alert", or an explicit
 * "unknown shape". `observedAt` must be the Telegram publication time of the message.
 */
export function parseAlertChannelMessage(text: string, observedAt: Date): AlertChannelParse {
  const lines = normalizeLines(text ?? '');
  if (!lines.length) return { kind: 'ignored', reason: 'empty', headline: '' };

  const { markers, clock, text: headline } = splitHeadline(lines[0]!);
  const body = readBody(lines.slice(1));

  // 🟠 is the advisory channel-within-a-channel; it never carries an alert transition.
  if (markers.length && markers.every((marker) => marker === 'advisory')) {
    return { kind: 'ignored', reason: 'advisory', headline };
  }

  const transition = matchHeadline(headline);

  if (!transition) {
    const reason = ignorableReason(headline)
      // "🟡 Увага" / "🟡 к" carrying only the "still under alert" addendum: informational, and the
      // typo'd headlines prove the addendum is the reliable part of that shape.
      ?? (body.hasStillActiveList ? 'still_active_notice' as const : null)
      // No circle and no alert vocabulary: an ordinary post on a channel that also publishes news.
      // A circle without a phrase we know is still `unrecognized` — that is the wording-drift alarm.
      ?? (markers.length ? null : 'unrelated' as const);
    return reason ? { kind: 'ignored', reason, headline } : { kind: 'unrecognized', headline };
  }

  // The circle and the wording must agree. They always have on the live channels; a disagreement —
  // including an alert phrase published with no circle at all — means the vocabulary moved and is
  // safer surfaced than guessed at.
  const expected: Marker[] = transition.action === 'start' ? ['alert'] : ['clear', 'partial'];
  if (!markers.some((marker) => expected.includes(marker))) {
    return { kind: 'unrecognized', headline };
  }

  const inline = cleanName(transition.inline);
  const named = inline ? [inline] : body.bulletLocations;
  if (!named.length) return { kind: 'unrecognized', headline };

  // 🟡 clears part of a territory and repeats what is still under alert. `Відбій тривоги в
  // Куп'янський район … тривога ще триває у: - Куп'янський район` must not end anything.
  const stillActive = new Set(body.stillActiveNames.map(locationKey));
  const locationNames = transition.action === 'end'
    ? named.filter((name) => !stillActive.has(locationKey(name)))
    : named;
  if (!locationNames.length) {
    return { kind: 'ignored', reason: 'partial_all_clear_still_active', headline };
  }

  return {
    kind: 'event',
    event: {
      action: transition.action,
      alertType: AIR_RAID_ALERT_TYPE,
      locationNames,
      observedAt,
      channelClock: clock,
      stillActiveNames: body.stillActiveNames
    }
  };
}
