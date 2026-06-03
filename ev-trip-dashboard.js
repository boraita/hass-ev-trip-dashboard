/*! EV Trip Dashboard — Lovelace dashboard strategy (HACS plugin).
 *
 * Auto-generates the full EV Trip dashboard (Driving / Trips / History /
 * Charts / Stats) from your trip-logger device — no __DEVICE__ find/replace.
 *
 * Usage (a dashboard's raw config):
 *   strategy:
 *     type: custom:ev-trip
 *     # device: sealion_7      # optional — auto-detected from *_recent_trips
 *     # vehicle: byd_sealion_7 # optional — car integration (range/odometer/map/temps)
 *
 * The Trips search/sort/filter still needs the input helpers in
 * packages/trip-list-helpers.yaml (a dashboard strategy can't create helpers).
 * If they're absent the list shows everything unfiltered.
 */

const CUR_MAP = "{'EUR':'€','USD':'$','GBP':'£'}";

// ---- helpers -------------------------------------------------------------
function detectDevice(hass) {
  // First sensor.<slug>_recent_trips wins.
  for (const id in hass.states) {
    const m = id.match(/^sensor\.(.+)_recent_trips$/);
    if (m) return m[1];
  }
  return null;
}

function has(hass, entity) {
  return Object.prototype.hasOwnProperty.call(hass.states, entity);
}

// True only when the entity exists AND currently has a usable value — used to
// drop optional metrics (max speed/power, regen, temperature) that are blank
// because the logger has no speed/power/temperature source sensor configured.
function hasVal(hass, entity) {
  const s = hass.states[entity];
  return !!s && !["unknown", "unavailable", "none", ""].includes(String(s.state).toLowerCase());
}

const heading = (h, icon) => ({ type: "heading", heading: h, icon });
const md = (content) => ({ type: "markdown", content });
const grid = (cards) => ({ type: "grid", cards });

