'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pipeline, Writable } = require('node:stream');
const { spawn } = require('node:child_process');

// Evaluate the daemon's helpers and listener without its boot section or
// collectors' constructors. No launch agents, live data or scheduled jobs.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const code = [
  section('function fetchUrl(', 'function ago('),
  section('const BRIEF_FEEDBACK_FILE', 'const JSF_VISIBLE ='),
  section('const CHROME_BIN', '// Returns the cached preview path'),
  section('const DEADLINES_FILE', 'function ensureNotifyConfig('),
  section('let state = { at: 0 };', 'const ART_CACHE_DIR'),
  section('const server = http.createServer', '// ---------------------------------------------------------------- command centre helpers'),
  section('function jsonBody(', 'const HTML_ENTITIES'),
  section('function fetchPage(', 'async function pageMeta('),
].join('\n');

function harness(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-server-test-'));
  fs.mkdirSync(path.join(root, 'data'));
  const errors = [];
  const ctx = vm.createContext({
    fs, fsp, path, os, http, https, crypto, zlib, pipeline, Buffer, URL,
    setTimeout, clearTimeout, setInterval, clearInterval, process,
    console: { error: (...args) => errors.push(args), log() {} },
    ROOT: root, DATA_DIR: path.join(root, 'data'), CACHE_DIR: path.join(root, 'cache'), STORAGE_ROOT: root, JOBS_ENABLED: true,
    runtime: { portableProfile: () => false, DEMO: false }, enabled: () => true, firstRun: require('../first-run'),
    CONFIG_FILE: path.join(root, 'config.json'), fileQueues: new Map(),
    CONFIG: { port: 4980, tailscale: { hostname: 'studio.example.invalid' } },
    COMMAND_PREFS_FILE: path.join(root, 'data', 'command-prefs.json'),
    tailnetCache: { info: { host: 'studio.example.invalid' } },
    almanac: { handle: async () => false }, briefIcon: { handle: async () => false, isBriefUrl: () => false },
    projectsStore: { read: async () => ({ projects: [] }) },
    draftRoutes: async () => false, // drafts.js has its own tests
    voice: { handle: async () => false }, // voice.js has its own tests
    draftsLib: require('../drafts'), // authorized() uses its fromInternet
    mcpGrants: { recognizes: () => false }, bearer: require('../mcp-grants').bearer,
    phoneState: require('../phone-state').phoneState,
    createRefresh: require('../refresh').createRefresh, createSources: require('../refresh').createSources,
    repoCache: { at: 0 }, brainCache: {}, calCache: {}, campaignSnapshotCache: {}, localCache: { at: 0 },
    spawn, stash: {}, STASH_ID: /^[a-z0-9]+$/,
    ranker: { peek: () => null, maybeRefresh() {}, refresh: async () => null }, // todo-rank.js has its own tests
    ...extra,
  });
  vm.runInContext(code + '\nthis.server = server; this.clients = sseClients; this.refreshState = refreshState;', ctx);
  t.after(async () => {
    ctx.server.closeAllConnections();
    if (ctx.server.listening) await new Promise((resolve) => ctx.server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { ctx, root, errors, run: (s) => vm.runInContext(s, ctx) };
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function request(base, route, method = 'GET', body, headers = {}, raw = false) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
async function upstream(t, handler) {
  const server = http.createServer(handler);
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return listen(server);
}
function read(root, name) { return JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8')); }
function write(root, name, value) { fs.writeFileSync(path.join(root, 'data', name), JSON.stringify(value)); }

// Keep route-triggered refreshes out of mutation tests. refreshState itself
// has a separate test with a hung collector and stale data.
function noRefresh(h) { h.run('refreshLiveState = async () => state;'); }

function previewFiles(h) {
  const dir = path.join(h.root, 'delegations', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['mockup.html', 'image.svg', 'document.xml', 'REPORT.md', 'app.js', 'data.json', 'notes.txt', 'MOCKUP.HTML']) {
    fs.writeFileSync(path.join(dir, name), 'synthetic preview');
  }
}

test('WebP static and design assets have image MIME, cache validators and unchanged bytes', async (t) => {
  const pass = { handle: async () => false };
  const h = harness(t, { aiUsageLedger: pass, money: pass, tell: pass }), bytes = fs.readFileSync(path.join(__dirname, '../public/img/planets/jupiter.webp'));
  for (const file of ['img/planets/jupiter.webp', 'design/fixture/jupiter.webp']) {
    const target = path.join(h.root, 'public', file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const base = await listen(h.ctx.server);
  for (const route of ['/img/planets/jupiter.webp', '/design/fixture/jupiter.webp']) {
    const r = await request(base, route, 'GET', undefined, {}, true);
    assert.equal(r.status, 200); assert.deepEqual(r.body, bytes);
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.equal(r.headers['cache-control'], 'public, max-age=3600');
    assert.ok(r.headers.etag && r.headers['last-modified']);
    const fresh = await request(base, route, 'GET', undefined, { 'if-none-match': r.headers.etag });
    assert.equal(fresh.status, 304); assert.equal(fresh.body, '');
  }
});

test('delegation sandbox is opt-in and leaves default response headers and bytes alone', async (t) => {
  const h = harness(t); previewFiles(h);
  const base = await listen(h.ctx.server);
  for (const setting of [undefined, {}, { sandboxPreviews: false }, { sandboxPreviews: 'true' }, { sandboxPreviews: 1 }]) {
    h.ctx.CONFIG.delegations = setting;
    for (const [name, type] of [['mockup.html', 'text/html'], ['image.svg', 'image/svg+xml'], ['document.xml', 'text/plain; charset=utf-8']]) {
      const r = await request(base, '/delegations/fixture/' + name);
      assert.equal(r.status, 200); assert.equal(r.body, 'synthetic preview');
      assert.equal(r.headers['content-type'], type);
      assert.equal(r.headers['content-security-policy'], undefined);
      assert.equal(r.headers['x-content-type-options'], undefined);
    }
  }
});

test('delegation sandbox covers HTML, SVG and XML, with an optional static mode', async (t) => {
  const h = harness(t); previewFiles(h);
  const base = await listen(h.ctx.server);
  for (const [setting, policy] of [[true, 'sandbox allow-scripts allow-popups allow-forms allow-modals'], ['scripts-off', 'sandbox']]) {
    h.ctx.CONFIG.delegations = { sandboxPreviews: setting };
    for (const method of ['GET', 'HEAD']) {
      for (const name of ['mockup.html', 'image.svg', 'document.xml', 'MOCKUP.HTML']) {
        const r = await request(base, '/delegations/fixture/' + name, method);
        assert.equal(r.status, 200); assert.equal(r.headers['content-security-policy'], policy);
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.equal(r.body, method === 'HEAD' ? '' : 'synthetic preview');
      }
    }
    for (const route of ['/delegations/fixture/REPORT.md', '/delegations/fixture/app.js', '/delegations/fixture/data.json', '/delegations/fixture/notes.txt', '/api/deadlines']) {
      const r = await request(base, route);
      assert.equal(r.status, 200); assert.equal(r.headers['content-security-policy'], undefined);
      assert.equal(r.headers['x-content-type-options'], undefined);
    }
    const missing = await request(base, '/delegations/fixture/missing.html');
    assert.equal(missing.status, 404); assert.equal(missing.headers['content-security-policy'], undefined);
  }
});

test('delegation traversal paths cannot read files outside a run with either flag setting', async (t) => {
  const h = harness(t, { aiUsageLedger: { handle: async () => false }, money: { handle: async () => false }, tell: { handle: async () => false } }); previewFiles(h);
  fs.writeFileSync(path.join(h.root, 'private.html'), 'outside run');
  const base = await listen(h.ctx.server);
  for (const setting of [false, true, 'scripts-off']) {
    h.ctx.CONFIG.delegations = { sandboxPreviews: setting };
    for (const route of ['/delegations/../private.html', '/delegations/fixture/../../private.html', '/delegations/%2e%2e/private.html', '/delegations/fixture/%2e%2e%2f%2e%2e%2fprivate.html', '/delegations/fixture/..%5c..%5cprivate.html', '/delegations/fixture/subdir/mockup.html']) {
      const r = await request(base, route);
      assert.equal(r.status, 404, route); assert.ok(!r.body.includes('outside run'), route);
    }
  }
});

test('request rejection answers 500 and the listener keeps accepting requests', async (t) => {
  const h = harness(t, { projectsStore: { read: async () => { throw new Error('projects unreadable'); } } });
  const base = await listen(h.ctx.server);
  assert.equal((await request(base, '/api/projects')).status, 500);
  assert.equal((await request(base, '/api/deadlines')).status, 200);
  assert.ok(h.errors.some((e) => e[0] === 'request failed:'));
});

test('a rejection after response headers destroys the response', async (t) => {
  const h = harness(t, { almanac: { handle: async (req, res) => { res.writeHead(200); res.write('partial'); throw new Error('late failure'); } } });
  const base = await listen(h.ctx.server);
  await assert.rejects(request(base, '/api/example'));
  assert.ok(h.errors.some((e) => e[0] === 'request failed:'));
});

test('process rejection handler logs without exiting', () => {
  const events = new EventEmitter(), logged = [];
  const line = source.split('\n').find((s) => s.startsWith("process.on('unhandledRejection'"));
  assert.ok(line);
  vm.runInNewContext(line, { process: events, console: { error: (...args) => logged.push(args) } });
  const error = new Error('background failure');
  events.emit('unhandledRejection', error);
  assert.equal(logged[0][1], error);
});

test('Origin guard allows Meridian pages and scripts, rejects foreign and null origins', (t) => {
  const { ctx } = harness(t);
  const allowed = (origin, host = '127.0.0.1:4980') => ctx.allowedOrigin({ headers: { host, ...(origin === undefined ? {} : { origin }) } });
  for (const origin of [undefined, 'http://127.0.0.1:4980', 'http://localhost:4980', 'http://[::1]:4980', 'https://studio.example.invalid', 'https://studio.example.invalid']) assert.equal(allowed(origin), true, String(origin));
  assert.equal(allowed('https://studio.example.invalid', 'studio.example.invalid'), true);
  assert.equal(allowed('http://100.64.0.5:4980', '100.64.0.5:4980'), true);
  for (const origin of ['null', '', 'https://[', 'file:///tmp/page', 'http://localhost:1234', 'https://foreign.ts.net', 'https://studio.example.invalid:444', 'https://user@studio.example.invalid', 'https://studio.example.invalid/path']) assert.equal(allowed(origin), false, origin);
});

test('central Origin guard blocks simple POSTs before routing, no-Origin calls still work', async (t) => {
  const h = harness(t); noRefresh(h);
  const base = await listen(h.ctx.server);
  for (const route of ['/api/captures', '/api/todos/clear-completed', '/api/feedback', '/api/brief-feedback']) {
    for (const origin of ['https://evil.example', 'null', 'https://[']) assert.equal((await request(base, route, 'POST', 'x', { Origin: origin, 'Content-Type': 'text/plain' })).status, 403);
  }
  assert.equal((await request(base, '/api/brief-feedback', 'POST', { id: 'board:one', action: 'complete' })).status, 200);
  assert.deepEqual(read(h.root, 'brief-feedback.json').completed, ['board:one']);
});

test('delegate and brief-feedback return 413 for oversized bodies', async (t) => {
  const h = harness(t), base = await listen(h.ctx.server);
  for (const route of ['/api/delegate', '/api/brief-feedback']) {
    assert.equal((await request(base, route, 'POST', JSON.stringify({ text: 'é'.repeat(11000) }))).status, 413);
    assert.equal((await request(base, route, 'POST', '{')).status, 400);
  }
});

test('JSON body reader preserves UTF-8 split across chunks and counts bytes', async (t) => {
  const { ctx } = harness(t);
  const req = new EventEmitter(), body = ctx.jsonBody(req, 12);
  const bytes = Buffer.from('{"x":"é"}');
  req.emit('data', bytes.subarray(0, 7)); req.emit('data', bytes.subarray(7)); req.emit('end');
  assert.equal((await body).x, 'é');
  const large = new EventEmitter(), rejected = ctx.jsonBody(large, 8);
  large.emit('data', bytes); large.emit('end');
  await assert.rejects(rejected, (e) => e.statusCode === 413);
});

test('concurrent deadline creates and patches keep every mutation', async (t) => {
  const h = harness(t); noRefresh(h);
  const base = await listen(h.ctx.server);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => request(base, '/api/deadlines', 'POST', { title: 'Deadline ' + i, due: '2026-10-10', track: 'uni' })));
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(read(h.root, 'deadlines.json').items.length, 20);
  const id = JSON.parse(results[0].body).item.id;
  const patches = await Promise.all([{ done: true }, { archived: true }, { note: 'kept' }].map((p) => request(base, '/api/deadlines/' + id, 'PATCH', p)));
  assert.ok(patches.every((r) => r.status === 200));
  const item = read(h.root, 'deadlines.json').items.find((i) => i.id === id);
  assert.equal(item.done, true); assert.equal(item.archived, true); assert.equal(item.note, 'kept');
  assert.equal((await request(base, '/api/deadlines/' + id, 'DELETE')).status, 200);
  assert.equal((await request(base, '/api/deadlines/' + id, 'DELETE')).status, 404);
});

test('concurrent prefs saves use separate temp files and preserve PUT replacement', async (t) => {
  const h = harness(t), base = await listen(h.ctx.server);
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => request(base, '/api/command/prefs', 'PUT', { n })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(typeof read(h.root, 'command-prefs.json').n, 'number');
  assert.ok(fs.readdirSync(path.join(h.root, 'data')).every((f) => !f.endsWith('.tmp')));
  await request(base, '/api/command/prefs', 'PUT', { replacement: true });
  assert.deepEqual(read(h.root, 'command-prefs.json'), { replacement: true });
});

test('concurrent brief feedback keeps every action', async (t) => {
  const h = harness(t), base = await listen(h.ctx.server);
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => request(base, '/api/brief-feedback', 'POST', { id: 'board:' + i, action: ['complete', 'reject', 'skip'][i % 3] })));
  assert.ok(results.every((r) => r.status === 200));
  const saved = read(h.root, 'brief-feedback.json');
  assert.equal(saved.completed.length, 8); assert.equal(saved.rejected.length, 8);
  assert.equal(Object.values(saved.skipped)[0].length, 8);
});

test('file queue recovers from rejection, atomic failure keeps old contents and removes temp', async (t) => {
  const h = harness(t);
  const file = path.join(h.root, 'data', 'atomic.json');
  fs.writeFileSync(file, '{"old":true}');
  await assert.rejects(h.ctx.queueFile(file, () => Promise.reject(new Error('failed'))));
  await h.ctx.queueFile(file, () => h.ctx.writeJsonAtomic(file, { kept: true }));
  const original = fs.readFileSync(file, 'utf8');
  h.ctx.fsp = { ...fsp, rename: async () => { throw new Error('rename failed'); } };
  await assert.rejects(h.ctx.writeJsonAtomic(file, { lost: true }), /rename failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['atomic.json']);
});

test('config writes keep a valid backup and recover a corrupt primary', async (t) => {
  const h = harness(t), file = path.join(h.root, 'config.json');
  fs.writeFileSync(file, '{"port":5001}');
  await h.ctx.saveConfig();
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak')), { port: 5001 });
  fs.writeFileSync(file, '{broken');
  assert.equal(h.ctx.readConfig(file).port, 5001);
  await h.ctx.saveConfig();
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak')), { port: 5001 });
  assert.equal(h.ctx.readConfig(file).port, 4980);
  assert.ok(h.errors.some((e) => e[0].startsWith('CONFIG RECOVERED')));
});

test('intake sync merges project changes onto the latest automation document', async (t) => {
  let h;
  const projects = [];
  const store = { read: async () => ({ projects }), create: async (project) => {
    const latest = read(h.root, 'brief-intake.json');
    latest.updatedAt = 'new snapshot'; latest.automation = { kept: true }; latest.invites = [{ id: 'invite' }]; latest.meetings = [{ id: 'meeting' }];
    latest.items[0].title = 'Updated title'; latest.items[0].respondedAt = 'today';
    latest.items.push({ id: 'two', source: 'slack', title: 'New automation item' });
    write(h.root, 'brief-intake.json', latest);
    const saved = { ...project, id: 'project-one' }; projects.push(saved); return saved;
  } };
  h = harness(t, { projectsStore: store });
  write(h.root, 'brief-intake.json', { items: [{ id: 'one', source: 'outlook', title: 'Original' }] });
  await h.ctx.syncBriefIntake();
  const saved = read(h.root, 'brief-intake.json');
  assert.equal(saved.items.length, 2); assert.equal(saved.items[0].projectId, 'project-one');
  assert.equal(saved.items[0].title, 'Updated title'); assert.equal(saved.items[0].respondedAt, 'today');
  assert.equal(saved.updatedAt, 'new snapshot'); assert.deepEqual(saved.automation, { kept: true });
  assert.equal(saved.invites[0].id, 'invite'); assert.equal(saved.meetings[0].id, 'meeting');
});

test('intake sync preserves automation rejections and removals', async (t) => {
  let h;
  h = harness(t, { projectsStore: { read: async () => ({ projects: [] }), create: async () => {
    write(h.root, 'brief-intake.json', { items: [{ id: 'one', source: 'outlook', status: 'rejected' }] });
    return { id: 'project-one' };
  } } });
  write(h.root, 'brief-intake.json', { items: [{ id: 'one', source: 'outlook' }, { id: 'removed', source: 'slack' }] });
  await h.ctx.syncBriefIntake();
  const saved = read(h.root, 'brief-intake.json');
  assert.equal(saved.items.length, 1); assert.equal(saved.items[0].status, 'rejected'); assert.equal(saved.items[0].projectId, null);
});

test('daemon intake mutations queue behind project creation and do not duplicate projects', async (t) => {
  const projects = [];
  const h = harness(t, { projectsStore: {
    read: async () => ({ projects }),
    create: async (p) => { await new Promise((r) => setTimeout(r, 10)); const item = { ...p, id: 'project-one' }; projects.push(item); return item; },
  } });
  write(h.root, 'brief-intake.json', { items: [{ id: 'one', source: 'outlook' }] });
  await Promise.all([h.ctx.syncBriefIntake(), h.ctx.syncBriefIntake(), h.ctx.markBriefIntakeDelegated('project-one')]);
  assert.equal(projects.length, 1); assert.equal(read(h.root, 'brief-intake.json').items[0].status, 'delegated');
});

test('malformed upstream redirects reject instead of escaping the response callback', async (t) => {
  const { ctx } = harness(t);
  const base = await upstream(t, (req, res) => { res.writeHead(302, { Location: 'https://[' }); res.end(); });
  await assert.rejects(ctx.fetchPage(base), /Invalid URL/);
});

test('fetch deadline stops a dripping response, and oversized or aborted bodies fail', async (t) => {
  const { ctx } = harness(t);
  const base = await upstream(t, (req, res) => {
    if (req.url === '/large') { res.end(Buffer.alloc(700000)); return; }
    if (req.url === '/aborted') { res.writeHead(200, { 'Content-Length': 100 }); res.write('short'); setImmediate(() => res.destroy()); return; }
    res.writeHead(200); res.write('a');
    const timer = setInterval(() => res.write('a'), 10);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  assert.equal((await ctx.fetchUrl(base, { timeout: 100 })).status, 0);
  assert.ok(Date.now() - started < 1500);
  assert.equal((await ctx.fetchUrl(base + '/large')).status, 0);
  assert.equal((await ctx.fetchUrl(base + '/aborted')).status, 0);
});

test('preview transitions allow only HTTP(S), including redirects and meta refreshes', async (t) => {
  const { ctx } = harness(t);
  const base = await upstream(t, (req, res) => {
    if (req.url === '/redirect-file') { res.writeHead(302, { Location: 'file:///etc/passwd' }); res.end(); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/meta-file' }); res.end(); }
    else if (req.url === '/safe') res.end('<meta http-equiv="refresh" content="0; url=/final">');
    else if (req.url === '/meta-file') res.end('<meta http-equiv="refresh" content="0; url=file:///etc/passwd">');
    else res.end('fine');
  });
  for (const url of ['file:///etc/passwd', 'data:text/html,test', base + '/meta-file', base + '/redirect-file', base + '/redirect']) assert.equal(await ctx.resolveMetaRefresh(url), null, url);
  assert.equal(await ctx.resolveMetaRefresh(base + '/safe'), base + '/final');
});

// Link previews use Chrome on a Mac only (previews connector); elsewhere nothing is spawned to fail.
test('Chrome spawn failure resolves false and cleans its profile and timers', { skip: process.platform !== 'darwin' && 'link previews are Mac-only' }, async (t) => {
  let profile;
  const h = harness(t, { spawn: (bin, args, opts) => {
    profile = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    return spawn(path.join(h.root, 'missing-chrome'), [], opts);
  } });
  // HAS_CHROME is fixed at startup; simulate removal after that check.
  h.run('screenshot = ' + source.slice(source.indexOf('async function screenshot('), source.indexOf('// Returns the cached preview path')).replace('if (!HAS_CHROME) return false;', ''));
  const base = await upstream(t, (req, res) => res.end('fine'));
  assert.equal(await h.ctx.screenshot(base, path.join(h.root, 'preview.png')), false);
  assert.ok(profile); assert.equal(fs.existsSync(profile), false);
});

test('stash streams handle removal between stat and open, both full and ranged', async (t) => {
  const h = harness(t);
  const file = path.join(h.root, 'file.txt');
  h.ctx.stash = { filePath: async () => ({ file, type: 'text/plain' }) };
  h.ctx.fs = { ...fs, createReadStream: (...args) => { fs.unlinkSync(file); return fs.createReadStream(...args); } };
  const base = await listen(h.ctx.server);
  for (const headers of [{}, { Range: 'bytes=0-2' }]) {
    fs.writeFileSync(file, 'hello');
    await assert.rejects(request(base, '/api/stash/abcdefgh/file', 'GET', undefined, headers));
  }
  assert.equal((await request(base, '/api/deadlines')).status, 200);
  assert.ok(h.errors.filter((e) => e[0] === 'stash stream failed:').length === 2);
});

test('fetched favicon and stash SVG icon responses carry isolation headers', async (t) => {
  const h = harness(t, { faviconFor: async () => ({ type: 'image/svg+xml', buffer: Buffer.from('<svg/>') }) });
  const file = path.join(h.root, 'icon.svg'); fs.writeFileSync(file, '<svg/>');
  h.ctx.stash = { filePath: async () => ({ file, type: 'image/svg+xml' }) };
  const base = await listen(h.ctx.server);
  for (const route of ['/api/favicon?url=https://example.org', '/api/stash/abcdefgh/icon']) {
    const r = await request(base, route);
    assert.equal(r.status, 200, route); assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
});

function slowClient() {
  return { blockedAt: 0, pending: null, bytes: 0, writes: [], closed: false,
    buffered() { return this.bytes; }, needsDrain() { return this.bytes > 0; },
    write(s) { this.writes.push(s); this.bytes += Buffer.byteLength(s); return false; }, close() { this.closed = true; },
  };
}
test('SSE coalesces backed-up state and drops oversized or persistently slow clients', (t) => {
  const h = harness(t), c = slowClient(); h.ctx.clients.add(c);
  h.ctx.sendSse(c, 'first', true);
  h.ctx.sendSse(c, 'second', true); h.ctx.sendSse(c, 'latest', true);
  assert.deepEqual(c.writes, ['first']); assert.equal(c.pending, 'latest');
  const blockedAt = c.blockedAt;
  h.ctx.sendSse(c, 'named event');
  assert.equal(c.blockedAt, blockedAt);
  c.bytes = 0; h.ctx.drainSse(c);
  assert.deepEqual(c.writes, ['first', 'named event', 'latest']);
  c.bytes = 3 * 1024 * 1024; h.ctx.sweepSse(); assert.equal(c.closed, true);
  const stuck = slowClient(); stuck.blockedAt = Date.now() - 61000; h.ctx.clients.add(stuck);
  h.ctx.sweepSse(); assert.equal(stuck.closed, true); assert.equal(h.ctx.clients.size, 0);
});

test('raw and gzip SSE deliver initial state promptly', async (t) => {
  const h = harness(t), base = await listen(h.ctx.server);
  h.run('state = { at: 1, value: "initial" };');
  for (const gz of [false, true]) {
    await new Promise((resolve, reject) => {
      let req;
      const timer = setTimeout(() => { req.destroy(); reject(new Error('initial SSE state delayed')); }, 2000);
      req = http.get(base + '/api/stream', { headers: gz ? { 'Accept-Encoding': 'gzip' } : {} }, (res) => {
        const stream = gz ? res.pipe(zlib.createGunzip()) : res;
        let data = '';
        stream.on('data', (c) => {
          data += c;
          if (data.includes('"value":"initial"')) { clearTimeout(timer); req.destroy(); resolve(); }
        });
        stream.on('error', reject);
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
});

test('gzip SSE exposes backpressure and total stream buffering', (t) => {
  const { ctx } = harness(t);
  const res = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {} });
  const client = ctx.gzipEventStream(res); ctx.clients.add(client);
  t.after(() => client.close());
  assert.equal(client.write('event: state\ndata: ' + 'x'.repeat(100000) + '\n\n'), false);
  assert.ok(client.buffered() >= 100000); assert.equal(client.needsDrain(), true);
});

test('gzip SSE drains consecutive state frames without the sweep timer', async (t) => {
  const h = harness(t), base = await listen(h.ctx.server);
  h.run('state = { at: Date.now(), marker: "first", text: "x".repeat(120000) };');
  await new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => { req.destroy(); reject(new Error('second compressed frame stalled')); }, 2000);
    req = http.get(base + '/api/stream', { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const stream = res.pipe(zlib.createGunzip()); let data = '', sent = false;
      stream.on('data', (chunk) => {
        data += chunk;
        if (!sent && data.includes('"marker":"first"') && data.endsWith('\n\n')) {
          sent = true;
          setImmediate(() => h.run('state.marker = "second"; broadcast();'));
        }
        if (data.includes('"marker":"second"')) { clearTimeout(timer); req.destroy(); resolve(); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
});

test('state HTTP reads share compression and invalidate after an in-place local update', async (t) => {
  let compressions = 0, strings = 0;
  const h = harness(t, {
    zlib: { ...zlib, gzip: (...args) => { compressions++; return zlib.gzip(...args); } },
    JSON: { parse: JSON.parse, stringify: (value, ...args) => { if (value?.marker === 'cache-fixture') strings++; return JSON.stringify(value, ...args); } },
    collectTailnet: async () => ({}), collectLocalServers: async () => [{ port: 5130 }], localCache: { at: 0 },
  });
  h.run('state = { at: Date.now(), marker: "cache-fixture", text: "x".repeat(2048), local: { servers: [] } };');
  const base = await listen(h.ctx.server);
  const replies = await Promise.all(Array.from({ length: 8 }, () => request(base, '/api/state', 'GET', undefined, { 'Accept-Encoding': 'gzip' }, true)));
  assert.equal(compressions, 1); assert.equal(strings, 1);
  assert.ok(replies.every((r) => r.status === 200 && r.headers['content-encoding'] === 'gzip'));
  const before = zlib.gunzipSync(replies[0].body).toString();
  assert.equal((await request(base, '/api/state')).body.toString(), before);
  assert.equal((await request(base, '/api/local')).status, 200);
  const after = await request(base, '/api/state', 'GET', undefined, { 'Accept-Encoding': 'gzip' }, true);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(after.body)).local.servers, [{ port: 5130 }]);
  assert.equal(compressions, 2); assert.equal(strings, 2);
});

test('a failed state compression can be retried without poisoning the cache', async (t) => {
  let compressions = 0;
  const h = harness(t, { zlib: { ...zlib, gzip: (body, callback) => {
    if (++compressions === 1) { queueMicrotask(() => callback(new Error('fixture compression failure'))); return; }
    return zlib.gzip(body, callback);
  } } });
  h.run('state = { at: Date.now(), text: "x".repeat(2048) };');
  const base = await listen(h.ctx.server), headers = { 'Accept-Encoding': 'gzip' };
  assert.equal((await request(base, '/api/state', 'GET', undefined, headers)).status, 500);
  const recovered = await request(base, '/api/state', 'GET', undefined, headers, true);
  assert.equal(recovered.status, 200);
  assert.equal(JSON.parse(zlib.gunzipSync(recovered.body)).text.length, 2048);
  assert.equal(compressions, 2);
});

test('phone state is opt-in, uses normal authorization and shares its own gzip cache', async (t) => {
  let compressions = 0;
  const h = harness(t, { zlib: { ...zlib, gzip: (...args) => { compressions++; return zlib.gzip(...args); } } });
  h.ctx.CONFIG.token = 'fixture-token';
  h.run('state = { at: Date.now(), todos: [{ id: "todo", title: "x".repeat(2048) }], calendar: { events: [] }, money: { private: true }, unused: "desktop" };');
  const base = await listen(h.ctx.server), headers = { 'Accept-Encoding': 'gzip' };
  assert.equal((await request(base, '/api/state?view=phone', 'GET', undefined, { 'tailscale-funnel-request': '?1' })).status, 403);
  const raw = await request(base, '/api/state?view=phone&t=fixture-token', 'GET', undefined, { 'tailscale-funnel-request': '?1' });
  const view = JSON.parse(raw.body);
  assert.equal(view.todos[0].id, 'todo'); assert.equal(view.money, undefined); assert.equal(view.unused, undefined);
  assert.equal(raw.headers['cache-control'], 'no-store');
  const compressed = await Promise.all(Array.from({ length: 8 }, () => request(base, '/api/state?view=phone', 'GET', undefined, headers, true)));
  assert.equal(compressions, 1);
  for (const reply of compressed) {
    assert.equal(reply.headers['content-encoding'], 'gzip'); assert.equal(reply.headers.vary, 'Accept-Encoding');
    assert.equal(zlib.gunzipSync(reply.body).toString(), raw.body);
  }
  const full = await request(base, '/api/state', 'GET', undefined, headers, true);
  assert.equal(JSON.parse(zlib.gunzipSync(full.body)).at, view.at);
  assert.equal(JSON.parse(zlib.gunzipSync(full.body)).money.private, true);
  assert.equal(compressions, 2);
  assert.equal((await request(base, '/api/state?view=unknown')).body, zlib.gunzipSync(full.body).toString());
  h.run('state.todos = [{ id: "new", title: "Changed" }]; broadcast();');
  assert.equal(JSON.parse((await request(base, '/api/state?view=phone')).body).todos[0].id, 'new');
});

test('refresh publishes source freshness and retains the section when a collector hangs', async (t) => {
  const h = harness(t, { createSources: options => {
    const tracker = require('../refresh').createSources(options);
    const collect = tracker.collect;
    tracker.collect = (name, fn, opts) => collect(name, fn, { ...opts, deadline: Date.now() + 15 });
    return tracker;
  } });
  let calls = 0;
  const hung = () => { calls++; return new Promise(() => {}); };
  h.run('state = { at: 1, board: { cards: [{ title: "stale" }] } };');
  const empty = async () => ({});
  Object.assign(h.ctx, {
    collectBoard: hung, collectAI: empty, collectFleet: empty, collectGit: async () => ({ repos: [] }), collectBrain: empty, collectThreads: empty,
    collectCalendar: async () => ({ events: [] }), collectSystem: empty, collectLedger: empty, collectMeetings: empty, collectDrift: empty, collectDelegations: empty,
    collectSmokingSnapshot: empty, collectLocalServers: async () => [], collectLinks: empty, collectExampleappFeedback: empty,
    JSF_EMPTY: {}, collectTailnet: empty, updateLearning: empty, collectPulse: empty, syncJournalFromLedger: empty,
    todaySoFar: () => ({}), syncTodoDelegations: async () => [], notifyTransitions: empty, readNotificationLog: async () => [],
    meetingNudges: { mergeMeetings: () => ({ events: [], invites: [], unmatched: [] }) },
    heartHealth: { collect: () => ({}), source: () => ({}) }, engineLabels: () => [], defaultModelLabel: () => 'default',
    vaultJournalDir: () => h.root, nudgeSettings: () => ({}), github: { get: () => ({}), source: () => ({}) },
    ranker: { peek: () => null, source: () => ({}), maybeRefresh() {} }, HAS_CHROME: false,
  });
  const result = await h.ctx.refreshState();
  assert.ok(result.at > 1); assert.equal(result.board.cards[0].title, 'stale');
  assert.equal(result.sources.board.stale, true); assert.equal(result.sources.board.lastSuccess, null);
  assert.match(result.sources.board.error, /budget/); assert.equal(typeof result.sources.board.durationMs, 'number');
  assert.ok(h.errors.some((e) => e[0] === 'collector board failed:'));
  const next = await h.ctx.refreshState(); assert.equal(calls, 1); assert.match(next.sources.board.error, /still running/);
});

test('Funnel traffic needs the token; Serve traffic from the tailnet does not', async (t) => {
  const h = harness(t);
  h.ctx.CONFIG.token = 'dashboard-token';
  const base = await listen(h.ctx.server);
  assert.equal((await request(base, '/api/deadlines', 'GET', undefined, { 'x-forwarded-for': '100.80.0.85' })).status, 200);
  assert.equal((await request(base, '/api/deadlines', 'GET', undefined, { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' })).status, 403);
  assert.equal((await request(base, '/api/deadlines?t=dashboard-token', 'GET', undefined, { 'tailscale-funnel-request': '?1' })).status, 200);
});

test('a committed to-do during state assembly appears in the queued pass before the refresh promise resolves', async t => {
  let release, entered; const blocked = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const rows = []; let passes = 0;
  const h = harness(t, { todosStore: { create: async input => { const todo = { id: 'new', ...input }; rows.push(todo); return todo; } } });
  const empty = async () => ({});
  Object.assign(h.ctx, {
    collectBoard: async () => ({ cards: [] }), collectAI: empty, collectFleet: empty, collectGit: async () => ({ repos: [] }), collectBrain: empty, collectThreads: empty,
    collectCalendar: async () => ({ events: [] }), collectSystem: empty, collectLedger: empty, collectMeetings: empty, collectDrift: empty, collectDelegations: empty,
    collectSmokingSnapshot: empty, collectLocalServers: async () => [], collectLinks: empty, collectExampleappFeedback: empty,
    JSF_EMPTY: {}, collectTailnet: empty, updateLearning: empty, collectPulse: empty, syncJournalFromLedger: empty,
    todaySoFar: () => ({}), syncTodoDelegations: async () => rows.slice(), notifyTransitions: empty,
    readNotificationLog: async () => { if (++passes === 1) { entered(); await blocked; } return []; },
    meetingNudges: { mergeMeetings: () => ({ events: [], invites: [], unmatched: [] }) },
    heartHealth: { collect: () => ({}), source: () => ({}) }, engineLabels: () => [], defaultModelLabel: () => 'default',
    vaultJournalDir: () => h.root, nudgeSettings: () => ({}), github: { get: () => ({}), source: () => ({}) },
    ranker: { peek: () => null, source: () => ({}), maybeRefresh() {} }, HAS_CHROME: false,
  });
  const base = await listen(h.ctx.server), pending = h.ctx.refreshState(); await reached;
  const response = await request(base, '/api/todos', 'POST', { title: 'Committed during refresh' }); assert.equal(response.status, 201);
  release(); const state = await pending; assert.equal(passes, 2); assert.equal(state.todos[0].title, 'Committed during refresh');
});

test('a calendar edit during a fetch invalidates its cache for the immediate queued pass', async () => {
  let release; const blocked = new Promise(r => { release = r; }); let calls = 0, invalidated = 0;
  const code = section('async function collectCalendar()', '// ---------------------------------------------------------------- Campaign Snapshot');
  const ctx = vm.createContext({ CONFIG: { calendar: {} }, calCache: { at: 0 }, calendarVersion: 0, CAL_LIMIT: 80, Date, runtime: { portableProfile: () => false },
    parseIcsFeed: () => [], connectInfo: { bust: () => { invalidated++; } },
    calendars: { collect: async () => { calls++; if (calls === 1) await blocked; return { configured: true, events: [{ ts: calls }], calendars: [] }; } },
  });
  const refresh = require('../refresh').createRefresh(() => ctx.collectCalendar()); ctx.refreshState = refresh;
  vm.runInContext(code, ctx); const pending = refresh(); await Promise.resolve(); const edited = ctx.refreshCalendarNow(); release();
  const result = await pending; await edited; assert.equal(calls, 2); assert.equal(invalidated, 1); assert.equal(result.events[0].ts, 2);
});

test('a section mutation marks the current refresh dirty even when its collector is already running', async t => {
  let release, entered; const blocked = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const h = harness(t); let data = 'before', calls = 0;
  h.ctx.fixtureRead = async () => { const value = data; calls++; if (calls === 1) { entered(); await blocked; } return value; };
  h.run("refreshLiveState = async () => { const value = await sources.collect('links', fixtureRead); state = { at: Date.now(), links: value }; return state; };");
  const p = h.ctx.refreshState(); await reached; data = 'after';
  const mutation = h.ctx.collectForState('links', h.ctx.fixtureRead, 'before'); release(); await mutation;
  assert.equal((await p).links, 'after'); assert.equal(calls, 2);
});
