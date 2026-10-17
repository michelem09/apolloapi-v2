#!/bin/bash
# backend/utils/install-node-runtime.sh against fake tarballs.
#
# The script is the trust root for the Node binary every device executes, so the
# properties that matter are the refusals: a wrong checksum installs nothing and
# leaves nothing behind, and a failed upgrade leaves the previous runtime exactly
# as it was. The "good" cases prove the refusals are not simply a script that
# never installs.
#
# The fixtures are gzip tarballs named .tar.xz: the script extracts with a plain
# `tar -xf`, which detects the compression, and that keeps the suite runnable in
# images without xz (apollo-bashlab).
#
# Run: bash tests/node_runtime.test.sh   (also under bash 5: scripts/test-shell-bash5.sh)

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/backend/utils/install-node-runtime.sh"

pass=0
fail=0
check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass=$((pass + 1)); printf '  ok   %s\n' "$name"
    else
        fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$name" "$expected" "$actual"
    fi
}
exists() { [ -e "$1" ] && echo 1 || echo 0; }

sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

export COPYFILE_DISABLE=1   # bsdtar: no ._ files in the fixtures
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# make_fixture <node-version> — a mirror dir with a node tarball and a yarn tgz,
# and a pins file that lists them correctly.
make_fixture() {
    local v="$1" d="$tmp/fx-$1"
    local top="$tmp/build-$v/node-v$v-linux-arm64"
    mkdir -p "$top/bin" "$top/include" "$top/share/man" "$top/lib/node_modules/npm/bin" "$d/v$v"
    printf '#!/bin/sh\necho v%s\n' "$v" > "$top/bin/node"; chmod 755 "$top/bin/node"
    echo header > "$top/include/node.h"; echo man > "$top/share/man/node.1"
    echo license > "$top/LICENSE"; echo changes > "$top/CHANGELOG.md"
    echo npm > "$top/lib/node_modules/npm/bin/npm-cli.js"
    ln -s ../lib/node_modules/npm/bin/npm-cli.js "$top/bin/npm"
    tar -C "$tmp/build-$v" -czf "$d/v$v/node-v$v-linux-arm64.tar.xz" "node-v$v-linux-arm64"

    local y="$tmp/build-yarn-$v/package"
    mkdir -p "$y/bin"
    printf '#!/bin/sh\necho 1.22.22\n' > "$y/bin/yarn.js"   # the real one is not executable in the tarball
    chmod 644 "$y/bin/yarn.js"
    tar -C "$tmp/build-yarn-$v" -czf "$d/yarn-1.22.22.tgz" package

    {
        echo "# fixture pins"
        echo "$(sha_of "$d/v$v/node-v$v-linux-arm64.tar.xz")  node-v$v-linux-arm64.tar.xz"
        echo "$(sha_of "$d/yarn-1.22.22.tgz")  yarn-1.22.22.tgz"
    } > "$d/pins"
}

# run <version> <dest> [pins] [mirror] — exit status in $rc, output in $out
run() {
    local v="$1" dest="$2" pins="${3:-$tmp/fx-$1/pins}" mirror="${4:-$tmp/fx-$1}"
    out="$(APOLLO_NODE_VERSION="$v" APOLLO_NODE_ARCH=arm64 APOLLO_NODE_PINS="$pins" \
           APOLLO_NODE_MIRROR="$mirror" APOLLO_YARN_MIRROR="$mirror" \
           bash "$SCRIPT" "$dest" 2>&1)"
    rc=$?
}

make_fixture 9.9.9
make_fixture 9.9.8

# --- a correct checksum installs ------------------------------------------------
dest="$tmp/a/runtime/node"
run 9.9.9 "$dest"
check "correct checksum: exit 0"                  "0" "$rc"
check "…node is in place and reports its version" "v9.9.9" "$("$dest/bin/node" --version 2>/dev/null)"
check "…yarn is in place and runs from the prefix" "1.22.22" "$(PATH="$dest/bin:$PATH" "$dest/bin/yarn" --version 2>/dev/null)"
check "…yarn.js is executable"                    "1" "$( [ -x "$dest/bin/yarn" ] && echo 1 || echo 0 )"
check "…headers are pruned"                       "0" "$(exists "$dest/include")"
check "…man pages are pruned"                     "0" "$(exists "$dest/share")"
check "…the license stays"                        "1" "$(exists "$dest/LICENSE")"
check "…npm's symlink survives"                   "../lib/node_modules/npm/bin/npm-cli.js" "$(readlink "$dest/bin/npm")"
check "…no temp dir is left beside it"            "0" "$(ls -A "$tmp/a/runtime" | grep -c '^\.node-runtime')"

