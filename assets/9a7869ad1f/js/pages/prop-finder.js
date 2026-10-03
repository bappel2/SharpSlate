// Prop Finder: every prop on the slate in one table, narrowed by filters
// (owner 2026-09-30: "an Outlier style prop screener"). One row per player,
// prop and side. It has no data file of its own: it reads the same
// data/<sport>/prop-lab.json as the Prop Lab and runs the Prop Lab's own number
// logic (propstats.js) over every player at once, so a hit rate here is the
// tile the Prop Lab shows. A row opens that player's Prop Lab card at that
// market, window and split.
//
// Research, not picks (charter): a row sets past hit rates beside the market's
// fair odds and says nothing about the two together. No filter, sort, badge
// or color here compares a price with a fair number.
//
// The search box is also a player picker (owner 2026-10-01: many players share
// a name): from two letters a list under it offers the matching players, one
// entry per player id; choosing one filters the table to his props and shows
// him as a chip. Typing and pressing Enter still searches the table by text.
//
// Every filter and the sort live in the URL hash (propfilter.js), so a search
// can be shared; a bad hash falls back to the default view. The logic with no
// page in it is propfilter.js, which /selftest/ runs against the same data.
import {
  h, root, fetchJSON, currentSport, comingState, errorState, missingState, emptyState, notice,
  getComingText, setFooterSources, manifestStatus, fmtKick, fmtDec1, fmtPercent, debounce,
} from "../app.js";
import {
  createStats, rateClass, teamAbbr, fmtLineValue, headshotImg, bookLine, rankPhrase, parseAmerican,
} from "../propstats.js";
import {
  createFinder, defaultState, decodeHash, encodeHash, minGamesFor, matchSegments, TONE_KEYS, TONE_LABEL,
} from "../propfilter.js";

//: rows drawn at a time (CFB has about a thousand; the rest wait behind Show more)
const PAGE = 100;

let DATA = null;
let S = null;               // the shared number logic (propstats.js)
let F = null;               // the rows and filters (propfilter.js)
let state = null;
let limit = PAGE;
let ui = {};                // the page's own nodes
const syncers = [];         // each control's "show the state" function

// ---------------------------------------------------------------- hash
function writeHash() {
  const q = encodeHash(state, S);
  history.replaceState(null, "", q ? `#${q}` : `${location.pathname}${location.search}`);
}

// ---------------------------------------------------------------- state changes
/** Every control goes through here: change the state, rewrite the hash, redraw. */
function change(patch, { keepPaging = false } = {}) {
  state = { ...state, ...patch };
  if (!keepPaging) limit = PAGE;
  writeHash();
  draw({ resetScroll: !keepPaging });
}

const PRESETS = [
  { key: "l10", label: "80%+ last 10", patch: { hw: "last10", hmin: 80, hg: null } },
  { key: "l20", label: "70%+ last 20", patch: { hw: "l20", hmin: 70, hg: null } },
  { key: "ssn", label: "Every game this season", patch: { hmin: 100, hg: 3 }, season: true },
];

// what the view was set to before a preset took over, so turning it off puts it back
let beforePreset = null;

function presetPatch(p) {
  if (!p.season) return { ...p.patch, sort: `win:${p.patch.hw}`, dir: "desc" };
  const tile = S.TILES.find((t) => t.label === "This season");
  const key = tile ? tile.key : state.hw;
  return { ...p.patch, hw: key, sort: `win:${key}`, dir: "desc" };
}

function presetOn(p) {
  const patch = presetPatch(p);
  return state.hw === patch.hw && state.hmin === patch.hmin && state.hg === patch.hg;
}

function activeCount() {
  const d = defaultState(S);
  let n = 0;
  for (const k of ["pt", "ps", "df"]) if (state[k].length) n++;
  for (const k of ["tm", "gm", "dy", "sd", "sp", "q", "pl"]) if (state[k] !== d[k]) n++;
  if (state.lmin != null || state.lmax != null) n++;
  if (state.omin != null || state.omax != null) n++;
  if (state.hmin > 0) n++;
  if (state.hg != null) n++;
  if (state.bk > 0) n++;
  if (state.thin) n++;
  if (!state.hs) n++;
  return n;
}

// ---------------------------------------------------------------- small controls
let _uid = 0;
const uid = (p) => `${p}-${++_uid}`;

function labeled(text, control, help, { forId = null } = {}) {
  const id = forId || control.id || uid("pf");
  if (!forId) control.id = id;
  return h("div", { class: "pf-grp" },
    h("label", { class: "pf-lbl", for: id }, text),
    control,
    help ? h("div", { class: "pf-help" }, help) : null);
}

function groupLabel(text, id) {
  return h("div", { class: "pf-lbl", id }, text);
}

/** Pills that toggle in and out of a list (prop types, positions, defense). */
function multiPills(labelText, key, options, help) {
  const id = uid("pf-g");
  const btns = options.map((o) => {
    const b = h("button", { type: "button", class: "pf-pill", "aria-pressed": "false" }, o.label);
    b.addEventListener("click", () => {
      const has = state[key].includes(o.key);
      change({ [key]: has ? state[key].filter((k) => k !== o.key) : [...state[key], o.key] });
    });
    return { b, o };
  });
  syncers.push(() => btns.forEach(({ b, o }) => b.setAttribute("aria-pressed", state[key].includes(o.key) ? "true" : "false")));
  return h("div", { class: "pf-grp", role: "group", "aria-labelledby": id },
    groupLabel(labelText, id),
    h("div", { class: "pf-pills" }, btns.map((x) => x.b)),
    help ? h("div", { class: "pf-help" }, help) : null);
}

