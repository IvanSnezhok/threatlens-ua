-- The retrospective veto (classifier `v5`) and the model gate that may extend it.
--
-- ================================================================================================
-- What went wrong, in one message
-- ================================================================================================
--
-- On 2026-08-09 at 08:25Z the єРадар monitoring channel published a reflective essay about the
-- night: «Цієї ночі тисячі киян знову ночували на платформах метро… Раніше масовані нальоти БпЛА та
-- часові розрахунки після зльоту бортів стратегічної авіації давали бодай якийсь час на підготовку.
-- Тепер усе інакше.» It contains `баліст`, `БПЛА`, `ракети` and `Києва`, so the classifier read it
-- as a live «Київ — комбінована загроза», opened a threat event and sent a Telegram notification.
--
-- Nothing in the rules read *tense*. The Air Force's 09:00 morning tally and the strategic-aviation
-- channel's after-action write-ups fail the same way and have been sitting in
-- `tests/fixtures/classifier-gold.json` as labelled false positives since the corpus was built.
--
-- `v5` adds two layers. The first is deterministic and lives in `src/domain/classifier.ts`: a
-- message that reads as a report about a period that has ended, and that carries no operational
-- NOW-marker, raises nothing. The second is the model gate in
-- `src/services/retrospective-gate.ts`, for the grey band the rules will not decide on their own.
-- This migration is the two columns those layers need.
--
-- ================================================================================================
-- 1. Two new decisions in the classification archive
-- ================================================================================================
--
-- `message_classifications.decision` is the coarse word a dashboard groups on, and until now a
-- refusal was either `ignored` (recognised something, nowhere to put it) or `unrecognized` (nothing
-- threat-shaped). A retrospective is neither: something threat-shaped WAS recognised, a place WAS
-- resolved, and the message was refused anyway. Folding it into `ignored` would make the one
-- question this release exists to answer — «скільки ретроспектив ми більше не публікуємо, і чи не
-- зникло разом з ними щось справжнє» — unanswerable without re-reading every row's text.
--
-- The two are kept apart from each other for a sharper reason still. `ignored_retrospective` is a
-- decision a reviewer can reproduce from the source: the rules are in a file, the markers are in the
-- row's `indicators`, and replaying the classifier over the archive gives the same answer. NOTHING
-- about `ignored_retrospective_model` is reproducible — it is one model's answer to one question at
-- one moment, and the model may answer differently tomorrow. Two words, because they carry two very
-- different warranties, and an operator auditing a suppression needs to know which one they are
-- looking at before they read anything else.
--
-- The constraint is replaced rather than dropped. A free-form column here would let a typo become a
-- decision word nobody ever groups by, and this table is the corpus every later measurement is taken
-- from.
ALTER TABLE message_classifications DROP CONSTRAINT IF EXISTS message_classifications_decision_check;
ALTER TABLE message_classifications ADD CONSTRAINT message_classifications_decision_check
  CHECK (decision IN (
    'event_created','event_merged','redirect','de_escalation','ignored','unrecognized','coalesced',
    'ignored_retrospective','ignored_retrospective_model'
  ));

COMMENT ON COLUMN message_classifications.decision IS
  'What the pipeline did. ignored_retrospective = refused by the deterministic v5 rules and reproducible from them; ignored_retrospective_model = refused by the model gate and reproducible from nothing.';

-- ================================================================================================
-- 2. The fifth switch
-- ================================================================================================
--
-- `codex_settings` (migration 018) holds one column per call site an operator may switch on:
-- `narrative`, `digest`, `attacks`, and `shadow` since migration 020. This is the fifth, and it is
-- not like the other four.
--
-- Every switch above it buys text. Turn `narrative` off and a paragraph disappears from a page whose
-- numbers were computed in SQL and are unchanged; turn `shadow` off and a comparison table in `/ops`
-- stops filling up. None of them can alter a threat event, an alert, a risk signal or a
-- notification — `src/services/shadow-classifier.ts` says so in its header and returns `void` so
-- that no future edit can quietly start consuming the answer.
--
-- `retrospective_gate_enabled` is the first switch that hands a model authority over the pipeline.
-- With it on, a model reading a message the deterministic rules flagged as `suspect` may convert a
-- threat those rules would have published into an archive-only row.
--
-- The authority is bounded in one direction only, and structurally:
--
--   * the gate is reached from exactly one place, and only for a classification the rules already
--     marked `retrospective.verdict = 'suspect'` — which the rules only ever set on a message that
--     was about to become an event;
--   * its result type admits `archive` from a single branch, reached only when the model answers
--     «this is retrospective» with enough confidence, and every other path — off, over budget, no
--     session, timed out, unparseable, an answer of «this is current» — returns `publish`;
--   * so a model that is broken, slow, absent or hostile can lose a *suppression* and can never
--     lose a *warning*.
--
-- DEFAULT false, and more emphatically than its neighbours. An installation that upgrades into this
-- migration must not discover that a model has started deciding what its subscribers are told.
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS retrospective_gate_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.retrospective_gate_enabled IS
  'Whether the model may confirm a retrospective in the grey band. Off by default: the only switch here whose answer changes what the pipeline does, and it can only ever suppress, never publish.';

-- Every suppression this release can produce, in one statement, newest first. The two decisions are
-- rare by construction and the existing (decision, published_at DESC) index already serves them; the
-- partial index exists so the review query an operator runs after a version bump — "show me
-- everything v5 stopped publishing" — stays a cheap index scan as the archive grows past the point
-- where anyone would run it by hand.
CREATE INDEX IF NOT EXISTS message_classifications_retrospective_idx
  ON message_classifications (published_at DESC)
  WHERE decision IN ('ignored_retrospective','ignored_retrospective_model');
