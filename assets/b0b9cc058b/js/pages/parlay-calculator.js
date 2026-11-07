// The stand alone parlay calculator (2026-10-19, sharpslate/calculators.py).
// The heading and the article are in the HTML; this draws the calculator into
// #app. Each leg takes American or decimal odds, an optional other side (for
// the fair odds and the book's margin) and a Push box (the leg drops out, the
// way most books grade a push). The inputs ride in the address (#s=10&l=...),
// so a parlay can be shared or bookmarked. Every number is the user's own
// inputs run through oddsmath.js; nothing here says what to bet.
import { h } from "../app.js";
import * as odds from "../oddsmath.js";
import { uid, textInput, numInput, field, kpi, resultRow, resultBox, showMessage, showResult, money } from "../calc-ui.js";

const MAX_LEGS = 15;
// the longest odds the page prints (decimal 10 million, +999,999,900): past
// that the numbers stop meaning anything and print in exponent form
const LONGEST = 1e7;

// long parlays print big numbers: group them, and say "under 0.1%" not "0.0%"
const fmtOdds = (american) => `${american > 0 ? "+" : ""}${american.toLocaleString("en-US")}`;
const fmtDec = (d) => d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (p) => (p > 0 && p < 0.001 ? "under 0.1%" : `${(p * 100).toFixed(1)}%`);
const DEFAULT = { stake: "10", legs: [-110, -110, -110].map((o) => ({ odds: String(o), other: "-110", push: false })) };

/** "-110", "+150" (American) or "1.91" (decimal) -> decimal odds; null if neither.
 * A signed number is American, and American odds are never between -100 and
 * +100. An unsigned one is American from 100 up and decimal above 1 below that.
 * American odds are whole numbers: "+150.5" is refused, never quietly cut to +150. */
export function parseOdds(text) {
  const t = String(text ?? "").trim();
  const m = /^([+-]?)(\d+)(\.\d+)?$/.exec(t);
  if (!m) return null;
  const v = Number(m[2] + (m[3] || "")) * (m[1] === "-" ? -1 : 1);
  if (Math.abs(v) >= 100) return m[3] ? null : odds.americanToDecimal(v);
  if (!m[1] && v > 1) return v;
  return null;
}

// --------------------------------------------------------------- the address
// Read raw, split, THEN decode each piece: a comma typed into a leg is sent as
// %2C and must not split the parlay on the way back in.
function readHash() {
  const raw = Object.create(null);
  for (const kv of location.hash.slice(1).split("&")) {
    const at = kv.indexOf("=");
    if (at > 0) raw[kv.slice(0, at)] = kv.slice(at + 1);
  }
  const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, " ")); } catch { return ""; } };
  if (!raw.l) return null;
  const legs = raw.l.split(",").slice(0, MAX_LEGS).map((part) => {
    const [o = "", other = "", flag = ""] = part.split("~").map(dec);
    return { odds: o, other, push: flag === "p" };
  }).filter((l) => l.odds.trim());
  return legs.length ? { stake: dec(raw.s || "") || DEFAULT.stake, legs } : null;
}

function writeHash(state) {
  const enc = (x) => encodeURIComponent(String(x).trim()).replace(/~/g, "%7E");
  const l = state.legs.map((g) => [enc(g.odds), enc(g.other), g.push ? "p" : ""].join("~").replace(/~+$/, ""));
  const hash = `#s=${enc(state.stake)}&l=${l.join(",")}`;
  history.replaceState(null, "", hash);
}

// ------------------------------------------------------------------- the math
/** Everything the result boxes show, from the inputs. Exported for the self-test. */
export function computeParlay(state) {
  const stake = Number(state.stake);
  const counted = [];
  for (const [i, g] of state.legs.entries()) {
    if (g.push) continue;
    const dec = parseOdds(g.odds);
    if (dec == null) return { error: `Leg ${i + 1}: enter American odds such as -110 or +150, or decimal odds such as 1.91.` };
    let other = null;
    if (String(g.other).trim()) {
      other = parseOdds(g.other);
      if (other == null) return { error: `Leg ${i + 1}: the other side's odds aren't readable. Leave it empty or enter odds such as -110.` };
    }
    counted.push({ dec, other });
  }
  if (!(stake >= 0)) return { error: "Enter a stake of zero or more." };
  const pushes = state.legs.length - counted.length;
  if (!counted.length) return { stake, pushes, legs: 0, dec: 1 };
  const dec = counted.reduce((acc, g) => acc * g.dec, 1);
  if (dec > LONGEST) return { error: "These odds are too long to show. Remove a leg or two." };
  const out = { stake, pushes, legs: counted.length, dec, payout: stake * dec };
  const withOther = counted.filter((g) => g.other != null).length;
  if (withOther === counted.length) {
    const fair = counted.reduce((acc, g) => acc * odds.novigTwoWay(g.dec, g.other)[0], 1);
    if (1 / fair > LONGEST) out.fairTooLong = true;
    else out.fair = { prob: fair, margin: 1 - fair * dec };
  } else {
    out.fairMissing = counted.length - withOther;
  }
  return out;
}

