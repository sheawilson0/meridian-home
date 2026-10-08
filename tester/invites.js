'use strict';

// Who's been invited to try Meridian, and how their test is going (7 Oct 2026).
// One JSON file. An invite's id is its link (/t/<id>), so it's long and random;
// its agentToken opens only that tester's MCP server and can be swapped.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const clean = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const rid = (n) => { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; const b = crypto.randomBytes(n); let s = ''; for (const x of b) s += a[x % a.length]; return s; };

function createInvites({ file }) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')).invites || []; } catch { /* first run */ }
  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      try { await fsp.writeFile(tmp, JSON.stringify({ invites: list }, null, 1)); await fsp.rename(tmp, file); } catch (e) { console.error('invites save failed', e.message); }
    }, 200);
  }
  const get = (id) => list.find((x) => x.id === id) || null;
  const byAgentToken = (t) => (t && list.find((x) => x.agentToken === t)) || null;

  function create({ name, mode = 'moderated', world = 'sam', note = '' }) {
    const inv = { id: rid(12), name: clean(name, 40) || 'Tester', mode: mode === 'self' ? 'self' : 'moderated', world: world === 'blank' ? 'blank' : 'sam', note: clean(note, 500),
      created: Date.now(), agentToken: rid(24), consent: null, task: null, seq: {}, taskLog: [], answers: null, notes: [], lastSeen: null, opened: null, finished: null };
    list.push(inv); save(); return inv;
  }
  function update(id, patch) {
    const inv = get(id); if (!inv) return null;
    for (const k of ['name', 'mode', 'world', 'note']) if (patch[k] !== undefined) inv[k] = k === 'mode' ? (patch[k] === 'self' ? 'self' : 'moderated') : k === 'world' ? (patch[k] === 'blank' ? 'blank' : 'sam') : clean(patch[k], k === 'note' ? 500 : 40);
    save(); return inv;
  }
  function mutate(id, fn) { const inv = get(id); if (!inv) return null; fn(inv); save(); return inv; }
  function remove(id) { const n = list.length; list = list.filter((x) => x.id !== id); save(); return list.length < n; }
  function newAgentToken(id) { return mutate(id, (inv) => { inv.agentToken = rid(24); }); }

  return { all: () => list.slice(), get, byAgentToken, create, update, mutate, remove, newAgentToken };
}

module.exports = { createInvites };
