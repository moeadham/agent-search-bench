#!/bin/sh
set -eu

if [ "${ASBENCH_ENABLE_PAID_E2E:-}" != "1" ]; then
  echo "Refusing paid checks: set ASBENCH_ENABLE_PAID_E2E=1 explicitly." >&2
  exit 2
fi

config="${ASBENCH_CONFIG:-agent-search-bench.config.json}"
query="${ASBENCH_LIVE_QUERY:-Find me a provider that aggregates audio models}"
pnpm build
node dist/cli.js doctor --live --config "$config"
node dist/cli.js run --config "$config" --query "$query"
