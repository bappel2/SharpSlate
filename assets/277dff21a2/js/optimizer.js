// SharpSlate lineup optimizer: DraftKings and FanDuel Classic rosters solved as a
// mixed-integer program in the visitor's browser (HiGHS, compiled to
// WebAssembly and served from assets/vendor/highs-1.15.3).
//
// A port of core/nfl/optimize.py `solve`, generic over the roster spec in each
// sport's dfs.json so every sport shares one solver:
//   * one binary per (player, eligible slot type), slot counts met exactly
//   * each player at most once; locks force him in, pins force him into a
//     slot type, excludes drop him
//   * salary under the cap
//   * at least two games: no game may supply more than size - 1 players
//     (exact while min_games is 2, the only value DK uses)
//   * an optional team cap (opts.teamCap): at most that many non-DST players
//     from one team, raised to 1 + qbStack for a team whose QB is chosen with
//     a stack (owner 2026-10-01: "two at most unless the settings are
//     utilized"). A team the visitor forced past the cap keeps what he forced.
//   * a site team rule (rules.max_per_team, FanDuel's four): no more than that
//     many players from one team, the DST counted. FanDuel also wants players
//     from at least three teams; with nine seats that follows from a cap of
//     four or less (4 + 4 < 9), so one row per team enforces both. The
//     visitor's teamCap above is a tighter limit on top of this one.
//   * optional QB stack, bring-back and DST-opponent rules, written as
//     implications per candidate QB/DST so they bind only when he is chosen.
//     The stack's pass catchers are rules.stack_positions (NFL default WR/TE;
//     CFB lists tight ends as WR, so WR alone)
//   * several lineups: each new one may share at most maxOverlap players with
//     any earlier one
// Objective: maximize sum(proj - risk * sd). risk < 0 leans to ceiling.
// After each solve every flex seat (a slot taking more than one position:
// NFL's FLEX, CFB's S-FLEX then FLEX, widest first) goes to the latest kickoff
// among players who could legally sit there (core/nfl/optimize.py
// seat_flex_last, generalized; tools/sharpslate_parity.py seat_flex_last is
// the Python twin).
//
// The /selftest/ page (sharpslate/selftest.py) solves the cases in
// tools/sharpslate_parity.py here and in Python on the same data; totals must match.

let _highs = null;

export async function loadSolver() {
  if (_highs) return _highs;
  // this file is assets/<hash>/js/optimizer.js; the solver has one stable
  // home at assets/vendor/highs-<its version>/ (sharpslate/build.py VENDOR)
  const base = new URL("../../vendor/highs-1.15.3/", import.meta.url);
  const mod = await import(new URL("highs.mjs", base).href);
  _highs = await mod.default({ locateFile: (f) => new URL(f, base).href });
  return _highs;
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "_");

// Which slot types a player may fill. A sport whose players carry several
// positions (NBA "PG/SG") lists them per player as `slots`; otherwise the
// slot's `eligible` positions decide.
export const canFill = (p, s) => (Array.isArray(p.slots) ? p.slots.includes(s.key) : s.eligible.includes(p.pos));
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

