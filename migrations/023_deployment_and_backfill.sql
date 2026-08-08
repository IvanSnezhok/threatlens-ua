-- ================================================================================================
-- Two operator-facing records this deployment has never had: what an update did, and what a
-- catch-up read after downtime did.
-- ================================================================================================
--
-- The two live in one migration because they are one release and because a half-applied pair would
-- leave `/ops` rendering a card whose table does not exist. They share nothing else: section 1 is
-- written by the deployment runner (a separate container that holds the Docker socket), section 2
-- by the collector inside `app`.
--
-- ------------------------------------------------------------------------------------------------
-- Why the deployment journal is in PostgreSQL and not in a file on the host
-- ------------------------------------------------------------------------------------------------
-- The whole point of the journal is to survive the thing it describes. An update destroys and
-- recreates the `app` container: any record held in that process, or in a volume that container
-- owns, is gone exactly when an operator needs it — "the page went away mid-update, what happened".
-- PostgreSQL is the one component the update scenario deliberately never restarts (see
-- `src/deployer/runner.ts`: the compose `up` list is frozen to `app` and `caddy`), it is writable
-- while `app` is down, and it is where `/ops` already reads everything else. A stage transition
-- written here is readable the instant the new container answers.
--
-- ------------------------------------------------------------------------------------------------
-- Why this file lifts the statement timeout for its own transaction
-- ------------------------------------------------------------------------------------------------
-- Same argument migration 022 makes: `src/db/migrate.ts` runs each file inside a transaction on the
-- ordinary application connection, whose session `statement_timeout` is 15 s. The new index on
-- `source_messages` below is built over a table that grows without a retention policy, under a
-- migration that `src/index.ts` awaits BEFORE `buildServer()` — a timeout here is not a slow deploy,
-- it is a container that never reaches listen(). `SET LOCAL` reverts at COMMIT, so no other
-- migration and no runtime statement loses the bound; `lock_timeout` is the companion the lift makes
-- necessary, because failing fast on a lock is strictly better than hanging the boot on it.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '10s';

-- ================================================================================================
-- SECTION 1 — Deployment runs
-- ================================================================================================

