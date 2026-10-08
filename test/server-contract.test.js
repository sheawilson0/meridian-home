'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { startSandbox, request, shape, DRAFT_ID, TOKEN, MCP_TOKEN, PAGES, repo } = require('./helpers/sandbox-server.cjs');
const { startHandler } = require('./helpers/server-handler.cjs');
const contracts = require('./fixtures/server-contract/routes.json');

let sandbox, handler, saved;
async function files(root) {
  const out = {};
  for (const dir of ['data', 'cache']) {
    const visit = async relative => {
      for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) await visit(name);
        else out[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
      }
    };
    await visit(dir);
  }
  out['config.json'] = crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'config.json'))).digest('hex');
  return out;
}

test.before(async () => {
  sandbox = await startSandbox();
  saved = await files(sandbox.root);
  handler = await startHandler(sandbox, JSON.parse((await request(sandbox.base, '/api/state')).body));
});
test.after(async () => {
  try {
    if (handler) await handler.stop();
    if (sandbox) {
      assert.deepEqual(await files(sandbox.root), saved, 'reads and refused writes leave every fixture file unchanged');
      await sandbox.stop();
      const { output, errors } = sandbox.logs();
      assert.deepEqual(JSON.parse(output.match(/SANDBOX_COUNTS (.+)/)[1]), { children: 0, outbound: 0, timers: 0 });
      assert.equal(errors, '', 'sandbox has no collector or request errors');
    }
  } finally { if (sandbox) await sandbox.stop(); }
});

