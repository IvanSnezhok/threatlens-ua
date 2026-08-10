-- ================================================================================================
-- The .env moves into the database — everything except the keys that must not
-- ================================================================================================
--
-- What was reported
-- -----------------
-- «Хочу міняти налаштування з /ops, а не редагувати .env і перезапускати контейнер.» Ninety-four
-- variables live in `.env.example` today. Changing any one of them means an SSH session, an editor,
-- `docker compose up -d`, and a window in which the site is down — for decisions as small as «постав
-- таймаут моделі на 30 секунд» and as urgent as «токен Ukraine Alarm протух, ось новий».
--
-- Migration 022 already made this argument for six values and named its own limit: «an operational
-- judgement that requires editing .env and restarting the container is a judgement that will not be
-- made in time». 018 made it for the Codex switches, 017 for the OAuth session, 028 for the storm
-- guard. Each of those carved out one named question and gave it a typed table with typed columns.
-- This table is the general case, and the general case cannot be typed columns: `src/config.ts` is
-- the schema, it changes with the code, and a migration per new setting is the friction this whole
-- feature exists to remove.
--
-- Why text keys and text values, with no CHECK on either
-- -----------------------------------------------------
-- The value column holds the ENVIRONMENT-STRING form of a setting — exactly the bytes that would
-- have been on the right-hand side of an `=` in `.env`, before zod coerces, trims, lowercases or
-- transforms them. `'true'`, `'15'`, `'Europe/Kyiv'`. That is deliberate and it is the whole design:
--
--   * There is then exactly ONE validator in the system, `parseAppConfig` in `src/config.ts`, and it
--     is the same one that has always decided whether the deployment may boot. A CHECK constraint
--     here would be a SECOND, weaker statement of the same rules — `PUBLICATION_DELAY_SECONDS
--     BETWEEN 5 AND 60` restated in SQL — and the two would drift the first time the zod bound
--     moved. Migration 022 has that shape (four CHECKs, restated in `RUNTIME_SETTINGS_BOUNDS`, with
--     a comment explaining that the transcription is how they drift); it is tolerable there because
--     it is four numbers on a frozen row. Across ninety-four keys that change with every release it
--     would be a standing lie.
--   * A row is therefore never trusted on read. `loadAppSettings()` overlays the store on
--     `process.env` and re-parses the WHOLE configuration; a row that does not survive that parse is
--     dropped, reported on the settings page as `rejected`, and the environment's value stands. The
--     database cannot make the process unbootable, which is the property a CHECK constraint would
--     be trying to provide and would provide worse.
--   * No `value_kind` column for the same reason. The kind is `src/config.ts`'s to know — it is the
--     zod schema — and a column duplicating it would be a second source of truth that no code reads.
--
-- Nothing is seeded. An absent row means «this key is whatever .env or the default says», which is
-- the state every deployment starts in and the state `null` in `PUT /ops/api/settings` returns a key
-- to. Seeding ninety-four rows with their defaults would make «за замовчуванням» and «оператор
-- явно обрав те саме значення» indistinguishable, and the settings page exists to tell them apart.
--
-- Why the secrets share this table, and what that costs
-- -----------------------------------------------------
-- Nine of the settings are bearer credentials — the bot token, the MTProto session, two provider
-- tokens, two model keys. They are stored here, in plaintext, beside `MAP_STYLE_URL`. There is no
-- `is_secret` column: which keys are secret is a property of what the value IS, so it is declared
-- once in `APP_SETTINGS` in `src/config.ts` and read from there by the one serialisation function
-- that builds the ops payload. A boolean column here would be a second answer that a hand-edited row
-- could set to `false`, and the serialiser would then publish a token because a row said it was safe
-- to.
--
-- The exposure is the one migration 017 already accepted for `codex_credentials`, and it is restated
-- rather than assumed:
--
--   * Anyone who can read this table can act as the bot, as the MTProto account, and as whatever
--     model account is configured, until those credentials are rotated. That was already true of
--     `.env` on the same host; what changes is that the credentials are now ALSO in every database
--     dump.
--   * **The backups are the new surface.** `compose.yaml` runs a `pg_dump` on a timer with
--     `BACKUP_RETENTION_DAYS` of retention. Before this migration those files held alert history;
--     from this migration they hold the bot token as well, for as long as retention keeps them, and
--     rotating a leaked credential does not un-leak the copies already written. `docs/PRIVACY.md`
--     and `docs/TOKENS.md` say so in as many words. A backup file is now a credential file: it wants
--     the file permissions and the off-host destination that implies.
--   * Encryption at rest is deliberately NOT attempted, for the reason 017 gives: the key would have
--     to live beside the data in the same compose file, so it would document a protection that does
--     not exist. The honest controls are the ones that hold — the value never leaves the server (the
--     ops API returns `isSet` and never the value, proven by a substring search over the whole
--     payload in `tests/integration/ops-settings.test.ts`), no public route reads this table, and a
--     `null` write drops the row.
--
-- Why no polling and no TTL
-- -------------------------
-- The store is read exactly twice: once at boot, between `migrate()` and `buildServer()`, and again
-- inside the transaction that writes it. There is no cache expiry and no background refresh, because
-- this deployment is single-replica and single-writer — the `/ops` API is the only writer, and it is
-- in the same process as every reader. `Object.assign(config, next)` after the COMMIT is what makes
-- a change visible, and it is visible to everything that reads `config.KEY` at call time. Adding a
-- TTL would buy nothing this process cannot already see, and would turn every settings read into a
-- statement on a pool the ingestion tick and every snapshot share. If a second replica is ever run,
-- this is the assumption that has to be revisited first; it is the same assumption
-- `runtime-settings.ts`, `shadow-classifier.ts` and `ingestion.ts` already state.

