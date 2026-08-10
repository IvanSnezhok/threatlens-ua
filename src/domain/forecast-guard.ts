/**
 * The words a public surface of this project is never allowed to say.
 *
 * ## Why a lexicon and not a judgement
 *
 * Everything this system publishes is either `observed` (a source said it) or `derived` (we counted
 * what already happened). Neither of those can express «наступна ціль — Полтава», and yet the two
 * new surfaces that reach a model — the tactical commentary on the attacks page and the operator
 * research memo — both hand it a table of past counts and ask for prose. A model given "share of
 * Shaheds rose from 0.31 to 0.52 over 24 hours" will, unprompted and in good faith, write the
 * sentence that follows naturally from it: «отже, найближчої ночі очікується удар по…». That
 * sentence is not a mistake of arithmetic — every number in it may be correct — so the grounding
 * check that guards those surfaces cannot see it. It is a mistake of *tense*, and it is the single
 * output this project must never produce: a strike forecast, published, under our name.
 *
 * The response is a closed list of stems rather than a model, a classifier or a heuristic, for the
 * same reason the retrospective rules are a closed list: this check runs on the path where the
 * answer decides whether text is shown to the public, so it must be reproducible from a file, be
 * readable by a person who does not trust it, and give the same answer today and next month. A
 * verifier that is itself a model can be talked out of its answer by the text it is verifying.
 *
 * ## The asymmetry that sets every threshold here
 *
 * A false positive costs a paragraph: the caller falls back to its deterministic text, which was
 * already written and already complete. A false negative costs a published forecast. So the list is
 * allowed to be blunt, and where a stem is ambiguous the ambiguity is resolved toward matching.
 *
 * Bluntness has a limit, though, and the negative fixtures in the test are it. «за добу»,
 * «ймовірна стратегія» and «очікувана тривалість» are ordinary phrases in text that is purely about
 * the past, and a guard that ate them would silently turn the model off for every honest sentence
 * as well. That is why `ймовірн` is not a lexeme on its own and only counts beside a strike word,
 * and why the `очікув-` family is enumerated by finite form rather than stemmed to `очікув`.
 *
 * ## Shape
 *
 * Each lexeme is a sequence of token prefixes, matched against consecutive whole tokens of the text.
 * Prefix matching is what stands in for Ukrainian inflection here: `завдад` covers «завдадуть» and
 * «завдадуться», `наступн` covers «наступна», «наступної» and «наступним». It is deliberately much
 * cruder than `place-morphology.ts` — there the cost of over-generating is a settlement resolved
 * wrongly on the map, here it is a paragraph replaced by another paragraph.
 *
 * A leaf module: it imports nothing, touches nothing, and is safe to call from a public request
 * path, an ops route or a test.
 */

/**
 * The closed list. Each entry is one lexeme, written as the token prefixes it is made of.
 *
 * Grouped by what makes them forecasts, because a reader deciding whether to add an entry needs the
 * rule, not the list:
 *
 *   * naming the act of forecasting (`прогноз`, `передбачаєм`);
 *   * putting a strike in the future (`очікуєть`, `завдад`, `буде атак`, `планує`, `готує удар`);
 *   * naming a target not yet hit (`наступн ціл`, `цілі на`, `ризик влучан`);
 *   * qualifying a strike with a likelihood (`ймовірн удар`, `найімовірніш`);
 *   * pointing at a window that has not happened (`найближч годин`).
 *
 * Nothing here is about vocabulary an analyst may not use — it is about the tense the sentence is
 * in. «Ударів по енергетиці стало вдвічі більше» names strikes and is fine; «удар буде по
 * енергетиці» names one that has not happened and is not.
 */
