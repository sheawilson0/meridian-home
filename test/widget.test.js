'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { widgetView } = require('../widget');

const NOW = new Date(2026, 9, 4, 16, 0).getTime();
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();

test('the widget gets the next meeting (not the daily routine), what needs Owner, to-dos, agents and a deadline', () => {
  const state = {
    nudges: { skip: ['^example agency wip$'] },
    calendar: { events: [
      { id: 'a', ts: at(5, 9, 15), end: at(5, 9, 30), title: 'Example Agency WIP', joinUrl: 'https://teams' },
      { id: 'b', ts: at(5, 15, 45), end: at(5, 16), title: 'DEMO stats catch-up', response: 'needsAction' },
      { id: 'c', ts: at(4, 10), end: at(4, 11), title: 'Over already' },
    ] },
    invites: [
      { id: 'i1', title: 'DEMO stats catch-up', start: '2026-10-05T14:45:00Z', end: '2026-10-05T15:00:00Z', calendarId: 'b' },
      { id: 'i2', title: 'DEMO stats catch-up', start: '2026-10-12T14:45:00Z', end: '2026-10-12T15:00:00Z' },
    ],
    todos: [{ title: 'Later thing', priority: 'later' }, { title: 'Urgent', priority: 'now' }, { title: 'Done', done: true }],
    ai: { sessions: [{ live: true, project: '/x/Meridian' }, { live: false }] },
    delegations: { runs: [{ status: 'running', title: 'Tidy room' }, { kind: 'feedback', status: 'done', title: 'Bigger button', started: NOW - 3600e3, finished: NOW - 60e3 }] },
    deadlines: [{ title: 'Pitch', due: '2026-10-14' }, { title: 'Seminar', due: '2026-10-06' }, { title: 'Old', due: '2026-10-01' }],
    money: { never: 'shown' },
  };
  const w = widgetView(state, { tells: [{ status: 'ready', actions: [{ state: 'planned', title: 'Drinks with Sam' }] }], drafts: [{ status: 'drafting', lastBy: 'Dot', title: 'Email Rowan', updated: new Date(NOW - 3600e3).toISOString() }], now: NOW });
  assert.equal(w.next.title, 'DEMO stats catch-up');
  assert.equal(w.next.notAccepted, true);
  assert.equal(w.next.today, false);
  assert.equal(w.needs.count, 4, 'one invite for the series, a plan, a draft, a live fix');
  assert.deepEqual(w.needs.first, { title: 'DEMO stats catch-up', why: 'Not answered' });
  assert.deepEqual(w.todos, { open: 2, top: ['Urgent', 'Later thing'] });
  assert.deepEqual(w.agents, { working: 2, first: 'Tidy room' });
  assert.deepEqual(w.deadline, { title: 'Seminar', due: '2026-10-06', days: 2 });
  assert.equal(JSON.stringify(w).includes('never'), false);
  assert.deepEqual(w.later.map((e) => e.title), ['Example Agency WIP']);
  assert.equal(w.needs.items.length, 3);
});

test('tidy drops tags like [internal] and capitalises', () => {
  const { tidy } = require('../widget');
  assert.equal(tidy('[internal] weekly catch up on DEMO'), 'Weekly catch up on DEMO');
  assert.equal(tidy('[EXT] [internal] RE: budget'), 'Budget');
  assert.equal(tidy('Gym'), 'Gym');
});

test('an empty state gives an empty widget, not an error', () => {
  const w = widgetView({}, { now: NOW });
  assert.equal(w.next, null);
  assert.equal(w.needs.count, 0);
  assert.equal(w.deadline, null);
});
