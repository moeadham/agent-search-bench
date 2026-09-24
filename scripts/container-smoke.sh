#!/bin/sh
set -eu

image="${ASBENCH_SMOKE_IMAGE:-agent-search-bench:smoke}"
docker build -t "$image" .
docker run --rm --entrypoint sh "$image" -c '
  claude --version
  codex --version
  openclaw --version
  hermes --version
'
docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid \
  --tmpfs /home/node:rw,nosuid \
  -e SMOKE_AGENT_KEY=available-for-non-live-inspection \
  -e SMOKE_JUDGE_KEY=separate-non-live-inspection-key \
  -v "$(pwd)/tests/fixtures/container.config.json:/config/agent-search-bench.config.json:ro" \
  "$image" doctor --config /config/agent-search-bench.config.json
