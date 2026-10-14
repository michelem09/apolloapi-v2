#!/bin/bash
# What a full disk leaves behind in the node's datadir, and how to get past it.
#
# bitcoind stops itself cleanly when the drive fills — but "cleanly" still means
# writing its state on the way out, onto a disk with no room. settings.json is
# the one that bites: it is rewritten on shutdown, and a write that lands as an
# empty file is not JSON. From then on bitcoind refuses to start — before it
# opens debug.log, so the crash loop has no trace anywhere — and freeing space
# does not help, because the file is already broken. bitcoind's own message says
# what to do: remove the file, which resets it to defaults. Nothing of ours lives
# in there (the configuration this stack manages is bitcoin.conf), so the reset
# costs nothing, and the launcher does it rather than waiting for someone to
# find it over SSH.
#
# Usage:
#   . node_datadir.sh          then call  node_datadir_heal_settings <datadir>

# Is this a settings file bitcoind will accept? An empty file is the case a full
# disk produces and is never valid. Beyond that, JSON is checked with python3
# when it is there — every image ships it — and otherwise taken on trust: the
# only false negative that matters is the one we can prove.
node_datadir_settings_valid() {
    local f="$1"
    [ -s "$f" ] || return 1
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$f" >/dev/null 2>&1
    else
        return 0
    fi
}

# Moves an unreadable settings.json out of the way — never deletes it — and
# prints where it went. Prints nothing and succeeds when there was nothing to do.
node_datadir_heal_settings() {
    local datadir="$1" f aside
    f="$datadir/settings.json"
    [ -e "$f" ] || return 0
    node_datadir_settings_valid "$f" && return 0
    aside="$f.corrupt-$(date +%Y%m%d-%H%M%S)"
    mv -f "$f" "$aside" || return 1
    printf '%s\n' "$aside"
}
