'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createDrafts, createTools, mcpMessage } = require('../drafts');

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drafts-'));
  return createDrafts({ file: path.join(dir, 'drafts.json') });
}

test('create names a draft from what it has', async () => {
  const d = await setup();
  assert.equal((await d.create({ kind: 'email', to: 'Sam Boss <personal@example.com>, personal@example.com' })).title, 'Email to Sam Boss');
  assert.equal((await d.create({ kind: 'email', subject: '  Budget  for Q4 ' })).title, 'Budget for Q4');
  assert.equal((await d.create({ kind: 'text', to: 'Dad' })).title, 'Text to Dad');
  assert.equal((await d.create({ kind: 'slack', to: '#team' })).title, 'Slack to #team');
  assert.equal((await d.create({ kind: 'nonsense' })).kind, 'email');
  assert.equal((await d.list()).length, 5);
});

test('update bumps rev, records who changed what, and tells watchers', async () => {
  const d = await setup();
  const x = await d.create({ kind: 'email', body: 'Hi' }, 'Dot');
  const seen = [];
  const stop = d.watch(x.id, (v) => seen.push(v));
  const y = await d.update(x.id, { subject: 'Hello', body: 'Hi' }, 'Dot');
  assert.equal(y.rev, 2);
  assert.deepEqual(y.lastFields, ['subject']);
  assert.equal(y.lastBy, 'Dot');
  assert.equal((await d.update(x.id, { body: 'Hi' })).rev, 2, 'no change, no new revision');
  stop();
  await d.update(x.id, { body: 'Hiya' });
  assert.equal(seen.length, 1);
  await assert.rejects(d.update('nope', {}), /no draft/);
});

test('approval belongs to one revision: editing the words afterwards clears it', async () => {
  const d = await setup();
  const x = await d.create({ kind: 'text', to: 'Dad', body: 'Running late' });
  const ok = await d.update(x.id, { status: 'ready' });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.approvedRev, ok.rev);
  const renamed = await d.update(x.id, { title: 'Dad' });
  assert.equal(renamed.status, 'ready', 'renaming the tab is not the words');
  const edited = await d.update(x.id, { body: 'Running very late' }, 'Dot');
  assert.equal(edited.status, 'drafting');
  assert.equal(edited.approvedRev, null);
  const sent = await d.update(x.id, { status: 'sent' }, 'Dot');
  assert.ok(sent.sentAt);
  await assert.rejects(d.update(x.id, { status: 'posted' }), /status must be/);
});

