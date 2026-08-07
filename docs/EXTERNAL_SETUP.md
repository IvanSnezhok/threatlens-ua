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

## 7. Codex over ChatGPT OAuth — `CODEX_*` *(optional, and currently unverified)*

**Read this before spending time on it.**

The intent is to run inference on a ChatGPT plan instead of an API key. The configuration exists:

```env
CODEX_BASE_URL=
CODEX_API_KEY=              # OAuth access token, sent as a bearer
CODEX_MODEL=
CODEX_ACCOUNT_ID=           # becomes the ChatGPT-Account-Id header
```

Three caveats, all of them real:

1. **The transport here is a guess.** It is implemented as OpenAI-compatible
   `POST {CODEX_BASE_URL}/chat/completions`, because no credentials were available to test against
   the live service. Codex actually speaks the **Responses API**, a different request shape. Point
   `CODEX_BASE_URL` at a compatible proxy, or the `/responses` shape has to be implemented.
2. **There is no token refresh.** The access token expires and nothing renews it. The narrative
   falls back to deterministic text — nothing breaks, but nothing works either.
3. **It is outside what that authorisation is for.** Codex sign-in is meant for the Codex client, not
   for a third-party server running around the clock. The risk is account action.

If you still want it: install the Codex CLI, run `codex login`, and read the access token and account
id out of `~/.codex/auth.json`.

With `CODEX_*` empty the narrative falls back to `AI_*`, and then to no model at all.

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
