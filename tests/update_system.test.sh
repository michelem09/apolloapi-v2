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

# --- 2. order of the bootstrap steps (static: the stubs cannot reach them) -------
line() { grep -n -- "$1" "$SCRIPT" | head -1 | cut -d: -f1; }
l_stop=$(line '^stop_runtime_services$')
l_chown=$(line 'chown -R futurebit:futurebit "\$STATE_DIR"')
l_boot=$(line 'src/bootstrap.js')
check "state dir is chowned before the bootstrap runs" "1" "$( [ -n "$l_chown" ] && [ "$l_chown" -lt "$l_boot" ] && echo 1 || echo 0 )"
check "services are stopped before the bootstrap runs" "1" "$( [ -n "$l_stop" ] && [ "$l_stop" -lt "$l_boot" ] && echo 1 || echo 0 )"

# --- 3. detach: re-exec through systemd-run so stopping apollo-api cannot kill us -
mkdir -p "$tmp/fake-systemd"
: > "$tmp/calls.log"
PATH="$bin:$PATH" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" APOLLO_SYSTEMD_DIR="$tmp/fake-systemd" APOLLO_STATE_DIR="$tmp/state" \
    bash "$SCRIPT" >/dev/null 2>&1
check "outside its own unit it re-runs under systemd-run" "1" "$(grep -c '^systemd-run .*--wait' "$tmp/calls.log")"
check "…and does not stop anything itself first"        "0" "$(grep -c '^systemctl stop' "$tmp/calls.log")"
: > "$tmp/calls.log"
PATH="$bin:$PATH" APOLLO_SOLO_REQUEST_FILE="$tmp/solo" APOLLO_UPDATE_PROGRESS_FILE="$tmp/progress" APOLLO_SYSTEMD_DIR="$tmp/fake-systemd" APOLLO_UPDATE_SYSTEM_DETACHED=1 APOLLO_STATE_DIR="$tmp/state" \
    bash "$SCRIPT" >/dev/null 2>&1
check "inside its unit it does not re-exec"              "0" "$(grep -c '^systemd-run' "$tmp/calls.log")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
