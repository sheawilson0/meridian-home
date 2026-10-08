'use strict';

// Link hub store. One JSON file, atomic writes, no dependencies.
// A link is a URL Owner has decided is worth keeping: a live site, a
// Tailscale preview, a local tool, a document. Categories are free text so
// the hub can grow with the work, but the defaults below keep the first
// screen tidy.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const KINDS = ['live', 'preview', 'local', 'tool', 'doc'];
const DEFAULT_CATEGORIES = ["Work", "Meridian", "Tools", "Personal"];

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function cleanUrl(value) {
  const url = clean(value, 2000);
  if (!url) throw new Error('url required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('url must be absolute (include http:// or https://)'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http and https links');
  return parsed.href;
}

function cleanTags(value, existing) {
  if (value === undefined) return existing || [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((t) => clean(t, 30).toLowerCase()).filter(Boolean))].slice(0, 12);
}

function guessKind(url) {
  try {
    const host = new URL(url).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return 'local';
    if (/^100\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.ts.net')) return 'preview';
  } catch { /* fallthrough */ }
  return 'live';
}

function normaliseLink(input, existing = {}) {
  const now = new Date().toISOString();
  const url = input.url === undefined ? existing.url : cleanUrl(input.url);
  if (!url) throw new Error('url required');
  let title = clean(input.title === undefined ? existing.title : input.title, 120);
  if (!title) {
    try { title = new URL(url).hostname.replace(/^www\./, ''); } catch { title = url; }
  }
  const kind = clean(input.kind === undefined ? existing.kind : input.kind, 20) || existing.kind || guessKind(url);
  if (!KINDS.includes(kind)) throw new Error('bad kind');
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    url,
    category: clean(input.category === undefined ? existing.category : input.category, 40) || 'Tools',
    tags: cleanTags(input.tags, existing.tags),
    note: clean(input.note === undefined ? existing.note : input.note, 600),
    kind,
    pinned: input.pinned === undefined ? Boolean(existing.pinned) : Boolean(input.pinned),
    // Order within the pinned row on Today. Set from Manage mode.
    pinOrder: Number.isFinite(Number(input.pinOrder)) ? Number(input.pinOrder) : (Number(existing.pinOrder) || 0),
    check: input.check === undefined ? (existing.check === undefined ? true : Boolean(existing.check)) : Boolean(input.check),
    preview: input.preview === undefined ? (existing.preview === undefined ? true : Boolean(existing.preview)) : Boolean(input.preview),
    opens: Number(existing.opens) || 0,
    lastOpened: existing.lastOpened || null,
    created: existing.created || now,
    updated: now,
  };
}

function createStore(file, { defaultCategories = DEFAULT_CATEGORIES } = {}) {
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
        categories: Array.isArray(parsed.categories) && parsed.categories.length ? parsed.categories : defaultCategories.slice(),
        links: Array.isArray(parsed.links) ? parsed.links : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, categories: defaultCategories.slice(), links: [] };
    }
  }

  async function write(data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n');
    await fsp.rename(temp, file);
  }

  function rememberCategory(data, category) {
    if (category && !data.categories.includes(category)) data.categories.push(category);
  }

  async function create(input) {
    const data = await read();
    const link = normaliseLink(input);
    if (data.links.some((l) => l.url === link.url)) throw new Error('that url is already saved');
    rememberCategory(data, link.category);
    data.links.unshift(link);
    await write(data);
    return link;
  }

  async function update(id, patch) {
    const data = await read();
    const index = data.links.findIndex((l) => l.id === id);
    if (index < 0) return null;
    data.links[index] = normaliseLink(patch, data.links[index]);
    rememberCategory(data, data.links[index].category);
    await write(data);
    return data.links[index];
  }

  async function remove(id) {
    const data = await read();
    const before = data.links.length;
    data.links = data.links.filter((l) => l.id !== id);
    if (data.links.length === before) return false;
    await write(data);
    return true;
  }

  async function touch(id) {
    const data = await read();
    const link = data.links.find((l) => l.id === id);
    if (!link) return null;
    link.opens = (Number(link.opens) || 0) + 1;
    link.lastOpened = new Date().toISOString();
    await write(data);
    return link;
  }

  // The whole pinned order in a single write. Doing this as one PATCH per
  // link raced and corrupted the file.
  async function setPinOrder(ids) {
    const data = await read();
    const list = Array.isArray(ids) ? ids : [];
    const now = new Date().toISOString();
    list.forEach((id, i) => {
      const link = data.links.find((l) => l.id === id);
      if (link) { link.pinOrder = i; link.updated = now; }
    });
    await write(data);
    return data.links;
  }

  // The full ordered list from the shelf. A category some link still uses but
  // the request left out is kept at the end rather than orphaning its links.
  async function setCategories(categories) {
    const data = await read();
    const list = [...new Set((Array.isArray(categories) ? categories : []).map((c) => clean(c, 40)).filter(Boolean))];
    if (!list.length) throw new Error('at least one category');
    const used = [...data.categories, ...data.links.map((l) => l.category)].filter((c) => c && !list.includes(c) && data.links.some((l) => l.category === c));
    data.categories = [...list, ...new Set(used)];
    await write(data);
    return data.categories;
  }

  // Renames on every link and in the list. Renaming onto an existing
  // category merges the two, keeping the target's place in the order.
  async function renameCategory(fromRaw, toRaw) {
    const data = await read();
    const from = clean(fromRaw, 40);
    const to = clean(toRaw, 40);
    if (!from || !to) throw new Error('from and to required');
    const moved = data.links.filter((l) => l.category === from);
    if (!moved.length && !data.categories.includes(from)) throw new Error(`no category called ${from}`);
    if (from === to) return { categories: data.categories, moved: 0, merged: false };
    const merged = data.categories.includes(to);
    const now = new Date().toISOString();
    for (const l of moved) { l.category = to; l.updated = now; }
    data.categories = merged ? data.categories.filter((c) => c !== from) : data.categories.map((c) => (c === from ? to : c));
    rememberCategory(data, to);
    await write(data);
    return { categories: data.categories, moved: moved.length, merged };
  }

  // Removes a category from the list, moving its links (to "Other" unless
  // told otherwise). The list never ends up empty, because read() would then
  // bring back the defaults.
  async function removeCategory(nameRaw, moveToRaw) {
    const data = await read();
    const name = clean(nameRaw, 40);
    const moveTo = clean(moveToRaw, 40) || 'Other';
    if (!name) throw new Error('name required');
    if (name === moveTo) throw new Error('cannot move links into the category being removed');
    const moved = data.links.filter((l) => l.category === name);
    if (!moved.length && !data.categories.includes(name)) throw new Error(`no category called ${name}`);
    const now = new Date().toISOString();
    for (const l of moved) { l.category = moveTo; l.updated = now; }
    data.categories = data.categories.filter((c) => c !== name);
    if (moved.length || !data.categories.length) rememberCategory(data, moveTo);
    await write(data);
    return { categories: data.categories, moved: moved.length, moveTo };
  }

  const guard = (fn) => (...args) => serialise(() => fn(...args));
  return { read, create: guard(create), update: guard(update), remove: guard(remove), touch: guard(touch), setCategories: guard(setCategories), setPinOrder: guard(setPinOrder), renameCategory: guard(renameCategory), removeCategory: guard(removeCategory) };
}

module.exports = { createStore, KINDS, DEFAULT_CATEGORIES, guessKind };
