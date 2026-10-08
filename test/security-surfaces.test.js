'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createTools, createRoutes } = require('../drafts');
const { createStash } = require('../stash');
const { createStashTools } = require('../stash-tools');

function source(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }
function section(code, start, end) {
  const a = code.indexOf(start), b = code.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return code.slice(a, b);
}
function escLine(code) { return code.split('\n').find((line) => /^const esc\s*=/.test(line)); }
const attack = '"><img src=x onerror="security_marker()"><script>security_marker()</script>&';

test('dashboard Stash cards escape agent notes, web titles and quote page titles', () => {
  const code = source('public/command.js');
  const ctx = vm.createContext({ ST: { seenBefore: null }, ST_SOURCE: {}, icon: () => '', ago: () => 'now',
    stShot: () => false, stMedia: () => '', api: (url) => url, stBytes: () => '', stTitle: (item) => item.title,
    cap: (text, max) => String(text).slice(0, max) });
  vm.runInContext(escLine(code) + '\n' + section(code, 'function stCardHTML(', '// Masonry'), ctx);
  for (const kind of ['note', 'quote', 'link', 'image']) {
    const html = ctx.stCardHTML({ id: 'safeid12345', kind, title: attack, summary: attack, text: attack,
      domain: attack, from: attack, page: { title: attack }, created: 0, source: 'agent' });
    assert.doesNotMatch(html, /<script>|<img src=x|onerror="security_marker/);
    assert.match(html, /&lt;img|&quot;/);
  }
});

test('sorter and draft list escape the same untrusted text', () => {
  const sorter = source('public/stash-sort.html');
  const ctx = vm.createContext({ KIND: { quote: 'Quote', note: 'Note' }, SOURCE: {}, shot: () => false,
    titleOf: (item) => item.title, ago: () => 'now', api: (url) => url });
  vm.runInContext(escLine(sorter) + '\n' + section(sorter, 'function cardHTML(', 'function render('), ctx);
  const html = ctx.cardHTML({ kind: 'quote', title: attack, text: attack, page: { title: attack }, spaces: [attack] });
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/);

  const drafts = source('public/drafts.html');
  const out = {};
  const data = { id: 'safeid', kind: 'note', title: attack, to: attack, lastBy: attack };
  const list = vm.createContext({ qs: new URLSearchParams(''), WORD: { note: 'Note' }, ICON: { note: '' }, when: () => 'now', ic: () => '',
    encodeURIComponent, agentColour: () => '#fff', all: [data], kind: '', view: 'live',
    $: (id) => id === 'q' ? { value: '' } : out });
  const render = drafts.includes('function item(')
    ? section(drafts, 'function item(', '// Archived drafts')
    : section(drafts, 'function draw(', 'function press(');
  vm.runInContext(escLine(drafts) + '\n' + section(drafts, 'function status(', 'function when(') + render, list);
  const item = list.item ? list.item(data) : (list.draw(), out.innerHTML);
  assert.doesNotMatch(item, /<script>|<img src=x/);
  assert.match(item, /&lt;script&gt;/);
});

test('panel MCP scheme allowlist excludes scripts, files, custom schemes and HTTP', async () => {
  const opened = [];
  const tool = createTools({}, { browse: (url) => opened.push(url) }).find((t) => t.name === 'panel_open_url');
  for (const url of ['javascript:security_marker()', 'file:///etc/passwd', 'data:text/html,hi', 'meridian://terminal',
    'shortcuts://run-shortcut', 'http://127.0.0.1:3000/', 'https://[']) {
    await assert.rejects(tool.run({ url }));
  }
  assert.equal(opened.length, 0);
  await tool.run({ url: 'https://owner.example.ts.net/' });
  assert.deepEqual(opened, ['https://owner.example.ts.net/']);
});

