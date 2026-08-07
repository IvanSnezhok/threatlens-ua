import { EventEmitter } from 'node:events';
import { pool } from '../db/pool.js';

export interface SystemEvent {
  version: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface EventRelay {
  buffer(event: SystemEvent): void;
  deliver(event: SystemEvent): void;
  flush(): void;
}

export function createEventRelay(sinceVersion: number, write: (event: SystemEvent) => void): EventRelay {
  let highest = sinceVersion;
  let pending: SystemEvent[] | null = [];
  const deliver = (event: SystemEvent) => {
    if (event.version <= highest) return;
    highest = event.version;
    write(event);
  };
  return {
    deliver,
    buffer: (event) => { if (pending) pending.push(event); else deliver(event); },
    flush: () => {
      const queued = pending ?? [];
      pending = null;
      for (const event of [...queued].sort((a, b) => a.version - b.version)) deliver(event);
    }
  };
}

class EventHub extends EventEmitter {
  private lastVersion: number | null = null;
  private timer?: NodeJS.Timeout;

  start() {
    if (this.timer) return;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const cursor = this.lastVersion;
        if (cursor === null) {
          const head = await pool.query<{ version: string }>(
            `SELECT COALESCE(max(version),0) AS version FROM system_event_log`
          );
          this.lastVersion = Number(head.rows[0]?.version ?? 0);
          return;
        }
        const result = await pool.query(
          `SELECT version,event_type,payload,created_at FROM system_event_log
           WHERE version > $1 ORDER BY version LIMIT 200`, [cursor]
        );
        for (const row of result.rows) {
          this.lastVersion = Number(row.version);
          this.emit('event', {
            version: this.lastVersion,
            eventType: row.event_type,
            payload: row.payload,
            createdAt: row.created_at.toISOString()
          } satisfies SystemEvent);
        }
      } catch {
        // Readiness and logs report database errors; the hub retries without terminating the app.
        // A failed cursor initialization leaves lastVersion null so the next tick retries instead
        // of replaying the whole log as live events.
      } finally {
        polling = false;
      }
    };
    void poll();
    this.timer = setInterval(poll, 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export const eventHub = new EventHub();
