// The odds converter, no vig, Kelly and expected value calculators, as cards
// (moved out of pages/tools.js 2026-10-29). The Tools page shows all of them
// with a link to each one's own page ({ more: true }); each stand alone page
// (sharpslate/calculators.py) draws its own card alone, at the article's width.
// Every number is the user's own inputs run through oddsmath.js; nothing here
// says what to bet.
import { h, root } from "./app.js";
import * as odds from "./oddsmath.js";
import {
  textInput, numInput, field, kpi, resultRow, resultBox, showMessage, showResult, card,
  signedNum, signedMoney,
} from "./calc-ui.js";

// the Tools card's link to the calculator's own page
function more(opts, key, text) {
  return opts.more ? h("a", { class: "home-link tl-more", href: `${root()}${key}/` }, text) : null;
}

// ------------------------------------------------------------- odds converter
export function oddsConverterCard(opts = {}) {
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
    more(opts, "odds-converter", "Odds converter page"),
  ]);
}

// ------------------------------------------------------------------- devig
export function devigCard(opts = {}) {
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

  return card("No vig", "Take the book's margin out of a two way market.", [
    h("div", { class: "tl-inputs is-pair" }, field("Side A odds", oddsA), field("Side B odds", oddsB)),
    result,
    more(opts, "no-vig-calculator", "No vig calculator page"),
  ]);
}

// ------------------------------------------------------------------- kelly
export function kellyCard(opts = {}) {
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
    more(opts, "kelly-calculator", "Kelly calculator page"),
  ], { wide: true });
}

// ---------------------------------------------------------------------- ev
export function evCard(opts = {}) {
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
    more(opts, "ev-calculator", "Expected value calculator page"),
  ], { wide: true });
}
