'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const ics = require('../calendar-ics');

const SELF = ['owner@example.com', 'owner@example.com'];
const NOW = new Date(2026, 9, 2, 7, 0, 0).getTime(); // Fri 2 Oct 2026, 07:00 local

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const stamp = (y, mo, d, h, mi) => `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}${String(mi).padStart(2, '0')}00`;

function feed(...events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.map((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT'].join('\r\n')), 'END:VCALENDAR'].join('\r\n');
}

test('PARTSTAT maps to Owner\'s response; organiser counts as accepted; none is null', () => {
  const text = feed(
    ['UID:a1', `DTSTART:${stamp(2026, 10, 2, 10, 0)}`, `DTEND:${stamp(2026, 10, 2, 11, 0)}`, 'SUMMARY:Accepted one', 'ATTENDEE;CN=Owner;PARTSTAT=ACCEPTED:mailto:owner@example.com'],
    ['UID:a2', `DTSTART:${stamp(2026, 10, 2, 12, 0)}`, 'SUMMARY:Tentative one', 'ATTENDEE;PARTSTAT=TENTATIVE;CN="Example, Owner":mailto:OWNER@EXAMPLE.COM'],
    ['UID:a3', `DTSTART:${stamp(2026, 10, 2, 13, 0)}`, 'SUMMARY:Unanswered', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@example.com', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:personal@example.com'],
    ['UID:a4', `DTSTART:${stamp(2026, 10, 2, 14, 0)}`, 'SUMMARY:Declined', 'ATTENDEE;PARTSTAT=DECLINED:mailto:owner@example.com'],
    ['UID:a5', `DTSTART:${stamp(2026, 10, 2, 15, 0)}`, 'SUMMARY:Mine', 'ORGANIZER;CN=the owner:mailto:owner@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@example.com'],
    ['UID:a6', `DTSTART:${stamp(2026, 10, 2, 16, 0)}`, 'SUMMARY:No attendee data', 'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE'],
    ['UID:a7', `DTSTART:${stamp(2026, 10, 2, 17, 0)}`, 'SUMMARY:No partstat param', 'ATTENDEE;CN=Owner:mailto:owner@example.com', 'ORGANIZER;CN=Robin Swan:mailto:swan@example.com'],
  );
  const ev = ics.parseIcsFeed(text, 'Google', { now: NOW, selfEmails: SELF });
  const by = Object.fromEntries(ev.map((e) => [e.title, e]));
  assert.equal(by['Accepted one'].response, 'accepted');
  assert.equal(by['Tentative one'].response, 'tentative', 'quoted CN with a comma and an upper-case address');
  assert.equal(by.Unanswered.response, 'needsAction');
  assert.equal(by.Declined.response, 'declined');
  assert.equal(by.Mine.response, 'accepted', 'organiser');
  assert.equal(by.Mine.organizer, 'the owner');
  assert.equal(by['No attendee data'].response, null);
  assert.equal(by['No attendee data'].busyStatus, 'tentative');
  assert.equal(by['No partstat param'].response, 'needsAction', 'RFC 5545 default');
  assert.equal(by['No partstat param'].organizer, 'Robin Swan');
  assert.equal(by['Accepted one'].id, `a1|${new Date(local(2026, 10, 2, 10, 0)).toISOString()}`);
});

test('join links: Teams property first, then Teams/Zoom/Meet links in LOCATION or DESCRIPTION', () => {
  const teamsJoin = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d';
  const text = feed(
    ['UID:j1', `DTSTART:${stamp(2026, 10, 2, 10, 0)}`, 'SUMMARY:Property', `X-MICROSOFT-SKYPETEAMSMEETINGURL:${teamsJoin}`, 'DESCRIPTION:Other https://zoom.us/j/1'],
    // Outlook's published feed: options and help links sit before the join one.
    ['UID:j2', `DTSTART:${stamp(2026, 10, 2, 11, 0)}`, 'SUMMARY:Outlook body', 'LOCATION:Microsoft Teams Meeting',
      'DESCRIPTION:___\\nMicrosoft Teams Need help?<https://aka.ms/JoinTeamsMeeting?omkt=en-GB>\\nFor organisers: Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=1&tenantId=2>\\nJoin the meeting now<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d>\\n___'],
    ['UID:j3', `DTSTART:${stamp(2026, 10, 2, 12, 0)}`, 'SUMMARY:New Teams format', 'DESCRIPTION:Join: https://teams.microsoft.com/meet/334527537387300?p=Bu\\nMeeting ID: 334'],
    ['UID:j4', `DTSTART:${stamp(2026, 10, 2, 13, 0)}`, 'SUMMARY:Zoom', 'LOCATION:https://us02web.zoom.us/j/8812345678?pwd=abc\\, Room 2'],
    ['UID:j5', `DTSTART:${stamp(2026, 10, 2, 14, 0)}`, 'SUMMARY:Meet', 'DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij'],
    ['UID:j6', `DTSTART:${stamp(2026, 10, 2, 15, 0)}`, 'SUMMARY:Plain', 'LOCATION:Liverpool office', 'DESCRIPTION:See https://example.com/agenda'],
    // A folded line splitting the URL across two lines.
    ['UID:j7', `DTSTART:${stamp(2026, 10, 2, 16, 0)}`, 'SUMMARY:Folded', 'DESCRIPTION:Join the meeting now<https://teams.microsoft.com/l/meetup-j', ' oin/19%3ameeting_folded%40thread.v2/0>'],
  );
  const ev = Object.fromEntries(ics.parseIcsFeed(text, 'Outlook', { now: NOW }).map((e) => [e.title, e.joinUrl]));
  assert.equal(ev.Property, teamsJoin);
  assert.equal(ev['Outlook body'], 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d');
  assert.equal(ev['New Teams format'], 'https://teams.microsoft.com/meet/334527537387300?p=Bu');
  assert.equal(ev.Zoom, 'https://us02web.zoom.us/j/8812345678?pwd=abc');
  assert.equal(ev.Meet, 'https://meet.google.com/abc-defg-hij');
  assert.equal(ev.Plain, null);
  assert.equal(ev.Folded, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_folded%40thread.v2/0');
});

test('cancelled events drop; window is now - 6 h to now + windowDays; text is unescaped', () => {
  const text = feed(
    ['UID:c1', `DTSTART:${stamp(2026, 10, 2, 10, 0)}`, 'SUMMARY:Gone', 'STATUS:CANCELLED'],
    ['UID:c2', `DTSTART:${stamp(2026, 10, 2, 11, 0)}`, 'SUMMARY:Canceled: Old title'],
    ['UID:c3', `DTSTART:${stamp(2026, 9, 1, 11, 0)}`, 'SUMMARY:Last month'],
    ['UID:c4', `DTSTART:${stamp(2026, 10, 20, 11, 0)}`, 'SUMMARY:Too far'],
    ['UID:c5', 'DTSTART;VALUE=DATE:20261003', 'SUMMARY:Shift\\, then gym\\; late'],
  );
  const ev = ics.parseIcsFeed(text, null, { now: NOW, windowDays: 7 });
  assert.deepEqual(ev.map((e) => e.title), ['Shift, then gym; late']);
  assert.equal(ev[0].allDay, true);
});

test('weekly and daily series expand, with EXDATE and RECURRENCE-ID overrides', () => {
  const text = feed(
    // Monday 15:45 weekly, starting 5 Oct (the DEMO stats catch-up shape).
    ['UID:weekly', `DTSTART;TZID=GMT Standard Time:${stamp(2026, 10, 5, 15, 45)}`, `DTEND;TZID=GMT Standard Time:${stamp(2026, 10, 5, 16, 0)}`, 'RRULE:FREQ=WEEKLY;UNTIL=20270329T144500Z;INTERVAL=1;BYDAY=MO;WKST=MO', 'SUMMARY:Weekly stats'],
    // Daily 09:15 since 2025, one day excluded, one moved, one cancelled.
    ['UID:daily', `DTSTART;TZID=GMT Standard Time:${stamp(2025, 11, 3, 9, 15)}`, `DTEND;TZID=GMT Standard Time:${stamp(2025, 11, 3, 9, 30)}`, 'RRULE:FREQ=DAILY;UNTIL=20271002T081500Z;INTERVAL=1', `EXDATE;TZID=GMT Standard Time:${stamp(2026, 10, 4, 9, 15)}`, 'SUMMARY:Daily'],
    ['UID:daily', `RECURRENCE-ID;TZID=GMT Standard Time:${stamp(2026, 10, 3, 9, 15)}`, `DTSTART;TZID=GMT Standard Time:${stamp(2026, 10, 3, 10, 0)}`, `DTEND;TZID=GMT Standard Time:${stamp(2026, 10, 3, 10, 15)}`, 'SUMMARY:Daily (moved)'],
    ['UID:daily', `RECURRENCE-ID;TZID=GMT Standard Time:${stamp(2026, 10, 6, 9, 15)}`, `DTSTART;TZID=GMT Standard Time:${stamp(2026, 10, 6, 9, 15)}`, 'STATUS:CANCELLED', 'SUMMARY:Daily'],
    // Every other week, three times only.
    ['UID:count', `DTSTART:${stamp(2026, 9, 21, 12, 0)}`, 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'SUMMARY:Fortnightly'],
  );
  const ev = ics.parseIcsFeed(text, 'Outlook', { now: NOW, windowDays: 14 });
  const at = (title) => ev.filter((e) => e.title === title).map((e) => new Date(e.ts).toISOString());
  const iso = (...a) => new Date(local(...a)).toISOString();
  assert.deepEqual(at('Weekly stats'), [iso(2026, 10, 5, 15, 45), iso(2026, 10, 12, 15, 45)]);
  const weekly = ev.find((e) => e.title === 'Weekly stats');
  assert.equal(weekly.end - weekly.ts, 15 * 60000, 'duration carried to each occurrence');
  assert.equal(weekly.recurring, true);
  const daily = at('Daily');
  assert.ok(daily.includes(iso(2026, 10, 2, 9, 15)));
  assert.ok(!daily.includes(iso(2026, 10, 3, 9, 15)), 'overridden by the moved instance');
  assert.ok(!daily.includes(iso(2026, 10, 4, 9, 15)), 'EXDATE');
  assert.ok(!daily.includes(iso(2026, 10, 6, 9, 15)), 'cancelled override');
  assert.ok(daily.includes(iso(2026, 10, 15, 9, 15)));
  assert.equal(daily.length, 11, '2 to 15 Oct is 14 days, minus 3');
  assert.deepEqual(at('Daily (moved)'), [iso(2026, 10, 3, 10, 0)]);
  assert.deepEqual(at('Fortnightly'), [iso(2026, 10, 5, 12, 0)], '21 Sep, 5 Oct, 19 Oct (past the window)');
  assert.ok(new Set(ev.map((e) => e.id)).size === ev.length, 'ids are unique per occurrence');
});

test('expandRrule keeps wall-clock time across the clock change', () => {
  const start = local(2026, 10, 19, 9, 15);
  const out = ics.expandRrule(start, 'FREQ=WEEKLY;COUNT=3');
  assert.deepEqual(out.map((t) => [new Date(t).getHours(), new Date(t).getMinutes()]), [[9, 15], [9, 15], [9, 15]]);
  assert.deepEqual(ics.expandRrule(start, 'FREQ=MONTHLY;COUNT=3'), [start], 'unsupported rules fall back to the first date');
});

test('parseLine, unescapeText and ownerFromFeedUrl', () => {
  assert.deepEqual(ics.parseLine('ATTENDEE;CN="A: B";PARTSTAT=ACCEPTED:mailto:personal@example.com'), { name: 'ATTENDEE', params: { CN: 'A: B', PARTSTAT: 'ACCEPTED' }, value: 'mailto:personal@example.com' });
  assert.equal(ics.unescapeText('a\\,b\\;c\\nd\\\\e'), 'a,b;c\nd\\e');
  assert.equal(ics.ownerFromFeedUrl('https://calendar.google.com/calendar/ical/owner%40example.com/private-abc/basic.ics'), 'owner@example.com');
  assert.equal(ics.ownerFromFeedUrl('https://outlook.office365.com/owa/calendar/x/y/calendar.ics'), null);
});
