import { Counter, Gauge, type Registry } from 'prom-client';
import { config } from '../config.js';
import {
  ALERT_CHANNEL_SOURCE_ID, MONITOR_ADAPTER_TYPE, ingestAlertChannelMessages, loadAlertChannels,
  loadMonitoredTelegramChannels, processMessage,
  type AlertChannelMessage, type AlertTelegramChannel, type MonitoredTelegramChannel
} from '../services/ingestion.js';
import { markSourceError, markSourceSuccess } from '../services/operations.js';

/**
 * Last-resort definition of the Air Force channel.
 *
 * The channel list is read from `sources`, but the Air Force channel is an official Tier A source
 * that has been collected since the first release and must keep working exactly as it does now. If
 * the registry query fails, or the row has lost its `telegram_username`, the collector falls back to
 * this pair rather than starting up subscribed to nothing. The OSINT monitors have no such fallback:
 * a monitor the database does not list is a monitor that is not read.
 */
const AIR_FORCE_SOURCE_ID = 'air-force';
const AIR_FORCE_CHANNEL = 'kpszsu';

interface CollectorLogger { info: Function; warn?: Function; error: Function }

/**
 * What one subscribed username is for.
 *
 * `kind` is the routing decision, made once at connect time from the registry and never re-derived
 * from the text of a message. An `alert` route reaches the alert reconciler and nothing else; a
 * `classifier` route reaches `processMessage` and nothing else. Comparing a username against a
 * single configured handle — which is what this used to do — could only ever protect one channel.
 */
export type ChannelRoute =
  | { kind: 'alert'; sourceId: string; username: string }
  | { kind: 'classifier'; sourceId: string; username: string; adapterType: string };

/**
 * Resolves the channels the collector subscribes to, keyed by lower-cased username.
 *
 * The alert channels are inserted first and the classifier channels can never overwrite them: a
 * handle that somehow appears on both an `mtproto_alert_channel` row and a monitoring row stays an
 * alert route. That is the whole routing guarantee, and it is the one that stops an official
 * administration channel from being processed as OSINT and having its air-raid alerts filed as
 * unverified threat events.
 */
