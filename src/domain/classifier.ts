import { detectOriginZone } from './origin-zones.js';
import type { ClassifiedMessage, RelationType, ThreatType } from '../types.js';
import {
  ADMIN_CONNECTORS, inflections, isBlockedPlaceToken, nameTokens, OBLAST_HEADS, type PlaceToken,
  RAION_HEADS, sameLexeme, tokenize
} from './place-morphology.js';

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
 * * `v3` — one correction and the vocabulary a manual read of the archive found missing.
 *
 *   The correction that matters: `v2` looked at the **first** occurrence of each threat pattern and
 *   nowhere else, so "БпЛА не фіксуємо, але БпЛА курсом на Київ" was judged entirely on the denied
 *   first "БпЛА" and filed as an all-clear — the worst available direction for this module to fail
 *   in. Every occurrence is now examined ({@link allMatches}) and one un-denied occurrence is enough
 *   to make the message an assertion. The strategic indicators carried the identical single-`exec`
 *   bug and are repaired the same way.
 *
 *   The vocabulary: the jet-powered Shahed as the channels actually inflect it (`реактив`,
 *   `реактива`, `реактивний`, `реактивних` — `v2` read only the clipped `реакт`), the Zala
 *   reconnaissance drone, the "Молнія" strike drone, and `Ударний Бп`, the abbreviation the
 *   structured bulletins use. Plus a location-gated class of **generic** nouns — `дрон`, `ракета`,
 *   `бомба` — and a bare reported direction with no weapon named at all. Both only mean something
 *   next to a Ukrainian place, and the generic nouns additionally require an operational cue, so
 *   neither a parcel-post notice nor a meme about drones can raise anything. A direction with no
 *   named type produces `unknown`, never a class carried over from an earlier message.
 * * `v4` — location resolution, rebuilt. `v3` looked for a place name as a **substring** of the
 *   message, which has no word boundary on either side, so a name resolved out of the middle of a
 *   different word: "Баришівку" produced Бар, "Обухівку" produced Обухів, "Березну" produced
 *   Березне, "Самарському р-ні" produced Самар, and "південно-західний" produced the settlement
 *   Південне — a compass bearing published as a town. Each of those is a real place on the map that
 *   the message never named, which is worse than resolving nothing: it tells that settlement's
 *   subscribers a threat was addressed to them.
 *
 *   Matching is now by whole word in any case, against a closed, generated Ukrainian declension
 *   table (`src/domain/place-morphology.ts`), so a name matches only where every one of its words
 *   equals a message word. The same change makes the inflections `v3` could not read resolvable at
 *   all — "Києвом", "Кропивницьким", "Фастова" — because the paradigm is generated rather than
 *   guessed at by clipping a suffix.
 *
 *   Three rules ride on top of it. An oblast or raion adjective names its unit only next to the head
 *   noun, which is what stops the **city** of Kyiv from being read out of "Київської області" and
 *   what makes "Київської та Чернігівської областей" name both oblasts. A span claimed by two
 *   catalogue rows is refused unless the catalogue itself ranks them. And a one-word name is never
 *   read out of a compass bearing.
 *
 *   Migration 024 lands beside it: eighteen settlements the monitoring channels name and the
 *   catalogue lacked, the Kyiv districts Троєщина and Жуляни as aliases of the city, and the removal
 *   of "запоріжжя" from the oblast's aliases so a bare "Запоріжжя" names the city the way a bare
 *   "Київ" already does.
 * * `v5` — the retrospective veto. Everything up to `v4` read a message for the vocabulary in it and
 *   nothing at all for the *tense* it was written in, so a monitoring channel's reflective essay
 *   about last night — «Цієї ночі тисячі киян знову ночували на платформах метро… Раніше масовані
 *   нальоти БпЛА… давали бодай якийсь час на підготовку. Тепер усе інакше» — matched `баліст`,
 *   `бпла`, `ракет` and `Київ` and was published as a live «Київ — комбінована загроза» with a
 *   Telegram notification. The Air Force's 09:00 night summary and the strategic-aviation channel's
 *   after-action write-up fail the same way, and both are in the gold corpus as false positives.
 *
 *   {@link assessRetrospective} reads the register instead of the vocabulary: summary bulletins
 *   («у ніч на 08 серпня», «станом на 09:00», «збито/подавлено», «підсумки», «за ніч», «вчора»),
 *   narration («цієї ночі» beside a past-tense verb, the «раніше … тепер» contrast) and prose at
 *   essay length. None of it can suppress anything on its own: a message that also carries a genuine
 *   operational NOW-marker — a stated direction, an arrow bulletin, a national «загроза
 *   застосування», a time-to-impact, the telegraphic «3х» count, a shelter instruction or a
 *   present-tense verb of motion — publishes exactly as it did in `v4`. That asymmetry is deliberate
 *   and is the whole safety argument: missing a retrospective false positive costs a reader one
 *   wrong line, suppressing a real warning costs them the warning.
 * * `v6` — the guided-bomb pattern stops matching ordinary words. `каб[а-яіїєґ]*` was a three-letter
 *   stem plus a glob, and three letters is not a stem: it matched «Кабмін», «Кабінет», «кабельний»,
 *   «кабачки» and the Russian «декабре», so "Кабмін ухвалив постанову про виплати для Харківщини"
 *   classified as a significant `guided_air_bomb` over Харківська область with 46 monitor rows able
 *   to trigger it on routine government news. It was not hypothetical: a Zhytomyr cable-factory news
 *   item published a real threat event over Житомир on 2026-08-09, and migration 029's channel
 *   re-audit hit the Russian half of the same hole («декабре» → a guided bomb over Джанкой). The
 *   pattern is now the enumerated declension of the abbreviation with a letter boundary on both
 *   sides — every weapon form the archive contains matches, nothing that merely begins with those
 *   three letters does. The long form additionally reads «керован* авіабомб*», the compound spelling
 *   of the same weapon, which the rules had never matched at all and which twelve archived messages
 *   use.
 */
export const CLASSIFIER_VERSION = 'v6';

