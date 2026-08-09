import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AERIAL_MIRROR_AIR_TYPES, AERIAL_MIRROR_SOURCE_ID, AerialMirrorStaleError, aerialMirrorRawUrl,
  kyivWallClockToUtc, parseAerialMirrorPayload, parseAerialMirrorRawPayload, toAlarmSnapshotBody
} from './aerial-mirror.js';
import { normalizeAlarmResponse } from '../services/ingestion.js';

/**
 * The community aerial-alert mirror's parser, driven against a real captured response.
 *
 * `tests/fixtures/aerial-mirror-snapshot.json` is verbatim output of
 * https://ubilling.net.ua/aerialalerts/ captured on 2026-08-09, not a hand-written sample — the
 * feed's quirks are the point. It prints its own cache stamp and every change time as a bare Kyiv
 * wall clock with no zone, it names Kyiv city «м. Київ» while everything else is «<X>ська область»,
 * and it carries no row at all for Crimea or Sevastopol.
 *
 * The property this file exists to pin is the last one in `describe('staleness')`: a mirror that
 * freezes must be refused, not believed. Everything a snapshot source reports is authoritative over
 * what it stops reporting, so «every region is quiet» from a dead mirror is indistinguishable from
 * peace unless the freshness stamp is checked first — and the check has to happen here, before any
 * database work, which is why the parser throws instead of returning a flag for a caller to forget.
 */

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/aerial-mirror-snapshot.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

/** The instant the fixture was captured: `cachedat` 2026-08-09 14:26:25 Kyiv = 11:26:25Z. */
const CAPTURED_AT = new Date('2026-08-09T11:26:25.000Z');
const STALE_SECONDS = 300;

/** The seven regions alight in the captured response. */
const ACTIVE_IN_FIXTURE = [
  'Дніпропетровська область', 'Донецька область', 'Запорізька область', 'Луганська область',
  'Сумська область', 'Харківська область', 'Чернігівська область'
];

function parse(body: unknown = FIXTURE, now: Date = CAPTURED_AT, bound = STALE_SECONDS) {
  return parseAerialMirrorPayload(body, now, bound);
}

/** The fixture with `cachedat` moved, which is the only way to simulate age. */
function withCachedAt(cachedat: unknown): Record<string, unknown> {
  return { ...FIXTURE, cachedat };
}

describe('kyivWallClockToUtc', () => {
  // The bug this guards is silent and environment-dependent: `new Date('2026-08-09 14:26:25')` is
  // 11:26:25Z on a laptop set to Europe/Kyiv and 14:26:25Z in the UTC container, so the same payload
  // is either correct or three hours in the FUTURE depending on where it runs — and a future stamp
  // is precisely what makes a frozen mirror look eternally fresh.
  it('reads a summer wall clock as EEST (UTC+3)', () => {
    expect(kyivWallClockToUtc('2026-08-09 14:26:25')?.toISOString())
      .toBe('2026-08-09T11:26:25.000Z');
  });

  it('reads a winter wall clock as EET (UTC+2)', () => {
    expect(kyivWallClockToUtc('2026-01-15 14:26:25')?.toISOString())
      .toBe('2026-01-15T12:26:25.000Z');
  });

  it('does not depend on the host time zone', () => {
    // Whatever TZ the runner has, the answer is fixed by Europe/Kyiv. Asserting the offset rather
    // than re-deriving it is the point: a re-derivation would reproduce the bug.
    const summer = kyivWallClockToUtc('2026-07-01 12:00:00')!;
    const winter = kyivWallClockToUtc('2026-12-01 12:00:00')!;
    expect(summer.getTime() - Date.UTC(2026, 6, 1, 12, 0, 0)).toBe(-3 * 3600_000);
    expect(winter.getTime() - Date.UTC(2026, 11, 1, 12, 0, 0)).toBe(-2 * 3600_000);
  });

  it('accepts the ISO "T" separator and rejects anything that is not a wall clock', () => {
    expect(kyivWallClockToUtc('2026-08-09T14:26:25')?.toISOString()).toBe('2026-08-09T11:26:25.000Z');
    for (const bad of ['', 'not a date', '2026-08-09', '09.08.2026 14:26:25', '2026-08-09 14:26']) {
      expect(kyivWallClockToUtc(bad), bad).toBeNull();
    }
  });
});

