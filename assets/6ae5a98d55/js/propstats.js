// The Prop Lab's number logic, shared with the Prop Finder (owner 2026-09-30:
// Outlier style prop finder). One copy, so a hit rate on the finder's row and
// the same player's tile in the Prop Lab can never disagree: game windows
// (L5, L10, L20, this season, last season, vs opponent), the home/away split,
// the hit rate at a line, the average, the opponent defense lookup and its
// tone, the logo and headshot helpers. Moved out of pages/prop-lab.js as is;
// the only additions are the UNDER side of hitRate and sideTone, which the
// Prop Lab never asks for.
//
// Everything here reads data/<sport>/prop-lab.json. Nothing here compares a
// price with a fair number: research, not picks.
import { h } from "./app.js";

// ---------------------------------------------------------------- small pure helpers
// Games strictly over the line; a push at a whole number line is not over.
// `side` "under" counts games strictly under it: a push is neither, but it
// still counts in the games played (d), so over + under + pushes = d.
export function hitRate(rows, market, line, side = "over") {
  const d = rows.length;
  let n = 0;
  if (side === "under") {
    for (const r of rows) if (Number(r[market.stat]) < line) n++;
  } else {
    for (const r of rows) if (Number(r[market.stat]) > line) n++;
  }
  return { n, d, pct: d ? (n / d) * 100 : 0 };
}

export function average(rows, market) {
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (Number(r[market.stat]) || 0), 0) / rows.length;
}

export function lineOf(mkData) {
  return mkData && mkData.line != null ? Number(mkData.line) : null;
}

export function fmtLineValue(v) {
  return v == null ? "No line" : String(Number(v));
}

export function rateClass(pct) {
  return pct >= 60 ? "is-good" : pct <= 40 ? "is-bad" : "is-mid";
}

// The abbreviation a team is printed as. NFL keys its teams by abbreviation;
// CFB keys them by ESPN team id and carries the abbreviation beside it.
export function teamAbbr(game, key) {
  if (key === game.away) return game.away_abbr || key;
  if (key === game.home) return game.home_abbr || key;
  return key;
}

export function teamName(game, key) {
  return (key === game.away ? game.away_name : game.home_name) || teamAbbr(game, key);
}

// ---------------------------------------------------------------- rank phrase + tone
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

// "6th most", "Most", "Fewest", "3rd fewest" -- never a bare rank number.
export function rankPhrase(rank, of) {
  if (rank == null || !of) return "N/A";
  if (rank === 1) return "Most";
  if (rank === of) return "Fewest";
  if (rank <= of / 2) return `${ordinal(rank)} most`;
  return `${ordinal(of + 1 - rank)} fewest`;
}

// Rank colors (owner, 2026-09-27: "green it helps the player in question.
// yellow is neutral, red is bad"). The exporter decides the tone, since it
// knows the ties and which rows are the defense's own plays (sacks, INTs,
// takeaways), where more hurts him: 1 helps, 0 neutral, -1 hurts.
export const TONES = {
  1: { cls: "is-help", label: "Helps him" },
  0: { cls: "is-even", label: "Neutral" },
  [-1]: { cls: "is-hurt", label: "Hurts him" },
};

// Where a defense sits from the player's side: the sign (+ helps him, - hurts
// him) and how far out toward that end of the league (0 at the middle, 1 at
// an extreme). The phrase carries the nearer end and its distance, ties
// included ("Most", "6th most", "3rd fewest", "Fewest"); a row flagged
// more_hurts (sacks, INTs, takeaways) is the defense's own play, so a lot of
// it hurts him. The exporter's tone has the last word on the sign.
export function helpScore(cell, of, moreHurts) {
  const [, most, phrase, tone] = cell;
  const text = phrase || rankPhrase(most, of);
  const fewer = /fewest$/i.test(text);
  const m = /^(\d+)/.exec(text);
  const far = /^(most|fewest)$/i.test(text) ? 1 : (m ? Number(m[1]) : most);
  const half = Math.max(1, ((of || 32) - 1) / 2);
  const mag = Math.max(0, Math.min(1, 1 - (far - 1) / half));
  let sign = fewer ? -1 : 1;
  if (moreHurts) sign = -sign;
  if (tone === 1) sign = 1;
  else if (tone === -1) sign = -1;
  return { sign, mag, tone };
}

