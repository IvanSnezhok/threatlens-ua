CREATE UNIQUE INDEX IF NOT EXISTS locations_official_code_uidx
  ON locations(official_code) WHERE official_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS reference_dataset_syncs (
  dataset_id text PRIMARY KEY,
  source_url text NOT NULL,
  source_version text,
  source_sha256 text NOT NULL,
  imported_rows integer NOT NULL,
  status text NOT NULL,
  error text,
  synced_at timestamptz NOT NULL DEFAULT now()
);