// ---- views ---------------------------------------------------------------
function drivingView(D, V, hass) {
  const status = [
    heading("Status", "mdi:car-electric"),
    {
      type: "gauge",
      entity: `sensor.${D}_battery_percent`,
      name: "Battery",
      min: 0,
      max: 100,
      needle: true,
      severity: { green: 50, yellow: 20, red: 0 },
    },
  ];

  // Battery / range / odometer. Logger gives a real-world range estimate;
  // the car integration (optional) gives its own range + odometer.
  const kpis = [
    { entity: `sensor.${D}_battery_energy`, name: "In battery" },
    { entity: `sensor.${D}_energy_to_full_charge`, name: "To 100%" },
  ];
  if (has(hass, `sensor.${D}_range_at_recent_efficiency`))
    kpis.push({ entity: `sensor.${D}_range_at_recent_efficiency`, name: "Real range" });
  if (has(hass, `sensor.${V}_range`))
    kpis.push({ entity: `sensor.${V}_range`, name: "Range" });
  if (has(hass, `sensor.${V}_odometer`))
    kpis.push({ entity: `sensor.${V}_odometer`, name: "Odometer" });
  // Modern tile cards (one per KPI) instead of a flat glance.
  for (const k of kpis) status.push({ type: "tile", entity: k.entity, name: k.name });

  if (has(hass, `sensor.${V}_exterior_temperature`))
    status.push({ type: "tile", entity: `sensor.${V}_exterior_temperature`, name: "Outside", color: "orange" });
  if (has(hass, `sensor.${V}_cabin_temperature`))
    status.push({ type: "tile", entity: `sensor.${V}_cabin_temperature`, name: "Cabin", color: "orange" });

  // Live-trip glance — shown only while a trip is actively tracked, so these
  // metrics populate live (they're sampled when vehicle_on is on). Include any
  // that the logger exposes; synthetic/backfilled trips never open this card.
  const liveEnts = [
    { entity: `sensor.${D}_current_trip_distance`, name: "km" },
    { entity: `sensor.${D}_current_trip_duration`, name: "min" },
    { entity: `sensor.${D}_current_trip_energy`, name: "kWh" },
    { entity: `sensor.${D}_current_trip_consumption`, name: "kWh/100" },
    { entity: `sensor.${D}_current_trip_average_speed`, name: "km/h" },
    { entity: `sensor.${D}_current_trip_battery_used`, name: "% used" },
  ];
  for (const [s, n] of [
    ["current_trip_max_speed", "km/h max"],
    ["current_trip_max_power", "kW max"],
    ["current_trip_avg_temperature", "°C"],
    ["current_trip_regen_energy", "regen"],
    ["current_trip_cost", "cost"],
    ["current_trip_score", "score"],
  ]) {
    if (has(hass, `sensor.${D}_${s}`)) liveEnts.push({ entity: `sensor.${D}_${s}`, name: n });
  }

  const lastEnts = [
    { entity: `sensor.${D}_last_trip_distance`, name: "km" },
    { entity: `sensor.${D}_last_trip_duration`, name: "min" },
    { entity: `sensor.${D}_last_trip_energy`, name: "kWh" },
    { entity: `sensor.${D}_last_trip_consumption`, name: "kWh/100" },
    { entity: `sensor.${D}_last_trip_cost`, name: "cost" },
    { entity: `sensor.${D}_last_trip_score`, name: "score" },
  ];
  for (const [s, n] of [
    ["last_trip_average_speed", "km/h"],
    ["last_trip_max_speed", "km/h max"],
    ["last_trip_max_power", "kW max"],
    ["last_trip_regen_energy", "regen"],
    ["last_trip_battery_used", "% used"],
    ["last_trip_avg_temperature", "°C"],
  ]) {
    if (hasVal(hass, `sensor.${D}_${s}`)) lastEnts.push({ entity: `sensor.${D}_${s}`, name: n });
  }

  const now = [
    heading("Now", "mdi:speedometer"),
    {
      type: "conditional",
      conditions: [{ condition: "numeric_state", entity: `sensor.${D}_current_trip_distance`, above: 0 }],
      card: { type: "glance", title: "🟢 Trip in progress", columns: 4, entities: liveEnts },
    },
    {
      type: "conditional",
      conditions: [{ condition: "numeric_state", entity: `sensor.${D}_current_trip_distance`, below: 0.001 }],
      card: {
        type: "vertical-stack",
        cards: [
          md(
            `### Last trip\n` +
            `{%- set ended = state_attr('sensor.${D}_last_trip_distance', 'ended_at') %}\n` +
            `{%- if ended %}\n` +
            `_{{ as_timestamp(ended) | timestamp_custom('%d/%m %H:%M') }} — {{ state_attr('sensor.${D}_last_trip_distance', 'origin') or '?' }} → {{ state_attr('sensor.${D}_last_trip_distance', 'destination') or '?' }}_\n` +
            `{%- endif %}`
          ),
          { type: "glance", columns: 3, entities: lastEnts },
        ],
      },
    },
    md(
      `{%- set CUR = ${CUR_MAP} %}\n` +
      `{%- set s = states('sensor.${D}_current_journey') | int(0) %}\n` +
      `{%- if s > 0 %}\n` +
      `### 🟢 Journey in progress\n` +
      `- **{{ s }} {% if s == 1 %}stage{% else %}stages{% endif %}** so far\n` +
      `- Distance: **{{ state_attr('sensor.${D}_current_journey', 'distance_km') | default('—', true) }} km**\n` +
      `- Energy: **{{ state_attr('sensor.${D}_current_journey', 'energy_kwh') | default('—', true) }} kWh**\n` +
      `- Cost: **{{ state_attr('sensor.${D}_current_journey', 'cost') | default('—', true) }} €**\n` +
      `{%- if state_attr('sensor.${D}_current_journey', 'stage_active') %}\n` +
      `- _Stage moving right now_\n` +
      `{%- endif %}\n` +
      `{%- else %}\n` +
      `{%- set ls = states('sensor.${D}_last_journey') %}\n` +
      `{%- if ls in ('unknown', 'unavailable', '0', 'None') %}\n` +
      `### Last journey\n_No completed journeys yet._\n` +
      `{%- else %}\n` +
      `### Last journey\n` +
      `{%- set ended = state_attr('sensor.${D}_last_journey', 'ended_at') %}\n` +
      `{%- if ended %}\n_Ended {{ as_timestamp(ended) | timestamp_custom('%d/%m %H:%M') }}_\n{%- endif %}\n` +
      `- **{{ ls }} stages**\n` +
      `- Distance: **{{ state_attr('sensor.${D}_last_journey', 'distance_km') | default('—', true) }} km**\n` +
      `- Energy: **{{ state_attr('sensor.${D}_last_journey', 'energy_kwh') | default('—', true) }} kWh**\n` +
      `- Cost: **{{ state_attr('sensor.${D}_last_journey', 'cost') | default('—', true) }} €**\n` +
      `{%- endif %}\n{%- endif %}`
    ),
  ];

  // Charging-now card from the logger's live charge sensors.
  if (has(hass, `sensor.${D}_current_charge_power`)) {
    now.push({
      type: "conditional",
      conditions: [{ condition: "state", entity: `sensor.${D}_charge_in_progress`, state: "charging" }],
      card: {
        type: "glance",
        title: "⚡ Charging now",
        columns: 3,
        entities: [
          { entity: `sensor.${D}_current_charge_power`, name: "kW" },
          { entity: `sensor.${D}_current_charge_energy`, name: "kWh" },
          { entity: `sensor.${D}_current_charge_duration`, name: "min" },
          { entity: `sensor.${D}_current_charge_price_per_kwh`, name: "€/kWh" },
          { entity: `sensor.${D}_current_charge_cost`, name: "cost" },
          { entity: `sensor.${D}_current_charge_type`, name: "type" },
        ],
      },
    });
  }

  const sections = [grid(status), grid(now)];

  // Map (car integration only).
  if (has(hass, `device_tracker.${V}_location`)) {
    sections.push(grid([heading("Where", "mdi:map-marker"), { type: "map", default_zoom: 11, entities: [`device_tracker.${V}_location`] }]));
  }

  return { title: "Driving", path: "driving", icon: "mdi:car", type: "sections", max_columns: 2, sections };
}

