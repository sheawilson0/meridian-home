'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createShares, createIgnoreList, parseServeStatus, pickHttpsPort, shareFor, validPort } = require('../local-share');

const HOST = 'studio.example.invalid';

// A stand-in for the tailscale CLI that keeps serve config in memory and
// records every call, so the tests can check exactly what would have run.
function fakeTailscale(initial) {
  const conf = JSON.parse(JSON.stringify(initial));
  const calls = [];
  const runner = async (bin, args) => {
    calls.push(args);
    if (args[0] === 'serve' && args[1] === 'status') return { ok: true, stdout: JSON.stringify(conf), stderr: '' };
    const https = args.find((a) => a.startsWith('--https='));
    const port = https && https.slice(8);
    if (args[args.length - 1] === 'off') {
      delete conf.TCP[port]; delete conf.Web[`${HOST}:${port}`];
      return { ok: true, stdout: '', stderr: '' };
    }
    conf.TCP[port] = { HTTPS: true };
    conf.Web[`${HOST}:${port}`] = { Handlers: { '/': { Proxy: args[args.length - 1] } } };
    return { ok: true, stdout: 'Serve started', stderr: '' };
  };
  return { conf, calls, runner };
}

const BASE = {
  TCP: { 443: { HTTPS: true }, 10000: { HTTPS: true }, 19443: { HTTPS: true }, 14420: { HTTPS: true } },
  Web: {
    [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4980' }, '/slides': { Proxy: 'http://127.0.0.1:8936' } } },
    [`${HOST}:10000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } },
    [`${HOST}:19443`]: { Handlers: { '/': { Proxy: 'http://localhost:4420' } } },
    [`${HOST}:14420`]: { Handlers: { '/': { Path: '/tmp/site' } } },
  },
};

test('parseServeStatus, shareFor and pickHttpsPort', () => {
  const s = parseServeStatus(BASE);
  assert.deepEqual([...s.usedPorts].sort((a, b) => a - b), [443, 10000, 14420, 19443]);
  assert.equal(shareFor(4980, s.mappings).url, `https://${HOST}/`);
  assert.equal(shareFor(8936, s.mappings).url, `https://${HOST}/slides`);
  assert.equal(shareFor(4420, s.mappings).url, `https://${HOST}:19443/`, 'localhost targets count');
  assert.equal(shareFor(5555, s.mappings), null);
  assert.deepEqual(parseServeStatus({}).mappings, []);
  assert.equal(pickHttpsPort(4420, s.usedPorts), 10001, ':14420 is taken, so the first free port above 10000');
  assert.equal(pickHttpsPort(3100, s.usedPorts), 13100);
  assert.equal(pickHttpsPort(60000, s.usedPorts), 10001, 'past 65535 falls back to the first free port above 10000');
  assert.equal(pickHttpsPort(60000, new Set([10001, 10002])), 10003);
  assert.equal(validPort('4420'), 4420);
  assert.throws(() => validPort('44; rm -rf /'), /integer/);
  assert.throws(() => validPort(4420.5), /integer/);
  assert.throws(() => validPort(70000), /integer/);
});

test('annotate adds shareUrl and reachable', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-share-'));
  const ts = fakeTailscale(BASE);
  const shares = createShares({ bin: 'tailscale', file: path.join(dir, 'shares.json'), runner: ts.runner });
  const servers = await shares.annotate([
    { port: 4420, tailUrl: null }, { port: 3200, tailUrl: `http://${HOST}:3200/` }, { port: 4440, tailUrl: null },
  ]);
  assert.deepEqual(servers.map((s) => [s.port, s.shareUrl, s.reachable, s.shareOwned]), [
    [4420, `https://${HOST}:19443/`, `https://${HOST}:19443/`, false],
    [3200, null, `http://${HOST}:3200/`, false],
    [4440, null, null, false],
  ]);
});

test('share makes one mapping, reuses an existing one, and never touches others', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-share-'));
  const ts = fakeTailscale(BASE);
  const shares = createShares({ bin: 'tailscale', file: path.join(dir, 'shares.json'), runner: ts.runner, listeningPorts: async () => new Set([14440]) });

  const existing = await shares.share(4420);
  assert.deepEqual([existing.url, existing.existing, existing.owned], [`https://${HOST}:19443/`, true, false]);
  assert.ok(!ts.calls.some((a) => a.includes('--bg')), 'nothing run for an existing mapping');

  // 4440 + 10000 is held by a local listener, so the first free port above 10000.
  const made = await shares.share(4440);
  assert.deepEqual([made.url, made.httpsPort, made.existing, made.owned], [`https://${HOST}:10001/`, 10001, false, true]);
  assert.deepEqual(ts.calls.find((a) => a.includes('--bg')), ['serve', '--bg', '--yes', '--https=10001', 'http://127.0.0.1:4440']);
  const madeAgain = await shares.share(4440);
  assert.equal(madeAgain.existing, true);
  assert.equal(madeAgain.owned, true);

  const mine = await shares.owned();
  assert.deepEqual(Object.keys(mine), ['4440']);

  // Unshare refuses a mapping Meridian did not make.
  await assert.rejects(() => shares.unshare(4420), (e) => e.statusCode === 409 && /did not make that mapping/.test(e.message));
  await assert.rejects(() => shares.unshare(5555), /not shared/);

  const gone = await shares.unshare(4440);
  assert.deepEqual([gone.removed, gone.httpsPort], [true, 10001]);
  assert.deepEqual(ts.calls[ts.calls.length - 2], ['serve', '--yes', '--https=10001', 'off']);
  assert.deepEqual(ts.conf, BASE, 'everything else exactly as it was');
});

