'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const port = Number(process.env.MERIDIAN_TEST_PORT || 5135);
const todoId = '00000000-0000-0000-0000-000000000001';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(25); }
  throw new Error('fixture condition timed out');
}
function request(route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-delegation-'));
  await fs.chmod(dir, 0o700);
  const data = path.join(dir, 'data'), workspace = path.join(dir, 'workspace');
  await fs.mkdir(data); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'example.txt'), 'Before\n');
  await fs.writeFile(path.join(data, 'todos.json'), JSON.stringify({ todos: [{ id: todoId, title: 'Fixture task', when: 'now' }] }));
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ machine: 'Fixture', calendar: {}, vaultInbox: path.join(dir, 'inbox') }));
  const children = [], agentPids = new Set();
  let daemon;
  async function stop(signal = 'SIGTERM') {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill(signal);
    if (daemon) await daemon.closed;
  }
  t.after(async () => {
    for (const pid of agentPids) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.closed));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function boot() {
    daemon = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/delegation-sandbox.cjs'), path.join(repo, 'server.js')], {
      cwd: repo, env: { ...process.env, MERIDIAN_SANDBOX: '1', MERIDIAN_JOBS: 'off', MERIDIAN_PORT: String(port), MERIDIAN_DATA: data, MERIDIAN_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(daemon);
    daemon.closed = new Promise(resolve => daemon.once('close', resolve));
    let output = '', errors = '';
    daemon.stdout.on('data', c => { output += c; }); daemon.stderr.on('data', c => { errors += c; });
    await until(() => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('fixture boot failed: ' + errors);
      return output.includes(`127.0.0.1:${port}`);
    });
  }
  const meta = async id => JSON.parse(await fs.readFile(path.join(dir, 'delegations', id, 'meta.json'), 'utf8'));
  const report = id => path.join(dir, 'delegations', id, 'REPORT.md');
  async function start(plan, feedback = false) {
    await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan));
    const reply = await request(feedback ? '/api/feedback' : `/api/todos/${todoId}/delegate`, feedback ? { text: 'Fixture fix' } : {});
    assert.equal(reply.status, 200, JSON.stringify(reply.value));
    const id = reply.value.id;
    agentPids.add((await meta(id)).pid);
    let pid;
    try { pid = await until(() => fs.readFile(report(id) + '.ready', 'utf8').catch(() => null)); }
    catch (error) { throw new Error(error.message + ': ' + await fs.readFile(path.join(dir, 'delegations', id, 'run.log'), 'utf8')); }
    agentPids.add(Number(pid));
    return id;
  }
  async function state() {
    assert.equal((await request('/api/refresh', {})).status, 200);
    return (await request('/api/state')).value;
  }
  await boot();
  return { dir, workspace, boot, stop, start, meta, report, state, agentPids };
}

test('sandbox Node children persist missing reports, successful reports, nonzero exits and signals across restart', async t => {
  const f = await fixture(t);
  assert.equal((await request('/api/notify/test', {})).status, 503);
  for (const [plan, status, code, signal] of [
    [{ code: 0 }, 'failed', 0, null], [{ code: 7 }, 'failed', 7, null],
    [{ reportBefore: true, hold: true }, 'done', 0, null],
    [{ reportAfter: true, code: 7 }, 'failed', 7, null],
    [{ reportBefore: true, signal: 'SIGTERM' }, 'failed', null, 'SIGTERM'],
  ]) {
    const id = await f.start(plan);
    if (plan.hold) {
      const running = await f.state();
      assert.equal(running.delegations.runs.find(r => r.id === id).status, 'running');
      assert.equal(running.todos[0].delegation.status, 'running');
      await fs.writeFile(f.report(id) + '.release', 'release');
    }
    const receipt = await until(async () => { const m = await f.meta(id); return m.finishedAt != null && m; });
    assert.equal(receipt.status, status); assert.equal(receipt.exitCode, code); assert.equal(receipt.signal, signal);
    assert.equal(receipt.result.report, plan.reportBefore || plan.reportAfter ? 'REPORT.md' : null);
    assert.equal(receipt.todoId, todoId); assert.equal(receipt.lifecycleVersion, 1);
    f.agentPids.delete(receipt.pid);
    if (!plan.reportBefore && !plan.reportAfter && code === 0) assert.match(receipt.error, /without writing REPORT/);
    await f.stop(); await f.boot();
    const s = await f.state();
    assert.equal(s.delegations.runs.find(r => r.id === id).status, status);
    assert.equal(s.todos[0].delegation.status, status);
    assert.deepEqual(await f.meta(id), receipt);
  }
});

test('sandbox cancellation survives restart, retains its report and records forced termination', async t => {
  const f = await fixture(t);
  const id = await f.start({ reportBefore: true, hold: true, ignoreTerm: true });
  assert.equal((await request(`/api/delegations/${id}/cancel`, {})).status, 200);
  const receipt = await until(async () => { const m = await f.meta(id); return m.finishedAt != null && m; });
  assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.signal, 'SIGKILL');
  assert.equal(receipt.result.status, 'cancelled'); assert.equal(receipt.result.report, 'REPORT.md');
  f.agentPids.delete(receipt.pid);
  await f.stop(); await f.boot();
  assert.equal((await f.state()).todos[0].delegation.status, 'cancelled');
  assert.deepEqual(await f.meta(id), receipt);
});

