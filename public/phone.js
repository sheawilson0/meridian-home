'use strict';
/* Meridian on the phone (4 Oct 2026). The "Recommended" direction from
   /design/mobile, built on the real server: Today, Agents, Tell, Money, More.

   Three jobs: look at the day, tell Meridian what to change (tell.js does it and
   hands back receipts with Undo), and keep an eye on the agents. Building things
   stays in T3 Code; this is for running life admin with the Dot.

   Plain JS, no build step, same tokens as the command centre. Reads /api/state
   (cached on the phone for an instant open, Money never cached), /api/tell,
   /api/drafts and /api/almanac. ?lab blocks every write, like the dashboard. */

/* ---------- basics ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const Q = new URLSearchParams(location.search);
const token = Q.get('t');
const LAB = Q.has('lab');
if (LAB) { const f = window.fetch; window.fetch = (u, o = {}) => /^(GET|HEAD)$/i.test(o.method || 'GET') ? f(u, o) : Promise.resolve(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })); }
// ?demo (8 Oct 2026): the made-up data the dashboard's demo mode uses, for boards and recordings. Missing parts just stay empty.
const DEMO = Q.has('demo');
const api = (p) => { if (DEMO && p.startsWith('/api/')) p = '/api/demo/' + p.slice(5); return token ? p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token) : p; };
async function send(p, body, method = 'POST') {
  const r = await fetch(api(p), { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || 'That didn’t work (' + r.status + ')');
  return j;
}
async function getJSON(p, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { const r = await fetch(api(p), { cache: 'no-store', signal: controller.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
  finally { clearTimeout(timer); }
}
function phoneStateShape(s) {
  return s && s.at != null && Array.isArray(s.calendar?.events) &&
    Array.isArray(s.projects?.projects) && Array.isArray(s.briefIntake?.items) &&
    Array.isArray(s.ai?.sessions) && Array.isArray(s.delegations?.runs) &&
    Array.isArray(s.github?.reviews) && Array.isArray(s.notifyHistory) &&
    s.briefFeedback && typeof s.briefFeedback === 'object' &&
    s.ledger && typeof s.ledger === 'object';
}
async function getState() {
  if (DEMO) return getJSON('/api/state');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  const read = async (p) => { const r = await fetch(api(p), { cache: 'no-store', signal: controller.signal }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
  try {
    // Older daemons and tester worlds can still send the full state.
    try { const s = await read('/api/state?view=phone'); if (phoneStateShape(s)) return s; }
    catch (e) { if (controller.signal.aborted) throw e; }
    // Both attempts share one deadline, including their response bodies.
    return await read('/api/state');
  } finally { clearTimeout(timer); }
}
async function getText(p) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try { const r = await fetch(api(p), { cache: 'no-store', signal: controller.signal }); return { ok: r.ok, text: await r.text() }; }
  finally { clearTimeout(timer); }
}
const store = { get(k, d) { try { const v = localStorage.getItem('meridian.phone.' + (DEMO ? 'demo.' : '') + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('meridian.phone.' + (DEMO ? 'demo.' : '') + k, JSON.stringify(v)); } catch { /* full or private */ } } };
const setHTML = (el, h) => { if (el && el.__h !== h) { el.innerHTML = h; el.__h = h; nameControls(el); } };
function nameControls(scope) {
  scope.querySelectorAll('[role=switch],.sw').forEach((b) => { const label=b.closest('.kindrow,.act')?.querySelector('.t'); if(label)b.setAttribute('aria-label',label.textContent.trim()); });
}

/* ---------- look: the desktop's choice (8 Oct 2026) ---------- */
// The phone wears whichever Look the desktop picked in Customise (server prefs). The last one
// seen is put on before anything draws, then the Mac is asked again. ?surface=nothing overrides
// it for testing. Only Nothing has phone styles so far (/themes/nothing-phone.css).
(() => {
  const pin = Q.get('surface');
  const apply = (s) => {
    s = /^[a-z0-9-]{1,24}$/.test(s || '') ? s : 'ink';
    document.documentElement.dataset.surface = s;
    if (s !== 'nothing') return;
    if (!document.getElementById('nd-fonts')) { const l = document.createElement('link'); l.id = 'nd-fonts'; l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Doto:ROND,wght@0..100,500..900&family=Space+Grotesk:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap'; document.head.appendChild(l); }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#000000');
  };
  apply(pin || store.get('surface', 'ink'));
  if (pin) return;
  const check = () => getJSON('/api/command/prefs').then((j) => { store.set('name', j?.prefs?.name || ''); const s = j?.prefs?.look?.surface; if (s) { store.set('surface', s); apply(s); } }).catch(() => { /* keep the last one */ });
  check();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
})();

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const shortDate = (ts) => { const d = new Date(ts); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
function dayWord(ts) { const d = startOfDay(ts), t = startOfDay(Date.now()); if (d === t) return 'Today'; if (d === t + 86400e3) return 'Tomorrow'; const x = new Date(ts); return `${DAYS[x.getDay()].slice(0, 3)} ${x.getDate()}`; }
function ago(ts) { if (!ts) return ''; const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min'; if (s < 86400) return Math.round(s / 3600) + ' h'; return Math.round(s / 86400) + ' d'; }
const agoText = (ts) => { const a = ago(ts); return a === 'just now' || !a ? a : a + ' ago'; };
const daysUntil = (iso) => Math.round((startOfDay(Date.parse(iso + 'T12:00:00')) - startOfDay(Date.now())) / 86400e3);
const cap = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const gbp = (n) => (n < 0 ? '−' : '') + '£' + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: Math.abs(n) < 100 ? 2 : 0, maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });

