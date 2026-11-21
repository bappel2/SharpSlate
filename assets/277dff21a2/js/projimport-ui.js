// "Your own projections" on the DFS page: the file picker, the paste box, the
// column picker, the match report and the list of rows to settle by hand. All
// the reading and matching is in projimport.js; this only draws it and keeps
// the page's state (projOverride, projLeftOut) in step.
import { h, labeledField as field } from "./app.js";
import * as PI from "./projimport.js";

const store = () => {
  try { return window.localStorage; } catch { return null; }
};

/** The saved-file key: sport, site and slate (draft group, else the slate's date). */
export function slateKey(data, site) {
  const s = data.slate || {};
  return PI.storageKey(data.sport || "slate", site, s.draft_group || s.date || s.label || "slate");
}

/** The page's Clear button also forgets the saved file. */
export function clearSavedProjections(data, site) {
  PI.clearUpload(store(), slateKey(data, site));
}

let _uid = 0;
const uid = (p) => `${p}-${++_uid}`;

// SheetJS (assets/vendor/sheetjs-0.20.3, Apache 2.0) is read only for an old
// binary .xls or a workbook the built in reader cannot take; every other file
// never loads it.
async function loadSheetJS() {
  if (window.XLSX && window.XLSX.read) return window.XLSX;
  const src = new URL("../../vendor/sheetjs-0.20.3/xlsx.core.min.js", import.meta.url).href;
  await new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("The Excel reader did not load."));
    document.head.appendChild(el);
  });
  return window.XLSX;
}

// the lists draw this many rows at a time, so a huge file never builds a huge page
const PAGE = 200;
const stamp = (t) => {
  try {
    return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
};
const dec1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "");

