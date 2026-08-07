-- Debounced end of an official alert.
--
-- The scheduler polls every official provider every 15 seconds and the reconciler used to end a
-- global alert as soon as the per-source aggregate reported nothing active. One incomplete response
-- or one transient provider failure was therefore enough to emit `alert.ended` and push an
-- "Офіційний відбій" message to every subscriber. For an air-raid product a false all-clear is the
-- most dangerous failure mode there is.
--
-- `missing_since` records the first poll in which a source that *was* holding an alert stopped
-- reporting it. NULL means "not currently missing": either the source still reports the alert, or it
-- never held this alert in the first place. The reconciler treats a source as still holding the
-- alert while `active=true` OR `missing_since` is younger than ALERT_END_DEBOUNCE_SECONDS, so an
-- alert only ends after a source has been silent about it for the whole window.
--
-- The column is deliberately left NULL for existing rows. Backfilling it with now() would make every
-- inactive row look freshly missing on the first poll after deployment, which would resurrect
-- already-ended alerts; NULL means "was not holding anything", which is the correct reading of a row
-- that is inactive at migration time.
ALTER TABLE alert_source_states ADD COLUMN IF NOT EXISTS missing_since timestamptz;

-- Serves the operator query for "alerts currently kept alive only by the debounce window"
-- (docs/OPERATIONS.md), which is how a dead provider holding an alert open is diagnosed.
CREATE INDEX IF NOT EXISTS alert_source_states_missing_idx
  ON alert_source_states(location_id, alert_type) WHERE missing_since IS NOT NULL;
