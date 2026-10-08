'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pings = require('../pings');

const at = (h, m = 0) => new Date(2026, 9, 4, h, m).getTime();

test('quiet hours run over midnight, or inside one day', () => {
  const night = { on: true, from: '23:00', to: '08:00' };
  assert.equal(pings.inQuiet(night, at(23, 30)), true);
  assert.equal(pings.inQuiet(night, at(3)), true);
  assert.equal(pings.inQuiet(night, at(8)), false);
  assert.equal(pings.inQuiet(night, at(12)), false);
  const lunch = { on: true, from: '13:00', to: '14:00' };
  assert.equal(pings.inQuiet(lunch, at(13, 30)), true);
  assert.equal(pings.inQuiet(lunch, at(14, 1)), false);
  assert.equal(pings.inQuiet({ ...night, on: false }, at(3)), false);
});

test('quietOf fills defaults and ignores nonsense times', () => {
  assert.deepEqual(pings.quietOf({}), { on: true, from: '23:00', to: '08:00' });
  assert.deepEqual(pings.quietOf({ quiet: { on: false, from: 'late', to: '07:30' } }), { on: false, from: '23:00', to: '07:30' });
});

test('decide: switched-off kinds, the older events list, twice in six hours, quiet hours', () => {
  const rules = { events: ['delegation'], muted: ['tell'], quiet: { on: true, from: '23:00', to: '08:00' } };
  assert.equal(pings.decide({ rules, event: 'fleet', now: at(12) }).verdict, 'skip');
  assert.equal(pings.decide({ rules, event: 'delegation', now: at(12) }).verdict, 'send');
  assert.equal(pings.decide({ rules, event: 'tell', now: at(12) }).verdict, 'skip');
  assert.equal(pings.decide({ rules, event: 'needs', now: at(12) }).verdict, 'send');
  const history = [{ ok: true, title: 'A', message: 'b', time: at(9) }];
  assert.deepEqual(pings.decide({ rules, event: 'needs', title: 'A', message: 'b', history, now: at(12) }), { verdict: 'skip', why: 'sent already' });
  assert.equal(pings.decide({ rules, event: 'needs', title: 'A', message: 'b', history, now: at(16) }).verdict, 'send');
  // A reminder Owner set fires even if the words repeat, and even at night.
  assert.equal(pings.decide({ rules, event: 'reminder', title: 'A', message: 'b', history, now: at(12) }).verdict, 'send');
  assert.equal(pings.decide({ rules, event: 'reminder', now: at(2) }).verdict, 'send');
  assert.equal(pings.decide({ rules, event: 'needs', now: at(2) }).verdict, 'hold');
  assert.equal(pings.decide({ rules, event: 'meeting', priority: 5, now: at(2) }).verdict, 'send');
});

test('held pings come back once quiet hours end, as one summary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const held = pings.createHeld(path.join(dir, 'held.json'));
  const rules = { quiet: { on: true, from: '23:00', to: '08:00' } };
  await held.add({ title: 'Agent finished', message: 'x', click: '/a' });
  await held.add({ title: 'Site down', message: 'y' });
  assert.deepEqual(await held.take(rules, at(3)), []);
  const out = await held.take(rules, at(8, 1));
  assert.equal(out.length, 2);
  assert.deepEqual(await held.read(), []);
  const s = pings.summary(out);
  assert.match(s.title, /2 things/);
  assert.match(s.message, /Agent finished/);
  assert.equal(s.click, '/a');
  assert.equal(pings.summary([]), null);
  assert.equal(pings.summary([out[0]]).title, 'Agent finished');
});