CREATE TABLE IF NOT EXISTS app_settings (
  -- The environment variable name, verbatim. Not lower-cased and not namespaced: the operator, the
  -- `.env.example` line, the `docs/OPERATIONS.md` recipe and this row all say `AI_TIMEOUT_MS`.
  key        text        PRIMARY KEY,
  -- The env-string form. NOT NULL because absence is expressed by the absence of the row — a NULL
  -- here would be a third state ("set, to nothing") that `candidateEnv` would have to invent a
  -- meaning for. An empty string is a legitimate value and means what it means in `.env`: for the
  -- credential keys it is «not configured», which is how a token is cleared without deleting the
  -- operator's decision to clear it.
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL DEFAULT 'system'
);

COMMENT ON TABLE app_settings IS
  'Operator overrides for src/config.ts, keyed by environment variable name. Values are env-STRING form and are validated only by parseAppConfig; a row that fails the parse is dropped at boot and reported, never applied. Holds bearer credentials in plaintext — see the migration header and docs/PRIVACY.md.';
COMMENT ON COLUMN app_settings.value IS
  'Exactly the bytes that would follow ''='' in .env, before any zod coercion or transform. Empty string is a value; absence of the row is the absence of an override.';
COMMENT ON COLUMN app_settings.updated_by IS
  'config.OPS_USER of the operator who wrote the row, or ''system'' for anything this repository writes itself.';

-- ================================================================================================
-- Audit trail: one row per changed key, and never the value of a secret
-- ================================================================================================
--
-- Same shape and same argument as `runtime_settings_audit` (migration 022): one row per changed
-- field rather than a snapshot per save, so «хто зняв токен і коли» is answered by reading the table
-- instead of by diffing two blobs. Append-only; nothing ever updates a row here.
--
-- The one difference from 022 is what a secret writes. `previous_value`/`new_value` for a key
-- classified `db_secret` in `APP_SETTINGS` are the literal strings «замінено» and «знято» — never
-- the credential, not even the old one, not even truncated. An audit table that recorded the
-- previous token would defeat the whole serialisation discipline on the surface that is most likely
-- to be copied into a support thread, and the question this trail answers is «коли змінили», which
-- those two words answer completely.
--
-- `new_value` is NOT NULL, exactly as in 022, so a reset is written as «знято» rather than as a NULL
-- a reader would have to distinguish from a missing column.

CREATE TABLE IF NOT EXISTS app_settings_audit (
  id             bigserial   PRIMARY KEY,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     text        NOT NULL,
  -- The environment variable name. Called `field` rather than `key` to match
  -- `runtime_settings_audit`, which the ops console already renders with the same component.
  field          text        NOT NULL,
  previous_value text,
  new_value      text        NOT NULL,
  source         text        NOT NULL DEFAULT 'ops_api'
                             CHECK (source IN ('ops_api','migration','system'))
);

-- Two indexes, because there are two questions. «Що взагалі змінювали останнім часом» is the
-- settings page's twenty-row tail; «хто і коли чіпав саме цей ключ» is the per-field history behind
-- one row, and without the second index it is a sequential scan over the whole trail.
CREATE INDEX IF NOT EXISTS app_settings_audit_changed_idx
  ON app_settings_audit (changed_at DESC);
CREATE INDEX IF NOT EXISTS app_settings_audit_field_idx
  ON app_settings_audit (field, changed_at DESC);

COMMENT ON TABLE app_settings_audit IS
  'Append-only record of every app_settings change: who, when, from what, to what. For keys classified db_secret the two value columns hold «замінено»/«знято» and never the credential.';
