# EV Trip Dashboard

A polished 9-view dashboard inspired by the BYD mobile app, powered by
[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger) **v0.5.0+**
— works with any car integration that publishes the same sensor names.

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

## 9 views — one per BYD-app pantalla

| # | View | What's on it |
|---|---|---|
| 1 | **Resumen** | Vehicle hero + SoC + range + ODO/Energy/SOH/System chips + tire pressures (2×2) + location map + conditional live-charge popup |
| 2 | **Calendario** | Monthly calendar with per-day badges — `mdi:lightning-bolt` for charges, `mdi:car` for trips. Powered by the new `calendar.<device>_activity` entity |
| 3 | **Tendencias** | 4 KPI tiles (long trip, avg trip, driving time, monthly cost) + dual-axis Monthly Km vs kWh bar chart + 60-day km line |
| 4 | **Patrones** | Trips KPI + daily-avg + 24-hour distribution bars + radar by weekday + 7-day Mon-Sun strip with km totals |
| 5 | **Eficiencia** | Avg consumption hero + monthly avg consumption line + Efficiency vs Distance scatter (score-colored dots) + temperature bucket bars |
| 6 | **Récords** | 4 record KPI tiles (longest, max duration, cheapest, best efficiency) + top-9 lists (distance, consumption, efficiency, speed) |
| 7 | **Detalle** | Single-trip drilldown: 4 KPIs (distance, consumption, efficiency, avg speed) + delta vs personal average + percentile + estimated cost + route map placeholder (uses GPS samples from `trip_positions`) |
| 8 | **Viajes** | 5 KPI averages (last 30 days) + trip cards with date·time / distance / consumption / efficiency / cost / score color-coded |
| 9 | **Cargas** | 4 KPI tiles (avg kWh / avg cost / avg €/kWh / total charges) + charge cards with date / kWh / source label AC/DC / cost / SoC delta + floating "+" button for manual log |

Two ways to use it:
- **HACS dashboard strategy** (recommended) — install via HACS, the strategy auto-generates all 9 views from your device slug. No find/replace.
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
| `vehicle` | No (recommended) | Your **car integration** slug (e.g. `byd_sealion_7`). Unlocks the Driving view's **Range, Odometer, Outside/Cabin temperature, the location map**, and the live **charge session** tiles. Omit it and those car-only cards are simply not shown (everything else still works). |

The strategy regenerates all five views on every load, so you never edit the dashboard again — plugin updates ship new cards automatically.

> Helpers: a dashboard strategy can't create input helpers, so the Trips search/sort/filter still needs `packages/trip-list-helpers.yaml` added as a package (replace `__DEVICE__`, restart). Without them the list just shows everything unfiltered.

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
