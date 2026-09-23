import { pool } from '../db/pool.js';
import { tokenize, type PlaceToken } from '../domain/place-morphology.js';
import {
  COARSE_TYPES, TRACK_WINDOW_MINUTES, classMaxKmh, greatCircleKm, placePoint, plausibleKm, reportPositions,
  trackWindow
} from '../domain/threat-motion.js';
import type { EvidenceLevel } from '../types.js';
import { actualizationApplies, latestActualizations, type TrackActualization } from './track-actualization.js';

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
 *
 * ## Two views of one chain: the history and the track
 *
 * The chain grew for as long as its event lived, and that is what the map got wrong: every
 * classification of a live event was projected and nothing aged out, so a vector showed where a
 * target had been reported thirty, twenty and ten minutes ago; a target circling a town drew
 * mirrored arcs over it; and a message naming an oblast and a town zig-zagged between the two. The
 * archive is not wrong — it is the history — so the threat dialog (`/api/v1/threats/:id/vector`)
 * still gets all of it. The map (`/api/v1/vectors`) gets the TRACK: the part of the same chain that
 * is still current, cut by rules that are the same for every event.
 *
 *   * A window per class ({@link TRACK_WINDOW_MINUTES}): a ballistic report is old after six
 *     minutes, a Shahed report after twenty-five. A node older than its class's horizon is history.
 *     The newest node — the HEAD — is never cut; when even the head is older than the horizon the
 *     event has no track at all, and its territory marker is what still shows it. A head older than
 *     the shorter head-stale window is published as `stale`, because stale data must look stale.
 *   * One node per place. A→B→A is two places and a return, not three places and two mirrored arcs;
 *     the node counts its `visits`, the head moves to the revisited place, and a return is a loiter —
 *     as is a head restated three times over four minutes with no new place in between.
 *   * No leg a member of the class could not have flown. The event merge rule
 *     (`src/domain/event-merge.ts`) already refuses a message its class could not have reached from
 *     the event's head, so what is left for this rule is what still reaches one event without being
 *     measured: an expected event that merges by place alone, a place with no coordinate, an event
 *     glued before that rule existed («Київ → Кропивницький», 250 km in 116 s). Walking back from the
 *     head, the track stops at the first leg longer than the class's fastest member covers in the
 *     time between the two reports (`CLASS_MAX_KMH` in `src/domain/threat-motion.ts`); the older group
 *     is history.
 *   * At most four nodes: the head and the three freshest others.
 *   * No oblast (or country) node while the track holds anything finer.
 *   * The head message's stated destination is the `heading`, not a node. «В районі Кагарлика
 *     курсом на Київ» puts the head at Кагарлик and says where it is going, instead of drawing the
 *     target into Kyiv. A message that named only a destination still makes it the head: it is the
 *     only place that message gave.
 *   * An ended event keeps its track for five minutes, marked `ended`, and then leaves the map.
 *
 * Every age in the payload is measured when the payload is built, and that is honest only because
 * the public list is memoised for one second (`src/api/vector-routes.ts`): an age is never older
 * than the memo that carries it.
 *
 * ## The model may shape the track, and nothing else
 *
 * In `classifier_mode=codex`, with the `actualization` feature on, the fast model re-reads an event's
 * recent messages and says where the target is now ({@link TrackActualization}). Its row is used only
 * when its confidence is at least 0.6, when it has seen the event's newest classification in this
 * publication slice, and when it was written before the slice's cutoff — a row written later may have
 * read a held message, and its head or its summary would publish what the hold is holding. Even then
 * it only chooses among what the chain already holds: a head or a loiter must be a node of the
 * event's history, a heading a place one of its messages named, and an id that maps onto neither is
 * ignored. It never creates, ends or merges an event, never touches an alert and is never an
 * all-clear. Every other case — the feature off, the `rules` mode, a low confidence, a row that has
 * not seen the newest message, a failed read — is the deterministic track, so a vector never depends
 * on the model.
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

/** Where a node sits in its track: the oldest current place, a place in between, or the head. */
export type TrackNodeRole = 'origin' | 'trail' | 'head';

export interface ReportedVectorNode {
  index: number;
  locationId: string;
  name: string;
  locationType: string;
  firstReportedAt: string;
  lastReportedAt: string;
  coordinates: [number, number] | null;
  /**
   * `catalogue` — the coordinate the catalogue (`locations`) holds for the place: a settlement's
   * point, published as `point`; for a hromada, the centre of its area (migration 056), published as
   * `approximate` for the same reason a raion centroid is.
   * `raion_centroid` — the centroid of the ADM2 polygon, because raions have no catalogue
   * coordinate at all. It is an approximation of a district, not a position, and is published as
   * such so a client can draw it differently instead of implying a precision nobody reported.
   */
  coordinateSource: 'catalogue' | 'raion_centroid' | null;
  coordinatePrecision: CoordinatePrecision;
  reports: VectorReport[];
  /** Seconds since `lastReportedAt`, measured when the payload was built. */
  ageSeconds: number;
  /** Separate arrivals at this place: a restatement is not a visit, a return after another place is. */
  visits: number;
  role: TrackNodeRole;
  /** The place the track reads as circled. At most one node, and only while the track is `loitering`. */
  loiter: boolean;
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
  /** Seconds since `reportedAt` — the age of the report that made this leg's destination. */
  ageSeconds: number;
}