function recordsCard(D) {
  return md(
    `{%- set CUR = ${CUR_MAP} %}\n` +
    `{%- set rsrc = 'sensor.${D}_trip_records' %}\n` +
    `{%- set best = state_attr(rsrc, 'best_score') %}\n` +
    `{%- if best is mapping %}\n` +
    `{%- set longest = state_attr(rsrc, 'longest') %}\n` +
    `{%- set efficient = state_attr(rsrc, 'most_efficient') %}\n` +
    `{%- set cheapest = state_attr(rsrc, 'cheapest') %}\n` +
    `### 🏆 Records ({{ states(rsrc) }} trips all-time)\n` +
    `| Record | When | Where | Value |\n|---|---|---|---:|\n` +
    `{%- if best.value is defined %}\n| 🥇 Best score | {{ as_timestamp(best.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ best.destination or '—' }} | **{{ best.value }}** |\n{%- endif %}\n` +
    `{%- if longest %}\n| 📏 Longest | {{ as_timestamp(longest.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ longest.destination or '—' }} | **{{ longest.value }} km** |\n{%- endif %}\n` +
    `{%- if efficient %}\n| 🪫 Most efficient | {{ as_timestamp(efficient.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ efficient.destination or '—' }} | **{{ efficient.value }} kWh/100** |\n{%- endif %}\n` +
    `{%- if cheapest %}\n| 💶 Cheapest | {{ as_timestamp(cheapest.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ cheapest.destination or '—' }} | **{{ cheapest.value }} {{ CUR.get(cheapest.currency, cheapest.currency or '€') }}** |\n{%- endif %}\n` +
    `{%- else %}\n` +
    `{%- set trips = state_attr('sensor.${D}_recent_trips', 'trips') or [] %}\n` +
    `{%- if trips | length == 0 %}\n### 🏆 Trip records\n_No trips recorded yet._\n` +
    `{%- else %}\n` +
    `{%- set scored = trips | rejectattr('score', 'none') | list %}\n` +
    `{%- set with_dist = trips | rejectattr('distance_km', 'none') | list %}\n` +
    `{%- set with_eff = trips | rejectattr('consumption_kwh_100km', 'none') | list %}\n` +
    `{%- set with_cost = trips | rejectattr('cost', 'none') | list %}\n` +
    `{%- set b = (scored | sort(attribute='score', reverse=true) | first) if scored else none %}\n` +
    `{%- set lo = (with_dist | sort(attribute='distance_km', reverse=true) | first) if with_dist else none %}\n` +
    `{%- set ef = (with_eff | sort(attribute='consumption_kwh_100km') | first) if with_eff else none %}\n` +
    `{%- set ch = (with_cost | sort(attribute='cost') | first) if with_cost else none %}\n` +
    `### 🏆 Trip records (last {{ trips | length }} trips)\n` +
    `| Record | When | Where | Value |\n|---|---|---|---:|\n` +
    `{%- if b %}\n| 🥇 Best score | {{ as_timestamp(b.ended_at) | timestamp_custom('%d/%m') }} | {{ b.destination or '—' }} | **{{ b.score }}** |\n{%- endif %}\n` +
    `{%- if lo %}\n| 📏 Longest | {{ as_timestamp(lo.ended_at) | timestamp_custom('%d/%m') }} | {{ lo.destination or '—' }} | **{{ lo.distance_km }} km** |\n{%- endif %}\n` +
    `{%- if ef %}\n| 🪫 Most efficient | {{ as_timestamp(ef.ended_at) | timestamp_custom('%d/%m') }} | {{ ef.destination or '—' }} | **{{ ef.consumption_kwh_100km }} kWh/100** |\n{%- endif %}\n` +
    `{%- if ch %}\n| 💶 Cheapest | {{ as_timestamp(ch.ended_at) | timestamp_custom('%d/%m') }} | {{ ch.destination or '—' }} | **{{ ch.cost }} {{ CUR.get(ch.currency, ch.currency or '€') }}** |\n{%- endif %}\n` +
    `{%- endif %}\n{%- endif %}`
  );
}

function tripsView(D) {
  return {
    title: "Trips",
    path: "trips",
    icon: "mdi:map-search",
    type: "sections",
    max_columns: 2,
    sections: [
      grid([heading("Records", "mdi:trophy"), recordsCard(D)]),
      grid([
        heading("Search & filter", "mdi:filter-variant"),
        {
          type: "entities",
          show_header_toggle: false,
          entities: [
            { entity: `input_text.${D}_trip_search`, name: "Search (destination / date)" },
            { entity: `input_select.${D}_trip_sort`, name: "Sort by" },
            { entity: `input_select.${D}_trip_window`, name: "Period" },
            { type: "divider" },
            { entity: `input_number.${D}_trip_min_distance`, name: "Min distance (km)" },
            { entity: `input_number.${D}_trip_min_score`, name: "Min score" },
            { entity: `input_number.${D}_trip_max_cost`, name: "Max cost" },
            { entity: `input_number.${D}_trip_max_consumption`, name: "Max kWh/100" },
          ],
        },
        { type: "custom:ev-trip-list-card", device: D, title: "Trips" },
      ]),
    ],
  };
}

