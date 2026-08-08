import { createHash } from 'node:crypto';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { THREAT_VALIDITY_MS } from '../repositories/events.js';
import { ALERT_CHANNEL_ADAPTER_TYPE, MONITOR_ADAPTER_TYPE, processMessage } from './ingestion.js';

/**
 * ================================================================================================
 * Catch-up backfill for the classifier Telegram sources
 * ================================================================================================
 *
 * After a restart or a long disconnect the collector resumes at the live edge of every channel it
 * subscribes to; everything published while the process was down is simply never seen. The official
 * alert channels already close that gap in `src/sources/telegram.ts`, but they close it by folding a
 * window down to **one terminal state per location** — correct for a channel that publishes states
 * («тривога почалася», «відбій»), and meaningless for a monitoring channel, whose messages are
 * events. Two hundred posts about drone courses do not fold into anything.
 *
 * So this is a second, separate loop, and the separation is structural rather than conventional:
 * {@link BackfillPort.routes} yields classifier routes only, nothing in this file imports
 * `teleproto` or `src/sources/telegram.ts`, and `ALERT_CHANNEL_BACKFILL_*` is untouched. An official
 * alert can never be started, ended or influenced by anything below.
 *
 * ## The three properties that make a replay safe
 *
 *  1. **The cursor is derived, not written.** It is `max(published_at)` over `source_messages` for
 *     that source — the archive itself. The hot path gains zero writes, a message that threw is not
 *     marked as done, and a rerun of a window that already landed computes an EMPTY replay set
 *     before a single Telegram request is made. `source_backfill_state` holds a copy for display and
 *     audit and is never the authority.
 *  2. **Idempotency is the storage model's, not this file's.** `source_messages` is unique on
 *     `(source_id, external_id, content_hash)` and `message_classifications` on
 *     `(source_message_id, classifier_version)`. The duplicate probe below is a fast path in front of
 *     those constraints, not a replacement for them.
 *  3. **Stale history is archive, not news.** Every replayed message carries `historical: true` into
 *     `ingestThreat`, which refuses to append to `system_event_log` for a message already past its
 *     own validity window — and that row is the only trigger the public SSE stream and the Telegram
 *     fan-out have. The window is checked per message, so the ten-minute-old post at the recent end
 *     of a three-hour gap is published exactly as it would have been live.
 *
 * ## Failure isolation
 *
 * One source failing must not stop the sweep, and the sweep must never take down live collection.
 * Every source runs inside its own try/catch; a failure raises `consecutive_failures`, which the
 * rerun guard turns into exponential backoff (1h · 2^n, capped at 24h) so a poison message is
 * retried a bounded number of times instead of on every sweep. `markSourceError` is deliberately NOT
 * called: the live stream for that channel is fine, and reporting a source outage because its
 * history could not be read would be a lie an operator acts on.
 */

// ------------------------------------------------------------------------------------------------
// The port: everything this module needs from MTProto, and nothing else
// ------------------------------------------------------------------------------------------------

/** One Telegram message as the history API returns it, reduced to the four fields used here. */
export interface BackfillRawMessage {
  /** Telegram message id. Monotonically increasing per channel; also the paging offset. */
  id: number;
  /** Telegram publication time, in whole seconds since the epoch. */
  date: number;
  /** Message text, or null for a service/media-only post that carries none. */
  message: string | null;
  editDate?: number | null;
}

/**
 * The MTProto capability this module consumes, as an interface it does not implement.
 *
 * The adapter lives in `src/sources/telegram.ts`, next to the connected client, its resolved-peer
 * cache and the central flood-wait policy. Keeping the port here and the adapter there is what lets
 * every test in this file run without a Telegram session, and — more importantly — is what makes
 * "the backfill can never touch an alert channel" a property of the type rather than of a review
 * comment: `routes()` returns classifier routes, and there is no other way in.
 */
export interface BackfillPort {
  /** Classifier routes ONLY. An `mtproto_alert_channel` row must never appear here. */
  routes(): ReadonlyArray<{ sourceId: string; username: string; adapterType: string }>;
  /** One page of history, newest first, through the collector's own peer cache and flood policy. */
  history(username: string, page: { limit: number; offsetId: number }): Promise<BackfillRawMessage[]>;
}