/* ---------- icons (the command centre's line set) ---------- */
const P = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  agents: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.3l-1.8-5.7L4.5 10.8 10.2 9z"/><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  money: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 8.6a2.6 2.6 0 0 0-4.6 1.7c0 2.4-.4 3.9-1.9 5.2h7.2M8.6 12.3h4.6"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  todo: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  fix: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  out: '<path d="M7 17 17 7M9 7h8v8"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  stash: '<path d="M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5"/><path d="M4 13.5h4.5l1 2h5l1-2H20L17.5 6h-11z"/>',
  shelf: '<path d="M5 4v16M9 4v16M13 6l3.5 14M18 5l2 15"/>',
  journal: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  usage: '<path d="M5 20V12M10 20V6M15 20v-9M20 20V9"/>',
  system: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/>',
  brief: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a10 10 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  spark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  pound: '<path d="M15.5 6.5A3.5 3.5 0 0 0 9 8.5c0 3.5-.5 6.5-2.5 9.5H17M7 12.5h7"/>',
  soul: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  note: '<path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M14 3.5V8h4M9 12h6M9 16h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  layout: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  button: '<rect x="8" y="2.5" width="8" height="19" rx="3"/><path d="M4 9v4"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
};
const icon = (n, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
const tickSvg = '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const glyph = '<svg viewBox="0 0 24 24" fill="none" stroke="#f4f4f5" stroke-width="1.7"><circle cx="12" cy="12" r="8.4"/><line x1="12" y1="3.6" x2="12" y2="20.4"/><circle cx="12" cy="4.4" r="2" fill="#ff5247" stroke="none"/></svg>';
const ACT_ICON = { todo: 'todo', bell: 'bell', flag: 'flag', pound: 'pound', cal: 'cal', mail: 'mail', fix: 'fix', note: 'note', soul: 'soul' };
const ACT_CLASS = { todo: 'todo', remind: 'todo', deadline: 'todo', money: 'money', calendar: 'cal', draft: 'mail', fix: 'fix', note: 'note', soul: 'note' };

/* ---------- data ---------- */
let S = store.get('state', null);   // /api/state, cached for an instant open
let tells = store.get('tells', []);
let drafts = [];
let sky = store.get('sky', null);
let lastLoad = 0;
let loading = null;
let offline = !navigator.onLine;
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
function showOffline(on) {
  offline = on;
  $('#offline').hidden = !on;
  $('#offline').textContent = S ? 'Offline · can’t reach the Home Mac · showing the last copy' : 'Offline · can’t reach the Home Mac';
}

/* ---------- feel (lab, 8 Oct 2026) ---------- */
// The picks from the Nothing rebuild, lab only for now (see /feel.js and /design/nothing-picks): ticking a to-do
// crosses it off with a burst of dots and the chime, and turning the phone on its side launches into Standby.
// ?sound=off|key|all and ?pomo=on try the other choices.
const FEEL = LAB && !!window.Feel;
function phoneStandby() {
  const evs = (S?.calendar?.events || []).filter((e) => !e.allDay && (e.end || e.ts) >= Date.now() && e.response !== 'declined').sort((a, b) => a.ts - b.ts);
  const runs = (S?.delegations?.runs || []).filter((r) => ['running', 'queued'].includes(r.status)).map((r) => ({ who: r.model || 'Agent', what: r.title, started: r.started, usual: 8 }));
  const ses = (S?.ai?.sessions || []).filter((x) => x.live).map((x) => ({ who: String(x.project || x.tool).split('/').pop(), what: x.did || x.prompt || '', started: x.started, usual: 25 }));
  return { rise: sky?.today?.sunrise, set: sky?.today?.sunset, temp: sky?.now?.temp, weather: sky?.now?.label, next: evs[0] && { title: evs[0].title, ts: evs[0].ts }, todo: (S?.todos || []).filter((t) => !t.done).length, agents: [...runs, ...ses] };
}
if (FEEL) {
  Feel.init({ opt: (k) => ({ sound: Q.get('sound') || 'key', tickfx: 'dots', rings: 'time', pomo: Q.get('pomo') || 'off', rockets: 'off' })[k], data: phoneStandby });
  const side = matchMedia('(orientation: landscape) and (max-height: 500px)');
  const turn = () => { if (side.matches) Feel.launch(); else Feel.land(); };
  side.addEventListener('change', turn); if (side.matches) setTimeout(turn, 600);
}
function load() {
  if (loading) return loading;
  // A slow companion read must not hold up the day or hide a lost connection.
  loading = Promise.allSettled([
    getState().then((s) => { S = s; slimCache(); showOffline(false); lastLoad = Date.now(); renderSoon(); })
      .catch(() => { showOffline(true); lastLoad = Date.now(); renderSoon(); }),
    getJSON('/api/tell?limit=40').then((j) => { tells = j.tells || []; store.set('tells', tells.slice(0, 20)); renderSoon(); }),
    getJSON('/api/drafts?limit=12').then((j) => { drafts = j.drafts || []; renderSoon(); }),
    getJSON('/api/almanac').then((j) => { sky = j?.items?.sky || null; store.set('sky', sky); renderSoon(); }),
  ]).finally(() => { loading = null; });
  return loading;
}
// Only what the phone shows goes in the cache, so it opens instantly without filling storage.
function slimCache() {
  if (!S) return;
  const keep = ['at', 'calendar', 'invites', 'todos', 'deadlines', 'projects', 'briefFeedback', 'briefIntake', 'ai', 'delegations', 'ledger', 'journalToday', 'github', 'nudges', 'notify', 'notifyHistory', 'tailnet', 'git'];
  const slim = Object.fromEntries(keep.map((k) => [k, S[k]]));
  if (slim.ledger) slim.ledger = { now: slim.ledger.now };
  store.set('state', slim);
}

/* ---------- the shell ---------- */
const app = $('#app');
app.innerHTML = `
<div class="offline" id="offline" hidden>Can’t reach the Home Mac · showing the last copy</div>
<section class="screen" id="s-today">
  <div class="topbar"><button class="ibtn bg" data-sheet="sh-menu" aria-label="Everything else">${icon('menu')}</button>
    <span class="end"><button class="ibtn bg" id="call" aria-label="Call your Dot">${icon('phone')}</button></span></div>
  <div class="eyebrow" id="t-eyebrow"></div>
  <h1 class="hello" id="t-hello"></h1>
  <p class="line" id="t-line"></p>
  <div class="sec" id="t-needs-sec"><div class="sec-h"><h3 aria-level="2">Needs you</h3><span class="sub" id="t-needs-n"></span><span class="end"><button data-go="agents">All agents</button></span></div><div class="needs" id="t-needs"></div></div>
  <div class="sec" id="t-next"></div>
  <div class="sec"><div class="sec-h"><h3 aria-level="2">To do</h3><span class="sub" id="t-todo-n"></span></div>
    <div class="card" style="padding:10px 12px 4px"><form class="quickadd" id="quickadd">${icon('plus')}<input id="qa" aria-label="Add a to-do" placeholder="Add a to-do" enterkeyhint="done" autocomplete="off" autocapitalize="sentences"></form><div class="rows" id="t-todos"></div></div></div>
  <div class="sec" id="t-inbox-sec"><div class="sec-h"><h3 aria-level="2">From your inbox</h3><span class="sub" id="t-inbox-n"></span></div><div class="card list" id="t-inbox"></div></div>
  <div class="sec"><div class="sec-h"><h3 aria-level="2">Coming up</h3><span class="sub" id="t-coming-n"></span></div><div class="card list" id="t-coming"></div></div>
  <div class="sec" id="t-dl-sec"><div class="sec-h"><h3 aria-level="2">Deadlines</h3></div><div class="strip" id="t-dl" role="region" aria-label="Deadlines" tabindex="0"></div></div>
</section>

<section class="screen" id="s-agents" hidden>
  <div class="topbar"><h1 class="t-title">Agents</h1><span class="end"><button class="btn sm" data-tell="">${icon('plus')}Tell</button></span></div>
  <p class="t-sub" style="margin-top:-6px">What’s running, and where each project is up to. Building happens in T3 Code.</p>
  <button class="pinned" style="margin-top:14px" id="open-thread"><span class="av">${glyph}</span><span class="main"><b>Meridian</b><span class="s" id="a-pin-s">Everything you’ve told it, and what it did</span></span><span class="unread" id="a-unread" hidden></span></button>
  <div id="a-needs-sec"><div class="sec-h" style="margin-top:22px"><h3 aria-level="2">Needs you</h3></div><div class="needs" id="a-needs"></div></div>
  <div class="sec-h" style="margin-top:22px"><h3 aria-level="2">Working</h3><span class="sub" id="a-work-n"></span></div>
  <div class="card list" id="a-work"></div>
  <div class="sec-h" style="margin-top:22px"><h3 aria-level="2">Where things are</h3><span class="sub">NOW.md + today</span></div>
  <div id="a-proj"></div>
  <div class="sec-h" style="margin-top:22px"><h3 aria-level="2">Done today</h3></div>
  <div class="card list" id="a-done"></div>
</section>

<section class="screen" id="s-money" hidden>
  <div class="topbar"><h1 class="t-title">Money</h1><span class="end"><button class="ibtn bg" id="m-lockbtn" aria-label="Lock Money" hidden>${icon('lock')}</button></span></div>
  <p class="t-sub" style="margin-top:-6px">Monzo and Trading 212, read every morning. Never kept on the phone.</p>
  <div id="m-body" style="margin-top:16px"></div>
</section>

<section class="screen" id="s-more" hidden>
  <h1 class="t-title">More</h1>
  <div class="group-h">Opens to</div>
  <div class="seg" id="opento">${[['today', 'Today'], ['agents', 'Agents'], ['tell', 'Tell'], ['last', 'Last used']].map(([k, l]) => `<button data-open="${k}">${l}</button>`).join('')}</div>
  <div class="group-h">Ways in</div>
  <div class="card list">
    <button class="door" data-sheet="sh-way-tell"><span class="di" style="background:var(--accent);color:var(--accent-ink)">${icon('plus')}</span><div class="main"><div class="t">Tell on your Home Screen</div><div class="s">Its own icon that opens ready to talk</div></div><span class="tag go">Now</span></button>
    <button class="door" data-sheet="sh-way-button"><span class="di">${icon('button')}</span><div class="main"><div class="t">Action Button</div><div class="s">Press, talk, done. A Shortcut sends it here</div></div><span class="tag go">Now</span></button>
    <button class="door" data-sheet="sh-way-pings"><span class="di">${icon('bell')}</span><div class="main"><div class="t">Buttons on notifications</div><div class="s">“Do it” and “In an hour”, through ntfy</div></div><span class="tag go">Now</span></button>
    <button class="door" data-sheet="sh-widgets"><span class="di">${icon('grid')}</span><div class="main"><div class="t">Widgets, Lock Screen, Dynamic Island</div><div class="s">Widgets now with Scriptable; the rest with the app</div></div><span class="tag go">Try now</span></button>
    <button class="door" data-sheet="sh-way-share"><span class="di">${icon('share')}</span><div class="main"><div class="t">Share to Meridian</div><div class="s">From Safari, Photos, Mail</div></div><span class="tag">iPhone app</span></button>
  </div>
  <div class="group-h">Meridian itself</div>
  <div class="card list">
    <button class="list-link" data-sheet="sh-soul">${icon('soul')}How Meridian talks<span class="end">soul.md ${icon('chev')}</span></button>
    <button class="list-link" data-sheet="sh-pings">${icon('bell')}What pings you<span class="end" id="more-quiet"></span></button>
    <button class="list-link" data-sheet="sh-trust">${icon('check')}What Tell does without asking<span class="end">${icon('chev')}</span></button>
    <button class="list-link" data-sheet="sh-call">${icon('phone')}The call button<span class="end" id="more-call"></span></button>
  </div>
  <div class="group-h">Layout</div>
  <div class="card list">
    <a class="list-link" href="/dashboard?classic${token ? '&t=' + encodeURIComponent(token) : ''}">${icon('layout')}Classic phone layout<span class="end">the old one ${icon('out')}</span></a>
    <div class="kindrow"><div class="main"><div class="t">Always open the classic layout</div><div class="s">Switch back from its menu any time</div></div><button class="sw2" role="switch" id="classic-sw" aria-checked="false"></button></div>
  </div>
  <p class="faint center" style="font-size:12.5px;margin-top:22px">Meridian on the Home Mac · <span id="more-at"></span></p>
</section>

<div class="push" id="thread" aria-label="Conversation with Meridian"><header class="ph"><button class="ibtn" id="thread-back" aria-label="Back">${icon('back')}</button><span class="av" style="width:36px;height:36px;border-radius:12px">${glyph}</span><span><b>Meridian</b><span>on the Home Mac</span></span></header>
  <section class="screen" id="thread-list" role="log" aria-label="Messages from Meridian" aria-live="polite" aria-relevant="additions text"></section>
  <div class="dock"><div class="quick" id="quick">
      <button class="chip" data-say="What’s on tomorrow?">${icon('cal')}Tomorrow</button>
      <button class="chip" data-say="What’s left on my to-do list that matters today?">${icon('todo')}To-dos</button>
      <button class="chip" data-say="What does my week look like?">${icon('today')}This week</button>
      <button class="chip" data-say="What deadlines are coming up?">${icon('flag')}Deadlines</button>
    </div>
    <form class="composer" id="thread-form"><textarea id="thread-box" aria-label="Message Meridian" rows="1" placeholder="Message Meridian" enterkeyhint="send" autocapitalize="sentences"></textarea><button class="send" id="thread-send" aria-label="Send" disabled>${icon('send')}</button></form></div>
</div>

<nav class="tabbar" aria-label="Views">
  <button class="tab" data-go="today" aria-current="page">${icon('today')}Today</button>
  <button class="tab" data-go="agents">${icon('agents')}<span class="badge" id="badge" hidden></span>Agents</button>
  <button class="tellbtn" id="tell-open" aria-label="Tell Meridian">${icon('plus')}</button>
  <button class="tab" data-go="money">${icon('money')}Money</button>
  <button class="tab" data-go="more">${icon('more')}More</button>
</nav>

<div class="scrim" id="scrim"></div>

<div class="sheet full" id="sh-tell"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Tell Meridian</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="tell-body"></div>
  <div class="sf" id="tell-foot" role="status" aria-live="polite" aria-atomic="true"></div></div>

<div class="sheet" id="sh-menu"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Everything else</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb"><div class="card list">
    ${[['stash', 'Stash', 'stash'], ['shelf', 'Shelf', 'shelf'], ['brief', 'Morning brief', 'brief'], ['journal', 'Journal', 'journal'], ['usage', 'AI usage', 'usage'], ['dogfood', 'Dogfood', 'fix'], ['system', 'System', 'system']].map(([v, l, i]) => `<a class="list-link" href="/dashboard?classic${token ? '&t=' + encodeURIComponent(token) : ''}#${v}">${icon(i)}${l}<span class="end">${icon('out')}</span></a>`).join('')}
  </div>
  <p class="faint" style="font-size:12.5px;margin:12px 4px 0">These open in the classic layout, which still has everything. Settings for this one are under More.</p></div></div>

<div class="sheet" id="sh-soul"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">How Meridian talks</h3><span class="end"><button class="ibtn bg" id="soul-edit" aria-label="Edit how Meridian talks">${icon('fix')}</button><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="soul-body"><p class="faint">Loading…</p></div>
  <div class="sf" id="soul-foot" hidden><div style="display:flex;gap:8px"><button class="btn ghost" id="soul-cancel">Cancel</button><span style="flex:1"></span><button class="btn primary" id="soul-save">Save</button></div></div></div>

<div class="sheet" id="sh-pings"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">What pings you</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="pings-body"></div></div>

<div class="sheet" id="sh-trust"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Without asking</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="trust-body"></div></div>

<div class="sheet" id="sh-call"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">The call button</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="call-body"></div></div>

<div class="sheet" id="sh-way-tell"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Tell on your Home Screen</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb"><p style="color:var(--body)">A second icon that opens straight on the Tell box. Same app, its own front door.</p>
    <ol class="steps"><li>Open <b id="tell-link-host"></b> in <b>Safari</b> on this phone.</li><li>Tap <b>Share</b>, then <b>Add to Home Screen</b>. It’s called <b>Tell</b>, with a red icon.</li><li>Open it and tap the box. Wispr Flow works there, or the keyboard’s mic.</li></ol>
    <div class="copyfield"><code id="tell-link"></code><button class="btn sm" data-copy="#tell-link">Copy</button></div></div></div>

<div class="sheet" id="sh-way-button"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Action Button</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb"><p style="color:var(--body)">Press the button, say what you want changed, and carry on. Meridian does the safe parts straight away and pings you about anything that needs a tick.</p>
    <a class="btn primary wide" style="margin-top:14px" href="/downloads/shortcuts/Tell%20Meridian.shortcut" target="_blank" rel="noopener">${icon('button')}Add the Tell Meridian shortcut</a>
    <ol class="steps" style="margin-top:10px"><li>Tap the button above, then <b>Download</b>, then open it and tap <b>Add Shortcut</b>. It’s already set up for your Mac.</li><li>In <b>Settings → Action Button</b>, swipe to <b>Shortcut</b> and choose <b>Tell Meridian</b>.</li></ol>
    <p class="faint" style="font-size:12.5px;margin-top:10px">It listens, sends your words to the Home Mac and shows Meridian’s answer. It only works while Tailscale is on, like the rest of Meridian. If the Mac can’t make a plan, your words are saved as a note, so nothing’s lost.</p>
    <details style="margin-top:14px"><summary class="faint" style="font-size:13px">Or build it yourself</summary>
    <ol class="steps"><li>New shortcut: <b>Dictate Text</b>, with Stop Listening <b>After Pause</b>.</li><li><b>Get Contents of URL</b> with the address below. Method <b>POST</b>, Request Body <b>JSON</b>, one field: <b>text</b> = Dictated Text.</li><li><b>Show Notification</b> with Contents of URL.</li></ol>
    <div class="copyfield"><code id="tell-api"></code><button class="btn sm" data-copy="#tell-api">Copy</button></div></details></div></div>

<div class="sheet" id="sh-way-pings"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Buttons on notifications</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb"><p style="color:var(--body)">The ntfy app already shows buttons, so these work today. Press and hold a ping to see them.</p>
    <div class="note"><span class="ni">${glyph}</span><div class="nm"><b>Meridian needs a tick</b>Done: Milk, Call Dad. Drinks with Sam, Friday 20:00 needs a tick in Meridian.</div><span class="nt">now</span></div>
    <div class="note-acts"><span>Do it</span><span>Look first</span></div>
    <div class="note"><span class="ni">${glyph}</span><div class="nm"><b>Send Rowan the expenses claim</b>Reminder · on your to-do list</div><span class="nt">09:00</span></div>
    <div class="note-acts"><span>Done</span><span>In an hour</span></div>
    <p class="faint" style="font-size:12.5px;margin-top:14px">The buttons talk straight to the Home Mac over Tailscale. The iPhone app would put the same buttons on the Lock Screen without ntfy.</p></div></div>

<div class="sheet" id="sh-way-share"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Share to Meridian</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb"><p style="color:var(--body)">A web page can’t appear in the Share sheet. The iPhone app can: a link, a photo or an email shared to Meridian lands in Tell with your words on top, or in Stash.</p>
    <p class="faint" style="font-size:13px;margin-top:12px">Until then, the Action Button and the Tell icon are the quick ways in.</p></div></div>

<div class="sheet full" id="sh-widgets"><div class="grab"></div>
  <div class="sh"><h3 aria-level="2">Widgets and the rest</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="widgets-body"></div></div>

<div class="sheet" id="sh-report"><div class="grab"></div>
  <div class="sh"><h3 id="report-h">Summary</h3><span class="end"><button class="ibtn bg" data-close aria-label="Close">${icon('x')}</button></span></div>
  <div class="sb" id="report-body"></div></div>

<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>`;
nameControls(app);
new MutationObserver((records) => { for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1)nameControls(n.parentElement||n); }).observe(app,{childList:true,subtree:true});

/* ---------- keyboard: #app is the visible area ---------- */
// iOS doesn't shrink the page for the keyboard, so #app follows visualViewport.
// Anything at its bottom (a sheet, the composer) then sits on the keyboard.
const vv = window.visualViewport;
function fit() {
  const h = vv ? vv.height : innerHeight;
  // Only a focused field means a keyboard. At launch a Home Screen app can report a short
  // visualViewport for a moment, which squashed the whole app when this trusted it alone.
  const typing = !!document.activeElement?.matches('input,textarea,[contenteditable=true]');
  const open = vv && typing ? innerHeight - vv.height > 120 : false;
  // iOS 26 can leave offsetTop behind after the keyboard closes; snap back when it's gone.
  // With no keyboard, CSS sizes the app to the screen; nothing measured can squash it.
  app.style.top = open ? vv.offsetTop + 'px' : '';
  app.style.height = open ? h + 'px' : '';
  document.body.classList.toggle('typing', open);
  if (!open && scrollY) scrollTo(0, 0);
}
if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
addEventListener('resize', fit);
addEventListener('focusin', () => { fit(); setTimeout(fit, 350); });
addEventListener('focusout', () => setTimeout(fit, 60));
addEventListener('pageshow', fit);
fit();