/**
 * The defense's tone for the SIDE of a prop, not for the player: 1 soft (the
 * stat goes this side more easily), 0 neutral, -1 tough, null when the defense
 * has no tone. The exporter's tone is the PLAYER's (1 = the defense helps him
 * do well). For an OVER on yards that is the same thing: a defense that
 * allows the most receiving yards is soft for the over and tough for the
 * under. Two flips follow: a stat whose total hurts him (`moreHurts`: sacks,
 * INTs, takeaways) turns the player's tone around for the OVER, since a
 * defense that forces the most INTs is soft for an interceptions over; and
 * the UNDER is always the over turned around.
 */
export function sideTone(tone, moreHurts, side) {
  if (tone !== 1 && tone !== 0 && tone !== -1) return null;
  let t = tone;
  if (moreHurts) t = -t;
  if (side === "under") t = -t;
  return t === 0 ? 0 : t;                              // never -0
}

// ---------------------------------------------------------------- odds order
// American odds on one number line do not sort by their raw value: -110 is a
// shorter price than +100 (decimal 1.909 against 2.0), and +100 and -100 are
// the same price. Compare by decimal payout.
export function americanDecimal(odds) {
  const o = Math.trunc(Number(odds));
  if (!Number.isFinite(o) || o === 0 || (o > -100 && o < 100)) return null;
  return 1 + (o > 0 ? o / 100 : 100 / Math.abs(o));
}

/** "+250" / "-200" / "250" -> an integer American price, or null if it isn't one. */
export function parseAmerican(text) {
  const s = String(text == null ? "" : text).trim().replace(/^−/, "-");
  if (!/^[+-]?\d{3,5}$/.test(s)) return null;
  const n = Number(s);
  return americanDecimal(n) == null ? null : n;
}

/** Is `odds` (a string like "-112") inside [lo, hi] (integers or null = open)?
 *  Read by payout, so -200 to +250 holds -110 and +100 and not -300 or +300;
 *  the two ends may be given in either order. No price is out. */
export function oddsInRange(odds, lo, hi) {
  const d = americanDecimal(odds);
  if (d == null) return false;
  let dl = lo == null ? -Infinity : americanDecimal(lo);
  let dh = hi == null ? Infinity : americanDecimal(hi);
  if (dl == null || dh == null) return false;
  if (dl > dh) [dl, dh] = [dh, dl];
  return d >= dl - 1e-9 && d <= dh + 1e-9;
}

// ---------------------------------------------------------------- images
export function teamLogoImg(url, abbr, size) {
  const fallback = () => h("span", { class: "pl-logo-fallback", style: `width:${size}px;height:${size}px` }, abbr || "");
  if (!url) return fallback();
  const img = h("img", {
    src: url, alt: abbr || "", width: size, height: size,
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => { img.replaceWith(fallback()); }, { once: true });
  return img;
}

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function initialsCircle(name, size, cls) {
  return h("span", { class: `pl-avatar ${cls}`, style: `width:${size}px;height:${size}px` }, initials(name));
}

// The NFL's headshot links serve the full 3400px photo (about 500KB each, a
// dozen to a team list). Its image host resizes on request, so ask for the size
// the page draws, twice over for a sharp screen. A link it won't resize falls
// back to the original, then to initials. ESPN's headshots are left alone.
export function sizedHeadshot(url, size) {
  const m = /^(https:\/\/static\.www\.nfl\.com\/image\/upload\/)f_auto,q_auto(\/.+)$/.exec(url || "");
  return m ? `${m[1]}f_auto,q_auto,w_${size * 2},h_${size * 2},c_fill,g_face${m[2]}` : url;
}

export function headshotImg(url, name, size, cls) {
  if (!url) return initialsCircle(name, size, cls);
  const img = h("img", {
    src: sizedHeadshot(url, size), alt: "", width: size, height: size, class: `pl-avatar ${cls}`,
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    else img.replaceWith(initialsCircle(name, size, cls));
  });
  return img;
}

// ---------------------------------------------------------------- best price
// Owner 2026-09-29: "the site should just show the best line and what book its
// from. thats what people want when they place a bet." Beside the fair line,
// never instead of it and never marked against it: a price and a book. A side
// with no best price (the game has kicked off, or no book quoted it) draws
// nothing at all.
export function validBest(b) {
  return b && typeof b.odds === "string" && Array.isArray(b.books) && b.books.length ? b : null;
}

// One or two books are named outright; a longer tie shows the first and a
// count, with every name in the button's tooltip, its accessible name, and
// (tap or click) the line itself, so a phone can read the list too.
export function bookLine(books, cls = "pl-odds-book") {
  if (books.length <= 2) return h("span", { class: cls }, books.join(", "));
  const full = `${books.slice(0, -1).join(", ")} and ${books[books.length - 1]}`;
  const short = `${books[0]} and ${books.length - 1} more`;
  const btn = h("button", { type: "button", class: `${cls} pl-odds-more`, "aria-expanded": "false", title: full });
  const paint = (open) => {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) btn.replaceChildren(full);
    else btn.replaceChildren(short, h("span", { class: "visually-hidden" }, `: ${full}`));
  };
  paint(false);
  btn.addEventListener("click", () => paint(btn.getAttribute("aria-expanded") !== "true"));
  return btn;
}