/** A segmented control: one pressed option. */
function segmented(labelText, key, options, { onPick, extra, title } = {}) {
  const id = uid("pf-g");
  const btns = options.map((o) => {
    const b = h("button", { type: "button", class: "segmented-opt", "aria-pressed": "false" }, o.label);
    b.addEventListener("click", () => (onPick ? onPick(o) : change({ [key]: o.key })));
    return { b, o };
  });
  syncers.push(() => btns.forEach(({ b, o }) => b.setAttribute("aria-pressed", state[key] === o.key ? "true" : "false")));
  return h("div", { class: "pf-grp", role: "group", "aria-labelledby": id, title: title || null },
    groupLabel(labelText, id),
    h("div", { class: "segmented" }, btns.map((x) => x.b)), extra || null);
}

function selectFilter(labelText, key, allLabel, options) {
  const sel = h("select", { class: "select-input" },
    h("option", { value: "" }, allLabel),
    options.map((o) => h("option", { value: o.key }, o.label)));
  sel.addEventListener("change", () => change({ [key]: sel.value }));
  syncers.push(() => { sel.value = state[key]; });
  return labeled(labelText, h("span", { class: "pf-select" }, sel), null, { forId: (sel.id = uid("pf")) });
}

/** A number box; `read` turns its text into the state value (null = empty/invalid). */
function numberBox(labelText, key, attrs, { min, max, round = false, ph = "", live = 220, ariaLabel } = {}) {
  const input = h("input", {
    type: "number", class: "text-input num", inputmode: "decimal", placeholder: ph,
    "aria-label": ariaLabel || null, ...attrs,
  });
  const push = debounce(() => {
    const raw = input.value.trim();
    let v = raw === "" ? null : Number(raw);
    if (v != null && (!Number.isFinite(v) || v < min || v > max)) v = null;
    if (v != null && round) v = Math.round(v);
    input.setAttribute("aria-invalid", raw !== "" && v == null ? "true" : "false");
    change({ [key]: v });
  }, live);
  input.addEventListener("input", push);
  syncers.push(() => {
    if (document.activeElement === input) return;
    input.value = state[key] == null || (state[key] === 0 && key !== "lmin" && key !== "lmax") ? "" : String(state[key]);
  });
  return input;
}

/** American odds box: "-200" / "+250"; anything else is ignored and flagged. */
function oddsBox(key, ph, ariaLabel) {
  const input = h("input", {
    type: "text", class: "text-input num", inputmode: "text", autocomplete: "off", spellcheck: "false",
    placeholder: ph, "aria-label": ariaLabel, maxlength: "6",
  });
  const push = debounce(() => {
    const raw = input.value.trim();
    // American odds always carry a sign, so a bare "110" is flagged, never read as +110
    const v = raw === "" || !/^[+\-−]/.test(raw) ? null : parseAmerican(raw);
    input.setAttribute("aria-invalid", raw !== "" && v == null ? "true" : "false");
    change({ [key]: v });
  }, 250);
  input.addEventListener("input", push);
  syncers.push(() => {
    if (document.activeElement === input) return;
    const v = state[key];
    input.value = v == null ? "" : (v > 0 ? `+${v}` : String(v));
    input.setAttribute("aria-invalid", "false");
  });
  return input;
}

function switchRow(text, key, { invert = false } = {}) {
  const id = uid("pf-sw");
  const box = h("input", { type: "checkbox", id });
  box.addEventListener("change", () => change({ [key]: invert ? !box.checked : box.checked }));
  syncers.push(() => { box.checked = invert ? !state[key] : !!state[key]; });
  return h("label", { class: "switch-row pf-switch", for: id },
    box, h("span", { class: "switch-track", "aria-hidden": "true" }), h("span", { class: "switch-label" }, text));
}

