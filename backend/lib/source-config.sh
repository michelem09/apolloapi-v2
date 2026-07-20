# shellcheck shell=bash
# Resolve where this device pulls its code from.
#
# Sourced by the updaters, which always run from a complete checkout. The
# installers carry an inline copy instead: they may run before any checkout
# exists (factory image), so they cannot source this file. Keep the two in sync.
#
# Precedence: environment > /var/lib/apollo/source.conf > official default.
# A device with no config resolves to the official repos, so production devices
# need no configuration at all.

SOURCE_CONF="${APOLLO_SOURCE_CONF:-/var/lib/apollo/source.conf}"
_ENV_GIT_BASE="${APOLLO_GIT_BASE-}"
_ENV_API_REPO="${APOLLO_API_REPO-}"
_ENV_UI_REPO="${APOLLO_UI_REPO-}"
[ -r "$SOURCE_CONF" ] && . "$SOURCE_CONF"
APOLLO_GIT_BASE="${_ENV_GIT_BASE:-${APOLLO_GIT_BASE:-https://github.com/jstefanop}}"
APOLLO_API_REPO="${_ENV_API_REPO:-${APOLLO_API_REPO:-apolloapi-v2}}"
APOLLO_UI_REPO="${_ENV_UI_REPO:-${APOLLO_UI_REPO:-apolloui-v2}}"
APOLLO_API_URL="${APOLLO_GIT_BASE}/${APOLLO_API_REPO}.git"
APOLLO_UI_URL="${APOLLO_GIT_BASE}/${APOLLO_UI_REPO}.git"
