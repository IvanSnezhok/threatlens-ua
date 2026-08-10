-- Operator-only oblast research: what the archive says about a band of hours, and nothing more.
--
-- ================================================================================================
-- Why this is `calculated` and why it is `ops_`
-- ================================================================================================
--
-- An operator asks «що можливе цієї ночі по Полтавщині». That question cannot be answered from the
-- archive without reasoning about a window that has not happened yet, so every answer this family of
-- tables holds is `calculated` in the sense migration 016 fixed: not something a source said
-- (`observed`), not arithmetic over what already happened (`derived`), but a statement whose subject
-- is a period nobody has reported on. `derived` may be published; `calculated` may not, ever, and
-- the ONLY structural way to keep that true is the one `ops_threat_vector_projections` proved: put
-- the rows in tables whose name no public query may contain. Leaking a memo then requires typing
-- `ops_attack_research_` into a module that builds a public response, which `vector-isolation.test.ts`
-- fails the build over.
--
-- ## What the memo actually contains, and why it is not a forecast
--
-- The one thing this surface refuses to produce is a probability. A percentage attached to a future
-- strike is a prediction whatever the prose around it says, and this project does not make them. So
-- every class in a memo carries a **band** instead — a closed enum of four phrases, each of which is
-- a statement about the past or the present tense and about nothing else:
--
--   * `спостерігається`            — a live event of that class covers this oblast right now;
--   * `типово для цього вікна`     — over thirty days this class fills a real share of these hours;
--   * `нетипово, але траплялося`   — it has happened in these hours, rarely;
--   * `у цьому вікні не фіксували` — the archive has nothing in these hours.
--
-- The band is computed in SQL by `classifyBand()` and is written here as a CHECK over four literals.
-- A model may reword a memo, but the verifier rejects the whole reply if it moves a band by one
-- step, so the enum is the boundary between «переформулювати» and «стверджувати щось інше».
--
-- ## What this can never do
--
-- Nothing here creates, widens, restores or ends an alert, a threat event, a risk assessment or a
-- geography. There is no write path from this family to any of them, by construction: the service
-- that fills these tables holds SELECTs against the archive and INSERTs against these three tables,
-- and that is its whole vocabulary.

-- ================================================================================================
-- Every request, including the ones that were refused
-- ================================================================================================
--
-- The refusals are the reason this table exists rather than only the memo table. An operator who
-- pressed the button four times and got three refusals has a different story from one who pressed it
-- once, and «скільки з двадцяти на сьогодні» is counted FROM HERE rather than from a counter in
-- memory: a process restart must not hand anybody a fresh daily allowance. Governance that lives in
-- a module variable is governance that a `docker compose restart` removes.
CREATE TABLE IF NOT EXISTS ops_attack_research_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ops session has one identity; this records which console asked, not who a person is.
  requested_by text NOT NULL DEFAULT 'operator',
  oblast_id text NOT NULL REFERENCES locations(id),
  -- `research_window`, not `window`: WINDOW is a reserved word in PostgreSQL and a column of that
  -- name would have to be quoted at every use, which is exactly the kind of detail a later writer
  -- forgets once and discovers in production.
  research_window text NOT NULL CHECK (research_window IN ('night','day','next12h')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- `failed` is separate from every refusal on purpose: a refusal is the governance working and is
  -- not a fault, while `failed` is the only value in this column an operator should ever chase.
  status text NOT NULL CHECK (status IN (
    'completed','refused_disabled','refused_cooldown','refused_daily_cap','failed'
  )),
  refusal_detail text
);

CREATE INDEX IF NOT EXISTS ops_attack_research_requests_time_idx
  ON ops_attack_research_requests (requested_at DESC);
-- The cooldown predicate reads exactly this: the newest request for one oblast in one window.
CREATE INDEX IF NOT EXISTS ops_attack_research_requests_scope_idx
  ON ops_attack_research_requests (oblast_id, research_window, requested_at DESC);