// ---------------------------------------------------------------- filter panel
function buildPanel() {
  const f = F.facets;
  const splitOpts = DATA.lab.splits.map((s) => ({ key: s.key, label: s.label }));
  const winOpts = F.tiles.map((t) => ({ key: t.key, label: t.label }));

  const minGames = numberBox("Min games", "hg", { min: "0", max: "99", step: "1" }, { min: 0, max: 99, round: true, ph: "5", ariaLabel: "Minimum games in the window" });
  // the empty box shows the window's own default, so the number is never a mystery
  syncers.push(() => { minGames.placeholder = String(minGamesFor(S, state, state.hw)); });

  // each group says how many of the panel's twelve columns it takes on a desktop
  const span = (node, n) => { node.classList.add(`s-${n}`); return node; };

  const hitGrp = span(h("div", { class: "pf-grp pf-hit", role: "group", "aria-labelledby": "pf-hit-l" },
    groupLabel("Hit rate", "pf-hit-l"),
    h("div", { class: "pf-hit-row" },
      h("div", { class: "segmented", role: "group", "aria-label": "Hit rate window" },
        winOpts.map((o) => {
          const b = h("button", { type: "button", class: "segmented-opt", "aria-pressed": "false" }, o.label);
          b.addEventListener("click", () => change({ hw: o.key }));
          syncers.push(() => b.setAttribute("aria-pressed", state.hw === o.key ? "true" : "false"));
          return b;
        })),
      h("label", { class: "pf-mini" }, h("span", { class: "pf-mini-l" }, "Min %"),
        numberBox("Min %", "hmin", { min: "0", max: "100", step: "5" }, { min: 0, max: 100, round: true, ph: "0", ariaLabel: "Minimum hit rate percent" })),
      h("label", { class: "pf-mini" }, h("span", { class: "pf-mini-l" }, "Min games"), minGames)),
    h("div", { class: "pf-help" }, "The window also sets Avg and Opp defense. A rate over fewer games than Min games is left out when Min % is set.")), 7);

  const defGrp = span(multiPills("Opponent defense", "df",
    TONE_KEYS.map((k) => ({ key: k, label: TONE_LABEL[k] })),
    "From the side's point of view: a defense that allows the most rec yds is soft for an over and tough for an under."), 5);

  return h("section", { class: "pf-panel", id: "pf-panel", "aria-label": "Filters" },
    span(multiPills("Prop", "pt", f.marketList.map((m) => ({ key: m.key, label: m.short }))), 8),
    span(multiPills("Position", "ps", f.positions.map((p) => ({ key: p, label: p }))), 4),
    span(selectFilter("Game", "gm", "All games", f.gameList.map((g) => ({
      key: g.key, label: `${teamAbbr(g, g.away)} @ ${teamAbbr(g, g.home)} · ${fmtKick(g.kick)}` }))), 4),
    span(selectFilter("Team", "tm", "All teams", f.teamList.map((t) => ({ key: t.key, label: t.abbr }))), 2),
    span(selectFilter("Day", "dy", "All days", f.dayList.map((d) => ({ key: d.key, label: d.label }))), 2),
    span(segmented("Split", "sp", splitOpts, { title: "Applies to hit rates and averages" }), 4),
    span(h("div", { class: "pf-grp" },
      groupLabel("Line", "pf-line-l"),
      h("div", { class: "pf-pair", role: "group", "aria-labelledby": "pf-line-l" },
        numberBox("Line min", "lmin", { step: "0.5" }, { min: -1e4, max: 1e4, ph: "Min", ariaLabel: "Line, minimum" }),
        h("span", { class: "pf-to", "aria-hidden": "true" }, "to"),
        numberBox("Line max", "lmax", { step: "0.5" }, { min: -1e4, max: 1e4, ph: "Max", ariaLabel: "Line, maximum" }))), 3),
    span(h("div", { class: "pf-grp" },
      groupLabel("Best price", "pf-odds-l"),
      h("div", { class: "pf-pair", role: "group", "aria-labelledby": "pf-odds-l" },
        oddsBox("omin", "-200", "Best price, shortest odds"),
        h("span", { class: "pf-to", "aria-hidden": "true" }, "to"),
        oddsBox("omax", "+250", "Best price, longest odds")),
      h("div", { class: "pf-help" }, "American odds, by payout. Start with + or a minus sign, as in +150 or -110.")), 3),
    span(h("div", { class: "pf-grp" },
      h("label", { class: "pf-lbl", for: "pf-books" }, "Min books"),
      numberBox("Min books", "bk", { id: "pf-books", min: "0", max: "99", step: "1" }, { min: 0, max: 99, round: true, ph: "0" })), 2),
    span(h("div", { class: "pf-grp pf-switches" },
      switchRow("Hide props with too few books", "thin"),
      switchRow("Hide games that have started", "hs")), 4),
    hitGrp, defGrp,
    (ui.done = h("button", { type: "button", class: "btn btn-primary pf-done" }, "Show props")));
}

// ---------------------------------------------------------------- table
// Seven fixed columns plus the windows, never a sideways scroll: the player's
// cell carries the game, the prop's cell carries the side and line, the price
// cell carries the book and the book count. The sort keys that no longer have
// a column of their own (kickoff, line, side, books) live in the Sort select.
const COLS = () => {
  const win = (t) => ({ key: `win:${t.key}`, label: t.label, num: true, hit: t.key, defDir: "desc", cls: "c-rate" });
  return [
    { key: "player", label: "Player", cls: "c-player", defDir: "asc" },
    { key: "prop", label: "Prop", cls: "c-prop", defDir: "asc" },
    { key: "price", label: "Best price", num: true, cls: "c-price", defDir: "desc" },
    { key: "fair", label: "Fair odds", num: true, cls: "c-fair", defDir: "desc" },
    ...F.tiles.map(win),
    { key: "avg", label: "Avg", num: true, cls: "c-avg", defDir: "desc" },
    { key: "def", label: "Opp defense", cls: "c-def", defDir: "desc" },
  ];
};

/** Every sort the page offers, for the Sort select (the phone has no clickable headers). */
function sortOptions() {
  return [
    { key: "player", label: "Player", defDir: "asc" },
    { key: "game", label: "Kickoff", defDir: "asc" },
    { key: "prop", label: "Prop", defDir: "asc" },
    { key: "line", label: "Line", defDir: "desc" },
    { key: "side", label: "Side", defDir: "asc" },
    { key: "price", label: "Best price", defDir: "desc" },
    { key: "fair", label: "Fair odds", defDir: "desc" },
    ...F.tiles.map((t) => ({ key: `win:${t.key}`, label: `Hit rate ${t.label}`, defDir: "desc" })),
    { key: "avg", label: "Avg", defDir: "desc" },
    { key: "def", label: "Opp defense", defDir: "desc" },
    { key: "books", label: "Books", defDir: "desc" },
  ];
}

let cols = [];
let ths = new Map();

function buildHead() {
  cols = COLS();
  ths = new Map();
  const tr = h("tr");
  for (const c of cols) {
    const btn = h("button", { type: "button", class: "th-sort" }, c.label);
    btn.addEventListener("click", () => {
      const same = state.sort === c.key;
      change({ sort: c.key, dir: same ? (state.dir === "desc" ? "asc" : "desc") : c.defDir });
    });
    const th = h("th", { scope: "col", role: "columnheader", class: `${c.num ? "num " : ""}${c.cls || ""}` }, btn);
    ths.set(c.key, { th, btn, c });
    tr.appendChild(th);
  }
  return h("thead", {}, tr);
}

