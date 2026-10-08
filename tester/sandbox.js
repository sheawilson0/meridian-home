'use strict';

// A tester's own Meridian (7 Oct 2026), for usability tests with people who
// aren't on the tailnet. It starts from demo mode's made-up world (demo.js)
// and keeps the tester's changes on top, so the page behaves: a to-do they
// add stays, one they tick stays ticked, and one they hand to an agent runs
// for about a minute and leaves a report. Nothing here reads Meridian's own
// data, config or logs.
//
// Two starting worlds:
//   sam    Sam's day from demo mode, minus the uni bits (testers are working
//          people), plus a ChatGPT agent so there are three kinds of agent
//   blank  only what the tester brings: typed in, pasted (Tell), or sent by
//          their own agent over MCP
//
// One JSON file per tester in `dir`. `onChange(invite)` fires after every
// change so the server can push the new state down that tester's stream.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const demo = require('../demo');

const W = demo.world;
const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;
const RUN_MS = [40000, 75000];          // how long a pretend agent takes
const LIMITS = { todos: 300, deadlines: 100, links: 300, journal: 300, stash: 300, projects: 200, events: 300, agents: 60, runs: 80 };
const YOURS = '#ee8a62';               // the colour of calendar events the tester brought

const clean = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const iso = (ms) => new Date(ms).toISOString();
const newId = () => crypto.randomUUID();
// Only the fields a page may change, each its proper type; anything else is dropped.
const KIND = { title: 'str', note: 'str', priority: 'str', status: 'str', url: 'str', category: 'str', area: 'str', track: 'str', body: 'str', date: 'day', due: 'day',
  done: 'bool', pinned: 'bool', check: 'bool', preview: 'bool', minutes: 'num', pinOrder: 'num', spaces: 'strs', tags: 'strs' };
