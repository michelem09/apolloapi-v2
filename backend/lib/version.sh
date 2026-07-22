#!/bin/bash
# Version ordering, in one place.
#
# Sourced by backend/update AND by .github/workflows/release.yml, which decides
# where a channel pointer may move. They must not merely agree — they must be the
# same code. The workflow first used `sort -V`, under a comment claiming parity
# with this function, and `sort -V` ranks 2.3.0-rc1 ABOVE 2.3.0: the first
# rc-to-final release would have frozen the channel with everything green.
#
# The workflow used to get this by sourcing backend/update itself, which also
# applied `set -Eeuo pipefail` to the rest of the CI step and ran that script's
# top-level code (reading /dev/urandom, /etc/apollo/update.conf, a state dir that
# does not exist on a runner). This file holds the comparison and nothing else,
# so adding anything to backend/update can never change how releases publish.
#
# Deliberately NOT strict semver: digit runs are compared numerically, so rc10
# outranks rc9. Strict semver §11 says the opposite, and the opposite is useless
# to us — the release train goes rc9, rc10, rc11.

version_gt() {  # $1 > $2 ?
  local a="$1" b="$2" ac bc ap bp i x y
  ac="${a%%-*}"; bc="${b%%-*}"
  [ "$a" = "$ac" ] && ap='' || ap="${a#*-}"
  [ "$b" = "$bc" ] && bp='' || bp="${b#*-}"
  local -a A B; IFS=. read -ra A <<<"$ac"; IFS=. read -ra B <<<"$bc"
  for i in 0 1 2; do
    x=$((10#${A[i]:-0})); y=$((10#${B[i]:-0}))
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
  done
  # Cores equal: a release outranks any prerelease of the same core.
  [ -z "$ap" ] && [ -n "$bp" ] && return 0
  [ -n "$ap" ] && [ -z "$bp" ] && return 1
  [ "$ap" = "$bp" ] && return 1

  local na nb
  na="$(normalize_prerelease "$ap")"
  nb="$(normalize_prerelease "$bp")"
  [ "$na" = "$nb" ] && return 1
  # LC_ALL=C, because collation is locale-dependent: without it two devices in
  # different locales could reach opposite conclusions about the same pair.
  local LC_ALL=C
  [[ "$na" > "$nb" ]]
}

# Zero-pads every run of digits so a plain lexical compare orders them naturally:
# rc9 -> rc0000000009, rc10 -> rc0000000010.
#
# This is a DELIBERATE deviation from semver §11, which compares alphanumeric
# identifiers lexically and therefore ranks rc10 BELOW rc9 — formally correct and
# certainly not what anyone means. Strict semver only gets this right when the
# number is its own dot-separated field (rc.10), which is not how these tags are
# written. Comparing lexically without the padding left every beta device stuck
# at rc9 and, in the other direction, accepting rc2 over rc10 as an "upgrade".
normalize_prerelease() {
  local s="$1" out=''
  while [[ "$s" =~ ^([^0-9]*)([0-9]+)(.*)$ ]]; do
    out="$out${BASH_REMATCH[1]}$(printf '%010d' "$((10#${BASH_REMATCH[2]}))")"
    s="${BASH_REMATCH[3]}"
  done
  printf '%s%s' "$out" "$s"
}