/* ---------- toast ---------- */
let toastT;
function toast(msg, undo) {
  const t = $('#toast'), opener = document.activeElement;
  const hide = () => { t.classList.remove('on'); if (t.contains(document.activeElement) && opener?.isConnected) opener.focus({ preventScroll: true }); t.querySelectorAll('button').forEach((b) => b.inert = true); };
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  if (undo) t.querySelector('button').onclick = () => { hide(); undo(); };
  t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(hide, undo ? 5000 : 2600);
}

/* ---------- navigation ---------- */
const VIEWS = ['today', 'agents', 'money', 'more'];
let view = 'today';
function go(v, { quiet } = {}) {
  if (!VIEWS.includes(v)) v = 'today';
  view = v;
  $$('#app > .screen').forEach((s) => { s.hidden = s.id !== 's-' + v; });
  $$('.tab').forEach((t) => { if (t.dataset.go === v) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  if (!quiet) $('#s-' + v).scrollTop = 0;
  closeThread();
  store.set('last', v);
  if (v === 'money') loadMoney();
  if (v === 'more') renderMore();
  noteUsage('phone-' + v);
  if (location.hash && !quiet) history.replaceState(null, '', location.pathname + location.search);
}
const noteUsage = (v) => { const k = v + ':' + Math.floor(Date.now() / 600000); if (noteUsage[k]) return; noteUsage[k] = 1; fetch(api('/api/usage'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view: v }) }).catch(() => {}); };

/* ---------- sheets ---------- */
let openSheet = null;
function sheet(id, on) {
  const s = document.getElementById(id); if (!s) return;
  if (on && openSheet && openSheet !== id) sheet(openSheet, false);
  s.classList.toggle('on', on); $('#scrim').classList.toggle('on', on);
  openSheet = on ? id : null;
  if (on) { SHEET_OPEN[id]?.(); window.MeridianA11y?.open(s); } else { window.MeridianA11y?.close(s); SHEET_CLOSE[id]?.(); }
}
$('#scrim').onclick = () => openSheet && sheet(openSheet, false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openSheet) { e.preventDefault(); sheet(openSheet, false); } else if(e.key === 'Escape' && $('#thread').classList.contains('on')) { e.preventDefault(); closeThread(); } });
// Drag a sheet down by its grab bar or header to close it, as on iOS.
$$('.sheet').forEach((s) => {
  let y0 = null;
  const start = (e) => { if (e.target.closest('button,textarea,input')) return; y0 = e.touches[0].clientY; s.style.transition = 'none'; };
  const move = (e) => { if (y0 === null) return; const dy = Math.max(0, e.touches[0].clientY - y0); s.style.transform = `translateY(${dy}px)`; if (dy > 12) document.activeElement?.blur?.(); };
  const end = (e) => { if (y0 === null) return; const dy = (e.changedTouches[0].clientY - y0); y0 = null; s.style.transition = ''; s.style.transform = ''; if (dy > 90) sheet(s.id, false); };
  [$('.grab', s), $('.sh', s)].forEach((h) => { if (!h) return; h.addEventListener('touchstart', start, { passive: true }); h.addEventListener('touchmove', move, { passive: true }); h.addEventListener('touchend', end); });
});
const SHEET_OPEN = {}; const SHEET_CLOSE = {};

