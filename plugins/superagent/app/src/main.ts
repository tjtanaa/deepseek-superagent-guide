#!/usr/bin/env node
// superagent: start | doctor | detect | route
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { detect } from "./detect.ts";
import { Engine } from "./engine.ts";
import { Executor } from "./executor.ts";
import { Outbox } from "./outbox.ts";
import { Router } from "./router.ts";
import { startServer } from "./server.ts";
import { GitHubSource } from "./sources/github.ts";
import { PanelSource } from "./sources/panel.ts";
import type { Source } from "./sources/types.ts";
import { defaultAdapters } from "./workers/index.ts";
import { run } from "./workers/spawn.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c", default: process.env.SUPERAGENT_CONFIG ?? "superagent.json" },
    text: { type: "string" },
  },
});
const cmd = positionals[0] ?? "help";

function hostUrl(cfg: Config) {
  const h = cfg.panel.host === "0.0.0.0" || cfg.panel.host === "::" ? "127.0.0.1" : cfg.panel.host;
  return `http://${h}:${cfg.panel.port}`;
}

async function start() {
  const cfg = loadConfig(values.config!);
  const db = new Db(join(cfg.stateDir, "superagent.db"));
  const engine = new Engine(db, cfg);
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const router = new Router(cfg, undefined, (m) => log(`[router] ${m}`));
  const executor = new Executor(engine, cfg, defaultAdapters(), router, { hostUrl: hostUrl(cfg), log: (m) => log(`[executor] ${m}`) });
  const sources: Record<string, Source> = {};
  let panel: PanelSource | undefined;
  if (cfg.sources.panel) sources.panel = panel = new PanelSource(db, cfg.sources.panel.user);
  if (cfg.sources.github) sources.github = new GitHubSource(db, cfg.sources.github.repo, undefined, (m) => log(`[github] ${m}`));
  const outbox = new Outbox(db, sources, (m) => log(`[outbox] ${m}`));

  executor.recover();
  startServer(engine, executor, panel, cfg);
  log(`panel on http://${cfg.panel.host}:${cfg.panel.port}; roster: ${cfg.roster.filter((e) => e.enabled).map((e) => e.id).join(", ")}; router: ${cfg.router.mode === "llm" ? `${cfg.router.model} (${cfg.router.effort}/${cfg.router.failoverEffort})` : "rules"}`);

  const poll = async () => {
    for (const s of Object.values(sources)) {
      for (const t of await s.poll().catch((e) => (log(String(e)), []))) {
        const r = engine.receive(t);
        if (r.decision !== "duplicate") log(`trigger ${t.id} from @${t.author}: ${r.decision.action}${"reason" in r.decision ? ` (${r.decision.reason})` : ""}`);
      }
    }
  };
  await poll();
  setInterval(poll, (cfg.sources.github?.pollSeconds ?? 30) * 1000);
  setInterval(() => executor.tick(), 2000);
  setInterval(() => outbox.flush().catch((e) => log(String(e))), 3000);
}

async function doctor() {
  const cfg = loadConfig(values.config!);
  const adapters = defaultAdapters();
  const line = (ok: boolean, what: string, detail = "") => console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  let bad = 0;
  const check = async (what: string, fn: () => Promise<string>) => {
    try {
      line(true, what, await fn());
    } catch (e) {
      bad++;
      line(false, what, String((e as Error).message ?? e).slice(0, 200));
    }
  };
  for (const name of new Set(cfg.roster.filter((e) => e.enabled).map((e) => e.adapter)))
    await check(`${name} CLI`, () => adapters[name].version());
  for (const e of cfg.roster.filter((e) => e.enabled))
    line(true, `roster ${e.id}`, `${e.adapter} ${e.model ?? "(default model)"}${e.effort ? ` effort ${e.effort}` : ""}`);
  if (cfg.router.mode === "llm") await check(`router ${cfg.router.model}`, () => adapters["claude-code"].version());
  const gh = cfg.sources.github;
  if (gh) {
    await check("gh login", async () => {
      const r = await run("gh", ["api", "user", "--jq", ".login"]);
      const login = r.stdout.trim();
      if (r.code !== 0) throw new Error(r.stderr.trim());
      if (login.toLowerCase() !== gh.agentLogin.toLowerCase()) throw new Error(`token belongs to @${login}, not @${gh.agentLogin}`);
      return `@${login}`;
    });
    await check("push access", async () => {
      const r = await run("gh", ["api", `repos/${gh.repo}`, "--jq", ".permissions.push"]);
      if (r.stdout.trim() !== "true") throw new Error(`no push access to ${gh.repo}`);
      return gh.repo;
    });
  }
  await check("local clone", async () => {
    if (!existsSync(join(cfg.workspace.repoPath, ".git"))) throw new Error(`${cfg.workspace.repoPath} is not a git clone`);
    const r = await run("git", ["-C", cfg.workspace.repoPath, "remote", "get-url", "origin"]);
    return r.code === 0 ? r.stdout.trim() : "no origin (local-only mode)";
  });
  process.exit(bad ? 1 : 0);
}

async function route() {
  const cfg = loadConfig(values.config!);
  const router = new Router(cfg, undefined, (m) => console.error(`[router] ${m}`));
  const r = await router.route({ purpose: "new", body: values.text ?? "", requester: "you", candidates: cfg.roster.filter((e) => e.enabled) });
  console.log(JSON.stringify({ id: r?.entry.id, by: r?.by, reason: r?.reason }, null, 2));
}

switch (cmd) {
  case "start":
    await start();
    break;
  case "doctor":
    await doctor();
    break;
  case "detect":
    console.log(JSON.stringify(await detect(), null, 2));
    break;
  case "route":
    await route();
    break;
  default:
    console.log(`usage: superagent <start|doctor|detect|route> [--config superagent.json] [--text "..."]`);
}
