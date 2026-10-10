// Methodology: "How these numbers work", one readable article drawn from
// data/methodology.json (sharpslate/export/methodology.py writes the copy, so
// the numbers in it come from the same constants the exporters use). The page
// only lays it out: a contents list, then each section in a column no wider
// than 68 characters.
import { h, root, fetchJSON, fmtKick, errorState } from "../app.js";

function paras(list) {
  return (list || []).map((t) => h("p", {}, t));
}

// The worked example: a small table, a caption under it.
function example(ex) {
  if (!ex || !Array.isArray(ex.rows)) return null;
  const head = h("tr", {}, (ex.columns || []).map((c, i) =>
    h("th", { scope: "col", class: i ? "num" : "" }, c || h("span", { class: "visually-hidden" }, "Step"))));
  const body = ex.rows.map((r) => h("tr", {}, r.map((cell, i) =>
    i === 0 ? h("th", { scope: "row" }, cell) : h("td", { class: "num" }, cell))));
  return h("figure", { class: "method-example" },
    h("figcaption", { class: "method-example-title" }, ex.title || "Example"),
    h("div", { class: "table-scroll" }, h("table", { class: "data-table" }, h("thead", {}, head), h("tbody", {}, body))),
    ex.caption ? h("p", { class: "method-example-note" }, ex.caption) : null);
}

// "Right now": the last pull time of each live sport, from the build.
function pulls(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return h("p", { class: "method-now" },
    h("span", { class: "method-now-label" }, "Right now"),
    list.map((p) => h("span", { class: "method-now-item" },
      `${p.label} lines as of ${fmtKick(p.lines_as_of)} ET`)));
}

function section(s, data) {
  return h("section", { class: "method-section", id: s.id, "aria-labelledby": `${s.id}-h` },
    h("h2", { id: `${s.id}-h`, class: "method-h2" }, s.title),
    paras(s.paras),
    example(s.example),
    s.pulls ? pulls(data.pulls) : null);
}

function contents(sections) {
  return h("nav", { class: "method-toc", "aria-label": "On this page" },
    h("p", { class: "method-toc-title" }, "On this page"),
    h("ol", { role: "list" },
      sections.map((s) => h("li", {}, h("a", { href: `#${s.id}` }, s.title)))));
}

async function render() {
  const app = document.getElementById("app");
  // The build writes the article into the page itself (2026-10-03, so search
  // engines read it); drawing it again would only flash. The JSON path below
  // stays for a build that couldn't.
  if (!app.querySelector(".method")) {
    let data;
    try {
      data = await fetchJSON("data/methodology.json");
    } catch {
      app.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, "How these numbers work")),
        errorState("This page's text isn't available right now. Please try again in a few minutes."));
      return;
    }
    const sections = Array.isArray(data.sections) ? data.sections : [];
    app.replaceChildren(h("div", { class: "method" },
      h("div", { class: "method-head" },
        h("h1", { class: "method-h1" }, data.title || "How these numbers work"),
        h("p", { class: "method-lede" }, data.intro || "")),
      h("div", { class: "method-layout" },
        h("article", { class: "method-article" }, sections.map((s) => section(s, data)),
          h("p", { class: "method-back" }, h("a", { class: "home-link", href: `${root()}index.html` }, "Back to the slate"))),
        contents(sections))));
  }
  app.dataset.state = "ready";
  // a link into a section (the Prop Finder's footer) lands on it, clearing
  // the header (--header-h is set by now). Back and forward are left alone:
  // the browser puts the reader back where they were
  const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  const nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
  if (target && !(nav && nav.type === "back_forward")) {
    target.scrollIntoView();
    // the web fonts can arrive after this and reflow the text above the
    // section, sliding its heading under the header: scroll again once they
    // are in, unless the reader has started scrolling in the meantime
    // (or gone to another section: a hash change with no input, from the
    // address bar or the back button, counts too)
    let moved = false;
    const hash = location.hash;
    for (const ev of ["wheel", "touchstart", "keydown", "mousedown", "hashchange"]) {
      addEventListener(ev, () => { moved = true; }, { once: true, passive: true });
    }
    if (document.fonts) {
      document.fonts.ready.then(() => { if (!moved && location.hash === hash) target.scrollIntoView(); });
    }
  }
}

render();
