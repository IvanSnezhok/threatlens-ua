# Operations runbook

## Health

- `/health/live`: process is running.
- `/health/ready`: database is reachable and the latest required migration is applied.
- `/api/v1/sources/health`: configured, current, stale, error and unconfigured source states.
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

## Backups

The backup container creates a custom-format archive, validates it with `pg_restore --list`, and writes a SHA-256 sidecar. Retention defaults to 14 days.

Perform a real isolated restore test after material schema changes:

```bash
docker compose exec -T backup sh /usr/local/bin/restore-test.sh /backups/threatlens-TIMESTAMP.dump
```

Production backups must additionally be encrypted and copied to independent object storage. That storage account is an external setup task.

## Incident responses

- **Official API stale/error:** public site enters degraded state; do not infer alert end from timeout.
- **Telegram 403:** the user is disabled automatically; queued messages stop.
- **Telegram 429:** delivery uses the provider `retry_after` value.
- **AI invalid/timeout:** failure is recorded and deterministic fallback is used.
- **Unknown provider location:** parsed alert states are retained, source becomes error, and the unknown location is not mapped heuristically.
- **Edited monitored message:** revision is stored; incompatible previous event is marked corrected.
- **Incorrect channel recommendation:** hide it in `/ops`; public API, site and bot stop returning it immediately.
