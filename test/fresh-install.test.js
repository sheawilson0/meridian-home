'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { request, repo } = require('./helpers/sandbox-server.cjs');
const fixturePort = Number(process.env.MERIDIAN_TEST_PORT || process.env.MERIDIAN_TEST_PORT_BASE || 5190) + 4;

async function boot(root, { demo = false, jobs = 'on', config, port = fixturePort } = {}) {
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/isolate.cjs'),
    '--require', path.join(__dirname, 'sandbox-probe.cjs'), path.join(repo, 'server.js')], {
    cwd: repo, env: { PATH: '', HOME: path.join(root, 'home'), TMPDIR: root,
      MERIDIAN_UNIT_ROOT: process.env.MERIDIAN_UNIT_ROOT || root, MERIDIAN_CONFIG: config || path.join(root, 'config.json'),
      MERIDIAN_DATA: path.join(root, 'data'), MERIDIAN_PORT: String(port), MERIDIAN_JOBS: jobs, MERIDIAN_DEMO: demo ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(timer); }
    const match = output.match(/SANDBOX_COUNTS (.+)/);
    assert.ok(match, output + errors);
    const counts = JSON.parse(match[1]);
    assert.equal(counts.children, 0, errors);
    assert.equal(counts.outbound, 0, errors);
    assert.equal(errors, '', errors);
    return counts;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Fresh boot timed out: ' + output + errors)), 15000);
      function finish(error) { clearTimeout(timer); child.stdout.off('data', check); child.off('close', exited); error ? reject(error) : resolve(); }
      function check() { if (output.includes(`127.0.0.1:${port}`)) finish(); }
      function exited() { finish(new Error('Fresh boot exited: ' + errors)); }
      child.stdout.on('data', check); child.once('close', exited); child.once('error', finish); check();
    });
    const base = `http://127.0.0.1:${port}`;
    const json = async (route, method = 'GET', body, status = 200, headers = {}) => {
      const result = await request(base, route, { method, body, headers: { 'content-type': 'application/json', ...headers } });
      assert.equal(result.status, status, method + ' ' + route + ': ' + result.body);
      return JSON.parse(result.body);
    };
    for (let i = 0; i < 100; i++) {
      const state = await json('/api/state');
      if (state.at && state.setup) return { base, json, stop, state, logs: () => output };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Fresh state did not initialise');
  } catch (error) { await stop(); throw error; }
}

