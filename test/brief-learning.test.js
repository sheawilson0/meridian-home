'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { summarise, createLearning, channelOf } = require('../brief-learning');

const NOW = Date.parse('2026-10-02T08:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const item = (id, from, over = {}) => ({ id, source: id.startsWith('slack') ? 'slack' : 'outlook', from, title: id, status: 'queued', receivedAt: daysAgo(1), queuedAt: daysAgo(1), projectId: `p-${id}`, ...over });

test('outcomes per sender and channel from intake, feedback, projects and delegations', () => {
  const intakeItems = [
    item('outlook:1', 'Avery Morgan'), // completed in the brief
    item('outlook:2', 'Avery Morgan'), // project done
    item('slack:D1:1', 'Avery Morgan', { respondedAt: daysAgo(0.5) }), // replied
    item('slack:D1:2', 'Avery  morgan', { status: 'delegated' }),
    item('outlook:3', 'Vercel', { queuedAt: daysAgo(9) }), // ignored
    item('outlook:4', 'Vercel', { queuedAt: daysAgo(8) }), // rejected in the brief
    item('outlook:5', 'Vercel', { status: 'rejected' }),
    item('outlook:6', 'Vercel', { queuedAt: daysAgo(12) }), // ignored
    item('outlook:7', 'Vercel', { queuedAt: daysAgo(20) }), // ignored
    item('slack:C9:1', 'Alex W', { status: 'snoozed' }),
    item('slack:C9:2', 'Alex W'), // open
  ];
  const feedback = { completed: ['project:p-outlook:1'], rejected: ['project:p-outlook:4'], skipped: {} };
  const projects = [{ id: 'p-outlook:2', status: 'done' }, { id: 'p-outlook:1', status: 'inbox' }];
  const doc = summarise({ intakeItems, feedback, projects, delegatedProjectIds: [], now: NOW });
  const s = Object.fromEntries(doc.senders.map((x) => [x.from, x]));
  const c = s['Avery Morgan'];
  assert.equal(c.surfaced, 4, 'names are matched case- and space-insensitively');
  assert.deepEqual([c.done, c.delegated, c.responded, c.rejected, c.ignored, c.acted, c.dismissed], [2, 1, 1, 0, 0, 4, 0]);
  assert.equal(c.weight, 'raise');
  assert.equal(c.lastRespondedAt, daysAgo(0.5));
  const v = s.Vercel;
  assert.deepEqual([v.surfaced, v.rejected, v.ignored, v.dismissed, v.acted], [5, 2, 3, 5, 0]);
  assert.equal(v.weight, 'skip');
  const a = s['Alex W'];
  assert.deepEqual([a.skipped, a.open, a.weight], [1, 1, 'neutral']);
  const ch = Object.fromEntries(doc.channels.map((x) => [x.key, x]));
  assert.equal(ch['outlook:mail'].surfaced, 7);
  assert.equal(ch['slack:D1'].acted, 2);
  assert.equal(ch['slack:C9'].surfaced, 2);
  assert.equal(doc.totals.surfaced, 11);
  assert.equal(doc.items['outlook:3'].ignored, true);
  assert.equal(channelOf({ source: 'slack', id: 'slack:D0B:123.4' }), 'slack:D0B');
});

test('a delegation run counts as delegated; history survives items leaving the intake', () => {
  const first = summarise({ intakeItems: [item('outlook:a', 'Jordan'), item('outlook:b', 'Jordan', { queuedAt: daysAgo(2) })], delegatedProjectIds: ['p-outlook:a'], now: NOW });
  assert.equal(first.items['outlook:a'].delegated, true);
  // Next week: both have rolled off the intake; b was never touched.
  const later = summarise({ intakeItems: [], previous: first, now: NOW + 7 * 86400000 });
  assert.equal(later.items['outlook:a'].delegated, true);
  assert.equal(later.items['outlook:b'].ignored, true, 'open turns into ignored once old enough');
  assert.equal(later.senders[0].surfaced, 2);
  // Lifecycle flags stick even if a later intake write loses them.
  const again = summarise({ intakeItems: [item('outlook:a', 'Jordan', { status: 'queued' })], previous: later, now: NOW + 8 * 86400000 });
  assert.equal(again.items['outlook:a'].delegated, true);
});

test('createLearning writes only when an outcome changes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'learning-'));
  const file = path.join(dir, 'brief-learning.json');
  let now = NOW;
  const l = createLearning(file, { now: () => now });
  const inputs = { intakeItems: [item('outlook:1', 'Robin Swan')], feedback: {}, projects: [], delegatedProjectIds: [] };
  assert.equal((await l.update(inputs)).written, true);
  now += 60000;
  assert.equal((await l.update(inputs)).written, false);
  assert.equal((await l.update({ ...inputs, feedback: { completed: ['project:p-outlook:1'] } })).written, true);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.senders[0].done, 1);
  assert.equal(saved.version, 1);
  // A fresh instance (restart) picks up from the file.
  assert.equal((await createLearning(file, { now: () => now }).update({ ...inputs, feedback: { completed: ['project:p-outlook:1'] } })).written, false);
});
