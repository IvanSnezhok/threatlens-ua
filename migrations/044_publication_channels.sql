-- A Telegram channel the project publishes TO, as opposed to the subscribers it warns.
--
-- ## What the outbox could not address before this file
--
-- `src/bot/outbox.ts` knows exactly one kind of recipient: a `telegram_users` row that asked for
-- something. Every insert joins `subscriptions`, `notification_outbox.chat_id` is an FK to that
-- table (migration 001), and every deduplication decision is made PER CHAT — `notification_state`
-- is keyed (entity_kind, entity_key, chat_id) and `idempotency_key` carries both the chat id and the
-- `system_event_log` version, so the same threat legitimately produces one row per subscriber and
-- another round of them when the event log moves (see `threadContentHash` / `mergePublishedState`
-- in `src/bot/notification-policy.ts`).
--
-- Both properties are right for a warning and wrong for a channel. A channel has one reader-facing
-- identity and no subscription row, and its unit of publication is the EVENT rather than the event
-- *version*: a channel that receives the same analytical estimate a second time because the event
-- log advanced is a channel that appears to be reporting a second, independent threat over the same
-- oblast. That is the failure this file is shaped around, and it is why the deduplication below is
-- a primary key on (channel, event) instead of another per-chat state row.
--
-- ## What may be published here, and what may never be
--
-- Only `threat_events.origin='model'` (migration 041) — the unverified analytical estimates the
-- shadow classifier is allowed to promote when `codex_settings.analytical_threats_enabled` is on
-- (migration 040). Official alerts do NOT travel this path at all, and neither do deterministic
-- threat events. Two reasons, in order of weight:
--
--   1. An official alert is a state owned by `alert_source_states` / `alert_periods` and it reaches
--      people through the subscriber fanout, which applies their territory filter and never
--      coalesces, never edits and never suppresses. Copying that state into a public channel would
--      create a second, slower, unfiltered publication of the one signal `CONTEXT.md` puts above
--      everything else — and the first time the two disagreed, the channel would be the one people
--      screenshot.
--   2. The channel format (`src/bot/humanize.ts`) opens with «Оцінка моделі. Не підтверджено
--      джерелом. Не є офіційною тривогою.» Publishing an official alert through a formatter that
--      begins by disclaiming itself would be worse than not publishing it.
--
-- If a later decision does put official material in a channel, it needs its own row kind, its own
-- format and its own delivery class — not a widened CHECK on `publishes` below. The column is an
-- enumeration with one value today precisely so that widening it is a visible act.
--
-- Everything here ships OFF: `publication_channels.enabled` defaults to false, no row is seeded, and
-- `PUBLICATION_CHANNEL_ENABLED` (src/config.ts) defaults to false above it. An installation that
-- applies this migration and changes nothing else publishes nothing, exactly as before.

CREATE TABLE IF NOT EXISTS publication_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The channel's Telegram chat id, as the bot API addresses it (a supergroup/channel id is
  -- negative and needs the full 64 bits — `-1001234567890` does not fit in an integer). UNIQUE
  -- because two rows for one channel would defeat the (channel, event) deduplication below by
  -- making the same event publishable twice to the same reader.
  chat_id bigint NOT NULL UNIQUE,
  -- Operator-facing label. The bot never reads a channel title from Telegram: a title fetched at
  -- delivery time would be one more API call on the path that is rate-limited by air-raid traffic,
  -- and the only consumer is a human reading `/ops` or `psql`.
  title text NOT NULL DEFAULT '',
  -- What this channel is allowed to carry. See the header for why this is an enumeration with one
  -- member rather than a boolean or a free-form string.
  publishes text NOT NULL DEFAULT 'model_analysis' CHECK (publishes IN ('model_analysis')),
  -- Off, like every switch that changes what a reader sees. A channel row is created by an operator
  -- who has already added the bot as an administrator; creating the row and granting the rights are
  -- two separate acts, and this column is what keeps the gap between them from being a queue of
  -- messages that fail with 403.
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE publication_channels IS
  'Telegram channels this project publishes model analysis to; disabled until an operator enables one';
COMMENT ON COLUMN publication_channels.chat_id IS
  'Telegram chat id of the channel, as the bot API addresses it (negative for channels)';
COMMENT ON COLUMN publication_channels.publishes IS
  'What the channel carries. model_analysis = threat_events with origin=model only; official alerts never travel this path';
COMMENT ON COLUMN publication_channels.enabled IS
  'Off by default: the row can exist before the bot has administrator rights in the channel';

