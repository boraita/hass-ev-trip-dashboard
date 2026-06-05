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

// Resolve a "vehicle concept" to a concrete entity across car integrations
// (BYD/Tesla/…), so the Driving view isn't hard-wired to BYD entity names.
// Order: explicit config override (e.g. range_entity:) → known name candidates
// → device_class/keyword auto-detect among the vehicle slug's own entities.
function pickVehicleEntity(hass, V, concept, cfg) {
  cfg = cfg || {};
  const ovr = cfg[`${concept}_entity`];
  if (ovr && has(hass, ovr)) return ovr;
  const NAMES = {
    range: [`sensor.${V}_range`, `sensor.${V}_battery_range`],
    odometer: [`sensor.${V}_odometer`],
    outside_temp: [`sensor.${V}_exterior_temperature`, `sensor.${V}_outside_temperature`],
    cabin_temp: [`sensor.${V}_cabin_temperature`, `sensor.${V}_inside_temperature`],
    soh: [`sensor.${V}_state_of_health`, `sensor.${V}_battery_health`],
    location: [`device_tracker.${V}_location`, `device_tracker.${V}`],
    plug: [`binary_sensor.${V}_plug`, `binary_sensor.${V}_charge_cable`, `binary_sensor.${V}_charging_cable`, `binary_sensor.${V}_charge_port`],
    charging: [`binary_sensor.${V}_charging`, `binary_sensor.${V}_charging_system`],
  };
  for (const e of NAMES[concept] || []) if (hasVal(hass, e)) return e;
  const ids = Object.keys(hass.states).filter((id) => id.includes(`.${V}_`) || id.endsWith(`.${V}`));
  const dc = (id) => (hass.states[id].attributes || {}).device_class;
  const find = (pred) => ids.find((id) => { try { return pred(id); } catch (_e) { return false; } });
  switch (concept) {
    case "range": return find((id) => id.startsWith("sensor.") && dc(id) === "distance" && /range/.test(id)) || null;
    case "odometer": return find((id) => id.startsWith("sensor.") && dc(id) === "distance" && /odo/.test(id)) || null;
    case "outside_temp": return find((id) => id.startsWith("sensor.") && dc(id) === "temperature" && /(out|exter|ambient)/.test(id)) || null;
    case "cabin_temp": return find((id) => id.startsWith("sensor.") && dc(id) === "temperature" && /(in|cabin|interior)/.test(id)) || null;
    case "soh": return find((id) => id.startsWith("sensor.") && /(state_of_health|_soh|battery_health)/.test(id)) || null;
    case "location": return find((id) => id.startsWith("device_tracker.")) || null;
    case "plug": return find((id) => id.startsWith("binary_sensor.") && (dc(id) === "plug" || /(plug|cable)/.test(id))) || null;
    case "charging": return find((id) => id.startsWith("binary_sensor.") && dc(id) === "battery_charging") || null;
    default: return null;
  }
}

// All four TPMS corners in display order; [] if the car exposes no tire sensors.
function pickTireEntities(hass, V, cfg) {
  cfg = cfg || {};
  if (Array.isArray(cfg.tire_pressure_entities) && cfg.tire_pressure_entities.length)
    return cfg.tire_pressure_entities.filter((e) => has(hass, e)).map((e, i) => [e, ["Front Left", "Front Right", "Rear Left", "Rear Right"][i] || "Tire"]);
  const press = Object.keys(hass.states).filter(
    (id) => id.startsWith("sensor.") && (id.includes(`.${V}_`)) &&
      ((hass.states[id].attributes || {}).device_class === "pressure" || /tire|tyre|tpms/.test(id))
  );
  const out = [];
  for (const [re, name] of [[/(front.*left|_fl)/, "Front Left"], [/(front.*right|_fr)/, "Front Right"], [/(rear.*left|_rl)/, "Rear Left"], [/(rear.*right|_rr)/, "Rear Right"]]) {
    const m = press.find((id) => re.test(id));
    if (m) out.push([m, name]);
  }
  return out;
}

// Resolve the charging-power entity (for the live graph + per-charge curve)
// generically: config override → logger's own → a detected *charger_power*.
function resolveChargePower(hass, D, cfg) {
  cfg = cfg || {};
  if (cfg.charge_power_entity && has(hass, cfg.charge_power_entity)) return cfg.charge_power_entity;
  const own = `sensor.${D}_current_charge_power`;
  if (has(hass, own)) return own;
  const cand = Object.keys(hass.states).find(
    (id) => id.startsWith("sensor.") && (hass.states[id].attributes || {}).device_class === "power" && /charg/.test(id)
  );
  return cand || own;
}

// Current charge state, shared by the Driving charge card + the trip-list live
// row. state ∈ "charging" (drawing power) | "paused" (cable in, not charging) |
// "idle" (unplugged). plugEnt/chargingEnt/powerEnt are resolved generically.
function evChargeState(hass, D, plugEnt, chargingEnt, powerEnt) {
  const s = (id) => { const e = id && hass.states[id]; return e ? e.state : undefined; };
  const num = (id) => { const v = parseFloat(s(id)); return isNaN(v) ? null : v; };
  const cip = String(s(`sensor.${D}_charge_in_progress`) || "").toLowerCase();
  const chgBin = chargingEnt ? String(s(chargingEnt)).toLowerCase() === "on" : false;
  const pwr = powerEnt ? num(powerEnt) : null;
  const charging = cip === "charging" || chgBin || (pwr != null && pwr > 0.05);
  // plugEnt may be a single entity or a LIST (e.g. wallbox + car plug). The
  // cable counts as connected only when every sensor that reports a usable
  // on/off agrees on "on" — so one flappy sensor saying "on" can't fake it,
  // and an unknown/asleep sensor is ignored rather than blocking.
  const plugList = Array.isArray(plugEnt) ? plugEnt : plugEnt ? [plugEnt] : [];
  const pStates = plugList.map((e) => String(s(e) || "").toLowerCase()).filter((v) => v === "on" || v === "off");
  const plugSensorsConnected = pStates.length > 0 && pStates.every((v) => v === "on");
  const plugged = charging || plugSensorsConnected;
  // When charging stops the logger drops current_charge_* to unknown, so fall
  // back to the just-finished charge for the paused view — BUT only if that
  // charge belongs to THE CURRENT plug session (ended after the cable was
  // connected). Otherwise (e.g. cable plugged now but the last charge was this
  // morning), the paused card must NOT show that old charge's energy/time.
  let plugSince = null;
  for (const e of plugList) {
    const o = hass.states[e];
    if (o && String(o.state).toLowerCase() === "on") {
      const t = new Date(o.last_changed).getTime();
      if (!isNaN(t) && (plugSince == null || t < plugSince)) plugSince = t; // connected since the earliest
    }
  }
  const rc = hass.states[`sensor.${D}_recent_charges`];
  const lastRaw = (rc && rc.attributes && Array.isArray(rc.attributes.charges) && rc.attributes.charges[0]) || null;
  // A charge is "this session" if it ended at/after the cable was connected
  // (5-min grace). When charging live we always treat it as the current one.
  const inSession =
    charging ||
    (lastRaw && lastRaw.ended_at && plugSince != null && new Date(lastRaw.ended_at).getTime() >= plugSince - 300000);
  const last = inSession ? lastRaw : null;
  let lastDurMin = null;
  if (last && last.started_at && last.ended_at) {
    const d = (new Date(last.ended_at) - new Date(last.started_at)) / 60000;
    if (!isNaN(d) && d >= 0) lastDurMin = d;
  }
  const liveDur = s(`sensor.${D}_current_charge_duration`);
  const liveDurOk = liveDur && !["unknown", "unavailable", "none"].includes(String(liveDur).toLowerCase());
  return {
    state: charging ? "charging" : plugged ? "paused" : "idle",
    charging, plugged,
    // live power while charging; 0 while paused (cable in, not drawing power).
    power: charging ? (pwr != null ? pwr : 0) : plugged ? 0 : pwr,
    energy: num(`sensor.${D}_current_charge_energy`),
    durationMin: liveDurOk ? parseFloat(liveDur) : null,
    soc: num(`sensor.${D}_battery_percent`),
    price: num(`sensor.${D}_current_charge_price_per_kwh`),
    type: s(`sensor.${D}_current_charge_type`),
    lastEnergy: last && last.kwh != null ? Number(last.kwh) : null,
    lastDurMin,
  };
}

