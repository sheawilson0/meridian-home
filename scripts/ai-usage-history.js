#!/usr/bin/env node
'use strict';

// Keeps data/ai-usage/history/daily-usage.csv, the source of truth for AI usage.
//
//   node scripts/ai-usage-history.js            rescan recent days on Home and Main, upsert
//   node scripts/ai-usage-history.js --seed     load the Sol 2026-10-01 metadata (full history)
//   node scripts/ai-usage-history.js --rewrite  recompute plan and api_value_usd only
//
// Options: --machines Home,Main  --seed-dir <dir>  --no-enrich (seed without the
// plan_type lookup, which reruns the collector in full on both Macs).
//
// Token columns are facts. A run only touches (machine, date) pairs inside its
// window, and never lowers a (machine, date, provider) total, so days
// whose Claude transcripts have since been deleted keep their numbers.
// plan and api_value_usd are recomputed from plans.json and the rate table on
// every write. Runs are serialised by a lock file; all writes are atomic.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require('../ai-usage-ledger');
const { DATA_DIR } = require('../runtime');

const ROOT = path.join(__dirname, '..');
const REMOTES = { Main: 'macbook-1' }; // machine -> ssh host
const WINDOW_DAYS = 10;
const BACKFILL_MARGIN_DAYS = 2;
const COLLECT_TIMEOUT_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 40 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

function defaultPaths(over = {}) {
  const dir = over.dir || path.join(DATA_DIR, 'ai-usage', 'history');
  return {
    dir,
    daily: path.join(dir, 'daily-usage.csv'),
    payments: path.join(dir, 'payments.csv'),
    state: path.join(dir, 'state.json'),
    lock: path.join(dir, '.lock'),
    plans: over.plans || path.join(DATA_DIR, 'ai-usage', 'plans', 'plans.json'),
    rates: over.rates || path.join(os.homedir(), '.t3', 'userdata', 'usage-model-rates.json'),
    collector: over.collector || path.join(ROOT, 'scripts', 'ai-usage-collect.py'),
    seedDir: over.seedDir || path.join(dir, 'sol-2026-10-01'),
  };
}

const PROVIDER_OF = { 'Claude Code': 'claude', Codex: 'openai' };
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';

// Collector events -> daily rows (facts only; plan and api_value_usd come later).
function eventsToRows(events, { machine, from = null, to = null }) {
  const rows = new Map();
  let skipped = 0;
  for (const e of events) {
    const provider = PROVIDER_OF[e && e.provider];
    const ms = e && typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!provider || !Number.isFinite(ms) || !Array.isArray(e.tokens)) { skipped++; continue; }
    const date = L.londonDay(ms);
    if ((from && date < from) || (to && date > to)) continue;
    const t = [0, 1, 2, 3].map((i) => (Number.isInteger(e.tokens[i]) && e.tokens[i] > 0 ? e.tokens[i] : 0));
    const profile = String(e.profile || '');
    const model = String(e.model || 'unknown');
    const planType = provider === 'openai' && typeof e.plan_type === 'string' ? e.plan_type : '';
    const key = [date, provider, profile, model, planType].join('\u0000');
    let r = rows.get(key);
    if (!r) {
      rows.set(key, (r = { date, machine, provider, profile, model, plan_type: planType, plan: '', input: 0, cache_read: 0, cache_write: 0, output: 0,
        total_tokens: 0, events: 0, sessions: new Set(), api_value_usd: 0 }));
    }
    r.input += t[0]; r.cache_read += t[1]; r.cache_write += t[2]; r.output += t[3];
    r.events += 1;
    r.sessions.add(String(e.session || ''));
  }
  const out = [...rows.values()].map((r) => ({ ...r, sessions: r.sessions.size, total_tokens: r.input + r.cache_read + r.cache_write + r.output }));
  return Object.assign(out, { skipped });
}

