---
name: superagent
description: Set up, run, tune or debug a self-hosted superagent (DeepSeek's pattern) whose workers are Claude Code and OpenAI Codex models chosen per ticket by a Claude Opus router. Use when the person asks about the superagent host, its model roster, routing, Codex workers, the sa CLI, or tickets that are stuck.
---

# Superagent with Claude and Codex workers

The host is in `${CLAUDE_PLUGIN_ROOT}/app` (Node 24, TypeScript run directly, SQLite via `node:sqlite`, `zod`). The design it implements is the guide's README: tickets, the deterministic gate, subscriptions, the `sa` contract, quiet messaging. Read the guide before changing behaviour; keep its principles.

## Layout

| File | What it does |
| --- | --- |
| `src/gate.ts` | Who may start, stop or reach a ticket. Pure function; text never grants permission |
| `src/engine.ts` | Only writer of triggers, tickets, inputs; the `sa` worker API; stages |
| `src/router.ts` | Picks a roster entry: `model:` hint, then the Opus router, then rules |
| `src/executor.ts` | Worker slots, worktrees, turns, retries, cooldown and failover, cross-model review, restart recovery |
| `src/workers/{claude-code,codex,opencode,mock}.ts` | One adapter per agent CLI: `run(turn) → { ok, sessionId, text, error, transient, exhausted, costUsd }` |
| `src/sources/{github,panel}.ts`, `src/outbox.ts` | Polling GitHub with `gh`, the local panel, ordered retried sending |
| `src/server.ts`, `bin/sa` | Panel page, `/api/state`, `/api/worker/<cmd>` and the CLI workers call |
| `prompts/*.md` | Worker, host and team instructions, re-read every turn |
| `docker/` | Image, compose file, entrypoint checks, example config |

## Model roster and routing

- `roster[]`: `id`, `adapter` (`claude-code` · `codex` · `opencode`), `model`, `effort`, `strengths`, `tags`, `cost`, `maxConcurrent`, `enabled`.
- `router`: `mode` `llm` (default) or `rules`; `model` `claude-opus-5-5`; `effort` `high` for new tickets, `failoverEffort` `medium`. The router gets only the entries available now, has no tools, and its answer is checked against those ids.
- An allowed person can write `model:<id>` or `model:<tag>` in a request or follow-up to choose.
- A ticket keeps its model. On a quota error (`exhausted`), or on transient errors beyond `worker.maxRetries`, the model cools down for `worker.cooldownMinutes` and the ticket moves to another model, preferring another provider, with a handoff note.
- `review.enabled`: the first `ready` report is held while a model from another adapter reviews the branch read-only; its findings come back as an input.

## Codex specifics (checked with codex-cli 0.167)

- First turn: `codex exec --json --skip-git-repo-check -m <model> -c model_reasoning_effort="<effort>" -c developer_instructions="<host instructions>" --dangerously-bypass-approvals-and-sandbox -` (the message goes on stdin). The session id is `thread_id` on the `thread.started` event; the final text is the last `item.completed` with `item.type == "agent_message"`; `turn.completed` means success, `turn.failed`/`error` carry the error.
- Later turns: `codex exec resume --json ... <thread_id> -`. `resume` has no `--sandbox` flag, so reviewers use `-c sandbox_mode="read-only"`.
- Models: `~/.codex/models_cache.json` lists them; `main.ts detect` reads it. Auth: `OPENAI_API_KEY` (`codex login --with-api-key`) or a ChatGPT plan (`codex login --device-auth`), stored under `$CODEX_HOME`.
- The `codex@openai-codex` Claude Code plugin (`/codex:rescue`, `/codex:review`) drives Codex through `codex app-server` for interactive use. The superagent does not depend on it; it calls the Codex CLI directly, like the other adapters.
- On Windows the Codex desktop app's CLI is usually not on PATH; set `SUPERAGENT_CODEX_BIN`. Likewise `SUPERAGENT_CLAUDE_BIN`, `SUPERAGENT_OPENCODE_BIN`, `SUPERAGENT_GH_BIN`.

## Commands

`node src/main.ts start | doctor | detect | route --text "..."` with `--config <file>`. Tests: `npm test` (Node 24) or `node --experimental-strip-types --test test/*.test.ts` (Node 22). Check types with `npm run typecheck`.

## Debugging a stuck ticket

1. `/superagent:status`, or `curl -s 127.0.0.1:3090/api/state`.
2. The SQLite file is `<stateDir>/superagent.db`: `turns` has every turn's model, error and final text; `inputs.turn_id IS NULL` are pending; `cooldowns` shows benched models; `outbox` shows unsent or dropped messages with reasons.
3. Re-run a model by hand in the ticket's directory with the same CLI flags the adapter uses.
