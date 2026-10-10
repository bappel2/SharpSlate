// Prop Lab: GENERIC across every sport, driven only by data/<sport>/prop-lab.json
// (owner, 2026-09-26, shown the old MLB Prop Lab: "can we keep this same
// layout/theme for all sports? i think it looks professional and pleasing to
// the eye"). NFL and CFB plug in now; MLB/NBA plug in later with the same code,
// no changes needed here -- everything sport-specific (markets, positions,
// windows, splits, log columns) rides in `lab`.
//
// Redesign (owner 2026-09-30, "more professional, like the popular prop
// sites"): three columns on a desktop -- a compact GAME rail, a PLAYER LIST
// (headshot, line, last-10 hit rate and a sparkline per row) and the player's
// detail: a header with a KPI row, market TABS, the best prices as sportsbook
// style boxes, HIT RATE TILES that pick the window, the game log chart, the
// advanced block and a DEFENSE block of diverging bars. A tablet turns the rail
// into a scroller on top; a phone adds a team toggle and folds the list behind
// a button that shows the selected player.
//
// Selection lives in the URL hash (#g=..&t=..&p=..&m=..&w=..&s=..) so any card
// is linkable; the home page's #g=<game key> deep link (no other params) still
// works because every other field falls back to a computed default when
// absent or invalid. The w values that shipped before the tiles (last10, the
// two season keys) are tile keys too, so old links land on the same window.
import {
  h, root, fetchJSON, currentSport, comingState, errorState, missingState, emptyState, notice,
  getComingText, setFooterSources, manifestStatus, fmtKick, fmtDec1, fmtPercent, fmtSigned,
} from "../app.js";
// The number logic (windows, split, hit rate, defense lookup, images) lives in
// propstats.js, shared with the Prop Finder (owner 2026-09-30).
import {
  createStats, hitRate, average, lineOf, fmtLineValue, rateClass, teamAbbr, teamName,
  rankPhrase, TONES, helpScore, teamLogoImg, headshotImg, validBest, bookLine, dayOf,
} from "../propstats.js";

let DATA = null;
let S = null;                 // the shared number logic for this sport's data (propstats.js)
let COL_IDX = {};
let TILES = [];
let state = { game: null, team: null, player: null, market: null, window: null, split: null };
let ui = { listOpen: false, focus: null, roster: null };
let railHost, teamHost, pickHost, listHost, listCol, detailHost;
const compactMQ = window.matchMedia("(max-width: 639px)");
const stackedMQ = window.matchMedia("(max-width: 899px)");

// ---------------------------------------------------------------- hash
function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  const out = {};
  for (const part of raw.split("&")) {
    if (!part) continue;
    const [k, v] = part.split("=");
    // a hand-edited or truncated link (#g=%E0) must not blank the page
    try { out[k] = v ? decodeURIComponent(v) : undefined; } catch { out[k] = undefined; }
  }
  return out;
}

function writeHash() {
  const q = `g=${encodeURIComponent(state.game || "")}&t=${encodeURIComponent(state.team || "")}` +
    `&p=${encodeURIComponent(state.player || "")}&m=${encodeURIComponent(state.market || "")}` +
    `&w=${encodeURIComponent(state.window || "")}&s=${encodeURIComponent(state.split || "")}`;
  history.replaceState(null, "", `#${q}`);
}

// ---------------------------------------------------------------- data helpers
const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3 };

function gameByKey(key) {
  return DATA.slate.games.find((g) => g.key === key);
}


function topTeamForGame(game) {
  let best = null;
  for (const p of DATA.players) {
    if (p.game !== game.key) continue;
    if (!best || (p.dk_proj ?? -1) > (best.dk_proj ?? -1)) best = p;
  }
  return (best && best.team) || game.away;
}

function teamRoster(gameKey, team) {
  return DATA.players.filter((p) => p.game === gameKey && p.team === team)
    .sort((a, b) => (POS_ORDER[a.pos] ?? 9) - (POS_ORDER[b.pos] ?? 9) || (b.dk_proj ?? -1) - (a.dk_proj ?? -1));
}

// Markets with a fair number first (in lab.markets order), then this
// position's other pos_markets, priced thin or not at all -- so the game log
// is always one click away even before a book prices it -- then any other
// thin market. A lone book's anytime TD no longer leads the tab row.
function marketsForPlayer(p) {
  const full = (m) => p.markets && p.markets[m.key] && !p.markets[m.key].thin;
  const withLine = DATA.lab.markets.filter(full);
  const seen = new Set(withLine.map((m) => m.key));
  const byKey = new Map(DATA.lab.markets.map((m) => [m.key, m]));
  const posOnly = (DATA.lab.pos_markets[p.pos] || [])
    .filter((k) => !seen.has(k))
    .map((k) => byKey.get(k))
    .filter(Boolean);
  posOnly.forEach((m) => seen.add(m.key));
  const thinRest = DATA.lab.markets.filter((m) => !seen.has(m.key) && p.markets && p.markets[m.key]);
  return [...withLine, ...posOnly, ...thinRest];
}

// A player's card opens on his position's default market: the first of its
// pos_markets (owner 2026-09-27: QB pass yds, RB rush yds, WR and TE rec
// yds), whether or not a book has priced it yet. It used to jump to the first
// market with a line, so a Tuesday board of anytime TDs alone opened nearly
// every card on the TD market (owner 2026-09-29: "you changed the defaults").
function defaultMarket(player, markets) {
  if (!player) return null;
  const pref = markets.find((m) => m.key === (DATA.lab.pos_markets[player.pos] || [])[0]);
  return pref || markets[0] || null;
}