-- ------------------------------------------------------------------------------------------------
-- deployment_runs — one row per attempted update, terminal or not
-- ------------------------------------------------------------------------------------------------
--
-- Three properties are enforced here rather than in the runner, because the runner is the process
-- most likely to die mid-scenario and a rule that only exists in a dead process is not a rule:
--
--   1. **Only `refs/heads/main` is ever deployed.** There is no code path that writes another ref,
--      and this CHECK is the second lock on that door. The issue puts "оновлення з довільної гілки,
--      tag або fork" out of scope; a column that can only hold one value is how that stays true
--      after somebody adds a "branch" field to a form.
--   2. **At most one run may be active at a time.** `active_lock` is GENERATED from `status`, so it
--      cannot disagree with it, and the partial unique index below makes a second active row a
--      23505 rather than a race. The advisory lock in the runner is the liveness half of the same
--      guarantee; this is the invariant half, and it holds even if every runner process is killed.
--   3. **Commits are commits.** Every SHA column is CHECKed as 40 lower-case hex. The runner
--      validates the operator's `expectedRemoteCommit` with the same regex before it does anything
--      else, and neither value ever reaches a subprocess argument — but a journal that could record
--      `; rm -rf /` as a commit would be a journal an operator could be socially engineered with.
CREATE TABLE IF NOT EXISTS deployment_runs (
  id                      bigserial   PRIMARY KEY,
  -- queued is written by the runner the instant it accepts the trigger, before any git call, so a
  -- runner that dies between accepting and starting still leaves the attempt visible.
  status                  text        NOT NULL DEFAULT 'queued'
                                      CHECK (status IN ('queued','checking','building','migrating',
                                                        'starting','waiting_ready','succeeded','failed')),
  -- The stage a *terminal* row was in when it stopped. On an active row it equals status; on a
  -- failed row it is the answer to "how far did it get", which status alone ('failed') cannot give.
  current_stage           text,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  -- `config.OPS_USER` of the operator who pressed the button. A DB column and nothing else: it never
  -- reaches an argv array, an environment variable or a shell.
  requested_by            text        NOT NULL DEFAULT 'operator',
  started_at              timestamptz,
  finished_at             timestamptz,
  -- Refreshed every ten seconds while a run is active. A `queued`..`waiting_ready` row whose
  -- heartbeat is minutes old is a runner that died; the next runner start reaps it to
  -- failed/runner_lost. Display only — the reaping decision is taken under the advisory lock.
  heartbeat_at            timestamptz,
  runner_id               text,
  remote_url              text,
  remote_ref              text        NOT NULL DEFAULT 'refs/heads/main'
                                      CHECK (remote_ref = 'refs/heads/main'),
  -- What the operator's browser was showing when the button was pressed. If origin/main has moved
  -- since, the run is refused with commit_moved rather than silently shipping something the
  -- operator never saw.
  expected_commit         text        CHECK (expected_commit ~ '^[0-9a-f]{40}$'),
  from_commit             text        CHECK (from_commit ~ '^[0-9a-f]{40}$'),
  to_commit               text        CHECK (to_commit ~ '^[0-9a-f]{40}$'),
  -- What the *running application* answered, as opposed to what the checkout says. The two differ
  -- exactly when somebody moved the working tree without rebuilding, which is the drift this pair
  -- of columns exists to make visible.
  running_commit_before   text,
  running_commit_after    text,
  migrations_before       integer,
  migrations_after        integer,
  -- The filenames this run actually applied, as a set difference taken around the migrate step.
  -- Empty is the healthy answer for a code-only update and is NOT the same as unknown (NULL).
  migrations_applied      text[]      NOT NULL DEFAULT '{}',
  -- Services whose compose definition changed but which the scenario deliberately did not restart
  -- (postgres, backup, deployer). Best effort, never a failure: see runner.ts step 11.
  pending_manual_services text[]      NOT NULL DEFAULT '{}',
  error_code              text,
  error_summary           text,
  -- The tail of the failing command's combined output, already redacted of the runner token and the
  -- PostgreSQL password by `spawnExec`. Bounded by DEPLOY_LOG_TAIL_BYTES, default 8 KiB.
  log_tail                text,
  -- GENERATED, not maintained: a boolean an application writes beside a status is a boolean that
  -- eventually disagrees with it, and the uniqueness of "one active run" would then be enforced
  -- over a lie. If a target PostgreSQL ever rejects the generated column, the fallback is a plain
  -- boolean with CHECK (active_lock = (status IN (...))) — same invariant, more writes.
  active_lock             boolean     GENERATED ALWAYS AS (status IN ('queued','checking','building',
                                                                      'migrating','starting','waiting_ready')) STORED
);

-- The invariant layer of the concurrency guarantee. A partial unique index over a single-valued
-- column admits exactly one TRUE row and any number of FALSE ones.
CREATE UNIQUE INDEX IF NOT EXISTS deployment_runs_single_active_uidx
  ON deployment_runs (active_lock) WHERE active_lock;
CREATE INDEX IF NOT EXISTS deployment_runs_recent_idx ON deployment_runs (requested_at DESC);

COMMENT ON TABLE deployment_runs IS
  'One row per operator-triggered update. Written by the deployment runner container, read by /ops. Survives the restart it describes because PostgreSQL is the one service the update scenario never restarts.';
COMMENT ON COLUMN deployment_runs.active_lock IS
  'GENERATED from status: true for every non-terminal state. The partial unique index over it is what makes two concurrent runs a 23505 rather than a race.';
COMMENT ON COLUMN deployment_runs.remote_ref IS
  'Always refs/heads/main. The CHECK is the second lock on "no arbitrary branch, tag or fork"; the first is that no code path writes anything else.';