// ---------------------------------------------------------------- days
const ET_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
const ET_YMD = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export function dayOf(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return { key: ET_YMD.format(d), label: ET_DAY.format(d) };
}

// ---------------------------------------------------------------- the data context
/**
 * Everything that reads one sport's prop-lab.json: its log columns, windows,
 * logos and defense table. Build once per page load.
 */
export function createStats(DATA) {
  const COL_IDX = {};
  DATA.lab.log_cols.forEach((c, i) => { COL_IDX[c] = i; });
  const parsed = new WeakMap();                         // player -> his log, parsed once
  const gameIdx = new Map(DATA.slate.games.map((g) => [g.key, g]));

  function parseRow(arr) {
    const o = {};
    for (const c of DATA.lab.log_cols) o[c] = arr[COL_IDX[c]];
    return o;
  }

  /** A player's whole log as objects, oldest first. Parsed once and shared:
   *  callers slice or filter it, never change it. */
  function rowsOf(player) {
    let rows = parsed.get(player);
    if (!rows) { rows = (player.log || []).map(parseRow); parsed.set(player, rows); }
    return rows;
  }

  // A log row knows its opponent by the same key the defense block uses: the
  // abbreviation (NFL) or the ESPN team id (CFB, whose rows carry `opp_id`).
  function oppKeyOf(row) {
    return COL_IDX.opp_id !== undefined ? row.opp_id : row.opp;
  }

  function vsOpponent(row, player) {
    const k = oppKeyOf(row);
    return k != null && String(k) === String(player.opp);
  }

  // Split first, then window -- exactly the order the spec fixes, since a
  // "last N" window means the last N games AT that split, not overall. The
  // vs-opponent window reads every logged game against today's opponent.
  function filteredLog(player, split, win) {
    let rows = rowsOf(player);
    if (split && split.home === 0) rows = rows.filter((r) => r.home === 0);
    else if (split && split.home === 1) rows = rows.filter((r) => r.home === 1);
    if (win) {
      if (win.h2h) rows = rows.filter((r) => vsOpponent(r, player));
      else if (win.last != null) rows = rows.slice(-win.last);
      else if (win.season != null) rows = rows.filter((r) => r.season === win.season);
    }
    return rows;
  }

  // The hit rate tiles ARE the window control. The data's own windows (last 10
  // and two seasons) keep their keys, so a shared link from before the tiles
  // still opens on the same tile; L5, L20 and vs-opponent are added here, for
  // the player's log only (the defense block keeps the windows it was ranked in).
  function buildTiles() {
    const W = DATA.lab.windows;
    const seasons = W.filter((w) => w.season != null).sort((a, b) => b.season - a.season);
    const last10 = W.find((w) => w.last === 10) || { key: "last10", last: 10 };
    const tiles = [
      { key: "l5", label: "L5", long: "Last 5", last: 5 },
      { ...last10, label: "L10", long: "Last 10" },
      { key: "l20", label: "L20", long: "Last 20", last: 20 },
    ];
    if (seasons[0]) tiles.push({ ...seasons[0], label: "This season", long: String(seasons[0].season) });
    if (seasons[1]) tiles.push({ ...seasons[1], label: "Last season", long: String(seasons[1].season) });
    tiles.push({ key: "h2h", label: "vs Opp", long: "vs opponent", h2h: true });
    return tiles;
  }
  const TILES = buildTiles();

  function tileByKey(key) {
    return TILES.find((t) => t.key === key)
      || TILES.find((t) => t.key === DATA.lab.default_window) || TILES[0];
  }

  // The defense is ranked over its own last 10 or one season. A season tile
  // reads that season; every other tile reads the default window.
  function defenseWindow(tile) {
    if (tile.season != null) return DATA.lab.windows.find((w) => w.season === tile.season) || tile;
    return DATA.lab.windows.find((w) => w.key === DATA.lab.default_window) || DATA.lab.windows[0];
  }

  function tileLabel(tile, player, game) {
    return tile.h2h ? `vs ${teamAbbr(game, player.opp)}` : tile.label;
  }

  // The opponent's defense rank for this market's stat, read in the season the
  // game was played (1 = allowed the most). Only a defense the data ranks has one:
  // every NFL team, and the CFB teams on this slate.
  function barRank(player, market, row) {
    const rowKey = (((DATA.lab.matchup || {}).market_row || {})[player.pos] || {})[market.key];
    if (!rowKey) return null;
    const de = ((DATA.defense || {})[oppKeyOf(row)] || {})[String(row.season)];
    const cell = de && de.pos && de.pos[player.pos] && de.pos[player.pos][rowKey];
    return cell ? { n: cell[1], phrase: cell[2] } : null;
  }

  /**
   * Today's opponent's defense against this player's position for this
   * market's stat, in the window `tile` reads: {cell: [per game, rank,
   * phrase, tone], of, moreHurts} or null (no matchup section, a market with
   * no defense row, an FCS or unranked defense).
   */
  function defenseFor(player, market, tile) {
    const m = DATA.lab.matchup;
    if (!m || !m.rows) return null;
    const rowKey = ((m.market_row || {})[player.pos] || {})[market.key];
    if (!rowKey) return null;
    const de = ((DATA.defense || {})[player.opp] || {})[defenseWindow(tile).key];
    const cell = de && de.pos && de.pos[player.pos] && de.pos[player.pos][rowKey];
    if (!cell) return null;
    const def = (m.rows[player.pos] || []).find((r) => r.key === rowKey);
    return { cell, of: de.of, moreHurts: !!(def && def.more_hurts) };
  }

  // ---------------------------------------------------------------- logos
  // The slate carries a logo for the teams playing now. A past game's opponent
  // is keyed the way the log keys it, so the slate's own logo comes first and
  // ESPN's public logo path fills in the rest (NFL by abbreviation, CFB by team
  // id). Same host, nothing new.
  const LOGOS = {};
  for (const g of DATA.slate.games) {
    if (g.away_logo) LOGOS[g.away] = g.away_logo;
    if (g.home_logo) LOGOS[g.home] = g.home_logo;
  }

  function oppLogoUrl(row) {
    const key = oppKeyOf(row);
    if (key == null || key === "") return null;
    if (LOGOS[key]) return LOGOS[key];
    if (COL_IDX.opp_id !== undefined) return `https://a.espncdn.com/i/teamlogos/ncaa/500/${key}.png`;
    return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(key).toLowerCase()}.png`;
  }

  // Pregame prices only. The build strips them once a game kicks off, but it
  // runs every 30 minutes, so the page checks the clock too (Fable 9/29).
  function kickedOff(player) {
    const g = player && gameIdx.get(player.game);
    return Boolean(g && g.kick && new Date(g.kick).getTime() <= Date.now());
  }

  return {
    DATA, COL_IDX, TILES, LOGOS,
    parseRow, rowsOf, oppKeyOf, vsOpponent, filteredLog,
    tileByKey, defenseWindow, tileLabel, barRank, defenseFor, oppLogoUrl, kickedOff,
    gameByKey: (key) => gameIdx.get(key),
  };
}

