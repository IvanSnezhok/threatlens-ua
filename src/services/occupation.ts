import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import polygonClipping, { type MultiPolygon, type Pair, type Polygon, type Ring } from 'polygon-clipping';
import { Counter, Gauge, type Registry } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Temporarily occupied territories layer.
 *
 * The upstream DeepStateMap feed is an editorial product: besides the Ukrainian front line it also
 * carries polygons for territories russia occupies outside Ukraine (Kaliningrad, Abkhazia, Karelia,
 * the Kuril Islands, occupied districts of Estonia and Latvia, and so on). Rendering the feed as-is
 * would put "occupied" polygons over the Baltics, Finland, Georgia and Japan on a map that claims to
 * show Ukraine. Therefore this module is built as a fail-safe allowlist: only explicitly approved
 * status keys are ever emitted, everything else is dropped, and every surviving polygon is then
 * clipped to the internationally recognised border of Ukraine as a second line of defence.
 */

export const OCCUPATION_SOURCE = 'deepstate';
export const OCCUPATION_ATTRIBUTION = { name: 'DeepStateMap', url: 'https://deepstatemap.live' } as const;

export type OccupationStatus = 'occupied' | 'contested' | 'liberated';

export type RejectionReason =
  | 'non_polygon_geometry'
  | 'missing_status_key'
  | 'non_ukrainian_territory'
  | 'unknown_status_key'
  | 'invalid_geometry'
  | 'outside_ukraine_border'
  | 'clip_failed';

export interface OccupationLogger {
  info: Function;
  warn: Function;
  error: Function;
}

/** Status keys that are allowed onto the map, mapped to our own vocabulary. */
const STATUS_ALLOWLIST: Readonly<Record<string, OccupationStatus>> = {
  'geoJSON.status.occupied': 'occupied',
  'geoJSON.territories.crimea': 'occupied',
  'geoJSON.territories.ordlo': 'occupied',
  'geoJSON.territories.tuzla': 'occupied',
  'geoJSON.status.unknown': 'contested',
  'geoJSON.status.dismissed': 'liberated',
  'geoJSON.zmiinyi_island': 'liberated'
};

/**
 * Keys that describe territory outside Ukraine. They are already excluded by the allowlist; the
 * explicit list exists so the intent is documented, testable and observable in metrics rather than
 * silently folded into "unknown key".
 */
export const NON_UKRAINIAN_STATUS_KEYS: readonly string[] = [
  'geoJSON.territories.prussia',
  'geoJSON.territories.abkhazia',
  'geoJSON.territories.karelia',
  'geoJSON.territories.ichkeria',
  'geoJSON.territories.petsamo',
  'geoJSON.territories.salla',
  'geoJSON.territories.estonia',
  'geoJSON.territories.pechorsky-district',
  'geoJSON.territories.latvia',
  'geoJSON.territories.kuril',
  'geoJSON.territories.tskhinvali-district',
  // Not part of the eleven territories listed upstream, but Transnistria is Moldova and its polygon
  // overlaps the Ukrainian border just enough to survive geometric clipping. It must be named here.
  'geoJSON.territories.transnistria'
];

const NON_UKRAINIAN_KEYS = new Set(NON_UKRAINIAN_STATUS_KEYS);

/** `geoJSON.status.dismissed_at {{at:27.03 - 31.03}}` — the suffix varies, the meaning does not. */
export const DISMISSED_AT_KEY = 'geoJSON.status.dismissed_at';
const DISMISSED_AT_PATTERN = /^geoJSON\.status\.dismissed_at(?:\s*\{\{\s*at\s*:([^}]*)\}\})?$/;

export const STATUS_LABELS_UK: Readonly<Record<OccupationStatus, string>> = {
  occupied: 'Тимчасово окупована територія України',
  contested: 'Територія, статус якої не підтверджено',
  liberated: 'Звільнена територія'
};