describe('parseAerialMirrorPayload', () => {
  it('reads every region of the captured response', () => {
    const snapshot = parse();
    expect(snapshot.regions).toHaveLength(25);
    expect(snapshot.upstream).toBe('Mørk Skogen API (default)');
    expect(snapshot.cachedAt.toISOString()).toBe('2026-08-09T11:26:25.000Z');
    expect(snapshot.ageSeconds).toBe(0);
    expect(snapshot.regions.filter((region) => region.active).map((region) => region.name).sort())
      .toEqual([...ACTIVE_IN_FIXTURE].sort());
  });

  it('covers the twenty-four oblasts and Kyiv city, and nothing else', () => {
    const names = parse().regions.map((region) => region.name);
    expect(names.filter((name) => name.endsWith(' область'))).toHaveLength(24);
    expect(names).toContain('м. Київ');
    // Not an oversight to be worked around: the feed carries no row for either, so the mirror can
    // neither raise nor clear an alert there. Anything that starts asserting Crimean alert state
    // from this source is reading a region that does not exist in the payload.
    expect(names).not.toContain('АР Крим');
    expect(names.some((name) => name.includes('Севастополь'))).toBe(false);
    expect(names.some((name) => name.includes('Крим'))).toBe(false);
  });

  it('resolves each region\'s own change time from Kyiv local time', () => {
    const luhansk = parse().regions.find((region) => region.name === 'Луганська область')!;
    // The feed still reports the alert that began 2022-04-04 19:45:39 Kyiv (EEST, +3).
    expect(luhansk.active).toBe(true);
    expect(luhansk.changedAt.toISOString()).toBe('2022-04-04T16:45:39.000Z');
  });

  it('falls back to the cache stamp when a region\'s change time is unreadable', () => {
    // Degrading one period's start beats discarding a region whose CURRENT state is perfectly
    // readable — `alertnow` is the fact that moves the map, `changed` only dates it.
    const body = withCachedAt(FIXTURE.cachedat);
    body.states = { 'Сумська область': { alertnow: true, changed: 'yesterday afternoon' } };
    const region = parse(body).regions[0]!;
    expect(region.active).toBe(true);
    expect(region.changedAt.toISOString()).toBe('2026-08-09T11:26:25.000Z');
  });
});