/* ---------- Today ---------- */
const skipRes = () => (S?.nudges?.skip || []).map((x) => { try { return new RegExp(x, 'i'); } catch { return null; } }).filter(Boolean);
function upcoming() {
  const seen = new Set();
  return (S?.calendar?.events || []).filter((e) => (e.end || e.ts) >= Date.now() && e.response !== 'declined').sort((a, b) => a.ts - b.ts)
    .filter((e) => { const k = e.ts + '|' + String(e.title).trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function waitingIds() { return new Set((S?.invites || []).map((i) => i.calendarId).filter(Boolean)); }
const notAnswered = (e, w = waitingIds()) => e.response === 'needsAction' || w.has(e.id);
function headline() {
  const evs = upcoming(); const re = skipRes();
  // The daily routine meeting never takes the headline (Owner asked never to be reminded of it).
  return evs.find((e) => !re.some((r) => r.test(String(e.title).trim()))) || evs[0] || null;
}
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Late one' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'; }
// One line under the greeting: what's left today, how tomorrow starts, and anything due soon.
function dayLine() {
  const evs = upcoming().filter((e) => !e.allDay);
  const t0 = startOfDay(Date.now());
  const today = evs.filter((e) => startOfDay(e.ts) === t0);
  const tomorrow = evs.filter((e) => startOfDay(e.ts) === t0 + 86400e3);
  const soon = (S?.deadlines || []).filter((d) => !d.done && !d.archived && daysUntil(d.due) >= 0 && daysUntil(d.due) <= 2).sort((a, b) => a.due.localeCompare(b.due))[0];
  const bits = [];
  bits.push(today.length ? `${today.length} more thing${today.length === 1 ? '' : 's'} today.` : 'Nothing else booked today.');
  if (tomorrow.length) bits.push(`Tomorrow starts at ${hm(tomorrow[0].ts)}${tomorrow.length > 1 ? `, ${tomorrow.length} things in all` : ''}.`);
  if (soon) bits.push(`${cap(soon.title.split(':')[0], 40)} is due ${daysUntil(soon.due) === 0 ? 'today' : daysUntil(soon.due) === 1 ? 'tomorrow' : 'in 2 days'}.`);
  return bits.join(' ');
}

function needsItems() {
  if (!S) return [];
  const out = []; const now = Date.now(); const w = waitingIds();
  // Invites and meetings nobody has answered yet.
  const seenSeries = new Set();
  const invites = (S.invites || []).filter((i) => Date.parse(i.end || i.start) >= now).sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .filter((i) => { const k = String(i.title).trim().toLowerCase(); if (seenSeries.has(k)) return false; seenSeries.add(k); return true; });
  for (const v of invites) {
    const ts = Date.parse(v.start); const outlook = v.source !== 'ics';
    out.push({ key: 'inv:' + v.id, ts, dot: 'you', title: v.title, sub: `${dayWord(ts)} · ${hm(ts)}${v.organizer ? ' · from ' + v.organizer : ''} · not answered`,
      acts: outlook ? [{ l: 'Accept', p: 1, a: 'respond', invite: v.id, r: 'accept' }, { l: 'Maybe', a: 'respond', invite: v.id, r: 'tentative' }, { l: 'No', a: 'respond', invite: v.id, r: 'decline' }] : (v.url ? [{ l: 'Open in Outlook', a: 'url', url: v.url }] : []) });
  }
  for (const e of upcoming().filter((e) => e.response === 'needsAction' && !w.has(e.id) && e.cal === 'Outlook').slice(0, 3)) {
    out.push({ key: 'ev:' + e.id, ts: e.ts, dot: 'you', title: e.title, sub: `${dayWord(e.ts)} · ${hm(e.ts)} · not answered`, acts: [{ l: 'Accept', p: 1, a: 'respond', event: e.id, r: 'accept' }, { l: 'Maybe', a: 'respond', event: e.id, r: 'tentative' }] });
  }
  // Plans from Tell still waiting for a tick.
  for (const t of tells.filter((t) => t.status === 'ready' && t.actions.some((a) => a.state === 'planned')).slice(0, 4)) {
    const n = t.actions.filter((a) => a.state === 'planned').length;
    out.push({ key: 'tell:' + t.id, ts: Date.parse(t.created), dot: 'you', who: 'Meridian', cls: 'meridian', title: n === 1 ? t.actions.find((a) => a.state === 'planned').title : `${n} changes waiting for a tick`, sub: `Tell · ${ago(Date.parse(t.created))} ago`, acts: [{ l: 'Review', p: 1, a: 'review', tell: t.id }] });
  }
  // Drafts the Dot or an agent wrote, waiting to be read.
  for (const d of drafts.filter((d) => d.status !== 'sent' && d.lastBy && d.lastBy !== 'you' && now - Date.parse(d.updated) < 3 * 86400e3).slice(0, 3)) {
    out.push({ key: 'draft:' + d.id, ts: Date.parse(d.updated), dot: 'you', who: d.lastBy, cls: /dot|chatgpt|codex/i.test(d.lastBy) ? 'openai' : /claude/i.test(d.lastBy) ? 'claude' : 'meridian', title: d.title || d.subject || 'A draft', sub: `Draft ${d.kind || ''} · ${d.status === 'ready' ? 'ready to send' : 'waiting for you to read'}`, acts: [{ l: 'Read it', p: 1, a: 'url', url: '/draft?id=' + d.id }] });
  }
  // Dogfood fixes that went live, and runs that went wrong.
  for (const r of (S.delegations?.runs || [])) {
    if (r.undoneAt || r.archivedAt) continue;
    if (r.kind === 'feedback' && r.status === 'done' && now - (r.finished || r.started) < 2 * 86400e3) {
      out.push({ key: 'run:' + r.id, ts: r.finished || r.started, dot: 'you', who: /codex|gpt/i.test(r.model) ? 'Codex' : 'Claude', cls: /codex|gpt/i.test(r.model) ? 'codex' : 'claude', title: r.title, sub: `Dogfood fix is live · ${ago(r.finished || r.started)} ago`, acts: [{ l: 'Keep it', p: 1, a: 'keep', run: r.id }, { l: 'What changed', a: 'report', run: r.id, title: r.title }, ...(r.undoable ? [{ l: 'Undo', a: 'runundo', run: r.id }] : [])] });
    } else if (['failed', 'stalled'].includes(r.status) && now - r.started < 2 * 86400e3) {
      out.push({ key: 'run:' + r.id, ts: r.started, dot: 'bad', who: /codex|gpt/i.test(r.model) ? 'Codex' : 'Claude', cls: /codex|gpt/i.test(r.model) ? 'codex' : 'claude', title: r.title, sub: `${r.status === 'failed' ? 'Failed' : 'Stopped answering'} · ${ago(r.started)} ago`, acts: [{ l: 'What happened', a: 'report', run: r.id, title: r.title }, { l: 'Put away', a: 'keep', run: r.id }] });
    }
  }
  for (const p of (S.github?.reviews || []).slice(0, 3)) out.push({ key: 'pr:' + p.url, ts: Date.parse(p.updatedAt), dot: 'you', title: p.title, sub: `Review asked · ${String(p.repo || '').split('/').pop()} #${p.number}`, acts: [{ l: 'Open on GitHub', a: 'url', url: p.url }] });
  return out.sort((a, b) => (a.key.startsWith('inv') || a.key.startsWith('ev') ? 0 : 1) - (b.key.startsWith('inv') || b.key.startsWith('ev') ? 0 : 1) || a.ts - b.ts);
}
function needHTML(n) {
  return `<div class="job" data-need="${esc(n.key)}"><span class="dot ${n.dot}"></span><div class="main"><div class="t">${esc(n.title)}</div>
    <div class="s">${n.who ? `<span class="who ${n.cls || ''}">${esc(n.who)}</span> · ` : ''}${esc(n.sub)}</div>
    ${n.acts.length ? `<div class="acts">${n.acts.map((a, i) => `<button class="btn sm ${a.p ? 'primary' : ''}" data-act="${i}">${esc(a.l)}</button>`).join('')}</div>` : ''}</div></div>`;
}
let NEEDS = [];

function openTodos() {
  const rank = (t) => ['now', 'next', 'later'].indexOf(t.priority || 'next');
  return (S?.todos || []).filter((t) => !t.done && !hiddenTodos.has(t.id)).sort((a, b) => rank(a) - rank(b) || (a.order || 0) - (b.order || 0));
}
const hiddenTodos = new Set();
let todosOpen = false;
function todoRow(t) {
  return `<div class="row" data-todo="${esc(t.id)}" style="max-height:120px"><button class="tick" aria-label="Done">${tickSvg}</button><div class="main"><div class="t">${esc(t.title)}${t.priority === 'now' ? '<span class="src" style="color:var(--accent)">now</span>' : ''}${t.delegation && t.delegation.status === 'running' ? '<span class="src">agent on it</span>' : ''}</div>${noteText(t.note) ? `<div class="s">${esc(cap(noteText(t.note), 90))}</div>` : ''}</div></div>`;
}
// Notes written by the brief start with the day they were made; the list doesn't need it.
const noteText = (n) => String(n || '').replace(/^(?:(?:prepare )?on )?(?:\w+day )?\d{1,2} \w+ \d{4}(?: for (?:\w+day )?\d{1,2} \w+(?: \d{4})?)?[.,:]?\s*/i, '').trim();
function inboxItems() {
  if (!S) return [];
  const fb = S.briefFeedback || {}; const today = isoDay();
  const hidden = new Set([...(fb.completed || []), ...(fb.rejected || []), ...((fb.skipped && fb.skipped[today]) || [])]);
  const intake = new Map(((S.briefIntake || {}).items || []).filter((i) => i.projectId).map((i) => [i.projectId, i]));
  const rank = (p) => p === 'high' ? 2 : p === 'normal' ? 1 : 0;
  return ((S.projects && S.projects.projects) || []).filter((c) => c.brief && c.status !== 'done' && !hidden.has('project:' + c.id) && !hiddenTodos.has('project:' + c.id)).map((p) => {
    const i = intake.get(p.id);
    return { id: p.id, title: p.title, source: p.source || i?.source || '', from: p.sourceFrom || i?.from || '', url: p.sourceUrl || i?.url || '', when: p.sourceReceivedAt || i?.receivedAt || p.updated, priority: p.priority };
  }).sort((a, b) => rank(b.priority) - rank(a.priority) || String(b.when || '').localeCompare(String(a.when || '')));
}
const SRC = { outlook: 'Outlook', slack: 'Slack', teams: 'Teams', meridian: 'Meridian' };

// The owner's install says Owner. A fresh install uses the name given in Customise (or none), and the demo is Sam's.
const youName = () => !S?.setup ? 'Owner' : S.setup.demo ? 'Sam' : store.get('name', '');

function renderToday() {
  const d = new Date();
  setHTML($('#t-eyebrow'), [`${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`, sky?.now ? `${S?.location?.name || (S?.setup ? 'Outside' : 'Belfast')} ${Math.round(sky.now.temp)}° · ${esc(String(sky.now.label || '').toLowerCase())}` : '', sky?.today?.sunset ? `Sunset ${esc(sky.today.sunset)}` : ''].filter(Boolean).map((x) => `<span>${x}</span>`).join(''));
  setHTML($('#t-hello'), `${greeting()}${youName() ? ', ' + esc(youName()) : ''}<span class="stop">.</span>`);
  const next = headline();
  setHTML($('#t-line'), esc(S ? dayLine() : offline ? 'Can’t get your day while offline.' : 'Getting your day from the Home Mac…'));

  NEEDS = needsItems();
  $('#t-needs-sec').hidden = !NEEDS.length;
  setHTML($('#t-needs-n'), NEEDS.length ? String(NEEDS.length) : '');
  setHTML($('#t-needs'), NEEDS.slice(0, 4).map(needHTML).join('') + (NEEDS.length > 4 ? `<button class="more-link" data-go="agents">${NEEDS.length - 4} more in Agents</button>` : ''));

  if (next) {
    const mins = next.end ? Math.round((next.end - next.ts) / 60000) : 0;
    const inMin = Math.round((next.ts - Date.now()) / 60000);
    const when = next.ts <= Date.now() ? 'On now' : inMin < 120 ? `In ${inMin} min` : dayWord(next.ts);
    const live = next.joinUrl && inMin < 15;
    setHTML($('#t-next'), `<div class="next"><div class="when"><b>${next.allDay ? 'All day' : hm(next.ts)}</b><span>${esc(when)}${mins && !next.allDay ? ' · ' + (mins >= 60 ? (mins / 60).toFixed(1).replace(/\.0$/, '') + ' h' : mins + ' min') : ''}</span></div>
      <h4 aria-level="2">${esc(next.title)}</h4>
      <div class="meta">${notAnswered(next) ? '<span class="pill you">Not accepted</span>' : next.response === 'tentative' ? '<span class="pill ok">Maybe</span>' : ''}${next.location && !/^https?:/.test(next.location) ? `<span>${esc(cap(next.location, 40))}</span>` : ''}<span>${esc(next.calendar || next.cal || '')}</span></div>
      <div class="acts">${next.joinUrl ? `<a class="btn ${live ? 'primary' : 'glass'} sm" href="${esc(next.joinUrl)}" target="_blank" rel="noopener">${icon('out')}${/teams\.microsoft/.test(next.joinUrl) ? 'Join Teams' : 'Join'}</a>` : ''}<button class="btn glass sm" data-tell="Move ${esc(next.title)} on ${esc(dayWord(next.ts))} at ${hm(next.ts)} to ">${icon('cal')}Move…</button></div></div>`);
  } else setHTML($('#t-next'), S ? '<div class="card faint">Nothing booked in the next week.</div>' : '');

  const todos = openTodos();
  setHTML($('#t-todo-n'), todos.length ? `${todos.length} open` : '');
  const shown = todosOpen ? todos : todos.slice(0, 6);
  setHTML($('#t-todos'), shown.map(todoRow).join('') + (todos.length > 6 ? `<button class="more-link" id="todos-more">${todosOpen ? 'Show fewer' : `${todos.length - 6} more`}</button>` : '') + (!todos.length && S ? '<div class="empty">Nothing on the list.</div>' : ''));

  const inbox = inboxItems();
  $('#t-inbox-sec').hidden = !inbox.length;
  setHTML($('#t-inbox-n'), inbox.length ? String(inbox.length) : '');
  setHTML($('#t-inbox'), inbox.slice(0, 3).map((x) => `<div class="row" data-inbox="${esc(x.id)}" style="max-height:120px"><button class="tick" aria-label="Done">${tickSvg}</button><div class="main"><div class="t">${esc(x.title)}</div><div class="s">${esc([SRC[x.source] || x.source, x.from].filter(Boolean).join(' · '))}</div></div>${x.url ? `<a class="ibtn" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="Open">${icon('out')}</a>` : ''}</div>`).join(''));

  const w = waitingIds();
  const coming = upcoming().filter((e) => e !== next && e.ts < Date.now() + 7 * 86400e3).slice(0, 10);
  setHTML($('#t-coming-n'), coming.length ? `${upcoming().filter((e) => e.ts < Date.now() + 7 * 86400e3).length} this week` : '');
  setHTML($('#t-coming'), coming.length ? `<div class="rows">${coming.map((e) => `<div class="row"><div class="day">${esc(dayWord(e.ts))}<small>${e.allDay ? 'all day' : hm(e.ts)}</small></div><span class="bar" style="background:${esc(e.color || 'var(--blue)')}"></span><div class="main"><div class="t">${esc(e.title)}</div>${notAnswered(e, w) ? '<div class="s" style="color:var(--warn)">Not accepted yet</div>' : e.location && !/^https?:/.test(e.location) ? `<div class="s">${esc(e.location)}</div>` : ''}</div></div>`).join('')}</div>` : `<div class="empty">${S ? 'A clear week.' : ''}</div>`);

  const today = isoDay();
  const dls = (S?.deadlines || []).filter((d) => !d.done && !d.archived && !(d.snoozedUntil && d.snoozedUntil > today) && daysUntil(d.due) >= 0).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  $('#t-dl-sec').hidden = !dls.length;
  setHTML($('#t-dl'), dls.map((d) => { const n = daysUntil(d.due); return `<div class="dl ${n > 14 ? 'far' : ''}"><b>${n === 0 ? 'Today' : n + 'd'}<small>${esc(dayWord(Date.parse(d.due + 'T12:00:00')))}</small></b><p>${esc(d.title)}</p></div>`; }).join(''));
}

/* ---------- Agents ---------- */
const toolName = (t) => t === 'codex' ? 'Codex' : t === 'claude' ? 'Claude' : t;
function projects() {
  const now = (S?.ledger?.now || '');
  const secs = []; let cur = null;
  for (const line of now.split('\n')) {
    const m = /^##\s+(.+)/.exec(line);
    if (m) { cur = { name: m[1].trim(), text: '' }; secs.push(cur); } else if (cur && line.trim() && !/^#/.test(line)) cur.text += (cur.text ? ' ' : '') + line.trim().replace(/^[-*]\s*/, '');
  }
  const items = S?.journalToday?.items || [];
  const sessions = S?.ai?.sessions || [];
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(secs.map((s) => [key(s.name), s]));
  for (const it of items) if (!byName.has(key(it.name))) { const s = { name: it.name, text: '' }; secs.push(s); byName.set(key(it.name), s); }
  return secs.map((s) => {
    const it = items.find((x) => key(x.name) === key(s.name));
    const ses = sessions.filter((x) => key(String(x.project || '').split('/').pop()) === key(s.name)).sort((a, b) => b.last - a.last);
    return { ...s, today: it, latest: ses[0], live: ses.some((x) => x.live), last: Math.max(it?.last || 0, ses[0]?.last || 0) };
  }).sort((a, b) => (b.live - a.live) || (b.last - a.last));
}
function renderAgents() {
  setHTML($('#a-needs'), NEEDS.map(needHTML).join(''));
  $('#a-needs-sec').hidden = !NEEDS.length;
  const ses = (S?.ai?.sessions || []).filter((s) => s.live);
  const runs = (S?.delegations?.runs || []).filter((r) => r.status === 'running' || r.status === 'queued');
  const busy = tells.filter((t) => t.status === 'planning' || t.status === 'applying');
  const work = [
    ...busy.map((t) => `<div class="job"><span class="dot run"></span><div class="main"><div class="t">${esc(cap(t.text, 90))}</div><div class="s"><span class="who meridian">Meridian</span> · Tell · ${t.status === 'planning' ? 'reading it' : 'making the changes'}</div></div><span class="r">${ago(Date.parse(t.created))}</span></div>`),
    ...runs.map((r) => `<div class="job"><span class="dot run"></span><div class="main"><div class="t">${esc(r.title)}</div><div class="s"><span class="who ${/codex|gpt/i.test(r.model) ? 'codex' : 'claude'}">${esc(r.model || '')}</span> · ${r.kind === 'feedback' ? 'Dogfood' : 'Delegated'}</div></div><span class="r">${ago(r.started)}</span></div>`),
    ...ses.map((s) => `<div class="job"><span class="dot run"></span><div class="main"><div class="t">${esc(cap(s.did || s.prompt || 'Working', 110))}</div><div class="s"><span class="who ${s.tool}">${toolName(s.tool)}</span> · ${esc(String(s.project || '').split('/').pop())}</div></div><span class="r">${ago(s.started)}</span></div>`),
  ];
  setHTML($('#a-work-n'), work.length ? String(work.length) : '');
  setHTML($('#a-work'), work.join('') || '<div class="empty">Nothing running right now.</div>');
  const projs = projects().slice(0, 8);
  setHTML($('#a-proj'), projs.map((p) => {
    const tags = [];
    if (p.live) tags.push('<span style="color:var(--good)">working now</span>');
    if (p.today?.sessions) { const n = Object.entries(p.today.sessions).filter(([, v]) => v).map(([k, v]) => `${v} ${toolName(k)}`).join(' · '); if (n) tags.push(`<span>${esc(n)} today</span>`); }
    if (p.today?.commits?.length) tags.push(`<span>${p.today.commits.length} commit${p.today.commits.length === 1 ? '' : 's'}</span>`);
    const latest = p.latest ? cap(p.latest.did || p.latest.prompt || '', 160) : '';
    return `<div class="proj"><div class="ph"><b>${esc(p.name)}</b><span class="r">${p.last ? agoText(p.last) : ''}</span></div>${p.text ? `<p>${esc(cap(p.text, 220))}</p>` : ''}${latest ? `<p style="color:var(--dim)">Last: ${esc(latest)}</p>` : ''}${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div>`;
  }).join('') || '<div class="card empty">No projects in NOW.md yet.</div>');
  const today0 = startOfDay(Date.now());
  const done = [
    ...tells.filter((t) => t.status === 'done' && Date.parse(t.created) >= today0).slice(0, 4).map((t) => ({ ts: Date.parse(t.updated || t.created), html: `<div class="job"><span class="dot ok"></span><div class="main"><div class="t">${esc(t.receipt || 'Tell')}</div><div class="s"><span class="who meridian">Meridian</span> · ${esc(cap(t.text, 70))}</div></div><span class="r">${hm(Date.parse(t.updated || t.created))}</span></div>` })),
    ...(S?.delegations?.runs || []).filter((r) => r.status === 'done' && (r.finished || r.started) >= today0).map((r) => ({ ts: r.finished || r.started, html: `<div class="job"><span class="dot ok"></span><div class="main"><div class="t">${esc(r.title)}</div><div class="s"><span class="who ${/codex|gpt/i.test(r.model) ? 'codex' : 'claude'}">${esc(r.model || '')}</span> · ${r.kind === 'feedback' ? 'Dogfood' : 'Delegated'}</div></div><span class="r">${hm(r.finished || r.started)}</span></div>` })),
    ...(S?.ai?.sessions || []).filter((s) => !s.live && s.last >= today0).slice(0, 6).map((s) => ({ ts: s.last, html: `<div class="job"><span class="dot ok"></span><div class="main"><div class="t">${esc(cap(s.did || s.prompt || 'A session', 110))}</div><div class="s"><span class="who ${s.tool}">${toolName(s.tool)}</span> · ${esc(String(s.project || '').split('/').pop())}</div></div><span class="r">${hm(s.last)}</span></div>` })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 10);
  setHTML($('#a-done'), done.map((x) => x.html).join('') || '<div class="empty">Nothing finished yet today.</div>');
  const last = tells[0];
  setHTML($('#a-pin-s'), esc(last ? cap(last.receipt || last.reply || last.text, 80) : 'Everything you’ve told it, and what it did'));
  const seen = store.get('threadSeen', 0);
  $('#a-unread').hidden = !(last && Date.parse(last.updated || last.created) > seen);
  const b = $('#badge'); const n = NEEDS.length; b.hidden = !n; b.textContent = n;
}

/* ---------- More ---------- */
function renderMore() {
  const o = store.get('opens', 'today');
  $$('#opento button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.open === o)));
  $('#classic-sw').setAttribute('aria-checked', String(localStorage.getItem('meridian.phone.layout') === 'classic'));
  const q = S?.notify?.quiet; setHTML($('#more-quiet'), (q && q.on !== false ? `quiet ${esc(q.from)}–${esc(q.to)} ` : '') + icon('chev'));
  setHTML($('#more-call'), (store.get('call', null) ? 'set ' : 'set it up ') + icon('chev'));
  setHTML($('#more-at'), S?.at ? 'updated ' + hm(S.at) : '');
  const host = S?.tailnet?.host ? 'https://' + S.tailnet.host : location.origin;
  $('#tell-link').textContent = host + '/tell';
  $('#tell-link-host').textContent = host.replace(/^https?:\/\//, '') + '/tell';
  $('#tell-api').textContent = host + '/api/tell?mode=auto&via=action-button&wait=25000&format=text';
}

function render() { renderToday(); renderAgents(); if (view === 'more') renderMore(); if ($('#thread').classList.contains('on')) renderThread(); }

/* ---------- Tell ---------- */
// The sheet holds one conversation at a time: what you said, Meridian's plan as
// cards you can untick or edit, then receipts with Undo.
let current = null;         // the tell on screen
let route = 'auto';
const TELL_HINT = 'Say or type anything you want changed. Calendar, to-dos, money, reminders, emails, a Meridian fix…';
function tellInputHTML(prefill = '') {
  return `<div class="routes" id="routes">${[['auto', 'spark', 'Meridian decides'], ['fix', 'fix', 'Meridian fix'], ['note', 'note', 'Just note it']].map(([k, i, l]) => `<button class="chip" data-route="${k}" aria-pressed="${route === k}">${icon(i)}${l}</button>`).join('')}</div>
    <div class="tell-in"><textarea aria-label="Tell Meridian" id="tell-text" placeholder="${esc(TELL_HINT)}" enterkeyhint="enter" autocapitalize="sentences">${esc(prefill)}</textarea>
    <div class="tell-tools"><span class="hint">${icon('mic')}Wispr Flow works here</span></div></div>
    ${recentTellsHTML()}`;
}
function recentTellsHTML() {
  const recent = tells.filter((t) => t.status !== 'planning').slice(0, 3);
  if (!recent.length) return '';
  return `<div class="group-h">Earlier</div><div class="card list">${recent.map((t) => `<button class="list-link" style="font-size:14.5px" data-review="${esc(t.id)}"><span class="main" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(cap(t.text, 80))}</span><span class="end">${esc(t.receipt || (t.status === 'ready' ? 'waiting' : t.status))} ${icon('chev')}</span></button>`).join('')}</div>`;
}
function openTell(prefill = '', { focus = true, instant = false } = {}) {
  current = null;
  setHTML($('#tell-body'), tellInputHTML(prefill));
  setTellFoot('input');
  // From the Tell icon there's nothing to slide in from: it's simply open.
  const sh = $('#sh-tell'); if (instant) { sh.style.transition = 'none'; $('#scrim').style.transition = 'none'; }
  sheet('sh-tell', true);
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => { sh.style.transition = ''; $('#scrim').style.transition = ''; }));
  const ta = $('#tell-text');
  // Focus inside the tap itself, or iOS won't bring the keyboard up.
  if (focus) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
  grow(ta);
  noteUsage('phone-tell');
}
function grow(ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.45) + 'px'; }
function setTellFoot(mode, t) {
  const f = $('#tell-foot');
  if (mode === 'input') { setHTML(f, `<div class="plan-foot" style="margin:0"><span class="grow faint" style="font-size:12.5px">Goes to the Home Mac. Nothing changes until you say.</span><button class="btn primary" id="tell-go">${icon('send')}Send</button></div>`); return; }
  if (mode === 'plan' && t) {
    const planned = t.actions.filter((a) => a.state === 'planned');
    const on = planned.filter((a) => a.on !== false).length;
    if (t.status === 'ready' && planned.length) { setHTML(f, `<div class="plan-foot" style="margin:0"><button class="btn ghost" id="tell-later">Do it later</button><span class="grow"></span><button class="btn primary" id="tell-apply" ${on ? '' : 'disabled'}>${on ? `Make ${on} change${on === 1 ? '' : 's'}` : 'Nothing ticked'}</button></div>`); return; }
    if (t.status === 'failed') { setHTML(f, `<div class="plan-foot" style="margin:0"><button class="btn ghost" id="tell-inbox">Save as a note</button><span class="grow"></span><button class="btn primary" id="tell-retry">${icon('refresh')}Try again</button></div>`); return; }
    if (t.status === 'planning' || t.status === 'applying') { setHTML(f, `<div class="plan-foot" style="margin:0"><span class="grow faint" style="font-size:12.5px">It keeps going if you close this.</span><button class="btn" data-close>Close</button></div>`); return; }
    setHTML(f, `<div class="plan-foot" style="margin:0"><button class="btn ghost" id="tell-new">${icon('plus')}Tell something else</button><span class="grow"></span><button class="btn" data-close>Done</button></div>`);
  }
}
// Plan cards, used by the sheet and the thread alike.
function actHTML(t, a, i) {
  const k = ACT_CLASS[a.group] || 'note';
  const ask = a.ask && a.state === 'planned' ? `<div class="why">${esc(a.ask.q)}</div><div class="q">${a.ask.options.map((o, j) => `<button data-choice="${j}" aria-pressed="${(a.choice || 0) === j}">${esc(o.label)}</button>`).join('')}</div>` : '';
  const res = a.result ? `<div class="res ${a.state === 'failed' ? 'bad' : ''}">${esc(a.result)}</div>` : '';
  const link = a.state === 'done' && a.link ? `<div class="q"><a class="btn sm" href="${esc(api(a.link))}" ${/\.ics$/.test(a.link) ? '' : 'target="_blank" rel="noopener"'}>${icon(/\.ics$/.test(a.link) ? 'cal' : a.link.startsWith('#') ? 'fix' : 'mail')}${/\.ics$/.test(a.link) ? 'Add to Calendar' : a.link.startsWith('#') ? 'See Dogfood' : 'Read draft'}</a></div>` : '';
  const conf = a.state === 'planned' && a.confirm ? '<div class="why" style="color:var(--dim)">Waits for your tick</div>' : '';
  return `<div class="act ${a.state === 'planned' && a.on !== false ? 'on' : ''} ${a.ask && a.state === 'planned' ? 'ask' : ''} ${a.state === 'done' ? 'did' : ''} ${a.state === 'failed' ? 'failed' : ''} ${a.state === 'undone' ? 'undone' : ''} ${a.state === 'skipped' ? 'skipped' : ''} ${a.state === 'doing' ? 'busy' : ''}" data-tell-id="${esc(t.id)}" data-i="${i}">
    <span class="k ${k}">${icon(a.state === 'done' ? 'check' : ACT_ICON[a.icon] || 'note')}</span>
    <div class="main"><div class="t" data-edit-title>${esc(a.title)}</div>${a.detail ? `<div class="s">${esc(a.detail)}</div>` : ''}${ask}${conf}${a.state === 'doing' ? '<div class="res" style="color:var(--dim)">Working on it…</div>' : res}${link}</div>
    ${a.state === 'planned' ? `<button class="sw" aria-label="Include">${tickSvg}</button>` : ''}${a.state === 'done' && a.canUndo ? '<button class="undo">Undo</button>' : ''}${a.state === 'undone' ? '<span class="undo" style="display:block">Undone</span>' : ''}</div>`;
}
function tellHTML(t, { inThread } = {}) {
  const say = inThread ? '' : `<div class="said">${esc(t.text)}<small>${ago(Date.parse(t.created))} ago${t.via && t.via !== 'phone' ? ' · ' + esc(t.via.replace('-', ' ')) : ''}</small></div>`;
  let mid = '';
  if (t.status === 'planning') mid = `<div class="think"><i></i>Reading it and checking your week…</div>`;
  else if (t.status === 'failed') mid = `<div class="think bad">Couldn’t make a plan: ${esc(t.error || 'something went wrong')}</div>`;
  else {
    const head = t.reply || (t.actions.length ? 'Here’s what I’ll do. Untick anything you don’t want.' : 'Nothing to change.');
    mid = `<div class="think ${t.status === 'done' ? 'ok' : ''}">${t.status === 'applying' ? '<i></i>' : ''}${esc(t.status === 'done' && t.receipt ? t.receipt : head)}</div>
      ${t.status === 'done' && t.reply && t.actions.length ? `<p class="faint" style="font-size:13.5px;margin:-2px 2px 8px">${esc(t.reply)}</p>` : ''}
      <div class="plan">${t.actions.map((a, i) => actHTML(t, a, i)).join('')}</div>
      ${t.status === 'ready' ? trustNoteHTML(t) : ''}
      ${t.status === 'done' && t.actions.some((a) => a.canUndo) ? '<div class="receipt">Undo any of these for the next day · they’re in Agents → Meridian</div>' : ''}`;
  }
  return say + mid;
}
let trustCache = null;
function trustNoteHTML(t) {
  const groups = [...new Set(t.actions.filter((a) => a.state === 'planned' && a.confirm && !(a.people || []).length).map((a) => a.group))].filter((g) => ['calendar', 'fix'].includes(g));
  if (!groups.length) return '';
  const g = groups[0];
  return `<div class="kindrow card" style="margin-top:12px;padding:10px 14px"><div class="main"><div class="t" style="font-size:13.5px">${g === 'calendar' ? 'Calendar changes: just do them next time' : 'Meridian fixes: just start them next time'}</div><div class="s">Anything with other people still waits</div></div><button class="sw2" role="switch" data-trust="${g}" aria-checked="${!!trustCache?.trust?.[g]}"></button></div>`;
}
function showTell(t) {
  current = t;
  const i = tells.findIndex((x) => x.id === t.id); if (i >= 0) tells[i] = t; else tells.unshift(t);
  if (openSheet === 'sh-tell') {
    const sb = $('#tell-body'); const atBottom = sb.scrollHeight - sb.scrollTop - sb.clientHeight < 80;
    setHTML(sb, tellHTML(t));
    setTellFoot('plan', t);
    if (atBottom) sb.scrollTo({ top: sb.scrollHeight, behavior: 'smooth' });
  }
  if ($('#thread').classList.contains('on')) renderThread();
  renderToday(); renderAgents();
}
const watching = new Set();
async function watch(id) {
  if (watching.has(id)) return; watching.add(id);
  try {
    for (let n = 0; n < 60; n++) {
      // The server deliberately holds this read for twenty seconds.
      const { tell: t } = await getJSON(`/api/tell/${id}?wait=20000`, 25000);
      showTell(t);
      if (t.status !== 'planning' && t.status !== 'applying') break;
    }
  } catch { toast('Lost the Home Mac for a moment. Pull to refresh.'); }
  finally { watching.delete(id); }
}
async function sendTell(text, { mode = 'review', via = 'phone' } = {}) {
  text = text.trim(); if (!text) return null;
  if (route === 'note') {
    const r = await send('/api/capture', { text });
    toast(r.label || 'Saved as a note', async () => { try { await send(`/api/capture/${r.id}/undo`, {}); toast('Taken back out'); } catch (e) { toast(e.message); } });
    return null;
  }
  if (route === 'fix') text = 'Meridian fix (change the Meridian app itself): ' + text;
  const { tell: t } = await send('/api/tell', { text, mode, via });
  if (LAB) return null;
  showTell(t); watch(t.id);
  return t;
}
async function applyTell(t, { later } = {}) {
  if (later) {
    // Trusted parts now, the rest waits in Needs you.
    const picks = t.actions.map((a, i) => ({ i, on: a.state === 'planned' && a.on !== false && !a.confirm })).filter((p) => p.on);
    if (!picks.length) { sheet('sh-tell', false); toast('Saved. It’s waiting in Needs you'); return; }
    const { tell: x } = await send(`/api/tell/${t.id}/apply`, { picks: picks.map((p) => ({ ...p, choice: t.actions[p.i].choice, title: t.actions[p.i].title })) });
    showTell(x); watch(x.id); sheet('sh-tell', false); toast('Done the safe parts. The rest is in Needs you'); return;
  }
  const picks = t.actions.map((a, i) => ({ i, on: a.state === 'planned' && a.on !== false, choice: a.choice, title: a.title })).filter((p) => t.actions[p.i].state === 'planned');
  const { tell: x } = await send(`/api/tell/${t.id}/apply`, { picks });
  showTell(x); watch(x.id);
}
function findTell(id) { return (current && current.id === id) ? current : tells.find((t) => t.id === id); }
async function reviewTell(id) {
  let t = findTell(id);
  if (!t) { try { t = (await getJSON(`/api/tell/${id}`)).tell; } catch { toast('That one’s gone'); return; } }
  current = t;
  sheet('sh-tell', true);
  showTell(t);
  if (t.status === 'planning' || t.status === 'applying') watch(t.id);
}

/* ---------- the Meridian thread ---------- */
// Everything you've told Meridian and what it did, plus the pings it sent, in order.
function renderThread() {
  const items = [];
  for (const t of tells) items.push({ ts: Date.parse(t.created), html: `<div class="msg me"><div class="time">${esc(dayWord(Date.parse(t.created)))} ${hm(Date.parse(t.created))}${t.via && t.via !== 'phone' ? ' · ' + esc(t.via.replace('-', ' ')) : ''}</div><div class="b">${esc(t.text)}</div></div><div class="msg" style="max-width:100%">${tellHTML(t, { inThread: true })}${t.status === 'ready' && t.actions.some((a) => a.state === 'planned') ? `<div class="acts"><button class="btn sm primary" data-review="${esc(t.id)}">Review and do it</button></div>` : ''}</div>` });
  for (const n of (S?.notifyHistory || []).filter((n) => n.ok && ['meeting', 'reminder', 'deadline', 'delegation', 'summary'].includes(n.event)).slice(-25)) items.push({ ts: n.time, html: `<div class="msg"><div class="time">${esc(dayWord(n.time))} ${hm(n.time)} · ping</div><div class="b"><b>${esc(n.title)}</b>${n.message ? '<br>' + esc(cap(n.message, 200)) : ''}</div></div>` });
  items.sort((a, b) => a.ts - b.ts);
  let lastDay = '';
  const html = items.map((x) => { const d = dayWord(x.ts); const div = d !== lastDay ? `<div class="daydiv">${esc(d)}</div>` : ''; lastDay = d; return div + x.html; }).join('');
  const list = $('#thread-list'); const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  setHTML(list, html || `<div class="msg"><div class="b">I’m the part of Meridian that talks. Tell me anything you want changed, or ask about your week.</div></div>`);
  if (atBottom) list.scrollTop = list.scrollHeight;
}
function openThread() {
  renderThread();
  $('#thread').classList.add('on'); window.MeridianA11y?.open($('#thread'));
  const list = $('#thread-list'); list.scrollTop = list.scrollHeight;
  store.set('threadSeen', Date.now()); $('#a-unread').hidden = true;
}
function closeThread() { $('#thread').classList.remove('on'); window.MeridianA11y?.close($('#thread')); }
$('#open-thread').onclick = openThread;
$('#thread-back').onclick = closeThread;
const tbox = $('#thread-box');
tbox.addEventListener('input', () => { grow2(tbox); $('#thread-send').disabled = !tbox.value.trim(); });
function grow2(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 132) + 'px'; }
$('#thread-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const v = tbox.value.trim(); if (!v) return;
  tbox.value = ''; grow2(tbox); $('#thread-send').disabled = true;
  try { const prev = route; route = 'auto'; await sendTell(v); route = prev; renderThread(); const l = $('#thread-list'); l.scrollTop = l.scrollHeight; } catch (err) { toast(err.message); tbox.value = v; }
});
tbox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#thread-form').requestSubmit(); } });
// Tap the conversation to put the keyboard away, as in Messages.
$('#thread-list').addEventListener('click', (e) => { if (!e.target.closest('button,a,[contenteditable]')) tbox.blur(); });

