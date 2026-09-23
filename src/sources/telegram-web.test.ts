import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackfillPort } from '../services/source-backfill.js';

/**
 * The web-preview collector, driven by real preview pages and a fake `fetch`.
 *
 * The parser half reads pages captured verbatim with curl on 2026-09-22 (`tests/fixtures/
 * telegram-web-*.html`): the claims it pins — which element is the text, what a reply quote, a
 * reaction or a link preview is NOT — are claims about Telegram's markup, and a hand-written page
 * would only prove the parser agrees with its author.
 *
 * The collector half serves synthetic pages in the same markup from an in-memory channel that pages
 * the way the preview measurably does (`after` → the following twenty, `before` → the preceding
 * twenty, «more» links when more exist). Nothing here touches PostgreSQL or the network: the
 * registry, ingestion and the source-health writers are module mocks, as in `./telegram.test.ts`.
 */

// ------------------------------------------------------------------------------------------------
// Module mocks
// ------------------------------------------------------------------------------------------------

const configState = vi.hoisted(() => ({
  // Read by `src/bot/admin-notice.ts` on every state flip the collector publishes.
  TELEGRAM_ADMIN_CHAT_ID: '', APP_TIMEZONE: 'Europe/Kyiv',
  ALERT_CHANNEL_ENABLED: true, ALERT_CHANNEL_USERNAME: 'air_alert_ua',
  ALERT_CHANNEL_BACKFILL_MESSAGES: 500, ALERT_CHANNEL_BACKFILL_SECONDS: 43_200,
  SHADOW_IMAGE_MAX_BYTES: 8_000_000, SHADOW_AUDIO_MAX_BYTES: 25_000_000
}));

const registry = vi.hoisted(() => ({
  alert: [] as Array<{ sourceId: string; username: string }>,
  monitored: [] as Array<{ sourceId: string; username: string; adapterType: string }>
}));

/** `newestStoredExternalId` per source: what the archive already holds. Empty means a fresh archive. */
const archive = vi.hoisted(() => ({ newest: new Map<string, number>() }));

const ingested = vi.hoisted(() => ({
  classifier: [] as Array<{ message: Record<string, any>; options: Record<string, any> }>,
  alerts: [] as Array<{ sourceId: string; messages: Array<Record<string, any>> }>
}));

const operations = vi.hoisted(() => ({
  successes: [] as string[],
  errors: [] as Array<{ sourceId: string; message: string }>
}));

const backfill = vi.hoisted(() => ({ port: null as BackfillPort | null }));

vi.mock('../config.js', () => ({ config: configState }));

vi.mock('../services/ingestion.js', () => ({
  ALERT_CHANNEL_SOURCE_ID: 'air-alert-ua',
  ALERT_CHANNEL_ADAPTER_TYPE: 'mtproto_alert_channel',
  MONITOR_ADAPTER_TYPE: 'mtproto_monitor',
  loadAlertChannels: async () => registry.alert,
  loadMonitoredTelegramChannels: async () => registry.monitored,
  newestStoredExternalId: async (sourceId: string) => archive.newest.get(sourceId) ?? null,
  processMessage: async (message: Record<string, any>, options: Record<string, any> = {}) => {
    ingested.classifier.push({ message, options });
    return { ignored: true as const };
  },
  ingestAlertChannelMessages: async (sourceId: string, messages: Array<Record<string, any>>) => {
    ingested.alerts.push({ sourceId, messages });
    return { events: 0, ignored: 0, unrecognized: 0, applied: 0, skippedStale: 0, unresolved: [] };
  }
}));

vi.mock('../services/operations.js', () => ({
  markSourceSuccess: async (sourceId: string) => { operations.successes.push(sourceId); },
  markSourcesSuccess: async (sourceIds: readonly string[]) => { operations.successes.push(...sourceIds); },
  markSourceError: async (sourceId: string, error: unknown) => {
    operations.errors.push({ sourceId, message: error instanceof Error ? error.message : String(error) });
  }
}));

// The sweep's own decisions have their coverage in `src/services/source-backfill.test.ts`; what is
// this file's is the PORT the collector hands it, so the mock keeps exactly that.
vi.mock('../services/source-backfill.js', () => ({
  startClassifierBackfill: (port: BackfillPort) => {
    backfill.port = port;
    return () => { backfill.port = null; };
  }
}));

import { parseChannelPage, startTelegramWebCollector } from './telegram-web.js';
import { resetTelegramCollectorStatus, telegramCollectorStatus } from './telegram.js';

// ------------------------------------------------------------------------------------------------
// The parser, against pages captured from the live preview
// ------------------------------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/telegram-web-${name}.html`, import.meta.url), 'utf8');
}

