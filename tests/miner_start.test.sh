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
for stub in sleep screen gpio; do printf '#!/bin/sh\nexit 0\n' > "$bin/$stub"; done
cat > "$bin/install" <<EOS
#!/bin/sh
echo "\$*" >> "$tmp/install.log"
for last; do :; done
for arg; do case "\$arg" in -*|futurebit|700) ;; *) /bin/mkdir -p "\$arg" ;; esac; done
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

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
