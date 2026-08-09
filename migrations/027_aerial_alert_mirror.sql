-- The community aerial-alert mirror: one tokenless snapshot source, and the designation argument
-- behind it.
--
-- ## Why this row exists
--
-- Both official alert APIs need a token issued on written application, and neither application has
-- been granted. Until they are, the only alert state this deployment can read over HTTPS is a
-- third-party republication. https://ubilling.net.ua/aerialalerts/ is that republication: free, no
-- key, no registration, twenty-five rows covering the twenty-four oblasts and Kyiv city, each with
-- `alertnow` and the timestamp it last changed, plus a `cachedat` stamp for the response itself.
-- Measured over thirteen consecutive fifteen-second polls during research: HTTP 200 every time, and
-- `cachedat` never more than two seconds behind the request. The operator publishes a limit of two
-- requests per second per host (wiki.ubilling.net.ua/doku.php?id=aerialalertsapi); the collector
-- polls every fifteen seconds.
--
-- ## What tier and `official` mean on THIS row, and why
--
-- docs/ARCHITECTURE.md states the rule as **designation, not transport**: a source designated to
-- publish alerts starts and ends official alerts whether its bytes arrive over HTTPS or MTProto.
-- This row is the first case where the awkward part of that rule is load-bearing, because the
-- designation and the publisher come apart:
--
--   * The STATE it carries is the executive authorities' own air-raid declaration — the identical
--     fact the two APIs and the twenty-one administration channels carry. Nothing about it is
--     softer, and it is not OSINT: no one is observing anything, they are relaying a declaration.
--   * The PUBLISHER has no mandate whatsoever. It is a software vendor's convenience endpoint.
--
-- `tier='A'` and `official=true` follow the state, not the publisher, and the reason is that this
-- row's only function is to move official alert periods. A row wired into
-- `persistOfficialAlertSnapshot` — able to raise and clear the red polygons on the public map — but
-- labelled tier B would misdescribe what the system actually does with it, and `tier`/`official` are
-- read as the answer to "how much authority does this carry", which for the declaration itself is
-- the full amount.
--
-- The contrary reading is real and is recorded here rather than argued away: `official=true` has
-- meant "carries a state mandate" everywhere else in this catalogue, and ubilling carries none. An
-- operator who decides the label should describe the publisher rather than the payload should flip
-- this row to `tier='B', official=false`; the alert path does not read either column — it is keyed on
-- `source_id` — so the flip changes what the ops page claims and nothing about behaviour. **The
-- catalogue decision is the product owner's**, who asked for this source; what is written above is
-- the reasoning offered with it, not a fact discovered.
--
-- Untrustworthiness is handled where it belongs instead: in the independence group below, in the
-- staleness rule in `src/sources/aerial-mirror.ts`, and in the measured `source_trust` score, none
-- of which require lying about what the payload is.
--
-- ## Its own independence group, and why corroboration with it is worth almost nothing
--
-- `?source=default` is not one feed. The operator documents it as an aggregator over five upstreams
-- — `skog`, `klimenko`, `jaam`, `aiu`, `ual` — serving "whichever is most current", and the last two
-- ARE Alerts.in.ua and Ukraine Alarm. On any given poll this row may literally be one of the other
-- two API rows wearing a different hat.
--
-- So it gets `independence_group='community-alert-mirror'`, shared with nothing. That group is not a
-- claim of independence; it is the refusal to pool it with `official-civil-alerts`, which would let
-- one upstream corroborate itself. The caveat is the national channel's, only stronger: agreement
-- between this row and the civil alert APIs is close to no evidence at all, because it may be the
-- same bytes counted twice. Agreement between it and an OSINT group still means something.
--
-- The operator's own disclaimer is worth recording verbatim, because it is the most honest thing
-- anyone has said about this feed: "do not perceive this API as absolutely reliable ... use official
-- sources of information" for decisions that matter.
--
-- ## `enabled=true`, and the switch above it
--
-- Registered switched ON. That is a deliberate change to production behaviour at deploy — a new
-- source that immediately starts raising and clearing alert periods — and it is exactly what was
-- asked for: the deployment has no other live alert source it can read without credentials.
--
-- `AERIAL_MIRROR_ENABLED` (default true) is the deployment-level kill switch above this row, the
-- same shape as `ALERT_CHANNEL_ENABLED` and `OSINT_MONITOR_ENABLED`. It is an environment variable
-- and not a `sources.enabled` flip because it has to work when the database is the thing that is
-- wrong. Note what switching it off does NOT do: the mirror's rows in `alert_source_states` keep
-- whatever they were holding, because `expireStuckAlertChannelAlerts` sweeps `mtproto_alert_channel`
-- rows only. docs/OPERATIONS.md carries the release procedure.
--
-- `stale_after_seconds` is 300 to match `AERIAL_MIRROR_STALE_SECONDS`: the health card and the
-- adapter should call this source dead at the same moment, not five minutes apart.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url)
VALUES
  ('aerial-alerts-mirror','Повітряна тривога — спільнотне дзеркало (ubilling)','api','A',true,true,
   'aerial_alerts_mirror','community-alert-mirror',15,300,'https://ubilling.net.ua/aerialalerts/')
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,tier=EXCLUDED.tier,official=EXCLUDED.official,
  adapter_type=EXCLUDED.adapter_type,independence_group=EXCLUDED.independence_group,
  expected_update_interval_seconds=EXCLUDED.expected_update_interval_seconds,
  stale_after_seconds=EXCLUDED.stale_after_seconds,public_url=EXCLUDED.public_url;
