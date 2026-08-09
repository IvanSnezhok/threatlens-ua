# Operations runbook

## Health

- `/health/live`: process is running. This is what the container healthcheck probes, so nothing below restarts the app. It also carries `commit` and `builtAt` — what image is actually serving, baked in at build time.
- `/health/ready`: database is reachable, **every migration shipped in this image** is applied, and the MTProto collector is not blocked. The migration check is a set comparison against the image's own `migrations/` directory, not one hard-coded filename: a 503 answers `{"reason":"migrations_pending","required":[…],"applied":[…]}` so the diff is readable. A ready response carries `commit` (the image's `APP_COMMIT`) and `migration` (the newest shipped file) — the deployment runner requires both a 200 and a matching `commit` before it records an update as successful, which is what stops a `compose up` that silently kept the old container from being reported as a success. The response carries a `collector` object in both directions; `503 {"reason":"collector_flood_wait"}` and `collector_failed` are the two states that mean no Telegram channel is being read at all. `disabled` (no MTProto credentials) and `degraded` (handlers live, some handles unbound) stay ready.
- `/api/v1/sources/health`: configured, current, stale, error and unconfigured source states. MTProto rows additionally carry `collector` — the live handler state, which the database cannot hold.
- `/ops/api`: Basic-auth protected worker, AI, source and database state.
- `/ops`: operator console. Credentials are held only in the active tab's memory; it can add, verify, activate and hide recommended Telegram channels.
- `/metrics`: open in development; in production requires `METRICS_TOKEN` Bearer auth or ops Basic auth.

The site continues to show the last known state when SSE disconnects and marks it stale. A stale official source must never be presented as current.

## Routine commands

```bash
docker compose ps
docker compose logs -f app
docker compose exec -T app curl -fsS http://localhost:3000/health/ready
docker compose exec -T postgres psql -U threatlens -d threatlens -c 'TABLE schema_migrations'
```

## Publication mode (operator only)

The public presentation can be held back by `PUBLICATION_DELAY_SECONDS` (default 15). The mode lives
in `runtime_settings` and is switched from `/ops` — «Режим показу» — not from `.env`, because the
moment to stop holding data is the worst possible moment to edit a file and restart. `live` is the
default and is byte-identical to a build without the feature. Full contract: `docs/ARCHITECTURE.md`,
"Publication mode".

The hold is presentation-only. Collection, classification, the alert reconciler, `alert_periods`,
the audit tables, `/ops`, `/metrics`, `/health/*` and **Telegram notifications** are never delayed.
The console states that beside the switch; so should anyone answering a question about it.

```bash
# Stored settings, their bounds, what the hold is doing right now, and who changed what.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/api/runtime

# Hold the public view. Any subset of fields; omitted ones keep their value.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X PUT -H 'Content-Type: application/json' \
  -d '{"publicationMode":"delayed_15s"}' http://localhost:3000/ops/api/runtime

# Release it.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X PUT -H 'Content-Type: application/json' \
  -d '{"publicationMode":"live"}' http://localhost:3000/ops/api/runtime
```

Reading it:

- **`effective` is the answer, `settings` is only the intent.** `backlogEvents` is how many rows are
  written but not yet released and `behindSeconds` is how far behind wall clock the last slice was;
  a stored mode with neither of those is the confusing state this block exists to prevent. In `live`
  both are zero except for rows written in the same millisecond as the read.
- **The cutoff cannot move backwards over a flip.** It is
  `GREATEST(now() - delay, mode_changed_at)`, so switching to `delayed_15s` holds *new* rows and
  never retracts what was already published. An alert that was open three seconds before the flip is
  still returned; one that ended before it stays ended.
- **A provider flap does not blank an alert either.** When a source drops a region for one poll and
  re-lists it with the same declared start, the reconciler reopens the same period. It refreshes
  `alert_periods.published_at` only when the period had already been publicly cleared — a gap longer
  than `PUBLICATION_DELAY_SECONDS`. A shorter flap keeps the original value, because the delayed view
  was still drawing that alert one millisecond earlier and re-stamping it would take the red polygon
  off the public map for the rest of the hold. If you ever see an oblast blink in `delayed_15s`, this
  is the first thing to check: `SELECT status, published_at, ended_at, updated_at FROM alert_periods
  WHERE location_id = …`.
- **The public attack analytics hold on receipt time, not on the post's own timestamp.**
  `message_classifications.published_at` is the Telegram post's time and is what the window
  («за добу») is measured on; the hold is applied to `classified_at`, the instant we recorded the
  classification. So a message an hour old that we only just ingested still waits out the full hold
  before it appears in the aggregate — that is the intended behaviour, not a lagging query.
- **A 400 with `issues` is the API refusing an impossible pair, not a fault.**
  `analyticsMaxDelayMs` below `analyticsDebounceMs` is rejected inside the row lock, so two
  concurrent PUTs both get a 400 naming the field rather than one getting a 500.
- **`publication.mode` is never itself held.** The public snapshot reports the mode in force right
  now, so the page cannot claim to be live while data is being held back. That is also why
  `GET /api/v1/analytics/attacks` drops its shared cache header while the hold is on: a body cached
  in `live` mode would otherwise be replayed for up to an hour after the flip.
- **`threatlens_publication_lag_seconds` and `threatlens_publication_backlog_events` describe the
  last thing a reader was actually served**, not a value a separate scheduler sampled. The lag gauge
  is nonzero exactly when somebody was shown held data.

## Event-driven analytics (operator only)

Assessments used to move on three unrelated clocks with no invalidation of any kind: the materialised
views on a fifteen-minute timer, the risk engine on another, and the public attack-analytics memo on
a 120-second TTL that expires but is never invalidated. A threat observed at 10:00:01 could first
appear in the map's аналітична оцінка at 10:15:00. The recompute worker adds the missing trigger —
the moment something the analytics describe actually changed — and the fifteen-minute timer stays as
the floor beneath it.

It subscribes to the **recorded** event feed, never the published one. In `delayed_15s` a
`threat.created` on the published feed would not reach it for fifteen seconds, and the map would pay
the hold twice: once on the presentation and once again on the assessment describing it. Seven event
types arm a pass — `alert.started`, `alert.ended`, `threat.created`, `threat.updated`,
`threat.corrected`, `threat.withdrawn`, `threat.expired`. `assessment.updated` is deliberately absent:
the risk engine writes it, so subscribing to it would make every recompute schedule the next one.

```bash
# The cadence settings live beside the publication mode.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/api/runtime

# Slow it down under load: wait 60s after the last event, never postpone past 5 minutes.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X PUT -H 'Content-Type: application/json' \
  -d '{"analyticsDebounceMs":60000,"analyticsMaxDelayMs":300000}' \
  http://localhost:3000/ops/api/runtime

# Stop event-driven recompute, keeping the fifteen-minute floor.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X PUT -H 'Content-Type: application/json' \
  -d '{"analyticsEventDriven":false}' http://localhost:3000/ops/api/runtime

# Run one pass now. Same code path as the automatic ones; «Оновити зараз» in /ops does this.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X POST \
  http://localhost:3000/ops/api/analytics/recalculate
```

Reading it:

- **A skip is an answer, not a failure.** `skipped: 'overlap'` means a pass was already running,
  `'disabled'` that the switch is off, `'cooldown'` that the previous pass completed less than a
  minute ago. Each has its own `threatlens_analytics_recompute_total{outcome=…}` series, so «нічого
  не перерахувалося» is always attributable.
