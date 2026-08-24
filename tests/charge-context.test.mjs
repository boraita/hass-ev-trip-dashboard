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
