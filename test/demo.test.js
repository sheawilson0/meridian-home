'use strict';

// Demo mode must never show Owner's real work. This walks every answer the
// command centre page can get from /api/demo/* and fails on any real name,
// client, host or address in it (keys and values, any case).

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createDemo, buildState, PASS } = require('../demo');

const DENY = [/studio\.example\.invalid/i, /ts\.net/i, /\/Users\/(?!example)/, /100\.106\./];
const DENY_HASHES = new Set(["99c215a550764c2780c71503ed7dc36d355bcedbfef9df641c2fa91b335443ed", "3eeb392534465e0a766b2e454473985aa07c2a830790a510f99e33b484437e0e", "d8ede17963b124dfd54dea131816f4dbf3555683d540b61ec6a2636df93fe30a", "f132cdfc463c4adc6c0c3704ffa629ad42db37e05a75f105e6d21aac4c369250", "e2411f90645028dcc34736979c69cbc60de689676b86f685d0b87ca8d110caad", "72fe5c6d96b2e276d5323e13c0bc7c338247c626d913ce3214e36053e11f8be6", "c335aa7b888138f1ded9a4dc66f3eceabf8f5159fecce8dbd2284b1ac185a320", "bb20f1edc87f7570445f645243832e0f226398f9a96b41bb064284dbed1c6238", "2272edd0cf5d3f84d3b092ab4aef7ce946ab5e9f6b3e521d71f80c43cd549039", "4a2b5e1822ca11588586eb912320817f3cf0c11cd5ec8937e78a8209505f4e84", "904294d8c54b1c63e40832fa1d95bcde534b310df6d42882ce4baf28f3e0184a", "119c9ae6f9ca741bd0a76f87fba0b22cab5413187afb2906aa2875c38e213603", "ec2206809a1860d13839a867afd06127ccccae94e3565f652cc03441223f3f83", "6a735a3f6318bc90f6ee067564fba29c4a7e9ef4ca03e7ae559b30fc62692cb0", "4d92b55b3ea940ac848fca61d8dedbd96371b0c3856bdddbcd6113f36538208c", "bb44bf07cf9a2db0554bba63a03d822c927deae77df101874496df5a6a3e896d", "0f22a1b6ff348f9fb9029a52198b16cefe071b721a6c83eed270bfb28258dcbe", "6df23ccc3ac208e59b0fb23099a8a8c3ec2a73e6b7e149e4b94d5e62fc582068", "0ac63ffb88d7b3b37b7f0081cc4a9c42a79ee12d5d38a807e1929d9c6e2b3d6a", "21feeb544c6a5bb78afe4996acfe846ad1ff15558b051998ad097cc009e99df9", "49fbe9b03a5e67d08f5ee0e8b249e68172705ce9e9319efd8ac8e8edb8b7ce5d", "d04baed6caa39c30437152ad7397ba610259357c44130915f141501479d99dca", "f4f75df8c8c87ed6bee1a2297be6d06e1a150cea6db7e1780f1fa607ae70097c"]);

