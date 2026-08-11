import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MTProto collector's startup contract, driven against the REAL teleproto event builders.
 *
 * The failure this file exists to pin is not a wrong value, it is a wrong number of network calls.
 * `new NewMessage({ chats })` resolves nothing at construction time; the library defers the whole
 * list to the first arriving update, once per builder, and — because a failed resolve leaves
 * `resolved === false` — retries it on every update after that
 * (`teleproto/client/updates.js:85-92`, `teleproto/events/common.js:75-81`). With 54 handles that is
 * a `contacts.ResolveUsername` avalanche, and an unresolved builder silently discards every event it
 * is handed (`teleproto/events/common.js:86-88`), so nothing arrives to make the failure visible.
 *
 * That is why the fake client here is hostile rather than permissive: `getInputEntity` — the call
 * `_intoIdSet` makes for anything it cannot parse as an id (`teleproto/events/common.js:50`) —
 * throws. Any test in which a builder still tries to resolve a username fails on that call rather
 * than on a count someone has to remember to assert. `NewMessage` and `EditedMessage` are the real
 * classes for the same reason: a hand-written stand-in would prove nothing about the library.
 *
 * Nothing here touches PostgreSQL or a network. The registry and the two `markSource*` writers are
 * module mocks; the client, the timers behind the flood-wait retry and the heartbeat interval are
 * injected through `TelegramCollectorDeps`.
 */

// ------------------------------------------------------------------------------------------------
// Module mocks
// ------------------------------------------------------------------------------------------------

const configState = vi.hoisted(() => ({
  TELEGRAM_API_ID: '1000', TELEGRAM_API_HASH: 'api-hash', TELEGRAM_SESSION: 'session',
  // Read by `src/bot/admin-notice.ts`, which `setCollectorStatus` now calls on a state flip, and by
  // the timestamp formatter that notice goes through. Empty by default: every test in this file
  // other than the «operator notices» block is about the collector, not about who hears from it.
  TELEGRAM_ADMIN_CHAT_ID: '', APP_TIMEZONE: 'Europe/Kyiv',
  ALERT_CHANNEL_ENABLED: true, ALERT_CHANNEL_USERNAME: 'air_alert_ua',
  // Backfill is a separate concern with its own coverage; leaving it on would only make every test
  // here also assert `getMessages` paging.
  ALERT_CHANNEL_BACKFILL_MESSAGES: 0, ALERT_CHANNEL_BACKFILL_SECONDS: 21_600,
  // Same argument for the classifier catch-up the collector now starts once its channels are bound:
  // its decision logic, its window arithmetic and its idempotency have their own coverage in
  // `src/services/source-backfill.test.ts` and `tests/integration/classifier-backfill.test.ts`.
  // Leaving it on here would put a `pool.query` — i.e. a real TCP connection — behind every readiness
  // assertion in this file. Off, `startClassifierBackfill` returns its stop closure and issues
  // nothing, which is exactly the seam under test: the collector starts it and does not wait for it.
  CLASSIFIER_BACKFILL_ENABLED: false, CLASSIFIER_BACKFILL_MIN_GAP_SECONDS: 3600,
  CLASSIFIER_BACKFILL_MAX_AGE_SECONDS: 21_600, CLASSIFIER_BACKFILL_MAX_MESSAGES: 300,
  CLASSIFIER_BACKFILL_MAX_PAGES: 5, CLASSIFIER_BACKFILL_PAGE_SIZE: 100,
  CLASSIFIER_BACKFILL_MAX_SOURCES_PER_SWEEP: 10, CLASSIFIER_BACKFILL_SOURCE_DELAY_MS: 0,
  CLASSIFIER_BACKFILL_MIN_RERUN_SECONDS: 3600, CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS: 0
}));

const registry = vi.hoisted(() => ({
  alert: [] as Array<{ sourceId: string; username: string }>,
  monitored: [] as Array<{ sourceId: string; username: string; adapterType: string }>,
  alertError: null as Error | null,
  monitoredError: null as Error | null
}));

const ingested = vi.hoisted(() => ({
  classifier: [] as Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>,
  alerts: [] as Array<{ sourceId: string; messages: Array<Record<string, unknown>> }>
}));

const operations = vi.hoisted(() => ({
  successes: [] as string[],
  errors: [] as Array<{ sourceId: string; message: string }>,
  timeline: [] as string[]
}));

vi.mock('../config.js', () => ({ config: configState }));

