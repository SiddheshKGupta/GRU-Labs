// The Workbench page: one self-contained HTML document, no external files.
//
// Live mode polls /api/state from `gru workbench`; snapshot mode carries a
// WorkbenchView inline. Everything that came from a ledger is inserted with
// textContent, never as markup, because Minion text is untrusted (T3/T4).
// The avatars are hand-drawn pixel fan art of Gru, Dru, Dr. Nefario and the
// Minions, at the Director's request for personal, non-commercial use (CDR-008).

import type { WorkbenchView } from "./model.ts";

export type PageMode = { mode: "live"; pollMs?: number } | { mode: "snapshot"; view: WorkbenchView };

/** JSON safe to place inside a <script> element: no "<" survives, so no "</script>". */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

const STYLE = `
:root { color-scheme: dark; --bg:#0b0f16; --panel:#121925; --panel2:#0f1520; --line:#23304a; --fg:#dbe4f0; --muted:#8393ab;
  --accent:#e2a93b; --ok:#4fc38a; --warn:#e0b04f; --bad:#ef6b6b; --info:#6fa8ff; --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --sans: system-ui, "Segoe UI", Roboto, sans-serif; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.45 var(--sans); }
.wb { padding: 14px 16px 28px; display:grid; gap:12px; max-width: 1480px; margin:0 auto; }
header { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 16px; }
header h1 { margin:0; font:700 18px/1.2 var(--mono); letter-spacing:.08em; color:var(--accent); }
header .meta { color:var(--muted); font:12px var(--mono); }
.badge { font:600 11px var(--mono); padding:2px 8px; border-radius:3px; border:1px solid var(--line); color:var(--muted); }
.badge.live { color:var(--ok); border-color:var(--ok); }
.grid { display:grid; gap:12px; grid-template-columns: repeat(12, minmax(0,1fr)); }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px; min-width:0; display:flex; flex-direction:column; gap:8px; }
.panel h2 { margin:0; font:700 12px/1.2 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--accent); display:flex; justify-content:space-between; gap:8px; }
.panel h2 small { color:var(--muted); font-weight:400; letter-spacing:0; text-transform:none; }
.role { grid-column: span 3; }
.term, .queue { grid-column: span 3; }
.roster { grid-column: span 12; }
.term { gap:6px; } .term-head { display:flex; justify-content:space-between; align-items:center; } .term-head .win { color:var(--muted); font:12px var(--mono); letter-spacing:.2em; }
.tabs { display:flex; gap:2px; border-bottom:1px solid var(--line); }
.tab { background:none; border:0; border-bottom:2px solid transparent; color:var(--muted); font:600 11px var(--mono); letter-spacing:.06em; padding:4px 8px; cursor:pointer; }
.tab.on { color:var(--fg); border-bottom-color:var(--accent); } .tab:focus-visible, .ghost:focus-visible { outline:2px solid var(--accent); }
.term .log { max-height: 300px; min-height: 220px; background:var(--panel2); border-radius:4px; padding:6px 8px; }
.log .msg { color:var(--fg); } .log .who { color:var(--muted); }
.cmd { display:flex; align-items:center; gap:6px; background:var(--panel2); border:1px solid var(--line); border-radius:4px; padding:4px 8px; }
.cmd .prompt { color:var(--accent); font:700 12px var(--mono); }
.cmd input { flex:1; min-width:0; background:transparent; border:0; color:var(--fg); font:12px var(--mono); outline:none; }
.qactions { display:flex; gap:6px; margin-top:auto; } .qactions .replay { margin-left:auto; }
.ghost { background:none; border:1px solid var(--line); color:var(--muted); border-radius:3px; font:700 11px var(--mono); padding:3px 10px; }
.ghost:disabled { opacity:.55; cursor:not-allowed; }
.table-wrap { overflow-x:auto; } table { border-collapse:collapse; width:100%; min-width:900px; font:12px var(--mono); }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:10.5px; letter-spacing:.06em; }
td.n { text-align:right; font-variant-numeric: tabular-nums; } tr.total td { font-weight:700; border-top:1px solid var(--accent); }
.feed { grid-column: span 3; grid-row: span 2; }
.minions { grid-column: span 9; }
.span3 { grid-column: span 3; }
@media (max-width: 1100px) { .role, .feed, .span3, .term, .queue { grid-column: span 6; } .minions { grid-column: span 12; } .feed { grid-row: auto; } }
@media (max-width: 640px) { .role, .feed, .span3, .minions, .term, .queue { grid-column: span 12; } }
.scene { display:flex; gap:10px; align-items:flex-end; min-height:92px; background:var(--panel2); border-radius:4px; padding:8px; }
.bubble { position:relative; background:#e9eef6; color:#131a26; border-radius:6px; padding:6px 8px; font:12px/1.35 var(--sans); max-width: 100%; overflow-wrap:anywhere; }
.kv { display:grid; grid-template-columns: auto 1fr; gap:2px 10px; font:12px var(--mono); }
.kv dt { color:var(--muted); } .kv dd { margin:0; overflow-wrap:anywhere; }
.bar { height:6px; background:#1d2638; border-radius:3px; overflow:hidden; } .bar i { display:block; height:100%; background:var(--ok); }
.cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
.card { background:var(--panel2); border:1px solid var(--line); border-radius:5px; padding:8px; display:flex; flex-direction:column; gap:6px; min-width:0; }
.card .name { font:700 11px var(--mono); letter-spacing:.04em; text-transform:uppercase; overflow-wrap:anywhere; }
.card .bubble { font-size:11px; min-height: 2.8em; }
.card .row { display:flex; align-items:center; justify-content:space-between; gap:6px; font:11px var(--mono); color:var(--muted); white-space:nowrap; }
.chip { font:700 10px var(--mono); padding:1px 6px; border-radius:3px; border:1px solid currentColor; }
.PASS { color:var(--ok); } .FAIL { color:var(--bad); } .PARTIAL, .ABANDONED { color:var(--warn); } .RUNNING { color:var(--info); }
.log { font:11.5px/1.5 var(--mono); overflow:auto; max-height: 560px; display:flex; flex-direction:column; gap:1px; }
.log div { overflow-wrap:anywhere; } .log time { color:var(--muted); margin-right:6px; } .log b { font-weight:600; margin-right:6px; }
.t-ok b { color:var(--ok); } .t-warn b { color:var(--warn); } .t-bad b { color:var(--bad); } .t-info b { color:var(--info); }
.list { display:flex; flex-direction:column; gap:6px; font:12px var(--mono); }
.list .item { display:flex; justify-content:space-between; gap:8px; border-bottom:1px dashed var(--line); padding-bottom:4px; }
.list .item span:first-child { overflow-wrap:anywhere; min-width:0; }
.empty { color:var(--muted); font:12px var(--mono); }
.q { display:grid; gap:4px; } .q .step { display:flex; gap:6px; align-items:center; } .q .step span:last-child { margin-left:auto; font:11px var(--mono); } .q .n { width:20px; height:20px; border:1px solid var(--line); border-radius:3px; display:grid; place-items:center; font:11px var(--mono); color:var(--muted); }
.legend { display:flex; flex-wrap:wrap; gap:14px; font:11px var(--mono); color:var(--muted); }
.legend span::before { content:"■ "; } .legend .ok::before{color:var(--ok)} .legend .warn::before{color:var(--warn)} .legend .bad::before{color:var(--bad)} .legend .info::before{color:var(--info)}
svg.sprite { image-rendering: pixelated; shape-rendering: crispEdges; flex: none; }
.replay { font:700 11px var(--mono); color:var(--bg); background:var(--accent); border:0; border-radius:3px; padding:3px 10px; cursor:pointer; }
.replay:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes pop { from { transform: scale(.6); opacity:0; } to { transform: scale(1); opacity:1; } }
@keyframes blink { 50% { opacity: 0; } }
.working svg.sprite { animation: bob .5s ease-in-out infinite; }
.working .bubble { outline: 1px solid var(--info); }
.chip.hidden { visibility:hidden; }
.chip.show { animation: pop .25s ease-out; }
.log .cursor::after { content:"▌"; animation: blink 1s step-end infinite; color:var(--accent); }
.log .fresh { animation: pop .2s ease-out; }
@media (prefers-reduced-motion: reduce) { .working svg.sprite, .chip.show, .log .fresh, .log .cursor::after { animation: none; } }
`;

