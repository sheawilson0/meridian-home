'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const draftsLib = require('../drafts');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const a = source.indexOf('function isLoopback('), b = source.indexOf('const MIME =', a);
assert.ok(a >= 0 && b > a, 'guard section exists');
function guards(token = 'fixture-token') {
  const context = { URL, Buffer, crypto: require('node:crypto'), draftsLib, CONFIG: { token, port: 4980, tailscale: { hostname: 'fixture.example.ts.net' } }, tailnetCache: { info: { host: 'discovered.example.ts.net' } } };
  vm.createContext(context); vm.runInContext(source.slice(a, b), context);
  context.mcpGrants = { recognizes: () => false }; context.bearer = require('../mcp-grants').bearer;
  return context;
}
const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers: { host: '127.0.0.1:4980', ...headers } });
test('authorization accepts loopback and only the Tailnet address range without a token', () => {
  const g = guards(null), url = new URL('http://fixture/api/state');
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.127.255.254', '::ffff:100.64.0.1']) assert.equal(g.authorized(req(address), url), true, address);
  for (const address of ['100.63.255.254', '100.128.0.1', '192.168.1.1', '203.0.113.1', '']) assert.equal(g.authorized(req(address), url), false, address);
});
test('internet proxies need the token and cannot borrow loopback trust', () => {
  const g = guards(), url = new URL('http://fixture/api/state');
  for (const headers of [{ 'tailscale-funnel-request': '?1' }, { 'tailscale-funnel-request': '' }, { 'x-forwarded-for': '203.0.113.1' }, { 'x-forwarded-for': '203.0.113.1, 100.64.0.1' }]) {
    assert.equal(g.authorized(req('127.0.0.1', headers), url), false);
    assert.equal(g.authorized(req('127.0.0.1', { ...headers, 'x-meridian-token': 'fixture-token' }), url), true);
  }
  assert.equal(g.authorized(req('203.0.113.1', { 'x-meridian-token': 'fixture-token' }), url), true);
  assert.equal(g.authorized(req('203.0.113.1'), new URL('http://fixture/?t=fixture-token')), true);
  assert.equal(g.authorized(req('203.0.113.1', { 'x-meridian-token': 'wrong' }), url), false);
});
test('origins reject credentials, malformed values, unrelated hosts and foreign ports', () => {
  const g = guards(), allowed = origin => g.allowedOrigin(req('127.0.0.1', { origin }));
  for (const origin of [undefined, 'http://127.0.0.1:4980', 'http://localhost:4980', 'http://[::1]:4980', 'https://fixture.example.ts.net', 'https://discovered.example.ts.net']) assert.equal(allowed(origin), true, String(origin));
  for (const origin of ['null', '', 'file:///tmp/page', 'https://evil.example', 'http://localhost:4981', 'https://fixture.example.ts.net:444', 'https://user:personal@example.com', 'https://fixture.example.ts.net/path', 'https://fixture.example.ts.net/?q=1', 'https://fixture.example.ts.net/#x', 'https://[']) assert.equal(allowed(origin), false, origin);
});