function paintHead() {
  const tile = F.tiles.find((t) => t.key === state.hw) || F.tiles[0];
  for (const { th, btn, c } of ths.values()) {
    const on = state.sort === c.key;
    btn.classList.toggle("active", on);
    btn.dataset.arrow = state.dir === "asc" ? "↑" : "↓";
    th.classList.toggle("is-sorted", on);
    if (on) th.setAttribute("aria-sort", state.dir === "asc" ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
    th.classList.toggle("is-window", c.hit === state.hw);
    if (c.key === "avg") {
      btn.textContent = `Avg ${tile.label}`;
      btn.setAttribute("aria-label", `Sort by average over ${tile.long}`);
    } else {
      btn.setAttribute("aria-label", `Sort by ${c.label}`);
    }
  }
  if (ui.sortSel) {
    ui.sortSel.value = state.sort;
    const asc = state.dir === "asc";
    ui.sortDir.textContent = asc ? "↑ Ascending" : "↓ Descending";
    ui.sortDir.setAttribute("aria-label", `Sort direction: ${asc ? "ascending" : "descending"}. Switch to ${asc ? "descending" : "ascending"}`);
  }
}

function proplabHref(row) {
  const p = row.rec.p;
  const q = `g=${encodeURIComponent(p.game)}&t=${encodeURIComponent(p.team)}&p=${encodeURIComponent(p.id)}`
    + `&m=${encodeURIComponent(row.rec.m.key)}&w=${encodeURIComponent(state.hw)}&s=${encodeURIComponent(state.sp)}`;
  return `${root()}${currentSport()}/prop-lab/#${q}`;
}

const SIDE_LABEL = { over: "Over", under: "Under", yes: "Yes" };

// `label` is what the phone's card shows above a value (the headers are hidden there)
function td(cls, label, ...kids) {
  return h("td", { class: cls || null, role: "cell", "data-label": label || null }, ...kids);
}

function hitCell(row, tile) {
  const hr = row.st[tile.key][row.hitSide];
  const cls = `num c-rate${tile.key === state.hw ? " is-window" : ""}`;
  if (!hr.d) return td(cls, tile.label, h("span", { class: "pf-gap", title: `${tile.long}: no games`, "aria-label": `${tile.label}: no games` }, "N/A"));
  const verb = row.side === "yes" ? "scored in" : row.side === "under" ? "under in" : "over in";
  const label = `${tile.label}: ${verb} ${hr.n} of ${hr.d} ${hr.d === 1 ? "game" : "games"}, ${Math.round(hr.pct)} percent`;
  return td(cls, tile.label,
    h("span", { class: `pf-rate ${rateClass(hr.pct)}`, title: label, "aria-label": label },
      h("span", { class: "pf-rate-n" }, `${hr.n}/${hr.d}`),
      h("span", { class: "pf-rate-p" }, `${Math.round(hr.pct)}%`)));
}

function defCell(row) {
  if (!row.def || row.tone == null) return td("c-def", "Opp defense", h("span", { class: "pf-gap", "aria-label": "No defense rank" }, "N/A"));
  const phrase = row.def.cell[2] || rankPhrase(row.def.cell[1], row.def.of);
  const name = row.tone === 1 ? "soft" : row.tone === -1 ? "tough" : "neutral";
  const cls = row.tone === 1 ? "is-soft" : row.tone === -1 ? "is-tough" : "is-even";
  const side = row.side === "under" ? "the under" : row.side === "yes" ? "a yes" : "the over";
  const label = `${row.rec.m.short} allowed: ${phrase.toLowerCase()}, ${name} for ${side}`;
  return td("c-def", "Opp defense", h("span", { class: `pf-def ${cls}`, title: label, "aria-label": label }, phrase));
}

function fairCell(row) {
  const f = row.fair;
  if (f.kind === "thin") return td("num c-fair", "Fair odds", h("span", { class: "pf-thin" }, "Too few books"));
  const pct = f.prob != null ? fmtPercent(f.prob, 1) : "";
  if (f.kind === "avg") {
    return td("num c-fair", "Fair odds", h("span", { class: "pf-fair-v", title: "The books' average, their cut included", "aria-label": `Books' average, cut included: ${f.odds}` }, f.odds),
      h("span", { class: "pf-fair-p pf-avgtag" }, "Books' avg"));
  }
  return td("num c-fair", "Fair odds", h("span", { class: "pf-fair-v" }, f.odds), pct ? h("span", { class: "pf-fair-p" }, pct) : null);
}

// A game's own pull time, when it differs from the board's by more than a few
// minutes (CFB: a game the latest pull missed keeps its older prices), the way
// the Prop Lab shows it. Same-pull games say nothing here; the footer has the board's.
const STAMP_GAP_MS = 15 * 60 * 1000;
function rowAsOf(game) {
  if (!game.lines_as_of || !DATA.lines_as_of) return null;
  const gap = Math.abs(Date.parse(game.lines_as_of) - Date.parse(DATA.lines_as_of));
  return gap > STAMP_GAP_MS ? game.lines_as_of : null;
}

function priceCell(row) {
  const n = row.rec.books;
  const asOf = rowAsOf(row.rec.game);
  const count = h("span", { class: "pf-nbooks" }, `${n} book${n === 1 ? "" : "s"}`,
    asOf ? ` · as of ${fmtKick(asOf)} ET` : null);
  if (!row.price) return td("num c-price", null, h("span", { class: "pf-gap", title: "No best price on the board for this side", "aria-label": "No best price" }, "N/A"), count);
  return td("num c-price", null, h("span", { class: "pf-price-v" }, row.price.odds), bookLine(row.price.books, "pf-book"), count);
}

function buildRow(row) {
  const { p, game, m } = row.rec;
  const tile = F.tiles.find((t) => t.key === state.hw) || F.tiles[0];
  const href = proplabHref(row);
  const team = p.team_abbr || teamAbbr(game, p.team);
  const lineTxt = fmtLineValue(row.rec.line);
  const aria = `${p.name}, ${m.label} ${SIDE_LABEL[row.side].toLowerCase()}${row.side === "yes" ? "" : ` ${lineTxt}`}. Open in the Prop Lab`;
  const gameTxt = `${teamAbbr(game, game.away)} @ ${teamAbbr(game, game.home)}`;
  const link = h("a", { class: "pf-who", href, "aria-label": aria },
    headshotImg(p.headshot, p.name, 24, "pl-avatar-sm"),
    h("span", { class: "pf-id" },
      h("span", { class: "pf-name" }, p.name),
      h("span", { class: "pf-sub" }, `${p.pos} · ${team}`),
      h("span", { class: "pf-sub pf-gm" }, `${gameTxt} · ${game.kick ? fmtKick(game.kick) : "TBD"}`)));
  const tr = h("tr", { class: "pf-row", role: "row", "data-href": href });
  const cells = [
    td("c-player", null, link),
    td("c-prop", null,
      h("span", { class: "pf-mkt" }, m.short),
      h("span", { class: `pf-pick num ${row.side === "yes" ? "" : `is-${row.side}`}` },
        h("span", { class: "pf-side" }, SIDE_LABEL[row.side]), row.side === "yes" ? null : ` ${lineTxt}`)),
    priceCell(row), fairCell(row),
    ...F.tiles.map((t) => hitCell(row, t)),
    td("num c-avg", `Avg ${tile.label}`, row.st[tile.key].avg == null ? h("span", { class: "pf-gap" }, "N/A") : fmtDec1(row.st[tile.key].avg)),
    defCell(row),
  ];
  cells.forEach((c, i) => {
    if (state.sort === cols[i].key) c.classList.add("is-sorted");
    tr.appendChild(c);
  });
  return tr;
}

// A whole row is one target: a click anywhere opens the card (the player's
// name is the row's real link, for the keyboard and for "open in a new tab").
function onRowClick(e) {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.target.closest("a, button, input, select, label")) return;
  const tr = e.target.closest(".pf-row");
  if (!tr) return;
  const href = tr.dataset.href;
  if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
  else location.href = href;
}

