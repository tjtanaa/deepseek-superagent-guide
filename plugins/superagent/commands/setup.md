---
description: Set up a superagent for one GitHub repository, with Claude and Codex models on its roster
argument-hint: "[OWNER/REPO]"
---

Set up a superagent for the person, following the guide: `README.md` of https://github.com/tjtanaa/deepseek-superagent-guide (in a local clone it is `${CLAUDE_PLUGIN_ROOT}/../../README.md`). Read sections 0, 3, 7, 8 and 11 fully first and the skill `superagent`. The host's code is already written: it lives in `${CLAUDE_PLUGIN_ROOT}/app`. Do not rewrite it.

Steps:

1. Ask the questions in section 0 of the guide one at a time, with the recommended answer. Repository: `$ARGUMENTS` if given.
2. Find every model the person can use: run `node ${CLAUDE_PLUGIN_ROOT}/app/src/main.ts detect` (Node 24; on Node 22 add `--experimental-strip-types`). It reports the Claude Code, Codex and OpenCode CLIs and the Codex models in `~/.codex/models_cache.json`. On Windows the Codex CLI that ships with the Codex desktop app is usually not on PATH: look under `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` and set `SUPERAGENT_CODEX_BIN`. If the `codex@openai-codex` Claude Code plugin is installed, its `/codex:setup` command also reports whether Codex is ready.
3. Write the config from `${CLAUDE_PLUGIN_ROOT}/app/docker/superagent.example.json`: keep every model detect found (the person wants all of them used), fill in the repository, bot login and allow list, and ask the person to adjust each entry's `strengths` and `cost`, because the router reads them. The router stays Claude Opus (`claude-opus-5-5`), effort `high` for new tickets and `medium` for failover, unless the person says otherwise.
4. Copy `docker/.env.sandbox.example` to `docker/.env.sandbox`, `chmod 600` it, and have the person fill it in themselves. Never ask for a secret in the chat; check only whether each is set and its length.
5. Build and start: `cd ${CLAUDE_PLUGIN_ROOT}/app/docker && docker compose up -d --build`. For Codex on a ChatGPT plan, have the person run `docker compose exec superagent codex login --device-auth` once.
6. Run the verification checklist in section 8 and show each result, starting with `docker compose exec superagent node src/main.ts doctor`.
