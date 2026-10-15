#!/bin/bash
# miner_start.sh runs as root. Its fallback creation of the state/runtime dirs
# must hand them to futurebit (0700), otherwise the next bootstrap, which runs as
# futurebit, gets EACCES on a root-owned dir.
#
# The script is run for real with stubs for everything that touches hardware, and
# `install` is a recorder, so the test sees the exact arguments.
#
# Run: bash tests/miner_start.test.sh

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

bin="$tmp/bin"; mkdir -p "$bin"
for stub in sleep gpio; do printf '#!/bin/sh\nexit 0\n' > "$bin/$stub"; done
cat > "$bin/screen" <<EOS
#!/bin/sh
echo "\$PWD|\$*" >> "$tmp/screen.log"
EOS
cat > "$bin/install" <<EOS
#!/bin/sh
echo "\$*" >> "$tmp/install.log"
for last; do :; done
case "\$*" in
    *"-d "*) for arg; do case "\$arg" in -*|futurebit|700) ;; *) /bin/mkdir -p "\$arg" ;; esac; done ;;
    *) /bin/cp "\$3" "\$4" && /bin/chmod 755 "\$4" ;; # install -m 755 SRC DST
esac
EOS
cat > "$bin/mkdir" <<EOS
#!/bin/sh
echo "\$*" >> "$tmp/mkdir.log"
exec /bin/mkdir "\$@"
EOS
chmod +x "$bin"/*

state="$tmp/state"
PATH="$bin:$PATH" BOARD_NAME="Solo Node" APOLLO_STATE_DIR="$state" \
    bash "$REPO/backend/apollo-miner/miner_start.sh" >/dev/null 2>&1

log="$(cat "$tmp/install.log" 2>/dev/null)"
check "dirs are created with install -d" "1" "$(grep -c -- '-d' <<<"$log")"
check "owned by futurebit:futurebit"     "1" "$(grep -c -- '-o futurebit -g futurebit' <<<"$log")"
check "mode 0700"                        "1" "$(grep -c -- '-m 700' <<<"$log")"
check "covers the state dir"             "1" "$(grep -c -- "$state" <<<"$log")"
check "covers the runtime dir"           "1" "$(grep -c -- "$state/miner" <<<"$log")"
check "never plain mkdir (root-owned)"   "0" "$( [ -f "$tmp/mkdir.log" ] && wc -l < "$tmp/mkdir.log" | tr -d ' ' || echo 0)"

# --- Apollo III: the binary is launched from a copy in the runtime dir ------------
# (it writes its stat file next to itself, not into its cwd)
bindir="$tmp/checkout-bin"; mkdir -p "$bindir"
printf '#!/bin/sh\necho v1\n' > "$bindir/futurebit-miner-v3"; chmod +x "$bindir/futurebit-miner-v3"
state3="$tmp/state3"
run3() { PATH="$bin:$PATH" BOARD_NAME="Apollo 3" APOLLO_STATE_DIR="$state3" APOLLO_BIN_DIR="$bindir" \
    bash "$REPO/backend/apollo-miner/miner_start.sh" >/dev/null 2>&1; }
: > "$tmp/screen.log"; run3
check "III runs the runtime-dir copy, from the runtime dir" "$state3/miner|-dmS miner $state3/miner/futurebit-miner-v3" "$(head -1 "$tmp/screen.log")"
check "the copy is executable and identical"       "1" "$( [ -x "$state3/miner/futurebit-miner-v3" ] && cmp -s "$bindir/futurebit-miner-v3" "$state3/miner/futurebit-miner-v3" && echo 1 || echo 0)"
printf '#!/bin/sh\necho v2\n' > "$bindir/futurebit-miner-v3"; chmod +x "$bindir/futurebit-miner-v3"
run3
check "an OTA-replaced binary refreshes the copy"  "1" "$(cmp -s "$bindir/futurebit-miner-v3" "$state3/miner/futurebit-miner-v3" && echo 1 || echo 0)"
: > "$tmp/install.log"; run3
check "an unchanged binary is not re-copied"       "0" "$(grep -c 'futurebit-miner-v3' "$tmp/install.log")"
check "the checkout binary is never launched"      "0" "$(grep -c "$bindir" "$tmp/screen.log")"
# copy impossible -> fall back to the checkout binary rather than not mining
rm -rf "$state3"
cp "$bin/install" "$tmp/install.real"
printf '#!/bin/sh\ncase "$*" in *"-d "*) exec %s "$@";; *) exit 1;; esac\n' "$tmp/install.real" > "$bin/install"; chmod +x "$bin/install"
: > "$tmp/screen.log"; run3
check "failed copy falls back to the checkout binary" "1" "$(grep -c -- "-dmS miner $bindir/futurebit-miner-v3" "$tmp/screen.log")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
