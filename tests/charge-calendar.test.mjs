/*! The charge calendar and the charge detail's AC/DC + home/away chips.
 *
 * The calendar exists so a charge can be FOUND: scrolling a 60-session list
 * to reach a Tuesday in July is not a search. Tapping a day narrows the list
 * to it; the type and place chips make each row identifiable once found.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, makeCard, fakeHass, st, clickTarget, dispatchClick } from "./harness.mjs";

const { cards } = loadDashboard();
const TYPE = "ev-trip-history-card";
const D = "sealion_7";

/** A charge. `day` is a local YYYY-MM-DD; `h` the hour it ended. */
function charge({ id, day, h = 12, kwh = 10, dc = false, location = "home", cost = 1.5 }) {
  const started = `${day}T${String(h - 1).padStart(2, "0")}:05:00+02:00`;
  const ended = `${day}T${String(h).padStart(2, "0")}:35:00+02:00`;
  return {
    id, charge_id: id, started_at: started, ended_at: ended,
    kwh, price_per_kwh: 0.07, total_cost: cost, currency: "EUR",
    soc_start: 40, soc_end: 60, location, is_dcfc: dc,
    duration_min: 90, avg_power_kw: 7, peak_charge_power_kw: 7.4,
  };
}

/** Today, and the same day one and two months back — so the tests do not
 *  break when the month rolls over. */
const p2 = (n) => String(n).padStart(2, "0");
const dayKeyOf = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const now = new Date();
const THIS_MONTH = new Date(now.getFullYear(), now.getMonth(), 10);
const LAST_MONTH = new Date(now.getFullYear(), now.getMonth() - 1, 15);
const DAY_A = dayKeyOf(THIS_MONTH);
const DAY_B = dayKeyOf(new Date(now.getFullYear(), now.getMonth(), 11));
const DAY_OLD = dayKeyOf(LAST_MONTH);

function build(charges, config = {}) {
  const card = makeCard(cards, TYPE, { device: D, kind: "charges", calendar: true, ...config });
  card.connectedCallback();
  card.hass = fakeHass({
    [`sensor.${D}_recent_charges`]: st(String(charges.length), { charges }),
  });
  return card;
}

const FIXTURE = [
  charge({ id: 3, day: DAY_A, h: 9, kwh: 12.5, dc: false, location: "home" }),
  charge({ id: 2, day: DAY_A, h: 20, kwh: 30.0, dc: true, location: "not_home" }),
  charge({ id: 1, day: DAY_B, h: 14, kwh: 8.0, dc: false, location: "home" }),
  charge({ id: 0, day: DAY_OLD, h: 11, kwh: 42.0, dc: true, location: "not_home" }),
];

test("renders a month grid with a weekday header", () => {
  const html = build(FIXTURE).innerHTML;
  assert.match(html, /class="cal"/);
  assert.match(html, /class="cal-wd"/);
  assert.match(html, /class="cal-grid"/);
  // 7 weekday labels, Monday first.
  assert.equal((html.match(/<div class="cal-wd">(.*?)<\/div>/s)[1].match(/<span>/g) || []).length, 7);
  assert.match(html, /data-cal-nav="1"/, "a way back to older months");
  assert.match(html, /data-cal-nav="-1"/);
});