- **The debounce is not the only bound.** `ANALYTICS_MIN_PASS_INTERVAL_MS` (60 s) is the minimum gap
  between two *completed* passes and it is compiled in, not settable. Lowering the debounce to two
  seconds does not produce a pass every two seconds; it produces `skipped_interval`.
- **`analyticsMaxDelayMs` is the guarantee, `analyticsDebounceMs` is the wait.** Under a continuous
  stream the debounce window is re-armed indefinitely; the max delay is what fires anyway. The API
  refuses a max delay below the debounce, because that pair has no meaning.
- **The manual button always runs**, whatever the switch says — an operator who pressed it has
  overridden the switch by pressing it — but it is subject to the same overlap and interval guards.
- **`ANALYTICS_EVENT_DRIVEN_ENABLED=false` in `.env` is a bigger hammer than the switch.** The worker
  then never subscribes at all. It exists because the reason to stop event-driven recomputation is
  usually that it is amplifying a database problem, which is the worst moment to need the database
  to read a flag.
- **The Codex leg never touches the numbers.** It writes prose over already computed aggregates
  behind `codexCooldownMs`, and a skipped call is counted in `threatlens_codex_cooldown_skips_total`
  and reported as `codex: 'cooldown'`.
- **The risk leg does call a model, and it is bounded separately.** On a deployment where
  `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are set, `runRiskAssessments` calls that model **once
  per `(location, threat_type)` group**, and one nationwide message fans a group out over every
  oblast for six hours. A recompute is therefore allowed to spend it **at most once per
  `ANALYTICS_RECOMPUTE_FLOOR_MS` (15 min), plus every press of «Оновити зараз»**; the passes in
  between still re-score every group, through the deterministic scorer that is the default wherever
  `AI_*` is unset. Model spend on this path is otherwise governed by the same three levers as
  database load — `analyticsDebounceMs`, `analyticsMaxDelayMs`, `analyticsEventDriven` — plus the
  legacy fifteen-minute `startRiskScheduler` timer, which is unaffected by any of them.
- **A failing materialised-view refresh costs the pass its views and nothing else.** It is counted as
  `outcome="view_refresh_failed"`, logged with the pg error, and the risk leg, the Codex leg and the
  `analytics.updated` row still run. The refresh is then retried at floor cadence, not on the next
  pass.

## Threat vector extrapolation (operator only)

The public product publishes the chain of *reported* observations behind a threat and stops where the
reporting stops. Continuing the last leg is an internal tool. It lives behind the same Basic auth as
the rest of `/ops`, in its own tables, and **must not be quoted publicly, forwarded to a channel or
pasted into a message to the public** — it is a calculation about the future, and the product's
standing commitment is that it does not predict targets or trajectories.

```bash
# Live events that have a chain worth extrapolating, plus the last 20 projections.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/vectors

# Compute, record and read one projection. horizonMinutes is 1..60, default 15.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X POST \
  "http://localhost:3000/ops/threats/<event-id>/vector-projection?horizonMinutes=15"
```

The same panel is rendered inside `/ops` in the browser. Reading it:

- **`dataNature: "calculated"`** is on the row, not on the caption. It is a CHECK constraint, so no
  row in these tables can claim to be an observation.
- **`uncertainty`** is mandatory. `lateralHalfAngleDegrees` widens for every admission the computation
  has to make — one leg only, an approximate raion centroid on either end, sub-minute spacing between
  the two reports, a stale last report — and `reasons` names each one in Ukrainian.
  `confidence` is only ever `low` or `medium`; `high` is not a value the schema accepts.
- **`candidates`** are locations that fall in or near the cone. They are a *calculation about places*,
  never a report that anything is heading there. `withinUncertainty: false` means "near the cone, not
  in it" and is kept deliberately rather than dropped.
- **`narrativeOrigin`** is `deterministic` unless a model was configured *and* its rewording passed
  validation. The numbers are never the model's: a reply containing any number the computation did not
  produce is discarded and the generated wording is used.

A `422 projection_unavailable` is a normal answer, not a fault. `no_drawable_leg` means no leg has a
coordinate at both ends (hromadas, and raions missing from the ADM2 file); `no_elapsed_time` means one
message stated both ends, which gives a heading but no speed; `implausible_speed` means two reports
landed close enough together that the ratio is an artefact.

## Codex analytics (operator only)

The whole lifecycle lives in one `/ops` group — «Codex-аналітика»: session status, the sign-in
button, the model dropdown, the four surface switches (narrative, digest, attacks, shadow
classification) and the `ai_runs` audit viewer. Nothing about it requires editing `.env` or
restarting, except `CODEX_BASE_URL` itself.

```bash
# Session: is there one, whose is it, when does it die. Never returns a token.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/codex

# Current settings, the model catalogue and its provenance.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/codex/settings

# Pick a model and switch surfaces. Any subset of fields; omitted ones keep their value.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X PUT -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-luna","features":{"narrative":true,"digest":true,"attacks":true,"shadow":true}}' \
  http://localhost:3000/ops/codex/settings

# The audit log: every call, including the ones that never left the process.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" 'http://localhost:3000/ops/ai-runs?limit=20'
```

Reading it:

- **The switches are off by default.** An installation that never opens the console never calls a
  model, and every surface produces its complete deterministic output either way.
- **`modelsSource: "fallback"` against the ChatGPT backend is by design**, not a degradation — that
  backend publishes no `/models`, so the dropdown is the static list plus whatever is already
  selected. Against an OpenAI-compatible proxy the list comes from the service.
- **The prose stopping is answered by `ai_runs`, not by guesswork.** Pre-flight refusals are recorded
  under the model that would have been used (`no_session`, `model_not_selected`, `not_configured`),
  endpoint refusals keep the status code and never the response body, and a `session_expired` streak
  means someone needs to press the sign-in button again.
- **The shadow switch spends quota during attacks by design.** Shadow classification runs on exactly
  the messages the classifier is already processing, capped by `SHADOW_CLASSIFIER_MAX_PER_MINUTE`
  (default 6, messages over budget dropped, never queued). The switch lives here and not in `.env`
  precisely because the moment to turn it off — an exhausted quota mid-attack — is the worst moment
  to edit a file and restart. Its runs audit under `shadow-classifier-v1`; `/ops` shows the agreement
  rate and the newest disagreements, and the follow-up is a pattern and a test, never a state change.

## Source trust (operator only)

The nightly worker scores every source's last thirty days from the classification archive and
appends one row per source per run; the map shows subscribers one word, the ops surface shows the
arithmetic. Full contract: `docs/ARCHITECTURE.md`, "Dynamic source trust".

```bash
# Every source with its current score, label and modifier — and the methodology
# (weights, window, thresholds) in the same payload, so the number can be checked.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/api/source-trust

# The append-only series behind one source's value, newest first.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" 'http://localhost:3000/ops/api/source-trust/<source-id>?limit=60'

