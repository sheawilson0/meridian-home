'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const cs = require('../calendars-store');
const ics = require('../calendar-ics');

const SECRET = 'private-token-abc123';
const GOOGLE = `https://calendar.google.com/calendar/ical/someone%40example.com/${SECRET}/basic.ics`;
const OUTLOOK = `https://outlook.office365.com/owa/calendar/x/${SECRET}/calendar.ics`;
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function feed(title, startMs) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${title}`, `DTSTART:${stamp(new Date(startMs))}`, `DTEND:${stamp(new Date(startMs + 3600e3))}`, `SUMMARY:${title}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

async function tmpFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-cal-'));
  return path.join(dir, 'calendars.json');
}

test('classes expand weekly inside the term, in London time, skipping listed dates', () => {
  const classes = cs.normaliseClasses({
    term: { from: '2026-10-19', to: '2026-11-06' },
    skip: ['2026-10-27'],
    items: [{ title: 'Studio', day: 'Tuesday', start: '10:00', end: '16:00', where: 'Room 1', who: 'A Tutor', estimated: true }],
  });
  const ev = cs.expandClasses(classes, { from: Date.parse('2026-10-01'), to: Date.parse('2026-12-31') });
  assert.deepEqual(ev.map((e) => new Date(e.ts).toISOString()), ['2026-10-20T09:00:00.000Z', '2026-11-03T10:00:00.000Z'], 'BST then GMT, and 27 Oct skipped');
  const e = ev[0];
  assert.equal(e.calendar, 'Classes');
  assert.equal(e.cal, 'Classes');
  assert.equal(e.kind, 'class');
  assert.equal(e.color, cs.COLORS.Classes);
  assert.equal(e.end - e.ts, 6 * 3600e3);
  assert.equal(e.estimated, true);
  assert.equal(e.organizer, 'A Tutor');
  assert.equal(e.location, 'Room 1');
  assert.match(e.id, /^class-[a-z0-9-]+\|2026-10-20T09:00:00.000Z$/);
  // Window clipping: only what overlaps [from, to].
  assert.equal(cs.expandClasses(classes, { from: Date.parse('2026-11-01'), to: Date.parse('2026-11-04') }).length, 1);
  assert.equal(cs.expandClasses(classes, { from: Date.parse('2027-01-01'), to: Date.parse('2027-02-01') }).length, 0, 'nothing after the term');
});

test('new installs have an empty timetable', () => {
  assert.deepEqual(cs.DEFAULT_CLASSES.items, []);
  assert.deepEqual(cs.expandClasses(cs.DEFAULT_CLASSES, { from: 0, to: Date.now() }), []);
});

test('normaliseClasses refuses what would break the timetable', () => {
  const base = { term: { from: '2026-09-21', to: '2026-12-11' } };
  assert.throws(() => cs.normaliseClasses({ ...base, items: [{ title: 'X', day: 'tue', start: '14:00', end: '13:00' }] }), /ends before it starts/);
  assert.throws(() => cs.normaliseClasses({ ...base, items: [{ title: 'X', day: 'someday', start: '10:00', end: '11:00' }] }), /weekday/);
  assert.throws(() => cs.normaliseClasses({ ...base, items: [{ title: '', day: 'tue', start: '10:00', end: '11:00' }] }), /needs a name/);
  assert.throws(() => cs.normaliseClasses({ term: { from: '2026-12-11', to: '2026-09-21' }, items: [] }), /ends before it starts/);
  assert.throws(() => cs.normaliseClasses({ ...base, items: [{ title: 'X', day: 'tue', start: '25:00', end: '26:00' }] }), /time like/);
  const ok = cs.normaliseClasses({ ...base, items: [{ title: 'X', day: 2, start: '9:05', end: '10:00' }] });
  assert.equal(ok.items[0].day, 'tue');
  assert.equal(ok.items[0].start, '09:05');
  assert.equal(ok.items[0].estimated, false);
});

test('feed links: https or webcal only; labels guessed from the host; masked as host + …', () => {
  assert.equal(cs.normaliseUrl('webcal://p01-caldav.icloud.com/x.ics'), 'https://p01-caldav.icloud.com/x.ics');
  assert.throws(() => cs.normaliseUrl('http://example.com/x.ics'), /https/);
  assert.throws(() => cs.normaliseUrl('not a link'), /not a link/);
  assert.equal(cs.guessLabel(GOOGLE), 'Google');
  assert.equal(cs.guessLabel(OUTLOOK), 'Outlook');
  assert.equal(cs.maskUrl(OUTLOOK), 'outlook.office365.com…');
});

