/*! EV Trip Dashboard — Lovelace dashboard strategy (HACS plugin).
 *
 * Auto-generates the BYD-app-style EV Trip dashboard (9 pantallas) from your
 * trip-logger device — no __DEVICE__ find/replace.
 *
 * Views (in order):
 *   1. Resumen      — vehicle hero + SoC/SoH/tires/map + charging popup
 *   2. Calendario   — monthly activity calendar
 *   3. Tendencias   — KPI tiles + monthly bar chart + 60-day km line
 *   4. Patrones     — trip-time histogram, weekday radar, weekday strip
 *   5. Eficiencia   — 30d avg + per-month consumption + scatter + temp bar
 *   6. Récords      — top distance / duration / efficiency / cheapest
 *   7. Detalle      — drilldown for the last trip + route map
 *   8. Viajes       — last-30-days KPI strip + reactive trip list
 *   9. Cargas       — KPI strip + recent charges
 *
 * Usage (a dashboard's raw config):
 *   strategy:
 *     type: custom:ev-trip
 *     # device: sealion_7      # optional — auto-detected from *_recent_trips
 *     # vehicle: byd_sealion_7 # optional — car integration (range/odo/map/tires)
 *
 * HACS dependencies (REQUIRED — install via HACS → Frontend):
 *   - mushroom (template + chips + title)
 *   - button-card
 *   - mini-graph-card
 *   - apexcharts-card
 *   - calendar-card-pro
 *
 * The Trips search/sort/filter still needs the input helpers in
 * packages/trip-list-helpers.yaml (a dashboard strategy can't create helpers).
 * If they're absent the list shows everything unfiltered.
 */

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

// ---- card builders (shared between views) --------------------------------

// A mushroom-title-card for section headings — mirrors the YAML cards' header
// style (title + optional subtitle + icon).
const mushroomTitle = (title, subtitle, icon) => {
  const card = { type: "custom:mushroom-title-card", title };
  if (subtitle) card.subtitle = subtitle;
  if (icon) card.icon = icon;
  return card;
};

// Native heading — used inside section grids that want the small built-in
// chip-style heading rather than the larger mushroom title.
const heading = (h, icon) => ({ type: "heading", heading: h, icon });
const md = (content) => ({ type: "markdown", content });
const grid = (cards) => ({ type: "grid", cards });

// Wraps a vertical stack — used when a "screen" maps to a vertical-stack in the
// reference YAML. Strategies render any nested cards through Lovelace as-is.
const vstack = (cards) => ({ type: "vertical-stack", cards });
const hstack = (cards) => ({ type: "horizontal-stack", cards });

// Mushroom template "tile" — colored icon + primary label + dynamic secondary.
// Used for KPI surfaces (Resumen hero, Trends KPIs, charging popup, etc.).
function mushroomTpl({ primary, secondary, icon, iconColor, entity, badgeIcon, badgeColor, fillContainer, multilineSecondary, layout, tapAction, content }) {
  const card = { type: "custom:mushroom-template-card" };
  if (primary != null) card.primary = primary;
  if (secondary != null) card.secondary = secondary;
  if (icon) card.icon = icon;
  if (iconColor) card.icon_color = iconColor;
  if (entity) card.entity = entity;
  if (badgeIcon) card.badge_icon = badgeIcon;
  if (badgeColor) card.badge_color = badgeColor;
  if (fillContainer !== undefined) card.fill_container = fillContainer;
  if (multilineSecondary !== undefined) card.multiline_secondary = multilineSecondary;
  if (layout) card.layout = layout;
  if (tapAction) card.tap_action = tapAction;
  if (content != null) card.content = content;
  return card;
}

// Compact button-card builder used by the KPI grids. Most tiles share the same
// padding / border-radius / typography, so we keep a single canonical style
// here and let callers override icon color + sizes.
function btnTile({ entity, name, icon, iconColor, iconWidth, stateFontSize, height, padding, borderRadius, stateDisplay, label, showLabel, showState, template, tapAction }) {
  const card = { type: "custom:button-card" };
  if (entity) card.entity = entity;
  if (template !== undefined) card.template = template;
  card.name = name == null ? "" : name;
  card.icon = icon;
  card.show_state = showState !== false;
  card.show_icon = true;
  card.show_name = true;
  if (showLabel) card.show_label = true;
  if (label) card.label = label;
  if (stateDisplay) card.state_display = stateDisplay;
  if (tapAction) card.tap_action = tapAction;

  const cardStyle = [];
  cardStyle.push({ padding: padding || "12px" });
  cardStyle.push({ "border-radius": borderRadius || "16px" });
  if (height) cardStyle.push({ height });
  card.styles = {
    card: cardStyle,
    name: [{ "font-size": "12px" }, { opacity: "0.75" }],
    state: [{ "font-size": stateFontSize || "22px" }, { "font-weight": "bold" }],
    icon: [],
  };
  if (iconColor) card.styles.icon.push({ color: iconColor });
  if (iconWidth) card.styles.icon.push({ width: iconWidth });
  if (showLabel) {
    card.styles.label = [{ "font-size": "12px" }, { opacity: "0.85" }];
  }
  return card;
}

// Tire pressure tile — front-left / rear-right etc. The color rule
// (2.2–2.8 bar = ok, otherwise warning) is identical for all four corners,
// so we keep the inline JS expression here once and inject the entity.
function tirePressureTile(entity, name) {
  return {
    type: "custom:button-card",
    entity,
    name,
    icon: "mdi:car-tire-alert",
    show_state: true,
    styles: {
      card: [{ padding: "8px" }],
      icon: [
        {
          color:
            "[[[\n  const v = parseFloat(entity.state);\n  return (v >= 2.2 && v <= 2.8) ? 'var(--success-color)' : 'var(--warning-color)';\n]]]",
        },
      ],
    },
  };
}

// Wraps an apexcharts-card. The `apexConfig` / `yaxis` / `series` are passed
// through verbatim — most charts have idiosyncratic options so this is the
// pragmatic shape rather than a deeply opinionated builder.
function apexChart({ title, chartType, graphSpan, span, apexConfig, yaxis, series, headerShowStates, colorizeStates }) {
  const card = {
    type: "custom:apexcharts-card",
    header: { show: true, title, show_states: !!headerShowStates },
  };
  if (colorizeStates) card.header.colorize_states = true;
  if (chartType) card.chart_type = chartType;
  if (graphSpan) card.graph_span = graphSpan;
  if (span) card.span = span;
  if (apexConfig) card.apex_config = apexConfig;
  if (yaxis) card.yaxis = yaxis;
  if (series) card.series = series;
  return card;
}