/**
 * `moving` / `loitering` — a fresh head, read by the rules or by the model; `stale` — the head is
 * older than its class's head-stale window; `ended` — the event's end is public and the track is on
 * its way off the map; `passed` and `unclear` — only ever a model's reading.
 */
export type ReportedTrackStatus = 'moving' | 'loitering' | 'passed' | 'ended' | 'unclear' | 'stale';

export interface ReportedTrackHeading {
  locationId: string;
  name: string;
  coordinates: [number, number] | null;
}

/** What turns a chain into something a map can read at a glance: which node is now, and how old. */
export interface ReportedTrack {
  status: ReportedTrackStatus;
  /** Index into the payload's own `nodes` of the place the target was last put at. */
  headIndex: number;
  /** A place the head message named as its destination. Never inferred, and never a node of the track. */
  heading: ReportedTrackHeading | null;
  headAgeSeconds: number;
  staleAfterSeconds: number;
  horizonSeconds: number;
  basis: 'rules' | 'model';
  /** The model's own sentence — only when `basis === 'model'`, like the two fields after it. */
  summary: string | null;
  model: string | null;
  confidence: number | null;
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
  track: ReportedTrack;
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
  /**
   * `threat_events.status` and `ended_at`. Optional so that a row built by hand still describes a
   * live event, which is what a row without them has always meant.
   */
  event_status?: string;
  event_ended_at?: Date | string | null;
}

// ------------------------------------------------------------------------------------------------
// Track windows
// ------------------------------------------------------------------------------------------------

// The per-class windows (`TRACK_WINDOW_MINUTES`) and the plausibility ceilings live in
// `src/domain/threat-motion.ts`. The event merge reads the same numbers, and an event and its track
// must agree on what «the same target» means.

/** Longest horizon of any class: no event whose last observation is older has a track to publish. */
const LONGEST_HORIZON_SECONDS = Math.max(...Object.values(TRACK_WINDOW_MINUTES).map((window) => window.horizon)) * 60;

/** How long an ended event's track stays on the map, marked `ended`. */
export const ENDED_TRACK_SECONDS = 5 * 60;
/** The head and three others: past that a track is a scribble, and the old end is history anyway. */
export const MAX_TRACK_NODES = 4;
/** The public list, newest head first. Forty legible tracks beat two hundred overlapping ones. */
export const MAX_PUBLISHED_TRACKS = 40;
/** The floor a model actualization must clear before it may shape a public track. */
export const ACTUALIZATION_MIN_CONFIDENCE = 0.6;

const LOITER_MIN_VISITS = 2;
const LOITER_MIN_REPORTS = 3;
const LOITER_MIN_SPAN_MS = 4 * 60_000;

/** The statuses `liveThreats` also treats as ended. */
const ENDED_EVENT_STATUSES: Readonly<Record<string, true>> = { expired: true, withdrawn: true, corrected: true };

// ------------------------------------------------------------------------------------------------
// Chain assembly
// ------------------------------------------------------------------------------------------------

/** The same mapping `ingestThreat` uses, so a segment never claims more than its event. */
export function evidenceForSource(tier: string, official: boolean): EvidenceLevel {
  if (official) return 'official';
  return tier === 'B' ? 'monitoring' : 'unverified';
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
  let tokens: PlaceToken[] | null = null;
  const text = () => tokens ??= tokenize((head.raw_text || head.direction_text || '').toLocaleLowerCase('uk-UA'));
  const plan = reportPositions(rows, head.decision === 'redirect' || head.intent === 'redirect', text);
  if (!plan) return null;
  const { positions, basis: pairBasis } = plan;

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
  const located = placePoint(row.location_id, row.latitude, row.longitude);
  if (located?.source === 'catalogue') {
    // A hromada's catalogue point is the centre of an area, or the settlement that governs it when that
    // centre falls outside the raion — never where anything was. Published as a point, it would claim a
    // precision nobody reported, exactly what `raion_centroid` below refuses to do.
    const precision: CoordinatePrecision = row.location_type === 'hromada' ? 'approximate' : 'point';
    return { coordinates: located.point, coordinateSource: 'catalogue', coordinatePrecision: precision };
  }
  if (located) return { coordinates: located.point, coordinateSource: 'raion_centroid', coordinatePrecision: 'approximate' };
  // Raions whose polygon is missing from the ADM2 file, and places the catalogue has no coordinate for.
  // The node is still published: "a source named this place at this time" is a fact whether or not it
  // can be drawn.
  return { coordinates: null, coordinateSource: null, coordinatePrecision: 'unavailable' };
}

const BASIS_STRENGTH: Readonly<Record<VectorSegmentBasis, number>> = {
  reported_transit: 3, reported_direction: 2, observation_sequence: 1
};

/** One place one message put the target at, in the order the whole event reported them. */
interface Position {
  step: ChainStep;
  /** 0, or 1 for the destination of an origin/destination pair. */
  offset: number;
  row: VectorChainRow;
  order: number;
}

