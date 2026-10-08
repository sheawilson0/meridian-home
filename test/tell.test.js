'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createTell, contextFor, parseLocal, localStamp } = require('../tell');
const { createStore } = require('../todos-store');

const NOW = new Date(2026, 9, 4, 14, 52).getTime(); // Sun 4 Oct 2026, 14:52

function setup(t, { plan, calendar, trust, clock = () => NOW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const todos = createStore(path.join(dir, 'todos.json'));
  const sent = []; const captured = []; const deadlines = []; const notes = []; const draftList = []; const fixes = []; const agentCalls = [];
  const state = {
    todos: [{ id: 't-mark', title: 'Email Rowan the expenses claim', priority: 'next', done: false }],
    calendar: { events: [
      { id: 'e1', ts: new Date(2026, 9, 8, 17, 30).getTime(), end: new Date(2026, 9, 8, 18, 30).getTime(), title: 'Gym work', cal: 'Google' },
      { id: 'e2', ts: new Date(2026, 9, 5, 15, 45).getTime(), end: new Date(2026, 9, 5, 16, 15).getTime(), title: 'DEMO stats catch-up', cal: 'Outlook', response: 'needsAction' },
    ] },
    invites: [{ id: 'inv1', title: 'Design review', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z', organizer: 'Avery', source: 'outlook' }],
    deadlines: [],
  };
  const runClaude = async ({ args, input }) => {
    if (args.includes('--allowedTools')) { agentCalls.push(input); return calendar ? calendar(input) : { ok: true, eventId: 'AAMk1', summary: 'Done in Outlook' }; }
    if (plan instanceof Error) throw plan;
    return typeof plan === 'function' ? plan(input) : plan;
  };
  const tell = createTell({
    dir, getState: () => state, todos, now: clock, runClaude,
    drafts: { create: async (d, by) => { const x = { id: 'd' + draftList.length, ...d, by }; draftList.push(x); return x; }, remove: async (id) => { const i = draftList.findIndex((d) => d.id === id); draftList.splice(i, 1); } },
    captures: { capture: async (text) => { captured.push(text); return { id: '2026-10-04T13-52-00' }; }, undo: async () => ({ ok: true }) },
    notify: async (title, message, opts) => { sent.push({ title, message, ...opts }); return true; },
    addDeadline: async (d) => { const x = { id: 'dl' + deadlines.length, ...d }; deadlines.push(x); return x; },
    removeDeadline: async (id) => { deadlines.splice(deadlines.findIndex((d) => d.id === id), 1); },
    moneyNotes: { add: async (n) => { notes.push({ id: 'tell-n' + notes.length, ...n }); return 'tell-n' + (notes.length - 1); }, remove: async (id) => { notes.splice(notes.findIndex((n) => n.id === id), 1); } },
    startFix: async (text) => { fixes.push(text); return { id: 'feedback-x' }; },
    soulDefault: '# Meridian\nShort. Say what matters first.\n',
  });
  if (trust) fs.writeFileSync(path.join(dir, 'tell-settings.json'), JSON.stringify({ trust }));
  return { dir, tell, todos, state, sent, captured, deadlines, notes, draftList, fixes, agentCalls };
}

const DUMP_PLAN = {
  reply: 'Five changes. One question about Sam.',
  actions: [
    { kind: 'todo.add', title: 'Add milk', text: 'Milk' },
    { kind: 'remind', title: 'Remind you about Rowan’s expenses email', ref: 'T1', at: '2026-10-05T09:00', text: 'Send Rowan the expenses claim' },
    { kind: 'money.note', title: 'Log £12 lunch as a work expense', amount: 12, date: '2026-10-04', label: 'Work expense', text: 'Lunch' },
    { kind: 'calendar.add', title: 'Drinks with Sam, Friday 20:00', text: 'Drinks with Sam', start: '2026-10-09T20:00', end: '2026-10-09T22:00', calendar: 'phone', people: ['Sam'],
      ask: { q: 'Invite Sam, or just block the time?', options: [{ label: 'Just block it', set: { people: [] } }, { label: 'Invite Sam', set: { calendar: 'outlook' } }] } },
    { kind: 'calendar.move', title: 'Move made-up event', ref: 'E99', start: '2026-10-09T18:00' },
    { kind: 'teleport', title: 'not a kind' },
  ],
};

test('parseLocal reads Europe/London wall-clock times and localStamp writes them back', () => {
  const ms = parseLocal('2026-10-09T18:00');
  assert.equal(localStamp(ms), '2026-10-09T18:00');
  assert.equal(new Date(parseLocal('2026-10-09')).getHours(), 9);
  assert.equal(parseLocal('Friday at six'), null);
});

test('the planner context gives refs for to-dos, events and invites and marks Outlook ones', (t) => {
  const { state } = setup(t);
  const ctx = contextFor(state, NOW);
  assert.match(ctx.text, /T1 · Email Rowan the expenses claim/);
  assert.match(ctx.text, /Gym work \[Google\]/);
  assert.match(ctx.text, /DEMO stats catch-up \[outlook\] \(not answered\)/);
  assert.match(ctx.text, /I1 · .*Design review · from Avery/);
  assert.equal(ctx.refs.T1.id, 't-mark');
  assert.equal(ctx.refs.E2.outlook, true);
  assert.equal(ctx.refs.E1.outlook, false);
});

test('a plan keeps only known kinds and real refs, and marks what needs a tick', async (t) => {
  const { tell } = setup(t, { plan: DUMP_PLAN });
  const p = await tell.create({ text: 'brain dump', wait: 5000 });
  assert.equal(p.status, 'ready');
  assert.equal(p.reply, 'Five changes. One question about Sam.');
  assert.deepEqual(p.actions.map((a) => a.kind), ['todo.add', 'remind', 'money.note', 'calendar.add']);
  const byKind = Object.fromEntries(p.actions.map((a) => [a.kind, a]));
  assert.equal(byKind['todo.add'].confirm, false);
  assert.equal(byKind['calendar.add'].confirm, true, 'calendar waits for a tick, and Sam is involved');
  assert.equal(byKind.remind.target.id, 't-mark');
  assert.equal(byKind['calendar.add'].ask.options[0].label, 'Just block it');
});

test('apply makes each change, returns receipts, and Undo puts each one back', async (t) => {
  const { tell, todos, notes } = setup(t, { plan: DUMP_PLAN });
  const p = await tell.create({ text: 'brain dump', wait: 5000 });
  const done = await tell.apply(p.id, { picks: [{ i: 0, on: true, title: 'Buy milk' }, { i: 1, on: true }, { i: 2, on: true }, { i: 3, on: true, choice: 0 }] });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.actions.map((a) => a.state), ['done', 'done', 'done', 'done']);
  assert.equal((await todos.read()).todos[0].title, 'Milk');
  assert.equal(done.actions[0].title, 'Buy milk', 'the card keeps the edited title');
  assert.match(done.actions[1].result, /Mon 5 Oct 09:00/);
  assert.deepEqual(notes.map((n) => n.text), ['£12.00 Lunch (Work expense)']);
  assert.equal(done.actions[3].link, `/api/tell/${p.id}/event/3.ics`);
  assert.match(done.receipt, /4 changes made/);
  assert.equal((await tell.readReminders()).length, 1);

  await tell.undo(p.id, 0);
  await tell.undo(p.id, 1);
  await tell.undo(p.id, 2);
  assert.equal((await todos.read()).todos.length, 0);
  assert.equal((await tell.readReminders()).length, 0);
  assert.equal(notes.length, 0);
  await assert.rejects(tell.undo(p.id, 3), /can't be undone/);
  const after = await tell.get(p.id);
  assert.deepEqual(after.actions.map((a) => a.state), ['undone', 'undone', 'undone', 'done']);
});

test('the phone calendar event is an .ics with the chosen answer applied', async (t) => {
  const { tell } = setup(t, { plan: DUMP_PLAN });
  const p = await tell.create({ text: 'x', wait: 5000 });
  await tell.apply(p.id, { picks: [{ i: 3, on: true, choice: 0 }, { i: 0, on: false }, { i: 1, on: false }, { i: 2, on: false }] });
  const ics = tell.ics(await tell.get(p.id), 3);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Drinks with Sam/);
  assert.match(ics, new RegExp('DTSTART:' + new Date(2026, 9, 9, 20).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')));
  const later = await tell.get(p.id);
  assert.deepEqual(later.actions.map((a) => a.state), ['skipped', 'skipped', 'skipped', 'done']);
});

test('auto mode (the Action Button) does the trusted parts and pings about the rest', async (t) => {
  const { tell, sent, todos } = setup(t, { plan: DUMP_PLAN });
  const p = await tell.create({ text: 'brain dump', mode: 'auto', via: 'action-button', wait: 5000 });
  assert.deepEqual(p.actions.map((a) => a.state), ['done', 'done', 'done', 'planned']);
  assert.equal((await todos.read()).todos.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Meridian needs a tick');
  assert.match(sent[0].message, /Done: Add milk, Remind you about Rowan’s expenses email, Log £12 lunch as a work expense\./);
  assert.match(sent[0].message, /Drinks with Sam, Friday 20:00 needs a tick/);
  assert.equal(sent[0].event, 'needs');
  assert.equal(sent[0].actions[0].label, 'Do it');
  assert.equal(sent[0].actions[0].url, `/api/tell/${p.id}/apply`);
  assert.deepEqual(JSON.parse(sent[0].actions[0].body), { picks: [{ i: 3, on: true }] });
  assert.equal(sent[0].actions[1].label, 'Look first');
  assert.match(tell.shortcutLine(p), /1 needs a tick/);
});

test('trusting calendar lets a phone event happen without asking, but not one with other people', async (t) => {
  const plan = { reply: '', actions: [
    { kind: 'calendar.add', title: 'Gym', text: 'Gym', start: '2026-10-09T18:00', calendar: 'phone' },
    { kind: 'calendar.add', title: 'Drinks', text: 'Drinks', start: '2026-10-09T20:00', calendar: 'phone', people: ['Sam'] },
  ] };
  const { tell } = setup(t, { plan, trust: { calendar: true } });
  const p = await tell.create({ text: 'x', wait: 5000 });
  assert.deepEqual(p.actions.map((a) => a.confirm), [false, true]);
});

test('Outlook changes go to a calendar agent with only calendar tools, and can be undone', async (t) => {
  const plan = { reply: '', actions: [
    { kind: 'calendar.add', title: 'Client call', text: 'Client call', start: '2026-10-06T11:00', end: '2026-10-06T11:30', calendar: 'outlook' },
    { kind: 'calendar.move', title: 'Move the DEMO catch-up', ref: 'E2', start: '2026-10-05T16:00', end: '2026-10-05T16:30' },
    { kind: 'calendar.move', title: 'Move the gym', ref: 'E1', start: '2026-10-09T18:00' },
  ] };
  const { tell, agentCalls } = setup(t, { plan });
  const p = await tell.create({ text: 'x', wait: 5000 });
  await tell.apply(p.id, { picks: [{ i: 0 }, { i: 1 }, { i: 2 }] });
  // Calendar agents run in the background; wait for them to settle.
  for (let n = 0; n < 50 && (await tell.get(p.id)).status !== 'done'; n++) await new Promise((r) => setTimeout(r, 10));
  const done = await tell.get(p.id);
  assert.deepEqual(done.actions.map((a) => a.state), ['done', 'done', 'failed']);
  assert.match(done.actions[2].result, /only Outlook events/);
  assert.match(agentCalls[0], /Create an event in .+ Outlook calendar: "Client call" from 2026-10-06T11:00 to 2026-10-06T11:30/);
  assert.match(agentCalls[0], /Don't invite anyone/);
  assert.match(agentCalls[1], /Move the event "DEMO stats catch-up" starting 2026-10-05T15:45/);
  await tell.undo(p.id, 0);
  assert.match(agentCalls[2], /Delete the event "Client call" at 2026-10-06T11:00 .*event id AAMk1/);
  await tell.undo(p.id, 1);
  assert.match(agentCalls[3], /back to 2026-10-05T15:45 to 2026-10-05T16:15/);
});

test('a button can act directly: Accept on an invite goes straight to Outlook', async (t) => {
  const { tell, agentCalls } = setup(t, { plan: new Error('planner should not run') });
  const p = await tell.create({ actions: [{ kind: 'calendar.respond', title: 'Accept Design review', invite: 'inv1', response: 'accept' }], via: 'phone' });
  for (let n = 0; n < 50 && (await tell.get(p.id)).status !== 'done'; n++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await tell.get(p.id)).actions[0].state, 'done');
  assert.match(agentCalls[0], /Respond "accept" to the event "Design review"/);
  assert.match(agentCalls[0], /organised by Avery/);
});

test('a failed plan from the Action Button keeps the words in the Inbox and says so', async (t) => {
  const { tell, captured, sent } = setup(t, { plan: new Error('model unavailable') });
  const p = await tell.create({ text: 'Move the gym to Friday', mode: 'auto', wait: 5000 });
  assert.equal(p.status, 'failed');
  assert.match(captured[0], /Move the gym to Friday/);
  assert.equal(sent[0].title, 'Saved, not done');
});

test('a question gets an answer and no actions', async (t) => {
  const { tell } = setup(t, { plan: { reply: 'Example Agency WIP at 09:15, then DEMO stats at 15:45.', actions: [] } });
  const p = await tell.create({ text: 'what’s on tomorrow?', wait: 5000 });
  assert.equal(p.status, 'ready');
  assert.equal(p.actions.length, 0);
  assert.equal(tell.shortcutLine(p), 'Example Agency WIP at 09:15, then DEMO stats at 15:45.');
});

test('drafts, Meridian fixes and inbox notes go to their own places', async (t) => {
  const plan = { reply: '', actions: [
    { kind: 'draft', title: 'Email Rowan', channel: 'email', to: 'Rowan', subject: 'Expenses claim', text: 'Hi Rowan…' },
    { kind: 'fix', title: 'Bigger Tell button', text: 'Make the Tell button bigger' },
    { kind: 'capture', title: 'Idea', text: 'A widget for deadlines' },
  ] };
  const { tell, draftList, fixes, captured } = setup(t, { plan });
  const p = await tell.create({ text: 'x', wait: 5000 });
  assert.deepEqual(p.actions.map((a) => a.confirm), [false, true, false]);
  await tell.apply(p.id, { picks: [{ i: 0 }, { i: 1 }, { i: 2 }] });
  for (let n = 0; n < 50 && (await tell.get(p.id)).status !== 'done'; n++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(draftList[0].by, 'Meridian');
  assert.equal(draftList[0].kind, 'email');
  assert.deepEqual(fixes, ['Make the Tell button bigger']);
  assert.deepEqual(captured, ['A widget for deadlines']);
  await tell.undo(p.id, 0);
  assert.equal(draftList.length, 0);
});

test('soul.md: Owner edits it, Meridian edits it, and the history shows what changed', async (t) => {
  const plan = { reply: '', actions: [{ kind: 'soul.edit', title: 'Never ping twice', text: 'Never ping twice about the same thing.', remove: 'Short. Say what matters first.' }] };
  const { tell } = setup(t, { plan });
  assert.match((await tell.soul()).text, /Short\. Say what matters first\./);
  await tell.saveSoul('# Meridian\nShort. Say what matters first.\nBritish spelling.\n', { by: 'Owner', why: 'spelling' });
  const p = await tell.create({ text: 'in your soul file, never ping me twice', wait: 5000 });
  await tell.apply(p.id, { picks: [{ i: 0 }] });
  const s = await tell.soul();
  assert.doesNotMatch(s.text, /Short\./);
  assert.match(s.text, /Never ping twice about the same thing\./);
  assert.equal(s.history[0].by, 'Meridian');
  assert.deepEqual(s.history[0].added, ['Never ping twice about the same thing.']);
  assert.deepEqual(s.history[0].removed, ['Short. Say what matters first.']);
  assert.equal(s.history[1].by, 'Owner');
  await tell.undo(p.id, 0);
  assert.match((await tell.soul()).text, /Short\. Say what matters first\./);
});

test('reminders ping once at their time; long-missed ones are marked, not sent', async (t) => {
  const { tell, sent } = setup(t);
  await tell.addReminder({ text: 'Call Dad', at: NOW - 60000 });
  await tell.addReminder({ text: 'Old one', at: NOW - 13 * 3600e3 });
  await tell.addReminder({ text: 'Later', at: NOW + 3600e3 });
  const due = await tell.tickReminders();
  assert.deepEqual(due.map((r) => r.text), ['Call Dad']);
  assert.equal(sent[0].title, 'Call Dad');
  assert.equal(sent[0].event, 'reminder');
  assert.deepEqual(sent[0].actions.map((a) => a.label), ['In an hour']);
  const snoozed = await tell.snoozeReminder(due[0].id, 60);
  assert.equal(snoozed.at, NOW + 3600e3);
  await tell.removeReminder(snoozed.id);
  assert.deepEqual((await tell.tickReminders()).map((r) => r.text), []);
  const left = (await tell.readReminders()).filter((r) => !r.sent).map((r) => r.text);
  assert.deepEqual(left, ['Later']);
});

test('routes: plan, long-poll, apply, undo, settings, soul, reminders', async (t) => {
  const { tell } = setup(t, { plan: async () => { await new Promise((r) => setTimeout(r, 40)); return DUMP_PLAN; } });
  const sendJson = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  const jsonBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(JSON.parse(b || '{}'))); });
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); if (!(await tell.handle(req, res, url, { jsonBody, sendJson }))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };

  const short = await fetch(base + '/api/tell?mode=auto&via=action-button&wait=3000&format=text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'brain dump' }) });
  assert.equal(short.status, 201);
  assert.match(short.headers.get('content-type'), /text\/plain/);
  assert.match(await short.text(), /^Done: Add milk/);
  const made = await call('POST', '/api/tell', { text: 'brain dump' });
  assert.equal(made.status, 201);
  assert.equal(made.json.tell.status, 'planning');
  assert.match(made.json.message, /Working on it/);
  const id = made.json.tell.id;
  const polled = await call('GET', `/api/tell/${id}?wait=3000`);
  assert.equal(polled.json.tell.status, 'ready');
  assert.equal(polled.json.tell.actions[1].undo, undefined, 'undo details stay on the Mac');
  const applied = await call('POST', `/api/tell/${id}/apply`, { picks: [{ i: 0 }, { i: 1, on: false }, { i: 2, on: false }, { i: 3, on: false }] });
  assert.equal(applied.json.tell.actions[0].canUndo, true);
  const undone = await call('POST', `/api/tell/${id}/undo`, { i: 0 });
  assert.equal(undone.json.tell.actions[0].state, 'undone');
  assert.equal((await call('GET', '/api/tell')).json.tells.length, 2);
  assert.equal((await call('POST', `/api/tell/${id}/undo`, { i: 1 })).status, 409);
  assert.equal((await call('GET', '/api/tell/settings')).json.trust.calendar, false);
  assert.equal((await call('PUT', '/api/tell/settings', { trust: { calendar: true, bogus: true } })).json.trust.calendar, true);
  assert.match((await call('GET', '/api/soul')).json.text, /# Meridian/);
  assert.equal((await call('PUT', '/api/soul', { text: '# Meridian\nBe brief.\n', why: 'test' })).json.history[0].why, 'test');
  assert.equal((await call('GET', '/api/tell/abcdefabcdef')).status, 404);
  assert.equal((await call('GET', '/api/nothing-here')).status, 404);
});

test('Undo uses the injected clock and expires after a day', async (t) => {
  let clock = NOW;
  const { tell, todos } = setup(t, { clock: () => clock, plan: { actions: [{ kind: 'todo.add', text: 'Keep me' }] } });
  const p = await tell.create({ text: 'x', wait: 5000 });
  await tell.apply(p.id, { picks: [{ i: 0 }] });
  clock += 24 * 3600e3 + 1;
  await assert.rejects(tell.undo(p.id, 0), /more than a day/);
  assert.equal((await todos.read()).todos.length, 1);
});

test('local dates reject impossible days, times and the spring DST gap', () => {
  for (const s of ['2026-02-29', '2026-02-31', '2026-00-01', '2026-13-01', '2026-10-00', '2026-10-09T24:00', '2026-10-09T12:60', '2026-03-29T01:30']) assert.equal(parseLocal(s), null, s);
  assert.equal(localStamp(parseLocal('2028-02-29')), '2028-02-29T09:00');
  for (const s of ['2026-03-29T00:30', '2026-03-29T02:30', '2026-10-25T00:30', '2026-10-25T02:30']) assert.equal(localStamp(parseLocal(s)), s);
});

test('CLI timeout and output limit kill the process group and wait for close', async () => {
  const { runClaudeCli } = require('../tell');
  const { EventEmitter } = require('node:events');
  const children = [], signals = [], callbacks = new Map(); let next = 0;
  const timers = { setTimeout(fn) { const timer = { id: ++next, unref() {} }; callbacks.set(timer.id, fn); return timer; }, clearTimeout(timer) { callbacks.delete(timer?.id); } };
  const spawnChild = () => {
    const child = new EventEmitter(); child.pid = 77 + children.length;
    child.stdin = new EventEmitter(); child.stdin.end = () => {};
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child;
  };
  const p = runClaudeCli({ args: [], input: 'fake', spawnChild, timers, kill: (...args) => signals.push(args) });
  let settled = false; p.catch(() => { settled = true; }); callbacks.get(1)(); await Promise.resolve();
  assert.equal(settled, false); assert.deepEqual(signals[0], [-77, 'SIGTERM']); callbacks.get(2)(); assert.deepEqual(signals[1], [-77, 'SIGKILL']);
  children[0].emit('close', null); await assert.rejects(p, /too long/); assert.equal(callbacks.size, 0);
  const p2 = runClaudeCli({ args: [], input: 'fake', spawnChild, timers, maxBytes: 10, kill: (...args) => signals.push(args) });
  children[1].stdout.emit('data', Buffer.alloc(11)); assert.deepEqual(signals[2], [-78, 'SIGTERM']);
  children[1].emit('close', null); await assert.rejects(p2, /too large/); assert.equal(callbacks.size, 0);
});