test('MCP: tools/list, create opens the panel, get reports approval, update cannot approve', async () => {
  const d = await setup();
  const opened = [];
  const tools = createTools(d, { open: (x) => opened.push(x.id), browse: () => {} });
  const call = async (name, args) => (await mcpMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'Dot')).result;
  const init = await mcpMessage(tools, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'meridian');
  assert.equal(await mcpMessage(tools, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const names = (await mcpMessage(tools, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(names.includes('draft_create') && names.includes('panel_open_url') && !names.includes('todo_add'));

  const made = (await call('draft_create', { kind: 'email', to: 'personal@example.com', subject: 'Friday' })).structuredContent;
  assert.deepEqual(opened, [made.id]);
  assert.equal(made.approved, false);
  const upd = (await call('draft_update', { id: made.id, body: 'Hi', status: 'ready' })).structuredContent;
  assert.equal(upd.status, 'drafting', 'an agent cannot approve its own draft');
  assert.equal(upd.lastEditedBy, 'Dot');
  await d.update(made.id, { status: 'ready' });
  assert.equal((await call('draft_get', { id: made.id })).structuredContent.approved, true);
  const bad = await call('panel_open_url', { url: 'javascript:alert(1)' });
  assert.equal(bad.isError, true);
  assert.equal((await mcpMessage(tools, { jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('fromInternet: Funnel and public forwarded addresses need the token; this Mac and the tailnet do not', () => {
  const { fromInternet } = require('../drafts');
  const req = (h) => ({ headers: h });
  assert.equal(fromInternet(req({})), false);
  assert.equal(fromInternet(req({ 'x-forwarded-for': '100.80.0.85' })), false);
  assert.equal(fromInternet(req({ 'x-forwarded-for': '127.0.0.1' })), false);
  assert.equal(fromInternet(req({ 'x-forwarded-for': '100.200.1.1' })), true, 'outside 100.64/10');
  assert.equal(fromInternet(req({ 'x-forwarded-for': '203.0.113.9, 100.80.0.85' })), true);
  assert.equal(fromInternet(req({ 'tailscale-funnel-request': '?1' })), true);
});

test('MCP: odd bodies get an error reply instead of a throw', async () => {
  const tools = createTools(await setup());
  for (const m of [null, 3, 'x', [], { jsonrpc: '2.0' }]) assert.equal((await mcpMessage(tools, m)).error.code, -32600);
});

test('routes: null bodies, Unicode tokens and IPv6 tailnet addresses do not throw or lock Owner out', async () => {
  const { createRoutes, fromInternet } = require('../drafts');
  const { Readable } = require('stream');
  assert.equal(fromInternet({ headers: { 'x-forwarded-for': 'fd7a:115c:a1e0::1234' } }), false);
  const d = await setup();
  const sent = [];
  const sendJson = (res, code, v) => sent.push([code, v]);
  const handle = createRoutes({ drafts: d, tools: createTools(d), jsonBody: async () => ({}), sendJson, open: () => {}, token: 'abcd' });
  const req = (body, headers = {}) => Object.assign(Readable.from([body]), { method: 'POST', headers });
  const res = { headersSent: false, writeHead() {}, end() {} };
  assert.equal(await handle(req('null'), res, new URL('http://x/mcp')), true);
  assert.equal(sent.pop()[1].error.code, -32600);
  // 4 characters, more than 4 bytes
  assert.equal(await handle(req('{}', { 'tailscale-funnel-request': '?1' }), res, new URL('http://x/mcp?t=%C3%A9%C3%A9%C3%A9%C3%A9')), true);
  assert.equal(sent.pop()[0], 403);
});

test('routes: the MCP token opens /mcp (query or path) from the internet, and nothing else', async () => {
  const { createRoutes } = require('../drafts');
  const { Readable } = require('stream');
  const d = await setup();
  const sent = [];
  const handle = createRoutes({ drafts: d, tools: createTools(d), jsonBody: async () => ({}), sendJson: (res, code, v) => sent.push([code, v]), open: () => {}, token: 'dashboard-token-123', mcpToken: 'mcp-token-abcdefghij' });
  const net = { 'tailscale-funnel-request': '?1' };
  const req = (method, body = '') => Object.assign(Readable.from([body]), { method, headers: { ...net } });
  const res = { headersSent: false, writeHead() {}, end() {} };
  const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  await handle(req('POST', ping), res, new URL('http://x/mcp/mcp-token-abcdefghij'));
  assert.deepEqual(sent.pop(), [200, { jsonrpc: '2.0', id: 1, result: {} }]);
  await handle(req('POST', ping), res, new URL('http://x/mcp?t=mcp-token-abcdefghij'));
  assert.equal(sent.pop()[0], 200);
  await handle(req('GET'), res, new URL('http://x/api/drafts?t=mcp-token-abcdefghij'));
  assert.equal(sent.pop()[0], 403, 'the MCP token is not the dashboard token');
  await handle(req('POST', ping), res, new URL('http://x/mcp/wrong-token-abcdefgh'));
  assert.equal(sent.pop()[0], 403);
  await handle(req('GET'), res, new URL('http://x/mcp/mcp-token-abcdefghij'));
  assert.equal(sent.pop()[1].name, 'meridian');
});

test('notion pages: where is part of the words, published link is kept, nothing is dropped', async () => {
  const d = await setup();
  const x = await d.create({ kind: 'notion', where: 'COURSE102 > Week 03', body: '## Week 3\n\nNotes' }, 'Dot');
  assert.equal(x.kind, 'notion');
  assert.equal(x.title, 'Week 3');
  await d.update(x.id, { status: 'ready' });
  assert.equal((await d.update(x.id, { where: 'COURSE101 > Week 03' }, 'Dot')).status, 'drafting', 'moving it needs approving again');
  await assert.rejects(d.update(x.id, { sentUrl: 'javascript:alert(1)' }), /https/);
  const sent = await d.update(x.id, { status: 'sent', sentUrl: 'https://app.notion.com/p/abc' }, 'Dot');
  assert.equal(sent.sentUrl, 'https://app.notion.com/p/abc');
  for (let i = 0; i < 320; i++) await d.create({ kind: 'note', body: 'n' + i });
  assert.ok(await d.get(x.id), 'old drafts are no longer capped at 300');
});

test('archive hides a draft from the live list and lists it with the old ones', async () => {
  const d = await setup();
  const a = await d.create({ kind: 'note', body: 'keep' });
  const b = await d.create({ kind: 'note', body: 'file away' });
  const y = await d.update(b.id, { archived: true });
  assert.equal(y.rev, b.rev + 1);
  assert.deepEqual((await d.list()).map((x) => x.id), [a.id]);
  assert.deepEqual((await d.list({ archived: true })).map((x) => x.id), [b.id]);
  assert.equal((await d.list({ all: true })).length, 2);
});

test('history keeps who changed what, and folds one person\'s typing into one entry', async () => {
  let t = Date.parse('2026-10-06T10:00:00Z');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drafts-'));
  const d = createDrafts({ file: path.join(dir, 'drafts.json'), now: () => t });
  const x = await d.create({ kind: 'notion', body: 'I went to the lecture.' }, 'you');
  t += 1000; await d.update(x.id, { body: 'I went to the lecture on research.' }, 'you');
  t += 1000; await d.update(x.id, { body: 'Attendance at the research methodology lecture was undertaken.' }, 'Dot');
  t += 1000; await d.update(x.id, { body: 'I went to the research lecture.' }, 'you');
  const h = await d.history(x.id);
  assert.deepEqual(h.map((e) => [e.by, e.before, e.after]), [
    ['you', '', 'I went to the lecture on research.'],
    ['Dot', 'I went to the lecture on research.', 'Attendance at the research methodology lecture was undertaken.'],
    ['you', 'Attendance at the research methodology lecture was undertaken.', 'I went to the research lecture.'],
  ]);
  assert.equal(h[1].field, 'body');
  t += 3 * 60 * 1000; await d.update(x.id, { body: 'I went to the research lecture!' }, 'you');
  assert.equal((await d.history(x.id)).length, 4, 'a pause starts a new entry');
  await d.remove(x.id);
  await assert.rejects(d.history(x.id), /no draft/);
});

test('draft_history and draft_mark_sent with a link over MCP', async () => {
  const d = await setup();
  const tools = createTools(d);
  const x = await d.create({ kind: 'notion', body: 'a' });
  await d.update(x.id, { body: 'b' }, 'Dot');
  const h = await mcpMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft_history', arguments: { id: x.id } } });
  assert.equal(h.result.structuredContent.history.length, 2);
  const s = await mcpMessage(tools, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'draft_mark_sent', arguments: { id: x.id, url: 'https://app.notion.com/p/x' } } }, 'Dot');
  assert.equal(s.result.structuredContent.sentUrl, 'https://app.notion.com/p/x');
  assert.equal(s.result.structuredContent.status, 'sent');
});

test('email from: the agent picks an account with a reason; changing it clears the reason and the approval', async () => {
  const d = await setup();
  const tools = createTools(d);
  const r = await mcpMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft_create', arguments: { kind: 'email', to: 'Daniel', from: 'Uni', fromWhy: 'Daniel is your tutor', open: false } } }, 'Dot');
  const x = r.result.structuredContent;
  assert.equal(x.from, 'Uni');
  assert.equal(x.fromWhy, 'Daniel is your tutor');
  await d.update(x.id, { status: 'ready' });
  const y = await d.update(x.id, { from: 'Personal' });
  assert.equal(y.fromWhy, '', 'the old reason goes with the old account');
  assert.equal(y.status, 'drafting', 'a new account needs approving again');
  assert.deepEqual((await d.history(x.id)).filter((e) => e.field === 'from').map((e) => e.after), ['Uni', 'Personal']);
  const n = await mcpMessage(tools, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'draft_create', arguments: { kind: 'notion', body: 'a', open: false } } });
  assert.equal('from' in n.result.structuredContent, false, 'only emails have an account');
});

test('a page with no title is named after its first line', async () => {
  const d = await setup();
  assert.equal((await d.create({ kind: 'notion', body: '\n- In a sentence\nPick the method' })).title, 'In a sentence');
  assert.equal((await d.create({ kind: 'note', body: '  ## Shopping\nmilk' })).title, 'Shopping');
  const named = await d.create({ kind: 'notion', title: 'Week 03', body: 'x' });
  assert.equal(named.named, true);
});
