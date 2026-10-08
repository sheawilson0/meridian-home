'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/lab-guard.js'), 'utf8');

function setup(search = '?lab') {
  const calls = [], logs = [], listeners = [], observers = [];
  class XHR extends EventTarget {
    constructor() { super(); this.responseType = ''; }
    open(...args) { calls.push(['open', ...args]); }
    send(...args) { calls.push(['xhr', ...args]); }
    abort() { calls.push(['abort']); }
  }
  class Form { submit() { calls.push(['submit']); } }
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(...args) { this.observed = args; }
  }
  function node(tag, attrs = {}, children = []) {
    return { nodeType: 1, tagName: tag, getAttribute: k => attrs[k] || null,
      setAttribute(k, v) { attrs[k] = v; },
      matches() { return (tag === 'IFRAME' && !!attrs.src) || (tag === 'A' && !!attrs.href); },
      querySelectorAll() { return children; } };
  }
  const document = { baseURI: 'https://meridian.test/base/page', documentElement: node('HTML'),
    addEventListener(...args) { listeners.push(args); } };
  const fetch = function (...args) { calls.push(['fetch', this, ...args]); return Promise.resolve(new Response('read')); };
  const beacon = function (...args) { calls.push(['beacon', this, ...args]); return false; };
  const window = { location: { search, origin: 'https://meridian.test' }, fetch };
  const navigator = { sendBeacon: beacon };
  const context = vm.createContext({ window, document, navigator, XMLHttpRequest: XHR, HTMLFormElement: Form,
    MutationObserver: Observer, URL, URLSearchParams, Request, Response, Blob, TextEncoder, Event, setTimeout,
    console: { info: line => logs.push(line) } });
  const originals = { fetch, beacon, open: XHR.prototype.open, send: XHR.prototype.send, abort: XHR.prototype.abort, submit: Form.prototype.submit };
  const run = () => vm.runInContext(source, context);
  run();
  return { window, navigator, XHR, Form, document, calls, logs, listeners, observers, originals, node, run, context };
}

test('without lab, every transport and form method is untouched, with no listeners or observers', () => {
  for (const query of ['', '?laboratory=1', '?mode=lab']) {
    const s = setup(query);
    assert.equal(s.window.fetch, s.originals.fetch);
    assert.equal(s.navigator.sendBeacon, s.originals.beacon);
    for (const key of ['open', 'send', 'abort']) assert.equal(s.XHR.prototype[key], s.originals[key]);
    assert.equal(s.Form.prototype.submit, s.originals.submit);
    assert.equal(s.window.MERIDIAN_LAB, undefined);
    assert.deepEqual(s.observers, []); assert.deepEqual(s.listeners, []); assert.deepEqual(s.logs, []);
  }
});

test('lab and lab=1 block fetch writes and return the promised JSON success', async () => {
  for (const query of ['?lab', '?lab=1']) {
    const s = setup(query);
    for (const method of ['POST', 'put', 'PATCH', 'DELETE', 'OPTIONS']) {
      const r = await s.window.fetch('/api/write?t=private', { method, body: 'private body' });
      assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/json');
      assert.deepEqual(await r.json(), { ok: true, lab: true });
    }
    assert.deepEqual(s.calls, []); assert.equal(s.logs.length, 5);
    assert.ok(s.logs.every(line => !line.includes('private')));
    assert.equal(s.window.MERIDIAN_LAB, true);
  }
});

test('GET/HEAD, URL objects and external writes keep their arguments and receiver', async () => {
  const s = setup(), receiver = {};
  for (const [input, options] of [['/api/read', undefined], [new URL('https://meridian.test/api/read'), { method: 'HEAD' }], ['https://external.test/write', { method: 'POST' }]]) {
    await s.window.fetch.call(receiver, input, options);
    assert.deepEqual(s.calls.at(-1), ['fetch', receiver, input, options]);
  }
  assert.deepEqual(s.logs, []);
});

test('Request methods are honoured, including explicit init overrides', async () => {
  const s = setup(), input = new Request('https://meridian.test/api/write', { method: 'POST' });
  assert.deepEqual(await (await s.window.fetch(input)).json(), { ok: true, lab: true });
  await s.window.fetch(input, { method: 'GET' });
  assert.equal(s.calls.length, 1);
  await s.window.fetch(new Request('https://meridian.test/api/read'), { method: 'DELETE' });
  assert.equal(s.logs.length, 2);
});

test('XHR writes complete asynchronously with success events, JSON and headers, without send', async () => {
  const s = setup(), x = new s.XHR(), events = [];
  for (const name of ['loadstart', 'readystatechange', 'load', 'loadend']) x.addEventListener(name, () => events.push(name));
  x.open('PATCH', '/api/write'); x.responseType = 'json';
  const loaded = new Promise(resolve => x.addEventListener('loadend', resolve, { once: true }));
  x.send('private'); assert.deepEqual(events, ['loadstart']); await loaded;
  assert.equal(x.readyState, 4); assert.equal(x.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(x.response)), { ok: true, lab: true }); assert.equal(JSON.parse(x.responseText).lab, true);
  assert.equal(x.responseURL, 'https://meridian.test/api/write');
  assert.equal(x.getResponseHeader('Content-Type'), 'application/json');
  assert.equal(x.getResponseHeader('unknown'), null);
  assert.equal(x.getAllResponseHeaders(), 'content-type: application/json\r\n');
  assert.deepEqual(events, ['loadstart', 'readystatechange', 'readystatechange', 'readystatechange', 'load', 'loadend']);
  assert.equal(s.calls.filter(c => c[0] === 'xhr').length, 0); assert.equal(s.logs.length, 1);
});

