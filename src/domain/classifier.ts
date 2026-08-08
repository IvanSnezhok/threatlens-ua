import type { ClassifiedMessage, RelationType, ThreatType } from '../types.js';

/**
 * Version of the rules in this module, stamped on every decision in `message_classifications`.
 *
 * Without it, an improvement to this file is indistinguishable from a change in enemy behaviour.
 * "Half as many ballistic events this month" reads identically whether the enemy launched fewer
 * missiles or a regex here stopped matching a phrasing it used to catch, and the archive would offer
 * no way to tell them apart. Recording the version separates the two axes so any comparison across
 * time can hold the instrument constant.
 *
 * **Raise it whenever a rule changes what a message means** — a new or altered pattern, a new
 * indicator, a change to the negation, redirect, significance or foreign-place logic. Do not raise
 * it for comments, refactoring or renames. The archive keeps one row per (message, version), so a
 * bumped version replayed over stored history produces a second opinion beside the first instead of
 * overwriting it, which is what makes this corpus usable for regression-testing a new classifier.
 *
 * ## Version history
 *
 * * `v1` — the original rule set.
 * * `v2` — vocabulary the monitoring channels use that `v1` did not read. Ground-attack use of
 *   S-300/S-400 ("загроза застосування С-300 по Харківщині"), which `v1` saw as a message with no
 *   threat noun in it at all; launches from the Black and Azov sea areas; the "Бандероль" (S8000)
 *   cruise missile; naval drones, which `v1` matched as an ordinary UAV with nothing recording that
 *   the platform was a surface one; a bare "розвідник" beside a place; a repeat approach
 *   ("повторно курсом на Одесу") with no weapon named; and the split of MiG-31K activity into a
 *   launch-scope take-off and an ambient-scope landing, so a reported landing at Savasleyka no
 *   longer raises a country-wide ballistic warning. `FOREIGN_PLACE_STEMS` gained the airfields those
 *   landing reports name.
 */
export const CLASSIFIER_VERSION = 'v2';

export interface LocationLexeme {
  id: string;
  name: string;
  aliases: string[];
}

const patterns: Array<[ThreatType, RegExp]> = [
  // `баліст` rather than `балістик`: the adjective form ("загроза застосування балістичного
  // озброєння", the Air Force's standard national warning) does not carry the -ик- stem.
  ['ballistic_missile', /(баліст[а-яіїєґ]*|іскандер[-– ]?м|kn[-– ]?(23|24))/iu],
  // "Онікс"/П-800 and "швидкісна ціль" are how the monitoring channels name a supersonic
  // anti-ship missile and an unidentified fast target; both are cruise-class for our purposes.
  // "Бандероль" (S8000) is a cruise missile the channels started naming in 2025 and report exactly
  // the way they report a Kalibr. The word also means "parcel", and no lexical guard separates the
  // two — the structural one does: {@link isSignificant} refuses to raise anything that names no
  // place, so a post office notice classifies as a threat about nowhere and is dropped.
  ['cruise_missile', /(крилат[а-яіїєґ]* ракет[а-яіїєґ]*|іскандер[-– ]?к|калібр[а-яіїєґ]*|он[іи]кс|п[-– ]?800|(?<!\p{L})бандерол[а-яіїєґ]*|швидкісн[а-яіїєґ]*\s+ціл[а-яіїєґ]*)/iu],
  ['guided_air_bomb', /(каб[а-яіїєґ]*|керован[а-яіїєґ]* авіаційн[а-яіїєґ]* бомб[а-яіїєґ]*)/iu],
  // "герань" and "мопед" are the two slang names the OSINT feeds use for a Shahed-type drone, and
  // the bare "реакт" is how they abbreviate a jet-powered one in telegraphic posts
  // ("3х реакт йдуть по межі Котельва"). The suffix guard keeps it away from "реактивна артилерія",
  // which is a different weapon and is already matched as `mlrs` below.
  ['uav', /(бпла|ударн[а-яіїєґ]* дрон[а-яіїєґ]*|безпілотник[а-яіїєґ]*|шахед[а-яіїєґ]*|геран[ья][а-яіїєґ]*|мопед[а-яіїєґ]*|(?<!\p{L})реакт(?:и|ів|ах|ами)?(?!\p{L}))/iu],
  ['aviation', /(стратегічн[а-яіїєґ]* авіаці[а-яіїєґ]*|тактичн[а-яіїєґ]* авіаці[а-яіїєґ]*|активність авіаці[а-яіїєґ]*)/iu],
  ['mlrs', /(рсзв|реактивн[а-яіїєґ]* артилері[а-яіїєґ]*)/iu],
  ['artillery', /(артилерійськ[а-яіїєґ]* обстріл[а-яіїєґ]*|ствольн[а-яіїєґ]* артилері[а-яіїєґ]*)/iu],
  ['mortar', /(мінометн[а-яіїєґ]* обстріл[а-яіїєґ]*)/iu]
];

