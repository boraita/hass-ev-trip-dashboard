/*! ev-trip-history-card, kind="charges" — the rate and its explanation.
 *
 * A charge row already showed how much went in and what it cost. What it
 * never showed was *why* it went in at that rate: driving warms the pack and
 * a warm pack accepts more power, so km-since-the-last-charge and ambient
 * temperature are most of the answer to why one DC session pulled 150 kW and
 * the next one 40. These tests are about what the row says in each case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, makeCard, fakeHass, st } from "./harness.mjs";

const { cards } = loadDashboard();
const TYPE = "ev-trip-history-card";
const RC = "sensor.sealion_7_recent_charges";

/** One charge, with the fields a v0.8.32 logger sends. */
const charge = (over = {}) => ({
  id: 67,
  charge_id: 67,
  started_at: "2026-08-23T22:11:59+02:00",
  ended_at: "2026-08-23T22:33:00+02:00",
  kwh: 13.23,
  price_per_kwh: 0.3696,
  total_cost: 4.89,
  currency: "EUR",
  soc_start: 37,
  soc_end: 54,
  location: "not_home",
  is_dcfc: true,
  price_locked: false,
  ...over,
});

/** Markup only. The card inlines a <style> block whose selector names
 *  (`cp-locked`, `chip--ctx`, …) would otherwise satisfy an assertion that
 *  the markup never actually made — the first draft of these tests passed
 *  against the stylesheet. */
const body = (html) => String(html).replace(/<style>[\s\S]*?<\/style>/g, "");

/** Charge rows are grouped per day and collapsed; the detail with the chips
 *  only exists once a day is open, so open it. */
function rendered(charges, day = "2026-08-23") {
  const card = makeCard(cards, TYPE, { device: "sealion_7", kind: "charges" });
  card.hass = fakeHass({ [RC]: st(String(charges.length), { charges }) });
  card._openId = day;
  card._render();
  return { card, html: body(card.innerHTML) };
}

test("temperature and km driven before land on the row", () => {
  const { html } = rendered([charge({ temperature_c: 28.4, km_before: 197.0 })]);
  assert.match(html, /28°C/);
  assert.match(html, /197 km/);
});

test("zero km before is stated, not hidden as missing", () => {
  // The whole point of the chip: a charge straight after another one had no
  // chance to warm the pack, and that is the diagnosis for a slow session.
  // A truthiness check would have swallowed it.
  const { html } = rendered([charge({ temperature_c: 12.0, km_before: 0 })]);
  assert.match(html, /0 km/);
});

test("an older logger with neither field renders no context chip at all", () => {
  const { html } = rendered([charge()]);
  assert.doesNotMatch(html, /chip--ctx/);
  assert.doesNotMatch(html, /undefined|NaN|null/);
});

test("a DC charge that started high says the curve was tapering", () => {
  const { html } = rendered([charge({ soc_start: 72, soc_end: 88, km_before: 40 })]);
  assert.match(html, /72%/);
  assert.match(html, /curva|curve/i);
});

test("the same start SoC on AC says nothing — the wallbox is the limit", () => {
  const { html } = rendered([
    charge({ soc_start: 72, soc_end: 88, is_dcfc: false, location: "home", km_before: 40 }),
  ]);
  assert.doesNotMatch(html, /curva|tapering/i);
});

test("peak power shows only when it beats the average", () => {
  // 13.23 kWh over 21 min is ~37.8 kW average. A 96 kW peak against that is
  // the shape of the session — it tapered — and worth a number.
  const { html: tapered } = rendered([charge({ peak_charge_power_kw: 96.0 })]);
  assert.match(tapered, /<b>96<\/b> kW peak/);
  // A flat AC charge peaks at its own average; repeating it adds nothing.
  const { html: flat } = rendered([
    charge({ kwh: 7.0, started_at: "2026-08-23T20:00:00+02:00",
             ended_at: "2026-08-23T21:00:00+02:00", peak_charge_power_kw: 7.1,
             is_dcfc: false }),
  ]);
  assert.doesNotMatch(flat, /kW peak/);
});