// ---------------------------------------------------------------- player picker
// An ARIA combobox: the input keeps focus, the list is a listbox of options, and
// aria-activedescendant names the highlighted one. Up and Down move, Enter picks
// the highlighted player (with none highlighted it is the plain text search),
// Escape closes the list and a second one clears the text, Tab closes it.
const DD_MAX = 8;
const dd = { hits: [], total: 0, active: -1, open: false };
const COARSE = window.matchMedia ? window.matchMedia("(pointer: coarse)") : { matches: false };

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const chipText = (e) => `${e.name} · ${e.pos} ${e.abbr}`;
const gameText = (e) => `${teamAbbr(e.game, e.game.away)} @ ${teamAbbr(e.game, e.game.home)} · ${e.game.kick ? fmtKick(e.game.kick) : "TBD"}`;

function optionNode(e, i, toks) {
  const segs = matchSegments(e.name, toks);
  return h("li", { class: "pf-opt", role: "option", id: `pf-opt-${i}`, "aria-selected": "false", "data-i": String(i) },
    headshotImg(e.headshot, e.name, 32, "pl-avatar-sm"),
    h("span", { class: "pf-opt-main" },
      h("span", { class: "pf-opt-name" }, segs.map((x) => (x.m ? h("b", { class: "pf-em" }, x.t) : x.t))),
      h("span", { class: "pf-opt-sub" }, `${e.pos} · ${e.abbr}`),
      h("span", { class: "pf-opt-sub pf-opt-gm" }, gameText(e))),
    h("span", { class: "pf-opt-n num" }, plural(e.nProps, "prop")));
}

function setActive(i, { scroll = false } = {}) {
  dd.active = i;
  [...ui.ddList.children].forEach((li, k) => {
    const on = k === i;
    li.setAttribute("aria-selected", on ? "true" : "false");
    li.classList.toggle("is-active", on);
    if (on && scroll) li.scrollIntoView({ block: "nearest" });
  });
  if (i >= 0) ui.search.setAttribute("aria-activedescendant", `pf-opt-${i}`);
  else ui.search.removeAttribute("aria-activedescendant");
}

function closeDropdown() {
  dd.open = false;
  ui.dd.hidden = true;
  ui.search.setAttribute("aria-expanded", "false");
  setActive(-1);
}

/** Rebuild the list for what is typed; under two letters there is no list. */
function refreshDropdown() {
  const r = F.searchPlayers(ui.search.value, DD_MAX);
  if (!r.tokens.length) { ui.ddStatus.textContent = ""; return closeDropdown(); }
  dd.hits = r.hits;
  dd.total = r.total;
  ui.ddList.replaceChildren(...r.hits.map((e, i) => optionNode(e, i, r.tokens)));
  ui.ddList.hidden = !r.hits.length;
  const more = r.total - r.hits.length;
  ui.ddNote.textContent = !r.hits.length
    ? "No player starts with that. Press Enter to search the table by text."
    : more > 0 ? `${plural(more, "more player")}. Keep typing to narrow the list.` : "";
  ui.ddNote.hidden = !ui.ddNote.textContent;
  ui.ddStatus.textContent = r.hits.length
    ? `${plural(r.total, "player")} found. Use the up and down arrow keys, then Enter, to choose one.`
    : "No players found.";
  dd.open = true;
  ui.dd.hidden = false;
  ui.ddList.scrollTop = 0;
  ui.search.setAttribute("aria-expanded", r.hits.length ? "true" : "false");
  setActive(-1);
}

