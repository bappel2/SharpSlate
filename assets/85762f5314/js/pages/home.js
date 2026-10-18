// Home: the day's slate, drawn from data/home.json. Redesign (owner,
// 2026-09-30: "model it on the popular prop sites"): those open on DATA, so
// the slogan hero, its buttons and the browser and phone mockups are gone.
// Per sport that has data (the file lists them; nothing here names a sport):
//
//   header        the sport, its slate, a link to its Prop Lab
//   games strip   compact game cards, each linking to that game in the Prop Lab
//   props table   featured props, one per player, fair and best odds,
//                 last ten hit rate; each row links to that player's card
//   DFS pool      a short player pool at one position and a link to the builder
//
// then a tools row. A sport with no full props yet shows its games and an
// honest line instead of a table. No lineup is drawn anywhere (operator
// 2026-09-26: "we dont want people all entering the same roster"); the publish
// audit enforces it on home.json.
//
// Research, not picks: nothing here marks a side, and a best price is shown
// beside the fair odds, never colored or ranked against them.
import { h, root, fetchJSON, fmtKick, fmtMoney, fmtDec1, emptyState, errorState } from "../app.js";

const DOT = "·";
const ESPN = "https://a.espncdn.com/";

// ---------------------------------------------------------------- images
// Logos and headshots load from ESPN only; anything else (or a failed load)
// draws initials in place, so a row never shows a broken image.
function espnOnly(url) {
  return typeof url === "string" && url.startsWith(ESPN) ? url : null;
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function fallback(cls, text, size) {
  return h("span", { class: `${cls} is-fallback`, style: `width:${size}px;height:${size}px`, "aria-hidden": "true" }, text);
}

function image(url, cls, text, size) {
  const src = espnOnly(url);
  if (!src) return fallback(cls, text, size);
  const img = h("img", {
    src, alt: "", width: size, height: size, class: cls,
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => img.replaceWith(fallback(cls, text, size)), { once: true });
  return img;
}

// ---------------------------------------------------------------- small helpers
const enc = encodeURIComponent;

function started(iso) {
  return Boolean(iso && new Date(iso).getTime() <= Date.now());
}

// A line as the books print it: 64.5, 2.5, 240.
function fmtLine(v) {
  return v == null || !Number.isFinite(Number(v)) ? "N/A" : String(Number(v));
}

function kickText(iso) {
  return iso ? `${fmtKick(iso)} ET` : "Time TBD";
}

// ---------------------------------------------------------------- header
function sportHead(sec) {
  return h("header", { class: "home-sport-head" },
    h("h2", { class: "home-sport-name", id: `sport-${sec.key}` },
      h("span", { class: `sport-dot sport-dot--${sec.key}`, "aria-hidden": "true" }), sec.label),
    h("p", { class: "home-sport-slate" }, sec.slate || ""),
    sec.prop_lab
      ? h("a", { class: "home-link", href: `${root()}${sec.key}/prop-lab/` }, "Open the Prop Lab")
      : null);
}

// ---------------------------------------------------------------- games strip
// Each card deep links to its game: the Prop Lab reads #g=<game key>. A game
// that has kicked off stays (its fair lines stay in the lab), dimmed.
function gameCard(sec, g) {
  const when = kickText(g.kick);
  const body = [
    h("span", { class: "home-game-team" }, image(g.away_logo, "home-logo", g.away_abbr, 20),
      h("span", { class: "home-game-abbr" }, g.away_abbr)),
    h("span", { class: "home-game-team" }, image(g.home_logo, "home-logo", g.home_abbr, 20),
      h("span", { class: "home-game-abbr" }, g.home_abbr)),
    h("span", { class: "home-game-kick" }, when),
  ];
  const cls = `home-game${started(g.kick) ? " is-past" : ""}`;
  return sec.prop_lab
    ? h("a", {
      class: cls, href: `${root()}${sec.key}/prop-lab/#g=${enc(g.key)}`,
      "aria-label": `${g.away_abbr} at ${g.home_abbr}, ${when}`,
    }, body)
    : h("div", { class: cls }, body);
}

function gamesStrip(sec) {
  const games = sec.games || [];
  if (!games.length) return null;
  return h("ul", { class: "home-games", role: "list", "aria-label": `${sec.label} games` },
    games.map((g) => h("li", {}, gameCard(sec, g))));
}

// ---------------------------------------------------------------- props table
// One row per player. The whole row is the link: the player's name is the real
// anchor and stretches over the row (CSS), so a phone taps anywhere on it.
function bestCell(best) {
  const ok = best && typeof best.odds === "string" && Array.isArray(best.books) && best.books.length;
  if (!ok) return h("span", { class: "home-none" }, "N/A");
  const n = best.books.length;
  const name = n > 1 ? `${best.books[0]} and ${n - 1} more` : best.books[0];
  return h("span", { class: "home-best" },
    h("span", { class: "home-best-odds" }, best.odds),
    h("span", { class: "home-best-book" }, name),
    n > 1 ? h("span", { class: "visually-hidden" }, `: ${best.books.join(", ")}`) : null);
}

function label(text, side) {
  // the phone shows each cell's label (the desktop header row covers it)
  return h("span", { class: "home-lbl" }, text, side
    ? h("span", { class: side === "O" ? "home-o" : "home-u" }, ` ${side}`) : null);
}

function propRow(sec, r) {
  const href = `${root()}${sec.key}/prop-lab/#g=${enc(r.game)}&t=${enc(r.team)}`
    + `&p=${enc(r.id)}&m=${enc(r.market)}`;
  const meta = [r.pos, r.team_abbr].filter(Boolean).join(` ${DOT} `);
  const hit = r.hit && r.hit.d ? `${r.hit.n}/${r.hit.d}` : "N/A";
  return h("div", { class: "home-row", role: "row" },
    h("div", { class: "home-c home-c-player", role: "cell" },
      image(r.headshot, "home-shot", initials(r.name), 28),
      h("span", { class: "home-id" },
        h("a", { class: "home-row-link", href }, r.name,
          h("span", { class: "visually-hidden" }, `, ${r.label} ${fmtLine(r.line)}`)),
        h("span", { class: "home-meta" }, meta))),
    h("div", { class: "home-c home-c-market", role: "cell" }, r.label),
    h("div", { class: "home-c home-c-line num", role: "cell" }, fmtLine(r.line)),
    h("div", { class: "home-c home-c-fo num", role: "cell" }, label("Fair", "O"), r.fair_over_odds),
    h("div", { class: "home-c home-c-fu num", role: "cell" }, label("Fair", "U"), r.fair_under_odds),
    h("div", { class: "home-c home-c-bo num", role: "cell" }, label("Best", "O"), bestCell(r.best_over)),
    h("div", { class: "home-c home-c-bu num", role: "cell" }, label("Best", "U"), bestCell(r.best_under)),
    h("div", { class: "home-c home-c-hit num", role: "cell" }, label("Last 10 over"), hit),
    h("div", { class: "home-c home-c-books num", role: "cell" }, label("Books"), String(r.books ?? "N/A")));
}

function headCell(cls, text, side, tip) {
  return h("div", { class: `home-c ${cls}`, role: "columnheader", title: tip },
    text, side ? h("span", { class: side === "O" ? "home-o" : "home-u" }, ` ${side}`) : null);
}

function propsTable(sec) {
  // the build runs every 30 minutes: a game that kicked off since drops out here
  const rows = (sec.props || []).filter((r) => !started(r.kick)).slice(0, sec.shown || 10);
  if (!rows.length) {
    const text = sec.note || sec.started_note;
    return text ? h("p", { class: "home-note" }, text) : null;
  }
  const asOf = sec.lines_as_of ? `Lines as of ${fmtKick(sec.lines_as_of)} ET` : null;
  const head = h("div", { class: "home-row home-row-head", role: "row" },
    headCell("home-c-player", "Player"),
    headCell("home-c-market", "Market"),
    headCell("home-c-line", "Line"),
    headCell("home-c-fo", "Fair", "O", "Fair odds for the over, with the books' cut removed"),
    headCell("home-c-fu", "Fair", "U", "Fair odds for the under, with the books' cut removed"),
    headCell("home-c-bo", "Best", "O", "Best over price any book we check posts at this line"),
    headCell("home-c-bu", "Best", "U", "Best under price any book we check posts at this line"),
    headCell("home-c-hit", "L10", null, "Games finished over this line, of the last 10"),
    headCell("home-c-books", "Books", null, "Books pricing this prop"));
  return h("div", { class: "home-block" },
    h("div", { class: "home-block-head" },
      h("h3", { class: "home-block-title" }, "Featured props"),
      asOf ? h("p", { class: "home-block-sub" }, asOf) : null),
    h("div", { class: "home-table-wrap" },
      h("div", { class: "home-table", role: "table", "aria-label": `${sec.label} featured props` },
        head, h("div", { class: "home-rows", role: "rowgroup" }, rows.map((r) => propRow(sec, r))))));
}

// ---------------------------------------------------------------- DFS pool
// A pool at one position, never a lineup.
function poolBlock(sec) {
  const d = sec.dfs;
  if (!d || !Array.isArray(d.pool) || !d.pool.length) return null;
  const sub = [d.site, d.cap ? `${fmtMoney(d.cap)} cap` : null, d.label].filter(Boolean).join(` ${DOT} `);
  return h("div", { class: "home-block" },
    h("div", { class: "home-block-head" },
      h("h3", { class: "home-block-title" }, `DFS player pool ${DOT} ${d.pos}`),
      h("p", { class: "home-block-sub" }, sub),
      h("a", { class: "home-link home-block-link", href: `${root()}${sec.key}/dfs/` }, "Build a lineup")),
    h("ul", { class: "home-pool", role: "list", "aria-label": `${sec.label} ${d.pos} pool` },
      d.pool.map((p) => h("li", { class: "home-pool-item" },
        h("span", { class: "home-pool-id" },
          h("span", { class: "home-pool-name" }, p.name),
          h("span", { class: "home-meta" }, [p.pos, p.team].filter(Boolean).join(` ${DOT} `))),
        h("span", { class: "home-pool-num num" },
          h("span", { class: "home-pool-salary" }, fmtMoney(p.salary)),
          h("span", { class: "home-pool-proj" }, `${fmtDec1(p.proj)} proj`))))));
}

// ---------------------------------------------------------------- sections
function sportSection(sec) {
  return h("section", { class: "home-sport", "aria-labelledby": `sport-${sec.key}` },
    sportHead(sec), gamesStrip(sec), propsTable(sec), poolBlock(sec));
}

function toolsRow(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return h("section", { class: "home-tools", "aria-labelledby": "home-tools-h" },
    h("h2", { class: "home-tools-title", id: "home-tools-h" }, "Tools"),
    h("p", { class: "home-tools-text" }, "Odds converter, devig, parlay and stake calculators. They work for every sport."),
    h("ul", { class: "home-tools-links", role: "list" },
      tools.map((t) => h("li", {}, h("a", { class: "home-chip", href: `${root()}${t.key}/tools/` }, `${t.label} Tools`)))));
}

function intro() {
  return h("div", { class: "home-intro" },
    h("p", { class: "home-intro-text" }, "Fair odds, best prices and game logs for every prop on the slate."),
    h("a", { class: "home-link", href: `${root()}methodology/` }, "How these numbers work"));
}

// A compact card for the league site, under the intro: one row on a
// desktop, title and buttons stacked on a phone. Both open in a new tab, like
// the menu's Leagues item, so the slate stays open behind them.
function leaguesCard(lg) {
  if (!lg || typeof lg.url !== "string" || !lg.url.startsWith("https://")) return null;
  const out = (href, cls, text) => h("a", { class: cls ? `btn ${cls}` : "btn", href, target: "_blank", rel: "noopener",
    "aria-label": `${text}, opens in a new tab` }, text);
  return h("aside", { class: "home-leagues", "aria-labelledby": "home-leagues-h" },
    h("div", { class: "home-leagues-copy" },
      h("h2", { class: "home-leagues-title", id: "home-leagues-h" }, "Run your own betting league"),
      h("p", { class: "home-leagues-text" },
        "Start a free league, invite your group, and everyone bets off one board. Play units only, no real money.")),
    h("div", { class: "home-leagues-actions" },
      out(lg.url, "btn-primary", "Start a league"),
      typeof lg.demo === "string" && lg.demo.startsWith("https://") ? out(lg.demo, "", "See an example league") : null));
}

// ---------------------------------------------------------------------- mount
async function render() {
  const app = document.getElementById("app");
  const page = h("div", { class: "home" }, intro());
  app.replaceChildren(page);
  let data;
  try {
    data = await fetchJSON("data/home.json");
  } catch {
    page.appendChild(errorState("The slate didn't load. Try again in a few minutes."));
    return;
  }
  const sports = Array.isArray(data.sports) ? data.sports : [];
  if (!sports.length) {
    page.appendChild(emptyState("Nothing is on the board right now. Check back when the next slate posts.",
      "No games on the board"));
  }
  const leagues = leaguesCard(data.leagues);
  if (leagues) page.appendChild(leagues);
  for (const sec of sports) page.appendChild(sportSection(sec));
  const tools = toolsRow(data.tools);
  if (tools) page.appendChild(tools);
  app.dataset.state = "ready";
}

render();
