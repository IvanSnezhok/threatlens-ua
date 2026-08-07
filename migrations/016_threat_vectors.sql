-- Threat vectors: the chain of reported observations, and the operator-only extrapolation of it.
--
-- ================================================================================================
-- Two levels, separated by the schema rather than by discipline
-- ================================================================================================
--
-- The product commitment, stated in README.md, docs/ARCHITECTURE.md and on the map itself, is that
-- the system shows only an explicitly reported region, point or direction and never a predicted
-- target, impact or trajectory. Threat vectors do not weaken it, because they are two different
-- things wearing one name:
--
--   * **Public** — a chain of *reported observations*. "Three sources led this target from A through
--     B to C over eight minutes." Every node is a place a message named, every segment carries the
--     source that produced it, the time it was published and how strongly the movement itself is
--     attested. Nothing is interpolated, nothing is continued past the last message.
--   * **Operator only** — the extrapolation: continue the last leg, name the locations that fall
--     inside the resulting cone, and state the uncertainty. This is a calculation about the future
--     and has no place in a public payload.
--
-- ## Why the extrapolation gets its own table and not a column
--
-- A nullable column on `threat_events` — or a jsonb blob beside the reported geometry — would put the
-- calculated future one `SELECT e.*` away from every public endpoint. `liveThreats()`,
-- `threatDetails()` and the history query in `src/api/server.ts` all select the whole event row, so a
-- projection column would have leaked into the public snapshot, the SSE payload and the Telegram bot
-- on the day it was added, and a refactor six months from now would re-add the leak silently. The
-- rule this file enforces instead is positional: **the calculated future lives in tables no public
-- query names**, so leaking it requires typing `ops_threat_vector_` into a public module, which is a
-- reviewable, greppable, testable act rather than an oversight.
--
-- The `ops_` prefix is load-bearing for exactly that reason. `src/api/vector-isolation.test.ts`
-- fails the build if the token appears in any module reachable from a public entry point.
--
-- ## Why the public chain has no table at all
--
-- It needs none. Every fact it is made of is already recorded: `message_classifications` holds one
-- row per classifier decision with its event, `message_classification_locations` holds the places
-- that decision named and the role each played (`asserted` / `retracted`) and, for the asserted
-- ones, the relation (`reported_direction`, `explicit_threat`, `mentioned`, `aftermath`). A
-- `redirect` — "Балістика повз Бровари на Бориспіль" — is already stored as one message retracting
-- one place and asserting another, which is the most precise movement signal this system has.
-- Deriving the chain from that archive rather than materialising a second copy means the chain can
-- never disagree with the messages it claims to summarise, and that a classifier fix retroactively
-- corrects every chain it touched.
--
-- The only public thing this migration adds is the index that walk needs.

-- `message_classifications_event_idx` already serves "rows for this event", but the chain reads them
-- in publication order, and during a mass attack one event can accumulate dozens of decisions.
CREATE INDEX IF NOT EXISTS message_classifications_event_time_idx
  ON message_classifications (event_id, published_at) WHERE event_id IS NOT NULL;