// Replace a machine's rows inside [from, to] (null = unbounded) with fresh ones,
// per (date, provider) group, unless the fresh group total is lower
// (kept) or the same (unchanged).
function upsert(existing, fresh, { machine, from = null, to = null }) {
  const inWindow = (r) => r.machine === machine && (!from || r.date >= from) && (!to || r.date <= to);
  // Per provider-day, not per profile: Main's .codex_p mirrors .codex, so an event
  // can move profile between scans without the day's total changing.
  const group = (r) => [r.date, r.provider].join('\u0000');
  const collect = (rows) => {
    const m = new Map();
    for (const r of rows) if (inWindow(r)) { const g = group(r); if (!m.has(g)) m.set(g, []); m.get(g).push(r); }
    return m;
  };
  const total = (rows) => rows.reduce((s, r) => s + r.total_tokens, 0);
  const oldG = collect(existing);
  const newG = collect(fresh);
  const rows = existing.filter((r) => !inWindow(r));
  const counts = { replaced: 0, added: 0, unchanged: 0, kept: 0, keptTokens: 0 };
  for (const [g, rs] of newG) {
    const old = oldG.get(g);
    if (old && total(rs) < total(old)) { rows.push(...old); counts.kept++; counts.keptTokens += total(old) - total(rs); continue; }
    if (old && total(rs) === total(old)) { rows.push(...old); counts.unchanged++; continue; } // same facts: keep what is there (e.g. plan_type)
    rows.push(...rs);
    if (!old) counts.added++; else counts.replaced++;
  }
  for (const [g, old] of oldG) if (!newG.has(g)) { rows.push(...old); counts.kept++; counts.keptTokens += total(old); }
  return { rows, ...counts };
}

function finalise(rows, { rules, rates }) {
  for (const r of rows) {
    r.total_tokens = r.input + r.cache_read + r.cache_write + r.output;
    r.plan = L.resolvePlan(rules, { provider: r.provider, profile: r.profile, date: r.date, planType: r.plan_type || null, machine: r.machine }) || '';
    r.api_value_usd = L.round6(rates.cost(r.model, { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write }, r.provider));
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => cmp(a.date, b.date) || cmp(a.machine, b.machine) || cmp(a.provider, b.provider) || cmp(a.profile, b.profile) || cmp(a.model, b.model) || cmp(a.plan_type, b.plan_type));
  return rows;
}

// From (last success - 2 days) or 10 days back, whichever is earlier.
// Never scanned: null, a full scan.
function windowFrom(machineState, today) {
  if (!machineState || !machineState.lastSuccess || !Number.isFinite(Date.parse(machineState.lastSuccess))) return null;
  const a = L.addDays(L.londonDay(Date.parse(machineState.lastSuccess)), -BACKFILL_MARGIN_DAYS);
  const b = L.addDays(today, -WINDOW_DAYS);
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// Payments seeded from the Sol files (payments.json + work-billing.json)

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
function isoDate(s) {
  if (L.validDate(s)) return s;
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(String(s || '').trim());
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function solPayments(payments, workBilling) {
  const out = [];
  const warnings = [];
  for (const p of Array.isArray(payments) ? payments : []) {
    const cat = String(p.category || '');
    const acct = String(p.account || '').toLowerCase();
    const date = isoDate(p.paid_date);
    let row;
    if (/claude pro/i.test(cat) && acct.includes('gmail')) row = { plan: 'claude-pro-gmail', provider: 'claude', account: 'Personal (Gmail)', payer: 'you', kind: 'subscription' };
    else if (/claude pro/i.test(cat) && acct.includes('ulster')) row = { plan: 'claude-pro-ulster', provider: 'claude', account: 'Ulster University', payer: 'you', kind: 'subscription' };
    else if (/chatgpt plus/i.test(cat)) row = { plan: 'chatgpt-plus', provider: 'openai', account: 'Personal', payer: 'you', kind: 'subscription' };
    else if (/openai api/i.test(cat)) row = { plan: '', provider: 'openai', account: 'OpenAI API, org "Personal" (work email)', payer: '', kind: 'api-credit' };
    else if (/api credit/i.test(cat)) row = { plan: '', provider: '', account: 'Personal (Gmail)', payer: 'you', kind: 'api-credit' };
    if (!row || !date || !p.receipt) { warnings.push(`skipped payment ${p.receipt || '?'} (${cat})`); continue; }
    const notes = [];
    if (p.receipt_file) notes.push(p.receipt_file);
    const sym = { GBP: '£', USD: '$', EUR: '€' }[p.currency] || '';
    if (typeof p.net_amount === 'number' && typeof p.tax_amount === 'number') notes.push(`${sym}${p.net_amount} + ${sym}${p.tax_amount} tax`);
    if (row.kind === 'api-credit' && !row.provider) notes.push('Issuer not recorded; sent to the personal Gmail used for Claude Pro, so probably Anthropic API credits');
    if (row.kind === 'api-credit' && !row.payer) notes.push('payer not established');
    if (p.note) notes.push(p.note);
    if (!notes.length && p.source && !/^https?:/.test(p.source)) notes.push(p.source);
    out.push({ date, ...row, currency: p.currency, amount: p.amount, status: p.amount === 0 ? 'free' : 'paid', reference: p.receipt, note: notes.join('; ') });
  }
  for (const inv of (workBilling && Array.isArray(workBilling.invoices)) ? workBilling.invoices : []) {
    const date = isoDate(inv.date);
    if (!date || !inv.reference) { warnings.push(`skipped invoice ${inv.reference || '?'}`); continue; }
    out.push({
      date, plan: /chatgpt business/i.test(inv.category || '') ? 'chatgpt-business' : '', provider: /chatgpt/i.test(inv.category || '') ? 'openai' : '',
      account: 'Example Agency', payer: 'work', currency: inv.currency, amount: inv.amount, kind: 'invoice',
      status: /unverified/i.test(inv.status || '') ? 'unverified' : 'paid', reference: inv.reference,
      note: [inv.category, inv.period, inv.receipt_file, inv.note].filter(Boolean).join('; '),
    });
  }
  return { rows: out, warnings };
}

// Adds payments whose reference is new. Existing text is kept byte for byte.
function appendPayments(existingText, incoming) {
  const parsed = existingText ? L.parseCsv(existingText) : { header: [], rows: [] };
  const header = parsed.header.length ? parsed.header : L.PAYMENT_COLUMNS;
  const seen = new Set(parsed.rows.map((r) => r.reference));
  const added = [];
  for (const r of incoming) if (!seen.has(r.reference)) { seen.add(r.reference); added.push(r); }
  if (!added.length && existingText) return { text: existingText, added: 0 };
  const body = L.toCsv(header, added).split('\n').slice(1).join('\n');
  const base = existingText ? (existingText.endsWith('\n') ? existingText : existingText + '\n') : header.join(',') + '\n';
  return { text: base + body, added: added.length };
}

// ---------------------------------------------------------------------------
// Running the collector, locally or on another Mac over ssh

function runCollector({ ssh = null, since = null, collector, home = null, timeoutMs = COLLECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = [...(since ? ['--since', since] : []), ...(home ? ['--home', home] : [])];
    const python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
    const t0 = Date.now();
    const child = ssh
      ? spawn('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh, ['python3', '-', ...args].join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(python, [collector, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let killed = null;
    const timer = setTimeout(() => { killed = 'timed out'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { size += c.length; if (size > MAX_OUTPUT_BYTES) { killed = 'output too large'; child.kill('SIGKILL'); } else chunks.push(c); });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const who = ssh ? `ssh ${ssh}` : 'collector';
      if (killed) return reject(new Error(`${who} ${killed}`));
      if (code !== 0) return reject(new Error(`${who} exited ${code === null ? signal : code}${lastLine(stderr) ? ': ' + lastLine(stderr) : ''}`));
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error(`${who} output is not JSON`)); }
      if (!data || !Array.isArray(data.events)) return reject(new Error(`${who} output has no events`));
      resolve({ data, ms: Date.now() - t0, bytes: size });
    });
    if (ssh) {
      child.stdin.on('error', () => {});
      fs.createReadStream(collector).on('error', (e) => { child.kill('SIGKILL'); reject(e); }).pipe(child.stdin);
    }
  });
}

