'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStash, parseQuery, colourName, readPage, normalHex } = require('../stash');

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stash-'));
  const clock = { now: Date.parse('2026-10-02T12:00:00Z') };
  const events = [];
  // No vision binary and no network: links stay as they are, which is what these tests want.
  const s = createStash({ dir, now: () => clock.now, onChange: (e) => events.push(e), log: () => {}, fetch: async () => null, quicklook: false });
  return { dir, clock, s, events };
}

test('loose phrases become removable filters', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const { filters, chips } = parseQuery('blue screenshots last week #moodboard site:dribbble.com "big type" posters', now);
  assert.deepEqual([...filters.colours], ['blue']);
  assert.deepEqual([...filters.kinds], ['screenshot']);
  assert.deepEqual([...filters.spaces], ['moodboard']);
  assert.deepEqual([...filters.sites], ['dribbble.com']);
  assert.deepEqual(filters.phrases, ['big type']);
  assert.deepEqual(filters.words, ['posters']);
  assert.equal(filters.range[2], 'Last week');
  assert.equal(chips.length, 6);
  assert.deepEqual(parseQuery('quotes from vitsoe').filters.words, ['vitsoe'], 'filler words drop out when there is something else');
  assert.deepEqual(parseQuery('from').filters.words, ['from']);
});

test('colour words', () => {
  assert.equal(colourName('#ff5247'), 'red');
  assert.equal(colourName('#f6c93a'), 'yellow');
  assert.equal(colourName('#6db4ff'), 'blue');
  assert.equal(colourName('#050505'), 'black');
  assert.equal(colourName('#f4f4f5'), 'white');
  assert.equal(colourName('#8e8e94'), 'grey');
  assert.equal(normalHex('F6C93A'), '#f6c93a');
  assert.equal(normalHex('#abc'), '#aabbcc');
  assert.equal(normalHex('hello'), null);
});

test('text becomes a note, a quote, a link or a colour', async () => {
  const { s } = await setup();
  const note = (await s.addText({ text: 'Ring the venue', source: 'tray', from: 'Main' })).item;
  assert.equal(note.kind, 'note');
  const quote = (await s.addText({ text: 'Less, but better.', source: 'clipboard', page: { url: 'https://www.vitsoe.com/gb/about/good-design', title: 'Good design' } })).item;
  assert.equal(quote.kind, 'quote');
  assert.equal(quote.domain, 'vitsoe.com');
  const hex = (await s.addText({ text: '#ff5247' })).item;
  assert.equal(hex.kind, 'colour');
  assert.equal(hex.title, 'red');
  const link = (await s.addText({ text: 'https://example.com/a' })).item;
  assert.equal(link.kind, 'link');
  const again = await s.addText({ text: 'https://example.com/a' });
  assert.equal(again.duplicate, true);
  assert.equal(again.item.id, link.id);
  await assert.rejects(s.addText({ text: '   ' }), /nothing to stash/);
  await s.settle();
  const r = await s.list({ q: 'quotes from vitsoe' });
  assert.deepEqual(r.items.map((i) => i.id), [quote.id]);
  assert.equal((await s.list({ q: 'red' })).items[0].id, hex.id);
  assert.equal((await s.list({ q: 'venue' })).items[0].id, note.id);
  assert.equal((await s.list({})).counts.all, 4);
});

test('files dedupe by content, delete keeps them for undo, spaces filter', async () => {
  const { s, dir, events } = await setup();
  const bytes = Buffer.from('%PDF-1.4 not really');
  const a = await s.addFile(bytes, { name: 'brief.pdf', type: 'application/pdf', source: 'drop', from: 'Main' });
  assert.equal(a.item.kind, 'file');
  assert.equal(a.item.name, 'brief.pdf');
  await fsp.access(path.join(dir, a.item.file));
  const b = await s.addFile(bytes, { name: 'copy.pdf' });
  assert.equal(b.duplicate, true);
  await s.patch(a.item.id, { spaces: ['Uni', '#Dissertation'], title: 'Pitch brief' });
  assert.equal((await s.list({ q: '#dissertation' })).items.length, 1);
  assert.deepEqual((await s.list({})).spaces.map((x) => x.name), ['Dissertation', 'Uni']);
  await s.remove(a.item.id);
  assert.equal((await s.list({})).total, 0);
  await s.restore(a.item.id);
  assert.equal((await s.list({})).total, 1);
  assert.ok(events.some((e) => e.action === 'delete') && events.some((e) => e.action === 'restore'));
  await s.settle();
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8'));
  assert.equal(saved.items.length, 1);
});

test('seen marker counts what arrived since', async () => {
  const { s, clock } = await setup();
  await s.markSeen(clock.now);
  clock.now += 1000;
  await s.addText({ text: 'one' });
  await s.addText({ text: 'two' });
  assert.equal(await s.freshCount(), 2);
  await s.markSeen(clock.now);
  assert.equal(await s.freshCount(), 0);
});

