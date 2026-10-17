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

# run <version> <dest> [pins] [mirror] — exit status in $rc, output in $out.
# The machine is an aarch64 one unless MACHINE says otherwise, so the runtime is
# "for this machine" and the post-extraction run check is exercised everywhere.
run() {
    local v="$1" dest="$2" pins="${3:-$tmp/fx-$1/pins}" mirror="${4:-$tmp/fx-$1}"
    out="$(APOLLO_NODE_VERSION="$v" APOLLO_NODE_ARCH=arm64 APOLLO_MACHINE_ARCH="${MACHINE:-aarch64}" APOLLO_NODE_PINS="$pins" \
           APOLLO_NODE_MIRROR="$mirror" APOLLO_YARN_MIRROR="$mirror" \
           bash "$SCRIPT" "$dest" 2>&1)"
    rc=$?
}

# make_broken_fixture <version> <node-script-body> — like make_fixture, but the
# extracted bin/node is the given shell script (a binary that dies, or lies).
make_broken_fixture() {
    local v="$1" body="$2" d="$tmp/fx-$1"
    make_fixture "$v"
    printf '#!/bin/sh\n%s\n' "$body" > "$tmp/build-$v/node-v$v-linux-arm64/bin/node"
    tar -C "$tmp/build-$v" -czf "$d/v$v/node-v$v-linux-arm64.tar.xz" "node-v$v-linux-arm64"
    {
        echo "$(sha_of "$d/v$v/node-v$v-linux-arm64.tar.xz")  node-v$v-linux-arm64.tar.xz"
        echo "$(sha_of "$d/yarn-1.22.22.tgz")  yarn-1.22.22.tgz"
    } > "$d/pins"
}

make_fixture 9.9.9
make_fixture 9.9.8
make_broken_fixture 9.9.7 'exit 127'
make_broken_fixture 9.9.6 'echo v0.0.1'

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

# --- an extracted node that does not run, or lies ---------------------------------
# On a machine of the runtime's own architecture this is a failed install and the
# previous runtime survives. Only a cross build (other architecture) skips the check.
dest="$tmp/g/runtime/node"
run 9.9.8 "$dest"
touch "$dest/OLD_MARKER"
run 9.9.7 "$dest"
check "a node that does not start is refused"       "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'does not start' && echo 1 || echo 0 )"
check "…the message names the runtime's arch"       "1" "$(printf '%s' "$out" | grep -c 'extracted arm64 node does not start on this arm64 machine')"
check "…and the previous runtime is untouched"      "v9.9.8:1" "$("$dest/bin/node" --version 2>/dev/null):$(exists "$dest/OLD_MARKER")"
run 9.9.6 "$dest"
check "a node that reports another version is refused" "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'reports v0.0.1' && echo 1 || echo 0 )"
check "…and the previous runtime is untouched"      "v9.9.8:1" "$("$dest/bin/node" --version 2>/dev/null):$(exists "$dest/OLD_MARKER")"
dest="$tmp/g2/runtime/node"
MACHINE=x86_64 run 9.9.7 "$dest"
check "cross build: the unrunnable node is installed" "0" "$rc"
check "…and the skipped check is declared"          "1" "$(printf '%s' "$out" | grep -c 'cross build')"
dest="$tmp/g3/runtime/node"
out="$(APOLLO_NODE_VERSION=9.9.9 APOLLO_NODE_ARCH=riscv64 APOLLO_NODE_PINS="$tmp/fx-9.9.9/pins" \
       APOLLO_NODE_MIRROR="$tmp/fx-9.9.9" APOLLO_YARN_MIRROR="$tmp/fx-9.9.9" bash "$SCRIPT" "$dest" 2>&1)"; rc=$?
check "an unknown architecture is refused, naming it" "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'no Node runtime for riscv64' && echo 1 || echo 0 )"

# --- the final move fails: the previous runtime comes back --------------------------
# A mv that fails for the last step only (runtime tree -> destination).
dest="$tmp/h/runtime/node"
run 9.9.8 "$dest"
touch "$dest/OLD_MARKER"
mvbin="$tmp/mvfail-bin"; mkdir -p "$mvbin"
cat > "$mvbin/mv" <<EOS
#!/bin/sh
case "\$1" in */.node-runtime.*/node) [ "\$2" = "$dest" ] && exit 1;; esac
exec /bin/mv "\$@"
EOS
chmod +x "$mvbin/mv"
out="$(PATH="$mvbin:$PATH" APOLLO_NODE_VERSION=9.9.9 APOLLO_NODE_ARCH=arm64 APOLLO_MACHINE_ARCH=aarch64 \
       APOLLO_NODE_PINS="$tmp/fx-9.9.9/pins" APOLLO_NODE_MIRROR="$tmp/fx-9.9.9" APOLLO_YARN_MIRROR="$tmp/fx-9.9.9" \
       bash "$SCRIPT" "$dest" 2>&1)"; rc=$?