function historyView(D) {
  return {
    title: "History",
    path: "history",
    icon: "mdi:format-list-bulleted",
    type: "sections",
    max_columns: 2,
    sections: [
      grid([
        heading("Journeys", "mdi:road-variant"),
        { type: "custom:ev-trip-history-card", device: D, kind: "journeys", title: "Journeys" },
      ]),
      grid([
        heading("Charges", "mdi:ev-station"),
        { type: "custom:ev-trip-history-card", device: D, kind: "charges", title: "Charges" },
      ]),
    ],
  };
}

function chartsView(D, hass) {
  const monthly = [
    heading("Monthly totals", "mdi:chart-bar"),
    statBar("Distance per month", `sensor.${D}_distance_this_month`),
    statBar("Energy consumed per month", `sensor.${D}_energy_this_month`),
    statBar("Charging cost per month", `sensor.${D}_spent_on_charging_this_month`),
  ];

  const trends = [
    heading("Trends", "mdi:chart-line"),
    {
      type: "statistics-graph",
      title: "Avg consumption (kWh/100km, 30-day rolling)",
      entities: [`sensor.${D}_avg_consumption_30_days`],
      chart_type: "line",
      period: "day",
      stat_types: ["mean"],
      days_to_show: 60,
    },
  ];

  // AC vs DC charge price (both logger sensors, no state_class → history-graph).
  const acdc = [];
  if (has(hass, `sensor.${D}_avg_ac_charge_price_30_days`))
    acdc.push({ entity: `sensor.${D}_avg_ac_charge_price_30_days`, name: "AC €/kWh" });
  if (has(hass, `sensor.${D}_avg_dc_fast_charge_price_30_days`))
    acdc.push({ entity: `sensor.${D}_avg_dc_fast_charge_price_30_days`, name: "DC €/kWh" });
  acdc.push({ entity: `sensor.${D}_avg_charge_price_30_days`, name: "Avg €/kWh" });
  trends.push({ type: "history-graph", title: "Charge price (€/kWh)", hours_to_show: 720, entities: acdc });

  trends.push({
    type: "history-graph",
    title: "Battery (24h)",
    hours_to_show: 24,
    entities: [{ entity: `sensor.${D}_battery_percent`, name: "SoC %" }],
  });

  // Consumption vs ambient temperature (from the by_bucket attribute).
  if (has(hass, `sensor.${D}_consumption_by_temperature`)) {
    trends.push(
      md(
        `{%- set src = 'sensor.${D}_consumption_by_temperature' %}\n` +
        `{%- set bb = state_attr(src, 'by_bucket') %}\n` +
        `{%- set step = state_attr(src, 'bucket_size_c') | int(5) %}\n` +
        `### 🌡️ Consumption by temperature\n` +
        `{%- if bb %}\n| Temp (°C) | kWh/100 |\n|---|---:|\n` +
        `{%- for k, v in bb.items() %}\n| {{ k }}–{{ k | int + step }} | {{ v }} |\n{%- endfor %}\n` +
        `{%- else %}\n_Not enough temperature data yet._\n{%- endif %}`
      )
    );
  }

  trends.push({
    type: "logbook",
    title: "Recent activity (7d)",
    hours_to_show: 168,
    entities: [`sensor.${D}_last_trip_distance`, `sensor.${D}_last_charge_energy`],
  });

  return { title: "Charts", path: "charts", icon: "mdi:chart-line", type: "sections", max_columns: 2, sections: [grid(monthly), grid(trends)] };
}

function statBar(title, entity) {
  return { type: "statistics-graph", title, entities: [entity], chart_type: "bar", period: "month", stat_types: ["sum"], days_to_show: 365 };
}

