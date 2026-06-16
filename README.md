# EV Trip Dashboard

A polished multi-view Home Assistant dashboard powered by **[hass-ev-trip-logger](https://github.com/boraita/hass-ev-trip-logger)** (**v0.5.60+** required for battery health / SoH / weather / seasonal cards). Inspired by the BYD mobile app, but the trip / charge / journey data comes from the logger sensors, so it works with **any car**: BYD, Tesla, OVMS, dongle setups, even fully manual entry.

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

### Battery health (logger v0.5.54+)

| Sensor / attribute | Used for |
|---|---|
| `sensor.__DEVICE___battery_soh` | Observed % of declared capacity actually delivered. Stays at 100 until the calibration kicks in (5+ charges with ΔSoC ≥ 30 %). Attributes carry `calibrated_capacity_kwh`, `declared_capacity_kwh`, `degradation_kwh_per_year`, full `history[]`. |
| `sensor.__DEVICE___expected_battery_soh` | Modelled SoH for this car's km/age/chemistry/climate/habits. Attributes break the loss into `year1_knee`, `calendar`, `cycle`, `climate_hot`, `dcfc`, `soc_habit`. `confidence` is low/medium/high based on what optional config you've filled. |
| `sensor.__DEVICE___battery_health_vs_expected` | Enum tile: `calibrating` / `ahead` (>+2 pp) / `on_track` (±2 pp) / `behind` (<−2 pp). Attributes: `observed_soh_pct`, `expected_soh_pct`, `delta_pp`. |

Drop-in **mushroom + apexcharts** card for the trio:

```yaml
type: vertical-stack
cards:
  - type: custom:mushroom-template-card
    primary: |
      {% set d = state_attr('sensor.__DEVICE___battery_health_vs_expected','delta_pp') %}
      Salud de batería
    secondary: |
      {{ states('sensor.__DEVICE___battery_soh') }} % observado · {{ states('sensor.__DEVICE___expected_battery_soh') }} % esperado
    icon: mdi:battery-heart-variant
    icon_color: |
      {% set s = states('sensor.__DEVICE___battery_health_vs_expected') %}
      {{ {'ahead':'green','on_track':'blue','behind':'red','calibrating':'grey'}[s] | default('grey') }}
    badge_icon: |
      {% set s = states('sensor.__DEVICE___battery_health_vs_expected') %}
      {{ {'ahead':'mdi:trending-up','on_track':'mdi:approximately-equal','behind':'mdi:trending-down','calibrating':'mdi:dots-horizontal'}[s] | default('mdi:help') }}

  # Long-term capacity curve from capacity_history
  - type: custom:apexcharts-card
    header:
      title: Capacidad efectiva (kWh)
      show: true
    graph_span: 365d
    series:
      - entity: sensor.__DEVICE___battery_soh
        attribute: history
        data_generator: |
          return entity.attributes.history.map(snap => [
            new Date(snap.observed_at).getTime(),
            snap.calibrated_kwh
          ]);
        type: line
        stroke_width: 2

  # Loss breakdown — see WHERE the modeled degradation comes from
  - type: custom:mushroom-template-card
    primary: Componentes del SoH esperado
    secondary: |
      {% set f = state_attr('sensor.__DEVICE___expected_battery_soh','factors') or {} %}
      Year1 {{ f.year1_knee }} · Calendar {{ f.calendar }} · Cycle {{ f.cycle }}
      · Hot {{ f.climate_hot }} · DCFC {{ f.dcfc }} · SoC {{ f.soc_habit }}
    icon: mdi:scale-balance
```

### Weather & seasonal analytics (logger v0.5.54+)

When the logger is configured with `weather_entity` (any `weather.*` — AEMET, Met.no, OpenWeatherMap), every trip is enriched with `ambient_temp_c`, `humidity_pct`, `wind_kmh`, `precipitation_mm`, `weather_condition`. Three new aggregate sensors are exposed:

| Sensor | State | Attributes |
|---|---|---|
| `sensor.__DEVICE___consumption_by_season` | Current season's avg consumption (kWh/100km) | `by_season: {winter, spring, summer, autumn}` each with `{trips, distance_km, energy_kwh, avg_consumption_kwh_100km, avg_ambient_temp_c}` |
| `sensor.__DEVICE___consumption_by_time_of_day` | Current bucket's avg | `by_time: {night, morning, midday, afternoon, evening}` |
| `sensor.__DEVICE___consumption_by_temp_bucket` | Cold / cool / mild / warm / hot bucket your CAR temp probe is in | `by_bucket: {bucket→avg}` (uses `exterior_temp_sensor`) |

Side-by-side season bars (apexcharts):

```yaml
type: custom:apexcharts-card
header:
  title: Consumo por estación
  show: true
chart_type: bar
graph_span: 1d  # static, data is lifetime
series:
  - entity: sensor.__DEVICE___consumption_by_season
    attribute: by_season
    data_generator: |
      const b = entity.attributes.by_season || {};
      const order = ['winter','spring','summer','autumn'];
      return order.map(k => [Date.now() + order.indexOf(k)*86400000,
                             (b[k]||{}).avg_consumption_kwh_100km || 0]);
    type: column
    color: '#7eb3ff'
```

### Trip attributes new in v0.5.50–v0.5.54

The `sensor.__DEVICE___recent_trips` attribute object now carries:

| Field | Meaning |
|---|---|
| `confidence` | `live` / `reconstructed` / `reconstructed_polling_paused` / `reconstructed_recovery` / `orphan` / `orphan_odo_only` |
| `driver` | Who drove (state of the configured driver sensor) |
| `ambient_temp_c` | Avg of weather start/end snapshots |
| `weather_condition` | sunny / cloudy / rainy / snowy / ... |
| `humidity_pct`, `wind_kmh`, `precipitation_mm` | Weather extras |
| `gps_distance_km` | Haversine sum over the route — useful sanity check against `distance_km` (odometer-derived) |
| `kwh_charged_before` / `kwh_charged_during` | kWh added by charges before/inside this trip's window |
| `score` | Recomputed each render with the per-car calibrated baseline |

And at the top level of `recent_trips` attributes:

| Field | Meaning |
|---|---|
| `score_baseline_kwh_100km` | The kWh/100km value that maps to 10/10 for THIS car (calibration falls back to 14.5 if not enough history) |
| `score_baseline_trip_count` | How many eligible trips fed the calibration |
| `effective_battery_capacity_kwh` | Calibrated pack capacity (= declared while < 5 valid charges) |
| `battery_capacity_calibration_charges` | n of charges that fed the capacity median |

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

## Tracking checklist (logger side)

The dashboard renders only what the logger reports. For the new battery-health and weather cards to have data, configure these in the logger's *Configure* dialog (HA → Settings → Devices & Services → EV Trip Logger):

- [ ] **Weather entity** (`weather.aemet` / Met.no / OpenWeatherMap) → unlocks the season / time-of-day / temp-bucket cards and the `climate_hot` factor of the SoH model.
- [ ] **Battery chemistry** (`lfp` / `nmc` / `nca`) → curve constants for the expected SoH.
- [ ] **Vehicle first-registered date** → real calendar age for the SoH model (raises `confidence` to `high`).
- [ ] Drive normally for **5+ charges with ΔSoC ≥ 30 %** so the calibrated capacity kicks in and `battery_health_vs_expected` leaves `calibrating`.

Full checklist in the logger README's [Get the most out of it](https://github.com/boraita/hass-ev-trip-logger#get-the-most-out-of-it).

---

## Tips

- **Performance**: every list-attribute sensor (`recent_trips`, `tops`, `monthly_history`, `capacity_history` (via attribute), …) is recorder-excluded by the integration. Your DB stays small even with 1000s of trips.
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
