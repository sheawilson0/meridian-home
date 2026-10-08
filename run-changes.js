'use strict';

// Undo for Dogfood fixes. Feedback runs edit Meridian in place and Meridian
// is not a git repo, so before a run starts the text files it could edit are
// copied to delegations/<id>/before/ with a manifest of hashes. When the run
// ends, what changed goes to changes.json (per-file line counts and the
// post-run hash) and changes.diff (unified diff). Undo puts each file back,
// but only where the file is still exactly as the run left it: anything
// edited since is skipped and reported as a conflict, never overwritten.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execute } = require('./process-runner');

// Top-level folders that are state, not code, plus anything generated.
const SKIP_TOP = new Set(['data', 'cache', 'logs', 'delegations', 'ledger', 'audit']);
const SKIP_ANY = new Set(['node_modules', '.git']);
const MAX_BYTES = 2 * 1024 * 1024;
// changes.diff is served over the tailnet; these files hold tokens, so their
// diff text is withheld (the counts still show, and undo still covers them).
const SECRET_FILES = new Set(['config.json']);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const skipName = (name) => /\.bak/i.test(name) || /\.tmp$/i.test(name) || name === '.DS_Store';
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

async function list(root) {
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_ANY.has(e.name) || (!rel && SKIP_TOP.has(e.name))) continue;
        await walk(path.join(dir, e.name), r);
      } else if (e.isFile() && !skipName(e.name)) out.push(r);
    }
  }
  await walk(root, '');
  return out;
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function safeJoin(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) throw new Error(`path escapes the workdir: ${rel}`);
  return full;
}

async function hashOf(full) {
  try { return sha(await fsp.readFile(full)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Copies every editable text file. Returns counts and how long it took.
async function snapshot(workdir, runDir) {
  const t0 = Date.now();
  const before = path.join(runDir, 'before');
  const files = {};
  let bytes = 0; let binary = 0; let big = 0;
  await pool(await list(workdir), 16, async (rel) => {
    const full = path.join(workdir, rel);
    let st;
    try { st = await fsp.stat(full); } catch { return; }
    if (st.size > MAX_BYTES) { big++; return; }
    const buf = await fsp.readFile(full);
    if (isBinary(buf)) { binary++; return; }
    const copy = path.join(before, 'files', rel);
    await fsp.mkdir(path.dirname(copy), { recursive: true });
    await fsp.writeFile(copy, buf, { mode: SECRET_FILES.has(rel) ? 0o600 : 0o644 });
    files[rel] = { hash: sha(buf), size: buf.length };
    bytes += buf.length;
  });
  const manifest = { workdir, at: Date.now(), files, skipped: { binary, big } };
  await fsp.writeFile(path.join(before, 'manifest.json'), JSON.stringify(manifest) + '\n');
  return { files: Object.keys(files).length, bytes, ms: Date.now() - t0 };
}

function unifiedDiff(diffBin, a, b, rel) {
  return execute(diffBin, ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, a, b], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
    .then(result => String(result.stdout || ''), error => {
      // diff exits 1 when the files differ, which is the expected case.
      if (error.code === 1) return String(error.stdout || '');
      return `--- a/${rel}\n+++ b/${rel}\n@@ diff unavailable: ${String(error.message || error).slice(0, 200)} @@\n`;
    });
}

function countLines(diff) {
  let added = 0; let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// What the run changed, written next to the snapshot. Safe to call again:
// it always compares the snapshot with the workdir as it is now.
async function computeChanges(workdir, runDir, { diffBin = '/usr/bin/diff', extra = {} } = {}) {
  const t0 = Date.now();
  const before = path.join(runDir, 'before');
  const manifest = JSON.parse(await fsp.readFile(path.join(before, 'manifest.json'), 'utf8'));
  const known = manifest.files || {};
  const now = new Set(await list(workdir));
  const files = [];
  const diffs = [];
  // Files that were in the snapshot are always compared, even if they have
  // since grown past the size limit or turned binary.
  for (const rel of new Set([...Object.keys(known), ...now])) {
    const full = safeJoin(workdir, rel);
    let after = null;
    if (known[rel]) after = await hashOf(full);
    else {
      let st; try { st = await fsp.stat(full); } catch { continue; }
      if (st.size > MAX_BYTES) continue;
      const buf = await fsp.readFile(full);
      if (isBinary(buf)) continue;
      after = sha(buf);
    }
    const was = known[rel] ? known[rel].hash : null;
    if (was === after) continue;
    const status = !was ? 'added' : after === null ? 'deleted' : 'modified';
    const diff = await unifiedDiff(diffBin, was ? path.join(before, 'files', rel) : '/dev/null', after ? full : '/dev/null', rel);
    const { added, removed } = countLines(diff);
    files.push({ path: rel, status, added, removed, before: was, after });
    diffs.push([rel, SECRET_FILES.has(rel) ? `--- a/${rel}\n+++ b/${rel}\n@@ ${added} added, ${removed} removed; diff withheld because this file holds secrets @@\n` : diff]);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  diffs.sort((a, b) => a[0].localeCompare(b[0]));
  const total = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
  const record = { at: Date.now(), workdir, ms: Date.now() - t0, total, files, ...extra };
  await fsp.writeFile(path.join(runDir, 'changes.json'), JSON.stringify(record, null, 2) + '\n');
  await fsp.writeFile(path.join(runDir, 'changes.diff'), diffs.map(([, d]) => d).join(''));
  return record;
}

// The run's changes for state, or null when it has none on record.
function readChanges(runDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(runDir, 'changes.json'), 'utf8'));
    return {
      files: (c.files || []).map(({ path: p, status, added, removed }) => ({ path: p, status, added, removed })),
      total: c.total || { files: 0, added: 0, removed: 0 },
      at: c.at || null,
      concurrent: Array.isArray(c.concurrent) && c.concurrent.length ? c.concurrent : undefined,
    };
  } catch { return null; }
}

const hasSnapshot = (runDir) => fs.existsSync(path.join(runDir, 'before', 'manifest.json'));

// Restores each changed file to its snapshot, deleting files the run added,
// but only where the current hash still equals the post-run hash.
async function undo(workdir, runDir) {
  const changes = JSON.parse(await fsp.readFile(path.join(runDir, 'changes.json'), 'utf8'));
  const restored = [];
  const conflicts = [];
  for (const f of changes.files || []) {
    const full = safeJoin(workdir, f.path);
    const current = await hashOf(full);
    if (current !== f.after) {
      conflicts.push({ path: f.path, status: f.status, reason: current === null ? 'deleted since the run finished' : f.after === null ? 'recreated since the run finished' : 'edited since the run finished' });
      continue;
    }
    if (f.status === 'added') {
      await fsp.unlink(full);
    } else {
      const copy = safeJoin(path.join(runDir, 'before', 'files'), f.path);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      const buf = await fsp.readFile(copy);
      if (sha(buf) !== f.before) { conflicts.push({ path: f.path, status: f.status, reason: 'snapshot copy is damaged' }); continue; }
      let mode = 0o644;
      try { mode = (await fsp.stat(full)).mode & 0o777; } catch { /* deleted by the run: default mode */ }
      const tmp = `${full}.undo-${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf, { mode });
      await fsp.rename(tmp, full);
    }
    restored.push(f.path);
  }
  return { restored, conflicts };
}

module.exports = { snapshot, computeChanges, readChanges, hasSnapshot, undo, list, SKIP_TOP, MAX_BYTES };
