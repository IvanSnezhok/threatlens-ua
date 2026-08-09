/**
 * The community aerial-alert mirror: https://ubilling.net.ua/aerialalerts/
 *
 * A tokenless HTTP snapshot of the same executive-authority air-raid state the two official APIs
 * serve, republished by a third party. Everything in this file is pure: it turns one response body
 * into the record shape `persistOfficialAlertSnapshot` already understands, or it throws. Nothing
 * here touches PostgreSQL, so the safety property this source exists to guarantee — a frozen mirror
 * must never clear the map — is testable without a database.
 *
 * ## What the feed is
 *
 * `?source=default` is an aggregator over five upstreams (`skog`, `klimenko`, `jaam`, `aiu`, `ual`)
 * and serves "whichever is most current", which is why `AERIAL_MIRROR_SOURCE_ID` gets an
 * independence group of its own and why corroboration between it and the official APIs is worth
 * close to nothing: `aiu` and `ual` ARE Alerts.in.ua and Ukraine Alarm, so on any given poll this
 * source may be one of them wearing a different hat. See `migrations/027_aerial_alert_mirror.sql`.
 *
 * ## Two payloads, two parsers
 *
 * The aggregated `states` object is oblast-only: twenty-five rows, no raion, no hromada, no Crimea.
 * The documented `?source=<x>&raw` passthrough returns the chosen upstream's NATIVE body inside the
 * same `{source, cachedat, …}` envelope, and `ual` — Ukraine Alarm — publishes all three
 * administrative levels. `parseAerialMirrorPayload` reads the aggregated shape,
 * `parseAerialMirrorRawPayload` reads the `ual` passthrough, and both hand the caller the same
 * `AerialMirrorRegion[]` so `toAlarmSnapshotBody` is the single exit. Which one runs is
 * `AERIAL_MIRROR_RAW_SOURCE`; the fallback rule between them lives in `syncAerialMirror`.
 *
 * ## Timestamps
 *
 * Both `cachedat` and `changed` are bare wall clocks with no zone — "2026-08-09 14:26:25" — printed
 * in Europe/Kyiv. `new Date('2026-08-09 14:26:25')` reads them in the *host's* zone, which is
 * Europe/Kyiv on a developer laptop and UTC in the container: the same payload would be three hours
 * old locally and three hours in the FUTURE in production, and a timestamp in the future is exactly
 * the thing that would make a frozen mirror look permanently fresh. `kyivWallClockToUtc` is
 * therefore mandatory on every timestamp this feed prints, and the future-skew branch of
 * `parseAerialMirrorPayload` is the backstop for getting it wrong anyway.
 */

/** Registry id of the mirror. Matches the row inserted by `027_aerial_alert_mirror.sql`. */
export const AERIAL_MIRROR_SOURCE_ID = 'aerial-alerts-mirror';

/** The mirror publishes air-raid state and nothing else. */
export const AERIAL_MIRROR_ALERT_TYPE = 'air_raid';

/**
 * Identifies the poller to the operator of a free, unauthenticated endpoint.
 *
 * The published limit is two requests per second per host and the scheduler polls every fifteen
 * seconds, so this deployment is three orders of magnitude inside it; the header is there so that if
 * that ever stops being true the operator can see who to contact rather than only what to block.
 */
export const AERIAL_MIRROR_USER_AGENT = 'ThreatLensUA/1.0 (+https://github.com/threatlens-ua)';

/**
 * Which Ukraine Alarm alert types this source is allowed to move.
 *
 * The `ual` passthrough carries the upstream's whole vocabulary, and three of its members were
 * observed live in a single capture: `AIR`, `ARTILLERY`, `URBAN_FIGHTS` (`CHEMICAL`, `NUCLEAR` and
 * `INFO` exist in the same enum). Only the air-raid ones are read here, and the reason is not
 * squeamishness about the others — it is that `AERIAL_MIRROR_ALERT_TYPE` is a constant. This source
 * is registered as a mover of `air_raid` state and nothing else; the artillery and street-fighting
 * declarations belong to a threat vocabulary this adapter has no mandate over, and quietly
 * promoting «загроза вуличних боїв» in Vovchansk into an air-raid siren on the public map would be
 * a lie about what the authorities declared.
 *
 * The consequence is deliberate and worth stating: an entry whose ONLY alerts are `ARTILLERY` is
 * dropped entirely, so a hromada under shelling and nothing else is not on this source's map. That
 * is correct — it is not under an air-raid alert. Observed on the capture in
 * `tests/fixtures/aerial-mirror-raw-ual.json`: three Dnipropetrovshchyna hromadas, artillery only.
 *
 * `AIR_RAID` is accepted alongside `AIR` because `alarmTypeMap` in the ingestion normalizer already
 * treats the two as synonyms and the two lists must not be able to disagree.
 */
