// Tools: odds calculators that work for every sport with no data at all,
// plus an optional sport-specific tools listing (empty for NFL today).
// Laid out like the Prop Lab (redesign 2026-09-30): cards with a display face
// title, small uppercase field labels, and results as a headline number over a
// few quiet rows. Every number is the user's own inputs run through
// oddsmath.js; nothing here says what to bet.
import { h, fetchJSON, currentSport, manifestStatus } from "../app.js";
import * as odds from "../oddsmath.js";

let _uid = 0;

// ---------------------------------------------------------------- building blocks
function textInput(value, extra = {}) {
  return h("input", { type: "text", class: "text-input", inputmode: "decimal", value: String(value), ...extra });
}
function numInput(value, extra = {}) {
  return h("input", { type: "number", class: "text-input", value: String(value), ...extra });
}

// A select with a caret drawn by the page (the control's own is switched off).
function selectBox(select) {
  return h("span", { class: "tl-select" }, select);
}

/** A <label for> over a control, with an optional line of help under it. */
function field(labelText, control, help, host = control) {
  const id = control.id || `tl-f-${++_uid}`;
  control.id = id;
  return h("div", { class: "field" },
    h("label", { class: "field-label", for: id }, labelText),
    host,
    help ? h("div", { class: "field-help" }, help) : null);
}

// A result: one headline cell (or two), then quiet rows. `tone` is the sign of
// the user's own number, shown in the good or bad text color and nothing more.
function kpi(label, value, sub, tone) {
  return h("div", { class: "tl-kpi" },
    h("div", { class: "tl-kpi-l" }, label),
    h("div", { class: `tl-kpi-v num${tone ? ` is-${tone}` : ""}` }, value),
    sub ? h("div", { class: "tl-kpi-s num" }, sub) : null);
}

function resultRow(label, value, tone) {
  return h("div", { class: "tl-row" },
    h("span", { class: "tl-row-l" }, label),
    h("span", { class: `tl-row-v num${tone ? ` is-${tone}` : ""}` }, value));
}

/** The result box: it announces its changes politely to a screen reader. */
function resultBox() {
  return h("div", { class: "tl-result", "aria-live": "polite", "aria-atomic": "true" });
}

function showMessage(box, text) {
  box.replaceChildren(h("p", { class: "tl-empty" }, text));
}

function showResult(box, headline, rows) {
  box.replaceChildren(
    h("div", { class: `tl-heads${headline.length > 1 ? " is-two" : ""}` }, headline),
    rows.length ? h("div", { class: "tl-rows" }, rows) : null);
}

let _cardId = 0;
function card(titleText, blurb, body, { wide = false, full = false } = {}) {
  const id = `tl-card-${++_cardId}`;
  return h("section", {
    class: `tl-card${wide ? " is-wide" : ""}${full ? " is-full" : ""}`, "aria-labelledby": id,
  },
    h("div", { class: "tl-card-head" },
      h("h2", { class: "tl-card-title", id }, titleText),
      blurb ? h("p", { class: "tl-card-sub" }, blurb) : null),
    h("div", { class: "tl-body" }, body));
}