interface Chain {
  eventId: string;
  eventThreatType: string;
  /** This event's rows only — every place any of its messages named, chosen or not. */
  rows: VectorChainRow[];
  positions: Position[];
  newestPublishedMs: number;
}

function prepareChain(eventId: string, rows: readonly VectorChainRow[]): Chain | null {
  const byClassification = new Map<string, VectorChainRow[]>();
  const own: VectorChainRow[] = [];
  // The event's own class, read off the join rather than queried again. Every row of this event
  // carries the same value, so the first one is the whole answer; `unknown` is the catalogue's own
  // name for "not classified" and is reachable only from a row shape a test built by hand.
  let eventThreatType = 'unknown';
  let newestPublishedMs = -Infinity;
  for (const row of rows) {
    if (row.event_id !== eventId) continue;
    own.push(row);
    if (row.event_threat_type) eventThreatType = row.event_threat_type;
    newestPublishedMs = Math.max(newestPublishedMs, new Date(row.published_at).getTime());
    const bucket = byClassification.get(row.classification_id);
    if (bucket) bucket.push(row); else byClassification.set(row.classification_id, [row]);
  }
  const steps = [...byClassification.values()]
    .map(planStep)
    .filter((step): step is ChainStep => step !== null)
    .sort((left, right) => left.atMs - right.atMs || left.classificationId.localeCompare(right.classificationId));
  if (!steps.length) return null;
  const positions: Position[] = [];
  for (const step of steps) {
    for (const [offset, row] of step.positions.entries()) positions.push({ step, offset, row, order: positions.length });
  }
  return { eventId, eventThreatType, rows: own, positions, newestPublishedMs };
}

interface Assembly {
  nodes: ReportedVectorNode[];
  segments: ReportedVectorSegment[];
  nodeOf: Map<Position, number>;
  visits: number[];
  /** The node's latest run of consecutive reports, which is what a loiter over it is read from. */
  lastRun: Array<{ reports: number; fromMs: number; toMs: number }>;
  /** Chain order of the node's latest report. */
  lastOrder: number[];
}

function leg(
  from: Position, to: Position, fromIndex: number, toIndex: number,
  origin: ReportedVectorNode, destination: ReportedVectorNode, eventThreatType: string
): ReportedVectorSegment {
  // Both ends from one message: that message stated the move. Otherwise the ordering is ours — also
  // when the message's own first end was cut from a track and the leg now starts at an older report.
  const oneMessage = from.step === to.step;
  const basis = oneMessage ? to.step.pairBasis : 'observation_sequence';
  const originSource = oneMessage ? null : sourceRef(from.step.row);
  const elapsedSeconds = oneMessage ? 0 : Math.max(0, Math.round((to.step.atMs - from.step.atMs) / 1000));
  const destinationSource = sourceRef(to.row);
  const independentEnds = originSource !== null
    && originSource.independenceGroup !== destinationSource.independenceGroup;
  let evidenceLevel = evidenceForSource(to.row.tier, to.row.official);
  // The same corroboration rule the event itself uses: two independent Tier A/B groups on the
  // two ends of one leg is what "confirmed" already means everywhere else in this system.
  if (evidenceLevel !== 'official' && independentEnds && originSource
    && ['A', 'B'].includes(originSource.tier) && ['A', 'B'].includes(to.row.tier)) {
    evidenceLevel = 'confirmed';
  }
  const missingCoordinates = [origin, destination]
    .filter((node) => node.coordinates === null)
    .map((node) => node.locationId);
  return {
    from: fromIndex,
    to: toIndex,
    basis,
    basisLabel: SEGMENT_BASIS_LABELS_UK[basis],
    // The class the DESTINATION message reported, because that is the message that made this
    // leg. A withdrawal records no class of its own, and then the event's stands in.
    threatType: to.row.classification_threat_type ?? eventThreatType,
    reportedAt: to.step.at,
    elapsedSeconds,
    evidenceLevel,
    source: destinationSource,
    originSource,
    independentEnds,
    statement: excerpt(to.row),
    drawable: missingCoordinates.length === 0,
    missingCoordinates,
    ageSeconds: 0
  };
}

/**
 * Nodes and segments out of positions in chain order.
 *
 * A source restating the tail's place strengthens that node and draws nothing. With
 * `collapseRevisits` — the track — a return to ANY place already on it lands on that node too and
 * counts a visit, which is what turns A→B→A into two places instead of three; without it — the
 * history — a return is a new node, exactly as the archive reads.
 */