// ---------------------------------------------------------------- selection
function setState(patch, focus) {
  const next = { ...state, ...patch };
  const game = DATA.slate.games.find((g) => g.key === next.game) || DATA.slate.games[0];
  const teams = [game.away, game.home];
  const team = teams.includes(next.team) ? next.team : topTeamForGame(game);
  const roster = teamRoster(game.key, team);
  const player = roster.find((p) => p.id === next.player) || roster[0] || null;
  const markets = player ? marketsForPlayer(player) : [];
  // A market the viewer picked (or a linked card's m=) holds while the player
  // stays; a new player opens on his own default, so a TD pick made on one
  // card never carries a QB into the TD market.
  const same = player && player.id === state.player;
  const wanted = "market" in patch ? patch.market : (same ? state.market : null);
  const market = markets.find((m) => m.key === wanted) || defaultMarket(player, markets);
  const win = S.tileByKey(next.window);
  const split = DATA.lab.splits.find((s) => s.key === next.split) || DATA.lab.splits[0];

  state = {
    game: game.key, team, player: player ? player.id : null, market: market ? market.key : null,
    window: win ? win.key : null, split: split ? split.key : null,
  };
  if (focus !== undefined) ui.focus = focus;
  writeHash();
  renderAll();
}

// ---------------------------------------------------------------- game rail

// "Sun 1:00 PM" with the day in its own span: a tall rail groups games under a
// day heading and drops it from the row; the scroller keeps it in the row.
function gameTime(iso) {
  const full = fmtKick(iso);
  const cut = full.indexOf(" ");
  if (cut < 0) return h("span", { class: "pl-game-time num" }, full);
  return h("span", { class: "pl-game-time num" },
    h("span", { class: "pl-game-day" }, `${full.slice(0, cut)} `), full.slice(cut + 1));
}

function buildGameRow(g) {
  const pressed = g.key === state.game;
  const label = `${g.away_name || teamAbbr(g, g.away)} at ${g.home_name || teamAbbr(g, g.home)}, ${fmtKick(g.kick)} ET`;
  const btn = h("button", {
    type: "button", class: "pl-game", "aria-pressed": pressed ? "true" : "false",
    "aria-label": label, "data-fid": `g:${g.key}`,
  },
    h("span", { class: "pl-game-teams" },
      teamLogoImg(g.away_logo, teamAbbr(g, g.away), 22),
      h("span", { class: "pl-game-at" }, "@"),
      teamLogoImg(g.home_logo, teamAbbr(g, g.home), 22)),
    gameTime(g.kick));
  btn.addEventListener("click", () => setState({ game: g.key }));
  return btn;
}

function buildRail() {
  const out = [];
  let lastDay = null;
  for (const g of DATA.slate.games) {
    const day = dayOf(g.kick);
    if (day && day.key !== lastDay) {
      out.push(h("div", { class: "pl-rail-day" }, day.label));
      lastDay = day.key;
    }
    out.push(buildGameRow(g));
  }
  return out;
}

// ---------------------------------------------------------------- team toggle + player list
function buildTeamToggle(game) {
  const teams = [
    { key: game.away, abbr: teamAbbr(game, game.away), logo: game.away_logo },
    { key: game.home, abbr: teamAbbr(game, game.home), logo: game.home_logo },
  ];
  return h("div", { class: "pl-teams", role: "group", "aria-label": "Team" }, teams.map((t) => {
    const btn = h("button", {
      type: "button", class: "pl-team", "aria-pressed": t.key === state.team ? "true" : "false",
      "data-fid": `t:${t.key}`,
    }, teamLogoImg(t.logo, t.abbr, 22), h("span", {}, t.abbr));
    btn.addEventListener("click", () => {
      ui.listOpen = true;                   // a phone picks a team to choose a player
      setState({ team: t.key });
    });
    return btn;
  }));
}

