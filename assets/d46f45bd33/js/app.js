// Shared helpers for every SharpSlate page module: a tiny DOM builder, data
// fetching relative to the page's root, formatters, a sortable table
// renderer, and the small set of "nothing to show" states every section
// needs (notice / empty / coming / error). Every page module imports this.

export { fmtAmerican } from "./oddsmath.js";

// ---------------------------------------------------------------- DOM
// h("div", {class:"x", onClick(){...}}, "text", childNode, [moreChildren])
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "dataset") {
      Object.assign(el.dataset, v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

let _fieldUid = 0;
/** A <label for> + control + optional help line, wired to a stable id. */
export function labeledField(labelText, inputEl, helpText) {
  const id = inputEl.id || `f-${++_fieldUid}`;
  inputEl.id = id;
  return h("div", { class: "field" },
    h("label", { class: "field-label", for: id }, labelText),
    inputEl,
    helpText ? h("div", { class: "field-help" }, helpText) : null);
}

// ---------------------------------------------------------------- context
export function root() {
  return document.body.dataset.root || "";
}

export function currentSport() {
  return document.body.dataset.sport || null;
}

export function currentSection() {
  return document.body.dataset.section || null;
}

const _cache = {};
function readEmbedded(id) {
  if (id in _cache) return _cache[id];
  const tag = document.getElementById(id);
  let v = null;
  try {
    v = tag ? JSON.parse(tag.textContent) : null;
  } catch {
    v = null;
  }
  _cache[id] = v;
  return v;
}

export function getManifest() {
  return readEmbedded("manifest-data");
}

/** [{key,label,name}] in nav order, e.g. {key:"nfl",label:"NFL",name:"Pro football"}. */
export function getSports() {
  return readEmbedded("sports-data") || [];
}

/** [{key,label}] in nav order, e.g. {key:"prop-lab",label:"Prop Lab"}. */
export function getSections() {
  return readEmbedded("sections-data") || [];
}

/** {sportKey: sentence} shown when a sport/section has no data yet. */
export function getComing() {
  return readEmbedded("coming-data") || {};
}

/** The "coming" sentence for one sport/section, falling back to the sport's
 * general line (composite "sport/section" keys win when present). */
export function getComingText(sport, section) {
  const c = getComing();
  return c[`${sport}/${section}`] || c[sport] || "This section is being added.";
}

/** Status the manifest recorded for sport/section, e.g. "live" | "coming". */
export function manifestStatus(sport, section) {
  const m = getManifest();
  return m && m.sports && m.sports[sport] && m.sports[sport][section]
    ? m.sports[sport][section].status
    : null;
}

// ---------------------------------------------------------------- fetch
export async function fetchJSON(path) {
  const man = getManifest();
  const v = (man && man.updated) || document.body.dataset.updated || "";
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${root()}${path}${sep}v=${encodeURIComponent(v)}`);
  if (!res.ok) {
    const err = new Error(`Request for ${path} failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------- formatters
export function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "N/A";
  return Math.round(Number(n)).toLocaleString("en-US");
}

export function fmtDec1(n) {
  if (n == null || !Number.isFinite(Number(n))) return "N/A";
  return Number(n).toFixed(1);
}

export function fmtPercent(n, places = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "N/A";
  return `${(Number(n) * 100).toFixed(places)}%`;
}

export function fmtSigned(n, places = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "N/A";
  const v = Number(n);
  const s = v.toFixed(places);
  return v >= 0 ? `+${s}` : s;
}

export function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return "N/A";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
});
const ET_WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short",
});

/** "Sun 1:00 PM" in America/New_York from an ISO timestamp. */
export function fmtKick(iso) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBD";
  return `${ET_WEEKDAY.format(d)} ${ET_TIME.format(d)}`;
}

const ET_YMD = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const ET_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric",
});
const DAY_MS = 864e5;

/** "Updated 10:49 PM ET" today (ET), "Updated Sun 10:49 PM ET" within the
 *  week, "Updated Sep 27" after that: a page the site hasn't republished
 *  never passes an old stamp off as today's (Fable audit 2026-09-27). */
export function fmtUpdatedAt(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "Updated recently";
  if (now - d > 6 * DAY_MS) return `Updated ${ET_DATE.format(d)}`;
  if (ET_YMD.format(d) !== ET_YMD.format(now)) {
    return `Updated ${ET_WEEKDAY.format(d)} ${ET_TIME.format(d)} ET`;
  }
  return `Updated ${ET_TIME.format(d)} ET`;
}

