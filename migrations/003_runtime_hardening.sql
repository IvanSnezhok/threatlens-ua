UPDATE sources SET stale_after_seconds=86400 WHERE id='demo';

CREATE INDEX IF NOT EXISTS event_evidence_event_idx ON event_evidence(event_id,attached_at);
CREATE INDEX IF NOT EXISTS risk_signals_live_group_idx ON risk_signals(location_id,threat_type,expires_at DESC);
CREATE INDEX IF NOT EXISTS system_event_log_created_idx ON system_event_log(created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_chat_enabled_idx ON subscriptions(chat_id,enabled);
