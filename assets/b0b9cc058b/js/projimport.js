// Your own projections: reading a visitor's file and matching it to the slate.
// Pure logic, no DOM, so the /selftest/ page can run it on hand-checked cases.
// The page that draws it is projimport-ui.js.
//
//   bytes or pasted text  ->  readBytes / parseText  ->  sheets of string rows
//   rows                  ->  analyze                ->  header row + column guesses
//   rows + columns        ->  extractRows            ->  {name, team, pos, id, points}
//   rows + the slate      ->  buildMatcher.match     ->  id / name and team / name
//   results + hand picks  ->  assemble               ->  {playerId: points}
//
// Matching is best first and each step is unique or nothing: a row that fits two
// players is listed for the visitor to settle, never guessed. Ids: dfs.json
// carries DraftKings' PLAYER id for the live feed (the draftable id that
// DKSalaries.csv holds in its ID column and in "Name + ID" is not in our data),
// so a salary file's id usually will not hit and the row falls through to the
// name and team step; an id hit is trusted only when the name agrees. FanDuel's
// ids are "<fixture>-<player>"; the bare player part is accepted from a column
// that looks like FanDuel's. Nothing here is sent anywhere.

export const SKIP = "skip";

// ---------------------------------------------------------------- text
/** Bytes to text: a BOM picks UTF-8 or UTF-16; no BOM tries UTF-8, then Windows-1252. */
export function decodeText(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

const clean = (s) => String(s == null ? "" : s).replace(/[ ​﻿]/g, " ").replace(/\s+/g, " ").trim();

/** Which delimiter a block of text uses: the one that splits most lines the same
 *  number of times (title lines above the table split differently and lose). */
export function detectDelimiter(text) {
  const lines = String(text).split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 60);
  let best = ",", bestScore = 0;
  for (const d of ["\t", ";", ",", "|"]) {
    const freq = new Map();
    for (const l of lines) {
      let n = 0, q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '"') q = !q;
        else if (!q && c === d) n++;
      }
      if (n > 0) freq.set(n, (freq.get(n) || 0) + 1);
    }
    let top = 0, topN = 0;
    for (const [n, f] of freq) if (f > top || (f === top && n > topN)) { top = f; topN = n; }
    // a delimiter that splits at least two lines the same way, then by how many columns it makes
    const score = top >= 2 || lines.length === 1 ? top * 1000 + topN : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Delimited text to rows of strings: quoted fields (with "" and line breaks inside), \r\n or \n. */
export function parseDelimited(text, delim) {
  const src = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [], cur = "", q = false;
  const endRow = () => {
    row.push(cur); cur = "";
    if (row.some((x) => x.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"' && cur === "") q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; endRow(); }
    else cur += c;
  }
  if (cur !== "" || row.length) endRow();
  return rows;
}

/** Pasted or loaded text: HTML table, or delimited with the delimiter found. */
export function parseText(text) {
  const t = String(text).replace(/^﻿/, "");
  if (/^\s*<(!doctype|html|table|meta|\?xml)/i.test(t) && /<t[dh]\b/i.test(t)) {
    return { sheets: [{ name: "Table", rows: parseHtmlTable(t) }], delim: "html" };
  }
  const delim = detectDelimiter(t);
  return { sheets: [{ name: "Sheet", rows: parseDelimited(t, delim) }], delim };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return String(s)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** A saved-as-.xls web table (many sites export HTML under an Excel name). */
export function parseHtmlTable(html) {
  const rows = [];
  for (const m of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const c of m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(clean(decodeEntities(c[1].replace(/<[^>]*>/g, ""))));
    }
    if (cells.some((x) => x !== "")) rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------- numbers
/** "27.07", "$7,500", "1.234,5" (decimal comma), "(3.5)", "12%" to a number, or null. */
export function parseNumber(raw, decimalComma = false) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = clean(raw);
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/^[\s$€£]+|[\s$€£%]+$/g, "");
  if (/^[-+−]/.test(s)) { if (s[0] !== "+") neg = !neg; s = s.slice(1).trim(); }
  s = s.replace(/^[$€£]+/, "");
  if (!s) return null;
  let t = null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) && !decimalComma) t = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) && decimalComma) t = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d+$/.test(s)) {
    // "7,500" is thousands unless the file writes decimal commas; "12,5" is a decimal either way
    const frac = s.split(",")[1];
    t = frac.length === 3 && !decimalComma ? s.replace(",", "") : s.replace(",", ".");
  } else if (/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) t = s;
  if (t === null) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** Does the file write 12,5 for 12.5? (more comma decimals than point decimals) */
export function detectDecimalComma(rows) {
  let comma = 0, point = 0;
  for (const r of rows.slice(0, 400)) {
    for (const c of r) {
      const s = clean(c).replace(/^[$€]/, "");
      const m = /^[-+]?\d+,(\d+)$/.exec(s);
      if (m && m[1].length !== 3) comma++;
      else if (/^[-+]?\d*\.\d+$/.test(s)) point++;
    }
  }
  return comma > 0 && comma > point;
}

// ---------------------------------------------------------------- xlsx (native)
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw coded("no-inflate", "This browser cannot unzip a workbook.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** The entries of a ZIP: {name: {method, compressed, size, offset}} from its central directory. */
function zipEntries(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw coded("not-zip", "That is not a workbook.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw coded("zip64", "That workbook is too large to read here.");
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw coded("bad-zip", "That workbook is damaged.");
    const method = dv.getUint16(p + 10, true);
    const compressed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const n = dv.getUint16(p + 28, true), m = dv.getUint16(p + 30, true), c = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(b.subarray(p + 46, p + 46 + n));
    out[name] = { method, compressed, size, offset };
    p += 46 + n + m + c;
  }
  return out;
}

async function zipRead(b, entry) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const o = entry.offset;
  if (dv.getUint32(o, true) !== 0x04034b50) throw coded("bad-zip", "That workbook is damaged.");
  const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  const data = b.subarray(start, start + entry.compressed);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw coded("bad-zip", "That workbook uses a compression this page cannot read.");
}

