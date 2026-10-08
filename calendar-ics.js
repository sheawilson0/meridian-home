'use strict';

// Calendar feeds (ICS) into the events Meridian shows and nudges for.
//
// Two feeds today: Google (Owner's personal calendar, which carries ATTENDEE
// lines with his PARTSTAT) and the published Outlook work calendar. The
// Outlook feed has no ATTENDEE, ORGANIZER or Teams URL property at all: an
// unanswered invite and a tentative accept both arrive as
// X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE, so `response` stays null there and
// `busyStatus` says 'tentative'. The Codex automations fill that gap from
// the Outlook connector (brief-intake.json -> invites, meetings).
//
// Teams links in the Outlook feed only live inside DESCRIPTION ("Join the
// meeting now<https://teams.microsoft.com/l/meetup-join/...>" or "Join:
// https://teams.microsoft.com/meet/..."), next to links that are not joins
// (Meeting options, Need help?), so the join URL is picked by path.
//
// Recurring series are expanded for DAILY and WEEKLY rules (INTERVAL, BYDAY,
// UNTIL, COUNT, EXDATE, RECURRENCE-ID overrides). Before Oct 2026 only a
// series' first date ever showed, so a weekly Monday meeting vanished after
// week one. Times with a TZID are read as this Mac's local time, as before
// (both feeds use UK time and the Mac is in Belfast).

const crypto = require('crypto');