test('MCP as is an unverified label, and a cloud token cannot enter draft HTTP routes', async () => {
  const labels = [];
  const route = createRoutes({ token: 'dashboard-test', mcpToken: 'cloud-test', drafts: {},
    tools: [{ name: 'label', run: async (_a, by) => { labels.push(by); return {}; } }],
    sendJson: (res, status, data) => { res.status = status; res.data = data; } });
  const req = new EventEmitter(); req.method = 'POST'; req.headers = { 'tailscale-funnel-request': '1' };
  const res = {};
  const done = route(req, res, new URL('http://x/mcp?t=cloud-test&as=you'));
  req.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'label' } })));
  req.emit('end'); await done;
  assert.deepEqual(labels, ['you']); assert.equal(res.status, 200);
  await route(req, res, new URL('http://x/api/drafts?t=cloud-test'));
  assert.equal(res.status, 403);
});

// Every effect stays in this temporary store or these injected functions.
test('URL-only note_add keeps private and non-HTTP URLs as text without fetching or previews', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mer-security-'));
  const targets = [];
  const stash = createStash({ dir, quicklook: false, log: () => {},
    fetch: async (url) => { targets.push(['fetch', url]); return { url, type: 'text/html',
      buffer: Buffer.from('<title>Sandbox private title</title><meta name="description" content="Sandbox private description">') }; },
    preview: async (_key, url) => { targets.push(['preview', url]); return null; },
  });
  t.after(async () => { await stash.settle(); await fsp.rm(dir, { recursive: true, force: true }); });
  const tools = createStashTools(stash);
  const note = tools.find((tool) => tool.name === 'note_add');
  for (const url of ['http://127.0.0.1:5190/private-page', 'http://100.100.1.1/',
    'http://169.254.169.254/', 'http://[::1]/', 'https://2130706433/',
    'file:///etc/passwd', 'javascript:security_marker()', 'meridian://terminal']) {
    const added = await note.run({ text: url, publicOnly: false }, 'untrusted-agent');
    await stash.settle();
    const result = await tools.find((tool) => tool.name === 'stash_get').run({ id: added.saved });
    assert.equal(result.kind, 'note', url);
    assert.equal(result.text, url);
    assert.equal(result.pageDescription, undefined);
    assert.equal(result.hasPicture, false);
    assert.equal(result.thumbnail, undefined);
    assert.equal(result._images, undefined);
    assert.equal((await stash.get(added.saved)).url, '');
    await stash.refresh(added.saved);
  }
  await stash.settle();
  assert.deepEqual(targets, []);
});

// Run the real store, DNS guard and HTTP fetcher with fake transports only.
async function captureFixture(t, { answers = () => [{ address: '8.8.8.8', family: 4 }], pages = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mer-security-agent-'));
  const dnsCalls = [], requests = [], previews = [];
  const networkModule = { exports: {} };
  vm.runInNewContext(source('public-network.js'), { module: networkModule, require: (name) => name === 'node:dns' ? {
    lookup(host, options, cb) {
      assert.equal(options.all, true);
      dnsCalls.push(host);
      const addresses = answers(host, dnsCalls.filter((h) => h === host).length);
      cb(addresses instanceof Error ? addresses : null, addresses);
    },
  } : require(name) });
  const network = networkModule.exports;
  const transport = { request(url, options, callback) {
    if (options.lookup) assert.equal(options.agent, false, 'never reuse an owner connection');
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const connect = (err, addresses) => {
        if (err) { req.emit('error', err); return; }
        requests.push({ url, guarded: options.lookup === network.publicLookup, addresses });
        const page = pages[url] || { body: '<title>Public article</title><meta name="description" content="Public description">' };
        const res = new EventEmitter(); res.resume = () => {};
        res.statusCode = page.location ? 302 : 200;
        res.headers = page.location ? { location: page.location } : { 'content-type': page.type || 'text/html' };
        callback(res);
        if (!page.location) { res.emit('data', Buffer.from(page.body)); res.emit('end'); }
      };
      if (options.lookup && !require('node:net').isIP(new URL(url).hostname.replace(/^\[|\]$/g, ''))) {
        options.lookup(new URL(url).hostname, { all: true }, connect);
      } else connect(null);
    });
    return req;
  } };
  const stashModule = { exports: {} };
  vm.runInNewContext(source('stash.js'), {
    module: stashModule, URL, Buffer, console, process: { pid: process.pid }, setTimeout, clearTimeout,
    require: (name) => name === './public-network' ? network
      : name === 'http' || name === 'https' ? transport
      : name.startsWith('./') ? require('../' + name.slice(2)) : require(name),
  });
  const options = { dir, quicklook: false, log: () => {}, preview: async (_key, url) => { previews.push(url); return null; } };
  const stash = stashModule.exports.createStash(options);
  t.after(async () => { await stash.settle(); await fsp.rm(dir, { recursive: true, force: true }); });
  const tools = createStashTools(stash);
  return { stash, tools, requests, previews, dnsCalls, reload: () => stashModule.exports.createStash(options),
    note: tools.find((tool) => tool.name === 'note_add'), get: tools.find((tool) => tool.name === 'stash_get') };
}

