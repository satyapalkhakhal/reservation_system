#!/usr/bin/env bash
# Usage: ./burst.sh <BASE_URL> [--hot 5000] [--concurrency 1000] ...
# Needs only Node >= 22.18 (runs scripts/burst.ts via built-in type stripping).
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo "usage: ./burst.sh <BASE_URL> [options]" >&2
  exit 2
fi
exec node --disable-warning=ExperimentalWarning "$(dirname "$0")/scripts/burst.ts" "$@"