const xmlText = (u8) => new TextDecoder("utf-8").decode(u8);
const attr = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2]) : null;
};

/** The text of every <t> in a fragment, phonetic runs left out. */
function tText(frag) {
  const f = frag.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let s = "";
  for (const m of f.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) s += m[1] || "";
  return decodeEntities(s);
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] || "") n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
};

/** Sheets of string rows from an .xlsx, read here with no library: unzip, then
 *  read the shared strings and each sheet's cells. */
export async function readXlsx(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const files = zipEntries(b);
  const read = async (name) => (files[name] ? xmlText(await zipRead(b, files[name])) : null);
  const wbXml = await read("xl/workbook.xml");
  if (!wbXml) throw coded("not-xlsx", "That zip is not an Excel workbook.");
  const relXml = (await read("xl/_rels/workbook.xml.rels")) || "";
  const rels = {};
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), target = attr(m[0], "Target");
    if (id && target) rels[id] = target;
  }
  const sharedXml = await read("xl/sharedStrings.xml");
  const shared = [];
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(tText(m[1] || ""));
  }
  const sheets = [];
  let n = 0;
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    n++;
    const state = attr(m[0], "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const name = attr(m[0], "name") || `Sheet ${n}`;
    const rid = attr(m[0], "r:id") || attr(m[0], "id");
    let target = rels[rid] || `worksheets/sheet${n}.xml`;
    target = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    target = target.replace(/[^/]+\/\.\.\//g, "");
    const xml = await read(target);
    if (xml === null) continue;
    sheets.push({ name, rows: sheetRows(xml, shared) });
  }
  if (!sheets.length) throw coded("empty-xlsx", "That workbook has no visible sheet.");
  return { sheets, delim: "xlsx" };
}

function sheetRows(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = rm[1];
    if (!body) continue;
    const cells = [];
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1], inner = cm[2] || "";
      const ref = attr(head, "r");
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const t = attr(head, "t");
      let v = "";
      if (t === "inlineStr") v = tText(inner);
      else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vm ? decodeEntities(vm[1]) : "";
        if (t === "s") v = shared[parseInt(raw, 10)] ?? "";
        else if (t === "b") v = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
        else if (t === "e") v = "";
        else v = raw;
      }
      while (cells.length < col) cells.push("");
      cells[col] = v;
    }
    if (cells.some((x) => String(x).trim() !== "")) rows.push(cells);
  }
  return rows;
}

/** Sheets from a SheetJS module (`XLSX`), for the files the reader above cannot take (.xls). */
export function sheetsFromSheetJS(XLSX, buf) {
  const wb = XLSX.read(buf instanceof Uint8Array ? buf : new Uint8Array(buf), { type: "array" });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "", blankrows: false });
    const rows = aoa.map((r) => r.map((c) => (c == null ? "" : String(c)))).filter((r) => r.some((x) => x.trim() !== ""));
    if (rows.length) sheets.push({ name, rows });
  }
  if (!sheets.length) throw coded("empty-xlsx", "That workbook has no readable sheet.");
  return { sheets, delim: "xls" };
}

/** What kind of file the first bytes say it is. */
export function sniff(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "zip";
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "ole";
  return "text";
}

/** A file's bytes to sheets. Throws an error with `code` "needs-sheetjs" for the
 *  old binary .xls (or an .xlsx this reader cannot take): the page then loads
 *  the vendored SheetJS and calls sheetsFromSheetJS. */
export async function readBytes(buf) {
  const kind = sniff(buf);
  if (kind === "ole") throw coded("needs-sheetjs", "An older Excel file.");
  if (kind === "zip") {
    try {
      return await readXlsx(buf);
    } catch (e) {
      if (e && e.code === "not-xlsx") throw coded("not-xlsx", "That zip is not an Excel workbook.");
      throw coded("needs-sheetjs", (e && e.message) || "That workbook needs the fuller reader.");
    }
  }
  return parseText(decodeText(buf));
}

// ---------------------------------------------------------------- names
const SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b/g;

/** A name folded to its join form: no accents, case, periods or apostrophes,
 *  no Jr/Sr/II..., hyphens as spaces, and a run of leading initials joined ("J. K." = "JK"). */