// Last 10 values as mini bars against the prop line: over green, under red, a
// push muted, and a faint tick where the line sits. No line, no colors.
function sparkline(values, line) {
  const W = 47, H = 22, bw = 3.6, gap = 1.2, pad = 2;
  const peak = Math.max(...values, line != null ? line : 0, 1);
  const y = (v) => H - pad - (v / peak) * (H - pad * 2);
  const svg = svgEl("svg", { class: "pl-spark", viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true", focusable: "false" });
  values.forEach((v, i) => {
    const x = W - (values.length - i) * (bw + gap) + gap;
    const cls = line == null ? "is-none" : v > line ? "is-over" : v < line ? "is-under" : "is-push";
    const top = y(v);
    svg.appendChild(svgEl("rect", { class: cls, x: x.toFixed(1), y: Math.min(top, H - pad - 1).toFixed(1), width: bw, height: Math.max(1, H - pad - top).toFixed(1), rx: 1 }));
  });
  if (line != null) {
    svg.appendChild(svgEl("line", { class: "pl-spark-line", x1: 0, x2: W, y1: y(line).toFixed(1), y2: y(line).toFixed(1) }));
  }
  return svg;
}

// One player's row: his default market's line, the last 10 games against it.
function playerRowBits(p) {
  const market = defaultMarket(p, marketsForPlayer(p));
  const mk = market && p.markets ? p.markets[market.key] : null;
  const line = lineOf(mk);
  const last10 = S.rowsOf(p).slice(-10);
  const values = market ? last10.map((r) => Number(r[market.stat]) || 0) : [];
  const hr = market && line != null && last10.length ? hitRate(last10, market, line) : null;
  return { market, mk, line, values, hr };
}

function buildPlayerRow(p) {
  const { market, mk, line, values, hr } = playerRowBits(p);
  const pressed = p.id === state.player;
  const lineText = !market ? "" : line == null ? null : (mk.one_sided ? "Yes" : fmtLineValue(line));
  const sub = h("span", { class: "pl-prow-sub" },
    `${p.pos} · `,
    lineText === null
      ? h("span", { class: "is-muted" }, "No line")
      : h("span", { class: "num" }, lineText), market && lineText ? ` ${market.short}` : "");
  const aria = `${p.name}, ${p.pos}` + (market && line != null
    ? `, ${market.label} line ${fmtLineValue(line)}${hr ? `, ${mk.one_sided ? "scored in" : "over in"} ${hr.n} of the last ${hr.d}` : ""}` : ", no line");
  const btn = h("button", {
    type: "button", class: "pl-prow", "aria-pressed": pressed ? "true" : "false",
    "aria-label": aria, "data-fid": `p:${p.id}`,
  },
    headshotImg(p.headshot, p.name, 28, "pl-avatar-sm"),
    h("span", { class: "pl-prow-id" }, h("span", { class: "pl-prow-name" }, p.name), sub),
    hr ? h("span", { class: `pl-rate num ${rateClass(hr.pct)}` }, `${hr.n}/${hr.d}`) : h("span", { class: "pl-rate-gap" }),
    values.length ? sparkline(values, line) : h("span", { class: "pl-spark-gap" }));
  btn.addEventListener("click", () => {
    ui.listOpen = false;
    // a phone's list closes on the pick, so the pick button keeps the focus
    setState({ player: p.id }, stackedMQ.matches ? "pick" : undefined);
  });
  return btn;
}

function buildPickButton(player) {
  if (!player) return null;
  const { market, mk, line } = playerRowBits(player);
  const lineText = !market || line == null ? "No line" : `${mk.one_sided ? "Yes" : fmtLineValue(line)} ${market.short}`;
  const btn = h("button", {
    type: "button", class: "pl-pick", "aria-expanded": ui.listOpen ? "true" : "false",
    "aria-controls": "pl-list", "data-fid": "pick",
  },
    headshotImg(player.headshot, player.name, 34, "pl-avatar-sm"),
    h("span", { class: "pl-prow-id" },
      h("span", { class: "pl-prow-name" }, player.name),
      h("span", { class: "pl-prow-sub" }, `${player.pos} · ${lineText}`)),
    h("span", { class: "pl-pick-cue", "aria-hidden": "true" }));
  btn.addEventListener("click", () => {
    ui.listOpen = !ui.listOpen;
    listCol.classList.toggle("is-open", ui.listOpen);
    btn.setAttribute("aria-expanded", ui.listOpen ? "true" : "false");
  });
  return btn;
}

// ---------------------------------------------------------------- header + KPIs
function kpi(label, value, sub, opts = {}) {
  const cls = `pl-kpi${opts.wide ? " is-wide" : ""}`;
  const vcls = `pl-kpi-v num${opts.tone ? ` is-${opts.tone}` : ""}`;
  const el = h("div", { class: cls },
    h("div", { class: "pl-kpi-l" }, label),
    h("div", { class: vcls }, value),
    sub ? h("div", { class: "pl-kpi-s" }, sub) : null);
  if (opts.help) { el.title = opts.help; el.setAttribute("aria-label", `${label}: ${value}. ${opts.help}`); }
  return el;
}

function buildKpis(market, mkData, rows, tile, hr) {
  const hasLine = lineOf(mkData) != null;
  const oneSided = hasLine && mkData.one_sided;
  const books = hasLine ? `${mkData.books} book${mkData.books === 1 ? "" : "s"}` : "";
  const cells = [];
  cells.push(kpi("Line", !hasLine ? "No line" : (oneSided ? "Yes" : fmtLineValue(mkData.line)), books,
    { tone: hasLine ? null : "muted" }));
  if (hasLine && mkData.thin) {
    // Owner 2026-09-30: a prop too few books have posted shows its best price
    // and no fair number until more books post it. The count is the books
    // pricing BOTH sides at this line (yes quotes on a TD): the price box can
    // name another book posting one side only (Fable 9/30).
    cells.push(kpi(oneSided ? "Books' average" : "Fair number", "Too few books",
      oneSided ? `${mkData.books} quoting` : `${mkData.books} on both sides`, { wide: true, tone: "muted" }));
  } else if (hasLine && oneSided) {
    // The charter's one exception: a yes only price can't be de-vigged, so it
    // is the books' average WITH their cut, and both cells say so.
    cells.push(kpi("Books' average", mkData.market_odds, "Cut included", { tone: "over" }));
    cells.push(kpi("Implied yes", fmtPercent(mkData.market_over, 1), "Cut included"));
  } else if (hasLine) {
    cells.push(kpi("Fair over", mkData.fair_over_odds, fmtPercent(mkData.fair_over, 1), { tone: "over" }));
    cells.push(kpi("Fair under", mkData.fair_under_odds, fmtPercent(mkData.fair_under, 1), { tone: "under" }));
  }
  const avg = average(rows, market);
  cells.push(kpi("Average", avg == null ? "No games" : fmtDec1(avg), tile.long, { tone: avg == null ? "muted" : null }));
  // History only, never set beside this game's price: a window's hit rate and
  // Sunday's fair chance are different questions (Fable audit 2026-09-26).
  if (!hasLine) cells.push(kpi("Hit rate", "No line", "", { tone: "muted" }));
  else if (!hr || !hr.d) cells.push(kpi("Hit rate", "No games", "", { tone: "muted" }));
  else cells.push(kpi("Hit rate", `${Math.round(hr.pct)}%`, `${hr.n}/${hr.d}`));
  return h("div", { class: "pl-kpis" }, cells);
}

function buildHeader(player, game, kpis) {
  const isHome = player.team === game.home;
  const sub = `${player.pos} · ${teamAbbr(game, player.team)} ${isHome ? "vs" : "at"} ${teamName(game, player.opp)}`;
  const kick = h("div", { class: "pl-kick" },
    h("div", { class: "pl-kick-teams" },
      teamLogoImg(game.away_logo, teamAbbr(game, game.away), 26),
      h("span", { class: "pl-game-at" }, "@"),
      teamLogoImg(game.home_logo, teamAbbr(game, game.home), 26)),
    h("div", { class: "pl-kick-time num" }, game.kick ? `${fmtKick(game.kick)} ET` : "TBD"),
    game.venue ? h("div", { class: "pl-kick-venue" }, game.venue) : null);
  return h("div", { class: "panel pl-hcard" },
    h("div", { class: "pl-hcard-top" },
      h("div", { class: "pl-id" },
        headshotImg(player.headshot, player.name, 56, "pl-avatar-lg pl-shot"),
        h("div", { class: "pl-id-text" },
          h("h2", { class: "pl-name" }, player.name),
          h("div", { class: "pl-sub" }, sub))),
      kick),
    kpis);
}

// ---------------------------------------------------------------- market tabs
function buildTabs(player, markets, log10) {
  const tabs = markets.map((m) => {
    const mk = (player.markets || {})[m.key];
    const line = lineOf(mk);
    const hr = line != null && log10.length ? hitRate(log10, m, line) : null;
    const btn = h("button", {
      type: "button", class: "pl-tab", "aria-pressed": m.key === state.market ? "true" : "false",
      "data-fid": `m:${m.key}`,
      title: hr ? `${m.label}: ${mk && mk.one_sided ? "scored in" : "over in"} ${hr.n} of the last ${hr.d}` : m.label,
    }, m.short, hr ? h("span", { class: `pl-rate is-sm num ${rateClass(hr.pct)}` }, `${Math.round(hr.pct)}%`) : null);
    btn.addEventListener("click", () => setState({ market: m.key }));
    return btn;
  });
  return h("div", { class: "pl-tabs", role: "group", "aria-label": "Market" }, tabs);
}

// ---------------------------------------------------------------- best price
// A sportsbook style odds box: the side and line, the price, the book. Not a
// link and not clickable (the site sends no one to a book).
function oddsBox(side, line, best) {
  const label = side
    ? h("div", { class: "pl-odds-side" }, h("span", { class: `pl-side is-${side}` }, side === "over" ? "Over" : "Under"), line != null ? h("span", { class: "num" }, ` ${line}`) : null)
    : h("div", { class: "pl-odds-side" }, h("span", { class: "pl-side" }, "Yes"));
  return h("div", { class: "pl-odds" }, label, h("div", { class: "pl-odds-v num" }, best.odds), bookLine(best.books));
}

function buildPrices(mkData, player) {
  if (S.kickedOff(player)) return null;
  // a game's own pull time when the sport keeps one per game (CFB: a game the
  // latest pull missed keeps its older prices), else the board's
  const g = gameByKey(player.game);
  const asOf = (g && g.lines_as_of) || DATA.lines_as_of;
  const oneSided = !!mkData.one_sided;
  const over = validBest(mkData.best_over);
  const under = oneSided ? null : validBest(mkData.best_under);
  const line = oneSided ? null : fmtLineValue(mkData.line);
  const boxes = [];
  if (over) boxes.push(oddsBox(oneSided ? null : "over", line, over));
  if (under) boxes.push(oddsBox("under", line, under));
  if (!boxes.length) return null;
  return h("div", { class: "panel pl-prices" },
    h("div", { class: "pl-prices-head" },
      h("div", { class: "pl-ttl" }, "Best price"),
      asOf ? h("div", { class: "pl-asof" }, `Lines as of ${fmtKick(asOf)} ET`) : null),
    h("div", { class: "pl-odds-row" }, boxes));
}

// ---------------------------------------------------------------- hit rate tiles
function buildHitTiles(player, game, market, mkData, split) {
  const line = lineOf(mkData);
  return h("div", { class: "pl-tiles", role: "group", "aria-label": "Window" }, TILES.map((t) => {
    const rows = S.filteredLog(player, split, t);
    const hr = line != null ? hitRate(rows, market, line) : null;
    const label = S.tileLabel(t, player, game);
    const verb = mkData && mkData.one_sided ? "scored in" : "over in";
    let cls = "is-mid";
    let body;
    let aria;
    if (!rows.length) {
      cls = "is-empty";
      body = [h("div", { class: "pl-tile-v num" }, "No games")];
      aria = `${label}: no games`;
    } else if (!hr) {
      cls = "is-empty";
      body = [h("div", { class: "pl-tile-v num" }, `${rows.length} game${rows.length === 1 ? "" : "s"}`), h("div", { class: "pl-tile-p" }, "No line")];
      aria = `${label}: ${rows.length} games, no line`;
    } else {
      cls = rateClass(hr.pct);
      body = [h("div", { class: "pl-tile-v num" }, `${hr.n}/${hr.d}`), h("div", { class: "pl-tile-p num" }, `${Math.round(hr.pct)}%`)];
      aria = `${label}: ${verb} ${hr.n} of ${hr.d} games, ${Math.round(hr.pct)} percent`;
    }
    const btn = h("button", {
      type: "button", class: `pl-tile ${cls}`, "aria-pressed": t.key === state.window ? "true" : "false",
      "aria-label": aria, "data-fid": `w:${t.key}`,
    }, h("div", { class: "pl-tile-l" }, label), body);
    btn.addEventListener("click", () => setState({ window: t.key }));
    return btn;
  }));
}

// ---------------------------------------------------------------- chart tooltip text
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rushClause(r) {
  let s = `${r.car ?? 0} car, ${r.rush_yds ?? 0} rush yds`;
  if ((r.rush_td ?? 0) > 0) s += `, ${r.rush_td} rush TD`;
  return s;
}
// extended: WR/TE only (owner request) -- RB keeps the plain clause since
// its receiving work is a secondary line, not the market itself.
function recClause(r, extended) {
  // a log with no targets column (CFB: ESPN's college box has none) says so
  // by leaving them out, never "on 0 tgt"
  let s = COL_IDX.tgt === undefined
    ? `${r.rec ?? 0} rec, ${r.rec_yds ?? 0} yds`
    : `${r.rec ?? 0} rec on ${r.tgt ?? 0} tgt, ${r.rec_yds ?? 0} yds`;
  if (extended) {
    if (r.air_yds != null) s += `, ${r.air_yds} air yds`;
    if (r.yac != null) s += `, ${r.yac} YAC`;
  }
  if ((r.rec_td ?? 0) > 0) s += `, ${r.rec_td} rec TD`;
  return s;
}

// A log row's date can be missing (the schedule file unreachable, or a week it
// lacks): every reader goes through this, so a gap reads as a gap, not a crash.
function monthDay(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date || "");
  return m ? { m: Number(m[1]), d: Number(m[2]) } : null;
}

function tooltipText(pos, marketKey, r) {
  const md = monthDay(r.date);
  // home is 1 or 0; null is a neutral site (or unknown): no "at"
  const vsAt = r.home === 0 ? "at" : "vs";
  const when = [r.week != null ? `Wk ${r.week}` : null, md ? `${MONTHS[md.m - 1]} ${md.d}` : null].filter(Boolean).join(" · ");
  const header = `${when} ${vsAt} ${r.opp}:`;
  // a sport that lists its own clauses (NBA: [column, noun] pairs) reads them
  if (DATA.lab.tip) {
    return `${header} ${DATA.lab.tip.map(([c, noun]) => `${r[c] ?? 0} ${noun}`).join(", ")}`;
  }
  const clauses = [];
  if (marketKey === "player_anytime_td") clauses.push(`${r.td ?? 0} TD`);
  if (pos === "QB") {
    let passClause = `${r.pass_yds ?? 0} pass yds · ${r.cmp ?? 0}/${r.att ?? 0}, ${r.pass_td ?? 0} TD, ${r.int ?? 0} INT`;
    if (r.pass_air != null) passClause += `, ${r.pass_air} air yds`;
    clauses.push(passClause);
    clauses.push(rushClause(r));
  } else if (pos === "RB") {
    clauses.push(rushClause(r));
    clauses.push(recClause(r));
  } else {
    clauses.push(recClause(r, true));
    if ((r.car ?? 0) > 0) clauses.push(rushClause(r));
  }
  return `${header} ${clauses.filter(Boolean).join(" · ")}`;
}

// ---------------------------------------------------------------- chart
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function attachTooltip(target, wrap, tipEl, text) {
  function position() {
    const rr = target.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = rr.left - wr.left + rr.width / 2;
    const above = (rr.top - wr.top) > 46;
    tipEl.style.left = `${cx}px`;
    if (above) {
      tipEl.style.top = `${rr.top - wr.top - 6}px`;
      tipEl.style.transform = "translate(-50%, -100%)";
    } else {
      tipEl.style.top = `${rr.bottom - wr.top + 6}px`;
      tipEl.style.transform = "translate(-50%, 0)";
    }
    requestAnimationFrame(() => {
      const tr = tipEl.getBoundingClientRect();
      const wr2 = wrap.getBoundingClientRect();
      let dx = 0;
      if (tr.left < wr2.left) dx = wr2.left - tr.left;
      else if (tr.right > wr2.right) dx = wr2.right - tr.right;
      if (dx) tipEl.style.left = `${cx + dx}px`;
    });
  }
  function show() { tipEl.textContent = text; tipEl.classList.add("is-visible"); position(); }
  function hide() { tipEl.classList.remove("is-visible"); }
  target.addEventListener("mouseenter", show);
  target.addEventListener("mouseleave", hide);
  target.addEventListener("focus", show);
  target.addEventListener("blur", hide);
}

// A gridline step of 1, 2 or 5 times a power of ten giving about five lines.
// Every charted stat is a whole number, so the step never drops below 1.
function niceStep(peak) {
  const raw = peak / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
}

function refLine(kind, value, top, plotH, text, title) {
  const el = h("div", { class: `pl-cg-ref is-${kind}`, style: `bottom:${((value / top) * 100).toFixed(2)}%` },
    h("span", { class: "pl-cg-ref-l num", title: title || null }, text));
  return el;
}

function buildChartPlot(player, market, line, avg, rows, compact) {
  const bars = rows.slice(compact ? -10 : -20);
  const values = bars.map((r) => Number(r[market.stat]) || 0);
  // Round gridlines (yards read 0/100/200/300, TDs 0/1/2/3), with a little
  // headroom so the tallest bar and its labels clear the top.
  const peak = Math.max(...values, line != null ? line : 0, avg != null ? avg : 0, 1);
  const step = niceStep(peak);
  const top = step * Math.ceil((peak * 1.06) / step);
  const plotH = compact ? 170 : 200;

  const wrap = h("div", { class: "pl-cg", style: `--plot-h:${plotH}px` });
  const tipEl = h("div", { class: "pl-tooltip" });
  const plot = h("div", { class: "pl-cg-plot" });

  for (let v = 0; v <= top + 1e-9; v += step) {
    plot.appendChild(h("div", { class: "pl-cg-gl", style: `bottom:${((v / top) * 100).toFixed(2)}%` },
      h("span", { class: "pl-cg-gl-n num" }, String(v))));
  }

  const cols = h("div", { class: "pl-cg-cols" });
  // the numbers ride their own layer above the prop and average lines, so a
  // line crossing a bar's label passes behind it (owner 2026-09-30: the
  // dashed line "runs in with the numbers")
  const labs = h("div", { class: "pl-cg-labs", "aria-hidden": "true" });
  bars.forEach((r, i) => {
    const val = values[i];
    const cls = line == null ? "is-noline" : (val > line ? "is-over" : (val < line ? "is-under" : "is-push"));
    const rank = S.barRank(player, market, r);
    const rankTip = rank ? ` · Opp defense ${rank.phrase.toLowerCase()} (${r.season})` : "";
    const tip = tooltipText(player.pos, market.key, r) + rankTip;
    const col = h("div", {
      class: `pl-cg-col ${cls}`, style: `--v:${((val / top) * 100).toFixed(2)}%`,
      tabindex: "0", role: "img", "aria-label": tip,
    }, h("div", { class: "pl-cg-bar" }));
    labs.appendChild(h("div", { class: "pl-cg-lcol", style: `--v:${((val / top) * 100).toFixed(2)}%` },
      h("div", { class: "pl-cg-lab" },
        rank ? h("span", { class: "pl-cg-rank num" }, `R:${rank.n}`) : null,
        h("span", { class: "pl-cg-val num" }, String(val)))));
    attachTooltip(col, wrap, tipEl, tip);
    cols.appendChild(col);
  });
  plot.appendChild(cols);

  if (line != null) plot.appendChild(refLine("line", line, top, plotH, String(Number(line)), `Line ${line}`));
  if (avg != null) {
    const a = refLine("avg", avg, top, plotH, `avg ${fmtDec1(avg)}`);
    // the two labels sit on the same gutter: keep them from printing on top of each other
    if (line != null && Math.abs(avg - line) / top * plotH < 15) a.classList.add(avg >= line ? "is-up" : "is-down");
    plot.appendChild(a);
  }
  plot.appendChild(labs);

  const axis = h("div", { class: "pl-cg-axis" }, bars.map((r) => {
    const md = monthDay(r.date);
    return h("div", { class: "pl-cg-x" },
      teamLogoImg(S.oppLogoUrl(r), r.opp, 18),
      h("span", { class: "pl-cg-date num" }, md ? `${md.m}/${md.d}` : `Wk ${r.week}`));
  }));

  wrap.append(plot, axis, tipEl);
  return { node: wrap, shown: bars.length };
}

function splitControl(split) {
  const group = h("div", { class: "segmented pl-split", role: "group", "aria-label": "Split" },
    DATA.lab.splits.map((s) => {
      const btn = h("button", {
        type: "button", class: "segmented-opt", "aria-pressed": s.key === split.key ? "true" : "false",
        "data-fid": `s:${s.key}`,
      }, s.label);
      btn.addEventListener("click", () => setState({ split: s.key }));
      return btn;
    }));
  return group;
}

function buildChart(player, market, mkData, rows, tile, split) {
  const compact = compactMQ.matches;
  const line = lineOf(mkData);
  const avg = average(rows, market);
  const shown = compact ? Math.min(rows.length, 10) : Math.min(rows.length, 20);
  const bits = [tile.h2h ? `vs ${teamAbbr(gameByKey(player.game), player.opp)}` : tile.long];
  if (split.key !== "all") bits.push(split.label);
  if (shown < rows.length) bits.push(`showing ${shown} of ${rows.length}`);
  const head = h("div", { class: "pl-chart-head" },
    h("div", { class: "pl-ttl" }, market.label, h("span", { class: "pl-ttl-sub" }, bits.join(" · "))),
    splitControl(split));
  const kids = [head];
  if (!player.log || !player.log.length) {
    // not "no games": a player our id crosswalk can't place has none on file
    kids.push(h("p", { class: "props-quiet" }, "No game log available for this player."));
  } else if (!rows.length) {
    kids.push(h("p", { class: "props-quiet" }, "No games in this window."));
  } else {
    const plot = buildChartPlot(player, market, line, avg, rows, compact);
    plot.node.setAttribute("role", "group");
    plot.node.setAttribute("aria-label", `${market.label} by game`);
    kids.push(plot.node);
  }
  return h("div", { class: "panel pl-chart" }, kids);
}

// ---------------------------------------------------------------- advanced
function fmtProfileValue(v, format) {
  if (format === "pct") return fmtPercent(v, 1);
  if (format === "signed1") return fmtSigned(v, 1);
  if (format === "signed2") return fmtSigned(v, 2);
  return fmtDec1(v);
}

// Sum of the num columns over the given rows, divided by either the row
// count (den === "games") or the summed den columns -- exactly the rows the
// chart is already showing, so the tile and the bars never disagree.
function computeProfileValue(item, rows) {
  if (!rows.length) return null;
  const numSum = rows.reduce((s, r) => s + item.num.reduce((a, c) => a + (Number(r[c]) || 0), 0), 0);
  const den = item.den === "games"
    ? rows.length
    : rows.reduce((s, r) => s + item.den.reduce((a, c) => a + (Number(r[c]) || 0), 0), 0);
  return den ? numSum / den : null;
}

function buildAdvancedCard(player, rows, tile, split) {
  const items = (DATA.lab.profile || {})[player.pos] || [];
  // no games in this window and split: the chart already says so
  if (!items.length || !rows.length) return null;
  const n = rows.length;
  const bits = [tile.h2h ? `vs ${teamAbbr(gameByKey(player.game), player.opp)}` : tile.long];
  if (split.key !== "all") bits.push(split.label);
  bits.push(`${n} game${n === 1 ? "" : "s"}`);
  const cells = items.map((it) => {
    const v = computeProfileValue(it, rows);
    return kpi(it.label, v == null ? "N/A" : fmtProfileValue(v, it.format), "",
      { tone: v == null ? "muted" : null, help: it.help });
  });
  return h("div", { class: "panel pl-adv" },
    h("div", { class: "pl-ttl" }, "Advanced", h("span", { class: "pl-ttl-sub" }, bits.join(" · "))),
    h("div", { class: "pl-kpis is-adv" }, cells));
}

// ---------------------------------------------------------------- defense
function windowSubtitle(win, games) {
  const n = games || 0;
  if (win.last != null) return `Last ${n} game${n === 1 ? "" : "s"}`;
  if (win.season != null) return `${win.label || win.season} season · ${n} game${n === 1 ? "" : "s"}`;
  return `${n} game${n === 1 ? "" : "s"}`;
}

function dvRow(item, dataObj, of, primary) {
  const cell = dataObj[item.key];
  if (!cell) return null;
  // [per game, rank, phrase, tone]: the exporter writes the phrase (it knows
  // the ties: a group tied at the bottom reads "Fewest") and the tone
  const [perGame, rank, phrase, tone] = cell;
  const places = item.places ?? 1;       // two for per-game counts near one (TDs, INTs)
  const { sign, mag } = helpScore(cell, of, item.more_hurts);
  const side = sign > 0 ? "is-soft" : "is-tough";
  const tcls = (TONES[tone] || {}).cls || "";
  const perText = Number.isFinite(Number(perGame)) ? Number(perGame).toFixed(places) : "N/A";
  const toneLabel = (TONES[tone] || {}).label;
  const aria = `${item.label}: ${phrase || rankPhrase(rank, of)}, ${perText} per game${toneLabel ? `, ${toneLabel.toLowerCase()}` : ""}`;
  return h("li", { class: `pl-dv-row${primary ? " is-primary" : ""}`, "aria-label": aria },
    h("span", { class: "pl-dv-label" }, item.label),
    h("span", { class: "pl-dv-track", "aria-hidden": "true" },
      h("span", { class: `pl-dv-fill ${side} ${tcls}`, style: `--w:${(mag * 50).toFixed(1)}%` })),
    h("span", { class: "pl-dv-rank num", title: `Rank ${rank}` }, phrase || rankPhrase(rank, of)),
    h("span", { class: "pl-dv-val num" }, perText));
}

// The softest and toughest rows for his position: the farthest out of the
// rows the exporter tones as helping (1) or hurting (-1) him. A middle third
// row is neutral (yellow) and never a spot, however it leans (Fable 9/30: a
// green "Softest spot" sat above an all yellow table). DK points is left out
// (it sums the prop stats already listed).
function pickSpots(rowsDef, posData, of) {
  const scored = rowsDef.filter((it) => it.key !== "dk").map((item) => {
    const cell = posData[item.key];
    if (!cell) return null;
    const s = helpScore(cell, of, item.more_hurts);
    return { item, cell, tone: s.tone, mag: s.mag };
  }).filter(Boolean);
  const pick = (tone) => scored.filter((x) => x.tone === tone).sort((a, b) => b.mag - a.mag)[0] || null;
  return { soft: pick(1), tough: pick(-1) };
}

function spotCard(kind, label, spot, pos) {
  if (!spot) {
    return h("div", { class: `pl-spot is-${kind} is-none` },
      h("div", { class: "pl-spot-l" }, label),
      h("div", { class: "pl-spot-v" }, "Nothing stands out"));
  }
  const [perGame, rank, phrase] = spot.cell;
  const places = spot.item.places ?? 1;
  return h("div", { class: `pl-spot is-${kind}` },
    h("div", { class: "pl-spot-l" }, label),
    h("div", { class: "pl-spot-v" }, spot.item.label),
    h("div", { class: "pl-spot-s num" },
      `${phrase || rankPhrase(rank, 0)} · ${Number(perGame).toFixed(places)} per game`));
}

// "QBs", or the sport's own word for a group (NBA "guards")
function posPlural(pos) {
  return ((DATA.lab.matchup || {}).pos_names || {})[pos] || `${pos}s`;
}

function buildDefenseCard(player, game, market, tile, split) {
  // a sport whose data has no matchup section yet shows no card
  if (!DATA.lab.matchup || !DATA.lab.matchup.rows) return null;
  const pos = player.pos;
  const oppAbbr = player.opp;
  const oppFull = teamName(game, oppAbbr);
  const defWin = S.defenseWindow(tile);
  const byTeam = (DATA.defense || {})[oppAbbr];
  const de = byTeam ? byTeam[defWin.key] : null;
  const kids = [h("div", { class: "pl-ttl" }, `${oppFull} defense`)];

  if (!de && (DATA.defense_fcs || []).includes(oppAbbr)) {
    kids.push(h("p", { class: "props-quiet" }, "An FCS defense, so it isn't ranked against the FBS defenses."));
  } else if (!de) {
    kids.push(h("p", { class: "props-quiet" }, "No games for this defense in this window yet."));
  } else {
    // the Split control narrows the player's games, never the defense's
    const sub = windowSubtitle(defWin, de.games) + (split && split.key !== "all" ? " · home and away" : "");
    kids[0].appendChild(h("span", { class: "pl-ttl-sub" }, sub));

    const rowsDef = DATA.lab.matchup.rows[pos] || [];
    const posData = (de.pos || {})[pos] || {};
    const marketRowKey = ((DATA.lab.matchup.market_row || {})[pos] || {})[market.key];
    const primary = marketRowKey ? rowsDef.find((r) => r.key === marketRowKey) : null;
    const ordered = primary ? [primary, ...rowsDef.filter((r) => r.key !== primary.key)] : rowsDef;
    const { soft, tough } = pickSpots(rowsDef, posData, de.of);

    kids.push(h("div", { class: "pl-spots" },
      spotCard("soft", "Softest spot", soft, pos),
      spotCard("tough", "Toughest spot", tough, pos)));

    const axisHead = h("div", { class: "pl-dv-axis", "aria-hidden": "true" },
      h("span", {}, "Tougher"), h("span", {}, "Softer"));
    const list = (defs, data, key) => h("ul", { class: "pl-dv", "aria-label": key },
      defs.map((it) => dvRow(it, data, de.of, primary && it.key === primary.key && data === posData)).filter(Boolean));
    kids.push(h("div", { class: "pl-dv-col" },
      h("div", { class: "pl-dv-title" }, `vs ${posPlural(pos)}`), axisHead,
      list(ordered, posData, `Allowed to ${posPlural(pos)}`)));
    kids.push(h("div", { class: "pl-dv-col" },
      h("div", { class: "pl-dv-title" }, "Whole defense"), axisHead.cloneNode(true),
      list(DATA.lab.matchup.overall || [], de.overall || {}, "Whole defense")));
  }
  return h("div", { class: "panel pl-defense" }, kids);
}

// ---------------------------------------------------------------- footer
function buildFooter() {
  return h("div", { class: "pl-foot" },
    h("a", { class: "pl-foot-link", href: `${root()}methodology/` }, "How these numbers work"),
    DATA.lines_as_of ? h("span", { class: "pl-foot-stamp" }, `Lines as of ${fmtKick(DATA.lines_as_of)} ET`) : null);
}

// ---------------------------------------------------------------- assemble
function buildDetail() {
  const game = gameByKey(state.game);
  const player = DATA.players.find((p) => p.id === state.player) || null;
  if (!player) return [emptyState("No players published for this game yet.")];
  const markets = marketsForPlayer(player);
  const market = DATA.lab.markets.find((m) => m.key === state.market);
  const split = DATA.lab.splits.find((s) => s.key === state.split);
  const tile = S.tileByKey(state.window);
  if (!market) {
    return [buildHeader(player, game, h("div", { class: "pl-kpis" })),
      emptyState("No markets configured for this player yet.")];
  }
  const mkData = (player.markets || {})[market.key] || null;
  const line = lineOf(mkData);
  const rows = S.filteredLog(player, split, tile);
  const hr = line != null ? hitRate(rows, market, line) : null;
  const last10 = S.rowsOf(player).slice(-10);
  return [
    buildHeader(player, game, buildKpis(market, mkData, rows, tile, hr)),
    buildTabs(player, markets, last10),
    mkData ? buildPrices(mkData, player) : null,
    buildHitTiles(player, game, market, mkData, split),
    buildChart(player, market, mkData, rows, tile, split),
    buildAdvancedCard(player, rows, tile, split),
    buildDefenseCard(player, game, market, tile, split),
  ];
}

// Scroll a list's own box just far enough to show the selected row. Never the page.
function keepVisible(box, el) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  if (!b.width || !b.height) return;
  if (e.left < b.left) box.scrollLeft -= b.left - e.left + 8;
  else if (e.right > b.right) box.scrollLeft += e.right - b.right + 8;
  if (e.top < b.top) box.scrollTop -= b.top - e.top + 8;
  else if (e.bottom > b.bottom) box.scrollTop += e.bottom - b.bottom + 8;
}

