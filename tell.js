'use strict';
const runtime = require('./runtime');
const jobsEnabled = () => runtime.connectorEnabled('tell');

// Tell (4 Oct 2026): one box for anything Owner wants changed.
//
// Owner types or dictates a paragraph (Wispr Flow, the Action Button, the phone's
// Tell sheet). A planner (claude -p, no tools, structured output) turns it into a
// short list of actions from a fixed menu below. Owner unticks what they don't
// want, answers the one question it couldn't guess, and Meridian makes the
// changes. Every change comes back as a receipt with its own Undo.
//
// What happens without asking is a trust setting per group (data/tell-settings.json).
// Defaults follow /design/mobile: to-dos, reminders, deadlines, money notes,
// inbox notes and drafts just happen; calendar changes and Meridian fixes wait
// for a tick. Anything that would speak for Owner is only ever a draft.
//
// Outlook calendar changes run as a second claude -p with only the Microsoft 365
// calendar tools allowed. Google events can't be written from here, so a new
// personal event becomes an .ics the phone adds with one tap.
//
// Also here, because Tell is what creates them: reminders (pinged through
// ntfy at their time) and soul.md, the file that sets how Meridian talks.
//
// Routes:
//   POST /api/tell {text, via, mode:'review'|'auto', wait}   plan it (auto: also do the trusted parts)
//   POST /api/tell {actions:[…], via}                        a direct action from a button (Accept)
//   GET  /api/tell?limit=20, GET /api/tell/:id
//   POST /api/tell/:id/apply {picks:[{i, on, choice, title}]}
//   POST /api/tell/:id/undo {i}
//   DELETE /api/tell/:id                                     put a plan away without doing it
//   GET  /api/tell/:id/event/:i.ics                          a personal event for the phone's calendar
//   GET/PUT /api/tell/settings                               trust per group
//   GET/PUT /api/soul {text, why}                            soul.md and its history
//   GET  /api/reminders, DELETE /api/reminders/:id, POST /api/reminders/:id/snooze {minutes}

const { spawn } = require('child_process');
const { capProcess, workContext } = require('./process-runner');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const KINDS = {
  'todo.add': { group: 'todo', icon: 'todo' },
  'todo.done': { group: 'todo', icon: 'todo' },
  'todo.edit': { group: 'todo', icon: 'todo' },
  'todo.remove': { group: 'todo', icon: 'todo', ask: true },
  remind: { group: 'remind', icon: 'bell' },
  'deadline.add': { group: 'deadline', icon: 'flag' },
  'money.note': { group: 'money', icon: 'pound' },
  'calendar.add': { group: 'calendar', icon: 'cal' },
  'calendar.move': { group: 'calendar', icon: 'cal' },
  'calendar.respond': { group: 'calendar', icon: 'cal' },
  'calendar.remove': { group: 'calendar', icon: 'cal', ask: true },
  draft: { group: 'draft', icon: 'mail' },
  fix: { group: 'fix', icon: 'fix' },
  capture: { group: 'note', icon: 'note' },
  'soul.edit': { group: 'soul', icon: 'soul' },
};
const GROUPS = ['todo', 'remind', 'deadline', 'money', 'note', 'draft', 'soul', 'calendar', 'fix'];
const DEFAULT_TRUST = { todo: true, remind: true, deadline: true, money: true, note: true, draft: true, soul: true, calendar: false, fix: false };
const UNDO_MS = 24 * 3600e3;
const KEEP = 150;
const M365 = 'mcp__claude_ai_Microsoft_365__';
const CAL_TOOLS = ['outlook_calendar_search', 'outlook_create_event', 'outlook_update_event', 'outlook_delete_event', 'outlook_respond_to_event', 'search_people'].map((t) => M365 + t);

const clean = (v, max = 400) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Meridian runs on a Mac set to Europe/London, so local time is Owner's time.
const localStamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const say = (ms) => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0);
  // Date normalises impossible days and DST gaps; don't schedule a different time.
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3] || d.getHours() !== (m[4] ? +m[4] : 9) || d.getMinutes() !== (m[5] ? +m[5] : 0)) return null;
  return d.getTime();
}
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------------------------------------------------------------- the planner's contract

const FIELDS = {
  text: { type: 'string', description: 'The to-do, reminder, note, draft body, fix request or soul lines to add' },
  note: { type: 'string' },
  priority: { type: 'string', enum: ['now', 'next', 'later', ''] },
  start: { type: 'string', description: 'Local Europe/London YYYY-MM-DDTHH:MM' },
  end: { type: 'string', description: 'Local Europe/London YYYY-MM-DDTHH:MM' },
  at: { type: 'string', description: 'Reminder time, local YYYY-MM-DDTHH:MM' },
  due: { type: 'string', description: 'YYYY-MM-DD' },
  track: { type: 'string', enum: ['work', 'uni', 'personal', ''] },
  calendar: { type: 'string', enum: ['outlook', 'phone', ''] },
  where: { type: 'string' },
  people: { type: 'array', items: { type: 'string' } },
  response: { type: 'string', enum: ['accept', 'tentative', 'decline', ''] },
  channel: { type: 'string', enum: ['email', 'slack', 'text', ''] },
  to: { type: 'string' },
  subject: { type: 'string' },
  amount: { type: 'number' },
  date: { type: 'string', description: 'YYYY-MM-DD' },
  label: { type: 'string' },
  remove: { type: 'string', description: 'soul.edit only: lines to take out, verbatim, one per line' },
};
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One or two short sentences to Owner, in the soul.md voice. Answers the question if there was one.' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: Object.keys(KINDS) },
          title: { type: 'string', description: 'The card line, e.g. "Move Gym work to Friday"' },
          detail: { type: 'string', description: 'Second line, e.g. "Thu 8 17:30 → Fri 9 18:00"' },
          ref: { type: 'string', description: 'T#, E#, I# or D# from the context when acting on something that exists, else empty' },
          ...FIELDS,
          ask: {
            type: 'object',
            description: 'Only when you cannot make a sensible guess. Most likely answer first.',
            properties: {
              q: { type: 'string' },
              options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, set: { type: 'object', properties: FIELDS } }, required: ['label'] } },
            },
            required: ['q', 'options'],
          },
        },
        required: ['kind', 'title'],
      },
    },
  },
  required: ['reply', 'actions'],
};

