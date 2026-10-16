#!/bin/bash
# ckpool_stop.sh / ckpool_start.sh, run for real with a stand-in "ckpool" (a copy
# of sleep under a ckpool path) and a stub screen.
#
# What this guards: `screen -X quit` returns before ckpool is gone, so a restart
# started the new ckpool on top of the old one; it exited, the unit failed, and
# systemd retried 30 s later. The stop script must not return until ckpool is gone.
#
# Run: bash tests/ckpool_scripts.test.sh   (bash 3.2 and 5; the scripts use the
# APOLLO_* paths of the v2.2 launchers, and the stub screen stands in for screen)

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backend/ckpool"
tmp="$(mktemp -d)"
pids=""
cleanup() { for p in $pids; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap cleanup EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}
alive() { kill -0 "$1" 2>/dev/null && echo 1 || echo 0; }

# Stand-in "ckpool": a bash started with argv0 = $BIN (a copy of a system binary
# is killed by macOS code signing), see spawn(). A screen stub that does what `screen -X quit` does: signals
# the child (the stub's behaviour is set per test by $SCREEN_ACTION) and returns.
mkdir -p "$tmp/bin" "$tmp/run"
export APOLLO_DIR="$tmp/apollo" APOLLO_STATE_DIR="$tmp/state"
BIN="$APOLLO_DIR/backend/ckpool/ckpool"
mkdir -p "$APOLLO_DIR/backend/ckpool"
# The binary start.sh launches: its behaviour is picked per test by $CKPOOL_MODE.
cat > "$BIN" <<'STUB'
#!/bin/bash
echo "$$" > "${CKPOOL_STUB_PID:-/dev/null}"
case "${CKPOOL_MODE:-exit0}" in
    exit0) exit 0 ;;
    exit3) exit 3 ;;
    segv) kill -SEGV $$ ;;
    sleep) sleep 30 ;;
    termexit) trap 'exit 0' TERM; sleep 30 & wait ;;
    slowhup) trap 'sleep 1.5; exit 0' HUP; sleep 30 & wait ;;
esac
STUB
chmod +x "$BIN"
cat > "$tmp/bin/screen" <<'STUB'
#!/bin/bash
echo "screen $*" >> "$STUB_LOG"
# `screen -D -m -S name cmd...` as the real one (Debian 4.09) behaves: run the
# command, wait for it, and exit 0 whatever it did. SCREEN_ACTION=norun skips the
# command (the session "never started"), SCREEN_ACTION=fail1 exits 1 without it.
if [ "${1:-}" = "-D" ]; then
    case "${SCREEN_ACTION:-}" in norun) exit 0 ;; fail1) exit 1 ;; esac
    shift 4
    "$@"
    exit 0
fi
case "${SCREEN_ACTION:-none}" in
    hup) [ -n "${TARGET_PID:-}" ] && kill -TERM "$TARGET_PID" 2>/dev/null ;;
    fail) echo "No screen session found." >&2; exit 1 ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/screen"

export PATH="$tmp/bin:$PATH" STUB_LOG="$tmp/screen.log"
export APOLLO_CKPOOL_PIDFILE="$tmp/run/main.pid"
CKPOOL_PIDFILE="$APOLLO_CKPOOL_PIDFILE"
export APOLLO_CKPOOL_STOP_WAIT=3 APOLLO_CKPOOL_STOP_TERM_WAIT=2 APOLLO_CKPOOL_STOP_KILL_WAIT=2

# spawn <ignore-term:0|1>: a ckpool that lives 300 s; prints its pid.
# An optional second argument is the argv0 to use instead of $BIN.
spawn() {
    local trap_cmd="" argv0="${2:-$BIN}"
    [ "$1" = 1 ] && trap_cmd="trap '' TERM;"
    ( exec -a "$argv0" bash -c "$trap_cmd i=0; while [ \$i -lt 300 ]; do sleep 1; i=\$((i+1)); done" ) >/dev/null 2>&1 &
    pids="$pids $!"; echo $!
}
now() { date +%s; }