/**
 * Strategic indicators: activity observed on the launching side.
 *
 * `scope: 'launch'` means the indicator describes preparation or launch of something aimed at
 * Ukraine. Those messages name Russian airfields, seas and firing positions by design, so the
 * foreign-place guard below must not suppress them — a report about Engels is the single most
 * valuable early warning this system receives.
 *
 * `scope: 'ambient'` means the indicator describes activity on the far side that is *not* itself a
 * threat to Ukraine. Enemy air defence working over Kursk is a fact about Kursk. Left in the
 * 'launch' class it would raise a national Ukrainian threat every time a monitoring channel
 * reported an explosion in Russia.
 */
type IndicatorScope = 'launch' | 'ambient';

const strategicIndicators: Array<{ name: string; pattern: RegExp; threatTypes: ThreatType[]; scope: IndicatorScope }> = [
  { name: 'зліт стратегічної авіації', pattern: /(зліт|підня(?:то|лися)|у повітрі).{0,45}(ту[-– ]?(95|160)|стратегічн[а-яіїєґ]* авіаці)/iu, threatTypes: ['cruise_missile'], scope: 'launch' },
  // The trailing guard is what keeps a *landing* out of the launch class: "МіГ-31К здійснив посадку"
  // is the end of a threat window, not the start of one, and it is reported in the same telegraphic
  // shape as the take-off. Without it every landing report raised a country-wide ballistic warning —
  // the exact inversion of what the message said. Scoped to the clause so a later sentence about
  // some other aircraft landing cannot suppress a live warning.
  { name: 'активність МіГ-31К', pattern: /(міг[-– ]?31к|mig[-– ]?31k|носі[йя].{0,20}кинджал)(?![^.!?\n]{0,40}(?:посадк|приземл|призем))/iu, threatTypes: ['ballistic_missile'], scope: 'launch' },
  // The mirror of the above, and the reason it is `ambient`: a MiG-31K on the ground at Savasleyka
  // is a fact about Savasleyka. Ambient scope means the foreign-place guard is allowed to suppress
  // it, which is what these reports need — they name a Russian airfield and nothing else.
  {
    name: 'посадка МіГ-31К',
    pattern: /((?:міг[-– ]?31к|mig[-– ]?31k)[^.!?\n]{0,40}(?:посадк|приземл|призем)|(?:посадк|приземл|призем)[а-яіїєґ]*[^.!?\n]{0,40}(?:міг[-– ]?31к|mig[-– ]?31k))/iu,
    threatTypes: ['ballistic_missile'], scope: 'ambient'
  },
  { name: 'активність пускових установок', pattern: /(с[-– ]?300|с[-– ]?400|іскандер).{0,45}(активн|робот|переміщ|готовн|пуск)/iu, threatTypes: ['ballistic_missile'], scope: 'launch' },
  // S-300/S-400 fired at ground targets, which the Air Force warns about in a fixed phrase:
  // "Загроза застосування С-300 по Харківщині". `v1` read this as a message containing no threat
  // noun whatsoever — "загроза застосування" set `nationalScope` only when no place resolved, so the
  // *located* version, the one that actually says where the shelling is aimed, classified as
  // nothing at all and was discarded. Frontline oblasts receive this warning almost daily.
  {
    name: 'загроза застосування С-300/С-400',
    pattern: /(?:загроз[а-яіїєґ]*\s+застосуванн[а-яіїєґ]*|застосуванн[а-яіїєґ]*|удар[а-яіїєґ]*|обстріл[а-яіїєґ]*|пуск[а-яіїєґ]*)[^.!?\n]{0,30}(?<!\p{L})с[-– ]?[34]00/iu,
    threatTypes: ['ballistic_missile'], scope: 'launch'
  },
  { name: 'активність ракетоносіїв у морі', pattern: /(ракетоносі[йї]|носі[йї].{0,25}калібр|корабл[а-яіїєґ]*.{0,25}калібр)/iu, threatTypes: ['cruise_missile'], scope: 'launch' },
  // A launch reported by the water it came from rather than by the platform that fired it:
  // "Пуски з акваторії Чорного моря". Both word orders occur, so both are matched. Kept at launch
  // scope even though the sea named is usually outside Ukraine — that is the whole point of the
  // scope distinction, and this is the earliest warning a coastal oblast ever gets.
  {
    name: 'пуски з морської акваторії',
    pattern: /((?:пуск|запуск|старт)[а-яіїєґ]*[^.!?\n]{0,40}(?:акватор[а-яіїєґ]*|чорного\s+моря|чорному\s+морі|азовського\s+моря|азовському\s+морі)|(?:акватор[а-яіїєґ]*|чорного\s+моря|чорному\s+морі|азовського\s+моря|азовському\s+морі)[^.!?\n]{0,40}(?:пуск|запуск|старт)[а-яіїєґ]*)/iu,
    threatTypes: ['cruise_missile'], scope: 'launch'
  },
  { name: 'ознаки підготовки БпЛА', pattern: /(пуск|запуск|старт|груп[а-яіїєґ]*).{0,35}(шахед|бпла|безпілотник)/iu, threatTypes: ['uav'], scope: 'launch' },
  { name: 'робота ворожої ППО', pattern: /(робот[а-яіїєґ]*|активн[а-яіїєґ]*).{0,25}(ворож[а-яіїєґ]* ппо|ппо рф)/iu, threatTypes: ['ballistic_missile','cruise_missile'], scope: 'ambient' }
];

