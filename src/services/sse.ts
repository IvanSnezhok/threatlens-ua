import { EventEmitter } from 'node:events';
import { pool } from '../db/pool.js';

export interface SystemEvent {
  version: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

class EventHub extends EventEmitter {
  private lastVersion = 0;
  private timer?: NodeJS.Timeout;

  start() {
    if (this.timer) return;
    const poll = async () => {
      try {
        const result = await pool.query(
          `SELECT version,event_type,payload,created_at FROM system_event_log
           WHERE version > $1 ORDER BY version LIMIT 200`, [this.lastVersion]
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
