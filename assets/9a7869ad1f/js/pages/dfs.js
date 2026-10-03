// DFS: the build controls and the roster up top, the player pool below in a
// scroller of its own. The solver (optimizer.js) is dynamically imported only
// when Optimize is clicked, so this page still renders fully if it isn't there
// yet.
//
// FanDuel (NFL only): a DraftKings | FanDuel switch at the top loads
// data/nfl/dfs-fd.json in place of dfs.json. The same page, solver and controls
// run on either file, which carries its own roster spec (cap, seats, team
// rule). The chosen site rides in the address (#site=fd) so it can be linked.
//
// Restyled 2026-09-30 to match the redesigned home page and Prop Lab (owner
// preview). Look only: every control below does what it did before. What the redesign adds: a headshot and team logo wherever a player
// shows, a status chip, a points per $1K bar, Pin and Exclude as icon buttons,
// a salary bar with KPI cells under the roster, and a lineup tab strip in place
// of the old stack of lineup cards.
import {
  h, fetchJSON, currentSport, comingState, errorState, missingState, notice,
  getComingText, setFooterSources, manifestStatus, getManifest, fmtMoney, fmtDec1, fmtKick, sortRows,
  renderTable, debounce, normName, labeledField as field,
} from "../app.js";
import { buildProjectionImport, clearSavedProjections } from "../projimport-ui.js";

let DATA = null;
let seats = [];

// ------------------------------------------------------------------ the site
// Which DFS site the page shows: DraftKings (dfs.json) or FanDuel (dfs-fd.json,
// NFL only; college football has no FanDuel contest). DraftKings is the default.
const SITE_FILES = { dk: "dfs", fd: "dfs-fd" };
const SITE_LABELS = { dk: "DraftKings", fd: "FanDuel" };
// The "not in yet" sentence lives in the build (nfl_fd.COMING): it rides in
// dfs-fd.json and the manifest. This copy is only for a deploy where neither
// file exists yet (a 404).
const FD_COMING_FALLBACK = "FanDuel's player list for this week isn't in yet.";
function fdComingText() {
  const m = getManifest();
  const fdStatus = m && m.sports && m.sports.nfl && m.sports.nfl.dfs && m.sports.nfl.dfs.fd;
  return (fdStatus && fdStatus.message) || FD_COMING_FALLBACK;
}
let siteKey = "dk";
let hasFanDuel = false;
let headHost, bodyHost;
let loadToken = 0;

function siteFromHash() {
  try {
    const v = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("site");
    return v === "fd" ? "fd" : "dk";
  } catch {
    return "dk";
  }
}

function writeSiteHash(site) {
  try {
    const url = window.location.pathname + window.location.search + (site === "fd" ? "#site=fd" : "");
    window.history.replaceState(null, "", url);
  } catch { /* the address is a convenience */ }
}

// A position as this site names it: FanDuel's seat is DEF where the data says DST.
const posLabel = (pos) => ((DATA && DATA.roster && DATA.roster.pos_labels) || {})[pos] || pos;
const state = {
  lineups: 1,
  maxOverlap: 7,
  qbStack: 0,
  bringBack: 0,
  // On by default (owner 2026-09-27: "should be toggled on by default"): a
  // defense scores when the offense it faces struggles, so rostering both
  // bets against yourself.
  blockDstOpponents: true,
  salaryFloor: null,     // no player (DST aside) priced under this, or null for none
  excludes: new Set(),
  projOverride: {},
  projLeftOut: null,     // a Set of ids the visitor's file leaves out (treated as unprojected), or null
  csvReport: null,
  seatPins: new Map(),   // seat index -> player object
  lastResult: null,      // last optimize() result, or null
  activeLineup: 0,       // which of the result's lineups the roster shows
  poolSort: { key: "_proj", dir: "desc" },
  poolSearch: "",
  poolPos: "ALL",
};

let poolSortSel, poolSortDir;
let rosterListHost, rosterHeadHost, totalsHost, lineupTabsHost, rosterActionsHost, resultsHost, poolTableHost, poolCountHost, messageHost;

let _uid = 0;
const uid = (p) => `${p}-${++_uid}`;

function expandSeats(roster) {
  const out = [];
  for (const s of roster.slots) {
    for (let k = 0; k < s.count; k++) out.push({ slot: s.key, label: s.label || s.key, eligible: s.eligible });
  }
  return out;
}

// What each sport's data file says, with the NFL page's values when it says
// nothing, so a sport without a DST (CFB) never offers the DST switch.
const NFL_POSITIONS = ["QB", "RB", "WR", "TE", "DST"];
const rules = () => DATA.rules || {};
const hasDstRule = () => !!rules().block_dst_opponents;

function findPlayer(id) {
  return DATA.players.find((p) => p.id === id);
}

function effectiveProj(p) {
  const over = state.projOverride[p.id];
  if (over != null) return over;
  if (state.projLeftOut && state.projLeftOut.has(String(p.id))) return null;
  return p.proj == null ? null : Number(p.proj);
}

// ---------------------------------------------------------------- images
// Photos and logos load from two hosts only: ESPN's, and the NFL's own image
// host the Prop Lab already uses. Anything else, or a failed load, draws
// initials (or the team's abbreviation) in its place, never a broken image.
const IMAGE_HOSTS = new Set(["a.espncdn.com", "static.www.nfl.com"]);

function okImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && IMAGE_HOSTS.has(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function sized(size) {
  return `--sz:${size}px`;
}

function initialsCircle(name, size) {
  return h("span", { class: "dfs-avatar is-fallback", style: sized(size), "aria-hidden": "true" }, initials(name));
}

// The NFL's headshot links serve the full 3400px photo (about 500KB each).
// Its image host resizes on request, so ask for the size drawn, twice over for
// a sharp screen (the Prop Lab does the same). A link it won't resize falls
// back to the original, then to initials. ESPN's photos are left alone.
function sizedHeadshot(url, size) {
  const m = /^(https:\/\/static\.www\.nfl\.com\/image\/upload\/)f_auto,q_auto(\/.+)$/.exec(url || "");
  return m ? `${m[1]}f_auto,q_auto,w_${size * 2},h_${size * 2},c_fill,g_face${m[2]}` : url;
}

function headshotImg(url, name, size) {
  const src = okImage(url);
  if (!src) return initialsCircle(name, size);
  const img = h("img", {
    src: sizedHeadshot(src, size), alt: "", width: size, height: size, class: "dfs-avatar", style: sized(size),
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    else img.replaceWith(initialsCircle(name, size));
  });
  return img;
}

// ESPN's NFL logo files are the team's lowercase code, except where
// DraftKings' code differs. The data file names each team's logo itself
// (teams), so this only covers a file built without them.
const ESPN_NFL_CODE = { WAS: "wsh" };

function logoUrl(abbr) {
  const t = DATA.teams && DATA.teams[abbr];
  if (t && t.logo) return t.logo;
  if (DATA.sport === "nfl" && abbr) {
    return `https://a.espncdn.com/i/teamlogos/nfl/500/${ESPN_NFL_CODE[abbr] || String(abbr).toLowerCase()}.png`;
  }
  return null;
}

function teamLogo(abbr, size) {
  // a logo too small to carry letters falls back to an empty tile
  const fallback = () => h("span", { class: "dfs-logo is-fallback", style: sized(size), "aria-hidden": "true" },
    size >= 18 ? abbr : "");
  const src = okImage(logoUrl(abbr));
  if (!src) return fallback();
  const img = h("img", {
    src, alt: "", width: size, height: size, class: "dfs-logo", style: sized(size),
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

// A defense has no photo: its team's logo sits where the face would.
function playerImg(p, size) {
  return p.pos === "DST" ? teamLogo(p.team, size) : headshotImg(p.headshot, p.name, size);
}

// ------------------------------------------------------------------ small bits
const ICONS = {
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 3.5h6l-.8 5.8 2.8 3V14H7v-1.7l2.8-3z"/><path d="M12 14v6.5"/></svg>',
  ban: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"/><path d="M6.4 6.4l11.2 11.2"/></svg>',
};

// DraftKings' injury tags. A code we don't know is shown as it came.
const STATUS = {
  Q: ["Questionable", "q"], D: ["Doubtful", "d"], O: ["Out", "o"], P: ["Probable", "p"],
};

function statusChip(code) {
  const raw = String(code || "").trim();
  if (!raw) return null;
  const [word, tone] = STATUS[raw.toUpperCase()] || [raw, "x"];
  return h("span", { class: `dfs-status is-${tone}`, role: "img", "aria-label": word, title: word }, raw.toUpperCase());
}

// "@ LAC" away, "vs LAC" at home; DraftKings writes a game as away@home.
function oppLabel(p) {
  if (!p.opp) return "";
  const away = typeof p.game === "string" && p.game.split("@")[0] === p.team;
  return `${away ? "@" : "vs"} ${p.opp}`;
}

const noProj = () => h("span", { class: "dfs-none" }, "No proj");

// ------------------------------------------------------------- roster/totals
function pinnedIdSet() {
  return new Set([...state.seatPins.values()].map((p) => p.id));
}

function removeFromSeat(i) {
  state.seatPins.delete(i);
  state.lastResult = null;
  refreshRoster();
  refreshResults();
  refreshPool();
}

function commitPin(i, player) {
  state.seatPins.set(i, player);
  state.lastResult = null;
  refreshRoster();
  refreshResults();
  refreshPool();
}

function openSlotPicker(seat, i) {
  const input = h("input", {
    type: "text", class: "text-input", placeholder: `Search ${seat.eligible.map(posLabel).join("/")}`,
    "aria-label": `Search ${seat.label} players`, autocomplete: "off",
  });
  const results = h("div", { class: "search-results" });
  const row = h("div", { class: "roster-slot is-picking" },
    h("span", { class: "slot-tag" }, seat.label),
    h("div", { class: "search-wrap slot-picker" }, input, results));

  const run = debounce(() => {
    const q = input.value.trim().toLowerCase();
    const pinned = pinnedIdSet();
    const matches = DATA.players.filter((p) => seat.eligible.includes(p.pos)
      && !state.excludes.has(p.id) && !pinned.has(p.id)
      && (q.length < 1 || p.name.toLowerCase().includes(q)))
      .slice(0, 8);
    results.replaceChildren(...matches.map((p) => {
      const btn = h("button", { type: "button" },
        h("span", { class: "sr-name" }, p.name),
        h("span", { class: "sr-meta num" }, `${p.team} · ${fmtMoney(p.salary)} · ${effectiveProj(p) == null ? "no proj" : fmtDec1(effectiveProj(p))}`));
      btn.addEventListener("mousedown", (e) => e.preventDefault()); // survive the input's blur
      btn.addEventListener("click", () => commitPin(i, p));
      return btn;
    }));
  }, 120);
  input.addEventListener("input", run);
  input.addEventListener("blur", () => setTimeout(() => {
    if (!state.seatPins.has(i)) refreshRoster();
  }, 150));

  rosterListHost.children[i].replaceWith(row);
  run();
  input.focus();
}

function emptySlotRow(seat, i) {
  const btn = h("button", { type: "button", class: "slot-empty-btn" }, `Add ${seat.label}`);
  btn.addEventListener("click", () => openSlotPicker(seat, i));
  return h("div", { class: "roster-slot" }, h("span", { class: "slot-tag" }, seat.label), btn);
}

function filledSlotRow(seat, i, player, isPinned) {
  const rm = h("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${player.name}` }, "×");
  rm.addEventListener("click", () => removeFromSeat(i));
  const proj = effectiveProj(player);
  return h("div", { class: `roster-slot is-filled${isPinned ? " is-pinned" : ""}` },
    h("span", { class: "slot-tag" }, seat.label),
    h("div", { class: "slot-player" },
      playerImg(player, 28),
      h("div", { class: "slot-body" },
        h("div", { class: "slot-name" },
          h("span", { class: "slot-name-t" }, player.name),
          isPinned ? h("span", { class: "pin-badge" }, "Pinned") : null,
          statusChip(player.status)),
        h("div", { class: "slot-meta" },
          h("span", {}, `${posLabel(player.pos)} ·`), teamLogo(player.team, 14),
          h("span", {}, `${player.team} ${oppLabel(player)}`)))),
    h("div", { class: "slot-nums" },
      h("span", { class: "num slot-sal" }, fmtMoney(player.salary)),
      h("span", { class: "num slot-proj" }, proj == null ? noProj() : fmtDec1(proj))),
    rm);
}

// The lineup the roster shows: the picked tab of an optimizer result, or null
// while the roster is just the player's own pins.
function shownLineup() {
  const r = state.lastResult;
  if (!r || r.status !== "ok" || !r.lineups.length) return null;
  return r.lineups[Math.min(state.activeLineup, r.lineups.length - 1)];
}

function refreshRoster() {
  const lu = shownLineup();
  const pinned = pinnedIdSet();
  const rows = seats.map((seat, i) => {
    if (lu) {
      const rs = lu.slots[i];
      if (rs && rs.player) return filledSlotRow(seat, i, rs.player, pinned.has(rs.player.id));
      return emptySlotRow(seat, i);
    }
    const p = state.seatPins.get(i);
    return p ? filledSlotRow(seat, i, p, true) : emptySlotRow(seat, i);
  });
  rosterListHost.replaceChildren(...rows);
  // the Salary and Proj labels wait for something to label
  rosterHeadHost.classList.toggle("is-idle", !rosterListHost.querySelector(".is-filled"));
  refreshTotals();
}

function refreshTotals() {
  const lu = shownLineup();
  const filled = seats.map((seat, i) => {
    if (lu) return lu.slots[i]?.player || null;
    return state.seatPins.get(i) || null;
  }).filter(Boolean);
  const salary = filled.reduce((s, p) => s + (p.salary || 0), 0);
  const proj = filled.reduce((s, p) => s + (effectiveProj(p) || 0), 0);
  const cap = DATA.roster.cap;
  const over = salary > cap;
  const pct = Math.max(0, Math.min(100, (salary / cap) * 100));
  const kpi = (label, value, tone) => h("div", { class: "dfs-kpi" },
    h("div", { class: "dfs-lbl" }, label),
    h("div", { class: `dfs-kpi-v num${tone ? ` ${tone}` : ""}` }, value));
  totalsHost.replaceChildren(
    h("div", { class: "dfs-cap" },
      h("div", { class: "dfs-cap-top" },
        h("span", { class: "dfs-lbl" }, "Salary"),
        h("span", { class: "num dfs-cap-n" }, `${fmtMoney(salary)} of ${fmtMoney(cap)}`)),
      h("div", {
        class: `dfs-cap-bar${over ? " is-over" : ""}`, role: "progressbar", "aria-label": "Salary used",
        "aria-valuemin": "0", "aria-valuemax": String(cap), "aria-valuenow": String(Math.round(salary)),
      }, h("i", { style: `width:${pct}%` }))),
    h("div", { class: "dfs-kpis" },
      kpi("Used", fmtMoney(salary), over ? "is-over" : ""),
      kpi("Remaining", fmtMoney(cap - salary), over ? "is-over" : ""),
      kpi("Projected", fmtDec1(proj))));
}

// ---------------------------------------------------------------------- results
function csvEscape(s) {
  const str = String(s ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// DraftKings: one column per seat holding the player's name. FanDuel: the
// same seat headers (QB, RB, RB, WR, WR, WR, TE, FLEX, DEF) with each cell the
// player's FanDuel Id alone (the Id in the player list the page was built from).
// ★ FanDuel's exact upload template is UNVERIFIED: it may want other headers,
// "Id:Name" cells or entry columns. Check it against a real template download
// before leaning on this file.
const uploadsIds = () => !!(DATA && DATA.roster && DATA.roster.upload === "fanduel");

function lineupsCSV(lineups, byId) {
  const header = lineups[0].slots.map((s) => s.label);
  const lines = [header.map(csvEscape).join(",")];
  for (const lu of lineups) {
    lines.push(lu.slots.map((s) => csvEscape(s.player ? (byId ? s.player.id : s.player.name) : "")).join(","));
  }
  return lines.join("\r\n");
}

function downloadLineupsCSV(lineups) {
  const blob = new Blob([lineupsCSV(lineups, uploadsIds())], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: uploadsIds() ? "sharpslate-fanduel-lineups.csv" : "sharpslate-lineups.csv" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Several lineups: a tab for each above the slots (the roster shows the picked
// one), and each player's exposure across all of them below.
function refreshResults() {
  const result = state.lastResult;
  if (!result || result.status !== "ok" || result.lineups.length <= 1) {
    lineupTabsHost.replaceChildren();
    rosterActionsHost.replaceChildren();
    resultsHost.replaceChildren();
    return;
  }
  state.activeLineup = Math.min(state.activeLineup, result.lineups.length - 1);

  const n = result.lineups.length;
  const label = (lu, idx) => `Lineup ${idx + 1} of ${n}, ${fmtDec1(lu.proj)} projected`;
  const tabBtns = result.lineups.map((lu, idx) => {
    const tab = h("button", {
      type: "button", class: "dfs-tab", "aria-pressed": idx === state.activeLineup ? "true" : "false",
    }, `Lineup ${idx + 1}`, h("span", { class: "dfs-chip num" }, fmtDec1(lu.proj)));
    tab.addEventListener("click", () => pickLineup(idx));
    return tab;
  });
  const tabs = h("div", { class: "dfs-tabs", role: "group", "aria-label": "Lineups" }, tabBtns);
  // A stepper for a phone and for a long list: previous, a select, next. It
  // says "Lineup 3 of 20", so a row of twenty tabs never has to fit anywhere.
  const sel = h("select", { class: "select-input dfs-step-sel", "aria-label": "Lineup" },
    result.lineups.map((lu, idx) => h("option", { value: String(idx) }, label(lu, idx))));
  const prev = h("button", { type: "button", class: "btn dfs-step-btn", "aria-label": "Previous lineup" }, "‹");
  const next = h("button", { type: "button", class: "btn dfs-step-btn", "aria-label": "Next lineup" }, "›");
  prev.addEventListener("click", () => pickLineup(state.activeLineup - 1));
  next.addEventListener("click", () => pickLineup(state.activeLineup + 1));
  sel.addEventListener("change", () => pickLineup(Number(sel.value)));
  function syncLineupNav() {
    tabBtns.forEach((b, k) => b.setAttribute("aria-pressed", k === state.activeLineup ? "true" : "false"));
    sel.value = String(state.activeLineup);
    // aria-disabled, not disabled: a disabled button that has focus drops it
    prev.setAttribute("aria-disabled", state.activeLineup <= 0 ? "true" : "false");
    next.setAttribute("aria-disabled", state.activeLineup >= n - 1 ? "true" : "false");
  }
  function pickLineup(idx) {
    if (idx < 0 || idx > n - 1) return;
    state.activeLineup = idx;
    syncLineupNav();
    refreshRoster();
  }
  syncLineupNav();
  lineupTabsHost.replaceChildren(h("div", { class: "dfs-lineups", "data-many": n > 6 ? "true" : "false" },
    tabs, h("div", { class: "dfs-step" }, prev, sel, next)));
  const dlBtn = h("button", {
    type: "button", class: "btn btn-sm",
    title: uploadsIds() ? "Lineups as a CSV, one per row, with FanDuel player Ids by seat." : null,
  }, "Download CSV");
  dlBtn.addEventListener("click", () => downloadLineupsCSV(result.lineups));
  rosterActionsHost.replaceChildren(dlBtn);

  const counts = new Map();
  for (const lu of result.lineups) {
    for (const s of lu.slots) {
      if (!s.player) continue;
      counts.set(s.player.id, (counts.get(s.player.id) || 0) + 1);
    }
  }
  const expRows = sortRows([...counts.entries()].map(([id, count]) => {
    const p = findPlayer(id);
    return { player: p ? p.name : id, count, pct: count / result.lineups.length };
  }), "count", "desc");
  const expHost = h("div", { class: "dfs-expo" });
  renderTable(expHost, {
    columns: [
      { key: "player", label: "Player", type: "text" },
      { key: "count", label: "Count", type: "int" },
      { key: "pct", label: "%", type: "pct1" },
    ],
    rows: expRows,
  });
  resultsHost.replaceChildren(h("div", { class: "dfs-lbl" }, "Exposure"), expHost);
}

// ------------------------------------------------------------------------ pool
function excludePlayer(id) {
  state.excludes.add(id);
  for (const [seatIdx, pl] of [...state.seatPins]) if (pl.id === id) state.seatPins.delete(seatIdx);
  state.lastResult = null;
  refreshRoster();
  refreshResults();
  refreshPool();
  if (refreshExcludeChips) refreshExcludeChips();
}

function unexcludePlayer(id) {
  state.excludes.delete(id);
  refreshPool();
  if (refreshExcludeChips) refreshExcludeChips();
}

function pinFromPool(id) {
  const p = findPlayer(id);
  if (!p) return;
  if (pinnedIdSet().has(id)) {
    messageHost.replaceChildren(notice({ kind: "warn", text: `${p.name} is already pinned.` }));
    return;
  }
  state.excludes.delete(id);
  const seatIdx = seats.findIndex((s, i) => s.eligible.includes(p.pos) && !state.seatPins.has(i));
  if (seatIdx === -1) {
    messageHost.replaceChildren(notice({ kind: "warn", text: `No open ${posLabel(p.pos)} seat. Remove one first.` }));
    return;
  }
  commitPin(seatIdx, p);
}

function iconCell(r, pinned) {
  const isPin = pinned.has(r.id);
  const isEx = state.excludes.has(r.id);
  const pinBtn = h("button", {
    type: "button", class: "dfs-iconbtn is-pin", html: ICONS.pin, title: isPin ? "Pinned" : "Pin",
    "aria-label": `Pin ${r.name} into the roster`, "aria-pressed": isPin ? "true" : "false",
    "data-fid": `p:${r.id}`,
  });
  if (isPin) pinBtn.disabled = true;
  pinBtn.addEventListener("click", () => pinFromPool(r.id));
  const exBtn = h("button", {
    type: "button", class: "dfs-iconbtn is-ex", html: ICONS.ban, title: isEx ? "Excluded" : "Exclude",
    "aria-label": `Exclude ${r.name}`, "aria-pressed": isEx ? "true" : "false",
    "data-fid": `x:${r.id}`,
  });
  if (isEx) exBtn.disabled = true;
  exBtn.addEventListener("click", () => excludePlayer(r.id));
  return h("div", { class: "dfs-acts" }, pinBtn, exBtn);
}

// The columns, left to right. Nothing in the pool scrolls sideways: from 1100px
// every column shows; below that Pos, Team and Status fold into the name and
// the kickoff under the opponent; under 760px each row becomes a card (see
// .dfs-pool in site.css). cls drives the widths and which columns fold.
const POOL_COLUMNS = [
  { key: "_act", label: "Pin or exclude", cls: "c-act", sortable: false, hidden: true },
  { key: "name", label: "Player", cls: "c-player" },
  { key: "pos", label: "Pos", cls: "c-pos" },
  { key: "team", label: "Team", cls: "c-team" },
  { key: "opp", label: "Opp", cls: "c-opp" },
  { key: "kick", label: "Kick", cls: "c-kick" },
  { key: "salary", label: "Salary", cls: "c-sal", num: true },
  { key: "_proj", label: "Proj", cls: "c-proj", num: true },
  { key: "_pp1k", label: "Pts per $1K", cls: "c-ppk", num: true },
  { key: "status", label: "Status", cls: "c-status", sortable: false },
];

function poolRows() {
  let rows = DATA.players;
  if (state.poolPos !== "ALL") rows = rows.filter((p) => p.pos === state.poolPos);
  if (state.poolSearch) {
    const q = state.poolSearch.toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(q));
  }
  rows = rows.map((p) => {
    const proj = effectiveProj(p);
    return { ...p, _proj: proj, _pp1k: proj == null ? null : proj / (p.salary / 1000) };
  });
  return sortRows(rows, state.poolSort.key, state.poolSort.dir);
}

// The bar under Pts per $1K is scaled to the best on the whole slate, not the
// rows showing, so a bar means the same thing under every filter.
function bestPp1k() {
  let best = 0;
  for (const p of DATA.players) {
    const proj = effectiveProj(p);
    if (proj != null && p.salary > 0) best = Math.max(best, proj / (p.salary / 1000));
  }
  return best;
}

function poolRow(r, pinned, best) {
  const isPin = pinned.has(r.id);
  const isEx = state.excludes.has(r.id);
  const td = (cls, ...kids) => h("td", { class: cls }, ...kids);
  const tr = h("tr", { class: `${isPin ? "is-pinned " : ""}${isEx ? "is-excluded" : ""}`.trim() || null });
  tr.append(
    td("c-act", iconCell(r, pinned)),
    td("c-player", h("div", { class: "dfs-pcell" },
      playerImg(r, 24),
      h("div", { class: "dfs-pname" },
        h("span", { class: "dfs-pname-t" }, r.name,
          r.status ? h("span", { class: "dfs-status-sm" }, statusChip(r.status)) : null),
        // narrower than a desktop the Pos, Team and Status columns fold into
        // the name; a phone also folds in the opponent and the kickoff
        h("span", { class: "dfs-psub" },
          h("span", { class: "dfs-ps-pos" }, posLabel(r.pos)), h("span", { class: "dfs-ps-dot", "aria-hidden": "true" }, "·"),
          teamLogo(r.team, 14), h("span", { class: "dfs-ps-team" }, r.team),
          h("span", { class: "dfs-ps-game" }, ` ${oppLabel(r)}`.trimEnd(), h("span", { class: "dfs-ps-kick" }, ` · ${fmtKick(r.kick)}`)))))),
    td("c-pos", h("span", { class: "dfs-pos" }, posLabel(r.pos))),
    td("c-team", h("div", { class: "dfs-tcell" }, teamLogo(r.team, 18), h("span", {}, r.team))),
    td("c-opp", oppLabel(r), h("span", { class: "dfs-kick-sm" }, fmtKick(r.kick))),
    td("c-kick", fmtKick(r.kick)),
    td("c-sal num", fmtMoney(r.salary)),
    td("c-proj num", r._proj == null ? noProj() : fmtDec1(r._proj)),
    td("c-ppk num", r._pp1k == null ? noProj() : h("div", { class: "dfs-ppk" },
      h("span", { class: "dfs-ppk-bar", "aria-hidden": "true" },
        h("i", { style: `width:${best > 0 ? Math.max(0, Math.min(100, (r._pp1k / best) * 100)).toFixed(1) : 0}%` })),
      h("span", { class: "dfs-ppk-n" }, fmtDec1(r._pp1k)))),
    td("c-status", statusChip(r.status)));
  return tr;
}

function poolTable(rows) {
  const trh = h("tr");
  for (const col of POOL_COLUMNS) {
    const th = h("th", { scope: "col", class: `${col.cls}${col.num ? " num" : ""}` });
    if (col.sortable === false) {
      th.appendChild(col.hidden ? h("span", { class: "visually-hidden" }, col.label) : document.createTextNode(col.label));
    } else {
      const active = state.poolSort.key === col.key;
      th.appendChild(h("button", {
        type: "button", class: `th-sort${active ? " active" : ""}`,
        "data-arrow": state.poolSort.dir === "asc" ? "↑" : "↓", "data-fid": `th:${col.key}`,
        "aria-label": `Sort by ${col.label}`,
        onClick: () => sortPoolBy(col.key),
      }, col.label));
      if (active) th.setAttribute("aria-sort", state.poolSort.dir === "asc" ? "ascending" : "descending");
    }
    trh.appendChild(th);
  }
  const pinned = pinnedIdSet();
  const best = bestPp1k();
  const tbody = h("tbody");
  const frag = document.createDocumentFragment();
  for (const r of rows) frag.appendChild(poolRow(r, pinned, best));
  tbody.appendChild(frag);
  return h("div", {
    class: "table-scroll dfs-pool-scroll", role: "region", tabindex: "0", "aria-label": "Player pool",
  }, h("table", { class: "data-table" }, h("thead", {}, trh), tbody));
}

// The Sort control, for a layout with no room for every header: a select over
// the same keys as the headers (and Pos, Team and Kick, whose columns fold into
// the name), plus a direction button. A desktop sorts from the headers instead.
const SORT_DEFAULT_DIR = { name: "asc", pos: "asc", team: "asc", opp: "asc", kick: "asc" };
function syncPoolSort() {
  if (!poolSortSel) return;
  poolSortSel.value = state.poolSort.key;
  const asc = state.poolSort.dir === "asc";
  poolSortDir.textContent = asc ? "↑ Ascending" : "↓ Descending";
  poolSortDir.setAttribute("aria-label", `Sort direction: ${asc ? "ascending" : "descending"}. Switch to ${asc ? "descending" : "ascending"}`);
}

function sortPoolBy(key) {
  state.poolSort = state.poolSort.key === key
    ? { key, dir: state.poolSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" };
  refreshPool({ keepScroll: false });
}

// Redrawing replaces the whole table, so keep the reader's place: the scroll
// position (unless the rows themselves just changed order or filter) and the
// button that had focus, or the row's other button when the focused one is now
// disabled (a pinned player's Pin).
function refreshPool({ keepScroll = true } = {}) {
  const old = poolTableHost.querySelector(".dfs-pool-scroll");
  const top = old && keepScroll ? old.scrollTop : 0;
  const left = old && keepScroll ? old.scrollLeft : 0;
  const active = document.activeElement;
  const fid = active && poolTableHost.contains(active) ? active.dataset.fid : null;

  syncPoolSort();
  const rows = poolRows();
  const total = DATA.players.length;
  poolCountHost.textContent = rows.length === total ? `${total} players` : `${rows.length} of ${total} players`;
  if (!rows.length) {
    poolTableHost.replaceChildren(h("p", { class: "props-quiet dfs-pool-empty" }, "No players match."));
    return;
  }
  const scroller = poolTable(rows);
  poolTableHost.replaceChildren(scroller);
  scroller.scrollTop = top;
  scroller.scrollLeft = left;
  if (fid) {
    const same = (id) => poolTableHost.querySelector(`[data-fid="${CSS.escape(id)}"]`);
    let target = same(fid);
    if (target && target.disabled && fid.startsWith("p:")) target = same(`x:${fid.slice(2)}`);
    else if (target && target.disabled && fid.startsWith("x:")) target = same(`p:${fid.slice(2)}`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
}

function buildPoolHead() {
  const search = h("input", {
    type: "text", class: "text-input", placeholder: "Search players", "aria-label": "Search player pool",
    autocomplete: "off",
  });
  search.addEventListener("input", debounce(() => {
    state.poolSearch = search.value.trim();
    refreshPool({ keepScroll: false });
  }, 150));

  const tabs = h("div", { class: "dfs-tabs", role: "group", "aria-label": "Position" });
  ["ALL", ...(DATA.roster.positions || NFL_POSITIONS)].forEach((pos) => {
    const n = pos === "ALL" ? DATA.players.length : DATA.players.filter((p) => p.pos === pos).length;
    const btn = h("button", {
      type: "button", class: "dfs-tab", "aria-pressed": state.poolPos === pos ? "true" : "false",
    }, posLabel(pos), h("span", { class: "dfs-tab-n num" }, String(n)));
    btn.addEventListener("click", () => {
      state.poolPos = pos;
      [...tabs.children].forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
      refreshPool({ keepScroll: false });
    });
    tabs.appendChild(btn);
  });

  const sortId = uid("dfs-sort");
  const sortable = POOL_COLUMNS.filter((c) => c.sortable !== false);
  poolSortSel = h("select", { class: "select-input dfs-sort-sel", id: sortId },
    sortable.map((c) => h("option", { value: c.key }, c.label)));
  poolSortSel.addEventListener("change", () => {
    state.poolSort = { key: poolSortSel.value, dir: SORT_DEFAULT_DIR[poolSortSel.value] || "desc" };
    refreshPool({ keepScroll: false });
  });
  poolSortDir = h("button", { type: "button", class: "btn dfs-sort-dir" });
  poolSortDir.addEventListener("click", () => {
    state.poolSort = { key: state.poolSort.key, dir: state.poolSort.dir === "asc" ? "desc" : "asc" };
    refreshPool({ keepScroll: false });
  });
  const sortBox = h("div", { class: "dfs-sort" },
    h("label", { class: "dfs-lbl", for: sortId }, "Sort"), poolSortSel, poolSortDir);

  poolCountHost = h("span", { class: "dfs-ttl-sub", "aria-live": "polite" });
  return h("div", { class: "dfs-poolhead" },
    h("h2", { class: "dfs-ttl" }, "Player pool", poolCountHost),
    tabs,
    h("div", { class: "dfs-search" }, search),
    sortBox);
}

// -------------------------------------------------------------------- controls
let refreshExcludeChips = null;

function switchField(label, checked, onChange) {
  const input = h("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "switch-row" }, input,
    h("span", { class: "switch-track", "aria-hidden": "true" }),
    h("span", { class: "switch-label" }, label));
}

function smallSegmented(values, current, onChange, labelledBy) {
  const seg = h("div", { class: "segmented", role: "group", "aria-labelledby": labelledBy });
  values.forEach((v) => {
    const btn = h("button", { type: "button", class: "segmented-opt num", "aria-pressed": v === current ? "true" : "false" }, String(v));
    btn.addEventListener("click", () => {
      onChange(v);
      [...seg.children].forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
    });
    seg.appendChild(btn);
  });
  return seg;
}

const siteTeamCap = () => Number(rules().max_per_team) || 0;
const hasDstSlot = () => !!(DATA && DATA.roster && DATA.roster.slots.some((s) => s.key === "DST"));

/** A salary floor: nobody priced under it, the DST aside, unless kept by hand. */
function buildSalaryFloor() {
  const id = uid("dfs-floor");
  const input = h("input", {
    id, type: "text", inputmode: "numeric", class: "text-input dfs-floor-input", placeholder: "No minimum",
    autocomplete: "off", maxlength: "6",
  });
  if (state.salaryFloor) input.value = String(state.salaryFloor);
  const help = h("div", { class: "dfs-help", id: `${id}-help` });
  input.setAttribute("aria-describedby", `${id}-help`);
  const say = () => {
    help.textContent = state.salaryFloor
      ? `Nobody under $${state.salaryFloor.toLocaleString("en-US")}${hasDstSlot() ? `, the ${posLabel("DST")} aside` : ""}. Players you keep in the roster stay.`
      : `Leave blank for no minimum${hasDstSlot() ? `. The ${posLabel("DST")} is never limited.` : "."}`;
  };
  input.addEventListener("input", () => {
    // "$4,600" pasted reads as 4600; a zero alone is no minimum, so the box clears
    let digits = input.value.replace(/[^0-9]/g, "").replace(/^0+/, "");
    if (digits !== input.value) input.value = digits;
    const n = Number(digits);
    state.salaryFloor = digits && n > 0 ? n : null;
    say();
  });
  say();
  return h("div", { class: "dfs-ctl" },
    h("label", { class: "dfs-lbl", for: id }, "Min salary per player"),
    h("div", { class: "dfs-floor" }, h("span", { class: "dfs-floor-cur", "aria-hidden": "true" }, "$"), input),
    help);
}

function buildExcludePicker() {
  const input = h("input", {
    type: "text", class: "text-input", placeholder: "Search players", "aria-label": "Search players to exclude",
    autocomplete: "off",
  });
  const results = h("div", { class: "search-results" });
  const chips = h("div", { class: "chip-row dfs-chips" });

  function draw() {
    chips.replaceChildren(...[...state.excludes].map((id) => {
      const p = findPlayer(id);
      const rm = h("button", { type: "button", "aria-label": `Remove ${p ? p.name : id} from excludes` }, "×");
      const chip = h("span", { class: "chip" }, p ? p.name : id, rm);
      rm.addEventListener("click", () => unexcludePlayer(id));
      return chip;
    }));
  }
  const run = debounce(() => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { results.replaceChildren(); return; }
    const matches = DATA.players.filter((p) => !state.excludes.has(p.id) && p.name.toLowerCase().includes(q)).slice(0, 8);
    results.replaceChildren(...matches.map((p) => {
      const btn = h("button", { type: "button" }, h("span", { class: "sr-name" }, p.name), h("span", { class: "sr-meta" }, `${posLabel(p.pos)} · ${p.team}`));
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => { excludePlayer(p.id); input.value = ""; results.replaceChildren(); draw(); });
      return btn;
    }));
  }, 150);
  input.addEventListener("input", run);
  draw();
  refreshExcludeChips = draw;
  return h("div", { class: "dfs-ctl is-wide" }, h("div", { class: "dfs-lbl" }, "Exclude"),
    h("div", { class: "search-wrap" }, input, results), chips);
}

// Your own projections: the reading, matching and drawing live in
// projimport.js (pure) and projimport-ui.js. The page hands over its data, the
// site and a redraw, and the import keeps state.projOverride and
// state.projLeftOut in step.
function buildCsvSection() {
  return buildProjectionImport({
    data: DATA,
    site: siteKey,
    state,
    // not before the pool and roster exist (the import restores a saved file while the page mounts)
    refresh: () => { if (poolTableHost && rosterListHost) { refreshPool(); refreshRoster(); } },
  });
}

function buildControlsPanel() {
  const panel = h("section", { class: "panel dfs-build", "aria-label": "Build" },
    h("h2", { class: "dfs-ttl" }, "Build"));
  const body = h("div", { class: "dfs-build-body" });

  const lineupsId = uid("dfs-lineups");
  const overlapId = uid("dfs-overlap");
  const lineupsVal = h("span", { class: "range-value num" }, String(state.lineups));
  const lineupsSlider = h("input", {
    type: "range", id: lineupsId, min: "1", max: String(DATA.rules.max_lineups), value: String(state.lineups),
  });
  const maxOverlapVal = h("span", { class: "range-value num" }, String(state.maxOverlap));
  const maxOverlapSlider = h("input", {
    type: "range", id: overlapId, min: "3", max: "8", value: String(state.maxOverlap),
    disabled: state.lineups <= 1 ? true : null,
  });
  lineupsSlider.addEventListener("input", () => {
    state.lineups = Number(lineupsSlider.value);
    lineupsVal.textContent = lineupsSlider.value;
    maxOverlapSlider.disabled = state.lineups <= 1;
  });
  maxOverlapSlider.addEventListener("input", () => {
    state.maxOverlap = Number(maxOverlapSlider.value);
    maxOverlapVal.textContent = maxOverlapSlider.value;
  });
  body.append(
    h("div", { class: "dfs-ctl" },
      h("div", { class: "dfs-ctl-row" }, h("label", { class: "dfs-lbl", for: lineupsId }, "Lineups"), lineupsVal),
      lineupsSlider),
    h("div", { class: "dfs-ctl" },
      h("div", { class: "dfs-ctl-row" }, h("label", { class: "dfs-lbl", for: overlapId }, "Max shared between lineups"), maxOverlapVal),
      maxOverlapSlider));

  const stackId = uid("dfs-stack");
  const backId = uid("dfs-back");
  body.append(
    h("div", { class: "dfs-ctl" }, h("div", { class: "dfs-lbl", id: stackId }, "QB stack"),
      smallSegmented(rules().qb_stack || [0, 1, 2, 3], state.qbStack, (v) => { state.qbStack = v; }, stackId),
      h("div", { class: "dfs-help" }, `Pass catchers from the QB's team. Without a stack, a lineup takes at most ${TEAM_CAP} players from one team${hasDstSlot() ? `, not counting the ${posLabel("DST")}` : ""}.${siteTeamCap() ? ` ${SITE_LABELS[siteKey]} allows at most ${siteTeamCap()}, the ${posLabel("DST")} counted.` : ""}`)),
    h("div", { class: "dfs-ctl" }, h("div", { class: "dfs-lbl", id: backId }, "Bring back"),
      smallSegmented(rules().bring_back || [0, 1, 2], state.bringBack, (v) => { state.bringBack = v; }, backId),
      h("div", { class: "dfs-help" }, "Opponents when a QB is stacked.")));

  if (hasDstRule()) {
    body.append(h("div", { class: "dfs-ctl is-wide" }, switchField(`Keep my ${posLabel("DST")} away from its opponents`,
      state.blockDstOpponents, (v) => { state.blockDstOpponents = v; })));
  }

  body.append(buildSalaryFloor());
  body.append(buildExcludePicker());
  body.append(buildCsvSection());

  const optBtn = h("button", { type: "button", class: "btn btn-primary btn-block" }, "Optimize");
  const clearBtn = h("button", { type: "button", class: "btn btn-block" }, "Clear");
  optBtn.addEventListener("click", runOptimize);
  clearBtn.addEventListener("click", clearAll);
  body.append(h("div", { class: "control-actions is-wide" }, optBtn, clearBtn));

  // spaced only while it holds a message, so the panel ends at its buttons
  messageHost = h("div", { class: "dfs-message is-wide" });
  body.append(messageHost);
  panel.append(body);
  return panel;
}

/** The most players one team supplies to a lineup, beyond a QB stack's own. */
const TEAM_CAP = 2;

async function runOptimize() {
  messageHost.replaceChildren(notice({ kind: "info", text: "Solving…" }));
  let mod;
  try {
    mod = await import("../optimizer.js");
  } catch {
    messageHost.replaceChildren(errorState("The optimizer isn't available right now. Try again shortly."));
    return;
  }
  const pins = [...state.seatPins.entries()].map(([i, p]) => ({ slot: seats[i].slot, id: p.id }));
  const opts = {
    // one build, the highest-projected roster (owner 2026-09-29: "default to
    // max points. dont need a gpp option")
    risk: 0,
    lineups: state.lineups,
    maxOverlap: state.maxOverlap,
    pins,
    excludes: [...state.excludes],
    qbStack: state.qbStack,
    bringBack: state.bringBack,
    // at most two players from one team unless a QB stack asks for more
    // (owner 2026-10-01, after a build took three Rams with no stack set)
    teamCap: TEAM_CAP,
    playerSalaryFloor: state.salaryFloor || 0,
    blockDstOpponents: state.blockDstOpponents,
    projOverride: state.projOverride,
    noProj: state.projLeftOut ? [...state.projLeftOut] : [],
  };
  try {
    const result = await mod.optimize(DATA, opts);
    state.lastResult = result;
    state.activeLineup = 0;
    if (result.status !== "ok") {
      messageHost.replaceChildren(notice({ kind: result.status === "error" ? "bad" : "warn", text: result.message || "That build isn't feasible." }));
    } else if (result.message) {
      messageHost.replaceChildren(notice({ kind: "warn", text: result.message }));
    } else {
      messageHost.replaceChildren();
    }
  } catch (e) {
    messageHost.replaceChildren(errorState(`The optimizer hit an error. ${e && e.message ? e.message : e}`));
  }
  refreshRoster();
  refreshResults();
}

function clearAll() {
  state.lineups = 1;
  state.maxOverlap = 7;
  state.qbStack = 0;
  state.bringBack = 0;
  state.blockDstOpponents = hasDstRule();
  state.salaryFloor = null;
  state.excludes.clear();
  state.projOverride = {};
  state.projLeftOut = null;
  state.csvReport = null;
  clearSavedProjections(DATA, siteKey);
  state.seatPins.clear();
  state.lastResult = null;
  state.activeLineup = 0;
  state.poolSort = { key: "_proj", dir: "desc" };
  state.poolSearch = "";
  state.poolPos = "ALL";
  mount();
}

// --------------------------------------------------------------------- mount
function buildRosterPanel() {
  // a slot name longer than the NFL's four letters (CFB's SFLEX) widens the tags
  const wide = seats.some((s) => s.label.length > 4);
  lineupTabsHost = h("div", {});
  rosterActionsHost = h("div", {});
  rosterListHost = h("div", { class: wide ? "roster-list has-wide-tags" : "roster-list" });
  rosterHeadHost = h("div", { class: `roster-head${wide ? " has-wide-tags" : ""}`, "aria-hidden": "true" },
    h("span", {}), h("span", {}), h("span", { class: "rh-sal" }, "Salary"), h("span", { class: "rh-proj" }, "Proj"), h("span", {}));
  totalsHost = h("div", { class: "dfs-totals" });
  resultsHost = h("div", { class: "dfs-results" });
  return h("section", { class: "panel dfs-roster", "aria-label": "Roster" },
    h("div", { class: "dfs-roster-top" },
      h("div", { class: "dfs-cardhead" }, h("h2", { class: "dfs-ttl" }, "Roster"), rosterActionsHost),
      lineupTabsHost,
      rosterHeadHost,
      rosterListHost),
    totalsHost,
    resultsHost);
}

// The title row: DFS, the DraftKings | FanDuel switch (NFL only) and, once a
// site's data is in, its slate and contest. It stays up while the site below
// it loads, is "coming" or fails, so the other site is always one click away.
function siteSwitch() {
  const seg = h("div", { class: "segmented dfs-site", role: "group", "aria-label": "DFS site" });
  for (const key of ["dk", "fd"]) {
    const btn = h("button", {
      type: "button", class: "segmented-opt", "aria-pressed": key === siteKey ? "true" : "false",
      "data-site": key,
    }, SITE_LABELS[key]);
    btn.addEventListener("click", () => switchSite(key));
    seg.appendChild(btn);
  }
  return seg;
}

function drawHead(withMeta) {
  const kids = [h("h1", {}, "DFS")];
  if (hasFanDuel) kids.push(siteSwitch());
  if (withMeta && DATA) {
    kids.push(
      h("span", { class: "dfs-sub" }, DATA.slate.label),
      h("span", { class: "dfs-meta" }, `${DATA.roster.site} ${DATA.roster.contest} · ${fmtMoney(DATA.roster.cap)} cap`));
  }
  headHost.replaceChildren(...kids);
}

function mount() {
  drawHead(true);
  const controls = buildControlsPanel();
  const rosterPanel = buildRosterPanel();
  const grid = h("div", { class: "dfs-grid" }, controls, rosterPanel);

  const poolHead = buildPoolHead();
  poolTableHost = h("div", { class: "dfs-pool-body" });
  const poolPanel = h("section", { class: "panel dfs-pool", "aria-label": "Player pool" }, poolHead, poolTableHost);

  // a list that is not an exact match for the slate says so (FanDuel's full week list)
  const note = DATA.slate && DATA.slate.note ? h("p", { class: "dfs-help dfs-slate-note" }, DATA.slate.note) : null;
  bodyHost.replaceChildren(...[note, grid, poolPanel].filter(Boolean));

  refreshRoster();
  refreshResults();
  refreshPool();
}

// Settings that mean the same on either site stay; everything tied to one
// site's players (picks, excludes, projections, the result, the pool view) goes.
function resetForSite() {
  state.excludes.clear();
  state.projOverride = {};
  state.projLeftOut = null;
  state.csvReport = null;
  state.seatPins.clear();
  state.lastResult = null;
  state.activeLineup = 0;
  state.poolSort = { key: "_proj", dir: "desc" };
  state.poolSearch = "";
  state.poolPos = "ALL";
}

async function loadSite(site) {
  const sport = currentSport();
  const token = ++loadToken;
  siteKey = site;
  const fanduel = site === "fd";
  let data;
  try {
    data = await fetchJSON(`data/${sport}/${SITE_FILES[site]}.json`);
  } catch (e) {
    if (token !== loadToken) return;
    DATA = null;
    drawHead(false);
    bodyHost.replaceChildren(fanduel && e.status === 404 ? comingState(fdComingText())
      : e.status === 404 ? missingState(sport, "dfs") : errorState(e.message));
    return;
  }
  if (token !== loadToken) return;     // the visitor already switched again
  if (data.status === "pending" || data.status === "coming") {
    DATA = null;
    drawHead(false);
    bodyHost.replaceChildren(comingState(data.message || (fanduel ? fdComingText() : getComingText(sport, "dfs"))));
    return;
  }
  if (data.status === "error") {
    DATA = null;
    drawHead(false);
    bodyHost.replaceChildren(errorState(data.error || "Something went wrong building this page."));
    return;
  }
  DATA = data;
  seats = expandSeats(DATA.roster);
  state.blockDstOpponents = state.blockDstOpponents && hasDstRule();
  setFooterSources(DATA.sources);
  mount();
}

function switchSite(site) {
  if (site === siteKey || !hasFanDuel) return;
  resetForSite();
  writeSiteHash(site);
  siteKey = site;
  drawHead(false);
  bodyHost.replaceChildren();          // nothing of the other site's pool lingers while this one loads
  loadSite(site);
}

async function render() {
  const app = document.getElementById("app");
  const sport = currentSport();

  // a sport still marked "coming" has no data folder, so there is nothing to ask for
  if (manifestStatus(sport, "dfs") === "coming") {
    app.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, "DFS")),
      comingState(getComingText(sport, "dfs")));
    return;
  }

  // FanDuel is an NFL contest only; a link with #site=fd on another sport is ignored
  hasFanDuel = sport === "nfl";
  siteKey = hasFanDuel ? siteFromHash() : "dk";
  headHost = h("div", { class: "dfs-head" });
  bodyHost = h("div", { class: "dfs-body" });
  app.replaceChildren(h("div", { class: "dfs" }, headHost, bodyHost));
  drawHead(false);
  if (hasFanDuel) {
    // a hand edited or followed link (#site=fd) switches the page in place
    window.addEventListener("hashchange", () => {
      const next = siteFromHash();
      if (next !== siteKey) switchSite(next);
    });
  }
  await loadSite(siteKey);
}

render();
