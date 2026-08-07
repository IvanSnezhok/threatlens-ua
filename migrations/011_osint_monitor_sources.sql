-- OSINT air-threat monitoring channels, and the column that makes the collector's channel list
-- data-driven instead of a constant plus an `if` in `src/sources/telegram.ts`.
--
-- ## Why a dedicated column and not `public_url`
--
-- The channel username is an *identity key*: the collector maps an incoming MTProto message to the
-- `sources` row that owns it, and getting that mapping wrong silently attributes evidence to the
-- wrong publisher, which is exactly what the independence-group rule depends on. `public_url` is a
-- *display* field — it is rendered as the "source" link on every threat card — so it is edited for
-- presentation reasons: a trailing slash, the `https://t.me/s/<name>` preview form, or a link to the
-- channel's website instead of its Telegram page. Deriving identity from it would turn a cosmetic
-- edit into a collector that quietly stops reading a channel, with no error anywhere.
--
-- A dedicated column also states the invariant the parsing approach cannot: `lower(telegram_username)`
-- is unique, so two rows can never claim the same channel and the username -> source_id map is a
-- function by construction.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS telegram_username text;

CREATE UNIQUE INDEX IF NOT EXISTS sources_telegram_username_uidx
  ON sources (lower(telegram_username)) WHERE telegram_username IS NOT NULL;

-- Guard rails for the new adapter type, enforced by the database rather than by a code review.
--
-- `mtproto_monitor` is the classifier-path adapter: its messages become `threat_events` and never
-- touch `alert_source_states` or `alert_periods`. Three properties have to hold for that to stay
-- true and for the evidence model to stay honest, so they are constraints:
--   * a username is mandatory — a monitor row without one is a row the collector cannot route;
--   * `official=false` — an official row would make `ingestThreat` stamp `evidence_level='official'`
--     on OSINT reporting and promote the event straight to `active`;
--   * `tier<>'A'` — Tier A is reserved for sources with a state mandate.
ALTER TABLE sources ADD CONSTRAINT sources_mtproto_monitor_check
  CHECK (
    adapter_type <> 'mtproto_monitor'
    OR (telegram_username IS NOT NULL AND official = false AND tier <> 'A')
  ) NOT VALID;

-- The two channels the collector already reads, so the whole list comes from one place. The alert
-- channel's username stays owned by `ALERT_CHANNEL_USERNAME`; the value here is documentation and
-- the uniqueness anchor that stops a monitor row from claiming the same channel.
UPDATE sources SET telegram_username='kpszsu' WHERE id='air-force' AND telegram_username IS NULL;
UPDATE sources SET telegram_username='air_alert_ua' WHERE id='air-alert-ua' AND telegram_username IS NULL;