const RESPONSES = { ACCEPTED: 'accepted', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needsAction', DECLINED: 'declined' };
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_DAYS = 40 * 366; // how far a series is walked from its DTSTART

function unfold(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(value) {
  return String(value || '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// NAME;PARAM=a;PARAM="b:c":value -> { name, params, value }. The first colon
// outside quotes ends the parameters (mailto: values contain colons too).
function parseLine(line) {
  let inQuote = false;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  if (i >= line.length) return null;
  const parts = line.slice(0, i).match(/(?:[^;"]|"[^"]*")+/g) || [];
  const name = String(parts.shift() || '').toUpperCase();
  if (!name) return null;
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value: line.slice(i + 1) };
}

// 20260719T090000Z (UTC), 20260719T090000 (local) or 20260719 (all day).
function parseIcsDate(v) {
  const m = String(v || '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

function emailOf(value) {
  const m = String(value || '').match(/mailto:([^\s;]+)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

const JOIN_PATHS = [
  /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//i,
  /^https:\/\/teams\.microsoft\.com\/meet\//i,
  /^https:\/\/teams\.live\.com\/meet\//i,
  /^https:\/\/([\w-]+\.)?zoom\.us\/(j|my|w|s)\//i,
  /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}/i,
];
const JOIN_HOSTS = /^https:\/\/((teams\.microsoft\.com|teams\.live\.com|meet\.google\.com)|([\w-]+\.)?zoom\.us)\//i;
const NOT_JOIN = /meetingOptions|meeting-options|\/support|aka\.ms/i;

// First join link in free text: a join path wins over a bare host match.
function joinUrlFromText(...texts) {
  const urls = [];
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/https?:\/\/[^\s<>"'\\]+/g)) urls.push(m[0].replace(/[),.;\]]+$/, ''));
  }
  return urls.find((u) => JOIN_PATHS.some((re) => re.test(u)))
    || urls.find((u) => JOIN_HOSTS.test(u) && !NOT_JOIN.test(u))
    || null;
}

// Owner's PARTSTAT, or 'accepted' when he organised it; null when the feed
// does not say (the Outlook feed never does).
function responseFor(attendees, organizerEmail, selfEmails) {
  const self = new Set((selfEmails || []).map((e) => String(e).toLowerCase()));
  const mine = attendees.find((a) => a.email && self.has(a.email));
  if (organizerEmail && self.has(organizerEmail)) return 'accepted';
  if (mine) return RESPONSES[(mine.partstat || 'NEEDS-ACTION').toUpperCase()] || null;
  return null;
}

function parseRrule(value) {
  const out = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

// Occurrence starts for a DAILY or WEEKLY rule, in local wall-clock time so
// a 09:15 meeting stays at 09:15 across the clock change. Unsupported rules
// return just the first start (the pre-Oct 2026 behaviour).
function expandRrule(startTs, rruleValue, { from = -Infinity, until = Infinity, exdates = new Set() } = {}) {
  const rule = parseRrule(rruleValue);
  const freq = String(rule.FREQ || '').toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return [startTs];
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Math.max(1, Number(rule.COUNT) || 1) : Infinity;
  const ruleUntil = rule.UNTIL ? parseIcsDate(rule.UNTIL) : Infinity;
  const stop = Math.min(until, ruleUntil == null ? Infinity : ruleUntil);
  const byDay = rule.BYDAY ? rule.BYDAY.split(',').map((d) => WEEKDAYS[d.replace(/^[+-]?\d+/, '').toUpperCase()]).filter((d) => d !== undefined) : null;
  const first = new Date(startTs);
  const out = [];
  let produced = 0;
  // Walk day by day from DTSTART; a day counts when it falls in an active
  // interval block and (for BYDAY) on a listed weekday.
  const weekStart = (d) => { const w = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)); return w; };
  const firstWeek = weekStart(first);
  for (let i = 0; i < MAX_DAYS && produced < count; i++) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i, first.getHours(), first.getMinutes(), first.getSeconds());
    const ts = day.getTime();
    if (ts > stop) break;
    let ok;
    if (freq === 'DAILY') {
      ok = i % interval === 0 && (!byDay || byDay.includes(day.getDay()));
    } else {
      const weeks = Math.round((weekStart(day) - firstWeek) / (7 * 86400000));
      ok = weeks % interval === 0 && (byDay ? byDay.includes(day.getDay()) : day.getDay() === first.getDay());
    }
    if (!ok) continue;
    produced++;
    if (ts >= from && !exdates.has(ts)) out.push(ts);
  }
  return out;
}

function readEvent(block) {
  const ev = { props: {}, attendees: [], exdates: new Set(), organizer: null, organizerEmail: null };
  for (const raw of block.split('\n')) {
    if (!raw) continue;
    if (/^(BEGIN|END):VALARM/i.test(raw)) { ev.inAlarm = /^BEGIN/i.test(raw); continue; }
    if (ev.inAlarm) continue;
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'ATTENDEE') {
      ev.attendees.push({ email: emailOf(line.value), partstat: line.params.PARTSTAT || null, name: line.params.CN || null });
    } else if (line.name === 'ORGANIZER') {
      ev.organizerEmail = emailOf(line.value);
      ev.organizer = line.params.CN ? unescapeText(line.params.CN) : ev.organizerEmail;
    } else if (line.name === 'EXDATE') {
      for (const v of line.value.split(',')) { const ts = parseIcsDate(v); if (ts) ev.exdates.add(ts); }
    } else if (!(line.name in ev.props)) {
      ev.props[line.name] = line;
    }
  }
  return ev;
}

function eventId(uid, ts, title) {
  const base = uid || crypto.createHash('sha1').update(String(title)).digest('hex').slice(0, 16);
  return `${base}|${new Date(ts).toISOString()}`;
}

// text -> events overlapping [now - 6 h, now + windowDays].
function parseIcsFeed(text, label, { now = Date.now(), windowDays = 7, selfEmails = [] } = {}) {
  const horizon = now + windowDays * 86400000;
  const floor = now - 6 * 3600 * 1000;
  const blocks = unfold(text).split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0]);
  const parsed = blocks.map(readEvent);
  // RECURRENCE-ID overrides replace the series occurrence they name.
  const overridden = new Map();
  for (const ev of parsed) {
    const rid = ev.props['RECURRENCE-ID'];
    const uid = ev.props.UID && ev.props.UID.value.trim();
    if (!rid || !uid) continue;
    if (!overridden.has(uid)) overridden.set(uid, new Set());
    overridden.get(uid).add(parseIcsDate(rid.value));
  }
  const events = [];
  for (const ev of parsed) {
    const p = ev.props;
    const startLine = p.DTSTART;
    const summary = p.SUMMARY ? unescapeText(p.SUMMARY.value).trim() : '';
    if (!startLine || !summary) continue;
    // Outlook keeps cancelled events as STATUS:CANCELLED and/or "Canceled:".
    if ((p.STATUS && /^CANCELLED$/i.test(p.STATUS.value.trim())) || /^cancell?ed:/i.test(summary)) continue;
    const start = parseIcsDate(startLine.value);
    if (!start) continue;
    const endRaw = p.DTEND ? parseIcsDate(p.DTEND.value) : null;
    const duration = endRaw ? endRaw - start : 0;
    const allDay = !startLine.value.includes('T');
    const uid = p.UID ? p.UID.value.trim() : null;
    const location = p.LOCATION ? unescapeText(p.LOCATION.value).trim() : '';
    const description = p.DESCRIPTION ? unescapeText(p.DESCRIPTION.value) : '';
    const joinUrl = (p['X-MICROSOFT-SKYPETEAMSMEETINGURL'] && p['X-MICROSOFT-SKYPETEAMSMEETINGURL'].value.trim())
      || (p['X-GOOGLE-CONFERENCE'] && p['X-GOOGLE-CONFERENCE'].value.trim())
      || joinUrlFromText(location, description);
    const busy = p['X-MICROSOFT-CDO-BUSYSTATUS'] ? p['X-MICROSOFT-CDO-BUSYSTATUS'].value.trim().toLowerCase() : null;
    const base = {
      title: summary, allDay, cal: label || null, uid,
      joinUrl: joinUrl || null,
      response: responseFor(ev.attendees, ev.organizerEmail, selfEmails),
      organizer: ev.organizer || null,
      busyStatus: busy || null,
      location: location || null,
    };
    let starts = [start];
    let recurring = false;
    if (p.RRULE && !p['RECURRENCE-ID']) {
      recurring = true;
      const skip = new Set([...ev.exdates, ...((uid && overridden.get(uid)) || [])]);
      starts = expandRrule(start, p.RRULE.value, { from: floor - duration, until: horizon, exdates: skip });
    }
    for (const ts of starts) {
      const end = endRaw ? ts + duration : null;
      if (ts > horizon || (end || ts) < floor) continue;
      events.push({ ts, end, ...base, id: eventId(uid, ts, summary), recurring: recurring || Boolean(p['RECURRENCE-ID']) });
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

// The address in a Google "secret address" ICS URL is the calendar owner.
function ownerFromFeedUrl(url) {
  const m = String(url || '').match(/\/calendar\/ical\/([^/]+)\//);
  if (!m) return null;
  try { const e = decodeURIComponent(m[1]).toLowerCase(); return /^[^@\s]+@[^@\s]+$/.test(e) ? e : null; } catch { return null; }
}

module.exports = { parseIcsFeed, parseIcsDate, parseLine, unfold, unescapeText, joinUrlFromText, responseFor, expandRrule, ownerFromFeedUrl, eventId };