function leaks(value, where = '$', out = []) {
  const check = (s, at) => {
    for (const re of DENY) if (re.test(s)) out.push(`${at}: private pattern`);
    const words = String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
    for (let i = 0; i < words.length; i++) for (let n = 1; n <= 4 && i + n <= words.length; n++) if (DENY_HASHES.has(require('node:crypto').createHash('sha256').update(words.slice(i, i + n).join('')).digest('hex'))) out.push(`${at}: private identity`);
  };
  if (typeof value === 'string') check(value, where);
  else if (Array.isArray(value)) value.forEach((v, i) => leaks(v, `${where}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { check(k, `${where}.${k} (key)`); leaks(v, `${where}.${k}`, out); }
  return out;
}

const ENGINES = () => ({ labels: ['Opus 5.5 · High', 'GPT-6 Luna · High'], default: 'Opus 5.5 · High' });

function serve(demo) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const r = await demo.handle(req, res, url);
    if (r !== true) { res.writeHead(299, { 'Content-Type': 'text/plain' }); res.end(String(r)); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('the demo state has the real shape and nothing real in it, at any time of day', () => {
  for (const h of [0, 7, 9, 13, 18, 23]) {
    const now = new Date(2026, 9, 6, h, 37).getTime();
    const s = buildState(now, { engines: ENGINES });
    assert.deepEqual(leaks(s), [], `state at ${h}:37`);
    for (const k of ['at', 'calendar', 'ai', 'fleet', 'local', 'links', 'todos', 'deadlines', 'delegations', 'github', 'invites', 'nudges', 'projects', 'briefIntake', 'journalToday', 'ledger', 'notify', 'capabilities', 'engines']) assert.ok(k in s, `state.${k}`);
    assert.equal(s.ai.sessions.filter((x) => x.live).length, 2, 'two agents working now');
    assert.ok(s.calendar.events.length >= 6);
    assert.ok(s.calendar.events.every((e) => e.calendar && e.color && e.cal), 'every event has a calendar and colour');
    assert.ok(s.calendar.events.some((e) => e.ts > now && e.ts - now <= 60 * 60000), 'a meeting within the hour');
    assert.deepEqual(new Set(s.todos.filter((t) => !t.done).map((t) => t.priority)), new Set(['now', 'next', 'later']));
    assert.ok(!('campaignSnapshot' in s) && !('heartHealth' in s) && !('exampleappFeedback' in s));
    assert.ok(s.delegations.runs.some((r) => r.kind === 'feedback' && r.status === 'running'));
  }
});

test('demo.js reads nothing from disk and no config', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'demo.js'), 'utf8');
  assert.ok(!/require\(['"](fs|fs\/promises|child_process|os)['"]\)/.test(src), 'no fs, child_process or os');
  assert.ok(!/config\.json|CONFIG/.test(src));
});

test('every GET the page makes answers with made-up data only', async () => {
  const { server, base } = await serve(createDemo({ engines: ENGINES }));
  try {
    const json = ['state', 'links', 'journal', 'ai-usage/ledger', 'ai-usage', 'ai-usage/plans', 'usage', 'todos', 'deadlines', 'github', 'local', 'projects',
      'stash', 'stash?q=northwind', 'stash?kind=screenshot', 'stash?space=uni', 'stash?order=shuffle', 'stash/demo0001', 'stash/demo0001/similar', 'link-meta?url=https%3A%2F%2Fwww.example.org%2Fx', 'money', 'money/status'];
    for (const p of json) {
      const r = await fetch(`${base}/api/demo/${p}`);
      assert.equal(r.status, 200, p);
      const body = await r.json();
      assert.deepEqual(leaks(body), [], p);
      if (p.startsWith('stash')) assert.equal(body.ok, true, p);
    }
    const money = await (await fetch(`${base}/api/demo/money`)).json();
    assert.ok(money.monzo.transactions.length > 100 && money.t212.positions.length && money.history.length > 30 && money.rules.salary.length, 'same shape as money.js');
    const ledger = await (await fetch(`${base}/api/demo/ai-usage/ledger`)).json();
    assert.ok(ledger.rows.length > 100 && ledger.plans.length && ledger.models && ledger.fx && ledger.history, 'same shape as ai-usage-ledger.js');
    const today = new Date(); const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.ok(ledger.rows.some((r) => r.date === day), 'usage up to today');

    for (const p of ['journal/report?format=md', 'journal/report?format=csv&track=work']) {
      const r = await fetch(`${base}/api/demo/${p}`);
      assert.equal(r.status, 200);
      assert.deepEqual(leaks(await r.text()), [], p);
    }
    const thumb = await fetch(`${base}/api/demo/stash/demo0001/thumb`);
    assert.equal(thumb.headers.get('content-type'), 'image/svg+xml');
    assert.match(await thumb.text(), /^<svg /);
    for (const p of ['favicon?link=x', 'preview?link=x', 'stash/demo0001/icon', 'heart-health', 'preferences', 'connect', 'calendars', 'brain/search?q=x', 'nope']) {
      assert.equal((await fetch(`${base}/api/demo/${p}`)).status, 404, `${p} is not served in the demo`);
    }
  } finally { server.close(); }
});

test('the stream sends one made-up state, then only keep-alives', async () => {
  const { server, base } = await serve(createDemo({ engines: ENGINES }));
  try {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/demo/stream`, { signal: ctrl.signal });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const reader = r.body.getReader();
    let text = '';
    while (!text.includes('\n\n', text.indexOf('event: state'))) { const { value } = await reader.read(); text += Buffer.from(value).toString(); }
    const data = JSON.parse(text.split('event: state\ndata: ')[1].split('\n\n')[0]);
    assert.deepEqual(leaks(data), []);
    assert.equal(data.demo, true);
    ctrl.abort();
  } finally { server.close(); }
});