const PLANNER_RULES = `You are Meridian's Tell planner. Owner (they/them) brain-dumps, often by dictation, anything they want changed. Turn it into a short plan using only the action kinds in the schema. You never do anything yourself: Meridian shows the plan, Owner ticks it, Meridian does it.

Kinds:
- todo.add (text, note, priority) · todo.done (ref T#) · todo.edit (ref T#, text and/or note/priority) · todo.remove (ref T#)
- remind (text, at, optional ref T# when it's about an existing to-do): a ping on Owner's phone at that time
- deadline.add (text, due, track)
- money.note (amount in GBP, date, label, text): notes a spend or an expense for the Money tab. Doesn't move money.
- calendar.add (text = event title, start, end, where, calendar, people) · calendar.move (ref E#, start, end) · calendar.respond (ref E# or I#, response) · calendar.remove (ref E#)
- draft (channel, to, subject, text): any message to another person. Never send anything.
- fix (text): only when Owner wants Meridian itself (this app) changed. Text is the request as Owner put it.
- capture (text): a thought to keep that isn't a task, saved as a note (in Stash, where Owner keeps his thoughts).
- soul.edit (text = lines to add, remove = lines to take out): only when Owner wants to change how Meridian talks or behaves.

Rules:
- One action per change, so each can be unticked and undone on its own.
- Use refs from the context for things that already exist. Never invent a ref.
- Don't duplicate. If a to-do already exists, use its ref (todo.edit, remind) and say so in detail.
- Times are Europe/London, YYYY-MM-DDTHH:MM, resolved against "Now". "Six" for the gym or drinks means 18:00. Events with no end last an hour, drinks two.
- calendar: "outlook" for work (Example Agency, colleagues, Teams), "phone" for personal. Only events marked [outlook] can be moved, answered or removed. To move a personal event, add the new time with calendar "phone" and say in detail that the old one needs deleting by hand.
- If another person is involved and it isn't clear whether to invite them, ask (e.g. "Invite Sam, or just block the time?") with "Just block it" first.
- Ask at most one question per action, only when a sensible guess isn't possible. Each option's set holds the fields that change.
- title is the card's line, short and plain. detail is the specifics in under 70 characters; for a move write "old → new".
- Refs (T4, E2…) are for you. Never write one in title, detail or reply; use the thing's name.
- money.note: label is the kind of spend as Owner would file it ("Work expense, claimable", "Groceries"), text is what it was ("Lunch").
- If Owner asks a question, answer it in reply from the context, with no actions.
- reply: first person, one or two short sentences, in the voice from soul.md.`;

function contextFor(state, now) {
  const refs = {};
  const lines = [];
  const n = new Date(now);
  lines.push(`Now: ${DAYS[n.getDay()]} ${localStamp(now).replace('T', ' ')} (Europe/London)`);
  const todos = (state.todos || []).filter((t) => !t.done).slice(0, 60);
  lines.push('', 'Open to-dos:');
  todos.forEach((t, i) => { const k = 'T' + (i + 1); refs[k] = { type: 'todo', id: t.id, title: t.title }; lines.push(`${k} · ${t.title}${t.priority === 'now' ? ' (now)' : ''}${t.note ? ' · ' + clean(t.note, 120) : ''}`); });
  if (!todos.length) lines.push('(none)');
  const until = now + 21 * 86400e3;
  const events = ((state.calendar && state.calendar.events) || []).filter((e) => (e.end || e.ts) >= now - 3600e3 && e.ts <= until && e.response !== 'declined').slice(0, 70);
  lines.push('', 'Calendar, next three weeks:');
  events.forEach((e, i) => {
    const k = 'E' + (i + 1);
    const outlook = e.cal === 'Outlook' || e.joinFrom === 'outlook';
    refs[k] = { type: 'event', title: e.title, ts: e.ts, end: e.end, cal: e.cal, uid: e.uid || null, outlookId: e.outlookId || null, outlook, allDay: !!e.allDay, where: e.location || '' };
    lines.push(`${k} · ${e.allDay ? say(e.ts).slice(0, -6) + ' all day' : say(e.ts) + (e.end ? '–' + localStamp(e.end).slice(11) : '')} · ${clean(e.title, 120)}${outlook ? ' [outlook]' : ' [' + (e.calendar || e.cal || 'calendar') + ']'}${e.response === 'needsAction' ? ' (not answered)' : ''}${e.recurring ? ' (repeats)' : ''}`);
  });
  if (!events.length) lines.push('(nothing)');
  const invites = (state.invites || []).filter((i) => !i.inCalendar).slice(0, 20);
  if (invites.length) {
    lines.push('', 'Invites waiting for an answer:');
    invites.forEach((v, i) => { const k = 'I' + (i + 1); const ts = Date.parse(v.start); refs[k] = { type: 'invite', title: v.title, ts, end: Date.parse(v.end) || null, outlook: v.source !== 'ics' || v.cal === 'Outlook', organizer: v.organizer || '', id: v.id }; lines.push(`${k} · ${Number.isFinite(ts) ? say(ts) : v.start} · ${clean(v.title, 120)}${v.organizer ? ' · from ' + clean(v.organizer, 60) : ''}`); });
  }
  const deadlines = (state.deadlines || []).filter((d) => !d.done && !d.archived && !d.fromCalendar).slice(0, 30);
  if (deadlines.length) {
    lines.push('', 'Deadlines:');
    deadlines.forEach((d, i) => { const k = 'D' + (i + 1); refs[k] = { type: 'deadline', id: d.id, title: d.title }; lines.push(`${k} · ${d.due} · ${d.title} (${d.track})`); });
  }
  return { text: lines.join('\n'), refs };
}

