'use strict';

// Session recordings for the usability test (7 Oct 2026). The participant's
// page runs rrweb (tester/public/rec.js) and posts its events here in
// batches; Owner replays them on the admin side (tester/admin/replay.html)
// with a summary of where they clicked, rage and dead clicks, and how long
// each task took.
//
// One session is two files in `dir`:
//   <session>.jsonl      one line per batch: {seq, at, events}
//   <session>.meta.json  {session, invite, started, last, batches, count, bytes, meta}
// Batches are appended, never rewritten, so a crash loses one line at most
// (a torn last line is skipped when reading). Writes to a session go one at
// a time; different sessions write in parallel.
//
// Event shapes are rrweb 2.1.7's own (@rrweb/types): type 2 full snapshot,
// 3 incremental (data.source 0 mutation, 1 mouse move, 2 mouse interaction,
// 3 scroll, 4 viewport resize, 5 input, 7 media), 4 meta {href, width,
// height}, 5 custom {tag, payload}. Our custom tags are `click`, `nav` and
// `task` (see rec.js).

const fsp = require('fs/promises');
const path = require('path');

const SESSION = /^[a-z0-9-]{8,80}$/;
const INVITE = /^[a-z0-9]{4,40}$/;
const MAX_EVENTS = 5000;
const MAX_FILE = 60 * 1024 * 1024;
const RECENT = 20; // batch keys kept in meta to spot a resent batch

const FULL = 2, INCREMENTAL = 3, META = 4, CUSTOM = 5;
const MUTATION = 0, SCROLL = 3, INPUT = 5, MEDIA = 7;
const RAGE_CLICKS = 3, RAGE_MS = 1000, RAGE_PX = 40, DEAD_MS = 1000;
// Nobody clicks more than this in a real session; a recording that claims to is cut short, so a
// forged one can't make the summary (and the server) crawl.
const MAX_CLICKS = 5000, RAGE_LOOK = 30;
// Clicking into a field gives it focus and nothing else, which isn't dead.
const FIELDS = ['input', 'textarea', 'select'];

function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// The same batch sent twice (a retry after a lost reply, or a beacon) has
// the same seq and the same events; a reload that restarts seq does not.
const batchKey = (seq, events) => [seq, events.length, events.length ? events[0].timestamp : 0, events.length ? events[events.length - 1].timestamp : 0].join(':');

function cleanMeta(m) {
  if (!isObj(m)) return null;
  return { ua: str(m.ua, 400), w: num(m.w) ? Math.round(m.w) : null, h: num(m.h) ? Math.round(m.h) : null, href: str(m.href, 500), started: num(m.started) ? m.started : null };
}

async function endsWithNewline(file, size) {
  const fh = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(1); await fh.read(b, 0, 1, size - 1); return b[0] === 10; } finally { await fh.close(); }
}

function hashOf(href) {
  if (typeof href !== 'string') return '';
  const i = href.indexOf('#');
  return i < 0 ? '' : href.slice(i);
}

