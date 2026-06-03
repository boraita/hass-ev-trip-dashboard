# EV Trip Dashboard

A polished 8-view dashboard inspired by the BYD mobile app, powered by
[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger) **v0.5.0+**.
It is **car-agnostic**: the trip/charge data comes from the logger, and the
optional car-integration tiles (range, temperatures, tires, location, charge
power) are resolved generically by name + `device_class` (BYD, Tesla, …), with
config overrides if auto-detection misses. See **[Works with any car](#works-with-any-car-integration)**.

## ⚠️ Required HACS frontend cards (v0.2.0)

This pack now **requires** the following HACS frontend repos installed in your
Home Assistant. They unlock the rich BYD-app-style visuals — KPI tiles, dual-axis
bars, scatter, radar, route map, monthly calendar, etc.

| HACS frontend | Used for |
|---|---|
| `custom:mushroom-template-card` (Mushroom) | Hero, KPI labels, score-colored trip rows |
| `custom:mushroom-chips-card` | ODO/Energy/SOH strip in the Resumen view |
| `custom:mushroom-title-card` | Section headers in every view |
| `custom:button-card` | KPI tiles, tire-pressure cells, floating "+" |
| `custom:apexcharts-card` | Dual-axis monthly bars, by-hour bars, radar, scatter |
| `custom:mini-graph-card` | Compact line charts (60-day km, etc.) |
| `custom:calendar-card-pro` | The monthly activity calendar |

Optional but recommended:
- `custom:browser_mod` — click-on-day popups in the Calendar view
- `custom:atomic-calendar-revive` — fallback if you don't want calendar-card-pro

## 8 views

The HACS strategy generates these 8 views (in order). The first two — **Driving**
and **Trips** — are the original, most-used screens; the rest are analytics.

| # | View | What's on it |
|---|---|---|
| 1 | **Driving** | Battery chips + a **mini-graph battery trend** + Range/Odometer/Temperature KPIs (auto-resolved per car) + a live **trip-in-progress** / **last-trip** glance (with percentile) + the **journey-of-the-day** card (left-home → arrived, with a charge chip) |
| 2 | **Trips** | 30-day average KPI strip + the reactive **trip list** with charge rows woven into the timeline (tap a trip for detail incl. the €/kWh applied) + all-time **records** + (optional) search/filter |
| 3 | **Calendar** | A built-in monthly calendar (`ev-trip-calendar-card`) of trips + charges per day, built from `recent_trips`/`recent_charges` — tap a day to expand |
| 4 | **Trends** | Long-trip / avg-trip / driving-time / monthly-cost KPIs + **Monthly Km & kWh** + **60-day daily-km** charts |
| 5 | **Patterns** | Trips & daily-avg KPIs + **by-hour** bars + **weekday** km/trips strip (`ev-trip-patterns-card`) |
| 6 | **Efficiency** | Avg-consumption hero + **Efficiency-vs-Distance scatter** (score-colored) + monthly consumption line + temperature buckets (when available) + a tip |
| 7 | **Records** | All-time **records board** (longest / longest drive / most efficient / fastest / cheapest) with an expandable top-9 (`ev-trip-records-card`) |
| 8 | **Charges** | Avg kWh / cost / €/kWh / count KPIs + per-day **charge history** with each charge's **power-vs-time curve** + an inline last-charge price editor (when its helper is set up) |

Two ways to use it:
- **HACS dashboard strategy** (recommended) — install via HACS, the strategy auto-generates all 8 views from your device slug. No find/replace.
- **Pure-YAML pack** — copy `dashboards/full.yaml` (or `mobile.yaml` for compact) and replace `__DEVICE__` / `__VEHICLE__`. Each card under `cards/` is also a standalone drop-in.

## Install

### Option A — HACS (dashboard strategy, recommended)

1. HACS → ⋮ → **Custom repositories** → add `https://github.com/boraita/hass-ev-trip-dashboard` with category **Dashboard**.
2. Install **EV Trip Dashboard**. HACS downloads `ev-trip-dashboard.js` and registers the Lovelace resource. Reload the browser (hard refresh, Ctrl/Cmd+Shift+R).
3. Add the **Trips helpers** (`packages/trip-list-helpers.yaml`) — see note below; the search/filter needs them.
4. Create the dashboard. **The strategy does not appear in the "Add dashboard" picker** — instead: **Settings → Dashboards → + Add Dashboard → New dashboard from scratch** → open it → edit (✏️) → **⋮ → Raw configuration editor** → replace everything with the config below → **Save**.

   ```yaml
   strategy:
     type: custom:ev-trip
     vehicle: byd_sealion_7   # your CAR integration slug — unlocks range/odometer/map/temps/charge session
     # device: sealion_7      # your trip-LOGGER slug — usually omit (auto-detected)
   ```

#### Strategy options

| Option | Required | What it does |
|---|---|---|
| `device` | No | The **trip-logger** slug (e.g. `sealion_7`). **Auto-detected** from the first `sensor.<slug>_recent_trips` entity — only set it if you run more than one logger device. |
| `vehicle` | No (recommended) | Your **car integration** slug (e.g. `byd_sealion_7`, `portunol`). Unlocks the Driving view's **Range, Odometer, Outside/Cabin temperature, tire pressures, location map**, and live **charge** tiles. Omit it and those car-only cards are simply not shown (everything else still works). |
| `*_entity` overrides | No | Force a specific entity when auto-detection picks the wrong one — see [Works with any car](#works-with-any-car-integration). |

The strategy regenerates all 8 views on every load, so you never edit the dashboard again — plugin updates ship new cards automatically.

> Helpers: a dashboard strategy can't create input helpers, so the Trips search/sort/filter **panel** only appears when you add `packages/trip-list-helpers.yaml` (replace `__DEVICE__`, restart). **Without them nothing breaks** — the trip list just shows everything, newest-first.

## Works with any car integration

The dashboard's data comes from **hass-ev-trip-logger** (`sensor.<device>_*`),
which is car-agnostic. The only car-specific parts are the optional Driving-view
tiles (range, temperatures, odometer, tires, location). Those are resolved
**generically** for each `vehicle` slug, in this order:

1. an explicit `*_entity` **override** in the strategy config (below), then
2. **known name candidates** (BYD `sensor.<v>_range` / `_exterior_temperature` /
   `_cabin_temperature`; Tesla `sensor.<v>_battery_range` / `_outside_temperature` /
   `_inside_temperature`; etc.), then
3. **`device_class` auto-detection** among that vehicle's own entities (a
   `distance` sensor whose name says "range", a `temperature` sensor named
   out/cabin, …).

Anything that can't be resolved is **hidden** (no broken cards). So a BYD, a
Tesla, or any other integration all work with just `vehicle:` set — and if a
guess is wrong, override it:

```yaml
strategy:
  type: custom:ev-trip
  vehicle: portunol            # e.g. a Tesla
  # --- optional overrides (only if auto-detection picks the wrong entity) ---
  range_entity: sensor.portunol_battery_range
  odometer_entity: sensor.portunol_odometer
  outside_temp_entity: sensor.portunol_outside_temperature
  cabin_temp_entity: sensor.portunol_inside_temperature
  charge_power_entity: sensor.portunol_charger_power   # for the per-charge kW curve
```

Supported override keys: `range_entity`, `odometer_entity`, `outside_temp_entity`,
`cabin_temp_entity`, `charge_power_entity` (plus `soh_entity` / `location_entity` /
`tire_pressure_entities`, used when those tiles are enabled).

### Option B — Pure YAML (no HACS)

#### Quick start (one dashboard, full pack)

1. Copy `dashboards/full.yaml` to your `config/dashboards/` folder (create it if it doesn't exist).
2. Edit the file and replace **two** placeholders:
   - `__DEVICE__` → your **trip-logger** slug (for the canonical BYD Sealion 7 this is `sealion_7`, derived from the device name "Sealion 7").
   - `__VEHICLE__` → your **car integration** slug, used only for range/odometer/map/temps/charge-session (for the BYD this is `byd_sealion_7`). If you don't run a separate car integration, set it to the same value as `__DEVICE__`; those few cards will just show "unavailable" — delete them if you like.
3. **Add the Trips helpers.** The Trips view (and `mobile.yaml`) search/sort/filter needs the helpers in `packages/trip-list-helpers.yaml`. Add that file as a [package](https://www.home-assistant.io/docs/configuration/packages/) (or paste its `input_text`/`input_select`/`input_number` blocks into `configuration.yaml`), replace `__DEVICE__`, and restart. **Without these helpers the search box does nothing.**
4. In Home Assistant: Settings → Dashboards → **+ Add Dashboard** → "From YAML file" → point to the file you just copied. Or paste the content into the Raw configuration editor of any existing dashboard.

> **Slug note:** the trip-LOGGER slug (`sealion_7`) and the BYD **vehicle** integration slug (`byd_sealion_7`) are different devices. `__DEVICE__` is the logger; `__VEHICLE__` is the car.

### One card at a time

Each `cards/*.yaml` file is a self-contained card. Paste it into any existing dashboard, then replace `__DEVICE__` with your device slug.

## Required sensors

The dashboard expects the entity IDs published by **hass-ev-trip-logger v0.3.10+**. Here is the full contract — replace `__DEVICE__` with your device slug.

> The exact per-trip attribute schema, the configurable trip-list window, the
> all-time records sensor (`sensor.__DEVICE___trip_records`) and the
> origin/destination labelling are specified in **[CONTRACT.md](CONTRACT.md)** —
> that's the coordination doc between this dashboard and the logger.

| Group | Entity ID |
|---|---|
| Live (current trip) | `sensor.__DEVICE___current_trip_{distance, duration, battery_used, energy, consumption, average_speed, max_power, avg_temperature}` |
| Last trip | `sensor.__DEVICE___last_trip_{distance, duration, battery_used, energy, consumption, average_speed, max_power, avg_temperature, cost, score}` |
| Last charge | `sensor.__DEVICE___last_charge_{energy, cost, price_per_kwh}` |
| Charge in progress | `sensor.__DEVICE___charge_in_progress` |
| Journeys | `sensor.__DEVICE___{current_journey, last_journey, recent_journeys}` |
| Recent lists | `sensor.__DEVICE___{recent_trips, recent_charges}` |
| All-time records (optional) | `sensor.__DEVICE___trip_records` — see [CONTRACT.md §2](CONTRACT.md). When present, the records card shows all-time bests; otherwise it falls back to the recent window. |
| Battery | `sensor.__DEVICE___battery_percent` (SoC %), `sensor.__DEVICE___{battery_energy, energy_to_full_charge}` |
| Monthly trips | `sensor.__DEVICE___{distance_today, distance_this_week, distance_this_month, distance_this_year, energy_this_month, cost_this_month, trips_this_month}` |
| Monthly charges | `sensor.__DEVICE___{charges_this_month, energy_charged_this_month, spent_on_charging_this_month}` |
| 30-day averages | `sensor.__DEVICE___{avg_consumption_30_days, avg_charge_price_30_days}` |

Optional **car-integration** entities (`__VEHICLE__`) used by the Driving view and the live charge session — omit if you only run the logger:

| Group | Entity ID |
|---|---|
| Range / odometer | `sensor.__VEHICLE___{range, odometer}` |
| Temperatures | `sensor.__VEHICLE___{exterior_temperature, cabin_temperature}` |
| Location (map) | `device_tracker.__VEHICLE___location` |
| Charge session | `sensor.__VEHICLE___charge_session_{phase, duration, kwh_added, soc_added}` |

## Using with data from other sources

If you do not run hass-ev-trip-logger but already collect trip data from another integration (your car's official integration, Tessie, custom scripts…), drop one of the templates from `packages/` into your `configuration.yaml`. It defines [template sensors](https://www.home-assistant.io/integrations/template/) that wrap your source data into the entity IDs the dashboard expects.

`packages/ev-trip-logger.yaml` is a no-op passthrough for users already running ev-trip-logger and is intentionally empty.

`packages/from-manual.yaml` shows the pattern when you only have a per-trip CSV or manual input.

## Customise

- Replace `__DEVICE__` (a single search-replace) to wire any device's entities.
- Cards are independent. Reorder or remove without breaking anything.
- The trip/journey history list uses `markdown` templates that read the JSON attribute — adapt the formatting to taste.
- For dark theme compatibility, the cards rely on Home Assistant's native theming and don't hard-code colours.

## Repo layout

```
ev-trip-dashboard.js   HACS plugin: dashboard strategy (custom:ev-trip) + custom trip-list card
hacs.json              HACS plugin manifest
dashboards/
  full.yaml            Complete sections dashboard (Driving/Trips/History/Charts/Stats)
  mobile.yaml          Compact single view, optimised for phone width
cards/
  battery-status.yaml
  current-trip.yaml
  current-journey.yaml
  last-trip.yaml
  last-journey.yaml
  trip-history.yaml
  trip-search.yaml     Searchable + sortable + filterable trip list (needs helpers)
  trip-records.yaml    Best-trip / records card (all-time or recent window)
  journey-history.yaml
  charges-history.yaml
  monthly-stats.yaml
  charts.yaml
  logbook.yaml
packages/
  ev-trip-logger.yaml      Passthrough (no-op) for ev-trip-logger users
  trip-list-helpers.yaml   input_text/select/number helpers for the Trips search/filter
  from-manual.yaml         Map per-trip CSV / manual inputs
examples/                  Generated from full.yaml — DO NOT edit by hand
  byd-sealion-7.yaml       __DEVICE__=sealion_7, __VEHICLE__=byd_sealion_7
  sim-ev-dev.yaml          single slug sim_ev
scripts/
  generate-examples.sh     Regenerate examples/ from full.yaml (run after editing full.yaml)
CONTRACT.md                Data contract with the logger (schema, records sensor, labels)
```

## License

MIT.
