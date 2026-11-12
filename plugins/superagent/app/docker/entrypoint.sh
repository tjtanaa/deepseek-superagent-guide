#!/bin/sh
# Checks on every start; each fails with a clear message.
set -eu
die() { echo "superagent: $*" >&2; exit 1; }

mkdir -p "$HOME" /data/state
[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set (.env.sandbox)"
[ -n "${BOT_LOGIN:-}" ] || die "BOT_LOGIN is not set (.env.sandbox)"
[ -n "${REPO:-}" ] || die "REPO is not set (.env.sandbox)"
[ -f "$SUPERAGENT_CONFIG" ] || die "config $SUPERAGENT_CONFIG is missing"

# At least one model provider.
node -e '
const c = JSON.parse(require("fs").readFileSync(process.env.SUPERAGENT_CONFIG, "utf8"));
const used = new Set(c.roster.filter(e => e.enabled !== false).map(e => e.adapter));
const fs = require("fs"), home = process.env.HOME;
const claude = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
const codex = !!process.env.OPENAI_API_KEY || fs.existsSync(home + "/.codex/auth.json");
const missing = [];
if ((used.has("claude-code") || (c.router?.mode ?? "llm") === "llm") && !claude) missing.push("claude-code (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)");
if (used.has("codex") && !codex) missing.push("codex (OPENAI_API_KEY, or run: docker compose exec superagent codex login --device-auth)");
if (missing.length) { console.error("superagent: no credentials for " + missing.join("; ")); process.exit(1); }
' || exit 1

if [ -n "${OPENAI_API_KEY:-}" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
  printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null
fi

login=$(gh api user --jq .login) || die "GH_TOKEN does not work"
[ "$(echo "$login" | tr A-Z a-z)" = "$(echo "$BOT_LOGIN" | tr A-Z a-z)" ] || die "GH_TOKEN belongs to @$login, not @$BOT_LOGIN"

git config --global credential.https://github.com.helper '!gh auth git-credential'
git config --global user.name "$BOT_LOGIN"
git config --global user.email "${BOT_ID:-0}+${BOT_LOGIN}@users.noreply.github.com"

for id in $(gh api user/repository_invitations --jq ".[] | select(.repository.full_name == \"$REPO\") | .id"); do
  gh api -X PATCH "user/repository_invitations/$id" >/dev/null && echo "accepted invitation to $REPO"
done
[ "$(gh api "repos/$REPO" --jq .permissions.push)" = "true" ] || die "@$BOT_LOGIN has no push access to $REPO"

[ -d /data/repo/.git ] || git clone "https://github.com/$REPO.git" /data/repo

exec "$@"
