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


// ---------------------------------------------------------------------------
// v2.135 — the 0-10 score, and the two fastest stops.
// ---------------------------------------------------------------------------

test("the fastest session in the history scores 10 by construction", () => {
  // The anchor IS a real session — the same idiom as the trip score, which
  // anchors on the car's own best rather than a spec-sheet number.
  const span = (min, kwh) => ({
    started_at: "2026-08-23T10:00:00+02:00",
    ended_at: new Date(Date.parse("2026-08-23T10:00:00+02:00") + min * 60000).toISOString(),
    kwh,
  });
  const { html } = rendered([
    charge({ id: 1, charge_id: 1, peak_charge_power_kw: 150, ...span(60, 88) }),
    charge({ id: 2, charge_id: 2, peak_charge_power_kw: 50, ...span(60, 44) }),
  ], "2026-08-23");
  assert.match(html, />10\.0</, "88 kW is the best, so it anchors at 10");
  assert.match(html, />5\.0</, "44 kW is half of it");
});

test("a home AC charge is not scored against a DC anchor", () => {
  // 11 kW against an 88 kW anchor would read 1.2/10 and say nothing at all
  // about the wallbox.
  const { html } = rendered([
    charge({ id: 1, charge_id: 1, peak_charge_power_kw: 150,
             started_at: "2026-08-23T10:00:00+02:00",
             ended_at: "2026-08-23T11:00:00+02:00", kwh: 88 }),
    charge({ id: 2, charge_id: 2, is_dcfc: false, location: "home",
             peak_charge_power_kw: 11,
             started_at: "2026-08-23T12:00:00+02:00",
             ended_at: "2026-08-23T16:00:00+02:00", kwh: 44 }),
  ], "2026-08-23");
  assert.doesNotMatch(html, />1\.[0-9]</, "the AC session gets no score at all");
});

test("the fastest stops are ranked by their best visit, not their average", () => {
  // One slow visit should not demote a good charger: the question is where
  // this car CAN go fast, not where it has always gone fast.
  const card = makeCard(cards, "ev-fast-charge-card", { device: "sealion_7" });
  const mk = (id, kw, la, lo, rated) => ({
    id, charge_id: id, is_dcfc: true, location: "not_home",
    peak_charge_power_kw: Math.max(kw, 26), avg_power_kw: kw,
    charger_power_kw: rated, charge_lat: la, charge_lon: lo,
    kwh: 40, ended_at: `2026-08-2${id}T10:00:00+02:00`,
  });
  card.hass = fakeHass({ [RC]: st("4", { charges: [
    mk(1, 88.1, 43.24106, -5.77631, 160),   // one visit, best overall
    mk(2, 87.9, 41.52119, -5.75497, 360),   // two visits, one weaker
    mk(3, 60.0, 41.52119, -5.75497, 360),
    mk(4, 39.4, 38.42443, -6.41494, 50),
  ] }) });
  const html = body(card.innerHTML);
  assert.match(html, /Mejores paradas/);
  // One decimal on purpose: this figure IS the ranking key, and rounding
  // 88.1 and 87.9 both to "88" hides why one is above the other.
  assert.match(html, /88\.1 kW/);
  assert.match(html, /87\.9 kW/, "ranked on its best visit, not the 74 kW mean");
  assert.match(html, /2×/, "the visit count survives, the coordinates do not");
  // v2.138 — the label is the conditions the stop happened under, never the
  // coordinates and no longer the date either. A date identifies a session;
  // temperature, kWh and minutes are what make one recognisable as good.
  const labels = [...html.matchAll(/class="fc-place">([^<]*)</g)].map((m) => m[1]);
  assert.ok(labels.length >= 2);
  for (const t of labels) {
    assert.doesNotMatch(t, /-?\d+\.\d{4}/, `coordinates leaked into a label: ${t}`);
    assert.doesNotMatch(t, /\d{2}\/\d{2}/, `a date leaked into a label: ${t}`);
    assert.match(t, /kWh/, "labelled by what it delivered");
  }
});

test("stops with no recorded position are left out of the ranking", () => {
  const card = makeCard(cards, "ev-fast-charge-card", { device: "sealion_7" });
  card.hass = fakeHass({ [RC]: st("1", { charges: [{
    id: 1, charge_id: 1, is_dcfc: true, location: "not_home",
    peak_charge_power_kw: 150, avg_power_kw: 88, kwh: 40,
    ended_at: "2026-08-20T10:00:00+02:00",
  }] }) });
  const html = body(card.innerHTML);
  assert.doesNotMatch(html, /Mejores paradas/);
  assert.match(html, /Carga rápida/, "the class summary still renders");
});


