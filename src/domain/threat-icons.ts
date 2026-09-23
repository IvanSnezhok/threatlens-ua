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
 * The ten threat classes as filled 24×24 silhouettes: one path each, drawn for fill-rule `evenodd`.
 *
 * ## Where the glyphs come from
 *
 * Original drawings made for this project (2026-09-23), so no third-party licence is attached and
 * the map legend carries no attribution line. They replaced a set of game-icons.net glyphs (CC BY
 * 3.0) for one reason: those did not depict their class. `uav` was a B-2 stealth bomber, `combined`
 * a missile swarm, `cruise_missile` and `ballistic_missile` two near-identical rockets, `mlrs` read
 * as an air-defence launcher and `artillery` was a bullet. An icon whose only job is to say what is
 * flying cannot borrow the silhouette of something else.
 *
 * Every glyph was judged by rendering it at 19 px — the glyph box inside the 24 px map chip, i.e.
 * the size the territory stacks draw — and at 48 px, and redrawn until each read as its class at
 * 19 px on its own. The vector head draws the same chip at 0.62–0.86 of that; a silhouette that
 * needed its detail to be read would be unreadable there, so none of them does.
 *
 * Drawing rules the paths keep:
 *
 * - **24 grid.** `web/app.js` scales the glyph box by `ICON_GLYPH_BOX / ICON_GLYPH_GRID`, so the grid
 *   is a number in one place, not a format.
 * - **Inside the round chip.** Everything stays within ~12 units of the centre (12, 12): the chip is a
 *   circle, and a wingtip in the corner of the square would be cut by its dark outline.
 * - **evenodd, not nonzero.** Sub-paths never overlap except where a hole is the drawing: the wheel
 *   and hub of the howitzer, the tube slits of the rocket pack, the ring around the question mark.
 *   Anything that must read as one piece is one outline; two parts that merely touch stay two.
 * - **Negative space as a separator.** Where a class is two objects (`combined`), the one behind is cut
 *   back along the one in front, so the pair reads as two silhouettes rather than as one blob.
 *
 * Why path strings and not files: `npm run build:web` is a bare `esbuild --bundle` with no
 * asset-copy step, and production CSP is `default-src 'self'`. An icon that lives in a file is an
 * icon that has to be fetched, and a fetch that fails is an icon that MapLibre silently replaces
 * with a 1×1 transparent image (`map.on('styleimagemissing')`, web/app.js:679-681). A string in the
 * bundle cannot fail to arrive.
 *
 * ## Why no arrows — and why a missile with a nose is not one
 *
 * An arrow drawn on a territory asserts a predicted target. This system does not predict targets,
 * and says so in eight places.
 *
 * Several of these glyphs do have an inherent orientation, because the objects do: a drone and a
 * missile have a nose, a falling bomb has a down. That is a depiction, not a bearing, and the
 * distinction is mechanical rather than a matter of reading — **the chip is never rotated**.
 * `icon-rotate` is not set on any of the four territory-icon layers, so the glyph sits at the same
 * angle over Sumy as over Odesa and cannot encode a direction even in principle. The one bitmap on
 * this map that IS rotated is the vector arrowhead, and it is not from this table.
 *
 * The map does draw arrows, and they are not these and never will be: they belong to a threat-vector
 * leg whose basis is `reported_transit` or `reported_direction`, or to the heading a source named for
 * a track's head — a movement a source stated in so many words, towards a place that source named —
 * and they live in `web/app.js` as their own bitmaps and lines. The difference is the whole rule:
 * those arrows point from a reported place to another reported place, while an arrow on a *territory
 * glyph* would point at a target nobody reported. A leg the sources did not assert
 * (`observation_sequence`) gets no arrowhead either.
 *
 * Дзеркальна копія цієї мапи живе у web/app.js (`threatIconPaths`). Змінюєш тут — зміни й там.
 */
