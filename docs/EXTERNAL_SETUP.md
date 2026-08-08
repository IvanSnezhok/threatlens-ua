# Credentials: what each one is and how to get it

Every code path in this project exists without these. What they unlock is real data.

Ordered by how much they unlock. The first one turns the product on; the last four are optional.

---

## 1. Telegram collector — `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`

**Unlocks:** official air raid alerts, all-clears, and every monitored channel — 53 sources.
Nothing real arrives without this. It is the only credential the product genuinely needs.

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

The script asks for the two values above, then the phone number, the login code Telegram sends, and
the two-step password if the account has one. It prints a `TELEGRAM_SESSION=` line.

```env
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_SESSION=1BQANOTEuMTA4...
```

**The session string is equivalent to being logged into that account.** It is printed once and never
written to disk by the script. Keep it out of git — `.env` is already ignored. Revoke it from
*Telegram → Settings → Devices* if it leaks, which invalidates it immediately.

It does not expire on its own. Logging that account out of all devices ends it.

---

## 2. Bot — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`

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

A leaked token is revoked with `/revoke` in BotFather.

### `TELEGRAM_ADMIN_CHAT_ID` (optional)

Your own numeric chat id, for operator notices. Get it by messaging
[@userinfobot](https://t.me/userinfobot).

---

## 3. Self-generated secrets — `POSTGRES_PASSWORD`, `OPS_PASSWORD`, `METRICS_TOKEN`

Nobody issues these. Generate them:

```bash
openssl rand -base64 24     # run once per secret
```

```env
POSTGRES_PASSWORD=…
OPS_PASSWORD=…              # 16+ chars, or production refuses to start
METRICS_TOKEN=…             # 16+ chars, same rule
```

`OPS_PASSWORD` guards `/ops` together with `OPS_USER` (default `operator`). `METRICS_TOKEN` guards
`/metrics` outside development.

Production startup **fails** on `change-me`, on anything under 16 characters, on a non-HTTPS
`PUBLIC_URL`, on demo mode left enabled, and on development database credentials. A half-configured
alerting system is worse than one that will not boot.

---

## 4. Domain — `SITE_ADDRESS`, `PUBLIC_HOST`, `PUBLIC_URL`

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

---

## 5. Official alert APIs — `UKRAINE_ALARM_API_TOKEN`, `ALERTS_IN_UA_TOKEN` *(optional)*

**Unlocks:** a second and third independent official source. **Not a prerequisite** — official
alerts already work through the Telegram collector at step 1.

Both are issued on written application, and approval takes as long as it takes:

- **Ukraine Alarm** — request through <https://api.ukrainealarm.com>.
- **Alerts.in.ua** — request through <https://alerts.in.ua>, developer section.

Validate in staging before trusting either: their region identifiers must map onto the local
catalogue. An unmapped location is reported as a catalogue gap rather than guessed at, so a mismatch
shows up as silence, not as a wrong region.

---

## 6. Model — `AI_API_KEY` *(optional)*

**Unlocks:** model-written risk explanations and analytics narrative. Every number is produced by
deterministic SQL either way; the model only writes prose over figures it is given, and any number it
invents is rejected.

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

---

## 7. Codex over ChatGPT OAuth — `CODEX_*` *(optional)*

**Read this before spending time on it.**

The intent is to run inference on a ChatGPT plan instead of an API key. The configuration exists:

```env
CODEX_BASE_URL=https://chatgpt.com/backend-api/codex
CODEX_API_KEY=              # OAuth access token, sent as a bearer
CODEX_MODEL=
CODEX_ACCOUNT_ID=           # becomes the ChatGPT-Account-Id header
CODEX_API_STYLE=auto        # auto | chat | responses
```

Three caveats, all of them real:

1. **Two transports, chosen from the URL.** Against `chatgpt.com/backend-api` the client sends the
   **Responses API** shape the Codex CLI sends — `POST {CODEX_BASE_URL}/responses`, `stream: true`,
   `store: false`, reply read from the SSE stream, JSON contract carried in the instructions since
   that backend has no `response_format`. Any other base URL gets OpenAI-compatible
   `POST {CODEX_BASE_URL}/chat/completions`. `CODEX_API_STYLE` overrides the guess for proxies on a
   confusing URL. The ChatGPT backend also publishes no `/models`, so the model dropdown there is
   the static fallback list by design.
2. **The OAuth client and endpoints are the Codex CLI's, not ours.** `CODEX_OAUTH_CLIENT_ID` and
   `CODEX_OAUTH_ISSUER` carry the values that client publishes. Both are overridable. The sign-in
   itself *has* been exercised against the live service (2026-08-07): the authorisation, the
   loopback callback and the code-for-token exchange all completed and stored a session with a
   refresh token. That says nothing about caveat 1 — obtaining a credential and being able to spend
   it at an endpoint are separate questions.
3. **It is outside what that authorisation is for.** Codex sign-in is meant for the Codex client, not
   for a third-party server running around the clock. The risk is account action.

### Signing in from the operations console

Open `/ops`, find **Codex / ChatGPT** and press **Увійти через ChatGPT**. The browser goes to
ChatGPT, comes back to `http://localhost:1455/auth/callback`, and the session is stored in
PostgreSQL and refreshed from then on. Nothing is written to `.env` and no restart is needed.

One thing still has to be set by hand, because signing in supplies a credential and not an endpoint:

```env
CODEX_BASE_URL=
```

`CODEX_MODEL` and `ANALYTICS_NARRATIVE_ENABLED` remain valid and still work exactly as before, but
they are now defaults rather than the decision. The console states which precondition is missing, so
"connected but silent" is never a mystery.

### Choosing a model and what it may write

`/ops` → **Codex-аналітика** → **Модель і функції**. The model list is fetched from the service on
every read, falling back to a static list (`gpt-5.2`, `gpt-5.2-codex`, `o5`, `o5-mini`, plus
`CODEX_MODEL`) and saying so when the service will not answer. Leaving the dropdown on «за
замовчуванням» defers to `CODEX_MODEL`.

Three switches, all off until somebody turns them on, because the cost of a bad sentence differs by
three orders of magnitude between them:

| Switch | Where the text lands | If the model fails |
|---|---|---|
| Наратив аналітики | the analytics page, operator-facing | deterministic prose, as today |
| Нічний дайджест | Telegram, to every analytics subscriber | the digest goes out with no summary line |
| Аналіз атак | the extrapolation note in `/ops` only | the computed wording, unchanged |

In all three the model only rewords numbers that were already computed, and every digit it writes is
checked against those numbers — one figure the computation did not produce discards the whole text.
Model-written text is labelled as such: `aiGenerated` on the analytics narrative, and an explicit
«написала мовна модель» line in the Telegram digest.

Everything Codex is asked, and everything it answers, is recorded in `ai_runs` and readable in the
same console section — including the calls that never left the process because a switch was off or
the session had expired.

The settings live in `codex_settings` (migration `018`) and hold no credentials.

**The callback is loopback, and that is a hard limit.** The Codex OAuth client accepts exactly one
redirect — `http://localhost:<port>/auth/callback` — and we have no client of our own registered
with OpenAI. So the browser finishing the sign-in and this app have to agree on what `localhost`
means:

| Where the app runs | Sign-in |
|---|---|
| `docker compose` on your own machine | works — compose publishes `127.0.0.1:1455` |
| `npm run dev` on your own machine | works |
| a remote host behind Caddy, browser elsewhere | **never completes** — the callback goes to *your* machine, where nothing is listening |

For the third case, tunnel the port to the server (`ssh -L 1455:localhost:1455 …`) before pressing
the button, or keep using the manual token below.

If port 1455 is busy — the Codex CLI holds it while it is running — the console says so rather than
handing out a URL whose answer would be dropped.

### The manual token, still supported

Install the Codex CLI, run `codex login`, and read the access token and account id out of
`~/.codex/auth.json` into `CODEX_API_KEY` and `CODEX_ACCOUNT_ID`. That token **does not refresh**;
when it expires the narrative falls back to deterministic text until you paste a new one. A session
stored through the button always takes precedence over these two variables.

### What is stored, and how to revoke it

`codex_credentials` holds one row with an access token and a refresh token in plaintext — the same
exposure `TELEGRAM_SESSION` already carries in `.env`, and it is not encrypted because the key
would have to live beside the data. The token never leaves the server: `/ops/codex` returns the
account id and the expiry, never the credential. To revoke, press **Відключити** in the console —
or, if the database is out of reach, remove the session in **ChatGPT → Settings → Connected apps**.

With `CODEX_*` empty and no stored session the narrative falls back to `AI_*`, and then to no model
at all.

---

## Nothing to obtain

These work with no registration and are enabled by default:

| | |
|---|---|
| `@air_alert_ua` and the oblast alert channels | Read through the collector from step 1. |
| KATOTTG location catalogue | Public ministry publication, imported automatically. |
| Raion boundaries | Built from OpenStreetMap, committed to the repository. |
| DeepStateMap occupation layer | Public endpoint. Attribution is emitted in every response; the data is **not** under an open licence, so obtain permission before public distribution or set `OCCUPATION_SOURCE_ENABLED=false`. |
| Basemap | Public tile server. Replace with `MAP_STYLE_URL` for a self-hosted style. |

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
