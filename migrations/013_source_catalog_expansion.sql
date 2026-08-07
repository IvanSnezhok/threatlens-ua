-- The verified channel catalogue: 58 Telegram sources registered as rows, not as code.
--
-- Migration 011 made the collector's channel list data-driven so that adding a publisher is an
-- INSERT rather than an edit to `src/sources/telegram.ts`. This migration is the first time that
-- claim is actually exercised at scale: 68 candidate channels were researched, 59 verified as
-- existing and usable, one of those rejected on editorial grounds (`ComAFUA`, see the negative list
-- at the foot of this file), and the remaining 58 are registered here.
--
-- Three things are decided per row and nothing else is: what tier the publisher speaks at, whether
-- it carries a state mandate, and which independence group its agreement belongs to. Those three
-- columns are the entire evidence model — `src/repositories/events.ts` reads them to pick an
-- `evidence_level` and to decide whether two reports corroborate, and `src/services/risk.ts` reads
-- them to cap a location whose signals are all Tier C. Getting them right here is the whole job;
-- there is no code in this migration because there should not need to be any.
--
-- ## What `enabled=false` means on these rows, and why so many of them carry it
--
-- For `mtproto_monitor` rows the flag is a real gate: `loadMonitoredTelegramChannels` will not
-- subscribe to a disabled row. For `mtproto_alert_channel` rows it is currently documentation —
-- the alert path still routes exactly one username (`config.ALERT_CHANNEL_USERNAME`) to exactly one
-- source id (`ALERT_CHANNEL_SOURCE_ID`), so none of the official rows below are read yet by anyone.
-- That is deliberate: the catalogue is the input the routing change needs, and registering it first
-- means the routing change is a code change against a fixed, reviewed list rather than a code change
-- that also has to invent the list.
--
-- A row that is switched on while contributing nothing is worse than one that is honestly off. It
-- reports healthy, it occupies a slot in the source list, and its silence reads as an absence of
-- threats. Every `enabled=false` below is a statement that something concrete is still missing —
-- named in the comment above the row — and not a placeholder.

