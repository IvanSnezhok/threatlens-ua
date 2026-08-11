-- Contextual and multimodal model analysis remains advisory-only.
-- None of these columns is read by the live threat/alert/risk pipeline.

ALTER TABLE shadow_classifications
  ADD COLUMN IF NOT EXISTS model_analysis jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS context_message_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS media_kinds text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN shadow_classifications.model_analysis IS
  'Validated contextual model verdict, including reported origin/destination/direction and lifecycle state.';
COMMENT ON COLUMN shadow_classifications.context_message_ids IS
  'Bounded same-channel messages shown to the model. Provenance only; they are not current assertions.';
COMMENT ON COLUMN shadow_classifications.media_kinds IS
  'Kinds of transient Telegram media shown or transcribed for the advisory verdict; raw bytes are not persisted.';

ALTER TABLE shadow_classifications DROP CONSTRAINT IF EXISTS shadow_classifications_media_kinds_check;
ALTER TABLE shadow_classifications ADD CONSTRAINT shadow_classifications_media_kinds_check
  CHECK (media_kinds <@ ARRAY['image','audio']::text[]);