vi.mock('../services/ingestion.js', () => ({
  ALERT_CHANNEL_SOURCE_ID: 'air-alert-ua',
  // Read by `src/services/source-backfill.ts`, which the collector now imports for the catch-up port.
  // A partial module mock has to name every export the whole import graph reaches, not only the ones
  // this file calls.
  ALERT_CHANNEL_ADAPTER_TYPE: 'mtproto_alert_channel',
  MONITOR_ADAPTER_TYPE: 'mtproto_monitor',
  loadAlertChannels: async () => {
    if (registry.alertError) throw registry.alertError;
    return registry.alert;
  },
  loadMonitoredTelegramChannels: async () => {
    if (registry.monitoredError) throw registry.monitoredError;
    return registry.monitored;
  },
  processMessage: async (message: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    ingested.classifier.push({ message, options });
    return { ignored: true as const };
  },
  ingestAlertChannelMessages: async (sourceId: string, messages: Array<Record<string, unknown>>) => {
    ingested.alerts.push({ sourceId, messages });
    return { events: 0, ignored: 0, unrecognized: 0, applied: 0, skippedStale: 0, unresolved: [] };
  }
}));

vi.mock('../services/operations.js', () => ({
  markSourceSuccess: async (sourceId: string) => {
    operations.successes.push(sourceId);
    operations.timeline.push(`success:${sourceId}`);
  },
  markSourceError: async (sourceId: string, error: unknown) => {
    operations.errors.push({ sourceId, message: error instanceof Error ? error.message : String(error) });
    operations.timeline.push(`error:${sourceId}`);
  }
}));

import { resetAdminNotices, setAdminNoticeBot } from '../bot/admin-notice.js';
import {
  floodWaitSeconds, requestTelegramCollectorReload, resetTelegramCollectorStatus, resolveChannelPeers, startTelegramCollector,
  telegramCollectorStatus, type ChannelRoute, type TelegramCollectorRuntime
} from './telegram.js';

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

/** Seven official alert channels, forty-six monitors and the Air Force channel: 54 live routes. */
const ALERT_CHANNELS = [
  'air_alert_ua', 'khersonskaoda', 'kherson_miskrada', 'kyivoda', 'vinnytsiaoda', 'oda_rv', 'slv_vca'
];
const MONITOR_CHANNELS = Array.from({ length: 46 }, (_, index) => `osint_monitor_${index + 1}`);
const AIR_FORCE = 'kpszsu';
const ALL_CHANNELS = [...ALERT_CHANNELS, ...MONITOR_CHANNELS, AIR_FORCE];

function sourceIdFor(username: string): string {
  return `src-${username}`;
}

/** Marked channel ids, the `-100…` shape `getPeerId` produces (`teleproto/Utils.js:1111-1120`). */
function peerIdFor(username: string): string {
  return `-100${1_000_000_000 + ALL_CHANNELS.indexOf(username)}`;
}

function useRegistry(channels: string[] = ALL_CHANNELS): void {
  registry.alert = channels.filter((handle) => ALERT_CHANNELS.includes(handle))
    .map((username) => ({ sourceId: sourceIdFor(username), username }));
  registry.monitored = channels.filter((handle) => !ALERT_CHANNELS.includes(handle))
    .map((username) => ({
      sourceId: sourceIdFor(username), username,
      adapterType: username === AIR_FORCE ? 'mtproto' : 'mtproto_monitor'
    }));
}

interface FakeClientOptions {
  /** Handles the dialog scan reports. Everything else falls through to `getPeerId`. */
  dialogs?: string[];
  /** Thrown by `getDialogs` on the given (1-based) pass. */
  dialogsError?: Error | null;
  /** Consulted for every `getPeerId`; returning an Error makes that lookup fail. */
  onGetPeerId?: (username: string, callIndex: number) => Error | void;
}

interface FakeClient {
  client: Record<string, any>;
  calls: { dialogScans: number; peerLookups: string[]; inputEntities: unknown[]; disconnects: number };
  handlers: Array<[(event: any) => Promise<void>, any]>;
}

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls = { dialogScans: 0, peerLookups: [] as string[], inputEntities: [] as unknown[], disconnects: 0 };
  const handlers: Array<[(event: any) => Promise<void>, any]> = [];
  const visible = options.dialogs ?? ALL_CHANNELS;
  const client = {
    async getDialogs() {
      calls.dialogScans += 1;
      if (options.dialogsError && calls.dialogScans === 1) throw options.dialogsError;
      return visible.map((username) => ({
        id: peerIdFor(username),
        entity: { username: username.toUpperCase(), usernames: [{ username: `${username}_alt` }] }
      }));
    },
    async getPeerId(username: string) {
      calls.peerLookups.push(username);
      const outcome = options.onGetPeerId?.(username, calls.peerLookups.length);
      if (outcome instanceof Error) throw outcome;
      return peerIdFor(username);
    },
    async getInputEntity(peer: unknown) {
      calls.inputEntities.push(peer);
      throw new Error(`getInputEntity must never run during startup (asked for ${String(peer)})`);
    },
    async getMessages() { return []; },
    addEventHandler(callback: (event: any) => Promise<void>, builder: any) { handlers.push([callback, builder]); },
    removeEventHandler(callback: (event: any) => Promise<void>, builder: any) {
      for (let index = handlers.length - 1; index >= 0; index -= 1) {
        const entry = handlers[index];
        if (entry && (entry[0] === callback || entry[1] === builder)) handlers.splice(index, 1);
      }
    },
    async disconnect() { calls.disconnects += 1; },
    _log: { error: () => undefined, warn: () => undefined }
  };
  return { client, calls, handlers };
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface ArmedTimer { ms: number; run: () => void; cancelled: boolean }

