'use strict';
const runtime = require('./runtime');
const { JOBS_ENABLED } = runtime;

// Calendars (2 Oct 2026): every feed Meridian reads, plus the class timetable.
//
// Feeds come from two places:
//   - config.json -> calendar.icsUrl / icsUrls. Read-only here and shown as
//     "set in config". Relabelling, recolouring or hiding one is stored in
//     data/calendars.json -> overrides, so config.json is never written.
//   - data/calendars.json -> feeds: ones added from the Connect page.
// Feed URLs carry secret tokens. Nothing this module returns to the API holds
// one: feeds show `host` ("calendar.google.com…") and an id (a hash).
//
// Classes are a weekly timetable (day, start, end, Europe/London time)
// expanded into events inside the term, skipping listed dates. They sit on
// the "Classes" calendar and carry kind:'class', so meeting nudges skip them.
//
// Every event gets `calendar` (the label shown) and `color`. `cal` stays the
// feed's original label for config feeds (meeting-nudges.js keys on
// cal === 'Outlook'), so renaming a feed on the page never changes nudges.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');

const COLORS = { Outlook: '#6db4ff', Google: '#5fd3a5', Classes: '#b7a1ff' };
const PALETTE = ['#f2a65a', '#e58aa6', '#9bd36f', '#f6c93a', '#7fd6d6', '#c9a7ff', '#ff9f7a'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const TZ = 'Europe/London';
const MAX_BYTES = 8 * 1024 * 1024;

// Existing timetables live in calendars.json; new installs start empty.
const DEFAULT_CLASSES = {
  label: 'Classes',
  color: COLORS.Classes,
  hidden: false,
  term: { from: '2000-01-01', to: '2000-01-01' },
  skip: [],
  note: '',
  items: [],
};

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }
function maskUrl(url) { const h = hostOf(url); return h ? `${h}…` : '…'; }
function feedId(url) { return 'c' + crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10); }

// The name a feed gets when none is given, from its host.
function guessLabel(url) {
  const h = hostOf(url).toLowerCase();
  if (/(^|\.)google\.com$/.test(h)) return 'Google';
  if (/outlook|office365|office\.com|live\.com|hotmail/.test(h)) return 'Outlook';
  if (/icloud\.com$/.test(h)) return 'iCloud';
  const first = h.replace(/^www\./, '').split('.')[0] || 'Calendar';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function cleanColor(v) {
  const s = clean(v, 9);
  if (!s) return null;
  if (!/^#[0-9a-f]{6}$/i.test(s)) throw fail('colour must look like #6db4ff');
  return s.toLowerCase();
}

function defaultColor(label, used = []) {
  if (COLORS[label]) return COLORS[label];
  return PALETTE.find((c) => !used.includes(c)) || PALETTE[used.length % PALETTE.length];
}

// Portable profiles can also read a feed from a literal loopback HTTP server.
function allowedUrl(u) {
  return u.protocol === 'https:' || runtime.portableProfile() && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname);
}

// webcal:// (what Apple and Outlook sometimes hand out) uses https.
function normaliseUrl(raw) {
  let s = clean(raw, 4000);
  if (!s) throw fail('paste the calendar link');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw fail('that is not a link'); }
  if (!allowedUrl(u)) throw fail('the link has to start with https://');
  return u.href;
}

