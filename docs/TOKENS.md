# Tokens: how to obtain each one, and where it lives afterwards

Every code path in this project exists without these. What they unlock is real data.

Ordered by how much they unlock. The first one turns the product on; most of the rest are optional
or self-generated.

**Two things changed when `/ops/settings` shipped, and they change how this document is read.**

1. **Most of these values no longer have to be in `.env`.** The settings registry stores them in
   PostgreSQL (`app_settings`), where a stored value wins over the environment. `.env` remains the
   bootstrap: what the container starts with, and the only place thirty keys may ever be set. Each
   section below says which of the two it is.
2. **A stored secret is still a plaintext secret.** It moved from a file into a table; it did not
   become encrypted. See [Where each secret lives](#where-each-secret-lives) and
   [`docs/PRIVACY.md`](PRIVACY.md) — the backups contain it.

Verification dates are stated per section. Where a step is a human action behind a browser form,
the date records when the path was last walked, not a promise that it still behaves that way today.

---

<a id="telegram-mtproto"></a>

## 1. Telegram collector — `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`

**Unlocks:** official air-raid alerts, all-clears, and every monitored channel. Nothing real arrives
without this. It is the only credential the product genuinely needs.

This is a **user** account, not a bot. The Bot API cannot read a channel it does not administer, and
official alert channels are exactly that. Use an account you control; a second SIM is fine.

### api_id and api_hash

1. Open <https://my.telegram.org> and log in with the phone number of that account.
2. Choose **API development tools**.
3. Fill the form — any app name and short name are accepted; platform *Other*; URL may be blank.
4. The page then shows **App api_id** (a number) and **App api_hash** (32 hex characters).

Both are permanent for that account. Losing them means creating a new app on the same page.

### session string

```bash
npm install
node scripts/telegram-session.mjs
```

That is the real script name and it takes no arguments. It asks for the two values above (or reads
them from the environment if they are already exported), then the phone number, the login code
Telegram sends, and the two-step password if the account has one. It prints a `TELEGRAM_SESSION=`
line and writes nothing to disk.

```env
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_SESSION=1BQANOTEuMTA4...
```

**The session string is equivalent to being logged into that account.** It does not expire on its
own; logging that account out of all devices ends it.

**Where it lives now:** all three are `db_secret` — settable from `/ops/settings`, stored in
`app_settings`. `.env` still works and is what a first boot reads.

**Changing it restarts the collector.** The page marks all three `confirm` with impact
`collector` and shows the live collector state beside the button, because the seconds after a
replacement are seconds in which no channel is being read.

**Rotation:** *Telegram → Settings → Devices* → terminate the session. That invalidates the string
immediately, everywhere, including any copy in a backup. Then run the script again and save the new
value. Rotating `api_hash` instead means creating a new app on my.telegram.org; the old one keeps
working until you do.

---

<a id="telegram-bot"></a>

## 2. Bot — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_CHAT_ID`

**Unlocks:** notifications to subscribers. Without it the bot is skipped and everything else runs.

1. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`.
2. Give a display name, then a username ending in `bot`.
3. BotFather replies with a token shaped `123456789:AAF...`.

```env
TELEGRAM_BOT_TOKEN=123456789:AAF-your-token-here
TELEGRAM_BOT_USERNAME=your_bot          # without the @
```

The bot registers its own command list on start. Useful follow-ups in BotFather: `/setdescription`,
`/setabouttext`, `/setuserpic`.

`TELEGRAM_ADMIN_CHAT_ID` is your own numeric chat id, for operator notices. Get it by messaging
[@userinfobot](https://t.me/userinfobot). It is not a secret.

**Where it lives now:** the token is `db_secret`; the username and admin chat id are ordinary
`db_tunable` values. All three are settable from `/ops/settings`.

**Rotation:** `/revoke` in BotFather issues a new token and kills the old one in the same step.
Paste the new one into **Замінити** on the settings page — no restart, the bot picks it up.

---

<a id="self-generated"></a>

## 3. Self-generated secrets — `POSTGRES_PASSWORD`, `OPS_PASSWORD`, `METRICS_TOKEN`, `DEPLOY_RUNNER_TOKEN`

Nobody issues these. Generate them:

```bash
openssl rand -base64 24     # run once per secret
openssl rand -hex 32        # DEPLOY_RUNNER_TOKEN: 32+ characters is enforced
```

```env
POSTGRES_PASSWORD=…
OPS_PASSWORD=…              # 16+ chars, or production refuses to start
METRICS_TOKEN=…             # 16+ chars, same rule
DEPLOY_RUNNER_TOKEN=…       # 32+ chars when DEPLOY_ENABLED=true
```

`OPS_PASSWORD` guards `/ops` together with `OPS_USER` (default `operator`). `METRICS_TOKEN` guards
`/metrics` outside development. `DEPLOY_RUNNER_TOKEN` is the shared bearer between `app` and the
`deployer` container.

Production startup **fails** on `change-me`, on anything under 16 characters, on a non-HTTPS
`PUBLIC_URL`, on demo mode left enabled, and on development database credentials. A half-configured
alerting system is worse than one that will not boot.

**Where they live now: `.env` only, all four.** This is the sharpest boundary in the registry and it
is not an oversight:

- `OPS_USER` and `OPS_PASSWORD` are the lock on the very page that would edit them. A session that
  can change its own login condition can, with one typo, lock the operator out of the only surface
  that could fix it.
- `METRICS_TOKEN` and `DEPLOY_RUNNER_TOKEN` are shared with something outside this process — a
  scraper, and a container that is deliberately not given `env_file: .env`. A value stored where
  only `app` can read it would be a value the other half never learns.
- `POSTGRES_PASSWORD` is inside `DATABASE_URL`, which is the string used to open the pool that holds
  the settings table. Chicken and egg.

**Rotation:** edit `.env`, then `docker compose up -d app` (a `restart` does not re-read `.env`).
For `POSTGRES_PASSWORD` change it in PostgreSQL first (`ALTER ROLE threatlens WITH PASSWORD …`),
then in `.env`, then recreate `app` and `backup`. For `DEPLOY_RUNNER_TOKEN` both `app` and
`deployer` must be recreated, or the button starts answering 502.

---

<a id="domain"></a>

## 4. Domain — `SITE_ADDRESS`, `PUBLIC_HOST`, `PUBLIC_URL`

Server deployments only; a laptop needs none of this. Full setup — DNS, ports, Caddy — is in
[`docs/EXTERNAL_SETUP.md`](EXTERNAL_SETUP.md), which remains the document for anything that is not a
credential.

```env
SITE_ADDRESS=https://your.domain
PUBLIC_HOST=your.domain
PUBLIC_URL=https://your.domain
```

**Where it lives now: `.env` only.** `SITE_ADDRESS` and `PUBLIC_HOST` are consumed by compose and
handed to Caddy, which never reads the database at all. `PUBLIC_URL` has to agree with them and with
the certificate, and production additionally requires https — a mismatch breaks the bot's «Відкрити
карту» button, and it could not be repaired from `/ops` because the console lives at that address.

---

<a id="ukrainealarm"></a>

## 5. Ukraine Alarm — `UKRAINE_ALARM_API_TOKEN` *(optional)*

**Unlocks:** a second independent official source. **Not a prerequisite** — official alerts already
work through the Telegram collector at step 1 and through the community mirror at step 7.

- Request through <https://api.ukrainealarm.com>.
- **The application is a browser form filled in by a human.** Checked 2026-08: an automated request
  for the token is answered with **HTTP 403** — there is no scripted path, and a deployment tool
  that tries to fetch one will get a refusal, not a token. Open the page, fill the form, wait.
- Approval takes as long as it takes. Nothing in this project blocks on it.

Final confirmation of the current form and its wording is an owner action: this document records the
date the path was walked, not a live probe.

```env
UKRAINE_ALARM_API_TOKEN=…
UKRAINE_ALARM_API_URL=https://api.ukrainealarm.com/api/v3/alerts
```

Validate in staging before trusting it: the provider's region identifiers must map onto the local
catalogue. An unmapped location is reported as a catalogue gap rather than guessed at, so a mismatch
shows up as silence, not as a wrong region.

**Where it lives now:** the token is `db_secret`; the URL is `db_tunable`. Both settable from
`/ops/settings`, applied hot.

**Rotation:** request a replacement through the same form; there is no self-service revoke. Until
the new one is in place, clear the old one (**Очистити**) rather than leaving a dead token polling —
an unconfigured source is reported as `unconfigured`, a dead one as `error`, and only the first of
those is the truth.

---

<a id="alerts-in-ua"></a>

## 6. Alerts.in.ua — `ALERTS_IN_UA_TOKEN` *(optional)*

**Unlocks:** a third independent official source. Same standing as step 5: corroboration, not a
prerequisite.

- Request through <https://alerts.in.ua>, developer section. Written application, checked 2026-08.
- **Respect the published rate limit.** It is stated by the issuer alongside the token and it is not
  negotiable by configuration: polling faster than it allows returns `429`, and a source that is
  being rate-limited is a source that is not corroborating anything. This project polls official
  providers every 15 seconds; if the issued limit is tighter than that, the token is the wrong shape
  for this deployment and the mirror at step 7 is the better source.

```env
ALERTS_IN_UA_TOKEN=…
ALERTS_IN_UA_URL=https://api.alerts.in.ua/v1/alerts/active.json
```

**Where it lives now:** token `db_secret`, URL `db_tunable`, both hot.

**Rotation:** reissue through the developer section, replace on the settings page. As with step 5,
clear rather than leave stale.

---

<a id="aerial-mirror"></a>

## 7. Community aerial-alert mirror — no token at all

**Unlocks:** live alert data with **no credential, no application and no waiting.** This is what
carries a fresh deployment while the applications in steps 5 and 6 are pending.

There is nothing to obtain. `AERIAL_MIRROR_ENABLED` is on by default precisely because there is no
credential to withhold — this switch is the only "off" the source has.

```env
AERIAL_MIRROR_ENABLED=true
AERIAL_MIRROR_URL=https://ubilling.net.ua/aerialalerts/
AERIAL_MIRROR_RAW_SOURCE=ual      # empty string = oblast-only, the known-good retreat
```

Read `migrations/027_aerial_alert_mirror.sql` before trusting it for anything: its own operator says
"do not perceive this API as absolutely reliable", and `?source=default` is an aggregator that may
be serving one of the two APIs above on any given poll — so it corroborates them barely at all.

**Where it lives now:** `AERIAL_MIRROR_ENABLED` is `.env` only (a deployment-level kill switch must
work when the database does not). The URL, the raw source, the staleness bound and the request gap
are all `db_tunable`.

---

<a id="ai-platform"></a>

## 8. Model — `AI_API_KEY` *(optional)*

**Unlocks:** model-written risk explanations and analytics narrative. Every number is produced by
deterministic SQL either way; the model only writes prose over figures it is given, and any number
it invents is rejected.

1. <https://platform.openai.com> → **API keys** → create.
2. Billing must be set up on the platform account; a ChatGPT subscription does **not** include API
   access.

```env
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-…
AI_MODEL=gpt-4.1-mini
ANALYTICS_NARRATIVE_ENABLED=true
```

Any OpenAI-compatible endpoint works — a local model server, a proxy, another provider.

Expected load: tens of short calls per cycle. This is a few dollars a month, not a reason to
optimise.

**Where it lives now:** the key is `db_secret`; base URL, model name and timeout are `db_tunable`.
All hot — a replaced key is used by the next call.

**Rotation:** revoke on the platform's API-keys page, create a new one, paste into **Замінити**.
Revoking first is safe: the deterministic path is what runs while no key works.

---

<a id="codex"></a>

## 9. Codex over ChatGPT OAuth — `CODEX_*` *(optional)*

**Read this before spending time on it.**

The intent is to run inference on a ChatGPT plan instead of an API key.

### Signing in from the operations console

Open `/ops`, find **Codex / ChatGPT** and press **Увійти через ChatGPT**. The browser goes to
ChatGPT, comes back to `http://localhost:1455/auth/callback`, and the session is stored in
PostgreSQL and refreshed from then on. Nothing is written to `.env` and no restart is needed.

The sign-in was exercised end to end against the live service on **2026-08-07** and returned a
session with a refresh token; the Responses transport was exercised with that session on
**2026-08-08** and returned model text whose audit row landed in `ai_runs`.

One thing still has to be set by hand, because signing in supplies a credential and not an endpoint:

```env
CODEX_BASE_URL=https://chatgpt.com/backend-api/codex
```

### The callback is loopback, and that is a hard limit

The Codex OAuth client accepts exactly one redirect — `http://localhost:<port>/auth/callback` — and
we have no client of our own registered with OpenAI. So the browser finishing the sign-in and this
app have to agree on what `localhost` means:

| Where the app runs | Sign-in |
|---|---|
| `docker compose` on your own machine | works — compose publishes `127.0.0.1:1455` |
| `npm run dev` on your own machine | works |
| a remote host behind Caddy, browser elsewhere | **never completes** — the callback goes to *your* machine, where nothing is listening |

For the third case, **tunnel the port before pressing the button**:

```bash
ssh -L 1455:localhost:1455 you@your.host
```

Then open `/ops` through that same machine and sign in. `/ops/codex` reports the unreachable
callback as a precondition, not as a bug. If port 1455 is busy — the Codex CLI holds it while it is
running — the console says so rather than handing out a URL whose answer would be dropped.

### The manual token, still supported

Install the Codex CLI, run `codex login`, and read the access token and account id out of
`~/.codex/auth.json` into `CODEX_API_KEY` and `CODEX_ACCOUNT_ID`. That token **does not refresh**;
when it expires the narrative falls back to deterministic text until you paste a new one. A session
stored through the button always takes precedence over these two variables.

### It is outside what that authorisation is for

Codex sign-in is meant for the Codex client, not for a third-party server running around the clock.
The risk is account action. That is a real caveat, not a formality.

**Where it lives now:** `CODEX_API_KEY` and `CODEX_ACCOUNT_ID` are `db_secret` in `app_settings`;
base URL, model, API style and all seven `CODEX_OAUTH_*` values are ordinary settings — the OAuth
seven are `.env` only, because the redirect port is published by compose and the rest describe a
client that is not ours. The **stored session** is a different row entirely: `codex_credentials`,
written by the button, holding an access token and a refresh token in plaintext.

**Rotation:** press **Відключити** in the console — that drops the stored session. If the database
is out of reach, remove the session in **ChatGPT → Settings → Connected apps**. For the manual
variables, clear them on the settings page.

---

<a id="katottg"></a>

## 10. KATOTTG location catalogue — no token

Public ministry publication, imported automatically. No registration.

```env
KATOTTG_SYNC_ENABLED=true
KATOTTG_URL=https://mindev.gov.ua/storage/app/sites/1/uploaded-files/kodifikator-07-07.xlsx
KATOTTG_VERSION=07.07.2026
```

The URL and version change only when the ministry publishes a new codifier; when that happens, set
both together — the version string is what the import records as provenance, so a new file under an
old version number produces a catalogue that lies about where it came from.

**Where it lives now:** `KATOTTG_SYNC_ENABLED` is `.env` only (kill switch); the URL and the version
are `db_tunable`.

---

<a id="deepstate"></a>

## 11. DeepStateMap occupation layer — no token, but a licence caveat

Public endpoint, no registration, no key.

**The data is not published under an open licence.** Attribution is mandatory and is emitted in
every response. Obtain permission before public distribution, or switch the layer off:

```env
OCCUPATION_SOURCE_ENABLED=false
```

Only territory inside the internationally recognised border of Ukraine is ever rendered.

**Where it lives now:** `OCCUPATION_SOURCE_ENABLED` is `.env` only (kill switch); the endpoint URL
and the two interval bounds are `db_tunable`.

---

<a id="basemap"></a>

## 12. Basemap — `MAP_STYLE_URL`

Public tile server by default. Replace with a self-hosted style for production; see
`data/map/README.md`.

**Where it lives now:** `db_tunable`, hot. It is served to the visitor's browser through
`/api/v1/config`, so a change reaches the next page load with no restart — and a bad value is
visible to every visitor immediately, which is why it is worth checking in one tab before walking
away.

---

<a id="where-each-secret-lives"></a>

## Where each secret lives

Nine values are classified as secrets by the registry — the page never renders them, the API never
serialises them, and the audit trail records «замінено» / «знято» instead of a value. Four more are
credentials that are `.env`-only, which makes them unwritable but not safe to print, so they are
masked too.

| Secret | Stored in | Settable from `/ops/settings` | In `.env` backups? | In database backups? |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `app_settings` | yes | if set there | **yes** |
| `TELEGRAM_API_ID` | `app_settings` | yes | if set there | **yes** |
| `TELEGRAM_API_HASH` | `app_settings` | yes | if set there | **yes** |
| `TELEGRAM_SESSION` | `app_settings` | yes | if set there | **yes** |
| `UKRAINE_ALARM_API_TOKEN` | `app_settings` | yes | if set there | **yes** |
| `ALERTS_IN_UA_TOKEN` | `app_settings` | yes | if set there | **yes** |
| `AI_API_KEY` | `app_settings` | yes | if set there | **yes** |
| `CODEX_API_KEY` | `app_settings` | yes | if set there | **yes** |
| `CODEX_ACCOUNT_ID` | `app_settings` | yes | if set there | **yes** |
| Codex OAuth session | `codex_credentials` | no — the sign-in button writes it | no | **yes** |
| `DATABASE_URL` (with `POSTGRES_PASSWORD`) | `.env` only | no | **yes** | no |
| `OPS_PASSWORD` | `.env` only | no | **yes** | no |
| `METRICS_TOKEN` | `.env` only | no | **yes** | no |
| `DEPLOY_RUNNER_TOKEN` | `.env` only | no | **yes** | no |

**Read that last column again.** A PostgreSQL dump of this deployment contains live credentials in
plaintext — the same exposure `.env` has always carried, now in a second place. `scripts/backup.sh`
writes those dumps to `./backups`. Treat a dump exactly as you treat `.env`: it is not an archive of
public data, and production copies must be encrypted before they leave the host.
[`docs/PRIVACY.md`](PRIVACY.md) states this too, because it is the kind of fact that has to be true
in more than one place to be found.

Nothing in `app_settings` is encrypted at rest, and that is a deliberate limit rather than a
shortcut: the key would have to live beside the data, on the same host, readable by the same
process — which is the same exposure with more moving parts. The same reasoning already applies to
`codex_credentials` (migration `017`).

---

## Minimum to see real data

Steps 1 and 2. Everything else is optional or self-generated.

```env
TELEGRAM_API_ID=…
TELEGRAM_API_HASH=…
TELEGRAM_SESSION=…
TELEGRAM_BOT_TOKEN=…
TELEGRAM_BOT_USERNAME=…
DEMO_SOURCE_ENABLED=false
```

```bash
docker compose up --build -d
```

After the first boot, everything above except the thirty `.env`-only keys can be changed from
`/ops/settings` without touching a file. The operations runbook has the `curl` equivalents:
[`docs/OPERATIONS.md`](OPERATIONS.md), "Settings from /ops".
