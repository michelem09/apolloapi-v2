#!/bin/bash
# miner_stop.sh / miner_start.sh, run for real with stubbed gpio, apollo-helper,
# screen and sleep.
#
# What this guards: a stop that lands while miner_start.sh is still running (the
# unit stays "activating" ~35s) or after a crash never ran ExecStop, so the
# hashboard reset and the Apollo 3 SIGTERM shutdown were skipped. The unit now also
# runs `miner_stop.sh --if-owed` as ExecStopPost. Between the two calls every stop
# must do the full shutdown exactly once.
#
# Run: bash tests/miner_scripts.test.sh   (bash 3.2 and 5)

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$DIR/backend/apollo-miner"
tmp="$(mktemp -d)"
pids=""
cleanup() { for p in $pids; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap cleanup EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

mkdir -p "$tmp/bin" "$tmp/miner" "$tmp/run"
LOG="$tmp/calls.log"
for cmd in gpio screen; do
    printf '#!/bin/bash\necho "%s $*" >> "$STUB_LOG"\n' "$cmd" > "$tmp/bin/$cmd"
done
# GPIO_DIE=1: the shutdown script is killed in the middle of its gpio reset.
printf '#!/bin/bash\necho "gpio $*" >> "$STUB_LOG"\n[ -n "${GPIO_DIE:-}" ] && kill -KILL "$PPID"\nexit 0\n' > "$tmp/bin/gpio"
# No session to find, nothing to wait for: `screen -ls` prints nothing.
printf '#!/bin/bash\necho "apollo-helper $*" >> "$STUB_LOG"\ncase "$1" in -s) echo Apollo-2;; esac\n' > "$tmp/miner/apollo-helper"
# The start script waits 35 s for USB boards; the wait is not what is under test.
printf '#!/bin/bash\nexit 0\n' > "$tmp/bin/sleep"
chmod +x "$tmp/bin/"* "$tmp/miner/apollo-helper"
cp "$SCRIPTS/miner_start.sh" "$SCRIPTS/miner_stop.sh" "$tmp/miner/"

export PATH="$tmp/bin:$PATH" STUB_LOG="$LOG"
export APOLLO_MINER_DIR="$tmp/miner" MINER_STOPPED_MARKER="$tmp/run/stopped"
export ARMBIAN_RELEASE_FILE="$tmp/armbian-release"
: > "$ARMBIAN_RELEASE_FILE"

resets() { grep -c '^gpio write 0 0' "$LOG"; }
stop()   { ( bash "$tmp/miner/miner_stop.sh" "$@" >/dev/null 2>&1 ); }
start()  { bash "$tmp/miner/miner_start.sh" >/dev/null 2>&1; }
fresh()  { : > "$LOG"; rm -f "$MINER_STOPPED_MARKER"; }

# 1. A plain stop (ExecStop) does the shutdown and leaves the marker.
fresh; stop
check "stop resets the hashboard" 1 "$(resets)"
check "stop leaves the marker" 1 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"

# 2. ExecStopPost after an ExecStop that ran: nothing more happens.
stop --if-owed
check "--if-owed after a stop is a no-op" 1 "$(resets)"

# 3. ExecStopPost with no ExecStop before it (stop while starting, or a crash): full shutdown.
fresh; start; : > "$LOG"
stop --if-owed
check "--if-owed after a start does the shutdown" 1 "$(resets)"
check "...and leaves the marker" 1 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"
stop --if-owed
check "...once" 1 "$(resets)"

# 4. A start makes the next stop owed again, even if the previous one left the marker.
stop; start; : > "$LOG"
check "start clears the marker" 0 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"
stop --if-owed
check "--if-owed after the next start runs" 1 "$(resets)"

# 4b. A shutdown that died half-way is still owed: the marker is written last.
fresh; start; : > "$LOG"
GPIO_DIE=1 stop
check "a stop killed half-way leaves no marker" 0 "$([ -e "$MINER_STOPPED_MARKER" ] && echo 1 || echo 0)"
stop --if-owed
check "...so --if-owed does it again" 2 "$(resets)"

# 4c. USB boards are apollo-usb-miner@ instances, enqueued with --no-block (the
# script is apollo-miner's ExecStart; waiting for After=apollo-miner units hangs).
# The sleep stub logs its argument so the 35 s wait can be asserted per board.
printf '#!/bin/bash\necho "sleep $*" >> "$STUB_LOG"\nexit 0\n' > "$tmp/bin/sleep"
# UNIT_MISSING=1: `systemctl cat` fails as for a unit file that was never installed.
printf '#!/bin/bash\necho "systemctl $*" >> "$STUB_LOG"\n[ "$1" = cat ] && [ -n "${UNIT_MISSING:-}" ] && exit 1\nexit 0\n' > "$tmp/bin/systemctl"
# PGREP_HIT=1: a miner already runs on some port.
printf '#!/bin/bash\necho "pgrep $*" >> "$STUB_LOG"\n[ -n "${PGREP_HIT:-}" ]\n' > "$tmp/bin/pgrep"
printf '#!/bin/bash\necho "setsid $*" >> "$STUB_LOG"\n' > "$tmp/bin/setsid"
chmod +x "$tmp/bin/"*
touch "$tmp/ttyACM0" "$tmp/ttyACM1"
USBS="$tmp/ttyACM0 $tmp/ttyACM1 $tmp/ttyACM9"; rm -f "$tmp/ttyACM9"
for board in "Solo Node" "Apollo 3" "FutureBit Apollo II"; do
    printf 'BOARD_NAME="%s"\n' "$board" > "$ARMBIAN_RELEASE_FILE"
    fresh; APOLLO_USB_PORTS="$USBS" start
    check "$board: instance for ttyACM0, --no-block" 1 \
        "$(grep -c '^systemctl start --no-block apollo-usb-miner@ttyACM0.service$' "$LOG")"
    check "$board: instance for ttyACM1" 1 "$(grep -c '^systemctl start --no-block apollo-usb-miner@ttyACM1.service$' "$LOG")"
    check "$board: no instance for a port that is not there" 0 "$(grep -c 'ttyACM9' "$LOG")"
    check "$board: no USB board in screen" 0 "$(grep -c '^screen .*-comport '"$tmp"'/ttyACM' "$LOG")"
    check "$board: no systemctl start without --no-block" 0 "$(grep '^systemctl start' "$LOG" | grep -vc -- '--no-block')"
done
# 4d. A port whose board is still in its bootloader (USB product "BCO IAP #...") is
# skipped: probing it only fails, and the SLV hotplug starts the instance. The
# product is read from sysfs, like the udev rule and src/minerBoards.js do.
fakeusb() {  # name product
    mkdir -p "$tmp/sys/$1" "$tmp/usbdev/$1/if"
    printf '%s\n' "$2" > "$tmp/usbdev/$1/product"
    ln -sfn "$tmp/usbdev/$1/if" "$tmp/sys/$1/device"
}
fakeusb ttyACM0 "BCO IAP #0000AA"; fakeusb ttyACM1 "BCO SLV #0000BB"
printf 'BOARD_NAME="Solo Node"\n' > "$ARMBIAN_RELEASE_FILE"
fresh; APOLLO_SYS_TTY_DIR="$tmp/sys" APOLLO_USB_PORTS="$USBS" start
check "IAP port: no instance enqueued" 0 "$(grep -c 'apollo-usb-miner@ttyACM0' "$LOG")"
check "IAP port: the SLV port next to it is enqueued" 1 "$(grep -c '^systemctl start --no-block apollo-usb-miner@ttyACM1.service$' "$LOG")"
fresh; UNIT_MISSING=1 APOLLO_SYS_TTY_DIR="$tmp/sys" APOLLO_USB_PORTS="$USBS" start
check "IAP port, no unit: not started in screen" 0 "$(grep '^screen' "$LOG" | grep -c "ttyACM0")"
check "IAP port, no unit: not probed" 0 "$(grep -c "^apollo-helper -s $tmp/ttyACM0" "$LOG")"
# No sysfs entry (a dev machine, an unreadable product): not IAP, started as before.
fresh; APOLLO_SYS_TTY_DIR="$tmp/nosys" APOLLO_USB_PORTS="$USBS" start
check "no sysfs: ttyACM0 enqueued" 1 "$(grep -c '^systemctl start --no-block apollo-usb-miner@ttyACM0.service$' "$LOG")"
# "IAP" must be a word: a product that merely contains the letters is a miner.
fakeusb ttyACM0 "BCO CAPITAL #1"
fresh; APOLLO_SYS_TTY_DIR="$tmp/sys" APOLLO_USB_PORTS="$USBS" start
check "product containing IAP letters inside a word: enqueued" 1 "$(grep -c 'apollo-usb-miner@ttyACM0' "$LOG")"
fakeusb ttyACM0 "BCO IAP #0000AA"

# Unit file not installed (git deploy): the old way, in screen, same binary choice
# (the apollo-helper stub answers Apollo-2), and nothing is enqueued.
for board in "Solo Node" "Apollo 3"; do
    printf 'BOARD_NAME="%s"\n' "$board" > "$ARMBIAN_RELEASE_FILE"
    printf -- '-user USB' > "$tmp/miner/miner_config"
    fresh; UNIT_MISSING=1 APOLLO_USB_PORTS="$USBS" start
    check "$board, no unit: no instance enqueued" 0 "$(grep -c '^systemctl start' "$LOG")"
    check "$board, no unit: ttyACM0 in screen with miner_config" 1 \
        "$(grep -Fc "screen -dmS miner ./futurebit-miner-v2 -comport $tmp/ttyACM0 -ao_mode 1 -user USB" "$LOG")"
    check "$board, no unit: ttyACM1 in screen" 1 "$(grep -Fc "screen -dmS miner ./futurebit-miner-v2 -comport $tmp/ttyACM1 " "$LOG")"
    check "$board, no unit: no screen for the port that is not there" 0 "$(grep '^screen' "$LOG" | grep -c ttyACM9)"
    # A port whose miner already runs is skipped, not started twice.
    fresh; UNIT_MISSING=1 PGREP_HIT=1 APOLLO_USB_PORTS="$USBS" start
    check "$board, no unit, miner already there: no screen on a USB port" 0 "$(grep -c '^screen .*-comport '"$tmp"'/ttyACM' "$LOG")"
    check "$board, no unit, miner already there: no probe of the port" 0 "$(grep -c '^apollo-helper -s '"$tmp"'/ttyACM' "$LOG")"
done
rm -f "$tmp/miner/miner_config"
# With the unit installed the fallback never runs.
fresh; APOLLO_USB_PORTS="$USBS" start
check "unit installed: no screen on a USB port" 0 "$(grep -c '^screen .*-comport '"$tmp"'/ttyACM' "$LOG")"
# No USB board: no instance at all.
printf 'BOARD_NAME="Solo Node"\n' > "$ARMBIAN_RELEASE_FILE"
fresh; APOLLO_USB_PORTS="$tmp/nothing" start
check "no board: no systemctl start" 0 "$(grep -c '^systemctl start' "$LOG")"

# Solo Node: no 35 s wait, a placeholder keeps the unit active, stat files still go.
printf 'BOARD_NAME="Solo Node"\n' > "$ARMBIAN_RELEASE_FILE"
touch "$tmp/miner/apollo-miner.1234" "$tmp/miner/apollo-miner-v3.json"
fresh; start
check "Solo Node: no sleep 35" 0 "$(grep -c '^sleep 35' "$LOG")"
check "Solo Node: placeholder started" 1 "$(grep -c '^setsid -f sleep infinity$' "$LOG")"
check "Solo Node: nothing in screen" 0 "$(grep -c '^screen' "$LOG")"
check "Solo Node: no gpio" 0 "$(grep -c '^gpio' "$LOG")"
check "Solo Node: old stat files cleared" 0 "$(ls "$tmp/miner" | grep -c '^apollo-miner[.-]')"

# Apollo II: gpio reset, wait, internal board on ttyS1 with the miner_config read
# after the wait (the sleep stub rewrites it, standing in for a settings save).
printf 'BOARD_NAME="FutureBit Apollo II"\n' > "$ARMBIAN_RELEASE_FILE"
printf '#!/bin/bash\necho "sleep $*" >> "$STUB_LOG"\n[ "$1" = 35 ] && printf -- "-user NEW" > "$APOLLO_MINER_DIR/miner_config"\nexit 0\n' > "$tmp/bin/sleep"
fresh; printf -- '-user OLD' > "$tmp/miner/miner_config"; start
check "Apollo II: gpio reset" 1 "$(resets)"
check "Apollo II: waits 35 s" 1 "$(grep -c '^sleep 35' "$LOG")"
check "Apollo II: internal board on ttyS1 with the new miner_config" 1 "$(grep -c '^screen .*-comport /dev/ttyS1 .*-user NEW' "$LOG")"
check "Apollo II: no placeholder" 0 "$(grep -c '^setsid' "$LOG")"

# Apollo 3: internal miner unchanged (miner_config3, no wait, no placeholder).
printf 'BOARD_NAME="Apollo 3"\n' > "$ARMBIAN_RELEASE_FILE"
fresh; printf -- '-threads 3' > "$tmp/miner/miner_config3"; start
check "Apollo 3: internal miner in screen" 1 "$(grep -c '^screen -dmS miner ./futurebit-miner-v3 -threads 3$' "$LOG")"
check "Apollo 3: no gpio" 0 "$(grep -c '^gpio' "$LOG")"
check "Apollo 3: no placeholder" 0 "$(grep -c '^setsid' "$LOG")"
: > "$ARMBIAN_RELEASE_FILE"; rm -f "$tmp/miner/miner_config" "$tmp/miner/miner_config3"

# Past the start script: the real sleep is back (step 6 needs the waiting to be real).
rm -f "$tmp/bin/sleep" "$tmp/bin/pgrep"

# 5. An explicit stop is never skipped by a stale marker (ExecStop always shuts down).
touch "$MINER_STOPPED_MARKER"; : > "$LOG"
stop
check "plain stop ignores the marker" 1 "$(resets)"

# 6. Apollo 3: the shutdown is SIGTERM to the miner, found by the pattern built
# from the miner dir (the miner is started here by absolute path, which only the
# MINER_DIR branch of the pattern matches), and the script waits for it.
echo 'BOARD_NAME="Apollo 3"' > "$ARMBIAN_RELEASE_FILE"
M3_LOG="$tmp/m3.log"
( cd "$tmp/miner"; exec -a "$tmp/miner/futurebit-miner-v3" bash -c "trap 'echo TERM >> $M3_LOG; sleep 1; echo done >> $M3_LOG; exit 0' TERM; i=0; while [ \$i -lt 100 ]; do sleep 0.2; i=\$((i+1)); done" ) >/dev/null 2>&1 &
pids="$pids $!"
sleep 0.5
fresh; stop
check "Apollo 3 miner got SIGTERM" "TERM" "$(head -1 "$M3_LOG" 2>/dev/null)"
check "Apollo 3 stop waited for the miner to finish" "done" "$(tail -1 "$M3_LOG" 2>/dev/null)"
check "Apollo 3 stop does not reset the gpio" 0 "$(resets)"

# 7. The unit and the script agree on the flag, and the unit shuts the cgroup down
# in the order the Apollo 3 shutdown needs.
UNIT="$DIR/backend/systemd/apollo-miner.service"
check "unit runs miner_stop.sh --if-owed as ExecStopPost" 1 \
    "$(grep -Ec '^ExecStopPost=-?/opt/apolloapi/backend/apollo-miner/miner_stop\.sh --if-owed$' "$UNIT")"
check "unit uses KillMode=mixed" 1 "$(grep -c '^KillMode=mixed$' "$UNIT")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
