'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function request(port, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timed out: ' + route)));
    req.end();
  });
}

for (const sandbox of [false, true]) test(`isolated boot has no children, outbound requests or job timers (${sandbox ? 'sandbox' : 'jobs off'})`, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-sandbox-test-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  await fs.mkdir(path.join(data, 'stash'), { recursive: true });
  await fs.mkdir(path.join(data, 'brief-art'));
  const art = { i: '00000000-0000-0000-0000-000000000000', t: 'Fixture', favourite: true };
  await fs.writeFile(path.join(data, 'brief-art', 'collection.json'), JSON.stringify({ artworks: [art] }));
  await fs.writeFile(path.join(data, 'brief-art', 'favourite.jpg'), 'fixture image');
  await fs.writeFile(path.join(data, 'todos.json'), JSON.stringify({ todos: [{ id: 'fixture', title: 'Sandbox fixture', when: 'now' }] }));
  await fs.writeFile(path.join(data, 'stash', 'items.json'), JSON.stringify({ version: 1, items: [{ id: 'fixture01', kind: 'link', url: 'https://example.invalid', pending: true }] }));
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ port: 4980, machine: 'Fixture', location: 'Fixture', calendar: {}, notify: { topic: 'fixture-topic', enabled: true } }));
  const port = Number(process.env.MERIDIAN_TEST_PORT || (Number(process.env.MERIDIAN_TEST_PORT_BASE) ? Number(process.env.MERIDIAN_TEST_PORT_BASE) + 8 : 5138)) + (sandbox ? 1 : 0);
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'sandbox-probe.cjs'), path.join(root, 'server.js')], {
    cwd: root, env: { ...process.env, MERIDIAN_CONFIG: config, MERIDIAN_DATA: data, MERIDIAN_PORT: String(port), MERIDIAN_JOBS: sandbox ? 'on' : 'off', MERIDIAN_SANDBOX: sandbox ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { errors += c; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox did not boot: ' + errors)), 5000);
    const check = () => { if (output.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); child.stdout.off('data', check); resolve(); } };
    child.stdout.on('data', check);
    child.on('close', () => { clearTimeout(timer); reject(new Error('sandbox exited: ' + errors)); });
  });
  const state = await request(port, '/api/state');
  assert.equal(state.status, 200, errors);
  assert.equal(JSON.parse(state.body).machine, 'Fixture');
  assert.equal(JSON.parse(state.body).todos[0].title, 'Sandbox fixture');
  assert.equal(JSON.parse(state.body).nudges.push, false);
  const sources = JSON.parse(state.body).sources;
  assert.equal(sources.board.error, 'collectors disabled');
  assert.equal(sources.board.lastAttempt, null);
  assert.equal(typeof sources.todos.lastSuccess, 'number');
  for (const record of Object.values(sources)) assert.deepEqual(Object.keys(record).sort(), ['durationMs', 'error', 'lastAttempt', 'lastSuccess', 'stale']);
  assert.equal(output.includes('100.'), false);
  for (const route of ['/command?lab', '/dashboard?lab', '/dashboard/phone?lab', '/?lab', '/drafts?lab', '/api/stash', '/api/state?view=phone', '/api/engines?refresh=1', '/api/almanac?force=1', '/api/local', '/api/heart-health', '/api/ai-usage/ledger', '/api/connect', '/brief-icon.svg', '/api/voice/status', '/api/preview?url=https://example.invalid', '/api/favicon?url=https://example.invalid', '/api/art?id=' + art.i, '/api/link-meta?url=https://example.invalid']) {
    const reply = await request(port, route);
    assert.ok([200, 404, 503].includes(reply.status), route + ': ' + reply.status);
  }
  for (const route of ['/api/notify/test', '/api/refresh', '/api/money/refresh', '/api/local/share', '/api/fleet/pause', '/api/command/prefs', '/mcp']) {
    assert.equal((await request(port, route, 'POST')).status, 503, route);
  }
  assert.equal(await fs.readFile(config, 'utf8'), JSON.stringify({ port: 4980, machine: 'Fixture', location: 'Fixture', calendar: {}, notify: { topic: 'fixture-topic', enabled: true } }));
  assert.deepEqual((await fs.readdir(data)).sort(), ['brief-art', 'stash', 'todos.json']);
  child.kill('SIGTERM'); await closed;
  const counts = JSON.parse(output.match(/SANDBOX_COUNTS (.+)/)[1]);
  assert.deepEqual(counts, { children: 0, outbound: 0, timers: 0 });
  assert.equal(errors.includes('unhandled rejection'), false, errors);
});

test('jobs-off guard refuses direct process, HTTP, fetch and socket bypasses', () => {
  const script = `const assert = require('node:assert/strict');
    const runtime = require('./runtime'); runtime.installGuards();
    for (const run of [
      () => require('node:child_process').spawn('unexpected'),
      () => require('node:child_process').execFile('unexpected'),
      () => require('node:child_process').execSync('unexpected'),
      () => require('node:http').get('http://example.invalid'),
      () => require('node:https').request('https://example.invalid'),
      () => require('node:net').connect(80, 'example.invalid'),
      () => require('node:tls').connect(443, 'example.invalid'),
    ]) assert.throws(run, { code: 'MERIDIAN_JOBS_OFF' });
    assert.rejects(fetch('https://example.invalid'), { code: 'MERIDIAN_JOBS_OFF' });
    assert.equal(runtime.DATA_DIR, require('node:path').join(__dirname, 'data'));
  `;
  // __dirname in -e is '.', so use an absolute directory in the path assertion.
  execFileSync(process.execPath, ['-e', script.replace("join(__dirname, 'data')", "join(process.cwd(), 'data')")], { cwd: root, env: { ...process.env, MERIDIAN_JOBS: 'off', MERIDIAN_DATA: '', MERIDIAN_SANDBOX: '0' } });
});

test('usage-history child defaults follow the selected data directory', () => {
  for (const selected of ['', path.join(os.tmpdir(), 'meridian-history-path-test', 'data')]) {
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./scripts/ai-usage-history').parseArgs([]).paths))"], {
      cwd: root, env: { ...process.env, MERIDIAN_JOBS: 'off', MERIDIAN_DATA: selected, MERIDIAN_SANDBOX: '0' }, encoding: 'utf8',
    }));
    const data = selected || path.join(root, 'data');
    assert.equal(actual.dir, path.join(data, 'ai-usage', 'history'));
    assert.equal(actual.plans, path.join(data, 'ai-usage', 'plans', 'plans.json'));
    assert.equal(actual.collector, path.join(root, 'scripts', 'ai-usage-collect.py'));
  }
});