/**
 * Indicators that only mean something next to a place inside Ukraine.
 *
 * "дорозвідка" — a drone re-scouting a target before a strike — is one of the most useful things the
 * monitoring channels publish, and it arrives in telegraphic form: "Одеса дорозвідка". It is kept
 * out of {@link strategicIndicators} because it must never produce a country-wide event: a bare
 * "дорозвідка" with no place attached says nothing actionable, while the same word next to a
 * resolved location is a concrete UAV signal.
 */
const contextIndicators: Array<{ name: string; pattern: RegExp; threatTypes: ThreatType[] }> = [
  {
    // "розвідник" is the bare noun these channels use once the context is established — "Над Одесою
    // розвідник" is a complete report to their readers. It is safe *here* and would not be safe in
    // {@link strategicIndicators}: the same word means a human scout, and the location requirement
    // is what keeps a war memoir out of the threat feed.
    name: 'розвідувальна активність БпЛА',
    pattern: /(дорозвідк[а-яіїєґ]*|(?<!\p{L})розвідник[а-яіїєґ]*|розвідувальн[а-яіїєґ]*\s+(бпла|дрон[а-яіїєґ]*|безпілотник[а-яіїєґ]*))/iu,
    threatTypes: ['uav']
  },
  {
    // Surface drones. The class stays `uav` — the word "безпілотник" in the message already matched
    // it and `ThreatType` has no naval member — but the indicator records that the platform was a
    // surface one, which is the difference between a warning for a coastal city and a warning for
    // shipping. Naming it is what makes the distinction recoverable from the archive later; silently
    // downgrading the class would drop a real warning to buy a taxonomy.
    name: 'морські безпілотники',
    pattern: /(морськ[а-яіїєґ]*\s+(?:безпілотник|дрон)[а-яіїєґ]*|безекіпажн[а-яіїєґ]*\s+катер[а-яіїєґ]*|надводн[а-яіїєґ]*\s+(?:безпілотник|дрон)[а-яіїєґ]*)/iu,
    threatTypes: ['uav']
  },
  {
    // A second pass over a place already attacked: "повторно курсом на Одесу". `threatTypes` is
    // empty on purpose. The phrase almost always describes a Shahed, but "almost always" is a guess,
    // and a message that names no weapon must not be told what weapon it named — when the text does
    // say "шахед", the ordinary UAV pattern has already matched and this indicator only adds the
    // fact that it is a repeat.
    name: 'повторний захід',
    pattern: /(?<!\p{L})(?:повторн[а-яіїєґ]*|знову)\s+(?:[^.!?\n]{0,20}?)(?:курс(?:ом)?\s+на|у\s+напрямку|в\s+напрямку|заход[а-яіїєґ]*|захід)/iu,
    threatTypes: []
  },
  {
    // The arrow bulletin: "✈️Сумщина: →Кириківка/Тростянець. ✈️Харківщина: →Гути/Богодухів."
    // A region header, an arrow, and the settlements the target is moving towards — with no threat
    // noun anywhere in the message. `threatTypes` is deliberately empty: the arrow states movement,
    // not what is moving, and the emoji before the region is not evidence of a weapon class. The
    // event is raised as `unknown` ("Повідомлення про загрозу"), which is the honest reading —
    // something is heading for these places and the message does not say what.
    name: 'рух цілі за напрямком',
    pattern: /(?:→|➡|⮕|-->|->)\s*\p{L}/u,
    threatTypes: []
  }
];

/**
 * Settlements and regions on the far side of the border.
 *
 * The location catalogue holds Ukrainian places only, so "Брянськ" resolves to nothing and a report
 * about a fire over Bryansk already produces no located event. The failure it does *not* prevent is
 * the country-wide one: with no Ukrainian location resolved, any matched indicator sets
 * `nationalScope`, and a message about enemy air defence working over Kursk would be published as a
 * threat "по всій Україні". This list is what lets the classifier tell "nothing matched because the
 * event is abroad" apart from "nothing matched because the message is about the whole country".
 *
 * Only names with no Ukrainian homonym are listed, and matching is prefix-based with a
 * letter-boundary on the left so inflections are covered without matching inside another word.
 * Occupied Ukrainian territory — Crimea, Donetsk, Melitopol — is deliberately absent: it is Ukraine,
 * it is in the catalogue, and it resolves normally.
 */
