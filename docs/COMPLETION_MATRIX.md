# Specification completion matrix

This matrix is the release gate for the initial single-node Docker deployment. `Implemented` means the code path exists and was exercised locally. `External setup` means implementation is present but a human-owned account, token, domain, legal text or infrastructure subscription is intentionally not bundled.

| Requirement | State | Implementation / verification |
|---|---|---|
| One-command Docker start | Implemented | `compose.yaml` starts Caddy, app, PostgreSQL and backup services with health dependencies. A fifth service, `deployer`, is defined but started by hand and only by deployments that opt into operator-controlled updates; every variable it needs has a default, so a stack that never enables it runs every compose command unchanged. |
| PostgreSQL history and migrations | Implemented | Idempotent migrations from `001_init` onwards, applied once each by an advisory-locked runner; `/health/ready` compares the **set** of `*.sql` files shipped in the image against `schema_migrations` and names the difference in its 503, so a container carrying an unapplied migration can never report itself ready — which is what makes the readiness gate usable as the success condition of an update. `tests/integration/migrations.test.ts` pins the applied set against the directory listing. |
| Official alert ingestion | Implemented | Tier A sources — the Ukraine Alarm and Alerts.in.ua APIs plus a registry of official alert Telegram channels (`adapter_type='mtproto_alert_channel'`, twenty-one bodies registered) — feeding per-source state and one aggregate start/end reconciler. For a polled source an alert ends only after every source that held it has been silent for `ALERT_END_DEBOUNCE_SECONDS` (default 60 = four polls), so one missed poll cannot emit a false all-clear. API tokens remain external setup; the channels need none. |
| Official alerts without an API token | Implemented | Every enabled alert channel is read through the MTProto collector, parsed by a pure function (`src/domain/alert-parser.ts`) reading both published word orders, and reconciled event-by-event against **its own** `source_id`: 🔴/🟢 move only the raions a message names, one body's all-clear cannot end another's alert, an explicit all-clear skips the polled-source debounce, out-of-order messages are refused via `alert_source_states.last_event_at`, and a missing all-clear is bounded by `ALERT_CHANNEL_MAX_ALERT_SECONDS` (default 24 h) with a warn log and `threatlens_alert_channel_stuck_alerts_total`. `sources.enabled` gates collection: it asserts that the parser has been shown that channel's wording as a fixture. |
| Public-channel monitoring | Implemented | Telegram MTProto collector handles new and edited messages for the Air Force channel, the OSINT monitors and every enabled alert channel, routing each handle by registry `kind` rather than by name comparison, and re-reads a bounded, order-folded history window per channel after a reconnect. API credentials/session remain external setup. |
| Threat normalization | Implemented | UAV, ballistic/cruise missile, KAB, aviation, MLRS, artillery, mortar and combined classifications. |
| Evidence and provenance | Implemented | Source tier, independence group, raw message, URL, revisions, corroboration and non-downgrading evidence. |
| Event lifecycle | Implemented | Deduplication, merge, correction, withdrawal, expiry, update history and SSE event versions. |
| Threat de-escalation | Implemented | `threat_assertions` holds one row per (event, source, location, threat class), mirroring `alert_source_states`; an event lives while any assertion holds and becomes `withdrawn` with a `threat.withdrawn` event log row when the last one is taken back. A withdrawal is scoped `WHERE source_id = …`, so it never touches another publisher's claim and a source that never asserted changes nothing; `coverage: 'unspecified'` closes every claim of that one source; a redirect withdraws for the place passed and asserts for the place approached. Validity is recomputed as the maximum the survivors support and risk signals decay by expiry, never by a negative contribution. Evidence level is untouched, and no path reaches `alert_source_states` or `alert_periods`. Pinned by `tests/integration/threat-withdrawal.test.ts`. |
| Classification archive | Implemented | `message_classifications` records one row per classifier decision — created, merged, redirect, de-escalation, ignored, unrecognised, coalesced — with candidate threat classes, indicators, located relations, national scope, the resulting event and, for a withdrawal, what it retracted and what the source last claimed. Every row carries `CLASSIFIER_VERSION`, and `UNIQUE (source_message_id, classifier_version)` lets a new classifier be replayed over stored history beside the old verdict. The write is outside the ingestion transaction; a failure increments `threatlens_classification_log_failures_total` instead of failing ingestion. Pinned by `tests/integration/classification-archive.test.ts`, which executes the three analytical queries in docs/OPERATIONS.md. |
| City and oblast coverage | Implemented | Weekly official KATOTTG synchronization; verified import of 461 cities plus oblast/special-city hierarchy. |
| No invented map trajectories | Implemented | Only reported geometry/direction is rendered; details explicitly state that geometry is not a forecast. The territory aggregate extends the rule from geometry to *claims*: an icon is emitted only for a territory a source literally named or for the nearest outline-bearing ancestor of a named place that has none, a `mentioned` relation produces a panel row and no glyph, and an analytical pair carried by more than twenty territories in one snapshot produces no glyphs at all. Icons are never arrows. Pinned by `src/domain/territory-state.test.ts`, including `'a national-scope posture never produces 27 icon stacks'` and `'a mentioned-only location gets no threat polygon and no icon'`. |
| Explainable six-hour risk index | Implemented | Time decay, source guardrails, independent-source limits, versioned methodology, factors and supporting signals. Recomputation is now event-driven: `src/services/analytics-scheduler.ts` arms a pass from the recorded event feed behind an operator-set debounce, bounded by a maximum delay and by a compiled-in sixty-second minimum between completed passes, with the fifteen-minute timer kept as the floor and an on-demand `POST /ops/api/analytics/recalculate`. Every skip is attributable — `threatlens_analytics_recompute_total{outcome="skipped_overlap"|"skipped_interval"|"skipped_disabled"|"view_refresh_failed"|"failed"|"ok"}`. |
| Optional AI assessment | Implemented | Validated structured output, timeout/error audit and deterministic fallback. Endpoint credentials remain external setup. |
| Safe risk wording | Implemented | Percentage is labelled indicative and non-statistical; alert, threat event and assessment are distinct types. |
| Nightly 23:20 digest | Implemented | Europe/Kyiv scheduler, one digest per user/date, bounded aggregation and outbox idempotency. |
| Telegram user flow | Implemented | `/start`, `/city`, `/status`, `/analytics`, `/settings`, `/stop`, `/delete_me`, `/help`. Bot token remains external setup. |
| Subscription filters | Implemented | Multiple territories, city/oblast hierarchy, evidence threshold, threat and analytics switches. |
| Reliable bot delivery | Implemented | PostgreSQL outbox, event-version idempotency, retry/backoff, Telegram `retry_after`, blocked-user handling. |
| Static responsive website | Implemented | HTML/CSS/bundled JS client with snapshot API and SSE; no server rendering framework. |
| Interactive Ukraine map | Implemented | MapLibre layers, explicit freshness, layer controls, event details and map fit control. Territories now carry one aggregated state each rather than alert fill plus loose point markers: four independent state families (official alert, asserted threat, confirmed consequences, analytical contour) written through feature-state on the existing oblast and raion geometry, with coverage stated as `direct` / `unmapped` / `partial` so a muted polygon never reads as an assertion about the whole. Clicking a territory opens a panel listing its alerts, threats and assessment with per-item click-through. `src/domain/territory-state.ts` computes it with no database, no configuration and no clock of its own. |
| Per-territory aggregated map state | Implemented | `snapshot.territories[]` carries one entry per oblast, special city and raion referenced by the slice. National-scope warnings produce no territory and no polygon — they are a caption, an event card and a bot message, never 27 lit oblasts. A territory whose location has no outline in the browser is re-climbed client-side to the nearest ancestor that does, so a raion-only threat cannot vanish when the ADM2 file is slow. Pinned by `src/domain/territory-state.test.ts` and `tests/integration/territory-snapshot.test.ts`. |
| Threat icon catalogue | Implemented | Ten weapon-class glyphs in four tones (consequence, confirmed, reported, analytic), ranked by danger class, evidence, relation and freshness bucket, three slots per territory with a `+N` badge for what ranking cut. Paths, labels and tones live in `src/domain/threat-icons.ts` and are rasterised in the browser from the same table, with a test importing the module at runtime so the two copies cannot drift. The stack is a separate point source, kept out of every layer-toggle group and off the polygon layers, so the feature-state contract above is unaffected. |
| Crimea and Sevastopol sovereignty context | Implemented | Pinned UKR ADM0/ADM1 overlays render above the basemap; Crimea and Sevastopol are explicitly marked as Ukraine. |
| Temporarily occupied territories layer | Implemented | DeepStateMap sync behind `OCCUPATION_SOURCE_ENABLED`, status-key allowlist, border clipping, revision history in `occupation_snapshots`, cached `/api/v1/occupation` endpoint and rejection metrics. Reference context only: it feeds no alert, threat or risk path. |
| Occupation data licence | Implemented for personal use | DeepStateMap data is not under an open licence. Attribution is emitted in every response and the source is switchable off with one flag. The product owner runs the project personally, which needs no written permission, so the layer ships enabled. The requirement returns on public distribution and remains owned by the product owner. |
| Territorial click history | Implemented | Oblast polygons and verified city points open combined alert, threat and analytical timelines with a full-history deep link. |
| Phone and TV support | Implemented | Browser-verified at 390x844 and 1920x1080; dedicated `/tv` layout. |
| History and monthly analytics | Implemented | Filterable history; monthly alert duration and threat-message summaries with location filters. |
| Source health and stale state | Implemented | Current/stale/error/recovered/unconfigured states exposed to API and UI. |
| Operations and observability | Implemented | Liveness/readiness, protected ops endpoints, Prometheus metrics and structured logs. The console now also owns publication timing and recompute cadence (`GET`/`PUT /ops/api/runtime`, `POST /ops/api/analytics/recalculate`), every change written to `runtime_settings_audit` as one row per changed field, and a change of mode additionally announced as a `publication.changed` row in the same transaction, so the log can never carry a mode change for a setting that was rolled back. New series: `threatlens_publication_mode`, `threatlens_publication_delay_seconds`, `threatlens_publication_lag_seconds`, `threatlens_publication_backlog_events`, `threatlens_publication_settings_read_failures_total`, `threatlens_sse_delivery_lag_seconds`, `threatlens_ingestion_lag_seconds`, `threatlens_classification_duration_seconds`, `threatlens_channel_errors_total`, `threatlens_analytics_recompute_total`, `threatlens_analytics_recompute_duration_seconds`, `threatlens_codex_cooldown_skips_total`. Runbooks for all three new failure modes are in docs/OPERATIONS.md. |
| Operator-set publication mode | Implemented | `runtime_settings.publication_mode` switches the public presentation between `live` and `delayed_15s`; the hold length is `PUBLICATION_DELAY_SECONDS` (5–60, default 15). One `PublicationSlice` computed in PostgreSQL bounds the snapshot, the SSE stream and every public row endpoint for a request, so version, `generatedAt` and rows always describe the same instant. The cutoff is `GREATEST(now() - delay, mode_changed_at)`, which makes it monotonic across a mode flip; delayed reads report status **as of the cutoff**, so a terminal label is never revealed before the frame that carries it. `live` is byte-identical to a build without the feature. Collection, classification, `alert_periods`, the audit tables, `/ops`, `/metrics`, `/health/*` and the Telegram fan-out are never held — the bot reads the event log through its own `worker_state` cursor, so the exemption is structural. Pinned by `tests/integration/publication-mode.test.ts` and `tests/integration/ops-runtime.test.ts`. |
| Curated Telegram channel catalog | Implemented | Protected operator create/verify/activate/hide controls; public site and `/channels` bot command provide relevant recommendations. |
| Operator-controlled deployment from `/ops` | Implemented | `DEPLOY_ENABLED` (off by default) adds an «Оновлення з main» block showing the running image's commit, `origin/main`, when it was last checked and the outcome of every past run. The application never holds the Docker socket: a separate `deployer` service does, publishes no host port, and executes ONE frozen scenario built from literal argv arrays — remote/clean-tree checks, `git fetch` of `refs/heads/main` only, a refusal if the SHA moved since the operator confirmed it, `compose build app`, the pending migrations run from the new image while the old app still serves, `compose up -d app caddy`, then `/health/ready` polled until it answers 200 **with the deployed commit**. Every transition is written to `deployment_runs`/`deployment_run_events` in PostgreSQL — the one service the scenario never restarts — so the journal and the failing command's redacted `log_tail` survive the restart they describe. Concurrency is closed three ways: a partial unique index over a GENERATED `active_lock`, a session advisory lock whose reacquisition proves a run was abandoned (`runner_lost`), and a heartbeat for display. Refusals that record nothing are exactly three: bad token (401), live run (409), minimum interval (429). Pinned by `src/deployer/{runner,exec,compose-contract}.test.ts` (exact argv sequence, argv byte-identity across operators, no shell), `tests/integration/deploy-runner.test.ts` (journal, 23505, reap, min-interval, migration set difference) and `tests/integration/ops-deploy.test.ts`. New series: `threatlens_deploy_runs`, `_active`, `_last_result`, `_last_success_timestamp_seconds`, `_last_run_duration_seconds`, `_commit_state`, `_last_check_age_seconds`. |
| Catch-up backfill after downtime | Implemented | After an interruption longer than `CLASSIFIER_BACKFILL_MIN_GAP_SECONDS` (3600, floor 300) every enabled classifier Telegram source is read from its own archive cursor — derived from `source_messages`, so the hot path gains no writes and a rerun of the same window computes an empty set before any Telegram call. Bounded by age (6 h), count (300) and pages (5); hitting a bound is `truncated`, a bounded success, not a failure. Replayed messages keep their original `published_at`, `external_id` and provenance and reuse the existing deduplication, classification and decision archive. A message outside its own 30-minute validity window is archived without appending to `system_event_log` — the single trigger for the public map, SSE and Telegram fan-out — so stale history can never surface as a current threat or a notification. Official alert channels are structurally excluded: the port yields classifier routes only. Per-source progress and errors are in `source_backfill_state` and read-only in `/ops`; one source failing stops neither live collection nor the other sources. |
| Security baseline | Implemented | Production fail-fast configuration, auth, rate limit, CSP and browser security headers, sanitized errors. |
| Privacy controls | Implemented | Minimal Telegram data, stop and cascade deletion. Controller/legal notice remains external setup. |
| Backups and restore | Implemented | Scheduled custom dumps, checksum, archive validation and isolated restore test. Off-site encrypted storage remains external setup. |
| Public deployment | External setup | Domain/DNS, HTTPS host, Telegram registrations (bot plus the MTProto credentials that enable the official alert channel), secrets, monitoring receiver and off-site storage. Official alert API tokens are optional corroboration, no longer a prerequisite. |