COMMENT ON COLUMN deployment_runs.expected_commit IS
  'The origin/main SHA the operator confirmed. A mismatch against the freshly fetched ref fails the run with commit_moved instead of shipping an unreviewed commit.';
COMMENT ON COLUMN deployment_runs.migrations_applied IS
  'Filenames applied by this run, as a set difference around the migrate step. {} means "none were pending" and is a healthy result; NULL would mean "not measured" and never occurs.';
COMMENT ON COLUMN deployment_runs.log_tail IS
  'Redacted tail of the failing command output. Never contains DEPLOY_RUNNER_TOKEN or the PostgreSQL password: spawnExec strips both before the text reaches this column.';

-- ------------------------------------------------------------------------------------------------
-- deployment_run_events — the stage-by-stage trail behind one run
-- ------------------------------------------------------------------------------------------------
--
-- `deployment_runs` holds the current answer; this holds how it was arrived at. They are separate
-- because the run row is UPDATEd on every transition — a journal kept in the same row would be
-- overwritten by the next stage, which is precisely the information an operator wants after a
-- failure. Cascade on delete: an event without its run is unreadable.
CREATE TABLE IF NOT EXISTS deployment_run_events (
  id         bigserial   PRIMARY KEY,
  run_id     bigint      NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  stage      text        NOT NULL,
  outcome    text        NOT NULL CHECK (outcome IN ('started','ok','failed','skipped')),
  duration_ms integer,
  detail     text
);
CREATE INDEX IF NOT EXISTS deployment_run_events_run_idx ON deployment_run_events (run_id, id);

COMMENT ON TABLE deployment_run_events IS
  'Append-only stage trail for one deployment run. Separate from deployment_runs because that row is overwritten by every transition.';

