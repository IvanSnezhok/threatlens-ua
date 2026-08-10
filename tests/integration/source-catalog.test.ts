import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, sql } from '../helpers/db.js';

/**
 * Covers the channel catalogue registered by `migrations/013_source_catalog_expansion.sql`.
 *
 * This file guards *data*, and that is the point: the tier, the `official` flag and the
 * independence group of a publisher are the entire evidence model, and every one of them is a row
 * rather than a line of code. A row is exactly as easy to get wrong as a line of code and nothing
 * else in the suite would notice — a Tier C aggregator quietly promoted to `official=true` would
 * simply start declaring official air-raid alerts, and the alerts would look like every other one.
 *
 * So the assertions here are deliberately about editorial decisions rather than about SQL: which
 * channels may declare an alert, which are switched off and why, and which of them are allowed to
 * corroborate each other. The handle lists below are the catalogue in full; a row appearing in
 * `sources` that is not in these lists fails this file, which is what makes "58 channels, and these
 * exact 58" a checkable statement rather than a comment in the migration.
 */

/**
 * Tier A — bodies with a state mandate. `official=true`, `adapter_type='mtproto_alert_channel'`.
 *
 * The A1/A2/A3/A4 split is not a quality ranking, it is a statement about what has been *observed*
 * from each channel, and it is the only thing that decides `enabled`.
 */

/**
 * A1: the location-first alert format `src/domain/alert-parser.ts` reads. Collected.
 *
 * Migration 013 put seven channels here on the strength of a channel-level sample. Migration 014
 * corrects the list after reading every post of each feed: three of the seven publish something the
 * parser cannot act on (see `A_FORMAT_NOT_READABLE`), and two rows filed elsewhere turned out to
 * publish this exact format. Every handle below is pinned as a verbatim fixture in
 * `src/domain/alert-parser.test.ts` — that is what "confirmed" means for a Tier A row.
 */
const A1_ENABLED = [
  'khersonskaODA', 'kherson_miskrada', 'kyivoda', 'VinnytsiaODA', 'oda_rv', 'slv_vca'
];

/**
 * Official bodies publishing alerts in a shape the parser is deliberately not given.
 *
 * `odeskaODA` prints its locations *above* the phrase and gives the all-clear with no location at
 * all; the Zaporizhzhia pair write free prose with "крім <city>" exclusions the location model
 * cannot express. Both would need a decision — a source-scoped blanket all-clear, and exclusion
 * semantics — rather than a wider regex, and until then alert authority over three oblasts stays
 * off. Migration 014 carries the verbatim samples.
 */
const A_FORMAT_NOT_READABLE = ['odeskaODA', 'zoda_gov_ua', 'ivan_fedorov_zp'];

/** A2: official, real operational reporting, free prose. Not parseable, so not collected. */
const A2_PROSE = ['kharkivoda', 'synegubov', 'Sumy_news_ODA'];

/** A3: DSNS — official, but after-action reporting rather than first alert. */
const A3_DSNS = ['dsns_telegram', 'DSNS_Kharkiv', 'dsns_kyiv_region'];

/**
 * A4: the body is verified, its alert format is not — zero alert posts in the verified sample.
 *
 * These are the rows the `enabled=false` rule exists for. Alert authority granted to a channel whose
 * alert wording has never been seen yields one of two outcomes and no third: a source that is silent
 * on an oblast we then believe is covered, or a parser that reads ordinary news as an official alert
 * for an entire oblast at the highest evidence level the system has.
 *
 * `ternopilskaODA` is the instructive one, and the label above is wrong for it: it *does* publish
 * alerts. Verbatim, ternopilskaODA/26967 and /26968, 07.08.2026, twenty-seven minutes apart —
 *
 *   УВАГА‼️Повітряна тривога! Пройдіть негайно в укриття!
 *   Відбій повітряної тривоги‼️
 *
 * — with no location and no status circle in either. A body naming no place cannot move a location's
 * state, and this parser takes its scope from the text rather than from the source id it was handed,
 * so what unblocks this row is a per-source default scope in the catalogue, not a wider pattern.
 * `migrations/029_disabled_channel_reaudit.sql` re-sampled all five of the others on 10.08.2026 and
 * reproduced the original finding: zero alert posts in 7–18 posts each.
 */
