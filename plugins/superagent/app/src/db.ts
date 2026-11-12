import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,           -- source-unique, so receiving it twice is a no-op
  source TEXT NOT NULL,
  thread TEXT NOT NULL,
  kind TEXT NOT NULL,            -- issue | comment | review | review_comment | ci | pr_state | panel
  author TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  meta TEXT,                     -- JSON: ci outcome, pr number/state, reply target
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  decision TEXT,                 -- new | followup | context | stop | filtered | ignored
  reason TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  thread TEXT NOT NULL,
  origin_trigger TEXT NOT NULL,
  requester TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | ended
  end_reason TEXT,                          -- completed | merged | closed | dropped | stopped
  stopped_by_person INTEGER NOT NULL DEFAULT 0,
  report TEXT,                              -- last status reported by the worker
  report_question TEXT,
  report_summary TEXT,
  roster_id TEXT,                           -- the model working on it now
  route_reason TEXT,
  branch TEXT NOT NULL,
  dir TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  running INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  review_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  ticket_id INTEGER NOT NULL,
  roster_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (ticket_id, roster_id)
);
CREATE TABLE IF NOT EXISTS inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- assignment | followup | context | recovery | review
  trigger_id TEXT,
  author TEXT,
  body TEXT NOT NULL,
  wakes INTEGER NOT NULL DEFAULT 1,
  turn_id INTEGER,                -- set when delivered
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  ticket_id INTEGER NOT NULL,
  thread TEXT NOT NULL,
  PRIMARY KEY (ticket_id, thread)
);
CREATE TABLE IF NOT EXISTS prs (
  ticket_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',       -- open | merged | closed
  PRIMARY KEY (ticket_id, number)
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  roster_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',      -- worker | reviewer
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ok INTEGER,
  error TEXT,
  cost_usd REAL,
  text TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER,
  source TEXT NOT NULL,
  thread TEXT NOT NULL,
  reply_to TEXT,
  purpose TEXT NOT NULL,          -- ack | answer | result | attention
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  sent_at TEXT,
  dropped_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
  roster_id TEXT PRIMARY KEY,
  until TEXT NOT NULL,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS panel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type Row = Record<string, any>;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
  }

  all(sql: string, ...params: any[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }
  get(sql: string, ...params: any[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }
  run(sql: string, ...params: any[]) {
    return this.raw.prepare(sql).run(...params);
  }

  /** Runs fn in one transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  cursor(key: string): string | undefined {
    return this.get("SELECT value FROM cursors WHERE key = ?", key)?.value;
  }
  setCursor(key: string, value: string) {
    this.run(
      "INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

export const now = () => new Date().toISOString();
