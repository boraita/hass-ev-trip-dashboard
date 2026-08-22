/*! Minimal DOM harness for the dashboard's custom cards.
 *
 * ev-trip-dashboard.js is a single browser script with no exports: it defines
 * ~28 card classes and hands them to customElements.define(). This harness
 * gives it just enough of a DOM to run under plain node, captures the
 * registry, and hands back the classes so tests can drive a card directly:
 *
 *   const { cards } = loadDashboard();
 *   const card = new cards.get("ev-abrp-card")();
 *   card.setConfig({ device: "sealion_7" });
 *   card.hass = fakeHass({ "switch.abrp_push": st("on") });
 *   assert.match(card.innerHTML, /enviando/);
 *
 * No dependencies on purpose — `node --test` runs it as-is. It is a string
 * harness, not a renderer: innerHTML is stored verbatim, so tests assert on
 * the HTML a card produces, which is exactly what the real cards build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A stand-in for a DOM element: stores innerHTML, records listeners. */
class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this._html = "";
    this._listeners = [];
    this.children = [];
  }
  set innerHTML(v) {
    this._html = String(v);
    // Cheap child accounting so cards that check childElementCount behave.
    this.children = this._html ? [new FakeElement("ha-card")] : [];
    // A real innerHTML write replaces the subtree, so the stubs handed out
    // for the previous markup — and any listeners on them — are gone.
    this._stubs = new Map();
  }
  get innerHTML() { return this._html; }
  get childElementCount() { return this.children.length; }
  /** Returns a listener-recording stub for any selector present in the HTML.
   *  Stable per selector: the card attaches its listener to the object it
   *  gets back, and a test clicking the same selector must reach it. */
  querySelector(sel) {
    const key = String(sel).replace(/[[\]".]/g, "").split("=")[0];
    if (!this._html.includes(key)) return null;
    if (!this._stubs) this._stubs = new Map();
    if (!this._stubs.has(key)) {
      const el = new FakeElement();
      el._owner = this;
      this._stubs.set(key, el);
    }
    return this._stubs.get(key);
  }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { this._listeners.push({ type, fn }); }
  removeEventListener() {}
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
  getAttribute() { return null; }
  /** Fire the handler registered on the element matching `sel`. */
  click(sel) {
    const el = this.querySelector(sel);
    if (!el) throw new Error(`click: no element matching ${sel}`);
    for (const l of el._listeners) if (l.type === "click") l.fn(new FakeElement());
    return el;
  }
}

/** Load the dashboard script in a sandbox and return its card registry. */
export function loadDashboard() {
  const cards = new Map();
  const customCards = [];
  const ctx = {
    HTMLElement: FakeElement,
    customElements: { define: (n, c) => cards.set(n, c), get: (n) => cards.get(n) },
    window: { customCards },
    console: { ...console, info: () => {}, log: () => {} },
    Date, Math, JSON, Intl, URL, URLSearchParams,
    navigator: { language: "es-ES" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error("network disabled in tests"); },
  };
  ctx.globalThis = ctx;
  ctx.window.document = ctx.document = {
    createElement: (t) => new FakeElement(t),
    head: new FakeElement("head"),
  };
  vm.createContext(ctx);
  vm.runInContext(
    readFileSync(path.join(ROOT, "ev-trip-dashboard.js"), "utf8"),
    ctx,
    { filename: "ev-trip-dashboard.js" }
  );
  return { cards, customCards, ctx, FakeElement };
}

/** Build one fake state object. `ts` defaults to now, so _sig sees movement. */
export function st(state, attributes = {}, ts = new Date().toISOString()) {
  return { state: String(state), attributes, last_updated: ts, last_changed: ts };
}

/** Build a fake hass. `calls` collects every callService invocation. */
export function fakeHass(states = {}, { language = "es" } = {}) {
  const calls = [];
  return {
    states,
    language,
    locale: { language },
    callService: (domain, service, data) => { calls.push({ domain, service, data }); },
    calls,
  };
}

/** Instantiate a registered card with a config. Throws if it isn't defined. */
export function makeCard(cards, type, config = {}) {
  const Klass = cards.get(type);
  if (!Klass) throw new Error(`card ${type} is not registered`);
  const card = new Klass();
  card.setConfig(config);
  return card;
}
