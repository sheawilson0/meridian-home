'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { request, repo, seed, shape } = require('./helpers/sandbox-server.cjs');
const runtime = require('../runtime');
const schema = require('../setup-schema');
const calendars = require('../calendars-store');
// Import before changing the gate: the collector must not cache it at import.
const { createGithub } = require('../github');
const { createHistoryRunner } = require('../ai-usage-ledger');

const firstPort = Number(process.env.MERIDIAN_TEST_PORT || process.env.MERIDIAN_TEST_PORT_BASE || 5220);
const port = firstPort + 6, feedPort = firstPort + 7;
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const cleanups = new Map();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-setup-'));
  cleanups.set(root, []);
  t.after(async () => {
    for (const stop of cleanups.get(root)) await stop();
    cleanups.delete(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function boot(t, root, { jobs = 'on', sandbox = false, clock = false } = {}) {
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/isolate.cjs'),
    ...(clock ? ['--require', path.join(__dirname, 'helpers/fixture-clock.cjs')] : []), path.join(repo, 'server.js')], {
    cwd: repo, env: { PATH: '', HOME: os.homedir(), MERIDIAN_UNIT_ROOT: process.env.MERIDIAN_UNIT_ROOT || root,
      MERIDIAN_CONFIG: path.join(root, 'config.json'), MERIDIAN_DATA: path.join(root, 'data'),
      MERIDIAN_PORT: String(port), MERIDIAN_JOBS: jobs, MERIDIAN_SANDBOX: sandbox ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(timer); }
    assert.equal(errors, '', errors);
  }
  cleanups.get(root).push(stop);
  t.after(stop);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Setup server boot timed out: ' + errors)), 15000);
    function finish(error) { clearTimeout(timer); child.stdout.off('data', check); child.off('close', exited); error ? reject(error) : resolve(); }
    function check() { if (output.includes(`127.0.0.1:${port}`)) finish(); }
    function exited() { finish(new Error('Setup server exited: ' + errors)); }
    child.stdout.on('data', check); child.once('close', exited); child.once('error', finish); check();
  });
  const base = `http://127.0.0.1:${port}`;
  async function json(route, method = 'GET', body, expected = 200, headers = {}) {
    const response = await request(base, route, { method, body, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal(response.status, expected, method + ' ' + route + ': ' + response.body);
    return JSON.parse(response.body);
  }
  for (let i = 0; i < 100; i++) {
    if ((await json('/api/state')).at) return { base, json, stop };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Setup state did not initialise');
}

async function localFeed(t, root) {
  const start = Date.now() + 3600000;
  const file = path.join(root, 'fixture.ics');
  await fs.writeFile(file, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:setup-fixture',
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3600000)}`, 'SUMMARY:Local setup event', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  let hits = 0;
  const server = http.createServer(async (_req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/calendar' }); res.end(await fs.readFile(file)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(feedPort, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${feedPort}/private-fixture.ics`, hits: () => hits };
}

test('setup schema rejects bad URLs, missing required fields and unknown or malformed settings', () => {
  runtime.configure({ portable: true, fresh: false, connectors: {} });
  const validate = (name, body, config = {}) => schema.validate(name, body, config, { calendarUrl: calendars.normaliseUrl });
  assert.throws(() => validate('calendar', { enabled: true, settings: { icsUrls: ['not a URL'] } }), /not a link/);
  for (const url of ['file:///tmp/feed.ics', 'http://example.com/feed.ics', 'http://127.0.0.1.evil.invalid/feed.ics']) {
    assert.throws(() => validate('calendar', { enabled: true, settings: { icsUrls: [url] } }), /https/);
  }
  assert.throws(() => validate('calendar', { enabled: true, settings: {} }), /icsUrls is required/);
  assert.throws(() => validate('github', { enabled: true, settings: {} }), /account is required/);
  assert.throws(() => validate('github', { enabled: true, settings: { account: 'bad/name' } }), /account name/);
  assert.throws(() => validate('git', { enabled: true, settings: { roots: ['/tmp', 1] } }), /list/);
  assert.throws(() => validate('notify', { enabled: true, settings: { topic: 'fixture', url: 'http://example.com' } }), /HTTPS/);
  assert.throws(() => validate('ai', { enabled: 'true' }), /boolean/);
  assert.throws(() => validate('ai', { enabled: true, settings: [] }), /object/);
  assert.throws(() => validate('ai', { enabled: true, settings: { token: 'unused' } }), /Unknown setting/);
  assert.throws(() => validate('__proto__', { enabled: true }), /Unknown connector/);
  assert.deepEqual(validate('calendar', { enabled: false, settings: { icsUrls: [] } }), { enabled: false, patch: { icsUrls: [] } });
  runtime.configure({ portable: false, connectors: {} });
  assert.throws(() => calendars.normaliseUrl(`http://127.0.0.1:${feedPort}/fixture.ics`), /https/);
});

test('portable setup validates, saves private files and enables a real local calendar without restart', async t => {
  const root = await fixture(t), feed = await localFeed(t, root);
  let server = await boot(t, root);
  const initial = await server.json('/api/setup');
  assert.deepEqual(Object.keys(initial).sort(), ['connectors', 'demo', 'fresh']);
  assert.deepEqual(Object.keys(initial.connectors).sort(), Object.keys(schema.SCHEMA).sort());
  assert.equal(initial.fresh, true); assert.equal(initial.demo, false);
  assert.deepEqual(initial.connectors.calendar.needs, schema.SCHEMA.calendar.needs);
  assert.equal(initial.connectors.calendar.live, true);
  assert.equal(initial.connectors.previews.platform, 'darwin');
  assert.ok(initial.connectors.github.reason.includes('gh'));
  const file = path.join(root, 'config.json'), before = await fs.readFile(file, 'utf8');
  await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: true, settings: { icsUrls: ['invalid'] } }, 400);
  await server.json('/api/setup/connectors/github', 'PUT', { enabled: true, settings: {} }, 400);
  await server.json('/api/setup/connectors/unknown', 'PUT', { enabled: true }, 404);
  await server.json('/api/setup/demo-data', 'POST', {}, 404);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(await fs.readFile(file + '.bak', 'utf8'), before);
  assert.equal((await request(server.base, '/api/setup', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403);
  assert.equal((await request(server.base, '/api/setup/connectors/calendar', { method: 'PUT', body: '{}', headers: { origin: 'https://foreign.example', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await request(server.base, '/api/setup/connectors/calendar', { method: 'PUT', body: '{}' })).status, 415);
  for (const name of [file, file + '.bak']) await fs.chmod(name, 0o644);

  const enabled = await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: true, settings: { icsUrls: [feed.url] } });
  assert.equal(enabled.enabled, true); assert.equal(enabled.configured, true);
  assert.equal(Object.hasOwn(enabled, 'needsRestart'), false);
  assert.equal(JSON.stringify(enabled).includes(feed.url), false);
  await server.json('/api/refresh', 'POST', {});
  assert.ok((await server.json('/api/state')).calendar.events.some(event => event.title === 'Local setup event'));
  assert.ok(feed.hits() > 0);
  const saved = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(saved).calendar.icsUrls, [feed.url]);
  assert.equal(await fs.readFile(file + '.bak', 'utf8'), saved);
  for (const name of [file, file + '.bak']) assert.equal((await fs.stat(name)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
  await server.stop();

  server = await boot(t, root);
  assert.equal((await server.json('/api/setup')).fresh, false);
  assert.equal((await server.json('/api/setup')).connectors.calendar.enabled, true);
  await server.json('/api/refresh', 'POST', {});
  assert.ok((await server.json('/api/state')).calendar.events.some(event => event.title === 'Local setup event'));
  await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: false });
  await server.json('/api/refresh', 'POST', {});
  assert.deepEqual((await server.json('/api/state')).calendar.events, []);
  const hits = feed.hits();
  await server.json('/api/refresh', 'POST', {});
  assert.equal(feed.hits(), hits);
  await server.stop();
  server = await boot(t, root);
  assert.equal((await server.json('/api/setup')).connectors.calendar.enabled, false);
  assert.equal((await server.json('/api/setup')).connectors.calendar.configured, true);
  await server.json('/api/refresh', 'POST', {});
  assert.deepEqual((await server.json('/api/state')).calendar.events, []);
  assert.equal(feed.hits(), hits);
});

test('AI sessions switch live and disappear from the next refresh after disable', async t => {
  const root = await fixture(t), project = path.join(os.homedir(), '.claude/projects/meridian-setup-fixture');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'fixture.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Synthetic session' } }) + '\n');
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const server = await boot(t, root);
  assert.deepEqual((await server.json('/api/state')).ai.sessions, []);
  const enabled = await server.json('/api/setup/connectors/ai', 'PUT', { enabled: true });
  assert.equal(enabled.enabled, true); assert.equal(Object.hasOwn(enabled, 'needsRestart'), false);
  await server.json('/api/refresh', 'POST', {});
  assert.ok((await server.json('/api/state')).ai.sessions.some(session => session.tool === 'claude' && session.id === 'fixture' && session.project === 'meridian/setup/fixture'));
  await server.json('/api/setup/connectors/ai', 'PUT', { enabled: false });
  await server.json('/api/refresh', 'POST', {});
  assert.deepEqual((await server.json('/api/state')).ai.sessions, []);
});

