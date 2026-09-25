#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  exec tail -f /dev/null
fi

exec node /app/dist/cli.js "$@"