export const AERIAL_MIRROR_AIR_TYPES: ReadonlySet<string> = new Set(['AIR', 'AIR_RAID']);

/** The `regionType` values the `ual` passthrough prints, plus a bucket for anything new. */
export type AerialMirrorLevel = 'State' | 'District' | 'Community' | 'other';

const KNOWN_LEVELS: readonly AerialMirrorLevel[] = ['State', 'District', 'Community'];

/** One region as the feed prints it. */
export interface AerialMirrorRegion {
  /** Verbatim feed label, e.g. «Вінницька область», «м. Київ», «Харківський район». */
  name: string;
  active: boolean;
  /** When the feed says this region last changed state, resolved to a real instant. */
  changedAt: Date;
  /**
   * Administrative level the upstream filed the region under, where it says so.
   *
   * Reporting only — resolution is by name, because the level is not reliable enough to key on:
   * the `ual` feed files «м. Харків та Харківська територіальна громада» as a `State`.
   */
  level?: AerialMirrorLevel;
}

export interface AerialMirrorSnapshot {
  /** The `source` field: which upstream answered this poll. Ops signal only. */
  upstream: string;
  cachedAt: Date;
  /** How far behind `now` the mirror's own cache stamp is. Negative means the feed is ahead. */
  ageSeconds: number;
  regions: AerialMirrorRegion[];
}

/** What `parseAerialMirrorRawPayload` saw, over and above the regions it kept. */
export interface AerialMirrorRawSnapshot extends AerialMirrorSnapshot {
  /** Entries in `raw[]` before any filtering — 0 means the upstream reports a quiet country. */
  entryCount: number;
  /** Of those, how many parsed into something this adapter can read at all. */
  readableCount: number;
  /** Regions KEPT, by level. The granularity upgrade, made observable. */
  byLevel: Record<AerialMirrorLevel, number>;
  /** Labels dropped because none of their active alerts was an air raid. */
  nonAirRegions: number;
  /** Duplicate labels folded away before resolution. */
  duplicateLabels: number;
}

/**
 * Raised when the payload cannot be trusted to describe the present.
 *
 * Separate from a generic parse failure because it is the one the caller must never treat as "the
 * mirror reports no alerts": both end up at `markSourceError`, but the distinction is what the
 * operator reads in `last_error`.
 */
export class AerialMirrorStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AerialMirrorStaleError';
  }
}

const KYIV_TIME_ZONE = 'Europe/Kyiv';