export function normKey(text) {
  let t = String(text == null ? "" : text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/đ/g, "d").replace(/ł/g, "l");
  t = t.replace(/[.'`’´]/g, "").replace(SUFFIX_RE, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const parts = t.split(" ");
  while (parts.length > 2 && parts[0].length === 1 && parts[1].length === 1) parts.splice(0, 2, parts[0] + parts[1]);
  return parts.join(" ");
}

// First names that are the same name written two ways. Used last (a looser pass),
// and still unique or nothing.
const NICK_GROUPS = [
  ["michael", "mike", "mikey"], ["matthew", "matt"], ["joshua", "josh"], ["nicholas", "nick", "nicky"],
  ["christopher", "chris"], ["zachary", "zach", "zack"], ["william", "will", "bill", "billy", "willie"],
  ["benjamin", "ben"], ["jacob", "jake"], ["daniel", "dan", "danny"], ["thomas", "tom", "tommy"],
  ["joseph", "joe", "joey"], ["james", "jim", "jimmy"], ["robert", "rob", "bob", "bobby", "robbie"],
  ["richard", "rick", "ricky", "rich", "richie"], ["anthony", "tony"], ["andrew", "andy", "drew"],
  ["alexander", "alex"], ["samuel", "sam"], ["kenneth", "ken", "kenny"], ["nathan", "nate", "nathaniel"],
  ["mitchell", "mitch"], ["cameron", "cam"], ["patrick", "pat"], ["steven", "stephen", "steve"],
  ["edward", "ed", "eddie", "ted"], ["frederick", "fred", "freddie"], ["gabriel", "gabe"],
  ["charles", "chuck", "charlie"], ["david", "dave"], ["gregory", "greg"], ["jeffrey", "jeff"],
  ["timothy", "tim"], ["ronald", "ron", "ronnie"], ["lawrence", "larry"], ["vincent", "vince"],
  ["dominic", "dom"], ["ezekiel", "zeke"], ["jonathan", "jon"], ["theodore", "teddy"],
  ["terrence", "terrance", "terry"], ["donald", "don", "donnie"], ["timothy", "timmy"], ["isaiah", "zay"],
];
const NICK = new Map();
for (const g of NICK_GROUPS) for (const n of g) if (!NICK.has(n)) NICK.set(n, g[0]);

const squeeze = (k) => {
  const p = k.split(" ");
  const q = p.filter((x) => x.length > 1);
  return q.length >= 2 ? q.join(" ") : k;
};
const nickFold = (k) => {
  const p = k.split(" ");
  if (p.length >= 2 && NICK.has(p[0])) p[0] = NICK.get(p[0]);
  return p.join(" ");
};

/** The keys a name is looked up under, loosest last: [alias folded, without
 *  stray initials, with the first name's long form]. */
export function nameKeys(name, aliases) {
  const al = aliases || {};
  const k1raw = normKey(name);
  const k1 = Object.prototype.hasOwnProperty.call(al, k1raw) ? al[k1raw] : k1raw;
  const k2 = squeeze(k1);
  return [k1, k2, nickFold(k2)];
}

/** One name cell to {name, hints, idHint}: "Last, First", "Name (WR - BUF)",
 *  "Name (12345)" and "Name - BUF" are taken apart; hints are the loose
 *  position/team words, resolved later against the slate. */
export function parseNameCell(raw) {
  let s = clean(raw);
  const hints = [];
  let idHint = "";
  for (let guard = 0; guard < 3; guard++) {
    const m = /^(.*?)\s*[([]([^)\]]*)[)\]]\s*$/.exec(s);
    if (!m || !m[1].trim()) break;
    const inner = m[2].trim().replace(/D\s*\/\s*ST/gi, "DST");
    s = m[1].trim();
    if (/^\d{3,}$/.test(inner)) idHint = inner;
    else hints.push(...inner.split(/[\s,/|;·•\-–—]+/).filter(Boolean));
  }
  const dash = /^(.*\S)\s+[-–—|]\s+([A-Z0-9][A-Z0-9 /,]{0,13})$/.exec(s);
  if (dash && dash[2].split(/[\s,/]+/).filter(Boolean).every((t) => /^[A-Z0-9]{1,5}$/.test(t))) {
    s = dash[1].trim();
    hints.push(...dash[2].replace(/D\s*\/\s*ST/gi, "DST").split(/[\s,/]+/).filter(Boolean));
  }
  const parts = s.split(",");
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) s = `${parts[1].trim()} ${parts[0].trim()}`;
  return { name: s, hints, idHint };
}

const POS_MAP = {
  QB: "QB", RB: "RB", HB: "RB", FB: "RB", WR: "WR", TE: "TE", K: "K", PK: "K",
  DST: "DST", DEF: "DST", D: "DST", DEFENSE: "DST", DEFENCE: "DST",
};
/** Position words in a cell ("WR", "RB/WR", "D/ST", "DEF") as site positions. */
export function posTokens(cell) {
  const out = new Set();
  const s = String(cell || "").toUpperCase().replace(/D\s*\/\s*ST/g, "DST");
  for (const t of s.split(/[^A-Z]+/)) if (t && POS_MAP[t]) out.add(POS_MAP[t]);
  return out;
}

// ---------------------------------------------------------------- teams
// DraftKings' abbreviation first, then the other abbreviations files use.
const NFL_TEAMS = [
  "ARI|Arizona|Cardinals|ARZ,AZ", "ATL|Atlanta|Falcons|", "BAL|Baltimore|Ravens|BLT", "BUF|Buffalo|Bills|",
  "CAR|Carolina|Panthers|", "CHI|Chicago|Bears|", "CIN|Cincinnati|Bengals|", "CLE|Cleveland|Browns|CLV",
  "DAL|Dallas|Cowboys|", "DEN|Denver|Broncos|", "DET|Detroit|Lions|", "GB|Green Bay|Packers|GNB",
  "HOU|Houston|Texans|HST", "IND|Indianapolis|Colts|", "JAX|Jacksonville|Jaguars|JAC,Jags",
  "KC|Kansas City|Chiefs|KAN", "LAC|Los Angeles Chargers|Chargers|SD,LA Chargers,San Diego",
  "LAR|Los Angeles Rams|Rams|LA,STL,LA Rams,St Louis", "LV|Las Vegas|Raiders|LVR,OAK,Oakland",
  "MIA|Miami|Dolphins|", "MIN|Minnesota|Vikings|", "NE|New England|Patriots|NWE,Pats",
  "NO|New Orleans|Saints|NOR,NOLA", "NYG|New York Giants|Giants|NY Giants", "NYJ|New York Jets|Jets|NY Jets",
  "PHI|Philadelphia|Eagles|", "PIT|Pittsburgh|Steelers|", "SEA|Seattle|Seahawks|",
  "SF|San Francisco|49ers|SFO,Niners", "TB|Tampa Bay|Buccaneers|TAM,Bucs", "TEN|Tennessee|Titans|",
  "WAS|Washington|Commanders|WSH,Redskins",
].map((r) => {
  const [abbr, place, nick, alts] = r.split("|");
  const names = [abbr, ...(alts ? alts.split(",") : [])];
  const words = [nick];
  if (/^(Los Angeles|New York)/.test(place)) words.push(place);
  else words.push(place, `${place} ${nick}`);
  return { abbr, abbrs: names, words };
});

// A few college abbreviations files use where DraftKings' differs. Used only
// when the DraftKings code is on the slate.
const CFB_ALTS = {
  ALA: "BAMA", FLA: "UF", GA: "UGA", HOU: "UH", KEN: "UK", MIZ: "MIZZ", VAN: "VAND", VA: "UVA", WIS: "WISC",
  MICHST: "MSU", OHST: "OSU", NCAR: "UNC", MISSST: "MSST",
};