function assemble(positions: readonly Position[], eventThreatType: string, collapseRevisits: boolean): Assembly {
  const nodes: ReportedVectorNode[] = [];
  const segments: ReportedVectorSegment[] = [];
  const nodeOf = new Map<Position, number>();
  const byLocation = new Map<string, number>();
  const visits: number[] = [];
  const lastRun: Assembly['lastRun'] = [];
  const lastOrder: number[] = [];
  let tail = -1;
  let previous: Position | null = null;

  for (const position of positions) {
    const { step, row } = position;
    let index: number;
    if (tail >= 0 && nodes[tail]!.locationId === row.location_id) {
      index = tail;
      lastRun[index]!.reports += 1;
      lastRun[index]!.toMs = step.atMs;
    } else {
      const known = collapseRevisits ? byLocation.get(row.location_id) : undefined;
      if (known !== undefined) {
        index = known;
        visits[index]! += 1;
        lastRun[index] = { reports: 1, fromMs: step.atMs, toMs: step.atMs };
      } else {
        index = nodes.length;
        nodes.push({
          index,
          locationId: row.location_id,
          name: row.name_uk,
          locationType: row.location_type,
          firstReportedAt: step.at,
          lastReportedAt: step.at,
          ...resolveCoordinates(row),
          reports: [],
          ageSeconds: 0,
          visits: 1,
          role: 'trail',
          loiter: false
        });
        byLocation.set(row.location_id, index);
        visits.push(1);
        lastRun.push({ reports: 1, fromMs: step.atMs, toMs: step.atMs });
        lastOrder.push(position.order);
      }
    }
    const node = nodes[index]!;
    node.lastReportedAt = step.at;
    node.reports.push({
      at: step.at,
      source: sourceRef(row),
      relationType: row.relation_type,
      role: row.role,
      sourceMessageId: row.source_message_id,
      alsoNamed: step.alsoNamed
    });
    nodeOf.set(position, index);
    lastOrder[index] = position.order;
    if (previous && index !== tail) {
      segments.push(leg(previous, position, tail, index, nodes[tail]!, node, eventThreatType));
    }
    tail = index;
    previous = position;
  }
  return { nodes, segments, nodeOf, visits, lastRun, lastOrder };
}

/**
 * The track's nodes in the order of their LATEST report, so the head is the last node and a return
 * reads as the move it was: A→B→A is drawn B→A, from where the target last was to where it is.
 * Segments are renumbered, and one leg is kept per pair of places — the newest, pointing the newest
 * way — because a leg flown twice is one line, not two mirrored arcs.
 */
function orderByLastReport(assembly: Assembly): Assembly {
  const sequence = assembly.nodes.map((_, index) => index)
    .sort((left, right) => assembly.lastOrder[left]! - assembly.lastOrder[right]!);
  const rank = new Map<number, number>();
  sequence.forEach((old, next) => rank.set(old, next));
  const nodes = sequence.map((old, next) => ({ ...assembly.nodes[old]!, index: next }));
  const seen = new Set<string>();
  const segments: ReportedVectorSegment[] = [];
  for (let index = assembly.segments.length - 1; index >= 0; index -= 1) {
    const segment = assembly.segments[index]!;
    const from = rank.get(segment.from)!, to = rank.get(segment.to)!;
    const pair = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    segments.push({ ...segment, from, to });
  }
  segments.reverse();
  return {
    nodes,
    segments,
    nodeOf: new Map([...assembly.nodeOf].map(([position, index]) => [position, rank.get(index)!])),
    visits: sequence.map((old) => assembly.visits[old]!),
    lastRun: sequence.map((old) => assembly.lastRun[old]!),
    lastOrder: sequence.map((old) => assembly.lastOrder[old]!)
  };
}

function ageSeconds(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
}

// ------------------------------------------------------------------------------------------------
// The track
// ------------------------------------------------------------------------------------------------

/**
 * Everything a track is measured against. Every field is optional: the defaults — now, no cutoff,
 * no model — are the deterministic track of the operator path.
 */
export interface TrackContext {
  /** Epoch milliseconds every age and window is measured against. */
  now?: number;
  /**
   * The publication cutoff the rows were read under; null on the operator path. An end recorded
   * after it is not public yet, and a model row written after it may have read held messages.
   */
  cutoff?: Date | null;
  /** `actualizationApplies()`: whether the public map may use actualizations at all right now. */
  actualizationApplies?: boolean;
  /** The event's latest actualization, as stored; every condition on it is checked here. */
  actualization?: TrackActualization | null;
}

/**
 * The actualization, if every condition to use it holds: the feature applies, confidence clears the
 * floor, the model has seen the newest classification this slice holds, and it was written before
 * the cutoff. With the last two together, the model can only have read what this slice may show: a
 * row written before the cutoff saw nothing classified after it, and one that has seen the newest
 * visible message is not behind the map it would be drawn on.
 */
function usableActualization(chain: Chain, context: TrackContext): TrackActualization | null {
  const candidate = context.actualization;
  if (!context.actualizationApplies || !candidate || candidate.eventId !== chain.eventId) return null;
  if (!(candidate.confidence >= ACTUALIZATION_MIN_CONFIDENCE)) return null;
  if (!(Date.parse(candidate.asOf) >= chain.newestPublishedMs)) return null;
  if (context.cutoff && !(Date.parse(candidate.createdAt) <= context.cutoff.getTime())) return null;
  return candidate;
}

/**
 * When the event's end became public, or null while it reads as live. An end recorded after the
 * cutoff is not public yet: until the hold passes `liveThreats` still projects the event as `active`,
 * and the track must not announce the end before the map does.
 */
function publishedEnd(chain: Chain, cutoff: Date | null | undefined): number | null {
  const row = chain.rows[0]!;
  if (!row.event_status || ENDED_EVENT_STATUSES[row.event_status] !== true || row.event_ended_at == null) return null;
  const endedAtMs = new Date(row.event_ended_at).getTime();
  if (!Number.isFinite(endedAtMs)) return null;
  if (cutoff && endedAtMs > cutoff.getTime()) return null;
  return endedAtMs;
}

