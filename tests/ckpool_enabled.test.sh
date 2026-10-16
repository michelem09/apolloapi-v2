#!/bin/bash
# ckpool_enabled.sh (ExecCondition) against a real sqlite database, including one
# whose write lock is held: the Solo start resolver writes the request row and
# starts the unit at once, and a read that fails on the lock skipped the unit
# with solo mining requested online.
#
# Run: bash tests/ckpool_enabled.test.sh   (needs sqlite3)

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backend/ckpool"
command -v sqlite3 >/dev/null || { echo "  skip (no sqlite3)"; exit 0; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}
export DATABASE_URL="$tmp/db.sqlite"
sqlite3 "$DATABASE_URL" "CREATE TABLE settings (id INTEGER PRIMARY KEY, created_at INTEGER, node_enable_solo_mining INTEGER);
  CREATE TABLE service_status (id INTEGER PRIMARY KEY, service_name TEXT, requested_status TEXT);
  INSERT INTO settings VALUES (1, 1, 1);
  INSERT INTO service_status VALUES (1, 'solo', 'online');"
run() { bash "$DIR/ckpool_enabled.sh" >/dev/null 2>"$tmp/err"; echo $?; }

check "enabled and requested online -> 0" "0" "$(run)"
sqlite3 "$DATABASE_URL" "INSERT INTO service_status VALUES (2, 'solo', 'offline');"
check "requested offline -> 1" "1" "$(run)"
sqlite3 "$DATABASE_URL" "INSERT INTO service_status VALUES (3, 'solo', 'online');"

# An EXCLUSIVE transaction held ~1.5 s: readers are only locked out while a writer
# holds EXCLUSIVE (commit), which is what the API's request write does briefly.
hold_lock() {
    ( sqlite3 "$DATABASE_URL" "BEGIN EXCLUSIVE; UPDATE service_status SET requested_status='online' WHERE id=3; SELECT 1;" \
        ".shell sleep 1.5" "COMMIT;" >/dev/null 2>&1 ) &
    sleep 0.4
}
hold_lock
t0=$(date +%s)
rc="$(run)"
el=$(( $(date +%s) - t0 ))
wait
check "locked DB: waits for the lock and answers enabled" "0" "$rc"
check "locked DB: no 'Could not read' error" "0" "$(grep -c 'Could not read' "$tmp/err")"
check "locked DB: it did wait" "1" "$( [ "$el" -ge 1 ] && echo 1 || echo 0 )"

# Beyond the timeout it still fails closed (unit skipped), never claims enabled.
hold_lock
rc="$(APOLLO_DB_BUSY_MS=200 run)"
wait
check "lock held past the timeout -> error exit 1" "1" "$rc"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