const FOREIGN_PLACE_STEMS = [
  // Russia
  'брянськ', 'брянск', 'брянщин', 'курськ', 'курск', 'курщин', 'бєлгород', 'белгород', 'білгород',
  'москв', 'ростов', 'воронеж', 'таганрог', 'новоросійськ', 'рязан', 'саратов', 'енгельс', 'энгельс',
  'оленья', 'оленєгорськ', 'шайковк', 'міллеров', 'морозовськ', 'приморсько-ахтарськ', 'єйськ',
  // MiG-31K basing airfields. Added with the landing indicator: a landing report names one of these
  // and nothing else, and without the stem it would resolve no Ukrainian place and go country-wide.
  'саваслейк', 'ахтубінськ',
  'краснодар', 'анапа', 'сочі', 'тамань', 'кубан',
  // Belarus
  'мозир', 'гомел', 'мінськ', 'барановичі', 'лунінец', 'мачулищ', 'бобруйськ', 'речиц', 'калинковичі'
];
const FOREIGN_PLACE_PATTERN = new RegExp(`(?<!\\p{L})(?:${FOREIGN_PLACE_STEMS.join('|')})`, 'iu');

/**
 * Satire, memes, promotion and fundraising.
 *
 * These channels publish jokes and donation appeals between situation reports, and the words a joke
 * is built from are the same words a threat report is built from — "шахед" in a meme classified
 * exactly as "шахед" in a warning before this guard existed. What can be detected reliably is the
 * *frame*: an explicit humour marker, laughing emoji, a fundraiser or an ad call-to-action. What
 * cannot is a meme that carries none of those; the structural backstop for that case is
 * {@link isSignificant}, which refuses to raise an event that names no place.
 */
// `\b` is ASCII-only in JavaScript even under the `u` flag, so it never fires between two Cyrillic
// letters. Every boundary here is a `\p{L}` lookaround for that reason.
const COMMENTARY_MARKERS = /((?<!\p{L})мем(?:и|ів|ам|ах|ами|ас[а-яіїєґ]*|чик[а-яіїєґ]*)?(?!\p{L})|гумор|жарт[а-яіїєґ]*|анекдот|сатир[а-яіїєґ]*|рофл|прикол|тролін[а-яіїєґ]*|😂|🤣|😹|підписуйт|підписуйся|реклам[а-яіїєґ]*|монобанк|mono\.bank|send\.monobank|реквізит[а-яіїєґ]*|донат[а-яіїєґ]*|збір на)/iu;

/**
 * Structural marks of an operational report, used to override {@link COMMENTARY_MARKERS}.
 *
 * Deliberately structural rather than topical: a direction, a launch, an explicit national warning
 * or a time-to-impact. Listing threat words here instead would hand the override straight back to
 * any meme that mentions a Shahed, which is the case the commentary guard exists for.
 */
const OPERATIONAL_CUES = /([ув] напрямку|курс(?:ом)? на|прямує до|руха(?:ється|ються) до|(?<!\p{L})[ув] бік|загроза застосування|(?<!\p{L})(?:за)?пуск|(?<!\p{L})зліт|\d+\s*хв)/iu;

/**
 * Messages that address the whole country without naming a place inside it.
 *
 * The Air Force channel warns nationally in exactly this shape ("Загроза застосування балістичного
 * озброєння"), and {@link isSignificant} would otherwise drop it for having no location.
 */
const NATIONAL_SCOPE_CUES = /(по всій (?:території )?україн[аиі]|вся територія україни|загроза застосування|масован(?:ий|а) (?:удар|атака|обстріл))/iu;

/**
 * "Nothing is happening" phrasing.
 *
 * The all-quiet bulletin is a distinct message class on these channels and it is built from exactly
 * the same vocabulary as a warning — "не відмічаємо ознак … застосування стратегічної авіації" names
 * the threat it is denying. Matching a threat pattern was previously sufficient on its own, so a
 * denial produced a threat.
 */
const NEGATION_MARKERS = /(?<!\p{L})(не\s+(?:лет|фікс|зафіксов|спостеріга|відміча|відмічен|виявля|виявлен|помічен|зареєстров|становить|загрожу)|нічого\s+не|немає|нема(?!\p{L})|без\s+загроз|відсутн|неактивн|чисте небо)/iu;

/** Sentence-ish boundaries. A comma is not one: a denial and its object share a clause. */
const CLAUSE_BOUNDARY = /[.!?;\n]/;

/**
 * Contrastive conjunctions, which end the reach of a denial as firmly as a full stop.
 *
 * "Не фіксуємо балістики, але шахеди йдуть на Одесу" denies exactly one of the two threats it names.
 * Without this the leading denial would swallow the clause it is being contrasted with and the
 * warning would be read as an all-clear — the worst available direction for this module to fail in.
 */
const CONTRAST_MARKERS = /(?<!\p{L})(?:але|проте|однак|втім|зате|натомість)(?!\p{L})/giu;

/** The part of a denial's forward reach that survives a contrast, i.e. after the last one. */
function afterLastContrast(prefix: string): string {
  let cut = 0;
  for (const match of prefix.matchAll(CONTRAST_MARKERS)) cut = match.index + match[0].length;
  return prefix.slice(cut);
}

/** The part of a denial's backward reach that survives a contrast, i.e. before the first one. */
function beforeFirstContrast(suffix: string): string {
  const match = CONTRAST_MARKERS.exec(suffix);
  CONTRAST_MARKERS.lastIndex = 0;
  return match ? suffix.slice(0, match.index) : suffix;
}

