# Specification completion matrix

This matrix is the release gate for the initial single-node Docker deployment. `Implemented` means the code path exists and was exercised locally. `External setup` means implementation is present but a human-owned account, token, domain, legal text or infrastructure subscription is intentionally not bundled.

| Requirement | State | Implementation / verification |
|---|---|---|
| One-command Docker start | Implemented | `compose.yaml` starts Caddy, app, PostgreSQL and backup services with health dependencies. |
| PostgreSQL history and migrations | Implemented | Idempotent migrations from `001_init` onwards, applied once each by an advisory-locked runner; `/health/ready` gates on a named migration marker in `src/api/server.ts`, and `tests/integration/migrations.test.ts` pins the applied set. |
| Official alert ingestion | Implemented | Three tier A sources — the Ukraine Alarm and Alerts.in.ua APIs plus the official channel `@air_alert_ua` — feeding per-source state and one aggregate start/end reconciler. For a polled source an alert ends only after every source that held it has been silent for `ALERT_END_DEBOUNCE_SECONDS` (default 60 = four polls), so one missed poll cannot emit a false all-clear. API tokens remain external setup; the channel needs none. |
| Official alerts without an API token | Implemented | `@air_alert_ua` is read through the MTProto collector, parsed by a pure function (`src/domain/alert-parser.ts`) and reconciled event-by-event: 🔴/🟢 move only the raions a message names, an explicit all-clear skips the polled-source debounce, out-of-order messages are refused via `alert_source_states.last_event_at`, and a missing all-clear is bounded by `ALERT_CHANNEL_MAX_ALERT_SECONDS` (default 24 h) with a warn log and `threatlens_alert_channel_stuck_alerts_total`. |
| Public-channel monitoring | Implemented | Telegram MTProto collector handles new and edited messages for both the Air Force channel and the official alert channel, and re-reads a bounded, order-folded history window after a reconnect. API credentials/session remain external setup. |
| Threat normalization | Implemented | UAV, ballistic/cruise missile, KAB, aviation, MLRS, artillery, mortar and combined classifications. |
| Evidence and provenance | Implemented | Source tier, independence group, raw message, URL, revisions, corroboration and non-downgrading evidence. |
| Event lifecycle | Implemented | Deduplication, merge, correction, withdrawal, expiry, update history and SSE event versions. |
| Threat de-escalation | Implemented | `threat_assertions` holds one row per (event, source, location, threat class), mirroring `alert_source_states`; an event lives while any assertion holds and becomes `withdrawn` with a `threat.withdrawn` event log row when the last one is taken back. A withdrawal is scoped `WHERE source_id = …`, so it never touches another publisher's claim and a source that never asserted changes nothing; `coverage: 'unspecified'` closes every claim of that one source; a redirect withdraws for the place passed and asserts for the place approached. Validity is recomputed as the maximum the survivors support and risk signals decay by expiry, never by a negative contribution. Evidence level is untouched, and no path reaches `alert_source_states` or `alert_periods`. Pinned by `tests/integration/threat-withdrawal.test.ts`. |
| Classification archive | Implemented | `message_classifications` records one row per classifier decision — created, merged, redirect, de-escalation, ignored, unrecognised, coalesced — with candidate threat classes, indicators, located relations, national scope, the resulting event and, for a withdrawal, what it retracted and what the source last claimed. Every row carries `CLASSIFIER_VERSION`, and `UNIQUE (source_message_id, classifier_version)` lets a new classifier be replayed over stored history beside the old verdict. The write is outside the ingestion transaction; a failure increments `threatlens_classification_log_failures_total` instead of failing ingestion. Pinned by `tests/integration/classification-archive.test.ts`, which executes the three analytical queries in docs/OPERATIONS.md. |
| City and oblast coverage | Implemented | Weekly official KATOTTG synchronization; verified import of 461 cities plus oblast/special-city hierarchy. |
| No invented map trajectories | Implemented | Only reported geometry/direction is rendered; details explicitly state that geometry is not a forecast. |
| Explainable six-hour risk index | Implemented | Time decay, source guardrails, independent-source limits, versioned methodology, factors and supporting signals. |
| Optional AI assessment | Implemented | Validated structured output, timeout/error audit and deterministic fallback. Endpoint credentials remain external setup. |
| Safe risk wording | Implemented | Percentage is labelled indicative and non-statistical; alert, threat event and assessment are distinct types. |
| Nightly 23:20 digest | Implemented | Europe/Kyiv scheduler, one digest per user/date, bounded aggregation and outbox idempotency. |
| Telegram user flow | Implemented | `/start`, `/city`, `/status`, `/analytics`, `/settings`, `/stop`, `/delete_me`, `/help`. Bot token remains external setup. |
| Subscription filters | Implemented | Multiple territories, city/oblast hierarchy, evidence threshold, threat and analytics switches. |
| Reliable bot delivery | Implemented | PostgreSQL outbox, event-version idempotency, retry/backoff, Telegram `retry_after`, blocked-user handling. |
| Static responsive website | Implemented | HTML/CSS/bundled JS client with snapshot API and SSE; no server rendering framework. |
| Interactive Ukraine map | Implemented | MapLibre layers, explicit freshness, layer controls, event details and map fit control. |
| Crimea and Sevastopol sovereignty context | Implemented | Pinned UKR ADM0/ADM1 overlays render above the basemap; Crimea and Sevastopol are explicitly marked as Ukraine. |
| Temporarily occupied territories layer | Implemented | DeepStateMap sync behind `OCCUPATION_SOURCE_ENABLED`, status-key allowlist, border clipping, revision history in `occupation_snapshots`, cached `/api/v1/occupation` endpoint and rejection metrics. Reference context only: it feeds no alert, threat or risk path. |
| Occupation data licence | Implemented for personal use | DeepStateMap data is not under an open licence. Attribution is emitted in every response and the source is switchable off with one flag. The product owner runs the project personally, which needs no written permission, so the layer ships enabled. The requirement returns on public distribution and remains owned by the product owner. |
| Territorial click history | Implemented | Oblast polygons and verified city points open combined alert, threat and analytical timelines with a full-history deep link. |
| Phone and TV support | Implemented | Browser-verified at 390x844 and 1920x1080; dedicated `/tv` layout. |
| History and monthly analytics | Implemented | Filterable history; monthly alert duration and threat-message summaries with location filters. |
| Source health and stale state | Implemented | Current/stale/error/recovered/unconfigured states exposed to API and UI. |
| Operations and observability | Implemented | Liveness/readiness, protected ops endpoints, Prometheus metrics and structured logs. |
| Curated Telegram channel catalog | Implemented | Protected operator create/verify/activate/hide controls; public site and `/channels` bot command provide relevant recommendations. |
| Security baseline | Implemented | Production fail-fast configuration, auth, rate limit, CSP and browser security headers, sanitized errors. |
| Privacy controls | Implemented | Minimal Telegram data, stop and cascade deletion. Controller/legal notice remains external setup. |
| Backups and restore | Implemented | Scheduled custom dumps, checksum, archive validation and isolated restore test. Off-site encrypted storage remains external setup. |
| Public deployment | External setup | Domain/DNS, HTTPS host, Telegram registrations (bot plus the MTProto credentials that enable the official alert channel), secrets, monitoring receiver and off-site storage. Official alert API tokens are optional corroboration, no longer a prerequisite. |

