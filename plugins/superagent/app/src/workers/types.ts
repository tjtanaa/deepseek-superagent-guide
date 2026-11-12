import type { RosterEntry } from "../config.ts";

export interface Turn {
  ticketId: number;
  entry: RosterEntry;
  dir: string;
  /** The host's instructions (worker.md + host.md + team sections + environment). */
  instructions: string;
  /** All pending inputs, rendered as one message. */
  message: string;
  /** Session id from an earlier turn of this ticket on this roster entry, if any. */
  sessionId?: string;
  /** Session id to create, for adapters that let the caller choose one. */
  newSessionId: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Reviewer turns must not change files or push. */
  role: "worker" | "reviewer";
}

export interface TurnResult {
  ok: boolean;
  sessionId?: string;
  text: string;
  error?: string;
  /** Worth retrying on the same model: 408, 429, 5xx, overloaded, connection resets. */
  transient: boolean;
  /** The model's quota or credit is used up; try another roster entry. */
  exhausted?: boolean;
  costUsd?: number;
}

export interface WorkerAdapter {
  readonly name: string;
  run(turn: Turn): Promise<TurnResult>;
  /** Version string, or throws if the CLI is missing. */
  version(): Promise<string>;
}

const TRANSIENT = [
  /\b(408|429|500|502|503|504|529)\b/,
  /overloaded/i,
  /rate.?limit/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|connection (reset|closed|error)/i,
  /stream (disconnected|error)/i,
  /timed? ?out/i,
];
const EXHAUSTED = [
  /usage limit/i,
  /insufficient_quota|exceeded your current quota/i,
  /credit balance is too low/i,
  /out of (credits|tokens)/i,
  /plan limit|limit reached|try again (at|in) \d/i,
];

export function classify(error: string): { transient: boolean; exhausted: boolean } {
  const exhausted = EXHAUSTED.some((r) => r.test(error));
  return { exhausted, transient: exhausted || TRANSIENT.some((r) => r.test(error)) };
}
