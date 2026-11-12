import { randomUUID } from "node:crypto";
import { type Db, now, type Row } from "../db.ts";
import type { Trigger } from "../gate.ts";
import type { SendResult, Source } from "./types.ts";

/** Requests typed into the local panel. Threads are `panel:<n>`. */
export class PanelSource implements Source {
  readonly name = "panel";
  private db: Db;
  private user: string;
  constructor(db: Db, user: string) {
    this.db = db;
    this.user = user;
  }

  async poll(): Promise<Trigger[]> {
    return [];
  }

  /** Builds a trigger for a request typed into the panel; `thread` continues an existing one. */
  request(text: string, thread?: string): Trigger {
    const n = thread ?? `panel:${Date.now().toString(36)}`;
    this.db.run("INSERT INTO panel_messages (thread, author, body, created_at) VALUES (?, ?, ?, ?)", n, this.user, text, now());
    return {
      id: `panel:${randomUUID()}`,
      source: "panel",
      thread: n,
      kind: "panel",
      author: this.user,
      isBot: false,
      body: text,
      createdAt: now(),
      meta: { title: text.split("\n")[0]!.slice(0, 80) },
    };
  }

  async send(row: Row): Promise<SendResult> {
    this.db.run(
      "INSERT INTO panel_messages (thread, author, body, created_at) VALUES (?, 'superagent', ?, ?)",
      row.thread, row.body, now(),
    );
    return { ok: true };
  }
}