describe('staleness — the frozen mirror must never be believed', () => {
  it('accepts a response inside the bound', () => {
    const snapshot = parse(FIXTURE, new Date(CAPTURED_AT.getTime() + 299_000));
    expect(snapshot.ageSeconds).toBe(299);
    expect(snapshot.regions).toHaveLength(25);
  });

  it('refuses a cachedat older than the bound', () => {
    expect(() => parse(FIXTURE, new Date(CAPTURED_AT.getTime() + 301_000)))
      .toThrow(AerialMirrorStaleError);
    expect(() => parse(FIXTURE, new Date(CAPTURED_AT.getTime() + 301_000)))
      .toThrow(/stale: cachedat .* is 301s old, bound is 300s/);
  });

  /**
   * The whole reason this source has a parser rather than a `JSON.parse`.
   *
   * A mirror whose upstream has died keeps answering 200 with a structurally perfect body in which
   * every `alertnow` is false. Fed to `persistOfficialAlertSnapshot` that clears every location the
   * source holds and publishes «Офіційний відбій» for the entire country — during an attack, on the
   * strength of a process that stopped hours ago. The refusal has to be a throw: a throw reaches
   * `markSourceError` and leaves `alert_source_states` unopened, so the alerts stay held.
   */
  it('refuses a frozen all-quiet payload rather than reading it as peace', () => {
    const frozen = withCachedAt('2026-08-09 09:00:00');
    frozen.states = Object.fromEntries(
      Object.keys(FIXTURE.states as object).map((name) => [name, { alertnow: false, changed: '2026-08-09 08:59:00' }])
    );
    // Structurally flawless, and it would clear all twenty-five regions.
    expect(Object.values(frozen.states as Record<string, { alertnow: boolean }>)
      .every((region) => !region.alertnow)).toBe(true);
    expect(() => parse(frozen)).toThrow(AerialMirrorStaleError);
    // 09:00:00 Kyiv is 06:00:00Z; the fixture was captured at 11:26:25Z, so the freeze is 5h26m25s.
    expect(() => parse(frozen)).toThrow(/is 19585s old/);
  });

  it('refuses a cachedat far in the future, which is what a zone bug looks like', () => {
    // Without this branch a clock three hours ahead — exactly the bug a naive `new Date()` on a
    // zone-less Kyiv stamp produces in a UTC container — reports a negative age and passes the
    // staleness test forever.
    expect(() => parse(FIXTURE, new Date(CAPTURED_AT.getTime() - 301_000)))
      .toThrow(/301s in the future/);
    // Ordinary skew inside the bound is tolerated rather than treated as an outage.
    expect(parse(FIXTURE, new Date(CAPTURED_AT.getTime() - 30_000)).ageSeconds).toBe(-30);
  });

  it('refuses a missing or unreadable cachedat, because freshness is then unknowable', () => {
    const missing = { ...FIXTURE };
    delete missing.cachedat;
    expect(() => parse(missing)).toThrow(/carries no `cachedat`/);
    expect(() => parse(withCachedAt('2026-08-09'))).toThrow(/unreadable/);
    expect(() => parse(withCachedAt(1_754_738_785))).toThrow(/carries no `cachedat`/);
  });
});

describe('malformed payloads never read as an empty snapshot', () => {
  // A truncated body was observed once during research, when two requests landed inside the same
  // second and the endpoint's 2 rps limit cut the response short. Every shape below has to reach the
  // caller as a throw; the one outcome that must never happen is a snapshot with zero active regions.
  it.each([
    ['null', null],
    ['a JSON array', [{ 'Сумська область': { alertnow: true } }]],
    ['a string', '{"states":'],
    ['an object with no states', { source: 'x', cachedat: '2026-08-09 14:26:25' }],
    ['states as an array', { cachedat: '2026-08-09 14:26:25', states: [] }]
  ])('refuses %s', (_label, body) => {
    expect(() => parse(body)).toThrow();
  });

  it('refuses a states object in which no entry is a usable region', () => {
    // `alertnow` missing or non-boolean means the region's state is unknown, not false.
    expect(() => parse(withStates({ 'Сумська область': { changed: '2026-08-09 14:00:00' } })))
      .toThrow(/no readable regions/);
    expect(() => parse(withStates({ 'Сумська область': { alertnow: 'true' } })))
      .toThrow(/no readable regions/);
    expect(() => parse(withStates({ 'Сумська область': null }))).toThrow(/no readable regions/);
  });

  it('drops an unusable region but keeps the readable ones', () => {
    const snapshot = parse(withStates({
      'Сумська область': { alertnow: true, changed: '2026-08-09 14:00:00' },
      'Полтавська область': { alertnow: 'yes' }
    }));
    expect(snapshot.regions.map((region) => region.name)).toEqual(['Сумська область']);
  });

  function withStates(states: unknown): Record<string, unknown> {
    return { ...FIXTURE, states };
  }
});

