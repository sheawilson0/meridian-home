'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createRecordings } = require('../tester/recordings');

async function setup(opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tester-rec-'));
  return { dir, rec: createRecordings({ dir, ...opts }) };
}

const T0 = 1_800_000_000_000;
const ev = (ms, type = 3, data = { source: 1, positions: [] }) => ({ type, data, timestamp: T0 + ms });
const custom = (ms, tag, payload) => ev(ms, 5, { tag, payload });
const click = (ms, x, y, extra = {}) => custom(ms, 'click', { x, y, label: 'Thing', tag: 'button', role: '', interactive: true, hash: '#home', path: 'button.thing', ...extra });
const mutation = (ms) => ev(ms, 3, { source: 0, texts: [], attributes: [{ id: 9, attributes: { class: 'on' } }], removes: [], adds: [] });
const task = (ms, n, state) => custom(ms, 'task', { n, title: 'Task ' + n, state });

test('append refuses bad input with a 400', async () => {
  const { rec } = await setup();
  const ok = { session: 'abcd1234-x', invite: 'abcd1234', seq: 0, events: [ev(0)] };
  for (const bad of [
    null, [], { ...ok, session: 'short' }, { ...ok, session: 'Has-Capitals1' }, { ...ok, session: 'a/../../etc/passwd' },
    { ...ok, invite: 'abc' }, { ...ok, invite: 'has-dash' }, { ...ok, seq: -1 }, { ...ok, seq: 1.5 }, { ...ok, seq: 100001 }, { ...ok, seq: '0' },
    { ...ok, events: 'nope' }, { ...ok, events: Array.from({ length: 5001 }, () => ev(0)) },
    { ...ok, events: [{ type: 3 }] }, { ...ok, events: [{ type: '3', timestamp: T0 }] }, { ...ok, events: [null] }, { ...ok, events: [[1, 2]] },
  ]) {
    await assert.rejects(rec.append(bad), (e) => e.statusCode === 400, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(await rec.list(), [], 'nothing written');
  assert.equal((await rec.append(ok)).ok, true);
});

test('events come back in time order, a resent batch once, a torn line skipped', async () => {
  const { dir, rec } = await setup();
  const s = 'inv1-session-01';
  await rec.append({ session: s, invite: 'inv1', seq: 1, events: [ev(300), ev(500)] });
  await rec.append({ session: s, invite: 'inv1', seq: 0, events: [ev(0, 4, { href: 'https://t.example/#home', width: 1280, height: 800 }), ev(10, 2, { node: {} }), ev(400)],
    meta: { ua: 'Test', w: 1280, h: 800, href: '/#home', started: T0, extra: 'dropped' } });
  const again = await rec.append({ session: s, invite: 'inv1', seq: 1, events: [ev(300), ev(500)] });
  assert.equal(again.duplicate, true);
  // A resend the meta file missed, and half a line from a crash.
  const file = path.join(dir, s + '.jsonl');
  await fsp.appendFile(file, JSON.stringify({ seq: 1, at: 0, events: [ev(300), ev(500)] }) + '\n{"seq":2,"ev');
  const all = await rec.events(s);
  assert.deepEqual(all.map((e) => e.timestamp - T0), [0, 10, 300, 400, 500]);
  // A reload restarts seq with different events: kept.
  await rec.append({ session: s, invite: 'inv1', seq: 0, events: [ev(900)] });
  const [info] = await rec.list();
  assert.equal(info.session, s);
  assert.equal(info.invite, 'inv1');
  assert.equal(info.count, 5 + 1);
  assert.equal(info.started, T0);
  assert.equal(info.last, T0 + 900);
  assert.deepEqual(info.meta, { ua: 'Test', w: 1280, h: 800, href: '/#home', started: T0 });
  assert.equal(info.recent, undefined, 'internal keys stay inside');
  assert.ok(info.bytes > 0);
  assert.equal((await rec.events(s)).length, 6);
});

test('a session belongs to one invite, and unknown sessions are 404', async () => {
  const { rec } = await setup();
  await rec.append({ session: 'aaaa-1111', invite: 'aaaa', seq: 0, events: [ev(0)] });
  await assert.rejects(rec.append({ session: 'aaaa-1111', invite: 'bbbb', seq: 1, events: [ev(1)] }), (e) => e.statusCode === 403);
  await assert.rejects(rec.events('nope-nope-1'), (e) => e.statusCode === 404);
  await assert.rejects(rec.summary('../../etc'), (e) => e.statusCode === 400);
});

test('writes to one session go in order even when sent together', async () => {
  const { rec } = await setup();
  const s = 'para-llel-01';
  await Promise.all(Array.from({ length: 30 }, (_, i) => rec.append({ session: s, invite: 'para', seq: i, events: [ev(i * 10), ev(i * 10 + 5)] })));
  const [info] = await rec.list();
  assert.equal(info.count, 60);
  assert.equal((await rec.events(s)).length, 60);
});

test('list is newest first and filters by invite', async () => {
  const { rec } = await setup();
  await rec.append({ session: 'aaaa-old-1', invite: 'aaaa', seq: 0, events: [ev(0)] });
  await rec.append({ session: 'aaaa-new-1', invite: 'aaaa', seq: 0, events: [ev(60000)] });
  await rec.append({ session: 'bbbb-mid-1', invite: 'bbbb', seq: 0, events: [ev(30000)] });
  assert.deepEqual((await rec.list()).map((x) => x.session), ['aaaa-new-1', 'bbbb-mid-1', 'aaaa-old-1']);
  assert.deepEqual((await rec.list({ invite: 'aaaa' })).map((x) => x.session), ['aaaa-new-1', 'aaaa-old-1']);
});

test('summary: pages, rage, dead, tasks and marks', async () => {
  const { rec } = await setup();
  const s = 'summ-ary-01';
  const events = [
    ev(0, 4, { href: 'https://t.example/command#home', width: 1440, height: 900 }),
    ev(5, 2, { node: {}, initialOffset: { left: 0, top: 0 } }),
    task(1000, 1, 'start'),
    // Answered by a mutation 300 ms later: fine.
    click(2000, 100, 100), mutation(2300),
    // Three quick clicks on one spot (two answered): all rage.
    click(3000, 200, 200), mutation(3050), click(3300, 210, 205), click(3600, 205, 195),
    // Fourth click 1.2 s after the first of the run, elsewhere: not rage.
    click(4200, 600, 600, { label: 'Nothing happens' }),
    // Not clickable at all: dead even though the page changed.
    click(6000, 50, 50, { interactive: false, tag: 'div' }), mutation(6100),
    // Clicking into a field: focus only, not dead.
    click(8000, 300, 300, { tag: 'input' }),
    // Followed by a route change: fine.
    click(9000, 400, 20, { label: 'Shelf' }), custom(9100, 'nav', { hash: '#shelf' }),
    custom(9200, 'nav', { hash: '#shelf' }),
    // Change after more than a second: dead.
    click(11000, 500, 500), mutation(12200),
    task(13000, 1, 'done'),
    task(14000, 2, 'start'),
    task(20000, 3, 'start'), // moved on from 2
    custom(21000, 'nav', { hash: '#home' }),
    task(25000, 3, 'stuck'),
    task(26000, 5, 'skip'), // never started
    task(27000, 4, 'start'),
    ev(30000),
  ];
  await rec.append({ session: s, invite: 'summ', seq: 0, events: events.slice(0, 12) });
  await rec.append({ session: s, invite: 'summ', seq: 1, events: events.slice(12) });
  const sum = await rec.summary(s);
  assert.equal(sum.session, s);
  assert.equal(sum.invite, 'summ');
  assert.equal(sum.started, T0);
  assert.equal(sum.ms, 30000);
  assert.deepEqual(sum.viewport, { w: 1440, h: 900 });
  assert.deepEqual(sum.pages, [{ t: 0, hash: '#home' }, { t: 9100, hash: '#shelf' }, { t: 21000, hash: '#home' }]);

  const byT = Object.fromEntries(sum.clicks.map((c) => [c.t, c]));
  assert.equal(sum.clicks.length, 9);
  assert.deepEqual(sum.clicks.filter((c) => c.rage).map((c) => c.t), [3000, 3300, 3600]);
  assert.deepEqual(sum.clicks.filter((c) => c.dead).map((c) => c.t), [3300, 3600, 4200, 6000, 11000]);
  assert.equal(byT[2000].dead, false);
  assert.equal(byT[8000].dead, false, 'focusing a field');
  assert.equal(byT[9000].dead, false, 'route change');
  assert.equal(byT[4200].label, 'Nothing happens');
  assert.deepEqual(sum.counts, { clicks: 9, rage: 3, dead: 5 });

  assert.deepEqual(sum.tasks, [
    { n: 1, title: 'Task 1', start: 1000, end: 13000, ms: 12000, outcome: 'done' },
    { n: 2, title: 'Task 2', start: 14000, end: 20000, ms: 6000, outcome: 'moved on' },
    { n: 3, title: 'Task 3', start: 20000, end: 25000, ms: 5000, outcome: 'stuck' },
    { n: 5, title: 'Task 5', start: 26000, end: 26000, ms: 0, outcome: 'skip' },
    { n: 4, title: 'Task 4', start: 27000, end: null, ms: 3000, outcome: 'unfinished' },
  ]);
  assert.deepEqual(sum.marks.map((m) => m.name), ['task', 'nav', 'nav', 'task', 'task', 'task', 'nav', 'task', 'task', 'task']);
  assert.deepEqual(sum.marks[0], { t: 1000, name: 'task', data: { n: 1, title: 'Task 1', state: 'start' } });
});

test('summary of a session with no events yet', async () => {
  const { rec } = await setup();
  await rec.append({ session: 'empt-y-001', invite: 'empt', seq: 0, events: [], meta: { w: 800, h: 600, href: '/command#home' } });
  const sum = await rec.summary('empt-y-001');
  assert.deepEqual(sum.viewport, { w: 800, h: 600 });
  assert.deepEqual(sum.pages, [{ t: 0, hash: '#home' }]);
  assert.deepEqual(sum.counts, { clicks: 0, rage: 0, dead: 0 });
});

test('removeInvite deletes that invite\'s sessions only', async () => {
  const { dir, rec } = await setup();
  await rec.append({ session: 'gone-1-aaaa', invite: 'gone', seq: 0, events: [ev(0)] });
  await rec.append({ session: 'gone-2-aaaa', invite: 'gone', seq: 0, events: [ev(1)] });
  await rec.append({ session: 'kept-1-aaaa', invite: 'kept', seq: 0, events: [ev(2)] });
  assert.equal(await rec.removeInvite('gone'), 2);
  assert.equal(await rec.removeInvite('gone'), 0);
  assert.deepEqual((await rec.list()).map((x) => x.session), ['kept-1-aaaa']);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['kept-1-aaaa.jsonl', 'kept-1-aaaa.meta.json']);
  await assert.rejects(rec.removeInvite('../x'), (e) => e.statusCode === 400);
});

test('a full session is refused with a 413', async () => {
  const { rec } = await setup({ maxBytes: 3000 }); // one batch is about 2.3 KB
  const big = Array.from({ length: 10 }, (_, i) => ev(i, 3, { source: 0, texts: [{ id: i, value: 'x'.repeat(100) }], attributes: [], removes: [], adds: [] }));
  await rec.append({ session: 'full-full-1', invite: 'full', seq: 0, events: big });
  await assert.rejects(rec.append({ session: 'full-full-1', invite: 'full', seq: 1, events: big }), (e) => e.statusCode === 413);
  const [info] = await rec.list();
  assert.equal(info.count, 10, 'the refused batch was not written');
  assert.ok(info.bytes <= 3000);
});