-- ------------------------------------------------------------------------------------------------
-- Tier A — bodies with a state mandate to declare an air-raid alert
-- ------------------------------------------------------------------------------------------------
--
-- `official=true` and `adapter_type='mtproto_alert_channel'` together mean one thing: a message from
-- this row may start or end an official alert period. That is the strongest authority the system
-- grants, so it is granted only where the body's alert format has actually been observed.
--
-- ## A1 — confirmed structured alert format, `enabled=true`
--
-- These seven publish a stable, machine-readable three-shape format:
--
--   🔴 <район> - повітряна тривога!
--   🟡 <район> - відбій ... Зверніть увагу, повітряна тривога досі триває у: ...
--   🟢 <район> - відбій повітряної тривоги!
--
-- Enabled because the format is confirmed, not because the body is important. The distinction is the
-- point of the A1/A4 split below.
--
-- TWO PREREQUISITES BEFORE THESE ROWS PRODUCE ANYTHING, both outside this migration:
--
--   1. Routing. The alert path resolves one username (`config.ALERT_CHANNEL_USERNAME`) to one
--      hard-coded source id (`ALERT_CHANNEL_SOURCE_ID` in `src/services/ingestion.ts`), and
--      `mtproto_alert_channel` is not a classifier adapter type, so no collector subscribes to these
--      rows at all today. `alert_source_states` is already keyed by `source_id` and
--      `reconcileAggregateAlert` already takes one, so the storage model is multi-source already —
--      the constant is the whole of the gap.
--
--   2. Parsing. `parseAlertChannelMessage` was written for the `air_alert_ua` word order,
--      "🔴 13:47 Повітряна тривога в <район>", and its START/END phrase patterns are anchored to the
--      start of the headline. The shape above puts the location first and the phrase after a dash,
--      and returns `unrecognized` today — verified against the current parser. Wiring the routing
--      without extending the parser yields seven official sources that publish alerts the collector
--      logs as unknown shapes and never acts on.
--
-- `enabled=true` here is therefore a statement about the channel, not about readiness: it records
-- that these seven are the ones whose format has been observed and that they are the intended first
-- users of the multi-channel alert path once it exists.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('gov-kherson-oda','Херсонська ОВА','telegram','A',true,true,'mtproto_alert_channel',
   'gov-kherson-oda',60,300,'https://t.me/khersonskaODA','khersonskaODA'),
  -- The city military administration is a different body from the oblast one, with its own mandate
  -- over the city and the Khersonskyi raion, so it gets its own group. Two bodies covering
  -- overlapping ground is not the same thing as one body copied twice.
  ('gov-kherson-mva','Херсонська МВА','telegram','A',true,true,'mtproto_alert_channel',
   'gov-kherson-mva',60,300,'https://t.me/kherson_miskrada','kherson_miskrada'),
  ('gov-odesa-oda','Одеська ОВА (Олег Кіпер)','telegram','A',true,true,'mtproto_alert_channel',
   'gov-odesa-oda',60,300,'https://t.me/odeskaODA','odeskaODA'),
  -- Kyiv *oblast*, not the city. KMVA is a different body and is not in this catalogue; the map
  -- treats `ua-32` and `ua-80` as separate locations and this row speaks only for the former.
  ('gov-kyiv-oblast-oda','Київська ОВА','telegram','A',true,true,'mtproto_alert_channel',
   'gov-kyiv-oblast-oda',60,300,'https://t.me/kyivoda','kyivoda'),
  ('gov-vinnytsia-oda','Вінницька ОВА','telegram','A',true,true,'mtproto_alert_channel',
   'gov-vinnytsia-oda',60,300,'https://t.me/VinnytsiaODA','VinnytsiaODA'),
  ('gov-zaporizhzhia-oda','Запорізька ОВА','telegram','A',true,true,'mtproto_alert_channel',
   'gov-zaporizhzhia-oda',60,300,'https://t.me/zoda_gov_ua','zoda_gov_ua'),
  -- SHARED GROUP with `gov-zaporizhzhia-oda`, and this is the load-bearing part of the row.
  --
  -- The personal channel of the head of the Zaporizhzhia OVA and the OVA's own channel are the same
  -- authority speaking twice — the OVA channel visibly reposts the personal one. Giving them
  -- separate groups would let one official statement, copied, reach the two-independent-sources
  -- threshold on its own. Sharing the group makes the corroboration query collapse them into one,
  -- which is what "a repost is not a second witness" means in SQL.
  ('gov-zaporizhzhia-head','Іван Федоров (Запорізька ОВА)','telegram','A',true,true,
   'mtproto_alert_channel','gov-zaporizhzhia-oda',60,300,
   'https://t.me/ivan_fedorov_zp','ivan_fedorov_zp')
ON CONFLICT (id) DO NOTHING;

-- ## A2 — official body, real operational content, free-prose format, `enabled=false`
--
-- These four are genuine authorities publishing genuine operational reporting, but they write it as
-- prose: strike consequences, casualty figures, alert duration in hours. `parseAlertChannelMessage`
-- would return `unrecognized` for almost everything they publish, and the few messages it did match
-- would be matched by accident. Enabling them would not produce alerts; it would produce a log full
-- of unrecognised shapes and an occasional false one.
--
-- What unblocks them is a parser that reads their wording, not a flag flip.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('gov-kharkiv-oda','Харківська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-kharkiv-oda',60,300,'https://t.me/kharkivoda','kharkivoda'),
  -- SHARED GROUP with `gov-kharkiv-oda`: the head of the oblast administration and the
  -- administration itself duplicate each other near-verbatim. Same reasoning as the Zaporizhzhia
  -- pair above — the duplication is observable in the sampled feeds, so the group states it.
  ('gov-kharkiv-head','Олег Синєгубов (Харківська ОВА)','telegram','A',true,false,
   'mtproto_alert_channel','gov-kharkiv-oda',60,300,'https://t.me/synegubov','synegubov'),
  ('gov-sumy-oda','Сумська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-sumy-oda',60,300,'https://t.me/Sumy_news_ODA','Sumy_news_ODA'),
  -- Hromada-level authority, and the only sub-oblast body in the A set besides Kherson city. Its
  -- reporting is about Sloviansk alone, which is why it can never stand in for Donetsk oblast.
  ('gov-sloviansk-mva','Слов''янська МВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-sloviansk-mva',60,300,'https://t.me/slv_vca','slv_vca')