-- ------------------------------------------------------------------------------------------------
-- deployment_state — what the last check saw, so /ops has something to show between runs
-- ------------------------------------------------------------------------------------------------
--
-- Singleton, seeded by this migration for the same reason `runtime_settings` is: reading it must be
-- a plain SELECT that finds either defaults or a real observation, never "no row, therefore
-- unknown". The card renders «Синхронізовано» / «Доступне оновлення» from this row plus the running
-- container's own commit, and it must render something honest before the first check has ever run.
CREATE TABLE IF NOT EXISTS deployment_state (
  singleton           boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  remote_url          text,
  branch              text        NOT NULL DEFAULT 'main' CHECK (branch = 'main'),
  -- The newest SHA seen on origin/main by a check. NOT a promise that it is fetched locally: the
  -- cheap check is `git ls-remote`, which touches nothing in the working tree.
  remote_commit       text,
  working_tree_commit text,
  working_tree_dirty  boolean     NOT NULL DEFAULT false,
  last_checked_at     timestamptz,
  last_check_ok       boolean,
  last_check_error    text,
  runner_version      text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO deployment_state(singleton) VALUES (true) ON CONFLICT DO NOTHING;

COMMENT ON TABLE deployment_state IS
  'Singleton snapshot of the last origin/main check: what the remote had, what the checkout has, whether the tree is clean. Seeded by the migration so a read is never "no row, therefore unknown".';
COMMENT ON COLUMN deployment_state.working_tree_dirty IS
  'A dirty checkout refuses the update with working_tree_dirty. Deploying over uncommitted host edits would silently discard them and make the recorded to_commit a lie.';

-- ================================================================================================
-- SECTION 2 — Catch-up backfill for classifier sources
-- ================================================================================================

-- ------------------------------------------------------------------------------------------------
-- source_backfill_state — per-source progress of the post-downtime catch-up read
-- ------------------------------------------------------------------------------------------------
--
-- Why not columns on `sources`
-- ----------------------------
-- `sources` is a catalogue: rows describe what a channel *is* and are written by hand in migrations
-- after somebody read the channel. This is per-run telemetry, rewritten on every sweep. Sixteen
-- churning columns on the catalogue would make every `SELECT * FROM sources` in the codebase carry
-- them, and would put the catalogue's rows in the write path of a five-minute worker.
--
-- Why the cursor here is NOT authoritative
-- ----------------------------------------
-- The real cursor is `source_messages`: `MAX(published_at)` for the source, which is the archive's
-- own statement about what has been collected. It is DERIVED on every decision and copied here for
-- display and audit. That choice is what makes the hot path free of extra writes and what makes a
-- thrown message safe — a message that failed to process never advanced the archive, so the next
-- sweep sees the same gap and reads it again (at-least-once, made harmless by the message-level
-- idempotency that already exists: source_messages UNIQUE (source_id, external_id, content_hash)
-- and message_classifications UNIQUE (source_message_id, classifier_version)).
--
-- `baseline_at` is the one thing that cannot be derived. A source the deployment has never collected
-- has no archive row at all, and "no cursor" must mean "zero gap", not "backfill from the epoch" —
-- otherwise enabling a channel would trigger a mass historical read. The row is written the first
-- time the source is considered, and `now()` at that moment is the honest zero point.
CREATE TABLE IF NOT EXISTS source_backfill_state (
  source_id             text        PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  baseline_at           timestamptz NOT NULL DEFAULT now(),
  -- Copied from the archive probe, for the operator card and for after-the-fact audit. Never read
  -- back as an input to the gap decision.
  cursor_published_at   timestamptz,
  cursor_external_id    text,
  last_checked_at       timestamptz,
  last_gap_seconds      integer,
  last_run_at           timestamptz,
  -- 'truncated' is a SUCCESS: the window was capped by age, count or pages and everything inside it
  -- was replayed. The card says «дозбір обмежено», not «помилка», and the distinction matters
  -- because a permanently truncated source is a configuration decision, not an incident.
  last_run_status       text        CHECK (last_run_status IN ('ok','truncated','skipped_small_gap',
                                                              'skipped_recent','skipped_disabled',
                                                              'no_cursor','failed')),
  last_run_finished_at  timestamptz,
  last_run_duration_ms  integer,
  covered_from          timestamptz,
  covered_to            timestamptz,
  messages_read         integer     NOT NULL DEFAULT 0,
  messages_replayed     integer     NOT NULL DEFAULT 0,
  messages_duplicate    integer     NOT NULL DEFAULT 0,
  -- Read and replayed, but outside its own validity window: archived, never published as current.
  messages_stale        integer     NOT NULL DEFAULT 0,
  messages_failed       integer     NOT NULL DEFAULT 0,
  pages_read            integer     NOT NULL DEFAULT 0,
  truncated_reason      text        CHECK (truncated_reason IN ('age','count','pages')),
  last_error            text,
  last_error_at         timestamptz,
  -- Drives the exponential re-run guard: a source that fails is retried after
  -- MIN_RERUN_SECONDS * min(2^consecutive_failures, 24), so a poison message costs one read per day
  -- rather than one every five minutes. Reset to zero by any non-failed outcome.
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE source_backfill_state IS
  'Per-source progress of the catch-up read that runs after downtime longer than CLASSIFIER_BACKFILL_MIN_GAP_SECONDS. Telemetry, not catalogue: the authoritative cursor is derived from source_messages on every decision.';
COMMENT ON COLUMN source_backfill_state.baseline_at IS
  'Zero point for a source with an empty archive, written the first time it is considered. Without it a never-collected channel would report an infinite gap and trigger a mass historical read the first time it is enabled.';
COMMENT ON COLUMN source_backfill_state.last_run_status IS
  'truncated is a success bounded by age/count/pages, not a failure; failed is the only value that raises consecutive_failures.';

-- The one-row cursor probe: `ORDER BY published_at DESC, external_id DESC LIMIT 1` per source, run
-- on every sweep for every classifier source. Without this index that is a scan of every message
-- the installation has ever archived; `source_messages_published_idx` (001) is global and cannot
-- serve the per-source ordering.
CREATE INDEX IF NOT EXISTS source_messages_source_published_idx
  ON source_messages (source_id, published_at DESC);
