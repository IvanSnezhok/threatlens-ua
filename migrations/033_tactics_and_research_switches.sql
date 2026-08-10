-- The sixth and seventh switches, and the sentence that says what the third one actually gates.
--
-- ================================================================================================
-- Two new call sites, one table
-- ================================================================================================
--
-- `codex_settings` (migration 018) holds one boolean per place a model may be spent, and the whole
-- point of the table is that an operator watching the output can switch any one of them off without
-- editing `.env` and restarting a container. Two more call sites are arriving:
--
--   * `tactics_enabled`         — the commentary under the PUBLIC tactical block on the attacks
--                                 page. The block itself is arithmetic over the classification
--                                 archive and is complete without a model; the switch buys one
--                                 paragraph of prose beneath numbers that already exist, labelled as
--                                 model-written, and every number in it is checked against the
--                                 detections it was given before a word of it is shown.
--   * `attack_research_enabled` — the operator-only oblast research memo. Never published, never
--                                 scheduled, never reached except by an operator pressing a button
--                                 in `/ops`.
--
-- Both DEFAULT false, like every switch before them. The default is not caution theatre: `tactics`
-- is the first switch whose text reaches a public page directly rather than through Telegram, and an
-- installation that upgrades into this migration must not discover that a model has started writing
-- on its attacks page. `attack_research` is off by default because the memo it produces is
-- `calculated` — it reasons about a window of the near future's history — and an operator has to
-- decide, deliberately, that a model may be involved in that at all.
--
-- Neither switch can create, widen or restore a threat, an alert, a risk signal or a geography.
-- `tactics` rewords detections that were computed in SQL; `attack_research` writes an operator memo
-- and returns it to the one browser that asked. That is the same warranty every switch above them
-- carries except `retrospective_gate`, which remains the only one with authority over the pipeline.
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS tactics_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS attack_research_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.tactics_enabled IS
  'Whether the model may write the commentary under the public tactical block on the attacks page. Off by default: the detections and their numbers are computed in SQL and published either way, and the prose is rejected wholesale if it invents a digit, a class, an oblast or a forecast.';
COMMENT ON COLUMN codex_settings.attack_research_enabled IS
  'Whether the model may write the operator-only oblast research memo. Off by default. The memo is never published, never scheduled and never produced except on an explicit operator request.';

-- ================================================================================================
-- What `attacks_enabled` has actually gated since migration 018
-- ================================================================================================
--
-- The column was named for a page, and it has never gated one. Its single reader is
-- `refineWithCodex()` in `src/services/vector-projection.ts`, which rewords the note attached to an
-- operator-only vector extrapolation — a surface that lives entirely inside `/ops` and is forbidden
-- from reaching any public payload by `src/api/vector-isolation.test.ts`. The public attacks page
-- has never consulted this flag and does not consult it now: the tactical block arriving with
-- `tactics_enabled` is a different surface with a different switch, and reading them as one would
-- mean an operator who switched off "attacks" believing they had silenced the public page had in
-- fact silenced only a paragraph they are the only person who can see.
--
-- A COMMENT rather than a rename. `attacks_enabled` is read by name from `codex-settings.ts`, is
-- already stored in every deployment's row, and renaming it would buy a clearer word at the price of
-- a migration that can lose an operator's setting. The console label moves instead — it now reads
-- «Формулювання екстраполяції вектора», which is what the switch does — and this comment is where a
-- reader who arrives through `psql` finds the same answer.
COMMENT ON COLUMN codex_settings.attacks_enabled IS
  'Whether the model may reword the operator-only vector extrapolation note (refineWithCodex in src/services/vector-projection.ts). Despite the name this has never gated the public attacks page; the public tactical block is gated by tactics_enabled.';