// ---------------------------------------------------------------- running claude

// launchd's PATH doesn't include ~/.local/bin, so the server passes the full path.
function runClaudeCli({ args, input, timeoutMs = 120000, cwd, bin = 'claude', spawnChild = spawn, timers, kill, signal = workContext.getStore()?.signal, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('the agent took too long', 504));
    const child = spawnChild(bin, args, { detached: process.platform !== 'win32', cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'meridian-tell' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', failure = null, bytes = 0;
    const stop = capProcess(child, { timeout: timeoutMs, detached: true, timers, kill,
      onTimeout: () => { failure = fail('the agent took too long', 504); } });
    const abort = () => { failure = fail('the agent took too long', 504); stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const append = (chunk, stderr) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { failure = fail('the agent output was too large', 502); stop(); return; }
      if (stderr) err += chunk; else out += chunk;
    };
    child.stdout.on('data', c => append(c, false));
    child.stderr.on('data', c => append(c, true));
    child.stdin.on('error', error => { failure = error; stop(); });
    child.on('error', error => { failure = error; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      let j = null; try { j = JSON.parse(out); } catch { /* not JSON */ }
      if (!j) return reject(fail(clean(err || out || `claude exited ${code}`, 300), 502));
      if (j.is_error) return reject(fail(clean(j.result || 'the agent failed', 300), 502));
      resolve(j.structured_output || (() => { try { return JSON.parse(j.result); } catch { return null; } })() || {});
    });
    child.stdin.end(input);
  });
}

// ---------------------------------------------------------------- the module

