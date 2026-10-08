'use strict';
const runtime = require('./runtime');
const jobsEnabled = () => runtime.connectorEnabled('todoRank');

// To-do ranking (5 Oct 2026): Home's to-do list in order of urgency, the way a
// sharp assistant would put it.
//
// A model (claude -p, no tools, structured output) reads Owner's own to-dos, the
// inbox to-dos from the morning brief, the next 72 hours of calendar, deadlines
// in the next 30 days, who Owner usually acts on (brief-learning.json) and a
// notes file Owner edits (data/todo-rank-notes.md: who's who, standing
// priorities). It returns every to-do once, most urgent first, each with an
// urgency (now / today / soon / later) and a short reason.
//
// The result is cached in data/todo-rank.json and rides along on the state
// stream as state.todoRank. It is recomputed in the background when the list
// changes (ids, titles, the notes file, the date) or an hour has passed: one
// run at a time, at most one every two minutes, 15 seconds after the last edit
// so a burst of edits makes one run. A failed run keeps the previous order.
//
// Routes (server.js):
//   GET  /api/todos/rank    what we have now: { at, running, error, items }
//   POST /api/todos/rank    rank again now, and answer when it's done

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { runClaudeCli } = require('./tell');
const { createSources } = require('./refresh');

const URGENCY = ['now', 'today', 'soon', 'later'];
const REASON_MAX = 70;
const STALE_MS = 60 * 60e3;
const MIN_GAP_MS = 2 * 60e3;
const ERROR_GAP_MS = 10 * 60e3;
const DEBOUNCE_MS = 15e3;
const TZ = 'Europe/London';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'urgency', 'reason'],
        properties: {
          id: { type: 'string', description: 'The ref from the list, e.g. T3 or I2' },
          urgency: { type: 'string', enum: URGENCY },
          reason: { type: 'string', description: `Under ${REASON_MAX} characters, to Owner, specific` },
        },
      },
    },
  },
};

const NOTES_TEMPLATE = `<!--
Notes for the to-do ranker. Meridian reads this file every time it puts your
Home to-dos in order, so write what a new assistant would need to know:

- who's who: your boss, clients, people whose asks come first or can wait
- standing priorities: e.g. "uni deadlines beat side projects in term time"
- anything to leave alone: e.g. "newsletters from X are never urgent"

Plain sentences are fine. This comment is not sent to the model.
-->
`;

const SYSTEM = `You put Owner's to-do list in order of urgency, the way a sharp personal assistant who knows their week would. You get every open to-do (refs T1… are Owner's own, I1… came in by email or Slack via the morning brief) plus the time, calendar, deadlines, who Owner usually acts on, and Owner's own notes. Return every ref exactly once, most urgent first.

How to judge:
- Time first. Anything tied to a meeting, class, deadline or departure in the calendar comes before that event; the closer the event, the higher. Travel changes everything: with a flight or train in the next few hours, packing and anything that must happen before leaving is "now" and desk work drops.
- People next. A real person asking Owner for something (a named human in email or Slack) outranks an automated notice from a service or system (product emails, alerts, reports, no-reply senders), unless the notice carries a hard date or something others rely on is broken. Asks from Owner's boss and clients outrank Owner's own nice-to-haves. Use Owner's notes for who's who; senders marked "raise" are people Owner reliably acts on. Never invent a relationship the notes or the data don't support.
- Then consequences: renewals, payments, broken things others rely on, anything that gets worse with waiting.
- Dates written in a to-do's note as a target ("for Monday", "before 9 October", "today") are real deadlines; compare them to now, and call a missed one overdue. But a bare date at the very start of a note ("Sunday 4 October 2026.") is only when it was written down, not a due date, and relative words in a note ("today", "tomorrow") count from that day or the added date, not from now.
- Only tie a to-do to an event or deadline when it is plainly about the same thing. Don't borrow a nearby deadline to make something look urgent.
- Chores and personal admin are "later" unless something in the context makes them pressing (a trip, guests, a deadline). Open-ended reminders to think, review or tinker are "later" too.
- Owner's own priority (now/next/later) is a hint, not a rule.

urgency: now = do it before anything else today, within the next couple of hours; today = before the day ends; soon = this week; later = no pressure yet.

reason: one line, aim for 60 characters and never more than ${REASON_MAX}, written to Owner ("you"), plain British English. Say the specific fact that sets its place: the person, the time, the event, the date, the consequence. Good: "Flight at 18:40, so pack before you leave", "Avery needs this before Thursday's launch", "Jordan asked on 21 Sep and it's still open", "Renews 9 Oct, so check seats by Wednesday", "You meant to send it today", "Nothing hangs on it this week". It must read as a natural sentence Owner could say aloud. Bad: anything that restates the title, rates it ("important", "high priority", "quick win"), guesses ("may", "might", "could"), or could fit any to-do. No refs (T1, I2), no ids, no full stop at the end.`;

