import { describe, expect, it } from 'vitest';
import { chooseMergeTarget, type MergeCandidate, type MergeMessage, type MergePlace } from './event-merge.js';

/**
 * Правило злиття без бази: кандидати й місця — такі, якими їх збирає `ingestThreat`, координати —
 * справжні точки каталогу. Кожен випадок — рішення, яке правило має ухвалити, і кожен ламається від
 * правдоподібної помилки: пласкі тридцять хвилин замість горизонту класу, спільна область як «те саме
 * місце», кожна названа назва як позиція, стеля швидкості не того класу, звуження класу при злитті.
 */

const MINUTE = 60_000;
const T = Date.parse('2026-09-22T21:00:00.000Z');

const place = (id: string, type: string, point: [number, number] | null = null): MergePlace => ({ id, type, point });
const KYIV = place('ua-80', 'special_city', [30.5234, 50.4501]);
const BROVARY = place('brovary', 'city', [30.79, 50.5111]);
const KAHARLYK = place('kaharlyk', 'city', [30.8227, 49.8651]);
const KROPYVNYTSKYI = place('kropyvnytskyi', 'city', [32.2623, 48.5079]);
const SLAVUTYCH = place('slavutych', 'city', [30.7562, 51.5201]);
const CHERKASY = place('cherkasy', 'city', [32.0598, 49.4444]);
const BILA_TSERKVA = place('bila-tserkva', 'city', [30.1311, 49.7956]);
const KYIV_OBLAST = place('ua-32', 'oblast', [30.5234, 50.4501]);
const CHERNIHIV_OBLAST = place('ua-74', 'oblast', [31.2893, 51.4982]);
const CHERNIHIV = place('chernihiv', 'city', [31.2893, 51.4982]);
const BROVARY_RAION = place('brovary-raion', 'raion');

/** Where a message puts the target, and everything it names — its positions unless told otherwise. */
function message(threatType: string, atMs: number, positions: MergePlace[], named: MergePlace[] = positions): MergeMessage {
  return { threatType, atMs, positions, named };
}

/** A live «now» event whose archive holds `reports`; its last observation is the newest of them. */
function event(
  id: string, threatType: string, reports: Array<{ atMs: number; positions: MergePlace[]; named?: MergePlace[] }>
): MergeCandidate {
  const archive = reports.map((report) => ({ ...report, named: report.named ?? report.positions }));
  return {
    id, threatType, expectedOpen: false,
    lastObservedAtMs: Math.max(...archive.map((report) => report.atMs)),
    attached: { positions: archive.flatMap((report) => report.positions), named: archive.flatMap((report) => report.named) },
    reports: archive
  };
}

