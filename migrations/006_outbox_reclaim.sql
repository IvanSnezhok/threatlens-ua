ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS outbox_sending_stale_idx ON notification_outbox (updated_at) WHERE status='sending';