const UKRAINE_BOUNDARY_PATH = 'public/data/ukraine-adm0.geojson';
const COORDINATE_PRECISION = 1e6;
const FETCH_TIMEOUT_MS = 30_000;
const PAYLOAD_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// Metrics. Created detached so that importing this module never mutates a shared registry; the
// HTTP layer attaches them via registerOccupationMetrics().
// ---------------------------------------------------------------------------------------------

export const occupationFeaturesTotal = new Counter({
  name: 'threatlens_occupation_features_total',
  help: 'Occupation polygons accepted into the published layer',
  labelNames: ['status'] as const,
  registers: []
});
export const occupationRejectedTotal = new Counter({
  name: 'threatlens_occupation_rejected_total',
  help: 'Upstream occupation features rejected by the normalizer',
  labelNames: ['reason'] as const,
  registers: []
});
export const occupationUnknownStatusKeysTotal = new Counter({
  name: 'threatlens_occupation_unknown_status_keys_total',
  help: 'Occupation features carrying a status key this build does not recognise',
  registers: []
});
export const occupationSyncTotal = new Counter({
  name: 'threatlens_occupation_sync_total',
  help: 'Occupation layer sync attempts by result',
  labelNames: ['result'] as const,
  registers: []
});
export const occupationLastSuccessTimestamp = new Gauge({
  name: 'threatlens_occupation_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful occupation layer sync',
  registers: []
});

const OCCUPATION_METRICS: ReadonlyArray<[string, Counter<string> | Gauge<string>]> = [
  ['threatlens_occupation_features_total', occupationFeaturesTotal],
  ['threatlens_occupation_rejected_total', occupationRejectedTotal],
  ['threatlens_occupation_unknown_status_keys_total', occupationUnknownStatusKeysTotal],
  ['threatlens_occupation_sync_total', occupationSyncTotal],
  ['threatlens_occupation_last_success_timestamp_seconds', occupationLastSuccessTimestamp]
];

export function registerOccupationMetrics(registry: Registry): void {
  for (const [name, metric] of OCCUPATION_METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

// ---------------------------------------------------------------------------------------------
// Status key classification
// ---------------------------------------------------------------------------------------------

export type StatusDecision =
  | { accepted: true; status: OccupationStatus; statusKey: string; sinceLabel: string | null }
  | { accepted: false; reason: RejectionReason; statusKey: string | null };

/**
 * Upstream `properties.name` looks like `"Українською /// English /// geoJSON.status.KEY"`.
 * The trailing segment is the only part we trust; the localized halves are editorial prose.
 */
export function extractStatusKey(rawName: unknown): string | null {
  if (typeof rawName !== 'string') return null;
  const segments = rawName.split('///').map((segment) => segment.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const candidate = segments[segments.length - 1];
  if (!candidate || !candidate.startsWith('geoJSON.')) return null;
  return candidate;
}

export function classifyStatusKey(rawName: unknown): StatusDecision {
  const statusKey = extractStatusKey(rawName);
  if (!statusKey) return { accepted: false, reason: 'missing_status_key', statusKey: null };
  if (NON_UKRAINIAN_KEYS.has(statusKey)) return { accepted: false, reason: 'non_ukrainian_territory', statusKey };

  const allowed = STATUS_ALLOWLIST[statusKey];
  if (allowed) return { accepted: true, status: allowed, statusKey, sinceLabel: null };

  const dismissedAt = DISMISSED_AT_PATTERN.exec(statusKey);
  if (dismissedAt) {
    const since = (dismissedAt[1] ?? '').trim().replace(/\s+/g, ' ');
    return { accepted: true, status: 'liberated', statusKey: DISMISSED_AT_KEY, sinceLabel: since || null };
  }

  return { accepted: false, reason: 'unknown_status_key', statusKey };
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers. All geometry stays in plain jsonb; clipping happens here in Node, no PostGIS.
// ---------------------------------------------------------------------------------------------

type Bbox = [number, number, number, number];

function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

function sanitizeRing(input: unknown): Ring | null {
  if (!Array.isArray(input) || input.length < 4) return null;
  const ring: Ring = [];
  for (const point of input) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const longitude = point[0];
    const latitude = point[1];
    if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
    const pair: Pair = [roundCoordinate(longitude), roundCoordinate(latitude)];
    const previous = ring[ring.length - 1];
    if (previous && previous[0] === pair[0] && previous[1] === pair[1]) continue;
    ring.push(pair);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return null;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring.length >= 4 ? ring : null;
}

function sanitizePolygon(input: unknown): Polygon | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const rings: Ring[] = [];
  for (const rawRing of input) {
    const ring = sanitizeRing(rawRing);
    // A broken exterior ring invalidates the polygon; a broken hole is simply dropped.
    if (!ring) {
      if (rings.length === 0) return null;
      continue;
    }
    rings.push(ring);
  }
  return rings.length ? rings : null;
}

function sanitizeMultiPolygon(input: unknown): MultiPolygon | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const polygons: Polygon[] = [];
  for (const rawPolygon of input) {
    const polygon = sanitizePolygon(rawPolygon);
    if (polygon) polygons.push(polygon);
  }
  return polygons.length ? polygons : null;
}

/** Accepts a GeoJSON geometry object and returns it as a MultiPolygon, or null for anything else. */
export function toMultiPolygon(geometry: unknown): MultiPolygon | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (type === 'Polygon') {
    const polygon = sanitizePolygon(coordinates);
    return polygon ? [polygon] : null;
  }
  if (type === 'MultiPolygon') return sanitizeMultiPolygon(coordinates);
  return null;
}

function bboxOf(geometry: MultiPolygon): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of geometry) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

