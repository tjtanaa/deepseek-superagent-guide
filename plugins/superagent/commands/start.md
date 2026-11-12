---
description: Start the superagent host locally (no Docker) with a config file
argument-hint: "[path/to/superagent.json]"
---

Start the superagent host from `${CLAUDE_PLUGIN_ROOT}/app` in the background. The config file is `$ARGUMENTS`; if that is empty, use `superagent.json` in the current directory. Call it CONFIG below and pass it as an absolute path.

1. If `node_modules` is missing there, run `npm install --omit=dev` in that directory.
2. Run `node src/main.ts doctor --config "CONFIG"` and show the result. Stop and explain any FAIL line.
3. Start it with Bash `run_in_background`: `node src/main.ts start --config "CONFIG"` (add `--experimental-strip-types` before `src/main.ts` on Node 22).
4. Tell the person the panel address from the first log line. Workers run with permission prompts off, so recommend the Docker setup (`/superagent:setup`) for anything beyond a local sandbox repository.
