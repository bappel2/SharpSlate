// Tools: odds calculators that work for every sport with no data at all,
// plus an optional sport-specific tools listing (empty for NFL today).
// Laid out like the Prop Lab (redesign 2026-09-30): cards with a display face
// title, small uppercase field labels, and results as a headline number over a
// few quiet rows. Every number is the user's own inputs run through
// oddsmath.js; nothing here says what to bet.
import { h, fetchJSON, currentSport, pageHeading, manifestStatus, root } from "../app.js";
import * as odds from "../oddsmath.js";
import { uid, textInput, numInput, selectBox, field, kpi, resultRow, resultBox, showResult, card } from "../calc-ui.js";
// the other four calculators, shared with their stand alone pages (2026-10-29)
import { oddsConverterCard, devigCard, kellyCard, evCard } from "../calc-cards.js";

// ------------------------------------------------------------------ parlay
function parlayCard() {
  let legs = [-110, -110, -110];
  const legsId = uid("tl-legs");
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
    // the stand alone page (2026-10-19): pushes, fair odds and the margin
    h("a", { class: "home-link tl-more", href: `${root()}parlay-calculator/` },
      "Full parlay calculator"),
  ], { full: true });
}

function sportToolCard(t) {
  return card(t.label || t.name || t.key || "Tool", t.description || null, []);
}

async function render() {
  const app = document.getElementById("app");
  const sport = currentSport();
  const parts = [
    h("div", { class: "tl-head" },
      h("h1", {}, pageHeading("Betting Calculators")),
      h("p", { class: "sub" }, "Odds converter, no vig, parlay, Kelly and EV."),
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
    oddsConverterCard({ more: true }), devigCard({ more: true }), parlayCard(),
    kellyCard({ more: true }), evCard({ more: true })));

  app.replaceChildren(h("div", { class: "tools" }, parts));
}

render();