function timerSeam(armed: ArmedTimer[]) {
  return (run: () => void, ms: number) => {
    const timer: ArmedTimer = { ms, run, cancelled: false };
    armed.push(timer);
    return () => { timer.cancelled = true; };
  };
}

let NewMessage: TelegramCollectorRuntime['NewMessage'];
let EditedMessage: TelegramCollectorRuntime['EditedMessage'];
let FloodWaitError: new (args: { capture: number }) => Error & { seconds: number };

async function start(fake: FakeClient, armed: ArmedTimer[] = [], heartbeatMs = 60_000) {
  return startTelegramCollector(silentLog, {
    createRuntime: async () => ({ client: fake.client, NewMessage, EditedMessage }),
    schedule: timerSeam(armed),
    heartbeatMs
  });
}

/**
 * One update, delivered the way `_dispatchUpdate` delivers it.
 *
 * The `build` step is skipped — it only turns a raw `Api.Update` into an event object — but the two
 * steps this file is about are the real ones: a builder that has not resolved delivers nothing, and
 * the chat filter is `this.chats.includes(event.chatId.toString())`
 * (`teleproto/events/common.js:85-99`). `kind` picks the builder the same way `build` would, since
 * `EditedMessage` extends `NewMessage` and would otherwise match a new message too.
 */
async function deliver(fake: FakeClient, kind: 'new' | 'edited', event: Record<string, unknown>): Promise<boolean> {
  const entry = fake.handlers[kind === 'new' ? 0 : 1];
  if (!entry) return false;
  const [callback, builder] = entry;
  if (!builder.resolved) return false;
  if (!builder.filter(event)) return false;
  await callback(event);
  return true;
}

function channelMessage(username: string, overrides: Record<string, unknown> = {}) {
  return {
    chatId: peerIdFor(username),
    message: {
      id: 4242, message: 'Загроза БпЛА для Полтавщини', date: 1_800_000_000, out: false,
      ...overrides
    }
  };
}

beforeAll(async () => {
  const events = await import('teleproto/events/index.js');
  const edited = await import('teleproto/events/EditedMessage.js');
  const errors = await import('teleproto/errors/index.js');
  NewMessage = events.NewMessage as never;
  EditedMessage = edited.EditedMessage as never;
  FloodWaitError = errors.FloodWaitError as never;
});

beforeEach(() => {
  useRegistry();
  registry.alertError = null;
  registry.monitoredError = null;
  ingested.classifier = [];
  ingested.alerts = [];
  operations.successes = [];
  operations.errors = [];
  operations.timeline = [];
  configState.TELEGRAM_ADMIN_CHAT_ID = '';
  resetAdminNotices();
  resetTelegramCollectorStatus();
});

// ------------------------------------------------------------------------------------------------
// One resolve pass for the whole list
// ------------------------------------------------------------------------------------------------