export interface BackfillLogger {
  info?: Function;
  warn?: Function;
  error?: Function;
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------
//
// Constructed DETACHED (`registers: []`) at module scope, attached by
// `registerBackfillMetrics(registry)` — the shape `registerPublicationMetrics` and
// `registerAlertChannelMetrics` already use.

const backfillRuns = new Counter({
  name: 'threatlens_backfill_runs_total',
  help: 'Catch-up backfill attempts per classifier source, by outcome',
  labelNames: ['source', 'result'], registers: []
});
const backfillMessages = new Counter({
  name: 'threatlens_backfill_messages_total',
  help: 'Messages the catch-up backfill handled, by source and what happened to them',
  labelNames: ['source', 'outcome'], registers: []
});
const backfillPages = new Counter({
  name: 'threatlens_backfill_pages_total',
  help: 'History pages the catch-up backfill read, by source',
  labelNames: ['source'], registers: []
});
const backfillGap = new Gauge({
  name: 'threatlens_backfill_gap_seconds',
  help: 'Seconds between the newest archived message of a source and the last gap check',
  labelNames: ['source'], registers: []
});
const backfillDuration = new Histogram({
  name: 'threatlens_backfill_duration_seconds',
  help: 'Seconds one source spent in a catch-up backfill run',
  buckets: [0.5, 1, 5, 15, 30, 60, 120, 300], registers: []
});

const METRICS: ReadonlyArray<[string, Counter<string> | Gauge<string> | Histogram<string>]> = [
  ['threatlens_backfill_runs_total', backfillRuns],
  ['threatlens_backfill_messages_total', backfillMessages],
  ['threatlens_backfill_pages_total', backfillPages],
  ['threatlens_backfill_gap_seconds', backfillGap],
  ['threatlens_backfill_duration_seconds', backfillDuration]
];

export function registerBackfillMetrics(registry: Registry): void {
  for (const [name, metric] of METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

// ------------------------------------------------------------------------------------------------
// Limits
// ------------------------------------------------------------------------------------------------

/**
 * Every bound the sweep obeys, resolved once so a caller can override them in a test without
 * rewriting the environment the whole process shares.
 */
export interface BackfillLimits {
  enabled: boolean;
  /** Gaps at or below this never start an extended backfill. The issue's «понад 60 хвилин». */
  minGapSeconds: number;
  maxAgeSeconds: number;
  maxMessages: number;
  maxPages: number;
  pageSize: number;
  maxSourcesPerSweep: number;
  sourceDelayMs: number;
  minRerunSeconds: number;
  checkIntervalSeconds: number;
}

export function backfillLimits(): BackfillLimits {
  return {
    enabled: config.CLASSIFIER_BACKFILL_ENABLED,
    minGapSeconds: config.CLASSIFIER_BACKFILL_MIN_GAP_SECONDS,
    maxAgeSeconds: config.CLASSIFIER_BACKFILL_MAX_AGE_SECONDS,
    maxMessages: config.CLASSIFIER_BACKFILL_MAX_MESSAGES,
    maxPages: config.CLASSIFIER_BACKFILL_MAX_PAGES,
    pageSize: config.CLASSIFIER_BACKFILL_PAGE_SIZE,
    maxSourcesPerSweep: config.CLASSIFIER_BACKFILL_MAX_SOURCES_PER_SWEEP,
    sourceDelayMs: config.CLASSIFIER_BACKFILL_SOURCE_DELAY_MS,
    minRerunSeconds: config.CLASSIFIER_BACKFILL_MIN_RERUN_SECONDS,
    checkIntervalSeconds: config.CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS
  };
}

// ------------------------------------------------------------------------------------------------
// The gap decision — PURE
// ------------------------------------------------------------------------------------------------

export type BackfillAction =
  'run' | 'skipped_disabled' | 'no_cursor' | 'skipped_recent' | 'skipped_small_gap';

export type BackfillRunStatus = 'ok' | 'truncated' | 'failed' | Exclude<BackfillAction, 'run'>;

export interface BackfillDecisionInput {
  sourceId: string;
  now: Date;
  /** `CLASSIFIER_BACKFILL_ENABLED`. */
  enabled: boolean;
  /** `sources.enabled` for this row. */
  sourceEnabled: boolean;
  /**
   * The EFFECTIVE cursor: the newest archived message for this source, or `baseline_at` when the
   * archive holds none. Never null in practice — `baseline_at` defaults to `now()` the first time a
   * source is seen, which is exactly what keeps a freshly registered channel from being read back to
   * the beginning of time on its first sweep.
   */
  cursorPublishedAt: Date | null;
  /** True when the cursor above came from `baseline_at` because `source_messages` holds nothing. */
  archiveEmpty: boolean;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  minGapSeconds: number;
  minRerunSeconds: number;
}

export interface BackfillDecision {
  sourceId: string;
  gapSeconds: number;
  cursorPublishedAt: Date | null;
  action: BackfillAction;
}

/**
 * Whether this source's gap earns an extended backfill, and if not, why not.
 *
 * Pure and total: every branch names itself, and the name is what `/ops` shows and what
 * `source_backfill_state.last_run_status` stores. The order of the checks is the order of the
 * reasons an operator would give — switched off, nothing to measure from, tried too recently, gap
 * too small — and it matters: a disabled source must report `skipped_disabled` regardless of how big
 * its gap has grown, or the console shows a red gap next to a feature nobody switched on.
 *
 * The comparison at the bottom is `<=`, so a gap of exactly `MIN_GAP_SECONDS` skips. The issue's
 * acceptance criterion is «розрив ПОНАД 60 хвилин запускає» — sixty minutes exactly is not over
 * sixty minutes, and the boundary is pinned by a unit test at 59/60/61.
 *
 * The rerun guard is exponential in `consecutive_failures`, capped at 24×. A source whose history
 * contains a message that always throws would otherwise be retried on every sweep forever, spending
 * the account's Telegram budget on a request that cannot succeed; one success resets the counter.
 */
export function decideBackfill(input: BackfillDecisionInput): BackfillDecision {
  const cursorPublishedAt = input.cursorPublishedAt;
  const gapSeconds = cursorPublishedAt
    ? Math.max(0, Math.floor((input.now.getTime() - cursorPublishedAt.getTime()) / 1000))
    : 0;
  const decided = (action: BackfillAction): BackfillDecision =>
    ({ sourceId: input.sourceId, gapSeconds, cursorPublishedAt, action });

  if (!input.enabled || !input.sourceEnabled) return decided('skipped_disabled');
  if (input.archiveEmpty || !cursorPublishedAt) return decided('no_cursor');
  if (input.lastRunAt) {
    const backoff = Math.min(2 ** Math.max(0, input.consecutiveFailures), 24);
    const quietUntil = input.lastRunAt.getTime() + input.minRerunSeconds * backoff * 1000;
    if (quietUntil > input.now.getTime()) return decided('skipped_recent');
  }
  if (gapSeconds <= input.minGapSeconds) return decided('skipped_small_gap');
  return decided('run');
}

// ------------------------------------------------------------------------------------------------
// Window selection — PURE
// ------------------------------------------------------------------------------------------------

export type BackfillTruncation = 'age' | 'count' | 'pages';

export interface BackfillWindow {
  from: Date;
  to: Date;
  truncatedReason: BackfillTruncation | null;
}

export interface BackfillWindowBounds {
  /** Exclusive lower bound: `max(cursor.publishedAt, now - MAX_AGE_SECONDS)`. */
  from: Date;
  /** Upper bound of the sweep: `now` as of when it started. */
  to: Date;
  /** Telegram id of the newest archived message — the tie-break at the boundary second. */
  cursorExternalId: number | null;
  /** True when `MAX_AGE_SECONDS` raised `from` above the cursor, i.e. the window lost its tail. */
  ageTruncated: boolean;
  maxMessages: number;
  maxPages: number;
  pageSize: number;
}

export interface BackfillSelection {
  /** What to replay, ASCENDING by (publication time, message id) — chronological, as the issue requires. */
  replay: BackfillRawMessage[];
  window: BackfillWindow;
  pagesRead: number;
  /** Raw messages seen, including the ones outside the window and the ones carrying no text. */
  messagesRead: number;
  /** True when no further page can add anything: the caller must stop requesting history. */
  done: boolean;
  /** `offsetId` for the next request — Telegram returns messages with a STRICTLY smaller id. */
  nextOffsetId: number;
}

/**
 * Turns the pages fetched so far into the set to replay, and says whether another page is worth
 * asking for.
 *
 * Called after every page rather than once at the end, which is what keeps it pure *and* keeps the
 * caller from paying for pages it will discard: a quiet channel answers the whole window in one
 * request, and the loop stops on the first message older than `from`. Telegram returns history
 * newest-first, so that first old message ends the useful window and every page behind it would be
 * fetched, decoded and thrown away — the same reasoning `backfillAlertChannel` gives for paging by
 * hand instead of asking for the whole count at once.
 *
 * Three caps, and the reason each of them is reported separately:
 *
 *  * `count` — the window held more than `MAX_MESSAGES`. Because the walk is newest-first, what
 *    survives is the RECENT end of the gap and the oldest part is dropped permanently: the cursor
 *    moves to the newest replayed message and those posts will never be read. That is a real loss of
 *    archive, and it is why truncation is a visible status rather than a silent success.
 *  * `pages` — `MAX_PAGES` requests were spent before the window ended. Same loss, different bound.
 *  * `age` — `MAX_AGE_SECONDS` cut the window's tail before any request was made. Decided by the
 *    bounds, not by the walk, and reported last because the two caps above are strictly tighter:
 *    when they fire, the age floor was never even reached.
 *
 * A message with no text is counted as read and never replayed. Photos, polls and service messages
 * carry nothing to classify, and skipping them here rather than inside the replay loop keeps the
 * `messages_read` figure an operator sees equal to what Telegram actually returned.
 */
export function selectWindowMessages(
  pages: ReadonlyArray<ReadonlyArray<BackfillRawMessage>>,
  bounds: BackfillWindowBounds
): BackfillSelection {
  const fromMs = bounds.from.getTime();
  const kept: BackfillRawMessage[] = [];
  let pagesRead = 0;
  let messagesRead = 0;
  let nextOffsetId = 0;
  let reachedAge = false;
  let hitCount = false;
  let hitPages = false;
  let shortPage = false;

  for (const page of pages) {
    if (pagesRead >= bounds.maxPages) { hitPages = true; break; }
    pagesRead += 1;
    for (const message of page) {
      messagesRead += 1;
      nextOffsetId = message.id;
      const at = message.date * 1000;
      // Strictly newer than the cursor, with the message id breaking a tie at the same second —
      // Telegram dates have one-second resolution, so two posts a moment apart share a `date` and
      // only the id can say which of them the archive already holds.
      const afterCursor = at > fromMs
        || (at === fromMs && bounds.cursorExternalId !== null && message.id > bounds.cursorExternalId);
      if (!afterCursor) { reachedAge = true; break; }
      if (typeof message.message !== 'string' || !message.message.trim()) continue;
      kept.push(message);
      if (kept.length >= bounds.maxMessages) { hitCount = true; break; }
    }
    if (reachedAge || hitCount) break;
    if (page.length < bounds.pageSize) { shortPage = true; break; }
  }
  if (!reachedAge && !hitCount && !shortPage && pagesRead >= bounds.maxPages) hitPages = true;

  const truncatedReason: BackfillTruncation | null =
    hitCount ? 'count' : hitPages ? 'pages' : bounds.ageTruncated ? 'age' : null;

  return {
    replay: [...kept].sort((left, right) => left.date - right.date || left.id - right.id),
    window: { from: bounds.from, to: bounds.to, truncatedReason },
    pagesRead,
    messagesRead,
    done: reachedAge || hitCount || hitPages || shortPage,
    nextOffsetId
  };
}

// ------------------------------------------------------------------------------------------------
// State: the cursor, and the row `/ops` reads
// ------------------------------------------------------------------------------------------------

/**
 * Classifier sources, in one predicate used by every statement below.
 *
 * `mtproto` is the Air Force channel and `mtproto_monitor` the OSINT monitors — the two adapter
 * types that go through `processMessage`. `ALERT_CHANNEL_ADAPTER_TYPE` is excluded explicitly rather
 * than implicitly by the allowlist: it costs nothing and it means the exclusion survives somebody
 * later adding a third classifier adapter type to the list above it.
 */
const CLASSIFIER_SOURCE_SQL = `adapter_type IN ('mtproto','${MONITOR_ADAPTER_TYPE}')`
  + ` AND adapter_type <> '${ALERT_CHANNEL_ADAPTER_TYPE}'`;

interface BackfillStateRow {
  baseline_at: Date;
  last_run_at: Date | null;
  consecutive_failures: number;
}

/**
 * Reads this source's backfill state, writing the baseline the first time it is seen.
 *
 * `baseline_at` defaults to `now()`, and that default is the whole of the "no mass backfill on first
 * deployment" guarantee: a channel that has never been collected has an empty archive, so its
 * effective cursor is the moment it was first noticed, its gap is zero, and it is skipped. A channel
 * WITH history measures its gap against the real archive and is read from there.
 */
async function ensureBackfillState(sourceId: string): Promise<BackfillStateRow> {
  await pool.query(
    `INSERT INTO source_backfill_state(source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING`,
    [sourceId]
  );
  const result = await pool.query<BackfillStateRow>(
    `SELECT baseline_at,last_run_at,consecutive_failures FROM source_backfill_state WHERE source_id=$1`,
    [sourceId]
  );
  return result.rows[0] ?? { baseline_at: new Date(), last_run_at: null, consecutive_failures: 0 };
}

/**
 * The newest message this source has in the archive — the cursor, derived rather than stored.
 *
 * Served by `source_messages_source_published_idx (source_id, published_at DESC)`: one index probe,
 * one row. `external_id DESC` breaks a tie at the same publication second, matching the tie-break
 * {@link selectWindowMessages} applies on the way back in.
 */
async function readArchiveCursor(
  sourceId: string
): Promise<{ publishedAt: Date; externalId: string } | null> {
  const result = await pool.query<{ published_at: Date; external_id: string }>(
    `SELECT published_at,external_id FROM source_messages WHERE source_id=$1
     ORDER BY published_at DESC,external_id DESC LIMIT 1`,
    [sourceId]
  );
  const row = result.rows[0];
  return row ? { publishedAt: new Date(row.published_at), externalId: row.external_id } : null;
}

async function sourceIsEnabled(sourceId: string): Promise<boolean> {
  const result = await pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM sources WHERE id=$1 AND ${CLASSIFIER_SOURCE_SQL}`, [sourceId]
  );
  return Boolean(result.rows[0]?.enabled);
}

// ------------------------------------------------------------------------------------------------
// One source
// ------------------------------------------------------------------------------------------------

export interface BackfillCounters {
  read: number;
  replayed: number;
  duplicate: number;
  stale: number;
  failed: number;
  pages: number;
}

export interface SourceBackfillOutcome {
  sourceId: string;
  decision: BackfillDecision;
  status: BackfillRunStatus;
  counters: BackfillCounters;
  window: BackfillWindow | null;
  error: string | null;
}

const NO_COUNTERS: BackfillCounters = { read: 0, replayed: 0, duplicate: 0, stale: 0, failed: 0, pages: 0 };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Whether this exact message is already in the archive.
 *
 * `(source_id, external_id, content_hash)` is the UNIQUE key `source_messages` carries, so this asks
 * the storage model's own question rather than a weaker one: an EDITED post shares its external id
 * with the original and hashes differently, and must be replayed as the revision it is. Probing
 * before the write is what makes a rerun of an already-landed window provably free — the second pass
 * performs no INSERT at all, rather than performing one that a constraint then swallows.
 */
async function alreadyArchived(sourceId: string, externalId: string, text: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM source_messages WHERE source_id=$1 AND external_id=$2 AND content_hash=$3 LIMIT 1`,
    [sourceId, externalId, sha256(text)]
  );
  return Boolean(result.rowCount);
}

async function recordRun(
  sourceId: string,
  decision: BackfillDecision,
  status: BackfillRunStatus,
  counters: BackfillCounters,
  window: BackfillWindow | null,
  error: string | null,
  durationMs: number | null,
  cursor: { publishedAt: Date; externalId: string } | null
): Promise<void> {
  const attempted = status === 'ok' || status === 'truncated' || status === 'failed';
  await pool.query(
    `UPDATE source_backfill_state SET
       -- COALESCE, not assignment: a run that failed before it could re-read the archive must not
       -- blank the cursor an operator is reading the gap from.
       cursor_published_at=COALESCE($2::timestamptz,cursor_published_at),
       cursor_external_id=COALESCE($3::text,cursor_external_id),
       last_checked_at=now(),last_gap_seconds=$4,last_run_status=$5,
       last_run_at=CASE WHEN $6 THEN now() ELSE last_run_at END,
       last_run_finished_at=CASE WHEN $6 THEN now() ELSE last_run_finished_at END,
       last_run_duration_ms=CASE WHEN $6 THEN $7 ELSE last_run_duration_ms END,
       covered_from=CASE WHEN $6 THEN $8::timestamptz ELSE covered_from END,
       covered_to=CASE WHEN $6 THEN $9::timestamptz ELSE covered_to END,
       messages_read=CASE WHEN $6 THEN $10 ELSE messages_read END,
       messages_replayed=CASE WHEN $6 THEN $11 ELSE messages_replayed END,
       messages_duplicate=CASE WHEN $6 THEN $12 ELSE messages_duplicate END,
       messages_stale=CASE WHEN $6 THEN $13 ELSE messages_stale END,
       messages_failed=CASE WHEN $6 THEN $14 ELSE messages_failed END,
       pages_read=CASE WHEN $6 THEN $15 ELSE pages_read END,
       truncated_reason=CASE WHEN $6 THEN $16 ELSE truncated_reason END,
       -- The error and its timestamp move together: a run that succeeded must not leave «остання
       -- помилка — немає» beside a time an operator will read as recent.
       last_error=CASE WHEN $6 THEN $17 ELSE last_error END,
       last_error_at=CASE WHEN $17 IS NOT NULL THEN now() WHEN $6 THEN NULL ELSE last_error_at END,
       -- A successful attempt clears the backoff; a failed one lengthens it. A SKIP touches
       -- neither: it is not evidence about whether this source can be read.
       consecutive_failures=CASE
         WHEN $5='failed' THEN consecutive_failures + 1
         WHEN $6 THEN 0
         ELSE consecutive_failures END,
       updated_at=now()
     WHERE source_id=$1`,
    [
      sourceId, cursor?.publishedAt ?? null, cursor?.externalId ?? null,
      decision.gapSeconds, status, attempted, durationMs,
      window?.from ?? null, window?.to ?? null,
      counters.read, counters.replayed, counters.duplicate, counters.stale, counters.failed,
      counters.pages, window?.truncatedReason ?? null, error
    ]
  );
}

/**
 * Reads and replays one source's gap.
 *
 * Never throws. Every exit records a row in `source_backfill_state`, so «немає даних» in `/ops` means
 * the sweep has not reached this source yet rather than "something went wrong silently".
 */
export async function runSourceBackfill(
  port: BackfillPort,
  route: { sourceId: string; username: string; adapterType: string },
  limits: BackfillLimits,
  log: BackfillLogger = {}
): Promise<SourceBackfillOutcome> {
  const startedAt = Date.now();
  const now = new Date(startedAt);
  const counters: BackfillCounters = { ...NO_COUNTERS };
  let decision: BackfillDecision = {
    sourceId: route.sourceId, gapSeconds: 0, cursorPublishedAt: null, action: 'skipped_disabled'
  };
  try {
    const [state, archived, sourceEnabled] = await Promise.all([
      ensureBackfillState(route.sourceId),
      readArchiveCursor(route.sourceId),
      sourceIsEnabled(route.sourceId)
    ]);
    const effectiveCursor = archived?.publishedAt ?? new Date(state.baseline_at);
    decision = decideBackfill({
      sourceId: route.sourceId,
      now,
      enabled: limits.enabled,
      sourceEnabled,
      cursorPublishedAt: effectiveCursor,
      archiveEmpty: archived === null,
      lastRunAt: state.last_run_at ? new Date(state.last_run_at) : null,
      consecutiveFailures: Number(state.consecutive_failures ?? 0),
      minGapSeconds: limits.minGapSeconds,
      minRerunSeconds: limits.minRerunSeconds
    });
    backfillGap.set({ source: route.sourceId }, decision.gapSeconds);

    if (decision.action !== 'run') {
      await recordRun(route.sourceId, decision, decision.action, counters, null, null, null, archived);
      backfillRuns.inc({ source: route.sourceId, result: decision.action });
      return {
        sourceId: route.sourceId, decision, status: decision.action, counters, window: null, error: null
      };
    }

    // `from` is the later of the cursor and the age floor. When the floor wins, the tail of the gap
    // is dropped before a single request is made and the run reports itself `truncated`, not `ok`.
    const floor = new Date(now.getTime() - limits.maxAgeSeconds * 1000);
    const ageTruncated = floor.getTime() > effectiveCursor.getTime();
    const externalId = Number(archived?.externalId);
    const bounds: BackfillWindowBounds = {
      from: ageTruncated ? floor : effectiveCursor,
      to: now,
      cursorExternalId: !ageTruncated && Number.isSafeInteger(externalId) ? externalId : null,
      ageTruncated,
      maxMessages: limits.maxMessages,
      maxPages: limits.maxPages,
      pageSize: limits.pageSize
    };

    const pages: BackfillRawMessage[][] = [];
    let selection: BackfillSelection;
    let offsetId = 0;
    for (;;) {
      const page = await port.history(route.username, { limit: limits.pageSize, offsetId });
      pages.push([...page]);
      selection = selectWindowMessages(pages, bounds);
      if (selection.done || !page.length) break;
      offsetId = selection.nextOffsetId;
    }
    counters.read = selection.messagesRead;
    counters.pages = selection.pagesRead;
    backfillPages.inc({ source: route.sourceId }, selection.pagesRead);

    // Chronological, one at a time, and STOPPING at the first failure: the cursor is
    // `max(published_at)`, so continuing past a message that could not be written would advance the
    // cursor over a hole nothing would ever come back for.
    let failure: unknown = null;
    for (const message of selection.replay) {
      const text = message.message ?? '';
      const externalMessageId = String(message.id);
      if (await alreadyArchived(route.sourceId, externalMessageId, text)) {
        counters.duplicate += 1;
        backfillMessages.inc({ source: route.sourceId, outcome: 'duplicate' });
        continue;
      }
      const publishedAt = new Date(message.date * 1000);
      try {
        await processMessage({
          sourceId: route.sourceId,
          externalId: externalMessageId,
          publishedAt,
          editedAt: message.editDate ? new Date(message.editDate * 1000) : undefined,
          text,
          rawPayload: { channel: route.username, id: message.id, backfill: true }
        }, { monitor: route.adapterType === MONITOR_ADAPTER_TYPE, historical: true });
      } catch (error) {
        counters.failed += 1;
        backfillMessages.inc({ source: route.sourceId, outcome: 'failed' });
        failure = error;
        break;
      }
      // The same rule `ingestThreat` applies, read off the same constant: a message already past its
      // own validity window landed in the archive and nowhere else.
      const stale = publishedAt.getTime() + THREAT_VALIDITY_MS <= Date.now();
      if (stale) counters.stale += 1; else counters.replayed += 1;
      backfillMessages.inc({ source: route.sourceId, outcome: stale ? 'stale' : 'replayed' });
    }

    const cursor = await readArchiveCursor(route.sourceId);
    const durationMs = Date.now() - startedAt;
    if (failure) throw failure;
    backfillDuration.observe(durationMs / 1000);
    const status: BackfillRunStatus = selection.window.truncatedReason ? 'truncated' : 'ok';
    await recordRun(route.sourceId, decision, status, counters, selection.window, null, durationMs, cursor);
    backfillRuns.inc({ source: route.sourceId, result: status });
    log.info?.({
      sourceId: route.sourceId, channel: route.username, gapSeconds: decision.gapSeconds,
      from: selection.window.from.toISOString(), to: selection.window.to.toISOString(),
      truncated: selection.window.truncatedReason, ...counters
    }, 'classifier source backfill finished');
    return {
      sourceId: route.sourceId, decision, status, counters, window: selection.window, error: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    backfillDuration.observe((Date.now() - startedAt) / 1000);
    // Best effort: if the state write itself is what failed, there is nothing left to report it to,
    // and the sweep must still continue to the next source.
    await recordRun(
      route.sourceId, decision, 'failed', counters, null, message.slice(0, 500),
      Date.now() - startedAt, null
    ).catch(() => undefined);
    backfillRuns.inc({ source: route.sourceId, result: 'failed' });
    log.error?.({ error, sourceId: route.sourceId, channel: route.username },
      'classifier source backfill failed; live collection and the other sources are unaffected');
    return {
      sourceId: route.sourceId, decision, status: 'failed', counters, window: null, error: message
    };
  }
}

// ------------------------------------------------------------------------------------------------
// The sweep
// ------------------------------------------------------------------------------------------------

export interface BackfillSweepSummary {
  startedAt: string;
  finishedAt: string;
  outcomes: SourceBackfillOutcome[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/**
 * One pass over every classifier route the port offers.
 *
 * Sources are taken in gap order, widest first, and capped at `MAX_SOURCES_PER_SWEEP`: with
 * fifty-odd channels registered, a restart that ran all of them at once would put fifty history
 * bursts on the connection the live stream is arriving over, which is the exact shape of request the
 * flood-wait policy exists to avoid. The rest are picked up by the next sweep five minutes later,
 * and their gap only grows, so the ordering is self-correcting.
 *
 * Ordering needs the gap, and the gap needs a database read per source — done here in one pass so
 * the expensive part (history, classification) still runs strictly one source at a time with
 * `SOURCE_DELAY_MS` between them.
 */
export async function runBackfillSweep(
  port: BackfillPort,
  log: BackfillLogger = {},
  limits: BackfillLimits = backfillLimits()
): Promise<BackfillSweepSummary> {
  sweepRunning = true;
  try {
    return await sweep(port, log, limits);
  } finally {
    sweepRunning = false;
  }
}

/**
 * Whether a sweep is in progress right now, for `/ops` alone.
 *
 * Observational, never a lock: the mutex that stops two sweeps overlapping is the closure in
 * {@link startClassifierBackfill}, and moving it here would make a direct `runBackfillSweep` call in
 * a test silently do nothing. One process holds one collector and one HTTP server, so a module-level
 * boolean is the truth the console needs.
 */
let sweepRunning = false;
export function backfillSweepRunning(): boolean {
  return sweepRunning;
}

async function sweep(
  port: BackfillPort, log: BackfillLogger, limits: BackfillLimits
): Promise<BackfillSweepSummary> {
  const startedAt = new Date();
  const outcomes: SourceBackfillOutcome[] = [];
  const routes = [...port.routes()];
  const ranked: Array<{ route: typeof routes[number]; gapSeconds: number }> = [];
  for (const route of routes) {
    try {
      const [state, archived] = await Promise.all([
        ensureBackfillState(route.sourceId), readArchiveCursor(route.sourceId)
      ]);
      const cursor = archived?.publishedAt ?? new Date(state.baseline_at);
      ranked.push({ route, gapSeconds: Math.max(0, (startedAt.getTime() - cursor.getTime()) / 1000) });
    } catch (error) {
      log.error?.({ error, sourceId: route.sourceId }, 'classifier backfill gap probe failed');
    }
  }
  ranked.sort((left, right) => right.gapSeconds - left.gapSeconds);

  let index = 0;
  for (const { route } of ranked.slice(0, Math.max(0, limits.maxSourcesPerSweep))) {
    if (index > 0 && limits.sourceDelayMs > 0) await sleep(limits.sourceDelayMs);
    index += 1;
    outcomes.push(await runSourceBackfill(port, route, limits, log));
  }
  return { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), outcomes };
}

/**
 * Starts the sweep and keeps it running, returning the closure that stops it.
 *
 * Called by the collector once its channels are bound, and deliberately NOT awaited there: a
 * backfill is minutes of work and the live stream must not wait for it. The mutex is closure-local,
 * which is all that is needed — the startup pass and the interval share exactly one of these.
 *
 * `CHECK_INTERVAL_SECONDS = 0` means "at start only". Anything else re-checks on that cadence, which
 * is what covers a gap that opens *after* startup: a long flood wait, or a socket that stayed up
 * while the far side stopped delivering.
 */
export function startClassifierBackfill(
  port: BackfillPort,
  log: BackfillLogger = {},
  limits: BackfillLimits = backfillLimits()
): () => void {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped || !limits.enabled) return;
    running = true;
    try {
      await runBackfillSweep(port, log, limits);
    } catch (error) {
      // Nothing here may reach the collector. A sweep that throws is a sweep that will be tried
      // again on the next tick; a sweep that throws INTO the collector is a dead live stream.
      log.error?.({ error }, 'classifier backfill sweep failed');
    } finally {
      running = false;
    }
  };
  void run();
  if (limits.checkIntervalSeconds <= 0) return () => { stopped = true; };
  const timer = setInterval(() => void run(), limits.checkIntervalSeconds * 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

// ------------------------------------------------------------------------------------------------
// What `/ops` reads
// ------------------------------------------------------------------------------------------------

export interface BackfillProgressRow {
  sourceId: string;
  name: string;
  adapterType: string;
  enabled: boolean;
  gapSeconds: number | null;
  cursorPublishedAt: string | null;
  cursorExternalId: string | null;
  lastCheckedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunDurationMs: number | null;
  coveredFrom: string | null;
  coveredTo: string | null;
  messagesRead: number;
  messagesReplayed: number;
  messagesDuplicate: number;
  messagesStale: number;
  messagesFailed: number;
  pagesRead: number;
  truncatedReason: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

/**
 * Per-source backfill progress, widest gap first.
 *
 * Read from the database rather than from the port, because `/ops` is answered by the HTTP server
 * and the port belongs to the collector — and because the answer must survive a restart, which is
 * the state an operator is most likely to be looking at this page in.
 *
 * The gap is recomputed live from `source_messages` rather than served from `last_gap_seconds`: the
 * stored value is as old as the last sweep, and «розрив» going stale in the console is precisely the
 * confusion the number exists to remove. Alert channels are excluded by
 * {@link CLASSIFIER_SOURCE_SQL}; they have their own reconciliation contour.
 */
export async function readBackfillProgress(): Promise<BackfillProgressRow[]> {
  const result = await pool.query(
    `SELECT s.id,s.name,s.adapter_type,s.enabled,
            b.cursor_published_at,b.cursor_external_id,b.baseline_at,b.last_checked_at,b.last_run_at,
            b.last_run_status,b.last_run_duration_ms,b.covered_from,b.covered_to,
            b.messages_read,b.messages_replayed,b.messages_duplicate,b.messages_stale,
            b.messages_failed,b.pages_read,b.truncated_reason,b.last_error,b.last_error_at,
            b.consecutive_failures,
            (SELECT max(published_at) FROM source_messages sm WHERE sm.source_id=s.id) AS archive_at
       FROM sources s
       LEFT JOIN source_backfill_state b ON b.source_id=s.id
      WHERE ${CLASSIFIER_SOURCE_SQL}
      ORDER BY s.id`
  );
  const now = Date.now();
  return result.rows
    .map((row) => {
      const cursor = row.archive_at ?? row.baseline_at ?? null;
      return {
        sourceId: row.id,
        name: row.name,
        adapterType: row.adapter_type,
        enabled: row.enabled,
        gapSeconds: cursor ? Math.max(0, Math.floor((now - new Date(cursor).getTime()) / 1000)) : null,
        cursorPublishedAt: row.archive_at ? new Date(row.archive_at).toISOString()
          : row.cursor_published_at ? new Date(row.cursor_published_at).toISOString() : null,
        cursorExternalId: row.cursor_external_id ?? null,
        lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
        lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
        lastRunStatus: row.last_run_status ?? null,
        lastRunDurationMs: row.last_run_duration_ms == null ? null : Number(row.last_run_duration_ms),
        coveredFrom: row.covered_from ? new Date(row.covered_from).toISOString() : null,
        coveredTo: row.covered_to ? new Date(row.covered_to).toISOString() : null,
        messagesRead: Number(row.messages_read ?? 0),
        messagesReplayed: Number(row.messages_replayed ?? 0),
        messagesDuplicate: Number(row.messages_duplicate ?? 0),
        messagesStale: Number(row.messages_stale ?? 0),
        messagesFailed: Number(row.messages_failed ?? 0),
        pagesRead: Number(row.pages_read ?? 0),
        truncatedReason: row.truncated_reason ?? null,
        lastError: row.last_error ?? null,
        lastErrorAt: row.last_error_at ? new Date(row.last_error_at).toISOString() : null,
        consecutiveFailures: Number(row.consecutive_failures ?? 0)
      };
    })
    .sort((left, right) => (right.gapSeconds ?? -1) - (left.gapSeconds ?? -1));
}
