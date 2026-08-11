-- Every source switch is an operational safety decision, especially for a row allowed to carry
-- official alert state. Keep the decision beside the catalogue rather than only in transient logs.
CREATE TABLE IF NOT EXISTS source_enabled_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  previous_enabled boolean NOT NULL,
  enabled boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  changed_by text NOT NULL,
  official_authority_acknowledged boolean NOT NULL DEFAULT false,
  held_alerts_acknowledged boolean NOT NULL DEFAULT false,
  held_alerts_at_change integer NOT NULL DEFAULT 0 CHECK (held_alerts_at_change >= 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_enabled_audit_source_time_idx
  ON source_enabled_audit(source_id, changed_at DESC);

COMMENT ON TABLE source_enabled_audit IS
  'Append-only audit of Ops source enable/disable decisions. A switch never mutates alert_source_states; disabling a holder therefore preserves the over-warning safety direction.';

-- `alerts-in-ua` pre-dates `enabled` as a runtime gate. Its adapter used to set this bit to true on
-- every token-backed poll, so the migration must preserve the effective state before the adapter
-- starts obeying the bit. A deployment without a token will correctly show enabled/unconfigured;
-- a later Ops disable is audited and stays disabled because no adapter writes this column anymore.
UPDATE sources SET enabled=true WHERE id='alerts-in-ua';