// a value that prints as zero has no sign: "+0.000", never "-0.000"
const signedNum = (v, places) => `${v < 0 && Math.abs(v).toFixed(places) !== (0).toFixed(places) ? "-" : "+"}${Math.abs(v).toFixed(places)}`;
const signedMoney = (v) => `${v < 0 && Math.abs(v).toFixed(2) !== "0.00" ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;

// ------------------------------------------------------------- odds converter
function oddsConverterCard() {
  const american = textInput("-110");
  const decimal = numInput("1.91", { step: "0.01" });
  const implied = numInput("52.4", { step: "0.1" });

  const fromAmerican = () => {
    const a = parseFloat(american.value);
    if (!Number.isFinite(a) || a === 0) return;
    const d = odds.americanToDecimal(a);
    decimal.value = d.toFixed(2);
    implied.value = (odds.impliedProb(d) * 100).toFixed(1);
  };
  const fromDecimal = () => {
    const d = parseFloat(decimal.value);
    if (!Number.isFinite(d) || d <= 1) return;
    american.value = odds.fmtAmerican(odds.decimalToAmerican(d));
    implied.value = (odds.impliedProb(d) * 100).toFixed(1);
  };
  const fromImplied = () => {
    const p = parseFloat(implied.value);
    if (!Number.isFinite(p) || p <= 0 || p >= 100) return;
    const d = 1 / (p / 100);
    decimal.value = d.toFixed(2);
    american.value = odds.fmtAmerican(odds.decimalToAmerican(d));
  };
  american.addEventListener("input", fromAmerican);
  decimal.addEventListener("input", fromDecimal);
  implied.addEventListener("input", fromImplied);

  return card("Odds converter", "Edit any field and the others follow.", [
    h("div", { class: "tl-inputs" },
      field("American", american, "e.g. -110 or +150"),
      field("Decimal", decimal),
      field("Implied probability %", implied)),
  ]);
}

// ------------------------------------------------------------------- devig
function devigCard() {
  const oddsA = textInput("-120");
  const oddsB = textInput("+100");
  const result = resultBox();

  function recompute() {
    const a = parseFloat(oddsA.value), b = parseFloat(oddsB.value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0) {
      showMessage(result, "Enter both sides' odds.");
      return;
    }
    const decA = odds.americanToDecimal(a), decB = odds.americanToDecimal(b);
    const [pA, pB] = odds.novigTwoWay(decA, decB);
    const hold = (odds.impliedProb(decA) + odds.impliedProb(decB) - 1) * 100;
    showResult(result, [
      kpi("Side A fair", `${(pA * 100).toFixed(1)}%`, `Fair odds ${odds.fmtAmerican(odds.probToAmerican(pA))}`),
      kpi("Side B fair", `${(pB * 100).toFixed(1)}%`, `Fair odds ${odds.fmtAmerican(odds.probToAmerican(pB))}`),
    ], [resultRow("Book hold", `${hold.toFixed(2)}%`)]);
  }
  oddsA.addEventListener("input", recompute);
  oddsB.addEventListener("input", recompute);
  recompute();

  return card("Devig", "Take the book's margin out of a two way market.", [
    h("div", { class: "tl-inputs is-pair" }, field("Side A odds", oddsA), field("Side B odds", oddsB)),
    result,
  ]);
}

// ------------------------------------------------------------------ parlay
function parlayCard() {
  let legs = [-110, -110, -110];
  const legsId = `tl-legs-${++_uid}`;
  const legsGrid = h("div", { class: "tl-legs" });
  const stakeInput = numInput("10", { step: "1", min: "0" });
  const legsCount = h("select", { class: "select-input" });
  for (let n = 2; n <= 8; n++) {
    legsCount.appendChild(h("option", { value: String(n), selected: n === 3 ? true : null }, `${n} legs`));
  }
  const result = resultBox();

  function recompute() {
    const dec = odds.parlayDecimal(legs);
    const stake = parseFloat(stakeInput.value) || 0;
    showResult(result, [
      kpi("Parlay odds", odds.fmtAmerican(odds.decimalToAmerican(dec))),
    ], [
      resultRow("Decimal", dec.toFixed(2)),
      resultRow("Implied probability", `${(odds.impliedProb(dec) * 100).toFixed(1)}%`),
      resultRow("Payout on stake", `$${(stake * dec).toFixed(2)}`),
    ]);
  }
  function renderLegInputs() {
    legsGrid.replaceChildren();
    legs.forEach((val, i) => {
      const inp = textInput(odds.fmtAmerican(val), { "aria-label": `Leg ${i + 1} odds` });
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v) && v !== 0) { legs[i] = v; recompute(); }
      });
      legsGrid.appendChild(inp);
    });
  }
  legsCount.addEventListener("change", () => {
    const n = parseInt(legsCount.value, 10);
    legs = Array.from({ length: n }, (_, i) => (legs[i] !== undefined ? legs[i] : -110));
    renderLegInputs();
    recompute();
  });
  stakeInput.addEventListener("input", recompute);
  renderLegInputs();
  recompute();

  return card("Parlay", "Combine legs into one price.", [
    h("div", { class: "tl-inputs" },
      h("div", { class: "tl-inputs is-pair" },
        field("Number of legs", legsCount, null, selectBox(legsCount)),
        field("Stake $", stakeInput)),
      h("div", { class: "field", role: "group", "aria-labelledby": legsId },
        h("span", { class: "field-label", id: legsId }, "Leg odds"), legsGrid)),
    result,
  ], { full: true });
}

// ------------------------------------------------------------------- kelly
function kellyCard() {
  const winPct = numInput("55", { step: "0.1", min: "0", max: "100" });
  const offered = textInput("-110");
  const bankroll = numInput("1000", { step: "10", min: "0" });
  const result = resultBox();

  function recompute() {
    const p = parseFloat(winPct.value) / 100;
    const american = parseFloat(offered.value);
    const br = parseFloat(bankroll.value) || 0;
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(american) || american === 0) {
      showMessage(result, "Enter a win probability and offered odds.");
      return;
    }
    const f = odds.kellyFraction(p, american);
    if (f <= 0) {
      showMessage(result, "At these numbers the Kelly stake is zero.");
      return;
    }
    showResult(result, [
      kpi("Full Kelly", `${(f * 100).toFixed(1)}%`, `$${(f * br).toFixed(2)}`),
    ], [
      resultRow("Half Kelly", `${(f / 2 * 100).toFixed(1)}% · $${(f / 2 * br).toFixed(2)}`),
      resultRow("Quarter Kelly", `${(f / 4 * 100).toFixed(1)}% · $${(f / 4 * br).toFixed(2)}`),
    ]);
  }
  [winPct, offered, bankroll].forEach((el) => el.addEventListener("input", recompute));
  recompute();

  return card("Kelly stake", "A share of your bankroll, from the probability you enter.", [
    h("div", { class: "tl-inputs" },
      field("Your win probability %", winPct),
      field("Offered odds", offered),
      field("Bankroll $", bankroll)),
    result,
  ], { wide: true });
}

// ---------------------------------------------------------------------- ev
function evCard() {
  const fairPct = numInput("55", { step: "0.1", min: "0", max: "100" });
  const posted = textInput("-110");
  const stake = numInput("10", { step: "1", min: "0" });
  const result = resultBox();

  function recompute() {
    const p = parseFloat(fairPct.value) / 100;
    const american = parseFloat(posted.value);
    const st = parseFloat(stake.value) || 0;
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(american) || american === 0) {
      showMessage(result, "Enter a fair probability and posted odds.");
      return;
    }
    const evd = odds.evPerDollar(p, american);
    const evs = evd * st;
    // the sign of the user's own number as printed, in text color only: a
    // result that prints as zero has no sign
    const toneOf = (printed) => (Number(printed) > 0 ? "good" : Number(printed) < 0 ? "bad" : null);
    showResult(result, [
      kpi("EV on stake", signedMoney(evs), null, toneOf(evs.toFixed(2))),
    ], [
      resultRow("EV per $1", signedNum(evd, 3), toneOf(evd.toFixed(3))),
      resultRow("Posted implied probability", `${(odds.americanImpliedProb(american) * 100).toFixed(1)}%`),
    ]);
  }
  [fairPct, posted, stake].forEach((el) => el.addEventListener("input", recompute));
  recompute();

  return card("Expected value", "Average result per dollar at the probability you enter.", [
    h("div", { class: "tl-inputs" },
      field("Your fair probability %", fairPct),
      field("Posted odds", posted),
      field("Stake $", stake)),
    result,
  ], { wide: true });
}

function sportToolCard(t) {
  return card(t.label || t.name || t.key || "Tool", t.description || null, []);
}

async function render() {
  const app = document.getElementById("app");
  const sport = currentSport();
  const parts = [
    h("div", { class: "tl-head" },
      h("h1", {}, "Tools"),
      h("p", { class: "sub" }, "Odds converter, devig, parlay, Kelly and EV."),
      h("p", { class: "tl-note" }, "These run on your inputs only. Informational, not advice.")),
  ];

  try {
    // a sport still marked "coming" has no data folder, so there is nothing to ask for
    if (manifestStatus(sport, "research") === "coming") throw new Error("no data");
    const data = await fetchJSON(`data/${sport}/tools.json`);
    if (data && Array.isArray(data.tools) && data.tools.length) {
      parts.push(h("section", { class: "tl-sport" },
        h("h2", { class: "tl-sport-title" }, `${sport.toUpperCase()} tools`),
        h("div", { class: "tl-grid" }, data.tools.map(sportToolCard))));
    }
  } catch {
    // Sport tools are an optional enhancement; the calculators below need no data.
  }

  parts.push(h("div", { class: "tl-grid" },
    oddsConverterCard(), devigCard(), parlayCard(), kellyCard(), evCard()));

  app.replaceChildren(h("div", { class: "tools" }, parts));
}

render();
