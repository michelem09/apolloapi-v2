#!/bin/bash
# usb_miner_run.sh, run for real with stubbed screen, sleep and apollo-helper.
#
# What this guards: the per-port instance (apollo-usb-miner@.service) must wait for
# the port to settle, give up quietly when the port is gone, refuse boards it does
# not know (exit 64, which the unit does not retry), read miner_config only after
# the settle, and keep the screen session named "miner".
#
# Run: bash tests/usb_miner_scripts.test.sh   (bash 3.2 and 5)

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$DIR/backend/apollo-miner"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

mkdir -p "$tmp/bin" "$tmp/miner"
LOG="$tmp/calls.log"
printf '#!/bin/bash\necho "screen $*" >> "$STUB_LOG"\n' > "$tmp/bin/screen"
# The sleep stub logs its argument; SLEEP_REMOVES deletes the port, SLEEP_WRITES
# rewrites miner_config, standing in for an unplug / a settings save during the settle.
printf '#!/bin/bash\necho "sleep $*" >> "$STUB_LOG"\n[ -n "${SLEEP_REMOVES:-}" ] && rm -f "$SLEEP_REMOVES"\n[ -n "${SLEEP_WRITES:-}" ] && printf -- "-user NEW" > "$APOLLO_MINER_DIR/miner_config"\nexit 0\n' > "$tmp/bin/sleep"
# BOARD names what apollo-helper -s prints.
printf '#!/bin/bash\necho "apollo-helper $*" >> "$STUB_LOG"\ncase "$1" in -s) echo "${BOARD:-}";; esac\n' > "$tmp/miner/apollo-helper"
chmod +x "$tmp/bin/"* "$tmp/miner/apollo-helper"
cp "$SCRIPTS/usb_miner_run.sh" "$tmp/miner/"

export PATH="$tmp/bin:$PATH" STUB_LOG="$LOG" APOLLO_MINER_DIR="$tmp/miner"
PORT="$tmp/ttyACM0"
run() { : > "$LOG"; touch "$PORT"; bash "$tmp/miner/usb_miner_run.sh" "$PORT" >/dev/null 2>&1; echo $?; }

# 1. The settle is 8 s by default and overridable.
BOARD="Apollo-BTC" run >/dev/null
check "settles 8 s by default" 1 "$(grep -c '^sleep 8$' "$LOG")"
BOARD="Apollo-BTC" APOLLO_USB_SETTLE_S=3 run >/dev/null
check "settle is overridable" 1 "$(grep -c '^sleep 3$' "$LOG")"

# 2. Port gone during the settle: exit 0, the board is never probed or started.
rc=$(BOARD="Apollo-BTC" SLEEP_REMOVES="$PORT" run)
check "port gone: exit 0" 0 "$rc"
check "port gone: no probe" 0 "$(grep -c '^apollo-helper' "$LOG")"
check "port gone: no screen" 0 "$(grep -c '^screen' "$LOG")"

# 3. Unknown board (also an empty answer): exit 64, nothing started.
rc=$(BOARD="Mystery-9" run)
check "unknown board: exit 64" 64 "$rc"
check "unknown board: no screen" 0 "$(grep -c '^screen' "$LOG")"
rc=$(BOARD="" run)
check "empty probe: exit 64" 64 "$rc"

# 4. Binary per board type; the session is named miner, in the foreground.
for pair in "Apollo-BTC:./futurebit-miner" "RD6:./futurebit-miner" "Apollo-2:./futurebit-miner-v2"; do
    board="${pair%%:*}"; bin="${pair#*:}"
    rc=$(BOARD="$board" run)
    check "$board: exit 0 (stub screen returns)" 0 "$rc"
    check "$board: screen -D -m -S miner $bin -comport port -ao_mode 1" 1 \
        "$(grep -Fc "screen -D -m -S miner $bin -comport $PORT -ao_mode 1" "$LOG")"
done
check "the probe is of the right port" 1 "$(grep -Fc "apollo-helper -s $PORT" "$LOG")"

# 5. miner_config is read after the settle, never before.
printf -- '-user OLD' > "$tmp/miner/miner_config"
BOARD="Apollo-BTC" SLEEP_WRITES=1 run >/dev/null
check "settings written during the settle are the ones used" 1 "$(grep -c -- '-user NEW$' "$LOG")"
check "...and not the stale ones" 0 "$(grep -c -- '-user OLD' "$LOG")"
rm -f "$tmp/miner/miner_config"
BOARD="Apollo-BTC" run >/dev/null
check "no miner_config: still starts" 1 "$(grep -c '^screen -D -m -S miner' "$LOG")"

# 6. The unit and the script agree on the exit code and the arguments.
UNIT="$DIR/backend/systemd/apollo-usb-miner@.service"
check "unit: RestartPreventExitStatus=64" 1 "$(grep -c '^RestartPreventExitStatus=64$' "$UNIT")"
check "unit: ExecStart passes /dev/%I" 1 "$(grep -c '^ExecStart=/opt/apolloapi/backend/apollo-miner/usb_miner_run.sh /dev/%I$' "$UNIT")"
for l in 'BindsTo=dev-%i.device' 'Requisite=apollo-miner.service' 'PartOf=apollo-miner.service' 'StartLimitIntervalSec=0' 'Restart=always'; do
    check "unit: $l" 1 "$(grep -Fxc "$l" "$UNIT")"
done
RULE="$DIR/backend/udev/99-apollo-usb-miner.rules"
check "rule: wants the instance for %k" 1 "$(grep -Fc 'ENV{SYSTEMD_WANTS}+="apollo-usb-miner@%k.service"' "$RULE")"
check "rule: never RUN+=" 0 "$(grep -v '^#' "$RULE" | grep -c 'RUN')"
check "rule: IAP excluded" 1 "$(grep -c '^ATTRS{product}=="BCO IAP\*", GOTO=' "$RULE")"
# Every GOTO has its LABEL, and every non-comment line is a valid rule shape.
check "rule: GOTOs resolve" 0 "$(grep -o 'GOTO="[^"]*"' "$RULE" | sort -u | sed 's/GOTO=/LABEL=/' | while read -r l; do grep -Fxq "$l" "$RULE" || echo missing; done | wc -l | tr -d ' ')"
check "rule: lines are key/op/value lists" 0 "$(grep -v '^#' "$RULE" | grep -v '^$' | grep -vcE '^[A-Za-z_]+(\{[A-Za-z_]+\})?(==|!=|\+=|=)"[^"]*"(, ?[A-Za-z_]+(\{[A-Za-z_]+\})?(==|!=|\+=|=)"[^"]*")*$')"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
