/*! The `custom:ev-trip` dashboard strategy — generation smoke tests.
 *
 * Most of this project's recent bug fixes were the same shape: a view blew up
 * (or silently emptied) because a sensor was missing, `unknown`, or its list
 * attribute was empty — the exact state of a freshly installed logger. These
 * tests generate every view against that state and against a populated one,
 * and fail on a throw or on malformed cards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, fakeHass, st } from "./harness.mjs";

const { cards } = loadDashboard();
const Strategy = cards.get("ll-strategy-dashboard-ev-trip");
const D = "sealion_7";

/** Every card in a generated dashboard, flattened out of views/sections. */
function allCards(dash) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type) out.push(node);
    for (const k of ["cards", "sections", "views", "card", "badges"]) if (node[k]) walk(node[k]);
  };
  walk(dash.views);
  return out;
}

/** A logger that exists but has never recorded anything. */
function freshInstall() {
  const states = {
    [`sensor.${D}_recent_trips`]: st("0", { trips: [] }),
    [`sensor.${D}_recent_charges`]: st("0", { charges: [] }),
    [`sensor.${D}_recent_journeys`]: st("0", { journeys: [] }),
  };
  for (const s of [
    "battery_percent", "battery_energy", "distance_this_month", "energy_this_month",
    "cost_this_month", "trips_this_month", "avg_consumption_30_days", "charge_in_progress",
    "current_trip_distance", "last_trip_distance", "monthly_history", "weekly_history",
    "daily_km_60d", "trip_patterns", "trip_records", "tops", "battery_soh",
    "expected_battery_soh", "consumption_by_temperature", "consumption_by_season",
    "consumption_by_time_of_day", "driver_stats_30_days", "current_journey",
    "last_journey", "range_at_recent_efficiency", "current_charge_power",
  ]) states[`sensor.${D}_${s}`] = st("unknown");
  return states;
}

/** The same install with plausible data in the list attributes. */
function populated() {
  const states = freshInstall();
  const now = new Date().toISOString();
  states[`sensor.${D}_recent_trips`] = st("2", {
    trips: [
      {
        id: 2, journey_id: 7, started_at: now, ended_at: now, distance_km: 42.3,
        duration_min: 38, energy_kwh: 7.1, consumption_kwh_100km: 16.8, cost: 1.17,
        currency: "EUR", score: 88, origin: "home", destination: "Granada",
      },
      {
        id: 1, journey_id: null, started_at: now, ended_at: now, distance_km: 3.1,
        duration_min: 9, energy_kwh: null, consumption_kwh_100km: null, cost: null,
        currency: "EUR", score: null, origin: "home", destination: "not_home",
        confidence: "estimated",
      },
    ],
  });
  states[`sensor.${D}_recent_charges`] = st("1", {
    charges: [{
      charge_id: 9, started_at: now, ended_at: now, kwh: 21.4, cost: 3.53,
      price_per_kwh: 0.165, currency: "EUR", location: "home", soc_start: 42,
      soc_end: 68, evse_energy_kwh: 23.1, charging_efficiency_pct: 92.6,
    }],
  });
  states[`sensor.${D}_battery_percent`] = st("68");
  states[`sensor.${D}_distance_this_month`] = st("2379");
  states[`sensor.${D}_avg_consumption_30_days`] = st("16.3");
  return states;
}

const generate = (states, config = {}) => Strategy.generate({ device: D, ...config }, fakeHass(states));

test("the strategy is registered", () => {
  assert.ok(Strategy, "ll-strategy-dashboard-ev-trip must be defined");
  assert.equal(typeof Strategy.generate, "function");
});

test("explains itself instead of throwing when no logger is present", async () => {
  const dash = await Strategy.generate({}, fakeHass({}));
  assert.equal(dash.views.length, 1);
  assert.match(JSON.stringify(dash), /recent_trips/, "must tell the user what's missing");
});

for (const [label, build] of [["a fresh install", freshInstall], ["populated data", populated]]) {
  test(`generates every view with ${label}`, async () => {
    const dash = await generate(build());
    assert.ok(dash.views.length >= 5, `only ${dash.views.length} views generated`);
    for (const v of dash.views) {
      assert.ok(v.title, "every view needs a title");
      assert.ok(v.path, `view ${v.title} needs a path`);
    }
    // Paths are the URL — duplicates silently shadow a whole view.
    const paths = dash.views.map((v) => v.path);
    assert.equal(new Set(paths).size, paths.length, `duplicate view paths: ${paths}`);
  });

  test(`every card is well formed with ${label}`, async () => {
    const dash = await generate(build());
    const list = allCards(dash);
    assert.ok(list.length > 20, `only ${list.length} cards generated`);
    for (const c of list) {
      assert.equal(typeof c.type, "string");
      assert.doesNotMatch(c.type, /undefined|null/, `bad card type: ${c.type}`);
      // A custom card referencing our own device must carry the slug, or it
      // silently renders empty in production.
      if (/^custom:ev-/.test(c.type) && "device" in c) {
        assert.equal(c.device, D, `${c.type} got device=${c.device}`);
      }
    }
  });

  test(`serializes cleanly with ${label}`, async () => {
    const json = JSON.stringify(await generate(build()));
    assert.doesNotMatch(json, /"undefined"|:undefined|NaN/);
    assert.doesNotMatch(json, /sensor\.undefined|sensor\.null/);
  });
}

test("the ABRP card is wired into the Driving view", async () => {
  const dash = await generate(populated());
  const abrp = allCards(dash).filter((c) => c.type === "custom:ev-abrp-card");
  assert.equal(abrp.length, 1, "exactly one ABRP card, in Driving");
  assert.equal(abrp[0].device, D);
});
