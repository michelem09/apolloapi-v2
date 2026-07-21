#!/bin/bash
# Tier-1 tests for bootstrap.sh: the one-shot migration onto the release layout,
# with systemctl/node/health stubbed. Structural only (file moves, symlink,
# markers); the real service restart + health are covered on apollo2.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# stubs
mkdir -p "$WORK/bin"
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >> "$BOOT_CALLS"\n' > "$WORK/bin/systemctl"
printf '#!/bin/bash\n[ "$1" = "-e" ] && { printf 21; exit 0; }\n' > "$WORK/bin/node"
chmod +x "$WORK/bin/systemctl" "$WORK/bin/node"
export BOOT_CALLS="$WORK/calls"; : > "$BOOT_CALLS"
echo ok > "$WORK/health"

# a fake extracted release
SRC="$WORK/extracted"; mkdir -p "$SRC/backend/systemd" "$SRC/bin" "$SRC/src"
echo '{"version":"9.9.9"}' > "$SRC/version.json"
for u in apollo-bootstrap apollo-api apollo-ui-v2 node ckpool apollo-miner; do
  echo "[Unit]" > "$SRC/backend/systemd/$u.service"
done
echo '#!/bin/bash' > "$SRC/bin/apollo-update"; chmod +x "$SRC/bin/apollo-update"
echo "code" > "$SRC/src/init.js"
echo '#!/bin/sh' > "$SRC/backend/rc.local"
cp "$ROOT/bootstrap.sh" "$SRC/bootstrap.sh"

run_bootstrap() {  # $1 = APOLLO_DIR
  APOLLO_DIR="$1" APOLLO_STATE_DIR="$WORK/state" \
  APOLLO_SYSTEMCTL="$WORK/bin/systemctl" APOLLO_NODE="$WORK/bin/node" \
  APOLLO_CLI_DEST="$WORK/bin/apollo-update-installed" APOLLO_SYSTEMD_DIR="$WORK/systemd" \
  APOLLO_RC_LOCAL="$WORK/rc.local" APOLLO_HEALTH_URL="file://$WORK/health" \
  bash "$SRC/bootstrap.sh" >>"$WORK/log" 2>&1
}

echo "bootstrap.sh — tier 1"

# happy path onto a fresh device (no current yet), with a legacy UI .env present
mkdir -p "$WORK/systemd" "$WORK/opt/apolloui-v2"
printf 'NEXTAUTH_SECRET="s3cr3t"\n' > "$WORK/opt/apolloui-v2/.env"
run_bootstrap "$WORK/opt"; rc=$?
[ $rc -eq 0 ] && ok "migration succeeds" || bad "migration failed (rc=$rc)"
[ "$(readlink "$WORK/opt/current")" = "$WORK/opt/releases/9.9.9" ] && ok "current points at the release" || bad "current symlink wrong"
[ -f "$WORK/opt/releases/9.9.9/src/init.js" ] && ok "code is under releases/<version>" || bad "code not installed"
[ ! -f "$WORK/opt/releases/9.9.9/bootstrap.sh" ] && ok "the release does not carry the migrator" || bad "bootstrap.sh leaked into the release"
[ "$(ls "$WORK/systemd" | wc -l | tr -d ' ')" = "6" ] && ok "all units installed" || bad "units missing"
[ -x "$WORK/bin/apollo-update-installed" ] && ok "CLI installed" || bad "CLI not installed"
grep -q "daemon-reload" "$BOOT_CALLS" && ok "daemon-reload was run" || bad "no daemon-reload"
grep -qxF complete "$WORK/state/migration.state" && ok "completion marker written" || bad "no completion marker"
[ -x "$WORK/rc.local" ] && ok "rc.local installed" || bad "rc.local not installed"
grep -q 's3cr3t' "$WORK/opt/apolloui-v2.env" 2>/dev/null \
  && ok "UI env migrated to the device-stable path" || bad "UI env not migrated"

# idempotent: a second run must not rebuild the release
BEFORE="$(stat -c %Y "$WORK/opt/releases/9.9.9" 2>/dev/null || stat -f %m "$WORK/opt/releases/9.9.9")"
: > "$BOOT_CALLS"; run_bootstrap "$WORK/opt"
AFTER="$(stat -c %Y "$WORK/opt/releases/9.9.9" 2>/dev/null || stat -f %m "$WORK/opt/releases/9.9.9")"
[ "$BEFORE" = "$AFTER" ] && ok "re-run does not rebuild the release" || bad "re-run rebuilt the release"

# safety: refuse when current is a real directory (the untouched checkout)
mkdir -p "$WORK/opt2/current/src"; echo checkout > "$WORK/opt2/current/src/init.js"
run_bootstrap "$WORK/opt2"; rc=$?
[ $rc -ne 0 ] && ok "refuses to clobber a real current/ directory" || bad "did not refuse a real current/"
[ -f "$WORK/opt2/current/src/init.js" ] && ok "the checkout is left intact" || bad "the checkout was destroyed"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