test('saved feeds use the core Calendars API and count towards setup requirements', async t => {
  const root = await fixture(t), feed = await localFeed(t, root), server = await boot(t, root);
  const added = await server.json('/api/calendars', 'POST', { url: feed.url, label: 'Fixture' }, 201);
  assert.equal(JSON.stringify(added).includes('private-fixture.ics'), false);
  const enabled = await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: true, settings: {} });
  assert.equal(enabled.enabled, true);
  await server.json('/api/refresh', 'POST', {});
  assert.equal((await server.json('/api/state')).calendar.events[0].calendar, 'Fixture');
  await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: true, settings: { icsUrls: [] } });
  await server.json('/api/calendars/' + added.feed.id, 'DELETE');
  await server.json('/api/refresh', 'POST', {});
  assert.equal((await server.json('/api/setup')).connectors.calendar.configured, false);
  assert.equal((await server.json('/api/setup')).connectors.calendar.enabled, false);
});

test('secret settings stay private, concurrent saves retain both updates and boot-only connectors report restart', async t => {
  const root = await fixture(t), server = await boot(t, root), topic = 'private-fixture-topic';
  const [notify, link] = await Promise.all([
    server.json('/api/setup/connectors/notify', 'PUT', { enabled: false, settings: { topic } }),
    server.json('/api/setup/connectors/linkMetadata', 'PUT', { enabled: true }),
  ]);
  assert.equal(notify.configured, true); assert.equal(link.enabled, true);
  assert.equal(JSON.stringify(notify).includes(topic), false);
  assert.equal(JSON.stringify(await server.json('/api/setup')).includes(topic), false);
  await server.json('/api/refresh', 'POST', {});
  assert.equal(JSON.stringify(await server.json('/api/state')).includes(topic), false);
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  assert.equal(config.notify.topic, topic); assert.equal(config.connectors.linkMetadata.enabled, true);
  const restart = await server.json('/api/setup/connectors/stashSummary', 'PUT', { enabled: false });
  assert.equal(restart.live, false); assert.equal(restart.needsRestart, true);
});

