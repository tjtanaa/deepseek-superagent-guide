---
description: Dry-run the router - ask Claude Opus which roster model it would pick for a request
argument-hint: "<request text> [--config superagent.json]"
---

Run `node ${CLAUDE_PLUGIN_ROOT}/app/src/main.ts route --config superagent.json --text "$ARGUMENTS"` (add `--experimental-strip-types` on Node 22) and report the chosen roster id, whether it came from a `model:` hint, the router or the rule-based fallback, and the router's reason. Nothing is created and no worker runs.
