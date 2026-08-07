import { describe, expect, it } from 'vitest';
import { buildReportedVector, type VectorChainRow } from './threat-vectors.js';
import {
  allowedNumbers,
  angularDifference,
  bearingDegrees,
  computeProjection,
  coneHalfAngle,
  destinationPoint,
  distanceKm,
  narrativeIsFaithful,
  rankCandidates
} from './vector-projection.js';

/**
 * The operator-only extrapolation, pinned without a model and without a database.
 *
 * The contract this file exists to hold: the vector an operator acts on is arithmetic over two
 * reported points, it always states how wrong it might be, it is never described as an observation,
 * and a language model can change no number in it.
 */

const EVENT = '22222222-2222-4222-8222-222222222222';
const CHERNIHIV: [number, number] = [31.2893, 51.4982];
const BROVARY: [number, number] = [30.7903, 50.5111];
const KYIV: [number, number] = [30.5234, 50.4501];

function row(overrides: Partial<VectorChainRow> & Pick<VectorChainRow, 'classification_id' | 'published_at' | 'location_id' | 'name_uk'>): VectorChainRow {
  return {
    event_id: EVENT,
    decision: 'event_merged',
    intent: 'threat',
    direction_text: null,
    source_message_id: 'msg',
    source_id: 'osint-war-monitor',
    source_name: 'War Monitor',
    tier: 'B',
    official: false,
    independence_group: 'osint-war-monitor',
    raw_text: 'Тестове повідомлення',
    role: 'asserted',
    relation_type: 'mentioned',
    location_type: 'city',
    latitude: null,
    longitude: null,
    ...overrides
  } as VectorChainRow;
}

/** Two independent sources, four minutes apart, Chernihiv -> Brovary. Roughly 115 km at 1730 km/h. */
function southboundChain(): ReturnType<typeof buildReportedVector> {
  return buildReportedVector(EVENT, [
    row({
      classification_id: 'a', published_at: '2026-08-07T20:00:00.000Z', location_id: 'ua-city-chernihiv',
      name_uk: 'Чернігів', longitude: CHERNIHIV[0], latitude: CHERNIHIV[1],
      source_id: 'osint-war-monitor', independence_group: 'osint-war-monitor'
    }),
    row({
      classification_id: 'b', published_at: '2026-08-07T20:04:00.000Z', location_id: 'ua-city-brovary',
      name_uk: 'Бровари', longitude: BROVARY[0], latitude: BROVARY[1],
      source_id: 'osint-eradar', independence_group: 'osint-eradar'
    }),
    row({
      classification_id: 'c', published_at: '2026-08-07T20:08:00.000Z', location_id: 'ua-80',
      name_uk: 'Київ', location_type: 'special_city', longitude: KYIV[0], latitude: KYIV[1],
      source_id: 'osint-aeris-rimor', independence_group: 'osint-aeris-rimor'
    })
  ]);
}

const PLACES = [
  { id: 'ua-city-bila-tserkva', name: 'Біла Церква', type: 'city', point: [30.1311, 49.7956] as [number, number], precision: 'point' as const },
  { id: 'ua-city-lviv', name: 'Львів', type: 'city', point: [24.0297, 49.8397] as [number, number], precision: 'point' as const },
  { id: 'ua-city-kharkiv', name: 'Харків', type: 'city', point: [36.2304, 49.9935] as [number, number], precision: 'point' as const }
];

describe('spherical helpers', () => {
  it('measures the distance and heading between two Ukrainian cities', () => {
    expect(distanceKm(CHERNIHIV, BROVARY)).toBeGreaterThan(110);
    expect(distanceKm(CHERNIHIV, BROVARY)).toBeLessThan(125);
    // Chernihiv to Brovary is south-south-west.
    expect(bearingDegrees(CHERNIHIV, BROVARY)).toBeGreaterThan(190);
    expect(bearingDegrees(CHERNIHIV, BROVARY)).toBeLessThan(215);
  });

  it('round-trips a point through bearing and distance', () => {
    const moved = destinationPoint(KYIV, 90, 100);
    expect(distanceKm(KYIV, moved)).toBeCloseTo(100, 1);
    expect(bearingDegrees(KYIV, moved)).toBeCloseTo(90, 1);
  });

  it('takes the short way round when comparing bearings', () => {
    expect(angularDifference(10, 350)).toBe(20);
    expect(angularDifference(350, 10)).toBe(-20);
  });
});

