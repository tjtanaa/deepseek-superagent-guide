import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Config, parseConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { Executor } from "../src/executor.ts";
import type { Trigger } from "../src/gate.ts";
import { Outbox } from "../src/outbox.ts";
import { Router } from "../src/router.ts";
import { startServer } from "../src/server.ts";
import { PanelSource } from "../src/sources/panel.ts";
import type { Source } from "../src/sources/types.ts";
import { defaultAdapters } from "../src/workers/index.ts";
import { MockAdapter, type MockScript } from "../src/workers/mock.ts";
import type { Turn } from "../src/workers/types.ts";

const SA = join(import.meta.dirname, "..", "bin", "sa");

function setup(scripts: { claude?: MockScript; codex?: MockScript }, over: Partial<Config> = {}, routeTo?: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "sa-test-"));
  const cfg = parseConfig({
    stateDir,
    sources: { github: { repo: "o/r", agentLogin: "bot", allow: ["alice"] } },
    workspace: { repoPath: stateDir },
    roster: [
      { id: "claude-sonnet", adapter: "claude-code", model: "sonnet", tags: ["default"] },
      { id: "codex-sol", adapter: "codex", model: "gpt-6.1-sol", effort: "high" },
    ],
    worker: { maxConcurrent: 1, maxRetries: 1 },
    ...over,
  });
  const db = new Db(":memory:");
  const engine = new Engine(db, cfg);
  const claude = new MockAdapter(scripts.claude);
  const codex = new MockAdapter(scripts.codex);
  const routed: string[] = [];
  const router = new Router(cfg, async (prompt) => {
    routed.push(prompt);
    return { id: routeTo ?? "claude-sonnet", reason: "test" };
  });
  const executor = new Executor(engine, cfg, defaultAdapters({ "claude-code": claude, codex }), router, {
    hostUrl: "http://127.0.0.1:0", skipWorktree: true, log: () => {},
  });
  const sent: any[] = [];
  const gh: Source = { name: "github", poll: async () => [], send: async (row) => (sent.push(row), { ok: true }) };
  const outbox = new Outbox(db, { github: gh }, () => {});
  const sa = (turn: Turn, cmd: string, body: any) => engine.command(turn.env.SUPERAGENT_TOKEN!, cmd, body) as any;
  const cycle = async () => {
    for (let i = 0; i < 10; i++) {
      const started = executor.tick();
      if (!started.length) break;
      await Promise.all(started);
    }
    await outbox.flush();
  };
  return { cfg, db, engine, executor, claude, codex, routed, sent, sa, cycle };
}

let n = 0;
const trig = (p: Partial<Trigger> = {}): Trigger => ({
  id: `github:comment:${++n}`, source: "github", thread: "github:o/r#1", kind: "comment", author: "alice",
  isBot: false, body: "@bot fix the typo in README", createdAt: new Date().toISOString(), ...p,
});

test("a request becomes a routed ticket, a PR and an awaiting-review stage; follow-ups reuse the session", async () => {
  const s = setup({
    claude: (turn, call) => {
      if (call === 1) {
        s.sa(turn, "ack", { text: "On it: fixing the README typo." });
        s.sa(turn, "report", { status: "progress", pr: 5 });
        s.sa(turn, "report", { status: "ready", message: "PR #5 fixes the typo; ready for review." });
      } else {
        assert.equal(turn.sessionId, s.claude.turns[0]!.newSessionId);
        s.sa(turn, "report", { status: "ready" });
      }
      return { text: "done" };
    },
  });
  const r = s.engine.receive(trig());
  assert.equal((r.decision as any).action, "new");
  await s.cycle();
  const t = s.engine.ticket(r.tickets[0]!)!;
  assert.equal(t.roster_id, "claude-sonnet");
  assert.equal(s.engine.stage(t), "awaiting-review");
  assert.deepEqual(s.sent.map((m) => m.purpose), ["ack", "result"]);
  assert.match(s.claude.turns[0]!.instructions, /roster entry claude-sonnet/);
  assert.match(s.claude.turns[0]!.message, /Trigger id: github:comment:\d+/);

  // Comment on the PR thread without mentioning the bot: same ticket, same session.
  const f = s.engine.receive(trig({ thread: "github:o/r#5", author: "bob", body: "Also fix the second one" }));
  assert.deepEqual(f.tickets, [t.id]);
  await s.cycle();
  assert.equal(s.claude.turns.length, 2);

  // A duplicate trigger is a no-op.
  assert.equal(s.engine.receive(trig({ id: "github:comment:1" })).decision, "duplicate");

  // Merge ends the ticket.
  s.engine.receive(trig({ id: "github:pr:5:merged", kind: "pr_state", isBot: true, thread: "github:o/r#5", body: "merged", meta: { pr: 5, prState: "merged" } }));
  assert.equal(s.engine.ticket(t.id)!.end_reason, "merged");
});

