-- What every subscriber was actually told, per (entity, chat).
--
-- The outbox already has an idempotency key, but it only protects a single *version* of a system
-- event: `entityId:chatId:type:eventVersion`. A live threat collects a new version from every
-- channel message that lands on it, so a raid that is merely re-confirmed ten times produced ten
-- outbox rows with ten different keys and ten identical Telegram messages. The key cannot be
-- widened to fix that — it is what makes the outbox at-least-once, and collapsing distinct versions
-- into one key would silently drop genuine escalations too.
--
-- This table sits one layer above the key: it remembers the state that was last *published to a
-- given chat*, so the fanout can compare "what this chat knows" against "what is true now" and stay
-- quiet when the answer is the same. Comparing against the last computed state instead would keep
-- re-sending, because the computation runs far more often than the state changes.
--
-- Rows are written when a notification is queued (not when it is delivered): the fanout can run
-- again within the same second, and a marker that only appears after delivery would let the second
-- pass re-decide against an empty history and queue the same message twice. The delivery worker
-- then fills in `telegram_message_id`, which is what lets a soft update edit the message the chat
-- is already looking at instead of pushing a new one.
CREATE TABLE IF NOT EXISTS notification_state (
  -- 'threat'     — entity_key is the threat_events id.
  -- 'assessment' — entity_key is 'locationId:threatType'. Every analytics run inserts a *new*
  --                risk_assessments row, so the assessment id is useless as an identity here; the
  --                thing a subscriber experiences as "the same estimate" is the location and type.
  entity_kind text NOT NULL CHECK (entity_kind IN ('threat', 'assessment')),
  entity_key text NOT NULL,
  chat_id bigint NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
  location_id text REFERENCES locations(id),

  last_threat_type text,
  last_evidence_level text,
  -- Sorted, comma-joined location ids of the last published version of the threat. Kept as one
  -- text column rather than an array so the whole comparison the fanout performs is a scalar one.
  last_geography_key text,
  last_risk_level text,
  last_score numeric(5,2),
  last_valid_until timestamptz,
  -- Fingerprint of the structural fields above, as produced by `threatContentHash`. It is the cheap
  -- short-circuit for "nothing that a message would mention has moved", and it makes the last
  -- published state legible in ops queries without joining the outbox payloads back together.
  content_hash text,

  telegram_message_id bigint,
  last_notified_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  -- Threats live for hours and assessments for a six-hour horizon, so this table is short-lived by
  -- nature. The operations worker deletes expired rows on its regular pass; without that the table
  -- would grow by one row per subscriber per threat, forever.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, entity_key, chat_id)
);

CREATE INDEX IF NOT EXISTS notification_state_expiry_idx ON notification_state (expires_at);