// ==========================================================================
// View 1 — Resumen (Pantalla 1)
// Hero (SoC + range) · ODO/ENERGY/SOH/SYSTEM strip · tire 2x2 · mini map ·
// CONDITIONAL "charge live" popup (only when charging).
// ==========================================================================
function resumenView(D, V, hass) {
  const cards = [];

  // ---- HERO -------------------------------------------------------------
  // Car icon, name (from device_tracker friendly_name if present), SoC %,
  // range chip. Uses secondary_info to fit both battery percent and range
  // on one line. icon_color drives the red/orange/green ring.
  cards.push(
    mushroomTpl({
      primary: `{{ state_attr('device_tracker.${V}_location', 'friendly_name') or 'Vehicle' }}`,
      secondary: `{{ states('sensor.${D}_battery_percent') }}% · {{ states('sensor.${D}_range_at_recent_efficiency') }} km`,
      icon: "mdi:car-electric",
      iconColor: `{% set p = states('sensor.${D}_battery_percent') | float(0) %}{% if p < 20 %}red{% elif p < 50 %}orange{% else %}green{% endif %}`,
      badgeIcon: `{% if is_state('sensor.${D}_charge_in_progress', 'charging') %}mdi:flash{% endif %}`,
      badgeColor: "amber",
      fillContainer: true,
      multilineSecondary: false,
      tapAction: { action: "more-info", entity: `sensor.${D}_battery_percent` },
    })
  );

  // ---- STRIP — ODO · ENERGY · SOH · SYSTEM ------------------------------
  // SOH and SYSTEM are guarded with conditional chips so the row keeps
  // working on cars that don't expose those entities.
  const chips = [
    {
      type: "template",
      icon: "mdi:counter",
      content: `{{ states('sensor.${V}_odometer') | round(0) }} km`,
      icon_color: "blue",
    },
    {
      type: "template",
      icon: "mdi:battery-charging-medium",
      content: `{{ states('sensor.${D}_battery_energy') }} kWh`,
      icon_color: "teal",
    },
  ];
  if (has(hass, `sensor.${V}_state_of_health`)) {
    chips.push({
      type: "conditional",
      conditions: [{ condition: "state", entity: `sensor.${V}_state_of_health`, state_not: "unavailable" }],
      chip: {
        type: "template",
        icon: "mdi:heart-pulse",
        content: `SOH {{ states('sensor.${V}_state_of_health') }}%`,
        icon_color: "pink",
      },
    });
  }
  if (has(hass, `binary_sensor.${V}_power_system`)) {
    chips.push({
      type: "conditional",
      conditions: [{ condition: "state", entity: `binary_sensor.${V}_power_system`, state_not: "unavailable" }],
      chip: {
        type: "template",
        icon: "mdi:power",
        content: `{{ 'ON' if is_state('binary_sensor.${V}_power_system', 'on') else 'OFF' }}`,
        icon_color: `{{ 'green' if is_state('binary_sensor.${V}_power_system', 'on') else 'grey' }}`,
      },
    });
  }
  cards.push({ type: "custom:mushroom-chips-card", alignment: "justify", chips });

  // ---- TIRE PRESSURES — 2x2 button-card grid ----------------------------
  const tires = [
    [`sensor.${V}_front_left_tire_pressure`, "Front Left"],
    [`sensor.${V}_front_right_tire_pressure`, "Front Right"],
    [`sensor.${V}_rear_left_tire_pressure`, "Rear Left"],
    [`sensor.${V}_rear_right_tire_pressure`, "Rear Right"],
  ];
  // Only render the tire grid if at least one corner sensor exists; otherwise
  // the card looks broken on non-BYD installs.
  if (tires.some(([e]) => has(hass, e))) {
    cards.push({
      type: "grid",
      columns: 2,
      square: false,
      cards: tires.map(([e, n]) => tirePressureTile(e, n)),
    });
  }

  // ---- MINI MAP ---------------------------------------------------------
  if (has(hass, `device_tracker.${V}_location`)) {
    cards.push({
      type: "map",
      entities: [{ entity: `device_tracker.${V}_location` }],
      hours_to_show: 6,
      default_zoom: 14,
      aspect_ratio: "16:9",
    });
  }

  // ---- CHARGE LIVE POPUP (only while charging) --------------------------
  // ETA = energy_to_full_charge (kWh) / current_charge_power (kW), in minutes.
  cards.push({
    type: "conditional",
    conditions: [{ condition: "state", entity: `sensor.${D}_charge_in_progress`, state: "charging" }],
    card: mushroomTpl({
      primary: `Charging · {{ states('sensor.${D}_current_charge_type') | upper }}`,
      secondary:
        `{{ states('sensor.${D}_current_charge_power') }} kW · ` +
        `SoC {{ states('sensor.${D}_battery_percent') }}% · ` +
        `+{{ states('sensor.${D}_current_charge_energy') }} kWh · ` +
        `{{ states('sensor.${D}_current_charge_duration') }} · ` +
        `ETA {% set kwh = states('sensor.${D}_energy_to_full_charge') | float(0) %}` +
        `{% set kw  = states('sensor.${D}_current_charge_power')  | float(0) %}` +
        `{% if kw > 0 %}{{ ((kwh / kw) * 60) | round(0) }} min{% else %}—{% endif %}`,
      icon: "mdi:ev-station",
      iconColor: "amber",
      fillContainer: true,
      multilineSecondary: true,
      tapAction: { action: "more-info", entity: `sensor.${D}_current_charge_power` },
    }),
  });

  return {
    title: "Resumen",
    path: "resumen",
    icon: "mdi:car-electric",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 2 — Calendario (Pantalla 2)
// Monthly activity calendar via calendar-card-pro. Each day with activity
// shows up as one all-day event ("2 viajes · 23 km · 1 carga").
// ==========================================================================
function calendarioView(D, hass) {
  const cards = [
    mushroomTitle("Actividad EV", null, "mdi:calendar"),
    {
      type: "custom:calendar-card-pro",
      entities: [
        // Two entries on the SAME calendar give calendar-card-pro two
        // color/icon rules; "carga" → blue lightning, "viaje" → green car.
        // The first matching rule wins.
        {
          entity: `calendar.${D}_activity`,
          color: "#1976d2",
          icon: "mdi:lightning-bolt",
          accumulate_by: "day",
          label: "carga",
        },
        {
          entity: `calendar.${D}_activity`,
          color: "#2e7d32",
          icon: "mdi:car",
          accumulate_by: "day",
          label: "viaje",
        },
      ],
      view: "month",
      show_navigation: true,
      show_today: true,
      first_day_of_week: "monday",
      language: "es",
      time_format: 24,
      max_events_to_show: 4,
      compact_events_to_show: 2,
      show_empty_days: true,
      // Tap a day → browser_mod popup if available; otherwise calendar-card-pro
      // falls back to its built-in detail view.
      tap_action: {
        action: "fire-dom-event",
        browser_mod: {
          service: "browser_mod.popup",
          data: {
            title: "Actividad del día",
            size: "normal",
            content: {
              type: "markdown",
              content:
                `{% set events = state_attr('calendar.${D}_activity', 'all_events') or [] %}\n` +
                `{% set today = states('sensor.date') %}\n` +
                `{% set todays = events | selectattr('start', 'search', today) | list %}\n` +
                `{% if todays | length == 0 %}\n_Sin actividad registrada para hoy._\n` +
                `{% else %}\n{% for ev in todays %}\n**{{ ev.summary }}**\n{{ ev.description or '' }}\n{% endfor %}\n{% endif %}`,
            },
          },
        },
      },
    },
  ];

  return {
    title: "Calendario",
    path: "calendar",
    icon: "mdi:calendar",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 3 — Tendencias (Pantalla 3)
// 4 KPI tiles (Long trip / Avg trip / Driving time / Monthly cost) +
// dual-axis monthly bar (km + kWh) + last-60-days km line.
// ==========================================================================
function tendenciasView(D, hass) {
  const cards = [];

  cards.push(mushroomTitle("Tendencias", "Resumen de los últimos 30/60 días", "mdi:chart-line"));

  // ---- KPI 2x2 ----------------------------------------------------------
  // Tile 1 leans on trip_records.attributes.totals.longest_trip_date — colour
  // shifts from orange (recent) to red (long ago) using an inline JS state rule.
  const longTrip = {
    type: "custom:button-card",
    name: "Long trip",
    icon: "mdi:trophy-outline",
    show_state: true,
    entity: `sensor.${D}_trip_records`,
    state: [
      {
        operator: "template",
        value:
          "[[[\n  const d = entity.attributes?.totals?.longest_trip_date;\n  if (!d) return false;\n  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);\n  return days <= 30;\n]]]",
        color: "rgb(255, 152, 0)",
      },
      { operator: "default", color: "rgb(244, 67, 54)" },
    ],
    label:
      "[[[\n  const d = entity.attributes?.totals?.longest_trip_date;\n  if (!d) return 'sin datos';\n  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);\n  return `hace ${days} día${days === 1 ? '' : 's'}`;\n]]]",
    styles: {
      card: [{ padding: "12px" }, { "border-radius": "16px" }],
      name: [{ "font-size": "13px" }, { opacity: "0.75" }],
      label: [{ "font-size": "12px" }, { opacity: "0.85" }],
      state: [{ "font-size": "20px" }, { "font-weight": "bold" }],
    },
  };

  const avgTrip = mushroomTpl({
    primary: "Avg trip",
    secondary: `{{ states('sensor.${D}_avg_trip_distance_30_days') }} km · {{ states('sensor.${D}_avg_trip_duration_30_days') }} min`,
    icon: "mdi:road-variant",
    iconColor: "blue",
    fillContainer: true,
  });

  const drivingTime = mushroomTpl({
    primary: "Driving time",
    secondary: `{{ states('sensor.${D}_driving_time_30_days') }} h (30d)`,
    icon: "mdi:steering",
    iconColor: "green",
    fillContainer: true,
  });

  const monthlyCost = mushroomTpl({
    primary: "Monthly cost",
    secondary: `{{ states('sensor.${D}_cost_this_month') }} €`,
    icon: "mdi:cash-multiple",
    iconColor: "amber",
    fillContainer: true,
  });

  cards.push({
    type: "grid",
    columns: 2,
    square: false,
    cards: [longTrip, avgTrip, drivingTime, monthlyCost],
  });

  // ---- Dual-axis bar chart — Monthly Km & kWh ---------------------------
  // data_generator walks monthly_history.attributes.months and emits
  // [month-label, value] pairs. Two series share the x-axis but use separate
  // y-axes (left=km, right=kWh).
  cards.push(
    apexChart({
      title: "Monthly Km & kWh",
      graphSpan: "365d",
      span: { end: "month" },
      apexConfig: {
        chart: { height: "280px", stacked: false },
        legend: { position: "bottom" },
        xaxis: { type: "category", labels: { rotate: -45, style: { fontSize: "11px" } } },
        plotOptions: { bar: { columnWidth: "60%", borderRadius: 4 } },
        tooltip: { shared: true },
      },
      yaxis: [
        {
          id: "km",
          decimals: 0,
          apex_config: { title: { text: "Km" }, labels: { style: { colors: "#ef5350" } } },
        },
        {
          id: "kwh",
          opposite: true,
          decimals: 1,
          apex_config: { title: { text: "kWh" }, labels: { style: { colors: "#26c6da" } } },
        },
      ],
      series: [
        {
          entity: `sensor.${D}_monthly_history`,
          name: "Distance (km)",
          type: "column",
          yaxis_id: "km",
          color: "#ef5350",
          data_generator:
            "const months = entity.attributes.months || [];\nreturn months.map(m => [m.month, m.distance_km]);",
        },
        {
          entity: `sensor.${D}_monthly_history`,
          name: "Energy (kWh)",
          type: "column",
          yaxis_id: "kwh",
          color: "#26c6da",
          data_generator:
            "const months = entity.attributes.months || [];\nreturn months.map(m => [m.month, m.energy_kwh]);",
        },
      ],
    })
  );

  // ---- Line chart — Km driven in last 60 days ---------------------------
  // Smoothed area chart with gradient fill, datetime x-axis.
  cards.push(
    apexChart({
      title: "Km driven in last 60 days",
      headerShowStates: true,
      colorizeStates: true,
      graphSpan: "60d",
      span: { end: "day" },
      apexConfig: {
        chart: { height: "260px" },
        stroke: { curve: "smooth", width: 3 },
        fill: {
          type: "gradient",
          gradient: { shadeIntensity: 1, opacityFrom: 0.55, opacityTo: 0.05, stops: [0, 90, 100] },
        },
        xaxis: {
          type: "datetime",
          labels: { datetimeFormatter: { month: "MMM", day: "dd MMM" } },
        },
        tooltip: { x: { format: "dd MMM yyyy" } },
      },
      yaxis: [{ decimals: 0, min: 0, apex_config: { title: { text: "Km / day" } } }],
      series: [
        {
          entity: `sensor.${D}_daily_km_60d`,
          name: "Km",
          type: "area",
          color: "#e53935",
          stroke_width: 3,
          data_generator:
            "const days = entity.attributes.days || [];\nreturn days.map(d => [new Date(d.day).getTime(), d.distance_km]);",
        },
      ],
    })
  );

  return {
    title: "Tendencias",
    path: "trends",
    icon: "mdi:chart-line",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 4 — Patrones (Pantalla 4)
// Title + KPI strip (trips count + daily avg) + by-hour histogram +
// by-weekday radar + km-per-weekday strip.
// ==========================================================================
function patternsView(D, hass) {
  const cards = [];

  cards.push(mushroomTitle("Patrones", "Cuándo y cuánto conduces (últimos 90 días)", "mdi:chart-bell-curve-cumulative"));

  // ---- KPI strip --------------------------------------------------------
  // Two button-cards in a horizontal stack. Common large-state/small-label
  // typography lifted directly from the reference YAML.
  const kpiCardStyles = (iconColor) => ({
    card: [
      { padding: "12px" },
      { "border-radius": "18px" },
      { background: "var(--ha-card-background, var(--card-background-color))" },
    ],
    icon: [{ color: iconColor }, { width: "28px" }],
    name: [{ "font-size": "13px" }, { color: "var(--secondary-text-color)" }],
    state: [{ "font-size": "26px" }, { "font-weight": "700" }],
    label: [{ "font-size": "11px" }, { color: "var(--secondary-text-color)" }],
  });

  cards.push(
    hstack([
      {
        type: "custom:button-card",
        entity: `sensor.${D}_trip_patterns`,
        name: "Viajes",
        show_state: true,
        show_label: true,
        label: "ult. 90 días",
        icon: "mdi:routes",
        styles: kpiCardStyles("#f59e0b"),
        tap_action: { action: "more-info" },
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_trip_distance_30_days`,
        name: "Media diaria",
        show_state: true,
        show_label: true,
        label: "km/día (30 d)",
        icon: "mdi:speedometer",
        styles: kpiCardStyles("#10b981"),
        tap_action: { action: "more-info" },
      },
    ])
  );

  // ---- By Hour — 24-bar histogram --------------------------------------
  // by_hour keys are STRINGS "0".."23"; we emit {x, y} pairs so apex labels
  // the bars "00h", "01h", … in chronological order.
  cards.push({
    type: "custom:apexcharts-card",
    header: { show: true, title: "Por hora", show_states: false },
    chart_type: "bar",
    graph_span: "1d",
    apex_config: {
      chart: { height: 240, toolbar: { show: false } },
      plotOptions: { bar: { borderRadius: 4, columnWidth: "70%" } },
      dataLabels: { enabled: false },
      xaxis: {
        labels: { style: { fontSize: "10px" }, rotate: 0, hideOverlappingLabels: true },
        tickAmount: 12,
      },
      yaxis: { labels: { style: { fontSize: "10px" } }, decimalsInFloat: 0 },
      grid: { borderColor: "rgba(255,255,255,0.08)" },
      tooltip: { x: { formatter: 'EVAL:function(val) { return val + ":00"; }' } },
      colors: ["#f59e0b"],
    },
    series: [
      {
        entity: `sensor.${D}_trip_patterns`,
        name: "Viajes",
        type: "column",
        data_generator:
          'const by = entity.attributes.by_hour || {};\nconst out = [];\nfor (let i = 0; i < 24; i++) {\n  const k = String(i);\n  out.push({ x: (i < 10 ? "0" + i : "" + i) + "h", y: Number(by[k] || 0) });\n}\nreturn out;',
      },
    ],
  });

  // ---- By Day — radar chart --------------------------------------------
  // by_weekday is keyed "0".."6" with 0 = Monday. We feed apex an [{x, y}, …]
  // shape because apexcharts-card requires it; apex flattens the y values for
  // radar and pulls the labels from apex_config.xaxis.categories.
  cards.push({
    type: "custom:apexcharts-card",
    header: { show: true, title: "Por día", show_states: false },
    apex_config: {
      chart: { type: "radar", height: 280, toolbar: { show: false } },
      stroke: { width: 2 },
      fill: { opacity: 0.35 },
      markers: { size: 4 },
      xaxis: {
        categories: ["L", "M", "X", "J", "V", "S", "D"],
        labels: { style: { fontSize: "12px", fontWeight: 600 } },
      },
      yaxis: { show: false },
      colors: ["#6366f1"],
      tooltip: { y: { formatter: 'EVAL:function(val) { return val + " viajes"; }' } },
    },
    series: [
      {
        entity: `sensor.${D}_trip_patterns`,
        name: "Viajes",
        data_generator:
          'const labels = ["L","M","X","J","V","S","D"];\nconst by = entity.attributes.by_weekday || {};\nconst out = [];\nfor (let i = 0; i < 7; i++) {\n  out.push({ x: labels[i], y: Number(by[String(i)] || 0) });\n}\nreturn out;',
      },
    ],
  });

  // ---- Km per weekday — 7-cell horizontal strip -------------------------
  // Saturday/Sunday get an "amber/orange" color hint to set weekends apart;
  // weekdays use indigo. Each cell reads the km_by_weekday attr by string key.
  const weekdayTile = (label, key, iconColor, icon) =>
    mushroomTpl({
      primary: label,
      secondary: `{{ (state_attr('sensor.${D}_trip_patterns','km_by_weekday') or {}).get('${key}', 0) | round(0) }} km`,
      icon: icon || "mdi:calendar-today",
      iconColor,
      layout: "vertical",
      fillContainer: true,
      tapAction: { action: "more-info", entity: `sensor.${D}_trip_patterns` },
    });

  cards.push(
    hstack([
      weekdayTile("L", "0", "indigo"),
      weekdayTile("M", "1", "indigo"),
      weekdayTile("X", "2", "indigo"),
      weekdayTile("J", "3", "indigo"),
      weekdayTile("V", "4", "amber"),
      weekdayTile("S", "5", "orange", "mdi:calendar-weekend"),
      weekdayTile("D", "6", "orange", "mdi:calendar-weekend"),
    ])
  );

  return {
    title: "Patrones",
    path: "patterns",
    icon: "mdi:chart-bell-curve-cumulative",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 5 — Eficiencia (Pantalla 5)
// Hero (30-day avg consumption) + monthly consumption line + efficiency vs
// distance scatter (3 series by score band) + temperature bar + tip.
// ==========================================================================
function eficienciaView(D, hass) {
  const cards = [];

  cards.push({
    type: "custom:mushroom-title-card",
    title: "Eficiencia",
    subtitle: "Consumo, distancia y temperatura",
    alignment: "start",
  });

  // ---- Hero — 30-day avg consumption -----------------------------------
  // Green gradient background; state_display appends "kWh/100km".
  cards.push({
    type: "custom:button-card",
    entity: `sensor.${D}_avg_consumption_30_days`,
    name: "Consumo medio (30 días)",
    show_state: true,
    show_icon: true,
    icon: "mdi:leaf",
    styles: {
      card: [
        { padding: "18px" },
        { "border-radius": "16px" },
        { background: "linear-gradient(135deg, rgba(46,160,67,0.18), rgba(46,160,67,0.04))" },
      ],
      grid: [
        { "grid-template-areas": '"i n" "i s"' },
        { "grid-template-columns": "64px 1fr" },
        { "grid-template-rows": "auto auto" },
      ],
      icon: [{ color: "#2ea043" }, { width: "48px" }],
      name: [{ "justify-self": "start" }, { "font-size": "14px" }, { opacity: "0.75" }],
      state: [
        { "justify-self": "start" },
        { "font-size": "28px" },
        { "font-weight": "600" },
        { color: "#2ea043" },
      ],
    },
    state_display: "[[[ return `${entity.state} kWh/100km`; ]]]",
  });

  // ---- Monthly avg consumption (LINE) -----------------------------------
  // Walk monthly_history.attributes.months, compute kWh/100km per month with
  // a divide-by-zero guard, parse "YYYY-MM" → ms timestamp for datetime x-axis.
  cards.push(
    apexChart({
      title: "Avg consumption per month (kWh/100km)",
      graphSpan: "365d",
      span: { end: "month" },
      apexConfig: {
        chart: { height: 260 },
        stroke: { curve: "smooth", width: 3 },
        markers: { size: 4 },
        dataLabels: { enabled: false },
        grid: { borderColor: "rgba(255,255,255,0.08)" },
        tooltip: { x: { format: "MMM yyyy" } },
        xaxis: {
          type: "datetime",
          labels: { datetimeFormatter: { year: "yyyy", month: "MMM 'yy" } },
        },
        yaxis: { decimalsInFloat: 1, title: { text: "kWh/100km" } },
      },
      series: [
        {
          entity: `sensor.${D}_monthly_history`,
          name: "Consumo",
          color: "#2ea043",
          type: "line",
          data_generator:
            "const months = entity.attributes.months || [];\nreturn months.map((m) => {\n  const km = Number(m.distance_km) || 0;\n  const kwh = Number(m.energy_kwh) || 0;\n  const cons = km > 0 ? (kwh / km) * 100 : null;\n  const [y, mo] = String(m.month || '').split('-').map(Number);\n  const ts = (y && mo) ? new Date(y, mo - 1, 1).getTime() : new Date(m.month).getTime();\n  return [ts, cons];\n}).filter((p) => p[1] !== null);",
        },
      ],
    })
  );

  // ---- Efficiency vs Distance (SCATTER, 3 series by score) -------------
  // Each trip becomes one point: x = distance_km, y = consumption_kwh_100km.
  // Three series so apex colors points by score band:
  //   green (≥7), orange (4..7), red (<4 or missing).
  const scatterSeries = (name, color, filterJs) => ({
    entity: `sensor.${D}_recent_trips`,
    name,
    color,
    type: "scatter",
    data_generator:
      "const trips = entity.attributes.trips || [];\nreturn trips\n  .filter((t) => " +
      filterJs +
      "\n    && t.distance_km != null\n    && t.consumption_kwh_100km != null)\n  .map((t) => [Number(t.distance_km), Number(t.consumption_kwh_100km)]);",
  });

  cards.push(
    apexChart({
      title: "Efficiency vs Distance",
      graphSpan: "90d",
      chartType: "scatter",
      apexConfig: {
        chart: { height: 280 },
        dataLabels: { enabled: false },
        grid: { borderColor: "rgba(255,255,255,0.08)" },
        legend: { show: true, position: "bottom" },
        tooltip: {
          shared: false,
          intersect: true,
          x: { formatter: "EVAL:function(val){ return val.toFixed(1) + ' km'; }" },
          y: { formatter: "EVAL:function(val){ return val.toFixed(1) + ' kWh/100km'; }" },
        },
        xaxis: { type: "numeric", title: { text: "Distance (km)" }, decimalsInFloat: 0 },
        yaxis: { title: { text: "kWh/100km" }, decimalsInFloat: 1 },
      },
      series: [
        scatterSeries("Score ≥ 7", "#2ea043", "Number(t.score) >= 7"),
        scatterSeries(
          "Score 4–7",
          "#f0883e",
          "(function(){ const s = Number(t.score); return s >= 4 && s < 7; })()"
        ),
        scatterSeries(
          "Score < 4",
          "#f85149",
          "(function(){ const s = Number(t.score); return (isNaN(s) || s < 4); })()"
        ),
      ],
    })
  );

  // ---- Consumption by temperature bucket (BAR) -------------------------
  // by_bucket keys are stringified ints; sort them numerically ascending so
  // the x-axis goes cold → hot. Each label gets a "°C" suffix.
  cards.push({
    type: "custom:apexcharts-card",
    header: { show: true, title: "Consumption by temperature (kWh/100km)", show_states: false },
    chart_type: "bar",
    apex_config: {
      chart: { height: 240 },
      plotOptions: { bar: { borderRadius: 4, columnWidth: "60%", distributed: true } },
      dataLabels: {
        enabled: true,
        formatter: "EVAL:function(val){ return val ? val.toFixed(1) : ''; }",
        style: { fontSize: "11px" },
      },
      legend: { show: false },
      grid: { borderColor: "rgba(255,255,255,0.08)" },
      xaxis: { type: "category", title: { text: "Temperature bucket (°C)" } },
      yaxis: { title: { text: "kWh/100km" }, decimalsInFloat: 1 },
    },
    series: [
      {
        entity: `sensor.${D}_consumption_by_temperature`,
        name: "Consumo",
        type: "bar",
        data_generator:
          "const buckets = entity.attributes.by_bucket || {};\nreturn Object.keys(buckets)\n  .map((k) => [parseInt(k, 10), Number(buckets[k])])\n  .filter((p) => !isNaN(p[0]) && !isNaN(p[1]))\n  .sort((a, b) => a[0] - b[0])\n  .map(([k, v]) => [`${k}°C`, v]);",
      },
    ],
  });

  // ---- Footer hint — colored advice -------------------------------------
  cards.push(
    mushroomTpl({
      primary: "Consejo de eficiencia",
      secondary:
        `{% set c = states('sensor.${D}_avg_consumption_30_days') | float(0) %}` +
        `{% if c == 0 %} Sin datos suficientes todavía.` +
        `{% elif c < 16 %} Excelente — mantienes un consumo muy eficiente.` +
        `{% elif c < 19 %} Buen consumo, dentro de lo esperado.` +
        `{% elif c < 22 %} Algo elevado: revisa estilo de conducción o clima.` +
        `{% else %} Consumo alto: trayectos cortos/frío/autopista influyen mucho.{% endif %}`,
      icon: "mdi:lightbulb-on-outline",
      iconColor:
        `{% set c = states('sensor.${D}_avg_consumption_30_days') | float(0) %}` +
        `{% if c == 0 %} grey` +
        `{% elif c < 19 %} green` +
        `{% elif c < 22 %} orange` +
        `{% else %} red{% endif %}`,
      fillContainer: true,
    })
  );

  return {
    title: "Eficiencia",
    path: "efficiency",
    icon: "mdi:leaf",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 6 — Récords (Pantalla 6)
// KPI tiles (longest / max duration / cheapest / best efficiency) +
// Top-9 lists per category (distance, consumption, efficiency, speed).
// ==========================================================================
function topsView(D, hass) {
  const cards = [];

  cards.push(mushroomTitle("Récords", `{{ states('sensor.${D}_tops') }} viajes clasificados`, "mdi:trophy"));

  // Common style block for the KPI tiles — name top-left, big label in middle.
  const recordTileStyles = (iconColor) => ({
    card: [{ padding: "12px" }, { "border-radius": "16px" }],
    name: [
      { "font-size": "11px" },
      { "letter-spacing": "1px" },
      { color: "var(--secondary-text-color)" },
    ],
    label: [
      { "font-size": "16px" },
      { "font-weight": "600" },
      { "white-space": "pre-line" },
      { "line-height": "1.3" },
    ],
    icon: [{ color: iconColor }, { width: "28px" }],
  });

  // ---- KPI grid (2x2) ---------------------------------------------------
  // Each label is an inline JS expression that reads the first entry of the
  // ranking list (longest / longest_duration / cheapest / top_efficiency) and
  // formats "<value>\n<date>" — the pre-line white-space honors the newline.
  cards.push({
    type: "grid",
    columns: 2,
    square: false,
    cards: [
      {
        type: "custom:button-card",
        name: "LONGEST",
        icon: "mdi:map-marker-distance",
        show_state: false,
        show_label: true,
        label:
          "[[[\n  const list = states['sensor." +
          D +
          "_tops']?.attributes?.longest || [];\n  if (!list.length) return '—';\n  const t = list[0];\n  const km = t.distance_km != null ? Number(t.distance_km).toFixed(1) : '—';\n  const d  = t.ended_at ? new Date(t.ended_at).toLocaleDateString('es-ES') : '';\n  return `${km} km\\n${d}`;\n]]]",
        styles: recordTileStyles("var(--info-color)"),
      },
      {
        type: "custom:button-card",
        name: "MAX DURATION",
        icon: "mdi:timer-sand",
        show_state: false,
        show_label: true,
        label:
          "[[[\n  const list = states['sensor." +
          D +
          "_tops']?.attributes?.longest_duration || [];\n  if (!list.length) return '—';\n  const t = list[0];\n  const mn = t.duration_min != null ? Math.round(Number(t.duration_min)) : '—';\n  const d  = t.ended_at ? new Date(t.ended_at).toLocaleDateString('es-ES') : '';\n  return `${mn} min\\n${d}`;\n]]]",
        styles: recordTileStyles("var(--warning-color)"),
      },
      {
        type: "custom:button-card",
        name: "CHEAPEST",
        icon: "mdi:cash-multiple",
        show_state: false,
        show_label: true,
        label:
          "[[[\n  const list = states['sensor." +
          D +
          "_tops']?.attributes?.cheapest || [];\n  if (!list.length) return '—';\n  const t = list[0];\n  const c  = t.cost != null ? Number(t.cost).toFixed(2) : '—';\n  const cur = t.currency || '€';\n  const d  = t.ended_at ? new Date(t.ended_at).toLocaleDateString('es-ES') : '';\n  return `${c} ${cur}\\n${d}`;\n]]]",
        styles: recordTileStyles("var(--success-color)"),
      },
      {
        type: "custom:button-card",
        name: "BEST EFFICIENCY",
        icon: "mdi:leaf",
        show_state: false,
        show_label: true,
        label:
          "[[[\n  const list = states['sensor." +
          D +
          "_tops']?.attributes?.top_efficiency || [];\n  if (!list.length) return '—';\n  const t = list[0];\n  const v = t.consumption_kwh_100km != null\n    ? Number(t.consumption_kwh_100km).toFixed(1) : '—';\n  const d = t.ended_at ? new Date(t.ended_at).toLocaleDateString('es-ES') : '';\n  return `${v} kWh/100\\n${d}`;\n]]]",
        styles: recordTileStyles("var(--success-color)"),
      },
    ],
  });

  // ---- Top-9 ranking cards ----------------------------------------------
  // Each one is a mushroom-template-card whose `secondary` is a Jinja list.
  // We reuse a single helper to spell out the four categories.
  const topList = (primary, icon, iconColor, attr, valueFormat) =>
    mushroomTpl({
      primary,
      secondary:
        `{%- set rows = state_attr('sensor.${D}_tops', '${attr}') or [] %}\n` +
        `{%- if rows | length == 0 %}\n_Sin datos todavía._\n` +
        `{%- else %}\n{%- for t in rows[:9] %}\n` +
        `{{ loop.index }}. {{ as_timestamp(t.ended_at) | timestamp_custom('%d/%m/%Y') }} · **${valueFormat}**\n` +
        `{%- endfor %}\n{%- endif %}`,
      icon,
      iconColor,
      fillContainer: true,
      multilineSecondary: true,
    });

  cards.push(
    topList("🥇 Top Distance", "mdi:map-marker-distance", "blue", "longest", "{{ '%.1f' | format(t.distance_km | float(0)) }} km")
  );
  cards.push(
    topList("⚡ Top Consumption", "mdi:flash", "amber", "top_consumption", "{{ '%.2f' | format(t.energy_kwh | float(0)) }} kWh")
  );
  cards.push(
    topList(
      "🌱 Top Efficiency",
      "mdi:leaf",
      "green",
      "top_efficiency",
      "{{ '%.1f' | format(t.consumption_kwh_100km | float(0)) }} kWh/100"
    )
  );
  cards.push(
    topList("🚀 Top Average Speed", "mdi:speedometer", "red", "top_speed", "{{ '%.0f' | format(t.avg_speed_kmh | float(0)) }} km/h")
  );

  return {
    title: "Récords",
    path: "tops",
    icon: "mdi:trophy",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 7 — Detalle (Pantalla 7)
// Drilldown for the LAST completed trip: KPI 2x2 + comparison vs personal
// avg + percentile + estimated cost + route map (recorder breadcrumbs).
// ==========================================================================
function detalleView(D, V, hass) {
  const cards = [];

  cards.push({
    type: "custom:mushroom-title-card",
    title: "Detalle del viaje",
    subtitle:
      `{{ state_attr('sensor.${D}_last_trip', 'started_at') | as_timestamp(0) | timestamp_custom('%d %b %H:%M', true) ` +
      `if state_attr('sensor.${D}_last_trip', 'started_at') else '—' }}`,
    icon: "mdi:magnify",
  });

  // ---- KPI grid 2x2 -----------------------------------------------------
  // First three tiles surface a sensor directly; the fourth synthesises the
  // avg_speed_kmh attribute (it isn't its own entity) via a template label.
  const kpiBtnStyles = {
    card: [{ padding: "12px" }, { "border-radius": "16px" }],
    name: [{ "font-size": "12px" }, { opacity: "0.7" }],
    state: [{ "font-size": "22px" }, { "font-weight": "bold" }],
  };

  const kpiBtn = (entity, name, icon) => ({
    type: "custom:button-card",
    entity,
    name,
    show_state: true,
    show_icon: true,
    icon,
    styles: kpiBtnStyles,
  });

  cards.push({
    type: "grid",
    columns: 2,
    square: false,
    cards: [
      kpiBtn(`sensor.${D}_last_trip_distance`, "Distancia", "mdi:road-variant"),
      kpiBtn(`sensor.${D}_last_trip_energy`, "Consumo", "mdi:lightning-bolt"),
      kpiBtn(`sensor.${D}_last_trip_consumption`, "Eficiencia", "mdi:speedometer"),
      {
        type: "custom:button-card",
        // avg_speed_kmh is an attribute, not an entity — use a label template
        // and hide the (empty) state row.
        template: "",
        name: "Velocidad media",
        show_state: true,
        show_icon: true,
        icon: "mdi:gauge",
        label:
          "[[[\n  const v = states['sensor." +
          D +
          "_last_trip'].attributes.avg_speed_kmh;\n  return (v == null) ? '—' : v.toFixed(1) + ' km/h';\n]]]",
        show_label: true,
        styles: {
          card: [{ padding: "12px" }, { "border-radius": "16px" }],
          name: [{ "font-size": "12px" }, { opacity: "0.7" }],
          label: [{ "font-size": "22px" }, { "font-weight": "bold" }],
          state: [{ display: "none" }],
        },
      },
    ],
  });

  // ---- Comparison vs personal 30-day average ---------------------------
  cards.push(
    mushroomTpl({
      primary: "Frente a tu media",
      secondary:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set avg  = states('sensor.${D}_total_30d_avg_consumption') | float(0) %}` +
        `{% if avg > 0 and trip > 0 %}{% set delta = ((trip - avg) / avg) * 100 %}` +
        `{% if delta < 0 %}{{ delta | round(1) }}% mejor que tu media (≈ {{ avg | round(1) }} kWh/100km)` +
        `{% else %}+{{ delta | round(1) }}% peor que tu media (≈ {{ avg | round(1) }} kWh/100km){% endif %}` +
        `{% else %}Aún no hay datos suficientes{% endif %}`,
      icon: "mdi:chart-line-variant",
      iconColor:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set avg  = states('sensor.${D}_total_30d_avg_consumption') | float(0) %}` +
        `{% if avg > 0 and trip > 0 %}{{ 'green' if trip <= avg else 'red' }}{% else %}grey{% endif %}`,
    })
  );

  // ---- Percentile within the recent_trips window ------------------------
  // Lower consumption is better → "Top X%" = this trip beat X% of recent trips.
  cards.push(
    mushroomTpl({
      primary: "Percentil",
      secondary:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set trips = state_attr('sensor.${D}_recent_trips', 'trips') or [] %}` +
        `{% set valid = trips | selectattr('consumption_kwh_100km', 'defined') | rejectattr('consumption_kwh_100km', 'none') | list %}` +
        `{% set total = valid | count %}` +
        `{% if total > 0 and trip > 0 %}` +
        `{% set worse = valid | selectattr('consumption_kwh_100km', '>', trip) | list | count %}` +
        `{% set pct = ((worse / total) * 100) | round(0) %}` +
        `Top {{ pct }}% — mejor que {{ worse }} de {{ total }} viajes recientes` +
        `{% else %}Sin histórico aún{% endif %}`,
      icon: "mdi:trophy-variant",
      iconColor:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set trips = state_attr('sensor.${D}_recent_trips', 'trips') or [] %}` +
        `{% set valid = trips | selectattr('consumption_kwh_100km', 'defined') | rejectattr('consumption_kwh_100km', 'none') | list %}` +
        `{% set total = valid | count %}` +
        `{% if total > 0 and trip > 0 %}` +
        `{% set worse = valid | selectattr('consumption_kwh_100km', '>', trip) | list | count %}` +
        `{% set pct = (worse / total) * 100 %}` +
        `{{ 'green' if pct >= 50 else ('amber' if pct >= 25 else 'red') }}` +
        `{% else %}grey{% endif %}`,
    })
  );

  // ---- Estimated cost ---------------------------------------------------
  cards.push({
    type: "custom:button-card",
    entity: `sensor.${D}_last_trip_cost`,
    name: "Coste estimado",
    show_state: true,
    show_icon: true,
    icon: "mdi:cash-multiple",
    styles: {
      card: [{ padding: "14px" }, { "border-radius": "16px" }],
      name: [{ "font-size": "13px" }, { opacity: "0.7" }],
      state: [{ "font-size": "26px" }, { "font-weight": "bold" }],
    },
  });

  // ---- Route map (recorder breadcrumbs around the trip window) ---------
  // Map's hours_to_show doesn't accept Jinja, so resolve it at generate time
  // from sensor.<D>_last_trip's duration_min (rounded hours + 0.5h buffer).
  if (has(hass, `device_tracker.${V}_location`)) {
    let hoursToShow = 1;
    const lt = hass.states[`sensor.${D}_last_trip`];
    const durMin = lt && lt.attributes && parseFloat(lt.attributes.duration_min);
    if (durMin && !isNaN(durMin) && durMin > 0) {
      hoursToShow = Math.max(1, Math.round(durMin / 60 + 0.5));
    }
    cards.push({
      type: "map",
      title: "Ruta",
      default_zoom: 13,
      hours_to_show: hoursToShow,
      entities: [{ entity: `device_tracker.${V}_location` }],
    });
  }

  // ---- Footnote about route approximation -------------------------------
  cards.push(
    md(
      "_Ruta aproximada a partir del histórico del `device_tracker`. La integración " +
        "guarda 1 muestra GPS cada 30 s mientras el coche está encendido " +
        "(`storage.async_trip_positions(trip_id)`). Para dibujar la ruta exacta " +
        "instala un mapa de Leaflet (p. ej. `ha-card-leaflet` o `plotly-graph-card` " +
        "con scatter geo) y aliméntalo con un sensor REST/template que lea esas posiciones._"
    )
  );

  return {
    title: "Detalle",
    path: "trip-detail",
    icon: "mdi:magnify",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 8 — Viajes (Pantalla 8)
// "Viajes" header + Last-30-days KPI strip (5 tiles) + ev-trip-list-card
// (custom element ships with this plugin — replaces the markdown blob in
// trip-list-v2.yaml with a reactive, expandable list).
// ==========================================================================
function viajesView(D, hass) {
  const cards = [];

  cards.push(mushroomTitle("Viajes", "Last 30 days", "mdi:car-electric"));

  // ---- KPI strip (5 button-cards) --------------------------------------
  // Avg consumption is computed in JS from recent_trips because it spans the
  // last 10 trips; the others are direct sensor reads.
  const kpiStyles = {
    card: [{ padding: "10px" }, { "border-radius": "14px" }],
    name: [{ "font-size": "12px" }, { opacity: "0.75" }],
    state: [{ "font-size": "18px" }, { "font-weight": "bold" }],
  };

  cards.push({
    type: "grid",
    columns: 5,
    square: false,
    cards: [
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_trip_distance_30_days`,
        name: "Avg distance",
        icon: "mdi:map-marker-distance",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: kpiStyles,
        state_display: "[[[ return `${entity.state} km` ]]]",
      },
      {
        type: "custom:button-card",
        name: "Avg consumption",
        icon: "mdi:flash",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: kpiStyles,
        // Mean of the last 10 trips' energy_kwh; falls back to "— kWh".
        state_display:
          "[[[\n  const trips = (states['sensor." +
          D +
          "_recent_trips']\n                && states['sensor." +
          D +
          "_recent_trips'].attributes\n                && states['sensor." +
          D +
          "_recent_trips'].attributes.trips) || [];\n  const vals = trips.map(t => parseFloat(t.energy_kwh)).filter(v => !isNaN(v));\n  if (!vals.length) return '— kWh';\n  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;\n  return `${avg.toFixed(2)} kWh`;\n]]]",
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_consumption_30_days`,
        name: "Avg efficiency",
        icon: "mdi:lightning-bolt-outline",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: kpiStyles,
        state_display: "[[[ return `${entity.state} kWh/100km` ]]]",
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_trip_duration_30_days`,
        name: "Avg duration",
        icon: "mdi:timer-outline",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: kpiStyles,
        state_display: "[[[ return `${entity.state} min` ]]]",
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_trip_speed_30_days`,
        name: "Avg speed",
        icon: "mdi:speedometer",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: kpiStyles,
        state_display: "[[[ return `${entity.state} km/h` ]]]",
      },
    ],
  });

  // ---- Reactive trip list (custom element from this plugin) ------------
  // Replaces the per-row Jinja markdown of trip-list-v2.yaml with a sortable,
  // searchable, expandable list. Honours the same input helpers when present.
  cards.push({ type: "custom:ev-trip-list-card", device: D, title: "Recent trips" });

  return {
    title: "Viajes",
    path: "trips",
    icon: "mdi:car-multiple",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 9 — Cargas (Pantalla 9)
// Title · 4 KPI tiles (Avg kWh · Avg Cost · Avg €/kWh · Total Charges) ·
// ev-trip-history-card (kind=charges) for the per-day grouped list ·
// Floating "+" button to fire the ev_trip_logger.log_charge service.
// ==========================================================================
function cargasView(D, hass) {
  const cards = [];

  cards.push(mushroomTitle("Cargas", "Últimos 30 días", "mdi:battery-charging"));

  // ---- KPI grid (2x2) --------------------------------------------------
  // Each tile is a button-card with 96px height so the grid feels denser
  // than the default tile spacing.
  const chKpiStyles = (iconColor) => ({
    card: [{ padding: "12px" }, { height: "96px" }],
    name: [{ "font-size": "12px" }, { color: "var(--secondary-text-color)" }],
    state: [{ "font-size": "22px" }, { "font-weight": "600" }],
    icon: [{ color: iconColor }, { width: "28px" }],
  });

  cards.push({
    type: "grid",
    columns: 2,
    square: false,
    cards: [
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_charge_kwh_30_days`,
        name: "Avg kWh",
        icon: "mdi:flash",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: chKpiStyles("var(--info-color)"),
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_charge_cost_30_days`,
        name: "Avg Cost",
        icon: "mdi:currency-eur",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: chKpiStyles("var(--warning-color)"),
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_charge_price_30_days`,
        name: "Avg €/kWh",
        icon: "mdi:tag-outline",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: chKpiStyles("var(--accent-color)"),
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_charges_this_month`,
        name: "Total Charges",
        icon: "mdi:counter",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: chKpiStyles("var(--success-color)"),
      },
    ],
  });

  // ---- Reactive charges history (custom element from this plugin) ------
  // Replaces the Jinja markdown blob; groups sessions by calendar day with
  // expandable detail panels.
  cards.push({ type: "custom:ev-trip-history-card", device: D, kind: "charges", title: "Historial de cargas" });

  // ---- Floating "+" button — log a manual charge -----------------------
  // Position fixed → floats above the dashboard regardless of scroll.
  cards.push({
    type: "custom:button-card",
    name: "",
    icon: "mdi:plus",
    show_name: false,
    show_icon: true,
    tap_action: {
      action: "call-service",
      service: "ev_trip_logger.log_charge",
      service_data: {},
    },
    hold_action: {
      action: "more-info",
      entity: `sensor.${D}_recent_charges`,
    },
    styles: {
      card: [
        { position: "fixed" },
        { bottom: "24px" },
        { right: "24px" },
        { width: "56px" },
        { height: "56px" },
        { "border-radius": "50%" },
        { "background-color": "var(--primary-color)" },
        { "box-shadow": "0 4px 12px rgba(0,0,0,0.3)" },
        { "z-index": 1000 },
        { padding: 0 },
      ],
      icon: [{ color: "white" }, { width: "28px" }],
    },
  });

  return {
    title: "Cargas",
    path: "charges",
    icon: "mdi:ev-station",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
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
// HACS deps are required — no per-card fallback. If a dep is missing the
// user will see one broken card, not a degraded dashboard.
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
      title: "EV Trips",
      views: [
        resumenView(D, V, hass),
        calendarioView(D, hass),
        tendenciasView(D, hass),
        patternsView(D, hass),
        eficienciaView(D, hass),
        topsView(D, hass),
        detalleView(D, V, hass),
        viajesView(D, hass),
        cargasView(D, hass),
      ],
    };
  }
}

customElements.define("ll-strategy-dashboard-ev-trip", EvTripDashboardStrategy);

console.info(
  "%c EV-TRIP-DASHBOARD %c strategy loaded ",
  "background:#0a8;color:#fff;border-radius:3px 0 0 3px",
  "background:#333;color:#fff;border-radius:0 3px 3px 0"
);
