'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createGrants, SCOPES, TOOL_SCOPES } = require('../mcp-grants');
const { createDrafts, createTools, mcpMessage } = require('../drafts');
const { createStore } = require('../todos-store');
const { createStash } = require('../stash');
const { createStashTools } = require('../stash-tools');
const { seed, startSandbox, request, TOKEN, MCP_TOKEN, NOW } = require('./helpers/sandbox-server.cjs');
const { startHandler } = require('./helpers/server-handler.cjs');

const rpc = (method, params, id = 7) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
function fixture(t, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-grants-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createGrants({ dataDir: dir, ...(now ? { now } : {}) }) };
}

test('grants store only SHA-256 hashes of 256-bit tokens; list/revoke never return credentials', t => {
  const { dir, store } = fixture(t);
  const created = store.create({ name: 'Dot', scopes: ['read', 'draft-write'] });
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  const file = path.join(dir, 'mcp-grants.json');
  const text = fs.readFileSync(file, 'utf8'), doc = JSON.parse(text);
  assert.equal(text.includes(created.token), false);
  assert.equal(doc.grants[0].hash, crypto.createHash('sha256').update(created.token).digest('hex'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(file + '.lock'), false);
  assert.deepEqual(Object.keys(created.grant).sort(), ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'revokedAt', 'scopes']);
  assert.equal(created.grant.expiresAt, null);
  assert.equal(created.grant.lastUsedAt, null);
  const access = store.access(created.token);
  assert.equal(access.name, 'Dot');
  assert.ok(store.list()[0].lastUsedAt);
  const revoked = store.revoke(created.grant.id);
  assert.ok(revoked.revokedAt);
  assert.equal(store.access(created.token), null);
  assert.throws(() => access.check(), e => e.rpcCode === -32001 && e.statusCode === 401);
  assert.equal(JSON.stringify([store.list(), revoked]).includes(created.token), false);
  assert.equal(JSON.stringify([store.list(), revoked]).includes(doc.grants[0].hash), false);
});

test('grant verification uses timingSafeEqual on fixed-length hashes, including a wrong token', t => {
  const { store } = fixture(t);
  const { token } = store.create({ name: 'Codex', scopes: ['read'] });
  const original = crypto.timingSafeEqual;
  const sizes = [];
  crypto.timingSafeEqual = (a, b) => { sizes.push([a.length, b.length]); return original(a, b); };
  try {
    assert.ok(store.access(token));
    assert.equal(store.access(crypto.randomBytes(32).toString('base64url')), null);
    assert.equal(store.access('short'), null);
  } finally { crypto.timingSafeEqual = original; }
  assert.ok(sizes.length >= 2);
  assert.ok(sizes.every(([a, b]) => a === 32 && b === 32));
});

test('expiry is checked at the boundary and by existing access objects; corrupt data fails closed', t => {
  let now = NOW;
  const { dir, store } = fixture(t, () => now);
  const { token } = store.create({ name: 'Claude', scopes: ['read'], expiresAt: new Date(now + 1000).toISOString() });
  const access = store.access(token);
  now += 1000;
  assert.equal(store.access(token), null);
  assert.throws(() => access.check(), e => e.statusCode === 401);
  fs.writeFileSync(path.join(dir, 'mcp-grants.json'), '{invalid');
  assert.throws(() => store.access(token), /could not be read safely/);
  assert.throws(() => store.list(), /could not be read safely/);
  assert.throws(() => store.create({ name: 'Replacement', scopes: ['read'] }), /could not be read safely/);
  assert.equal(fs.readFileSync(path.join(dir, 'mcp-grants.json'), 'utf8'), '{invalid');
});

