import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nameTokens, sameLexeme, type PlaceToken } from './place-morphology.js';

/**
 * Як рухається загроза і де стоять місця, між якими вона рухається — одне визначення на двох
 * споживачів.
 *
 * Трек загрози (`src/services/threat-vectors.ts`) вирішує цим, куди кожне повідомлення ставить ціль,
 * що на карті ще поточне і де трек рветься. Злиття подій (`./event-merge.ts`, `ingestThreat` у
 * `src/repositories/events.ts`) вирішує тим самим, чи нове повідомлення — та сама група: де воно
 * ставить ціль, чи подія ще у вікні свого класу і чи могла ціль долетіти від голови події до
 * названого місця. Дві копії цих правил дали б події й її треку два різні визначення «тієї самої
 * цілі», і трек знову мусив би ховати групи, які склеїло злиття.
 *
 * Модуль не читає бази й не знає конфігурації. Єдиний ввід-вивід — ліниве читання полігонів ADM2,
 * які карта й так віддає, заради центроїдів районів.
 */

// ------------------------------------------------------------------------------------------------
// Track windows
// ------------------------------------------------------------------------------------------------

/**
 * How long a report stays part of the track (`horizon`), and how long the head stays fresh
 * (`stale`), per class, in minutes.
 *
 * The numbers follow how fast each class makes a report untrue. A Shahed flies at walking pace next
 * to anything else here and is reported every few minutes over a flight of hours; a ballistic
 * missile is over in minutes, so a six-minute-old ballistic report describes a target that has
 * already arrived. `unknown` and `combined` take the middle of the table, because a window chosen for
 * the fastest possible class would cut a slow target's track while it is still flying, and one chosen
 * for the slowest would keep a fast target's history on the map long after it stopped being true.
 *
 * Той самий горизонт — вікно злиття: подія, яку востаннє бачили давніше за горизонт її класу, нового
 * повідомлення не приймає, бо її голова вже не описує, де ціль зараз.
 */
export const TRACK_WINDOW_MINUTES: Readonly<Record<string, { horizon: number; stale: number }>> = {
  uav: { horizon: 25, stale: 12 },
  combined: { horizon: 20, stale: 10 },
  unknown: { horizon: 20, stale: 10 },
  aviation: { horizon: 20, stale: 10 },
  cruise_missile: { horizon: 12, stale: 5 },
  guided_air_bomb: { horizon: 8, stale: 4 },
  ballistic_missile: { horizon: 6, stale: 3 },
  mlrs: { horizon: 10, stale: 5 },
  artillery: { horizon: 10, stale: 5 },
  mortar: { horizon: 10, stale: 5 }
};

/** The event's class decides the window; a class the table does not know reads as `unknown`. */
export function trackWindow(threatType: string): { horizonSeconds: number; staleAfterSeconds: number } {
  const window = TRACK_WINDOW_MINUTES[threatType] ?? TRACK_WINDOW_MINUTES.unknown!;
  return { horizonSeconds: window.horizon * 60, staleAfterSeconds: window.stale * 60 };
}

// ------------------------------------------------------------------------------------------------
// Plausibility
// ------------------------------------------------------------------------------------------------

/**
 * The fastest any member of each class flies, in km/h — a PLAUSIBILITY FILTER, not a speed estimate.
 *
 * Two readers ask the same question of it: could one target have covered the distance between two
 * reports in the time between them? The event merge asks it before a message may join an event —
 * reachable from the event's head, or it is another group — and the track asks it again, walking back
 * from the head, as a safety net for whatever still reaches one event with a leg nothing could have
 * flown («Київ → Кропивницький», 250 km reported 116 s apart). The allowance is the ceiling × the
 * time between the two reports, never less than {@link PLAUSIBLE_LAG_FLOOR_HOURS} because channels
 * lag each other by minutes, × {@link PLAUSIBLE_MARGIN}. Each ceiling is the fastest member of its
 * class, not a typical one — jet Shaheds for `uav` — so a genuinely fast leg is never cut;
 * `ballistic_missile` has none, because no distance in the country is beyond it. Like the animation
 * speed (CONTEXT.md, «Межі безпеки»), none of these numbers is a speed of any real target: they decide
 * only which reports belong together, and they reach no text, no API field and no risk score.
 */