const A4_UNCONFIRMED_FORMAT = [
  'chernigivskaODA', 'zhytomyrskaODA', 'poltavskaOVA', 'dnipropetrovskaODA',
  'DonetskaODA', 'ternopilskaODA'
];

const TIER_A = [
  ...A1_ENABLED, ...A_FORMAT_NOT_READABLE, ...A2_PROSE, ...A3_DSNS, ...A4_UNCONFIRMED_FORMAT
];

/** Tier B — national OSINT monitoring, in the two clusters described in `independence groups`. */
const B_LAUNCH_DETECTION = ['StrategicaviationT', 'strategicontrol'];
const B_FLIGHT_TRACKING = ['raketa_trevoga', 'monikppy', 'operinform', 'deraketaua', 'monitor_ukr'];
const TIER_B = [...B_LAUNCH_DETECTION, ...B_FLIGHT_TRACKING];

/** Tier C rows that are registered but not collected, each for a reason that is not "low quality". */
const C_RUSSIAN_LANGUAGE = ['krymrealii', 'alertOdessa'];
const C_UNVERIFIED_OPERATOR = ['alarm_kyiv'];

/** Tier C — regional and hybrid monitoring. Visible on the map, never able to confirm anything. */
const TIER_C = [
  'sumyregion', 'Zhyvytskyy', 'ppouaradar', 'radar_ukr', 'kharkivalarm', 'info_zp',
  'dnipro_alerts', 'sirena_dp', 'suspilnemykolaiv', 'warningodesa', 'surenasumy',
  'suspilnechernihiv', 'mapa_karta', 'lviv_alert', 'Uvaga_tryvoha_Volyn', 'if112',
  'khmelnytskyi_alert', 'trevoga_vinnitsa_noviny', 'alarm_cherkasy', 'cherkasyalarm',
  'surenakrop', 'k_pravda', 'suspilnekropyvnytskyi', 'mon1tor_ua', 'Ukrainian_Intelligence',
  'monitoring_ua1', 'radar_war_ua', ...C_RUSSIAN_LANGUAGE, ...C_UNVERIFIED_OPERATOR
];

const CATALOGUE = [...TIER_A, ...TIER_B, ...TIER_C];

/**
 * Handles that must never appear in `sources`, at any tier, enabled or not.
 *
 * The first two are hijacked: both were official channels and both now serve unrelated content,
 * while still circulating in published "official channels" lists. `ComAFUA` contradicts the Air
 * Force's own statement that it runs exactly one channel (`kpszsu`, already registered) and echoes
 * it, so registering it as Tier A would let one Air Force statement corroborate itself.
 */
const FORBIDDEN = ['mykolaivskaODA', 'pavlokyrylenko_donoda', 'ComAFUA'];

/**
 * Channels asserting official status in their own title or bio with nothing behind it.
 *
 * Registered, collected, and permanently capped at Tier C. The failure this guards is a future
 * reader seeing "ОФІЦІЙНИЙ" in the name and treating it as a credential.
 */
const SELF_DECLARED_OFFICIAL = ['radar_war_ua', 'warningodesa', 'sirena_dp'];

interface SourceRow {
  id: string;
  handle: string;
  tier: string;
  official: boolean;
  enabled: boolean;
  adapter_type: string;
  independence_group: string;
  public_url: string;
}

async function catalogueRows(): Promise<Map<string, SourceRow>> {
  const rows = await sql<SourceRow>(
    `SELECT id,telegram_username AS handle,tier,official,enabled,adapter_type,independence_group,public_url
     FROM sources WHERE lower(telegram_username) = ANY($1::text[]) ORDER BY id`,
    [CATALOGUE.map((handle) => handle.toLowerCase())]
  );
  return new Map(rows.rows.map((row) => [row.handle.toLowerCase(), row]));
}

function get(rows: Map<string, SourceRow>, handle: string): SourceRow {
  const row = rows.get(handle.toLowerCase());
  if (!row) throw new Error(`@${handle} is not registered in sources`);
  return row;
}

