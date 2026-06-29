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
    speed: [`sensor.${V}_speed`, `sensor.${V}_vehicle_speed`],
  };
  for (const e of NAMES[concept] || []) if (hasVal(hass, e)) return e;
  // Match the vehicle slug even when the car integration PREFIXES it
  // (e.g. logger slug `sealion_7` but entities are `…byd_sealion_7_*`), so the
  // auto-detect works without the user setting `vehicle:` explicitly.
  const ids = Object.keys(hass.states).filter(
    (id) => id.includes(`.${V}_`) || id.endsWith(`.${V}`) || id.includes(`_${V}_`) || id.endsWith(`_${V}`)
  );
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
    case "speed": return find((id) => id.startsWith("sensor.") && (dc(id) === "speed" || /\b(km\/h|mph)\b/.test((hass.states[id].attributes || {}).unit_of_measurement || ""))) || null;
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
function kpiTile(entity, name, icon, color, decimals) {
  if (hasCard("mushroom-template-card")) {
    // Round the numeric state to `decimals` (default 1) so raw vehicle sensors
    // without suggested_display_precision (e.g. Tesla odometer 45732.1741…,
    // range 212.578…) don't show a long decimal tail. Non-numeric → shown raw.
    const dp = decimals == null ? 1 : decimals;
    const round = dp === 0 ? "(f | round(0) | int)" : `(f | round(${dp}))`;
    const secondary =
      `{% set v = states(entity) %}{% set f = v | float(none) %}` +
      `{{ ${round} if f is not none else v }}` +
      `{{ ' ' ~ state_attr(entity,'unit_of_measurement') if state_attr(entity,'unit_of_measurement') else '' }}`;
    return {
      type: "custom:mushroom-template-card",
      entity,
      primary: name,
      secondary,
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
function tendenciasView(D, hass, cfg) {
  cfg = cfg || {};
  const cards = [];

  cards.push(mushroomTitle("Trends", "Summary of the last 30/60 days", "mdi:chart-line"));

  // Savings vs petrol + cost per 100 km (computed in custom cards from data).
  cards.push({ type: "custom:ev-trip-savings-card", device: D, gas_l_per_100km: cfg.gas_l_per_100km, gas_price_per_l: cfg.gas_price_per_l });
  cards.push({ type: "custom:ev-trip-cost-card", device: D });

  // Distance by period — at-a-glance totals (today / week / month / year).
  const distStyles = {
    card: [{ padding: "10px" }, { "border-radius": "14px" }],
    name: [{ "font-size": "12px" }, { opacity: "0.75" }],
    state: [{ "font-size": "20px" }, { "font-weight": "bold" }],
    icon: [{ color: "var(--info-color)" }, { width: "22px" }],
  };
  const distTile = (suffix, name) => ({
    type: "custom:button-card",
    entity: `sensor.${D}_distance_${suffix}`,
    name,
    icon: "mdi:map-marker-distance",
    show_state: true, show_name: true, show_icon: true,
    styles: distStyles,
    state_display: "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(0)} km` ]]]",
  });
  cards.push({
    type: "grid",
    columns: 4,
    square: false,
    cards: [distTile("today", "Today"), distTile("this_week", "Week"), distTile("this_month", "Month"), distTile("this_year", "Year")],
  });
  // "Year" only counts since the logger started recording, not the real
  // calendar year — clarify with the first recorded trip date so 444 km
  // (= everything since install) doesn't read as a full-year figure.
  cards.push(
    md(
      `{%- set trips = state_attr('sensor.${D}_recent_trips', 'trips') or [] %}` +
      `{%- set firsts = trips | map(attribute='started_at') | reject('none') | list %}` +
      `{%- if firsts | length > 0 %}` +
      `{%- set first = firsts | min %}` +
      `_📅 Totals count from when the logger started — first trip {{ as_timestamp(first) | timestamp_custom('%d/%m/%Y') }}. The “Year” figure grows from there._` +
      `{%- endif %}`
    )
  );

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

  // ---- NEW (v0.5.43): per-driver stats card ----------------------------
  // Only rendered when the sensor exists (needs driver sensor wired in logger).
  if (has(hass, `sensor.${D}_driver_stats_30_days`)) {
    cards.push({ type: "custom:ev-driver-stats-card", device: D });
  }

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
function eficienciaView(D, hass, V, cfg) {
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

  // ---- Energy consumed (kWh) per day / month / year, with a period toggle --
  cards.push({ type: "custom:ev-trip-consumption-card", device: D });

  // ---- Real range now (range at recent efficiency + per-band estimate) ---
  cards.push({ type: "custom:ev-trip-range-card", device: D });

  // ---- NEW: robust efficiency-vs-distance scatter (works on existing data) --
  // Additive: above the apex scatter below; retire the apex once validated.
  cards.push({ type: "custom:ev-trip-efficiency-card", device: D });

  // ---- Monthly efficiency: per-month chips + this-vs-last delta ---------
  // Custom card (not a markdown blob): some HA markdown sanitisers strip the
  // inline <style> and leave its CSS visible as text, so this is rendered by a
  // real custom element where scoped styles are reliable.
  cards.push({ type: "custom:ev-trip-monthly-eff-card", device: D });

  // Apex "Efficiency vs Distance" scatter removed — superseded by
  // ev-trip-efficiency-card above (cleaner, rounded axis labels).

  // ---- Consumption by SPEED band (works on existing data) --------------
  // Always useful (highway vs city efficiency) and doesn't depend on a temp
  // sensor, unlike the temperature chart below which stays empty until the
  // logger records avg_temp_c per trip.
  cards.push({ type: "custom:ev-trip-speed-card", device: D });

  // ---- Battery health (degradation proxy: calibrated usable capacity) ---
  cards.push({
    type: "custom:ev-trip-battery-health-card",
    device: D,
    nominalKwh: cfg && cfg.battery_nominal_kwh,
  });

  // ---- Consumption by season (winter/spring/summer/autumn) --------------
  cards.push({ type: "custom:ev-trip-season-card", device: D });

  // ---- Consumption by time of day (morning/afternoon/evening/night) -----
  cards.push({ type: "custom:ev-trip-time-of-day-card", device: D });

  // ---- Consumption by temperature band (custom HTML bars) ---------------
  // Reliable bars cold→hot, current-temp band highlighted, in the active unit.
  // Self-shows an "awaiting data" state until trips record an outside temp
  // (logger v0.5.54 weather_entity).
  cards.push({
    type: "custom:ev-trip-temp-card",
    device: D,
    tempEntity: (cfg && cfg.outside_temp_entity) || (hass && V ? pickVehicleEntity(hass, V, "outside_temp", cfg) : null),
  });

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
    columns: 3,
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
          "_recent_trips'].attributes.trips) || [];\n  const vals = trips.map(t => parseFloat(t.energy_kwh)).filter(v => !isNaN(v));\n  if (!vals.length) return '— kWh';\n  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;\n  return `${avg.toFixed(1)} kWh`;\n]]]",
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
      {
        type: "custom:button-card",
        entity: `sensor.${D}_avg_trip_regen_30_days`,
        name: L("Avg regen", "Regen media"),
        icon: "mdi:battery-charging",
        show_state: true,
        show_name: true,
        show_icon: true,
        styles: kpiStyles,
        state_display:
          "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(2)} kWh` ]]]",
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
function cargasView(D, hass, V, cfg) {
  cfg = cfg || {};
  V = V || D;
  const cards = [];
  const analytics = []; // charger-vs-battery section → LEFT column when present

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

  // This-month totals (energy charged / spent / sessions) — complements the
  // 30-day averages below.
  cards.push(heading("This month", "mdi:calendar-month"));
  cards.push({
    type: "grid",
    columns: 3,
    square: false,
    cards: [
      {
        type: "custom:button-card",
        entity: `sensor.${D}_energy_charged_this_month`,
        name: "Charged",
        icon: "mdi:lightning-bolt",
        show_state: true, show_name: true, show_icon: true,
        styles: chKpiStyles("var(--info-color)"),
        state_display: "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(1)} kWh` ]]]",
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_spent_on_charging_this_month`,
        name: "Spent",
        icon: "mdi:cash-multiple",
        show_state: true, show_name: true, show_icon: true,
        styles: chKpiStyles("var(--warning-color)"),
        state_display: "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(2)} €` ]]]",
      },
      {
        type: "custom:button-card",
        entity: `sensor.${D}_charges_this_month`,
        name: "Sessions",
        icon: "mdi:counter",
        show_state: true, show_name: true, show_icon: true,
        styles: chKpiStyles("var(--success-color)"),
      },
    ],
  });

  cards.push(heading("Last 30 days", "mdi:chart-box-outline"));
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
      // AC→DC charging efficiency (30-day rolling median) — only once the EVSE
      // power sensor has produced data, so it never shows a bare "unknown".
      ...(hasVal(hass, `sensor.${D}_avg_charging_efficiency_30d`) ? [{
        type: "custom:button-card",
        entity: `sensor.${D}_avg_charging_efficiency_30d`,
        name: L("Avg efficiency", "Eficiencia media"),
        icon: "mdi:gauge",
        show_state: true, show_name: true, show_icon: true,
        styles: chKpiStyles("var(--accent-color)"),
        state_display: "[[[ const v = entity && entity.state; return (v==null||v==='unavailable'||v==='unknown') ? '—' : `${Number(v).toFixed(0)}%` ]]]",
      }] : []),
    ],
  });

  // ---- Charging insights (AC/DC split, prices, cheapest, avg session) --
  cards.push({ type: "custom:ev-trip-charge-insights-card", device: D });

  // ---- Reactive charges history (custom element from this plugin) ------
  // Groups sessions by calendar day with expandable detail panels. Each charge
  // detail has an inline €/kWh editor (sets that specific charge by charge_id)
  // and, for not_home charges, the geocoded street + a Google Maps link. This
  // replaces the old "fix last charge" helper+script editor entirely.
  const locationEntity = (cfg && cfg.location_entity) || (hass ? pickVehicleEntity(hass, V, "location", cfg) : null);
  cards.push({ type: "custom:ev-trip-history-card", device: D, kind: "charges", title: "Charge history", locationEntity, scrollRows: 5 });

  // ---- Charged vs driving summary (LEFT column) -------------------------
  // Icon tiles of REAL charged kWh (from recent_charges, so today's charges show)
  // vs driving kWh, per Today/Week/Month/Year. Uses the logger (the optional
  // byd_charge package meters read 0 because their wallbox source isn't flowing).
  if (has(hass, `sensor.${D}_recent_charges`)) {
    analytics.push({ type: "custom:ev-charge-summary-card", device: D });
  }

  // Two columns when the analytics package is present: LEFT = charger-vs-battery
  // analytics, RIGHT = the charge list (everything else). They stack on mobile.
  const sections = analytics.length ? [grid(analytics), grid(cards)] : [grid(cards)];
  return {
    title: "Charges",
    path: "charges",
    icon: "mdi:ev-station",
    type: "sections",
    max_columns: 2,
    sections,
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
// "HH:MM–HH:MM" time range for a trip/stage. When start and end fall on the
// same calendar day → just the two times; if it crosses midnight, the end gets
// a "+1d" marker so the range stays unambiguous. Empty if timestamps missing.
const _timeRange = (started, ended) => {
  if (!started || !ended) return "";
  const s = new Date(started), e = new Date(ended);
  if (isNaN(s) || isNaN(e)) return "";
  const p = (n) => String(n).padStart(2, "0");
  const hm = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate();
  return sameDay ? `${hm(s)}–${hm(e)}` : `${hm(s)}–${hm(e)} +1d`;
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
const _esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Cheap dirty-check: build a signature string from the last_updated+state of a
// set of entity ids. Cards use this in set hass to skip _render() when nothing
// they actually read has changed (HA fires set hass on EVERY state change in the
// house, not just the card's own entities).
const _sig = (hass, ids) => ids.map((id) => { const s = hass.states[id]; return s ? s.last_updated + ":" + s.state : "x"; }).join("|");
// Medal for the top 3 of a ranking, plain number after.
const _medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}`;
// Currency symbol for cards whose own data carries no per-row currency
// (e.g. monthly_history). Derive it from the per-row currency on recent
// charges/trips, falling back to €.
const _CUR_SYMBOLS = { EUR: "€", USD: "$", GBP: "£" };
const _deviceCurrency = (hass, D) => {
  const fromArr = (id, arrKey) => {
    const a = (hass.states[`sensor.${D}_${id}`] || {}).attributes;
    const arr = a && Array.isArray(a[arrKey]) && a[arrKey];
    const row = arr && arr.find((x) => x && x.currency);
    return row ? row.currency : null;
  };
  const code = fromArr("recent_charges", "charges") || fromArr("recent_trips", "trips");
  return _CUR_SYMBOLS[code] || code || "€";
};
// Reverse-geocode lat/lon → a short "street, town" label via OpenStreetMap
// Nominatim. Trips don't store coordinates, so callers fetch the position from
// the device_tracker recorder history first. Results are cached per ~11 m cell
// and requests are throttled to ~1/s to respect Nominatim's usage policy.
const _geoCache = {};
const _geoQueue = [];
let _geoBusy = false;
function _geoPump() {
  if (_geoBusy) return;
  const job = _geoQueue.shift();
  if (!job) return;
  _geoBusy = true;
  fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${job.lat}&lon=${job.lon}`, { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      let label = "";
      const a = j && j.address;
      if (a) {
        const road = a.road || a.pedestrian || a.footway || a.cycleway || a.path || a.neighbourhood;
        const place = a.city || a.town || a.village || a.municipality || a.suburb || a.county;
        label = [road, place].filter(Boolean).join(", ") || (j.display_name || "").split(",").slice(0, 2).join(",");
      }
      _geoCache[job.key] = label;
      job.resolve(label);
    })
    .catch(() => { _geoCache[job.key] = ""; job.resolve(""); })
    .finally(() => { setTimeout(() => { _geoBusy = false; _geoPump(); }, 1100); });
}
function _reverseGeocode(lat, lon) {
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return Promise.resolve("");
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (_geoCache[key] !== undefined) return Promise.resolve(_geoCache[key]);
  return new Promise((resolve) => { _geoQueue.push({ key, lat, lon, resolve }); _geoPump(); });
}
// Compact colour legend for the trip score bands (matches _scoreColor).
const _scoreLegend = () =>
  `<div class="score-legend">` +
  [["var(--success-color,#43a047)", "8+ great"], ["var(--light-green-color,#7cb342)", "7+ good"], ["var(--warning-color,#fbc02d)", "5+ ok"], ["var(--error-color,#e53935)", "&lt;5 poor"]]
    .map(([c, l]) => `<span class="sl-i"><i style="background:${c}"></i>${l}</span>`)
    .join("") +
  `</div>`;

class EvTripListCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
    this._latestOnly = !!this._config.latestOnly; // show only the newest trip, expanded
    this._temps = this._temps || {}; // trip id -> {start,end} | 'loading'
    this._streets = this._streets || {}; // trip id -> {start,end} | 'loading'
    this._regen = this._regen || {}; // trip id -> {kwh,est} | 'loading'
    this._routes = this._routes || {}; // trip id -> [{lat,lon}] | 'loading'
  }
  // Resolve the start/end location of the open trip. The logger geocodes the
  // DESTINATION (end_address) but leaves start_address null, so the start never
  // showed. Each trip now carries start_lat/lon + end_lat/lon, so geocode those
  // directly (a containing HA zone wins, else the reverse-geocoded street).
  // Falls back to the device_tracker history for trips without coordinates.
  // Only endpoints the logger hasn't already resolved (a street or named zone)
  // are looked up. Cached per trip id.
  _fetchOpenTripStreets(rows) {
    if (this._openTripId == null) return;
    const t = rows.find((x) => String(x.id) === String(this._openTripId));
    if (!t) return;
    const id = t.id;
    if (this._streets[id] !== undefined) return;
    const needStart = !_zoneLabel(t.origin) && !_cleanAddr(t.start_address);
    const needEnd = !_zoneLabel(t.destination) && !_cleanAddr(t.end_address);
    if (!needStart && !needEnd) { this._streets[id] = {}; return; }
    const label = (lat, lon) => {
      const z = _zoneForPoint(this._hass, lat, lon);
      if (z) return Promise.resolve({ text: z, zone: true });
      return _reverseGeocode(lat, lon).then((s) => ({ text: s || null, zone: false }));
    };
    const slat = parseFloat(t.start_lat), slon = parseFloat(t.start_lon);
    const elat = parseFloat(t.end_lat), elon = parseFloat(t.end_lon);
    const haveS = !isNaN(slat) && !isNaN(slon);
    const haveE = !isNaN(elat) && !isNaN(elon);
    // Fast path: the trip carries the coordinates we still need.
    if ((!needStart || haveS) && (!needEnd || haveE)) {
      this._streets[id] = { start: needStart ? "loading" : null, end: needEnd ? "loading" : null };
      this._render();
      Promise.all([
        needStart ? label(slat, slon) : Promise.resolve(null),
        needEnd ? label(elat, elon) : Promise.resolve(null),
      ]).then(([s, e]) => { this._streets[id] = { start: s, end: e }; this._render(); });
      return;
    }
    // Fallback: pull positions from the device_tracker history (older trips /
    // vehicles that don't store per-trip coordinates). NOTE: need attributes
    // (lat/lon) so no minimal_response.
    const ent = this._config.locationEntity;
    if (!ent || !t.started_at || !t.ended_at) { this._streets[id] = {}; return; }
    this._streets[id] = "loading";
    let start, end;
    try {
      start = new Date(new Date(t.started_at).getTime() - 120000).toISOString();
      end = new Date(new Date(t.ended_at).getTime() + 120000).toISOString();
    } catch (_e) { this._streets[id] = {}; return; }
    Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        const pts = [];
        for (const x of ser) {
          const a = x.attributes || {};
          const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
          if (!isNaN(lat) && !isNaN(lon)) pts.push({ lat, lon });
        }
        if (!pts.length) { this._streets[id] = {}; this._render(); return; }
        const first = pts[0], last = pts[pts.length - 1];
        this._streets[id] = { start: needStart ? "loading" : null, end: needEnd ? "loading" : null };
        this._render();
        Promise.all([
          needStart ? label(first.lat, first.lon) : Promise.resolve(null),
          needEnd ? label(last.lat, last.lon) : Promise.resolve(null),
        ]).then(([s, e]) => { this._streets[id] = { start: s, end: e }; this._render(); });
      })
      .catch(() => { this._streets[id] = {}; this._render(); });
  }
  // Estimate the energy regenerated DURING the trip (downhill / braking). The
  // logger's regen_kwh is usually null, so integrate the POSITIVE portion of
  // the signed power sensor (positive = energy flowing back into the pack while
  // driving) across the trip window. Cached per trip id.
  _fetchOpenTripRegen(rows) {
    if (this._openTripId == null) return;
    const t = rows.find((x) => String(x.id) === String(this._openTripId));
    if (!t) return;
    const id = t.id;
    // Logger value present → no estimate needed.
    if (t.regen_kwh != null && !isNaN(Number(t.regen_kwh))) return;
    const ent = this._config.tripPowerEntity;
    if (!ent || !t.started_at || !t.ended_at || this._regen[id] !== undefined) return;
    this._regen[id] = "loading";
    let start, end;
    try { start = new Date(t.started_at).toISOString(); end = new Date(t.ended_at).toISOString(); }
    catch (_e) { this._regen[id] = {}; return; }
    Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        const pts = [];
        for (const x of ser) {
          const v = parseFloat(x.state);
          const ts = Date.parse(x.last_changed || x.last_updated);
          if (!isNaN(v) && !isNaN(ts)) pts.push([ts, v]);
        }
        let regen = 0;
        for (let i = 1; i < pts.length; i++) {
          const dtH = (pts[i][0] - pts[i - 1][0]) / 3600000;
          const p = pts[i - 1][1]; // hold previous reading over the interval
          if (p > 0 && dtH > 0 && dtH < 0.5) regen += p * dtH;
        }
        this._regen[id] = pts.length >= 3 ? { kwh: regen, est: true } : {};
        this._render();
      })
      .catch(() => { this._regen[id] = {}; this._render(); });
  }
  // Fetch the GPS breadcrumbs the car logged DURING the trip so the detail can
  // draw the real route (not just a start→end straight line). Cached per id.
  _fetchOpenTripRoute(rows) {
    const ent = this._config.locationEntity;
    if (!ent || this._openTripId == null) return;
    const t = rows.find((x) => String(x.id) === String(this._openTripId));
    if (!t || !t.started_at || !t.ended_at) return;
    const id = t.id;
    if (this._routes[id] !== undefined) return;
    this._routes[id] = "loading";
    let start, end;
    try { start = new Date(t.started_at).toISOString(); end = new Date(t.ended_at).toISOString(); }
    catch (_e) { this._routes[id] = []; return; }
    Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        const pts = [];
        for (const x of ser) {
          const a = x.attributes || {};
          const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
          if (isNaN(lat) || isNaN(lon)) continue;
          const last = pts[pts.length - 1];
          if (!last || Math.abs(last.lat - lat) > 1e-6 || Math.abs(last.lon - lon) > 1e-6) pts.push({ lat, lon });
        }
        this._routes[id] = pts;
        this._render();
      })
      .catch(() => { this._routes[id] = []; this._render(); });
  }
  // Fetch the outside-temperature at the open trip's start/end from recorder
  // history (the logger only stores avg_temp_c). Cached per trip id.
  _fetchOpenTripTemp(rows) {
    const ent = this._config.tempEntity;
    if (!ent || this._openTripId == null) return;
    const t = rows.find((x) => String(x.id) === String(this._openTripId));
    if (!t || !t.started_at || !t.ended_at) return;
    const id = t.id;
    if (this._temps[id] !== undefined) return;
    this._temps[id] = "loading";
    let start, end;
    try {
      start = new Date(new Date(t.started_at).getTime() - 120000).toISOString();
      end = new Date(new Date(t.ended_at).getTime() + 120000).toISOString();
    } catch (_e) { this._temps[id] = {}; return; }
    Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&minimal_response`))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        const vals = ser.map((p) => parseFloat(p.state)).filter((v) => !isNaN(v));
        this._temps[id] = vals.length ? { start: vals[0], end: vals[vals.length - 1] } : {};
        this._render();
      })
      .catch(() => { this._temps[id] = {}; this._render(); });
  }
  set hass(hass) {
    this._hass = hass;
    const D = this._device || detectDevice(hass);
    const sig = _sig(hass, [
      `sensor.${D}_recent_trips`,
      `sensor.${D}_recent_charges`,
      `sensor.${D}_charge_in_progress`,
      `input_text.${D}_trip_search`,
      `input_select.${D}_trip_sort`,
      `input_select.${D}_trip_window`,
      `input_number.${D}_trip_min_distance`,
      `input_number.${D}_trip_min_score`,
      `input_number.${D}_trip_max_cost`,
      `input_number.${D}_trip_max_consumption`,
    ]);
    if (sig === this._listSig) return;
    this._listSig = sig;
    this._render();
  }
  getCardSize() {
    return 8;
  }
  connectedCallback() {
    // Re-render when the global efficiency unit changes (toggled elsewhere).
    if (!this._effBound) {
      this._effBound = true;
      this._onEffUnit = () => this._render();
      window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
    }
    // Event delegation: one click listener toggles the tapped trip's detail.
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      // Efficiency-unit toggle chip in the header.
      if (ev.target && ev.target.closest && ev.target.closest(".eff-toggle")) {
        ev.stopPropagation();
        _cycleEffUnit();
        return;
      }
      const trip = ev.target && ev.target.closest && ev.target.closest(".trip");
      if (!trip || !this.contains(trip)) return;
      const id = trip.getAttribute("data-trip-id");
      if (id == null) return;
      this._openTripId = String(this._openTripId) === String(id) ? null : id;
      this._render();
    });
  }
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
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
      const label = `${t.origin || ""} ${t.destination || ""} ${t.start_address || ""} ${t.end_address || ""} ${_fmtDate(t.ended_at)}`.toLowerCase();
      if (q && !label.includes(q)) return false;
      if (t.distance_km != null && t.distance_km < minD) return false;
      if (t.score != null && t.score < minS) return false;
      if (t.cost != null && t.cost > maxC) return false;
      if (t.consumption_kwh_100km != null && t.consumption_kwh_100km > maxE) return false;
      return inWindow(t);
    });
    // Sort by a numeric key; trips MISSING that key (null/NaN) always sink to
    // the bottom regardless of direction — so "Cheapest"/"Most efficient" never
    // surface an unpriced/unmeasured trip as if it were 0.
    const by = (k, dir = 1) => (a, b) => {
      const av = a[k], bv = b[k];
      const an = av == null || isNaN(av), bn = bv == null || isNaN(bv);
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      return (av - bv) * dir;
    };
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
    _setUiLang(this._hass);
    // Lazy-bind the click delegation in case connectedCallback hasn't run.
    if (!this._clickBound && typeof this.addEventListener === "function") {
      this.connectedCallback();
    }
    const ft = this._filteredTrips();
    let rows = ft.rows; const total = ft.total, sort = ft.sort;
    // "Last trip" mode: just the newest trip, always expanded — reuses the full
    // list-detail style (location, battery, regen, route map) on the main panel.
    if (this._latestOnly) {
      rows = rows.slice(0, 1);
      if (rows[0] != null) this._openTripId = String(rows[0].id);
    }
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
          <div class="d-sub">${_fmtDate(t.ended_at, true)}${(() => { const r = _timeRange(t.started_at, t.ended_at); return r ? ` · ${r}` : ""; })()}${t.driver ? ` · <span class="d-driver"><svg class="d-driver-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>${_esc(t.driver)}</span>` : ""}</div>
          ${(() => {
            // One location line: a HA zone/area name when the endpoint was
            // inside a zone, otherwise the reverse-geocoded street (not_home).
            const ss = this._streets[t.id];
            const resolve = (place, addr, key) => {
              // 1) the logger's named place (home / zone / a street it geocoded)
              const zl = _zoneLabel(place);
              if (zl) return `<span class="${zl === "Home" ? "d-zone" : "d-street"}">${_esc(zl)}</span>`;
              // 2) the logger's street address, if it resolved one
              const a = _cleanAddr(addr);
              if (a) return `<span class="d-street">${_esc(a)}</span>`;
              // 3) our own geocode of the trip's GPS (zone name or street)
              if (ss === undefined || ss === "loading") return "…";
              const v = ss[key];
              if (v === "loading") return "…";
              if (v && v.text) return `<span class="${v.zone ? "d-zone" : "d-street"}">${_esc(v.text)}</span>`;
              return "Away";
            };
            return `<div class="d-route"><ha-icon icon="mdi:map-marker"></ha-icon>${resolve(t.origin, t.start_address, "start")}<ha-icon icon="mdi:arrow-right"></ha-icon>${resolve(t.destination, t.end_address, "end")}</div>`;
          })()}
          ${(() => {
            // Weather snapshot the logger stored on the trip (v0.5.54 weather_entity).
            // Shown only when present (null until a weather entity is configured).
            const condIcon = {
              sunny: "mdi:weather-sunny", clear: "mdi:weather-sunny", "clear-night": "mdi:weather-night",
              partlycloudy: "mdi:weather-partly-cloudy", cloudy: "mdi:weather-cloudy", fog: "mdi:weather-fog",
              rainy: "mdi:weather-rainy", pouring: "mdi:weather-pouring", snowy: "mdi:weather-snowy",
              "snowy-rainy": "mdi:weather-snowy-rainy", lightning: "mdi:weather-lightning",
              "lightning-rainy": "mdi:weather-lightning-rainy", windy: "mdi:weather-windy", hail: "mdi:weather-hail",
            };
            const at = t.ambient_temp_c, cond = t.weather_condition, hum = t.humidity_pct, wind = t.wind_kmh, precip = t.precipitation_mm;
            const chips = [];
            if (cond) chips.push(`<span class="d-wx"><ha-icon icon="${condIcon[String(cond).toLowerCase()] || "mdi:weather-partly-cloudy"}"></ha-icon>${_esc(cond)}</span>`);
            if (at != null && !isNaN(Number(at))) chips.push(`<span class="d-wx"><ha-icon icon="mdi:thermometer"></ha-icon>${Number(at).toFixed(0)}°C</span>`);
            if (hum != null && !isNaN(Number(hum))) chips.push(`<span class="d-wx"><ha-icon icon="mdi:water-percent"></ha-icon>${Number(hum).toFixed(0)}%</span>`);
            if (wind != null && !isNaN(Number(wind))) chips.push(`<span class="d-wx"><ha-icon icon="mdi:weather-windy"></ha-icon>${Number(wind).toFixed(0)} km/h</span>`);
            if (precip != null && !isNaN(Number(precip)) && Number(precip) > 0) chips.push(`<span class="d-wx"><ha-icon icon="mdi:weather-rainy"></ha-icon>${Number(precip).toFixed(1)} mm</span>`);
            return chips.length ? `<div class="d-wxrow">${chips.join("")}</div>` : "";
          })()}
          <div class="d-grid d-grid3">
            ${tile("mdi:map-marker-distance", L("Distance", "Distancia"), fmtNum(t.distance_km), "km")}
            ${tile("mdi:speedometer", L("Top speed", "Vel. máxima"), fmtNum(t.max_speed_kmh == null ? null : Math.round(t.max_speed_kmh)), "km/h")}
            ${tile("mdi:timer-outline", L("Duration", "Duración"), fmtNum(t.duration_min == null ? null : Math.round(t.duration_min)), "min")}
          </div>
          <div class="d-grid">
            ${tile("mdi:lightning-bolt", L("Consumption", "Consumo"), nn(t.energy_kwh), "kWh")}
            ${(() => { const e = _fmtEffVal(t.consumption_kwh_100km); return tile("mdi:chart-line", L("Efficiency", "Eficiencia"), e.value, e.unit); })()}
          </div>
          <div class="d-grid d-grid3">
            ${tile("mdi:speedometer", "Avg speed", speed, "km/h")}
            ${(() => {
              // SoC at motion start→end. This is the DRIVING window only — the
              // pack can also drain while parked (climate) before departure and
              // after arrival, so this "% used" can be less than peak→now.
              const s0 = t.soc_start, s1 = t.soc_end;
              const socV = s0 != null && s1 != null ? `${Math.round(s0)}→${Math.round(s1)}` : s1 != null ? `→${Math.round(s1)}` : null;
              return tile("mdi:battery", "Battery", socV || DASH, socV ? "%" : "");
            })()}
            ${(() => {
              // Regen recovered driving (downhill/braking): logger value if it
              // has one, otherwise our integrated estimate from the power sensor.
              const lg = t.regen_kwh != null && !isNaN(Number(t.regen_kwh)) ? Number(t.regen_kwh) : null;
              const est = this._regen[t.id];
              let val, label = "Regen";
              if (lg != null) val = lg.toFixed(2);
              else if (est === "loading") val = "…";
              else if (est && est.kwh != null) { val = est.kwh.toFixed(2); label = "Regen ~"; }
              else val = DASH;
              return tile("mdi:sync", label, val, "kWh");
            })()}
          </div>
          <div class="d-grid">
            ${(() => {
              const tp = this._temps[t.id];
              const fmtT = (v) => (tp === "loading" ? "…" : v != null ? Number(v).toFixed(1) : DASH);
              return (
                tile("mdi:thermometer-low", "Temp start", fmtT(tp && tp.start), "°C") +
                tile("mdi:thermometer-high", "Temp end", fmtT(tp && tp.end), "°C")
              );
            })()}
          </div>
          ${(() => {
            // Real driven route from the GPS breadcrumbs logged during the trip.
            const rt = this._routes[t.id];
            if (rt === "loading") return `<div class="d-map d-map--ph">${L("Loading route…", "Cargando ruta…")}</div>`;
            if (Array.isArray(rt) && rt.length >= 2) {
              const svg = _routeSvg(rt);
              if (svg) return `<div class="d-map">${svg}</div>`;
            }
            return "";
          })()}
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
      const driverChip = t.driver
        ? `<span class="driver-chip"><svg class="driver-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>${_esc(t.driver)}</span>`
        : "";
      return `
        <div class="trip${isOpen ? " trip--open" : ""}" data-trip-id="${_esc(t.id)}">
          <div class="trip-date">${_fmtDate(t.ended_at, true)}${driverChip}</div>
          <div class="cols">
            ${col("Distance", fmtNum(t.distance_km), "km")}
            ${col("Consumption", nn(t.energy_kwh), "kWh")}
            ${(() => { const e = _fmtEffVal(t.consumption_kwh_100km); return col("Efficiency", e.value === "—" ? DASH : e.value, e.unit); })()}
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
    if (!this._latestOnly && (cs.state === "charging" || cs.state === "paused")) {
      const charging = cs.state === "charging";
      const soc = cs.soc != null ? `${cs.soc.toFixed(0)}%` : "";
      const dm = cs.durationMin != null ? cs.durationMin : cs.lastDurMin;
      const durStr = dm == null ? "" : dm >= 60 ? `${Math.floor(dm / 60)}h ${Math.round(dm % 60)}m` : `${Math.round(dm)} min`;
      const energy = cs.energy != null ? cs.energy : cs.lastEnergy;
      // Until the logger has a kWh delta (soc_start may be null at the very
      // start), show "starting…" rather than a misleading 0.00 kWh.
      const hasE = energy != null && energy >= 0.01;
      const metrics = charging
        ? `${hasE ? `<b>${energy.toFixed(2)}</b> kWh · ` : "starting… · "}<b>${(cs.power || 0).toFixed(1)}</b> kW${durStr ? ` · ${durStr}` : ""}`
        : `Cable connected · not charging${hasE ? ` · <b>${energy.toFixed(2)}</b> kWh` : ""}${durStr ? ` · ${durStr}` : ""}`;
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
          .d-grid3{grid-template-columns:repeat(3,1fr);}
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
          .d-route{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-weight:600;
                   font-size:.95em;margin-top:-2px;}
          .d-route ha-icon{--mdc-icon-size:15px;color:var(--secondary-text-color);}
          .d-route ha-icon[icon="mdi:map-marker"]{color:var(--info-color,#039be5);}
          .d-zone{color:var(--primary-text-color);}
          .d-street{color:var(--info-color,#039be5);font-weight:600;}
          .d-wxrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:-4px;}
          .d-wx{display:inline-flex;align-items:center;gap:3px;font-size:.8em;font-weight:600;
                padding:2px 8px;border-radius:999px;color:var(--secondary-text-color);
                background:var(--secondary-background-color,rgba(0,0,0,.06));border:1px solid var(--divider-color);}
          .d-wx ha-icon{--mdc-icon-size:14px;}
          .d-map{border-radius:12px;overflow:hidden;margin-top:2px;
                 border:1px solid var(--divider-color,rgba(0,0,0,.12));}
          .d-map--ph{height:170px;display:flex;align-items:center;justify-content:center;
                     color:var(--secondary-text-color);font-size:.85em;
                     background:var(--secondary-background-color);}
          .cal-rt-svg{display:block;width:100%;height:170px;}
          .cal-rt-bg{fill:var(--secondary-background-color,#e8eaed);}
          .cal-rt-svg image{image-rendering:auto;}
          .cal-rt-halo{fill:none;stroke:#fff;stroke-width:5;stroke-linejoin:round;stroke-linecap:round;opacity:.8;}
          .cal-rt-line{fill:none;stroke:#1565c0;stroke-width:3;stroke-linejoin:round;stroke-linecap:round;}
          .cal-rt-start{fill:var(--success-color,#43a047);stroke:#fff;stroke-width:1.5;}
          .cal-rt-end{fill:var(--error-color,#e53935);stroke:#fff;stroke-width:1.5;}
          .cal-rt-attr{fill:#000;opacity:.5;font-size:7px;text-anchor:end;paint-order:stroke;stroke:#fff;stroke-width:2;}
          .d-cmp{display:flex;flex-direction:column;gap:8px;margin-top:2px;}
          .d-cmp-row{display:flex;justify-content:space-between;align-items:center;
                     font-size:.95em;}
          .d-cmp-label{color:var(--secondary-text-color);}
          .d-cmp-val{font-weight:800;font-variant-numeric:tabular-nums;}
          .driver-chip{display:inline-flex;align-items:center;gap:3px;margin-left:8px;
                       font-size:.75em;font-weight:600;padding:1px 7px;border-radius:999px;
                       background:var(--secondary-background-color,rgba(0,0,0,.06));
                       border:1px solid var(--divider-color);color:var(--secondary-text-color);
                       vertical-align:middle;}
          .driver-icon{width:11px;height:11px;fill:currentColor;flex:0 0 auto;}
          .d-driver{display:inline-flex;align-items:center;gap:3px;
                    color:var(--secondary-text-color);font-size:.9em;}
          .d-driver-icon{width:12px;height:12px;fill:currentColor;flex:0 0 auto;}
          .head-right{display:inline-flex;align-items:center;gap:8px;}
          .eff-toggle{display:inline-flex;align-items:center;gap:3px;cursor:pointer;
                      font-size:.62em;font-weight:700;letter-spacing:.02em;
                      padding:3px 8px;border-radius:999px;color:var(--primary-color);
                      background:var(--secondary-background-color,rgba(0,0,0,.06));
                      border:1px solid var(--divider-color);}
          .eff-toggle:hover{border-color:var(--primary-color);}
          .eff-toggle ha-icon{--mdc-icon-size:13px;}
          @media (max-width:360px){
            .col-label{font-size:.55em;}
            .col-val{font-size:.95em;}
            .col-val--big{font-size:1.3em;}
          }
        </style>
        <div class="head"><span>${_esc(this._config.title || (this._latestOnly ? L("Last trip", "Último viaje") : "Trips"))}</span>
          ${this._latestOnly ? "" : `<span class="head-right">
            <button class="eff-toggle" title="${L("Change consumption unit", "Cambiar unidad de consumo")}"><ha-icon icon="mdi:swap-horizontal"></ha-icon>${_esc(_effUnitLabel())}</button>
            <span class="count">${rows.length} of ${total}</span>
          </span>`}</div>
        <div class="list">${rowsHtml}</div>
      </ha-card>`;

    // Lazily fetch the open trip's start/end temperature + street, the regen
    // estimate, and the driven GPS route.
    this._fetchOpenTripTemp(rows);
    this._fetchOpenTripStreets(rows);
    this._fetchOpenTripRegen(rows);
    this._fetchOpenTripRoute(rows);
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
    this._streets = this._streets || {}; // charge_id -> {label,lat,lon} | 'loading'
  }
  set hass(hass) {
    this._hass = hass;
    // Don't blow away an in-progress price edit when an unrelated state update
    // arrives — re-render is resumed once the input loses focus / is applied.
    if (this._editing) return;
    const D = this._device || detectDevice(hass);
    const sig = _sig(hass, [
      `sensor.${D}_recent_charges`,
      `sensor.${D}_recent_trips`,
      `sensor.${D}_charge_in_progress`,
    ]);
    if (sig === this._histSig) return;
    this._histSig = sig;
    this._render();
  }
  getCardSize() {
    return 4;
  }
  connectedCallback() {
    if (!this._effBound) {
      this._effBound = true;
      this._onEffUnit = () => this._render();
      window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
    }
    // Event delegation: one click listener toggles the tapped journey's detail.
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const tgt = ev.target;
      if (!tgt || !tgt.closest) return;
      // Inline price editor: Apply button sets THIS charge's €/kWh.
      const apply = tgt.closest(".cp-apply[data-charge-id]");
      if (apply && this.contains(apply)) {
        ev.stopPropagation();
        this._applyPrice(apply.getAttribute("data-charge-id"));
        return;
      }
      // Clicks inside the editor row must not toggle the day open/closed.
      if (tgt.closest(".cp-edit")) { ev.stopPropagation(); return; }
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
    // Pause re-render while the user is typing in a price input.
    this.addEventListener("focusin", (ev) => { if (ev.target && ev.target.closest && ev.target.closest(".cp-input")) this._editing = true; });
    this.addEventListener("focusout", (ev) => { if (ev.target && ev.target.closest && ev.target.closest(".cp-input")) this._editing = false; });
  }
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
  }
  _applyPrice(chargeId) {
    const id = parseInt(chargeId, 10);
    if (isNaN(id)) return;
    const input = this.querySelector(`.cp-input[data-charge-id="${chargeId}"]`);
    if (!input) return;
    const price = parseFloat(String(input.value).replace(",", "."));
    if (isNaN(price) || price < 0) { input.focus(); return; }
    this._editing = false;
    const data = { charge_id: id, price_per_kwh: price };
    if (this._config.entry_id) data.entry_id = this._config.entry_id;
    // ev_trip_logger.set_last_charge_price targets a specific charge when
    // charge_id is given, and sets price_locked=1 (so the editor then hides).
    Promise.resolve(this._hass.callService("ev_trip_logger", "set_last_charge_price", data))
      .then(() => { this._render(); })
      .catch((e) => { console.error("set charge price failed", e); this._render(); });
  }
  // Synthesise the charge that is happening RIGHT NOW from the live sensors —
  // the logger only writes a charge to recent_charges once it ENDS, so an
  // ongoing (e.g. overnight) charge would otherwise be missing from the
  // history. Returns null when not charging. Marked in_progress for the UI.
  _liveCharge(D) {
    const st = (id) => this._hass.states[id];
    const cip = st(`sensor.${D}_charge_in_progress`);
    const cipOn = cip && String(cip.state).toLowerCase() === "charging";
    if (!cipOn) return null;
    const numOf = (id) => { const s = st(id); const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; };
    const energy = numOf(`sensor.${D}_current_charge_energy`);
    const durMin = numOf(`sensor.${D}_current_charge_duration`);
    const typeS = st(`sensor.${D}_current_charge_type`);
    const type = typeS && typeS.state && !["unknown", "unavailable"].includes(String(typeS.state).toLowerCase()) ? String(typeS.state).toUpperCase() : null;
    const socStart = cip.attributes && cip.attributes.soc_start != null ? Number(cip.attributes.soc_start) : null;
    const socNow = numOf(`sensor.${D}_battery_percent`);
    const costEnt = st(`sensor.${D}_current_charge_cost`);
    const currency = (costEnt && costEnt.attributes && costEnt.attributes.unit_of_measurement) || "EUR";
    const le = this._config.locationEntity ? st(this._config.locationEntity) : null;
    const location = le && String(le.state).toLowerCase() === "home" ? "home" : null;
    let now, started;
    try { now = new Date(); started = durMin != null ? new Date(now.getTime() - durMin * 60000) : null; }
    catch (_e) { return null; }
    return {
      id: "__live__", charge_id: "__live__", in_progress: true,
      started_at: started ? started.toISOString() : null,
      ended_at: now.toISOString(),
      kwh: energy, total_cost: numOf(`sensor.${D}_current_charge_cost`),
      price_per_kwh: numOf(`sensor.${D}_current_charge_price_per_kwh`),
      soc_start: socStart, soc_end: socNow,
      is_dcfc: type === "DC", type, currency, location,
    };
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
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
    // Prepend the charge in progress (not yet in recent_charges) so it shows
    // at the top of today, instead of vanishing until it finishes.
    if (kind === "charges") {
      const live = this._liveCharge(D);
      if (live) rows.unshift(live);
    }
    const cur = { EUR: "€", USD: "$", GBP: "£" };
    const sym = (c) => cur[c] || c || "€";
    const DASH = "—";
    const fmtNum = (v, dp) => (v == null || isNaN(v) ? DASH : dp == null ? String(v) : Number(v).toFixed(dp));

    const inner = kind === "journeys" ? this._journeysHtml(rows, D, sym, DASH, fmtNum) : this._chargesHtml(rows, sym, DASH, fmtNum);
    if (kind === "charges") { this._fetchOpenDayCurves(rows); this._fetchOpenChargeStreets(rows); }

    this.innerHTML = `
      <ha-card>
        <style>
          .head{display:flex;justify-content:space-between;align-items:baseline;
                padding:14px 16px 10px;font-weight:600;font-size:1.05em;}
          .head .count{color:var(--secondary-text-color);font-weight:400;font-size:.82em;}
          .list{display:flex;flex-direction:column;gap:10px;padding:0 12px 14px;}
          .list--scroll{scrollbar-width:thin;}
          .list--scroll::-webkit-scrollbar{width:6px;}
          .list--scroll::-webkit-scrollbar-thumb{background:var(--divider-color);border-radius:3px;}
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
          /* ---- not_home street + maps link ---- */
          .s-loc{display:flex;align-items:center;gap:5px;font-size:.82em;padding:4px 4px 0;color:var(--secondary-text-color);}
          .s-loc ha-icon{--mdc-icon-size:15px;color:var(--info-color,#039be5);flex:0 0 auto;}
          .s-loc a{color:var(--info-color,#039be5);text-decoration:none;font-weight:600;}
          .s-loc a:hover{text-decoration:underline;}
          /* ---- inline per-charge price editor ---- */
          .cp-edit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 4px 4px;}
          .cp-lbl{font-size:.8em;color:var(--secondary-text-color);}
          .cp-input{width:92px;padding:6px 8px;border-radius:8px;border:1px solid var(--divider-color);
                    background:var(--card-background-color);color:var(--primary-text-color);
                    font-size:.95em;font-variant-numeric:tabular-nums;}
          .cp-apply{display:inline-flex;align-items:center;gap:3px;cursor:pointer;border:none;
                    border-radius:8px;padding:6px 12px;font-size:.85em;font-weight:700;
                    background:var(--primary-color);color:#fff;}
          .cp-apply ha-icon{--mdc-icon-size:16px;}
          .cp-locked{display:flex;align-items:center;gap:5px;font-size:.82em;padding:8px 4px 4px;
                     color:var(--success-color,#43a047);font-weight:600;font-variant-numeric:tabular-nums;}
          .cp-locked ha-icon{--mdc-icon-size:15px;}
          .chip--ac{color:var(--success-color, #43a047);
                    border-color:var(--success-color, #43a047);}
          .chip--dc{color:var(--warning-color, #fb8c00);
                    border-color:var(--warning-color, #fb8c00);}
          .chip--soc{color:var(--info-color, #039be5);border-color:var(--info-color, #039be5);}
          .chip--soc ha-icon{--mdc-icon-size:13px;}
          .chip--eff{color:var(--success-color,#43a047);border-color:var(--success-color,#43a047);}
          .chip--eff ha-icon{--mdc-icon-size:13px;}
          .chip--live{color:var(--success-color,#43a047);border-color:var(--success-color,#43a047);
                      font-weight:700;animation:evpulse 1.6s ease-in-out infinite;}
          .chip--live ha-icon{--mdc-icon-size:13px;}
          @keyframes evpulse{0%,100%{opacity:1;}50%{opacity:.45;}}
          .chargeday--live{border-color:var(--success-color,#43a047);}
          .session--live{position:relative;}
          .score-pill--live{background:var(--success-color,#43a047);}
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
        <div class="list${this._config.scrollRows ? " list--scroll" : ""}"${this._config.scrollRows ? ` style="max-height:${Math.round(this._config.scrollRows * 78)}px;overflow-y:auto;"` : ""}>${inner}</div>
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
                <div class="smetrics"><b>${fmtNum(t.distance_km)}</b> km · <b>${_fmtEff(t.consumption_kwh_100km)}</b></div>
              </div>
              <div class="score-pill" style="background:${_scoreColor(t.score)}">${score}</div>
            </div>`;
        })
        .join("");
    }

    // Averages / summary (efficiency in the active display unit).
    const avgConsE =
      j.energy_kwh != null && j.distance_km != null && j.distance_km !== 0
        ? _fmtEffVal((j.energy_kwh / j.distance_km) * 100)
        : { value: DASH, unit: _effUnitLabel() };

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
          ${stat("Avg consumption", avgConsE.value, avgConsE.unit)}
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
        const hasLive = sessions.some((c) => c.in_progress);

        const detail = isOpen ? this._chargeDayDetailHtml(sessions, sym, DASH, fmtNum, timeOf) : "";

        return `
          <div class="chargeday${isOpen ? " chargeday--open" : ""}${hasLive ? " chargeday--live" : ""}" data-day="${_esc(key)}">
            <div class="badge badge--ev"><ha-icon icon="mdi:ev-station"></ha-icon></div>
            <div class="body">
              <div class="title-line">
                <span class="title">${_esc(dayLabel(key))}</span>
                <span class="chip"><ha-icon icon="mdi:counter"></ha-icon>${n} ${L(n === 1 ? "charge" : "charges", n === 1 ? "carga" : "cargas")}</span>
                ${hasLive ? `<span class="chip chip--live"><ha-icon icon="mdi:flash"></ha-icon>${L("charging", "cargando")}</span>` : ""}
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
        // Charge in progress: live row from current sensors — no end time,
        // price editor, geocode or stored curve (it's ongoing).
        if (c.in_progress) {
          const r0 = (v) => (v == null || isNaN(v) ? null : Math.round(Number(v)));
          const ss0 = r0(c.soc_start), se0 = r0(c.soc_end);
          const socStr = se0 != null ? (ss0 != null ? `${ss0}→${se0}% (+${se0 - ss0})` : `→${se0}%`) : null;
          const socChip = socStr ? `<span class="chip chip--soc"><ha-icon icon="mdi:battery-charging-high"></ha-icon>${socStr}</span>` : "";
          const type = c.type ? String(c.type).toUpperCase() : (c.is_dcfc ? "DC" : null);
          const typeChip = type ? `<span class="chip chip--${type === "DC" ? "dc" : "ac"}">${_esc(type)}</span>` : "";
          const pwrEnt = this._hass.states[`sensor.${this._device}_current_charge_power`];
          const pwr = pwrEnt && !isNaN(parseFloat(pwrEnt.state)) ? `${Number(pwrEnt.state).toFixed(1)} kW` : null;
          const liveEff = parseFloat(((this._hass.states[`sensor.${this._device}_current_charge_efficiency`] || {}).state));
          const effChipLive = !isNaN(liveEff) && liveEff > 0 ? `<span class="chip chip--eff"><ha-icon icon="mdi:gauge"></ha-icon>${liveEff.toFixed(0)}%</span>` : "";
          const total = c.total_cost != null ? `${fmtNum(c.total_cost, 2)} ${_esc(sym(c.currency))}` : DASH;
          return `
            <div class="csession">
              <div class="session session--live">
                <div class="sbody">
                  <div class="sroute">
                    <span class="chip chip--live"><ha-icon icon="mdi:flash"></ha-icon>${L("Charging now", "Cargando ahora")}</span>
                    <span class="chip">${_endpoint(null, c.location)}</span>
                    ${typeChip}
                    ${socChip}
                    ${effChipLive}
                  </div>
                  <div class="smetrics"><b>${fmtNum(c.kwh)}</b> kWh${pwr ? ` · <b>${pwr}</b>` : ""}${c.price_per_kwh != null ? ` · <b>${fmtNum(c.price_per_kwh)}</b> ${_esc(sym(c.currency))}/kWh` : ""}${c.started_at ? ` · ${L("since", "desde")} ${timeOf(c.started_at)}` : ""}</div>
                </div>
                <div class="score-pill score-pill--live">${total}</div>
              </div>
            </div>`;
        }
        const type = c.type ? String(c.type).toUpperCase() : (c.is_dcfc ? "DC" : null);
        const typeChip = type ? `<span class="chip chip--${type === "DC" ? "dc" : "ac"}">${_esc(type)}</span>` : "";
        const total = c.total_cost != null ? `${fmtNum(c.total_cost, 2)} ${_esc(sym(c.currency))}` : DASH;
        // Per-charge power-vs-time curve (recorder history, fetched lazily).
        const id = c.charge_id != null ? c.charge_id : c.id;
        const cv = id != null ? this._curves[id] : undefined;
        // Duration = time ACTUALLY charging, not plugged-in. started_at→ended_at
        // spans the whole connection (a car left plugged overnight reads ~24h),
        // so prefer the power curve: sum the minutes where charge power > 0.2 kW.
        // Fallback to the plug span ONLY when it implies a real rate (≥1.5 kW);
        // otherwise it's mostly idle and we show no (misleading) duration.
        let durMin = null;
        if (Array.isArray(cv) && cv.length >= 2) {
          let m = 0;
          for (let i = 1; i < cv.length; i++) {
            const dt = (cv[i].t - cv[i - 1].t) / 60000, p = cv[i - 1].v;
            if (p > 0.2 && dt > 0 && dt < 120) m += dt;
          }
          if (m > 0) durMin = m;
        }
        if (durMin == null && c.started_at && c.ended_at) {
          const span = (new Date(c.ended_at) - new Date(c.started_at)) / 60000;
          const impliedKw = c.kwh != null && span > 0 ? Number(c.kwh) / (span / 60) : null;
          if (!isNaN(span) && span >= 0 && impliedKw != null && impliedKw >= 1.5) durMin = span;
        }
        const durStr =
          durMin == null ? null : durMin >= 60 ? `${Math.floor(durMin / 60)}h ${Math.round(durMin % 60)}m` : `${Math.round(durMin)} min`;
        const avgKw = c.kwh != null && durMin && durMin > 0 ? Number(c.kwh) / (durMin / 60) : null;
        const extra =
          (durStr ? ` · <ha-icon class="s-mini" icon="mdi:timer-outline"></ha-icon>${durStr}` : "") +
          (avgKw != null ? ` · <b>${avgKw.toFixed(1)}</b> kW avg` : "");
        let curve;
        if (cv == null || cv === "loading") curve = `<div class="cv-msg">Loading power curve…</div>`;
        else if (!Array.isArray(cv) || cv.length < 2) curve = `<div class="cv-msg">No power history for this charge.</div>`;
        else curve = _miniPowerSvg(cv);
        const cid = c.charge_id != null ? c.charge_id : c.id;
        const locked = c.price_locked === true;
        // Home charges always use the default home price — only AWAY charges
        // (not_home / a named zone like "Trabajo ele") need a manual price.
        const isHome = String(c.location || "").toLowerCase() === "home";
        // not_home → street + Google Maps link (geocoded from device_tracker
        // history at charge time; charges carry no coordinates).
        const isAway = !c.location || String(c.location).toLowerCase() === "not_home";
        let locHtml = "";
        if (this._config.locationEntity && isAway) {
          const ss = this._streets[cid];
          if (ss === undefined || ss === "loading") locHtml = `<div class="s-loc"><ha-icon icon="mdi:map-marker"></ha-icon> locating…</div>`;
          else if (ss && ss.lat != null) {
            const q = `${ss.lat},${ss.lon}`;
            locHtml = `<div class="s-loc"><ha-icon icon="mdi:map-marker"></ha-icon><a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">${_esc(ss.label || "View on map")}</a></div>`;
          }
        }
        // Inline €/kWh editor — only for AWAY charges (home uses the default
        // price). Sets THIS charge by charge_id; hides once price_locked=1.
        let priceHtml = "";
        if (locked) {
          priceHtml = `<div class="cp-locked"><ha-icon icon="mdi:lock-check"></ha-icon>${fmtNum(c.price_per_kwh, 3)} ${_esc(sym(c.currency))}/kWh · set</div>`;
        } else if (!isHome) {
          priceHtml = `<div class="cp-edit">
               <span class="cp-lbl">Set €/kWh</span>
               <input class="cp-input" data-charge-id="${_esc(cid)}" type="number" inputmode="decimal" step="0.001" min="0" placeholder="${fmtNum(c.price_per_kwh, 3)}" />
               <button class="cp-apply" data-charge-id="${_esc(cid)}"><ha-icon icon="mdi:check"></ha-icon>Set</button>
             </div>`;
        }
        // SoC reached by this charge (start→end %); end is always recorded,
        // start sometimes isn't.
        const r0 = (v) => (v == null || isNaN(v) ? null : Math.round(Number(v)));
        const ss0 = r0(c.soc_start), se0 = r0(c.soc_end);
        const socStr = se0 != null ? (ss0 != null ? `${ss0}→${se0}% (+${se0 - ss0})` : `→${se0}%`) : null;
        const socChip = socStr ? `<span class="chip chip--soc"><ha-icon icon="mdi:battery-charging-high"></ha-icon>${socStr}</span>` : "";
        // AC→DC charging efficiency for THIS charge (logger v0.5.90, from the
        // EVSE power sensor). Present only once a charge runs with EVSE metering.
        const effV = c.charging_efficiency_pct;
        const effChip = effV != null && !isNaN(Number(effV))
          ? `<span class="chip chip--eff"><ha-icon icon="mdi:gauge"></ha-icon>${Number(effV).toFixed(0)}%${c.evse_energy_kwh != null && !isNaN(Number(c.evse_energy_kwh)) ? ` · ${Number(c.evse_energy_kwh).toFixed(1)} kWh AC` : ""}</span>`
          : "";
        return `
          <div class="csession">
            <div class="session">
              <div class="sbody">
                <div class="sroute">
                  <span class="stime">${timeOf(c.ended_at)}</span>
                  <span class="chip">${_endpoint(null, c.location)}</span>
                  ${typeChip}
                  ${socChip}
                  ${effChip}
                </div>
                <div class="smetrics"><b>${fmtNum(c.kwh)}</b> kWh · <b>${fmtNum(c.price_per_kwh)}</b> ${_esc(sym(c.currency))}/kWh${extra}</div>
                ${locHtml}
                ${priceHtml}
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
      if (c.in_progress) continue; // ongoing charge: no stored curve to fetch
      const id = c.charge_id != null ? c.charge_id : c.id;
      if (id == null || this._curves[id] !== undefined) continue;
      this._curves[id] = "loading";
      this._fetchCurve(D, c, id);
    }
  }

  // For not_home charges of the open day, resolve the street: charges store no
  // coordinates, so pull the device_tracker position during the charge window
  // and reverse-geocode it (cached per charge_id).
  _fetchOpenChargeStreets(rows) {
    const ent = this._config.locationEntity;
    if (!ent || this._openId == null || !this._hass) return;
    const p = (n) => String(n).padStart(2, "0");
    const dayKey = (iso) => { const d = new Date(iso); return isNaN(d) ? "unknown" : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    const sessions = rows.filter((c) => dayKey(c.ended_at) === this._openId);
    for (const c of sessions) {
      if (c.in_progress) continue; // ongoing charge handled by live sensors
      const id = c.charge_id != null ? c.charge_id : c.id;
      const isAway = !c.location || String(c.location).toLowerCase() === "not_home";
      if (id == null || !isAway || this._streets[id] !== undefined) continue;
      this._streets[id] = "loading";
      let start, end;
      try {
        start = new Date(new Date(c.started_at).getTime() - 120000).toISOString();
        end = new Date(new Date(c.ended_at || c.started_at).getTime() + 120000).toISOString();
      } catch (_e) { this._streets[id] = {}; continue; }
      Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
        .then((res) => {
          const ser = Array.isArray(res) && res[0] ? res[0] : [];
          let lat = null, lon = null;
          for (const x of ser) {
            const a = x.attributes || {};
            const la = parseFloat(a.latitude), lo = parseFloat(a.longitude);
            if (!isNaN(la) && !isNaN(lo)) { lat = la; lon = lo; break; }
          }
          if (lat == null) { this._streets[id] = {}; this._render(); return; }
          _reverseGeocode(lat, lon).then((label) => { this._streets[id] = { label: label || null, lat, lon }; this._render(); });
        })
        .catch(() => { this._streets[id] = {}; this._render(); });
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
    const D = this._device || detectDevice(hass);
    const sig = _sig(hass, [
      `sensor.${D}_current_journey`,
      `sensor.${D}_last_journey`,
      `sensor.${D}_recent_trips`,
      `sensor.${D}_recent_charges`,
      `sensor.${D}_charge_in_progress`,
      `sensor.${D}_last_charge_energy`,
    ]);
    if (sig === this._journeySig) return;
    this._journeySig = sig;
    this._render();
  }
  getCardSize() {
    return 3;
  }
  connectedCallback() {
    if (!this._effBound) {
      this._effBound = true;
      this._onEffUnit = () => this._render();
      window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
    }
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const h = ev.target && ev.target.closest && ev.target.closest(".jhead.jclickable");
      if (h && this.contains(h)) { this._open = !this._open; this._render(); }
    });
  }
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
  }
  // Recompute the in-progress journey from recent_trips so it reflects only the
  // current run away from home — the logger leaves a journey open across an
  // overnight home charge (it anchors close on a →home TRIP only). The current
  // run starts after the latest moment the car was home: a trip that ended at
  // "home", OR a charge whose location is "home".
  _correctedLiveJourney(D) {
    const ms = (x) => { const t = new Date(x).getTime(); return isNaN(t) ? null : t; };
    const trips = ((this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {}).trips || [];
    const charges = ((this._hass.states[`sensor.${D}_recent_charges`] || {}).attributes || {}).charges || [];
    if (!Array.isArray(trips) || !trips.length) return null;
    let anchor = 0;
    for (const t of trips) {
      if (String(t.destination || "").toLowerCase() === "home" && t.ended_at) { const e = ms(t.ended_at); if (e != null) anchor = Math.max(anchor, e); }
    }
    for (const c of charges) {
      if (String(c.location || "").toLowerCase() === "home" && c.ended_at) { const e = ms(c.ended_at); if (e != null) anchor = Math.max(anchor, e); }
    }
    const stages = trips
      .filter((t) => { const s = ms(t.started_at); return s != null && s >= anchor - 60000; })
      .sort((x, y) => ms(x.started_at) - ms(y.started_at));
    if (!stages.length) return null;
    const sum = (k) => stages.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    return {
      stages: stages.length,
      stagesList: stages,
      started_at: stages[0].started_at,
      distance_km: sum("distance_km"),
      energy_kwh: sum("energy_kwh"),
      cost: stages.some((x) => x.cost != null) ? sum("cost") : null,
    };
  }
  // Stages (sub-trips) of a finished journey, by its journey_id, oldest first.
  _journeyStagesById(D, jid) {
    if (jid == null) return [];
    const trips = ((this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {}).trips || [];
    return trips
      .filter((t) => String(t.journey_id) === String(jid))
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  }
  // Fetch outside-temperature at each stage's start/end from recorder history
  // (the logger doesn't populate avg_temp_c). Cached per trip id, lazy.
  _fetchStageTemps(stages) {
    const ent = this._config.tempEntity;
    this._temps = this._temps || {};
    if (!ent || !this._hass) return;
    for (const t of stages) {
      const id = t.id != null ? t.id : t.trip_id;
      if (id == null || !t.started_at || !t.ended_at || this._temps[id] !== undefined) continue;
      this._temps[id] = "loading";
      let start, end;
      try {
        start = new Date(new Date(t.started_at).getTime() - 120000).toISOString();
        end = new Date(new Date(t.ended_at).getTime() + 120000).toISOString();
      } catch (_e) { this._temps[id] = {}; continue; }
      Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&minimal_response`))
        .then((res) => {
          const ser = Array.isArray(res) && res[0] ? res[0] : [];
          const vals = ser.map((p) => parseFloat(p.state)).filter((v) => !isNaN(v));
          this._temps[id] = vals.length ? { start: vals[0], end: vals[vals.length - 1] } : {};
          this._render();
        })
        .catch(() => { this._temps[id] = {}; this._render(); });
    }
  }
  // Resolve each stage's start/end LOCATION. The logger leaves start_address
  // null, so geocode the stage's own start_lat/lon (a containing HA zone wins,
  // else the reverse-geocoded street), falling back to the device_tracker
  // history for stages without coordinates. Independent of origin/destination.
  // Cached per trip id, lazy (only while the journey detail is open).
  _fetchStageStreets(stages) {
    this._streets = this._streets || {};
    if (!this._hass) return;
    const ent = this._config.locationEntity;
    const label = (lat, lon) => {
      const z = _zoneForPoint(this._hass, lat, lon);
      if (z) return Promise.resolve(z);
      return _reverseGeocode(lat, lon).then((s) => s || null);
    };
    for (const t of stages) {
      const id = t.id != null ? t.id : t.trip_id;
      if (id == null || this._streets[id] !== undefined) continue;
      // Only look up endpoints the logger hasn't already resolved.
      const needStart = !_zoneLabel(t.origin) && !_cleanAddr(t.start_address);
      const needEnd = !_zoneLabel(t.destination) && !_cleanAddr(t.end_address);
      if (!needStart && !needEnd) { this._streets[id] = {}; continue; }
      const slat = parseFloat(t.start_lat), slon = parseFloat(t.start_lon);
      const elat = parseFloat(t.end_lat), elon = parseFloat(t.end_lon);
      const haveS = !isNaN(slat) && !isNaN(slon), haveE = !isNaN(elat) && !isNaN(elon);
      // Fast path: stage carries the coordinates we need.
      if ((!needStart || haveS) && (!needEnd || haveE)) {
        this._streets[id] = "loading";
        Promise.all([
          needStart ? label(slat, slon) : Promise.resolve(null),
          needEnd ? label(elat, elon) : Promise.resolve(null),
        ]).then(([s, e]) => { this._streets[id] = { start: s, end: e }; this._render(); });
        continue;
      }
      // Fallback: device_tracker history.
      if (!ent || !t.started_at || !t.ended_at) { this._streets[id] = {}; continue; }
      this._streets[id] = "loading";
      let start, end;
      try {
        start = new Date(new Date(t.started_at).getTime() - 120000).toISOString();
        end = new Date(new Date(t.ended_at).getTime() + 120000).toISOString();
      } catch (_e) { this._streets[id] = {}; continue; }
      Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
        .then((res) => {
          const ser = Array.isArray(res) && res[0] ? res[0] : [];
          const pts = [];
          for (const x of ser) {
            const a = x.attributes || {};
            const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
            if (!isNaN(lat) && !isNaN(lon)) pts.push({ lat, lon });
          }
          if (!pts.length) { this._streets[id] = {}; this._render(); return; }
          const first = pts[0], last = pts[pts.length - 1];
          Promise.all([
            needStart ? label(first.lat, first.lon) : Promise.resolve(null),
            needEnd ? label(last.lat, last.lon) : Promise.resolve(null),
          ]).then(([s, e]) => { this._streets[id] = { start: s, end: e }; this._render(); });
        })
        .catch(() => { this._streets[id] = {}; this._render(); });
    }
  }
  // Estimate per-stage regen by integrating the positive power while driving
  // (same approach as the trip detail). Logger value wins when present. Lazy.
  _fetchStageRegen(stages) {
    this._regen = this._regen || {};
    const ent = this._config.tripPowerEntity;
    if (!ent || !this._hass) return;
    for (const t of stages) {
      const id = t.id != null ? t.id : t.trip_id;
      if (id == null || !t.started_at || !t.ended_at || this._regen[id] !== undefined) continue;
      if (t.regen_kwh != null && !isNaN(Number(t.regen_kwh))) { this._regen[id] = null; continue; }
      this._regen[id] = "loading";
      let start, end;
      try { start = new Date(t.started_at).toISOString(); end = new Date(t.ended_at).toISOString(); }
      catch (_e) { this._regen[id] = {}; continue; }
      Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
        .then((res) => {
          const ser = Array.isArray(res) && res[0] ? res[0] : [];
          const pts = [];
          for (const x of ser) {
            const v = parseFloat(x.state), ts = Date.parse(x.last_changed || x.last_updated);
            if (!isNaN(v) && !isNaN(ts)) pts.push([ts, v]);
          }
          let regen = 0;
          for (let i = 1; i < pts.length; i++) {
            const dtH = (pts[i][0] - pts[i - 1][0]) / 3600000, p = pts[i - 1][1];
            if (p > 0 && dtH > 0 && dtH < 0.5) regen += p * dtH;
          }
          this._regen[id] = pts.length >= 3 ? { kwh: regen, est: true } : {};
          this._render();
        })
        .catch(() => { this._regen[id] = {}; this._render(); });
    }
  }
  // Fetch the GPS breadcrumbs each stage logged so the detail can draw the real
  // route over OpenStreetMap (not just a start→end line). Lazy, cached per id.
  _fetchStageRoute(stages) {
    this._routes = this._routes || {};
    const ent = this._config.locationEntity;
    if (!ent || !this._hass) return;
    for (const t of stages) {
      const id = t.id != null ? t.id : t.trip_id;
      if (id == null || !t.started_at || !t.ended_at || this._routes[id] !== undefined) continue;
      this._routes[id] = "loading";
      let start, end;
      try { start = new Date(t.started_at).toISOString(); end = new Date(t.ended_at).toISOString(); }
      catch (_e) { this._routes[id] = []; continue; }
      Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
        .then((res) => {
          const ser = Array.isArray(res) && res[0] ? res[0] : [];
          const pts = [];
          for (const x of ser) {
            const a = x.attributes || {};
            const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
            if (isNaN(lat) || isNaN(lon)) continue;
            const last = pts[pts.length - 1];
            if (!last || Math.abs(last.lat - lat) > 1e-6 || Math.abs(last.lon - lon) > 1e-6) pts.push({ lat, lon });
          }
          this._routes[id] = pts;
          this._render();
        })
        .catch(() => { this._routes[id] = []; this._render(); });
    }
  }
  // Stable cache key for the whole-journey route (first→last stage + count).
  _jrKey(stages) {
    if (!stages || !stages.length) return null;
    const a = stages[0], b = stages[stages.length - 1];
    const ida = a.id != null ? a.id : a.trip_id, idb = b.id != null ? b.id : b.trip_id;
    return `${ida}-${idb}-${stages.length}`;
  }
  // Fetch the GPS breadcrumbs for the WHOLE journey in one window (first stage
  // start → last stage end, or now if still en route) so the detail can draw a
  // single map of the entire day's route. Lazy, cached per journey key.
  _fetchJourneyRoute(stages) {
    this._jroute = this._jroute || {};
    const ent = this._config.locationEntity;
    if (!ent || !this._hass || !stages || !stages.length) return;
    const first = stages[0], last = stages[stages.length - 1];
    if (!first.started_at) return;
    const key = this._jrKey(stages);
    if (this._jroute[key] !== undefined) return;
    this._jroute[key] = "loading";
    let start, end;
    try {
      start = new Date(first.started_at).toISOString();
      end = (last.ended_at ? new Date(last.ended_at) : new Date()).toISOString();
    } catch (_e) { this._jroute[key] = []; return; }
    Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
      .then((res) => {
        const ser = Array.isArray(res) && res[0] ? res[0] : [];
        const pts = [];
        for (const x of ser) {
          const a = x.attributes || {};
          const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
          if (isNaN(lat) || isNaN(lon)) continue;
          const lp = pts[pts.length - 1];
          if (!lp || Math.abs(lp.lat - lat) > 1e-6 || Math.abs(lp.lon - lon) > 1e-6) pts.push({ lat, lon });
        }
        this._jroute[key] = pts;
        this._render();
      })
      .catch(() => { this._jroute[key] = []; this._render(); });
  }
  // Render the expandable list of stages (one rich block per sub-trip) + totals.
  _stagesHtml(stages) {
    if (!stages || !stages.length) return "";
    this._temps = this._temps || {};
    this._streets = this._streets || {};
    this._regen = this._regen || {};
    this._routes = this._routes || {};
    const DASH = "—";
    const f0 = (v) => (v == null || isNaN(v) ? DASH : Number(v).toFixed(0));
    const f1 = (v) => (v == null || isNaN(v) ? DASH : Number(v).toFixed(1));
    const f2 = (v) => (v == null || isNaN(v) ? DASH : Number(v).toFixed(2));
    const tod = (iso) => { const d = new Date(iso); return isNaN(d) ? DASH : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const sym = (c) => ({ EUR: "€", USD: "$", GBP: "£" }[c] || c || "€");
    const sum = (k) => stages.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const totCost = stages.some((x) => x.cost != null) ? sum("cost") : null;
    const totRegen = stages.some((x) => x.regen_kwh != null) ? sum("regen_kwh") : null;
    const totals = `<div class="jstotals">
        <b>${f0(sum("distance_km"))}</b> km · <b>${f1(sum("energy_kwh"))}</b> kWh${totCost != null ? ` · <b>${f2(totCost)} ${_esc(sym(stages.find((x) => x.currency) && stages.find((x) => x.currency).currency))}</b>` : ""}${totRegen ? ` · ↻ <b>${f1(totRegen)}</b> kWh regen` : ""} · ${stages.length} ${stages.length === 1 ? "stage" : "stages"}
      </div>`;
    const chip = (icon, label, value) => (value == null || value === "" ? "" : `<span class="jm"><ha-icon icon="${icon}"></ha-icon>${label ? `<span class="jm-l">${label}</span>` : ""}<b>${value}</b></span>`);
    const rows = stages
      .map((t, i) => {
        const id = t.id != null ? t.id : t.trip_id;
        const tp = this._temps[id];
        const tempVal = tp === "loading" ? "…" : tp && (tp.start != null || tp.end != null) ? `${tp.start != null ? f0(tp.start) : DASH}→${tp.end != null ? f0(tp.end) : DASH}°C` : null;
        // Prefer the GPS-derived location (zone or street) over the logger's
        // origin/dest; fall back to start_address/origin while it resolves.
        const sg = this._streets[id];
        const endPt = (key, zone, addr) =>
          sg && sg !== "loading" && sg[key] ? _esc(sg[key]) : _endpoint(addr, zone);
        const cons = t.consumption_kwh_100km != null && Number(t.consumption_kwh_100km) >= 0 ? _fmtEff(t.consumption_kwh_100km) : null;
        const soc = t.soc_start != null && t.soc_end != null ? `${f0(t.soc_start)}→${f0(t.soc_end)}%${t.soc_used_pct != null ? ` (${f0(t.soc_used_pct)})` : ""}` : null;
        const pill = t.score != null ? `<span class="js-pill" style="background:${_scoreColor(t.score)}">${f1(t.score)}</span>` : "";
        // Regen: logger value, else the integrated power estimate ("~").
        const rg = this._regen[id];
        const regenVal =
          t.regen_kwh != null && !isNaN(Number(t.regen_kwh)) ? `${f1(t.regen_kwh)} kWh`
          : rg === "loading" ? "…"
          : rg && rg.kwh != null ? `~${f1(rg.kwh)} kWh`
          : null;
        const metrics =
          chip("mdi:timer-outline", "", t.duration_min != null ? `${f0(t.duration_min)} min` : null) +
          chip("mdi:speedometer", "", t.avg_speed_kmh != null ? `${f0(t.avg_speed_kmh)} km/h` : null) +
          chip("mdi:lightning-bolt", "", t.energy_kwh != null ? `${f1(t.energy_kwh)} kWh` : null) +
          chip("mdi:chart-line", "", cons) +
          chip("mdi:battery", "", soc) +
          chip("mdi:cash", "", t.cost != null ? `${f2(t.cost)} ${sym(t.currency)}` : null) +
          chip("mdi:sync", "regen", regenVal) +
          chip("mdi:thermometer", "", tempVal) +
          chip("mdi:flash", "max", t.max_power_kw != null ? `${f0(t.max_power_kw)} kW` : null) +
          chip("mdi:speedometer-medium", "max", t.max_speed_kmh != null ? `${f0(t.max_speed_kmh)} km/h` : null);
        // Real driven route for this stage, from the GPS breadcrumbs.
        const rt = this._routes[id];
        let mapHtml = "";
        if (rt === "loading") mapHtml = `<div class="js-map js-map--ph">${L("Loading route…", "Cargando ruta…")}</div>`;
        else if (Array.isArray(rt) && rt.length >= 2) { const svg = _routeSvg(rt); if (svg) mapHtml = `<div class="js-map">${svg}</div>`; }
        return `<div class="jstage">
          <div class="jstage-head">
            <span class="js-n">${i + 1}</span>
            <span class="js-time">${_timeRange(t.started_at, t.ended_at) || tod(t.started_at)}</span>
            <span class="js-route">${endPt("start", t.origin, t.start_address)}<ha-icon icon="mdi:arrow-right"></ha-icon>${endPt("end", t.destination, t.end_address)}</span>
            ${pill}
          </div>
          <div class="jstage-metrics">${metrics}</div>
          ${mapHtml}
        </div>`;
      })
      .join("");
    // One map of the WHOLE day's route (all stages joined), above the stages.
    const jr = this._jroute ? this._jroute[this._jrKey(stages)] : undefined;
    let journeyMap = "";
    if (jr === "loading") journeyMap = `<div class="js-map js-map--all js-map--ph">${L("Loading the day's route…", "Cargando ruta del día…")}</div>`;
    else if (Array.isArray(jr) && jr.length >= 2) { const svg = _routeSvg(jr); if (svg) journeyMap = `<div class="js-map js-map--all">${svg}</div>`; }
    return `<div class="jstages-list">${totals}${journeyMap}${rows}</div>`;
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    if (!this._clickBound && typeof this.addEventListener === "function") this.connectedCallback();
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

    // Stages (sub-trips) of the journey being shown, for the expandable detail.
    let stages = [];
    // status colors / glyph / label
    let dotColor, badgeBg, icon, statusLabel, statusSub, a, stagesNum;
    if (inProgress) {
      const at = cur.attributes || {};
      dotColor = "var(--success-color, #43a047)";
      badgeBg = "rgba(67,160,71,.16)";
      icon = "mdi:road-variant";
      statusLabel = "🟢 En route";
      a = at;
      stagesNum = curStages;
      statusSub = "Left " + (at.started_at ? _fmtDate(at.started_at) : DASH) + " · en route";
      // The logger only closes a journey on a trip that ARRIVES home, so an
      // overnight home CHARGE (no →home trip logged) leaves the journey open and
      // it wrongly spans back to yesterday. Recompute today's run from
      // recent_trips: the stages since the car was last home (a →home trip OR a
      // home charge). This fixes the inflated "2 stages / started yesterday".
      const fix = this._correctedLiveJourney(D);
      if (fix) {
        a = { ...at, started_at: fix.started_at, distance_km: fix.distance_km, energy_kwh: fix.energy_kwh, cost: fix.cost };
        stagesNum = fix.stages;
        statusSub = "Left " + _fmtDate(fix.started_at) + " · en route";
        stages = fix.stagesList || [];
      } else {
        stages = this._journeyStagesById(D, at.journey_id);
      }
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
      stages = this._journeyStagesById(D, at.journey_id);
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

    if (this._open) { this._fetchStageTemps(stages); this._fetchStageStreets(stages); this._fetchStageRegen(stages); this._fetchStageRoute(stages); this._fetchJourneyRoute(stages); }
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
          .jhead.jclickable{cursor:pointer;}
          .jcaret{flex:0 0 auto;color:var(--secondary-text-color);transition:transform .15s ease;}
          .jcaret ha-icon{--mdc-icon-size:22px;}
          .jhead.jopen .jcaret{transform:rotate(180deg);}
          .jstages-list{display:flex;flex-direction:column;gap:10px;padding:6px 14px 14px;
                        border-top:1px solid var(--divider-color);margin-top:2px;}
          .jstotals{font-size:.85em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;padding-bottom:2px;}
          .jstotals b{color:var(--primary-text-color);}
          .jstage{display:flex;flex-direction:column;gap:6px;font-size:.85em;}
          .jstage + .jstage{border-top:1px dashed var(--divider-color);padding-top:10px;}
          .js-map{border-radius:10px;overflow:hidden;margin-top:2px;
                  border:1px solid var(--divider-color,rgba(0,0,0,.12));}
          .js-map--ph{height:150px;display:flex;align-items:center;justify-content:center;
                      color:var(--secondary-text-color);font-size:.9em;background:var(--secondary-background-color);}
          .js-map--all{margin-bottom:4px;}
          .js-map--all .cal-rt-svg{height:200px;}
          .js-map--all.js-map--ph{height:200px;}
          .cal-rt-svg{display:block;width:100%;height:150px;}
          .cal-rt-bg{fill:var(--secondary-background-color,#e8eaed);}
          .cal-rt-svg image{image-rendering:auto;}
          .cal-rt-halo{fill:none;stroke:#fff;stroke-width:5;stroke-linejoin:round;stroke-linecap:round;opacity:.8;}
          .cal-rt-line{fill:none;stroke:#1565c0;stroke-width:3;stroke-linejoin:round;stroke-linecap:round;}
          .cal-rt-start{fill:var(--success-color,#43a047);stroke:#fff;stroke-width:1.5;}
          .cal-rt-end{fill:var(--error-color,#e53935);stroke:#fff;stroke-width:1.5;}
          .cal-rt-attr{fill:#000;opacity:.5;font-size:7px;text-anchor:end;paint-order:stroke;stroke:#fff;stroke-width:2;}
          .jstage-head{display:flex;align-items:center;gap:8px;}
          .js-n{flex:0 0 auto;width:18px;height:18px;border-radius:50%;background:var(--secondary-background-color,var(--divider-color));
                color:var(--secondary-text-color);font-size:.72em;font-weight:700;display:flex;align-items:center;justify-content:center;}
          .js-time{flex:0 0 auto;font-weight:700;font-variant-numeric:tabular-nums;color:var(--primary-text-color);}
          .js-route{flex:1 1 auto;display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
          .js-route ha-icon{--mdc-icon-size:13px;color:var(--secondary-text-color);flex:0 0 auto;}
          .js-pill{flex:0 0 auto;min-width:26px;text-align:center;padding:1px 6px;border-radius:999px;color:#fff;
                   font-weight:800;font-size:.78em;font-variant-numeric:tabular-nums;}
          .jstage-metrics{display:flex;flex-wrap:wrap;gap:6px;}
          .jm{display:inline-flex;align-items:center;gap:4px;background:var(--secondary-background-color,var(--card-background-color));
              border:1px solid var(--divider-color);border-radius:8px;padding:3px 8px;font-size:.92em;
              color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .jm ha-icon{--mdc-icon-size:14px;}
          .jm-l{text-transform:uppercase;font-size:.82em;letter-spacing:.03em;}
          .jm b{color:var(--primary-text-color);font-weight:700;}
        </style>
        <div class="jhead${stages.length ? " jclickable" : ""}${this._open ? " jopen" : ""}">
          <div class="jbadge"><ha-icon icon="${icon}"></ha-icon></div>
          <div class="jhead-body">
            <div class="jtitle">${_esc(this._config.title || "Journey")}</div>
            <div class="jstatus">
              <span class="jchip"><span class="jdot"></span>${_esc(statusLabel)}</span>
              ${chargeChip}
              <span class="jsub">${_esc(stageStr)} · ${_esc(statusSub)}</span>
            </div>
          </div>
          ${stages.length ? `<div class="jcaret"><ha-icon icon="mdi:chevron-down"></ha-icon></div>` : ""}
        </div>
        <div class="jtiles">
          ${tile("mdi:map-marker-distance", "Distance", fmtNum(a.distance_km), "km")}
          ${tile("mdi:lightning-bolt", "Energy", fmtNum(a.energy_kwh), "kWh")}
          ${tile("mdi:currency-eur", "Cost", fmtNum(a.cost, a.cost != null ? 2 : undefined), "€")}
        </div>
        ${this._open ? this._stagesHtml(stages) : ""}
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
  connectedCallback() {
    if (this._effBound) return;
    this._effBound = true;
    this._onEffUnit = () => this._render();
    window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
  }
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
  }
  set hass(hass) {
    this._hass = hass;
    const D = this._device || detectDevice(hass);
    const sig = _sig(hass, [`sensor.${D}_monthly_history`]);
    if (sig === this._monthlySig) return;
    this._monthlySig = sig;
    this._render();
  }
  getCardSize() {
    return 4;
  }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = this._hass.states[`sensor.${D}_monthly_history`];
    const months = (st && st.attributes && Array.isArray(st.attributes.months) && st.attributes.months) || [];
    // monthly_history carries no currency — derive it from the trip/charge data.
    const sym = _deviceCurrency(this._hass, D);

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
        const effE = km > 0 ? _fmtEffVal((kwh / km) * 100) : { value: "—", unit: _effUnitLabel() };
        return `
          <div class="mh-row">
            <div class="mh-month">${_esc(_fmtMonth(m.month))}</div>
            <div class="mh-track"><div class="mh-fill" style="width:${pct}%"></div></div>
            <div class="mh-vals"><b>${km.toFixed(0)}</b> km · ${kwh.toFixed(1)} kWh · ${cost.toFixed(2)} ${_esc(sym)} · <span class="mh-eff">${effE.value}</span> ${_esc(effE.unit)}</div>
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
    const D = this._device || detectDevice(hass);
    const sig = _sig(hass, [`sensor.${D}_trip_patterns`]);
    if (sig === this._patternsSig) return;
    this._patternsSig = sig;
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

    // At-a-glance insights derived from the same data.
    const argmax = (o, n) => Array.from({ length: n }, (_, i) => [i, Number(o[String(i)]) || 0]).reduce((m, c) => (c[1] > m[1] ? c : m), [0, -1]);
    const peakH = argmax(byHour, 24), peakW = argmax(byWd, 7), kmLead = argmax(kmWd, 7);
    const insights =
      `<span class="tp-ins"><ha-icon icon="mdi:clock-outline"></ha-icon>Busiest <b>${peakH[0]}:00</b></span>` +
      (peakW[1] > 0 ? `<span class="tp-ins"><ha-icon icon="mdi:calendar-star"></ha-icon>Most trips <b>${_WD_ABBR[peakW[0]]}</b></span>` : "") +
      (kmLead[1] > 0 ? `<span class="tp-ins"><ha-icon icon="mdi:map-marker-distance"></ha-icon>Most km <b>${_WD_ABBR[kmLead[0]]}</b></span>` : "");

    this.innerHTML = `
      <ha-card>
        <div class="tp-head">Driving patterns <span class="tp-tot">${total} trips · ${winDays} d</span></div>
        <div class="tp-insights">${insights}</div>
        <div class="tp-section">By hour of day</div>
        <div class="tp-hours">${hourBars}</div>
        <div class="tp-section">By weekday <span class="tp-legend">km · trips</span></div>
        <div class="tp-week">${wdCells}</div>
        <style>
          .tp-head{display:flex;justify-content:space-between;align-items:baseline;
                   padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
          .tp-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;}
          .tp-insights{display:flex;flex-wrap:wrap;gap:6px;padding:2px 14px 6px;}
          .tp-ins{display:inline-flex;align-items:center;gap:4px;font-size:.8em;
                  background:var(--secondary-background-color,var(--card-background-color));
                  border:1px solid var(--divider-color);border-radius:999px;padding:3px 10px;}
          .tp-ins ha-icon{--mdc-icon-size:15px;color:var(--secondary-text-color);}
          .tp-ins b{font-weight:700;}
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
    // Rolling week-over-week: last 7 days vs the 7 before them.
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const last7 = sum(vals.slice(-7)), prev7 = sum(vals.slice(-14, -7));
    let wow = "";
    if (vals.length >= 14) {
      const pct = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : null;
      const up = last7 > prev7, flat = last7 === prev7;
      const arrow = flat ? "→" : up ? "▲" : "▼";
      const cls = flat ? "dk-flat" : up ? "dk-up" : "dk-down";
      wow = `<span class="dk-wow"><b>${last7.toFixed(0)} km</b> last 7d <span class="${cls}">${arrow}${pct == null ? "" : ` ${pct > 0 ? "+" : ""}${pct}%`}</span> vs prev</span>`;
    }
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
        ${wow ? `<div class="dk-wowrow">${wow}</div>` : ""}
        <div class="dk-chart">${bars}</div>
        <style>
          .dk-head{display:flex;justify-content:space-between;align-items:baseline;
                   padding:14px 16px 8px;font-weight:600;font-size:1.05em;flex-wrap:wrap;gap:4px;}
          .dk-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;
                  font-variant-numeric:tabular-nums;}
          .dk-wowrow{padding:0 16px 8px;}
          .dk-wow{font-size:.82em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .dk-wow b{color:var(--primary-text-color);}
          .dk-up{color:var(--info-color,#039be5);font-weight:700;}
          .dk-down{color:var(--secondary-text-color);font-weight:700;}
          .dk-flat{color:var(--secondary-text-color);font-weight:700;}
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
// Custom card: ENERGY CONSUMED (kWh) per day / month / year — one card with a
// Day·Month·Year toggle, drawn as reliable HTML bars (apex can't plot derived
// attribute arrays). Day = recent_trips summed by local date (last 21 days);
// Month/Year = monthly_history.months[] (Year rolled up by calendar year).
// Pure kWh consumption + km/cost subline — no efficiency here (it lives per
// charge in the Charges view). The current bucket is highlighted; a dashed line
// marks the average. Period choice persists in localStorage.
// ==========================================================================
class EvTripConsumptionCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
    try { const m = localStorage.getItem("evTripConsPeriod"); this._period = ["day", "week", "month", "year"].includes(m) ? m : "month"; }
    catch (_e) { this._period = "month"; }
  }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 4; }
  connectedCallback() {
    if (this._bound) return;
    this._bound = true;
    this.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest(".cc-btn[data-m]");
      if (b && this.contains(b)) {
        this._period = b.getAttribute("data-m");
        try { localStorage.setItem("evTripConsPeriod", this._period); } catch (_e) {}
        this._render();
      }
    });
  }
  // Build the bar series for the active period from the logger sensors.
  _series(D) {
    if (this._period === "month" || this._period === "year") {
      const months = ((this._hass.states[`sensor.${D}_monthly_history`] || {}).attributes || {}).months;
      if (!Array.isArray(months) || !months.length) return null;
      if (this._period === "month") {
        return months.map((m) => ({ label: _fmtMonth(m.month), kwh: Number(m.energy_kwh) || 0, km: Number(m.distance_km) || 0, cost: Number(m.cost) || 0 }));
      }
      const byY = {};
      for (const m of months) {
        const y = String(m.month || "").slice(0, 4); if (!y) continue;
        const e = byY[y] || (byY[y] = { kwh: 0, km: 0, cost: 0 });
        e.kwh += Number(m.energy_kwh) || 0; e.km += Number(m.distance_km) || 0; e.cost += Number(m.cost) || 0;
      }
      return Object.keys(byY).sort().map((y) => ({ label: y, ...byY[y] }));
    }
    // Week: sum recent_trips by ISO week (Monday-start), zero-filled from the
    // earliest week with data up to the current week (capped at 16). Note this
    // only spans what the recent_trips rolling window covers (~last weeks); the
    // logger has no weekly_history sensor. The dashed line = the weekly average.
    if (this._period === "week") {
      const trips = ((this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {}).trips || [];
      const wkStart = (iso) => { const x = new Date(iso); if (isNaN(x)) return null; x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
      const byW = {}; let earliest = null;
      for (const t of trips) {
        const ws = wkStart(t.started_at || t.ended_at); if (!ws) continue;
        const k = _localDateKey(ws.toISOString());
        const e = byW[k] || (byW[k] = { kwh: 0, km: 0, cost: 0 });
        e.kwh += Number(t.energy_kwh) || 0; e.km += Number(t.distance_km) || 0; e.cost += Number(t.cost) || 0;
        if (!earliest || ws < earliest) earliest = ws;
      }
      if (!earliest) return [];
      const cur = wkStart(new Date().toISOString());
      const minStart = new Date(cur); minStart.setDate(minStart.getDate() - 15 * 7);
      if (earliest < minStart) earliest = minStart;
      const p = (n) => String(n).padStart(2, "0");
      const out = [];
      for (const w = new Date(earliest); w <= cur; w.setDate(w.getDate() + 7)) {
        const e = byW[_localDateKey(w.toISOString())] || { kwh: 0, km: 0, cost: 0 };
        out.push({ label: `${p(w.getDate())}/${p(w.getMonth() + 1)}`, kwh: e.kwh, km: e.km, cost: e.cost });
      }
      return out;
    }
    // Day: sum recent_trips by local date, zero-filled over the last 21 days.
    const trips = ((this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {}).trips || [];
    const byD = {};
    for (const t of trips) {
      const k = _localDateKey(t.started_at || t.ended_at); if (!k) continue;
      const e = byD[k] || (byD[k] = { kwh: 0, km: 0, cost: 0 });
      e.kwh += Number(t.energy_kwh) || 0; e.km += Number(t.distance_km) || 0; e.cost += Number(t.cost) || 0;
    }
    const out = [];
    const now = new Date();
    for (let i = 20; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = _localDateKey(d.toISOString());
      const e = byD[k] || { kwh: 0, km: 0, cost: 0 };
      out.push({ label: String(d.getDate()), kwh: e.kwh, km: e.km, cost: e.cost });
    }
    return out;
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    if (!this._bound && typeof this.addEventListener === "function") this.connectedCallback();
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const sym = _deviceCurrency(this._hass, D);
    const f0 = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(0));
    const f1 = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(1));
    const seg = [["day", L("Day", "Día")], ["week", L("Week", "Semana")], ["month", L("Month", "Mes")], ["year", L("Year", "Año")]]
      .map(([m, lbl]) => `<button class="cc-btn${m === this._period ? " on" : ""}" data-m="${m}">${lbl}</button>`).join("");
    const head = `<div class="cc-head"><span>${L("Consumption", "Consumo")}</span><div class="cc-seg">${seg}</div></div>`;
    const css = `
      .cc-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
      .cc-seg{display:inline-flex;gap:2px;background:var(--secondary-background-color,rgba(0,0,0,.06));border:1px solid var(--divider-color);border-radius:999px;padding:2px;}
      .cc-btn{cursor:pointer;border:0;background:transparent;color:var(--secondary-text-color);font-weight:700;font-size:.72em;padding:4px 10px;border-radius:999px;}
      .cc-btn.on{background:var(--primary-color);color:var(--text-primary-color,#fff);}
      .cc-hero{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:2px 16px 2px;}
      .cc-num{font-size:2em;font-weight:800;color:var(--primary-text-color);font-variant-numeric:tabular-nums;}
      .cc-unit{font-size:.9em;color:var(--secondary-text-color);}
      .cc-sub{padding:2px 16px 8px;font-size:.85em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
      .cc-chart{display:flex;align-items:flex-end;gap:2px;height:104px;padding:0 14px 22px;position:relative;}
      .cc-bar{flex:1 1 0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;position:relative;}
      .cc-fill{width:78%;min-height:1px;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--info-color,#039be5),var(--primary-color));opacity:.85;}
      .cc-bar.cc-cur .cc-fill{opacity:1;background:linear-gradient(180deg,var(--success-color,#43a047),var(--primary-color));}
      .cc-lbl{position:absolute;bottom:-18px;font-size:.68em;white-space:nowrap;color:var(--primary-text-color);opacity:.75;font-variant-numeric:tabular-nums;}
      .cc-avg{position:absolute;left:14px;right:14px;border-top:1px dashed var(--secondary-text-color);opacity:.5;}
      .cc-avglbl{position:absolute;right:14px;font-size:.64em;font-weight:700;color:var(--primary-text-color);transform:translateY(-50%);
                 background:var(--card-background-color,var(--ha-card-background));padding:0 4px;border-radius:4px;}
      .cc-empty{padding:10px 16px 22px;color:var(--secondary-text-color);}`;
    const bars = this._series(D);
    if (!bars || !bars.length) {
      this.innerHTML = `<ha-card>${head}<div class="cc-empty">${L("No consumption data yet for this period.", "Aún sin datos de consumo para este periodo.")}</div><style>${css}</style></ha-card>`;
      return;
    }
    const maxV = Math.max(...bars.map((b) => b.kwh), 0.001);
    const nonzero = bars.filter((b) => b.kwh > 0);
    const avg = nonzero.length ? nonzero.reduce((a, b) => a + b.kwh, 0) / nonzero.length : 0;
    const lblIdx = new Set([0, Math.floor(bars.length / 2), bars.length - 1]);
    const barsHtml = bars.map((b, i) => {
      const pct = Math.round((b.kwh / maxV) * 100);
      const cur = i === bars.length - 1;
      const lbl = lblIdx.has(i) ? `<div class="cc-lbl">${_esc(b.label)}</div>` : "";
      const tip = `${_esc(b.label)} — ${f1(b.kwh)} kWh${b.km ? ` · ${f0(b.km)} km` : ""}`;
      return `<div class="cc-bar${cur ? " cc-cur" : ""}" title="${tip}"><div class="cc-fill" style="height:${pct}%"></div>${lbl}</div>`;
    }).join("");
    const avgPct = Math.round((avg / maxV) * 100);
    const avgLine = avg > 0 ? `<div class="cc-avg" style="bottom:${22 + (avgPct / 100) * (104 - 22)}px"></div><div class="cc-avglbl" style="bottom:${22 + (avgPct / 100) * (104 - 22)}px">${L("avg", "media")} ${f1(avg)}</div>` : "";
    // Headline: Day → window total + per-active-day; Month/Year → current bucket.
    let heroNum, heroSub;
    if (this._period === "day") {
      const tot = bars.reduce((a, b) => a + b.kwh, 0);
      heroNum = f1(tot);
      heroSub = `${L("last 21 days", "últimos 21 días")} · ${nonzero.length} ${L("active days", "días activos")} · ${f1(avg)} kWh/${L("day", "día")}`;
    } else if (this._period === "week") {
      const cur = bars[bars.length - 1];
      heroNum = f1(cur.kwh);
      heroSub = `${L("this week", "esta semana")}${cur.km ? ` · ${f0(cur.km)} km` : ""} · ${nonzero.length} ${L("active weeks", "semanas activas")} · ${f1(avg)} kWh/${L("wk", "sem")}`;
    } else {
      const cur = bars[bars.length - 1];
      heroNum = f1(cur.kwh);
      heroSub = `${_esc(cur.label)}${cur.km ? ` · ${f0(cur.km)} km` : ""}${cur.cost ? ` · ${f1(cur.cost)} ${_esc(sym)}` : ""}`;
    }
    this.innerHTML = `<ha-card>
      ${head}
      <div class="cc-hero"><span class="cc-num">${heroNum}</span><span class="cc-unit">kWh</span></div>
      <div class="cc-sub">${heroSub}</div>
      <div class="cc-chart">${barsHtml}${avgLine}</div>
      <style>${css}</style>
    </ha-card>`;
  }
}
customElements.define("ev-trip-consumption-card", EvTripConsumptionCard);
window.customCards.push({ type: "ev-trip-consumption-card", name: "EV Trip — consumption (day/month/year)", description: "Energy consumed (kWh) per day, month or year with a period toggle." });

// ==========================================================================
// Custom card: charger vs battery vs driving, as big icon tiles, per
// week/month/year so the periods are easy to compare. Charger/battery come
// from the byd_charge_analytics package sensors; driving (energy consumed) is
// derived — week from recent_trips (current calendar week), month from
// sensor.<D>_energy_this_month, year from monthly_history. Only rendered when
// the package's charger sensor exists.
// ==========================================================================
class EvChargeSummaryCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 6; }
  _num(id) { const s = this._hass.states[id]; const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; }
  _starts() {
    const now = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(today.getDate() - ((now.getDay() + 6) % 7)); // Monday
    return { today, week, month: new Date(now.getFullYear(), now.getMonth(), 1), year: new Date(now.getFullYear(), 0, 1) };
  }
  // Window aggregate from recent_charges since `start`. battery = Σ kwh (DC into
  // the pack); evse = Σ evse_energy_kwh over EVSE-metered charges (AC); matchBat
  // = Σ kwh over ONLY those same metered charges, so efficiency divides
  // like-for-like (avoids the 290/43 → 674% bug from mixing the full battery
  // sum with a partial AC sum). batKwh is null when no charge matched (so an
  // empty period renders "—", not "0.0").
  _chargeAgg(D, start) {
    const ch = ((this._hass.states[`sensor.${D}_recent_charges`] || {}).attributes || {}).charges || [];
    let batKwh = 0, n = 0, evseKwh = 0, matchBat = 0, evseAny = false;
    for (const c of ch) {
      const d = new Date(c.ended_at || c.started_at); if (isNaN(d) || d < start) continue;
      const e = Number(c.kwh); if (!isNaN(e)) { batKwh += e; n++; }
      const ev = Number(c.evse_energy_kwh); if (!isNaN(ev) && ev > 0) { evseKwh += ev; if (!isNaN(e)) matchBat += e; evseAny = true; }
    }
    return { batKwh: n ? batKwh : null, n, evseKwh: evseAny ? evseKwh : null, eff: evseAny && evseKwh > 0 ? (matchBat / evseKwh) * 100 : null };
  }
  // Driving energy (kWh) from recent_trips since `start`. Skips odometer-only
  // noise (`orphan_odo_only`) and sub-1km blips so a stray micro-trip can't
  // inflate the total. Used for today/week (month/year use logger sensors).
  _drivingTrips(D, start) {
    const trips = ((this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {}).trips || [];
    let kwh = 0, any = false;
    for (const t of trips) {
      const d = new Date(t.started_at || t.ended_at); if (isNaN(d) || d < start) continue;
      if (t.confidence === "orphan_odo_only") continue;
      if ((Number(t.distance_km) || 0) < 1) continue;
      const e = Number(t.energy_kwh); if (!isNaN(e)) { kwh += e; any = true; }
    }
    return any ? kwh : null;
  }
  _drivingYear(D) {
    const months = ((this._hass.states[`sensor.${D}_monthly_history`] || {}).attributes || {}).months;
    if (!Array.isArray(months)) return null;
    const y = String(new Date().getFullYear()); let kwh = 0, any = false;
    for (const m of months) { if (String(m.month || "").slice(0, 4) === y) { const e = Number(m.energy_kwh); if (!isNaN(e)) { kwh += e; any = true; } } }
    return any ? kwh : null;
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    const D = this._device || detectDevice(this._hass); this._device = D;
    const f1 = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(1));
    const s = this._starts();
    // Resolve the four tiles for one period. Month/year read the logger's
    // authoritative period sensors (the rolling recent_charges window can't
    // represent a whole month/year — it caps at ~28 entries). Today/week have
    // no per-day/week logger sensor, so they use the window. From-charger (AC)
    // is DERIVED as battery ÷ efficiency so it stays physically consistent
    // (AC ≥ DC) — the measured grid_* value is partial while only some charges
    // are EVSE-metered, which otherwise reads as charger << battery.
    const resolve = (kind, start) => {
      const w = this._chargeAgg(D, start);
      let bat = w.batKwh, eff = w.eff, n = w.n, drv;
      if (kind === "month") {
        bat = this._num(`sensor.${D}_energy_charged_this_month`) ?? bat;
        eff = this._num(`sensor.${D}_avg_charging_efficiency_this_month`) ?? eff;
        n = this._num(`sensor.${D}_charges_this_month`) ?? n;
        drv = this._num(`sensor.${D}_energy_this_month`) ?? this._drivingTrips(D, start);
      } else if (kind === "year") {
        bat = this._num(`sensor.${D}_battery_energy_charged_this_year`) ?? this._num(`sensor.${D}_battery_energy_charged_lifetime`) ?? bat;
        eff = this._num(`sensor.${D}_avg_charging_efficiency_this_year`) ?? eff;
        drv = this._drivingYear(D) ?? this._drivingTrips(D, start);
      } else {
        drv = this._drivingTrips(D, start);
      }
      const chg = eff != null && eff > 0 && bat != null ? bat / (eff / 100) : null;
      return { bat, chg, eff, n, drv };
    };
    const periods = [
      { label: L("Today", "Hoy"), kind: "today", start: s.today },
      { label: L("This week", "Esta semana"), kind: "week", start: s.week },
      { label: L("This month", "Este mes"), kind: "month", start: s.month },
      { label: L("This year", "Este año"), kind: "year", start: s.year },
    ];
    const tile = (icon, clr, lbl, val, sub) =>
      `<div class="cv-tile"><ha-icon icon="${icon}" style="color:${clr}"></ha-icon><div class="cv-lbl">${lbl}</div><div class="cv-val">${val}<span class="cv-u"> kWh</span></div>${sub ? `<div class="cv-sub">${sub}</div>` : ""}</div>`;
    const rows = periods.map((p) => {
      const r = resolve(p.kind, p.start);
      const nSub = r.n ? `${r.n} ${L(r.n === 1 ? "charge" : "charges", r.n === 1 ? "carga" : "cargas")}` : L("no charges", "sin cargas");
      const effSub = r.eff != null ? `${r.eff.toFixed(0)}% eff` : (r.n ? L("needs EVSE", "falta EVSE") : "");
      return `
        <div class="cv-period">${_esc(p.label)}</div>
        <div class="cv-grid">
          ${tile("mdi:ev-station", "var(--info-color,#039be5)", L("From charger", "Del cargador"), f1(r.chg), effSub)}
          ${tile("mdi:car-battery", "var(--success-color,#43a047)", L("To battery", "A batería"), f1(r.bat), nSub)}
          ${tile("mdi:car-electric", "var(--error-color,#e53935)", L("Driving", "Conducción"), f1(r.drv), "")}
        </div>`;
    }).join("");
    this.innerHTML = `<ha-card>
      <div class="cv-head"><ha-icon icon="mdi:transmission-tower"></ha-icon>${L("Charger · battery · driving", "Cargador · batería · conducción")}</div>
      ${rows}
      <style>
        .cv-head{display:flex;align-items:center;gap:7px;padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
        .cv-head ha-icon{--mdc-icon-size:20px;color:var(--primary-color);}
        .cv-period{padding:10px 16px 2px;font-size:.78em;font-weight:700;letter-spacing:.04em;
                   text-transform:uppercase;color:var(--secondary-text-color);}
        .cv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 12px 4px;}
        .cv-tile{display:flex;flex-direction:column;align-items:center;text-align:center;gap:3px;
                 background:var(--secondary-background-color,var(--card-background-color));
                 border:1px solid var(--divider-color);border-radius:14px;padding:12px 6px;}
        .cv-tile ha-icon{--mdc-icon-size:26px;}
        .cv-lbl{font-size:.72em;color:var(--secondary-text-color);line-height:1.1;}
        .cv-val{font-size:1.25em;font-weight:800;color:var(--primary-text-color);font-variant-numeric:tabular-nums;}
        .cv-u{font-size:.5em;font-weight:600;color:var(--secondary-text-color);}
        .cv-sub{font-size:.66em;color:var(--secondary-text-color);}
      </style>
    </ha-card>`;
  }
}
customElements.define("ev-charge-summary-card", EvChargeSummaryCard);
window.customCards.push({ type: "ev-charge-summary-card", name: "EV Trip — charged vs driving", description: "Real charged (recent_charges) vs driving kWh as icon tiles, per today/week/month/year." });

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
const _endpoint = (addr, fallback) => {
  const v = addr || fallback || "?";
  const z = String(v).trim().toLowerCase();
  if (z === "not_home" || z === "outside known zones") return "Away"; // raw label → human
  if (z === "home") return "Home";
  return _esc(v);
};
// HA zone/area name for a trip endpoint, or null when the car was OUTSIDE any
// zone (`not_home`/empty) — in which case the caller should reverse-geocode the
// street. `home` and named zones (e.g. "Trabajo ele") return the area name.
const _zoneLabel = (zone) => {
  const z = String(zone == null ? "" : zone).trim();
  const lz = z.toLowerCase();
  // not_home / "Outside known zones" / unknown all mean "no named place" — the
  // caller should fall back to the trip's GPS (street) instead.
  if (!z || lz === "not_home" || lz === "outside known zones" || lz === "unknown") return null;
  if (lz === "home") return "Home";
  return z;
};
// ---- Efficiency unit (user-toggleable, persisted in localStorage) ----------
// The logger stores efficiency as kWh/100km; the user can cycle the DISPLAY
// unit with a chip. The choice is global (one localStorage key) and a window
// event re-renders every custom card so they stay in sync. Markdown/chart
// cards can't react to this, so they keep the canonical kWh/100km.
const EFF_UNITS = ["kwh100", "wh_km", "km_kwh"];
let _effUnit = (() => {
  try { const u = localStorage.getItem("evTripEffUnit"); return EFF_UNITS.includes(u) ? u : "kwh100"; }
  catch (_e) { return "kwh100"; }
})();
const _effUnitLabel = (u) => ({ kwh100: "kWh/100km", wh_km: "Wh/km", km_kwh: "km/kWh" }[u || _effUnit] || "kWh/100km");
const _cycleEffUnit = () => {
  _effUnit = EFF_UNITS[(EFF_UNITS.indexOf(_effUnit) + 1) % EFF_UNITS.length];
  try { localStorage.setItem("evTripEffUnit", _effUnit); } catch (_e) {}
  try { window.dispatchEvent(new CustomEvent("ev-trip-eff-unit")); } catch (_e) {}
};
// Convert a kWh/100km value to the active unit → { value, unit }.
const _fmtEffVal = (v100) => {
  const n = Number(v100);
  if (v100 == null || isNaN(n)) return { value: "—", unit: _effUnitLabel() };
  if (_effUnit === "wh_km") return { value: (n * 10).toFixed(0), unit: "Wh/km" };
  if (_effUnit === "km_kwh") return { value: n > 0 ? (100 / n).toFixed(1) : "—", unit: "km/kWh" };
  return { value: n.toFixed(1), unit: "kWh/100km" };
};
// One-shot "12.3 kWh/100km" style string in the active unit.
const _fmtEff = (v100) => { const e = _fmtEffVal(v100); return e.value === "—" ? "—" : `${e.value} ${e.unit}`; };
// ---- UI language (follows the installed HA language; English by default) ----
// Most of the dashboard is English; these helpers let the newer custom cards
// render in the HA language when it's Spanish, and English otherwise.
let _uiLang = "en";
const _setUiLang = (hass) => {
  try { _uiLang = String((hass && hass.language) || "en").slice(0, 2).toLowerCase(); }
  catch (_e) { _uiLang = "en"; }
};
const L = (en, es) => (_uiLang === "es" && es != null ? es : en);
// Resolve a logger sensor for device D by a SIGNATURE attribute, tolerating
// collided entity_ids — HA assigns `sensor.<D>_2`, `_3`… fallback object_ids
// when a translation_key isn't ready at first registration (happened to the
// v0.5.54 season/time/SoH sensors). Prefers the canonical id, else scans this
// device's sensors for the one carrying `attr`. Returns the state object|null.
const _findSensorByAttr = (hass, D, canonicalKey, attr) => {
  if (!hass) return null;
  const canon = hass.states[`sensor.${D}_${canonicalKey}`];
  if (canon && canon.attributes && attr in canon.attributes) return canon;
  const prefix = `sensor.${D}`;
  for (const id in hass.states) {
    if (id.indexOf(prefix) !== 0) continue;
    const a = hass.states[id].attributes;
    if (a && Object.prototype.hasOwnProperty.call(a, attr)) return hass.states[id];
  }
  return canon || null;
};
// A logger-provided address string that is actually usable (a real street),
// or null for the placeholders the logger emits when it couldn't resolve one.
const _cleanAddr = (a) => {
  const s = String(a == null ? "" : a).trim();
  const l = s.toLowerCase();
  if (!s || ["none", "null", "unknown", "not_home", "home", "outside known zones"].includes(l)) return null;
  return s;
};
// Great-circle distance in metres between two lat/lon points.
const _haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
// Friendly name of the smallest HA zone that contains (lat,lon), or null when
// the point is outside every zone. Lets us label a trip/charge endpoint by its
// ACTUAL GPS position rather than trusting the logger's origin/destination
// field (which is often "home" even when the trip started elsewhere).
const _zoneForPoint = (hass, lat, lon) => {
  if (!hass || lat == null || lon == null || isNaN(lat) || isNaN(lon)) return null;
  let best = null, bestR = Infinity;
  for (const id in hass.states) {
    if (id.indexOf("zone.") !== 0) continue;
    const a = hass.states[id].attributes || {};
    const zlat = parseFloat(a.latitude), zlon = parseFloat(a.longitude), r = parseFloat(a.radius);
    if (isNaN(zlat) || isNaN(zlon) || isNaN(r)) continue;
    if (_haversine(lat, lon, zlat, zlon) <= r && r < bestR) {
      best = a.friendly_name || id.slice(5);
      bestR = r;
    }
  }
  return best;
};
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
  // Degenerate route (car never really moved / GPS pinned to one spot): a span
  // below ~40 m would max-zoom around a single point and render a pointless
  // map — let the caller show the "No GPS for this trip" placeholder instead.
  if (Math.max(xMax - xMin, yMax - yMin) < 1e-6) return "";
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
    <rect x="0" y="0" width="${VB_W}" height="${VB_H}" class="cal-rt-bg"/>
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
    if (!this._effBound) {
      this._effBound = true;
      this._onEffUnit = () => this._render();
      window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
    }
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
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
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
      // File a charge on the day it ENDED (matches the charge-history list and
      // the user's "today's charge" intuition). Overnight / multi-day sessions
      // would otherwise land on the start day and vanish from the day it
      // actually completed.
      const k = _localDateKey(ch.ended_at || ch.started_at);
      if (!k) continue;
      const e = ensure(k);
      e.charges.push(ch);
      e.kwh += Number(ch.kwh) || 0;
    }
    return map;
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
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
      // Record route windows so _fetchOpenDayRoutes can pull each journey's
      // GPS track. A journey is fetched PER STAGE (one sub-window per leg) and
      // the legs are concatenated — fetching the whole journey span would drag
      // the polyline across the parked gap between stages (e.g. overnight).
      this._openGroups = groups
        .map((g) => ({ key: `${g.started_at}|${g.ended_at}`, windows: g.stages.map((t) => ({ start: t.started_at, end: t.ended_at })) }))
        .concat(standalone.map((t) => ({ key: `${t.started_at}|${t.ended_at}`, windows: [{ start: t.started_at, end: t.ended_at }] })));

      const stage = (t) => `
        <div class="cal-stage">
          <span class="cal-stime">${_timeRange(t.started_at, t.ended_at) || _timeOfDay(t.started_at)}</span>
          <span class="cal-sroute">${_endpoint(t.start_address, t.origin)}<ha-icon class="cal-arr" icon="mdi:arrow-right"></ha-icon>${_endpoint(t.end_address, t.destination)}</span>
          <span class="cal-smeta">${f0(t.distance_km)} km · ${t.consumption_kwh_100km != null && Number(t.consumption_kwh_100km) >= 0 ? _fmtEff(t.consumption_kwh_100km) : "—"}</span>
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
          <div class="cal-jsum"><b>${f0(g.km)}</b> km · <b>${f1(g.kwh)}</b> kWh${g.cons != null ? ` · <b>${_fmtEff(g.cons)}</b>` : ""}${g.cost ? ` · <b>${g.cost.toFixed(2)} ${_esc(sym(g.currency))}</b>` : ""} · ${g.stages.length} ${g.stages.length === 1 ? "stage" : "stages"}</div>
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
          .cal-rt-bg{fill:var(--secondary-background-color,#e8eaed);}
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
    // Fetch one device_tracker history window and return its de-duplicated
    // lat/lon breadcrumb. NOTE: need attributes (lat/lon) so do NOT use
    // minimal_response/no_attributes.
    const fetchWin = (win) => {
      let start, end;
      try {
        start = new Date(new Date(win.start).getTime() - 60000).toISOString();
        end = new Date(new Date(win.end).getTime() + 60000).toISOString();
      } catch (_e) { return Promise.resolve([]); }
      return Promise.resolve(this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${ent}&significant_changes_only=0`))
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
          return pts;
        })
        .catch(() => []);
    };
    for (const w of this._openGroups) {
      if (this._routes[w.key] !== undefined) continue; // cached/loading
      this._routes[w.key] = "loading";
      const wins = Array.isArray(w.windows) ? w.windows : [];
      // Fetch every leg, then concatenate in chronological order (skips the
      // stationary gaps between stages entirely).
      Promise.all(wins.map(fetchWin))
        .then((legs) => {
          const pts = [];
          for (const leg of legs) for (const p of leg) {
            const last = pts[pts.length - 1];
            if (!last || last.lat !== p.lat || last.lon !== p.lon) pts.push(p);
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
        e: Number(t.energy_kwh),
        s: t.score == null ? null : Number(t.score),
      }))
      .filter((p) => !isNaN(p.x) && !isNaN(p.y) && p.x > 0 && p.y >= 0 && !(p.e < 0));

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

    // Dashed line = the authoritative 30-day average (the same number shown in
    // the hero), so the two never disagree. The logger's `avg_consumption_30_days`
    // is a true 30-DAY window; recomputing here over `recent_trips` would be the
    // last-N-TRIPS window instead (a different population), which is why the old
    // self-computed mean visibly diverged. Fall back to the distance-weighted
    // mean of the plotted points only when the hero sensor is missing.
    const sumE = pts.reduce((a, p) => a + (isNaN(p.e) ? (p.y * p.x) / 100 : p.e), 0);
    const sumX = pts.reduce((a, p) => a + p.x, 0);
    const heroSt = this._hass.states[`sensor.${D}_avg_consumption_30_days`];
    const hero = heroSt ? parseFloat(heroSt.state) : NaN;
    const mean = !isNaN(hero) ? hero : sumX > 0 ? (sumE / sumX) * 100 : 0;
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
        <div class="ef-legcap">dot colour = trip score</div>
        ${_scoreLegend()}
        <style>
          .ef-legcap{padding:0 16px 2px;font-size:.66em;text-transform:uppercase;
                     letter-spacing:.04em;color:var(--secondary-text-color);}
          .score-legend{display:flex;flex-wrap:wrap;gap:8px;padding:2px 16px 14px;}
          .sl-i{display:inline-flex;align-items:center;gap:4px;font-size:.74em;color:var(--secondary-text-color);}
          .sl-i i{width:10px;height:10px;border-radius:3px;display:inline-block;}
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
// Custom card: consumption by SPEED band — distance-weighted kWh/100km for
// city / mixed / road / highway, computed from recent_trips (avg_speed_kmh +
// consumption). Works on existing data (no temp sensor needed), so it's the
// useful counterpart to the consumption-by-temperature chart that stays empty
// until the logger samples outside temperature.
// ==========================================================================
class EvTripSpeedCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 3; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = this._hass.states[`sensor.${D}_recent_trips`];
    const trips = (st && st.attributes && Array.isArray(st.attributes.trips) && st.attributes.trips) || [];
    const bands = [
      { key: "city", label: "City", sub: "<30 km/h", icon: "mdi:city-variant-outline", color: "#8b5cf6", lo: 0, hi: 30 },
      { key: "mixed", label: "Mixed", sub: "30–60", icon: "mdi:road-variant", color: "#039be5", lo: 30, hi: 60 },
      { key: "road", label: "Road", sub: "60–90", icon: "mdi:highway", color: "#22c55e", lo: 60, hi: 90 },
      { key: "highway", label: "Highway", sub: "90+", icon: "mdi:car-speed-limiter", color: "#f59e0b", lo: 90, hi: Infinity },
    ];
    for (const b of bands) { b.e = 0; b.x = 0; b.n = 0; }
    for (const t of trips) {
      const sp = Number(t.avg_speed_kmh), km = Number(t.distance_km), cons = Number(t.consumption_kwh_100km);
      if (isNaN(sp) || isNaN(km) || km <= 0 || isNaN(cons) || cons < 0) continue;
      const energy = !isNaN(Number(t.energy_kwh)) && Number(t.energy_kwh) >= 0 ? Number(t.energy_kwh) : (cons * km) / 100;
      const b = bands.find((z) => sp >= z.lo && sp < z.hi);
      if (!b) continue;
      b.e += energy; b.x += km; b.n += 1;
    }
    const active = bands.filter((b) => b.x > 0).map((b) => ({ ...b, cons: (b.e / b.x) * 100 }));
    if (active.length < 1) {
      this.innerHTML = `<ha-card><div class="sp-head">Consumption by speed</div>
        <div class="sp-empty">Not enough trips with speed data yet.</div>
        <style>.sp-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
        .sp-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);}</style></ha-card>`;
      return;
    }
    const maxC = Math.max(...active.map((b) => b.cons));
    const rows = active
      .map((b) => {
        const pct = Math.round((b.cons / maxC) * 100);
        return `<div class="sp-row">
          <span class="sp-ic" style="color:${b.color}"><ha-icon icon="${b.icon}"></ha-icon></span>
          <span class="sp-lbl"><span class="sp-l1">${b.label}</span><span class="sp-l2">${b.sub} · ${b.n} ${b.n === 1 ? "trip" : "trips"} · ${b.x.toFixed(0)} km</span></span>
          <span class="sp-track"><span class="sp-fill" style="width:${pct}%;background:${b.color}"></span></span>
          <span class="sp-val">${b.cons.toFixed(1)}</span>
        </div>`;
      })
      .join("");
    const best = active.reduce((m, b) => (b.cons < m.cons ? b : m));
    this.innerHTML = `
      <ha-card>
        <div class="sp-head">Consumption by speed <span class="sp-sub">kWh/100km · lower is better</span></div>
        <div class="sp-list">${rows}</div>
        <div class="sp-foot">Most efficient: <b style="color:${best.color}">${best.label}</b> at ${best.cons.toFixed(1)} kWh/100km</div>
        <style>
          .sp-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px;
                   padding:14px 16px 8px;font-weight:600;font-size:1.05em;}
          .sp-sub{color:var(--secondary-text-color);font-weight:400;font-size:.78em;}
          .sp-list{display:flex;flex-direction:column;gap:10px;padding:2px 16px 8px;}
          .sp-row{display:grid;grid-template-columns:26px 1fr 90px auto;align-items:center;gap:10px;}
          .sp-ic ha-icon{--mdc-icon-size:22px;}
          .sp-lbl{display:flex;flex-direction:column;line-height:1.15;min-width:0;}
          .sp-l1{font-weight:600;}
          .sp-l2{font-size:.72em;color:var(--secondary-text-color);}
          .sp-track{height:10px;border-radius:6px;background:var(--divider-color);overflow:hidden;}
          .sp-fill{display:block;height:100%;border-radius:6px;}
          .sp-val{font-weight:800;font-variant-numeric:tabular-nums;min-width:40px;text-align:right;}
          .sp-foot{padding:6px 16px 16px;font-size:.84em;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-speed-card", EvTripSpeedCard);
window.customCards.push({ type: "ev-trip-speed-card", name: "EV Trip — consumption by speed", description: "Distance-weighted kWh/100km per speed band from recent_trips." });

// ==========================================================================
// Custom card: consumption by TEMPERATURE band (the "seasons" view). Reads the
// logger's consumption-by-temperature sensor (state = current bucket; attribute
// `by_bucket` = {tempBucket: kWh/100km}). Drawn as reliable HTML bars (the apex
// category chart renders blank), cold→hot, season-coloured, with the bucket the
// car is in right now highlighted. Honours the global efficiency unit toggle.
// Stays empty (with a clear hint) until trips record an outside temperature.
// ==========================================================================
class EvTripTempCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 4; }
  connectedCallback() {
    if (this._effBound) return;
    this._effBound = true;
    this._onEffUnit = () => this._render();
    window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
  }
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
  }
  // Cold → hot season styling for a bucket's lower-bound temperature.
  _season(t) {
    if (t < 5) return { color: "#039be5", icon: "mdi:snowflake" };
    if (t < 15) return { color: "#26c6da", icon: "mdi:weather-partly-cloudy" };
    if (t < 25) return { color: "#43a047", icon: "mdi:weather-sunny" };
    return { color: "#f59e0b", icon: "mdi:weather-sunny-alert" };
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = _findSensorByAttr(this._hass, D, "consumption_by_temperature", "by_bucket");
    const a = (st && st.attributes) || {};
    const buckets = a.by_bucket || {};
    const size = Number(a.bucket_size_c) || 5;
    const n = Number(a.sample_count) || 0;
    const keys = Object.keys(buckets)
      .map((k) => [parseInt(k, 10), Number(buckets[k])])
      .filter((p) => !isNaN(p[0]) && !isNaN(p[1]) && p[1] >= 0)
      .sort((x, y) => x[0] - y[0]);
    const head = `<div class="tc-head">${L("Consumption by temperature", "Consumo por temperatura")} <span class="tc-sub">${_esc(_effUnitLabel())} · ${n} ${L(n === 1 ? "sample" : "samples", n === 1 ? "muestra" : "muestras")}</span></div>`;
    if (!keys.length) {
      this.innerHTML = `<ha-card>${head}
        <div class="tc-empty"><ha-icon icon="mdi:thermometer-off"></ha-icon>
          <div>${L("No temperature data yet.", "Aún sin datos por temperatura.")}<br><span>${L("Fills as trips record the outside temperature.", "Se llena a medida que los viajes registran la temperatura exterior.")}</span></div>
        </div>
        <style>
          .tc-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px;padding:14px 16px 8px;font-weight:600;font-size:1.05em;}
          .tc-sub{color:var(--secondary-text-color);font-weight:400;font-size:.78em;}
          .tc-empty{display:flex;align-items:center;gap:12px;padding:10px 18px 22px;color:var(--secondary-text-color);}
          .tc-empty ha-icon{--mdc-icon-size:30px;flex:0 0 auto;opacity:.7;}
          .tc-empty span{font-size:.88em;opacity:.85;}
        </style></ha-card>`;
      return;
    }
    // Which bucket is the car in right now?
    let curBucket = null;
    const te = this._config.tempEntity ? this._hass.states[this._config.tempEntity] : null;
    const curTemp = te ? parseFloat(te.state) : NaN;
    if (!isNaN(curTemp)) curBucket = Math.floor(curTemp / size) * size;
    const maxV = Math.max(...keys.map((p) => p[1])) || 1;
    const rows = keys
      .map(([lo, v]) => {
        const s = this._season(lo);
        const e = _fmtEffVal(v);
        const pct = Math.max(4, Math.round((v / maxV) * 100));
        const isCur = curBucket != null && lo === curBucket;
        return `<div class="tc-row${isCur ? " tc-row--cur" : ""}">
          <span class="tc-ic" style="color:${s.color}"><ha-icon icon="${s.icon}"></ha-icon></span>
          <span class="tc-lbl">${lo}–${lo + size}°C${isCur ? ` <span class="tc-now">${L("now", "ahora")}</span>` : ""}</span>
          <span class="tc-track"><span class="tc-fill" style="width:${pct}%;background:${s.color}"></span></span>
          <span class="tc-val">${e.value}</span>
        </div>`;
      })
      .join("");
    // Best (lowest-consumption) band for the footer.
    const best = keys.reduce((m, p) => (p[1] < m[1] ? p : m));
    this.innerHTML = `
      <ha-card>
        ${head}
        <div class="tc-list">${rows}</div>
        <div class="tc-foot">❄️ ${L("cold", "frío")} → ☀️ ${L("hot", "calor")} · ${L("lower is better", "más bajo = mejor")} · ${L("best band", "mejor banda")}: <b>${best[0]}–${best[0] + size}°C</b> (${_fmtEff(best[1])})</div>
        <style>
          .tc-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px;padding:14px 16px 8px;font-weight:600;font-size:1.05em;}
          .tc-sub{color:var(--secondary-text-color);font-weight:400;font-size:.78em;}
          .tc-list{display:flex;flex-direction:column;gap:9px;padding:2px 16px 8px;}
          .tc-row{display:grid;grid-template-columns:26px 92px 1fr auto;align-items:center;gap:10px;}
          .tc-row--cur .tc-lbl{font-weight:800;color:var(--primary-text-color);}
          .tc-ic ha-icon{--mdc-icon-size:20px;}
          .tc-lbl{font-size:.84em;font-variant-numeric:tabular-nums;color:var(--secondary-text-color);}
          .tc-now{font-size:.78em;background:var(--primary-color);color:var(--text-primary-color,#fff);
                  border-radius:6px;padding:0 5px;margin-left:3px;font-weight:700;}
          .tc-track{height:10px;border-radius:6px;background:var(--divider-color);overflow:hidden;}
          .tc-fill{display:block;height:100%;border-radius:6px;}
          .tc-val{font-weight:800;font-variant-numeric:tabular-nums;min-width:42px;text-align:right;}
          .tc-foot{padding:6px 16px 16px;font-size:.82em;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-temp-card", EvTripTempCard);
window.customCards.push({ type: "ev-trip-temp-card", name: "EV Trip — consumption by temperature", description: "Seasonal kWh/100km per outdoor-temperature band from the logger." });

// ==========================================================================
// Custom card: battery health (degradation proxy). The BYD/Tesla clouds don't
// expose a real SoH, but the logger calibrates the EFFECTIVE usable capacity
// from charge sessions (SoC delta vs kWh added) and exposes it on recent_trips
// as `effective_battery_capacity_kwh` (+ how many charges back the estimate).
// A drop in this figure over time is the practical degradation signal. Health %
// is shown when a nominal (as-new) capacity is configured.
// ==========================================================================
class EvTripBatteryHealthCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 3; }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    // Prefer the dedicated SoH sensor (v0.5.54): state = calibrated/declared %.
    // attrs: declared_capacity_kwh, calibrated_capacity_kwh, calibration_charges,
    // degradation_kwh_per_year, history[{observed_at,calibrated_kwh,...}].
    const soh = _findSensorByAttr(this._hass, D, "battery_soh", "calibrated_capacity_kwh");
    const rt = (this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {};
    // Real lifetime odometer (v0.5.65 exposes it on battery_soh) — show THIS,
    // not the logger-witnessed km the SoH model currently uses.
    const odoKm = soh ? parseFloat((soh.attributes || {}).odometer_km) : NaN;
    let declared, calibrated, charges, sohPct, ratePerYear, history;
    if (soh) {
      const sa = soh.attributes || {};
      declared = parseFloat(sa.declared_capacity_kwh);
      calibrated = parseFloat(sa.calibrated_capacity_kwh);
      charges = parseInt(sa.calibration_charges, 10);
      sohPct = parseFloat(soh.state);
      if (isNaN(sohPct) && !isNaN(calibrated) && !isNaN(declared) && declared > 0) sohPct = (calibrated / declared) * 100;
      ratePerYear = parseFloat(sa.degradation_kwh_per_year);
      history = Array.isArray(sa.history) ? sa.history : [];
    } else {
      // Fallback (pre-restart): the capacity calibration on recent_trips.
      calibrated = parseFloat(rt.effective_battery_capacity_kwh);
      declared = parseFloat(rt.battery_capacity_declared_kwh);
      if (isNaN(declared)) { const c = parseFloat(this._config.nominalKwh); if (!isNaN(c)) declared = c; }
      charges = parseInt(rt.battery_capacity_calibration_charges, 10);
      sohPct = !isNaN(calibrated) && !isNaN(declared) && declared > 0 ? (calibrated / declared) * 100 : NaN;
      history = [];
    }
    // v0.5.57 — expected SoH (model from km/age/chemistry/climate) + a
    // health-vs-expected verdict. The expected value is available even before
    // any charge calibration, so it answers "what SoH should this car have?".
    const exp = _findSensorByAttr(this._hass, D, "expected_battery_soh", "factors");
    const expInputs = (exp && exp.attributes && exp.attributes.inputs) || {};
    let expectedPct = exp ? parseFloat(exp.state) : NaN;
    // The logger's SoH model currently counts only logger-WITNESSED km for the
    // cycle term, which undercounts wear on a car with mileage before the logger
    // was installed. Re-base the cycle term on the REAL odometer when it's higher.
    // Idempotent: becomes a no-op once the logger itself uses the odometer.
    const _CYCLE_PP_PER_1000KM = { lfp: 0.040, nmc: 0.100, nca: 0.110 };
    if (exp && !isNaN(expectedPct) && !isNaN(odoKm)) {
      const chem = String(expInputs.chemistry || (soh && soh.attributes && soh.attributes.battery_chemistry) || "lfp").toLowerCase();
      const rate = _CYCLE_PP_PER_1000KM[chem];
      const loggerKm = Number(expInputs.km);
      if (rate != null && !isNaN(loggerKm) && odoKm > loggerKm) {
        const cycLogger = parseFloat((exp.attributes.factors || {}).cycle);
        const cycFromLogger = !isNaN(cycLogger) ? cycLogger : rate * (loggerKm / 1000);
        expectedPct = Math.max(70, expectedPct + cycFromLogger - rate * (odoKm / 1000));
      }
    }
    const vsExp = _findSensorByAttr(this._hass, D, "battery_health_vs_expected", "expected_soh_pct");
    const status = vsExp ? String(vsExp.state) : null; // calibrating|ahead|on_track|behind
    const STATUS = {
      ahead: { label: L("Better than expected", "Mejor de lo esperado"), color: "var(--success-color,#43a047)", icon: "mdi:thumb-up" },
      on_track: { label: L("On track", "En lo esperado"), color: "var(--info-color,#039be5)", icon: "mdi:check-circle" },
      behind: { label: L("Worse than expected", "Peor de lo esperado"), color: "var(--error-color,#e53935)", icon: "mdi:alert" },
    };
    const headStyle = `
      .bh-head{display:flex;align-items:center;gap:7px;padding:14px 16px 2px;font-weight:600;font-size:1.05em;}
      .bh-head ha-icon{--mdc-icon-size:20px;color:var(--success-color,#43a047);}`;
    // Capacity to show: the calibrated value when committed, else the declared
    // spec (the logger uses declared until it has enough confidence to calibrate).
    const cap = !isNaN(calibrated) ? calibrated : declared;
    if (isNaN(cap) && isNaN(sohPct)) {
      this.innerHTML = `<ha-card><div class="bh-head"><ha-icon icon="mdi:battery-heart-variant"></ha-icon>${L("Battery health", "Salud de batería")}</div>
        <div class="bh-empty">${L("Calibrating capacity… (needs several recorded charges)", "Calibrando capacidad… (necesita varias cargas registradas)")}</div>
        <style>${headStyle}.bh-empty{padding:8px 16px 20px;color:var(--secondary-text-color);}</style></ha-card>`;
      return;
    }
    const calibrating = isNaN(calibrated); // showing the declared spec for now
    const chg = (n) => L(`${n} ${n === 1 ? "charge" : "charges"}`, `${n} ${n === 1 ? "carga" : "cargas"}`);
    const conf = isNaN(charges) ? { label: "—", color: "var(--secondary-text-color)" }
      : charges >= 10 ? { label: `${L("high", "alta")} · ${chg(charges)}`, color: "var(--success-color,#43a047)" }
      : charges >= 3 ? { label: `${L("medium", "media")} · ${chg(charges)}`, color: "var(--warning-color,#fb8c00)" }
      : { label: `${L("low", "baja")} · ${chg(charges)}`, color: "var(--error-color,#e53935)" };
    // Show a measured SoH % ONLY when the logger has committed a calibrated
    // capacity. Until then `state` is a 100% placeholder (declared/declared) —
    // NOT a real measurement — so showing a green 100% would be misleading
    // (a car with real km has degraded a few %). Present "not measured yet".
    // Context line: expected SoH from the model (km / age / chemistry).
    const yrs = (v) => L(`${Number(v).toFixed(1)} yr`, `${Number(v).toFixed(1)} años`);
    const kmShown = !isNaN(odoKm) ? odoKm : (expInputs.km != null ? Number(expInputs.km) : null);
    const expLine = !isNaN(expectedPct)
      ? `<div class="bh-exp">${L("Expected", "Esperado")} <b>${expectedPct.toFixed(1)}%</b>${kmShown != null ? ` · ${Math.round(kmShown).toLocaleString()} km` : ""}${expInputs.age_years != null ? ` · ${yrs(expInputs.age_years)}` : ""}${expInputs.chemistry ? ` · ${String(expInputs.chemistry).toUpperCase()}` : ""}</div>`
      : "";
    // Status chip (ahead / on_track / behind) once both observed & expected exist.
    const statusChip = status && STATUS[status]
      ? `<span class="bh-chip" style="color:${STATUS[status].color};border-color:${STATUS[status].color}"><ha-icon icon="${STATUS[status].icon}"></ha-icon>${STATUS[status].label}</span>`
      : "";
    let healthHtml = "";
    if (!calibrating && !isNaN(sohPct)) {
      // Real MEASURED SoH from a committed calibration.
      const pct = Math.max(0, Math.min(100, sohPct));
      const col = pct >= 95 ? "var(--success-color,#43a047)" : pct >= 88 ? "var(--warning-color,#fb8c00)" : "var(--error-color,#e53935)";
      healthHtml = `
        <div class="bh-soh"><span class="bh-num" style="color:${col}">${pct.toFixed(1)}%</span><span class="bh-unit">${L("measured health (SoH)", "salud medida (SoH)")}</span>${statusChip}</div>
        <div class="bh-bar"><span class="bh-fill" style="width:${pct.toFixed(0)}%;background:${col}"></span></div>
        <div class="bh-sub">${cap.toFixed(1)} ${L("kWh usable", "kWh útiles")}${!isNaN(declared) ? ` ${L("of", "de")} ${declared.toFixed(1)} ${L("nominal", "nominal")}` : ""}</div>
        ${expLine}`;
    } else if (!isNaN(expectedPct) && (Number(expInputs.age_years) >= 0.3 || Number(expInputs.km) >= 3000)) {
      // Not measured yet, but the model has enough basis (real km/age) to give
      // a realistic expectation. Guard against the "0 km / 0 yr → 100%" case.
      const col = expectedPct >= 95 ? "var(--success-color,#43a047)" : expectedPct >= 88 ? "var(--warning-color,#fb8c00)" : "var(--error-color,#e53935)";
      healthHtml = `
        <div class="bh-soh"><span class="bh-num" style="color:${col}">${expectedPct.toFixed(1)}%</span><span class="bh-unit">${L("estimated SoH", "SoH estimada")}</span></div>
        <div class="bh-bar"><span class="bh-fill" style="width:${expectedPct.toFixed(0)}%;background:${col}"></span></div>
        <div class="bh-sub">${!isNaN(cap) ? `${cap.toFixed(1)} ${L("kWh nominal", "kWh nominales")} · ` : ""}${kmShown != null ? `${Math.round(kmShown).toLocaleString()} km` : ""}${expInputs.age_years != null ? ` · ${yrs(expInputs.age_years)}` : ""}${expInputs.chemistry ? ` · ${String(expInputs.chemistry).toUpperCase()}` : ""}</div>
        <div class="bh-pending"><ha-icon icon="mdi:progress-clock"></ha-icon><span>${L("Estimated from km/age. The <b>measured</b> value appears once the logger calibrates with more charges", "Estimada por km/edad. La <b>medida real</b> aparece cuando el logger calibre con más cargas")} (${isNaN(charges) ? 0 : charges}).</span></div>`;
    } else {
      // Either no model output, or the model lacks a basis (it only counts km
      // since the logger started + age from vehicle_first_registered, both ~0
      // here → a meaningless ~100%). Show nominal capacity + how to fix it.
      const nC = isNaN(charges) ? 0 : charges;
      healthHtml = `
        <div class="bh-soh"><span class="bh-num bh-num--muted">${isNaN(cap) ? "—" : cap.toFixed(1)}</span><span class="bh-unit">${L("kWh nominal", "kWh nominales")}</span></div>
        <div class="bh-pending"><ha-icon icon="mdi:progress-clock"></ha-icon><span>${L(`<b>SoH not reliably estimated yet.</b> Real capacity is calibrated from charges (${nC} so far) and the age estimate needs the vehicle's <b>first-registration date</b> (the model only counts km since the logger was installed).`, `<b>SoH aún sin estimar de forma fiable.</b> La capacidad real se calibra con cargas (${nC} hasta ahora) y la estimación por edad necesita la <b>fecha de matriculación</b> del coche (el modelo solo cuenta km desde que se instaló el logger).`)}</span></div>`;
    }
    // Degradation rate + tiny capacity trend sparkline.
    let rateHtml = "";
    if (!isNaN(ratePerYear) && Math.abs(ratePerYear) >= 0.01) {
      const losing = ratePerYear < 0;
      rateHtml = `<div class="bh-rate"><ha-icon icon="${losing ? "mdi:trending-down" : "mdi:trending-up"}" style="color:${losing ? "var(--error-color,#e53935)" : "var(--success-color,#43a047)"}"></ha-icon>${ratePerYear > 0 ? "+" : ""}${ratePerYear.toFixed(2)} ${L("kWh/yr", "kWh/año")}</div>`;
    }
    const caps = history.map((h) => parseFloat(h.calibrated_kwh)).filter((v) => !isNaN(v));
    let spark = "";
    if (caps.length >= 2) {
      const lo = Math.min(...caps), hi = Math.max(...caps), span = hi - lo || 1;
      const W = 220, H = 30;
      const pts = caps.map((v, i) => `${((i / (caps.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / span) * (H - 4) - 2).toFixed(1)}`).join(" ");
      spark = `<svg class="bh-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--primary-color)" stroke-width="2"/></svg>`;
    }
    this.innerHTML = `
      <ha-card>
        <div class="bh-head"><ha-icon icon="mdi:battery-heart-variant"></ha-icon>${L("Battery health", "Salud de batería")}${rateHtml}</div>
        ${healthHtml}
        ${spark}
        <div class="bh-foot">${L("Capacity calibrated from real charges", "Capacidad calibrada con cargas reales")} · ${L("confidence", "confianza")} <b style="color:${conf.color}">${conf.label}</b>. ${calibrating ? L("The SoH % appears once there are enough charges.", "El SoH (% de salud) aparece cuando haya suficientes cargas.") : L("A sustained drop = real degradation.", "Una bajada sostenida = degradación real.")}</div>
        <style>
          ${headStyle}
          .bh-head{justify-content:space-between;}
          .bh-rate{display:inline-flex;align-items:center;gap:3px;font-size:.78em;font-weight:600;color:var(--secondary-text-color);}
          .bh-rate ha-icon{--mdc-icon-size:16px;}
          .bh-soh{display:flex;align-items:baseline;gap:6px;padding:2px 16px 4px;}
          .bh-num{font-size:2.1em;font-weight:800;color:var(--primary-text-color);font-variant-numeric:tabular-nums;}
          .bh-num--muted{color:var(--secondary-text-color);}
          .bh-pending{display:flex;align-items:flex-start;gap:7px;padding:2px 16px 2px;font-size:.84em;color:var(--secondary-text-color);}
          .bh-pending ha-icon{--mdc-icon-size:17px;flex:0 0 auto;color:var(--warning-color,#fb8c00);margin-top:1px;}
          .bh-unit{font-size:.85em;color:var(--secondary-text-color);}
          .bh-bar{height:12px;border-radius:7px;background:var(--divider-color);overflow:hidden;margin:2px 16px 0;}
          .bh-fill{display:block;height:100%;border-radius:7px;}
          .bh-sub{padding:5px 16px 2px;font-size:.9em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .bh-exp{padding:2px 16px 2px;font-size:.84em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .bh-chip{display:inline-flex;align-items:center;gap:3px;margin-left:auto;font-size:.6em;font-weight:700;
                   padding:3px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap;align-self:center;}
          .bh-chip ha-icon{--mdc-icon-size:13px;}
          .bh-spark{display:block;width:calc(100% - 32px);height:30px;margin:6px 16px 0;}
          .bh-foot{padding:6px 16px 16px;font-size:.8em;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-battery-health-card", EvTripBatteryHealthCard);
window.customCards.push({ type: "ev-trip-battery-health-card", name: "EV Trip — battery health", description: "State of Health / calibrated capacity (degradation) from the logger." });

// ==========================================================================
// Shared renderer for the "consumption by <bucket>" cards (season / time of
// day). Reads {current, by} from a logger sensor whose buckets each carry
// {trips, distance_km, energy_kwh, avg_consumption_kwh_100km, avg_ambient_temp_c}
// and draws HTML bars in the active efficiency unit, current bucket highlighted.
// ==========================================================================
class _EvTripBucketCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 4; }
  connectedCallback() {
    if (this._effBound) return;
    this._effBound = true;
    this._onEffUnit = () => this._render();
    window.addEventListener("ev-trip-eff-unit", this._onEffUnit);
  }
  disconnectedCallback() {
    if (this._onEffUnit) window.removeEventListener("ev-trip-eff-unit", this._onEffUnit);
    this._effBound = false;
  }
  // Subclasses set: _sensorKey, _curAttr, _byAttr, _headIcon, _titleEn/_titleEs,
  // _emptyEn/_emptyEs, _order [{key,labelEn,labelEs,icon,color}].
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = _findSensorByAttr(this._hass, D, this._sensorKey, this._byAttr);
    const a = (st && st.attributes) || {};
    const by = a[this._byAttr] || {};
    const cur = a[this._curAttr];
    const rowsData = this._order
      .map((o) => ({ ...o, label: L(o.labelEn, o.labelEs), d: by[o.key] }))
      .filter((o) => o.d && o.d.avg_consumption_kwh_100km != null && !isNaN(Number(o.d.avg_consumption_kwh_100km)));
    const head = `<div class="bk-head"><ha-icon icon="${this._headIcon}"></ha-icon>${L(this._titleEn, this._titleEs)}<span class="bk-sub">${_esc(_effUnitLabel())} · ${L("lower is better", "más bajo = mejor")}</span></div>`;
    const css = `
      .bk-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:14px 16px 8px;font-weight:600;font-size:1.05em;}
      .bk-head ha-icon{--mdc-icon-size:20px;color:var(--primary-color);}
      .bk-sub{margin-left:auto;color:var(--secondary-text-color);font-weight:400;font-size:.72em;}
      .bk-empty{display:flex;align-items:center;gap:12px;padding:8px 18px 22px;color:var(--secondary-text-color);}
      .bk-empty ha-icon{--mdc-icon-size:28px;opacity:.7;}
      .bk-list{display:flex;flex-direction:column;gap:9px;padding:2px 16px 12px;}
      .bk-row{display:grid;grid-template-columns:24px 84px 1fr auto;align-items:center;gap:10px;}
      .bk-row--cur .bk-lbl{font-weight:800;color:var(--primary-text-color);}
      .bk-ic ha-icon{--mdc-icon-size:19px;}
      .bk-lbl{font-size:.85em;color:var(--secondary-text-color);}
      .bk-now{font-size:.74em;background:var(--primary-color);color:var(--text-primary-color,#fff);border-radius:6px;padding:0 5px;margin-left:3px;font-weight:700;}
      .bk-track{height:10px;border-radius:6px;background:var(--divider-color);overflow:hidden;}
      .bk-fill{display:block;height:100%;border-radius:6px;}
      .bk-val{font-weight:800;font-variant-numeric:tabular-nums;min-width:42px;text-align:right;}
      .bk-meta{grid-column:2 / -1;font-size:.72em;color:var(--secondary-text-color);margin-top:-4px;}`;
    if (!rowsData.length) {
      this.innerHTML = `<ha-card>${head}
        <div class="bk-empty"><ha-icon icon="mdi:database-clock-outline"></ha-icon>
          <div>${L(this._emptyEn, this._emptyEs)}</div></div>
        <style>${css}</style></ha-card>`;
      return;
    }
    const maxV = Math.max(...rowsData.map((o) => Number(o.d.avg_consumption_kwh_100km))) || 1;
    const rows = rowsData
      .map((o) => {
        const v = Number(o.d.avg_consumption_kwh_100km);
        const e = _fmtEffVal(v);
        const pct = Math.max(4, Math.round((v / maxV) * 100));
        const isCur = cur != null && String(cur) === String(o.key);
        const trips = o.d.trips != null ? L(`${o.d.trips} ${o.d.trips === 1 ? "trip" : "trips"}`, `${o.d.trips} ${o.d.trips === 1 ? "viaje" : "viajes"}`) : "";
        const temp = o.d.avg_ambient_temp_c != null ? ` · ${Number(o.d.avg_ambient_temp_c).toFixed(0)}°C` : "";
        const km = o.d.distance_km != null ? ` · ${Number(o.d.distance_km).toFixed(0)} km` : "";
        return `<div class="bk-row${isCur ? " bk-row--cur" : ""}">
            <span class="bk-ic" style="color:${o.color}"><ha-icon icon="${o.icon}"></ha-icon></span>
            <span class="bk-lbl">${_esc(o.label)}${isCur ? ` <span class="bk-now">${L("now", "ahora")}</span>` : ""}</span>
            <span class="bk-track"><span class="bk-fill" style="width:${pct}%;background:${o.color}"></span></span>
            <span class="bk-val">${e.value}</span>
            <span class="bk-meta">${trips}${km}${temp}</span>
          </div>`;
      })
      .join("");
    const best = rowsData.reduce((m, o) => (Number(o.d.avg_consumption_kwh_100km) < Number(m.d.avg_consumption_kwh_100km) ? o : m));
    this.innerHTML = `<ha-card>${head}<div class="bk-list">${rows}</div>
      <div class="bk-foot">${L("Most efficient", "Más eficiente")}: <b>${_esc(best.label)}</b> (${_fmtEff(Number(best.d.avg_consumption_kwh_100km))})</div>
      <style>${css}.bk-foot{padding:0 16px 16px;font-size:.82em;color:var(--secondary-text-color);}</style></ha-card>`;
  }
}

// Consumption by SEASON (winter/spring/summer/autumn) — sensor.<D>_consumption_by_season.
class EvTripSeasonCard extends _EvTripBucketCard {
  constructor() {
    super();
    this._sensorKey = "consumption_by_season";
    this._byAttr = "by_season";
    this._curAttr = "current_season";
    this._titleEn = "Consumption by season"; this._titleEs = "Consumo por estación";
    this._headIcon = "mdi:sun-snowflake-variant";
    this._emptyEn = "No seasonal data yet — it fills from recorded trips.";
    this._emptyEs = "Aún sin datos por estación — se llena con los viajes registrados.";
    this._order = [
      { key: "winter", labelEn: "Winter", labelEs: "Invierno", icon: "mdi:snowflake", color: "#039be5" },
      { key: "spring", labelEn: "Spring", labelEs: "Primavera", icon: "mdi:flower", color: "#43a047" },
      { key: "summer", labelEn: "Summer", labelEs: "Verano", icon: "mdi:weather-sunny", color: "#f59e0b" },
      { key: "autumn", labelEn: "Autumn", labelEs: "Otoño", icon: "mdi:leaf-maple", color: "#a1632e" },
    ];
  }
}
customElements.define("ev-trip-season-card", EvTripSeasonCard);
window.customCards.push({ type: "ev-trip-season-card", name: "EV Trip — consumption by season", description: "Seasonal kWh/100km from the logger's consumption_by_season sensor." });

// Consumption by TIME OF DAY — sensor.<D>_consumption_by_time_of_day.
class EvTripTimeOfDayCard extends _EvTripBucketCard {
  constructor() {
    super();
    this._sensorKey = "consumption_by_time_of_day";
    this._byAttr = "by_time";
    this._curAttr = "current_bucket";
    this._titleEn = "Consumption by time of day"; this._titleEs = "Consumo por franja horaria";
    this._headIcon = "mdi:clock-time-four-outline";
    this._emptyEn = "No time-of-day data yet."; this._emptyEs = "Aún sin datos por franja horaria.";
    this._order = [
      { key: "morning", labelEn: "Morning", labelEs: "Mañana", icon: "mdi:weather-sunset-up", color: "#fbc02d" },
      { key: "midday", labelEn: "Midday", labelEs: "Mediodía", icon: "mdi:weather-sunny", color: "#f59e0b" },
      { key: "afternoon", labelEn: "Afternoon", labelEs: "Tarde", icon: "mdi:weather-partly-cloudy", color: "#039be5" },
      { key: "evening", labelEn: "Evening", labelEs: "Atardecer", icon: "mdi:weather-sunset-down", color: "#8b5cf6" },
      { key: "night", labelEn: "Night", labelEs: "Noche", icon: "mdi:weather-night", color: "#5c6bc0" },
    ];
  }
}
customElements.define("ev-trip-time-of-day-card", EvTripTimeOfDayCard);
window.customCards.push({ type: "ev-trip-time-of-day-card", name: "EV Trip — consumption by time of day", description: "kWh/100km per part of day from the logger's consumption_by_time_of_day sensor." });

// ==========================================================================
// Custom card: per-month efficiency (kWh/100km) — a "this month vs last" delta
// plus one chip per month, computed from monthly_history. Rendered as a real
// custom element (not markdown) so the scoped <style> always applies.
// ==========================================================================
class EvTripMonthlyEffCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 2; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const mh = this._hass.states[`sensor.${D}_monthly_history`];
    const months = (mh && mh.attributes && Array.isArray(mh.attributes.months) && mh.attributes.months) || [];
    const eff = (m) => { const km = Number(m.distance_km) || 0, kwh = Number(m.energy_kwh) || 0; return km > 0 ? (kwh / km) * 100 : null; };
    const withEff = months.map((m) => ({ m, e: eff(m) })).filter((x) => x.e != null);
    if (!withEff.length) { this.innerHTML = ""; return; }
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let delta = "";
    if (withEff.length >= 2) {
      const cur = withEff[withEff.length - 1].e, prev = withEff[withEff.length - 2].e;
      const better = cur <= prev;
      const col = better ? "var(--success-color,#43a047)" : "var(--warning-color,#fb8c00)";
      delta = `<div class="mef-delta">
        <ha-icon icon="${better ? "mdi:trending-down" : "mdi:trending-up"}" style="color:${col}"></ha-icon>
        <span><b>${cur.toFixed(1)}</b> vs ${prev.toFixed(1)} kWh/100km</span>
        <span class="mef-tag" style="color:${col}">${better ? "▼" : "▲"} ${Math.abs(cur - prev).toFixed(1)} ${better ? "better" : "worse"}</span>
      </div>`;
    }
    const effCol = (e) =>
      e < 16 ? "var(--success-color,#43a047)" : e < 19 ? "var(--light-green-color,#7cb342)" : e < 22 ? "var(--warning-color,#fbc02d)" : "var(--error-color,#e53935)";
    const chips = withEff
      .map((x) => {
        const [y, mo] = String(x.m.month || "").split("-").map(Number);
        const lbl = y && mo ? `${M[mo - 1]} '${String(y).slice(2)}` : String(x.m.month);
        return `<span class="mef-chip"><span class="mef-m">${_esc(lbl)}</span><span class="mef-v" style="color:${effCol(x.e)}">${x.e.toFixed(1)}</span></span>`;
      })
      .join("");
    this.innerHTML = `
      <ha-card>
        <div class="mef-head">Per-month efficiency <span class="mef-sub">kWh/100km · lower is better</span></div>
        ${delta}
        <div class="mef-chips">${chips}</div>
        <style>
          .mef-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px;
                    padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
          .mef-sub{color:var(--secondary-text-color);font-weight:400;font-size:.78em;}
          .mef-delta{display:flex;align-items:center;gap:8px;padding:2px 16px 8px;font-size:.92em;flex-wrap:wrap;}
          .mef-delta ha-icon{--mdc-icon-size:20px;}
          .mef-tag{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums;}
          .mef-chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 16px 16px;}
          .mef-chip{display:flex;flex-direction:column;align-items:center;gap:1px;
                    background:var(--secondary-background-color,var(--card-background-color));
                    border:1px solid var(--divider-color);border-radius:10px;padding:6px 10px;}
          .mef-m{font-size:.62em;color:var(--secondary-text-color);text-transform:uppercase;}
          .mef-v{font-weight:800;font-variant-numeric:tabular-nums;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-monthly-eff-card", EvTripMonthlyEffCard);
window.customCards.push({ type: "ev-trip-monthly-eff-card", name: "EV Trip — per-month efficiency", description: "Per-month kWh/100km chips + this-vs-last delta from monthly_history." });

// Shared: distance-weighted kWh/100km per speed band from recent_trips.
function _speedBandStats(trips) {
  const bands = [
    { key: "city", label: "City", icon: "mdi:city-variant-outline", color: "#8b5cf6", lo: 0, hi: 30 },
    { key: "mixed", label: "Mixed", icon: "mdi:road-variant", color: "#039be5", lo: 30, hi: 60 },
    { key: "road", label: "Road", icon: "mdi:highway", color: "#22c55e", lo: 60, hi: 90 },
    { key: "highway", label: "Highway", icon: "mdi:car-speed-limiter", color: "#f59e0b", lo: 90, hi: Infinity },
  ];
  for (const b of bands) { b.e = 0; b.x = 0; b.n = 0; }
  for (const t of trips || []) {
    const sp = Number(t.avg_speed_kmh), km = Number(t.distance_km), cons = Number(t.consumption_kwh_100km);
    if (isNaN(sp) || isNaN(km) || km <= 0 || isNaN(cons) || cons < 0) continue;
    const energy = !isNaN(Number(t.energy_kwh)) && Number(t.energy_kwh) >= 0 ? Number(t.energy_kwh) : (cons * km) / 100;
    const b = bands.find((z) => sp >= z.lo && sp < z.hi);
    if (b) { b.e += energy; b.x += km; b.n += 1; }
  }
  return bands.filter((b) => b.x > 0).map((b) => ({ ...b, cons: (b.e / b.x) * 100 }));
}

// ==========================================================================
// Custom card: savings vs an equivalent petrol car. Compares your real
// electric cost against what the same distance would cost on petrol, using a
// configurable consumption (L/100km) and fuel price. All-time figures come
// from trip_records.totals; "this month" from the monthly distance/cost.
// ==========================================================================
class EvTripSavingsCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 3; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const L = Number(this._config.gas_l_per_100km) || 5.7;   // petrol car L/100km
    const P = Number(this._config.gas_price_per_l) || 1.6;   // €/L
    const sym = _deviceCurrency(this._hass, D);
    const num = (e) => { const s = this._hass.states[e]; const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; };
    const tot = (this._hass.states[`sensor.${D}_trip_records`] || {}).attributes || {};
    const totals = tot.totals || {};
    const petrol = (km) => (km / 100) * L * P;
    const block = (km, eur, label) => {
      if (km == null || eur == null || km <= 0) return "";
      const pc = petrol(km), save = pc - eur, max = Math.max(pc, eur, 0.01);
      return `<div class="sv-blk">
        <div class="sv-blabel">${label} · ${km.toFixed(0)} km</div>
        <div class="sv-bar"><div class="sv-bf sv-elec" style="width:${Math.round((eur / max) * 100)}%"></div></div>
        <div class="sv-brow"><span>⚡ Electric</span><b>${eur.toFixed(2)} ${_esc(sym)}</b></div>
        <div class="sv-bar"><div class="sv-bf sv-gas" style="width:${Math.round((pc / max) * 100)}%"></div></div>
        <div class="sv-brow"><span>⛽ Petrol (${L} L/100)</span><b>${pc.toFixed(2)} ${_esc(sym)}</b></div>
        <div class="sv-save">Saved <b>${save.toFixed(2)} ${_esc(sym)}</b></div>
      </div>`;
    };
    const allKm = Number(totals.distance_km), allEur = Number(totals.cost);
    const moKm = num(`sensor.${D}_distance_this_month`), moEur = num(`sensor.${D}_cost_this_month`);
    const blocks = [block(allKm, allEur, "All-time"), block(moKm, moEur, "This month")].filter(Boolean).join("");
    if (!blocks) { this.innerHTML = ""; return; }
    const allSave = allKm > 0 && allEur != null ? petrol(allKm) - allEur : null;
    this.innerHTML = `
      <ha-card>
        <div class="sv-head"><ha-icon icon="mdi:fuel"></ha-icon> Savings vs petrol
          ${allSave != null ? `<span class="sv-hero">${allSave.toFixed(0)} ${_esc(sym)}</span>` : ""}</div>
        <div class="sv-blocks">${blocks}</div>
        <div class="sv-foot">Assumes a petrol car at ${L} L/100km · ${P.toFixed(2)} ${_esc(sym)}/L${this._config.gas_l_per_100km || this._config.gas_price_per_l ? "" : " (defaults — set gas_l_per_100km / gas_price_per_l)"}</div>
        <style>
          .sv-head{display:flex;align-items:center;gap:6px;padding:14px 16px 8px;font-weight:600;font-size:1.05em;}
          .sv-head ha-icon{--mdc-icon-size:20px;color:var(--success-color,#43a047);}
          .sv-hero{margin-left:auto;font-weight:800;color:var(--success-color,#43a047);font-variant-numeric:tabular-nums;}
          .sv-blocks{display:flex;flex-direction:column;gap:14px;padding:2px 16px 8px;}
          .sv-blabel{font-size:.72em;text-transform:uppercase;letter-spacing:.04em;color:var(--secondary-text-color);margin-bottom:4px;}
          .sv-bar{height:9px;border-radius:6px;background:var(--divider-color);overflow:hidden;margin:2px 0;}
          .sv-bf{display:block;height:100%;border-radius:6px;}
          .sv-elec{background:var(--success-color,#43a047);}
          .sv-gas{background:var(--error-color,#e53935);}
          .sv-brow{display:flex;justify-content:space-between;align-items:center;font-size:.85em;}
          .sv-brow b{font-variant-numeric:tabular-nums;}
          .sv-save{text-align:right;font-size:.9em;margin-top:4px;}
          .sv-save b{color:var(--success-color,#43a047);}
          .sv-foot{padding:4px 16px 14px;font-size:.72em;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-savings-card", EvTripSavingsCard);
window.customCards.push({ type: "ev-trip-savings-card", name: "EV Trip — savings vs petrol", description: "Electric cost vs an equivalent petrol car." });

// ==========================================================================
// Custom card: cost per 100 km + projected month-end cost, from the monthly
// distance/cost sensors and trip_records.totals.
// ==========================================================================
class EvTripCostCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 2; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const sym = _deviceCurrency(this._hass, D);
    const num = (e) => { const s = this._hass.states[e]; const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; };
    const moKm = num(`sensor.${D}_distance_this_month`), moEur = num(`sensor.${D}_cost_this_month`);
    const tot = ((this._hass.states[`sensor.${D}_trip_records`] || {}).attributes || {}).totals || {};
    const allKm = Number(tot.distance_km), allEur = Number(tot.cost);
    const per100 = (km, eur) => (km > 0 && eur != null ? (eur / km) * 100 : null);
    const moP = per100(moKm, moEur), allP = per100(allKm, allEur);
    // Projection: scale this-month cost to the full month by elapsed fraction.
    const now = new Date();
    const dom = now.getDate(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const proj = moEur != null && dom > 0 ? (moEur / dom) * dim : null;
    if (moP == null && allP == null) { this.innerHTML = ""; return; }
    const stat = (v, unit, label, color) =>
      `<div class="co-stat"><div class="co-sv"${color ? ` style="color:${color}"` : ""}>${v == null ? "—" : v}<span class="co-su">${unit}</span></div><div class="co-sl">${label}</div></div>`;
    this.innerHTML = `
      <ha-card>
        <div class="co-head"><ha-icon icon="mdi:cash-multiple"></ha-icon> Cost</div>
        <div class="co-grid">
          ${stat(moP == null ? null : moP.toFixed(2), ` ${sym}/100km`, "This month", "var(--primary-color)")}
          ${stat(allP == null ? null : allP.toFixed(2), ` ${sym}/100km`, "All-time")}
          ${stat(proj == null ? null : proj.toFixed(2), ` ${sym}`, `Projected (${dom}/${dim} d)`, "var(--warning-color,#fb8c00)")}
        </div>
        <style>
          .co-head{display:flex;align-items:center;gap:6px;padding:14px 16px 6px;font-weight:600;font-size:1.05em;}
          .co-head ha-icon{--mdc-icon-size:20px;color:var(--warning-color,#fb8c00);}
          .co-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:4px 12px 16px;}
          .co-stat{text-align:center;}
          .co-sv{font-size:1.25em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1;}
          .co-su{font-size:.5em;font-weight:600;color:var(--secondary-text-color);}
          .co-sl{font-size:.66em;text-transform:uppercase;letter-spacing:.03em;color:var(--secondary-text-color);margin-top:2px;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-cost-card", EvTripCostCard);
window.customCards.push({ type: "ev-trip-cost-card", name: "EV Trip — cost per 100km", description: "Cost per 100 km and projected month-end cost." });

// ==========================================================================
// Custom card: charging insights from recent_charges — AC/DC split, average
// price per type, cheapest/priciest session, average session.
// ==========================================================================
class EvTripChargeInsightsCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 3; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const sym = _deviceCurrency(this._hass, D);
    const a = (this._hass.states[`sensor.${D}_recent_charges`] || {}).attributes || {};
    const charges = (Array.isArray(a.charges) && a.charges) || [];
    if (!charges.length) { this.innerHTML = ""; return; }
    const grp = (isDc) => {
      const list = charges.filter((c) => (isDc ? c.is_dcfc === true : c.is_dcfc !== true) && Number(c.kwh) > 0);
      const kwh = list.reduce((s, c) => s + Number(c.kwh), 0);
      const priced = list.filter((c) => Number(c.price_per_kwh) > 0);
      const avgP = priced.length ? priced.reduce((s, c) => s + Number(c.price_per_kwh), 0) / priced.length : null;
      return { n: list.length, kwh, avgP };
    };
    const ac = grp(false), dc = grp(true);
    const priced = charges.filter((c) => Number(c.price_per_kwh) > 0);
    const cheapest = priced.length ? priced.reduce((m, c) => (Number(c.price_per_kwh) < Number(m.price_per_kwh) ? c : m)) : null;
    const priciest = priced.length ? priced.reduce((m, c) => (Number(c.price_per_kwh) > Number(m.price_per_kwh) ? c : m)) : null;
    const withK = charges.filter((c) => Number(c.kwh) > 0);
    const avgKwh = withK.length ? withK.reduce((s, c) => s + Number(c.kwh), 0) / withK.length : null;
    const avgCost = withK.length ? withK.reduce((s, c) => s + (Number(c.total_cost) || 0), 0) / withK.length : null;
    const fmtP = (v) => (v == null ? "—" : `${v.toFixed(3)} ${sym}/kWh`);
    const typeRow = (label, g, color) =>
      g.n ? `<div class="ci-trow"><span class="ci-tdot" style="background:${color}"></span><span class="ci-tl">${label}</span>` +
        `<span class="ci-tn">${g.n} · ${g.kwh.toFixed(0)} kWh</span><span class="ci-tp">${fmtP(g.avgP)}</span></div>` : "";
    const line = (icon, label, val) => `<div class="ci-row"><ha-icon icon="${icon}"></ha-icon><span>${label}</span><b>${val}</b></div>`;
    this.innerHTML = `
      <ha-card>
        <div class="ci-head"><ha-icon icon="mdi:lightning-bolt-circle"></ha-icon> Charging insights <span class="ci-sub">${charges.length} sessions</span></div>
        <div class="ci-types">
          ${typeRow("Home / AC", ac, "var(--info-color,#039be5)")}
          ${typeRow("DC fast", dc, "var(--warning-color,#fb8c00)")}
        </div>
        <div class="ci-rows">
          ${cheapest ? line("mdi:tag-arrow-down", "Cheapest" + (cheapest.location ? ` · ${_esc(cheapest.location)}` : ""), fmtP(Number(cheapest.price_per_kwh))) : ""}
          ${priciest && priciest !== cheapest ? line("mdi:tag-arrow-up", "Priciest" + (priciest.location ? ` · ${_esc(priciest.location)}` : ""), fmtP(Number(priciest.price_per_kwh))) : ""}
          ${avgKwh != null ? line("mdi:battery-charging", "Avg session", `${avgKwh.toFixed(1)} kWh · ${(avgCost || 0).toFixed(2)} ${_esc(sym)}`) : ""}
        </div>
        <style>
          .ci-head{display:flex;align-items:center;gap:6px;padding:14px 16px 8px;font-weight:600;font-size:1.05em;}
          .ci-head ha-icon{--mdc-icon-size:20px;color:var(--warning-color,#fb8c00);}
          .ci-sub{margin-left:auto;color:var(--secondary-text-color);font-weight:400;font-size:.78em;}
          .ci-types{display:flex;flex-direction:column;gap:8px;padding:2px 16px 6px;}
          .ci-trow{display:flex;align-items:center;gap:8px;font-size:.9em;}
          .ci-tdot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;}
          .ci-tl{font-weight:600;}
          .ci-tn{margin-left:auto;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .ci-tp{font-weight:700;font-variant-numeric:tabular-nums;min-width:96px;text-align:right;}
          .ci-rows{display:flex;flex-direction:column;gap:8px;padding:6px 16px 16px;border-top:1px solid var(--divider-color);margin-top:4px;}
          .ci-row{display:flex;align-items:center;gap:8px;font-size:.9em;}
          .ci-row ha-icon{--mdc-icon-size:17px;color:var(--secondary-text-color);}
          .ci-row b{margin-left:auto;font-variant-numeric:tabular-nums;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-charge-insights-card", EvTripChargeInsightsCard);
window.customCards.push({ type: "ev-trip-charge-insights-card", name: "EV Trip — charging insights", description: "AC/DC split, average price, cheapest/priciest, avg session." });

// ==========================================================================
// Custom card: real range NOW — range at recent efficiency plus a per-speed-
// band estimate (battery energy ÷ band consumption) so you see city vs highway
// range from the same charge.
// ==========================================================================
class EvTripRangeCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._device = this._config.device || null; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 3; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const num = (e) => { const s = this._hass.states[e]; const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; };
    const battery = num(`sensor.${D}_battery_energy`);          // kWh available now
    const soc = num(`sensor.${D}_battery_percent`);
    const heroRange = num(`sensor.${D}_range_at_recent_efficiency`);
    const avgCons = num(`sensor.${D}_avg_consumption_30_days`);
    const hero = heroRange != null ? heroRange : (battery != null && avgCons > 0 ? (battery / avgCons) * 100 : null);
    if (hero == null && battery == null) { this.innerHTML = ""; return; }
    const trips = ((this._hass.states[`sensor.${D}_recent_trips`] || {}).attributes || {}).trips || [];
    const bands = battery != null ? _speedBandStats(trips) : [];
    const chips = bands
      .map((b) => `<span class="rg-chip"><ha-icon icon="${b.icon}" style="color:${b.color}"></ha-icon><span class="rg-ck">${b.label}</span><span class="rg-cv">${((battery / b.cons) * 100).toFixed(0)}<span class="rg-cu"> km</span></span></span>`)
      .join("");
    this.innerHTML = `
      <ha-card>
        <div class="rg-top">
          <div class="rg-badge"><ha-icon icon="mdi:map-marker-distance"></ha-icon></div>
          <div class="rg-main">
            <div class="rg-label">Range now${soc != null ? ` · ${soc.toFixed(0)}% · ${battery != null ? battery.toFixed(1) + " kWh" : ""}` : ""}</div>
            <div class="rg-val">${hero == null ? "—" : hero.toFixed(0)}<span class="rg-u"> km</span></div>
            <div class="rg-sub">at your recent efficiency${avgCons ? ` (${avgCons.toFixed(1)} kWh/100km)` : ""}</div>
          </div>
        </div>
        ${chips ? `<div class="rg-bandcap">Estimated range by driving type</div><div class="rg-chips">${chips}</div>` : ""}
        <style>
          .rg-top{display:flex;align-items:center;gap:12px;padding:14px 16px 8px;}
          .rg-badge{flex:0 0 auto;width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(3,155,229,.16);}
          .rg-badge ha-icon{--mdc-icon-size:25px;color:var(--info-color,#039be5);}
          .rg-label{font-size:.8em;color:var(--secondary-text-color);}
          .rg-val{font-size:2em;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;}
          .rg-u{font-size:.45em;font-weight:600;color:var(--secondary-text-color);}
          .rg-sub{font-size:.78em;color:var(--secondary-text-color);margin-top:2px;}
          .rg-bandcap{padding:2px 16px 4px;font-size:.66em;text-transform:uppercase;letter-spacing:.04em;color:var(--secondary-text-color);}
          .rg-chips{display:flex;flex-wrap:wrap;gap:8px;padding:2px 16px 16px;}
          .rg-chip{display:flex;align-items:center;gap:6px;background:var(--secondary-background-color,var(--card-background-color));
                   border:1px solid var(--divider-color);border-radius:12px;padding:7px 11px;}
          .rg-chip ha-icon{--mdc-icon-size:18px;}
          .rg-ck{font-size:.78em;color:var(--secondary-text-color);}
          .rg-cv{font-weight:800;font-variant-numeric:tabular-nums;}
          .rg-cu{font-size:.6em;font-weight:600;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-range-card", EvTripRangeCard);
window.customCards.push({ type: "ev-trip-range-card", name: "EV Trip — range now", description: "Range at recent efficiency + per-speed-band estimate." });

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
      // Exclude parked-with-ignition sessions (long duration, ~0 movement) so
      // "Longest drive" reflects real driving, not a car left on.
      { key: "longest_duration", icon: "mdi:timer-outline", label: "Longest drive", color: "#8b5cf6", filter: (t) => Number(t.avg_speed_kmh) > 5, val: (t) => _recDur(t.duration_min) },
      { key: "top_efficiency", icon: "mdi:leaf", label: "Most efficient", color: "#22c55e", val: (t) => `${(Number(t.consumption_kwh_100km) || 0).toFixed(1)} kWh/100` },
      // Highest consumption — the counterpart to "most efficient" (emitted by the logger as top_consumption).
      { key: "top_consumption", icon: "mdi:gauge-full", label: "Least efficient", color: "#ef4444", filter: (t) => Number(t.consumption_kwh_100km) > 0, val: (t) => `${(Number(t.consumption_kwh_100km) || 0).toFixed(1)} kWh/100` },
      { key: "top_speed", icon: "mdi:speedometer", label: "Fastest avg", color: "#f59e0b", val: (t) => `${(Number(t.avg_speed_kmh) || 0).toFixed(0)} km/h` },
      // Skip cost<=0 entries: a 0 here is a mis-costed trip (charge price was
      // stale at trip-close), not a genuinely free trip — surface the real
      // cheapest paid trip instead. (Logger should fix the root cost bug.)
      { key: "cheapest", icon: "mdi:cash-multiple", label: "Cheapest", color: "#10b981", filter: (t) => Number(t.cost) > 0, val: (t) => `${(Number(t.cost) || 0).toFixed(2)} ${cur[t.currency] || t.currency || "€"}` },
    ];
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
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
                  `<div class="rec-li"><span class="rec-rank">${_medal(i)}</span>` +
                  `<span class="rec-lmain">${_endpoint(t.start_address, t.origin)} → ${_endpoint(t.end_address, t.destination)}</span>` +
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
                <span class="rec-meta">${_recDate(top.started_at || top.ended_at)} · ${_endpoint(top.start_address, top.origin)} → ${_endpoint(top.end_address, top.destination)}</span>
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
// Custom card: per-driver stats over the last 30 days.
// Reads sensor.<device>_driver_stats_30_days — state = number of identified
// drivers, attribute `drivers` = [{driver, trips, distance_km, hours,
// energy_kwh, avg_consumption_kwh_100km}] ordered by km desc.
// The 'unknown' bucket is rendered last and dimmed as "Sin identificar".
// ==========================================================================
class EvDriverStatsCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
  }
  set hass(hass) {
    this._hass = hass;
    const D = this._device || detectDevice(hass);
    const sig = _sig(hass, [`sensor.${D}_driver_stats_30_days`]);
    if (sig === this._driverSig) return;
    this._driverSig = sig;
    this._render();
  }
  getCardSize() {
    return 4;
  }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const st = this._hass.states[`sensor.${D}_driver_stats_30_days`];
    const a = (st && st.attributes) || {};
    const allRows = (Array.isArray(a.drivers) && a.drivers) || [];
    const winDays = Number(a.window_days) || 30;

    if (!st || !allRows.length) {
      this.innerHTML = `
        <ha-card>
          <div class="ds-head">Conductores (${winDays} d\xEDs)</div>
          <div class="ds-empty">Sin datos de conductor a\xFAn.<br><span>Requiere <code>sensor.${_esc(D)}_driver_stats_30_days</code> (logger v0.5.43).</span></div>
          <style>
            .ds-head{padding:14px 16px 4px;font-weight:600;font-size:1.05em;}
            .ds-empty{padding:18px 16px 22px;text-align:center;color:var(--secondary-text-color);line-height:1.5;}
            .ds-empty span{font-size:.85em;opacity:.8;}
          </style>
        </ha-card>`;
      return;
    }

    // Split known drivers from the 'unknown' bucket so unknown is always last.
    const known = allRows.filter((r) => r.driver !== "unknown");
    const unknownRow = allRows.find((r) => r.driver === "unknown") || null;
    const rows = unknownRow ? [...known, unknownRow] : known;

    const maxKm = Math.max(1, ...rows.map((r) => Number(r.distance_km) || 0));
    const DASH = "—";
    const fmt = (v, dp) => (v == null || isNaN(Number(v)) ? DASH : Number(v).toFixed(dp));

    const rowsHtml = rows.map((r) => {
      const isUnknown = r.driver === "unknown";
      const km = Number(r.distance_km) || 0;
      const pct = Math.round((km / maxKm) * 100);
      const name = isUnknown ? "Sin identificar" : _esc(r.driver);
      const cons = r.avg_consumption_kwh_100km != null ? `${fmt(r.avg_consumption_kwh_100km, 1)} kWh/100` : DASH;
      const hrs = r.hours != null ? `${fmt(r.hours, 1)} h` : DASH;
      return `
        <div class="ds-row${isUnknown ? " ds-unknown" : ""}">
          <div class="ds-namerow">
            <span class="ds-name">${name}</span>
            <span class="ds-trips">${r.trips != null ? r.trips : DASH} viajes</span>
          </div>
          <div class="ds-track"><div class="ds-fill" style="width:${pct}%"></div></div>
          <div class="ds-vals">
            <b>${fmt(km, 0)}</b> km &nbsp;&middot;&nbsp;
            ${hrs} &nbsp;&middot;&nbsp;
            <b>${fmt(r.energy_kwh, 1)}</b> kWh &nbsp;&middot;&nbsp;
            <span class="ds-cons">${cons}</span>
          </div>
        </div>`;
    }).join("");

    this.innerHTML = `
      <ha-card>
        <div class="ds-head">Conductores (${winDays} d\xEDs)
          <span class="ds-tot">${known.length} identificado${known.length !== 1 ? "s" : ""}</span>
        </div>
        <div class="ds-list">${rowsHtml}</div>
        <style>
          .ds-head{display:flex;justify-content:space-between;align-items:baseline;
                   padding:14px 16px 10px;font-weight:600;font-size:1.05em;}
          .ds-tot{color:var(--secondary-text-color);font-weight:400;font-size:.8em;}
          .ds-list{display:flex;flex-direction:column;gap:10px;padding:0 16px 16px;}
          .ds-row{display:flex;flex-direction:column;gap:4px;}
          .ds-unknown{opacity:.55;}
          .ds-namerow{display:flex;justify-content:space-between;align-items:baseline;}
          .ds-name{font-weight:700;font-size:.95em;color:var(--primary-text-color);}
          .ds-trips{font-size:.78em;color:var(--secondary-text-color);}
          .ds-track{height:9px;border-radius:5px;background:var(--divider-color);overflow:hidden;}
          .ds-fill{height:100%;border-radius:5px;
                   background:linear-gradient(90deg,var(--primary-color),var(--info-color,#039be5));}
          .ds-unknown .ds-fill{background:var(--secondary-text-color);}
          .ds-vals{font-size:.8em;color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
          .ds-vals b{color:var(--primary-text-color);}
          .ds-cons{color:var(--success-color,#43a047);font-weight:600;}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-driver-stats-card", EvDriverStatsCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-driver-stats-card", name: "EV Trip — driver stats", description: "Per-driver usage over 30 days (sensor.<device>_driver_stats_30_days)." });

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
  connectedCallback() {
    if (this._clickBound) return;
    this._clickBound = true;
    this.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest(".cs-full[data-full]");
      if (b && this.contains(b)) {
        ev.stopPropagation();
        const ent = b.getAttribute("data-full");
        if (ent && this._hass) this._hass.callService("input_boolean", "toggle", { entity_id: ent });
      }
    });
  }
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
    if (!this._clickBound && typeof this.addEventListener === "function") this.connectedCallback();
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
        .cs-full{margin-left:auto;flex:0 0 auto;cursor:pointer;display:inline-flex;align-items:center;gap:4px;
                 border:1px solid var(--divider-color);border-radius:999px;padding:5px 11px;font-size:.82em;font-weight:700;
                 background:var(--card-background-color);color:var(--secondary-text-color);font-variant-numeric:tabular-nums;}
        .cs-full ha-icon{--mdc-icon-size:16px;}
        .cs-full.on{background:rgba(67,160,71,.18);color:var(--success-color,#43a047);border-color:var(--success-color,#43a047);}
        .cs-eta{display:flex;align-items:center;gap:7px;margin:0 16px 8px;padding:8px 12px;
                border-radius:10px;background:rgba(67,160,71,.12);color:var(--success-color,#43a047);
                font-size:.9em;font-variant-numeric:tabular-nums;}
        .cs-eta ha-icon{--mdc-icon-size:18px;flex:0 0 auto;}
        .cs-eta b{font-weight:800;}
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
      // Live AC→DC charging efficiency (logger current_charge_efficiency, fed by
      // the EVSE power sensor). Shown as a tile only once it has a real value.
      const chargeEff = parseFloat(((this._hass.states[`sensor.${D}_current_charge_efficiency`] || {}).state));
      // ETA: energy still needed ÷ current power. Honours an optional charge
      // target (e.g. 80%) so the estimate matches where you actually stop —
      // energy-to-target is derived from the pack capacity (battery_energy +
      // energy_to_full) and the gap between the current SoC and the target.
      const etf = parseFloat(((this._hass.states[`sensor.${D}_energy_to_full_charge`] || {}).state));
      const batt = parseFloat(((this._hass.states[`sensor.${D}_battery_energy`] || {}).state));
      // Target = configured (default 100), overridden to 100 when the "full"
      // toggle (input_boolean.<D>_charge_full) is on.
      const baseTarget = Math.min(100, Math.max(1, Number(this._config.chargeTarget) || 100));
      const fullEnt = this._config.chargeFullEntity || (D ? `input_boolean.${D}_charge_full` : null);
      const hasFullToggle = fullEnt && has(this._hass, fullEnt);
      const fullOn = hasFullToggle && String(this._hass.states[fullEnt].state).toLowerCase() === "on";
      const target = fullOn ? 100 : baseTarget;
      const fullToggle = hasFullToggle
        ? `<button class="cs-full${fullOn ? " on" : ""}" data-full="${_esc(fullEnt)}"><ha-icon icon="${fullOn ? "mdi:battery-high" : "mdi:battery-80"}"></ha-icon>${fullOn ? "100%" : baseTarget + "%"}</button>`
        : "";
      let etaHtml = "";
      if (charging && st.power != null && st.power > 0.1) {
        let need = etf, label = "Full";
        if (target < 100 && st.soc != null && !isNaN(batt) && !isNaN(etf)) {
          const capacity = batt + etf; // full pack kWh
          need = capacity * Math.max(0, target - st.soc) / 100;
          label = `To ${target}%`;
        }
        if (!isNaN(need) && need > 0.05) {
          const etaMin = (need / st.power) * 60;
          const etaStr = etaMin >= 60 ? `${Math.floor(etaMin / 60)}h ${Math.round(etaMin % 60)}m` : `${Math.round(etaMin)} min`;
          const ready = new Date(Date.now() + etaMin * 60000);
          const p2 = (n) => String(n).padStart(2, "0");
          etaHtml =
            `<div class="cs-eta"><ha-icon icon="mdi:timer-sand"></ha-icon>` +
            `<span>${label} in <b>~${etaStr}</b> · ${num(need, 1)} kWh left · ready ≈ <b>${p2(ready.getHours())}:${p2(ready.getMinutes())}</b></span></div>`;
        } else if (target < 100 && st.soc != null && st.soc >= target) {
          etaHtml = `<div class="cs-eta"><ha-icon icon="mdi:check-circle-outline"></ha-icon><span><b>${target}%</b> target reached</span></div>`;
        }
      }
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
            ${fullToggle}
          </div>
          ${etaHtml}
          ${curveSvg()}
          <div class="cs-tiles">
            ${tile("mdi:battery-charging-high", "SoC", num(st.soc, 0), "%")}
            ${tile("mdi:lightning-bolt", "Added", num(energy, 2), "kWh")}
            ${tile("mdi:flash", "Power", num(st.power, 1), "kW")}
            ${tile("mdi:timer-outline", "Time", dur, "")}
            ${charging && !isNaN(chargeEff) && chargeEff > 0 ? tile("mdi:gauge", L("Efficiency", "Eficiencia"), chargeEff.toFixed(0), "%") : ""}
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
// Custom card: the LIVE trip in progress, for the Driving screen. Shows tiles
// (distance/duration/energy/efficiency/avg speed/SoC used + cost/score) only
// while a trip is active (current_trip_distance > 0); renders nothing otherwise.
// ==========================================================================
class EvTripActiveCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._device = this._config.device || null;
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  getCardSize() { return 4; }
  _render() {
    if (!this._hass) return;
    const D = this._device || detectDevice(this._hass);
    this._device = D;
    const DASH = "—";
    const num = (id) => { const e = this._hass.states[`sensor.${D}_${id}`]; const v = e ? parseFloat(e.state) : NaN; return isNaN(v) ? null : v; };
    const dist = num("current_trip_distance");
    if (dist == null || dist <= 0) { this.innerHTML = ""; return; } // not driving → hide
    const f = (v, dp) => (v == null ? DASH : Number(v).toFixed(dp == null ? 0 : dp));
    const dur = num("current_trip_duration");
    const energy = num("current_trip_energy");
    const cons = num("current_trip_consumption");
    const spd = num("current_trip_average_speed");
    const soc = num("current_trip_battery_used");
    const cost = num("current_trip_cost");
    const score = num("current_trip_score");
    const tile = (icon, label, value, unit, color) =>
      `<div class="at-t"><ha-icon class="at-ti" icon="${icon}"></ha-icon><div class="at-tl">${_esc(label)}</div>` +
      `<div class="at-tv"${color ? ` style="color:${color}"` : ""}>${value}<span class="at-tu">${unit ? " " + _esc(unit) : ""}</span></div></div>`;
    const extra =
      (cost != null ? tile("mdi:cash", "Cost", f(cost, 2), "€") : "") +
      (score != null ? tile("mdi:star", "Score", f(score, 1), "", _scoreColor(score)) : "");
    this.innerHTML = `
      <ha-card>
        <div class="at-head">
          <span class="at-badge"><ha-icon icon="mdi:steering"></ha-icon></span>
          <div><div class="at-title">🟢 Trip in progress</div><div class="at-sub">live · updates as you drive</div></div>
        </div>
        <div class="at-tiles">
          ${tile("mdi:map-marker-distance", "Distance", f(dist, 1), "km")}
          ${tile("mdi:timer-outline", "Duration", f(dur), "min")}
          ${tile("mdi:lightning-bolt", "Energy", f(energy, 2), "kWh")}
          ${tile("mdi:chart-line", "Efficiency", f(cons, 1), "kWh/100")}
          ${tile("mdi:speedometer", "Avg speed", f(spd, 1), "km/h")}
          ${tile("mdi:battery-minus", "SoC used", f(soc, 1), "%")}
          ${extra}
        </div>
        <style>
          .at-head{display:flex;align-items:center;gap:10px;padding:14px 16px 8px;}
          .at-badge{flex:0 0 auto;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                    background:rgba(67,160,71,.18);}
          .at-badge ha-icon{--mdc-icon-size:23px;color:var(--success-color,#43a047);}
          .at-title{font-weight:700;}
          .at-sub{color:var(--secondary-text-color);font-size:.82em;}
          .at-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:6px 12px 14px;}
          .at-t{background:var(--secondary-background-color,var(--card-background-color));border:1px solid var(--divider-color);
                border-radius:12px;padding:9px 6px;display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center;}
          .at-ti{--mdc-icon-size:18px;color:var(--secondary-text-color);}
          .at-tl{font-size:.6em;letter-spacing:.04em;text-transform:uppercase;color:var(--secondary-text-color);line-height:1.2;}
          .at-tv{font-size:1.2em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1;}
          .at-tu{font-size:.55em;font-weight:600;color:var(--secondary-text-color);}
        </style>
      </ha-card>`;
  }
}
customElements.define("ev-trip-active-card", EvTripActiveCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ev-trip-active-card", name: "EV Trip — live trip", description: "The in-progress trip (shown only while driving)." });

// ==========================================================================
// Custom card: a polished "glance" row for the Driving screen — outside &
// cabin temperature + odometer, each as a tile with a color-coded gradient
// icon chip (temps shift cold→hot). Renders only the tiles whose entities
// exist; nothing if none were passed.
// ==========================================================================
class EvTripGlanceCard extends HTMLElement {
  setConfig(config) { this._config = config || {}; }
  set hass(hass) { this._hass = hass; this._render(); }
  getCardSize() { return 1; }
  // Cold → hot gradient stops for a temperature in °C.
  _tempColor(c) {
    if (c == null || isNaN(c)) return ["#90a4ae", "#607d8b"];
    if (c < 5)  return ["#42a5f5", "#1565c0"]; // cold — blue
    if (c < 15) return ["#26c6da", "#00838f"]; // cool — cyan
    if (c < 25) return ["#66bb6a", "#2e7d32"]; // mild — green
    if (c < 32) return ["#ffa726", "#ef6c00"]; // warm — orange
    return ["#ef5350", "#c62828"];             // hot — red
  }
  // Empty → full gradient stops for a battery state of charge (%).
  _battColor(p) {
    if (p == null || isNaN(p)) return ["#90a4ae", "#607d8b"];
    if (p < 15) return ["#ef5350", "#c62828"]; // critical — red
    if (p < 30) return ["#ffa726", "#ef6c00"]; // low — orange
    if (p < 55) return ["#ffca28", "#f9a825"]; // amber
    if (p < 80) return ["#9ccc65", "#558b2f"]; // good — light green
    return ["#66bb6a", "#2e7d32"];             // full — green
  }
  // Battery icon matching the level (and a charging bolt while charging).
  _battIcon(p, charging) {
    if (p == null || isNaN(p)) return "mdi:battery-off-outline";
    const step = Math.max(0, Math.min(100, Math.round(p / 10) * 10));
    if (charging) return step <= 0 ? "mdi:battery-charging-outline" : `mdi:battery-charging-${step}`;
    if (step >= 100) return "mdi:battery";
    if (step <= 0) return "mdi:battery-outline";
    return `mdi:battery-${step}`;
  }
  _render() {
    if (!this._hass) return;
    _setUiLang(this._hass);
    const cfg = this._config || {};
    const stOf = (id) => (id && this._hass.states[id]) || null;
    const fmt = (v, dp) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(dp));
    const tiles = [];
    const mk = (icon, label, value, unit, c1, c2) =>
      `<div class="gl-t">` +
      `<div class="gl-chip" style="background:linear-gradient(135deg,${c1},${c2})"><ha-icon icon="${icon}"></ha-icon></div>` +
      `<div class="gl-tv">${value}<span class="gl-tu">${unit ? " " + _esc(unit) : ""}</span></div>` +
      `<div class="gl-tl">${_esc(label)}</div></div>`;

    // Battery — compact, color-coded by level, charging-aware.
    const bat = stOf(cfg.batteryEntity);
    if (bat) {
      const v = parseFloat(bat.state);
      const chSt = stOf(cfg.chargingEntity);
      const charging = chSt && String(chSt.state).toLowerCase() === "charging";
      const [c1, c2] = this._battColor(v);
      tiles.push(mk(this._battIcon(v, charging), L("Battery", "Batería"), fmt(v, 0), "%", c1, c2));
    }
    // Range — the car's own range, with a cool distance icon.
    const rng = stOf(cfg.rangeEntity);
    if (rng && !isNaN(parseFloat(rng.state))) {
      const u = (rng.attributes || {}).unit_of_measurement || "km";
      tiles.push(mk("mdi:map-marker-distance", L("Range", "Autonomía"), fmt(parseFloat(rng.state), 0), u, "#26a69a", "#00695c"));
    }

    const out = stOf(cfg.outsideEntity);
    if (out) {
      const v = parseFloat(out.state), u = (out.attributes || {}).unit_of_measurement || "°C";
      const [c1, c2] = this._tempColor(v);
      tiles.push(mk("mdi:sun-thermometer", L("Outside", "Exterior"), fmt(v, 0), u, c1, c2));
    }
    const cab = stOf(cfg.cabinEntity);
    if (cab) {
      const v = parseFloat(cab.state), u = (cab.attributes || {}).unit_of_measurement || "°C";
      const [c1, c2] = this._tempColor(v);
      tiles.push(mk("mdi:car-seat", L("Cabin", "Interior"), fmt(v, 0), u, c1, c2));
    }
    const odo = stOf(cfg.odoEntity);
    if (odo && !isNaN(parseFloat(odo.state))) {
      const u = (odo.attributes || {}).unit_of_measurement || "km";
      tiles.push(mk("mdi:road-variant", L("Odometer", "Odómetro"), fmt(parseFloat(odo.state), 0), u, "#7e57c2", "#4527a0"));
    }
    if (!tiles.length) { this.innerHTML = ""; return; }
    this.innerHTML =
      `<ha-card><div class="gl-wrap">${tiles.join("")}</div>` +
      `<style>` +
      `.gl-wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:10px;padding:12px;}` +
      `.gl-t{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;` +
      `background:var(--secondary-background-color,var(--card-background-color));` +
      `border:1px solid var(--divider-color);border-radius:14px;padding:13px 6px;}` +
      `.gl-chip{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
      `box-shadow:0 2px 7px rgba(0,0,0,.20);}` +
      `.gl-chip ha-icon{--mdc-icon-size:25px;color:#fff;}` +
      `.gl-tv{font-size:1.4em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05;}` +
      `.gl-tu{font-size:.5em;font-weight:600;color:var(--secondary-text-color);}` +
      `.gl-tl{font-size:.62em;letter-spacing:.05em;text-transform:uppercase;color:var(--secondary-text-color);}` +
      `</style></ha-card>`;
  }
}
customElements.define("ev-trip-glance-card", EvTripGlanceCard);
window.customCards.push({ type: "ev-trip-glance-card", name: "EV Trip — glance", description: "Outside/cabin temperature + odometer with colored icon chips." });

// ==========================================================================
// RESTORED from v1.5.0 (user favourites, pre-2.0): Driving + Trips views.
// Additive — the 9-view equivalents stay until these are validated.
// ==========================================================================
function drivingView(D, V, hass, cfg) {
  const status = [heading("Status", "mdi:car-electric")];

  // Status glance — Battery · Range · Outside · Cabin · Odometer, all in ONE
  // card with color-coded gradient icon chips. Battery shifts red→green by
  // level (compact, next to range) and shows a charging bolt while charging;
  // temps shift cold→hot. Range uses the car's own sensor (logger range as
  // fallback). The card self-hides any tile whose entity is absent.
  const vRange = pickVehicleEntity(hass, V, "range", cfg);
  const rangeEntity = vRange || (has(hass, `sensor.${D}_range_at_recent_efficiency`) ? `sensor.${D}_range_at_recent_efficiency` : null);
  const vOut = pickVehicleEntity(hass, V, "outside_temp", cfg);
  const vCab = pickVehicleEntity(hass, V, "cabin_temp", cfg);
  const vOdo = pickVehicleEntity(hass, V, "odometer", cfg);
  status.push({
    type: "custom:ev-trip-glance-card",
    batteryEntity: has(hass, `sensor.${D}_battery_percent`) ? `sensor.${D}_battery_percent` : null,
    chargingEntity: has(hass, `sensor.${D}_charge_in_progress`) ? `sensor.${D}_charge_in_progress` : null,
    rangeEntity,
    outsideEntity: vOut || null,
    cabinEntity: vCab || null,
    odoEntity: hasVal(hass, vOdo) ? vOdo : null,
  });

  // Live trip in progress — right after the battery; self-hides when not driving.
  status.push({ type: "custom:ev-trip-active-card", device: D });

  // Live location map — shown ONLY while a trip is in progress, so you can see
  // where the car is in near-real-time (the marker moves as the device_tracker
  // updates). hours_to_show:1 also draws the recent path. Conditional on the
  // logger's current_trip_distance > 0, so it disappears once the trip ends.
  const liveLoc = (cfg && cfg.location_entity) || pickVehicleEntity(hass, V, "location", cfg);
  if (liveLoc && has(hass, `sensor.${D}_current_trip_distance`)) {
    status.push({
      type: "conditional",
      conditions: [{ condition: "numeric_state", entity: `sensor.${D}_current_trip_distance`, above: 0 }],
      card: {
        type: "map",
        title: L("Live location", "Ubicación en vivo"),
        entities: [{ entity: liveLoc }],
        hours_to_show: 1,
        default_zoom: 15,
        aspect_ratio: "16:9",
      },
    });
  }

  // Live charge status (charging / paused-while-plugged / last-charge summary).
  status.push({
    type: "custom:ev-charge-status-card",
    device: D,
    plugEntity: (cfg && cfg.plug_entity) || pickVehicleEntity(hass, V, "plug", cfg),
    chargingEntity: pickVehicleEntity(hass, V, "charging", cfg),
    powerEntity: resolveChargePower(hass, D, cfg),
    chargeTarget: cfg && cfg.charge_target, // % to charge to (default 100)
  });

  // (Battery · Range · Outside · Cabin · Odometer are all rendered by the
  // single ev-trip-glance-card placed near the top of the status column.)

  // (The live in-progress trip is rendered by the ev-trip-active-card placed
  // right after the battery above — it self-hides when no trip is open.)

  // Shared vehicle entities (also used by the journey card below).
  const jTempEntity = (cfg && cfg.outside_temp_entity) || pickVehicleEntity(hass, V, "outside_temp", cfg);
  const jLocationEntity = (cfg && cfg.location_entity) || pickVehicleEntity(hass, V, "location", cfg);
  const jTripPowerEntity = (cfg && cfg.trip_power_entity) || (has(hass, `sensor.${V}_power`) ? `sensor.${V}_power` : null);
  // Last trip — rendered by the trip-list card in "latestOnly" mode so it looks
  // exactly like an expanded row in the Trips list (location, battery, regen,
  // route map), using the reliable recent_trips[0] instead of last_trip_* sensors.
  const now = [
    {
      type: "custom:ev-trip-list-card",
      device: D,
      latestOnly: true,
      title: L("Last trip", "Último viaje"),
      locationEntity: jLocationEntity,
      tempEntity: jTempEntity,
      tripPowerEntity: jTripPowerEntity,
    },
  ];

  // (The live "Charging now" details are already rendered by the richer
  // ev-charge-status-card in the status grid above — no duplicate glance here.)

  // Live time-series: charging (SoC + power) and driving (SoC + speed + range).
  // Real entity-history apex charts (graph_span based) — they render fine,
  // unlike the category apex charts we replaced. Resolved generically so they
  // work across car integrations; each series is added only when its entity
  // currently has a value, and a chart is shown only with SoC + ≥1 other line.
  // Gated on apexcharts so the heading never orphans when the dep is absent.
  // These go in the RIGHT column (with Last trip below them).
  const chartCards = [];
  if (hass && hasCard("apexcharts-card")) {
    // Resolve by EXISTENCE (not current value): apex plots recorder history,
    // so a momentarily-unknown reading (e.g. a Tesla asleep) must not hide a
    // chart that still has hours of real history behind it.
    const socEnt =
      (cfg && cfg.soc_entity && has(hass, cfg.soc_entity) && cfg.soc_entity) ||
      (has(hass, `sensor.${D}_battery_percent`) ? `sensor.${D}_battery_percent` : null) ||
      (has(hass, `sensor.${V}_battery_level`) ? `sensor.${V}_battery_level` : null);
    const socSeries = socEnt ? [{ entity: socEnt, name: "SoC %", yaxis_id: "soc", stroke_width: 2, color: "#4CAF50" }] : [];

    // --- Charging (6h): SoC + charge power (+ optional charge curve) -------
    const powerEnt = resolveChargePower(hass, D, cfg);
    const unitOf = (e) => ((hass.states[e] || {}).attributes || {}).unit_of_measurement || "";
    const wTransform = (e) => (/^w$/i.test(unitOf(e).trim()) ? "return x / 1000;" : undefined); // only W→kW
    const curveEnt = (cfg && cfg.charge_curve_entity) || `sensor.${V}_charge_curve`;
    const chgSeries = socSeries.slice();
    if (powerEnt && has(hass, powerEnt)) chgSeries.push({ entity: powerEnt, name: "Power kW", yaxis_id: "power", stroke_width: 2, color: "#9C27B0", ...(wTransform(powerEnt) ? { transform: wTransform(powerEnt) } : {}) });
    if (curveEnt !== powerEnt && has(hass, curveEnt)) chgSeries.push({ entity: curveEnt, name: "Curve kW", yaxis_id: "power", stroke_width: 1, color: "#FFC107", ...(wTransform(curveEnt) ? { transform: wTransform(curveEnt) } : {}) });
    if (chgSeries.length >= 2) {
      chartCards.push(
        heading("Charging (6h)", "mdi:ev-station"),
        apexChart({
          title: "Charging (6h)", chartType: "line", graphSpan: "6h", headerShowStates: true,
          yaxis: [{ id: "soc", min: 0, max: 100, decimals: 0, apex_config: { forceNiceScale: true } }, { id: "power", opposite: true, min: 0, decimals: 1, apex_config: { forceNiceScale: true } }],
          series: chgSeries,
        })
      );
    }

    // --- Driving (3h): SoC + speed + range --------------------------------
    const speedEnt = (cfg && cfg.speed_entity) || pickVehicleEntity(hass, V, "speed", cfg);
    const rangeEnt = pickVehicleEntity(hass, V, "range", cfg) || (has(hass, `sensor.${D}_range_at_recent_efficiency`) ? `sensor.${D}_range_at_recent_efficiency` : null);
    const drvSeries = socEnt ? [{ entity: socEnt, name: "SoC %", yaxis_id: "soc", stroke_width: 2, color: "#03A9F4" }] : [];
    if (speedEnt && has(hass, speedEnt)) drvSeries.push({ entity: speedEnt, name: "Speed km/h", yaxis_id: "speed", stroke_width: 2, color: "#F44336" });
    if (rangeEnt && has(hass, rangeEnt)) drvSeries.push({ entity: rangeEnt, name: "Range km", yaxis_id: "speed", stroke_width: 1, color: "#9E9E9E" });
    if (drvSeries.length >= 2) {
      chartCards.push(
        heading("Driving (3h)", "mdi:speedometer"),
        apexChart({
          title: "Driving (3h)", chartType: "line", graphSpan: "3h", headerShowStates: true,
          yaxis: [{ id: "soc", min: 0, max: 100, decimals: 0, apex_config: { forceNiceScale: true } }, { id: "speed", opposite: true, min: 0, decimals: 0, apex_config: { forceNiceScale: true } }],
          series: drvSeries,
        })
      );
    }
  }

  // Two fixed columns (exactly two sections, so each takes one column):
  //  • LEFT  = the sensor/status list, with Today's journey below it.
  //  • RIGHT = the live charts (Charging, Driving) with Last trip below them.
  const leftCards = status.concat([
    heading("Today's journey", "mdi:map-marker-path"),
    { type: "custom:ev-trip-journey-card", device: D, tempEntity: jTempEntity, locationEntity: jLocationEntity, tripPowerEntity: jTripPowerEntity },
  ]);
  const rightCards = chartCards.concat(now);

  const sections = [grid(leftCards), grid(rightCards)];

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
    `{%- set tot = state_attr(rsrc, 'totals') %}\n` +
    `{%- set cy = CUR.get(cheapest.currency, cheapest.currency or '€') if cheapest else '€' %}\n` +
    `{%- macro place(v) %}{{ '—' if not v else ('Away' if v == 'not_home' else ('Home' if v == 'home' else v)) }}{%- endmacro %}\n` +
    `### 🏆 Records ({{ states(rsrc) }} trips all-time)\n` +
    `{%- if tot is mapping %}\n**{{ tot.distance_km | round(0) }} km** · **{{ tot.energy_kwh | round(0) }} kWh** · **{{ tot.cost | round(2) }} {{ cy }}** total\n{%- endif %}\n` +
    `\n| Record | When | Where | Value |\n|---|---|---|---:|\n` +
    `{%- if best.value is defined %}\n| 🥇 Best score | {{ as_timestamp(best.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ place(best.destination) | trim }} | **{{ best.value }}** |\n{%- endif %}\n` +
    `{%- if longest %}\n| 📏 Longest | {{ as_timestamp(longest.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ place(longest.destination) | trim }} | **{{ longest.value }} km** |\n{%- endif %}\n` +
    `{%- if efficient %}\n| 🪫 Most efficient | {{ as_timestamp(efficient.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ place(efficient.destination) | trim }} | **{{ efficient.value }} kWh/100** |\n{%- endif %}\n` +
    `{%- if cheapest %}\n| 💶 Cheapest | {{ as_timestamp(cheapest.ended_at) | timestamp_custom('%d/%m/%y') }} | {{ place(cheapest.destination) | trim }} | **{{ cheapest.value }} {{ cy }}** |\n{%- endif %}\n` +
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
  const tempEntity = (cfg && cfg.outside_temp_entity) || (hass ? pickVehicleEntity(hass, V, "outside_temp", cfg) : null);
  const locationEntity = (cfg && cfg.location_entity) || (hass ? pickVehicleEntity(hass, V, "location", cfg) : null);
  // Signed power sensor (positive = energy back into the pack while driving) →
  // lets the trip detail estimate per-trip regen when the logger lacks it.
  const tripPowerEntity =
    (cfg && cfg.trip_power_entity) ||
    (hass && has(hass, `sensor.${V}_power`) ? `sensor.${V}_power` : null);
  // Right column = the helper-backed Search & filter card ONLY when the input
  // helpers exist (input_text.<D>_trip_search is the canary). Without them the
  // ev-trip-list-card still shows all trips newest-first, so we drop the right
  // column entirely and let the list span both columns.
  const hasFilter = hass && has(hass, `input_text.${D}_trip_search`);
  const listCard = {
    type: "custom:ev-trip-list-card",
    device: D, title: "Trips",
    plugEntity, chargingEntity, powerEntity, tempEntity, locationEntity, tripPowerEntity,
  };
  const sections = [
    { type: "grid", column_span: 2, cards: [heading("Last 30 days", "mdi:calendar-range"), trips30dKpis(D)] },
  ];
  if (hasFilter) {
    sections.push(grid([heading("Trips", "mdi:map-marker-path"), listCard]));
    sections.push(grid([heading("Search & filter", "mdi:filter-variant"), {
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
    }]));
  } else {
    // No filter helpers → trips list full-width.
    sections.push({ type: "grid", column_span: 2, cards: [heading("Trips", "mdi:map-marker-path"), listCard] });
  }
  return { title: "Trips", path: "trips", icon: "mdi:map-search", type: "sections", max_columns: 2, sections };
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
    _setUiLang(hass); // follow the installed HA language (English by default)
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
      // Restored pre-2.0 favourites first (Driving + Trips with search).
      drivingView(D, V, hass, config),
      tripsView(D, hass, V, config),
      calendarioView(D, hass, V, config),
      tendenciasView(D, hass, config),
      patternsView(D, hass),
      eficienciaView(D, hass, V, config),
      // (Records/Tops view removed — per-trip "biggest/best" rankings weren't useful.)
      cargasView(D, hass, V, config),
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
