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

// Currency map for Jinja templates (used by the restored records card).
const CUR_MAP = "{'EUR':'€','USD':'$','GBP':'£'}";

// Progressive-enhancement check — true if a fancy HACS card is registered.
// Matches the bare element name or a "custom:"-prefixed type.
function hasCard(type) {
  try {
    if (typeof customElements !== "undefined" && customElements.get && customElements.get(type)) return true;
  } catch (_e) {
    /* customElements may be unavailable in non-browser contexts */
  }
  const cc = (typeof window !== "undefined" && window.customCards) || [];
  return cc.some((c) => c && (c.type === type || c.type === `custom:${type}`));
}

// A mushroom-template-card "tile" with a colored icon (Driving KPIs); falls
// back to a native tile card when mushroom isn't installed.
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
    title: "Overview",
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
// shows up as one all-day event ("2 trips · 23 km · 1 charge").
// ==========================================================================
function calendarioView(D, hass) {
  // The calendar entity ships with logger v0.5.0. Until it exists, show a
  // friendly placeholder instead of calendar-card-pro's "entity not found".
  if (!has(hass, `calendar.${D}_activity`)) {
    return {
      title: "Calendar",
      path: "calendar",
      icon: "mdi:calendar",
      type: "sections",
      max_columns: 2,
      sections: [
        grid([
          mushroomTitle("EV Activity", null, "mdi:calendar"),
          md(
            "### 📅 Activity calendar\n\n" +
              "This view will show a monthly calendar with your trips and charges per day.\n\n" +
              "_Requires `calendar." +
              D +
              "_activity`, which is added when you update **hass-ev-trip-logger to v0.5.0**._"
          ),
        ]),
      ],
    };
  }
  const cards = [
    mushroomTitle("EV Activity", null, "mdi:calendar"),
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
          label: "charge",
        },
        {
          entity: `calendar.${D}_activity`,
          color: "#2e7d32",
          icon: "mdi:car",
          accumulate_by: "day",
          label: "trip",
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
            title: "Day activity",
            size: "normal",
            content: {
              type: "markdown",
              content:
                `{% set events = state_attr('calendar.${D}_activity', 'all_events') or [] %}\n` +
                `{% set today = states('sensor.date') %}\n` +
                `{% set todays = events | selectattr('start', 'search', today) | list %}\n` +
                `{% if todays | length == 0 %}\n_No activity recorded for today._\n` +
                `{% else %}\n{% for ev in todays %}\n**{{ ev.summary }}**\n{{ ev.description or '' }}\n{% endfor %}\n{% endif %}`,
            },
          },
        },
      },
    },
  ];

  return {
    title: "Calendar",
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

  cards.push(mushroomTitle("Trends", "Summary of the last 30/60 days", "mdi:chart-line"));

  // ---- KPI 2x2 ----------------------------------------------------------
  // Tile 1 leans on trip_records.attributes.totals.longest_trip_date — colour
  // shifts from orange (recent) to red (long ago) using an inline JS state rule.
  const longTrip = {
    type: "custom:button-card",
    name: "Long trip",
    icon: "mdi:trophy-outline",
    show_state: true,
    show_label: true,
    entity: `sensor.${D}_trip_records`,
    // The records sensor exposes attributes.longest = {value, ended_at, ...};
    // the state itself is the trip count, so render the distance explicitly.
    state_display:
      "[[[\n  const l = entity && entity.attributes && entity.attributes.longest;\n  return (l && l.value != null) ? `${l.value} km` : '—';\n]]]",
    state: [
      {
        operator: "template",
        value:
          "[[[\n  const d = entity.attributes && entity.attributes.longest && entity.attributes.longest.ended_at;\n  if (!d) return false;\n  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);\n  return days <= 30;\n]]]",
        color: "rgb(255, 152, 0)",
      },
      { operator: "default", color: "rgb(244, 67, 54)" },
    ],
    label:
      "[[[\n  const d = entity.attributes && entity.attributes.longest && entity.attributes.longest.ended_at;\n  if (!d) return 'no data';\n  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);\n  return `${days} day${days === 1 ? '' : 's'} ago`;\n]]]",
    styles: {
      card: [{ padding: "12px" }, { "border-radius": "16px" }],
      name: [{ "font-size": "13px" }, { opacity: "0.75" }],
      label: [{ "font-size": "12px" }, { opacity: "0.85" }],
      state: [{ "font-size": "20px" }, { "font-weight": "bold" }],
    },
  };

  const avgTrip = mushroomTpl({
    primary: "Avg trip",
    secondary:
      `{% set d = states('sensor.${D}_avg_trip_distance_30_days') %}` +
      `{% set t = states('sensor.${D}_avg_trip_duration_30_days') %}` +
      `{{ d if d not in ['unknown','unavailable','None'] else '—' }} km · ` +
      `{{ t if t not in ['unknown','unavailable','None'] else '—' }} min`,
    icon: "mdi:road-variant",
    iconColor: "blue",
    fillContainer: true,
  });

  const drivingTime = mushroomTpl({
    primary: "Driving time",
    secondary:
      `{% set t = states('sensor.${D}_driving_time_30_days') %}` +
      `{{ t if t not in ['unknown','unavailable','None'] else '—' }} min (30d)`,
    icon: "mdi:steering",
    iconColor: "green",
    fillContainer: true,
  });

  const monthlyCost = mushroomTpl({
    primary: "Monthly cost",
    secondary:
      `{% if has_value('sensor.${D}_cost_this_month') %}` +
      `{{ states('sensor.${D}_cost_this_month') | float(0) | round(2) }} €` +
      `{% else %}—{% endif %}`,
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

  // ---- NEW (v0.5.0): robust monthly history card -----------------------
  // Additive: rendered above the apex version below. Once logger v0.5.0
  // ships and this is validated, remove the apex "Monthly Km & kWh" card.
  cards.push({ type: "custom:ev-trip-monthly-card", device: D });
  // Daily km sparkline (replaces the apex 60-day line below once validated).
  cards.push({ type: "custom:ev-trip-daily-card", device: D });

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
    title: "Trends",
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

  cards.push(mushroomTitle("Patterns", "When and how much you drive (last 90 days)", "mdi:chart-bell-curve-cumulative"));

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
        name: "Trips",
        show_state: true,
        show_label: true,
        label: "last 90 days",
        icon: "mdi:routes",
        styles: kpiCardStyles("#f59e0b"),
        tap_action: { action: "more-info" },
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_trip_distance_30_days`,
        name: "Daily avg",
        show_state: true,
        show_label: true,
        label: "km/day (30 d)",
        icon: "mdi:speedometer",
        styles: kpiCardStyles("#10b981"),
        tap_action: { action: "more-info" },
      },
    ])
  );

  // ---- NEW (v0.5.0): robust patterns card ------------------------------
  // Additive: consolidates by-hour + weekday km/trips into one vanilla-JS
  // card, rendered above the apex by-hour/radar + mushroom strip below.
  // Once validated against logger v0.5.0, remove those three apex/mushroom
  // cards.
  cards.push({ type: "custom:ev-trip-patterns-card", device: D });

  // ---- By Hour — 24-bar histogram --------------------------------------
  // by_hour keys are STRINGS "0".."23"; we emit {x, y} pairs so apex labels
  // the bars "00h", "01h", … in chronological order.
  cards.push({
    type: "custom:apexcharts-card",
    header: { show: true, title: "By hour", show_states: false },
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
        name: "Trips",
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
    header: { show: true, title: "By day", show_states: false },
    apex_config: {
      chart: { type: "radar", height: 280, toolbar: { show: false } },
      stroke: { width: 2 },
      fill: { opacity: 0.35 },
      markers: { size: 4 },
      xaxis: {
        categories: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        labels: { style: { fontSize: "12px", fontWeight: 600 } },
      },
      yaxis: { show: false },
      colors: ["#6366f1"],
      tooltip: { y: { formatter: 'EVAL:function(val) { return val + " trips"; }' } },
    },
    series: [
      {
        entity: `sensor.${D}_trip_patterns`,
        name: "Trips",
        data_generator:
          'const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];\nconst by = entity.attributes.by_weekday || {};\nconst out = [];\nfor (let i = 0; i < 7; i++) {\n  out.push({ x: labels[i], y: Number(by[String(i)] || 0) });\n}\nreturn out;',
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
      weekdayTile("Mon", "0", "indigo"),
      weekdayTile("Tue", "1", "indigo"),
      weekdayTile("Wed", "2", "indigo"),
      weekdayTile("Thu", "3", "indigo"),
      weekdayTile("Fri", "4", "indigo"),
      weekdayTile("Sat", "5", "orange", "mdi:calendar-weekend"),
      weekdayTile("Sun", "6", "orange", "mdi:calendar-weekend"),
    ])
  );

  return {
    title: "Patterns",
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
    title: "Efficiency",
    subtitle: "Consumption, distance and temperature",
    alignment: "start",
  });

  // ---- Hero — 30-day avg consumption -----------------------------------
  // Green gradient background; state_display appends "kWh/100km".
  cards.push({
    type: "custom:button-card",
    entity: `sensor.${D}_avg_consumption_30_days`,
    name: "Avg consumption (30 days)",
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
    state_display:
      "[[[ const n = entity && Number(entity.state); return (n==null||isNaN(n)) ? '—' : `${n.toFixed(1)} kWh/100km`; ]]]",
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
          name: "Consumption",
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
  // Only render when there is actually bucketed data — an empty by_bucket
  // (no temp sensor yet / synthetic trips) would otherwise show bare axes.
  const tempSt = hass && hass.states[`sensor.${D}_consumption_by_temperature`];
  const tempBuckets = tempSt && tempSt.attributes && tempSt.attributes.by_bucket;
  if (tempBuckets && Object.keys(tempBuckets).length > 0) {
    cards.push({
    type: "custom:apexcharts-card",
    header: { show: true, title: "Consumption by temperature (kWh/100km)", show_states: false },
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
        name: "Consumption",
        type: "column",
        data_generator:
          "const buckets = entity.attributes.by_bucket || {};\nreturn Object.keys(buckets)\n  .map((k) => [parseInt(k, 10), Number(buckets[k])])\n  .filter((p) => !isNaN(p[0]) && !isNaN(p[1]))\n  .sort((a, b) => a[0] - b[0])\n  .map(([k, v]) => [`${k}°C`, v]);",
      },
    ],
    });
  }

  // ---- Footer hint — colored advice -------------------------------------
  cards.push(
    mushroomTpl({
      primary: "Efficiency tip",
      secondary:
        `{% set c = states('sensor.${D}_avg_consumption_30_days') | float(0) %}` +
        `{% if c == 0 %} Not enough data yet.` +
        `{% elif c < 16 %} Excellent — you maintain very efficient consumption.` +
        `{% elif c < 19 %} Good consumption, within the expected range.` +
        `{% elif c < 22 %} A bit high: check your driving style or the weather.` +
        `{% else %} High consumption: short trips/cold/highway have a big impact.{% endif %}`,
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
    title: "Efficiency",
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

  cards.push(mushroomTitle("Records", `{{ states('sensor.${D}_tops') }} ranked trips`, "mdi:trophy"));

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
    title: "Records",
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
    title: "Trip detail",
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
      kpiBtn(`sensor.${D}_last_trip_distance`, "Distance", "mdi:road-variant"),
      kpiBtn(`sensor.${D}_last_trip_energy`, "Consumption", "mdi:lightning-bolt"),
      kpiBtn(`sensor.${D}_last_trip_consumption`, "Efficiency", "mdi:speedometer"),
      {
        type: "custom:button-card",
        // avg_speed_kmh is an attribute, not an entity — use a label template
        // and hide the (empty) state row.
        name: "Avg speed",
        show_state: false,
        show_icon: true,
        icon: "mdi:gauge",
        label:
          "[[[\n  const s = states['sensor." +
          D +
          "_last_trip'];\n  const v = s && s.attributes ? s.attributes.avg_speed_kmh : null;\n  return (v == null) ? '—' : Number(v).toFixed(1) + ' km/h';\n]]]",
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
      primary: "vs your average",
      secondary:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set avg  = states('sensor.${D}_total_30d_avg_consumption') | float(0) %}` +
        `{% if avg > 0 and trip > 0 %}{% set delta = ((trip - avg) / avg) * 100 %}` +
        `{% if delta < 0 %}{{ delta | round(1) }}% better than your average (≈ {{ avg | round(1) }} kWh/100km)` +
        `{% else %}+{{ delta | round(1) }}% worse than your average (≈ {{ avg | round(1) }} kWh/100km){% endif %}` +
        `{% else %}Not enough data yet{% endif %}`,
      icon: "mdi:chart-line-variant",
      iconColor:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set avg  = states('sensor.${D}_total_30d_avg_consumption') | float(0) %}` +
        `{% if avg > 0 and trip > 0 %}{{ 'green' if trip <= avg else 'red' }}{% else %}grey{% endif %}`,
    })
  );

  // ---- Percentilee within the recent_trips window ------------------------
  // Lower consumption is better → "Top X%" = this trip beat X% of recent trips.
  cards.push(
    mushroomTpl({
      primary: "Percentile",
      secondary:
        `{% set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}` +
        `{% set trips = state_attr('sensor.${D}_recent_trips', 'trips') or [] %}` +
        `{% set valid = trips | selectattr('consumption_kwh_100km', 'defined') | rejectattr('consumption_kwh_100km', 'none') | list %}` +
        `{% set total = valid | count %}` +
        `{% if total > 0 and trip > 0 %}` +
        `{% set worse = valid | selectattr('consumption_kwh_100km', '>', trip) | list | count %}` +
        `{% set pct = ((worse / total) * 100) | round(0) %}` +
        `Top {{ pct }}% — better than {{ worse }} of {{ total }} recent trips` +
        `{% else %}No history yet{% endif %}`,
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
    name: "Estimated cost",
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
      title: "Route",
      default_zoom: 13,
      hours_to_show: hoursToShow,
      entities: [{ entity: `device_tracker.${V}_location` }],
    });
  }

  // ---- Footnote about route approximation -------------------------------
  cards.push(
    md(
      "_Approximate route from the `device_tracker` history. The integration " +
        "stores 1 GPS sample every 30 s while the car is on " +
        "(`storage.async_trip_positions(trip_id)`). To draw the exact route " +
        "install a Leaflet map (e.g. `ha-card-leaflet` or `plotly-graph-card` " +
        "with geo scatter) and feed it from a REST/template sensor that reads those positions._"
    )
  );

  return {
    title: "Detail",
    path: "trip-detail",
    icon: "mdi:magnify",
    type: "sections",
    max_columns: 2,
    sections: [grid(cards)],
  };
}

// ==========================================================================
// View 8 — Viajes (Pantalla 8)
// "Trips" header + Last-30-days KPI strip (5 tiles) + ev-trip-list-card
// (custom element ships with this plugin — replaces the markdown blob in
// trip-list-v2.yaml with a reactive, expandable list).
// ==========================================================================
function viajesView(D, hass) {
  const cards = [];

  cards.push(mushroomTitle("Trips", "Last 30 days", "mdi:car-electric"));

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
        state_display:
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${v} km` ]]]",
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
        state_display:
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${v} kWh/100km` ]]]",
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
        state_display:
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${v} min` ]]]",
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
        state_display:
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${v} km/h` ]]]",
      },
    ],
  });

  // ---- Reactive trip list (custom element from this plugin) ------------
  // Replaces the per-row Jinja markdown of trip-list-v2.yaml with a sortable,
  // searchable, expandable list. Honours the same input helpers when present.
  cards.push({ type: "custom:ev-trip-list-card", device: D, title: "Recent trips" });

  return {
    // Demoted to a distinct path so the restored pre-2.0 "Trips" (left list +
    // right records/search) can reclaim the canonical "trips" slot. Remove this
    // view once the restored one is confirmed as the keeper.
    title: "Trips (cards)",
    path: "trips-cards",
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

  cards.push(mushroomTitle("Charges", "Last 30 days", "mdi:battery-charging"));

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
        entity: `sensor.${D}_avg_charge_energy_30_days`,
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
        name: "Total charges",
        icon: "mdi:counter",
        show_state: true,
        show_name: true,
        show_icon: true,
        // Count the recent_charges window so it matches the list below
        // ("9 charges"), instead of charges_this_month which only counts
        // the current calendar month.
        state_display:
          "[[[\n  const s = states['sensor." +
          D +
          "_recent_charges'];\n  const arr = s && s.attributes && Array.isArray(s.attributes.charges) ? s.attributes.charges : null;\n  return arr ? String(arr.length) : '—';\n]]]",
        styles: chKpiStyles("var(--success-color)"),
      },
    ],
  });

  // ---- Reactive charges history (custom element from this plugin) ------
  // Replaces the Jinja markdown blob; groups sessions by calendar day with
  // expandable detail panels.
  cards.push({ type: "custom:ev-trip-history-card", device: D, kind: "charges", title: "Charge history" });

  // NOTE: a floating "+" to log a manual charge used to live here, but it
  // fired ev_trip_logger.log_charge with empty service_data → the service
  // rejects it ("required key 'kwh'"). Charges are auto-detected by the
  // logger's charge_sensor anyway. To re-add manual logging, wire a
  // browser_mod popup with input_number helpers for kwh + €/kWh.

  return {
    title: "Charges",
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

    // Mean efficiency of the filtered set (for "Compared to your average").
    const effVals = rows.map((t) => t.consumption_kwh_100km).filter((v) => v != null && !isNaN(v) && v !== 0);
    const effMean = effVals.length ? effVals.reduce((a, b) => a + b, 0) / effVals.length : null;
    // Scores of the filtered set (for percentile).
    const scoreVals = rows.map((t) => t.score).filter((v) => v != null && !isNaN(v));

    // Builds the BYD-app-style "Trip detail" panel for one trip.
    const detailHtml = (t) => {
      const sym = cur[t.currency] || t.currency || "€";
      const scoreNum = t.score != null ? Number(t.score).toFixed(1) : DASH;
      const tile = (icon, label, value, unit) => `
        <div class="d-tile">
          <ha-icon class="d-tile-icon" icon="${icon}"></ha-icon>
          <div class="d-tile-label">${_esc(label)}</div>
          <div class="d-tile-value">${value}<span class="d-tile-unit">${unit ? " " + _esc(unit) : ""}</span></div>
        </div>`;

      // Avg speed — derived, guard divide-by-zero.
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
          `<div class="d-cmp-row"><span class="d-cmp-label">Compared to your average</span>` +
          `<span class="d-cmp-val" style="color:${color}">${sign}${Math.abs(pct).toFixed(1)}%</span></div>`
        );
      }
      if (t.score != null && scoreVals.length) {
        const better = scoreVals.filter((s) => s >= t.score).length;
        const topPct = (better / scoreVals.length) * 100;
        cmpRows.push(
          `<div class="d-cmp-row"><span class="d-cmp-label">Percentile</span>` +
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
            <div class="d-title">Trip detail</div>
            <div class="d-score">
              <span class="d-score-num" style="color:${_scoreColor(t.score)}">${scoreNum}</span>
              <span class="d-score-max">/10</span>
            </div>
          </div>
          <div class="d-sub">${_fmtDate(t.ended_at, true)}</div>
          <div class="d-grid">
            ${tile("mdi:map-marker-distance", "Distance", fmtNum(t.distance_km), "km")}
            ${tile("mdi:timer-outline", "Duration", fmtNum(t.duration_min == null ? null : Math.round(t.duration_min)), "min")}
            ${tile("mdi:lightning-bolt", "Consumption", fmtNum(t.energy_kwh), "kWh")}
            ${tile("mdi:chart-line", "Efficiency", fmtNum(t.consumption_kwh_100km), "kWh/100km")}
          </div>
          <div class="d-tile d-tile--wide">
            <ha-icon class="d-tile-icon" icon="mdi:speedometer"></ha-icon>
            <div class="d-tile-label">Avg speed</div>
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
                ${col("Distance", fmtNum(t.distance_km), "km")}
                ${col("Consumption", fmtNum(t.energy_kwh), "kWh")}
                ${col("Efficiency", fmtNum(t.consumption_kwh_100km), "kWh/100km")}
                ${col("Cost", fmtNum(t.cost), sym || DASH)}
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

          /* ---- Trip detail panel ("Trip detail") ---- */
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

// ==========================================================================
// Custom card: monthly history as proportional bars (no apexcharts).
// Reads sensor.<device>_monthly_history.attributes.months =
//   [{month:"YYYY-MM", distance_km, energy_kwh, cost, trips}] (chronological).
// Robust vanilla-JS alternative to the apex dual-axis bar — degrades to a
// friendly "needs logger v0.5.0" note when the sensor is absent.
// ==========================================================================
const _MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const _fmtMonth = (ym) => {
  const [y, m] = String(ym || "").split("-").map(Number);
  return y && m ? `${_MONTHS_ABBR[m - 1]} '${String(y).slice(-2)}` : String(ym || "—");
};
class EvTripMonthlyCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
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
    this._device = D;
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const st = this._hass.states[`sensor.${D}_monthly_history`];
    const months = (st && st.attributes && Array.isArray(st.attributes.months) && st.attributes.months) || [];
    const sym = cur[st && st.attributes && st.attributes.currency] || "€";

    if (!months.length) {
      this.innerHTML = `
        <ha-card>
          <div class="mh-head">Monthly history</div>
          <div class="mh-empty">No monthly data yet.<br><span>Provided by <code>sensor.${_esc(D)}_monthly_history</code> (logger v0.5.0).</span></div>
          <style>
            .mh-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
            .mh-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);line-height:1.5;}
            .mh-empty span{font-size:.85em;opacity:.8;}
          </style>
        </ha-card>`;
      return;
    }

    const maxKm = Math.max(1, ...months.map((m) => Number(m.distance_km) || 0));
    const totKm = months.reduce((a, m) => a + (Number(m.distance_km) || 0), 0);
    const totKwh = months.reduce((a, m) => a + (Number(m.energy_kwh) || 0), 0);
    const rows = months
      .slice()
      .reverse()
      .map((m) => {
        const km = Number(m.distance_km) || 0;
        const kwh = Number(m.energy_kwh) || 0;
        const cost = Number(m.cost) || 0;
        const pct = Math.round((km / maxKm) * 100);
        const eff = km > 0 ? ((kwh / km) * 100).toFixed(1) : "—";
        return `
          <div class="mh-row">
            <div class="mh-month">${_esc(_fmtMonth(m.month))}</div>
            <div class="mh-track"><div class="mh-fill" style="width:${pct}%"></div></div>
            <div class="mh-vals"><b>${km.toFixed(0)}</b> km · ${kwh.toFixed(1)} kWh · ${cost.toFixed(2)} ${_esc(sym)} · <span class="mh-eff">${eff}</span> kWh/100</div>
          </div>`;
      })
      .join("");

    this.innerHTML = `
      <ha-card>
        <div class="mh-head">Monthly history
          <span class="mh-tot">${totKm.toFixed(0)} km · ${totKwh.toFixed(0)} kWh</span>
        </div>
        <div class="mh-list">${rows}</div>
        <style>
          .mh-head{display:flex;justify-content:space-between;align-items:baseline;
                   padding:14px 16px 10px;font-weight:600;font-size:1.05em;}
          .mh-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;}
          .mh-list{display:flex;flex-direction:column;gap:8px;padding:0 16px 16px;}
          .mh-row{display:grid;grid-template-columns:62px 1fr;grid-template-rows:auto auto;
                  column-gap:10px;row-gap:3px;align-items:center;}
          .mh-month{grid-row:1 / span 2;font-weight:600;font-variant-numeric:tabular-nums;}
          .mh-track{height:10px;border-radius:6px;background:var(--divider-color);overflow:hidden;}
          .mh-fill{height:100%;border-radius:6px;
                   background:linear-gradient(90deg,var(--info-color,#039be5),var(--primary-color));}
          .mh-vals{font-size:.8em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .mh-eff{color:var(--success-color,#43a047);font-weight:600;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-monthly-card", EvTripMonthlyCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-monthly-card", name: "EV Trip — monthly history", description: "Per-month km/kWh/cost bars (logger v0.5.0)." });

// ==========================================================================
// Custom card: trip patterns — by-hour bars + weekday km/count strip.
// Reads sensor.<device>_trip_patterns.attributes:
//   by_hour {"0".."23": count}, by_weekday {"0".."6": count} (0=Mon),
//   km_by_weekday {"0".."6": km}, sample_count.
// Consolidates the apex by-hour bars + radar + mushroom km strip into one
// robust vanilla-JS card.
// ==========================================================================
const _WD_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
class EvTripPatternsCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
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
    this._device = D;
    const st = this._hass.states[`sensor.${D}_trip_patterns`];
    const a = (st && st.attributes) || {};
    const byHour = a.by_hour || {};
    const byWd = a.by_weekday || {};
    const kmWd = a.km_by_weekday || {};
    const total = Number(a.sample_count) || 0;

    if (!st || total === 0) {
      this.innerHTML = `
        <ha-card>
          <div class="tp-head">Driving patterns</div>
          <div class="tp-empty">No pattern data yet.<br><span>Provided by <code>sensor.${_esc(D)}_trip_patterns</code> (logger v0.5.0).</span></div>
          <style>
            .tp-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
            .tp-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);line-height:1.5;}
            .tp-empty span{font-size:.85em;opacity:.8;}
          </style>
        </ha-card>`;
      return;
    }

    const maxHour = Math.max(1, ...Array.from({ length: 24 }, (_, h) => Number(byHour[String(h)]) || 0));
    const hourBars = Array.from({ length: 24 }, (_, h) => {
      const v = Number(byHour[String(h)]) || 0;
      const pct = Math.round((v / maxHour) * 100);
      const lbl = h % 6 === 0 ? `${h}h` : "";
      return `<div class="tp-hbar" title="${h}:00 — ${v} trips"><div class="tp-hfill" style="height:${pct}%"></div><div class="tp-hlbl">${lbl}</div></div>`;
    }).join("");

    const maxKm = Math.max(1, ...Array.from({ length: 7 }, (_, w) => Number(kmWd[String(w)]) || 0));
    const wdCells = Array.from({ length: 7 }, (_, w) => {
      const km = Number(kmWd[String(w)]) || 0;
      const n = Number(byWd[String(w)]) || 0;
      const pct = Math.round((km / maxKm) * 100);
      const weekend = w >= 5 ? " tp-weekend" : "";
      return `
        <div class="tp-wd${weekend}" title="${_WD_ABBR[w]} — ${km.toFixed(0)} km, ${n} trips">
          <div class="tp-wtrack"><div class="tp-wfill" style="height:${pct}%"></div></div>
          <div class="tp-wkm">${km.toFixed(0)}</div>
          <div class="tp-wlbl">${_WD_ABBR[w]}</div>
          <div class="tp-wn">${n}</div>
        </div>`;
    }).join("");

    this.innerHTML = `
      <ha-card>
        <div class="tp-head">Driving patterns <span class="tp-tot">${total} trips · 90 d</span></div>
        <div class="tp-section">By hour of day</div>
        <div class="tp-hours">${hourBars}</div>
        <div class="tp-section">By weekday <span class="tp-legend">km · trips</span></div>
        <div class="tp-week">${wdCells}</div>
        <style>
          .tp-head{display:flex;justify-content:space-between;align-items:baseline;
                   padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
          .tp-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;}
          .tp-section{padding:8px 16px 4px;font-size:.78em;font-weight:600;
                      text-transform:uppercase;letter-spacing:.04em;
                      color:var(--secondary-text-color);
                      display:flex;justify-content:space-between;}
          .tp-legend{font-weight:400;text-transform:none;letter-spacing:0;}
          .tp-hours{display:flex;align-items:flex-end;gap:2px;height:84px;padding:0 14px 2px;}
          .tp-hbar{flex:1 1 0;height:100%;display:flex;flex-direction:column;
                   justify-content:flex-end;align-items:center;position:relative;}
          .tp-hfill{width:70%;min-height:2px;border-radius:3px 3px 0 0;
                    background:var(--info-color,#039be5);}
          .tp-hlbl{position:absolute;bottom:-15px;font-size:.6em;
                   color:var(--secondary-text-color);}
          .tp-hours{margin-bottom:16px;}
          .tp-week{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;padding:0 14px 16px;}
          .tp-wd{display:flex;flex-direction:column;align-items:center;gap:2px;
                 background:var(--secondary-background-color,var(--card-background-color));
                 border:1px solid var(--divider-color);border-radius:10px;padding:8px 2px 6px;}
          .tp-weekend{border-color:var(--warning-color,#fb8c00);}
          .tp-wtrack{height:52px;width:10px;border-radius:6px;background:var(--divider-color);
                     display:flex;align-items:flex-end;overflow:hidden;}
          .tp-wfill{width:100%;border-radius:6px;background:var(--primary-color);}
          .tp-weekend .tp-wfill{background:var(--warning-color,#fb8c00);}
          .tp-wkm{font-weight:700;font-size:.9em;font-variant-numeric:tabular-nums;}
          .tp-wlbl{font-size:.7em;color:var(--secondary-text-color);}
          .tp-wn{font-size:.68em;color:var(--secondary-text-color);
                 font-variant-numeric:tabular-nums;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-patterns-card", EvTripPatternsCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-patterns-card", name: "EV Trip — driving patterns", description: "By-hour bars + weekday km/trips strip (logger v0.5.0)." });

// ==========================================================================
// Custom card: daily km over the last 60 days as a thin bar sparkline.
// Reads sensor.<device>_daily_km_60d.attributes.days =
//   [{day:"YYYY-MM-DD", distance_km}] (zero-filled, chronological).
// Robust vanilla-JS alternative to the apex 60-day line.
// ==========================================================================
class EvTripDailyCard extends HTMLElement {
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
    const st = this._hass.states[`sensor.${D}_daily_km_60d`];
    const days = (st && st.attributes && Array.isArray(st.attributes.days) && st.attributes.days) || [];

    if (!days.length) {
      this.innerHTML = `
        <ha-card>
          <div class="dk-head">Daily km · 60 days</div>
          <div class="dk-empty">No daily data yet.<br><span>Provided by <code>sensor.${_esc(D)}_daily_km_60d</code> (logger v0.5.0).</span></div>
          <style>
            .dk-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
            .dk-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);line-height:1.5;}
            .dk-empty span{font-size:.85em;opacity:.8;}
          </style>
        </ha-card>`;
      return;
    }

    const vals = days.map((d) => Number(d.distance_km) || 0);
    const maxKm = Math.max(1, ...vals);
    const totKm = vals.reduce((a, b) => a + b, 0);
    const drivenDays = vals.filter((v) => v > 0).length;
    const avgKm = drivenDays ? totKm / drivenDays : 0;
    // Label the first day, ~middle and last day of the window.
    const lblIdx = new Set([0, Math.floor(days.length / 2), days.length - 1]);
    const fmtDay = (iso) => {
      const p = String(iso || "").split("-");
      return p.length === 3 ? `${p[2]}/${p[1]}` : String(iso || "");
    };
    const bars = days
      .map((d, i) => {
        const km = Number(d.distance_km) || 0;
        const pct = Math.round((km / maxKm) * 100);
        const lbl = lblIdx.has(i) ? `<div class="dk-lbl">${fmtDay(d.day)}</div>` : "";
        return `<div class="dk-bar" title="${_esc(fmtDay(d.day))} — ${km.toFixed(1)} km"><div class="dk-fill" style="height:${pct}%"></div>${lbl}</div>`;
      })
      .join("");

    this.innerHTML = `
      <ha-card>
        <div class="dk-head">Daily km · 60 days
          <span class="dk-tot">${totKm.toFixed(0)} km · ${avgKm.toFixed(1)} km/active-day</span>
        </div>
        <div class="dk-chart">${bars}</div>
        <style>
          .dk-head{display:flex;justify-content:space-between;align-items:baseline;
                   padding:14px 16px 8px;font-weight:600;font-size:1.05em;flex-wrap:wrap;gap:4px;}
          .dk-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;
                  font-variant-numeric:tabular-nums;}
          .dk-chart{display:flex;align-items:flex-end;gap:1px;height:96px;
                    padding:0 14px 22px;position:relative;}
          .dk-bar{flex:1 1 0;height:100%;display:flex;flex-direction:column;
                  justify-content:flex-end;align-items:center;position:relative;}
          .dk-fill{width:80%;min-height:1px;border-radius:2px 2px 0 0;
                   background:linear-gradient(180deg,var(--info-color,#039be5),var(--primary-color));}
          .dk-lbl{position:absolute;bottom:-18px;font-size:.6em;white-space:nowrap;
                  color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-daily-card", EvTripDailyCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-daily-card", name: "EV Trip — daily km (60d)", description: "Daily km sparkline for the last 60 days (logger v0.5.0)." });

// ==========================================================================
// RESTORED from v1.5.0 (user favourites, pre-2.0): Driving + Trips views.
// Additive — the 9-view equivalents stay until these are validated.
// ==========================================================================
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
        // Restored pre-2.0 favourites first (Driving + Trips with records/search).
        drivingView(D, V, hass),
        tripsView(D),
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