describe('parseChannelPage on real preview pages', () => {
  it('reads a monitoring channel: every post, ascending, <br> as newlines, the reply quote left out', () => {
    const posts = parseChannelPage(fixture('kudy_letyt'), 'kudy_letyt');
    expect(posts.map((post) => post.id)).toEqual(Array.from({ length: 20 }, (_, index) => 118_741 + index));
    expect(posts.find((post) => post.id === 118_760)).toEqual({
      id: 118_760,
      publishedAt: new Date('2026-09-22T19:52:56Z'),
      text: 'Одещина:\nРеактивний БпЛА курсом на Одесу \n\nЧернігівщина:\n2х Реактивні БпЛА курсом на '
        + 'Славутич \n\nКиївщина:\nРеактивний БпЛА курсом на Кагарлик\nРеактивний БпЛА курсом на Пісківку'
        + '\n\nКіровоградщина:\nРеактивний БпЛА курсом на Кропивницький',
      edited: false,
      photoUrl: null
    });
    // A reply to «Дніпропетровщина: 8х Бандеролей на Кривий Ріг»: the quote is on the page, inside
    // the post's own bubble, and is not what this post said.
    expect(posts.find((post) => post.id === 118_752)?.text).toBe('Мінус');
    // Every post on the page carries a 🙏 reaction; none of them wrote one.
    expect(posts.some((post) => post.text.includes('🙏'))).toBe(false);
  });

  it('keeps custom emoji as characters and never reads the «open Telegram» placeholder as text', () => {
    const posts = parseChannelPage(fixture('kpszsu'), 'kpszsu');
    expect(posts).toHaveLength(20);
    expect(posts[0]?.id).toBe(79_578);
    expect(posts.at(-1)).toMatchObject({ id: 79_597, text: '🏍 Київщина: реактивний БпЛА курсом на Васильків.' });
    expect(posts.find((post) => post.id === 79_584)?.text)
      .toBe('💣Пуски керованих авіаційних бомб ворожою тактичною авіацією на Сумщину.');
    expect(posts.some((post) => /Please open Telegram|VIEW IN TELEGRAM/.test(post.text))).toBe(false);
  });

  it('reads an administration channel by its lower-cased registry handle, albums included', () => {
    // `data-post="khersonskaODA/…"` on the page, `khersonskaoda` in the registry.
    const posts = parseChannelPage(fixture('khersonskaoda'), 'khersonskaoda');
    expect(posts.map((post) => post.id)).toEqual([
      68_143, 68_146, 68_147, 68_148, 68_149, 68_158, 68_159, 68_160, 68_161, 68_162, 68_163, 68_164
    ]);
    const album = posts[0]!;
    expect(album.photoUrl).toMatch(/^https:\/\/cdn4\.telesco\.pe\/file\/.+\.jpg$/);
    // The caption sits in a text element nested inside another one; it is read once, whole.
    expect(album.text.startsWith('На фото – кілька російських безпілотників')).toBe(true);
    expect(album.text.split('На фото').length).toBe(2);
    expect(posts.find((post) => post.id === 68_163)).toMatchObject({
      text: '🟡 Бериславський район — повітряна тривога, жовтий рівень: Дронова загроза (жовтий рівень)',
      publishedAt: new Date('2026-09-22T19:43:30Z'),
      photoUrl: null
    });
  });

  it('skips the service message, leaves the link preview out and reads the «edited» mark', () => {
    const posts = parseChannelPage(fixture('sumyregion'), 'sumyregion');
    // Twenty widgets; 159173 is «Sumyregion pinned …».
    expect(posts).toHaveLength(19);
    expect(posts.some((post) => post.id === 159_173)).toBe(false);
    expect(posts.filter((post) => post.edited).map((post) => post.id)).toEqual([159_172, 159_175, 159_179]);
    const appeal = posts.find((post) => post.id === 159_172)!;
    expect(appeal.text.startsWith('Друзі, наш канал працює практично цілодобово.')).toBe(true);
    // The post links its jar itself; the preview card under it (title, description) is not text.
    expect(appeal.text.endsWith('Банка каналу: https://send.monobank.ua/jar/RFnZtAPgq\n\nДякуємо кожному ❤️')).toBe(true);
    expect(appeal.text).not.toMatch(/Безпечний переказ коштів|Надсилайте безкоштовно/);
    expect(posts.find((post) => post.id === 159_180)?.text).toBe('Жужики наші літають, все ок 😊');
  });

  it('decodes named, decimal and hex entities once, after the tags are gone', () => {
    const [post] = parseChannelPage(page('entities', [{
      id: 7, text: 'A &amp; B &quot;C&quot; D&#39;E&#33; &#x1F6A8; &lt;b&gt;not bold&lt;/b&gt; &amp;lt;&nbsp;x'
    }]), 'entities');
    expect(post?.text).toBe('A & B "C" D\'E! 🚨 <b>not bold</b> &lt;\u00a0x');
  });
});