describe('toAlarmSnapshotBody', () => {
  it('feeds the shared normalizer, typed as an air raid', () => {
    // Reusing `normalizeAlarmResponse` is what keeps one normalizer on the snapshot path: the mirror
    // gets the same alert-type mapping and the same externalId construction as Ukraine Alarm.
    const normalized = normalizeAlarmResponse(toAlarmSnapshotBody(parse()));
    expect(normalized.records).toHaveLength(25);
    expect([...new Set(normalized.records.map((record) => record.alertType))]).toEqual(['air_raid']);
    expect(normalized.records.map((record) => record.locationName)).toContain('м. Київ');
  });

  it('emits inactive regions too, not only the ones alight', () => {
    // The official APIs return only what is alight; this one returns the whole country, and all of
    // it is forwarded. That is what exercises name resolution for all twenty-five labels on every
    // poll, so a relabelled region surfaces in the unresolved warning immediately rather than on the
    // day it first goes under alert. It costs nothing in behaviour: the snapshot's blanket clear has
    // already stamped `missing_since` on anything that was holding, so an explicit all-clear is
    // still debounced exactly like silence.
    const normalized = normalizeAlarmResponse(toAlarmSnapshotBody(parse()));
    expect(normalized.records.filter((record) => record.active)).toHaveLength(7);
    expect(normalized.records.filter((record) => !record.active)).toHaveLength(18);
  });

  it('carries each region\'s change time through as the provider start', () => {
    const records = normalizeAlarmResponse(toAlarmSnapshotBody(parse())).records;
    const luhansk = records.find((record) => record.locationName === 'Луганська область')!;
    expect(luhansk.startedAt.toISOString()).toBe('2022-04-04T16:45:39.000Z');
  });

  it('gives the source a stable registry id', () => {
    expect(AERIAL_MIRROR_SOURCE_ID).toBe('aerial-alerts-mirror');
  });
});

// ================================================================================================
// The `?source=ual&raw` passthrough — the granularity upgrade
// ================================================================================================

/**
 * `tests/fixtures/aerial-mirror-raw-ual.json` is verbatim output of
 * https://ubilling.net.ua/aerialalerts/?source=ual&raw captured on 2026-08-09 at 20:31:23 Kyiv,
 * unedited and unredacted. It was chosen out of several probes because one live capture happens to
 * contain every case this parser has to get right:
 *
 *   - all three `regionType` values — 3 `State`, 26 `District`, 5 `Community`;
 *   - the upstream's non-air vocabulary, `ARTILLERY` and `URBAN_FIGHTS`, both of which this source
 *     must ignore, and three Dnipropetrovshchyna hromadas that carry NOTHING else, so ignoring them
 *     means dropping the entry outright;
 *   - «Липецька територіальна громада» listing the same `AIR` alert twice;
 *   - two Communities whose catalogue home is a raion that is ALSO listed as a District in the same
 *     payload (Вовчанська → Чугуївський, Липецька → Харківський) — the duplicate that survives this
 *     parser and is folded later, after resolution;
 *   - two `State` entries that are not oblasts at all: «Автономна Республіка Крим», which the
 *     aggregated feed does not carry in any form, and «м. Харків та Харківська територіальна
 *     громада», which is a city the upstream files at state level.
 *
 * The envelope stamps are the mirror's Kyiv wall clocks; everything inside `raw[]` is Ukraine
 * Alarm's own ISO-8601 with a `Z`, and mixing the two conventions up is the bug this file guards.
 */
const RAW_FIXTURE = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/aerial-mirror-raw-ual.json', import.meta.url), 'utf8')
) as { source: string; cachedat: string; raw: Array<Record<string, unknown>> };

/** `cachedat` 2026-08-09 20:31:23 Kyiv (EEST, +3) = 17:31:23Z. */
const RAW_CAPTURED_AT = new Date('2026-08-09T17:31:23.000Z');

function parseRaw(body: unknown = RAW_FIXTURE, now: Date = RAW_CAPTURED_AT, bound = STALE_SECONDS) {
  return parseAerialMirrorRawPayload(body, now, bound);
}

