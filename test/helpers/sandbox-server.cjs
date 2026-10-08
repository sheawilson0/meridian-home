'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { world } = require('../../demo');
const { migrationKeys } = require('../../owner-config');

const repo = path.resolve(__dirname, '../..');
const NOW = Date.parse('2026-10-08T11:00:00.000Z');
const DRAFT_ID = 'aabbcc001122';
const TOKEN = 'synthetic-dashboard-token';
const MCP_TOKEN = 'synthetic-mcp-token';
const PAGES = {
  '/': 'brief-dia.html', '/dashboard': 'command.html', '/command': 'command.html',
  '/dashboard-classic': 'dashboard.html', '/connect': 'connect.html', '/quick': 'quick.html',
  '/draft': 'draft.html', '/drafts': 'drafts.html', 
  '/dashboard/phone': 'phone.html', '/phone': 'phone.html', '/tell': 'phone.html', '/stash-sort': 'stash-sort.html',
};

async function seed(root) {
  const data = path.join(root, 'data');
  const put = async (name, value) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
  };
  await put('config.json', { ...structuredClone(migrationKeys), port: 5160, machine: 'Fixture Mac', location: 'Fixture town', token: TOKEN, mcpToken: MCP_TOKEN,
    tailscale: { hostname: 'fixture.example.ts.net' }, notify: { enabled: false }, nudges: { enabled: false, skip: ['Synthetic meeting'] },
    heartHealth: { project: 'fixture', scope: 'fixture', hostname: 'fixture.example.com', cli: 'unused.js', from: '2026-09-16', dashboardUrl: '', answersFrom: '' } });
  await put('data/brief-art/collection.json', { artworks: [{ i: '00000000-0000-0000-0000-000000000000', t: 'Fixture painting', a: 'Example Artist', d: '2026', favourite: true }] });
  // A tiny local image keeps the artwork path usable without fetching anything.
  await fs.writeFile(path.join(data, 'brief-art/favourite.jpg'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64'));
  await put('data/todos.json', { version: 1, todos: world.todos(NOW) });
  await put('data/links.json', { version: 1, ...world.links(NOW) });
  await put('data/deadlines.json', { version: 1, items: world.deadlines(NOW) });
  await put('data/projects.json', { version: 1, projects: [] });
  await put('data/journal.json', { version: 1, ...world.journal(NOW) });
  await put('data/brief-intake.json', world.intake(NOW));
  await put('data/brief-feedback.json', { items: [], completed: [], dismissed: [] });
  await put('data/command-prefs.json', { look: { surface: 'ink', type: 'editorial', hero: 'earthview' } });
  await put('data/drafts.json', { version: 1, drafts: [{ id: DRAFT_ID, kind: 'email', title: 'Northwind proofs',
    to: 'Alex <alex@example.invalid>', cc: '', bcc: '', subject: 'Proofs for Friday', from: 'Studio', fromWhy: 'Project correspondence',
    where: '', space: '', body: 'Hi Alex,\n\nThe colour proofs are ready for Friday. Shall we review them at ten?\n\nSam',
    status: 'drafting', rev: 1, approvedRev: null, created: NOW - 3600000, updated: NOW - 1800000, by: 'Example agent', archived: false }] });
  // Text, link and colour records need no Vision, browser preview or missing file.
  await put('data/stash/items.json', { version: 1, seenAt: NOW - 10800000,
    items: world.stashItems(NOW).filter(it => ['note', 'link', 'quote', 'colour'].includes(it.kind)) });
  await put('cache/almanac/2026-10-08.json', { date: '2026-10-08', generatedAt: '2026-10-08T11:00:00.000Z',
    items: { weather: { temp: 14, code: 3, label: 'Cloudy', place: 'Fixture town', fetchedAt: '2026-10-08T11:00:00.000Z' } }, meta: {} });
  return { root, data, config: path.join(root, 'config.json') };
}

async function freePort() {
  // Agents can select their assigned range without borrowing a live port.
  const first = Number(process.env.MERIDIAN_TEST_PORT || process.env.MERIDIAN_TEST_PORT_BASE || 5160);
  const last = first + (process.env.MERIDIAN_TEST_PORT ? 1 : 9);
  if (!Number.isInteger(first) || first < 1 || last > 65535 || first <= 4980 && last >= 4980) throw new Error('Invalid sandbox port range');
  for (let port = first; port <= last; port++) {
    const socket = net.createServer();
    const available = await new Promise((resolve, reject) => {
      socket.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No free sandbox port in the selected range');
}

function request(base, route, { method = 'GET', headers = {}, body } = {}) {
  const text = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, agent: false,
      headers: { ...(text === undefined ? {} : { 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out: ' + route)));
    req.end(text);
  });
}

async function startSandbox({ preload } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meridian-contract-'));
  let child, closed;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (closed) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    const fixture = await seed(root);
    const port = await freePort();
    child = spawn(process.execPath, ['--require', path.join(__dirname, 'isolate.cjs'),
      '--require', path.join(__dirname, 'fixture-clock.cjs'), '--require', path.join(repo, 'test/sandbox-probe.cjs'),
      ...(preload ? ['--require', preload] : []), path.join(repo, 'server.js')], {
      cwd: repo, env: { PATH: process.env.PATH, TZ: 'Europe/London', MERIDIAN_UNIT_ROOT: process.env.MERIDIAN_UNIT_ROOT || root,
        ...(preload ? { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT } : {}),
        MERIDIAN_SANDBOX: '1', MERIDIAN_JOBS: 'off', MERIDIAN_CONFIG: fixture.config, MERIDIAN_DATA: fixture.data, MERIDIAN_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    closed = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Sandbox boot timed out: ' + errors)), 5000);
      const finish = error => { clearTimeout(timer); child.stdout.off('data', check); child.off('error', finish); child.off('close', exited); error ? reject(error) : resolve(); };
      const check = () => { if (output.includes(`127.0.0.1:${port}`)) finish(); };
      const exited = () => finish(new Error('Sandbox exited before listen: ' + errors));
      child.stdout.on('data', check); child.once('error', finish); child.once('close', exited); check();
    });
    const base = `http://127.0.0.1:${port}`;
    // Listen can precede the asynchronous disk refresh. Never pin the empty startup placeholder.
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = JSON.parse((await request(base, '/api/state')).body);
      if (state.at) return { ...fixture, base, port, child, stop, logs: () => ({ output, errors }) };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Sandbox did not assemble its disk state');
  } catch (error) { await stop(); throw error; }
}

// Array membership and values may vary; the set of keys and value types may not.
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return { array: [...new Map(value.map(item => { const s = shape(item); return [JSON.stringify(s), s]; })).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])]));
  return typeof value;
}

module.exports = { startSandbox, seed, freePort, request, shape, NOW, DRAFT_ID, TOKEN, MCP_TOKEN, PAGES, repo };