// ---------------------------------------------------------------------------
// Lock, state

async function withLock(lockFile, fn) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(lockFile, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await fh.close();
      try { return await fn(); } finally { await fsp.rm(lockFile, { force: true }); }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await fsp.stat(lockFile).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fsp.rm(lockFile, { force: true }); continue; }
      throw Object.assign(new Error('another ai-usage-history run is in progress'), { code: 'LOCKED' });
    }
  }
  throw Object.assign(new Error('could not take the ai-usage-history lock'), { code: 'LOCKED' });
}

async function readState(file) {
  const r = await L.readJson(file);
  const s = r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
  if (!s.machines || typeof s.machines !== 'object') s.machines = {};
  return s;
}
const writeState = (file, state) => L.writeJsonAtomic(file, { version: 1, ...state, updatedAt: new Date().toISOString() }, true);

async function loadRulesAndRates(p) {
  const plans = await L.readPlansDoc(p.plans);
  const rates = L.createRates({ file: p.rates });
  rates.load();
  return { rules: plans.rules, plansError: plans.error, rates };
}

async function writeDaily(p, rows) {
  await L.writeAtomic(p.daily, L.toCsv(L.DAILY_COLUMNS, rows));
}

async function readDailyStrict(p) {
  const d = await L.readDailyCsv(p.daily);
  if (d.error) throw new Error(d.error);
  if (d.invalid) throw new Error(`daily-usage.csv has ${d.invalid} unreadable rows; fix them before the next write so nothing is lost`);
  return d;
}

function machineList(only, localMachine) {
  const all = [{ name: localMachine, ssh: null }, ...Object.entries(REMOTES).map(([name, ssh]) => ({ name, ssh }))];
  return only ? all.filter((m) => only.some((o) => L.sameMachine(o, m.name))) : all;
}