-- ================================================================================================
-- Operator-only extrapolation
-- ================================================================================================
--
-- Nothing under `src/` that produces a public response may reference these two tables. They are read
-- by `src/services/vector-projection.ts` and served by `src/api/ops-vector-routes.ts` behind Basic
-- auth, and by nothing else.
CREATE TABLE IF NOT EXISTS ops_threat_vector_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  -- The "this is arithmetic, not an observation" marker, in the data rather than in a caption.
  --
  -- A caption is a property of one rendering; this is a property of the row. The CHECK makes the
  -- column unable to hold anything else, so no future writer — and no future import — can file a
  -- calculated future here as though somebody had reported it. Any consumer that reads a row from
  -- this table and drops the column has still read a row from a table whose every record is, by
  -- constraint, a calculation.
  data_nature text NOT NULL DEFAULT 'calculated' CHECK (data_nature = 'calculated'),
  computed_at timestamptz NOT NULL DEFAULT now(),

  -- ---- what was extrapolated FROM, so a projection can always be traced back to real messages ---
  -- The last drawable leg of the public chain. Recorded by location and by time rather than by
  -- segment index alone, so the basis survives a later reclassification that renumbers the chain.
  basis_from_location_id text REFERENCES locations(id),
  basis_to_location_id text REFERENCES locations(id),
  basis_observed_from timestamptz NOT NULL,
  basis_observed_to timestamptz NOT NULL,
  basis_segment_basis text NOT NULL CHECK (basis_segment_basis IN (
    'reported_transit','reported_direction','observation_sequence'
  )),
  basis_segment_count integer NOT NULL,
  basis_independence_groups integer NOT NULL,
  -- True when either endpoint came from a raion polygon centroid instead of a catalogue coordinate.
  -- KATOTTG gives raions no geometry, so the chain falls back to the centroid of the ADM2 polygon;
  -- that is an approximation of a place, and extrapolating from it is an approximation of an
  -- approximation. It is recorded because it is the single largest driver of the cone below.
  basis_uses_approximate_coordinates boolean NOT NULL DEFAULT false,

  -- ---- the extrapolation itself, computed deterministically ------------------------------------
  method text NOT NULL CHECK (method IN ('last_leg_linear')),
  bearing_degrees numeric(6,2) NOT NULL,
  ground_speed_kmh numeric(8,2) NOT NULL,
  horizon_minutes integer NOT NULL CHECK (horizon_minutes > 0 AND horizon_minutes <= 60),
  -- `{ "centerline": <LineString>, "cone": <Polygon> }`. Calculated geometry: it is not a
  -- `threat_events.geometry` and must never be copied into one.
  projection_geometry jsonb NOT NULL,

  -- ---- uncertainty, mandatory ------------------------------------------------------------------
  -- NOT NULL on every column here is the point. A projection that cannot state how wrong it might be
  -- cannot be stored, so no consumer ever has to decide what a missing uncertainty means.
  lateral_half_angle_degrees numeric(5,2) NOT NULL CHECK (lateral_half_angle_degrees > 0),
  radius_km_at_horizon numeric(8,2) NOT NULL CHECK (radius_km_at_horizon > 0),
  -- Deliberately two values, not three. `high` is unreachable by construction: an extrapolation of
  -- two reported points is never high-confidence, and leaving the word available in the schema would
  -- eventually put it on a screen.
  confidence text NOT NULL CHECK (confidence IN ('low','medium')),
  uncertainty_reasons text[] NOT NULL DEFAULT '{}',

  -- ---- wording ---------------------------------------------------------------------------------
  -- A model may rewrite the sentence an operator reads; it may never produce the numbers above.
  -- `narrative_origin` records which happened, so a run where the model was rejected is visible
  -- rather than indistinguishable from a run where it was never configured.
  narrative text NOT NULL,
  narrative_origin text NOT NULL CHECK (narrative_origin IN ('deterministic','model')),
  model_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_threat_vector_projections_event_idx
  ON ops_threat_vector_projections (event_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS ops_threat_vector_projections_time_idx
  ON ops_threat_vector_projections (computed_at DESC);

-- Candidate next locations. A child table rather than jsonb so the foreign key keeps the ids honest
-- against the catalogue, and so "which places have we ever projected onto, how often" is a query
-- rather than a scan of blobs.
CREATE TABLE IF NOT EXISTS ops_threat_vector_projection_candidates (
  projection_id uuid NOT NULL REFERENCES ops_threat_vector_projections(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id),
  -- Repeated from the parent on purpose: a candidate row read on its own is still, by constraint,
  -- a calculation about a place — never a report that anything is heading there.
  data_nature text NOT NULL DEFAULT 'calculated' CHECK (data_nature = 'calculated'),
  rank integer NOT NULL CHECK (rank > 0),
  angular_deviation_degrees numeric(5,2) NOT NULL,
  distance_km numeric(8,2) NOT NULL,
  minutes_to_reach numeric(8,2),
  -- Whether the location falls inside the stated cone, or only near it. Both are kept: "just outside
  -- the cone" is operationally interesting and silently dropping it would make the cone look tighter
  -- than the calculation supports.
  within_uncertainty boolean NOT NULL,
  coordinate_precision text NOT NULL CHECK (coordinate_precision IN ('point','approximate')),
  PRIMARY KEY (projection_id, location_id)
);

CREATE INDEX IF NOT EXISTS ops_threat_vector_projection_candidates_location_idx
  ON ops_threat_vector_projection_candidates (location_id);
