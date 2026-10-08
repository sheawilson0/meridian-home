'use strict';

// Meetings Owner should not miss. Three inputs:
//   - calendar events from the ICS feeds (calendar-ics.js);
//   - `invites` the Codex automations find in Outlook (invitations he has
//     not answered, which the published Outlook feed cannot tell apart from
//     tentative accepts);
//   - `meetings` they find in Outlook (online meetings today and tomorrow,
//     with join links the feed may lack).
// Out come state.invites, join links merged onto calendar events, and
// nudges 10 minutes and 1 minute before anything with a join link or from
// Outlook. Each nudge goes out once per event and offset, recorded in
// data/nudges.json so a restart never repeats one.

const fsp = require('fs/promises');
const path = require('path');

const DEFAULTS = { enabled: true, minutes: [10, 1], skip: [] };
const SLOT_MS = 5 * 60 * 1000;

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function normTitle(value) {
  return String(value || '').toLowerCase().replace(/^(re|fw|fwd|updated|invitation|accepted|tentative):\s*/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Same meeting if one title contains the other or at least half the words
// of the longer one are shared (the start time must match too).
function similarTitle(a, b) {
  const x = normTitle(a); const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))) return true;
  const wx = new Set(x.split(' ').filter((w) => w.length > 2));
  const wy = new Set(y.split(' ').filter((w) => w.length > 2));
  if (!wx.size || !wy.size) return false;
  let shared = 0;
  for (const w of wx) if (wy.has(w)) shared++;
  return shared / Math.max(wx.size, wy.size) >= 0.5;
}

const sameSlot = (a, b) => a != null && b != null && Math.abs(a - b) <= SLOT_MS;
const slotKey = (title, ms) => `${normTitle(title)}|${Math.round(ms / 60000)}`;

function cleanUrl(value) {
  const s = String(value || '').trim();
  return /^https:\/\/\S+$/i.test(s) ? s.slice(0, 2000) : null;
}

// Intake rows from the automations -> tidy rows, or null.
function normaliseIntakeMeeting(raw, { invite = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const start = toMs(raw.start);
  const title = String(raw.title || raw.subject || '').trim().slice(0, 200);
  if (start == null || !title) return null;
  const end = toMs(raw.end);
  const out = {
    id: String(raw.id || '').trim().slice(0, 500) || `intake|${slotKey(title, start)}`,
    title,
    start: iso(start),
    end: iso(end),
    joinUrl: cleanUrl(raw.joinUrl),
  };
  if (invite) {
    out.organizer = String(raw.organizer || '').trim().slice(0, 180) || null;
    out.response = 'needsAction';
    out.url = cleanUrl(raw.url);
  }
  return out;
}

// Copies of the calendar events with intake join links and invite status
// merged in, the invites list, and intake meetings that matched no event.
function mergeMeetings(events, intake = {}, { now = Date.now(), inviteDays = 14 } = {}) {
  const out = (events || []).map((e) => ({ ...e }));
  const meetings = (Array.isArray(intake.meetings) ? intake.meetings : []).map((m) => normaliseIntakeMeeting(m)).filter(Boolean);
  const intakeInvites = (Array.isArray(intake.invites) ? intake.invites : []).map((m) => normaliseIntakeMeeting(m, { invite: true })).filter(Boolean);
  const find = (title, startMs) => out.find((e) => !e.allDay && sameSlot(e.ts, startMs) && similarTitle(e.title, title));

  const unmatched = [];
  for (const m of meetings) {
    const ev = find(m.title, toMs(m.start));
    if (ev) { if (!ev.joinUrl && m.joinUrl) { ev.joinUrl = m.joinUrl; ev.joinFrom = 'outlook'; } ev.outlookId = ev.outlookId || m.id; }
    else unmatched.push({ ...m, source: 'outlook' });
  }

  const horizon = now + inviteDays * 86400000;
  const seen = new Set();
  const invites = [];
  for (const inv of intakeInvites) {
    const start = toMs(inv.start);
    if (start < now - 3600 * 1000 || start > horizon) continue;
    const ev = find(inv.title, start);
    if (ev) {
      if (!ev.response) ev.response = 'needsAction';
      if (!ev.joinUrl && inv.joinUrl) { ev.joinUrl = inv.joinUrl; ev.joinFrom = 'outlook'; }
    }
    const key = slotKey(inv.title, start);
    if (seen.has(key)) continue;
    seen.add(key);
    invites.push({ ...inv, joinUrl: inv.joinUrl || (ev && ev.joinUrl) || null, source: 'outlook', inCalendar: Boolean(ev), calendarId: ev ? ev.id : null });
  }
  for (const ev of out) {
    if (ev.response !== 'needsAction' || ev.allDay || ev.ts < now - 3600 * 1000) continue;
    const key = slotKey(ev.title, ev.ts);
    if (seen.has(key)) continue;
    seen.add(key);
    invites.push({ id: ev.id, title: ev.title, start: iso(ev.ts), end: iso(ev.end), organizer: ev.organizer || null, joinUrl: ev.joinUrl || null, response: 'needsAction', url: null, source: 'ics', cal: ev.cal || null, inCalendar: true, calendarId: ev.id });
  }
  invites.sort((a, b) => toMs(a.start) - toMs(b.start));
  return { events: out, invites, unmatched };
}

function nudgeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const minutes = (Array.isArray(src.minutes) ? src.minutes : DEFAULTS.minutes)
    .map(Number).filter((m) => Number.isFinite(m) && m >= 0 && m <= 180);
  const skip = (Array.isArray(src.skip) ? src.skip : DEFAULTS.skip).map(String).filter(Boolean);
  return {
    enabled: src.enabled === undefined ? DEFAULTS.enabled : src.enabled !== false,
    minutes: [...new Set(minutes.length ? minutes : DEFAULTS.minutes)].sort((a, b) => b - a),
    skip,
  };
}