ON CONFLICT (id) DO NOTHING;

-- ## A3 — the State Emergency Service, `enabled=false`
--
-- DSNS is unquestionably official, and that is exactly the problem. Its channels report the
-- *aftermath* — what burned, who was rescued, how many crews were deployed — and they publish it
-- after the fact. A first-alert path fed by after-action reports would declare alerts that started
-- in the past and would never clear them, because nothing in that reporting is an all-clear.
--
-- One shared independence group for all three: they are one agency. The national channel republishes
-- what the oblast directorates file, so counting a regional report and its national repost as two
-- witnesses would be counting the same agency twice.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('gov-dsns-ua','ДСНС України','telegram','A',true,false,'mtproto_alert_channel',
   'gov-dsns',60,300,'https://t.me/dsns_telegram','dsns_telegram'),
  ('gov-dsns-kharkiv','ДСНС Харківщини','telegram','A',true,false,'mtproto_alert_channel',
   'gov-dsns',60,300,'https://t.me/DSNS_Kharkiv','DSNS_Kharkiv'),
  ('gov-dsns-kyiv-oblast','ДСНС Київщини','telegram','A',true,false,'mtproto_alert_channel',
   'gov-dsns',60,300,'https://t.me/dsns_kyiv_region','dsns_kyiv_region')
ON CONFLICT (id) DO NOTHING;

-- ## A4 — body confirmed, alert format NOT confirmed, `enabled=false`
--
-- THIS IS THE MOST IMPORTANT DECISION IN THIS FILE.
--
-- Every row below is a verified oblast military administration. Every one of them is a body that may
-- lawfully declare an air-raid alert. And in the verified sample, not one of them published a single
-- post about an alert — the feeds are grants, road repairs, school openings and condolences.
--
-- Registering them as `official=true` is correct: that is what they are, and the row is the place
-- that fact belongs. Enabling them is not, and the reason is that "official" is not a compliment in
-- this system, it is an authority: `ingestThreat` stamps `evidence_level='official'` on anything an
-- official row publishes and promotes the event straight to `active`, and the alert path lets an
-- official alert-channel row start and end alert periods outright.
--
-- So giving alert authority to a source whose alert format has never been observed has exactly two
-- possible outcomes, and both are bad:
--
--   * the channel genuinely never posts alerts — and we have added a silent source whose silence is
--     indistinguishable from calm, on an oblast where we then believe we have coverage; or
--   * the parser matches something in its ordinary news — and a post about a school opening becomes
--     an official air-raid alert for an entire oblast, with the highest evidence level the system
--     has and a notification to every subscriber of that oblast.
--
-- There is no third outcome where enabling them helps. What unblocks a row here is one thing: an
-- observed alert message from that specific channel, pasted into a parser fixture. Until then the
-- row is a registered, documented, deliberately-silent capability.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('gov-chernihiv-oda','Чернігівська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-chernihiv-oda',60,300,'https://t.me/chernigivskaODA','chernigivskaODA'),
  ('gov-zhytomyr-oda','Житомирська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-zhytomyr-oda',60,300,'https://t.me/zhytomyrskaODA','zhytomyrskaODA'),
  ('gov-poltava-oda','Полтавська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-poltava-oda',60,300,'https://t.me/poltavskaOVA','poltavskaOVA'),
  -- Dnipropetrovsk is the clearest case of the pattern: the oblast's real alert traffic runs through
  -- a network of local city channels (`dnipro_alerts`, `sirena_dp` below), not through the oblast
  -- administration's own feed. Enabling this row would give alert authority to the one channel in
  -- the region that demonstrably does not carry alerts.
  ('gov-dnipropetrovsk-oda','Дніпропетровська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-dnipropetrovsk-oda',60,300,'https://t.me/dnipropetrovskaODA','dnipropetrovskaODA'),
  ('gov-donetsk-oda','Донецька ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-donetsk-oda',60,300,'https://t.me/DonetskaODA','DonetskaODA'),
  ('gov-rivne-oda','Рівненська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-rivne-oda',60,300,'https://t.me/oda_rv','oda_rv'),
  ('gov-ternopil-oda','Тернопільська ОВА','telegram','A',true,false,'mtproto_alert_channel',
   'gov-ternopil-oda',60,300,'https://t.me/ternopilskaODA','ternopilskaODA')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------------------------