const teamNorm = (s) => {
  let t = normKey(String(s || "").replace(/&/g, " and "));
  t = t.replace(/\bst\b/g, "state").replace(/\buniv(ersity)?\b/g, " ").replace(/\bof\b/g, " ").replace(/\bthe\b/g, " ");
  return t.replace(/\s+/g, " ").trim();
};

/** Turns the team words a file uses (BUF, Bills, Buffalo, Buffalo Bills, JAC, Ohio State Buckeyes)
 *  into the slate's own abbreviation, or null. `abbrs` are the slate's teams. */
export function makeTeamResolver({ teams, sport, abbrs }) {
  const slate = new Set(abbrs);
  const exact = new Map();       // normalized text -> abbr, or null when two teams claim it
  const names = new Map();       // normalized team name (for prefix matching) -> abbr
  const put = (map, key, abbr) => {
    if (!key) return;
    if (map.has(key) && map.get(key) !== abbr) map.set(key, null);
    else map.set(key, abbr);
  };
  for (const a of slate) put(exact, teamNorm(a), a);
  for (const [a, t] of Object.entries(teams || {})) {
    if (!slate.has(a) || !t || !t.name) continue;
    put(exact, teamNorm(t.name), a);
    put(names, teamNorm(t.name), a);
    // other words the data lists for a team (NBA: nickname, city, ESPN's code);
    // a word two teams share ("Los Angeles") matches neither
    for (const x of t.alts || []) put(exact, teamNorm(x), a);
  }
  if (sport === "nfl") {
    for (const t of NFL_TEAMS) {
      const target = t.abbrs.find((x) => slate.has(x));
      if (!target) continue;
      for (const x of t.abbrs) put(exact, teamNorm(x), target);
      for (const w of t.words) { put(exact, teamNorm(w), target); put(names, teamNorm(w), target); }
    }
  } else {
    for (const [alt, a] of Object.entries(CFB_ALTS)) if (slate.has(a)) put(exact, teamNorm(alt), a);
  }
  const prefixKeys = [...names.keys()].filter((k) => names.get(k)).sort((x, y) => y.length - x.length);
  // NFL teams that are not on this slate: a file naming one is naming nobody here
  const off = new Set();
  if (sport === "nfl") {
    for (const t of NFL_TEAMS) {
      if (t.abbrs.some((x) => slate.has(x))) continue;
      for (const x of [...t.abbrs, ...t.words]) off.add(teamNorm(x));
    }
  }
  const exactOnly = (text) => {
    const k = teamNorm(text);
    return k && exact.has(k) ? exact.get(k) : null;
  };
  return {
    abbrs: slate,
    /** the whole text is one team word (abbreviation, city, nickname or full name) */
    resolveExact: exactOnly,
    /** team cells: also "Ohio State Buckeyes", a name followed by a mascot */
    resolve(text) {
      const k = teamNorm(text);
      if (!k) return null;
      if (exact.has(k)) return exact.get(k);
      for (const p of prefixKeys) if (k.startsWith(p + " ")) return names.get(p);
      return null;
    },
    offSlate(text) {
      const k = teamNorm(text);
      return !!k && off.has(k);
    },
  };
}

// ---------------------------------------------------------------- columns
const normHeader = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const NAME_EXACT = new Set([
  "name", "player", "player name", "playername", "full name", "fullname", "nickname", "athlete", "display name",
  "displayname", "player full name", "name id", "player name id", "name pos team", "player pos team", "player team pos",
  "name team pos", "name team", "player team", "name pos", "player pos", "players",
]);
const FIRST = new Set(["first name", "first", "firstname", "fname", "given name", "given", "first nm"]);
const LAST = new Set(["last name", "last", "lastname", "lname", "surname", "family name", "last nm"]);
const TEAM = new Set([
  "team", "tm", "teamabbrev", "team abbrev", "team abbr", "team abbreviation", "teamabbreviation", "nfl team", "school",
  "college", "club", "squad", "team name", "teamname", "team code", "team short", "ncaa team",
]);
const POS = new Set(["pos", "position", "player position", "posn", "positions", "pos s"]);
const ID_OTHER = /\b(gsis|espn|mlbam|nfl|yahoo|sleeper|rotowire|fantasypros|pfr|sportradar|ref|pff|rg|rotogrinders|nflverse|game|team|opp|slate|contest|fixture|draftgroup|group|league)\b/;
const EXCL = new Set((
  "salary sal salaries price cost own ownership pown ownp owned roster rostered value val ceil ceiling floor boom bust " +
  "rank rk ecr adp tier sd stdev variance odds line spread total game opp opponent avg average fppg ppg allowed against " +
  "dvp snaps snap targets tgt carries yards yds td tds rec receptions att cmp int ints fum fumbles pass rush receiving " +
  "rushing passing sacks pct percent diff change delta salary k per dollar played tier games gp"
).split(" "));
const siteTag = (norm) => {
  if (/(^| )(dk|draftkings|draft kings)( |$)|(^| )dk(proj|pts|fp|fpts|points|projection)( |$)/.test(norm)) return "dk";
  if (/(^| )(fd|fanduel|fan duel)( |$)|(^| )fd(proj|pts|fp|fpts|points|projection)( |$)/.test(norm)) return "fd";
  return null;
};

/** 3 = a projection column, 2 = fantasy points, 1 = bare points or median, 0 = not a points column. */
function ptsStrength(norm) {
  const t = norm.split(" ");
  if (t.some((x) => EXCL.has(x) || /^\d+k$/.test(x))) return 0;
  let s = /\bfantasy (points|pts|fpts)\b/.test(norm) ? 2 : 0;
  for (const x of t) {
    if (/^(proj|projs|projection|projections|projected|projpts|projfpts|dkproj|fdproj|projdk|projfd|projectedpoints)$/.test(x)) s = Math.max(s, 3);
    else if (/^(fp|fpts|ffpts|fpt|dkfpts|fdfpts|dkpts|fdpts|dkfp|fdfp|dkpoints|fdpoints)$/.test(x)) s = Math.max(s, 2);
    else if (/^(pts|points|point|median|mean|expected|exp)$/.test(x)) s = Math.max(s, 1);
  }
  return s;
}