export const THREAT_ICON_PATHS: Record<ThreatType, string> = {
  // Балістична: ракета круто вгору, з оперенням і коротким факелом, над дугою сліду — висхідна гілка
  // параболи. Крутизна й факел відрізняють її від крилатої, яка летить горизонтально.
  ballistic_missile:
    'M17.6 2.2L18.01 3.93L17.87 5.64L15.84 9.99L16.69 14.8L15.42 14.2L14.49 12.89L11.41 11.45'
    + 'L9.8 11.58L8.53 10.99L12.76 8.55L14.79 4.2L16.01 3ZM13.83 13.35L11.01 16.34L11.48 12.25Z'
    + 'M3.6 21.6C4.4 17.4 6.4 15 9.4 14.4L9.8 15.8C7.3 16.4 6 18.3 5.3 21.8Z',

  // КАБ: товста бомба носом донизу з розкладеними крилами планувального модуля (УМПК) і коробчастим
  // хвостом. Крила — те, що відрізняє керовану бомбу від звичайної.
  guided_air_bomb:
    'M8.4 2.2H15.6L13.3 5.4L15 7.8V9.2H22.6V11.1H15V17.2C15 20.2 13.4 22.2 12 23'
    + 'C10.6 22.2 9 20.2 9 17.2V11.1H1.4V9.2H9V7.8L10.7 5.4Z',

  // Крилата: вид збоку, рівний політ — довгий циліндр із загостреним носом, малі крила посередині й
  // хрестоподібний хвіст. Крило лише знизу робило з неї пістолет, тому пари дві, як у справжньої.
  cruise_missile:
    'M23 12C21.8 11 20 10.8 17.8 10.8H14L10.6 7.8H9.2L11.8 10.8H6.8L3.6 8.2H2.4V15.8H3.6L6.8 13.2'
    + 'H11.8L9.2 16.2H10.6L14 13.2H17.8C20 13.2 21.8 13 23 12Z',

  // БпЛА: «Шахед-136» згори — дельтакрило з вертикальними шайбами на кінцях, короткий фюзеляж і
  // штовхальний гвинт позаду. Шайби й гвинт відрізняють його і від літака, і від «невидимки».
  uav:
    'M12 1.9C12.8 1.9 13.2 3 13.2 4.2V6L20.4 13.6V12.4H21.8V18.6H20.4V17.2L13.2 18.2V19.4H10.8V18.2'
    + 'L3.6 17.2V18.6H2.2V12.4H3.6V13.6L10.8 6V4.2C10.8 3 11.2 1.9 12 1.9ZM8.6 20.2H15.4V21.4H8.6Z',

  // Авіація: реактивний літак згори — стрілоподібне крило посередині й окремий хвостовий стабілізатор.
  // Хрест «крило + хвіст» не сплутати з дельтою БпЛА.
  aviation:
    'M12 1.2L13.1 4.4V8.2L21.8 14V15.6L13.1 13.4V17.4L17.8 20.6V22L13.1 21.2L12.6 22.8H11.4L10.9 21.2'
    + 'L6.2 22V20.6L10.9 17.4V13.4L2.2 15.6V14L10.9 8.2V4.4Z',

  // РСЗВ: вантажівка з пакетом труб, піднятим під кутом над кабіною. Прорізи в пакеті — самі труби:
  // саме вони відрізняють реактивну систему від пускової ППО з двома-трьома контейнерами.
  mlrs:
    'M1.8 15H17.2V10.2H20.6L22.4 12.4V17.2H1.8ZM2.9 19.7A2.1 2.1 0 1 0 7.1 19.7'
    + 'A2.1 2.1 0 1 0 2.9 19.7ZM7.7 19.7A2.1 2.1 0 1 0 11.9 19.7A2.1 2.1 0 1 0 7.7 19.7ZM17.1 19.7'
    + 'A2.1 2.1 0 1 0 21.3 19.7A2.1 2.1 0 1 0 17.1 19.7ZM3 14.2L14.04 8.33L12.07 4.62L1.03 10.49Z'
    + 'M3.5 12.58L13.47 7.27L13.14 6.65L3.17 11.96ZM2.89 11.43L12.86 6.12L12.53 5.51L2.56 10.81ZM6 15'
    + 'V12.6L8 11.54V15Z',

  // Артилерія: гаубиця на колесі — довгий ствол із дульним гальмом під пологим кутом, станина до
  // землі й колесо зі ступицею. Довгий пологий ствол і колесо — те, чим вона не схожа на міномет.
  artillery:
    'M5.23 11.66L13.03 7.56L13.29 8.05L19.47 4.76L19.28 4.41L20.52 3.75L21.6 5.78L20.36 6.44'
    + 'L20.17 6.09L13.99 9.37L14.25 9.86L7.51 13.39L4 20.2H2.4L2.7 19.4L5.98 13.07ZM6.3 17.3'
    + 'A4.4 4.4 0 1 0 15.1 17.3A4.4 4.4 0 1 0 6.3 17.3ZM7.8 17.3A2.9 2.9 0 1 0 13.6 17.3'
    + 'A2.9 2.9 0 1 0 7.8 17.3ZM9.45 17.3A1.25 1.25 0 1 0 11.95 17.3A1.25 1.25 0 1 0 9.45 17.3Z',

  // Міномет: коротка товста труба круто вгору на двоногому лафеті, з опорною плитою під казенником.
  mortar:
    'M7.78 20.26L16.98 3.86L14.62 2.54L5.42 18.94ZM4.2 20.6H11.2V21.8H4.2ZM13.5 10.2L14.9 9.9L20 20.8'
    + 'H18.4L15.5 14.8L15.9 20.8H14.3Z',

  // Комбінована: малий «Шахед» і ракета поруч, ракета попереду — крило дрона підрізано вздовж неї.
  // Два різні засоби в одному повідомленні, а не рій однакових.
  combined:
    'M8.6 5.8L9.42 7.09V8.52L14.31 13.69V12.87H15.05V17.09H14.31V16.14L9.42 16.82V17.63H7.78V16.82'
    + 'L2.89 16.14V17.09H1.94V12.87H2.89V13.69L7.78 8.52V7.09ZM6.29 18.18H10.91V18.99H6.29ZM17.6 2.2'
    + 'L18.76 4L19.05 5.6V15.8L21.35 18.8V20L19.05 19.2V18.4H16.15V19.2L13.85 20V18.8L16.15 15.8V5.6'
    + 'L16.44 4Z',

  // Невизначена: жирний знак питання в кільці. Відсутність класифікації, а не її різновид.
  unknown:
    'M.8 12A11.2 11.2 0 1 0 23.2 12A11.2 11.2 0 1 0 .8 12ZM2.8 12A9.2 9.2 0 1 0 21.2 12'
    + 'A9.2 9.2 0 1 0 2.8 12ZM7.3 9A4.7 4.7 0 1 1 15.6 12.02L13.4 13.4V15.4H10.6V12.8L13.46 10.22'
    + 'A1.9 1.9 0 1 0 10.1 9ZM10.45 18.3A1.55 1.55 0 1 0 13.55 18.3A1.55 1.55 0 1 0 10.45 18.3Z'
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
