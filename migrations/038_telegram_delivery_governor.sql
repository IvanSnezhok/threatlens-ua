-- One aggregate Telegram Bot API budget shared by every app process.
--
-- The bucket is persisted so a restart cannot erase a provider retry_after or restore a full burst.
-- `notification_outbox` remains the source of truth for work; the decision journal is intentionally
-- small and operational, and is pruned by the worker after each write.
CREATE TABLE IF NOT EXISTS telegram_delivery_governor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tokens double precision NOT NULL DEFAULT 25 CHECK (tokens >= 0),
  last_refill_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO telegram_delivery_governor(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS coalesced_into uuid REFERENCES notification_outbox(id);

CREATE TABLE IF NOT EXISTS telegram_delivery_decisions (
  id bigserial PRIMARY KEY,
  outbox_id uuid REFERENCES notification_outbox(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN
    ('deferred','coalesced','provider_backoff','recovered')),
  notification_class text NOT NULL CHECK (notification_class IN
    ('protected','standard','soft','analytics')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_delivery_decisions_recent_idx
  ON telegram_delivery_decisions(created_at DESC);

CREATE INDEX IF NOT EXISTS outbox_governor_pending_idx
  ON notification_outbox(status, next_attempt_at, priority, created_at)
  WHERE status IN ('pending','retry');
