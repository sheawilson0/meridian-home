'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStore } = require('../links-store');

async function store() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-links-'));
  const s = createStore(path.join(dir, 'links.json'));
  await s.setCategories(['ExampleApp', 'Tools', 'Personal']);
  await s.create({ url: 'https://a.example/', category: 'ExampleApp' });
  await s.create({ url: 'https://b.example/', category: 'Tools' });
  await s.create({ url: 'https://c.example/', category: 'Labs' });
  return s;
}

const cats = async (s) => (await s.read()).categories;
const linkCats = async (s) => (await s.read()).links.map((l) => [new URL(l.url).host, l.category]).sort();

test('rename, including a merge into an existing category', async () => {
  const s = await store();
  assert.deepEqual(await cats(s), ['ExampleApp', 'Tools', 'Personal', 'Labs']);
  const r = await s.renameCategory('Tools', 'Kit');
  assert.deepEqual([r.moved, r.merged], [1, false]);
  assert.deepEqual(await cats(s), ['ExampleApp', 'Kit', 'Personal', 'Labs'], 'keeps its place');
  const m = await s.renameCategory('Labs', 'ExampleApp');
  assert.deepEqual([m.moved, m.merged], [1, true]);
  assert.deepEqual(await cats(s), ['ExampleApp', 'Kit', 'Personal']);
  assert.deepEqual(await linkCats(s), [['a.example', 'ExampleApp'], ['b.example', 'Kit'], ['c.example', 'ExampleApp']]);
  await assert.rejects(() => s.renameCategory('Nope', 'X'), /no category called Nope/);
  await assert.rejects(() => s.renameCategory('', 'X'), /required/);
});

test('remove moves links to Other by default, or where told', async () => {
  const s = await store();
  const r = await s.removeCategory('Tools');
  assert.deepEqual([r.moved, r.moveTo], [1, 'Other']);
  assert.deepEqual(await cats(s), ['ExampleApp', 'Personal', 'Labs', 'Other']);
  await s.removeCategory('Labs', 'ExampleApp');
  assert.deepEqual(await linkCats(s), [['a.example', 'ExampleApp'], ['b.example', 'Other'], ['c.example', 'ExampleApp']]);
  const empty = await s.removeCategory('Personal');
  assert.equal(empty.moved, 0);
  assert.deepEqual(await cats(s), ['ExampleApp', 'Other'], 'no Other added twice, nothing moved');
  await assert.rejects(() => s.removeCategory('Other', 'Other'), /being removed/);
});

test('setCategories takes the full order and keeps used ones it left out', async () => {
  const s = await store();
  const out = await s.setCategories(['Personal', 'ExampleApp']);
  assert.deepEqual(out, ['Personal', 'ExampleApp', 'Tools', 'Labs']);
  await assert.rejects(() => s.setCategories([]), /at least one/);
});

test('concurrent category writes do not lose each other', async () => {
  const s = await store();
  await Promise.all([s.renameCategory('Tools', 'Kit'), s.removeCategory('Labs'), s.create({ url: 'https://d.example/', category: 'New' })]);
  assert.deepEqual(await cats(s), ['ExampleApp', 'Kit', 'Personal', 'Other', 'New']);
  assert.equal((await s.read()).links.length, 4);
});