/** Filter the table to one player, by id, and clear the typed text. */
function pickPlayer(e, { byPointer = false } = {}) {
  closeDropdown();
  ui.search.value = "";
  ui.ddStatus.textContent = `Showing props for ${e.name}`;
  if (ui.root.classList.contains("pf-open")) {
    ui.root.classList.remove("pf-open");
    ui.filterBtn.setAttribute("aria-expanded", "false");
  }
  change({ pl: e.id, q: "" });
  // on a phone, put the keyboard away so the player's props are in view
  if (byPointer && COARSE.matches) ui.search.blur();
}

function clearPlayer(e) {
  change({ pl: "" });
  // from the keyboard, focus goes back to the search box rather than to nowhere
  if (e && e.detail === 0) ui.search.focus();
}

/** Keep the player, drop every other filter (Both sides), keep the sort and window. */
function showAllOfHis(e) {
  const pe = F.playerById.get(state.pl);
  if (!pe) return;
  const d = defaultState(S);
  const started = pe.kick != null && pe.kick <= Date.now();
  beforePreset = null;
  ui.search.value = "";
  closeDropdown();
  change({
    ...d, pl: state.pl, sd: "both", hw: state.hw, sp: state.sp, sort: state.sort, dir: state.dir,
    hs: started ? false : d.hs,
  });
  if (e && e.detail === 0) ui.scroll.focus();
}

function onSearchKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const n = dd.hits.length;
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (!dd.open) refreshDropdown();
      if (!dd.open || !n) return;
      e.preventDefault();
      const none = dd.active === -1;
      let i;
      if (e.key === "ArrowDown") i = none ? 0 : dd.active + 1 >= n ? -1 : dd.active + 1;
      else i = none ? n - 1 : dd.active - 1;
      setActive(i, { scroll: true });
      return;
    }
    case "Enter":
      if (dd.open && dd.active >= 0 && dd.hits[dd.active]) {
        e.preventDefault();
        pickPlayer(dd.hits[dd.active]);
      } else {
        // no entry highlighted: the plain text search, now rather than after the pause
        closeDropdown();
        const q = ui.search.value.trim();
        if (q !== state.q) change({ q });
      }
      return;
    case "Escape":
      if (dd.open) {
        closeDropdown();
      } else if (ui.search.value) {
        ui.search.value = "";
        if (state.q) change({ q: "" });
      } else {
        return;          // nothing here to close: the phone's filter panel may take it
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    case "Tab":
      closeDropdown();
      return;
    case "Backspace":
      if (!ui.search.value && state.pl) clearPlayer({ detail: 0 });
      return;
    default:
  }
}

function buildSearch() {
  ui.search = h("input", {
    type: "search", class: "text-input pf-search", placeholder: "Search players", autocomplete: "off",
    autocapitalize: "off", enterkeyhint: "search", "aria-label": "Search players by name", spellcheck: "false", maxlength: "40",
    role: "combobox", "aria-autocomplete": "list", "aria-haspopup": "listbox", "aria-expanded": "false",
    "aria-controls": "pf-dd-list",
  });
  const pushSearch = debounce(() => change({ q: ui.search.value.trim() }), 160);
  ui.search.addEventListener("input", () => { refreshDropdown(); pushSearch(); });
  ui.search.addEventListener("keydown", onSearchKey);
  ui.search.addEventListener("click", () => { if (!dd.open && ui.search.value) refreshDropdown(); });

  ui.ddList = h("ul", { class: "pf-dd-list", id: "pf-dd-list", role: "listbox", "aria-label": "Matching players" });
  ui.ddNote = h("div", { class: "pf-dd-note" });
  ui.ddNote.hidden = true;
  ui.dd = h("div", { class: "pf-dd" }, ui.ddList, ui.ddNote);
  ui.dd.hidden = true;
  ui.ddStatus = h("div", { class: "visually-hidden", role: "status" });
  // the list never takes focus from the input; a tap or click picks, a moving mouse highlights
  ui.dd.addEventListener("mousedown", (e) => { if (e.target.closest(".pf-opt") || e.target.closest(".pf-dd-note")) e.preventDefault(); });
  ui.ddList.addEventListener("click", (e) => {
    const li = e.target.closest(".pf-opt");
    if (li && dd.hits[+li.dataset.i]) pickPlayer(dd.hits[+li.dataset.i], { byPointer: true });
  });
  let lastXY = "";
  ui.ddList.addEventListener("mousemove", (e) => {
    const xy = `${e.clientX},${e.clientY}`;
    if (xy === lastXY) return;
    lastXY = xy;
    const li = e.target.closest(".pf-opt");
    if (li && +li.dataset.i !== dd.active) setActive(+li.dataset.i);
  });
  document.addEventListener("pointerdown", (e) => {
    if (dd.open && e.target !== ui.search && !ui.dd.contains(e.target)) closeDropdown();
  });
  ui.search.addEventListener("focusout", (e) => {
    if (dd.open && e.relatedTarget && !ui.dd.contains(e.relatedTarget)) closeDropdown();
  });
  ui.chipHost = h("div", { class: "pf-chiprow" });
  ui.chipId = "";
}

/** The chip for the picked player, rebuilt only when the player changes. */
function paintPlayer() {
  const e = state.pl ? F.playerById.get(state.pl) : null;
  const id = e ? e.id : "";
  if (id === ui.chipId) return;
  ui.chipId = id;
  if (!e) { ui.chipHost.replaceChildren(); return; }
  const x = h("button", {
    type: "button", class: "pf-chip-x",
    "aria-label": `Clear the player filter: ${e.name}, ${e.pos} ${e.abbr}`,
  }, h("span", { "aria-hidden": "true" }, "×"));
  x.addEventListener("click", clearPlayer);
  ui.chipHost.replaceChildren(h("span", { class: "pf-chip" },
    h("span", { class: "pf-chip-t", title: chipText(e) }, chipText(e)), x));
}