# Recompute now. Appends a real run, indistinguishable from the nightly one.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X POST http://localhost:3000/ops/api/source-trust/recalculate
```

Reading it:

- **`neutral: true` is not a verdict.** Below twenty observed events the window cannot distinguish a
  bad channel from an unlucky one, so the source keeps 0.5 and `neutralReason` says why, naming the
  window the run actually used.
- **An official source at exactly neutral may be floored.** `officialFloorApplied` distinguishes "we
  measured 0.5" from "we measured worse and the mandate floor held" — the second one is the cue for
  an editorial look at the channel, since the nightly run deliberately will not demote it.
- **Trust is not tier.** A source at the 0.6 floor still contributes 60% of its weight, and the
  3.9/5.9 caps run after the modifier. If a channel deserves less than that, the response is its
  `sources` row — disable it — not a hope that the measurement will silence it.
- **A step in a series with an unchanged channel** usually means `TRUST_METHODOLOGY_VERSION` moved;
  every row carries the version it was computed under, so compare like with like.

## Deployment from /ops

Off unless `DEPLOY_ENABLED=true`. Off is a complete configuration: the «Оновлення з main» block says
so, no `deployer` container is needed, and updates stay a manual `git pull && docker compose up -d
--build` on the host.

### Prerequisites, in order

1. **An absolute checkout path, mounted at the same path inside the runner.**
   `DEPLOY_REPO_PATH=/opt/threatlens-ua` and the bind mount in `compose.yaml` is
   `${DEPLOY_REPO_PATH}:${DEPLOY_REPO_PATH}`. This is not a stylistic choice: `docker compose` runs
   *inside* the runner, but the daemon that executes the resulting mounts runs *outside*, and
   relative bind mounts in `compose.yaml` are resolved daemon-side against `--project-directory`,
   which is a host path. Mount the checkout anywhere else and every relative mount in the file
   resolves to a directory that does not exist on the host.
2. **`name: threatlens` in `compose.yaml`** (already there). The runner addresses the stack as
   `docker compose -p threatlens`; an inferred project name would build a second stack beside the
   running one and the update would appear to do nothing.
3. **A real token.** `openssl rand -hex 32` into `DEPLOY_RUNNER_TOKEN`. Production refuses to boot
   with `DEPLOY_ENABLED=true` and fewer than 32 characters, and the runner itself refuses to start.
4. **Start the runner once, by hand:** `docker compose up -d deployer`. The scenario deliberately
   never restarts it — a runner that replaces itself mid-run cannot report its own outcome, and
   somebody who can push to `main` must not be able to swap the runner by way of the button.
5. **Branch protection on `main`.** Anyone who can write `main` ships code the moment an operator
   presses the button. Stated prerequisite, not a defect.

### What the button can and cannot do

| Can | Cannot |
|---|---|
| Rebuild and restart at the current `origin/main` of the configured remote | Choose a branch, tag, fork, remote or arbitrary commit — no code path, plus a DB `CHECK (remote_ref='refs/heads/main')` |
| Run pending migrations from the target image | Reach a shell, or pass any operator-supplied byte to a subprocess argument |
| Recreate `app` and `caddy` | Restart `postgres`, `backup` or `deployer` |
| Read the journal and the tail of a failing command | Run two updates at once, or more often than `DEPLOY_MIN_INTERVAL_SECONDS` |

The app never holds the Docker socket, and `src/deployer/compose-contract.test.ts` fails the build if
that changes. The runner publishes no host port (`expose`, never `ports`) and Caddy proxies exactly
one upstream, `app:3000`.

### The scenario, stage by stage

`checking` → `building` → `migrating` → `starting` → `waiting_ready` → `succeeded` | `failed`.
«idle» is the absence of an active row.

1. `checking` — origin URL matches, working tree clean, `git fetch` origin/main, the fetched SHA
   equals the one the operator confirmed, record `HEAD` and what `/health/live` reports, then
   `git checkout --detach <target>`. If the checkout and the running container are both already at
   the target, the run finishes `succeeded` with `already_current` and nothing is built.
2. `building` — `docker compose build app` with `APP_COMMIT`/`APP_BUILT_AT` in the child environment.
3. `migrating` — `schema_migrations` is read, `docker compose run --rm --no-deps -T app node
   dist/db/migrate.js` runs from the freshly built image **while the old app is still serving**, and
   the set difference lands in `migrations_applied`. An empty list is the healthy result of a
   code-only release.
4. `starting` — `docker compose up -d --no-build app caddy`.
5. `waiting_ready` — poll `/health/ready` until it answers 200 **and** `commit` equals the target,
   up to `DEPLOY_READY_TIMEOUT_SECONDS`.
6. A best-effort drift probe compares the compose definitions of `postgres`, `backup` and `deployer`
   against the running containers and records `pending_manual_services`. It can never fail a run.

**Why the migration is a separate step before the restart.** `src/index.ts` still runs `migrate()`
at boot, and that stays as the cold-start cover. But boot-time migration happens *after* the old
container has been destroyed: a failing migration then leaves a crash-looping new container and a
site that is down. Running it from the new image while the old one still serves means a failure ends
the run at `migrating` with the site untouched — the least bad outcome of a bad release, and the one
the runbook wants.

**The cost, stated:** between the migration and the restart, old code runs against the new schema.
That makes expand/contract a hard project rule — a migration may add; it may not rename or drop a
column the previous release still reads, in the same release. Every migration in this repository
complies.

### Reading it by hand

```bash
# The whole card the console renders, in one request.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/api/deploy

# Ask what origin/main holds right now. `git ls-remote`, no fetch, nothing written to the checkout.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X POST http://localhost:3000/ops/api/deploy/check

# Trigger. `confirm` and a 40-hex commit are the ONLY accepted keys; anything else is a 400.
curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X POST -H 'Content-Type: application/json' \
  -d '{"confirm":true,"expectedRemoteCommit":"<40 hex>"}' http://localhost:3000/ops/api/deploy

# The journal, straight from the database — this is what survives the restart it describes.
docker compose exec -T postgres psql -U threatlens -d threatlens -c "
  SELECT id, status, current_stage, requested_at, requested_by,
         left(from_commit,7) AS from, left(to_commit,7) AS to,
         error_code, cardinality(migrations_applied) AS migrations
  FROM deployment_runs ORDER BY requested_at DESC LIMIT 10"

docker compose exec -T postgres psql -U threatlens -d threatlens -c "
  SELECT at, stage, outcome, duration_ms, detail FROM deployment_run_events
  WHERE run_id=(SELECT max(id) FROM deployment_runs) ORDER BY id"