function newestPositionAt(positions: readonly Position[], locationId: string | null): Position | null {
  if (!locationId) return null;
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    if (positions[index]!.row.location_id === locationId) return positions[index]!;
  }
  return null;
}

function newestRowAt(rows: readonly VectorChainRow[], locationId: string | null): VectorChainRow | null {
  if (!locationId) return null;
  let newest: VectorChainRow | null = null;
  let newestMs = -Infinity;
  for (const row of rows) {
    if (row.location_id !== locationId) continue;
    const at = new Date(row.published_at).getTime();
    if (at >= newestMs) { newest = row; newestMs = at; }
  }
  return newest;
}

type MeasuredNode = ReportedVectorNode & { coordinates: [number, number] };

/**
 * A node whose position can be measured. A node without a coordinate cannot, and neither can an
 * oblast or the country: their catalogue point is not where anything was, so a leg to one proves
 * nothing either way — and a track made only of oblasts would otherwise be cut between neighbours.
 */
function measurable(node: ReportedVectorNode): node is MeasuredNode {
  return node.coordinates !== null && COARSE_TYPES[node.locationType] !== true;
}

/**
 * How far the track reaches from the head in one direction — `-1` towards older nodes, `1` towards
 * newer ones, which only a model's head can have — before the first leg no member of the class could
 * have flown in the time between its two latest reports. Every measurable node is compared with the
 * nearest measurable one on the head's side, so a place that cannot be measured neither causes a cut
 * nor hides one. What lies past the cut is another group that reached the event without being
 * measured on the way in.
 */
function plausibleReach(nodes: readonly ReportedVectorNode[], headAt: number, direction: -1 | 1, maxKmh: number): number {
  let reach = headAt;
  let anchor = measurable(nodes[headAt]!) ? nodes[headAt] as MeasuredNode : null;
  for (let index = headAt + direction; index >= 0 && index < nodes.length; index += direction) {
    const node = nodes[index]!;
    if (measurable(node)) {
      if (anchor) {
        const elapsedMs = Date.parse(anchor.lastReportedAt) - Date.parse(node.lastReportedAt);
        if (greatCircleKm(anchor.coordinates, node.coordinates) > plausibleKm(maxKmh, elapsedMs)) break;
      }
      anchor = node;
    }
    reach = index;
  }
  return reach;
}

interface ComposedTrack {
  positions: Position[];
  /** The position the head stands on, and the one the loiter does; both exist in the history too. */
  head: Position;
  loiter: Position | null;
  nodes: ReportedVectorNode[];
  segments: ReportedVectorSegment[];
  track: ReportedTrack;
  /** Whether `/api/v1/vectors` may carry it. The dialog carries the track object regardless. */
  publishable: boolean;
}

/**
 * The deterministic track, and the model's reading over it when that reading may be used.
 *
 * Positions are selected first — the window, the oblast rule, the heading — and only then assembled,
 * so a leg is only ever built between two reports that are both still current: cutting a place out
 * of the middle bridges its neighbours with an `observation_sequence` leg rather than keeping a leg
 * whose end is gone. The plausibility break and the node cap work the same way, on assembled nodes:
 * they choose which places stay, and the track is assembled again from those places' reports.
 */
