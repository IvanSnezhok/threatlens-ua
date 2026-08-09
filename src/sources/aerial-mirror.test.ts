import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AERIAL_MIRROR_SOURCE_ID, AerialMirrorStaleError, kyivWallClockToUtc,
  parseAerialMirrorPayload, toAlarmSnapshotBody
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