describe('startup resolution', () => {
  it('binds 54 channels with one dialog scan and no username resolve at all', async () => {
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      expect(ALL_CHANNELS).toHaveLength(54);
      expect(fake.calls.dialogScans).toBe(1);
      // The whole point: not one `contacts.ResolveUsername`, from us or from either builder.
      expect(fake.calls.peerLookups).toEqual([]);
      expect(fake.calls.inputEntities).toEqual([]);
      expect(telegramCollectorStatus()).toMatchObject({
        state: 'ready', handlersReady: true, channels: 54, resolved: 54, unresolved: [],
        floodWaitSeconds: null, floodWaitUntil: null
      });
    } finally { await stop?.(); }
  });

  it('passes numeric peer ids to both builders and resolves them before any update arrives', async () => {
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      expect(fake.handlers).toHaveLength(2);
      const [newBuilder, editedBuilder] = fake.handlers.map((entry) => entry[1]);
      expect(newBuilder).toBeInstanceOf(NewMessage);
      expect(editedBuilder).toBeInstanceOf(EditedMessage);
      // `resolve()` has already run, so `chats` is the id SET `_intoIdSet` produced — which for a
      // marked (negative) id is the id itself, added without a lookup
      // (`teleproto/events/common.js:25-32`).
      for (const builder of [newBuilder, editedBuilder]) {
        expect(builder.resolved).toBe(true);
        expect([...builder.chats].sort()).toEqual(ALL_CHANNELS.map(peerIdFor).sort());
        for (const chat of builder.chats) expect(chat).toMatch(/^-100\d+$/);
      }
    } finally { await stop?.(); }
  });

  it('matches a channel by any of its handles, whatever case the entity reports', async () => {
    // The fake reports every dialog's username upper-cased and adds a collectible alias; the
    // registry stores lower-cased primaries. A case-sensitive comparison would bind nothing.
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      expect(telegramCollectorStatus().resolved).toBe(54);
      expect(fake.calls.peerLookups).toEqual([]);
    } finally { await stop?.(); }
  });

  it('falls back to a bounded per-username lookup only for handles the dialog list is missing', async () => {
    const missing = MONITOR_CHANNELS.slice(0, 3);
    const fake = fakeClient({ dialogs: ALL_CHANNELS.filter((handle) => !missing.includes(handle)) });
    const stop = await start(fake);
    try {
      expect(fake.calls.dialogScans).toBe(1);
      expect(fake.calls.peerLookups).toEqual(missing);
      expect(telegramCollectorStatus()).toMatchObject({ state: 'ready', resolved: 54, unresolved: [] });
    } finally { await stop?.(); }
  });

  it('still resolves every handle by name when the dialog scan itself fails', async () => {
    const fake = fakeClient({ dialogsError: new Error('DIALOGS_UNAVAILABLE') });
    const stop = await start(fake);
    try {
      expect(fake.calls.peerLookups).toHaveLength(54);
      expect(telegramCollectorStatus()).toMatchObject({ state: 'ready', resolved: 54 });
    } finally { await stop?.(); }
  });
});

// ------------------------------------------------------------------------------------------------
// A failure part-way down the list
// ------------------------------------------------------------------------------------------------

