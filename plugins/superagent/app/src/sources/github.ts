import type { Db, Row } from "../db.ts";
import type { Trigger } from "../gate.ts";
import { run } from "../workers/spawn.ts";
import { AUTOMATED_HEADER, type SendResult, type Source } from "./types.ts";

export type Gh = (args: string[], stdin?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const ghCli: Gh = (args, stdin) => run(process.env.SUPERAGENT_GH_BIN ?? "gh", args, { stdin, timeoutMs: 120_000 });

const isBot = (u: any) => u?.type === "Bot" || String(u?.login ?? "").endsWith("[bot]");
const numFromUrl = (url: string) => Number(String(url).split("/").pop());

/**
 * Polls one repository with `gh api`, one `since` cursor per endpoint, so a
 * failing endpoint holds back only itself. Overlap between polls is absorbed by
 * idempotent trigger ids.
 */
export class GitHubSource implements Source {
  readonly name = "github";
  private db: Db;
  private repo: string;
  private gh: Gh;
  private log: (m: string) => void;
  constructor(db: Db, repo: string, gh: Gh = ghCli, log: (m: string) => void = (m) => console.log(`[github] ${m}`)) {
    this.db = db;
    this.repo = repo;
    this.gh = gh;
    this.log = log;
  }

  thread(n: number) {
    return `github:${this.repo}#${n}`;
  }

  private async list(path: string): Promise<any[]> {
    const r = await this.gh(["api", "--paginate", "--slurp", path]);
    if (r.code !== 0) throw new Error(`${path}: ${r.stderr.trim().slice(0, 200)}`);
    const pages = JSON.parse(r.stdout || "[]");
    return Array.isArray(pages) ? pages.flat() : [];
  }

  private async one(path: string): Promise<any> {
    const r = await this.gh(["api", path]);
    if (r.code !== 0) throw new Error(`${path}: ${r.stderr.trim().slice(0, 200)}`);
    return JSON.parse(r.stdout);
  }

  /** Runs fn with this endpoint's cursor; on success the cursor moves to poll start minus 10 seconds. */
  private async withCursor(key: string, fn: (since: string) => Promise<Trigger[]>): Promise<Trigger[]> {
    const start = new Date();
    const cursorKey = `github:${this.repo}:${key}`;
    let since = this.db.cursor(cursorKey);
    if (!since) {
      // First run starts at "now", so history is never replayed.
      this.db.setCursor(cursorKey, start.toISOString());
      return [];
    }
    try {
      const out = await fn(since);
      this.db.setCursor(cursorKey, new Date(start.getTime() - 10_000).toISOString());
      return out;
    } catch (e) {
      this.log(String(e));
      return [];
    }
  }

  async poll(): Promise<Trigger[]> {
    const q = (since: string) => `state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`;
    const out: Trigger[] = [];

    out.push(
      ...(await this.withCursor("issues", async (since) =>
        (await this.list(`repos/${this.repo}/issues?${q(since)}`))
          .filter((i) => i.created_at >= since)
          .map((i) => ({
            id: `github:issue:${i.number}`,
            source: "github",
            thread: this.thread(i.number),
            kind: "issue" as const,
            author: i.user?.login ?? "",
            isBot: isBot(i.user),
            body: `${i.title}\n\n${i.body ?? ""}`,
            url: i.html_url,
            createdAt: i.created_at,
            meta: { title: i.title },
          })),
      )),
    );

    out.push(
      ...(await this.withCursor("comments", async (since) =>
        (await this.list(`repos/${this.repo}/issues/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`))
          .filter((c) => c.created_at >= since)
          .map((c) => ({
            id: `github:comment:${c.id}`,
            source: "github",
            thread: this.thread(numFromUrl(c.issue_url)),
            kind: "comment" as const,
            author: c.user?.login ?? "",
            isBot: isBot(c.user),
            body: c.body ?? "",
            url: c.html_url,
            createdAt: c.created_at,
          })),
      )),
    );

    out.push(
      ...(await this.withCursor("review_comments", async (since) =>
        (await this.list(`repos/${this.repo}/pulls/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`))
          .filter((c) => c.created_at >= since)
          .map((c) => ({
            id: `github:comment:${c.id}`,
            source: "github",
            thread: this.thread(numFromUrl(c.pull_request_url)),
            kind: "review_comment" as const,
            author: c.user?.login ?? "",
            isBot: isBot(c.user),
            body: `${c.path}${c.line ? `:${c.line}` : ""}\n${c.body ?? ""}`,
            url: c.html_url,
            createdAt: c.created_at,
            meta: { replyTarget: String(c.in_reply_to_id ?? c.id), pr: numFromUrl(c.pull_request_url) },
          })),
      )),
    );

    out.push(...(await this.pollFollowedPrs()));
    return out;
  }

  /** Reviews, CI and merge/close state for PRs that open tickets follow. */
  private async pollFollowedPrs(): Promise<Trigger[]> {
    const out: Trigger[] = [];
    const prs = this.db.all(
      "SELECT DISTINCT p.number FROM prs p JOIN tickets t ON t.id = p.ticket_id WHERE p.state = 'open' AND t.status = 'open'",
    );
    for (const { number: n } of prs) {
      try {
        const pr = await this.one(`repos/${this.repo}/pulls/${n}`);
        const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
        if (state !== "open")
          out.push({
            id: `github:pr:${n}:${state}`, source: "github", thread: this.thread(n), kind: "pr_state",
            author: pr.merged_by?.login ?? pr.user?.login ?? "github", isBot: true, body: `Pull request #${n} was ${state}.`,
            url: pr.html_url, createdAt: pr.closed_at ?? new Date().toISOString(), meta: { pr: n, prState: state },
          });

        for (const r of await this.list(`repos/${this.repo}/pulls/${n}/reviews?per_page=100`)) {
          if (!r.body && r.state === "COMMENTED") continue; // body-less wrapper of inline comments
          out.push({
            id: `github:review:${r.id}`, source: "github", thread: this.thread(n), kind: "review",
            author: r.user?.login ?? "", isBot: isBot(r.user), body: `[${r.state}] ${r.body ?? ""}`,
            url: r.html_url, createdAt: r.submitted_at ?? new Date().toISOString(),
          });
        }

        const sha = pr.head?.sha;
        if (sha && state === "open") {
          const checks = (await this.one(`repos/${this.repo}/commits/${sha}/check-runs?per_page=100`)).check_runs ?? [];
          if (checks.length && checks.every((c: any) => c.status === "completed")) {
            const failed = checks.filter((c: any) => !["success", "neutral", "skipped"].includes(c.conclusion));
            const outcome = failed.length ? "failure" : "success";
            out.push({
              id: `github:ci:${sha}:${outcome}`, source: "github", thread: this.thread(n), kind: "ci",
              author: "github-actions[bot]", isBot: true,
              body: failed.length
                ? `CI failed on ${sha.slice(0, 7)}: ${failed.map((c: any) => `${c.name} (${c.conclusion}) ${c.html_url}`).join("; ")}`
                : `CI passed on ${sha.slice(0, 7)}.`,
              createdAt: new Date().toISOString(), meta: { ciOutcome: outcome, pr: n },
            });
          }
        }
      } catch (e) {
        this.log(String(e));
      }
    }
    return out;
  }

  async send(row: Row): Promise<SendResult> {
    const n = Number(String(row.thread).split("#").pop());
    const path = row.reply_to
      ? `repos/${this.repo}/pulls/${n}/comments/${row.reply_to}/replies`
      : `repos/${this.repo}/issues/${n}/comments`;
    const body = `${AUTOMATED_HEADER}\n\n${row.body}`;
    const r = await this.gh(["api", "-X", "POST", path, "--input", "-"], JSON.stringify({ body }));
    if (r.code === 0) return { ok: true };
    const err = (r.stderr || r.stdout).trim().slice(0, 300);
    const permanent = /HTTP 410/.test(err) || (/HTTP 403/.test(err) && /locked/i.test(err));
    return { ok: false, permanent, error: err };
  }
}
