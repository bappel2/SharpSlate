// Odds math for the calculators: an exact port of core/odds_math.py (the
// unit-tested Python the Streamlit calculators used). Keep the two in step;
// the /selftest/ page (sharpslate/selftest.py) checks them against the Python.
//
// Python's round() is round-half-to-even and JavaScript's Math.round is not,
// so roundHalfEven() stands in wherever the Python rounds.

export function roundHalfEven(x) {
  const r = Math.round(x);
  // Math.round sends .5 up; Python sends it to the even neighbour.
  if (Math.abs(x % 1) === 0.5) return r % 2 === 0 ? r : r - 1;
  return r;
}

// +150 -> 2.5, -200 -> 1.5
export function americanToDecimal(odds) {
  const o = Math.trunc(Number(odds));
  return 1 + (o > 0 ? o / 100 : 100 / Math.abs(o));
}

// 2.5 -> +150, 1.5 -> -200 (0 when there is no price)
export function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!(d > 1)) return 0;
  return d >= 2 ? roundHalfEven((d - 1) * 100) : roundHalfEven(-100 / (d - 1));
}

export function impliedProb(dec) {
  return 1 / Number(dec);
}

export function americanImpliedProb(odds) {
  return impliedProb(americanToDecimal(odds));
}

// Proportional (multiplicative) devig of a two-way market.
export function novigTwoWay(decSide, decOpp) {
  const ps = impliedProb(decSide);
  const po = impliedProb(decOpp);
  const total = ps + po;
  return [ps / total, po / total];
}

// Probability -> fair American odds (0 outside (0, 1)).
export function probToAmerican(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) return 0;
  return decimalToAmerican(1 / x);
}

// Combined decimal odds for independent legs (American odds in).
export function parlayDecimal(oddsList) {
  return oddsList.reduce((acc, o) => acc * americanToDecimal(o), 1);
}

// Full-Kelly fraction of bankroll; 0 when there is no edge.
export function kellyFraction(p, oddsAmerican) {
  const b = americanToDecimal(oddsAmerican) - 1;
  if (b <= 0) return 0;
  return Math.max(0, (b * p - (1 - p)) / b);
}

// EV per $1 staked.
export function evPerDollar(p, oddsAmerican) {
  return p * (americanToDecimal(oddsAmerican) - 1) - (1 - p);
}

// "+150" / "-110" display.
export function fmtAmerican(n) {
  const v = Math.trunc(Number(n));
  return v > 0 ? `+${v}` : String(v);
}