test('agent public URLs still enrich title, description, share image and favicon through pinned fetches', async (t) => {
  const url = 'https://article.example/post';
  const f = await captureFixture(t, { pages: {
    [url]: { location: 'http://article.example/final' },
    'http://article.example/final': { body: '<title>Public article</title><meta name="description" content="Public description">'
      + '<meta property="og:image" content="https://cdn.example/share.png"><link rel="icon" href="https://cdn.example/icon.png">' },
    'https://cdn.example/share.png': { type: 'image/png', body: 'public image' },
    'https://cdn.example/icon.png': { type: 'image/png', body: 'public icon '.repeat(10) },
  } });
  const added = await f.note.run({ text: url }, 'Dot');
  await f.stash.settle();
  const result = await f.get.run({ id: added.saved });
  assert.equal(result.kind, 'link');
  assert.equal(result.title, 'Public article');
  assert.equal(result.pageDescription, 'Public description');
  assert.ok((await f.stash.get(added.saved)).icon);
  assert.deepEqual(f.requests.map((r) => r.url), [url, 'http://article.example/final', 'https://cdn.example/share.png', 'https://cdn.example/icon.png']);
  assert.ok(f.requests.every((r) => r.guarded && r.addresses[0].address === '8.8.8.8'));
  assert.deepEqual(f.previews, []);
  const duplicate = await f.note.run({ text: url });
  assert.equal(duplicate.saved, added.saved);
  const reloaded = f.reload();
  await reloaded.refresh(added.saved); await reloaded.settle();
  assert.ok(f.requests.every((r) => r.guarded));
  assert.deepEqual(f.previews, [], 'the policy survives restart and refresh');
});

test('agent private, mixed, empty and failed DNS answers stay plain notes without HTTP', async (t) => {
  const f = await captureFixture(t, { answers: (host) => ({
    'private.example': [{ address: '127.0.0.1', family: 4 }],
    'mixed.example': [{ address: '8.8.8.8', family: 4 }, { address: 'fd7a:115c:a1e0::1', family: 6 }],
    'empty.example': [], 'missing.example': new Error('DNS failed'),
  })[host] });
  for (const host of ['private.example', 'mixed.example', 'empty.example', 'missing.example']) {
    const text = `https://${host}/`;
    const added = await f.note.run({ text });
    const result = await f.get.run({ id: added.saved });
    assert.equal(result.kind, 'note'); assert.equal(result.text, text);
    assert.equal(result.pageDescription, undefined); assert.equal(result.hasPicture, false);
  }
  assert.equal(f.dnsCalls.length, 4);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.previews, []);
});

test('agent redirects stop before private literals, private DNS, mixed DNS and non-HTTP schemes', async (t) => {
  const destinations = ['http://127.0.0.1:5190/', 'http://100.100.1.1/', 'http://169.254.169.254/',
    'http://[::ffff:127.0.0.1]/', 'https://private.example/', 'https://mixed.example/', 'file:///etc/passwd'];
  const pages = Object.fromEntries(destinations.map((location, i) => [`https://article.example/${i}`, { location }]));
  const f = await captureFixture(t, { pages, answers: (host) => host === 'private.example'
    ? [{ address: '127.0.0.1', family: 4 }]
    : host === 'mixed.example' ? [{ address: '8.8.8.8', family: 4 }, { address: '100.100.1.1', family: 4 }]
      : [{ address: '8.8.8.8', family: 4 }] });
  for (let i = 0; i < destinations.length; i++) {
    const added = await f.note.run({ text: `https://article.example/${i}` });
    await f.stash.settle();
    const result = await f.get.run({ id: added.saved });
    assert.equal(result.pageDescription, undefined);
    assert.equal(result.hasPicture, false);
  }
  assert.deepEqual(f.requests.map((r) => r.url), Object.keys(pages));
  assert.deepEqual(f.previews, []);
});