test('admin validation and exclusive locks reject unsafe input and concurrent overwrites', t => {
  const { dir, store } = fixture(t);
  for (const input of [{ name: '', scopes: ['read'] }, { name: 'a\nname', scopes: ['read'] }, { name: 'x'.repeat(41), scopes: ['read'] },
    { name: 'Agent', scopes: [] }, { name: 'Agent', scopes: ['money.read'] }, { name: 'Agent', scopes: ['read'], token: 'injected' },
    { name: 'Agent', scopes: ['read'], expiresAt: 'never' }, { name: 'Agent', scopes: ['read'], expiresAt: '2000-01-01' }]) assert.throws(() => store.create(input));
  assert.deepEqual(store.list(), []);
  const { grant } = store.create({ name: 'Agent', scopes: ['read', 'read'] });
  assert.deepEqual(grant.scopes, ['read']);
  fs.writeFileSync(path.join(dir, 'mcp-grants.json.lock'), 'fixture lock');
  assert.throws(() => store.revoke(grant.id), e => e.statusCode === 409);
  assert.equal(store.list()[0].revokedAt, null);
});

test('each scope lists only its family; unknown future tools fail closed and write does not imply read', async t => {
  const { store } = fixture(t);
  const tools = [...createTools({}, { open() {}, browse() {}, overview() {}, addTodo() {} }), ...createStashTools({}),
    { name: 'future_tool', run() { throw new Error('must not execute'); } }];
  assert.deepEqual(tools.slice(0, -1).map(t => t.name).sort(), Object.keys(TOOL_SCOPES).sort());
  for (const scope of SCOPES) {
    const { token } = store.create({ name: 'Scoped', scopes: [scope] });
    const access = store.access(token);
    const listed = await mcpMessage(tools, rpc('tools/list'), access.name, access);
    assert.deepEqual(listed.result.tools.map(t => t.name).sort(), Object.entries(TOOL_SCOPES).filter(([, s]) => s === scope).map(([n]) => n).sort());
    const denied = await mcpMessage(tools, rpc('tools/call', { name: 'future_tool' }), access.name, access);
    assert.equal(denied.error.data.error, 'insufficient_scope');
  }
});

