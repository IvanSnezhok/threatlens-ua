/**
 * The threat-class icon catalogue and the deterministic order that decides which three of them a
 * territory shows.
 *
 * Pure by contract: zero database access, zero `config` import, zero `Date.now()`. The caller passes
 * `now`, and that single fact is what makes the ranking reproducible between the server, the unit
 * tests and any replay of a recorded snapshot — «алгоритм має бути детермінованим» is not a wish
 * about the output, it is a constraint on the inputs.
 *
 * ## Precondition the ranking is written against
 *
 * `composeTerritoryStates` produces **at most one candidate per threat class per territory**: one
 * `TerritoryThreat` per class, and an `analytic` candidate only for a class that has no live threat
 * at all. Keys 5–7 of the order are therefore unreachable in production; they exist so the order
 * stays total if that invariant is ever relaxed, and they are unit-tested directly against
 * same-class pairs.
 *
 * ## Known limit of the danger ladder
 *
 * The classifier collapses every multi-class report into `combined`
 * (`matchedTypes.length > 1 ? 'combined' : …`, src/domain/classifier.ts), so a combined report that
 * contained ballistics ranks below a pure ballistic report. The ladder cannot recover the members.
 * It matters little because danger is only key #4 — state, evidence and freshness all dominate it —
 * and inventing a member list would be worse than ranking the class we actually recorded.
 */
import { THREAT_TYPES, type EvidenceLevel, type RelationType, type ThreatType } from '../types.js';

/**
 * The ten threat classes as filled 24×24 silhouettes.
 *
 * Why path strings and not files: `npm run build:web` is a bare `esbuild --bundle` with no
 * asset-copy step, and production CSP is `default-src 'self'`. An icon that lives in a file is an
 * icon that has to be fetched, and a fetch that fails is an icon that MapLibre silently replaces
 * with a 1×1 transparent image (`map.on('styleimagemissing')`, web/app.js:679-681). A string in the
 * bundle cannot fail to arrive.
 *
 * Why no arrows: an arrow drawn on a territory asserts a predicted target. This system does not
 * predict targets, and says so in eight places. Read `ballistic`'s wedge as a descending body.
 *
 * Дзеркальна копія цієї мапи живе у web/app.js (`threatIconPaths`). Змінюєш тут — зміни й там.
 */