-- Three independent OSINT air-threat monitors.
--
-- All three publish original monitoring — directions, target types, timestamps, distances — rather
-- than reposting each other, which is what makes separate `independence_group` values correct.
-- The consequence is deliberate and load-bearing: agreement between any two of them promotes a
-- threat event to `confirmed` through the two-independent-sources rule in `ingestThreat`, without
-- any official source being involved. None of them can raise or clear an official alert: they are
-- `official=false`, they carry the classifier-path adapter, and no code path from `processMessage`
-- reaches the alert reconciler.
--
-- `enabled=true` on insert, unlike `air-alert-ua`: these rows need no credential of their own beyond
-- the MTProto session the collector already requires, and unlike the official adapters the flag is a
-- real gate here — `loadMonitoredTelegramChannels` will not subscribe to a row with `enabled=false`.
-- Tier C rows are visible on the map and in the history exactly like Tier B ones, and they are
-- deliberately weaker in two places that are already implemented and not touched here: the
-- corroboration rule in `ingestThreat` counts only tier A and B groups, so a Tier C channel can
-- never promote an event to `confirmed` on its own, and `src/services/risk.ts` caps a location whose
-- signals are all Tier C at 3.9. The tier is the statement "this publisher is worth showing, but not
-- worth confirming on".
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('osint-war-monitor','War Monitor','telegram','B',false,true,'mtproto_monitor','osint-war-monitor',
   60,300,'https://t.me/war_monitor','war_monitor'),
  ('osint-eradar','єРадар','telegram','B',false,true,'mtproto_monitor','osint-eradar',
   60,300,'https://t.me/eRadarrua','eRadarrua'),
  ('osint-aeris-rimor','Aeris Rimor','telegram','B',false,true,'mtproto_monitor','osint-aeris-rimor',
   60,300,'https://t.me/AerisRimor','AerisRimor'),
  ('osint-rynda','Ринда моніторить','telegram','B',false,true,'mtproto_monitor','osint-rynda',
   60,300,'https://t.me/kudy_letyt','kudy_letyt'),
  ('osint-molfar','Мольфар','telegram','B',false,true,'mtproto_monitor','osint-molfar',
   60,300,'https://t.me/molfar_info','molfar_info'),
  ('osint-kyiv-airdef','Kyiv AirDefense','telegram','B',false,true,'mtproto_monitor','osint-kyiv-airdef',
   60,300,'https://t.me/kyiv_airdef','kyiv_airdef'),
  -- Tier C: single-region, crowdsourced, hybrid or personal. Each is its own independence group
  -- because each does its own observing; what makes them C is coverage and signal purity, not
  -- dependence on somebody else's reporting.
  --
  -- `kyiv_nebo` covers Kyiv only. That is the reason for the tier: a source whose silence about
  -- Zaporizhzhia carries no information cannot be read as evidence about Zaporizhzhia, and tiering it
  -- B would let two Kyiv-only observers look like national corroboration.
  ('osint-kyiv-nebo','Київське небо','telegram','C',false,true,'mtproto_monitor','osint-kyiv-nebo',
   60,300,'https://t.me/kyiv_nebo','kyiv_nebo'),
  ('osint-sk','#SK# говорить','telegram','C',false,true,'mtproto_monitor','osint-sk',
   60,300,'https://t.me/SK_DM_SK','SK_DM_SK'),
  ('osint-zhenyok','Женьок Вещає','telegram','C',false,true,'mtproto_monitor','osint-zhenyok',
   60,300,'https://t.me/ZhenyokSay','ZhenyokSay'),
  ('osint-raccoon','Український Єнот','telegram','C',false,true,'mtproto_monitor','osint-raccoon',
   60,300,'https://t.me/ukrainian_raccoon_channel','ukrainian_raccoon_channel'),
  -- Distinct from `kudy_letyt` ("Ринда моніторить") above despite the near-identical meaning of the
  -- two names. Different publisher, different reach, its own independence group; the unique index on
  -- `telegram_username` is what makes "is this the same channel?" a question with one answer.
  ('osint-radar-raketaa','Куди летить? | Тривога','telegram','B',false,true,'mtproto_monitor',
   'osint-radar-raketaa',60,300,'https://t.me/radar_raketaa','radar_raketaa'),
  -- Tier C on 714k subscribers, and the subscriber count is not the reason for either direction.
  -- The channel aggregates other publishers and says so inside its own posts ("— місцеві пабліки"),
  -- so its reporting is not independent observation, and a large part of it is maps and images with
  -- no text for the classifier to read. Tier C keeps it visible without letting it corroborate.
  ('osint-trivoga-map','Карта повітряних тривог','telegram','C',false,true,'mtproto_monitor',
   'osint-trivoga-map',60,300,'https://t.me/povitryanatrivogaaa','povitryanatrivogaaa')
ON CONFLICT (id) DO NOTHING;

-- Николаевский Ванёк: a repost aggregator, and the one row here that shares an independence group.
--
-- `independence_group='air-force'` — the same group as `kpszsu` — is the whole point of the row. The
-- channel republishes official Ukrainian military reporting, so treating it as its own group would
-- let the project's own rule be defeated by a copy: the identical statement, counted twice, would
-- reach the two-independent-sources threshold and promote an event to `confirmed` on the strength of
-- one publisher. Sharing the group makes the corroboration query collapse the two into one, which is
-- what "reposts from one group count as one source" means in SQL.
--
-- `enabled=false`, and this is not a placeholder for credentials. The channel publishes in Russian,
-- while the classifier matches Ukrainian patterns and folds case with `uk-UA`, and the location
-- catalogue holds Ukrainian names only. "4 реактивных мопеда… над Броварами… под Васильковом"
-- yields no threat type and no locations today, and a source that is switched on while silently
-- contributing nothing is worse than one that is honestly off: it reports healthy, it occupies a
-- slot in the source list, and its silence looks like an absence of threats. Enabling it needs
-- Russian-language patterns and Russian location aliases first — tracked as separate work.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('osint-vanek-nikolaev','Николаевский Ванёк','telegram','C',false,false,'mtproto_monitor','air-force',
   60,300,'https://t.me/vanek_nikolaev','vanek_nikolaev')
ON CONFLICT (id) DO NOTHING;
