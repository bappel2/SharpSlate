// The Prop Finder's logic with no page in it (owner 2026-09-30: Outlier style
// prop finder): which (player, prop, side) rows exist, the filters that narrow
// them, the sort, and the URL hash that carries both. Every number comes from
// propstats.js, the same code the Prop Lab draws its tiles with.
//
// Research, not picks. Nothing here sets a best price against a fair number:
// no filter, sort or flag takes both. A row's hit rates (history) and its
// fair odds (the market) sit side by side and stay separate.
//
// Pure functions of the data, so /selftest/ can run the same code on the
// published prop-lab.json and check it against an independent Python count.
import {
  hitRate, average, lineOf, parseAmerican, oddsInRange, americanDecimal, sideTone, helpScore,
  validBest, dayOf, teamAbbr,
} from "./propstats.js";
import { normName } from "./app.js";

// ---------------------------------------------------------------- state
/** The side filter: over (a yes only prop counts as over), under, or both. */
export const SIDES = ["over", "under", "both"];
/** The opponent defense filter, from the side's point of view. */
export const TONE_KEYS = ["soft", "neutral", "tough"];
const TONE_OF = { soft: 1, neutral: 0, tough: -1 };
export const TONE_LABEL = { soft: "Soft", neutral: "Neutral", tough: "Tough" };

/** Games the hit rate filter wants in a window before it counts a rate, when
 *  the viewer hasn't set it (owner 2026-09-30: "5 for L10/L20, so a 1 for 1
 *  player doesn't pass 100%"). L5 and a season are shorter windows, and a
 *  player has met today's opponent only a few times. The same numbers are in
 *  export/methodology.py (FINDER_MIN_GAMES); /selftest/ checks they agree. */
export const AUTO_MIN_GAMES = { l5: 3, last10: 5, l20: 5, h2h: 2 };
const SEASON_MIN_GAMES = 3;

export function autoMinGames(tileKey) {
  return tileKey in AUTO_MIN_GAMES ? AUTO_MIN_GAMES[tileKey] : SEASON_MIN_GAMES;
}

/** The sort keys a header can ask for. */
export const SORT_KEYS = ["player", "game", "prop", "line", "side", "price", "fair", "avg", "def", "books"];

export function defaultState(S) {
  return {
    pt: [], ps: [], tm: "", gm: "", dy: "",
    sd: "over", lmin: null, lmax: null, omin: null, omax: null,
    hw: S.tileByKey(null).key, hmin: 0, hg: null,
    sp: "all", df: [], bk: 0, thin: false, hs: true, q: "", pl: "",
    sort: "win:last10", dir: "desc",
  };
}

/** The windows the finder offers: the Prop Lab's tiles without last season. */
export function windowTiles(S) {
  const last = S.TILES.filter((t) => t.label === "Last season").map((t) => t.key);
  return S.TILES.filter((t) => !last.includes(t.key));
}

export function minGamesFor(S, state, tileKey) {
  return state.hg != null ? state.hg : autoMinGames(tileKey);
}

