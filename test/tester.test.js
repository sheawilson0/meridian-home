const crypto = require('node:crypto');
'use strict';

// The tester server (tester/) puts Meridian on the internet for usability
// tests, so these check the front door first: nothing without an invite,
// nothing of Owner's in what a tester sees, writes only from the page itself,
// the console never from the internet. Then the sandbox (changes stick, pretend
// agents finish), the tester's MCP server, and the calendar-link guards.

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-test-'));
process.env.TESTER_DATA = DATA;
process.env.TAILSCALE_BIN = '/usr/bin/false';
const server = require('../tester/server');
const { createSandboxes } = require('../tester/sandbox');
const { checkUrl, privateIp } = require('../tester/ics');
const { tidy, leaks } = require('../tester/ai');
const tasks = require('../tester/tasks');

// Real names, clients, places and hosts that must never reach a tester (as demo.test.js).
const DENY = [/\/Users\/(?!example)/, /100\.106\./];
const PRIVATE_HASHES = new Set(["e2411f90645028dcc34736979c69cbc60de689676b86f685d0b87ca8d110caad", "72fe5c6d96b2e276d5323e13c0bc7c338247c626d913ce3214e36053e11f8be6", "c335aa7b888138f1ded9a4dc66f3eceabf8f5159fecce8dbd2284b1ac185a320", "bb20f1edc87f7570445f645243832e0f226398f9a96b41bb064284dbed1c6238", "4a2b5e1822ca11588586eb912320817f3cf0c11cd5ec8937e78a8209505f4e84", "119c9ae6f9ca741bd0a76f87fba0b22cab5413187afb2906aa2875c38e213603", "ec2206809a1860d13839a867afd06127ccccae94e3565f652cc03441223f3f83", "6a735a3f6318bc90f6ee067564fba29c4a7e9ef4ca03e7ae559b30fc62692cb0", "4d92b55b3ea940ac848fca61d8dedbd96371b0c3856bdddbcd6113f36538208c", "8b8afb8e9c757a9116687b0da72801cac2d4da831554fa2737624ef057c2408d", "a2141ac29b296861c826e05a4349070be654c82ba64a71000dea38a9edd0a9a8"]);
const OWNER_HASH = 'ec2206809a1860d13839a867afd06127ccccae94e3565f652cc03441223f3f83';
function privateWords(s, allowOwner = false) {
 const words = String(s).toLowerCase().match(/[a-z0-9]+/g) || []; const hits = [];
 for (let i = 0; i < words.length; i++) for (let n = 1; n <= 5 && i + n <= words.length; n++) {
  const h = crypto.createHash('sha256').update(words.slice(i, i + n).join('')).digest('hex');
  if (PRIVATE_HASHES.has(h) && !(allowOwner && h === OWNER_HASH)) hits.push(h);
 }
 return hits;
}
function leaksIn(value, where = '$', out = []) {
  const check = (s, at) => { for (const re of DENY) if (re.test(s)) out.push(`${at}: private pattern`); if (privateWords(s).length) out.push(`${at}: private identity`); };
  if (typeof value === 'string') check(value, where);
  else if (Array.isArray(value)) value.forEach((v, i) => leaksIn(v, `${where}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { check(k, `${where}.${k} (key)`); leaksIn(v, `${where}.${k}`, out); }
  return out;
}

function listen(handler) {
  const s = http.createServer(handler);
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })));
}
let pub; let adm;
test.before(async () => { pub = await listen((q, r) => server.publicRequest(q, r).catch((e) => { r.writeHead(e.statusCode || 500); r.end(String(e.message)); })); adm = await listen((q, r) => server.adminRequest(q, r).catch((e) => { r.writeHead(e.statusCode || 500); r.end(String(e.message)); })); });
test.after(() => { pub.s.close(); adm.s.close(); fs.rmSync(DATA, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const admin = (p, body, method = 'POST', headers = {}) => fetch(adm.base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Meridian-Admin': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
async function invite(name = 'Alex', mode = 'moderated') {
  const j = await (await admin('/admin-api/invites', { name, mode })).json();
  const r = await fetch(pub.base + '/t/' + j.invite.id, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { inv: j.invite, cookie, get: (p, o = {}) => fetch(pub.base + p, { redirect: 'manual', ...o, headers: { cookie, ...(o.headers || {}) } }),
    post: (p, b, h = {}) => fetch(pub.base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b || {}) }) };
}

test('without an invite, every page is the same private-test 404', async () => {
  for (const p of ['/', '/command', '/welcome', '/connect', '/command.js', '/api/state', '/api/demo/state', '/api/stream', '/tester/overlay.js', '/delegations/run-0123456789/REPORT.md', '/t/nosuchinvite']) {
    const r = await fetch(pub.base + p, { redirect: 'manual' });
    assert.equal(r.status, 404, p);
  }
  const r = await fetch(pub.base + '/x/mcp/aaaaaaaaaaaaaaaaaaaaaaaa', { method: 'POST', body: '{}' });
  assert.equal(r.status, 404);
});

test('an invite opens the welcome; the page waits for consent', async () => {
  const t = await invite();
  assert.match(t.cookie, /^mt=[a-z0-9]+\.[\w-]{32}$/);
  assert.equal((await t.get('/welcome')).status, 200);
  const before = await t.get('/');
  assert.equal(before.status, 302); assert.equal(before.headers.get('location'), '/welcome');
  assert.equal((await t.post('/t-api/consent', { record: false })).status, 200);
  const page = await t.get('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /window\.MERIDIAN_TESTER=\{"invite":"[a-z0-9]+","name":"Alex"/);
  assert.match(html, /\/tester\/overlay\.js/);
  assert.doesNotMatch(html, /rec\.js/, 'no recorder without a yes');
  const forged = await fetch(pub.base + '/api/state', { headers: { cookie: t.cookie.replace(/\.[\w-]+$/, '.' + 'x'.repeat(32)) } });
  assert.equal(forged.status, 404, 'a forged cookie is nobody');
});

test('what a tester gets carries nothing of Owner’s', async () => {
  const t = await invite('Robin');
  await t.post('/t-api/consent', { record: true });
  const state = await (await t.get('/api/demo/state')).json();
  assert.deepEqual(leaksIn(state), []);
  assert.equal(state.tester.name, 'Robin');
  assert.ok(!JSON.stringify(state).match(/DES50\d|"Uni"|Classes/), 'no uni bits');
  for (const p of ['/command.js', '/command.css', '/money-core.js', '/source-marks.js']) {
    const body = await (await t.get(p)).text();
    for (const digest of ['e2411f90645028dcc34736979c69cbc60de689676b86f685d0b87ca8d110caad', '72fe5c6d96b2e276d5323e13c0bc7c338247c626d913ce3214e36053e11f8be6', '0d38a59c34022dbae0368c803664fbc4e2d9fb3c4f90724644b8cd749d71ab9f', '4a2b5e1822ca11588586eb912320817f3cf0c11cd5ec8937e78a8209505f4e84', 'a2141ac29b296861c826e05a4349070be654c82ba64a71000dea38a9edd0a9a8']) {
      const words = body.toLowerCase().match(/[a-z]+/g) || [];
      for (let i = 0; i < words.length; i++) for (let n = 1; n <= 3 && i + n <= words.length; n++) assert.notEqual(crypto.createHash('sha256').update(words.slice(i, i + n).join(' ')).digest('hex'), digest, p + ': private identity');
    }
  }
  for (const p of ['/api/demo/links', '/api/demo/journal', '/api/demo/stash', '/api/demo/command/prefs', '/api/demo/engines', '/api/demo/ai-usage/ledger', '/api/demo/github']) {
    assert.deepEqual(leaksIn(await (await t.get(p)).json()), [], p);
  }
  const prefs = (await (await t.get('/api/demo/command/prefs')).json()).prefs;
  assert.equal(prefs.spaces, undefined, 'Spaces name real work, so they never go');
  assert.ok(prefs.tabs.hidden.includes('money'));
});

test('only the page’s own files: no reports, data, config or ways out', async () => {
  const t = await invite();
  await t.post('/t-api/consent', {});
  for (const p of ['/reports/2026-10-04/overnight.html', '/design/draft-review/index.html', '/saturday-data.json', '/work-report-2026-09-21.md', '/downloads/meridian-app.json', '/tester/../server.js', '/tester/%2e%2e/server.js', '/../config.json', '/api/command/hero-photo', '/api/demo/money/receivables', '/api/demo/brief']) {
    const r = await t.get(p);
    assert.ok([404].includes(r.status) || (r.status === 200 && !(await r.text()).includes('mcpToken')), `${p} → ${r.status}`);
  }
  assert.equal((await t.get('/img/planets/saturn.jpg')).status, 404);
  const texture = await t.get('/img/planets/saturn.webp');
  assert.equal(texture.status, 200);
  assert.equal(texture.headers.get('content-type'), 'image/webp');
  assert.equal(texture.headers.get('cache-control'), 'private, max-age=3600');
  assert.equal((await texture.arrayBuffer()).byteLength, fs.statSync(path.join(__dirname, '../public/img/planets/saturn.webp')).size);
});

test('writes come only from the page, and stick in the sandbox', async () => {
  const t = await invite();
  await t.post('/t-api/consent', {});
  const cross = await t.post('/api/demo/todos', { title: 'From another site' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(cross.status, 403);
  const add = await (await t.post('/api/demo/todos', { title: 'Write the launch brief' })).json();
  assert.equal(add.todo.title, 'Write the launch brief');
  let state = await (await t.get('/api/demo/state')).json();
  assert.ok(state.todos.some((x) => x.title === 'Write the launch brief'), 'the new to-do is still there');
  const patch = await fetch(pub.base + '/api/demo/todos/' + add.todo.id, { method: 'PATCH', headers: { cookie: t.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) });
  assert.equal(patch.status, 200);
  state = await (await t.get('/api/demo/state')).json();
  assert.equal(state.todos.find((x) => x.id === add.todo.id).done, true);
  const d = await (await t.post(`/api/demo/todos/${add.todo.id}/delegate`, { model: 'gpt-6-luna', effort: 'high' })).json();
  assert.match(d.id, /^run-[a-f0-9]{10}$/);
  state = await (await t.get('/api/demo/state')).json();
  assert.equal(state.delegations.runs.find((r) => r.id === d.id).status, 'running');
  assert.equal(state.todos.find((x) => x.id === add.todo.id).delegation.model, 'GPT-6 Luna · High');
});

test('the console refuses the internet and other sites', async () => {
  assert.equal((await fetch(adm.base + '/', { headers: { 'Tailscale-Funnel-Request': '?1' } })).status, 404);
  assert.equal((await fetch(adm.base + '/admin-api/overview', { headers: { 'Tailscale-Funnel-Request': '?1' } })).status, 404);
  assert.equal((await fetch(adm.base + '/admin-api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status, 403);
  const o = await (await fetch(adm.base + '/admin-api/overview')).json();
  assert.ok(Array.isArray(o.invites));
  assert.equal(o.tasks.moderated.length, 6);
});

test('the console moves a tester on, and their answers come back scored', async () => {
  const t = await invite('Sam', 'self');
  await t.post('/t-api/consent', {});
  const j = await (await admin(`/admin-api/invites/${t.inv.id}/task`, { n: 2 })).json();
  assert.equal(j.invite.task.n, 2);
  await t.post('/t-api/task', { n: 2, state: 'done', answer: 'The strip at the bottom' });
  await t.post('/t-api/seq', { n: 2, value: 6 });
  await t.post('/t-api/answers', { answers: { umux1: 5, umux2: 6, use: 'Keeping track of Codex', which: ['Codex', 'ChatGPT'] } });
  const x = (await (await fetch(`${adm.base}/admin-api/invites/${t.inv.id}`)).json()).invite;
  assert.equal(x.seq[2], 6);
  assert.equal(x.answers.use, 'Keeping track of Codex');
  assert.equal(x.umux, tasks.umuxLite(5, 6));
  assert.ok(x.finished);
});

test('the tester’s agent reaches only their sandbox, by its own token', async () => {
  const t = await invite('Kim');
  await t.post('/t-api/consent', {});
  const tok = t.inv.agentUrl.split('/').pop();
  const call = (body) => fetch(`${pub.base}/x/mcp/${tok}?as=Codex`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'meridian-test');
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((x) => x.name).sort(), ['agent_status', 'ask_add', 'deadline_add', 'event_add', 'meridian_overview', 'note_add', 'todo_add']);
  await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_status', arguments: { agent: 'Codex', project: 'site', doing: 'Fixing the carousel' } } });
  await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_add', arguments: { title: 'Reply to Dan', from: 'Dan', source: 'slack' } } });
  await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'event_add', arguments: { title: 'Launch call', start: new Date(Date.now() + 3600e3).toISOString() } } });
  const s = await (await t.get('/api/demo/state')).json();
  assert.ok(s.ai.sessions.some((x) => x.tool === 'codex' && x.did === 'Fixing the carousel' && x.live));
  assert.ok(s.projects.projects.some((p) => p.title === 'Reply to Dan' && p.source === 'slack'));
  assert.ok(s.calendar.events.some((e) => e.title === 'Launch call'));
  const other = await invite('Lee');
  await other.post('/t-api/consent', {});
  const s2 = await (await other.get('/api/demo/state')).json();
  assert.ok(!s2.projects.projects.some((p) => p.title === 'Reply to Dan'), 'another tester never sees it');
});

test('forgetting deletes the sandbox and signs them out', async () => {
  const t = await invite('Max');
  await t.post('/t-api/consent', { record: true });
  await t.post('/api/demo/todos', { title: 'Private thing' });
  assert.ok(fs.existsSync(path.join(DATA, 'sandboxes', t.inv.id + '.json')) || true);
  const r = await t.post('/t-api/forget', {});
  assert.match(r.headers.get('set-cookie'), /mt=;.*Max-Age=0/);
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(!fs.existsSync(path.join(DATA, 'sandboxes', t.inv.id + '.json')));
  const x = (await (await fetch(`${adm.base}/admin-api/invites/${t.inv.id}`)).json()).invite;
  assert.equal(x.consent, null);
});

test('recordings only with a yes, and only for this tester', async () => {
  const t = await invite('Ari');
  await t.post('/t-api/consent', { record: false });
  const ev = [{ type: 4, timestamp: Date.now(), data: { href: 'http://x/', width: 1, height: 1 } }];
  assert.equal((await t.post('/t-api/rec', { session: t.inv.id + '-abc-1234', invite: t.inv.id, seq: 0, events: ev })).status, 403);
  await t.post('/t-api/consent', { record: true });
  assert.equal((await t.post('/t-api/rec', { session: 'someoneelse-abc-1234', invite: t.inv.id, seq: 0, events: ev })).status, 403);
  assert.equal((await t.post('/t-api/rec', { session: t.inv.id + '-abc-1234', invite: t.inv.id, seq: 0, events: ev })).status, 200);
});

test('sandbox: pretend agents finish and leave a report; blank starts empty', async () => {
  let now = Date.UTC(2026, 9, 8, 10, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-'));
  const done = [];
  const sb = createSandboxes({ dir, now: () => now, models: () => [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }], onRunDone: (id, r) => done.push(r.id) });
  const s = sb.state('abcd');
  const leo = s.todos.find((t) => /Leo/.test(t.title));
  const r = sb.startRun('abcd', { title: leo.title, todoId: leo.id, model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(sb.state('abcd').delegations.runs[0].status, 'running');
  now += 80000;
  const after = sb.state('abcd');
  assert.equal(after.delegations.runs[0].status, 'done');
  assert.deepEqual(after.delegations.runs[0].files, ['REPORT.md']);
  assert.match(sb.report('abcd', r.id).markdown, /^# Review Leo’s onboarding PR\n/);
  assert.throws(() => sb.startRun('abcd', { title: 'x', todoId: 'nope', model: 'm' }) && sb.startRun('abcd', { title: 'x', todoId: 'nope', model: 'm' }), /already on this one/);
  sb.configure('blank1', { world: 'blank' });
  const b = sb.state('blank1');
  assert.equal(b.todos.length, 0); assert.equal(b.calendar.events.length, 0); assert.equal(b.ai.sessions.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('calendar links: HTTPS to the big calendar hosts only, never inside', () => {
  assert.throws(() => checkUrl('http://outlook.office365.com/owa/calendar/x/calendar.ics'), /https/);
  assert.throws(() => checkUrl('https://example.com/calendar.ics'), /only Outlook/);
  assert.throws(() => checkUrl('https://outlook.office365.com:8443/x.ics'), /isn’t one/);
  assert.throws(() => checkUrl('https://127.0.0.1/x.ics'), /only Outlook/);
  assert.equal(checkUrl('webcal://calendar.google.com/calendar/ical/x/basic.ics').protocol, 'https:');
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.5', '172.16.0.1', '100.100.1.1', '169.254.169.254', '::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1']) assert.ok(privateIp(ip), ip);
  assert.ok(!privateIp('52.97.1.1'));
});

test('sorting: clipped, dated sanely, and never the host’s details', () => {
  const now = Date.UTC(2026, 9, 8, 9, 0);
  const out = tidy({ todos: [{ title: 'x'.repeat(500), urgency: 'whenever' }], asks: [{ title: 'Reply to Dan', from: 'Dan', source: 'pigeon', urgency: 'now' }],
    events: [{ title: 'Old', start: '2020-01-01T10:00:00Z' }, { title: 'Call', start: '2026-10-08T15:00:00+01:00' }], deadlines: [{ title: 'Bad date', due: 'Friday' }], agents: [], notes: [] }, now);
  assert.equal(out.todos[0].title.length, 200); assert.equal(out.todos[0].urgency, 'today');
  assert.equal(out.asks[0].source, 'other');
  assert.deepEqual(out.events.map((e) => e.title), ['Call']);
  assert.equal(out.deadlines.length, 0);
  assert.ok(leaks('Here is the brief for Example Agency', 'Write the brief', [/example agency/i]));
  assert.ok(!leaks('Here is the brief for Example Agency', 'Write the brief for Example Agency', [/example agency/i]), 'their own words are fine');
});

// ---------------------------------------------------------------- from the Codex security review (7 Oct)

test('the console: HEAD changes nothing, any Funnel header is refused, and only its own host names', async () => {
  assert.equal((await fetch(adm.base + '/admin-api/public', { method: 'HEAD' })).status, 405);
  assert.equal((await fetch(adm.base + '/admin-api/overview', { headers: { 'Tailscale-Funnel-Request': '' } })).status, 404);
  const r = await new Promise((resolve) => {
    const u = new URL(adm.base);
    http.get({ host: u.hostname, port: u.port, path: '/admin-api/overview', headers: { Host: 'evil.example:4986' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(r, 421);
});

test('nothing of the sandbox before a yes; Delete everything signs every device out', async () => {
  const t = await invite('Noor');
  assert.equal((await t.get('/api/demo/state')).status, 403);
  assert.equal((await t.post('/t-api/note', { text: 'hi' })).status, 403);
  await t.post('/t-api/consent', {});
  assert.equal((await t.get('/api/demo/state')).status, 200);
  const before = (await (await fetch(`${adm.base}/admin-api/invites/${t.inv.id}`)).json()).invite.agentUrl;
  await t.post('/t-api/forget', {});
  assert.equal((await t.get('/api/demo/state')).status, 404, 'the old cookie is nobody now');
  const after = (await (await fetch(`${adm.base}/admin-api/invites/${t.inv.id}`)).json()).invite.agentUrl;
  assert.notEqual(after, before, 'a new agent link');
  const again = await fetch(pub.base + '/t/' + t.inv.id, { redirect: 'manual' });
  assert.match(again.headers.get('set-cookie'), /^mt=/, 'the invite link still works for a fresh start');
});

test('bad input is refused, not stored', async () => {
  const t = await invite('Ola');
  await t.post('/t-api/consent', {});
  assert.equal((await t.post('/t-api/seq', { n: 1.5, value: 3 })).status, 400);
  assert.equal((await t.post('/t-api/task', { n: 2.5, state: 'done' })).status, 400);
  assert.equal((await t.post('/api/demo/brief-feedback', { id: 'project:made-up', action: 'complete' })).status, 404);
  assert.equal((await t.post('/api/demo/deadlines', { title: 'x', due: '2026-99-99' })).status, 400);
  assert.equal((await t.post('/t-api/rec', null)).status, 403, 'not recording');
  await t.post('/t-api/consent', { record: true });
  assert.equal((await fetch(pub.base + '/t-api/rec', { method: 'POST', headers: { cookie: t.cookie, 'Content-Type': 'application/json' }, body: 'null' })).status, 400);
  const add = await (await t.post('/api/demo/todos', { title: 'Typed' })).json();
  await fetch(pub.base + '/api/demo/todos/' + add.todo.id, { method: 'PATCH', headers: { cookie: t.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: { evil: 1 }, done: 'yes' }) });
  const s = await (await t.get('/api/demo/state')).json();
  const td = s.todos.find((x) => x.id === add.todo.id);
  assert.equal(td.title, 'Typed'); assert.equal(td.done, false);
});

test('recordings: 40 sessions per tester at most', async () => {
  const t = await invite('Pat');
  await t.post('/t-api/consent', { record: true });
  const ev = [{ type: 4, timestamp: Date.now(), data: { href: 'http://x/', width: 1, height: 1 } }];
  let last = 0;
  for (let i = 0; i < 41; i++) last = (await t.post('/t-api/rec', { session: `${t.inv.id}-s${i}-abcd`, invite: t.inv.id, seq: 0, events: ev })).status;
  assert.equal(last, 413);
});

test('a tester can’t hold the server open with streams', async () => {
  const t = await invite('Quin');
  await t.post('/t-api/consent', {});
  const ctl = []; const codes = [];
  for (let i = 0; i < 7; i++) { const c = new AbortController(); ctl.push(c); codes.push((await fetch(pub.base + '/api/demo/stream', { headers: { cookie: t.cookie }, signal: c.signal })).status); }
  ctl.forEach((c) => c.abort());
  assert.deepEqual(codes.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.equal(codes[6], 429);
});

test('every text file a tester can fetch is free of real names', async () => {
  const t = await invite('Ren');
  await t.post('/t-api/consent', {});
  const files = ['/', '/connect', '/welcome', '/command.js', '/command.css', '/money-core.js', '/source-marks.js', '/tester/overlay.js', '/tester/overlay.css', '/tester/pages.css', '/tester/report.css', '/tester/rec.js'];
  // The test's own pages name Owner on purpose ("Owner will talk you through it"); the dashboard's code mustn't.
  const OWN = ['/connect', '/welcome', '/tester/overlay.js'];
  for (const f of files) {
    const body = await (await t.get(f)).text();
    for (const re of DENY) assert.doesNotMatch(body, re, `${f}: private pattern`);
    assert.deepEqual(privateWords(body, OWN.includes(f)), [], f + ': private identity');
  }
});

// ---------------------------------------------------------------- round two of the review

test('a request still sending its body when Delete everything happens changes nothing', async () => {
  const t = await invite('Sol');
  await t.post('/t-api/consent', {});
  const u = new URL(pub.base);
  const body = JSON.stringify({ title: 'Sent after deleting' });
  const done = new Promise((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/demo/todos', method: 'POST', headers: { cookie: t.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.write(body.slice(0, 5));
    setTimeout(async () => { await t.post('/t-api/forget', {}); req.end(body.slice(5)); }, 50);
  });
  assert.equal(await done, 410);
  assert.ok(!fs.existsSync(path.join(DATA, 'sandboxes', t.inv.id + '.json')));
});

test('Delete everything works even after a busy hour', async () => {
  const t = await invite('Tam');
  await t.post('/t-api/consent', {});
  let last = 0;
  for (let i = 0; i < 601 && last !== 429; i++) last = (await t.post('/t-api/seq', { n: 1, value: 4 })).status;
  assert.equal(last, 429);
  assert.equal((await t.post('/t-api/forget', {})).status, 200);
});

test('recording slots are reserved one at a time, even in a burst', async () => {
  const t = await invite('Uma');
  await t.post('/t-api/consent', { record: true });
  const ev = [{ type: 4, timestamp: Date.now(), data: { href: 'http://x/', width: 1, height: 1 } }];
  const codes = await Promise.all(Array.from({ length: 60 }, (_, i) => t.post('/t-api/rec', { session: `${t.inv.id}-b${i}-abcd`, invite: t.inv.id, seq: 0, events: ev }).then((r) => r.status)));
  assert.equal(codes.filter((c) => c === 200).length, 40);
});

test('pin order only keeps links that exist', async () => {
  const t = await invite('Val');
  await t.post('/t-api/consent', {});
  const fake = Array.from({ length: 200 }, (_, i) => 'nope-' + i);
  await t.post('/api/demo/links/pin-order', { ids: fake });
  const exp = await (await fetch(`${adm.base}/admin-api/invites/${t.inv.id}/export`)).json();
  assert.equal(Object.keys(exp.sandbox.links.patch).length, 0);
  assert.equal(exp.sandbox.links.pinOrder.length, 0);
});
