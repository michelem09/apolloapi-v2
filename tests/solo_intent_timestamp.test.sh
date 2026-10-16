#!/bin/bash
# The update scripts put the user's solo intent back into service_status. The
# service monitor reads requested_at as epoch milliseconds (every API writer uses
# Date.now()); CURRENT_TIMESTAMP is a "YYYY-MM-DD HH:MM:SS" string that reads as a
# nonsense date there. This runs the real functions from both scripts against a
# real sqlite database.
#
# Run: bash tests/solo_intent_timestamp.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v sqlite3 >/dev/null || { echo "  skip (no sqlite3)"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# The cases run in subshells, so results are counted in files.
check() {
    if [ "$2" = "$3" ]; then echo . >> "$tmp/passed"; printf '  ok   %s\n' "$1"
    else echo . >> "$tmp/failed"; printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

# A function body, exactly as written in the script: from "name() {" to the "}"
# in the first column.
fn() { awk -v n="$2" '$0 ~ "^"n"\\(\\) \\{" {p=1} p {print} p && /^}/ {exit}' "$1"; }

seed() {
    rm -f "$tmp/db.sqlite"
    sqlite3 "$tmp/db.sqlite" "CREATE TABLE service_status (service_name TEXT, status TEXT, requested_status TEXT, requested_at INTEGER);
        INSERT INTO service_status VALUES ('solo','offline',NULL,NULL);"
    printf '%s\n' "$1" > "$tmp/solo"
}

# Digits only, and within a minute of now, in milliseconds.
verify() {
    local label="$1" value now
    value="$(sqlite3 "$tmp/db.sqlite" "SELECT requested_at FROM service_status WHERE service_name='solo';")"
    now=$(( $(date +%s) * 1000 ))
    case "$value" in ''|*[!0-9]*) check "$label: requested_at is an integer" "digits" "$value"; return;; esac
    check "$label: requested_at is epoch milliseconds (now ± 60s)" "ok" \
        "$([ "$value" -gt $((now - 60000)) ] && [ "$value" -lt $((now + 60000)) ] && echo ok || echo "$value")"
    check "$label: the row is pending with the preserved intent" "pending|online" \
        "$(sqlite3 "$tmp/db.sqlite" "SELECT status||'|'||requested_status FROM service_status WHERE service_name='solo';")"
}

# backend/update
(
    SOLO_REQUEST_FILE="$tmp/solo"; STATE_DIR="$tmp/none"; APOLLO_DIR="$tmp/app"; mkdir -p "$APOLLO_DIR"
    err() { :; }
    conf_get() { printf '%s\n' "$tmp/db.sqlite"; }
    eval "$(fn "$ROOT/backend/update" resolve_database_url)"
    eval "$(fn "$ROOT/backend/update" restore_solo_intent)"
    seed online
    restore_solo_intent
    verify "update"
)

# backend/update_system
(
    SOLO_REQUEST_FILE="$tmp/solo"; STATE_DIR="$tmp/none"; APOLLO_DIR="$tmp/app"
    mkdir -p "$APOLLO_DIR"; printf 'DATABASE_URL=%s\n' "$tmp/db.sqlite" > "$APOLLO_DIR/.env"
    YELLOW=''; NC=''
    eval "$(fn "$ROOT/backend/update_system" resolve_database_url)"
    eval "$(fn "$ROOT/backend/update_system" restore_solo_intent)"
    seed online
    restore_solo_intent
    verify "update_system"
)

# No writer may go back to the string form.
check "no requested_at=CURRENT_TIMESTAMP left in backend/" "0" \
    "$(grep -rEn 'requested_at *= *CURRENT_TIMESTAMP' "$ROOT/backend" | wc -l | tr -d ' ')"

pass=$(cat "$tmp/passed" 2>/dev/null | wc -l | tr -d ' ')
fail=$(cat "$tmp/failed" 2>/dev/null | wc -l | tr -d ' ')
echo
echo "solo intent timestamp: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