/** An envelope with a fresh stamp around an arbitrary `raw` list. */
function withRaw(raw: unknown, cachedat: string = RAW_FIXTURE.cachedat): Record<string, unknown> {
  return { source: 'ukrainealarm.com API', cachedat, raw };
}

/** One `raw[]` entry, spelled the way the upstream spells them. */
function entry(
  regionName: string, regionType: string, types: string[], lastUpdate = '2026-08-09T17:00:00Z'
): Record<string, unknown> {
  return {
    regionId: '1', regionType, regionName, regionEngName: '', lastUpdate,
    activeAlerts: types.map((type) => ({ regionId: '1', regionType, type, lastUpdate }))
  };
}

describe('aerialMirrorRawUrl', () => {
  it('builds the passthrough URL for the configured base', () => {
    expect(aerialMirrorRawUrl('https://ubilling.net.ua/aerialalerts/', 'ual'))
      .toBe('https://ubilling.net.ua/aerialalerts/?source=ual&raw=');
  });

  it('preserves anything already on the base URL rather than concatenating a second query string', () => {
    // The failure this prevents is silent: `base + '?source=…'` against a base that already carries
    // `?x=1` produces a URL the endpoint reads as a different request, and the poll would quietly
    // answer with something other than the passthrough.
    expect(aerialMirrorRawUrl('https://mirror.test/alerts?x=1', 'klimenko'))
      .toBe('https://mirror.test/alerts?x=1&source=klimenko&raw=');
    // `raw=` and a bare `raw` are the same request to this endpoint — probed against the live one.
    expect(aerialMirrorRawUrl('https://mirror.test/alerts?source=old', 'ual'))
      .toBe('https://mirror.test/alerts?source=ual&raw=');
  });
});

