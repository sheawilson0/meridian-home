'use strict';

// GET /api/widget (4 Oct 2026): the little that a widget shows, in one small
// answer. Scriptable reads it on the phone today; the iPhone app's WidgetKit
// widgets will read the same thing. Never anything from Money.

const cap = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
// "[internal] weekly catch up on…" reads better on a widget as "Weekly catch up on…".
const tidy = (t) => { const s = String(t || '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').replace(/^(re|fw|fwd):\s*/i, '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : String(t || ''); };
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

function widgetView(state = {}, { tells = [], drafts = [], now = Date.now() } = {}) {
  // The next event, skipping the daily routine meeting Owner asked never to be reminded of.
  const skip = (state.nudges?.skip || []).map((x) => { try { return new RegExp(x, 'i'); } catch { return null; } }).filter(Boolean);
  const events = ((state.calendar && state.calendar.events) || []).filter((e) => (e.end || e.ts) >= now && e.response !== 'declined').sort((a, b) => a.ts - b.ts);
  const waiting = new Set((state.invites || []).map((i) => i.calendarId).filter(Boolean));
  const next = events.find((e) => !skip.some((r) => r.test(String(e.title).trim()))) || events[0] || null;

  // What needs Owner: unanswered invites (a series once), plans waiting for a tick, drafts to read, fixes to keep.
  const needs = [];
  const seen = new Set();
  for (const v of (state.invites || []).filter((i) => Date.parse(i.end || i.start) >= now).sort((a, b) => String(a.start).localeCompare(String(b.start)))) {
    const k = String(v.title).trim().toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    needs.push({ title: tidy(v.title), why: 'Not answered', start: Date.parse(v.start) });
  }
  for (const t of tells.filter((t) => t.status === 'ready' && (t.actions || []).some((a) => a.state === 'planned'))) needs.push({ title: (t.actions.find((a) => a.state === 'planned') || {}).title || 'A plan', why: 'Waiting for a tick' });
  for (const d of drafts.filter((d) => d.status !== 'sent' && d.lastBy && d.lastBy !== 'you' && now - Date.parse(d.updated) < 3 * 86400e3)) needs.push({ title: d.title || d.subject || 'A draft', why: 'Draft to read' });
  for (const r of ((state.delegations && state.delegations.runs) || [])) {
    if (r.undoneAt || r.archivedAt) continue;
    if (r.kind === 'feedback' && r.status === 'done' && now - (r.finished || r.started) < 2 * 86400e3) needs.push({ title: r.title, why: 'Fix is live' });
    else if (['failed', 'stalled'].includes(r.status) && now - r.started < 2 * 86400e3) needs.push({ title: r.title, why: 'Agent ' + r.status });
  }

  const rank = (t) => ['now', 'next', 'later'].indexOf(t.priority || 'next');
  const todos = (state.todos || []).filter((t) => !t.done).sort((a, b) => rank(a) - rank(b) || (a.order || 0) - (b.order || 0));
  const working = ((state.ai && state.ai.sessions) || []).filter((s) => s.live);
  const runs = ((state.delegations && state.delegations.runs) || []).filter((r) => r.status === 'running' || r.status === 'queued');
  const today = new Date(now); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dl = (state.deadlines || []).filter((d) => !d.done && !d.archived && d.due >= iso && !(d.snoozedUntil && d.snoozedUntil > iso)).sort((a, b) => a.due.localeCompare(b.due))[0];

  return {
    at: now,
    next: next ? { title: cap(tidy(next.title), 80), start: next.ts, end: next.end || null, allDay: !!next.allDay, joinUrl: next.joinUrl || null, notAccepted: next.response === 'needsAction' || waiting.has(next.id), today: startOfDay(next.ts) === startOfDay(now) } : null,
    needs: { count: needs.length, first: needs[0] ? { title: cap(needs[0].title, 70), why: needs[0].why } : null, items: needs.slice(0, 3).map((n) => ({ title: cap(n.title, 70), why: n.why })) },
    todos: { open: todos.length, top: todos.slice(0, 5).map((t) => cap(t.title, 60)) },
    // The few after the headline, for the large widget.
    later: events.filter((e) => e !== next && !e.allDay && e.ts < now + 7 * 86400e3).filter((e, i, all) => all.findIndex((x) => x.title === e.title) === i).slice(0, 4).map((e) => ({ title: cap(tidy(e.title), 60), start: e.ts, notAccepted: e.response === 'needsAction' || waiting.has(e.id) })),
    agents: { working: working.length + runs.length, first: cap(runs[0]?.title || working[0]?.project?.split('/').pop() || '', 40) },
    deadline: dl ? { title: cap(dl.title, 60), due: dl.due, days: Math.round((startOfDay(Date.parse(dl.due + 'T12:00:00')) - startOfDay(now)) / 86400e3) } : null,
  };
}

module.exports = { widgetView, tidy };
