'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readBrainSummary } = require('../brain-summary');

test('worker graph summary keeps counts, realm order and the eight-realm limit', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brain-summary-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'graph.json');
  const nodes = Array.from({ length: 10 }, (_, i) => ({ realm: 'realm-' + i }));
  nodes.push({ realm: 'realm-5' }, { realm: 'realm-5' }, { realm: 'realm-9' });
  await fsp.writeFile(file, JSON.stringify({ nodes, links: [{}, {}] }));
  const summary = await readBrainSummary(file);
  assert.equal(summary.nodes, 13); assert.equal(summary.links, 2);
  assert.deepEqual(summary.realms, [
    { name: 'realm-5', count: 3 }, { name: 'realm-9', count: 2 },
    ...[0, 1, 2, 3, 4, 6].map(i => ({ name: 'realm-' + i, count: 1 })),
  ]);
  await fsp.writeFile(file, '{}');
  assert.deepEqual(await readBrainSummary(file), { nodes: 0, links: 0, realms: [] });
});

test('missing and malformed graphs reject without leaking a worker', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brain-summary-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'graph.json');
  await assert.rejects(readBrainSummary(file), /ENOENT/);
  await fsp.writeFile(file, '{ invalid');
  await assert.rejects(readBrainSummary(file), /JSON|property name/);
});
