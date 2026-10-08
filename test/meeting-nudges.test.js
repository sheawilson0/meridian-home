'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const mn = require('../meeting-nudges');

const T = Date.parse('2026-10-05T14:45:00Z'); // a meeting start
const MIN = 60000;
const ev = (over) => ({ ts: T, end: T + 15 * MIN, title: 'Weekly stats', allDay: false, cal: 'Outlook', id: `uid|${new Date(T).toISOString()}`, joinUrl: null, response: null, ...over });

test('mergeMeetings: intake join links land on the matching event; unmatched ones are kept', () => {
  const events = [ev(), ev({ id: 'g1', cal: 'Google', title: 'Gym', ts: T + 3 * 3600e3 })];
  const intake = {
    meetings: [
      { id: 'o1', title: '[internal] Weekly stats', start: new Date(T + 2 * MIN).toISOString(), end: null, joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
      { id: 'o2', title: 'Client call', start: '2026-10-05T16:00:00+01:00', joinUrl: 'https://teams.microsoft.com/meet/1' },
      { id: 'bad', title: '', start: 'not a date' },
    ],
  };
  const out = mn.mergeMeetings(events, intake, { now: T - 3600e3 });
  assert.equal(out.events[0].joinUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.equal(out.events[0].joinFrom, 'outlook');
  assert.equal(events[0].joinUrl, null, 'inputs are not mutated');
  assert.deepEqual(out.unmatched.map((m) => m.id), ['o2']);
  assert.equal(out.unmatched[0].start, '2026-10-05T15:00:00.000Z');
});

test('mergeMeetings: invites from intake and ICS needsAction, deduped by title and start', () => {
  const events = [
    ev(),
    ev({ id: 'g-inv', cal: 'Google', title: 'Coffee chat', ts: T + 86400e3, response: 'needsAction', organizer: 'Sam', joinUrl: 'https://meet.google.com/abc-defg-hij' }),
    ev({ id: 'g-old', cal: 'Google', title: 'Long gone', ts: T - 5 * 86400e3, response: 'needsAction' }),
  ];
  const intake = {
    invites: [
      { id: 'out-1', title: 'Weekly stats', start: new Date(T).toISOString(), end: new Date(T + 15 * MIN).toISOString(), organizer: 'Avery Morgan', joinUrl: 'https://teams.microsoft.com/meet/9', response: 'needsAction', url: 'https://outlook.office365.com/owa/?itemid=1' },
      { id: 'out-1-dup', title: 'weekly  stats', start: new Date(T).toISOString() },
      { id: 'out-2', title: 'Not in the feed', start: new Date(T + 2 * 86400e3).toISOString(), organizer: 'Robin Swan' },
      { id: 'too-far', title: 'Next month', start: new Date(T + 30 * 86400e3).toISOString() },
      { id: 'evil', title: 'Bad link', start: new Date(T + 3600e3).toISOString(), joinUrl: 'javascript:alert(1)' },
    ],
  };
  const out = mn.mergeMeetings(events, intake, { now: T - 3600e3 });
  assert.deepEqual(out.invites.map((i) => i.id), ['out-1', 'evil', 'g-inv', 'out-2']);
  const first = out.invites[0];
  assert.deepEqual(Object.keys(first).slice(0, 8), ['id', 'title', 'start', 'end', 'joinUrl', 'organizer', 'response', 'url']);
  assert.equal(first.response, 'needsAction');
  assert.equal(first.inCalendar, true);
  assert.equal(out.events[0].response, 'needsAction', 'the calendar event learns it is unanswered');
  assert.equal(out.events[0].joinUrl, 'https://teams.microsoft.com/meet/9');
  assert.equal(out.invites.find((i) => i.id === 'evil').joinUrl, null, 'only https links');
  assert.equal(out.invites.find((i) => i.id === 'g-inv').source, 'ics');
  assert.equal(out.invites.find((i) => i.id === 'out-2').inCalendar, false);
});

test('nudgeCandidates: join link or Outlook, timed, not declined, not skipped', () => {
  const cfg = mn.nudgeConfig({ skip: ['^example agency wip$'] });
  const c = mn.nudgeCandidates({
    events: [
      ev({ id: 'a', title: 'Example Agency WIP', ts: T - 6 * 3600e3 }),
      ev({ id: 'b' }),
      ev({ id: 'c', cal: 'Google', title: 'Gym', ts: T + 3600e3 }),
      ev({ id: 'd', cal: 'Google', title: 'Call with Sam', ts: T + 7200e3, joinUrl: 'https://meet.google.com/abc-defg-hij' }),
      ev({ id: 'e', title: 'Declined thing', ts: T + 9000e3, response: 'declined' }),
      ev({ id: 'f', title: 'Holiday', allDay: true }),
    ],
    unmatched: [{ id: 'u', title: 'Client call', start: new Date(T + 4 * 3600e3).toISOString(), joinUrl: 'https://teams.microsoft.com/meet/1' }],
    invites: [{ id: 'i-dup', title: 'Weekly stats', start: new Date(T).toISOString() }],
  }, cfg);
  assert.deepEqual(c.map((x) => x.id), ['b', 'd', 'u']);
  assert.deepEqual(cfg, { enabled: true, minutes: [10, 1], skip: ['^example agency wip$'] });
  assert.deepEqual(mn.nudgeConfig({ minutes: [1, 5, 'x', 999], enabled: false, skip: [] }), { enabled: false, minutes: [5, 1], skip: [] });
});

test('dueNudges: each offset owns its stretch; sent keys are skipped', () => {
  const c = [{ id: 'm', title: 'Weekly stats', start: T, joinUrl: 'https://teams.microsoft.com/meet/9' }];
  const at = (minsBefore, sent = {}) => mn.dueNudges(c, { now: T - minsBefore * MIN, minutes: [10, 1], sent });
  assert.deepEqual(at(11), []);
  const ten = at(10);
  assert.equal(ten.length, 1);
  assert.deepEqual(ten[0], { key: 'm|10', id: 'm', title: 'Weekly stats', start: new Date(T).toISOString(), minutes: 10, joinUrl: 'https://teams.microsoft.com/meet/9', body: 'in 10 min' });
  assert.equal(at(6)[0].body, 'in 6 min', 'late (after a restart) still goes, with the real time left');
  assert.deepEqual(at(6, { 'm|10': 'x' }), []);
  const one = at(1);
  assert.equal(one.length, 1);
  assert.equal(one[0].minutes, 1);
  assert.equal(one[0].body, 'starting now');
  assert.equal(at(-1.5).length, 1, 'still nudges just after the start');
  assert.deepEqual(at(-3), [], 'not once it has properly started');
});

test('createNudger: sends once per event and offset, across restarts', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nudges-'));
  const file = path.join(dir, 'nudges.json');
  let now = T - 10 * MIN;
  const pushed = []; const announced = [];
  const make = () => mn.createNudger({ file, now: () => now, send: async (n) => { pushed.push(n.key); return true; }, announce: (n) => announced.push(n.key) });
  const cfg = mn.nudgeConfig({ skip: ['^example agency wip$'] });
  const cands = [{ id: 'm', title: 'Weekly stats', start: T, joinUrl: null }];
  let n = make();
  assert.equal((await n.tick(cands, cfg)).length, 1);
  assert.equal((await n.tick(cands, cfg)).length, 0);
  n = make(); // a restart
  now = T - 9 * MIN;
  assert.equal((await n.tick(cands, cfg)).length, 0, 'the 10-minute nudge is on disk');
  now = T - 30000;
  const late = await n.tick(cands, cfg);
  assert.equal(late.length, 1);
  assert.equal(late[0].pushed, true);
  assert.deepEqual(pushed, ['m|10', 'm|1']);
  assert.deepEqual(announced, ['m|10', 'm|1']);
  assert.deepEqual(await make().tick(cands, { ...cfg, enabled: false }), []);
  const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(doc.sent).sort(), ['m|1', 'm|10']);
  // Old keys are pruned on the next write.
  now = T + 4 * 86400e3;
  await make().tick([{ id: 'z', title: 'Later', start: now + 10 * MIN }], cfg);
  assert.deepEqual(Object.keys(JSON.parse(await fsp.readFile(file, 'utf8')).sent), ['z|10']);
});