describe('a resolve failure mid-list', () => {
  it('keeps the other 53 channels live and reports the one it lost', async () => {
    const broken = MONITOR_CHANNELS[10] as string;
    const fake = fakeClient({
      dialogs: ALL_CHANNELS.filter((handle) => handle !== broken),
      onGetPeerId: (username) => (username === broken ? new Error('No user has "…" as username') : undefined)
    });
    const stop = await start(fake);
    try {
      const status = telegramCollectorStatus();
      expect(status).toMatchObject({ state: 'degraded', handlersReady: true, channels: 54, resolved: 53 });
      expect(status.unresolved).toEqual([broken]);
      // Live channels are marked successful; the lost one is marked in error rather than left
      // `unknown`, which `updateSourceFreshness` would never move.
      expect(operations.successes).toHaveLength(53);
      expect(operations.successes).not.toContain(sourceIdFor(broken));
      expect(operations.errors).toEqual([expect.objectContaining({ sourceId: sourceIdFor(broken) })]);
      // The failure does not become a resolve storm: one attempt for that handle, none for the rest.
      expect(fake.calls.peerLookups).toEqual([broken]);
    } finally { await stop?.(); }
  });

  it('does not attach handlers, mark sources or start a heartbeat when nothing resolves', async () => {
    const fake = fakeClient({
      dialogs: [], onGetPeerId: () => new Error('CHANNEL_PRIVATE')
    });
    const stop = await start(fake, [], 5);
    try {
      expect(fake.handlers).toHaveLength(0);
      expect(operations.successes).toEqual([]);
      expect(telegramCollectorStatus()).toMatchObject({
        state: 'failed', handlersReady: false, resolved: 0, detail: 'no_channels_resolved'
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(operations.successes).toEqual([]);
    } finally { await stop?.(); }
  });
});

// ------------------------------------------------------------------------------------------------
// Flood waits
// ------------------------------------------------------------------------------------------------

describe('flood-wait handling', () => {
  it('reads the interval off a real FloodWaitError', () => {
    const flood = new FloodWaitError({ capture: 1800 });
    expect(flood.seconds).toBe(1800);
    expect(floodWaitSeconds(flood)).toBe(1800);
    expect(floodWaitSeconds({ errorMessage: 'FLOOD_WAIT_45' })).toBe(45);
    expect(floodWaitSeconds({ message: 'Please wait 12 seconds before repeating the action.' })).toBe(12);
    expect(floodWaitSeconds(new Error('CHANNEL_PRIVATE'))).toBeNull();
    expect(floodWaitSeconds(null)).toBeNull();
  });

  it('stops the resolve pass at the first flood wait instead of asking for the rest', async () => {
    const uncovered = MONITOR_CHANNELS.slice(0, 4);
    const fake = fakeClient({
      dialogs: ALL_CHANNELS.filter((handle) => !uncovered.includes(handle)),
      onGetPeerId: (_username, callIndex) => (callIndex === 1 ? new FloodWaitError({ capture: 1800 }) : undefined)
    });
    const armed: ArmedTimer[] = [];
    const stop = await start(fake, armed);
    try {
      // One request, then silence. The remaining three handles are reported unresolved without a
      // single further call — that is the retry storm the issue describes, and it must not exist.
      expect(fake.calls.peerLookups).toEqual([uncovered[0]]);
      const status = telegramCollectorStatus();
      expect(status).toMatchObject({
        state: 'degraded', handlersReady: true, floodWaitSeconds: 1800, detail: 'flood_wait_username'
      });
      expect(status.unresolved).toEqual(uncovered);
      expect(Date.parse(status.floodWaitUntil as string) - Date.now()).toBeGreaterThan(1_700_000);
      // The 50 channels that did resolve stay live: a flood wait on one handle must not take the
      // official alert channels off the air.
      expect(operations.successes).toHaveLength(50);
      // And the retry for the three that are still missing waits the interval Telegram named — not
      // the shorter default, which would issue a resolve inside an active wait.
      expect(armed.filter((timer) => !timer.cancelled)).toHaveLength(1);
      expect(armed[0]?.ms).toBe(1_800_000);
    } finally { await stop?.(); }
  });

  it('waits the interval Telegram named before it resolves anything again', async () => {
    const fake = fakeClient({
      dialogsError: new FloodWaitError({ capture: 900 })
    });
    const armed: ArmedTimer[] = [];
    const stop = await start(fake, armed);
    try {
      // A flood wait during the dialog scan aborts the pass whole: nothing else is asked for.
      expect(fake.calls.dialogScans).toBe(1);
      expect(fake.calls.peerLookups).toEqual([]);
      expect(fake.handlers).toHaveLength(0);
      expect(operations.successes).toEqual([]);
      expect(telegramCollectorStatus()).toMatchObject({
        state: 'flood_wait', handlersReady: false, resolved: 0, floodWaitSeconds: 900,
        detail: 'flood_wait_dialogs'
      });
      // Every source is reported unavailable with the reason, so `/api/v1/sources/health` stops
      // claiming a channel is being read.
      expect(operations.errors).toHaveLength(54);
      expect(operations.errors[0]?.message).toContain('900s');

      // Exactly one timer, armed for exactly the named interval.
      expect(armed.filter((timer) => !timer.cancelled)).toHaveLength(1);
      expect(armed[0]?.ms).toBe(900_000);

      // Nothing happens until it elapses.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.calls.dialogScans).toBe(1);

      // When it does, the pass runs again — and now succeeds.
      armed[0]?.run();
      await vi.waitFor(() => expect(telegramCollectorStatus().state).toBe('ready'));
      expect(fake.calls.dialogScans).toBe(2);
      expect(operations.successes).toHaveLength(54);
    } finally { await stop?.(); }
  });

  it('keeps the live handlers when a retry is itself cut short', async () => {
    // The retry runs while 53 channels are being read. If it flooded on the dialog scan and the
    // collector re-registered on its (empty) result, a transient wait would take down a working
    // subscription — the outage this module exists to prevent, arriving through its own repair path.
    const broken = MONITOR_CHANNELS[10] as string;
    let floodTheScan = false;
    const fake = fakeClient({
      dialogs: ALL_CHANNELS.filter((handle) => handle !== broken),
      onGetPeerId: (username) => (username === broken ? new Error('CHANNEL_PRIVATE') : undefined)
    });
    const scan = fake.client.getDialogs;
    fake.client.getDialogs = async () => {
      if (floodTheScan) { fake.calls.dialogScans += 1; throw new FloodWaitError({ capture: 1200 }); }
      return scan();
    };
    const armed: ArmedTimer[] = [];
    const stop = await start(fake, armed);
    try {
      expect(telegramCollectorStatus()).toMatchObject({ state: 'degraded', resolved: 53 });
      const builders = fake.handlers.map((entry) => entry[1]);
      expect(armed[0]?.ms).toBe(600_000);

      floodTheScan = true;
      armed[0]?.run();
      await vi.waitFor(() => expect(fake.calls.dialogScans).toBe(2));
      await vi.waitFor(() => expect(telegramCollectorStatus().floodWaitSeconds).toBe(1200));

      // Same builder objects, still resolved, still carrying the 53 peers.
      expect(fake.handlers.map((entry) => entry[1])).toEqual(builders);
      expect(telegramCollectorStatus()).toMatchObject({ state: 'degraded', handlersReady: true, resolved: 53 });
      expect(await deliver(fake, 'new', channelMessage(MONITOR_CHANNELS[0] as string))).toBe(true);
      // And the next attempt waits the newly named interval, not the shorter default.
      const live = armed.filter((timer) => !timer.cancelled);
      expect(live).toHaveLength(1);
      expect(live[0]?.ms).toBe(1_200_000);
    } finally { await stop?.(); }
  });

  it('rebinds after an Ops registry change and removes a disabled live route', async () => {
    const removed = MONITOR_CHANNELS[0] as string;
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      expect(await deliver(fake, 'new', channelMessage(removed))).toBe(true);
      useRegistry(ALL_CHANNELS.filter((handle) => handle !== removed));
      expect(requestTelegramCollectorReload()).toBe(true);
      await vi.waitFor(() => expect(fake.calls.dialogScans).toBe(2));
      await vi.waitFor(() => expect(telegramCollectorStatus().resolved).toBe(53));
      expect(telegramCollectorStatus()).toMatchObject({ state: 'ready', channels: 53, resolved: 53 });
      expect(await deliver(fake, 'new', channelMessage(removed))).toBe(false);
      expect(fake.handlers).toHaveLength(2);
    } finally { await stop?.(); }
    expect(requestTelegramCollectorReload()).toBe(false);
  });

  it('cancels the armed retry when the collector is stopped', async () => {
    const fake = fakeClient({ dialogsError: new FloodWaitError({ capture: 600 }) });
    const armed: ArmedTimer[] = [];
    const stop = await start(fake, armed);
    await stop?.();
    expect(armed.every((timer) => timer.cancelled)).toBe(true);
    expect(fake.calls.disconnects).toBe(1);
    expect(telegramCollectorStatus()).toMatchObject({ state: 'disabled', detail: 'stopped' });
  });
});

// ------------------------------------------------------------------------------------------------
// Readiness before success
// ------------------------------------------------------------------------------------------------

describe('handler readiness gates the success marks', () => {
  it('marks no source and starts no heartbeat until both builders have resolved', async () => {
    const order: string[] = [];
    class TracedNew extends (NewMessage as any) {
      async resolve(client: unknown) { await super.resolve(client); order.push('resolved:new'); }
    }
    class TracedEdited extends (EditedMessage as any) {
      async resolve(client: unknown) { await super.resolve(client); order.push('resolved:edited'); }
    }
    const fake = fakeClient();
    const stop = await startTelegramCollector(silentLog, {
      createRuntime: async () => ({
        client: fake.client, NewMessage: TracedNew as never, EditedMessage: TracedEdited as never
      }),
      schedule: timerSeam([])
    });
    try {
      const firstSuccess = operations.timeline.findIndex((entry) => entry.startsWith('success:'));
      expect(firstSuccess).toBeGreaterThanOrEqual(0);
      expect(order).toEqual(['resolved:new', 'resolved:edited']);
      // Both resolutions completed before the first `markSourceSuccess` was even attempted.
      expect(operations.timeline.slice(0, firstSuccess).some((entry) => entry.startsWith('success:'))).toBe(false);
    } finally { await stop?.(); }
  });

  it('leaves every source unmarked when the second builder cannot resolve', async () => {
    class BrokenEdited extends (EditedMessage as any) {
      async resolve() { throw new Error('EDITED_BUILDER_FAILED'); }
    }
    const fake = fakeClient();
    const armed: ArmedTimer[] = [];
    const stop = await startTelegramCollector(silentLog, {
      createRuntime: async () => ({
        client: fake.client, NewMessage, EditedMessage: BrokenEdited as never
      }),
      schedule: timerSeam(armed), heartbeatMs: 5
    });
    try {
      expect(operations.successes).toEqual([]);
      expect(telegramCollectorStatus()).toMatchObject({
        state: 'failed', handlersReady: false, detail: 'handler_resolve_failed'
      });
      // Both builders are detached again, so a half-ready pair cannot deliver into a collector that
      // has told readiness it is not collecting.
      expect(fake.handlers).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(operations.successes).toEqual([]);
      expect(armed.filter((timer) => !timer.cancelled)).toHaveLength(1);
    } finally { await stop?.(); }
  });

  it('keeps marking the live sources on the heartbeat once it is ready', async () => {
    const fake = fakeClient({
      dialogs: ALERT_CHANNELS, onGetPeerId: () => new Error('CHANNEL_PRIVATE')
    });
    const stop = await start(fake, [], 5);
    try {
      const afterStartup = operations.successes.length;
      expect(afterStartup).toBe(ALERT_CHANNELS.length);
      await vi.waitFor(() => expect(operations.successes.length).toBeGreaterThan(afterStartup));
      // Only the channels that actually resolved are heartbeaten; the 47 that did not stay silent.
      const beaten = new Set(operations.successes);
      expect([...beaten].sort()).toEqual(ALERT_CHANNELS.map(sourceIdFor).sort());
    } finally { await stop?.(); }
  });
});

// ------------------------------------------------------------------------------------------------
// Delivery: the routing decision, now taken on the peer id
// ------------------------------------------------------------------------------------------------

describe('message delivery', () => {
  it('routes a monitoring-channel message into the classifier ingestion path', async () => {
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      const monitor = MONITOR_CHANNELS[7] as string;
      expect(await deliver(fake, 'new', channelMessage(monitor))).toBe(true);
      expect(ingested.alerts).toEqual([]);
      expect(ingested.classifier).toHaveLength(1);
      expect(ingested.classifier[0]?.message).toMatchObject({
        sourceId: sourceIdFor(monitor), externalId: '4242',
        text: 'Загроза БпЛА для Полтавщини'
      });
      expect(ingested.classifier[0]?.options).toEqual({ monitor: true });
      expect((ingested.classifier[0]?.message as any).rawPayload).toMatchObject({
        channel: monitor, peerId: peerIdFor(monitor), id: 4242
      });
      // No `getChat()`: `ChatGetter.getChat` walks `iterDialogs` whenever the entity is not cached
      // (`teleproto/tl/custom/chatGetter.js:49-73`), which would put a dialog scan on the hot path.
      expect(fake.calls.dialogScans).toBe(1);
      expect(fake.calls.inputEntities).toEqual([]);
    } finally { await stop?.(); }
  });

  it('routes an alert-channel message into the alert reconciliation path and never the classifier', async () => {
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      expect(await deliver(fake, 'new', channelMessage('kyivoda', {
        message: '🔴 Повітряна тривога в Броварському районі'
      }))).toBe(true);
      expect(ingested.classifier).toEqual([]);
      expect(ingested.alerts).toHaveLength(1);
      expect(ingested.alerts[0]?.sourceId).toBe(sourceIdFor('kyivoda'));
      expect(ingested.alerts[0]?.messages[0]).toMatchObject({
        externalId: '4242', text: '🔴 Повітряна тривога в Броварському районі'
      });
    } finally { await stop?.(); }
  });

  it('re-processes an edit with the original publication time', async () => {
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      const monitor = MONITOR_CHANNELS[2] as string;
      expect(await deliver(fake, 'edited', channelMessage(monitor, {
        date: 1_800_000_000, editDate: 1_800_000_600
      }))).toBe(true);
      const message = ingested.classifier[0]?.message as Record<string, Date>;
      expect(message.publishedAt?.getTime()).toBe(1_800_000_000_000);
      expect(message.editedAt?.getTime()).toBe(1_800_000_600_000);
    } finally { await stop?.(); }
  });

  it('drops a message from a channel that is not in the peer set', async () => {
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      const delivered = await deliver(fake, 'new', { chatId: '-1009999999999', message: { id: 1, message: 'x' } });
      // The library's own chat filter rejects it — nothing reaches our callback at all.
      expect(delivered).toBe(false);
      expect(ingested.classifier).toEqual([]);
      expect(ingested.alerts).toEqual([]);
    } finally { await stop?.(); }
  });
});

