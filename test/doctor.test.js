'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnose } = require('../scripts/doctor');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home: root, env: { PATH: '', MERIDIAN_PORT: '5140' }, nodeVersion: '22.22.3', platform: 'linux', probePort: async () => 'free' };
}

function config(f) {
  const value = { board: { dir: 'board' }, fleet: { services: [], sites: [] }, git: { roots: [] }, brain: { graphPath: 'graph.json' }, threads: { url: '', configPath: 'threads.json' }, vaultInbox: 'inbox', notify: { topic: 'local-disabled', enabled: false } };
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify(value));
  return value;
}

test('doctor describes a fresh clone without creating config, data or jobs', async (t) => {
  const f = fixture(t), before = fs.readdirSync(f.root);
  const result = await diagnose(f);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.ok(result.rows.some((r) => r.check === 'Config' && r.status === 'FAIL'));
  assert.ok(result.rows.some((r) => r.check === 'Brief artwork' && r.status === 'FAIL'));
  assert.ok(result.rows.some((r) => r.check === 'Swift compiler' && r.status === 'WARN'));
});

test('doctor never includes malformed config text, keys or feed URLs in its report', async (t) => {
  const f = fixture(t);
  const secret = 'private-test-value-should-never-be-reported';
  fs.writeFileSync(path.join(f.root, 'config.json'), '{"token":"' + secret + '" BROKEN');
  const bad = await diagnose(f);
  assert.ok(!JSON.stringify(bad).includes(secret));
  const c = config(f);
  c.token = secret; c.calendar = { icsUrls: ['https://example.invalid/' + secret] };
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify(c));
  const good = await diagnose(f);
  assert.ok(!JSON.stringify(good).includes(secret));
});

test('doctor accepts the same config backup as the server without repairing files', async (t) => {
  const f = fixture(t); config(f);
  fs.renameSync(path.join(f.root, 'config.json'), path.join(f.root, 'config.json.bak'));
  fs.writeFileSync(path.join(f.root, 'config.json'), 'broken');
  const result = await diagnose(f);
  assert.ok(result.rows.some((r) => r.check === 'Config' && r.status === 'WARN'));
  assert.ok(result.rows.some((r) => r.check === 'Legacy settings' && r.status === 'OK'));
  assert.equal(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'), 'broken');
});

test('doctor validates the port before probing and honours config and port overrides', async (t) => {
  const f = fixture(t); config(f);
  const file = path.join(f.root, 'isolated.json');
  fs.renameSync(path.join(f.root, 'config.json'), file);
  f.env.MERIDIAN_CONFIG = path.relative(process.cwd(), file);
  let probes = [];
  f.probePort = async (port) => { probes.push(port); return 'busy'; };
  let result = await diagnose(f);
  assert.deepEqual(probes, [5140]);
  assert.ok(result.rows.some((r) => r.check === 'Config' && r.status === 'OK'));
  assert.ok(result.rows.some((r) => r.check === 'Port' && r.status === 'WARN'));
  f.env.MERIDIAN_PORT = 'not-a-port'; probes = [];
  result = await diagnose(f);
  assert.deepEqual(probes, []);
  assert.ok(result.rows.some((r) => r.check === 'Port' && r.status === 'FAIL'));
});

test('doctor rejects malformed nested settings and warns about push auto-enrolment', async (t) => {
  const f = fixture(t), c = config(f);
  c.git.roots = 'wrong'; c.fleet.services = [null]; c.calendar = { icsUrls: 'wrong' }; c.notify = { enabled: false };
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify(c));
  const result = await diagnose(f);
  for (const check of ['Legacy settings', 'fleet.services', 'Calendar settings']) assert.ok(result.rows.some((r) => r.check === check && r.status === 'FAIL'));
  assert.ok(result.rows.some((r) => r.check === 'Pushes' && r.detail.includes('even if enabled was false')));
});

test('doctor separates absent optional tools from startup blockers', async (t) => {
  const f = fixture(t); config(f);
  const dir = path.join(f.root, 'data', 'brief-art'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'collection.json'), '{"artworks":[]}');
  const result = await diagnose(f);
  assert.equal(result.exitCode, 0);
  assert.ok(result.rows.some((r) => r.check === 'Claude CLI' && r.status === 'WARN'));
  assert.ok(result.rows.some((r) => r.check === 'Boot overrides' && r.status === 'WARN'));
});

test('doctor recognises the boot integration without importing guards or requiring art in review mode', async (t) => {
  const f = fixture(t); config(f);
  fs.writeFileSync(path.join(f.root, 'server.js'), "require('./runtime');");
  fs.writeFileSync(path.join(f.root, 'runtime.js'), "throw new Error('doctor must not execute this'); // MERIDIAN_CONFIG MERIDIAN_DATA MERIDIAN_JOBS MERIDIAN_SANDBOX");
  f.env.MERIDIAN_JOBS = 'off'; f.env.MERIDIAN_DATA = path.join(f.root, 'isolated-data');
  const result = await diagnose(f);
  assert.equal(result.exitCode, 0);
  assert.ok(result.rows.some((r) => r.check === 'Brief artwork' && r.status === 'WARN'));
  assert.ok(result.rows.some((r) => r.check === 'Review mode' && r.detail.includes('503')));
  assert.equal(fs.existsSync(f.env.MERIDIAN_DATA), false);
});
