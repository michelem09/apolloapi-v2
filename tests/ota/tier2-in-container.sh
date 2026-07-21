#!/bin/bash
# Runs inside Dockerfile.ota-test (linux/arm64). Points the updater at the fork's
# real dev channel and applies the actual published artifact, with real cosign
# verification. Also proves the fork/official identity split is enforced by
# crypto, not convention. Requires network (GitHub Releases).
set -uo pipefail

OWNER="${FORK_OWNER:-michelem09}"
CLI=/opt/apolloapi/bin/apollo-update
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }

WORK=/work; mkdir -p "$WORK/root/releases" "$WORK/state/db"
cat > "$WORK/source.conf" <<EOF
APOLLO_GIT_BASE="https://github.com/${OWNER}"
APOLLO_CHANNEL="dev"
EOF

export APOLLO_DIR=/opt/apolloapi
export APOLLO_SOURCE_CONF="$WORK/source.conf"
export APOLLO_ROOT="$WORK/root" APOLLO_STATE_DIR="$WORK/state"
export APOLLO_HEALTH_URL="file://$WORK/health"; echo ok > "$WORK/health"
export APOLLO_SKIP_MIGRATIONS=1
export OTA_CALLS="$WORK/calls"; : > "$OTA_CALLS"
cur() { basename "$(readlink "$APOLLO_ROOT/current" 2>/dev/null || echo none)"; }

echo "apollo-update — tier 2 (real artifact, real cosign) — owner ${OWNER}"

echo "== check reaches the real channel manifest =="
LATEST="$("$CLI" check | jq -r '.latest')"
[ -n "$LATEST" ] && [ "$LATEST" != "null" ] && ok "check resolved latest = $LATEST" || bad "check could not resolve latest"

echo "== apply the real signed artifact (cosign verifies for real) =="
if "$CLI" apply latest; then ok "apply succeeded"; else bad "apply failed"; fi
[ "$(cur)" = "$LATEST" ] && ok "current is now $LATEST" || bad "current is $(cur), expected $LATEST"
[ -f "$APOLLO_ROOT/current/version.json" ] && ok "release tree extracted (version.json present)" || bad "release tree missing"
[ -f "$APOLLO_ROOT/current/apolloui-v2/.next/standalone/server.js" ] \
  && ok "standalone UI present in the extracted release" \
  || echo "  note: standalone server.js not in this artifact (expected until the standalone build ships in the release)"
grep -q "restart apollo-api" "$OTA_CALLS" && ok "services were restarted" || bad "services not restarted"

echo "== security: an artifact signed by the fork must NOT verify as official =="
rm -rf "$WORK/root/releases/"* "$WORK/root/current" "$WORK/root/previous"
: > "$OTA_CALLS"
# Trust the OFFICIAL identity while the artifact is fork-signed → cosign must reject.
if APOLLO_TRUST_IDENTITY='^https://github.com/jstefanop/apolloapi-v2/\.github/workflows/release\.yml@' \
     "$CLI" apply latest >/dev/null 2>&1; then
  bad "fork artifact wrongly accepted under the official identity"
else
  ok "fork artifact rejected under the official identity"
fi
[ "$(cur)" = "none" ] && ok "nothing activated on rejected signature" || bad "something activated despite rejection"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