test('similarTitle', () => {
  assert.ok(mn.similarTitle('[internal] weekly catch up on example campaign digital stats ', 'Weekly catch up on Example Campaign digital stats'));
  assert.ok(mn.similarTitle('RE: Budget review', 'Budget review'));
  assert.ok(!mn.similarTitle('Gym', 'Gym work out with the team'), 'too short to contain-match');
  assert.ok(!mn.similarTitle('Client call', 'Team lunch'));
});

test('nudgeCandidates: classes never nudge, WIP is still skipped, Outlook still counts', () => {
  const cfg = mn.nudgeConfig({ skip: ['^example agency wip$'] });
  const events = [
    ev({ id: 'class', title: 'COURSE102 Research and Writing', cal: 'Classes', calendar: 'Classes', kind: 'class', joinUrl: null }),
    ev({ id: 'class-renamed', title: 'Studio', cal: 'Uni', calendar: 'Uni', kind: 'class', joinUrl: 'https://teams.microsoft.com/meet/1', ts: T + 3600e3 }),
    ev({ id: 'class-label', title: 'Seminar', cal: 'Classes', joinUrl: 'https://meet.google.com/abc-defg-hij', ts: T + 2 * 3600e3 }),
    ev({ id: 'wip', title: 'Example Agency WIP', ts: T + 3 * 3600e3 }),
    ev({ id: 'work', title: 'Weekly stats', calendar: 'Work', cal: 'Outlook', ts: T + 4 * 3600e3 }),
  ];
  assert.deepEqual(mn.nudgeCandidates({ events }, cfg).map((c) => c.id), ['work']);
});
