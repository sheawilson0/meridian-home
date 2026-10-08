'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const STATUSES = ['inbox', 'next', 'active', 'waiting', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function normaliseProject(input, existing = {}) {
  const now = new Date().toISOString();
  const title = clean(input.title === undefined ? existing.title : input.title, 120);
  if (!title) throw new Error('title required');
  const status = clean(input.status === undefined ? existing.status : input.status, 20) || 'inbox';
  if (!STATUSES.includes(status)) throw new Error('bad status');
  const priority = clean(input.priority === undefined ? existing.priority : input.priority, 20) || 'normal';
  if (!PRIORITIES.includes(priority)) throw new Error('bad priority');
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    note: clean(input.note === undefined ? existing.note : input.note),
    status,
    priority,
    brief: input.brief === undefined ? Boolean(existing.brief) : Boolean(input.brief),
    delegate: input.delegate === undefined ? Boolean(existing.delegate) : Boolean(input.delegate),
    source: clean(input.source === undefined ? existing.source : input.source, 30) || null,
    sourceId: clean(input.sourceId === undefined ? existing.sourceId : input.sourceId, 500) || null,
    sourceUrl: clean(input.sourceUrl === undefined ? existing.sourceUrl : input.sourceUrl, 2000) || null,
    sourceFrom: clean(input.sourceFrom === undefined ? existing.sourceFrom : input.sourceFrom, 160) || null,
    sourceReceivedAt: clean(input.sourceReceivedAt === undefined ? existing.sourceReceivedAt : input.sourceReceivedAt, 80) || null,
    created: existing.created || now,
    updated: now,
  };
}

function createStore(file) {
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
      return { version: 1, projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, projects: [] };
    }
  }

  async function write(data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n');
    await fsp.rename(temp, file);
  }

  async function create(input) {
    const data = await read();
    const project = normaliseProject(input);
    data.projects.unshift(project);
    await write(data);
    return project;
  }

  async function update(id, patch) {
    const data = await read();
    const index = data.projects.findIndex((project) => project.id === id);
    if (index < 0) return null;
    data.projects[index] = normaliseProject(patch, data.projects[index]);
    await write(data);
    return data.projects[index];
  }

  async function remove(id) {
    const data = await read();
    const before = data.projects.length;
    data.projects = data.projects.filter((project) => project.id !== id);
    if (data.projects.length === before) return false;
    await write(data);
    return true;
  }

  const guard = (fn) => (...args) => serialise(() => fn(...args));
  return { read, create: guard(create), update: guard(update), remove: guard(remove) };
}

module.exports = { createStore, STATUSES, PRIORITIES };