check "a failing final move: exit non-zero"          "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'could not move' && echo 1 || echo 0 )"
check "…the previous runtime is back in place"       "v9.9.8:1" "$("$dest/bin/node" --version 2>/dev/null):$(exists "$dest/OLD_MARKER")"
check "…and no temp dir is left"                     "0" "$(ls -A "$tmp/h/runtime" | grep -c '^\.node-runtime')"

# --- refusals that happen before any download -----------------------------------
dest="$tmp/e/runtime/node"
run 26 "$dest"
check "an inexact version is refused"             "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'exact version' && echo 1 || echo 0 )"
run 9.9.7 "$dest" "$tmp/fx-9.9.9/pins"
check "a version with no pinned checksum is refused" "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'no pinned checksum' && echo 1 || echo 0 )"
run 9.9.9 "$dest" "$tmp/fx-9.9.9/pins" "http://nodejs.org/dist"
check "a plain-http mirror is refused"            "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'refusing mirror' && echo 1 || echo 0 )"
check "…and none of them created anything"        "0" "$(exists "$tmp/e")"

# --- an xz tarball on a machine without xz --------------------------------------
# tar's own "xz: Cannot exec" says nothing useful. Needs xz to build the fixture
# and a non-root user (root would go and apt-get it), so it is skipped elsewhere.
if command -v xz >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
    xzfx="$tmp/fx-xz"; mkdir -p "$xzfx/v9.9.9"
    cp "$tmp/fx-9.9.9/yarn-1.22.22.tgz" "$xzfx/"
    gzip -dc < "$tmp/fx-9.9.9/v9.9.9/node-v9.9.9-linux-arm64.tar.xz" | xz -c > "$xzfx/v9.9.9/node-v9.9.9-linux-arm64.tar.xz"
    {
        echo "$(sha_of "$xzfx/v9.9.9/node-v9.9.9-linux-arm64.tar.xz")  node-v9.9.9-linux-arm64.tar.xz"
        grep 'yarn-' "$tmp/fx-9.9.9/pins"
    } > "$xzfx/pins"
    # A PATH with the tools the script needs and no xz.
    nox="$tmp/noxz-bin"; mkdir -p "$nox"
    for c in bash sh tar gzip awk tr od cut grep mktemp rm mv mkdir cp ln chmod dirname id cat sed head sha256sum shasum uname; do
        p="$(command -v "$c" 2>/dev/null)" && ln -sf "$p" "$nox/$c"
    done
    dest="$tmp/f/runtime/node"
    out="$(PATH="$nox" APOLLO_NODE_VERSION=9.9.9 APOLLO_NODE_ARCH=arm64 APOLLO_NODE_PINS="$xzfx/pins" \
           APOLLO_NODE_MIRROR="$xzfx" APOLLO_YARN_MIRROR="$xzfx" "$nox/bash" "$SCRIPT" "$dest" 2>&1)"; rc=$?
    check "an xz tarball without xz installed is refused" "1" "$( [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'xz is needed' && echo 1 || echo 0 )"
    check "…with nothing installed"                      "0" "$(exists "$dest")"
    run 9.9.9 "$dest" "$xzfx/pins" "$xzfx"
    check "…and the same fixture installs where xz exists" "0" "$rc"
else
    echo "  skip xz-less machine (needs xz and a non-root user)"
fi

# --- the repo's own pins -------------------------------------------------------
# .nvmrc is the single source of the version; bumping it without pinning the new
# tarball would break the next release build and every image install.
want="$(tr -d '[:space:]' < "$REPO/.nvmrc")"
for arch in arm64 x64; do
    check "real pins list node $want for $arch" "1" \
      "$(grep -c "^[0-9a-f]\{64\}  node-v$want-linux-$arch.tar.xz\$" "$REPO/backend/utils/node-runtime.sha256")"
done

# The Docker images build and test the code, so they pin the same exact version:
# a floating "26" tag moves under .nvmrc and the image stops matching the runtime.
for f in Dockerfile.test Dockerfile.integration apolloui-v2/Dockerfile; do
    check "$f pins node $want exactly" "1" \
      "$(grep -c "^FROM node:$want-" "$REPO/$f" | awk '$1>0{print 1; next}{print 0}')"
done

echo
echo "--- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