-- Tier B — national OSINT monitoring: seven channels, TWO independence groups
-- ------------------------------------------------------------------------------------------------
--
-- The seven below all publish original national monitoring and none of them forwards another, so the
-- obvious reading is seven independent groups. That reading is wrong, and the corroboration rule is
-- what makes it dangerous: two Tier B groups agreeing promotes a threat event to `confirmed` with no
-- official source involved. Seven groups would mean any two of these channels saying the same thing
-- is a confirmation.
--
-- The Ukrainian "radar" channel ecosystem does not work that way. These channels draw on the same
-- informal pool of local spotters, who post the same sighting into several chats and bots at once.
-- Two channels reporting one spotter's observation is one observation, and reading it as two is the
-- precise failure the independence rule exists to prevent. Agreement *inside* a cluster is not
-- corroboration; the threshold is meant to fire *between* clusters.
--
-- So: two groups, drawn along how the observation is actually produced.
--
--   * `osint-launch-detection` — StrategicaviationT + strategicontrol. Both watch the same narrow
--     set of Russian airfields (Engels-2, Belaya, Ukrainka, Shaykovka) by the same method, radio
--     intercepts plus OSINT spotters. Two reports of one bomber taking off is one take-off.
--   * `osint-flight-tracking` — the other five. In-flight tracking of missiles and UAVs across
--     Ukraine, all fed by the shared spotter pool described above.
--
-- The consequence is deliberate: a threat reaches `confirmed` on OSINT alone only when a launch
-- observation and an in-flight observation agree, or when one of these agrees with a Tier A source.
-- That is a meaningfully harder test than "two radar channels said the same thing", which is exactly
-- what it should be.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('osint-strategic-aviation','Стратегічна авіація','telegram','B',false,true,'mtproto_monitor',
   'osint-launch-detection',60,300,'https://t.me/StrategicaviationT','StrategicaviationT'),
  ('osint-strategic-control','Strategic Control','telegram','B',false,true,'mtproto_monitor',
   'osint-launch-detection',60,300,'https://t.me/strategicontrol','strategicontrol'),
  ('osint-raketa-trevoga','Чому тривога | Радар','telegram','B',false,true,'mtproto_monitor',
   'osint-flight-tracking',60,300,'https://t.me/raketa_trevoga','raketa_trevoga'),
  ('osint-monikppy','Повітряний простір України','telegram','B',false,true,'mtproto_monitor',
   'osint-flight-tracking',60,300,'https://t.me/monikppy','monikppy'),
  ('osint-operinform','Оперативний Інформ','telegram','B',false,true,'mtproto_monitor',
   'osint-flight-tracking',60,300,'https://t.me/operinform','operinform'),
  ('osint-deraketaua','Де Ракета?','telegram','B',false,true,'mtproto_monitor',
   'osint-flight-tracking',60,300,'https://t.me/deraketaua','deraketaua'),
  ('osint-monitor-ukr','Моніторинг | Україна','telegram','B',false,true,'mtproto_monitor',
   'osint-flight-tracking',60,300,'https://t.me/monitor_ukr','monitor_ukr')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------------------------
