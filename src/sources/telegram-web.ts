import { createHash } from 'node:crypto';
import { config } from '../config.js';
import {
  MONITOR_ADAPTER_TYPE, ingestAlertChannelMessages, newestStoredExternalId, processMessage
} from '../services/ingestion.js';
import { markSourceError, markSourcesSuccess } from '../services/operations.js';
import {
  startClassifierBackfill, type BackfillPort, type BackfillRawMessage
} from '../services/source-backfill.js';
import type { MessageMediaAttachment } from '../types.js';
import {
  bindTelegramCollector, codexMediaConsumers, noteCollectorUpdate, refreshCollectorSilenceGauge,
  resolveChannelRoutes, setCollectorStatus,
  type ChannelRoute, type CollectorLogger, type MediaConsumers, type TelegramCollectorStatus
} from './telegram.js';

/**
 * ================================================================================================
 * The tokenless channel collector: the public web preview at `https://t.me/s/<username>`
 * ================================================================================================
 *
 * The MTProto collector (`./telegram.ts`) reads through one user session. On 2026-09-02 that session
 * died (`AUTH_KEY_UNREGISTERED`), and for twenty days not one channel message was ingested — no
 * threat events, no vectors, nothing on the map — with nothing short of a new account able to fix
 * it. The preview page needs no account at all: every one of the 54 registry channels answers it
 * with HTTP 200 and its newest posts. The owner made it the default transport
 * (`TELEGRAM_TRANSPORT=web`) and kept MTProto selectable; one process runs exactly one of them.
 *
 * Everything that decides WHAT happens to a message is shared with the MTProto collector rather than
 * re-derived here: the routing table (`resolveChannelRoutes` — an alert route reaches the alert
 * reconciler and nothing else, a classifier route reaches `processMessage` and nothing else), the
 * status every reader consumes (`telegramCollectorStatus()`), the Ops reload hook, the rule for who
 * reads media, and the catch-up backfill port. What differs is only how bytes arrive: pages polled on
 * a budget instead of updates pushed down a socket — and therefore two things MTProto never had to
 * do by hand, a per-channel cursor and edit detection.
 */

// ------------------------------------------------------------------------------------------------
// The page, parsed — PURE
// ------------------------------------------------------------------------------------------------

/** One post as the public preview shows it. */
export interface WebChannelPost {
  /** Telegram message id — the same number MTProto delivers, so archived ids agree across transports. */
  id: number;
  publishedAt: Date;
  /**
   * The message text and nothing else: the quoted text of a reply, the reactions under the post and
   * a link preview are all separate elements on the page and none of them is part of what the
   * channel said. `<br>` is a newline, emoji are their characters. Empty for a captionless photo.
   */
  text: string;
  /** The page prints «edited» beside the time. */
  edited: boolean;
  /** The first photo of the post (albums show several), or null. */
  photoUrl: string | null;
}

/** What one page says beyond its posts. */
interface ChannelPage {
  /** A channel's message history at all — a history with nothing newer in it still is one. */
  isChannel: boolean;
  /** Message widgets of THIS channel on the page, readable or not (service messages, videos). */
  widgets: number;
  /** Lowest and highest widget id — the range the page accounts for, readable or not. */
  oldestId: number | null;
  newestId: number | null;
  /** Readable posts, ascending by id. */
  posts: WebChannelPost[];
  /** `data-before` of the «older» link: the page's own statement that older messages exist. */
  olderFrom: number | null;
  /** `data-after` of the «newer» link: newer messages exist past this id (albums included). */
  newerFrom: number | null;
}