| Continuous verification | Implemented | GitHub Actions runs typecheck, lint, the full test suite against a PostgreSQL service container, and the production build on every push and pull request to `main`. |

## Verified release checks

- TypeScript typecheck, ESLint, production build and 299 automated tests pass: 129 unit tests over
  pure functions and 170 integration tests executed against a live PostgreSQL 18 database.
- The integration suite covers subscription fanout (hierarchy in both directions, evidence threshold,
  threat-type filter, opt-out switches, idempotency), official alert reconciliation across two polled
  sources (including the end-debounce window and the identical-restart collision), event-driven
  reconciliation of the official alert channel (per-raion isolation of starts and all-clears, the
  refusal of a partial all-clear that repeats its own raion, out-of-order rejection, backlog folding
  and the maximum-duration backstop), outbox delivery and stuck-message reclaim, and the migration
  runner.
- Threat de-escalation is pinned on the isolation guarantee rather than on the happy path: a
  withdrawal from one monitor leaves another monitor's assertion standing and the event alive; the
  last withdrawal moves the event to `withdrawn` and appends `threat.withdrawn`; a source that never
  asserted changes nothing; an unscoped "нічого не летить" closes every claim of its own source and
  none of anybody else's; a redirect withdraws for the place passed and asserts for the place
  approached; the withdrawing source's risk signals decay while every other source's stay live; and
  `alert_source_states` and `alert_periods` are byte-identical before and after, including
  `updated_at`.
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
