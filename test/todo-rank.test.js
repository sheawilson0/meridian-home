'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRanker, clampReason, inboxTodos, buildPrompt, rankables } = require('../todo-rank');

const NOW = Date.parse('2026-10-05T13:00:00Z'); // Mon 5 Oct 2026, 14:00 in London

function baseState() {
  return {
    todos: [
      { id: 'a1', title: 'Finish unpacking', note: '', priority: 'next', done: false, created: '2026-10-04T10:00:00Z' },
      { id: 'b2', title: 'Email Rowan the expenses claim', note: 'For Monday', priority: 'now', done: false },
      { id: 'c3', title: 'Old thing', done: true },
    ],
    projects: { projects: [
      { id: 'p1', title: 'Point tips link to DEMO', brief: true, status: 'inbox', priority: 'high', sourceFrom: 'Avery Morgan', source: 'outlook' },
      { id: 'p2', title: 'Already done', brief: true, status: 'inbox', priority: 'normal' },
      { id: 'p3', title: 'Not a brief item', status: 'inbox' },
      { id: 'p4', title: 'Skipped today', brief: true, status: 'inbox' },
    ] },
    briefFeedback: { completed: ['project:p2'], rejected: [], skipped: { '2026-10-05': ['project:p4'] } },
    briefIntake: { items: [{ projectId: 'p1', from: 'Avery Morgan', summary: 'Update the support link', receivedAt: '2026-10-01T14:12:24Z' }] },
    calendar: { events: [
      { ts: NOW + 4 * 3600e3, end: NOW + 6 * 3600e3, title: 'Flight BFS to LGW', location: 'Belfast City' },
      { ts: NOW + 5 * 86400e3, title: 'Far away', end: NOW + 5 * 86400e3 + 3600e3 },
    ] },
    deadlines: [{ id: 'd1', title: 'COURSE101 seminar', due: '2026-10-06', track: 'uni', done: false }],
  };
}

