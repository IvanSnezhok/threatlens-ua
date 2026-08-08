import { z } from 'zod';
import { config } from '../config.js';
import { CLASSIFIER_VERSION } from '../domain/classifier.js';
import { pool } from '../db/pool.js';
import {
  raionCentroids,
  reportedVectorForEvent,
  type ReportedVector,
  type ReportedVectorSegment,
  type VectorSegmentBasis
} from './threat-vectors.js';
import { codexChat } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';

/**
 * Operator-only extrapolation of a reported vector. **Nothing here may ever reach a public payload.**
 *
 * The public chain (`./threat-vectors.ts`) stops where the reporting stops. This module continues
 * the last leg, names the places that fall inside the resulting cone and states how wrong it might
 * be. That is a calculation about the future, and the product commitment — "the map renders only an
 * explicitly reported region, point or direction" — holds only because this calculation is not on
 * the map, not in `/api/v1/snapshot`, not in the SSE stream and not in the bot.
 *
 * ## The separation is positional, not disciplinary
 *
 * The import arrow points one way only: this module imports the public chain builder, and the public
 * chain builder does not know this module exists. Public routes live in `../api/vector-routes.ts`
 * and import only `./threat-vectors.js`; the ops route lives in `../api/ops-vector-routes.ts` and is
 * the only other file allowed to reach here. `src/api/vector-isolation.test.ts` walks the real
 * module graph from every public entry point and fails the build if any of them reaches this file,
 * and separately fails if the token `ops_threat_vector` appears in a module a public response can
 * reach. Storage matches: the results live in `ops_threat_vector_projections`, a table no public
 * query names, rather than in a column on `threat_events` that every `SELECT e.*` would have picked
 * up for free.
 *
 * ## "Calculation, not observation" is in the data
 *
 * Every stored row carries `data_nature='calculated'` under a CHECK constraint that permits no other
 * value, in the parent row and again in each candidate row. A consumer that reads one of these rows
 * and drops the caption has still read a row that cannot be anything but arithmetic.
 *
 * ## The model may write the sentence, never the vector
 *
 * The bearing, speed, horizon, cone and candidate list are computed here, deterministically, with no
 * network call. A configured model is offered the finished numbers and may only return a better
 * Ukrainian phrasing; the reply is schema-validated and additionally rejected if it contains a single
 * number the deterministic computation did not produce. Anything else falls back to the generated
 * wording, and `narrative_origin` records which of the two an operator is reading. The pattern —
 * validate, clamp, fall back, record the run — is the one `./risk.ts` established for `callModel`.
 */

const EARTH_RADIUS_KM = 6371.0088;
const DEFAULT_HORIZON_MINUTES = 15;
const MAX_HORIZON_MINUTES = 60;
/** Along-track share of the horizon distance treated as unknown. Speed from two reports is coarse. */
const ALONG_TRACK_FRACTION = 0.35;
/** Extra kilometres when a leg endpoint is a raion polygon centroid rather than a real coordinate. */
const APPROXIMATE_COORDINATE_PENALTY_KM = 25;
const MAX_CANDIDATES = 6;

export type ProjectionUnavailableReason =
  | 'no_chain'
  | 'no_drawable_leg'
  | 'no_elapsed_time'
  | 'implausible_speed';

export interface ProjectionCandidate {
  locationId: string;
  name: string;
  locationType: string;
  rank: number;
  angularDeviationDegrees: number;
  distanceKm: number;
  minutesToReach: number;
  withinUncertainty: boolean;
  coordinatePrecision: 'point' | 'approximate';
}

