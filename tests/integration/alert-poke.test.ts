import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';
import {
  OBLAST, OTHER_OBLAST, delay, ensureMigrated, fakeBot, integrationDatabaseAvailable, outboxRows,
  resetDatabase, seedSubscription, seedUser, sql
} from '../helpers/db.js';

/**
 * Instant propagation, against a live database.
 *
 * Three properties, and only the first two could be argued from the code:
 *
 *  1. **The poke removes polling lag.** An `alert.started` written by a snapshot poll reaches the
 *     hub's public feed and the notification outbox in a small fraction of the one-second tick that
 *     used to be the only trigger. Measured, and the measurement is printed — «before → after» in
 *     `docs/OPERATIONS.md` is a claim about these numbers.
 *  2. **The poke never removes the HOLD.** In `delayed_15s` a poked pass runs the same
 *     version-bounded SELECT the timer would have run, so the fresh row is above the bound and is
 *     not emitted. This is the assertion the whole delivery is shipped on: a latency optimisation
 *     that could leak a held row would be a retraction hazard, not an optimisation. The
 *     `'internal-event'` feed firing in the same window is what proves the poke DID run and that
 *     the gate, not a missing poke, is what withheld it.
 *  3. **A nationwide snapshot is one poke, not twenty-five.** Bound 1 of
 *     `src/services/alert-poke.ts` — one poke per COMMIT — measured on a real multi-oblast body.
 *
 * The propagation metric is exercised on the same path, because the number it reports is only
 * meaningful if it is taken from the row the hub actually released.
 */

const UKRAINE_ALARM_URL = 'https://api.ukrainealarm.com/api/v3/alerts';

interface Region { regionId: string; regionName: string; startedAt?: string }

function alarmBody(regions: Region[]): unknown {
  return regions.map((region) => ({
    regionId: region.regionId,
    regionName: region.regionName,
    activeAlerts: [{ type: 'AIR', lastUpdate: region.startedAt ?? new Date().toISOString() }]
  }));
}

async function pollUkraineAlarm(body: unknown): Promise<void> {
  responses.set(UKRAINE_ALARM_URL, body);
  const { syncOfficialAlerts } = await import('../../src/services/ingestion.js');
  await syncOfficialAlerts();
}

const responses = new Map<string, unknown>();

/**
 * The hub, started for one test and stopped again, with every frame it releases timestamped.
 *
 * `eventHub` is a module singleton and the integration project runs every file in ONE fork, so a hub
 * left running would keep polling into the next file's truncated database.
 */
async function withHub<T>(
  body: (seen: {
    published: Array<{ version: number; type: string; at: number }>;
    internal: Array<{ version: number; type: string; at: number }>;
  }) => Promise<T>
): Promise<T> {
  const { eventHub, resetEventHubCursor } = await import('../../src/services/sse.js');
  const published: Array<{ version: number; type: string; at: number }> = [];
  const internal: Array<{ version: number; type: string; at: number }> = [];
  const onPublished = (event: any) => {
    published.push({ version: event.version, type: event.eventType, at: Date.now() });
  };
  const onInternal = (event: any) => {
    internal.push({ version: event.version, type: event.eventType, at: Date.now() });
  };
  resetEventHubCursor();
  eventHub.on('event', onPublished);
  eventHub.on('internal-event', onInternal);
  eventHub.start();
  // The hub initialises its cursor on the FIRST tick and emits nothing on it; everything asserted
  // below has to be written after that, or it would be below the cursor and never selected.
  await delay(60);
  try {
    return await body({ published, internal });
  } finally {
    eventHub.stop();
    eventHub.off('event', onPublished);
    eventHub.off('internal-event', onInternal);
  }
}

