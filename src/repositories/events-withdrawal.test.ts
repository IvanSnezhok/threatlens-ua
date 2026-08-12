import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reach of the analytical withdrawal path, asserted as SQL rather than as behaviour.
 *
 * What is being defended here is not a feature but a boundary. `withdrawAnalyticalEvent` is the
 * first thing in this codebase that can end a live public threat event on an operator's say-so, and
 * the single property that makes it acceptable is that it physically cannot reach an event the
 * deterministic rules or a human channel authored. A behavioural test — "call it on a deterministic
 * event and observe that nothing changed" — would pass just as well against an implementation that
 * checks `origin` in TypeScript and then issues an unguarded UPDATE, which is one careless refactor
 * away from reaching everything. So these tests read the statements themselves: the parameter lists
 * and the WHERE clauses handed to node-pg are the artefact the guarantee lives in.
 *
 * The fake client is the same device `./events.test.ts` uses, for the same reason: the decision under
 * test is taken from one column of one row, and driving it through live PostgreSQL would prove the
 * same branch through a truncate, a catalogue and a migration run — and prove it only where an
 * integration database exists. What a fake cannot check is that `analytical_withdrawals` exists and
 * that the CHECK constraints hold; that belongs to `migrations/042_analytical_withdrawal.sql` and to
 * `tests/integration/analytical-withdrawal.test.ts`, which asserts the same guard against a real
 * database and against the official tables this path must never touch.
 */

interface RecordedQuery { text: string; params: unknown[] }

const queries: RecordedQuery[] = [];
const poolQueries: RecordedQuery[] = [];

/**
 * The row `SELECT ... FOR UPDATE` finds. `null` means "no such event", which is how the `not_found`
 * branch is driven without a second mock.
 */
let eventRow: { status: string; origin: string; evidence_level: string } | null = null;

/** Ids the candidate scan returns, for the unattended-sweep cases. */
let sweepCandidates: Array<{ id: string }> = [];