export const CLASS_MAX_KMH: Readonly<Record<string, number>> = {
  uav: 600,
  cruise_missile: 1000,
  guided_air_bomb: 1000,
  aviation: 1200,
  combined: 1000,
  unknown: 1000,
  mlrs: 1000,
  artillery: 1000,
  mortar: 1000,
  ballistic_missile: Number.POSITIVE_INFINITY
};
export const PLAUSIBLE_LAG_FLOOR_HOURS = 10 / 60;
export const PLAUSIBLE_MARGIN = 1.3;

/** The class's ceiling; a class the table does not know reads as `unknown`. */
export function classMaxKmh(threatType: string): number {
  return CLASS_MAX_KMH[threatType] ?? CLASS_MAX_KMH.unknown!;
}

/**
 * How far a member of the class plausibly got between two reports `elapsedMs` apart, in either
 * order: `maxKmh` × max(time, {@link PLAUSIBLE_LAG_FLOOR_HOURS}) × {@link PLAUSIBLE_MARGIN}.
 */
export function plausibleKm(maxKmh: number, elapsedMs: number): number {
  return maxKmh * Math.max(Math.abs(elapsedMs) / 3_600_000, PLAUSIBLE_LAG_FLOOR_HOURS) * PLAUSIBLE_MARGIN;
}

/**
 * Great-circle distance in km between two [longitude, latitude] points. A copy of `distanceKm` in
 * `src/services/vector-projection.ts` rather than an import of it: that module is operator-only, and
 * no public module may import it (`src/api/vector-isolation.test.ts`).
 */
