'use strict';

// What Owner actually does with the work the Daily brief automation finds.
// Every intake item (Outlook or Slack) ends up done, rejected, delegated,
// skipped, replied to, or left alone; this tallies that per sender and per
// source/channel into data/brief-learning.json, which the automation reads
// to rank tomorrow's items: senders he always acts on go up, ones he always
// dismisses go down or are skipped.
//
// The intake file only holds the latest 40 items, so each item's outcome is
// also kept in the learning file's `items` (newest 600) and history
// survives items rolling off the intake.
//
// Signals, per item:
//   done       intake status done, its project marked done, or completed in the brief
//   rejected   intake status rejected, or rejected in the brief
//   delegated  intake status delegated, or a Meridian agent run for its project
//   skipped    snoozed, or skipped in the brief
//   responded  respondedAt set by the automation (Owner replied in Slack or Outlook)
//   ignored    none of the above, 7+ days after it surfaced
//   open       none of the above yet, under 7 days old

const fsp = require('fs/promises');
const path = require('path');

const IGNORE_AFTER_MS = 7 * 86400000;
const KEEP_ITEMS = 600;
const RULES = {
  minDecided: 3, // fewer decided items than this: no opinion yet
  raiseAt: 0.6, // acted / decided at or above: rank higher
  lowerAt: 0.6, // dismissed / decided at or above: rank lower
  skipAt: 0.8, // dismissed / decided at or above, with skipMinDecided+ decided: skip
  skipMinDecided: 5,
};

const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function channelOf(item) {
  if (item.source === 'slack') { const c = String(item.id || '').split(':')[1]; return c ? `slack:${c}` : 'slack'; }
  return item.source === 'outlook' ? 'outlook:mail' : String(item.source || 'other');
}

function senderKey(from) { return String(from || '').trim().toLowerCase().replace(/\s+/g, ' ') || '(unknown)'; }

function outcomeFor(item, { feedback, projects, delegated, now, previous }) {
  const pid = item.projectId;
  const fbId = pid ? `project:${pid}` : null;
  const completed = new Set(feedback.completed || []);
  const rejectedSet = new Set(feedback.rejected || []);
  const skippedSet = new Set(Object.values(feedback.skipped || {}).flat());
  const project = pid ? projects.get(pid) : null;
  const prev = previous || {};
  const o = {
    done: item.status === 'done' || Boolean(project && project.status === 'done') || Boolean(fbId && completed.has(fbId)) || Boolean(prev.done),
    rejected: item.status === 'rejected' || Boolean(fbId && rejectedSet.has(fbId)) || Boolean(prev.rejected),
    delegated: item.status === 'delegated' || Boolean(pid && delegated.has(pid)) || Boolean(prev.delegated),
    skipped: item.status === 'snoozed' || Boolean(fbId && skippedSet.has(fbId)) || Boolean(prev.skipped),
    respondedAt: item.respondedAt || prev.respondedAt || null,
  };
  const surfacedAt = prev.surfacedAt || item.queuedAt || item.receivedAt || iso(now);
  const acted = o.done || o.delegated || Boolean(o.respondedAt);
  const none = !acted && !o.rejected && !o.skipped;
  const old = now - (ms(surfacedAt) || now) >= IGNORE_AFTER_MS;
  return { ...o, surfacedAt, ignored: none && old, open: none && !old };
}

function emptyCounts() {
  return { surfaced: 0, done: 0, rejected: 0, delegated: 0, responded: 0, skipped: 0, ignored: 0, open: 0, acted: 0, dismissed: 0, lastSurfacedAt: null, lastRespondedAt: null };
}

function weigh(c) {
  const decided = c.acted + c.dismissed;
  const actRate = decided ? c.acted / decided : null;
  const dismissRate = decided ? c.dismissed / decided : null;
  let weight = 'neutral';
  if (decided >= RULES.minDecided) {
    if (actRate >= RULES.raiseAt) weight = 'raise';
    else if (dismissRate >= RULES.skipAt && decided >= RULES.skipMinDecided) weight = 'skip';
    else if (dismissRate >= RULES.lowerAt) weight = 'lower';
  }
  const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return { ...c, decided, actRate: round(actRate), dismissRate: round(dismissRate), weight };
}

