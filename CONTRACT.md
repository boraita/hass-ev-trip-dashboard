# Data contract — what the dashboard needs from the trip logger

This is the agreed contract between **hass-ev-trip-dashboard** (this repo) and
**hass-ev-trip-logger** (the integration that publishes the sensors). The
dashboard only renders what the logger exposes, so any new dashboard feature
either reuses the data below or requires the logger to add it.

Replace `__DEVICE__` with the device slug. For the canonical BYD Sealion 7 the
real slug emitted by the integration is **`sealion_7`** (derived from the device
name "Sealion 7"), not `byd_sealion_7`.

---

## 1. Trip list — `sensor.__DEVICE___recent_trips` (EXISTS, needs two tweaks)

State: number of trips in the window. Attribute `trips` is a list, newest first.

Per-trip schema (verified live, **keep stable**):

| Field | Type | Notes |
|---|---|---|
| `id` | int | stable per-trip id |
| `journey_id` | int / null | groups stages of a journey |
| `started_at` | ISO datetime (local) | |
| `ended_at` | ISO datetime (local) | used for sort + date search |
| `distance_km` | float | |
| `duration_min` | float | |
| `energy_kwh` | float / null | |
| `consumption_kwh_100km` | float / null | efficiency |
| `cost` | float / null | |
| `currency` | string | e.g. `EUR` |
| `score` | float / null | 0–10 |
| `origin` | string | **see §3** |
| `destination` | string | **see §3** |
| `driver` | string / null | **v0.5.43+** — who drove, captured from the car's bluetooth-connected-device sensor; `null` when unidentified |

**Tweak A — configurable window size.** Today the window is small (~10). Add a
config option (suggested `recent_trips_limit`, default **50**) so the dashboard's
search/sort has a useful range. Keep it bounded — one HA state attribute should
stay well under the recorder's ~16 KB limit, so ~50 trips is a safe ceiling, not
"all history". Full-history search is explicitly **out of scope** for now.

**Tweak B — resolved origin/destination.** See §3.

---

## 2. All-time records — `sensor.__DEVICE___trip_records` (NEW)

The dashboard's "best trip ever" must be computed **logger-side over the full
history**, because `recent_trips` is only a recent window. The dashboard reads
this sensor and just renders it (it falls back to computing over `recent_trips`
when the sensor is absent, so shipping it is non-breaking).

- **State:** total number of completed trips all-time (int).
- **Attributes:** one object per record. Each object identifies the winning trip
  so the dashboard can show *when* and *where*:

```yaml
sensor.__DEVICE___trip_records:
  state: 137                       # all-time trip count
  attributes:
    best_score:                    # highest score
      value: 10.0
      trip_id: 42
      ended_at: "2026-05-28T17:13:25"
      distance_km: 7.0
      destination: "Casa"
    longest:                       # max distance_km
      value: 312.4
      trip_id: 88
      ended_at: "2026-04-02T19:40:00"
      destination: "Valencia"
    most_efficient:                # min consumption_kwh_100km (ignore null/0)
      value: 10.4
      trip_id: 42
      ended_at: "2026-05-28T17:13:25"
      destination: "Casa"
    cheapest:                      # min cost (ignore null; per whole trip)
      value: 0.05
      currency: "EUR"
      trip_id: 42
      ended_at: "2026-05-28T17:13:25"
      destination: "Casa"
    # optional, nice to have:
    fastest:                       # max average_speed_kmh
      value: 98.0
      trip_id: 88
      ended_at: "2026-04-02T19:40:00"
      destination: "Valencia"
    totals:                        # all-time aggregates
      trips: 137
      distance_km: 8421.0
      energy_kwh: 1380.5
      cost: 96.4
      currency: "EUR"
```

Field names the dashboard expects per record object: `value`, `ended_at`,
`destination` (and `currency` on `cheapest`). If a record can't be computed yet
(no trips), omit the object or set it to `null` — the dashboard hides empty rows.

---

## 3. Origin / destination labels (logger-side resolution)

Today both are `"home"` / `"not_home"`, which makes search-by-destination
useless. Resolve each trip's start/end coordinates to a human label, in this
priority order:

1. **HA zone name** if the point falls inside a configured zone (`zone.home` →
   its friendly name, e.g. "Casa"; custom zones "Trabajo", "Gimnasio"…).
2. **Reverse-geocoded place** otherwise (city / locality, or street). Reuse
   whatever geocoding the integration already has access to; keep it short.
3. **Fallback** to the current `home` / `not_home` if nothing resolves.

Keep the value a plain string in `origin` / `destination` (no change to the
schema in §1). If you also want the raw zone state, add a separate optional
field rather than overloading these.

---

## 3b. Sensor metadata fixes (DONE as of v0.5.x)

- **`avg_charge_price_30_days` `state_class`** — DONE: set to `MEASUREMENT` with
  unit `<currency>/kWh`. The sensor is now long-term-statistics eligible.
- **`trips_this_month` (now `total_month_count`)** — DONE: state class changed to
  `TOTAL_INCREASING` so a "trips per month" bar chart works in LTS.
- **Battery SoC entity name** — The entity_id is `sensor.__DEVICE___battery_state`
  (the `SensorEntityDescription.key` is `"battery_state"` inside the
  `BatteryPercentSensor` class in `sensor.py`). The friendly name shown in the
  UI is derived from the translation key `"battery_state"`. Earlier versions of
  this document incorrectly referred to this entity as `battery_percent` or
  `battery_level`. The logger exposes exactly one SoC sensor per device, at
  `sensor.__DEVICE___battery_state`.