test("a price already set can be corrected, not just admired", () => {
  // price_locked exists so auto-detect cannot overwrite a figure the user
  // typed. It was never meant to lock the USER out, but the row rendered a
  // padlock and nothing else, so a wrong price could only be fixed from
  // Developer Tools — which is where this was found.
  const { html } = rendered([charge({ price_locked: true })]);
  assert.match(html, /cp-locked/);
  assert.match(html, /cp-unlock/, "a locked away charge offers a way back in");
});

test("a locked HOME charge offers no editor — it uses the default tariff", () => {
  const { html } = rendered([charge({ price_locked: true, location: "home" })]);
  assert.doesNotMatch(html, /cp-unlock/);
});


// ---------------------------------------------------------------------------
// v2.132 — the charger's rated power, and the verdict it makes possible.
// ---------------------------------------------------------------------------

test("41 kW out of a 50 kW unit reads as charger-limited", () => {
  const { html } = rendered([
    charge({ peak_charge_power_kw: 41.1, charger_power_kw: 50 }),
  ]);
  assert.match(html, /41\/50 kW/);
  assert.match(html, /82%/);
  assert.match(html, /limitó el poste/);
});

test("the same 41 kW out of a 150 kW unit reads as the charger failing", () => {
  // This is the whole reason charger_power_kw is a stored field: the peak is
  // identical, the diagnosis is the opposite, and no inference from the peak
  // alone can tell them apart.
  const { html } = rendered([
    charge({ peak_charge_power_kw: 41.1, charger_power_kw: 150, soc_start: 20 }),
  ]);
  assert.match(html, /41\/150 kW/);
  assert.match(html, /27%/);
  assert.match(html, /no dio lo que promete/);
  assert.match(html, /lim--bad/);
});

test("a low peak with a HIGH starting SoC is taper, not a bad charger", () => {
  // 41 of 150 starting at 80 % is the curve doing what curves do. Blaming
  // the charger there would be a false accusation.
  const { html } = rendered([
    charge({ peak_charge_power_kw: 41.1, charger_power_kw: 150, soc_start: 80 }),
  ]);
  assert.doesNotMatch(html, /no dio lo que promete/);
  assert.match(html, /taper/);
});

test("88 kW out of 150 is battery taper", () => {
  const { html } = rendered([
    charge({ peak_charge_power_kw: 88.1, charger_power_kw: 150 }),
  ]);
  assert.match(html, /59%/);
  assert.match(html, /taper/);
  assert.match(html, /lim--pack/);
});

test("with no rating recorded it falls back to how much was held", () => {
  // avg/peak still separates "sat at its ceiling" from "tapered". It cannot
  // spot an under-delivering charger, because then the ceiling held IS the
  // low number — which is the limitation the rating removes.
  const { html } = rendered([charge({ peak_charge_power_kw: 41.1 })]);
  assert.doesNotMatch(html, /kW ·.*promete/);
  assert.match(html, /sostuvo/);
});

test("the editor offers a charger-rating input", () => {
  const { html } = rendered([charge({ price_locked: false })]);
  assert.match(html, /cp-kw-input/);
  assert.match(html, /Potencia del poste/);
});

test("the rating can be sent on its own, with no receipt", () => {
  // The realistic flow: the charge auto-logged days ago and you are filling
  // in what the unit said. Requiring a total first made that impossible.
  const { card } = rendered([charge({ price_locked: false })]);
  card.querySelector('.cp-kw-input[data-charge-id="67"]').value = "150";
  card._applyPrice("67");
  const call = card._hass.calls.at(-1);
  assert.equal(call.service, "set_last_charge_price");
  assert.equal(call.data.charger_power_kw, 150);
  assert.equal(call.data.total_cost, undefined, "no price was typed, none must be sent");
  assert.equal(call.data.charge_id, 67);
});

test("an empty editor fires no service call at all", () => {
  const { card } = rendered([charge({ price_locked: false })]);
  const before = card._hass.calls.length;
  card._applyPrice("67");
  assert.equal(card._hass.calls.length, before, "nothing filled in, nothing sent");
});


