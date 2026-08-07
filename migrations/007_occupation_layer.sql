-- Temporarily occupied territories layer.
-- One row per upstream revision, kept forever: the history feeds a future time slider, while the
-- UI renders only the newest row. Geometry stays in jsonb; clipping to the state border of Ukraine
-- happens in Node, so the stack does not need PostGIS.
CREATE TABLE IF NOT EXISTS occupation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'deepstate',
  -- Upstream monotonic revision identifier, used for deduplication. Stored as text: it is an
  -- opaque foreign key, not an integer we do arithmetic on.
  source_revision_id text NOT NULL,
  -- Upstream "05.08 o 14:47": no year, no timezone, not ISO-8601. Kept verbatim, never parsed.
  captured_label text NOT NULL DEFAULT '',
  -- When we first observed this revision.
  fetched_at timestamptz NOT NULL DEFAULT now(),
  -- When we last confirmed this revision is still the newest one upstream. Drives the stale flag,
  -- so a source that simply has not published in a day is not reported as stale.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  geojson jsonb NOT NULL,
  occupied_count integer NOT NULL DEFAULT 0,
  contested_count integer NOT NULL DEFAULT 0,
  liberated_count integer NOT NULL DEFAULT 0,
  -- Polygon features refused by the allowlist or by border clipping.
  rejected_count integer NOT NULL DEFAULT 0,
  -- Point/line features (upstream labels and icons) that never represent territory.
  dropped_geometry_count integer NOT NULL DEFAULT 0,
  rejection_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Status keys this build did not recognise. Never rendered; kept so they can be reviewed.
  unknown_status_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS occupation_snapshots_revision_uidx
  ON occupation_snapshots (source, source_revision_id);
CREATE INDEX IF NOT EXISTS occupation_snapshots_latest_idx
  ON occupation_snapshots (source, fetched_at DESC);
