'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { mcpMessage, createTools, createRoutes } = require('../drafts');
const { createStashTools } = require('../stash-tools');
const { handleMcp, tools: testerTools } = require('../tester/mcp');
const protocol = require('../mcp-protocol');

const msg = (method, params, id = 0) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('initialize agrees on supported versions and never echoes an unsupported version', async () => {
  for (const version of protocol.SUPPORTED_VERSIONS) {
    const r = await mcpMessage([], msg('initialize', { protocolVersion: version }));
    assert.equal(r.result.protocolVersion, version);
    assert.equal(r.id, 0);
  }
  for (const version of ['2026-07-28', '2099-01-01', '2024-11-05']) {
    assert.equal((await mcpMessage([], msg('initialize', { protocolVersion: version }))).result.protocolVersion, '2025-11-25');
  }
  assert.equal((await mcpMessage([], msg('initialize'))).result.protocolVersion, '2025-06-18');
  assert.equal((await mcpMessage([], msg('initialize', { protocolVersion: [] }))).error.code, -32602);
});

test('ping and notifications work without executing a notified tool', async () => {
  let ran = false;
  const tools = [{ name: 'write', run() { ran = true; } }];
  assert.deepEqual(await mcpMessage(tools, msg('ping')), { jsonrpc: '2.0', id: 0, result: {} });
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'tools/call']) {
    assert.equal(await mcpMessage(tools, { jsonrpc: '2.0', method, params: { name: 'write' } }), null);
  }
  assert.equal(ran, false);
});

test('invalid envelopes and params produce errors, tool failures remain tool results', async () => {
  for (const value of [null, 3, [], {}, msg('ping', undefined, null), msg('ping', undefined, true), msg('ping', undefined, {}), msg('ping', undefined, 1.5)]) {
    const r = await mcpMessage([], value);
    assert.equal(r.error.code, -32600);
    assert.equal(r.id, null);
    assert.equal(r.result, undefined);
  }
  for (const value of [msg('ping', null), msg('ping', []), msg('tools/call', {}), msg('tools/call', { name: 'write', arguments: [] })]) {
    const r = await mcpMessage([], value);
    assert.equal(r.error.code, -32602);
    assert.equal(r.id, 0);
  }
  assert.equal((await mcpMessage([], msg('unknown', undefined, 'request'))).error.code, -32601);
  assert.equal((await mcpMessage([], msg('tools/call', { name: 'missing' }))).error.code, -32602);
  const tools = [{ name: 'failure', async run() { throw new Error('not allowed'); } }];
  const r = await mcpMessage(tools, msg('tools/call', { name: 'failure' }));
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'not allowed');
});

test('modern metadata cannot invoke tools under the legacy lifecycle', async () => {
  let ran = false;
  const r = await mcpMessage([{ name: 'write', run() { ran = true; } }], msg('tools/call', {
    name: 'write', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
  }));
  assert.equal(r.error.code, -32600);
  assert.equal(ran, false);
});

test('every dashboard, Stash and tester tool exposes explicit behaviour hints', async () => {
  const tools = [...createTools({}, { browse() {}, overview() {}, addTodo() {} }), ...createStashTools({})];
  const read = new Set(['meridian_overview', 'draft_get', 'draft_list', 'draft_history', 'stash_search', 'stash_get', 'stash_spaces']);
  for (const list of [tools, testerTools({ sandboxes: {}, invite: 'test' })]) {
    const r = await mcpMessage(list, msg('tools/list'));
    for (const t of r.result.tools) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof t.annotations[hint], 'boolean', t.name + ': ' + hint);
      assert.equal(t.annotations.readOnlyHint, read.has(t.name), t.name);
      assert.equal(t.run, undefined);
    }
  }
  const listed = (await mcpMessage(tools, msg('tools/list'))).result.tools;
  assert.equal(listed.find((t) => t.name === 'draft_update').annotations.destructiveHint, true);
  assert.equal(listed.find((t) => t.name === 'draft_create').annotations.readOnlyHint, false);
  assert.equal(listed.find((t) => t.name === 'panel_open_url').annotations.openWorldHint, true);
  assert.equal(listed.find((t) => t.name === 'note_add').annotations.idempotentHint, false);
});