-- ------------------------------------------------------------------------------------------------
-- Deduplication, at the level of the event
-- ------------------------------------------------------------------------------------------------
--
-- One row per (channel, event), inserted by the fanout BEFORE the outbox row it describes and in the
-- same statement, so the primary key is the thing that decides whether a message is queued at all.
-- `ON CONFLICT DO NOTHING` on this key returns zero rows for an event this channel already has, the
-- outbox insert selects from those zero rows, and nothing is queued — which is the whole guarantee
-- «one event, one message», independent of how many times the fan-out cursor replays the event, how
-- many `threat.updated` versions the event accumulates, and whether the worker crashed mid-pass.
--
-- `notification_outbox.idempotency_key` is kept as a second, weaker guard (it carries no event-log
-- version for these rows), but it cannot be the primary one: it is unique across the whole table and
-- would have to encode the same pair anyway, and a UNIQUE violation on it would abort the
-- surrounding statement instead of quietly declining to publish.
CREATE TABLE IF NOT EXISTS channel_published_events (
  channel_id uuid NOT NULL REFERENCES publication_channels(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE, unlike `analytical_outcomes` (migration 043) which keeps its measurement
  -- after the event is gone. This table is not a measurement: it is a claim that a message about
  -- THIS event was queued, and an event that no longer exists cannot be published again.
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  -- The queued message. DEFERRABLE INITIALLY DEFERRED for one specific reason: the fanout inserts
  -- this row inside a data-modifying CTE whose outer statement inserts the `notification_outbox` row
  -- it points at (the id is chosen here, with gen_random_uuid(), so the claim and the message can be
  -- written in one atomic statement). An immediate check would depend on the exact moment Postgres
  -- fires an AFTER ROW trigger queued from a CTE; deferring it to COMMIT makes the ordering a
  -- documented property of the constraint rather than an assumption about the executor.
  --
  -- ON DELETE SET NULL rather than CASCADE: an outbox row that is deleted (by `/delete_me`, by a
  -- future retention pass) must not make an already-published event publishable a second time.
  outbox_id uuid REFERENCES notification_outbox(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED,
  -- Filled by the delivery worker. Unlike `notification_state.telegram_message_id`, nothing edits a
  -- channel post today; it is stored because a published message id is the only durable link between
  -- an event in this database and a post a reader can be shown, and reconstructing it later is
  -- impossible.
  telegram_message_id bigint,
  queued_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  -- (channel, event) and not (event, channel): every query names the channel first — «what has this
  -- channel already published» — and the insert names both.
  PRIMARY KEY (channel_id, event_id)
);

-- The delivery worker's only lookup: «which publication is this outbox row», once per sent message.
-- UNIQUE because an outbox row describes exactly one publication, and partial because the column is
-- null for as long as a claim outlives its message.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_published_events_outbox
  ON channel_published_events(outbox_id)
  WHERE outbox_id IS NOT NULL;

COMMENT ON TABLE channel_published_events IS
  'One row per (channel, threat event): the event-level deduplication that keeps one event to one channel post';
COMMENT ON COLUMN channel_published_events.outbox_id IS
  'The queued message; deferred FK because the claim and the outbox row are written in one statement';
COMMENT ON COLUMN channel_published_events.telegram_message_id IS
  'Set once Telegram accepted the post — the only durable link from an event to a public message';

-- ------------------------------------------------------------------------------------------------
-- Teaching the outbox that a recipient can be a channel
-- ------------------------------------------------------------------------------------------------
--
-- `notification_outbox.chat_id` has been `REFERENCES telegram_users(chat_id) ON DELETE CASCADE`
-- since migration 001, and a channel is not a `telegram_users` row: it has no `/start`, no
-- subscriptions, no evidence threshold and no place in the subscriber counts that table feeds. The
-- three ways out of that were:
--
--   * insert the channel into `telegram_users` — the cheapest change and the wrong one. Every
--     count of "our users", every `enabled=false` sweep and every future retention pass would then
--     be operating on a row that is not a person.
--   * a second outbox table for channels — a second delivery worker, a second rate-limit budget
--     against the same Telegram account, and two places for the governor of migration 038 to look.
--     The governor exists because ONE budget has to be arbitrated; splitting the queue would undo it.
--   * this: keep one queue, one worker and one budget, drop the FK, and make the discriminator
--     explicit.
--
-- What the FK actually bought is preserved below by trigger, because `/delete_me` promises it:
-- «Telegram-ідентифікатор, підписки, черга повідомлень і журнал нічних зведень видалені»
-- (src/bot/bot.ts). Without the replacement, a deleted user's queued messages would stay in the
-- outbox and still be DELIVERED to them — the one outcome that command must not have.
ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS publication_channel_id uuid REFERENCES publication_channels(id) ON DELETE CASCADE;

ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_chat_id_fkey;

-- The discriminator, as a constraint rather than as a convention. `channel_publication` rows carry a
-- channel and subscriber rows never do — written as an equality between two predicates so that
-- BOTH mistakes are caught: a channel row without a channel (which would be delivered to a chat id
-- nothing owns) and a subscriber row that somehow acquired one (which would make the delivery worker
-- record a publication against a private chat).
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_channel_recipient_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_channel_recipient_check
  CHECK ((publication_channel_id IS NOT NULL) = (notification_type = 'channel_publication'));

COMMENT ON COLUMN notification_outbox.publication_channel_id IS
  'Set exactly on channel_publication rows: the channel this message is addressed to instead of a subscriber';

-- The cascade migration 001 declared, restated as the only thing it was ever used for.
--
-- Deliberately narrower than the FK it replaces in one respect and identical in every other: it
-- leaves channel rows alone (they are not addressed to any user, and a chat id collision between a
-- deleted user and a channel is not a reason to unpublish), and it fails in exactly the same place
-- the cascade failed — `notification_deliveries.outbox_id` is `NOT NULL REFERENCES
-- notification_outbox(id)` with no delete action, so deleting a user who has already been sent
-- something raises a foreign-key violation today and raises the same one after this migration. That
-- is a pre-existing defect of `/delete_me`, not one introduced here, and reproducing it exactly is
-- the point: this migration must not quietly change what that command does.
CREATE OR REPLACE FUNCTION notification_outbox_forget_deleted_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM notification_outbox
   WHERE chat_id = OLD.chat_id AND publication_channel_id IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS telegram_users_forget_outbox ON telegram_users;
CREATE TRIGGER telegram_users_forget_outbox
  AFTER DELETE ON telegram_users
  FOR EACH ROW EXECUTE FUNCTION notification_outbox_forget_deleted_user();

COMMENT ON FUNCTION notification_outbox_forget_deleted_user() IS
  'Replaces the ON DELETE CASCADE dropped from notification_outbox.chat_id: /delete_me still empties the queue';