function bboxesOverlap(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

let cachedBoundary: { geometry: MultiPolygon; bbox: Bbox } | null = null;

/** Internationally recognised border of Ukraine, Crimea included. Loaded once, cached in process. */
export function loadUkraineBoundary(): { geometry: MultiPolygon; bbox: Bbox } {
  if (cachedBoundary) return cachedBoundary;
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), UKRAINE_BOUNDARY_PATH), 'utf8')) as {
    type?: string;
    features?: Array<{ geometry?: unknown }>;
    geometry?: unknown;
  };
  const candidates = Array.isArray(raw.features) ? raw.features.map((feature) => feature?.geometry) : [raw.geometry ?? raw];
  const geometry: MultiPolygon = [];
  for (const candidate of candidates) {
    const parts = toMultiPolygon(candidate);
    if (parts) geometry.push(...parts);
  }
  if (!geometry.length) throw new Error(`${UKRAINE_BOUNDARY_PATH} contains no usable polygon geometry`);
  cachedBoundary = { geometry, bbox: bboxOf(geometry) };
  return cachedBoundary;
}

type ClipOutcome =
  | { ok: true; geometry: MultiPolygon }
  | { ok: false; reason: 'outside_ukraine_border' | 'clip_failed'; error?: unknown };

function clipToUkraine(geometry: MultiPolygon, boundary: { geometry: MultiPolygon; bbox: Bbox }): ClipOutcome {
  if (!bboxesOverlap(bboxOf(geometry), boundary.bbox)) return { ok: false, reason: 'outside_ukraine_border' };
  let clipped: MultiPolygon;
  try {
    clipped = polygonClipping.intersection(geometry, boundary.geometry);
  } catch (error) {
    return { ok: false, reason: 'clip_failed', error };
  }
  const sanitized = sanitizeMultiPolygon(clipped);
  if (!sanitized) return { ok: false, reason: 'outside_ukraine_border' };
  return { ok: true, geometry: sanitized };
}

// ---------------------------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------------------------

export interface OccupationFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Polygon } | { type: 'MultiPolygon'; coordinates: MultiPolygon };
  properties: {
    status: OccupationStatus;
    statusKey: string;
    labelUk: string;
    sinceLabel: string | null;
  };
}

export interface OccupationFeatureCollection {
  type: 'FeatureCollection';
  features: OccupationFeature[];
}

export interface OccupationCounts {
  occupied: number;
  contested: number;
  liberated: number;
  rejected: number;
}