test("the host refuses messages over the word limit, progress messages and foreign triggers", async () => {
  const errors: string[] = [];
  const s = setup({
    claude: (turn) => {
      for (const [cmd, body] of [
        ["ack", { text: Array(200).fill("word").join(" ") }],
        ["report", { status: "progress", message: "hi" }],
        ["reply", { to: "github:comment:999999", text: "hi" }],
        ["report", { status: "failed" }],
      ] as const) {
        try {
          s.sa(turn, cmd, body);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      s.sa(turn, "report", { status: "dropped" });
      return { text: "" };
    },
  });
  s.engine.receive(trig());
  await s.cycle();
  assert.equal(errors.length, 4);
  assert.match(errors[0]!, /limit is 120/);
  assert.match(errors[1]!, /progress report may not carry a message/);
  assert.match(errors[2]!, /did not reach this ticket/);
  assert.match(errors[3]!, /failed needs --message/);
  assert.equal(s.sent.length, 0);
});

test("a model that runs out of quota cools down and the ticket fails over to another provider", async () => {
  const s = setup({
    claude: () => ({ ok: false, error: "Claude AI usage limit reached", transient: true, exhausted: true }),
    codex: (turn) => {
      assert.match(turn.message, /### Handoff/);
      assert.match(turn.message, /fix the typo/); // the cut-off inputs are delivered again
      s.sa(turn, "report", { status: "ready", message: "Done." });
      return { text: "ok" };
    },
  });
  const r = s.engine.receive(trig());
  await s.cycle();
  const t = s.engine.ticket(r.tickets[0]!)!;
  assert.equal(t.roster_id, "codex-sol");
  assert.equal(t.status, "ended");
  assert.equal(s.claude.turns.length, 1);
  assert.equal(s.codex.turns.length, 1);
  assert.ok(s.db.get("SELECT 1 FROM cooldowns WHERE roster_id = 'claude-sonnet'"));
  assert.match(t.route_reason, /only available model/);
});

test("when every model is unavailable the ticket fails with one attention message", async () => {
  const quota = () => ({ ok: false, error: "usage limit", transient: true, exhausted: true });
  const s = setup({ claude: quota, codex: quota });
  const r = s.engine.receive(trig());
  await s.cycle();
  await s.cycle();
  const t = s.engine.ticket(r.tickets[0]!)!;
  assert.equal(s.engine.stage(t), "failed");
  assert.equal(s.sent.filter((m) => m.purpose === "attention").length, 1);
});

test("cross-model review holds the first ready report and feeds findings back", async () => {
  const s = setup(
    {
      claude: (turn, call) => {
        const held = s.sa(turn, "report", { status: "ready", message: "Ready." });
        if (call === 1) assert.ok(held.held);
        else assert.match(turn.message, /Review by codex-sol[\s\S]*missing test/);
        return { text: "" };
      },
      codex: (turn) => {
        assert.equal(turn.role, "reviewer");
        return { text: "1. README.md:3 missing test" };
      },
    },
    { review: { enabled: true, rounds: 1, reviewers: [] } } as any,
  );
  const r = s.engine.receive(trig());
  await s.cycle();
  assert.equal(s.claude.turns.length, 2);
  assert.equal(s.codex.turns.length, 1);
  assert.equal(s.engine.ticket(r.tickets[0]!)!.end_reason, "completed");
  assert.deepEqual(s.sent.map((m) => m.body), ["Ready."]);
});

test("model:<id> from an allowed person picks the model; stop ends the ticket for good", async () => {
  const s = setup({ codex: () => ({ text: "working" }) });
  const r = s.engine.receive(trig({ body: "@bot refactor the parser model:codex-sol" }));
  await s.cycle();
  const id = r.tickets[0]!;
  assert.equal(s.engine.ticket(id)!.roster_id, "codex-sol");
  assert.match(s.engine.ticket(id)!.route_reason, /^hint/);
  assert.equal(s.routed.length, 0);

  s.engine.receive(trig({ body: "@bot stop" }));
  assert.equal(s.engine.ticket(id)!.end_reason, "stopped");
  const later = s.engine.receive(trig({ body: "please continue" }));
  assert.equal((later.decision as any).action, "ignored");
});

test("a turn cut off by a restart comes back with a recovery note", async () => {
  const s = setup({ claude: () => ({ text: "" }) });
  const r = s.engine.receive(trig());
  const id = r.tickets[0]!;
  // Simulate a crash mid-turn.
  s.db.run("UPDATE tickets SET running = 1, roster_id = 'claude-sonnet' WHERE id = ?", id);
  const turn = Number(s.db.run("INSERT INTO turns (ticket_id, roster_id, started_at) VALUES (?, 'claude-sonnet', 'x')", id).lastInsertRowid);
  s.db.run("UPDATE inputs SET turn_id = ? WHERE ticket_id = ?", turn, id);
  s.executor.recover();
  await s.cycle();
  assert.match(s.claude.turns[0]!.message, /### Recovery[\s\S]*fix the typo/);
});

test("end to end over HTTP: the sa CLI talks to the panel server", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "sa-http-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const cfg = parseConfig({
    stateDir, sources: { panel: { user: "me" } }, workspace: { repoPath: stateDir },
    roster: [{ id: "mock", adapter: "mock" }], router: { mode: "rules" }, panel: { port },
  });
  const db = new Db(":memory:");
  const engine = new Engine(db, cfg);
  const run = promisify(execFile);
  const mock = new MockAdapter(async (turn) => {
    const env = { ...process.env, ...turn.env };
    await run(process.execPath, [SA, "ack", "On", "it."], { env });
    const show = JSON.parse((await run(process.execPath, [SA, "show"], { env })).stdout);
    assert.equal(show.ticket.model, "mock");
    const refused = await run(process.execPath, [SA, "report", "progress", "--message", "x"], { env }).catch((e) => e);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /refused: a progress report may not carry a message/);
    await run(process.execPath, [SA, "report", "ready", "--message", "Done."], { env });
    return { text: "ok" };
  });
  const executor = new Executor(engine, cfg, defaultAdapters({ mock }), new Router(cfg), {
    hostUrl: `http://127.0.0.1:${port}`, skipWorktree: true, log: () => {},
  });
  const panel = new PanelSource(db, "me");
  const server = startServer(engine, executor, panel, cfg);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/request`, { method: "POST", body: JSON.stringify({ text: "say hello" }) });
    assert.equal(res.status, 200);
    await executor.idle();
    await new Outbox(db, { panel }, () => {}).flush();
    const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(st.tickets[0].endReason, "completed");
    assert.deepEqual(st.messages.map((m: any) => m.body).reverse(), ["say hello", "On it.", "Done."]);
  } finally {
    server.close();
  }
});
