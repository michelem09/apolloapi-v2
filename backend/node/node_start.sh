#!/bin/bash
set -Eeuo pipefail

DEVICE="${APOLLO_NODE_DEVICE:-/dev/nvme0n1p1}"
MOUNTPOINT="${APOLLO_NODE_MOUNTPOINT:-/media/nvme}"
DATADIR="${APOLLO_BITCOIN_DATADIR:-${MOUNTPOINT}/Bitcoin}"
APOLLO_DIR="${APOLLO_DIR:-/opt/apolloapi}"
STATE_DIR="${APOLLO_STATE_DIR:-/var/lib/apollo}"
DATABASE_URL="${DATABASE_URL:-${APOLLO_DIR}/futurebit.sqlite}"

CONF_BASE="${APOLLO_DIR}/backend/default-configs"
CONF_DST="${STATE_DIR}/bitcoin.conf"
CHECK_SYNC="${APOLLO_DIR}/backend/utils/check_node_synced.sh"

CONF_SYNCED="${CONF_BASE}/bitcoin.conf"
CONF_IBD_GENERIC="${CONF_BASE}/bitcoin-ibd.conf"
CONF_IBD_8G="${CONF_BASE}/bitcoin-ibd-8gb.conf"
CONF_IBD_16G="${CONF_BASE}/bitcoin-ibd-16gb.conf"
SRC_CONF="$CONF_SYNCED"

log() { echo "[node-start] $*" >&2; }

set_conf_by_ram_for_ibd() {
    local mem_kb mem_gb

    # Shrink zram to 1GB during IBD, to leave more RAM for bitcoind's cache.
    # An optimization, not a condition for starting bitcoind: newer Armbian
    # manages zram through armbian-zram-config, which holds the device and
    # refuses the resize.
    if [ -b /dev/zram0 ]; then
        sudo swapoff /dev/zram0 >/dev/null 2>&1 || true
        sudo zramctl --reset /dev/zram0 >/dev/null 2>&1 || true
        if ! sudo zramctl --size=1G /dev/zram0 >/dev/null 2>&1 ||
           ! sudo mkswap /dev/zram0 >/dev/null 2>&1 ||
           ! sudo swapon /dev/zram0 >/dev/null 2>&1; then
            log "WARN: could not configure IBD ZRAM"

            # Recovery matters more than the resize did. Failing halfway can
            # leave the device with no swap at all, and bitcoind doing an IBD on a
            # board with neither swap nor spare RAM is killed by the OOM reaper on
            # repeat. Rebuild the signature if the resize destroyed it, then check
            # we actually have swap back.
            sudo swapon /dev/zram0 2>/dev/null ||
                (sudo mkswap /dev/zram0 >/dev/null 2>&1 && sudo swapon /dev/zram0 2>/dev/null) ||
                true

            if ! grep -q "^/dev/zram0" /proc/swaps 2>/dev/null &&
               ! grep -qE "^(/|[^ ]+swapfile)" /proc/swaps 2>/dev/null; then
                log "ERROR: no swap is active; bitcoind may be OOM-killed during IBD"
            fi
        fi
    fi

    mem_kb=$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)
    if [ -z "$mem_kb" ]; then
        log "WARN: could not read MemTotal; using generic IBD profile"
        SRC_CONF="$CONF_IBD_GENERIC"
        return
    fi

    mem_gb=$(( (mem_kb + 524288) / 1048576 ))
    log "Detected RAM: ${mem_gb}GiB (MemTotal=${mem_kb}kB)"
    if [ "$mem_gb" -lt 7 ]; then
        SRC_CONF="$CONF_IBD_GENERIC"
    elif [ "$mem_gb" -le 15 ]; then
        SRC_CONF="$CONF_IBD_8G"
    else
        SRC_CONF="$CONF_IBD_16G"
    fi
}

select_bitcoind() {
    local software arch
    # Wait for the API's write lock instead of failing the start at once.
    if ! software=$(sqlite3 -cmd ".timeout 5000" "$DATABASE_URL" \
        "SELECT node_software FROM settings ORDER BY created_at DESC, id DESC LIMIT 1;" \
        2>/dev/null); then
        log "ERROR: could not read node software from $DATABASE_URL"
        return 1
    fi
    if [ -z "$software" ]; then
        log "ERROR: no node software is configured"
        return 1
    fi
    arch=$(uname -m)

    case "$software" in
        core-25.1|core-28.1|core-29.2|core-31.0|knots-29.2|knots-29.3)
            ;;
        *)
            log "ERROR: unsupported node software '$software'"
            return 1
            ;;
    esac

    BITCOIND="${APOLLO_DIR}/backend/node/bin/${software}/${arch}/bitcoind"
    if [ ! -x "$BITCOIND" ]; then
        log "ERROR: executable not found for ${software}/${arch}: $BITCOIND"
        return 1
    fi
    log "Selected ${software}/${arch}"
}

# --- Node drive / mount validation ---
# The same check the API reports to the UI, so a node that will not start and a
# panel explaining why can never disagree. Some Apollo III ship with no SSD at
# all; the states below are what the user is told, and what they can act on.
NODE_PARTITION="$DEVICE"
NODE_MOUNTPOINT="$MOUNTPOINT"
. "${APOLLO_DIR}/backend/lib/node_storage.sh"

storage_state="$(node_storage_state)"
if [ "$storage_state" != "ready" ]; then
    case "$storage_state" in
        no-drive)    log "WARN: no node drive detected; bitcoind not started" ;;
        unformatted) log "WARN: node drive present but not formatted; bitcoind not started" ;;
        not-mounted) log "WARN: $MOUNTPOINT is not mounted; bitcoind not started" ;;
        foreign)     log "WARN: $MOUNTPOINT is mounted from something other than the node drive; bitcoind not started" ;;
    esac
    # Under systemd this is unreachable — ExecCondition= already refused the
    # start. It stays for anyone running the launcher by hand, and 69 is
    # EX_UNAVAILABLE rather than 0 so a shell script calling it can tell.
    exit 69
fi

log "Node storage OK: $MOUNTPOINT mounted from $NODE_PARTITION"
# --- end validation ---

if [ -x "$CHECK_SYNC" ] && "$CHECK_SYNC"; then
    SRC_CONF="$CONF_SYNCED"
    log "State=synced -> selecting $(basename "$SRC_CONF")"
else
    set_conf_by_ram_for_ibd
    log "State=unsynced -> selecting $(basename "$SRC_CONF")"
fi

select_bitcoind
mkdir -p "$STATE_DIR"
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        includeconf=/var/lib/apollo/*)
            printf 'includeconf=%s/%s\n' "$STATE_DIR" "${line##*/}"
            ;;
        *)
            printf '%s\n' "$line"
            ;;
    esac
done < "$SRC_CONF" > "${CONF_DST}.tmp"
chmod 600 "${CONF_DST}.tmp"
mv -f "${CONF_DST}.tmp" "$CONF_DST"

# --- Datadir left behind by a full disk ---
# A settings.json truncated on the way down stops every start before bitcoind
# even opens its log. The launcher clears it rather than looping on it.
. "${APOLLO_DIR}/backend/lib/node_datadir.sh"
if aside="$(node_datadir_heal_settings "$DATADIR")" && [ -n "$aside" ]; then
    log "WARN: settings.json was not valid JSON (a full disk does this); moved to $aside"
fi
# --- end ---

log "Starting bitcoind in attachable screen session 'node'"
exec screen -D -m -S node "$BITCOIND" \
    -datadir="$DATADIR" \
    -conf="$CONF_DST"
