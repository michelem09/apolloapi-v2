#!/bin/bash
# Installs the Node.js runtime the Apollo services run on, into
# backend/runtime/node (or $1).
#
#   install-node-runtime.sh [dest]
#
# The runtime is a build artifact, not a file in the repo and not something the
# device downloads on its own: release.yml calls this before packaging, so every
# OTA artifact carries the exact Node its node_modules were built against, and the
# git-based install paths (image_install*, image_update*, install-v2,
# update_system) call it to get the same bits. The path has no version in it on
# purpose — units and scripts point at <dest>/bin/node and never change when the
# version does.
#
# One source for the version: .nvmrc at the repo root, which must be exact
# (26.12.0, not 26). One source for trust: node-runtime.sha256 next to this file,
# a verbatim subset of the official SHASUMS256.txt (signature checked when it was
# pinned, see the header there). Nothing is trusted that was fetched next to the
# tarball.
#
# Idempotent: nothing is touched when <dest>/bin/node and <dest>/bin/yarn already
# report the wanted versions. Atomic: the new tree is built in a sibling temp dir
# and renamed into place, so an interrupted run never leaves a half-extracted
# runtime that `bin/node` would then try to execute.
#
# Yarn classic is installed beside node because Node 25+ no longer ships corepack,
# and the git-based paths run `yarn install` / `yarn build`. It goes under the
# runtime prefix, never into a global location.
#
# Test seams (all optional): APOLLO_NODE_VERSION, APOLLO_NODE_PINS,
# APOLLO_NODE_MIRROR (an https URL, or a local directory), APOLLO_NODE_ARCH,
# APOLLO_YARN_MIRROR.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

YARN_VERSION='1.22.22'

PINS="${APOLLO_NODE_PINS:-$HERE/node-runtime.sha256}"
NODE_MIRROR="${APOLLO_NODE_MIRROR:-https://nodejs.org/dist}"
YARN_MIRROR="${APOLLO_YARN_MIRROR:-https://registry.npmjs.org/yarn/-}"
DEST="${1:-$REPO/backend/runtime/node}"

log() { echo "[node-runtime] $*"; }
die() { echo "[node-runtime] $*" >&2; exit 1; }

