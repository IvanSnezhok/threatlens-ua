import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, sql } from '../helpers/db.js';

/**
 * Covers `resolveChannelRoutes` in `src/sources/telegram.ts` — the one decision that says what a
 * subscribed Telegram username is *for*.
 *
 * Until the Tier A catalogue existed the answer was a string comparison against one configured
 * handle, and everything else fell through to the classifier. With twenty-one official handles that
 * default is the wrong way round: an oblast administration that fell through would have its air-raid
 * alerts read as OSINT prose and filed as unverified threat events, while the alert path stayed
 * silent for that oblast. The assertions below are about that boundary and about nothing else — the
 * reconciliation behaviour itself lives in `alert-channel.test.ts`.
 *
 * Nothing here connects to Telegram. `resolveChannelRoutes` reads `sources` and returns a map.
 */

const A1_CONFIRMED_FORMAT = [
  'khersonskaODA', 'kherson_miskrada', 'kyivoda', 'VinnytsiaODA', 'oda_rv', 'slv_vca'
].map((handle) => handle.toLowerCase());

/** Registered Tier A rows whose published format the parser cannot read. See migration 014. */
const A_SWITCHED_OFF = [
  'odeskaODA', 'zoda_gov_ua', 'ivan_fedorov_zp', 'kharkivoda', 'synegubov', 'Sumy_news_ODA',
  'dsns_telegram', 'DSNS_Kharkiv', 'dsns_kyiv_region', 'chernigivskaODA', 'zhytomyrskaODA',
  'poltavskaOVA', 'dnipropetrovskaODA', 'DonetskaODA', 'ternopilskaODA'
].map((handle) => handle.toLowerCase());

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function routes() {
  const { resolveChannelRoutes } = await import('../../src/sources/telegram.js');
  return resolveChannelRoutes(silentLog);
}

describe.skipIf(!integrationDatabaseAvailable)('alert channel routing', () => {
  beforeAll(ensureMigrated);

  afterEach(async () => {
    // The catalogue flags are what these tests manipulate, and `resetDatabase` does not restore
    // them. Migration 014 is the statement of record for which rows are on.
    await sql(`UPDATE sources SET enabled=true WHERE id = ANY($1::text[])`,
      [['air-alert-ua', 'gov-kherson-oda', 'gov-kherson-mva', 'gov-kyiv-oblast-oda',
        'gov-vinnytsia-oda', 'gov-rivne-oda', 'gov-sloviansk-mva']]);
    await sql(`UPDATE sources SET enabled=false WHERE id = ANY($1::text[])`,
      [['gov-odesa-oda', 'gov-zaporizhzhia-oda', 'gov-zaporizhzhia-head']]);
  });

  it('routes every enabled Tier A channel to the alert path', async () => {
    const resolved = await routes();
    for (const handle of ['air_alert_ua', ...A1_CONFIRMED_FORMAT]) {
      expect(resolved.get(handle)).toMatchObject({ kind: 'alert' });
    }
  });

  it('binds each alert channel to its own source id', async () => {
    // The whole of what keeps two administrations reporting the same raion apart. A handle bound to
    // the wrong row would attribute one authority's all-clear to another.
    const resolved = await routes();
    const expected = await sql<{ id: string; handle: string }>(
      `SELECT id,lower(telegram_username) AS handle FROM sources
       WHERE adapter_type='mtproto_alert_channel' AND enabled=true AND telegram_username IS NOT NULL`
    );
    for (const row of expected.rows) {
      expect(resolved.get(row.handle)).toEqual({
        kind: 'alert', sourceId: row.id, username: row.handle
      });
    }
  });

  it('never routes a Tier A channel through the classifier', async () => {
    // An official channel reaching `processMessage` would publish air-raid alerts as threat events
    // and leave the alert path silent for that oblast — the failure this split exists to prevent.
    const resolved = await routes();
    const classifier = [...resolved.values()].filter((route) => route.kind === 'classifier');
    const officialHandles = await sql<{ handle: string }>(
      `SELECT lower(telegram_username) AS handle FROM sources WHERE adapter_type='mtproto_alert_channel'`
    );
    const official = new Set(officialHandles.rows.map((row) => row.handle));
    expect(classifier.filter((route) => official.has(route.username))).toEqual([]);
  });

  it('does not subscribe to a Tier A row that is switched off', async () => {
    const resolved = await routes();
    for (const handle of A_SWITCHED_OFF) expect(resolved.has(handle)).toBe(false);
  });

  it('stops reading a channel the moment its row is disabled, and resumes when it is not', async () => {
    expect((await routes()).has('kyivoda')).toBe(true);
    await sql(`UPDATE sources SET enabled=false WHERE id='gov-kyiv-oblast-oda'`);
    expect((await routes()).has('kyivoda')).toBe(false);
    await sql(`UPDATE sources SET enabled=true WHERE id='gov-kyiv-oblast-oda'`);
    expect((await routes()).has('kyivoda')).toBe(true);
  });

  it('still routes the OSINT monitors and the Air Force channel to the classifier', async () => {
    const resolved = await routes();
    expect(resolved.get('kpszsu')).toMatchObject({ kind: 'classifier', sourceId: 'air-force' });
    expect(resolved.get('war_monitor')).toMatchObject({ kind: 'classifier' });
  });

  it('covers every subscribed channel with the connection heartbeat', async () => {
    // `updateSourceFreshness` only moves a source from `current` to `stale`, so a row that is never
    // marked successful reports `unknown` forever. The heartbeat set is the route map, so this is
    // the assertion that a newly enabled Tier A row is not left permanently unknown.
    const resolved = await routes();
    const heartbeat = new Set([...resolved.values()].map((route) => route.sourceId));
    const enabled = await sql<{ id: string }>(
      `SELECT id FROM sources WHERE adapter_type='mtproto_alert_channel' AND enabled=true`
    );
    for (const row of enabled.rows) expect(heartbeat.has(row.id)).toBe(true);
    expect(heartbeat.has('air-force')).toBe(true);
  });

  it('refuses a second row claiming a handle an alert channel already owns', async () => {
    // A handle that appears twice would decide, by nothing more than map insertion order, whether an
    // official alert is read as an alert or as an unverified sighting. Migration 014 makes that
    // unrepresentable; `loadMonitoredTelegramChannels` and `resolveChannelRoutes` each drop such a
    // row as well, so a hand-edited database still routes the official channel correctly.
    const index = await sql(
      `SELECT 1 FROM pg_indexes WHERE indexname='sources_telegram_username_key'`
    );
    expect(index.rowCount).toBe(1);
    await expect(sql(
      `INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
         telegram_username)
       VALUES ('test-shadow','Shadow','telegram','C',false,true,'mtproto_monitor','test-shadow','KyivOda')`
    )).rejects.toThrow(/duplicate key value violates unique constraint/);
    await sql(`DELETE FROM sources WHERE id='test-shadow'`);
  });
});
