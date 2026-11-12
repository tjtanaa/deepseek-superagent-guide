import { type Db, now } from "./db.ts";
import type { Source } from "./sources/types.ts";

/** Sends stored messages in order per thread, retrying with backoff (5 s doubling to 300 s). */
export class Outbox {
  private db: Db;
  private sources: Record<string, Source>;
  private log: (m: string) => void;
  constructor(db: Db, sources: Record<string, Source>, log: (m: string) => void = (m) => console.log(`[outbox] ${m}`)) {
    this.db = db;
    this.sources = sources;
    this.log = log;
  }

  /** Sends until every thread is empty or waiting on a retry. */
  async flush() {
    for (let i = 0; i < 100; i++) if (!(await this.flushOnce())) return;
  }

  private async flushOnce(): Promise<boolean> {
    let progressed = false;
    const heads = this.db.all(
      `SELECT * FROM outbox o WHERE sent_at IS NULL AND dropped_reason IS NULL
       AND id = (SELECT MIN(id) FROM outbox p WHERE p.thread = o.thread AND p.sent_at IS NULL AND p.dropped_reason IS NULL)`,
    );
    const t = now();
    for (const row of heads) {
      if (row.next_at > t) continue;
      const source = this.sources[row.source];
      if (!source) {
        this.db.run("UPDATE outbox SET dropped_reason = ? WHERE id = ?", `no source ${row.source}`, row.id);
        progressed = true;
        continue;
      }
      let res;
      try {
        res = await source.send(row);
      } catch (e) {
        res = { ok: false as const, permanent: false, error: String(e) };
      }
      if (res.ok) {
        this.db.run("UPDATE outbox SET sent_at = ?, attempts = attempts + 1 WHERE id = ?", now(), row.id);
        progressed = true;
      } else if (res.permanent) {
        this.db.run("UPDATE outbox SET dropped_reason = ?, attempts = attempts + 1 WHERE id = ?", res.error, row.id);
        this.log(`dropped message ${row.id}: ${res.error}`);
        progressed = true;
      } else {
        const delay = Math.min(300, 5 * 2 ** row.attempts) * 1000;
        this.db.run(
          "UPDATE outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?",
          new Date(Date.now() + delay).toISOString(), row.id,
        );
        this.log(`message ${row.id} failed, retry in ${delay / 1000}s: ${res.error}`);
      }
    }
    return progressed;
  }
}
