-- What changed in how the enemy is flying, stored one row per change rather than one row per pass.
--
-- ================================================================================================
-- What these two tables hold, and why they may be published
-- ================================================================================================
--
-- `src/services/attack-tactics.ts` compares two windows of `message_classifications` — the last 24
-- hours against the fifteen days before them — and emits a small set of typed observations: the
-- share of a weapon class moved, a class that was absent appeared, the hours shifted, an oblast that
-- was never named is named now, the waves got longer. Every one of them is arithmetic over messages
-- that were already ingested, already classified and already counted on the public attacks page.
--
-- That is what `data_nature = 'derived'` means here, and the CHECK on both tables is what keeps the
-- meaning from drifting. The vocabulary this project uses has three words and only two of them may
-- ever reach a reader:
--
--   * `observed` — a source said it. The threat feed.
--   * `derived`  — we counted what already happened. These two tables, and the attacks page.
--   * the third word — an extrapolation forward, which is operator-only by construction and lives
--     behind its own prefix, its own migration and its own isolation test. It does not appear in
--     this migration at all, and a reader checking that claim is checking it correctly: nothing
--     stored here reasons about anything that has not happened yet.
--
-- A detection is a statement in the past tense with a number attached. It is not a forecast, it does
-- not name a next target, and the prose written beneath it — deterministic by default, a model's
-- rewording only when an operator switches `codex_settings.tactics_enabled` on — is rejected
-- wholesale if it invents a digit, a weapon class, an oblast or a future tense.
--
-- ================================================================================================
-- One row per CHANGE, not one row per pass
-- ================================================================================================
--
-- The pass runs inside the analytics recompute, at most once every five minutes, and for most of
-- those passes the answer is identical to the previous one: the same four detections, the same
-- numbers, the same sentences. Writing a row each time would turn "what changed in the last day"
-- into a table that grows by 288 rows a day and whose newest row says nothing the one before it did
-- not.
--
-- So the pass computes a `digest` — an order-independent, value-sensitive fingerprint of the
-- detection set — and:
--
--   * digest differs from the newest stored pass → INSERT a new row, with its detections;
--   * digest is identical                        → UPDATE `last_confirmed_at` and nothing else.
--
-- The page therefore shows two timestamps that mean different things and are both worth showing:
-- `computed_at` is when this picture first appeared, `last_confirmed_at` is when it was last
-- re-derived and found unchanged. "Since 03:40, still true at 11:15" is a sentence about stability
-- that a table of identical rows could only express by counting them.
--
-- ================================================================================================
-- The hold, and why it is a read predicate rather than a column
-- ================================================================================================
--
-- `runtime_settings.publication_mode` can put a delay between the moment this project learns
-- something and the moment the public may see it. Every other public surface applies it by bounding
-- a receipt column, and this one does the same with the whole pass: the pass itself always computes
-- over unheld data, and the public read is
--
--     WHERE computed_at <= $cutoff ORDER BY computed_at DESC LIMIT 1
--
-- which is the entire implementation of the hold on this surface. There is no held/unheld flag and
-- no second copy of the pass. `attack_tactic_passes_computed_idx` is what makes that predicate an
-- index scan of one row rather than a walk of ninety days of history.
--
-- Retention is ninety days, pruned by the same leg that writes. The baseline window is fifteen days,
-- so ninety is six baselines of history — enough to answer "was this the first time" without turning
-- an append-only audit trail into an unbounded one.

CREATE TABLE IF NOT EXISTS attack_tactic_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The fingerprint insert-on-change is decided by. Text rather than bytea because it is read by
  -- humans in `psql` at least as often as it is compared by the writer.
  digest text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  -- Moved by every later pass that re-derives the same digest. Never earlier than `computed_at`.
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  -- Which edition of the detection rules produced this. A threshold change is a new version, and a
  -- reader comparing two passes across one is comparing two different questions.
  methodology_version text NOT NULL,
  current_from timestamptz NOT NULL,
  current_to timestamptz NOT NULL,
  baseline_from timestamptz NOT NULL,
  baseline_to timestamptz NOT NULL,
  -- Asserting messages in each window. Both are on the row because every detection's numbers are
  -- shares of them, and a reader who cannot see the denominators cannot check a single one.
  current_messages integer NOT NULL,
  baseline_messages integer NOT NULL,
  -- Every classifier version that judged a message in either window. More than one weakens every
  -- comparison below, and the page says so in as many words.
  classifier_versions text[] NOT NULL DEFAULT '{}',
  -- What started the pass. The same three words `RecomputeTrigger` uses, so a row here can be lined
  -- up against `system_event_log`'s `analytics.updated` payload without a translation table.
  trigger text NOT NULL CHECK (trigger IN ('event','manual','schedule')),
  data_nature text NOT NULL DEFAULT 'derived' CHECK (data_nature = 'derived'),
  -- {headline, findings[], caveats[]}. Never null: a pass is inserted with its deterministic text
  -- already written, and the model — when it is switched on and its answer survives verification —
  -- replaces this column afterwards. A row can therefore never exist without prose, which is what
  -- makes the model optional in the strong sense rather than in the hopeful one.
  commentary jsonb NOT NULL,
  commentary_origin text NOT NULL DEFAULT 'deterministic'
    CHECK (commentary_origin IN ('deterministic','model')),
  commentary_model text,
  -- Why the model's text was not used: a grounding failure, a forecast lexeme, a class or an oblast
  -- it was not given, a cooldown, a transport failure. Null when the model wrote the row or when it
  -- was never asked.
  commentary_rejection_reason text,
  -- The transport row for the call that produced `commentary`, when a model was involved.
  -- ON DELETE SET NULL: `ai_runs` is prunable telemetry and losing it must not lose the commentary
  -- an operator is reading.
  ai_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  CONSTRAINT attack_tactic_passes_window_order CHECK (current_from < current_to
    AND baseline_from < baseline_to AND baseline_to <= current_from),
  CONSTRAINT attack_tactic_passes_confirmed_order CHECK (last_confirmed_at >= computed_at)
);