// ---------------------------------------------------------------------------
// v2.133 — the car's own ceiling, and inheriting a rating from the same spot.
// ---------------------------------------------------------------------------

/** Like `rendered`, but with the car's all-time peak in state. */
function renderedWithCar(charges, bestEverKw, day = "2026-08-23") {
  const card = makeCard(cards, TYPE, { device: "sealion_7", kind: "charges" });
  card.hass = fakeHass({
    [RC]: st(String(charges.length), { charges }),
    "sensor.sealion_7_peak_charge_power_best_ever": st(String(bestEverKw)),
  });
  card._openId = day;
  card._render();
  return { card, html: body(card.innerHTML) };
}

test("maxing a 360 kW charger on a 150 kW car is the car's limit, not taper", () => {
  // Measured on the real vehicle: 148, 149 and 150 kW peaks on 160, 180 and
  // 360 kW units. Dividing by the charger's rating alone reported every big
  // charger as a 41 % battery taper while the car was flat out.
  const { html } = renderedWithCar(
    [charge({ peak_charge_power_kw: 148.3, charger_power_kw: 360, soc_start: 11 })],
    149.88,
  );
  assert.match(html, /148\/150 kW/);
  assert.match(html, /99%/);
  assert.match(html, /límite del coche/);
  assert.doesNotMatch(html, /taper/);
});

test("a small charger still reads against the charger, not the car", () => {
  const { html } = renderedWithCar(
    [charge({ peak_charge_power_kw: 41.1, charger_power_kw: 50 })],
    149.88,
  );
  assert.match(html, /41\/50 kW/);
  assert.match(html, /limitó el poste/);
  assert.doesNotMatch(html, /límite del coche/);
});

test("88 kW on a 360 kW charger is still flagged against the car ceiling", () => {
  // The real anomaly in the author's history: a 360 kW unit, 18 % start SoC,
  // and only 88 kW when the same car pulls 148 elsewhere. 88/150 = 59 %.
  const { html } = renderedWithCar(
    [charge({ peak_charge_power_kw: 87.9, charger_power_kw: 360, soc_start: 18 })],
    149.88,
  );
  assert.match(html, /88\/150 kW/);
  assert.match(html, /59%/);
});

test("the rating is offered from a previous charge at the same spot", () => {
  const here = { charge_lat: 38.42443, charge_lon: -6.41494 };
  const { html } = rendered([
    charge({ id: 68, charge_id: 68, price_locked: false, ...here }),
    charge({ id: 67, charge_id: 67, charger_power_kw: 50,
             ended_at: "2026-08-23T20:00:00+02:00", ...here }),
  ]);
  assert.match(html, /value="50"/);
  assert.match(html, /mismo sitio/);
});

test("the 40 m radius separates two chargers 56 m apart at one service area", () => {
  // Real coordinates: a 180 kW unit and a 60 kW one, 56 m apart at the same
  // stop. A 150 m radius merged them and the suggestion became a coin flip.
  // At 40 m the new charge matches only the unit it is actually parked at.
  const { html } = rendered([
    charge({ id: 70, charge_id: 70, price_locked: false,
             charge_lat: 39.88372, charge_lon: -6.27604 }),
    charge({ id: 60, charge_id: 60, charger_power_kw: 180,
             ended_at: "2026-08-20T17:24:00+02:00",
             charge_lat: 39.88372, charge_lon: -6.27604 }),
    charge({ id: 55, charge_id: 55, charger_power_kw: 60,
             ended_at: "2026-08-18T10:44:00+02:00",
             charge_lat: 39.88378, charge_lon: -6.27539 }),
  ]);
  assert.match(html, /value="180"/, "matches the unit it is parked at");
  assert.doesNotMatch(html, /value="60"/, "not the one 56 m away");
});