test("only days that have charges are tappable", () => {
  const html = build(FIXTURE).innerHTML;
  const taps = [...html.matchAll(/data-cal-day="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(taps.sort(), [DAY_A, DAY_B].sort(), "this month's charge days, and only those");
  // The empty days still render as cells, just not as buttons.
  assert.ok((html.match(/class="cal-c/g) || []).length > taps.length);
});

test("a day's colour says AC, DC or both", () => {
  const html = build(FIXTURE).innerHTML;
  const cellOf = (day) => html.slice(html.indexOf(`data-cal-day="${day}"`) - 220, html.indexOf(`data-cal-day="${day}"`));
  assert.match(cellOf(DAY_A), /cal-c--mix/, "one AC and one DC that day");
  assert.match(cellOf(DAY_B), /cal-c--ac/);
  assert.doesNotMatch(cellOf(DAY_B), /cal-c--dc|cal-c--mix/);
});

test("the month header totals match the month's charges", () => {
  const html = build(FIXTURE).innerHTML;
  // 12.5 + 30.0 + 8.0 = 50.5 kWh over 3 sessions this month.
  assert.match(html, /class="cal-tot">3 · <b>50\.5<\/b> kWh/);
});

test("the list starts on the newest month that has charges", () => {
  // Only last month has data → opening on the current month would greet the
  // user with "no charges on the selected date".
  const html = build([charge({ id: 9, day: DAY_OLD, kwh: 11 })]).innerHTML;
  assert.doesNotMatch(html, /No hay cargas en la fecha seleccionada/);
  assert.match(html, /data-cal-day="/, "the month it landed on has a tappable day");
});

test("tapping a day narrows the list to it, and tapping again clears", () => {
  const card = build(FIXTURE);
  dispatchClick(card, clickTarget({ "[data-cal-day]": { "data-cal-day": DAY_B } }));
  assert.equal(card._calDay, DAY_B);
  let html = card.innerHTML;
  assert.match(html, /cal-c--sel/, "the tapped cell is marked");
  // 1 of 4: the window still holds four, one is on screen.
  assert.match(html, /class="count">1 de 4</);
  assert.match(html, /8\.00<\/b> kWh|8<\/b> kWh/, "that day's session");
  assert.doesNotMatch(html, /30\.00/, "the other day's DC session is filtered out");

  dispatchClick(card, clickTarget({ "[data-cal-day]": { "data-cal-day": DAY_B } }));
  assert.equal(card._calDay, null, "same day again clears the filter");
});

test("month navigation moves and clamps", () => {
  const card = build(FIXTURE);
  const start = card._calOffset;
  dispatchClick(card, clickTarget({ "[data-cal-nav]": { "data-cal-nav": "1" } }));
  assert.equal(card._calOffset, start + 1, "older");
  // Now on last month, whose only charge is the 42 kWh DC one.
  assert.match(card.innerHTML, /42/);
  dispatchClick(card, clickTarget({ "[data-cal-nav]": { "data-cal-nav": "-1" } }));
  assert.equal(card._calOffset, start);
  // At the current month there is nothing newer to go to.
  assert.match(card.innerHTML, /data-cal-nav="-1" disabled/);
});

test("\"show all\" lists the whole window without moving the calendar", () => {
  const card = build(FIXTURE);
  const month = card._calOffset;
  dispatchClick(card, clickTarget({ "[data-cal-all]": { "data-cal-all": "1" } }));
  assert.equal(card._calAll, true);
  assert.equal(card._calOffset, month, "the grid stays where it was");
  const html = card.innerHTML;
  assert.match(html, /class="count">4 cargas</);
  assert.match(html, /42/, "last month's charge is back in the list");
});

test("the detail names AC as explicitly as DC", () => {
  // Regression: `is_dcfc === false` fell through to null, so AC charges
  // rendered with no type chip at all and the card looked DC-only.
  const card = build(FIXTURE);
  dispatchClick(card, clickTarget({ "[data-cal-day]": { "data-cal-day": DAY_B } }));
  const html = card.innerHTML;
  assert.match(html, /class="chip chip--ac"/);
  assert.match(html, /power-plug-outline/);
  assert.match(html, />AC</);
});

test("the detail says whether it charged at home or away", () => {
  const card = build(FIXTURE);
  dispatchClick(card, clickTarget({ "[data-cal-day]": { "data-cal-day": DAY_A } }));
  const html = card.innerHTML;
  assert.match(html, /chip--home/);
  assert.match(html, /En casa/);
  assert.match(html, /chip--away/);
  assert.match(html, /Fuera de casa/);
  assert.match(html, /class="chip chip--dc"/, "and the DC session of that day");
  assert.doesNotMatch(html, />not_home</, "never the raw token");
});

test("a named zone is shown by its own name, still as away", () => {
  const card = build([charge({ id: 5, day: DAY_A, location: "Trabajo ele", dc: false })]);
  dispatchClick(card, clickTarget({ "[data-cal-day]": { "data-cal-day": DAY_A } }));
  const html = card.innerHTML;
  assert.match(html, /chip--away/);
  assert.match(html, /Trabajo ele/);
});

test("survives an empty window and unknown dates", () => {
  assert.match(build([]).innerHTML, /Todavía no hay cargas/);
  const odd = build([{ id: 1, charge_id: 1, kwh: 5, currency: "EUR", location: "home", is_dcfc: null }]);
  assert.doesNotMatch(odd.innerHTML, /undefined|NaN/);
});

test("calendar:false keeps the plain list", () => {
  const html = build(FIXTURE, { calendar: false }).innerHTML;
  assert.doesNotMatch(html, /class="cal-grid"/);
  assert.match(html, /class="count">4 cargas</, "and shows the whole window");
});