describe('cone half angle', () => {
  it('widens for every admission and never claims better than the floor', () => {
    const tight = coneHalfAngle({ segmentCount: 3, approximateCoordinates: false, elapsedSeconds: 240, staleSeconds: 60, basis: 'reported_transit' });
    expect(tight.halfAngle).toBe(12);
    expect(tight.reasons).toEqual([]);
    const loose = coneHalfAngle({ segmentCount: 1, approximateCoordinates: true, elapsedSeconds: 20, staleSeconds: 1800, basis: 'observation_sequence' });
    expect(loose.halfAngle).toBeGreaterThan(tight.halfAngle);
    expect(loose.reasons.length).toBeGreaterThanOrEqual(4);
    expect(loose.halfAngle).toBeLessThanOrEqual(60);
  });

  it('charges for a speed that was never measured', () => {
    const measured = coneHalfAngle({ segmentCount: 2, approximateCoordinates: false, elapsedSeconds: 240, staleSeconds: 60, basis: 'reported_transit' });
    const inferred = coneHalfAngle({ segmentCount: 2, approximateCoordinates: false, elapsedSeconds: 240, staleSeconds: 60, basis: 'reported_transit', timingInferred: true });
    expect(inferred.halfAngle).toBeGreaterThan(measured.halfAngle);
    expect(inferred.reasons.join(' ')).toContain('не виміряно');
  });
});

describe('computeProjection', () => {
  it('extrapolates the last leg and marks the result as a calculation in the data', () => {
    const vector = southboundChain()!;
    const result = computeProjection(vector, PLACES, { horizonMinutes: 10, now: Date.parse('2026-08-07T20:09:00.000Z') });
    expect(result.available).toBe(true);
    if (!result.available) return;
    const { projection } = result;
    expect(projection.dataNature).toBe('calculated');
    expect(projection.method).toBe('last_leg_linear');
    expect(projection.basis.fromLocationId).toBe('ua-city-brovary');
    expect(projection.basis.toLocationId).toBe('ua-80');
    expect(projection.groundSpeedKmh).toBeGreaterThan(0);
    expect(projection.horizonDistanceKm).toBeCloseTo(projection.groundSpeedKmh * 10 / 60, 0);
    expect(projection.geometry.centerline.coordinates).toHaveLength(2);
    expect(projection.geometry.cone.type).toBe('Polygon');
    expect(projection.geometry.cone.coordinates[0]!.length).toBeGreaterThan(10);
  });

  it('always states an uncertainty, and can never state high confidence', () => {
    const vector = southboundChain()!;
    const result = computeProjection(vector, PLACES, { now: Date.parse('2026-08-07T20:09:00.000Z') });
    if (!result.available) throw new Error('expected a projection');
    expect(['low', 'medium']).toContain(result.projection.uncertainty.confidence);
    expect(result.projection.uncertainty.lateralHalfAngleDegrees).toBeGreaterThan(0);
    expect(result.projection.uncertainty.radiusKmAtHorizon).toBeGreaterThan(0);
    expect(result.projection.uncertainty.reasons.length).toBeGreaterThan(0);
    // The chain is `observation_sequence` throughout: nobody reported the movement, so the
    // extrapolation of it cannot be the confident branch.
    expect(result.projection.uncertainty.confidence).toBe('low');
  });

  it('says so in the narrative rather than only in a caption', () => {
    const vector = southboundChain()!;
    const result = computeProjection(vector, PLACES, { now: Date.parse('2026-08-07T20:09:00.000Z') });
    if (!result.available) throw new Error('expected a projection');
    expect(result.projection.narrative).toContain('РОЗРАХУНОК, НЕ СПОСТЕРЕЖЕННЯ');
    expect(result.projection.narrative).toContain('Жодне джерело цього не повідомляло');
    expect(result.projection.narrativeOrigin).toBe('deterministic');
    expect(result.projection.modelVersion).toBeNull();
  });

  it('refuses to call a transit chain confident when nobody timed the leg', () => {
    // Two `redirect` messages: Chernihiv -> Brovary -> Kyiv. Each states both its own ends, so no
    // message ever measured how long a leg took; the interval comes from the node timestamps.
    const redirect = (classification: string, at: string, fromId: string, fromName: string, fromPoint: [number, number], toId: string, toName: string, toPoint: [number, number], source: string) => ([
      row({
        classification_id: classification, published_at: at, location_id: fromId, name_uk: fromName,
        longitude: fromPoint[0], latitude: fromPoint[1], role: 'retracted', relation_type: null,
        decision: 'redirect', intent: 'redirect', source_id: source, independence_group: source
      }),
      row({
        classification_id: classification, published_at: at, location_id: toId, name_uk: toName,
        longitude: toPoint[0], latitude: toPoint[1], relation_type: 'reported_direction',
        decision: 'redirect', intent: 'redirect', source_id: source, independence_group: source
      })
    ]);
    const vector = buildReportedVector(EVENT, [
      ...redirect('a', '2026-08-07T20:00:00.000Z', 'ua-city-chernihiv', 'Чернігів', CHERNIHIV, 'ua-city-brovary', 'Бровари', BROVARY, 'osint-war-monitor'),
      ...redirect('b', '2026-08-07T20:04:00.000Z', 'ua-city-brovary', 'Бровари', BROVARY, 'ua-80', 'Київ', KYIV, 'osint-eradar')
    ])!;
    expect(vector.segments.map((segment) => segment.basis)).toEqual(['reported_transit', 'reported_transit']);
    const result = computeProjection(vector, PLACES, { now: Date.parse('2026-08-07T20:05:00.000Z') });
    if (!result.available) throw new Error('expected a projection');
    expect(result.projection.uncertainty.confidence).toBe('low');
    expect(result.projection.uncertainty.reasons.join(' ')).toContain('не виміряно');
  });

  it('clamps the horizon to the hour the schema allows', () => {
    const vector = southboundChain()!;
    const long = computeProjection(vector, PLACES, { horizonMinutes: 600, now: Date.parse('2026-08-07T20:09:00.000Z') });
    const short = computeProjection(vector, PLACES, { horizonMinutes: -5, now: Date.parse('2026-08-07T20:09:00.000Z') });
    if (!long.available || !short.available) throw new Error('expected projections');
    expect(long.projection.horizonMinutes).toBe(60);
    expect(short.projection.horizonMinutes).toBe(1);
  });

  it('refuses rather than inventing a speed when one message stated both ends', () => {
    const vector = buildReportedVector(EVENT, [
      row({
        classification_id: 'a', published_at: '2026-08-07T20:00:00.000Z', location_id: 'ua-city-brovary',
        name_uk: 'Бровари', longitude: BROVARY[0], latitude: BROVARY[1], role: 'retracted',
        relation_type: null, decision: 'redirect', intent: 'redirect'
      }),
      row({
        classification_id: 'a', published_at: '2026-08-07T20:00:00.000Z', location_id: 'ua-80',
        name_uk: 'Київ', location_type: 'special_city', longitude: KYIV[0], latitude: KYIV[1],
        relation_type: 'reported_direction', decision: 'redirect', intent: 'redirect'
      })
    ])!;
    const result = computeProjection(vector, PLACES, { now: Date.parse('2026-08-07T20:01:00.000Z') });
    expect(result).toMatchObject({ available: false, reason: 'no_elapsed_time' });
  });

  it('refuses when neither end of any leg can be placed on the map', () => {
    const vector = buildReportedVector(EVENT, [
      row({ classification_id: 'a', published_at: '2026-08-07T20:00:00.000Z', location_id: 'ua-hromada-a', name_uk: 'Громада А', location_type: 'hromada' }),
      row({ classification_id: 'b', published_at: '2026-08-07T20:03:00.000Z', location_id: 'ua-hromada-b', name_uk: 'Громада Б', location_type: 'hromada' })
    ])!;
    expect(computeProjection(vector, PLACES)).toMatchObject({ available: false, reason: 'no_drawable_leg' });
  });

  it('refuses a speed that is an artefact of two reports landing seconds apart', () => {
    const vector = buildReportedVector(EVENT, [
      row({
        classification_id: 'a', published_at: '2026-08-07T20:00:00.000Z', location_id: 'ua-city-lviv',
        name_uk: 'Львів', longitude: 24.0297, latitude: 49.8397
      }),
      row({
        classification_id: 'b', published_at: '2026-08-07T20:00:01.000Z', location_id: 'ua-city-kharkiv',
        name_uk: 'Харків', longitude: 36.2304, latitude: 49.9935
      })
    ])!;
    expect(computeProjection(vector, PLACES)).toMatchObject({ available: false, reason: 'implausible_speed' });
  });
});

