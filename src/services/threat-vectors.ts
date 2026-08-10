import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../db/pool.js';
import type { EvidenceLevel } from '../types.js';

/**
 * The public half of threat vectors: a chain of **reported observations**, and nothing else.
 *
 * The product commitment — "the map renders only an explicitly reported region, point or direction;
 * it does not extrapolate a target or trajectory" — is unchanged by this module and its wording is
 * not softened anywhere. What this module publishes is a different statement: *these messages, from
 * these sources, at these times, named these places in this order*. It answers "three sources led
 * this target from A through B to C over eight minutes" without asserting where the target is now,
 * where it is going, or what it will hit.
 *
 * ## Where the chain comes from, and why it is derived rather than stored
 *
 * Nothing here is new information. `message_classifications` already records one row per classifier
 * decision together with the event it landed on, and `message_classification_locations` records the
 * places that decision named, the role each played (`asserted` / `retracted`) and, for the asserted
 * ones, the relation (`reported_direction`, `explicit_threat`, `mentioned`, `aftermath`,
 * `official_alert`). The chain is a projection of that archive, so it can never disagree with the
 * messages it claims to summarise, and a later classifier fix retroactively corrects every chain it
 * touched. A materialised copy would drift; this cannot.
 *
 * ## The evidence ladder, which is the whole point
 *
 * Segments are not equal and the payload never pretends they are. Three kinds, strongest first:
 *
 *   * `reported_transit` — one message stated the movement itself. `redirect` is exactly this:
 *     "Балістика повз Бровари на Бориспіль" retracts the place being passed and asserts the place
 *     being approached, in one sentence, from one source. It is the most precise movement signal
 *     this system has, and it is the only one where a single publisher vouched for both ends.
 *   * `reported_direction` — one message named a place *and* a direction out of it
 *     (`relation_type='reported_direction'`). The source stated a heading; it did not state arrival.
 *   * `observation_sequence` — two different messages named two different places at two different
 *     times. **The ordering is ours, the movement is not asserted by anybody.** This is the weakest
 *     rung and it is labelled as such in the payload, in the map legend and in the detail dialog,
 *     because a line drawn between two independent reports is the one thing here that could be
 *     mistaken for a trajectory.
 *
 * Nothing is continued past the last message: the chain ends where the reporting ends. Extrapolation
 * exists, is useful, and lives in `src/services/vector-projection.ts` behind ops authentication —
 * this module does not import it, cannot reach it, and `src/api/vector-isolation.test.ts` fails the
 * build if that ever changes.
 *
 * ## What is moving, not only where
 *
 * «Балістика повз Полтаву на Харків» names a class as plainly as it names two places, and a chain
 * that published only the places threw half of the sentence away — the map then had to guess the
 * class from a marker somewhere else, or say nothing. So both the envelope and every segment carry
 * `threatType`, and the two are not the same statement:
 *
 *   * the envelope's is `threat_events.threat_type` — the class the EVENT is filed under, which is
 *     the class every other public surface already shows for it;
 *   * a segment's is `message_classifications.threat_type` — the class the message that produced
 *     that leg's destination reported, falling back to the event's when that message recorded none
 *     (a withdrawal, or a decision that raised no class of its own). A chain whose class changes
 *     mid-way is a real thing — a report of БпЛА followed by a report of ballistics on the same
 *     event — and flattening it to the event's aggregate would hide exactly the change that matters.
 *
 * Both are additive: no existing field is renamed, retyped or removed, so a client written against
 * the previous payload keeps working unchanged.
 */

export const REPORTED_VECTOR_KIND = 'reported_observation_chain' as const;

/** Rendered on the map legend, in the threat dialog and returned with every payload. */
export const REPORTED_VECTOR_DISCLAIMER =
  'Послідовність повідомлень із часом і джерелом, а не траєкторія польоту. '
  + 'Система не прогнозує ціль, влучання або маршрут.';

export type VectorSegmentBasis = 'reported_transit' | 'reported_direction' | 'observation_sequence';

export const SEGMENT_BASIS_LABELS_UK: Readonly<Record<VectorSegmentBasis, string>> = {
  reported_transit: 'джерело повідомило сам рух',
  reported_direction: 'джерело повідомило напрямок',
  observation_sequence: 'послідовність окремих повідомлень'
};

export type CoordinatePrecision = 'point' | 'approximate' | 'unavailable';

export interface VectorSourceRef {
  id: string;
  name: string;
  tier: string;
  official: boolean;
  independenceGroup: string;
}

