'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createResultRecorder, resultStatus } = require('../delegation-results');

test('explicit results win over report/log heuristics; old records retain their behaviour', () => {
  assert.equal(resultStatus({ lifecycleVersion: 1, status: 'running' }, { hasReport: true, now: 1000000, logM: 1000000 }), 'running');
  assert.equal(resultStatus({ finishedAt: 10, exitCode: 1, signal: null }, { hasReport: true, logM: 10, now: 10 }), 'failed');
  assert.equal(resultStatus({ finishedAt: 10, result: { status: 'done' } }, { hasReport: false }), 'done');
  assert.equal(resultStatus({ status: 'cancelled', finishedAt: 10, exitCode: 0 }, { hasReport: true }), 'cancelled');
  assert.equal(resultStatus({}, { hasReport: true }), 'done');
  assert.equal(resultStatus({}, { now: 1000000, logM: 1000000 }), 'running');
  assert.equal(resultStatus({}, { now: 1000000 }), 'stalled');
});

test('exit receipt persists code, signal, result and finish time atomically, retaining cancellation and metadata', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mer-result-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const record = createResultRecorder({ now: () => 1234 });
  for (const [id, code, signal, report, status] of [['success', 0, null, true, 'done'], ['partial', 2, null, true, 'failed'], ['no-report', 0, null, false, 'failed'], ['signal', null, 'SIGKILL', false, 'failed'], ['cancelled', null, 'SIGTERM', true, 'cancelled']]) {
    const run = path.join(dir, id); await fs.mkdir(run);
    await fs.writeFile(path.join(run, 'meta.json'), JSON.stringify({ status: id === 'cancelled' ? 'cancelled' : 'running', title: 'Kept', lifecycleVersion: 1 }));
    if (report) await fs.writeFile(path.join(run, 'REPORT.md'), 'finished report');
    const meta = await record(run, code, signal);
    assert.equal(meta.status, status); assert.equal(meta.exitCode, code); assert.equal(meta.signal, signal); assert.equal(meta.finishedAt, 1234);
    assert.equal(meta.result.status, status); assert.equal(meta.result.report, report ? 'REPORT.md' : null); assert.equal(meta.title, 'Kept');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(run, 'meta.json'))), meta);
    assert.deepEqual(await record(run, 99, 'SIGINT'), meta);
    assert.equal((await fs.readdir(run)).some(f => f.endsWith('.tmp')), false);
  }
});

// Exercise the daemon's real registry and launch hooks with synthetic records
// and a child emitter. No agent CLI or live job is started.
const vm = require('node:vm');
const syncFs = require('node:fs');
const { EventEmitter } = require('node:events');
const serverSource = syncFs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const section = (from, to) => serverSource.slice(serverSource.indexOf(from), serverSource.indexOf(to, serverSource.indexOf(from)));
async function daemon(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mer-registry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queues = new Map();
  const ctx = vm.createContext({ fs: syncFs, fsp: fs, path, process: { platform: process.platform, env: {}, kill() { throw Object.assign(Error('gone'), { code: 'ESRCH' }); } },
    ROOT: root, STORAGE_ROOT: root, DATA_DIR: path.join(root, 'data'), HOME: root, CONFIG: {}, sandboxDelegations: null,
    createResultRecorder, resultStatus, console, setTimeout, runtime: { portableProfile: () => false }, defaultModelLabel: () => 'Fake', state: { at: 0 },
    runChanges: { hasSnapshot: () => false, readChanges: () => null },
    queueFile(file, fn) { const next = (queues.get(file) || Promise.resolve()).catch(() => {}).then(fn); queues.set(file, next); return next; },
    writeJsonAtomic: async (file, value) => { await fs.writeFile(file + '.tmp', JSON.stringify(value)); await fs.rename(file + '.tmp', file); },
    ...extra,
  });
  vm.runInContext(section('function pidAlive(', '// ---------------------------------------------------------------- pulse (today\'s activity)') +
    section('async function syncTodoDelegations(', '// ---------------------------------------------------------------- journal → vault') +
    '\nthis.registry = delegationRegistry;', ctx);
  return { root, ctx };
}

test('the display stays at eight newest while an older archived to-do run still syncs', async t => {
  const todos = [{ id: 'todo', delegation: { id: 'run0', status: 'running' } }];
  const { root, ctx } = await daemon(t, { todosStore: { read: async () => ({ todos }), sort: x => x, update: async (_id, patch) => Object.assign(todos[0], patch) } });
  const dir = path.join(root, 'delegations'); await fs.mkdir(dir);
  for (let i = 0; i < 11; i++) {
    const run = path.join(dir, 'run' + i); await fs.mkdir(run);
    await fs.writeFile(path.join(run, 'meta.json'), JSON.stringify({ started: i + 1, status: 'done', finishedAt: 10, exitCode: 0, result: { status: 'done' }, archivedAt: i === 0 ? 20 : null }));
  }
  const display = await ctx.collectDelegations(); assert.equal(display.runs.length, 8); assert.equal(display.runs[0].id, 'run10');
  assert.equal(ctx.registry.size, 11); assert.equal(display.runs.some(r => r.id === 'run0'), false);
  await ctx.syncTodoDelegations(display); assert.equal(todos[0].delegation.status, 'done');
});

test('the launch exit hook records a receipt and requests refresh; REPORT.md alone is not done', async t => {
  let child, refreshed;
  const finished = new Promise(resolve => { refreshed = resolve; });
  const { root, ctx } = await daemon(t, { EFFORTS: ['high'], CODEX_BIN: 'fake', CLAUDE_BIN: 'fake', slugify: text => text.toLowerCase(),
    resolveEngine: () => ({ kind: 'codex', who: 'Fake', id: 'fake', model: 'fake', effort: 'high' }),
    refreshState: async () => refreshed(), spawn() {
      child = new EventEmitter(); child.pid = 123; child.unref = () => {};
      child.stdin = new EventEmitter(); child.stdin.end = () => child.emit('spawn'); return child;
    },
  });
  const id = await ctx.startDelegation(null, 'Task', 'fake', null, { card: 'Make a plan', todoId: 'todo' });
  const run = path.join(root, 'delegations', id); await fs.writeFile(path.join(run, 'REPORT.md'), 'Early report');
  assert.equal((await ctx.collectDelegations()).runs[0].status, 'running');
  child.emit('exit', 0, null); await finished;
  const meta = JSON.parse(await fs.readFile(path.join(run, 'meta.json')));
  assert.equal(meta.status, 'done'); assert.equal(meta.exitCode, 0); assert.equal(meta.signal, null); assert.equal(typeof meta.finishedAt, 'number'); assert.equal(meta.todoId, 'todo');
  assert.equal((await ctx.collectDelegations()).runs[0].finished, meta.finishedAt);
});