// Coefficients print without exponent notation and without "-0".
function coef(c) {
  const r = Math.round(c * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
}

// "a x1 + b x2 - c x3" with line breaks so no LP line runs long.
function expr(terms) {
  const out = [];
  terms.forEach(([c, v], k) => {
    const sign = c < 0 ? "-" : "+";
    const body = `${coef(Math.abs(c))} ${v}`;
    out.push(k === 0 ? (c < 0 ? `- ${body}` : body) : `${sign} ${body}`);
  });
  const lines = [];
  for (let k = 0; k < out.length; k += 8) lines.push(out.slice(k, k + 8).join(" "));
  return lines.join("\n   ") || "0 dummy";
}

// Expand the slot types into the nine display seats: QB, RB, RB, WR, ...
export function seatsOf(roster) {
  const seats = [];
  for (const s of roster.slots) {
    for (let k = 0; k < s.count; k++) seats.push({ slot: s.key, label: s.label || s.key });
  }
  return seats;
}

// The pool the solver sees, after overrides, projections and exclusions.
function preparePool(data, opts) {
  const over = opts.projOverride || {};
  // ids treated as having no projection (the visitor's "leave out players my
  // file does not list"): in only when kept by hand, like any unprojected player
  const noProj = new Set((opts.noProj || []).map(String));
  const excl = new Set((opts.excludes || []).map(String));
  const forced = new Set([...(opts.locks || []), ...(opts.pins || []).map((p) => p.id)].map(String));
  const clash = [...forced].filter((id) => excl.has(id));
  if (clash.length) {
    const names = clash.map((id) => (data.players.find((p) => String(p.id) === id) || {}).name || id);
    return { error: `Can't both keep and exclude: ${names.join(", ")}.` };
  }
  const floor = Number(opts.playerSalaryFloor) || 0;
  const pool = [];
  for (const p of data.players) {
    const id = String(p.id);
    if (excl.has(id)) continue;
    // a salary floor (owner 2026-10-01: "i dont want anyone under $4600 ... it
    // should not include DEF"): cheaper players stay out unless kept by hand
    if (floor && p.pos !== "DST" && Number(p.salary) < floor && !forced.has(id)) continue;
    let proj = id in over ? num(over[id]) : noProj.has(id) ? null : num(p.proj);
    if (proj === null) {
      // No projection: in only when pinned (at 0). A switch that let every
      // such player in at 0 was removed 2026-09-27: at 0 the solver never
      // picked one (20 of 20 lineups identical either way, at risk 0 and at
      // the old GPP lean).
      if (!forced.has(id)) continue;
      proj = 0;
    }
    pool.push({ ...p, id, proj, sd: num(p.sd) ?? 0 });
  }
  return { pool };
}

// Build the LP text for one solve. `cuts` holds earlier lineups (arrays of
// pool indices) for the overlap rule.
function buildLP(data, pool, opts, cuts) {
  const roster = data.roster;
  const size = roster.size;
  const risk = Number(opts.risk) || 0;
  const vars = []; // {i, slot, name}
  const byPlayer = pool.map(() => []);
  pool.forEach((p, i) => {
    for (const s of roster.slots) {
      if (canFill(p, s)) {
        const name = `x${i}_${safe(s.key)}`;
        vars.push({ i, slot: s.key, name });
        byPlayer[i].push(name);
      }
    }
  });
  const rows = [];
  let rc = 0;
  const row = (terms, sense, rhs) => {
    if (terms.length) rows.push(` c${rc++}: ${expr(terms)} ${sense} ${coef(rhs)}`);
  };

  // exactly the required bodies in every slot type
  for (const s of roster.slots) {
    row(vars.filter((v) => v.slot === s.key).map((v) => [1, v.name]), "=", s.count);
  }
  // each player at most once; locks and pins force him in
  const forced = new Set([...(opts.locks || []), ...(opts.pins || []).map((p) => p.id)].map(String));
  pool.forEach((p, i) => {
    if (byPlayer[i].length) row(byPlayer[i].map((n) => [1, n]), forced.has(p.id) ? "=" : "<=", 1);
  });
  // pins: the exact (player, slot type) variable is on
  for (const pin of opts.pins || []) {
    const i = pool.findIndex((p) => p.id === String(pin.id));
    const v = vars.find((x) => x.i === i && x.slot === pin.slot);
    if (v) row([[1, v.name]], "=", 1);
  }
  // salary
  row(vars.map((v) => [pool[v.i].salary, v.name]), "<=", roster.cap);
  if (opts.minSalary) row(vars.map((v) => [pool[v.i].salary, v.name]), ">=", opts.minSalary);

  // two-game minimum: no game supplies more than size - 1
  const games = new Map();
  vars.forEach((v) => {
    const g = pool[v.i].game || "?";
    if (!games.has(g)) games.set(g, []);
    games.get(g).push(v);
  });
  for (const [, vs] of games) {
    if (new Set(vs.map((v) => v.i)).size > size - 1) row(vs.map((v) => [1, v.name]), "<=", size - 1);
  }

  const qbs = pool.map((p, i) => i).filter((i) => pool[i].pos === "QB" && byPlayer[i].length);
  const qbStack = Number(opts.qbStack) || 0;
  const bringBack = Number(opts.bringBack) || 0;
  const catchers = (data.rules && data.rules.stack_positions) || ["WR", "TE"];
  for (const q of qbs) {
    const qTerms = (k) => byPlayer[q].map((n) => [-k, n]);
    if (qbStack) {
      const mates = vars.filter((v) => catchers.includes(pool[v.i].pos) && pool[v.i].team === pool[q].team);
      row([...mates.map((v) => [1, v.name]), ...qTerms(qbStack)], ">=", 0);
    }
    if (bringBack) {
      const opp = vars.filter((v) => pool[v.i].game === pool[q].game && pool[v.i].team !== pool[q].team && pool[v.i].pos !== "DST");
      row([...opp.map((v) => [1, v.name]), ...qTerms(bringBack)], ">=", 0);
    }
  }
  // team cap: per team, (its non-DST players) - extra * (its QB) <= cap.
  // cap is the visitor's number, or more when he kept more of that team by hand.
  // extra is what a stacked QB adds: 1 + the stack (or the catchers he kept, if
  // more) + the other players he kept. One QB per team, so the allowance is
  // granted once even where a flex seat takes a QB (CFB's S-FLEX; Fable 10/01).
  // Exact, no indicator variables: the QB term loosens the row only when he plays.
  const teamCap = Number(opts.teamCap) || 0;
  if (teamCap) {
    const teams = new Map();
    vars.forEach((v) => {
      const p = pool[v.i];
      if (p.pos === "DST" || !p.team) return;
      if (!teams.has(p.team)) teams.set(p.team, []);
      teams.get(p.team).push(v);
    });
    for (const [, vs] of teams) {
      const people = [...new Set(vs.map((v) => v.i))];
      const qbVars = vs.filter((v) => pool[v.i].pos === "QB");
      if (qbVars.length && new Set(qbVars.map((v) => v.i)).size > 1) row(qbVars.map((v) => [1, v.name]), "<=", 1);
      const kept = people.filter((i) => forced.has(pool[i].id));
      const cap = Math.max(teamCap, kept.length);
      const keptCatch = kept.filter((i) => catchers.includes(pool[i].pos)).length;
      const keptOther = kept.filter((i) => pool[i].pos !== "QB" && !catchers.includes(pool[i].pos)).length;
      const extra = qbStack ? Math.max(0, 1 + Math.max(qbStack, keptCatch) + keptOther - cap) : 0;
      if (people.length <= cap) continue;
      row(vs.map((v) => [pool[v.i].pos === "QB" && extra ? 1 - extra : 1, v.name]), "<=", cap);
    }
  }
  // site team rule: per team, ALL its players (the DST too) <= rules.max_per_team.
  // A cap of 4 or less on nine seats also gives FanDuel's three team minimum.
  const siteCap = Number(data.rules && data.rules.max_per_team) || 0;
  if (siteCap) {
    const byTeam = new Map();
    vars.forEach((v) => {
      const t = pool[v.i].team;
      if (!t) return;
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t).push(v);
    });
    for (const [, vs] of byTeam) {
      if (new Set(vs.map((v) => v.i)).size > siteCap) row(vs.map((v) => [1, v.name]), "<=", siteCap);
    }
  }
  if (opts.blockDstOpponents) {
    const m = size - 1;
    pool.forEach((d, di) => {
      if (d.pos !== "DST" || !byPlayer[di].length) return;
      const opp = vars.filter((v) => pool[v.i].game === d.game && pool[v.i].team !== d.team);
      if (opp.length) row([...opp.map((v) => [1, v.name]), ...byPlayer[di].map((n) => [m, n])], "<=", m);
    });
  }
  // overlap cuts against every earlier lineup
  const maxOverlap = Number.isFinite(Number(opts.maxOverlap)) ? Number(opts.maxOverlap) : size - 2;
  for (const cut of cuts) {
    const seen = new Set(cut);
    row(vars.filter((v) => seen.has(v.i)).map((v) => [1, v.name]), "<=", maxOverlap);
  }

  const obj = vars.map((v) => [pool[v.i].proj - risk * pool[v.i].sd, v.name]);
  const lp = [
    "Maximize",
    ` obj: ${expr(obj)}`,
    "Subject To",
    ...rows,
    "Bounds",
    ...vars.map((v) => ` 0 <= ${v.name} <= 1`),
    "Generals",
    ...chunk(vars.map((v) => v.name), 12).map((c) => ` ${c.join(" ")}`),
    "End",
  ].join("\n");
  return { lp, vars };
}