export const FORECAST_LEXEMES: ReadonlyArray<readonly string[]> = [
  // Naming the act itself. `прогноз` also catches «прогнозує», «прогнозований», «прогнозу».
  ['прогноз'],
  ['спрогноз'],
  ['передбачаєм'],
  ['передбачаю'],

  // The `очікув-` family, by finite form. `очікуват` deliberately does NOT reach «очікувана
  // тривалість» — an adjective about something already under way — while «очікувати», «очікуватимуть»
  // and «слід очікувати» all begin with it.
  ['очікуєть'],
  ['очікуват'],
  ['очікуєм'],
  ['очікуй'],

  // A strike placed in the future by its verb.
  ['завдад'],           // завдадуть удару
  ['атакуват'],         // будуть атакувати
  ['буде', 'атак'],
  ['будуть', 'атак'],
  ['буде', 'удар'],
  ['будуть', 'удар'],
  ['планує'],
  ['планують'],
  ['готує', 'удар'],
  ['готують', 'удар'],
  ['намір'],            // наміри ворога, має намір

  // A target that has not been hit yet.
  ['наступн', 'ціл'],
  ['цілі', 'на'],       // цілі на ніч, цілі на завтра
  ['ризик', 'влучан'],
  ['під', 'загроз', 'буд'],  // під загрозою будуть

  // A strike qualified by likelihood. `ймовірн` alone is an ordinary word about the past
  // («ймовірна стратегія», «найбільш ймовірне пояснення») and is never a lexeme by itself.
  ['ймовірн', 'ціл'],
  ['ймовірн', 'удар'],
  ['ймовірн', 'атак'],
  // Both spellings of the same word: «приліт» keeps its і in the singular and loses it in the
  // plural («прильоти»), so one stem cannot cover the two and a single entry would let half the
  // sentences a model writes through.
  ['ймовірн', 'приліт'],
  ['ймовірн', 'прильот'],
  ['ймовірн', 'напрям'],
  ['найімовірніш'],

  // A window that has not happened yet.
  ['найближч', 'годин'],
  ['найближч', 'доб'],
  ['найближч', 'ноч']
];

/**
 * Words as this guard counts them.
 *
 * Letters and digits only: punctuation, quotation marks and the Ukrainian apostrophe are all
 * separators, so «удар — буде» and «"наступна" ціль» are the same token sequences as their plain
 * forms. Splitting on the apostrophe can only cut a token into two shorter ones, and no lexeme here
 * contains one, so it cannot hide a match.
 */
function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** How a matched lexeme is named back to the caller and written into a rejection reason. */
function label(lexeme: readonly string[]): string {
  return lexeme.join(' ');
}

/**
 * The first forecasting lexeme in `text`, or null when there is none.
 *
 * Returns the lexeme rather than a boolean because every caller writes the answer down: a rejected
 * commentary is stored with the reason it was rejected, and «forecast lexeme: наступн ціл» is a
 * reason an operator can act on, while «rejected» is not.
 *
 * Order of the returned match follows {@link FORECAST_LEXEMES}, not position in the text. Which
 * lexeme is reported first has no meaning — one is enough to reject the whole text — and pinning it
 * to the list keeps the answer stable when the same sentence trips two entries.
 */
export function forecastLexeme(text: string): string | null {
  if (!text) return null;
  const tokens = tokenise(text);
  if (!tokens.length) return null;
  for (const lexeme of FORECAST_LEXEMES) {
    for (let start = 0; start + lexeme.length <= tokens.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < lexeme.length; offset += 1) {
        if (!tokens[start + offset]!.startsWith(lexeme[offset]!)) { matched = false; break; }
      }
      if (matched) return label(lexeme);
    }
  }
  return null;
}

/**
 * The same question asked of several strings at once, answering with the first offender.
 *
 * The callers hold structured text — a headline, a list of findings, a list of caveats — and reject
 * all of it together when any part offends. Without this they would each write the same loop, and
 * the one that forgot the caveats array would be the one that published the forecast.
 */
export function firstForecastLexeme(texts: readonly (string | null | undefined)[]): string | null {
  for (const text of texts) {
    const found = text ? forecastLexeme(text) : null;
    if (found) return found;
  }
  return null;
}
