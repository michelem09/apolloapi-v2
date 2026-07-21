#!/bin/bash
# bootstrap.sh — one-shot migration of a device from the legacy git-checkout
# layout to the release layout the OTA updater needs:
#
#   /opt/apolloapi/releases/<version>/   the code (this tarball)
#   /opt/apolloapi/current  -> releases/<version>
#   /opt/apolloapi/previous -> releases/<old>        (created by later updates)
#   /opt/apolloapi/.env                              stays put (device state)
#
# It ships INSIDE the release tarball and runs from the extracted directory, so
# "the release" is simply the directory this script lives in. Runtime state (DB,
# node/ckpool config, miner runtime) already lives in /var/lib/apollo from the
# bootstrap work, so this only moves code.
#
# Idempotent and resumable: each step records a marker, so a power loss resumes
# from where it stopped. Testable off-device via the same indirections the
# updater uses (APOLLO_DIR, APOLLO_STATE_DIR, APOLLO_SYSTEMCTL, APOLLO_NODE).
set -Eeuo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"          # the extracted release = this dir
APOLLO_DIR="${APOLLO_DIR:-/opt/apolloapi}"
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
SYSTEMCTL="${APOLLO_SYSTEMCTL:-systemctl}"
NODE="${APOLLO_NODE:-/usr/local/nvm/versions/node/v21.6.2/bin/node}"
CLI_DEST="${APOLLO_CLI_DEST:-/usr/local/bin/apollo-update}"
SYSTEMD_DIR="${APOLLO_SYSTEMD_DIR:-/etc/systemd/system}"
HEALTH_URL="${APOLLO_HEALTH_URL:-http://localhost:5000/health}"
HEALTH_TIMEOUT="${APOLLO_HEALTH_TIMEOUT:-90}"

RELEASES="$APOLLO_DIR/releases"
CURRENT_LINK="$APOLLO_DIR/current"
MARK="$STATE_DIR/migration.state"
UNITS="apollo-bootstrap apollo-api apollo-ui-v2 node ckpool apollo-miner"

log()  { printf '[bootstrap] %s\n' "$*" >&2; }
die()  { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
done_step() { [ -f "$MARK" ] && grep -qxF "$1" "$MARK"; }
mark()      { echo "$1" >> "$MARK"; }

VERSION="$(jq -r '.version' "$SRC/version.json" 2>/dev/null || true)"
[ -n "$VERSION" ] && [ "$VERSION" != "null" ] || die "cannot read version from $SRC/version.json"
DEST="$RELEASES/$VERSION"

# --- 1. preflight ----------------------------------------------------------
preflight() {
  done_step preflight && { log "preflight already done"; return; }
  for t in jq curl tar; do have "$t" || die "missing dependency: $t"; done
  [ -x "$NODE" ] || die "node interpreter not found at $NODE"
  local major; major="$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  [ "$major" -ge 21 ] || die "node >= 21 required, found $major — re-flash the SD image"
  # /tmp/update_progress present means the legacy updater is mid-run; that is us.
  [ -w "$(dirname "$APOLLO_DIR")" ] || die "no write access to $(dirname "$APOLLO_DIR")"
  mkdir -p "$STATE_DIR"
  mark preflight
}

# --- 2. back up current units (rollback target) ----------------------------
backup_units() {
  done_step backup_units && return
  local bdir="$STATE_DIR/backups/units-pre-$VERSION"
  mkdir -p "$bdir"
  for u in $UNITS; do
    [ -f "$SYSTEMD_DIR/$u.service" ] && cp "$SYSTEMD_DIR/$u.service" "$bdir/" || true
  done
  log "units backed up to $bdir"
  mark backup_units
}

# --- 3. install this release under releases/<version> ----------------------
install_release() {
  done_step install_release && { log "release $VERSION already installed"; return; }
  mkdir -p "$RELEASES"
  local partial="$RELEASES/${VERSION}.partial"
  rm -rf "$partial"; mkdir -p "$partial"
  # Copy everything except this script and the state marker; the release should
  # not carry its own migrator.
  ( cd "$SRC" && tar --exclude=./bootstrap.sh -cf - . ) | tar -C "$partial" -xf -
  rm -rf "$DEST"; mv "$partial" "$DEST"
  log "release installed at $DEST"
  mark install_release
}

# --- 4. activate: current -> releases/<version> ----------------------------
activate() {
  # ln -sfn replaces a symlink-to-dir correctly; if current is still the legacy
  # checkout *directory*, refuse rather than nest the link inside it.
  if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
    die "$CURRENT_LINK exists and is not a symlink — refusing to clobber the checkout"
  fi
  ln -sfn "$DEST" "$CURRENT_LINK"
  log "current -> $(readlink "$CURRENT_LINK")"
}

# Move the UI env (NEXTAUTH_SECRET etc.) out of the checkout to a device-stable
# path, so apollo-ui-v2.service can inject it via EnvironmentFile and it survives
# updates. set_UI_mode.sh appends the NEXT_PUBLIC_* flags to this same file.
migrate_ui_env() {
  done_step migrate_ui_env && return
  local dst="$APOLLO_DIR/apolloui-v2.env" legacy="$APOLLO_DIR/apolloui-v2/.env"
  if [ ! -f "$dst" ] && [ -f "$legacy" ]; then
    cp "$legacy" "$dst"; chown --reference="$legacy" "$dst" 2>/dev/null || true
    log "UI env migrated to $dst"
  fi
  mark migrate_ui_env
}

# --- 5. install the units (they reference current/) + CLI + rc.local -------
install_units_and_cli() {
  for u in $UNITS; do
    [ -f "$DEST/backend/systemd/$u.service" ] \
      && install -m 644 "$DEST/backend/systemd/$u.service" "$SYSTEMD_DIR/$u.service"
  done
  install -m 755 "$DEST/bin/apollo-update" "$CLI_DEST"
  [ -f "$DEST/backend/rc.local" ] && install -m 755 "$DEST/backend/rc.local" "${APOLLO_RC_LOCAL:-/etc/rc.local}"
  $SYSTEMCTL daemon-reload
  log "units, CLI and rc.local installed"
}

# --- 6. restart + health ---------------------------------------------------
restart_and_probe() {
  $SYSTEMCTL restart apollo-api apollo-ui-v2 || die "apollo-api/ui failed to restart"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1 && { log "healthy on $VERSION"; return 0; }
    sleep 3
  done
  die "health check failed after migration"
}

main() {
  log "migrating device to $VERSION (release layout)"
  preflight
  backup_units
  install_release
  migrate_ui_env
  activate
  install_units_and_cli
  # node/ckpool/miner follow current/ now; restart them so they pick up the new
  # paths, then verify the API.
  $SYSTEMCTL restart node ckpool apollo-miner || log "warning: a mining service did not restart cleanly"
  restart_and_probe
  mark complete
  log "migration to $VERSION complete"
  log "legacy checkout files under $APOLLO_DIR (src/, node_modules/, .next, .git) can be pruned once verified"
}

main "$@"
