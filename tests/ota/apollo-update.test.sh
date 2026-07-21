#!/bin/bash
# Tier-1 tests for bin/apollo-update: the update mechanism with systemctl, cosign
# and the network stubbed. Pure filesystem + real tar/zstd/sha256, so it runs
# anywhere — macOS included. Real signature verification and real service
# restarts are covered by the Docker tier and by apollo2.
#
# Assertions check exit status and output, not just side effects — the review
# found several bugs that a "did it change a file" test would miss.
#
#   bash tests/ota/apollo-update.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/bin/apollo-update"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1 (want '$3', got '$2')"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ota-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$WORK/bin"
cat > "$WORK/bin/systemctl" <<'EOF'
#!/bin/bash
printf '%s\n' "restart $*" >> "$OTA_CALLS"
EOF
cat > "$WORK/bin/cosign" <<'EOF'
#!/bin/bash
[ "${OTA_COSIGN_FAIL:-0}" = "1" ] && exit 1 || exit 0
EOF
chmod +x "$WORK/bin/systemctl" "$WORK/bin/cosign"

build_release() {  # $1 version
  local v="$1"; local b="$WORK/build-$v"
  mkdir -p "$b/backend/systemd"
  printf '{"version":"%s"}\n' "$v" > "$b/version.json"
  echo "[Unit]" > "$b/backend/systemd/apollo-api.service"
  ( cd "$b" && tar --zstd -cf "$WORK/serve/apollo-$v-aarch64.tar.zst" . )
}
manifest() {  # $1 manifest-version  $2 sha-override(optional)  $3 tarball-version(optional)
  local v="$1"; local tv="${3:-$1}"; local tb="$WORK/serve/apollo-$tv-aarch64.tar.zst"; local sha
  sha="${2:-$(sha256_of "$tb")}"
  echo sig > "$tb.sig"; echo cert > "$tb.pem"
  cat > "$WORK/serve/$v.json" <<EOF
{"version":"$v","channel":"dev","sha256":"$sha",
 "url":"file://$tb","signature_url":"file://$tb.sig","certificate_url":"file://$tb.pem",
 "summary":"Release $v","notes_url":"file:///dev/null","min_from_version":"2.0.0"}
EOF
}

mkdir -p "$WORK/serve" "$WORK/root/releases" "$WORK/state/db" "$WORK/systemd"
mkdir -p "$WORK/root/releases/2.2.0"; echo '{"version":"2.2.0"}' > "$WORK/root/releases/2.2.0/version.json"
ln -sfn "$WORK/root/releases/2.2.0" "$WORK/root/current"
build_release 2.2.1; manifest 2.2.1

export OTA_CALLS="$WORK/calls"; : > "$OTA_CALLS"
export PATH="$WORK/bin:$PATH"
export APOLLO_ROOT="$WORK/root" APOLLO_STATE_DIR="$WORK/state" APOLLO_DIR="$WORK/none"
export APOLLO_SYSTEMCTL=systemctl APOLLO_SYSTEMD_DIR="$WORK/systemd"
export APOLLO_TRUST_IDENTITY='.*'
export APOLLO_CHANNEL_URL="file://$WORK/serve/2.2.1.json"
export APOLLO_HEALTH_URL="file://$WORK/health" APOLLO_UI_HEALTH_URL="file://$WORK/health"; echo ok > "$WORK/health"
cur() { basename "$(readlink "$APOLLO_ROOT/current")"; }
reset() { rm -rf "$APOLLO_ROOT/releases/2.2.1" "$APOLLO_ROOT/previous"; ln -sfn "$APOLLO_ROOT/releases/2.2.0" "$APOLLO_ROOT/current"; : > "$OTA_CALLS"; }

echo "apollo-update — tier 1"

eq "current reports the active release" "$("$CLI" current)" "2.2.0"
eq "check sees a newer version" "$("$CLI" check | jq -r '.updateAvailable')" "true"
eq "check carries the summary" "$("$CLI" check | jq -r '.summary')" "Release 2.2.1"