export interface VectorReport {
  at: string;
  source: VectorSourceRef;
  relationType: string | null;
  role: 'asserted' | 'retracted';
  sourceMessageId: string | null;
  /** Other places the same message named, so a node never hides the context it came from. */
  alsoNamed: string[];
}

export interface ReportedVectorNode {
  index: number;
  locationId: string;
  name: string;
  locationType: string;
  firstReportedAt: string;
  lastReportedAt: string;
  coordinates: [number, number] | null;
  /**
   * `catalogue` — the coordinate KATOTTG gives the place.
   * `raion_centroid` — the centroid of the ADM2 polygon, because raions have no catalogue
   * coordinate at all. It is an approximation of a district, not a position, and is published as
   * such so a client can draw it differently instead of implying a precision nobody reported.
   */
  coordinateSource: 'catalogue' | 'raion_centroid' | null;
  coordinatePrecision: CoordinatePrecision;
  reports: VectorReport[];
}

export interface ReportedVectorSegment {
  from: number;
  to: number;
  basis: VectorSegmentBasis;
  basisLabel: string;
  /**
   * The class this leg reports as moving: the destination message's own `threat_type`, or the
   * event's when that message recorded none. Never null — a leg always belongs to a classified
   * event — so a client may render it without a fallback of its own.
   */
  threatType: string;
  /** Publication time of the message that produced the destination end of this segment. */
  reportedAt: string;
  /** Time between the two ends as reported. `0` when one message stated both. */
  elapsedSeconds: number;
  evidenceLevel: EvidenceLevel;
  source: VectorSourceRef;
  /** The publisher of the origin end, when a different message produced it. */
  originSource: VectorSourceRef | null;
  /** The two ends came from different independence groups — a repost pair is not two sources. */
  independentEnds: boolean;
  /** What the message actually said, trimmed. Already public through `/api/v1/threats/:id`. */
  statement: string | null;
  /** False when either end has no coordinate; the segment still exists as a stated fact. */
  drawable: boolean;
  missingCoordinates: string[];
}

export interface ReportedVector {
  eventId: string;
  kind: typeof REPORTED_VECTOR_KIND;
  /** `threat_events.threat_type` — the same class the event card, the icon and the bot already name. */
  threatType: string;
  disclaimer: string;
  nodes: ReportedVectorNode[];
  segments: ReportedVectorSegment[];
  span: {
    from: string;
    to: string;
    elapsedSeconds: number;
    sourceCount: number;
    independenceGroupCount: number;
    /** Segments that can be drawn; the rest exist in the text only. */
    drawableSegments: number;
    strongestBasis: VectorSegmentBasis | null;
  };
}

export interface VectorChainRow {
  classification_id: string;
  event_id: string;
  published_at: Date | string;
  decision: string;
  intent: string;
  direction_text: string | null;
  source_message_id: string | null;
  /** `threat_events.threat_type` — NOT NULL in the schema, so the envelope always has a class. */
  event_threat_type: string;
  /** `message_classifications.threat_type` — nullable: a withdrawal raises no class of its own. */
  classification_threat_type: string | null;
  source_id: string;
  source_name: string;
  tier: string;
  official: boolean;
  independence_group: string;
  raw_text: string | null;
  location_id: string;
  role: 'asserted' | 'retracted';
  relation_type: string | null;
  name_uk: string;
  location_type: string;
  latitude: number | string | null;
  longitude: number | string | null;
}

// ------------------------------------------------------------------------------------------------
// Coordinates
// ------------------------------------------------------------------------------------------------

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
 * an approximation and is never silently promoted to a coordinate: it arrives with
 * `coordinateSource: 'raion_centroid'` and `coordinatePrecision: 'approximate'`.
 *
 * A missing or malformed file degrades to an empty index rather than an exception — the chain is
 * still correct as text, it simply has fewer drawable segments.
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

// ------------------------------------------------------------------------------------------------
// Chain assembly
// ------------------------------------------------------------------------------------------------

/** The same mapping `ingestThreat` uses, so a segment never claims more than its event. */
export function evidenceForSource(tier: string, official: boolean): EvidenceLevel {
  if (official) return 'official';
  return tier === 'B' ? 'monitoring' : 'unverified';
}

/**
 * How specific a place is. A message that names both "Київська область" and "Бориспіль" has told us
 * about Бориспіль; anchoring the chain on the oblast would throw that away and draw a line to the
 * middle of a region nobody pointed at.
 */
const TYPE_SPECIFICITY: Readonly<Record<string, number>> = {
  city: 0, special_city: 1, hromada: 2, raion: 3, oblast: 4, country: 5
};

