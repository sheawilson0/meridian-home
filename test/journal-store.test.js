'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseEntry } = require('../journal-store');

test('journal normalisation preserves identity and fields omitted from an edit', () => {
  const old = normaliseEntry({ title: 'First', date: '2026-10-08', track: 'uni', source: 'agent', tags: ['UX', 'ux', ' notes '], minutes: 40 });
  const next = normaliseEntry({ title: '  Revised  ' }, old);
  assert.equal(next.id, old.id); assert.equal(next.created, old.created);
  assert.equal(next.date, '2026-10-08'); assert.equal(next.track, 'uni'); assert.equal(next.source, 'agent');
  assert.equal(next.title, 'Revised'); assert.deepEqual(next.tags, ['ux', 'notes']); assert.equal(next.minutes, 40);
});
test('journal parsing rejects unknown tracks and sources, and clamps minutes and tags', () => {
  assert.throws(() => normaliseEntry({ title: '  ' }), /title required/);
  assert.throws(() => normaliseEntry({ title: 'x', track: 'other' }), /track must/);
  assert.throws(() => normaliseEntry({ title: 'x', source: 'other' }), /bad source/);
  assert.equal(normaliseEntry({ title: 'x', minutes: -5 }).minutes, 0);
  assert.equal(normaliseEntry({ title: 'x', minutes: 9999 }).minutes, 1440);
  assert.equal(normaliseEntry({ title: 'x', minutes: '' }).minutes, null);
  assert.deepEqual(normaliseEntry({ title: 'x', tags: ' Foo,foo, Bar, ' }).tags, ['foo', 'bar']);
  assert.equal(normaliseEntry({ title: 'x', tags: Array.from({ length: 20 }, (_, i) => 'tag' + i) }).tags.length, 12);
});
