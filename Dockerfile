FROM node:26-trixie-slim AS agent-base

ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
ARG DEEPSEEK_VERSION=next
ARG OPENCLAW_VERSION=latest
ARG OPENCLAW_BRAVE_PLUGIN_VERSION=latest
ARG HERMES_INSTALL_URL=https://hermes-agent.nousresearch.com/install.sh
ARG ANTIGRAVITY_INSTALL_URL=https://antigravity.google/cli/install.sh

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
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code,@google/genai,esbuild,koffi,@deepseek-ai/dsh-subprocess-local,node-pty,protobufjs,openclaw \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@deepseek-ai/dsh@${DEEPSEEK_VERSION}" \
      "openclaw@${OPENCLAW_VERSION}" \
    && mkdir -p /opt/openclaw-template /opt/openclaw-plugins \
    && npm install --prefix /opt/openclaw-plugins/brave-package "@openclaw/brave-plugin@${OPENCLAW_BRAVE_PLUGIN_VERSION}" \
    && npm cache clean --force

ENV HERMES_RUNTIME_DIR=/opt/agent-install/.hermes/tools

RUN chown -R node:node "$INSTALL_HOME"
USER node

# Keep Antigravity in the shared runtime without making Hermes' large build
# depend on it, so either installer can be updated independently.
FROM agent-base AS antigravity-base

# Antigravity publishes a native Linux binary through its official installer.
# The URL is overridable so production builds can point at a reviewed artifact.
RUN curl -fsSL "$ANTIGRAVITY_INSTALL_URL" | bash -s -- --dir "$INSTALL_HOME/.local/bin" \
    && test -x "$INSTALL_HOME/.local/bin/agy"

USER root

# Build Hermes separately so its runtime can be copied into the final image in
# bounded layers. This avoids a Docker/containerd registry timeout on the
# installer's former multi-gigabyte layer.
FROM agent-base AS hermes-runtime
USER node

# Official installers are URL-overridable so a reviewed, versioned installer
# artifact can be supplied by production builds.
RUN curl -fsSL "$HERMES_INSTALL_URL" | bash -s -- --skip-browser \
    && test -x "$INSTALL_HOME/.local/bin/hermes"

# Hermes' Firecrawl provider lazily imports an optional dependency. Ask
# Hermes' package manager to install its pinned extra so this follows Hermes'
# current isolated-runtime layout.
RUN hermes pm install --extra firecrawl

# Installer download caches and Git history are not used by benchmark turns.
RUN rm -rf "$INSTALL_HOME/.hermes/cache" "$INSTALL_HOME/.hermes/hermes-agent/.git"

# Hermes creates ephemeral process leases beside each selected environment.
# Keep dependencies immutable at runtime while directing leases to tmpfs.
RUN mkdir -p /tmp/hermes-leases \
    && for environment in "$INSTALL_HOME"/.hermes/installs/*/environments/*; do \
         rm -rf "$environment/.leases"; \
         ln -s /tmp/hermes-leases "$environment/.leases"; \
       done

USER root

FROM antigravity-base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile=false
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM antigravity-base AS final
ARG BUILD_ID=local
ENV ASBENCH_IMAGE_ID=$BUILD_ID \
    ASBENCH_OPENCLAW_PLUGIN_PATH=/opt/openclaw-plugins/brave-package/node_modules/@openclaw/brave-plugin \
    ASBENCH_HERMES_RUNTIME_HOME=/opt/agent-install/.hermes \
    HOME=/home/node \
    NODE_ENV=production
RUN mkdir -p /app /runs /config \
    /tmp/hermes-leases \
    && chown -R node:node /app /runs /config /home/node /tmp/hermes-leases
WORKDIR /app
# Keep each Hermes component in a separate registry layer. The wrapper invokes
# the checked-out Python package while the orchestrator shares installs/tools
# read-only into each isolated trial home.
COPY --from=hermes-runtime --chown=node:node /opt/agent-install/.local/bin/hermes /opt/agent-install/.local/bin/hermes
COPY --from=hermes-runtime --chown=node:node /opt/agent-install/.local/bin/hermes-acp /opt/agent-install/.local/bin/hermes-acp
COPY --from=hermes-runtime --chown=node:node /opt/agent-install/.local/bin/hermes-agent /opt/agent-install/.local/bin/hermes-agent
COPY --from=hermes-runtime --chown=node:node /opt/agent-install/.hermes/hermes-agent /opt/agent-install/.hermes/hermes-agent
COPY --from=hermes-runtime --chown=node:node /opt/agent-install/.hermes/installs /opt/agent-install/.hermes/installs
COPY --from=hermes-runtime --chown=node:node /opt/agent-install/.hermes/tools /opt/agent-install/.hermes/tools
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node cloudflare/agent-search-bench.config.json /config/agent-search-bench.config.json
COPY --chown=node:node scripts/container-entrypoint.sh /app/container-entrypoint.sh
RUN chmod 755 /app/container-entrypoint.sh
USER node
ENTRYPOINT ["/app/container-entrypoint.sh"]
