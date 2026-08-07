import { describe, expect, it } from 'vitest';
import { buildReportedVector, raionCentroids, type VectorChainRow } from './threat-vectors.js';

/**
 * The public chain, pinned without a database.
 *
 * Every rule that decides what a chain *claims* lives in `buildReportedVector`, so this file is the
 * executable form of the promise in the module docblock: a segment is only ever as strong as the
 * message behind it, and nothing is drawn that nobody reported.
 */

const EVENT = '11111111-1111-4111-8111-111111111111';
const BROVARY_RAION = 'katottg-ua32060000000012455';
const BORYSPIL_RAION = 'katottg-ua32040000000054694';

interface RowOptions {
  classification: string;
  at: string;
  location: string;
  name: string;
  role?: 'asserted' | 'retracted';
  relation?: string | null;
  type?: string;
  latitude?: number | null;
  longitude?: number | null;
  source?: string;
  sourceName?: string;
  tier?: string;
  official?: boolean;
  group?: string;
  decision?: string;
  intent?: string;
  text?: string;
  directionText?: string | null;
}

function row(options: RowOptions): VectorChainRow {
  return {
    classification_id: options.classification,
    event_id: EVENT,
    published_at: options.at,
    decision: options.decision ?? 'event_merged',
    intent: options.intent ?? 'threat',
    direction_text: options.directionText ?? null,
    source_message_id: `msg-${options.classification}`,
    source_id: options.source ?? 'osint-war-monitor',
    source_name: options.sourceName ?? 'War Monitor',
    tier: options.tier ?? 'B',
    official: options.official ?? false,
    independence_group: options.group ?? options.source ?? 'osint-war-monitor',
    raw_text: options.text ?? 'Тестове повідомлення',
    location_id: options.location,
    role: options.role ?? 'asserted',
    relation_type: options.relation === undefined ? 'mentioned' : options.relation,
    name_uk: options.name,
    location_type: options.type ?? 'city',
    latitude: options.latitude === undefined ? 50 : options.latitude,
    longitude: options.longitude === undefined ? 30 : options.longitude
  };
}

