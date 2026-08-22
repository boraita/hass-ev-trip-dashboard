/*! ev-abrp-card — ABRP link status.
 *
 * The card's whole job is making an invisible integration observable, so the
 * tests are about what it *says* in each state the ABRP link can be in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, makeCard, fakeHass, st } from "./harness.mjs";

const { cards } = loadDashboard();
const TYPE = "ev-abrp-card";
const SW = "switch.abrp_push";
const SOC = "sensor.sealion_7_abrp_next_charge_soc";
const CAR = "byd:sealion:25:82:rwd";

/** Unix seconds, `s` seconds in the past — the shape of last_sent_at. */
const epochAgo = (s) => Date.now() / 1000 - s;

/** A card already fed one hass update. */
function rendered(states, config = { device: "sealion_7" }) {
  const card = makeCard(cards, TYPE, config);
  const hass = fakeHass(states);
  card.hass = hass;
  return { card, hass, html: card.innerHTML };
}

test("is registered and advertises grid options", () => {
  const card = makeCard(cards, TYPE, { device: "sealion_7" });
  const grid = card.getGridOptions();
  assert.ok(grid.columns, "must declare columns for the sections view");
  assert.ok(grid.min_columns <= grid.columns);
  assert.ok(grid.rows >= grid.min_rows);
});

test("renders nothing when ABRP is not configured", () => {
  const { html } = rendered({ "sensor.sealion_7_recent_trips": st("12") });
  assert.equal(html, "", "no ABRP entities → the card must stay invisible");
});

test("push on with an active route: sending + target SoC", () => {
  const { html } = rendered({
    [SW]: st("on", { last_sent_at: epochAgo(20), interval_s: 40, car_model: CAR }),
    [SOC]: st("23"),
  });
  assert.match(html, /ab-pill ok/);
  assert.match(html, /enviando/);
  assert.match(html, /hace 20 s/);
  assert.match(html, /cada 40 s/);
  assert.match(html, /23<span class="ab-u">%/);
  assert.match(html, /ruta activa/);
});