-- Tier C — regional and hybrid monitoring
-- ------------------------------------------------------------------------------------------------
--
-- Tier C is not a demotion for being small. It is the statement "worth showing, not worth confirming
-- on": the corroboration rule counts only Tier A and B groups, so nothing here can promote an event
-- to `confirmed`, and `src/services/risk.ts` caps a location whose signals are all Tier C at 3.9.
-- What lands a channel here is single-oblast coverage, a feed mixing alerts with fundraising and
-- advertising, or an unverified operator — never subscriber count in either direction.
--
-- Each row gets its own independence group by default, because each does its own observing. The
-- exceptions are the four clone/echo clusters called out below; each one is a case where two rows
-- would otherwise look like two witnesses to one publisher's work.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('osint-sumyregion','Sumyregion','telegram','C',false,true,'mtproto_monitor',
   'osint-sumyregion',60,300,'https://t.me/sumyregion','sumyregion'),
  -- SHARED GROUP with `gov-sumy-oda`. The author is the sitting head of the Sumy OVA, so this is the
  -- same authority as the OVA channel, published as a personal blog. Tier C rather than A because
  -- the *channel* is a blog — political commentary and holiday greetings mixed with damage reports,
  -- plus reposts of other outlets — and a format like that cannot be given alert authority. The
  -- group keeps the two from ever counting as two.
  ('osint-zhyvytskyi','Дмитро Живицький (Сумська ОВА)','telegram','C',false,true,'mtproto_monitor',
   'gov-sumy-oda',60,300,'https://t.me/Zhyvytskyy','Zhyvytskyy'),
  ('osint-ppo-radar','ППО РАДАР | Повітряний простір','telegram','C',false,true,'mtproto_monitor',
   'osint-ppo-radar',60,300,'https://t.me/ppouaradar','ppouaradar'),
  -- Mostly forwards from other channels. Its own group only because the channels it forwards are not
  -- in this catalogue; if they are ever added, this row must join theirs.
  ('osint-pukhnastyi-radar','Пухнастий радар','telegram','C',false,true,'mtproto_monitor',
   'osint-pukhnastyi-radar',60,300,'https://t.me/radar_ukr','radar_ukr'),
  -- CLONE NETWORK `osint-alarm-clone-network`, with `osint-cherkasy-alarm` below. Identical title
  -- template ("Повітряна тривога <місто> (<область> область)"), identical embedded advertiser, and
  -- neither shows evidence of its own observation — the same operator running one bot per oblast.
  -- Different oblasts, so the shared group costs nothing in coverage and buys the guarantee that two
  -- instances of one bot can never read as two observers.
  ('osint-kharkiv-alarm','Повітряна тривога Харків','telegram','C',false,true,'mtproto_monitor',
   'osint-alarm-clone-network',60,300,'https://t.me/kharkivalarm','kharkivalarm'),
  ('osint-zaporizhzhia-info','ЗАПОРІЖЖЯ.ІНФО','telegram','C',false,true,'mtproto_monitor',
   'osint-zaporizhzhia-info',60,300,'https://t.me/info_zp','info_zp'),
  ('osint-dnipro-alerts','Дніпро Alerts','telegram','C',false,true,'mtproto_monitor',
   'osint-dnipro-alerts',60,300,'https://t.me/dnipro_alerts','dnipro_alerts'),
  ('osint-suspilne-mykolaiv','Суспільне Миколаїв','telegram','C',false,true,'mtproto_monitor',
   'media-suspilne',60,300,'https://t.me/suspilnemykolaiv','suspilnemykolaiv'),
  ('osint-warning-odesa','Сповіщення Одеса','telegram','C',false,true,'mtproto_monitor',
   'osint-warning-odesa',60,300,'https://t.me/warningodesa','warningodesa'),
  -- SIREN NETWORK `osint-surena-network`, with `osint-surena-kirovohrad` below: one operator's
  -- "Сирена" family, same handle stem, same message template across two oblasts. The Sumy channel's
  -- own verification note says its format is identical to other district alert bots built on the
  -- shared official alerts API — i.e. it relays rather than observes.
  ('osint-surena-sumy','Тривога. Сумська область','telegram','C',false,true,'mtproto_monitor',
   'osint-surena-network',60,300,'https://t.me/surenasumy','surenasumy'),
  -- SUSPILNE `media-suspilne`, three rows: Mykolaiv, Chernihiv, Kropyvnytskyi. Regional bureaux of
  -- one public broadcaster with one editorial pipeline, each visibly reposting the parent channel.
  -- Three bureaux of one newsroom agreeing is one newsroom agreeing.
  ('osint-suspilne-chernihiv','Суспільне Чернігів','telegram','C',false,true,'mtproto_monitor',
   'media-suspilne',60,300,'https://t.me/suspilnechernihiv','suspilnechernihiv'),
  ('osint-lviv-alarm-map','Повітряна тривога Львів','telegram','C',false,true,'mtproto_monitor',
   'osint-lviv-alarm-map',60,300,'https://t.me/mapa_karta','mapa_karta'),
  -- CLONE NETWORK `osint-siren-clone-network`, with `osint-khmelnytskyi-alert` below. The two titles
  -- are the same bilingual template with the city swapped ("<МІСТО> / СИРЕНИ / ПОВІТРЯНА ТРИВОГА /
  -- <ГОРОД> / СИРЕНЫ / ВОЗДУШНАЯ ТРЕВОГА"); same operator, one instance per city.
  ('osint-lviv-alert','Львів | Сирени | Повітряна тривога','telegram','C',false,true,'mtproto_monitor',
   'osint-siren-clone-network',60,300,'https://t.me/lviv_alert','lviv_alert'),
  ('osint-volyn-alert','Оповіщення Волинь','telegram','C',false,true,'mtproto_monitor',
   'osint-volyn-alert',60,300,'https://t.me/Uvaga_tryvoha_Volyn','Uvaga_tryvoha_Volyn'),
  ('osint-frankivsk-112','Frankivsk 112','telegram','C',false,true,'mtproto_monitor',
   'osint-frankivsk-112',60,300,'https://t.me/if112','if112'),
  ('osint-khmelnytskyi-alert','Хмельницький | Сирени | Повітряна тривога','telegram','C',false,true,
   'mtproto_monitor','osint-siren-clone-network',60,300,
   'https://t.me/khmelnytskyi_alert','khmelnytskyi_alert'),
  ('osint-vinnytsia-alert','Тривога Вінниця','telegram','C',false,true,'mtproto_monitor',
   'osint-vinnytsia-alert',60,300,'https://t.me/trevoga_vinnitsa_noviny','trevoga_vinnitsa_noviny'),
  -- Deliberately NOT in `osint-alarm-clone-network` with `osint-cherkasy-alarm`, despite both
  -- covering Cherkasy oblast: different title convention, finer raion granularity, and its own UAV
  -- tracking. Two channels over one oblast are not automatically one publisher — the clone groups
  -- above rest on observed template and operator evidence, not on geography.
  ('osint-cherkasy-radar','Радар Черкаси | Повітряна тривога','telegram','C',false,true,'mtproto_monitor',
   'osint-cherkasy-radar',60,300,'https://t.me/alarm_cherkasy','alarm_cherkasy'),
  ('osint-cherkasy-alarm','Повітряна тривога Черкаси','telegram','C',false,true,'mtproto_monitor',
   'osint-alarm-clone-network',60,300,'https://t.me/cherkasyalarm','cherkasyalarm'),
  ('osint-surena-kirovohrad','Сирена Кіровоградщина','telegram','C',false,true,'mtproto_monitor',
   'osint-surena-network',60,300,'https://t.me/surenakrop','surenakrop'),
  ('osint-kirovohradska-pravda','Кіровоградська Правда','telegram','C',false,true,'mtproto_monitor',
   'osint-kirovohradska-pravda',60,300,'https://t.me/k_pravda','k_pravda'),
  ('osint-suspilne-kropyvnytskyi','Суспільне Кропивницький','telegram','C',false,true,'mtproto_monitor',
   'media-suspilne',60,300,'https://t.me/suspilnekropyvnytskyi','suspilnekropyvnytskyi'),
  ('osint-mon1tor-ua','ППО радар | Напрямок ракет','telegram','C',false,true,'mtproto_monitor',
   'osint-mon1tor-ua',60,300,'https://t.me/mon1tor_ua','mon1tor_ua'),
  -- The name reads like a state intelligence service; the channel's own bio says it is not one. Tier
  -- C and `official=false` are what keep the name from becoming an authority claim inside the system.
  ('osint-ukrainian-intelligence','Розвідка України','telegram','C',false,true,'mtproto_monitor',
   'osint-ukrainian-intelligence',60,300,
   'https://t.me/Ukrainian_Intelligence','Ukrainian_Intelligence'),
  ('osint-monitoring-ua1','Моніторинг UA','telegram','C',false,true,'mtproto_monitor',
   'osint-monitoring-ua1',60,300,'https://t.me/monitoring_ua1','monitoring_ua1'),
  ('osint-sirena-dnipro','Сирена. Дніпро','telegram','C',false,true,'mtproto_monitor',
   'osint-sirena-dnipro',60,300,'https://t.me/sirena_dp','sirena_dp'),
  ('osint-radar-war-ua','Радар тривог України (WAR UA)','telegram','C',false,true,'mtproto_monitor',
   'osint-radar-war-ua',60,300,'https://t.me/radar_war_ua','radar_war_ua')
ON CONFLICT (id) DO NOTHING;

-- ## The three self-declared "official" channels: `radar_war_ua`, `warningodesa`, `sirena_dp`
--
-- Registered above as ordinary Tier C rows, enabled, and carrying this standing caveat:
--
--   NEVER PROMOTE ANY OF THESE THREE ABOVE TIER C, AND NEVER SET `official=true` ON THEM.
--
-- All three assert official status in their own title or bio — "ОФІЦІЙНИЙ РАДАР", "…Офіційно❗️",
-- "офіційний канал Дніпра" — and not one of them names the body that owns it or carries any
-- verification. `radar_war_ua` says in its own description that it aggregates other people's
-- "verified sources" rather than observing anything itself.
--
-- The risk is specific and it is not about content quality: a future reviewer skimming this table
-- sees "official" in the name and reads it as a reason to raise the tier. That would hand
-- alert-declaring authority to an anonymous private aggregator, and the resulting alerts would carry
-- `evidence_level='official'` and go straight to `active`. The word in the title is a claim, not a
-- credential, and this comment is here so that nobody has to rediscover that.

-- ## Disabled Tier C rows
--
-- Registered so that the catalogue records the decision and nobody re-adds them from a stale list,
-- but not collected.
--
-- `krymrealii` and `alertOdessa` publish in Russian. `src/domain/classifier.ts` matches Ukrainian
-- patterns and folds case with `uk-UA`, and the location catalogue holds Ukrainian names only, so a
-- Russian-language message yields no threat type and no locations. This is the same reasoning that
-- keeps the already-registered `vanek_nikolaev` disabled, and it will be the same fix: Russian
-- patterns and Russian location aliases, tracked as separate work. Enabling them before that gives
-- two sources that report healthy while contributing nothing — and `krymrealii` additionally quotes
-- occupation-administration statements, which needs its own handling before it is read at all.
--
-- `alarm_kyiv` has seven subscribers, no identified operator and no stated data source. An unknown
-- channel that could be abandoned or repurposed at any moment is not something to subscribe to; the
-- row exists to record that it was looked at and rejected, not to be switched on later without a
-- fresh check.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url,telegram_username)
VALUES
  ('osint-krym-realii','Крым.Реалии','telegram','C',false,false,'mtproto_monitor',
   'osint-krym-realii',60,300,'https://t.me/krymrealii','krymrealii'),
  ('osint-alert-odessa','Одесса и область, воздушная тревога','telegram','C',false,false,
   'mtproto_monitor','osint-alert-odessa',60,300,'https://t.me/alertOdessa','alertOdessa'),
  ('osint-kyiv-alarm','Повітряна тривога Київ','telegram','C',false,false,'mtproto_monitor',
   'osint-kyiv-alarm',60,300,'https://t.me/alarm_kyiv','alarm_kyiv')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------------------------