export function greatCircleKm(from: readonly [number, number], to: readonly [number, number]): number {
  const radians = Math.PI / 180;
  const dLat = (to[1] - from[1]) * radians;
  const dLon = (to[0] - from[0]) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(from[1] * radians) * Math.cos(to[1] * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ------------------------------------------------------------------------------------------------
// Places
// ------------------------------------------------------------------------------------------------

/**
 * How specific a place is. A message that names both "Київська область" and "Бориспіль" has told us
 * about Бориспіль; anchoring on the oblast would throw that away and point at the middle of a region
 * nobody pointed at.
 */
export const TYPE_SPECIFICITY: Readonly<Record<string, number>> = {
  city: 0, special_city: 1, hromada: 2, raion: 3, oblast: 4, country: 5
};

/**
 * An oblast or the country. Their catalogue point is not where anything was, so a distance to one
 * proves nothing either way; the track drops them as soon as it holds anything finer, and the merge
 * never lets one on its own join two groups.
 */
export const COARSE_TYPES: Readonly<Record<string, true>> = { oblast: true, country: true };

/**
 * Offset in the lower-cased message of the LAST place where `name` is named, or -1.
 *
 * Matched word by word in any case through the classifier's own declension table, so «з Борисполя на
 * Бровари» finds Бориспіль at its genitive. A place the text names only through an alias («Троя» for
 * Київ) is not found and loses the tie to any place that is, which is the right direction to fail:
 * the found one is certainly in the sentence.
 */
function lastMention(tokens: readonly PlaceToken[], name: string): number {
  const keys = nameTokens(name);
  if (!keys.length) return -1;
  for (let start = tokens.length - keys.length; start >= 0; start -= 1) {
    let matches = true;
    for (let offset = 0; offset < keys.length && matches; offset += 1) {
      matches = sameLexeme(keys[offset]!, tokens[start + offset]!.key);
    }
    if (matches) return tokens[start]!.start;
  }
  return -1;
}

/** One place one message named, as a row of `message_classification_locations` joined to `locations`. */
export interface ReportedPlace {
  role: string;
  relation_type: string | null;
  location_type: string;
  name_uk: string;
}

/**
 * The most specific of `rows`, and among equally specific places the one the message names LAST.
 *
 * The rows arrive ordered by `location_id`, and the first of a tie used to win — so «з Борисполя на
 * Бровари» anchored on Бориспіль because `boryspil` sorts before `brovary`, and the chain pointed the
 * wrong way. A Ukrainian report names where the target is going after where it comes from, so the
 * last-named place is the destination, which is the newer fact about the target. Only a tie pays for
 * reading the text; the id order stays as the last resort when no candidate is found in it.
 */
function mostSpecific<T extends ReportedPlace>(rows: readonly T[], text: () => readonly PlaceToken[]): T | null {
  let best: T | null = null;
  let bestRank = Infinity;
  let tied = false;
  for (const row of rows) {
    const rank = TYPE_SPECIFICITY[row.location_type] ?? 9;
    if (rank < bestRank) { best = row; bestRank = rank; tied = false; } else if (rank === bestRank) tied = true;
  }
  if (!best || !tied) return best;
  const tokens = text();
  let bestAt = lastMention(tokens, best.name_uk);
  for (const row of rows) {
    if (row === best || (TYPE_SPECIFICITY[row.location_type] ?? 9) !== bestRank) continue;
    const at = lastMention(tokens, row.name_uk);
    if (at > bestAt) { best = row; bestAt = at; }
  }
  return best;
}

/**
 * Where one message puts the target: one place, or an ordered pair and how the pair was attested.
 *
 * Одна відповідь на двох споживачів: трек малює з цих позицій вузли, а злиття подій порівнює їх, щоб
 * вирішити, чи повідомлення — та сама група. Решта названих місць — контекст («Київщина» поруч із
 * «Бровари», інші групи у зведенні по областях): до події вони прив'язуються, але цілі не ставлять.
 * `text` читається лише тоді, коли треба розрізнити однаково конкретні місця.
 */
export function reportPositions<T extends ReportedPlace>(
  rows: readonly T[], redirect: boolean, text: () => readonly PlaceToken[]
): { positions: T[]; basis: 'reported_transit' | 'reported_direction' | 'observation_sequence' } | null {
  const asserted = rows.filter((row) => row.role === 'asserted');
  const transitOrigin = mostSpecific(rows.filter((row) => row.role === 'retracted'), text);
  const destination = mostSpecific(asserted.filter((row) => row.relation_type === 'reported_direction'), text);
  const anchor = mostSpecific(asserted.filter((row) => row.relation_type !== 'reported_direction'), text);
  // "повз A на B": one publisher vouched for both ends of the move in one sentence.
  if (redirect && transitOrigin && destination) return { positions: [transitOrigin, destination], basis: 'reported_transit' };
  // The message named a place and a heading out of it. A heading is not an arrival.
  if (anchor && destination) return { positions: [anchor, destination], basis: 'reported_direction' };
  // A retraction with nothing asserted moves no chain forward; it is still where the target was.
  const single = destination ?? anchor ?? transitOrigin;
  return single ? { positions: [single], basis: 'observation_sequence' } : null;
}

const ADM2_PATH = 'public/data/ukraine-adm2.geojson';
let raionCentroidIndex: Map<string, [number, number]> | null = null;

function ringCentroid(ring: number[][]): [number, number] | null {
  let x = 0, y = 0, area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i], previous = ring[j];
    if (!current || !previous) continue;
    const cross = (previous[0]! * current[1]!) - (current[0]! * previous[1]!);
    area += cross;
    x += (previous[0]! + current[0]!) * cross;
    y += (previous[1]! + current[1]!) * cross;
  }
  if (area) return [x / (3 * area), y / (3 * area)];
  const first = ring[0];
  return first && first.length >= 2 ? [first[0]!, first[1]!] : null;
}

/** Centroid of the largest outer ring — the same rule the map already uses to place region labels. */
function largestRingCentroid(geometry: { type?: string; coordinates?: unknown }): [number, number] | null {
  const polygons: number[][][][] = geometry?.type === 'MultiPolygon'
    ? geometry.coordinates as number[][][][]
    : geometry?.type === 'Polygon' ? [geometry.coordinates as number[][][]] : [];
  let best: number[][] | null = null;
  let largest = 0;
  for (const polygon of polygons) {
    const outer = polygon?.[0];
    if (!Array.isArray(outer) || outer.length < 4) continue;
    let area = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const current = outer[i], previous = outer[j];
      if (!current || !previous) continue;
      area += (previous[0]! * current[1]!) - (current[0]! * previous[1]!);
    }
    if (Math.abs(area) > largest) { largest = Math.abs(area); best = outer; }
  }
  return best ? ringCentroid(best) : null;
}

