'use strict';
const { JOBS_ENABLED } = require('./runtime');

// Demo mode (2 Oct 2026): made-up data for screen recordings, so the command
// centre can be shown on X without client work. The page rewrites /api/x to
// /api/demo/x when demo is on, and every GET it makes is answered here.
//
// The world is invented and coherent: a designer working on the Northwind
// Coffee rebrand, the Tidepool app and a zine called Fieldnotes, plus two uni
// modules (DES501, DES502). Times are relative to now, so it always looks
// live: two agents working, a meeting in about half an hour, to-dos in
// Now / Next / Later. IDs and numbers are stable for the day.
//
// Rules this file keeps:
//   - It never reads Meridian's state, data files, config or logs. The only
//     real things are pass-throughs that are not personal: the model list
//     (/api/engines and the labels handed in), the almanac, the day's
//     painting and the page's own look (GET /api/command/prefs). handle()
//     names those by returning the real path; nothing else falls through.
//   - Every write answers {ok:true} (with a plausible id or echo where the
//     page expects one) and changes nothing.
//   - Hosts are invented (.example). Favicons and previews are 404 so the
//     page draws monograms.

const crypto = require('crypto');

const COLORS = { Outlook: '#6db4ff', Google: '#5fd3a5', Classes: '#b7a1ff' };
const HOST = 'studio-mac.tailnet.example';
const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;

// Real GETs that are safe to show: answered by the normal route.
const PASS = [/^\/api\/engines$/, /^\/api\/almanac$/, /^\/api\/almanac\/[\w.-]+(\/[\w.-]+)*$/, /^\/api\/daily-art\/image$/, /^\/api\/command\/prefs$/];

// ---------------------------------------------------------------- helpers

