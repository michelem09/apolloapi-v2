#!/bin/bash
# Tier-1 tests for bin/apollo-update: the update mechanism with systemctl, cosign
# and the network stubbed. Pure filesystem + real tar/zstd/sha256, so it runs
# anywhere — macOS included — for a fast loop. Real signature verification and
# real service restarts are covered by the Docker tier and by apollo2.
#
#   bash tests/ota/apollo-update.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/bin/apollo-update"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1 (want '$3', got '$2')"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ota-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- stubs on PATH ---------------------------------------------------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/systemctl" <<'EOF'
#!/bin/bash
printf '%s\n' "restart $*" >> "$OTA_CALLS"
EOF
cat > "$WORK/bin/cosign" <<'EOF'
#!/bin/bash
# Fake verifier: pass unless the fixture asked us to fail.
[ "${OTA_COSIGN_FAIL:-0}" = "1" ] && exit 1 || exit 0
EOF
chmod +x "$WORK/bin/systemctl" "$WORK/bin/cosign"

# --- a served release + manifest ------------------------------------------
build_release() {  # $1 version
  local v="$1"; local b="$WORK/build-$v"
  mkdir -p "$b/apolloui-v2"
  printf '{"version":"%s"}\n' "$v" > "$b/version.json"
  echo "server $v" > "$b/apolloui-v2/server.js"
  ( cd "$b" && tar --zstd -cf "$WORK/serve/apollo-$v-aarch64.tar.zst" . )
}
manifest() {  # $1 version  $2 sha-override(optional)
  local v="$1" tb="$WORK/serve/apollo-$1-aarch64.tar.zst" sha
  sha="${2:-$(sha256sum "$tb" | cut -d' ' -f1)}"
  echo sig  > "$tb.sig"; echo cert > "$tb.pem"
  cat > "$WORK/serve/$v.json" <<EOF
{"version":"$v","channel":"dev","sha256":"$sha",
 "url":"file://$tb","signature_url":"file://$tb.sig","certificate_url":"file://$tb.pem",
 "summary":"Release $v","notes_url":"file:///dev/null"}
EOF
}

mkdir -p "$WORK/serve" "$WORK/root/releases" "$WORK/state/db"
build_release 2.2.0
mkdir -p "$WORK/root/releases/2.2.0"; echo '{"version":"2.2.0"}' > "$WORK/root/releases/2.2.0/version.json"
ln -sfn "$WORK/root/releases/2.2.0" "$WORK/root/current"
build_release 2.2.1; manifest 2.2.1

export OTA_CALLS="$WORK/calls"; : > "$OTA_CALLS"
export PATH="$WORK/bin:$PATH"
export APOLLO_ROOT="$WORK/root" APOLLO_STATE_DIR="$WORK/state" APOLLO_DIR="$WORK/none"
export APOLLO_SYSTEMCTL=systemctl APOLLO_TRUST_IDENTITY='.*' APOLLO_SKIP_MIGRATIONS=1
export APOLLO_CHANNEL_URL="file://$WORK/serve/2.2.1.json"
export APOLLO_HEALTH_URL="file://$WORK/health"; echo ok > "$WORK/health"
cur() { basename "$(readlink "$APOLLO_ROOT/current")"; }
reset() { rm -rf "$APOLLO_ROOT/releases/2.2.1" "$APOLLO_ROOT/previous"; ln -sfn "$APOLLO_ROOT/releases/2.2.0" "$APOLLO_ROOT/current"; : > "$OTA_CALLS"; }

echo "apollo-update — tier 1"

# read-only commands
eq "current reports the active release" "$("$CLI" current)" "2.2.0"
eq "check sees a newer version" "$("$CLI" check | jq -r '.updateAvailable')" "true"
eq "check carries the summary" "$("$CLI" check | jq -r '.summary')" "Release 2.2.1"

# happy path
reset; "$CLI" apply latest >/dev/null 2>&1
eq "apply activates the new release" "$(cur)" "2.2.1"
eq "apply records previous" "$(basename "$(readlink "$APOLLO_ROOT/previous")")" "2.2.0"
grep -q "restart apollo-api" "$OTA_CALLS" && ok "apply restarts services" || bad "apply restarts services"

# rollback
"$CLI" rollback >/dev/null 2>&1
eq "rollback returns to previous" "$(cur)" "2.2.0"

# integrity gate
reset; manifest 2.2.1 "deadbeef"
out="$("$CLI" apply latest 2>&1)"; rc=$?
[ $rc -ne 0 ] && ok "sha mismatch fails" || bad "sha mismatch fails"
grep -q "sha256 mismatch" <<<"$out" && ok "sha mismatch is reported" || bad "sha mismatch is reported"
eq "sha mismatch does not activate" "$(cur)" "2.2.0"
manifest 2.2.1   # restore good sha

# signature gate
reset; OTA_COSIGN_FAIL=1 "$CLI" apply latest >/dev/null 2>&1
eq "bad signature does not activate" "$(cur)" "2.2.0"

# health-failure auto-rollback
reset
APOLLO_HEALTH_URL="file://$WORK/absent" APOLLO_HEALTH_TIMEOUT=2 "$CLI" apply latest >/dev/null 2>&1
eq "failed health check auto-rolls-back" "$(cur)" "2.2.0"
eq "auto-rollback restarts twice" "$(grep -c restart "$OTA_CALLS")" "2"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
