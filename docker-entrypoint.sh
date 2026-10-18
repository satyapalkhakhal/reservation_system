#!/bin/sh
# Runs migrations (advisory-locked, safe with several replicas), then the API.
# Set RUN_MIGRATIONS=false to run `node dist/db/migrate-cli.js` as a separate
# release step instead.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  attempt=1
  max="${MIGRATION_MAX_ATTEMPTS:-30}"
  # Retry so the app tolerates the database starting after it.
  until node dist/db/migrate-cli.js; do
    if [ "$attempt" -ge "$max" ]; then
      echo "migrations failed after $attempt attempts" >&2
      exit 1
    fi
    echo "migrations not applied yet (attempt $attempt/$max), retrying in 2s" >&2
    attempt=$((attempt + 1))
    sleep 2
  done
fi

exec node dist/server.js