test('page meta: share image, title and icon', () => {
  const html = `<html><head><title>Fallback</title><meta property="og:title" content="Moof &amp; friends"><meta property="og:image" content="/img/share.png">
    <link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/apple.png"></head></html>`;
  const m = readPage(html, 'https://example.com/post/1');
  assert.equal(m.title, 'Moof & friends');
  assert.equal(m.image, 'https://example.com/img/share.png');
  assert.equal(m.icon, 'https://example.com/apple.png');
});

test('concurrent cold additions share one index and survive reopening', async (t) => {
  const { s, dir } = await setup();
  const rename = fsp.rename;
  let writes = 0;
  t.mock.method(fsp, 'rename', async (from, to) => { if (to === path.join(dir, 'items.json')) writes++; return rename(from, to); });
  const added = await Promise.all(Array.from({ length: 30 }, (_, i) => s.addText({ text: 'note ' + i })));
  assert.equal(new Set(added.map((r) => r.item.id)).size, 30);
  assert.equal((await s.list({})).total, 30);
  assert.equal(writes, 1, 'cold additions still coalesce into one write');
  const reopened = createStash({ dir, log: () => {} });
  assert.equal((await reopened.list({})).total, 30);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('failed writes reject mutations and retry the dirty index', async () => {
  const { s, dir } = await setup();
  await s.load();
  const index = path.join(dir, 'items.json');
  await fsp.mkdir(index);
  await assert.rejects(s.addText({ text: 'must survive' }));
  await fsp.rmdir(index);
  await s.settle();
  assert.equal(JSON.parse(await fsp.readFile(index, 'utf8')).items[0].text, 'must survive');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('corrupt indexes are moved aside and unreadable indexes block writes', async () => {
  for (const [name, contents] of [['items.json', '{ broken'], ['items.json', '{"items":{}}'], ['vectors.json', '{ broken'], ['vectors.json', '{"id":123}']]) {
    const { dir } = await setup();
    const index = path.join(dir, name);
    await fsp.writeFile(index, contents);
    const logs = [];
    const s = createStash({ dir, log: (m) => logs.push(m) });
    await s.addText({ text: 'new note' });
    const backup = (await fsp.readdir(dir)).find((n) => n.startsWith(name + '.corrupt-'));
    assert.equal(await fsp.readFile(path.join(dir, backup), 'utf8'), contents);
    assert.match(logs[0], /corrupt (index|vectors) moved/);
    assert.equal(JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8')).items.length, 1);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  const { dir, s } = await setup();
  await fsp.mkdir(path.join(dir, 'items.json'));
  await assert.rejects(s.addText({ text: 'blocked' }), { code: 'EISDIR' });
  assert.equal((await fsp.stat(path.join(dir, 'items.json'))).isDirectory(), true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a running stash purges expired trash on the next mutation', async () => {
  const { s, dir, clock } = await setup();
  const { item } = await s.addFile(Buffer.from('old file'), { name: 'old.pdf' });
  await s.settle();
  await s.remove(item.id);
  clock.now += 31 * 86400e3;
  await s.addText({ text: 'today' });
  await assert.rejects(s.get(item.id), { statusCode: 404 });
  await assert.rejects(fsp.access(path.join(dir, item.file)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8')).items.length, 1);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a mutation arriving during a write waits for a write containing it', async (t) => {
  const { s, dir } = await setup();
  const rename = fsp.rename;
  let release; let started;
  const gate = new Promise((r) => { release = r; });
  const firstWrite = new Promise((r) => { started = r; });
  let writes = 0;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === path.join(dir, 'items.json') && ++writes === 1) { started(); await gate; }
    return rename(from, to);
  });
  const first = s.addText({ text: 'first' });
  await firstWrite;
  let acknowledged = false;
  const second = s.addText({ text: 'second' }).then((r) => { acknowledged = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(acknowledged, false);
  release();
  await Promise.all([first, second]);
  assert.equal(writes, 2);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8')).items.map((it) => it.text), ['first', 'second']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a failed purge keeps files until its pending writes succeed', async (t) => {
  const { s, dir, clock } = await setup();
  const { item } = await s.addFile(Buffer.from('old file'), { name: 'old.pdf' });
  await s.settle();
  await s.remove(item.id);
  clock.now += 31 * 86400e3;
  const rename = fsp.rename;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === path.join(dir, 'items.json')) throw new Error('disk unavailable');
    return rename(from, to);
  });
  await assert.rejects(s.addText({ text: 'today' }), /disk unavailable/);
  await fsp.access(path.join(dir, item.file));
  assert.equal(JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8')).items.length, 1);
  t.mock.restoreAll();
  await s.settle();
  await assert.rejects(fsp.access(path.join(dir, item.file)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8')).items.map((it) => it.text), ['today']);
  await fsp.rm(dir, { recursive: true, force: true });
});