# https or a local directory, nothing else: a plain-http mirror would hand the
# bytes to anyone on the path, and the checksum would then be the only defence.
for m in "$NODE_MIRROR" "$YARN_MIRROR"; do
  case "$m" in
    /*|https://*) ;;
    *) die "refusing mirror '$m' — expected an https URL or a local directory" ;;
  esac
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1   # macOS: dev boxes and the test harness
  fi
}

VERSION="${APOLLO_NODE_VERSION:-}"
if [ -z "$VERSION" ]; then
  [ -r "$REPO/.nvmrc" ] || die "no .nvmrc at $REPO and APOLLO_NODE_VERSION is not set"
  VERSION="$(tr -d '[:space:]' < "$REPO/.nvmrc")"
fi
VERSION="${VERSION#v}"
# Exact only. "26" or "lts/*" would make the runtime depend on what nodejs.org
# serves today, which is precisely what a pinned checksum cannot describe.
printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die ".nvmrc must be an exact version like 26.12.0, got '$VERSION'"

case "${APOLLO_NODE_ARCH:-$(uname -m)}" in
  aarch64|arm64) ARCH='arm64' ;;
  x86_64|amd64)  ARCH='x64' ;;
  *) die "no Node runtime for $(uname -m)" ;;
esac

NODE_FILE="node-v${VERSION}-linux-${ARCH}.tar.xz"
YARN_FILE="yarn-${YARN_VERSION}.tgz"

pinned() {  # file name -> sha256 on stdout, empty when not pinned
  [ -r "$PINS" ] || die "checksum file $PINS is missing"
  awk -v f="$1" '$1 !~ /^#/ && $2 == f { print $1; exit }' "$PINS"
}

NODE_SHA="$(pinned "$NODE_FILE")"
YARN_SHA="$(pinned "$YARN_FILE")"
[ -n "$NODE_SHA" ] || die "$NODE_FILE has no pinned checksum in $PINS — pin it (see the header there) before bumping .nvmrc"
[ -n "$YARN_SHA" ] || die "$YARN_FILE has no pinned checksum in $PINS"

# Already there? Both versions, as reported by the binaries themselves.
if [ -x "$DEST/bin/node" ] && [ -x "$DEST/bin/yarn" ] \
   && [ "$("$DEST/bin/node" --version 2>/dev/null || true)" = "v$VERSION" ] \
   && [ "$(PATH="$DEST/bin:$PATH" "$DEST/bin/yarn" --version 2>/dev/null || true)" = "$YARN_VERSION" ]; then
  log "node v$VERSION and yarn $YARN_VERSION already installed in $DEST"
  exit 0
fi

PARENT="$(dirname "$DEST")"
mkdir -p "$PARENT"
# A killed run leaves its temp dir behind; nothing else would ever remove it.
rm -rf "$PARENT"/.node-runtime.* 2>/dev/null || true
TMP="$(mktemp -d "$PARENT/.node-runtime.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fetch() {  # url-or-path dest
  case "$1" in
    /*) cp "$1" "$2" ;;
    *) curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 600 -o "$2" --url "$1" ;;
  esac
}

verified() {  # file name expected-sha
  local got
  got="$(sha256_of "$1")"
  [ "$got" = "$3" ] || die "$2 checksum mismatch (expected $3, got $got) — refusing to install"
}

log "downloading node v$VERSION ($ARCH)"
fetch "$NODE_MIRROR/v$VERSION/$NODE_FILE" "$TMP/$NODE_FILE"
verified "$TMP/$NODE_FILE" "$NODE_FILE" "$NODE_SHA"

log "downloading yarn $YARN_VERSION"
fetch "$YARN_MIRROR/$YARN_FILE" "$TMP/$YARN_FILE"
verified "$TMP/$YARN_FILE" "$YARN_FILE" "$YARN_SHA"

# The official tarball is .xz. Debian/Ubuntu images normally have it, but a
# minimal one may not, and tar's own "xz: Cannot exec" says nothing useful. As root
# we install it the way install-update-deps.sh installs its tools; otherwise say so.
# (Detected from the file's magic number, so a test fixture in another format is
# not affected.)
if [ "$(od -An -tx1 -N6 "$TMP/$NODE_FILE" | tr -d ' \n')" = "fd377a585a00" ] && ! command -v xz >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
    log "installing xz-utils from apt"
    DEBIAN_FRONTEND=noninteractive apt-get -y -q install xz-utils >/dev/null \
      || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -q install xz-utils >/dev/null; } \
      || die "could not install xz-utils, which is needed to unpack the Node tarball"
  else
    die "xz is needed to unpack the Node tarball (apt-get install xz-utils)"
  fi
fi

NEW="$TMP/node"
mkdir -p "$NEW"
tar -C "$NEW" --strip-components=1 --no-same-owner -xf "$TMP/$NODE_FILE"

# Not needed to run anything: include/ is the C++ headers for node-gyp (64 MB, and
# sqlite3 ships a prebuilt binary; node-gyp fetches headers itself if it ever has
# to compile), share/ is man pages. Everything here is shipped inside every OTA
# artifact, so weight counts. LICENSE stays: the runtime is redistributed.
rm -rf "$NEW/include" "$NEW/share" "$NEW/CHANGELOG.md" "$NEW/README.md"

mkdir -p "$TMP/yarn" "$NEW/lib/node_modules/yarn"
tar -C "$TMP/yarn" --strip-components=1 --no-same-owner -xf "$TMP/$YARN_FILE"
cp -R "$TMP/yarn/." "$NEW/lib/node_modules/yarn/"
ln -s ../lib/node_modules/yarn/bin/yarn.js "$NEW/bin/yarn"
ln -s ../lib/node_modules/yarn/bin/yarn.js "$NEW/bin/yarnpkg"
chmod 755 "$NEW/lib/node_modules/yarn/bin/yarn.js"
# World-readable and traversable, so services running as futurebit can use a
# runtime that a root-run installer put there.
chmod -R a+rX "$NEW"

# Proof that what we are about to publish runs, before it replaces anything. Skipped
# only when the binary cannot execute here at all (an aarch64 runtime unpacked on a
# dev Mac): the checksum already vouched for the bytes.
if got="$("$NEW/bin/node" --version 2>/dev/null)"; then
  [ "$got" = "v$VERSION" ] || die "extracted node reports $got, expected v$VERSION"
fi

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  mv "$DEST" "$TMP/previous"
fi
if ! mv "$NEW" "$DEST"; then
  [ -e "$TMP/previous" ] && mv "$TMP/previous" "$DEST"
  die "could not move the runtime into place at $DEST"
fi
log "installed node v$VERSION + yarn $YARN_VERSION in $DEST"