| Continuous verification | Implemented | GitHub Actions runs typecheck, lint, the full test suite against a PostgreSQL service container, and the production build on every push and pull request to `main`. |

## Verified release checks

- TypeScript typecheck, ESLint, the production build and both Vitest projects pass: `unit` over pure
  functions with no external services, and `integration` against a live PostgreSQL 18 database. The
  suite is deliberately not quoted here as a number — it grows with every delivery, and a figure in
  this document was stale within one release of being written. `npm test` prints the current count,
  and CI runs both projects on every push and pull request to `main`.
- The integration suite covers subscription fanout (hierarchy in both directions, evidence threshold,
  threat-type filter, opt-out switches, idempotency), official alert reconciliation across two polled
  sources (including the end-debounce window and the identical-restart collision), event-driven
  reconciliation of the official alert channels (per-raion isolation of starts and all-clears, the
  refusal of a partial all-clear that repeats its own raion, out-of-order rejection, backlog folding,
  the maximum-duration backstop, and the isolation between two administrations reporting at once),
  the routing that decides whether a subscribed handle reaches the alert reconciler or the classifier,
  outbox delivery and stuck-message reclaim, and the migration runner.
- Threat de-escalation is pinned on the isolation guarantee rather than on the happy path: a
  withdrawal from one monitor leaves another monitor's assertion standing and the event alive; the
  last withdrawal moves the event to `withdrawn` and appends `threat.withdrawn`; a source that never
  asserted changes nothing; an unscoped "нічого не летить" closes every claim of its own source and
  none of anybody else's; a redirect withdraws for the place passed and asserts for the place
  approached; the withdrawing source's risk signals decay while every other source's stay live; and
  `alert_source_states` and `alert_periods` are byte-identical before and after, including
  `updated_at`.
