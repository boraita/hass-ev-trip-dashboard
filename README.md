# EV Trip Dashboard

A ready-made dashboard to visualise every metric from
[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger) — and any
other integration that publishes the same sensor names.

Two ways to use it:
- **HACS dashboard strategy** (recommended) — install via HACS, point a dashboard at the strategy, and it auto-generates everything from your device. Includes a polished custom trip-list card. No `__DEVICE__` find/replace.
- **Pure-YAML pack** (no dependencies) — copy the YAML in `dashboards/` / `cards/` and replace `__DEVICE__`. Works on any Home Assistant, no HACS, no JavaScript.

## What you get

- **Driving view** — battery, range, odometer, temps, live/last trip, current/last journey, and a map of the car's location.
- **Trips view** — searchable, sortable, **filterable** trip list (search by destination/date; sort by date/distance/score/efficiency/cost; filter by period and by min distance / min score / max cost / max consumption) plus a "records" card highlighting the best trips. The HACS strategy renders it as a polished custom list card (route chips + colour-coded score); the YAML pack renders it as a native markdown table.
- **History view** — recent journeys and recent charges.
- **Charts view** — monthly distance / energy / charging-cost bars, rolling efficiency and charge-price trends, 24h battery curve.
- **Stats view** — monthly totals for driving and charging, plus the live charge session when plugged in.
- **Individual cards** under `cards/` you can drop into any other dashboard.

All cards use stock Lovelace types (`markdown`, `glance`, `entities`, `gauge`, `tile`, `heading`, `map`, `conditional`, `statistics-graph`, `history-graph`) inside the native `sections` layout — no custom dependencies. The Trips view's search/sort/filter uses the input helpers in `packages/trip-list-helpers.yaml`.

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