export interface VectorProjection {
  id: string | null;
  eventId: string;
  /** Not a label. The same word is a CHECK-constrained column on every row this produces. */
  dataNature: 'calculated';
  computedAt: string;
  method: 'last_leg_linear';
  basis: {
    fromLocationId: string;
    toLocationId: string;
    fromName: string;
    toName: string;
    observedFrom: string;
    observedTo: string;
    segmentBasis: VectorSegmentBasis;
    segmentCount: number;
    independenceGroups: number;
    usesApproximateCoordinates: boolean;
  };
  bearingDegrees: number;
  groundSpeedKmh: number;
  horizonMinutes: number;
  horizonDistanceKm: number;
  geometry: {
    centerline: { type: 'LineString'; coordinates: Array<[number, number]> };
    cone: { type: 'Polygon'; coordinates: Array<Array<[number, number]>> };
  };
  uncertainty: {
    lateralHalfAngleDegrees: number;
    radiusKmAtHorizon: number;
    confidence: 'low' | 'medium';
    reasons: string[];
  };
  candidates: ProjectionCandidate[];
  narrative: string;
  narrativeOrigin: 'deterministic' | 'model';
  modelVersion: string | null;
}

export type ProjectionResult =
  | { available: true; projection: VectorProjection }
  | { available: false; reason: ProjectionUnavailableReason; eventId: string };

// ------------------------------------------------------------------------------------------------
// Spherical helpers
// ------------------------------------------------------------------------------------------------

const toRadians = (degrees: number) => degrees * Math.PI / 180;
const toDegrees = (radians: number) => radians * 180 / Math.PI;