// ------------------------------------------------------------------------------------------------
// A channel the fake preview serves
// ------------------------------------------------------------------------------------------------

interface FakePost { id: number; text: string; at: Date; edited?: boolean; photo?: string }

const NOW = new Date('2026-09-22T20:00:00Z');

function page(username: string, posts: Array<Partial<FakePost> & { id: number; text: string }>,
  links: { before?: number; after?: number } = {}): string {
  const widgets = posts.map((post) => {
    const at = (post.at ?? NOW).toISOString().replace('.000Z', '+00:00');
    const photo = post.photo
      ? `<a class="tgme_widget_message_photo_wrap blured js-message_photo" style="width:800px;background-image:url('${post.photo}')" href="https://t.me/${username}/${post.id}"></a>`
      : '';
    return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${username}/${post.id}" data-view="x">`
      + `<div class="tgme_widget_message_bubble">${photo}<div class="tgme_widget_message_text js-message_text" dir="auto">${post.text}</div>`
      + `<div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info">`
      + `<span class="tgme_widget_message_meta">${post.edited ? 'edited &nbsp;' : ''}<a class="tgme_widget_message_date" href="https://t.me/${username}/${post.id}"><time datetime="${at}" class="time">00:00</time></a></span>`
      + '</div></div></div></div></div>';
  }).join('');
  const more = (kind: 'before' | 'after', id: number | undefined) => id === undefined ? ''
    : `<div class="tgme_widget_message_centered js-messages_more_wrap"><a href="/s/${username}?${kind}=${id}" class="tme_messages_more js-messages_more" data-${kind}="${id}"></a></div>`;
  return `<html><body><main><section class="tgme_channel_history js-message_history">${more('before', links.before)}${widgets}${more('after', links.after)}</section></main></body></html>`;
}

type Query = { after: number | null; before: number | null };

/** A channel that pages the way the preview does: twenty per page, «more» links when more exist. */
function channel(username: string, posts: FakePost[]): (query: Query) => Response {
  return ({ after, before }) => {
    const all = [...posts].sort((left, right) => left.id - right.id);
    const shown = after !== null ? all.filter((post) => post.id > after).slice(0, 20)
      : before !== null ? all.filter((post) => post.id < before).slice(-20)
        : all.slice(-20);
    const first = shown[0];
    const last = shown.at(-1);
    return new Response(page(username, shown, {
      before: first && all.some((post) => post.id < first.id) ? first.id : undefined,
      after: last && all.some((post) => post.id > last.id) ? last.id : undefined
    }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
}

function posts(from: number, to: number, at = new Date(NOW.getTime() - 60_000)): FakePost[] {
  return Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index, text: `Пост ${from + index}`, at }));
}

const feeds = new Map<string, (query: Query) => Response>();
const requests: Array<{ username: string; after: number | null; before: number | null; at: number }> = [];
let intercept: ((username: string) => Response | null) | null = null;

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  const username = url.pathname.replace(/^\/s\//, '').toLowerCase();
  const number = (key: string) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null;
  requests.push({ username, after: number('after'), before: number('before'), at: Date.now() });
  const intercepted = intercept?.(username);
  if (intercepted) return intercepted;
  const feed = feeds.get(username);
  // What t.me does for a handle with no public preview.
  return feed ? feed({ after: number('after'), before: number('before') })
    : new Response(null, { status: 302, headers: { location: `https://t.me/${username}` } });
}