function composeTrack(chain: Chain, context: TrackContext, nowMs: number): ComposedTrack {
  const { horizonSeconds, staleAfterSeconds } = trackWindow(chain.eventThreatType);
  const model = usableActualization(chain, context);
  const all = chain.positions;
  const newestStep = all[all.length - 1]!.step;

  let fromMs = nowMs - horizonSeconds * 1000;
  const since = model?.currentSince ? Date.parse(model.currentSince) : Number.NaN;
  // The model's «everything before this is history» can only shorten the window, never lengthen it.
  if (Number.isFinite(since)) fromMs = Math.max(fromMs, since);

  // The model chooses among places the chain holds; an id it does not hold is ignored, not added.
  const modelHead = model ? newestPositionAt(all, model.headLocationId) : null;
  let modelLoiter = model?.status === 'loitering' ? newestPositionAt(all, model.loiterLocationId) : null;
  const pinned = new Set<Position>([modelHead, modelLoiter].filter((position): position is Position => position !== null));

  let positions = all.filter((position) =>
    position.step.atMs >= fromMs || position.step === newestStep || pinned.has(position));
  if (positions.some((position) => COARSE_TYPES[position.row.location_type] !== true)) {
    positions = positions.filter((position) => COARSE_TYPES[position.row.location_type] !== true || pinned.has(position));
  }

  // The head message's destination becomes the heading when the same message also put the target
  // somewhere; that somewhere is the head. When the first half was an oblast the rule above already
  // dropped, the destination is all that is left of the message, and it stays the head.
  let head = positions[positions.length - 1]!;
  let heading: VectorChainRow | null = null;
  const pairEnd = head.step.positions[1];
  const pairStart = positions.find((position) => position.step === head.step && position.offset === 0);
  if (pairEnd && pairStart) {
    heading = pairEnd;
    positions = positions.filter((position) =>
      position.step !== head.step || position.offset === 0 || pinned.has(position));
    head = pairStart;
  }
  if (modelHead) head = modelHead;
  const modelHeading = model ? newestRowAt(chain.rows, model.headingLocationId) : null;
  if (modelHeading) heading = modelHeading;
  if (heading && heading.location_id === head.row.location_id) heading = null;

  // Nodes in the order of their latest report: the freshest are last, and two neighbours are a move
  // the reports made in that order — which is what the break below measures.
  let assembly = orderByLastReport(assemble(positions, chain.eventThreatType, true));
  const headAt = assembly.nodeOf.get(head)!;
  const maxKmh = classMaxKmh(chain.eventThreatType);
  const first = plausibleReach(assembly.nodes, headAt, -1, maxKmh);
  const last = plausibleReach(assembly.nodes, headAt, 1, maxKmh);
  // A model loiter on the far side of a break belongs to the other group: ignored, like any id the
  // track does not hold.
  const loiterAt = modelLoiter ? assembly.nodeOf.get(modelLoiter)! : -1;
  if (loiterAt < first || loiterAt > last) modelLoiter = null;
  // Then the cap: the head, the model's loiter, and the freshest others up to four.
  const keep = new Set<number>([headAt]);
  if (modelLoiter) keep.add(loiterAt);
  for (let index = last; index >= first && keep.size < MAX_TRACK_NODES; index -= 1) keep.add(index);
  if (keep.size < assembly.nodes.length) {
    const cut = assembly;
    positions = positions.filter((position) => keep.has(cut.nodeOf.get(position)!));
    assembly = orderByLastReport(assemble(positions, chain.eventThreatType, true));
  }

  const headIndex = assembly.nodeOf.get(head)!;
  const headNode = assembly.nodes[headIndex]!;
  const headAgeSeconds = ageSeconds(headNode.lastReportedAt, nowMs);
  const endedAtMs = publishedEnd(chain, context.cutoff);
  const run = assembly.lastRun[headIndex]!;
  const circles = assembly.visits[headIndex]! >= LOITER_MIN_VISITS
    || (run.reports >= LOITER_MIN_REPORTS && run.toMs - run.fromMs >= LOITER_MIN_SPAN_MS);

  // The event's own end outranks every reading of it. After that, «passed» and «ended» are the
  // model's statements about the target and stay true however old the head is; everything else is a
  // reading of a CURRENT position, and an old head turns it into `stale` whoever read it.
  let status: ReportedTrackStatus;
  if (endedAtMs !== null) status = 'ended';
  else if (model && (model.status === 'passed' || model.status === 'ended')) status = model.status;
  else if (headAgeSeconds > staleAfterSeconds) status = 'stale';
  else if (model) status = model.status;
  else status = circles ? 'loitering' : 'moving';
  const loiter = status === 'loitering' ? modelLoiter ?? head : null;
  const loiterIndex = loiter ? assembly.nodeOf.get(loiter)! : -1;

  assembly.nodes.forEach((node, index) => {
    node.ageSeconds = ageSeconds(node.lastReportedAt, nowMs);
    node.visits = assembly.visits[index]!;
    node.role = index === headIndex ? 'head' : index === 0 ? 'origin' : 'trail';
    node.loiter = index === loiterIndex;
  });
  for (const segment of assembly.segments) segment.ageSeconds = ageSeconds(segment.reportedAt, nowMs);

  const track: ReportedTrack = {
    status,
    headIndex,
    heading: heading
      ? { locationId: heading.location_id, name: heading.name_uk, coordinates: resolveCoordinates(heading).coordinates }
      : null,
    headAgeSeconds,
    staleAfterSeconds,
    horizonSeconds,
    basis: model ? 'model' : 'rules',
    summary: model?.summary ?? null,
    model: model?.model ?? null,
    confidence: model?.confidence ?? null
  };
  // A lone node with nothing to point at is a place somebody named — the territory marker already
  // shows it. A lone node WITH a heading or a loiter is a statement the marker cannot make.
  const publishable = headAgeSeconds <= horizonSeconds
    && (endedAtMs === null || nowMs - endedAtMs <= ENDED_TRACK_SECONDS * 1000)
    && (assembly.segments.length > 0 || track.heading !== null || loiterIndex >= 0);
  return {
    positions, head, loiter, nodes: assembly.nodes, segments: assembly.segments, track, publishable
  };
}

function envelope(
  chain: Chain, positions: readonly Position[], nodes: ReportedVectorNode[],
  segments: ReportedVectorSegment[], track: ReportedTrack
): ReportedVector {
  const sources = new Set<string>();
  const groups = new Set<string>();
  for (const node of nodes) {
    for (const report of node.reports) {
      sources.add(report.source.id);
      groups.add(report.source.independenceGroup);
    }
  }
  const first = positions[0]!.step;
  const last = positions[positions.length - 1]!.step;
  const strongestBasis = segments.length
    ? segments.reduce((best, segment) => BASIS_STRENGTH[segment.basis] > BASIS_STRENGTH[best] ? segment.basis : best, segments[0]!.basis)
    : null;
  return {
    eventId: chain.eventId,
    kind: REPORTED_VECTOR_KIND,
    threatType: chain.eventThreatType,
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
    },
    track
  };
}