- **Recorder bloat** — `recent_trips`, `recent_journeys`, `recent_charges` carry
  large JSON attributes. Recommend documenting a `recorder.exclude.entity_globs`
  for `sensor.*_recent_*`, or dropping `state_class` on those entities.

## 3c. `__VEHICLE__` entities (car integration, not the logger)

The Driving view's range/odometer/map/temps and the live charge session come from
the **car** integration (`__VEHICLE__` slug, e.g. `byd_sealion_7`), a different
device from the logger. These are optional and out of the logger's contract:
`sensor.__VEHICLE___{range, odometer, exterior_temperature, cabin_temperature}`,
`device_tracker.__VEHICLE___location`, `sensor.__VEHICLE___charge_session_*`.

Note: that `device_tracker` already resolves to **zone names** (e.g. "Trabajo"),
which is exactly the source the logger can reuse to implement §3 origin/destination
labelling.

---

## 4. New sensors (v0.5.43)

### 4a. Average regen per trip — `sensor.__DEVICE___avg_trip_regen_30_days`

Mean energy recovered per trip (regen, regenerative braking) over the last 30
days.

- **State:** float, unit `kWh`, `state_class: MEASUREMENT`.
- **Attributes:**
  - `sample_count` — number of trips with regen data in the window.
  - `window_days` — window length (30).

The dashboard reads this in the Trips view KPI strip ("Regen media" tile).

### 4b. Per-driver stats — `sensor.__DEVICE___driver_stats_30_days`

Usage breakdown by driver over the last 30 days. Only exists when the user has
wired a driver sensor (e.g. the car's Bluetooth-connected-device sensor) in the
logger config.

- **State:** int — number of **identified** drivers (excludes the `unknown`
  bucket).
- **Attributes:**
  - `drivers` — list of objects, ordered by `distance_km` descending:

    ```json
    [
      {
        "driver": "Alice",
        "trips": 18,
        "distance_km": 312.4,
        "hours": 4.2,
        "energy_kwh": 48.1,
        "avg_consumption_kwh_100km": 15.4
      },
      {
        "driver": "unknown",
        "trips": 3,
        "distance_km": 42.0,
        "hours": 0.6,
        "energy_kwh": 7.2,
        "avg_consumption_kwh_100km": 17.1
      }
    ]
    ```

    `driver == "unknown"` is the bucket for unidentified trips. It may be
    absent when all trips have identified drivers.

  - `window_days` — window length (30).

The dashboard renders this in the `ev-driver-stats-card` (Patterns view and
standalone `cards/driver-stats.yaml`).

### 4c. Current driver — `sensor.__DEVICE___current_driver`

Who is driving **right now**. Only exists when the user has wired a driver
sensor. Handle absence gracefully (entity will be missing, not just unavailable).

- **State:** string — name of the current driver, or `"unknown"` / `None` when
  idle or unidentified.
- **Attributes:**
  - `trip_active` — bool, `true` while a trip is in progress.
  - `last_trip_driver` — string / null — driver of the most recently completed
    trip.

---

## 5. Summary of asks for the logger session

- [ ] `recent_trips`: add `recent_trips_limit` option (default 50).
- [ ] `recent_trips`: resolve `origin`/`destination` to labels (§3).
- [ ] New sensor `sensor.__DEVICE___trip_records` with the all-time record
      objects in §2.
- [x] `recent_trips` per-trip `driver` field (v0.5.43).
- [x] `sensor.__DEVICE___avg_trip_regen_30_days` (v0.5.43).
- [x] `sensor.__DEVICE___driver_stats_30_days` (v0.5.43).
- [x] `sensor.__DEVICE___current_driver` (v0.5.43).
- [x] Battery SoC entity is `sensor.__DEVICE___battery_state` (key `battery_state`).
- [x] `state_class` fixes for avg_charge_price, total_month_count (§3b).

When the pending items land, the dashboard needs **no structural change**: the
trip list auto-uses the bigger window and real destinations, and the records card
auto-switches from "best of recent" to "best all-time".

---

## 6. Vehicle entity naming (brand maps)

Building on §3c (the car-integration entities the cards consume), this section
defines the canonical naming and how to remap it per brand.

The cards reference the car integration's entities through the `__VEHICLE__`
slug plus a **canonical suffix**. The canonical scheme is BYD's (the reference
car). Cars with different entity names are supported via per-brand maps in
`vehicle-maps/<brand>.map` applied by `scripts/apply-vehicle-map.sh <brand>`
before the slug substitution.

Canonical Group A suffixes (concept → where it is used):

| Canonical suffix (BYD) | Domain | Concept |
|---|---|---|
| `front_left_tire_pressure` … `rear_right_tire_pressure` | `sensor` | TPMS, 4 wheels |
| `location` | `device_tracker` | GPS tracker |
| `power_system` | `binary_sensor` | car online/awake |
| `state_of_health` | `sensor` | battery SoH |
| `odometer` | `sensor` | odometer |
| `exterior_temperature` / `cabin_temperature` | `sensor` | temperatures |

Domains do not change across brands — a map only renames the **suffix**.

To add a brand: copy `vehicle-maps/template.map`, set each right-hand suffix to
your integration's real name (or `<token> <token>` if identical), delete lines
for entities your car lacks, and run `scripts/apply-vehicle-map.sh <brand>`. The
script's pre-flight lists any canonical token left unmapped. Group B telemetry
(BYD-cloud consumption, `pm25_*`, doors/windows) is intentionally out of scope —
those cards degrade on their own when the entities are absent. Note: the brand
map covers the dashboard **cards** only; the `packages/vehicle-on-from-speed.yaml`
helper also uses `__VEHICLE__` tokens (`vehicle_on`, `speed`, `power`) which are
not Group A and must be mapped separately by the brand integrator.