test('a failed config save keeps the runtime switch and primary file unchanged', async t => {
  const root = await fixture(t), server = await boot(t, root), file = path.join(root, 'config.json');
  const before = await fs.readFile(file, 'utf8');
  await fs.rename(file + '.bak', file + '.kept');
  await fs.mkdir(file + '.bak');
  const refused = await server.json('/api/setup/connectors/linkMetadata', 'PUT', { enabled: true }, 500);
  assert.equal(refused.error, 'Could not save connector settings');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await server.json('/api/setup')).connectors.linkMetadata.enabled, false);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('legacy setup routes return 404 and the owner state structure is byte-identical', async t => {
  const root = await fixture(t);
  await seed(root);
  const server = await boot(t, root, { jobs: 'off', clock: true });
  const before = await request(server.base, '/api/state');
  const config = await fs.readFile(path.join(root, 'config.json'), 'utf8');
  await server.json('/api/setup', 'GET', undefined, 404);
  await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: true }, 404);
  const after = await request(server.base, '/api/state');
  assert.equal(after.body, before.body);
  assert.equal(Object.hasOwn(JSON.parse(after.body), 'setup'), false);
  const expected = require('./fixtures/server-contract/routes.json')['/api/state'].shape;
  assert.deepEqual(shape(JSON.parse(after.body)), expected);
  assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), config);
});