# --- idempotent -----------------------------------------------------------------
touch "$dest/SENTINEL"
run 9.9.9 "$dest"
check "second run: exit 0"                        "0" "$rc"
check "…says it is already installed"             "1" "$(printf '%s' "$out" | grep -c 'already installed')"
check "…and does not replace the tree"            "1" "$(exists "$dest/SENTINEL")"

# --- a wrong checksum is refused, and nothing is left ---------------------------
bad="$tmp/fx-9.9.9-badpins"
mkdir -p "$bad"
{
    echo "0000000000000000000000000000000000000000000000000000000000000000  node-v9.9.9-linux-arm64.tar.xz"
    grep 'yarn-' "$tmp/fx-9.9.9/pins"
} > "$bad/pins"
dest="$tmp/b/runtime/node"
run 9.9.9 "$dest" "$bad/pins"
check "wrong node checksum: exit non-zero"        "1" "$( [ "$rc" -ne 0 ] && echo 1 || echo 0 )"
check "…says checksum mismatch"                   "1" "$(printf '%s' "$out" | grep -c 'checksum mismatch')"
check "…no runtime dir is created"                "0" "$(exists "$dest")"
check "…no temp dir is left behind"               "0" "$(ls -A "$tmp/b/runtime" | wc -l | tr -d ' ')"

{
    grep 'node-v' "$tmp/fx-9.9.9/pins"
    echo "0000000000000000000000000000000000000000000000000000000000000000  yarn-1.22.22.tgz"
} > "$bad/pins-yarn"
dest="$tmp/b2/runtime/node"
run 9.9.9 "$dest" "$bad/pins-yarn"
check "wrong yarn checksum: exit non-zero"        "1" "$( [ "$rc" -ne 0 ] && echo 1 || echo 0 )"
check "…no runtime dir is created"                "0" "$(exists "$dest")"

# A tampered tarball with the genuine pins is the real attack: same name, other bytes.
tamper="$tmp/fx-tampered"; mkdir -p "$tamper/v9.9.9"
cp "$tmp/fx-9.9.9/yarn-1.22.22.tgz" "$tamper/"
echo "extra" | cat "$tmp/fx-9.9.9/v9.9.9/node-v9.9.9-linux-arm64.tar.xz" - > "$tamper/v9.9.9/node-v9.9.9-linux-arm64.tar.xz"
dest="$tmp/c/runtime/node"
run 9.9.9 "$dest" "$tmp/fx-9.9.9/pins" "$tamper"
check "tampered tarball, genuine pins: refused"   "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'checksum mismatch' && echo 1 || echo 0 )"
check "…nothing installed"                        "0" "$(exists "$dest")"

# --- a failed upgrade leaves the previous runtime untouched ---------------------
dest="$tmp/d/runtime/node"
run 9.9.8 "$dest"
touch "$dest/OLD_MARKER"
run 9.9.9 "$dest" "$bad/pins"
check "failed upgrade: exit non-zero"             "1" "$( [ "$rc" -ne 0 ] && echo 1 || echo 0 )"
check "…the old runtime still reports its version" "v9.9.8" "$("$dest/bin/node" --version 2>/dev/null)"
check "…and is the same tree"                     "1" "$(exists "$dest/OLD_MARKER")"
run 9.9.9 "$dest"
check "good upgrade replaces it"                  "v9.9.9" "$("$dest/bin/node" --version 2>/dev/null)"
check "…without keeping the old tree"             "0" "$(exists "$dest/OLD_MARKER")"
check "…or any temp dir"                          "0" "$(ls -A "$tmp/d/runtime" | grep -c '^\.node-runtime')"

# --- refusals that happen before any download -----------------------------------
dest="$tmp/e/runtime/node"
run 26 "$dest"
check "an inexact version is refused"             "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'exact version' && echo 1 || echo 0 )"
run 9.9.7 "$dest" "$tmp/fx-9.9.9/pins"
check "a version with no pinned checksum is refused" "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'no pinned checksum' && echo 1 || echo 0 )"
run 9.9.9 "$dest" "$tmp/fx-9.9.9/pins" "http://nodejs.org/dist"
check "a plain-http mirror is refused"            "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'refusing mirror' && echo 1 || echo 0 )"
check "…and none of them created anything"        "0" "$(exists "$tmp/e")"

# --- the repo's own pins -------------------------------------------------------
# .nvmrc is the single source of the version; bumping it without pinning the new
# tarball would break the next release build and every image install.
want="$(tr -d '[:space:]' < "$REPO/.nvmrc")"
for arch in arm64 x64; do
    check "real pins list node $want for $arch" "1" \
      "$(grep -c "^[0-9a-f]\{64\}  node-v$want-linux-$arch.tar.xz\$" "$REPO/backend/utils/node-runtime.sha256")"
done

echo
echo "--- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