function chunk(a, n) {
  const out = [];
  for (let k = 0; k < a.length; k += n) out.push(a.slice(k, k + n));
  return out;
}

const kickMs = (p) => {
  const t = p && p.kick ? Date.parse(p.kick) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

// Can these players (pool indices) fill these seats (slot keys), one each?
// Augmenting paths; a roster is eight or nine seats.
function seatable(who, seats, pool, bySlot) {
  const owner = new Array(seats.length).fill(-1);
  const place = (w, seen) => {
    for (let k = 0; k < seats.length; k++) {
      if (seen[k] || !canFill(pool[who[w]], bySlot.get(seats[k]))) continue;
      seen[k] = true;
      if (owner[k] < 0 || place(owner[k], seen)) { owner[k] = w; return true; }
    }
    return false;
  };
  return who.every((_, w) => place(w, new Array(seats.length).fill(false)));
}

// Seat `kb`'s player takes seat `kh`; the player he displaces moves along the
// shortest chain of legal moves that ends in the seat he left, so as few men
// as possible change seats (a direct swap when one is legal). Only `open`
// seats move.
function reseat(cur, kb, kh, open, pool, bySlot) {
  const holder = cur[kh].i;
  const seats = open.filter((k) => k !== kh);
  const parent = new Map();
  const queue = [-1];
  let found = false;
  while (queue.length && !found) {
    const from = queue.shift();
    const who = from < 0 ? holder : cur[from].i;
    for (const k of seats) {
      if (parent.has(k) || !canFill(pool[who], bySlot.get(cur[k].slot))) continue;
      parent.set(k, from);
      if (k === kb) { found = true; break; }
      queue.push(k);
    }
  }
  if (!found) return cur; // never leave a lineup unseatable
  const next = cur.map((c) => ({ ...c }));
  next[kh] = { ...next[kh], i: cur[kb].i };
  for (let k = kb; k !== -1; k = parent.get(k)) {
    const from = parent.get(k);
    next[k] = { ...next[k], i: from < 0 ? holder : cur[from].i };
  }
  return next;
}

// Every flex seat (a slot taking more than one position), widest first, goes
// to the latest kickoff among the unpinned men who could sit there with the
// rest of the lineup still legally seated; then that seat is settled. With
// one FLEX (NFL) that is exactly the men of the FLEX holder's position, as
// core/nfl/optimize.py seat_flex_last has it. Ties never move, and an
// unreadable kickoff never takes a seat. Only seats change, never players.
export function seatFlexLast(chosen, pool, pinnedIds, slots) {
  if (!slots) return chosen;
  const bySlot = new Map(slots.map((s) => [s.key, s]));
  const flexKeys = slots.filter((s) => (s.eligible || []).length > 1)
    .sort((a, b) => b.eligible.length - a.eligible.length).map((s) => s.key);
  let cur = chosen.map((c) => ({ ...c }));
  const fixed = new Set();
  cur.forEach((c, k) => { if (pinnedIds.has(pool[c.i].id)) fixed.add(k); });
  for (const key of flexKeys) {
    for (let kh = 0; kh < cur.length; kh++) {
      if (cur[kh].slot !== key || fixed.has(kh)) continue;
      const open = cur.map((_, k) => k).filter((k) => !fixed.has(k));
      const rest = open.filter((k) => k !== kh).map((k) => cur[k].slot);
      const cands = open.filter((k) => canFill(pool[cur[k].i], bySlot.get(key))
        && seatable(open.filter((x) => x !== k).map((x) => cur[x].i), rest, pool, bySlot));
      if (cands.length) {
        const best = cands.reduce((a, b) => (kickMs(pool[cur[b].i]) > kickMs(pool[cur[a].i]) ? b : a));
        if (kickMs(pool[cur[best].i]) > kickMs(pool[cur[kh].i])) cur = reseat(cur, best, kh, open, pool, bySlot);
      }
      fixed.add(kh);
    }
  }
  return cur;
}

function seatLineup(data, chosen, pool) {
  const seats = seatsOf(data.roster);
  const left = [...chosen].sort((a, b) => a.i - b.i);
  return seats.map((seat) => {
    const k = left.findIndex((c) => c.slot === seat.slot);
    const c = k >= 0 ? left.splice(k, 1)[0] : null;
    return { slot: seat.slot, label: seat.label, player: c ? pool[c.i] : null };
  });
}

// Quick checks that turn a guaranteed-infeasible request into a sentence.
function precheck(data, pool, opts) {
  const perSlot = {};
  for (const pin of opts.pins || []) perSlot[pin.slot] = (perSlot[pin.slot] || 0) + 1;
  for (const s of data.roster.slots) {
    if ((perSlot[s.key] || 0) > s.count) return `More players are picked for ${s.label || s.key} than it has seats.`;
  }
  for (const pin of opts.pins || []) {
    const p = pool.find((x) => x.id === String(pin.id));
    const s = data.roster.slots.find((x) => x.key === pin.slot);
    if (p && s && !canFill(p, s)) return `${p.name} (${p.pos}) can't fill ${s.label || s.key}.`;
  }
  if ((opts.qbStack || opts.bringBack) && !pool.some((p) => p.pos === "QB")) {
    return "The stacking rules need a quarterback in the pool.";
  }
  if (Number(opts.teamCap)) {
    const forced = new Set([...(opts.locks || []), ...(opts.pins || []).map((p) => p.id)].map(String));
    const keptQbTeams = pool.filter((p) => p.pos === "QB" && forced.has(p.id)).map((p) => p.team);
    if (new Set(keptQbTeams).size < keptQbTeams.length) return "A lineup takes one quarterback per team. Keep just one of them.";
  }
  return siteTeamPrecheck(data, pool, opts);
}

const WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };

// The site's team rule (rules.max_per_team: FanDuel's four, the DST counted)
// against what the visitor forced: players kept or pinned from one team, and
// the pass catchers a QB stack would add around a kept QB. Names the rule in
// the data's own words instead of the generic "no lineup fits".
function siteTeamPrecheck(data, pool, opts) {
  const cap = Number(data.rules && data.rules.max_per_team) || 0;
  if (!cap) return null;
  const forced = new Set([...(opts.locks || []), ...(opts.pins || []).map((p) => p.id)].map(String));
  const catchers = (data.rules && data.rules.stack_positions) || ["WR", "TE"];
  const qbStack = Number(opts.qbStack) || 0;
  const byTeam = new Map();
  for (const p of pool) if (forced.has(p.id) && p.team) byTeam.set(p.team, [...(byTeam.get(p.team) || []), p]);
  for (const [, kept] of byTeam) {
    const hasQb = kept.some((p) => p.pos === "QB");
    const keptCatch = kept.filter((p) => catchers.includes(p.pos)).length;
    const keptOther = kept.filter((p) => p.pos !== "QB" && !catchers.includes(p.pos)).length;
    // with a stacked QB kept: him, the larger of the stack and the catchers kept, and the rest kept
    const need = qbStack && hasQb ? 1 + Math.max(qbStack, keptCatch) + keptOther : kept.length;
    if (need > cap) {
      const def = (data.roster.pos_labels && data.roster.pos_labels.DST) || "DST";
      return `${data.roster.site} allows at most ${WORDS[cap] || cap} players from one team, the ${def} counted.`;
    }
  }
  return null;
}