-- The public read: newest pass not later than the cutoff. One index, one row, one scan.
CREATE INDEX IF NOT EXISTS attack_tactic_passes_computed_idx
  ON attack_tactic_passes (computed_at DESC);
-- The writer's read: "is this the same picture as last time". Kept separate from the index above
-- because the writer looks the digest up on the newest row only and the reader never filters by it.
CREATE INDEX IF NOT EXISTS attack_tactic_passes_digest_idx
  ON attack_tactic_passes (digest);

-- ================================================================================================
-- The detections
-- ================================================================================================
--
-- One row per (pass, detection type, subject). The subject is what the detection is about — a
-- weapon class id, an oblast id, `night` for the hour shift, an ordered oblast pair for a redirect
-- corridor — and it is part of the primary key because two detections of the same type in one pass
-- are the normal case: two classes can both move, two oblasts can both be new.
--
-- Every row carries the arithmetic, not only its conclusion. `current_value` and `baseline_value`
-- are the two sides of the comparison in the unit named by `unit`; `current_support` and
-- `baseline_support` are the message counts underneath them, which is what separates "the share
-- doubled" over 200 messages from the same sentence over 3. `evidence` holds whatever else the
-- sentence quotes — the verbatim direction phrasings of a corridor, the hour bands of a shift — and
-- is the only place free-form text from a source message is stored here, always as an exact
-- quotation and never as a paraphrase.
--
-- `sentence` is the finished Ukrainian statement, composed deterministically from the columns beside
-- it. It exists in the table rather than only in the renderer because it is what the model is shown
-- and what the model's rewording is checked against: every number in the model's prose must already
-- appear in these rows, and a sentence assembled at render time could not be the reference.

CREATE TABLE IF NOT EXISTS attack_tactic_detections (
  pass_id uuid NOT NULL REFERENCES attack_tactic_passes(id) ON DELETE CASCADE,
  detection_type text NOT NULL,
  subject_key text NOT NULL,
  subject_label text NOT NULL,
  -- What `current_value`/`baseline_value` are measured in. Three units and no more: a fraction of a
  -- window, a count of messages, a duration. Anything that does not fit one of them is a detection
  -- that has not been thought through.
  unit text NOT NULL CHECK (unit IN ('share','count','minutes')),
  current_value numeric NOT NULL,
  -- Null where there is nothing to compare against: a class or an oblast that is new by definition
  -- has no baseline value, and storing 0 there would say "we measured zero" instead of "there was
  -- nothing to measure".
  baseline_value numeric,
  current_support integer NOT NULL,
  baseline_support integer NOT NULL,
  -- The signed movement the threshold was applied to, in the same unit. Stored rather than derived
  -- so a reader can sort by it without re-deriving which of the two values is the reference.
  effect numeric NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  sentence text NOT NULL,
  -- Display order inside the pass, strongest effect first. Assigned by the writer so the page, the
  -- payload and the model all read the detections in the same order.
  rank integer NOT NULL,
  data_nature text NOT NULL DEFAULT 'derived' CHECK (data_nature = 'derived'),
  PRIMARY KEY (pass_id, detection_type, subject_key)
);

COMMENT ON TABLE attack_tactic_passes IS
  'One row per CHANGE in the 24h-against-15d tactical comparison; an unchanged pass only moves last_confirmed_at. Published, derived, never a forecast.';
COMMENT ON TABLE attack_tactic_detections IS
  'The typed observations of one pass, each with the counts it was derived from and the deterministic sentence built out of them.';
COMMENT ON COLUMN attack_tactic_passes.commentary IS
  'Deterministic prose on insert; replaced by a model rewording only after it passes number grounding, the forecast lexicon and the class/oblast check.';
COMMENT ON COLUMN attack_tactic_detections.evidence IS
  'Exact quotations and secondary numbers the sentence uses. Quotations are verbatim from source messages; nothing here is paraphrased or inferred.';