// ---------------------------------------------------------------- hash
function splitList(v) {
  return String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function num(v, lo, hi) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/**
 * The URL hash -> a state. Anything that doesn't parse, or names something
 * this slate doesn't have, falls back to its default; a half bad link still
 * opens (the good fields hold) and a wholly bad one opens the default view.
 * `facets` is what the slate has: {markets, positions, teams, games, days}.
 */
export function decodeHash(hash, S, facets) {
  const d = defaultState(S);
  const raw = {};
  for (const part of String(hash || "").replace(/^#/, "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    let v = i < 0 ? "" : part.slice(i + 1);
    try { v = decodeURIComponent(v.replace(/\+/g, "%2B")); } catch { v = ""; }
    raw[k] = v;
  }
  const wins = windowTiles(S).map((t) => t.key);
  const out = { ...d };
  out.pt = splitList(raw.pt).filter((k) => facets.markets.includes(k));
  out.ps = splitList(raw.ps).filter((k) => facets.positions.includes(k));
  if (facets.teams.includes(raw.tm)) out.tm = raw.tm;
  if (facets.games.includes(raw.gm)) out.gm = raw.gm;
  if (facets.days.includes(raw.dy)) out.dy = raw.dy;
  if (SIDES.includes(raw.sd)) out.sd = raw.sd;
  out.lmin = num(raw.lmin, -1e4, 1e4);
  out.lmax = num(raw.lmax, -1e4, 1e4);
  out.omin = raw.omin ? parseAmerican(raw.omin) : null;
  out.omax = raw.omax ? parseAmerican(raw.omax) : null;
  if (wins.includes(raw.hw)) out.hw = raw.hw;
  const hmin = num(raw.hmin, 0, 100);
  out.hmin = hmin == null ? 0 : Math.round(hmin);
  const hg = num(raw.hg, 0, 99);
  out.hg = hg == null ? null : Math.round(hg);
  if (S.DATA.lab.splits.some((s) => s.key === raw.sp)) out.sp = raw.sp;
  out.df = splitList(raw.df).filter((k) => TONE_KEYS.includes(k));
  const bk = num(raw.bk, 0, 99);
  out.bk = bk == null ? 0 : Math.round(bk);
  out.thin = raw.thin === "1";
  out.hs = raw.hs !== "0";
  out.q = String(raw.q || "").slice(0, 40);
  // a picked player, by id; one this slate doesn't have is no filter at all
  if (raw.pl && (facets.players || []).includes(raw.pl)) out.pl = raw.pl;
  if (raw.sort) {
    const [key, dir] = raw.sort.split(".");
    // a hit rate column is "win:<window key>", one of the windows offered
    const ok = SORT_KEYS.includes(key) || (key.startsWith("win:") && wins.includes(key.slice(4)));
    if (ok) {
      out.sort = key;
      out.dir = dir === "a" ? "asc" : "desc";
    }
  }
  return out;
}

/** A state -> a hash with only what differs from the default view. */
export function encodeHash(state, S) {
  const d = defaultState(S);
  const parts = [];
  const put = (k, v) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (state.pt.length) put("pt", state.pt.join(","));
  if (state.ps.length) put("ps", state.ps.join(","));
  if (state.tm) put("tm", state.tm);
  if (state.gm) put("gm", state.gm);
  if (state.dy) put("dy", state.dy);
  if (state.sd !== d.sd) put("sd", state.sd);
  if (state.lmin != null) put("lmin", state.lmin);
  if (state.lmax != null) put("lmax", state.lmax);
  if (state.omin != null) put("omin", state.omin > 0 ? `+${state.omin}` : state.omin);
  if (state.omax != null) put("omax", state.omax > 0 ? `+${state.omax}` : state.omax);
  if (state.hw !== d.hw) put("hw", state.hw);
  if (state.hmin) put("hmin", state.hmin);
  if (state.hg != null) put("hg", state.hg);
  if (state.sp !== d.sp) put("sp", state.sp);
  if (state.df.length) put("df", state.df.join(","));
  if (state.bk) put("bk", state.bk);
  if (state.thin) put("thin", "1");
  if (!state.hs) put("hs", "0");
  if (state.q) put("q", state.q);
  if (state.pl) put("pl", state.pl);
  if (state.sort !== d.sort || state.dir !== d.dir) {
    put("sort", `${state.sort}.${state.dir === "asc" ? "a" : "d"}`);
  }
  return parts.join("&");
}

// ---------------------------------------------------------------- player search
// The picker under the search box (owner 2026-10-01: "there are many players
// with the name allen"). One entry per player id, never per name: two players
// who share a name stay two entries. The match is on the start of any word of
// the name, accents and punctuation set aside, so "st brown", "smith njigba"
// and "ramirez" find Amon-Ra St. Brown, Jaxon Smith-Njigba and Ramírez.

/** A word, folded for matching: no accents, lower case, no periods or apostrophes. */
export function foldWord(s) {
  return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[.'’`]/g, "");
}

const WORD_RE = /[\p{L}\p{N}'’`.]+/gu;

/** The words of a name or a query: [{w, start, end}] with w folded and start/end in the original text. */
export function wordSpans(text) {
  const out = [];
  const src = String(text || "");
  for (const m of src.matchAll(WORD_RE)) {
    const w = foldWord(m[0]);
    if (w) out.push({ w, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The tokens of a typed query, or [] when it is under two letters in all. */
export function queryTokens(q) {
  const toks = wordSpans(q).map((x) => x.w);
  return toks.join("").length >= 2 ? toks : [];
}

/** Index entries for the picker: `list` rows carry {id, name, abbr, nProps, ...}. */
export function indexPlayers(list) {
  return list.map((e) => {
    const words = wordSpans(e.name).map((x) => x.w);
    return { ...e, words, nameF: words.join(" "), abbrF: foldWord(e.abbr) };
  });
}

/**
 * The players a typed query finds, best first, at most `max`; `total` counts
 * every match. A name that starts with the query comes first, then any name
 * with each typed word at the start of one of its words, then a name that
 * needs the team's abbreviation for one of the words (so "allen buf" and
 * "buf" work). Ties go to the player with more props, then by name.
 */
export function rankPlayers(index, q, max = 8) {
  const toks = queryTokens(q);
  if (!toks.length) return { hits: [], total: 0, tokens: [] };
  const qs = toks.join(" ");
  const found = [];
  for (const e of index) {
    let tier;
    if (toks.every((t) => e.words.some((w) => w.startsWith(t)))) tier = e.nameF.startsWith(qs) ? 0 : 1;
    else if (e.abbrF && toks.every((t) => e.abbrF.startsWith(t) || e.words.some((w) => w.startsWith(t)))) tier = 2;
    else continue;
    found.push({ e, tier });
  }
  found.sort((a, b) => a.tier - b.tier || b.e.nProps - a.e.nProps
    || a.e.name.localeCompare(b.e.name) || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
  return { hits: found.slice(0, max).map((x) => x.e), total: found.length, tokens: toks };
}

/** A name cut into [{t, m}] pieces, m = true where a typed word matched the start of a word of it. */
export function matchSegments(name, toks) {
  const src = String(name || "");
  const spans = wordSpans(src);
  const used = new Set();
  const ranges = [];
  for (const t of toks) {
    const i = spans.findIndex((x, k) => !used.has(k) && x.w.startsWith(t));
    if (i < 0) continue;
    used.add(i);
    // t.length folded letters in, walked back to the original text (a period or accent isn't a letter)
    let seen = 0, end = spans[i].start;
    for (const ch of src.slice(spans[i].start, spans[i].end)) {
      end += ch.length;
      seen += foldWord(ch).length;
      if (seen >= t.length) break;
    }
    ranges.push([spans[i].start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    if (a > at) out.push({ t: src.slice(at, a), m: false });
    out.push({ t: src.slice(a, b), m: true });
    at = b;
  }
  if (at < src.length) out.push({ t: src.slice(at), m: false });
  return out;
}

// ---------------------------------------------------------------- the finder
const SIDE_ORDER = { over: 0, yes: 0, under: 1 };

/**
 * Build the finder for one sport's data (a propstats.js context `S`). The
 * records (one per player and priced market) are made once; `rows(state)` is
 * the filtered, sorted list for a state, with each record's stats memoized per
 * split so a filter change only re-reads numbers it already has.
 */
export function createFinder(S) {
  const DATA = S.DATA;
  const lab = DATA.lab;
  const tiles = windowTiles(S);
  const splits = new Map(lab.splits.map((s) => [s.key, s]));
  const marketIdx = new Map(lab.markets.map((m, i) => [m.key, i]));
  const kickMs = new Map(DATA.slate.games.map((g) => [g.key, g.kick ? new Date(g.kick).getTime() : null]));

  // ---- records
  const recs = [];
  for (const p of DATA.players) {
    const game = S.gameByKey(p.game);
    if (!game) continue;
    for (const m of lab.markets) {
      const mk = (p.markets || {})[m.key];
      const line = lineOf(mk);
      if (line == null) continue;
      recs.push({
        id: `${p.id}|${m.key}`, p, game, m, mk, line,
        oneSided: !!mk.one_sided, thin: !!mk.thin, books: Number(mk.books) || 0,
        nameN: normName(p.name), abbrN: normName(p.team_abbr || teamAbbr(game, p.team) || ""), dayKey: (dayOf(game.kick) || {}).key || "",
        kick: kickMs.get(p.game),
      });
    }
  }

  // ---- the players on the board, one entry per id (built once, with the records)
  const sideCount = (rec) => (rec.oneSided ? 1 : 2);
  const byId = new Map();
  for (const rec of recs) {
    const id = String(rec.p.id);
    let e = byId.get(id);
    if (!e) {
      e = {
        id, name: rec.p.name, pos: rec.p.pos, team: rec.p.team,
        abbr: rec.p.team_abbr || teamAbbr(rec.game, rec.p.team),
        headshot: rec.p.headshot, game: rec.game, kick: rec.kick, nProps: 0, nOver: 0, nUnder: 0,
      };
      byId.set(id, e);
    }
    e.nProps += sideCount(rec);
    e.nOver += 1;                     // an over or a yes
    if (!rec.oneSided) e.nUnder += 1;     // the rows he has with Over, Under and Both all shown
  }
  const players = indexPlayers([...byId.values()]);
  const playerById = new Map(players.map((e) => [e.id, e]));

  // ---- facets (what the filters can offer)
  const inUse = new Set(recs.map((r) => r.m.key));
  const marketsOffered = lab.markets.filter((m) => inUse.has(m.key));
  const posSeen = new Set(recs.map((r) => r.p.pos));
  const posOrder = Object.keys(lab.pos_markets || {});
  const positions = [...posOrder.filter((x) => posSeen.has(x)), ...[...posSeen].filter((x) => !posOrder.includes(x)).sort()];
  const teamSeen = new Map();
  for (const g of DATA.slate.games) {
    teamSeen.set(g.away, teamAbbr(g, g.away));
    teamSeen.set(g.home, teamAbbr(g, g.home));
  }
  const teamsWithRows = new Set(recs.map((r) => r.p.team));
  const teams = [...teamSeen.entries()].filter(([k]) => teamsWithRows.has(k))
    .map(([key, abbr]) => ({ key, abbr })).sort((a, b) => a.abbr.localeCompare(b.abbr));
  const gamesWithRows = new Set(recs.map((r) => r.p.game));
  const games = DATA.slate.games.filter((g) => gamesWithRows.has(g.key));
  const dayMap = new Map();
  for (const g of games) { const d = dayOf(g.kick); if (d) dayMap.set(d.key, d.label); }
  const days = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, label]) => ({ key, label }));
  const facets = {
    markets: marketsOffered.map((m) => m.key), marketList: marketsOffered,
    positions, teams: teams.map((t) => t.key), teamList: teams,
    games: games.map((g) => g.key), gameList: games,
    days: days.map((d) => d.key), dayList: days,
    players: players.map((e) => e.id),
  };

  // ---- per record, per split: windows' hit rates and averages for both sides
  const memo = new Map();
  function statsFor(rec, splitKey) {
    const k = `${rec.id}|${splitKey}`;
    let st = memo.get(k);
    if (st) return st;
    const split = splits.get(splitKey) || lab.splits[0];
    st = {};
    for (const t of tiles) {
      const rows = S.filteredLog(rec.p, split, t);
      st[t.key] = {
        over: hitRate(rows, rec.m, rec.line, "over"),
        under: hitRate(rows, rec.m, rec.line, "under"),
        avg: average(rows, rec.m),
        games: rows.length,
      };
    }
    memo.set(k, st);
    return st;
  }

  const defMemo = new Map();
  function defenseOf(rec, tile) {
    const k = `${rec.id}|${tile.key}`;
    if (defMemo.has(k)) return defMemo.get(k);
    const v = S.defenseFor(rec.p, rec.m, tile);
    defMemo.set(k, v);
    return v;
  }

  // ---- one row's price and fair number for a side
  function priceOf(rec, side, now) {
    if (rec.kick != null && rec.kick <= now) return null;   // best prices vanish at kickoff
    const b = validBest(side === "under" ? rec.mk.best_under : rec.mk.best_over);
    if (!b) return null;
    return { odds: b.odds, books: b.books, dec: americanDecimal(b.odds) };
  }

  function fairOf(rec, side) {
    const mk = rec.mk;
    if (rec.thin) return { kind: "thin" };
    if (rec.oneSided) {
      // the one exception: a yes only price can't be de-vigged, so it is the
      // books' average WITH their cut, and says so
      return mk.market_odds ? { kind: "avg", odds: mk.market_odds, prob: mk.market_over } : { kind: "thin" };
    }
    const odds = side === "under" ? mk.fair_under_odds : mk.fair_over_odds;
    const prob = side === "under" ? mk.fair_under : mk.fair_over;
    return odds ? { kind: "fair", odds, prob } : { kind: "thin" };
  }

  // ---- the pipeline
  function sideList(rec, sd) {
    if (rec.oneSided) return sd === "under" ? [] : ["yes"];
    return sd === "over" ? ["over"] : sd === "under" ? ["under"] : ["over", "under"];
  }

  /**
   * Filtered, sorted rows for `state`. Returns {rows, total} (total = rows
   * before any paging; the page shows the first 100 and a Show more button).
   */
  function run(state, now = Date.now()) {
    const tile = tiles.find((t) => t.key === state.hw) || tiles[0];
    const needle = normName(state.q);
    const pt = state.pt.length ? new Set(state.pt) : null;
    const ps = state.ps.length ? new Set(state.ps) : null;
    const df = state.df.length ? new Set(state.df.map((k) => TONE_OF[k])) : null;
    const out = [];
    const wantHits = state.hmin > 0;
    // the two ends of the line range may be given in either order, as the odds pair's are
    let lmin = state.lmin, lmax = state.lmax;
    if (lmin != null && lmax != null && lmin > lmax) [lmin, lmax] = [lmax, lmin];
    const minG = minGamesFor(S, state, tile.key);
    for (const rec of recs) {
      if (state.pl && String(rec.p.id) !== state.pl) continue;
      if (pt && !pt.has(rec.m.key)) continue;
      if (ps && !ps.has(rec.p.pos)) continue;
      if (state.tm && rec.p.team !== state.tm) continue;
      if (state.gm && rec.p.game !== state.gm) continue;
      if (state.dy && rec.dayKey !== state.dy) continue;
      if (state.hs && rec.kick != null && rec.kick <= now) continue;
      if (state.thin && rec.thin) continue;
      if (rec.books < state.bk) continue;
      if (lmin != null && rec.line < lmin) continue;
      if (lmax != null && rec.line > lmax) continue;
      // a team abbreviation finds that team's players too, as the picker's list does
      if (needle && !rec.nameN.includes(needle) && rec.abbrN !== needle) continue;
      for (const side of sideList(rec, state.sd)) {
        const hitSide = side === "under" ? "under" : "over";
        const price = priceOf(rec, side, now);
        if (state.omin != null || state.omax != null) {
          if (!price || !oddsInRange(price.odds, state.omin, state.omax)) continue;
        }
        const st = statsFor(rec, state.sp);
        if (wantHits) {
          const hr = st[tile.key][hitSide];
          if (hr.d < minG || hr.d === 0 || hr.pct < state.hmin) continue;
        }
        const def = defenseOf(rec, tile);
        let tone = null;
        if (def) tone = sideTone(def.cell[3], def.moreHurts, hitSide);
        if (df && (tone == null || !df.has(tone))) continue;
        out.push({ rec, side, hitSide, price, fair: fairOf(rec, side), st, def, tone, tile });
      }
    }
    sortRows(out, state, minG);
    return { rows: out, total: out.length };
  }

  // ---- sort
  function hitValue(row, tileKey) {
    const hr = row.st[tileKey][row.hitSide];
    return hr.d ? hr : null;
  }

  function keyOf(row, key, minG) {
    switch (key) {
      case "player": return row.rec.p.name.toLowerCase();
      case "game": return row.rec.kick ?? Infinity;
      case "prop": return marketIdx.get(row.rec.m.key);
      case "line": return row.rec.line;
      case "side": return SIDE_ORDER[row.side];
      case "price": return row.price ? row.price.dec : null;
      // a yes only prop's "fair" is the books' average WITH their cut: it sits in its
      // own band after the true fair rows (no key), never ranked among the de-vigged ones
      case "fair": return row.fair.kind === "fair" ? (row.fair.prob ?? null) : null;
      case "avg": return row.st[row.tile.key].avg;
      case "books": return row.rec.books;
      case "def": {
        if (row.tone == null) return null;
        const mag = helpScore(row.def.cell, row.def.of, row.def.moreHurts).mag;
        return row.tone === 0 ? 0 : row.tone * (1 + mag);
      }
      default: {
        if (!key.startsWith("win:")) return null;
        const hr = hitValue(row, key.slice(4));
        return hr ? hr.pct : null;
      }
    }
  }

  function sortRows(list, state, minG) {
    const key = state.sort;
    const mul = state.dir === "asc" ? 1 : -1;
    const isWin = key.startsWith("win:");
    const wkey = isWin ? key.slice(4) : null;
    const need = isWin ? minGamesFor(S, state, wkey) : 0;
    const dec = list.map((row) => {
      const hr = isWin ? hitValue(row, wkey) : null;
      return {
        row, v: keyOf(row, key, minG),
        // a hit rate over fewer games than the minimum sits below the rest
        thin: isWin && hr ? hr.d < need : false,
        d: hr ? hr.d : 0,
      };
    });
    dec.sort((a, b) => {
      const an = a.v == null, bn = b.v == null;
      if (an !== bn) return an ? 1 : -1;
      if (isWin && a.thin !== b.thin) return a.thin ? 1 : -1;
      if (!an && a.v !== b.v) {
        if (typeof a.v === "string") return a.v < b.v ? -mul : mul;
        return (a.v - b.v) * mul;
      }
      if (isWin && a.d !== b.d) return b.d - a.d;          // more games first
      const bk = b.row.rec.books - a.row.rec.books;        // then the more widely posted
      if (bk) return bk;
      const nm = a.row.rec.p.name.localeCompare(b.row.rec.p.name);
      return nm || (SIDE_ORDER[a.row.side] - SIDE_ORDER[b.row.side]);
    });
    dec.forEach((x, i) => { list[i] = x.row; });
  }

  /** The picker's matches for a typed query: {hits, total, tokens}. */
  const searchPlayers = (q, max = 8) => rankPlayers(players, q, max);

  return { recs, facets, tiles, run, statsFor, fairOf, priceOf, players, playerById, searchPlayers };
}
