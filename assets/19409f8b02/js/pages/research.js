// Research: index + per season/window view files, tabs of filterable tables.
// Laid out like the Prop Lab (redesign 2026-09-30): a header with the view's
// meta inline, underline tabs, one row of compact controls, then dense tables
// that run with the page under a sticky header row, so the page keeps the only
// scroll bar (owner 2026-10-03); a table too wide for its box is drawn as
// cards instead, so nothing scrolls sideways (fitTable). A player shows his
// photo and a team its logo where the data has them (initials and the bare
// abbreviation where it doesn't); share columns carry a small in-cell bar;
// the defense table colors each rank the way the Prop Lab does.
import {
  h, fetchJSON, currentSport, comingState, errorState, missingState, notice, sortRows,
  renderTable, getComingText, setFooterSources, formatByType, manifestStatus,
} from "../app.js";

const sel = { season: null, window: null, tab: null };
// each tab's filters survive a season or window change
const saved = {};
let TEAMS = {};

// ---------------------------------------------------------------- images
// A logo or photo that fails to load (or isn't in the data) degrades to
// initials or an empty disc, never a broken image.
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function isUrl(u) {
  return typeof u === "string" && u.startsWith("https://");
}

function sized(size) {
  return `width:${size}px;height:${size}px`;
}

// The NFL's headshot links serve the full 3400px photo; its image host
// resizes on request, so ask for the size drawn, twice over for a sharp
// screen (the Prop Lab does the same). A link it won't resize falls back to
// the original, then to initials.
function sizedHeadshot(url, size) {
  const m = /^(https:\/\/static\.www\.nfl\.com\/image\/upload\/)f_auto,q_auto(\/.+)$/.exec(url || "");
  return m ? `${m[1]}f_auto,q_auto,w_${size * 2},h_${size * 2},c_fill,g_face${m[2]}` : url;
}

function avatar(url, name, size) {
  const fallback = () => h("span", { class: "rs-avatar is-fallback", style: sized(size), "aria-hidden": "true" }, initials(name));
  if (!isUrl(url)) return fallback();
  const img = h("img", {
    src: sizedHeadshot(url, size), alt: "", width: size, height: size, class: "rs-avatar",
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    else img.replaceWith(fallback());
  });
  return img;
}

