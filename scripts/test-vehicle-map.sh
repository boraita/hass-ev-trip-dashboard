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

# --- Test 3: no false positive — odometer/cabin are declared no-ops ---
t3() {
  local d=/tmp/tvm_t3; setup_cards "$d"
  local out; out=$(scripts/apply-vehicle-map.sh tesla "$d" 2>&1 >/dev/null)
  if echo "$out" | grep -q "pre-flight"; then
    die "preflight-no-false-positive" "reported a token despite all being mapped/no-op: $out"
  else
    pass "pre-flight silent when every Group A token is mapped or no-op"
  fi
}

# --- Test 4: detects a Group A token with no map entry at all ---
t4() {
  local d=/tmp/tvm_t4; setup_cards "$d"
  # exterior_temperature is in tesla.map; remove it to simulate "forgotten"
  grep -v '^exterior_temperature' vehicle-maps/tesla.map > /tmp/tvm_t4.map
  echo '        g: sensor.__VEHICLE___exterior_temperature' >> "$d/sample.yaml"
  local out; out=$(VEHICLE_MAP_OVERRIDE=/tmp/tvm_t4.map scripts/apply-vehicle-map.sh tesla "$d" 2>&1 >/dev/null)
  echo "$out" | grep -q "exterior_temperature" \
    && pass "pre-flight reports an unmapped Group A token" \
    || die "preflight-detects-new" "did not report exterior_temperature: $out"
}

# --- Test 5: equivalence — apply tesla.map + slug sub to a clean copy of the
#     real cards reproduces the hand-remapped Group A refs in the wired cards. ---
t5() {
  local d=/tmp/tvm_t5; rm -rf "$d"; cp -r cards "$d"
  scripts/apply-vehicle-map.sh tesla "$d" >/dev/null 2>&1
  # slug substitution (same as the install pipeline)
  for f in "$d"/*.yaml; do
    sed -e 's/__VEHICLE__/relampago/g' -e 's/__DEVICE__/relampago/g' "$f" > "$f.s" && mv "$f.s" "$f"
  done
  local got; got=$(grep -rhoE \
    "(sensor|binary_sensor|device_tracker)\.relampago_(tpms_[a-z_]+|location_tracker|online|battery_state_of_health|odometer)" \
    "$d/resumen-vehicle.yaml" "$d/trip-detail.yaml" | sort -u)
  local want; want=$(sort -u tests/fixtures/tesla-expected-group-a.txt)
  if [ "$got" = "$want" ] \
     && ! grep -rqE "relampago_(front_left_tire_pressure|power_system|state_of_health)" \
          "$d/resumen-vehicle.yaml" "$d/trip-detail.yaml"; then
    pass "equivalence: script reproduces hand-remapped wired cards"
  else
    die "equivalence" "Group A refs differ from fixture or BYD names remain"
  fi
}

t1; t2; t3; t4; t5
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
