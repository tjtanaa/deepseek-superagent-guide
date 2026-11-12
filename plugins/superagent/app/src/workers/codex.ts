import { classify, type Turn, type TurnResult, type WorkerAdapter } from "./types.ts";
import { lastLines, run } from "./spawn.ts";

// The Codex CLI is often not on PATH: the Codex desktop app ships its own copy
// (on Windows under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe). Point
// SUPERAGENT_CODEX_BIN at it, or install `@openai/codex` from npm.
const BIN = process.env.SUPERAGENT_CODEX_BIN ?? "codex";

/**
 * OpenAI Codex CLI (`codex exec`). First turn: `codex exec --json ... -`, the new
 * thread id comes from the `thread.started` event. Later turns:
 * `codex exec resume --json <thread_id> -`. The message always goes on stdin.
 * Host instructions go in `developer_instructions` on every turn, because
 * config overrides are not stored in the session.
 */
export class CodexAdapter implements WorkerAdapter {
  readonly name = "codex";

  async version() {
    const r = await run(BIN, ["--version"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout, 3) || "codex not found");
    return r.stdout.trim();
  }

  async run(turn: Turn): Promise<TurnResult> {
    let res = await this.once(turn, turn.sessionId);
    if (!res.ok && turn.sessionId && /no (session|thread|rollout|conversation)|not found/i.test(res.error ?? ""))
      res = await this.once(turn, undefined);
    return res;
  }

  private async once(turn: Turn, sessionId: string | undefined): Promise<TurnResult> {
    const args = codexArgs(turn, sessionId);
    const r = await run(BIN, args, { cwd: turn.dir, env: turn.env, stdin: turn.message, timeoutMs: turn.timeoutMs });
    return parseCodexOutput(r.stdout, r.stderr, r.code, r.timedOut);
  }
}

export function codexArgs(turn: Turn, sessionId: string | undefined): string[] {
  const args = ["exec"];
  if (sessionId) args.push("resume");
  args.push("--json", "--skip-git-repo-check");
  if (turn.entry.model) args.push("-m", turn.entry.model);
  if (turn.entry.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(turn.entry.effort)}`);
  args.push("-c", `developer_instructions=${JSON.stringify(turn.instructions)}`);
  if (turn.role === "reviewer") {
    // `exec resume` has no --sandbox flag; the config key works for both.
    args.push("-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"');
  } else {
    // Unattended work needs network (git push, gh) and no prompts. Run inside the container.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (sessionId) args.push(sessionId);
  args.push("-");
  return args;
}

export function parseCodexOutput(stdout: string, stderr: string, code: number | null, timedOut = false): TurnResult {
  if (timedOut) return { ok: false, text: "", error: "turn timed out", transient: true };
  let sessionId: string | undefined;
  let text = "";
  let completed = false;
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
    else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string")
      text = ev.item.text;
    else if (ev.type === "turn.completed") completed = true;
    else if (ev.type === "turn.failed") errors.push(ev.error?.message ?? JSON.stringify(ev.error));
    else if (ev.type === "error") errors.push(ev.message ?? JSON.stringify(ev));
  }
  if (!completed || code !== 0) {
    const error = errors.join("; ") || lastLines(stderr) || `codex exited ${code}`;
    return { ok: false, sessionId, text, error, ...classify(error) };
  }
  return { ok: true, sessionId, text, transient: false };
}