export interface NormalizedOccupation {
  revisionId: string;
  capturedLabel: string;
  geojson: OccupationFeatureCollection;
  counts: OccupationCounts;
  /** Point/line features (upstream labels and icons) that never represent territory. */
  droppedGeometryCount: number;
  rejectionBreakdown: Partial<Record<RejectionReason, number>>;
  unknownStatusKeys: string[];
  checksum: string;
}

export interface NormalizeOptions {
  /** Pass null to skip geometric clipping. Only tests should ever do that. */
  boundary?: { geometry: MultiPolygon; bbox: Bbox } | null;
  log?: OccupationLogger;
}

const feedSchema = z.object({
  id: z.union([z.number(), z.string()]),
  datetime: z.string().optional(),
  map: z.object({ features: z.array(z.unknown()) })
});

export function normalizeOccupationFeed(payload: unknown, options: NormalizeOptions = {}): NormalizedOccupation {
  const parsed = feedSchema.safeParse(payload);
  if (!parsed.success) throw new Error('DeepState payload does not match the expected shape');

  const boundary = options.boundary === undefined ? loadUkraineBoundary() : options.boundary;
  const log = options.log;
  const features: OccupationFeature[] = [];
  const counts: OccupationCounts = { occupied: 0, contested: 0, liberated: 0, rejected: 0 };
  const rejectionBreakdown: Partial<Record<RejectionReason, number>> = {};
  const unknownStatusKeys = new Set<string>();
  let droppedGeometryCount = 0;

  const reject = (reason: RejectionReason) => {
    rejectionBreakdown[reason] = (rejectionBreakdown[reason] ?? 0) + 1;
    occupationRejectedTotal.inc({ reason });
    if (reason === 'non_polygon_geometry') droppedGeometryCount += 1;
    else counts.rejected += 1;
  };

  for (const raw of parsed.data.map.features) {
    const feature = (raw ?? {}) as { geometry?: unknown; properties?: { name?: unknown } };
    const geometry = toMultiPolygon(feature.geometry);
    if (!geometry) {
      // Upstream ships ~400 Point features: those are labels and icons, not territory.
      reject('non_polygon_geometry');
      continue;
    }

    const decision = classifyStatusKey(feature.properties?.name);
    if (!decision.accepted) {
      if (decision.reason === 'unknown_status_key' && decision.statusKey) {
        unknownStatusKeys.add(decision.statusKey);
        occupationUnknownStatusKeysTotal.inc();
        log?.warn(
          { statusKey: decision.statusKey, source: OCCUPATION_SOURCE },
          'unknown DeepState status key rejected: territory will not be rendered until it is reviewed'
        );
      } else if (decision.reason === 'non_ukrainian_territory') {
        log?.info({ statusKey: decision.statusKey }, 'dropped upstream polygon outside Ukraine');
      }
      reject(decision.reason);
      continue;
    }

    const outcome = boundary ? clipToUkraine(geometry, boundary) : { ok: true as const, geometry };
    if (!outcome.ok) {
      log?.warn(
        { statusKey: decision.statusKey, reason: outcome.reason },
        'occupation polygon dropped by border clipping'
      );
      reject(outcome.reason);
      continue;
    }

    const parts = outcome.geometry;
    const head = parts[0];
    if (!head) {
      reject('invalid_geometry');
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: parts.length === 1 ? { type: 'Polygon', coordinates: head } : { type: 'MultiPolygon', coordinates: parts },
      properties: {
        status: decision.status,
        statusKey: decision.statusKey,
        labelUk: STATUS_LABELS_UK[decision.status],
        sinceLabel: decision.sinceLabel
      }
    });
    counts[decision.status] += 1;
    occupationFeaturesTotal.inc({ status: decision.status });
  }

  const geojson: OccupationFeatureCollection = { type: 'FeatureCollection', features };
  return {
    revisionId: String(parsed.data.id),
    capturedLabel: parsed.data.datetime ?? '',
    geojson,
    counts,
    droppedGeometryCount,
    rejectionBreakdown,
    unknownStatusKeys: [...unknownStatusKeys],
    checksum: createHash('sha256').update(JSON.stringify(geojson)).digest('hex')
  };
}

