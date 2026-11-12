import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { type Engine, NEEDS_PERSON, Refused } from "./engine.ts";
import type { Executor } from "./executor.ts";
import type { PanelSource } from "./sources/panel.ts";

// The panel has no login: bind it to 127.0.0.1. The worker API is authenticated
// by each ticket's own random token.

export function startServer(engine: Engine, executor: Executor, panel: PanelSource | undefined, cfg: Config): Server {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, engine, executor, panel, cfg);
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  });
  server.listen(cfg.panel.port, cfg.panel.host);
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, engine: Engine, executor: Executor, panel: PanelSource | undefined, cfg: Config) {
  const url = new URL(req.url ?? "/", "http://x");
  const worker = /^\/api\/worker\/(\w+)$/.exec(url.pathname);
  if (worker && req.method === "POST") {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    try {
      return send(res, 200, engine.command(token, worker[1]!, await body(req)));
    } catch (e) {
      if (e instanceof Refused) return send(res, 403, { refused: e.message });
      throw e;
    }
  }
  if (url.pathname === "/api/state") return send(res, 200, state(engine, executor));
  if (url.pathname === "/api/request" && req.method === "POST") {
    if (!panel) return send(res, 404, { error: "the panel source is not configured" });
    const b = await body(req);
    if (!b.text?.trim()) return send(res, 400, { error: "text is required" });
    const out = engine.receive(panel.request(String(b.text), b.thread || undefined));
    executor.tick();
    return send(res, 200, out);
  }
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE(cfg));
  }
  send(res, 404, { error: "not found" });
}

export function state(engine: Engine, executor: Executor) {
  const db = engine.db;
  const tickets = db
    .all("SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 200")
    .map((t) => ({
      id: t.id, name: t.name, thread: t.thread, requester: t.requester, stage: engine.stage(t),
      model: t.roster_id, routeReason: t.route_reason, endReason: t.end_reason, question: t.report_question,
      prs: db.all("SELECT number, state FROM prs WHERE ticket_id = ?", t.id),
      cost: db.get("SELECT COALESCE(SUM(cost_usd), 0) c FROM turns WHERE ticket_id = ?", t.id)!.c,
      updatedAt: t.updated_at,
    }))
    .sort((a, b) => Number(NEEDS_PERSON.includes(b.stage)) - Number(NEEDS_PERSON.includes(a.stage)));
  const avail = new Set(executor.available().map((e) => e.id));
  const cooldowns = new Map(db.all("SELECT * FROM cooldowns WHERE until > ?", new Date().toISOString()).map((r) => [r.roster_id, r]));
  const roster = engine.cfg.roster.map((e) => ({
    id: e.id, adapter: e.adapter, model: e.model ?? "(default)", effort: e.effort ?? "", enabled: e.enabled,
    available: avail.has(e.id), cooldownUntil: cooldowns.get(e.id)?.until, cooldownReason: cooldowns.get(e.id)?.reason,
    turns: db.get("SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) c FROM turns WHERE roster_id = ?", e.id),
  }));
  const messages = db.all("SELECT * FROM panel_messages ORDER BY id DESC LIMIT 100");
  return { tickets, roster, router: engine.cfg.router, messages };
}

function body(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Refused("body is not JSON"));
      }
    });
  });
}

function send(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const PAGE = (cfg: Config) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superagent</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--warn:#b45309;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--warn:#f59e0b;--ok:#4ade80}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px}
h1{font-size:20px}h2{font-size:15px;margin-top:24px}
table{width:100%;border-collapse:collapse;background:var(--card)}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500}.needs{color:var(--warn);font-weight:600}.ok{color:var(--ok)}.muted{color:var(--muted)}
textarea{width:100%;box-sizing:border-box;min-height:70px;background:var(--card);color:var(--fg);border:1px solid var(--line);padding:8px}
button{margin-top:6px;padding:6px 14px}.wrap{overflow-x:auto}
</style></head><body>
<h1>Superagent</h1>
${cfg.sources.panel ? `<form id="f"><textarea name="text" placeholder="Ask for work as @${cfg.sources.panel.user}. Add model:&lt;id&gt; to pick a model."></textarea><button>Send</button></form>` : ""}
<h2>Tickets</h2><div class="wrap"><table id="t"></table></div>
<h2>Models</h2><div class="wrap"><table id="r"></table></div>
<h2>Panel messages</h2><div class="wrap"><table id="m"></table></div>
<script>
const NEEDS=${JSON.stringify(NEEDS_PERSON)};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function load(){const s=await (await fetch("/api/state")).json();
t.innerHTML="<tr><th>Ticket</th><th>Stage</th><th>Model</th><th>PRs</th><th>Cost</th></tr>"+s.tickets.map(k=>"<tr><td>"+esc(k.name)+"<div class=muted>"+esc(k.thread)+"</div></td><td class='"+(NEEDS.includes(k.stage)?"needs":"")+"'>"+esc(k.stage)+(k.endReason?" ("+esc(k.endReason)+")":"")+(k.question?"<div>"+esc(k.question)+"</div>":"")+"</td><td>"+esc(k.model)+"<div class=muted>"+esc(k.routeReason)+"</div></td><td>"+k.prs.map(p=>"#"+p.number+" "+p.state).join(", ")+"</td><td>$"+Number(k.cost).toFixed(2)+"</td></tr>").join("");
r.innerHTML="<tr><th>Id</th><th>Agent</th><th>Model</th><th>State</th><th>Turns</th></tr>"+s.roster.map(e=>"<tr><td>"+esc(e.id)+"</td><td>"+esc(e.adapter)+"</td><td>"+esc(e.model)+" "+esc(e.effort)+"</td><td class='"+(e.available?"ok":"needs")+"'>"+(!e.enabled?"disabled":e.cooldownUntil?"cooling down until "+esc(e.cooldownUntil)+"<div class=muted>"+esc(e.cooldownReason)+"</div>":e.available?"available":"busy")+"</td><td>"+e.turns.n+" · $"+Number(e.turns.c).toFixed(2)+"</td></tr>").join("");
m.innerHTML=s.messages.map(x=>"<tr><td class=muted>"+esc(x.thread)+"</td><td>@"+esc(x.author)+"</td><td>"+esc(x.body)+"</td></tr>").join("");}
const f=document.getElementById("f");if(f)f.onsubmit=async e=>{e.preventDefault();await fetch("/api/request",{method:"POST",body:JSON.stringify({text:f.text.value})});f.text.value="";load()};
load();setInterval(load,3000);
</script></body></html>`;
