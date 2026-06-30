#!/usr/bin/env bash
# Tests for apply-vehicle-map.sh. Plain shell, no external deps.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
pass() { echo "PASS: $1"; }
die()  { echo "FAIL: $1"; echo "  $2"; fail=1; }

# --- fixture: a throwaway cards dir with the canonical BYD tokens ---
setup_cards() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  cat > "$d/sample.yaml" <<'YAML'
        a: sensor.__VEHICLE___front_left_tire_pressure
        b: "sensor.__VEHICLE___front_left_tire_pressure"
        c: device_tracker.__VEHICLE___location
        d: binary_sensor.__VEHICLE___power_system
        e: sensor.__VEHICLE___state_of_health
        f: sensor.__VEHICLE___odometer
YAML
}

# --- Test 1: substitution rewrites canonical suffixes to Tesla ones ---
t1() {
  local d=/tmp/tvm_t1; setup_cards "$d"
  scripts/apply-vehicle-map.sh tesla "$d" >/dev/null
  grep -q "sensor.__VEHICLE___tpms_front_left" "$d/sample.yaml" \
    && grep -q "device_tracker.__VEHICLE___location_tracker" "$d/sample.yaml" \
    && grep -q "binary_sensor.__VEHICLE___online" "$d/sample.yaml" \
    && grep -q "sensor.__VEHICLE___battery_state_of_health" "$d/sample.yaml" \
    && ! grep -q "__VEHICLE___front_left_tire_pressure" "$d/sample.yaml" \
    && pass "substitution rewrites canonical → tesla suffixes" \
    || die "substitution" "expected tesla suffixes, BYD names remain"
}

# --- Test 2: idempotent (location must not become location_tracker_tracker) ---
t2() {
  local d=/tmp/tvm_t2; setup_cards "$d"
  scripts/apply-vehicle-map.sh tesla "$d" >/dev/null
  cp "$d/sample.yaml" /tmp/tvm_t2_after1.yaml
  scripts/apply-vehicle-map.sh tesla "$d" >/dev/null
  if diff -q /tmp/tvm_t2_after1.yaml "$d/sample.yaml" >/dev/null \
     && ! grep -q "location_tracker_tracker" "$d/sample.yaml"; then
    pass "idempotent on re-apply"
  else
    die "idempotence" "second apply changed output or doubled location"
  fi
}

t1; t2
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
