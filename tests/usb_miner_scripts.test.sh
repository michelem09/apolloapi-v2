#!/bin/bash
# usb_miner_run.sh, run for real with stubbed screen, sleep and apollo-helper.
#
# What this guards: the per-port instance (apollo-usb-miner@.service) must wait for
# the port to settle, give up quietly when the port is gone, refuse boards it does
# not know (exit 64, which the unit does not retry), exit 65 on a board still in IAP, read miner_config only after
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
# BOARD names what apollo-helper -s prints; BOARD_SEQ is a file of answers, one per
# probe, consumed first (a board that answers empty while it comes up).
cat > "$tmp/miner/apollo-helper" <<'EOS'
#!/bin/bash
echo "apollo-helper $*" >> "$STUB_LOG"
if [ "$1" = -s ]; then
    if [ -n "${BOARD_SEQ:-}" ] && [ -s "$BOARD_SEQ" ]; then
        head -1 "$BOARD_SEQ"; tail -n +2 "$BOARD_SEQ" > "$BOARD_SEQ.t"; mv "$BOARD_SEQ.t" "$BOARD_SEQ"
    else
        echo "${BOARD:-}"
    fi
fi
EOS
# PGREP_HIT=1: a miner already runs on the port.
printf '#!/bin/bash\necho "pgrep $*" >> "$STUB_LOG"\n[ -n "${PGREP_HIT:-}" ]\n' > "$tmp/bin/pgrep"
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

# 3b. A transient empty answer is retried (3 probes, 3 s apart) before the final 64.
rc=$(BOARD="" run)
check "empty probe: 3 probes" 3 "$(grep -c '^apollo-helper -s' "$LOG")"
check "empty probe: waits 3 s between probes" 3 "$(grep -c '^sleep 3$' "$LOG")"
printf '\n\nApollo-BTC\n' > "$tmp/seq"
rc=$(BOARD_SEQ="$tmp/seq" run)
check "late answer: exit 0" 0 "$rc"
check "late answer: started after 3 probes" 1 "$(grep -Fc "screen -D -m -S miner ./futurebit-miner -comport $PORT" "$LOG")"
printf '\nApollo-2\n' > "$tmp/seq"
rc=$(BOARD_SEQ="$tmp/seq" run)
check "answer on the 2nd probe picks the right binary" 1 "$(grep -Fc "screen -D -m -S miner ./futurebit-miner-v2 -comport $PORT" "$LOG")"
check "...and stops probing" 2 "$(grep -c '^apollo-helper -s' "$LOG")"

# 3c. A miner already on the port (rollback: an old miner_start.sh started it in
# screen): exit 0 without probing or starting; the pattern names this port.
rc=$(PGREP_HIT=1 BOARD="Apollo-BTC" run)
check "already running: exit 0" 0 "$rc"
check "already running: no screen" 0 "$(grep -c '^screen' "$LOG")"
check "already running: no probe" 0 "$(grep -c '^apollo-helper' "$LOG")"
check "already running: pgrep matches -comport of this port" 1 "$(grep -Fc -- "-comport ${PORT}( |\$)" "$LOG")"

# 3d. Board still in its bootloader (product "BCO IAP #..."): exit 0 without probing
# or starting; exit 65 stops the unit (no retry), the SLV hotplug starts a fresh one.
mkdir -p "$tmp/sys/ttyACM0" "$tmp/usbdev/if"
ln -sfn "$tmp/usbdev/if" "$tmp/sys/ttyACM0/device"
export APOLLO_SYS_TTY_DIR="$tmp/sys"
printf 'BCO IAP #0000AA\n' > "$tmp/usbdev/product"
rc=$(BOARD="Apollo-BTC" run)
check "IAP: exit 65 (the unit does not retry it)" 65 "$rc"
check "IAP: no probe" 0 "$(grep -c '^apollo-helper' "$LOG")"
check "IAP: no screen" 0 "$(grep -c '^screen' "$LOG")"
printf 'BCO SLV #0000AA\n' > "$tmp/usbdev/product"
rc=$(BOARD="Apollo-BTC" run)
check "SLV: started" 1 "$(grep -c '^screen -D -m -S miner' "$LOG")"
printf 'BCO IAP #0000AA\n' > "$tmp/usbdev/product"
rm -rf "$tmp/sys"
rc=$(BOARD="Apollo-BTC" run)
check "no sysfs entry: not IAP, started" 1 "$(grep -c '^screen -D -m -S miner' "$LOG")"
# The shared criterion table: same cases as the udev rule, minerBoards.js and miner_start.sh.
mkdir -p "$tmp/sys/ttyACM0"; ln -sfn "$tmp/usbdev/if" "$tmp/sys/ttyACM0/device"
while IFS=$'\t' read -r product want; do
    printf '%s\n' "$product" > "$tmp/usbdev/product"
    rc=$(BOARD="Apollo-BTC" run)
    if [ "$want" = yes ]; then
        check "criterion '$product': IAP, not started" 0 "$(grep -c '^screen -D -m -S miner' "$LOG")"
    else
        check "criterion '$product': not IAP, started" 1 "$(grep -c '^screen -D -m -S miner' "$LOG")"
    fi