export async function optimize(data, opts = {}) {
  try {
    const prep = preparePool(data, opts);
    if (prep.error) return { status: "infeasible", message: prep.error, lineups: [] };
    const pool = prep.pool;
    const why = precheck(data, pool, opts);
    if (why) return { status: "infeasible", message: why, lineups: [] };
    const highs = await loadSolver();
    const pinned = new Set((opts.pins || []).map((p) => String(p.id)));
    const want = Math.max(1, Math.min(Number(opts.lineups) || 1, (data.rules && data.rules.max_lineups) || 20));
    const cuts = [];
    const lineups = [];
    for (let n = 0; n < want; n++) {
      const { lp, vars } = buildLP(data, pool, opts, cuts);
      const res = highs.solve(lp, { output_flag: false, mip_rel_gap: 0 });
      if (res.Status !== "Optimal") {
        if (!lineups.length) {
          const floor = Number(opts.playerSalaryFloor) || 0;
          return {
            status: "infeasible",
            // a floor is the likeliest reason, so name it (Fable 10/01)
            message: floor
              ? `No lineup fits under the cap with nobody below $${floor.toLocaleString("en-US")}. Lower the minimum salary, loosen a rule or remove a pick.`
              : "No lineup fits those rules under the cap. Loosen a rule or remove a pick.",
            lineups: [],
          };
        }
        break; // fewer distinct lineups exist than were asked for
      }
      let chosen = vars.filter((v) => (res.Columns[v.name] || {}).Primal > 0.5).map((v) => ({ i: v.i, slot: v.slot }));
      chosen = seatFlexLast(chosen, pool, pinned, data.roster.slots);
      const idxs = chosen.map((c) => c.i);
      lineups.push({
        slots: seatLineup(data, chosen, pool),
        salary: idxs.reduce((s, i) => s + pool[i].salary, 0),
        proj: idxs.reduce((s, i) => s + pool[i].proj, 0),
        value: res.ObjectiveValue,
      });
      cuts.push(idxs);
    }
    const message = lineups.length < want ? `Only ${lineups.length} distinct lineups fit those rules.` : "";
    return { status: "ok", message, lineups };
  } catch (e) {
    _highs = null; // a crashed WebAssembly instance is not reusable
    return { status: "error", message: `The optimizer hit an error: ${e && e.message ? e.message : e}`, lineups: [] };
  }
}

// Exposed for the parity test: the exact LP text for a given request.
export function modelText(data, opts = {}, cuts = []) {
  const prep = preparePool(data, opts);
  if (prep.error) return null;
  return buildLP(data, prep.pool, opts, cuts).lp;
}