// ------------------------------------------------------------------------------------------------
// `resolveChannelPeers` on its own
// ------------------------------------------------------------------------------------------------

describe('resolveChannelPeers', () => {
  function routesFor(usernames: string[]): Map<string, ChannelRoute> {
    return new Map(usernames.map((username) => [username, {
      kind: 'classifier' as const, sourceId: sourceIdFor(username), username, adapterType: 'mtproto_monitor'
    }]));
  }

  it('reports how many lookups escaped the dialog pass', async () => {
    const fake = fakeClient({ dialogs: MONITOR_CHANNELS.slice(0, 2) });
    const resolution = await resolveChannelPeers(fake.client, routesFor(MONITOR_CHANNELS.slice(0, 5)), silentLog);
    expect(resolution.byPeerId.size).toBe(5);
    expect(resolution.usernameLookups).toBe(3);
    expect(resolution.floodWaitSeconds).toBeNull();
  });

  it('names the phase the wait landed in', async () => {
    const dialogs = fakeClient({ dialogsError: new FloodWaitError({ capture: 60 }) });
    const first = await resolveChannelPeers(dialogs.client, routesFor(MONITOR_CHANNELS.slice(0, 5)), silentLog);
    expect(first).toMatchObject({ floodWaitSeconds: 60, floodWaitPhase: 'dialogs', usernameLookups: 0 });
    expect(first.unresolved).toHaveLength(5);

    const byName = fakeClient({ dialogs: [], onGetPeerId: () => new FloodWaitError({ capture: 300 }) });
    const second = await resolveChannelPeers(byName.client, routesFor(MONITOR_CHANNELS.slice(0, 5)), silentLog);
    expect(second).toMatchObject({ floodWaitSeconds: 300, floodWaitPhase: 'username', usernameLookups: 1 });
    expect(second.unresolved).toHaveLength(5);
  });
});