// ---------------------------------------------------------------------------------------------
// Upstream fetch + persistence
// ---------------------------------------------------------------------------------------------

export async function fetchDeepStateFeed(): Promise<unknown> {
  const response = await fetch(config.DEEPSTATE_API_URL, {
    headers: { accept: 'application/json', 'user-agent': `ThreatLensUA/1.0 (+${config.PUBLIC_URL})` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DeepState endpoint responded ${response.status}`);
  return await response.json();
}

const revisionIdSchema = z.union([z.number(), z.string()]);

export type SyncResult =
  | { status: 'disabled' }
  | { status: 'unchanged'; revisionId: string }
  | { status: 'stored'; revisionId: string; counts: OccupationCounts; unknownStatusKeys: string[] };

export async function syncOccupationLayer(log?: OccupationLogger): Promise<SyncResult> {
  if (!config.OCCUPATION_SOURCE_ENABLED) return { status: 'disabled' };

  const payload = await fetchDeepStateFeed();
  const revisionCandidate = revisionIdSchema.safeParse((payload as { id?: unknown })?.id);
  if (!revisionCandidate.success) throw new Error('DeepState payload has no usable revision id');
  const revisionId = String(revisionCandidate.data);

  // Re-clipping 120 polygons costs about a second; skip it when the revision is already stored.
  const seen = await pool.query(
    `UPDATE occupation_snapshots SET last_seen_at=now()
     WHERE source=$1 AND source_revision_id=$2 RETURNING id`,
    [OCCUPATION_SOURCE, revisionId]
  );
  if (seen.rowCount) {
    occupationLastSuccessTimestamp.set(Date.now() / 1000);
    occupationSyncTotal.inc({ result: 'unchanged' });
    resetOccupationPayloadCache();
    return { status: 'unchanged', revisionId };
  }

  const normalized = normalizeOccupationFeed(payload, { log });
  await pool.query(
    `INSERT INTO occupation_snapshots
       (source,source_revision_id,captured_label,geojson,occupied_count,contested_count,liberated_count,
        rejected_count,dropped_geometry_count,rejection_breakdown,unknown_status_keys,checksum)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (source,source_revision_id) DO UPDATE SET last_seen_at=now()`,
    [
      OCCUPATION_SOURCE, revisionId, normalized.capturedLabel, JSON.stringify(normalized.geojson),
      normalized.counts.occupied, normalized.counts.contested, normalized.counts.liberated,
      normalized.counts.rejected, normalized.droppedGeometryCount,
      JSON.stringify(normalized.rejectionBreakdown), JSON.stringify(normalized.unknownStatusKeys),
      normalized.checksum
    ]
  );
  occupationLastSuccessTimestamp.set(Date.now() / 1000);
  occupationSyncTotal.inc({ result: 'stored' });
  resetOccupationPayloadCache();
  return { status: 'stored', revisionId, counts: normalized.counts, unknownStatusKeys: normalized.unknownStatusKeys };
}

export interface OccupationSnapshotRow {
  source_revision_id: string;
  captured_label: string;
  fetched_at: Date;
  last_seen_at: Date;
  geojson: OccupationFeatureCollection;
  occupied_count: number;
  contested_count: number;
  liberated_count: number;
  rejected_count: number;
  checksum: string;
}

export async function latestOccupationSnapshot(): Promise<OccupationSnapshotRow | null> {
  const result = await pool.query<OccupationSnapshotRow>(
    `SELECT source_revision_id,captured_label,fetched_at,last_seen_at,geojson,
            occupied_count,contested_count,liberated_count,rejected_count,checksum
     FROM occupation_snapshots WHERE source=$1 ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    [OCCUPATION_SOURCE]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// HTTP payload. Serialized once per revision so that a few hundred kilobytes are not re-encoded
// on every request, and so the ETag can be derived from the exact bytes we hand out.
// ---------------------------------------------------------------------------------------------

export interface OccupationPayloadView {
  json: string;
  etag: string;
  lastModified: string;
  revisionId: string | null;
  stale: boolean;
}

const EMPTY_PAYLOAD = {
  source: OCCUPATION_SOURCE,
  revisionId: null,
  capturedLabel: null,
  fetchedAt: null,
  stale: true,
  attribution: OCCUPATION_ATTRIBUTION,
  counts: { occupied: 0, contested: 0, liberated: 0, rejected: 0 },
  geojson: { type: 'FeatureCollection', features: [] as OccupationFeature[] }
};

let payloadCache: { at: number; view: OccupationPayloadView } | null = null;

export function resetOccupationPayloadCache(): void {
  payloadCache = null;
}

/**
 * The degraded-but-working shape: an empty collection flagged stale. Used when the source is
 * switched off, when no revision has been stored yet, and when the database is unreachable — the
 * map has to keep rendering without this layer rather than fail.
 */
export function emptyOccupationPayloadView(now = Date.now()): OccupationPayloadView {
  return {
    json: JSON.stringify(EMPTY_PAYLOAD),
    etag: '"occupation-empty"',
    lastModified: new Date(now).toUTCString(),
    revisionId: null,
    stale: true
  };
}

export async function buildOccupationPayloadView(now = Date.now()): Promise<OccupationPayloadView> {
  // The kill switch has to actually kill the source: when it is off we serve nothing from DeepState,
  // and the map degrades to an empty but working layer instead of failing.
  if (!config.OCCUPATION_SOURCE_ENABLED) return emptyOccupationPayloadView(now);

  const snapshot = await latestOccupationSnapshot();
  if (!snapshot) return emptyOccupationPayloadView(now);

  const lastSeenAt = new Date(snapshot.last_seen_at ?? snapshot.fetched_at);
  const fetchedAt = new Date(snapshot.fetched_at);
  const stale = now - lastSeenAt.getTime() > config.OCCUPATION_STALE_AFTER_SECONDS * 1000;
  const body = {
    source: OCCUPATION_SOURCE,
    revisionId: snapshot.source_revision_id,
    capturedLabel: snapshot.captured_label,
    fetchedAt: fetchedAt.toISOString(),
    stale,
    attribution: OCCUPATION_ATTRIBUTION,
    counts: {
      occupied: Number(snapshot.occupied_count),
      contested: Number(snapshot.contested_count),
      liberated: Number(snapshot.liberated_count),
      rejected: Number(snapshot.rejected_count)
    },
    geojson: snapshot.geojson
  };
  return {
    json: JSON.stringify(body),
    // The staleness flag lives inside the body, so it has to participate in the validator or a
    // cached client would never learn that the layer went stale.
    etag: `"${snapshot.source_revision_id}-${snapshot.checksum.slice(0, 16)}-${stale ? 's' : 'f'}"`,
    lastModified: fetchedAt.toUTCString(),
    revisionId: snapshot.source_revision_id,
    stale
  };
}

export async function occupationPayloadView(now = Date.now()): Promise<OccupationPayloadView> {
  if (payloadCache && now - payloadCache.at < PAYLOAD_CACHE_TTL_MS) return payloadCache.view;
  const view = await buildOccupationPayloadView(now);
  payloadCache = { at: now, view };
  return view;
}

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------

export function startOccupationScheduler(log: OccupationLogger): () => void {
  if (!config.OCCUPATION_SOURCE_ENABLED) {
    log.warn('occupation layer disabled: OCCUPATION_SOURCE_ENABLED is false');
    return () => undefined;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await syncOccupationLayer(log);
      log.info({ ...result, source: OCCUPATION_SOURCE }, 'occupation layer sync finished');
    } catch (error) {
      // A third-party editorial feed must never be able to take the process down.
      occupationSyncTotal.inc({ result: 'failed' });
      log.error({ error: String(error) }, 'occupation layer sync failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, config.OCCUPATION_SYNC_INTERVAL_SECONDS * 1_000);
  timer.unref();
  setTimeout(run, 8_000).unref();
  return () => clearInterval(timer);
}