function activeFid() {
  const a = document.activeElement;
  return a && a.dataset && a.dataset.fid && a.closest && a.closest(".prop-lab") ? a.dataset.fid : null;
}

function restoreFocus(fid) {
  if (!fid) return;
  const el = document.querySelector(`.prop-lab [data-fid="${fid.replace(/"/g, '\\"')}"]`);
  if (el && el.getClientRects().length) el.focus({ preventScroll: true });
}

function showSelected() {
  keepVisible(railHost, railHost.querySelector('.pl-game[aria-pressed="true"]'));
  keepVisible(listHost, listHost.querySelector('.pl-prow[aria-pressed="true"]'));
}

function renderAll() {
  // a click rebuilds the page's cards, so the keyboard user keeps his place
  const fid = ui.focus || activeFid();
  ui.focus = null;
  const game = gameByKey(state.game);
  const player = DATA.players.find((p) => p.id === state.player) || null;
  const rosterKey = `${state.game}|${state.team}`;
  const railPos = { l: railHost.scrollLeft, t: railHost.scrollTop };
  const listTop = rosterKey === ui.roster ? listHost.scrollTop : 0;
  ui.roster = rosterKey;

  railHost.replaceChildren(...buildRail());
  railHost.scrollLeft = railPos.l;
  railHost.scrollTop = railPos.t;
  teamHost.replaceChildren(buildTeamToggle(game));
  pickHost.replaceChildren(...[buildPickButton(player)].filter(Boolean));
  listHost.replaceChildren(...teamRoster(game.key, state.team).map(buildPlayerRow));
  listHost.scrollTop = listTop;
  listCol.classList.toggle("is-open", ui.listOpen);
  // a row with no players says so
  if (!listHost.children.length) listHost.appendChild(h("p", { class: "props-quiet pl-list-empty" }, "No players published yet."));
  showSelected();

  detailHost.replaceChildren(...buildDetail().filter(Boolean));
  restoreFocus(fid);
}