/* ---------- Money ---------- */
let moneyLoaded = 0; let MC = null;
async function loadMoney() {
  const body = $('#m-body');
  if (Date.now() - moneyLoaded < 60000 && body.__h) return;
  try {
    const st = await getJSON('/api/money/status');
    $('#m-lockbtn').hidden = !st.unlocked;
    if (!st.setup) { setHTML(body, `<div class="card locked">${icon('lock')}<p style="margin-top:12px">Set a Money passcode on the Mac first, in the Money tab.</p></div>`); return; }
    if (!st.unlocked) {
      setHTML(body, `<form class="card locked" id="m-unlock">${icon('lock')}<p style="margin:12px 0 14px">Money is locked</p>
        <input type="text" name="username" autocomplete="username" value="Meridian Money" hidden aria-hidden="true">
        <div style="display:flex;gap:6px;justify-content:center;align-items:center">
          <input id="m-pass" aria-label="Money password" name="password" type="password" ${store.get('numpad', false) ? 'inputmode="numeric" ' : ''}autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Password" style="background:var(--card-2);border-radius:12px;height:46px;padding:0 14px;width:100%;max-width:220px;text-align:center;font-size:17px">
          <button type="button" class="ibtn bg" id="m-numpad" aria-label="${store.get('numpad', false) ? 'ABC' : '123'}: switch keyboard" style="height:46px;width:46px;font-size:12.5px;font-weight:600;color:var(--body)">${store.get('numpad', false) ? 'ABC' : '123'}</button></div>
        <label class="faint" style="display:flex;gap:8px;justify-content:center;align-items:center;margin-top:12px;font-size:13px"><input type="checkbox" id="m-remember" checked style="appearance:auto;width:16px;height:16px"> Keep it open on this phone for 30 days</label>
        <button class="btn primary" style="margin-top:14px">${icon('lock')}Unlock</button>
        <p class="faint" style="font-size:12px;margin-top:14px;line-height:1.45">Let iPhone save it when it asks. Next time, tap the box and Face ID fills it in.</p></form>`);
      return;
    }
    if (!MC) { await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/money-core.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); MC = window.MoneyCore; }
    const D = await getJSON('/api/money');
    if (!LAB && !D.approvedClaimsSeeded) {
      const seeded = await send('/api/money/receivables', { action: 'seed-approved' }); D.receivables = seeded.claims; D.senders = seeded.senders; D.approvedClaimsSeeded = seeded.approvedClaimsSeeded;
    }
    const P = MC.prepare(D.monzo.transactions, D.rules, { context: D.context, plans: D.plans, receivables: D.receivables });
    const claimOptions = '<option value="">Manual review only</option>' + (D.senders || []).map(x => `<option value="${esc(x.id)}">${esc(x.names.join(' / '))} · ${esc(x.id)}</option>`).join('');
    const claimsHTML = `<div class="card"><h2>Owed to you</h2>${(D.receivables || []).map(c => `<div class="row" style="flex-wrap:wrap"><div class="main"><div class="t">${esc(c.who)}${c.settled ? ' · paid back' : ''}</div><div class="s">${esc(c.note)}</div><div class="s">${c.sender ? 'Sender: ' + esc(c.sender.name) : 'Sender unverified · manual review only'}${c.matchedTransactionId ? ' · ' + esc(c.matchedTransactionId) : ''}</div>${!c.settled && (c.review || []).length ? `<div class="s">Review: ${c.review.map(r => esc(r.reason)).join('; ')}</div>` : ''}</div><span class="r">${gbp(c.amount)}</span><button class="btn" data-mclaimact="${esc(c.id)}" data-action="${c.settled ? 'undo' : 'settle'}">${c.settled ? 'Undo' : 'Paid back'}</button>${!c.settled ? `<div style="width:100%"><select aria-label="Verified bank sender">${claimOptions}</select><button class="btn" data-mclaimlink="${esc(c.id)}">Verify sender</button></div>` : ''}</div>`).join('')}
      ${P.filter(t => t.split).flatMap(t => t.split.filter(x => !x.settled).map(x => `<div class="row"><div class="main"><div class="t">${esc(x.who)}</div><div class="s">${esc(t.myNote || t.name)}</div></div><span class="r">${gbp(x.amount)}</span></div>`)).join('')}
      <details><summary>Add claim</summary><form id="m-claim"><label>Who owes you?<input name="who" required maxlength="80"></label><label>Amount in GBP<input name="amount" type="number" min="0.01" step="0.01" required></label><label>What is it for?<input name="note" maxlength="400"></label><label>Verified bank sender<select name="senderId">${claimOptions}</select></label><button class="btn primary">Add claim</button></form></details><p class="faint">Confirm senders from bank records. Automatic settlement needs a new posted GBP transfer from a verified sender for the exact amount.</p></div>`;

    const sp = MC.periodSpan('payday', P, isoDay()); const s = MC.summarize(P, sp);
    const pct = s.earned > 0 ? Math.max(0, Math.min(100, (s.spent / s.earned) * 100)) : 0;
    const recent = P.filter((t) => !t.synthetic && t.kind === 'spend').slice(-8).reverse();
    setHTML(body, `<div class="card"><div class="faint" style="font-size:13px">${sp.id === 'payday' ? 'Left since payday' : 'Left this month'}</div>
      <div class="money-big" style="margin-top:8px">${gbp(s.left)}<small>of ${gbp(s.earned)} in</small></div>
      <div class="meter"><i style="width:${pct.toFixed(1)}%;${s.left < 0 ? 'background:var(--bad)' : ''}"></i></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--dim);margin-top:8px"><span>${gbp(s.spent)} spent</span><span>${s.left < 0 ? 'Over' : 'On track'}</span></div></div>
      ${D.t212 ? `<div class="card" style="display:flex;align-items:baseline;gap:10px"><div style="flex:1"><div class="faint" style="font-size:13px">Investments</div><div style="font:500 26px/1.1 var(--f-display);margin-top:6px">${gbp(D.t212.account.value)}</div></div><span style="color:${D.t212.account.unrealised >= 0 ? 'var(--good)' : 'var(--bad)'};font-size:14px">${D.t212.account.unrealised >= 0 ? '+' : ''}${gbp(D.t212.account.unrealised)}</span></div>` : ''}
      <div class="card list"><div class="rows">${recent.map((t) => `<div class="row"><span class="bar" style="background:var(--dim2)"></span><div class="main"><div class="t">${esc(t.name || t.type)}</div><div class="s">${esc(t.cat || t.category || '')} · ${esc(dayWord(Date.parse(t.date + 'T12:00:00')))}</div></div><span class="r">${gbp(Math.abs(t.amount))}</span></div>`).join('') || '<div class="empty">No spending yet.</div>'}</div></div>
      ${claimsHTML}<button class="btn wide" style="margin-top:10px" data-tell="Money: ">${icon('pound')}Log or note something</button>`);
    moneyLoaded = Date.now();
  } catch (e) { setHTML(body, `<div class="card empty">Couldn’t load Money: ${esc(e.message)}</div>`); }
}
$('#m-body').addEventListener('submit', async (e) => {
  if (e.target.id === 'm-claim') {
    e.preventDefault(); const f = new FormData(e.target); const senderId = f.get('senderId');
    try { await send('/api/money/receivables', { action: 'create', who: f.get('who'), amount: f.get('amount'), note: f.get('note'), ...(senderId ? { senderId } : {}) }); moneyLoaded = 0; loadMoney(); } catch (err) { toast(err.message); } return;
  }
  if (e.target.id !== 'm-unlock') return; e.preventDefault();
  try { await send('/api/money/unlock', { passcode: $('#m-pass').value, remember: $('#m-remember').checked }); moneyLoaded = 0; $('#m-body').__h = ''; loadMoney(); }
  catch (err) { toast(err.message); $('#m-pass').value = ''; }
});
$('#m-body').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-mclaimact]'); const link = e.target.closest('[data-mclaimlink]');
  if (act || link) {
    const senderId = link?.parentElement.querySelector('select').value;
    if (link && !senderId) { toast('Choose a verified bank sender'); return; }
    try { await send('/api/money/receivables', act ? { action: act.dataset.action, id: act.dataset.mclaimact } : { action: 'link', id: link.dataset.mclaimlink, senderId }); moneyLoaded = 0; loadMoney(); } catch (err) { toast(err.message); } return;
  }
  if (!e.target.closest('#m-numpad')) return;
  const on = !store.get('numpad', false); store.set('numpad', on);
  const i = $('#m-pass'); if (on) i.setAttribute('inputmode', 'numeric'); else i.removeAttribute('inputmode');
  const button=e.target.closest('#m-numpad'); button.textContent = on ? 'ABC' : '123'; button.setAttribute('aria-label',button.textContent+': switch keyboard');
  i.blur(); i.focus();
});
$('#m-lockbtn').onclick = async () => { try { await send('/api/money/lock', {}); } catch { /* already locked */ } moneyLoaded = 0; $('#m-body').__h = ''; loadMoney(); };

