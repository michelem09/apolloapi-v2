#!/bin/bash
# Installs what backend/update needs in order to verify a release: jq, zstd and
# cosign.
#
# None of them were installed by anything in this repo — not install-v2, not
# image_install — so every fielded device failed the updater's dependency gate
# within a second and the OTA channel was inert fleet-wide, with each device
# needing exactly the manual SSH the mechanism exists to avoid.
#
# jq and zstd come from Debian. cosign is not in the Debian archive, so it is
# fetched from the sigstore release and checked against a pinned sha256. That pin
# is the trust root for every signature verification afterwards: nothing else
# vouches for this binary, so it is deliberate and must be bumped by hand,
# together with the version the release workflow signs with.
set -Eeuo pipefail

COSIGN_VERSION='v2.5.2'
COSIGN_SHA256_ARM64='2cbcea1873ad76274c3f241ef175d204654e3aac3e73e6ec4504e5227015cb0a'
COSIGN_SHA256_AMD64='bcfeae05557a9f313ee4392d2f335d0ff69ebbfd232019e3736fb04999fe1734'
COSIGN_BIN='/usr/local/bin/cosign'

log()  { echo "[update-deps] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || { echo "[update-deps] must run as root" >&2; exit 1; }

missing=''
# sqlite3 too: backend/update hard-requires the CLI (it reads settings and
# service_status through it) and self-provisions by running THIS script, so
# leaving it out means the updater can die at its own dependency gate on an
# image that happens not to ship it, with nothing left to install it. Fielded
# 2.1.x images carry it because the old update_system used it directly, but that
# is an accident of history, not a guarantee.
for p in jq zstd sqlite3; do have "$p" || missing="$missing $p"; done
if [ -n "$missing" ]; then
  log "installing from apt:$missing"
  apt-get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get -y -q install $missing
fi

if have cosign; then
  log "cosign already installed: $(command -v cosign)"
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) asset='cosign-linux-arm64'; want="$COSIGN_SHA256_ARM64" ;;
  x86_64|amd64)  asset='cosign-linux-amd64'; want="$COSIGN_SHA256_AMD64" ;;
  *) echo "[update-deps] no pinned cosign for $(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

log "downloading cosign $COSIGN_VERSION ($asset)"
curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 \
  -o "$tmp/cosign" \
  --url "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${asset}"

got="$(sha256sum "$tmp/cosign" | cut -d' ' -f1)"
if [ "$got" != "$want" ]; then
  echo "[update-deps] cosign checksum mismatch (expected $want, got $got)" >&2
  exit 1
fi

install -m 755 "$tmp/cosign" "$COSIGN_BIN"
log "installed $COSIGN_BIN"