export const THREAT_ICON_PATHS: Record<ThreatType, string> = {
  // Балістична: підйом ліворуч-праворуч, апогей і спуск, що завершується суцільним клином.
  // Клин тупий і без держака — це тіло, що падає, а не стрілка, що показує напрямок.
  ballistic_missile:
    'M2.6 21.6 C3.9 13.6 7.6 7.6 13.6 4.4 C16.3 3.0 18.6 3.6 19.9 5.8 '
    + 'L17.5 7.2 C16.9 6.2 15.9 6.0 14.7 6.6 C9.6 9.3 6.4 14.4 5.1 21.6 Z '
    + 'M16.3 9.4 L23.1 9.4 L19.7 21.8 Z',

  // КАБ: важке краплеподібне тіло носом донизу, хвостове оперення, одне коротке планувальне крило.
  // Двигуна немає — саме це відрізняє КАБ від крилатої ракети.
  guided_air_bomb:
    'M12 21.6 C9.0 21.6 6.6 19.0 6.6 15.4 C6.6 10.6 9.0 5.4 12 1.8 '
    + 'C15.0 5.4 17.4 10.6 17.4 15.4 C17.4 19.0 15.0 21.6 12 21.6 Z '
    + 'M7.2 4.2 L12 8.0 L16.8 4.2 L16.8 6.6 L12 10.4 L7.2 6.6 Z '
    + 'M17.0 12.2 L22.6 10.4 L22.6 12.6 L17.0 14.2 Z',

  // Крилата: довгий горизонтальний циліндр, заокруглений ніс праворуч, куце крило посередині,
  // один хвостовий кіль. Візуальна протилежність балістичному клину.
  cruise_missile:
    'M3.6 10.6 L17.8 10.6 C20.4 10.6 22.4 11.5 22.4 12.6 C22.4 13.7 20.4 14.6 17.8 14.6 '
    + 'L3.6 14.6 Z '
    + 'M10.6 10.6 L8.2 6.4 L11.0 6.4 L13.4 10.6 Z '
    + 'M10.6 14.6 L8.2 18.8 L11.0 18.8 L13.4 14.6 Z '
    + 'M3.6 10.6 L1.6 5.6 L4.4 5.6 L6.0 10.6 Z',

  // Комбінована: балістичний клин і дельта БпЛА зі зсувом в одному полі. Читається як «більш ніж
  // один тип», а не як третій окремий тип.
  combined:
    'M13.2 3.2 L19.6 3.2 L16.6 14.4 Z '
    + 'M7.4 8.6 L13.0 20.2 L1.8 20.2 Z',

  // РСЗВ: три короткі паралельні ракети зі спільної основи. Множинність і є знаком.
  mlrs:
    'M2.6 19.2 L21.4 19.2 L21.4 21.8 L2.6 21.8 Z '
    + 'M6.8 3.4 L8.4 7.0 L8.4 18.2 L5.2 18.2 L5.2 7.0 Z '
    + 'M12 2.2 L13.6 5.8 L13.6 18.2 L10.4 18.2 L10.4 5.8 Z '
    + 'M17.2 3.4 L18.8 7.0 L18.8 18.2 L15.6 18.2 L15.6 7.0 Z',

  // БпЛА: дельта в плані, вузький прямокутний фюзеляж, два скошені хвостові кілі.
  // Розмах 20.8 — ширший за будь-який ракетний гліф і вужчий за авіаційний.
  uav:
    'M12 2.6 L22.4 17.2 L1.6 17.2 Z '
    + 'M10.6 6.4 L13.4 6.4 L13.4 21.4 L10.6 21.4 Z '
    + 'M4.6 21.4 L10.6 17.6 L10.6 21.4 Z '
    + 'M19.4 21.4 L13.4 17.6 L13.4 21.4 Z',

  // Артилерія: один ствол під 45° на суцільній трапецієподібній основі.
  artillery:
    'M3.6 21.6 L20.4 21.6 L18.0 16.2 L6.0 16.2 Z '
    + 'M8.6 17.6 L11.0 15.2 L21.2 5.0 L18.8 7.4 Z',

  // Міномет: коротка товста труба під ~70° на опорній плиті, міна над дульним зрізом.
  mortar:
    'M4.2 20.0 L19.8 20.0 L19.8 22.4 L4.2 22.4 Z '
    + 'M6.6 19.3 L11.0 7.1 L15.0 8.5 L10.6 20.7 Z '
    + 'M14.6 1.6 C16.1 3.0 16.8 4.3 16.8 5.3 C16.8 6.6 15.8 7.5 14.6 7.5 '
    + 'C13.4 7.5 12.4 6.6 12.4 5.3 C12.4 4.3 13.1 3.0 14.6 1.6 Z',

  // Авіація: класичний силует літака в плані зі стрілоподібним крилом і стабілізатором.
  // Розмах 22.4 — свідомо більший за БпЛА, щоб читалося «літак», а не «дрон».
  aviation:
    'M12 1.6 C13.0 2.9 13.5 4.4 13.5 6.0 L13.5 20.0 C13.5 21.2 12.9 22.2 12 22.4 '
    + 'C11.1 22.2 10.5 21.2 10.5 20.0 L10.5 6.0 C10.5 4.4 11.0 2.9 12 1.6 Z '
    + 'M10.5 9.0 L0.8 15.4 L0.8 17.2 L10.5 14.6 Z '
    + 'M13.5 9.0 L23.2 15.4 L23.2 17.2 L13.5 14.6 Z '
    + 'M10.5 18.4 L5.6 21.0 L5.6 22.2 L10.5 21.0 Z '
    + 'M13.5 18.4 L18.4 21.0 L18.4 22.2 L13.5 21.0 Z',

  // Невизначена: заокруглений квадрат із вибитим знаком питання. Свідомо НЕ зброя —
  // це відсутність класифікації, а не її різновид.
  unknown:
    'M6.4 2.8 H17.6 A3.6 3.6 0 0 1 21.2 6.4 V17.6 A3.6 3.6 0 0 1 17.6 21.2 '
    + 'H6.4 A3.6 3.6 0 0 1 2.8 17.6 V6.4 A3.6 3.6 0 0 1 6.4 2.8 Z '
    + 'M12.0 6.0 C9.8 6.0 8.2 7.5 8.2 9.6 H10.8 C10.8 8.8 11.3 8.3 12.0 8.3 '
    + 'C12.8 8.3 13.3 8.8 13.3 9.5 C13.3 10.2 12.9 10.7 12.1 11.3 '
    + 'C11.0 12.1 10.7 12.9 10.7 14.2 V14.8 H13.3 V14.4 C13.3 13.6 13.6 13.2 14.4 12.6 '
    + 'C15.5 11.8 15.9 10.9 15.9 9.5 C15.9 7.4 14.3 6.0 12.0 6.0 Z '
    + 'M10.6 16.4 H13.4 V19.2 H10.6 Z'
};

