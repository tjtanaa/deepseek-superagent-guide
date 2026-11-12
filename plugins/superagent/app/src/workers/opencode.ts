import { classify, type Turn, type TurnResult, type WorkerAdapter } from "./types.ts";
import { lastLines, run } from "./spawn.ts";

const BIN = process.env.SUPERAGENT_OPENCODE_BIN ?? "opencode";

/** OpenCode v2. It has no flag for extra instructions, so they ride in the first message. */
export class OpenCodeAdapter implements WorkerAdapter {
  readonly name = "opencode";

  async version() {
    const r = await run(BIN, ["--version"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout, 3) || "opencode not found");
    return r.stdout.trim();
  }

  async run(turn: Turn): Promise<TurnResult> {
    const args = ["run", "--format", "json", "--auto"];
    if (turn.entry.model) args.push("--model", turn.entry.model);
    if (turn.entry.effort) args.push("--variant", turn.entry.effort);
    let message: string;
    if (turn.sessionId) {
      args.push("--session", turn.sessionId);
      message = `Reminder: you are a superagent worker; the rules in your first message's <instructions> still apply.\n\n${turn.message}`;
    } else {
      message = `<instructions>\n${turn.instructions}\n</instructions>\n\n${turn.message}`;
    }
    args.push(message);
    const r = await run(BIN, args, { cwd: turn.dir, env: turn.env, timeoutMs: turn.timeoutMs });
    return parseOpenCodeOutput(r.stdout, r.stderr, r.code, r.timedOut);
  }
}

export function parseOpenCodeOutput(stdout: string, stderr: string, code: number | null, timedOut = false): TurnResult {
  if (timedOut) return { ok: false, text: "", error: "turn timed out", transient: true };
  let sessionId: string | undefined;
  let text = "";
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId ??= ev.sessionID;
    if (ev.type === "text" && typeof ev.part?.text === "string") text = ev.part.text;
    if (ev.type === "error") errors.push(typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error));
  }
  if (errors.length || code !== 0) {
    const error = errors.join("; ") || lastLines(stderr) || `opencode exited ${code}`;
    return { ok: false, sessionId, text, error, ...classify(error) };
  }
  return { ok: true, sessionId, text, transient: false };
}