/** Real macrotask turns, so fetch bodies, streams and the mocked writers all settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await nextTurn();
}

async function advance(ms: number, step = 100): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    await settle();
  }
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
let stop: (() => Promise<void>) | null = null;

async function start(): Promise<void> {
  stop = await startTelegramWebCollector(silentLog, {
    fetch: fakeFetch as typeof fetch,
    mediaConsumers: async () => ({ primary: false, detached: false })
  });
  await advance(1_000);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  registry.alert = [];
  registry.monitored = [];
  archive.newest.clear();
  ingested.classifier = [];
  ingested.alerts = [];
  operations.successes = [];
  operations.errors = [];
  backfill.port = null;
  feeds.clear();
  requests.length = 0;
  intercept = null;
  resetTelegramCollectorStatus();
});

afterEach(async () => {
  await stop?.();
  stop = null;
  vi.useRealTimers();
});

function monitor(username: string): void {
  registry.monitored.push({ sourceId: `src-${username}`, username, adapterType: 'mtproto_monitor' });
}

const classifierIds = () => ingested.classifier.map((entry) => Number(entry.message.externalId));

// ------------------------------------------------------------------------------------------------
// The collector
// ------------------------------------------------------------------------------------------------

describe('the web collector', () => {
  it('routes an alert channel to the alert reconciler only and a monitor to the classifier only', async () => {
    registry.alert = [{ sourceId: 'src-oda', username: 'oda_test' }];
    monitor('mon_test');
    feeds.set('oda_test', channel('oda_test', [
      { id: 100, text: '🔴 Бериславський район — повітряна тривога', at: new Date(NOW.getTime() - 60_000) }
    ]));
    feeds.set('mon_test', channel('mon_test', [
      { id: 200, text: 'Київщина:<br/>Реактивний БпЛА курсом на Васильків', at: new Date(NOW.getTime() - 30_000) }
    ]));
    await start();

    expect(ingested.alerts).toEqual([{
      sourceId: 'src-oda',
      messages: [{
        externalId: '100', publishedAt: new Date(NOW.getTime() - 60_000), editedAt: null,
        text: '🔴 Бериславський район — повітряна тривога',
        rawPayload: { channel: 'oda_test', id: 100, transport: 'web' }
      }]
    }]);
    expect(ingested.classifier).toHaveLength(1);
    expect(ingested.classifier[0]).toMatchObject({
      message: {
        sourceId: 'src-mon_test', externalId: '200', text: 'Київщина:\nРеактивний БпЛА курсом на Васильків',
        rawPayload: { channel: 'mon_test', id: 200, transport: 'web', media: [] }
      },
      options: { monitor: true }
    });
    expect(telegramCollectorStatus()).toMatchObject({
      transport: 'web', state: 'ready', handlersReady: true, channels: 2, resolved: 2, unresolved: []
    });
  });

  it('polls on with after=<newest id> and never delivers a post twice', async () => {
    monitor('mon_b');
    const feed = posts(300, 301);
    feeds.set('mon_b', channel('mon_b', feed));
    await start();
    expect(requests[0]).toMatchObject({ username: 'mon_b', after: null, before: null });
    expect(classifierIds()).toEqual([300, 301]);

    // Hot: the channel published a minute ago, so it is read again five seconds later.
    await advance(5_000);
    expect(requests.at(-1)).toMatchObject({ after: 301 });
    expect(classifierIds()).toEqual([300, 301]);

    feed.push({ id: 302, text: 'Пост 302', at: new Date(Date.now()) });
    await advance(5_000);
    await advance(5_000);
    expect(classifierIds()).toEqual([300, 301, 302]);
    expect(requests.at(-1)).toMatchObject({ after: 302 });
  });

  it('reads a full page again at once instead of waiting for the next poll', async () => {
    monitor('mon_c');
    const feed = posts(1, 3);
    feeds.set('mon_c', channel('mon_c', feed));
    await start();
    feed.push(...posts(4, 28, new Date(NOW.getTime() - 30_000)));

    await advance(5_000);
    const walk = requests.filter((request) => request.after !== null);
    expect(walk.map((request) => request.after)).toEqual([3, 23]);
    // The catch-up page is one request spacing behind the full one, not a poll interval.
    expect(walk[1]!.at - walk[0]!.at).toBeLessThan(1_000);
    expect(classifierIds()).toEqual(Array.from({ length: 28 }, (_, index) => index + 1));

    // The partial page ended the cycle: the next request waits for the hot interval.
    await advance(4_000);
    expect(requests.filter((request) => request.after !== null)).toHaveLength(2);
  });

  it('pauses every request on a 429 for the Retry-After it names, and reports flood_wait meanwhile', async () => {
    monitor('mon_d1');
    monitor('mon_d2');
    feeds.set('mon_d1', channel('mon_d1', posts(10, 11)));
    feeds.set('mon_d2', channel('mon_d2', posts(20, 21)));
    await start();
    expect(telegramCollectorStatus().state).toBe('ready');

    intercept = () => new Response(null, { status: 429, headers: { 'retry-after': '120' } });
    await advance(5_000);
    const refusedAt = requests.at(-1)!.at;
    expect(telegramCollectorStatus()).toMatchObject({
      transport: 'web', state: 'flood_wait', floodWaitSeconds: 120,
      floodWaitUntil: new Date(refusedAt + 120_000).toISOString(), detail: 'http_429'
    });

    const asked = requests.length;
    intercept = null;
    await advance(119_000 - (Date.now() - refusedAt), 1_000);
    expect(requests.length).toBe(asked);
    expect(telegramCollectorStatus().state).toBe('flood_wait');

    await advance(2_000);
    expect(requests.length).toBeGreaterThan(asked);
    expect(telegramCollectorStatus()).toMatchObject({ state: 'ready', floodWaitSeconds: null, floodWaitUntil: null });
  });

  it('re-processes an edited post with its original time and editedAt, and ignores an unmarked change', async () => {
    monitor('mon_e');
    const publishedAt = new Date(NOW.getTime() - 60_000);
    const feed: FakePost[] = [
      { id: 500, text: 'Київщина: БпЛА на Бровари', at: publishedAt },
      { id: 501, text: 'Чернігівщина: чисто', at: publishedAt }
    ];
    feeds.set('mon_e', channel('mon_e', feed));
    await start();
    expect(classifierIds()).toEqual([500, 501]);

    feed[0] = { ...feed[0]!, text: 'Київщина: БпЛА на Бориспіль', edited: true };
    // A digest that moves without the page saying «edited» is a rendering change, not a revision.
    feed[1] = { ...feed[1]!, text: 'Чернігівщина: чисто.' };
    await advance(61_000, 500);

    const refresh = requests.find((request) => request.after === null && request.at > NOW.getTime() + 1_000);
    expect(refresh).toBeDefined();
    expect(ingested.classifier).toHaveLength(3);
    expect(ingested.classifier[2]!.message).toMatchObject({
      externalId: '500', text: 'Київщина: БпЛА на Бориспіль', publishedAt, editedAt: new Date(refresh!.at)
    });
  });

  it('reports a handle with no public preview as unresolved and the collector as degraded', async () => {
    monitor('mon_ok');
    monitor('mon_gone');
    feeds.set('mon_ok', channel('mon_ok', posts(1, 2)));
    await start();

    expect(telegramCollectorStatus()).toMatchObject({
      state: 'degraded', channels: 2, resolved: 1, unresolved: ['mon_gone'], detail: 'channels_unresolved'
    });
    expect(operations.errors).toEqual([{
      sourceId: 'src-mon_gone', message: 'Telegram channel @mon_gone has no readable public preview (http_302)'
    }]);
  });

  it('delivers only what the archive does not hold yet on the first page', async () => {
    monitor('mon_g');
    archive.newest.set('src-mon_g', 301);
    feeds.set('mon_g', channel('mon_g', posts(290, 302)));
    await start();
    expect(classifierIds()).toEqual([302]);
  });

  it('walks forward from the archive, in order, when the first page does not reach it', async () => {
    monitor('mon_h');
    archive.newest.set('src-mon_h', 50);
    feeds.set('mon_h', channel('mon_h', posts(41, 120)));
    await start();

    expect(requests.map((request) => request.after)).toEqual([null, 50, 70, 90, 110]);
    expect(classifierIds()).toEqual(Array.from({ length: 70 }, (_, index) => 51 + index));
  });

  it('hands the catch-up sweep a port that pages history newest-first and knows no alert channel', async () => {
    registry.alert = [{ sourceId: 'src-oda', username: 'oda_i' }];
    monitor('mon_i');
    feeds.set('oda_i', channel('oda_i', posts(1, 2)));
    const history = posts(1, 60, new Date('2026-09-22T12:00:00Z'));
    feeds.set('mon_i', channel('mon_i', history));
    await start();

    const port = backfill.port!;
    expect(port.routes()).toEqual([{ sourceId: 'src-mon_i', username: 'mon_i', adapterType: 'mtproto_monitor' }]);

    requests.length = 0;
    const newest = port.history('mon_i', { limit: 25, offsetId: 0 });
    await advance(1_000);
    const firstPage = await newest;
    expect(requests.map((request) => request.before)).toEqual([null, 41]);
    expect(firstPage.map((message) => message.id)).toEqual(Array.from({ length: 25 }, (_, index) => 60 - index));
    expect(firstPage[0]).toEqual({ id: 60, date: Date.parse('2026-09-22T12:00:00Z') / 1000, message: 'Пост 60' });

    requests.length = 0;
    const older = port.history('mon_i', { limit: 25, offsetId: 36 });
    await advance(1_000);
    expect((await older).map((message) => message.id)).toEqual(Array.from({ length: 25 }, (_, index) => 35 - index));
    expect(requests.map((request) => request.before)).toEqual([36, 16]);

    await expect(port.history('oda_i', { limit: 10, offsetId: 0 })).rejects.toThrow(/not a classifier route/);
  });
});