# 1. ckpool exits shortly after the quit request: the script waits for it.
: > "$STUB_LOG"
pid="$(spawn 0)"; echo "$pid" > "$CKPOOL_PIDFILE"
( sleep 1; kill -TERM "$pid" ) >/dev/null 2>&1 &
t0="$(now)"
SCREEN_ACTION=none bash "$DIR/ckpool_stop.sh" >/dev/null 2>&1; rc=$?
el=$(( $(now) - t0 ))
check "stop: exits 0"                         "0" "$rc"
check "stop: ckpool is gone when it returns"  "0" "$(alive "$pid")"
check "stop: it waited for the exit (>=1 s)"  "1" "$( [ "$el" -ge 1 ] && echo 1 || echo 0 )"
check "stop: asked screen to quit"            "1" "$(grep -c 'screen -S ckpool -X quit' "$STUB_LOG")"
check "stop: pid file removed once gone"      "0" "$( [ -e "$CKPOOL_PIDFILE" ] && echo 1 || echo 0 )"

# 2. ckpool never exits on its own: TERM ends it.
pid="$(spawn 0)"; echo "$pid" > "$CKPOOL_PIDFILE"
SCREEN_ACTION=none bash "$DIR/ckpool_stop.sh" >"$tmp/out" 2>&1; rc=$?
check "TERM: exits 0"                  "0" "$rc"
check "TERM: ckpool is gone"           "0" "$(alive "$pid")"
check "TERM: says it sent TERM"        "1" "$(grep -c 'sending TERM' "$tmp/out")"
check "TERM: did not need KILL"        "0" "$(grep -c 'sending KILL' "$tmp/out")"

# 3. ckpool ignores TERM too: KILL.
pid="$(spawn 1)"; echo "$pid" > "$CKPOOL_PIDFILE"
SCREEN_ACTION=none bash "$DIR/ckpool_stop.sh" >"$tmp/out" 2>&1; rc=$?
check "KILL: exits 0"                  "0" "$rc"
check "KILL: ckpool is gone"           "0" "$(alive "$pid")"
check "KILL: says it sent KILL"        "1" "$(grep -c 'sending KILL' "$tmp/out")"
check "KILL: pid file removed"         "0" "$( [ -e "$CKPOOL_PIDFILE" ] && echo 1 || echo 0 )"

# 4. Nothing running, screen says "No screen session": already stopped, not an error.
rm -f "$CKPOOL_PIDFILE"
t0="$(now)"
SCREEN_ACTION=fail bash "$DIR/ckpool_stop.sh" >/dev/null 2>&1; rc=$?
check "idle: exits 0 with no session"  "0" "$rc"
check "idle: returns at once"          "1" "$( [ $(( $(now) - t0 )) -le 1 ] && echo 1 || echo 0 )"

# 5. Stale pid file (dead pid): removed, exit 0.
echo 999999 > "$CKPOOL_PIDFILE"
SCREEN_ACTION=fail bash "$DIR/ckpool_stop.sh" >/dev/null 2>&1; rc=$?
check "stale: exits 0"                 "0" "$rc"
check "stale: pid file removed"        "0" "$( [ -e "$CKPOOL_PIDFILE" ] && echo 1 || echo 0 )"

# 6. Someone else's process: a pid file pointing at an unrelated live process,
# and a same-named sleep that is not our binary, are never touched.
( exec sleep 300 ) >/dev/null 2>&1 & other=$!; pids="$pids $other"
echo "$other" > "$CKPOOL_PIDFILE"
SCREEN_ACTION=fail bash "$DIR/ckpool_stop.sh" >/dev/null 2>&1; rc=$?
check "foreign: exits 0"               "0" "$rc"
check "foreign: unrelated process survives" "1" "$(alive "$other")"
kill -KILL "$other" 2>/dev/null

# 7. pgrep branch alone: no pid file at all, only the process list finds ckpool.
rm -f "$CKPOOL_PIDFILE"
pid="$(spawn 0)"
SCREEN_ACTION=none bash "$DIR/ckpool_stop.sh" >/dev/null 2>&1; rc=$?
check "pgrep: exits 0"                       "0" "$rc"
check "pgrep: found without a pid file, stopped" "0" "$(alive "$pid")"

