# EV Trip Dashboard

A ready-made Lovelace pack to visualise every metric from
[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger) — and any
other integration that publishes the same sensor names.

No HACS plugin, no JavaScript. Just YAML you drop into your Home Assistant.

## What you get

- **Driving view** — live current trip, current journey, last trip, last journey, battery status.
- **History view** — last 10 trips, last 10 journeys, last 10 charges.
- **Stats view** — monthly totals for driving and charging, average consumption and charge price over 30 days.
- **Individual cards** under `cards/` you can drop into any other dashboard.

All cards work on the standard Lovelace `markdown`, `glance`, `entities`, `gauge` and `conditional` types — no custom dependencies.

## Install

### Quick start (one dashboard, full pack)

1. Copy `dashboards/full.yaml` to your `config/dashboards/` folder (create it if it doesn't exist).
2. Edit the file: search-replace `__DEVICE__` with the slug of your vehicle device. For the canonical BYD Sealion 7 case this would be `byd_sealion_7`.
3. In Home Assistant: Settings → Dashboards → **+ Add Dashboard** → "From YAML file" → point to the file you just copied. Or paste the content into the Raw configuration editor of any existing dashboard.

### One card at a time

Each `cards/*.yaml` file is a self-contained card. Paste it into any existing dashboard, then replace `__DEVICE__` with your device slug.

## Required sensors

The dashboard expects the entity IDs published by **hass-ev-trip-logger v0.3.10+**. Here is the full contract — replace `__DEVICE__` with your device slug:

| Group | Entity ID |
|---|---|
| Live (current trip) | `sensor.__DEVICE___current_trip_{distance, duration, battery_used, energy, consumption, average_speed, max_power, avg_temperature}` |
| Last trip | `sensor.__DEVICE___last_trip_{distance, duration, battery_used, energy, consumption, average_speed, max_power, avg_temperature, cost, score}` |
| Last charge | `sensor.__DEVICE___last_charge_{energy, cost, price_per_kwh}` |
| Charge in progress | `sensor.__DEVICE___charge_in_progress` |
| Journeys | `sensor.__DEVICE___{current_journey, last_journey, recent_journeys}` |
| Recent lists | `sensor.__DEVICE___{recent_trips, recent_charges}` |
| Battery derived | `sensor.__DEVICE___{battery_energy, energy_to_full_charge}` |
| Monthly trips | `sensor.__DEVICE___{distance_today, distance_this_week, distance_this_month, distance_this_year, energy_this_month, cost_this_month, trips_this_month}` |
| Monthly charges | `sensor.__DEVICE___{charges_this_month, energy_charged_this_month, spent_on_charging_this_month}` |
| 30-day averages | `sensor.__DEVICE___{avg_consumption_30_days, avg_charge_price_30_days}` |

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
dashboards/
  full.yaml            Complete single dashboard with multiple views
  mobile.yaml          Compact single view, optimised for phone width
cards/
  battery-status.yaml
  current-trip.yaml
  current-journey.yaml
  last-trip.yaml
  last-journey.yaml
  trip-history.yaml
  journey-history.yaml
  charges-history.yaml
  monthly-stats.yaml
packages/
  ev-trip-logger.yaml  Passthrough (no-op) for ev-trip-logger users
  from-manual.yaml     Map per-trip CSV / manual inputs
examples/
  byd-sealion-7.yaml   Ready-made full dashboard for BYD Sealion users
```

## License

MIT.