- The publication gate is pinned on the isolation guarantee rather than on the happy path: an event
  written `now()` is absent from both the snapshot and the stream under `delayed_15s` and present
  exactly once after being backdated past the cutoff; snapshot and stream agree on the same version
  for the same slice; flipping the mode while fifty events are being written leaves the delivered
  `id:` sequence strictly increasing with every version delivered exactly once; an alert that ended
  less than the cutoff ago is still reported as active while one that started less than the cutoff
  ago is absent, in both flip directions; a fresh `alert.started` still produces a notification
  outbox row while the hold is on; `publication.changed` and `analytics.updated` produce none; and
  `EXPLAIN` of the slice statement contains no sequential scan of `system_event_log`.
- The classification archive is verified by executing its three acceptance queries against ingested
  data: events per threat class per oblast per month by classifier version, the "where are threats
  lost" join over `threat_assertions`, and the per-source daily breakdown of messages that raised
  nothing with the reason for each.
- Integration tests never pass silently: without a database they report as skipped with an explicit
  reason, and CI sets `REQUIRE_INTEGRATION_DB=1` so a missing database fails the run.
- Production dependency audit reports zero known vulnerabilities.
- All four containers start; app and PostgreSQL report healthy and readiness returns `ready`.
- The current KATOTTG workbook imports 461 city records and records its SHA-256 checksum.
- Active risk assessments use methodology v2; previous model versions are no longer live.
- Backup checksum and full restore into an isolated temporary database succeed.
- Main, history, analytics, sources, methodology and TV routes render through the running service.
- Event and assessment dialogs expose source provenance, revisions/signals, limits and expiry.
- Caddy serves the app with CSP, HSTS, frame, referrer, permissions and content-type protections.

