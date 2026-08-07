# External setup checklist

All product code paths exist without these credentials. Complete these human-controlled registrations before a public launch.

## Required for live operation

1. Obtain access to one supported official alert API.
   - Set `UKRAINE_ALARM_API_TOKEN`, or
   - set `ALERTS_IN_UA_TOKEN`.
   - Verify a sample response in staging; unknown provider locations intentionally degrade the source.
2. Create a Telegram bot through BotFather.
   - Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`.
   - Configure its public description and privacy notice.
3. Create Telegram API credentials for the public-channel collector.
   - Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and `TELEGRAM_SESSION`.
4. Register a domain and configure DNS.
   - Set an HTTPS `SITE_ADDRESS`, `PUBLIC_HOST` and `PUBLIC_URL`.
5. Generate strong production secrets.
   - `POSTGRES_PASSWORD`, `OPS_PASSWORD`, `METRICS_TOKEN`.
   - Set `DEMO_SOURCE_ENABLED=false`; production startup rejects demo data and known development database credentials.

6. Agree terms of use for the temporarily occupied territories layer with DeepStateMap.
   - The feed is not published under an open licence; attribution alone is not a licence.
   - Until permission is confirmed in writing, deploy with `OCCUPATION_SOURCE_ENABLED=false`.
   - This is a legal decision owned by the product owner, not a configuration step.

## Optional

- Configure an OpenAI-compatible JSON endpoint through `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`. The deterministic engine works without it.
- Create independent encrypted object storage for off-host backups.
- Host a private PMTiles archive and set `MAP_STYLE_URL`.
- Add monitoring receivers for Prometheus and logs.

Never commit tokens or generated Telegram sessions. Production configuration rejects weak ops and metrics credentials and a non-HTTPS public URL.
