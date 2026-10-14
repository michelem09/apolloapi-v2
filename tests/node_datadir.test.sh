#!/bin/bash
# The settings.json a full disk leaves behind, and the launcher's way past it.
#
# The failure this guards against was found the hard way: bitcoind refuses an
# empty settings.json before it opens debug.log, so the crash loop it causes has
# no trace anywhere, and freeing space — the obvious fix — does nothing.
#
# Run: bash tests/node_datadir.test.sh

set -u

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backend/lib/node_datadir.sh"
# shellcheck disable=SC1090
. "$LIB"

pass=0
fail=0
check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass=$((pass + 1)); printf '  ok   %s\n' "$name"
    else
        fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$name" "$expected" "$actual"
    fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The case from the field: 0 bytes.
d="$tmp/empty"; mkdir -p "$d"; : > "$d/settings.json"
out="$(node_datadir_heal_settings "$d")"
check "an empty file is moved aside"           "1" "$( [ -n "$out" ] && echo 1 || echo 0 )"
check "…and is gone from where bitcoind looks" "0" "$( [ -e "$d/settings.json" ] && echo 1 || echo 0 )"
check "…but not deleted"                       "1" "$( [ -e "$out" ] && echo 1 || echo 0 )"
check "…under a name that says what it was"    "settings.json.corrupt-" "$(basename "$out" | cut -c1-22)"

# Truncated mid-write: the other shape a full disk produces.
d="$tmp/truncated"; mkdir -p "$d"; printf '{"rpcport": 83' > "$d/settings.json"
out="$(node_datadir_heal_settings "$d")"
check "a truncated file is moved aside" "1" "$( [ -n "$out" ] && echo 1 || echo 0 )"

# The two shapes that must be left alone.
d="$tmp/valid"; mkdir -p "$d"; printf '{"prune": 0}\n' > "$d/settings.json"
out="$(node_datadir_heal_settings "$d")"
check "a valid file is untouched"     "" "$out"
check "…and still there"              "1" "$( [ -e "$d/settings.json" ] && echo 1 || echo 0 )"

d="$tmp/none"; mkdir -p "$d"
out="$(node_datadir_heal_settings "$d")"; rc=$?
check "no file at all is fine"        "0" "$rc"
check "…and says nothing"             "" "$out"

# Two heals in a row must not overwrite the first copy.
d="$tmp/twice"; mkdir -p "$d"
: > "$d/settings.json"; first="$(node_datadir_heal_settings "$d")"
: > "$d/settings.json"; sleep 1; second="$(node_datadir_heal_settings "$d")"
check "each copy gets its own name" "1" "$( [ "$first" != "$second" ] && [ -e "$first" ] && [ -e "$second" ] && echo 1 || echo 0 )"

echo
echo "--- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
