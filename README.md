# EV Trip Dashboard

A polished multi-view Home Assistant dashboard powered by **[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger)** (v0.5.0+). Inspired by the BYD mobile app, but the trip / charge / journey data comes from the logger sensors, so it works with **any car**: BYD, Tesla, OVMS, dongle setups, even fully manual entry.

Optional car-integration tiles (range, temperatures, tires, doors, energy snapshot, fetch-data button) plug in via placeholders so you only configure the prefix once.

---

## TL;DR install

1. Install **hass-ev-trip-logger** via HACS and configure it.
2. Install the HACS frontend cards listed below (one-off).
3. Clone or download this repo into `<HA config>/dashboards/ev-trip/`:
   ```bash
   cd /config/dashboards && \
   git clone https://github.com/boraita/hass-ev-trip-dashboard ev-trip
   ```
4. Find/replace placeholders in the YAML (see [Placeholders](#placeholders)).
5. Add the dashboard to `configuration.yaml`:
   ```yaml
   lovelace:
     mode: storage
     dashboards:
       lovelace-ev:
         mode: yaml
         title: EV
         icon: mdi:car-electric
         show_in_sidebar: true
         filename: dashboards/ev-trip/dashboards/full.yaml
   ```
6. Restart HA. Done.

---

## Placeholders

The cards use two placeholders so the pack stays vehicle-agnostic. Substitute them before loading the dashboard (most editors can do a project-wide find/replace, or use a `sed` one-liner).

| Placeholder | Replace with | Example |
|---|---|---|
| `__DEVICE__` | Your ev_trip_logger device slug (lowercase, snake_case). | `sealion_7` |
| `__VEHICLE__` | Manufacturer integration prefix (entity_id middle). | `byd_sealion_7` |
| `__FETCH_BUTTON__` | Optional — the on-demand fetch-energy button entity_id. | `button.byd_sealion_7_fetch_energy_data` |
| `__GEOAPIFY_KEY__` | Optional — free Geoapify API key for road-fit route maps. | `0123abcd…` |

One-liner (zsh / bash):
```bash
find dashboards cards -name '*.yaml' -exec sed -i '' \
  -e 's/__DEVICE__/sealion_7/g' \
  -e 's/__VEHICLE__/byd_sealion_7/g' \
  -e 's|__FETCH_BUTTON__|button.byd_sealion_7_fetch_energy_data|g' \
  -e 's/__GEOAPIFY_KEY__/abc123…/g' \
  {} +
```

---

## Required HACS frontend cards

Install via HACS → Frontend → ⋮ → Custom repositories. The visuals fall back gracefully when one is missing, but you get the full experience only with the lot.

| Plugin | Repo | Used for |
|---|---|---|
| Mushroom | `piitaya/lovelace-mushroom` | KPI tiles, hero headers, chips |
| button-card | `custom-cards/button-card` | Numeric tiles with conditional colours |
| apexcharts-card | `RomRider/apexcharts-card` | Trip-distance bars, efficiency scatter, monthly stats |
| flex-table-card | `custom-cards/flex-table-card` | Trip / charge / journey list tables |

---

## What's in the dashboard

All cards live in `cards/` and can be `!include`-ed from any view. Below: the catalog with what each card surfaces and which logger sensors it needs.

### Trip-level

| Card | Shows | Key sensors |
|---|---|---|
| `cards/trip-detail.yaml` | Single-trip drilldown: KPI tiles, vs-average % + percentile, regen chip, charge-related chip, **route map with numbered waypoints** (Geoapify road-fit if `__GEOAPIFY_KEY__` set; OSM markers otherwise), waypoint list with Google-Maps deep links, full route directions link with waypoints. | `recent_trips`, `last_trip_route`, `last_trip_cost`, `last_trip_score` |
| `cards/last-trip.yaml` | Hero card for the most recent trip on summary views. | `last_trip_*` |
| `cards/current-trip.yaml` | Live KPIs while a trip is in progress. Renders nothing when idle. | `current_trip_*` |
| `cards/trip-list-v2.yaml` | "Last N trips" list with score-coloured rows + distance / cost / efficiency. | `recent_trips` |
| `cards/trip-history.yaml` | Long table with sortable columns. | `recent_trips` |
| `cards/trip-search.yaml` | Filter trips by distance / cost / consumption / origin / destination. | `recent_trips` |

### Journey-level

| Card | Shows | Key sensors |
|---|---|---|
| `cards/last-journey.yaml` | The latest `casa → … → casa` journey — hero with departure/arrival times + stages, aggregates strip, **multi-stage OSM map + Google Maps directions link with waypoints**, "charged during journey" chip. | `last_journey`, `recent_trips` |
| `cards/current-journey.yaml` | Live journey progress (only when one is open). | `current_journey` |
| `cards/journey-history.yaml` | Past journeys with stage breakdown. | `recent_journeys` |

### Charges

| Card | Shows |
|---|---|
| `cards/charges-v2.yaml` | "Last 10 charges" tiles + inline price editor (corrects the most recent or a specific id). |
| `cards/charges-history.yaml` | Full charge history table. |

### Analytics

| Card | Shows |
|---|---|
| `cards/charts.yaml` | Trip distance bars by day. |
| `cards/monthly-stats.yaml` | Per-month rollup (km / kWh / €) dual-axis bars. |
| `cards/monthly-calendar.yaml` | **Current-month grid** with ⚡ / 🔌 indicators per day. |
| `cards/efficiency-charts.yaml` | 30-day rolling consumption + month-over-month delta. |
| `cards/efficiency-vs-distance.yaml` | **Scatter** kWh/100km vs distance (log X), apexcharts. |
| `cards/patterns.yaml` | Trip distribution by hour-of-day and weekday. |
| `cards/trends.yaml` | KPI tiles + sparkline trends. |
| `cards/calendar.yaml` | Native HA calendar entity rendering (uses the integration's `calendar.<device>_activity`). |

### Vehicle status

| Card | Shows | Sensors expected |
|---|---|---|
| `cards/resumen-vehicle.yaml` | Top-level vehicle snapshot: range, SoC, plug state, last/next charge. | logger + your manufacturer integration |
| `cards/battery-status.yaml` | Battery percent, kWh, range, charge curve. | logger + manufacturer |
| `cards/vehicle-status.yaml` | **Doors / windows / hood / trunk + cabin/exterior temp + PM2.5** snapshot (mirrors the BYD app's "Vehicle Details" modal). | `binary_sensor.<vehicle>_door_*`, `_window_*`, `sensor.<vehicle>_cabin_temperature`, etc. |
| `cards/vehicle-energy-snapshot.yaml` | **Day / 50 km / lifetime** consumption tiles + tap-to-refresh button (uses `__FETCH_BUTTON__`). |
| `cards/logbook.yaml` | Plain HA logbook for the vehicle's entities. |

---

## Recovery & corrections — what to use, when

The logger ships several services. The dashboard surfaces them where it makes sense; the rest you call from **Developer Tools → Actions**.

| Symptom | What to call |
|---|---|
| "I see a missing drive in the list" | `ev_trip_logger.recover_missing_trips(since, until?)` — scans recorder odometer history, inserts only the gaps. Existing rows untouched. |
| "This trip's origin / destination is wrong" | `ev_trip_logger.set_trip(trip_id, origin / destination / …)` — patch any field. |
| "Manual charge with wrong timestamps" | `ev_trip_logger.set_charge(charge_id, started_at, ended_at, kwh, soc_start, …)`. |
| "Charge price was wrong" | `ev_trip_logger.set_last_charge_price(price_per_kwh \| total_cost, charge_id?)` — triggers a trip-cost recompute too. |
| "Wrong trip should be deleted" | `ev_trip_logger.delete_last_trip` or `ev_trip_logger.purge_trips(since, until)`. |
| "I want to backfill a drive HA missed" | `ev_trip_logger.log_manual_trip(started_at, ended_at, distance_km \| odo bounds, …)` — applies the journey state machine too. |

Want a one-click button on the dashboard? Drop this into any card:

```yaml
type: button
name: Recuperar trips de los últimos 7 días
icon: mdi:database-refresh
tap_action:
  action: call-service
  service: ev_trip_logger.recover_missing_trips
  data:
    since: "{{ (now() - timedelta(days=7)).isoformat() }}"
  confirmation:
    text: ¿Escanear los últimos 7 días en busca de trips no registrados?
```

---

## ABRP integration

When the logger is configured with ABRP credentials, the dashboard automatically gets:
- `switch.abrp_push` — toggle push on/off (default ON; survives restarts).
- `sensor.<device>_abrp_next_charge_soc` — target SoC of the next stop while a route is active.

Replicate the legacy "ABRP only while driving" pattern with the snippet in the [logger README](https://github.com/boraita/hass-ev-trip-logger#abrp-setup-optional).

---

## Tips

- **Performance**: every list-attribute sensor (`recent_trips`, `tops`, `monthly_history`, …) is recorder-excluded by the integration. Your DB stays small even with 1000s of trips.
- **Map quality**: with `__GEOAPIFY_KEY__` the trip-detail route is fit to actual roads (free tier 3000 req/day). Without it you get straight-line OSM markers.
- **Confidence badges**: when a trip's `confidence` is `reconstructed_polling_paused` or `reconstructed_recovery`, render a small warning chip. Example Jinja:
  ```jinja
  {% set c = t.confidence or 'live' %}
  {% if c.startswith('reconstructed') %}⚠️ Baja confianza{% endif %}
  ```
- **Multiple cars**: deploy two copies of the dashboard with different placeholder values, or use one dashboard and stack two-column layouts (one per `__DEVICE__`).

---

## Reporting issues

Issues that look like dashboard rendering bugs (Jinja errors, missing tiles): open here.
Issues with the underlying trip/charge data: open in **[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger/issues)** with the relevant log lines.

---

## License

MIT.
