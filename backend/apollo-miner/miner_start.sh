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

# The internal board of an Apollo II starts only after the 35 s wait below, and a
# settings save (new pool, new payout address) can rewrite miner_config during it.
# Read it after the wait, right before the board starts, never at the top. (USB
# boards read it themselves, in usb_miner_run.sh.)
load_settings()
{
    settings=""
    [[ -r miner_config ]] && settings=$(<miner_config)
}

# A miner already drives this port (see usb_miner_run.sh, which yields the same way).
usb_port_running()
{
    pgrep -f "futurebit-miner(-v2)? .*-comport ${1}( |\$)" >/dev/null 2>&1
}

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

# The pre-template way, for a git deploy that did not install the unit file
# (apollo-usb-miner@.service is copied by the installer, not by git pull): without
# it every systemctl start below fails and the USB boards silently stay off.
start_usb_board_in_screen()
{
    local port="$1"
    if usb_port_running "$port"; then
        echo "a miner already runs on $port"
        return
    fi
    local boardType
    boardType=$(./apollo-helper -s "$port")
    load_settings
    if [[ "$boardType" == *"Apollo-BTC"* || "$boardType" == *"RD6"* ]]; then
        screen -dmS miner ./futurebit-miner -comport "$port" -ao_mode 1 $settings
    elif [[ "$boardType" == *"Apollo-2"* ]]; then
        screen -dmS miner ./futurebit-miner-v2 -comport "$port" -ao_mode 1 $settings
    else
        echo "unknown USB board on $port"
    fi
}

# USB boards are apollo-usb-miner@<port> instances (hotplug starts the same
# instances from udev). --no-block is mandatory: this script is apollo-miner's
# ExecStart and the instances are After=apollo-miner, so waiting for them would
# deadlock. Starting an instance that already runs is a no-op.
start_external_hashboards()
{
    # Glob overridable so the test can fake a plugged-in USB board.
    local ports=(${APOLLO_USB_PORTS:-/dev/ttyACM*})
    local port
    local have_unit=1
    systemctl cat apollo-usb-miner@.service >/dev/null 2>&1 || have_unit=0
    for port in "${ports[@]}"; do
        [[ -e "$port" ]] || continue
        if usb_port_is_iap "$port"; then
            echo "${port} is still in its bootloader (IAP): the SLV hotplug starts it"
            continue
        fi
        if [[ "$have_unit" == 1 ]]; then
            systemctl start --no-block "apollo-usb-miner@${port##*/}.service" ||
                echo "could not enqueue apollo-usb-miner@${port##*/}"
        else
            echo "apollo-usb-miner@.service is not installed: starting ${port} in screen"
            start_usb_board_in_screen "$port"
        fi
    done
}

# Clear old Apollo I/II stat files without deleting Apollo III stats.
rm -f apollo-miner.* apollo-miner-v*.*

case "${BOARD_NAME:-}" in
    "Apollo 3")
        # Start the internal miner; USB boards come as instances.
        screen -dmS miner ./futurebit-miner-v3 $settings3
        ;;
    "Solo Node")
        # Nothing internal to run: the USB boards are apollo-usb-miner@ instances,
        # started by udev as they appear. Leave a placeholder in this unit's cgroup
        # so the unit stays active instead of exiting and being restarted every
        # 65 s. Only here: on Apollo II/III it would hide a crash of the internal
        # miner from Restart=always. setsid so it is not tied to this script, and
        # not in screen (the logs service looks for screen sessions named miner).
        setsid -f sleep infinity
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