# happy path
reset; out="$("$CLI" apply latest 2>/dev/null)"; rc=$?
eq "apply exits 0" "$rc" "0"
eq "apply prints the activated version" "$out" "2.2.1"
eq "apply activates the new release" "$(cur)" "2.2.1"
eq "apply records previous" "$(basename "$(readlink "$APOLLO_ROOT/previous")")" "2.2.0"
grep -q "apollo-api" "$OTA_CALLS" && ok "apply restarts the app services" || bad "apply restarts services"

"$CLI" rollback >/dev/null 2>&1
eq "rollback returns to previous" "$(cur)" "2.2.0"

# precondition: refuse when current is not a release symlink
reset; rm -f "$APOLLO_ROOT/current"; mkdir -p "$APOLLO_ROOT/current/src"
"$CLI" apply latest >/dev/null 2>&1; rc=$?
[ $rc -ne 0 ] && ok "refuses to apply on a non-release layout" || bad "applied on a non-release layout"
rm -rf "$APOLLO_ROOT/current"; ln -sfn "$APOLLO_ROOT/releases/2.2.0" "$APOLLO_ROOT/current"

# malicious version in the unsigned manifest is rejected before use
reset
cat > "$WORK/serve/evil.json" <<EOF
{"version":"../../../etc","sha256":"x","url":"file:///dev/null","signature_url":"file:///dev/null","certificate_url":"file:///dev/null"}
EOF
APOLLO_CHANNEL_URL="file://$WORK/serve/evil.json" "$CLI" apply latest >/dev/null 2>&1; rc=$?
[ $rc -ne 0 ] && ok "rejects a path-traversal version" || bad "accepted a path-traversal version"
eq "traversal version does not activate" "$(cur)" "2.2.0"

# downgrade refused
reset; build_release 2.1.0; manifest 2.1.0
APOLLO_CHANNEL_URL="file://$WORK/serve/2.1.0.json" "$CLI" apply latest >/dev/null 2>&1; rc=$?
[ $rc -ne 0 ] && ok "refuses a downgrade" || bad "allowed a downgrade"

# artifact whose version.json disagrees with the manifest is rejected
reset
cat > "$WORK/serve/lie.json" <<EOF
{"version":"2.2.5","channel":"dev","sha256":"$(sha256_of "$WORK/serve/apollo-2.2.1-aarch64.tar.zst")",
 "url":"file://$WORK/serve/apollo-2.2.1-aarch64.tar.zst","signature_url":"file://$WORK/serve/apollo-2.2.1-aarch64.tar.zst.sig",
 "certificate_url":"file://$WORK/serve/apollo-2.2.1-aarch64.tar.zst.pem","min_from_version":"2.0.0"}
EOF
APOLLO_CHANNEL_URL="file://$WORK/serve/lie.json" "$CLI" apply latest >/dev/null 2>&1; rc=$?
[ $rc -ne 0 ] && ok "rejects a manifest/artifact version mismatch" || bad "accepted a version mismatch"
eq "version mismatch does not activate" "$(cur)" "2.2.0"

# integrity gate
reset; manifest 2.2.1 "deadbeef"
out="$("$CLI" apply latest 2>&1)"; rc=$?
[ $rc -ne 0 ] && ok "sha mismatch fails" || bad "sha mismatch fails"
grep -q "sha256 mismatch" <<<"$out" && ok "sha mismatch is reported" || bad "sha mismatch is reported"
eq "sha mismatch does not activate" "$(cur)" "2.2.0"
manifest 2.2.1

# signature gate
reset; OTA_COSIGN_FAIL=1 "$CLI" apply latest >/dev/null 2>&1
eq "bad signature does not activate" "$(cur)" "2.2.0"

# health-failure auto-rollback
reset
APOLLO_HEALTH_URL="file://$WORK/absent" APOLLO_UI_HEALTH_URL="file://$WORK/absent" APOLLO_HEALTH_TIMEOUT=2 \
  "$CLI" apply latest >/dev/null 2>&1
eq "failed health check auto-rolls-back" "$(cur)" "2.2.0"
eq "auto-rollback restarts twice" "$(grep -c restart "$OTA_CALLS")" "2"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