/**
 * The short name a designer uses for the glyph. Three differ from the class name.
 *
 * Documentation and legend copy only. **Nothing addressable is keyed on it** — image ids, layer ids
 * and the wire format all use `ThreatType`, so there is exactly one identifier a bug can be traced
 * through.
 */
export const THREAT_ICON_KEYS: Record<ThreatType, string> = {
  ballistic_missile: 'ballistic', guided_air_bomb: 'kab', cruise_missile: 'cruise',
  combined: 'combined', mlrs: 'mlrs', uav: 'uav', artillery: 'artillery',
  mortar: 'mortar', aviation: 'aviation', unknown: 'unknown'
};

export type IconTone = 'consequence' | 'confirmed' | 'reported' | 'analytic';
export const ICON_TONES = ['consequence', 'confirmed', 'reported', 'analytic'] as const;

// Дзеркальна копія цієї мапи живе у web/app.js (`threatIconLabels`). Змінюєш тут — зміни й там.
// Це рівно ті самі рядки, що вже показує карта у `threatNames`; іконка не має права називати
// той самий клас інакше, ніж картка події поруч.
export const THREAT_ICON_LABELS_UK: Record<ThreatType, string> = {
  uav: 'Ударні БпЛА',
  ballistic_missile: 'Балістична загроза',
  cruise_missile: 'Крилаті ракети',
  guided_air_bomb: 'Керовані авіабомби',
  aviation: 'Активність авіації',
  mlrs: 'РСЗВ',
  artillery: 'Артилерія',
  mortar: 'Мінометний обстріл',
  combined: 'Комбінована загроза',
  unknown: 'Невизначена загроза'
};

// Дзеркальна копія цієї мапи живе у web/app.js (`threatIconAria`). Змінюєш тут — зміни й там.
export const ICON_TONE_ARIA_UK: Record<IconTone, string> = {
  consequence: 'повідомлено наслідки',
  confirmed: 'підтверджене джерело',
  reported: 'повідомлення моніторингу',
  analytic: 'аналітична оцінка, не тривога'
};

/** `ti-uav-confirmed`. 10 classes × 4 tones = 40 ids, all unique, all lower-case ASCII + `-`/`_`. */
export function iconImageId(threatType: ThreatType, tone: IconTone): string {
  return `ti-${threatType}-${tone}`;
}

/** «Ударні БпЛА — підтверджене джерело» */
export function iconAriaLabel(threatType: ThreatType, tone: IconTone): string {
  return `${THREAT_ICON_LABELS_UK[threatType]} — ${ICON_TONE_ARIA_UK[tone]}`;
}

export const MAX_ICON_SLOTS = 3;

/**
 * How little warning the class gives and how lethal one event is to the population under it.
 * Ballistic gives the least warning of anything in the list; a КАБ in the frontline belt has
 * effectively no interception window; cruise missiles give minutes; `combined` outranks every
 * single conventional class because by definition it is more than one; MLRS / artillery / mortar
 * are ordered by range and therefore by warning; `aviation` is a posture indicator rather than an
 * inbound weapon; `unknown` is last because it is the *absence* of a classification, not a class.
 *
 * The ten values are DISTINCT on purpose: that is what makes key #4 decisive for any two different
 * classes, and it is why keys #5–#7 only ever run for two candidates of the SAME class.
 */
export const DANGER_RANK: Record<ThreatType, number> = {
  ballistic_missile: 9, guided_air_bomb: 8, cruise_missile: 7, combined: 6,
  mlrs: 5, uav: 4, artillery: 3, mortar: 2, aviation: 1, unknown: 0
};

export const TONE_RANK: Record<IconTone, number> =
  { consequence: 3, confirmed: 2, reported: 1, analytic: 0 };

/** Mirrors `evidenceRank` in src/repositories/events.ts. An analytic-only candidate scores -1. */
export const EVIDENCE_RANK = { official: 3, confirmed: 2, monitoring: 1, unverified: 0 } as const;

/**
 * Mirrors the geographic-relevance weights in src/repositories/events.ts:487-491.
 * `official_alert` is in the enum and in two SQL CHECKs but no code path has ever written it;
 * it is ranked alongside `mentioned` rather than left undefined so a future writer cannot produce
 * an `undefined` comparison key.
 */
export const RELATION_RANK: Record<RelationType, number> =
  { explicit_threat: 3, reported_direction: 2, aftermath: 1, mentioned: 0, official_alert: 0 };

export interface IconCandidate {
  threatType: ThreatType;
  tone: IconTone;
  evidenceLevel: EvidenceLevel | null;   // null for an analytic-only candidate
  relationType: RelationType | null;
  lastConfirmedAt: string;               // ISO — lastObservedAt, or generatedAt for analytic
  eventCount: number;
  riskScore: number | null;
}