// ------------------------------------------------------------------------------------------------
// One line per transition, never per tick
// ------------------------------------------------------------------------------------------------

/**
 * The operator notice, seen from the collector's side.
 *
 * `setCollectorStatus` is the one place the state word changes, so it is the one place a notice can
 * be emitted without double-counting; what this block pins is that the emission is keyed on the
 * CHANGE and not on the call. The retry path is the case that matters: `armRetry` re-enters
 * `attach()` every `RESOLVE_RETRY_MS` for as long as an upstream stays down, and every one of those
 * passes calls `setCollectorStatus` again with fresh counts. A notifier keyed on the call rather
 * than on the transition would send a Telegram message every ten minutes, forever, about a
 * condition the operator was told about once.
 *
 * The cooldown that bounds a genuinely FLAPPING transition is a property of the notifier and is
 * covered in `src/bot/admin-notice.test.ts`; here the clock is never moved.
 */
describe('operator notices', () => {
  function recorder() {
    const sent: string[] = [];
    setAdminNoticeBot({ api: { async sendMessage(_chatId: string, text: string) { sent.push(text); return {}; } } });
    return sent;
  }

  it('says nothing at all when the collector reaches ready', async () => {
    configState.TELEGRAM_ADMIN_CHAT_ID = '4242';
    const sent = recorder();
    const fake = fakeClient();
    const stop = await start(fake);
    try {
      expect(telegramCollectorStatus().state).toBe('ready');
      // `disabled → starting → ready` is the healthy path, and none of those three words is a
      // reason to wake anybody.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent).toEqual([]);
    } finally { await stop?.(); }
    // Neither is the stop, which lands on `disabled`.
    expect(sent).toEqual([]);
  });

  it('sends one line when the collector degrades, and nothing on a retry that stays degraded', async () => {
    configState.TELEGRAM_ADMIN_CHAT_ID = '4242';
    const sent = recorder();
    const broken = MONITOR_CHANNELS[10] as string;
    const fake = fakeClient({
      dialogs: ALL_CHANNELS.filter((handle) => handle !== broken),
      onGetPeerId: (username) => (username === broken ? new Error('CHANNEL_PRIVATE') : undefined)
    });
    const armed: ArmedTimer[] = [];
    const stop = await start(fake, armed);
    try {
      expect(telegramCollectorStatus()).toMatchObject({ state: 'degraded', resolved: 53 });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toContain('колектор Telegram деградував');
      expect(sent[0]).toContain('привʼязано 53 з 54');

      // The retry re-enters the same state with the same counts. One transition, one line.
      armed[0]?.run();
      await vi.waitFor(() => expect(fake.calls.dialogScans).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent).toHaveLength(1);
      expect(telegramCollectorStatus().state).toBe('degraded');
    } finally { await stop?.(); }
  });

  it('sends one line when no channel binds at all, naming the flood wait', async () => {
    configState.TELEGRAM_ADMIN_CHAT_ID = '4242';
    const sent = recorder();
    const fake = fakeClient({ dialogs: [], dialogsError: new FloodWaitError({ capture: 900 }) });
    const armed: ArmedTimer[] = [];
    const stop = await start(fake, armed);
    try {
      expect(telegramCollectorStatus()).toMatchObject({ state: 'flood_wait', resolved: 0 });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toContain('flood wait (900 с)');
      expect(sent[0]).toContain('⚠️ ThreatLens');
    } finally { await stop?.(); }
  });

  it('stays silent when TELEGRAM_ADMIN_CHAT_ID is empty, degraded or not', async () => {
    // The default for this file, restated as the property it is: an unset admin chat id is a
    // deployment that has not asked for these notices, not a deployment that fails to send them.
    const sent = recorder();
    const broken = MONITOR_CHANNELS[10] as string;
    const fake = fakeClient({
      dialogs: ALL_CHANNELS.filter((handle) => handle !== broken),
      onGetPeerId: (username) => (username === broken ? new Error('CHANNEL_PRIVATE') : undefined)
    });
    const stop = await start(fake, []);
    try {
      expect(telegramCollectorStatus().state).toBe('degraded');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent).toEqual([]);
    } finally { await stop?.(); }
  });
});