/**
 * Whether the threat token at `[index, index + length)` sits inside a denial.
 *
 * Scoped to the clause holding the match, and asymmetric on purpose. Everything before the match in
 * that clause counts, because the denial usually leads ("не відмічаємо ознак … застосування
 * стратегічної авіації"). Only a short run after the match counts, because a denial that trails far
 * behind is usually about something else — in "БпЛА в Полтавській області, вибухів не зафіксовано"
 * the drones are real and only the explosions are denied.
 */
function negatedAt(text: string, index: number, length: number): boolean {
  let start = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (CLAUSE_BOUNDARY.test(text[cursor]!)) { start = cursor + 1; break; }
  }
  const after = index + length;
  let end = text.length;
  for (let cursor = after; cursor < text.length; cursor += 1) {
    if (CLAUSE_BOUNDARY.test(text[cursor]!)) { end = cursor; break; }
  }
  // Both a denial ("не фіксуємо балістики") and an explicit withdrawal ("відбій загрози ударних
  // БпЛА") make the threat token they govern a thing being taken back rather than asserted.
  const retracts = (span: string) => NEGATION_MARKERS.test(span) || DE_ESCALATION_PHRASES.test(span);
  return retracts(afterLastContrast(text.slice(start, index)))
    || retracts(beforeFirstContrast(text.slice(after, Math.min(end, after + 30))));
}

interface SignalMatch {
  threatTypes: ThreatType[];
  index: number;
  length: number;
  negated: boolean;
}

/** Every threat token in the message, each tagged with whether its own clause denies it. */
function signalMatches(text: string): SignalMatch[] {
  const sources: Array<{ pattern: RegExp; threatTypes: ThreatType[] }> = [
    ...patterns.map(([type, pattern]) => ({ pattern, threatTypes: [type] })),
    ...strategicIndicators.map(({ pattern, threatTypes }) => ({ pattern, threatTypes }))
  ];
  const matches: SignalMatch[] = [];
  for (const { pattern, threatTypes } of sources) {
    const match = pattern.exec(text);
    if (!match) continue;
    matches.push({
      threatTypes, index: match.index, length: match[0].length,
      negated: negatedAt(text, match.index, match[0].length)
    });
  }
  return matches;
}

/**
 * Statements of absence that name no threat token of their own.
 *
 * "ТУшки неактивні, у наш бік наразі нічого не летить" contains no pattern this module matches — the
 * withdrawal is carried entirely by the verb. Without this, the message classifies as nothing and is
 * discarded, which loses the only signal the channel ever publishes that a threat is over.
 */
const ABSENCE_STATEMENTS = /((?<!\p{L})нічого\s+не\s+лет|(?<!\p{L})не\s+лет(?:ить|ять)|(?<!\p{L})неактивн[а-яіїєґ]*|(?<!\p{L})не\s+(?:відміча|фіксу|спостеріга|виявля|поміча)[а-яіїєґ]*|повітряний\s+простір\s+чист|чисте\s+небо|(?<!\p{L})без\s+загроз)/iu;

/** Explicit withdrawals: the threat existed and is now over. */
const DE_ESCALATION_PHRASES = /((?<!\p{L})відбій\s+загроз|загроз[аи]?\s+мину|небезпек[аи]?\s+мину|загроза\s+відсутн|ціл[ья][а-яіїєґ]*\s+(?:знищен|збит|ліквідован)|(?<!\p{L})збито\s+(?:ціл|усі|всі)|повітряний\s+простір\s+вільн)/iu;

/**
 * Anticipation, which is not withdrawal.
 *
 * "Очікуємо на відбій, але пильність не втрачати" is a message about a threat that is still running.
 * Reading it as an all-clear is the most dangerous mistake available in this module, so anticipation
 * vetoes de-escalation outright rather than being weighed against it.
 */
const ANTICIPATION_MARKERS = /((?<!\p{L})очікує|(?<!\p{L})чекає|сподіва|незабаром|(?<!\p{L})скоро(?!\p{L})|згодом|пильност|пильність|не\s+втрача|залишайт|(?<!\p{L})ще\s+не(?!\p{L}))/iu;

/**
 * A threat moving past one place towards another.
 *
 * Both halves have to resolve for this to be a redirect: at least one catalogue location inside the
 * "повз …" span and at least one inside the "… на …" span. When only one side resolves the message
 * is classified as an ordinary threat for whatever it did name — asserting a threat that has moved
 * on is a smaller error than withdrawing one that has not.
 */
const REDIRECT_PATTERN = /(?<!\p{L})повз\s+([^.!?\n]{2,60}?)\s+(?:на|у\s+напрямку|в\s+напрямку|до)\s+([^.!?\n]{2,80})/iu;