# What the last check saw.
docker compose exec -T postgres psql -U threatlens -d threatlens -c 'TABLE deployment_state'
```

`log_tail` on a failed row is the end of the failing command's output, already stripped of the runner
token and the PostgreSQL password. It is rendered verbatim in `/ops`.

### Recovery, per `error_code`

| `error_code` | What happened | What to do |
|---|---|---|
| `remote_mismatch` | The checkout's `origin` is not `DEPLOY_REPO_URL` | Fix the remote on the host, or the variable. Nothing was touched. |
| `working_tree_dirty` | Uncommitted changes on the host | Commit, stash or discard them. The runner refuses rather than discarding somebody's work. |
| `fetch_failed` | `git fetch` could not reach the remote | Network, DNS, rate limit. Read `log_tail`. Nothing was touched. |
| `commit_moved` | `origin/main` moved between the page render and the confirmation | Reload `/ops` and confirm the new SHA. This is the guard working. |
| `checkout_failed` | `git checkout --detach` failed | Read `log_tail`; usually a permission or a local ref problem. Working tree may be mid-checkout — inspect it on the host. |
| `build_failed` | The image did not build | The site is untouched and still serving. Read `log_tail`, fix, push, press again. |
| `migration_failed` | **The good failure.** A migration from the new image failed | The old container is still serving. Each migration file runs in its own transaction, so the schema is consistent at whichever file failed. Fix the migration, push, press again. Do not hand-edit `schema_migrations`. |
| `start_failed` | `docker compose up` failed | Read `log_tail` (port conflict, missing volume). `docker compose ps` on the host; the old container may already be gone. |
| `ready_timeout` | The new container never became ready | `docker compose logs app`. The migrations already ran, so a rollback is a code rollback only (below). |
| `ready_commit_mismatch` | `/health/ready` answers 200 from a **different** commit | The recreate did not happen or brought back the old container. `docker compose ps` and `docker compose up -d --force-recreate app` on the host. This is the check that stops a no-op being recorded as a success. |
| `runner_lost` | The runner process died mid-run | The next runner start reclaims the row and marks it. Check `docker compose ps deployer` and its logs; the update may or may not have landed — compare `/health/live`'s `commit` with `origin/main`. |

### Rollback boundaries

- **Forward-only.** Migrations are never reversed by anything in this system, and no endpoint offers
  it. A bad release is fixed by a new commit.
- **Rolling code back is a manual host action**, and it does not undo a migration:

  ```bash
  cd "$DEPLOY_REPO_PATH"
  git checkout --detach <known-good-commit>
  APP_COMMIT=$(git rev-parse HEAD) docker compose -p threatlens build app
  docker compose -p threatlens up -d --no-build app caddy
  ```

  This works only because migrations expand rather than rename or drop. If a release did break that
  rule, the rollback path is a restore from `backups/` (see "Backups"), which loses everything
  written since the dump — which is why the rule is a rule.
- **`postgres`, `backup` and `deployer` never move.** When their compose definition changes, the run
  records `pending_manual_services` and `/ops` prints the command; run it during a maintenance
  window, not during an attack.

## Catch-up backfill (дозбір)

After downtime the collector reads what it missed for every enabled **classifier** Telegram source.
Official alert channels are not part of this contour at all: they have their own reconnect path
(`ALERT_CHANNEL_BACKFILL_*`), because their messages are state transitions that get folded to one
terminal state per location, while these are events that get archived one by one.

### The decision, per source

```
gap = now - cursor.published_at        # cursor is derived from source_messages, not stored state
skipped_disabled    the feature or the source is off
no_cursor           the archive is empty; baseline_at was just written, so the gap is zero
skipped_recent      read too recently (exponential guard after failures)
skipped_small_gap   gap <= CLASSIFIER_BACKFILL_MIN_GAP_SECONDS      # 59 min -> skip, 60 min -> skip
run                 otherwise                                        # 61 min -> run
```

The window is `[max(cursor, now - MAX_AGE_SECONDS), now]`, paged newest-first and replayed in
chronological order. **`truncated` is a success**, not a failure: the window hit its bound by age,
count or pages, and everything inside it was replayed. `/ops` says «дозбір обмежено» and names which
bound. A permanently truncated source is a configuration decision, not an incident.

**Why a stale message never becomes news.** The single trigger for the public map, the SSE stream and
every Telegram notification is a row in `system_event_log`. A replayed message whose own 30-minute
validity window has already closed is archived — `source_messages`, `message_classifications`, a
`threat_events` row born `expired` — and appends *nothing* to `system_event_log`. No log row means no
fanout and no map change, in one place rather than in five. A message from inside the window is
treated exactly as a live one, because it is one.

```bash
# Per-source progress, worst gap first.
docker compose exec -T postgres psql -U threatlens -d threatlens -c "
  SELECT source_id, last_run_status, truncated_reason, last_gap_seconds,
         cursor_published_at, messages_read, messages_replayed, messages_stale, pages_read,
         consecutive_failures, left(coalesce(last_error,''),80) AS error
  FROM source_backfill_state ORDER BY last_gap_seconds DESC NULLS LAST"

# Clear the exponential re-run guard for one source after fixing the cause.
docker compose exec -T postgres psql -U threatlens -d threatlens -c "
  UPDATE source_backfill_state SET consecutive_failures=0, last_run_at=NULL WHERE source_id='…'"
```

There is deliberately **no manual trigger**. An operator-fired history burst is exactly the request
shape that earns a Telegram flood wait, and a flood wait stops live collection for every channel on
the account. The sweep re-checks every `CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS` (300) by itself.

## Analytical queries

The classification archive and the assertion table are shaped so each of these is one statement.
Pinned by `tests/integration/classification-archive.test.ts`, which runs them against ingested data.

**Threat events per class, per oblast, per month, split by classifier version.** The roll-up walks
`parent_id` rather than joining one edge, so a city event still counts towards its oblast once the
raion tier sits between them.

```sql
WITH RECURSIVE ancestry(location_id,node_id,node_type,depth,path) AS (
    SELECT l.id,l.id,l.type,0,ARRAY[l.id] FROM locations l
  UNION ALL
    SELECT a.location_id,parent.id,parent.type,a.depth+1,a.path||parent.id
    FROM ancestry a
    JOIN locations child ON child.id=a.node_id
    JOIN locations parent ON parent.id=child.parent_id
    WHERE a.depth<8 AND NOT (parent.id=ANY(a.path))
)
SELECT date_trunc('month',e.started_at AT TIME ZONE 'Europe/Kyiv')::date AS month,
       oblast.node_id AS oblast_id, e.threat_type, mc.classifier_version,
       count(DISTINCT e.id) AS events
FROM message_classifications mc
JOIN threat_events e ON e.id=mc.event_id
JOIN threat_event_locations el ON el.event_id=e.id
JOIN ancestry oblast ON oblast.location_id=el.location_id
                    AND oblast.node_type IN ('oblast','special_city','country')
GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
```

**Where threats are lost.** For every threat that ended in a stand-down rather than in the validity
timer: where it was last asserted, where it was withdrawn, by whom, and how long it stood.

```sql
SELECT e.threat_type, e.evidence_level,
       last_assertion.source_id AS last_asserted_by, last_assertion.location_id AS last_asserted_for,
       withdrawal.source_id AS withdrawn_by, withdrawal.location_id AS withdrawn_for,
       withdrawal.withdrawal_reason,
       withdrawal.withdrawn_at - last_assertion.asserted_at AS held_for
FROM threat_events e
CROSS JOIN LATERAL (
  SELECT ta.source_id,ta.location_id,ta.asserted_at FROM threat_assertions ta
  WHERE ta.event_id=e.id ORDER BY ta.asserted_at DESC,ta.id LIMIT 1) AS last_assertion
CROSS JOIN LATERAL (
  SELECT ta.source_id,ta.location_id,ta.withdrawn_at,ta.withdrawal_reason FROM threat_assertions ta
  WHERE ta.event_id=e.id AND ta.withdrawn_at IS NOT NULL
  ORDER BY ta.withdrawn_at DESC,ta.id LIMIT 1) AS withdrawal