describe('chooseMergeTarget', () => {
  describe('place', () => {
    it('splits two groups a region apart, even two minutes after each other', () => {
      // Київ → Кропивницький is ~250 km; the fastest drone covers 130 km inside the ten-minute floor.
      const kyiv = event('kyiv', 'uav', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('uav', T + 2 * MINUTE, [KROPYVNYTSKYI]), [kyiv])).toBeNull();
    });

    it('joins a place the same group can reach from the head', () => {
      const brovary = event('brovary', 'uav', [{ atMs: T, positions: [BROVARY] }]);
      const decision = chooseMergeTarget(message('uav', T + 8 * MINUTE, [KYIV]), [brovary]);
      expect(decision).toMatchObject({ eventId: 'brovary', threatType: 'uav', basis: 'reachable' });
      expect(decision!.distanceKm).toBeGreaterThan(15);
      expect(decision!.distanceKm).toBeLessThan(25);
    });

    it('never joins through a shared oblast alone', () => {
      // «Київщина: на Славутич» and «Київщина: на Білу Церкву» — ~195 km apart, three minutes apart.
      const north = event('north', 'uav', [{ atMs: T, positions: [SLAVUTYCH], named: [KYIV_OBLAST, SLAVUTYCH] }]);
      expect(chooseMergeTarget(message('uav', T + 3 * MINUTE, [BILA_TSERKVA], [KYIV_OBLAST, BILA_TSERKVA]), [north]))
        .toBeNull();
    });

    it('joins through an oblast when neither side names anything finer', () => {
      const oblast = event('oblast', 'uav', [{ atMs: T, positions: [CHERNIHIV_OBLAST] }]);
      expect(chooseMergeTarget(message('uav', T + 5 * MINUTE, [CHERNIHIV_OBLAST]), [oblast]))
        .toMatchObject({ eventId: 'oblast', basis: 'coarse_only' });
      // A message that names a city is finer than the oblast-only event: the oblast is not a place
      // the group was measured at, so it is another report, not the same one.
      expect(chooseMergeTarget(message('uav', T + 5 * MINUTE, [CHERNIHIV], [CHERNIHIV_OBLAST, CHERNIHIV]), [oblast]))
        .toBeNull();
    });

    it('judges a digest by where it puts the target, not by every place it names', () => {
      // «Київщина: 6 на Бровари, Черкащина: 3 на Черкаси» names Бровари but, read as the track reads
      // it, puts the target at Черкаси — 150 km from the event at Бровари.
      const brovary = event('brovary', 'uav', [{ atMs: T, positions: [BROVARY] }]);
      expect(chooseMergeTarget(message('uav', T + 2 * MINUTE, [CHERKASY], [KYIV_OBLAST, BROVARY, CHERKASY]), [brovary]))
        .toBeNull();
      expect(chooseMergeTarget(message('uav', T + 2 * MINUTE, [BROVARY], [KYIV_OBLAST, CHERKASY, BROVARY]), [brovary]))
        .toMatchObject({ eventId: 'brovary', basis: 'same_place' });
    });

    it('matches a place without coordinates only by name', () => {
      const raion = event('raion', 'uav', [{ atMs: T, positions: [BROVARY_RAION] }]);
      expect(chooseMergeTarget(message('uav', T + 4 * MINUTE, [BROVARY]), [raion])).toBeNull();
      expect(chooseMergeTarget(message('uav', T + 4 * MINUTE, [BROVARY_RAION]), [raion]))
        .toMatchObject({ eventId: 'raion', basis: 'same_place' });
    });

    it('measures reach from the head and counts only places named inside the window', () => {
      // The event came from Київ; its head is Кропивницький now.
      const flight = event('flight', 'uav', [
        { atMs: T - 20 * MINUTE, positions: [KYIV] },
        { atMs: T, positions: [KROPYVNYTSKYI] }
      ]);
      // Бровари is 20 km from where the event started and 260 km from its head.
      expect(chooseMergeTarget(message('uav', T + 3 * MINUTE, [BROVARY]), [flight])).toBeNull();
      // Київ itself is still a current place of the event three minutes on…
      expect(chooseMergeTarget(message('uav', T + 3 * MINUTE, [KYIV]), [flight]))
        .toMatchObject({ eventId: 'flight', basis: 'same_place' });
      // …and history once the 25-minute drone window has moved past it.
      expect(chooseMergeTarget(message('uav', T + 6 * MINUTE, [KYIV]), [flight])).toBeNull();
    });

    it('stands the head where the newest report put the target, not on its heading', () => {
      // «В районі Кагарлика курсом на Київ»: the target is at Кагарлик. Славутич is 120 km from Київ
      // but 184 km from Кагарлик, out of a drone's reach three minutes later.
      const heading = event('heading', 'uav', [{ atMs: T, positions: [KAHARLYK, KYIV] }]);
      expect(chooseMergeTarget(message('uav', T + 3 * MINUTE, [SLAVUTYCH]), [heading])).toBeNull();
    });

    it('counts the place a transit is passing as where the group is', () => {
      const kyiv = event('kyiv', 'ballistic_missile', [{ atMs: T, positions: [KYIV] }]);
      // «Балістика повз Київ на …»: the destination is a raion with no point, so only the passed
      // place can tie the message to the event.
      const destination = place('far-raion', 'raion');
      expect(chooseMergeTarget(message('ballistic_missile', T + MINUTE, [destination]), [kyiv])).toBeNull();
      expect(chooseMergeTarget(message('ballistic_missile', T + MINUTE, [KYIV, destination], [destination]), [kyiv]))
        .toMatchObject({ eventId: 'kyiv', basis: 'same_place' });
    });
  });

  describe('time', () => {
    it('forgets an event older than its class horizon', () => {
      const drones = event('drones', 'uav', [{ atMs: T, positions: [BROVARY] }]);
      expect(chooseMergeTarget(message('uav', T + 24 * MINUTE, [BROVARY]), [drones])).not.toBeNull();
      expect(chooseMergeTarget(message('uav', T + 26 * MINUTE, [BROVARY]), [drones])).toBeNull();
      // Ballistics is over in minutes: seven minutes later the same place is a new launch.
      const ballistic = event('ballistic', 'ballistic_missile', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('ballistic_missile', T + 7 * MINUTE, [KYIV]), [ballistic])).toBeNull();
    });

    it('keeps the old rule for an expected event whose window is still open', () => {
      // «Увечері очікується» two hours ago, over Київщина: the window, not the last mention, keeps it
      // current, and any shared place of the same class joins it — the oblast included.
      const expected: MergeCandidate = {
        ...event('expected', 'ballistic_missile', [{ atMs: T - 120 * MINUTE, positions: [KYIV_OBLAST] }]),
        expectedOpen: true
      };
      expect(chooseMergeTarget(message('ballistic_missile', T, [BILA_TSERKVA], [KYIV_OBLAST, BILA_TSERKVA]), [expected]))
        .toMatchObject({ eventId: 'expected', threatType: 'ballistic_missile', basis: 'expected_window' });
      // …and exactly the old rule: the class must be the same one.
      expect(chooseMergeTarget(message('unknown', T, [KYIV_OBLAST]), [expected])).toBeNull();
    });
  });

  describe('class', () => {
    it('measures reach with the stricter ceiling of the two classes', () => {
      // Черкаси is ~157 km from Київ: inside what an unknown or combined class may cover in ten
      // minutes (217 km), outside what a drone may (130 km). A report that names no class, or several,
      // says nothing faster about a drone group; only two reports that allow the faster class do.
      const drones = event('drones', 'uav', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('unknown', T + 2 * MINUTE, [CHERKASY]), [drones])).toBeNull();
      expect(chooseMergeTarget(message('combined', T + 2 * MINUTE, [CHERKASY]), [drones])).toBeNull();
      const unnamed = event('unnamed', 'unknown', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('uav', T + 2 * MINUTE, [CHERKASY]), [unnamed])).toBeNull();
      expect(chooseMergeTarget(message('unknown', T + 2 * MINUTE, [CHERKASY]), [unnamed]))
        .toMatchObject({ eventId: 'unnamed', basis: 'reachable' });
    });

    it('lets a report that names no class join the group it is about', () => {
      const drones = event('drones', 'uav', [{ atMs: T, positions: [BROVARY] }]);
      expect(chooseMergeTarget(message('unknown', T + 3 * MINUTE, [BROVARY]), [drones]))
        .toMatchObject({ eventId: 'drones', threatType: 'uav' });
    });

    it('upgrades an unknown event to the class a later report names', () => {
      const unnamed = event('unnamed', 'unknown', [{ atMs: T, positions: [BROVARY] }]);
      expect(chooseMergeTarget(message('uav', T + 3 * MINUTE, [BROVARY]), [unnamed]))
        .toMatchObject({ eventId: 'unnamed', threatType: 'uav' });
    });

    it('widens a single class to combined, and never narrows combined back', () => {
      const drones = event('drones', 'uav', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('combined', T + 2 * MINUTE, [KYIV]), [drones]))
        .toMatchObject({ eventId: 'drones', threatType: 'combined' });
      const combined = event('combined', 'combined', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('ballistic_missile', T + 2 * MINUTE, [KYIV]), [combined]))
        .toMatchObject({ eventId: 'combined', threatType: 'combined' });
    });

    it('keeps different concrete classes apart', () => {
      const drones = event('drones', 'uav', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('ballistic_missile', T + MINUTE, [KYIV]), [drones])).toBeNull();
      const aviation = event('aviation', 'aviation', [{ atMs: T, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('combined', T + MINUTE, [KYIV]), [aviation])).toBeNull();
    });
  });

  describe('several candidates', () => {
    it('picks the nearest head, then the most recent event', () => {
      // Both heads can reach Київ. The one standing on it wins, although the other was seen later.
      const olderKyiv = event('older-kyiv', 'uav', [{ atMs: T - 12 * MINUTE, positions: [KYIV] }]);
      const newerBrovary = event('newer-brovary', 'uav', [{ atMs: T - MINUTE, positions: [BROVARY] }]);
      expect(chooseMergeTarget(message('uav', T, [KYIV]), [newerBrovary, olderKyiv]))
        .toMatchObject({ eventId: 'older-kyiv' });
      // Equal distance: the most recently observed event, whatever order the candidates came in.
      const earlier = event('earlier', 'uav', [{ atMs: T - 9 * MINUTE, positions: [KYIV] }]);
      const later = event('later', 'uav', [{ atMs: T - 3 * MINUTE, positions: [KYIV] }]);
      expect(chooseMergeTarget(message('uav', T, [KYIV]), [earlier, later])).toMatchObject({ eventId: 'later' });
      expect(chooseMergeTarget(message('uav', T, [KYIV]), [later, earlier])).toMatchObject({ eventId: 'later' });
    });
  });
});

