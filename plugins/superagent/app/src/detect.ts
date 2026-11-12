// Finds the coding agents and models installed on this machine and proposes a roster.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RosterEntry } from "./config.ts";
import { run } from "./workers/spawn.ts";

export interface Detected {
  claude?: string;
  codex?: string;
  opencode?: string;
  codexModels: { slug: string; defaultEffort?: string; efforts: string[] }[];
  opencodeModels: string[];
  roster: Partial<RosterEntry>[];
}

async function version(bin: string) {
  const r = await run(bin, ["--version"], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Reads visible models from Codex's models cache (`$CODEX_HOME/models_cache.json`). */
export function codexModels(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const file = join(codexHome, "models_cache.json");
  if (!existsSync(file)) return [];
  const found: Detected["codexModels"] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (typeof v.slug === "string") {
      const hidden = String(v.visibility ?? "list").toLowerCase() === "hide";
      if (!hidden) {
        const efforts = (v.supported_reasoning_levels ?? v.supported_reasoning_efforts ?? v.efforts ?? [])
          .map((e: any) => (typeof e === "string" ? e : (e?.effort ?? e?.level)))
          .filter(Boolean);
        found.push({ slug: v.slug, defaultEffort: v.default_reasoning_level ?? v.default_reasoning_effort, efforts });
      }
      return;
    }
    Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
  return found;
}

export async function detect(): Promise<Detected> {
  const claudeBin = process.env.SUPERAGENT_CLAUDE_BIN ?? "claude";
  const codexBin = process.env.SUPERAGENT_CODEX_BIN ?? "codex";
  const opencodeBin = process.env.SUPERAGENT_OPENCODE_BIN ?? "opencode";
  const [claude, codex, opencode] = await Promise.all([version(claudeBin), version(codexBin), version(opencodeBin)]);
  const cm = codex || existsSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json")) ? codexModels() : [];
  let om: string[] = [];
  if (opencode) {
    const r = await run(opencodeBin, ["models"], { timeoutMs: 60_000 });
    if (r.code === 0) om = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l));
  }

  const roster: Partial<RosterEntry>[] = [];
  if (claude) {
    roster.push(
      { id: "claude-opus", adapter: "claude-code", model: "opus", effort: "high", cost: 5, tags: ["hard"], strengths: "Hardest work: design, subtle bugs, large refactors, unclear requests." },
      { id: "claude-sonnet", adapter: "claude-code", model: "sonnet", cost: 2, tags: ["default"], strengths: "Everyday features and fixes; good at following repository conventions." },
      { id: "claude-haiku", adapter: "claude-code", model: "haiku", cost: 1, tags: ["cheap"], strengths: "Small, mechanical changes: typos, renames, config, docs." },
    );
  }
  for (const m of cm) {
    const strongest = m.efforts.includes("high") ? "high" : m.defaultEffort;
    roster.push({
      id: `codex-${m.slug}`.replace(/[^a-z0-9._-]/gi, "-").toLowerCase(),
      adapter: "codex",
      model: m.slug,
      effort: strongest,
      cost: 2,
      strengths: `OpenAI ${m.slug} via Codex CLI. Edit this line to say what it is good at.`,
    });
  }
  for (const m of om.slice(0, 5)) {
    roster.push({ id: `opencode-${m.split("/").pop()}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-"), adapter: "opencode", model: m, cost: 1, strengths: `${m} via OpenCode.` });
  }
  return { claude, codex, opencode, codexModels: cm, opencodeModels: om, roster };
}
