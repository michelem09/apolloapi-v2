#!/bin/bash
# Runs inside Dockerfile.ota-test (linux/arm64). Models a bootstrapped fork dev
# device and applies the actual published artifact, with real cosign
# verification. Also proves the fork/official identity split is enforced by
# crypto: the trusted identity comes from a root-only file, and swapping it to
# the official identity makes the fork artifact fail. Requires network.
set -uo pipefail

OWNER="${FORK_OWNER:-michelem09}"
CLI=/opt/apolloapi/bin/apollo-update
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }

WORK=/work; mkdir -p "$WORK/root/releases/2.1.0" "$WORK/state/db" "$WORK/systemd" "$WORK/etc"
# a bootstrapped device: current is a symlink to an installed (older) release
echo '{"version":"2.1.0"}' > "$WORK/root/releases/2.1.0/version.json"
ln -sfn "$WORK/root/releases/2.1.0" "$WORK/root/current"

# WHERE to fetch: app-writable source config → the fork's dev channel.
cat > "$WORK/state/source.conf" <<EOF
APOLLO_GIT_BASE="https://github.com/${OWNER}"
APOLLO_CHANNEL="dev"
EOF
# WHICH identity to trust: root-only file, pinned to the fork's release workflow.
cat > "$WORK/etc/update.conf" <<EOF
APOLLO_TRUST_IDENTITY="^https://github\\.com/${OWNER}/apolloapi-v2/\\.github/workflows/release\\.yml@refs/tags/v"
EOF

# systemctl is stubbed (no init in a container); health via file:// (no live API).
export APOLLO_DIR=/opt/apolloapi
export APOLLO_ROOT="$WORK/root" APOLLO_STATE_DIR="$WORK/state"
export APOLLO_SOURCE_CONF="$WORK/state/source.conf" APOLLO_TRUST_CONF="$WORK/etc/update.conf"
export APOLLO_SYSTEMD_DIR="$WORK/systemd"
export APOLLO_HEALTH_URL="file://$WORK/health" APOLLO_UI_HEALTH_URL="file://$WORK/health"; echo ok > "$WORK/health"
export OTA_CALLS="$WORK/calls"; : > "$OTA_CALLS"
cur() { basename "$(readlink "$APOLLO_ROOT/current" 2>/dev/null || echo none)"; }

echo "apollo-update — tier 2 (real artifact, real cosign) — owner ${OWNER}"

echo "== check reaches the real channel manifest =="
LATEST="$("$CLI" check | jq -r '.latest')"
[ -n "$LATEST" ] && [ "$LATEST" != "null" ] && ok "check resolved latest = $LATEST" || bad "check could not resolve latest"

echo "== apply the real signed artifact (cosign verifies against the root-only trust) =="
if "$CLI" apply latest; then ok "apply succeeded"; else bad "apply failed"; fi
[ "$(cur)" = "$LATEST" ] && ok "current is now $LATEST" || bad "current is $(cur), expected $LATEST"
[ -f "$APOLLO_ROOT/current/version.json" ] && ok "release tree extracted" || bad "release tree missing"
[ -f "$APOLLO_ROOT/current/apolloui-v2/.next/standalone/server.js" ] \
  && ok "standalone UI present in the extracted release" \
  || bad "standalone server.js missing from the artifact"
grep -q "apollo-api" "$OTA_CALLS" && ok "services were restarted" || bad "services not restarted"

echo "== security: the same artifact must NOT verify under the official identity =="
rm -rf "$WORK/root/releases/"*/ "$WORK/root/previous"
mkdir -p "$WORK/root/releases/2.1.0"; echo '{"version":"2.1.0"}' > "$WORK/root/releases/2.1.0/version.json"
ln -sfn "$WORK/root/releases/2.1.0" "$WORK/root/current"
: > "$OTA_CALLS"
if APOLLO_TRUST_IDENTITY='^https://github\.com/jstefanop/apolloapi-v2/\.github/workflows/release\.yml@refs/tags/v' \
     "$CLI" apply latest >/dev/null 2>&1; then
  bad "fork artifact wrongly accepted under the official identity"
else
  ok "fork artifact rejected under the official identity"
fi
[ "$(cur)" = "2.1.0" ] && ok "nothing activated on rejected signature" || bad "something activated despite rejection"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
