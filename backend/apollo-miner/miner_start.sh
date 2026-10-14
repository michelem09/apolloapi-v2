#!/bin/bash

# Binaries stay in the code checkout; the regenerated runtime data (miner_config,
# miner_config3, apollo-miner.* stat files) lives outside it so the checkout stays
# clean for prebuilt OTA updates. The bootstrap creates RUNTIME_DIR
# (futurebit-owned) before this unit runs; the install -d here is only a
# fallback, and it must keep that ownership: this script runs as root, and a
# root-owned dir makes the next bootstrap (futurebit) fail with EACCES.
BIN_DIR=/opt/apolloapi/backend/apollo-miner
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
RUNTIME_DIR="${STATE_DIR}/miner"

install -d -o futurebit -g futurebit -m 700 "$STATE_DIR" "$RUNTIME_DIR"
cd "$RUNTIME_DIR" || exit 1

ARMBIAN_RELEASE="/etc/armbian-release"
if [[ -r "$ARMBIAN_RELEASE" ]]; then
    . "$ARMBIAN_RELEASE"
fi

settings=""
settings3=""
[[ -r miner_config  ]] && settings=$(<miner_config)
[[ -r miner_config3 ]] && settings3=$(<miner_config3)

start_hashboards()
{
    while [[ -n "${1:-}" ]]; do
        local port="$1"
        local boardType
        boardType=$("$BIN_DIR"/apollo-helper -s "$port")

        if [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* ]]; then
            screen -dmS miner "$BIN_DIR"/futurebit-miner -comport "$port" -ao_mode 1 $settings
        elif [[ "$boardType" == *"Apollo-2"* ]]; then
            screen -dmS miner "$BIN_DIR"/futurebit-miner-v2 -comport "$port" -ao_mode 1 $settings
        else
            echo "unknown USB board"
        fi

        sleep 1
        shift
    done
}

start_external_hashboards()
{
    local ports=(/dev/ttyACM*)
    if [[ -e ${ports[0]} ]]; then
        start_hashboards "${ports[@]}"
    fi
}

# Clear old Apollo I/II stat files without deleting Apollo III stats.
rm -f apollo-miner.* apollo-miner-v*.*

case "${BOARD_NAME:-}" in
    "Apollo 3")
        # Start the internal miner immediately, then wait for external USB miners.
        screen -dmS miner "$BIN_DIR"/futurebit-miner-v3 $settings3
        sleep 35
        ;;
    "Solo Node")
        # Solo Node only needs to wait for external USB miners.
        sleep 35
        ;;
    *)
        # Reset the internal hashboard.
        gpio write 0 0
        sleep .5
        gpio write 0 1

        sleep 35

        # Start the internal hashboard.
        boardType=$("$BIN_DIR"/apollo-helper -s /dev/ttyS1)

        if [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* ]]; then
            screen -dmS miner "$BIN_DIR"/futurebit-miner -comport /dev/ttyS1 -ao_mode 1 $settings
        elif [[ "$boardType" == *"Apollo-2"* ]]; then
            screen -dmS miner "$BIN_DIR"/futurebit-miner-v2 -comport /dev/ttyS1 -ao_mode 1 $settings
        else
            echo "internal board error"
        fi
        ;;
esac

# Find and start external hashboards.
start_external_hashboards

echo "Started"