export function distanceKm(from: [number, number], to: [number, number]): number {
  const [lon1, lat1] = from, [lon2, lat2] = to;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing, degrees clockwise from north. */
export function bearingDegrees(from: [number, number], to: [number, number]): number {
  const [lon1, lat1] = from, [lon2, lat2] = to;
  const phi1 = toRadians(lat1), phi2 = toRadians(lat2);
  const dLambda = toRadians(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function destinationPoint(from: [number, number], bearing: number, distance: number): [number, number] {
  const [lon, lat] = from;
  const delta = distance / EARTH_RADIUS_KM;
  const theta = toRadians(bearing);
  const phi1 = toRadians(lat), lambda1 = toRadians(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return [((toDegrees(lambda2) + 540) % 360) - 180, toDegrees(phi2)];
}

/** Signed smallest difference between two bearings, in degrees. */
export function angularDifference(left: number, right: number): number {
  return ((((left - right) % 360) + 540) % 360) - 180;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

// ------------------------------------------------------------------------------------------------
// Deterministic computation
// ------------------------------------------------------------------------------------------------

function lastDrawableLeg(vector: ReportedVector): ReportedVectorSegment | null {
  for (let index = vector.segments.length - 1; index >= 0; index -= 1) {
    const segment = vector.segments[index]!;
    if (segment.drawable) return segment;
  }
  return null;
}

/**
 * Half-angle of the cone, in degrees.
 *
 * Every term is an admission rather than a tuning constant. A single leg means the heading has never
 * been corroborated by a second one; an approximate endpoint means the heading was measured between
 * a district centroid and something else; a very short elapsed time means the speed is the ratio of
 * two coarse numbers; a stale last report means the target has had time to turn. The floor is wide
 * because a narrow cone is a claim, and the ceiling is wide because past it the cone stops meaning
 * anything and the honest output is "unknown", which `confidence: 'low'` already says.
 */
export function coneHalfAngle(input: {
  segmentCount: number;
  approximateCoordinates: boolean;
  elapsedSeconds: number;
  staleSeconds: number;
  basis: VectorSegmentBasis;
  /** The interval came from the node timestamps because one message stated both ends. */
  timingInferred?: boolean;
}): { halfAngle: number; reasons: string[] } {
  const reasons: string[] = [];
  let halfAngle = 12;
  if (input.segmentCount < 2) { halfAngle += 8; reasons.push('Лише один відрізок ланцюга: курс не підтверджено другим переходом'); }
  if (input.approximateCoordinates) { halfAngle += 10; reasons.push('Один із кінців — центроїд полігона району, а не координата з каталогу'); }
  // A `redirect` states both ends of the move in one sentence, which gives a heading but never an
  // interval. Falling back to the node timestamps mixes a transit statement with whatever else was
  // published about those places, so the resulting speed is an estimate about the chain rather than
  // a measurement of the leg — and the cone has to say so.
  if (input.timingInferred) { halfAngle += 8; reasons.push('Час між кінцями відрізка не виміряно: одне повідомлення назвало обидва кінці, інтервал узято з міток вузлів'); }
  if (input.elapsedSeconds > 0 && input.elapsedSeconds < 60) { halfAngle += 6; reasons.push('Між повідомленнями менше хвилини: оцінка швидкості груба'); }
  if (input.basis === 'observation_sequence') { halfAngle += 6; reasons.push('Рух не стверджувало жодне повідомлення — це послідовність окремих спостережень'); }
  const staleMinutes = input.staleSeconds / 60;
  if (staleMinutes > 5) {
    halfAngle += Math.min(20, Math.floor(staleMinutes / 5) * 5);
    reasons.push('Останнє повідомлення не свіже: ціль могла змінити курс');
  }
  return { halfAngle: Math.min(60, round(halfAngle, 1)), reasons };
}

function conePolygon(
  origin: [number, number], bearing: number, horizonDistance: number, halfAngle: number, radiusKm: number
): { type: 'Polygon'; coordinates: Array<Array<[number, number]>> } {
  const near = Math.max(0.5, horizonDistance * (1 - ALONG_TRACK_FRACTION));
  const far = horizonDistance * (1 + ALONG_TRACK_FRACTION) + radiusKm * 0.25;
  const steps = 12;
  const outer: Array<[number, number]> = [];
  const inner: Array<[number, number]> = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = bearing - halfAngle + (2 * halfAngle * step) / steps;
    outer.push(destinationPoint(origin, angle, far));
    inner.unshift(destinationPoint(origin, angle, near));
  }
  const ring = [...outer, ...inner];
  ring.push(ring[0]!);
  return { type: 'Polygon', coordinates: [ring] };
}

interface CandidateSource {
  id: string;
  name_uk: string;
  type: string;
  latitude: number | string | null;
  longitude: number | string | null;
}

async function candidateLocations(): Promise<Array<{
  id: string; name: string; type: string; point: [number, number]; precision: 'point' | 'approximate';
}>> {
  const rows = (await pool.query<CandidateSource>(
    `SELECT id,name_uk,type,latitude,longitude FROM locations WHERE type <> 'country'`
  )).rows;
  const centroids = raionCentroids();
  const out: Array<{ id: string; name: string; type: string; point: [number, number]; precision: 'point' | 'approximate' }> = [];
  for (const row of rows) {
    const latitude = row.latitude == null ? null : Number(row.latitude);
    const longitude = row.longitude == null ? null : Number(row.longitude);
    if (latitude != null && longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      out.push({ id: row.id, name: row.name_uk, type: row.type, point: [longitude, latitude], precision: 'point' });
      continue;
    }
    const centroid = centroids.get(row.id);
    if (centroid) out.push({ id: row.id, name: row.name_uk, type: row.type, point: centroid, precision: 'approximate' });
  }
  return out;
}

/** Which name wins when two catalogue entries resolve to the same point. */
const CANDIDATE_SPECIFICITY: Readonly<Record<string, number>> = {
  city: 0, special_city: 1, hromada: 2, raion: 3, oblast: 4
};

export function rankCandidates(
  origin: [number, number],
  bearing: number,
  horizonDistance: number,
  halfAngle: number,
  speedKmh: number,
  excluded: Set<string>,
  places: Array<{ id: string; name: string; type: string; point: [number, number]; precision: 'point' | 'approximate' }>
): ProjectionCandidate[] {
  const maxDistance = horizonDistance * (1 + ALONG_TRACK_FRACTION) * 1.15;
  const minDistance = Math.max(1, horizonDistance * (1 - ALONG_TRACK_FRACTION) * 0.6);
  const inSector = places
    .filter((place) => !excluded.has(place.id))
    .map((place) => {
      const distance = distanceKm(origin, place.point);
      const deviation = Math.abs(angularDifference(bearingDegrees(origin, place.point), bearing));
      return { place, distance, deviation };
    })
    .filter(({ distance, deviation }) => distance >= minDistance && distance <= maxDistance && deviation <= halfAngle * 1.5)
    .sort((left, right) => (left.deviation - right.deviation) || (left.distance - right.distance));
  // An oblast's catalogue coordinate is its administrative centre, so the oblast and its capital are
  // the same point under two names. Listing both would double the sector without adding a place.
  const byPoint = new Map<string, typeof inSector[number]>();
  for (const candidate of inSector) {
    const key = `${candidate.place.point[0].toFixed(4)},${candidate.place.point[1].toFixed(4)}`;
    const kept = byPoint.get(key);
    const rank = (type: string) => CANDIDATE_SPECIFICITY[type] ?? 9;
    if (!kept || rank(candidate.place.type) < rank(kept.place.type)) byPoint.set(key, candidate);
  }
  const scored = [...byPoint.values()]
    .sort((left, right) => (left.deviation - right.deviation) || (left.distance - right.distance))
    .slice(0, MAX_CANDIDATES);
  return scored.map(({ place, distance, deviation }, index) => ({
    locationId: place.id,
    name: place.name,
    locationType: place.type,
    rank: index + 1,
    angularDeviationDegrees: round(deviation, 1),
    distanceKm: round(distance, 1),
    minutesToReach: round((distance / speedKmh) * 60, 1),
    withinUncertainty: deviation <= halfAngle,
    coordinatePrecision: place.precision
  }));
}

function deterministicNarrative(projection: Omit<VectorProjection, 'narrative' | 'narrativeOrigin' | 'modelVersion' | 'id'>): string {
  const inside = projection.candidates.filter((candidate) => candidate.withinUncertainty);
  const names = inside.length ? inside.slice(0, 3).map((candidate) => candidate.name).join(', ') : null;
  return [
    'РОЗРАХУНОК, НЕ СПОСТЕРЕЖЕННЯ.',
    `Продовжено останній відрізок ланцюга ${projection.basis.fromName} → ${projection.basis.toName}`,
    `(${projection.basis.segmentBasis === 'observation_sequence' ? 'рух не стверджувало жодне повідомлення' : 'рух повідомлено джерелом'}).`,
    `Курс ${projection.bearingDegrees}°, оцінена швидкість ${projection.groundSpeedKmh} км/год,`,
    `горизонт ${projection.horizonMinutes} хв — це ${projection.horizonDistanceKm} км.`,
    `Невизначеність: сектор ±${projection.uncertainty.lateralHalfAngleDegrees}°, радіус ${projection.uncertainty.radiusKmAtHorizon} км на горизонті.`,
    names ? `У секторі опиняються: ${names}.` : 'У секторі немає жодного населеного пункту з каталогу.',
    'Жодне джерело цього не повідомляло.'
  ].join(' ');
}

/**
 * Builds the projection without touching the network or the database.
 *
 * Exported for `src/services/vector-projection.test.ts`: the numbers an operator acts on are pinned
 * by tests that never need a model, which is the executable form of "the vector is deterministic".
 */
export function computeProjection(
  vector: ReportedVector,
  places: Array<{ id: string; name: string; type: string; point: [number, number]; precision: 'point' | 'approximate' }>,
  options: { horizonMinutes?: number; now?: number } = {}
): ProjectionResult {
  const horizonMinutes = Math.min(MAX_HORIZON_MINUTES, Math.max(1, Math.round(options.horizonMinutes ?? DEFAULT_HORIZON_MINUTES)));
  const now = options.now ?? Date.now();
  if (!vector.segments.length) return { available: false, reason: 'no_chain', eventId: vector.eventId };
  const leg = lastDrawableLeg(vector);
  if (!leg) return { available: false, reason: 'no_drawable_leg', eventId: vector.eventId };
  const origin = vector.nodes[leg.from]!;
  const destination = vector.nodes[leg.to]!;
  const from = origin.coordinates!;
  const to = destination.coordinates!;

  // A leg both ends of which were stated by one message carries a heading but no interval. The
  // fallback is the span between the two nodes' own timestamps, which is an estimate about the chain
  // rather than a measurement of the leg — recorded as `timingInferred` and paid for in the cone.
  const timingInferred = leg.elapsedSeconds <= 0;
  const observedFrom = timingInferred ? origin.firstReportedAt : origin.lastReportedAt;
  const elapsedSeconds = timingInferred
    ? Math.max(0, Math.round((new Date(destination.lastReportedAt).getTime() - new Date(observedFrom).getTime()) / 1000))
    : leg.elapsedSeconds;
  if (elapsedSeconds <= 0) return { available: false, reason: 'no_elapsed_time', eventId: vector.eventId };

  const legDistance = distanceKm(from, to);
  const speed = round((legDistance / elapsedSeconds) * 3600, 1);
  // Above Mach ~7 at sea level the "speed" is an artefact of two reports landing seconds apart, not
  // a measurement. Refusing is more useful than a cone drawn across half the country.
  if (!Number.isFinite(speed) || speed <= 0 || speed > 9000) {
    return { available: false, reason: 'implausible_speed', eventId: vector.eventId };
  }

  const bearing = round(bearingDegrees(from, to), 1);
  const approximate = origin.coordinatePrecision === 'approximate' || destination.coordinatePrecision === 'approximate';
  const staleSeconds = Math.max(0, Math.round((now - new Date(destination.lastReportedAt).getTime()) / 1000));
  const { halfAngle, reasons } = coneHalfAngle({
    segmentCount: vector.segments.length,
    approximateCoordinates: approximate,
    elapsedSeconds,
    staleSeconds,
    basis: leg.basis,
    timingInferred
  });
  const horizonDistance = round((speed * horizonMinutes) / 60, 1);
  const lateral = horizonDistance * Math.tan(toRadians(halfAngle));
  const along = horizonDistance * ALONG_TRACK_FRACTION;
  const radiusKm = round(
    Math.sqrt(lateral ** 2 + along ** 2) + (approximate ? APPROXIMATE_COORDINATE_PENALTY_KM : 0), 1
  );
  // `medium` demands everything the calculation can ask for: a corroborated chain, real coordinates
  // at both ends, a measured interval, a source that stated the movement, and a recent last report.
  const confidence: 'low' | 'medium' =
    vector.segments.length >= 2 && !approximate && vector.span.independenceGroupCount >= 2
      && leg.basis !== 'observation_sequence' && staleSeconds <= 600 && !timingInferred
      ? 'medium'
      : 'low';
  if (confidence === 'low' && !reasons.length) {
    reasons.push('Екстраполяція спирається на два повідомлені спостереження — це не вимірювання траєкторії');
  }

  const horizonPoint = destinationPoint(to, bearing, horizonDistance);
  const candidates = rankCandidates(
    to, bearing, horizonDistance, halfAngle, speed,
    new Set([origin.locationId, destination.locationId]), places
  );

  const core: Omit<VectorProjection, 'narrative' | 'narrativeOrigin' | 'modelVersion' | 'id'> = {
    eventId: vector.eventId,
    dataNature: 'calculated',
    computedAt: new Date(now).toISOString(),
    method: 'last_leg_linear',
    basis: {
      fromLocationId: origin.locationId,
      toLocationId: destination.locationId,
      fromName: origin.name,
      toName: destination.name,
      observedFrom,
      observedTo: destination.lastReportedAt,
      segmentBasis: leg.basis,
      segmentCount: vector.segments.length,
      independenceGroups: vector.span.independenceGroupCount,
      usesApproximateCoordinates: approximate
    },
    bearingDegrees: bearing,
    groundSpeedKmh: speed,
    horizonMinutes,
    horizonDistanceKm: horizonDistance,
    geometry: {
      centerline: { type: 'LineString', coordinates: [to, horizonPoint] },
      cone: conePolygon(to, bearing, horizonDistance, halfAngle, radiusKm)
    },
    uncertainty: {
      lateralHalfAngleDegrees: halfAngle,
      radiusKmAtHorizon: radiusKm,
      confidence,
      reasons
    },
    candidates
  };

  return {
    available: true,
    projection: { ...core, id: null, narrative: deterministicNarrative(core), narrativeOrigin: 'deterministic', modelVersion: null }
  };
}

// ------------------------------------------------------------------------------------------------
// Optional model rewording, with validation and rollback
// ------------------------------------------------------------------------------------------------

const narrativeSchema = z.object({ narrative: z.string().min(20).max(700) });

/** Every number the deterministic computation produced, as plain values. */
export function allowedNumbers(projection: VectorProjection): Set<number> {
  const values = [
    projection.bearingDegrees, projection.groundSpeedKmh, projection.horizonMinutes,
    projection.horizonDistanceKm, projection.uncertainty.lateralHalfAngleDegrees,
    projection.uncertainty.radiusKmAtHorizon, projection.basis.segmentCount,
    projection.basis.independenceGroups,
    ...projection.candidates.flatMap((candidate) => [
      candidate.rank, candidate.angularDeviationDegrees, candidate.distanceKm, candidate.minutesToReach
    ])
  ];
  const allowed = new Set<number>();
  for (const value of values) {
    allowed.add(round(value, 2));
    allowed.add(Math.round(value));
  }
  return allowed;
}

/**
 * Whether a model-written sentence may be shown.
 *
 * Prose is the only thing the model is allowed to change, so any number it emits that the
 * computation did not produce is a hallucinated measurement and disqualifies the whole reply. The
 * check is deliberately blunt — a rejected rewording costs an operator nothing, an invented speed
 * costs them their judgement.
 */
export function narrativeIsFaithful(narrative: string, allowed: Set<number>): boolean {
  const numbers = narrative.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  return numbers.every((token) => {
    const value = Number(token.replace(',', '.'));
    return Number.isFinite(value) && (allowed.has(round(value, 2)) || allowed.has(Math.round(value)));
  });
}

async function recordAiRun(status: 'success' | 'failed', input: unknown, output: unknown, error?: unknown, durationMs?: number): Promise<void> {
  // `validation_status` is a real verdict on this path, not a placeholder: `narrativeIsFaithful`
  // has already run by the time either call site gets here, so `'passed'` means the rewording
  // introduced no number the computation did not produce, and `'rejected'` means it did and the
  // deterministic wording stands.
  await pool.query(
    `INSERT INTO ai_runs(model,prompt_version,input,output,status,error,duration_ms,
                         surface,classifier_version,validation_status,fallback_reason)
     VALUES ($1,'vector-narrative-v1',$2,$3,$4,$5,$6,'attacks',$7,$8,$5)`,
    [
      config.AI_MODEL || 'deterministic', JSON.stringify(input),
      output === undefined ? null : JSON.stringify(output), status,
      error === undefined ? null : String(error).slice(0, 800), durationMs ?? null,
      CLASSIFIER_VERSION, status === 'success' ? 'passed' : 'rejected'
    ]
  ).catch(() => undefined);
}

const REFINE_SYSTEM_PROMPT = 'Return only JSON: {"narrative": string}. Rewrite the supplied Ukrainian operator note '
  + 'more clearly. This is an internal extrapolation, not an observation: the wording must keep '
  + 'saying so. Never introduce a number that is not already in the input, never name a target, '
  + 'an impact or a place that is not in the candidate list, and never state that anybody reported '
  + 'the projected movement.';

function refineInput(projection: VectorProjection) {
  return {
    bearingDegrees: projection.bearingDegrees,
    groundSpeedKmh: projection.groundSpeedKmh,
    horizonMinutes: projection.horizonMinutes,
    horizonDistanceKm: projection.horizonDistanceKm,
    uncertainty: projection.uncertainty,
    basis: projection.basis,
    candidates: projection.candidates.map((candidate) => ({ name: candidate.name, withinUncertainty: candidate.withinUncertainty })),
    deterministicNarrative: projection.narrative
  };
}

/**
 * The Codex attempt, which an operator switches on in `/ops` under "аналіз атак".
 *
 * Tried before `AI_*` and skipped entirely when the switch is off, so an installation that has
 * never opened the console behaves exactly as it did before. It returns the projection unchanged on
 * every failure — including the number-faithfulness check, which is the whole reason a rewording is
 * allowed to touch this text at all — and `codexChat` has already written the `ai_runs` row by then,
 * so a refusal is visible in the console without being visible in the output.
 */
async function refineWithCodex(projection: VectorProjection): Promise<VectorProjection | null> {
  if (!await codexFeatureEnabled('attacks')) return null;
  const input = refineInput(projection);
  const result = await codexChat({
    promptVersion: 'vector-narrative-v1',
    surface: 'attacks',
    classifierVersion: CLASSIFIER_VERSION,
    system: REFINE_SYSTEM_PROMPT,
    user: JSON.stringify(input),
    json: true,
    auditInput: input
  });
  if (!result.ok) return null;
  try {
    const parsed = narrativeSchema.parse(JSON.parse(result.content));
    if (!narrativeIsFaithful(parsed.narrative, allowedNumbers(projection))) return null;
    return { ...projection, narrative: parsed.narrative, narrativeOrigin: 'model', modelVersion: result.model };
  } catch {
    return null;
  }
}

export async function refineNarrative(projection: VectorProjection): Promise<VectorProjection> {
  const viaCodex = await refineWithCodex(projection).catch(() => null);
  if (viaCodex) return viaCodex;
  if (!config.AI_BASE_URL || !config.AI_API_KEY || !config.AI_MODEL) return projection;
  const input = {
    bearingDegrees: projection.bearingDegrees,
    groundSpeedKmh: projection.groundSpeedKmh,
    horizonMinutes: projection.horizonMinutes,
    horizonDistanceKm: projection.horizonDistanceKm,
    uncertainty: projection.uncertainty,
    basis: projection.basis,
    candidates: projection.candidates.map((candidate) => ({ name: candidate.name, withinUncertainty: candidate.withinUncertainty })),
    deterministicNarrative: projection.narrative
  };
  const started = Date.now();
  try {
    const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.AI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.AI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Return only JSON: {"narrative": string}. Rewrite the supplied Ukrainian operator note '
              + 'more clearly. This is an internal extrapolation, not an observation: the wording must keep '
              + 'saying so. Never introduce a number that is not already in the input, never name a target, '
              + 'an impact or a place that is not in the candidate list, and never state that anybody reported '
              + 'the projected movement.'
          },
          { role: 'user', content: JSON.stringify(input) }
        ]
      }),
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`AI endpoint ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI endpoint returned empty content');
    const parsed = narrativeSchema.parse(JSON.parse(content));
    if (!narrativeIsFaithful(parsed.narrative, allowedNumbers(projection))) {
      throw new Error('model narrative introduced a number the computation did not produce');
    }
    await recordAiRun('success', input, parsed, undefined, Date.now() - started);
    return { ...projection, narrative: parsed.narrative, narrativeOrigin: 'model', modelVersion: config.AI_MODEL };
  } catch (error) {
    // The deterministic wording is already correct; a failed rewording is a logged non-event.
    await recordAiRun('failed', input, undefined, error, Date.now() - started);
    return projection;
  }
}

// ------------------------------------------------------------------------------------------------
// Persistence — the only place in the project that writes the ops tables
// ------------------------------------------------------------------------------------------------

async function persist(projection: VectorProjection): Promise<VectorProjection> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ops_threat_vector_projections(
         event_id,basis_from_location_id,basis_to_location_id,basis_observed_from,basis_observed_to,
         basis_segment_basis,basis_segment_count,basis_independence_groups,
         basis_uses_approximate_coordinates,method,bearing_degrees,ground_speed_kmh,horizon_minutes,
         projection_geometry,lateral_half_angle_degrees,radius_km_at_horizon,confidence,
         uncertainty_reasons,narrative,narrative_origin,model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [
        projection.eventId, projection.basis.fromLocationId, projection.basis.toLocationId,
        projection.basis.observedFrom, projection.basis.observedTo, projection.basis.segmentBasis,
        projection.basis.segmentCount, projection.basis.independenceGroups,
        projection.basis.usesApproximateCoordinates, projection.method, projection.bearingDegrees,
        projection.groundSpeedKmh, projection.horizonMinutes, JSON.stringify(projection.geometry),
        projection.uncertainty.lateralHalfAngleDegrees, projection.uncertainty.radiusKmAtHorizon,
        projection.uncertainty.confidence, projection.uncertainty.reasons, projection.narrative,
        projection.narrativeOrigin, projection.modelVersion
      ]
    );
    const id = inserted.rows[0]!.id;
    for (const candidate of projection.candidates) {
      await client.query(
        `INSERT INTO ops_threat_vector_projection_candidates(
           projection_id,location_id,rank,angular_deviation_degrees,distance_km,minutes_to_reach,
           within_uncertainty,coordinate_precision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          id, candidate.locationId, candidate.rank, candidate.angularDeviationDegrees,
          candidate.distanceKm, candidate.minutesToReach, candidate.withinUncertainty,
          candidate.coordinatePrecision
        ]
      );
    }
    await client.query('COMMIT');
    return { ...projection, id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Computes, optionally rewords, stores and returns the extrapolation for one event. */
export async function projectEventVector(
  eventId: string, options: { horizonMinutes?: number; store?: boolean } = {}
): Promise<ProjectionResult> {
  const vector = await reportedVectorForEvent(eventId);
  if (!vector) return { available: false, reason: 'no_chain', eventId };
  const places = await candidateLocations();
  const computed = computeProjection(vector, places, { horizonMinutes: options.horizonMinutes });
  if (!computed.available) return computed;
  const worded = await refineNarrative(computed.projection);
  return { available: true, projection: options.store === false ? worded : await persist(worded) };
}

export interface StoredProjectionRow {
  id: string;
  event_id: string;
  data_nature: string;
  computed_at: Date;
  method: string;
  bearing_degrees: string;
  ground_speed_kmh: string;
  horizon_minutes: number;
  projection_geometry: VectorProjection['geometry'];
  lateral_half_angle_degrees: string;
  radius_km_at_horizon: string;
  confidence: 'low' | 'medium';
  uncertainty_reasons: string[];
  narrative: string;
  narrative_origin: 'deterministic' | 'model';
  model_version: string | null;
  basis_from_location_id: string | null;
  basis_to_location_id: string | null;
  basis_segment_basis: VectorSegmentBasis;
  basis_segment_count: number;
  basis_independence_groups: number;
  basis_uses_approximate_coordinates: boolean;
  basis_observed_from: Date;
  basis_observed_to: Date;
}

export async function latestStoredProjection(eventId: string): Promise<
  { projection: StoredProjectionRow; candidates: Array<Record<string, unknown>> } | null
> {
  const result = await pool.query<StoredProjectionRow>(
    `SELECT * FROM ops_threat_vector_projections WHERE event_id=$1 ORDER BY computed_at DESC LIMIT 1`,
    [eventId]
  );
  const projection = result.rows[0];
  if (!projection) return null;
  const candidates = await pool.query(
    `SELECT c.*,l.name_uk FROM ops_threat_vector_projection_candidates c
       JOIN locations l ON l.id=c.location_id
      WHERE c.projection_id=$1 ORDER BY c.rank`,
    [projection.id]
  );
  return { projection, candidates: candidates.rows };
}

export async function recentProjections(limit = 20): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(
    `SELECT p.id,p.event_id,p.data_nature,p.computed_at,p.bearing_degrees,p.ground_speed_kmh,
            p.horizon_minutes,p.lateral_half_angle_degrees,p.radius_km_at_horizon,p.confidence,
            p.narrative,p.narrative_origin,e.title
       FROM ops_threat_vector_projections p
       JOIN threat_events e ON e.id=p.event_id
      ORDER BY p.computed_at DESC LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );
  return result.rows;
}
