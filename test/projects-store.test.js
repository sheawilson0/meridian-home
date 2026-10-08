'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStore } = require('../projects-store');

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-projects-'));
  const store = createStore(path.join(dir, 'projects.json'));
  assert.deepEqual((await store.read()).projects, []);
  const made = await store.create({ title: '  Meridian projects  ', note: 'Calm source of truth', brief: true });
  assert.equal(made.title, 'Meridian projects');
  assert.equal(made.status, 'inbox');
  assert.equal(made.priority, 'normal');
  const moved = await store.update(made.id, { status: 'active', priority: 'high' });
  assert.equal(moved.status, 'active');
  assert.equal(moved.note, made.note);
  assert.equal((await store.read()).projects.length, 1);
  await assert.rejects(() => store.create({ title: 'Bad', status: 'maybe' }), /bad status/);
  console.log('projects-store: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