function mostSpecific(rows: VectorChainRow[]): VectorChainRow | null {
  let best: VectorChainRow | null = null;
  for (const row of rows) {
    const rank = TYPE_SPECIFICITY[row.location_type] ?? 9;
    const bestRank = best ? TYPE_SPECIFICITY[best.location_type] ?? 9 : 10;
    if (rank < bestRank) best = row;
  }
  return best;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sourceRef(row: VectorChainRow): VectorSourceRef {
  return {
    id: row.source_id, name: row.source_name, tier: row.tier,
    official: row.official, independenceGroup: row.independence_group
  };
}

function excerpt(row: VectorChainRow): string | null {
  const text = row.direction_text?.trim() || row.raw_text?.trim();
  if (!text) return null;
  const collapsed = text.replace(/\s+/gu, ' ');
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

interface ChainStep {
  classificationId: string;
  at: string;
  atMs: number;
  row: VectorChainRow;
  /** Ordered positions this one message contributes: one, or an origin/destination pair. */
  positions: VectorChainRow[];
  /** Basis of the link *between* the two positions of this same message. */
  pairBasis: VectorSegmentBasis;
  alsoNamed: string[];
}

function planStep(rows: VectorChainRow[]): ChainStep | null {
  const head = rows[0];
  if (!head) return null;
  const asserted = rows.filter((row) => row.role === 'asserted');
  const retracted = rows.filter((row) => row.role === 'retracted');
  const directions = asserted.filter((row) => row.relation_type === 'reported_direction');
  const anchors = asserted.filter((row) => row.relation_type !== 'reported_direction');
  const isRedirect = head.decision === 'redirect' || head.intent === 'redirect';

  let positions: VectorChainRow[];
  let pairBasis: VectorSegmentBasis = 'observation_sequence';
  const transitOrigin = mostSpecific(retracted);
  const destination = mostSpecific(directions);
  const anchor = mostSpecific(anchors);

  if (isRedirect && transitOrigin && destination) {
    // "повз A на B": one publisher vouched for both ends of the move in one sentence.
    positions = [transitOrigin, destination];
    pairBasis = 'reported_transit';
  } else if (anchor && destination) {
    // The message named a place and a heading out of it. A heading is not an arrival.
    positions = [anchor, destination];
    pairBasis = 'reported_direction';
  } else if (destination) {
    positions = [destination];
  } else if (anchor) {
    positions = [anchor];
  } else if (transitOrigin) {
    // A retraction with nothing asserted moves no chain forward; it is still where the target was.
    positions = [transitOrigin];
  } else return null;

  const chosen = new Set(positions.map((row) => row.location_id));
  return {
    classificationId: head.classification_id,
    at: toIso(head.published_at),
    atMs: new Date(head.published_at).getTime(),
    row: head,
    positions,
    pairBasis,
    alsoNamed: [...new Set(rows.filter((row) => !chosen.has(row.location_id)).map((row) => row.name_uk))]
  };
}

function resolveCoordinates(row: VectorChainRow): Pick<ReportedVectorNode, 'coordinates' | 'coordinateSource' | 'coordinatePrecision'> {
  const latitude = row.latitude == null ? null : Number(row.latitude);
  const longitude = row.longitude == null ? null : Number(row.longitude);
  if (latitude != null && longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { coordinates: [longitude, latitude], coordinateSource: 'catalogue', coordinatePrecision: 'point' };
  }
  const centroid = raionCentroids().get(row.location_id);
  if (centroid) return { coordinates: centroid, coordinateSource: 'raion_centroid', coordinatePrecision: 'approximate' };
  // Hromadas, and raions whose polygon is missing from the ADM2 file. The node is still published:
  // "a source named this place at this time" is a fact whether or not it can be drawn.
  return { coordinates: null, coordinateSource: null, coordinatePrecision: 'unavailable' };
}

const BASIS_STRENGTH: Readonly<Record<VectorSegmentBasis, number>> = {
  reported_transit: 3, reported_direction: 2, observation_sequence: 1
};

/**
 * Assembles one event's chain from its archived classifier decisions.
 *
 * Pure on purpose: every rule that decides what a chain claims is exercised by
 * `src/services/threat-vectors.test.ts` without a database, so the ladder in the module docblock is
 * pinned by tests rather than by review.
 */
export function buildReportedVector(eventId: string, rows: VectorChainRow[]): ReportedVector | null {
  const byClassification = new Map<string, VectorChainRow[]>();
  // The event's own class, read off the join rather than queried again. Every row of this event
  // carries the same value, so the first one is the whole answer; `unknown` is the catalogue's own
  // name for "not classified" and is reachable only from a row shape a test built by hand.
  let eventThreatType = 'unknown';
  for (const row of rows) {
    if (row.event_id !== eventId) continue;
    if (row.event_threat_type) eventThreatType = row.event_threat_type;
    const bucket = byClassification.get(row.classification_id);
    if (bucket) bucket.push(row); else byClassification.set(row.classification_id, [row]);
  }
  const steps = [...byClassification.values()]
    .map(planStep)
    .filter((step): step is ChainStep => step !== null)
    .sort((left, right) => left.atMs - right.atMs || left.classificationId.localeCompare(right.classificationId));
  if (!steps.length) return null;

  const nodes: ReportedVectorNode[] = [];
  const segments: ReportedVectorSegment[] = [];
  let tail = -1;
  let tailStep: ChainStep | null = null;

  for (const step of steps) {
    for (const [offset, position] of step.positions.entries()) {
      const role = position.role;
      const report: VectorReport = {
        at: step.at,
        source: sourceRef(position),
        relationType: position.relation_type,
        role,
        sourceMessageId: position.source_message_id,
        alsoNamed: step.alsoNamed
      };
      const current = nodes[tail];
      let index: number;
      if (current && current.locationId === position.location_id) {
        // A source restating the same place does not advance the chain; it strengthens the node.
        current.lastReportedAt = step.at;
        current.reports.push(report);
        index = tail;
      } else {
        const coordinates = resolveCoordinates(position);
        index = nodes.length;
        nodes.push({
          index,
          locationId: position.location_id,
          name: position.name_uk,
          locationType: position.location_type,
          firstReportedAt: step.at,
          lastReportedAt: step.at,
          ...coordinates,
          reports: [report]
        });
      }

      if (tail >= 0 && index !== tail) {
        const origin = nodes[tail]!;
        const basis = offset === 0 ? 'observation_sequence' : step.pairBasis;
        const originSource = offset === 0 ? (tailStep ? sourceRef(tailStep.row) : null) : null;
        const elapsedSeconds = offset === 0 && tailStep
          ? Math.max(0, Math.round((step.atMs - tailStep.atMs) / 1000))
          : 0;
        const destinationSource = sourceRef(position);
        const independentEnds = originSource !== null
          && originSource.independenceGroup !== destinationSource.independenceGroup;
        let evidenceLevel = evidenceForSource(position.tier, position.official);
        // The same corroboration rule the event itself uses: two independent Tier A/B groups on the
        // two ends of one leg is what "confirmed" already means everywhere else in this system.
        if (evidenceLevel !== 'official' && independentEnds && originSource
          && ['A', 'B'].includes(originSource.tier) && ['A', 'B'].includes(position.tier)) {
          evidenceLevel = 'confirmed';
        }
        const missingCoordinates = [origin, nodes[index]!]
          .filter((node) => node.coordinates === null)
          .map((node) => node.locationId);
        segments.push({
          from: tail,
          to: index,
          basis,
          basisLabel: SEGMENT_BASIS_LABELS_UK[basis],
          // The class the DESTINATION message reported, because that is the message that made this
          // leg. A withdrawal records no class of its own, and then the event's stands in.
          threatType: position.classification_threat_type ?? eventThreatType,
          reportedAt: step.at,
          elapsedSeconds,
          evidenceLevel,
          source: destinationSource,
          originSource,
          independentEnds,
          statement: excerpt(position),
          drawable: missingCoordinates.length === 0,
          missingCoordinates
        });
      }
      tail = index;
    }
    tailStep = step;
  }

  const sources = new Set<string>();
  const groups = new Set<string>();
  for (const node of nodes) {
    for (const report of node.reports) {
      sources.add(report.source.id);
      groups.add(report.source.independenceGroup);
    }
  }
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const strongestBasis = segments.length
    ? segments.reduce((best, segment) => BASIS_STRENGTH[segment.basis] > BASIS_STRENGTH[best] ? segment.basis : best, segments[0]!.basis)
    : null;

  return {
    eventId,
    kind: REPORTED_VECTOR_KIND,
    threatType: eventThreatType,
    disclaimer: REPORTED_VECTOR_DISCLAIMER,
    nodes,
    segments,
    span: {
      from: first.at,
      to: last.at,
      elapsedSeconds: Math.max(0, Math.round((last.atMs - first.atMs) / 1000)),
      sourceCount: sources.size,
      independenceGroupCount: groups.size,
      drawableSegments: segments.filter((segment) => segment.drawable).length,
      strongestBasis
    }
  };
}

// ------------------------------------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------------------------------------

/**
 * `$2` is the publication cutoff, or NULL for the operator paths that are exempt from the hold.
 *
 * Bounded on `classified_at` (when the classification was RECORDED), never on `published_at`, which
 * migration 012 documents as «Publication time, not receipt time» — the Telegram post's own
 * timestamp, which a back-dated or edited message carries hours into the past and which would
 * therefore walk straight past any hold. `classified_at` is written within milliseconds of the
 * `threat_event_locations.created_at` that `liveThreats` already bounds, which is what keeps the two
 * surfaces in step: without this predicate a message naming a NEW raion for an ALREADY-PUBLISHED
 * event draws a chain node, a transit segment and a legend entry into a district the map is
 * simultaneously refusing to fill or icon, because `liveThreats` is holding it for the full cutoff.
 *
 * `message_classifications_event_idx` already narrows to the event's handful of rows, so the extra
 * predicate is a residual filter and needs no index of its own.
 */
const CHAIN_QUERY = `
  SELECT mc.id AS classification_id, mc.event_id, mc.published_at, mc.decision, mc.intent,
         mc.direction_text, mc.source_message_id,
         te.threat_type AS event_threat_type, mc.threat_type AS classification_threat_type,
         s.id AS source_id, s.name AS source_name, s.tier, s.official, s.independence_group,
         sm.raw_text,
         mcl.location_id, mcl.role, mcl.relation_type,
         l.name_uk, l.type AS location_type, l.latitude, l.longitude
    FROM message_classifications mc
    JOIN threat_events te ON te.id = mc.event_id
    JOIN sources s ON s.id = mc.source_id
    LEFT JOIN source_messages sm ON sm.id = mc.source_message_id
    JOIN message_classification_locations mcl ON mcl.classification_id = mc.id
    JOIN locations l ON l.id = mcl.location_id
   WHERE mc.event_id = ANY($1::uuid[])
     AND ($2::timestamptz IS NULL OR mc.classified_at <= $2)
   ORDER BY mc.event_id, mc.published_at, mc.id, mcl.role, mcl.location_id`;

/**
 * `cutoff` defaults to `null` — UNBOUNDED — so `src/services/vector-projection.ts` keeps the whole
 * chain for the operator extrapolation, which is exempt from the hold by design. Every PUBLIC caller
 * passes `slice.cutoffAt`.
 */
export async function reportedVectorsForEvents(
  eventIds: string[], cutoff: Date | null = null
): Promise<ReportedVector[]> {
  if (!eventIds.length) return [];
  const result = await pool.query<VectorChainRow>(CHAIN_QUERY, [eventIds, cutoff]);
  const vectors: ReportedVector[] = [];
  for (const eventId of eventIds) {
    const vector = buildReportedVector(eventId, result.rows);
    // A single-node chain is a place somebody named, not a vector. Publishing it as one would put a
    // dot on the map that looks like the start of a route nobody reported.
    if (vector && vector.segments.length) vectors.push(vector);
  }
  return vectors;
}

export async function reportedVectorForEvent(
  eventId: string, cutoff: Date | null = null
): Promise<ReportedVector | null> {
  const [vector] = await reportedVectorsForEvents([eventId], cutoff);
  return vector ?? null;
}

/**
 * Chains for the events the map is currently drawing.
 *
 * The window must mirror `liveThreats(cutoff)` exactly — the same statuses, the same twelve hours
 * AND the same publication cutoff — or the map draws an observation chain for a threat it is not
 * showing, which is the one way this overlay can assert something no marker backs.
 *
 * The cutoff is applied TWICE and both applications are load-bearing: once when choosing which
 * events to expand (an event created after the cutoff does not exist yet) and once inside the chain
 * itself (a classification recorded after the cutoff has not been published yet, even for an event
 * that has). Only the first gate existed, so a chain grew into held geography.
 */
export async function reportedVectorsForLiveEvents(cutoff: Date): Promise<ReportedVector[]> {
  const live = await pool.query<{ id: string }>(
    `SELECT id FROM threat_events
      WHERE last_observed_at > now() - interval '12 hours'
        AND created_at <= $1
        AND ( status IN ('observed','confirmed','active')
           OR ( status IN ('expired','withdrawn','corrected')
                AND ended_at > $1 AND updated_at > now() - interval '1 hour' ) )
      ORDER BY last_observed_at DESC LIMIT 200`, [cutoff]
  );
  return reportedVectorsForEvents(live.rows.map((row) => row.id), cutoff);
}

/** Visibility, not existence: an event created after the cutoff is not yet a fact a public reader
 *  may learn, so it answers exactly as an event that never existed. */
export async function threatEventExists(eventId: string, cutoff: Date): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM threat_events WHERE id=$1 AND created_at <= $2`, [eventId, cutoff]
  );
  return Boolean(result.rowCount);
}
