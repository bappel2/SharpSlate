// Building blocks for the calculators: the Tools page's cards and the stand
// alone calculator pages (2026-10-19) draw with the same inputs, fields and
// result boxes, so they look and read the same. Styles live under .tools in
// site.css.
import { h } from "./app.js";

let _uid = 0;
export const uid = (prefix = "tl") => `${prefix}-${++_uid}`;

export function textInput(value, extra = {}) {
  return h("input", { type: "text", class: "text-input", inputmode: "decimal", value: String(value), ...extra });
}
export function numInput(value, extra = {}) {
  return h("input", { type: "number", class: "text-input", value: String(value), ...extra });
}

// A select with a caret drawn by the page (the control's own is switched off).
export function selectBox(select) {
  return h("span", { class: "tl-select" }, select);
}

/** A <label for> over a control, with an optional line of help under it. */
export function field(labelText, control, help, host = control) {
  const id = control.id || uid("tl-f");
  control.id = id;
  return h("div", { class: "field" },
    h("label", { class: "field-label", for: id }, labelText),
    host,
    help ? h("div", { class: "field-help" }, help) : null);
}

// A result: one headline cell (or two), then quiet rows. `tone` is the sign of
// the user's own number, shown in the good or bad text color and nothing more.
export function kpi(label, value, sub, tone) {
  return h("div", { class: "tl-kpi" },
    h("div", { class: "tl-kpi-l" }, label),
    h("div", { class: `tl-kpi-v num${tone ? ` is-${tone}` : ""}` }, value),
    sub ? h("div", { class: "tl-kpi-s num" }, sub) : null);
}

export function resultRow(label, value, tone) {
  return h("div", { class: "tl-row" },
    h("span", { class: "tl-row-l" }, label),
    h("span", { class: `tl-row-v num${tone ? ` is-${tone}` : ""}` }, value));
}

/** The result box: it announces its changes politely to a screen reader. */
export function resultBox() {
  return h("div", { class: "tl-result", "aria-live": "polite", "aria-atomic": "true" });
}

export function showMessage(box, text) {
  box.replaceChildren(h("p", { class: "tl-empty" }, text));
}

export function showResult(box, headline, rows) {
  // replaceChildren would print a null as the text "null"
  box.replaceChildren(...[
    h("div", { class: `tl-heads${headline.length > 1 ? " is-two" : ""}` }, headline),
    rows.length ? h("div", { class: "tl-rows" }, rows) : null].filter(Boolean));
}

export function card(titleText, blurb, body, { wide = false, full = false } = {}) {
  const id = uid("tl-card");
  return h("section", {
    class: `tl-card${wide ? " is-wide" : ""}${full ? " is-full" : ""}`, "aria-labelledby": id,
  },
    h("div", { class: "tl-card-head" },
      h("h2", { class: "tl-card-title", id }, titleText),
      blurb ? h("p", { class: "tl-card-sub" }, blurb) : null),
    h("div", { class: "tl-body" }, body));
}

// a value that prints as zero has no sign: "+0.000", never "-0.000"
export const signedNum = (v, places) => `${v < 0 && Math.abs(v).toFixed(places) !== (0).toFixed(places) ? "-" : "+"}${Math.abs(v).toFixed(places)}`;
export const signedMoney = (v) => `${v < 0 && Math.abs(v).toFixed(2) !== "0.00" ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;
export const money = (v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
