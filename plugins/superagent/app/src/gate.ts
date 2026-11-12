// The deterministic gate. It decides who may start or stop work before any model runs.
// Nothing in a message's text can grant permission: only the author's login and the
// thread's existing tickets matter, plus whether the text mentions the agent.

export interface Trigger {
  id: string;
  source: string; // "github" | "panel"
  thread: string; // e.g. github:owner/repo#12
  kind: "issue" | "comment" | "review" | "review_comment" | "ci" | "pr_state" | "panel";
  author: string;
  isBot: boolean;
  body: string;
  url?: string;
  createdAt: string;
  meta?: {
    ciOutcome?: "success" | "failure";
    pr?: number;
    prState?: "open" | "merged" | "closed";
    replyTarget?: string; // review thread comment id
    title?: string;
  };
}

export interface ThreadTicket {
  id: number;
  status: "open" | "ended";
  stoppedByPerson: boolean;
  requester: string;
}

export type GateDecision =
  | { action: "filtered"; reason: "own_message" }
  | { action: "stop"; tickets: number[] }
  | { action: "context"; tickets: number[] }
  | { action: "followup"; tickets: number[] }
  | { action: "new" }
  | { action: "ignored"; reason: "not_on_allow_list" | "not_addressed" | "bot_not_admitted" | "no_live_ticket" };

export interface GateInput {
  trigger: Trigger;
  agentLogin: string;
  allow: Set<string>; // lower-cased logins
  tickets: ThreadTicket[]; // tickets subscribed to the trigger's thread
}

export function mentions(body: string, login: string): boolean {
  const re = new RegExp(`(^|[^\\w-])@${escape(login)}(?![\\w-])`, "i");
  return re.test(body);
}

const STOP_WORDS = new Set(["stop", "cancel", "abort"]);

/** "@bot stop", "@bot please cancel", "stop @bot" all count; "how do I stop the server" does not. */
export function isStop(body: string, login: string): boolean {
  const stripped = body
    .replace(new RegExp(`@${escape(login)}`, "gi"), " ")
    .replace(/[^\w\s]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && w !== "please");
  return stripped.length > 0 && stripped.length <= 3 && STOP_WORDS.has(stripped[0]!);
}

export function gate({ trigger, agentLogin, allow, tickets }: GateInput): GateDecision {
  const author = trigger.author.toLowerCase();
  if (author === agentLogin.toLowerCase()) return { action: "filtered", reason: "own_message" };

  const allowed = !trigger.isBot && allow.has(author);
  const addressed = mentions(trigger.body, agentLogin) || trigger.kind === "panel";
  const live = tickets.filter((t) => t.status === "open");

  if (allowed && addressed && live.length && isStop(trigger.body, agentLogin))
    return { action: "stop", tickets: live.map((t) => t.id) };

  // Merge/close state changes are facts about the thread, never requests.
  if (trigger.kind === "pr_state") {
    const subscribed = tickets.filter((t) => !t.stoppedByPerson);
    return subscribed.length
      ? { action: "context", tickets: subscribed.map((t) => t.id) }
      : { action: "ignored", reason: "no_live_ticket" };
  }

  if (trigger.isBot) {
    return live.length
      ? { action: "context", tickets: live.map((t) => t.id) }
      : { action: "ignored", reason: "bot_not_admitted" };
  }

  // Any person on a subscribed thread is heard; an ended ticket resumes only if
  // its requester is still allowed.
  const reachable = tickets.filter(
    (t) => !t.stoppedByPerson && (t.status === "open" || allow.has(t.requester.toLowerCase())),
  );
  if (reachable.length) return { action: "followup", tickets: reachable.map((t) => t.id) };

  if (allowed && addressed) return { action: "new" };

  if (addressed) return { action: "ignored", reason: "not_on_allow_list" };
  return { action: "ignored", reason: "not_addressed" };
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