done < "$DIR/tests/fixtures/iap_product_cases.tsv"
unset APOLLO_SYS_TTY_DIR

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
check "unit: RestartPreventExitStatus=64 65" 1 "$(grep -c '^RestartPreventExitStatus=64 65$' "$UNIT")"
check "unit: SuccessExitStatus=1 65 (IAP is a clean end, not failed)" 1 "$(grep -c '^SuccessExitStatus=1 65$' "$UNIT")"
check "unit: ExecStart passes /dev/%I" 1 "$(grep -c '^ExecStart=/opt/apolloapi/backend/apollo-miner/usb_miner_run.sh /dev/%I$' "$UNIT")"
for l in 'BindsTo=dev-%i.device' 'Requisite=apollo-miner.service' 'PartOf=apollo-miner.service' 'StartLimitIntervalSec=0' 'Restart=always'; do
    check "unit: $l" 1 "$(grep -Fxc "$l" "$UNIT")"
done
RULE="$DIR/backend/udev/99-apollo-usb-miner.rules"
check "rule: wants the instance for %k" 1 "$(grep -Fc 'ENV{SYSTEMD_WANTS}+="apollo-usb-miner@%k.service"' "$RULE")"
check "rule: never RUN+=" 0 "$(grep -v '^#' "$RULE" | grep -c 'RUN')"
# A negative ATTRS{} match is true at the first parent that differs (the USB hub):
# every board would skip the rule. Seen on the Solo Node.
check "rule: no negative ATTRS match" 0 "$(grep -v '^#' "$RULE" | grep -c 'ATTRS{[^}]*}!=')"
check "rule: vendor/product from usb_id" 2 "$(grep -cE '^ENV\{ID_(VENDOR|MODEL)_ID\}!="(0483|5740)", GOTO=' "$RULE")"
check "rule: IAP excluded, from ENV{ID_MODEL} only" 1 "$(grep -c '^ENV{ID_MODEL}=="IAP|IAP_\*|\*_IAP|\*_IAP_\*", GOTO=' "$RULE")"
check "rule: no ATTRS{product} at all" 0 "$(grep -v '^#' "$RULE" | grep -c 'ATTRS{')"
# The shared criterion table (tests/fixtures/iap_product_cases.tsv, also read by
# tests/minerBoards.test.js): the rule's glob alternation, applied to the product
# the way usb_id writes it into ID_MODEL (spaces -> underscores).
PATS="$(grep '^ENV{ID_MODEL}==' "$RULE" | sed -E 's/^ENV\{ID_MODEL\}=="([^"]*)".*/\1/')"
while IFS=$'\t' read -r product want; do
    model="${product// /_}"; got=no
    old_ifs=$IFS; IFS='|'
    for pat in $PATS; do
        # shellcheck disable=SC2254
        case "$model" in $pat) got=yes;; esac
    done
    IFS=$old_ifs
    check "rule glob, '$product' is IAP: $want" "$want" "$got"
done < "$DIR/tests/fixtures/iap_product_cases.tsv"
# Every GOTO has its LABEL, and every non-comment line is a valid rule shape.
check "rule: GOTOs resolve" 0 "$(grep -o 'GOTO="[^"]*"' "$RULE" | sort -u | sed 's/GOTO=/LABEL=/' | while read -r l; do grep -Fxq "$l" "$RULE" || echo missing; done | wc -l | tr -d ' ')"
check "rule: lines are key/op/value lists" 0 "$(grep -v '^#' "$RULE" | grep -v '^$' | grep -vcE '^[A-Za-z_]+(\{[A-Za-z_]+\})?(==|!=|\+=|=)"[^"]*"(, ?[A-Za-z_]+(\{[A-Za-z_]+\})?(==|!=|\+=|=)"[^"]*")*$')"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