-- NEGATIVE LIST — handles that must never be registered, and why
-- ------------------------------------------------------------------------------------------------
--
-- This block is the most durable part of the migration. Every handle below still circulates in
-- published channel lists and search snippets, so the next person assembling a source catalogue will
-- meet them again and will have no way of knowing they were already examined and rejected. Absence
-- records nothing; this list does.
--
--   @mykolaivskaODA        HIJACKED. Formerly the Mykolaiv OVA head's channel, the handle now
--                          redirects to unrelated adult content (~160 subscribers). It is still
--                          listed as the official Mykolaiv channel by several aggregators. Adding it
--                          would subscribe the collector to a pornography feed and, worse, would
--                          register it as `official=true` Tier A — a hijacked handle with authority
--                          to declare air-raid alerts for an entire oblast. Mykolaiv oblast is
--                          therefore a known coverage gap, and a gap is the correct state until a
--                          verified replacement exists.
--
--   @pavlokyrylenko_donoda HIJACKED. Formerly attributed to the head of the Donetsk OVA, the handle
--                          now serves gambling/casino content. Same failure mode as above.
--
--   @ComAFUA               "Командування Повітряних Сил". Rejected on the Air Force's own statement
--                          that it operates exactly one Telegram channel, @kpszsu, which is already
--                          registered as `air-force`. The verification found this channel echoing
--                          kpszsu. Registering it as Tier A would build a self-confirmation loop: one
--                          Air Force statement, republished, would satisfy the two-independent-source
--                          rule against itself. If it were ever added despite this, it would have to
--                          carry `independence_group='air-force'`.
--
--   The Centre for Countering Disinformation list — «Легитимный», «Резидент», «Картель»,
--   «Сплетница», «Херсон Live», «Бунтарь», «Скептик», «Криоген», «ЗеРада», «Шептун UA»,
--   «Наблюдатель», «Украинский формат», «Медведь», «ХтоШо» and the rest of that roster — are
--   officially designated disinformation distributors. They are excluded as a class, at any tier,
--   enabled or not. A disabled row would still put them in the source list as if they were a
--   capability being held back rather than a category that is out of bounds.
--
-- Also examined and not registered, for the record: @vgorunews (post-hoc media, not alerts),
-- @dsns_poltava_syrena and @khmlv (dead), @suspilne_uzhhorod, @chernivtsigram, @xchernivtsi (zero
-- alert posts — Zakarpattia and Chernivtsi have no candidate at all), and @starukhofficial
-- (plausible but never verified; not registered without direct verification).
--
-- Known coverage gaps after this migration, so that they are not mistaken for oversights: Luhansk
-- oblast (no candidate found at all), Zakarpattia and Chernivtsi (verified empty), Mykolaiv (handle
-- hijacked, only a relay available), and the city of Kyiv as distinct from Kyiv oblast.