const clean = (v, max = 400) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Clamp to max characters, cutting at a word where possible.
function clampReason(s, max = REASON_MAX) {
  const t = clean(s, 1000).replace(/\.$/, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, '') + '…';
}

// Dates and times as Owner's clock reads them, whatever the machine's zone.
const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts });
const F_DAY = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
const F_SAY = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const F_SAY_DAY = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const F_TIME = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const F_LONG = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function londonDay(ms) { const p = Object.fromEntries(F_DAY.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; }
const say = (ms) => F_SAY.format(new Date(ms)).replace(',', '');
const sayDay = (ms) => F_SAY_DAY.format(new Date(ms)).replace(',', '');
const when = (v) => { const ms = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(ms) ? say(ms) : ''; };

// Inbox to-dos, as Home's briefTodos() in public/command.js derives them.
function inboxTodos(state, now) {
  const fb = state.briefFeedback || {};
  const skipped = fb.skipped || {};
  // The browser hides today's skips by local date; the server files them by UTC date. Honour both.
  const days = new Set([londonDay(now), new Date(now).toISOString().slice(0, 10)]);
  const hidden = new Set([...(fb.completed || []), ...(fb.rejected || []), ...[...days].flatMap((d) => skipped[d] || [])]);
  const intake = new Map((((state.briefIntake || {}).items) || []).filter((i) => i.projectId).map((i) => [i.projectId, i]));
  const projects = (state.projects && state.projects.projects) || [];
  return projects.filter((c) => c.brief && c.status !== 'done' && !hidden.has('project:' + c.id)).map((p) => {
    const i = intake.get(p.id) || {};
    return {
      id: p.id, title: p.title, from: p.sourceFrom || i.from || '', source: p.source || i.source || 'meridian',
      receivedAt: p.sourceReceivedAt || i.receivedAt || p.updated || '',
      summary: i.request || i.summary || String(p.note || '').replace(/^[^\n]*\n(Received:[^\n]*\n)?\n?/, ''),
      priority: p.priority || 'normal',
    };
  });
}

function openTodos(state) {
  return (state.todos || []).filter((t) => t && !t.done).map((t) => ({ id: t.id, title: t.title, note: t.note || '', priority: t.priority || 'next', created: t.created || '' }));
}

// Everything that gets ranked, with the refs the model sees.
function rankables(state, now) {
  const own = openTodos(state).map((t, i) => ({ ref: 'T' + (i + 1), kind: 'todo', ...t }));
  const inbox = inboxTodos(state, now).map((t, i) => ({ ref: 'I' + (i + 1), kind: 'inbox', ...t }));
  return [...own, ...inbox];
}

function stripComments(md) { return String(md || '').replace(/<!--[\s\S]*?-->/g, '').trim(); }

function buildPrompt({ state, now, items, notes, learning }) {
  const L = [];
  L.push(`Now: ${F_LONG.format(new Date(now)).replace(/^(\w+),/, '$1').replace(' at ', ', ')} (Europe/London)`);

  L.push('', "Owner's own to-dos (priority is Owner's own label):");
  const own = items.filter((x) => x.kind === 'todo');
  for (const t of own) L.push(`${t.ref} · ${clean(t.title, 200)} · priority ${t.priority}${t.created ? ' · added ' + when(t.created) : ''}${t.note ? '\n   note: ' + clean(t.note, 300) : ''}`);
  if (!own.length) L.push('(none)');

  L.push('', 'Inbox to-dos (asks that came in by email or Slack):');
  const inbox = items.filter((x) => x.kind === 'inbox');
  for (const t of inbox) L.push(`${t.ref} · ${clean(t.title, 200)} · from ${clean(t.from, 60) || 'unknown'} via ${t.source}${t.receivedAt ? ' · received ' + when(t.receivedAt) : ''} · brief priority ${t.priority}${t.summary ? '\n   ask: ' + clean(t.summary, 300) : ''}`);
  if (!inbox.length) L.push('(none)');

  const until = now + 72 * 3600e3;
  const events = (((state.calendar || {}).events) || [])
    .filter((e) => e && Number.isFinite(e.ts) && (e.end || e.ts) >= now && e.ts <= until && e.response !== 'declined')
    .sort((a, b) => a.ts - b.ts).slice(0, 40);
  L.push('', 'Calendar, next 72 hours:');
  for (const e of events) {
    const time = e.allDay ? sayDay(e.ts) + ' all day' : say(e.ts) + (e.end ? '–' + F_TIME.format(new Date(e.end)) : '');
    L.push(`- ${time} · ${clean(e.title, 120)}${e.location ? ' · ' + clean(e.location, 80) : ''}${e.ts <= now ? ' (happening now)' : ''}`);
  }
  if (!events.length) L.push('(nothing)');

  const today = londonDay(now); const horizon = londonDay(now + 30 * 86400e3);
  const deadlines = (state.deadlines || []).filter((d) => d && !d.done && !d.archived && d.due && d.due <= horizon).slice(0, 30);
  L.push('', 'Deadlines, next 30 days:');
  for (const d of deadlines) L.push(`- ${d.due} (${sayDay(Date.parse(d.due + 'T12:00:00Z'))})${d.due < today ? ' (overdue)' : d.due === today ? ' (today)' : ''} · ${clean(d.title, 160)}${d.track ? ' (' + d.track + ')' : ''}${d.note ? ' · ' + clean(d.note, 160) : ''}`);
  if (!deadlines.length) L.push('(none)');

  const senders = ((learning && learning.senders) || []).filter((s) => s && s.weight && s.weight !== 'neutral').slice(0, 30);
  if (senders.length) {
    L.push('', 'Who Owner usually acts on (from past inbox outcomes):');
    for (const s of senders) L.push(`- ${clean(s.from, 60)}: ${s.weight}${Number.isFinite(s.decided) && s.decided ? ` (acted on ${s.acted} of ${s.decided})` : ''}`);
  }

  L.push('', "Owner's notes (who's who, standing priorities):", notes || '(none yet)');
  L.push('', `Rank all ${items.length} refs: ${items.map((x) => x.ref).join(', ')}.`);
  return L.join('\n');
}

// Keep what the model said for known refs, once each; anything it missed goes last.
function shapeResult(out, items) {
  const byRef = new Map(items.map((x) => [x.ref.toUpperCase(), x]));
  const byId = new Map(items.map((x) => [x.id, x]));
  const seen = new Set();
  const ranked = [];
  for (const r of (out && Array.isArray(out.items) ? out.items : [])) {
    if (!r) continue;
    const key = clean(r.id, 80);
    const it = byRef.get(key.toUpperCase()) || byId.get(key);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    ranked.push({ id: it.id, kind: it.kind, urgency: URGENCY.includes(r.urgency) ? r.urgency : 'later', reason: clampReason(r.reason) });
  }
  for (const it of items) if (!seen.has(it.id)) ranked.push({ id: it.id, kind: it.kind, urgency: 'later', reason: '' });
  return ranked;
}

function createRanker(deps) {
  const {
    dir, getState, now = () => Date.now(), model = () => 'sonnet', claudeBin = 'claude',
    runClaude: run = runClaudeCli, onChange = () => {}, sourceTimers,
    debounceMs = DEBOUNCE_MS, minGapMs = MIN_GAP_MS, errorGapMs = ERROR_GAP_MS, staleMs = STALE_MS,
  } = deps;
  const F = {
    cache: path.join(dir, 'todo-rank.json'),
    notes: path.join(dir, 'todo-rank-notes.md'),
    learning: path.join(dir, 'brief-learning.json'),
  };

  let cache = { version: 1, at: 0, sig: '', items: [], error: null };
  try { const j = JSON.parse(fs.readFileSync(F.cache, 'utf8')); if (j && Array.isArray(j.items)) cache = { ...cache, ...j }; } catch { /* first run */ }
  try { if (jobsEnabled() && !fs.existsSync(F.notes)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(F.notes, NOTES_TEMPLATE); } } catch (e) { console.error('todo-rank: could not create notes file', e.message); }

  let running = null;      // the run in progress
  let timer = null;        // a scheduled run
  let lastStart = 0;       // when the last run began
  let lastFailSig = null;  // the signature the last failed run was for
  let seenSig = null;      // the signature maybeRefresh last saw, for the debounce

  const sources = createSources({ now, timers: sourceTimers, onError: (_name, error) => { cache = { ...cache, error: { at: now(), message: clean(error.message || error, 300) } }; } });
  sources.observe('todoRank', { lastSuccess: cache.at || null, error: cache.error?.message || null, stale: Boolean(cache.at && cache.error) });

  function notesMtime() { try { return fs.statSync(F.notes).mtimeMs; } catch { return 0; } }
  function signature(state, at) {
    const items = rankables(state || {}, at).map((x) => `${x.id}\u0001${x.title}`).sort();
    return crypto.createHash('sha1').update(JSON.stringify([items, notesMtime(), londonDay(at)])).digest('hex');
  }

  function peek() { return { at: cache.at || null, running: !!running, error: cache.error || null, items: cache.items }; }

  async function save() {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${F.cache}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2) + '\n');
    await fsp.rename(tmp, F.cache);
  }

  async function compute() {
    const at = now();
    const state = getState() || {};
    const sig = signature(state, at);
    const items = rankables(state, at);
    if (!items.length) {
      cache = { version: 1, at, sig, items: [], error: null };
      await save().catch(() => {});
      return;
    }
    const notes = stripComments(await fsp.readFile(F.notes, 'utf8').catch(() => ''));
    const learning = await fsp.readFile(F.learning, 'utf8').then(JSON.parse).catch(() => null);
    const prompt = buildPrompt({ state, now: at, items, notes, learning });
    try {
      const out = await run({
        args: ['-p', '--model', model(), '--effort', 'low', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
          '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'],
        input: prompt, timeoutMs: 90000, cwd: dir, bin: claudeBin,
      });
      cache = { version: 1, at, sig, items: shapeResult(out, items), error: null };
      lastFailSig = null;
    } catch (e) {
      cache = { ...cache, error: { at, message: clean(e && e.message || e, 300) } };
      lastFailSig = sig;
    }
    await save().catch((e) => console.error('todo-rank: could not save', e.message));
  }

  // One run at a time; callers during a run share it.
  function start() {
    if (!jobsEnabled()) return Promise.resolve(peek());
    if (running) return running;
    lastStart = now();
    running = sources.collect('todoRank', async () => { await compute(); return peek(); }, { deadline: lastStart + 92000, fallback: peek(), retained: Boolean(cache.at), describe: value => ({ error: value.error?.message || null, stale: Boolean(value.error && cache.at) }) }).finally(() => { running = null; try { onChange(peek()); } catch { /* not ours */ } });
    return running;
  }

  function needed(sig, at) {
    if (sig !== cache.sig) return lastFailSig !== sig || at - lastStart >= errorGapMs;
    return at - (cache.at || 0) >= staleMs;
  }

  function schedule(delay) {
    if (!jobsEnabled()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, delay));
    if (timer.unref) timer.unref();
  }

  function fire() {
    timer = null;
    const at = now();
    if (running) { running.then(() => maybeRefresh()); return; }
    const gap = (lastFailSig ? errorGapMs : minGapMs) - (at - lastStart);
    if (lastStart && gap > 0) { schedule(gap); return; }
    if (!needed(signature(getState() || {}, at), at)) return;
    start();
  }

  // Cheap: work out whether a run is due and schedule it. Never throws.
  function maybeRefresh() {
    try {
      const at = now();
      const sig = signature(getState() || {}, at);
      if (!needed(sig, at)) { seenSig = sig; return; }
      const changed = sig !== seenSig;
      seenSig = sig;
      if (running) { running.then(() => maybeRefresh()); return; }
      if (changed || !timer) schedule(changed && sig !== cache.sig ? debounceMs : 0);
    } catch (e) { console.error('todo-rank: maybeRefresh', e.message); }
  }

  // Rank now (still one at a time) and resolve with the result.
  async function refresh() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (running) await running;
    await start();
    return peek();
  }

  function stop() { if (timer) clearTimeout(timer); timer = null; }
  return { peek, maybeRefresh, refresh, stop, source: () => sources.snapshot().todoRank, files: F };
}

module.exports = { createRanker, SCHEMA, SYSTEM, buildPrompt, shapeResult, clampReason, inboxTodos, rankables, londonDay, NOTES_TEMPLATE };