// ---------------------------------------------------------------------------
// v2.137 — the comparison shown as real charges, not as a method.
// ---------------------------------------------------------------------------

/** A fast DC session: given charger rating, factor value and resulting rate. */
const fc = (id, ratedKw, temp, rateKw, day) => ({
  id, charge_id: id, is_dcfc: true, location: "not_home",
  charger_power_kw: ratedKw, peak_charge_power_kw: Math.max(rateKw, 26),
  temperature_c: temp, km_before: 100, soc_start: 20,
  started_at: `2026-08-${String(day).padStart(2, "0")}T12:00:00+02:00`,
  ended_at: new Date(Date.parse(`2026-08-${String(day).padStart(2, "0")}T12:00:00+02:00`) + 3600000).toISOString(),
  kwh: rateKw,   // one hour, so kwh equals the average kW
});

function fastCard(rows) {
  const card = makeCard(cards, "ev-fast-charge-card", { device: "sealion_7" });
  card.hass = fakeHass({ [RC]: st(String(rows.length), { charges: rows }) });
  return body(card.innerHTML);
}

test("the fastest and slowest sessions are listed by what they did", () => {
  // Not by method, and not by coordinates. v2.138 also drops the date in
  // favour of the temperature: the driver is comparing conditions, and the
  // calendar is not one of them.
  const html = fastCard([
    fc(1, 150, 20, 88, 20), fc(2, 150, 25, 87, 21), fc(3, 150, 30, 86, 22),
    fc(4, 50, 20, 39, 23), fc(5, 50, 25, 38, 24), fc(6, 50, 30, 34, 25),
  ]);
  assert.match(html, /Las más rápidas/);
  assert.match(html, /Las más lentas/);
  assert.match(html, /88\.0 kWh · 60 min/);
  assert.match(html, /34\.0 kWh · 60 min/);
  const lead = [...html.matchAll(/class="fs-when">([^<]*)</g)].map((m) => m[1]);
  assert.equal(lead.length, 6);
  for (const t of lead) {
    assert.match(t, /^\d+ °C$/, `the leading column must be the temperature: ${t}`);
  }
  // The factors the estimate refuses to use are still readable, as the
  // row's tooltip rather than a column.
  assert.match(html, /title="100 km antes · llegó al 20 %"/);
});

test("the fastest block never explains its own method", () => {
  // The previous version reported per-class deltas and verdicts, which is how
  // the answer was reached rather than the answer.
  const html = fastCard([
    fc(1, 150, 20, 88, 20), fc(2, 150, 25, 87, 21),
    fc(3, 50, 20, 39, 22), fc(4, 50, 25, 38, 23),
  ]);
  assert.doesNotMatch(html, /ruido|sin efecto|faltan datos/);
  assert.doesNotMatch(html, /mitad|median/i);
});

test("too few sessions to compare renders no comparison at all", () => {
  const html = fastCard([fc(1, 150, 20, 88, 20), fc(2, 50, 20, 39, 21)]);
  assert.doesNotMatch(html, /Las más rápidas/);
});


// ---------------------------------------------------------------------------
// v2.138 — "Qué esperar": the predictive half. Everything above this point in
// the card is a record of what happened; these tests are about the only part
// that projects forward, and about what it refuses to use to do so.
// ---------------------------------------------------------------------------

function fastCardWith(rows, states = {}) {
  const card = makeCard(cards, "ev-fast-charge-card", { device: "sealion_7" });
  card.hass = fakeHass({ [RC]: st(String(rows.length), { charges: rows }), ...states });
  return body(card.innerHTML);
}

/** The three live figures the projection needs: charge level, and the two
 *  halves of the pack capacity the logger already publishes. */
const live = (soc, batt, etf) => ({
  "sensor.sealion_7_battery_percent": st(String(soc)),
  "sensor.sealion_7_battery_energy": st(String(batt)),
  "sensor.sealion_7_energy_to_full_charge": st(String(etf)),
});

/** The estimate table, parsed back out of the markup. */
const estimate = (html) => [...html.matchAll(
  /class="fx-lbl">([^<]*)<span class="fc-n">(\d+)<\/span><\/span>\s*<b class="fx-kw">(\d+)<\/b>\s*<span class="fx-min">([^<]*)<\/span>\s*<span class="fx-gain">([^<]*)<\/span>/g
)].map((m) => ({ label: m[1], n: Number(m[2]), kw: Number(m[3]), time: m[4], saves: m[5] }));

