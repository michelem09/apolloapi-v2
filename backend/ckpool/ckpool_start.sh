#!/bin/bash
# ExecStart of ckpool.service (Type=simple: screen stays in the foreground).
set -Eeuo pipefail

APOLLO_DIR="${APOLLO_DIR:-/opt/apolloapi}"
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
LOG_DIR="${STATE_DIR}/ckpool/logs"
CKPOOL_BIN="${APOLLO_DIR}/backend/ckpool/ckpool"
# ckpool keeps its pid file in its socket dir, which our config leaves at the default.
PIDFILE="${APOLLO_CKPOOL_PIDFILE:-/tmp/ckpool/main.pid}"

mkdir -p "$LOG_DIR"

# Keep the previous run's log (one generation): it is the evidence when a start
# fails, and deleting it blindly destroyed exactly that.
if [ -f "${LOG_DIR}/ckpool.log" ]; then
    mv -f "${LOG_DIR}/ckpool.log" "${LOG_DIR}/ckpool.log.1"
fi

# A pid file left by a ckpool that is gone (or whose pid another process has
# since reused) would be met by the new instance: remove it unless it names our
# own ckpool, checked the way ckpool_stop.sh does.
if [ -f "$PIDFILE" ]; then
    pid="$(tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true)"
    ours=0
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
        case "$args" in "$CKPOOL_BIN"|"$CKPOOL_BIN "*) ours=1 ;; esac
    fi
    [ "$ours" = 1 ] || rm -f "$PIDFILE"
fi

exec screen -D -m -S ckpool "$CKPOOL_BIN" \
    -B \
    -c "${STATE_DIR}/ckpool.conf"