## Fixed defects

- **False all-clear from a single missed poll, and the snapshot rollback it caused.** The reconciler used
  to end a global alert as soon as the per-source aggregate reported nothing active. Because official
  providers are polled every 15 seconds, one incomplete response or one failed call produced `alert.ended`
  and an "Офіційний відбій" broadcast. The re-report that followed then collided with
  `UNIQUE (location_id, alert_type, started_at)` on `alert_periods` — the reconciler inserts a new period
  from `min(provider_started_at)` — which rolled back the **entire** transaction: every other location in
  that poll lost its update and the source flipped to `health_status='error'`.

  Fixed by `migrations/008_alert_end_debounce.sql` and `src/services/ingestion.ts`:
  `alert_source_states.missing_since` records the first poll in which a source that was holding an alert
  went quiet, and a source counts as still holding the alert while `active=true` **or** `missing_since` is
  younger than `ALERT_END_DEBOUNCE_SECONDS` (default 60 seconds = four polls, floor 30). An alert now ends
  only when every source has been silent about it for the whole window; the two-source rule is unchanged.
  The period insert additionally reopens a colliding period (`ON CONFLICT … DO UPDATE … WHERE status
  <> 'active'`) instead of failing, so the unique index can no longer discard a snapshot, and an active
  alert is never hidden. Pinned by `tests/integration/alert-reconciliation.test.ts`, including the
  blast-radius case (a second location in the same snapshot survives) and source health staying `current`.
  Known boundary: a provider that stops answering entirely produces no polls, so its alerts stay active
  indefinitely — deliberate, with the operator response in `docs/OPERATIONS.md`.

## Known defects

Found by the PostgreSQL integration suite and pinned by a test so the behaviour cannot change unnoticed.
Neither is fixed yet; both are owned outside this document.

- **`002_operational_completion.sql` is not replay-safe on its own.** The migration *runner* is idempotent —
  `schema_migrations` guarantees each file is applied once, and running `npm run migrate` repeatedly is a
  no-op — but the file itself uses `ALTER TABLE … ADD CONSTRAINT`, which PostgreSQL has no
  `IF NOT EXISTS` form for. Re-applying that one file by hand against an already-migrated database fails
  with `constraint "sources_health_status_check" … already exists`. Never replay migration files manually;
  use the runner.
- **Subscription fanout walks exactly one level of the location hierarchy.** Sufficient for the shipped
  two-level catalogue (oblast/special city -> city, which is how KATOTTG rows are attached), but a raion or
  hromada tier inserted between them would silently stop reaching oblast subscribers. Pinned by
  `tests/integration/outbox-fanout.test.ts`.

## Release boundary

The implemented target is a single application replica. Horizontal application scaling requires PostgreSQL advisory-lock leadership for schedulers. This does not block the documented initial Docker deployment.