for (const [route, contract] of Object.entries(contracts)) test('GET contract: ' + route, async () => {
  const res = await request(sandbox.base, route);
  assert.equal(res.status, contract.status);
  assert.equal(res.headers['content-type'], contract.contentType);
  const body = contract.shape === 'string' ? res.body : JSON.parse(res.body);
  assert.deepEqual(shape(body), contract.shape, 'keys/types only, no personal or changing values');
  if (route === '/agent.md') {
    assert.deepEqual(res.body.split('\n').filter(line => /^#{1,2} /.test(line)),
      ['# Meridian', '## To-dos', '## Deadlines', '## Open drafts', '## How to help']);
  }
});

const authCases = [
  ['loopback', {}, '', 200],
  ['forwarded loopback', { 'x-forwarded-for': '127.0.0.1' }, '', 200],
  ['forwarded Tailnet', { 'x-forwarded-for': '100.64.0.1' }, '', 200],
  ['forwarded public', { 'x-forwarded-for': '203.0.113.1' }, '', 403],
  ['public first proxy hop', { 'x-forwarded-for': '203.0.113.1, 100.64.0.1' }, '', 403],
  ['Funnel marker', { 'tailscale-funnel-request': '?1' }, '', 403],
  ['empty Funnel marker', { 'tailscale-funnel-request': '' }, '', 403],
  ['query token', { 'x-forwarded-for': '203.0.113.1' }, '?t=' + TOKEN, 200],
  ['header token', { 'x-forwarded-for': '203.0.113.1', 'x-meridian-token': TOKEN }, '', 200],
  ['Funnel with token', { 'tailscale-funnel-request': '?1', 'x-meridian-token': TOKEN }, '', 200],
  ['wrong query token', { 'x-forwarded-for': '203.0.113.1' }, '?t=wrong', 403],
  ['wrong header token', { 'x-forwarded-for': '203.0.113.1', 'x-meridian-token': 'wrong' }, '', 403],
  ['wrong query wins over valid header', { 'x-forwarded-for': '203.0.113.1', 'x-meridian-token': TOKEN }, '?t=wrong', 403],
];
test('real daemon auth decisions, 13 requests', async () => {
  for (const [name, headers, query, status] of authCases) {
    const res = await request(sandbox.base, '/api/state' + query, { headers });
    assert.equal(res.status, status, name);
    if (status === 403) assert.equal(res.body, 'forbidden', name);
    else assert.deepEqual(shape(JSON.parse(res.body)), contracts['/api/state'].shape, name);
  }
  // These exceptions precede broad dashboard auth, while demo still needs it.
  for (const route of ['/api/almanac', '/brief-icon.svg', '/api/daily-art']) {
    assert.equal((await request(sandbox.base, route, { headers: { 'tailscale-funnel-request': '?1' } })).status, 200, route);
  }
  assert.equal((await request(sandbox.base, '/api/demo/state', { headers: { 'tailscale-funnel-request': '?1' } })).status, 403);
});

const rpc = (name, params) => ({ jsonrpc: '2.0', id: 7, method: name, ...(params === undefined ? {} : { params }) });
const post = (base, body, headers = {}, route = '/mcp') => request(base, route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
test('Origin decisions behind the jobs gate, 12 origins', async () => {
  const origins = [
    [undefined, 200], ['http://127.0.0.1:' + handler.port, 200], ['http://localhost:' + handler.port, 200],
    ['http://[::1]:' + handler.port, 200], ['https://fixture.example.ts.net', 200],
    ['null', 403], ['', 403], ['https://foreign.example', 403], ['http://localhost:4980', 403],
    ['https://user@fixture.example.ts.net', 403], ['https://fixture.example.ts.net/path', 403], ['https://[', 403],
  ];
  for (const [origin, status] of origins) {
    const res = await post(handler.base, rpc('tools/list'), origin === undefined ? {} : { origin });
    assert.equal(res.status, status, String(origin));
    if (status === 403) assert.equal(res.body, 'forbidden');
    else assert.ok(Array.isArray(JSON.parse(res.body).result.tools));
  }
});

test('jobs-off 503 precedes Origin, auth, demo and MCP dispatch', async () => {
  for (const [method, route, headers] of [
    ['POST', '/api/refresh', {}], ['PUT', '/api/command/prefs', {}], ['PATCH', '/api/drafts/' + DRAFT_ID, {}],
    ['DELETE', '/api/stash/demo0002', {}], ['POST', '/api/notify/test', {}], ['POST', '/api/local/share', {}],
    ['POST', '/api/fleet/pause', {}], ['POST', '/api/money/refresh', {}], ['POST', '/api/demo/todos', {}],
    ['POST', '/mcp', {}], ['POST', '/mcp', { origin: 'https://foreign.example', 'tailscale-funnel-request': '?1' }],
  ]) {
    const res = await request(sandbox.base, route, { method, headers, body: '{}' });
    assert.equal(res.status, 503, method + ' ' + route);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Meridian jobs are off' });
  }
});

function stream(base, route, wanted) {
  let req, res, buffer = '';
  const events = [];
  let opened;
  const connected = new Promise(resolve => { opened = resolve; });
  const ready = new Promise((resolve, reject) => {
    req = http.get(base + route, { headers: { 'accept-encoding': 'identity' } }, response => {
      res = response;
      if (res.statusCode !== 200 || res.headers['content-type'] !== 'text/event-stream') {
        reject(new Error('Expected a 200 text/event-stream response')); return;
      }
      opened();
      res.on('error', reject);
      res.on('data', bytes => {
        buffer += bytes.toString();
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          events.push(buffer.slice(0, at + 2)); buffer = buffer.slice(at + 2);
          if (events.length === wanted) resolve(events);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('SSE contract timed out')));
  });
  return { ready, connected: Promise.race([connected, ready]), close: () => { res?.destroy(); req.destroy(); } };
}
test('real SSE starts with retry and a state event', async () => {
  const s = stream(sandbox.base, '/api/stream', 2);
  try {
    const [retry, event] = await s.ready;
    assert.equal(retry, 'retry: 5000\n\n');
    assert.match(event, /^event: state\ndata: [^\n]+\n\n$/);
    assert.deepEqual(shape(JSON.parse(event.split('\n')[1].slice(6))), contracts['/api/state'].shape);
  } finally { s.close(); }
});
test('real draft SSE uses the named draft event', async () => {
  const s = stream(sandbox.base, '/api/drafts/' + DRAFT_ID + '/stream', 2);
  try {
    const [retry, event] = await s.ready;
    assert.equal(retry, 'retry: 3000\n\n');
    assert.match(event, /^event: draft\ndata: [^\n]+\n\n$/);
    assert.deepEqual(shape(JSON.parse(event.split('\n')[1].slice(6))), contracts['/api/drafts/' + DRAFT_ID].shape.draft);
  } finally { s.close(); }
});
test('SSE broadcaster preserves panel, stash and nudge framing', async () => {
  const payload = { fixture: true, text: 'one\ntwo' };
  const client = stream(handler.base, '/api/stream', 5);
  try {
    await client.connected;
    for (const name of ['panel', 'stash', 'nudge']) handler.broadcast(name, payload);
    const events = await client.ready;
    for (const [index, name] of ['panel', 'stash', 'nudge'].entries()) {
      assert.equal(events[index + 2], `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  } finally { client.close(); }
});

test('13 PAGES mappings preserve bytes and static validators', async () => {
  for (const [route, file] of Object.entries(PAGES)) {
    const res = await request(sandbox.base, route + '?lab=1');
    assert.equal(res.status, 200, route);
    assert.equal(res.headers['content-type'], 'text/html');
    assert.equal(res.body, await fs.readFile(path.join(repo, 'public', file), 'utf8'), route);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.ok(res.headers.etag && res.headers['last-modified']);
    assert.equal((await request(sandbox.base, route + '?lab=1', { headers: { 'if-none-match': res.headers.etag } })).status, 304, route);
  }
  assert.equal((await request(sandbox.base, '/story/?lab=1')).status, 404, 'private research is excluded');
  const redirect = await request(sandbox.base, '/story?lab=1');
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, '/story/?lab=1');
});

test('MCP initialize negotiates supported versions and tools/list preserves tool names', async () => {
  for (const [requested, expected] of [[undefined, '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2025-06-18', '2025-06-18'], ['2025-11-25', '2025-11-25'], ['2024-11-05', '2025-11-25'], ['future-fixture-version', '2025-11-25']]) {
    const res = await post(handler.base, rpc('initialize', requested ? { protocolVersion: requested } : {}));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(shape(body), { id: 'number', jsonrpc: 'string', result: { capabilities: { tools: {} }, instructions: 'string', protocolVersion: 'string', serverInfo: { name: 'string', version: 'string' } } });
    assert.equal(body.result.protocolVersion, expected);
    assert.deepEqual(body.result.serverInfo, { name: 'meridian', version: '1.0.0' });
  }
  const listed = JSON.parse((await post(handler.base, rpc('tools/list'))).body).result.tools;
  const names = require('./fixtures/server-contract/tools.json');
  assert.deepEqual(listed.map(tool => tool.name), names);
  assert.deepEqual(JSON.parse((await request(sandbox.base, '/mcp')).body).tools, names);
  for (const tool of listed) {
    assert.deepEqual(Object.keys(tool).sort(), ['annotations', 'description', 'inputSchema', 'name']);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean', tool.name + ': ' + hint);
    assert.equal(typeof tool.description, 'string'); assert.equal(tool.inputSchema.type, 'object');
  }
});
test('MCP tools/call and transport errors preserve their two error envelopes', async () => {
  for (const [input, status, error] of [
    [rpc('tools/call', { name: 'missing_tool' }), 200, { code: -32602, message: 'unknown tool missing_tool' }],
    [rpc('missing_method'), 200, { code: -32601, message: 'method not found: missing_method' }],
    [null, 200, { code: -32600, message: 'invalid request' }],
    ['{broken', 400, { code: -32700, message: 'parse error' }],
  ]) {
    const res = await post(handler.base, input === null ? 'null' : input);
    assert.equal(res.status, status);
    const body = JSON.parse(res.body);
    assert.deepEqual(shape(body), { error: { code: 'number', message: 'string' }, id: input === null || typeof input === 'string' ? 'null' : 'number', jsonrpc: 'string' });
    assert.deepEqual(body.error, error);
  }
  for (const name of ['draft_get', 'stash_get']) {
    const res = await post(handler.base, rpc('tools/call', { name, arguments: { id: 'abcdef987654' } }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(shape(body), { id: 'number', jsonrpc: 'string', result: { content: { array: [{ text: 'string', type: 'string' }] }, isError: 'boolean' } });
    assert.equal(body.result.isError, true); assert.equal(body.result.content[0].type, 'text');
  }
  const notification = await post(handler.base, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202); assert.equal(notification.body, '');
});
test('MCP-only credentials stay scoped to MCP', async () => {
  for (const [route, headers, status] of [
    ['/mcp', { 'x-forwarded-for': '203.0.113.1' }, 403],
    ['/mcp?t=' + MCP_TOKEN, { 'x-forwarded-for': '203.0.113.1' }, 200],
    ['/mcp/' + MCP_TOKEN, { 'tailscale-funnel-request': '?1' }, 200],
    ['/mcp', { 'tailscale-funnel-request': '?1', authorization: 'Bearer ' + MCP_TOKEN }, 200],
    ['/mcp', { 'tailscale-funnel-request': '?1', 'x-meridian-token': TOKEN }, 403],
    ['/api/state?t=' + MCP_TOKEN, { 'x-forwarded-for': '203.0.113.1' }, 403],
  ]) assert.equal((await request(sandbox.base, route, { headers })).status, status, route);
});