test('store: config feeds read-only, added feeds validated, nothing secret in the list', async () => {
  const file = await tmpFile();
  const now = Date.parse('2026-10-05T08:00:00Z');
  const bodies = new Map([
    [GOOGLE, { status: 200, body: feed('Gym', now + 4 * 3600e3) }],
    [OUTLOOK, { status: 200, body: feed('Weekly stats', now + 2 * 3600e3) }],
    ['https://cal.example.com/extra.ics', { status: 200, body: feed('Extra thing', now + 5 * 3600e3) }],
    ['https://cal.example.com/page.html', { status: 200, body: '<html>a web page</html>' }],
    ['https://cal.example.com/gone.ics', { status: 404, body: '' }],
  ]);
  const fetcher = async (url) => bodies.get(url) || { status: 0, body: '', error: 'no answer' };
  const store = cs.createCalendars({ file, configFeeds: () => [{ url: GOOGLE, label: 'Google' }, { url: OUTLOOK, label: 'Outlook' }], fetcher, now: () => now });
  const parse = (text, label) => ics.parseIcsFeed(text, label, { now, windowDays: 7 });

  const first = await store.list();
  assert.deepEqual(first.feeds.map((f) => [f.label, f.source, f.host, f.color]), [['Google', 'config', 'calendar.google.com…', '#5fd3a5'], ['Outlook', 'config', 'outlook.office365.com…', '#6db4ff']]);
  assert.equal(first.classes.items.length, 0, 'classes start empty');
  await store.setClasses({ term: { from: '2026-10-01', to: '2026-10-31' }, items: [{ title: 'Synthetic studio', day: 'tue', start: '10:00', end: '11:00', who: 'Robin Ellis' }] });
  assert.ok(fs.existsSync(file), 'the file is written on first load');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only Owner can read it (it holds feed links)');

  await assert.rejects(store.add({ url: 'https://cal.example.com/page.html' }, { parse }), (e) => e.statusCode === 422 && /not a calendar feed/.test(e.message));
  await assert.rejects(store.add({ url: 'https://cal.example.com/gone.ics' }, { parse }), (e) => e.statusCode === 422 && /404/.test(e.message));
  await assert.rejects(store.add({ url: OUTLOOK }, { parse }), (e) => e.statusCode === 409);
  const added = await store.add({ url: 'https://cal.example.com/extra.ics', label: 'Side project' }, { parse });
  assert.equal(added.source, 'added');
  assert.equal(added.ok, true);
  assert.equal(added.events, 1);
  assert.match(added.id, /^a[0-9a-f]{10}$/);

  // Config feeds: relabel, recolour, hide. config.json is never touched; it is an override here.
  const outlookId = first.feeds[1].id;
  const patched = await store.patch(outlookId, { label: 'Work', color: '#123456', hidden: false });
  assert.equal(patched.label, 'Work');
  assert.equal(patched.color, '#123456');
  await assert.rejects(store.patch(outlookId, { color: 'red' }), /colour/);
  await assert.rejects(store.remove(outlookId), (e) => e.statusCode === 409);
  await store.patch(first.feeds[0].id, { hidden: true });

  const got = await store.collect({ parse, from: now - 6 * 3600e3, to: now + 7 * 86400e3 });
  const titles = got.events.map((e) => e.title);
  assert.ok(!titles.includes('Gym'), 'a hidden feed is left out');
  const stats = got.events.find((e) => e.title === 'Weekly stats');
  assert.equal(stats.calendar, 'Work', 'the label shown follows the rename');
  assert.equal(stats.cal, 'Outlook', 'cal keeps the config label, so nudges still see Outlook');
  assert.equal(stats.color, '#123456');
  assert.equal(got.events.find((e) => e.title === 'Extra thing').calendar, 'Side project');
  assert.ok(got.events.some((e) => e.kind === 'class' && e.calendar === 'Classes'), 'classes are in (Tue 6 Oct)');
  assert.ok(got.calendars.some((c) => c.id === 'classes'));

  // A feed that stops answering keeps its last good events and says so.
  bodies.set(OUTLOOK, { status: 503, body: '' });
  const again = await store.collect({ parse, from: now - 6 * 3600e3, to: now + 7 * 86400e3 });
  assert.ok(again.events.some((e) => e.title === 'Weekly stats'));
  const status = (await store.list()).feeds.find((f) => f.id === outlookId);
  assert.equal(status.ok, false);
  assert.equal(status.status, 503);
  assert.match(status.error, /503/);

  const listed = JSON.stringify(await store.list());
  assert.ok(!listed.includes(SECRET), 'no feed link in what the API sends');
  assert.ok(!listed.includes('https://cal.example.com/extra.ics'));

  assert.deepEqual(await store.remove(added.id), { ok: true, id: added.id });
  assert.ok(!(await store.list()).feeds.some((f) => f.id === added.id));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.feeds.length, 0);
  assert.equal(onDisk.overrides[outlookId].label, 'Work');

  // Classes: replace, then hide.
  const saved = await store.setClasses({ term: { from: '2026-09-21', to: '2026-12-11' }, items: [{ title: 'Only one', day: 'mon', start: '09:00', end: '10:00' }] });
  assert.equal(saved.items.length, 1);
  assert.equal(saved.events, 2, 'Mon 5 and Mon 12 Oct at 09:00 are both inside the 7-day window');
  const hidden = await store.patch('classes', { hidden: true });
  assert.equal(hidden.classes.hidden, true);
  const noClasses = await store.collect({ parse, from: now - 6 * 3600e3, to: now + 7 * 86400e3 });
  assert.ok(!noClasses.events.some((e) => e.kind === 'class'));
});