const realDay = (v) => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(v + 'T12:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };
function pick(o, keys) {
  const out = {};
  for (const k of keys) {
    const v = o[k]; if (v === undefined) continue;
    const kind = KIND[k] || 'str';
    if (kind === 'str' && typeof v === 'string') out[k] = clean(v, 4000);
    else if (kind === 'day' && realDay(v)) out[k] = v;
    else if (kind === 'bool' && typeof v === 'boolean') out[k] = v;
    else if (kind === 'num' && (v === null || (Number.isFinite(v) && Math.abs(v) < 1e6))) out[k] = v;
    else if (kind === 'strs' && Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 20).map((x) => clean(x, 60));
  }
  return out;
}
const fail = (msg, code = 400) => Object.assign(new Error(msg), { statusCode: code });

// ---------------------------------------------------------------- the starting world

// Testers are working people: the student's modules, classes and reading go.
function isUni(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.area === 'Uni' || x.track === 'uni' || x.category === 'Uni' || x.calendar === 'Classes' || x.kind === 'class') return true;
  if ((x.spaces || []).includes('uni')) return true;
  if (/^des5/i.test(x.project || x.name || '')) return true;
  return /\bDES50\d\b/.test(String(x.title || '') + ' ' + String(x.prompt || '') + ' ' + String(x.name || ''));
}
const noUni = (list) => (list || []).filter((x) => !isUni(x));
const NOW_MD = W.NOW_MD.replace(/\n## Uni\n[^#]*/, '\n');

// Three kinds of agent, the way people work now: a ChatGPT agent doing an errand
// alongside Claude Code and Codex, and asking for a decision like a colleague would.
function samExtras(now) {
  const offsite = W.uuid('proj:offsite-venue');
  return {
    session: { tool: 'chatgpt', project: 'studio-offsite', started: now - 9 * MIN, last: now - 25 * 1000, live: true, summary: null,
      prompt: 'Find three venues in town for 12 people on the 23rd, under £600, with a projector', did: 'Comparing three venues for the studio offsite' },
    project: { id: offsite, title: 'Pick a venue for the studio offsite', note: '', status: 'inbox', priority: 'normal', brief: true, delegate: true,
      source: 'chatgpt', sourceId: 'demo-offsite', sourceUrl: 'https://chat.example.com/c/offsite-venues', sourceFrom: 'ChatGPT agent', sourceReceivedAt: iso(now - 20 * MIN), created: iso(now - 20 * MIN), updated: iso(now - 20 * MIN) },
    item: { id: 'demo-offsite', source: 'chatgpt', title: 'Pick a venue for the studio offsite', from: 'ChatGPT agent', avatarUrl: null, receivedAt: iso(now - 20 * MIN), url: 'https://chat.example.com/c/offsite-venues',
      summary: 'Found three venues for 12 people on the 23rd: The Print Room (£480), Harbour Loft (£560) and the Old Library (£590). It needs you to pick one before it books.', priority: 'normal', confidence: 'high', actionable: true, status: 'queued', projectId: offsite },
  };
}

// The order Home's To do card shows (todo-rank.js does this with a model on the real thing).
const SAM_RANK = [
  ['Approve the Northwind menu proofs', 'now', 'Maya needs a yes today so the printer can start tomorrow.'],
  ['Send Maya the three lock-up options', 'now', 'You see Maya at the brand review soon, and she asked for these first.'],
  ['Reply to Priya about the onboarding copy', 'today', 'Priya is holding the reminder step until you answer.'],
  ['Pick a venue for the studio offsite', 'today', 'The ChatGPT agent can’t book until you choose one.'],
  ['Send the Brightwater festival estimate', 'soon', 'Tom needs it before Monday’s kickoff.'],
  ['Review Leo’s onboarding PR', 'soon', 'Leo’s change is ready and waiting on your review.'],
  ['Book a print slot for Fieldnotes issue 3', 'soon', 'The smaller press has slots next week.'],
  ['Rewrite the portfolio about page', 'later', ''],
  ['Back up the photo library', 'later', ''],
];
const URGENCY = ['now', 'today', 'soon', 'later'];

// What the pretend agent hands back for Sam's own to-dos and asks.
const REPORTS = {
  'Send Maya the three lock-up options': 'I put the three lock-ups (stacked, horizontal and the mark on its own) on one page at cup, sign and app-icon sizes, and wrote Maya a short email to go with them.\n\n## What I did\n- Exported each lock-up at 40 mm, 600 mm and 1024 px\n- Laid them out side by side on `lockups.pdf`\n- Drafted the email: "Hi Maya, here are the three lock-ups at real sizes. The stacked one reads best on the cup sleeve."\n\n## Needs you\n- Read the email and send it, or tell me what to change\n- Say whether the one-colour versions should go in too',
  'Review Leo’s onboarding PR': 'I read Leo’s pull request (#121, swap the chart library) and ran it.\n\n## What I found\n- The bundle is 38 KB smaller and the tooltips are clearer\n- One colour is wrong: the week chart uses the old blue instead of `--sky-500`\n- Tests pass, and nothing else changes for users\n\n## Needs you\n- Approve it once the colour is fixed. I left Leo a comment with the line to change',
  'Book a print slot for Fieldnotes issue 3': 'I compared the two quotes and checked the smaller press’s calendar.\n\n## What I found\n- Smaller press: next Thursday, £212 for 150 copies, two colours\n- Big press: the week after, £188, but riso only in one colour\n\n## Needs you\n- Pick one. I drafted a booking email to the smaller press, ready to send',
  'Rewrite the portfolio about page': 'I rewrote the about page in a plainer voice and cut it from 420 to 180 words.\n\n## What I did\n- Led with what you make and who for\n- Moved the client list under the words\n- Kept your line about repair and care, word for word\n\n## Needs you\n- Read it on the preview and say yes, or mark what to change',
  'Back up the photo library': 'I checked the backup drive and started a copy.\n\n## What I found\n- 312 GB to copy, 1.1 TB free on the drive\n- September isn’t backed up yet\n\n## Needs you\n- Nothing. It will finish in about an hour. I’ll say if anything fails',
  'Approve the Northwind menu proofs': 'I went through Maya’s menu proofs against the brand rules.\n\n## What I found\n- Prices line up and the type is on the new scale\n- Page 2: "flat white" is in the old typeface\n- The terracotta on the cover is 8% lighter than the cups\n\n## Needs you\n- Approve it with those two fixes. I drafted the reply to Maya',
  'Reply to Priya about the onboarding copy': 'I drafted a reply to Priya in the Tidepool channel.\n\n## Draft\n"Yes to Remind me later. It says what happens, and Skip sounds like you lose something. Can we keep it under 20 characters on small phones?"\n\n## Needs you\n- Send it as it is, or change it',
  'Send the Brightwater festival estimate': 'I put together a rough estimate for the Brightwater festival site from last year’s Northwind numbers.\n\n## Estimate\n- Design: 6 days\n- Build: 8 days\n- Content and launch: 3 days\n- About £9,400 in total\n\n## Needs you\n- Check the day rate and send it to Tom. The email is drafted',
  'Pick a venue for the studio offsite': 'I checked all three venues against the brief: 12 people, the 23rd, a projector, under £600.\n\n## Recommendation\n- **The Print Room**, £480: projector, step-free, ten minutes from the studio\n- Harbour Loft is nicer but has no step-free access\n\n## Needs you\n- Say yes and I’ll book The Print Room',
};

function genericReport(title, model) {
  return `I picked up "${title}" and worked through it.\n\n## What I did\n- Read what you wrote and anything linked to it\n- Did the parts I could do without you\n- Wrote up what’s left below\n\n## Needs you\n- Check what I did and say if it’s right\n- Anything that needs your name on it (sending, paying, signing) is left for you\n\n_${model} · this is a test copy of Meridian, so this report is a stand-in for the real work._`;
}

// ---------------------------------------------------------------- overlays

const ov = () => ({ add: [], patch: {}, del: [] });
function fresh(invite, opts = {}) {
  return {
    v: 1, invite, name: clean(opts.name || '', 40), world: opts.world === 'blank' ? 'blank' : 'sam', created: Date.now(), updated: Date.now(),
    todos: ov(), deadlines: ov(), links: { ...ov(), categories: null, pinOrder: null }, journal: ov(), stash: ov(), projects: ov(),
    intake: [], feedback: { completed: [], rejected: [] }, events: [], agents: [], runs: [], reports: {}, rank: {}, prefs: null, notify: true, seenAt: 0,
  };
}
function merge(base, o) {
  const del = new Set(o.del);
  const out = [];
  for (const x of [...base, ...o.add]) if (x && !del.has(x.id)) out.push(o.patch[x.id] ? { ...x, ...o.patch[x.id] } : x);
  return out;
}
const has = (base, o, id) => merge(base, o).some((x) => x.id === id);
function capped(list, key) { if (list.length >= LIMITS[key]) throw fail('this test copy is full; ask Owner to reset it', 409); }

// ---------------------------------------------------------------- the module

function createSandboxes(deps = {}) {
  const {
    dir, now: clock = () => Date.now(), onChange = () => {}, onRunDone = () => {},
    writeReport = null,     // async ({ title, note, model, from }) => markdown; null keeps the stand-in reports
    models = () => [],      // [{ id, name }] for labels
  } = deps;
  fs.mkdirSync(dir, { recursive: true });
  const cache = new Map();
  const timers = new Map();
  const saving = new Map();

  const fileOf = (invite) => path.join(dir, invite + '.json');
  function load(invite) {
    if (!/^[a-z0-9]{4,40}$/.test(invite)) throw fail('bad invite');
    if (cache.has(invite)) return cache.get(invite);
    let sb = null;
    try { sb = JSON.parse(fs.readFileSync(fileOf(invite), 'utf8')); } catch { /* new */ }
    if (!sb || sb.v !== 1) sb = fresh(invite);
    cache.set(invite, sb);
    for (const r of sb.runs) if (!r.cancelled && !r.notified) schedule(invite, r);
    return sb;
  }
  function exists(invite) { return cache.has(invite) || fs.existsSync(fileOf(invite)); }
  function save(invite) {
    const sb = cache.get(invite); if (!sb) return;
    sb.updated = Date.now();
    clearTimeout(saving.get(invite));
    saving.set(invite, setTimeout(async () => {
      saving.delete(invite);
      const tmp = `${fileOf(invite)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      try { await fsp.writeFile(tmp, JSON.stringify(sb)); await fsp.rename(tmp, fileOf(invite)); } catch (e) { console.error('sandbox save failed', invite, e.message); }
    }, 300));
  }
  function changed(invite) { save(invite); try { onChange(invite); } catch { /* the server's problem */ } }

  function reset(invite, opts = {}) {
    const old = cache.get(invite);
    for (const r of (old && old.runs) || []) clearTimeout(timers.get(r.id));
    const sb = fresh(invite, { name: opts.name ?? old?.name, world: opts.world ?? old?.world });
    if (old && opts.keepPrefs) sb.prefs = old.prefs;
    cache.set(invite, sb); changed(invite); return sb;
  }
  async function remove(invite) {
    const sb = cache.get(invite);
    for (const r of (sb && sb.runs) || []) clearTimeout(timers.get(r.id));
    cache.delete(invite); clearTimeout(saving.get(invite));
    await fsp.rm(fileOf(invite), { force: true });
  }
  function configure(invite, { name, world } = {}) {
    const sb = load(invite);
    if (name !== undefined) sb.name = clean(name, 40);
    if (world !== undefined) sb.world = world === 'blank' ? 'blank' : 'sam';
    changed(invite); return sb;
  }

  // ---- the base world, as this tester sees it
  function base(sb, now) {
    if (sb.world === 'blank') return { todos: [], deadlines: [], links: { categories: ['Work', 'Tools', 'Personal'], links: [] }, journal: [], stash: [], projects: [], intake: [], events: [], sessions: [] };
    const x = samExtras(now);
    const { projects, briefIntake } = W.intake(now);
    const lk = W.links(now);
    return {
      todos: noUni(W.todos(now)),
      deadlines: noUni(W.deadlines(now)),
      links: { categories: lk.categories.filter((c) => c !== 'Uni'), links: noUni(lk.links) },
      journal: noUni(W.journal(now).entries),
      stash: noUni(W.stashItems(now)),
      projects: [...projects.projects, x.project],
      intake: [...briefIntake.items, x.item],
      events: noUni(W.calendarEvents(now)),
      sessions: [...noUni(W.sessions(now)), x.session],
    };
  }

  const view = {
    todos: (sb, now, b = base(sb, now)) => merge(b.todos, sb.todos),
    deadlines: (sb, now, b = base(sb, now)) => merge(b.deadlines, sb.deadlines),
    links: (sb, now, b = base(sb, now)) => {
      const list = merge(b.links.links, sb.links);
      if (sb.links.pinOrder) { const at = new Map(sb.links.pinOrder.map((id, i) => [id, i])); for (const l of list) if (at.has(l.id)) l.pinOrder = at.get(l.id); }
      const cats = sb.links.categories || [...new Set([...b.links.categories, ...list.map((l) => l.category).filter(Boolean)])];
      return { categories: cats, links: list };
    },
    journal: (sb, now, b = base(sb, now)) => merge(b.journal, sb.journal),
    stash: (sb, now, b = base(sb, now)) => merge(b.stash, sb.stash).sort((p, q) => q.created - p.created),
    projects: (sb, now, b = base(sb, now)) => merge(b.projects, sb.projects),
  };

  function runStatus(r, now) {
    if (r.cancelled) return 'cancelled';
    if (r.archived) return 'archived';
    return now >= r.doneAt && r.reportReady ? 'done' : 'running';
  }
  function runView(r, now) {
    const status = runStatus(r, now);
    return { id: r.id, title: r.title, card: null, projectId: r.projectId || null, kind: 'delegation', todoId: r.todoId || null, source: r.source || 'todo', requestFile: null,
      model: r.model, started: r.started, finished: status === 'done' ? r.doneAt : null, effort: r.effort || null, status, error: null,
      files: status === 'done' ? ['REPORT.md'] : [], changes: null, undoable: false, undoneAt: null };
  }

  // Everything /api/state carries, with the tester's changes on top.
  function state(invite, now = clock()) {
    const sb = load(invite);
    const s = demo.buildState(now, { engines: () => ({ labels: models().map((m) => m.name), default: (models()[0] || {}).name }) });
    const b = base(sb, now);
    const todos = view.todos(sb, now, b);
    const runs = sb.runs.map((r) => runView(r, now));
    for (const t of todos) {
      const r = runs.filter((x) => x.todoId === t.id && x.status !== 'cancelled').sort((p, q) => q.started - p.started)[0];
      if (r) t.delegation = { id: r.id, model: r.model, status: r.status, started: r.started };
    }
    s.todos = todos;
    s.deadlines = view.deadlines(sb, now, b);
    s.links = view.links(sb, now, b);
    const projects = view.projects(sb, now, b);
    s.projects = { version: 1, projects };
    const items = [...b.intake, ...sb.intake];
    s.briefIntake = { updatedAt: iso(now - 12 * MIN), window: { from: iso(now - DAY), to: iso(now), sources: ['Outlook', 'Slack'] }, items, pending: items.length };
    s.briefFeedback = { completed: sb.feedback.completed.slice(), rejected: sb.feedback.rejected.slice(), skipped: {} };
    const evs = [...b.events, ...sb.events.map((e) => eventView(e))].filter((e) => e.end >= now - 6 * HOUR && e.ts <= now + 8 * DAY).sort((p, q) => p.ts - q.ts);
    s.calendar.events = evs;
    if (sb.world === 'blank') s.calendar.calendars = [];
    else s.calendar.calendars = s.calendar.calendars.filter((c) => c.id !== 'classes');
    const cals = new Set(s.calendar.calendars.map((c) => c.label));
    for (const e of sb.events) if (!cals.has(e.calendar)) { cals.add(e.calendar); s.calendar.calendars.push({ id: 'yours-' + e.calendar.toLowerCase().replace(/\W+/g, '-'), label: e.calendar, color: e.color || YOURS, hidden: false, ok: true }); }
    s.invites = sb.world === 'blank' ? [] : (s.invites || []);
    const agents = sb.agents.map((a) => ({ id: a.id, tool: a.tool, project: a.project, started: a.started, last: a.last, live: a.status !== 'done' && now - a.last < 20 * MIN, prompt: a.prompt, did: a.did, summary: null, cwd: null }));
    const sessions = [...b.sessions, ...agents];
    s.ai = { sessions, liveCount: sessions.filter((x) => x.live).length, todayCount: sessions.filter((x) => W.isoDay(x.started) === W.isoDay(now)).length };
    // Only the tester's own runs: demo.js's Dogfood runs are about changing Meridian itself, which testers can't do.
    s.delegations = { runs: runs.filter((r) => r.status !== 'archived') };
    s.todoRank = rank(sb, todos, projects, now);
    if (sb.world === 'blank') {
      Object.assign(s, { board: { cards: [] }, git: { repos: [] }, github: null, journalToday: { date: W.isoDay(now), items: [], delegations: [] }, pulse: { events: [] }, notifyHistory: [], local: { servers: [] } });
      s.fleet = { sites: [], services: [], agents: [], paused: 0, down: 0 };
      s.ledger = { ...s.ledger, now: '', latest: null, entries: [] };
    } else {
      s.ledger = { ...s.ledger, now: NOW_MD, latest: s.ledger.latest ? { ...s.ledger.latest, excerpt: s.ledger.latest.excerpt.replace(/\n## Uni\n[^#]*/, '\n') } : null };
      s.journalToday = { ...s.journalToday, items: noUni(s.journalToday.items) };
      s.pulse = { events: (s.pulse.events || []).filter((e) => !/des50/i.test(e.label)) };
    }
    s.notify = { ...s.notify, topic: '', enabled: sb.notify !== false };
    if (s.brain) s.brain = { ...s.brain, realms: s.brain.realms.filter((r) => r.name !== 'Uni') };
    s.machine = 'Studio Mac';
    s.location = null;
    s.tester = { name: sb.name || '', world: sb.world };
    return s;
  }

  function eventView(e) {
    return { ts: e.ts, end: e.end, title: e.title, allDay: Boolean(e.allDay), cal: e.calendar, calendar: e.calendar, color: e.color || YOURS, uid: e.id, joinUrl: e.joinUrl || null,
      response: null, organizer: e.organizer || null, busyStatus: 'busy', location: e.location || null, id: `${e.id}|${iso(e.ts)}`, recurring: false };
  }

  // Home's order: Sam's ranking, with the tester's own things slotted in by how urgent they said (or "today").
  function rank(sb, todos, projects, now) {
    const fb = new Set([...sb.feedback.completed, ...sb.feedback.rejected]);
    const open = [
      ...todos.filter((t) => !t.done).map((t) => ({ id: t.id, kind: 'todo', title: t.title, created: Date.parse(t.created) || 0 })),
      ...projects.filter((p) => p.brief && p.status !== 'done' && !fb.has('project:' + p.id)).map((p) => ({ id: p.id, kind: 'brief', title: p.title, created: Date.parse(p.sourceReceivedAt || p.created) || 0 })),
    ];
    const samAt = new Map(SAM_RANK.map(([title, u, reason], i) => [title, { i, u, reason }]));
    const scored = open.map((x) => {
      const own = sb.rank[x.id];
      if (own) return { ...x, u: own.urgency, reason: own.reason || '', w: URGENCY.indexOf(own.urgency) * 100 - (x.created - now) / 1e9 };
      const s = sb.world === 'sam' ? samAt.get(x.title) : null;
      if (s) return { ...x, u: s.u, reason: s.reason, w: URGENCY.indexOf(s.u) * 100 + s.i };
      return { ...x, u: 'today', reason: '', w: 100 + 50 };
    });
    scored.sort((p, q) => p.w - q.w);
    return { at: now - 4 * MIN, running: false, error: null, items: scored.map((x) => ({ id: x.id, kind: x.kind, urgency: x.u, reason: x.reason })) };
  }

  // ---- pretend agents
  const label = (id, effort) => {
    const m = models().find((x) => x.id === id);
    const e = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max' }[effort] || '';
    return (m ? m.name : clean(id || 'Agent', 40)) + (e ? ' · ' + e : '');
  };
  function startRun(invite, { title, note = '', todoId = null, projectId = null, source = 'todo', from = '', model, effort }) {
    const sb = load(invite);
    if (sb.runs.length >= LIMITS.runs) throw fail('too many agents in this test copy', 409);   // cancelled ones count too
    const busy = sb.runs.find((r) => !r.cancelled && !r.archived && (todoId ? r.todoId === todoId : r.projectId === projectId) && runStatus(r, clock()) === 'running');
    if (busy) throw fail('an agent is already on this one', 409);
    const t = clock();
    const r = { id: 'run-' + crypto.randomBytes(5).toString('hex'), title: clean(title, 200), todoId, projectId, source, model: label(model, effort), effort: effort || null,
      started: t, doneAt: t + RUN_MS[0] + Math.round(Math.random() * (RUN_MS[1] - RUN_MS[0])), reportReady: false, cancelled: false, archived: false, notified: false };
    sb.runs.push(r);
    const canned = sb.world === 'sam' && REPORTS[r.title];
    // A model sometimes repeats the to-do as its own heading; the page already has one.
    const done = (md) => { sb.reports[r.id] = `# ${r.title}\n\n${String(md).replace(/^\s*#\s[^\n]*\n+/, '')}\n`; r.reportReady = true; save(invite); };
    if (canned) done(canned);
    else if (writeReport) {
      Promise.race([writeReport({ invite, title: r.title, note, model: r.model, from }), new Promise((res) => setTimeout(() => res(null), 90000))])
        .then((md) => done(md || genericReport(r.title, r.model)), () => done(genericReport(r.title, r.model)));
    } else done(genericReport(r.title, r.model));
    schedule(invite, r);
    changed(invite);
    return r;
  }
  function schedule(invite, r) {
    clearTimeout(timers.get(r.id));
    const wait = Math.max(0, r.doneAt - clock());
    const tick = () => {
      const sb = cache.get(invite); if (!sb || r.cancelled) return;
      if (!r.reportReady) { timers.set(r.id, setTimeout(tick, 2000)); return; }
      r.notified = true; changed(invite);
      try { onRunDone(invite, runView(r, clock())); } catch { /* the server's problem */ }
    };
    const h = setTimeout(tick, wait + 50); h.unref?.(); timers.set(r.id, h);
  }

  // ---- reads
  function report(invite, runId) {
    const sb = load(invite);
    const r = sb.runs.find((x) => x.id === runId);
    if (!r) return null;
    return { run: runView(r, clock()), markdown: runStatus(r, clock()) === 'done' ? sb.reports[r.id] || '' : null };
  }
  function stashList(invite, q, now = clock()) {
    const sb = load(invite);
    const all = view.stash(sb, now);
    const words = String(q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const kind = String(q.get('kind') || '');
    const space = String(q.get('space') || '').toLowerCase().replace(/^#/, '');
    let found = all.filter((it) => {
      if (kind === 'screenshot' ? it.source !== 'screenshot' : kind && it.kind !== kind) return false;
      if (space && !(it.spaces || []).includes(space)) return false;
      const hay = [it.title, it.text, it.note, it.domain, it.kind, ...(it.spaces || []), ...((it.palette || []).map((p) => p.name)), ...((it.labels || []).map((l) => l.id))].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w.replace(/^#/, '')));
    });
    if (q.get('order') === 'shuffle') found = found.map((it) => [Math.random(), it]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const counts = { all: all.length };
    for (const it of all) { counts[it.kind] = (counts[it.kind] || 0) + 1; if (it.source === 'screenshot') counts.screenshot = (counts.screenshot || 0) + 1; }
    const spaceCounts = new Map();
    for (const it of all) for (const s of it.spaces || []) spaceCounts.set(s, (spaceCounts.get(s) || 0) + 1);
    const seenAt = sb.seenAt || now - 3 * HOUR;
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 300)); const offset = Math.max(0, Number(q.get('offset')) || 0);
    return { ok: true, total: found.length, chips: [], counts, spaces: [...spaceCounts].map(([name, n]) => ({ name, n })), seenAt, fresh: all.filter((it) => it.created > seenAt).length, items: found.slice(offset, offset + limit) };
  }
  function stashItem(invite, id) { const sb = load(invite); return view.stash(sb, clock()).find((x) => x.id === id) || null; }

  // ---- writes from the page. `real` is the /api path; returns the JSON to send, or null for "not mine".
  function write(invite, method, real, body) {
    const sb = load(invite); const now = clock(); const b = base(sb, now);
    const out = (x = {}) => ({ ok: true, ...x });
    let m;
    // To-dos
    if (real === '/api/todos' && method === 'POST') {
      capped(sb.todos.add, 'todos');
      const title = clean(body.title, 300); if (!title) throw fail('say what the to-do is');
      const t = { id: newId(), title, note: clean(body.note, 2000), priority: ['now', 'next', 'later'].includes(body.priority) ? body.priority : 'next', done: false, doneAt: null, area: '', delegation: null, order: 0, created: iso(now), updated: iso(now), by: body.by || 'you' };
      sb.todos.add.push(t); if (body.urgency && URGENCY.includes(body.urgency)) sb.rank[t.id] = { urgency: body.urgency, reason: clean(body.reason, 140) };
      changed(invite); return { status: 201, json: out({ todo: t }) };
    }
    if ((m = real.match(/^\/api\/todos\/([\w-]+)\/delegate$/)) && method === 'POST') {
      const t = view.todos(sb, now, b).find((x) => x.id === m[1]); if (!t) throw fail('no such to-do', 404);
      const r = startRun(invite, { title: t.title, note: t.note, todoId: t.id, source: 'todo', model: body.model, effort: body.effort });
      return { json: out({ id: r.id, todo: { id: t.id, delegation: { id: r.id, model: r.model, status: 'running', started: r.started } } }) };
    }
    if ((m = real.match(/^\/api\/todos\/([\w-]+)$/))) {
      if (!has(b.todos, sb.todos, m[1])) throw fail('no such to-do', 404);
      if (method === 'DELETE') { sb.todos.del.push(m[1]); changed(invite); return { json: out() }; }
      if (method === 'PATCH') {
        const p = pick(body, ['title', 'priority', 'done', 'note']);
        if (p.title !== undefined && !clean(p.title)) delete p.title;
        if (p.done !== undefined) { p.done = Boolean(p.done); p.doneAt = p.done ? iso(now) : null; }
        sb.todos.patch[m[1]] = { ...(sb.todos.patch[m[1]] || {}), ...p, updated: iso(now) };
        changed(invite); return { json: out({ todo: view.todos(sb, now).find((x) => x.id === m[1]) }) };
      }
    }
    if (real === '/api/todos/clear-done') { const done = view.todos(sb, now, b).filter((t) => t.done).map((t) => t.id); sb.todos.del.push(...done); changed(invite); return { json: out({ removed: done.length }) }; }
    if (real === '/api/todos/reorder') return { json: out({ todos: view.todos(sb, now, b) }) };
    // The inbox (asks from email, Slack and agents)
    if (real === '/api/brief-feedback' && method === 'POST') {
      const id = String(body.id || ''); if (!/^project:[\w-]+$/.test(id) || !has(b.projects, sb.projects, id.slice(8))) throw fail('no such item', 404);
      const list = body.action === 'reject' ? sb.feedback.rejected : body.action === 'complete' ? sb.feedback.completed : null;
      if (!list) { if (body.action === 'undo') { sb.feedback.completed = sb.feedback.completed.filter((x) => x !== id); sb.feedback.rejected = sb.feedback.rejected.filter((x) => x !== id); changed(invite); } return { json: out() }; }
      if (!list.includes(id)) list.push(id);
      changed(invite); return { json: out() };
    }
    if ((m = real.match(/^\/api\/projects\/([\w-]+)$/)) && method === 'PATCH') {
      if (!has(b.projects, sb.projects, m[1])) throw fail('no such item', 404);
      const p = pick(body, ['title', 'note', 'priority', 'status']); if (p.title !== undefined && !clean(p.title)) delete p.title;
      sb.projects.patch[m[1]] = { ...(sb.projects.patch[m[1]] || {}), ...p, updated: iso(now) };
      changed(invite); return { json: out({ project: view.projects(sb, now).find((x) => x.id === m[1]) }) };
    }
    if (real === '/api/delegate' && method === 'POST') {
      if (!body.projectId) return { json: out({ id: 'run-none' }) };   // the Connect page's "set this up for me": not in a test copy
      const p = view.projects(sb, now, b).find((x) => x.id === body.projectId); if (!p) throw fail('no such item', 404);
      const item = [...b.intake, ...sb.intake].find((i) => i.projectId === p.id);
      const r = startRun(invite, { title: clean(body.title || p.title, 200), note: item?.summary || p.note || '', projectId: p.id, source: p.source, from: p.sourceFrom || '', model: body.model, effort: body.effort });
      return { json: out({ id: r.id }) };
    }
    if ((m = real.match(/^\/api\/delegations\/([\w-]+)\/(cancel|archive|undo)$/)) && method === 'POST') {
      const r = sb.runs.find((x) => x.id === m[1]); if (!r) return { json: out() };   // demo.js's own Dogfood runs
      if (m[2] === 'cancel') { r.cancelled = true; clearTimeout(timers.get(r.id)); }
      if (m[2] === 'archive') r.archived = true;
      changed(invite); return { json: out() };
    }
    // Deadlines
    if (real === '/api/deadlines' && method === 'POST') {
      capped(sb.deadlines.add, 'deadlines');
      const title = clean(body.title, 200); const due = realDay(body.due) ? body.due : null;
      if (!title || !due) throw fail('a deadline needs a title and a date');
      const d = { id: newId(), title, due, track: ['work', 'uni', 'personal'].includes(body.track) ? body.track : 'work', area: '', note: clean(body.note, 1000), done: false, created: iso(now), updated: iso(now) };
      sb.deadlines.add.push(d); changed(invite); return { status: 201, json: out({ item: d }) };
    }
    if ((m = real.match(/^\/api\/deadlines\/([\w-]+)$/))) {
      if (!has(b.deadlines, sb.deadlines, m[1])) throw fail('no such deadline', 404);
      if (method === 'DELETE') { sb.deadlines.del.push(m[1]); changed(invite); return { json: out() }; }
      if (method === 'PATCH') { sb.deadlines.patch[m[1]] = { ...(sb.deadlines.patch[m[1]] || {}), ...pick(body, ['title', 'due', 'track', 'note', 'done']), updated: iso(now) }; changed(invite); return { json: out({ item: view.deadlines(sb, now).find((x) => x.id === m[1]) }) }; }
    }
    // Links
    if (real === '/api/links' && method === 'POST') {
      capped(sb.links.add, 'links');
      let url = clean(body.url, 2000); if (!/^https?:\/\//i.test(url)) throw fail('a link needs a web address');
      const l = { id: newId(), title: clean(body.title, 200) || url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url, category: clean(body.category, 60) || 'Tools', tags: [], note: clean(body.note, 1000), kind: 'tool',
        pinned: Boolean(body.pinned), pinOrder: Number(body.pinOrder) || 0, check: false, preview: true, opens: 0, lastOpened: null, created: iso(now), updated: iso(now), health: null };
      sb.links.add.push(l); changed(invite); return { status: 201, json: out({ link: l }) };
    }
    if ((m = real.match(/^\/api\/links\/([\w-]+)\/open$/))) {
      if (!has(b.links.links, sb.links, m[1])) return { json: out() };
      const cur = view.links(sb, now, b).links.find((x) => x.id === m[1]);
      sb.links.patch[m[1]] = { ...(sb.links.patch[m[1]] || {}), opens: (cur.opens || 0) + 1, lastOpened: iso(now) }; changed(invite); return { json: out() };
    }
    if (real === '/api/links/categories') { if (Array.isArray(body.categories)) { sb.links.categories = body.categories.slice(0, 40).map((c) => clean(c, 60)).filter(Boolean); changed(invite); } return { json: out({ categories: sb.links.categories }) }; }
    if (real === '/api/links/pin-order') {
      if (Array.isArray(body.ids)) {
        const known = new Set(view.links(sb, now, b).links.map((l) => l.id));   // only links that exist
        sb.links.pinOrder = [...new Set(body.ids.map(String))].filter((id) => known.has(id)).slice(0, 200);
        for (const id of sb.links.pinOrder) sb.links.patch[id] = { ...(sb.links.patch[id] || {}), pinned: true };
        changed(invite);
      }
      return { json: out() };
    }
    if (real === '/api/links/rename-category' || real === '/api/links/remove-category') {
      const from = clean(real.endsWith('rename-category') ? body.from : body.name, 60); const to = clean(real.endsWith('rename-category') ? body.to : (body.moveTo || 'Other'), 60);
      for (const l of view.links(sb, now, b).links) if (l.category === from) sb.links.patch[l.id] = { ...(sb.links.patch[l.id] || {}), category: to };
      const cats = view.links(sb, now, b).categories.map((c) => (c === from ? to : c));
      sb.links.categories = [...new Set(cats)].filter((c) => real.endsWith('rename-category') || c !== from);
      changed(invite); return { json: out() };
    }
    if ((m = real.match(/^\/api\/links\/([\w-]+)$/))) {
      if (!has(b.links.links, sb.links, m[1])) throw fail('no such link', 404);
      if (method === 'DELETE') { sb.links.del.push(m[1]); changed(invite); return { json: out() }; }
      if (method === 'PATCH') { sb.links.patch[m[1]] = { ...(sb.links.patch[m[1]] || {}), ...pick(body, ['title', 'url', 'category', 'note', 'pinned', 'pinOrder', 'tags', 'check', 'preview']), updated: iso(now) }; changed(invite); return { json: out({ link: view.links(sb, now).links.find((x) => x.id === m[1]) }) }; }
    }
    // Journal
    if (real === '/api/journal' && method === 'POST') {
      capped(sb.journal.add, 'journal');
      const e = { id: newId(), date: realDay(body.date) ? body.date : W.isoDay(now), area: clean(body.area, 60), track: ['work', 'uni', 'personal'].includes(body.track) ? body.track : 'work',
        title: clean(body.title, 200) || 'Untitled', body: clean(body.body, 8000), tags: [], minutes: Number(body.minutes) || null, source: 'manual', sourceRef: null, created: iso(now), updated: iso(now) };
      sb.journal.add.push(e); changed(invite); return { status: 201, json: out({ entry: e }) };
    }
    if ((m = real.match(/^\/api\/journal\/([\w-]+)$/))) {
      if (!has(b.journal, sb.journal, m[1])) throw fail('no such entry', 404);
      if (method === 'DELETE') { sb.journal.del.push(m[1]); changed(invite); return { json: out() }; }
      if (method === 'PATCH') { sb.journal.patch[m[1]] = { ...(sb.journal.patch[m[1]] || {}), ...pick(body, ['date', 'area', 'track', 'title', 'body', 'minutes']), updated: iso(now) }; changed(invite); return { json: out({ entry: view.journal(sb, now).find((x) => x.id === m[1]) }) }; }
    }
    // Stash and quick capture
    if ((real === '/api/stash' && method === 'POST') || real === '/api/capture') {
      capped(sb.stash.add, 'stash');
      const text = clean(body.text, 4000); if (!text) throw fail('nothing to keep');
      const it = stashNote(text, body.source || (real === '/api/capture' ? 'note' : 'paste'), now);
      sb.stash.add.push(it); changed(invite);
      return { status: 201, json: real === '/api/capture' ? out({ id: it.id, file: null }) : out({ item: it }) };
    }
    if ((m = real.match(/^\/api\/capture\/([\w-]+)\/undo$/))) { if (sb.stash.add.some((x) => x.id === m[1]) && !sb.stash.del.includes(m[1])) { sb.stash.del.push(m[1]); changed(invite); } return { json: out() }; }
    if (real === '/api/stash/seen') { const at = Number(body.at); sb.seenAt = Number.isFinite(at) && Math.abs(at - now) < 30 * DAY ? at : now; changed(invite); return { json: out() }; }
    if ((m = real.match(/^\/api\/stash\/([a-z0-9]{6,40})(\/restore|\/refresh)?$/))) {
      if (m[2] === '/restore') { if (sb.stash.del.includes(m[1])) { sb.stash.del = sb.stash.del.filter((x) => x !== m[1]); changed(invite); } return { json: out({ item: stashItem(invite, m[1]) }) }; }
      if (m[2] === '/refresh') return { json: out() };
      if (!has(b.stash, sb.stash, m[1])) throw fail('not in the stash', 404);
      if (method === 'DELETE') { sb.stash.del.push(m[1]); changed(invite); return { json: out() }; }
      if (method === 'PATCH') { sb.stash.patch[m[1]] = { ...(sb.stash.patch[m[1]] || {}), ...pick(body, ['title', 'note', 'spaces', 'pinned']), updated: now }; changed(invite); return { json: out({ item: stashItem(invite, m[1]) }) }; }
    }
    // The page's look, and phone reminders
    if (real === '/api/command/prefs' && method === 'PUT') { sb.prefs = cleanPrefs(body); changed(invite); return { json: out() }; }
    if (real === '/api/notify' && method === 'PATCH') { sb.notify = Boolean(body.enabled); changed(invite); return { json: out() }; }
    return null;
  }

  function stashNote(text, source, now) {
    const isLink = /^https?:\/\/\S+$/.test(text);
    let domain = ''; try { if (isLink) domain = new URL(text).hostname; } catch { /* not a url */ }
    return { id: 'yrs' + crypto.randomBytes(4).toString('hex'), kind: isLink ? 'link' : 'note', title: isLink ? domain : '', note: '', text: isLink ? '' : text, url: isLink ? text : '', domain,
      source: clean(source, 20), from: 'Browser', page: null, spaces: [], pinned: false, created: now, updated: now, labels: [], hasText: false };
  }

  // ---- what the tester's own agents and Tell bring in (tester/mcp.js, tester/tell.js)
  const bring = {
    todo(invite, { title, note, urgency, reason, by = 'agent' }) {
      return write(invite, 'POST', '/api/todos', { title, note, urgency, reason, by, priority: urgency === 'now' ? 'now' : urgency === 'later' ? 'later' : 'next' }).json.todo;
    },
    ask(invite, { title, from, source = 'other', summary = '', url = '', urgency, reason, receivedAt }) {
      const sb = load(invite); const now = clock();
      capped(sb.projects.add, 'projects');
      const t = clean(title, 200); if (!t) throw fail('an ask needs a title');
      const src = ['outlook', 'slack', 'teams', 'chatgpt', 'codex', 'claude', 'email', 'other'].includes(source) ? source : 'other';
      const when = Date.parse(receivedAt) || now;
      const id = newId();
      let link = clean(url, 2000); if (link && !/^https:\/\//i.test(link)) link = '';
      const p = { id, title: t, note: clean(summary, 2000), status: 'inbox', priority: urgency === 'now' ? 'high' : 'normal', brief: true, delegate: true, source: src, sourceId: 'yours-' + id.slice(0, 8), sourceUrl: link, sourceFrom: clean(from, 80), sourceReceivedAt: iso(when), created: iso(now), updated: iso(now) };
      sb.projects.add.push(p);
      sb.intake.push({ id: p.sourceId, source: src, title: t, summary: p.note, request: p.note, from: p.sourceFrom, avatarUrl: null, receivedAt: iso(when), url: link, priority: p.priority, confidence: 'high', actionable: true, status: 'queued', projectId: id });
      if (urgency && URGENCY.includes(urgency)) sb.rank[id] = { urgency, reason: clean(reason, 140) };
      changed(invite); return p;
    },
    event(invite, { title, start, end, calendar = 'Yours', location = '', joinUrl = '', organizer = '', allDay = false }) {
      const sb = load(invite);
      if (sb.events.length >= LIMITS.events) throw fail('this test copy is full; ask Owner to reset it', 409);
      const ts = Date.parse(start); if (!Number.isFinite(ts)) throw fail('an event needs a start time');
      let te = Date.parse(end); if (!Number.isFinite(te) || te <= ts) te = ts + 30 * MIN;
      let join = clean(joinUrl, 1000); if (join && !/^https:\/\//i.test(join)) join = '';
      const e = { id: 'yours-' + crypto.randomBytes(5).toString('hex'), title: clean(title, 200) || 'Busy', ts, end: Math.min(te, ts + 2 * DAY), calendar: clean(calendar, 30) || 'Yours', location: clean(location, 200), joinUrl: join, organizer: clean(organizer, 80), allDay: Boolean(allDay) };
      sb.events.push(e); changed(invite); return e;
    },
    deadline(invite, { title, due, note }) { return write(invite, 'POST', '/api/deadlines', { title, due, note, track: 'work' }).json.item; },
    note(invite, { text }) { return write(invite, 'POST', '/api/stash', { text, source: 'agent' }).json.item; },
    link(invite, { title, url, category }) { return write(invite, 'POST', '/api/links', { title, url, category, pinned: false }).json.link; },
    agent(invite, { agent, project, doing, asked, status = 'working', id }) {
      const sb = load(invite); const now = clock();
      const tool = /codex/i.test(agent) ? 'codex' : /claude/i.test(agent) ? 'claude' : /chatgpt|gpt|openai|dot/i.test(agent) ? 'chatgpt' : /cursor/i.test(agent) ? 'cursor' : /copilot/i.test(agent) ? 'copilot' : /gemini/i.test(agent) ? 'gemini' : 'agent';
      let a = id && sb.agents.find((x) => x.id === id);
      if (!a) {
        a = sb.agents.find((x) => x.tool === tool && x.project === clean(project, 80) && x.status !== 'done');
      }
      if (!a) { if (sb.agents.length >= LIMITS.agents) sb.agents.shift(); a = { id: 'ag-' + crypto.randomBytes(4).toString('hex'), tool, project: clean(project, 80) || 'work', started: now, prompt: clean(asked, 300) }; sb.agents.push(a); }
      a.did = clean(doing, 300) || a.did || ''; if (asked) a.prompt = clean(asked, 300); a.last = now; a.status = ['working', 'done', 'needs-you'].includes(status) ? status : 'working';
      changed(invite); return { id: a.id, tool: a.tool, status: a.status };
    },
    clearSam(invite) { const sb = load(invite); sb.world = 'blank'; changed(invite); return sb; },
  };

  return { load, exists, state, write, report, stashList, stashItem, reset, remove, configure, startRun, bring, view: (invite, k) => view[k](load(invite), clock()), prefs: (invite) => load(invite).prefs };
}

// The look the tester sees: only the keys that are about looks. Spaces, web tabs and
// the like could name real work, so they never go in.
const PREF_KEYS = ['look', 'accent', 'grain', 'side', 'tabs', 'strip', 'keys', 'homeOrder', 'homeHidden', 'heroMix', 'gradient', 'pickStars', 'updated'];
function cleanPrefs(p) {
  const out = {};
  for (const k of PREF_KEYS) if (p && p[k] !== undefined) out[k] = p[k];
  const s = JSON.stringify(out);
  return s.length > 60000 ? {} : JSON.parse(s);
}

module.exports = { createSandboxes, cleanPrefs, isUni, PREF_KEYS };