test('denied tools never execute; draft_create requires explicit open:false without host-control', async t => {
  const { dir, store } = fixture(t);
  let opened = 0;
  const drafts = createDrafts({ file: path.join(dir, 'drafts.json') });
  const tools = createTools(drafts, { open() { opened++; }, browse() { opened++; }, addTodo() { opened++; } });
  const { token } = store.create({ name: 'Dot', scopes: ['draft-write'] });
  const access = store.access(token);
  for (const open of [undefined, true, null, 0, 'false']) {
    const denied = await mcpMessage(tools, rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note', ...(open === undefined ? {} : { open }) } }), 'Spoofed', access);
    assert.equal(denied.error.code, -32003);
    assert.deepEqual(denied.error.data.missingScopes, ['host-control']);
    assert.match(denied.error.message, /open:false/);
  }
  assert.deepEqual(await drafts.list(), []);
  for (const [name, missing] of [['draft_get', 'read'], ['todo_add', 'todo-write'], ['draft_open', 'host-control']]) {
    const denied = await mcpMessage(tools, rpc('tools/call', { name }), access.name, access);
    assert.deepEqual(denied.error.data.missingScopes, [missing]);
  }
  const result = await mcpMessage(tools, rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note', body: 'A fixture', open: false } }), 'Spoofed', access);
  assert.equal(result.result.structuredContent.lastEditedBy, 'Dot');
  assert.equal(opened, 0);
  const full = store.create({ name: 'Owner agent', scopes: ['draft-write', 'host-control'] });
  assert.ok((await mcpMessage(tools, rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note' } }), 'Owner agent', store.access(full.token))).result);
  assert.equal(opened, 1);
});

test('a queued draft or todo mutation rechecks revocation before committing', async t => {
  const { dir, store } = fixture(t);
  const created = store.create({ name: 'Worker', scopes: ['draft-write', 'todo-write'] });
  const access = store.access(created.token);
  const drafts = createDrafts({ file: path.join(dir, 'drafts.json') });
  const todos = createStore(path.join(dir, 'todos.json'));
  const pendingDraft = drafts.create({ kind: 'note' }, access.name, () => access.check('draft_create', { open: false }));
  const pendingTodo = todos.create({ title: 'Queued' }, () => access.check('todo_add'));
  store.revoke(created.grant.id);
  const results = await Promise.allSettled([pendingDraft, pendingTodo]);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.statusCode === 401));
  assert.deepEqual(await drafts.list(), []);
  assert.deepEqual((await todos.read()).todos, []);
});

test('revocation during an awaited read prevents returning its private result', async t => {
  const { store } = fixture(t);
  const created = store.create({ name: 'Reader', scopes: ['read'] });
  const access = store.access(created.token);
  const tools = [{ name: 'draft_get', async run() { store.revoke(created.grant.id); return { private: true }; } }];
  const denied = await mcpMessage(tools, rpc('tools/call', { name: 'draft_get' }), access.name, access);
  assert.equal(denied.error.data.httpStatus, 401);
  assert.equal(denied.result, undefined);
});

test('note attribution comes from a grant, and existing hidden Stash spaces stay excluded', async t => {
  const { dir, store } = fixture(t);
  const stash = createStash({ dir: path.join(dir, 'stash'), now: () => NOW });
  const created = store.create({ name: 'Verified', scopes: ['read', 'draft-write'] });
  const access = store.access(created.token);
  const tools = createStashTools(stash);
  const added = await mcpMessage(tools, rpc('tools/call', { name: 'note_add', arguments: { text: 'Fixture note', spaces: ['private'] } }), access.name, access);
  assert.equal((await stash.get(added.result.structuredContent.saved)).agent, 'Verified');
  const hidden = await mcpMessage(tools, rpc('tools/call', { name: 'stash_get', arguments: { id: added.result.structuredContent.saved } }), access.name, access);
  assert.equal(hidden.result.isError, true);
  assert.equal((await mcpMessage(tools, rpc('tools/call', { name: 'stash_search' }), access.name, access)).result.structuredContent.total, 0);
});

test('offline CLI creates, lists and revokes in a chosen data directory without returning tokens again', t => {
  const { dir } = fixture(t);
  const script = path.join(__dirname, '../scripts/mcp-grant.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args, '--data-dir', dir], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
  const created = run('create', '--name', 'Dot', '--scopes', 'read,draft-write', '--expires', '30d');
  assert.equal(created.status, 0, created.stderr);
  const { grant, token } = JSON.parse(created.stdout);
  assert.ok(Date.parse(grant.expiresAt) > Date.parse(grant.createdAt) + 29 * 86400000);
  for (const args of [['list'], ['revoke', grant.id], ['list']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(token), false);
    assert.equal(result.stdout.includes('hash'), false);
  }
  assert.equal(created.stderr, '');
  assert.equal(run('create', '--name', 'Bad', '--scopes', 'money.read').status, 1);
  assert.equal(run('create', '--name', 'Bad', '--scopes', 'read', '--expires', 'invalid').status, 1);
  assert.equal(JSON.parse(run('list').stdout).grants.length, 1);
});

test('server handler enforces scope/Bearer precedence, owner-only administration and legacy clients', async t => {
  const { dir } = fixture(t);
  const seeded = await seed(dir);
  const todos = createStore(path.join(seeded.data, 'todos.json'));
  let opened = 0;
  const handler = await startHandler(seeded, {}, { open() { opened++; }, browse() { opened++; }, addTodo: (input, check) => todos.create(input, check), overview: async () => ({ json: {}, md: 'Fixture' }) });
  t.after(() => handler.stop());
  const store = handler.context.mcpGrants;
  const post = (route, body, headers = {}) => request(handler.base, route, { method: 'POST', headers, body });
  const fullNames = require('./fixtures/server-contract/tools.json');
  const admin = await post('/api/mcp/grants', { name: 'Dot', scopes: ['read', 'draft-write'] });
  assert.equal(admin.status, 201);
  assert.equal(admin.headers['cache-control'], 'no-store');
  const created = JSON.parse(admin.body), token = created.token;
  const bearer = { authorization: 'Bearer ' + token };
  const listed = await post('/mcp?as=Spoofed&t=' + MCP_TOKEN, rpc('tools/list'), bearer);
  assert.equal(listed.status, 200);
  const names = JSON.parse(listed.body).result.tools.map(t => t.name);
  assert.ok(names.includes('draft_create'));
  assert.equal(names.includes('draft_open'), false);
  assert.equal(names.includes('todo_add'), false);
  assert.equal(JSON.parse((await request(handler.base, '/mcp', { headers: bearer })).body).tools.length, names.length);
  const added = await post('/mcp?as=Spoofed', rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note', open: false, body: 'Scoped' } }), bearer);
  assert.equal(added.status, 200);
  assert.equal(JSON.parse(added.body).result.structuredContent.lastEditedBy, 'Dot');
  const denied = await post('/mcp', rpc('tools/call', { name: 'todo_add', arguments: { title: 'Denied' } }), bearer);
  assert.equal(denied.status, 403);
  assert.match(denied.headers['www-authenticate'], /insufficient_scope.*todo-write/);
  assert.equal(JSON.parse(denied.body).error.data.missingScopes[0], 'todo-write');
  assert.equal((await post('/mcp', rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note' } }), bearer)).status, 403);
  assert.equal(opened, 0);
  for (const headers of [{}, { 'x-forwarded-for': '100.64.0.1' }, { 'tailscale-funnel-request': '?1' }]) {
    for (const route of ['/mcp?t=' + token, '/mcp/' + token]) assert.equal((await post(route, rpc('tools/list'), headers)).status, 401, 'grant URLs rejected on every network');
    for (const route of ['/api/state', '/api/mcp/grants', '/api/drafts']) assert.equal((await request(handler.base, route, { headers: { ...headers, ...bearer } })).status, 403, route);
    assert.equal((await request(handler.base, '/api/mcp/grants', { headers: { ...headers, 'x-meridian-token': token } })).status, 403);
    assert.equal((await post('/api/mcp/grants', { name: 'Bad', scopes: ['host-control'] }, { ...headers, ...bearer })).status, 403);
  }
  assert.equal((await post('/mcp?t=' + MCP_TOKEN, rpc('tools/list'), { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post('/mcp', rpc('tools/list'), { ...bearer, 'tailscale-funnel-request': '?1' })).status, 200);
  for (const owner of [TOKEN, MCP_TOKEN]) {
    for (const [route, headers] of [['/mcp?t=' + owner, {}], ['/mcp/' + owner, {}], ['/mcp', { authorization: 'Bearer ' + owner }]]) {
      const res = await post(route, rpc('tools/list'), { 'tailscale-funnel-request': '?1', ...headers });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body).result.tools.map(t => t.name), fullNames);
    }
  }
  const legacy = await post('/mcp?as=Legacy', rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note' } }));
  assert.equal(legacy.status, 200);
  assert.equal(JSON.parse(legacy.body).result.structuredContent.lastEditedBy, 'Legacy');
  assert.equal(opened, 1);
  // A URL holding the owner token cannot override a scoped Bearer token.
  assert.equal((await post('/mcp/' + MCP_TOKEN, rpc('tools/call', { name: 'draft_open', arguments: { id: JSON.parse(legacy.body).result.structuredContent.id } }), bearer)).status, 403);
  const adminRemote = await post('/api/mcp/grants?t=' + TOKEN, { name: 'Remote', scopes: ['read'] }, { 'tailscale-funnel-request': '?1' });
  assert.equal(adminRemote.status, 403);
  const publicList = await request(handler.base, '/api/mcp/grants');
  assert.equal(publicList.status, 200);
  assert.equal(publicList.body.includes(token), false);
  assert.equal(publicList.body.includes('hash'), false);
  const revoked = await request(handler.base, '/api/mcp/grants/' + created.grant.id, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.includes(token), false);
  assert.equal((await post('/mcp', rpc('tools/list'), bearer)).status, 401);
  assert.equal((await post('/mcp', rpc('tools/call', { name: 'draft_create', arguments: { kind: 'note', open: false } }), bearer)).status, 401);
  assert.equal((await request(handler.base, '/api/state', { headers: bearer })).status, 403);
  assert.equal(store.list().length, 1);
});

test('scoped initialize/auth failures never log or return the token, including revoked credentials', async t => {
  const { store } = fixture(t);
  const created = store.create({ name: 'Quiet', scopes: ['read'] });
  const access = store.access(created.token);
  const logs = [], original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = await mcpMessage([], rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: created.token } }), access.name, access);
    assert.equal(JSON.stringify(result).includes(created.token), false);
  } finally { console.log = original; }
  assert.equal(logs.join('').includes(created.token), false);
  store.revoke(created.grant.id);
  const denied = await mcpMessage([], rpc('ping'), access.name, access);
  assert.equal(JSON.stringify(denied).includes(created.token), false);
});

test('real isolated daemon creates grants, enforces writes and sees offline revocation without restarting', async t => {
  const server = await startSandbox({ preload: path.join(__dirname, 'helpers/grants-sandbox.cjs') });
  t.after(() => server.stop());
  const post = (route, body, token) => request(server.base, route, { method: 'POST', body,
    headers: token ? { authorization: 'Bearer ' + token, 'tailscale-funnel-request': '?1' } : {} });
  const create = await post('/api/mcp/grants', { name: 'Real worker', scopes: ['todo-write'] });
  assert.equal(create.status, 201);
  const { grant, token } = JSON.parse(create.body);
  const list = await post('/mcp', rpc('tools/list'), token);
  assert.deepEqual(JSON.parse(list.body).result.tools.map(t => t.name), ['todo_add']);
  const add = await post('/mcp?as=Impostor', rpc('tools/call', { name: 'todo_add', arguments: { title: 'Real fixture task' } }), token);
  assert.equal(add.status, 200);
  assert.ok(JSON.parse(fs.readFileSync(path.join(server.data, 'todos.json'), 'utf8')).todos.some(t => t.title === 'Real fixture task'));
  assert.equal((await post('/mcp', rpc('tools/call', { name: 'meridian_overview' }), token)).status, 403);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../scripts/mcp-grant.js'), 'revoke', grant.id, '--data-dir', server.data],
    { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((await post('/mcp', rpc('tools/list'), token)).status, 401);
  assert.equal((await post('/mcp', rpc('tools/call', { name: 'todo_add', arguments: { title: 'Revoked fixture task' } }), token)).status, 401);
  assert.equal(JSON.parse(fs.readFileSync(path.join(server.data, 'todos.json'), 'utf8')).todos.some(t => t.title === 'Revoked fixture task'), false);
  const adminList = await request(server.base, '/api/mcp/grants');
  assert.equal(adminList.body.includes(token), false);
  assert.equal(cli.stdout.includes(token), false);
  assert.equal((server.logs().output + server.logs().errors).includes(token), false);
  assert.equal(server.logs().errors, '');
});

test('stdio bridge preserves scoped JSON-RPC denial and the missing-scope guidance', async () => {
  let receive;
  const output = [];
  const denied = { jsonrpc: '2.0', id: 7, error: { code: -32003, message: 'Missing scope: todo-write', data: { httpStatus: 403, missingScopes: ['todo-write'] } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/meridian-mcp.js'), 'utf8'), {
    require(name) { if (name === 'readline') return { createInterface: () => ({ on(event, fn) { receive = fn; } }) }; return require('../mcp-protocol'); },
    process: { env: {}, stdin: {}, stdout: { write(line) { output.push(JSON.parse(line)); } } }, URLSearchParams,
    fetch: async () => ({ status: 403, ok: false, json: async () => denied }),
  });
  await receive(JSON.stringify(rpc('tools/call', { name: 'todo_add' })));
  assert.deepEqual(output, [denied]);
});