test('portable jobs-off and sandbox setup return 503 without touching config or backup', async t => {
  const root = await fixture(t);
  let server = await boot(t, root);
  await server.stop();
  const file = path.join(root, 'config.json'), before = await fs.readFile(file, 'utf8');
  for (const options of [{ jobs: 'off' }, { sandbox: true }]) {
    server = await boot(t, root, options);
    await server.json('/api/setup', 'GET', undefined, 503);
    await server.json('/api/setup/connectors/calendar', 'PUT', { enabled: true }, 503);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(await fs.readFile(file + '.bak', 'utf8'), before);
    await server.stop();
  }
});

test('common connector jobs start once on live enable and stop on disable', async () => {
  const source = await fs.readFile(path.join(repo, 'server.js'), 'utf8');
  const code = source.slice(source.indexOf('const portableJobs = new Map();'), source.indexOf('const setupApi ='));
  const flags = {}, calls = {}, timers = new Set();
  const count = key => { calls[key] = (calls[key] || 0) + 1; };
  const context = vm.createContext({ runtime: { portableProfile: () => true, setup: () => ({ connectors: Object.fromEntries(Object.entries(flags).map(([name, enabled]) => [name, { enabled }])) }) },
    JOBS_ENABLED: true, CONFIG: {}, enabled: name => flags[name],
    setInterval: () => { const timer = {}; timers.add(timer); return timer; }, clearInterval: timer => timers.delete(timer),
    refreshState() {}, nudgeTick() {}, releaseHeldPings() {}, github: { refresh() {} },
    almanac: { start() { count('almanacStart'); return () => count('almanacStop'); } },
    aiUsageLedger: { startHistory: () => count('usageStart'), stopHistory: () => count('usageStop') },
    tell: { start: () => count('tellStart'), stop: () => count('tellStop') }, ranker: { stop() {} }, console,
  });
  vm.runInContext(code, context);
  context.syncPortableJobs(); assert.equal(timers.size, 0);
  for (const name of ['calendar', 'github', 'almanac', 'aiUsage', 'tell', 'notify', 'nudges']) flags[name] = true;
  context.syncPortableJobs(); context.syncPortableJobs();
  assert.equal(timers.size, 4);
  for (const key of ['almanacStart', 'usageStart', 'tellStart']) assert.equal(calls[key], 1);
  for (const name of Object.keys(flags)) flags[name] = false;
  context.syncPortableJobs(); assert.equal(timers.size, 0);
  for (const key of ['almanacStop', 'usageStop', 'tellStop']) assert.equal(calls[key], 1);
});

test('GitHub and usage history read the live gate after their modules have loaded', async () => {
  let calls = 0;
  const github = createGithub({ bin: 'fixture', runner: async (_bin, args) => {
    calls++;
    return { ok: true, stdout: JSON.stringify(args[1] === 'graphql' ? { data: { viewer: { login: 'fixture' }, mine: { nodes: [] }, reviews: { nodes: [] }, merged: { nodes: [] } } } : []) };
  } });
  runtime.configure({ portable: true, connectors: { github: { enabled: false }, aiUsage: { enabled: false } } });
  await github.refresh(); assert.equal(calls, 0);
  runtime.updateConnectors({ github: { enabled: true }, aiUsage: { enabled: true } });
  assert.equal((await github.refresh()).user, 'fixture'); assert.ok(calls > 0);
  let scheduled = 0, stopped = 0;
  const clock = { setTimeout: () => { scheduled++; return { unref() {} }; }, setInterval: () => { scheduled++; return { unref() {} }; },
    clearTimeout: () => stopped++, clearInterval: () => stopped++ };
  const runner = createHistoryRunner({ clock });
  runner.start(); assert.equal(scheduled, 2); runner.stop(); assert.equal(stopped, 2);
  runtime.updateConnectors({ github: { enabled: false }, aiUsage: { enabled: false } });
  const previous = calls; await github.refresh(); assert.equal(calls, previous);
  runner.start(); assert.equal(scheduled, 2);
  runtime.configure({ portable: false, connectors: {} });
});