const MESSAGE_TAG = /<div\b[^>]*\bdata-post="([^"/]+)\/(\d+)"[^>]*>/g;
const MESSAGE_TEXT_TAG = /<div\b[^>]*\bclass="[^"]*\bjs-message_text\b[^"]*"[^>]*>/;
const PUBLISHED_AT = /<time\b[^>]*\bdatetime="([^"]+)"/;
const EDITED_MARK = /\btgme_widget_message_meta\b[^>]*>\s*edited\b/;
const PHOTO_TAG = /<a\b[^>]*\btgme_widget_message_photo_wrap\b[^>]*>/;
const BACKGROUND_URL = /background-image:\s*url\(\s*(['"]?)(.*?)\1\s*\)/;
const MORE_LINK = /<a\b[^>]*\btme_messages_more\b[^>]*>/g;

/**
 * Named entities the preview is seen to emit (`&nbsp;`, `&amp;`, `&quot;`) plus the handful any
 * HTML-escaping layer might, decoded in ONE pass so `&amp;lt;` stays the four characters `&lt;`.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', deg: '°', times: '×', minus: '−', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c'
};

function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body] ?? whole;
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/** The content of the `<div>` whose opening tag ends at `from`, nested `<div>`s included. */
function divContent(html: string, from: number, limit: number): string {
  // Balanced rather than «up to the first `</div>`»: an album caption is one text div NESTED in
  // another with the same class, and a lazy match would cut the caption at the inner close.
  const token = /<div\b|<\/div\s*>/gi;
  token.lastIndex = from;
  let depth = 1;
  for (let match = token.exec(html); match && match.index < limit; match = token.exec(html)) {
    depth += match[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(from, match.index);
  }
  return html.slice(from, limit);
}

function photoUrlOf(body: string): string | null {
  const tag = PHOTO_TAG.exec(body)?.[0];
  const raw = tag ? BACKGROUND_URL.exec(tag)?.[2] : undefined;
  if (!raw) return null;
  const url = decodeEntities(raw);
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  // Only ever fetched over TLS: this URL is downloaded by the server when a model reads media.
  return absolute.startsWith('https://') ? absolute : null;
}

function readChannelPage(html: string, username: string): ChannelPage {
  const expected = username.toLowerCase();
  const tags: Array<{ id: number; tag: string; start: number; end: number }> = [];
  for (const match of html.matchAll(MESSAGE_TAG)) {
    // The handle in `data-post` carries the channel's own capitalisation (`IF112/…` for a registry
    // row `if112`), so it is compared without case. A widget of another channel is never read.
    if ((match[1] ?? '').toLowerCase() !== expected) continue;
    const start = match.index ?? 0;
    tags.push({ id: Number(match[2]), tag: match[0], start, end: start + match[0].length });
  }

  const posts: WebChannelPost[] = [];
  const seen = new Set<number>();
  let oldestId: number | null = null;
  let newestId: number | null = null;
  for (let index = 0; index < tags.length; index += 1) {
    const current = tags[index]!;
    const { id, tag } = current;
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    oldestId = oldestId === null ? id : Math.min(oldestId, id);
    newestId = newestId === null ? id : Math.max(newestId, id);
    // «Channel pinned …», «photo updated»: carried in the same text element as a real post.
    if (/\bservice_message\b/.test(/\bclass="([^"]*)"/.exec(tag)?.[1] ?? '')) continue;
    if (seen.has(id)) continue;
    const body = html.slice(current.end, tags[index + 1]?.start ?? html.length);
    const published = PUBLISHED_AT.exec(body)?.[1];
    const publishedAt = published ? new Date(published) : null;
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) continue;
    // `js-message_text` is the message's own text. A reply's quote is `js-message_reply_text`,
    // reactions and link previews are separate elements — none of them carries this class.
    const textTag = MESSAGE_TEXT_TAG.exec(body);
    // Tags are stripped BEFORE entities are decoded, so a channel that wrote a literal «<b>» (sent
    // as `&lt;b&gt;`) keeps it as text instead of losing it as markup. Emoji arrive as
    // `<i class="emoji" …><b>🙏</b></i>`, so stripping the tags leaves exactly the character.
    const fragment = textTag ? divContent(body, (textTag.index ?? 0) + textTag[0].length, body.length) : '';
    const text = decodeEntities(fragment.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
    const photoUrl = photoUrlOf(body);
    if (!text && !photoUrl) continue;
    seen.add(id);
    posts.push({ id, publishedAt, text, edited: EDITED_MARK.test(body), photoUrl });
  }
  posts.sort((left, right) => left.id - right.id);

  let olderFrom: number | null = null;
  let newerFrom: number | null = null;
  for (const [link] of html.matchAll(MORE_LINK)) {
    const before = /\bdata-before="(\d+)"/.exec(link)?.[1];
    const after = /\bdata-after="(\d+)"/.exec(link)?.[1];
    if (before) olderFrom = Number(before);
    if (after) newerFrom = Number(after);
  }
  return {
    isChannel: tags.length > 0 || /\btgme_channel_history\b/.test(html),
    widgets: tags.length, oldestId, newestId, posts, olderFrom, newerFrom
  };
}

/**
 * The readable posts of one preview page, ascending by id.
 *
 * Service messages are skipped, and a post with neither text nor a photo — a video, a poll, a
 * sticker — is dropped: there is nothing on the page this system could read from it.
 */
export function parseChannelPage(html: string, username: string): WebChannelPost[] {
  return readChannelPage(html, username).posts;
}

// ------------------------------------------------------------------------------------------------
// The budget
// ------------------------------------------------------------------------------------------------

/**
 * Request rate, from the measurement it was sized against.
 *
 * 2026-09-22, from this deployment's host: 354 requests at a sustained six per second for sixty
 * seconds, `Accept-Encoding: gzip`, a browser User-Agent — every one answered 200, not one 429, p50
 * 0.29 s, p95 0.41 s, `Cache-control: no-store` and no ETag (so there is no conditional request to
 * make cheaper). Six per second is a rate observed to be tolerated, not a guess at one; nothing
 * above it was tried. Spacing rather than a bucket, so the budget can never be spent as a burst.
 * Four in flight covers the latency: six a second at p95 0.41 s keeps about 2.5 busy.
 */
const REQUEST_SPACING_MS = Math.ceil(1000 / 6);
const MAX_IN_FLIGHT = 4;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Poll cadence. A channel that published in the last half hour is hot and read every five seconds,
 * every other one every thirty. Quiet, the 54-channel registry costs 1.8 requests a second; the
 * cadence only meets the six-per-second ceiling once about 25 channels are hot at once, and past
 * that the budget sets the pace — every channel still read at least every ~9 s.
 */
const HOT_INTERVAL_MS = 5_000;
const COLD_INTERVAL_MS = 30_000;
const HOT_WINDOW_MS = 30 * 60_000;

/**
 * A page shows up to twenty messages (measured). A 20-widget page, or one carrying a «newer» link,
 * means more follow and is read again at once; ten pages is one cycle's ceiling, so a channel that
 * fell far behind cannot hold the budget for the rest.
 */
const PAGE_SIZE = 20;
const CATCH_UP_PAGES = 10;

/**
 * Edits. The preview has no «edited since» query, so the newest page is re-read without `after` once
 * a minute per channel and each known post's text digest compared. That request REPLACES the
 * channel's regular poll rather than adding one, so edit detection costs no budget at all. Digests
 * are kept for the newest sixty posts per channel — three pages; a correction to anything older is
 * not followed, which bounds the memory at ~54 × 60 short strings.
 */
const EDIT_CHECK_INTERVAL_MS = 60_000;
const EDIT_MEMORY = 60;

/**
 * Global backoff on 429 or 5xx: `Retry-After` when the answer names one, otherwise thirty seconds
 * doubling to fifteen minutes. Every request pauses — the limit is per host, and a second channel
 * asking during the pause is the same refusal again. The ceiling on a named wait is the one the
 * MTProto collector puts on a flood wait (`FLOOD_WAIT_CEILING_SECONDS`), purely so a malformed header
 * cannot arm a timer days out.
 */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const RETRY_AFTER_CEILING_MS = 21_600_000;

/**
 * A handle that answers 404 or redirects off the preview is asked again on the MTProto collector's
 * resolve-retry cadence: that answer does not change from one poll to the next. A page that came back
 * but read as nothing is retried at the channel's normal cadence instead — it may be a glitch.
 */
const UNRESOLVED_RETRY_MS = 600_000;
/** Transient failures in a row before a channel that WAS readable is reported as not being read. */
const FAILING_AFTER = 3;
/** How recent a channel's last good page must be for the heartbeat to call its source fresh. */
const LIVE_WINDOW_MS = 3 * COLD_INTERVAL_MS;
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * A first page that does not reach the newest archived message is bridged by walking forward from
 * the archive with `after` — at most one catch-up cycle's worth. A wider gap starts at the live edge.
 */
const BRIDGE_IDS = PAGE_SIZE * CATCH_UP_PAGES;

/** A preview page is ~110 KB decoded; anything this size is not one. */
const PAGE_MAX_BYTES = 2_000_000;
/** The catch-up sweep reads sequentially, so one waiter is normal; this is a hard ceiling. */
const BACKFILL_WAITERS = 4;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/128.0.0.0 Safari/537.36';

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Encoding': 'gzip',
  // Pins the language of the «edited» mark the parser reads.
  'Accept-Language': 'en-US,en;q=0.9'
};

const NO_MEDIA_CONSUMERS: MediaConsumers = { primary: false, detached: false };

// ------------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------------

type PageQuery = { after?: number; before?: number };

type PageOutcome =
  | { kind: 'page'; page: ChannelPage }
  /** 404, a redirect away from the preview (no public preview), or a body that is not a channel. */
  | { kind: 'missing'; reason: string }
  | { kind: 'throttled'; status: number; retryAfterMs: number | null }
  | { kind: 'failed'; error: unknown };

function pageUrl(username: string, query: PageQuery): string {
  const url = new URL(`https://t.me/s/${encodeURIComponent(username)}`);
  if (query.after !== undefined) url.searchParams.set('after', String(query.after));
  if (query.before !== undefined) url.searchParams.set('before', String(query.before));
  return url.toString();
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header?.trim()) return null;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), RETRY_AFTER_CEILING_MS) : null;
}

