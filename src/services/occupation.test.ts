import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import occupationRoutes from '../api/occupation-routes.js';
import {
  DISMISSED_AT_KEY,
  NON_UKRAINIAN_STATUS_KEYS,
  classifyStatusKey,
  extractStatusKey,
  loadUkraineBoundary,
  normalizeOccupationFeed,
  resetOccupationPayloadCache,
  toMultiPolygon,
  type OccupationStatus
} from './occupation.js';

// The route talks to PostgreSQL; the tests must not. No live database, no network.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../db/pool.js', () => ({ pool: { query: queryMock } }));

// ------------------------------------------------------------------------------------------
// Fixture. Shaped exactly like GET https://deepstatemap.live/api/history/last, but tiny, so the
// tests never touch the network. Polygons that are meant to survive sit inside Ukraine; the
// out-of-country ones sit at their real locations so allowlist and clipping can be told apart.
// ------------------------------------------------------------------------------------------

function square(centerLon: number, centerLat: number, size = 0.2): number[][][] {
  const half = size / 2;
  return [[
    [centerLon - half, centerLat - half],
    [centerLon + half, centerLat - half],
    [centerLon + half, centerLat + half],
    [centerLon - half, centerLat + half],
    [centerLon - half, centerLat - half]
  ]];
}

/** Somewhere safely inland in Ukraine (Poltava region), so clipping keeps it whole. */
const INSIDE_UKRAINE: [number, number] = [34.5, 49.6];

function polygonFeature(name: string, center: [number, number] = INSIDE_UKRAINE) {
  return {
    type: 'Feature',
    properties: {
      name,
      // Upstream KML styling. It must never influence our output: colours are ours, not theirs.
      stroke: '#bcaaa4', fill: '#bcaaa4', 'fill-opacity': 0.3, styleUrl: '#poly-BCAAA4'
    },
    geometry: { type: 'Polygon', coordinates: square(center[0], center[1]) }
  };
}

function pointFeature(name: string) {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [INSIDE_UKRAINE[0], INSIDE_UKRAINE[1]] }
  };
}

function feed(features: unknown[]) {
  return { id: 1785934070, datetime: '05.08 o 14:47', map: { type: 'FeatureCollection', features } };
}

/** Real-world centres of the eleven polygons that lie entirely outside Ukraine. */
const OUTSIDE_UKRAINE: Record<string, [number, number]> = {
  'geoJSON.territories.prussia': [20.5, 54.7],
  'geoJSON.territories.abkhazia': [41.0, 43.0],
  'geoJSON.territories.karelia': [31.0, 62.0],
  'geoJSON.territories.ichkeria': [45.7, 43.3],
  'geoJSON.territories.petsamo': [31.0, 69.5],
  'geoJSON.territories.salla': [29.0, 66.8],
  'geoJSON.territories.estonia': [27.5, 58.5],
  'geoJSON.territories.pechorsky-district': [27.6, 57.8],
  'geoJSON.territories.latvia': [27.8, 56.4],
  'geoJSON.territories.kuril': [146.5, 44.5],
  'geoJSON.territories.tskhinvali-district': [43.9, 42.3]
};

function statusesOf(result: ReturnType<typeof normalizeOccupationFeed>): OccupationStatus[] {
  return result.geojson.features.map((feature) => feature.properties.status);
}

// ------------------------------------------------------------------------------------------

describe('DeepState status key extraction', () => {
  it('takes the trailing machine key out of the trilingual name', () => {
    expect(extractStatusKey('Тимчасово окуповано /// Occupied /// geoJSON.status.occupied'))
      .toBe('geoJSON.status.occupied');
  });

  it('returns null when the name carries no machine key at all', () => {
    expect(extractStatusKey('Просто підпис')).toBeNull();
    expect(extractStatusKey(undefined)).toBeNull();
    expect(extractStatusKey(42)).toBeNull();
  });
});