describe('reported vector chain', () => {
  it('turns one redirect message into a transit segment stated by a single source', () => {
    const rows = [
      row({
        classification: 'c1', at: '2026-08-07T20:00:00.000Z', decision: 'redirect', intent: 'redirect',
        location: 'ua-city-brovary', name: 'Бровари', role: 'retracted', relation: null,
        latitude: 50.5111, longitude: 30.7903,
        text: 'Балістика повз Бровари на Бориспіль'
      }),
      row({
        classification: 'c1', at: '2026-08-07T20:00:00.000Z', decision: 'redirect', intent: 'redirect',
        location: 'ua-city-boryspil', name: 'Бориспіль', relation: 'reported_direction',
        latitude: 50.3527, longitude: 30.9550,
        text: 'Балістика повз Бровари на Бориспіль'
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.nodes.map((node) => node.locationId)).toEqual(['ua-city-brovary', 'ua-city-boryspil']);
    expect(vector.segments).toHaveLength(1);
    const [segment] = vector.segments;
    expect(segment!.basis).toBe('reported_transit');
    // One message stated both ends, so no time passed *between the statements*.
    expect(segment!.elapsedSeconds).toBe(0);
    expect(segment!.originSource).toBeNull();
    expect(segment!.independentEnds).toBe(false);
    expect(segment!.drawable).toBe(true);
    expect(segment!.statement).toContain('повз Бровари на Бориспіль');
    expect(vector.span.strongestBasis).toBe('reported_transit');
  });

  it('leads a target through three sources in eight minutes without claiming anybody saw it move', () => {
    const rows = [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-chernihiv',
        name: 'Чернігів', latitude: 51.4982, longitude: 31.2893,
        source: 'osint-war-monitor', group: 'osint-war-monitor', sourceName: 'War Monitor'
      }),
      row({
        classification: 'b', at: '2026-08-07T20:04:00.000Z', location: 'ua-city-brovary',
        name: 'Бровари', latitude: 50.5111, longitude: 30.7903,
        source: 'osint-eradar', group: 'osint-eradar', sourceName: 'єРадар'
      }),
      row({
        classification: 'c', at: '2026-08-07T20:08:00.000Z', location: 'ua-city-boryspil',
        name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550,
        source: 'osint-aeris-rimor', group: 'osint-aeris-rimor', sourceName: 'Aeris Rimor'
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.nodes).toHaveLength(3);
    expect(vector.segments).toHaveLength(2);
    // Every leg is the weakest rung: three separate messages, an ordering this system imposed.
    expect(vector.segments.every((segment) => segment.basis === 'observation_sequence')).toBe(true);
    expect(vector.segments.every((segment) => segment.independentEnds)).toBe(true);
    // Two independent Tier B groups on one leg is `confirmed` everywhere else in this system too.
    expect(vector.segments.every((segment) => segment.evidenceLevel === 'confirmed')).toBe(true);
    expect(vector.segments.map((segment) => segment.elapsedSeconds)).toEqual([240, 240]);
    expect(vector.span).toMatchObject({
      elapsedSeconds: 480, sourceCount: 3, independenceGroupCount: 3, drawableSegments: 2,
      strongestBasis: 'observation_sequence'
    });
  });

  it('counts a repost and its origin as one source rather than two', () => {
    const rows = [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-chernihiv',
        name: 'Чернігів', latitude: 51.4982, longitude: 31.2893,
        source: 'air-force', group: 'air-force', tier: 'A', official: true
      }),
      row({
        classification: 'b', at: '2026-08-07T20:03:00.000Z', location: 'ua-city-brovary',
        name: 'Бровари', latitude: 50.5111, longitude: 30.7903,
        source: 'osint-vanek-nikolaev', group: 'air-force', tier: 'C'
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.span.sourceCount).toBe(2);
    expect(vector.span.independenceGroupCount).toBe(1);
    expect(vector.segments[0]!.independentEnds).toBe(false);
    // A repost cannot promote its own leg: the destination is Tier C and unofficial.
    expect(vector.segments[0]!.evidenceLevel).toBe('unverified');
  });

  it('reads a direction stated alongside the place it leaves', () => {
    const rows = [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-chernihiv',
        name: 'Чернігів', relation: 'explicit_threat', latitude: 51.4982, longitude: 31.2893,
        directionText: 'у напрямку Києва'
      }),
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-80', name: 'Київ',
        type: 'special_city', relation: 'reported_direction', latitude: 50.4501, longitude: 30.5234,
        directionText: 'у напрямку Києва'
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.segments).toHaveLength(1);
    expect(vector.segments[0]!.basis).toBe('reported_direction');
    expect(vector.segments[0]!.statement).toBe('у напрямку Києва');
  });

  it('anchors on the most specific place a message named, not on the oblast that contains it', () => {
    const rows = [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-32',
        name: 'Київська область', type: 'oblast', latitude: 50.05, longitude: 30.76
      }),
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary',
        name: 'Бровари', latitude: 50.5111, longitude: 30.7903
      }),
      row({
        classification: 'b', at: '2026-08-07T20:05:00.000Z', location: 'ua-city-boryspil',
        name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.nodes.map((node) => node.locationId)).toEqual(['ua-city-brovary', 'ua-city-boryspil']);
    // The oblast is still recorded — it was named, it simply is not the point of the chain.
    expect(vector.nodes[0]!.reports[0]!.alsoNamed).toEqual(['Київська область']);
  });

  it('collapses a source restating the same place instead of drawing a segment to itself', () => {
    const rows = [
      row({ classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary', name: 'Бровари' }),
      row({ classification: 'b', at: '2026-08-07T20:02:00.000Z', location: 'ua-city-brovary', name: 'Бровари' }),
      row({
        classification: 'c', at: '2026-08-07T20:05:00.000Z', location: 'ua-city-boryspil',
        name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.nodes).toHaveLength(2);
    expect(vector.nodes[0]!.reports).toHaveLength(2);
    expect(vector.nodes[0]!.lastReportedAt).toBe('2026-08-07T20:02:00.000Z');
    expect(vector.segments).toHaveLength(1);
    expect(vector.segments[0]!.elapsedSeconds).toBe(180);
  });

  it('falls back to the raion polygon centroid, and says that it did', () => {
    const rows = [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: BROVARY_RAION,
        name: 'Броварський район', type: 'raion', latitude: null, longitude: null
      }),
      row({
        classification: 'b', at: '2026-08-07T20:04:00.000Z', location: BORYSPIL_RAION,
        name: 'Бориспільський район', type: 'raion', latitude: null, longitude: null
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.nodes.every((node) => node.coordinateSource === 'raion_centroid')).toBe(true);
    expect(vector.nodes.every((node) => node.coordinatePrecision === 'approximate')).toBe(true);
    expect(vector.segments[0]!.drawable).toBe(true);
    // Sanity: the centroids really are inside Kyiv oblast rather than an arbitrary fallback point.
    for (const node of vector.nodes) {
      expect(node.coordinates![0]).toBeGreaterThan(30);
      expect(node.coordinates![0]).toBeLessThan(33);
      expect(node.coordinates![1]).toBeGreaterThan(49);
      expect(node.coordinates![1]).toBeLessThan(52);
    }
  });

  it('keeps a segment whose place has no coordinate at all, and marks it undrawable', () => {
    const rows = [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-hromada-nowhere',
        name: 'Якась громада', type: 'hromada', latitude: null, longitude: null
      }),
      row({
        classification: 'b', at: '2026-08-07T20:03:00.000Z', location: 'ua-city-boryspil',
        name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550
      })
    ];
    const vector = buildReportedVector(EVENT, rows)!;
    expect(vector.nodes[0]!.coordinates).toBeNull();
    expect(vector.nodes[0]!.coordinatePrecision).toBe('unavailable');
    expect(vector.segments).toHaveLength(1);
    expect(vector.segments[0]!.drawable).toBe(false);
    expect(vector.segments[0]!.missingCoordinates).toEqual(['ua-hromada-nowhere']);
    expect(vector.span.drawableSegments).toBe(0);
  });

  it('ignores rows belonging to another event and returns null when nothing is left', () => {
    const foreign = { ...row({ classification: 'x', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-lviv', name: 'Львів' }), event_id: 'other' };
    expect(buildReportedVector(EVENT, [foreign])).toBeNull();
    expect(buildReportedVector(EVENT, [])).toBeNull();
  });

  it('publishes the same disclaimer on every chain', () => {
    const vector = buildReportedVector(EVENT, [
      row({ classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary', name: 'Бровари' }),
      row({ classification: 'b', at: '2026-08-07T20:02:00.000Z', location: 'ua-city-boryspil', name: 'Бориспіль', latitude: 50.35, longitude: 30.95 })
    ])!;
    expect(vector.disclaimer).toContain('не траєкторія');
    expect(vector.kind).toBe('reported_observation_chain');
  });
});

describe('raion centroids', () => {
  it('indexes every ADM2 polygon by the catalogue id the map already uses', () => {
    const index = raionCentroids();
    expect(index.size).toBe(136);
    expect(index.get(BROVARY_RAION)).toBeDefined();
  });
});