function isIdHeader(norm) {
  if (NAME_EXACT.has(norm)) return false;
  const t = norm.split(" ");
  if (ID_OTHER.test(norm)) return false;
  return t.some((x) => x === "id" || x === "ids" || /^(dk|fd|player|draftable|draftkings|fanduel|site)id$/.test(x));
}

/** What a header says its column is: {role, tag, strength} or null. */
export function roleOf(headerText) {
  const norm = normHeader(headerText);
  if (!norm) return null;
  if (NAME_EXACT.has(norm)) return { role: "name", norm };
  if (FIRST.has(norm)) return { role: "first", norm };
  if (LAST.has(norm)) return { role: "last", norm };
  if (isIdHeader(norm)) return { role: "id", tag: siteTag(norm), norm };
  if (TEAM.has(norm)) return { role: "team", norm };
  if (POS.has(norm)) return { role: "pos", norm };
  const strength = ptsStrength(norm);
  if (strength) return { role: "pts", tag: siteTag(norm), strength, norm };
  if (/^(player|name)\b/.test(norm) && norm.split(" ").length <= 4 && !norm.split(" ").some((x) => EXCL.has(x) || x === "id" || x === "rank")) {
    return { role: "name", norm, weak: true };
  }
  return null;
}

const isTotalsLabel = (s) => /^(totals?|grand total|average|avg|sum|mean|median|count|min|max|league average|source|notes?)$/i.test(clean(s));

function colProfile(table, from, c, limit = 400) {
  let n = 0, nums = 0, text = 0;
  const vals = [];
  for (let r = from; r < Math.min(table.length, from + limit); r++) {
    const cell = clean(table[r][c]);
    if (!cell) continue;
    n++;
    const v = parseNumber(cell, true) ?? parseNumber(cell, false);
    if (v !== null) { nums++; vals.push(v); } else text++;
  }
  vals.sort((a, b) => a - b);
  return { n, nums, text, numFrac: n ? nums / n : 0, median: vals.length ? vals[vals.length >> 1] : null };
}

const nonEmpty = (row) => row.filter((c) => clean(c) !== "").length;

function hasNumericBelow(table, r) {
  const below = table.slice(r + 1, r + 16);
  if (!below.length) return false;
  const width = Math.max(...below.map((x) => x.length), 0);
  for (let c = 0; c < width; c++) {
    let nums = 0, filled = 0;
    for (const row of below) {
      const cell = clean(row[c]);
      if (!cell) continue;
      filled++;
      if (parseNumber(cell, true) !== null || parseNumber(cell, false) !== null) nums++;
    }
    if (nums >= 1 && nums >= Math.ceil(below.length / 2)) return true;
  }
  return false;
}

/** The column names to show in a picker: the header row's text, else "Column n". */
export function headersOf(table, headerRow) {
  const width = Math.min(200, Math.max(...table.slice(0, 200).map((x) => x.length), 0));
  const out = [];
  for (let c = 0; c < width; c++) {
    const t = headerRow >= 0 && table[headerRow] ? clean(table[headerRow][c]) : "";
    out.push(t || `Column ${c + 1}`);
  }
  return out;
}

/** Find the header row (the first with a name column and a numeric column below it,
 *  past any title rows), then guess the columns. `ctx.site` is "dk" or "fd".
 *  Returns {ok, headerRow, headers, choices, ptsCandidates, needPicker, reason}. */
