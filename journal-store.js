'use strict';

// Journal store. One JSON file, atomic writes, no dependencies.
// An entry is one thing Owner did on one day. Most entries are written for
// him: the nightly ledger is split into entries per area, and a backfill
// agent can add history. `track` is the coarse filter he asked for
// (work / uni / personal); `area` is the finer grouping (ExampleApp, Uni…).

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const TRACKS = ['work', 'uni', 'personal'];
const SOURCES = ['manual', 'ledger', 'auto', 'agent'];
const DEFAULT_AREAS = ["Uni", "Work", "Meridian", "Personal"];

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function cleanDate(value, fallback) {
  const v = clean(value, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))) return v;
  if (fallback) return fallback;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanTags(value, existing) {
  if (value === undefined) return existing || [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((t) => clean(t, 30).toLowerCase()).filter(Boolean))].slice(0, 12);
}

function normaliseEntry(input, existing = {}) {
  const now = new Date().toISOString();
  const title = clean(input.title === undefined ? existing.title : input.title, 160);
  if (!title) throw new Error('title required');
  const track = clean(input.track === undefined ? existing.track : input.track, 12).toLowerCase() || existing.track || 'personal';
  if (!TRACKS.includes(track)) throw new Error('track must be work, uni or personal');
  const source = clean(input.source === undefined ? existing.source : input.source, 12).toLowerCase() || existing.source || 'manual';
  if (!SOURCES.includes(source)) throw new Error('bad source');
  let minutes = input.minutes === undefined ? existing.minutes : input.minutes;
  minutes = minutes === '' || minutes === null || minutes === undefined ? null : Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)));
  return {
    id: existing.id || crypto.randomUUID(),
    date: cleanDate(input.date === undefined ? existing.date : input.date, existing.date),
    area: clean(input.area === undefined ? existing.area : input.area, 40) || 'Personal',
    track,
    title,
    body: clean(input.body === undefined ? existing.body : input.body, 8000),
    tags: cleanTags(input.tags, existing.tags),
    minutes,
    source,
    sourceRef: clean(input.sourceRef === undefined ? existing.sourceRef : input.sourceRef, 120) || null,
    created: existing.created || now,
    updated: now,
  };
}

function createStore(file, { defaultAreas = DEFAULT_AREAS } = {}) {
  // Every mutation is a read-modify-write on one file. Without this chain two
  // requests arriving together can interleave and leave a half-written file
  // behind, which is exactly how links.json got corrupted on 2026-09-03.
  let writeChain = Promise.resolve();
  function serialise(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  async function read() {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      return {
        version: 1,
        areas: Array.isArray(parsed.areas) && parsed.areas.length ? parsed.areas : defaultAreas.slice(),
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, areas: defaultAreas.slice(), entries: [] };
    }
  }

  async function write(data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n');
    await fsp.rename(temp, file);
  }

  function rememberArea(data, area) {
    if (area && !data.areas.includes(area)) data.areas.push(area);
  }

  async function create(input) {
    const data = await read();
    const entry = normaliseEntry(input);
    rememberArea(data, entry.area);
    data.entries.unshift(entry);
    await write(data);
    return entry;
  }

  // Bulk insert for the ledger sync and backfill. Skips anything whose
  // (source, sourceRef) is already present so re-runs are safe.
  async function createMany(inputs) {
    const data = await read();
    const seen = new Set(data.entries.filter((e) => e.sourceRef).map((e) => e.source + '|' + e.sourceRef));
    const added = [];
    for (const input of inputs) {
      const entry = normaliseEntry(input);
      const key = entry.source + '|' + (entry.sourceRef || '');
      if (entry.sourceRef && seen.has(key)) continue;
      seen.add(key);
      rememberArea(data, entry.area);
      data.entries.push(entry);
      added.push(entry);
    }
    if (added.length) {
      data.entries.sort((a, b) => b.date.localeCompare(a.date) || String(b.created).localeCompare(String(a.created)));
      await write(data);
    }
    return added;
  }

  async function update(id, patch) {
    const data = await read();
    const index = data.entries.findIndex((e) => e.id === id);
    if (index < 0) return null;
    data.entries[index] = normaliseEntry(patch, data.entries[index]);
    rememberArea(data, data.entries[index].area);
    await write(data);
    return data.entries[index];
  }

  async function remove(id) {
    const data = await read();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    if (data.entries.length === before) return false;
    await write(data);
    return true;
  }

  async function setAreas(areas) {
    const data = await read();
    const list = [...new Set((Array.isArray(areas) ? areas : []).map((a) => clean(a, 40)).filter(Boolean))];
    if (!list.length) throw new Error('at least one area');
    data.areas = list;
    await write(data);
    return data.areas;
  }

  function toMarkdown(data, { from, to } = {}) {
    const entries = data.entries
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.created).localeCompare(String(a.created)));
    const out = ['# Journal', ''];
    let day = null;
    for (const e of entries) {
      if (e.date !== day) { day = e.date; out.push(`## ${day}`, ''); }
      const meta = [e.area, e.track, e.minutes ? (e.minutes >= 60 ? (e.minutes / 60).toFixed(1).replace(/\.0$/, '') + ' h' : e.minutes + ' min') : null].filter(Boolean).join(' · ');
      out.push(`### ${e.title}${meta ? ` (${meta})` : ''}`, '');
      if (e.body) out.push(e.body, '');
      if (e.tags && e.tags.length) out.push(`Tags: ${e.tags.join(', ')}`, '');
    }
    return out.join('\n');
  }

  const guard = (fn) => (...args) => serialise(() => fn(...args));
  return { read, create: guard(create), createMany: guard(createMany), update: guard(update), remove: guard(remove), setAreas: guard(setAreas), toMarkdown, normaliseEntry };
}

module.exports = { createStore, TRACKS, SOURCES, DEFAULT_AREAS, normaliseEntry };
