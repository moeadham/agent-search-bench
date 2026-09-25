#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ > /tmp/asbench-container-entrypoint-at
  exec tail -f /dev/null
fi

exec node /app/dist/cli.js "$@"
