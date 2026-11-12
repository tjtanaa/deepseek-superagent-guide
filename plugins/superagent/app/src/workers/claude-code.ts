import { classify, type Turn, type TurnResult, type WorkerAdapter } from "./types.ts";
import { lastLines, run } from "./spawn.ts";

const BIN = process.env.SUPERAGENT_CLAUDE_BIN ?? "claude";

/** Claude Code in print mode. Sessions are stored per working directory, so every turn runs in the ticket's dir. */
export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly name = "claude-code";

  async version() {
    const r = await run(BIN, ["--version"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout, 3) || "claude not found");
    return r.stdout.trim();
  }

  async run(turn: Turn): Promise<TurnResult> {
    const first = turn.sessionId ? ["--resume", turn.sessionId] : ["--session-id", turn.newSessionId];
    let res = await this.once(turn, first);
    // Fallbacks from the guide: a lost session restarts under the id; an id that exists resumes.
    if (!res.ok && /No conversation found/i.test(res.error ?? ""))
      res = await this.once(turn, ["--session-id", turn.sessionId ?? turn.newSessionId]);
    else if (!res.ok && /already in use/i.test(res.error ?? ""))
      res = await this.once(turn, ["--resume", turn.newSessionId]);
    return res;
  }

  private async once(turn: Turn, sessionArgs: string[]): Promise<TurnResult> {
    const args = ["-p", "--output-format", "json", "--append-system-prompt", turn.instructions, ...sessionArgs];
    if (turn.role === "reviewer") args.push("--permission-mode", "plan", "--disallowedTools", "Edit,Write,NotebookEdit");
    else args.push("--dangerously-skip-permissions");
    if (turn.entry.model) args.push("--model", turn.entry.model);
    if (turn.entry.effort) args.push("--effort", turn.entry.effort);
    const r = await run(BIN, args, { cwd: turn.dir, env: turn.env, stdin: turn.message, timeoutMs: turn.timeoutMs });
    return parseClaudeOutput(r.stdout, r.stderr, r.code, r.timedOut);
  }
}

export function parseClaudeOutput(stdout: string, stderr: string, code: number | null, timedOut = false): TurnResult {
  if (timedOut) return { ok: false, text: "", error: "turn timed out", transient: true };
  let out: any;
  try {
    out = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "");
  } catch {
    const error = lastLines(stderr || stdout) || `claude exited ${code}`;
    return { ok: false, text: "", error, ...classify(error) };
  }
  const text = typeof out.result === "string" ? out.result : "";
  if (out.is_error || code !== 0) {
    const error = [out.api_error_status, text, lastLines(stderr, 5)].filter(Boolean).join(" ") || `claude exited ${code}`;
    return { ok: false, sessionId: out.session_id, text, error, costUsd: out.total_cost_usd, ...classify(error) };
  }
  return { ok: true, sessionId: out.session_id, text, transient: false, costUsd: out.total_cost_usd };
}