// ---------------------------------------------------------------- draw
function draw({ resetScroll = false } = {}) {
  const t0 = performance.now();
  syncers.forEach((fn) => fn());
  const { rows, total } = F.run(state);
  const shown = rows.slice(0, limit);

  ui.count.textContent = `${total.toLocaleString("en-US")} prop${total === 1 ? "" : "s"}`;
  ui.tabs.forEach(({ b, key }) => b.setAttribute("aria-pressed", state.sd === key ? "true" : "false"));
  const n = activeCount();
  ui.filterBtn.textContent = n ? `Filters (${n})` : "Filters";
  ui.filterBtn.setAttribute("aria-expanded", ui.root.classList.contains("pf-open") ? "true" : "false");
  ui.done.textContent = `Show ${total.toLocaleString("en-US")} prop${total === 1 ? "" : "s"}`;
  ui.resetBtn.disabled = n === 0 && state.sort === defaultState(S).sort && state.dir === defaultState(S).dir;
  ui.presets.forEach(({ b, p }) => b.setAttribute("aria-pressed", presetOn(p) ? "true" : "false"));
  paintHead();
  paintPlayer();

  // a picked player whose props the other filters hide says how many are showing
  const pe = state.pl ? F.playerById.get(state.pl) : null;
  // out of his props on this side tab: the side alone is a choice, not a hidden prop (Fable 10/01)
  const ofSide = pe ? (state.sd === "over" ? pe.nOver : state.sd === "under" ? pe.nUnder : pe.nProps) : 0;
  const hides = pe && total < ofSide;
  const tally = hides ? `${pe.name}: ${total.toLocaleString("en-US")} of ${plural(ofSide, "prop")} shown.` : "";
  ui.plnoteText.textContent = tally;
  ui.plnote.hidden = !(hides && total > 0);

  if (!total) {
    ui.scroll.hidden = true;
    ui.more.hidden = true;
    const reset = h("button", { type: "button", class: "btn btn-sm", onClick: reset_ }, "Reset filters");
    const acts = [];
    if (hides) acts.push(h("button", { type: "button", class: "btn btn-sm btn-primary", onClick: showAllOfHis }, "Show all of his props"));
    acts.push(reset);
    ui.empty.replaceChildren(
      emptyState(hides ? tally : "Nothing on the slate matches these filters. Loosen one, or reset them all.", "No props match"),
      h("div", { class: "pf-empty-act" }, acts));
    ui.empty.hidden = false;
  } else {
    ui.empty.hidden = true;
    ui.scroll.hidden = false;
    const frag = document.createDocumentFragment();
    for (const r of shown) frag.appendChild(buildRow(r));
    ui.tbody.replaceChildren(frag);
    if (resetScroll) ui.scroll.scrollTop = 0;
    ui.more.hidden = shown.length >= total;
    if (!ui.more.hidden) {
      ui.moreText.textContent = `Showing ${shown.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
    }
  }
  const ms = Math.round(performance.now() - t0);
  ui.root.dataset.drawMs = String(ms);
  ui.root.dataset.rows = String(total);
}

function reset_() {
  state = defaultState(S);
  limit = PAGE;
  // the search box is cleared with the rest
  ui.search.value = "";
  closeDropdown();
  writeHash();
  draw({ resetScroll: true });
}

// ---------------------------------------------------------------- mount
function mount() {
  const app = document.getElementById("app");
  state = decodeHash(location.hash, S, F.facets);

  const head = h("div", { class: "page-head pf-head" },
    h("h1", {}, "Prop Finder"), h("p", { class: "sub" }, DATA.slate.label));
  if (DATA.message) head.appendChild(notice({ kind: "info", text: DATA.message }));
  const intro = h("p", { class: "pf-intro" },
    "Past hit rates beside the market’s fair odds. A streak the books already know is in the price.");

  // search, the phone's Filters button, the presets and Reset
  buildSearch();
  ui.filterBtn = h("button", { type: "button", class: "btn pf-filter-btn", "aria-controls": "pf-panel", "aria-expanded": "false" }, "Filters");
  ui.filterBtn.addEventListener("click", () => {
    ui.root.classList.toggle("pf-open");
    ui.filterBtn.setAttribute("aria-expanded", ui.root.classList.contains("pf-open") ? "true" : "false");
  });
  ui.presets = PRESETS.map((p) => {
    const b = h("button", { type: "button", class: "pf-pill pf-preset", "aria-pressed": "false" }, p.label);
    b.addEventListener("click", () => {
      if (presetOn(p)) {
        const back = beforePreset || { hw: defaultState(S).hw, sort: defaultState(S).sort, dir: defaultState(S).dir };
        beforePreset = null;
        change({ hmin: 0, hg: null, ...back });
      } else {
        // switching straight from one preset to another keeps the first one's "before"
        if (!PRESETS.some(presetOn)) beforePreset = { hw: state.hw, sort: state.sort, dir: state.dir };
        change(presetPatch(p));
      }
    });
    return { b, p };
  });
  ui.resetBtn = h("button", { type: "button", class: "pf-reset" }, "Reset");
  ui.resetBtn.addEventListener("click", reset_);
  const bar = h("div", { class: "pf-bar" },
    h("div", { class: "pf-barline" },
      h("div", { class: "pf-searchrow" }, ui.search, ui.filterBtn, ui.dd, ui.ddStatus), ui.chipHost),
    h("div", { class: "pf-presets", role: "group", "aria-label": "Quick filters" }, ui.presets.map((x) => x.b), ui.resetBtn));

  const panel = buildPanel();
  ui.done.addEventListener("click", () => {
    ui.root.classList.remove("pf-open");
    ui.filterBtn.setAttribute("aria-expanded", "false");
    ui.filterBtn.focus();
  });

  // Over | Under | Both as the page's underline tabs, with the count at the right
  ui.tabs = ["over", "under", "both"].map((key) => {
    const b = h("button", { type: "button", class: "pf-tab", "aria-pressed": "false" },
      key === "over" ? "Over" : key === "under" ? "Under" : "Both");
    b.addEventListener("click", () => change({ sd: key }));
    return { b, key };
  });
  ui.count = h("span", { class: "pf-count num", "aria-live": "polite" });
  // the Sort control: the only sort on a phone, and the way to reach kickoff, line, side and books anywhere
  const sopts = sortOptions();
  ui.sortSel = h("select", { class: "select-input pf-sort-sel", id: "pf-sort" },
    sopts.map((o) => h("option", { value: o.key }, o.label)));
  ui.sortSel.addEventListener("change", () => {
    const o = sopts.find((x) => x.key === ui.sortSel.value);
    change({ sort: o.key, dir: o.defDir });
  });
  ui.sortDir = h("button", { type: "button", class: "btn btn-sm pf-sort-dir" });
  ui.sortDir.addEventListener("click", () => change({ dir: state.dir === "desc" ? "asc" : "desc" }));
  const sortBox = h("div", { class: "pf-sort" },
    h("label", { class: "pf-lbl", for: "pf-sort" }, "Sort"),
    h("span", { class: "pf-select" }, ui.sortSel), ui.sortDir);
  const tabs = h("div", { class: "pf-tabrow" },
    h("div", { class: "pf-tabs", role: "group", "aria-label": "Side" }, ui.tabs.map((x) => x.b)),
    sortBox, ui.count);

  ui.tbody = h("tbody");
  const table = h("table", { class: "data-table pf-table", role: "table" },
    h("caption", { class: "visually-hidden" }, "Props on the slate, one row per player, prop and side. Select a row to open that player in the Prop Lab."),
    buildHead(), ui.tbody);
  ui.tbody.addEventListener("click", onRowClick);
  ui.scroll = h("div", { class: "table-scroll pf-scroll", tabindex: "0", role: "region", "aria-label": "Props, scrolls down" }, table);
  ui.plnoteText = h("span", { class: "pf-plnote-t" });
  const plBtn = h("button", { type: "button", class: "pf-plnote-btn" }, "Show all of his props");
  plBtn.addEventListener("click", showAllOfHis);
  ui.plnote = h("div", { class: "pf-plnote", "aria-live": "polite" }, ui.plnoteText, plBtn);
  ui.plnote.hidden = true;
  ui.empty = h("div", { class: "pf-empty" });
  ui.empty.hidden = true;
  ui.moreText = h("span", { class: "pf-more-t num" });
  const moreBtn = h("button", { type: "button", class: "btn btn-sm" }, "Show more");
  moreBtn.addEventListener("click", () => { limit += PAGE; draw(); });
  ui.more = h("div", { class: "pf-more" }, ui.moreText, moreBtn);
  ui.more.hidden = true;

  const foot = h("div", { class: "pf-foot" },
    h("a", { class: "pf-foot-link", href: `${root()}methodology/#finder` }, "How these numbers work"),
    DATA.lines_as_of ? h("span", { class: "pf-foot-stamp" }, `Lines as of ${fmtKick(DATA.lines_as_of)} ET`) : null,
    DATA.slate.games.some(rowAsOf) ? h("span", { class: "pf-foot-stamp" }, "A game with older prices says so in its row.") : null);

  // one Tab from the top reaches the results, past the filters' many stops
  const skip = h("button", { type: "button", class: "pf-skip" }, "Skip to results");
  skip.addEventListener("click", () => {
    const first = ui.tbody.querySelector(".pf-who");
    (first || ui.scroll).focus();
    (first || ui.scroll).scrollIntoView({ block: "center" });
  });
  ui.root = h("div", { class: "prop-finder" }, head, intro, skip, bar, panel, tabs, ui.plnote, ui.scroll, ui.empty, ui.more, foot);
  // Escape closes the phone's filter panel and gives focus back to its button
  ui.root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !ui.root.classList.contains("pf-open")) return;
    ui.root.classList.remove("pf-open");
    ui.filterBtn.setAttribute("aria-expanded", "false");
    ui.filterBtn.focus();
  });
  app.replaceChildren(ui.root);
  ui.search.value = state.q;
  draw();
}

// ---------------------------------------------------------------- entry
async function render() {
  const app = document.getElementById("app");
  const sport = currentSport();
  app.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, "Prop Finder")));

  // a sport whose Prop Lab is still "coming" has no data folder, so there is nothing to ask for
  if (manifestStatus(sport, "prop-finder") === "coming") {
    app.appendChild(comingState(getComingText(sport, "prop-finder")));
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
    app.appendChild(comingState(data.message || getComingText(sport, "prop-finder")));
    return;
  }
  if (!data.slate || !data.slate.games || !data.slate.games.length) {
    app.appendChild(emptyState("No games on this slate yet."));
    return;
  }
  DATA = data;
  S = createStats(data);
  F = createFinder(S);
  setFooterSources(data.sources);
  mount();
}

// a hand-edited or back/forward hash redraws the table; an unreadable one is the default view
window.addEventListener("hashchange", () => {
  if (!F) return;
  state = decodeHash(location.hash, S, F.facets);
  limit = PAGE;
  ui.search.value = state.q;
  closeDropdown();
  draw({ resetScroll: true });
});

render();