/* ---------- soul.md ---------- */
let soulData = null; let soulEditing = false;
SHEET_OPEN['sh-soul'] = async () => { soulEditing = false; renderSoul(); try { soulData = await getJSON('/api/soul'); renderSoul(); } catch (e) { setHTML($('#soul-body'), `<p class="faint">${esc(e.message)}</p>`); } };
function renderSoul() {
  $('#soul-foot').hidden = !soulEditing;
  if (!soulData) return;
  if (soulEditing) { setHTML($('#soul-body'), `<div class="soul"><textarea id="soul-text" spellcheck="false">${esc(soulData.text)}</textarea></div>`); return; }
  const h = soulData.history || [];
  const latest = h[0];
  const note = latest ? `<div class="diffnote">${icon('soul')}<div><b>${esc(latest.by)} changed this ${esc(ago(Date.parse(latest.at)))} ago</b>${latest.why ? ` · ${esc(latest.why)}` : ''}<div class="lines">${(latest.added || []).map((l) => `<ins>+ ${esc(l)}</ins>`).join('')}${(latest.removed || []).map((l) => `<del>− ${esc(l)}</del>`).join('')}</div></div></div>` : '';
  const md = esc(soulData.text).replace(/^(#{1,3} .*)$/gm, '<b style="color:var(--ink)">$1</b>');
  setHTML($('#soul-body'), `${note}<div class="soul">${md || '<span class="faint">Empty. Meridian talks plainly with no voice of its own.</span>'}</div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" style="flex:1" id="soul-edit2">${icon('fix')}Edit it</button><button class="btn" style="flex:1" data-tell="In your soul file, ">${icon('spark')}Ask Meridian</button></div>
    ${h.length > 1 ? `<div class="group-h">History</div><div class="card list">${h.slice(1, 12).map((x) => `<div class="row"><div class="main"><div class="t" style="font-size:14px">${esc(x.by)} · ${esc(ago(Date.parse(x.at)))} ago</div><div class="s">${esc([...(x.added || []).map((l) => '+ ' + l), ...(x.removed || []).map((l) => '− ' + l)].join('  ') || x.why || '')}</div></div></div>`).join('')}</div>` : ''}
    <p class="faint" style="font-size:12.5px;margin-top:12px">Meridian reads this before it plans anything you tell it. Empty it to turn its voice off.</p>`);
}
function editSoul() { soulEditing = true; renderSoul(); const ta = $('#soul-text'); ta.focus({ preventScroll: true }); }
$('#soul-edit').onclick = editSoul;
$('#soul-body').addEventListener('click', (e) => { if (e.target.closest('#soul-edit2')) editSoul(); });
$('#soul-cancel').onclick = () => { soulEditing = false; renderSoul(); };
$('#soul-save').onclick = async () => { try { soulData = await send('/api/soul', { text: $('#soul-text').value, why: 'Edited on the phone' }, 'PUT'); soulEditing = false; renderSoul(); toast('Saved. Meridian will talk like this from now on'); } catch (e) { toast(e.message); } };

/* ---------- pings, trust, call ---------- */
const PING_KINDS = [
  ['needs', 'Needs you', 'A plan waiting for a tick, a draft to read', 'muted'],
  ['meeting', 'Before meetings', '10 minutes and 1 minute before, when there’s a link', 'muted'],
  ['tell', 'Receipts', 'One line after Tell has done something', 'muted'],
  ['delegation', 'Agent finished', 'A Dogfood fix or a delegated run is done', 'events'],
  ['deadline', 'Deadlines', 'The morning a deadline is due, and the day before', 'events'],
  ['fleet', 'Sites going down', 'Your projects’ sites and services', 'events'],
];
SHEET_OPEN['sh-pings'] = () => renderPings();
function renderPings() {
  const n = S?.notify || {}; const q = n.quiet || { on: true, from: '23:00', to: '08:00' };
  const isOn = ([k, , , where]) => where === 'events' ? (n.events || []).includes(k) : !(n.muted || []).includes(k);
  setHTML($('#pings-body'), `<div class="card list">
    <div class="kindrow"><div class="main"><div class="t">Pings to this phone</div><div class="s">Through ntfy. Reminders you set always come through</div></div><button class="sw2" role="switch" data-ping-all aria-checked="${n.enabled !== false}"></button></div></div>
    <div class="card list" style="margin-top:10px;${n.enabled === false ? 'opacity:.45;pointer-events:none' : ''}">${PING_KINDS.map((k) => `<div class="kindrow"><div class="main"><div class="t">${k[1]}</div><div class="s">${k[2]}</div></div><button class="sw2" role="switch" data-ping="${k[0]}" aria-checked="${isOn(k)}"></button></div>`).join('')}</div>
    <div class="group-h">Quiet hours</div>
    <div class="card list"><div class="kindrow"><div class="main"><div class="t">Hold pings overnight</div><div class="s">They come as one summary when it ends. A meeting starting now still rings</div></div><button class="sw2" role="switch" data-quiet aria-checked="${q.on !== false}"></button></div>
      <div class="kindrow"><div class="main"><div class="t">From</div></div><input type="time" id="q-from" aria-label="From" value="${esc(q.from)}"></div>
      <div class="kindrow"><div class="main"><div class="t">Until</div></div><input type="time" id="q-to" aria-label="Until" value="${esc(q.to)}"></div></div>
    <p class="faint" style="font-size:12.5px;margin-top:12px">Meridian never sends the same ping twice in six hours.</p>`);
}
async function savePings(patch) {
  try { const r = await send('/api/notify', patch, 'PATCH'); S.notify = { ...S.notify, ...r.notify }; renderPings(); renderMore(); } catch (e) { toast(e.message); renderPings(); }
}
$('#pings-body').addEventListener('click', (e) => {
  const sw = e.target.closest('.sw2'); if (!sw) return;
  const on = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(on));
  const n = S?.notify || {};
  if (sw.hasAttribute('data-ping-all')) return savePings({ enabled: on });
  if (sw.hasAttribute('data-quiet')) return savePings({ quiet: { on } });
  const k = sw.dataset.ping; const kind = PING_KINDS.find((x) => x[0] === k);
  if (kind[3] === 'events') { const ev = new Set(n.events || []); if (on) ev.add(k); else ev.delete(k); savePings({ events: [...ev] }); }
  else { const m = new Set(n.muted || []); if (on) m.delete(k); else m.add(k); savePings({ muted: [...m] }); }
});
$('#pings-body').addEventListener('change', (e) => { if (e.target.id === 'q-from' || e.target.id === 'q-to') savePings({ quiet: { from: $('#q-from').value, to: $('#q-to').value } }); });

const TRUST = [['todo', 'To-dos', 'Add, tick off, change'], ['remind', 'Reminders', 'A ping at a time you said'], ['deadline', 'Deadlines', 'Add one with its date'], ['money', 'Money notes', 'Notes a spend or an expense. Never moves money'], ['note', 'Notes', 'Saves a thought as a note in Stash'], ['draft', 'Drafts', 'Writes it for you to read. Never sends'], ['soul', 'How Meridian talks', 'Changes soul.md when you ask'], ['calendar', 'Calendar', 'Adds, moves or answers events. With other people it always asks'], ['fix', 'Meridian fixes', 'Starts a Dogfood fix']];
SHEET_OPEN['sh-trust'] = async () => { try { trustCache = await getJSON('/api/tell/settings'); } catch { /* shows the defaults */ } renderTrust(); };
function renderTrust() {
  const t = trustCache?.trust || {};
  setHTML($('#trust-body'), `<p style="color:var(--body);font-size:14.5px;margin-bottom:12px">When you tell Meridian something, these happen straight away, each with an Undo. Anything switched off waits for your tick.</p>
    <div class="card list">${TRUST.map(([k, l, s]) => `<div class="kindrow"><div class="main"><div class="t">${l}</div><div class="s">${s}</div></div><button class="sw2" role="switch" data-trust="${k}" aria-checked="${!!t[k]}"></button></div>`).join('')}</div>
    <p class="faint" style="font-size:12.5px;margin-top:12px">Emails, Slack messages and texts are only ever drafts.</p>`);
}
async function setTrust(k, on) { try { trustCache = await send('/api/tell/settings', { trust: { [k]: on } }, 'PUT'); toast(on ? 'Done without asking from now on' : 'It’ll wait for your tick'); } catch (e) { toast(e.message); } }

SHEET_OPEN['sh-call'] = () => {
  const c = store.get('call', { kind: 'shortcut', value: 'Call Dot' });
  setHTML($('#call-body'), `<p style="color:var(--body);font-size:14.5px">The phone button on Today rings your Dot. The quickest way is a shortcut called <b>Call Dot</b>.</p>
    <a class="btn primary wide" style="margin-top:12px" href="/downloads/shortcuts/Call%20Dot.shortcut" target="_blank" rel="noopener" onclick="store.set('call',{kind:'shortcut',value:'Call Dot'})">${icon('phone')}Add the Call Dot shortcut</a>
    <p class="faint" style="font-size:12.5px;margin-top:8px">It opens ChatGPT. To land straight in a voice call, edit it in Shortcuts and swap in ChatGPT’s own voice action (search “ChatGPT”). Keep the name.</p>
    <div class="group-h">Or point the button somewhere else</div>
    <div class="seg" id="call-kind" style="margin-top:12px"><button data-k="shortcut" aria-pressed="${c.kind === 'shortcut'}">A Shortcut</button><button data-k="tel" aria-pressed="${c.kind === 'tel'}">A number</button><button data-k="url" aria-pressed="${c.kind === 'url'}">A link</button></div>
    <div class="card" style="margin-top:10px"><input id="call-value" value="${esc(c.value)}" style="width:100%;font-size:16px" placeholder="${c.kind === 'tel' ? '+44…' : c.kind === 'url' ? 'https://…' : 'Shortcut name'}"></div>
    <p class="faint" style="font-size:12.5px;margin-top:10px">${c.kind === 'shortcut' ? 'Make a Shortcut with that name that starts a voice chat with ChatGPT (its “Start voice conversation” action), or calls the Dot’s number.' : c.kind === 'tel' ? 'The Dot’s phone number, if it has one.' : 'Any link that opens a call.'}</p>
    <button class="btn primary wide" style="margin-top:12px" id="call-save">Save</button>`);
};
$('#call-body').addEventListener('click', (e) => {
  const k = e.target.closest('#call-kind button'); if (k) { store.set('call', { kind: k.dataset.k, value: k.dataset.k === 'shortcut' ? 'Call Dot' : '' }); SHEET_OPEN['sh-call'](); return; }
  if (e.target.closest('#call-save')) { const c = store.get('call', { kind: 'shortcut' }); store.set('call', { kind: c.kind, value: $('#call-value').value.trim() }); sheet('sh-call', false); toast('The call button is set'); renderMore(); }
});
$('#call').onclick = () => {
  const c = store.get('call', null);
  if (!c || !c.value) { sheet('sh-call', true); return; }
  location.href = c.kind === 'tel' ? 'tel:' + c.value.replace(/[^\d+]/g, '') : c.kind === 'url' ? c.value : 'shortcuts://run-shortcut?name=' + encodeURIComponent(c.value);
};

/* ---------- widgets, as they'd look ---------- */
let widgetScript = '';
async function loadWidgetScript() {
  try { const r = await getText('/widgets/meridian-scriptable.js'); widgetScript = r.text.replace('__BASE__', S?.tailnet?.host ? 'https://' + S.tailnet.host : location.origin); const b = $('#copy-script'); if (b) b.disabled = false; } catch { /* the button stays off */ }
}
SHEET_OPEN['sh-widgets'] = () => {
  loadWidgetScript();
  const n = headline(); const todos = openTodos().slice(0, 3);
  const live = (S?.ai?.sessions || []).filter((s) => s.live); const runs = (S?.delegations?.runs || []).filter((r) => r.status === 'running');
  const working = live.length + runs.length; const first = runs[0]?.title || (live[0] && (live[0].did || live[0].prompt)) || 'Mobile layout';
  const d = new Date(); const inMin = n ? Math.round((n.ts - Date.now()) / 60000) : 0;
  setHTML($('#widgets-body'), `<div class="card" style="box-shadow:inset 0 0 0 1px #6cc39a40"><div class="t" style="font-size:15.5px;font-weight:500">Real ones today, with Scriptable</div>
      <p class="faint" style="font-size:13.5px;margin-top:4px">A free app that draws widgets from a web address. It reads the same feed the iPhone app will.</p>
      <ol class="steps"><li>Get <b>Scriptable</b> from the App Store.</li><li>Tap <b>+</b>, paste the script, and name it <b>Meridian</b>. Already have it? Paste over the old one: widgets pick up the change on their next refresh.</li><li>Home Screen: hold, tap <b>+</b>, pick <b>Scriptable</b> and a size, then <b>Edit Widget</b> and choose <b>Meridian</b>. For a small one, the Parameter can be <b>tell</b> (a red Tell button) or <b>needs</b> (what needs you). Medium and large show your day.</li><li>Lock Screen: hold, <b>Customise</b>, add <b>Scriptable</b> and choose <b>Meridian</b>.</li></ol>
      <button class="btn primary wide" id="copy-script" disabled>Copy the script</button></div>
    <p style="color:var(--body);font-size:14.5px;margin-top:18px">The rest are mock-ups with your real data. They need the iPhone app, a small shell around this page that comes with the Apple Developer account.</p>
    <div class="group-h">Home Screen</div>
    <div class="wall"><div class="wgrid">
      <div class="wd"><div class="wl">${icon('cal')}Next</div><div class="big">${n ? (n.allDay ? 'All day' : hm(n.ts)) : '—'}</div><div class="tt">${esc(n ? n.title : 'Nothing booked')}</div><div class="ss">${n ? esc(inMin > 0 && inMin < 120 ? `in ${inMin} min` : dayWord(n.ts)) : ''}</div></div>
      <div class="wd tell"><div class="wl">${icon('mic')}Meridian</div><div class="big">Tell<br>Meridian</div></div>
      <div class="wd wide"><div class="wl">${icon('today')}Today · ${NEEDS.length} need${NEEDS.length === 1 ? 's' : ''} you</div><div class="mini">${todos.map((t) => `<div><i></i>${esc(t.title)}</div>`).join('') || '<div><i></i>Nothing on the list</div>'}${working ? `<div><i style="background:var(--good)"></i>${working} agent${working === 1 ? '' : 's'} working</div>` : ''}</div></div>
    </div></div>
    <div class="group-h">Lock Screen</div>
    <div class="lock"><div class="date">${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}</div><div class="clock">${hm(Date.now())}</div>
      <div class="lw"><div class="circ">${working}<br><span style="font-weight:400;font-size:10px">agents</span></div><div class="rect"><b>${esc(n ? (n.allDay ? 'All day' : hm(n.ts)) + ' ' + cap(n.title, 28) : 'A clear day')}</b>${NEEDS.length ? `${NEEDS.length} need${NEEDS.length === 1 ? 's' : ''} you` : 'Nothing needs you'}</div></div>
      <div class="la"><span class="av">${glyph}</span><div class="main"><b>${esc(cap(first, 40))}</b><span>${working ? 'Working · ' + ago(runs[0]?.started || live[0]?.started) : 'Live Activity while an agent runs'}</span><div class="prog"><i></i></div></div></div></div>
    <div class="group-h">Dynamic Island</div>
    <div class="island"><span class="l"><i></i>${working || 1} working</span><span style="color:var(--dim)">${esc(cap(first, 14))}</span></div>
    ${(() => { const x = NEEDS[0] || { title: 'Drinks with Sam needs a tick', sub: 'Friday 20:00 · invite Sam, or just block the time?', acts: [{ l: 'Just block it' }, { l: 'Invite Sam' }] }; return `<div class="island big"><div class="row1"><span class="av" style="width:30px;height:30px;border-radius:10px">${glyph}</span><b>${esc(cap(x.title, 60))}</b></div><p>${esc(x.sub)}</p><div class="ia">${x.acts.slice(0, 2).map((a) => `<span>${esc(a.l)}</span>`).join('')}</div></div>`; })()}
    <div class="group-h">Notifications</div>
    <div class="note"><span class="ni">${glyph}</span><div class="nm"><b>${esc(n ? cap(n.title, 40) : 'DEMO stats catch-up')} in 10 min</b>You haven’t accepted it yet.</div><span class="nt">now</span></div>
    <div class="note-acts"><span>Accept</span><span>Join</span></div>
    <p class="faint" style="font-size:12.5px;margin-top:16px">Next step: install Xcode (free, 3 GB, App Store) and the app can go on your phone by cable to try. Widgets and the Share sheet work on a free account for 7 days at a time; notifications from the Mac need the paid one.</p>`);
};

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const g = e.target.closest('[data-go]'); if (g) { sheet(openSheet, false); go(g.dataset.go); return; }
  const tl = e.target.closest('[data-tell]'); if (tl) { e.preventDefault(); openTell(tl.dataset.tell); return; }
  const sh = e.target.closest('[data-sheet]'); if (sh) { sheet(sh.dataset.sheet, true); return; }
  const cl = e.target.closest('.sheet [data-close]'); if (cl) { sheet(cl.closest('.sheet').id, false); return; }
  if (e.target.closest('#copy-script')) { try { await navigator.clipboard.writeText(widgetScript); toast('Copied. Paste it into a new Scriptable script'); } catch { toast('Couldn’t copy. Open /widgets/meridian-scriptable.js instead'); } return; }
  const cp = e.target.closest('[data-copy]'); if (cp) { try { await navigator.clipboard.writeText($(cp.dataset.copy).textContent); toast('Copied'); } catch { toast('Couldn’t copy. Press and hold the text instead'); } return; }
  const rv = e.target.closest('[data-review]'); if (rv) { reviewTell(rv.dataset.review); return; }
  const say = e.target.closest('[data-say]'); if (say) { tbox.value = say.dataset.say; $('#thread-form').requestSubmit(); return; }
  const tr = e.target.closest('[data-trust]'); if (tr) { const on = tr.getAttribute('aria-checked') !== 'true'; tr.setAttribute('aria-checked', String(on)); setTrust(tr.dataset.trust, on); return; }

  // To-dos: tick with an Undo in the toast.
  const tk = e.target.closest('[data-todo] .tick');
  if (tk) {
    const row = tk.closest('[data-todo]'); const id = row.dataset.todo; if (FEEL) Feel.done(tk, row.querySelector('.t')); row.classList.add('done'); setTimeout(() => row.classList.add('leaving'), 30);
    hiddenTodos.add(id);
    try { await send('/api/todos/' + id, { done: true }, 'PATCH'); const t = (S.todos || []).find((x) => x.id === id); if (t) t.done = true; }
    catch (err) { hiddenTodos.delete(id); toast(err.message); renderToday(); return; }
    toast('Done', async () => { try { await send('/api/todos/' + id, { done: false }, 'PATCH'); const t = (S.todos || []).find((x) => x.id === id); if (t) t.done = false; hiddenTodos.delete(id); renderToday(); } catch (err) { toast(err.message); } });
    setTimeout(() => { hiddenTodos.delete(id); renderToday(); }, 1300);
    return;
  }
  const ib = e.target.closest('[data-inbox] .tick');
  if (ib) {
    const row = ib.closest('[data-inbox]'); const id = row.dataset.inbox; row.classList.add('done'); setTimeout(() => row.classList.add('leaving'), 30);
    hiddenTodos.add('project:' + id);
    try { await send('/api/brief-feedback', { id: 'project:' + id, action: 'complete' }); } catch (err) { hiddenTodos.delete('project:' + id); toast(err.message); renderToday(); return; }
    toast('Done. It’s off the brief too');
    return;
  }
  if (e.target.closest('#todos-more')) { todosOpen = !todosOpen; renderToday(); return; }

  // Needs you buttons.
  const na = e.target.closest('[data-need] [data-act]');
  if (na) {
    const n = NEEDS.find((x) => x.key === na.closest('[data-need]').dataset.need); const a = n && n.acts[Number(na.dataset.act)]; if (!a) return;
    if (a.a === 'url') { window.open(a.url, '_blank', 'noopener'); return; }
    if (a.a === 'review') { reviewTell(a.tell); return; }
    na.disabled = true;
    try {
      if (a.a === 'respond') {
        const word = { accept: 'Accept', tentative: 'Maybe for', decline: 'Decline' }[a.r];
        await sendDirect({ kind: 'calendar.respond', title: `${word} ${n.title}`, response: a.r, ...(a.invite ? { invite: a.invite } : { event: a.event }) });
        toast(a.r === 'accept' ? 'Accepting in Outlook…' : a.r === 'decline' ? 'Declining in Outlook…' : 'Saying maybe in Outlook…');
      } else if (a.a === 'keep') { await send(`/api/delegations/${a.run}/archive`, {}); toast('Kept. It’s in Journal'); load(); }
      else if (a.a === 'runundo') { await send(`/api/delegations/${a.run}/undo`, {}); toast('Undone. The change is gone'); load(); }
      else if (a.a === 'report') { showReport(a.run, a.title); na.disabled = false; }
    } catch (err) { toast(err.message); na.disabled = false; }
    return;
  }

  // Tell: routes, send, plan cards.
  const rt = e.target.closest('[data-route]'); if (rt) { route = rt.dataset.route; $$('#routes .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === rt))); $('#tell-text')?.focus({ preventScroll: true }); return; }
  if (e.target.closest('#tell-go')) { const v = $('#tell-text').value; if (!v.trim()) { $('#tell-text').focus(); return; } $('#tell-text').blur(); try { setTellFoot('plan', { status: 'planning', actions: [] }); const t = await sendTell(v); if (!t && openSheet === 'sh-tell' && route === 'note') sheet('sh-tell', false); } catch (err) { toast(err.message); setTellFoot('input'); } return; }
  if (e.target.closest('#tell-new')) { openTell(''); return; }
  if (e.target.closest('#tell-retry') && current) { const text = current.text; try { await sendTell(text.replace(/^Meridian fix \(change the Meridian app itself\): /, '')); } catch (err) { toast(err.message); } return; }
  if (e.target.closest('#tell-inbox') && current) { try { const r = await send('/api/capture', { text: current.text }); toast(r.label || 'Saved as a note'); sheet('sh-tell', false); } catch (err) { toast(err.message); } return; }
  if (e.target.closest('#tell-apply') && current) { e.target.closest('#tell-apply').disabled = true; try { await applyTell(current); } catch (err) { toast(err.message); } return; }
  if (e.target.closest('#tell-later') && current) { try { await applyTell(current, { later: true }); } catch (err) { toast(err.message); } return; }
  const act = e.target.closest('.act[data-tell-id]');
  if (act) {
    const t = findTell(act.dataset.tellId); const i = Number(act.dataset.i); const a = t && t.actions[i]; if (!a) return;
    if (e.target.closest('.undo') && a.state === 'done') { try { const { tell: x } = await send(`/api/tell/${t.id}/undo`, { i }); showTell(x); toast('Put back as it was'); } catch (err) { toast(err.message); } return; }
    if (a.state !== 'planned') return;
    const ch = e.target.closest('[data-choice]'); if (ch) { a.choice = Number(ch.dataset.choice); a.on = true; showTell(t); return; }
    if (e.target.closest('.sw')) { a.on = a.on === false; showTell(t); return; }
    const title = e.target.closest('[data-edit-title]');
    if (title && title.contentEditable !== 'true') { title.contentEditable = 'true'; title.focus(); const r = document.createRange(); r.selectNodeContents(title); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); title.addEventListener('blur', () => { a.title = title.textContent.trim() || a.title; title.contentEditable = 'false'; }, { once: true }); }
  }
});
async function sendDirect(action) {
  const { tell: t } = await send('/api/tell', { actions: [action], via: 'phone' });
  if (LAB) return;
  showTell(t); watch(t.id);
}
async function showReport(id, title) {
  setHTML($('#report-h'), esc(cap(title, 40))); setHTML($('#report-body'), '<p class="faint">Loading…</p>'); sheet('sh-report', true);
  try { const r = await getText('/delegations/' + encodeURIComponent(id) + '/REPORT.md'); const t = r.ok ? r.text : 'No summary yet.'; setHTML($('#report-body'), `<div class="soul" style="font-family:var(--f-body);font-size:14.5px">${esc(t)}</div>`); }
  catch { setHTML($('#report-body'), '<p class="faint">Couldn’t load the summary.</p>'); }
}
document.addEventListener('input', (e) => { if (e.target.id === 'tell-text') grow(e.target); });
$('#opento').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; store.set('opens', b.dataset.open); renderMore(); toast(`Meridian will open to ${b.textContent}`); };
$('#classic-sw').onclick = (e) => { const on = e.currentTarget.getAttribute('aria-checked') !== 'true'; try { if (on) localStorage.setItem('meridian.phone.layout', 'classic'); else localStorage.removeItem('meridian.phone.layout'); } catch { /* private */ } renderMore(); toast(on ? 'The classic layout opens from now on' : 'This layout opens from now on'); };
$('#tell-open').onclick = () => openTell();
$('#quickadd').addEventListener('submit', async (e) => {
  e.preventDefault(); const i = $('#qa'); const v = i.value.trim(); if (!v) return;
  i.value = '';
  try { const { todo } = await send('/api/todos', { title: v }); if (todo) { S.todos = [todo, ...(S.todos || [])]; renderToday(); } toast('Added', async () => { try { await send('/api/todos/' + todo.id, undefined, 'DELETE'); S.todos = S.todos.filter((t) => t.id !== todo.id); renderToday(); } catch (err) { toast(err.message); } }); }
  catch (err) { toast(err.message); i.value = v; }
});