describe('fail-safe allowlist', () => {
  it('maps Crimea, ORDLO and Tuzla to occupied territory of Ukraine', () => {
    for (const key of ['geoJSON.status.occupied', 'geoJSON.territories.crimea',
      'geoJSON.territories.ordlo', 'geoJSON.territories.tuzla']) {
      const decision = classifyStatusKey(`Крим /// Crimea /// ${key}`);
      expect(decision, key).toMatchObject({ accepted: true, status: 'occupied' });
    }
  });

  it('maps the unknown-status key to contested and dismissed keys to liberated', () => {
    expect(classifyStatusKey('/// /// geoJSON.status.unknown')).toMatchObject({ accepted: true, status: 'contested' });
    expect(classifyStatusKey('/// /// geoJSON.status.dismissed')).toMatchObject({ accepted: true, status: 'liberated' });
    expect(classifyStatusKey('/// /// geoJSON.zmiinyi_island')).toMatchObject({ accepted: true, status: 'liberated' });
  });

  it('parses every observed variation of the dismissed_at suffix and keeps the date as a string', () => {
    const cases: Array<[string, string | null]> = [
      ['geoJSON.status.dismissed_at {{at:25.03}}', '25.03'],
      ['geoJSON.status.dismissed_at {{at:16.03 -17.03}}', '16.03 -17.03'],
      ['geoJSON.status.dismissed_at {{at:27.03 - 31.03}}', '27.03 - 31.03'],
      ['geoJSON.status.dismissed_at {{at:31.03 - 02.04}}', '31.03 - 02.04'],
      ['geoJSON.status.dismissed_at {{at: 04.09 }}', '04.09'],
      ['geoJSON.status.dismissed_at', null]
    ];
    for (const [key, expected] of cases) {
      const decision = classifyStatusKey(`Звільнено /// Liberated /// ${key}`);
      expect(decision, key).toEqual({
        accepted: true, status: 'liberated', statusKey: DISMISSED_AT_KEY, sinceLabel: expected
      });
    }
  });

  it('rejects every key that describes territory outside Ukraine', () => {
    // Eleven upstream territories plus Transnistria, which is Moldova.
    expect(NON_UKRAINIAN_STATUS_KEYS).toHaveLength(12);
    for (const key of NON_UKRAINIAN_STATUS_KEYS) {
      expect(classifyStatusKey(`x /// y /// ${key}`), key)
        .toEqual({ accepted: false, reason: 'non_ukrainian_territory', statusKey: key });
    }
  });

  it('rejects a status key it has never seen instead of guessing', () => {
    expect(classifyStatusKey('x /// y /// geoJSON.territories.brand-new-2027'))
      .toEqual({ accepted: false, reason: 'unknown_status_key', statusKey: 'geoJSON.territories.brand-new-2027' });
    expect(classifyStatusKey('x /// y /// geoJSON.status.occupied_soon'))
      .toEqual({ accepted: false, reason: 'unknown_status_key', statusKey: 'geoJSON.status.occupied_soon' });
  });
});

