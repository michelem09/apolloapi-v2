#!/bin/bash
# ExecStart of ckpool.service (Type=simple: this script stays in the foreground
# for as long as screen, and so ckpool, runs).
#
# `screen -D -m` exits 0 whatever its child did (checked on Debian's screen
# 4.09: ckpool exiting 3 or dying by SEGV both give 0). Exec'ing it made systemd
# see every crash as a clean exit: Restart=on-failure never fired, the unit went
# inactive and the service monitor read that as a manual stop. So ckpool runs
# through a small sh wrapper that records its real exit status, and this script
# exits with it (128+n for a death by signal n, as sh reports it).
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

STATUS_FILE="${STATE_DIR}/ckpool/exit-status"
# A status left by the previous run must not be mistaken for this one's.
rm -f "$STATUS_FILE"

# The wrapper runs ckpool as a child and forwards HUP/TERM to it: `screen -X
# quit` (ckpool_stop.sh) HUPs everything in the window, and a wrapper killed
# before it could write the status would turn every requested stop into a crash.
# $1 = status file, the rest = the command. No user input reaches it.
WRAPPER='status="$1"; shift
"$@" & child=$!
got=0
trap "got=1; kill -HUP $child 2>/dev/null" HUP
trap "got=1; kill -TERM $child 2>/dev/null" TERM
while :; do
    got=0
    wait "$child"; rc=$?
    [ "$got" = 1 ] || break
done
printf "%s\n" "$rc" > "$status"
exit "$rc"'

screen_rc=0
screen -D -m -S ckpool sh -c "$WRAPPER" ckpool-wrapper "$STATUS_FILE" \
    "$CKPOOL_BIN" \
    -B \
    -c "${STATE_DIR}/ckpool.conf" || screen_rc=$?

# What ckpool really did. A missing or garbled status (the wrapper never ran, or
# was killed outright) is a failure, never a clean exit.
status=""
if [ -r "$STATUS_FILE" ]; then
    status="$(tr -d '[:space:]' < "$STATUS_FILE" 2>/dev/null || true)"
fi
case "$status" in
    ''|*[!0-9]*) status="" ;;
    *) if [ "${#status}" -gt 3 ] || [ "$status" -gt 255 ]; then status=""; fi ;;
esac
if [ -n "$status" ]; then
    exit "$status"
fi
echo "ckpool_start.sh: no usable exit status from ckpool (screen exit ${screen_rc})" >&2
if [ "$screen_rc" -ne 0 ]; then exit "$screen_rc"; fi
exit 1