export function analyze(table, ctx = {}) {
  const site = ctx.site === "fd" ? "fd" : "dk";
  if (!table || !table.length) return { ok: false, reason: "That file looks empty." };
  const decimalComma = detectDecimalComma(table);
  let headerRow = -1, roles = null;
  for (let r = 0; r < Math.min(table.length, 60); r++) {
    if (nonEmpty(table[r]) < 2) continue;
    const rs = table[r].map(roleOf);
    const hasName = rs.some((x) => x && x.role === "name") ||
      (rs.some((x) => x && x.role === "first") && rs.some((x) => x && x.role === "last"));
    if (hasName && hasNumericBelow(table, r)) { headerRow = r; roles = rs; break; }
  }
  let guessed = false;
  if (headerRow < 0) {
    // no header we recognize: the first row of words with numbers under it, or no header at all
    guessed = true;
    for (let r = 0; r < Math.min(table.length, 30); r++) {
      if (nonEmpty(table[r]) < 2) continue;
      const cells = table[r].map(clean).filter(Boolean);
      const allWords = cells.every((c) => parseNumber(c, true) === null);
      if (allWords && hasNumericBelow(table, r)) { headerRow = r; break; }
      if (!allWords) { headerRow = -1; break; }
    }
    roles = headerRow >= 0 ? table[headerRow].map(roleOf) : [];
  }
  const headers = headersOf(table, headerRow);
  const width = headers.length;
  const from = headerRow + 1;
  const idxOf = (role) => (roles || []).map((x, i) => (x && x.role === role ? i : -1)).filter((i) => i >= 0);
  const textCol = (c) => { const p = colProfile(table, from, c); return p.n > 0 && p.text / p.n >= 0.6; };

  const choices = { headerRow, name: null, first: null, last: null, team: null, pos: null, id: null, pts: null, decimalComma };
  const names = idxOf("name").filter(textCol);
  // a plain "Name" beats "Name + ID" (the id rides in its brackets; the id column is read on its own)
  const rank = (i) => (roles[i].weak ? 3 : ["name", "player name", "player", "nickname"].includes(roles[i].norm) ? 0 : 1);
  names.sort((a, b) => rank(a) - rank(b) || a - b);
  if (names.length) choices.name = names[0];
  const firsts = idxOf("first"), lasts = idxOf("last");
  if (firsts.length && lasts.length) { choices.first = firsts[0]; choices.last = lasts[0]; }
  const teams = idxOf("team");
  if (teams.length) choices.team = teams[0];
  const poss = idxOf("pos");
  if (poss.length) choices.pos = poss[0];
  // an id column: this site's own first, then an untagged one, never the other site's
  const ids = idxOf("id");
  const idPick = ids.find((i) => roles[i].tag === site) ?? ids.find((i) => !roles[i].tag);
  if (idPick !== undefined) choices.id = idPick;

  // points candidates, only columns that hold fantasy-sized numbers
  const cands = [];
  idxOf("pts").forEach((i) => {
    const p = colProfile(table, from, i);
    if (p.numFrac >= 0.5 && p.median !== null && Math.abs(p.median) <= 80) {
      cands.push({ idx: i, tag: roles[i].tag || null, strength: roles[i].strength });
    }
  });
  const mine = cands.filter((c) => c.tag === site);
  const loose = cands.filter((c) => !c.tag);
  const other = cands.filter((c) => c.tag && c.tag !== site);
  const group = mine.length ? mine : loose.length ? loose : [];
  group.sort((a, b) => b.strength - a.strength || a.idx - b.idx);
  let needPicker = false, reason = "";
  if (group.length === 1) choices.pts = group[0].idx;
  else if (group.length > 1) { choices.pts = group[0].idx; needPicker = true; reason = "Several columns could be the projection. Pick the one to use."; }
  else {
    needPicker = true;
    const fallback = other.length ? other.sort((a, b) => b.strength - a.strength)[0].idx : guessNumeric(table, from, choices, width, headers);
    if (fallback !== null) choices.pts = fallback;
    reason = other.length
      ? `This file's projection columns are for ${site === "dk" ? "FanDuel" : "DraftKings"}. Pick the points column to use.`
      : "No projection column found. Pick the points column to use.";
  }
  if (choices.name === null && choices.first === null) {
    needPicker = true;
    choices.name = guessText(table, from, width);
    reason = reason || "No name column found. Pick the name column.";
  }
  if (guessed) { needPicker = true; reason = reason || "Check which columns hold the names and points."; }
  return {
    ok: choices.name !== null || choices.first !== null,
    headerRow, headers, choices, needPicker, reason, decimalComma,
    ptsCandidates: cands.map((c) => c.idx),
    width,
  };
}

/** Headers that are never guessed as the projection (FPPG, AvgPointsPerGame, Played, Tier, Salary,
 *  ownership, value, ceiling, floor ...); the visitor can still choose them by hand. */
function neverGuess(headerText) {
  const norm = normHeader(headerText);
  return norm.split(" ").some((x) => EXCL.has(x) || x.startsWith("avg") || x.endsWith("ppg") || x === "fppg");
}

function guessNumeric(table, from, choices, width, headers) {
  let best = null, bestScore = 0;
  for (let c = 0; c < width; c++) {
    if ([choices.name, choices.team, choices.pos, choices.id, choices.first, choices.last].includes(c)) continue;
    if (neverGuess(headers[c])) continue;
    const p = colProfile(table, from, c);
    if (p.numFrac >= 0.6 && p.median !== null && Math.abs(p.median) <= 80 && p.n > bestScore) { best = c; bestScore = p.n; }
  }
  return best;
}