test('fresh install is editable, persists over restart and attempts no connectors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-fresh-'));
  let server;
  try {
    server = await boot(root);
    assert.equal(server.state.setup.fresh, true);
    assert.ok(Object.values(server.state.setup.connectors).every(c => !c.enabled));
    assert.deepEqual(server.state.todos, []);
    assert.deepEqual(server.state.calendar.events, []);
    assert.ok(Object.values(server.state.sources).every(s => s.error === null));
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal(config.profile.kind, 'empty');
    assert.equal(await fs.readFile(path.join(root, 'config.json.bak'), 'utf8'), await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal((await fs.stat(path.join(root, 'config.json'))).mode & 0o777, 0o600);
    assert.equal((await request(server.base, '/command?lab')).status, 200);
    assert.equal((await request(server.base, '/api/state', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403);
    assert.equal((await request(server.base, '/api/todos', { method: 'POST', headers: { origin: 'https://foreign.example' }, body: '{}' })).status, 403);
    assert.equal((await server.json('/api/daily-art')).art, null);
    assert.deepEqual((await server.json('/api/connect')).sources, []);
    assert.deepEqual((await server.json('/api/calendars')).classes.items, []);

    const saved = {};
    const resources = [
      ['/api/todos', 'todo', { title: 'First task' }, { title: 'Edited task', done: true }, 201],
      ['/api/links', 'link', { title: 'First link', url: 'https://example.invalid' }, { title: 'Edited link' }, 201],
      ['/api/drafts', 'draft', { kind: 'note', title: 'First draft', body: 'One' }, { body: 'Two' }, 201],
      ['/api/stash', 'item', { kind: 'note', title: 'First note', text: 'One' }, { title: 'Edited note', text: 'Two' }, 200],
      ['/api/journal', 'entry', { date: '2026-10-08', title: 'First journal', body: 'One' }, { body: 'Two' }, 201],
    ];
    for (const [route, key, input, patch, status] of resources) {
      const item = (await server.json(route, 'POST', input, status))[key];
      assert.ok(item?.id, route);
      await server.json(route + '/' + item.id, 'PATCH', patch);
      const deletedInput = input.url ? { ...input, url: input.url + '/delete' } : input;
      const deleted = (await server.json(route, 'POST', deletedInput, status))[key];
      await server.json(route + '/' + deleted.id, 'DELETE');
      saved[route] = { id: item.id, deleted: deleted.id, key, patch };
    }
    await server.json('/api/stash', 'POST', { url: 'https://example.invalid/page' });
    const upload = await request(server.base, '/api/stash/file?name=sample.pdf&type=application/pdf', {
      method: 'POST', headers: { 'x-stash': '1', 'content-type': 'application/pdf' }, body: '%PDF-1.4 synthetic file' });
    assert.equal(upload.status, 200, upload.body);
    const file = JSON.parse(upload.body).item;
    const prefs = { look: { surface: 'ink' }, tabs: { hidden: ['brief'] } };
    await server.json('/api/command/prefs', 'PUT', { look: { surface: 'daylight' } });
    await server.json('/api/command/prefs', 'PUT', {});
    assert.deepEqual((await server.json('/api/command/prefs')).prefs, {});
    await server.json('/api/command/prefs', 'PUT', prefs);
    await server.json('/api/notify', 'PATCH', { enabled: false, quiet: { on: false } });
    for (const route of ['/api/engines?refresh=1', '/api/almanac?force=1', '/api/local', '/api/heart-health', '/api/ai-usage/ledger', '/api/connect', '/brief-icon.svg', '/api/voice/status', '/api/preview?url=https://example.invalid', '/api/favicon?url=https://example.invalid', '/api/link-meta?url=https://example.invalid', '/api/brain/search?q=test']) {
      const result = await request(server.base, route);
      assert.ok([200, 404, 503].includes(result.status), route + ': ' + result.status);
    }
    for (const route of ['/api/notify/test', '/api/delegate', '/api/feedback', '/api/local/share', '/api/fleet/pause', '/api/tell', '/api/voice/session', '/api/money/refresh']) {
      await server.json(route, 'POST', {}, 503);
    }
    const firstCounts = await server.stop(); server = null;
    server = await boot(root);
    assert.equal(server.state.setup.fresh, false);
    for (const [route, { id, deleted, patch }] of Object.entries(saved)) {
      const list = await server.json(route);
      const items = list.todos || list.links || list.drafts || list.items || list.entries;
      assert.ok(items.some(it => it.id === id), route);
      assert.ok(!items.some(it => it.id === deleted), route + ' deletion survives');
      const item = items.find(it => it.id === id);
      for (const [key, value] of Object.entries(patch)) assert.equal(item[key], value, route + ' ' + key);
    }
    assert.deepEqual((await server.json('/api/command/prefs')).prefs, prefs);
    assert.equal((await server.json('/api/state')).notify.quiet.on, false);
    assert.equal((await request(server.base, '/api/stash/' + file.id + '/file')).body, '%PDF-1.4 synthetic file');
    const restartCounts = await server.stop(); server = null;
    t.diagnostic('Empty HOME and PATH; core CRUD, settings, file upload and restart passed. Side effects: ' + JSON.stringify({ first: firstCounts, restart: restartCounts }));
  } finally { if (server) await server.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test('fresh read-only boot attempts no optional jobs and still honours jobs-off writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-empty-read-'));
  let server;
  try {
    server = await boot(root, { jobs: 'off' });
    assert.equal((await request(server.base, '/api/todos', { method: 'POST', body: '{}' })).status, 503);
    await assert.rejects(fs.stat(path.join(root, 'config.json')), { code: 'ENOENT' });
    assert.deepEqual(await server.stop(), { children: 0, outbound: 0, timers: 0 }); server = null;
    server = await boot(root);
    for (const route of ['/command?lab', '/api/connect', '/api/engines?refresh=1', '/api/almanac?force=1', '/brief-icon.svg']) {
      assert.equal((await request(server.base, route)).status, 200, route);
    }
    assert.deepEqual(await server.stop(), { children: 0, outbound: 0, timers: 0 }); server = null;
  } finally { if (server) await server.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test('demo ignores real paths, edits fictional records and removes its temporary profile', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-demo-check-'));
  let server;
  try {
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'config.json'), 'This must never be parsed');
    await fs.writeFile(path.join(root, 'data/todos.json'), 'This must never be read');
    server = await boot(root, { demo: true, port: fixturePort + 1 });
    assert.equal(server.state.setup.demo, true);
    assert.ok(server.state.todos.some(it => /Maya/.test(it.title)));
    const id = server.state.todos[0].id;
    await server.json('/api/demo/todos/' + id, 'PATCH', { title: 'Demo edit' });
    assert.equal((await server.json('/api/todos')).todos.find(it => it.id === id).title, 'Demo edit');
    const fresh = (await server.json('/api/demo/todos', 'POST', { title: 'Demo add' }, 201)).todo;
    await server.json('/api/demo/todos/' + fresh.id, 'DELETE');
    const data = server.state.vaultJournalDir;
    const temporaryRoot = path.resolve(data, '../../..');
    assert.match(path.basename(temporaryRoot), /^meridian-demo-/);
    assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), 'This must never be parsed');
    assert.equal(await fs.readFile(path.join(root, 'data/todos.json'), 'utf8'), 'This must never be read');
    await server.stop(); server = null;
    await assert.rejects(fs.stat(temporaryRoot), { code: 'ENOENT' });
    server = await boot(root, { demo: true, port: fixturePort + 1 });
    assert.ok(!(await server.json('/api/todos')).todos.some(it => it.title === 'Demo edit'));
    await server.stop(); server = null;
  } finally { if (server) await server.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