export interface LocationLexeme {
  id: string;
  name: string;
  aliases: string[];
  /**
   * `locations.type`, used only to break a tie between two rows that spell the same.
   *
   * Optional so a test or a caller that only cares about the text can build a lexeme from a name and
   * its aliases. Absent means "not administrative", which makes the tie-break refuse rather than
   * guess.
   */
  type?: string;
  /**
   * Whether the catalogue geocoded this row, i.e. `latitude IS NOT NULL`.
   *
   * The importer never writes coordinates, so the flag is true for exactly the hand-seeded rows: the
   * oblasts, the two special cities and the oblast capitals. It is a tie-break between two rows of
   * the same name and is read for nothing else — see {@link pickAmongTied}.
   */
  geocoded?: boolean;
  /**
   * The oblast (or special city) this row sits in, walked up `locations.parent_id`.
   *
   * Read only to let a message disambiguate a name it has already qualified: "Одещина: … на
   * Південне" names one of the two settlements called Південне and not the other. Absent on the
   * oblast rows themselves, and absent from a lexeme built by hand, in which case that tie-break
   * simply does not fire.
   */
  oblastId?: string;
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
  // The КАБ half is an enumerated declension table rather than a stem plus a glob, and the reason is
  // the defect it replaces. `каб[а-яіїєґ]*` matched every Ukrainian word that merely *begins* with
  // those three letters: "Кабмін ухвалив постанову про виплати для Харківщини" classified as a
  // significant `guided_air_bomb` over Харківська область, and "Підприємство виготовляє кабельні
  // системи для автомобілів … у Житомирі" was published as a real threat event on 2026-08-09
  // (osint-zhenyok, source message 6ea8fc00-0bb5-4820-aaa9-946db5c7f96f). Migration 029 found the
  // same hole from the Russian side — «в декабре 2025 года … Джанкоя» was read as a guided bomb over
  // Джанкой — and recorded that the Ukrainian «Кабмін»/«Кабінет» case was still live.
  //
  // The archive says what the weapon actually looks like. Over 3 434 stored messages the only forms
  // that carry the weapon sense are `каб` ×78, `кабів` ×42, `каби` ×37 and `кабам` ×5
  // (case-insensitive; the channels write КАБ, КАБи, КАБів, КАБам in capitals and каб, каби, кабів,
  // кабам in the telegraphic 🟠 posts), and every one of them is the abbreviation declined as an
  // ordinary masculine hard-stem noun. The other four `каб` words in the archive — `кабінеті`,
  // `кабінєт`, `кабельні`, `кабачки` — are not the weapon in any sense.
  //
  // So the paradigm is generated and closed, the same choice `place-morphology.ts` makes for place
  // names and for the same reason: an enumerated suffix list can be read against the language and
  // argued about, while `[а-яіїєґ]*` can only be tested against the messages somebody happened to
  // look at. A stop-list (`кабмін|кабінет|кабел`) was the alternative and is rejected — it would
  // have to grow with the dictionary, and the next word it does not yet know about becomes a
  // published threat rather than a missed match.
  //
  // The two boundaries carry the rest and are what make a stop-list unnecessary: `(?<!\p{L})` keeps
  // the token out of the middle of a word («декабре», «скабеева»), `(?!\p{L})` keeps it out of
  // anything longer that starts with it («Кабмін», «Кабінет», «кабельний», «кабіна», «кабачки»).
  // Non-letters still end the token, so "КАБ-500" and "КАБи-сучки" match on the first component.
  //
  // The long form gains «керован* авіабомб*», which is the compound the channels write when they do
  // not abbreviate: twelve archived messages carry it — "🔴🔴 Загроза керованих авіабомб в
  // м. Запоріжжя…" is the standard shape — and ten of those name no КАБ anywhere, so the phrase was
  // invisible to these rules. «керован» stays required: an unguided ФАБ is a different weapon and
  // this class must not absorb it.
  ['guided_air_bomb', /((?<!\p{L})каб(?:а|у|ом|і|и|ів|ам|ами|ах)?(?!\p{L})|керован[а-яіїєґ]*\s+(?:авіаційн[а-яіїєґ]*\s+бомб|авіабомб)[а-яіїєґ]*)/iu],
  // "герань" and "мопед" are the two slang names the OSINT feeds use for a Shahed-type drone, and
  // the bare "реакт" is how they abbreviate a jet-powered one in telegraphic posts
  // ("3х реакт йдуть по межі Котельва").
  //
  // `v2` stopped at that clipped form and so read almost none of the traffic: the archive's own
  // wording is "1х реактив", "2х реактива", "реактивний керований", "пара реактивних", and none of
  // those end where `реакт(и|ів|ах|ами)` ends. The `ив…` branch takes the whole adjective, and the
  // trailing guard is what keeps it off "реактивна артилерія" and "реактивні системи залпового
  // вогню" — different weapons, the first of which is already matched as `mlrs` below. The guard is
  // a lookahead rather than a suffix list because the adjective inflects freely and the noun after
  // it is the only thing that says which weapon is meant.
  //
  // "Zala" is the reconnaissance drone the intelligence channels name in Latin script, "Молнія" the
  // strike drone they name in Cyrillic, and "Ударний Бп" the abbreviation the structured bulletins
  // use for a strike UAV ("Сумська область ◦ Ударний Бп 2 грп."). The `Бп` is only read next to
  // "ударний": the two letters alone are far too short to be evidence of anything.
  ['uav', /(бпла|ударн[а-яіїєґ]*\s+(?:дрон[а-яіїєґ]*|бп(?!\p{L}))|безпілотник[а-яіїєґ]*|шахед[а-яіїєґ]*|геран[ья][а-яіїєґ]*|мопед[а-яіїєґ]*|(?<!\p{L})реакт(?:ив[а-яіїєґ]*|и|ів|ах|ами)?(?!\p{L})(?!\s+(?:артилері|систем))|(?<!\p{L})zala(?!\p{L})|(?<!\p{L})молн[иі][яюієї](?!\p{L}))/iu],
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
 * A direction the source states in words, with no weapon named anywhere.
 *
 * "Курс на н.п. Дігтярі та Мала Дівиця!", "Один курсом на Вишгород", "У бік Броварів" — a complete
 * report to the channel's readers, and nothing in it says what is moving. Read as an `unknown`
 * threat rather than guessed at: the previous message usually named a Shahed, and inferring the
 * class from it is precisely the inference this module is forbidden to make.
 *
 * Every branch requires the direction word to be *stated*, and the word alone is never enough:
 * "курс долара" and "курси англійської" are the two shapes that would otherwise turn an exchange
 * rate into a threat. A preposition or a compass adjective has to follow, and `Курси` cannot match
 * at all — the alternation is the exact word `курс` or `курсом`, both demanding whitespace after.
 *
 * A bare "Курс Бородянка", which the feeds also write, is deliberately **not** matched: separating
 * it from "Курс долара" needs the following word to be capitalised, and a case-insensitive regex
 * cannot express that — `\p{Lu}` under `i` matches lower case too, which is how that branch turned
 * a currency report into a threat for Kyiv in review. Such messages fall back to whatever weapon
 * they name, and to nothing when they name none.
 */
const REPORTED_DIRECTION = /((?<!\p{L})курс(?:ом)?\s+(?:на|до|у|в)(?!\p{L})|(?<!\p{L})курс(?:ом)?\s+(?:північн|південн|східн|західн)|[ув]\s+напрямку|(?<!\p{L})[ув]\s+бік|прямує\s+(?:до|на|у|в)(?!\p{L})|руха(?:ється|ються)\s+(?:до|на)(?!\p{L})|трима(?:є|ють|ємо)\s+курс)/iu;

/**
 * What makes a generic noun an operational report rather than a word.
 *
 * `дрон`, `ракета` and `бомба` are ordinary nouns. They appear in news, in jokes, in a sentence
 * about a bomb shelter and in a warning that a missile is over the city, and no lexical guard tells
 * those apart. What does tell them apart is the shape of the sentence around them: a direction, a
 * count, a verb of motion, an alarm word, a launch or a strike. Requiring one of those *and* a
 * resolved Ukrainian place is what lets "⚠️ КИЇВ! УВАГА! РАКЕТА!" raise an event while "Відділення
 * видає бандероль" and "засоби захисту від дронів активовані" raise nothing.
 *
 * Deliberately excludes "уважно", which these channels append to almost every place name
 * ("Троя уважно", "Бровари - уважно"): it marks attention, not an observation, and admitting it
 * would turn the gate into no gate at all.
 */
const GENERIC_THREAT_CONTEXT = /((?<!\p{L})курс|напрямк|(?<!\p{L})[ув]\s+бік|прямує|руха(?:ється|ються)|(?<!\p{L})лет(?:ить|ять|іти)|(?<!\p{L})йд(?:е|уть)(?!\p{L})|заход(?:ить|ять)|наближ|(?<!\p{L})увага(?!\p{L})|загроз|небезпек|укритт|(?<!\p{L})тривог|(?<!\p{L})(?:за)?пуск|атаку|удар|збито|\d+\s*х?\s*(?:дрон|ракет|бомб))/iu;

/**
 * Indicators that only mean something next to a place inside Ukraine.
 *
 * "дорозвідка" — a drone re-scouting a target before a strike — is one of the most useful things the
 * monitoring channels publish, and it arrives in telegraphic form: "Одеса дорозвідка". It is kept
 * out of {@link strategicIndicators} because it must never produce a country-wide event: a bare
 * "дорозвідка" with no place attached says nothing actionable, while the same word next to a
 * resolved location is a concrete UAV signal.
 *
 * `requires` is a second gate on top of the location one, for the entries whose pattern is an
 * ordinary word rather than a weapon name. See {@link GENERIC_THREAT_CONTEXT}.
 */
const contextIndicators: Array<{ name: string; pattern: RegExp; threatTypes: ThreatType[]; requires?: RegExp }> = [
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
    pattern: /(?:→|➡|⮕|➤|-->|->)\s*\p{L}/u,
    threatTypes: []
  },
  {
    // The same statement in words instead of an arrow. Kept beside the arrow indicator and with the
    // same empty `threatTypes` for the same reason: a heading says where, never what.
    name: 'повідомлений напрямок без названого типу',
    pattern: REPORTED_DIRECTION,
    threatTypes: []
  },
  {
    // "Київ, у нас 3 дрони біля Трої", "Дніпро /Кам'янське загроза 6х дронів". A drone is a UAV —
    // that is a synonym, not an inference — so this one does carry a class, unlike the two below.
    name: 'дрони без уточнення типу',
    pattern: /(?<!\p{L})дрон(?:а|и|у|ом|ів|ам|ах|ами|і)?(?!\p{L})/iu,
    threatTypes: ['uav'],
    requires: GENERIC_THREAT_CONTEXT
  },
  {
    // "⚠️ КИЇВ! УВАГА! РАКЕТА!" — a missile, and the message does not say which kind. Filing it as
    // ballistic or cruise would be a coin toss printed as a fact, so it raises an `unknown` event.
    // The endings are enumerated rather than globbed to keep "ракетоносії" and "ракетний" out: a
    // launch platform and an adjective are not a missile over a city.
    name: 'ракета без уточнення типу',
    pattern: /(?<!\p{L})ракет(?:а|и|у|ою|ам|ах|ами|і)?(?!\p{L})/iu,
    threatTypes: [],
    requires: GENERIC_THREAT_CONTEXT
  },
  {
    // "Бомба у напрямку Юнаківки/Хотіні", "Там бомби летять". Guided or not is exactly what these
    // messages do not say, and `guided_air_bomb` would be asserting the difference. The enumerated
    // endings keep "бомбосховище" out — a shelter is the opposite of a threat.
    name: 'авіабомба без уточнення типу',
    pattern: /(?<!\p{L})бомб(?:а|и|у|ою|ам|ах|ами|і)?(?!\p{L})/iu,
    threatTypes: [],
    requires: GENERIC_THREAT_CONTEXT
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

/**
 * Every occurrence of `pattern` in `text`, as spans.
 *
 * The reason this exists instead of `pattern.exec`: a denial and the warning it is contrasted with
 * routinely name the *same* weapon — "БпЛА не фіксуємо, але БпЛА курсом на Київ" — and reading only
 * the first occurrence reduced that message to its denial and published it as an all-clear. Each
 * occurrence has to be judged against the clause it actually sits in.
 *
 * A copy carries the `g` flag rather than the shared literal being declared global: `lastIndex` is
 * mutable state on a module-level regex, and a global one left mid-string by a previous call makes
 * the *next* message's classification depend on the previous message's text.
 */
function allMatches(pattern: RegExp, text: string): Array<{ index: number; length: number }> {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))]
    .map((match) => ({ index: match.index, length: match[0].length }));
}