test("push off: paused, and the last send shown as a clock time", () => {
  const { html } = rendered({
    [SW]: st("off", { last_sent_at: epochAgo(3600), interval_s: 40, car_model: CAR }),
    [SOC]: st("unknown"),
  });
  assert.match(html, /ab-pill idle/);
  assert.match(html, /en pausa/);
  assert.match(html, /último envío a las \d{1,2}[:.]\d{2}/);
  // The resting state of the sensor must be explained, not left blank.
  assert.match(html, /sin ruta activa/);
  assert.match(html, /ab-v">—/);
  assert.doesNotMatch(html, /cada 40 s/, "interval is noise while paused");
});

test("silent push while driving reads as a problem", () => {
  const { html } = rendered({
    [SW]: st("on", { last_sent_at: epochAgo(600), interval_s: 40 }),
    [SOC]: st("unavailable"),
    [`sensor.${"sealion_7"}_current_trip_distance`]: st("12.4"),
  });
  assert.match(html, /ab-pill warn/);
  assert.match(html, /sin enviar/);
});

test("silent push with the car parked is not a problem", () => {
  // The logger pushes off the car integration's polls, so a parked car stops
  // producing them. Warning here would fire every single night.
  const parked = {
    [SW]: st("on", { last_sent_at: epochAgo(28800), interval_s: 40 }),
    [`sensor.sealion_7_current_trip_distance`]: st("0"),
  };
  const { html } = rendered(parked);
  assert.match(html, /ab-pill idle/);
  assert.match(html, /en reposo/);
  assert.doesNotMatch(html, /ab-pill warn/);

  // Same with no trip sensor at all: still no false alarm.
  const { html: bare } = rendered({ [SW]: parked[SW] });
  assert.doesNotMatch(bare, /ab-pill warn/);
});

test("a rejected sample is named, and outranks any silence heuristic", () => {
  // logger v0.8.20+: ABRP answers a rejected sample with HTTP 200 and an
  // error body, so a push can look alive while ABRP stores nothing.
  const { html } = rendered({
    [SW]: st("on", {
      last_sent_at: epochAgo(20),
      interval_s: 40,
      car_model: CAR,
      last_error: "error: Unknown car_model 'byd:sealion'",
    }),
  });
  assert.match(html, /ab-pill warn/);
  assert.match(html, /rechazado/);
  assert.match(html, /rechazó la última muestra/);
  // The reason is shown, with the redundant "error:" prefix trimmed.
  assert.match(html, /Unknown car_model &#39;byd:sealion&#39;/);
  assert.doesNotMatch(html, />error: /);
});

test("no last_error attribute (older logger) changes nothing", () => {
  const { html } = rendered({
    [SW]: st("on", { last_sent_at: epochAgo(20), interval_s: 40, car_model: CAR }),
  });
  assert.match(html, /ab-pill ok/);
  assert.doesNotMatch(html, /rechaz/);
  // An explicit null must read the same as an absent attribute.
  const { html: nulled } = rendered({
    [SW]: st("on", { last_sent_at: epochAgo(20), interval_s: 40, last_error: null }),
  });
  assert.match(nulled, /ab-pill ok/);
  assert.doesNotMatch(nulled, /rechaz/);
});

test("never sent yet says so instead of showing a bogus time", () => {
  const { html } = rendered({ [SW]: st("on", { interval_s: 40 }) });
  assert.match(html, /nunca ha enviado/);
  assert.doesNotMatch(html, /NaN|Invalid Date/);
});

test("sensor without the switch degrades to read-only", () => {
  const { html } = rendered({ [SOC]: st("80") });
  assert.match(html, /solo lectura/);
  assert.match(html, /80<span class="ab-u">%/);
  assert.doesNotMatch(html, /data-toggle/, "no switch → nothing to toggle");
});

test("tapping the push row toggles the resolved switch", () => {
  const { card, hass } = rendered({
    [SW]: st("off", { last_sent_at: epochAgo(60), interval_s: 40, car_model: CAR }),
  });
  card.click("[data-toggle]");
  // Field-by-field: the card builds its payload inside the vm sandbox, so the
  // object's prototype is from another realm and deepStrictEqual would reject
  // a structurally identical value.
  assert.equal(hass.calls.length, 1);
  assert.equal(hass.calls[0].domain, "switch");
  assert.equal(hass.calls[0].service, "toggle");
  assert.equal(hass.calls[0].data.entity_id, SW);
});

test("the deep link carries the configured car model", () => {
  const { html } = rendered({ [SW]: st("on", { car_model: CAR, interval_s: 40 }) });
  assert.match(html, /abetterrouteplanner\.com\/\?car_model=byd%3Asealion%3A25%3A82%3Arwd/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("no car model configured: the link still works and says why it's bare", () => {
  const { html } = rendered({ [SW]: st("on", { interval_s: 40 }) });
  assert.match(html, /abetterrouteplanner\.com\/"/);
  assert.match(html, /modelo de coche sin configurar/);
});

test("re-renders when only an attribute moved (last_sent_at)", () => {
  const card = makeCard(cards, TYPE, { device: "sealion_7" });
  const first = st("on", { last_sent_at: epochAgo(80), interval_s: 40 });
  card.hass = fakeHass({ [SW]: first });
  assert.match(card.innerHTML, /hace 80 s|hace 1 min/);

  // Same state value, newer attributes — the dirty-check keys off
  // last_updated, which HA bumps on attribute-only writes.
  card.hass = fakeHass({
    [SW]: st("on", { last_sent_at: epochAgo(5), interval_s: 40 }, new Date(Date.now() + 1000).toISOString()),
  });
  assert.match(card.innerHTML, /hace 5 s/);
});

test("skips the rebuild when nothing it reads has changed", () => {
  const card = makeCard(cards, TYPE, { device: "sealion_7" });
  const states = { [SW]: st("on", { last_sent_at: epochAgo(20), interval_s: 40 }) };
  card.hass = fakeHass(states);
  const firstHtml = card.innerHTML;
  card.innerHTML = "SENTINEL";
  card.hass = fakeHass(states); // identical signature
  assert.equal(card.innerHTML, "SENTINEL", "should not have re-rendered");
  // …but a re-attach must always repaint, or the card comes back blank.
  card.connectedCallback();
  assert.equal(card.innerHTML, firstHtml);
});

test("picks the switch belonging to its own device when two cars are logged", () => {
  const { html } = rendered({
    // Neither id is device-prefixed — the logger names both after the entry.
    "switch.abrp_push_2": st("on", { friendly_name: "Model 3", last_sent_at: epochAgo(10), interval_s: 40 }),
    "switch.abrp_push_3": st("off", { friendly_name: "Sealion 7", last_sent_at: epochAgo(10), interval_s: 40 }),
  }, { device: "sealion_7" });
  assert.match(html, /en pausa/, "must resolve to Sealion 7's (off) switch, not the Tesla's");
});

test("never leaks undefined or NaN into the markup", () => {
  const cases = [
    { [SW]: st("on", {}) },
    { [SW]: st("unavailable", { interval_s: 40 }) },
    { [SOC]: st("unknown") },
    { [SW]: st("off", { last_sent_at: 0, interval_s: 0 }), [SOC]: st("") },
  ];
  for (const states of cases) {
    const { html } = rendered(states);
    assert.doesNotMatch(html, /undefined|NaN|Invalid Date/, JSON.stringify(states));
  }
});
