'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createStore } = require('../art-ratings');

test('stores, reads, and clears artwork ratings', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-art-ratings-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ratings.json');
  const artwork = { i: 'art-1', id: 1, t: 'A painting', a: 'An artist', d: '1885', source: 'https://example.test/art' };
  const store = createStore(file, [artwork]);

  assert.deepEqual((await store.read()).ratings, {});
  const liked = await store.set('art-1', 'like');
  assert.equal(liked.rating, 'like');
  assert.equal(liked.title, 'A painting');
  assert.match(liked.image, /^https:\/\/www\.artic\.edu\/iiif\/2\/art-1\/full\/1600,/);
  assert.equal(liked.description, 'A textured oil painting by An artist, painted in 1885.');
  assert.match(liked.ratedAt, /^202\d-/);
  assert.equal((await store.read()).ratings['art-1'].rating, 'like');
  await store.set('art-1', 'dislike');
  assert.equal((await store.read()).ratings['art-1'].rating, 'dislike');
  await store.set('art-1', null);
  assert.deepEqual((await store.read()).ratings, {});
  await assert.rejects(() => store.set('unknown', 'like'), /unknown artwork/);
  await assert.rejects(() => store.set('art-1', 'maybe'), /bad rating/);
});

test('recovers from a missing or malformed ratings file', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-art-ratings-recovery-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ratings.json');
  const artwork = { i: 'art-2', id: 2, t: 'Another painting', a: 'Another artist', d: '1890' };
  const store = createStore(file, [artwork]);

  assert.deepEqual((await store.read()).ratings, {});
  await fsp.writeFile(file, '{not valid json');
  assert.deepEqual((await store.read()).ratings, {});
  await store.set('art-2', 'like');
  assert.equal((await store.read()).ratings['art-2'].rating, 'like');
});

test('a newly saved artwork goes to the front of the order', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-art-order-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ratings.json');
  const works = ['a', 'b', 'c'].map((i, n) => ({ i, id: n, t: i, a: 'Artist', d: '1880' }));
  const store = createStore(file, works);

  await store.set('a', 'like');
  await store.set('b', 'like');
  assert.deepEqual((await store.read()).order, ['b', 'a']);
  await store.reorder(['a', 'b']);
  await store.set('c', 'like');
  assert.deepEqual((await store.read()).order, ['c', 'a', 'b']);
  await store.set('a', null);
  assert.deepEqual((await store.read()).order, ['c', 'b']);
});