describe('candidate ranking', () => {
  it('names only places that lie along the projected bearing', () => {
    // Project south-west out of Kyiv, far enough to reach Bila Tserkva and no further.
    const bilaTserkva = PLACES[0]!.point;
    const bearing = bearingDegrees(KYIV, bilaTserkva);
    const horizon = distanceKm(KYIV, bilaTserkva);
    const candidates = rankCandidates(KYIV, bearing, horizon, 20, 600, new Set(['ua-80']), PLACES);
    expect(candidates.map((candidate) => candidate.locationId)).toContain('ua-city-bila-tserkva');
    expect(candidates.map((candidate) => candidate.locationId)).not.toContain('ua-city-kharkiv');
    expect(candidates[0]!.rank).toBe(1);
    expect(candidates[0]!.minutesToReach).toBeGreaterThan(0);
  });
});

describe('model rewording guard', () => {
  const vector = southboundChain()!;
  const result = computeProjection(vector, PLACES, { horizonMinutes: 10, now: Date.parse('2026-08-07T20:09:00.000Z') });
  if (!result.available) throw new Error('expected a projection');
  const allowed = allowedNumbers(result.projection);

  it('accepts a rewording that reuses only the numbers the computation produced', () => {
    const restated = `Розрахунок на ${result.projection.horizonMinutes} хвилин, курс ${result.projection.bearingDegrees} градусів.`;
    expect(narrativeIsFaithful(restated, allowed)).toBe(true);
  });

  it('accepts prose that carries no numbers at all', () => {
    expect(narrativeIsFaithful('Це внутрішній розрахунок, а не спостереження.', allowed)).toBe(true);
  });

  it('rejects a rewording that invents a measurement', () => {
    expect(narrativeIsFaithful('Ціль рухається зі швидкістю 4321 км/год.', allowed)).toBe(false);
    expect(narrativeIsFaithful('Підліт 3 хвилини 17 секунд.', allowed)).toBe(false);
  });
});