test('XHR sync writes succeed, GET/HEAD and cross-origin writes still send, reused objects reset', () => {
  const s = setup(), x = new s.XHR();
  x.open('POST', '/api/write', false); x.send(); assert.equal(x.status, 200);
  x.open('GET', '/api/read'); assert.equal(Object.hasOwn(x, 'status'), false); x.send();
  x.open('HEAD', '/api/read'); x.send();
  x.open('POST', 'https://external.test/write'); x.send();
  assert.equal(s.calls.filter(c => c[0] === 'xhr').length, 3); assert.equal(s.logs.length, 1);
});

test('aborted or reopened fake XHR never fires a stale success', async () => {
  for (const change of ['abort', 'reopen']) {
    const s = setup(), x = new s.XHR(); let loaded = false;
    x.addEventListener('load', () => { loaded = true; }); x.open('DELETE', '/api/write'); x.send();
    if (change === 'abort') x.abort(); else x.open('GET', '/api/read');
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(loaded, false);
  }
});

test('sendBeacon blocks same-origin writes but preserves external requests', () => {
  const s = setup(); assert.equal(s.navigator.sendBeacon('/api/write', 'private'), true);
  assert.deepEqual(s.calls, []); assert.equal(s.logs.length, 1);
  assert.equal(s.navigator.sendBeacon('https://external.test/write', 'body'), false);
  assert.equal(s.calls[0][0], 'beacon');
});

test('form POST capture and direct submit are blocked, including submitter overrides', () => {
  const s = setup(), listener = s.listeners.find(([name]) => name === 'submit'); assert.equal(listener[2], true);
  const form = new s.Form(); form.method = 'post'; form.action = 'https://meridian.test/api/write';
  let prevented = 0, stopped = 0;
  const event = { target: form, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } };
  listener[1](event); form.submit();
  form.method = 'get'; listener[1](event); form.submit();
  event.submitter = { getAttribute: key => ({ formmethod: 'POST', formaction: '/api/override' })[key] };
  listener[1](event);
  assert.equal(prevented, 2); assert.equal(stopped, 2); assert.equal(s.logs.length, 3);
  assert.deepEqual(s.calls, [['submit']]);
});

test('observer propagates lab to existing and created iframe/link URLs, preserving queries and hashes', () => {
  const s = setup(), frame = s.node('IFRAME', { src: '/dashboard?t=keep#home' }), link = s.node('A', { href: '../draft?id=one#body' });
  const external = s.node('IFRAME', { src: 'https://external.test/' }), anchor = s.node('A', { href: '#here' });
  s.observers[0].callback([{ type: 'childList', addedNodes: [s.node('DIV', {}, [frame, link, external, anchor])] }]);
  assert.equal(frame.getAttribute('src'), 'https://meridian.test/dashboard?t=keep&lab=1#home');
  assert.equal(link.getAttribute('href'), 'https://meridian.test/draft?id=one&lab=1#body');
  assert.equal(external.getAttribute('src'), 'https://external.test/'); assert.equal(anchor.getAttribute('href'), '#here');
  const before = frame.getAttribute('src'); s.observers[0].callback([{ type: 'attributes', target: frame }]);
  assert.equal(frame.getAttribute('src'), before);
  const click = s.listeners.find(([name]) => name === 'click')[1], fresh = s.node('A', { href: '/quick' });
  click({ target: { closest: () => fresh } }); assert.match(fresh.getAttribute('href'), /lab=1/);
});

test('repeated inclusion is idempotent and existing Command/Phone fetch guards compose', async () => {
  for (const file of ['command.js', 'phone.js']) {
    const s = setup(), fetch = s.window.fetch, send = s.XHR.prototype.send; s.run();
    assert.equal(s.window.fetch, fetch); assert.equal(s.XHR.prototype.send, send); assert.equal(s.observers.length, 1);
    const guard = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8').match(/if\s*\(LAB\)\s*\{ const f\s*=\s*window.fetch;.*$/m)[0];
    vm.runInContext('const LAB=true; ' + guard, s.context);
    await s.window.fetch('/api/write', { method: 'POST' });
    await s.window.fetch(new Request('https://meridian.test/api/write', { method: 'POST' }));
    await s.window.fetch('/api/read');
    assert.equal(s.calls.length, 1); assert.equal(s.calls[0][0], 'fetch'); assert.equal(s.logs.length, 1);
  }
});

test('all requested pages load the guard before any other script', () => {
  for (const file of ['voice/index.html', 'voice/call.html', 'brief-dia.html', 'draft.html', 'drafts.html', 'quick.html', 'connect.html', 'projects.html', 'dashboard.html', 'stash-sort.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
    assert.equal(html.match(/<script[^>]*>/i)[0], '<script src="/lab-guard.js">', file);
    assert.ok(html.indexOf('/lab-guard.js') > html.indexOf('<head>') && html.indexOf('/lab-guard.js') < html.indexOf('</head>'));
  }
  const tester = fs.readFileSync(path.join(__dirname, '../tester/server.js'), 'utf8');
  assert.ok(!tester.match(/const PAGE_FILES[^;]+/)[0].includes('lab-guard'));
});
