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

/** One region as the feed prints it. */
export interface AerialMirrorRegion {
  /** Verbatim feed label, e.g. «Вінницька область», «м. Київ». */
  name: string;
  active: boolean;
  /** When the feed says this region last changed state, resolved to a real instant. */
  changedAt: Date;
}

export interface AerialMirrorSnapshot {
  /** The `source` field: which upstream answered this poll. Ops signal only. */
  upstream: string;
  cachedAt: Date;
  /** How far behind `now` the mirror's own cache stamp is. Negative means the feed is ahead. */
  ageSeconds: number;
  regions: AerialMirrorRegion[];
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
 * Re-shapes a snapshot into the body `normalizeAlarmResponse` already reads.
 *
 * Going through that function rather than around it keeps one normalizer on the snapshot path: the
 * mirror gets the same `alertType` mapping (`AIR` → `air_raid`) and the same `externalId`
 * construction as Ukraine Alarm, and a future change to either applies to all three adapters.
 *
 * **Every** region is emitted, including the inactive ones, which is the difference between this
 * feed and the official APIs — they return only what is alight. Two reasons. Name resolution is
 * then exercised for all twenty-five labels on every poll, so a relabelled or added region shows up
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