// ---------------------------------------------------------------------------
// Modes

async function scan(o) {
  const p = o.paths;
  const started = Date.now();
  return withLock(p.lock, async () => {
    const today = L.londonDay(started);
    const state = await readState(p.state);
    const results = await Promise.all(machineList(o.machines, o.localMachine).map(async (m) => {
      const from = windowFrom(state.machines[m.name], today);
      const startedAt = Date.now();
      try {
        const { data, ms, bytes } = await runCollector({ ssh: m.ssh, since: from, collector: p.collector, home: m.ssh ? null : o.home });
        if (!L.sameMachine(data.host, m.name)) throw new Error(`expected ${m.name} but the collector ran on ${data.host}`);
        const rows = eventsToRows(data.events, { machine: m.name, from, to: today });
        return { m, ok: true, from, to: today, rows, startedAt, collectMs: ms, bytes, events: data.events.length, scanMs: data.scan_ms };
      } catch (e) {
        return { m, ok: false, from, startedAt, error: String(e.message || e) };
      }
    }));
    const { rules, plansError, rates } = await loadRulesAndRates(p);
    let rows = (await readDailyStrict(p)).rows;
    const summary = { mode: 'scan', machines: {} };
    for (const r of results) {
      const prev = state.machines[r.m.name] || {};
      const base = { ...prev, lastAttempt: new Date(r.startedAt).toISOString() };
      if (!r.ok) {
        state.machines[r.m.name] = { ...base, error: r.error, errorAt: new Date().toISOString() };
        summary.machines[r.m.name] = { ok: false, error: r.error, window: { from: r.from, to: today } };
        continue;
      }
      const up = upsert(rows, r.rows, { machine: r.m.name, from: r.from, to: r.to });
      rows = up.rows;
      const info = { window: { from: r.from, to: r.to }, collectMs: r.collectMs, scanMs: r.scanMs, bytes: r.bytes, events: r.events, rows: r.rows.length,
        groups: { replaced: up.replaced, added: up.added, unchanged: up.unchanged, kept: up.kept }, keptTokens: up.keptTokens };
      state.machines[r.m.name] = { ...base, lastSuccess: new Date(r.startedAt).toISOString(), coveredThrough: L.addDays(L.londonDay(r.startedAt), -1),
        error: null, errorAt: null, ...info };
      summary.machines[r.m.name] = { ok: true, ...info };
    }
    finalise(rows, { rules, rates });
    await writeDaily(p, rows);
    const errors = results.filter((r) => !r.ok).map((r) => `${r.m.name}: ${r.error}`);
    state.lastRun = { mode: 'scan', startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), ms: Date.now() - started,
      ok: errors.length === 0, errors, csvRows: rows.length, ...(plansError ? { plansError } : {}) };
    await writeState(p.state, state);
    return { ...summary, ms: Date.now() - started, csvRows: rows.length, errors };
  });
}

