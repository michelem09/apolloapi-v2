#!/bin/bash

# Paths are overridable so tests/miner_scripts.test.sh can run the script for real.
cd "${APOLLO_MINER_DIR:-/opt/apolloapi/backend/apollo-miner}" || exit 1

ARMBIAN_RELEASE="${ARMBIAN_RELEASE_FILE:-/etc/armbian-release}"
if [[ -r "$ARMBIAN_RELEASE" ]]; then
    . "$ARMBIAN_RELEASE"
fi

# A start means a full shutdown is owed again: miner_stop.sh --if-owed (the unit's
# ExecStopPost) skips itself when the marker says one already ran since this start.
rm -f "${MINER_STOPPED_MARKER:-/run/apollo-miner.stopped}"

settings=""
settings3=""
[[ -r miner_config3 ]] && settings3=$(<miner_config3)

# The legacy binaries start only after the 35 s wait below, and a settings save
# (new pool, new payout address) can rewrite miner_config during it. Read it
# after the wait, right before the boards start, never at the top.
load_settings()
{
    settings=""
    [[ -r miner_config ]] && settings=$(<miner_config)
}

start_hashboards()
{
    while [[ -n "${1:-}" ]]; do
        local port="$1"
        local boardType
        boardType=$(./apollo-helper -s "$port")

        if [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* ]]; then
            screen -dmS miner ./futurebit-miner -comport "$port" -ao_mode 1 $settings
        elif [[ "$boardType" == *"Apollo-2"* ]]; then
            screen -dmS miner ./futurebit-miner-v2 -comport "$port" -ao_mode 1 $settings
        else
            echo "unknown USB board"
        fi

        sleep 1
        shift
    done
}

start_external_hashboards()
{
    # Glob overridable so the test can fake a plugged-in USB board.
    local ports=(${APOLLO_USB_PORTS:-/dev/ttyACM*})
    if [[ -e ${ports[0]} ]]; then
        start_hashboards "${ports[@]}"
    fi
}

# Clear old Apollo I/II stat files without deleting Apollo III stats.
rm -f apollo-miner.* apollo-miner-v*.*

case "${BOARD_NAME:-}" in
    "Apollo 3")
        # Start the internal miner immediately, then wait for external USB miners.
        screen -dmS miner ./futurebit-miner-v3 $settings3
        sleep 35
        load_settings
        ;;
    "Solo Node")
        # Solo Node only needs to wait for external USB miners.
        sleep 35
        load_settings
        ;;
    *)
        # Reset the internal hashboard.
        gpio write 0 0
        sleep .5
        gpio write 0 1

        sleep 35
        load_settings

        # Start the internal hashboard.
        boardType=$(./apollo-helper -s /dev/ttyS1)

        if [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* ]]; then
            screen -dmS miner ./futurebit-miner -comport /dev/ttyS1 -ao_mode 1 $settings
        elif [[ "$boardType" == *"Apollo-2"* ]]; then
            screen -dmS miner ./futurebit-miner-v2 -comport /dev/ttyS1 -ao_mode 1 $settings
        else
            echo "internal board error"
        fi
        ;;
esac

# Find and start external hashboards.
start_external_hashboards

echo "Started"
