#!/usr/bin/env node
// Validate and merge journal entries produced outside the daemon (the backfill
// agent). Usage:
//   node scripts/journal-import.js <file.json> --validate   report problems, change nothing
//   node scripts/journal-import.js <file.json> --apply      merge into data/journal.json
// Entries are skipped when the same (source, sourceRef) already exists, so
// running twice is safe. Exit code 0 means clean; 1 means the file has errors.

'use strict';
const path = require('path');
const fs = require('fs');
const { createStore, normaliseEntry, TRACKS, SOURCES } = require('../journal-store');

const file = process.argv[2];
const mode = process.argv.includes('--apply') ? 'apply' : 'validate';
if (!file) { console.error('usage: journal-import.js <file.json> --validate|--apply'); process.exit(2); }

let raw;
try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('not valid JSON:', e.message); process.exit(1); }
const list = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : null;
if (!list) { console.error('expected an array of entries or { "entries": [...] }'); process.exit(1); }

const problems = [];
const seen = new Set();
const clean = [];
list.forEach((e, i) => {
  const where = `entry ${i + 1}${e && e.title ? ` ("${String(e.title).slice(0, 40)}")` : ''}`;
  try {
    if (!e || typeof e !== 'object') throw new Error('not an object');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ''))) throw new Error('date must be YYYY-MM-DD');
    if (!TRACKS.includes(e.track)) throw new Error('track must be one of ' + TRACKS.join(', '));
    if (!SOURCES.includes(e.source || 'agent')) throw new Error('source must be one of ' + SOURCES.join(', '));
    if (!e.sourceRef) throw new Error('sourceRef required (stable key so re-imports do not duplicate)');
    if (String(e.title).length > 160) throw new Error('title over 160 characters; move detail into body');
    if (e.body && String(e.body).length > 8000) throw new Error('body over 8000 characters');
    if (/—/.test(String(e.title) + String(e.body || ''))) throw new Error('em dash found; use a comma, colon or full stop');
    const key = (e.source || 'agent') + '|' + e.sourceRef;
    if (seen.has(key)) throw new Error('duplicate sourceRef within file: ' + e.sourceRef);
    seen.add(key);
    clean.push(normaliseEntry({ ...e, source: e.source || 'agent' }));
  } catch (err) { problems.push(`${where}: ${err.message}`); }
});

const dates = clean.map((e) => e.date).sort();
console.log(`${list.length} entries read, ${clean.length} valid, ${problems.length} problem(s)`);
if (clean.length) console.log(`dates ${dates[0]} to ${dates[dates.length - 1]}; tracks: ${TRACKS.map((t) => t + ' ' + clean.filter((e) => e.track === t).length).join(', ')}`);
problems.slice(0, 40).forEach((p) => console.log(' - ' + p));
if (problems.length) process.exit(1);

if (mode === 'apply') {
  const store = createStore(path.join(__dirname, '..', 'data', 'journal.json'));
  store.createMany(clean).then((added) => {
    console.log(`applied: ${added.length} new entries merged into data/journal.json (${clean.length - added.length} already present)`);
  }).catch((e) => { console.error('apply failed:', e.message); process.exit(1); });
} else {
  console.log('valid. Re-run with --apply to merge.');
}
