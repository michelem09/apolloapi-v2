#!/bin/bash
# backend/update_system bridges a 2.1.x device to 2.2 while the OLD apollo-api is
# still running. That API's service monitor records "node stopped" as
# requested_status='offline', and the bootstrap moves its database. So the API
# must go down with node/ckpool, come back if the update fails, and the state dir
# must be futurebit-owned before the bootstrap runs.
#
# The script is run for real with every system command stubbed. In the first
# sections yarn is a stub that fails (right after the services are stopped), which
# exercises the ERR path for free.
#
# Run: bash tests/update_system.test.sh

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/backend/update_system"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

bin="$tmp/bin"; mkdir -p "$bin"
for c in systemctl install pgrep sqlite3 chown systemd-run; do
    cat > "$bin/$c" <<EOS
#!/bin/sh
echo "$c \$*" >> "$tmp/calls.log"
exit 0
EOS
done
chmod +x "$bin"/*

# A fake checkout whose runtime installer is a stub: the real one downloads Node
# (tests/node_runtime.test.sh covers it). The stub records the call and leaves a
# runtime/node/bin/node behind, as the real one does.
app="$tmp/app"
mkdir -p "$app/node_modules" "$app/apolloui-v2/node_modules" "$app/backend/systemd" \
    "$app/backend/apollo-miner" "$app/backend/ckpool" "$app/backend/node" "$app/backend/utils"
cat > "$app/backend/utils/install-node-runtime.sh" <<EOS
#!/bin/bash
echo "install-node-runtime \$*" >> "$tmp/calls.log"
[ -n "\${FAKE_RUNTIME_FAILS:-}" ] && exit 1
mkdir -p "$app/backend/runtime/node/bin"
exit 0
EOS
# yarn fails, so the run stops right after the services went down (section 4
# replaces this stub with one that works).
printf '#!/bin/sh\necho "yarn $*" >> "%s/calls.log"\nexit 1\n' "$tmp" > "$bin/yarn"; chmod +x "$bin/yarn"
mkdir -p "$tmp/state"

# --- 1. the update dies after the stops: API is stopped, then restarted ----------
: > "$tmp/calls.log"
PATH="$bin:$PATH" APOLLO_UPDATE_DIR="$app" APOLLO_STATE_DIR="$tmp/state" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" \
    bash "$SCRIPT" >/dev/null 2>&1
calls="$(cat "$tmp/calls.log")"
stop_api=$(grep -n 'systemctl stop apollo-api.service' <<<"$calls" | head -1 | cut -d: -f1)
stop_node=$(grep -n 'systemctl stop node.service' <<<"$calls" | head -1 | cut -d: -f1)
start_api=$(grep -n 'systemctl start apollo-api.service' <<<"$calls" | tail -1 | cut -d: -f1)
check "apollo-api is stopped"                          "1" "$( [ -n "$stop_api" ] && echo 1 || echo 0 )"
check "…before node is stopped"                        "1" "$( [ -n "$stop_api" ] && [ -n "$stop_node" ] && [ "$stop_api" -lt "$stop_node" ] && echo 1 || echo 0 )"
check "a failed update starts apollo-api again"        "1" "$( [ -n "$start_api" ] && [ -n "$stop_api" ] && [ "$start_api" -gt "$stop_api" ] && echo 1 || echo 0 )"

# --- 1b. early failure: state dir owned first, node comes back --------------------
first_install=$(grep -n '^install -d -o futurebit -g futurebit -m 700 '"$tmp/state" <<<"$calls" | head -1 | cut -d: -f1)
first_chown=$(grep -n '^chown -R futurebit:futurebit '"$tmp/state" <<<"$calls" | head -1 | cut -d: -f1)
first_stop=$(grep -n '^systemctl ' <<<"$calls" | head -1 | cut -d: -f1)
start_node=$(grep -n 'systemctl start node.service' <<<"$calls" | tail -1 | cut -d: -f1)
check "state dir is created futurebit-owned 0700 first" "1" "$( [ -n "$first_install" ] && [ -n "$first_stop" ] && [ "$first_install" -lt "$first_stop" ] && echo 1 || echo 0 )"
check "…and chowned recursively before any service call" "1" "$( [ -n "$first_chown" ] && [ "$first_chown" -lt "$first_stop" ] && echo 1 || echo 0 )"
check "a failed update starts node again"              "1" "$( [ -n "$start_node" ] && [ "$start_node" -gt "$stop_node" ] && echo 1 || echo 0 )"
check "ckpool is not started by the error path"        "0" "$(grep -c 'systemctl start ckpool' <<<"$calls")"

# --- 1c. yarn cache goes to the NVMe only when it is mounted and writable ---------
eval "$(sed -n '/^select_yarn_cache()/,/^}/p' "$SCRIPT")"
unset YARN_CACHE_FOLDER
APOLLO_YARN_CACHE_BASE="$tmp/no-such-mount" select_yarn_cache
check "no NVMe mount: yarn default cache"        "" "${YARN_CACHE_FOLDER:-}"
mkdir -p "$tmp/nvme"
APOLLO_YARN_CACHE_BASE="$tmp/nvme" select_yarn_cache
check "writable NVMe mount: cache on the NVMe"   "$tmp/nvme/.yarn-cache" "${YARN_CACHE_FOLDER:-}"
check "…and the folder exists"                    "1" "$( [ -d "$tmp/nvme/.yarn-cache" ] && echo 1 || echo 0 )"
if [ "$(id -u)" -ne 0 ]; then
    unset YARN_CACHE_FOLDER; mkdir -p "$tmp/ro"; chmod 555 "$tmp/ro"
    APOLLO_YARN_CACHE_BASE="$tmp/ro" select_yarn_cache
    check "read-only NVMe mount: yarn default cache" "" "${YARN_CACHE_FOLDER:-}"
    chmod 755 "$tmp/ro"
fi
unset YARN_CACHE_FOLDER

# --- 2. order of the bootstrap steps (static: the stubs cannot reach them) -------
line() { grep -n -- "$1" "$SCRIPT" | head -1 | cut -d: -f1; }
l_stop=$(line '^stop_runtime_services$')
l_chown=$(grep -n 'chown -R futurebit:futurebit "\$STATE_DIR"' "$SCRIPT" | tail -1 | cut -d: -f1)
l_boot=$(line 'src/bootstrap.js')
check "state dir is chowned before the bootstrap runs" "1" "$( [ -n "$l_chown" ] && [ "$l_chown" -lt "$l_boot" ] && echo 1 || echo 0 )"
check "services are stopped before the bootstrap runs" "1" "$( [ -n "$l_stop" ] && [ "$l_stop" -lt "$l_boot" ] && echo 1 || echo 0 )"

# --- 3. detach: re-exec through systemd-run so stopping apollo-api cannot kill us -
mkdir -p "$tmp/fake-systemd"
: > "$tmp/calls.log"
out="$(PATH="$bin:$PATH" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" APOLLO_SYSTEMD_DIR="$tmp/fake-systemd" APOLLO_STATE_DIR="$tmp/state" \
    bash "$SCRIPT" 2>&1)"
check "it tells the operator how to follow the run" "1" "$(grep -c 'journalctl -fu apollo-update-system' <<<"$out")"
check "outside its own unit it re-runs under systemd-run" "1" "$(grep -c '^systemd-run .*--wait' "$tmp/calls.log")"
check "…and does not stop anything itself first"        "0" "$(grep -c '^systemctl stop' "$tmp/calls.log")"
: > "$tmp/calls.log"
PATH="$bin:$PATH" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" APOLLO_SYSTEMD_DIR="$tmp/fake-systemd" APOLLO_UPDATE_SYSTEM_DETACHED=1 APOLLO_STATE_DIR="$tmp/state" \
    bash "$SCRIPT" >/dev/null 2>&1
check "inside its unit it does not re-exec"              "0" "$(grep -c '^systemd-run' "$tmp/calls.log")"

# --- 4. build artefacts go back to futurebit; binaries keep their owner ---------
# Run past the yarn steps against the fake checkout. yarn is a stub that creates the
# root-owned directories a real run would, and can be made to fail on "build".
for c in yarn sudo sleep; do
    cat > "$bin/$c" <<EOS
#!/bin/sh
echo "$c \$*" >> "$tmp/calls.log"
if [ "$c" = yarn ]; then
    case "\$*" in
        build) mkdir -p "\$PWD/.next"; [ -n "\${FAKE_BUILD_FAILS:-}" ] && exit 1 ;;
    esac
fi
exit 0
EOS
done
# Services report as stopped, or stop_runtime_services gives up before the build.
printf '#!/bin/sh\necho "systemctl $*" >> "%s/calls.log"\ncase "$1" in is-active) exit 3;; esac\nexit 0\n' "$tmp" > "$bin/systemctl"
printf '#!/bin/sh\nexit 1\n' > "$bin/pgrep"
chmod +x "$bin"/*
run_update() {
    : > "$tmp/calls.log"
    PATH="$bin:$PATH" APOLLO_UPDATE_DIR="$app" \
        APOLLO_YARN_CACHE_BASE="$tmp/nvme" APOLLO_UPDATE_SYSTEM_DETACHED=1 \
        APOLLO_STATE_DIR="$tmp/state" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" \
        APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" \
        bash "$SCRIPT" >/dev/null 2>&1
}
for f in "$app/yarn-error.log" "$app/apolloui-v2/yarn-error.log"; do : > "$f"; done
expected_owned="$(printf '%s\n' "$app/yarn-error.log" "$app/apolloui-v2/yarn-error.log" "$app/apolloui-v2/.next" "$app/apolloui-v2/node_modules" "$app/node_modules" "$tmp/nvme/.yarn-cache" "$app/backend/runtime" | sort)"
owned_paths() { grep '^chown -R futurebit:futurebit ' "$tmp/calls.log" | grep -v " $tmp/state\$" | sed 's/^chown -R futurebit:futurebit //' | sort; }

run_update
check "success: the update runs to the reboot"            "1" "$(grep -c '^systemctl reboot' "$tmp/calls.log")"
check "success: exactly the build artefacts are chowned"  "$expected_owned" "$(owned_paths)"
chown_line=$(grep -n "^chown -R futurebit:futurebit $app/apolloui-v2/.next" "$tmp/calls.log" | head -1 | cut -d: -f1)
build_line=$(grep -n '^yarn build' "$tmp/calls.log" | head -1 | cut -d: -f1)
check "success: on_error never ran (no service started)"  "0" "$(grep -c '^systemctl start' "$tmp/calls.log")"
check "success: the progress file survived until the end" "1" "$(grep -c '^sleep 8' "$tmp/calls.log")"
check "success: …after the build"                         "1" "$( [ -n "$chown_line" ] && [ -n "$build_line" ] && [ "$chown_line" -gt "$build_line" ] && echo 1 || echo 0 )"
check "success: binaries dirs are not chowned"            "0" "$(grep '^chown ' "$tmp/calls.log" | grep -v "$app/backend/runtime\$" | grep -c -E 'backend|apollo-miner|ckpool|bitcoind')"
check "success: the checkout itself is not chowned"       "0" "$(grep -c -E "^chown .* $app/?$" "$tmp/calls.log")"

FAKE_BUILD_FAILS=1 run_update
check "build fails: the update does not reboot"           "0" "$(grep -c '^systemctl reboot' "$tmp/calls.log")"
check "build fails: the half-built artefacts are chowned" "$expected_owned" "$(owned_paths)"
check "build fails: binaries dirs are not chowned"        "0" "$(grep '^chown ' "$tmp/calls.log" | grep -v "$app/backend/runtime\$" | grep -c -E 'backend|apollo-miner|ckpool|bitcoind')"
bl=$(grep -n '^yarn build' "$tmp/calls.log" | head -1 | cut -d: -f1)
sl=$(grep -n 'systemctl start apollo-api.service' "$tmp/calls.log" | tail -1 | cut -d: -f1)
check "build fails: apollo-api is started exactly once"   "1" "$(grep -c 'systemctl start apollo-api.service' "$tmp/calls.log")"
check "build fails: the recovery ran once (node)"         "1" "$(grep -c 'systemctl start node.service' "$tmp/calls.log")"
check "build fails: apollo-api is started again after it" "1" "$( [ -n "$bl" ] && [ -n "$sl" ] && [ "$sl" -gt "$bl" ] && echo 1 || echo 0 )"

# --- 5. on_error is a no-op in a subshell ------------------------------------
# Under bash 3.2 a set -E subshell inherits the ERR trap, and bash 5 can leave it
# unreached, so a real run does not exercise the guard reliably: call on_error
# itself, in a subshell and in the main shell.
eval "$(sed -n '/^on_error()/,/^}/p' "$SCRIPT")"
restore_solo_intent() { :; }; own_build_artefacts() { :; }
API_STOPPED=1; NODE_STOPPED=1
TMPFILE="$tmp/progress-sub"; : > "$TMPFILE"
: > "$tmp/calls.log"
( PATH="$bin:$PATH"; false || on_error ) >/dev/null 2>&1
check "on_error in a subshell starts nothing"            "0" "$(grep -c '^systemctl start' "$tmp/calls.log")"
check "…and leaves the progress file alone"              "1" "$( [ -e "$TMPFILE" ] && echo 1 || echo 0 )"
PATH="$bin:$PATH" TMPFILE="$tmp/progress-main" bash -c "$(sed -n '/^on_error()/,/^}/p' "$SCRIPT")
restore_solo_intent() { :; }; own_build_artefacts() { :; }
API_STOPPED=1; NODE_STOPPED=0
false; on_error" >/dev/null 2>&1
check "on_error in the main shell of a run starts the API" "1" "$(grep -c '^systemctl start apollo-api.service' "$tmp/calls.log")"
check "…and not the node it did not stop"                  "0" "$(grep -c '^systemctl start node.service' "$tmp/calls.log")"
: > "$tmp/calls.log"
PATH="$bin:$PATH" TMPFILE="$tmp/progress-none" bash -c "$(sed -n '/^on_error()/,/^}/p' "$SCRIPT")
restore_solo_intent() { :; }; own_build_artefacts() { :; }
API_STOPPED=0; NODE_STOPPED=0
false; on_error" >/dev/null 2>&1
check "on_error before anything was stopped starts nothing" "0" "$(grep -c '^systemctl start' "$tmp/calls.log")"

# --- 6. the Node runtime: installed first, used by the bootstrap, no nvm ------------
run_update
first_unit=$(grep -n '^install -m 644 '"$app"'/backend/systemd/' "$tmp/calls.log" | head -1 | cut -d: -f1)
first_stop2=$(grep -n '^systemctl stop' "$tmp/calls.log" | head -1 | cut -d: -f1)
rt=$(grep -n '^install-node-runtime' "$tmp/calls.log" | head -1 | cut -d: -f1)
check "the runtime installer runs once"                    "1" "$(grep -c '^install-node-runtime' "$tmp/calls.log")"
check "…before any unit is installed"                      "1" "$( [ -n "$rt" ] && [ -n "$first_unit" ] && [ "$rt" -lt "$first_unit" ] && echo 1 || echo 0 )"
check "…and before any service is stopped"                 "1" "$( [ -n "$rt" ] && [ -n "$first_stop2" ] && [ "$rt" -lt "$first_stop2" ] && echo 1 || echo 0 )"
check "the bootstrap runs on the runtime's node"           "1" "$(grep -c "^sudo -u futurebit env .* $app/backend/runtime/node/bin/node $app/src/bootstrap.js" "$tmp/calls.log")"

FAKE_RUNTIME_FAILS=1 run_update
check "runtime install fails: nothing is stopped"          "0" "$(grep -c '^systemctl stop' "$tmp/calls.log")"
check "…and nothing is started (a stopped node stays so)"  "0" "$(grep -c '^systemctl start' "$tmp/calls.log")"
check "…no unit is replaced"                               "0" "$(grep -c '^install -m 644' "$tmp/calls.log")"
check "…yarn never runs"                                   "0" "$(grep -c '^yarn' "$tmp/calls.log")"
check "…and the device is not rebooted"                    "0" "$(grep -c '^systemctl reboot' "$tmp/calls.log")"

# The script must not depend on nvm any more, or a device imaged without it would
# die at the first yarn.
check "no code path sources nvm or names a v21 node"       "0" "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c -E 'nvm\.sh|nvm use|node/v21|--ignore-engines')"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