test('tool metadata survives listing and image bytes stay out of structured content', async () => {
  const metadata = { title: 'Picture', icons: [{ src: 'https://example.com/icon.png' }], outputSchema: { type: 'object' }, _meta: { 'com.example/test': true } };
  const tools = [{ name: 'picture', inputSchema: { type: 'object' }, ...metadata, annotations: { readOnlyHint: true },
    async run() { return { value: 1, _images: [{ data: 'AAAA', mimeType: 'image/png' }] }; } }];
  const t = (await mcpMessage(tools, msg('tools/list'))).result.tools[0];
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(t[key], value);
  assert.equal(t.annotations.readOnlyHint, true);
  const r = (await mcpMessage(tools, msg('tools/call', { name: 'picture' }))).result;
  assert.deepEqual(r.structuredContent, { value: 1 });
  assert.deepEqual(r.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('HTTP notifications are 202, malformed JSON has a parse error, legacy batches still work', async () => {
  const sent = [];
  const routes = createRoutes({ drafts: {}, tools: [], open() {}, jsonBody() {}, sendJson(res, status, body) { sent.push({ status, body }); } });
  async function post(body, headers = {}) {
    const req = Object.assign(Readable.from([body]), { method: 'POST', headers: { accept: 'application/json, text/event-stream', ...headers } });
    const res = { headersSent: false, writeHead(status) { sent.push({ status }); }, end() {} };
    assert.equal(await routes(req, res, new URL('http://example.com/mcp')), true);
    return sent.pop();
  }
  assert.deepEqual(await post('{"jsonrpc":"2.0","method":"notifications/initialized"}'), { status: 202 });
  const bad = await post('{');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  const batch = await post(JSON.stringify([msg('ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }]));
  assert.deepEqual(batch.body, [{ jsonrpc: '2.0', id: 0, result: {} }]);
  const modern = await post(JSON.stringify(msg('server/discover')), { 'mcp-protocol-version': '2026-07-28' });
  assert.equal(modern.status, 400);
  assert.equal(modern.body.error.code, -32600);
});

test('tester validates before rate limiting and never replies to a notified tool call', async () => {
  async function handle(body, headers = {}) {
    let rateCalls = 0, response;
    await handleMcp({ req: { method: 'POST', headers }, res: { writeHead(status) { response = { status }; }, end() {} }, body,
      sandboxes: {}, invite: 'test', by: 'test', rate() { rateCalls++; return false; }, sendJson(res, status, data) { response = { status, data }; } });
    return { rateCalls, response };
  }
  assert.deepEqual(await handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'todo_add' } }), { rateCalls: 0, response: { status: 202 } });
  const r = await handle(msg('initialize', { protocolVersion: [] }));
  assert.equal(r.response.data.error.code, -32602);
  assert.equal(r.response.data.result, undefined);
  assert.equal((await handle(msg('tools/call', { name: 'todo_add' }))).response.data.result.isError, true);
  const modern = await handle(msg('server/discover'), { 'mcp-protocol-version': '2026-07-28' });
  assert.equal(modern.response.status, 400);
  assert.equal(modern.response.data.error.code, -32600);
});

test('Money stdio survives malformed input and shares version and annotation rules', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-money-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = ['{', 'null', '[]', JSON.stringify(msg('ping', null)), JSON.stringify(msg('initialize', { protocolVersion: '2026-07-28' })),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}', JSON.stringify(msg('ping', undefined, 'ping')), JSON.stringify(msg('tools/list')),
    JSON.stringify(msg('tools/call', { name: 'missing' }))].join('\n') + '\n';
  const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/money-mcp.js')], {
    input, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, MERIDIAN_MONEY_DIR: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.slice(0, 4).map((v) => v.error.code), [-32700, -32600, -32600, -32602]);
  assert.equal(lines[4].result.protocolVersion, '2025-11-25');
  assert.deepEqual(lines[5], { jsonrpc: '2.0', id: 'ping', result: {} });
  assert.equal(lines.length, 8, 'notifications produce no output');
  for (const tool of lines[6].result.tools) {
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'money_receivable_write', tool.name);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean');
    assert.equal(tool.remoteOnly, undefined);
  }
  assert.equal(lines[7].error.code, -32602);
});

test('stdio bridge sends bearer and transport headers, keeps the negotiated version and suppresses 202', async () => {
  let receive;
  const requests = [], output = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/meridian-mcp.js'), 'utf8'), {
    require(name) {
      if (name === 'readline') return { createInterface() { return { on(event, callback) { receive = callback; } }; } };
      if (name === '../mcp-protocol') return protocol;
      throw new Error('unexpected module');
    },
    process: { env: { MERIDIAN_URL: 'http://test.invalid', MERIDIAN_TOKEN: 'fixture-token', MERIDIAN_AGENT: 'Test' }, stdin: {}, stdout: { write(line) { output.push(JSON.parse(line)); } } },
    URLSearchParams,
    async fetch(url, options) {
      requests.push({ url, ...options });
      const r = await mcpMessage([], JSON.parse(options.body));
      return { status: r ? 200 : 202, ok: true, async json() { return r; } };
    },
  });
  await receive(JSON.stringify(msg('initialize', { protocolVersion: '2025-06-18' })));
  await receive('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  await receive(JSON.stringify(msg('ping')));
  assert.equal(output.length, 2);
  for (const r of requests) {
    assert.equal(new URL(r.url).searchParams.has('t'), false);
    assert.equal(r.headers.Authorization, 'Bearer fixture-token');
    assert.equal(r.headers.Accept, 'application/json, text/event-stream');
  }
  assert.equal(requests[0].headers['MCP-Protocol-Version'], undefined);
  assert.equal(requests[1].headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(requests[2].headers['MCP-Protocol-Version'], '2025-06-18');
  await receive('null');
  assert.equal(output.at(-1).error.code, -32600);
  assert.equal(requests.length, 3, 'invalid messages are rejected before HTTP');
});
