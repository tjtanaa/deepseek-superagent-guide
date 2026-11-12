import type { AdapterName } from "../config.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexAdapter } from "./codex.ts";
import { MockAdapter } from "./mock.ts";
import { OpenCodeAdapter } from "./opencode.ts";
import type { WorkerAdapter } from "./types.ts";

export type Adapters = Record<AdapterName, WorkerAdapter>;

export function defaultAdapters(overrides: Partial<Adapters> = {}): Adapters {
  return {
    "claude-code": new ClaudeCodeAdapter(),
    codex: new CodexAdapter(),
    opencode: new OpenCodeAdapter(),
    mock: new MockAdapter(),
    ...overrides,
  };
}