describe('normalizeOccupationFeed', () => {
  it('keeps Crimea and ORDLO as occupied and rejects the out-of-Ukraine polygons', () => {
    const features = [
      polygonFeature('Крим /// Crimea /// geoJSON.territories.crimea'),
      polygonFeature('ОРДЛО /// ORDLO /// geoJSON.territories.ordlo'),
      ...Object.entries(OUTSIDE_UKRAINE).map(([key, center]) => polygonFeature(`x /// y /// ${key}`, center)),
      polygonFeature('Придністров\'я /// Transnistria /// geoJSON.territories.transnistria', [29.6, 46.8])
    ];
    const result = normalizeOccupationFeed(feed(features));

    expect(statusesOf(result)).toEqual(['occupied', 'occupied']);
    expect(result.counts).toEqual({ occupied: 2, contested: 0, liberated: 0, rejected: 12 });
    expect(result.rejectionBreakdown).toEqual({ non_ukrainian_territory: 12 });
    // Nothing outside Ukraine may appear under any status, ever.
    expect(result.geojson.features.every((feature) => feature.properties.statusKey.startsWith('geoJSON.territories.crimea')
      || feature.properties.statusKey.startsWith('geoJSON.territories.ordlo'))).toBe(true);
  });

  it('drops an unknown status key, records it and never renders it', () => {
    const result = normalizeOccupationFeed(feed([
      polygonFeature('x /// y /// geoJSON.status.occupied'),
      polygonFeature('нове /// new /// geoJSON.status.partially_liberated')
    ]));

    expect(result.counts).toEqual({ occupied: 1, contested: 0, liberated: 0, rejected: 1 });
    expect(result.unknownStatusKeys).toEqual(['geoJSON.status.partially_liberated']);
    expect(result.rejectionBreakdown).toEqual({ unknown_status_key: 1 });
    expect(result.geojson.features).toHaveLength(1);
  });

  it('warns on an unknown status key rather than failing silently', () => {
    const warnings: unknown[] = [];
    const log = { info: () => undefined, warn: (...args: unknown[]) => warnings.push(args), error: () => undefined };
    normalizeOccupationFeed(feed([polygonFeature('x /// y /// geoJSON.status.mystery')]), { log });
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('geoJSON.status.mystery');
  });

  it('drops Point features: upstream uses them for labels and icons, not territory', () => {
    const result = normalizeOccupationFeed(feed([
      pointFeature('Підпис /// Label /// geoJSON.status.occupied'),
      pointFeature('Підпис /// Label /// geoJSON.status.dismissed'),
      polygonFeature('x /// y /// geoJSON.status.occupied')
    ]));

    expect(result.geojson.features).toHaveLength(1);
    expect(result.droppedGeometryCount).toBe(2);
    // Point drops are counted separately so they do not drown the meaningful rejection count.
    expect(result.counts.rejected).toBe(0);
    expect(result.rejectionBreakdown).toEqual({ non_polygon_geometry: 2 });
  });

  it('clips a polygon that straddles the border and drops one that lies fully outside', () => {
    const boundary = loadUkraineBoundary();
    // A wide box centred on the Ukrainian-Polish border: only the Ukrainian half may survive.
    const straddling = {
      type: 'Feature',
      properties: { name: 'x /// y /// geoJSON.status.occupied' },
      geometry: { type: 'Polygon', coordinates: square(23.5, 50.3, 3) }
    };
    // A box in central Poland, allowlisted by key, so only geometry can save or kill it.
    const abroad = {
      type: 'Feature',
      properties: { name: 'x /// y /// geoJSON.status.occupied' },
      geometry: { type: 'Polygon', coordinates: square(19.5, 52.0, 1) }
    };
    const result = normalizeOccupationFeed(feed([straddling, abroad]), { boundary });

    expect(result.counts).toEqual({ occupied: 1, contested: 0, liberated: 0, rejected: 1 });
    expect(result.rejectionBreakdown.outside_ukraine_border).toBe(1);
    const survivor = result.geojson.features[0]!;
    const rings = survivor.geometry.type === 'Polygon' ? survivor.geometry.coordinates : survivor.geometry.coordinates.flat();
    const points = rings.flat();
    // The box entered as a five-point square spanning 22.0..25.0; after clipping it must follow the
    // border, so it has many more vertices and no longer reaches its own western edge.
    expect(points.length).toBeGreaterThan(20);
    expect(Math.min(...points.map((point) => point[0]))).toBeGreaterThan(22);
  });

  it('produces the published feature shape with Ukrainian labels and no upstream styling', () => {
    const result = normalizeOccupationFeed(feed([
      polygonFeature('x /// y /// geoJSON.status.occupied'),
      polygonFeature('x /// y /// geoJSON.status.unknown'),
      polygonFeature('x /// y /// geoJSON.status.dismissed_at {{at:02.07}}')
    ]));

    expect(result.geojson.features.map((feature) => feature.properties)).toEqual([
      { status: 'occupied', statusKey: 'geoJSON.status.occupied', labelUk: 'Тимчасово окупована територія України', sinceLabel: null },
      { status: 'contested', statusKey: 'geoJSON.status.unknown', labelUk: 'Територія, статус якої не підтверджено', sinceLabel: null },
      { status: 'liberated', statusKey: DISMISSED_AT_KEY, labelUk: 'Звільнена територія', sinceLabel: '02.07' }
    ]);
    const serialized = JSON.stringify(result.geojson);
    for (const leaked of ['fill', 'stroke', 'styleUrl', 'fill-opacity']) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });

  it('keeps the upstream revision id and the raw non-ISO datetime string untouched', () => {
    const result = normalizeOccupationFeed(feed([polygonFeature('x /// y /// geoJSON.status.occupied')]));
    expect(result.revisionId).toBe('1785934070');
    expect(result.capturedLabel).toBe('05.08 o 14:47');
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: the same feed yields the same checksum', () => {
    const input = feed([polygonFeature('x /// y /// geoJSON.status.occupied')]);
    expect(normalizeOccupationFeed(input).checksum).toBe(normalizeOccupationFeed(input).checksum);
  });

  it('rejects a payload that does not look like the DeepState feed', () => {
    expect(() => normalizeOccupationFeed({ nope: true })).toThrow(/expected shape/);
    expect(() => normalizeOccupationFeed(null)).toThrow(/expected shape/);
  });

  it('refuses malformed geometry instead of emitting it', () => {
    expect(toMultiPolygon({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toBeNull();
    expect(toMultiPolygon({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], ['x', 1], [0, 0], [0, 0]]] })).toBeNull();
    expect(toMultiPolygon({ type: 'Polygon', coordinates: [[[999, 0], [1, 0], [1, 1], [0, 1], [999, 0]]] })).toBeNull();
    expect(toMultiPolygon({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBeNull();
    expect(toMultiPolygon(undefined)).toBeNull();
  });

  it('closes an unclosed ring rather than shipping invalid GeoJSON', () => {
    const geometry = toMultiPolygon({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
    const ring = geometry![0]![0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});

describe('GET /api/v1/occupation', () => {
  // Mirrors the server-wide onSend hook, which forces no-store on every JSON response. The layer is
  // hundreds of kilobytes and changes about once a day, so it has to escape that.
  async function buildApp() {
    const app = Fastify();
    app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.getHeader('content-type')?.toString().includes('application/json')) {
        reply.header('Cache-Control', 'no-store');
      }
      return payload;
    });
    await app.register(occupationRoutes, {});
    return app;
  }

  const snapshotRow = {
    source_revision_id: '1785934070',
    captured_label: '05.08 o 14:47',
    fetched_at: new Date('2026-08-07T10:00:00.000Z'),
    last_seen_at: new Date(),
    geojson: { type: 'FeatureCollection', features: [] },
    occupied_count: 28,
    contested_count: 31,
    liberated_count: 51,
    rejected_count: 12,
    checksum: 'a'.repeat(64)
  };

  beforeEach(() => {
    resetOccupationPayloadCache();
    queryMock.mockReset();
  });

  it('serves an empty but working layer when nothing has been stored yet', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/occupation' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'deepstate',
      revisionId: null,
      stale: true,
      attribution: { name: 'DeepStateMap', url: 'https://deepstatemap.live' },
      counts: { occupied: 0, contested: 0, liberated: 0, rejected: 0 },
      geojson: { type: 'FeatureCollection', features: [] }
    });
    await app.close();
  });

  it('stays up when the database is unreachable instead of failing the map', async () => {
    queryMock.mockRejectedValue(new Error('connection refused'));
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/occupation' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revisionId: null, stale: true });
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('returns the contract payload and beats the server-wide no-store hook', async () => {
    queryMock.mockResolvedValue({ rows: [snapshotRow], rowCount: 1 });
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/occupation' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      source: 'deepstate',
      revisionId: '1785934070',
      capturedLabel: '05.08 o 14:47',
      fetchedAt: '2026-08-07T10:00:00.000Z',
      stale: false,
      attribution: { name: 'DeepStateMap', url: 'https://deepstatemap.live' },
      counts: { occupied: 28, contested: 31, liberated: 51, rejected: 12 },
      geojson: { type: 'FeatureCollection', features: [] }
    });
    expect(response.headers['cache-control']).toContain('max-age');
    expect(response.headers['cache-control']).not.toContain('no-store');
    expect(response.headers.etag).toContain('1785934070');
    expect(response.headers['last-modified']).toBeTruthy();
    await app.close();
  });

  it('answers 304 when the client already holds the current revision', async () => {
    queryMock.mockResolvedValue({ rows: [snapshotRow], rowCount: 1 });
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/api/v1/occupation' });
    const etag = first.headers.etag as string;

    const revalidated = await app.inject({
      method: 'GET', url: '/api/v1/occupation', headers: { 'if-none-match': etag }
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe('');

    const changed = await app.inject({
      method: 'GET', url: '/api/v1/occupation', headers: { 'if-none-match': '"1785934069-deadbeef-f"' }
    });
    expect(changed.statusCode).toBe(200);
    await app.close();
  });

  it('flags a snapshot older than the staleness window and changes the validator with it', async () => {
    const fresh = { ...snapshotRow, last_seen_at: new Date() };
    const stale = { ...snapshotRow, last_seen_at: new Date(Date.now() - 7 * 3_600_000) };
    queryMock.mockResolvedValue({ rows: [fresh], rowCount: 1 });
    const app = await buildApp();
    const before = await app.inject({ method: 'GET', url: '/api/v1/occupation' });
    expect(before.json().stale).toBe(false);

    resetOccupationPayloadCache();
    queryMock.mockResolvedValue({ rows: [stale], rowCount: 1 });
    const after = await app.inject({ method: 'GET', url: '/api/v1/occupation' });
    expect(after.json().stale).toBe(true);
    // A client caching the fresh response must not be handed a 304 that hides the staleness.
    expect(after.headers.etag).not.toBe(before.headers.etag);
    await app.close();
  });
});

describe('Ukraine boundary', () => {
  it('loads the internationally recognised border, Crimea included', () => {
    const boundary = loadUkraineBoundary();
    expect(boundary.geometry.length).toBeGreaterThan(0);
    const [minX, minY, maxX, maxY] = boundary.bbox;
    expect(minX).toBeLessThan(23);
    expect(maxX).toBeGreaterThan(40);
    // Crimea reaches down to roughly 44.4°N; a border without it would stop near 45.2°N.
    expect(minY).toBeLessThan(44.6);
    expect(maxY).toBeGreaterThan(52);
  });
});
