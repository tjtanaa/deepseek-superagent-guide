// The engine is the only writer of triggers, tickets and inputs. Each command runs
// in one database transaction, so a crash never leaves half a decision behind.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { allowList, type Config } from "./config.ts";
import { type Db, now, type Row } from "./db.ts";
import { gate, type GateDecision, type ThreadTicket, type Trigger } from "./gate.ts";
import { hintedEntries } from "./router.ts";

export const STATUSES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

export type Stage =
  | "ended"
  | "working"
  | "queued"
  | "awaiting-answer"
  | "blocked"
  | "failed"
  | "awaiting-review"
  | "idle";
export const NEEDS_PERSON: Stage[] = ["awaiting-answer", "blocked", "failed", "awaiting-review"];

export class Refused extends Error {}

export class Engine {
  readonly allow: Set<string>;
  readonly agentLogin: string;

  readonly db: Db;
  readonly cfg: Config;

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
    this.allow = allowList(cfg);
    this.agentLogin = cfg.sources.github?.agentLogin ?? "superagent";
  }

  // ---------- triggers ----------

  receive(t: Trigger): { decision: GateDecision | "duplicate"; tickets: number[] } {
    return this.db.tx(() => {
      const ins = this.db.run(
        `INSERT OR IGNORE INTO triggers (id, source, thread, kind, author, is_bot, body, url, meta, created_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id, t.source, t.thread, t.kind, t.author, t.isBot ? 1 : 0, t.body, t.url ?? null,
        JSON.stringify(t.meta ?? {}), t.createdAt, now(),
      );
      if (Number(ins.changes) === 0) return { decision: "duplicate" as const, tickets: [] };

      const tickets = this.threadTickets(t.thread);
      let decision = gate({ trigger: t, agentLogin: this.agentLogin, allow: this.allow, tickets });
      // A person's message never reaches an ended ticket a person stopped; that is in the gate.
      let ids: number[] = [];

      switch (decision.action) {
        case "filtered":
        case "ignored":
          break;
        case "stop":
          for (const id of decision.tickets) this.endTicket(id, "stopped", true);
          this.enqueue(decision.tickets[0]!, t.thread, t, "ack", "Stopped.");
          ids = decision.tickets;
          break;
        case "context":
          ids = this.deliverContext(decision.tickets, t);
          break;
        case "followup":
          for (const id of decision.tickets) this.deliverFollowup(id, t);
          ids = decision.tickets;
          break;
        case "new":
          ids = [this.createTicket(t)];
          break;
      }
      const reason = "reason" in decision ? decision.reason : null;
      this.db.run("UPDATE triggers SET decision = ?, reason = ? WHERE id = ?", decision.action, reason, t.id);
      return { decision, tickets: ids };
    });
  }

  private threadTickets(thread: string): ThreadTicket[] {
    return this.db
      .all(
        `SELECT t.id, t.status, t.stopped_by_person, t.requester FROM tickets t
         JOIN subscriptions s ON s.ticket_id = t.id WHERE s.thread = ?`,
        thread,
      )
      .map((r) => ({ id: r.id, status: r.status, stoppedByPerson: !!r.stopped_by_person, requester: r.requester }));
  }

  createTicket(t: Trigger, requester = t.author): number {
    const created = now();
    const token = randomBytes(24).toString("hex");
    const r = this.db.run(
      `INSERT INTO tickets (name, source, thread, origin_trigger, requester, branch, dir, token, created_at, updated_at)
       VALUES ('', ?, ?, ?, ?, '', '', ?, ?, ?)`,
      t.source, t.thread, t.id, requester, token, created, created,
    );
    const id = Number(r.lastInsertRowid);
    const slug = slugify(t.meta?.title ?? t.body);
    const name = `T${id}${slug ? `-${slug}` : ""}`;
    const dir = join(this.cfg.workspace.worktreesDir ?? join(this.cfg.stateDir, "worktrees"), `ticket-${id}`);
    this.db.run(
      "UPDATE tickets SET name = ?, branch = ?, dir = ? WHERE id = ?",
      name, `${this.cfg.workspace.branchPrefix}${id}${slug ? `-${slug}` : ""}`, dir, id,
    );
    this.db.run("INSERT OR IGNORE INTO subscriptions (ticket_id, thread) VALUES (?, ?)", id, t.thread);
    this.addInput(id, "assignment", t, renderCard("Assignment", t), true);
    return id;
  }

  private deliverFollowup(id: number, t: Trigger) {
    const ticket = this.ticket(id)!;
    if (ticket.status === "ended") {
      this.db.run("UPDATE tickets SET status = 'open', end_reason = NULL, updated_at = ? WHERE id = ?", now(), id);
    }
    // An allowed person may switch the model mid-ticket with `model:<id>`.
    if (this.allow.has(t.author.toLowerCase())) {
      const hinted = hintedEntries(t.body, this.cfg.roster).filter((e) => e.enabled);
      if (hinted.length && hinted[0]!.id !== ticket.roster_id) {
        this.db.run("UPDATE tickets SET roster_id = ?, route_reason = 'switched by a person' WHERE id = ?", hinted[0]!.id, id);
        this.addInput(id, "recovery", null, handoffNote(ticket.roster_id, hinted[0]!.id, "a person asked for this model"), false);
      }
    }
    this.addInput(id, "followup", t, renderCard(`Follow-up from @${t.author}`, t), true);
  }

  private deliverContext(ids: number[], t: Trigger): number[] {
    const reached: number[] = [];
    for (const id of ids) {
      const ticket = this.ticket(id)!;
      const quiet = ticket.report === "blocked" || ticket.report === "failed";
      if (t.kind === "pr_state" && t.meta?.pr) {
        this.db.run("UPDATE prs SET state = ? WHERE ticket_id = ? AND number = ?", t.meta.prState ?? "open", id, t.meta.pr);
        const prs = this.db.all("SELECT state FROM prs WHERE ticket_id = ?", id);
        if (ticket.status === "open" && prs.length && prs.every((p) => p.state !== "open")) {
          this.endTicket(id, prs.some((p) => p.state === "merged") ? "merged" : "closed");
        } else {
          this.addInput(id, "context", t, renderCard(`PR #${t.meta.pr} is ${t.meta.prState}`, t), false);
        }
      } else if (t.kind === "ci") {
        const wakes = t.meta?.ciOutcome === "failure" && !quiet;
        this.addInput(id, "context", t, renderCard(`CI ${t.meta?.ciOutcome ?? "result"}`, t), wakes);
      } else {
        if (ticket.status !== "open") continue;
        this.addInput(id, "context", t, renderCard(`Context from bot @${t.author}`, t), !quiet);
      }
      reached.push(id);
    }
    return reached;
  }

  addInput(ticketId: number, kind: string, t: Trigger | null, body: string, wakes: boolean) {
    this.db.run(
      "INSERT INTO inputs (ticket_id, kind, trigger_id, author, body, wakes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ticketId, kind, t?.id ?? null, t?.author ?? null, body, wakes ? 1 : 0, now(),
    );
    this.touch(ticketId);
  }

  endTicket(id: number, reason: string, byPerson = false) {
    this.db.run(
      "UPDATE tickets SET status = 'ended', end_reason = ?, stopped_by_person = MAX(stopped_by_person, ?), review_pending = 0, updated_at = ? WHERE id = ?",
      reason, byPerson ? 1 : 0, now(), id,
    );
  }

  // ---------- reads ----------

  ticket(id: number): Row | undefined {
    return this.db.get("SELECT * FROM tickets WHERE id = ?", id);
  }
  ticketByToken(token: string): Row | undefined {
    return token ? this.db.get("SELECT * FROM tickets WHERE token = ?", token) : undefined;
  }

  stage(t: Row): Stage {
    if (t.status === "ended") return "ended";
    if (t.running) return "working";
    if (t.review_pending || this.db.get("SELECT 1 FROM inputs WHERE ticket_id = ? AND turn_id IS NULL AND wakes = 1", t.id))
      return "queued";
    if (t.report === "blocked") return t.report_question ? "awaiting-answer" : "blocked";
    if (t.report === "failed") return "failed";
    if (t.report === "ready") return "awaiting-review";
    return "idle";
  }

  /** Open tickets with work to do, oldest first; person follow-ups flagged for the reserved slot. */
  runnable(): { ticket: Row; personFollowup: boolean }[] {
    const t = now();
    return this.db
      .all(
        `SELECT t.*, (SELECT COUNT(*) FROM inputs i WHERE i.ticket_id = t.id AND i.turn_id IS NULL AND i.kind = 'followup') AS followups
         FROM tickets t WHERE t.status = 'open' AND t.running = 0 AND (t.retry_at IS NULL OR t.retry_at <= ?)
         AND (t.review_pending = 1 OR EXISTS (SELECT 1 FROM inputs i WHERE i.ticket_id = t.id AND i.turn_id IS NULL AND i.wakes = 1))
         ORDER BY t.updated_at`,
        t,
      )
      .map((r) => ({ ticket: r, personFollowup: r.followups > 0 }));
  }

  // ---------- the worker API (`sa`) ----------

  command(token: string, cmd: string, body: any): unknown {
    return this.db.tx(() => {
      const t = this.ticketByToken(token);
      if (!t) throw new Refused("unknown ticket token");
      switch (cmd) {
        case "show":
          return this.show(t);
        case "ack":
          return this.say(t, "ack", body.to, body.text, true);
        case "reply":
          if (!body.to) throw new Refused("reply needs --to <trigger>");
          return this.say(t, "answer", body.to, body.text, false);
        case "report":
          return this.report(t, body);
        case "handback":
          return this.handback(t, body.trigger, body.reason);
        default:
          throw new Refused(`unknown command ${cmd}`);
      }
    });
  }

  private show(t: Row) {
    return {
      ticket: {
        id: t.id, name: t.name, status: t.status, stage: this.stage(t), requester: t.requester,
        thread: t.thread, originTrigger: t.origin_trigger, branch: t.branch, dir: t.dir,
        model: t.roster_id, lastReport: t.report,
      },
      subscriptions: this.db.all("SELECT thread FROM subscriptions WHERE ticket_id = ?", t.id).map((r) => r.thread),
      pullRequests: this.db.all("SELECT number, state FROM prs WHERE ticket_id = ?", t.id),
      inputs: this.db
        .all("SELECT id, kind, trigger_id, author, body, created_at FROM inputs WHERE ticket_id = ? ORDER BY id", t.id),
    };
  }

  private reachedTrigger(t: Row, triggerId: string): Row {
    const reached =
      triggerId === t.origin_trigger ||
      this.db.get("SELECT 1 FROM inputs WHERE ticket_id = ? AND trigger_id = ?", t.id, triggerId);
    if (!reached) throw new Refused(`trigger ${triggerId} did not reach this ticket`);
    return this.db.get("SELECT * FROM triggers WHERE id = ?", triggerId)!;
  }

  private checkWords(text: unknown) {
    if (typeof text !== "string" || !text.trim()) throw new Refused("message text is empty");
    const words = text.trim().split(/\s+/).length;
    if (words > this.cfg.messages.maxWords)
      throw new Refused(`message has ${words} words; the limit is ${this.cfg.messages.maxWords}`);
  }

  private say(t: Row, purpose: string, to: string | undefined, text: string, isAck: boolean) {
    this.checkWords(text);
    const trig = this.reachedTrigger(t, to ?? t.origin_trigger);
    if (isAck && this.db.get("SELECT 1 FROM outbox WHERE ticket_id = ? AND purpose = 'ack' AND reply_to IS ? AND thread = ?", t.id, trigReplyTarget(trig), trig.thread))
      throw new Refused("this request was already acknowledged");
    this.enqueueRow(t.id, trig, purpose, text);
    return { ok: true, queued: purpose };
  }

  private report(t: Row, b: any) {
    const status = b.status as Status;
    if (!STATUSES.includes(status)) throw new Refused(`status must be one of ${STATUSES.join(", ")}`);
    if (status === "progress" && b.message) throw new Refused("a progress report may not carry a message");
    if (b.message) this.checkWords(b.message);
    if (b.question) this.checkWords(b.question);
    if (status === "blocked" && !b.question && !b.message) throw new Refused("blocked needs --question or --message");
    if (status === "failed" && !b.message) throw new Refused("failed needs --message saying why");

    if (b.pr !== undefined) {
      const n = Number(b.pr);
      if (!Number.isInteger(n) || n <= 0) throw new Refused("--pr must be a pull request number");
      const repo = this.cfg.sources.github?.repo;
      if (!repo) throw new Refused("no GitHub source is configured");
      this.db.run("INSERT OR IGNORE INTO subscriptions (ticket_id, thread) VALUES (?, ?)", t.id, `github:${repo}#${n}`);
      this.db.run("INSERT OR IGNORE INTO prs (ticket_id, number) VALUES (?, ?)", t.id, n);
    }

    // Cross-model review: hold a ready report until another model has looked at the work.
    if (status === "ready" && this.cfg.review.enabled && t.review_rounds < this.cfg.review.rounds) {
      this.db.run(
        "UPDATE tickets SET report = 'waiting', report_summary = ?, review_pending = 1, review_rounds = review_rounds + 1, updated_at = ? WHERE id = ?",
        b.summary ?? null, now(), t.id,
      );
      return {
        ok: true,
        held: "a review by another model was queued; its findings arrive in your next turn. Fix what is right, then report ready again.",
      };
    }

    this.db.run(
      "UPDATE tickets SET report = ?, report_question = ?, report_summary = ?, attempts = 0, updated_at = ? WHERE id = ?",
      status, status === "blocked" ? (b.question ?? null) : null, b.summary ?? null, now(), t.id,
    );

    const origin = this.db.get("SELECT * FROM triggers WHERE id = ?", b.to ? this.reachedTrigger(t, b.to).id : t.origin_trigger)!;
    const text = b.message ?? (status === "blocked" ? b.question : undefined);
    const purpose = status === "blocked" || status === "failed" ? "attention" : "result";
    if (text && status !== "progress") this.enqueueRow(t.id, origin, purpose, text);

    if (status === "dropped") this.endTicket(t.id, "dropped");
    if (status === "ready" && !this.db.get("SELECT 1 FROM prs WHERE ticket_id = ?", t.id)) this.endTicket(t.id, "completed");
    return { ok: true };
  }

  private handback(t: Row, triggerId: string, reason: string) {
    if (!triggerId || !reason) throw new Refused("handback needs <trigger> <reason>");
    const trig = this.reachedTrigger(t, triggerId);
    if (trig.id === t.origin_trigger) throw new Refused("the ticket's own assignment cannot be handed back");
    this.db.run(
      "UPDATE inputs SET turn_id = COALESCE(turn_id, -1) WHERE ticket_id = ? AND trigger_id = ?",
      t.id, trig.id,
    );
    if (!this.allow.has(String(trig.author).toLowerCase()) || trig.is_bot)
      return { ok: true, routed: "ignored: the author may not start new work" };
    const id = this.createTicket(rowToTrigger(trig));
    return { ok: true, routed: `new ticket T${id}` };
  }

  // ---------- outbox ----------

  private enqueue(ticketId: number, thread: string, t: Trigger, purpose: string, text: string) {
    this.db.run(
      "INSERT INTO outbox (ticket_id, source, thread, reply_to, purpose, body, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ticketId, t.source, thread, t.meta?.replyTarget ?? null, purpose, text, now(), now(),
    );
  }

  private enqueueRow(ticketId: number, trig: Row, purpose: string, text: string) {
    this.db.run(
      "INSERT INTO outbox (ticket_id, source, thread, reply_to, purpose, body, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ticketId, trig.source, trig.thread, trigReplyTarget(trig), purpose, text, now(), now(),
    );
  }

  private touch(id: number) {
    this.db.run("UPDATE tickets SET updated_at = ? WHERE id = ?", now(), id);
  }
}

