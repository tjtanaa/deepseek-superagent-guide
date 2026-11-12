import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeOutput } from "../src/workers/claude-code.ts";
import { codexArgs, parseCodexOutput } from "../src/workers/codex.ts";
import { parseOpenCodeOutput } from "../src/workers/opencode.ts";
import { classify, type Turn } from "../src/workers/types.ts";

test("claude-code: success, API error and garbage", () => {
  const ok = parseClaudeOutput(JSON.stringify({ result: "done", session_id: "s1", is_error: false, total_cost_usd: 0.1 }), "", 0);
  assert.deepEqual(ok, { ok: true, sessionId: "s1", text: "done", transient: false, costUsd: 0.1 });
  const err = parseClaudeOutput(JSON.stringify({ result: "Overloaded", session_id: "s1", is_error: true, api_error_status: 529 }), "", 1);
  assert.equal(err.ok, false);
  assert.equal(err.transient, true);
  const garbage = parseClaudeOutput("", "Error: No conversation found with session ID x", 1);
  assert.match(garbage.error!, /No conversation found/);
});

// Recorded from `codex exec --json` (codex-cli 0.167) on 2026-11-12.
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"01a1cfde-2efb-7211-a7c3-10831f4c441a"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17428,"cached_input_tokens":13696,"output_tokens":5}}',
].join("\n");

test("codex: parses thread id and final agent message", () => {
  assert.deepEqual(parseCodexOutput(CODEX_OK, "Reading additional input from stdin...", 0), {
    ok: true, sessionId: "01a1cfde-2efb-7211-a7c3-10831f4c441a", text: "ok", transient: false,
  });
});

test("codex: a failed turn with a usage limit is exhausted", () => {
  const out = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again in 3 hours."}}',
  ].join("\n");
  const r = parseCodexOutput(out, "", 1);
  assert.equal(r.ok, false);
  assert.equal(r.exhausted, true);
  assert.equal(r.sessionId, "t1");
});

const turn = (p: Partial<Turn> = {}): Turn => ({
  ticketId: 1, entry: { id: "codex-x", adapter: "codex", model: "gpt-6.1-sol", effort: "high", strengths: "", tags: [], cost: 1, maxConcurrent: 1, enabled: true },
  dir: "/w", instructions: 'Say "hi"\nthen go', message: "m", newSessionId: "n", env: {}, timeoutMs: 1, role: "worker", ...p,
});

test("codex: first turn and resume arguments", () => {
  const first = codexArgs(turn(), undefined);
  assert.deepEqual(first.slice(0, 5), ["exec", "--json", "--skip-git-repo-check", "-m", "gpt-6.1-sol"]);
  assert.ok(first.includes('model_reasoning_effort="high"'));
  assert.ok(first.includes(`developer_instructions=${JSON.stringify('Say "hi"\nthen go')}`));
  assert.ok(first.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(first.at(-1), "-");

  const resume = codexArgs(turn(), "t1");
  assert.deepEqual(resume.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(resume.slice(-2), ["t1", "-"]);

  const review = codexArgs(turn({ role: "reviewer" }), undefined);
  assert.ok(review.includes('sandbox_mode="read-only"'));
  assert.ok(!review.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("opencode: last text event and session id", () => {
  const out = [
    '{"type":"step_start","sessionID":"ses_1"}',
    '{"type":"text","sessionID":"ses_1","part":{"text":"first"}}',
    '{"type":"text","sessionID":"ses_1","part":{"text":"final"}}',
  ].join("\n");
  assert.deepEqual(parseOpenCodeOutput(out, "", 0), { ok: true, sessionId: "ses_1", text: "final", transient: false });
});

test("error classification", () => {
  assert.deepEqual(classify("HTTP 503 Service Unavailable"), { transient: true, exhausted: false });
  assert.deepEqual(classify("Your credit balance is too low"), { transient: true, exhausted: true });
  assert.deepEqual(classify("syntax error in prompt"), { transient: false, exhausted: false });
});
