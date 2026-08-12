import { classifyMessage, significanceRejection, type LocationLexeme } from './classifier.js';
import type { ThreatType } from '../types.js';

/**
 * Turning a place NAME written by a model into a catalogue id, deterministically or not at all.
 *
 * ## Why the model is never allowed to write an id
 *
 * Every model surface in this codebase is handed text and answers text. It never sees the location
 * catalogue, so an id in a model reply could only be an invention or a memorised fragment of one —
 * and an id is exactly the thing that decides which polygon lights up, which subscriptions match and
 * which oblast a Telegram push names. The rule is therefore structural: a model may say «Кременчук»,
 * and the *production classifier over the production catalogue* is what turns that into
 * `ua-53-...`, or into nothing.
 *
 * ## Why the resolution runs a synthetic sentence rather than a lookup
 *
 * There is no name→id function to call. The catalogue is matched by `classifyMessage`, which reads a
 * whole message: it resolves inflection, refuses adjectives without their head noun («Київська» is
 * an oblast only next to «область»), and breaks homonyms — Миколаїв the oblast capital against
 * Миколаїв the town in Lviv oblast — using the surrounding text. A bespoke `name = name_uk OR name =
 * ANY(aliases)` probe here would answer a *different* question than the one the rest of the system
 * answers about the same string, and it would answer it with a coin flip on exactly the homonym pairs
 * `migrations/031` and `032` exist because of.
 *
 * So the name is put into the shortest sentence the classifier accepts — «Загроза {клас} для {назва}»
 * — and the classifier's own answer is used. This is why {@link THREAT_LABELS} exists: the sentence
 * needs a real weapon class or `significanceRejection` refuses it as `no_threat_recognised`, and
 * refusing every resolution is not the failure mode wanted here.
 *
 * ## The three refusals, and why each is a refusal rather than a best guess
 *
 *  - `significanceRejection(check) !== null` — the classifier does not read the sentence as a threat
 *    assertion at all, which for this template means the name matched nothing.
 *  - `check.nationalScope` — the name resolved to «вся Україна». A model naming the whole country as
 *    an extra destination is not extra information, it is the loss of the only bound this path has.
 *  - `check.locations.length !== 1` — the name is ambiguous *in isolation*, which is precisely the
 *    homonym case. One name must mean one place or it means nothing: picking the first row would put
 *    a threat 400 km from where the source meant it, which is the defect `migrations/031` documents.
 *
 * Shared by {@link file://./../services/shadow-classifier.ts} (`buildAnalyticalClassification`, the
 * promotion path) and {@link file://./../services/analytical-enrichment.ts} (the enrichment path),
 * and it lives in `domain/` rather than in either of them so neither has to import the other: the
 * enrichment writer is called BY the shadow classifier, so a shared helper in the classifier would be
 * a module cycle, and a second copy of this function would be a second definition of «the model may
 * name a place but never an id».
 */

/**
 * The genitive weapon phrase each class is named by, for the synthetic sentence above and for the
 * prose of a promoted event.
 *
 * `unknown` is deliberately absent from the type: a resolution needs a class the classifier can
 * recognise, and «Загроза невідомого для Одеси» is not a sentence the rules read as a threat. Callers
 * exclude `unknown` before they get here, and `Exclude<ThreatType,'unknown'>` is what makes the
 * compiler check that rather than the reviewer.
 */
export const THREAT_LABELS: Record<Exclude<ThreatType, 'unknown'>, string> = {
  uav: 'ударних БпЛА',
  ballistic_missile: 'балістичних ракет',
  cruise_missile: 'крилатих ракет',
  guided_air_bomb: 'керованих авіабомб',
  aviation: 'бойової авіації',
  mlrs: 'реактивних систем залпового вогню',
  artillery: 'артилерії',
  mortar: 'мінометного обстрілу',
  combined: 'комбінованої повітряної атаки'
};

export interface ResolvedModelPlace {
  id: string;
  /** The catalogue's own spelling, never the model's — the id and the label come from one row. */
  name: string;
}

/**
 * The catalogue row a model-written name means, or `null` when it means none or more than one.
 *
 * Pure: the caller supplies the lexemes (`cachedLocationLexemes()` in production, a fixture in
 * tests), so the guarantee this function makes is provable without a database.
 */
export function resolveModelPlace(
  name: string, threatType: Exclude<ThreatType, 'unknown'>, lexemes: LocationLexeme[]
): ResolvedModelPlace | null {
  const check = classifyMessage(`Загроза ${THREAT_LABELS[threatType]} для ${name}.`, lexemes);
  if (significanceRejection(check) !== null || check.nationalScope || check.locations.length !== 1) {
    return null;
  }
  const location = check.locations[0]!;
  return { id: location.id, name: location.name };
}