// ---------- helpers ----------

function trigReplyTarget(trig: Row): string | null {
  try {
    return JSON.parse(trig.meta ?? "{}").replyTarget ?? null;
  } catch {
    return null;
  }
}

export function rowToTrigger(r: Row): Trigger {
  return {
    id: r.id, source: r.source, thread: r.thread, kind: r.kind, author: r.author, isBot: !!r.is_bot,
    body: r.body, url: r.url ?? undefined, createdAt: r.created_at, meta: JSON.parse(r.meta ?? "{}"),
  };
}

export function renderCard(heading: string, t: Trigger): string {
  return [
    `### ${heading}`,
    `Trigger id: ${t.id}`,
    `Thread: ${t.thread}`,
    t.url ? `URL: ${t.url}` : null,
    `Author: @${t.author}${t.isBot ? " (bot)" : ""}`,
    t.meta?.title ? `Title: ${t.meta.title}` : null,
    "",
    "<message>",
    t.body,
    "</message>",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function handoffNote(from: string | null, to: string, why: string): string {
  return `### Handoff
This ticket moves from ${from ?? "another model"} to ${to} because ${why}. A previous worker may already have changed files, committed, pushed, opened a pull request or posted messages. Before repeating any outside action, check this directory, \`git log\`, \`git status\`, the pull requests on this branch and \`sa show\`.`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/@[\w-]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
}