function mount() {
  const app = document.getElementById("app");
  const head = h("div", { class: "page-head pl-head" }, h("h1", {}, "Prop Lab"), h("p", { class: "sub" }, DATA.slate.label));
  if (DATA.message) head.appendChild(notice({ kind: "info", text: DATA.message }));

  railHost = h("div", { class: "pl-rail", role: "group", "aria-label": "Games" });
  teamHost = h("div", { class: "pl-team-host" });
  pickHost = h("div", { class: "pl-pick-host" });
  listHost = h("div", { class: "pl-list", id: "pl-list", role: "group", "aria-label": "Players" });
  listCol = h("div", { class: "pl-list-col" }, teamHost, pickHost, listHost);
  detailHost = h("div", { class: "pl-detail" });
  const layout = h("div", { class: "pl-layout" },
    h("div", { class: "pl-rail-col" }, railHost), listCol, detailHost);

  app.replaceChildren(h("div", { class: "prop-lab" }, head, layout, buildFooter()));
}

// ---------------------------------------------------------------- entry
async function render() {
  const app = document.getElementById("app");
  const sport = currentSport();
  app.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, "Prop Lab")));

  // a sport still marked "coming" has no data folder, so there is nothing to ask for
  // (as the Prop Finder, DFS and Research do; the request would only log a 404)
  if (manifestStatus(sport, "prop-lab") === "coming") {
    app.appendChild(comingState(getComingText(sport, "prop-lab")));
    return;
  }
  let data;
  try {
    data = await fetchJSON(`data/${sport}/prop-lab.json`);
  } catch (e) {
    app.appendChild(e.status === 404 ? missingState(sport, "prop-lab") : errorState(e.message));
    return;
  }
  if (data.status === "pending" || data.status === "coming") {
    app.appendChild(comingState(data.message || getComingText(sport, "prop-lab")));
    return;
  }
  if (!data.slate || !data.slate.games || !data.slate.games.length) {
    app.appendChild(emptyState("No games on this slate yet."));
    return;
  }

  DATA = data;
  S = createStats(data);
  COL_IDX = S.COL_IDX;
  TILES = S.TILES;
  setFooterSources(data.sources);

  mount();
  const hash = parseHash();
  setState({ game: hash.g, team: hash.t, player: hash.p, market: hash.m, window: hash.w, split: hash.s });
  // the web fonts land after the first layout and widen the rail's rows, so the
  // selected game is shown again once they have
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(showSelected);
}

window.addEventListener("hashchange", () => {
  if (!DATA) return;
  const hash = parseHash();
  setState({ game: hash.g, team: hash.t, player: hash.p, market: hash.m, window: hash.w, split: hash.s });
});

// the phone chart draws fewer bars than the desktop one
compactMQ.addEventListener("change", () => { if (DATA) renderAll(); });

render();
