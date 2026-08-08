-- Shadow classification: what a model would have said, recorded beside what the rules did say.
--
-- ================================================================================================
-- Why a second opinion is written down and never acted on
-- ================================================================================================
--
-- `src/domain/classifier.ts` is deterministic, auditable and the only thing allowed to raise a
-- threat event. That property is not negotiable: an operator can read the regex that produced a
-- warning, and a replay over `message_classifications` proves what the same rules do to the same
-- corpus today. A model has neither property — it is not reproducible, it cannot be reviewed line
-- by line, and it fails in ways that look like success.
--
-- What a model *is* good for here is finding the messages the rules got wrong, which is exactly the
-- work nobody has time to do by hand. So it runs beside the pipeline, after the decision has already
-- been made and outside its transaction, and its only product is a row in this table. Nothing reads
-- this table except `/ops`. If every model call fails for a month, the only thing lost is a month of
-- labelling material.
--
-- `agrees` is computed at write time rather than derived on read because it is the number the whole
-- feature exists to produce, and because the comparison rule lives in TypeScript
-- (`src/services/shadow-classifier.ts`) where it is unit-tested. A SQL expression that re-derived it
-- would be a second definition of agreement, free to drift from the first.
--
-- `message_text` is duplicated from `source_messages.raw_text` on purpose. This is a labelling
-- corpus: the row has to stay readable next to the two verdicts it is about, and joining back to a
-- table whose rows are pruned by retention would make old disagreements unreadable exactly when they
-- have become interesting. The text is already stored elsewhere, so this adds exposure of nothing
-- new.
--
-- UNIQUE (source_message_id, classifier_version) mirrors `message_classifications`: one shadow
-- verdict per message per version of the rules it was being compared against, so bumping
-- CLASSIFIER_VERSION opens a fresh comparison instead of overwriting the old one.

CREATE TABLE IF NOT EXISTS shadow_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL REFERENCES source_messages(id) ON DELETE CASCADE,
  classifier_version text NOT NULL,
  -- Publication time of the message, not of the model call: the agreement rate is a property of the
  -- night the message belongs to.
  published_at timestamptz NOT NULL,
  -- ---- what the rules decided ------------------------------------------------------------------
  deterministic_threat_type text NOT NULL,
  deterministic_locations text[] NOT NULL DEFAULT '{}',
  deterministic_significant boolean NOT NULL,
  -- ---- what the model said ---------------------------------------------------------------------
  model text NOT NULL,
  model_threat_type text NOT NULL,
  model_locations text[] NOT NULL DEFAULT '{}',
  model_significant boolean NOT NULL,
  -- The model's own confidence, 0..1. Kept because a confident disagreement and a hesitant one are
  -- different findings when a human comes to sort them.
  model_confidence numeric(4,3),
  agrees boolean NOT NULL,
  -- Which of the three axes differed, so a disagreement can be filtered without re-comparing arrays.
  disagreement_fields text[] NOT NULL DEFAULT '{}',
  message_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_message_id, classifier_version)
);

-- The two questions `/ops` asks: the agreement rate over a recent window, and the newest
-- disagreements to read.
CREATE INDEX IF NOT EXISTS shadow_classifications_time_idx
  ON shadow_classifications (published_at DESC);
CREATE INDEX IF NOT EXISTS shadow_classifications_disagreement_idx
  ON shadow_classifications (published_at DESC) WHERE agrees = false;

COMMENT ON TABLE shadow_classifications IS
  'Model second opinions on classified messages. Never affects the live pipeline; labelling material for /ops.';

-- ================================================================================================
-- The fourth switch
-- ================================================================================================
--
-- `codex_settings` (migration 018) already holds the operator's model choice and one switch per call
-- site: `narrative`, `digest`, `attacks`. Shadow classification is a fourth call site, so it gets a
-- fourth column in the same row rather than a table of its own — "which parts of the system may
-- speak to a model" is one question, and splitting its answer across two tables would mean an
-- operator has two places to look when the answer is "none of them".
--
-- DEFAULT false, like its three neighbours, and for a sharper reason: this is the only switch whose
-- call site spends a model call on *every ingested message* rather than once a night or once per
-- operator click. An installation that upgrades into this migration must not discover the feature
-- through its quota bill.
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS shadow_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.shadow_enabled IS
  'Whether the shadow classifier may call the model. Off by default: it is the only per-message call site.';