function hash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function uuid(seed) { const h = hash('demo:' + seed); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
// Small seeded random numbers, so a day's demo looks the same on every reload.
function rng(seed) {
  let a = parseInt(hash(seed).slice(0, 8), 16) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const iso = (ms) => new Date(ms).toISOString();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
function at(now, dayOffset, h, m = 0) { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m).getTime(); }
const quarterUp = (ms) => Math.ceil(ms / (15 * MIN)) * 15 * MIN;
const weekday = (ms) => new Date(ms).getDay();

function sendJson(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Meridian-Demo': '1' });
  res.end(JSON.stringify(value));
}

// A JSON body, capped; anything bigger (a stash upload) is read and dropped.
function readBody(req, limit = 100000) {
  return new Promise((resolve) => {
    let body = ''; let over = false;
    req.on('data', (c) => { if (over) return; body += c; if (body.length > limit) { over = true; body = ''; } });
    req.on('end', () => { if (over) { resolve({}); return; } try { const v = JSON.parse(body || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ---------------------------------------------------------------- the world

const PEOPLE = { maya: 'Maya Okafor', tom: 'Tom Reid', priya: 'Priya Shah', leo: 'Leo Hart', ana: 'Ana Ruiz', grant: 'Dr Ellis Grant', doyle: 'Sam Doyle' };
const AREAS = ['Northwind', 'Tidepool', 'Fieldnotes', 'Uni', 'Studio', 'Personal'];
const TRACK = { Northwind: 'work', Tidepool: 'work', Studio: 'work', Uni: 'uni', Fieldnotes: 'personal', Personal: 'personal' };

function modelNames(deps) {
  let labels = []; let def = null;
  try { const e = deps.engines ? deps.engines() : null; labels = (e && Array.isArray(e.labels) ? e.labels : []).map(String); def = e && e.default ? String(e.default) : null; } catch { /* fall back */ }
  if (!labels.length) labels = ['Opus 5.5 · High', 'GPT-6 Luna · High'];
  return { labels, def: def || labels[0] };
}

function calendarEvents(now) {
  const out = [];
  const push = (o) => {
    const uid = o.uid || 'demo-' + slug(o.title);
    out.push({
      ts: o.ts, end: o.end, title: o.title, allDay: false, cal: o.calendar, calendar: o.calendar, color: COLORS[o.calendar], uid,
      joinUrl: o.joinUrl || null, response: o.response || null, organizer: o.organizer || null, busyStatus: 'busy',
      location: o.location || null, id: `${uid}|${iso(o.ts)}`, recurring: Boolean(o.recurring), ...(o.kind ? { kind: o.kind, estimated: true } : {}),
    });
  };
  for (let d = 0; d < 8; d++) {
    const t = at(now, d, 9, 15);
    if ([0, 6].includes(weekday(t))) continue;
    push({ title: 'Studio stand-up', ts: t, end: t + 15 * MIN, calendar: 'Outlook', recurring: true, uid: 'demo-standup', joinUrl: 'https://meet.example.com/studio-standup', location: 'Online' });
  }
  const soon = quarterUp(now + 30 * MIN);
  push({ title: 'Northwind brand review', ts: soon, end: soon + 45 * MIN, calendar: 'Outlook', organizer: PEOPLE.maya, joinUrl: 'https://meet.example.com/northwind-review', location: 'Online' });
  const later = quarterUp(now + 3 * HOUR);
  push({ title: 'Tidepool sprint planning', ts: later, end: later + HOUR, calendar: 'Outlook', organizer: PEOPLE.priya, joinUrl: 'https://meet.example.com/tidepool-sprint', location: 'Online' });
  const climb = new Date(now).getHours() < 17 ? at(now, 0, 18, 30) : at(now, 1, 18, 30);
  push({ title: 'Climbing', ts: climb, end: climb + 90 * MIN, calendar: 'Google', location: 'The wall' });
  push({ title: 'Lunch with Ana', ts: at(now, 1, 13), end: at(now, 1, 14), calendar: 'Google', location: 'Market café' });
  push({ title: 'Fieldnotes print check', ts: at(now, 2, 16), end: at(now, 2, 16, 30), calendar: 'Google' });
  push({ title: 'Brightwater festival kickoff', ts: at(now, 3, 11), end: at(now, 3, 12), calendar: 'Outlook', organizer: PEOPLE.tom, response: 'needsAction', joinUrl: 'https://meet.example.com/brightwater-kickoff' });
  for (let d = 0; d < 8; d++) {
    const t = at(now, d, 12);
    if (weekday(t) === 2) push({ title: 'DES501 Final project studio', ts: at(now, d, 10), end: at(now, d, 16), calendar: 'Classes', organizer: PEOPLE.doyle, location: 'Studio 4', recurring: true, uid: 'class-des501', kind: 'class' });
    if (weekday(t) === 3) push({ title: 'DES502 Practice and Research', ts: at(now, d, 13), end: at(now, d, 14, 30), calendar: 'Classes', organizer: PEOPLE.grant, location: 'Room 2.14', recurring: true, uid: 'class-des502', kind: 'class' });
  }
  return out.filter((e) => e.end >= now - 6 * HOUR && e.ts <= now + 7 * DAY).sort((a, b) => a.ts - b.ts);
}

function todos(now) {
  const list = [
    ['Send Maya the three lock-up options', 'now', 'Northwind'],
    ['Book a print slot for Fieldnotes issue 3', 'next', 'Fieldnotes'],
    ['Review Leo’s onboarding PR', 'next', 'Tidepool'],
    ['Pick a DES502 research question', 'next', 'Uni'],
    ['Rewrite the portfolio about page', 'later', 'Studio'],
    ['Back up the photo library', 'later', 'Personal'],
  ];
  const out = list.map(([title, priority, area], i) => ({
    id: uuid('todo:' + title), title, note: '', priority, done: false, doneAt: null, area, delegation: null, order: i,
    created: iso(now - (i + 1) * 5 * HOUR), updated: iso(now - (i + 1) * HOUR),
  }));
  out.push({ id: uuid('todo:done'), title: 'Order sample cups from the printer', note: '', priority: 'next', done: true, doneAt: iso(now - 2 * HOUR), area: 'Northwind', delegation: null, order: 9, created: iso(now - 2 * DAY), updated: iso(now - 2 * HOUR) });
  return out;
}

function deadlines(now) {
  return [
    ['Northwind logo files to the printer', 2, 'work', 'Northwind', 'Final lock-up, CMYK and one-colour versions'],
    ['DES502 five-minute pitch', 5, 'uni', 'Uni', 'Three options, one slide each'],
    ['Fieldnotes issue 3 to print', 9, 'personal', 'Fieldnotes', '24 pages, riso, two colours'],
    ['DES502 essay draft', 30, 'uni', 'Uni', '4,000 words'],
  ].map(([title, days, track, area, note]) => ({ id: uuid('dl:' + title), title, due: isoDay(at(now, days, 12)), track, area, note, done: false, created: iso(now - 9 * DAY), updated: iso(now - 9 * DAY) }));
}

function intake(now) {
  const rows = [
    { title: 'Approve the Northwind menu proofs', source: 'outlook', from: PEOPLE.maya, ago: 2 * HOUR, priority: 'high', summary: 'Maya sent the final menu proofs and needs a yes or changes by tomorrow so the printer can start.', url: 'https://mail.example.com/message/northwind-proofs' },
    { title: 'Reply to Priya about the onboarding copy', source: 'slack', from: PEOPLE.priya, ago: 50 * MIN, priority: 'normal', summary: 'Priya asked whether the reminder step can say "Remind me later" instead of "Skip".', url: 'https://chat.example.com/archives/tidepool/p1' },
    { title: 'Send the Brightwater festival estimate', source: 'outlook', from: PEOPLE.tom, ago: 26 * HOUR, priority: 'normal', summary: 'Tom needs a rough estimate for the festival site before the kickoff on Monday.', url: 'https://mail.example.com/message/brightwater-estimate' },
  ];
  const projects = rows.map((r) => ({
    id: uuid('proj:' + r.title), title: r.title, note: r.summary, status: 'inbox', priority: r.priority, brief: true, delegate: true,
    source: r.source, sourceId: 'demo-' + slug(r.title), sourceUrl: r.url, sourceFrom: r.from, sourceReceivedAt: iso(now - r.ago), created: iso(now - r.ago), updated: iso(now - r.ago),
  }));
  const items = rows.map((r, i) => ({
    id: 'demo-' + slug(r.title), source: r.source, title: r.title, summary: r.summary, request: r.summary, from: r.from, avatarUrl: null,
    receivedAt: iso(now - r.ago), url: r.url, priority: r.priority, confidence: 'high', actionable: true, status: 'queued', projectId: projects[i].id, queuedAt: iso(now - r.ago + 5 * MIN), respondedAt: null,
  }));
  return { projects: { version: 1, projects }, briefIntake: { updatedAt: iso(now - 40 * MIN), window: { from: iso(now - DAY), to: iso(now), sources: ['Outlook', 'Slack'] }, items, pending: items.length } };
}

function sessions(now) {
  return [
    { tool: 'claude', project: 'northwind-site', started: now - 26 * MIN, last: now - 15 * 1000, live: true, prompt: 'Build the menu page on the new type scale and check it at phone width', did: 'Building the menu page on the new type scale' },
    { tool: 'codex', project: 'tidepool-app', started: now - 12 * MIN, last: now - 40 * 1000, live: true, prompt: 'The reminder step is skipped when notifications are off. Fix it and add a test.', did: 'Fixing the onboarding step that skips the reminder screen' },
    { tool: 'claude', project: 'fieldnotes', started: now - 3 * HOUR, last: now - 140 * MIN, live: false, prompt: 'Lay out issue 3 from the text in drafts/ and export a print PDF', did: 'Laid out issue 3 and exported a print PDF' },
    { tool: 'codex', project: 'portfolio', started: now - 5 * HOUR, last: now - 270 * MIN, live: false, prompt: 'Add a Northwind case study page using the photos in assets/northwind', did: 'Added the Northwind case study page' },
    { tool: 'claude', project: 'des502-reading', started: now - 6 * HOUR, last: now - 330 * MIN, live: false, prompt: 'Summarise these four papers on repair culture in plain English', did: 'Summarised four papers on repair culture for the reading list' },
    { tool: 'claude', project: 'design-tokens', started: now - 26 * HOUR, last: now - 25 * HOUR, live: false, prompt: 'Add the new terracotta and pine colours to the tokens', did: 'Added two brand colours and rebuilt the token docs' },
    { tool: 'codex', project: 'northwind-site', started: now - 29 * HOUR, last: now - 28 * HOUR, live: false, prompt: 'Make the shop finder work without location permission', did: 'Shop finder now falls back to a postcode search' },
  ].map((s) => ({ summary: null, ...s }));
}

function fleet(now) {
  const r = rng('fleet:' + isoDay(now));
  const hist = (base) => Array.from({ length: 48 }, () => Math.round(base * (0.7 + r() * 0.7)));
  const site = (name, url, base) => { const h = hist(base); return { name, url, up: true, rawUp: true, ms: h[h.length - 1], status: 200, history: h, kind: 'site', label: null, pausable: false, paused: false, pauseMode: 'probe', matchedBy: null }; };
  const svc = (name, url, base, paused = false) => { const h = paused ? [] : hist(base); return { name, url, kind: 'service', label: null, pausable: true, paused, pauseMode: 'probe', matchedBy: null, up: true, rawUp: paused ? null : true, ms: paused ? null : h[h.length - 1], status: paused ? null : 200, history: h }; };
  return {
    sites: [site('Portfolio', 'https://portfolio.example/', 140), site('Northwind preview', 'https://preview.northwind.example/', 180), site('Fieldnotes shop', 'https://fieldnotes.example/', 120)],
    services: [svc('Render queue', 'http://127.0.0.1:4500/', 12), svc('Asset library', 'http://127.0.0.1:4600/', 18), svc('Old prototype', 'http://127.0.0.1:4700/', 0, true)],
    agents: [{ label: 'com.studio.nightly-notes', pid: 0, exitStatus: 0 }, { label: 'com.studio.backup', pid: 0, exitStatus: 0 }],
    paused: 1, down: 0,
  };
}

function servers() {
  const s = (port, project, title, category, shared, extra = {}) => ({
    port, pid: 40000 + port, command: 'node', cwd: `~/Developer/${project}`, project, title, status: 200, ms: 20 + (port % 37), loopbackOnly: false,
    localUrl: `http://127.0.0.1:${port}/`, tailUrl: `http://${HOST}:${port}/`, tailIpUrl: `http://100.64.0.10:${port}/`, category,
    shareUrl: shared ? `https://${HOST}:${10000 + port}/` : null, shareHttpsPort: shared ? 10000 + port : null, shareOwned: Boolean(shared),
    reachable: shared ? `https://${HOST}:${10000 + port}/` : `http://${HOST}:${port}/`, ignored: false, ...extra,
  });
  return [
    s(3000, 'northwind-site', 'Northwind Coffee', 'Northwind', true),
    s(4321, 'fieldnotes', 'Fieldnotes no. 3', 'Fieldnotes', false),
    s(5173, 'tidepool-app', 'Tidepool', 'Tidepool', true),
    s(6006, 'design-tokens', 'Storybook', 'Tools', false),
  ];
}

function links(now) {
  const L = [
    ['Northwind brand board', 'https://boards.example/northwind', 'Northwind', 'doc', 0],
    ['Northwind preview', 'https://preview.northwind.example/', 'Northwind', 'live', 1],
    ['Tidepool staging', 'https://staging.tidepool.example/', 'Tidepool', 'live', 2],
    ['Tidepool board', 'https://tracker.example/tidepool', 'Tidepool', 'tool', 3],
    ['Fieldnotes shop', 'https://fieldnotes.example/', 'Fieldnotes', 'live', 4],
    ['Riso colour chart', 'https://printshop.example/riso-colours', 'Fieldnotes', 'doc', null],
    ['DES502 reading list', 'https://library.example/des502', 'Uni', 'doc', 5],
    ['DES501 project blog', 'https://notes.example/des501', 'Uni', 'doc', null],
    ['Type foundry', 'https://foundry.example/', 'Tools', 'tool', 6],
    ['Colour palettes', 'https://palettes.example/', 'Tools', 'tool', 7],
    ['Design files', 'https://files.example/studio', 'Tools', 'tool', null],
    ['Portfolio', 'https://portfolio.example/', 'Personal', 'live', null],
    ['Climbing timetable', 'https://wall.example/timetable', 'Personal', 'doc', null],
  ];
  const r = rng('links');
  return {
    categories: ['Northwind', 'Tidepool', 'Fieldnotes', 'Uni', 'Tools', 'Personal'],
    links: L.map(([title, url, category, kind, pin], i) => ({
      id: uuid('link:' + title), title, url, category, tags: [], note: '', kind, pinned: pin !== null, pinOrder: pin === null ? 0 : pin, check: kind === 'live', preview: true,
      opens: Math.round(4 + r() * 60), lastOpened: iso(now - Math.round((i + 1) * r() * 30) * HOUR), created: iso(now - (40 - i) * DAY), updated: iso(now - (20 - i) * DAY),
      health: kind === 'live' ? { at: now - 4 * MIN, up: true, status: 200, ms: Math.round(90 + r() * 150) } : null,
    })),
  };
}

function github(now) {
  const pr = (repo, number, title, hoursAgo, extra = {}) => ({ repo: `studio-ash/${repo}`, number, title, url: `https://git.example/studio-ash/${repo}/pull/${number}`, state: 'open', draft: false, checks: 'passing', reviewDecision: null, updatedAt: iso(now - hoursAgo * HOUR), author: 'studio-ash', mergedAt: null, ...extra });
  return {
    at: iso(now - 6 * MIN), user: 'studio-ash',
    prs: [pr('northwind-site', 42, 'Menu page on the new type scale', 0.3, { checks: 'pending' }), pr('tidepool-app', 118, 'Onboarding: keep the reminder step', 2), pr('design-tokens', 15, 'Terracotta and pine colours', 25, { draft: true })],
    reviews: [pr('tidepool-app', 121, 'Swap the chart library', 3, { author: 'leohart' })],
    merged: [pr('fieldnotes', 9, 'Issue 3 layout', 20, { state: 'merged', mergedAt: iso(now - 20 * HOUR) }), pr('portfolio', 31, 'Case study: Northwind', 30, { state: 'merged', mergedAt: iso(now - 30 * HOUR) }), pr('northwind-site', 40, 'Shop finder without location', 50, { state: 'merged', mergedAt: iso(now - 50 * HOUR) })],
    failing: [], repos: 5, error: null,
  };
}

const NOW_MD = `# Where things stand

## Northwind rebrand
Northwind rebrand has the lock-up approved, and the menu page is being built on the new type scale.

## Tidepool app
Tidepool app onboarding is in review, with one fix left on the reminder step.

## Fieldnotes zine
Fieldnotes issue 3 is laid out and waiting on a print slot.

## Uni
DES502 pitch is next week: three options, one slide each.
`;

function ledgerState(now) {
  const entries = Array.from({ length: 14 }, (_, i) => { const d = isoDay(now - (i + 1) * DAY); return { name: d + '.md', date: d }; });
  return { entries, latest: { ...entries[0], excerpt: `# ${entries[0].date}\n\n${NOW_MD.split('\n').slice(2).join('\n')}` }, now: NOW_MD, schedule: '23:40' };
}

function runs(now, m) {
  const run = (title, model, startedAgo, mins, status, files) => ({
    id: `feedback-${slug(title)}-demo`, title, card: null, projectId: null, kind: 'feedback', todoId: null, source: 'meridian-feedback', requestFile: null, model,
    started: now - startedAgo, finished: status === 'running' ? null : now - startedAgo + mins * MIN, effort: null, status, error: null,
    files: [], changes: files ? { files } : null, undoable: Boolean(files), undoneAt: null,
  });
  return [
    run('Make the shelf tiles a little smaller on phones', m.labels[0], 6 * MIN, 0, 'running', null),
    run('Show the week number in Up next', m.labels[1] || m.labels[0], 2 * HOUR, 9, 'done', [{ path: 'public/command.js', added: 14, removed: 3 }, { path: 'public/command.css', added: 6, removed: 0 }]),
    run('Stop the colour picker jumping while dragging', m.labels[0], 27 * HOUR, 12, 'done', [{ path: 'public/command.js', added: 8, removed: 11 }]),
    { ...run('Draft the Brightwater festival estimate', m.labels[1] || m.labels[0], 20 * HOUR, 7, 'done', null), kind: 'delegation', source: 'outlook', id: 'project-brightwater-demo', files: ['REPORT.md', 'estimate.md'] },
  ];
}

function journalToday(now) {
  const s = sessions(now).filter((x) => isoDay(x.started) === isoDay(now));
  const groups = new Map();
  for (const x of s) {
    const g = groups.get(x.project) || { name: x.project, commits: [], sessions: { claude: 0, codex: 0 }, minutes: 0, first: x.started, last: x.last, asks: [], did: null, track: x.project.startsWith('des') ? 'uni' : x.project === 'fieldnotes' ? 'personal' : 'work' };
    g.sessions[x.tool] = (g.sessions[x.tool] || 0) + 1;
    g.minutes += Math.max(1, Math.round((x.last - x.started) / MIN));
    g.first = Math.min(g.first, x.started); g.last = Math.max(g.last, x.last);
    g.asks.push(x.prompt); g.did = x.did;
    groups.set(x.project, g);
  }
  const ng = groups.get('northwind-site'); if (ng) ng.commits.push({ t: now - 70 * MIN, subject: 'Menu: section headings on the new scale' });
  return { date: isoDay(now), items: [...groups.values()].sort((a, b) => b.last - a.last), delegations: [] };
}

function pulse(now) {
  return sessions(now).filter((x) => isoDay(x.started) === isoDay(now)).map((x) => ({ t: x.started, kind: x.tool, label: `${x.project}: ${x.did}` })).sort((a, b) => a.t - b.t);
}

function buildState(now, deps = {}) {
  const m = modelNames(deps);
  const ev = calendarEvents(now);
  const kickoff = ev.find((e) => e.response === 'needsAction');
  const { projects, briefIntake } = intake(now);
  const ses = sessions(now);
  return {
    at: now, machine: 'Studio Mac', location: { name: 'Belfast', lat: 54.5973, lon: -5.9301 },
    board: { cards: [
      { id: 'northwind-menu', title: 'Northwind menu page', status: 'in-progress', needsYou: false, agentReady: true, updated: iso(now - 30 * MIN), link: null, file: 'northwind-menu.md' },
      { id: 'tidepool-reminders', title: 'Tidepool reminder step', status: 'review', needsYou: true, agentReady: false, updated: iso(now - 2 * HOUR), link: null, file: 'tidepool-reminders.md' },
      { id: 'fieldnotes-4', title: 'Fieldnotes issue 4 ideas', status: 'ideas', needsYou: false, agentReady: false, updated: iso(now - 3 * DAY), link: null, file: 'fieldnotes-4.md' },
    ] },
    projects,
    ai: { sessions: ses, liveCount: ses.filter((s) => s.live).length, todayCount: ses.filter((s) => isoDay(s.started) === isoDay(now)).length },
    fleet: fleet(now),
    git: { repos: [
      { path: '~/Developer/northwind-site', name: 'northwind-site', branch: 'menu-type-scale', dirty: 3, subject: 'Menu: section headings on the new scale', commitTs: now - 70 * MIN, ahead: 2, behind: 0 },
      { path: '~/Developer/tidepool-app', name: 'tidepool-app', branch: 'fix/reminder-step', dirty: 1, subject: 'Keep the reminder step when notifications are off', commitTs: now - 2 * HOUR, ahead: 1, behind: 0 },
      { path: '~/Developer/fieldnotes', name: 'fieldnotes', branch: 'main', dirty: 0, subject: 'Issue 3 layout', commitTs: now - 20 * HOUR, ahead: 0, behind: 0 },
      { path: '~/Developer/portfolio', name: 'portfolio', branch: 'main', dirty: 0, subject: 'Case study: Northwind', commitTs: now - 30 * HOUR, ahead: 0, behind: 0 },
    ] },
    brain: { nodes: 1840, links: 5230, realms: [{ name: 'Studio', count: 620 }, { name: 'Reading', count: 540 }, { name: 'Personal', count: 370 }, { name: 'Uni', count: 310 }] },
    threads: { up: false, tasks: [] },
    calendar: { at: now - 3 * MIN, configured: true, events: ev, calendars: [
      { id: 'demo-work', label: 'Outlook', color: COLORS.Outlook, hidden: false, ok: true },
      { id: 'demo-personal', label: 'Google', color: COLORS.Google, hidden: false, ok: true },
      { id: 'classes', label: 'Classes', color: COLORS.Classes, hidden: false, ok: true },
    ] },
    pulse: { events: pulse(now) },
    system: { host: 'Studio Mac', uptimeH: 96, load: '2.1', diskFreeGb: 212 },
    ledger: ledgerState(now),
    meetings: { meetings: [] }, drift: { strays: [] },
    delegations: { runs: runs(now, m) },
    briefFeedback: { completed: [], rejected: [], skipped: {} },
    briefIntake,
    workBrief: null,
    tailnet: { host: HOST, ip: '100.64.0.10', servePort: 4980 },
    local: { servers: servers() },
    links: links(now),
    notifyHistory: [
      { time: now - 2 * HOUR + 9 * MIN, title: 'Agent finished', message: 'Show the week number in Up next', event: 'delegation', ok: true, status: 200 },
      { time: now - 26 * HOUR, title: 'Due tomorrow: Northwind colour proofs', message: 'Tomorrow · Northwind colour proofs', event: 'deadline', ok: true, status: 200 },
    ],
    engines: m.labels, defaultModel: m.def,
    capabilities: { previews: false },
    journalToday: journalToday(now),
    deadlines: deadlines(now),
    todos: todos(now),
    notify: { provider: 'ntfy', url: 'https://ntfy.sh', topic: 'demo-topic', enabled: true, events: ['deadline', 'fleet', 'delegation'] },
    vaultJournalDir: '~/Notes/Journal',
    invites: kickoff ? [{ id: kickoff.id, title: kickoff.title, start: iso(kickoff.ts), end: iso(kickoff.end), organizer: kickoff.organizer, joinUrl: kickoff.joinUrl, response: 'needsAction', url: 'https://mail.example.com/invite/brightwater-kickoff', source: 'ics', cal: 'Outlook', inCalendar: true, calendarId: kickoff.id }] : [],
    outlookMeetings: [],
    nudges: { enabled: true, minutes: [10, 1], skip: ['^studio stand-up$'], push: true },
    github: github(now),
    demo: true,
  };
}

// ---------------------------------------------------------------- journal

const JOURNAL = {
  Northwind: [['Lock-up options for the new mark', 'Three lock-ups at cup, sign and app-icon sizes. The stacked one wins at small sizes.'], ['Menu page on the new type scale', 'Moved the menu to the new scale and fixed the price column alignment.'], ['Colour tests for the cup sleeves', 'Terracotta prints darker on kraft stock; lifted it 8% for the sleeves.'], ['Brand review prep', 'Pulled the lock-ups, colour tests and signage into one deck for Maya.'], ['Signage mock-ups for the riverside shop', 'Fascia, window vinyl and the A-board, all from the one grid.']],
  Tidepool: [['Onboarding flow, reminder step', 'The reminder step vanished when notifications were off. Agent fixed it; reviewed the copy with Priya.'], ['Chart library swap', 'Reviewed Leo’s swap. Smaller bundle, nicer tooltips, one colour to fix.'], ['Empty states for the journal screen', 'Drew three empty states with the illustration set.'], ['Sprint planning notes', 'Next sprint: reminders, onboarding polish, the settings tidy.']],
  Fieldnotes: [['Issue 3 layout', 'Twenty-four pages laid out, two-colour riso, page 12 still needs a photo.'], ['Cover, second pass', 'Simpler cover, one big shape and the masthead.'], ['Print quotes', 'Two quotes back. The smaller press can do it next week.']],
  Uni: [['DES502 reading: repair culture', 'Four papers summarised. Strongest thread: repair as care, not nostalgia.'], ['DES501 studio: three project options', 'Narrowed to three: shared tool libraries, bus stop data, a repair café kit.'], ['DES502 pitch outline', 'One slide per option, a question each, and what I would make.']],
  Studio: [['Invoices and the October plan', 'Sent two invoices and blocked out October around the Northwind launch.'], ['Portfolio case study: Northwind', 'Wrote the case study and picked eight images.']],
  Personal: [['Climbing', 'Finally sent the green overhang.'], ['Photo library tidy', 'Sorted September into albums and backed it up.']],
};

function journal(now) {
  const entries = [];
  for (let d = 0; d < 28; d++) {
    const day = at(now, -d, 12);
    const r = rng('journal:' + isoDay(day));
    const n = weekday(day) % 6 === 0 ? 1 : 2 + Math.floor(r() * 2);
    const used = new Set();
    for (let k = 0; k < n; k++) {
      const area = AREAS[Math.floor(r() * AREAS.length)];
      const list = JOURNAL[area];
      const [title, body] = list[Math.floor(r() * list.length)];
      if (used.has(title)) continue;
      used.add(title);
      entries.push({ id: uuid(`j:${isoDay(day)}:${title}`), date: isoDay(day), area, track: TRACK[area], title, body, tags: [], minutes: area === 'Personal' ? null : 30 + Math.round(r() * 8) * 15, source: r() < 0.8 ? 'ledger' : 'manual', sourceRef: null, created: iso(day - 2 * HOUR), updated: iso(day - 2 * HOUR) });
    }
  }
  return { version: 1, areas: AREAS.slice(), entries };
}

function journalReport(now, q) {
  const { entries } = journal(now);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : isoDay(now - 6 * DAY);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '') ? q.get('to') : isoDay(now);
  const track = ['work', 'uni', 'personal'].includes(q.get('track')) ? q.get('track') : 'all';
  const list = entries.filter((e) => e.date >= from && e.date <= to && (track === 'all' || e.track === track)).sort((a, b) => a.date.localeCompare(b.date));
  if (q.get('format') === 'csv') return { type: 'text/csv; charset=utf-8', body: ['date,area,track,title,minutes', ...list.map((e) => [e.date, e.area, e.track, `"${e.title.replace(/"/g, '""')}"`, e.minutes ?? ''].join(','))].join('\n') + '\n' };
  const byArea = new Map();
  for (const e of list) { if (!byArea.has(e.area)) byArea.set(e.area, []); byArea.get(e.area).push(e); }
  const md = [`# Time report, ${from} to ${to}`, '', ...[...byArea].flatMap(([a, l]) => [`## ${a}`, ...l.map((e) => `- ${e.date}: ${e.title}${e.minutes ? ` (${e.minutes} min)` : ''}`), ''])].join('\n');
  return { type: 'text/markdown; charset=utf-8', body: md };
}

// ---------------------------------------------------------------- AI usage

const MODELS = {
  'claude-opus-5-5': { label: 'Opus 5.5', provider: 'claude' }, 'claude-opus-5': { label: 'Opus 5', provider: 'claude' }, 'claude-sonnet-5': { label: 'Sonnet 5', provider: 'claude' },
  'gpt-6-luna': { label: 'GPT-6 Luna', provider: 'openai' }, 'gpt-6.1-sol': { label: 'GPT-6.1 Sol', provider: 'openai' }, 'gpt-5.6-terra': { label: 'GPT-5.6 Terra', provider: 'openai' },
};
const PLANS = [
  { id: 'claude-max', provider: 'claude', name: 'Claude Max', account: 'Personal', payer: 'you', status: 'active', periods: [{ from: '2026-03-01', to: null, amount: 90, currency: 'GBP', per: 'month', label: 'Max' }] },
  { id: 'chatgpt-pro-studio', provider: 'openai', name: 'ChatGPT Pro', account: 'Studio', payer: 'work', status: 'active', periods: [{ from: '2026-05-01', to: null, amount: 200, currency: 'USD', per: 'month', label: 'Pro' }] },
  { id: 'chatgpt-plus', provider: 'openai', name: 'ChatGPT Plus', account: 'Personal', payer: 'you', status: 'ended', periods: [{ from: '2026-01-10', to: '2026-04-30', amount: 20, currency: 'USD', per: 'month', label: 'Plus' }] },
];

function usageRows(now) {
  const rows = [];
  for (let d = 150; d >= 0; d--) {
    const day = at(now, -d, 12);
    const date = isoDay(day);
    const r = rng('usage:' + date);
    const weekend = [0, 6].includes(weekday(day));
    const ramp = 0.55 + 0.45 * (1 - d / 150);
    const cl = (weekend ? 0.35 : 1) * ramp * (14 + r() * 50);
    const op = (weekend ? 0.3 : 1) * ramp * (6 + r() * 26);
    const mk = (provider, model, plan, cost, machine, profile) => {
      const total = Math.round(cost * (provider === 'claude' ? 520000 : 760000) * (0.8 + r() * 0.4));
      const output = Math.round(total * 0.012); const input = Math.round(total * 0.03); const cacheWrite = Math.round(total * 0.06);
      rows.push({ date, provider, plan, model, machine, profile, source: 'history', approx: false, tokens: { input, output, cacheRead: total - input - output - cacheWrite, cacheWrite, total }, cost: Math.round(cost * 1e6) / 1e6, sessions: 1 + Math.floor(r() * 7) });
    };
    if (date >= '2026-03-01') {
      const model = date >= '2026-09-10' ? 'claude-opus-5-5' : date >= '2026-06-01' ? 'claude-opus-5' : 'claude-sonnet-5';
      mk('claude', model, 'claude-max', cl * 0.7, 'Studio', 'Claude Code');
      mk('claude', model, 'claude-max', cl * 0.3, 'Laptop', 'Claude Code');
    }
    const plan = date >= '2026-05-01' ? 'chatgpt-pro-studio' : date >= '2026-01-10' && date <= '2026-04-30' ? 'chatgpt-plus' : null;
    if (plan) mk('openai', date >= '2026-09-01' ? (r() < 0.6 ? 'gpt-6-luna' : 'gpt-6.1-sol') : 'gpt-5.6-terra', plan, op, r() < 0.7 ? 'Studio' : 'Laptop', 'Codex CLI');
  }
  return rows;
}

function payments(now) {
  const out = [];
  for (const p of PLANS) {
    for (const per of p.periods) {
      const end = per.to ? Date.parse(per.to + 'T12:00:00') : now;
      const [y, m, d] = per.from.split('-').map(Number);
      for (let k = 0; ; k++) {
        const t = new Date(y, m - 1 + k, d, 12).getTime();
        if (t > end) break;
        out.push({ date: isoDay(t), plan: p.id, provider: p.provider, account: p.account, payer: p.payer, currency: per.currency, amount: per.amount, kind: 'subscription', status: 'paid', reference: null, note: '' });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function aiLedger(now) {
  const rows = usageRows(now);
  const today = isoDay(now); const yesterday = isoDay(now - DAY);
  const morning = iso(at(now, 0, 7, 30));
  return {
    generatedAt: iso(now), currency: 'USD', fx: { USDGBP: 0.756, date: yesterday, source: 'frankfurter.dev (ECB)', fetchedAt: morning, stale: false },
    machine: 'Studio', providers: { claude: 'Claude', openai: 'ChatGPT' },
    plans: PLANS.map((p) => ({ ...p, note: '', evidence: [], confirmed: true, source: 'demo', seen: { from: p.periods[0].from, through: p.periods[0].to || today } })),
    planRules: [], payments: payments(now),
    history: { running: false, startedAt: null, lastRun: { mode: 'scan', startedAt: morning, finishedAt: iso(at(now, 0, 7, 30) + 4200), ms: 4200, ok: true, errors: [], csvRows: rows.length },
      machines: { Studio: { lastSuccess: morning, coveredThrough: yesterday, lastAttempt: morning, error: null }, Laptop: { lastSuccess: morning, coveredThrough: yesterday, lastAttempt: morning, error: null } } },
    rows,
    sources: [{ id: 'history', label: 'Usage history, both Macs', from: rows[0] ? rows[0].date : today, through: today, csvRows: rows.length, rows: rows.length, replacedByLive: 0, coveredThrough: { Studio: yesterday, Laptop: yesterday } }],
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, { ...m, pricedAs: id, pricing: 'table' }])),
  };
}

function aiHosts(now) {
  const days = {};
  for (const r of usageRows(now)) {
    if (r.date < isoDay(now - 30 * DAY) || r.machine !== 'Studio') continue;
    const d = days[r.date] || (days[r.date] = { claude: 0, codex: 0, tokens: 0 });
    d[r.provider === 'claude' ? 'claude' : 'codex'] += r.cost; d.tokens += r.tokens.total;
  }
  return { hosts: [{ host: 'Studio', name: 'Studio Mac', days, receivedAt: now - 20 * MIN }] };
}

// ---------------------------------------------------------------- stash

const STASH = [
  { kind: 'image', source: 'screenshot', title: 'Type specimen, display sizes', palette: ['#1d1b16', '#efe6d2', '#c8553d'], spaces: ['type', 'northwind'], w: 2880, h: 1800, ago: 25 * MIN, labels: ['screenshot', 'text'] },
  { kind: 'note', source: 'note', text: 'Northwind: try the wordmark with tighter tracking on the cup sleeve. It reads better at 40 mm.', spaces: ['northwind'], ago: 70 * MIN },
  { kind: 'colour', source: 'paste', hex: '#c8553d', title: 'Terracotta', spaces: ['northwind'], ago: 2 * HOUR },
  { kind: 'link', source: 'page', title: 'Café signage, a collection', url: 'https://moodboard.example/cafe-signage', palette: ['#2b2a28', '#d9cbb2', '#7a8b6f'], spaces: ['northwind'], w: 1200, h: 630, ago: 3 * HOUR },
  { kind: 'image', source: 'screenshot', title: 'Tidepool onboarding, step 3', palette: ['#0f2a3d', '#4fa3c7', '#e8f3f7'], spaces: ['tidepool'], w: 1170, h: 2532, ago: 5 * HOUR, labels: ['screenshot', 'phone'] },
  { kind: 'quote', source: 'page', text: 'Repair is a form of care that design keeps forgetting.', page: { url: 'https://journal.example/notes-on-repair', title: 'Notes on repair', app: 'Browser' }, url: '', spaces: ['uni'], ago: 8 * HOUR },
  { kind: 'image', source: 'drop', title: 'Riso print test', palette: ['#ff5e7e', '#00a5a8', '#f4efe6'], spaces: ['zine'], w: 2000, h: 2600, ago: 26 * HOUR, labels: ['print'] },
  { kind: 'colour', source: 'paste', hex: '#2e5e4e', title: 'Deep pine', spaces: ['northwind'], ago: 28 * HOUR },
  { kind: 'image', source: 'phone', title: 'Shop front reference', palette: ['#3b2f2a', '#b98b62', '#e9dcc8'], spaces: ['northwind'], w: 3024, h: 4032, ago: 2 * DAY, labels: ['photo', 'outdoor'] },
  { kind: 'link', source: 'page', title: 'Menus set in one typeface', url: 'https://typeface.example/menus', palette: ['#111111', '#f1ece2', '#d24d32'], spaces: ['type'], w: 1200, h: 630, ago: 3 * DAY },
  { kind: 'file', source: 'drop', name: 'DES502 reading list.pdf', title: 'DES502 reading list', spaces: ['uni'], bytes: 482113, ago: 4 * DAY },
  { kind: 'note', source: 'note', text: 'Zine idea: a page of found receipts from the market, scanned at 600 dpi.', spaces: ['zine'], ago: 5 * DAY },
];
const FROM = ['Studio', 'Laptop', 'Phone'];

function stashItems(now) {
  return STASH.map((s, i) => {
    const id = 'demo' + String(i + 1).padStart(4, '0');
    const created = now - s.ago;
    const it = {
      id, kind: s.kind, title: s.title || '', note: '', text: s.text || (s.hex || ''), url: s.url || (s.page ? s.page.url : ''), domain: '', source: s.source,
      from: s.source === 'phone' ? 'Phone' : FROM[i % 2], page: s.page || null, spaces: s.spaces || [], pinned: false, created, updated: created,
    };
    try { if (it.url) it.domain = new URL(it.url).hostname; } catch { /* none */ }
    if (s.hex) it.hex = s.hex;
    if (s.palette) {
      it.palette = s.palette.map((hex, k) => ({ hex, weight: [0.52, 0.31, 0.17][k] || 0.1, name: ['dark', 'light', 'accent'][k] || 'colour' }));
      it.thumb = true; it.tw = 900; it.th = Math.round(900 * (s.h / s.w)); it.w = s.w; it.h = s.h;
    }
    if (s.kind === 'image') Object.assign(it, { file: `${id}.png`, bytes: Math.round(s.w * s.h * 0.4), mime: 'image/png', name: `${slug(s.title)}.png`, labels: (s.labels || []).map((l, k) => ({ id: l, c: 0.97 - k * 0.08 })), hasText: (s.labels || []).includes('text'), similar: true });
    else if (s.kind === 'file') Object.assign(it, { file: `${id}.pdf`, bytes: s.bytes, mime: 'application/pdf', name: s.name, thumb: false, labels: [], hasText: true });
    else Object.assign(it, { labels: [], hasText: false });
    if (s.kind === 'link') it.title = s.title;
    return it;
  });
}

function stashList(now, q) {
  const all = stashItems(now);
  const words = String(q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const kind = String(q.get('kind') || '');
  const space = String(q.get('space') || '').toLowerCase().replace(/^#/, '');
  let found = all.filter((it) => {
    if (kind === 'screenshot' ? it.source !== 'screenshot' : kind && it.kind !== kind) return false;
    if (space && !it.spaces.includes(space)) return false;
    const hay = [it.title, it.text, it.note, it.domain, it.kind, ...(it.spaces || []), ...((it.palette || []).map((p) => p.name)), ...((it.labels || []).map((l) => l.id))].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w.replace(/^#/, '')));
  });
  if (q.get('order') === 'shuffle') { const r = rng('shuffle:' + isoDay(now)); found = found.map((it) => [r(), it]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); }
  const counts = { all: all.length };
  for (const it of all) { counts[it.kind] = (counts[it.kind] || 0) + 1; if (it.source === 'screenshot') counts.screenshot = (counts.screenshot || 0) + 1; }
  const spaceCounts = new Map();
  for (const it of all) for (const s of it.spaces) spaceCounts.set(s, (spaceCounts.get(s) || 0) + 1);
  const seenAt = now - 3 * HOUR;
  const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 300)); const offset = Math.max(0, Number(q.get('offset')) || 0);
  return { ok: true, total: found.length, chips: [], counts, spaces: [...spaceCounts].map(([name, n]) => ({ name, n })), seenAt, fresh: all.filter((it) => it.created > seenAt).length, items: found.slice(offset, offset + limit) };
}

// A made-up picture in the item's colours: a window for screenshots, soft shapes for photos.
function stashSvg(it) {
  const [a, b, c] = (it.palette || [{ hex: '#222' }, { hex: '#888' }, { hex: '#ddd' }]).map((p) => p.hex);
  const w = it.tw || 900; const h = it.th || 600;
  const r = rng('svg:' + it.id);
  let body;
  if (it.source === 'screenshot') {
    const bars = Array.from({ length: 6 }, (_, i) => `<rect x="${w * 0.1}" y="${h * (0.3 + i * 0.09)}" width="${w * (0.35 + r() * 0.45)}" height="${h * 0.035}" rx="${h * 0.012}" fill="${b}" opacity="${0.35 + r() * 0.4}"/>`).join('');
    body = `<rect width="${w}" height="${h}" fill="${a}"/><rect x="${w * 0.05}" y="${h * 0.06}" width="${w * 0.9}" height="${h * 0.88}" rx="${Math.min(w, h) * 0.03}" fill="${b}" opacity=".12"/><rect x="${w * 0.1}" y="${h * 0.14}" width="${w * 0.5}" height="${h * 0.09}" rx="${h * 0.02}" fill="${c}"/>${bars}`;
  } else {
    const blobs = Array.from({ length: 5 }, () => `<circle cx="${Math.round(r() * w)}" cy="${Math.round(r() * h)}" r="${Math.round((0.15 + r() * 0.35) * Math.max(w, h))}" fill="${[b, c, a][Math.floor(r() * 3)]}" opacity="${0.35 + r() * 0.4}"/>`).join('');
    body = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="${Math.round(Math.min(w, h) * 0.06)}"/></filter></defs><rect width="${w}" height="${h}" fill="url(#g)"/><g filter="url(#f)">${blobs}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

// ---------------------------------------------------------------- writes

const newId = (p) => `${p}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// ---------------------------------------------------------------- money

// Six months of a made-up designer's Monzo and a small index portfolio, for
// the Money tab (3 Oct 2026). Same shape as money.js's bundle.
const MONEY_RULES = { salary: ['Northwind Studio'], internal: ['Own Savings Ltd'], invest: ['Index Broker'], ignore: [], categories: {} };
function moneyBundle(now) {
  const r = rng('money:' + isoDay(now).slice(0, 7));
  const tx = []; let n = 0;
  const add = (ms, name, category, amount, type = 'Card payment', notes) => { if (ms > now) return; const d = new Date(ms); tx.push({ id: 'tx_demo' + String(++n).padStart(5, '0'), date: isoDay(ms), time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, type, name, category, amount: Math.round(amount * 100) / 100, account: 'Monzo', ...(notes ? { notes } : {}) }); };
  const start = at(now, -185, 9);
  for (let t = start; t <= now; t += DAY) {
    const d = new Date(t); const dom = d.getDate(); const wd = d.getDay();
    if (dom === 25) add(at(t, 0, 9, 4), 'Northwind Studio', 'Income', 2140 + Math.round(r() * 3) * 10, 'Faster payment');
    if (dom === 1) add(at(t, 0, 8, 2), 'Harbour Lets', 'Bills', -720, 'Faster payment', 'Rent');
    if (dom === 3) add(at(t, 0, 7, 30), 'Gym Co', 'Gym', -35);
    if (dom === 8) add(at(t, 0, 6, 12), 'Streamly', 'Entertainment', -10.99);
    if (dom === 12) add(at(t, 0, 6, 40), 'Cloud Notes', 'Bills', -6);
    if (dom === 15) add(at(t, 0, 10, 0), 'Phone Mobile', 'Bills', -18);
    if (dom === 26) add(at(t, 0, 9, 30), 'Index Broker', 'Savings', -200, 'Faster payment');
    if (wd === 2 || wd === 6) add(at(t, 0, 17, 20 + Math.floor(r() * 30)), r() > 0.5 ? 'Corner Grocer' : 'Fresh Market', 'Groceries', -(12 + r() * 34));
    if (wd >= 1 && wd <= 4 && r() > 0.45) add(at(t, 0, 8, 10), 'City Rail', 'Transport', -3.2);
    if (r() > 0.72) add(at(t, 0, 12, 30 + Math.floor(r() * 20)), ['Tidepool Cafe', 'Noodle Bar', 'The Lantern'][Math.floor(r() * 3)], 'Eating out', -(6 + r() * 26));
    if (r() > 0.9) add(at(t, 0, 15, 5), ['Record Shop', 'Bookshop', 'Outdoor Gear'][Math.floor(r() * 3)], 'Shopping', -(14 + r() * 60));
    if (r() > 0.6) add(at(t, 0, 21, 0), 'Rainy Day Pot', 'Savings', -(0.2 + r() * 1.6), 'Pot transfer');
  }
  add(at(now, -70, 13), 'Ferry Holidays', 'Holidays', -386, 'Card payment', 'Summer trip');
  add(at(now, -40, 11), 'Own Savings Ltd', 'Transfers', 300, 'Faster payment');
  const pos = [['Global All-Cap Index (Acc)', 2210, 2034], ['S&P 500 (Acc)', 1180, 1050], ['Physical Gold', 640, 600], ['Clean Energy ETF', 410, 455], ['Semiconductors (Acc)', 380, 311]];
  const value = pos.reduce((a, p) => a + p[1], 0); const cost = pos.reduce((a, p) => a + p[2], 0);
  // Walked backwards from today's value so the line ends where the card says.
  const history = []; let v = value; for (let i = 0; i < 60; i++) { history.unshift({ date: isoDay(now - i * DAY), value: Math.round(v * 100) / 100, cost: Math.round((cost - Math.floor((i + 23) / 30) * 200) * 100) / 100, cash: 12.4, source: 'api' }); v = v / (1 + (r() - 0.44) * 0.012); }
  const today = isoDay(now);
  return {
    at: iso(now),
    monzo: { pulledAt: iso(at(now, 0, 6, 0)), accounts: [{ tab: 'Personal Account Transactions', account: 'Monzo', rows: tx.length }], transactions: tx },
    t212: { pulledAt: iso(at(now, 0, 6, 1)), asOf: today, source: 'api', account: { currency: 'GBP', value: value + 12.4, invested: value, cost, cash: 12.4, unrealised: value - cost, realised: 18.2 },
      positions: pos.map(([name, val, c], i) => ({ ticker: 'DEMO' + i, name, quantity: 10 + i, currentPrice: 10 + i, value: val, cost: c, ppl: val - c, fx: null, currency: 'GBP', since: null, inPies: i >= 3 ? 10 + i : 0 })),
      pies: [{ id: 1, name: 'Future energy and chips', icon: null, invested: 766, value: 790, result: 24, cash: 0.2, instruments: pos.slice(3).map(([name, val, c], i) => ({ ticker: 'DEMO' + (i + 3), quantity: 13 + i, invested: c, value: val, result: val - c, share: 0.5 })) }],
      orders: pos.map(([name, val, c], i) => ({ id: 'o' + i, date: isoDay(now - (120 - i * 9) * DAY), ticker: 'DEMO' + i, name, side: 'BUY', status: 'FILLED', value: c, quantity: 10 + i, price: 9 + i * 0.9, currency: 'GBP', from: 'IOS' })), dividends: [{ ref: 'd1', date: isoDay(now - 20 * DAY), ticker: 'DEMO1', amount: 4.12 }], transfers: [{ ref: 't1', date: isoDay(now - 120 * DAY), type: 'DEPOSIT', amount: 3800 }, { ref: 't2', date: isoDay(now - 7 * DAY), type: 'DEPOSIT', amount: 200 }] },
    history,
    accounts: [{ id: 'demoacc001', name: 'Easy access savings', kind: 'savings', balance: 3250, asOf: isoDay(now - 9 * DAY), note: '', history: [] }, { id: 'demoacc002', name: 'Lifetime ISA', kind: 'lisa', balance: 5100, asOf: isoDay(now - 30 * DAY), note: '', history: [] }],
    rules: MONEY_RULES,
    status: { monzo: { ok: true, rows: tx.length, through: today, at: iso(at(now, 0, 6, 0)) }, t212: { ok: true, value, positions: pos.length, at: iso(at(now, 0, 6, 1)) }, running: false },
    connected: { google: true, t212: true, sheet: true },
    settings: { refreshHour: 6, palette: 'meaning' },
    context: { tx: {}, subs: { 'gym co': { status: 'paused', since: isoDay(now - 20 * DAY), note: 'Frozen until the project wraps' } },
      trips: [{ id: 'trip-coast', name: 'Coast trip', from: isoDay(now - 72 * DAY), to: isoDay(now - 66 * DAY), with: 'Sam', budget: 450, note: '' }],
      notes: [{ id: 'note-demo1', text: 'New studio desk and chair this month, a one-off.', from: isoDay(now - 40 * DAY), to: isoDay(now - 35 * DAY) }],
      profile: 'Freelance designer paid on the 25th. Rent monthly. Saving for a deposit.' },
    plans: {},
    advice: (() => { const n = { id: 'n-demo1', at: iso(at(now, 0, 6, 5)), date: isoDay(now), model: 'gpt-6-luna', effort: 'high', reason: 'scheduled', advice: DEMO_ADVICE }; return { notes: [n], latest: n, running: null, lastError: null, at: n.at, advice: n.advice, model: n.model }; })(),
    adviser: { schedule: 'weekly', weekday: 1, model: 'gpt-6-luna', effort: 'high' },
    advisers: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', kind: 'codex', effort: 'high' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', kind: 'codex', effort: 'medium' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', kind: 'claude', effort: 'high' }, { id: 'claude-opus-5-5', name: 'Opus 5.5', kind: 'claude', effort: 'medium' }],
  };
}
const DEMO_ADVICE = {
  headline: 'You are on track this month: rent is covered and about £1,270 is left with three weeks to payday.',
  going_well: ['£200 goes into your index fund every month without you thinking about it.', 'Eating out is down £44 on the same point last month.', 'The portfolio is up £370 on what you paid in.'],
  watch: ['Rent is 81% of spending so far, so small costs add up fast after it.', 'Five regular payments come to about £790 a month, rent included.'],
  try: ['Move £300 of this month\'s spare money to savings on payday, before it gets spent.', 'Check Cloud Notes: £6 a month for something you might not open.'],
};

async function write(req, res, real, now) {
  const body = await readBody(req);
  const m = req.method;
  const ok = (extra = {}) => sendJson(res, m === 'POST' && /^\/api\/(todos|links|projects|deadlines|journal)$/.test(real) ? 201 : 200, { ok: true, demo: true, ...extra });
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, typeof o[k] === 'string' ? o[k].slice(0, 2000) : o[k]]));
  let mm;
  if (real === '/api/todos' && m === 'POST') return ok({ todo: { id: uuid('new:' + Date.now()), title: String(body.title || 'New to-do').slice(0, 200), note: '', priority: ['now', 'next', 'later'].includes(body.priority) ? body.priority : 'next', done: false, doneAt: null, area: '', delegation: null, order: 0, created: iso(now), updated: iso(now) } });
  if ((mm = real.match(/^\/api\/todos\/([\w-]+)\/delegate$/)) && m === 'POST') { const id = newId('todo-demo'); return ok({ id, todo: { id: mm[1], delegation: { id, model: body.model || null, status: 'running', started: now } } }); }
  if ((mm = real.match(/^\/api\/todos\/([\w-]+)$/)) && m === 'PATCH') return ok({ todo: { id: mm[1], ...pick(body, ['title', 'priority', 'done', 'note']), updated: iso(now) } });
  if (real === '/api/todos/reorder') return ok({ todos: [] });
  if (real === '/api/todos/clear-done') return ok({ removed: 0 });
  if (real === '/api/links' && m === 'POST') return ok({ link: { id: uuid('newlink:' + Date.now()), ...pick(body, ['title', 'url', 'category', 'note', 'pinned', 'pinOrder']), created: iso(now), updated: iso(now) } });
  if ((mm = real.match(/^\/api\/links\/([\w-]+)\/open$/))) return ok({ link: { id: mm[1], lastOpened: iso(now) } });
  if ((mm = real.match(/^\/api\/links\/([\w-]+)$/)) && m === 'PATCH') return ok({ link: { id: mm[1], ...pick(body, ['title', 'url', 'category', 'note', 'pinned', 'pinOrder']), updated: iso(now) } });
  if (real === '/api/links/categories') return ok({ categories: Array.isArray(body.categories) ? body.categories.slice(0, 40) : [] });
  if (real === '/api/links/pin-order') return ok({ links: Array.isArray(body.ids) ? body.ids.length : 0 });
  if (real === '/api/capture') return ok({ id: newId('capture-demo'), file: null });
  if (real === '/api/feedback') return ok({ id: newId('feedback-demo'), file: null, model: String(body.model || ''), attachments: 0 });
  if (real === '/api/delegate') return ok({ id: newId('delegation-demo') });
  if (real === '/api/journal' && m === 'POST') return ok({ entry: { id: uuid('newj:' + Date.now()), ...pick(body, ['date', 'area', 'track', 'title', 'body', 'minutes']), created: iso(now), updated: iso(now) } });
  if ((mm = real.match(/^\/api\/journal\/([\w-]+)$/)) && m === 'PATCH') return ok({ entry: { id: mm[1], ...pick(body, ['date', 'area', 'track', 'title', 'body', 'minutes']), updated: iso(now) } });
  if (real === '/api/deadlines' && m === 'POST') return ok({ item: { id: uuid('newdl:' + Date.now()), ...pick(body, ['title', 'due', 'track', 'note']), done: false, created: iso(now), updated: iso(now) } });
  if ((mm = real.match(/^\/api\/deadlines\/([\w-]+)$/)) && m === 'PATCH') return ok({ item: { id: mm[1], ...pick(body, ['title', 'due', 'track', 'note', 'done']) } });
  if (real === '/api/local/share') { const port = Number(body.port) || 3000; return ok({ url: `https://${HOST}:${10000 + port}/`, port, httpsPort: 10000 + port }); }
  if (real === '/api/ai-usage/refresh') return ok({ running: false, started: false });
  if (real === '/api/money/rules') return ok({ rules: { ...MONEY_RULES, ...pick(body, ['salary', 'internal', 'invest', 'ignore', 'categories']) } });
  if (real === '/api/money/accounts') return ok({ accounts: Array.isArray(body.accounts) ? body.accounts.slice(0, 30).map((a, i) => ({ id: 'demoacc' + String(i).padStart(3, '0'), name: String(a.name || '').slice(0, 60), kind: a.kind || 'other', balance: Number(a.balance) || 0, asOf: a.asOf || isoDay(now), note: '', history: [] })) : [] });
  if (real === '/api/money/advice') { const n = { id: 'n-demo2', at: iso(now), date: isoDay(now), model: String(body.model || 'gpt-6-luna'), reason: 'asked', advice: DEMO_ADVICE }; return ok({ advice: { notes: [n], latest: n, running: null } }); }
  if (real === '/api/money/adviser') return ok({ adviser: { schedule: 'weekly', weekday: 1, model: 'gpt-6-luna', effort: 'high', ...pick(body, ['schedule', 'weekday', 'model', 'effort']) } });
  if (real === '/api/money/context') return ok({});
  if (real === '/api/money/plans') return ok({ plans: {} });
  if (real === '/api/money/settings') return ok({ settings: { refreshHour: 6, palette: String(body.palette || 'meaning') } });
  if (real === '/api/money/refresh') return ok({ result: { monzo: { ok: true }, t212: { ok: true } }, data: moneyBundle(now) });
  if (real === '/api/stash' && m === 'POST') { const text = String(body.text || '').slice(0, 4000); const isLink = /^https?:\/\/\S+$/.test(text.trim()); return ok({ item: { id: 'demo' + crypto.randomBytes(3).toString('hex'), kind: isLink ? 'link' : 'note', title: '', note: '', text: isLink ? '' : text, url: isLink ? text.trim() : '', domain: '', source: body.source || 'paste', from: body.from || null, page: null, spaces: [], pinned: false, created: now, updated: now, labels: [] } }); }
  if (real === '/api/stash/file') return ok({ item: { id: 'demo' + crypto.randomBytes(3).toString('hex'), kind: 'image', title: '', note: '', text: '', url: '', domain: '', source: 'upload', from: null, page: null, spaces: [], pinned: false, created: now, updated: now, pending: true, labels: [] } });
  if ((mm = real.match(/^\/api\/stash\/([a-z0-9]{8,20})$/)) && m === 'PATCH') { const it = stashItems(now).find((x) => x.id === mm[1]) || { id: mm[1] }; return ok({ item: { ...it, ...pick(body, ['title', 'note', 'spaces', 'pinned']), updated: now } }); }
  if ((mm = real.match(/^\/api\/stash\/([a-z0-9]{8,20})\/restore$/))) return ok({ item: stashItems(now).find((x) => x.id === mm[1]) || { id: mm[1] } });
  if (real === '/api/command/prefs' && m === 'PUT') return ok();
  return ok();
}

// ---------------------------------------------------------------- routes

function createDemo(deps = {}) {
  const clock = deps.now || (() => Date.now());

  // true when answered here; otherwise the real path (with its query) of an
  // allowed pass-through for server.js to serve as normal.
  async function handle(req, res, url) {
    const real = '/api' + (url.pathname.replace(/^\/api\/demo/, '') || '/');
    const m = req.method;
    const now = clock();
    const q = url.searchParams;
    if (m !== 'GET' && m !== 'HEAD') { await write(req, res, real, now); return true; }
    if (PASS.some((re) => re.test(real))) return real + url.search;

    if (real === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Meridian-Demo': '1' });
      res.write('retry: 5000\n\n');
      res.write('event: state\ndata: ' + JSON.stringify(buildState(now, deps)) + '\n\n');
      const keep = JOBS_ENABLED && setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { clearInterval(keep); } }, 20000);
      keep.unref?.();
      req.on('close', () => clearInterval(keep));
      return true;
    }
    const json = (v) => { sendJson(res, 200, v); return true; };
    switch (real) {
      case '/api/state': return json(buildState(now, deps));
      case '/api/links': return json(links(now));
      case '/api/journal': return json(journal(now));
      case '/api/ai-usage/ledger': return json(aiLedger(now));
      case '/api/ai-usage': return json(aiHosts(now));
      case '/api/ai-usage/plans': return json({ version: 2, plans: PLANS, rules: [] });
      case '/api/usage': return json({ week: { home: 46, shelf: 12, stash: 15, usage: 6, dogfood: 9, journal: 4, system: 3, brief: 5 }, all: { home: 410, shelf: 96, stash: 61, usage: 44, dogfood: 70, journal: 31, system: 22, brief: 38 }, days: 61 });
      case '/api/todos': return json({ todos: todos(now) });
      case '/api/deadlines': return json({ items: deadlines(now) });
      case '/api/github': return json(github(now));
      case '/api/local': return json({ servers: servers(), tailnet: { host: HOST, ip: '100.64.0.10', servePort: 4980 } });
      case '/api/projects': return json(intake(now).projects);
      case '/api/stash': return json(stashList(now, q));
      case '/api/money': return json(moneyBundle(now));
      case '/api/money/status': return json({ ok: true, setup: true, unlocked: true, until: now + DAY, remember: true });
      case '/api/link-meta': {
        let host = '';
        try { host = new URL(q.get('url') || '').hostname.replace(/^www\./, ''); } catch { return json({ ok: false, error: 'not a url' }); }
        const name = host.split('.')[0] || 'Link';
        return json({ ok: true, title: name.charAt(0).toUpperCase() + name.slice(1), description: '', status: 200, category: 'Tools' });
      }
      case '/api/journal/report': {
        const out = journalReport(now, q);
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="time-report.${out.type.startsWith('text/csv') ? 'csv' : 'md'}"`, 'X-Meridian-Demo': '1' });
        res.end(out.body);
        return true;
      }
      case '/api/favicon': case '/api/preview':
        res.writeHead(404, { 'Cache-Control': 'no-store', 'X-Meridian-Demo': '1' }); res.end('no icon in the demo'); return true;
      default: break;
    }
    const sm = real.match(/^\/api\/stash\/([a-z0-9]{8,20})(?:\/(file|thumb|icon|similar))?$/);
    if (sm) {
      const items = stashItems(now);
      const it = items.find((x) => x.id === sm[1]);
      if (!it) { sendJson(res, 404, { ok: false, error: 'not in the stash' }); return true; }
      if (!sm[2]) return json({ ok: true, item: { ...it, ocr: it.hasText ? it.title : '' } });
      if (sm[2] === 'similar') return json({ ok: true, items: items.filter((x) => x.id !== it.id && x.kind === 'image').map((x, i) => ({ ...x, distance: 0.21 + i * 0.07 })) });
      if ((sm[2] === 'thumb' || sm[2] === 'file') && it.palette) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'X-Meridian-Demo': '1' });
        res.end(stashSvg(it));
        return true;
      }
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('no ' + sm[2]); return true;
    }
    sendJson(res, 404, { ok: false, error: 'not in the demo' });
    return true;
  }

  return { handle, state: (now = clock()) => buildState(now, deps) };
}

module.exports = { createDemo, buildState, PASS };
// The world's parts, for the tester's sandbox (tester/sandbox.js), which keeps a tester's own changes on top.
module.exports.world = { calendarEvents, todos, deadlines, intake, sessions, links, journal, journalReport, stashItems, stashList, stashSvg, github, servers, aiLedger, aiHosts, moneyBundle, NOW_MD, PEOPLE, uuid, isoDay, readBody };
