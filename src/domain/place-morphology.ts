/**
 * Ukrainian morphology for finding catalogue place names in free text.
 *
 * ## Why this module exists
 *
 * The classifier used to look for a place name as a *substring* of the message. Ukrainian inflects
 * every place name, so a substring test is the cheapest way to catch "Богодухові" with the alias
 * "Богодухів" — and it is also the reason the classifier invented geography. A substring has no
 * left or right boundary: "Бар" is inside "Баришівку", "Обухів" inside "Обухівку", "Березне" (after
 * the old whole-string stemmer clipped it to "березн") inside "Березну", and "Південне" — clipped to
 * "південн" — inside "південно-західний", so a compass direction resolved as a town. Those are not
 * near misses. Each one puts a **different, real settlement** on the map and tells its subscribers a
 * threat was addressed to them.
 *
 * The replacement is a full-token match modulo declension: the message is cut into tokens, the
 * catalogue name is cut into tokens, and a name matches only where every one of its tokens equals a
 * message token *as a whole word*, allowing exactly the case endings Ukrainian actually forms. "Бар"
 * can never reach "Баришівку" because "баришівку" is not a form of "бар"; no boundary logic, no
 * prefix rule and no stem-length heuristic is involved.
 *
 * ## How the declension is decided, and why it is a generator rather than a stemmer
 *
 * A symmetric stemmer — strip an ending from both sides and compare the remainders — cannot tell
 * "Березну" (accusative of the feminine **Березна**) from "Березне" (a neuter adjectival name whose
 * accusative is unchanged). Both reduce to "березн". Generating the paradigm instead keeps the
 * distinction: {@link inflections} of "березне" is a closed set that contains "березного",
 * "березному" and "березним" and does **not** contain "березну", so the message resolves nothing,
 * which is the honest answer when the settlement it names is not in the catalogue.
 *
 * Each paradigm is picked by the shape of the nominative and is a closed, enumerated list of
 * endings. {@link PARADIGMS} is ordered and the first matching entry wins; the word itself is always
 * a form of itself. Nothing here consults a dictionary, a model or the network — the same input
 * always produces the same set, and `place-morphology.test.ts` prints the generated table for the
 * names the archive actually uses so a reviewer can read what the rules claim.
 *
 * ## Over-generation, and the two stop lists
 *
 * A generator applied to an alias that is *already* an oblique form ("сум", "києва") produces forms
 * that are not words. Junk forms are harmless — nothing in a message matches them — right up until
 * one collides with an ordinary Ukrainian word, and then the classifier reads "мені" as the town of
 * Мена. Two closed lists bound that:
 *
 *   * {@link COMPASS_TOKEN} — compass points and bearings. Required in its own right: a direction is
 *     never a place, whatever it spells.
 *   * {@link NEVER_A_PLACE} — ordinary words that a generated paradigm can reach. Each entry was
 *     found by running the matcher over the whole archive and reading every resolution it produced,
 *     not by imagination; the list is meant to be extended the same way.
 *
 * Both are applied to the **message** token, and only to a single-token name: a name of two words or
 * more carries its own boundary evidence, so "Південне Місто" would still be reachable if the
 * catalogue ever held it.
 */

/**
 * Apostrophe characters folded out of a comparison key.
 *
 * The same name arrives spelled with `'`, `’` and `ʼ` from the KATOTTG workbook, the alert APIs and
 * the Telegram channels — "Зазим'я", "Зазим’я", "Зазимʼя" — and the archive also carries the
 * Russified "Зазим'є". Folding the character away makes all of them one key. It is folded from the
 * *key* only, never from the text, so the spans this module reports still index the original string.
 */