# 8. Baits owned by the same user that mention the path but are not ckpool: a
# process whose command line merely CONTAINS the path (not at the start), and
# one whose path differs only where the real one has a dot (regex escaping).
bait1="$(spawn 0 "/usr/bin/other $BIN")"
dotless="$(printf '%s' "$BIN" | sed 's/\./Z/')"
bait2="$(spawn 0 "$dotless")"
real="$(spawn 0)"
SCREEN_ACTION=none bash "$DIR/ckpool_stop.sh" >/dev/null 2>&1; rc=$?
check "bait: exits 0"                          "0" "$rc"
check "bait: real ckpool stopped"              "0" "$(alive "$real")"
check "bait: path only mid-cmdline survives"   "1" "$(alive "$bait1")"
check "bait: path differing at a dot survives" "1" "$(alive "$bait2")"
kill -KILL "$bait1" "$bait2" 2>/dev/null

# --- ckpool_start.sh ---
CKPOOL_DIR="$APOLLO_DIR/backend/ckpool"
LOGS="$APOLLO_STATE_DIR/ckpool/logs"
mkdir -p "$LOGS"

# Log rotated, not deleted; one generation kept.
echo "run one" > "$LOGS/ckpool.log"
rm -f "$CKPOOL_PIDFILE"; : > "$STUB_LOG"
bash "$DIR/ckpool_start.sh" >/dev/null 2>&1; rc=$?
check "start: exits 0"                      "0" "$rc"
check "start: previous log kept as .1"      "run one" "$(cat "$LOGS/ckpool.log.1")"
check "start: old log moved away"           "0" "$( [ -e "$LOGS/ckpool.log" ] && echo 1 || echo 0 )"
check "start: launched ckpool in screen"    "1" "$(grep -c -- "^screen -D -m -S ckpool sh -c " "$STUB_LOG")"
check "start: ckpool args after the wrapper" "1" "$(grep -c -- " ckpool-wrapper $APOLLO_STATE_DIR/ckpool/exit-status $BIN -B -c $APOLLO_STATE_DIR/ckpool.conf" "$STUB_LOG")"
echo "run two" > "$LOGS/ckpool.log"
bash "$DIR/ckpool_start.sh" >/dev/null 2>&1
check "start: only one generation kept"     "run two" "$(cat "$LOGS/ckpool.log.1")"
bash "$DIR/ckpool_start.sh" >/dev/null 2>&1; rc=$?
check "start: no log at all is fine"        "0" "$rc"

# Stale pid file removed; a live one kept.
echo 999999 > "$CKPOOL_PIDFILE"
bash "$DIR/ckpool_start.sh" >/dev/null 2>&1
check "start: stale pid file removed"       "0" "$( [ -e "$CKPOOL_PIDFILE" ] && echo 1 || echo 0 )"
( exec sleep 300 ) >/dev/null 2>&1 & live=$!; pids="$pids $live"
echo "$live" > "$CKPOOL_PIDFILE"
bash "$DIR/ckpool_start.sh" >/dev/null 2>&1
check "start: pid file naming a live NON-ckpool process removed" "0" "$( [ -e "$CKPOOL_PIDFILE" ] && echo 1 || echo 0 )"
mine="$(spawn 0 "$CKPOOL_DIR/ckpool")"
echo "$mine" > "$CKPOOL_PIDFILE"
bash "$DIR/ckpool_start.sh" >/dev/null 2>&1
check "start: pid file naming our live ckpool kept" "1" "$( [ -e "$CKPOOL_PIDFILE" ] && echo 1 || echo 0 )"

# --- exit status propagation: screen -D -m exits 0 whatever ckpool did ---
start_rc() { bash "$DIR/ckpool_start.sh" >/dev/null 2>"$tmp/err"; echo $?; }
rm -f "$CKPOOL_PIDFILE"
check "status: ckpool exit 0 -> start exits 0"   "0"   "$(CKPOOL_MODE=exit0 start_rc)"
check "status: ckpool exit 3 -> start exits 3"   "3"   "$(CKPOOL_MODE=exit3 start_rc)"
check "status: ckpool SEGV -> start exits 139"   "139" "$(CKPOOL_MODE=segv start_rc)"
# A status from the previous run must not leak into this one.
echo 3 > "$APOLLO_STATE_DIR/ckpool/exit-status"
check "status: stale status file ignored"        "0"   "$(CKPOOL_MODE=exit0 start_rc)"
# The wrapper never ran / screen failed: not a clean exit.
check "status: screen ran nothing -> nonzero"    "1"   "$(SCREEN_ACTION=norun start_rc)"
check "status: screen failed with 1 -> 1"        "1"   "$(SCREEN_ACTION=fail1 start_rc)"
# Garbled status files are rejected (a stub that writes one instead of running).
for bad in "abc" "" "999" "-1" "3x" "00003000"; do
    cat > "$tmp/bin/screen" <<GARBLE
