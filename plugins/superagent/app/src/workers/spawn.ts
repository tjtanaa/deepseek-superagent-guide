import { spawn } from "node:child_process";

export interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      stderr += String(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });
}

export function lastLines(s: string, n = 20) {
  return s.trim().split("\n").slice(-n).join("\n");
}
