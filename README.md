# ThreatLens UA

Evidence-first situational awareness for Ukraine: a Telegram bot, responsive static web client, PostgreSQL event history, and an explainable six-hour risk index.

> This product is not an official alert system and does not predict strike targets. During an official alert, follow the instructions of the Air Force, the State Emergency Service, and local authorities.

## What is implemented

- Two official alert adapters, per-source state reconciliation, and normalized alert periods.
- Threat event classifier for UAVs, ballistic and cruise missiles, KABs, aviation, MLRS, artillery, and mortars.
- Evidence levels: `unverified`, `monitoring`, `confirmed`, and `official`.
- Corroboration by independent source groups; reposts do not count as independent confirmation.
- Six-hour per-location risk assessment with time decay, source-tier guardrails, validated AI output, and deterministic fallback.
- Telegram subscriptions, commands, PostgreSQL outbox, retry policy, and delivery rate control.
- Static HTML/CSS/JS frontend with MapLibre, SSE updates, mobile and TV layouts, history, analytics, source health, and operations views.
- Explicit internationally recognized Ukraine boundary overlay including the Autonomous Republic of Crimea and Sevastopol; oblast/city clicks open territorial history.
- Temporarily occupied territories layer sourced from DeepStateMap, filtered by a fail-safe status allowlist and clipped to the recognized border of Ukraine. Reference context only — it never affects alerts or risk scores.
- Operator-managed catalog of recommended Telegram channels, exposed on the site and through the bot.
- Automatic official KATOTTG import covering 461 cities in the 07.07.2026 release.
- PostgreSQL migrations, monthly materialized summaries, Prometheus metrics, health checks, Caddy, Docker Compose, and verified daily local backups.

## Quick start

```bash
cp .env.example .env
docker compose up --build -d
```

Open `http://localhost:8080`. The backend is also bound to `http://127.0.0.1:13000` for local development. Readiness is available at `/health/ready`.

The default configuration starts in demo mode with two clearly marked synthetic events. Before public deployment:

1. Set strong `POSTGRES_PASSWORD` and `OPS_PASSWORD` values.
2. Configure `PUBLIC_URL`, `PUBLIC_HOST`, and an HTTPS `SITE_ADDRESS`.
3. Set `DEMO_SOURCE_ENABLED=false`.
4. Add the official alert API token and validate its location mapping against the provider's current schema.
5. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`; configure the MTProto collector for the Air Force channel.
6. Configure an OpenAI-compatible structured-output endpoint if AI assessments are required.
7. Point `MAP_STYLE_URL` to a self-hosted style/PMTiles package; see `data/map/README.md`.

## Telegram commands

- `/start` — create a private subscription.
- `/city` — choose a region; `/city Назва` searches the full city catalog.
- `/status` — current official alerts and public assessments.
- `/analytics` — current six-hour assessment.
- `/settings` — notification preferences.
- `/channels` — administrator-curated Telegram channels relevant to the user's subscriptions.
- `/stop` — pause notifications.
- `/delete_me` — delete Telegram profile and subscriptions.
- `/help` — safety and usage notes.

The bot does not invent an alert. Official alert state and analytical risk assessment remain separate message types.

## Data model and event flow

```mermaid
flowchart LR
  Sources[Official APIs and monitored channels] --> Normalize[Normalize and classify]
  Normalize --> Evidence[Evidence and independent-source deduplication]
  Evidence --> Events[(PostgreSQL events)]
  Events --> Risk[Six-hour risk assessment]
  Events --> SSE[SSE snapshot stream]
  Risk --> Outbox[(Notification outbox)]
  Outbox --> Bot[Telegram bot]
  SSE --> Web[Static web map]
```

The map renders only an explicitly reported region, point, or direction. It does not extrapolate a target or trajectory. Assessments contain an expiry, confidence, methodology version, and supporting signals. A low score never means safety.

Detailed contracts and runbooks:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/PRIVACY.md`](docs/PRIVACY.md)
- [`docs/EXTERNAL_SETUP.md`](docs/EXTERNAL_SETUP.md)
- [`docs/COMPLETION_MATRIX.md`](docs/COMPLETION_MATRIX.md)

## Development and verification

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs two Vitest projects:

- `unit` — pure functions, no external services.
- `integration` — real SQL against a live PostgreSQL 18 database: subscription fanout, official alert
  reconciliation, outbox delivery and stuck-message reclaim, and the migration runner.

The integration project starts a throwaway `postgres:18-alpine` container on port `15437` and removes it
afterwards. Set `TEST_DATABASE_URL` to reuse an existing server instead (this is what CI does with a
GitHub Actions service container). Without Docker and without `TEST_DATABASE_URL` the integration tests
report as **skipped** with an explicit reason — they never pass silently. Set `REQUIRE_INTEGRATION_DB=1`
to turn that skip into a failure.