function respond(text: string): { rows: unknown[]; rowCount: number } {
  if (/FROM threat_events WHERE id=\$1 FOR UPDATE/.test(text)) {
    return eventRow ? { rows: [eventRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // The guarded UPDATE. It reports one row only when the fake row would really have matched its
  // WHERE — otherwise this fake would hide exactly the disagreement the `!closed.rowCount` branch
  // exists to catch.
  if (/UPDATE threat_events SET status='withdrawn'/.test(text)) {
    const matches = eventRow?.origin === 'model'
      && ['observed', 'confirmed', 'active'].includes(eventRow.status);
    return { rows: [], rowCount: matches ? 1 : 0 };
  }
  if (/INSERT INTO system_event_log/.test(text)) return { rows: [{ version: '77' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

const client = {
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    return respond(text);
  }),
  release: vi.fn()
};

vi.mock('../db/pool.js', () => ({
  pool: {
    connect: async () => client,
    query: async (text: string, params: unknown[] = []) => {
      poolQueries.push({ text, params });
      if (/FROM threat_events e/.test(text)) return { rows: sweepCandidates, rowCount: sweepCandidates.length };
      return { rows: [], rowCount: 0 };
    }
  }
}));

const { withdrawAnalyticalEvent, withdrawUnconfirmedAnalyticalEvents } = await import('./events.js');

const EVENT = '11111111-1111-4111-8111-111111111111';

/** Every statement issued on the transaction client, as one string. */
function transcript(): string {
  return queries.map((query) => query.text).join('\n');
}

function find(pattern: RegExp): RecordedQuery | undefined {
  return queries.find((query) => pattern.test(query.text));
}

/**
 * Statements that write. Matched on the leading verb rather than on the word appearing anywhere,
 * because `SELECT ... FOR UPDATE` — the read every refusal below is diagnosed from — contains the
 * word `UPDATE` and is not a write.
 */
function mutations(): string[] {
  return queries.map((query) => query.text.trim()).filter((text) => /^(UPDATE|INSERT)\b/.test(text));
}

beforeEach(() => {
  queries.length = 0;
  poolQueries.length = 0;
  eventRow = { status: 'observed', origin: 'model', evidence_level: 'unverified' };
  sweepCandidates = [];
  client.query.mockClear();
  client.release.mockClear();
});

describe('withdrawAnalyticalEvent', () => {
  /**
   * THE test. A deterministic event is what every human report and every official mirror is, so this
   * one case stands for "the operator button cannot reach anything a person wrote".
   *
   * The assertion is not on the return value alone. It is that the transaction issued no statement
   * that writes anything at all — no UPDATE, no INSERT, not even the audit row — and ended in
   * ROLLBACK. A refusal that still recorded something would mean the path had reached the event.
   */
  it('refuses a deterministic event and writes nothing', async () => {
    eventRow = { status: 'active', origin: 'deterministic', evidence_level: 'monitoring' };

    const result = await withdrawAnalyticalEvent(EVENT, { reason: 'помилкова подія', withdrawnBy: 'operator' });

    expect(result.outcome).toBe('not_model');
    expect(result.origin).toBe('deterministic');
    expect(result.version).toBeNull();
    expect(mutations()).toEqual([]);
    expect(transcript()).toMatch(/ROLLBACK/);
    expect(transcript()).not.toMatch(/COMMIT/);
  });

  /**
   * The same refusal stated as the property that survives a refactor: the mutating statement carries
   * the origin filter itself, so the TypeScript check above it is a diagnosis and not the guard.
   *
   * Written against the statement text rather than against an outcome deliberately — if somebody
   * moves the check into a helper, deletes it, or reorders the transaction, the guard is still in the
   * UPDATE and this test still passes; if somebody removes it FROM the UPDATE, this test fails even
   * though every behavioural test would still be green.
   */
  it('carries origin=model inside the mutating statement, not only in the pre-check', async () => {
    await withdrawAnalyticalEvent(EVENT, { reason: 'модель помилилась', withdrawnBy: 'operator' });

    const update = find(/UPDATE threat_events SET status='withdrawn'/);
    expect(update).toBeDefined();
    expect(update!.text).toMatch(/origin='model'/);
    expect(update!.text).toMatch(/status = ANY/);
  });

  it('withdraws a live model event and records the audit row in the same transaction', async () => {
    const result = await withdrawAnalyticalEvent(EVENT, {
      reason: 'ретроспектива, прочитана як жива загроза', withdrawnBy: 'operator'
    });

    expect(result).toEqual({
      outcome: 'withdrawn', eventId: EVENT, previousStatus: 'observed', origin: 'model', version: 77
    });
    const audit = find(/INSERT INTO analytical_withdrawals/);
    expect(audit).toBeDefined();
    expect(audit!.params).toEqual([
      EVENT, 'observed', 'ретроспектива, прочитана як жива загроза', 'operator', 'operator'
    ]);
    // The audit and the status change are one transaction, so "withdrawn" and "recorded as
    // withdrawn" cannot become different sets.
    expect(transcript()).toMatch(/COMMIT/);
    expect(transcript()).not.toMatch(/ROLLBACK/);
  });

  /**
   * `event_updates` is what the dialog behind the marker renders as «Історія змін». The evidence
   * level is carried across unchanged on purpose: how well corroborated a claim was does not change
   * because the claim was taken back, and moving it would make the archive misreport the past.
   */
  it('leaves the evidence level untouched in the lifecycle trail', async () => {
    eventRow = { status: 'confirmed', origin: 'model', evidence_level: 'unverified' };

    await withdrawAnalyticalEvent(EVENT, { reason: 'хибна геолокація', withdrawnBy: 'operator' });

    const update = find(/INSERT INTO event_updates/);
    expect(update!.params).toEqual([
      EVENT, 'confirmed', 'unverified', 'operator_withdrew_analytical_event'
    ]);
  });

  /**
   * `system_event_log` is read by the PUBLIC `/api/v1/stream`. An operator's free-prose note and the
   * ops account name are internal, and recording them in the payload would publish them verbatim —
   * the act of auditing would become the leak.
   */
  it('publishes a fixed token, never the operator note or the account name', async () => {
    await withdrawAnalyticalEvent(EVENT, {
      reason: 'канал жартує, прибрав вручну', withdrawnBy: 'nataliia'
    });

    const logged = find(/INSERT INTO system_event_log/);
    expect(logged!.params[0]).toBe('threat.withdrawn');
    const payload = JSON.parse(String(logged!.params[1]));
    expect(payload).toEqual({ eventId: EVENT, reason: 'operator_withdrew_analytical_event' });
    expect(String(logged!.params[1])).not.toContain('жартує');
    expect(String(logged!.params[1])).not.toContain('nataliia');
  });

  it('reports an unknown event apart from a refused one', async () => {
    eventRow = null;

    const result = await withdrawAnalyticalEvent(EVENT, { reason: 'невідомий id', withdrawnBy: 'operator' });

    expect(result.outcome).toBe('not_found');
    expect(mutations()).toEqual([]);
  });

  /**
   * A model event the expiry sweep already retired. The refusal matters because the alternative —
   * withdrawing it again — would write a second terminal transition and a second SSE frame about an
   * event that stopped existing on the map minutes ago.
   */
  it('refuses an event that is no longer live', async () => {
    eventRow = { status: 'expired', origin: 'model', evidence_level: 'unverified' };

    const result = await withdrawAnalyticalEvent(EVENT, { reason: 'вже не активна', withdrawnBy: 'operator' });

    expect(result.outcome).toBe('not_live');
    expect(result.previousStatus).toBe('expired');
    expect(mutations()).toEqual([]);
  });

  /**
   * The official surface, stated as an absence.
   *
   * `CONTEXT.md` §Межі безпеки: офіційні сигнали завжди мають пріоритет над аналітикою. This path
   * removes an analytical claim, so it must not be able to reach the tables that hold an official
   * one — nor a source's own assertions, which are a human channel's statements and do not stop
   * being true because an operator removed the model's reading of them.
   */
  it('never names an official or source-owned table', async () => {
    await withdrawAnalyticalEvent(EVENT, { reason: 'прибрано оператором', withdrawnBy: 'operator' });

    for (const table of [
      'alert_source_states', 'alert_periods', 'threat_assertions',
      'notification_outbox', 'risk_signals'
    ]) {
      expect(transcript()).not.toContain(table);
    }
  });
});

describe('withdrawUnconfirmedAnalyticalEvents', () => {
  /**
   * Off is the shipped default, and off has to mean "does not run" rather than "runs and matches
   * nothing" — a sweep that scans on every tick of a disabled feature is a cost paid for a capability
   * nobody switched on, and a scan that returns rows for a threshold of zero would close every
   * analytical event the instant it was created.
   */
  it('does nothing at all when the threshold is zero', async () => {
    const results = await withdrawUnconfirmedAnalyticalEvents(0);

    expect(results).toEqual([]);
    expect(poolQueries).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  /**
   * The candidate scan is where "unconfirmed" is defined, so the definition is asserted rather than
   * described. `evidence_role NOT LIKE 'model:%'` is the same exclusion the corroboration check in
   * `ingestThreat` uses: a second model verdict is not a second opinion.
   */
  it('selects only model events that nothing outside the model has corroborated', async () => {
    await withdrawUnconfirmedAnalyticalEvents(12);

    const scan = poolQueries[0]!;
    expect(scan.text).toMatch(/e\.origin='model'/);
    expect(scan.text).toMatch(/e\.evidence_level='unverified'/);
    expect(scan.text).toMatch(/NOT EXISTS/);
    expect(scan.text).toMatch(/evidence_role NOT LIKE 'model:%'/);
    // The clock is when WE published, never the publisher's declared time: a back-dated post would
    // otherwise be overdue the moment it was created.
    expect(scan.text).toMatch(/e\.created_at <= now\(\)/);
    expect(scan.params[1]).toBe('12');
  });

  /**
   * Every candidate goes through the guarded function rather than through a bulk UPDATE, so there is
   * exactly one statement in this codebase that can end a model event. The proof is that the sweep's
   * writes carry the same `origin='model'` filter — and that a candidate which turns out to be
   * deterministic (a row that changed between the scan and the write) is refused by that filter
   * rather than by the scan that selected it.
   */
  it('routes each candidate through the same guarded write', async () => {
    sweepCandidates = [{ id: EVENT }];

    const results = await withdrawUnconfirmedAnalyticalEvents(12);

    expect(results).toEqual([{
      outcome: 'withdrawn', eventId: EVENT, previousStatus: 'observed', origin: 'model', version: 77
    }]);
    expect(find(/UPDATE threat_events SET status='withdrawn'/)!.text).toMatch(/origin='model'/);
    const audit = find(/INSERT INTO analytical_withdrawals/);
    expect(audit!.params[3]).toBe('system');
    expect(audit!.params[4]).toBe('auto_unconfirmed');
  });

  it('refuses a candidate whose origin changed to deterministic before the write', async () => {
    sweepCandidates = [{ id: EVENT }];
    eventRow = { status: 'observed', origin: 'deterministic', evidence_level: 'unverified' };

    const results = await withdrawUnconfirmedAnalyticalEvents(12);

    expect(results).toEqual([{
      outcome: 'not_model', eventId: EVENT, previousStatus: 'observed',
      origin: 'deterministic', version: null
    }]);
    expect(mutations()).toEqual([]);
  });
});