describe('chooseMergeTarget: reach that does not grow with time', () => {
  // Catalogue points (migrations 002 and 056), [longitude, latitude]; the one synthetic place stands
  // exactly 30 km north of Краматорськ.
  const CHYHYRYN = place('chyhyryn', 'city', [32.6664, 49.0775]);
  const SVITLOVODSK = place('svitlovodsk', 'city', [33.2072, 49.0454]);
  const SUMY = place('ua-city-sumy', 'city', [34.7981, 50.9077]);
  const KRAMATORSK = place('ua-city-kramatorsk', 'city', [37.5844, 48.7389]);
  const NORTH_OF_KRAMATORSK = place('kramatorsk-30-km-north', 'city', [37.5844, 49.0087]);
  const IZIUM = place('izium', 'city', [37.2784, 49.1913]);
  const ORIKHIV = place('orikhiv', 'city', [35.7855, 47.5754]);
  const ZAPORIZHZHIA = place('ua-city-zaporizhzhia', 'city', [35.1396, 47.8388]);
  const MARHANETS = place('marhanets', 'city', [34.6492, 47.6491]);
  const POLTAVA = place('ua-city-poltava', 'city', [34.5514, 49.5883]);
  const KREMENCHUK = place('kremenchuk', 'city', [33.4035, 49.063]);

  it('keeps a rocket strike in Суми apart from a target heading for Світловодськ', () => {
    // 04:35 «Пішов курсом на Чигирин Світловодськ» (unknown), 04:46 «влучання РСЗВ … в Сумах» (mlrs):
    // 236 km in eleven minutes fits the 1000 km/h track ceiling (238 km), not a rocket launcher (40 km).
    const heading = event('heading', 'unknown', [
      { atMs: T, positions: [SVITLOVODSK], named: [CHYHYRYN, SVITLOVODSK] }
    ]);
    expect(chooseMergeTarget(message('mlrs', T + 11 * MINUTE, [SUMY]), [heading])).toBeNull();
  });

  it('joins artillery 30 km away, and nothing past 40 km however long after the head', () => {
    const shelling = event('shelling', 'artillery', [{ atMs: T, positions: [KRAMATORSK] }]);
    expect(chooseMergeTarget(message('artillery', T + MINUTE, [NORTH_OF_KRAMATORSK]), [shelling]))
      .toMatchObject({ eventId: 'shelling', threatType: 'artillery', basis: 'reachable' });
    // Ізюм is 55 km off, nine minutes on. The report names no class, and the event's fixed limit
    // still decides.
    expect(chooseMergeTarget(message('unknown', T + 9 * MINUTE, [IZIUM]), [shelling])).toBeNull();
  });

  it('lets a guided bomb glide 70 km, not further', () => {
    // From Оріхів: Запоріжжя is 57 km, Марганець 86 km.
    const bombs = event('bombs', 'guided_air_bomb', [{ atMs: T, positions: [ORIKHIV] }]);
    expect(chooseMergeTarget(message('guided_air_bomb', T + 2 * MINUTE, [ZAPORIZHZHIA]), [bombs]))
      .toMatchObject({ eventId: 'bombs', basis: 'reachable' });
    expect(chooseMergeTarget(message('guided_air_bomb', T + 2 * MINUTE, [MARHANETS]), [bombs])).toBeNull();
  });

  it('widens a missile event to combined only within 150 km of its head', () => {
    // «…КАБ на Запоріжжя» closing somebody else's digest, 199 km from the missile's head at Полтава:
    // inside the 217 km a 1000 km/h class covers in ten minutes, outside the widening limit.
    // Кременчук is 102 km from Полтава.
    const cruise = event('cruise', 'cruise_missile', [{ atMs: T, positions: [POLTAVA] }]);
    expect(chooseMergeTarget(message('combined', T + 5 * MINUTE, [ZAPORIZHZHIA]), [cruise])).toBeNull();
    expect(chooseMergeTarget(message('combined', T + 5 * MINUTE, [KREMENCHUK]), [cruise]))
      .toMatchObject({ eventId: 'cruise', threatType: 'combined', basis: 'reachable' });
    const ballistic = event('ballistic', 'ballistic_missile', [{ atMs: T, positions: [POLTAVA] }]);
    expect(chooseMergeTarget(message('combined', T + 2 * MINUTE, [ZAPORIZHZHIA]), [ballistic])).toBeNull();
  });
});
