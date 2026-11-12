import type { Row } from "../db.ts";
import type { Trigger } from "../gate.ts";

export type SendResult = { ok: true } | { ok: false; permanent: boolean; error: string };

export interface Source {
  readonly name: string;
  /** New triggers since the last poll. Sources that push (the panel) return []. */
  poll(): Promise<Trigger[]>;
  /** Posts one outbox row. Must add any header the source requires. */
  send(row: Row): Promise<SendResult>;
}

export const AUTOMATED_HEADER = "This is by an automated agent, not a human.";