export function formatByType(value, type) {
  switch (type) {
    case "int": return fmtInt(value);
    case "dec1": return fmtDec1(value);
    case "pct1": return fmtPercent(value, 1);
    case "signed1": return fmtSigned(value, 1);
    case "text":
    default: return value == null ? "N/A" : String(value);
  }
}

function initUpdatedStamp() {
  const el = document.getElementById("updated-stamp");
  if (!el) return;
  const dot = el.querySelector(".dot-live");
  const iso = (getManifest() || {}).updated || document.body.dataset.updated;
  el.replaceChildren();
  if (dot) el.appendChild(dot);
  el.appendChild(document.createTextNode(fmtUpdatedAt(iso)));
  // the green dot means fresh: a day without a publish greys it
  const age = Date.now() - new Date(iso).getTime();
  el.classList.toggle("is-stale", !(age < DAY_MS));
}
initUpdatedStamp();

// On phones the sport/section nav rows scroll horizontally; make sure the
// active pill/tab is actually in view instead of possibly scrolled off.
for (const sel of [".sport-pill.active", '.tab[aria-selected="true"]']) {
  const el = document.querySelector(sel);
  if (el) el.scrollIntoView({ inline: "center", block: "nearest" });
}

export function setFooterSources(list) {
  const el = document.getElementById("footer-sources");
  if (!el) return;
  el.textContent = list && list.length ? `Sources: ${list.join(", ")}.` : "";
}

// ---------------------------------------------------------------- misc
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.'`]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- sorting
export function sortRows(rows, key, dir = "desc") {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    const an = av == null || av === "", bn = bv == null || bv === "";
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}

// ---------------------------------------------------------------- table
/**
 * columns: [{key, label, type, sortable, render(row) -> string|Node, align}]
 * onSort(key): called on header click; caller owns sort state and re-renders.
 */
export function renderTable(container, { columns, rows, sortKey, sortDir = "desc", onSort, emptyText }) {
  if (!rows.length) {
    container.replaceChildren(h("p", { class: "props-quiet" }, emptyText || "No rows match these filters."));
    return;
  }
  const isNum = (col) => col.align ? col.align === "right" : !!(col.type && col.type !== "text");
  const trh = h("tr");
  for (const col of columns) {
    const th = h("th", { class: isNum(col) ? "num" : "", scope: "col" });
    if (onSort && col.sortable !== false) {
      const active = sortKey === col.key;
      th.appendChild(h("button", {
        type: "button",
        class: `th-sort${active ? " active" : ""}`,
        "data-arrow": sortDir === "asc" ? "↑" : "↓",
        "aria-label": `Sort by ${col.label}`,
        onClick: () => onSort(col.key),
      }, col.label));
      if (active) th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
    } else {
      th.textContent = col.label;
    }
    trh.appendChild(th);
  }
  const tbody = h("tbody");
  for (const row of rows) {
    const tr = h("tr");
    for (const col of columns) {
      const td = h("td", { class: isNum(col) ? "num" : "" });
      if (col.render) {
        const out = col.render(row);
        if (out instanceof Node) td.appendChild(out);
        else td.textContent = out == null ? "" : String(out);
      } else {
        td.textContent = formatByType(row[col.key], col.type);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  const table = h("table", { class: "data-table" }, h("thead", {}, trh), tbody);
  container.replaceChildren(h("div", { class: "table-scroll" }, table));
}

// ---------------------------------------------------------------- states
export function notice({ kind = "info", text }) {
  return h("div", { class: `notice notice--${kind}`, role: kind === "bad" ? "alert" : "status" },
    h("span", { class: "notice-dot", "aria-hidden": "true" }),
    h("span", {}, text));
}

export function emptyState(text, title = "Nothing to show yet") {
  return h("div", { class: "state-card" }, h("h3", {}, title), h("p", {}, text));
}

export function comingState(sentence, detail) {
  return h("div", { class: "state-card" },
    h("h3", {}, "Coming soon"),
    h("p", {}, sentence),
    detail ? h("p", { style: "margin-top:.6rem" }, detail) : null);
}

export function errorState(text) {
  return h("div", { class: "state-card state-error" },
    h("h3", {}, "Something went wrong"),
    h("p", {}, text));
}

// A section's data file came back 404. If the manifest says the section is
// live, the file should be there and isn't: say so plainly rather than
// promising it's "coming".
export function missingState(sport, section) {
  const st = manifestStatus(sport, section);
  if (st === "live" || st === "projections") {
    return errorState("This page's data isn't available right now. Please try again in a few minutes.");
  }
  return comingState(getComingText(sport, section));
}
