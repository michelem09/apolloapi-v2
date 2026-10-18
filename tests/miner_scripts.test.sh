#!/bin/bash
# miner_stop.sh / miner_start.sh, run for real with stubbed gpio, apollo-helper,
# screen and sleep.
#
# What this guards: a stop that lands while miner_start.sh is still running (the
# unit stays "activating" ~35s) or after a crash never ran ExecStop, so the
# hashboard reset and the Apollo 3 SIGTERM shutdown were skipped. The unit now also
# runs `miner_stop.sh --if-owed` as ExecStopPost. Between the two calls every stop
# must do the full shutdown exactly once.
#
# Run: bash tests/miner_scripts.test.sh   (bash 3.2 and 5)

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$DIR/backend/apollo-miner"
tmp="$(mktemp -d)"
pids=""
cleanup() { for p in $pids; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap cleanup EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

mkdir -p "$tmp/bin" "$tmp/miner" "$tmp/run"
LOG="$tmp/calls.log"
for cmd in gpio screen; do
    printf '#!/bin/bash\necho "%s $*" >> "$STUB_LOG"\n' "$cmd" > "$tmp/bin/$cmd"
done
# GPIO_DIE=1: the shutdown script is killed in the middle of its gpio reset.
printf '#!/bin/bash\necho "gpio $*" >> "$STUB_LOG"\n[ -n "${GPIO_DIE:-}" ] && kill -KILL "$PPID"\nexit 0\n' > "$tmp/bin/gpio"
# No session to find, nothing to wait for: `screen -ls` prints nothing.
printf '#!/bin/bash\necho "apollo-helper $*" >> "$STUB_LOG"\ncase "$1" in -s) echo Apollo-2;; esac\n' > "$tmp/miner/apollo-helper"
# The start script waits 35 s for USB boards; the wait is not what is under test.
printf '#!/bin/bash\nexit 0\n' > "$tmp/bin/sleep"
# v2.2's start script creates its state/runtime dirs with `install -d -o futurebit`
# (needs root and the user): a stub that only makes the directories.
printf '#!/bin/bash\nfor a in "$@"; do case "$a" in -*|futurebit|700) ;; *) mkdir -p "$a" ;; esac; done\n' > "$tmp/bin/install"
chmod +x "$tmp/bin/"* "$tmp/miner/apollo-helper"
cp "$SCRIPTS/miner_start.sh" "$SCRIPTS/miner_stop.sh" "$tmp/miner/"

export PATH="$tmp/bin:$PATH" STUB_LOG="$LOG"
export APOLLO_MINER_DIR="$tmp/miner" APOLLO_BIN_DIR="$tmp/miner" APOLLO_STATE_DIR="$tmp/state" MINER_STOPPED_MARKER="$tmp/run/stopped"
export ARMBIAN_RELEASE_FILE="$tmp/armbian-release"
: > "$ARMBIAN_RELEASE_FILE"

resets() { grep -c '^gpio write 0 0' "$LOG"; }
stop()   { ( bash "$tmp/miner/miner_stop.sh" "$@" >/dev/null 2>&1 ); }
start()  { bash "$tmp/miner/miner_start.sh" >/dev/null 2>&1; }
fresh()  { : > "$LOG"; rm -f "$MINER_STOPPED_MARKER"; }

# 1. A plain stop (ExecStop) does the shutdown and leaves the marker.
fresh; stop
check "stop resets the hashboard" 1 "$(resets)"
check "stop leaves the marker" 1 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"

# 2. ExecStopPost after an ExecStop that ran: nothing more happens.
stop --if-owed
check "--if-owed after a stop is a no-op" 1 "$(resets)"

# 3. ExecStopPost with no ExecStop before it (stop while starting, or a crash): full shutdown.
fresh; start; : > "$LOG"
stop --if-owed
check "--if-owed after a start does the shutdown" 1 "$(resets)"
check "...and leaves the marker" 1 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"
stop --if-owed
check "...once" 1 "$(resets)"

# 4. A start makes the next stop owed again, even if the previous one left the marker.
stop; start; : > "$LOG"
check "start clears the marker" 0 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"
stop --if-owed
check "--if-owed after the next start runs" 1 "$(resets)"

# 4b. A shutdown that died half-way is still owed: the marker is written last.
fresh; start; : > "$LOG"
GPIO_DIE=1 stop
check "a stop killed half-way leaves no marker" 0 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"
stop --if-owed
check "...so --if-owed does it again" 2 "$(resets)"

# Past the start script: the real sleep is back (step 6 needs the waiting to be real).
rm -f "$tmp/bin/sleep"

# 5. An explicit stop is never skipped by a stale marker (ExecStop always shuts down).
touch "$MINER_STOPPED_MARKER"; : > "$LOG"
stop
check "plain stop ignores the marker" 1 "$(resets)"

# 6. Apollo 3: the shutdown is SIGTERM to the miner, found by the pattern built
# from the miner dir (the miner is started here by absolute path, which only the
# MINER_DIR branch of the pattern matches), and the script waits for it.
echo 'BOARD_NAME="Apollo 3"' > "$ARMBIAN_RELEASE_FILE"
M3_LOG="$tmp/m3.log"
( cd "$tmp/miner"; exec -a "$tmp/miner/futurebit-miner-v3" bash -c "trap 'echo TERM >> $M3_LOG; sleep 1; echo done >> $M3_LOG; exit 0' TERM; i=0; while [ \$i -lt 100 ]; do sleep 0.2; i=\$((i+1)); done" ) >/dev/null 2>&1 &
pids="$pids $!"
sleep 0.5
fresh; stop
check "Apollo 3 miner got SIGTERM" "TERM" "$(head -1 "$M3_LOG" 2>/dev/null)"
check "Apollo 3 stop waited for the miner to finish" "done" "$(tail -1 "$M3_LOG" 2>/dev/null)"
check "Apollo 3 stop does not reset the gpio" 0 "$(resets)"

# 7. The unit and the script agree on the flag, and the unit shuts the cgroup down
# in the order the Apollo 3 shutdown needs.
UNIT="$DIR/backend/systemd/apollo-miner.service"
check "unit runs miner_stop.sh --if-owed as ExecStopPost" 1 \
    "$(grep -Ec '^ExecStopPost=-?/opt/apolloapi/backend/apollo-miner/miner_stop\.sh --if-owed$' "$UNIT")"
check "unit uses KillMode=mixed" 1 "$(grep -c '^KillMode=mixed$' "$UNIT")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
