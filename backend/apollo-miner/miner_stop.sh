#!/bin/bash

cd "${APOLLO_MINER_DIR:-/opt/apolloapi/backend/apollo-miner}" || exit 1

ARMBIAN_RELEASE="/etc/armbian-release"
if [[ -r "$ARMBIAN_RELEASE" ]]; then
    . "$ARMBIAN_RELEASE"
fi

reset_hashboards()
{
    while [[ -n "${1:-}" ]]; do
        ./apollo-helper -s "$1" -r
        sleep .5
        shift
    done
}

reset_external_hashboards()
{
    local ports=(/dev/ttyACM*)
    if [[ -e ${ports[0]} ]]; then
        reset_hashboards "${ports[@]}"
    fi
}

stop_apollo3_miner()
{
    # miner_start.sh runs the binary from a copy in the runtime dir
    # (/var/lib/apollo/miner), so match any path, not just the checkout.
    # Anchored on argv[0]: the SCREEN process carries the path as an argument
    # and must not match, nor futurebit-miner-v3.bak.
    local pattern='^([^[:space:]]*/)?futurebit-miner-v3([[:space:]]|$)'
    local timeout=60
    local waited=0

    if ! pgrep -f "$pattern" >/dev/null 2>&1; then
        return 0
    fi

    echo "Stopping Apollo 3 miner with SIGTERM"
    pkill -TERM -f "$pattern" 2>/dev/null || true

    while pgrep -f "$pattern" >/dev/null 2>&1; do
        if (( waited >= timeout )); then
            echo "Apollo 3 miner did not stop after ${timeout}s; closing its screen session" >&2
            return 1
        fi

        sleep 1
        waited=$((waited + 1))
    done

    echo "Apollo 3 miner stopped cleanly"
}

# The Apollo 3 miner handles SIGTERM/SIGINT, but screen quit sends SIGHUP.
# Let it finish its hardware shutdown before closing any screen sessions.
if [[ "${BOARD_NAME:-}" == "Apollo 3" ]]; then
    stop_apollo3_miner || true
fi

# Quit all mining processes.
screen -ls | grep '\.miner' | awk -F '\t|[.]' '{print $2}' | while read -r session
do
    echo "Killing session: $session"
    screen -S "$session" -X quit
done

case "${BOARD_NAME:-}" in
    "Apollo 3"|"Solo Node")
        ;;
    *)
        # Reset the internal hashboard.
        gpio write 0 0
        sleep .5
        gpio write 0 1
        ;;
esac

# Find and reset external hashboards.
reset_external_hashboards

echo "Stopped"
