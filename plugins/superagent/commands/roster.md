---
description: List every Claude, Codex and OpenCode model available on this machine and propose roster entries
---

Run `node ${CLAUDE_PLUGIN_ROOT}/app/src/main.ts detect` (add `--experimental-strip-types` on Node 22) and show:

1. which agent CLIs were found, with versions (Claude Code, Codex, OpenCode);
2. the Codex models from the models cache, with their reasoning efforts;
3. the proposed roster entries as JSON, ready to paste into `superagent.json`.

If Codex shows no CLI but models were found, the Codex desktop app's CLI is probably not on PATH: on Windows look for `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` and suggest setting `SUPERAGENT_CODEX_BIN` to it. Remind the person that the router chooses using each entry's `strengths` and `cost`, so those lines are worth editing.
