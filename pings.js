'use strict';

// What pings Owner's phone, and when (4 Oct 2026). Every ntfy push goes through
// decide() first:
//   - kinds Owner switched off are dropped (the phone's "What pings you" sheet),
//   - the same title and words inside 6 hours are dropped ("never ping twice"),
//   - anything in quiet hours (23:00 to 08:00 by default) is held, and the held
//     ones go out as one summary when quiet hours end. Reminders Owner set for
//     a time, and priority-5 pings (a meeting starting now), still go through.
// Rules live in config.json → notify: { quiet: {on, from, to}, muted: [kinds] }.
// The older events list (delegation, fleet, deadline) still works as before.

const fsp = require('fs/promises');
const path = require('path');

const KINDS = ['needs', 'meeting', 'tell', 'reminder', 'delegation', 'fleet', 'deadline'];
const LEGACY = ['delegation', 'fleet', 'deadline'];
const DEFAULT_QUIET = { on: true, from: '23:00', to: '08:00' };
const SAME_MS = 6 * 3600e3;

const minutes = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null; };
function quietOf(n = {}) {
  const q = { ...DEFAULT_QUIET, ...(n.quiet || {}) };
  return { on: q.on !== false, from: minutes(q.from) === null ? DEFAULT_QUIET.from : q.from, to: minutes(q.to) === null ? DEFAULT_QUIET.to : q.to };
}
// Quiet hours can run over midnight (23:00 to 08:00) or not (13:00 to 14:00).
function inQuiet(quiet, ms) {
  if (!quiet || quiet.on === false) return false;
  const d = new Date(ms); const t = d.getHours() * 60 + d.getMinutes();
  const a = minutes(quiet.from); const b = minutes(quiet.to);
  if (a === null || b === null || a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

// 'send', 'hold' or 'skip', with a reason for the log.
function decide({ rules = {}, event = null, priority = 3, title = '', message = '', history = [], now = Date.now() }) {
  if (event && LEGACY.includes(event) && Array.isArray(rules.events) && !rules.events.includes(event)) return { verdict: 'skip', why: 'kind off' };
  if (event && Array.isArray(rules.muted) && rules.muted.includes(event)) return { verdict: 'skip', why: 'kind off' };
  if (event !== 'reminder' && event !== 'meeting') {
    const same = history.some((h) => h.ok && h.title === title && h.message === message && now - (h.time || 0) < SAME_MS);
    if (same) return { verdict: 'skip', why: 'sent already' };
  }
  if (inQuiet(quietOf(rules), now) && event !== 'reminder' && Number(priority) < 5) return { verdict: 'hold', why: 'quiet hours' };
  return { verdict: 'send' };
}

// Held pings wait in data/pings-held.json until quiet hours end.
function createHeld(file) {
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };
  const read = async () => { try { const j = JSON.parse(await fsp.readFile(file, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const write = async (list) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, JSON.stringify(list, null, 2) + '\n'); };
  return {
    read,
    add: (p) => serial(async () => { const list = await read(); list.push({ title: p.title, message: p.message, event: p.event || null, click: p.click || null, time: p.time || Date.now() }); await write(list.slice(-50)); }),
    // Takes everything held, once quiet hours are over.
    take: (rules, now = Date.now()) => serial(async () => {
      if (inQuiet(quietOf(rules), now)) return [];
      const list = await read(); if (!list.length) return [];
      await write([]); return list;
    }),
  };
}

// The morning summary for whatever was held overnight.
function summary(held) {
  if (!held.length) return null;
  if (held.length === 1) return { title: held[0].title, message: held[0].message, click: held[0].click };
  const lines = held.slice(-8).map((h) => `· ${h.title}`);
  return { title: `While it was quiet: ${held.length} things`, message: lines.join('\n'), click: held.find((h) => h.click)?.click || null };
}

module.exports = { KINDS, LEGACY, DEFAULT_QUIET, inQuiet, quietOf, decide, createHeld, summary };
