'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSources, createRefresh } = require('../refresh');
const { workContext } = require('../process-runner');

const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fakeClock() {
  let time = 1000, id = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) { const key = ++id; pending.set(key, { fn, at: time + ms }); return key; },
    clearTimeout(key) { pending.delete(key); },
  };
  return { now: () => time, timers, async advance(ms) {
    const target = time + ms;
    while (true) {
      const first = [...pending.entries()].filter(([, p]) => p.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      time = first[1].at; pending.delete(first[0]); first[1].fn(); await turn();
    }
    time = target; await turn();
  } };
}

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('freshness records success, cache hits, failure with retained data and recovery', async () => {
  const clock = fakeClock(), sources = createSources(clock);
  const first = { events: ['meeting'] };
  assert.equal(await sources.collect('calendar', async () => { await clock.advance(20); return first; }), first);
  assert.deepEqual(sources.snapshot().calendar, { lastAttempt: 1000, lastSuccess: 1020, durationMs: 20, error: null, stale: false });
  await clock.advance(3000);
  assert.equal(await sources.collect('calendar', () => first, { cached: true }), first);
  assert.equal(sources.snapshot().calendar.lastSuccess, 1020);
  assert.equal(sources.snapshot().calendar.lastAttempt, 1000);
  assert.equal(await sources.collect('calendar', () => { throw new Error('offline'); }), first);
  assert.deepEqual(sources.snapshot().calendar, { lastAttempt: 4020, lastSuccess: 1020, durationMs: 0, error: 'offline', stale: true });
  await sources.collect('calendar', () => ({ events: [] }));
  assert.equal(sources.snapshot().calendar.stale, false);
  assert.equal(sources.snapshot().calendar.lastSuccess, 4020);
});

test('empty failure is erroring but is not described as a last-good copy', async () => {
  const sources = createSources(fakeClock());
  assert.deepEqual(await sources.collect('board', () => { throw Error('unreadable'); }, { fallback: { cards: [] } }), { cards: [] });
  assert.equal(sources.snapshot().board.lastSuccess, null);
  assert.equal(sources.snapshot().board.stale, false);
});

test('a hung collector is aborted once, stays single-flight and stops consuming later budgets', async () => {
  const clock = fakeClock(), sources = createSources(clock), job = deferred();
  let calls = 0, signal;
  const fn = () => { calls++; signal = workContext.getStore().signal; return job.promise; };
  const pending = sources.collect('board', fn, { deadline: 1100, fallback: ['old'], retained: true });
  await turn(); await clock.advance(100);
  assert.deepEqual(await pending, ['old']); assert.equal(signal.aborted, true);
  assert.deepEqual(await sources.collect('board', fn, { deadline: 1200, fallback: ['old'], retained: true }), ['old']);
  assert.equal(clock.now(), 1100); assert.equal(calls, 1);
  assert.match(sources.snapshot().board.error, /still running/);
  job.resolve(['late']); await turn();
  assert.equal(sources.snapshot().board.lastSuccess, null);
  assert.deepEqual(await sources.collect('board', () => ['fresh']), ['fresh']);
  assert.equal(sources.snapshot().board.stale, false);
});

test('all successive phases share a deadline, expired phases never start', async () => {
  const clock = fakeClock(), sources = createSources(clock);
  const deadline = clock.now() + 15000;
  await sources.collect('phase1', async () => { await clock.advance(14000); return 1; }, { deadline });
  const pending = sources.collect('phase2', () => new Promise(() => {}), { deadline, fallback: 2 });
  await turn(); await clock.advance(1000); assert.equal(await pending, 2);
  let calls = 0;
  assert.equal(await sources.collect('phase3', () => { calls++; return 3; }, { deadline, fallback: 4 }), 4);
  assert.equal(calls, 0); assert.equal(clock.now(), 16000);
  assert.equal(sources.snapshot().phase3.lastAttempt, null);
});

test('a burst during a refresh queues exactly one immediate rerun and every caller waits for it', async () => {
  const first = deferred(); let calls = 0, record = 'before', value;
  const refresh = createRefresh(async () => { calls++; value = record; if (calls === 1) await first.promise; return value; });
  const p = refresh(); await turn(); record = 'after mutation';
  for (let i = 0; i < 100; i++) assert.equal(refresh(), p);
  let completed = false; p.then(() => { completed = true; }); await turn(); assert.equal(completed, false);
  first.resolve(); assert.equal(await p, 'after mutation'); assert.equal(calls, 2);
  assert.equal(await refresh(), 'after mutation'); assert.equal(calls, 3);
});

test('requests during the rerun queue one further pass, rejection frees the flight', async () => {
  const blocks = [deferred(), deferred()]; let calls = 0;
  const refresh = createRefresh(async () => { const n = calls++; if (blocks[n]) await blocks[n].promise; return calls; });
  const p = refresh(); await turn(); refresh(); blocks[0].resolve(); await turn();
  refresh(); refresh(); blocks[1].resolve(); assert.equal(await p, 3);
  let fails = true;
  const recover = createRefresh(() => { if (fails) throw Error('failed'); return 1; });
  await assert.rejects(recover(), /failed/); fails = false; assert.equal(await recover(), 1);
});

module.exports = { fakeClock, turn };