function createTell(deps) {
  const {
    dir, getState, todos, drafts, captures, notify = async () => false,
    addDeadline, removeDeadline, moneyNotes, startFix, refresh = () => {},
    soulDefault = '', now = () => Date.now(), runClaude: run = runClaudeCli, model = () => 'sonnet', phoneUrl = () => '/phone', claudeBin = 'claude',
  } = deps;
  const runClaude = (opts) => run({ ...opts, bin: claudeBin });
  const origin = () => { try { return new URL(phoneUrl()).origin; } catch { return ''; } };
  const F = {
    tells: path.join(dir, 'tell.json'),
    settings: path.join(dir, 'tell-settings.json'),
    reminders: path.join(dir, 'reminders.json'),
    soul: path.join(dir, 'soul.md'),
    soulHistory: path.join(dir, 'soul-history.json'),
  };
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };
  const waiters = new Map();

  async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; } }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
    await fsp.rename(tmp, file);
  }
  const readTells = async () => { const j = await readJson(F.tells, null); return Array.isArray(j?.tells) ? j.tells : []; };
  const writeTells = (list) => writeJson(F.tells, { version: 1, tells: list.slice(0, KEEP) });

  // Read-modify-write one tell, in order with every other write.
  function change(id, fn) {
    return serial(async () => {
      const list = await readTells();
      const t = list.find((x) => x.id === id);
      if (!t) throw fail('no such plan', 404);
      await fn(t);
      t.updated = new Date(now()).toISOString();
      await writeTells(list);
      for (const w of waiters.get(id) || []) w(t);
      return t;
    });
  }
  async function recent(limit = 20) { return (await readTells()).filter((t) => t.status !== 'discarded').slice(0, limit); }
  async function get(id) { const t = (await readTells()).find((x) => x.id === id); if (!t) throw fail('no such plan', 404); return t; }

  async function settings() {
    const s = await readJson(F.settings, {});
    return { trust: { ...DEFAULT_TRUST, ...(s.trust || {}) } };
  }
  async function saveSettings(patch) {
    const cur = await settings();
    for (const g of GROUPS) if (patch?.trust && g in patch.trust) cur.trust[g] = Boolean(patch.trust[g]);
    await writeJson(F.settings, cur);
    return cur;
  }

  // ---- soul.md
  async function soul() {
    let text;
    try { text = await fsp.readFile(F.soul, 'utf8'); } catch { text = soulDefault; }
    const history = await readJson(F.soulHistory, []);
    return { text, history: Array.isArray(history) ? history.slice(-30).reverse() : [] };
  }
  function soulDiff(before, after) {
    const a = before.split('\n').map((l) => l.trim()).filter(Boolean); const b = after.split('\n').map((l) => l.trim()).filter(Boolean);
    return { added: b.filter((l) => !a.includes(l)).slice(0, 20), removed: a.filter((l) => !b.includes(l)).slice(0, 20) };
  }
  async function saveSoul(text, { by = 'Owner', why = '' } = {}) {
    const next = String(text ?? '').replace(/\r\n/g, '\n').slice(0, 20000);
    const { text: before } = await soul();
    if (next === before) return soul();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(F.soul, next);
    const history = await readJson(F.soulHistory, []);
    const entry = { at: new Date(now()).toISOString(), by: clean(by, 40), why: clean(why, 300), ...soulDiff(before, next), before };
    await writeJson(F.soulHistory, [...(Array.isArray(history) ? history : []), entry].slice(-60));
    return soul();
  }

  // ---- reminders
  const readReminders = async () => { const j = await readJson(F.reminders, []); return Array.isArray(j) ? j : []; };
  async function addReminder(r) {
    return serial(async () => {
      const list = await readReminders();
      const item = { id: crypto.randomBytes(5).toString('hex'), text: clean(r.text, 200), at: r.at, todoId: r.todoId || null, tellId: r.tellId || null, created: new Date(now()).toISOString(), sent: null };
      list.push(item); await writeJson(F.reminders, list.slice(-300));
      return item;
    });
  }
  async function snoozeReminder(id, mins = 60) {
    const r = (await readReminders()).find((x) => x.id === id);
    if (!r) throw fail('no such reminder', 404);
    return addReminder({ text: r.text, at: now() + Math.min(Math.max(Number(mins) || 60, 5), 24 * 60) * 60000, todoId: r.todoId, tellId: r.tellId });
  }
  async function removeReminder(id) {
    return serial(async () => { const list = await readReminders(); const next = list.filter((r) => r.id !== id); await writeJson(F.reminders, next); return next.length !== list.length; });
  }
  // Due reminders go out once. One that was missed by more than 12 hours (the
  // Mac was asleep) is marked missed rather than pinging out of nowhere.
  async function tickReminders() {
    const due = await serial(async () => {
      const list = await readReminders(); const t = now(); const out = [];
      for (const r of list) {
        if (r.sent || r.at > t) continue;
        if (t - r.at > 12 * 3600e3) { r.sent = 'missed'; continue; }
        r.sent = new Date(t).toISOString(); out.push(r);
      }
      if (out.length || list.some((r) => r.sent === 'missed')) await writeJson(F.reminders, list.filter((r) => !r.sent || Date.parse(r.sent) > t - 14 * 86400e3 || r.sent === 'missed' && r.at > t - 14 * 86400e3));
      return out;
    });
    for (const r of due) {
      const actions = [{ action: 'http', label: 'In an hour', url: origin() + `/api/reminders/${r.id}/snooze`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"minutes":60}', clear: true }];
      if (r.todoId) actions.unshift({ action: 'http', label: 'Done', url: origin() + `/api/todos/${r.todoId}`, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"done":true}', clear: true });
      await notify(r.text, r.todoId ? 'Reminder · on your to-do list' : 'Reminder', { tags: ['bell'], priority: 4, click: phoneUrl(), event: 'reminder', actions }).catch(() => {});
    }
    return due;
  }

  // ---- planning
  async function soulText() { return (await soul()).text; }
  async function plan(text, refsHint) {
    const ctx = contextFor(getState() || {}, now());
    const system = `${PLANNER_RULES}\n\n---\nsoul.md (Meridian's voice):\n${await soulText()}`;
    const prompt = `${ctx.text}\n\n---\nOwner said${refsHint ? ' (' + refsHint + ')' : ''}:\n${text}`;
    const out = await runClaude({
      args: ['-p', '--model', model(), '--effort', 'low', '--output-format', 'json', '--json-schema', JSON.stringify(PLAN_SCHEMA),
        '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'],
      input: prompt, timeoutMs: 90000, cwd: dir,
    });
    return { reply: clean(out.reply, 600), actions: (Array.isArray(out.actions) ? out.actions : []).slice(0, 20), refs: ctx.refs };
  }

  // Keep only what the planner is allowed to say, and attach what a ref points at.
  function shapeAction(a, refs, trust) {
    const kind = KINDS[a.kind] ? a.kind : null;
    if (!kind) return null;
    const x = { kind, group: KINDS[kind].group, icon: KINDS[kind].icon, title: clean(a.title, 160) || kind, detail: clean(a.detail, 300) };
    for (const k of Object.keys(FIELDS)) {
      if (a[k] === undefined || a[k] === null || a[k] === '') continue;
      if (k === 'people') x.people = (Array.isArray(a.people) ? a.people : []).map((p) => clean(p, 60)).filter(Boolean).slice(0, 10);
      else if (k === 'amount') { const v = Number(a.amount); if (Number.isFinite(v)) x.amount = Math.round(v * 100) / 100; }
      else x[k] = clean(a[k], k === 'text' ? 4000 : 300);
    }
    const ref = clean(a.ref, 8).toUpperCase();
    if (ref && refs[ref]) x.target = refs[ref];
    else if (/^(todo\.(done|edit|remove)|calendar\.(move|respond|remove))$/.test(kind)) return null; // nothing to act on
    if (a.ask && clean(a.ask.q) && Array.isArray(a.ask.options) && a.ask.options.length) {
      x.ask = { q: clean(a.ask.q, 200), options: a.ask.options.slice(0, 4).map((o) => ({ label: clean(o.label, 80), set: o.set && typeof o.set === 'object' ? o.set : {} })).filter((o) => o.label) };
      x.choice = 0;
    }
    // Calendar writes need a tick unless Owner trusts them; anything with other people in it always does.
    const involvesOthers = (x.people || []).length > 0 && kind.startsWith('calendar.');
    x.confirm = !trust[x.group] || KINDS[kind].ask === true || involvesOthers;
    x.state = 'planned';
    x.on = true;
    return x;
  }

  async function create(body, { onPlanned } = {}) {
    const text = clean(body.text, 8000);
    const direct = Array.isArray(body.actions) && body.actions.length;
    if (!text && !direct) throw fail('say what you want changed');
    const t = {
      id: crypto.randomBytes(6).toString('hex'), text, via: clean(body.via, 30) || 'phone', mode: body.mode === 'auto' ? 'auto' : 'review',
      created: new Date(now()).toISOString(), status: direct ? 'ready' : 'planning', reply: '', actions: [], error: null,
    };
    if (direct) {
      // A button that already knows what it wants (Accept on an invite). Still goes through apply, so it gets a receipt.
      const { trust } = await settings();
      const state = getState() || {};
      t.actions = body.actions.slice(0, 5).map((a) => shapeAction(a, directRefs(a, state), trust)).filter(Boolean);
      t.text = t.text || t.actions.map((a) => a.title).join(', ');
      t.mode = 'auto';
      if (!t.actions.length) throw fail('nothing to do');
      for (const a of t.actions) a.confirm = false;
    }
    await serial(async () => { const list = await readTells(); list.unshift(t); await writeTells(list); });
    if (direct) return apply(t.id, {});
    const job = (async () => {
      try {
        const { trust } = await settings();
        const p = await plan(text);
        await change(t.id, (x) => {
          x.reply = p.reply;
          x.actions = p.actions.map((a) => shapeAction(a, p.refs, trust)).filter(Boolean);
          x.status = 'ready';
        });
        if (t.mode === 'auto') await autoApply(t.id);
      } catch (e) {
        await change(t.id, (x) => { x.status = 'failed'; x.error = clean(e.message, 300); }).catch(() => {});
        // From the Action Button nobody is looking at a screen, so keep the words safe as a note.
        if (t.mode === 'auto' && captures) {
          try { await captures.capture(`Tell (couldn't plan it: ${clean(e.message, 120)})\n\n${text}`); await notify('Saved, not done', 'I couldn\'t plan that, so it\'s saved as a note, as you said it.', { tags: ['warning'], event: 'tell', click: phoneUrl() }); } catch { /* nothing more to do */ }
        }
      }
      onPlanned?.();
    })();
    if (body.wait) await Promise.race([job, new Promise((r) => setTimeout(r, Math.min(Number(body.wait) || 60000, 90000)))]);
    return get(t.id);
  }

  function directRefs(a, state) {
    const refs = {};
    if (a.ref && a.target) refs[clean(a.ref, 8).toUpperCase()] = a.target;
    if (a.invite) {
      const v = (state.invites || []).find((i) => i.id === a.invite);
      if (v) { refs.I1 = { type: 'invite', title: v.title, ts: Date.parse(v.start), end: Date.parse(v.end) || null, outlook: v.source !== 'ics' || v.cal === 'Outlook', organizer: v.organizer || '', id: v.id }; a.ref = 'I1'; }
    }
    if (a.event) {
      const e = ((state.calendar && state.calendar.events) || []).find((x) => x.id === a.event || x.uid === a.event);
      if (e) { refs.E1 = { type: 'event', title: e.title, ts: e.ts, end: e.end, cal: e.cal, uid: e.uid || null, outlookId: e.outlookId || null, outlook: e.cal === 'Outlook' || e.joinFrom === 'outlook' }; a.ref = 'E1'; }
    }
    if (a.todo) { const td = (state.todos || []).find((x) => x.id === a.todo); if (td) { refs.T1 = { type: 'todo', id: td.id, title: td.title }; a.ref = 'T1'; } }
    return refs;
  }

  // Action Button and "Do it later": do what's trusted now, leave the rest for a tick.
  async function autoApply(id) {
    const t = await get(id);
    const picks = t.actions.map((a, i) => ({ i, on: !a.confirm }));
    const done = await apply(id, { picks, partial: true });
    const did = done.actions.filter((a) => a.state === 'done');
    const waiting = done.actions.filter((a) => a.state === 'planned');
    const failed = done.actions.filter((a) => a.state === 'failed');
    if (did.length || waiting.length || failed.length) {
      const parts = [];
      if (did.length) parts.push('Done: ' + did.map((a) => a.title).join(', ') + '.');
      if (waiting.length) parts.push(`${waiting.length === 1 ? waiting[0].title + ' needs' : waiting.length + ' things need'} a tick in Meridian.`);
      if (failed.length) parts.push(`${failed.length} didn't work.`);
      // "Do it" on the notification itself: the ntfy app posts straight back to Meridian over Tailscale.
      const actions = waiting.length ? [
        { action: 'http', label: waiting.length === 1 ? 'Do it' : `Do all ${waiting.length}`, url: origin() + `/api/tell/${id}/apply`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picks: done.actions.map((a, i) => ({ i, on: a.state === 'planned' })).filter((p) => p.on) }), clear: true },
        { action: 'view', label: 'Look first', url: phoneUrl() + '#tell=' + id },
      ] : null;
      await notify(waiting.length ? 'Meridian needs a tick' : 'Meridian', parts.join(' '), { tags: [waiting.length ? 'raised_hand' : 'white_check_mark'], event: waiting.length ? 'needs' : 'tell', click: phoneUrl() + '#tell=' + id, actions }).catch(() => {});
    } else if (done.reply) {
      await notify('Meridian', done.reply, { tags: ['speech_balloon'], event: 'tell', click: phoneUrl() }).catch(() => {});
    }
    return done;
  }

  // ---- applying
  async function apply(id, { picks = [], partial = false } = {}) {
    const t = await get(id);
    if (t.status === 'planning') throw fail('still planning', 409);
    if (t.status === 'discarded') throw fail('that plan was put away', 409);
    if (t.status === 'failed') throw fail('there was no plan to do', 409);
    const byIndex = new Map((Array.isArray(picks) ? picks : []).map((p) => [Number(p.i), p]));
    const todo = [];
    await change(id, (x) => {
      x.actions.forEach((a, i) => {
        if (a.state !== 'planned') return;
        const p = byIndex.get(i);
        if (p && p.title) a.title = clean(p.title, 160);
        if (p && Number.isInteger(p.choice) && a.ask && a.ask.options[p.choice]) a.choice = p.choice;
        const on = p ? p.on !== false : !partial && a.on !== false;
        if (on) { a.state = 'doing'; todo.push(i); } else if (!partial) a.state = 'skipped';
      });
      x.status = 'applying';
    });
    // Local changes are quick and happen in order; calendar ones run an agent each, side by side.
    const slow = [];
    for (const i of todo) {
      const a = (await get(id)).actions[i];
      const run = doAction(t, a, i).then(
        (r) => change(id, (x) => { Object.assign(x.actions[i], { state: 'done', result: r.result, undo: r.undo || null, link: r.link || null, at: new Date(now()).toISOString() }); }),
        (e) => change(id, (x) => { Object.assign(x.actions[i], { state: 'failed', result: clean(e.message, 240) }); }),
      );
      if (needsAgent(a)) slow.push(run); else await run;
    }
    const finish = () => change(id, (x) => {
      const busy = x.actions.some((a) => a.state === 'doing');
      x.status = busy ? 'applying' : x.actions.some((a) => a.state === 'planned') ? 'ready' : 'done';
      x.receipt = receipt(x);
    });
    await finish();
    refresh();
    if (slow.length) Promise.allSettled(slow).then(finish).then(() => refresh()).catch(() => {});
    return get(id);
  }

  // Outlook changes and Meridian fixes take a while, so they finish in the background.
  function needsAgent(a) {
    if (a.group === 'fix') return true;
    if (a.group !== 'calendar') return false;
    const set = a.ask && a.ask.options[a.choice || 0] ? cleanSet(a.ask.options[a.choice || 0].set) : {};
    return !(a.kind === 'calendar.add' && (set.calendar || a.calendar) !== 'outlook');
  }

  function receipt(t) {
    const did = t.actions.filter((a) => a.state === 'done').length;
    const bad = t.actions.filter((a) => a.state === 'failed').length;
    const busy = t.actions.filter((a) => a.state === 'doing').length;
    const parts = [];
    if (did) parts.push(`${did} change${did === 1 ? '' : 's'} made`);
    if (busy) parts.push(`${busy} still going`);
    if (bad) parts.push(`${bad} didn't work`);
    return parts.join(' · ');
  }

  // Applies the chosen answer to a question, then does the thing.
  async function doAction(t, a0, i) {
    const a = { ...a0, ...(a0.ask && a0.ask.options[a0.choice || 0] ? cleanSet(a0.ask.options[a0.choice || 0].set) : {}) };
    const target = a.target || {};
    switch (a.kind) {
      case 'todo.add': {
        const item = await todos.create({ title: a.text || a.title, note: a.note || '', priority: a.priority || undefined });
        return { result: 'Added to your to-dos', undo: { todoId: item.id } };
      }
      case 'todo.done': {
        const item = await todos.update(target.id, { done: true });
        if (!item) throw fail('that to-do has gone');
        return { result: 'Ticked off', undo: { todoId: target.id } };
      }
      case 'todo.edit': {
        const cur = ((await todos.read()).todos || []).find((x) => x.id === target.id);
        if (!cur) throw fail('that to-do has gone');
        const patch = {};
        if (a.text) patch.title = a.text;
        if (a.note) patch.note = a.note;
        if (a.priority) patch.priority = a.priority;
        await todos.update(target.id, patch);
        return { result: 'Updated', undo: { todoId: target.id, before: { title: cur.title, note: cur.note, priority: cur.priority } } };
      }
      case 'todo.remove': {
        const cur = ((await todos.read()).todos || []).find((x) => x.id === target.id);
        if (!cur) throw fail('that to-do has gone');
        await todos.remove(target.id);
        return { result: 'Removed', undo: { restore: { title: cur.title, note: cur.note, priority: cur.priority, area: cur.area } } };
      }
      case 'remind': {
        const at = parseLocal(a.at);
        if (!at) throw fail('no time for the reminder');
        if (at < now() - 60000) throw fail('that time has passed');
        const r = await addReminder({ text: a.text || a.title, at, todoId: target.type === 'todo' ? target.id : null, tellId: t.id });
        return { result: `I'll ping you ${say(at)}`, undo: { reminderId: r.id } };
      }
      case 'deadline.add': {
        if (!isDay(a.due)) throw fail('no date for the deadline');
        const item = await addDeadline({ title: a.text || a.title, due: a.due, track: a.track || 'personal', note: a.note || '' });
        return { result: 'Added to Deadlines', undo: { deadlineId: item.id } };
      }
      case 'money.note': {
        const day = isDay(a.date) ? a.date : localStamp(now()).slice(0, 10);
        const words = [a.amount != null ? `£${a.amount.toFixed(2)}` : '', a.text || a.title, a.label ? `(${a.label})` : ''].filter(Boolean).join(' ');
        const id = await moneyNotes.add({ text: words, from: day, to: day });
        return { result: 'Noted in Money', undo: { moneyNoteId: id } };
      }
      case 'capture': {
        const c = await captures.capture(a.text || a.title);
        return { result: c.label || 'Saved as a note', undo: { captureId: c.id } };
      }
      case 'draft': {
        const kind = a.channel === 'slack' ? 'slack' : a.channel === 'text' ? 'text' : 'email';
        const d = await drafts.create({ kind, to: a.to || (a.people || []).join(', '), subject: a.subject || '', body: a.text || '', title: a.title }, 'Meridian');
        return { result: 'Draft ready for you to read. Nothing is sent', undo: { draftId: d.id }, link: '/draft?id=' + d.id };
      }
      case 'fix': {
        const r = await startFix(a.text || a.title);
        return { result: 'Sent to Dogfood. Undo it there once it\'s done', link: r && r.id ? '#dogfood' : null };
      }
      case 'soul.edit': {
        const { text: before } = await soul();
        let next = before;
        for (const line of String(a.remove || '').split('\n').map((l) => l.trim()).filter(Boolean)) next = next.split('\n').filter((l) => l.trim() !== line).join('\n');
        const add = String(a.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
        if (add.length) next = next.replace(/\s*$/, '') + '\n' + add.join('\n') + '\n';
        await saveSoul(next, { by: 'Meridian', why: `You asked: "${clean(t.text, 160)}"` });
        return { result: 'soul.md updated', undo: { soulBefore: before } };
      }
      case 'calendar.add':
        if (a.calendar !== 'outlook') {
          if (!parseLocal(a.start)) throw fail('no time for the event');
          return { result: 'Tap to add it to your phone\'s calendar', link: `/api/tell/${t.id}/event/${i}.ics` };
        }
        return calendarAgent(t, a, i);
      case 'calendar.move': case 'calendar.respond': case 'calendar.remove':
        if (!target.outlook) throw fail('only Outlook events can be changed from here');
        return calendarAgent(t, a, i);
      default: throw fail('not something Tell can do yet');
    }
  }
  function cleanSet(set) {
    const out = {};
    for (const k of Object.keys(FIELDS)) if (set && set[k] !== undefined && set[k] !== null && set[k] !== '') out[k] = k === 'people' ? (Array.isArray(set.people) ? set.people.map((p) => clean(p, 60)) : []) : clean(set[k], 300);
    return out;
  }

  const CAL_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, eventId: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, summary: { type: 'string', description: 'One short line for Owner' }, error: { type: 'string' } }, required: ['ok', 'summary'] };
  async function calendarAgent(t, a, i, undoOf = null) {
    const target = a.target || {};
    const when = (ms) => (ms ? localStamp(ms) : '');
    const find = target.title ? `the event "${target.title}" starting ${when(target.ts)}${target.end ? ' and ending ' + when(target.end) : ''} (Europe/London)${target.organizer ? ', organised by ' + target.organizer : ''}. Find it with outlook_calendar_search around that time first` : '';
    const task = {
      'calendar.add': `Create an event in Owner's Outlook calendar: "${a.text || a.title}" from ${a.start} to ${a.end || '(one hour later)'} Europe/London${a.where ? ', location ' + a.where : ''}. ${(a.people || []).length ? 'Invite: ' + a.people.join(', ') + ' (look each up with search_people; if someone can\'t be found, create the event without them and say so).' : 'Don\'t invite anyone.'}`,
      'calendar.move': `Move ${find}. New time: ${a.start} to ${a.end || '(keep the same length)'} Europe/London. If it repeats, move only this occurrence.`,
      'calendar.respond': `Respond "${a.response || 'accept'}" to ${find}. Send the response to the organiser without a comment.`,
      'calendar.remove': `Delete ${find}. Only if Owner is the organiser; if not, decline it instead and say so.`,
      undo: undoOf,
    }[undoOf ? 'undo' : a.kind];
    const out = await runClaude({
      args: ['-p', '--model', model(), '--effort', 'low', '--output-format', 'json', '--json-schema', JSON.stringify(CAL_SCHEMA),
        // No --setting-sources here: it hides the claude.ai connectors, Outlook included.
        '--tools', '', '--allowedTools', CAL_TOOLS.join(','), '--no-session-persistence',
        '--system-prompt', 'You make one calendar change in Owner\'s Outlook (Microsoft 365) calendar with the tools you have, then report. Times are Europe/London. Do exactly the one change asked, nothing else. If something is ambiguous (two matching events), change nothing and explain in error.'],
      input: task, timeoutMs: 150000, cwd: dir,
    });
    if (!out.ok) throw fail(clean(out.error || out.summary || 'Outlook said no', 240));
    const undo = undoOf ? null : a.kind === 'calendar.add' && out.eventId ? { calendar: 'delete', eventId: clean(out.eventId, 400), title: a.text || a.title, start: a.start }
      : a.kind === 'calendar.move' ? { calendar: 'move', title: target.title, from: a.start, back: { start: when(target.ts), end: when(target.end) } } : null;
    return { result: clean(out.summary, 240) || 'Done in Outlook', undo };
  }

  async function undo(id, i) {
    const t = await get(id);
    const a = t.actions[i];
    if (!a || a.state !== 'done') throw fail('nothing to undo there', 409);
    if (now() - Date.parse(a.at || t.created) > UNDO_MS) throw fail('that was more than a day ago, so it stays', 409);
    const u = a.undo || {};
    if (u.todoId && a.kind === 'todo.add') await todos.remove(u.todoId);
    else if (u.todoId && a.kind === 'todo.done') await todos.update(u.todoId, { done: false });
    else if (u.todoId && u.before) await todos.update(u.todoId, u.before);
    else if (u.restore) await todos.create(u.restore);
    else if (u.reminderId) await removeReminder(u.reminderId);
    else if (u.deadlineId) await removeDeadline(u.deadlineId);
    else if (u.moneyNoteId) await moneyNotes.remove(u.moneyNoteId);
    else if (u.captureId) await captures.undo(u.captureId);
    else if (u.draftId) await drafts.remove(u.draftId).catch(() => {});
    else if (u.soulBefore !== undefined) await saveSoul(u.soulBefore, { by: 'Owner', why: 'Undid a change from Tell' });
    else if (u.calendar === 'delete') await calendarAgent(t, a, i, `Delete the event "${u.title}" at ${u.start} Europe/London from Owner's Outlook calendar${u.eventId ? ' (event id ' + u.eventId + ')' : ''}. It was created a moment ago by mistake.`);
    else if (u.calendar === 'move') await calendarAgent(t, a, i, `Move the event "${u.title}" that now starts ${u.from} Europe/London back to ${u.back.start}${u.back.end ? ' to ' + u.back.end : ''}.`);
    else throw fail('this one can\'t be undone from here', 409);
    refresh();
    return change(id, (x) => { x.actions[i].state = 'undone'; x.receipt = receipt(x); });
  }

  async function discard(id) {
    return change(id, (x) => { if (x.actions.some((a) => a.state === 'done')) throw fail('some of it is already done; undo those instead', 409); x.status = 'discarded'; });
  }

  function ics(t, i) {
    const a = t.actions[i];
    if (!a || a.kind !== 'calendar.add') throw fail('no event there', 404);
    const set = a.ask && a.ask.options[a.choice || 0] ? cleanSet(a.ask.options[a.choice || 0].set) : {};
    const x = { ...a, ...set };
    const start = parseLocal(x.start); if (!start) throw fail('no time', 404);
    const end = parseLocal(x.end) || start + 3600e3;
    const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const line = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meridian//Tell//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:${t.id}-${i}@meridian`, `DTSTAMP:${z(now())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
      `SUMMARY:${line(x.text || x.title)}`, ...(x.where ? [`LOCATION:${line(x.where)}`] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  }

  // What a list on the phone needs: no undo payloads, no copies of soul.md.
  function view(t) {
    return { ...t, actions: t.actions.map(({ undo: u, target, ...a }) => ({ ...a, canUndo: !!u && a.state === 'done', target: target ? { type: target.type, title: target.title, ts: target.ts || null, cal: target.cal || null } : null })) };
  }

  // ---- routes
  async function handle(req, res, url, { jsonBody, sendJson }) {
    const p = url.pathname;
    if (!p.startsWith('/api/tell') && !p.startsWith('/api/soul') && !p.startsWith('/api/reminders')) return false;
    try {
      if (p === '/api/tell' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 20, KEEP);
        const list = (await readTells()).filter((t) => t.status !== 'discarded').slice(0, limit);
        sendJson(res, 200, { ok: true, tells: list.map(view) });
        return true;
      }
      if (p === '/api/tell' && req.method === 'POST') {
        // The Shortcut puts mode, via and wait in the query and only the words in the body,
        // and asks for format=text so it can show the answer without parsing JSON.
        const body = await jsonBody(req, 40000);
        for (const k of ['mode', 'via', 'wait']) if (body[k] === undefined && url.searchParams.has(k)) body[k] = url.searchParams.get(k);
        const t = await create(body);
        if (url.searchParams.get('format') === 'text') { res.writeHead(201, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(shortcutLine(t)); return true; }
        sendJson(res, 201, { ok: true, tell: view(t), message: shortcutLine(t) });
        return true;
      }
      if (p === '/api/tell/settings' && req.method === 'GET') { sendJson(res, 200, { ok: true, ...(await settings()), groups: GROUPS }); return true; }
      if (p === '/api/tell/settings' && req.method === 'PUT') { sendJson(res, 200, { ok: true, ...(await saveSettings(await jsonBody(req))) }); return true; }
      const ev = p.match(/^\/api\/tell\/([a-f0-9]{12})\/event\/(\d+)\.ics$/);
      if (ev && req.method === 'GET') {
        const body = ics(await get(ev[1]), Number(ev[2]));
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="meridian-event.ics"`, 'Cache-Control': 'no-store' });
        res.end(body);
        return true;
      }
      const m = p.match(/^\/api\/tell\/([a-f0-9]{12})(?:\/(apply|undo))?$/);
      if (m && req.method === 'GET' && !m[2]) {
        const wait = Math.min(Number(url.searchParams.get('wait')) || 0, 25000);
        let t = await get(m[1]);
        // A long poll: answer as soon as the plan changes, so the phone doesn't hammer the Mac.
        if (jobsEnabled() && wait && (t.status === 'planning' || t.status === 'applying')) {
          const since = t.updated || t.created;
          t = await new Promise((resolve) => {
            const done = (x) => { if ((x.updated || x.created) !== since) { clearTimeout(timer); off(); resolve(x); } };
            const off = () => { const l = (waiters.get(m[1]) || []).filter((f) => f !== done); if (l.length) waiters.set(m[1], l); else waiters.delete(m[1]); };
            const timer = setTimeout(() => { off(); get(m[1]).then(resolve, () => resolve(t)); }, wait);
            waiters.set(m[1], [...(waiters.get(m[1]) || []), done]);
          });
        }
        sendJson(res, 200, { ok: true, tell: view(t) });
        return true;
      }
      if (m && m[2] === 'apply' && req.method === 'POST') { const b = await jsonBody(req); sendJson(res, 200, { ok: true, tell: view(await apply(m[1], { picks: b.picks })) }); return true; }
      if (m && m[2] === 'undo' && req.method === 'POST') { const b = await jsonBody(req); sendJson(res, 200, { ok: true, tell: view(await undo(m[1], Number(b.i))) }); return true; }
      if (m && !m[2] && req.method === 'DELETE') { sendJson(res, 200, { ok: true, tell: view(await discard(m[1])) }); return true; }
      if (p === '/api/soul' && req.method === 'GET') { sendJson(res, 200, { ok: true, ...(await soul()) }); return true; }
      if (p === '/api/soul' && req.method === 'PUT') { const b = await jsonBody(req, 40000); sendJson(res, 200, { ok: true, ...(await saveSoul(b.text, { by: 'Owner', why: b.why })) }); return true; }
      if (p === '/api/reminders' && req.method === 'GET') { sendJson(res, 200, { ok: true, reminders: (await readReminders()).filter((r) => !r.sent).sort((a, b) => a.at - b.at) }); return true; }
      const rm = p.match(/^\/api\/reminders\/([a-f0-9]{10})(\/snooze)?$/);
      if (rm && !rm[2] && req.method === 'DELETE') { sendJson(res, 200, { ok: await removeReminder(rm[1]) }); return true; }
      if (rm && rm[2] && req.method === 'POST') { const b = await jsonBody(req); sendJson(res, 200, { ok: true, reminder: await snoozeReminder(rm[1], b.minutes) }); return true; }
      return false;
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: clean(e.message || e, 300) });
      return true;
    }
  }

  // What the Shortcut shows in its notification after the Action Button.
  function shortcutLine(t) {
    if (t.status === 'planning') return 'Got it. Working on it, I\'ll ping you.';
    if (t.status === 'failed') return 'Saved as a note. I couldn\'t plan it.';
    const did = t.actions.filter((a) => a.state === 'done').map((a) => a.title);
    const wait = t.actions.filter((a) => a.state === 'planned').length;
    const busy = t.actions.filter((a) => a.state === 'doing').length;
    const parts = [];
    if (did.length) parts.push('Done: ' + did.join(', ') + '.');
    if (busy) parts.push(`${busy} still going.`);
    if (wait) parts.push(`${wait} need${wait === 1 ? 's' : ''} a tick in Meridian.`);
    return parts.join(' ') || t.reply || 'Nothing to change.';
  }

  let timer = null;
  function start() { if (!jobsEnabled()) return; if (!timer) { timer = setInterval(() => { tickReminders().catch((e) => console.error('reminders:', e.message)); }, 30000); timer.unref?.(); } }
  function stop() { clearInterval(timer); timer = null; }

  return { handle, create, apply, undo, discard, get, recent, plan, settings, saveSettings, soul, saveSoul, tickReminders, addReminder, removeReminder, snoozeReminder, readReminders, ics, view, start, stop, shortcutLine };
}

module.exports = { createTell, contextFor, parseLocal, localStamp, KINDS, GROUPS, DEFAULT_TRUST, PLAN_SCHEMA, runClaudeCli };