const labels: Record<ThreatType, string> = {
  uav: 'Загроза ударних БпЛА',
  ballistic_missile: 'Балістична загроза',
  cruise_missile: 'Загроза крилатих ракет',
  guided_air_bomb: 'Загроза керованих авіаційних бомб',
  aviation: 'Підвищена активність авіації',
  mlrs: 'Загроза реактивної артилерії',
  artillery: 'Загроза артилерійського обстрілу',
  mortar: 'Загроза мінометного обстрілу',
  combined: 'Комбінована загроза',
  unknown: 'Повідомлення про загрозу'
};

function relationFor(text: string, alias: string): RelationType {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`([ув] напрямку|курс(?:ом)? на|руха(?:ється|ються) до|прямує до|[ув] бік)\\s+(?:.{0,24})${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  // The arrow bulletin marks its targets with an arrow and separates them with a slash:
  // "→Кириківка/Тростянець". Everything after the arrow up to the sentence end is a target list, so
  // the second name is as much a direction as the first.
  if (new RegExp(`(?:→|➡|⮕|-->|->)\\s*[^.!?\\n]{0,40}?${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  // Transit: "Балістика повз Бровари на Бориспіль". The place being passed and the place being
  // approached carry different meanings for a reader under it, and only the second is a direction.
  // The first keeps `mentioned`, which is what "повз" says — something went by, it was not aimed
  // there.
  if (new RegExp(`повз\\s+[^.!\\n]{0,40}?на\\s+(?:.{0,10})${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  if (new RegExp(`(загроза|небезпека|увага для)(?:.{0,45})${escaped}`, 'iu').test(text)) {
    return 'explicit_threat';
  }
  if (/наслідк|влучан|пошкоджен|вибух/iu.test(text)) return 'aftermath';
  return 'mentioned';
}

/** The classification of a message that carries no Ukrainian air threat and withdraws nothing. */
function neutral(summary: string): ClassifiedMessage {
  return {
    intent: 'none',
    threatType: 'unknown',
    signalThreatTypes: ['unknown'],
    locations: [],
    nationalScope: false,
    indicators: [],
    title: labels.unknown,
    summary
  };
}

/**
 * Whether a classification is allowed to become a threat event.
 *
 * Three conditions. The intent has to be an assertion — a withdrawal is not a threat, however much
 * threat vocabulary it contains. Something threat-shaped has to have been recognised. And, the
 * structural answer to satire, quotation and idle chatter, **a threat event has to be somewhere**:
 * either the message resolves a Ukrainian location, or it carries a strategic indicator or an
 * explicit national warning that makes it country-wide. A meme that says "шахед" and nothing else
 * names no place, so it raises nothing, whether or not any humour marker gave it away.
 */
export function isSignificant(classified: ClassifiedMessage): boolean {
  return significanceRejection(classified) === null;
}

/**
 * Which of the three conditions in {@link isSignificant} a classification failed, or `null` when it
 * passed.
 *
 * Same rule, stated so the answer can be *recorded*. "Why was this message ignored?" was previously
 * unanswerable — the boolean collapsed three different judgements into one, and none of them
 * survived the function call. Each value is a distinct operational finding: `no_threat_recognised`
 * on a channel that publishes real warnings means the vocabulary has drifted, while `no_location`
 * dominating one source means its place names are missing from the catalogue rather than that it
 * publishes noise.
 */
export type SignificanceRejection = 'not_an_assertion' | 'no_threat_recognised' | 'no_location';

export function significanceRejection(classified: ClassifiedMessage): SignificanceRejection | null {
  if (classified.intent !== 'threat' && classified.intent !== 'redirect') return 'not_an_assertion';
  if (classified.threatType === 'unknown' && classified.indicators.length === 0) return 'no_threat_recognised';
  if (classified.locations.length === 0 && !classified.nationalScope) return 'no_location';
  return null;
}

/** A source withdrawing its own earlier claim. Carries no threat event and changes no state. */
export function isDeEscalation(classified: ClassifiedMessage): boolean {
  return classified.intent === 'de_escalation';
}

interface ResolvedLocation {
  id: string;
  name: string;
  relationType: RelationType;
  /**
   * The lower-cased substring of the message that actually matched.
   *
   * Not the declared alias. An alias is matched by its stem — "богодухові" resolves "Богодухів"
   * through the stem "богодух" — and every downstream regex that has to find the place *in the
   * text* has to look for the form the text uses. Building "→\s*…богодухові" against a message that
   * says "→Гути/Богодухів" finds nothing, and the relation silently degrades to `mentioned`.
   */
  needle: string;
}

/**
 * Inflectional endings stripped from a single word to reach its stem.
 *
 * Wider than the whole-string suffix rule below because it is applied per word inside a compound
 * name, where the ending carried by each word is what changes: "Харківський район" ->
 * "Харківського району" -> "Харківським районом".
 */
const WORD_ENDING = /(?:ого|ому|ими|ої|ій|ий|их|им|ам|ах|ям|ями|ами|ові|еві|ою|ею|ом|а|я|и|і|у|ю|е|о|ь|й)$/u;

function wordStem(word: string): string {
  const stripped = word.replace(WORD_ENDING, '');
  // A stem shorter than four letters stops identifying the place — "біла" would become "біл" and
  // start matching anything beginning with it.
  return stripped.length >= 4 ? stripped : word;
}

const compoundPatterns = new Map<string, RegExp | null>();

/**
 * Case-tolerant pattern for a multi-word place name.
 *
 * The whole-string stemmer strips one ending from the end of the *last* word, so a compound name
 * only survives the cases somebody thought to enumerate as an alias. The KATOTTG importer emits
 * "харківський район", "харківського району" and "харківському районі" — and nothing else, so
 * "Шахед над Харківським районом" matched no raion at all and fell through to the substring
 * "харків", tagging the **city**. That is the worst shape this can fail in: a wrong location that
 * looks right, inflating the city's risk signals and telling its subscribers a raion threat was
 * addressed to them.
 *
 * Stemming each word and allowing a short ending after it covers the declension table generically
 * instead. The left boundary keeps "Нехарківський" out; the words must be adjacent, and each ending
 * is capped at four letters, so the pattern cannot wander.
 */
function compoundPattern(lowered: string): RegExp | null {
  if (compoundPatterns.has(lowered)) return compoundPatterns.get(lowered)!;
  const words = lowered.split(/\s+/u).filter(Boolean);
  const pattern = words.length < 2 ? null : new RegExp(
    `(?<!\\p{L})${words.map((word) => `${wordStem(word).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[а-яіїєґ'ʼ]{0,4}`).join('\\s+')}`,
    'u'
  );
  compoundPatterns.set(lowered, pattern);
  return pattern;
}

/** The substring that actually matched, so overlaps between place names can be compared. */
function matchedNeedle(candidate: string, normalized: string): string | null {
  const lowered = candidate.toLocaleLowerCase('uk-UA');
  if (normalized.includes(lowered)) return lowered;
  const compound = compoundPattern(lowered)?.exec(normalized);
  if (compound) return compound[0];
  const stem = lowered.replace(/(ою|ею|ами|ями|ові|еві|а|я|и|і|у|ю|е)$/u, '');
  return stem.length >= 5 && normalized.includes(stem) ? stem : null;
}

function occurrences(haystack: string, needle: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return spans;
    spans.push([at, at + needle.length]);
    from = at;
  }
}

/**
 * Locations named in `text`, with longer place names taking the text they cover.
 *
 * Matching is substring-based because Ukrainian inflects place names, and that alone made every
 * oblast mention also name its city: "київ" is inside "київщина", "харків" inside "харківщину".
 * The event then claimed the city had been named when only the oblast was, which inflates the
 * city's risk signals and tells its subscribers the threat was addressed to them. The hierarchy
 * already carries oblast events down to their cities, so the extra tag was both wrong and double
 * counting. A shorter name therefore only survives where it occurs outside every longer match —
 * "Київщина та місто Київ" still resolves both.
 */
function resolveLocations(text: string, locations: LocationLexeme[]): ResolvedLocation[] {
  const normalized = text.toLocaleLowerCase('uk-UA');
  const candidates: Array<{ location: LocationLexeme; alias: string; needle: string; order: number }> = [];
  locations.forEach((location, order) => {
    const aliases = [location.name, ...location.aliases].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const needle = matchedNeedle(alias, normalized);
      if (needle) { candidates.push({ location, alias, needle, order }); return; }
    }
  });

  const claimed: Array<[number, number]> = [];
  const seen = new Set<string>();
  const kept: Array<ResolvedLocation & { order: number }> = [];
  for (const candidate of [...candidates].sort((a, b) => b.needle.length - a.needle.length)) {
    if (seen.has(candidate.location.id)) continue;
    const free = occurrences(normalized, candidate.needle)
      .filter(([start, end]) => !claimed.some(([from, to]) => start >= from && end <= to));
    if (!free.length) continue;
    seen.add(candidate.location.id);
    claimed.push(...free);
    kept.push({
      id: candidate.location.id, name: candidate.location.name,
      relationType: relationFor(text, candidate.needle), needle: candidate.needle, order: candidate.order
    });
  }
  return kept.sort((a, b) => a.order - b.order)
    .map(({ id, name, relationType, needle }) => ({ id, name, relationType, needle }));
}

/** Locations named inside `span`, matched on the substring that resolved them in the full text. */
function locationsWithin(span: string, found: ResolvedLocation[]): ResolvedLocation[] {
  const normalized = span.toLocaleLowerCase('uk-UA');
  return found.filter((location) => normalized.includes(location.needle));
}

export function classifyMessage(text: string, locations: LocationLexeme[]): ClassifiedMessage {
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (COMMENTARY_MARKERS.test(text) && !OPERATIONAL_CUES.test(text)) return neutral(summary);

  const matchedIndicators = strategicIndicators.filter(({ pattern }) => pattern.test(text));
  const found = resolveLocations(text, locations);

  // Nothing inside Ukraine matched, and the message names a place on the far side of the border.
  // Unless something says the activity is aimed *at* Ukraine — a launch-scope indicator, or an
  // explicit national warning — this is reporting about somewhere else and must not become a
  // Ukrainian threat, least of all a country-wide one. Checked before the withdrawal branch: an
  // all-quiet bulletin about Kursk withdraws nothing of ours either.
  const aimedAtUkraine = matchedIndicators.some((indicator) => indicator.scope === 'launch')
    || NATIONAL_SCOPE_CUES.test(text);
  if (!found.length && FOREIGN_PLACE_PATTERN.test(text) && !aimedAtUkraine) return neutral(summary);

  // Withdrawal. Every threat token present is denied by its own clause, or the message states an
  // absence in its own right, and nothing in it anticipates rather than reports. One un-denied
  // threat token is enough to make this an assertion instead: "не фіксуємо балістики, але шахеди
  // йдуть на Одесу" is a warning.
  const signals = signalMatches(text);
  const asserted = signals.filter((signal) => !signal.negated);
  const withdrawn = signals.filter((signal) => signal.negated);
  if (!asserted.length && !ANTICIPATION_MARKERS.test(text)
      && (withdrawn.length > 0 || DE_ESCALATION_PHRASES.test(text) || ABSENCE_STATEMENTS.test(text))) {
    const withdrawnTypes = [...new Set(withdrawn.flatMap((signal) => signal.threatTypes))];
    return {
      ...neutral(summary),
      intent: 'de_escalation',
      retraction: {
        threatTypes: withdrawnTypes,
        locations: found.map(({ id, name }) => ({ id, name })),
        coverage: found.length ? 'located' : 'unspecified'
      }
    };
  }

  // A partially denied message is classified on what it asserts. "Не фіксуємо балістики, але шахеди
  // йдуть на Одесу" is a UAV warning, not a combined UAV-and-ballistic one.
  const assertedIndicators = matchedIndicators.filter(({ pattern }) => {
    const match = pattern.exec(text);
    return match !== null && !negatedAt(text, match.index, match[0].length);
  });
  const matchedContext = found.length
    ? contextIndicators.filter(({ pattern }) => pattern.test(text))
    : [];
  const matchedTypes = [...new Set([
    ...asserted.flatMap(({ threatTypes }) => threatTypes),
    ...matchedContext.flatMap(({ threatTypes }) => threatTypes)
  ])];
  const threatType: ThreatType = matchedTypes.length > 1 ? 'combined' : matchedTypes[0] ?? 'unknown';
  const nationalScope = found.length === 0
    && (assertedIndicators.length > 0 || NATIONAL_SCOPE_CUES.test(text));
  // Nothing threat-shaped survived, and nothing was withdrawn either: this is an ordinary message.
  // Saying so as `none` keeps `intent` meaningful — "очікуємо на відбій, але пильність не втрачати"
  // is neither an assertion nor a withdrawal, and calling it a threat would be a lie of convenience.
  if (threatType === 'unknown' && !matchedContext.length && !nationalScope) return neutral(summary);

  // Transit. Both spans have to name a catalogue location for this to be a redirect; otherwise the
  // message stays an ordinary threat report about whatever it did name.
  const redirect = REDIRECT_PATTERN.exec(text);
  const passedBy = redirect ? locationsWithin(redirect[1]!, found) : [];
  const towards = redirect ? locationsWithin(redirect[2]!, found) : [];
  const isRedirect = passedBy.length > 0 && towards.length > 0;

  const direction = text.match(/(?:[ув] напрямку|курс(?:ом)? на|руха(?:ється|ються) до|прямує до)\s+([^.!\n]{2,80})/iu)?.[0]
    ?? text.match(/(?:→|➡|⮕|-->|->)\s*([^.!?\n]{2,80})/u)?.[0];
  return {
    // `redirect` is still an assertion and still raises an event; what it adds is the statement that
    // the places in the "повз …" span are being passed rather than approached. Those locations stay
    // in `locations` — withdrawing them is a state decision, not a classification one — and are
    // named in `retraction` so a consumer can act on the distinction deliberately.
    intent: isRedirect ? 'redirect' : 'threat',
    threatType,
    signalThreatTypes: matchedTypes.length ? matchedTypes : ['unknown'],
    locations: found.map(({ id, name, relationType }) => ({ id, name, relationType })),
    // Country-wide only when no place inside Ukraine was named and the message is either a strategic
    // indicator or an explicit national warning. Context indicators are excluded by construction:
    // they are only collected when a location was already found.
    nationalScope,
    indicators: [...assertedIndicators.map(({ name }) => name), ...matchedContext.map(({ name }) => name)],
    directionText: direction,
    title: labels[threatType],
    summary,
    ...(isRedirect
      ? {
          retraction: {
            threatTypes: matchedTypes,
            locations: passedBy.map(({ id, name }) => ({ id, name })),
            coverage: 'located' as const
          }
        }
      : {})
  };
}

export function riskLevel(score: number): 'background' | 'elevated' | 'significant' | 'high' | 'very_high' {
  if (score < 2) return 'background';
  if (score < 4) return 'elevated';
  if (score < 6) return 'significant';
  if (score < 8) return 'high';
  return 'very_high';
}
