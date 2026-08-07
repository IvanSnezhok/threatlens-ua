-- Official air-raid alert channel https://t.me/air_alert_ua as a Tier A alert source.
--
-- Both existing official adapters need an API token issued on written application, which the
-- project does not have. This channel is fed directly by the executive authorities and the State
-- Emergency Service and is readable without any credential, so it is what actually makes official
-- alerts available. What makes a source official is its tier and its mandate, not its transport:
-- the same authority publishing over MTProto instead of HTTPS is still the same authority.
--
-- `independence_group` is its own. It is deliberately NOT 'air-force': that group is the Air Force
-- Telegram channel, a different publisher with a different mandate. It is also not
-- 'official-civil-alerts' — see docs/ARCHITECTURE.md for why corroboration between this channel and
-- the civil alert APIs should still be read with care, since they share upstream authorities.
--
-- `enabled=false` on insert: the row describes a configured capability, and the MTProto collector
-- flips it to true once it is actually connected, exactly as the Alerts.in.ua adapter does. Without
-- that, an unconfigured deployment would report a permanently healthy source that never runs.
INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,
                     expected_update_interval_seconds,stale_after_seconds,public_url)
VALUES ('air-alert-ua','Повітряна тривога (офіційний канал)','telegram','A',true,false,
        'mtproto_alert_channel','official-air-alert-channel',60,300,'https://t.me/air_alert_ua')
ON CONFLICT (id) DO NOTHING;

-- Ordering guard for the event-driven path.
--
-- The snapshot adapters are polled, so every response is by definition the newest state. Channel
-- messages are not: after a reconnect, or during a backfill, an older message can be processed
-- after a newer one. `last_event_at` holds the Telegram publication time of the newest message that
-- has been applied to this row, and the reconciler refuses to apply anything older — an all-clear
-- from an hour ago can no longer overwrite an alert declared five minutes ago.
--
-- Left NULL for existing rows on purpose: NULL means "no channel event has ever touched this row",
-- which is the truth for every row the polled adapters own, and it makes the first channel event
-- apply unconditionally.
ALTER TABLE alert_source_states ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

-- Serves the maximum-alert-duration backstop, which scans only this source's still-active rows.
CREATE INDEX IF NOT EXISTS alert_source_states_active_started_idx
  ON alert_source_states(source_id, provider_started_at) WHERE active = true;

-- The channel is worth recommending to users in its own right; it is the fastest official
-- notification available without a bot.
INSERT INTO recommended_telegram_channels
  (title,username,description,category,verified,sort_order,created_by)
VALUES
  ('Повітряна тривога','air_alert_ua',
   'Офіційний канал оповіщення про повітряні тривоги та відбої. Дані надходять від органів '
   || 'виконавчої влади та ДСНС.','official',true,5,'migration')
ON CONFLICT (lower(username)) DO NOTHING;
