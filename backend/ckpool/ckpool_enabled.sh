#!/bin/bash
set -Eeuo pipefail

APOLLO_DIR="${APOLLO_DIR:-/opt/apolloapi}"
DATABASE_URL="${DATABASE_URL:-${APOLLO_DIR}/futurebit.sqlite}"

# The Solo start resolver writes the request row and then starts this unit
# without waiting: the read lands on the API's write lock (journal_mode=delete)
# and, without a busy timeout, fails at once, which skipped the unit with solo
# mining requested online. `.timeout` makes sqlite3 wait for the lock instead.
if ! enabled=$(sqlite3 -cmd ".timeout ${APOLLO_DB_BUSY_MS:-5000}" "$DATABASE_URL" \
    "SELECT CASE
       WHEN COALESCE(
         (SELECT node_enable_solo_mining
            FROM settings
           ORDER BY created_at DESC, id DESC
           LIMIT 1),
         0
       ) = 1
       AND COALESCE(
         (SELECT requested_status
            FROM service_status
           WHERE service_name = 'solo'
           ORDER BY id DESC
           LIMIT 1),
         'online'
       ) != 'offline'
       THEN 1 ELSE 0
     END;" \
    2>/dev/null); then
    echo "[ckpool] Could not read solo-mining lifecycle state from $DATABASE_URL" >&2
    exit 1
fi

[ "$enabled" = "1" ]
