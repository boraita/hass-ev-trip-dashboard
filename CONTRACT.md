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

## 3b. Sensor metadata fixes (found during the dashboard review)

These are small logger-side corrections that make the native charts work without
dashboard workarounds:

- **`avg_charge_price_30_days` has no `state_class`** → it cannot be graphed with
  `statistics-graph`. The dashboard currently works around it with a
  `history-graph`. Fix: set `state_class: measurement` so it becomes
  long-term-statistics eligible, then a mean/day chart works.
- **`trips_this_month` is `measurement`** → it can't be summed in LTS, so a
  "trips per month" bar chart isn't possible. If you want that chart, expose a
  `total_increasing` monthly-reset counter (or a dedicated `trips_per_month`
  statistic). The dashboard currently omits the chart.
- **Battery SoC entity name.** The dashboard expects `sensor.__DEVICE___battery_percent`
  (verified live). Earlier docs said `battery_level`; that name belongs to the
  separate **car** integration (`__VEHICLE__`), not the logger. Keep
  `battery_percent` as the logger's SoC sensor.
- **Recorder bloat.** `recent_trips`, `recent_journeys`, `recent_charges` carry a
  large JSON attribute and have `state_class: measurement`, so the full blob is
  written to the recorder on every change. Recommend documenting a
  `recorder.exclude.entity_globs` for `sensor.*_recent_*`, or dropping
  `state_class` on those (they're lists, not measurements).

## 3c. `__VEHICLE__` entities (car integration, not the logger)

The Driving view's range/odometer/map/temps and the live charge session come from
the **car** integration (`__VEHICLE__` slug, e.g. `byd_sealion_7`), a different
device from the logger. These are optional and out of the logger's contract:
`sensor.__VEHICLE___{range, odometer, exterior_temperature, cabin_temperature}`,
`device_tracker.__VEHICLE___location`, `sensor.__VEHICLE___charge_session_*`.

Note: that `device_tracker` already resolves to **zone names** (e.g. "Trabajo"),
which is exactly the source the logger can reuse to implement §3 origin/destination
labelling.

## 4. Summary of asks for the logger session

- [ ] `recent_trips`: add `recent_trips_limit` option (default 50).
- [ ] `recent_trips`: resolve `origin`/`destination` to labels (§3).
- [ ] New sensor `sensor.__DEVICE___trip_records` with the all-time record
      objects in §2.
- [ ] Keep the per-trip field names in §1 stable — the dashboard templates key
      off them directly.

When these land, the dashboard needs **no structural change**: the trip list
auto-uses the bigger window and real destinations, and the records card
auto-switches from "best of recent" to "best all-time".