/** Every threat token in the message, each tagged with whether its own clause denies it. */
function signalMatches(text: string): SignalMatch[] {
  const sources: Array<{ pattern: RegExp; threatTypes: ThreatType[] }> = [
    ...patterns.map(([type, pattern]) => ({ pattern, threatTypes: [type] })),
    ...strategicIndicators.map(({ pattern, threatTypes }) => ({ pattern, threatTypes }))
  ];
  const matches: SignalMatch[] = [];
  for (const { pattern, threatTypes } of sources) {
    for (const { index, length } of allMatches(pattern, text)) {
      matches.push({ threatTypes, index, length, negated: negatedAt(text, index, length) });
    }
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
 * Як джерело промовляє курс: один словник на всі три місця, де курс розпізнається.
 *
 * ================================================================================================
 * Чому це константа, а не три регулярки
 * ================================================================================================
 *
 * Курс читають ТРИ незалежні місця: `relationFor` (щоб позначити місце як `reported_direction`),
 * `directionPhrase` (щоб зберегти дослівний текст у картку) і `REDIRECT_PATTERN` (щоб упізнати
 * транзит «повз A на B»). Доки кожне мало власний перелік фраз, вони розходилися — і розходження
 * було видно читачеві.
 *
 * Живий приклад, з якого це переписано: «Крилата ракета повз Нечаївку продовжує рух на
 * Кропивницький!». `relationFor` упізнав транзит і позначив Кропивницький як напрямок; окремий
 * перелік у видобувачі тексту слова «рух на» не мав — і картка написала «напрямок: не
 * повідомлявся» під заголовком, у якому напрямок названо прямо.
 *
 * ================================================================================================
 * Чому саме ці фрази
 * ================================================================================================
 *
 * Тільки ті, де прийменник веде за собою МІСЦЕ: «курсом на», «рухається на», «прямує до», «у бік».
 * Дієслова загального руху — «летить на», «йде на» — свідомо не входять: «летить на висоті 50
 * метрів» дало б у картку «напрямок: на висоті 50 метрів». `relationFor` від такої помилки
 * захищений каталогом (після фрази має стояти впізнане місце), а видобувач тексту — ні, і саме він
 * потрапляє людині на очі.
 */
const HEADING_LEAD =
  '[ув]\\s+напрямку|курс(?:ом)?\\s+на|руха(?:ється|ються)\\s+(?:до|на)|пряму(?:є|ють)\\s+(?:до|на)'
  + '|[ув]\\s+бік|рух(?:у)?\\s+на';

/** Стрілкові зведення: «→Кириківка/Тростянець». Той самий курс, записаний знаком. */
const ARROW_LEAD = '→|➡|⮕|➤|-->|->';

/** Чим джерело звʼязує «повз A» з «B». Спільне для `REDIRECT_PATTERN` і для `relationFor`. */
const TRANSIT_LEAD = 'на|у\\s+напрямку|в\\s+напрямку|до';

/**
 * A threat moving past one place towards another.
 *
 * Both halves have to resolve for this to be a redirect: at least one catalogue location inside the
 * "повз …" span and at least one inside the "… на …" span. When only one side resolves the message
 * is classified as an ordinary threat for whatever it did name — asserting a threat that has moved
 * on is a smaller error than withdrawing one that has not.
 *
 * Групи іменовані, бо `lead` тепер читається окремо: саме з нього й `towards` складається текст
 * напрямку для картки, коли інших ознак курсу в реченні немає.
 */
const REDIRECT_PATTERN = new RegExp(
  `(?<!\\p{L})повз\\s+(?<passed>[^.!?\\n]{2,60}?)\\s+(?<lead>${TRANSIT_LEAD})\\s+(?<towards>[^.!?\\n]{2,80})`,
  'iu'
);

// ------------------------------------------------------------------------------------------------
// Retrospection and narration (`v5`)
// ------------------------------------------------------------------------------------------------

/**
 * Past-tense and impersonal-perfect verb forms, as a closed list.
 *
 * A general Ukrainian past-tense detector is not expressible as a regex worth reviewing: the tense
 * is carried by an `-л-` suffix whose endings — `-в`, `-ла`, `-ло`, `-ли` — are also the endings of
 * ordinary nouns («число», «сила», «сталі»), so a generic rule would fire on half the language. What
 * is listed here is the verb stock the *retrospective register* is actually built from, taken from
 * the archive: what the enemy did, what the air defence did, what the readers did.
 *
 * It is only ever read as a **conjunct** — «цієї ночі» plus one of these — so the cost of the list
 * being incomplete is that one narration marker does not fire, and the cost of it being too wide is
 * bounded by the phrase it has to appear beside. Both errors point the safe way: nothing is
 * suppressed, a message merely publishes.
 */
const PAST_NARRATION = new RegExp(
  '(?<!\\p{L})(?:'
  + 'був|була|було|були'
  + '|(?:ночува|атакува|застосува|працюва|дава|трива|відбива|проводи|влучи|запусти|вдари|удари'
  + '|загину|постражда|фіксува|спостеріга)(?:в|ла|ло|ли)'
  + '|(?:при|про|від)?лет(?:ів|іла|іло|іли)'
  + '|ста(?:лося|лася|лись|лися)'
  + '|збито|подавлено|знищено|пошкоджено|зруйновано|зафіксовано|застосовано|виявлено|уражено|оголошено'
  + ')(?!\\p{L})', 'iu');

interface TextMarker {
  name: string;
  pattern: RegExp;
  /** A second condition on the same message. Present only where the phrase alone means too little. */
  requires?: RegExp;
}

/**
 * The summary bulletin: a report *about* a period that has ended.
 *
 * These are decisive on their own. «У ніч на 08 серпня противник атакував…», «Станом на 09:00…», «За
 * попередніми даними…», «ЗБИТО/ПОДАВЛЕНО 135…», «Починаючи з 13:00 було застосовано…» are not ways
 * of describing something happening now; they are the fixed opening of a bulletin whose subject is
 * over. The Air Force publishes one every morning and every one of them names weapons, places and
 * counts — which is precisely why `v4` published them as live combined threats.
 */
const RETROSPECTIVE_SUMMARY_MARKERS: TextMarker[] = [
  {
    name: 'ретроспектива: нічний підсумок',
    pattern: /(?<!\p{L})(?:підсум[а-яіїєґ]*|у\s+ніч\s+на(?!\p{L})|протягом\s+(?:ноч[іи]|доби)|за\s+(?:ніч|добу|ночі|доби)(?!\p{L})|за\s+попередн[а-яіїєґ]*\s+дан)/iu
  },
  // «Починаючи з 13:00 було застосовано…» opens an account of a window that has closed. Its obvious
  // sibling «станом на 00:42» is deliberately NOT a marker of anything: the strategic-aviation
  // channel opens its *live* hourly snapshots with it — «Приблизна ситуація в повітряному просторі
  // України станом на 00:42 … 2 реактивні БпЛА на Житомир» — and a replay over the production
  // archive showed that reading it as retrospective would have suppressed three live warnings for
  // Zhytomyr and Kharkiv. "As of an hour" is how both a summary and a snapshot begin.
  { name: 'ретроспектива: підсумок від години', pattern: /(?<!\p{L})починаючи\s+з\s+\d{1,2}[:.]\d{2}/iu },
  {
    // The morning tally, in the exact shape the Air Force writes it.
    name: 'ретроспектива: зведення збиття',
    pattern: /(?<!\p{L})(?:збито|знищено)\s*(?:\/|та\s+|і\s+)\s*подавлено/iu
  },
  { name: 'ретроспектива: вчорашній день', pattern: /(?<!\p{L})(?:вчора|учора|позавчора|напередодні)(?!\p{L})/iu },
  {
    name: 'ретроспектива: минула ніч або доба',
    pattern: /(?<!\p{L})мину(?:лої|лу|лою)\s+(?:ноч[іи]|доб[иу])/iu
  }
];

/**
 * Narration: a message written *about* the war rather than *from* it.
 *
 * Softer than a summary bulletin, and treated as such — a narration marker beside a weak operational
 * word is the grey band {@link RetrospectiveAssessment} calls `suspect`, which the rules resolve in
 * favour of publishing and `src/services/retrospective-gate.ts` may ask a model about. On its own,
 * with nothing operational anywhere in the message, it is enough.
 *
 * «цієї ночі» needs a past-tense verb beside it because the same words open an anticipation
 * («цієї ночі очікується»), and an anticipation is a warning. The «раніше … тепер» contrast needs no
 * second condition: it is the shape of an argument, and an argument is not a report.
 */
const RETROSPECTIVE_NARRATION_MARKERS: TextMarker[] = [
  {
    name: 'ретроспектива: «цієї ночі» з дієсловом минулого часу',
    pattern: /(?<!\p{L})(?:ці(?:єї|ю)\s+(?:ноч[іи]|доб[иу])|сьогодні\s+(?:вночі|вранці|зранку)|цього\s+ранку)/iu,
    requires: PAST_NARRATION
  },
  {
    name: 'ретроспектива: «раніше — тепер»',
    pattern: /(?<!\p{L})раніше(?!\p{L})[\s\S]{0,600}?(?<!\p{L})(?:тепер|нині)(?!\p{L})/iu
  }
];

/** The essay marker's name, kept beside the numbers that produce it. */
const ESSAY_MARKER = 'ретроспектива: розлога оповідь';

/**
 * Prose, measured rather than matched.
 *
 * The єРадар essay carries no dateline at all — it opens on last night and then argues about what
 * the war has become — so no phrase in it is decisive. What separates it from every operational
 * message these channels publish is its *shape*: four hundred characters and more, several
 * sentences, and sentences long enough to be prose rather than a list.
 *
 * All three shape conditions matter. Length alone would catch the arrow bulletins, which run to four
 * hundred characters of settlement names; the sentence count alone would catch a two-clause report;
 * and the mean sentence length is what tells «Кіровоградська область ◦ Ударний Бп → Богданівка,
 * Кам'янка…» (a real warning, mean ≈ 380 in one sentence — but see the strong-marker override, which
 * protects it anyway) from a paragraph of argument.
 *
 * Shape alone is still not enough, and the replay over the production archive is what proved it: the
 * strategic-aviation channel's target forecast — «Згідно деяких даних ворог може завдати удару
 * балістичними ракетами… Потенційні цілі ураження: Київ: Дарниця, Жуляни… Коли саме буде здійснено
 * атаку нам невідомо» — has exactly this shape and is *prospective*. Suppressing a forecast is a
 * different mistake from suppressing a summary, and this layer has no business making it. So the
 * essay marker additionally requires a past-tense verb ({@link PAST_NARRATION}): an essay is
 * retrospective when it is about something that already happened, and a text with no past tense
 * anywhere in it is not narrating anything.
 *
 * The numbers are calibrated against the 191 hand-labelled messages in
 * `tests/fixtures/classifier-gold.json` and against a full `v4 → v5` replay of the production
 * archive: on both, no message a reviewer read as a live threat reaches all four conditions.
 */
const ESSAY_MIN_CHARACTERS = 400;
const ESSAY_MIN_SENTENCES = 3;
const ESSAY_MIN_MEAN_SENTENCE = 45;

function readsAsEssay(text: string): boolean {
  if (!PAST_NARRATION.test(text)) return false;
  const body = text.replace(/\s+/gu, ' ').trim();
  if (body.length < ESSAY_MIN_CHARACTERS) return false;
  const sentences = body.split(/[.!?…]+[\s"»]/u).map((part) => part.trim()).filter(Boolean);
  if (sentences.length < ESSAY_MIN_SENTENCES) return false;
  const mean = sentences.reduce((total, sentence) => total + sentence.length, 0) / sentences.length;
  return mean >= ESSAY_MIN_MEAN_SENTENCE;
}

/**
 * What says a message is reporting something happening **now**, in the strong sense.
 *
 * Every entry states live geometry or immediacy and cannot be produced by narrating a finished
 * night: a course, an arrow, the Air Force's own national warning phrase, a time-to-impact, the
 * telegraphic «3х» count these channels use for targets in the air, a shelter instruction, or a verb
 * of motion in the present tense. One of these is an absolute veto on the veto — the message
 * publishes, whatever else it says.
 *
 * `(?:за)?пуск` is deliberately **not** here even though a launch is operational: «Пуски
 * проводилися з дронопорту "Цимбулова"» is the after-action write-up this release exists to stop
 * publishing. It sits in the weak list instead, where it routes to the grey band rather than to a
 * veto.
 */
const OPERATIONAL_NOW_STRONG: TextMarker[] = [
  { name: 'now: напрямок руху', pattern: REPORTED_DIRECTION },
  { name: 'now: стрілка-бюлетень', pattern: /(?:→|➡|⮕|➤|-->|->)\s*\p{L}/u },
  { name: 'now: національне попередження', pattern: /загроз[а-яіїєґ]*\s+застосуванн/iu },
  { name: 'now: підлітний час', pattern: /(?<!\p{L})\d+\s*хв/iu },
  { name: 'now: телеграфний рахунок цілей', pattern: /(?<!\p{L})\d+\s*х(?!\p{L})/iu },
  { name: 'now: вимога укриття', pattern: /(?<!\p{L})(?:[ув]|до)\s+укритт|(?<!\p{L})(?:негайно|терміново)(?!\p{L})/iu },
  {
    name: 'now: рух у теперішньому часі',
    pattern: /(?<!\p{L})(?:лет(?:ить|ять)|йд(?:е|уть)|заход(?:ить|ять)|наближ[а-яіїєґ]*|прямує|руха(?:ється|ються))(?!\p{L})/iu
  }
];

/**
 * Words that *might* mean "now" and might equally be part of the story being told.
 *
 * «Атака триває» in the middle of a morning summary, «у повітряному просторі» in a sentence about
 * what was in it last night, «пуски» in an after-action account of where they came from. Each is
 * real evidence and none of it is conclusive, which is exactly the definition of the grey band: a
 * narration marker plus one of these is `suspect`, and the deterministic answer for `suspect` is to
 * publish.
 */
const OPERATIONAL_NOW_WEAK: TextMarker[] = [
  {
    name: 'now?: теперішній момент',
    pattern: /(?<!\p{L})(?:зараз|наразі|щойно|цієї\s+хвилини|у\s+цю\s+хвилину|у\s+цей\s+момент)(?!\p{L})/iu
  },
  { name: 'now?: триває', pattern: /(?<!\p{L})трива(?:є|ють)(?!\p{L})/iu },
  { name: 'now?: у повітряному просторі', pattern: /(?<!\p{L})(?:[ув]\s+повітр[а-яіїєґ]*|повітряному\s+просторі)/iu },
  { name: 'now?: пуски', pattern: /(?<!\p{L})(?:за)?пуск[а-яіїєґ]*/iu },
  { name: 'now?: увага', pattern: /(?<!\p{L})увага(?!\p{L})/iu }
];

/**
 * What the retrospection rules concluded about one message.
 *
 * `vetoed` — the rules refuse it: it reads as a report about a period that has ended and carries
 * nothing operational. {@link significanceRejection} answers `retrospective` and the pipeline
 * archives it without raising anything.
 *
 * `suspect` — the grey band. The classification is **unchanged** and the message publishes; the flag
 * exists so `src/services/retrospective-gate.ts` may put one narrow question to a model before the
 * event is ingested. A model that is off, slow, broken or over budget changes nothing.
 *
 * `none` — either nothing retrospective fired, or something did and a strong operational marker
 * overrode it.
 */
export type RetrospectiveVerdict = 'none' | 'suspect' | 'vetoed';

export interface RetrospectiveAssessment {
  verdict: RetrospectiveVerdict;
  /** Names of the markers that fired, in declaration order. Archived as classifier indicators. */
  markers: string[];
  /** Names of the operational markers that fired, strong first. Empty when nothing did. */
  nowMarkers: string[];
}

function firedMarkers(markers: TextMarker[], text: string): string[] {
  return markers
    .filter(({ pattern, requires }) => pattern.test(text) && (!requires || requires.test(text)))
    .map(({ name }) => name);
}

/**
 * Reads the register a message is written in, independently of the vocabulary in it.
 *
 * Pure and exported so the bands can be tested one marker at a time, and so a reviewer can ask the
 * question about a message without running the whole classifier.
 *
 * The order of the three tests is the safety argument in code:
 *
 *  1. **Nothing retrospective fired** — `none`. This is the overwhelming majority of the traffic and
 *     costs one pass over a handful of regexes.
 *  2. **A strong operational marker fired** — `none`, whatever else the message says. A message that
 *     narrates last night *and* states a course is a warning with context attached, and the context
 *     is not permitted to swallow the warning.
 *  3. Otherwise the message is retrospective, and the only remaining question is how sure the rules
 *     are: a **summary** marker is decisive on its own, and a **narration** marker is decisive only
 *     when nothing operational at all is present. Narration beside a weak operational word is the
 *     grey band.
 */
export function assessRetrospective(text: string): RetrospectiveAssessment {
  const summary = firedMarkers(RETROSPECTIVE_SUMMARY_MARKERS, text);
  const narration = firedMarkers(RETROSPECTIVE_NARRATION_MARKERS, text);
  if (readsAsEssay(text)) narration.push(ESSAY_MARKER);
  const markers = [...summary, ...narration];
  if (!markers.length) return { verdict: 'none', markers: [], nowMarkers: [] };

  const strong = firedMarkers(OPERATIONAL_NOW_STRONG, text);
  const weak = firedMarkers(OPERATIONAL_NOW_WEAK, text);
  const nowMarkers = [...strong, ...weak];
  if (strong.length) return { verdict: 'none', markers, nowMarkers };
  if (summary.length || !weak.length) return { verdict: 'vetoed', markers, nowMarkers };
  return { verdict: 'suspect', markers, nowMarkers };
}

/**
 * Заголовок події за класом. Експортовано для модельного класифікатора
 * (`src/services/codex-classifier.ts`): подія, збудована з вердикту моделі, має читатися на карті
 * тими самими словами, що й подія правил, — заголовок не є місцем, де читач має вгадувати автора.
 */
export const THREAT_EVENT_TITLES: Record<ThreatType, string> = {
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
const labels = THREAT_EVENT_TITLES;

function relationFor(text: string, alias: string): RelationType {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:${HEADING_LEAD})\\s+(?:.{0,24})${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  // The arrow bulletin marks its targets with an arrow and separates them with a slash:
  // "→Кириківка/Тростянець". Everything after the arrow up to the sentence end is a target list, so
  // the second name is as much a direction as the first.
  if (new RegExp(`(?:${ARROW_LEAD})\\s*[^.!?\\n]{0,40}?${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  // Transit: "Балістика повз Бровари на Бориспіль". The place being passed and the place being
  // approached carry different meanings for a reader under it, and only the second is a direction.
  // The first keeps `mentioned`, which is what "повз" says — something went by, it was not aimed
  // there.
  //
  // Звʼязка береться з `TRANSIT_LEAD`, а не з голого «на». Доки тут стояло саме «на», «повз Бровари
  // ДО Борисполя» лишало Бориспіль звичайною згадкою — при тому що `REDIRECT_PATTERN` те саме
  // речення вже читав як транзит. Наслідок був не косметичний: `planStep` будує відрізок «A→B» лише
  // коли другий кінець має тип `reported_direction`, тож вектор для такого речення не малювався.
  if (new RegExp(`повз\\s+[^.!\\n]{0,40}?(?:${TRANSIT_LEAD})\\s+(?:.{0,10})${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  if (new RegExp(`(загроза|небезпека|увага для)(?:.{0,45})${escaped}`, 'iu').test(text)) {
    return 'explicit_threat';
  }
  if (/наслідк|влучан|пошкоджен|вибух/iu.test(text)) return 'aftermath';
  return 'mentioned';
}

const HEADING_PHRASE = new RegExp(`(?:${HEADING_LEAD})\\s+[^.!\\n]{2,80}`, 'iu');
const ARROW_PHRASE = new RegExp(`(?:${ARROW_LEAD})\\s*[^.!?\\n]{2,80}`, 'u');

/**
 * Дослівний уривок, у якому джерело назвало курс, або `undefined`.
 *
 * Порядок — від найпрямішого до найкосвеннішого, і третій крок є головним у цій функції: коли
 * речення не має ані фрази курсу, ані стрілки, але Є транзитом «повз A на B», курс у ньому названо
 * не менш прямо — просто іншою конструкцією. `REDIRECT_PATTERN` цей розбір уже зробив, тож замість
 * четвертої регулярки береться його результат.
 *
 * Повертається саме те, що написало джерело, без переказу: картка підписує це поле словами
 * «напрямок повідомлено джерелом», і будь-яке наше перефразування зробило б підпис неправдою.
 */
function directionPhrase(text: string, redirect: RegExpExecArray | null): string | undefined {
  const heading = text.match(HEADING_PHRASE)?.[0];
  if (heading) return heading.trim();
  const arrow = text.match(ARROW_PHRASE)?.[0];
  if (arrow) return arrow.trim();
  const groups = redirect?.groups;
  return groups?.lead && groups.towards ? `${groups.lead} ${groups.towards}`.trim() : undefined;
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
 * Four conditions. The message must not read as a report about a period that has ended — see
 * {@link assessRetrospective}. The intent has to be an assertion — a withdrawal is not a threat,
 * however much threat vocabulary it contains. Something threat-shaped has to have been recognised.
 * And, the structural answer to satire, quotation and idle chatter, **a threat event has to be
 * somewhere**: either the message resolves a Ukrainian location, or it carries a strategic indicator
 * or an explicit national warning that makes it country-wide. A meme that says "шахед" and nothing
 * else names no place, so it raises nothing, whether or not any humour marker gave it away.
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
export type SignificanceRejection =
  'not_an_assertion' | 'no_threat_recognised' | 'no_location' | 'retrospective';

export function significanceRejection(classified: ClassifiedMessage): SignificanceRejection | null {
  // First, and as its own reason. A vetoed message would otherwise be reported as
  // `not_an_assertion`, which is true of its `intent` and useless as a finding: "the rules read no
  // assertion" and "the rules read an assertion about last night" are different things to know, and
  // only the second one tells a reviewer to go and read the message.
  if (classified.retrospective?.verdict === 'vetoed') return 'retrospective';
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
   * Not the declared alias. A name is matched in whatever case the message used — "Києвом" resolves
   * "Київ" — and every downstream regex that has to find the place *in the text* has to look for the
   * form the text uses. Building "→\s*…київ" against a message that says "→Гути/Богодухів" finds
   * nothing, and the relation silently degrades to `mentioned`.
   */
  needle: string;
}

/**
 * An administrative unit named by an adjective plus a head noun.
 *
 * "Київська" is an adjective; it is the oblast only next to "область". Keeping the two apart is what
 * stops the **city** of Kyiv from being read out of "Київської області" and what lets
 * "Київської та Чернігівської областей" — one head noun, two adjectives — name both oblasts.
 */
interface AdminUnit {
  location: LocationLexeme;
  order: number;
  kind: 'oblast' | 'raion';
}

interface AliasEntry {
  location: LocationLexeme;
  order: number;
  /** Comparison keys of the alias, in order. Never empty. */
  tokens: string[];
}

interface CatalogueIndex {
  /**
   * Alias entries reachable from one message token, keyed by **every case form** of the alias's
   * first word. Built once per catalogue so a message costs one map lookup per token rather than a
   * scan over six hundred catalogue rows.
   */
  byFirstToken: Map<string, AliasEntry[]>;
  /** Administrative adjectives, keyed the same way. */
  adminByForm: Map<string, AdminUnit[]>;
}

/** A catalogue name of the shape "<adjective> область" / "<adjective> район". */
const ADMIN_NAME = /^(.+?)\s+(область|район)$/u;

function pushInto<T>(index: Map<string, T[]>, key: string, value: T): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(value); else index.set(key, [value]);
}

/**
 * Builds the lookup structures for one catalogue.
 *
 * ## The precedence rule for administrative adjectives, and why it is asymmetric
 *
 * An oblast adjective is feminine ("Київська", "Чернігівська") and a raion adjective is masculine
 * ("Броварський", "Кропивницький"). That accident of Ukrainian grammar decides how far each one may
 * be trusted on its own, and the catalogue has already relied on it once: `raionAliases` emits the
 * bare masculine adjective as an alias precisely because it "cannot shadow an oblast the way a bare
 * feminine one would".
 *
 *   * **A bare oblast adjective names the oblast.** "чернігівська реактивні ще" is a real archive
 *     message and it means the oblast. Nothing else in the catalogue spells that way — no settlement
 *     is called Чернігівська — and the city can no longer be read out of it, because "чернігів" is
 *     not a word-for-word match for "чернігівська". A longer name that merely *starts* with the
 *     adjective ("Чернігівська територіальна громада", an alias of the raion) still wins, because a
 *     longer name takes the text it covers.
 *   * **A bare raion adjective does not name the raion.** It collides head-on with a settlement:
 *     "БпЛА над Кропивницьким" means the **city**, and under the old longest-name-first rule the
 *     raion won every time. The bare alias is therefore dropped from the free-text index and the
 *     raion is reached through {@link adminCandidates}, which requires the head noun "район" —
 *     which is how every feed that means the raion actually writes it.
 *
 * The alias itself stays in the catalogue untouched, so the alert-channel lookup in
 * `src/services/ingestion.ts` — which matches a published label exactly and never sees free prose —
 * is unaffected either way.
 */
function buildIndex(locations: LocationLexeme[]): CatalogueIndex {
  const index: CatalogueIndex = { byFirstToken: new Map(), adminByForm: new Map() };
  locations.forEach((location, order) => {
    const admin = ADMIN_NAME.exec(location.name);
    const adjective = admin ? nameTokens(admin[1]!) : [];
    const kind = admin && adjective.length === 1
      ? (admin[2] === 'область' ? 'oblast' as const : 'raion' as const)
      : null;
    if (kind) {
      const unit: AdminUnit = { location, order, kind };
      for (const form of inflections(adjective[0]!)) pushInto(index.adminByForm, form, unit);
    }
    const spellings = [location.name, ...location.aliases,
      ...(kind === 'oblast' ? [adjective[0]!] : [])];
    for (const alias of spellings) {
      const tokens = nameTokens(alias);
      if (!tokens.length) continue;
      if (kind === 'raion' && tokens.length === 1 && tokens[0] === adjective[0]) continue;
      const entry: AliasEntry = { location, order, tokens };
      for (const form of inflections(tokens[0]!)) pushInto(index.byFirstToken, form, entry);
    }
  });
  return index;
}

/**
 * One index per catalogue array, keyed on the array itself.
 *
 * The catalogue is loaded once and handed to every message of a run — the live pipeline, the replay
 * and the gold corpus all pass the same array thousands of times — so building the index per call
 * would dominate the cost of classification. A `WeakMap` means a catalogue that is reloaded simply
 * drops out.
 */
const catalogueIndexes = new WeakMap<LocationLexeme[], CatalogueIndex>();

function indexFor(locations: LocationLexeme[]): CatalogueIndex {
  const cached = catalogueIndexes.get(locations);
  if (cached) return cached;
  const built = buildIndex(locations);
  catalogueIndexes.set(locations, built);
  return built;
}

interface Candidate {
  location: LocationLexeme;
  order: number;
  /** Number of words the name spans; a longer name takes the text it covers. */
  words: number;
  start: number;
  end: number;
}

/** Candidates from ordinary names and aliases: every word matched as a whole word, in any case. */
function aliasCandidates(tokens: PlaceToken[], index: CatalogueIndex): Candidate[] {
  const candidates: Candidate[] = [];
  tokens.forEach((token, position) => {
    for (const entry of index.byFirstToken.get(token.key) ?? []) {
      // A one-word name read out of a compass bearing or an ordinary Ukrainian word is the failure
      // mode this guard exists for; a name of two words or more carries its own evidence, and a
      // message that spells the name exactly as the catalogue does is naming the place.
      if (entry.tokens.length === 1 && isBlockedPlaceToken(token.key, token.key !== entry.tokens[0])) continue;
      const last = position + entry.tokens.length - 1;
      if (last >= tokens.length) continue;
      const matched = entry.tokens.every((name, offset) => sameLexeme(name, tokens[position + offset]!.key));
      if (!matched) continue;
      candidates.push({
        location: entry.location, order: entry.order, words: entry.tokens.length,
        start: token.start, end: tokens[last]!.end
      });
    }
  });
  return candidates;
}

/**
 * Candidates from an administrative adjective licensed by a head noun.
 *
 * The walk runs backwards from the head so that one head noun can license a coordinated list:
 * "по межі Київської та Чернігівської областей" reaches both adjectives, and
 * "у Київській, Чернігівській та Сумській областях" reaches all three. Anything that is neither an
 * adjective of the same kind nor a connector ends the chain, and the chain is bounded so a head noun
 * cannot reach across a sentence.
 *
 * The span recorded is the **adjective alone**, never the adjective plus the head. Two coordinated
 * oblasts would otherwise claim overlapping spans and the outer one would swallow the inner.
 */
const ADMIN_CHAIN_LIMIT = 6;

function adminCandidates(tokens: PlaceToken[], index: CatalogueIndex): Candidate[] {
  const candidates: Candidate[] = [];
  tokens.forEach((token, position) => {
    const kind = OBLAST_HEADS.has(token.key) ? 'oblast' : RAION_HEADS.has(token.key) ? 'raion' : null;
    if (!kind) return;
    for (let cursor = position - 1; cursor >= 0 && position - cursor <= ADMIN_CHAIN_LIMIT; cursor -= 1) {
      const previous = tokens[cursor]!;
      const units = (index.adminByForm.get(previous.key) ?? []).filter((unit) => unit.kind === kind);
      if (units.length) {
        for (const unit of units) {
          candidates.push({
            location: unit.location, order: unit.order, words: 1,
            start: previous.start, end: previous.end
          });
        }
        continue;
      }
      if (!ADMIN_CONNECTORS.has(previous.key)) return;
    }
  });
  return candidates;
}

/**
 * The one location a span names, or `null` when the span is ambiguous.
 *
 * The same rule `pickLocationMatch` applies to the alert-channel lookup, for the same reason:
 * refusing is the only safe answer when a name has two referents, because publishing either one
 * tells half the subscribers a threat is somewhere it is not. Ukraine really does hold two Південне,
 * two Городок and a Миколаїв that is not the oblast capital, and the catalogue holds a settlement
 * for only one of the several Обухівки and Погреби on the map.
 *
 * Three tie-breaks are tried, strongest evidence first.
 *
 *  1. **Administrative rank.** An oblast or a special city outranks a settlement of the same name.
 *  2. **The message's own oblasts.** "Одещина: реактив на Коблеве / Південне" names the oblast that
 *     contains exactly one of the two Південне, so the message has answered the question itself.
 *     This is the only tie-break that reads the text, and it reads nothing but places already
 *     resolved unambiguously.
 *  3. **Seeded rank.** Coordinates are the catalogue's own marker of a first-order settlement: they
 *     are set on the twenty-five oblasts, the two special cities and the seeded oblast capitals, and
 *     on nothing the KATOTTG importer writes. That keeps a bare "Миколаїв" the oblast capital.
 *
 * When none of the three leaves a single row, the span resolves to nothing. "Городок" — two KATOTTG
 * rows, neither seeded, in two oblasts the message does not name — stays refused.
 */
function pickAmongTied(tied: Candidate[], namedOblasts: ReadonlySet<string>): Candidate | null {
  const narrow = (candidates: Candidate[], keep: (candidate: Candidate) => boolean) => {
    const kept = candidates.filter(keep);
    return kept.length ? kept : candidates;
  };
  let finalists = narrow(tied, ({ location }) =>
    location.type === 'oblast' || location.type === 'special_city');
  finalists = narrow(finalists, ({ location }) =>
    !!location.oblastId && namedOblasts.has(location.oblastId));
  finalists = narrow(finalists, ({ location }) => !!location.geocoded);
  return new Set(finalists.map(({ location }) => location.id)).size === 1 ? finalists[0]! : null;
}

/**
 * Drops every candidate whose exact span is claimed by more than one location.
 *
 * Run in two passes so the oblast tie-break has something to read: the first pass keeps only the
 * spans that were never in doubt, and the oblasts among those — plus the oblast each of them sits
 * in — are the context the second pass uses. An ambiguous span therefore never disambiguates
 * another ambiguous span, which would make the result depend on the order they were found in.
 */
function resolveSpanCollisions(candidates: Candidate[]): Candidate[] {
  const bySpan = new Map<string, Candidate[]>();
  for (const candidate of candidates) pushInto(bySpan, `${candidate.start}:${candidate.end}`, candidate);
  const groups = [...bySpan.values()];
  const unambiguous = groups.filter((tied) => new Set(tied.map(({ location }) => location.id)).size === 1);
  const namedOblasts = new Set(unambiguous.flatMap(([candidate]) => [
    ...(candidate!.location.type === 'oblast' || candidate!.location.type === 'special_city'
      ? [candidate!.location.id] : []),
    ...(candidate!.location.oblastId ? [candidate!.location.oblastId] : [])
  ]));
  const kept: Candidate[] = [];
  for (const tied of groups) {
    if (new Set(tied.map(({ location }) => location.id)).size === 1) { kept.push(...tied); continue; }
    const winner = pickAmongTied(tied, namedOblasts);
    if (winner) kept.push(...tied.filter(({ location }) => location.id === winner.location.id));
  }
  return kept;
}

/**
 * Locations named in `text`, with longer place names taking the text they cover.
 *
 * Matching is by whole word in any case: the message is cut into tokens, each catalogue name is cut
 * into tokens, and a name matches only where every one of its words equals a message word modulo
 * declension (see `src/domain/place-morphology.ts`). That is what makes "Баришівку" unreachable from
 * "Бар" and "південно-західний" unreachable from "Південне" — under the substring rule this replaced,
 * both resolved, and each one put a real settlement on the map that the message never named.
 *
 * A longer name still takes the text it covers, so a shorter one only survives where it occurs
 * outside every longer match: "Київщина та місто Київ" resolves both, "Київська область" alone
 * resolves only the oblast.
 */
function resolveLocations(text: string, locations: LocationLexeme[]): ResolvedLocation[] {
  const normalized = text.toLocaleLowerCase('uk-UA');
  const tokens = tokenize(normalized);
  const index = indexFor(locations);
  const candidates = resolveSpanCollisions([
    ...aliasCandidates(tokens, index),
    ...adminCandidates(tokens, index)
  ]);

  const byLocation = new Map<string, Candidate[]>();
  for (const candidate of candidates) pushInto(byLocation, candidate.location.id, candidate);

  // Longest name first, so a name nested inside another cannot claim its text. The remaining
  // tie-breaks are on the catalogue order alone: nothing about the result may depend on the order
  // two equally long candidates happened to be generated in.
  const ranked = [...byLocation.values()]
    .map((group) => [...group].sort((a, b) => (b.end - b.start) - (a.end - a.start))!)
    .sort((a, b) => b[0]!.words - a[0]!.words
      || (b[0]!.end - b[0]!.start) - (a[0]!.end - a[0]!.start)
      || a[0]!.order - b[0]!.order);

  const claimed: Array<[number, number]> = [];
  const kept: Array<ResolvedLocation & { order: number }> = [];
  for (const group of ranked) {
    const free = group.filter(({ start, end }) => !claimed.some(([from, to]) => start >= from && end <= to));
    if (!free.length) continue;
    const first = free[0]!;
    claimed.push(...free.map(({ start, end }) => [start, end] as [number, number]));
    const needle = normalized.slice(first.start, first.end);
    kept.push({
      id: first.location.id, name: first.location.name,
      relationType: relationFor(text, needle), needle, order: first.order
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
  const assertedIndicators = matchedIndicators.filter(({ pattern }) =>
    allMatches(pattern, text).some(({ index, length }) => !negatedAt(text, index, length)));
  // Context indicators are gated on a resolved Ukrainian place, and the generic-noun ones on an
  // operational cue as well. Both gates are the whole reason those patterns are allowed to be
  // ordinary words: neither "дрон" nor "ракета" is evidence of anything until the message also says
  // where and shows the shape of a report.
  const matchedContext = found.length
    ? contextIndicators.filter(({ pattern, requires }) => pattern.test(text) && (!requires || requires.test(text)))
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
  const passedBy = redirect ? locationsWithin(redirect.groups!.passed!, found) : [];
  const towards = redirect ? locationsWithin(redirect.groups!.towards!, found) : [];
  const isRedirect = passedBy.length > 0 && towards.length > 0;

  const direction = directionPhrase(text, redirect);
  const assertion: ClassifiedMessage = {
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
    // Зона походження — з ТЕКСТУ, не з класу зброї. `detectOriginZone` мовчить, коли джерело не
    // назвало, звідки саме; порожнє значення тут — нормальний і найчастіший результат.
    originZone: detectOriginZone(text)?.id ?? null,
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

  // ---- The retrospective veto, applied last and only to something that would otherwise publish ---
  //
  // Placing it here is the whole of the blast-radius argument. Everything above has already returned
  // for a withdrawal, for a foreign event, for satire and for a message with nothing threat-shaped
  // in it, and `significanceRejection` is asked before anything is changed — so the veto can only
  // ever act on a classification that was about to become an event, and its only possible effect is
  // to stop that. It cannot create an assertion, cannot widen one, cannot turn an all-clear back
  // into a threat, and cannot reach a message the pipeline was already going to discard.
  const retrospective = assessRetrospective(text);
  if (retrospective.verdict === 'none' || significanceRejection(assertion) !== null) return assertion;
  if (retrospective.verdict === 'suspect') {
    // Unchanged, and published. The flag and the marker names travel with it so the grey band is
    // visible in the archive whether or not a model is ever asked about it.
    return {
      ...assertion,
      indicators: [...assertion.indicators, ...retrospective.markers],
      retrospective: { verdict: 'suspect', markers: retrospective.markers }
    };
  }
  // Vetoed. The threat classes that matched are kept as candidates and the markers as indicators —
  // "why did this raise nothing" has to be answerable from the archive row alone — but the locations
  // and the class are not: this message asserts a threat about nowhere, and recording Kyiv as an
  // asserted location of a message the rules refused would put it into exactly the analytics the
  // refusal exists to keep it out of.
  return {
    ...neutral(summary),
    signalThreatTypes: assertion.signalThreatTypes,
    indicators: [...assertion.indicators, ...retrospective.markers],
    retrospective: { verdict: 'vetoed', markers: retrospective.markers }
  };
}

export function riskLevel(score: number): 'background' | 'elevated' | 'significant' | 'high' | 'very_high' {
  if (score < 2) return 'background';
  if (score < 4) return 'elevated';
  if (score < 6) return 'significant';
  if (score < 8) return 'high';
  return 'very_high';
}