function createRecordings({ dir, maxBytes = MAX_FILE, now = () => Date.now() }) {
  const chains = new Map(); // session -> promise
  function serial(session, fn) {
    const prev = chains.get(session) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    chains.set(session, tail);
    tail.then(() => { if (chains.get(session) === tail) chains.delete(session); });
    return run;
  }
  const lines = (s) => path.join(dir, s + '.jsonl');
  const metaFile = (s) => path.join(dir, s + '.meta.json');

  async function readMeta(session) {
    try { return JSON.parse(await fsp.readFile(metaFile(session), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function writeMeta(m) {
    const tmp = metaFile(m.session) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(m) + '\n');
    await fsp.rename(tmp, metaFile(m.session));
  }
  const pub = (m) => ({ session: m.session, invite: m.invite, started: m.started, last: m.last, count: m.count, bytes: m.bytes, meta: m.meta || null });

  function check(body) {
    if (!isObj(body)) throw fail('expected a JSON object');
    const { session, invite, seq, events } = body;
    if (typeof session !== 'string' || !SESSION.test(session)) throw fail('bad session');
    if (typeof invite !== 'string' || !INVITE.test(invite)) throw fail('bad invite');
    if (!Number.isInteger(seq) || seq < 0 || seq > 100000) throw fail('bad seq');
    if (!Array.isArray(events) || events.length > MAX_EVENTS) throw fail('events must be an array of at most ' + MAX_EVENTS);
    for (const e of events) if (!isObj(e) || !num(e.timestamp) || !num(e.type)) throw fail('each event needs a numeric timestamp and type');
  }

  // Returns {ok, session, seq, duplicate?}. Throws with statusCode 400 (bad
  // input), 403 (session belongs to another invite) or 413 (session full).
  function append(body) {
    try { check(body); } catch (e) { return Promise.reject(e); }
    const { session, invite, seq, events } = body;
    return serial(session, async () => {
      await fsp.mkdir(dir, { recursive: true });
      const m = await readMeta(session);
      if (m && m.invite !== invite) throw fail('session belongs to another invite', 403);
      const key = batchKey(seq, events);
      if (m && (m.recent || []).includes(key)) return { ok: true, session, seq, duplicate: true };
      let size = 0;
      try { size = (await fsp.stat(lines(session))).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // After a torn write, start a fresh line so this batch isn't lost too.
      const line = (size && !(await endsWithNewline(lines(session), size)) ? '\n' : '') + JSON.stringify({ seq, at: now(), events }) + '\n';
      if (size + Buffer.byteLength(line) > maxBytes) throw fail('recording is full', 413);
      await fsp.appendFile(lines(session), line);
      let first = Infinity, last = -Infinity;
      for (const e of events) { if (e.timestamp < first) first = e.timestamp; if (e.timestamp > last) last = e.timestamp; }
      const next = m || { session, invite, started: null, last: null, batches: 0, count: 0, bytes: 0, meta: null, recent: [] };
      if (events.length) {
        next.started = next.started == null ? first : Math.min(next.started, first);
        next.last = next.last == null ? last : Math.max(next.last, last);
      } else if (next.started == null) next.started = next.last = now();
      next.batches += 1;
      next.count += events.length;
      next.bytes = size + Buffer.byteLength(line);
      if (!next.meta && body.meta) next.meta = cleanMeta(body.meta);
      next.recent = [...(next.recent || []), key].slice(-RECENT);
      await writeMeta(next);
      return { ok: true, session, seq };
    });
  }

  // Newest first.
  async function list({ invite } = {}) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.meta.json')) continue;
      const s = n.slice(0, -'.meta.json'.length);
      if (!SESSION.test(s)) continue;
      let m; try { m = await readMeta(s); } catch { continue; }
      if (!m || (invite && m.invite !== invite)) continue;
      out.push(pub(m));
    }
    return out.sort((a, b) => (b.started || 0) - (a.started || 0));
  }

  async function info(session) {
    if (typeof session !== 'string' || !SESSION.test(session)) throw fail('bad session');
    const m = await readMeta(session);
    if (!m) throw fail('no recording ' + session, 404);
    return pub(m);
  }

  // Every event, batches in seq order (a resent batch once), then by time.
  async function events(session) {
    await info(session);
    let text = '';
    try { text = await fsp.readFile(lines(session), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const seen = new Set(), batches = [];
    for (const l of text.split('\n')) {
      if (!l) continue;
      let b; try { b = JSON.parse(l); } catch { continue; } // a torn last line
      if (!b || !Array.isArray(b.events)) continue;
      const key = batchKey(b.seq, b.events);
      if (seen.has(key)) continue;
      seen.add(key);
      batches.push(b);
    }
    batches.sort((a, b) => a.seq - b.seq);
    return batches.flatMap((b) => b.events).sort((a, b) => a.timestamp - b.timestamp);
  }

  async function summary(session) {
    const m = await info(session);
    return summarise(await events(session), m);
  }

  // Deletes every session for an invite; returns how many.
  async function removeInvite(invite) {
    if (typeof invite !== 'string' || !INVITE.test(invite)) throw fail('bad invite');
    const sessions = (await list({ invite })).map((x) => x.session);
    for (const s of sessions) {
      await serial(s, async () => {
        for (const f of [lines(s), metaFile(s), metaFile(s) + '.tmp']) await fsp.rm(f, { force: true });
      });
    }
    return sessions.length;
  }

  return { append, list, info, events, summary, removeInvite };
}

// The summary the replay page draws. `t` is ms since the first event.
function summarise(events, m = {}) {
  const started = events.length ? events[0].timestamp : (m.started || 0);
  const ended = events.length ? events[events.length - 1].timestamp : (m.last || started);
  const t = (ts) => ts - started;
  const custom = (e) => e.type === CUSTOM && isObj(e.data) ? e.data : null;

  let viewport = null;
  const pages = [];
  const page = (ts, hash) => { if (!pages.length || pages[pages.length - 1].hash !== hash) pages.push({ t: t(ts), hash }); };
  const clicks = [], marks = [], taskEvents = [];
  const answers = []; // times the page changed: mutation, scroll, input, media, nav
  for (const e of events) {
    if (e.type === META && isObj(e.data)) {
      if (!viewport && num(e.data.width)) viewport = { w: e.data.width, h: e.data.height };
      page(e.timestamp, hashOf(e.data.href));
    } else if (e.type === INCREMENTAL && isObj(e.data)) {
      const s = e.data.source;
      if (s === MUTATION || s === SCROLL || s === INPUT || s === MEDIA) answers.push(e.timestamp);
    }
    const c = custom(e);
    if (!c) continue;
    const p = isObj(c.payload) ? c.payload : {};
    if (c.tag === 'click') {
      if (clicks.length >= MAX_CLICKS) continue;
      clicks.push({ ts: e.timestamp, t: t(e.timestamp), x: num(p.x) ? p.x : 0, y: num(p.y) ? p.y : 0, label: str(p.label, 80), tag: str(p.tag, 20),
        interactive: p.interactive === true, hash: str(p.hash, 200), path: str(p.path, 300), rage: false, dead: false });
      continue;
    }
    marks.push({ t: t(e.timestamp), name: String(c.tag), data: c.payload === undefined ? null : c.payload });
    if (c.tag === 'nav') { answers.push(e.timestamp); page(e.timestamp, str(p.hash, 200)); }
    if (c.tag === 'open') answers.push(e.timestamp);   // a new tab opened: an answer, just not on this page
    if (c.tag === 'task') taskEvents.push({ ts: e.timestamp, n: p.n, title: str(p.title, 200), state: p.state });
  }
  if (!viewport && m.meta && m.meta.w) viewport = { w: m.meta.w, h: m.meta.h };
  if (!pages.length && m.meta && m.meta.href) pages.push({ t: 0, hash: hashOf(m.meta.href) });

  // Rage: three or more clicks within RAGE_MS of the first and RAGE_PX of it.
  for (let i = 0; i < clicks.length; i++) {
    const run = [clicks[i]];
    for (let j = i + 1; j < clicks.length && j <= i + RAGE_LOOK && clicks[j].ts - clicks[i].ts <= RAGE_MS; j++) {
      if (Math.hypot(clicks[j].x - clicks[i].x, clicks[j].y - clicks[i].y) <= RAGE_PX) run.push(clicks[j]);
    }
    if (run.length >= RAGE_CLICKS) for (const c of run) c.rage = true;
  }
  // Dead: not on anything clickable, or nothing changed in the second after.
  // The window opens at the click, not the press: the dashboard hides its
  // tooltip on pointerdown, which would make every hovered click look live.
  const answered = (from, to) => {
    let lo = 0, hi = answers.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (answers[mid] < from) lo = mid + 1; else hi = mid; }
    return lo < answers.length && answers[lo] <= to;
  };
  for (const c of clicks) c.dead = !c.interactive || (!FIELDS.includes(c.tag) && !answered(c.ts, c.ts + DEAD_MS));

  // Tasks: a start opens one; its done/stuck/skip (or another task's start,
  // 'moved on') closes it. One left open at the end is 'unfinished'.
  const tasks = [];
  let open = null;
  const close = (ts, outcome) => { Object.assign(open, { end: t(ts), ms: ts - open.ts, outcome }); open = null; };
  for (const e of taskEvents) {
    if (e.state === 'start') {
      if (open && open.n === e.n) continue;
      if (open) close(e.ts, 'moved on');
      open = { n: e.n, title: e.title, ts: e.ts, start: t(e.ts), end: null, ms: null, outcome: null };
      tasks.push(open);
    } else if (['done', 'stuck', 'skip'].includes(e.state)) {
      if (open && open.n === e.n) close(e.ts, e.state);
      else tasks.push({ n: e.n, title: e.title, ts: e.ts, start: t(e.ts), end: t(e.ts), ms: 0, outcome: e.state });
    }
  }
  if (open) Object.assign(open, { ms: ended - open.ts, outcome: 'unfinished' });

  return {
    session: m.session || null, invite: m.invite || null, started, ended, ms: ended - started,
    viewport: viewport || { w: null, h: null }, pages,
    clicks: clicks.map(({ ts, ...c }) => c),
    tasks: tasks.map(({ ts, ...x }) => x),
    marks,
    counts: { clicks: clicks.length, rage: clicks.filter((c) => c.rage).length, dead: clicks.filter((c) => c.dead).length },
  };
}

module.exports = { createRecordings, summarise, SESSION, INVITE };
