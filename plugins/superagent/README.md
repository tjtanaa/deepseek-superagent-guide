# superagent plugin

A self-hosted superagent after DeepSeek's [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype): people mention a bot on GitHub, the host opens a ticket, and a coding agent works it in its own git worktree. Workers can be Claude Code, OpenAI Codex or OpenCode; Claude Opus routes each ticket to one model on your roster and fails over to another provider when a model runs out of quota.

The design, setup and verification steps are in the [guide](../../README.md); section 11 covers this plugin. The host is in `app/`, the Claude Code commands in `commands/`, and the operating notes for agents in `skills/superagent/SKILL.md`.