describe('parseAerialMirrorRawPayload — three levels out of one capture', () => {
  it('reads every air-raid region of the captured response, at every level', () => {
    const snapshot = parseRaw();
    expect(snapshot.upstream).toBe('ukrainealarm.com API');
    expect(snapshot.cachedAt.toISOString()).toBe('2026-08-09T17:31:23.000Z');
    expect(snapshot.ageSeconds).toBe(0);
    expect(snapshot.entryCount).toBe(34);
    expect(snapshot.readableCount).toBe(34);
    // 34 entries − 3 artillery-only hromadas = 31 labels alight for an air raid.
    expect(snapshot.regions).toHaveLength(31);
    expect(snapshot.byLevel).toEqual({ State: 3, District: 26, Community: 2, other: 0 });
    expect(snapshot.nonAirRegions).toBe(3);
    // Every region the upstream lists is alight; this payload has no inactive rows at all.
    expect(snapshot.regions.every((region) => region.active)).toBe(true);
  });

  it('carries raion and hromada labels the aggregated feed cannot express', () => {
    const names = parseRaw().regions.map((region) => region.name);
    // The whole point of the upgrade: before this, «Харківська область» was the finest thing this
    // source could say, and it said it about the entire oblast.
    expect(names).toContain('Харківський район');
    expect(names).toContain('Чугуївський район');
    expect(names).toContain('Вовчанська територіальна громада');
    // And a region the aggregated twenty-five-row feed carries no row for in any state.
    expect(names).toContain('Автономна Республіка Крим');
    expect(Object.keys(FIXTURE.states as object)).not.toContain('Автономна Республіка Крим');
  });

  it('ignores every alert type that is not an air raid', () => {
    // ARTILLERY and URBAN_FIGHTS are real declarations and they are real in this capture. They are
    // simply not this source's to move: it is registered as a mover of `air_raid` and nothing else,
    // and a shelling warning rendered as an air-raid siren would misstate what was declared.
    const names = parseRaw().regions.map((region) => region.name);
    for (const artilleryOnly of [
      'Червоногригорівська територіальна громада',
      'Покровська територіальна громада',
      'м. Марганець та Марганецька територіальна громада'
    ]) {
      expect(names, artilleryOnly).not.toContain(artilleryOnly);
    }
    // Вовчанська carries ARTILLERY and URBAN_FIGHTS *and* AIR, so it is kept — for the AIR alone.
    expect(names).toContain('Вовчанська територіальна громада');
  });

  it('keeps a region that carries an air raid alongside types it ignores', () => {
    const snapshot = parseRaw(withRaw([
      entry('Тестовий район', 'District', ['ARTILLERY', 'AIR', 'URBAN_FIGHTS'])
    ]));
    expect(snapshot.regions.map((region) => region.name)).toEqual(['Тестовий район']);
    expect(snapshot.nonAirRegions).toBe(0);
  });

  it.each([
    ['ARTILLERY'], ['URBAN_FIGHTS'], ['CHEMICAL'], ['NUCLEAR'], ['INFO'], ['UNKNOWN']
  ])('drops a region whose only alert is %s', (type) => {
    const snapshot = parseRaw(withRaw([entry('Тестовий район', 'District', [type])]));
    expect(snapshot.regions).toEqual([]);
    expect(snapshot.nonAirRegions).toBe(1);
    expect(snapshot.readableCount).toBe(1);
  });

  it('accepts AIR_RAID as a synonym of AIR, because the shared normalizer does', () => {
    expect([...AERIAL_MIRROR_AIR_TYPES].sort()).toEqual(['AIR', 'AIR_RAID']);
    const snapshot = parseRaw(withRaw([entry('Тестовий район', 'District', ['air_raid'])]));
    expect(snapshot.regions).toHaveLength(1);
  });

  it('reads the alert timestamps as ISO instants, not as Kyiv wall clocks', () => {
    // The two conventions live in one document: `cachedat` is a bare Kyiv wall clock, every
    // `lastUpdate` inside `raw[]` is ISO-8601 with a `Z`. Running `kyivWallClockToUtc` over an
    // instant that already carries its zone would shift every alert start by two or three hours.
    const luhansk = parseRaw().regions.find((region) => region.name === 'Луганська область')!;
    expect(luhansk.changedAt.toISOString()).toBe('2022-04-04T16:45:00.000Z');
    // Same alert, as the aggregated feed prints it: «2022-04-04 19:45:39» Kyiv — the same instant.
    expect(kyivWallClockToUtc('2022-04-04 19:45:39')!.getTime() - luhansk.changedAt.getTime())
      .toBe(39_000);
  });

  it('dates a region from the EARLIEST air raid it lists', () => {
    // «Липецька територіальна громада» lists AIR twice in the capture. Two stamps for one fact, and
    // the period started at the first of them.
    const snapshot = parseRaw(withRaw([{
      ...entry('Тестовий район', 'District', []),
      activeAlerts: [
        { type: 'AIR', lastUpdate: '2026-08-09T17:20:00Z' },
        { type: 'AIR', lastUpdate: '2026-08-09T16:05:00Z' }
      ]
    }]));
    expect(snapshot.regions[0]!.changedAt.toISOString()).toBe('2026-08-09T16:05:00.000Z');
  });

  it('falls back through the entry stamp to the cache stamp when an alert has no readable time', () => {
    const noAlertTime = parseRaw(withRaw([{
      regionName: 'Тестовий район', regionType: 'District', lastUpdate: '2026-08-09T12:00:00Z',
      activeAlerts: [{ type: 'AIR', lastUpdate: 'вчора' }]
    }]));
    expect(noAlertTime.regions[0]!.changedAt.toISOString()).toBe('2026-08-09T12:00:00.000Z');

    const noTimeAtAll = parseRaw(withRaw([{
      regionName: 'Тестовий район', regionType: 'District', activeAlerts: [{ type: 'AIR' }]
    }]));
    // Degrading the period start beats discarding a region whose CURRENT state is perfectly clear.
    expect(noTimeAtAll.regions[0]!.changedAt.toISOString()).toBe('2026-08-09T17:31:23.000Z');
  });

  it('folds a label the upstream lists twice, keeping the earlier start', () => {
    const snapshot = parseRaw(withRaw([
      entry('Харківський район', 'District', ['AIR'], '2026-08-09T17:20:00Z'),
      entry('харківський  район', 'Community', ['AIR'], '2026-08-09T15:00:00Z')
    ]));
    expect(snapshot.regions).toHaveLength(1);
    expect(snapshot.duplicateLabels).toBe(1);
    expect(snapshot.regions[0]!.changedAt.toISOString()).toBe('2026-08-09T15:00:00.000Z');
    // The level is the first one seen; it is reporting only, and resolution never reads it.
    expect(snapshot.byLevel).toEqual({ State: 0, District: 1, Community: 0, other: 0 });
  });

  it('buckets an unknown regionType rather than dropping the region', () => {
    // A new level upstream must reach the map, not vanish. `other` above zero is the signal that the
    // vocabulary has grown.
    const snapshot = parseRaw(withRaw([entry('Тестова область', 'Settlement', ['AIR'])]));
    expect(snapshot.regions).toHaveLength(1);
    expect(snapshot.byLevel.other).toBe(1);
  });
});

