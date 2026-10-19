#!/bin/bash

ENV_FILE="/opt/apolloapi/apolloui-v2/.env"
ARMBIAN_RELEASE="/etc/armbian-release"

if [[ -r "$ARMBIAN_RELEASE" ]]; then
    . "$ARMBIAN_RELEASE"
fi

set_env_var() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=\"${value}\"|" "$ENV_FILE"
    else
        echo "${key}=\"${value}\"" >> "$ENV_FILE"
    fi
}

remove_env_var() {
    local key="$1"
    sed -i "/^${key}=/d" "$ENV_FILE"
}

# USB miner presence is live from the API (hotplug), and the device type is
# derived from the chassis: drop the values older builds left behind. The stale
# DEVICE_TYPE is what pinned the Solo Node UI mode.
remove_env_var "NEXT_PUBLIC_USB_MINERS"
remove_env_var "NEXT_PUBLIC_DEVICE_TYPE"

case "${BOARD_NAME:-}" in
    "Apollo 3")
        set_env_var "NEXT_PUBLIC_CHASSIS" "apollo-iii"
        echo "Detected Apollo III chassis"
        ;;
    "Solo Node")
        set_env_var "NEXT_PUBLIC_CHASSIS" "solo-node"

        echo "Detected Solo Node chassis"
        ;;
    *)
        echo "Unsupported BOARD_NAME: ${BOARD_NAME:-unset}" >&2
        exit 1
        ;;
esac

echo "Done."