function statsView(D, hass) {
  const driving = [
    `sensor.${D}_distance_today`,
    `sensor.${D}_distance_this_week`,
    `sensor.${D}_distance_this_month`,
    `sensor.${D}_distance_this_year`,
    { type: "divider" },
    `sensor.${D}_energy_this_month`,
    `sensor.${D}_cost_this_month`,
    `sensor.${D}_trips_this_month`,
  ];
  if (has(hass, `sensor.${D}_trips_today`)) driving.splice(4, 0, `sensor.${D}_trips_today`);
  driving.push({ type: "divider" }, `sensor.${D}_avg_consumption_30_days`);
  if (has(hass, `sensor.${D}_range_at_recent_efficiency`)) driving.push(`sensor.${D}_range_at_recent_efficiency`);

  const charging = [
    `sensor.${D}_charges_this_month`,
    `sensor.${D}_energy_charged_this_month`,
    `sensor.${D}_spent_on_charging_this_month`,
    { type: "divider" },
    `sensor.${D}_avg_charge_price_30_days`,
  ];
  if (has(hass, `sensor.${D}_avg_ac_charge_price_30_days`)) charging.push(`sensor.${D}_avg_ac_charge_price_30_days`);
  if (has(hass, `sensor.${D}_avg_dc_fast_charge_price_30_days`)) charging.push(`sensor.${D}_avg_dc_fast_charge_price_30_days`);
  if (has(hass, `sensor.${D}_last_charge_type`)) charging.push(`sensor.${D}_last_charge_type`);
  charging.push(`sensor.${D}_charge_in_progress`);

  return {
    title: "Stats",
    path: "stats",
    icon: "mdi:chart-box",
    type: "sections",
    max_columns: 2,
    sections: [
      grid([heading("Driving", "mdi:steering"), { type: "entities", entities: driving }]),
      grid([heading("Charging", "mdi:ev-station"), { type: "entities", entities: charging }]),
    ],
  };
}

// ==========================================================================
// Custom card: a pretty, reactive trip list (chips + colored score pill).
// Replaces the markdown table when the plugin is installed; honours the same
// input helpers for search / sort / period / numeric filters.
// ==========================================================================
const _fmtDate = (iso, withYear) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  const date = withYear
    ? `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
    : `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const _scoreColor = (s) =>
  s == null
    ? "var(--disabled-text-color)"
    : s >= 8
    ? "var(--success-color, #43a047)"
    : s >= 7
    ? "var(--light-green-color, #7cb342)"
    : s >= 5
    ? "var(--warning-color, #fbc02d)"
    : "var(--error-color, #e53935)";
const _esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

class EvTripListCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  getCardSize() {
    return 8;
  }
  connectedCallback() {
    // Event delegation: one click listener toggles the tapped trip's detail.
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const trip = ev.target && ev.target.closest && ev.target.closest(".trip");
      if (!trip || !this.contains(trip)) return;
      const id = trip.getAttribute("data-trip-id");
      if (id == null) return;
      this._openTripId = String(this._openTripId) === String(id) ? null : id;
      this._render();
    });
  }
  _s(id) {
    const e = this._hass.states[id];
    return e ? e.state : undefined;
  }
  _n(id, dflt) {
    const v = parseFloat(this._s(id));
    return isNaN(v) ? dflt : v;
  }
  _filteredTrips() {
    const hass = this._hass;
    const D = this._device || detectDevice(hass);
    this._device = D;
    const rt = hass.states[`sensor.${D}_recent_trips`];
    let trips = (rt && rt.attributes && Array.isArray(rt.attributes.trips) && rt.attributes.trips) || [];
    const total = trips.length;
    let raw = this._s(`input_text.${D}_trip_search`);
    const q = !raw || ["unknown", "unavailable", "None"].includes(raw) ? "" : raw.toLowerCase().trim();
    const sort = this._s(`input_select.${D}_trip_sort`) || "Newest";
    const win = this._s(`input_select.${D}_trip_window`) || "All";
    const minD = this._n(`input_number.${D}_trip_min_distance`, 0);
    const minS = this._n(`input_number.${D}_trip_min_score`, 0);
    const maxC = this._n(`input_number.${D}_trip_max_cost`, 1e9);
    const maxE = this._n(`input_number.${D}_trip_max_consumption`, 1e9);

    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(midnight.getTime() - ((now.getDay() + 6) % 7) * 864e5);
    const inWindow = (t) => {
      if (win === "All") return true;
      const d = new Date(t.ended_at);
      if (isNaN(d)) return true;
      if (win === "Today") return d >= midnight;
      if (win === "This week") return d >= weekStart;
      if (win === "This month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      return true;
    };
    let rows = trips.filter((t) => {
      const label = `${t.origin || ""} ${t.destination || ""} ${_fmtDate(t.ended_at)}`.toLowerCase();
      if (q && !label.includes(q)) return false;
      if (t.distance_km != null && t.distance_km < minD) return false;
      if (t.score != null && t.score < minS) return false;
      if (t.cost != null && t.cost > maxC) return false;
      if (t.consumption_kwh_100km != null && t.consumption_kwh_100km > maxE) return false;
      return inWindow(t);
    });
    const by = (k, dir = 1) => (a, b) => ((a[k] ?? 0) - (b[k] ?? 0)) * dir;
    const byDate = (dir) => (a, b) => (new Date(a.ended_at) - new Date(b.ended_at)) * dir;
    const sorters = {
      Newest: byDate(-1), Oldest: byDate(1),
      Longest: by("distance_km", -1), Shortest: by("distance_km", 1),
      "Best score": by("score", -1), "Worst score": by("score", 1),
      "Most efficient": by("consumption_kwh_100km", 1), "Least efficient": by("consumption_kwh_100km", -1),
      Cheapest: by("cost", 1), Priciest: by("cost", -1),
    };
    rows = rows.slice().sort(sorters[sort] || byDate(-1));
    return { rows, total };
  }
  _render() {
    if (!this._hass) return;
    // Lazy-bind the click delegation in case connectedCallback hasn't run.
    if (!this._clickBound && typeof this.addEventListener === "function") {
      this.connectedCallback();
    }
    const { rows, total } = this._filteredTrips();
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const DASH = "—";
    const fmtNum = (v, dp) => (v == null || isNaN(v) ? DASH : dp == null ? String(v) : Number(v).toFixed(dp));

    // Mean efficiency of the filtered set (for "Comparado con tu media").
    const effVals = rows.map((t) => t.consumption_kwh_100km).filter((v) => v != null && !isNaN(v) && v !== 0);
    const effMean = effVals.length ? effVals.reduce((a, b) => a + b, 0) / effVals.length : null;
    // Scores of the filtered set (for percentile).
    const scoreVals = rows.map((t) => t.score).filter((v) => v != null && !isNaN(v));

    // Builds the BYD-app-style "Detalle del viaje" panel for one trip.
    const detailHtml = (t) => {
      const sym = cur[t.currency] || t.currency || "€";
      const scoreNum = t.score != null ? Number(t.score).toFixed(1) : DASH;
      const tile = (icon, label, value, unit) => `
        <div class="d-tile">
          <ha-icon class="d-tile-icon" icon="${icon}"></ha-icon>
          <div class="d-tile-label">${_esc(label)}</div>
          <div class="d-tile-value">${value}<span class="d-tile-unit">${unit ? " " + _esc(unit) : ""}</span></div>
        </div>`;

      // Velocidad media — derived, guard divide-by-zero.
      let speed = DASH;
      if (t.distance_km != null && t.duration_min != null && t.duration_min > 0) {
        speed = fmtNum(t.distance_km / (t.duration_min / 60), 1);
      }

      // Comparison rows.
      const cmpRows = [];
      if (t.consumption_kwh_100km != null && t.consumption_kwh_100km !== 0 && effMean != null && effMean !== 0) {
        const pct = ((t.consumption_kwh_100km - effMean) / effMean) * 100;
        const good = pct <= 0; // lower consumption than mean = good
        const sign = good ? "−" : "+";
        const color = good ? "var(--success-color, #43a047)" : "var(--warning-color, #fb8c00)";
        cmpRows.push(
          `<div class="d-cmp-row"><span class="d-cmp-label">Comparado con tu media</span>` +
          `<span class="d-cmp-val" style="color:${color}">${sign}${Math.abs(pct).toFixed(1)}%</span></div>`
        );
      }
      if (t.score != null && scoreVals.length) {
        const better = scoreVals.filter((s) => s >= t.score).length;
        const topPct = (better / scoreVals.length) * 100;
        cmpRows.push(
          `<div class="d-cmp-row"><span class="d-cmp-label">Percentil</span>` +
          `<span class="d-cmp-val" style="color:var(--info-color, #039be5)">Top ${topPct.toFixed(0)}%</span></div>`
        );
      }
      if (t.cost != null && !isNaN(t.cost)) {
        cmpRows.push(
          `<div class="d-cmp-row"><span class="d-cmp-label">Coste Estimado</span>` +
          `<span class="d-cmp-val" style="color:var(--warning-color, #fb8c00)">${fmtNum(t.cost, 2)} ${_esc(sym)}</span></div>`
        );
      }

      return `
        <div class="detail">
          <div class="d-head">
            <div class="d-title">Detalle del viaje</div>
            <div class="d-score">
              <span class="d-score-num" style="color:${_scoreColor(t.score)}">${scoreNum}</span>
              <span class="d-score-max">/10</span>
            </div>
          </div>
          <div class="d-sub">${_fmtDate(t.ended_at, true)}</div>
          <div class="d-grid">
            ${tile("mdi:map-marker-distance", "Distancia", fmtNum(t.distance_km), "km")}
            ${tile("mdi:timer-outline", "Duración", fmtNum(t.duration_min == null ? null : Math.round(t.duration_min)), "min")}
            ${tile("mdi:lightning-bolt", "Consumo", fmtNum(t.energy_kwh), "kWh")}
            ${tile("mdi:chart-line", "Eficiencia", fmtNum(t.consumption_kwh_100km), "kWh/100km")}
          </div>
          <div class="d-tile d-tile--wide">
            <ha-icon class="d-tile-icon" icon="mdi:speedometer"></ha-icon>
            <div class="d-tile-label">Velocidad media</div>
            <div class="d-tile-value">${speed}<span class="d-tile-unit"> km/h</span></div>
          </div>
          ${cmpRows.length ? `<div class="d-cmp">${cmpRows.join("")}</div>` : ""}
        </div>`;
    };

    const col = (label, value, unit, opts) => {
      const o = opts || {};
      const valStyle = o.color ? ` style="color:${o.color}"` : "";
      const valCls = o.big ? "col-val col-val--big" : "col-val";
      const unitHtml = unit ? `<div class="col-unit">${_esc(unit)}</div>` : `<div class="col-unit">&nbsp;</div>`;
      return `<div class="col">
                <div class="col-label">${_esc(label)}</div>
                <div class="${valCls}"${valStyle}>${value}</div>
                ${unitHtml}
              </div>`;
    };

    const rowsHtml = rows.length
      ? rows
          .map((t) => {
            const sym = cur[t.currency] || t.currency || "";
            const score = t.score != null ? Number(t.score).toFixed(1) : DASH;
            const isOpen = t.id != null && String(this._openTripId) === String(t.id);
            return `
            <div class="trip${isOpen ? " trip--open" : ""}" data-trip-id="${_esc(t.id)}">
              <div class="trip-date">${_fmtDate(t.ended_at, true)}</div>
              <div class="cols">
                ${col("Distancia", fmtNum(t.distance_km), "km")}
                ${col("Consumo", fmtNum(t.energy_kwh), "kWh")}
                ${col("Eficiencia", fmtNum(t.consumption_kwh_100km), "kWh/100km")}
                ${col("Coste", fmtNum(t.cost), sym || DASH)}
                ${col("Score", score, "", { big: true, color: _scoreColor(t.score) })}
              </div>
              ${isOpen ? detailHtml(t) : ""}
            </div>`;
          })
          .join("")
      : `<div class="empty">No trips match the current filters.</div>`;

    this.innerHTML = `
      <ha-card>
        <style>
          .head{display:flex;justify-content:space-between;align-items:baseline;
                padding:14px 16px 10px;font-weight:600;font-size:1.05em;}
          .head .count{color:var(--secondary-text-color);font-weight:400;font-size:.82em;}
          .list{display:flex;flex-direction:column;gap:12px;padding:0 12px 14px;}
          .trip{background:var(--secondary-background-color, var(--card-background-color));
                border:1px solid var(--divider-color);border-radius:16px;
                padding:14px 12px 12px;cursor:pointer;transition:border-color .15s ease;}
          .trip:hover{border-color:var(--primary-color);}
          .trip--open{border-color:var(--primary-color);}
          .trip-date{text-align:center;font-weight:700;font-size:1.02em;letter-spacing:.2px;
                     color:var(--primary-text-color);font-variant-numeric:tabular-nums;
                     margin-bottom:12px;}
          .cols{display:flex;align-items:stretch;gap:4px;}
          .col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;
               justify-content:flex-start;text-align:center;gap:2px;}
          .col-label{font-size:.62em;letter-spacing:.06em;text-transform:uppercase;
                     color:var(--secondary-text-color);line-height:1.2;}
          .col-val{font-size:1.12em;font-weight:700;color:var(--primary-text-color);
                   font-variant-numeric:tabular-nums;line-height:1.2;
                   overflow:hidden;text-overflow:ellipsis;max-width:100%;}
          .col-val--big{font-size:1.5em;font-weight:800;}
          .col-unit{font-size:.62em;color:var(--secondary-text-color);line-height:1.2;}
          .empty{padding:24px 16px;text-align:center;color:var(--secondary-text-color);}

          /* ---- Trip detail panel ("Detalle del viaje") ---- */
          .detail{margin-top:14px;padding-top:14px;border-top:1px solid var(--divider-color);
                  display:flex;flex-direction:column;gap:12px;}
          .d-head{display:flex;justify-content:space-between;align-items:flex-start;}
          .d-title{font-weight:700;font-size:1.05em;color:var(--primary-text-color);}
          .d-score{display:flex;align-items:baseline;gap:2px;line-height:1;}
          .d-score-num{font-size:2em;font-weight:800;font-variant-numeric:tabular-nums;}
          .d-score-max{font-size:.8em;color:var(--secondary-text-color);}
          .d-sub{margin-top:-6px;font-size:.85em;color:var(--secondary-text-color);
                 font-variant-numeric:tabular-nums;}
          .d-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
          .d-tile{background:var(--secondary-background-color);
                  border:1px solid var(--divider-color);border-radius:14px;
                  padding:12px 10px;display:flex;flex-direction:column;align-items:center;
                  justify-content:center;text-align:center;gap:4px;}
          .d-tile--wide{width:100%;}
          .d-tile-icon{--mdc-icon-size:20px;color:var(--secondary-text-color);}
          .d-tile-label{font-size:.7em;letter-spacing:.05em;text-transform:uppercase;
                        color:var(--secondary-text-color);}
          .d-tile-value{font-size:1.4em;font-weight:800;color:var(--primary-text-color);
                        font-variant-numeric:tabular-nums;line-height:1.1;}
          .d-tile-unit{font-size:.55em;font-weight:600;color:var(--secondary-text-color);}
          .d-cmp{display:flex;flex-direction:column;gap:8px;margin-top:2px;}
          .d-cmp-row{display:flex;justify-content:space-between;align-items:center;
                     font-size:.95em;}
          .d-cmp-label{color:var(--secondary-text-color);}
          .d-cmp-val{font-weight:800;font-variant-numeric:tabular-nums;}
          @media (max-width:360px){
            .col-label{font-size:.55em;}
            .col-val{font-size:.95em;}
            .col-val--big{font-size:1.3em;}
          }
        </style>
        <div class="head"><span>${_esc(this._config.title || "Trips")}</span>
          <span class="count">Showing ${rows.length} of ${total} trips</span></div>
        <div class="list">${rowsHtml}</div>
      </ha-card>`;
  }
}
customElements.define("ev-trip-list-card", EvTripListCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "ev-trip-list-card",
  name: "EV Trip — list",
  description: "Pretty searchable/sortable trip list for ev-trip-logger.",
});