describe('the raw passthrough distinguishes quiet from broken — as far as one payload can', () => {
  /**
   * The asymmetry this whole feature turns on.
   *
   * An empty `raw` list is what a calm night looks like AND what a half-dead upstream looks like.
   * This parser refuses to guess: it accepts both and reports what it saw, because the alternative —
   * throwing on empty — would put the source into `error` every time the country was at peace, and
   * an operator who sees `error` on every quiet night stops reading the health card at all.
   *
   * `syncAerialMirror` is where the guess is made, with the aggregated feed as a second witness.
   * Everything below is only about what this function is allowed to decide alone.
   */
  it('accepts an empty raw list as a legitimate quiet night', () => {
    const snapshot = parseRaw(withRaw([]));
    expect(snapshot.regions).toEqual([]);
    expect(snapshot.entryCount).toBe(0);
    expect(snapshot.readableCount).toBe(0);
    expect(snapshot.cachedAt.toISOString()).toBe('2026-08-09T17:31:23.000Z');
  });

  it('accepts a list in which everything alight is a type this source ignores', () => {
    // Also quiet, for air raids. Three hromadas under shelling is not an air-raid alert anywhere.
    const snapshot = parseRaw(withRaw([
      entry('Червоногригорівська територіальна громада', 'Community', ['ARTILLERY']),
      entry('Покровська територіальна громада', 'Community', ['ARTILLERY'])
    ]));
    expect(snapshot.regions).toEqual([]);
    expect(snapshot.entryCount).toBe(2);
    expect(snapshot.readableCount).toBe(2);
    expect(snapshot.nonAirRegions).toBe(2);
  });

  it('refuses a list whose entries are all unreadable, which is a reshaped upstream', () => {
    // The difference from the two cases above: here the upstream IS saying something and this
    // adapter cannot read it. Believed as "nothing alight", it clears every raion the mirror holds.
    expect(() => parseRaw(withRaw([{ region: 'Сумський район', alerts: ['AIR'] }])))
      .toThrow(/no readable entries/);
    expect(() => parseRaw(withRaw(['Сумський район', 42, null]))).toThrow(/no readable entries/);
    // No `activeAlerts` array at all is not this payload's shape either.
    expect(() => parseRaw(withRaw([{ regionName: 'Сумський район', regionType: 'District' }])))
      .toThrow(/no readable entries/);
  });

  it('keeps the readable entries when only some are malformed', () => {
    const snapshot = parseRaw(withRaw([
      entry('Сумський район', 'District', ['AIR']),
      { regionName: '', regionType: 'District', activeAlerts: [{ type: 'AIR' }] },
      null
    ]));
    expect(snapshot.regions.map((region) => region.name)).toEqual(['Сумський район']);
    expect(snapshot.entryCount).toBe(3);
    expect(snapshot.readableCount).toBe(1);
  });

  it.each([
    ['null', null],
    ['a bare array', [{ regionName: 'Сумський район' }]],
    ['a string', '{"raw":'],
    ['an envelope with no raw', { source: 'ukrainealarm.com API', cachedat: '2026-08-09 20:31:23' }],
    ['raw as an object', { cachedat: '2026-08-09 20:31:23', raw: { '0': {} } }],
    ['the aggregated body', { cachedat: '2026-08-09 20:31:23', states: {} }]
  ])('refuses %s', (_label, body) => {
    expect(() => parseRaw(body)).toThrow();
  });

  it('applies the same freshness gate as the aggregated parser, on the same envelope', () => {
    // One `readCachedAt`, two parsers. The safety rule cannot drift between the two payload shapes
    // because there is only one copy of it.
    expect(() => parseRaw(RAW_FIXTURE, new Date(RAW_CAPTURED_AT.getTime() + 301_000)))
      .toThrow(AerialMirrorStaleError);
    expect(() => parseRaw(RAW_FIXTURE, new Date(RAW_CAPTURED_AT.getTime() + 301_000)))
      .toThrow(/stale: cachedat .* is 301s old, bound is 300s/);
    expect(() => parseRaw(RAW_FIXTURE, new Date(RAW_CAPTURED_AT.getTime() - 301_000)))
      .toThrow(/301s in the future/);
    expect(() => parseRaw(withRaw([], '2026-08-09'))).toThrow(/unreadable/);
    const missing = { source: 'x', raw: [] };
    expect(() => parseRaw(missing)).toThrow(/carries no `cachedat`/);
    // Inside the bound it is accepted, exactly like the aggregated one.
    expect(parseRaw(RAW_FIXTURE, new Date(RAW_CAPTURED_AT.getTime() + 299_000)).ageSeconds).toBe(299);
  });

  it('refuses a FROZEN empty payload — the freshness gate outranks the quiet reading', () => {
    // The order matters and this pins it: an empty `raw` under a stale stamp is refused as stale,
    // never accepted as peace. Only a FRESH empty list is a candidate for "the country is quiet",
    // and even then `syncAerialMirror` still asks the aggregated feed.
    expect(() => parseRaw(withRaw([], '2026-08-09 15:00:00'))).toThrow(AerialMirrorStaleError);
  });
});

