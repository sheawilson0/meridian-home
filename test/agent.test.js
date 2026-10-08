'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const { summarize, markdown } = require('../agent');

test('summarize keeps what matters and leaves the rest out', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const s = {
    location: { name: 'Belfast' },
    calendar: { events: [
      { ts: now - 864e5, end: now - 864e5 + 3600e3, title: 'Yesterday' },
      { ts: now + 864e5, end: now + 864e5 + 1800e3, title: 'Standup', location: 'Teams', joinUrl: 'https://t/x' },
    ] },
    todos: [{ title: 'Email Rowan', priority: 'now', done: false }, { title: 'Old', priority: 'next', done: true }],
    deadlines: [{ title: 'Pitch', due: '2026-10-14', done: false }],
    briefIntake: { items: [{ from: 'Avery', source: 'outlook', title: 'Fix link', request: 'Point it at DEMO', status: 'queued' }, { title: 'Done one', status: 'done' }] },
    fleet: { services: [{ name: 'Atlas', up: false, paused: false }, { name: 'Paused', up: false, paused: true }] },
    money: { secret: 1 },
  };
  const o = summarize(s, { now, drafts: [{ id: 'abc', kind: 'email', title: 'To boss', status: 'drafting' }, { id: 'z', status: 'sent' }] });
  assert.deepEqual(o.calendar.map((e) => e.title), ['Standup']);
  assert.match(o.calendar[0].when, /^Tomorrow 13:00$/);
  assert.deepEqual(o.todos.map((t) => t.title), ['Email Rowan']);
  assert.equal(o.waitingOnOwner.length, 1);
  assert.deepEqual(o.problems, ['Atlas is down']);
  assert.deepEqual(o.drafts.map((d) => d.id), ['abc']);
  assert.ok(!JSON.stringify(o).includes('secret'));
  const md = markdown(o);
  assert.match(md, /## To-dos\n\n- \[now\] Email Rowan/);
  assert.match(md, /To boss \(email, drafting, id abc\)/);
});

test('summarize copes with an empty state', () => {
  const o = summarize({});
  assert.deepEqual(o.todos, []);
  assert.match(markdown(o), /^# Meridian/);
});

test('overview adds only calendar freshness and distinguishes a retained copy', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const calendar = { lastAttempt: now, lastSuccess: now - 3 * 3600000, durationMs: 100, error: 'offline', stale: true };
  const overview = summarize({ sources: { calendar, privateCollector: { error: 'private' } } }, { now });
  assert.deepEqual(overview.sources, { calendar }); assert.equal(JSON.stringify(overview).includes('private'), false);
  assert.match(markdown(overview), /Calendar last refreshed 8 Oct.*10:00, retained copy\./);
  assert.match(markdown(summarize({ sources: { calendar: { ...calendar, lastSuccess: null } } }, { now })), /no successful refresh recorded/);
});