// Original sprites: rows of palette keys, "." is transparent.
const SCRIPT = `
const SPRITES = {
  minion: ["...k..k...", "..yyyyyy..", ".yyyyyyyy.", "kkggggggkk", ".ygwwwwgy.", ".ygwiiwgy.", ".ygwwwwgy.", ".yyggggyy.", ".yyymmyyy.", ".dddddddd.", ".ddyddydd.", "..dd..dd..", "..kk..kk.."],
  gru: ["....ssss....", "...ssssss...", "..ssssssss..", "..sesssess..", "..sssnnnnss.", "...ssnnnss..", "....sssss...", "..azazazaz..", "..zazazaza..", ".cccccccccc.", "cccccccccccc", "cccccccccccc", "cccccccccccc", ".cccccccccc.", "..cc....cc..", "..kk....kk.."],
  dru: ["...hhhhhh...", "..hhhhhhhh..", "..hssssssh..", "..sesssess..", "..sssnnnnss.", "...ssnnnss..", "....sssss...", "..azazazaz..", "..zazazaza..", ".llllllllll.", "llllllllllll", "llllllllllll", "llllllllllll", ".llllllllll.", "..ll....ll..", "..kk....kk.."],
  nefario: ["....ssss....", "..ssssssssa.", ".ggggsggggs.", ".gwegggweg..", "..ssssnsss..", "...ssnnss...", "....ssss....", "....kkkk....", ".llllllllll.", "llllllllllll", "lkllllllllkl", "llllllllllll", ".llllllllll.", "..ll....ll..", "..kk....kk.."],
};
const PALETTES = {
  gru: { s:"#e9c7a3", e:"#1b1b1b", n:"#d9ae86", a:"#3b3b40", z:"#8e8e96", c:"#222228", k:"#111111" },
  dru: { h:"#f2da6b", s:"#f1d2b0", e:"#1b1b1b", n:"#e0b890", a:"#d8d8dc", z:"#f5f5f7", l:"#f2f2f4", k:"#8a8a90" },
  nefario: { s:"#e8cfb5", a:"#b0b0b0", g:"#5a5f66", w:"#dfe9f2", e:"#1b1b1b", n:"#d2b090", k:"#1b1b1b", l:"#f4f6f8" },
};
const YELLOW = ["#f5d33b", "#f7d84a", "#f2cc2e", "#f6d640"];
function hash(text) { let h = 0; for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; }
function sprite(rows, palette, scale) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "sprite");
  svg.setAttribute("width", rows[0].length * scale); svg.setAttribute("height", rows.length * scale);
  svg.setAttribute("viewBox", "0 0 " + rows[0].length + " " + rows.length);
  svg.setAttribute("aria-hidden", "true");
  rows.forEach((row, y) => [...row].forEach((key, x) => {
    if (key === "." || !palette[key]) return;
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", 1); r.setAttribute("height", 1); r.setAttribute("fill", palette[key]);
    svg.appendChild(r);
  }));
  return svg;
}
function minionSprite(name) {
  return sprite(SPRITES.minion, { k:"#1d1d1d", y: YELLOW[hash(name) % YELLOW.length], g:"#9aa3ad", w:"#ffffff", i:"#6b4423", m:"#3a2a1a", d:"#2f5ea8" }, 4);
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
function panel(title, note, cls) { const p = el("section", "panel " + (cls || "")); const h = el("h2", null, title); if (note) h.appendChild(el("small", null, note)); p.appendChild(h); return p; }
function kv(pairs) { const d = el("dl", "kv"); for (const [k, v] of pairs) { d.appendChild(el("dt", null, k)); d.appendChild(el("dd", null, v)); } return d; }
function bar(share, color) { const b = el("div", "bar"); const i = el("i"); i.style.width = Math.round(Math.max(0, Math.min(1, share)) * 100) + "%"; if (color) i.style.background = color; b.appendChild(i); return b; }
function clip(text, n) { text = String(text || ""); return text.length > n ? text.slice(0, n - 1) + "…" : text; }
function time(iso) { return String(iso || "").slice(11, 19); }
let TAB = "terminal";
const LOCAL = [];
const TABS = [["terminal", "TERMINAL"], ["git", "GIT"], ["messages", "MESSAGES"], ["traces", "TRACES"]];
const ACTOR_COLOR = { GRU:"#e2a93b", AVL:"#63c7e0", DRU:"#ef6b6b", NEFARIO:"#7cf29a", DIRECTOR:"#b09cff", MINION:"#f5d33b", YOU:"#dbe4f0" };
function num(n) { return Number(n || 0).toLocaleString("en-US"); }
function secs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : ms + " ms"; }
function tabItems(view, tab) {
  if (tab === "messages") return view.feed.filter((i) => i.actor === "MINION" || i.actor === "DIRECTOR" || i.actor === "DRU");
  if (tab === "traces") return view.feed.filter((i) => i.actor === "AVL" || i.actor === "NEFARIO");
  if (tab === "git") return [];
  return view.feed;
}
function feedLine(item) {
  const line = el("div", "t-" + item.tone);
  line.appendChild(el("time", null, time(item.at)));
  const tag = el("b", null, "[" + (item.actor === "MINION" ? item.minion.toUpperCase() : item.actor) + "]");
  tag.style.color = ACTOR_COLOR[item.actor] || "var(--info)";
  line.appendChild(tag);
  line.appendChild(el("span", "msg", item.text));
  if (item.actor !== "MINION" && item.minion) line.appendChild(el("span", "who", " · " + item.minion));
  return line;
}
function command(view, mode, raw) {
  const text = String(raw || "").trim(); if (!text) return;
  const input = document.getElementById("gru-cmd"); if (input) input.value = "";
  const say = (actor, msg, tone) => LOCAL.push({ at: new Date().toISOString(), actor, minion: "", text: msg, tone: tone || "info" });
  say("YOU", text);
  const t = view.totals;
  const [cmd, ...rest] = text.split(/\s+/);
  if (cmd === "/status") say("GRU", t.episodes + " episodes: " + t.pass + " PASS, " + t.fail + " FAIL, " + t.running + " running; " + view.pending.length + " waiting on you; DRU has " + t.high_objections + " HIGH objection(s).");
  else if (cmd === "/pending") { if (!view.pending.length) say("AVL", "Nothing waiting on the Director."); for (const p of view.pending) say("AVL", p.minion + ": " + p.effect + " (" + p.consequences.join(", ") + ")", "warn"); }
  else if (cmd === "/dru") {
    const all = view.episodes.flatMap((e) => e.objections.filter((o) => o.rule !== "network-open").map((o) => [e.minion, o]));
    if (!all.length) say("DRU", "No objections.");
    for (const [m, o] of all.slice(0, 20)) say("DRU", m + ": " + o.severity + " " + o.question + ": " + o.text, o.severity === "HIGH" ? "bad" : "warn");
  } else if (cmd === "/minion") {
    const m = view.episodes.find((e) => e.minion === rest[0]);
    if (!m) say("GRU", "No Minion called '" + (rest[0] || "") + "'. Try /minion " + (view.episodes[0] ? view.episodes[0].minion : "<name>"), "warn");
    else say("GRU", m.minion + " spawned " + time(m.started_at) + ", " + m.status + ", " + m.tool_calls + " tool calls, " + num(m.tokens.input + m.tokens.output) + " tokens; last: " + m.activity);
  } else if (cmd === "/replay" && mode === "snapshot") { replay(view); return; }
  else say("GRU", "Commands: /status, /pending, /dru, /minion <name>" + (mode === "snapshot" ? ", /replay" : "") + ". Read-only: approvals happen in the Director channel.");
  TAB = "terminal"; render(view, mode);
}
function pct(x) { return x === null || x === undefined ? "n/a" : Math.round(x * 100) + "%"; }

function role(name, subtitle, spriteRows, palette, say, pairs) {
  const p = panel(name, subtitle, "role");
  const scene = el("div", "scene"); scene.appendChild(sprite(spriteRows, palette, 5)); scene.appendChild(el("div", "bubble", say));
  p.appendChild(scene); p.appendChild(kv(pairs)); return p;
}

function render(view, mode) {
  const prior = document.getElementById("gru-cmd");
  const keep = prior ? prior.value : ""; const focused = prior !== null && document.activeElement === prior;
  queueMicrotask(() => { const next = document.getElementById("gru-cmd"); if (next) { next.value = keep; if (focused) next.focus(); } });
  const root = document.getElementById("wb");
  root.textContent = "";
  const t = view.totals;
  const head = el("header");
  head.appendChild(el("h1", null, "GRU WORKBENCH"));
  head.appendChild(el("span", "badge" + (mode === "live" ? " live" : ""), mode === "live" ? "LIVE" : "SNAPSHOT"));
  if (mode === "snapshot" && view.feed.length) {
    const button = el("button", "replay", "▶ Replay");
    button.type = "button";
    button.addEventListener("click", () => replay(view, button));
    head.appendChild(button);
  }
  head.appendChild(el("span", "meta", "ledger state at " + view.generated_at.replace("T", " ").slice(0, 19) + " UTC · " + t.episodes + " episodes"));
  root.appendChild(head);

  const grid = el("div", "grid");
  const closed = t.episodes - t.running;
  const latest = view.episodes[view.episodes.length - 1];
  const gruSay = t.episodes === 0 ? "No episodes yet. Give me a contract." :
    t.running > 0 ? "Running " + t.running + " of " + t.episodes + " episodes. " + view.pending.length + " waiting on the Director." :
    "All " + t.episodes + " episodes closed: " + t.pass + " PASS, " + t.fail + " FAIL" + (t.partial ? ", " + t.partial + " PARTIAL" : "") + ".";
  const gru = role("GRU", "project manager", SPRITES.gru, PALETTES.gru, gruSay, [["current task", clip(latest ? latest.task : "none", 90)], ["closed", closed + "/" + t.episodes]]);
  gru.appendChild(bar(t.episodes ? closed / t.episodes : 0));
  grid.appendChild(gru);
  const top = view.dru.top;
  grid.appendChild(role("DRU", "shadow PM · rules v0", SPRITES.dru, PALETTES.dru,
    top ? top.minion + ": " + top.text : "No objections. Every closure holds up against my rules.",
    [["top risk", top ? top.severity + " · " + top.question : "none"], ["objections", t.objections + " (" + t.high_objections + " high)"]]));
  const routes = view.lab.routes.map((r) => r.id + " ×" + r.episodes).join(", ") || "none";
  const backends = view.lab.backends.map((b) => b.id + " ×" + b.episodes).join(", ") || "none: commands run unconfined";
  grid.appendChild(role("DR. NEFARIO", "the lab", SPRITES.nefario, PALETTES.nefario,
    "Routes: " + routes + ". Isolation: " + backends + ".",
    [["unmet", view.lab.unmet.join(", ") || "none"], ["mode", view.lab.unmet.length ? "UNSAFE_DEVELOPMENT" : "GOVERNED"]]));

  const term = el("section", "panel term");
  const termHead = el("div", "term-head"); termHead.appendChild(el("h2", null, "Terminal")); termHead.appendChild(el("span", "win", "▢  ✕")); term.appendChild(termHead);
  const tabs = el("div", "tabs");
  for (const [id, label] of TABS) {
    const b = el("button", "tab" + (TAB === id ? " on" : ""), label); b.type = "button";
    b.addEventListener("click", () => { TAB = id; render(view, mode); });
    tabs.appendChild(b);
  }
  term.appendChild(tabs);
  const log = el("div", "log"); log.id = "feed-log";
  const items = tabItems(view, TAB);
  if (TAB === "git") log.appendChild(el("div", "empty", "No git integration yet: GRU records every effect in its ledger, not in commits."));
  else if (items.length === 0) log.appendChild(el("div", "empty", "no events"));
  for (const item of items) log.appendChild(feedLine(item));
  if (TAB === "terminal") for (const item of LOCAL) log.appendChild(feedLine(item));
  term.appendChild(log);
  const form = el("form", "cmd");
  form.appendChild(el("span", "prompt", ">"));
  const input = el("input"); input.id = "gru-cmd"; input.autocomplete = "off"; input.spellcheck = false;
  input.placeholder = "Type command... (e.g. /status, /pending, /dru, /minion <name>" + (mode === "snapshot" ? ", /replay" : "") + ")";
  input.setAttribute("aria-label", "Workbench command");
  form.appendChild(input);
  form.addEventListener("submit", (e) => { e.preventDefault(); command(view, mode, input.value); });
  term.appendChild(form);
  grid.appendChild(term);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });

  const minions = panel("Minions: active workspace", t.episodes + " episodes, one Minion each", "minions");
  const cards = el("div", "cards");
  if (view.episodes.length === 0) cards.appendChild(el("div", "empty", "none yet"));
  for (const m of view.episodes) {
    const card = el("div", "card" + (m.status === "RUNNING" ? " working" : ""));
    card.dataset.episode = m.episode_id;
    const top = el("div", "row"); top.appendChild(minionSprite(m.minion)); top.appendChild(el("span", "chip " + m.status, m.status)); card.appendChild(top);
    card.appendChild(el("div", "name", m.minion));
    card.appendChild(el("div", "bubble", clip(m.activity, 90)));
    card.appendChild(bar(m.budget_used ?? 0, m.status === "FAIL" ? "var(--bad)" : m.status === "RUNNING" ? "var(--info)" : "var(--ok)"));
    const meta = el("div", "row"); meta.appendChild(el("span", null, "budget " + pct(m.budget_used))); meta.appendChild(el("span", null, m.strength || "unverified")); card.appendChild(meta);
    if (!m.ledger_ok) card.appendChild(el("div", "row FAIL", "ledger does not verify"));
    const serious = m.objections.filter((o) => o.rule !== "network-open");
    if (serious.length) card.appendChild(el("div", "row " + (serious[0].severity === "HIGH" ? "FAIL" : "PARTIAL"), "DRU: " + serious.length + " objection" + (serious.length === 1 ? "" : "s")));
    cards.appendChild(card);
  }
  minions.appendChild(cards);
  grid.appendChild(minions);

  const queue = panel("Queue", view.pending.length + " awaiting you", "span3 queue");
  const qlist = el("div", "list");
  const qitems = [
    ...view.pending.map((p) => ({ at: p.at, text: p.minion + " wants " + p.effect, bad: false })),
    ...view.episodes.flatMap((e) => e.objections.filter((o) => o.severity === "HIGH").map((o) => ({ at: e.last_at, text: "Review " + e.minion + ": " + o.text, bad: true }))),
  ];
  if (qitems.length === 0) qlist.appendChild(el("div", "empty", "Queue empty."));
  for (const q of qitems.slice(0, 8)) {
    const item = el("div", "item"); item.appendChild(el("span", null, clip(q.text, 84))); item.appendChild(el("span", q.bad ? "FAIL" : "PARTIAL", time(q.at))); qlist.appendChild(item);
  }
  queue.appendChild(qlist);
  const qactions = el("div", "qactions");
  for (const [label, title] of [["FILES", "Attachments are not available in the read-only Workbench"], ["VOICE", "Voice is not available yet"]]) {
    const b = el("button", "ghost", label); b.type = "button"; b.disabled = true; b.title = title; qactions.appendChild(b);
  }
  const send = el("button", "replay", "SEND"); send.type = "button";
  send.addEventListener("click", () => { const i = document.getElementById("gru-cmd"); if (i) command(view, mode, i.value); });
  qactions.appendChild(send);
  queue.appendChild(qactions);
  grid.appendChild(queue);

  const status = panel("Project status", null, "span3");
  status.appendChild(kv([["episodes", t.episodes], ["running", t.running], ["PASS", t.pass], ["FAIL", t.fail], ["PARTIAL", t.partial], ["ABANDONED", t.abandoned], ["violations", t.violations]]));
  grid.appendChild(status);

  const debate = panel("GRU–DRU debate", "bounded, five questions", "span3");
  const q = el("div", "q");
  ["Objective", "Evidence", "Assumptions", "Risk / alternative", "Decision"].forEach((name, i) => {
    const s = el("div", "step"); s.appendChild(el("span", "n", i + 1)); s.appendChild(el("span", null, name)); q.appendChild(s);
  });
  debate.appendChild(q);
  [...q.children].forEach((row, i) => {
    const key = ["Q1 Objective", "Q2 Evidence", "Q3 Assumptions", "Q4 Risk", "Q5 Decision"][i];
    const n = view.dru.by_question[key] || 0;
    row.appendChild(el("span", n ? "FAIL" : "PASS", n ? n + " objection" + (n === 1 ? "" : "s") : "clear"));
  });
  debate.appendChild(el("div", "empty", "DRU v0 is rules over the ledger, not a model; it never changes a closure."));
  grid.appendChild(debate);

  const verify = panel("Verification", view.checks.length + " check runs", "span3");
  const vlist = el("div", "list");
  if (view.checks.length === 0) vlist.appendChild(el("div", "empty", "no checks run yet"));
  for (const c of view.checks.slice(-12)) {
    const item = el("div", "item");
    item.appendChild(el("span", null, c.minion + " · " + c.id + (c.kind === "must_fail" ? " (must fail)" : "")));
    item.appendChild(el("span", c.ok ? "PASS" : "FAIL", c.ok ? "OK" : "NOT OK"));
    vlist.appendChild(item);
  }
  verify.appendChild(vlist);
  grid.appendChild(verify);

  const avl = panel("AVL: authority & verification", null, "span3");
  avl.appendChild(kv([
    ["escalations", t.escalations], ["denied or rejected", t.denials], ["gate refusals", t.refusals],
    ["evidence store", t.evidence + " items"], ["ledgers", (t.episodes - t.ledgers_broken) + "/" + t.episodes + " verify"],
  ]));
  grid.appendChild(avl);
  root.appendChild(grid);

  const roster = panel("Minion roster", "spawned, working on, tokens burned", "roster");
  const wrap = el("div", "table-wrap"); const table = el("table");
  const hr = el("tr");
  for (const h of ["Minion", "Spawned", "Status", "Working on", "Model", "Turns", "Tool calls", "Tokens in", "Tokens out", "Cache read", "Duration", "DRU"]) hr.appendChild(el("th", null, h));
  const thead = el("thead"); thead.appendChild(hr); table.appendChild(thead);
  const tbody = el("tbody");
  const sum = { input: 0, output: 0, cache: 0 };
  for (const m of view.episodes) {
    sum.input += m.tokens.input; sum.output += m.tokens.output; sum.cache += m.tokens.cache_read;
    const tr = el("tr");
    const serious = m.objections.filter((o) => o.rule !== "network-open");
    const cells = [m.minion, time(m.started_at), m.status, clip(m.activity, 70), m.served_model || m.route || "?", m.turns, m.tool_calls, num(m.tokens.input), num(m.tokens.output), num(m.tokens.cache_read), secs(m.duration_ms), serious.length ? serious.length + (serious[0].severity === "HIGH" ? " HIGH" : "") : "-"];
    cells.forEach((c, i) => { const td = el("td", i === 2 ? m.status : (i >= 5 && i <= 10 ? "n" : null), c); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  const tot = el("tr", "total");
  ["All Minions", "", "", "", "", "", "", num(sum.input), num(sum.output), num(sum.cache), "", ""].forEach((c, i) => tot.appendChild(el("td", i >= 5 ? "n" : null, c)));
  tbody.appendChild(tot);
  table.appendChild(tbody); wrap.appendChild(table); roster.appendChild(wrap);
  if (sum.input + sum.output === 0) roster.appendChild(el("div", "empty", "No model tokens spent: these Minions ran on the scripted (fixture) route. A live route records its real usage per turn in the ledger, and it shows here."));
  grid.appendChild(roster);

  const legend = el("div", "legend");
  [["ok", "allowed / passed"], ["warn", "needs or got a Director decision"], ["bad", "denied / failed / violation"], ["info", "claims and progress"]].forEach(([c, text]) => legend.appendChild(el("span", c, text)));
  legend.appendChild(el("span", "", "Read-only: approvals happen in the Director channel (terminal or MCP)."));
  root.appendChild(legend);
}

// Replay: the ledger again, event by event. Cards start working with their
// badges hidden; each event types into the terminal and into its Minion's
// bubble; a closure reveals the badge. Nothing is invented: it is the feed.
let replaying = null;
function replay(view, button) {
  if (replaying) { clearTimeout(replaying); replaying = null; }
  TAB = "terminal"; LOCAL.length = 0;
  render(view, "snapshot");
  const log = document.getElementById("feed-log");
  const cards = new Map([...document.querySelectorAll(".card")].map((c) => [c.dataset.episode, c]));
  for (const card of cards.values()) {
    card.classList.add("working");
    card.querySelector(".chip").classList.add("hidden");
    card.querySelector(".bubble").textContent = "…";
  }
  log.textContent = "";
  const again = document.querySelector(".replay");
  if (again) again.textContent = "↺ Replaying…";
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = view.feed;
  let i = 0;
  const step = () => {
    const prev = log.lastElementChild; if (prev) prev.classList.remove("cursor");
    if (i >= items.length) {
      for (const card of cards.values()) card.classList.remove("working");
      if (again) again.textContent = "▶ Replay";
      replaying = null; return;
    }
    const item = items[i++];
    const line = feedLine(item); line.classList.add("fresh", "cursor");
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    const card = cards.get(item.episode_id);
    if (card) {
      if (item.type === "closure") {
        card.classList.remove("working");
        const chip = card.querySelector(".chip"); chip.classList.remove("hidden"); chip.classList.add("show");
      } else if (item.type !== "episode.opened") {
        card.querySelector(".bubble").textContent = clip(item.text, 90);
      }
    }
    replaying = setTimeout(step, reduce ? 0 : Math.max(35, 2400 / Math.max(1, items.length) * 10));
  };
  step();
}
`;

export function workbenchHtml(options: PageMode, shell: { document: boolean } = { document: true }): string {
  const boot =
    options.mode === "snapshot"
      ? `<script type="application/json" id="gru-data">${inlineJson(options.view)}</script>
<script>${SCRIPT}
render(JSON.parse(document.getElementById("gru-data").textContent), "snapshot");</script>`
      : `<script>${SCRIPT}
async function poll() {
  try { const r = await fetch("api/state", { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); render(await r.json(), "live"); }
  catch (e) { const h = document.querySelector("header .meta"); if (h) h.textContent = "disconnected from gru workbench: " + e.message; }
}
poll(); setInterval(poll, ${Math.max(250, options.pollMs ?? 1500)});</script>`;
  const head = `<title>GRU Workbench</title>\n<style>${STYLE}</style>`;
  const main = `<main class="wb" id="wb"><p class="empty">Loading the ledger…</p></main>\n${boot}`;
  return shell.document
    ? `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n${head}\n</head><body>\n${main}\n</body></html>\n`
    : `${head}\n${main}\n`;
}
