'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const network = require('../public-network');

test('public-source addresses exclude local, private, metadata and tailnet forms', () => {
  for (const address of ['127.0.0.1', '127.2.3.4', '0.0.0.0', '10.0.0.1', '172.16.1.1', '192.168.1.1',
    '100.64.0.1', '100.127.255.254', '169.254.169.254', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:100.100.1.1', '::ffff:a9fe:a9fe', '::127.0.0.1',
    'fd7a:115c:a1e0::1', 'fe80::1', '64:ff9b::7f00:1', '64:ff9b:1::a9fe:a9fe', '2002:7f00:1::1', 'bad']) {
    assert.equal(network.publicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '2606:4700:4700::1111']) {
    assert.equal(network.publicAddress(address), true, address);
  }
  for (const url of ['https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://[::ffff:127.0.0.1]']) {
    assert.throws(() => network.checkPublicUrl(new URL(url)), { code: 'ERR_PRIVATE_ADDRESS' });
  }
});

function lookupWith(addresses, error) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public-network.js'), 'utf8'), {
    module, require: (name) => name === 'node:dns' ? { lookup: (_host, options, cb) => {
      assert.equal(options.all, true); cb(error, addresses);
    } } : require(name),
  });
  return (options) => new Promise((resolve, reject) => module.exports.publicLookup('source.example', options,
    (err, address, family) => err ? reject(err) : resolve({ address, family })));
}

test('DNS checks every answer and pins the actual connection answer', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: 'fd7a:115c:a1e0::1', family: 6 }]]) {
    await assert.rejects(lookupWith(addresses)({}), { code: 'ERR_PRIVATE_ADDRESS' });
  }
  const lookup = lookupWith([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
  assert.deepEqual(await lookup({}), { address: '8.8.8.8', family: 4 });
  const all = await lookup({ all: true });
  assert.equal(all.address.length, 2);
  assert.equal(all.address[0].address, '8.8.8.8');
  await assert.rejects(lookupWith([], Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }))({}), { code: 'ENOTFOUND' });
});

// Exercise the actual fetcher with a fake HTTPS transport, never a socket.
function fetcher(next) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'almanac.js'), 'utf8');
  const code = source.slice(source.indexOf('function fetchRaw('), source.indexOf('function sniffImage('));
  const seen = [];
  const https = { get(url, options, callback) {
    const req = new EventEmitter(); req.destroy = () => {};
    seen.push(url.href);
    assert.equal(options.lookup, network.publicLookup);
    queueMicrotask(() => {
      const res = new EventEmitter(); res.resume = () => {}; res.complete = true;
      res.statusCode = next ? 302 : 200; res.headers = next ? { location: next } : {};
      callback(res);
      if (!next) { res.emit('data', Buffer.from('public image')); res.emit('end'); }
    });
    return req;
  } };
  const ctx = vm.createContext({ https, URL, Buffer, Date, setTimeout, clearTimeout,
    TIMEOUT_MS: 1000, MAX_REDIRECTS: 3, UA: 'test', ...network });
  vm.runInContext(code, ctx);
  return { fetch: ctx.fetchRaw, seen };
}

test('Almanac rejects literal and redirected private destinations and non-HTTPS schemes', async () => {
  for (const url of ['https://127.0.0.1/admin', 'https://100.100.1.1/', 'https://169.254.169.254/',
    'https://[::1]/', 'file:///etc/passwd', 'http://public.example/']) {
    const f = fetcher();
    await assert.rejects(f.fetch(url)); assert.equal(f.seen.length, 0, url);
  }
  for (const location of ['https://127.0.0.1/admin', 'https://[::ffff:169.254.169.254]/', 'file:///etc/passwd']) {
    const f = fetcher(location);
    await assert.rejects(f.fetch('https://public.example/image'));
    assert.deepEqual(f.seen, ['https://public.example/image']);
  }
  const f = fetcher();
  assert.equal((await f.fetch('https://public.example/image')).body.toString(), 'public image');
});
