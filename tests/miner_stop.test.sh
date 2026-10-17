#!/bin/bash
# miner_stop.sh must SIGTERM the Apollo 3 miner wherever it was launched from:
# the checkout (./ or absolute) or the runtime-dir copy made by miner_start.sh.
# Otherwise the miner dies on SIGHUP from `screen -X quit` and skips its
# hardware shutdown (fan stays on).
#
# The script is run for real; the "miner" is a copy of `sleep` named
# futurebit-miner-v3 (a real binary, so argv[0] is the launch path), and its
# exit status tells whether it died of SIGTERM (143).
#
# Run: bash tests/miner_stop.test.sh

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
pids=()
cleanup() { for p in "${pids[@]:-}"; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap cleanup EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

stubs="$tmp/stubs"; mkdir -p "$stubs"
for stub in sleep gpio screen; do printf '#!/bin/sh\nexit 0\n' > "$stubs/$stub"; done
# the test's own sleep must be the real one, and not be called "sleep" in PATH
REALSLEEP="$(command -v sleep)"
cp "$REALSLEEP" "$tmp/realsleep"
# macOS kills a copied system binary unless it is re-signed (no-op on Linux)
command -v codesign >/dev/null 2>&1 && codesign -f -s - "$tmp/realsleep" >/dev/null 2>&1
chmod +x "$stubs"/*

mdir="$tmp/checkout/miner"; rdir="$tmp/runtime/miner"; mkdir -p "$mdir" "$rdir"
cp "$tmp/realsleep" "$mdir/futurebit-miner-v3"
cp "$tmp/realsleep" "$rdir/futurebit-miner-v3"
cp "$tmp/realsleep" "$mdir/futurebit-miner-v3.bak"

run_stop() {
    PATH="$stubs:$PATH" BOARD_NAME="Apollo 3" APOLLO_MINER_DIR="$mdir" \
        bash "$REPO/backend/apollo-miner/miner_stop.sh" >"$tmp/out.log" 2>&1
}
# start "$@" in the background, print its pid
launch() { ( "$@" ) & local p=$!; pids+=("$p"); LAUNCHED=$p; sleep_a_bit; }
sleep_a_bit() { "$tmp/realsleep" 0.5; }
status_of() { wait "$1" 2>/dev/null; echo $?; }
alive() { kill -0 "$1" 2>/dev/null && echo alive || echo dead; }

# 1. launched as ./futurebit-miner-v3 from the miner dir
( cd "$mdir" && exec ./futurebit-miner-v3 60 ) & p1=$!; pids+=("$p1"); sleep_a_bit
run_stop
check "./futurebit-miner-v3 gets SIGTERM"        "143" "$(status_of $p1)"

# 2. launched from the runtime-dir copy (absolute path), as miner_start.sh does
( cd "$rdir" && exec "$rdir/futurebit-miner-v3" 60 ) & p2=$!; pids+=("$p2"); sleep_a_bit
run_stop
check "runtime-dir copy gets SIGTERM"            "143" "$(status_of $p2)"
check "stop logged the SIGTERM path"             "1" "$(grep -c 'Stopping Apollo 3 miner with SIGTERM' "$tmp/out.log")"

# 3. absolute checkout path
( exec "$mdir/futurebit-miner-v3" 60 ) & p3=$!; pids+=("$p3"); sleep_a_bit
run_stop
check "absolute checkout path gets SIGTERM"      "143" "$(status_of $p3)"

# 4. decoys: the SCREEN process (path only as an argument), a .bak binary,
#    and an unrelated process that merely mentions the name
( exec -a "SCREEN -dmS miner $rdir/futurebit-miner-v3 -x" "$tmp/realsleep" 60 ) & d1=$!; pids+=("$d1")
( exec "$mdir/futurebit-miner-v3.bak" 60 ) & d2=$!; pids+=("$d2")
( exec -a "tail -f $rdir/futurebit-miner-v3" "$tmp/realsleep" 60 ) & d3=$!; pids+=("$d3")
sleep_a_bit
run_stop
check "SCREEN line with the path as argument untouched" "alive" "$(alive $d1)"
check "futurebit-miner-v3.bak untouched"          "alive" "$(alive $d2)"
check "unrelated command mentioning it untouched" "alive" "$(alive $d3)"
check "no match: no SIGTERM message"              "0" "$(grep -c 'Stopping Apollo 3 miner' "$tmp/out.log")"
check "script still completes"                    "1" "$(grep -c '^Stopped$' "$tmp/out.log")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
