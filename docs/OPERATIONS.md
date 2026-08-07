# Operations runbook

## Health

- `/health/live`: process is running.
- `/health/ready`: database is reachable and the latest required migration is applied (currently `008_alert_end_debounce.sql`).
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
- **Stuck alert on the official channel source (`threatlens_alert_channel_stuck_alerts_total > 0`).**
  The channel is event-driven: an alert ends only when a 🟢 message names its location. If such a
  message is never published, is edited away, or arrives in a shape the parser refuses, the location
  keeps its alert indefinitely. `ALERT_CHANNEL_MAX_ALERT_SECONDS` (default 86400) is the backstop
  that clears it and increments the counter, and the accompanying `warn` log names the location and
  its start time.

  A non-zero counter means a 🟢 was genuinely lost — treat it as a parser defect report, not as
  routine noise. Open `https://t.me/s/air_alert_ua`, find the all-clear for that location and compare
  it against `src/domain/alert-parser.ts`: the channel publishes partial all-clears (🟡) carrying a
  "тривога ще триває у:" addendum, threat stand-downs (`Відбій загрози`, `Відбій по КАБах`) that must
  never end an air raid, and occasional typo headlines. A new wording variant belongs in the parser
  with a test, not in a lowered threshold.

  **Never lower `ALERT_CHANNEL_MAX_ALERT_SECONDS` toward a realistic alert duration.** The bound sits
  above the longest plausible real alert on purpose — overnight mass-attack alerts run 8–11 hours and
  frontline raions hold much of a day. Tuning it down converts a defect detector into a generator of
  false "Офіційний відбій" messages, which is the failure this system is built to avoid.
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
- **Comparing two periods of analytics.** Always split by `classifier_version` or state that you did
  not. A version bump changes what the same message means, and an unsplit comparison reports a change
  in this project's rules as a change in enemy behaviour.
- **Edited monitored message:** revision is stored; incompatible previous event is marked corrected.
- **Incorrect channel recommendation:** hide it in `/ops`; public API, site and bot stop returning it immediately.
