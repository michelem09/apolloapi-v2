#!/bin/bash
set -Eeuo pipefail

# Derive from the script's own location so it works whether the code lives at
# /opt/apolloapi (legacy checkout) or /opt/apolloapi/current/... (release layout).
APOLLO_DIR="${APOLLO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
LOG_DIR="${STATE_DIR}/ckpool/logs"

mkdir -p "$LOG_DIR"
rm -f "${LOG_DIR}/ckpool.log"

exec screen -D -m -S ckpool "${APOLLO_DIR}/backend/ckpool/ckpool" \
    -B \
    -c "${STATE_DIR}/ckpool.conf"
