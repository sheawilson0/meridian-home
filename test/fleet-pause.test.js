'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFleetPause, matchJob, pidLabels } = require('../fleet-pause');

const JOBS = [
  { label: 'com.example.session-launcher', plist: '/la/sl.plist', program: '/Users/example/.iris/server.js', args: ['/usr/bin/node', '/Users/example/.iris/server.js'], env: {} },
  { label: 'uk.example.threads-daemon', plist: '/la/td.plist', program: '/Users/example/LifeOS/threads-concept/daemon/server.js', args: ['node', '/Users/example/LifeOS/threads-concept/daemon/server.js'], env: {} },
  { label: 'com.owner.helio-playground', plist: '/la/hp.plist', program: 'x', args: ['npx', 'serve', '-l', '4410'], env: {} },
  { label: 'uk.example.portfolio-ar', plist: '/la/ar.plist', program: 'y', args: ['node', 'server.js'], env: { PORT: '4420' } },
  { label: 'uk.example.meridian', plist: '/la/m.plist', program: '/m/server.js', args: ['node', '/m/server.js'], env: {} },
];

test('matchJob: config label, listening PID, port in args or env, then name words', () => {
  assert.equal(matchJob({ name: 'Iris', url: 'http://127.0.0.1:4785/' }, JOBS).job.label, 'com.example.session-launcher');
  assert.equal(matchJob({ name: 'Iris', url: 'http://127.0.0.1:4785/' }, JOBS).by, 'name');
  assert.equal(matchJob({ name: 'Threads daemon', url: 'http://127.0.0.1:4960/api/health' }, JOBS).job.label, 'uk.example.threads-daemon');
  assert.equal(matchJob({ name: 'Whatever', url: 'http://127.0.0.1:4960/' }, JOBS, { pidLabel: 'uk.example.threads-daemon' }).by, 'pid');
  assert.equal(matchJob({ name: 'Playground', url: 'http://127.0.0.1:4410/' }, JOBS).job.label, 'com.owner.helio-playground');
  assert.equal(matchJob({ name: 'AR', url: 'http://localhost:4420/' }, JOBS).by, 'port');
  assert.equal(matchJob({ name: 'X', url: 'http://127.0.0.1:1/', label: 'uk.example.portfolio-ar' }, JOBS).by, 'config');
  assert.equal(matchJob({ name: 'Helios static', url: 'http://127.0.0.1:4322/' }, JOBS), null, '"helios" is not "helio"');
  assert.equal(matchJob({ name: 'The Room', url: 'http://127.0.0.1:4333/' }, JOBS), null);
  assert.equal(matchJob({ name: 'Meridian', url: 'http://127.0.0.1:4980/' }, JOBS), null, 'never Meridian');
  assert.equal(matchJob({ name: 'X', url: 'http://127.0.0.1:4980/' }, JOBS, { pidLabel: 'uk.example.meridian' }), null);
  assert.equal(matchJob({ name: 'Iris', url: 'https://iris.example.com/' }, JOBS), null, 'remote sites never match a job');
  assert.deepEqual([...pidLabels('PID\tStatus\tLabel\n2370\t0\tuk.example.threads-daemon\n-\t0\tidle.job\n').entries()], [[2370, 'uk.example.threads-daemon']]);
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-'));
  const agents = path.join(dir, 'LaunchAgents');
  await fsp.mkdir(agents);
  const plist = path.join(agents, 'uk.example.threads-daemon.plist');
  await fsp.writeFile(plist, '<plist>threads</plist>');
  const calls = [];
  const loaded = new Set(['uk.example.threads-daemon']);
  const runner = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'plutil') return { ok: true, code: 0, stderr: '', stdout: JSON.stringify({ Label: 'uk.example.threads-daemon', ProgramArguments: ['node', '/x/threads-concept/daemon/server.js'] }) };
    if (bin === 'lsof') return args.includes('-iTCP:4960') && loaded.has('uk.example.threads-daemon') ? { ok: true, code: 0, stderr: '', stdout: '2370\n' } : { ok: false, code: 1, stderr: '', stdout: '' };
    if (bin === 'launchctl') {
      const label = String(args[1] || '').split('/').pop();
      if (args[0] === 'bootout') { if (!loaded.delete(label)) return { ok: false, code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' }; }
      if (args[0] === 'bootstrap') loaded.add('uk.example.threads-daemon');
      if (args[0] === 'print') return loaded.has(label) ? { ok: true, code: 0, stdout: 'state = running', stderr: '' } : { ok: false, code: 113, stdout: '', stderr: 'Could not find service' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected' };
  };
  const fp = createFleetPause({ uid: 501, agentsDir: agents, auditRoot: path.join(dir, 'audit'), file: path.join(dir, 'fleet-paused.json'), selfPort: 4980, runner, now: () => Date.parse('2026-10-02T02:00:00Z'), platform: 'darwin' });
  return { dir, plist, calls, loaded, fp };
}

const SERVICES = [{ name: 'Threads daemon', url: 'http://127.0.0.1:4960/api/health' }, { name: 'The Room', url: 'http://127.0.0.1:4333/' }, { name: 'Meridian', url: 'http://127.0.0.1:4980/' }];
const SITES = [{ name: 'example.uk', url: 'https://example.uk' }];

test('pause backs up the plist, disables and boots out the job; resume brings it back', async () => {
  const { dir, plist, calls, loaded, fp } = await setup();
  const list = '2370\t0\tuk.example.threads-daemon\n';
  let info = await fp.annotate({ services: SERVICES, sites: SITES, launchctlList: list });
  assert.deepEqual(info.get('Threads daemon'), { kind: 'service', label: 'uk.example.threads-daemon', plist, pausable: true, paused: false, pauseMode: 'launchd', matchedBy: 'pid' });
  assert.deepEqual(info.get('The Room'), { kind: 'service', label: null, plist: null, pausable: true, paused: false, pauseMode: 'probe', matchedBy: null });
  assert.equal(info.get('Meridian').pausable, false);
  assert.equal(info.get('example.uk').kind, 'site');
  await assert.rejects(fp.pause(SERVICES[2], info.get('Meridian')), (e) => e.statusCode === 409);

  const r = await fp.pause(SERVICES[0], info.get('Threads daemon'));
  assert.equal(r.mode, 'launchd');
  assert.equal(r.backup, path.join(dir, 'audit', '2026-10-02-paused', 'uk.example.threads-daemon.plist'));
  assert.equal(await fsp.readFile(r.backup, 'utf8'), '<plist>threads</plist>');
  assert.deepEqual(calls.filter((c) => c[0] === 'launchctl').map((c) => c.slice(1).join(' ')), ['disable gui/501/uk.example.threads-daemon', 'bootout gui/501/uk.example.threads-daemon']);
  assert.equal(loaded.has('uk.example.threads-daemon'), false);
  info = await fp.annotate({ services: SERVICES, sites: SITES, launchctlList: '' });
  assert.equal(info.get('Threads daemon').paused, true);
  assert.equal(info.get('Threads daemon').label, 'uk.example.threads-daemon', 'the label is remembered once the job is gone');
  assert.equal((await fp.pause(SERVICES[0], info.get('Threads daemon'))).already, true);

  // The plist vanishing does not stop a resume: the backup goes back.
  await fsp.unlink(plist);
  calls.length = 0;
  const back = await fp.resume('Threads daemon');
  assert.deepEqual(back, { ok: true, name: 'Threads daemon', paused: false, started: 'uk.example.threads-daemon' });
  assert.equal(await fsp.readFile(plist, 'utf8'), '<plist>threads</plist>');
  assert.deepEqual(calls.filter((c) => c[0] === 'launchctl').map((c) => c.slice(1).join(' ')), ['enable gui/501/uk.example.threads-daemon', `bootstrap gui/501 ${plist}`]);
  assert.equal(loaded.has('uk.example.threads-daemon'), true);
  await assert.rejects(fp.resume('Threads daemon'), (e) => e.statusCode === 409);
});

test('a probe-only service or site pauses without touching launchd', async () => {
  const { calls, fp } = await setup();
  const info = await fp.annotate({ services: SERVICES, sites: SITES, launchctlList: '' });
  calls.length = 0;
  const r = await fp.pause(SERVICES[1], info.get('The Room'));
  assert.equal(r.mode, 'probe');
  const site = await fp.pause(SITES[0], info.get('example.uk'));
  assert.equal(site.kind, 'site');
  assert.deepEqual(calls.filter((c) => c[0] === 'launchctl'), []);
  assert.deepEqual(Object.keys(await fp.readPaused()).sort(), ['The Room', 'example.uk']);
  assert.equal((await fp.resume('The Room')).started, null);
});

test('concurrent pauses and resumes preserve every record', async () => {
  const { fp, dir } = await setup();
  const items = Array.from({ length: 12 }, (_, i) => ({ name: 'Site ' + i, url: 'https://example.com/' + i }));
  const info = await fp.annotate({ sites: items });
  await Promise.all(items.map((item) => fp.pause(item, info.get(item.name))));
  assert.equal(Object.keys(await fp.readPaused()).length, 12);
  await Promise.all(items.map((item) => fp.resume(item.name)));
  assert.deepEqual(await fp.readPaused(), {});
  const again = await Promise.all([fp.pause(items[0], info.get(items[0].name)), fp.pause(items[0], info.get(items[0].name))]);
  assert.equal(again[1].already, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the pause record is durable before launchctl runs, and failed storage leaves the job alone', async (t) => {
  const { fp, calls, dir } = await setup();
  const info = await fp.annotate({ services: SERVICES });
  calls.length = 0;
  const file = path.join(dir, 'fleet-paused.json');
  const rename = fsp.rename;
  let recorded = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    assert.equal(calls.filter((c) => c[0] === 'launchctl').length, recorded ? 2 : 0);
    await rename(from, to); recorded = true;
  });
  await fp.pause(SERVICES[0], info.get(SERVICES[0].name));
  assert.equal(recorded, true);
  t.mock.restoreAll();
  await fp.resume(SERVICES[0].name);
  await fsp.unlink(file); await fsp.mkdir(file);
  calls.length = 0;
  await assert.rejects(fp.pause(SERVICES[0], info.get(SERVICES[0].name)));
  assert.deepEqual(calls.filter((c) => c[0] === 'launchctl'), []);
  await fsp.rm(dir, { recursive: true, force: true });
});