/**
 * One event's whole chain — the history the threat dialog shows — with its current track described
 * over it: `track.headIndex` points at the history node that took the head's report.
 *
 * Pure on purpose: every rule that decides what a chain claims is exercised by
 * `src/services/threat-vectors.test.ts` without a database, so the ladder in the module docblock is
 * pinned by tests rather than by review.
 */
export function buildReportedVector(
  eventId: string, rows: readonly VectorChainRow[], context: TrackContext = {}
): ReportedVector | null {
  const chain = prepareChain(eventId, rows);
  if (!chain) return null;
  const nowMs = context.now ?? Date.now();
  const history = assemble(chain.positions, chain.eventThreatType, false);
  const current = composeTrack(chain, context, nowMs);
  const headIndex = history.nodeOf.get(current.head)!;
  const loiterIndex = current.loiter ? history.nodeOf.get(current.loiter)! : -1;
  const visitsByPlace = new Map<string, number>();
  for (const node of history.nodes) visitsByPlace.set(node.locationId, (visitsByPlace.get(node.locationId) ?? 0) + 1);
  history.nodes.forEach((node, index) => {
    node.ageSeconds = ageSeconds(node.lastReportedAt, nowMs);
    node.visits = visitsByPlace.get(node.locationId)!;
    node.role = index === headIndex ? 'head' : index === 0 ? 'origin' : 'trail';
    node.loiter = index === loiterIndex;
  });
  for (const segment of history.segments) segment.ageSeconds = ageSeconds(segment.reportedAt, nowMs);
  return envelope(chain, chain.positions, history.nodes, history.segments, { ...current.track, headIndex });
}

/**
 * One event's current track — what the map draws — or null when the map must not draw it: the head
 * is past its horizon, the end is more than five minutes old, or a lone node points at nothing.
 */
export function buildReportedTrack(
  eventId: string, rows: readonly VectorChainRow[], context: TrackContext = {}
): ReportedVector | null {
  const chain = prepareChain(eventId, rows);
  if (!chain) return null;
  const current = composeTrack(chain, context, context.now ?? Date.now());
  if (!current.publishable) return null;
  return envelope(chain, current.positions, current.nodes, current.segments, current.track);
}

export interface TrackListContext {
  now?: number;
  cutoff?: Date | null;
  actualizationApplies?: boolean;
  actualizations?: ReadonlyMap<string, TrackActualization>;
}

/**
 * ONE pass to bucket, instead of one pass over the whole result per event. The builders open by
 * skipping every row that is not their own, which made a per-event loop O(events × rows): the live
 * set is capped at 200 events and an event carries ten to thirty chain rows, so a rebuild visited
 * ~8·10⁵ rows to read ~4·10³ — synchronously, on the event loop, at the exact moment every open tab
 * refetches on the same SSE event. Bucketing costs one visit per row and leaves the filter in the
 * builders intact, which matters because they are pure and `src/services/threat-vectors.test.ts`
 * hands them rows of a FOREIGN event to prove they refuse them. The rows arrive
 * `ORDER BY mc.event_id, …`, so a bucket keeps the order the query chose.
 */
function bucketByEvent(rows: readonly VectorChainRow[]): Map<string, VectorChainRow[]> {
  const rowsByEvent = new Map<string, VectorChainRow[]>();
  for (const row of rows) {
    const bucket = rowsByEvent.get(row.event_id);
    if (bucket) bucket.push(row); else rowsByEvent.set(row.event_id, [row]);
  }
  return rowsByEvent;
}

