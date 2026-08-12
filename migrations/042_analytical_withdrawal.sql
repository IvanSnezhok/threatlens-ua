-- Who took a model event off the map, and on what grounds.
--
-- Migration 040 gave a high-confidence shadow verdict the right to CREATE one unverified analytical
-- event. Nothing was ever given the right to end one early. That asymmetry is not an oversight in
-- the withdrawal machinery — it is the deliberate shape of it: `src/repositories/events.ts` gates
-- the whole retraction path on `!options.modelPromotion`, because a model that could withdraw would
-- be a model that can take a HUMAN source's live warning off a public map, and `CONTEXT.md`
-- §Межі безпеки puts that outside what analysis may do. The gate is right and stays.
--
-- The cost of it is that a wrong model event has exactly one exit: the thirty-minute validity window
-- in `THREAT_VALIDITY_MS` running out. An operator looking at an obviously false analytical pin —
-- the model read a news retrospective as a live threat, or resolved «Миру» to the wrong oblast —
-- has no button, and the pin stays on a public map and in a Telegram channel for up to half an hour
-- while they watch. Half an hour is not a rounding error on a surface people read to decide whether
-- to move to a shelter.
--
-- So the exit is added on the other side of the boundary: not as authority granted to the model, but
-- as authority granted to a human over the model's output alone. `withdrawAnalyticalEvent`
-- (src/repositories/events.ts) filters on `threat_events.origin='model'` (migration 041) in the
-- UPDATE itself, so the path cannot reach a deterministic event even when handed its id.
--
-- This table is the trace that decision leaves. An operator who can silently remove a published
-- warning is an operator whose removals cannot be reviewed, and the review is the whole reason the
-- capability is acceptable: every row here names a person, a moment, a reason and the event, and
-- the row is written in the SAME transaction as the status change, so a withdrawal that happened
-- and a withdrawal that was recorded are the same set.
--
-- Nothing that writes here touches `alert_source_states`, `alert_periods`, `threat_assertions` or
-- `notification_outbox`. An official alert is a different domain with a different mandate, and a
-- source's own assertion rows are that source's statements — a human channel does not stop having
-- said what it said because an operator removed the model's reading of it.
CREATE TABLE IF NOT EXISTS analytical_withdrawals (
  -- The event, as the primary key rather than beside a surrogate id. `withdrawn` is terminal and the
  -- writer refuses any event that is not live, so one event can be withdrawn at most once and the
  -- natural key is also the idempotency guard: a double-click on the ops button, or a retry of a
  -- request whose response was lost, conflicts here instead of writing a second audit row that would
  -- read as a second decision.
  event_id uuid PRIMARY KEY REFERENCES threat_events(id) ON DELETE CASCADE,

  -- The status the event held immediately before, copied rather than inferred. `threat_events.status`
  -- is now `withdrawn` and cannot answer «what was taken away»; `event_updates` carries the same
  -- pair, but reading the audit of a removal through a table that every lifecycle transition writes
  -- to means reconstructing this row from a timestamp join. An audit that needs a join to be read is
  -- an audit that gets read wrong.
  previous_status text NOT NULL CHECK (previous_status IN ('observed','confirmed','active')),

  -- Free prose, bounded at both ends. The lower bound is the point: «no» and «bad» are not reasons,
  -- and a reason field that accepts them produces an audit log that documents nothing. Eight
  -- characters is the same floor `source_enabled_audit.reason` (migration 037) sets for the same
  -- decision shape — an operator overriding an automated surface — and the ceiling keeps a paste of
  -- a whole channel history out of a column that /ops renders inline.
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),

  -- The ops account from the Basic credentials, or the literal 'system' for the unattended sweep.
  -- Not nullable and not defaulted: a withdrawal whose actor is unknown is the one row this table
  -- exists to make impossible.
  withdrawn_by text NOT NULL CHECK (length(btrim(withdrawn_by)) > 0),

  -- Which of the two paths wrote the row.
  --   'operator'         — a human pressed the button in /ops
  --   'auto_unconfirmed' — the event stood for ANALYTICAL_UNCONFIRMED_CLOSE_MINUTES without any
  --                        corroboration and the sweep closed it (off by default; see src/config.ts)
  -- Stored rather than derived from `withdrawn_by='system'` because the two answer different
  -- questions and will not stay equivalent: an unattended path invoked under a service account would
  -- silently start reading as an operator decision.
  mode text NOT NULL CHECK (mode IN ('operator','auto_unconfirmed')),

  withdrawn_at timestamptz NOT NULL DEFAULT now()
);

-- The reading list is always «what was withdrawn recently», never «what happened to event X» — the
-- latter is a primary-key lookup and needs no index. Descending because /ops shows the newest first
-- and an operator reviewing the last shift reads exactly the head of this order.
CREATE INDEX IF NOT EXISTS analytical_withdrawals_recent_idx
  ON analytical_withdrawals(withdrawn_at DESC);

COMMENT ON TABLE analytical_withdrawals IS
  'Append-only audit of early terminations of model-authored (origin=model) threat events. Writing a row never touches official alert state; the writer filters on origin=model in SQL so a deterministic or human-sourced event cannot be reached from this path.';

COMMENT ON COLUMN analytical_withdrawals.previous_status IS
  'Live status the event held before it moved to withdrawn — the thing that was actually taken off the map';

COMMENT ON COLUMN analytical_withdrawals.mode IS
  'operator = a human pressed the button in /ops; auto_unconfirmed = the unattended sweep closed an analytical event no source corroborated';

COMMENT ON COLUMN analytical_withdrawals.withdrawn_by IS
  'Ops account that made the decision, or the literal system for the unattended sweep';
