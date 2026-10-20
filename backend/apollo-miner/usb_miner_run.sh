#!/bin/bash
# Runs one USB hashboard in the foreground, as the main process of
# apollo-usb-miner@<port>.service. Usage: usb_miner_run.sh /dev/ttyACMx
#
# Exit codes: 0 port gone or already served by a running miner (nothing to run),
# 64 unknown board (the unit does not retry, and ends failed),
# 65 still in the bootloader (IAP): the unit does not retry and counts it as a
#    clean end (SuccessExitStatus), so no failed unit is left behind. The SLV
#    re-enumeration fires a udev add that starts a fresh instance, and a Start from
#    the UI goes through miner_start.sh, which skips IAP ports: nothing to retry.
# anything else is the miner's/screen's own status.

# Same layout as miner_start.sh: binaries in the code checkout, runtime data
# (miner_config, the stat files the miners write into their cwd) under the state
# dir. Paths and the settle time are overridable so tests/usb_miner_scripts.test.sh
# can run the script for real.
BIN_DIR="${APOLLO_BIN_DIR:-/opt/apolloapi/backend/apollo-miner}"
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
RUNTIME_DIR="${STATE_DIR}/miner"
cd "$RUNTIME_DIR" || exit 1

port="${1:-}"
[[ -n "$port" ]] || { echo "usage: $0 /dev/ttyACMx" >&2; exit 2; }

# A replug enumerates several times in a few seconds, and a board comes up in its
# bootloader first. Let the port settle before talking to it.
sleep "${APOLLO_USB_SETTLE_S:-8}"

if [[ ! -e "$port" ]]; then
    echo "$port is gone"
    exit 0
fi

# The board is in its bootloader (USB product "BCO IAP #<serial>", ~30 s after
# power-up, then it re-enumerates as SLV). Same test as the udev rule and
# src/minerBoards.js (product read from the USB device above the tty interface).
# Probing it now only fails ("Unknown board"); the SLV add event starts it.
usb_port_is_iap()
{
    local name="${1##*/}" dev product
    dev=$(realpath "${APOLLO_SYS_TTY_DIR:-/sys/class/tty}/${name}/device" 2>/dev/null) || return 1
    product=$(cat "${dev}/../product" 2>/dev/null) || return 1
    [[ "$product" =~ (^|[^[:alnum:]_])IAP([^[:alnum:]_]|$) ]]
}

if usb_port_is_iap "$port"; then
    # 65, not 0: Restart=always would otherwise start this check again every
    # RestartSec for as long as the board stays in IAP (a stuck one: forever).
    echo "$port is still in its bootloader (IAP)"
    exit 65
fi

# Another miner already drives this port: a rollback to an older miner_start.sh
# starts boards in screen itself while the udev rule also starts this instance.
# Two miners on one port would fight over it, so this one yields. Restart=always
# brings the instance back after RestartSec and the check repeats, which is
# harmless: it starts the board as soon as the other miner is gone.
if pgrep -f "futurebit-miner(-v2)? .*-comport ${port}( |\$)" >/dev/null 2>&1; then
    echo "a miner already runs on $port"
    exit 0
fi

# An empty or garbled answer can be transient (the board is still coming up), and
# 64 is final for the unit: probe a few times before giving up.
boardType=""
for ((try = 1; try <= ${APOLLO_USB_PROBE_TRIES:-3}; try++)); do
    boardType=$("$BIN_DIR"/apollo-helper -s "$port")
    [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* || "$boardType" == *"Apollo-2"* ]] && break
    sleep "${APOLLO_USB_PROBE_WAIT_S:-3}"
    if [[ ! -e "$port" ]]; then
        echo "$port is gone"
        exit 0
    fi
done

if [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* ]]; then
    bin="$BIN_DIR"/futurebit-miner
elif [[ "$boardType" == *"Apollo-2"* ]]; then
    bin="$BIN_DIR"/futurebit-miner-v2
else
    echo "unknown USB board on $port"
    exit 64
fi

# Read the settings now, never before the settle: a settings save (new pool, new
# payout address) can rewrite miner_config while the port settles.
settings=""
[[ -r miner_config ]] && settings=$(<miner_config)

# The session name must stay "miner": the logs service and miner_stop.sh find
# sessions by that name. -D -m keeps screen in the foreground for systemd.
# shellcheck disable=SC2086
exec screen -D -m -S miner "$bin" -comport "$port" -ao_mode 1 $settings