test("two ratings at the SAME spot suggest nothing at all", () => {
  // GPS drifts, and a site can genuinely have two units within 40 m. When
  // the charges that match disagree, a confident wrong guess is worse than
  // an empty box, so the suggestion is withheld.
  const here = { charge_lat: 41.52119, charge_lon: -5.75497 };
  const { html } = rendered([
    charge({ id: 71, charge_id: 71, price_locked: false, ...here }),
    charge({ id: 59, charge_id: 59, charger_power_kw: 360,
             ended_at: "2026-08-20T13:57:00+02:00", ...here }),
    charge({ id: 56, charge_id: 56, charger_power_kw: 150,
             ended_at: "2026-08-18T15:31:00+02:00", ...here }),
  ]);
  assert.doesNotMatch(html, /mismo sitio/);
});

test("a charge with no position inherits nothing", () => {
  const { html } = rendered([
    charge({ id: 68, charge_id: 68, price_locked: false }),
    charge({ id: 67, charge_id: 67, charger_power_kw: 50,
             ended_at: "2026-08-23T20:00:00+02:00",
             charge_lat: 38.42443, charge_lon: -6.41494 }),
  ]);
  assert.doesNotMatch(html, /mismo sitio/);
});


// ---------------------------------------------------------------------------
// v2.134 — ranking the list by rate, and the rate in both units.
// ---------------------------------------------------------------------------

test("the row shows the rate as kW and as kWh/min", () => {
  // Same quantity twice on purpose: kW is what chargers are sold in, kWh/min
  // is how long the stop actually costs you.
  const { html } = rendered([charge()]);   // 13.23 kWh over 21 min
  assert.match(html, /<b>37\.8<\/b> kW avg/);
  assert.match(html, /<b>0\.63<\/b> kWh\/min/);
});

test("sorting by rate flattens the list and ranks fastest first", () => {
  // Day grouping and a global ranking cannot both hold — a "fastest first"
  // list broken into days is neither.
  const card = makeCard(cards, TYPE, { device: "sealion_7", kind: "charges" });
  // Each row's rate comes from its OWN span: 20 kWh in 60/30/15 min is
  // 20 / 40 / 80 kW. Deliberately the reverse of date order, so a list that
  // merely stayed chronological would fail this.
  const span = (startIso, minutes, kwh) => ({
    started_at: startIso,
    ended_at: new Date(new Date(startIso).getTime() + minutes * 60000).toISOString(),
    kwh,
  });
  const rows = [
    charge({ id: 1, charge_id: 1, ...span("2026-08-24T22:00:00+02:00", 60, 20) }),
    charge({ id: 2, charge_id: 2, ...span("2026-08-20T11:00:00+02:00", 15, 20) }),
    charge({ id: 3, charge_id: 3, ...span("2026-08-18T10:44:00+02:00", 30, 20) }),
  ];
  card.hass = fakeHass({ [RC]: st("3", { charges: rows }) });
  card._chargeSort = "rate";
  card._render();
  const html = body(card.innerHTML);
  assert.doesNotMatch(html, /class="chargeday/, "no day grouping while ranked");
  const order = [...html.matchAll(/<b>([\d.]+)<\/b> kW avg/g)].map((m) => m[1]);
  assert.deepEqual(order, ["80.0", "40.0", "20.0"]);
});

test("the sort chips are always shown, including on the grouped view", () => {
  // Otherwise there is no way back to the date view once you leave it.
  const { html } = rendered([charge()]);
  assert.match(html, /cs-bar/);
  assert.match(html, /data-sort="date"/);
  assert.match(html, /data-sort="rate"/);
  assert.match(html, /cs-btn--on/);
});

test("tapping a sort chip switches the order", () => {
  const { card } = rendered([charge()]);
  assert.equal(card._chargeSort, "date");
  const stub = card.querySelector('.cs-btn[data-sort]');
  stub.getAttribute = () => "rate";
  card._listeners.find((l) => l.type === "click").fn({
    target: { closest: (sel) => (sel.includes("cs-btn") ? stub : null) },
    stopPropagation() {},
  });
  assert.equal(card._chargeSort, "rate");
});