// --------------------------------------------------------------------- the UI
function render() {
  const app = document.getElementById("app");
  const state = readHash() || structuredClone(DEFAULT);

  const stakeInput = numInput(state.stake, { step: "1", min: "0" });
  const legList = h("ol", { class: "pc-legs", role: "list" });
  const addBtn = h("button", { type: "button", class: "btn btn-sm pc-add" }, "Add a leg");
  const resetBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost" }, "Start over");
  const result = resultBox();
  const fairBox = resultBox();
  fairBox.classList.add("pc-fair");

  // the address changes only once the visitor changes something: a #section
  // link into the article keeps its jump, and a copied link of the untouched
  // page doesn't carry the defaults
  let touched = false;
  function changed() {
    touched = true;
    recompute();
  }

  function recompute() {
    if (touched) writeHash(state);
    addBtn.disabled = state.legs.length >= MAX_LEGS;
    const r = computeParlay(state);
    if (r.error) {
      showMessage(result, r.error);
      showMessage(fairBox, "The fair odds follow once the parlay can be priced.");
      return;
    }
    const legsText = `${r.legs} ${r.legs === 1 ? "leg" : "legs"}${r.pushes ? `, ${r.pushes} ${r.pushes === 1 ? "push" : "pushes"}` : ""}`;
    if (!r.legs) {
      showResult(result, [kpi("Payout", money(r.stake), "Every leg pushed: the stake comes back")], []);
      showMessage(fairBox, "No legs left to price.");
      return;
    }
    const american = fmtOdds(odds.decimalToAmerican(r.dec));
    showResult(result, [
      kpi("Payout", money(r.payout), `Profit ${money(r.payout - r.stake)}`),
      kpi("Parlay odds", american, `Decimal ${fmtDec(r.dec)}`),
    ], [
      resultRow("Legs counted", legsText),
      resultRow("Break even win chance", fmtPct(1 / r.dec)),
    ]);
    if (r.fair) {
      const fairAm = fmtOdds(odds.probToAmerican(r.fair.prob));
      showResult(fairBox, [
        kpi("Fair odds", fairAm, `${fmtPct(r.fair.prob)} to win`),
        kpi("Book's margin", `${(r.fair.margin * 100).toFixed(1)}%`, "of each dollar, on average"),
      ], [
        resultRow("Fair payout on your stake", money(r.stake / r.fair.prob)),
      ]);
    } else if (r.fairTooLong) {
      showMessage(fairBox, "The fair odds are too long to show.");
    } else {
      showMessage(fairBox, `Add the other side's odds on ${r.fairMissing === r.legs ? "each leg" : `the ${r.fairMissing} ${r.fairMissing === 1 ? "leg" : "legs"} still missing it`} to see the fair odds and the book's margin.`);
    }
  }

  function legRow(g, i) {
    const oddsIn = textInput(g.odds, { "aria-label": `Leg ${i + 1} odds`, autocomplete: "off" });
    const otherIn = textInput(g.other, { "aria-label": `Leg ${i + 1} other side's odds`, placeholder: "optional", autocomplete: "off" });
    const pushId = uid("pc-push");
    const push = h("input", { type: "checkbox", id: pushId, checked: g.push || null, "aria-label": `Leg ${i + 1} push` });
    const remove = h("button", {
      type: "button", class: "icon-btn pc-remove", "aria-label": `Remove leg ${i + 1}`,
      disabled: state.legs.length <= 1 || null,
    }, "×");
    oddsIn.addEventListener("input", () => { g.odds = oddsIn.value; changed(); });
    otherIn.addEventListener("input", () => { g.other = otherIn.value; changed(); });
    push.addEventListener("change", () => { g.push = push.checked; row.classList.toggle("is-push", g.push); changed(); });
    remove.addEventListener("click", () => { state.legs.splice(i, 1); drawLegs(); changed(); });
    const row = h("li", { class: `pc-leg${g.push ? " is-push" : ""}` },
      h("span", { class: "pc-leg-n num", "aria-hidden": "true" }, String(i + 1)),
      field("Odds", oddsIn),
      field("Other side", otherIn),
      h("label", { class: "pc-push", for: pushId }, push, "Push"),
      remove);
    return row;
  }

  function drawLegs() {
    legList.replaceChildren(...state.legs.map(legRow));
  }

  stakeInput.addEventListener("input", () => { state.stake = stakeInput.value; changed(); });
  addBtn.addEventListener("click", () => {
    if (state.legs.length >= MAX_LEGS) return;
    state.legs.push({ odds: "-110", other: "", push: false });
    drawLegs();
    changed();
    legList.lastElementChild?.querySelector("input")?.focus();
  });
  resetBtn.addEventListener("click", () => {
    Object.assign(state, structuredClone(DEFAULT));
    stakeInput.value = state.stake;
    touched = false;
    history.replaceState(null, "", location.pathname + location.search);
    drawLegs();
    recompute();
  });

  drawLegs();
  recompute();

  const legsHead = uid("pc-legs-h");
  const outHead = uid("pc-out-h");
  app.replaceChildren(h("div", { class: "pc" },
    h("section", { class: "tl-card pc-input", "aria-labelledby": legsHead },
      h("div", { class: "tl-card-head" },
        h("h2", { class: "tl-card-title", id: legsHead }, "Your parlay"),
        h("p", { class: "tl-card-sub" }, "American odds (-110, +150) or decimal (1.91). The other side is optional.")),
      h("div", { class: "pc-stake" }, field("Stake $", stakeInput)),
      legList,
      h("div", { class: "pc-actions" }, addBtn, resetBtn)),
    h("section", { class: "tl-card pc-out", "aria-labelledby": outHead },
      h("h2", { class: "tl-card-title", id: outHead }, "What it pays"),
      result,
      h("h3", { class: "pc-sub" }, "Fair odds and the book's margin"),
      fairBox)));
  app.dataset.state = "ready";
}

render();
