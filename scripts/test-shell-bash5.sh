#!/bin/bash
# Runs tests/*.test.sh under bash 5 (the device's bash is 5.2; macOS ships 3.2,
# which behaves differently around set -E and ERR traps in subshells).
# Needs Docker. The repo is mounted read-only. Not wired into CI.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec docker run --rm -v "$REPO:/repo:ro" -w /repo debian:bookworm bash -c '
    set -u
    echo "bash $BASH_VERSION"
    rc=0
    for t in tests/*.test.sh; do
        echo "== $t"
        bash "$t" || rc=1
    done
    exit $rc'