// ==========================================================================
// Custom card: recent journeys / charges as a styled table. Reads the list
// attribute directly in JS (no markdown card) — robust against frontend
// markdown quirks, and consistent with the trip list.
// ==========================================================================
class EvTripHistoryCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
    this._kind = this._config.kind === "charges" ? "charges" : "journeys";
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  getCardSize() {
    return 4;
  }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    const kind = this._kind;
    const st = this._hass.states[`sensor.${D}_recent_${kind}`];
    const rows = (st && st.attributes && Array.isArray(st.attributes[kind]) && st.attributes[kind]) || [];
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const sym = (c) => cur[c] || c || "€";
    const num = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);

    let head, body;
    if (kind === "journeys") {
      head = `<tr><th>When</th><th>#</th><th class="r">Stages</th><th class="r">km</th><th class="r">kWh</th><th class="r">Cost</th></tr>`;
      body = rows
        .map(
          (j) =>
            `<tr><td>${_fmtDate(j.ended_at)}</td><td>${num(j.journey_id)}</td><td class="r">${num(j.stages)}</td><td class="r">${num(j.distance_km)}</td><td class="r">${num(j.energy_kwh)}</td><td class="r">${num(j.cost)} ${j.cost != null ? _esc(sym(j.currency)) : ""}</td></tr>`
        )
        .join("");
    } else {
      head = `<tr><th>When</th><th>Where</th><th class="r">kWh</th><th class="r">€/kWh</th><th class="r">Total</th></tr>`;
      body = rows
        .map(
          (c) =>
            `<tr><td>${_fmtDate(c.ended_at)}</td><td>${_esc(c.location || "—")}${c.type ? ` <span class="muted">(${_esc(c.type)})</span>` : ""}</td><td class="r">${num(c.kwh)}</td><td class="r">${num(c.price_per_kwh)}</td><td class="r">${num(c.total_cost)} ${c.total_cost != null ? _esc(sym(c.currency)) : ""}</td></tr>`
        )
        .join("");
    }

    const inner = rows.length
      ? `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
      : `<div class="empty">No ${kind} recorded yet.</div>`;

    this.innerHTML = `
      <ha-card>
        <style>
          .head{padding:12px 16px 6px;font-weight:600;}
          table{width:100%;border-collapse:collapse;font-size:.9em;}
          th,td{padding:7px 16px;text-align:left;border-top:1px solid var(--divider-color);white-space:nowrap;}
          th{color:var(--secondary-text-color);font-weight:500;font-size:.85em;}
          td{color:var(--primary-text-color);font-variant-numeric:tabular-nums;}
          .r{text-align:right;}
          .muted{color:var(--secondary-text-color);}
          .empty{padding:16px;color:var(--secondary-text-color);}
        </style>
        <div class="head">${_esc(this._config.title || (kind === "journeys" ? "Journeys" : "Charges"))}</div>
        ${inner}
      </ha-card>`;
  }
}
customElements.define("ev-trip-history-card", EvTripHistoryCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-history-card", name: "EV Trip — journeys/charges", description: "Recent journeys or charges as a table." });

// ---- strategy ------------------------------------------------------------
class EvTripDashboardStrategy {
  static async generate(config, hass) {
    const D = config.device || detectDevice(hass);
    const V = config.vehicle || D;
    if (!D) {
      return {
        title: "EV Trip",
        views: [
          {
            title: "EV Trip",
            cards: [
              md(
                "## EV Trip Dashboard\n\nNo `sensor.<device>_recent_trips` entity found.\n\n" +
                "Set the device slug explicitly:\n```yaml\nstrategy:\n  type: custom:ev-trip\n  device: your_slug\n```"
              ),
            ],
          },
        ],
      };
    }
    return {
      title: "EV Trip",
      views: [drivingView(D, V, hass), tripsView(D), historyView(D), chartsView(D, hass), statsView(D, hass)],
    };
  }
}

customElements.define("ll-strategy-dashboard-ev-trip", EvTripDashboardStrategy);

console.info("%c EV-TRIP-DASHBOARD %c strategy loaded ", "background:#0a8;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
