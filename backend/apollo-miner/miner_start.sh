#!/bin/bash

# Binaries stay in the code checkout; the regenerated runtime data (miner_config,
# miner_config3, apollo-miner.* stat files) lives outside it so the checkout stays
# clean for prebuilt OTA updates. The bootstrap creates RUNTIME_DIR
# (futurebit-owned) before this unit runs; the install -d here is only a
# fallback, and it must keep that ownership: this script runs as root, and a
# root-owned dir makes the next bootstrap (futurebit) fail with EACCES.
BIN_DIR="${APOLLO_BIN_DIR:-/opt/apolloapi/backend/apollo-miner}"
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
RUNTIME_DIR="${STATE_DIR}/miner"

install -d -o futurebit -g futurebit -m 700 "$STATE_DIR" "$RUNTIME_DIR"
cd "$RUNTIME_DIR" || exit 1

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

# The Apollo III binary writes apollo-miner-3.json next to ITSELF, not into its
# cwd (observed: cwd was $RUNTIME_DIR, the file landed in $BIN_DIR, root-owned,
# inside the OTA checkout, where the API never looks). It is not known whether it
# resolves its own dir from argv[0] or from /proc/self/exe; a symlink would only
# satisfy the first. A real copy in $RUNTIME_DIR satisfies both, so the III
# binary is run from there. Refreshed when the checkout's binary differs (OTA).
# Prints the path to launch; falls back to the checkout binary if the copy fails.
# The USB binaries are untouched: their stat files already land in the cwd.
stage_v3_binary()
{
    local src="$BIN_DIR"/futurebit-miner-v3
    local dst="$RUNTIME_DIR/futurebit-miner-v3"
    if [[ -x "$dst" ]] && cmp -s "$src" "$dst"; then
        echo "$dst"
    elif install -m 755 "$src" "$dst" >&2 && [[ -x "$dst" ]]; then
        echo "$dst"
    else
        echo "$src"
    fi
}

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
        miner_v3=$(stage_v3_binary)
        screen -dmS miner "$miner_v3" $settings3
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