/** The body, or null when it outgrows `maxBytes` — which is then not read any further. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

// ------------------------------------------------------------------------------------------------
// The collector
// ------------------------------------------------------------------------------------------------

export interface TelegramWebCollectorDeps {
  /** `globalThis.fetch` in production. */
  fetch?: typeof fetch;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Arms one timer and returns its canceller — the seam `TelegramCollectorDeps.schedule` is. */
  schedule?: (run: () => void, ms: number) => () => void;
  heartbeatMs?: number;
  /** Who reads a downloaded photo. A seam for the same reason it is one on the MTProto collector. */
  mediaConsumers?: () => Promise<MediaConsumers>;
}

type PollKind = 'first' | 'refresh' | 'after';

interface ChannelState {
  route: ChannelRoute;
  /** Highest message id accounted for; null until the channel's first page. */
  cursor: number | null;
  /** Earliest moment the next request for this channel may start. */
  dueAt: number;
  /** A request or its routing is under way. Never two at once, so a channel's posts stay in order. */
  busy: boolean;
  /** Pages spent in the current cycle, the first included. */
  cyclePages: number;
  /** The cursor is behind by more than a page: the next request walks forward instead of refreshing. */
  mustWalk: boolean;
  /** When the newest post this channel has shown was published. Hot or cold is measured from it. */
  newestPublishedAt: number;
  /** When a page without `after` was last read — the edit check's clock. */
  refreshedAt: number;
  /** Text digest of the newest {@link EDIT_MEMORY} posts, by id. */
  seen: Map<number, string>;
  standing: 'pending' | 'ok' | 'unresolved';
  failures: number;
  everRead: boolean;
  lastReadAt: number;
}

interface BackfillWaiter {
  enqueuedAt: number;
  run: () => void;
  fail: (error: Error) => void;
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('base64');
}

/**
 * Starts polling every registry channel through its public preview and returns the stop closure.
 *
 * Never throws: a registry that cannot be read falls back exactly as it does for MTProto
 * (`resolveChannelRoutes`), and every request failure becomes a channel standing or a backoff that
 * the shared collector status reports.
 */
