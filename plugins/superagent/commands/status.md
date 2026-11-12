---
description: Show superagent tickets that need a person, and which models are available or cooling down
argument-hint: "[panel URL, default http://127.0.0.1:3090]"
---

The panel URL is `$ARGUMENTS`, or `http://127.0.0.1:3090` if that is empty. Fetch `<panel URL>/api/state` with `curl -s` and summarise it in a few lines:

- tickets whose stage is `awaiting-answer`, `blocked`, `failed` or `awaiting-review` first, each with its thread, model, question and PRs;
- then how many tickets are working or queued;
- then the roster: each model that is cooling down (until when, and why), and turns and cost per model.

If the request fails, say the host is not running and suggest `/superagent:start` or `docker compose ps`.