const isClass = (e) => e.kind === 'class' || e.calendar === 'Classes' || e.cal === 'Classes';

// Everything worth a nudge: timed, not declined, not a class, and with a
// join link or from Outlook (the work calendar, intake meetings and invites).
function nudgeCandidates({ events = [], invites = [], unmatched = [] } = {}, { skip = [] } = {}) {
  const res = skip.map((s) => { try { return new RegExp(s, 'i'); } catch { return null; } }).filter(Boolean);
  const seen = new Set();
  const out = [];
  const add = (c) => {
    if (c.start == null || !c.title) return;
    if (res.some((re) => re.test(c.title.trim()))) return;
    const key = slotKey(c.title, c.start);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const e of events) {
    if (e.allDay || e.response === 'declined') continue;
    // Classes (calendars-store.js): Owner knows when they are, so never a nudge.
    if (isClass(e)) continue;
    const outlook = e.cal === 'Outlook' || e.joinFrom === 'outlook';
    if (!e.joinUrl && !outlook) continue;
    add({ id: e.id, title: e.title, start: e.ts, joinUrl: e.joinUrl || null });
  }
  for (const m of [...unmatched, ...invites]) add({ id: m.id, title: m.title, start: toMs(m.start), joinUrl: m.joinUrl || null });
  return out;
}

// Nudges due now. Each offset owns the stretch until the next one, and the
// last runs until 2 minutes after the start, so a nudge missed while
// Meridian was restarting still goes out late rather than never.
function dueNudges(candidates, { now = Date.now(), minutes = DEFAULTS.minutes, sent = {} } = {}) {
  const offsets = [...minutes].sort((a, b) => b - a);
  const due = [];
  for (const c of candidates) {
    for (let i = 0; i < offsets.length; i++) {
      const m = offsets[i];
      const from = c.start - m * 60000;
      const to = i + 1 < offsets.length ? c.start - offsets[i + 1] * 60000 : c.start + 2 * 60000;
      if (now < from || now >= to) continue;
      const key = `${c.id}|${m}`;
      if (sent[key]) continue;
      const left = Math.max(1, Math.round((c.start - now) / 60000));
      due.push({ key, id: c.id, title: c.title, start: iso(c.start), minutes: m, joinUrl: c.joinUrl || null, body: m <= 1 ? 'starting now' : `in ${left} min` });
    }
  }
  return due;
}

function createNudger({ file, now = () => Date.now(), send = async () => false, announce = () => {} }) {
  let busy = false;
  async function read() {
    try { const doc = JSON.parse(await fsp.readFile(file, 'utf8')); return doc && typeof doc.sent === 'object' && doc.sent ? doc.sent : {}; } catch { return {}; }
  }
  async function write(sent) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ note: 'Meeting nudges already sent, per event and minutes before. Kept 3 days.', sent }, null, 2) + '\n');
    await fsp.rename(tmp, file);
  }
  // Records each nudge before sending, so a crash mid-send never repeats it.
  async function tick(candidates, config) {
    if (busy || !config.enabled) return [];
    busy = true;
    try {
      const t = now();
      const sent = await read();
      const due = dueNudges(candidates, { now: t, minutes: config.minutes, sent });
      const cutoff = t - 3 * 86400000;
      for (const [k, at] of Object.entries(sent)) if (!(Date.parse(at) >= cutoff)) delete sent[k];
      if (!due.length) return [];
      for (const n of due) sent[n.key] = new Date(t).toISOString();
      await write(sent);
      for (const n of due) {
        announce(n);
        try { n.pushed = await send(n); } catch { n.pushed = false; }
      }
      return due;
    } finally { busy = false; }
  }
  return { tick, read };
}

module.exports = { DEFAULTS, mergeMeetings, nudgeCandidates, dueNudges, createNudger, nudgeConfig, similarTitle, normTitle, toMs };