test("the estimate answers in minutes, from the pack and the gap to the target", () => {
  // 24 + 56 = 80 kWh of capacity, 30 % in the pack, 80 % wanted: 40 kWh to
  // put in. At 80 kW that is half an hour; at 50 kW it is 48 minutes. Minutes
  // are the point — a driver at a motorway exit is deciding how long to
  // stand there, not comparing kW.
  const html = fastCardWith([
    fc(1, 150, 20, 80, 20), fc(2, 150, 25, 80, 21),
    fc(3, 50, 20, 50, 22), fc(4, 50, 25, 50, 23),
  ], live(30, 24, 56));
  assert.match(html, /Qué esperar/);
  assert.match(html, /Tienes 30 % · 40 kWh hasta el 80 %/);
  const est = estimate(html);
  assert.equal(est.length, 2);
  assert.deepEqual(est.map((x) => x.kw), [80, 50], "best option first");
  assert.equal(est[0].time, "30 min");
  assert.equal(est[1].time, "48 min");
  // Measured against the slowest post on offer, because that is the real
  // alternative: the one already in front of you.
  assert.equal(est[0].saves, "−18 min");
  assert.equal(est[1].saves, "", "the slowest row has nothing to save against");
});

test("one cut-short visit does not drag a class's estimate down", () => {
  // 88, 87 and a 20 kW session that ended early. The median says 87, which
  // is what this post typically does; the mean would say 65 and promise a
  // stop half again as long as reality.
  const html = fastCardWith([
    fc(1, 150, 20, 88, 20), fc(2, 150, 25, 87, 21), fc(3, 150, 30, 20, 22),
    fc(4, 50, 20, 38, 23), fc(5, 50, 25, 38, 24),
  ], live(30, 24, 56));
  const est = estimate(html);
  assert.equal(est[0].kw, 87);
  assert.equal(est[0].n, 3, "the bad visit is still counted, just not averaged in");
});

test("temperature and the kilometres before do not move the estimate", () => {
  // The same sessions at 5 °C and at 40 °C, after 3 km and after 400. If any
  // of those ever leaks into the projection, these two tables stop matching.
  // They were measured across the real history and ordered nothing, so a
  // number that shifted with them would be noise wearing a prediction's
  // clothes.
  const rows = (temp, km) => [
    { ...fc(1, 150, temp, 80, 20), km_before: km, min_before: km },
    { ...fc(2, 150, temp, 80, 21), km_before: km, min_before: km },
    { ...fc(3, 50, temp, 50, 22), km_before: km, min_before: km },
    { ...fc(4, 50, temp, 50, 23), km_before: km, min_before: km },
  ];
  const cold = estimate(fastCardWith(rows(5, 3), live(30, 24, 56)));
  const hot = estimate(fastCardWith(rows(40, 400), live(30, 24, 56)));
  assert.deepEqual(cold, hot);
  assert.equal(cold[0].time, "30 min");
});

test("without a live charge level it offers power and no invented minutes", () => {
  const html = fastCardWith([
    fc(1, 150, 20, 80, 20), fc(2, 150, 25, 80, 21),
    fc(3, 50, 20, 50, 22), fc(4, 50, 25, 50, 23),
  ]);
  const est = estimate(html);
  assert.deepEqual(est.map((x) => x.kw), [80, 50]);
  for (const x of est) {
    assert.equal(x.time, "—");
    assert.equal(x.saves, "", "no minutes means nothing to compare");
  }
  assert.match(html, /Sin nivel de batería en vivo/);
});

test("already past the target, it says so instead of projecting a stop", () => {
  const html = fastCardWith([
    fc(1, 150, 20, 80, 20), fc(2, 150, 25, 80, 21),
    fc(3, 50, 20, 50, 22), fc(4, 50, 25, 50, 23),
  ], live(88, 70, 10));
  assert.match(html, /Ya vas al 88 %, por encima del objetivo del 80 %/);
  for (const x of estimate(html)) assert.equal(x.time, "—");
});

test("one charger class is not a choice, so no estimate is offered", () => {
  // With nothing to compare against, a table of one row would be a number
  // dressed up as a decision.
  const html = fastCardWith([
    fc(1, 50, 20, 38, 20), fc(2, 50, 25, 39, 21),
  ], live(30, 24, 56));
  assert.doesNotMatch(html, /Qué esperar/);
  assert.match(html, /Carga rápida/, "the class summary still renders");
});

test("the estimate names the factors it leaves out", () => {
  // Silence would read as "these were considered". They were measured, and
  // they ordered nothing; saying which ones is what makes the estimate
  // honest rather than merely short.
  const html = fastCardWith([
    fc(1, 150, 20, 80, 20), fc(2, 150, 25, 80, 21),
    fc(3, 50, 20, 50, 22), fc(4, 50, 25, 50, 23),
  ], live(30, 24, 56));
  assert.match(html, /La temperatura y los km y minutos previos se midieron en estas 4 sesiones y no ordenaron nada/);
});