function guessText(table, from, width) {
  let best = 0, bestScore = -1;
  for (let c = 0; c < width; c++) {
    const p = colProfile(table, from, c);
    const score = p.n ? (p.text / p.n) * p.n : 0;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** The sheet to use: the first that reads cleanly, else the first that reads at all. */
export function chooseSheet(sheets, ctx) {
  const tries = sheets.map((s) => ({ sheet: s, an: analyze(s.rows, ctx) }));
  return tries.find((t) => t.an.ok && !t.an.needPicker) || tries.find((t) => t.an.ok) || tries[0] || null;
}

// ---------------------------------------------------------------- rows
const idText = (v) => {
  const s = clean(v);
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s;
};

/** The data rows under the chosen columns:
 *  [{i (row in the table), text, name, hints, idHint, team, pos, id, idFd, pts}] and what was skipped.
 *  idFd: the id column looks like FanDuel's (its header says FD or FanDuel, or most of its values
 *  are "<fixture>-<player>"), the only column whose bare player numbers are matched to FanDuel ids. */
export function extractRows(table, ch) {
  const rows = [];
  const skipped = { totals: 0, noPoints: 0, noName: 0 };
  const get = (cells, i) => (i == null || i < 0 ? "" : clean(cells[i]));
  const start = (ch.headerRow ?? -1) + 1;
  let idFd = false;
  if (ch.id != null) {
    const head = ch.headerRow >= 0 && table[ch.headerRow] ? normHeader(table[ch.headerRow][ch.id]) : "";
    if (siteTag(head) === "fd") idFd = true;
    else {
      let n = 0, dashed = 0;
      for (let r = start; r < Math.min(table.length, start + 400); r++) {
        const v = idText(table[r][ch.id]);
        if (!v) continue;
        n++;
        if (/^\d+-\d+$/.test(v)) dashed++;
      }
      idFd = n > 0 && dashed / n >= 0.5;
    }
  }
  for (let r = start; r < table.length; r++) {
    const cells = table[r];
    if (nonEmpty(cells) === 0) continue;
    let full = get(cells, ch.name);
    if (!full && (ch.first != null || ch.last != null)) full = `${get(cells, ch.first)} ${get(cells, ch.last)}`.trim();
    if (!full || parseNumber(full, true) !== null) { skipped.noName++; continue; }
    if (isTotalsLabel(full)) { skipped.totals++; continue; }
    const pts = parseNumber(get(cells, ch.pts), !!ch.decimalComma);
    if (pts === null) { skipped.noPoints++; continue; }
    const nc = parseNameCell(full);
    rows.push({
      i: r, text: full, name: nc.name, hints: nc.hints, idHint: nc.idHint,
      team: get(cells, ch.team), pos: get(cells, ch.pos), id: idText(cells[ch.id ?? -1]), idFd, pts,
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------- matching
const DEF_WORDS = /\b(dst|def|defense|defence|special teams|team)\b/g;
const OFF_SLATE = "\u0000off";      // a team the file names that is not on this slate: matches no player

/** Index the slate once; `match(row)` then answers for each file row.
 *  players: dfs.json players; teams: its {abbr: {name}}; aliases: its alias table. */
export function buildMatcher({ players, teams, aliases, sport }) {
  const abbrs = new Set(players.map((p) => p.team));
  const resolver = makeTeamResolver({ teams, sport, abbrs });
  const levels = [new Map(), new Map(), new Map()];
  const byId = new Map();
  const bare = new Map();
  const dst = new Map();
  const slatePos = new Set(players.map((p) => p.pos));
  for (const p of players) {
    nameKeys(p.name, aliases).forEach((k, l) => {
      if (!k) return;
      if (!levels[l].has(k)) levels[l].set(k, []);
      levels[l].get(k).push(p);
    });
    byId.set(String(p.id), p);
    const tail = String(p.id).includes("-") ? String(p.id).split("-").pop() : null;
    if (tail) bare.set(tail, bare.has(tail) ? null : p);
    if (p.pos === "DST") dst.set(p.team, dst.has(p.team) ? null : p);
  }
  const hasDst = dst.size > 0;

  function sameName(row, p) {
    const a = nameKeys(row.name, aliases), b = nameKeys(p.name, aliases);
    if (a.some((x, i) => x && x === b[i])) return true;
    const la = a[1].split(" ").pop(), lb = b[1].split(" ").pop();
    return !!la && la === lb;
  }

  // a name cell read as a defense: the words that say so removed, what is left an exact team word
  function defenseWords(row) {
    const words = String(row.name).toLowerCase().replace(/d\s*\/\s*st/g, " dst ").replace(/[.'`’]/g, "")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    let stripped = words.replace(DEF_WORDS, " ").replace(/\s+/g, " ").trim();
    let tagged = stripped !== words;
    if (!tagged) {
      // "Bills D": a lone D counts only when what is left is a team (D'Andre Swift is a back, not a defense)
      const s2 = stripped.replace(/(^| )d( |$)/g, " ").replace(/\s+/g, " ").trim();
      if (s2 !== stripped && resolver.resolveExact(s2)) { stripped = s2; tagged = true; }
    }
    return { stripped, tagged };
  }

  // positions and a team out of the pos cell, the hints and the team cell. A team or position
  // the file names stays a condition: it must fit a candidate or the row matches nobody.
  function context(row, extraHints = []) {
    const pos = posTokens(row.pos);
    let team = null, off = false;
    const take = (text) => {
      if (team || off) return;
      team = resolver.resolve(text);
      if (!team && resolver.offSlate(text)) off = true;
    };
    take(row.team);
    for (const h of [...row.hints, ...extraHints]) {
      if (/^D$/i.test(h)) {
        // "(D)" is often an injury tag: a defense only when the name itself is one
        if (resolver.resolveExact(defenseWords(row).stripped)) pos.add("DST");
        continue;
      }
      const pt = posTokens(h);
      if (pt.size) pt.forEach((x) => pos.add(x));
      else take(h);
    }
    return { pos, team: team || (off ? OFF_SLATE : null) };
  }

  // is this row a defense, and whose
  function defenseInfo(row, ctx) {
    if (!hasDst) return null;
    const { stripped, tagged } = defenseWords(row);
    const fromName = stripped ? resolver.resolveExact(stripped) : null;
    // with no position at all, a bare team word ("Bills", "BUF") is its defense; "Dallas Goedert" is not
    const bareTeam = !ctx.pos.size && !tagged && !!fromName;
    if (!ctx.pos.has("DST") && !tagged && !bareTeam) return null;
    return { team: fromName || ctx.team };
  }

  function byIdStep(row) {
    let ctx = null;
    for (const raw of [row.id, row.idHint]) {
      const id = idText(raw);
      if (!id) continue;
      let p = byId.get(id);
      if (!p && raw === row.id && (row.idFd || /^\d+-\d+$/.test(id))) {
        p = bare.get(id) || (id.includes("-") ? bare.get(id.split("-").pop()) : null);
      }
      if (!p) continue;
      if (!row.name || sameName(row, p)) return p;
      if (p.pos === "DST") {
        ctx = ctx || context(row);
        const d = defenseInfo(row, ctx);
        if (d && d.team === p.team) return p;
      }
    }
    return null;
  }

  function defenseStep(row, ctx) {
    const d = defenseInfo(row, ctx);
    if (!d) return null;
    const p = d.team ? dst.get(d.team) : null;
    return p ? { status: "nameteam", player: p } : { status: "none", defense: true };
  }

  function nameStep(row, ctx, name) {
    const keys = nameKeys(name, aliases);
    for (let l = 0; l < 3; l++) {
      const k = keys[l];
      const cands = k ? levels[l].get(k) : null;
      if (!cands || !cands.length) continue;
      let pool = cands, withTeam = false;
      if (ctx.team) {
        pool = pool.filter((p) => p.team === ctx.team);
        if (!pool.length) return { status: "none", conflict: "team" };
        withTeam = true;
      }
      if (ctx.pos.size) {
        pool = pool.filter((p) => ctx.pos.has(p.pos));
        if (!pool.length) return { status: "none", conflict: "position" };
      }
      if (pool.length === 1) return { status: withTeam ? "nameteam" : "name", player: pool[0] };
      return { status: "ambiguous", cands: pool };
    }
    return null;
  }

  // "Josh Allen BUF QB": peel trailing position and team codes off a plain name
  function peeled(row) {
    const toks = row.name.split(/\s+/);
    const codes = [];
    while (toks.length > 2 && codes.length < 2 && /^[A-Z]{1,5}$/.test(toks[toks.length - 1]) && toks[toks.length - 1] !== "D" &&
      (posTokens(toks[toks.length - 1]).size || resolver.resolveExact(toks[toks.length - 1]))) {
      codes.unshift(toks.pop());
    }
    return codes.length ? { name: toks.join(" "), codes } : null;
  }

  return {
    resolver,
    hasDst,
    knownPos: slatePos,
    match(row) {
      const p = byIdStep(row);
      if (p) return { status: "id", player: p };
      const ctx = context(row);
      const d = defenseStep(row, ctx);
      if (d) return d;
      const r = nameStep(row, ctx, row.name);
      if (r) return r;
      const pe = peeled(row);
      if (pe) {
        const r2 = nameStep(row, context(row, pe.codes), pe.name);
        if (r2) return r2;
      }
      return { status: "none" };
    },
  };
}

/** Everything the report needs, from the rows, their match results and the visitor's hand picks.
 *  manual: {rowKey: playerId | "skip"}. Counts and the override map {playerId: points}. */
export function assemble(rows, results, manual, players) {
  const man = manual || {};
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const override = {};
  const kind = { id: 0, nameteam: 0, name: 0, hand: 0 };
  const unmatched = [], ambiguous = [];
  let skipped = 0, repeats = 0, matched = 0;
  rows.forEach((row, n) => {
    const res = results[n] || { status: "none" };
    const pick = man[String(row.i)];
    if (pick === SKIP) { skipped++; return; }
    let pl = null, how = null;
    if (pick && byId.has(String(pick))) { pl = byId.get(String(pick)); how = "hand"; }
    else if (res.status === "id" || res.status === "nameteam" || res.status === "name") { pl = res.player; how = res.status; }
    if (!pl) {
      (res.status === "ambiguous" ? ambiguous : unmatched).push({ row, cands: res.cands || [] });
      return;
    }
    const id = String(pl.id);
    if (Object.prototype.hasOwnProperty.call(override, id)) { repeats++; return; }
    override[id] = row.pts;
    kind[how]++;
    matched++;
  });
  const byPts = (a, b) => b.row.pts - a.row.pts || a.row.i - b.row.i;
  unmatched.sort(byPts);
  ambiguous.sort(byPts);
  return { override, matched, total: rows.length, kind, unmatched, ambiguous, skipped, repeats };
}

/** Players on the slate the file does not name (with a SharpSlate projection to give up). */
export function missingIds(players, override) {
  return players
    .filter((p) => p.proj != null && !Object.prototype.hasOwnProperty.call(override, String(p.id)))
    .map((p) => String(p.id));
}

// ---------------------------------------------------------------- remembering
const KEY_PREFIX = "sharpslate.proj.v1";
const MAX_COLS = 40;
/** A saved file older than this many days is dropped, and no more than KEEP_NEWEST are kept. */
export const KEEP_DAYS = 21;
export const KEEP_NEWEST = 6;

/** One saved file per sport, site and slate (a different slate starts clean). */
export function storageKey(sport, site, slateId) {
  return `${KEY_PREFIX}.${sport}.${site}.${slateId}`;
}

/** The copy that goes to the browser's storage. The whole table stays in memory for matching;
 *  this one keeps at most `maxRows` rows and MAX_COLS columns, always the chosen columns and
 *  `keepCols` (the points candidates), with the choices renumbered to match.
 *  Returns {table, choices, partial}; partial is {rows, of} when rows were cut. */
export function slimForStorage(table, choices, keepCols = [], maxRows = 6000) {
  const chosen = ["name", "first", "last", "team", "pos", "id", "pts"].map((k) => choices[k]).filter((v) => v != null);
  const must = new Set([...chosen, ...keepCols]);
  const width = Math.max(0, ...table.slice(0, 200).map((r) => r.length));
  const cols = new Set(must);
  for (let c = 0; c < width && cols.size < Math.max(MAX_COLS, must.size); c++) cols.add(c);
  const keep = [...cols].sort((a, b) => a - b);
  const remap = new Map(keep.map((c, i) => [c, i]));
  const cut = (v) => (String(v == null ? "" : v).length > 120 ? String(v).slice(0, 120) : String(v == null ? "" : v));
  const out = table.slice(0, maxRows).map((r) => keep.map((c) => cut(r[c])));
  const ch = { ...choices };
  for (const k of ["name", "first", "last", "team", "pos", "id", "pts"]) ch[k] = choices[k] == null ? null : remap.get(choices[k]);
  return { table: out, choices: ch, partial: table.length > maxRows ? { rows: maxRows, of: table.length } : null };
}

/** Drop saved files that are old (KEEP_DAYS) or beyond the newest KEEP_NEWEST, never `keepKey`. */
export function pruneUploads(store, now, keepKey = "") {
  try {
    if (!store) return 0;
    const found = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k || !k.startsWith(KEY_PREFIX + ".")) continue;
      let t = 0;
      try { t = Number(JSON.parse(store.getItem(k)).savedAt) || 0; } catch { /* unreadable: oldest */ }
      found.push({ k, t });
    }
    found.sort((a, b) => b.t - a.t);
    const cutoff = now - KEEP_DAYS * 86400000;
    let removed = 0;
    found.forEach((f, i) => {
      if (f.k === keepKey) return;
      if (f.t < cutoff || i >= KEEP_NEWEST) { store.removeItem(f.k); removed++; }
    });
    return removed;
  } catch {
    return 0;
  }
}

export function saveUpload(store, key, payload) {
  try {
    if (!store) return false;
    store.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function loadUpload(store, key) {
  try {
    if (!store) return null;
    const raw = store.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.v === 1 && Array.isArray(o.table) && o.choices ? o : null;
  } catch {
    return null;
  }
}

export function clearUpload(store, key) {
  try {
    if (store) store.removeItem(key);
  } catch { /* storage is a convenience */ }
}