async function seed(o) {
  const p = o.paths;
  const started = Date.now();
  return withLock(p.lock, async () => {
    const names = (await fsp.readdir(p.seedDir)).filter((f) => f.endsWith('-metadata.json')).sort();
    if (!names.length) throw new Error(`no *-metadata.json files in ${p.seedDir}`);
    const loaded = [];
    for (const f of names) {
      const full = path.join(p.seedDir, f);
      const data = JSON.parse(await fsp.readFile(full, 'utf8'));
      if (!Array.isArray(data.events)) throw new Error(`${f} has no events`);
      loaded.push({ file: f, data, machine: L.shortMachine(data.host), collectedAt: (await fsp.stat(full)).mtimeMs });
    }
    // The Sol collector did not record Codex plan_type. Codex logs are never
    // deleted, so a full fresh collection supplies it, joined by event key.
    const planTypes = new Map();
    const enrich = {};
    if (o.enrich) {
      await Promise.all(machineList(null, o.localMachine).filter((m) => loaded.some((l) => l.machine === m.name)).map(async (m) => {
        try {
          const { data, ms } = await runCollector({ ssh: m.ssh, collector: p.collector, home: m.ssh ? null : o.home });
          let n = 0;
          for (const e of data.events) if (e.plan_type) { planTypes.set(e.key, e.plan_type); n++; }
          enrich[m.name] = { ok: true, ms, events: data.events.length, withPlanType: n };
        } catch (e) { enrich[m.name] = { ok: false, error: String(e.message || e) }; }
      }));
    }
    const seenKeys = new Map();
    let crossDuplicates = 0;
    const { rules, plansError, rates } = await loadRulesAndRates(p);
    let rows = (await readDailyStrict(p)).rows;
    const state = await readState(p.state);
    const machines = {};
    for (const l of loaded) {
      let joined = 0;
      const events = l.data.events.map((e) => {
        if (seenKeys.has(e.key) && seenKeys.get(e.key) !== l.machine) crossDuplicates++;
        seenKeys.set(e.key, l.machine);
        const pt = e.provider === 'Codex' ? planTypes.get(e.key) : null;
        if (pt) joined++;
        return pt ? { ...e, plan_type: pt } : e;
      });
      const fresh = eventsToRows(events, { machine: l.machine });
      const up = upsert(rows, fresh, { machine: l.machine });
      rows = up.rows;
      const tokens = events.reduce((s, e) => s + e.tokens.reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0), 0);
      machines[l.machine] = { file: l.file, events: events.length, tokens, rows: fresh.length, planTypeJoined: joined,
        groups: { replaced: up.replaced, added: up.added, unchanged: up.unchanged, kept: up.kept } };
      const prev = state.machines[l.machine] || {};
      if (!prev.lastSuccess || Date.parse(prev.lastSuccess) < l.collectedAt) {
        state.machines[l.machine] = { ...prev, lastSuccess: new Date(l.collectedAt).toISOString(), coveredThrough: L.addDays(L.londonDay(l.collectedAt), -1),
          error: null, source: `seed ${path.basename(p.seedDir)}` };
      }
    }
    finalise(rows, { rules, rates });
    await writeDaily(p, rows);

    let payments = { added: 0, warnings: [] };
    const solPay = await L.readJson(path.join(p.seedDir, 'payments.json'));
    const work = await L.readJson(path.join(p.seedDir, 'work-billing.json'));
    if (solPay.value || work.value) {
      const incoming = solPayments(solPay.value, work.value);
      const existing = await fsp.readFile(p.payments, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; });
      const out = appendPayments(existing, incoming.rows);
      if (out.added) await L.writeAtomic(p.payments, out.text);
      payments = { added: out.added, warnings: incoming.warnings };
    }
    state.seed = { dir: path.relative(ROOT, p.seedDir), at: new Date().toISOString(), machines, crossMachineDuplicateKeys: crossDuplicates, enrich, payments };
    state.lastRun = { mode: 'seed', startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), ms: Date.now() - started, ok: true, errors: [],
      csvRows: rows.length, ...(plansError ? { plansError } : {}) };
    await writeState(p.state, state);
    return { mode: 'seed', ms: Date.now() - started, csvRows: rows.length, machines, enrich, crossMachineDuplicateKeys: crossDuplicates, payments };
  });
}

async function rewrite(o) {
  const p = o.paths;
  const started = Date.now();
  return withLock(p.lock, async () => {
    const { rules, plansError, rates } = await loadRulesAndRates(p);
    const rows = finalise((await readDailyStrict(p)).rows, { rules, rates });
    await writeDaily(p, rows);
    const state = await readState(p.state);
    state.lastRewrite = { at: new Date().toISOString(), ms: Date.now() - started, csvRows: rows.length, ...(plansError ? { plansError } : {}) };
    await writeState(p.state, state);
    return { mode: 'rewrite', ms: Date.now() - started, csvRows: rows.length, plansError };
  });
}

function parseArgs(argv) {
  const o = { mode: 'scan', enrich: true, machines: null, over: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') o.mode = 'seed';
    else if (a === '--rewrite') o.mode = 'rewrite';
    else if (a === '--no-enrich') o.enrich = false;
    else if (a === '--machines') o.machines = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--seed-dir') o.over.seedDir = path.resolve(argv[++i]);
    else if (a === '--dir') o.over.dir = path.resolve(argv[++i]);
    else if (a === '--plans') o.over.plans = path.resolve(argv[++i]);
    else if (a === '--rates') o.over.rates = path.resolve(argv[++i]);
    else if (a === '--home') o.home = path.resolve(argv[++i]);
    else if (a === '--local-machine') o.localMachine = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  o.paths = defaultPaths(o.over);
  o.localMachine ||= L.shortMachine(os.hostname());
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  const run = o.mode === 'seed' ? seed : o.mode === 'rewrite' ? rewrite : scan;
  const out = await run(o);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

module.exports = { eventsToRows, upsert, finalise, windowFrom, solPayments, appendPayments, isoDate, runCollector, withLock, parseArgs, scan, seed, rewrite, defaultPaths };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ai-usage-history: ${e.message || e}\n`);
    process.exitCode = e.code === 'LOCKED' ? 75 : 1;
  });
}