/** The public list: every publishable track, newest head first, at most {@link MAX_PUBLISHED_TRACKS}. */
export function buildReportedTracks(
  eventIds: readonly string[], rows: readonly VectorChainRow[], context: TrackListContext = {}
): ReportedVector[] {
  const now = context.now ?? Date.now();
  const rowsByEvent = bucketByEvent(rows);
  const tracks: Array<{ vector: ReportedVector; headMs: number }> = [];
  for (const eventId of eventIds) {
    const eventRows = rowsByEvent.get(eventId);
    if (!eventRows) continue;
    const vector = buildReportedTrack(eventId, eventRows, {
      now,
      cutoff: context.cutoff,
      actualizationApplies: context.actualizationApplies,
      actualization: context.actualizations?.get(eventId) ?? null
    });
    if (vector) tracks.push({ vector, headMs: Date.parse(vector.nodes[vector.track.headIndex]!.lastReportedAt) });
  }
  return tracks
    .sort((left, right) => right.headMs - left.headMs || left.vector.eventId.localeCompare(right.vector.eventId))
    .slice(0, MAX_PUBLISHED_TRACKS)
    .map((entry) => entry.vector);
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
         te.status AS event_status, te.ended_at AS event_ended_at,
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

const NO_ACTUALIZATIONS = {
  actualizationApplies: false,
  actualizations: new Map<string, TrackActualization>() as ReadonlyMap<string, TrackActualization>
};

/**
 * The model's overlay, or none. Asked whether it applies FIRST, so the default — the `rules` mode,
 * the feature off — costs one settings read and no actualization query at all. A failure of either
 * read is not an error of the chain: the deterministic track stands without the model, and serving it
 * is exactly what the contract promises for every failure.
 */
async function actualizationOverlay(eventIds: readonly string[]): Promise<typeof NO_ACTUALIZATIONS> {
  try {
    if (!(await actualizationApplies())) return NO_ACTUALIZATIONS;
    return { actualizationApplies: true, actualizations: await latestActualizations(eventIds) };
  } catch {
    return NO_ACTUALIZATIONS;
  }
}

export interface VectorQueryOptions {
  /** What every age is measured against. */
  now?: Date;
  /**
   * Let the model's latest actualization shape `track` where it may. The public dialog asks for it,
   * so it describes the same track the map draws; the operator paths do not need it and skip the read.
   */
  actualize?: boolean;
}

/**
 * Whole chains — the history — for the given events, in the order asked.
 *
 * `cutoff` defaults to `null` — UNBOUNDED — so `src/services/vector-projection.ts` keeps the whole
 * chain for the operator extrapolation, which is exempt from the hold by design. Every PUBLIC caller
 * passes `slice.cutoffAt`.
 */
export async function reportedVectorsForEvents(
  eventIds: string[], cutoff: Date | null = null, options: VectorQueryOptions = {}
): Promise<ReportedVector[]> {
  if (!eventIds.length) return [];
  const [result, overlay] = await Promise.all([
    pool.query<VectorChainRow>(CHAIN_QUERY, [eventIds, cutoff]),
    options.actualize ? actualizationOverlay(eventIds) : NO_ACTUALIZATIONS
  ]);
  const now = (options.now ?? new Date()).getTime();
  const rowsByEvent = bucketByEvent(result.rows);
  const vectors: ReportedVector[] = [];
  for (const eventId of eventIds) {
    const rows = rowsByEvent.get(eventId);
    if (!rows) continue;
    const vector = buildReportedVector(eventId, rows, {
      now, cutoff,
      actualizationApplies: overlay.actualizationApplies,
      actualization: overlay.actualizations.get(eventId) ?? null
    });
    // A single-node chain is a place somebody named, not a vector. Publishing it as one would put a
    // dot on the map that looks like the start of a route nobody reported.
    if (vector && vector.segments.length) vectors.push(vector);
  }
  return vectors;
}

export async function reportedVectorForEvent(
  eventId: string, cutoff: Date | null = null, options: VectorQueryOptions = {}
): Promise<ReportedVector | null> {
  const [vector] = await reportedVectorsForEvents([eventId], cutoff, options);
  return vector ?? null;
}

/**
 * The events the map may be drawing a track for.
 *
 * The same statuses and the same publication cutoff as `liveThreats(cutoff)` — a track for an event
 * the map is not showing is the one way this overlay could assert something no marker backs — with
 * two deliberate differences. The window is the longest track horizon instead of twelve hours: every
 * classification that lands on an event raises `last_observed_at` to its own publication time
 * (`GREATEST` in `ingestThreat`), so an event observed longer ago than any horizon has no head left to
 * publish, and reading its chain would be work thrown away on every refetch. And an ended event stays
 * five minutes past its end, because its track is published as `ended` for exactly that long; an end
 * still inside the hold (`ended_at > $1`) is in the same branch and reads as live, as it does on
 * `liveThreats`.
 */
const LIVE_TRACK_EVENTS_QUERY = `
  SELECT id FROM threat_events
   WHERE last_observed_at > now() - make_interval(secs => $2)
     AND created_at <= $1
     AND ( status IN ('observed','confirmed','active')
        OR ( status IN ('expired','withdrawn','corrected')
             AND ended_at > now() - make_interval(secs => $3) AND updated_at > now() - interval '1 hour' ) )
   ORDER BY last_observed_at DESC LIMIT 200`;

/**
 * Current tracks for the events the map is drawing — the public list.
 *
 * The cutoff is applied TWICE and both applications are load-bearing: once when choosing which
 * events to expand (an event created after the cutoff does not exist yet) and once inside the chain
 * itself (a classification recorded after the cutoff has not been published yet, even for an event
 * that has). Only the first gate existed, so a chain grew into held geography.
 */
export async function reportedVectorsForLiveEvents(cutoff: Date, now: Date = new Date()): Promise<ReportedVector[]> {
  const live = await pool.query<{ id: string }>(
    LIVE_TRACK_EVENTS_QUERY, [cutoff, LONGEST_HORIZON_SECONDS, ENDED_TRACK_SECONDS]
  );
  const eventIds = live.rows.map((row) => row.id);
  if (!eventIds.length) return [];
  const [result, overlay] = await Promise.all([
    pool.query<VectorChainRow>(CHAIN_QUERY, [eventIds, cutoff]),
    actualizationOverlay(eventIds)
  ]);
  return buildReportedTracks(eventIds, result.rows, { now: now.getTime(), cutoff, ...overlay });
}

/** Visibility, not existence: an event created after the cutoff is not yet a fact a public reader
 *  may learn, so it answers exactly as an event that never existed. */
export async function threatEventExists(eventId: string, cutoff: Date): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM threat_events WHERE id=$1 AND created_at <= $2`, [eventId, cutoff]
  );
  return Boolean(result.rowCount);
}