describe('the raw snapshot goes through the same normalizer as everything else', () => {
  it('produces air_raid records for every level, with no type of its own', () => {
    const normalized = normalizeAlarmResponse(toAlarmSnapshotBody(parseRaw()));
    expect(normalized.records).toHaveLength(31);
    expect([...new Set(normalized.records.map((record) => record.alertType))]).toEqual(['air_raid']);
    expect(normalized.records.every((record) => record.active)).toBe(true);
    const names = normalized.records.map((record) => record.locationName);
    expect(names).toContain('Сумський район');
    expect(names).toContain('Вовчанська територіальна громада');
  });

  it('emits no location key, so an upstream region id can never be read as a catalogue code', () => {
    // Ukraine Alarm's `regionId` is a small integer in its own namespace — "16", "1313". Forwarding
    // it would put it into `resolveLocationId`'s `id OR official_code` probe, where a collision with
    // a catalogue code is a silent mis-resolution rather than an error. Names only, as before.
    const normalized = normalizeAlarmResponse(toAlarmSnapshotBody(parseRaw()));
    expect(normalized.records.every((record) => record.locationKey === '')).toBe(true);
  });

  it('carries each region\'s air-raid start through as the provider start', () => {
    const records = normalizeAlarmResponse(toAlarmSnapshotBody(parseRaw())).records;
    const crimea = records.find((record) => record.locationName === 'Автономна Республіка Крим')!;
    expect(crimea.startedAt.toISOString()).toBe('2022-12-10T22:22:00.000Z');
  });
});