// GET an ICS feed: follows up to 3 redirects, keeps up to 8 MB
// (fetchUrl in server.js stops at 512 KB, which would cut a big feed short).
function fetchIcs(url, { timeout = 10000, redirects = 3 } = {}) {
  if (!JOBS_ENABLED) return Promise.resolve({ status: 0, body: '', error: 'Meridian jobs are off' });
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, body: '', error: 'bad link' }); return; }
    if (!allowedUrl(u)) { resolve({ status: 0, body: '', error: 'not https' }); return; }
    const req = (u.protocol === 'http:' ? http : https).request(u, { timeout, headers: { 'User-Agent': 'Meridian/1.0 calendar', Accept: 'text/calendar,*/*;q=0.5' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).href.replace(/^webcals?:\/\//i, 'https://'); } catch { resolve({ status: res.statusCode, body: '', error: 'bad redirect' }); return; }
        resolve(fetchIcs(next, { timeout, redirects: redirects - 1 }));
        return;
      }
      const chunks = []; let size = 0;
      const failed = (error) => resolve({ status: res.statusCode, body: '', error });
      const length = Number(res.headers['content-length']);
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { failed('feed is over 8 MB'); res.destroy(); }
        else chunks.push(c);
      });
      res.on('end', () => {
        if (!res.complete || (Number.isFinite(length) && size !== length)) { failed('incomplete calendar feed'); return; }
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), error: null });
      });
      res.on('aborted', () => failed('incomplete calendar feed'));
      res.on('error', () => failed('could not read calendar feed'));
      res.on('close', () => { if (!res.complete) failed('incomplete calendar feed'); });
      if (length > MAX_BYTES) { failed('feed is over 8 MB'); res.destroy(); }
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: String(e.message || e).slice(0, 120) }));
    req.end();
  });
}

const looksLikeIcs = (text) => /^BEGIN:VCALENDAR\s*$/im.test(String(text || '').slice(0, 4000)) && /(?:^|\n)END:VCALENDAR\s*$/i.test(String(text || ''));
const countEvents = (text) => (String(text || '').match(/BEGIN:VEVENT/g) || []).length;

// ---------------------------------------------------------------- time

let fmt = null;
// Minutes east of UTC in Europe/London at that instant.
function londonOffset(ms) {
  fmt = fmt || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
// Wall-clock time in London -> epoch ms (right across the clock changes).
function londonToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - londonOffset(guess) * 60000;
  return guess - londonOffset(first) * 60000;
}
// The London calendar date of an instant, as YYYY-MM-DD.
function londonDate(ms) {
  const t = ms + londonOffset(ms) * 60000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- classes

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v, what) {
  const s = clean(v, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T12:00:00Z'))) throw fail(`${what} must be a date (YYYY-MM-DD)`);
  return s;
}
function cleanTime(v, what) {
  const s = clean(v, 5);
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) throw fail(`${what} must be a time like 13:00`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
function cleanDay(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6) return DAYS[v];
  const s = clean(v, 12).toLowerCase();
  if (DAYS.includes(s)) return s;
  if (s in DAY_NAMES) return DAYS[DAY_NAMES[s]];
  const short = s.slice(0, 3);
  if (DAYS.includes(short)) return short;
  throw fail('day must be a weekday, e.g. tue');
}

function normaliseClasses(input = {}, existing = DEFAULT_CLASSES) {
  const src = input && typeof input === 'object' ? input : {};
  const termIn = src.term === undefined ? existing.term : src.term;
  if (!termIn || typeof termIn !== 'object') throw fail('term needs from and to');
  const term = { from: cleanDate(termIn.from, 'term start'), to: cleanDate(termIn.to, 'term end') };
  if (term.to < term.from) throw fail('the term ends before it starts');
  if (Date.parse(term.to) - Date.parse(term.from) > 400 * 86400000) throw fail('a term can be at most 400 days');
  const skipIn = src.skip === undefined ? (existing.skip || []) : src.skip;
  if (!Array.isArray(skipIn)) throw fail('skip must be a list of dates');
  const skip = [...new Set(skipIn.slice(0, 200).map((d) => cleanDate(d, 'a skipped date')))].sort();
  const itemsIn = src.items === undefined ? (existing.items || []) : src.items;
  if (!Array.isArray(itemsIn)) throw fail('items must be a list');
  if (itemsIn.length > 40) throw fail('at most 40 classes');
  const ids = new Set();
  const items = itemsIn.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw fail(`class ${i + 1} is empty`);
    const title = clean(raw.title, 120);
    if (!title) throw fail(`class ${i + 1} needs a name`);
    const start = cleanTime(raw.start, `${title}: start`);
    const end = cleanTime(raw.end, `${title}: end`);
    if (end <= start) throw fail(`${title} ends before it starts`);
    let id = /^[a-z0-9-]{1,40}$/.test(String(raw.id || '')) ? String(raw.id) : crypto.randomBytes(4).toString('hex');
    while (ids.has(id)) id = crypto.randomBytes(4).toString('hex');
    ids.add(id);
    return {
      id, title, day: cleanDay(raw.day), start, end,
      where: clean(raw.where, 120), who: clean(raw.who, 120),
      estimated: raw.estimated === true,
    };
  });
  const label = src.label === undefined ? (existing.label || 'Classes') : clean(src.label, 40) || 'Classes';
  const color = src.color === undefined ? (existing.color || COLORS.Classes) : (cleanColor(src.color) || COLORS.Classes);
  const hidden = src.hidden === undefined ? Boolean(existing.hidden) : Boolean(src.hidden);
  const note = src.note === undefined ? (existing.note || '') : clean(src.note, 400);
  return { label, color, hidden, term, skip, note, items };
}