```bash
npm run test:unit
npm run test:integration
```

GitHub Actions runs typecheck, lint, both projects and the production build on every push and pull
request to `main`.

Useful endpoints:

- `/api/v1/snapshot` — atomic initial state.
- `/api/v1/stream` — real-time SSE events.
- `/api/v1/history` — normalized event history.
- `/api/v1/locations/:id/timeline` — alerts, threats and assessments for a clicked oblast or city.
- `/api/v1/channels` — active administrator-curated Telegram channels.
- `/api/v1/occupation` — temporarily occupied territories as GeoJSON, with source attribution, upstream revision id, per-status counts and a `stale` flag. Cached (`ETag`, `Last-Modified`, `Cache-Control: public, max-age=120`); returns an empty layer rather than an error when the source is off or unavailable.
- `/api/v1/analytics/monthly` — monthly summaries.
- `/api/v1/sources/health` — source freshness.
- `/api/v1/methodology` — machine-readable v2 methodology and hard limits.
- `/metrics` — Prometheus metrics.
- `/ops/api` and `/ops/run-assessment` — Basic-auth protected operations API.
- `/ops` — operator login and channel catalog management; channel mutations remain Basic-auth protected.

## Backups

The `backup` service creates a PostgreSQL custom-format dump in `./backups` every 24 hours and retains 14 days by default. Change `BACKUP_INTERVAL_SECONDS` and `BACKUP_RETENTION_DAYS` as needed. For production, copy encrypted dumps to independent object storage and regularly test restoration:

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" backups/threatlens-TIMESTAMP.dump
```

## Temporarily occupied territories

A separate reference layer, sourced from [DeepStateMap](https://deepstatemap.live). It is not an alert, not
a threat event and not an input to any risk score, and it is stored, served and rendered independently of
those pipelines. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full contract.

| Variable | Default | Meaning |
|---|---|---|
| `OCCUPATION_SOURCE_ENABLED` | `true` | Kill switch. When `false`, nothing is fetched and `/api/v1/occupation` serves an empty layer flagged stale. |
| `DEEPSTATE_API_URL` | `https://deepstatemap.live/api/history/last` | Upstream revision endpoint. |
| `OCCUPATION_SYNC_INTERVAL_SECONDS` | `10800` | Poll interval. Values below `3600` are rejected at startup — upstream publishes roughly once a day. |
| `OCCUPATION_STALE_AFTER_SECONDS` | `21600` | How long a revision may go unconfirmed before the payload is flagged `stale`. |

### Legal framing

Occupation is a **temporary factual condition on the territory of Ukraine, not a change of border**. The
internationally recognized border of Ukraine remains authoritative throughout this product, and the
Autonomous Republic of Crimea and the city of Sevastopol are Ukraine. The layer answers "which Ukrainian
territory is currently occupied", never "where does Ukraine end".

The upstream feed is an editorial product that also covers territories russia occupies outside Ukraine —
twelve of them: Kaliningrad, Abkhazia, Karelia, Ichkeria, Petsamo, Salla, Estonia, the Pechorsky district,
Latvia, the Kuril Islands, the Tskhinvali district and Transnistria. The normalizer is therefore a
**fail-safe allowlist**: only explicitly approved status keys are rendered, and any new or unrecognized key
is rejected, counted in `threatlens_occupation_unknown_status_keys_total` and stored for review rather than
drawn on the map. Accepted polygons are then clipped to the recognized ADM0 border of Ukraine.

Clipping is the second line of defence, not the first. Transnistria's polygon overlaps the Ukrainian border
closely enough to survive geometric clipping, so the allowlist — not the clip — is what keeps it off the map.

### Data licence — unresolved

DeepStateMap data is **not** published under an open licence. Attribution is emitted in every
`/api/v1/occupation` response and the source can be switched off with a single flag, but terms of use for a
public deployment have not been agreed. The product owner must obtain explicit permission from DeepState
before a public launch, or deploy with `OCCUPATION_SOURCE_ENABLED=false`.

## Known integration boundary

Access tokens and contractual schemas for public alert providers are not included. Adapters stay disabled without a token. Validate each provider in staging; unknown locations are rejected rather than silently shown in the wrong region. See `docs/EXTERNAL_SETUP.md` for the human-controlled launch checklist.

The location catalog is imported from the [official Ministry KATOTTG publication](https://mindev.gov.ua/diialnist/rozvytok-mistsevoho-samovriaduvannia/kodyfikator-administratyvno-terytorialnykh-odynyts-ta-terytorii-terytorialnykh-hromad), used under the Ukrainian open-data attribution terms. KATOTTG provides names and hierarchy, not map coordinates; cities without verified coordinates remain searchable and subscribable but are not placed at an approximate point.
