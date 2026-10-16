#!/bin/bash
# ExecStop of ckpool.service. `screen -X quit` only *asks* and returns at once;
# this waits until ckpool has really exited (TERM, then KILL, if it is slow), so
# a restart never starts the new ckpool on top of the old one. Having nothing to
# stop is a success ("No screen session found" is the already-stopped case), so
# this always exits 0.
set -Eeuo pipefail

SCREEN_SESSION="${APOLLO_CKPOOL_SCREEN_SESSION:-ckpool}"
APOLLO_DIR="${APOLLO_DIR:-/opt/apolloapi}"
CKPOOL_BIN="${APOLLO_DIR}/backend/ckpool/ckpool"
PIDFILE="${APOLLO_CKPOOL_PIDFILE:-/tmp/ckpool/main.pid}"
WAIT_QUIT="${APOLLO_CKPOOL_STOP_WAIT:-20}"   # seconds after the polite request
WAIT_TERM="${APOLLO_CKPOOL_STOP_TERM_WAIT:-5}"
WAIT_KILL="${APOLLO_CKPOOL_STOP_KILL_WAIT:-3}"

# The binary path as a regex: its dots and the like must not match anything else.
bin_re="$(printf '%s' "$CKPOOL_BIN" | sed 's/[][\.*^$+?(){}|\/]/\\&/g')"

# Pids of OUR ckpool: this binary, this user. Never anybody else's process.
# Every command here may legitimately find nothing, so each is guarded: under
# `set -e -o pipefail` a no-match pgrep would abort the whole script.
ckpool_pids() {
    local pid args
    pgrep -u "$(id -u)" -f "^${bin_re}( |\$)" 2>/dev/null || true
    if [ -r "$PIDFILE" ]; then
        pid="$(tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
            case "$args" in "$CKPOOL_BIN"|"$CKPOOL_BIN "*) echo "$pid" ;; esac
        fi
    fi
}

running() { [ -n "$(ckpool_pids)" ]; }

# wait_gone <seconds>: poll until nothing runs, in 0.2 s steps.
wait_gone() {
    local ticks=$(( $1 * 5 )) i=0
    while running; do
        if [ "$i" -ge "$ticks" ]; then return 1; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 0
}

# signal_all <SIG>: signal our ckpool pids; they may be gone already.
signal_all() {
    local pid
    for pid in $(ckpool_pids | sort -u || true); do
        kill "-$1" "$pid" 2>/dev/null || true
    done
}

screen -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true

if ! wait_gone "$WAIT_QUIT"; then
    echo "ckpool still running ${WAIT_QUIT}s after quit, sending TERM"
    signal_all TERM
    if ! wait_gone "$WAIT_TERM"; then
        echo "ckpool ignored TERM, sending KILL"
        signal_all KILL
        wait_gone "$WAIT_KILL" || true
    fi
fi

# A pid file nobody owns would be met by the next start.
running || rm -f "$PIDFILE"
exit 0
