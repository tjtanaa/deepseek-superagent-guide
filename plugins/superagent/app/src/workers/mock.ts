import { randomUUID } from "node:crypto";
import type { Turn, TurnResult, WorkerAdapter } from "./types.ts";

export type MockScript = (turn: Turn, call: number) => Promise<Partial<TurnResult>> | Partial<TurnResult>;

/** Scripted worker for tests and the local smoke test. */
export class MockAdapter implements WorkerAdapter {
  readonly name = "mock";
  readonly turns: Turn[] = [];
  private script: MockScript;
  constructor(script: MockScript = () => ({ text: "ok" })) {
    this.script = script;
  }

  async version() {
    return "mock 1";
  }

  async run(turn: Turn): Promise<TurnResult> {
    this.turns.push(turn);
    const out = await this.script(turn, this.turns.length);
    return {
      ok: out.ok ?? true,
      sessionId: out.sessionId ?? turn.sessionId ?? turn.newSessionId ?? randomUUID(),
      text: out.text ?? "",
      error: out.error,
      transient: out.transient ?? false,
      exhausted: out.exhausted,
      costUsd: out.costUsd ?? 0,
    };
  }
}