const kyivParts = new Intl.DateTimeFormat('en-US', {
  timeZone: KYIV_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

/** Milliseconds Kyiv wall clock runs ahead of UTC at a given instant (+2h EET, +3h EEST). */
function kyivOffsetMs(instant: Date): number {
  const parts: Record<string, number> = {};
  for (const part of kyivParts.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!
  );
  return asUtc - instant.getTime();
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Reads one «YYYY-MM-DD HH:MM:SS» Kyiv wall clock as the instant it names.
 *
 * Two passes, not one: the offset has to be sampled at the instant being converted, and the only
 * instant available to sample at first is the naive one. The first pass lands within an hour of the
 * answer, which is close enough for the second to sample the correct side of a DST boundary. Times
 * inside the one hour that repeats when the clocks go back are genuinely ambiguous in the source
 * data; the later (post-transition) reading wins, which is the conservative choice here because it
 * makes a timestamp look *older*, never fresher.
 */
export function kyivWallClockToUtc(value: string): Date | null {
  const match = WALL_CLOCK.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const naive = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)
  );
  if (Number.isNaN(naive)) return null;
  let instant = naive - kyivOffsetMs(new Date(naive));
  instant = naive - kyivOffsetMs(new Date(instant));
  const resolved = new Date(instant);
  return Number.isNaN(resolved.getTime()) ? null : resolved;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The freshness gate, shared by both parsers.
 *
 * Split out of `parseAerialMirrorPayload` when the raw passthrough arrived, because the one property
 * this source exists under — a frozen mirror must never be believed — has to hold identically on
 * both payload shapes, and the surest way to keep two copies of a safety rule in agreement is not to
 * have two copies. The envelope is the same on both: `cachedat` is a bare Europe/Kyiv wall clock.
 */
function readCachedAt(
  root: Record<string, unknown>, now: Date, staleSeconds: number
): { cachedAt: Date; ageSeconds: number } {
  const rawCachedAt = typeof root.cachedat === 'string' ? root.cachedat : '';
  if (!rawCachedAt) throw new AerialMirrorStaleError('aerial mirror response carries no `cachedat`');
  const cachedAt = kyivWallClockToUtc(rawCachedAt);
  if (!cachedAt) {
    throw new AerialMirrorStaleError(`aerial mirror \`cachedat\` is unreadable: ${rawCachedAt}`);
  }
  const ageSeconds = Math.round((now.getTime() - cachedAt.getTime()) / 1000);
  if (ageSeconds > staleSeconds) {
    throw new AerialMirrorStaleError(
      `aerial mirror is stale: cachedat ${rawCachedAt} is ${ageSeconds}s old, bound is ${staleSeconds}s`
    );
  }
  if (ageSeconds < -staleSeconds) {
    throw new AerialMirrorStaleError(
      `aerial mirror \`cachedat\` ${rawCachedAt} is ${-ageSeconds}s in the future, bound is ${staleSeconds}s`
    );
  }
  return { cachedAt, ageSeconds };
}

/**
 * Turns one mirror response into a snapshot, or throws.
 *
 * Throwing is the whole point. Every rejection below reaches `markSourceError` and leaves
 * `alert_source_states` untouched, so the alerts this source currently holds stay held. The
 * alternative — returning an empty or partial snapshot — would run the snapshot reconciler over a
 * response we have just decided we do not believe, and clear every location the mirror was holding.
 *
 * Rejected:
 *
 * - anything that is not an object with a non-empty `states` object (a truncated body — observed
 *   once during research when two requests landed inside the same second — parses as garbage or
 *   fails outright, and must not read as "no alerts anywhere");
 * - a `cachedat` that is missing or unreadable, because freshness is then unknowable;
 * - a `cachedat` older than `staleSeconds` — the frozen mirror;
 * - a `cachedat` more than `staleSeconds` in the future, which is what a zone bug or a broken
 *   upstream clock looks like, and which would otherwise make the staleness test unfailable;
 * - a `states` map in which no entry is a usable region.
 *
 * A region whose `changed` is unreadable is NOT rejected: its state is still current, and only the
 * period's start timestamp degrades. It falls back to `cachedAt`, which is the earliest instant the
 * feed can prove anything about.
 */
export function parseAerialMirrorPayload(
  body: unknown, now: Date, staleSeconds: number
): AerialMirrorSnapshot {
  const root = asObject(body);
  if (!root) throw new Error('aerial mirror response is not a JSON object');
  const states = asObject(root.states);
  if (!states) throw new Error('aerial mirror response carries no `states` object');

  const { cachedAt, ageSeconds } = readCachedAt(root, now, staleSeconds);

  const regions: AerialMirrorRegion[] = [];
  for (const [name, raw] of Object.entries(states)) {
    const region = asObject(raw);
    const label = name.trim();
    if (!region || !label) continue;
    if (typeof region.alertnow !== 'boolean') continue;
    const changed = typeof region.changed === 'string' ? kyivWallClockToUtc(region.changed) : null;
    regions.push({ name: label, active: region.alertnow, changedAt: changed ?? cachedAt });
  }
  if (!regions.length) throw new Error('aerial mirror response carries no readable regions');

  return {
    upstream: typeof root.source === 'string' ? root.source : 'unknown',
    cachedAt,
    ageSeconds,
    regions
  };
}

/**
 * The URL of the `?source=<x>&raw` passthrough for a configured base URL.
 *
 * Built through `URL` rather than by string concatenation so a base carrying its own query string —
 * or a trailing `?` — cannot produce a URL the endpoint reads as a different request. `raw` is a
 * valueless flag in the wiki's examples; `URLSearchParams` renders it as `raw=`, which was probed
 * against the live endpoint and answers identically. Anything else in the base is preserved.
 */
export function aerialMirrorRawUrl(baseUrl: string, upstream: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('source', upstream);
  url.searchParams.set('raw', '');
  return url.toString();
}

/** Milliseconds, or null when the value is not a timestamp this adapter can read. */
function isoInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function levelOf(value: unknown): AerialMirrorLevel {
  return KNOWN_LEVELS.find((level) => level === value) ?? 'other';
}

/**
 * Turns one `?source=ual&raw` response into a snapshot of everything alight, at every level.
 *
 * The envelope is the mirror's (`source`, `cachedat` as a Kyiv wall clock, and the upstream body
 * under `raw`); everything inside `raw[]` is Ukraine Alarm's own vocabulary and its own timestamps,
 * which are honest ISO-8601 with a `Z`. Both facts matter: `readCachedAt` must run on the envelope
 * and must NOT run on anything inside it.
 *
 * ## What comes out
 *
 * Only regions that are alight, because that is all the upstream lists — this payload has no
 * inactive rows to forward, unlike the aggregated `states` object. The blanket clear at the top of
 * `persistOfficialAlertSnapshot` plus `ALERT_END_DEBOUNCE_SECONDS` already give an omitted region
 * exactly the treatment an explicit `active:false` would, so nothing about ending an alert changes;
 * what is lost is the aggregated feed's incidental property that name resolution was exercised for
 * all twenty-five labels on every poll. It could not survive the upgrade in any case: the label
 * space here is the whole country's raions and hromadas, far too large to re-resolve every fifteen
 * seconds, and the unresolved-location warning still names anything new the moment it goes alight.
 *
 * ## What is refused, and what is merely empty
 *
 * Refused (throws, therefore `markSourceError`, therefore alerts held): a non-object root; the same
 * `cachedat` failures the aggregated parser refuses; a `raw` that is not an array; and a `raw` that
 * has entries of which NONE is readable — a reshaped upstream body, which must never read as peace.
 *
 * NOT refused: an empty `raw` array, and an array whose entries are all readable but carry no
 * air-raid alert. Both are what a quiet night genuinely looks like, and refusing them would make
 * this source permanently unhealthy every time the country went calm. Telling those apart from a
 * broken upstream is not something this payload can do alone, so it is not attempted here: the
 * snapshot reports `entryCount`/`readableCount` and `syncAerialMirror` cross-checks the aggregated
 * feed before believing a poll that found nothing.
 *
 * ## Dedupe
 *
 * Labels are folded before they leave, keeping the EARLIEST start among duplicates. Two shapes of
 * duplicate are real and both were present in the captured fixture: one entry listing the same
 * `AIR` alert twice, and — after the catalogue folds hromadas into their raion — a District and a
 * Community of that same District both alight (Чугуївський район with Вовчанська громада inside
 * it). This pass catches only the first; the second is invisible until a name becomes a location
 * id, so `persistOfficialAlertSnapshot` folds again after resolution. Both are needed.
 */
export function parseAerialMirrorRawPayload(
  body: unknown, now: Date, staleSeconds: number
): AerialMirrorRawSnapshot {
  const root = asObject(body);
  if (!root) throw new Error('aerial mirror raw response is not a JSON object');
  const entries = root.raw;
  if (!Array.isArray(entries)) {
    throw new Error('aerial mirror raw response carries no `raw` array');
  }

  const { cachedAt, ageSeconds } = readCachedAt(root, now, staleSeconds);

  const byLabel = new Map<string, AerialMirrorRegion>();
  const byLevel: Record<AerialMirrorLevel, number> = {
    State: 0, District: 0, Community: 0, other: 0
  };
  let readableCount = 0;
  let nonAirRegions = 0;
  let duplicateLabels = 0;

  for (const raw of entries) {
    const entry = asObject(raw);
    if (!entry) continue;
    const name = typeof entry.regionName === 'string' ? entry.regionName.replace(/\s+/gu, ' ').trim() : '';
    const alerts = entry.activeAlerts;
    // A region with no name, or with no `activeAlerts` array at all, is not this payload's shape.
    // An EMPTY array is: the upstream is entitled to list a region and report nothing about it.
    if (!name || !Array.isArray(alerts)) continue;
    readableCount += 1;

    let startedAt: Date | null = null;
    for (const alertRaw of alerts) {
      const alert = asObject(alertRaw);
      if (!alert) continue;
      const type = typeof alert.type === 'string' ? alert.type.trim().toUpperCase() : '';
      if (!AERIAL_MIRROR_AIR_TYPES.has(type)) continue;
      const at = isoInstant(alert.lastUpdate) ?? isoInstant(entry.lastUpdate);
      // Earliest wins: the same air raid listed twice, or an entry whose region-level stamp is older
      // than the alert's, should date the period from the first moment the feed can prove.
      if (at && (!startedAt || at < startedAt)) startedAt = at;
      else if (!startedAt) startedAt = cachedAt;
    }
    if (!startedAt) { nonAirRegions += 1; continue; }

    const key = name.toLocaleLowerCase('uk-UA');
    const existing = byLabel.get(key);
    if (existing) {
      duplicateLabels += 1;
      if (startedAt < existing.changedAt) existing.changedAt = startedAt;
      continue;
    }
    const level = levelOf(entry.regionType);
    byLevel[level] += 1;
    byLabel.set(key, { name, active: true, changedAt: startedAt, level });
  }

  if (entries.length > 0 && readableCount === 0) {
    throw new Error('aerial mirror raw response carries no readable entries');
  }

  return {
    upstream: typeof root.source === 'string' ? root.source : 'unknown',
    cachedAt,
    ageSeconds,
    regions: [...byLabel.values()],
    entryCount: entries.length,
    readableCount,
    byLevel,
    nonAirRegions,
    duplicateLabels
  };
}

/**
 * Re-shapes a snapshot into the body `normalizeAlarmResponse` already reads.
 *
 * Going through that function rather than around it keeps one normalizer on the snapshot path: the
 * mirror gets the same `alertType` mapping (`AIR` → `air_raid`) and the same `externalId`
 * construction as Ukraine Alarm, and a future change to either applies to all three adapters.
 *
 * No type is emitted per region, so `alarmTypeMap`'s `AIR` default applies to every row. That is the
 * whole of the type decision on this path: `parseAerialMirrorRawPayload` has already dropped
 * everything that was not an air raid, so what reaches here is air-raid state by construction and
 * `AERIAL_MIRROR_ALERT_TYPE` stays the only alert type this source can ever move.
 *
 * **Every** region of the AGGREGATED feed is emitted, including the inactive ones, which is the
 * difference between it and the official APIs — they return only what is alight. (The raw
 * passthrough has no inactive rows to emit; see `parseAerialMirrorRawPayload`.) Two reasons. Name
 * resolution is then exercised for all twenty-five labels on every poll, so a relabelled region shows up
 * in the unresolved-location warning immediately instead of on the day it first goes under alert;
 * and `persistOfficialAlertSnapshot`'s "no provider locations matched" guard becomes a statement
 * about the whole feed rather than about however many regions happen to be alight. The inactive rows
 * cost nothing in behaviour: the blanket clear at the top of the snapshot has already stamped
 * `missing_since` on anything that was holding, and re-stating a region as inactive preserves it, so
 * an all-clear from the mirror is still held for `ALERT_END_DEBOUNCE_SECONDS` exactly like silence.
 * That debounce is wanted here and not merely tolerated: `?source=default` switches upstream between
 * polls, and a switch that lands mid-transition must not be able to publish «Офіційний відбій».
 */
export function toAlarmSnapshotBody(snapshot: AerialMirrorSnapshot): unknown {
  return {
    states: snapshot.regions.map((region) => ({
      regionName: region.name,
      active: region.active,
      startedAt: region.changedAt.toISOString()
    }))
  };
}