export function buildProjectionImport({ data, site, state, refresh }) {
  const matcher = PI.buildMatcher({ players: data.players, teams: data.teams, aliases: data.aliases, sport: data.sport });
  const posLabel = (pos) => ((data.roster && data.roster.pos_labels) || {})[pos] || pos;
  const key = slateKey(data, site);

  // "Name (POS TEAM)" for the match-by-hand lists; two players that read alike get their id too
  const labelOf = new Map();
  const byLabel = new Map();
  for (const p of data.players) {
    let label = `${p.name} (${posLabel(p.pos)} ${p.team})`;
    if (byLabel.has(label)) label = `${label} ${p.id}`;
    byLabel.set(label, p);
    labelOf.set(String(p.id), label);
  }
  const listId = uid("pi-players");
  const datalist = h("datalist", { id: listId }, [...byLabel.keys()].map((l) => h("option", { value: l })));

  // the file: {name, savedAt, table (the whole table), choices, manual, missing, reason,
  //   pending (columns not confirmed: nothing is applied), cands, partial (a saved copy cut short), saveFailed}
  let model = null;
  let memSheets = null;   // every sheet of a workbook, for the sheet picker (this visit only)
  let sheetName = "";
  let limit = PAGE;       // how many rows each list draws
  let curRes = null;      // the report the page shows now
  let cache = null;       // the file read and matched, until its columns change
  let persistTimer = 0;
  let refs = null;        // the list rows on screen, for updating one without redrawing the rest
  let notice = "";        // a line for the visitor when a file could not be read

  const fileInput = h("input", { type: "file", id: uid("pi-file"), accept: ".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.html,.htm,text/csv,text/plain,text/tab-separated-values" });
  const pasteArea = h("textarea", { class: "text-input pi-paste-area", rows: "5", id: uid("pi-paste"), spellcheck: "false", placeholder: "Select the cells in your spreadsheet, copy, and paste here. Include the header row." });
  const pasteBtn = h("button", { type: "button", class: "btn btn-sm" }, "Use pasted rows");
  const statusHost = h("div", { class: "pi-status", role: "status" });
  const colsHost = h("div", { class: "pi-cols-host" });
  const reportHost = h("div", { class: "csv-report pi-report", role: "status" });
  const missingHost = h("div", { class: "pi-missing-host" });
  const listHost = h("div", { class: "pi-lists" });
  const badge = h("span", { class: "pi-badge", hidden: true }, "In use");

  // ---------------------------------------------------------------- the match
  function run() {
    if (!cache) {
      const { rows, skipped } = PI.extractRows(model.table, model.choices);
      cache = { rows, skipped, results: rows.map((r) => matcher.match(r)) };
    }
    const res = PI.assemble(cache.rows, cache.results, model.manual, data.players);
    return { ...res, skippedRows: cache.skipped };
  }

  // push the match into the page's state; `touch` redraws the pool and roster
  function apply({ touch, save }) {
    if (!model) {
      curRes = null;
      state.projOverride = {};
      state.projLeftOut = null;
      draw(null);
      if (touch) refresh();
      return;
    }
    if (model.pending) {
      // columns we are not sure of: nothing is applied until the visitor confirms them
      curRes = null;
      state.projOverride = {};
      state.projLeftOut = null;
      draw(null);
      if (touch) refresh();
      return;
    }
    const res = run();
    curRes = res;
    state.projOverride = res.override;
    const missing = PI.missingIds(data.players, res.override);
    state.projLeftOut = model.missing === "leave" && res.matched > 0 ? new Set(missing) : null;
    draw(res, missing.length);
    if (save) persist();
    if (save) drawStatus();
    if (touch) refresh();
  }

  // the saved copy: the chosen and candidate columns, at most 6000 rows (fewer if the browser
  // is short of room); the whole table stays in memory for this visit
  function persist() {
    const st = store();
    PI.pruneUploads(st, Date.now(), key);
    let ok = false, partial = model.partial || null;
    for (const cap of [6000, 3000, 1000]) {
      const slim = PI.slimForStorage(model.table, model.choices, model.cands || [], cap);
      partial = slim.partial || model.partial || null;
      ok = PI.saveUpload(st, key, {
        v: 1, name: model.name, savedAt: model.savedAt, table: slim.table, choices: slim.choices,
        manual: model.manual, missing: model.missing, reason: model.reason || "", partial,
      });
      if (ok) break;
    }
    model.saveFailed = !ok;
    model.savedPartial = ok ? partial : null;
  }

  // a run of hand picks is saved once, a moment after the last
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { if (model && !model.pending) { persist(); drawStatus(); } }, 400);
  }

  // ---------------------------------------------------------------- drawing
  function draw(res, missingCount) {
    badge.hidden = !model || !!model.pending;
    drawStatus();
    drawColumns();
    drawReport(res);
    drawMissing(res, missingCount || 0);
    drawLists(res);
  }

  function drawStatus() {
    const kids = [];
    if (notice) kids.push(h("p", { class: `pi-note${notice.startsWith("Reading") ? "" : " is-bad"}` }, notice));
    if (model && model.pending) {
      kids.push(h("p", { class: "pi-note" },
        "I read ", h("strong", { class: "pi-file-name" }, model.name),
        ", but I am not sure which column holds the projection. Check the columns below and choose Use these columns. Nothing is applied until you do."));
    } else if (model) {
      const clear = h("button", { type: "button", class: "btn btn-sm pi-clear" }, "Clear");
      clear.addEventListener("click", clearFile);
      kids.push(h("p", { class: "pi-using" },
        "Using your file ", h("strong", { class: "pi-file-name" }, model.name), ` from ${stamp(model.savedAt)}. `, clear));
      if (model.savedPartial) {
        kids.push(h("p", { class: "pi-note" },
          `Your browser keeps only the first ${model.savedPartial.rows} of ${model.savedPartial.of} rows, so after a refresh fewer rows will match.`));
      }
      if (model.saveFailed) {
        kids.push(h("p", { class: "pi-note is-bad" }, "Your browser could not keep this file, so it will be gone after a refresh."));
      }
    }
    statusHost.replaceChildren(...kids);
  }

  function drawColumns() {
    if (!model) { colsHost.replaceChildren(); return; }
    const headers = PI.headersOf(model.table, model.choices.headerRow);
    const ch = model.choices;
    let confirm = null;
    const ready = () => ch.pts != null && (ch.name != null || (ch.first != null && ch.last != null));
    const sel = (label, field_, optional, help) => {
      const s = h("select", { class: "select-input", id: uid("pi-col") },
        optional ? h("option", { value: "" }, "None") : (ch[field_] == null ? h("option", { value: "" }, "Choose a column") : null),
        headers.map((hd, i) => h("option", { value: String(i), selected: ch[field_] === i ? true : null }, hd)));
      if (ch[field_] == null) s.value = "";
      s.addEventListener("change", () => {
        ch[field_] = s.value === "" ? null : Number(s.value);
        cache = null;
        manualReset();
        if (model.pending) { if (confirm) confirm.disabled = !ready(); return; }
        model.reason = "";
        apply({ touch: true, save: true });
      });
      return field(label, s, help);
    };
    const grid = h("div", { class: "pi-grid" },
      sel("Name column", "name", true),
      sel("Points column", "pts", false),
      sel("Team column", "team", true),
      sel("Position column", "pos", true),
      sel("Id column", "id", true),
      sel("First name column", "first", true),
      sel("Last name column", "last", true));
    const kids = [];
    if (memSheets && memSheets.length > 1) {
      const s = h("select", { class: "select-input", id: uid("pi-sheet") },
        memSheets.map((sh) => h("option", { value: sh.name, selected: sh.name === sheetName ? true : null }, sh.name)));
      s.addEventListener("change", () => useSheet(memSheets.find((x) => x.name === s.value)));
      kids.push(field("Sheet", s));
    }
    kids.push(grid);
    if (model.pending) {
      confirm = h("button", { type: "button", class: "btn btn-sm btn-primary pi-confirm", disabled: ready() ? null : true }, "Use these columns");
      confirm.addEventListener("click", () => {
        if (!ready()) return;
        model.pending = false;
        model.savedAt = Date.now();
        apply({ touch: true, save: true });
      });
      kids.push(confirm);
    }
    const summary = model.pending ? "Columns: check these"
      : `Columns: ${ch.name != null ? headers[ch.name] : "first and last"} and ${ch.pts != null ? headers[ch.pts] : "none"}`;
    const det = h("details", { class: "pi-sub pi-cols" },
      h("summary", {}, summary),
      h("div", { class: "pi-sub-body" }, model.reason ? h("p", { class: "pi-note" }, model.reason) : null, ...kids));
    if (model.pending) det.open = true;
    colsHost.replaceChildren(det);
  }

  function drawReport(res) {
    if (!res) { reportHost.replaceChildren(); reportHost.className = "csv-report pi-report"; return; }
    reportHost.className = "csv-report pi-report ok";
    const k = res.kind;
    const lines = [
      h("div", { class: "pi-count" }, `Matched ${res.matched} of ${res.total} rows.`),
      h("div", {}, `By id ${k.id}, by name and team ${k.nameteam}, by name ${k.name}, by hand ${k.hand}.`),
    ];
    const rest = [];
    if (res.unmatched.length) rest.push(`${res.unmatched.length} not matched`);
    if (res.ambiguous.length) rest.push(`${res.ambiguous.length} could be more than one player`);
    if (res.skipped) rest.push(`${res.skipped} skipped`);
    if (res.repeats) rest.push(`${res.repeats} repeated`);
    const sk = res.skippedRows;
    if (sk && sk.noPoints) rest.push(`${sk.noPoints} without points ignored`);
    if (rest.length) lines.push(h("div", {}, `${rest.join(", ")}.`));
    reportHost.replaceChildren(...lines);
  }

  function drawMissing(res, count) {
    if (!model || !res) { missingHost.replaceChildren(); return; }
    const name = uid("pi-missing");
    const radio = (value, label) => {
      const input = h("input", { type: "radio", name, value, checked: model.missing === value ? true : null, disabled: value === "leave" && res.matched === 0 ? true : null });
      input.addEventListener("change", () => {
        if (!input.checked) return;
        model.missing = value;
        apply({ touch: true, save: true });
      });
      return h("label", { class: "pi-radio" }, input, h("span", {}, label));
    };
    missingHost.replaceChildren(h("fieldset", { class: "pi-choice" },
      h("legend", {}, "Players your file does not list"),
      h("p", { class: "field-help" }, count
        ? `${count} players on this slate have a SharpSlate projection and are not in your file.`
        : "Every player with a SharpSlate projection is in your file."),
      radio("keep", "Keep SharpSlate's projection"),
      radio("leave", "Leave them out of the optimizer")));
  }

  function manualReset() {
    // the file's rows moved under a new column choice: earlier hand picks no longer point at the same rows
    if (model) model.manual = {};
  }

  // A Skip or a hand pick changes one row: update the report, the counts and that one list row,
  // and leave the rest of the list alone (the file may have a hundred thousand rows).
  function pick(row, playerId) {
    // removing a focused input fires its blur and change again: take each row once
    if (Object.prototype.hasOwnProperty.call(model.manual, String(row.i))) return;
    model.manual[String(row.i)] = playerId;
    const res = curRes;
    if (!res || model.pending || !refs) { apply({ touch: true, save: true }); return; }
    const drop = (arr) => {
      const k = arr.findIndex((e) => e.row.i === row.i);
      if (k >= 0) arr.splice(k, 1);
    };
    drop(res.unmatched);
    drop(res.ambiguous);
    let changedPool = false;
    if (playerId === PI.SKIP) res.skipped++;
    else if (Object.prototype.hasOwnProperty.call(res.override, String(playerId))) res.repeats++;
    else {
      res.override[String(playerId)] = row.pts;
      res.kind.hand++;
      res.matched++;
      changedPool = true;
    }
    const missing = PI.missingIds(data.players, res.override);
    state.projLeftOut = model.missing === "leave" && res.matched > 0 ? new Set(missing) : null;
    drawReport(res);
    drawMissing(res, missing.length);
    const li = refs.rows.get(row.i);
    refs.rows.delete(row.i);
    if (li && li.parentNode) li.parentNode.removeChild(li);
    const section = (list, el, head, label) => {
      if (!el) return;
      head.textContent = `${label} (${list.length})`;
      if (!list.length) el.remove();
    };
    section(res.ambiguous, refs.secA, refs.headA, "Could be more than one player");
    section(res.unmatched, refs.secU, refs.headU, "Not matched");
    // the rows on screen ran out but more are waiting: draw the next page
    const onScreen = refs.rows.size;
    if (!onScreen && (res.ambiguous.length || res.unmatched.length)) drawLists(res);
    else {
      refs.setMore(res);
      refs.setUndo();
    }
    persistSoon();
    if (changedPool) refresh();
  }

  function drawLists(res) {
    refs = null;
    if (!res) { listHost.replaceChildren(); return; }
    const rowsOnScreen = new Map();
    const rowInfo = (row) => h("div", { class: "pi-row-info" },
      h("strong", { class: "pi-nm" }, row.text),
      h("span", { class: "pi-meta num" },
        [row.team, row.pos, dec1(row.pts)].filter((x) => x !== "" && x != null).join(" · ")));
    const skipBtn = (row) => {
      const b = h("button", { type: "button", class: "btn btn-sm", "aria-label": `Skip ${row.text}` }, "Skip");
      b.addEventListener("click", () => pick(row, PI.SKIP));
      return b;
    };
    const kids = [];
    let secA = null, headA = null, secU = null, headU = null;
    if (res.ambiguous.length) {
      const items = res.ambiguous.slice(0, limit).map(({ row, cands }) => {
        const li = h("li", { class: "pi-row" },
          rowInfo(row),
          h("div", { class: "pi-cands" }, cands.map((p) => {
            const b = h("button", { type: "button", class: "btn btn-sm pi-cand", "aria-label": `Match ${row.text} to ${labelOf.get(String(p.id)) || p.name}` }, labelOf.get(String(p.id)) || p.name);
            b.addEventListener("click", () => pick(row, String(p.id)));
            return b;
          }), skipBtn(row)));
        rowsOnScreen.set(row.i, li);
        return li;
      });
      headA = h("h3", { class: "pi-h" }, `Could be more than one player (${res.ambiguous.length})`);
      secA = h("section", { class: "pi-block" }, headA, h("p", { class: "field-help" }, "Choose the one you mean."), h("ul", { class: "pi-list" }, items));
      kids.push(secA);
    }
    if (res.unmatched.length) {
      const items = res.unmatched.slice(0, limit).map(({ row }) => {
        const input = h("input", {
          type: "text", class: "text-input pi-find", list: listId, autocomplete: "off", placeholder: "Find a player",
          "aria-label": `Match ${row.text} to a player`,
        });
        const choose = () => {
          const p = byLabel.get(input.value.trim());
          if (p) pick(row, String(p.id));
        };
        input.addEventListener("input", choose);
        input.addEventListener("change", choose);
        const li = h("li", { class: "pi-row" }, rowInfo(row), h("div", { class: "pi-row-ctl" }, input, skipBtn(row)));
        rowsOnScreen.set(row.i, li);
        return li;
      });
      headU = h("h3", { class: "pi-h" }, `Not matched (${res.unmatched.length})`);
      secU = h("section", { class: "pi-block" }, headU,
        h("p", { class: "field-help" }, "Highest points first. Rows for players who are not on this slate land here too; skip them or leave them."),
        h("ul", { class: "pi-list" }, items));
      kids.push(secU);
    }
    const more = h("button", { type: "button", class: "btn btn-sm" });
    more.addEventListener("click", () => { limit += PAGE; drawLists(curRes); });
    const undo = h("button", { type: "button", class: "btn btn-sm" }, "Undo my picks");
    undo.addEventListener("click", () => { model.manual = {}; apply({ touch: true, save: true }); });
    refs = {
      rows: rowsOnScreen, secA, headA, secU, headU,
      setMore(r) {
        const waiting = Math.max(0, r.ambiguous.length - limit) + Math.max(0, r.unmatched.length - limit);
        more.hidden = waiting <= 0;
        more.textContent = `Show ${Math.min(PAGE, waiting)} more of ${waiting} waiting`;
      },
      setUndo() { undo.hidden = !Object.keys(model.manual).length; },
    };
    refs.setMore(res);
    refs.setUndo();
    kids.push(more, undo);
    listHost.replaceChildren(...kids);
  }

  // ---------------------------------------------------------------- loading
  function adopt(sheets, name) {
    const pick_ = PI.chooseSheet(sheets, { site });
    if (!pick_ || !pick_.an.ok) {
      notice = "I could not find a table of player names and points in that file. Check that it has a header row.";
      drawStatus();
      return;
    }
    notice = "";
    memSheets = sheets;
    sheetName = pick_.sheet.name;
    limit = PAGE;
    cache = null;
    model = {
      name, savedAt: Date.now(), table: pick_.sheet.rows, choices: pick_.an.choices, manual: {},
      missing: model ? model.missing : "keep", reason: pick_.an.needPicker ? pick_.an.reason : "",
      pending: !!pick_.an.needPicker, cands: pick_.an.ptsCandidates || [], partial: null,
    };
    apply({ touch: true, save: !model.pending });
  }

  function useSheet(sheet) {
    if (!sheet) return;
    const an = PI.analyze(sheet.rows, { site });
    if (!an.ok) return;
    sheetName = sheet.name;
    model.table = sheet.rows;
    cache = null;
    limit = PAGE;
    model.choices = an.choices;
    model.manual = {};
    model.reason = an.needPicker ? an.reason : "";
    model.pending = !!an.needPicker;
    model.cands = an.ptsCandidates || [];
    model.partial = null;
    apply({ touch: true, save: !model.pending });
  }

  async function loadFile(file) {
    notice = `Reading ${file.name}`;
    drawStatus();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let parsed;
      try {
        parsed = await PI.readBytes(bytes);
      } catch (e) {
        if (!(e && e.code === "needs-sheetjs")) throw e;
        const XLSX = await loadSheetJS();
        parsed = PI.sheetsFromSheetJS(XLSX, bytes);
      }
      adopt(parsed.sheets, file.name);
    } catch (e) {
      notice = `That file could not be read. ${e && e.message ? e.message : ""}`.trim();
      drawStatus();
    }
  }

  function loadPasted() {
    const text = pasteArea.value;
    if (!text.trim()) return;
    const parsed = PI.parseText(text);
    adopt(parsed.sheets, "pasted rows");
    if (model) pasteArea.value = "";
  }

  function clearFile() {
    PI.clearUpload(store(), key);
    model = null;
    memSheets = null;
    limit = PAGE;
    cache = null;
    apply({ touch: true, save: false });
  }

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    await loadFile(f);
    fileInput.value = "";
  });
  pasteBtn.addEventListener("click", loadPasted);

  // ---------------------------------------------------------------- restore
  PI.pruneUploads(store(), Date.now(), key);
  const saved = PI.loadUpload(store(), key);
  if (saved) {
    model = {
      name: saved.name || "your file", savedAt: saved.savedAt || Date.now(), table: saved.table, choices: saved.choices,
      manual: saved.manual || {}, missing: saved.missing === "leave" ? "leave" : "keep", reason: saved.reason || "",
      pending: false, cands: [], partial: saved.partial || null, savedPartial: saved.partial || null,
    };
    apply({ touch: false, save: false });     // the page draws its pool and roster after the controls
  } else {
    state.projOverride = {};
    state.projLeftOut = null;
    draw(null);
  }

  return h("details", { class: "collapser is-wide pi" },
    h("summary", {}, "Your own projections", badge),
    h("div", { class: "collapser-body" },
      h("p", { class: "field-help" }, "Read in your browser. Never uploaded."),
      h("p", { class: "field-help" }, "Bring a CSV, TSV, text or Excel file, or paste rows from a spreadsheet. Names, teams, positions and ids are matched to this slate."),
      field("Projection file", fileInput),
      h("details", { class: "pi-sub pi-paste" },
        h("summary", {}, "Paste from a spreadsheet"),
        h("div", { class: "pi-sub-body" }, field("Pasted rows", pasteArea), pasteBtn)),
      statusHost, colsHost, reportHost, missingHost, listHost, datalist));
}