test('store: a broken data file is kept aside and the defaults are used', async () => {
  const file = await tmpFile();
  await fsp.writeFile(file, '{ not json');
  const store = cs.createCalendars({ file, configFeeds: () => [] });
  const list = await store.list();
  assert.equal(list.feeds.length, 0);
  assert.equal(list.classes.items.length, 0);
  const names = await fsp.readdir(path.dirname(file));
  assert.ok(names.some((n) => n.startsWith('calendars.json.broken-')));
});

test('incomplete and oversized feeds keep cached events and report failure', async (t) => {
  const { mockHttps } = require('./http-fixture');
  const file = await tmpFile();
  const now = Date.parse('2026-10-05T08:00:00Z');
  const good = feed('Keep me', now + 3600e3);
  let mode = 'good';
  mockHttps(t, 'request', (res, req, ready) => {
    const body = mode === 'truncated' ? good.replace('END:VCALENDAR', '') : good;
    if (mode === 'length') res.headers['content-length'] = Buffer.byteLength(body) + 50;
    if (mode === 'declared oversized') res.headers['content-length'] = 8 * 1024 * 1024 + 1;
    ready();
    if (mode === 'aborted') { res.write(body); res.emit('aborted'); res.destroy(); }
    else if (mode === 'oversized') { res.write('BEGIN:VCALENDAR\r\n'); res.write(Buffer.alloc(8 * 1024 * 1024)); }
    else { res.complete = true; res.end(body); }
  });
  const store = cs.createCalendars({ file, configFeeds: () => [{ url: GOOGLE, label: 'Google' }], now: () => now });
  const opts = { parse: (body, label) => ics.parseIcsFeed(body, label, { now, windowDays: 7 }), from: now, to: now + 7 * 86400e3 };
  assert.ok((await store.collect(opts)).events.some((e) => e.title === 'Keep me'));
  for (mode of ['truncated', 'length', 'aborted', 'oversized', 'declared oversized']) {
    const got = await store.collect(opts);
    assert.ok(got.events.some((e) => e.title === 'Keep me'), mode);
    const status = (await store.list()).feeds[0];
    assert.equal(status.ok, false, mode);
    assert.ok(status.error, mode);
  }
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a fetch error on HTTP 200 prevents replacing cached events', async () => {
  const file = await tmpFile();
  const now = Date.parse('2026-10-05T08:00:00Z');
  let error = null;
  const store = cs.createCalendars({ file, configFeeds: () => [GOOGLE], now: () => now, fetcher: async () => ({ status: 200, body: feed(error ? 'Bad' : 'Good', now + 3600e3), error }) });
  const opts = { parse: (body, label) => ics.parseIcsFeed(body, label, { now, windowDays: 7 }), from: now, to: now + 86400e3 };
  await store.collect(opts);
  error = 'feed is over 8 MB';
  const got = await store.collect(opts);
  assert.ok(got.events.some((e) => e.title === 'Good'));
  assert.ok(!got.events.some((e) => e.title === 'Bad'));
  assert.equal((await store.list()).feeds[0].error, error);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('an existing timetable survives new empty defaults without rewriting the file', async (t) => {
 const file = await tmpFile(); t.after(() => fsp.rm(path.dirname(file), { recursive: true, force: true }));
 const classes = cs.normaliseClasses({ term: { from: '2027-01-01', to: '2027-02-01' }, items: [{ title: 'Saved studio', day: 'tue', start: '10:00', end: '11:00', who: 'Robin Ellis' }] });
 const before = JSON.stringify({ version: 1, feeds: [], overrides: {}, classes }); await fsp.writeFile(file, before);
 const store = cs.createCalendars({ file }); assert.deepEqual(await store.classes(), classes);
 assert.equal(await fsp.readFile(file, 'utf8'), before);
});
