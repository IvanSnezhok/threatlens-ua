# Specification completion matrix

This matrix is the release gate for the initial single-node Docker deployment. `Implemented` means the code path exists and was exercised locally. `External setup` means implementation is present but a human-owned account, token, domain, legal text or infrastructure subscription is intentionally not bundled.

| Requirement | State | Implementation / verification |
|---|---|---|
| One-command Docker start | Implemented | `compose.yaml` starts Caddy, app, PostgreSQL and backup services with health dependencies. |
| PostgreSQL history and migrations | Implemented | Four idempotent migrations; readiness requires `004_location_catalog.sql`. |
| Official alert ingestion | Implemented | Ukraine Alarm and Alerts.in.ua adapters, per-provider state and aggregate start/end reconciliation. Tokens remain external setup. |
| Public-channel monitoring | Implemented | Telegram MTProto collector handles new and edited messages. API credentials/session remain external setup. |
| Threat normalization | Implemented | UAV, ballistic/cruise missile, KAB, aviation, MLRS, artillery, mortar and combined classifications. |
| Evidence and provenance | Implemented | Source tier, independence group, raw message, URL, revisions, corroboration and non-downgrading evidence. |
| Event lifecycle | Implemented | Deduplication, merge, correction, expiry, update history and SSE event versions. |
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
| Territorial click history | Implemented | Oblast polygons and verified city points open combined alert, threat and analytical timelines with a full-history deep link. |
| Phone and TV support | Implemented | Browser-verified at 390x844 and 1920x1080; dedicated `/tv` layout. |
| History and monthly analytics | Implemented | Filterable history; monthly alert duration and threat-message summaries with location filters. |
| Source health and stale state | Implemented | Current/stale/error/recovered/unconfigured states exposed to API and UI. |
| Operations and observability | Implemented | Liveness/readiness, protected ops endpoints, Prometheus metrics and structured logs. |
| Curated Telegram channel catalog | Implemented | Protected operator create/verify/activate/hide controls; public site and `/channels` bot command provide relevant recommendations. |
| Security baseline | Implemented | Production fail-fast configuration, auth, rate limit, CSP and browser security headers, sanitized errors. |
| Privacy controls | Implemented | Minimal Telegram data, stop and cascade deletion. Controller/legal notice remains external setup. |
| Backups and restore | Implemented | Scheduled custom dumps, checksum, archive validation and isolated restore test. Off-site encrypted storage remains external setup. |
| Public deployment | External setup | Domain/DNS, HTTPS host, live source tokens, Telegram registrations, secrets, monitoring receiver and off-site storage. |

## Verified release checks

- TypeScript typecheck, production build and 13 automated tests pass.
- Production dependency audit reports zero known vulnerabilities.
- All four containers start; app and PostgreSQL report healthy and readiness returns `ready`.
- The current KATOTTG workbook imports 461 city records and records its SHA-256 checksum.
- Active risk assessments use methodology v2; previous model versions are no longer live.
- Backup checksum and full restore into an isolated temporary database succeed.
- Main, history, analytics, sources, methodology and TV routes render through the running service.
- Event and assessment dialogs expose source provenance, revisions/signals, limits and expiry.
- Caddy serves the app with CSP, HSTS, frame, referrer, permissions and content-type protections.

## Release boundary

The implemented target is a single application replica. Horizontal application scaling requires PostgreSQL advisory-lock leadership for schedulers. This does not block the documented initial Docker deployment.