test('a daemon killed mid-run keeps the orphan running, then stalls honestly and syncs its to-do without inventing an exit receipt', async t => {
  const f = await fixture(t);
  for (const reportAfter of [false, true]) {
    const id = await f.start({ hold: true, reportAfter });
    const before = await f.meta(id);
    await f.stop('SIGKILL'); await f.boot();
    assert.equal((await f.state()).todos[0].delegation.status, 'running');
    await fs.writeFile(f.report(id) + '.release', 'release');
    await until(() => { try { process.kill(before.pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') throw e; return true; } });
    f.agentPids.delete(before.pid);
    // Advance just the fixture log's age instead of sleeping for six minutes.
    const old = new Date(Date.now() - 7 * 60000);
    await fs.utimes(path.join(f.dir, 'delegations', id, 'run.log'), old, old);
    const s = await f.state();
    assert.equal(s.delegations.runs.find(r => r.id === id).status, 'stalled');
    assert.equal(s.todos[0].delegation.status, 'stalled');
    const after = await f.meta(id);
    assert.equal(after.finishedAt, undefined); assert.equal(after.exitCode, undefined);
    assert.equal(after.result, undefined); assert.equal(after.title, before.title); assert.equal(after.pid, before.pid);
    await f.stop(); await f.boot();
    assert.equal((await f.state()).todos[0].delegation.status, 'stalled');
  }
});

test('feedback changes and Undo survive a sandbox restart and preserve newer edits', async t => {
  const f = await fixture(t);
  const id = await f.start({ reportAfter: true, edit: true }, true);
  await until(async () => (await f.meta(id)).finishedAt);
  f.agentPids.delete((await f.meta(id)).pid);
  await until(async () => (await f.state()).delegations.runs.find(r => r.id === id).undoable);
  assert.equal(await fs.readFile(path.join(f.workspace, 'example.txt'), 'utf8'), 'After\n');
  await f.stop(); await f.boot();
  assert.equal((await f.state()).delegations.runs.find(r => r.id === id).undoable, true);
  const undo = await request(`/api/delegations/${id}/undo`, {});
  assert.equal(undo.status, 200); assert.deepEqual(undo.value.restored, ['example.txt']);
  assert.equal(await fs.readFile(path.join(f.workspace, 'example.txt'), 'utf8'), 'Before\n');
  const undoneAt = (await f.meta(id)).undoneAt;
  await f.stop(); await f.boot();
  assert.equal((await f.state()).delegations.runs.find(r => r.id === id).undoneAt, undoneAt);
  assert.equal((await request(`/api/delegations/${id}/undo`, {})).status, 409);
  const second = await f.start({ reportAfter: true, edit: true }, true);
  await until(async () => (await f.state()).delegations.runs.find(r => r.id === second).undoable);
  f.agentPids.delete((await f.meta(second)).pid);
  await fs.writeFile(path.join(f.workspace, 'example.txt'), 'Owner edit\n');
  assert.equal((await request(`/api/delegations/${second}/undo`, {})).status, 409);
  assert.equal(await fs.readFile(path.join(f.workspace, 'example.txt'), 'utf8'), 'Owner edit\n');
});

test('an older run outside the display slice and an archived run still update their to-do after restart', async t => {
  const f = await fixture(t);
  const id = await f.start({ hold: true, reportAfter: true });
  const meta = await f.meta(id);
  for (let i = 0; i < 9; i++) {
    const dir = path.join(f.dir, 'delegations', 'newer-' + i); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ started: meta.started + i + 1, finishedAt: 1, exitCode: 0, status: 'done', result: { status: 'done' } }));
  }
  await fs.writeFile(f.report(id) + '.release', 'release');
  await until(async () => (await f.meta(id)).finishedAt);
  f.agentPids.delete((await f.meta(id)).pid);
  await f.stop(); await f.boot();
  const s = await f.state();
  assert.equal(s.delegations.runs.length, 8); assert.equal(s.delegations.runs.some(r => r.id === id), false);
  assert.equal(s.todos[0].delegation.status, 'done');
  await fs.writeFile(path.join(f.dir, 'delegations', id, 'meta.json'), JSON.stringify({ ...await f.meta(id), archivedAt: Date.now() }));
  const todosFile = path.join(f.dir, 'data', 'todos.json');
  const todos = JSON.parse(await fs.readFile(todosFile)); todos.todos[0].delegation.status = 'running';
  await fs.writeFile(todosFile, JSON.stringify(todos));
  await f.stop(); await f.boot();
  assert.equal((await f.state()).todos[0].delegation.status, 'done');
});

test('the delegation preload refuses normal boot even with fixture paths', async t => {
  const f = await fixture(t); await f.stop();
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/delegation-sandbox.cjs'), '-e', ''], {
    env: { ...process.env, MERIDIAN_SANDBOX: '0', MERIDIAN_DATA: path.join(f.dir, 'data'), MERIDIAN_CONFIG: path.join(f.dir, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = ''; child.stderr.on('data', c => { errors += c; });
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 1);
  assert.match(errors, /requires an isolated sandbox test/);
});
