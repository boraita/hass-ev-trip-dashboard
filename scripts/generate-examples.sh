#!/usr/bin/env bash
# Regenerate examples/*.yaml from dashboards/full.yaml.
# The examples are full.yaml with the placeholders substituted — never edit them
# by hand, edit full.yaml and re-run this script.
#
#   __DEVICE__   -> trip-logger slug
#   __VEHICLE__  -> car-integration slug (range/odometer/map/temps/charge-session)
#
# Usage: scripts/generate-examples.sh
set -euo pipefail
cd "$(dirname "$0")/.."

gen() {  # gen <out> <device-slug> <vehicle-slug>
  sed -e "s/__DEVICE__/$2/g" -e "s/__VEHICLE__/$3/g" dashboards/full.yaml > "$1"
  echo "generated $1  (__DEVICE__=$2 __VEHICLE__=$3)"
}

# BYD Sealion 7: logger device 'sealion_7', vehicle integration 'byd_sealion_7'.
gen examples/byd-sealion-7.yaml sealion_7 byd_sealion_7
# Generic simulator: single slug for both.
gen examples/sim-ev-dev.yaml sim_ev sim_ev

# Sanity: no placeholders left behind.
if grep -lR "__DEVICE__\|__VEHICLE__" examples/ ; then
  echo "ERROR: placeholders remain in examples/" >&2; exit 1
fi
echo "OK — examples regenerated and placeholder-free."
