import { beforeEach, describe, expect, it, vi } from 'vitest';

// The actualization module reads settings and a table; the pure builders never touch either, and the
// one test that goes through the query layer drives both by hand. Hoisted, because `vi.mock` is.
const database = vi.hoisted(() => ({ query: vi.fn() }));
const actualizations = vi.hoisted(() => ({ actualizationApplies: vi.fn(), latestActualizations: vi.fn() }));
vi.mock('../db/pool.js', () => ({ pool: database }));
vi.mock('./track-actualization.js', () => actualizations);

import {
  buildReportedTrack, buildReportedTracks, buildReportedVector, raionCentroids, reportedVectorsForLiveEvents,
  type TrackContext, type VectorChainRow
} from './threat-vectors.js';

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
  eventThreatType?: string;
  classificationThreatType?: string | null;
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
    event_threat_type: options.eventThreatType ?? 'ballistic_missile',
    classification_threat_type: options.classificationThreatType === undefined
      ? 'ballistic_missile' : options.classificationThreatType,
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

  it('publishes a hromada catalogue point as approximate, and a settlement point as a point', () => {
    // The hromada's point is the centre of an area. Drawn as solid, it would claim a position nobody
    // reported: the map draws `approximate` hollow, exactly as it draws a raion centroid.
    const vector = buildReportedVector(EVENT, [
      row({
        classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-hromada-velykodymerska',
        name: 'Великодимерська громада', type: 'hromada', latitude: 50.81, longitude: 30.92
      }),
      row({ classification: 'b', at: '2026-08-07T20:03:00.000Z', location: 'ua-city-brovary', name: 'Бровари' })
    ])!;
    expect(vector.nodes.map((node) => [node.coordinateSource, node.coordinatePrecision])).toEqual([
      ['catalogue', 'approximate'], ['catalogue', 'point']
    ]);
    expect(vector.segments[0]!.drawable).toBe(true);
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

  /**
   * A vector says *what* is moving as plainly as it says where.
   *
   * The two fields answer two different questions and are not interchangeable: the envelope carries
   * the class the EVENT is filed under — the same one the card, the icon stack and the bot already
   * show — and a segment carries the class the message that produced its destination end reported.
   * They agree almost always, and the case where they do not is the one worth publishing: a chain
   * that opened as БпЛА and continued as ballistics.
   */
  describe('the class that is moving', () => {
    it('publishes the event class on the envelope and the message class on every segment', () => {
      const vector = buildReportedVector(EVENT, [
        row({
          classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary',
          name: 'Бровари', latitude: 50.5111, longitude: 30.7903,
          eventThreatType: 'ballistic_missile', classificationThreatType: 'ballistic_missile'
        }),
        row({
          classification: 'b', at: '2026-08-07T20:02:00.000Z', location: 'ua-city-boryspil',
          name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550,
          eventThreatType: 'ballistic_missile', classificationThreatType: 'ballistic_missile'
        })
      ])!;
      expect(vector.threatType).toBe('ballistic_missile');
      expect(vector.segments.map((segment) => segment.threatType)).toEqual(['ballistic_missile']);
    });

    it('keeps a leg whose message reported a different class from the event it landed on', () => {
      const vector = buildReportedVector(EVENT, [
        row({
          classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-chernihiv',
          name: 'Чернігів', latitude: 51.4982, longitude: 31.2893,
          eventThreatType: 'combined', classificationThreatType: 'uav'
        }),
        row({
          classification: 'b', at: '2026-08-07T20:04:00.000Z', location: 'ua-city-brovary',
          name: 'Бровари', latitude: 50.5111, longitude: 30.7903,
          eventThreatType: 'combined', classificationThreatType: 'ballistic_missile'
        })
      ])!;
      // The destination end made the leg, so the leg carries what that message said.
      expect(vector.segments[0]!.threatType).toBe('ballistic_missile');
      // The event is still what the event is.
      expect(vector.threatType).toBe('combined');
    });

    it('falls back to the event class for a message that recorded none', () => {
      // `message_classifications.threat_type` is nullable — a withdrawal raises no class of its own.
      // The leg is still a leg, and «клас не вказано» on the map would be a second, wrong statement.
      const vector = buildReportedVector(EVENT, [
        row({
          classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary',
          name: 'Бровари', latitude: 50.5111, longitude: 30.7903,
          eventThreatType: 'guided_air_bomb', classificationThreatType: 'guided_air_bomb'
        }),
        row({
          classification: 'b', at: '2026-08-07T20:02:00.000Z', location: 'ua-city-boryspil',
          name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550,
          eventThreatType: 'guided_air_bomb', classificationThreatType: null
        })
      ])!;
      expect(vector.segments[0]!.threatType).toBe('guided_air_bomb');
    });

    it('adds the new fields without touching anything that was already published', () => {
      // Additive, literally: every key the previous payload had is still present, so a client
      // written against it needs no change.
      const rows = [
        row({ classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary', name: 'Бровари' }),
        row({
          classification: 'b', at: '2026-08-07T20:02:00.000Z', location: 'ua-city-boryspil',
          name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550
        })
      ];
      const vector = buildReportedVector(EVENT, rows)!;
      expect(Object.keys(vector))
        .toEqual(expect.arrayContaining(['disclaimer', 'eventId', 'kind', 'nodes', 'segments', 'span', 'threatType']));
      expect(Object.keys(vector.segments[0]!)).toEqual(expect.arrayContaining([
        'basis', 'basisLabel', 'drawable', 'elapsedSeconds', 'evidenceLevel', 'from',
        'independentEnds', 'missingCoordinates', 'originSource', 'reportedAt', 'source',
        'statement', 'threatType', 'to'
      ]));
    });
  });

  it('publishes the same disclaimer on every chain', () => {
    const vector = buildReportedVector(EVENT, [
      row({ classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary', name: 'Бровари' }),
      row({ classification: 'b', at: '2026-08-07T20:02:00.000Z', location: 'ua-city-boryspil', name: 'Бориспіль', latitude: 50.35, longitude: 30.95 })
    ])!;
    expect(vector.disclaimer).toContain('не траєкторія');
    expect(vector.kind).toBe('reported_observation_chain');
  });

  it('anchors on the place a message names last when two are equally specific', () => {
    // «з Борисполя на Бровари»: the destination is named last, and it is the newer fact. The rows
    // arrive in `location_id` order, where `boryspil` sorts first — which is what used to win.
    const text = 'БпЛА з Борисполя на Бровари';
    const vector = buildReportedVector(EVENT, [
      row({ classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-boryspil', name: 'Бориспіль', text }),
      row({ classification: 'a', at: '2026-08-07T20:00:00.000Z', location: 'ua-city-brovary', name: 'Бровари', text }),
      row({ classification: 'b', at: '2026-08-07T20:04:00.000Z', location: 'ua-80', name: 'Київ', type: 'special_city' })
    ])!;
    expect(vector.nodes.map((node) => node.locationId)).toEqual(['ua-city-brovary', 'ua-80']);
    expect(vector.nodes[0]!.reports[0]!.alsoNamed).toEqual(['Бориспіль']);
  });
});

/**
 * The track — the current part of the chain, which is all the map draws — against a fixed clock.
 *
 * Each case is one rule of the module docblock: a node ages out with its class's window, the head is
 * never the thing cut, a return is a visit and not a new place, and the model shapes the track only
 * when every condition holds.
 */
describe('the track', () => {
  const NOW = Date.parse('2026-09-23T21:00:00.000Z');
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const CHERNIHIV = { location: 'ua-city-chernihiv', name: 'Чернігів', latitude: 51.4982, longitude: 31.2893 };
  const BROVARY = { location: 'ua-city-brovary', name: 'Бровари', latitude: 50.5111, longitude: 30.7903 };
  const BORYSPIL = { location: 'ua-city-boryspil', name: 'Бориспіль', latitude: 50.3527, longitude: 30.9550 };
  const KYIV = { location: 'ua-80', name: 'Київ', type: 'special_city', latitude: 50.4501, longitude: 30.5234 };
  type Place = { location: string; name: string; type?: string; latitude: number | null; longitude: number | null };

  function report(
    threatType: string, classification: string, minutesAgo: number, place: Place, extra: Partial<RowOptions> = {}
  ): VectorChainRow {
    return row({
      classification, at: ago(minutesAgo), ...place,
      eventThreatType: threatType, classificationThreatType: threatType, ...extra
    });
  }
  const uav = (classification: string, minutesAgo: number, place: Place, extra: Partial<RowOptions> = {}) =>
    report('uav', classification, minutesAgo, place, extra);
  const ballistic = (classification: string, minutesAgo: number, place: Place, extra: Partial<RowOptions> = {}) =>
    report('ballistic_missile', classification, minutesAgo, place, extra);
  const ids = (vector: { nodes: Array<{ locationId: string }> }) => vector.nodes.map((node) => node.locationId);

  it('drops a node older than its class horizon and keeps the head', () => {
    // БпЛА: twenty-five minutes. Чернігів forty minutes ago is history; the map stops drawing it.
    const rows = [uav('a', 40, CHERNIHIV), uav('b', 20, BROVARY), uav('c', 5, BORYSPIL)];
    const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
    expect(ids(track)).toEqual([BROVARY.location, BORYSPIL.location]);
    expect(track.track).toMatchObject({ status: 'moving', headIndex: 1, horizonSeconds: 1500, basis: 'rules' });
    expect(track.nodes.map((node) => node.ageSeconds)).toEqual([1200, 300]);
    // The dialog keeps the whole history, with the same head pointed at in it.
    const history = buildReportedVector(EVENT, rows, { now: NOW })!;
    expect(ids(history)).toEqual([CHERNIHIV.location, BROVARY.location, BORYSPIL.location]);
    expect(history.track.headIndex).toBe(2);

    // The head is never what the window cuts, however old: the dialog still names it, as stale.
    const old = buildReportedVector(EVENT, [uav('a', 40, CHERNIHIV), uav('b', 30, BROVARY)], { now: NOW })!;
    expect(old.track).toMatchObject({ status: 'stale', headIndex: 1, headAgeSeconds: 1800 });
  });

  it('marks a head older than its head-stale window as stale, and still draws it', () => {
    const rows = [ballistic('a', 5, BROVARY), ballistic('b', 4, BORYSPIL)];
    expect(buildReportedTrack(EVENT, rows, { now: NOW })!.track)
      .toMatchObject({ status: 'stale', headAgeSeconds: 240, staleAfterSeconds: 180, horizonSeconds: 360 });
    // Two minutes earlier the same head was three minutes old at most: moving.
    expect(buildReportedTrack(EVENT, rows, { now: NOW - 2 * 60_000 })!.track.status).toBe('moving');
  });

  it('omits a track whose head is older than its horizon', () => {
    // Балістика: six minutes. A seven-minute-old head describes a missile that has already arrived.
    const rows = [ballistic('a', 9, BROVARY), ballistic('b', 7, BORYSPIL)];
    expect(buildReportedTrack(EVENT, rows, { now: NOW })).toBeNull();
    expect(buildReportedTracks([EVENT], rows, { now: NOW })).toEqual([]);
    // The history is still there for the dialog, and says why the map has no line.
    expect(buildReportedVector(EVENT, rows, { now: NOW })!.track.status).toBe('stale');
  });

  it('collapses A→B→A into two places, counts the return and reads it as a loiter', () => {
    const rows = [uav('a', 10, BROVARY), uav('b', 6, BORYSPIL), uav('c', 2, BROVARY)];
    const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
    expect(track.nodes.map((node) => [node.locationId, node.visits, node.role, node.loiter])).toEqual([
      [BORYSPIL.location, 1, 'origin', false],
      [BROVARY.location, 2, 'head', true]
    ]);
    // One line between the two places, pointing the newest way — not two mirrored arcs.
    expect(track.segments.map((segment) => [segment.from, segment.to])).toEqual([[0, 1]]);
    expect(track.track).toMatchObject({ status: 'loitering', headIndex: 1 });
    // The history still reads the archive as it happened.
    expect(ids(buildReportedVector(EVENT, rows, { now: NOW })!))
      .toEqual([BROVARY.location, BORYSPIL.location, BROVARY.location]);
  });

  it('reads three reports on the head over four minutes as a loiter, and not three within two', () => {
    const circling = [uav('a', 12, BORYSPIL), uav('b', 9, BROVARY), uav('c', 7, BROVARY), uav('d', 5, BROVARY)];
    expect(buildReportedTrack(EVENT, circling, { now: NOW })!.track.status).toBe('loitering');
    const passing = [uav('a', 12, BORYSPIL), uav('b', 7, BROVARY), uav('c', 6, BROVARY), uav('d', 5, BROVARY)];
    expect(buildReportedTrack(EVENT, passing, { now: NOW })!.track.status).toBe('moving');
  });

  it('keeps at most four nodes: the head and the three freshest', () => {
    const places = [CHERNIHIV, BROVARY, BORYSPIL, KYIV,
      { location: 'ua-city-obukhiv', name: 'Обухів', latitude: 50.107, longitude: 30.618 },
      { location: 'ua-city-vasylkiv', name: 'Васильків', latitude: 50.178, longitude: 30.320 }];
    const rows = places.map((place, index) => uav(`m${index}`, 20 - index * 3, place));
    const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
    expect(ids(track)).toEqual(places.slice(2).map((place) => place.location));
    expect(track.segments).toHaveLength(3);
    expect(track.track.headIndex).toBe(3);
  });

  it('drops an oblast node while the track holds a finer one', () => {
    const OBLAST = { location: 'ua-32', name: 'Київська область', type: 'oblast', latitude: 50.05, longitude: 30.76 };
    const rows = [uav('a', 10, BORYSPIL), uav('b', 6, OBLAST), uav('c', 2, BROVARY)];
    const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
    expect(ids(track)).toEqual([BORYSPIL.location, BROVARY.location]);
    // The leg now joins two separate messages across the dropped one, and says so.
    expect(track.segments.map((segment) => segment.basis)).toEqual(['observation_sequence']);
    expect(ids(buildReportedVector(EVENT, rows, { now: NOW })!)).toHaveLength(3);

    // With nothing finer on the track, the oblasts ARE the track. Their catalogue points are 166 km
    // apart, four minutes apart — and they stay joined: an oblast is an area, never measured.
    const CHERNIHIV_OBLAST = { location: 'ua-74', name: 'Чернігівська область', type: 'oblast', latitude: 51.5, longitude: 31.3 };
    expect(ids(buildReportedTrack(EVENT, [uav('a', 6, CHERNIHIV_OBLAST), uav('b', 2, OBLAST)], { now: NOW })!))
      .toEqual(['ua-74', 'ua-32']);
  });

  describe('the plausibility break', () => {
    const SLAVUTYCH = { location: 'ua-city-slavutych', name: 'Славутич', latitude: 51.5226, longitude: 30.7200 };
    const CHORNOBYL = { location: 'ua-city-chornobyl', name: 'Чорнобиль', latitude: 51.2763, longitude: 30.2219 };
    const KROPYVNYTSKYI = { location: 'ua-city-kropyvnytskyi', name: 'Кропивницький', latitude: 48.5079, longitude: 32.2623 };
    const OLEKSANDRIIA = { location: 'ua-city-oleksandriia', name: 'Олександрія', latitude: 48.6696, longitude: 33.1159 };
    const POLTAVA = { location: 'ua-city-poltava', name: 'Полтава', latitude: 49.5883, longitude: 34.5514 };
    const KREMENCHUK = { location: 'ua-city-kremenchuk', name: 'Кременчук', latitude: 49.0680, longitude: 33.4204 };

    it('cuts the track at a leg no drone could fly, and keeps the glued group in the history', () => {
      // The archive's case: two groups on one event, and Київ → Кропивницький is 250 km reported
      // 116 s apart. A jet Shahed covers at most 130 km in the ten-minute lag floor, margin included.
      const glued = [
        uav('a', 20, SLAVUTYCH), uav('b', 14, CHORNOBYL), uav('c', 6, KYIV), uav('d', 6 - 116 / 60, KROPYVNYTSKYI)
      ];
      // Alone after the cut, Кропивницький is a place somebody named, not a vector.
      expect(buildReportedTrack(EVENT, glued, { now: NOW })).toBeNull();

      const rows = [...glued, uav('e', 1, OLEKSANDRIIA)];
      const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
      expect(track.nodes.map((node) => [node.locationId, node.role])).toEqual([
        [KROPYVNYTSKYI.location, 'origin'], [OLEKSANDRIIA.location, 'head']
      ]);
      expect(track.segments.map((segment) => [segment.from, segment.to])).toEqual([[0, 1]]);
      expect(ids(buildReportedVector(EVENT, rows, { now: NOW })!)).toEqual([
        SLAVUTYCH.location, CHORNOBYL.location, KYIV.location, KROPYVNYTSKYI.location, OLEKSANDRIIA.location
      ]);
    });

    it('keeps a fast leg a drone could fly, however close together its reports', () => {
      // Полтава → Кременчук is 100 km: over twelve minutes that is 500 km/h, within a jet Shahed.
      expect(ids(buildReportedTrack(EVENT, [uav('a', 14, POLTAVA), uav('b', 2, KREMENCHUK)], { now: NOW })!))
        .toEqual([POLTAVA.location, KREMENCHUK.location]);
      // A minute apart it still stands: channels lag each other by minutes, so no leg is measured
      // against fewer than ten of them.
      expect(ids(buildReportedTrack(EVENT, [uav('a', 3, POLTAVA), uav('b', 2, KREMENCHUK)], { now: NOW })!))
        .toEqual([POLTAVA.location, KREMENCHUK.location]);
    });

    it('never cuts a ballistic track', () => {
      const rows = [ballistic('a', 3, KYIV), ballistic('b', 1, KROPYVNYTSKYI)];
      expect(ids(buildReportedTrack(EVENT, rows, { now: NOW })!)).toEqual([KYIV.location, KROPYVNYTSKYI.location]);
    });

    it('measures across a place without a coordinate, which neither causes a cut nor hides one', () => {
      const HROMADA = { location: 'ua-hromada-x', name: 'Якась громада', type: 'hromada', latitude: null, longitude: null };
      const rows = [uav('a', 8, KYIV), uav('b', 5, HROMADA), uav('c', 3, KROPYVNYTSKYI), uav('d', 1, OLEKSANDRIIA)];
      expect(ids(buildReportedTrack(EVENT, rows, { now: NOW })!))
        .toEqual([HROMADA.location, KROPYVNYTSKYI.location, OLEKSANDRIIA.location]);
    });
  });

  describe('heading', () => {
    it('puts the head where the head message placed the target and its destination in heading', () => {
      const text = 'БпЛА над Броварами курсом на Київ';
      const rows = [
        uav('a', 10, CHERNIHIV),
        uav('b', 3, BROVARY, { text }),
        uav('b', 3, KYIV, { text, relation: 'reported_direction' })
      ];
      const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
      expect(ids(track)).toEqual([CHERNIHIV.location, BROVARY.location]);
      expect(track.track.heading).toEqual({ locationId: 'ua-80', name: 'Київ', coordinates: [30.5234, 50.4501] });
      expect(track.track.headIndex).toBe(1);
      // In the history the destination is a node, after the head.
      const history = buildReportedVector(EVENT, rows, { now: NOW })!;
      expect(ids(history)).toEqual([CHERNIHIV.location, BROVARY.location, 'ua-80']);
      expect(history.track.headIndex).toBe(1);
    });

    it('keeps a destination the message named alone as the head', () => {
      const rows = [uav('a', 10, CHERNIHIV), uav('b', 3, KYIV, { relation: 'reported_direction' })];
      const track = buildReportedTrack(EVENT, rows, { now: NOW })!;
      expect(ids(track)).toEqual([CHERNIHIV.location, 'ua-80']);
      expect(track.track.heading).toBeNull();
    });

    it('publishes a lone head when it has a heading to show', () => {
      const text = 'Балістика повз Бровари на Бориспіль';
      const track = buildReportedTrack(EVENT, [
        ballistic('a', 1, BROVARY, { text, decision: 'redirect', intent: 'redirect', role: 'retracted', relation: null }),
        ballistic('a', 1, BORYSPIL, { text, decision: 'redirect', intent: 'redirect', relation: 'reported_direction' })
      ], { now: NOW })!;
      expect(ids(track)).toEqual([BROVARY.location]);
      expect(track.segments).toEqual([]);
      expect(track.track.heading?.locationId).toBe(BORYSPIL.location);
      // A lone head pointing at nothing is only a place somebody named: the marker shows it already.
      expect(buildReportedTrack(EVENT, [ballistic('a', 1, BROVARY)], { now: NOW })).toBeNull();
    });
  });

  it('keeps an ended event on the map for five minutes, and not before its end is public', () => {
    const ended = (minutesAgo: number) => [uav('a', 8, BROVARY), uav('b', 3, BORYSPIL)]
      .map((entry) => ({ ...entry, event_status: 'expired', event_ended_at: ago(minutesAgo) }));
    expect(buildReportedTrack(EVENT, ended(2), { now: NOW })!.track.status).toBe('ended');
    expect(buildReportedTrack(EVENT, ended(6), { now: NOW })).toBeNull();
    // An end recorded inside the publication hold is not public yet: until then the event is live.
    expect(buildReportedTrack(EVENT, ended(0.1), { now: NOW, cutoff: new Date(NOW - 15_000) })!.track.status)
      .toBe('moving');
  });

  it('publishes at most forty tracks, newest head first', () => {
    const eventIds = Array.from({ length: 45 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    const rows = eventIds.flatMap((eventId, n) => [
      { ...uav(`${n}-a`, 10 + n * 0.2, BROVARY), event_id: eventId },
      { ...uav(`${n}-b`, 1 + n * 0.2, BORYSPIL), event_id: eventId }
    ]);
    const list = buildReportedTracks([...eventIds].reverse(), rows, { now: NOW });
    expect(list.map((vector) => vector.eventId)).toEqual(eventIds.slice(0, 40));
  });

  describe('the model actualization', () => {
    // Київ is named beside Бровари in message b, so it is a place of the event without being a node.
    const rows = [
      uav('a', 10, CHERNIHIV),
      uav('b', 6, BROVARY),
      uav('b', 6, KYIV),
      uav('c', 2, BORYSPIL)
    ];
    const reading = {
      eventId: EVENT, asOf: ago(2), createdAt: ago(1), model: 'gpt-6-luna', status: 'loitering' as const,
      headLocationId: BROVARY.location, headingLocationId: 'ua-80', originLocationId: null,
      loiterLocationId: BROVARY.location, currentSince: ago(8), summary: 'Кружляє над Броварами', confidence: 0.8
    };
    const context: TrackContext = {
      now: NOW, cutoff: new Date(NOW - 30_000), actualizationApplies: true, actualization: reading
    };

    it('shapes the track when every condition holds', () => {
      const track = buildReportedTrack(EVENT, rows, context)!;
      // `currentSince` made Чернігів history; the head is where the model put it, and it circles.
      expect(ids(track)).toEqual([BROVARY.location, BORYSPIL.location]);
      expect(track.track).toMatchObject({
        basis: 'model', status: 'loitering', headIndex: 0, summary: 'Кружляє над Броварами',
        model: 'gpt-6-luna', confidence: 0.8, heading: { locationId: 'ua-80', name: 'Київ' }
      });
      expect(track.nodes.map((node) => [node.role, node.loiter])).toEqual([['head', true], ['trail', false]]);
    });

    it.each([
      ['the feature does not apply', { actualizationApplies: false }],
      ['confidence is below 0.6', { actualization: { ...reading, confidence: 0.59 } }],
      ['it has not seen the newest classification', { actualization: { ...reading, asOf: ago(3) } }],
      ['it was written after the publication cutoff', { actualization: { ...reading, createdAt: ago(0.25) } }]
    ])('falls back to the rules when %s', (_, change) => {
      const track = buildReportedTrack(EVENT, rows, { ...context, ...change })!;
      expect(track.track).toMatchObject({ basis: 'rules', status: 'moving', summary: null, model: null, confidence: null });
      expect(ids(track)).toEqual([CHERNIHIV.location, BROVARY.location, BORYSPIL.location]);
      expect(track.track.heading).toBeNull();
    });

    it('ignores an id the event does not hold, and keeps the rest of the reading', () => {
      const track = buildReportedTrack(EVENT, rows, {
        ...context, actualization: { ...reading, headLocationId: 'ua-city-lviv', headingLocationId: 'ua-city-odesa' }
      })!;
      expect(track.track.basis).toBe('model');
      // Львів is no place of this event: the head stays the rules' head, and nothing new is drawn.
      expect(track.nodes[track.track.headIndex]!.locationId).toBe(BORYSPIL.location);
      expect(ids(track)).not.toContain('ua-city-lviv');
      expect(track.track.heading).toBeNull();
    });

    describe('through the query layer', () => {
      beforeEach(() => {
        database.query.mockReset();
        actualizations.actualizationApplies.mockReset();
        actualizations.latestActualizations.mockReset();
      });

      it.each([
        ['the actualization read fails', () => {
          actualizations.actualizationApplies.mockResolvedValue(true);
          actualizations.latestActualizations.mockRejectedValue(new Error('relation does not exist'));
        }],
        ['the settings read fails', () => {
          actualizations.actualizationApplies.mockRejectedValue(new Error('connection terminated'));
        }]
      ])('serves the rules track when %s', async (_, arrange) => {
        arrange();
        database.query
          .mockResolvedValueOnce({ rows: [{ id: EVENT }] })
          .mockResolvedValueOnce({ rows });
        const [track] = await reportedVectorsForLiveEvents(new Date(NOW - 15_000), new Date(NOW));
        expect(track!.track.basis).toBe('rules');
        expect(ids(track!)).toEqual([CHERNIHIV.location, BROVARY.location, BORYSPIL.location]);
      });
    });
  });
});

describe('raion centroids', () => {
  it('indexes every ADM2 polygon by the catalogue id the map already uses', () => {
    const index = raionCentroids();
    expect(index.size).toBe(136);
    expect(index.get(BROVARY_RAION)).toBeDefined();
  });
});
