# Privacy and retention

The bot stores only the Telegram chat ID, optional username, language, subscription settings, delivery state and timestamps required to operate notifications.

- `/stop` disables delivery without deleting preferences.
- `/delete_me` deletes the Telegram user row and cascades subscriptions, queued notifications and nightly digest records.
- Public source messages are retained for provenance and correction history.
- No contact list, phone number, precise user location or Telegram private messages are requested.
- The website uses no analytics or advertising trackers by default.

Before public launch, publish a user-facing privacy notice with controller contact and retention periods. Legal/controller details require a human decision and are intentionally left to external setup.
