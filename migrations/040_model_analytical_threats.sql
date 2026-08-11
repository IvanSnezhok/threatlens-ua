-- A model may publish only a separately labelled, unverified analytical threat. This switch is
-- deliberately independent from shadow corpus collection: operators can collect comparisons
-- without granting publication authority, or disable both in one form during an incident.
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS analytical_threats_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.analytical_threats_enabled IS
  'Allow high-confidence shadow verdicts rejected by deterministic rules to create unverified analytical threat events';

-- The shadow row remains the audit root for the model decision. A nullable FK answers the important
-- question in both directions: which verdict created this public event, and whether a recorded
-- verdict was actually promoted.
ALTER TABLE shadow_classifications
  ADD COLUMN IF NOT EXISTS analytical_event_id uuid REFERENCES threat_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shadow_classifications_analytical_event
  ON shadow_classifications(analytical_event_id)
  WHERE analytical_event_id IS NOT NULL;

COMMENT ON COLUMN shadow_classifications.analytical_event_id IS
  'Unverified public threat event created from this model verdict, if strict promotion guards passed';

COMMENT ON TABLE shadow_classifications IS
  'Model comparisons with optional audited linkage to a strictly bounded unverified analytical event';