-- ================================================================================================
-- The memo
-- ================================================================================================
CREATE TABLE IF NOT EXISTS ops_attack_research_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES ops_attack_research_requests(id) ON DELETE CASCADE,
  -- Same constraint, same argument as migration 016: the marker is a property of the row, so a
  -- consumer that reads a memo and drops the column has still read a row that cannot be anything but
  -- a calculation.
  data_nature text NOT NULL DEFAULT 'calculated' CHECK (data_nature = 'calculated'),
  methodology_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  -- Two values, not three, exactly as the extrapolation's confidence is. `high` is unreachable by
  -- construction — thirty days of one oblast's messages cannot make a claim about an unreported
  -- window high-confidence — and a word left available in the schema eventually reaches a screen.
  confidence text NOT NULL CHECK (confidence IN ('low','medium')),
  -- The safety sentence, stored with the memo rather than rendered beside it. A memo that is copied
  -- out of the console carries its own framing; one that keeps the framing in the template loses it
  -- on the first copy-paste, which is the exact moment it matters.
  framing text NOT NULL,
  -- The evidence pack the memo was written from, verbatim. This is what makes a memo checkable a
  -- week later: every number in `memo` has to be findable here.
  evidence jsonb NOT NULL,
  memo jsonb NOT NULL,
  memo_origin text NOT NULL CHECK (memo_origin IN ('deterministic','model')),
  model_version text,
  prompt_version text,
  -- `skipped` is not a failure: it is what a memo written without ever asking a model records, and
  -- keeping it distinct from `passed` means «the verifier approved this» is never confused with
  -- «the verifier never ran».
  verification text NOT NULL CHECK (verification IN ('passed','rejected','skipped')),
  rejection_reason text,
  ai_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ops_attack_research_memos_time_idx
  ON ops_attack_research_memos (computed_at DESC);
CREATE INDEX IF NOT EXISTS ops_attack_research_memos_request_idx
  ON ops_attack_research_memos (request_id);

-- ================================================================================================
-- One row per threat class, with the band the arithmetic produced
-- ================================================================================================
--
-- A child table rather than a jsonb array inside the memo, for the one question this surface will be
-- asked in six months: «чи справді ми ставили „нетипово, але траплялося“ на балістику по Сумщині у
-- нічній смузі, і скільки разів». That is a query here and a scan of blobs there.
--
-- The band is written even when the memo's prose never uses band words — the deterministic memo
-- deliberately does not, because a fallback that says «типово» without a model having reasoned about
-- it is the same claim in plainer clothes. The audit trail keeps the computed value regardless, so
-- the rule the verifier enforces on a model reply is checkable against what the arithmetic said.
CREATE TABLE IF NOT EXISTS ops_attack_research_classes (
  memo_id uuid NOT NULL REFERENCES ops_attack_research_memos(id) ON DELETE CASCADE,
  threat_type text NOT NULL,
  band text NOT NULL CHECK (band IN (
    'спостерігається',
    'типово для цього вікна',
    'нетипово, але траплялося',
    'у цьому вікні не фіксували'
  )),
  -- Whether the band's first rung was reached, kept as its own boolean: «зараз видно» and «за
  -- тридцять днів типово» are two different facts, and a single word cannot carry both.
  observed_now boolean NOT NULL,
  window_messages integer NOT NULL CHECK (window_messages >= 0),
  window_share numeric(5,4) NOT NULL CHECK (window_share >= 0 AND window_share <= 1),
  baseline_support integer NOT NULL CHECK (baseline_support >= 0),
  data_nature text NOT NULL DEFAULT 'calculated' CHECK (data_nature = 'calculated'),
  PRIMARY KEY (memo_id, threat_type)
);

COMMENT ON TABLE ops_attack_research_requests IS
  'Every operator research request, including refusals. The daily cap and the per-oblast cooldown are counted from this table so a restart cannot reset them.';
COMMENT ON TABLE ops_attack_research_memos IS
  'Operator-only oblast research memos. calculated by constraint: never published, never scheduled, never quotable outside /ops.';
COMMENT ON TABLE ops_attack_research_classes IS
  'Per-class band for one memo, as computed by classifyBand(). Four literals, closed enum: a model may reword a memo but may not move a band.';
