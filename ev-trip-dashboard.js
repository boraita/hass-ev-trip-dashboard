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

// Progressive enhancement: is a HACS custom card available in this frontend?
// `type` is the bare element name (no "custom:" prefix). When false we fall
// back to a native Lovelace card so the strategy never emits a card that the
// user hasn't installed (the module ships as a public HACS plugin).
function hasCard(type) {
  try {
    if (typeof customElements !== "undefined" && customElements.get && customElements.get(type)) return true;
  } catch (_e) {
    /* customElements may be unavailable in non-browser contexts */
  }
  const cc = (typeof window !== "undefined" && window.customCards) || [];
  // window.customCards entries may carry the bare element name or a "custom:"-
  // prefixed type, depending on the plugin — match either.
  return cc.some((c) => c && (c.type === type || c.type === `custom:${type}`));
}

// The fancy HACS cards register asynchronously, often AFTER this strategy's
// generate() first runs — so hasCard() would see them as missing and we'd fall
// back to native cards even though they're installed. Wait (briefly) for the
// candidates to define before building the views. Cards that aren't installed
// never resolve, so the per-card timeout caps the wait.
const _FANCY_CARDS = [
  "mushroom-template-card",
  "mushroom-chips-card",
  "mushroom-title-card",
  "apexcharts-card",
  "mini-graph-card",
];
async function awaitFancyCards(timeoutMs = 2500) {
  if (typeof customElements === "undefined" || !customElements.whenDefined) return;
  await Promise.all(
    _FANCY_CARDS.map((t) =>
      Promise.race([
        Promise.resolve(customElements.whenDefined(t)).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    )
  );
}

// True only when the entity exists AND currently has a usable value — used to
// drop optional metrics (max speed/power, regen, temperature) that are blank
// because the logger has no speed/power/temperature source sensor configured.
function hasVal(hass, entity) {
  const s = hass.states[entity];
  return !!s && !["unknown", "unavailable", "none", ""].includes(String(s.state).toLowerCase());
}

// Heading — uses mushroom-title-card when present (tighter, themed), else the
// native section heading. mushroom-title-card has no icon slot, so we prefix
// the title with the matching mdi glyph via a small inline-icon is not possible
// in plain markdown there; instead we keep the icon on the native fallback and
// fold the icon into a subtitle-free title for mushroom.
const heading = (h, icon) =>
  hasCard("mushroom-title-card")
    ? { type: "custom:mushroom-title-card", title: h }
    : { type: "heading", heading: h, icon };
const md = (content) => ({ type: "markdown", content });
const grid = (cards) => ({ type: "grid", cards });

// A mushroom-template-card "tile" with a colored icon — used for the Driving
// KPIs when mushroom is installed. Falls back to a native tile card otherwise.
function kpiTile(entity, name, icon, color) {
  if (hasCard("mushroom-template-card")) {
    return {
      type: "custom:mushroom-template-card",
      entity,
      primary: name,
      secondary: "{{ states(entity) }}{{ ' ' ~ state_attr(entity,'unit_of_measurement') if state_attr(entity,'unit_of_measurement') else '' }}",
      icon: icon || "{{ state_attr(entity,'icon') or 'mdi:information-outline' }}",
      icon_color: color || "primary",
      multiline_secondary: false,
    };
  }
  const card = { type: "tile", entity, name };
  if (color) card.color = color;
  return card;
}

// ---- views ---------------------------------------------------------------
function drivingView(D, V, hass) {
  const status = [heading("Status", "mdi:car-electric")];

  // Optional mushroom chips strip — battery %, charging state, range — a quick
  // at-a-glance header above the gauge. Only when mushroom-chips-card exists.
  if (hasCard("mushroom-chips-card")) {
    const chips = [
      {
        type: "template",
        entity: `sensor.${D}_battery_percent`,
        icon: "{% set b = states(entity)|int(0) %}{{ 'mdi:battery' if b>=95 else 'mdi:battery-' ~ ((b/10)|round*10|int) if b>=10 else 'mdi:battery-outline' }}",
        icon_color: "{% set b = states(entity)|int(0) %}{{ 'red' if b<20 else 'amber' if b<50 else 'green' }}",
        content: "{{ states(entity) }}%",
      },
    ];
    if (has(hass, `sensor.${D}_charge_in_progress`)) {
      chips.push({
        type: "template",
        entity: `sensor.${D}_charge_in_progress`,
        icon: "{{ 'mdi:ev-station' if is_state(entity,'charging') else 'mdi:power-plug-off' }}",
        icon_color: "{{ 'blue' if is_state(entity,'charging') else 'disabled' }}",
        content: "{{ states(entity) }}",
      });
    }
    const rangeEnt = has(hass, `sensor.${D}_range_at_recent_efficiency`)
      ? `sensor.${D}_range_at_recent_efficiency`
      : has(hass, `sensor.${V}_range`)
      ? `sensor.${V}_range`
      : null;
    if (rangeEnt) {
      chips.push({
        type: "template",
        entity: rangeEnt,
        icon: "mdi:map-marker-distance",
        icon_color: "teal",
        content: "{{ states(entity)|round(0) }} km",
      });
    }
    status.push({ type: "custom:mushroom-chips-card", alignment: "center", chips });
  }

  // Battery: a mini-graph 24h curve (preferred — shows the trend) and only
  // fall back to the half-moon gauge when mini-graph-card isn't installed.
  if (hasCard("mini-graph-card")) {
    status.push({
      type: "custom:mini-graph-card",
      name: "Battery",
      icon: "mdi:battery-charging",
      hours_to_show: 24,
      points_per_hour: 2,
      line_width: 4,
      smoothing: true,
      show: { fill: "fade", state: true, name: true },
      entities: [{ entity: `sensor.${D}_battery_percent`, name: "Battery" }],
    });
  } else {
    status.push({
      type: "gauge",
      entity: `sensor.${D}_battery_percent`,
      name: "Battery",
      min: 0,
      max: 100,
      needle: true,
      severity: { green: 50, yellow: 20, red: 0 },
    });
  }

  // Battery / range / odometer. Logger gives a real-world range estimate;
  // the car integration (optional) gives its own range + odometer.
  const kpis = [
    { entity: `sensor.${D}_battery_energy`, name: "In battery", icon: "mdi:battery-charging", color: "green" },
    { entity: `sensor.${D}_energy_to_full_charge`, name: "To 100%", icon: "mdi:battery-plus", color: "blue" },
  ];
  if (has(hass, `sensor.${D}_range_at_recent_efficiency`))
    kpis.push({ entity: `sensor.${D}_range_at_recent_efficiency`, name: "Real range", icon: "mdi:map-marker-distance", color: "teal" });
  if (has(hass, `sensor.${V}_range`))
    kpis.push({ entity: `sensor.${V}_range`, name: "Range", icon: "mdi:map-marker-radius", color: "teal" });
  if (has(hass, `sensor.${V}_odometer`))
    kpis.push({ entity: `sensor.${V}_odometer`, name: "Odometer", icon: "mdi:counter", color: "grey" });
  // Mushroom template tiles (one per KPI) when available, else native tiles.
  for (const k of kpis) status.push(kpiTile(k.entity, k.name, k.icon, k.color));

  if (has(hass, `sensor.${V}_exterior_temperature`))
    status.push(kpiTile(`sensor.${V}_exterior_temperature`, "Outside", "mdi:thermometer", "orange"));
  if (has(hass, `sensor.${V}_cabin_temperature`))
    status.push(kpiTile(`sensor.${V}_cabin_temperature`, "Cabin", "mdi:car-seat", "orange"));

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
    { type: "custom:ev-trip-journey-card", device: D },
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
      // LEFT column — the trip list.
      grid([
        heading("Trips", "mdi:map-marker-path"),
        { type: "custom:ev-trip-list-card", device: D, title: "Trips" },
      ]),
      // RIGHT column — records on top, search & filter below.
      grid([
        heading("Records", "mdi:trophy-variant"),
        recordsCard(D),
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
  // Native statistics/history graphs — reliable across frontends. (An earlier
  // apexcharts version produced "Configuration error" on some setups, so we
  // stick to the built-in graph cards here.)
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

  // AC vs DC charge price (no state_class → plain history graph).
  const priceSeries = [];
  if (has(hass, `sensor.${D}_avg_ac_charge_price_30_days`))
    priceSeries.push({ entity: `sensor.${D}_avg_ac_charge_price_30_days`, name: "AC €/kWh" });
  if (has(hass, `sensor.${D}_avg_dc_fast_charge_price_30_days`))
    priceSeries.push({ entity: `sensor.${D}_avg_dc_fast_charge_price_30_days`, name: "DC €/kWh" });
  priceSeries.push({ entity: `sensor.${D}_avg_charge_price_30_days`, name: "Avg €/kWh" });
  trends.push({ type: "history-graph", title: "Charge price (€/kWh)", hours_to_show: 720, entities: priceSeries });

  // Battery 24h — mini-graph when installed (pretty + reliable), else history.
  if (hasCard("mini-graph-card")) {
    trends.push({
      type: "custom:mini-graph-card",
      name: "Battery (24h)",
      hours_to_show: 24,
      points_per_hour: 2,
      line_width: 3,
      smoothing: true,
      entities: [{ entity: `sensor.${D}_battery_percent`, name: "SoC" }],
    });
  } else {
    trends.push({ type: "history-graph", title: "Battery (24h)", hours_to_show: 24, entities: [{ entity: `sensor.${D}_battery_percent`, name: "SoC %" }] });
  }

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
  connectedCallback() {
    // Event delegation: one click listener toggles the tapped journey's detail.
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const tgt = ev.target;
      if (!tgt || !tgt.closest) return;
      const j = tgt.closest(".journey[data-journey-id]");
      if (j && this.contains(j)) {
        const id = j.getAttribute("data-journey-id");
        if (id == null) return;
        this._openId = String(this._openId) === String(id) ? null : id;
        this._render();
        return;
      }
      const cd = tgt.closest(".chargeday[data-day]");
      if (cd && this.contains(cd)) {
        const day = cd.getAttribute("data-day");
        if (day == null) return;
        this._openId = String(this._openId) === String(day) ? null : day;
        this._render();
      }
    });
  }
  _render() {
    if (!this._hass) return;
    // Lazy-bind the click delegation in case connectedCallback hasn't run.
    if (!this._clickBound && typeof this.addEventListener === "function") {
      this.connectedCallback();
    }
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const kind = this._kind;
    const st = this._hass.states[`sensor.${D}_recent_${kind}`];
    const rows = (st && st.attributes && Array.isArray(st.attributes[kind]) && st.attributes[kind]) || [];
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const sym = (c) => cur[c] || c || "€";
    const DASH = "—";
    const fmtNum = (v, dp) => (v == null || isNaN(v) ? DASH : dp == null ? String(v) : Number(v).toFixed(dp));

    const inner = kind === "journeys" ? this._journeysHtml(rows, D, sym, DASH, fmtNum) : this._chargesHtml(rows, sym, DASH, fmtNum);

    this.innerHTML = `
      <ha-card>
        <style>
          .head{display:flex;justify-content:space-between;align-items:baseline;
                padding:14px 16px 10px;font-weight:600;font-size:1.05em;}
          .head .count{color:var(--secondary-text-color);font-weight:400;font-size:.82em;}
          .list{display:flex;flex-direction:column;gap:10px;padding:0 12px 14px;}
          .empty{padding:24px 16px;text-align:center;color:var(--secondary-text-color);}

          /* ---- mushroom-like row ---- */
          .row,.chargeday{display:flex;align-items:center;gap:12px;
               background:var(--secondary-background-color, var(--card-background-color));
               border:1px solid var(--divider-color);border-radius:14px;padding:12px;}
          .journey,.chargeday{cursor:pointer;transition:border-color .15s ease;}
          .journey:hover,.chargeday:hover{border-color:var(--primary-color);}
          .journey--open,.chargeday--open{border-color:var(--primary-color);}
          .chargeday--open .caret{transform:rotate(180deg);}
          .badge{flex:0 0 auto;width:42px;height:42px;border-radius:50%;
                 display:flex;align-items:center;justify-content:center;}
          .badge ha-icon{--mdc-icon-size:22px;}
          .badge--road{background:rgba(3,155,229,.16);}
          .badge--road ha-icon{color:var(--info-color, #039be5);}
          .badge--ev{background:rgba(3,155,229,.16);}
          .badge--ev ha-icon{color:var(--info-color, #039be5);}
          .badge--ac{background:rgba(67,160,71,.16);}
          .badge--ac ha-icon{color:var(--success-color, #43a047);}
          .badge--dc{background:rgba(251,140,0,.16);}
          .badge--dc ha-icon{color:var(--warning-color, #fb8c00);}
          .body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}
          .title-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
          .title{font-weight:700;color:var(--primary-text-color);
                 font-variant-numeric:tabular-nums;}
          .id{color:var(--secondary-text-color);font-size:.8em;font-weight:600;}
          .sub{color:var(--secondary-text-color);font-size:.85em;
               font-variant-numeric:tabular-nums;}
          .sub b{color:var(--primary-text-color);font-weight:700;}
          .right{flex:0 0 auto;text-align:right;display:flex;flex-direction:column;gap:2px;}
          .right .big{font-weight:800;font-size:1.15em;color:var(--primary-text-color);
                      font-variant-numeric:tabular-nums;}
          .right .small{font-size:.8em;color:var(--secondary-text-color);
                        font-variant-numeric:tabular-nums;}
          .chip{display:inline-flex;align-items:center;gap:3px;
                background:var(--secondary-background-color);border:1px solid var(--divider-color);
                border-radius:999px;padding:1px 8px;font-size:.75em;font-weight:600;
                color:var(--secondary-text-color);white-space:nowrap;}
          .caret{flex:0 0 auto;color:var(--secondary-text-color);
                 transition:transform .15s ease;}
          .caret ha-icon{--mdc-icon-size:20px;}
          .journey--open .caret{transform:rotate(180deg);}

          /* ---- expanded journey detail ---- */
          .detail{margin-top:10px;padding-top:12px;border-top:1px solid var(--divider-color);
                  display:flex;flex-direction:column;gap:12px;}
          .stages{display:flex;flex-direction:column;gap:8px;}
          .stage{display:flex;align-items:center;gap:10px;padding:8px 4px;}
          .stage + .stage{border-top:1px dashed var(--divider-color);}
          .stage .sbody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}
          .stage .swhen{font-size:.8em;color:var(--secondary-text-color);
                        font-variant-numeric:tabular-nums;}
          .stage .sroute{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.9em;}
          .stage .smetrics{font-size:.8em;color:var(--secondary-text-color);
                           font-variant-numeric:tabular-nums;}
          .stage .smetrics b{color:var(--primary-text-color);font-weight:700;}
          .arrow{color:var(--secondary-text-color);}
          .score-pill{flex:0 0 auto;min-width:38px;padding:4px 8px;border-radius:999px;
                      color:#fff;font-weight:800;text-align:center;
                      font-variant-numeric:tabular-nums;font-size:.9em;}
          .stage-empty{padding:8px 4px;color:var(--secondary-text-color);
                       font-size:.85em;font-style:italic;}

          /* ---- expanded charge sessions ---- */
          .session{display:flex;align-items:center;gap:10px;padding:8px 4px;}
          .session + .session{border-top:1px dashed var(--divider-color);}
          .session .sbody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}
          .session .sroute{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.9em;}
          .session .stime{font-weight:700;color:var(--primary-text-color);
                          font-variant-numeric:tabular-nums;}
          .session .smetrics{font-size:.8em;color:var(--secondary-text-color);
                             font-variant-numeric:tabular-nums;}
          .session .smetrics b{color:var(--primary-text-color);font-weight:700;}
          .chip--ac{color:var(--success-color, #43a047);
                    border-color:var(--success-color, #43a047);}
          .chip--dc{color:var(--warning-color, #fb8c00);
                    border-color:var(--warning-color, #fb8c00);}
          .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
          .stat{background:var(--secondary-background-color);border:1px solid var(--divider-color);
                border-radius:12px;padding:10px 8px;display:flex;flex-direction:column;
                align-items:center;gap:3px;text-align:center;}
          .stat-label{font-size:.62em;letter-spacing:.05em;text-transform:uppercase;
                      color:var(--secondary-text-color);line-height:1.2;}
          .stat-value{font-size:1.2em;font-weight:800;color:var(--primary-text-color);
                      font-variant-numeric:tabular-nums;line-height:1.1;}
          .stat-unit{font-size:.55em;font-weight:600;color:var(--secondary-text-color);}
        </style>
        <div class="head"><span>${_esc(this._config.title || (kind === "journeys" ? "Journeys" : "Charges"))}</span>
          <span class="count">${rows.length} ${rows.length === 1 ? kind.replace(/s$/, "") : kind}</span></div>
        <div class="list">${inner}</div>
      </ha-card>`;
  }

  _journeysHtml(journeys, D, sym, DASH, fmtNum) {
    if (!journeys.length) return `<div class="empty">No journeys recorded yet.</div>`;
    const ts = this._hass.states[`sensor.${D}_recent_trips`];
    const allTrips = (ts && ts.attributes && Array.isArray(ts.attributes.trips) && ts.attributes.trips) || [];

    return journeys
      .map((j) => {
        const isOpen = j.journey_id != null && String(this._openId) === String(j.journey_id);
        const stageCount = j.stages != null ? j.stages : null;
        const stageChip = stageCount == null ? "" : `<span class="chip"><ha-icon icon="mdi:map-marker-path"></ha-icon>${stageCount} ${stageCount === 1 ? "stage" : "stages"}</span>`;
        const costStr = j.cost != null ? `${fmtNum(j.cost, 2)} ${_esc(sym(j.currency))}` : DASH;

        let detail = "";
        if (isOpen) {
          const stages = allTrips
            .filter((t) => t.journey_id != null && String(t.journey_id) === String(j.journey_id))
            .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
          detail = this._journeyDetailHtml(j, stages, sym, DASH, fmtNum);
        }

        return `
          <div class="row journey${isOpen ? " journey--open" : ""}" data-journey-id="${_esc(j.journey_id)}">
            <div class="badge badge--road"><ha-icon icon="mdi:road-variant"></ha-icon></div>
            <div class="body">
              <div class="title-line">
                <span class="title">${_fmtDate(j.ended_at)}</span>
                <span class="id">#${_esc(j.journey_id)}</span>
                ${stageChip}
              </div>
              <div class="sub"><b>${fmtNum(j.distance_km)}</b> km · <b>${fmtNum(j.energy_kwh)}</b> kWh · <b>${costStr}</b></div>
            </div>
            <div class="caret"><ha-icon icon="mdi:chevron-down"></ha-icon></div>
          </div>
          ${isOpen ? detail : ""}`;
      })
      .join("");
  }

  _journeyDetailHtml(j, stages, sym, DASH, fmtNum) {
    // Stages list.
    let stagesHtml;
    if (!stages.length) {
      stagesHtml = `<div class="stage-empty">Stage details not in recent window.</div>`;
    } else {
      stagesHtml = stages
        .map((t) => {
          const score = t.score != null ? Number(t.score).toFixed(1) : DASH;
          const origin = t.origin ? `<span class="chip">${_esc(t.origin)}</span>` : `<span class="chip">${DASH}</span>`;
          const dest = t.destination ? `<span class="chip">${_esc(t.destination)}</span>` : `<span class="chip">${DASH}</span>`;
          return `
            <div class="stage">
              <div class="sbody">
                <div class="swhen">${_fmtDate(t.started_at)}</div>
                <div class="sroute">${origin}<span class="arrow"><ha-icon icon="mdi:arrow-right" style="--mdc-icon-size:16px"></ha-icon></span>${dest}</div>
                <div class="smetrics"><b>${fmtNum(t.distance_km)}</b> km · <b>${fmtNum(t.consumption_kwh_100km)}</b> kWh/100</div>
              </div>
              <div class="score-pill" style="background:${_scoreColor(t.score)}">${score}</div>
            </div>`;
        })
        .join("");
    }

    // Averages / summary.
    const avgCons =
      j.energy_kwh != null && j.distance_km != null && j.distance_km !== 0
        ? fmtNum((j.energy_kwh / j.distance_km) * 100, 1)
        : DASH;

    let totDist = 0;
    let totDur = 0;
    let haveDur = false;
    for (const t of stages) {
      if (t.distance_km != null && !isNaN(t.distance_km)) totDist += Number(t.distance_km);
      if (t.duration_min != null && !isNaN(t.duration_min)) {
        totDur += Number(t.duration_min);
        haveDur = true;
      }
    }
    const avgSpeed = haveDur && totDur > 0 ? fmtNum(totDist / (totDur / 60), 1) : DASH;

    const stat = (label, value, unit) => `
      <div class="stat">
        <div class="stat-label">${_esc(label)}</div>
        <div class="stat-value">${value}<span class="stat-unit">${unit ? " " + _esc(unit) : ""}</span></div>
      </div>`;

    return `
      <div class="detail">
        <div class="stages">${stagesHtml}</div>
        <div class="stats">
          ${stat("Distance", fmtNum(j.distance_km), "km")}
          ${stat("Energy", fmtNum(j.energy_kwh), "kWh")}
          ${stat("Cost", j.cost != null ? fmtNum(j.cost, 2) : DASH, j.cost != null ? sym(j.currency) : "")}
          ${stat("Avg consumption", avgCons, "kWh/100")}
          ${stat("Avg speed", avgSpeed, "km/h")}
        </div>
      </div>`;
  }

  _chargesHtml(charges, sym, DASH, fmtNum) {
    if (!charges.length) return `<div class="empty">No charges recorded yet.</div>`;

    // Group sessions by calendar day (from ended_at). Day key is YYYY-MM-DD so
    // it's stable + sortable; the label is a short "Mon 02/06".
    const p = (n) => String(n).padStart(2, "0");
    const dayKey = (iso) => {
      if (!iso) return "unknown";
      const d = new Date(iso);
      if (isNaN(d)) return "unknown";
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const dayLabel = (key) => {
      if (key === "unknown") return "Unknown date";
      const [, m, dd] = key.split("-");
      const d = new Date(key + "T00:00:00");
      const wd = isNaN(d) ? "" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " ";
      return `${wd}${dd}/${m}`;
    };
    const timeOf = (iso) => {
      if (!iso) return DASH;
      const d = new Date(iso);
      if (isNaN(d)) return DASH;
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    // Preserve incoming order (newest first) when first seeing a day.
    const order = [];
    const byDay = {};
    for (const c of charges) {
      const k = dayKey(c.ended_at);
      if (!byDay[k]) {
        byDay[k] = [];
        order.push(k);
      }
      byDay[k].push(c);
    }
    order.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest day first

    return order
      .map((key) => {
        const sessions = byDay[key];
        // Day totals.
        let totKwh = 0;
        let haveKwh = false;
        let totCost = 0;
        let haveCost = false;
        let curSym = "€";
        for (const c of sessions) {
          if (c.kwh != null && !isNaN(c.kwh)) {
            totKwh += Number(c.kwh);
            haveKwh = true;
          }
          if (c.total_cost != null && !isNaN(c.total_cost)) {
            totCost += Number(c.total_cost);
            haveCost = true;
          }
          if (c.currency) curSym = sym(c.currency);
        }
        const kwhStr = haveKwh ? `${fmtNum(totKwh, 2)} kWh` : DASH;
        const costStr = haveCost ? `${fmtNum(totCost, 2)} ${_esc(curSym)}` : DASH;
        const n = sessions.length;
        const isOpen = String(this._openId) === String(key);

        const detail = isOpen ? this._chargeDayDetailHtml(sessions, sym, DASH, fmtNum, timeOf) : "";

        return `
          <div class="chargeday${isOpen ? " chargeday--open" : ""}" data-day="${_esc(key)}">
            <div class="badge badge--ev"><ha-icon icon="mdi:ev-station"></ha-icon></div>
            <div class="body">
              <div class="title-line">
                <span class="title">${_esc(dayLabel(key))}</span>
                <span class="chip"><ha-icon icon="mdi:counter"></ha-icon>${n} ${n === 1 ? "charge" : "charges"}</span>
              </div>
              <div class="sub"><b>${kwhStr}</b> · <b>${costStr}</b></div>
            </div>
            <div class="caret"><ha-icon icon="mdi:chevron-down"></ha-icon></div>
          </div>
          ${isOpen ? detail : ""}`;
      })
      .join("");
  }

  _chargeDayDetailHtml(sessions, sym, DASH, fmtNum, timeOf) {
    const items = sessions
      .map((c) => {
        const type = c.type ? String(c.type).toUpperCase() : null;
        const typeChip = type ? `<span class="chip chip--${type === "DC" ? "dc" : "ac"}">${_esc(type)}</span>` : "";
        const total = c.total_cost != null ? `${fmtNum(c.total_cost, 2)} ${_esc(sym(c.currency))}` : DASH;
        return `
          <div class="session">
            <div class="sbody">
              <div class="sroute">
                <span class="stime">${timeOf(c.ended_at)}</span>
                <span class="chip">${_esc(c.location || DASH)}</span>
                ${typeChip}
              </div>
              <div class="smetrics"><b>${fmtNum(c.kwh)}</b> kWh · <b>${fmtNum(c.price_per_kwh)}</b> ${_esc(sym(c.currency))}/kWh</div>
            </div>
            <div class="score-pill" style="background:var(--info-color, #039be5)">${total}</div>
          </div>`;
      })
      .join("");
    return `
      <div class="detail">
        <div class="stages">${items}</div>
      </div>`;
  }
}
customElements.define("ev-trip-history-card", EvTripHistoryCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-history-card", name: "EV Trip — journeys/charges", description: "Recent journeys or charges as a table." });

// ==========================================================================
// Custom card: current-or-last journey status. Replaces the Driving markdown
// (markdown renders unreliably on this user's frontend). Reads
// sensor.<device>_current_journey (live) and _last_journey (finished).
// ==========================================================================
class EvTripJourneyCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  getCardSize() {
    return 3;
  }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const DASH = "—";
    const fmtNum = (v, dp) => (v == null || isNaN(v) ? DASH : dp == null ? String(v) : Number(v).toFixed(dp));
    const stOf = (id) => {
      const e = this._hass.states[id];
      return e ? e : null;
    };

    const cur = stOf(`sensor.${D}_current_journey`);
    const last = stOf(`sensor.${D}_last_journey`);
    const curStages = cur ? parseInt(cur.state, 10) : NaN;
    const inProgress = !isNaN(curStages) && curStages > 0;

    const lastState = last ? String(last.state).toLowerCase() : "";
    const hasLast = last && !["unknown", "unavailable", "0", "none", ""].includes(lastState);

    // status colors / glyph / label
    let dotColor, badgeBg, icon, statusLabel, statusSub, a, stagesNum;
    if (inProgress) {
      const at = cur.attributes || {};
      dotColor = "var(--success-color, #43a047)";
      badgeBg = "rgba(67,160,71,.16)";
      icon = "mdi:road-variant";
      statusLabel = "🟢 En route";
      statusSub = at.stage_active ? "In progress · stage moving now" : "In progress";
      a = at;
      stagesNum = curStages;
    } else if (hasLast) {
      const at = last.attributes || {};
      dotColor = "var(--info-color, #039be5)";
      badgeBg = "rgba(3,155,229,.16)";
      icon = "mdi:flag-checkered";
      statusLabel = "✅ Finished";
      statusSub = at.ended_at ? `Ended ${_fmtDate(at.ended_at)}` : "Finished";
      a = at;
      stagesNum = parseInt(last.state, 10);
    } else {
      this.innerHTML = `
        <ha-card>
          <style>
            .head{display:flex;align-items:center;gap:12px;padding:14px 16px;}
            .badge{flex:0 0 auto;width:42px;height:42px;border-radius:50%;
                   background:var(--divider-color);display:flex;align-items:center;
                   justify-content:center;}
            .badge ha-icon{--mdc-icon-size:22px;color:var(--secondary-text-color);}
            .title{font-weight:700;color:var(--primary-text-color);}
            .sub{color:var(--secondary-text-color);font-size:.85em;}
          </style>
          <div class="head">
            <div class="badge"><ha-icon icon="mdi:road-variant"></ha-icon></div>
            <div>
              <div class="title">${_esc(this._config.title || "Journey")}</div>
              <div class="sub">No completed journeys yet.</div>
            </div>
          </div>
        </ha-card>`;
      return;
    }

    const stageStr = `${isNaN(stagesNum) ? DASH : stagesNum} ${stagesNum === 1 ? "stage" : "stages"}`;
    const tile = (tIcon, label, value, unit) => `
      <div class="jt">
        <ha-icon class="jt-icon" icon="${tIcon}"></ha-icon>
        <div class="jt-label">${_esc(label)}</div>
        <div class="jt-value">${value}<span class="jt-unit">${unit ? " " + _esc(unit) : ""}</span></div>
      </div>`;

    this.innerHTML = `
      <ha-card>
        <style>
          .jhead{display:flex;align-items:center;gap:12px;padding:14px 16px 10px;}
          .jbadge{flex:0 0 auto;width:44px;height:44px;border-radius:50%;
                  background:${badgeBg};display:flex;align-items:center;justify-content:center;}
          .jbadge ha-icon{--mdc-icon-size:24px;color:${dotColor};}
          .jhead-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}
          .jtitle{font-weight:700;color:var(--primary-text-color);}
          .jstatus{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
          .jchip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;
                 padding:2px 10px;font-size:.8em;font-weight:700;
                 background:${badgeBg};color:${dotColor};}
          .jdot{width:8px;height:8px;border-radius:50%;background:${dotColor};
                display:inline-block;}
          .jsub{color:var(--secondary-text-color);font-size:.82em;
                font-variant-numeric:tabular-nums;}
          .jtiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:4px 12px 14px;}
          .jt{background:var(--secondary-background-color, var(--card-background-color));
              border:1px solid var(--divider-color);border-radius:12px;padding:10px 8px;
              display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center;}
          .jt-icon{--mdc-icon-size:20px;color:var(--secondary-text-color);}
          .jt-label{font-size:.62em;letter-spacing:.05em;text-transform:uppercase;
                    color:var(--secondary-text-color);line-height:1.2;}
          .jt-value{font-size:1.25em;font-weight:800;color:var(--primary-text-color);
                    font-variant-numeric:tabular-nums;line-height:1.1;}
          .jt-unit{font-size:.55em;font-weight:600;color:var(--secondary-text-color);}
        </style>
        <div class="jhead">
          <div class="jbadge"><ha-icon icon="${icon}"></ha-icon></div>
          <div class="jhead-body">
            <div class="jtitle">${_esc(this._config.title || "Journey")}</div>
            <div class="jstatus">
              <span class="jchip"><span class="jdot"></span>${_esc(statusLabel)}</span>
              <span class="jsub">${_esc(stageStr)} · ${_esc(statusSub)}</span>
            </div>
          </div>
        </div>
        <div class="jtiles">
          ${tile("mdi:map-marker-distance", "Distance", fmtNum(a.distance_km), "km")}
          ${tile("mdi:lightning-bolt", "Energy", fmtNum(a.energy_kwh), "kWh")}
          ${tile("mdi:currency-eur", "Cost", fmtNum(a.cost, a.cost != null ? 2 : undefined), "€")}
        </div>
      </ha-card>`;
  }
}
customElements.define("ev-trip-journey-card", EvTripJourneyCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-journey-card", name: "EV Trip — journey status", description: "Current or last journey status with live stats." });

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
    // Give the installed fancy cards a moment to register so hasCard() sees
    // them (otherwise we'd fall back to native and the dashboard "looks the same").
    await awaitFancyCards();
    return {
      title: "EV Trip",
      views: [drivingView(D, V, hass), tripsView(D), historyView(D), chartsView(D, hass), statsView(D, hass)],
    };
  }
}

customElements.define("ll-strategy-dashboard-ev-trip", EvTripDashboardStrategy);

console.info("%c EV-TRIP-DASHBOARD %c strategy loaded ", "background:#0a8;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
