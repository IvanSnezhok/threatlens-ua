# External setup checklist

All product code paths exist without these credentials. Complete these human-controlled registrations before a public launch.

## Required for live operation

1. Create Telegram API credentials for the public-channel collector.
   - Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and `TELEGRAM_SESSION`.
   - These also enable the official alert source: the channel
     [@air_alert_ua](https://t.me/air_alert_ua) is read through the same collector. **No API token
     or written application is needed for official alerts.** Verify in staging that raion and
     hromada names from the channel resolve against the local catalogue; unresolved names are
     counted and logged, and degrade coverage rather than the source.
2. Create a Telegram bot through BotFather.
   - Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`.
   - Configure its public description and privacy notice.
3. Register a domain and configure DNS.
   - Set an HTTPS `SITE_ADDRESS`, `PUBLIC_HOST` and `PUBLIC_URL`.
4. Generate strong production secrets.
   - `POSTGRES_PASSWORD`, `OPS_PASSWORD`, `METRICS_TOKEN`.
   - Set `DEMO_SOURCE_ENABLED=false`; production startup rejects demo data and known development database credentials.

## Optional

- **Additional official alert APIs.** `UKRAINE_ALARM_API_TOKEN` and `ALERTS_IN_UA_TOKEN` each need a
  token issued on written application. They are no longer required to have official alerts, but a
  second independent official source strengthens corroboration and removes the single point of
  failure. Both adapters stay disabled without a token; verify a sample response in staging, since
  unknown provider locations intentionally degrade the source.
- **Temporarily occupied territories layer (DeepStateMap).** The feed is not published under an open
  licence. The product owner uses this project personally, and personal use needs no written
  permission, so the layer may run with `OCCUPATION_SOURCE_ENABLED=true`. Attribution is emitted in
  every `/api/v1/occupation` response regardless. **The requirement returns the moment the deployment
  is distributed publicly:** before a public launch, obtain explicit permission from DeepState or
  deploy with `OCCUPATION_SOURCE_ENABLED=false`. That is a legal decision owned by the product owner,
  not a configuration step.
- Configure an OpenAI-compatible JSON endpoint through `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`. The deterministic engine works without it.
- Create independent encrypted object storage for off-host backups.
- Host a private PMTiles archive and set `MAP_STYLE_URL`.
- Add monitoring receivers for Prometheus and logs.

Never commit tokens or generated Telegram sessions. Production configuration rejects weak ops and metrics credentials and a non-HTTPS public URL.
