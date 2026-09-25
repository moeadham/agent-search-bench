FROM node:26-bookworm-slim AS agent-runtime

ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCLAW_VERSION=latest
ARG OPENCLAW_BRAVE_PLUGIN_VERSION=latest
ARG HERMES_INSTALL_URL=https://hermes-agent.nousresearch.com/install.sh

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/opt/pnpm \
    INSTALL_HOME=/opt/agent-install \
    PATH=/opt/pnpm:/opt/agent-install/.local/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.22.0 \
    && mkdir -p "$INSTALL_HOME"

ENV HOME=$INSTALL_HOME
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "openclaw@${OPENCLAW_VERSION}" \
    && mkdir -p /opt/openclaw-template /opt/openclaw-plugins \
    && npm install --prefix /opt/openclaw-plugins/brave-package "@openclaw/brave-plugin@${OPENCLAW_BRAVE_PLUGIN_VERSION}" \
    && npm cache clean --force

ENV HERMES_RUNTIME_DIR=/opt/agent-install/.hermes/tools

RUN chown -R node:node "$INSTALL_HOME"
USER node

# Official installers are URL-overridable so a reviewed, versioned installer
# artifact can be supplied by production builds.
RUN curl -fsSL "$HERMES_INSTALL_URL" | bash -s -- --skip-browser \
    && test -x "$INSTALL_HOME/.local/bin/hermes"

# Hermes' Firecrawl provider lazily imports an optional dependency. Ask
# Hermes' package manager to install its pinned extra so this follows Hermes'
# current isolated-runtime layout.
RUN hermes pm install --extra firecrawl

# Hermes creates ephemeral process leases beside each selected environment.
# Keep dependencies immutable at runtime while directing leases to tmpfs.
RUN mkdir -p /tmp/hermes-leases \
    && for environment in "$INSTALL_HOME"/.hermes/installs/*/environments/*; do \
         rm -rf "$environment/.leases"; \
         ln -s /tmp/hermes-leases "$environment/.leases"; \
       done

USER root

FROM agent-runtime AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile=false
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM agent-runtime AS final
ARG BUILD_ID=local
ENV ASBENCH_IMAGE_ID=$BUILD_ID \
    ASBENCH_OPENCLAW_PLUGIN_PATH=/opt/openclaw-plugins/brave-package/node_modules/@openclaw/brave-plugin \
    ASBENCH_HERMES_RUNTIME_HOME=/opt/agent-install/.hermes \
    HOME=/home/node \
    NODE_ENV=production
RUN mkdir -p /app /runs /config \
    && chown -R node:node /app /runs /config /home/node
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node cloudflare/agent-search-bench.config.json /config/agent-search-bench.config.json
COPY --chown=node:node scripts/container-entrypoint.sh /app/container-entrypoint.sh
RUN chmod 755 /app/container-entrypoint.sh
USER node
ENTRYPOINT ["/app/container-entrypoint.sh"]