function add(counts, rec) {
  counts.surfaced++;
  for (const k of ['done', 'rejected', 'delegated', 'skipped', 'ignored', 'open']) if (rec[k]) counts[k]++;
  if (rec.respondedAt) counts.responded++;
  const acted = rec.done || rec.delegated || Boolean(rec.respondedAt);
  if (acted) counts.acted++;
  else if (rec.rejected || rec.ignored) counts.dismissed++;
  if (!counts.lastSurfacedAt || rec.surfacedAt > counts.lastSurfacedAt) counts.lastSurfacedAt = rec.surfacedAt;
  if (rec.respondedAt && (!counts.lastRespondedAt || rec.respondedAt > counts.lastRespondedAt)) counts.lastRespondedAt = rec.respondedAt;
}

// Pure: inputs -> the learning document (without writing it).
function summarise({ intakeItems = [], feedback = {}, projects = [], delegatedProjectIds = [], previous = null, now = Date.now() } = {}) {
  const projectMap = new Map((projects || []).map((p) => [p.id, p]));
  const delegated = new Set(delegatedProjectIds);
  const items = { ...((previous && previous.items) || {}) };
  for (const item of intakeItems) {
    if (!item || !item.id) continue;
    const prev = items[item.id];
    const o = outcomeFor(item, { feedback, projects: projectMap, delegated, now, previous: prev });
    items[item.id] = { from: item.from || (prev && prev.from) || '', source: item.source, channel: channelOf(item), title: String(item.title || '').slice(0, 120), ...o };
  }
  // Items that rolled off the intake keep their last outcome, but an open
  // one still turns into ignored once it is old enough.
  for (const rec of Object.values(items)) {
    if (rec.open && now - (ms(rec.surfacedAt) || now) >= IGNORE_AFTER_MS) { rec.open = false; rec.ignored = true; }
  }
  const kept = Object.entries(items).sort((a, b) => String(b[1].surfacedAt).localeCompare(String(a[1].surfacedAt))).slice(0, KEEP_ITEMS);
  const senders = new Map();
  const channels = new Map();
  for (const [, rec] of kept) {
    const sk = senderKey(rec.from);
    if (!senders.has(sk)) senders.set(sk, { from: rec.from || '(unknown)', ...emptyCounts() });
    add(senders.get(sk), rec);
    if (!channels.has(rec.channel)) channels.set(rec.channel, { key: rec.channel, source: rec.source, ...emptyCounts() });
    add(channels.get(rec.channel), rec);
  }
  const order = (a, b) => b.surfaced - a.surfaced || String(a.from || a.key).localeCompare(String(b.from || b.key));
  return {
    version: 1,
    generatedAt: iso(now),
    note: 'Written by Meridian from intake outcomes and brief feedback. The Daily brief automation reads it to rank items. weight: raise = Owner usually acts on these, lower = usually dismisses, skip = nearly always dismisses, neutral = not enough history.',
    rules: { ...RULES, ignoreAfterDays: IGNORE_AFTER_MS / 86400000 },
    totals: weigh(kept.reduce((c, [, rec]) => { add(c, rec); return c; }, emptyCounts())),
    senders: [...senders.values()].map(weigh).sort(order),
    channels: [...channels.values()].map(weigh).sort(order),
    items: Object.fromEntries(kept),
  };
}

const comparable = (doc) => JSON.stringify({ ...doc, generatedAt: null });

function createLearning(file, { now = () => Date.now() } = {}) {
  let last = null;
  async function read() {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
  }
  // Writes only when something other than the timestamp changed.
  async function update(inputs) {
    const previous = last || (await read());
    const doc = summarise({ ...inputs, previous, now: now() });
    if (previous && comparable(previous) === comparable(doc)) { last = previous; return { doc: previous, written: false }; }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
    await fsp.rename(tmp, file);
    last = doc;
    return { doc, written: true };
  }
  return { read, update };
}

module.exports = { summarise, createLearning, channelOf, RULES };
