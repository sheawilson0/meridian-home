'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProcessRunner, capProcess } = require('../process-runner');

function clock() {
  let time = 0, id = 0; const tasks = new Map();
  const timers = { setTimeout(fn, ms) { const t = { id: ++id, unref() {} }; tasks.set(t, { fn, at: time + ms }); return t; }, clearTimeout(t) { tasks.delete(t); } };
  return { timers, advance(ms) { time += ms; for (const [t, job] of [...tasks]) if (job.at <= time) { tasks.delete(t); job.fn(); } }, size: () => tasks.size };
}

test('wall-clock cap kills the detached process group, completion still waits for the runner', async () => {
  const c = clock(), signals = []; let callback, options;
  const run = createProcessRunner({ timers: c.timers, platform: 'darwin', execute: (_file, _args, opts, cb) => { options = opts; callback = cb; return { pid: 123 }; }, kill: (...args) => signals.push(args) });
  const p = run('fake', [], { timeout: 100 }); let settled = false; p.catch(() => { settled = true; });
  c.advance(100); await Promise.resolve(); assert.equal(settled, false);
  assert.deepEqual(signals, [[-123, 'SIGKILL']]); assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.detached, true);
  callback(Object.assign(Error('killed'), { signal: 'SIGKILL' }), '', ''); await assert.rejects(p, /killed/);
  assert.equal(c.size(), 0);
});

test('collector cancellation kills a group; completed work removes abort and timeout handlers', async () => {
  const c = clock(), signals = []; let callback;
  const run = createProcessRunner({ timers: c.timers, execute: (_f, _a, _o, cb) => { callback = cb; return { pid: 321 }; }, platform: 'darwin', kill: (...args) => signals.push(args) });
  const controller = new AbortController(), p = run('fake', [], { signal: controller.signal });
  callback(null, 'ok', ''); assert.equal((await p).stdout, 'ok'); controller.abort(); c.advance(9000); assert.deepEqual(signals, []);
  const second = new AbortController(), p2 = run('fake', [], { signal: second.signal }); second.abort(); assert.deepEqual(signals, [[-321, 'SIGKILL']]);
  callback(Error('cancelled')); await assert.rejects(p2, /cancelled/);
});

test('spawned jobs escalate TERM to KILL and close cancels both timers', () => {
  const c = clock(), child = new EventEmitter(), signals = []; child.pid = 44;
  let timeouts = 0;
  capProcess(child, { timeout: 100, graceMs: 20, detached: true, platform: 'darwin', timers: c.timers, kill: (...args) => signals.push(args), onTimeout: () => timeouts++ });
  c.advance(100); assert.deepEqual(signals, [[-44, 'SIGTERM']]); c.advance(20); assert.deepEqual(signals[1], [-44, 'SIGKILL']); assert.equal(timeouts, 1);
  child.emit('close'); assert.equal(c.size(), 0);
  const next = new EventEmitter(); next.pid = 45;
  capProcess(next, { timeout: 100, timers: c.timers, detached: true, kill: (...args) => signals.push(args) }); next.emit('close'); c.advance(200); assert.equal(signals.length, 2);
});

test('a real subprocess that ignores TERM is stopped at its wall-clock cap', async () => {
  const run = createProcessRunner();
  await assert.rejects(run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeout: 100 }), error => error.signal === 'SIGKILL');
});
