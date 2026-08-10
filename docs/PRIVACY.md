# Privacy and retention

The bot stores only the Telegram chat ID, optional username, language, subscription settings, delivery state and timestamps required to operate notifications.

- `/stop` disables delivery without deleting preferences.
- `/delete_me` deletes the Telegram user row and cascades subscriptions, queued notifications and nightly digest records.
- Public source messages are retained for provenance and correction history.
- No contact list, phone number, precise user location or Telegram private messages are requested.
- The website uses no analytics or advertising trackers by default.

Before public launch, publish a user-facing privacy notice with controller contact and retention periods. Legal/controller details require a human decision and are intentionally left to external setup.

## Backups contain credentials

A PostgreSQL dump of this deployment is **not** an archive of public data. Three tables hold live
secrets in plaintext, and a dump carries all three:

- `app_settings` — since migration `030`, every credential an operator set from `/ops/settings`:
  the bot token, the MTProto api_id, api_hash and session string, the two official-API tokens, the
  model key, and the Codex token and account id.
- `codex_credentials` — since migration `017`, the stored ChatGPT OAuth access and refresh tokens.
- Subscriber rows, which are personal data under the retention rules above.

None of it is encrypted at rest, and that is a stated limit rather than an oversight: the key would
have to live on the same host, beside the data, readable by the same process — the same exposure
with more moving parts. The precedent and the reasoning are recorded in migration `017`; `030`
inherits both.

What follows from it:

- **Treat a dump exactly as you treat `.env`.** `scripts/backup.sh` writes to `./backups` on the
  host; that directory now deserves the same handling as the secrets file next to it.
- **Production copies must be encrypted before they leave the host**, and the storage account they
  go to is an external setup task, not a default.
- **Rotating a leaked secret does not clean the backups.** It invalidates the credential, which is
  what matters — see the rotation runbook per secret in [`docs/TOKENS.md`](TOKENS.md). Old dumps
  keep the old value; they simply stop being useful to anybody holding them.
- **A restore restores the credentials too.** Restoring last week's dump into a deployment whose
  tokens were rotated since will put the rotated-away values back into `app_settings` and the app
  will start using them.
