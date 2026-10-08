'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createMoney, writeJson } = require('../money');
const A = require('../money-agent');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bank = { id: 'imported-credit', counterpartyId: 'verified-father', name: 'Example Dad', amount: 42, currency: 'GBP', date: '2026-10-01', type: 'Faster payment', status: 'posted' };
async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-agent-test-'));
  const tokens = { legacy: 'l'.repeat(43), scoped: 's'.repeat(43), read: 'r'.repeat(43), write: 'w'.repeat(43), empty: 'e'.repeat(43), expired: 'x'.repeat(43) };
  const grants = Object.entries(tokens).map(([name, token]) => ({ name, h: hash(token), ...(name === 'legacy' ? {} : { scopes: name === 'scoped' || name === 'expired' ? ['money.read', 'receivables.write'] : name === 'empty' ? [] : [name === 'write' ? 'receivables.write' : 'money.read'] }), ...(name === 'expired' ? { expiresAt: '2020-01-01T00:00:00Z' } : {}) }));
  await writeJson(path.join(dir, 'agents.json'), { tokens: grants });
  await writeJson(path.join(dir, 'monzo.json'), { pulledAt: '2026-10-04T06:00:00Z', transactions: [bank] });
  await writeJson(path.join(dir, 'credentials.json'), { google: { refresh_token: 'TEST-SECRET-DO-NOT-RETURN' } });
  const originalBank = fs.readFileSync(path.join(dir, 'monzo.json'), 'utf8');
  let calls = 0;
  const money = createMoney({ dir, now: () => Date.parse('2026-10-04T18:00:00Z'), wait: async () => {}, request: async () => { calls++; throw new Error('upstream prohibited'); } });
  const server = http.createServer(async (req, res) => { if (!await money.handle(req, res, new URL(req.url, 'http://test'))) { res.writeHead(404); res.end('{}'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, name = 'scoped', body, extra = {}, method = body === undefined ? 'GET' : 'POST') {
    const r = await fetch(base + route, { method, headers: { ...(name ? { Authorization: 'Bearer ' + (tokens[name] || name) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  return { dir, tokens, grants, money, base, call, originalBank, calls: () => calls };
}

test('scoped snapshot retains source freshness, omits secrets and respects legacy/read/expired grants', async t => {
  const h = await harness(t);
  for (const name of ['legacy', 'read', 'scoped']) {
    const r = await h.call('/api/money/agent', name); assert.equal(r.status, 200); assert.equal(r.json.monzo.pulledAt, '2026-10-04T06:00:00Z'); assert.ok(!JSON.stringify(r.json).includes('TEST-SECRET'));
    assert.equal((await h.call('/api/money/agent/receivables', name)).status, 200);
  }
  for (const name of [null, 'bad', 'expired']) assert.equal((await h.call('/api/money/agent', name)).status, 401);
  for (const name of ['write', 'empty']) assert.equal((await h.call('/api/money/agent', name)).status, 403);
  assert.equal(h.calls(), 0);
});

test('legacy/read grants cannot write; scoped grants cannot reach any excluded browser or agent route', async t => {
  const h = await harness(t);
  for (const name of ['legacy', 'read', 'empty']) assert.equal((await h.call('/api/money/agent/receivables', name, { action: 'create', who: 'Dad', amount: 42 })).status, 403);
  for (const prefix of ['/api/money/', '/api/money/agent/']) for (const route of ['refresh', 't212-key', 'passcode', 'setup', 'unlock', 'lock', 'accounts', 'rules', 'context', 'plans', 'settings', 'seen', 'adviser', 'advice', 'agents', 'transfer', 'orders']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await h.call(prefix + route, 'scoped', method === 'GET' ? undefined : {}, {}, method)).status, 403, prefix + route + method);
  }
  assert.equal((await h.call('/api/money/receivables', 'scoped', { action: 'create', who: 'Dad', amount: 42 })).status, 403);
  assert.equal((await h.call('/api/money/agent/receivables', 'scoped', {}, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal(h.calls(), 0); assert.equal(fs.existsSync(path.join(h.dir, 'receivables.json')), false);
});

test('create/edit/link/settle/undo commit audit evidence without changing bank imports; create retries deduplicate', async t => {
  const h = await harness(t); const route = '/api/money/agent/receivables';
  let r = await h.call(route, 'scoped', { action: 'create', who: 'Dad', amount: 42, note: 'Test claim', key: 'retry-42' });
  assert.equal(r.status, 200); const id = r.json.claim.id;
  r = await h.call(route, 'scoped', { action: 'create', who: 'Dad', amount: 42, note: 'Test claim', key: 'retry-42' }); assert.equal(r.json.claim.id, id);
  assert.equal((await h.call(route, 'scoped', { action: 'link', id, senderId: 'invented' })).status, 400);
  assert.equal((await h.call(route, 'scoped', { action: 'link', id, senderId: bank.counterpartyId })).status, 200);
  r = await h.call(route, 'scoped', { action: 'edit', id, who: 'Father', amount: 43.27, note: 'Updated' }); assert.equal(r.status, 200); assert.equal(r.json.claim.amount, 43.27); assert.ok(r.json.claim.excludedTransactionIds.includes(bank.id));
  r = await h.call(route, 'scoped', { action: 'settle', id }); assert.equal(r.json.claim.settled, true);
  assert.equal((await h.call(route, 'scoped', { action: 'edit', id, amount: 50 })).status, 400);
  r = await h.call(route, 'scoped', { action: 'undo', id }); assert.equal(r.json.claim.settled, false);
  const doc = JSON.parse(fs.readFileSync(path.join(h.dir, 'receivables.json')));
  assert.equal(doc.claims.length, 1); assert.deepEqual(doc.agentAudit.map(a => a.action), ['create', 'create', 'link', 'edit', 'settle', 'undo']);
  assert.ok(doc.agentAudit.every(a => a.agent === 'scoped' && a.scope === 'receivables.write' && a.claimId === id && a.after));
  const edit = doc.agentAudit.find(a => a.action === 'edit'); assert.equal(edit.before.amount, 42); assert.equal(edit.after.amount, 43.27);
  assert.equal(fs.statSync(path.join(h.dir, 'receivables.json')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(h.dir, 'monzo.json'), 'utf8'), h.originalBank); assert.equal(h.calls(), 0);
  assert.ok(!JSON.stringify(doc).includes(h.tokens.scoped));
});

test('validation rejects forged lifecycle/audit fields, seeding, unknown IDs and invalid amounts', async t => {
  const h = await harness(t);
  for (const body of [{ action: 'seed-approved' }, { action: 'create', who: 'Dad', amount: 42, settled: true }, { action: 'create', who: 'Dad', amount: 42, history: [] }, { action: 'create', who: 'Dad', amount: 42, senderId: 'guess' }, { action: 'create', who: 'Dad', amount: -1 }, { action: 'create', who: 'Dad', amount: '42' }, { action: 'create', who: {}, amount: 42 }, { action: 'settle' }, { action: 'edit', id: 'unknown', amount: 42 }, { action: 'link', id: 'unknown' }]) assert.equal((await h.call('/api/money/agent/receivables', 'scoped', body)).status, 400);
  assert.equal(fs.existsSync(path.join(h.dir, 'receivables.json')), false);
});

test('revocation is reread immediately; browser unlock never expands agent privileges', async t => {
  const h = await harness(t);
  const setup = await h.call('/api/money/setup', null, { passcode: 'fixture-passcode' }); assert.equal(setup.status, 200);
  assert.equal((await h.call('/api/money/agent/receivables', 'legacy', { action: 'create', who: 'Dad', amount: 42 }, { Cookie: setup.cookie })).status, 403);
  assert.equal((await h.call('/api/money/accounts', 'scoped', { accounts: [] }, { Cookie: setup.cookie }, 'PUT')).status, 403);
  await writeJson(path.join(h.dir, 'agents.json'), { tokens: h.grants.filter(g => g.name !== 'scoped') });
  assert.equal((await h.call('/api/money/agent', 'scoped')).status, 401);
  assert.equal((await h.call('/api/money/agent/receivables', 'scoped', { action: 'create', who: 'Dad', amount: 42 })).status, 401);
  assert.equal((await h.call('/api/money/agent', 'legacy')).status, 200);
  assert.equal((await h.call('/api/money', null, undefined, { Cookie: setup.cookie })).status, 200);
});

test('concurrent agent writes preserve records and audits, including write-only tokens', async t => {
  const h = await harness(t);
  const replies = await Promise.all(Array.from({ length: 12 }, (_, n) => h.call('/api/money/agent/receivables', 'write', { action: 'create', who: 'Claim ' + n, amount: n + 1, key: 'claim-' + n })));
  assert.ok(replies.every(r => r.status === 200));
  const doc = JSON.parse(fs.readFileSync(path.join(h.dir, 'receivables.json'))); assert.equal(doc.claims.length, 12); assert.equal(doc.agentAudit.length, 12);
});

test('scope parsing never broadens defaults and expiry fails closed', () => {
  assert.deepEqual(A.parseScopes(), ['money.read']); assert.deepEqual(A.parseScopes('money.read,receivables.write'), ['money.read', 'receivables.write']);
  assert.throws(() => A.parseScopes('money.admin')); assert.throws(() => A.parseScopes('money.read,'));
  const token = 'k'.repeat(43); assert.equal(A.principal({ tokens: [{ h: hash(token), expiresAt: 'broken' }] }, token, Date.now()), null);
});

test('MCP scoped write client uses the authenticated API and invalidates read cache', async t => {
  const h = await harness(t);
  const proc = spawn(process.execPath, [path.join(__dirname, '../scripts/money-mcp.js')], { env: { ...process.env, MERIDIAN_MONEY_URL: h.base, MERIDIAN_MONEY_TOKEN: h.tokens.scoped, MERIDIAN_MONEY_DIR: path.join(h.dir, 'never-read-this-directory') }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => proc.kill());
  let pending = new Map(), buffer = '', next = 0;
  proc.stdout.on('data', data => { buffer += data; let nl; while ((nl = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); const msg = JSON.parse(line); pending.get(msg.id)?.(msg.result); pending.delete(msg.id); } });
  function rpc(method, params) { const id = ++next; return new Promise(resolve => { pending.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
  await rpc('initialize', {});
  const list = await rpc('tools/list', {}); assert.ok(list.tools.some(x => x.name === 'money_receivable_write')); assert.ok(!list.tools.some(x => 'remoteOnly' in x));
  let r = await rpc('tools/call', { name: 'money_receivable_write', arguments: { action: 'create', who: 'MCP claim', amount: 10, key: 'mcp-one' } }); assert.ok(!r.isError); assert.equal(JSON.parse(r.content[0].text).claim.who, 'MCP claim');
  r = await rpc('tools/call', { name: 'money_receivables', arguments: {} }); assert.equal(JSON.parse(r.content[0].text).claims.length, 1);
  r = await rpc('tools/call', { name: 'money_overview', arguments: {} }); assert.ok(!r.isError);
  await writeJson(path.join(h.dir, 'agents.json'), { tokens: [] });
  r = await rpc('tools/call', { name: 'money_overview', arguments: {} }); assert.equal(r.isError, true, 'cached reads must reauthenticate after revocation');
  r = await rpc('tools/call', { name: 'money_receivable_write', arguments: { action: 'create', who: 'Denied', amount: 10 } }); assert.equal(r.isError, true);
});