test('unshare leaves a mapping alone once someone else has changed it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-share-'));
  const ts = fakeTailscale(BASE);
  const shares = createShares({ bin: 'tailscale', file: path.join(dir, 'shares.json'), runner: ts.runner });
  await shares.share(4460);
  ts.conf.Web[`${HOST}:14460`].Handlers['/extra'] = { Proxy: 'http://127.0.0.1:9999' };
  shares.invalidate();
  await assert.rejects(() => shares.unshare(4460), (e) => e.statusCode === 409 && /changed since/.test(e.message));
  assert.ok(ts.conf.Web[`${HOST}:14460`], 'still there');
  assert.ok(!ts.calls.some((a) => a[a.length - 1] === 'off'), 'off never ran');
  assert.deepEqual(await shares.owned(), {}, 'no longer claimed as ours');
});

test('ignore list: project + title when known, port otherwise, and un-ignore', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-ignore-'));
  const list = createIgnoreList(path.join(dir, 'ignore.json'));
  const live = [
    { port: 4416, project: 'Developer/kinetic', title: null },
    { port: 4426, project: 'Developer/films', title: 'Three films' },
    { port: 4427, project: 'Developer/films', title: 'Other page' },
    { port: 4599, project: null, title: 'Directory listing for /' },
  ];
  await assert.rejects(() => list.set({}, live), /port or project/);
  await assert.rejects(() => list.set({ port: 'x' }, live), /integer/);

  const a = await list.set({ port: 4426 }, live);
  assert.deepEqual([a.ignored, a.entry.match, a.entry.project, a.entry.title], [true, 'title', 'Developer/films', 'Three films']);
  await list.set({ port: 4599 }, live);
  let items = await list.read();
  // The same project on a new port is still hidden; a different page is not.
  const later = [{ port: 5000, project: 'Developer/films', title: 'Three films' }, ...live.slice(2, 3), { port: 4599, project: null, title: 'x' }, { port: 4600, project: null, title: 'y' }];
  list.annotate(later, items);
  assert.deepEqual(later.map((s) => [s.port, s.ignored]), [[5000, true], [4427, false], [4599, true], [4600, false]]);

  // Ignoring twice does not duplicate.
  await list.set({ port: 4426 }, live);
  assert.equal((await list.read()).length, 2);

  const b = await list.set({ port: 4426, project: 'Developer/films', ignored: false }, live);
  assert.deepEqual([b.ignored, b.removed], [false, 1]);
  const c = await list.set({ project: 'Developer/kinetic' }, live);
  assert.equal(c.entry.match, 'project');
  items = await list.read();
  list.annotate(live, items);
  assert.deepEqual(live.map((s) => s.ignored), [true, false, false, true]);
  // Un-ignore a server that is no longer running, by port and project.
  await list.set({ port: 4416, project: 'Developer/kinetic', ignored: false }, []);
  await list.set({ port: 4599, ignored: false }, []);
  assert.deepEqual(await list.read(), []);
});

// Force removes mappings Meridian did not make, root or sub-path, backing
// up the serve status before each one; without force it stays a 409.
test('unshare with force removes agent-made mappings after a backup', async () => {
  const conf = {
    TCP: { 443: { HTTPS: true }, 21443: { HTTPS: true }, 22443: { HTTPS: true } },
    Web: {
      [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4980' }, '/slides': { Proxy: 'http://127.0.0.1:8936' } } },
      [`${HOST}:21443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4430' } } },
      [`${HOST}:22443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4430' } } },
    },
  };
  const calls = [];
  const runner = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'status') return { ok: true, stdout: JSON.stringify(conf), stderr: '' };
    if (args[args.length - 1] === 'off') {
      const port = args.find((a) => a.startsWith('--https=')).slice(8);
      const setPath = args.find((a) => a.startsWith('--set-path='));
      const web = conf.Web[`${HOST}:${port}`];
      if (setPath) delete web.Handlers[setPath.slice(11)];
      else { delete conf.Web[`${HOST}:${port}`]; delete conf.TCP[port]; }
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'serve-'));
  const shares = createShares({ bin: 'tailscale', file: path.join(dir, 'shares.json'), runner });
  await assert.rejects(shares.unshare(4430), (e) => e.statusCode === 409, 'no force: left alone');
  const backups = [];
  const backup = async (doc, where) => { backups.push({ ports: Object.keys(doc.TCP).sort(), ...where }); return `/audit/${backups.length}.json`; };
  const r = await shares.unshare(4430, { force: true, backup });
  assert.equal(r.forced, true);
  assert.deepEqual(r.mappings.map((m) => m.httpsPort), [21443, 22443], 'both mappings to the port');
  assert.deepEqual(r.backups, ['/audit/1.json', '/audit/2.json']);
  assert.deepEqual(backups.map((b) => b.ports), [['21443', '22443', '443'], ['22443', '443']], 'each backup is taken just before its removal');
  assert.ok(calls.includes('serve --yes --https=21443 off'));
  const slides = await shares.unshare(8936, { force: true, backup });
  assert.deepEqual(slides.mappings, [{ httpsPort: 443, path: '/slides', url: `https://${HOST}/slides` }]);
  assert.ok(calls.includes('serve --yes --https=443 --set-path=/slides off'), 'a sub-path is removed on its own');
  assert.deepEqual(Object.keys(conf.Web[`${HOST}:443`].Handlers), ['/'], 'Meridian\'s root survives');
  await assert.rejects(shares.unshare(5555, { force: true, backup }), (e) => e.statusCode === 404);
  // A root handler sharing its port with other paths is not touched.
  conf.Web[`${HOST}:443`].Handlers['/x'] = { Proxy: 'http://127.0.0.1:7000' };
  await assert.rejects(shares.unshare(4980, { force: true, backup }), (e) => e.statusCode === 409);
  assert.ok(conf.Web[`${HOST}:443`].Handlers['/']);
});