function setup(t, { reply, state = baseState(), ...opts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-rank-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let clock = NOW;
  const runClaude = async (o) => {
    calls.push(o);
    const r = typeof reply === 'function' ? await reply(o, calls.length) : reply;
    if (r instanceof Error) throw r;
    return r;
  };
  const s = { value: state };
  const ranker = createRanker({ dir, getState: () => s.value, runClaude, now: () => clock, debounceMs: 5, minGapMs: 0, ...opts });
  return { dir, calls, ranker, s, tick: (ms) => { clock += ms; } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (items) => items.map((x) => x.id);

test('inbox to-dos mirror briefTodos: brief, not done, not hidden by feedback', () => {
  const inbox = inboxTodos(baseState(), NOW);
  assert.deepEqual(ids(inbox), ['p1']);
  assert.equal(inbox[0].from, 'Avery Morgan');
  assert.equal(inbox[0].summary, 'Update the support link');
});

test('prompt carries the time, refs, calendar within 72 hours and deadlines', () => {
  const state = baseState();
  const items = rankables(state, NOW);
  const p = buildPrompt({ state, now: NOW, items, notes: 'Jordan is my boss.', learning: { senders: [{ from: 'Avery Morgan', weight: 'raise', acted: 5, decided: 5 }, { from: 'Nobody', weight: 'neutral' }] } });
  assert.match(p, /Monday 5 October 2026, 14:00/);
  assert.match(p, /T1 · Finish unpacking/);
  assert.match(p, /I1 · Point tips link to DEMO · from Avery Morgan/);
  assert.match(p, /Mon 5 Oct 18:00–20:00 · Flight BFS to LGW · Belfast City/);
  assert.doesNotMatch(p, /Far away/);
  assert.match(p, /2026-10-06 \(Tue 6 Oct\) · COURSE101 seminar/);
  assert.match(p, /Avery Morgan: raise \(acted on 5 of 5\)/);
  assert.doesNotMatch(p, /Nobody/);
  assert.match(p, /Jordan is my boss/);
  assert.doesNotMatch(p, /Old thing|Already done|Skipped today|Not a brief item/);
});

test('ranks in the model order, drops unknown ids, appends missing ones as later', async (t) => {
  const { ranker, calls } = setup(t, { reply: { items: [
    { id: 'I1', urgency: 'today', reason: 'Avery asked on 1 Oct' },
    { id: 'T9', urgency: 'now', reason: 'Not a real ref' },
    { id: 'T1', urgency: 'now', reason: 'Flight at 18:00, so pack before you leave.' },
    { id: 'I1', urgency: 'later', reason: 'Duplicate' },
    { id: 'T1', urgency: 'bogus', reason: 'dup' },
  ] } });
  const out = await ranker.refresh();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--json-schema'));
  assert.deepEqual(ids(out.items), ['p1', 'a1', 'b2']);
  assert.deepEqual(out.items.map((x) => x.urgency), ['today', 'now', 'later']);
  assert.equal(out.items[1].reason, 'Flight at 18:00, so pack before you leave');
  assert.equal(out.items[2].reason, '');
  assert.equal(out.items[0].kind, 'inbox');
  assert.equal(out.error, null);
  assert.equal(out.running, false);
});

test('reasons are clamped to 70 characters at a word', () => {
  const long = 'Avery needs this before Thursday launch and Jordan also asked about it twice last week';
  const r = clampReason(long);
  assert.ok(r.length <= 70, r.length);
  assert.ok(r.endsWith('…'));
  assert.doesNotMatch(r, /\s…$/);
  assert.equal(clampReason('  Short one.  '), 'Short one');
});

test('caches by signature: no second call when nothing changed, and survives a restart', async (t) => {
  const { ranker, calls, dir, s } = setup(t, { reply: { items: [{ id: 'T1', urgency: 'now', reason: 'x' }] } });
  await ranker.refresh();
  assert.equal(calls.length, 1);
  ranker.maybeRefresh(); await wait(30);
  assert.equal(calls.length, 1);
  // A fresh ranker reads the saved file and doesn't run either.
  const again = createRanker({ dir, getState: () => s.value, runClaude: async () => { calls.push('again'); return { items: [] }; }, now: () => NOW, debounceMs: 5, minGapMs: 0 });
  assert.equal(again.peek().items.length, 3);
  again.maybeRefresh(); await wait(30);
  assert.equal(calls.length, 1);
  // A title change does trigger a run, after the debounce.
  s.value = { ...s.value, todos: s.value.todos.map((x) => x.id === 'a1' ? { ...x, title: 'Pack' } : x) };
  ranker.maybeRefresh(); await wait(40);
  assert.equal(calls.length, 2);
});

test('reruns when the result is older than an hour, and when the notes file changes', async (t) => {
  const { ranker, calls, tick, dir } = setup(t, { reply: { items: [] } });
  await ranker.refresh();
  tick(30 * 60e3); ranker.maybeRefresh(); await wait(30);
  assert.equal(calls.length, 1);
  tick(31 * 60e3); ranker.maybeRefresh();
  for (let i = 0; i < 100 && (!ranker.peek() || ranker.peek().at !== NOW + 61 * 60e3); i++) await wait(10);
  assert.equal(calls.length, 2);
  const notes = path.join(dir, 'todo-rank-notes.md');
  assert.match(fs.readFileSync(notes, 'utf8'), /^<!--/);
  fs.writeFileSync(notes, 'Jordan is my boss.\n');
  fs.utimesSync(notes, new Date(), new Date(Date.now() + 5000));
  ranker.maybeRefresh();
  for (let i = 0; i < 100 && calls.length < 3; i++) await wait(10);
  assert.equal(calls.length, 3);
  assert.match(calls[2].input, /Jordan is my boss/);
  assert.doesNotMatch(calls[2].input, /This comment is not sent/);
});

test('a burst of edits makes one run, and never two at once', async (t) => {
  let inFlight = 0; let maxInFlight = 0;
  const { ranker, calls, s } = setup(t, { debounceMs: 20, reply: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await wait(40); inFlight--; return { items: [] }; } });
  for (let i = 0; i < 5; i++) { s.value = { ...s.value, todos: [...s.value.todos, { id: 'n' + i, title: 'New ' + i }] }; ranker.maybeRefresh(); await wait(2); }
  await wait(50);
  assert.equal(calls.length, 1);
  assert.equal(ranker.peek().running, true);
  // A forced refresh while running waits for it, then runs once more on its own.
  const [a, b] = await Promise.all([ranker.refresh(), ranker.refresh()]);
  assert.equal(maxInFlight, 1);
  assert.equal(a.running, false); assert.equal(b.running, false);
  assert.ok(calls.length <= 3);
});

test('at most one run per gap', async (t) => {
  const { ranker, calls, s } = setup(t, { minGapMs: 60e3, reply: { items: [] } });
  await ranker.refresh();
  s.value = { ...s.value, todos: [...s.value.todos, { id: 'z', title: 'Z' }] };
  ranker.maybeRefresh(); await wait(40);
  assert.equal(calls.length, 1); // the gap hasn't passed (the clock is frozen)
});

test('an error keeps the previous items and records the error', async (t) => {
  let fail = false;
  const { ranker, calls } = setup(t, { reply: () => (fail ? new Error('the agent took too long') : { items: [{ id: 'T2', urgency: 'now', reason: 'Rowan needs it Monday' }] }) });
  const first = await ranker.refresh();
  assert.deepEqual(ids(first.items), ['b2', 'a1', 'p1']);
  fail = true;
  const second = await ranker.refresh();
  assert.equal(calls.length, 2);
  assert.deepEqual(second.items, first.items);
  assert.equal(second.error.message, 'the agent took too long');
  assert.equal(second.at, first.at);
});

test('an empty list never calls the model', async (t) => {
  const { ranker, calls } = setup(t, { state: { todos: [] }, reply: { items: [] } });
  const out = await ranker.refresh();
  assert.equal(calls.length, 0);
  assert.deepEqual(out.items, []);
});

test('an edit during a running rank is reranked once that run settles', async (t) => {
  let release, completed;
  const held = new Promise(resolve => { release = resolve; });
  const reranked = new Promise(resolve => { completed = resolve; });
  const { ranker, calls, s } = setup(t, {
    reply: async (_o, n) => { if (n === 1) await held; return { items: [] }; },
    onChange: () => { if (calls.length === 2) completed(); },
  });
  const first = ranker.refresh();
  for (let i = 0; i < 300 && !calls.length; i++) await wait(10);
  assert.equal(calls.length, 1);
  s.value = { ...s.value, todos: [{ id: 'later', title: 'Added during the run', done: false }] };
  ranker.maybeRefresh();
  release(); await first;
  let timer;
  try { await Promise.race([reranked, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('edit was never reranked')), 5000); })]); } finally { clearTimeout(timer); }
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /Added during the run/);
});

test('source freshness records ranking failures and a hung injected runner never overlaps', async t => {
  let fail = false;
  const normal = setup(t, { reply: () => fail ? Error('offline') : { items: [] } });
  await normal.ranker.refresh(); assert.equal(normal.ranker.source().lastSuccess, NOW); assert.equal(normal.ranker.source().stale, false);
  normal.tick(100); fail = true; await normal.ranker.refresh();
  assert.equal(normal.ranker.source().lastAttempt, NOW + 100); assert.equal(normal.ranker.source().lastSuccess, NOW); assert.equal(normal.ranker.source().error, 'offline'); assert.equal(normal.ranker.source().stale, true);
  let expire, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hung = setup(t, { reply: () => { entered(); return new Promise(() => {}); }, sourceTimers: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} } });
  const p = hung.ranker.refresh(); await waiting; hung.tick(92000); expire(); await p;
  assert.equal(hung.ranker.source().durationMs, 92000); assert.match(hung.ranker.source().error, /budget/);
  await hung.ranker.refresh(); assert.equal(hung.calls.length, 1); assert.match(hung.ranker.source().error, /still running/);
});
