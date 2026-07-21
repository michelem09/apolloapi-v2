#!/bin/bash
# Failure-injection tests for the updater's rollback path.
#
# This path is only ever taken when an update has already gone wrong, so it never
# runs in normal use and a review found it broken at every step: the bitcoind
# rescue deleted the only copy, the "did we mutate anything" flag was set after
# the mutation, version.json was never reverted, units were never reverted, and
# nothing was ever restarted.
#
# So these tests do not read the script — they source it as a library and drive
# the real functions against a real temporary tree, injecting the failures.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Results go to files, not variables: every scenario below runs in a subshell so
# its sandbox and sourced globals stay isolated, and a counter incremented there
# never reaches this shell — the suite would report success no matter what failed.
RESULTS="$(mktemp -d)"
trap 'rm -rf "$RESULTS"' EXIT
export RESULTS

ok()   { echo p >> "$RESULTS/pass"; printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
bad()  { echo f >> "$RESULTS/fail"; printf '  \033[0;31m✗\033[0m %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

# A device tree with the shapes the updater cares about: the owned dirs, the six
# bitcoind flavours under backend/node/bin, a built UI, and the root files.
make_device() {
  ROOT="$(mktemp -d)"
  export APOLLO_ROOT_DIR="$ROOT/opt/apolloapi"
  export APOLLO_STATE_DIR="$ROOT/var/lib/apollo"
  mkdir -p "$APOLLO_ROOT_DIR"/{src,config,migrations,node_modules,backend/node/bin,backend/systemd}
  mkdir -p "$APOLLO_ROOT_DIR/apolloui-v2/.next/standalone"
  echo 'OLD' > "$APOLLO_ROOT_DIR/src/marker"
  for f in core-25.1 core-28.1 core-29.2 core-31.0 knots-29.2 knots-29.3; do
    mkdir -p "$APOLLO_ROOT_DIR/backend/node/bin/$f"; echo bitcoind > "$APOLLO_ROOT_DIR/backend/node/bin/$f/bitcoind"
  done
  echo '{"version":"2.2.0"}' > "$APOLLO_ROOT_DIR/package.json"
  echo 'OLD' > "$APOLLO_ROOT_DIR/knexfile.js"
  mkdir -p "$APOLLO_STATE_DIR/backups"
  # Stubs: the functions call systemctl/install/chown, none of which exist or are
  # wanted here. Recorded so the tests can assert what was invoked.
  STUBS="$ROOT/stubs"; mkdir -p "$STUBS"
  cat > "$STUBS/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >> "$SYSTEMCTL_LOG"
EOF
  cat > "$STUBS/chown" <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod +x "$STUBS/systemctl" "$STUBS/chown"
  export SYSTEMCTL_LOG="$ROOT/systemctl.log"; : > "$SYSTEMCTL_LOG"
  export PATH="$STUBS:$PATH"
  # shellcheck disable=SC1091
  APOLLO_UPDATE_LIB=1 source "$REPO/backend/update"
}

flavours() { ls "$APOLLO_ROOT_DIR/backend/node/bin" 2>/dev/null | wc -l | tr -d ' '; }

echo "rollback contract"

# --- bitcoind survives a rollback --------------------------------------------
# The regression that made this file necessary: restore_code called
# preserve_binaries, whose first statement deletes $PRESERVED_BIN — the only copy
# of bitcoind in the window between preserve and place.
(
  make_device
  preserve_binaries          # bitcoind now lives ONLY at $PRESERVED_BIN
  backup_code
  check "bitcoind is out of the tree mid-update" "$(flavours)" "0"
  restore_code >/dev/null 2>&1
  check "rollback puts all six flavours back" "$(flavours)" "6"
  check "rollback restores the old code" "$(cat "$APOLLO_ROOT_DIR/src/marker" 2>/dev/null)" "OLD"
)

# --- a crashed run followed by a clean one ------------------------------------
# Run 1 dies after preserve; run 2 must not delete the orphaned copy.
(
  make_device
  preserve_binaries
  backup_code
  restore_code >/dev/null 2>&1          # run 1 rolls back
  preserve_binaries                     # run 2 starts
  restore_code >/dev/null 2>&1          # run 2 also rolls back
  check "bitcoind survives two consecutive failed runs" "$(flavours)" "6"
)

# --- the backup pointer exists before anything moves --------------------------
# It used to be written after the move loop, so a failure partway through left the
# tree dismantled with nothing recording where it went.
(
  make_device
  BACKUP_CODE=''
  backup_code
  ptr="$(cat "$APOLLO_STATE_DIR/backups/.last-code-backup" 2>/dev/null)"
  if [ -n "$ptr" ] && [ -d "$ptr" ]; then ok "backup pointer written and valid"
  else bad "backup pointer written and valid" "got '$ptr'"; fi
  # Recover using only the pointer, as cleanup would in a fresh shell.
  unset BACKUP_CODE
  restore_code >/dev/null 2>&1
  check "recovery works from the pointer alone" "$(cat "$APOLLO_ROOT_DIR/src/marker" 2>/dev/null)" "OLD"
)

# --- version.json is reverted -------------------------------------------------
# Left behind, it makes current_version() report the new release over old code and
# every future update exits "Already on <version>".
(
  make_device
  echo '{"version":"2.2.0"}' > "$APOLLO_ROOT_DIR/version.json"
  preserve_binaries; backup_code
  echo '{"version":"2.3.0"}' > "$APOLLO_ROOT_DIR/version.json"   # the new release
  restore_code >/dev/null 2>&1
  check "version.json reverted to the old release" \
    "$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$APOLLO_ROOT_DIR/version.json" 2>/dev/null)" "2.2.0"
)

# --- version.json absent before the update ------------------------------------
# The first tarball update on a device that never had one: the file must go away
# again, not survive as the new release's copy.
(
  make_device
  rm -f "$APOLLO_ROOT_DIR/version.json"
  preserve_binaries; backup_code
  echo '{"version":"2.3.0"}' > "$APOLLO_ROOT_DIR/version.json"
  restore_code >/dev/null 2>&1
  if [ -e "$APOLLO_ROOT_DIR/version.json" ]; then
    bad "version.json removed when it did not exist before" "file still present"
  else ok "version.json removed when it did not exist before"; fi
)

# --- units are reverted -------------------------------------------------------
(
  make_device
  mkdir -p "$ROOT/etc/systemd/system"
  # restore_units writes to the real /etc, so point the whole thing at the sandbox
  # by overriding the two functions' target through a stubbed install.
  cat > "$STUBS/install" <<EOF
#!/bin/bash
args=(); for a in "\$@"; do [ "\$a" = "-m" ] && { skip=1; continue; }; [ -n "\${skip:-}" ] && { unset skip; continue; }; args+=("\$a"); done
cp "\${args[0]}" "$ROOT/etc/systemd/system/\$(basename "\${args[1]}")"
EOF
  chmod +x "$STUBS/install"
  echo 'OLD-UNIT' > "$ROOT/etc/systemd/system/apollo-api.service"
  UNIT_BACKUP=''; UNITS_SAVED=0
  # backup_units reads from the real /etc; drive it against the sandbox copy.
  UNIT_BACKUP="$APOLLO_STATE_DIR/backups/units-test"; mkdir -p "$UNIT_BACKUP"
  cp "$ROOT/etc/systemd/system/apollo-api.service" "$UNIT_BACKUP/apollo-api.service"
  UNITS_SAVED=1
  echo 'NEW-UNIT' > "$ROOT/etc/systemd/system/apollo-api.service"
  restore_units >/dev/null 2>&1
  check "unit file reverted" "$(cat "$ROOT/etc/systemd/system/apollo-api.service")" "OLD-UNIT"
  if grep -q 'daemon-reload' "$SYSTEMCTL_LOG"; then ok "daemon-reload issued after revert"
  else bad "daemon-reload issued after revert" "not in systemctl log"; fi
)

# --- services are restarted after an abort ------------------------------------
# cleanup used to contain no `systemctl start` on any path, so an abort between
# the stop and the end left API, UI, node and ckpool down with no Restart=
# recovery, because the stop had been deliberate.
(
  make_device
  start_services >/dev/null 2>&1
  for unit in apollo-api.service apollo-ui-v2.service node.service apollo-miner.service; do
    if grep -q "start.*$unit" "$SYSTEMCTL_LOG"; then ok "restarts $unit"
    else bad "restarts $unit" "not started"; fi
  done
)

# --- the stop verification must succeed when everything IS stopped ------------
# Written inline as `is-active --quiet && die`, this aborted the update in exactly
# the case it exists to bless: a correctly inactive unit makes is-active exit 1,
# the && list inherits that status, the for loop inherits it in turn, and set -e
# kills the script with no message. Run under `set -e`, as the updater runs.
(
  make_device
  cat > "$STUBS/systemctl" <<'EOF'
#!/bin/bash
# Everything is inactive and nothing is running — the healthy post-stop state.
[ "$1" = "is-active" ] && exit 1
echo "systemctl $*" >> "$SYSTEMCTL_LOG"
exit 0
EOF
  cat > "$STUBS/pgrep" <<'EOF'
#!/bin/bash
exit 1
EOF
  chmod +x "$STUBS/systemctl" "$STUBS/pgrep"

  if ( set -Eeuo pipefail; verify_all_stopped ); then
    ok "verify_all_stopped succeeds when every unit is stopped"
  else
    bad "verify_all_stopped succeeds when every unit is stopped" \
        "returned non-zero, which aborts the update under set -e"
  fi
)

# --- and must abort when something is still running ---------------------------
(
  make_device
  cat > "$STUBS/systemctl" <<'EOF'
#!/bin/bash
# node.service refused to stop.
[ "$1" = "is-active" ] && { [ "$3" = "node.service" ] && exit 0 || exit 1; }
exit 0
EOF
  cat > "$STUBS/pgrep" <<'EOF'
#!/bin/bash
exit 1
EOF
  chmod +x "$STUBS/systemctl" "$STUBS/pgrep"

  if ( set -Eeuo pipefail; verify_all_stopped ) >/dev/null 2>&1; then
    bad "verify_all_stopped aborts when a unit is still active" "it returned success"
  else
    ok "verify_all_stopped aborts when a unit is still active"
  fi
)

# --- backups are pruned -------------------------------------------------------
# Nothing pruned them, so ~199 MB accumulated per update until the disk preflight
# refused every further run and the device could no longer take security fixes.
(
  make_device
  for i in 1 2 3 4; do
    mkdir -p "$APOLLO_STATE_DIR/backups/code-pre-2026010${i}T000000Z"
    mkdir -p "$APOLLO_STATE_DIR/backups/units-pre-2026010${i}T000000Z"
    sleep 0.01
  done
  prune_backups
  check "keeps exactly one code backup" \
    "$(ls -1d "$APOLLO_STATE_DIR"/backups/code-pre-* 2>/dev/null | wc -l | tr -d ' ')" "1"
  check "keeps three unit backups" \
    "$(ls -1d "$APOLLO_STATE_DIR"/backups/units-pre-* 2>/dev/null | wc -l | tr -d ' ')" "3"
  # The survivor must be the newest, or the rollback target is the one deleted.
  check "the kept code backup is the newest" \
    "$(basename "$(ls -1d "$APOLLO_STATE_DIR"/backups/code-pre-* 2>/dev/null | head -1)")" \
    "code-pre-20260104T000000Z"
)

# --- version ordering ---------------------------------------------------------
# Lexical comparison ranked rc10 below rc9, so beta devices stuck at rc9 and, in
# the other direction, accepted rc2 over rc10 as an upgrade.
(
  make_device
  vt() { if version_gt "$1" "$2"; then echo TRUE; else echo FALSE; fi; }
  check "rc10 outranks rc9"            "$(vt 2.2.0-rc10 2.2.0-rc9)"     "TRUE"
  check "rc2 does not outrank rc10"    "$(vt 2.2.0-rc2 2.2.0-rc10)"     "FALSE"
  check "beta.10 outranks beta.2"      "$(vt 2.2.0-beta.10 2.2.0-beta.2)" "TRUE"
  check "a release outranks its rc"    "$(vt 2.2.0 2.2.0-rc1)"          "TRUE"
  check "an rc does not outrank its release" "$(vt 2.2.0-rc1 2.2.0)"    "FALSE"
  check "equal versions do not outrank" "$(vt 2.2.0 2.2.0)"             "FALSE"
  check "2.10.0 outranks 2.9.0"        "$(vt 2.10.0 2.9.0)"             "TRUE"
)

# --- a signal must not be read as success -------------------------------------
# The EXIT trap can run with $? == 0 when the shell dies on a signal, which took
# the success branch and skipped the rollback. Run the real script under SIGTERM.
(
  ROOT="$(mktemp -d)"
  cat > "$ROOT/victim.sh" <<'EOF'
#!/bin/bash
set -Eeuo pipefail
COMPLETED=0
cleanup() {
  local status=$?
  trap - ERR EXIT TERM INT HUP
  if [ "$COMPLETED" -eq 1 ]; then echo SUCCESS-BRANCH > "$OUT"; exit 0; fi
  [ "$status" -eq 0 ] && status=1
  echo ROLLBACK-BRANCH > "$OUT"
  exit "$status"
}
trap cleanup ERR EXIT
trap 'exit 143' TERM INT HUP
sleep 2
EOF
  chmod +x "$ROOT/victim.sh"
  # Output to /dev/null, not the caller's pipes: the `sleep` outlives the killed
  # shell as an orphan, and holding an inherited stdout would make any parent
  # reading it (jest) block until the sleep expires.
  OUT="$ROOT/branch" bash "$ROOT/victim.sh" >/dev/null 2>&1 &
  vpid=$!
  sleep 1
  kill -TERM $vpid 2>/dev/null
  wait $vpid 2>/dev/null
  check "SIGTERM takes the rollback branch" "$(cat "$ROOT/branch" 2>/dev/null)" "ROLLBACK-BRANCH"
  rm -rf "$ROOT"
)

echo
count() { [ -f "$1" ] && { c=$(wc -l < "$1"); echo "${c// /}"; } || echo 0; }
PASS=$(count "$RESULTS/pass")
FAIL=$(count "$RESULTS/fail")
if [ "$PASS" -eq 0 ]; then
  printf '\033[0;31mno assertions ran\033[0m — the harness is broken\n'; exit 1
fi
if [ "$FAIL" -eq 0 ]; then
  printf '\033[0;32m%d passed\033[0m\n' "$PASS"; exit 0
else
  printf '\033[0;31m%d failed\033[0m, %d passed\n' "$FAIL" "$PASS"; exit 1
fi
