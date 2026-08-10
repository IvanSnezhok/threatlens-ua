# External setup: the parts that are not credentials

**Credentials moved.** How to obtain every token, key and session string — and, since migration
`030`, where each one lives afterwards and how to rotate it — is now
[`docs/TOKENS.md`](TOKENS.md). That document is the single place a credential is described, because
a credential described in two places is a credential that is wrong in one of them.

What stays here is everything that is not obtained from anybody: the domain, the certificate, the
server, and the operational decisions that surround them.

---

## Credentials — see `docs/TOKENS.md`

| What | Where |
|---|---|
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION` | [Telegram collector](TOKENS.md#telegram-mtproto) — my.telegram.org, then `node scripts/telegram-session.mjs` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_CHAT_ID` | [Bot](TOKENS.md#telegram-bot) — BotFather |
| `POSTGRES_PASSWORD`, `OPS_PASSWORD`, `METRICS_TOKEN`, `DEPLOY_RUNNER_TOKEN` | [Self-generated](TOKENS.md#self-generated) — `openssl rand` |
| `UKRAINE_ALARM_API_TOKEN` | [Ukraine Alarm](TOKENS.md#ukrainealarm) — browser form; an automated request is answered 403 |
| `ALERTS_IN_UA_TOKEN` | [Alerts.in.ua](TOKENS.md#alerts-in-ua) — written application, published rate limit |
| `AI_API_KEY` | [Model](TOKENS.md#ai-platform) — platform.openai.com |
| `CODEX_*` | [Codex over ChatGPT OAuth](TOKENS.md#codex) — sign-in button, loopback callback |
| nothing to obtain | [aerial mirror](TOKENS.md#aerial-mirror), [KATOTTG](TOKENS.md#katottg), [DeepStateMap](TOKENS.md#deepstate), [basemap](TOKENS.md#basemap) |

Most of these no longer need to be in `.env` at all — they are set from `/ops/settings` and stored
in the database. Which ones may *only* be set in `.env`, and why, is marked in `.env.example` and
listed by the page itself. The runbook for changing them is
[`docs/OPERATIONS.md`](OPERATIONS.md), "Settings from /ops".

---

## Domain and certificate

Server deployments only; a laptop needs none of this.

1. Register a domain, point an A/AAAA record at the host.
2. Open ports 80 and 443.

```env
SITE_ADDRESS=https://your.domain
PUBLIC_HOST=your.domain
PUBLIC_URL=https://your.domain
```

Caddy obtains and renews the certificate from Let's Encrypt automatically. Port 80 must stay open —
it is used for the challenge, not only for redirects.

All three are `.env`-only and always will be. `SITE_ADDRESS` and `PUBLIC_HOST` are interpolated by
compose and handed to Caddy, which never opens the database; `PUBLIC_URL` has to agree with both and
with the certificate, and production additionally refuses to start unless it is `https`. A mismatch
breaks the bot's «Відкрити карту» button — and could not be repaired from `/ops`, because the
console is served at that address.

---

## Production startup refuses to boot on

- `OPS_PASSWORD` left at `change-me` or shorter than 16 characters;
- `METRICS_TOKEN` missing or shorter than 16 characters;
- `PUBLIC_URL` that is not `https://`;
- `DEMO_SOURCE_ENABLED=true`;
- a `DATABASE_URL` still carrying development credentials;
- `DEPLOY_ENABLED=true` with a `DEPLOY_RUNNER_TOKEN` shorter than 32 characters.

That is deliberate. A half-configured alerting system is worse than one that will not start.

These checks are the reason `NODE_ENV` itself is `.env`-only: a value in the database could switch
off, by writing one row, the very guard that protects the database.

---

## Server layout

```bash
docker compose up --build -d          # app, caddy, postgres, backup
docker compose up -d deployer         # once, by hand, only if DEPLOY_ENABLED=true
```

`deployer` is started separately and on purpose. It is the one container holding the host's Docker
socket, it is deliberately **not** given `env_file: .env`, and the update scenario never restarts it
— a runner that can replace itself mid-run cannot report its own outcome. Prerequisites and
boundaries in full: [`docs/OPERATIONS.md`](OPERATIONS.md), "Deployment from /ops".

`DEPLOY_REPO_PATH` must be an absolute path and is mounted at the **same** path inside the
container: `docker compose` runs in there while the daemon runs out here, and the daemon resolves
this file's relative bind mounts against a host path.

---

## Occupied-territories layer: a licence decision, not a setup step

The DeepStateMap feed is not published under an open licence. Attribution is mandatory and is
emitted in every response, but obtaining permission before public distribution is a decision a human
has to make — or set `OCCUPATION_SOURCE_ENABLED=false`. Details:
[`docs/TOKENS.md`](TOKENS.md#deepstate).

---

## Left to a human

- A user-facing privacy notice with controller contact and retention periods, before public launch.
  See [`docs/PRIVACY.md`](PRIVACY.md) — the retention behaviour is implemented, the legal identity
  of the controller is not something this repository can state.
- Encrypted off-host backup storage. `scripts/backup.sh` writes archives to `./backups` and
  validates them; getting those archives somewhere else, encrypted, is an external setup task —
  and, since `030`, the archives contain credentials, which raises the stakes on it.
- Protecting the `main` branch, if `DEPLOY_ENABLED=true`. Anyone who can write `main` ships code the
  moment an operator presses the button. That is a stated prerequisite, not a defect.

---

## Minimum to see real data

The Telegram collector and the bot. Everything else is optional or self-generated.

```bash
docker compose up --build -d
```