describe.skipIf(!integrationDatabaseAvailable)('verified channel catalogue', () => {
  let rows: Map<string, SourceRow>;

  beforeAll(async () => {
    // The catalogue's `enabled` flags are an assertion about what the *migration* declares, and
    // other integration files flip those flags on live rows to exercise the collector gate. Starting
    // from an empty schema makes this file independent of which of them ran first, rather than
    // dependent on an execution order nothing enforces.
    await sql('DROP SCHEMA IF EXISTS public CASCADE');
    await sql('CREATE SCHEMA public');
    await ensureMigrated();
    rows = await catalogueRows();
  });

  describe('registration', () => {
    it('registers all 58 verified channels, and exactly those', async () => {
      // 68 candidates researched, 59 verified as existing and usable, one of those rejected on
      // editorial grounds (`ComAFUA`), 58 registered.
      expect(rows.size).toBe(58);
      expect(CATALOGUE).toHaveLength(58);

      const byTier = (tier: string) => [...rows.values()].filter((row) => row.tier === tier);
      expect(byTier('A')).toHaveLength(21);
      expect(byTier('B')).toHaveLength(7);
      expect(byTier('C')).toHaveLength(30);

      for (const handle of TIER_A) expect(get(rows, handle).tier).toBe('A');
      for (const handle of TIER_B) expect(get(rows, handle).tier).toBe('B');
      for (const handle of TIER_C) expect(get(rows, handle).tier).toBe('C');
    });

    it('gives every row the public URL of the channel it claims', async () => {
      // `public_url` is the link rendered on a threat card. A row pointing at a different channel
      // than the one it collects would attribute one publisher's reporting to another in the UI.
      for (const row of rows.values()) {
        expect(row.public_url).toBe(`https://t.me/${row.handle}`);
      }
    });

    it('lets no two rows anywhere claim the same channel', async () => {
      const duplicates = await sql<{ handle: string; n: string }>(
        `SELECT lower(telegram_username) AS handle,count(*)::text AS n FROM sources
         WHERE telegram_username IS NOT NULL GROUP BY 1 HAVING count(*)>1`
      );
      expect(duplicates.rows).toEqual([]);
    });

    it('does not re-register a channel the earlier migrations already own', async () => {
      // The already-integrated set: `kpszsu`, `air_alert_ua` and the eleven OSINT monitors from
      // migration 011. A second row for any of them would split one publisher's evidence across two
      // source ids and two independence groups.
      const previouslyIntegrated = [
        'kpszsu', 'air_alert_ua', 'war_monitor', 'eRadarrua', 'AerisRimor', 'kudy_letyt',
        'molfar_info', 'kyiv_airdef', 'kyiv_nebo', 'SK_DM_SK', 'ZhenyokSay',
        'ukrainian_raccoon_channel', 'vanek_nikolaev', 'radar_raketaa', 'povitryanatrivogaaa'
      ].map((handle) => handle.toLowerCase());
      expect(CATALOGUE.filter((handle) => previouslyIntegrated.includes(handle.toLowerCase())))
        .toEqual([]);
    });

    it('applies twice without changing anything', async () => {
      // Idempotence is not a property of the migration runner here — it skips applied files — it is
      // a property of the SQL, so it is exercised by running the file again against a database that
      // already has it.
      const migration = await readFile(
        resolve(process.cwd(), 'migrations/013_source_catalog_expansion.sql'), 'utf8'
      );
      const before = await sql(`SELECT id,tier,official,enabled,independence_group FROM sources ORDER BY id`);
      await expect(sql(migration)).resolves.toBeTruthy();
      await expect(sql(migration)).resolves.toBeTruthy();
      const after = await sql(`SELECT id,tier,official,enabled,independence_group FROM sources ORDER BY id`);
      expect(after.rows).toEqual(before.rows);
    });
  });

  describe('authority', () => {
    it('grants alert authority to Tier A rows only', async () => {
      for (const handle of TIER_A) {
        expect(get(rows, handle)).toMatchObject({
          official: true, adapter_type: 'mtproto_alert_channel'
        });
      }
    });

    it('never marks a Tier B or Tier C row official', async () => {
      // The single most consequential column in the table. `official=true` makes `ingestThreat`
      // stamp `evidence_level='official'` and promote the event straight to `active`, and on the
      // alert path it means the row may start and end alert periods. No monitoring channel — however
      // large, however accurate — carries a state mandate, so none of them may carry this flag.
      const monitors = [...TIER_B, ...TIER_C].map((handle) => get(rows, handle));
      expect(monitors.filter((row) => row.official)).toEqual([]);
      expect(monitors.filter((row) => row.tier === 'A')).toEqual([]);
      expect(monitors.every((row) => row.adapter_type === 'mtproto_monitor')).toBe(true);
    });

    it('keeps the self-declared "official" channels at Tier C forever', async () => {
      // "ОФІЦІЙНИЙ РАДАР", "…Офіційно❗️", "офіційний канал Дніпра" — three private channels, none
      // naming an owning authority, one of which states in its own description that it aggregates
      // other people's sources. Promoting any of them would hand alert-declaring authority to an
      // anonymous aggregator, and its alerts would arrive with `evidence_level='official'`.
      for (const handle of SELF_DECLARED_OFFICIAL) {
        expect(get(rows, handle)).toMatchObject({ tier: 'C', official: false, enabled: true });
      }
    });

    it('registers none of the forbidden handles', async () => {
      const present = await sql<{ id: string }>(
        `SELECT id FROM sources WHERE lower(telegram_username) = ANY($1::text[])`,
        [FORBIDDEN.map((handle) => handle.toLowerCase())]
      );
      expect(present.rows).toEqual([]);
    });
  });

  describe('collection state', () => {
    it('collects exactly the Tier A channels whose alert format is confirmed', async () => {
      const enabledA = TIER_A.filter((handle) => get(rows, handle).enabled);
      expect(enabledA.sort()).toEqual([...A1_ENABLED].sort());
    });

    it('leaves every A4 body registered but switched off', async () => {
      // Verified oblast administrations with zero alert posts in the sample. Registering them
      // records that they were checked; enabling them would grant alert authority on an unobserved
      // format, which is either a silent source or a false alert and never a useful one.
      for (const handle of A4_UNCONFIRMED_FORMAT) {
        expect(get(rows, handle)).toMatchObject({ official: true, tier: 'A', enabled: false });
      }
      for (const handle of [...A2_PROSE, ...A3_DSNS]) {
        expect(get(rows, handle).enabled).toBe(false);
      }
    });

    it('switches off the bodies whose alert format the parser cannot act on', async () => {
      // These three publish real alerts and are switched off anyway. `enabled` on an alert-channel
      // row means "the parser demonstrably reads this channel", not "this body is trustworthy" —
      // the trust is `tier` and `official`, and both stay true here. A channel routed to the alert
      // reconciler whose all-clear cannot be read is an oblast that looks covered and is not.
      for (const handle of A_FORMAT_NOT_READABLE) {
        expect(get(rows, handle)).toMatchObject({ official: true, tier: 'A', enabled: false });
      }
    });

    it('leaves the national alert channel enabled by catalogue rather than by collector', async () => {
      // Migration 010 inserted this row disabled and had the collector flip it on. That made the
      // flag documentation rather than a gate, which a catalogue of twenty-one rows — fifteen of
      // them switched off on purpose — cannot live with. Nothing in the application writes
      // `sources.enabled` for this adapter type any more.
      const airAlert = await sql<{ enabled: boolean; adapter_type: string }>(
        `SELECT enabled,adapter_type FROM sources WHERE id='air-alert-ua'`
      );
      expect(airAlert.rows[0]).toEqual({ enabled: true, adapter_type: 'mtproto_alert_channel' });
    });

    it('switches off the Russian-language channels', async () => {
      // `src/domain/classifier.ts` matches Ukrainian patterns and folds case with `uk-UA`, and the
      // location catalogue holds Ukrainian names only, so a Russian-language message produces no
      // threat type and no locations. An enabled row that contributes nothing is worse than a
      // disabled one: it reports healthy and its silence reads as an absence of threats.
      //
      // The 10.08.2026 re-audit found the failure is not only silence, which is why these stay off
      // rather than being enabled as harmless. Running @krymrealii's sampled posts through the real
      // classifier produced two threat events out of sixteen and both were false: a news story about
      // a political prisoner became a `guided_air_bomb` over Джанкой, because «декабре» matched the
      // KAB pattern `каб[а-яіїєґ]*` as it stood that day — `v6` replaced that pattern with the
      // abbreviation's enumerated declension and «декабре» no longer matches anything; and a report
      // that Ukrainian forces control the Kinburn spit
      // became a `uav` threat over Херсонська область and the town of Лиман, because «лиманом» is a
      // common noun in Russian and a settlement in the catalogue. @vanek_nikolaev resolved one
      // location in twenty and mis-scoped it: "мопеды в Одесской области … над Одессой … над
      // Арцизом" landed on Арциз alone, the only name spelled the same in both languages.
      for (const handle of C_RUSSIAN_LANGUAGE) expect(get(rows, handle).enabled).toBe(false);
      // The same rule, applied to the row migration 011 already registered.
      const vanek = await sql<{ enabled: boolean }>(
        `SELECT enabled FROM sources WHERE telegram_username='vanek_nikolaev'`
      );
      expect(vanek.rows[0]!.enabled).toBe(false);
    });

    it('switches off the unverified operator', async () => {
      // Seven subscribers, no identified operator, no stated data source. Still seven on 10.08.2026,
      // and the re-audit added a second reason that does not depend on the operator ever being
      // identified: all twenty sampled posts are the two-line pair "🚨 м. Київ / Повітряна тривога"
      // and "🟢 м. Київ / Відбій повітряної тривоги". That is an alert-state mirror, not threat
      // reporting — the classifier returns `not_an_assertion` on every one — and the state it
      // mirrors is already carried by `air-alert-ua` and `aerial-alerts-mirror`.
      for (const handle of C_UNVERIFIED_OPERATOR) expect(get(rows, handle).enabled).toBe(false);
    });

    it('collects every other Tier B and Tier C channel', async () => {
      expect(TIER_B.filter((handle) => !get(rows, handle).enabled)).toEqual([]);
      const offByDesign = [...C_RUSSIAN_LANGUAGE, ...C_UNVERIFIED_OPERATOR];
      expect(TIER_C.filter((handle) => !get(rows, handle).enabled).sort()).toEqual(offByDesign.sort());
    });
  });

  describe('independence groups', () => {
    it('collapses a body and its head into one group', async () => {
      // An administration's channel and the personal channel of the person who heads it are one
      // authority speaking twice — the Zaporizhzhia OVA channel visibly reposts the head's channel,
      // and the Kharkiv pair duplicate each other near-verbatim. Separate groups would let one
      // official statement, copied, satisfy the two-independent-sources rule against itself.
      expect(get(rows, 'ivan_fedorov_zp').independence_group)
        .toBe(get(rows, 'zoda_gov_ua').independence_group);
      expect(get(rows, 'synegubov').independence_group)
        .toBe(get(rows, 'kharkivoda').independence_group);
      // Same rule across tiers: the author of `Zhyvytskyy` heads the Sumy OVA, so his personal
      // channel shares the OVA's group even though the channel itself is only Tier C.
      expect(get(rows, 'Zhyvytskyy').independence_group)
        .toBe(get(rows, 'Sumy_news_ODA').independence_group);
    });

    it('splits Tier B into exactly two clusters, not seven independent monitors', async () => {
      // The rule this encodes, and the reason it is not one-group-per-channel:
      //
      // Two Tier B groups agreeing promotes a threat event to `confirmed` with no official source
      // involved. Seven groups would therefore mean any two of these channels saying the same thing
      // is a confirmation — and the Ukrainian "radar" channel ecosystem does not work that way. They
      // draw on the same informal pool of local spotters, who post one sighting into several chats
      // and bots at once. Two channels relaying one spotter is one observation; counting it as two
      // is precisely the failure the independence rule exists to prevent.
      //
      // So corroboration is made to fire *between* clusters: a launch observation agreeing with an
      // in-flight observation, or either agreeing with a Tier A source. Agreement inside a cluster
      // proves only that the cluster is talking to itself.
      const groups = new Set(TIER_B.map((handle) => get(rows, handle).independence_group));
      expect(groups.size).toBe(2);

      const launch = new Set(B_LAUNCH_DETECTION.map((h) => get(rows, h).independence_group));
      const flight = new Set(B_FLIGHT_TRACKING.map((h) => get(rows, h).independence_group));
      expect(launch.size).toBe(1);
      expect(flight.size).toBe(1);
      expect([...launch][0]).not.toBe([...flight][0]);
      // Both channels in the launch cluster watch the same Russian airfields by the same method, so
      // two reports of one take-off are one take-off.
      expect([...launch][0]).toBe('osint-launch-detection');
      expect([...flight][0]).toBe('osint-flight-tracking');
    });

    it('collapses each clone network into one group', async () => {
      // Three cases where two rows would otherwise look like two witnesses to one operator's bot:
      // an identical title template plus a shared embedded advertiser, an identical bilingual title
      // template with the city swapped, and one "Сирена" handle family whose format is a relay of
      // the shared official alerts API rather than an observation.
      const sameGroup = (a: string, b: string) =>
        expect(get(rows, a).independence_group).toBe(get(rows, b).independence_group);
      sameGroup('kharkivalarm', 'cherkasyalarm');
      sameGroup('lviv_alert', 'khmelnytskyi_alert');
      sameGroup('surenasumy', 'surenakrop');
      // Regional bureaux of one public broadcaster with one editorial pipeline.
      sameGroup('suspilnemykolaiv', 'suspilnechernihiv');
      sameGroup('suspilnemykolaiv', 'suspilnekropyvnytskyi');
    });

    it('keeps two channels over one oblast apart when only geography links them', async () => {
      // `alarm_cherkasy` and `cherkasyalarm` both cover Cherkasy oblast and are deliberately *not*
      // grouped: different title convention, finer raion granularity, its own UAV tracking. The
      // clone groups above rest on observed operator evidence, and this is the assertion that keeps
      // "same region" from quietly becoming the criterion.
      expect(get(rows, 'alarm_cherkasy').independence_group)
        .not.toBe(get(rows, 'cherkasyalarm').independence_group);
    });

    it('gives every other row a group of its own', async () => {
      const shared = new Set([
        'zoda_gov_ua', 'ivan_fedorov_zp', 'kharkivoda', 'synegubov', 'Sumy_news_ODA', 'Zhyvytskyy',
        ...A3_DSNS, ...TIER_B, 'kharkivalarm', 'cherkasyalarm', 'lviv_alert', 'khmelnytskyi_alert',
        'surenasumy', 'surenakrop', 'suspilnemykolaiv', 'suspilnechernihiv', 'suspilnekropyvnytskyi'
      ].map((handle) => handle.toLowerCase()));
      const independent = CATALOGUE.filter((handle) => !shared.has(handle.toLowerCase()));
      const groups = independent.map((handle) => get(rows, handle).independence_group);
      expect(new Set(groups).size).toBe(independent.length);
      // …and none of them collides with a group used by a shared cluster or by an earlier migration.
      const all = await sql<{ independence_group: string }>(`SELECT independence_group FROM sources`);
      for (const handle of independent) {
        const group = get(rows, handle).independence_group;
        expect(all.rows.filter((row) => row.independence_group === group)).toHaveLength(1);
      }
    });
  });

  describe('routing', () => {
    it('routes every enabled monitor through the classifier registry', async () => {
      const { loadMonitoredTelegramChannels } = await import('../../src/services/ingestion.js');
      const routed = new Map((await loadMonitoredTelegramChannels()).map((c) => [c.username, c.sourceId]));
      for (const handle of [...TIER_B, ...TIER_C]) {
        const row = get(rows, handle);
        expect(routed.get(handle.toLowerCase())).toBe(row.enabled ? row.id : undefined);
      }
    });

    it('routes no Tier A row through the classifier registry', async () => {
      // `mtproto_alert_channel` is not a classifier adapter type, so an official row can never reach
      // `ingestThreat`. It is now also excluded by handle, so a monitoring row cannot shadow an
      // official channel by claiming its name.
      const { loadMonitoredTelegramChannels } = await import('../../src/services/ingestion.js');
      const routed = await loadMonitoredTelegramChannels();
      const usernames = new Set(routed.map((channel) => channel.username));
      for (const handle of TIER_A) expect(usernames.has(handle.toLowerCase())).toBe(false);
    });

    it('routes exactly the enabled Tier A rows through the alert registry', async () => {
      // The other half of the split. `loadAlertChannels` is what the collector subscribes to on the
      // alert path, and a registered-but-switched-off row must not appear in it: registering a body
      // records that it was checked, and only `enabled` grants it authority to declare an alert.
      const { loadAlertChannels } = await import('../../src/services/ingestion.js');
      const alertRoutes = new Map((await loadAlertChannels()).map((c) => [c.username, c.sourceId]));
      for (const handle of TIER_A) {
        const row = get(rows, handle);
        expect(alertRoutes.get(handle.toLowerCase())).toBe(row.enabled ? row.id : undefined);
      }
      // The national channel from migration 010 rides the same registry, with no special case.
      expect(alertRoutes.get('air_alert_ua')).toBe('air-alert-ua');
    });
  });
});
