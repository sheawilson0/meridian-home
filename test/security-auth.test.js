'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const draftsLib = require('../drafts');

// Read the real guard without booting collectors, a listener or private data.
function guards(token = 'dashboard-test-token-1234') {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = source.slice(source.indexOf('function isLoopback('), source.indexOf('const MIME ='));
  let comparisons = 0;
  const ctx = vm.createContext({ URL, Buffer, draftsLib,
    mcpGrants: { recognizes: () => false }, bearer: require('../mcp-grants').bearer,
    CONFIG: { token, port: 4980, tailscale: { hostname: 'owner.example.ts.net' } },
    tailnetCache: { info: null },
    crypto: { timingSafeEqual(a, b) { comparisons++; return crypto.timingSafeEqual(a, b); } },
  });
  vm.runInContext(code, ctx);
  const request = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
  return { ctx, request, comparisons: () => comparisons };
}

test('dashboard fallback uses timing-safe bytes and preserves credential precedence', () => {
  const g = guards(), req = (headers) => g.request('203.0.113.5', headers);
  assert.equal(g.ctx.authorized(req({}), new URL('http://x/?t=dashboard-test-token-1234')), true);
  assert.equal(g.ctx.authorized(req({ 'x-meridian-token': 'dashboard-test-token-1234' }), new URL('http://x/')), true);
  assert.equal(g.comparisons(), 2);
  assert.equal(g.ctx.authorized(req({}), new URL('http://x/?t=dashboard-test-token-1235')), false);
  assert.equal(g.comparisons(), 3, 'equal-size wrong tokens use the same comparison');
  for (const token of ['', 'short', 'dashboard-test-token-1234-extra']) {
    assert.equal(g.ctx.authorized(req({}), new URL('http://x/?t=' + token)), false);
  }
  assert.equal(g.ctx.authorized(req({ 'x-meridian-token': 'dashboard-test-token-1234' }), new URL('http://x/?t=wrong')), false);
  assert.equal(g.ctx.authorized(req({ authorization: 'Bearer dashboard-test-token-1234' }), new URL('http://x/')), false);
  const unicode = guards('é');
  assert.equal(unicode.ctx.authorized(unicode.request('203.0.113.5'), new URL('http://x/?t=%C3%A9')), true);
  assert.equal(unicode.ctx.authorized(unicode.request('203.0.113.5'), new URL('http://x/?t=x')), false);
  assert.equal(guards('').ctx.authorized(req({}), new URL('http://x/?t=anything')), false);
});

test('existing loopback, tailnet and proxy boundaries remain intact', () => {
  const g = guards(), url = new URL('http://x/');
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.127.255.254', '::ffff:100.100.1.1']) {
    assert.equal(g.ctx.authorized(g.request(ip), url), true, ip);
  }
  for (const ip of ['100.63.255.254', '100.128.0.1', '192.168.1.2', '203.0.113.5']) {
    assert.equal(g.ctx.authorized(g.request(ip), url), false, ip);
  }
  assert.equal(g.ctx.authorized(g.request('127.0.0.1', { 'x-forwarded-for': '100.100.1.1' }), url), true);
  assert.equal(g.ctx.authorized(g.request('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' }), url), false);
  assert.equal(g.ctx.authorized(g.request('127.0.0.1', { 'tailscale-funnel-request': '1', 'x-forwarded-for': '100.100.1.1' }), url), false);
  assert.equal(g.ctx.authorized(g.request('203.0.113.5', { 'x-forwarded-for': '127.0.0.1' }), url), false);
});

test('Origin rejects opaque and foreign browser origins while retaining native calls', () => {
  const { ctx, request } = guards();
  for (const origin of ['null', '', 'file:///tmp/page', 'https://other.example', 'http://localhost:9999']) {
    assert.equal(ctx.allowedOrigin(request('127.0.0.1', { host: '127.0.0.1:4980', origin })), false, origin);
  }
  assert.equal(ctx.allowedOrigin(request('127.0.0.1', { host: '127.0.0.1:4980' })), true);
  assert.equal(ctx.allowedOrigin(request('127.0.0.1', { host: '127.0.0.1:4980', origin: 'http://127.0.0.1:4980' })), true);
});