#!/bin/bash
printf '%s\n' '$bad' > "$APOLLO_STATE_DIR/ckpool/exit-status"
exit 0
GARBLE
    check "status: garbled [$bad] -> nonzero"  "1" "$(start_rc)"
done

# A requested stop: screen -X quit HUPs the window. The wrapper forwards the HUP,
# ckpool ends, and the real status is still recorded (129, which the unit lists
# in SuccessExitStatus). Real stub again.
cat > "$tmp/bin/screen" <<'STUB'
#!/bin/bash
echo "screen $*" >> "$STUB_LOG"
shift 4
"$@"
exit 0
STUB
for sig in HUP TERM; do
    rm -f "$tmp/ck.pid"
    CKPOOL_MODE=sleep CKPOOL_STUB_PID="$tmp/ck.pid" bash "$DIR/ckpool_start.sh" >/dev/null 2>&1 &
    startpid=$!; pids="$pids $startpid"
    for _ in $(seq 1 50); do [ -s "$tmp/ck.pid" ] && break; sleep 0.1; done
    ckpid="$(cat "$tmp/ck.pid" 2>/dev/null)"
    # the wrapper is ckpool's parent
    wrap="$(ps -o ppid= -p "$ckpid" | tr -d ' ')"
    kill -"$sig" "$wrap"
    wait "$startpid"; rc=$?
    exp=$(( 128 + $(kill -l "$sig") ))
    check "stop via $sig: start exits $exp"     "$exp" "$rc"
    check "stop via $sig: ckpool is gone"       "0" "$(alive "$ckpid")"
done

# The real race (Debian screen 4.09): `screen -X quit` makes screen exit 0 at
# once while the wrapper is still forwarding the HUP and waiting for ckpool, so
# the status file appears AFTER screen has returned. The stub models it: it runs
# the wrapper in the background, waits for the quit flag, HUPs the wrapper and
# exits straight away. ckpool takes 1.5 s to finish after the HUP.
cat > "$tmp/bin/screen" <<'STUB'
#!/bin/bash
echo "screen $*" >> "$STUB_LOG"
shift 4
"$@" &
w=$!
while [ ! -e "$QUIT_FLAG" ]; do sleep 0.05; done
kill -HUP "$w" 2>/dev/null
exit 0
STUB
export QUIT_FLAG="$tmp/quit.flag"
race_run() {
    rm -f "$tmp/ck.pid" "$QUIT_FLAG"
    CKPOOL_MODE=slowhup CKPOOL_STUB_PID="$tmp/ck.pid" bash "$DIR/ckpool_start.sh" >/dev/null 2>"$tmp/err" &
    startpid=$!; pids="$pids $startpid"
    for _ in $(seq 1 50); do [ -s "$tmp/ck.pid" ] && break; sleep 0.1; done
    sleep 0.3; : > "$QUIT_FLAG"
    wait "$startpid"; echo $?
}
check "race: screen quits before the status is written -> still start exits 0" "0" "$(race_run)"
check "race: the status was waited for, not reported missing" "0" "$(grep -c 'no usable exit status' "$tmp/err")"
# A bounded wait: a wrapper that never writes (killed outright) fails, and the
# wait ends within the configured bound.
cat > "$tmp/bin/screen" <<'STUB'
#!/bin/bash
shift 4
( exec -a "ckpool-wrapper $APOLLO_STATE_DIR/ckpool/exit-status" sleep 30 ) &
exit 0
STUB
t0="$(now)"
rc="$(APOLLO_CKPOOL_STATUS_WAIT=2 start_rc)"
el=$(( $(now) - t0 ))
check "race: wrapper alive but silent -> failure after the bound" "1" "$rc"
check "race: the wait is bounded (2-4 s)" "1" "$( [ "$el" -ge 2 ] && [ "$el" -le 4 ] && echo 1 || echo 0 )"
pkill_pids="$(pgrep -f "^ckpool-wrapper $APOLLO_STATE_DIR" || true)"
for p in $pkill_pids; do kill -KILL "$p" 2>/dev/null; done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