export async function resolveChannelRoutes(log: CollectorLogger): Promise<Map<string, ChannelRoute>> {
  const routes = new Map<string, ChannelRoute>();

  // A failed registry read must not leave the deployment subscribed to nothing on the alert path.
  // `null` means "the query failed", which is the only case the configured fallback covers; an
  // empty list means the catalogue says no alert channel is switched on, and that is obeyed.
  const alertChannels = await loadAlertChannels().catch((error) => {
    log.error({ error }, 'alert channel registry could not be read; falling back to the configured channel');
    return null;
  });
  const alertFallback: AlertTelegramChannel[] =
    config.ALERT_CHANNEL_ENABLED && config.ALERT_CHANNEL_USERNAME
      ? [{ sourceId: ALERT_CHANNEL_SOURCE_ID, username: config.ALERT_CHANNEL_USERNAME }]
      : [];
  for (const channel of alertChannels ?? alertFallback) {
    routes.set(channel.username, { kind: 'alert', sourceId: channel.sourceId, username: channel.username });
  }

  const monitored = await loadMonitoredTelegramChannels().catch((error) => {
    log.error({ error }, 'monitored channel registry could not be read; falling back to the Air Force channel');
    return [] as MonitoredTelegramChannel[];
  });
  const classifier = new Map<string, MonitoredTelegramChannel>();
  for (const channel of monitored) classifier.set(channel.username, channel);
  if (![...classifier.values()].some((channel) => channel.sourceId === AIR_FORCE_SOURCE_ID)) {
    classifier.set(AIR_FORCE_CHANNEL, {
      sourceId: AIR_FORCE_SOURCE_ID, username: AIR_FORCE_CHANNEL, adapterType: 'mtproto'
    });
  }
  for (const channel of classifier.values()) {
    if (routes.has(channel.username)) {
      log.warn?.({ username: channel.username, sourceId: channel.sourceId },
        'classifier row claims a handle an alert channel already owns; the alert route wins');
      continue;
    }
    routes.set(channel.username, {
      kind: 'classifier', sourceId: channel.sourceId, username: channel.username,
      adapterType: channel.adapterType
    });
  }
  return routes;
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------
//
// Constructed DETACHED (`registers: []`), like `registerAlertChannelMetrics` and
// `registerPublicationMetrics`: importing the collector must never mutate a shared registry.

const collectorFloodWaits = new Counter({
  name: 'threatlens_telegram_flood_waits_total',
  help: 'Flood waits Telegram imposed on the collector, by the startup phase that hit one',
  labelNames: ['phase'], registers: []
});
const collectorResolveFailures = new Counter({
  name: 'threatlens_telegram_resolve_failures_total',
  help: 'Registry channels the startup resolve pass could not bind to a peer id, by reason',
  labelNames: ['reason'], registers: []
});
const collectorReady = new Gauge({
  name: 'threatlens_telegram_collector_ready',
  help: '1 when both MTProto event handlers are resolved and every registry channel is bound',
  registers: []
});

const COLLECTOR_METRICS: ReadonlyArray<[string, Counter<string> | Gauge<string>]> = [
  ['threatlens_telegram_flood_waits_total', collectorFloodWaits],
  ['threatlens_telegram_resolve_failures_total', collectorResolveFailures],
  ['threatlens_telegram_collector_ready', collectorReady]
];

/** Attaches this module's metrics to the one HTTP registry. Idempotent, like its neighbours. */
export function registerTelegramCollectorMetrics(registry: Registry): void {
  for (const [name, metric] of COLLECTOR_METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

// ------------------------------------------------------------------------------------------------
// Collector state, as readiness and source health see it
// ------------------------------------------------------------------------------------------------

/**
 * What the live collector is doing, in one word.
 *
 * `ready` is the only state in which every registry channel is bound to a peer id AND both event
 * builders are resolved — which, per `teleproto/events/common.js:86-88`, is the only state in which
 * an arriving update is not silently discarded. Everything else is reported as such: the failure
 * this whole module exists to prevent is a process that looks healthy while nothing arrives.
 */
export type TelegramCollectorState =
  | 'disabled' | 'starting' | 'ready' | 'degraded' | 'flood_wait' | 'failed';

export interface TelegramCollectorStatus {
  state: TelegramCollectorState;
  /** ISO 8601 — when this state was entered. */
  since: string;
  /** Both event builders resolved. Until this is true the library drops every update. */
  handlersReady: boolean;
  /** Registry routes the collector is meant to carry. */
  channels: number;
  /** Routes bound to a numeric peer id by the last resolve pass. */
  resolved: number;
  /** Usernames the last resolve pass could not bind. */
  unresolved: string[];
  /** ISO 8601 — end of the interval Telegram named, or null when no wait is in force. */
  floodWaitUntil: string | null;
  floodWaitSeconds: number | null;
  /** Machine-readable reason for a non-`ready` state. */
  detail: string | null;
}

const INITIAL_STATUS: TelegramCollectorStatus = {
  state: 'disabled', since: new Date(0).toISOString(), handlersReady: false, channels: 0,
  resolved: 0, unresolved: [], floodWaitUntil: null, floodWaitSeconds: null, detail: null
};

let collectorStatus: TelegramCollectorStatus = { ...INITIAL_STATUS };

/**
 * The current collector state.
 *
 * Read by `/health/ready` and by `sourceHealth()`; both are additive readers, so a deployment that
 * never starts the collector keeps reporting `disabled` — the state this module starts in — and
 * nothing about their existing answers changes.
 */
export function telegramCollectorStatus(): TelegramCollectorStatus {
  return { ...collectorStatus, unresolved: [...collectorStatus.unresolved] };
}

/** Test seam. Production has exactly one collector, and it owns this value for the process. */
export function resetTelegramCollectorStatus(): void {
  collectorStatus = { ...INITIAL_STATUS };
  collectorReady.set(0);
}

function setCollectorStatus(patch: Partial<TelegramCollectorStatus>): void {
  collectorStatus = { ...collectorStatus, ...patch, since: new Date().toISOString() };
  collectorReady.set(collectorStatus.state === 'ready' ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------
// Flood waits
// ------------------------------------------------------------------------------------------------

/**
 * The interval Telegram named, or null when this is not a flood wait.
 *
 * Duck-typed rather than `instanceof FloodWaitError`, because the error class lives in a CommonJS
 * module the collector otherwise only imports dynamically, and because `RPCMessageToError`
 * (`teleproto/errors/index.js:20-45`) may build one of several flood classes for the same 420: the
 * `FLOOD_WAIT_%d` and `FLOOD_PREMIUM_WAIT_%d` patterns both construct `FloodWaitError`
 * (`teleproto/errors/RPCErrorList.js:7899-7900`), and `FloodTestPhoneWaitError` carries the same
 * `seconds` field. Every one of them sets `name` from `this.constructor.name`
 * (`teleproto/errors/RPCBaseErrors.js:10`), `seconds` from the captured digits
 * (`teleproto/errors/RPCErrorList.js:7000-7004`) and `errorMessage` to the raw `FLOOD_WAIT_<n>`
 * (`teleproto/errors/index.js:43`).
 *
 * Note that the library already absorbs SHORT waits by itself: `invoke`'s flood policy sleeps and
 * retries whenever `seconds <= client.floodSleepThreshold`, default 60
 * (`teleproto/client/users.js:70-81`, `teleproto/client/telegramBaseClient.js:105`). Anything that
 * reaches this function is therefore a wait Telegram considers long, and the only correct response
 * is to stop asking.
 */
export function floodWaitSeconds(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { name?: unknown; seconds?: unknown; errorMessage?: unknown; message?: unknown };
  const named = String(candidate.name ?? '');
  const code = String(candidate.errorMessage ?? '');
  const text = String(candidate.message ?? '');
  const looksLikeFlood = named.startsWith('Flood')
    || /^FLOOD(_TEST_PHONE|_PREMIUM)?_WAIT_\d+$/.test(code)
    || /Please wait \d+ seconds before repeating the action/.test(text);
  if (!looksLikeFlood) return null;
  if (typeof candidate.seconds === 'number' && Number.isFinite(candidate.seconds) && candidate.seconds >= 0) {
    return Math.floor(candidate.seconds);
  }
  const captured = code.match(/_WAIT_(\d+)$/)?.[1] ?? text.match(/Please wait (\d+) seconds/)?.[1];
  return captured ? Number(captured) : 0;
}

// ------------------------------------------------------------------------------------------------
// One resolve pass: usernames to numeric peer ids, before any handler exists
// ------------------------------------------------------------------------------------------------

/**
 * How many dialogs one startup pass reads to build the username → peer-id table.
 *
 * `getDialogs` pages at 100 per request (`teleproto/client/dialogs.js:47,107`) and stops early once
 * a page comes back short, so an account that carries only the ~54 collected channels costs one
 * request. The bound exists for an account that also holds hundreds of private chats: five requests
 * is a proportionate ceiling, and any channel beyond it falls through to the per-username path
 * below, which is bounded and flood-aware.
 */
const DIALOG_SCAN_LIMIT = 500;

export interface ChannelPeerResolution {
  /** Marked peer id → route. The key is what `event.chatId.toString()` produces. */
  byPeerId: Map<string, ChannelRoute>;
  /** Registry usernames this pass could not bind, in registry order. */
  unresolved: string[];
  /** Per-username lookups that were attempted after the dialog pass. Zero is the healthy value. */
  usernameLookups: number;
  /** Set when Telegram named a wait; the pass STOPPED at that point and issued nothing further. */
  floodWaitSeconds: number | null;
  /** Which phase the wait landed in, for the metric label and the log. */
  floodWaitPhase: 'dialogs' | 'username' | null;
}

/** Every handle a dialog entity answers to, lower-cased. */
function entityHandles(entity: any): string[] {
  const handles: string[] = [];
  if (typeof entity?.username === 'string' && entity.username) handles.push(entity.username.toLowerCase());
  // Collectible/secondary handles: `Api.Channel.usernames` (`teleproto/tl/generated/api.d.ts:878`).
  // A `sources` row may name any of them, and a channel that renamed keeps the old one listed here.
  const extras = Array.isArray(entity?.usernames) ? entity.usernames : [];
  for (const extra of extras) {
    if (typeof extra?.username === 'string' && extra.username) handles.push(extra.username.toLowerCase());
  }
  return handles;
}

/**
 * Turns the registry's usernames into numeric peer ids exactly once, before any handler exists.
 *
 * ## Why this has to happen here and not in the event builders
 *
 * `new NewMessage({ chats })` does not resolve anything: `EventBuilder` only stringifies the list
 * (`teleproto/events/common.js:66`). The resolution happens in `_intoIdSet`
 * (`teleproto/events/common.js:16-58`), and where it happens is the whole bug — the library defers
 * it to the first update that arrives (`teleproto/client/updates.js:85-87`), runs it once per
 * builder, and on failure leaves `resolved === false` so the NEXT update tries the whole list again
 * (`teleproto/events/common.js:75-81`). With 54 usernames and two builders that is 108
 * `contacts.ResolveUsername` calls per update, repeated for as long as updates keep arriving — the
 * flood the process never recovers from, made worse by the fact that an unresolved builder discards
 * every event it is handed (`teleproto/events/common.js:86-88`), so nothing arrives to prove it.
 *
 * A marked peer id skips all of it: `_intoIdSet` takes the `parseID` branch for a numeric string and
 * adds it straight to the set (`teleproto/events/common.js:25-32`), never reaching the
 * `client.getInputEntity(chat)` call on line 50. `filter` then compares against
 * `event.chatId.toString()` (`teleproto/events/common.js:93`), which is the same marked id
 * (`teleproto/tl/custom/chatGetter.js:89-93`).
 *
 * ## Why the dialog pass comes first
 *
 * A collector receives updates only for dialogs its account is in, so every registry channel should
 * appear in `getDialogs`. Reading it once binds them all from one paged request set, and — because
 * `invoke` feeds every response through `session.processEntities`
 * (`teleproto/client/users.js:202`, `teleproto/sessions/Memory.js:207-212`) — it also primes the
 * session cache that `getInputEntity` consults before the network
 * (`teleproto/client/users.js:466-472`). A username missing from the dialog list is a real finding:
 * the account is not subscribed to it, and no message from it will ever arrive.
 */
export async function resolveChannelPeers(
  client: any, routes: Map<string, ChannelRoute>, log: CollectorLogger
): Promise<ChannelPeerResolution> {
  const byPeerId = new Map<string, ChannelRoute>();
  const pending = new Map<string, ChannelRoute>(routes);
  const unresolved: string[] = [];
  let usernameLookups = 0;
  let floodWait: number | null = null;
  let floodWaitPhase: 'dialogs' | 'username' | null = null;

  try {
    const dialogs = await client.getDialogs({ limit: DIALOG_SCAN_LIMIT });
    for (const dialog of dialogs ?? []) {
      const peerId = dialog?.id == null ? '' : String(dialog.id);
      if (!peerId) continue;
      for (const handle of entityHandles(dialog.entity)) {
        const route = pending.get(handle);
        if (!route) continue;
        byPeerId.set(peerId, route);
        pending.delete(handle);
      }
    }
  } catch (error) {
    floodWait = floodWaitSeconds(error);
    if (floodWait != null) {
      floodWaitPhase = 'dialogs';
      collectorFloodWaits.inc({ phase: 'dialogs' });
      log.error({ error, seconds: floodWait }, 'MTProto dialog scan hit a Telegram flood wait');
    } else {
      collectorResolveFailures.inc({ reason: 'dialog_scan' });
      log.warn?.({ error }, 'MTProto dialog scan failed; falling back to per-username resolution');
    }
  }

  for (const [username, route] of pending) {
    // Once Telegram has named an interval, nothing else is asked for. The remaining usernames are
    // reported unresolved without a request each — this loop is the retry storm the issue describes,
    // and the only way it cannot happen is for it to stop issuing calls.
    if (floodWait != null) { unresolved.push(username); continue; }
    usernameLookups += 1;
    try {
      // `getPeerId` on a string resolves through `getInputEntity` and returns the marked id
      // (`teleproto/client/users.js:611-632`); after the dialog pass above that is a session-cache
      // hit and costs nothing, and for a channel the account is genuinely not in it costs exactly
      // one `contacts.ResolveUsername`.
      const peerId = String(await client.getPeerId(username));
      if (!peerId || peerId === 'undefined' || peerId === 'null') throw new Error('empty peer id');
      byPeerId.set(peerId, route);
    } catch (error) {
      const seconds = floodWaitSeconds(error);
      if (seconds != null) {
        floodWait = seconds;
        floodWaitPhase = 'username';
        collectorFloodWaits.inc({ phase: 'username' });
        collectorResolveFailures.inc({ reason: 'flood_wait' });
        unresolved.push(username);
        log.error({ error, username, seconds }, 'MTProto channel resolution hit a Telegram flood wait');
        continue;
      }
      collectorResolveFailures.inc({ reason: 'lookup_failed' });
      unresolved.push(username);
      log.warn?.({ error, username, sourceId: route.sourceId },
        'Telegram channel could not be bound to a peer id; it will not be collected');
    }
  }

  return { byPeerId, unresolved, usernameLookups, floodWaitSeconds: floodWait, floodWaitPhase };
}

/**
 * Reads one channel's alert-relevant history that the collector missed while it was disconnected.
 *
 * These channels publish events, so a gap in the stream is a gap in the state: a raion whose 🔴
 * arrived while the process was down would otherwise stay clear on the map until its 🟢, and a raion
 * whose 🟢 was missed would stay under alert until the maximum-duration backstop fires. Reading the
 * tail of each channel closes both.
 *
 * The window is bounded twice — by message count and by age — and `ingestAlertChannelMessages` folds
 * it to one terminal state per location before writing anything, so nothing in the window is
 * replayed as a fresh event. An alert that both started and ended inside the window produces no
 * notification at all; only what is still true right now reaches the reconciler.
 *
 * The history is requested by PEER ID, not by handle: `getMessages` resolves its entity through
 * `getInputEntity`, which short-circuits on a numeric string via the in-memory entity cache
 * (`teleproto/client/users.js:429-446`) that the dialog pass has already filled
 * (`teleproto/client/users.js:207`). Passing the username instead would put one more
 * `contacts.ResolveUsername` per alert channel on the connect path, which is precisely the traffic
 * this module now exists to avoid.
 *
 * ## Why this pages by hand instead of asking for `ALERT_CHANNEL_BACKFILL_MESSAGES` in one call
 *
 * The two bounds are not equally binding, and they are not equally binding *per channel*. The
 * national channel publishes about fifty messages an hour, so 300 messages is roughly the six-hour
 * window it is calibrated to. An oblast administration publishes one to three an hour: 300 messages
 * reaches back the better part of a week, and everything beyond the age cutoff is fetched, decoded
 * and thrown away. Requesting a page at a time and stopping as soon as a page runs past the cutoff
 * makes the count the ceiling it was meant to be and the age the bound that actually decides —
 * one round trip for a quiet channel, as many as the window needs for a busy one. With six channels
 * enabled that is roughly nine history requests per connect rather than eighteen.
 */
const BACKFILL_PAGE = 100;

async function backfillAlertChannel(
  client: any, route: ChannelRoute, peerId: string, log: CollectorLogger
): Promise<void> {
  if (!config.ALERT_CHANNEL_BACKFILL_MESSAGES) return;
  const cutoff = Date.now() - config.ALERT_CHANNEL_BACKFILL_SECONDS * 1000;
  const messages: AlertChannelMessage[] = [];
  let read = 0;
  let offsetId = 0;
  let reachedCutoff = false;
  while (read < config.ALERT_CHANNEL_BACKFILL_MESSAGES && !reachedCutoff) {
    const limit = Math.min(BACKFILL_PAGE, config.ALERT_CHANNEL_BACKFILL_MESSAGES - read);
    const page = await client.getMessages(peerId, offsetId ? { limit, offsetId } : { limit });
    if (!page?.length) break;
    for (const message of page) {
      read += 1;
      offsetId = Number(message.id);
      if (!message?.message) continue;
      const publishedAt = new Date(Number(message.date) * 1000);
      // Telegram returns history newest-first, so the first message older than the cutoff ends the
      // useful window and every page after it would be discarded whole.
      if (publishedAt.getTime() < cutoff) { reachedCutoff = true; break; }
      messages.push({
        externalId: String(message.id),
        publishedAt,
        editedAt: message.editDate ? new Date(Number(message.editDate) * 1000) : null,
        text: message.message,
        rawPayload: { channel: route.username, peerId, id: message.id, backfill: true }
      });
    }
    if (page.length < limit) break;
  }
  const summary = await ingestAlertChannelMessages(route.sourceId, messages, log as { warn: Function });
  log.info({
    sourceId: route.sourceId, channel: route.username, read, inWindow: messages.length,
    events: summary.events, applied: summary.applied, skippedStale: summary.skippedStale,
    unrecognized: summary.unrecognized, unresolved: summary.unresolved.length
  }, 'alert channel backlog reconciled after connect');
}

// ------------------------------------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long the collector waits before retrying a pass that ended without a flood wait.
 *
 * A flood wait always uses the interval Telegram named instead of this one. This covers the other
 * incomplete outcomes — a channel that was not in the dialog list, a lookup that failed for its own
 * reasons — so a missing handle is retried on a bounded cadence rather than needing a restart.
 */
const RESOLVE_RETRY_MS = 600_000;

/**
 * Ceiling on a named wait, purely so a malformed `seconds` cannot arm a timer years out. Telegram's
 * long waits are hours, not days; a wait longer than this is treated as this.
 */
const FLOOD_WAIT_CEILING_SECONDS = 21_600;

/** The named interval as a timer length: clamped to the ceiling, never zero. */
function waitMs(seconds: number): number {
  return Math.max(1, Math.min(seconds, FLOOD_WAIT_CEILING_SECONDS)) * 1000;
}

export interface TelegramCollectorRuntime {
  client: any;
  NewMessage: new (params: Record<string, unknown>) => any;
  EditedMessage: new (params: Record<string, unknown>) => any;
}

export interface TelegramCollectorDeps {
  /** Connects and hands back the client and the two builder constructors. Replaced whole in tests. */
  createRuntime?: () => Promise<TelegramCollectorRuntime>;
  /** Arms the single retry timer and returns its canceller. */
  schedule?: (run: () => void, ms: number) => () => void;
  heartbeatMs?: number;
}

async function connectDefaultRuntime(): Promise<TelegramCollectorRuntime> {
  const [{ TelegramClient }, { StringSession }, { NewMessage }, { EditedMessage }] = await Promise.all([
    import('teleproto'), import('teleproto/sessions/index.js'), import('teleproto/events/index.js'),
    import('teleproto/events/EditedMessage.js')
  ]);
  const client = new TelegramClient(
    new StringSession(config.TELEGRAM_SESSION), Number(config.TELEGRAM_API_ID), config.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );
  await client.connect();
  return { client, NewMessage: NewMessage as never, EditedMessage: EditedMessage as never };
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export async function startTelegramCollector(
  log: CollectorLogger, deps: TelegramCollectorDeps = {}
): Promise<(() => Promise<void>) | undefined> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION) {
    setCollectorStatus({ ...INITIAL_STATUS, detail: 'credentials_absent' });
    return undefined;
  }
  const createRuntime = deps.createRuntime ?? connectDefaultRuntime;
  const schedule = deps.schedule ?? defaultSchedule;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

  setCollectorStatus({ ...INITIAL_STATUS, state: 'starting', detail: 'connecting' });
  let runtime: TelegramCollectorRuntime;
  try {
    runtime = await createRuntime();
  } catch (error) {
    setCollectorStatus({ ...INITIAL_STATUS, state: 'failed', detail: 'connect_failed' });
    log.error({ error }, 'MTProto collector failed to start');
    return undefined;
  }
  const { client, NewMessage, EditedMessage } = runtime;

  /**
   * The routing table the live handlers read, keyed by marked peer id.
   *
   * Rebound, never mutated in place, so a retry that binds a channel the first pass missed cannot be
   * observed half-applied by a message already in flight.
   */
  let routesByPeerId = new Map<string, ChannelRoute>();
  const backfilled = new Set<string>();
  let attachedBuilders: unknown[] = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cancelRetry: (() => void) | null = null;
  let stopped = false;

  const processEvent = async (event: any) => {
    const message = event?.message;
    if (!message?.message) return;
    let route: ChannelRoute | undefined;
    try {
      // The peer id off the event, NOT `message.getChat()`. `getChat` walks
      // `getInputChat` → `iterDialogs({ limit: 100 })` whenever the entity is not already cached
      // (`teleproto/tl/custom/chatGetter.js:49-73`), which turns every message from a channel the
      // cache has evicted into a dialog scan. The builder has already matched this event against the
      // same marked id (`teleproto/events/common.js:93`), so the map lookup is exact and free.
      const peerId = event.chatId ?? message.chatId;
      if (peerId == null) return;
      route = routesByPeerId.get(String(peerId));
      if (!route) return;
      // An edit is re-processed with the *original* publication time, not the edit time. The
      // corrected text is what matters; treating the edit as a fresh event would let a correction
      // to an hours-old message restart an alert, and would break the ordering guard that makes
      // out-of-order delivery safe. Removing a location from an edited message is deliberately not
      // an all-clear: absence never ends an alert on this path, only an explicit 🟢 does.
      const publishedAt = new Date(Number(message.date) * 1000);
      const editedAt = message.editDate ? new Date(Number(message.editDate) * 1000) : undefined;
      // One channel, one destination, decided from the registry before anything is parsed. An
      // alert route returns here and can never fall through to the classifier; a classifier route
      // never reaches the alert reconciler, because it is a different branch entirely.
      if (route.kind === 'alert') {
        await ingestAlertChannelMessages(route.sourceId, [{
          externalId: String(message.id),
          publishedAt,
          editedAt: editedAt ?? null,
          text: message.message,
          rawPayload: { channel: route.username, peerId: String(peerId), id: message.id }
        }], log as { warn: Function });
        return;
      }
      await processMessage({
        sourceId: route.sourceId,
        externalId: String(message.id),
        publishedAt,
        editedAt,
        text: message.message,
        rawPayload: { channel: route.username, peerId: String(peerId), id: message.id }
      }, { monitor: route.adapterType === MONITOR_ADAPTER_TYPE });
    } catch (error) {
      // Only the source the message actually belongs to is marked in error. Attributing a failure
      // to a default source would report an outage on a channel that is working, and — worse for
      // an alert channel — would hide the one that is not.
      if (route) await markSourceError(route.sourceId, error).catch(() => undefined);
      log.error({ error, sourceId: route?.sourceId ?? null }, 'MTProto message processing failed');
    }
  };

  const detach = () => {
    for (const builder of attachedBuilders) {
      client.removeEventHandler?.(processEvent, builder);
    }
    attachedBuilders = [];
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };

  const armRetry = (ms: number) => {
    cancelRetry?.();
    cancelRetry = schedule(() => { void attach(); }, ms);
  };

  /**
   * One startup pass: resolve, register, wait for readiness, only then declare success.
   *
   * Every early return leaves the sources unmarked and the heartbeat stopped. That is the point of
   * the issue: `markSourceSuccess` before the handlers can deliver is what made a dead collector
   * report fresh `last_success_at` for as long as the process ran.
   */
  const attach = async (): Promise<void> => {
    if (stopped) return;
    const routes = await resolveChannelRoutes(log);
    const resolution = await resolveChannelPeers(client, routes, log);
    if (stopped) return;

    const floodUntil = resolution.floodWaitSeconds == null ? null
      : new Date(Date.now() + waitMs(resolution.floodWaitSeconds));

    // A retry must never trade a working subscription for a worse one. A pass that binds nothing the
    // live handlers do not already carry learned nothing — it was cut short by a flood wait or a
    // failed dialog scan — and re-registering on its result would drop the channels that ARE being
    // read in order to re-register a subset of them. The live pair stays; only the retry is re-armed.
    const gainedNothing = attachedBuilders.length > 0
      && [...resolution.byPeerId.keys()].every((peerId) => routesByPeerId.has(peerId));
    if (gainedNothing) {
      setCollectorStatus({
        floodWaitSeconds: resolution.floodWaitSeconds,
        floodWaitUntil: floodUntil?.toISOString() ?? null
      });
      log.warn?.({
        resolved: resolution.byPeerId.size, live: routesByPeerId.size,
        unresolved: resolution.unresolved, floodWaitSeconds: resolution.floodWaitSeconds
      }, 'MTProto resolve retry bound no new channel; the live handlers are kept');
      armRetry(resolution.floodWaitSeconds != null ? waitMs(resolution.floodWaitSeconds) : RESOLVE_RETRY_MS);
      return;
    }

    detach();
    routesByPeerId = resolution.byPeerId;

    const base = {
      channels: routes.size,
      resolved: resolution.byPeerId.size,
      unresolved: resolution.unresolved,
      floodWaitSeconds: resolution.floodWaitSeconds,
      floodWaitUntil: floodUntil?.toISOString() ?? null
    };

    const markUnresolved = async (reason: unknown) => {
      // The registry rows behind unbound handles are reported in error rather than left silent: a
      // source that is never marked at all stays `unknown` forever, which is indistinguishable from
      // a quiet channel. `updateSourceFreshness` only ever moves `current` to `stale`.
      const sourceIds = new Set([...routes.values()]
        .filter((route) => resolution.unresolved.includes(route.username))
        .map((route) => route.sourceId));
      for (const sourceId of sourceIds) {
        await markSourceError(sourceId, reason)
          .catch((error) => log.error({ error, sourceId }, 'source could not be marked unavailable'));
      }
    };

    if (!resolution.byPeerId.size) {
      const seconds = resolution.floodWaitSeconds;
      setCollectorStatus({
        ...base, handlersReady: false,
        state: seconds != null ? 'flood_wait' : 'failed',
        detail: seconds != null ? `flood_wait_${resolution.floodWaitPhase}` : 'no_channels_resolved'
      });
      await markUnresolved(new Error(seconds != null
        ? `Telegram flood wait: ${seconds}s during ${resolution.floodWaitPhase} resolution`
        : 'MTProto collector resolved no Telegram channels'));
      log.error({
        channels: routes.size, floodWaitSeconds: seconds,
        floodWaitUntil: base.floodWaitUntil, usernameLookups: resolution.usernameLookups
      }, 'MTProto collector has no live channels');
      // The interval Telegram named, and not one request before it elapses.
      armRetry(seconds != null ? waitMs(seconds) : RESOLVE_RETRY_MS);
      return;
    }

    // Numeric peer ids, so neither builder performs a single username resolve — see
    // `resolveChannelPeers` for the library lines this depends on.
    const chats = [...resolution.byPeerId.keys()];
    const builders = [new NewMessage({ chats }), new EditedMessage({ chats })];
    for (const builder of builders) client.addEventHandler(processEvent, builder);
    attachedBuilders = builders;
    try {
      // Readiness is ASKED FOR, not assumed. `resolve()` is a no-op after the first success
      // (`teleproto/events/common.js:75-81`); doing it here means the first arriving update is
      // matched instead of being dropped by an unresolved builder, and it means a resolve that
      // cannot succeed is discovered now rather than silently, forever.
      for (const builder of builders) {
        await builder.resolve(client);
        if (builder.resolved !== true) throw new Error('event builder did not report itself resolved');
      }
    } catch (error) {
      detach();
      const seconds = floodWaitSeconds(error);
      if (seconds != null) collectorFloodWaits.inc({ phase: 'handlers' });
      setCollectorStatus({
        ...base, handlersReady: false,
        state: seconds != null ? 'flood_wait' : 'failed',
        detail: 'handler_resolve_failed',
        floodWaitSeconds: seconds ?? base.floodWaitSeconds,
        floodWaitUntil: seconds != null
          ? new Date(Date.now() + waitMs(seconds)).toISOString()
          : base.floodWaitUntil
      });
      log.error({ error }, 'MTProto event handlers did not become ready');
      armRetry(seconds != null ? waitMs(seconds) : RESOLVE_RETRY_MS);
      return;
    }
    if (stopped) { detach(); return; }

    // Only now. Both handlers are resolved, which is the first instant at which an arriving message
    // is actually delivered rather than filtered away.
    const liveSources = new Set([...resolution.byPeerId.values()].map((route) => route.sourceId));
    for (const sourceId of liveSources) {
      await markSourceSuccess(sourceId)
        .catch((error) => log.error({ error, sourceId }, 'source could not be marked connected'));
    }
    if (resolution.unresolved.length) {
      await markUnresolved(new Error('Telegram channel is not resolvable; the collector is not subscribed to it'));
    }

    heartbeat = setInterval(() => {
      for (const sourceId of liveSources) {
        markSourceSuccess(sourceId).catch((error) => log.error({ error, sourceId }, 'MTProto heartbeat failed'));
      }
    }, heartbeatMs);
    heartbeat.unref();

    setCollectorStatus({
      ...base, handlersReady: true,
      // `degraded`, not `flood_wait`, when some channels did bind: the handlers are live and those
      // channels are being read, so readiness must not report the deployment as collecting nothing.
      // The named interval is still carried on `floodWaitUntil` and in `detail`.
      state: resolution.unresolved.length ? 'degraded' : 'ready',
      detail: resolution.floodWaitSeconds != null ? `flood_wait_${resolution.floodWaitPhase}`
        : resolution.unresolved.length ? 'channels_unresolved' : null
    });
    log.info({
      chats, channels: routes.size, resolved: resolution.byPeerId.size,
      unresolved: resolution.unresolved, usernameLookups: resolution.usernameLookups,
      alertChannels: [...resolution.byPeerId.values()].filter((route) => route.kind === 'alert').length,
      sources: liveSources.size
    }, 'MTProto collector handlers ready');

    for (const [peerId, route] of resolution.byPeerId) {
      if (route.kind !== 'alert' || backfilled.has(route.sourceId)) continue;
      backfilled.add(route.sourceId);
      // A failed backlog read must not take the live stream down with it, and must not stop the
      // other channels being backfilled: the collector is already receiving new messages, and the
      // maximum-duration backstop covers whatever the gap left behind.
      await backfillAlertChannel(client, route, peerId, log).catch((error) =>
        log.error({ error, sourceId: route.sourceId }, 'alert channel backlog reconciliation failed'));
    }
    // A pass that bound most of the list but was cut short still owes the rest a second attempt —
    // and it owes Telegram the interval it named. Retrying the missing handles on the shorter
    // default would put `contacts.ResolveUsername` back inside an active wait, which is the one
    // thing this module must never do.
    if (resolution.unresolved.length) {
      armRetry(resolution.floodWaitSeconds != null ? waitMs(resolution.floodWaitSeconds) : RESOLVE_RETRY_MS);
    }
  };

  await attach();

  return async () => {
    stopped = true;
    cancelRetry?.();
    cancelRetry = null;
    detach();
    setCollectorStatus({ ...INITIAL_STATUS, detail: 'stopped' });
    await client.disconnect();
  };
}