const APOSTROPHES = /['‘’ʼ`´]/gu;

export interface PlaceToken {
  /** Lower-cased, apostrophe-free form used for every comparison. */
  key: string;
  /** Offset of the token in the lower-cased text it was cut from. */
  start: number;
  /** Offset just past the token. */
  end: number;
}

/**
 * One word, including internal apostrophes and hyphens.
 *
 * Keeping the hyphen inside the token is what makes "південно-західний" a single word rather than
 * the two words "південно" and "західний", and it keeps "Івано-Франківськ" and "Кам'янець-
 * Подільський" whole. A trailing hyphen or apostrophe is punctuation and stays outside.
 */
const TOKEN_PATTERN = /[\p{L}\p{Nd}]+(?:['‘’ʼ`´-][\p{L}\p{Nd}]+)*/gu;

export function tokenize(lowered: string): PlaceToken[] {
  const tokens: PlaceToken[] = [];
  for (const match of lowered.matchAll(TOKEN_PATTERN)) {
    tokens.push({
      key: match[0].replace(APOSTROPHES, ''),
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

/** The comparison keys of a catalogue name or alias, in order. */
export function nameTokens(name: string): string[] {
  return tokenize(name.toLocaleLowerCase('uk-UA')).map((token) => token.key);
}

function suffixed(stem: string, endings: readonly string[]): string[] {
  return endings.map((ending) => stem + ending);
}

/**
 * The і↔о / ї↔є alternation Ukrainian performs when a closed final syllable opens.
 *
 * Київ → Києва, Фастів → Фастова, Харків → Харкова, Ріг → Рогу. Without it the instrumental
 * "Києвом" and the genitive "Фастова" are unreachable from the nominative, which is precisely the
 * shape the archive writes them in. The rule is written as a closed rewrite on the final syllable,
 * not as a general vowel rule: it fires only on a word-final `і` (or `ї`) plus one consonant.
 */
function openSyllableStems(word: string): string[] {
  const stems: string[] = [];
  if (/їв$/u.test(word)) stems.push(`${word.slice(0, -2)}єв`);
  const alternated = word.replace(/і([бвгґджзклмнпрстфхцчшщ])$/u, 'о$1');
  if (alternated !== word) stems.push(alternated);
  return stems;
}

interface Paradigm {
  /** Name printed by the audit test. */
  name: string;
  /** Nominative shape this paradigm claims. */
  test: RegExp;
  /** Every form the paradigm licenses, the word itself excluded (it is always added). */
  forms: (word: string) => string[];
}

/**
 * Declension classes, tried in order; the first whose `test` matches owns the word.
 *
 * Only the classes Ukrainian settlement, raion and oblast names actually belong to are listed. A
 * word that matches none of them (an abbreviation, a Latin string, a three-letter name) is left
 * uninflected and matches literally.
 */
const PARADIGMS: readonly Paradigm[] = [
  {
    // Прикметникові чоловічого роду: Кропивницький, Броварський, Харківський, Кривий (Ріг).
    // "Кропивницьким" — the instrumental the archive writes "БпЛА над Кропивницьким" in — is here.
    name: 'прикметник ч. р. (-ий/-ій)',
    test: /(?:ий|ій)$/u,
    forms: (word) => (word.endsWith('ій')
      ? suffixed(word.slice(0, -2), ['ій', 'ього', 'ьому', 'ім', 'їм'])
      : suffixed(word.slice(0, -2), ['ий', 'ого', 'ому', 'им', 'ім']))
  },
  {
    // Прикметникові середнього роду: Березне, Вишневе, Озерне, Південне, Синельникове, Рівне.
    // The class that makes "Березну" unreachable: a neuter adjectival name has no -у form at all.
    name: 'прикметник с. р. (-е)',
    test: /е$/u,
    forms: (word) => suffixed(word.slice(0, -1), ['е', 'ого', 'ому', 'им', 'ім'])
  },
  {
    // Іменники ж./с. роду м'якої групи: Запоріжжя, Білопілля, Зазим'я, Городня, Мала Дівиця.
    // `є` is listed because the archive also spells Зазим'я as "Зазим'є".
    name: 'м\'яка група (-я)',
    test: /я$/u,
    forms: (word) => suffixed(word.slice(0, -1), ['я', 'і', 'ї', 'ю', 'ею', 'єю', 'ям', 'ями', 'ях', 'є'])
  },
  {
    // Іменники та прикметники жіночого роду на -а: Полтава, Одеса, Обухівка, Біла (Церква),
    // Велика (Димерка), Харківщина, Лозова. The noun endings (-и/-і/-у/-ою) and the adjectival ones
    // (-ої/-ій) are generated together because a one-word test cannot tell "Лозова" the adjectival
    // town from "Полтава" the noun, and the union costs only unreal forms.
    //
    // The `-і` form additionally gets the к→ц / г→з / х→с alternation, which is the only way
    // "у Великій Димерці" and "під Глевасі" reach "Димерка" and "Глеваха". The vocative (-о) is
    // left out for the same reason as the masculine one: a report never addresses a town, and every
    // form generated is a form some other place can be spelled with.
    name: 'жіночий рід (-а)',
    test: /а$/u,
    forms: (word) => {
      const stem = word.slice(0, -1);
      const softened = stem.replace(/к$/u, 'ц').replace(/г$/u, 'з').replace(/х$/u, 'с');
      return [
        ...suffixed(stem, ['а', 'и', 'і', 'у', 'ою', 'ої', 'ій']),
        ...(softened === stem ? [] : [`${softened}і`])
      ];
    }
  },
  {
    // Множинні назви: Суми, Бровари, Черкаси, Прилуки, Чабани, Погреби, Жуляни, Дігтярі, Чернівці.
    // The bare stem is the zero-ending genitive plural ("Сум", "Черкас", "Прилук") and is as much a
    // form as the suffixed ones.
    name: 'множина (-и/-і)',
    test: /(?:и|і)$/u,
    forms: (word) => {
      const stem = word.slice(0, -1);
      return [stem, ...suffixed(stem, ['и', 'і', 'ів', 'ам', 'ям', 'ами', 'ями', 'ах', 'ях'])];
    }
  },
  {
    // Середній рід на -о: Дніпро, Ківшарівко-подібні. Дніпра / Дніпру / Дніпром / Дніпрі.
    name: 'середній рід (-о)',
    test: /о$/u,
    forms: (word) => suffixed(word.slice(0, -1), ['о', 'а', 'у', 'ом', 'і', 'ові'])
  },
  {
    // Чоловічий рід на -ець: Тростянець → Тростянця, Козелець → Козельця, Кременець → Кременця.
    // The `е` is a fill vowel and disappears in every oblique case, which is why this class is tried
    // before the general soft-sign one. Both stems are generated because whether the consonant left
    // behind stays hard (Тростянця) or softens (Козельця) is a property of the individual name; the
    // unused one is not a Ukrainian word and matches nothing.
    name: 'чоловічий рід (-ець)',
    test: /ець$/u,
    forms: (word) => [word, ...[`${word.slice(0, -3)}ц`, `${word.slice(0, -3)}ьц`]
      .flatMap((stem) => suffixed(stem, ['я', 'ю', 'і', 'ем', 'еві', 'ями', 'ях']))]
  },
  {
    // Чоловічий/жіночий рід на -ь: Коростень, Хотінь, Бориспіль, Златопіль, Тернопіль.
    // Two stems: the plain one (Коростень → Коростеня, Хотінь → Хотіні) and the alternating one for
    // -іль (Бориспіль → Борисполя) and -інь (Ірпінь → Ірпеня), which are the two closed-syllable
    // alternations these names actually make.
    name: 'м\'який приголосний (-ь)',
    test: /ь$/u,
    forms: (word) => {
      const stems = [word.slice(0, -1)];
      if (/іль$/u.test(word)) stems.push(`${word.slice(0, -3)}ол`);
      if (/інь$/u.test(word)) stems.push(`${word.slice(0, -3)}ен`);
      return [word, ...stems.flatMap((stem) => suffixed(stem, ['я', 'ю', 'і', 'ем', 'еві', 'ями', 'ях']))];
    }
  },
  {
    // Чоловічий рід на -й: Гай, Ужгородський-подібні прізвищеві назви.
    name: 'чоловічий рід (-й)',
    test: /й$/u,
    forms: (word) => suffixed(word.slice(0, -1), ['й', 'я', 'ю', 'ї', 'єм', 'ям', 'ях'])
  },
  {
    // Чоловічий рід на твердий приголосний: Київ, Фастів, Обухів, Харків, Самар, Конотоп,
    // Вишгород, Кагарлик, Яготин, Житомир, Херсон, Ріг. The alternating stem from
    // {@link openSyllableStems} is what makes "Києвом" and "Фастова" reachable.
    // The vocative (-е: "Львове", "Києве") is deliberately absent. Nobody addresses a city in a
    // situation report, and the form is not free: Львове is itself a village in Kherson oblast, and
    // generating it put the city of Lviv into a list of shelled Kherson-oblast settlements.
    name: 'твердий приголосний',
    test: /[бвгґджзклмнпрстфхцчшщ]$/u,
    forms: (word) => [word, ...openSyllableStems(word)]
      .flatMap((stem) => suffixed(stem, ['', 'а', 'я', 'у', 'ю', 'ом', 'ем', 'і', 'ові', 'еві']))
  }
];

/**
 * Words shorter than this are matched literally.
 *
 * A three-letter alias is mostly ending: declining "бар" produces "бару", "барі" and "баром", which
 * are the forms of the ordinary noun *bar* far more often than they are the town in Vinnytsia
 * oblast, and declining "сум" (the genitive plural of Суми, stored as an alias in its own right)
 * produces "сума". The full nominative "Суми" is in the catalogue as the name and declines normally,
 * so nothing is lost by leaving the clipped alias alone.
 */
const MIN_INFLECTED_LENGTH = 4;

const inflectionCache = new Map<string, ReadonlySet<string>>();

/** Every form {@link PARADIGMS} licenses for `word`, including `word` itself. */
export function inflections(word: string): ReadonlySet<string> {
  const cached = inflectionCache.get(word);
  if (cached) return cached;
  const forms = new Set<string>([word]);
  if (word.length >= MIN_INFLECTED_LENGTH) {
    const paradigm = PARADIGMS.find((entry) => entry.test.test(word));
    for (const form of paradigm?.forms(word) ?? []) forms.add(form);
  }
  inflectionCache.set(word, forms);
  return forms;
}

/** The paradigm that owns `word`, for the audit test and for diagnostics. */
export function paradigmName(word: string): string {
  if (word.length < MIN_INFLECTED_LENGTH) return 'без відмінювання (коротке)';
  return PARADIGMS.find((entry) => entry.test.test(word))?.name ?? 'без відмінювання';
}

/** Whether `textToken` is the catalogue token `nameToken` in some case. */
export function sameLexeme(nameToken: string, textToken: string): boolean {
  return nameToken === textToken || inflections(nameToken).has(textToken);
}

/**
 * Compass points, bearings and the adjectives built from them.
 *
 * A direction is never a place. Whole-token matching already stops the worst case on its own —
 * "південно-західний" is one token and is not a form of "південне" — but the *inflected* bearings
 * are not so lucky: "південним курсом" writes an instrumental that is a perfectly good form of the
 * neuter adjectival settlement name Південне, and the archive uses it constantly.
 *
 * See {@link isBlockedPlaceToken} for the one thing this list does **not** do: suppress a message
 * that spells the name exactly as the catalogue does.
 */
export const COMPASS_TOKEN =
  /^(?:(?:північно|південно)-)?(?:північ|півноч|північн|південь|півдн|півден|південн|захід|заход|західн|схід|сход|східн)[а-яіїєґ]*$|^(?:пн|пд|сх|зх)$/u;

/**
 * Ordinary words a generated paradigm can reach.
 *
 * A paradigm generated from an alias that is already an oblique form, or from a very short name,
 * can produce a real Ukrainian word that has nothing to do with the place. Every entry below was
 * found by reading the generated table for a catalogue name against the words that table reaches,
 * and the same audit was run over the whole archive — 2 065 messages, 106 distinct declined forms
 * resolved, each one checked by hand. The list is meant to grow that way and never by imagination.
 *
 *   * `мені`, `мене`, `мною` — the dative, genitive and instrumental of "я", reachable from Мена.
 *   * `сума`, `суму`, `сумі`, `сумою` — the noun *sum*, reachable from the alias "сум" of Суми.
 *   * `чабан` — *shepherd*, the zero-ending genitive plural the paradigm forms from Чабани.
 *   * `троє` — the numeral *three (of them)*, reachable from the Kyiv-district alias "Троя" that
 *     migration 024 adds. "Троє БпЛА" is a count, not a district.
 *
 * Two collisions the archive audit found are handled in the paradigms instead, because the offending
 * form was worth nothing to begin with: the masculine and feminine vocatives are no longer generated
 * at all. "Львове" is a village in Kherson oblast, and generating it as the vocative of Львів put
 * the city into a list of shelled Kherson-oblast settlements.
 *
 * Like the compass list, this applies only to a form the message *declined*; a message that spells
 * the catalogue name exactly is taken at its word.
 */
export const NEVER_A_PLACE: ReadonlySet<string> = new Set([
  'мені', 'мене', 'мною', 'мену', 'меною',
  'сума', 'суму', 'сумі', 'сумою', 'сумам', 'сумах',
  'чабан', 'чабанам', 'чабанах',
  'троє', 'троєю'
]);

/**
 * Whether a one-word catalogue name may be read out of this message token.
 *
 * `declined` says the message spelled the name in some case other than the catalogue's own. That is
 * the whole condition: an inflected compass word is a bearing, and an inflected short name is
 * usually an ordinary word, but a message that writes the name **exactly** as the catalogue holds it
 * is naming the place. "Реактивний Козелець - 2 реактивних Мена" is the town of Мена; "мені" is not.
 * "Одещина: реактив на Південне" is the settlement in Odesa oblast; "південним курсом" is not.
 */
export function isBlockedPlaceToken(token: string, declined: boolean): boolean {
  return declined && (COMPASS_TOKEN.test(token) || NEVER_A_PLACE.has(token));
}

/**
 * The head nouns that license an administrative adjective.
 *
 * "Київська" on its own is an adjective; it becomes the oblast only next to "область". The forms are
 * enumerated rather than generated because there are two of them and because the abbreviations the
 * channels use ("обл.", "р-н") are not forms of anything.
 */
export const OBLAST_HEADS: ReadonlySet<string> = new Set([
  'область', 'області', 'областю', 'областей', 'областям', 'областями', 'областях', 'обл'
]);

export const RAION_HEADS: ReadonlySet<string> = new Set([
  'район', 'району', 'районі', 'районом', 'районе', 'райони', 'районів', 'районам', 'районами',
  'районах', 'р-н', 'р-ні', 'р-ну', 'р-нi', 'рн'
]);

/**
 * Tokens that may sit between two coordinated administrative adjectives.
 *
 * "по межі Київської та Чернігівської областей" names two oblasts with one head noun, and a
 * contiguous two-word alias match cannot see the first of them. Commas are not tokens, so a
 * comma-separated list needs no entry here.
 */
export const ADMIN_CONNECTORS: ReadonlySet<string> = new Set(['та', 'і', 'й', 'та-й', 'а', 'або']);
