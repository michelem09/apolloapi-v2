#!/bin/bash
# backend/uninstall-v2 removes the one PATH line image_install* appends to
# futurebit's .bashrc, and only that line. The script is a root uninstaller that
# cannot be run for real here, so the test extracts the function and runs it on a
# scratch file.
#
# Run: bash tests/uninstall_v2.test.sh

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/backend/uninstall-v2"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok   %s\n' "$1"
    else fail=$((fail + 1)); printf '  FAIL %s — expected [%s], got [%s]\n' "$1" "$2" "$3"; fi
}

eval "$(sed -n '/^remove_node_path_line()/,/^}/p' "$SCRIPT")"

OURS='export PATH="/opt/apolloapi/backend/runtime/node/bin:$PATH"'
rc="$tmp/bashrc"
printf '%s\n' '# ~/.bashrc' 'alias ll="ls -l"' \
    'export PATH="/opt/apolloapi/backend/runtime/node/bin:$PATH:/extra"' \
    '  export PATH="/opt/apolloapi/backend/runtime/node/bin:$PATH"' \
    "$OURS" 'export PATH="$HOME/bin:$PATH"' > "$rc"
chmod 640 "$rc"
remove_node_path_line "$rc"
check "our PATH line is gone"                    "0" "$(grep -cxF "$OURS" "$rc")"
check "the user's lines are kept"                "5" "$(wc -l < "$rc" | tr -d ' ')"
check "…including a different PATH line mentioning the runtime" "1" "$(grep -c ':/extra"' "$rc")"
check "…and an indented one"                     "1" "$(grep -c '^  export PATH=' "$rc")"
check "the file mode is unchanged"               "640" "$(stat -c %a "$rc" 2>/dev/null || stat -f %Lp "$rc")"
check "no temp file is left"                     "0" "$(ls "$tmp" | grep -c 'apollo-tmp')"

printf '%s\n' "$OURS" > "$tmp/only"
remove_node_path_line "$tmp/only"
check "a file holding only our line is emptied, not an error" "0" "$(wc -c < "$tmp/only" | tr -d ' ')"
remove_node_path_line "$tmp/missing"
check "a missing bashrc is not an error"         "0" "$?"

check "the script calls it on futurebit's bashrc" "1" "$(grep -c '^remove_node_path_line "\$FUTUREBIT_BASHRC"' "$SCRIPT")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