// ---- graceful degradation when HACS frontend cards aren't installed --------
// The dashboard uses custom:button-card / mushroom-* / apexcharts-card /
// mini-graph-card. If a user hasn't installed one, those cards throw
// "Configuration error". We post-process the generated card tree and swap any
// custom:<x> whose element isn't registered for a native equivalent. Our own
// bundled ev-trip-* cards are always registered, so they're never touched.
function nativeFallback(c, bare) {
  switch (bare) {
    case "mushroom-title-card":
      return { type: "heading", heading: c.title || c.subtitle || "", ...(c.icon ? { icon: c.icon } : {}) };
    case "mushroom-chips-card":
      return null; // chips have no clean native equal — drop
    case "mushroom-template-card": {
      const parts = [];
      if (c.primary) parts.push(`### ${c.primary}`);
      if (c.secondary) parts.push(c.secondary);
      const content = parts.join("\n\n") || (c.entity ? `{{ states('${c.entity}') }}` : "");
      return content ? { type: "markdown", content } : null;
    }
    case "button-card":
      if (c.entity) return { type: "tile", entity: c.entity, ...(c.name ? { name: c.name } : {}) };
      return c.name ? { type: "markdown", content: `**${c.name}**` } : null;
    case "apexcharts-card":
      return null; // the bundled ev-trip-* cards already render this data
    case "mini-graph-card": {
      const ents = (c.entities || []).map((e) => (typeof e === "string" ? e : e && e.entity)).filter(Boolean);
      return ents.length ? { type: "history-graph", entities: ents, hours_to_show: c.hours_to_show || 24 } : null;
    }
    default:
      return null; // unknown, uninstalled custom card → drop rather than error
  }
}
function degradeCard(node) {
  if (Array.isArray(node)) return node.map(degradeCard).filter((x) => x != null);
  if (!node || typeof node !== "object") return node;
  let n = node;
  const t = typeof n.type === "string" ? n.type : null;
  if (t && t.indexOf("custom:") === 0) {
    const bare = t.slice(7);
    if (!hasCard(bare)) {
      const fb = nativeFallback(n, bare);
      if (fb == null) return null;
      n = fb;
    }
  }
  const out = { ...n };
  if (Array.isArray(out.cards)) out.cards = out.cards.map(degradeCard).filter((x) => x != null);
  if (out.card) out.card = degradeCard(out.card);
  if (Array.isArray(out.sections)) {
    out.sections = out.sections.map((s) => {
      const sd = { ...s };
      if (Array.isArray(sd.cards)) sd.cards = sd.cards.map(degradeCard).filter((x) => x != null);
      return sd;
    });
  }
  return out;
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

// The fancy cards register asynchronously; await them (with a per-card timeout)
// before generate() builds views so hasCard() reflects what's installed.
const _FANCY_CARDS = [
  "mushroom-template-card",
  "mushroom-chips-card",
  "mushroom-title-card",
  "apexcharts-card",
  "mini-graph-card",
  "button-card",
  "calendar-card-pro",
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
function calendarioView(D, hass, V, cfg) {
  const cards = [
    mushroomTitle("EV Activity", null, "mdi:calendar"),
    // NEW: robust monthly calendar built from EXISTING recent_trips +
    // recent_charges — works today, no v0.5.0 calendar entity required.
    // locationEntity lets the day detail draw each journey's GPS route from
    // the device_tracker recorder history.
    {
      type: "custom:ev-trip-calendar-card",
      device: D,
      locationEntity: (cfg && cfg.location_entity) || (hass ? pickVehicleEntity(hass, V, "location", cfg) : null),
    },
  ];

  // calendar-card-pro removed — the custom ev-trip-calendar-card above is the
  // generic, working calendar (no v0.5.0 calendar entity required).

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
      `{{ (d|float)|round(1) if d not in ['unknown','unavailable','None'] else '—' }} km · ` +
      `{{ (t|float)|round(0) if t not in ['unknown','unavailable','None'] else '—' }} min`,
    icon: "mdi:road-variant",
    iconColor: "blue",
    fillContainer: true,
  });

  const drivingTime = mushroomTpl({
    primary: "Driving time",
    secondary:
      `{% set t = states('sensor.${D}_driving_time_30_days') %}` +
      `{{ (t|float/60)|round(1) if t not in ['unknown','unavailable','None'] else '—' }} h (30d)`,
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

  // Apex "Monthly Km & kWh" + "60-day line" removed — the ev-trip-monthly-card
  // and ev-trip-daily-card above render the same data reliably (apex category
  // bars rendered blank).

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

  // Apex by-hour + "By day" radar + mushroom weekday strip removed —
  // superseded by ev-trip-patterns-card above (the radar was stuck loading).

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

  // ---- NEW: robust efficiency-vs-distance scatter (works on existing data) --
  // Additive: above the apex scatter below; retire the apex once validated.
  cards.push({ type: "custom:ev-trip-efficiency-card", device: D });

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

  // Apex "Efficiency vs Distance" scatter removed — superseded by
  // ev-trip-efficiency-card above (cleaner, rounded axis labels).

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

  // NEW: robust records board (leaders + expandable top-9) from sensor.<D>_tops.
  cards.push({ type: "custom:ev-trip-records-card", device: D });

  // Old apex/button top-9 lists + record KPI tiles removed — replaced by
  // ev-trip-records-card above (nicer expandable board).

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
// 30-day average KPI tiles — moved out of the old Trips-cards view so the
// restored Trips view can show them on top.
function trips30dKpis(D) {
  const kpiStyles = {
    card: [{ padding: "12px" }, { "border-radius": "14px" }],
    name: [{ "font-size": "12px" }, { opacity: "0.75" }],
    state: [{ "font-size": "18px" }, { "font-weight": "bold" }],
  };

  return {
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
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(1)} km` ]]]",
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
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(1)} kWh/100km` ]]]",
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
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(0)} min` ]]]",
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
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(1)} km/h` ]]]",
      },
    ],
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

  // ---- Live charging session — kW curve + elapsed time -----------------
  // Only while a charge is in progress: a mini-graph of the charging power
  // (kW being added over time) plus energy / duration / current kW.
  if (has(hass, `sensor.${D}_current_charge_power`) && hasCard("mini-graph-card")) {
    cards.push({
      type: "conditional",
      conditions: [{ condition: "state", entity: `sensor.${D}_charge_in_progress`, state: "charging" }],
      card: {
        type: "vertical-stack",
        cards: [
          {
            type: "custom:mini-graph-card",
            name: "Charging power",
            icon: "mdi:ev-station",
            hours_to_show: 6,
            points_per_hour: 60,
            line_width: 4,
            smoothing: true,
            show: { fill: "fade", state: true, name: true },
            entities: [{ entity: `sensor.${D}_current_charge_power`, name: "kW" }],
          },
          {
            type: "glance",
            columns: 3,
            entities: [
              { entity: `sensor.${D}_current_charge_energy`, name: "Added" },
              { entity: `sensor.${D}_current_charge_duration`, name: "Time" },
              { entity: `sensor.${D}_current_charge_power`, name: "kW now" },
            ],
          },
        ],
      },
    });
  }

  // (Per-charge power curves are rendered inside the charge history card —
  // each charge shows its own kW-vs-time graph when its day is expanded.)

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

  // ---- Quick-fix the last charge's €/kWh -------------------------------
  // Auto-detect saves charges at the home price; this lets you correct the
  // most recent one on the fly. button-card can't template service_data, so
  // the Apply button calls a runtime HA script `script.<device>_apply_charge_price`
  // which reads the input_number via server-side Jinja and calls
  // ev_trip_logger.set_last_charge_price. Set the value to 0 for a free charge.
  // Shown only when BOTH the input_number helper and the script exist.
  if (has(hass, `input_number.${D}_charge_price_edit`) && has(hass, `script.${D}_apply_charge_price`)) {
    cards.push({
      type: "vertical-stack",
      cards: [
        {
          type: "entities",
          title: "Fix last charge €/kWh",
          show_header_toggle: false,
          entities: [{ entity: `input_number.${D}_charge_price_edit`, name: "New €/kWh" }],
        },
        {
          type: "custom:button-card",
          name: "Apply to last charge",
          icon: "mdi:content-save-outline",
          show_state: false,
          styles: {
            card: [{ padding: "10px" }, { "border-radius": "12px" }, { "background-color": "var(--primary-color)" }],
            name: [{ color: "white" }, { "font-weight": "600" }],
            icon: [{ color: "white" }, { width: "22px" }],
          },
          tap_action: {
            action: "call-service",
            service: `script.${D}_apply_charge_price`,
            service_data: {},
          },
        },
      ],
    });
  }

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
    return { rows, total, sort };
  }
  _render() {
    if (!this._hass) return;
    // Lazy-bind the click delegation in case connectedCallback hasn't run.
    if (!this._clickBound && typeof this.addEventListener === "function") {
      this.connectedCallback();
    }
    const { rows, total, sort } = this._filteredTrips();
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const DASH = "—";
    const fmtNum = (v, dp) => (v == null || isNaN(v) ? DASH : dp == null ? String(v) : Number(v).toFixed(dp));
    // Non-negative: energy/consumption can't be < 0 from driving — a negative
    // means the logger counted a period that included charging (SoC rose) as a
    // trip. Show "—" instead of a nonsensical negative.
    const nn = (v, dp) => (v == null || isNaN(v) || Number(v) < 0 ? DASH : fmtNum(v, dp));

    // Mean efficiency of the filtered set (for "Compared to your average").
    const effVals = rows.map((t) => t.consumption_kwh_100km).filter((v) => v != null && !isNaN(v) && v !== 0);
    const effMean = effVals.length ? effVals.reduce((a, b) => a + b, 0) / effVals.length : null;
    // Scores of the filtered set (for percentile).
    const scoreVals = rows.map((t) => t.score).filter((v) => v != null && !isNaN(v));

    // Charges — interleaved as their own rows between trips (timeline), so a
    // charge shows once, in its place, instead of being attributed to trips.
    const D2 = this._device || detectDevice(this._hass);
    const chSt = this._hass.states[`sensor.${D2}_recent_charges`];
    const charges = (chSt && chSt.attributes && Array.isArray(chSt.attributes.charges) && chSt.attributes.charges) || [];

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
          `<div class="d-cmp-row"><span class="d-cmp-label">Estimated cost</span>` +
          `<span class="d-cmp-val" style="color:var(--warning-color, #fb8c00)">${fmtNum(t.cost, 2)} ${_esc(sym)}</span></div>`
        );
      }
      // Effective €/kWh applied to this trip (= cost / energy).
      if (t.cost != null && t.energy_kwh != null && t.energy_kwh > 0) {
        cmpRows.push(
          `<div class="d-cmp-row"><span class="d-cmp-label">Price applied</span>` +
          `<span class="d-cmp-val">${(t.cost / t.energy_kwh).toFixed(3)} ${_esc(sym)}/kWh</span></div>`
        );
      }
      // (Charge info is shown as its own row between trips in the timeline,
      // not per-trip — a charge belongs to one trip, not every later one.)

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
            ${tile("mdi:lightning-bolt", "Consumption", nn(t.energy_kwh), "kWh")}
            ${tile("mdi:chart-line", "Efficiency", nn(t.consumption_kwh_100km), "kWh/100km")}
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

    const tripRowHtml = (t) => {
      const sym = cur[t.currency] || t.currency || "";
      const score = t.score != null ? Number(t.score).toFixed(1) : DASH;
      const isOpen = t.id != null && String(this._openTripId) === String(t.id);
      return `
        <div class="trip${isOpen ? " trip--open" : ""}" data-trip-id="${_esc(t.id)}">
          <div class="trip-date">${_fmtDate(t.ended_at, true)}</div>
          <div class="cols">
            ${col("Distance", fmtNum(t.distance_km), "km")}
            ${col("Consumption", nn(t.energy_kwh), "kWh")}
            ${col("Efficiency", nn(t.consumption_kwh_100km), "kWh/100km")}
            ${col("Cost", fmtNum(t.cost), sym || DASH)}
            ${col("Score", score, "", { big: true, color: _scoreColor(t.score) })}
          </div>
          ${isOpen ? detailHtml(t) : ""}
        </div>`;
    };
    const chargeRowHtml = (c) => {
      const sym = cur[c.currency] || c.currency || "€";
      let durMin = null;
      if (c.started_at && c.ended_at) { const d = (new Date(c.ended_at) - new Date(c.started_at)) / 60000; if (!isNaN(d) && d >= 0) durMin = d; }
      const durStr = durMin == null ? null : durMin >= 60 ? `${Math.floor(durMin / 60)}h ${Math.round(durMin % 60)}m` : `${Math.round(durMin)} min`;
      const avgKw = c.kwh != null && durMin && durMin > 0 ? Number(c.kwh) / (durMin / 60) : null;
      const type = c.is_dcfc ? "DC" : "AC";
      const parts = [
        `<b>${fmtNum(c.kwh, 2)}</b> kWh`,
        `<b>${fmtNum(c.price_per_kwh, 3)}</b> ${_esc(sym)}/kWh`,
        c.total_cost != null ? `<b>${fmtNum(c.total_cost, 2)}</b> ${_esc(sym)}` : null,
        avgKw != null ? `${avgKw.toFixed(1)} kW` : null,
        durStr,
      ].filter(Boolean).join(" · ");
      return `
        <div class="charge-row">
          <div class="cr-badge"><ha-icon icon="mdi:ev-station"></ha-icon></div>
          <div class="cr-body">
            <div class="cr-head">Charged${c.location ? ` · ${_esc(c.location)}` : ""}<span class="cr-time">${_fmtDate(c.ended_at, true)}</span></div>
            <div class="cr-metrics">${parts}</div>
          </div>
          <span class="cr-type cr-type--${type === "DC" ? "dc" : "ac"}">${type}</span>
        </div>`;
    };

    // For date sorts, weave charges into the trip timeline so each charge shows
    // once, between the trips around it (not attributed to every later trip).
    let items;
    const tsTrip = (t) => new Date(t.ended_at || t.started_at).getTime();
    const tsChg = (c) => new Date(c.ended_at || c.started_at).getTime();
    if ((sort === "Newest" || sort === "Oldest") && charges.length && rows.length) {
      const dir = sort === "Oldest" ? 1 : -1;
      const tripTimes = rows.map(tsTrip).filter((x) => !isNaN(x));
      const minT = Math.min(...tripTimes);
      const merged = rows
        .map((t) => ({ ts: tsTrip(t), html: tripRowHtml(t) }))
        .concat(
          charges
            .filter((c) => { const ct = tsChg(c); return !isNaN(ct) && ct >= minT; })
            .map((c) => ({ ts: tsChg(c), html: chargeRowHtml(c) }))
        )
        .sort((a, b) => (a.ts - b.ts) * dir);
      items = merged.map((x) => x.html);
    } else {
      items = rows.map(tripRowHtml);
    }
    // Live charge row at the very top while the cable is connected:
    // "Charging" (drawing power) or "Paused" (plugged, not charging).
    let liveRow = "";
    const cs = evChargeState(this._hass, D2, this._config.plugEntity, this._config.chargingEntity, this._config.powerEntity);
    if (cs.state === "charging" || cs.state === "paused") {
      const charging = cs.state === "charging";
      const soc = cs.soc != null ? `${cs.soc.toFixed(0)}%` : "";
      const dm = cs.durationMin != null ? cs.durationMin : cs.lastDurMin;
      const durStr = dm == null ? "" : dm >= 60 ? `${Math.floor(dm / 60)}h ${Math.round(dm % 60)}m` : `${Math.round(dm)} min`;
      const energy = cs.energy != null ? cs.energy : cs.lastEnergy;
      const metrics = charging
        ? `<b>${(energy || 0).toFixed(2)}</b> kWh · <b>${(cs.power || 0).toFixed(1)}</b> kW${durStr ? ` · ${durStr}` : ""}`
        : `Cable connected · not charging${energy != null ? ` · <b>${energy.toFixed(2)}</b> kWh` : ""}${durStr ? ` · ${durStr}` : ""}`;
      liveRow = `
        <div class="charge-row charge-live ${charging ? "cl-charging" : "cl-paused"}">
          <div class="cr-badge"><ha-icon icon="${charging ? "mdi:ev-station" : "mdi:pause-circle-outline"}"></ha-icon></div>
          <div class="cr-body">
            <div class="cr-head">${charging ? "Charging" : "Paused"}<span class="cr-time">${soc}</span></div>
            <div class="cr-metrics">${metrics}</div>
          </div>
          <span class="cr-type ${charging ? "cr-type--ac" : "cr-type--dc"}">${charging ? "⚡" : "⏸"}</span>
        </div>`;
    }
    const rowsHtml = (liveRow + (items.length ? items.join("") : "")) || `<div class="empty">No trips match the current filters.</div>`;

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
          /* ---- charge row woven between trips ---- */
          .charge-row{display:flex;align-items:center;gap:12px;
                      background:linear-gradient(90deg, rgba(3,155,229,.10), transparent);
                      border:1px dashed var(--info-color, #039be5);border-radius:14px;
                      padding:10px 12px;}
          .charge-live{border-style:solid;}
          .cl-charging{border-color:var(--success-color,#43a047);
                       background:linear-gradient(90deg, rgba(67,160,71,.16), transparent);}
          .cl-charging .cr-badge{background:rgba(67,160,71,.18);}
          .cl-charging .cr-badge ha-icon,.cl-charging .cr-head{color:var(--success-color,#43a047);}
          .cl-paused{border-color:var(--warning-color,#fb8c00);
                     background:linear-gradient(90deg, rgba(245,158,11,.16), transparent);}
          .cl-paused .cr-badge{background:rgba(245,158,11,.18);}
          .cl-paused .cr-badge ha-icon,.cl-paused .cr-head{color:var(--warning-color,#fb8c00);}
          .cr-badge{flex:0 0 auto;width:34px;height:34px;border-radius:50%;
                    background:rgba(3,155,229,.16);display:flex;align-items:center;justify-content:center;}
          .cr-badge ha-icon{--mdc-icon-size:19px;color:var(--info-color, #039be5);}
          .cr-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}
          .cr-head{font-size:.78em;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
                   color:var(--info-color, #039be5);display:flex;gap:8px;align-items:baseline;}
          .cr-time{margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;
                   color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .cr-metrics{font-size:.88em;color:var(--primary-text-color);
                      font-variant-numeric:tabular-nums;}
          .cr-type{flex:0 0 auto;font-size:.7em;font-weight:800;border-radius:6px;padding:2px 7px;}
          .cr-type--ac{background:rgba(67,160,71,.16);color:var(--success-color,#43a047);}
          .cr-type--dc{background:rgba(245,158,11,.18);color:var(--warning-color,#fb8c00);}
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
          .d-charge-head{display:flex;align-items:center;gap:6px;font-size:.78em;
                         font-weight:700;text-transform:uppercase;letter-spacing:.04em;
                         color:var(--info-color,#039be5);margin-top:4px;}
          .d-charge-head ha-icon{--mdc-icon-size:16px;}
          .d-charge-loc{margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;
                        color:var(--secondary-text-color);}
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
// Compact power-vs-time SVG for a single charge (used in the charge history).
const _miniPowerSvg = (pts) => {
  const VB_W = 300, VB_H = 92, PL = 22, PR = 6, PT = 6, PB = 14;
  const x0 = PL, x1 = VB_W - PR, y0 = PT, y1 = VB_H - PB;
  const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t));
  const maxKw = Math.max(...pts.map((p) => p.v)) * 1.12 || 1;
  const sx = (t) => x0 + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * (x1 - x0);
  const sy = (v) => y1 - (v / maxKw) * (y1 - y0);
  const ft = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
  const area = `M${sx(pts[0].t).toFixed(1)},${y1} ` + pts.map((p) => `L${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ") + ` L${sx(pts[pts.length - 1].t).toFixed(1)},${y1} Z`;
  const peak = Math.max(...pts.map((p) => p.v));
  return `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="cv-svg" preserveAspectRatio="none">
    <line x1="${x0}" y1="${sy(0).toFixed(1)}" x2="${x1}" y2="${sy(0).toFixed(1)}" class="cv-axis"/>
    <text x="${x0 - 3}" y="${(sy(maxKw) + 4).toFixed(1)}" text-anchor="end" class="cv-lbl">${peak.toFixed(0)}</text>
    <path d="${area}" class="cv-area"/><path d="${line}" class="cv-line"/>
    <text x="${x0}" y="${VB_H - 3}" class="cv-lbl">${ft(t0)}</text>
    <text x="${x1}" y="${VB_H - 3}" text-anchor="end" class="cv-lbl">${ft(t1)}</text>
  </svg>`;
};
class EvTripHistoryCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
    this._kind = this._config.kind === "charges" ? "charges" : "journeys";
    this._curves = this._curves || {}; // charge_id -> points | 'loading'
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
    const raw = (st && st.attributes && Array.isArray(st.attributes[kind]) && st.attributes[kind]) || [];
    // Always show newest first regardless of the underlying attribute order.
    // Journeys sort by ended_at desc when available, fallback to started_at;
    // charges sort by ended_at desc.
    const sortKey = kind === "journeys" ? "ended_at" : "ended_at";
    const fallback = kind === "journeys" ? "started_at" : "ended_at";
    const rows = raw.slice().sort((a, b) => {
      const ax = a[sortKey] || a[fallback] || "";
      const bx = b[sortKey] || b[fallback] || "";
      return bx.localeCompare(ax);
    });
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const sym = (c) => cur[c] || c || "€";
    const DASH = "—";
    const fmtNum = (v, dp) => (v == null || isNaN(v) ? DASH : dp == null ? String(v) : Number(v).toFixed(dp));

    const inner = kind === "journeys" ? this._journeysHtml(rows, D, sym, DASH, fmtNum) : this._chargesHtml(rows, sym, DASH, fmtNum);
    if (kind === "charges") this._fetchOpenDayCurves(rows);

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
          .csession + .csession{border-top:1px dashed var(--divider-color);}
          .session{display:flex;align-items:center;gap:10px;padding:8px 4px;}
          /* ---- per-charge power curve ---- */
          .s-curve{padding:2px 4px 8px;}
          .cv-svg{display:block;width:100%;height:92px;}
          .cv-axis{stroke:var(--divider-color);stroke-width:1;}
          .cv-area{fill:var(--info-color,#039be5);opacity:.13;}
          .cv-line{fill:none;stroke:var(--info-color,#039be5);stroke-width:2.5;
                   stroke-linejoin:round;stroke-linecap:round;}
          .cv-lbl{fill:var(--secondary-text-color);font-size:8px;}
          .cv-msg{font-size:.78em;color:var(--secondary-text-color);padding:6px 2px;text-align:center;}
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
          // Prefer the reverse-geocoded street address over the home/not_home label.
          const origin = `<span class="chip">${_endpoint(t.start_address, t.origin)}</span>`;
          const dest = `<span class="chip">${_endpoint(t.end_address, t.destination)}</span>`;
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
        const type = c.type ? String(c.type).toUpperCase() : (c.is_dcfc ? "DC" : null);
        const typeChip = type ? `<span class="chip chip--${type === "DC" ? "dc" : "ac"}">${_esc(type)}</span>` : "";
        const total = c.total_cost != null ? `${fmtNum(c.total_cost, 2)} ${_esc(sym(c.currency))}` : DASH;
        // Duration (time the charge took) + average power, derived from the
        // timestamps + kWh (no per-sample curve is stored for past charges).
        let durMin = null;
        if (c.started_at && c.ended_at) {
          const d = (new Date(c.ended_at) - new Date(c.started_at)) / 60000;
          if (!isNaN(d) && d >= 0) durMin = d;
        }
        const durStr =
          durMin == null ? null : durMin >= 60 ? `${Math.floor(durMin / 60)}h ${Math.round(durMin % 60)}m` : `${Math.round(durMin)} min`;
        const avgKw = c.kwh != null && durMin && durMin > 0 ? Number(c.kwh) / (durMin / 60) : null;
        const extra =
          (durStr ? ` · <ha-icon class="s-mini" icon="mdi:timer-outline"></ha-icon>${durStr}` : "") +
          (avgKw != null ? ` · <b>${avgKw.toFixed(1)}</b> kW avg` : "");
        // Per-charge power-vs-time curve (recorder history, fetched lazily).
        const id = c.charge_id != null ? c.charge_id : c.id;
        const cv = id != null ? this._curves[id] : undefined;
        let curve;
        if (cv == null || cv === "loading") curve = `<div class="cv-msg">Loading power curve…</div>`;
        else if (!Array.isArray(cv) || cv.length < 2) curve = `<div class="cv-msg">No power history for this charge.</div>`;
        else curve = _miniPowerSvg(cv);
        return `
          <div class="csession">
            <div class="session">
              <div class="sbody">
                <div class="sroute">
                  <span class="stime">${timeOf(c.ended_at)}</span>
                  <span class="chip">${_esc(c.location || DASH)}</span>
                  ${typeChip}
                </div>
                <div class="smetrics"><b>${fmtNum(c.kwh)}</b> kWh · <b>${fmtNum(c.price_per_kwh)}</b> ${_esc(sym(c.currency))}/kWh${extra}</div>
              </div>
              <div class="score-pill" style="background:var(--info-color, #039be5)">${total}</div>
            </div>
            <div class="s-curve">${curve}</div>
          </div>`;
      })
      .join("");
    return `
      <div class="detail">
        <div class="stages">${items}</div>
      </div>`;
  }

  // Lazily fetch the recorder power-curve for each charge of the open day.
  _fetchOpenDayCurves(rows) {
    if (this._openId == null || !this._hass) return;
    const D = this._device;
    const p = (n) => String(n).padStart(2, "0");
    const dayKey = (iso) => { const d = new Date(iso); return isNaN(d) ? "unknown" : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    const sessions = rows.filter((c) => dayKey(c.ended_at) === this._openId);
    for (const c of sessions) {
      const id = c.charge_id != null ? c.charge_id : c.id;
      if (id == null || this._curves[id] !== undefined) continue;
      this._curves[id] = "loading";
      this._fetchCurve(D, c, id);
    }
  }
  _fetchCurve(D, c, id) {
    let start, end;
    try {
      start = new Date(new Date(c.started_at).getTime() - 30000).toISOString();
      end = new Date(new Date(c.ended_at || Date.now()).getTime() + 30000).toISOString();
    } catch (_e) { this._curves[id] = []; this._render(); return; }
    const ent = `sensor.${D}_current_charge_power`;
    const path = `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&minimal_response&no_attributes`;
    Promise.resolve(this._hass.callApi("GET", path))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        this._curves[id] = ser
          .map((x) => ({ t: new Date(x.last_changed || x.lu || x.lc).getTime(), v: parseFloat(x.state) }))
          .filter((x) => !isNaN(x.t) && !isNaN(x.v));
        this._render();
      })
      .catch(() => { this._curves[id] = []; this._render(); });
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
      statusSub = "Left " + (at.started_at ? _fmtDate(at.started_at) : DASH) + " · en route";
      a = at;
      stagesNum = curStages;
    } else if (hasLast) {
      const at = last.attributes || {};
      dotColor = "var(--info-color, #039be5)";
      badgeBg = "rgba(3,155,229,.16)";
      icon = "mdi:flag-checkered";
      statusLabel = "✅ Finished";
      statusSub =
        "Left " + (at.started_at ? _fmtDate(at.started_at) : DASH) +
        " · Arrived " + (at.ended_at ? _fmtDate(at.ended_at) : DASH);
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

    // Charge indicator (heuristic until the logger links charges to journeys):
    // a charge that ended at/after this journey began counts as "charged".
    const cip = stOf(`sensor.${D}_charge_in_progress`);
    const lc = stOf(`sensor.${D}_last_charge_energy`);
    const charging = cip && String(cip.state).toLowerCase() === "charging";
    const lcEnd = lc && lc.attributes && lc.attributes.ended_at;
    const lcLoc = (lc && lc.attributes && lc.attributes.location) || "";
    const chargedThis = lcEnd && a.started_at && new Date(lcEnd) >= new Date(a.started_at);
    let chargeChip = "";
    if (charging) chargeChip = `<span class="jchip jchg"><ha-icon icon="mdi:ev-station"></ha-icon>Charging now</span>`;
    else if (chargedThis)
      chargeChip = `<span class="jchip jchg"><ha-icon icon="mdi:lightning-bolt"></ha-icon>Charged ${fmtNum(lc.state, 2)} kWh${lcLoc ? ` · ${_esc(lcLoc)}` : ""}</span>`;

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
          .jchip ha-icon{--mdc-icon-size:13px;}
          .jchg{background:rgba(3,155,229,.16);color:var(--info-color,#039be5);}
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
              ${chargeChip}
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
    // Logger exposes window_days (not sample_count); derive the trip total from
    // the weekday counts so the card fills whenever there is any data.
    const _sum = (o) => Object.values(o || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const total = _sum(byWd) || _sum(byHour);
    const winDays = Number(a.window_days) || 90;

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
        <div class="tp-head">Driving patterns <span class="tp-tot">${total} trips · ${winDays} d</span></div>
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
// Custom card: monthly activity calendar built from EXISTING data —
// sensor.<device>_recent_trips.trips + recent_charges.charges (grouped by the
// local date of started_at). Works today on logger v0.4.9 (no calendar entity
// needed). Per-day badges: car = trips (+km), lightning = charges. Tap a day
// to expand its trips/charges; ‹ › navigate months, • jumps to today.
// ==========================================================================
const _localDateKey = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const _timeOfDay = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
const _endpoint = (addr, fallback) => _esc(addr || fallback || "?");
// Draw a GPS route over REAL OpenStreetMap tiles (Web Mercator), auto-zoomed
// to fit the route. No API key. pts = [{lat,lon}] in order. If tiles fail to
// load (offline/blocked) the polyline still shows on the blank background.
const _routeSvg = (pts) => {
  if (!pts || pts.length < 2) return "";
  const VB_W = 320, VB_H = 180, PAD = 18;
  const lon2x = (lon) => (lon + 180) / 360;
  const lat2y = (lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const xs = pts.map((p) => lon2x(p.lon)), ys = pts.map((p) => lat2y(p.lat));
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  let z = 18;
  for (; z > 1; z--) {
    const sc = Math.pow(2, z) * 256;
    if ((xMax - xMin) * sc <= VB_W - 2 * PAD && (yMax - yMin) * sc <= VB_H - 2 * PAD) break;
  }
  const sc = Math.pow(2, z) * 256;
  const cx = ((xMin + xMax) / 2) * sc, cy = ((yMin + yMax) / 2) * sc; // route center, world px
  const left = cx - VB_W / 2, top = cy - VB_H / 2;
  const X = (lon) => lon2x(lon) * sc - left;
  const Y = (lat) => lat2y(lat) * sc - top;
  const nT = Math.pow(2, z);
  let tiles = "";
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + VB_W) / 256); tx++) {
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + VB_H) / 256); ty++) {
      if (ty < 0 || ty >= nT) continue;
      const xt = ((tx % nT) + nT) % nT;
      tiles += `<image href="https://tile.openstreetmap.org/${z}/${xt}/${ty}.png" x="${(tx * 256 - left).toFixed(1)}" y="${(ty * 256 - top).toFixed(1)}" width="256" height="256"/>`;
    }
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}`).join(" ");
  const a = pts[0], b = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="cal-rt-svg" preserveAspectRatio="xMidYMid slice">
    ${tiles}
    <path d="${d}" class="cal-rt-halo"/>
    <path d="${d}" class="cal-rt-line"/>
    <circle cx="${X(a.lon).toFixed(1)}" cy="${Y(a.lat).toFixed(1)}" r="4" class="cal-rt-start"/>
    <circle cx="${X(b.lon).toFixed(1)}" cy="${Y(b.lat).toFixed(1)}" r="4.5" class="cal-rt-end"/>
    <text x="${VB_W - 2}" y="${VB_H - 3}" class="cal-rt-attr">© OpenStreetMap</text>
  </svg>`;
};
class EvTripCalendarCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
    this._offset = 0; // months relative to current
    this._openDate = null;
    this._routes = this._routes || {}; // window key -> [{lat,lon}] | 'loading'
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  getCardSize() {
    return 5;
  }
  // Group a day's trips into journeys (home→home) by journey_id; ungrouped
  // trips become 1-stage standalone entries. Each group gets a summary.
  _groupByJourney(trips) {
    const sorted = trips.slice().sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    const groups = [], byId = new Map(), standalone = [];
    for (const t of sorted) {
      if (t.journey_id == null) { standalone.push(t); continue; }
      const key = String(t.journey_id);
      let g = byId.get(key);
      if (!g) { g = { journey_id: t.journey_id, stages: [] }; byId.set(key, g); groups.push(g); }
      g.stages.push(t);
    }
    for (const g of groups) {
      const s = g.stages;
      g.started_at = s[0].started_at;
      g.ended_at = s[s.length - 1].ended_at;
      g.origin = s[0].start_address || s[0].origin || "?";
      g.destination = s[s.length - 1].end_address || s[s.length - 1].destination || "?";
      g.km = s.reduce((a, t) => a + (Number(t.distance_km) || 0), 0);
      g.kwh = s.reduce((a, t) => a + (Number(t.energy_kwh) || 0), 0);
      g.cost = s.reduce((a, t) => a + (Number(t.cost) || 0), 0);
      g.currency = (s.find((t) => t.currency) || {}).currency || null;
      g.cons = g.km > 0 ? (g.kwh / g.km) * 100 : null;
      g.roundTrip = g.origin && g.destination && g.origin.trim().toLowerCase() === g.destination.trim().toLowerCase();
    }
    return { groups, standalone };
  }
  connectedCallback() {
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      const nav = t.closest(".cal-nav[data-dir]");
      if (nav && this.contains(nav)) {
        const dir = nav.getAttribute("data-dir");
        if (dir === "today") this._offset = 0;
        else this._offset += dir === "next" ? 1 : -1;
        this._openDate = null;
        this._render();
        return;
      }
      const cell = t.closest(".cal-day[data-date]");
      if (cell && this.contains(cell)) {
        const date = cell.getAttribute("data-date");
        this._openDate = this._openDate === date ? null : date;
        this._render();
      }
    });
  }
  _index() {
    const D = this._device;
    const trips = (this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes;
    const charges = (this._hass.states[`sensor.${D}_recent_charges`] || {}).attributes;
    const tArr = (trips && Array.isArray(trips.trips) && trips.trips) || [];
    const cArr = (charges && Array.isArray(charges.charges) && charges.charges) || [];
    const map = {};
    const ensure = (k) => (map[k] = map[k] || { trips: [], charges: [], km: 0, kwh: 0 });
    for (const tr of tArr) {
      const k = _localDateKey(tr.started_at || tr.ended_at);
      if (!k) continue;
      const e = ensure(k);
      e.trips.push(tr);
      e.km += Number(tr.distance_km) || 0;
    }
    for (const ch of cArr) {
      const k = _localDateKey(ch.started_at || ch.ended_at);
      if (!k) continue;
      const e = ensure(k);
      e.charges.push(ch);
      e.kwh += Number(ch.kwh) || 0;
    }
    return map;
  }
  _render() {
    if (!this._hass) return;
    if (!this._clickBound && typeof this.addEventListener === "function") this.connectedCallback();
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const map = this._index();

    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() + this._offset);
    const y = base.getFullYear();
    const m = base.getMonth();
    const monthName = `${_MONTHS_ABBR[m]} ${y}`;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Mon-first blanks
    const p = (n) => String(n).padStart(2, "0");
    const todayKey = _localDateKey(new Date().toISOString());

    const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      .map((d) => `<div class="cal-dow">${d}</div>`)
      .join("");

    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<div class="cal-day cal-blank"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${y}-${p(m + 1)}-${p(day)}`;
      const e = map[key];
      const isToday = key === todayKey ? " cal-today" : "";
      const isOpen = key === this._openDate ? " cal-open" : "";
      let badges = "";
      if (e && e.trips.length)
        badges += `<span class="cal-b cal-b-trip"><ha-icon icon="mdi:car"></ha-icon>${e.trips.length}</span>`;
      if (e && e.charges.length)
        badges += `<span class="cal-b cal-b-chg"><ha-icon icon="mdi:lightning-bolt"></ha-icon>${e.charges.length}</span>`;
      const km = e && e.km > 0 ? `<div class="cal-km">${e.km.toFixed(0)} km</div>` : "";
      const clickable = e ? "" : " cal-empty";
      cells += `<div class="cal-day${isToday}${isOpen}${clickable}" data-date="${key}"><div class="cal-num">${day}</div>${badges}${km}</div>`;
    }

    let detail = "";
    this._openGroups = [];
    if (this._openDate && map[this._openDate]) {
      const e = map[this._openDate];
      const sym = (c) => cur[c] || c || "€";
      const f0 = (v) => (Number(v) || 0).toFixed(0);
      const f1 = (v) => (Number(v) || 0).toFixed(1);
      const { groups, standalone } = this._groupByJourney(e.trips);
      // record windows so _fetchOpenDayRoutes can pull each journey's route
      this._openGroups = groups
        .map((g) => ({ key: `${g.started_at}|${g.ended_at}`, start: g.started_at, end: g.ended_at }))
        .concat(standalone.map((t) => ({ key: `${t.started_at}|${t.ended_at}`, start: t.started_at, end: t.ended_at })));

      const stage = (t) => `
        <div class="cal-stage">
          <span class="cal-stime">${_timeOfDay(t.started_at)}</span>
          <span class="cal-sroute">${_endpoint(t.start_address, t.origin)}<ha-icon class="cal-arr" icon="mdi:arrow-right"></ha-icon>${_endpoint(t.end_address, t.destination)}</span>
          <span class="cal-smeta">${f0(t.distance_km)} km · ${t.consumption_kwh_100km != null && Number(t.consumption_kwh_100km) >= 0 ? f1(t.consumption_kwh_100km) + " kWh/100" : "—"}</span>
          ${t.score != null ? `<span class="cal-pill" style="background:${_scoreColor(t.score)}">${f1(t.score)}</span>` : ""}
        </div>`;
      const mapSlot = (start, end) => {
        if (!this._config.locationEntity) return "";
        const r = this._routes[`${start}|${end}`];
        if (Array.isArray(r)) return `<div class="cal-map">${_routeSvg(r) || '<div class="cal-map-ph">No GPS for this trip</div>'}</div>`;
        return `<div class="cal-map"><div class="cal-map-ph"><ha-icon icon="mdi:map-marker-path"></ha-icon> Loading route…</div></div>`;
      };
      const jHtml = groups
        .map(
          (g) => `
        <div class="cal-journey">
          <div class="cal-jhead">
            <span class="cal-jicon"><ha-icon icon="${g.roundTrip ? "mdi:home-map-marker" : "mdi:map-marker-path"}"></ha-icon></span>
            <span class="cal-jtitle">${_endpoint(g.origin)} → ${_endpoint(g.destination)}</span>
            <span class="cal-jtime">${_timeOfDay(g.started_at)}–${_timeOfDay(g.ended_at)}</span>
          </div>
          <div class="cal-jsum"><b>${f0(g.km)}</b> km · <b>${f1(g.kwh)}</b> kWh${g.cons != null ? ` · <b>${f1(g.cons)}</b> kWh/100` : ""}${g.cost ? ` · <b>${g.cost.toFixed(2)} ${_esc(sym(g.currency))}</b>` : ""} · ${g.stages.length} ${g.stages.length === 1 ? "stage" : "stages"}</div>
          <div class="cal-stages">${g.stages.map(stage).join("")}</div>
          ${mapSlot(g.started_at, g.ended_at)}
        </div>`
        )
        .join("");
      const soloHtml = standalone
        .map((t) => `<div class="cal-journey cal-journey--solo"><div class="cal-stages">${stage(t)}</div>${mapSlot(t.started_at, t.ended_at)}</div>`)
        .join("");
      const chs = e.charges
        .slice()
        .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
        .map(
          (c) =>
            `<div class="cal-row"><span class="cal-ricon cal-b-chg"><ha-icon icon="mdi:lightning-bolt"></ha-icon></span>` +
            `<span class="cal-rtime">${_timeOfDay(c.started_at)}</span>` +
            `<span class="cal-rmain">${_esc(c.location || "charge")}${c.is_dcfc ? " · DC" : ""}</span>` +
            `<span class="cal-rval">${(Number(c.kwh) || 0).toFixed(1)} kWh${c.total_cost != null ? ` · ${(Number(c.total_cost) || 0).toFixed(2)} ${_esc(sym(c.currency))}` : ""}</span></div>`
        )
        .join("");
      const [yy, mm, dd] = this._openDate.split("-");
      const body = jHtml + soloHtml + chs || '<div class="cal-none">No activity.</div>';
      detail = `<div class="cal-detail"><div class="cal-dhead">${dd}/${mm}/${yy}</div>${body}</div>`;
    }

    this.innerHTML = `
      <ha-card>
        <div class="cal-top">
          <div class="cal-month">${monthName}</div>
          <div class="cal-navs">
            <span class="cal-nav" data-dir="prev"><ha-icon icon="mdi:chevron-left"></ha-icon></span>
            <span class="cal-nav cal-dot" data-dir="today"><ha-icon icon="mdi:circle-medium"></ha-icon></span>
            <span class="cal-nav" data-dir="next"><ha-icon icon="mdi:chevron-right"></ha-icon></span>
          </div>
        </div>
        <div class="cal-grid cal-dows">${dows}</div>
        <div class="cal-grid cal-cells">${cells}</div>
        ${detail}
        <style>
          .cal-top{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 8px;}
          .cal-month{font-weight:700;font-size:1.05em;}
          .cal-navs{display:flex;align-items:center;gap:2px;}
          .cal-nav{cursor:pointer;border-radius:8px;padding:2px;color:var(--secondary-text-color);
                   display:inline-flex;}
          .cal-nav:hover{background:var(--divider-color);color:var(--primary-text-color);}
          .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;padding:0 12px;}
          .cal-dows{padding-bottom:4px;}
          .cal-dow{text-align:center;font-size:.68em;font-weight:700;text-transform:uppercase;
                   letter-spacing:.03em;color:var(--secondary-text-color);}
          .cal-cells{padding-bottom:14px;}
          .cal-day{min-height:46px;border-radius:10px;border:1px solid var(--divider-color);
                   padding:3px 4px;display:flex;flex-direction:column;gap:2px;position:relative;
                   background:var(--secondary-background-color,var(--card-background-color));}
          .cal-blank{border:none;background:none;}
          .cal-empty{opacity:.5;}
          .cal-day[data-date]:not(.cal-empty){cursor:pointer;transition:border-color .12s;}
          .cal-day[data-date]:not(.cal-empty):hover{border-color:var(--primary-color);}
          .cal-today{border-color:var(--primary-color);box-shadow:inset 0 0 0 1px var(--primary-color);}
          .cal-open{border-color:var(--primary-color);background:var(--primary-color);}
          .cal-open .cal-num,.cal-open .cal-km{color:var(--text-primary-color,#fff);}
          .cal-num{font-size:.78em;font-weight:600;font-variant-numeric:tabular-nums;}
          .cal-b{display:inline-flex;align-items:center;gap:1px;font-size:.62em;font-weight:700;
                 border-radius:6px;padding:0 3px;line-height:1.4;}
          .cal-b ha-icon{--mdc-icon-size:11px;}
          .cal-b-trip{background:rgba(46,125,50,.18);color:var(--success-color,#43a047);}
          .cal-b-chg{background:rgba(3,155,229,.18);color:var(--info-color,#039be5);}
          .cal-km{font-size:.6em;color:var(--secondary-text-color);
                  font-variant-numeric:tabular-nums;margin-top:auto;}
          .cal-detail{margin:0 12px 14px;border:1px solid var(--primary-color);border-radius:12px;
                      padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
          .cal-dhead{font-weight:700;font-variant-numeric:tabular-nums;}
          .cal-row{display:flex;align-items:center;gap:8px;font-size:.85em;}
          .cal-ricon{flex:0 0 auto;width:24px;height:24px;border-radius:50%;
                     display:flex;align-items:center;justify-content:center;}
          .cal-ricon ha-icon{--mdc-icon-size:15px;}
          .cal-rtime{flex:0 0 auto;color:var(--secondary-text-color);
                     font-variant-numeric:tabular-nums;}
          .cal-rmain{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
          .cal-rval{flex:0 0 auto;font-weight:600;font-variant-numeric:tabular-nums;}
          .cal-none{color:var(--secondary-text-color);font-size:.85em;}
          /* ---- journey groups + route map ---- */
          .cal-journey{border:1px solid var(--divider-color);border-radius:12px;padding:10px;
                       display:flex;flex-direction:column;gap:8px;background:var(--card-background-color);}
          .cal-journey--solo{border-style:dashed;}
          .cal-jhead{display:flex;align-items:center;gap:8px;}
          .cal-jicon{flex:0 0 auto;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;
                     justify-content:center;background:rgba(3,155,229,.16);color:var(--info-color,#039be5);}
          .cal-jicon ha-icon{--mdc-icon-size:17px;}
          .cal-jtitle{flex:1 1 auto;min-width:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
          .cal-jtime{flex:0 0 auto;color:var(--secondary-text-color);font-size:.82em;font-variant-numeric:tabular-nums;}
          .cal-jsum{font-size:.82em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .cal-jsum b{color:var(--primary-text-color);font-weight:700;}
          .cal-stages{display:flex;flex-direction:column;gap:6px;border-left:2px solid var(--divider-color);
                      margin-left:13px;padding-left:12px;}
          .cal-stage{display:flex;align-items:center;gap:8px;font-size:.85em;flex-wrap:wrap;}
          .cal-stime{flex:0 0 auto;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .cal-sroute{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden;
                      text-overflow:ellipsis;white-space:nowrap;}
          .cal-arr{--mdc-icon-size:14px;color:var(--secondary-text-color);flex:0 0 auto;}
          .cal-smeta{flex:0 0 auto;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .cal-pill{flex:0 0 auto;min-width:30px;text-align:center;padding:2px 7px;border-radius:999px;
                    color:#fff;font-weight:800;font-size:.8em;font-variant-numeric:tabular-nums;}
          .cal-map{height:170px;border-radius:10px;overflow:hidden;border:1px solid var(--divider-color);
                   background:var(--secondary-background-color);}
          .cal-map-ph{height:100%;display:flex;align-items:center;justify-content:center;gap:6px;
                      color:var(--secondary-text-color);font-size:.85em;}
          .cal-rt-svg{display:block;width:100%;height:170px;}
          .cal-rt-svg image{image-rendering:auto;}
          .cal-rt-halo{fill:none;stroke:#fff;stroke-width:5;stroke-linejoin:round;stroke-linecap:round;opacity:.8;}
          .cal-rt-line{fill:none;stroke:#1565c0;stroke-width:3;stroke-linejoin:round;stroke-linecap:round;}
          .cal-rt-start{fill:var(--success-color,#43a047);stroke:#fff;stroke-width:1.5;}
          .cal-rt-end{fill:var(--error-color,#e53935);stroke:#fff;stroke-width:1.5;}
          .cal-rt-attr{fill:#000;opacity:.5;font-size:7px;text-anchor:end;paint-order:stroke;stroke:#fff;stroke-width:2;}
        </style>
      </ha-card>`;

    // After render, lazily fetch each open journey's GPS route from the
    // device_tracker recorder history and re-render the SVG into its slot.
    this._fetchOpenDayRoutes();
  }
  _fetchOpenDayRoutes() {
    const ent = this._config.locationEntity;
    if (!ent || !this._openGroups || !this._openGroups.length) return;
    for (const w of this._openGroups) {
      if (this._routes[w.key] !== undefined) continue; // cached/loading
      this._routes[w.key] = "loading";
      let start, end;
      try {
        start = new Date(new Date(w.start).getTime() - 60000).toISOString();
        end = new Date(new Date(w.end).getTime() + 60000).toISOString();
      } catch (_e) { this._routes[w.key] = []; continue; }
      // NOTE: need attributes (lat/lon) so do NOT use minimal_response/no_attributes.
      Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
        .then((res) => {
          const ser = Array.isArray(res) && res[0] ? res[0] : [];
          const pts = [];
          for (const x of ser) {
            const a = x.attributes || {};
            const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
            if (!isNaN(lat) && !isNaN(lon)) {
              const last = pts[pts.length - 1];
              if (!last || last.lat !== lat || last.lon !== lon) pts.push({ lat, lon });
            }
          }
          this._routes[w.key] = pts;
          this._render();
        })
        .catch(() => { this._routes[w.key] = []; this._render(); });
    }
  }
}
customElements.define("ev-trip-calendar-card", EvTripCalendarCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-calendar-card", name: "EV Trip — activity calendar", description: "Monthly trips/charges calendar from recent_trips + recent_charges." });

// ==========================================================================
// Custom card: efficiency-vs-distance SVG scatter from EXISTING data —
// sensor.<device>_recent_trips.trips (distance_km, consumption_kwh_100km,
// score). Points colored by score band; dashed line = mean consumption.
// Works today on logger v0.4.9. Robust vanilla-JS alternative to the apex
// scatter. An optional temperature-bucket bar shows when by_bucket has data.
// ==========================================================================
class EvTripEfficiencyCard extends HTMLElement {
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
    const st = this._hass.states[`sensor.${D}_recent_trips`];
    const trips = (st && st.attributes && Array.isArray(st.attributes.trips) && st.attributes.trips) || [];
    const pts = trips
      .map((t) => ({
        x: Number(t.distance_km),
        y: Number(t.consumption_kwh_100km),
        s: t.score == null ? null : Number(t.score),
      }))
      .filter((p) => !isNaN(p.x) && !isNaN(p.y) && p.x >= 0 && p.y >= 0);

    if (pts.length < 2) {
      this.innerHTML = `
        <ha-card>
          <div class="ef-head">Efficiency vs distance</div>
          <div class="ef-empty">Not enough trips with consumption data yet.</div>
          <style>
            .ef-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
            .ef-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);}
          </style>
        </ha-card>`;
      return;
    }

    // Plot geometry (viewBox units).
    const VB_W = 320, VB_H = 200, PL = 36, PR = 10, PT = 10, PB = 26;
    const x0 = PL, x1 = VB_W - PR, y0 = PT, y1 = VB_H - PB;
    const xMax = Math.max(...pts.map((p) => p.x)) * 1.08 || 1;
    const yVals = pts.map((p) => p.y);
    const yMin = Math.max(0, Math.min(...yVals) * 0.9);
    const yMax = Math.max(...yVals) * 1.08 || 1;
    const sx = (v) => x0 + (v / xMax) * (x1 - x0);
    const sy = (v) => y1 - ((v - yMin) / (yMax - yMin || 1)) * (y1 - y0);
    const fmt = (v) => (Math.round(v * 10) / 10).toString();

    const mean = yVals.reduce((a, b) => a + b, 0) / yVals.length;
    const meanY = sy(mean);

    // Gridlines + labels (3 on each axis).
    const yTicks = [yMin, (yMin + yMax) / 2, yMax];
    const xTicks = [0, xMax / 2, xMax];
    const grid =
      yTicks
        .map(
          (v) =>
            `<line x1="${x0}" y1="${sy(v).toFixed(1)}" x2="${x1}" y2="${sy(v).toFixed(1)}" class="ef-grid"/>` +
            `<text x="${x0 - 4}" y="${(sy(v) + 3).toFixed(1)}" class="ef-yl">${fmt(v)}</text>`
        )
        .join("") +
      xTicks
        .map(
          (v) =>
            `<text x="${sx(v).toFixed(1)}" y="${VB_H - 8}" class="ef-xl">${fmt(v)}</text>`
        )
        .join("");

    const dots = pts
      .map(
        (p) =>
          `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="${_scoreColor(p.s)}" fill-opacity="0.85" stroke="var(--card-background-color)" stroke-width="0.7"><title>${fmt(p.x)} km · ${fmt(p.y)} kWh/100${p.s != null ? ` · score ${p.s}` : ""}</title></circle>`
      )
      .join("");

    const best = Math.min(...yVals);
    const worst = Math.max(...yVals);

    this.innerHTML = `
      <ha-card>
        <div class="ef-head">Efficiency vs distance
          <span class="ef-sub">${pts.length} trips · lower is better</span>
        </div>
        <svg viewBox="0 0 ${VB_W} ${VB_H}" class="ef-svg" preserveAspectRatio="none">
          <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" class="ef-axis"/>
          <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" class="ef-axis"/>
          ${grid}
          <line x1="${x0}" y1="${meanY.toFixed(1)}" x2="${x1}" y2="${meanY.toFixed(1)}" class="ef-mean"/>
          <text x="${x1}" y="${(meanY - 3).toFixed(1)}" class="ef-meanl">avg ${fmt(mean)}</text>
          ${dots}
        </svg>
        <div class="ef-axislbls"><span>Distance (km) →</span><span>↑ kWh/100km</span></div>
        <div class="ef-foot">
          <div class="ef-stat"><div class="ef-sv" style="color:var(--success-color,#43a047)">${fmt(best)}</div><div class="ef-sl">best</div></div>
          <div class="ef-stat"><div class="ef-sv">${fmt(mean)}</div><div class="ef-sl">average</div></div>
          <div class="ef-stat"><div class="ef-sv" style="color:var(--error-color,#e53935)">${fmt(worst)}</div><div class="ef-sl">worst</div></div>
        </div>
        <style>
          .ef-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;
                   gap:4px;padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
          .ef-sub{color:var(--secondary-text-color);font-weight:400;font-size:.78em;}
          .ef-svg{display:block;width:100%;height:200px;padding:0 8px;box-sizing:border-box;}
          .ef-axis{stroke:var(--divider-color);stroke-width:1;}
          .ef-grid{stroke:var(--divider-color);stroke-width:.5;stroke-dasharray:3 3;opacity:.6;}
          .ef-mean{stroke:var(--primary-color);stroke-width:1;stroke-dasharray:5 3;opacity:.8;}
          .ef-meanl{fill:var(--primary-color);font-size:8px;text-anchor:end;}
          .ef-yl{fill:var(--secondary-text-color);font-size:8px;text-anchor:end;}
          .ef-xl{fill:var(--secondary-text-color);font-size:8px;text-anchor:middle;}
          .ef-axislbls{display:flex;justify-content:space-between;padding:0 18px 4px;
                       font-size:.66em;color:var(--secondary-text-color);}
          .ef-foot{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:6px 16px 16px;}
          .ef-stat{text-align:center;}
          .ef-sv{font-size:1.3em;font-weight:800;font-variant-numeric:tabular-nums;}
          .ef-sl{font-size:.66em;text-transform:uppercase;letter-spacing:.04em;
                 color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-efficiency-card", EvTripEfficiencyCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-efficiency-card", name: "EV Trip — efficiency scatter", description: "Efficiency-vs-distance SVG scatter from recent_trips (score-colored)." });

// ==========================================================================
// Custom card: all-time records board from sensor.<device>_tops. Each category
// (longest / longest drive / most efficient / fastest / cheapest) shows its
// leader with value + date + route; tap a row to expand its top-9 ranking.
// ==========================================================================
const _recDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
};
const _recDur = (min) => {
  const m = Math.round(Number(min) || 0);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
};
class EvTripRecordsCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
    this._openCat = null;
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  getCardSize() {
    return 5;
  }
  connectedCallback() {
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const r = ev.target && ev.target.closest && ev.target.closest(".rec-row[data-cat]");
      if (r && this.contains(r)) {
        const c = r.getAttribute("data-cat");
        this._openCat = this._openCat === c ? null : c;
        this._render();
      }
    });
  }
  _cats() {
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    return [
      { key: "longest", icon: "mdi:map-marker-distance", label: "Longest", color: "#3b82f6", val: (t) => `${(Number(t.distance_km) || 0).toFixed(0)} km` },
      { key: "longest_duration", icon: "mdi:timer-outline", label: "Longest drive", color: "#8b5cf6", val: (t) => _recDur(t.duration_min) },
      { key: "top_efficiency", icon: "mdi:leaf", label: "Most efficient", color: "#22c55e", val: (t) => `${(Number(t.consumption_kwh_100km) || 0).toFixed(1)} kWh/100` },
      { key: "top_speed", icon: "mdi:speedometer", label: "Fastest avg", color: "#f59e0b", val: (t) => `${(Number(t.avg_speed_kmh) || 0).toFixed(0)} km/h` },
      // Skip cost<=0 entries: a 0 here is a mis-costed trip (charge price was
      // stale at trip-close), not a genuinely free trip — surface the real
      // cheapest paid trip instead. (Logger should fix the root cost bug.)
      { key: "cheapest", icon: "mdi:cash-multiple", label: "Cheapest", color: "#10b981", filter: (t) => Number(t.cost) > 0, val: (t) => `${(Number(t.cost) || 0).toFixed(2)} ${cur[t.currency] || t.currency || "€"}` },
    ];
  }
  _render() {
    if (!this._hass) return;
    if (!this._clickBound && typeof this.addEventListener === "function") this.connectedCallback();
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = this._hass.states[`sensor.${D}_tops`];
    const a = (st && st.attributes) || {};
    const cats = this._cats()
      .map((c) => ({ ...c, list: c.filter ? (a[c.key] || []).filter(c.filter) : a[c.key] || [] }))
      .filter((c) => c.list.length);

    if (!cats.length) {
      this.innerHTML = `
        <ha-card>
          <div class="rec-head">Records</div>
          <div class="rec-empty">No records yet.<br><span>Provided by <code>sensor.${_esc(D)}_tops</code> (logger v0.5.0).</span></div>
          <style>
            .rec-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
            .rec-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);line-height:1.5;}
            .rec-empty span{font-size:.85em;opacity:.8;}
          </style>
        </ha-card>`;
      return;
    }

    const rows = cats
      .map((c) => {
        const top = c.list[0];
        const open = this._openCat === c.key;
        let sub = "";
        if (open) {
          sub =
            `<div class="rec-sub">` +
            c.list
              .map(
                (t, i) =>
                  `<div class="rec-li"><span class="rec-rank">${i + 1}</span>` +
                  `<span class="rec-lmain">${_esc(t.origin || "?")} → ${_esc(t.destination || "?")}</span>` +
                  `<span class="rec-ldate">${_recDate(t.started_at || t.ended_at)}</span>` +
                  `<span class="rec-lval">${c.val(t)}</span></div>`
              )
              .join("") +
            `</div>`;
        }
        return `
          <div class="rec-row${open ? " rec-open" : ""}" data-cat="${c.key}">
            <div class="rec-main">
              <span class="rec-badge" style="background:${c.color}22;color:${c.color}"><ha-icon icon="${c.icon}"></ha-icon></span>
              <span class="rec-body">
                <span class="rec-label">${c.label}</span>
                <span class="rec-meta">${_recDate(top.started_at || top.ended_at)} · ${_esc(top.origin || "?")} → ${_esc(top.destination || "?")}</span>
              </span>
              <span class="rec-val" style="color:${c.color}">${c.val(top)}</span>
              <ha-icon class="rec-caret" icon="mdi:chevron-down"></ha-icon>
            </div>
            ${sub}
          </div>`;
      })
      .join("");

    this.innerHTML = `
      <ha-card>
        <div class="rec-head">🏆 Records <span class="rec-tot">${st.state} trips all-time</span></div>
        <div class="rec-list">${rows}</div>
        <style>
          .rec-head{display:flex;justify-content:space-between;align-items:baseline;
                    padding:14px 16px 10px;font-weight:600;font-size:1.05em;}
          .rec-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;}
          .rec-list{display:flex;flex-direction:column;gap:8px;padding:0 12px 14px;}
          .rec-row{border:1px solid var(--divider-color);border-radius:14px;overflow:hidden;
                   cursor:pointer;transition:border-color .12s;
                   background:var(--secondary-background-color,var(--card-background-color));}
          .rec-row:hover{border-color:var(--primary-color);}
          .rec-open{border-color:var(--primary-color);}
          .rec-main{display:flex;align-items:center;gap:12px;padding:11px 12px;}
          .rec-badge{flex:0 0 auto;width:40px;height:40px;border-radius:50%;
                     display:flex;align-items:center;justify-content:center;}
          .rec-badge ha-icon{--mdc-icon-size:22px;}
          .rec-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}
          .rec-label{font-weight:700;}
          .rec-meta{font-size:.78em;color:var(--secondary-text-color);
                    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
                    font-variant-numeric:tabular-nums;}
          .rec-val{flex:0 0 auto;font-size:1.15em;font-weight:800;
                   font-variant-numeric:tabular-nums;}
          .rec-caret{flex:0 0 auto;--mdc-icon-size:20px;color:var(--secondary-text-color);
                     transition:transform .15s;}
          .rec-open .rec-caret{transform:rotate(180deg);}
          .rec-sub{display:flex;flex-direction:column;border-top:1px solid var(--divider-color);}
          .rec-li{display:flex;align-items:center;gap:10px;padding:7px 14px;font-size:.84em;
                  border-top:1px solid var(--divider-color);}
          .rec-li:first-child{border-top:none;}
          .rec-rank{flex:0 0 auto;width:20px;height:20px;border-radius:50%;font-size:.8em;
                    font-weight:700;display:flex;align-items:center;justify-content:center;
                    background:var(--divider-color);color:var(--secondary-text-color);}
          .rec-lmain{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
          .rec-ldate{flex:0 0 auto;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .rec-lval{flex:0 0 auto;font-weight:700;font-variant-numeric:tabular-nums;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-records-card", EvTripRecordsCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-records-card", name: "EV Trip — records board", description: "All-time record leaders with expandable top-9 (sensor.<device>_tops)." });

// ==========================================================================
// Custom card: the full charging-power curve (kW vs time) of the most recent
// charge. The logger doesn't store a per-charge power curve, so we fetch the
// recorder history of sensor.<device>_current_charge_power across the charge's
// [started_at, ended_at] window and draw it as an SVG line.
// ==========================================================================
class EvChargeGraphCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
  }
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._maybeFetch();
    else this._maybeFetch();
  }
  getCardSize() {
    return 4;
  }
  _lastCharge() {
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = this._hass.states[`sensor.${D}_recent_charges`];
    const arr = (st && st.attributes && Array.isArray(st.attributes.charges) && st.attributes.charges) || [];
    return arr[0] || null;
  }
  _maybeFetch() {
    const ch = this._lastCharge();
    const key = ch ? `${ch.started_at}|${ch.ended_at}` : null;
    if (!key) { this._render(); return; }
    if (key === this._key) { this._render(); return; }
    this._key = key;
    this._points = null; // loading
    this._charge = ch;
    this._render();
    const D = this._device;
    const ent = `sensor.${D}_current_charge_power`;
    let start, end;
    try {
      start = new Date(new Date(ch.started_at).getTime() - 30000).toISOString();
      end = new Date(new Date(ch.ended_at || Date.now()).getTime() + 30000).toISOString();
    } catch (_e) { this._points = []; this._render(); return; }
    const path = `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&minimal_response&no_attributes`;
    Promise.resolve(this._hass.callApi("GET", path))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        this._points = ser
          .map((p) => ({ t: new Date(p.last_changed || p.lu || p.lc).getTime(), v: parseFloat(p.state) }))
          .filter((p) => !isNaN(p.t) && !isNaN(p.v));
        this._render();
      })
      .catch(() => { this._points = []; this._render(); });
  }
  _render() {
    if (!this._hass) return;
    const ch = this._charge;
    const DASH = "—";
    const head = (body) => `
      <ha-card>
        <div class="cg-head">Charging process${ch && ch.location ? ` · ${_esc(ch.location)}` : ""}
          ${ch && ch.ended_at ? `<span class="cg-date">${_fmtDate(ch.ended_at, true)}</span>` : ""}</div>
        ${body}
        <style>
          .cg-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;
                   gap:4px;padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
          .cg-date{color:var(--secondary-text-color);font-weight:400;font-size:.78em;
                   font-variant-numeric:tabular-nums;}
          .cg-msg{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);}
          .cg-svg{display:block;width:100%;height:160px;padding:0 8px;box-sizing:border-box;}
          .cg-axis{stroke:var(--divider-color);stroke-width:1;}
          .cg-grid{stroke:var(--divider-color);stroke-width:.5;stroke-dasharray:3 3;opacity:.6;}
          .cg-line{fill:none;stroke:var(--info-color,#039be5);stroke-width:2.5;
                   stroke-linejoin:round;stroke-linecap:round;}
          .cg-area{fill:var(--info-color,#039be5);opacity:.12;}
          .cg-lbl{fill:var(--secondary-text-color);font-size:8px;}
          .cg-foot{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:6px 16px 16px;}
          .cg-stat{text-align:center;}
          .cg-sv{font-size:1.15em;font-weight:800;font-variant-numeric:tabular-nums;}
          .cg-sl{font-size:.62em;text-transform:uppercase;letter-spacing:.04em;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;

    if (!ch) { this.innerHTML = head(`<div class="cg-msg">No charges recorded yet.</div>`); return; }
    if (this._points == null) { this.innerHTML = head(`<div class="cg-msg">Loading charge curve…</div>`); return; }
    const pts = this._points;
    if (pts.length < 2) {
      this.innerHTML = head(`<div class="cg-msg">No power history recorded for this charge.</div>`);
      return;
    }

    const VB_W = 320, VB_H = 160, PL = 32, PR = 8, PT = 10, PB = 22;
    const x0 = PL, x1 = VB_W - PR, y0 = PT, y1 = VB_H - PB;
    const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t));
    const maxKw = Math.max(...pts.map((p) => p.v)) * 1.12 || 1;
    const sx = (t) => x0 + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * (x1 - x0);
    const sy = (v) => y1 - (v / maxKw) * (y1 - y0);
    const fmtT = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
    const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
    const area = `M${sx(pts[0].t).toFixed(1)},${y1} ` + pts.map((p) => `L${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ") + ` L${sx(pts[pts.length - 1].t).toFixed(1)},${y1} Z`;
    const peak = Math.max(...pts.map((p) => p.v));
    const durMin = (t1 - t0) / 60000;
    const durStr = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${Math.round(durMin % 60)}m` : `${Math.round(durMin)} min`;
    const avg = pts.reduce((a, p) => a + p.v, 0) / pts.length;
    const kwh = ch.kwh != null ? Number(ch.kwh).toFixed(2) : DASH;
    const yTicks = [0, maxKw / 2, maxKw];

    const body = `
      <svg viewBox="0 0 ${VB_W} ${VB_H}" class="cg-svg" preserveAspectRatio="none">
        ${yTicks.map((v) => `<line x1="${x0}" y1="${sy(v).toFixed(1)}" x2="${x1}" y2="${sy(v).toFixed(1)}" class="cg-grid"/><text x="${x0 - 3}" y="${(sy(v) + 3).toFixed(1)}" text-anchor="end" class="cg-lbl">${v.toFixed(0)}</text>`).join("")}
        <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" class="cg-axis"/>
        <path d="${area}" class="cg-area"/>
        <path d="${line}" class="cg-line"/>
        <text x="${x0}" y="${VB_H - 6}" text-anchor="start" class="cg-lbl">${fmtT(t0)}</text>
        <text x="${x1}" y="${VB_H - 6}" text-anchor="end" class="cg-lbl">${fmtT(t1)}</text>
      </svg>
      <div class="cg-foot">
        <div class="cg-stat"><div class="cg-sv">${kwh}</div><div class="cg-sl">kWh</div></div>
        <div class="cg-stat"><div class="cg-sv">${peak.toFixed(1)}</div><div class="cg-sl">peak kW</div></div>
        <div class="cg-stat"><div class="cg-sv">${avg.toFixed(1)}</div><div class="cg-sl">avg kW</div></div>
        <div class="cg-stat"><div class="cg-sv">${durStr}</div><div class="cg-sl">duration</div></div>
      </div>`;
    this.innerHTML = head(body);
  }
}
customElements.define("ev-charge-graph-card", EvChargeGraphCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-charge-graph-card", name: "EV Trip — charge power curve", description: "Power-vs-time curve of the last charge (from recorder history)." });

// ==========================================================================
// Custom card: live charge status for the first screen. Three states:
//   charging → live power curve + kWh/kW/time/SoC; paused (cable in, not
//   charging) → SoC + charged-so-far; idle (unplugged) → last-charge summary
//   (kWh / duration / avg kW). Reads logger current_charge_* + recent_charges
//   + the resolved plug/charging/power entities (config).
// ==========================================================================
class EvChargeStatusCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
  }
  set hass(hass) {
    this._hass = hass;
    this._tick();
  }
  getCardSize() { return 4; }
  _tick() {
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = evChargeState(this._hass, D, this._config.plugEntity, this._config.chargingEntity, this._config.powerEntity);
    this._st = st;
    const pe = this._config.powerEntity || `sensor.${D}_current_charge_power`;
    if ((st.charging || st.plugged) && has(this._hass, pe)) {
      const now = new Date().getTime();
      if (!this._lastFetch || this._fetchedState !== st.state || (st.charging && now - this._lastFetch > 45000)) {
        this._lastFetch = now;
        this._fetchedState = st.state;
        const start = new Date(now - 4 * 3600 * 1000).toISOString();
        const end = new Date(now + 60000).toISOString();
        Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${pe}&minimal_response&no_attributes`))
          .then((res) => {
            const ser = Array.isArray(res) && res[0] ? res[0] : [];
            this._pts = ser.map((p) => ({ t: new Date(p.last_changed || p.lu || p.lc).getTime(), v: parseFloat(p.state) })).filter((p) => !isNaN(p.t) && !isNaN(p.v));
            this._render();
          })
          .catch(() => { this._pts = []; this._render(); });
      }
    }
    this._render();
  }
  _lastCharge() {
    const st = this._hass.states[`sensor.${this._device}_recent_charges`];
    const arr = (st && st.attributes && Array.isArray(st.attributes.charges) && st.attributes.charges) || [];
    return arr[0] || null;
  }
  _render() {
    if (!this._hass) return;
    const D = this._device;
    const st = this._st || {};
    const DASH = "—";
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const tile = (icon, label, value, unit) =>
      `<div class="cs-t"><ha-icon class="cs-ti" icon="${icon}"></ha-icon><div class="cs-tl">${_esc(label)}</div>` +
      `<div class="cs-tv">${value}<span class="cs-tu">${unit ? " " + _esc(unit) : ""}</span></div></div>`;
    const styles = `
      <style>
        .cs-head{display:flex;align-items:center;gap:10px;padding:14px 16px 8px;}
        .cs-badge{flex:0 0 auto;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;}
        .cs-badge ha-icon{--mdc-icon-size:23px;}
        .cs-title{font-weight:700;}
        .cs-sub{color:var(--secondary-text-color);font-size:.82em;font-variant-numeric:tabular-nums;}
        .cs-svg{display:block;width:100%;height:120px;padding:0 10px;box-sizing:border-box;}
        .cs-axis{stroke:var(--divider-color);stroke-width:1;}
        .cs-area{fill:var(--info-color,#039be5);opacity:.13;}
        .cs-line{fill:none;stroke:var(--info-color,#039be5);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round;}
        .cs-lbl{fill:var(--secondary-text-color);font-size:8px;}
        .cs-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:6px 12px 14px;}
        .cs-t{background:var(--secondary-background-color,var(--card-background-color));border:1px solid var(--divider-color);
              border-radius:12px;padding:9px 6px;display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center;}
        .cs-ti{--mdc-icon-size:18px;color:var(--secondary-text-color);}
        .cs-tl{font-size:.6em;letter-spacing:.04em;text-transform:uppercase;color:var(--secondary-text-color);line-height:1.2;}
        .cs-tv{font-size:1.15em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1;}
        .cs-tu{font-size:.55em;font-weight:600;color:var(--secondary-text-color);}
      </style>`;
    const curveSvg = () => {
      const pts = (this._pts || []).filter((p) => p.v >= 0);
      if (pts.length < 2) return "";
      const VB_W = 320, VB_H = 120, PL = 28, PR = 8, PT = 8, PB = 16;
      const x0 = PL, x1 = VB_W - PR, y0 = PT, y1 = VB_H - PB;
      const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t));
      const maxKw = Math.max(...pts.map((p) => p.v)) * 1.12 || 1;
      const sx = (t) => x0 + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * (x1 - x0);
      const sy = (v) => y1 - (v / maxKw) * (y1 - y0);
      const ft = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
      const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
      const area = `M${sx(pts[0].t).toFixed(1)},${y1} ` + pts.map((p) => `L${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ") + ` L${sx(pts[pts.length - 1].t).toFixed(1)},${y1} Z`;
      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="cs-svg" preserveAspectRatio="none">
        <text x="${x0 - 3}" y="${(sy(maxKw) + 4).toFixed(1)}" text-anchor="end" class="cs-lbl">${maxKw.toFixed(0)}</text>
        <line x1="${x0}" y1="${sy(0).toFixed(1)}" x2="${x1}" y2="${sy(0).toFixed(1)}" class="cs-axis"/>
        <path d="${area}" class="cs-area"/><path d="${line}" class="cs-line"/>
        <text x="${x0}" y="${VB_H - 4}" class="cs-lbl">${ft(t0)}</text>
        <text x="${x1}" y="${VB_H - 4}" text-anchor="end" class="cs-lbl">${ft(t1)}</text>
      </svg>`;
    };
    const num = (v, dp) => (v == null || isNaN(v) ? DASH : Number(v).toFixed(dp == null ? 0 : dp));

    if (st.state === "charging" || st.state === "paused") {
      const charging = st.state === "charging";
      // Time: live duration while charging; the frozen charge time while paused.
      const durMin = st.durationMin != null ? st.durationMin : st.lastDurMin;
      const dur = durMin == null ? DASH : durMin >= 60 ? `${Math.floor(durMin / 60)}h ${Math.round(durMin % 60)}m` : `${Math.round(durMin)} min`;
      const energy = st.energy != null ? st.energy : st.lastEnergy;
      const sym = cur[st.type] || "€";
      this.innerHTML = `
        <ha-card>
          <div class="cs-head">
            <div class="cs-badge" style="background:${charging ? "rgba(67,160,71,.18)" : "rgba(245,158,11,.18)"}">
              <ha-icon icon="${charging ? "mdi:ev-station" : "mdi:pause-circle-outline"}" style="color:${charging ? "var(--success-color,#43a047)" : "var(--warning-color,#fb8c00)"}"></ha-icon>
            </div>
            <div>
              <div class="cs-title">${charging ? "⚡ Charging" : "🔌 Plugged in — paused"}</div>
              <div class="cs-sub">${charging ? "Cable connected · drawing power" : "Cable connected · not charging"}</div>
            </div>
          </div>
          ${curveSvg()}
          <div class="cs-tiles">
            ${tile("mdi:battery-charging-high", "SoC", num(st.soc, 0), "%")}
            ${tile("mdi:lightning-bolt", "Added", num(energy, 2), "kWh")}
            ${tile("mdi:flash", "Power", num(st.power, 1), "kW")}
            ${tile("mdi:timer-outline", "Time", dur, "")}
          </div>
        </ha-card>${styles}`;
      return;
    }

    // idle / unplugged → last-charge summary
    const c = this._lastCharge();
    if (!c) { this.innerHTML = ""; return; } // nothing to show
    const sym = cur[c.currency] || c.currency || "€";
    let durMin = null;
    if (c.started_at && c.ended_at) { const d = (new Date(c.ended_at) - new Date(c.started_at)) / 60000; if (!isNaN(d) && d >= 0) durMin = d; }
    const durStr = durMin == null ? DASH : durMin >= 60 ? `${Math.floor(durMin / 60)}h ${Math.round(durMin % 60)}m` : `${Math.round(durMin)}m`;
    const avgKw = c.kwh != null && durMin && durMin > 0 ? Number(c.kwh) / (durMin / 60) : null;
    this.innerHTML = `
      <ha-card>
        <div class="cs-head">
          <div class="cs-badge" style="background:rgba(3,155,229,.16)"><ha-icon icon="mdi:check-circle-outline" style="color:var(--info-color,#039be5)"></ha-icon></div>
          <div>
            <div class="cs-title">✅ Last charge</div>
            <div class="cs-sub">${_esc(c.location || "")}${c.ended_at ? ` · ${_fmtDate(c.ended_at, true)}` : ""}</div>
          </div>
        </div>
        <div class="cs-tiles">
          ${tile("mdi:lightning-bolt", "Charged", num(c.kwh, 2), "kWh")}
          ${tile("mdi:timer-outline", "Time", durStr, "")}
          ${tile("mdi:flash", "Avg", avgKw == null ? DASH : avgKw.toFixed(1), "kW")}
          ${tile("mdi:cash", "Cost", c.total_cost != null ? num(c.total_cost, 2) : DASH, sym)}
        </div>
      </ha-card>${styles}`;
  }
}
customElements.define("ev-charge-status-card", EvChargeStatusCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-charge-status-card", name: "EV Trip — charge status", description: "Live charging / paused / last-charge summary for the first screen." });

// ==========================================================================
// RESTORED from v1.5.0 (user favourites, pre-2.0): Driving + Trips views.
// Additive — the 9-view equivalents stay until these are validated.
// ==========================================================================
function drivingView(D, V, hass, cfg) {
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
      : pickVehicleEntity(hass, V, "range", cfg);
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

  // Battery: a mini-graph 24h curve (preferred — shows the trend), the
  // half-moon gauge when mini-graph-card isn't installed, and — when the
  // battery has no numeric value yet (e.g. the car is asleep/offline, so the
  // sensor is 'unknown') — a plain tile that shows "Unknown" instead of the
  // mini-graph's "NaN %" / the gauge's "non-numeric" error.
  if (!hasVal(hass, `sensor.${D}_battery_percent`)) {
    status.push({
      type: "tile",
      entity: `sensor.${D}_battery_percent`,
      name: "Battery",
      icon: "mdi:battery-off-outline",
    });
  } else if (hasCard("mini-graph-card")) {
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

  // Live charge status (charging / paused-while-plugged / last-charge summary).
  status.push({
    type: "custom:ev-charge-status-card",
    device: D,
    plugEntity: (cfg && cfg.plug_entity) || pickVehicleEntity(hass, V, "plug", cfg),
    chargingEntity: pickVehicleEntity(hass, V, "charging", cfg),
    powerEntity: resolveChargePower(hass, D, cfg),
  });

  // Battery / range / odometer. Logger gives a real-world range estimate;
  // the car integration (optional) gives its own range + odometer.
  const kpis = [
    { entity: `sensor.${D}_battery_energy`, name: "In battery", icon: "mdi:battery-charging", color: "green" },
    { entity: `sensor.${D}_energy_to_full_charge`, name: "To 100%", icon: "mdi:battery-plus", color: "blue" },
  ];
  if (has(hass, `sensor.${D}_range_at_recent_efficiency`))
    kpis.push({ entity: `sensor.${D}_range_at_recent_efficiency`, name: "Real range", icon: "mdi:map-marker-distance", color: "teal" });
  const vRange = pickVehicleEntity(hass, V, "range", cfg);
  if (vRange) kpis.push({ entity: vRange, name: "Range", icon: "mdi:map-marker-radius", color: "teal" });
  const vOdo = pickVehicleEntity(hass, V, "odometer", cfg);
  if (hasVal(hass, vOdo)) kpis.push({ entity: vOdo, name: "Odometer", icon: "mdi:counter", color: "grey" });
  // Mushroom template tiles (one per KPI) when available, else native tiles.
  for (const k of kpis) status.push(kpiTile(k.entity, k.name, k.icon, k.color));

  const vOut = pickVehicleEntity(hass, V, "outside_temp", cfg);
  if (vOut) status.push(kpiTile(vOut, "Outside", "mdi:thermometer", "orange"));
  const vCab = pickVehicleEntity(hass, V, "cabin_temp", cfg);
  if (vCab) status.push(kpiTile(vCab, "Cabin", "mdi:car-seat", "orange"));

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
            `{%- endif %}\n` +
            // Percentile vs the recent window (relocated here from the deleted Detail view).
            `{%- set trip = states('sensor.${D}_last_trip_consumption') | float(0) %}\n` +
            `{%- set trips = state_attr('sensor.${D}_recent_trips', 'trips') or [] %}\n` +
            `{%- set valid = trips | selectattr('consumption_kwh_100km','defined') | rejectattr('consumption_kwh_100km','none') | list %}\n` +
            `{%- set total = valid | count %}\n` +
            `{%- if total > 0 and trip > 0 %}{%- set worse = valid | selectattr('consumption_kwh_100km','>',trip) | list | count %}\n` +
            `\n**Percentile:** Top {{ ((worse/total)*100)|round(0) }}% — better than {{ worse }} of {{ total }} recent trips{%- endif %}`
          ),
          { type: "glance", columns: 3, entities: lastEnts },
        ],
      },
    },
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

  // Today's journey — full width across both columns (replaces the map).
  sections.push({
    type: "grid",
    column_span: 2,
    cards: [
      heading("Today's journey", "mdi:map-marker-path"),
      { type: "custom:ev-trip-journey-card", device: D },
    ],
  });

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

function tripsView(D, hass, V, cfg) {
  // Resolve the plug/charging/power entities once so the trip list can show a
  // live "Charging"/"Paused" row at the top while the cable is connected.
  const plugEntity = (cfg && cfg.plug_entity) || (hass ? pickVehicleEntity(hass, V, "plug", cfg) : null);
  const chargingEntity = hass ? pickVehicleEntity(hass, V, "charging", cfg) : null;
  const powerEntity = hass ? resolveChargePower(hass, D, cfg) : `sensor.${D}_current_charge_power`;
  // Right column: records, plus the helper-backed Search & filter card ONLY
  // when the input helpers exist (input_text.<D>_trip_search is the canary).
  // Without them the ev-trip-list-card still shows all trips, newest-first —
  // so on a clean install we just omit the (otherwise broken) filter card.
  const rightCards = [heading("Records", "mdi:trophy-variant"), recordsCard(D)];
  if (hass && has(hass, `input_text.${D}_trip_search`)) {
    rightCards.push(heading("Search & filter", "mdi:filter-variant"), {
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
    });
  }
  return {
    title: "Trips",
    path: "trips",
    icon: "mdi:map-search",
    type: "sections",
    max_columns: 2,
    sections: [
      { type: "grid", column_span: 2, cards: [heading("Last 30 days", "mdi:calendar-range"), trips30dKpis(D)] },
      grid([heading("Trips", "mdi:map-marker-path"), { type: "custom:ev-trip-list-card", device: D, title: "Trips", plugEntity, chargingEntity, powerEntity }]),
      grid(rightCards),
    ],
  };
}


// ---- strategy ------------------------------------------------------------
// HACS deps are required — no per-card fallback. If a dep is missing the
// user will see one broken card, not a degraded dashboard.
class EvTripDashboardStrategy {
  static async generate(config, hass) {
    // Fancy HACS cards register asynchronously, often AFTER generate() first
    // runs — without this wait hasCard() sees them as missing and the Driving
    // view falls back to the native gauge/tiles instead of mini-graph/mushroom.
    await awaitFancyCards();
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
    const views = [
      // Restored pre-2.0 favourites first (Driving + Trips with records/search).
      drivingView(D, V, hass, config),
      tripsView(D, hass, V, config),
      calendarioView(D, hass, V, config),
      tendenciasView(D, hass),
      patternsView(D, hass),
      eficienciaView(D, hass),
      topsView(D, hass),
      cargasView(D, hass),
    ];
    // Swap any uninstalled HACS custom card (button-card/mushroom/apex/mini-graph)
    // for a native fallback so the dashboard never shows "Configuration error".
    return { title: "EV Trips", views: views.map(degradeCard) };
  }
}

customElements.define("ll-strategy-dashboard-ev-trip", EvTripDashboardStrategy);

console.info(
  "%c EV-TRIP-DASHBOARD %c strategy loaded ",
  "background:#0a8;color:#fff;border-radius:3px 0 0 3px",
  "background:#333;color:#fff;border-radius:0 3px 3px 0"
);
