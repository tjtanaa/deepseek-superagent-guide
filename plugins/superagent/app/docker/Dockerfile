# One long-running container: the host and every worker CLI.
FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.2
# OpenCode is optional; leave empty to skip it.
ARG OPENCODE_VERSION=

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && if [ -n "$OPENCODE_VERSION" ]; then npm install -g "opencode-ai@${OPENCODE_VERSION}"; fi

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY bin ./bin
COPY prompts ./prompts
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh bin/sa

ENV DISABLE_AUTOUPDATER=1 HOME=/data/home SUPERAGENT_CONFIG=/config/superagent.json
USER node
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
CMD ["node", "src/main.ts", "start"]