test('only the listed public GETs pass through; writes change nothing and say ok', async () => {
  const { server, base } = await serve(createDemo({ engines: ENGINES }));
  try {
    for (const [p, real] of [['engines', '/api/engines'], ['almanac', '/api/almanac'], ['almanac/image/earthview?d=1', '/api/almanac/image/earthview?d=1'], ['daily-art/image', '/api/daily-art/image'], ['command/prefs?t=abc', '/api/command/prefs?t=abc']]) {
      const r = await fetch(`${base}/api/demo/${p}`);
      assert.equal(r.status, 299, p);
      assert.equal(await r.text(), real);
    }
    for (const p of ['daily-art', 'art-ratings', 'ai-usage/refresh', 'calendars', 'stash/file']) {
      assert.notEqual((await fetch(`${base}/api/demo/${p}`)).status, 299, `${p} must not reach the real route`);
    }
    assert.ok(!PASS.some((re) => re.test('/api/state')));

    const post = async (p, body, method = 'POST') => { const r = await fetch(`${base}/api/demo/${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [code, j] = await post('todos', { title: 'Try the demo' });
    assert.equal(code, 201); assert.equal(j.ok, true); assert.equal(j.todo.title, 'Try the demo'); assert.match(j.todo.id, /^[a-f0-9-]{36}$/);
    [, j] = await post('links', { url: 'https://example.org/', title: 'Example' }); assert.equal(j.link.title, 'Example'); assert.ok(j.link.id);
    [, j] = await post('capture', { text: 'a note' }); assert.ok(j.ok && j.id);
    [, j] = await post('feedback', { text: 'fix it' }); assert.ok(j.ok && j.id);
    [, j] = await post('stash', { text: 'https://example.org/a' }); assert.equal(j.item.kind, 'link'); assert.match(j.item.id, /^[a-z0-9]{8,20}$/);
    [, j] = await post('local/share', { port: 3000 }); assert.equal(j.url, 'https://studio-mac.tailnet.example:13000/');
    [, j] = await post('command/prefs', { look: {} }, 'PUT'); assert.equal(j.ok, true);
    [, j] = await post('todos/abc/delegate', { model: 'x' }); assert.ok(j.id && j.todo);
    [, j] = await post('stash/demo0002', { title: 'Renamed' }, 'PATCH'); assert.equal(j.item.title, 'Renamed');
    [, j] = await post('links/abc', undefined, 'DELETE'); assert.equal(j.ok, true);
    const big = await fetch(`${base}/api/demo/stash/file?name=a.png`, { method: 'POST', headers: { 'X-Stash': '1', 'Content-Type': 'image/png' }, body: Buffer.alloc(600 * 1024) });
    assert.equal((await big.json()).ok, true, 'an upload is read and dropped');
  } finally { server.close(); }
});

test('the leak check itself catches planted names, in keys and deep values', () => {
  assert.equal(leaks({ a: [{ b: 'Meet Avery at 3' }] }).length, 1);
  assert.equal(leaks({ 'studio.example.invalid': 1 }).length >= 2, true);
  assert.equal(leaks({ title: 'COURSE102 Research and Writing' }).length, 1);
  assert.deepEqual(leaks({ title: 'DES502 Practice and Research', who: 'Tom Reid' }), []);
});
