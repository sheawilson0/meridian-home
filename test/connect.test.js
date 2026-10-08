'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { buildSources, createConnect } = require('../connect');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const FULL = {
  claude: { count: 12, newest: NOW - 5 * 60000 },
  codex: { date: '2026-10-02', newest: NOW - 3600e3 },
  github: { user: 'someone', prs: [{}, {}], at: new Date(NOW - 120000).toISOString(), error: null },
  ghInstalled: true,
  tailnet: { host: 'this-mac.example.ts', ip: '100.64.0.1' },
  calendars: {
    feeds: [
      { id: 'c1', label: 'Google', color: '#5fd3a5', source: 'config', host: 'calendar.google.com…', ok: true, events: 3, at: NOW - 60000 },
      { id: 'c2', label: 'Outlook', color: '#6db4ff', source: 'config', host: 'outlook.office365.com…', ok: false, status: 401, error: 'the calendar answered 401', at: NOW },
    ],
    classes: { term: { from: '2026-09-21', to: '2026-12-11' }, items: [{ estimated: true }, { estimated: true }], color: '#b7a1ff' },
  },
  notify: { provider: 'ntfy', topic: true, enabled: true },
  lastPush: { time: NOW - 3600e3, ok: true },
  ledger: { date: '2026-10-01', schedule: '23:40', exitStatus: 0 },
  intake: { updatedAt: new Date(NOW - 3 * 3600e3).toISOString(), items: 7, sources: ['Outlook', 'Slack'] },
  inbox: true, chrome: true,
};

test('buildSources: what is found, what is broken, what is missing', () => {
  const list = buildSources(FULL, NOW);
  const by = Object.fromEntries(list.map((s) => [s.id, s]));
  for (const s of list) {
    assert.ok(['connected', 'missing', 'error'].includes(s.status), s.id);
    assert.ok(s.name && s.what, s.id);
    assert.ok([null, 'paste', 'agent'].includes(s.action), s.id);
    if (s.action === 'agent') assert.ok(s.prompt && s.prompt.length > 40, `${s.id} has a brief for the agent`);
  }
  assert.equal(by['claude-logs'].status, 'connected');
  assert.match(by['claude-logs'].detail, /12 projects · last active 5 min ago/);
  assert.equal(by.github.status, 'connected');
  assert.match(by.github.detail, /someone · 2 open PRs/);
  assert.equal(by.tailscale.status, 'connected');
  assert.equal(by['calendar:c1'].status, 'connected');
  assert.match(by['calendar:c1'].detail, /3 events this week · checked just now · set in config/);
  assert.equal(by['calendar:c2'].status, 'error');
  assert.equal(by['calendar:c2'].action, 'paste');
  assert.ok(!list.some((s) => s.id.startsWith('calendar-new:')), 'Google and Outlook are both there');
  assert.equal(by.classes.status, 'connected');
  assert.match(by.classes.detail, /2 classes a week · term ends 11 Dec · some times are guesses/);
  assert.equal(by.pushes.status, 'connected');
  assert.equal(by.ledger.status, 'connected');
  assert.equal(by['brief-intake'].status, 'connected');
  assert.ok(!JSON.stringify(list).includes('topic'), 'never mentions the ntfy topic value');
});

test('buildSources: a bare Mac gets paste boxes and agent buttons', () => {
  const list = buildSources({ calendars: { feeds: [], classes: { term: { from: '2026-09-21', to: '2026-12-11' }, items: [] } } }, NOW);
  const by = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(by['claude-logs'].status, 'missing');
  assert.equal(by['claude-logs'].action, 'agent');
  assert.equal(by.github.action, 'agent');
  assert.equal(by['calendar-new:outlook'].action, 'paste');
  assert.match(by['calendar-new:outlook'].help, /Publish a calendar/);
  assert.match(by['calendar-new:google'].help, /Secret address in iCal format/);
  assert.equal(by.classes.status, 'missing');
  assert.equal(by.pushes.status, 'missing');
});

test('buildSources: stale things are errors with an agent to look', () => {
  const list = buildSources({ ...FULL, ledger: { date: '2026-09-25', schedule: '23:40', exitStatus: 1 }, intake: { updatedAt: '2026-09-28T08:00:00Z', items: 0, sources: [] }, lastPush: { time: NOW - 600000, ok: false, status: 0 } }, NOW);
  const by = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(by.ledger.status, 'error');
  assert.equal(by.ledger.action, 'agent');
  assert.equal(by['brief-intake'].status, 'error');
  assert.equal(by.pushes.status, 'error');
});

test('createConnect: reads the log folders, caches for a minute, survives failing checks', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-connect-'));
  await fsp.mkdir(path.join(home, '.claude', 'projects', 'a'), { recursive: true });
  await fsp.mkdir(path.join(home, '.codex', 'sessions', '2026', '10', '02'), { recursive: true });
  await fsp.writeFile(path.join(home, '.codex', 'sessions', '2026', '10', '02', 'x.jsonl'), '{}');
  let calls = 0;
  const c = createConnect({ home, github: () => { calls++; throw new Error('gh broke'); }, calendars: async () => ({ feeds: [], classes: null }) });
  const a = await c.get();
  const by = Object.fromEntries(a.sources.map((s) => [s.id, s]));
  assert.equal(by['claude-logs'].status, 'connected');
  assert.equal(by['codex-logs'].status, 'connected');
  assert.equal(by.github.status, 'missing', 'no gh binary given');
  await c.get();
  assert.equal(calls, 1, 'cached');
  c.bust();
  await c.get();
  assert.equal(calls, 2);
});
