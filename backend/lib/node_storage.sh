#!/bin/bash
# Is there somewhere for the Bitcoin node to live?
#
# The launcher and the API both have to answer this, and they have to answer it
# the SAME way — a device the API calls ready and the launcher refuses is a node
# that never starts with nothing on screen to say why. So the answer is computed
# once, here, and both read it.
#
# Some Apollo III ship without an SSD, and a Solo Node can have one seated badly
# or failed. From the outside those look alike, which is why nothing here claims
# a drive is "not installed" — only that none was detected.
#
# Usage:
#   . node_storage.sh          then call  node_storage_state
#   node_storage.sh --json     prints the state as JSON, for the API
#
# States, in the order they are ruled out:
#   no-drive     no NVMe block device at all
#   unformatted  the disk is there, the partition is not
#   not-mounted  the partition is there, nothing is mounted at the mountpoint
#   foreign      something IS mounted there, but not from the node drive
#   ready        mounted, from the right device
#
# A ready drive also reports how much room is left ("free", bytes) and whether
# that is below NODE_STORAGE_LOW_GB ("low"). Running out is not a state of its
# own: the drive stays usable and the node keeps running right up to the wall.
# What ends there is bitcoind — it stops itself when the disk fills — and on the
# way down it can leave a half-written settings.json that then refuses every
# restart. The warning exists so that is seen coming, weeks ahead, not found
# afterwards in a crash loop.

NODE_DISK="${NODE_DISK:-/dev/nvme0n1}"
NODE_PARTITION="${NODE_PARTITION:-/dev/nvme0n1p1}"
NODE_MOUNTPOINT="${NODE_MOUNTPOINT:-/media/nvme}"
# The chain grows by roughly 10 GB a month; 20 GB is a couple of months of
# notice, and still well clear of the ~50 MB at which bitcoind gives up.
NODE_STORAGE_LOW_GB="${NODE_STORAGE_LOW_GB:-20}"

# Indirection, not decoration: the states below are told apart only by which
# block devices exist, and a test cannot create one without root. Overriding this
# is how the state machine gets exercised on a machine with a working disk.
node_storage_is_block() {
    [ -b "$1" ]
}

node_storage_state() {
    # The whole disk, not the partition: an unformatted drive has no partition,
    # and calling that "no drive" would hide the one thing the user can act on.
    if ! node_storage_is_block "$NODE_DISK" && ! node_storage_is_block "$NODE_PARTITION"; then
        echo "no-drive"
        return
    fi

    if ! node_storage_is_block "$NODE_PARTITION"; then
        echo "unformatted"
        return
    fi

    # --mountpoint, never --target: --target answers for the ENCLOSING mount, so
    # with nothing mounted here it reports / on the SD card and succeeds. This
    # branch would then be unreachable and a formatted-but-unmounted disk would
    # read as "foreign" — telling the user to format a drive holding their chain.
    if ! findmnt -rn --mountpoint "$NODE_MOUNTPOINT" >/dev/null 2>&1; then
        echo "not-mounted"
        return
    fi

    # Something IS mounted here — from where? Anything but the node partition
    # (a second disk, a stale fstab entry) is a blockchain written where it does
    # not belong, so it is refused rather than used.
    local mnt_src dev_real src_real
    mnt_src="$(findmnt -rn -o SOURCE --mountpoint "$NODE_MOUNTPOINT" 2>/dev/null || true)"
    dev_real="$(readlink -f "$NODE_PARTITION" 2>/dev/null || echo "$NODE_PARTITION")"
    src_real="$(readlink -f "$mnt_src" 2>/dev/null || echo "$mnt_src")"

    if [ -z "$mnt_src" ] || [ "$src_real" != "$dev_real" ]; then
        echo "foreign"
        return
    fi

    echo "ready"
}

# Size of the drive in bytes, or empty when there is nothing to measure. Reported
# so the UI can say WHICH disk it found on a drive that is present but unusable.
node_storage_size() {
    local target="$NODE_DISK"
    node_storage_is_block "$target" || target="$NODE_PARTITION"
    node_storage_is_block "$target" || return 0
    lsblk -bdno SIZE "$target" 2>/dev/null | tr -d ' '
}

# Bytes still available at the mountpoint, or empty when nothing usable is
# mounted there. Only meaningful for `ready`; the callers check the state first.
node_storage_free() {
    df -B1 --output=avail "$NODE_MOUNTPOINT" 2>/dev/null | tail -n 1 | tr -d ' '
}

# Whether a free-space figure is below the warning line. Empty (unknown) is not
# low: a probe that could not run must not raise an alarm on a healthy drive.
node_storage_is_low() {
    local free="$1"
    [ -n "$free" ] || return 1
    [ "$free" -lt $((NODE_STORAGE_LOW_GB * 1024 * 1024 * 1024)) ]
}

# The state, once it has stopped being one a boot race can still resolve. The
# mount comes from rc.local, not fstab, so it can land after the unit is
# evaluated, and on a fresh unit first_run partitions and formats the disk first.
#
# Only those two states are waited for. This also runs before every start the
# user asks for, and the others resolve nothing by waiting: no hardware appears
# on its own, and a mountpoint holding some other filesystem will still be
# holding it a minute later.
node_storage_settled_state() {
    local state deadline
    state="$(node_storage_state)"
    case "$state" in
        not-mounted|unformatted) ;;
        *) echo "$state"; return ;;
    esac

    deadline=$(( $(date +%s) + ${NODE_STORAGE_WAIT:-60} ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        sleep 2
        state="$(node_storage_state)"
        case "$state" in not-mounted|unformatted) ;; *) break ;; esac
    done
    echo "$state"
}

# ExecCondition= in node.service. Exiting 1 makes systemd SKIP the unit rather
# than fail it, and a unit that never went active is never restarted — which is
# the only way out of the loop: Restart=always fires on a clean exit too, and
# RestartPreventExitStatus= is matched against the main process, not the control
# process a Type=forking launcher runs as.
#
# That same property is why a drive which is merely LATE must not be refused
# (hence the settled state, not the instantaneous one): refusing would cost more
# than one boot, since skipped means never restarted and the node would stay down
# until someone rebooted or pressed Start.
if [ "${1:-}" = "--check" ]; then
    state="$(node_storage_settled_state)"
    [ "$state" = "ready" ] && exit 0
    echo "no usable node drive ($state); not starting bitcoind" >&2
    exit 1
fi

if [ "${1:-}" = "--json" ]; then
    state="$(node_storage_state)"
    size="$(node_storage_size)"
    free=""
    [ "$state" = "ready" ] && free="$(node_storage_free)"
    low=false
    node_storage_is_low "$free" && low=true
    printf '{"state":"%s","disk":"%s","partition":"%s","mountpoint":"%s","size":%s,"free":%s,"low":%s}\n' \
        "$state" "$NODE_DISK" "$NODE_PARTITION" "$NODE_MOUNTPOINT" "${size:-null}" "${free:-null}" "$low"
fi