test('agent share-image and favicon redirects use the same policy; DNS is rechecked at connection', async (t) => {
  const url = 'https://article.example/';
  const f = await captureFixture(t, { pages: {
    [url]: { body: '<title>Public article</title><meta property="og:image" content="https://cdn.example/share">'
      + '<link rel="icon" href="http://cdn.example/icon">' },
    'https://cdn.example/share': { location: 'http://127.0.0.1:5190/share' },
    'http://cdn.example/icon': { location: 'http://private.example/icon' },
  }, answers: (host, count) => host === 'private.example' || (host === 'rebind.example' && count > 1)
    ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '8.8.8.8', family: 4 }] });
  const added = await f.note.run({ text: url }); await f.stash.settle();
  const result = await f.get.run({ id: added.saved });
  assert.equal(result.title, 'Public article'); assert.equal(result.hasPicture, false);
  assert.equal((await f.stash.get(added.saved)).icon, undefined);
  await f.note.run({ text: 'https://rebind.example/' }); await f.stash.settle();
  assert.deepEqual(f.requests.map((r) => r.url), [url, 'https://cdn.example/share', 'http://cdn.example/icon']);
  assert.equal(f.dnsCalls.filter((h) => h === 'rebind.example').length, 2);
  assert.deepEqual(f.previews, []);
});

test('owner internal captures and screenshots remain unchanged; agents cannot reuse owner redirect metadata', async (t) => {
  const url = 'https://article.example/';
  const privateUrl = 'http://127.0.0.1:5190/private';
  const f = await captureFixture(t, { pages: {
    [url]: { location: privateUrl },
    [privateUrl]: { body: '<title>Owner private title</title><meta name="description" content="Owner private description">' },
  } });
  const owner = (await f.stash.addText({ text: url, source: 'page' })).item;
  await f.stash.settle();
  assert.equal((await f.stash.get(owner.id)).description, 'Owner private description');
  const local = (await f.stash.addText({ text: privateUrl, source: 'clipboard' })).item;
  await f.stash.settle();
  assert.equal(local.kind, 'link');
  assert.deepEqual(f.previews, [url, privateUrl]);
  assert.ok(f.requests.every((r) => !r.guarded));
  const start = f.requests.length;
  const added = await f.note.run({ text: url }); await f.stash.settle();
  assert.notEqual(added.saved, owner.id);
  const result = await f.get.run({ id: added.saved });
  assert.equal(result.pageDescription, undefined); assert.equal(result.hasPicture, false);
  assert.deepEqual(f.requests.slice(start).map((r) => r.url), [url]);
  assert.deepEqual(f.previews, [url, privateUrl]);
});

test('Owner saving a link an agent saved first makes it his capture: one card, screenshot allowed', async (t) => {
  const url = 'https://plain.example/page';
  const f = await captureFixture(t, { pages: { [url]: { body: '<title>Plain page</title>' } } });
  const added = await f.note.run({ text: url }, 'Dot');
  await f.stash.settle();
  assert.deepEqual(f.previews, [], 'an agent capture takes no screenshot');
  const owner = await f.stash.addText({ text: url, source: 'page' });
  await f.stash.settle();
  assert.equal(owner.item.id, added.saved, 'one card, not two');
  assert.equal(owner.duplicate, true);
  assert.deepEqual(f.previews, [url], 'his capture gets its screenshot');
  // The other order is unchanged: an agent saving his link gets its own public-only record.
  const again = await f.note.run({ text: url }, 'Dot');
  assert.notEqual(again.saved, added.saved);
});
