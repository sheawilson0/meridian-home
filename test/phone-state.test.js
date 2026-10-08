'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { phoneState } = require('../phone-state');

test('phone view keeps complete actionable arrays, IDs and renderer fields without private payloads', () => {
  const events = Array.from({ length: 150 }, (_, i) => ({ id: 'event' + i, ts: i }));
  const todos = Array.from({ length: 200 }, (_, i) => ({ id: 'todo' + i, title: 'Task ' + i }));
  const deadlines = Array.from({ length: 80 }, (_, i) => ({ id: 'deadline' + i, due: '2026-10-10' }));
  const source = {
    at: 123, location: 'Fixture', calendar: { events, configured: true }, todos, deadlines, invites: [{ id: 'invite' }],
    projects: { projects: [{ id: 'brief', title: 'Brief', brief: 'Do this', status: 'active', source: 'outlook', sourceFrom: 'Fixture', sourceUrl: '/fixture', sourceReceivedAt: 10, updated: 11, priority: 'high', notes: 'long unused notes' }, { id: 'other', title: 'No brief' }] },
    briefFeedback: { completed: ['brief'], rejected: [], skipped: {}, history: 'unused' },
    briefIntake: { items: [{ projectId: 'brief', source: 'outlook', from: 'Fixture', url: '/fixture', receivedAt: 10, request: 'long unused request' }] },
    ai: { sessions: [{ live: true, project: 'fixture', tool: 'codex', did: 'Work', prompt: 'Start', started: 10, last: 11, transcript: 'unused' }] },
    delegations: { runs: [{ id: 'run', status: 'done', kind: 'fix', model: 'fixture', title: 'Fix', started: 10, finished: 11, undoneAt: null, archivedAt: null, undoable: true, report: 'long unused report' }] },
    ledger: { now: 'Current work', entries: ['unused'] }, journalToday: { count: 2 },
    github: { reviews: [{ url: '/pr', updatedAt: 11, title: 'Review', repo: 'fixture', number: 1, body: 'unused' }], repos: ['unused'] },
    notifyHistory: [{ ok: true, event: 'delegation', time: 11, title: 'Finished', message: 'Fixture', topic: 'unused' }],
    notify: { enabled: true }, tailnet: { host: 'fixture.invalid' }, nudges: { enabled: true },
    money: { balance: 'must not be sent' }, unrelated: 'must not be sent',
  };
  const saved = JSON.stringify(source), view = phoneState(source);
  assert.equal(view.at, source.at);
  assert.deepEqual(view.calendar.events, events);
  assert.deepEqual(view.todos, todos); assert.deepEqual(view.deadlines, deadlines); assert.deepEqual(view.invites, source.invites);
  assert.equal(view.projects.projects.length, 1);
  assert.equal(view.projects.projects[0].id, 'brief'); assert.equal(view.projects.projects[0].sourceReceivedAt, 10);
  assert.equal(view.projects.projects[0].notes, undefined);
  assert.equal(view.briefIntake.items[0].projectId, 'brief'); assert.equal(view.briefIntake.items[0].request, undefined);
  assert.equal(view.ai.sessions[0].prompt, 'Start'); assert.equal(view.ai.sessions[0].transcript, undefined);
  assert.equal(view.delegations.runs[0].undoable, true); assert.equal(view.delegations.runs[0].report, undefined);
  assert.deepEqual(view.ledger, { now: 'Current work' }); assert.deepEqual(view.journalToday, source.journalToday);
  assert.equal(view.github.reviews[0].number, 1); assert.equal(view.github.reviews[0].body, undefined);
  assert.equal(view.notifyHistory[0].message, 'Fixture'); assert.equal(view.notifyHistory[0].topic, undefined);
  assert.equal(view.money, undefined); assert.equal(view.unrelated, undefined);
  assert.equal(JSON.stringify(source), saved);
});

test('phone view handles missing saved sections without inventing actionable records', () => {
  const view = phoneState({ at: 1 });
  assert.deepEqual(view.calendar.events, []); assert.deepEqual(view.projects.projects, []);
  assert.deepEqual(view.briefIntake.items, []); assert.deepEqual(view.ai.sessions, []);
  assert.deepEqual(view.delegations.runs, []); assert.deepEqual(view.github.reviews, []);
  assert.deepEqual(view.notifyHistory, []); assert.equal(view.todos, undefined);
});