export interface RankedIcon extends IconCandidate {
  rank: number;          // 0-based slot
  iconId: string;        // iconImageId(threatType, tone)
  labelUk: string;       // THREAT_ICON_LABELS_UK[threatType]
  ariaLabelUk: string;   // iconAriaLabel(threatType, tone)
}

/**
 * CONTRACT.md §3.2 declares `TerritoryState.icons: TerritoryIcon[]` without defining
 * `TerritoryIcon`. It is `RankedIcon`: the panel needs `eventCount`, `lastConfirmedAt` and
 * `evidenceLevel` anyway, and a narrower wire type would have to be widened again on first use.
 */
export type TerritoryIcon = RankedIcon;

export interface IconStack { icons: RankedIcon[]; overflow: number; }

const MINUTE = 60_000;

/**
 * Freshness as a bucket, never a raw timestamp.
 *
 * Two reports 400 ms apart are equally fresh to anyone reading the map, but a raw comparison would
 * let them swap slots between two snapshots taken a second apart, and the icon stack would flicker
 * during exactly the wave it exists to describe. Buckets make the order stable under clock jitter
 * and identical between the server, the tests and any replay.
 *
 * A future timestamp is clock skew on the source side, not freshness from the future: it clamps to
 * "now" rather than winning by being ahead. An unparseable timestamp falls into the oldest bucket,
 * which is the safe direction — it can never jump a malformed candidate to the front.
 */
export function freshnessBucket(lastConfirmedAt: string, now: Date): 0 | 1 | 2 | 3 {
  const at = Date.parse(lastConfirmedAt);
  if (!Number.isFinite(at)) return 0;
  const age = Math.max(0, now.getTime() - at);
  if (age < 10 * MINUTE) return 3;
  if (age < 30 * MINUTE) return 2;
  if (age < 120 * MINUTE) return 1;
  return 0;
}

const evidenceScore = (c: IconCandidate): number =>
  c.evidenceLevel == null ? -1 : EVIDENCE_RANK[c.evidenceLevel] ?? -1;

const relationScore = (c: IconCandidate): number =>
  c.relationType == null ? -1 : RELATION_RANK[c.relationType] ?? -1;

/** Never NaN: a NaN key would make `Array#sort` produce an arbitrary order, not a stable one. */
const recencyMs = (c: IconCandidate): number => {
  const at = Date.parse(c.lastConfirmedAt);
  return Number.isFinite(at) ? at : 0;
};

/**
 * Strict total order over icon candidates. Negative = `a` outranks `b`.
 *
 * Never returns 0 for two candidates of different classes: `DANGER_RANK` is injective over the ten
 * classes, so key #4 always decides, and key #8 guarantees it even if that ever stopped being true.
 * Two candidates of the SAME class compare equal only when every field is equal — which is the
 * definition of "the same icon".
 */
export function compareThreatIcons(a: IconCandidate, b: IconCandidate, now: Date): number {
  return (
    (TONE_RANK[b.tone] - TONE_RANK[a.tone]) ||                                   // 1. state
    (evidenceScore(b) - evidenceScore(a)) ||                                     // 2. evidence
    (freshnessBucket(b.lastConfirmedAt, now) - freshnessBucket(a.lastConfirmedAt, now)) || // 3.
    (DANGER_RANK[b.threatType] - DANGER_RANK[a.threatType]) ||                   // 4. danger
    (relationScore(b) - relationScore(a)) ||                                     // 5. relation
    (b.eventCount - a.eventCount) ||                                             // 6. event count
    (recencyMs(b) - recencyMs(a)) ||                                             // 7. exact recency
    (THREAT_TYPES.indexOf(a.threatType) - THREAT_TYPES.indexOf(b.threatType))    // 8. stable key
  );
}

/**
 * Sorts, slots the first MAX_ICON_SLOTS and reports the remainder as `overflow`.
 * Does not mutate `candidates` — the caller keeps the full per-class list for the panel.
 */
export function rankThreatIcons(candidates: IconCandidate[], now: Date): IconStack {
  const sorted = [...candidates].sort((a, b) => compareThreatIcons(a, b, now));
  const icons = sorted.slice(0, MAX_ICON_SLOTS).map((candidate, rank) => ({
    ...candidate,
    rank,
    iconId: iconImageId(candidate.threatType, candidate.tone),
    labelUk: THREAT_ICON_LABELS_UK[candidate.threatType],
    ariaLabelUk: iconAriaLabel(candidate.threatType, candidate.tone)
  }));
  return { icons, overflow: Math.max(0, sorted.length - MAX_ICON_SLOTS) };
}