export async function startTelegramWebCollector(
  log: CollectorLogger, deps: TelegramWebCollectorDeps = {}
): Promise<() => Promise<void>> {
  const fetchPage = deps.fetch ?? globalThis.fetch;
  const clock = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? defaultSchedule;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const mediaConsumers = deps.mediaConsumers ?? codexMediaConsumers;
  const halt = new AbortController();

  let stopped = false;
  let channels = new Map<string, ChannelState>();
  let inFlight = 0;
  let nextStartAt = 0;
  let cancelWake: (() => void) | null = null;
  let wakeAt = Number.POSITIVE_INFINITY;
  let throttle: { until: number; seconds: number; status: number; strikes: number } | null = null;
  const backfillQueue: BackfillWaiter[] = [];
  let stopBackfill: (() => void) | null = null;
  let firstRoundLogged = false;
  let published = '';

  const intervalFor = (state: ChannelState, now: number): number =>
    now - state.newestPublishedAt < HOT_WINDOW_MS ? HOT_INTERVAL_MS : COLD_INTERVAL_MS;

  // ---- status ----------------------------------------------------------------------------------

  /**
   * Heartbeat, and what it is allowed to claim.
   *
   * Freshness is asserted per channel against evidence: a page of that channel read inside the last
   * {@link LIVE_WINDOW_MS}. During a backoff no page is read, so the claims stop by themselves and
   * `updateSourceFreshness` moves the rows to `stale` — the collector says nothing rather than
   * something it cannot back, the rule the MTProto heartbeat was rewritten around.
   */
  const beat = (): void => {
    refreshCollectorSilenceGauge();
    const now = clock();
    const live = [...new Set([...channels.values()]
      .filter((state) => state.standing === 'ok' && now - state.lastReadAt <= LIVE_WINDOW_MS)
      .map((state) => state.route.sourceId))];
    if (!live.length) return;
    markSourcesSuccess(live)
      .catch((error: unknown) => log.error({ err: error, sources: live.length }, 'Telegram web heartbeat failed'));
  };

  const computeStatus = (): Omit<TelegramCollectorStatus, 'since'> => {
    const states = [...channels.values()];
    const resolved = states.filter((entry) => entry.standing === 'ok').length;
    const unresolved = states.filter((entry) => entry.standing === 'unresolved').map((entry) => entry.route.username);
    let state: TelegramCollectorStatus['state'] = 'ready';
    let detail: string | null = null;
    if (throttle) {
      state = 'flood_wait';
      detail = `http_${throttle.status}`;
    } else if (states.some((entry) => entry.standing === 'pending')) {
      state = 'starting';
      detail = 'first_poll';
    } else if (!resolved) {
      state = 'failed';
      detail = 'no_channels_resolved';
    } else if (unresolved.length) {
      state = 'degraded';
      detail = 'channels_unresolved';
    }
    return {
      transport: 'web', state, handlersReady: !stopped, channels: states.length, resolved, unresolved,
      unsubscribed: [],
      floodWaitUntil: throttle ? new Date(throttle.until).toISOString() : null,
      floodWaitSeconds: throttle?.seconds ?? null,
      detail
    };
  };

  /** Publishes only what moved: `setCollectorStatus` restamps `since` on every call. */
  const publishStatus = (): void => {
    if (stopped) return;
    const status = computeStatus();
    const signature = JSON.stringify(status);
    if (signature === published) return;
    published = signature;
    setCollectorStatus(status);
    if (!firstRoundLogged && status.state !== 'starting' && status.state !== 'flood_wait') {
      firstRoundLogged = true;
      log.info({
        channels: status.channels, resolved: status.resolved, unresolved: status.unresolved
      }, 'Telegram web collector has read every channel once');
      // Now, not a heartbeat from now: the sources are being read from this moment.
      beat();
    }
    // Started once, as the MTProto collector starts it once its channels are bound: after the first
    // round, and only once something is actually readable. Its port reads the live table, so a
    // channel a reload adds is picked up by the next sweep without a second loop.
    if (firstRoundLogged && status.resolved > 0) stopBackfill ??= startClassifierBackfill(backfillPort, log);
  };

  const markUnresolved = (state: ChannelState, reason: string): void => {
    if (state.standing === 'unresolved') return;
    state.standing = 'unresolved';
    const { username, sourceId } = state.route;
    log.warn?.({ channel: username, sourceId, reason },
      'Telegram channel has no readable public preview; it is not being collected');
    // Once per transition. A source never marked stays `unknown` forever, which reads as a quiet
    // channel; the heartbeat's `markSourcesSuccess` is what clears it once a page is read again.
    void markSourceError(sourceId, new Error(`Telegram channel @${username} has no readable public preview (${reason})`))
      .catch((error: unknown) => log.error({ err: error, sourceId }, 'source could not be marked unavailable'));
  };

  // ---- backoff ---------------------------------------------------------------------------------

  const enterBackoff = (status: number, retryAfter: number | null): void => {
    const now = clock();
    if (throttle && now < throttle.until) {
      // Requests already in flight when the pause began answer into it. They must not escalate it —
      // four concurrent refusals are one refusal — but a longer interval the host names is honoured.
      if (retryAfter !== null && now + retryAfter > throttle.until) {
        throttle.until = now + retryAfter;
        throttle.seconds = Math.round(retryAfter / 1000);
        publishStatus();
      }
      return;
    }
    const strikes = (throttle?.strikes ?? 0) + 1;
    const delay = retryAfter ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (strikes - 1));
    throttle = { until: now + delay, seconds: Math.round(delay / 1000), status, strikes };
    // Mirrors the MTProto flood gate: a catch-up read never waits out a pause, it fails and the
    // sweep retries it on its own schedule.
    for (const waiter of backfillQueue.splice(0)) {
      waiter.fail(new Error(`t.me answered HTTP ${status}; requests pause until ${new Date(throttle.until).toISOString()}`));
    }
    log.warn?.({
      status, seconds: throttle.seconds, until: new Date(throttle.until).toISOString(), strikes
    }, 'Telegram web preview refused the collector; every request pauses until the backoff ends');
    publishStatus();
  };

  /** Only a request answered after the pause ended may lift it. */
  const leaveBackoff = (now: number): void => {
    if (!throttle || now < throttle.until) return;
    log.info({ strikes: throttle.strikes }, 'Telegram web preview answers again; the backoff is lifted');
    throttle = null;
    publishStatus();
  };

  const requestPage = async (username: string, query: PageQuery): Promise<PageOutcome> => {
    let outcome: PageOutcome;
    try {
      const response = await fetchPage(pageUrl(username, query), {
        headers: PAGE_HEADERS, redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), halt.signal])
      });
      if (response.status === 429 || response.status >= 500) {
        discard(response);
        outcome = {
          kind: 'throttled', status: response.status,
          retryAfterMs: retryAfterMs(response.headers.get('retry-after'), clock())
        };
      } else if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
        // `t.me/s/<handle>` redirects to `t.me/<handle>` when there is no public preview: a
        // private channel, a user, a bot, a handle that does not exist. Following it would read a
        // page with no posts and call it «nothing new».
        discard(response);
        outcome = { kind: 'missing', reason: `http_${response.status}` };
      } else if (!response.ok) {
        discard(response);
        outcome = { kind: 'failed', error: new Error(`t.me answered HTTP ${response.status}`) };
      } else {
        const body = await readCapped(response, PAGE_MAX_BYTES);
        if (!body) {
          outcome = { kind: 'failed', error: new Error(`t.me page exceeded ${PAGE_MAX_BYTES} bytes`) };
        } else {
          const page = readChannelPage(body.toString('utf8'), username);
          outcome = page.isChannel ? { kind: 'page', page } : { kind: 'missing', reason: 'not_a_channel_page' };
        }
      }
    } catch (error) {
      outcome = { kind: 'failed', error };
    }
    if (outcome.kind === 'throttled') enterBackoff(outcome.status, outcome.retryAfterMs);
    else if (outcome.kind === 'page') leaveBackoff(clock());
    return outcome;
  };

  // ---- dispatch --------------------------------------------------------------------------------

  const armWake = (at: number, now: number): void => {
    if (cancelWake && wakeAt === at) return;
    cancelWake?.();
    wakeAt = at;
    cancelWake = schedule(() => {
      cancelWake = null;
      wakeAt = Number.POSITIVE_INFINITY;
      pump();
    }, Math.max(0, at - now));
  };

  /**
   * The one place a request starts. Most overdue first, a queued catch-up read counting as due from
   * the moment it asked; spacing, the in-flight ceiling and the backoff are all enforced here and
   * nowhere else, so no caller can spend the budget around them.
   */
  const pump = (): void => {
    if (stopped) return;
    const now = clock();
    if (throttle && now < throttle.until) { armWake(throttle.until, now); return; }
    while (inFlight < MAX_IN_FLIGHT && now >= nextStartAt) {
      let due = Number.POSITIVE_INFINITY;
      let start: (() => void) | null = null;
      const waiter = backfillQueue[0];
      if (waiter) {
        due = waiter.enqueuedAt;
        start = () => { backfillQueue.shift(); waiter.run(); };
      }
      for (const state of channels.values()) {
        if (state.busy || state.dueAt > now || state.dueAt >= due) continue;
        due = state.dueAt;
        start = () => { state.busy = true; void pollChannel(state); };
      }
      if (!start) break;
      inFlight += 1;
      nextStartAt = now + REQUEST_SPACING_MS;
      start();
    }
    // A completing request pumps again, so a full house needs no timer.
    if (inFlight >= MAX_IN_FLIGHT) return;
    let next = backfillQueue.length ? now : Number.POSITIVE_INFINITY;
    for (const state of channels.values()) {
      if (!state.busy && state.dueAt < next) next = state.dueAt;
    }
    if (next === Number.POSITIVE_INFINITY) return;
    armWake(Math.max(next, nextStartAt), now);
  };

  const releaseSlot = (): void => {
    inFlight -= 1;
    pump();
  };

  // ---- routing ---------------------------------------------------------------------------------

  const ingestAlerts = async (state: ChannelState, posts: WebChannelPost[], editedAt: Date | null): Promise<void> => {
    const route = state.route;
    const texted = posts.filter((post) => post.text);
    if (!texted.length) return;
    try {
      // ONE call per page, not one per post. `ingestAlertChannelMessages` folds a batch to one
      // terminal state per location — the reason the MTProto reconnect window goes through it whole:
      // a 🔴 and its 🟢 that a single poll (or a backoff) caught together converge on what is true
      // now instead of being re-announced as a fresh alert and its all-clear. A page holding one post
      // — the live case — is exactly the call the MTProto live handler makes.
      await ingestAlertChannelMessages(route.sourceId, texted.map((post) => ({
        externalId: String(post.id),
        publishedAt: post.publishedAt,
        editedAt,
        text: post.text,
        rawPayload: { channel: route.username, id: post.id, transport: 'web' }
      })), log as { warn: Function });
    } catch (error) {
      await markSourceError(route.sourceId, error).catch(() => undefined);
      log.error({ err: error, sourceId: route.sourceId, channel: route.username, ids: texted.map((post) => post.id) },
        'Telegram web alert-channel messages could not be processed');
    }
  };

  const downloadPhoto = async (url: string): Promise<MessageMediaAttachment[]> => {
    // The same cap the MTProto collector's `telegramAdvisoryMedia` applies to a photo: zero means
    // «never», a declared size over it is refused before a byte is read, and an undeclared one is
    // cut off as soon as it passes it. A different host (the CDN), so not the t.me budget.
    const maxBytes = config.SHADOW_IMAGE_MAX_BYTES;
    if (maxBytes <= 0) return [];
    const response = await fetchPage(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), halt.signal])
    });
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || declared > maxBytes) { discard(response); return []; }
    const bytes = await readCapped(response, maxBytes);
    if (!bytes?.byteLength) return [];
    // Telegram photos are JPEG, which is what the MTProto path declares for them; a CDN that says
    // otherwise about an image is believed.
    const declaredType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    return [{ kind: 'image', mimeType: declaredType.startsWith('image/') ? declaredType : 'image/jpeg', bytes }];
  };

  const processClassifierPost = async (state: ChannelState, post: WebChannelPost, editedAt: Date | undefined): Promise<void> => {
    const route = state.route;
    if (route.kind !== 'classifier') return;
    try {
      // The same three states as the MTProto path, from the same rule (`MediaConsumers`): nobody
      // reads the photo — not downloaded at all; the primary classifier reads it — downloaded and
      // awaited, because the verdict needs it; only the detached shadow path reads it — downloaded
      // alongside and handed over as a promise, so a warning never waits for a second opinion.
      const consumers = post.photoUrl ? await mediaConsumers() : NO_MEDIA_CONSUMERS;
      const flight = post.photoUrl && (consumers.primary || consumers.detached)
        ? downloadPhoto(post.photoUrl).catch(() => [] as MessageMediaAttachment[]) : null;
      const media = consumers.primary && flight ? await flight : [];
      await processMessage({
        sourceId: route.sourceId,
        externalId: String(post.id),
        publishedAt: post.publishedAt,
        editedAt,
        text: post.text,
        rawPayload: {
          channel: route.username, id: post.id, transport: 'web',
          media: media.map((item) => ({ kind: item.kind, mimeType: item.mimeType, bytes: item.bytes.byteLength }))
        },
        media
      }, {
        monitor: route.adapterType === MONITOR_ADAPTER_TYPE,
        ...(flight && !consumers.primary ? { pendingMedia: flight } : {})
      });
    } catch (error) {
      // Only the source the message belongs to is marked, as on the MTProto path.
      await markSourceError(route.sourceId, error).catch(() => undefined);
      log.error({ err: error, sourceId: route.sourceId, channel: route.username, id: post.id },
        'Telegram web message processing failed');
    }
  };

  /** New posts, oldest first. Each is proof the transport delivers, as every MTProto event is. */
  const deliver = async (state: ChannelState, posts: WebChannelPost[]): Promise<void> => {
    if (!posts.length) return;
    if (state.route.kind === 'alert') {
      noteCollectorUpdate();
      await ingestAlerts(state, posts, null);
      return;
    }
    for (const post of posts) {
      if (stopped || channels.get(state.route.username) !== state) return;
      noteCollectorUpdate();
      await processClassifierPost(state, post, undefined);
    }
  };

  const remember = (state: ChannelState, posts: WebChannelPost[]): void => {
    for (const post of posts) state.seen.set(post.id, digest(post.text));
    if (state.seen.size <= EDIT_MEMORY) return;
    const ids = [...state.seen.keys()].sort((left, right) => left - right);
    for (const id of ids.slice(0, state.seen.size - EDIT_MEMORY)) state.seen.delete(id);
  };

  /**
   * A post already read whose text changed is re-processed with its ORIGINAL publication time and
   * `editedAt` = now — the MTProto `EditedMessage` semantics (the preview does not say when the edit
   * happened). Only posts the page itself marks «edited» qualify: a digest that moved without that
   * mark is a rendering change, and replaying it would file a revision nobody made.
   */
  const reprocessEdits = async (state: ChannelState, posts: WebChannelPost[], now: number): Promise<void> => {
    const edited: WebChannelPost[] = [];
    for (const post of posts) {
      const known = state.seen.get(post.id);
      if (known === undefined) continue;
      const current = digest(post.text);
      if (known === current) continue;
      state.seen.set(post.id, current);
      if (post.edited) edited.push(post);
    }
    const editedAt = new Date(now);
    for (const post of edited) {
      if (stopped || channels.get(state.route.username) !== state) return;
      noteCollectorUpdate();
      if (state.route.kind === 'alert') await ingestAlerts(state, [post], editedAt);
      else await processClassifierPost(state, post, editedAt);
    }
  };

  // ---- one request ---------------------------------------------------------------------------

  const firstPage = async (state: ChannelState, page: ChannelPage, now: number): Promise<void> => {
    const route = state.route;
    state.refreshedAt = now;
    state.cursor = page.newestId;
    // What the archive already holds for this source. A restart re-reads the newest page of every
    // channel, and without this every post on it would be classified a second time — in `codex`
    // mode, a model call each.
    const stored = await newestStoredExternalId(route.sourceId).catch((error: unknown) => {
      log.warn?.({ err: error, sourceId: route.sourceId }, 'newest archived message could not be read; the whole first page is treated as new');
      return null;
    });
    const unseen = page.posts.filter((post) => stored === null || post.id > stored);
    const oldest = page.oldestId ?? Number.POSITIVE_INFINITY;
    const reachesArchive = stored === null || page.olderFrom === null || oldest <= stored + 1;

    if (route.kind === 'alert') {
      remember(state, page.posts);
      // The first page is this transport's reconnect window, and it obeys the MTProto window's two
      // bounds: `ALERT_CHANNEL_BACKFILL_MESSAGES=0` switches replay off, and nothing older than
      // `ALERT_CHANNEL_BACKFILL_SECONDS` is applied — a three-day-old 🔴 for a raion whose state row
      // is older still would otherwise raise an alert that ended days ago.
      const cutoff = now - config.ALERT_CHANNEL_BACKFILL_SECONDS * 1000;
      const replay = config.ALERT_CHANNEL_BACKFILL_MESSAGES > 0
        ? unseen.filter((post) => post.publishedAt.getTime() >= cutoff).slice(-config.ALERT_CHANNEL_BACKFILL_MESSAGES)
        : [];
      if (!reachesArchive) {
        log.warn?.({
          sourceId: route.sourceId, channel: route.username, storedThrough: stored, windowFrom: page.oldestId,
          missingMessages: stored === null ? null : oldest - stored - 1
        }, 'alert channel first page did not reach the newest stored message; messages in between were never read');
      }
      await deliver(state, replay);
      return;
    }

    if (!reachesArchive && stored !== null && oldest - stored <= BRIDGE_IDS) {
      // A gap wider than one page but narrower than one catch-up cycle: walk it forward from the
      // archive with `after`, in order, through the live path — the delivery age ceiling archives
      // what is stale. The newest page is read again at the end of that walk, not delivered now:
      // delivering it first would put the channel's newest posts ahead of the ones before them.
      state.cursor = stored;
      state.mustWalk = true;
      log.info({ channel: route.username, sourceId: route.sourceId, storedThrough: stored, windowFrom: page.oldestId },
        'Telegram web first page is ahead of the archive; walking forward from the newest stored message');
      return;
    }
    if (!reachesArchive) {
      log.warn?.({
        sourceId: route.sourceId, channel: route.username, storedThrough: stored, windowFrom: page.oldestId,
        missingMessages: stored === null ? null : oldest - stored - 1
      }, 'Telegram web first page is too far ahead of the archive to walk; reading from the live edge');
    }
    remember(state, page.posts);
    await deliver(state, unseen);
  };

  /** A page read without `after` once the cursor exists: edits first, then anything new. */
  const refreshPage = async (state: ChannelState, page: ChannelPage, now: number): Promise<boolean> => {
    state.refreshedAt = now;
    const cursor = state.cursor ?? 0;
    await reprocessEdits(state, page.posts, now);
    const fresh = page.posts.filter((post) => post.id > cursor);
    const reachesCursor = page.olderFrom === null || (page.oldestId ?? Number.POSITIVE_INFINITY) <= cursor + 1;
    if (fresh.length && !reachesCursor) {
      // More than a page arrived since the last read; walking forward keeps them in order.
      state.mustWalk = true;
      return true;
    }
    state.cursor = Math.max(cursor, page.newestId ?? cursor);
    remember(state, fresh);
    await deliver(state, fresh);
    return false;
  };

  /** A page read with `after`: new posts, and whether more follow. */
  const afterPage = async (state: ChannelState, page: ChannelPage, now: number): Promise<boolean> => {
    const cursor = state.cursor ?? 0;
    // The page can repeat an album the cursor sits inside of; a post that changed there is an edit.
    await reprocessEdits(state, page.posts, now);
    const fresh = page.posts.filter((post) => post.id > cursor);
    state.cursor = Math.max(cursor, page.newestId ?? cursor, page.newerFrom ?? cursor);
    remember(state, fresh);
    await deliver(state, fresh);
    const more = page.newerFrom !== null || page.widgets >= PAGE_SIZE;
    // A page that did not move the cursor cannot be followed by one that does.
    return more && state.cursor > cursor;
  };

  const pollChannel = async (state: ChannelState): Promise<void> => {
    const route = state.route;
    const kind: PollKind = state.cursor === null ? 'first'
      : !state.mustWalk && clock() - state.refreshedAt >= EDIT_CHECK_INTERVAL_MS ? 'refresh' : 'after';
    let outcome: PageOutcome;
    try {
      outcome = await requestPage(route.username, kind === 'after' ? { after: state.cursor ?? 0 } : {});
    } finally {
      releaseSlot();
    }
    try {
      if (stopped || channels.get(route.username) !== state) return;
      const now = clock();
      if (outcome.kind !== 'page') {
        // Any refusal ends the cycle; the next one starts from the same cursor.
        state.cyclePages = 0;
        if (outcome.kind === 'throttled') {
          // Read again as soon as the pause ends; the pause itself is global.
          state.dueAt = now;
        } else if (outcome.kind === 'missing') {
          markUnresolved(state, outcome.reason);
          state.dueAt = now + UNRESOLVED_RETRY_MS;
        } else {
          state.failures += 1;
          if (state.failures === 1) {
            log.warn?.({ err: outcome.error, channel: route.username, sourceId: route.sourceId },
              'Telegram web page request failed');
          }
          if (!state.everRead || state.failures >= FAILING_AFTER) {
            markUnresolved(state, outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
          }
          state.dueAt = now + intervalFor(state, now);
        }
        return;
      }

      const page = outcome.page;
      if (kind !== 'after' && !page.posts.length) {
        // A channel's newest page ALWAYS lists messages. None at all is the missing-channel case the
        // measurement did not show; widgets with nothing readable in them is what a changed page
        // layout looks like — and a parser that reads nothing must be loud, never «nothing new».
        state.cyclePages = 0;
        markUnresolved(state, page.widgets ? 'no_readable_posts' : 'no_posts');
        state.dueAt = now + intervalFor(state, now);
        return;
      }
      // Only a page read WITHOUT `after` clears «not readable». An `after` page is empty on a quiet
      // channel and under a broken parser alike; letting it clear the standing would flap a broken
      // channel between `ready` and `degraded` once a minute, a notice at every flap.
      if (kind !== 'after' || state.standing !== 'unresolved') {
        if (state.standing === 'unresolved') {
          log.info({ channel: route.username, sourceId: route.sourceId }, 'Telegram channel preview is readable again');
        }
        state.standing = 'ok';
        state.failures = 0;
        state.everRead = true;
        state.lastReadAt = now;
      }
      // Now, not after routing, which can take a model call per post: readiness must not wait for it.
      publishStatus();
      for (const post of page.posts) {
        state.newestPublishedAt = Math.max(state.newestPublishedAt, post.publishedAt.getTime());
      }
      state.cyclePages += 1;
      let more: boolean;
      if (kind === 'first') {
        await firstPage(state, page, now);
        more = state.mustWalk;
      } else if (kind === 'refresh') {
        more = await refreshPage(state, page, now);
      } else {
        more = await afterPage(state, page, now);
      }
      const finished = clock();
      if (more && state.cyclePages < CATCH_UP_PAGES) {
        state.dueAt = finished;
        return;
      }
      // Cycle over: either the live edge was reached, or the page ceiling was — in which case the
      // next cycle keeps walking rather than refreshing a page that would not reach the cursor.
      state.mustWalk = more;
      state.cyclePages = 0;
      state.dueAt = finished + intervalFor(state, finished);
    } catch (error) {
      log.error({ err: error, channel: route.username, sourceId: route.sourceId },
        'Telegram web page could not be handled');
      state.cyclePages = 0;
      state.dueAt = clock() + COLD_INTERVAL_MS;
    } finally {
      state.busy = false;
      publishStatus();
      pump();
    }
  };

  // ---- catch-up backfill port ------------------------------------------------------------------

  /** One history page through the same dispatcher, budget and backoff the live polls use. */
  const historyRequest = (username: string, query: PageQuery): Promise<PageOutcome> => {
    if (stopped) return Promise.reject(new Error('Telegram web collector is stopped'));
    if (throttle && clock() < throttle.until) {
      return Promise.reject(new Error(`t.me backoff is in force until ${new Date(throttle.until).toISOString()}`));
    }
    if (backfillQueue.length >= BACKFILL_WAITERS) {
      return Promise.reject(new Error('Telegram web catch-up queue is full'));
    }
    return new Promise<PageOutcome>((resolve, reject) => {
      backfillQueue.push({
        enqueuedAt: clock(),
        fail: reject,
        run: () => {
          void requestPage(username, query).then((outcome) => {
            releaseSlot();
            resolve(outcome);
          });
        }
      });
      pump();
    });
  };

  /**
   * The port `startClassifierBackfill` consumes. Classifier routes only — an alert channel is not
   * reachable through it, the same structural guarantee the MTProto port gives.
   *
   * `history` answers MTProto's contract: up to `limit` messages strictly older than `offsetId` (the
   * newest when it is 0), newest first. A preview page holds twenty, so one call reads as many pages
   * as `limit` needs; returning fewer than `limit` is what tells the sweep the history is exhausted.
   */
  const backfillPort: BackfillPort = {
    routes: () => [...channels.values()]
      .map((state) => state.route)
      .filter((route): route is Extract<ChannelRoute, { kind: 'classifier' }> => route.kind === 'classifier')
      .map((route) => ({ sourceId: route.sourceId, username: route.username, adapterType: route.adapterType })),
    async history(username, request): Promise<BackfillRawMessage[]> {
      const state = channels.get(username.toLowerCase());
      if (!state || state.route.kind !== 'classifier') {
        throw new Error(`Telegram channel ${username} is not a classifier route of the web collector`);
      }
      const collected: WebChannelPost[] = [];
      let before = request.offsetId > 0 ? request.offsetId : null;
      const maxRequests = Math.ceil(request.limit / PAGE_SIZE) + 2;
      for (let made = 0; made < maxRequests && collected.length < request.limit; made += 1) {
        const outcome = await historyRequest(state.route.username, before === null ? {} : { before });
        if (outcome.kind === 'throttled') throw new Error(`t.me answered HTTP ${outcome.status}`);
        if (outcome.kind === 'missing') throw new Error(`Telegram channel @${username} has no public preview (${outcome.reason})`);
        if (outcome.kind === 'failed') {
          throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        }
        const page = outcome.page;
        collected.push(...page.posts.filter((post) => before === null || post.id < before));
        const next = page.oldestId;
        if (next === null || (page.olderFrom === null && page.widgets < PAGE_SIZE)) break;
        if (before !== null && next >= before) break;
        before = next;
      }
      return collected
        .sort((left, right) => right.id - left.id)
        .slice(0, request.limit)
        .map((post) => ({
          id: post.id,
          date: Math.floor(post.publishedAt.getTime() / 1000),
          message: post.text || null
        }));
    }
  };

  // ---- registry --------------------------------------------------------------------------------

  const adopt = (routes: Map<string, ChannelRoute>): { added: string[]; removed: string[] } => {
    const now = clock();
    const next = new Map<string, ChannelState>();
    const added: string[] = [];
    for (const [key, route] of routes) {
      const current = channels.get(key);
      // Same channel, same source, same destination: keep the cursor, the edit memory and the
      // standing. Anything else is a different route and starts from its own first page.
      if (current && current.route.kind === route.kind && current.route.sourceId === route.sourceId) {
        current.route = route;
        next.set(key, current);
      } else {
        next.set(key, {
          route, cursor: null, dueAt: now, busy: false, cyclePages: 0, mustWalk: false,
          newestPublishedAt: 0, refreshedAt: 0, seen: new Map(), standing: 'pending', failures: 0,
          everRead: false, lastReadAt: 0
        });
        added.push(key);
      }
    }
    const removed = [...channels.keys()].filter((key) => !next.has(key));
    channels = next;
    return { added, removed };
  };

  let reloading: Promise<void> | null = null;
  let reloadAgain = false;
  const reload = (): void => {
    if (stopped) return;
    if (reloading) { reloadAgain = true; return; }
    reloading = (async () => {
      try {
        do {
          reloadAgain = false;
          const routes = await resolveChannelRoutes(log);
          if (stopped) return;
          const { added, removed } = adopt(routes);
          log.info({ channels: channels.size, added, removed }, 'Telegram web collector re-read the source registry');
          publishStatus();
          pump();
        } while (reloadAgain && !stopped);
      } catch (error) {
        log.error({ err: error }, 'Telegram web collector could not re-read the source registry');
      } finally {
        reloading = null;
      }
    })();
  };

  // ---- start -----------------------------------------------------------------------------------

  bindTelegramCollector(log, reload);
  setCollectorStatus({
    transport: 'web', state: 'starting', handlersReady: false, channels: 0, resolved: 0, unresolved: [],
    unsubscribed: [], floodWaitUntil: null, floodWaitSeconds: null, detail: 'loading_registry'
  });
  adopt(await resolveChannelRoutes(log));
  const heartbeat = setInterval(beat, heartbeatMs);
  heartbeat.unref();
  const routes = [...channels.values()].map((state) => state.route);
  log.info({
    channels: routes.length,
    alertChannels: routes.filter((route) => route.kind === 'alert').length,
    ratePerSecond: Math.round(1000 / REQUEST_SPACING_MS), maxInFlight: MAX_IN_FLIGHT
  }, 'Telegram web collector started');
  publishStatus();
  pump();

  return async () => {
    if (stopped) return;
    stopped = true;
    bindTelegramCollector(log, null);
    cancelWake?.();
    cancelWake = null;
    clearInterval(heartbeat);
    stopBackfill?.();
    stopBackfill = null;
    halt.abort();
    for (const waiter of backfillQueue.splice(0)) waiter.fail(new Error('Telegram web collector is stopped'));
    setCollectorStatus({
      transport: 'web', state: 'disabled', handlersReady: false, channels: 0, resolved: 0, unresolved: [],
      unsubscribed: [], floodWaitUntil: null, floodWaitSeconds: null, detail: 'stopped'
    });
  };
}
