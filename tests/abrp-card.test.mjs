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

test("does not pin its height in the sections grid", () => {
  // Regression: it declared rows:2 and the content (3 rows, 4 with a reject
  // reason) got clipped on the real dashboard. `rows` is a hard height there
  // and there is no "auto", so the card must not declare one at all — that's
  // what makes the grid fall back to the natural height.
  const card = makeCard(cards, TYPE, { device: "sealion_7" });
  const grid = card.getGridOptions ? card.getGridOptions() : null;
  if (grid) {
    assert.equal(grid.rows, undefined, "must not fix a row count");
    assert.equal(grid.min_rows, undefined, "must not fix a minimum row count");
  }
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
  // v2.139 — the resting state must still be explained, but a bare
  // `unknown` with no `status` attribute means we have not asked yet, and
  // saying "no active route" there was a claim about the planner that
  // nothing had checked.
  assert.match(html, /todavía sin consultar/);
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
      last_error: "Unknown car_model 'byd:sealion'",
    }),
  });
  assert.match(html, /ab-pill warn/);
  assert.match(html, /rechazado/);
  assert.match(html, /rechazó la última muestra/);
  // Shown verbatim and escaped — the logger already normalises the prefix.
  assert.match(html, /Unknown car_model &#39;byd:sealion&#39;/);
});

test("a reason whose prefix carries information keeps it", () => {
  // The logger strips a bare "error:" but keeps prefixes like this one.
  const { html } = rendered({
    [SW]: st("on", { interval_s: 40, last_error: "rate_limited: slow down" }),
  });
  assert.match(html, /rate_limited: slow down/);
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

// v2.139 — the two deep-link tests are gone with the link. It carried one
// parameter, opened a generic planner in a new tab, and told the driver
// nothing they could not get from the app already on their phone. The row
// it freed up now shows the pack we report, which is information that
// exists nowhere else — see "the card shows the pack it reports to ABRP".
test("the card no longer offers to open ABRP", () => {
  const { html } = rendered({ [SW]: st("on", { car_model: CAR, interval_s: 40 }) });
  assert.doesNotMatch(html, /abetterrouteplanner/);
  assert.doesNotMatch(html, /Planificar ruta/);
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


// ---------------------------------------------------------------------------
// v2.139 — the card stops guessing why there is no next-stop target, and
// starts showing what we tell ABRP.
// ---------------------------------------------------------------------------

function v139Card(states) {
  const card = makeCard(cards, "ev-abrp-card", { device: "sealion_7" });
  card.hass = fakeHass(states);
  return String(card.innerHTML).replace(/<style>[\s\S]*?<\/style>/g, "");
}

const v139 = (socState, socAttrs = {}, swAttrs = {}) => ({
  [SW]: st("on", { last_sent_at: 1787775783, car_model: "byd:sealion:25:82:rwd",
                   sent_capacity_kwh: 82.5, sent_soh_pct: 100, ...swAttrs }),
  [SOC]: st(socState, socAttrs),
});

test("a dead token is not reported as 'no active route'", () => {
  // The defect this replaces: every blank rendered "sin ruta activa en
  // ABRP", so an expired token sent the driver looking at their route
  // planner instead of at their credentials.
  const html = v139Card(v139("unknown", { status: "http_401" }));
  assert.match(html, /ABRP respondió 401/);
  assert.doesNotMatch(html, /sin ruta activa/);
});

test("a network drop says so, and an idle planner still says no route", () => {
  assert.match(v139Card(v139("unknown", { status: "network" })),
               /no se pudo conectar con ABRP/);
  const idle = v139Card(v139("unknown", { status: "no_route" }));
  assert.match(idle, /sin ruta activa en ABRP/);
  assert.doesNotMatch(idle, /ab-err/, "an idle planner is not an error");
});

test("before the first check it admits it has not looked", () => {
  // Previously indistinguishable from a confirmed absence of route.
  assert.match(v139Card(v139("unknown", {})), /todavía sin consultar/);
});

test("an active route shows its target", () => {
  const html = v139Card(v139("23", { status: "ok" }));
  assert.match(html, /de la ruta activa en ABRP/);
  assert.match(html, />23</);
});

test("the card shows the pack it reports to ABRP", () => {
  // The 2026-08-26 defect in one row: a 103.23 % SoH went to ABRP for four
  // days and nothing on screen said what we were sending.
  const html = v139Card(v139("unknown", { status: "no_route" }));
  assert.match(html, /Batería que le decimos/);
  assert.match(html, /82\.5 kWh · SoH 100 %/);
});

test("the deep link to abetterrouteplanner.com is gone", () => {
  const html = v139Card(v139("unknown", { status: "no_route" }));
  assert.doesNotMatch(html, /abetterrouteplanner/);
  assert.doesNotMatch(html, /Planificar ruta/);
});
