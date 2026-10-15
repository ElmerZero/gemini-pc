#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node ./gemini-pc.cjs "$@"