async function setMode(mode: 'live' | 'delayed_15s'): Promise<void> {
  await sql(
    `UPDATE runtime_settings SET publication_mode=$1, mode_changed_at=now() - interval '1 hour', updated_at=now()`,
    [mode]
  );
  (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
}

async function pokeCounts(): Promise<{ fired: number; coalesced: number }> {
  const { alertPokeMetrics } = await import('../../src/services/alert-poke.js');
  const registry = new Registry();
  for (const [, metric] of alertPokeMetrics()) registry.registerMetric(metric);
  const text = await registry.metrics();
  const read = (outcome: string) => {
    const match = new RegExp(`^threatlens_alert_pokes_total\\{outcome="${outcome}"\\} (\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : 0;
  };
  return { fired: read('fired'), coalesced: read('coalesced') };
}

/** Waits for a predicate, polling far faster than the thing under test, and reports how long it took. */
async function elapsedUntil(predicate: () => boolean, label: string, budgetMs = 5000): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return Date.now() - started;
    if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

/** The same, for a predicate that has to ask the database. */
async function elapsedUntilAsync(
  predicate: () => Promise<boolean>, label: string, budgetMs = 5000
): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - started;
    if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

describe.skipIf(!integrationDatabaseAvailable)('instant propagation of an alert start', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
    (await import('../../src/services/publication.js')).resetPublicationCache();
    responses.clear();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (!responses.has(url)) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => responses.get(url) };
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
  });

  it('releases a started alert to the public feed well inside one hub tick', async () => {
    const measured = await withHub(async (seen) => {
      const before = seen.published.length;
      await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));
      const ms = await elapsedUntil(
        () => seen.published.slice(before).some((frame) => frame.type === 'alert.started'),
        'the poked hub pass to release alert.started'
      );
      return ms;
    });
    // The hub's own timer is 1000 ms and a snapshot commit lands at a uniformly random point in it,
    // so without the poke the expected wait is ~500 ms and the worst case is ~1000. A budget of
    // 250 ms is well below both and still an order of magnitude above what a poke costs.
    console.log(`[measured] alert.started → public SSE frame: ${measured} ms`);
    expect(measured).toBeLessThan(250);
  });

  it('enqueues the Telegram notification on the same signal', async () => {
    await seedUser(9331);
    await seedSubscription({ chatId: 9331, locationId: OBLAST, notifyAlertStart: true });
    const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
    const stop = startNotificationWorkers(null, { warn: () => undefined, error: () => undefined });
    try {
      await delay(60);
      await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));
      const ms = await elapsedUntilAsync(
        async () => (await outboxRows()).length > 0,
        'the poked fan-out pass to queue an alert_start'
      );
      console.log(`[measured] alert.started → notification_outbox row: ${ms} ms`);
      expect((await outboxRows())[0]).toMatchObject({ notification_type: 'alert_start' });
      expect(ms).toBeLessThan(500);
    } finally {
      stop();
    }
  });

  it('sends the alert to Telegram without waiting for the delivery tick', async () => {
    // Знайдено вимірюванням на бойових даних, не читанням коду: від рядка в черзі до `sent_at`
    // минало p50 1.04 с, p90 1.49 с. Це не тривалість запиту до Telegram — це очікування наступного
    // тіку відправника, рівномірне на [0, 1 с]. Фан-аут будили, відправника — ні.
    await seedUser(9332);
    await seedSubscription({ chatId: 9332, locationId: OBLAST, notifyAlertStart: true });
    const telegram = fakeBot();
    const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
    const stop = startNotificationWorkers(
      telegram.bot as never, { warn: () => undefined, error: () => undefined }
    );
    try {
      await delay(60);
      await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));
      const ms = await elapsedUntil(
        () => telegram.calls.length > 0, 'the poked delivery pass to reach Telegram'
      );
      console.log(`[measured] alert.started → Telegram sendMessage: ${ms} ms`);
      expect(telegram.calls[0]?.text).toContain('Повітряна тривога');
      // Два таймери по 1 с стояли послідовно; без поштовху відправника очікування самої лише
      // доставки — ~500 мс у середньому. Бюджет нижчий за нього, і при цьому на порядок вищий за
      // те, чого коштує поштовх.
      expect(ms).toBeLessThan(400);
    } finally {
      stop();
    }
  });

  it('raises ONE poke for a snapshot that starts twenty-five alerts', async () => {
    const oblasts = await sql<{ id: string; name_uk: string }>(
      `SELECT id,name_uk FROM locations WHERE type='oblast' ORDER BY id LIMIT 25`
    );
    expect(oblasts.rowCount).toBeGreaterThanOrEqual(20);
    const before = await pokeCounts();
    await pollUkraineAlarm(alarmBody(
      oblasts.rows.map((row) => ({ regionId: row.id, regionName: row.name_uk }))
    ));
    await delay(50);
    const after = await pokeCounts();
    const started = await sql(`SELECT 1 FROM system_event_log WHERE event_type='alert.started'`);
    expect(started.rowCount).toBe(oblasts.rowCount);
    // Bound 1: one poke per COMMIT, not per row. Twenty-five oblasts going alight in one nationwide
    // snapshot is one extra hub pass and one extra fan-out pass, whatever the raid looks like.
    expect(after.fired - before.fired).toBe(1);
    expect(after.coalesced - before.coalesced).toBe(0);
  });

  it('does not poke for an alert that ENDS', async () => {
    await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));
    await delay(50);
    // The first empty poll only STAMPS `missing_since`; the end debounce holds the alert. Backdating
    // that marker is the same thing as waiting the window out — see `alert-reconciliation.test.ts`.
    await pollUkraineAlarm(alarmBody([]));
    await sql(`UPDATE alert_source_states SET missing_since=now()-interval '1 hour'
               WHERE missing_since IS NOT NULL`);
    const before = await pokeCounts();
    await pollUkraineAlarm(alarmBody([]));
    await delay(50);
    const ended = await sql(`SELECT 1 FROM system_event_log WHERE event_type='alert.ended'`);
    expect(ended.rowCount).toBe(1);
    // Starts fast, ends unhurried — the asymmetry this delivery implements. An end rides the
    // ordinary tick, exactly as it did before.
    expect(await pokeCounts()).toEqual(before);
  });
});

describe.skipIf(!integrationDatabaseAvailable)('the poke and the publication hold', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
    (await import('../../src/services/publication.js')).resetPublicationCache();
    responses.clear();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (!responses.has(url)) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => responses.get(url) };
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await setMode('live');
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
  });

  it('withholds a poked alert.started until its hold elapses, and records it internally at once', async () => {
    await setMode('delayed_15s');
    await withHub(async (seen) => {
      await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));

      // The poke fires within one macrotask; the internal feed is unbounded and must carry it.
      const internalMs = await elapsedUntil(
        () => seen.internal.some((frame) => frame.type === 'alert.started'),
        'the internal feed to carry the poked alert.started'
      );
      console.log(`[measured] delayed_15s: alert.started → internal feed: ${internalMs} ms`);
      expect(internalMs).toBeLessThan(250);

      // …and the PUBLIC feed must not, for as long as the row is younger than the cutoff. Two
      // seconds is two hub ticks plus the poked pass: if the poke could leak a held row, it has had
      // every opportunity.
      await delay(2000);
      expect(seen.published.filter((frame) => frame.type === 'alert.started')).toHaveLength(0);

      // The hold, and nothing else, is what withheld it. Ageing the row the code itself wrote past
      // the cutoff is the same thing as waiting fifteen seconds, and the very next pass releases it.
      await sql(`UPDATE system_event_log SET created_at = created_at - interval '60 seconds'
                 WHERE event_type='alert.started'`);
      const releasedMs = await elapsedUntil(
        () => seen.published.some((frame) => frame.type === 'alert.started'),
        'the aged alert.started to be released'
      );
      console.log(`[measured] delayed_15s: aged row → public frame: ${releasedMs} ms`);
    });
  }, 30_000);

  it('emits each held version exactly once when it is finally released', async () => {
    await setMode('delayed_15s');
    await withHub(async (seen) => {
      await pollUkraineAlarm(alarmBody([
        { regionId: OBLAST, regionName: 'Київська область' },
        { regionId: OTHER_OBLAST, regionName: 'Полтавська область' }
      ]));
      await delay(1200);
      expect(seen.published).toHaveLength(0);
      await sql(`UPDATE system_event_log SET created_at = created_at - interval '60 seconds'`);
      await elapsedUntil(() => seen.published.length >= 2, 'both held rows to be released');
      await delay(1200);
      const versions = seen.published.map((frame) => frame.version);
      expect(versions).toEqual([...versions].sort((left, right) => left - right));
      expect(new Set(versions).size).toBe(versions.length);
    });
  }, 30_000);
});

describe.skipIf(!integrationDatabaseAvailable)('the end-to-end propagation metric', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/publication.js')).resetPublicationCache();
    (await import('../../src/services/alert-poke.js')).resetAlertPoke();
    responses.clear();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (!responses.has(url)) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => responses.get(url) };
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('measures from the timestamp the provider printed to the row we wrote', async () => {
    const { lastAlertPropagation } = await import('../../src/services/publication.js');
    // Forty seconds ago, in the provider's own vocabulary — the same field the mirror's `changed`
    // and `lastUpdate` end up in.
    const upstream = new Date(Date.now() - 40_000).toISOString();
    await pollUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область', startedAt: upstream }
    ]));
    const reading = lastAlertPropagation();
    expect(reading).not.toBeNull();
    expect(reading!.source).toBe('ukraine-alarm');
    expect(reading!.seconds).toBeGreaterThan(35);
    expect(reading!.seconds).toBeLessThan(60);
    console.log(`[measured] propagation for a 40 s-old upstream stamp: ${reading!.seconds.toFixed(2)} s`);
  });

  it('clamps a provider whose clock runs ahead of ours to zero', async () => {
    const { lastAlertPropagation } = await import('../../src/services/publication.js');
    await pollUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область',
        startedAt: new Date(Date.now() + 3_600_000).toISOString() }
    ]));
    expect(lastAlertPropagation()!.seconds).toBe(0);
  });

  it('saturates rather than recording a back-dated reopen as hours of latency', async () => {
    const { lastAlertPropagation, ALERT_PROPAGATION_CAP_SECONDS } =
      await import('../../src/services/publication.js');
    await pollUkraineAlarm(alarmBody([
      { regionId: OBLAST, regionName: 'Київська область',
        startedAt: new Date(Date.now() - 4 * 3_600_000).toISOString() }
    ]));
    expect(lastAlertPropagation()!.seconds).toBe(ALERT_PROPAGATION_CAP_SECONDS);
  });

  it('records nothing for an alert that only ended', async () => {
    const { lastAlertPropagation, resetPublicationCache } =
      await import('../../src/services/publication.js');
    await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));
    await sql(`UPDATE alert_source_states SET missing_since=now()-interval '1 hour'`);
    resetPublicationCache();
    await pollUkraineAlarm(alarmBody([]));
    expect(lastAlertPropagation()).toBeNull();
  });

  it('exports the histogram on the metrics registry', async () => {
    const { registerPublicationMetrics } = await import('../../src/services/publication.js');
    await pollUkraineAlarm(alarmBody([{ regionId: OBLAST, regionName: 'Київська область' }]));
    const registry = new Registry();
    registerPublicationMetrics(registry);
    const text = await registry.metrics();
    expect(text).toContain('threatlens_alert_propagation_seconds_bucket{le="5",source="ukraine-alarm"}');
  });
});