function logo(url, size) {
  const fallback = () => h("span", { class: "rs-logo is-fallback", style: sized(size), "aria-hidden": "true" });
  if (!isUrl(url)) return fallback();
  const img = h("img", {
    src: url, alt: "", width: size, height: size, class: "rs-logo",
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

// ---------------------------------------------------------------- cells
function whoCell(row) {
  return h("span", { class: "rs-who" },
    avatar(row.headshot, row.player, 24),
    h("span", { class: "rs-name" }, row.player == null ? "N/A" : row.player));
}

function teamCell(abbr, strong) {
  if (abbr == null || abbr === "") return "N/A";
  const t = TEAMS[abbr] || {};
  return h("span", { class: `rs-team${strong ? " is-strong" : ""}`, title: t.name || null },
    logo(t.logo, 18), h("span", {}, abbr));
}

// A bar's width in percent of its track: `value` of `top` fills `full` percent.
// A real value never draws thinner than a sliver; a zero draws nothing.
function barWidth(value, top, full) {
  if (!(top > 0) || !(value > 0)) return 0;
  return Math.max(3, Math.min(full, (value / top) * full));
}

// A share or rate: its number with a bar from zero to the column's top value.
function barCell(value, top, text) {
  if (value == null || !Number.isFinite(Number(value))) return h("span", { class: "rs-none" }, "N/A");
  const w = barWidth(Number(value), top, 100);
  return h("span", { class: "rs-barcell" },
    h("span", { class: "rs-track", "aria-hidden": "true" }, h("span", { class: "rs-fill", style: `width:${w.toFixed(1)}%` })),
    h("span", { class: "rs-val" }, text));
}

// Rank colors, the Prop Lab's (owner 2026-09-27: "green it helps the player in
// question. yellow is neutral, red is bad"). The exporter decides the tone:
// 1 helps the player, 0 is the middle third, -1 hurts him.
const TONES = {
  1: { cls: "is-help", label: "helps the player" },
  0: { cls: "is-even", label: "neutral" },
  [-1]: { cls: "is-hurt", label: "hurts the player" },
};

// A signed number with a bar that leans right for plus and left for minus,
// from the middle. Colored by rank tone where the row has one (the defense
// table), plain otherwise: a regression gap isn't good or bad news.
function divCell(value, top, text, row) {
  if (value == null || !Number.isFinite(Number(value))) return h("span", { class: "rs-none" }, "N/A");
  const v = Number(value);
  const tone = row && row.tone != null ? TONES[row.tone] : null;
  // a number that prints as zero has no sign and no bar ("-0.0" is just "0.0")
  const zero = Number(text) === 0;
  if (zero) text = text.replace(/^[-+]/, "");
  const w = zero ? 0 : barWidth(Math.abs(v), top, 50);
  const side = v >= 0 ? "is-plus" : "is-minus";
  return h("span", { class: "rs-barcell" },
    h("span", { class: "rs-track is-div", "aria-hidden": "true" },
      h("span", { class: `rs-fill ${side}${tone ? ` ${tone.cls}` : ""}`, style: `width:${w.toFixed(1)}%` })),
    h("span", { class: "rs-val" }, text));
}

function rankCell(row) {
  if (row.rank == null || !row.phrase) return h("span", { class: "rs-none" }, "N/A");
  const tone = TONES[row.tone];
  return h("span", { class: `rs-rank${tone ? ` ${tone.cls}` : ""}`, title: `Rank ${row.rank}` },
    row.phrase, tone ? h("span", { class: "visually-hidden" }, `, ${tone.label}`) : null);
}

// A column's cell, picked by its key and type. The tops the bars scale to come
// from the rows on show (before the row limit), so a bar means "of the column's
// largest value here".
function buildColumns(defs, rows) {
  const top = (key, abs) => rows.reduce((m, r) => {
    const v = Number(r[key]);
    return r[key] == null || !Number.isFinite(v) ? m : Math.max(m, abs ? Math.abs(v) : v);
  }, 0);
  return defs.map((c) => {
    const col = { ...c };
    if (c.key === "player") {
      col.align = "left";
      col.render = whoCell;
    } else if (c.key === "team" || c.key === "defense") {
      col.align = "left";
      col.render = (r) => teamCell(r[c.key], !("player" in r));
    } else if (c.key === "pos") {
      col.align = "left";
      col.render = (r) => (r.pos == null ? "N/A" : h("span", { class: "rs-pos" }, r.pos));
    } else if (c.key === "rank") {
      col.align = "right";
      col.render = rankCell;
    } else if (c.type === "pct1") {
      const t = top(c.key, false);
      col.render = (r) => barCell(r[c.key], t, formatByType(r[c.key], c.type));
    } else if (c.type === "signed1") {
      const t = top(c.key, true);
      col.render = (r) => divCell(r[c.key], t, formatByType(r[c.key], c.type), r);
    }
    return col;
  });
}

// ---------------------------------------------------------------- controls
function segmented(label, options, isPressed, onPick) {
  const seg = h("div", { class: "segmented", role: "group", "aria-label": label });
  options.forEach((o) => {
    const btn = h("button", {
      type: "button", class: "segmented-opt", "aria-pressed": isPressed(o.value) ? "true" : "false",
    }, o.label);
    btn.addEventListener("click", () => onPick(o.value, btn, seg));
    seg.appendChild(btn);
  });
  return seg;
}

function ctl(label, ...body) {
  return h("div", { class: "rs-ctl" }, h("span", { class: "rs-ctl-l" }, label), ...body);
}

function renderControls(indexData, onChange) {
  const seasonCtl = indexData.controls.find((c) => c.key === "season");
  const windowCtl = indexData.controls.find((c) => c.key === "window");
  const single = (ctlDef, key) => segmented(
    ctlDef.label, ctlDef.options, (v) => v === sel[key],
    (v, btn, seg) => {
      sel[key] = v;
      [...seg.children].forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
      onChange();
    });
  return [ctl(seasonCtl.label, single(seasonCtl, "season")), ctl(windowCtl.label, single(windowCtl, "window"))];
}

// One tab's own filters, as controls in the same row. Returns the controls and
// the help lines (a slider's explanation sits under the row).
function renderFilters(defs, filterState, onChange) {
  const controls = [], help = [];
  for (const fd of defs) {
    if (fd.type === "multi") {
      const seg = segmented(fd.label, fd.options.map((o) => ({ value: o, label: o })),
        (v) => filterState[fd.key].includes(v),
        (v, btn) => {
          const arr = filterState[fd.key];
          const i = arr.indexOf(v);
          if (i >= 0) arr.splice(i, 1); else arr.push(v);
          btn.setAttribute("aria-pressed", arr.includes(v) ? "true" : "false");
          onChange();
        });
      controls.push(ctl(fd.label, seg));
    } else if (fd.type === "select") {
      const seg = segmented(fd.label, fd.options.map((o) => ({ value: o, label: o })),
        (v) => filterState[fd.key] === v,
        (v, btn, group) => {
          filterState[fd.key] = v;
          [...group.children].forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
          onChange();
        });
      controls.push(ctl(fd.label, seg));
    } else if (fd.type === "min") {
      const id = `rs-min-${fd.key}`;
      const valSpan = h("output", { class: "rs-range-v num", for: id }, String(filterState[fd.key]));
      const slider = h("input", {
        type: "range", id, class: "rs-range", min: String(fd.min), max: String(fd.max), step: String(fd.step || 1),
        value: String(filterState[fd.key]),
      });
      slider.addEventListener("input", () => {
        filterState[fd.key] = Number(slider.value);
        valSpan.textContent = slider.value;
        onChange();
      });
      controls.push(h("div", { class: "rs-ctl" },
        h("label", { class: "rs-ctl-l", for: id }, fd.label),
        h("span", { class: "rs-range-row" }, slider, valSpan)));
      if (fd.help) help.push(h("p", { class: "rs-help" }, fd.help));
    }
  }
  return { controls, help };
}

function applyFilters(rows, filterDefs, filterState) {
  let out = rows;
  for (const fd of filterDefs) {
    const val = filterState[fd.key];
    if (val === undefined) continue;
    if (fd.type === "multi") out = out.filter((r) => !(fd.key in r) || val.includes(r[fd.key]));
    else if (fd.type === "select") out = out.filter((r) => !(fd.key in r) || r[fd.key] === val);
    else if (fd.type === "min") out = out.filter((r) => !(fd.key in r) || Number(r[fd.key]) >= Number(val));
  }
  return out;
}

// A filter's remembered value if it still fits this tab's options, else its default.
function filterStateFor(tab) {
  const prev = saved[tab.key] || {};
  const state = {};
  for (const fd of tab.filters || []) {
    const old = prev[fd.key];
    const def = Array.isArray(fd.default) ? [...fd.default] : fd.default;
    if (fd.type === "multi") {
      state[fd.key] = Array.isArray(old) ? old.filter((o) => fd.options.includes(o)) : def;
    } else if (fd.type === "select") {
      state[fd.key] = fd.options.includes(old) ? old : def;
    } else if (fd.type === "min") {
      state[fd.key] = Number.isFinite(old) && old >= fd.min && old <= fd.max ? old : def;
    } else {
      state[fd.key] = def;
    }
  }
  saved[tab.key] = state;
  return state;
}

// ---------------------------------------------------------------- fit
// A table that fits its box stays a table; one that doesn't is drawn as a
// list of cards (.is-cards on its side), so nothing on the page scrolls
// sideways and the page keeps the only scroll bar (owner 2026-10-03: "Can we
// just have one scroll bar situation?", then "fix the research tables too").
// Decided by the table's own narrowest layout against the box, so a long
// name or a new column can't push it past the edge, at any screen width.
// The box is as wide in both modes (cards keep its border, transparent), and
// a table drawn as cards comes back only with FIT_SLACK pixels to spare: the
// switch changes the page's height, which can bring or take away the page's
// scroll bar and with it ~15px of width, and without the slack a table right
// at the edge flipped back and forth every frame (Fable 10/04).
const FIT_SLACK = 24;
const fitWidths = new WeakMap();
const live = new Set();                      // the boxes on the page now
const fitObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => { for (const e of entries) fitTable(e.target); })
  : null;

function fitTable(box) {
  const table = box.querySelector("table");
  const side = box.closest(".rs-side");
  const w = box.clientWidth;
  if (!table || !side || !box.isConnected || !w) return;
  if (fitWidths.get(box) === w) return;      // cards are taller: only a new width counts
  fitWidths.set(box, w);
  side.classList.remove("is-cards");
  const old = table.style.width;
  table.style.width = "min-content";
  const need = table.getBoundingClientRect().width;
  table.style.width = old;
  const slack = side.dataset.fits === "0" ? FIT_SLACK : 0;
  side.dataset.fits = need > w - slack + 0.5 ? "0" : "1";
  // two tables side by side change together, never one table beside one card list
  const pair = side.closest(".rs-pair");
  const group = pair ? [...pair.querySelectorAll(".rs-side")] : [side];
  const cards = group.some((s) => s.dataset.fits === "0");
  group.forEach((s) => s.classList.toggle("is-cards", cards));
}

function track(box) {
  live.add(box);
  if (fitObserver) fitObserver.observe(box);
}

// The web fonts land after the first fit (display=swap) and widen the text a
// little, which can push a table that just fit past its box; fit again then.
function refitAll() {
  for (const box of live) {
    if (!box.isConnected) { live.delete(box); continue; }
    fitWidths.delete(box);
    fitTable(box);
  }
}
if (document.fonts) {
  document.fonts.ready.then(refitAll);
  document.fonts.addEventListener("loadingdone", refitAll);
}

// Cards have no header row to click, so a card list gets a Sort control.
let sortSeq = 0;
function sortBar(columns, sort, index, onPick) {
  const id = `rs-sort-${++sortSeq}`;
  const sel = h("select", { class: "select-input rs-sort-sel", id, "data-ctl": `sort-${index}` },
    columns.filter((c) => c.sortable !== false).map((c) => h("option", { value: c.key }, c.label)));
  sel.value = sort.key;
  sel.addEventListener("change", () => onPick({ key: sel.value, dir: "desc" }));
  const asc = sort.dir === "asc";
  const dir = h("button", { type: "button", class: "btn rs-sort-dir", "data-ctl": `dir-${index}` },
    asc ? "\u2191 Ascending" : "\u2193 Descending");
  dir.addEventListener("click", () => onPick({ key: sort.key, dir: asc ? "desc" : "asc" }));
  return h("div", { class: "rs-sortbar" }, h("label", { class: "rs-ctl-l", for: id }, "Sort"), sel, dir);
}

// A redraw rebuilds the tables; the control that had the focus gets it back.
function focusKey(root) {
  const a = document.activeElement;
  if (!a || a === document.body || !root.contains(a)) return null;
  const side = a.closest(".rs-side");
  return { side: side ? side.dataset.side : null, ctl: a.dataset.ctl || null, label: a.getAttribute("aria-label") };
}

function restoreFocus(root, k) {
  if (!k || k.side == null) return;
  const side = root.querySelector(`.rs-side[data-side="${k.side}"]`);
  if (!side) return;
  let el = k.ctl ? side.querySelector(`[data-ctl="${k.ctl}"]`)
    : k.label ? [...side.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label") === k.label)
      : null;
  // the redraw switched the side between table and cards: the control it had
  // is hidden now, so the sort control of the layout on show takes the focus
  if (!el || el.offsetParent === null) {
    el = side.classList.contains("is-cards") ? side.querySelector('[data-ctl^="sort-"]')
      : side.querySelector("thead .th-sort.active") || side.querySelector("thead .th-sort");
  }
  if (el) el.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- tables
// "Running hot: more TDs than his volume predicts" reads as a title and a
// quiet line after it, the way the Prop Lab sets its section titles.
function sectionTitle(text, tag = "h3") {
  const cut = String(text).indexOf(": ");
  return h(tag, { class: "rs-ttl" }, cut < 0 ? text : [
    text.slice(0, cut), h("span", { class: "rs-ttl-sub" }, text.slice(cut + 2))]);
}

function toneLegend() {
  return h("ul", { class: "rs-legend", "aria-label": "Rank colors" },
    h("li", {}, h("span", { class: "rs-key is-help", "aria-hidden": "true" }), "Gives up more than most: helps the player"),
    h("li", {}, h("span", { class: "rs-key is-even", "aria-hidden": "true" }), "Middle third"),
    h("li", {}, h("span", { class: "rs-key is-hurt", "aria-hidden": "true" }), "Gives up less than most: hurts the player"));
}

function renderBlock(block, tab, filterDefs, filterState) {
  const wrap = h("section", { class: "rs-block" });
  if (block.title) wrap.appendChild(sectionTitle(block.title, "h3"));
  if (block.caption) wrap.appendChild(h("p", { class: "rs-cap" }, block.caption));
  const sides = block.pair ? block.pair : [{ table: block.table }];
  if (sides.some((s) => (s.table.rows[0] || {}).tone != null)) wrap.appendChild(toneLegend());
  const body = h("div", {});
  wrap.appendChild(body);

  const sideState = sides.map((side) => ({ side, sort: { ...side.table.sort } }));
  const observed = [];

  function computeSide(ss) {
    const all = sortRows(applyFilters(ss.side.table.rows, filterDefs, filterState), ss.sort.key, ss.sort.dir);
    const limit = ss.side.table.limit;
    return { all, rows: limit ? all.slice(0, limit) : all };
  }

  function redraw() {
    const computed = sideState.map((ss) => ({ ss, ...computeSide(ss) }));
    const total = computed.reduce((n, c) => n + c.rows.length, 0);
    const focus = focusKey(body);
    observed.splice(0).forEach((box) => { live.delete(box); if (fitObserver) fitObserver.unobserve(box); });
    if (total === 0 && block.empty) {
      body.replaceChildren(h("p", { class: "props-quiet" }, block.empty));
      return;
    }
    const hosts = computed.map(({ ss, all, rows }, i) => {
      const host = h("div", { class: "rs-side", "data-side": String(i) });
      if (ss.side.title) host.appendChild(sectionTitle(ss.side.title, "h4"));
      const columns = buildColumns(ss.side.table.columns, all);
      if (rows.length) {
        host.appendChild(sortBar(columns, ss.sort, i, (next) => { ss.sort = next; redraw(); }));
      }
      const tableHost = h("div", {});
      host.appendChild(tableHost);
      renderTable(tableHost, {
        columns, rows, sortKey: ss.sort.key, sortDir: ss.sort.dir,
        onSort(key) {
          ss.sort = ss.sort.key === key ? { key, dir: ss.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" };
          redraw();
        },
        emptyText: "No rows match these filters.",
      });
      const table = tableHost.querySelector("table");
      if (table) {
        table.setAttribute("aria-label", ss.side.title || block.title || tab.label);
        const at = columns.findIndex((c) => c.key === ss.sort.key);
        if (at >= 0) table.querySelectorAll("tr").forEach((tr) => tr.children[at] && tr.children[at].classList.add("is-sorted"));
      }
      if (all.length > rows.length) {
        host.appendChild(h("p", { class: "rs-count" }, `Showing ${rows.length} of ${all.length}. Change the sort to see the rest.`));
      }
      return host;
    });
    body.replaceChildren(block.pair ? h("div", { class: "rs-pair" }, hosts) : hosts[0]);
    for (const host of hosts) {
      const box = host.querySelector(".table-scroll");
      if (!box) continue;
      fitTable(box);                       // a no-op until the block is on the page
      track(box);
      observed.push(box);
    }
    restoreFocus(body, focus);
  }
  redraw();
  // the page calls this once the block is in the document, so the first
  // layout already has each table's final shape (no table-then-cards shift)
  const fit = () => observed.forEach(fitTable);
  return { el: wrap, redraw, fit };
}

// ---------------------------------------------------------------- page
function renderTabs(tabs, current, onPick) {
  const row = h("div", { class: "rs-tabs", role: "tablist", "aria-label": "Research views" });
  const btns = tabs.map((t) => {
    const on = t.key === current;
    const btn = h("button", {
      type: "button", class: "rs-tab", role: "tab", id: `rs-tab-${t.key}`, "aria-controls": "rs-panel",
      "aria-selected": on ? "true" : "false", tabindex: on ? "0" : "-1",
    }, t.label);
    // the row is redrawn on every pick, so the new button takes the focus
    // (a click used to drop it to the page)
    btn.addEventListener("click", () => onPick(t.key, true));
    return btn;
  });
  // arrow keys move between tabs, as a tablist does
  row.addEventListener("keydown", (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: (i + 1) % btns.length, ArrowLeft: (i - 1 + btns.length) % btns.length, Home: 0, End: btns.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onPick(tabs[to].key, true);
  });
  row.append(...btns);
  return row;
}

async function render() {
  const app = document.getElementById("app");
  const sport = currentSport();
  const meta = h("p", { class: "sub" });
  const intro = h("p", { class: "rs-intro" });
  const head = h("div", { class: "rs-head" }, h("h1", {}, "Research"), meta, intro);
  const root = h("div", { class: "research" }, head);
  app.replaceChildren(root);

  // a sport still marked "coming" has no data folder, so there is nothing to ask for
  if (manifestStatus(sport, "research") === "coming") {
    root.appendChild(comingState(getComingText(sport, "research")));
    return;
  }

  // Nothing below the heading is shown until the first table is ready: the
  // tabs, controls and caption used to appear in steps and push the table
  // down as each landed ("poor" layout shift, 2026-10-03)
  const wait = h("p", { class: "props-quiet" }, "Loading.");
  root.appendChild(wait);
  let indexData;
  try {
    indexData = await fetchJSON(`data/${sport}/research.json`);
  } catch (e) {
    wait.replaceWith(e.status === 404 ? missingState(sport, "research") : errorState(e.message));
    return;
  }
  if (!indexData || typeof indexData !== "object") {
    wait.replaceWith(errorState("This page's data isn't in the shape it should be. Please try again later."));
    return;
  }
  if (indexData.status === "pending" || indexData.status === "coming") {
    wait.replaceWith(comingState(indexData.message || getComingText(sport, "research")));
    return;
  }

  setFooterSources(indexData.sources);
  TEAMS = indexData.teams && typeof indexData.teams === "object" ? indexData.teams : {};

  // a data file of an unexpected shape shows an error, not a blank page
  const controls = Array.isArray(indexData.controls) ? indexData.controls : [];
  const seasonCtl = controls.find((c) => c.key === "season");
  const windowCtl = controls.find((c) => c.key === "window");
  if (!seasonCtl || !windowCtl || !indexData.views) {
    wait.replaceWith(errorState("This page's data isn't in the shape it should be. Please try again later."));
    return;
  }
  sel.season = seasonCtl.default;
  sel.window = windowCtl.default;

  const tabsHost = h("div", {});
  const filtersHost = h("div", { class: "rs-filters" });
  const bar = h("div", { class: "rs-bar", role: "group", "aria-label": "Table controls" });
  const helpHost = h("div", {});
  const panel = h("div", { class: "rs-panel", id: "rs-panel", role: "tabpanel", tabindex: "-1" });
  let view = null;
  let blocks = [];

  function drawTab(focusTab) {
    const tab = view.tabs.find((t) => t.key === sel.tab) || view.tabs[0];
    // the last tab's tables are gone: stop watching them
    if (fitObserver) fitObserver.disconnect();
    live.clear();
    sel.tab = tab.key;
    // the strip is redrawn, so focus that was on it moves to the new selected
    // tab (also when a view lands while a tab has focus), and on a phone strip
    // that scrolls sideways the tab is brought fully into view
    const keep = focusTab || tabsHost.contains(document.activeElement);
    tabsHost.replaceChildren(renderTabs(view.tabs, tab.key, (key, focus) => {
      sel.tab = key;
      drawTab(focus);
    }));
    panel.setAttribute("aria-labelledby", `rs-tab-${tab.key}`);
    if (keep) {
      const on = tabsHost.querySelector('[aria-selected="true"]');
      on.focus();
      on.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    const filterDefs = tab.filters || [];
    const filterState = filterStateFor(tab);
    blocks = (tab.blocks || []).map((b) => renderBlock(b, tab, filterDefs, filterState));
    const f = renderFilters(filterDefs, filterState, () => blocks.forEach((b) => b.redraw()));
    filtersHost.replaceChildren(...f.controls);
    helpHost.replaceChildren(...f.help);
    panel.replaceChildren(...[
      tab.notice ? notice(tab.notice) : null,
      tab.intro ? h("p", { class: "rs-cap" }, tab.intro) : null,
      ...blocks.map((b) => b.el)].filter(Boolean));
    blocks.forEach((b) => b.fit());        // no-op until the panel is on the page
  }

  let shown = false;
  let latest = 0;
  async function loadAndRenderView() {
    // only the newest request may draw: two quick clicks (a season, then a
    // window) start two fetches, and the slower, older one used to land last
    // and show a view the pressed buttons didn't ask for
    const mine = ++latest;
    // a season or window change keeps the panel's height while the next view
    // loads, so the page doesn't collapse and spring back
    if (shown) panel.style.minHeight = `${panel.offsetHeight}px`;
    panel.replaceChildren(h("p", { class: "props-quiet" }, "Loading."));
    const rel = indexData.views[`${sel.season}/${sel.window}`];
    let next = null, err = null;
    try {
      next = await fetchJSON(`data/${sport}/${rel}`);
    } catch (e) {
      err = e;
    }
    if (mine !== latest) return;          // a newer click owns the panel now
    try {
      if (err) throw err;
      view = next;
      meta.textContent = view.caption || "";
      drawTab(false);
    } catch (e) {
      // the last view's tabs and filters go too: left live, a tab click
      // redrew the old view's numbers under the new season and window
      meta.textContent = "";
      view = null;
      tabsHost.replaceChildren();
      filtersHost.replaceChildren();
      helpHost.replaceChildren();
      panel.removeAttribute("aria-labelledby");
      panel.replaceChildren(errorState(`Couldn't load this view. ${e.message}`));
    }
    panel.style.minHeight = "";
    if (!shown) {
      shown = true;
      wait.remove();
      intro.textContent = indexData.intro || "";
      root.append(tabsHost, bar, helpHost, panel);
      blocks.forEach((b) => b.fit());      // the first view: fit before the first paint
    }
  }

  bar.append(...renderControls(indexData, loadAndRenderView), filtersHost);
  await loadAndRenderView();
}

render();
