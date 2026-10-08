'use strict';

// To-do store. One JSON file, atomic writes, no dependencies.
// A to-do is something Owner decided he has to do, as opposed to the
// derived "needs you" items that come from the board, threads and the
// brief intake. He adds them, reorders them, marks them done, and can
// hand one to a model, which runs as a normal sandboxed delegation.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const PRIORITIES = ['now', 'next', 'later'];

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalise(input, existing = {}) {
  const now = new Date().toISOString();
  const title = clean(input.title === undefined ? existing.title : input.title, 200);
  if (!title) throw new Error('title required');
  let priority = clean(input.priority === undefined ? existing.priority : input.priority, 10).toLowerCase();
  if (!PRIORITIES.includes(priority)) priority = existing.priority && PRIORITIES.includes(existing.priority) ? existing.priority : 'next';
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    note: clean(input.note === undefined ? existing.note : input.note, 2000),
    priority,
    done: input.done === undefined ? Boolean(existing.done) : Boolean(input.done),
    doneAt: (input.done === undefined ? Boolean(existing.done) : Boolean(input.done)) ? (existing.doneAt || now) : null,
    area: clean(input.area === undefined ? existing.area : input.area, 40),
    // Set when a model is working on it, so the card can show the run.
    delegation: input.delegation === undefined ? (existing.delegation || null) : input.delegation,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : (Number(existing.order) || 0),
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
      return { version: 1, todos: Array.isArray(parsed.todos) ? parsed.todos : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, todos: [] };
    }
  }

  async function write(data, check) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n');
    try { check?.(); } catch (e) { await fsp.rm(temp, { force: true }); throw e; }
    await fsp.rename(temp, file);
  }

  // Open to-dos sort by priority then by explicit order; done ones fall to the bottom.
  function sort(todos) {
    const rank = (t) => PRIORITIES.indexOf(t.priority || 'next');
    return todos.slice().sort((a, b) => {
      if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
      if (a.done && b.done) return String(b.doneAt || '').localeCompare(String(a.doneAt || ''));
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0);
      return String(a.created).localeCompare(String(b.created));
    });
  }

  async function create(input, check) {
    const data = await read();
    const lowest = data.todos.reduce((min, t) => Math.min(min, Number(t.order) || 0), 0);
    const todo = normalise({ order: lowest - 1, ...input });
    data.todos.unshift(todo);
    await write(data, check);
    return todo;
  }

  async function update(id, patch) {
    const data = await read();
    const index = data.todos.findIndex((t) => t.id === id);
    if (index < 0) return null;
    data.todos[index] = normalise(patch, data.todos[index]);
    await write(data);
    return data.todos[index];
  }

  async function remove(id) {
    const data = await read();
    const before = data.todos.length;
    data.todos = data.todos.filter((t) => t.id !== id);
    if (data.todos.length === before) return false;
    await write(data);
    return true;
  }

  // Reorder from a list of ids, in the order they now appear on screen.
  async function reorder(ids) {
    const data = await read();
    const list = Array.isArray(ids) ? ids : [];
    list.forEach((id, i) => {
      const todo = data.todos.find((t) => t.id === id);
      if (todo) { todo.order = i; todo.updated = new Date().toISOString(); }
    });
    await write(data);
    return sort(data.todos);
  }

  async function clearDone() {
    const data = await read();
    const before = data.todos.length;
    data.todos = data.todos.filter((t) => !t.done);
    await write(data);
    return before - data.todos.length;
  }

  const guard = (fn) => (...args) => serialise(() => fn(...args));
  return { read, create: guard(create), update: guard(update), remove: guard(remove), reorder: guard(reorder), clearDone: guard(clearDone), sort, PRIORITIES };
}

module.exports = { createStore, PRIORITIES };