WHERE e.status='withdrawn'
ORDER BY withdrawal.withdrawn_at DESC;
```

**What each source published that raised nothing, and why** — the query in the incident response
above, grouped by day, source, decision and reason.

### Analytics API

The three statements above are the base of `src/services/analytics-archive.ts`, which serves them
and five further slices behind operator Basic auth on `/ops/api/analytics/*`. Pinned by
`tests/integration/analytics-archive.test.ts` and `tests/integration/analytics-routes.test.ts`.

| Endpoint | Question it answers |
| --- | --- |
| `coverage` | Which classifier versions exist, over what span. **Ask this first** — it decides which windows can be compared. |
| `threat-dynamics` | Threat classes over time, overall and per oblast. |
| `strike-composition` | What waves are made of (`candidate_threat_types`), launch-side indicators, national-warning share. |
| `geography-shift` | Which oblasts rise and which fall against the immediately preceding window. |
| `loss-points` | Where threats are taken back: by oblast, source and class, plus the interception **rate** and how long claims stood. |
| `sources` | Who reports first, who repeats, whose messages the classifier fails to read. |
| `classifier-versions` | Two versions over the messages both judged: agreement rate and the decision migration matrix. |
| `overview` / `narrative` | All of the above for one window; `narrative` adds a written conclusion. |

Common query parameters: `from`, `to` (ISO), `bucket` (`day|week|month`), `version` (repeatable or
comma-separated), `threatType`, `oblast`, `limit`. `classifier-versions` also needs `baseline` and
`candidate`.

Three properties to rely on:

- **Every window is bounded.** Defaults to the last 30 days, hard maximum 400 days; a longer request
  is rejected with `window_too_long` rather than turned into a scan of the whole archive. Measured on
  300 000 classifications and 100 000 assertions: `overview` runs in 0.36 s over 30 days and 1.5 s
  over 400, against a 15-second `statement_timeout`.
- **Every series is split by `classifier_version`, and says when that is not enough.** Each response
  carries `versionSafety`: `versionsInWindow`, `comparable` (a *period-over-period* reading is
  version-safe only when one version covers both halves), and `unattributed` for rows whose version
  could not be established — those are reported as `classifierVersion: null`, never folded into a
  version. `geography-shift` refuses to call a mixed-version comparison comparable and names both
  halves' versions in a note. **Never sum rows across versions**: the same night judged twice would be
  counted twice.
- **No model is involved in any number.** `narrative` writes prose over already-computed aggregates
  and is off unless `ANALYTICS_NARRATIVE_ENABLED=true`. A narrative that states a figure the
  aggregates do not support is discarded, the run is recorded in `ai_runs` with
  `error='ungrounded_number:…'`, and the deterministic text is returned with the same numbers.

## Backups

The backup container creates a custom-format archive, validates it with `pg_restore --list`, and writes a SHA-256 sidecar. Retention defaults to 14 days.

Perform a real isolated restore test after material schema changes:

```bash
docker compose exec -T backup sh /usr/local/bin/restore-test.sh /backups/threatlens-TIMESTAMP.dump
```

Production backups must additionally be encrypted and copied to independent object storage. That storage account is an external setup task.

## Incident responses

- **Official API stale/error:** public site enters degraded state; do not infer alert end from timeout.
- **Provider died completely while an alert was active — the alert stays active indefinitely.** This
  is a designed boundary, not a hang. Alert state is only ever re-evaluated *by a poll*: there is no
  separate expiry timer. A provider whose requests all fail produces no snapshot, so its
  `alert_source_states` rows freeze in their last state — `active=true` — and the aggregate keeps
  seeing a source that holds the alert. Holding a stale alert is deliberately preferred to announcing
  an all-clear nobody confirmed. (A provider that *does* answer but stops listing the alert is the
  normal case and self-heals: the debounce window runs out and the next poll ends the alert.)

  How to see it: `/api/v1/sources/health` and `/ops` show the source as `error` or `stale` while
  `/api/v1/alerts` still lists alerts. Confirm which alerts are held open by which source:

  ```bash
  docker compose exec -T postgres psql -U threatlens -d threatlens -c "
    SELECT p.location_id, p.alert_type, p.started_at,
           s.source_id, s.active, s.missing_since, s.last_seen_at, src.health_status
    FROM alert_periods p
    JOIN alert_source_states s ON s.location_id=p.location_id AND s.alert_type=p.alert_type
    JOIN sources src ON src.id=s.source_id
    WHERE p.status='active' ORDER BY p.started_at"
  ```

  A row with `active=true`, a `last_seen_at` that stopped advancing and `health_status='error'` is a
  frozen holder. Response, in order:

  1. Fix the provider — token, quota, upstream outage. The first successful poll reconciles the alert
     through the normal path, either confirming it or starting its debounce window.
  2. If the outage will be long and another official source is already clear, mark the frozen rows as
     missing so the surviving source's next poll can end the alert:
     `UPDATE alert_source_states SET active=false, missing_since=now()-interval '1 hour' WHERE source_id='…';`
     This still goes through the reconciler, so `ended_at`, `alert.ended` and the subscriber
     notification stay consistent. It only takes effect when some source still polls that location.
  3. Never edit `alert_periods` by hand: the map, the timeline and the monthly analytics all read it,
     and a hand-closed period emits no `alert.ended`, so subscribers are never told.

  Lowering `ALERT_END_DEBOUNCE_SECONDS` does not help in this scenario — with no polls, nothing
  re-evaluates. If *every* official source is down the site is in its documented degraded state and
  the alert layer must be presented as stale, not as current.
- **Community aerial mirror has silently dropped back to oblast granularity.** The source reads
  `?source=ual&raw` for raion- and hromada-level alerts and falls back to the aggregated oblast feed
  when that payload cannot be used. Falling back is the adapter working, so **`health_status` stays
  `current`** and nothing else makes it visible. The signal is the metric:

  ```promql
  rate(threatlens_aerial_mirror_polls_total{mode="unified_fallback"}[15m])   # should be ~0
  threatlens_aerial_mirror_raw_regions                                       # by level; District > 0 on any busy night
  ```

  `mode` is one of `raw` (healthy steady state), `raw_quiet` (raw feed empty and the aggregated feed
  agrees the country is calm), `unified_fallback` (raw feed unusable) and `unified_only`
  (`AERIAL_MIRROR_RAW_SOURCE` is empty, so the passthrough is switched off by configuration). The
  accompanying log line carries the reason:

  ```
  aerial mirror raw feed unusable, falling back to the aggregated oblast feed for this poll
  ```

  What to do:
  1. **Read the `reason` field.** `raw feed reported no air-raid region while the aggregated feed
     reports N` means the upstream is answering but empty — the quiet-versus-broken cross-check
     caught it. Anything else (`carries no raw array`, `no readable entries`, `Aerial alert mirror
     5xx`) means the passthrough itself is failing.
  2. **Check the passthrough by hand — one request, not a loop.** Two requests per second per host is
     the published limit and a burst is answered with a truncated body:

     ```bash
     curl -s 'https://ubilling.net.ua/aerialalerts/?source=ual&raw' | head -c 300
     ```

     Expect `{"source":"ukrainealarm.com API","cachedat":"…","raw":[…]}`, `cachedat` within seconds
     of now in Kyiv local time, and `raw` entries carrying `regionType` and `activeAlerts`.
  3. **If the upstream has reshaped its body**, set `AERIAL_MIRROR_RAW_SOURCE=` (empty) and redeploy.
     That is a full retreat to the oblast-only path this source shipped with — one request per poll,
     twenty-five oblast rows — not a degraded mode, and it is the intended response while the adapter
     is updated. `ual` is the only probed upstream that publishes below oblast level, so naming a
     different one (`klimenko`, `skog`) buys granularity back only if that has changed.
  4. **A `provider locations could not be mapped` warning naming this source is now expected in small
     numbers and is not an outage.** The label space is every raion and hromada in the country, and a
     hromada whose name exists in two raions is deliberately resolved to nothing — raising the wrong
     raion is worse than raising none. What matters is the trend: a jump means the KATOTTG catalogue
     sync is behind, or a raion has been renamed (see `migrations/026_renamed_toponym_aliases.sql`
     for the fix shape). Confirm the catalogue actually has the raion tier at all:

     ```bash
     docker compose exec -T postgres psql -U threatlens -d threatlens -c "
       SELECT type, count(*) FROM locations GROUP BY type ORDER BY 1"   # expect ~136 raions
     ```

     A database that has never run the KATOTTG sync carries two raion rows, and every District label
     will be unresolved.
- **Community aerial mirror stale or down (`aerial-alerts-mirror` shows `error`).** Read
  `last_error` first, because the two failures need opposite reactions:

  ```bash
  docker compose exec -T postgres psql -U threatlens -d threatlens -c "
    SELECT health_status, last_success_at, last_error_at, last_error
    FROM sources WHERE id='aerial-alerts-mirror'"
  ```

  An `error` on this source now means **both** feeds failed in the same poll: the raw passthrough was
  unusable *and* the aggregated feed it fell back to could not be read either. A single-feed failure
  is a fallback, not an error — see the entry above.

  - `aerial mirror is stale: cachedat … is N s old` — **the safety gate fired and it did its job.**
    The mirror answered, but its own cache stamp says the process feeding it has stopped. The poll was
    refused *before* anything was written, so the alerts this source was holding are still held and
    nothing was cleared. That is the designed outcome: a frozen mirror serving `alertnow: false` for
    all twenty-five regions would otherwise publish «Офіційний відбій» for the whole country. Do not
    "fix" it by raising `AERIAL_MIRROR_STALE_SECONDS` — that only widens the window in which a dead
    mirror is believed.
  - `Aerial alert mirror 429` / `5xx` / a fetch timeout — transport, not freshness. 429 is unexpected:
    the published limit is two requests per second per host and we poll every fifteen, so a 429 means
    the egress IP is shared with something else that is hammering the endpoint. Note that a poll which
    needs the cross-check makes two requests, sequenced `AERIAL_MIRROR_REQUEST_GAP_MS` apart; do not
    set that to 0 in production.
  - ``carries no `states` object`` / `no readable regions` — a truncated or reshaped body from the
    *aggregated* feed. If it persists, the feed's schema has changed and the adapter needs updating;
    the source stays in `error` and holds its alerts until it does.

  Check both feeds by hand before doing anything else — one request each, spaced, not a loop:

  ```bash
  curl -s https://ubilling.net.ua/aerialalerts/ | head -c 200   # `cachedat` should be within seconds of now, in Kyiv local time
  sleep 1
  curl -s 'https://ubilling.net.ua/aerialalerts/?source=ual&raw' | head -c 200
  ```

  Recovery, in order:

  1. **Wait, if anything else still polls.** The mirror self-heals: the first fresh response
     reconciles every region through the normal path and the map corrects itself.
  2. **If it will be down for a long time**, treat it exactly like any other frozen holder — the
     «Provider died completely» procedure above applies unchanged, including its `UPDATE
     alert_source_states … missing_since=now()-interval '1 hour'` step with
     `source_id='aerial-alerts-mirror'`. Note the caveat stated there: that step only takes effect
     when some source still polls those locations, so if the mirror is the *only* live alert source
     the alerts stay up until it returns. Over-warning is the deliberate failure direction here.
  3. **To switch it off**, set `AERIAL_MIRROR_ENABLED=false` and redeploy. This stops the source being
     **read**; it does **not** withdraw what it was holding — there is no sweeper for this adapter
     type (`expireStuckAlertChannelAlerts` covers `mtproto_alert_channel` rows only). If you want the
     holds released as well, run step 2 in the same maintenance window, before or after the redeploy.

  One more signal worth watching: a `provider locations could not be mapped to the local location
  catalogue` warning naming this source means the feed has relabelled or added a region. It is a
  catalogue gap, not an outage — the rest of the snapshot still applied and the source stays healthy —
  but that region's alerts are invisible until an alias is added. Since the granularity upgrade this
  warning names raions and hromadas, not only oblasts; see the entry above for how to read it.

  Note what an `error` on this source no longer means: it is **not** raised when only the raw
  passthrough fails. Two feeds have to fail in the same poll. If the map has gone coarse but the
  health card is green, you are looking at a fallback, and the runbook entry above is the right one.
- **Stuck alert on the official channel source (`threatlens_alert_channel_stuck_alerts_total > 0`).**
  The channel is event-driven: an alert ends only when a 🟢 message names its location. If such a
  message is never published, is edited away, or arrives in a shape the parser refuses, the location
  keeps its alert indefinitely. `ALERT_CHANNEL_MAX_ALERT_SECONDS` (default 86400) is the backstop
  that clears it and increments the counter, and the accompanying `warn` log names the location and
  its start time.

  A non-zero counter means a 🟢 was genuinely lost — treat it as a parser defect report, not as
  routine noise. The counter and the log carry the `source` label, so start from the channel it names:
  `SELECT public_url FROM sources WHERE id='…'`, open `https://t.me/s/<handle>`, find the all-clear
  for that location and compare it against `src/domain/alert-parser.ts`. The channels publish partial
  all-clears (🟡) carrying a "тривога ще триває у:" / "повітряна тривога досі триває у:" addendum,
  threat stand-downs (`Відбій загрози`, `Відбій по кабам`) that must never end an air raid, and
  occasional typo headlines. A new wording variant belongs in the parser with a fixture from that
  specific channel, not in a lowered threshold.

  **The addendum is the trap.** @air_alert_ua attaches the identical "тривога ще триває у:" list to
  its per-oblast threat commentary, so a stand-down there looks like a partial all-clear that lost
  its location — `🟡 20:53 Відбій`, `🟡 10:23 Відбій по кабам`, `🟡 15:51 к` and `🟡 05:01 е` were all
  published under #Донецька_область over one 48-hour window, each over the same list of all eight
  raions. A bare `Відбій` is the elided form of `Відбій по кабам`, not a shortened all-clear: read
  the 🟠 posts in the half hour before it and the real `🟢 … Відбій тривоги в` that follows, and the
  pairing is unambiguous. These are pinned as negative fixtures in `src/domain/alert-parser.test.ts`
  precisely so that a stuck-alert investigation does not "fix" them into all-clears.

  If the channel's whole format has moved rather than one message, the correct response is
  `UPDATE sources SET enabled=false WHERE id='…'` — the backstop keeps sweeping disabled rows, so
  switching a channel off releases what it was holding instead of stranding it.

  **Never lower `ALERT_CHANNEL_MAX_ALERT_SECONDS` toward a realistic alert duration.** The bound sits
  above the longest plausible real alert on purpose — overnight mass-attack alerts run 8–11 hours and
  frontline raions hold much of a day. Tuning it down converts a defect detector into a generator of
  false "Офіційний відбій" messages, which is the failure this system is built to avoid.
- **MTProto collector in flood wait (`threatlens_telegram_flood_waits_total > 0`, `/health/ready` 503
  with `reason=collector_flood_wait`).** Telegram has told the account to stop making a class of
  request for a named number of seconds, and the collector is sitting the interval out. It issues
  **nothing** in the meantime — that is the fix, not the symptom: the previous behaviour retried the
  whole channel list on every incoming update and never got out of the wait.

  What to check, in order:

  ```bash
  # The state itself: which phase hit the wait, when it ends, how many channels are bound.
  docker compose exec -T app curl -sS http://localhost:3000/health/ready | jq .collector

  # What the collector has been doing. One line per pass; there is no per-message logging here.
  docker compose logs app | grep -E 'MTProto collector (handlers ready|has no live channels)|flood wait'

  # Whether anything is still arriving.
  docker compose exec -T postgres psql -U threatlens -d threatlens -c "
    SELECT source_id, max(received_at) AS newest, count(*) FILTER (WHERE received_at > now()-interval '1 hour') AS last_hour
    FROM source_messages GROUP BY source_id ORDER BY newest DESC NULLS LAST LIMIT 20"
  ```

  `collector.floodWaitUntil` is when the single armed retry fires. **Do not restart the container to
  hurry it**: a restart re-runs the startup pass immediately, which is exactly the request Telegram
  refused, and each refusal can extend the interval. Wait it out; the retry re-runs by itself and the
  sources return to `current` through the normal `markSourceSuccess` path (`source.recovered` rows in
  `system_event_log` record it).

  `collector.floodWaitSeconds` above a few thousand usually means the session has been rate-limited
  at the account level rather than for one request. Short waits never reach this state at all — the
  library sleeps anything at or below `floodSleepThreshold` (60 s) itself.
- **MTProto collector `degraded`: some handles are not bound.** `/health/ready` stays 200 — the
  handlers are live and the bound channels are being collected — and `collector.unresolved` names the
  handles that are not. Each one's `sources` row is marked `error` with the reason, so
  `/api/v1/sources/health` and `/ops` show it individually. Almost always one of three things:

  1. **The account is not subscribed to the channel.** The collector receives updates only for
     dialogs its account is in, so an unsubscribed handle can never deliver a message however
     correctly it is spelled. Join it with the collector account, then wait for the retry (10 minutes)
     or restart.
  2. **The handle in `sources.telegram_username` is wrong or the channel renamed.** Open
     `https://t.me/<handle>`; fix the row rather than the code.
  3. **The channel became private or was deleted.** `UPDATE sources SET enabled=false WHERE id='…'`
     — a permanently unreachable row otherwise reports `error` for ever.

  A `degraded` collector never silently downgrades an alert channel: an unbound Tier A handle is a
  source that stops holding its alerts, which the aggregate treats as one fewer official source.
- **Telegram 403:** the user is disabled automatically; queued messages stop.
- **Telegram 429:** delivery uses the provider `retry_after` value.
- **AI invalid/timeout:** failure is recorded and deterministic fallback is used.
- **Unknown provider location:** an unmapped provider location is a catalogue gap, not a source outage. Locations that did resolve are persisted normally, the source stays `current`, and the unmapped names are counted and logged (`unresolvedLocationReports()`) instead of being guessed at. The source is only marked `error` when the response contained alerts and **none** of them could be mapped — the snapshot is then refused whole rather than applied partially.
- **Reclaimed notifications:** a row left in `sending` for more than 300 seconds is returned to `retry` on the next delivery pass, or marked `failed` once it has used all 8 attempts. The pass logs `reclaimed notifications stuck in sending` with a count; a non-zero count on every pass means delivery is crashing mid-batch.
- **Occupation layer stale or empty:** `/api/v1/occupation` never returns 5xx. An empty collection with `stale: true` means the source is switched off, no revision has been stored yet, or the database was unreachable. Check `threatlens_occupation_sync_total` and `threatlens_occupation_unknown_status_keys_total`; a rising unknown-key counter means upstream introduced a status key this build rejects by design, and it needs a code review before it can be rendered.
- **A threat disappeared from the map and no timer had run out.** It was withdrawn: some source that
  had asserted it published a stand-down and it was the last one holding the event. The audit trail
  is complete — `system_event_log` carries a `threat.withdrawn` row naming the source, `event_updates`
  carries `reason='last_source_assertion_withdrawn'`, and `threat_assertions` shows who claimed what
  and when each claim was closed.

  ```bash
  docker compose exec -T postgres psql -U threatlens -d threatlens -c "
    SELECT ta.source_id, ta.location_id, ta.threat_type, ta.asserted_at, ta.withdrawn_at,
           ta.withdrawal_reason, e.status
    FROM threat_assertions ta JOIN threat_events e ON e.id=ta.event_id
    WHERE e.id='<event-uuid>' ORDER BY ta.asserted_at"
  ```

  What this is **not** is an official all-clear. A withdrawal moves `threat_events` only; no monitored
  channel can touch `alert_source_states` or `alert_periods`. If an air-raid alert also ended, that
  came from a tier A source and has its own `alert.ended` row.

  A withdrawal that looks wrong is a classifier defect, not a state defect: find the message in
  `message_classifications` (`decision='de_escalation'`) with its `retraction_coverage` and
  `retracted_threat_types`, and fix the rule in `src/domain/classifier.ts` with a test. Raise
  `CLASSIFIER_VERSION` when you do. Never repair state by editing `threat_assertions` by hand — the
  event log and the notification fanout will not see it.
- **A source keeps standing down threats it never reported.** `withdrawn_assertions = 0` on its
  `de_escalation` rows. Harmless by construction — a withdrawal only ever matches its own source's
  rows — but a channel that does it constantly is usually one whose *assertions* are not being
  recognised, so look at its `ignored`/`unrecognized` share next:

  ```bash
  docker compose exec -T postgres psql -U threatlens -d threatlens -c "
    SELECT date_trunc('day', published_at AT TIME ZONE 'Europe/Kyiv')::date AS day,
           source_id, decision, COALESCE(ignored_reason,'(none)') AS reason, count(*)
    FROM message_classifications
    WHERE published_at > now() - interval '7 days'
    GROUP BY 1,2,3,4 ORDER BY 1 DESC, 5 DESC"
  ```

  `no_location` dominating one source means its place names are missing from the catalogue;
  `not_an_assertion` dominating one means the vocabulary has drifted and the patterns need widening.
- **`threatlens_classification_log_failures_total > 0`.** The classification archive has holes and
  any count taken from it is a lower bound. Ingestion is unaffected by design — the archive write is
  outside the ingestion transaction and its failure is deliberately swallowed — so this is a data
  quality alert, not an outage. The accompanying `warn` line names the source and the decision.
- **The deployment was left in `delayed_15s`.** The public site is holding every appearance back by
  fifteen seconds and nobody meant it to. This is a configuration state, not a fault, and it has no
  self-healing path: the mode is stored, so it survives restarts and redeploys.

  How to see it without opening the site: `threatlens_publication_mode{mode="delayed_15s"}` is `1`,
  and `threatlens_publication_lag_seconds` is nonzero on every scrape. In the browser the status
  strip reads «ЗАТРИМКА 15 С» and `#last-update` carries «зріз о …». In `/ops` the «Публікація та
  аналітика» card shows the amber «Затримка 15 с» pill.

  ```bash
  curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/ops/api/runtime
  curl -fsS -u "$OPS_USER:$OPS_PASSWORD" -X PUT -H 'Content-Type: application/json' \
    -d '{"publicationMode":"live"}' http://localhost:3000/ops/api/runtime
  ```

  The `audit` array in that response answers who set it and when — one row per changed field, with
  the previous and new values — so «хто ввімкнув затримку» is a lookup rather than an argument.
  Releasing the hold takes effect within a second or two: the settings memo is primed by the write
  and its TTL is two seconds. **Never** clear it by editing `runtime_settings` by hand; the audit
  trail and the `publication.changed` event both come from the endpoint, and a hand-edited row leaves
  the ops console and the map disagreeing about what happened. What did *not* happen while the hold
  was on: nothing was lost. Collection, classification and the alert reconciler ran at wall clock,
  Telegram subscribers were notified on time, and the backlog drains as soon as the mode is `live`.
- **Recompute storm, or the debounce collapsed.** Symptom: `threatlens_analytics_recompute_total`
  climbing steeply, `threatlens_analytics_recompute_duration_seconds` widening, and the pool visibly
  contended — the 15-second ingestion tick, the one-second event poll and every snapshot share twelve
  connections under a 15-second `statement_timeout`, and a `REFRESH MATERIALIZED VIEW CONCURRENTLY`
  that exceeds the timeout dies, counts as `view_refresh_failed`, and is retried at floor cadence.

  A recompute storm is also the case in which model spend rises, on a deployment where `AI_*` is
  configured: the risk leg calls that model once per `(location, threat_type)` group. It is bounded
  to one pass per fifteen minutes plus the manual button, so cadence alone cannot run it away — but
  the levers below are the ones that govern it, and there is no separate knob.

  Read the outcome label before changing anything — the counter is split for exactly this:

  ```bash
  curl -fsS -u "$OPS_USER:$OPS_PASSWORD" http://localhost:3000/metrics \
    | grep threatlens_analytics_recompute_total
  ```

  - `outcome="ok"` rising at more than one per minute is impossible; the interval guard forbids it.
    If it looks that way, two application replicas are running, each with its own in-process
    debounce. That is the documented single-replica boundary, not a tuning problem.
  - `outcome="skipped_interval"` rising is **the guard working, not a defect**. Events are arriving
    faster than one completed pass per minute and the surplus is being refused. Rising
    `skipped_interval` with a healthy `ok` series is a busy night, and the correct response is none.
  - `outcome="failed"` rising means the passes themselves are dying — look at the `statement_timeout`
    and at the risk leg before touching cadence. A pass counted here wrote no `analytics.updated`
    row, so the map's аналітична оцінка is standing still on this path and only the legacy
    fifteen-minute `startRiskScheduler` is still moving it.
  - `outcome="view_refresh_failed"` rising is **narrower than `failed` and much less serious**: the
    monthly materialised views did not refresh, and the rest of the pass — the risk leg, the Codex
    leg, the `analytics.updated` row — completed. Both views aggregate by month, so the visible cost
    is a stale month bucket in the archive, not a stale map. Look at the `statement_timeout` and at
    `refreshMonthlyAnalytics`; the pg error is on the log line beside the counter. The retry is at
    floor cadence, so this can rise at most four times an hour per trigger.
  - `outcome="skipped_overlap"` rising means passes are taking longer than the window they are armed
    in; raise `analyticsDebounceMs`, do not lower it.

  Response: raise `analyticsDebounceMs` (and `analyticsMaxDelayMs` with it — the API refuses a max
  delay below the debounce), or switch `analyticsEventDriven` off and let the fifteen-minute floor
  carry the load. `ANALYTICS_EVENT_DRIVEN_ENABLED=false` in `.env` is the deployment-level version of
  the same decision, for when the database is the thing that is unwell.

  **Lowering the debounce is the wrong instinct and the guard is why it is survivable.**
  `ANALYTICS_MIN_PASS_INTERVAL_MS` is compiled in at 60 seconds and is not settable from `/ops`
  precisely so that an operator responding to «аналітика відстає» cannot convert one PUT into a
  standing pair of concurrent view refreshes plus a full risk pass every few seconds. Sixty seconds
  is still fifteen times faster than the timer this replaced.

  A related report that is not an incident at all: **a burst that lands shortly after a completed
  pass arms no retry.** Its debounce window opens and closes normally, but the pass it fires would
  start less than a minute after the previous one finished, so the interval guard refuses it and
  counts `skipped_interval`. By then the window has been consumed and there is nothing left to
  re-arm: the next trigger is a further event, or the fifteen-minute floor. With the default
  twenty-second debounce that is any burst whose last event lands inside roughly the first forty
  seconds. A refused pass deliberately does **not** stamp the completed-pass clock — otherwise a
  steady stream one debounce apart would refuse itself forever — so the guard cannot compound.

  An operator seeing «аналітика відстає» within a minute of a pass is therefore watching the
  minimum-interval guard do its job, not a defect. Nothing on the alerting path waits with it: alerts,
  threat events, the map and the notifications are unaffected, and only the analytical assessment is
  a minute behind what a debounce alone would have produced.
- **`threatlens_publication_settings_read_failures_total > 0`.** The runtime settings row could not be
  read, or it contained a `publication_mode` this build does not recognise. Both fail **open to
  `live`**, which is the safe direction — a failure that quietly held the public view back would be
  invisible — so this is a data-quality alert rather than an outage: the site is serving, and it is
  serving without a hold.

  Two distinct causes, and the counter does not separate them:

  ```bash
  docker compose exec -T postgres psql -U threatlens -d threatlens -c \
    "SELECT publication_mode, mode_changed_at, updated_at, updated_by FROM runtime_settings"
  ```

  A mode outside `live` / `delayed_15s` is impossible through the CHECK constraint, so seeing one
  means the constraint is gone — dropped by hand, or absent from a dump restored from before it
  existed. Restore the constraint, then set the mode through `PUT /ops/api/runtime` so the audit row
  and the `publication.changed` event exist. If the row is fine, the read itself is failing
  — a pool exhausted, a database still finishing recovery — and the counter will be accompanied by
  the usual connection errors. The memo clears its slot on a rejection rather than caching the
  default, so the next caller retries instead of being pinned to `live` for a whole TTL.

  One consequence worth knowing during a restart: the SSE hub refuses to initialise its cursor on a
  degraded settings read and simply retries on the next tick. That is deliberate — initialising to
  the unbounded head while the stored mode is `delayed_15s` would permanently drop everything written
  in the last few seconds before the restart — so a short burst of this counter at boot means the
  stream started a second late, not that anything was lost.
- **Comparing two periods of analytics.** Always split by `classifier_version` or state that you did
  not. A version bump changes what the same message means, and an unsplit comparison reports a change
  in this project's rules as a change in enemy behaviour.
- **A deployment ended in `failed`.** Every stage transition is in `deployment_runs` /
  `deployment_run_events`, and the tail of the failing command is in `log_tail`. The per-`error_code`
  response table is in "Deployment from /ops" above; the three worth repeating here are
  `migration_failed` (the **good** failure — the old container is still serving, fix the migration
  and press again), `ready_commit_mismatch` (the recreate did not happen; `/health/ready` is
  answering from the previous image, so `docker compose up -d --force-recreate app` on the host) and
  `runner_lost` (the runner process died mid-run; the next runner start reclaims the row, and whether
  the update landed is answered by comparing `/health/live`'s `commit` with `origin/main`).

  A run that appears stuck is distinguished from a dead one by `heartbeat_at`, refreshed every ten
  seconds. A non-terminal row whose heartbeat is minutes old is an abandoned run and is reclaimed the
  next time a runner takes the lock — including at runner start, so `docker compose restart deployer`
  is the fastest way to resolve one.
- **`pending_manual_services` is non-empty on the last run.** The compose definition of `postgres`,
  `backup` or `deployer` changed and the update deliberately did not restart it — postgres holds the
  journal a run needs in order to report its own failure, and the runner cannot restart itself. The
  console prints the command; run it during a maintenance window:
  `docker compose -p threatlens up -d <services>`. Ignoring it is safe but means the running
  container no longer matches the file, which is exactly the drift the probe exists to surface.
- **`threatlens_notifications_suppressed_total{reason="expired"} > 0`.** The fanout tried to deliver
  a threat whose validity window had already closed and refused. A small count right after a
  catch-up read is expected — it is the defence-in-depth layer behind the `system_event_log` seam
  doing its job. A count that keeps growing outside a catch-up means the notification worker is more
  than thirty minutes behind the events it is reading: check `worker_state` for
  `notification-fanout`, the outbox backlog in `/ops/api`, and whether delivery is failing rather
  than the events being stale.
- **A source stuck in `failed` in `source_backfill_state`.** One source failing never stops live
  collection, never stops the other sources' catch-up, and never marks the source unhealthy —
  `last_error` and `consecutive_failures` are the whole signal. The exponential guard backs the retry
  off to `MIN_RERUN_SECONDS * min(2^failures, 24)`, i.e. at most once a day, so a poison message is
  bounded rather than a loop. After fixing the cause, clear the guard with the `UPDATE` in "Catch-up
  backfill" above. `truncated` is **not** a failure and needs no response.
- **Edited monitored message:** revision is stored; incompatible previous event is marked corrected.
- **Incorrect channel recommendation:** hide it in `/ops`; public API, site and bot stop returning it immediately.