/* ---------- start ---------- */
// Pull Today down past the top to refresh.
(() => { const s = $('#s-today'); let y0 = null; s.addEventListener('touchstart', (e) => { y0 = s.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true }); s.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 110) { toast('Refreshing'); load(); } y0 = null; }, { passive: true }); })();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastLoad > 20000) load(); });
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);

// Returns what to open on top: now (before the Mac answers) or later (needs data).
function startView() {
  const h = location.hash.slice(1);
  if (h.startsWith('tell=')) { go('agents', { quiet: true }); return { later: () => reviewTell(h.slice(5)) }; }
  const alias = { fleet: 'agents', dogfood: 'agents', today: 'today', home: 'today', thread: 'agents' };
  // The Tell icon opens straight on the box, without waiting for the Mac.
  if (h === 'tell' || location.pathname === '/tell') { go('today', { quiet: true }); return { now: () => openTell('', { focus: false, instant: true }) }; }
  if (VIEWS.includes(h) || alias[h]) { go(alias[h] || h, { quiet: true }); return { later: h === 'thread' ? openThread : null }; }
  const o = store.get('opens', 'today');
  if (o === 'tell') { go('today', { quiet: true }); return { now: () => openTell('', { focus: false, instant: true }) }; }
  go(o === 'last' ? store.get('last', 'today') : o, { quiet: true });
  return {};
}
const start = startView();
showOffline(offline);
render();
start.now?.();
noteUsage('phone');
load().then(() => { start.later?.(); });
window.addEventListener('offline', () => { showOffline(true); render(); });
window.addEventListener('online', () => load());
