'use strict';

// Meridian for agents (4 Oct 2026). One short, plain picture of Owner's
// dashboard that his Dot, Claude or Codex can read before helping: what's
// next on the calendar, his to-dos and deadlines, what's waiting on him,
// open drafts, which agents are working, and what's broken. The state the
// page uses is ~185 KB of render data; this is a few KB of meaning.
//
//   GET /api/agent      JSON
//   GET /agent.md       the same as Markdown (also /agent.txt)
//   MCP meridian_overview (drafts.js tools), the Markdown plus the JSON
//
// Never includes money (that has its own read-only MCP), tokens, or the
// brain graph. Times are written out in Europe/London, as Owner reads them.

const TZ = 'Europe/London';
const fmt = (ms, o) => new Date(ms).toLocaleString('en-GB', { timeZone: TZ, ...o });
const dayKey = (ms) => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
function when(ms, now) {
  const d = dayKey(ms), today = dayKey(now), tomorrow = dayKey(now + 864e5);
  const day = d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : fmt(ms, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} ${fmt(ms, { hour: '2-digit', minute: '2-digit' })}`;
}
const cut = (s, n = 200) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function summarize(state = {}, { drafts = [], now = Date.now(), base = '' } = {}) {
  const s = state || {};
  const events = (s.calendar?.events || []).filter((e) => (e.end || e.ts) >= now && e.ts < now + 7 * 864e5).slice(0, 15)
    .map((e) => ({ when: e.allDay ? when(e.ts, now).replace(/ \d\d:\d\d$/, ', all day') : when(e.ts, now), title: e.title, where: e.location || null,
      join: e.joinUrl || null, needsReply: e.response === 'none' || e.response === 'notResponded' || undefined }));
  const invites = (s.invites || []).filter((i) => !i.inCalendar).map((i) => ({ when: when(Date.parse(i.start), now), title: i.title, from: i.organizer || null }));
  const todos = (s.todos || []).filter((t) => !t.done).map((t) => ({ title: t.title, priority: t.priority, note: cut(t.note, 160) || undefined,
    area: t.area || undefined, agentRunning: t.delegation?.status === 'running' || undefined }));
  const deadlines = (s.deadlines || []).filter((d) => !d.done).sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .map((d) => ({ due: d.due, title: d.title, area: d.area || undefined, note: cut(d.note, 160) || undefined }));
  const waiting = (s.briefIntake?.items || []).filter((i) => i.actionable !== false && !['done', 'rejected', 'snoozed', 'delegated'].includes(i.status))
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || ''))).slice(0, 12)
    .map((i) => ({ from: i.from || null, via: i.source, title: i.title, ask: cut(i.request || i.summary, 220) }));
  const board = (s.board?.cards || []).filter((c) => c.needsYou).map((c) => ({ title: c.title, status: c.status }));
  const agents = (s.ai?.sessions || []).filter((x) => x.live).slice(0, 8).map((x) => ({ tool: x.tool, project: x.project || null, doing: cut(x.did || x.summary || x.prompt, 160) }));
  const down = (s.fleet?.services || []).filter((x) => !x.up && !x.paused).map((x) => x.name);
  const gh = s.github || {};
  const out = {
    about: `Owner's Meridian dashboard (his Home Mac), read at ${fmt(now, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} UK time.`,
    location: s.location?.name || null,
    calendar: events,
    sources: s.sources?.calendar ? { calendar: { ...s.sources.calendar } } : undefined,
    invitesWaitingForReply: invites,
    todos,
    deadlines,
    waitingOnOwner: waiting,
    boardNeedsOwner: board,
    workUpdates: (s.workBrief?.updates || []).map((u) => ({ title: u.title, detail: cut(u.body, 260) })),
    drafts: drafts.filter((d) => d.status !== 'sent').slice(0, 8).map((d) => ({ id: d.id, kind: d.kind, title: d.title, status: d.status, to: d.to || undefined })),
    agentsWorking: agents,
    problems: [
      ...down.map((n) => `${n} is down`),
      ...(gh.failing || []).map((p) => `Checks failing: ${p.repo}#${p.number} ${p.title}`),
      ...(gh.reviews || []).map((p) => `Review requested: ${p.repo}#${p.number} ${p.title}`),
    ],
    howToHelp: {
      draft: 'To write an email, Slack message or text with Owner, use draft_create (it opens beside his dashboard), then draft_get before sending.',
      todo: 'todo_add puts something on his to-do list.',
      open: 'panel_open_url shows a page beside his dashboard.',
      pages: base ? { dashboard: base + '/dashboard', brief: base + '/' } : undefined,
    },
  };
  return out;
}

function markdown(o) {
  const L = [`# Meridian`, '', o.about + (o.location ? ` In ${o.location}.` : ''), ''];
  const section = (title, rows, line) => { if (!rows?.length) return; L.push(`## ${title}`, ''); for (const r of rows) L.push('- ' + line(r)); L.push(''); };
  if (o.sources?.calendar) {
    const source = o.sources.calendar;
    L.push(source.lastSuccess == null ? 'Calendar has no successful refresh recorded.' : `Calendar last refreshed ${fmt(source.lastSuccess, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${source.stale ? ', retained copy' : ''}.`, '');
  }
  section('Calendar, next 7 days', o.calendar, (e) => `${e.when}: ${e.title}${e.where ? ` (${e.where})` : ''}${e.needsReply ? ', not replied yet' : ''}`);
  section('Invites waiting for a reply', o.invitesWaitingForReply, (i) => `${i.when}: ${i.title}${i.from ? `, from ${i.from}` : ''}`);
  section('To-dos', o.todos, (t) => `[${t.priority}] ${t.title}${t.note ? `: ${t.note}` : ''}${t.agentRunning ? ' (an agent is on it)' : ''}`);
  section('Deadlines', o.deadlines, (d) => `${d.due}: ${d.title}${d.area ? ` (${d.area})` : ''}`);
  section('Waiting on Owner', o.waitingOnOwner, (w) => `${w.from ? w.from + ' via ' : ''}${w.via}: ${w.title}. ${w.ask}`);
  section('Board cards that need him', o.boardNeedsOwner, (c) => `${c.title} (${c.status})`);
  section('Work updates', o.workUpdates, (u) => `${u.title}: ${u.detail}`);
  section('Open drafts', o.drafts, (d) => `${d.title} (${d.kind}, ${d.status}, id ${d.id})`);
  section('Agents working now', o.agentsWorking, (a) => `${a.tool}${a.project ? ' in ' + a.project : ''}: ${a.doing}`);
  section('Problems', o.problems.map((p) => ({ p })), (x) => x.p);
  L.push('## How to help', '', ...Object.values(o.howToHelp).filter((v) => typeof v === 'string').map((v) => '- ' + v), '');
  return L.join('\n');
}

module.exports = { summarize, markdown };
