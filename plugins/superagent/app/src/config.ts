import { readFileSync } from "node:fs";
import { z } from "zod";

export const ADAPTERS = ["claude-code", "codex", "opencode", "mock"] as const;
export type AdapterName = (typeof ADAPTERS)[number];

const RosterEntry = z.object({
  /** Stable id people use in `model:<id>` hints and that the router answers with. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  adapter: z.enum(ADAPTERS),
  /** Passed to the CLI's model flag; omit to use the CLI's default. */
  model: z.string().optional(),
  /** claude-code: --effort; codex: model_reasoning_effort; opencode: --variant. */
  effort: z.string().optional(),
  /** What this entry is good at, shown to the router and matched by `model:<tag>` hints. */
  strengths: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Relative cost, 1 = cheapest. The router weighs it; the fallback picks cheaper entries first among equals. */
  cost: z.number().positive().default(1),
  /** At most this many tickets run on the entry at once. */
  maxConcurrent: z.number().int().positive().default(2),
  enabled: z.boolean().default(true),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

const Router = z.object({
  /** "llm" asks a model to pick a roster entry; "rules" uses tags and order only. */
  mode: z.enum(["llm", "rules"]).default("llm"),
  adapter: z.enum(["claude-code", "mock"]).default("claude-code"),
  model: z.string().default("claude-opus-5-5"),
  /** Effort for routing a new ticket. */
  effort: z.string().default("high"),
  /** Effort for re-routing a ticket whose model failed (quota, outage). */
  failoverEffort: z.string().default("medium"),
  timeoutSeconds: z.number().positive().default(120),
  /** Used when the router fails or answers with an unknown id. */
  defaultEntry: z.string().optional(),
});

const Review = z.object({
  /** Before a ready report is posted, a second model from another adapter reviews the branch. */
  enabled: z.boolean().default(false),
  rounds: z.number().int().min(1).max(3).default(1),
  /** Roster ids to use as reviewers, in order of preference. Empty = any entry with another adapter. */
  reviewers: z.array(z.string()).default([]),
});

const GitHub = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  agentLogin: z.string(),
  allow: z.array(z.string()).min(1),
  pollSeconds: z.number().positive().default(30),
});

export const Config = z.object({
  stateDir: z.string(),
  sources: z.object({
    github: GitHub.optional(),
    panel: z.object({ user: z.string() }).optional(),
  }),
  roster: z.array(RosterEntry).min(1),
  router: Router.default({}),
  review: Review.default({}),
  worker: z
    .object({
      maxConcurrent: z.number().int().positive().default(2),
      turnTimeoutMinutes: z.number().positive().default(60),
      maxRetries: z.number().int().min(0).default(3),
      /** How long a model that hit a quota or kept failing is skipped. */
      cooldownMinutes: z.number().positive().default(30),
    })
    .default({}),
  workspace: z.object({
    repoPath: z.string(),
    branchPrefix: z.string().default("agent/"),
    worktreesDir: z.string().optional(),
  }),
  messages: z.object({ maxWords: z.number().int().positive().default(120) }).default({}),
  panel: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().default(3090) }).default({}),
  promptsDir: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

export function parseConfig(raw: unknown): Config {
  const cfg = Config.parse(raw);
  const ids = new Set<string>();
  for (const e of cfg.roster) {
    if (ids.has(e.id)) throw new Error(`roster: duplicate id ${e.id}`);
    ids.add(e.id);
  }
  if (cfg.router.defaultEntry && !ids.has(cfg.router.defaultEntry))
    throw new Error(`router.defaultEntry ${cfg.router.defaultEntry} is not in the roster`);
  for (const r of cfg.review.reviewers)
    if (!ids.has(r)) throw new Error(`review.reviewers: ${r} is not in the roster`);
  if (!cfg.sources.github && !cfg.sources.panel) throw new Error("configure at least one source");
  return cfg;
}

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Every login that may start work, lower-cased. */
export function allowList(cfg: Config): Set<string> {
  const s = new Set<string>((cfg.sources.github?.allow ?? []).map((l) => l.toLowerCase()));
  if (cfg.sources.panel) s.add(cfg.sources.panel.user.toLowerCase());
  return s;
}