// Class events overlapping [from, to] (epoch ms), in time order.
function expandClasses(classes, { from, to }) {
  const c = classes || {};
  if (!c.term || !Array.isArray(c.items) || !c.items.length) return [];
  const label = c.label || 'Classes';
  const color = c.color || COLORS.Classes;
  const skip = new Set(c.skip || []);
  const first = [c.term.from, londonDate(from - 86400000)].sort()[1];
  const last = [c.term.to, londonDate(to + 86400000)].sort()[0];
  const out = [];
  for (let day = first; day <= last;) {
    const [y, mo, d] = day.split('-').map(Number);
    const weekday = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
    if (!skip.has(day)) {
      for (const it of c.items) {
        if (it.day !== weekday) continue;
        const [sh, sm] = it.start.split(':').map(Number);
        const [eh, em] = it.end.split(':').map(Number);
        const ts = londonToUtc(y, mo, d, sh, sm);
        const end = londonToUtc(y, mo, d, eh, em);
        if (end < from || ts > to) continue;
        out.push({
          ts, end, title: it.title, allDay: false, cal: label, calendar: label, color,
          uid: `class-${it.id}`, id: `class-${it.id}|${new Date(ts).toISOString()}`,
          joinUrl: null, response: null, organizer: it.who || null, busyStatus: 'busy',
          location: it.where || null, recurring: true, kind: 'class', estimated: Boolean(it.estimated),
        });
      }
    }
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    day = next.toISOString().slice(0, 10);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------- store

function emptyDoc() {
  return { version: 1, note: 'Calendars added from the Connect page, label/colour/hidden for config.json feeds, and the class timetable. Feed links are secret: never paste this file.', feeds: [], overrides: {}, classes: JSON.parse(JSON.stringify(runtime.portableProfile() ? { ...DEFAULT_CLASSES, term: { from: '2000-01-01', to: '2000-01-01' }, note: '', items: [] } : DEFAULT_CLASSES)) };
}

// configFeeds: () => [{ url, label }] from config.json (read every time, so a config edit shows up).
function createCalendars({ file, configFeeds = () => [], fetcher = fetchIcs, now = () => Date.now() }) {
  let doc = null;
  let chain = Promise.resolve();
  const status = new Map(); // id -> { ok, status, events, total, at, error }
  const lastGood = new Map(); // id -> events from the last good fetch, kept through a blip

  function serialise(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function load() {
    if (doc) return doc;
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      const base = emptyDoc();
      let classes = base.classes;
      if (parsed.classes) {
        try { classes = normaliseClasses(parsed.classes, base.classes); } catch {
          // A hand edit that no longer reads: keep a copy, show the defaults.
          if (JOBS_ENABLED) await fsp.copyFile(file, `${file}.broken-${Date.now()}`).catch(() => {});
        }
      }
      doc = {
        ...base,
        feeds: Array.isArray(parsed.feeds) ? parsed.feeds.filter((f) => f && f.url && f.id) : [],
        overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
        classes,
      };
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
      if (e instanceof SyntaxError) {
        // Keep the broken file for a person to look at, then start clean.
        if (JOBS_ENABLED) await fsp.copyFile(file, `${file}.broken-${Date.now()}`).catch(() => {});
      }
      doc = emptyDoc();
      if (JOBS_ENABLED) await write();
    }
    return doc;
  }

  async function write() {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  // Every feed with its URL. Internal: never send this to a page.
  async function sources() {
    await load();
    const used = [];
    const out = [];
    const seen = new Set();
    for (const raw of configFeeds() || []) {
      const url = typeof raw === 'string' ? raw : raw && raw.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const id = feedId(url);
      const base = (raw && raw.label) || guessLabel(url);
      const o = doc.overrides[id] || {};
      const label = o.label || base;
      const color = o.color || (raw && raw.color) || defaultColor(base, used);
      used.push(color);
      out.push({ id, url, cal: base, label, color, hidden: Boolean(o.hidden), source: 'config' });
    }
    for (const f of doc.feeds) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      const color = f.color || defaultColor(f.label, used);
      used.push(color);
      out.push({ id: f.id, url: f.url, cal: f.label, label: f.label, color, hidden: Boolean(f.hidden), source: 'added', added: f.added || null });
    }
    return out;
  }

  // The URLs, for working out Owner's own address from a Google feed (sync, after first load).
  const urls = () => [...(configFeeds() || []).map((f) => (typeof f === 'string' ? f : f && f.url)), ...((doc && doc.feeds) || []).map((f) => f.url)].filter(Boolean);

  function publicFeed(f) {
    const s = status.get(f.id) || {};
    return {
      id: f.id, label: f.label, color: f.color, hidden: f.hidden, source: f.source, host: maskUrl(f.url),
      ok: s.ok === undefined ? null : s.ok, status: s.status ?? null, events: s.events ?? null, total: s.total ?? null,
      at: s.at || null, error: s.error || null, lastOk: s.lastOk || null,
    };
  }

  function classSummary(c, { from, to } = {}) {
    const t = now();
    const events = expandClasses(c, { from: from ?? t - 6 * 3600000, to: to ?? t + 7 * 86400000 }).length;
    return { ...JSON.parse(JSON.stringify(c)), events, perWeek: c.items.length };
  }

  async function list() {
    const feeds = await sources();
    return { feeds: feeds.map(publicFeed), classes: classSummary(doc.classes) };
  }

  async function check(url) {
    const r = await fetcher(url);
    if (r.error || r.status !== 200) return { ok: false, status: r.status || 0, error: r.error || (r.status ? `the calendar answered ${r.status}` : 'no answer from that address') };
    if (!looksLikeIcs(r.body)) return { ok: false, status: 200, error: 'that page is not a calendar feed (missing BEGIN:VCALENDAR or END:VCALENDAR). Use the ICS link, not the web page.' };
    return { ok: true, status: 200, body: r.body, total: countEvents(r.body) };
  }

  // POST: validate by fetching it once, then keep it.
  async function add(input = {}, { parse } = {}) {
    const url = normaliseUrl(input.url);
    const all = await sources();
    if (all.some((f) => f.url === url)) throw fail('that calendar is already connected', 409);
    if (doc.feeds.length >= 20) throw fail('at most 20 added calendars');
    const got = await check(url);
    if (!got.ok) throw Object.assign(fail(got.error, 422), { status: got.status });
    const label = clean(input.label, 40) || guessLabel(url);
    const color = cleanColor(input.color) || defaultColor(label, all.map((f) => f.color));
    const id = 'a' + crypto.randomBytes(5).toString('hex');
    const events = parse ? parse(got.body, label) : [];
    await serialise(async () => {
      doc.feeds.push({ id, label, url, color, hidden: false, added: new Date(now()).toISOString() });
      await write();
    });
    status.set(id, { ok: true, status: 200, events: events.length, total: got.total, at: now(), error: null, lastOk: now() });
    return publicFeed((await sources()).find((f) => f.id === id));
  }

  async function patch(id, input = {}) {
    if (id === 'classes') return { classes: await setClasses(pick(input, ['label', 'color', 'hidden'])) };
    const all = await sources();
    const f = all.find((x) => x.id === id);
    if (!f) throw fail('no calendar with that id', 404);
    const label = input.label === undefined ? undefined : clean(input.label, 40);
    if (label === '') throw fail('a calendar needs a name');
    const color = input.color === undefined ? undefined : cleanColor(input.color);
    const hidden = input.hidden === undefined ? undefined : Boolean(input.hidden);
    await serialise(async () => {
      if (f.source === 'config') {
        const o = { ...(doc.overrides[id] || {}) };
        if (label !== undefined) o.label = label;
        if (color !== undefined) o.color = color || undefined;
        if (hidden !== undefined) o.hidden = hidden;
        doc.overrides[id] = JSON.parse(JSON.stringify(o));
      } else {
        const rec = doc.feeds.find((x) => x.id === id);
        if (label !== undefined) rec.label = label;
        if (color !== undefined) rec.color = color || null;
        if (hidden !== undefined) rec.hidden = hidden;
      }
      await write();
    });
    return publicFeed((await sources()).find((x) => x.id === id));
  }

  async function remove(id) {
    await load();
    const all = await sources();
    const f = all.find((x) => x.id === id);
    if (!f) throw fail('no calendar with that id', 404);
    if (f.source === 'config') throw fail('that one is set in config.json, so it can only be hidden here', 409);
    await serialise(async () => {
      doc.feeds = doc.feeds.filter((x) => x.id !== id);
      await write();
    });
    status.delete(id); lastGood.delete(id);
    return { ok: true, id };
  }

  async function setClasses(input = {}) {
    await load();
    const next = normaliseClasses(input, doc.classes);
    await serialise(async () => { doc.classes = next; await write(); });
    return classSummary(doc.classes);
  }

  // Fetch every visible feed, parse it, add the classes. parse(text, label) -> events.
  // A feed that fails keeps its last good events, so a blip never blanks Up next.
  async function collect({ parse, from, to }) {
    const feeds = await sources();
    const visible = feeds.filter((f) => !f.hidden);
    const events = [];
    await Promise.all(visible.map(async (f) => {
      const got = await check(f.url);
      const prev = status.get(f.id) || {};
      if (got.ok) {
        let evs = [];
        try { evs = parse(got.body, f.cal); } catch (e) { got.ok = false; got.error = 'could not read it: ' + String(e.message || e).slice(0, 100); }
        if (got.ok) {
          evs = evs.map((e) => ({ ...e, cal: f.cal, calendar: f.label, color: f.color, feed: f.id }));
          lastGood.set(f.id, evs);
          status.set(f.id, { ok: true, status: 200, events: evs.length, total: got.total, at: now(), error: null, lastOk: now() });
          events.push(...evs);
          return;
        }
      }
      status.set(f.id, { ok: false, status: got.status, events: prev.events ?? 0, total: prev.total ?? null, at: now(), error: got.error, lastOk: prev.lastOk || null });
      if (lastGood.has(f.id)) events.push(...lastGood.get(f.id).filter((e) => (e.end || e.ts) >= from));
    }));
    const c = doc.classes;
    if (c && !c.hidden) events.push(...expandClasses(c, { from, to }));
    return {
      configured: feeds.length > 0 || Boolean(c && c.items && c.items.length),
      events,
      calendars: [
        ...feeds.map((f) => ({ id: f.id, label: f.label, color: f.color, hidden: f.hidden, ok: status.get(f.id) ? status.get(f.id).ok : null })),
        ...(c && c.items && c.items.length ? [{ id: 'classes', label: c.label || 'Classes', color: c.color, hidden: Boolean(c.hidden), ok: true }] : []),
      ],
    };
  }

  return { load, sources, urls, list, add, patch, remove, setClasses, collect, check, status: (id) => status.get(id) || null, classes: async () => (await load()).classes };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = {
  createCalendars, expandClasses, normaliseClasses, normaliseUrl, fetchIcs, guessLabel, maskUrl, feedId,
  looksLikeIcs, countEvents, londonToUtc, londonDate, DEFAULT_CLASSES, COLORS,
};
