#!/bin/bash
# backend/update_system bridges a 2.1.x device to 2.2 while the OLD apollo-api is
# still running. That API's service monitor records "node stopped" as
# requested_status='offline', and the bootstrap moves its database. So the API
# must go down with node/ckpool, come back if the update fails, and the state dir
# must be futurebit-owned before the bootstrap runs.
#
# The script is run for real with every system command stubbed. It dies on its
# own at the missing nvm (right after the services are stopped), which exercises
# the ERR path for free.
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

# --- 1. the update dies after the stops: API is stopped, then restarted ----------
: > "$tmp/calls.log"
PATH="$bin:$PATH" APOLLO_STATE_DIR="$tmp/state" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" \
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

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