/**
 * Raion centroids, read once from the ADM2 polygons the map already serves.
 *
 * KATOTTG carries no geometry for raions, so `locations.latitude/longitude` is null for all 136 of
 * them and a chain that passes through a raion would otherwise break in the middle. The centroid is
 * an approximation and is never silently promoted to a coordinate: the track publishes it with
 * `coordinateSource: 'raion_centroid'` and `coordinatePrecision: 'approximate'`.
 *
 * A missing or malformed file degrades to an empty index rather than an exception — the chain is
 * still correct as text, it simply has fewer drawable segments, and the merge falls back to naming
 * the same place.
 */
export function raionCentroids(): Map<string, [number, number]> {
  if (raionCentroidIndex) return raionCentroidIndex;
  const index = new Map<string, [number, number]>();
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), ADM2_PATH), 'utf8')) as {
      features?: Array<{ properties?: { locationId?: string }; geometry?: { type?: string; coordinates?: unknown } }>;
    };
    for (const feature of raw.features ?? []) {
      const id = feature?.properties?.locationId;
      if (!id || !feature.geometry) continue;
      const point = largestRingCentroid(feature.geometry);
      if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) index.set(id, point);
    }
  } catch {
    // The layer is optional geometry, not a data source. Chains stay readable without it.
  }
  raionCentroidIndex = index;
  return index;
}

/** Test seam: the index is cached for the process lifetime because the file never changes at runtime. */
export function resetRaionCentroidCache(): void {
  raionCentroidIndex = null;
}

/**
 * Де стоїть місце каталогу: його власна точка, а для району без неї — центроїд полігона ADM2. Порядок
 * той самий для треку й для злиття, тож відстань, через яку злиття відмовило, — та сама відстань, на
 * якій трек порвався б.
 */
export function placePoint(
  locationId: string, latitude: number | string | null | undefined, longitude: number | string | null | undefined
): { point: [number, number]; source: 'catalogue' | 'raion_centroid' } | null {
  const lat = latitude == null ? null : Number(latitude);
  const lon = longitude == null ? null : Number(longitude);
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    return { point: [lon, lat], source: 'catalogue' };
  }
  const centroid = raionCentroids().get(locationId);
  return centroid ? { point: centroid, source: 'raion_centroid' } : null;
}

// ------------------------------------------------------------------------------------------------
// Merge reach
// ------------------------------------------------------------------------------------------------

/**
 * Стала досяжність для ЗЛИТТЯ подій, у кілометрах від голови події, для класів, що не літають. Лише
 * для злиття: розрив треку й далі міряє {@link CLASS_MAX_KMH}.
 *
 * Стеля треку — найшвидший засіб класу в польоті, а вогонь з області в область не летить.
 * Реактивна, ствольна артилерія й міномети б'ють у межах дальності стволів (40 км), КАБ — у межах
 * планування (70 км), і скільки б хвилин не минуло між двома повідомленнями, місце за цими межами —
 * інша позиція, а не та сама група, що перемістилася. З тисячею кілометрів на годину треку «РСЗВ у
 * Сумах» приєднувалося до цілі «курсом на Чигирин Світловодськ» за 236 км.
 */
const MERGE_FIXED_REACH_KM: Readonly<Record<string, number>> = {
  mlrs: 40, artillery: 40, mortar: 40, guided_air_bomb: 70
};

/**
 * Як далеко від голови події може стояти повідомлення класу `threatType` через `elapsedMs` після неї
 * і ще бути тією самою групою: стала межа для вогню ({@link MERGE_FIXED_REACH_KM}), для решти — та
 * сама досяжність, що рве трек ({@link plausibleKm}). Злиття бере суворішу з досяжностей двох класів,
 * тож стала межа вирішує, хоч би яким був другий клас: навіть найповільніший летючий клас за
 * десятихвилинну нижню межу часу дотягується далі (БпЛА — 130 км).
 */
export function mergeReachKm(threatType: string, elapsedMs: number): number {
  return MERGE_FIXED_REACH_KM[threatType] ?? plausibleKm(classMaxKmh(threatType), elapsedMs);
}

/**
 * Найдалі від голови події крилатих ракет чи балістики, на якому повідомлення комбінованої атаки ще
 * розширює її до `combined`. Зведення, що називає кілька груп, ставить ціль туди, куди назвало
 * останню, і з тисячею кілометрів на годину дотягувалося б до 217 км: «Бандероль на Полтаву» ставала
 * комбінованою через «КАБ на Запоріжжя» наприкінці чужого зведення, за 199 км.
 */
export const COMBINED_WIDEN_MAX_KM = 150;
