import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { REDACTED } from './exec.js';
import { openRunJournal, writeDeploymentState } from './journal.js';

/**
 * Редакція живе НА ЦІЙ межі — і тільки на ній.
 *
 * `spawnExec` повертає сирі байти, бо runner порівнює їх з конфігурацією (бойовий інцидент:
 * пароль бази — підрядок назви репозиторію, редакція до порівняння дала вічний remote_mismatch).
 * Отже єдине місце, де секрет не сміє пройти, — запис у журнал. Ці тести пінують саме його.
 */

const SECRET = 'threatlens-secret-password';

function capturingPool(): { pool: pg.Pool; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const pool = {
    query: (_sql: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe('journal redaction boundary', () => {
  it('strips secrets from stage detail, error summary and log tail', async () => {
    const { pool, calls } = capturingPool();
    const journal = openRunJournal(pool, 7, [SECRET]);

    await journal.stage('checking', `origin carries ${SECRET} in its remote`);
    await journal.finish({
      status: 'failed', stage: 'building', errorCode: 'build_failed',
      errorSummary: `docker build printed ${SECRET}`,
      logTail: `…${SECRET}…`
    });

    const flat = JSON.stringify(calls);
    expect(flat).not.toContain(SECRET);
    expect(flat).toContain(REDACTED);
  });

  it('strips secrets from the check-state error and remote url', async () => {
    const { pool, calls } = capturingPool();
    await writeDeploymentState(pool, {
      remoteUrl: `https://user:${SECRET}@github.com/x/y.git`,
      remoteCommit: null,
      workingTreeCommit: null,
      workingTreeDirty: false,
      lastCheckOk: false,
      lastCheckError: `origin is «https://user:${SECRET}@github.com/x/y.git»`,
      runnerVersion: 'test/1'
    }, [SECRET]);

    const flat = JSON.stringify(calls);
    expect(flat).not.toContain(SECRET);
    expect(flat).toContain(REDACTED);
  });

  it('a secret that is a substring of honest text is still cut only at the journal, never before', async () => {
    // Порівняльний рядок (сирий) містить секрет-підрядок — журнал ріже, порівняння вище вже минуло.
    const { pool, calls } = capturingPool();
    const journal = openRunJournal(pool, 8, ['threatlens']);
    await journal.stage('checking', 'origin is https://github.com/IvanSnezhok/threatlens-ua.git');
    expect(JSON.stringify(calls)).toContain(`https://github.com/IvanSnezhok/${REDACTED}-ua.git`);
  });
});
