'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { phoneState } = require('../phone-state');
const { buildState } = require('../demo');
const { createSandboxes } = require('../tester/sandbox');
const source = fs.readFileSync(path.join(__dirname, '../public/phone.js'), 'utf8');
const basics = source.slice(0, source.indexOf('/* ---------- look:'));
const data = source.slice(source.indexOf("let S = store.get('state'"), source.indexOf('/* ---------- the shell'));
const full = buildState(Date.UTC(2026, 9, 8, 10));
const projected = JSON.parse(JSON.stringify(phoneState(full)));
const response = body => ({ ok: true, json: async () => body });

function client(fetcher, { search = '?lab', cached } = {}) {
  const calls = [], timers = new Map(), storage = new Map(), elements = new Map();
  let next = 0, renders = 0;
  if (cached) storage.set('meridian.phone.state', JSON.stringify(cached));
  const context = {
    URLSearchParams, AbortController, Response, Date, location: { search }, navigator: { onLine: true },
    document: { querySelector: s => { if (!elements.has(s)) elements.set(s, {}); return elements.get(s); } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => fn(), render: () => renders++,
    fetch: async (url, opts) => { calls.push({ url, opts }); return fetcher(url, opts, calls.length); },
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(basics + '\n' + data, context);
  return { context, calls, timers, storage, elements, renders: () => renders, state: () => vm.runInContext('S', context) };
}

test('projection is the only state read, with no-store and the existing token', async () => {
  const c = client(() => response(projected), { search: '?lab&t=fixture' });
  assert.equal(await c.context.getState(), projected);
  assert.deepEqual(c.calls.map(x => x.url), ['/api/state?view=phone&t=fixture']);
  assert.equal(c.calls[0].opts.cache, 'no-store'); assert.equal(c.timers.size, 0);
});

test('missing projection sections fall back to full state under one deadline and signal', async () => {
  for (const malformed of [null, {}, { at: 1 }, { ...projected, calendar: {} }, { ...projected, ai: { sessions: null } }]) {
    const c = client((url, opts, n) => {
      assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].ms, 8000);
      return response(n === 1 ? malformed : full);
    });
    assert.equal(await c.context.getState(), full);
    assert.deepEqual(c.calls.map(x => x.url), ['/api/state?view=phone', '/api/state']);
    assert.equal(c.calls[0].opts.signal, c.calls[1].opts.signal); assert.equal(c.timers.size, 0);
  }
});

test('an unsupported endpoint or invalid JSON can use the older full-state endpoint', async () => {
  for (const first of [{ ok: false, status: 404 }, { ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }]) {
    const c = client((url, opts, n) => n === 1 ? first : response(full));
    assert.equal(await c.context.getState(), full); assert.equal(c.calls.length, 2); assert.equal(c.timers.size, 0);
  }
});

test('a stalled projection body aborts at eight seconds without starting another deadline', async () => {
  const c = client((url, opts) => ({ ok: true, json: () => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) }));
  const pending = c.context.getState();
  await new Promise(resolve => setImmediate(resolve));
  [...c.timers.values()][0].fn();
  await assert.rejects(pending, /aborted/);
  assert.equal(c.calls.length, 1); assert.equal(c.timers.size, 0);
});

test('a stalled full-state fallback body shares the projection deadline', async () => {
  const c = client((url, opts, n) => n === 1 ? response({}) : { ok: true, json: () => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const pending = c.context.getState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.calls.length, 2);
  [...c.timers.values()][0].fn();
  await assert.rejects(pending, /aborted/);
  assert.equal(c.calls[0].opts.signal, c.calls[1].opts.signal); assert.equal(c.timers.size, 0);
});

test('old full-state cache survives failed reads, then refreshes in the same storage key', async () => {
  let fail = true;
  const c = client(url => {
    if (url.startsWith('/api/state')) { if (fail) throw new Error('offline'); return response(projected); }
    return response({});
  }, { cached: full });
  const old = JSON.stringify(c.state());
  await c.context.load();
  assert.equal(JSON.stringify(c.state()), old);
  assert.match(c.elements.get('#offline').textContent, /showing the last copy/);
  assert.equal(c.storage.get('meridian.phone.state'), JSON.stringify(full));
  fail = false; await c.context.load();
  assert.equal(c.state(), projected); assert.equal(c.elements.get('#offline').hidden, true);
  const saved = JSON.parse(c.storage.get('meridian.phone.state'));
  assert.deepEqual(saved.calendar.events, projected.calendar.events);
  assert.equal(saved.at, projected.at); assert.equal(saved.money, undefined); assert.ok(c.renders() > 0);
});

test('tester worlds tolerate an ignored view query and incomplete classic state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-tester-'));
  try {
    const sb = createSandboxes({ dir, now: () => Date.UTC(2026, 9, 8, 10) });
    for (const world of ['sam', 'blank']) {
      sb.reset('fixture', { world });
      const state = sb.state('fixture');
      const c = client(() => response(state));
      assert.equal(await c.context.getState(), state);
      assert.ok(c.calls.length <= 2); assert.equal(c.calls[0].url, '/api/state?view=phone');
      if (!c.context.phoneStateShape(state)) assert.equal(c.calls[1].url, '/api/state');
    }
    await sb.remove('fixture');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('demo mode keeps the existing demo endpoint and its separate cache', async () => {
  const c = client(() => response(full), { search: '?lab&demo&t=fixture' });
  assert.equal(await c.context.getState(), full);
  assert.deepEqual(c.calls.map(x => x.url), ['/api/demo/state?t=fixture']);
  vm.runInContext('store', c.context).set('state', full);
  assert.equal(c.storage.get('meridian.phone.demo.state'), JSON.stringify(full));
  assert.equal(c.storage.has('meridian.phone.state'), false); assert.equal(c.timers.size, 0);
});
