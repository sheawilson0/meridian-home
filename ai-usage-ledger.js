'use strict';
const runtime = require('./runtime');
const jobsEnabled = () => runtime.connectorEnabled('aiUsage');
const { DATA_DIR, CACHE_DIR } = runtime;

// AI usage ledger: daily tokens and API-equivalent cost per provider, plan,
// model, machine and profile, for the dashboard's AI usage tab.
//
// Rows, lowest precedence first:
//   1. data/ai-usage/history/daily-usage.csv, the source of truth, kept by
//      scripts/ai-usage-history.js (run by startHistory() every 6 hours).
//   2. Live rows for days the CSV has not fully covered yet (normally today):
//      this Mac's Claude Code and Codex logs, scanned incrementally (a port of
//      ~/Developer/ai-usage-bar/Sources/Activity.swift, with the history
//      collector's Claude dedupe), and other Macs'
//      menu bar reports in data/ai-usage/<host>.json (approx rows).
//   3. Imports in data/ai-usage/import/*.json (contract: docs/ai-usage-import.md).
// Plans and attribution rules: data/ai-usage/plans/plans.json.
// Payments: data/ai-usage/history/payments.csv.
//
// Never put loose .json files directly in data/ai-usage/: server.js serves every
// one of them to the menu bar app as a host report, and one odd file breaks its
// decoding. Everything else lives in subfolders.
//
// Zero dependencies. server.js calls handle(req, res, url) and startHistory().

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { capProcess } = require('./process-runner');

const PARSER_VERSION = 3;
const CACHE_MS = 5 * 60 * 1000;
const PROVIDERS = { claude: 'Claude', openai: 'ChatGPT' };
const IMPORT_SCHEMA = 'meridian.ai-usage.import/1';
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const IMPORT_MAX_ROWS = 50000;
const PLANS_MAX = 50;
const RULES_MAX = 100;
const BODY_LIMIT = 256 * 1024;
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP';
const FX_FALLBACK = 0.76;
const TZ = 'Europe/London';

const DAILY_COLUMNS = ['date', 'machine', 'provider', 'profile', 'model', 'plan_type', 'plan', 'input', 'cache_read', 'cache_write', 'output', 'total_tokens', 'events', 'sessions', 'api_value_usd'];
const DAILY_NUMBERS = ['input', 'cache_read', 'cache_write', 'output', 'total_tokens', 'events', 'sessions'];
const PAYMENT_COLUMNS = ['date', 'plan', 'provider', 'account', 'payer', 'currency', 'amount', 'kind', 'status', 'reference', 'note'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const intOr0 = (v) => (Number.isInteger(v) ? v : 0); // Swift: `x as? Int ?? 0`
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Local calendar day in Europe/London, "YYYY-MM-DD".
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function londonDay(ms) { return dayFormat.format(ms); }
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Swift parseDate: ISO 8601 internet date-time, with or without fractions.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
function parseTimestamp(v) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---------------------------------------------------------------------------
// Rates: the LiteLLM table T3 Code caches, with the Swift app's built-in fallback.

const rate = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
const FALLBACK_RATES = new Map(Object.entries({
  'claude-fable-5': rate(10e-6, 50e-6, 1e-6, 12.5e-6),
  'claude-opus-5': rate(5e-6, 25e-6, 0.5e-6, 6.25e-6),
  'claude-opus-4': rate(5e-6, 25e-6, 0.5e-6, 6.25e-6),
  'claude-sonnet-5': rate(2e-6, 10e-6, 0.2e-6, 2.5e-6),
  'claude-sonnet-4': rate(3e-6, 15e-6, 0.3e-6, 3.75e-6),
  'claude-haiku-4': rate(1e-6, 5e-6, 0.1e-6, 1.25e-6),
  'gpt-5.6-sol': rate(5e-6, 30e-6, 0.5e-6, 6.25e-6),
  'gpt-5.6-terra': rate(2e-6, 12e-6, 0.2e-6, 2.5e-6),
  'gpt-5.6-luna': rate(0.2e-6, 1.2e-6, 0.02e-6, 0.25e-6),
  'gpt-5.6': rate(5e-6, 30e-6, 0.5e-6, 6.25e-6),
  'gpt-5.5': rate(5e-6, 30e-6, 0.5e-6, 0),
  'gpt-5': rate(1.25e-6, 10e-6, 0.125e-6, 0),
}));

// Swift Rates.rate(for:): the model, then without a trailing -YYYYMMDD stamp,
// then progressively dropping the last "-" segment.
function rateCandidates(model) {
  const out = [model];
  let s = model;
  const stamp = /-\d{8}$/.exec(s);
  if (stamp) { s = s.slice(0, stamp.index); out.push(s); }
  let i;
  while ((i = s.lastIndexOf('-')) >= 0) { s = s.slice(0, i); out.push(s); }
  return out;
}

function tableFromDocument(doc) {
  const t = new Map();
  if (!isObj(doc)) return t;
  for (const [k, m] of Object.entries(doc)) {
    if (!isObj(m) || typeof m.input_cost_per_token !== 'number' || typeof m.output_cost_per_token !== 'number') continue;
    const i = m.input_cost_per_token;
    t.set(k, rate(i, m.output_cost_per_token,
      typeof m.cache_read_input_token_cost === 'number' ? m.cache_read_input_token_cost : i * 0.1,
      typeof m.cache_creation_input_token_cost === 'number' ? m.cache_creation_input_token_cost : i * 1.25));
  }
  return t;
}

function createRates({ file = null, document = null } = {}) {
  let table = tableFromDocument(document);
  let source = table.size ? 'rate table' : 'built-in table';
  let fetchedAt = null;
  let loadedKey = null;
  const memo = new Map();

  function load() {
    if (!file) return;
    let st;
    try { st = fs.statSync(file); } catch { return; }
    const key = `${st.size}:${st.mtimeMs}`;
    if (key === loadedKey) return;
    loadedKey = key;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const t = tableFromDocument(j && j.document);
      if (t.size) {
        table = t;
        source = 'T3 Code rate table';
        fetchedAt = typeof j.fetchedAtMs === 'number' ? new Date(j.fetchedAtMs).toISOString() : null;
        memo.clear();
      }
    } catch { /* keep the previous table */ }
  }

  // Returns { rate, key, from } where from is 'table', 'built-in' or 'default'.
  function lookup(model) {
    const m = String(model);
    if (memo.has(m)) return memo.get(m);
    let found = null;
    for (const c of rateCandidates(m)) {
      if (table.has(c)) { found = { rate: table.get(c), key: c, from: 'table' }; break; }
      if (FALLBACK_RATES.has(c)) { found = { rate: FALLBACK_RATES.get(c), key: c, from: 'built-in' }; break; }
    }
    if (!found) {
      const key = m.startsWith('claude') ? 'claude-opus-5' : 'gpt-5.6';
      found = { rate: FALLBACK_RATES.get(key), key, from: 'default' };
    }
    memo.set(m, found);
    return found;
  }

  // No model (report rows, imports, Codex sessions without a turn context)
  // prices at the Swift default for the provider.
  function lookupFor(model, provider) {
    if (model && model !== 'unknown') return lookup(model);
    const key = provider === 'claude' ? 'claude-opus-5' : 'gpt-5.6';
    return { rate: FALLBACK_RATES.get(key), key, from: 'default' };
  }

  function cost(model, t, provider) {
    const r = lookupFor(model, provider).rate;
    return (t.input || 0) * r.input + (t.output || 0) * r.output + (t.cacheRead || 0) * r.cacheRead + (t.cacheWrite || 0) * r.cacheWrite;
  }

  return { load, lookup, lookupFor, cost, get source() { return source; }, get fetchedAt() { return fetchedAt; } };
}

// ---------------------------------------------------------------------------
// Names and labels

function titleWord(w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }

function modelLabel(model) {
  if (!model) return 'Unknown model';
  const s = String(model).replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  if (/^claude(-|$)/i.test(s)) {
    const parts = s.split('-').slice(1).filter(Boolean);
    const words = parts.filter((p) => !/^\d+$/.test(p)).map(titleWord);
    const nums = parts.filter((p) => /^\d+$/.test(p));
    return [words.join(' '), nums.join('.')].filter(Boolean).join(' ') || 'Claude';
  }
  const g = /^gpt-([^-]+)(?:-(.+))?$/i.exec(s);
  if (g) return ['GPT-' + g[1], ...(g[2] ? g[2].split('-').filter(Boolean).map(titleWord) : [])].join(' ');
  if (/^o\d/i.test(s)) return s.split('-').map((w, i) => (i === 0 ? w.toLowerCase() : titleWord(w))).join(' ');
  return s.split(/[-_]+/).filter(Boolean).map((w) => (/^\d/.test(w) ? w : titleWord(w))).join(' ');
}

// "Owner’s MacBook Pro Main" / "Example-MacBook-Pro-Main.local" -> "Main"
function shortMachine(name) {
  const s = String(name || '').trim().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /\b(?:MacBook(?: Pro| Air)?|Mac ?mini|Mac Studio|Mac Pro|iMac(?: Pro)?)\b\s*(.*)$/i.exec(s);
  const rest = m ? m[1].trim() : s.replace(/^\S+[’']s\s+/, '').trim();
  return rest || s;
}
const machineKey = (name) => String(name || '').toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]/g, '');
const sameMachine = (a, b) => machineKey(shortMachine(a)) === machineKey(shortMachine(b));

// Swift codexPlanName: "self_serve_business_prolite" -> "Business Pro Lite"
function codexPlanName(raw) {
  const s = String(raw).replace(/self_serve_/g, '').replace(/prolite/g, 'pro lite');
  return s.split('_').map((part) => part.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ')).join(' ');
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(columns, rows) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvField(r[c])).join(','))].join('\n') + '\n';
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') records.push(row); }
  if (!records.length) return { header: [], rows: [] };
  const header = records[0];
  return { header, rows: records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? '' : r[i]]))) };
}

function dailyRowFromCsv(r) {
  if (!validDate(r.date) || !r.machine || !has(PROVIDERS, r.provider)) return null;
  const out = { date: r.date, machine: r.machine, provider: r.provider, profile: r.profile || '', model: r.model || 'unknown', plan_type: r.plan_type || '', plan: r.plan || '' };
  for (const k of DAILY_NUMBERS) {
    const n = Number(r[k] || 0);
    if (!Number.isInteger(n) || n < 0) return null;
    out[k] = n;
  }
  out.api_value_usd = Number(r.api_value_usd) || 0;
  return out;
}

async function readDailyCsv(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, rows: [], invalid: 0 };
    return { exists: true, rows: [], invalid: 0, error: e.code || String(e.message) };
  }
  const { header, rows } = parseCsv(text);
  const missing = DAILY_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { exists: true, rows: [], invalid: 0, error: `daily-usage.csv is missing columns: ${missing.join(', ')}` };
  const out = [];
  let invalid = 0;
  for (const r of rows) { const d = dailyRowFromCsv(r); if (d) out.push(d); else invalid++; }
  return { exists: true, rows: out, invalid };
}

const PAYMENT_KINDS = new Set(['subscription', 'api-credit', 'invoice']);
const PAYMENT_STATUSES = new Set(['paid', 'unverified', 'free']);

function normalisePayment(r) {
  const amount = Number(r.amount);
  if (!validDate(r.date) || !r.reference || !Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(r.currency || '')) return null;
  if (!PAYMENT_KINDS.has(r.kind) || !PAYMENT_STATUSES.has(r.status)) return null;
  return {
    date: r.date, plan: r.plan || null, provider: has(PROVIDERS, r.provider) ? r.provider : null, account: r.account || null,
    payer: r.payer === 'you' || r.payer === 'work' ? r.payer : null, currency: r.currency, amount, kind: r.kind, status: r.status,
    reference: r.reference, note: r.note || null,
  };
}

async function readPaymentsCsv(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, payments: [], invalid: 0, duplicates: 0 };
    return { exists: true, payments: [], invalid: 0, duplicates: 0, error: e.code || String(e.message) };
  }
  const { rows } = parseCsv(text);
  const seen = new Set();
  const payments = [];
  let invalid = 0;
  let duplicates = 0;
  for (const r of rows) {
    const p = normalisePayment(r);
    if (!p) { invalid++; continue; }
    if (seen.has(p.reference)) { duplicates++; continue; }
    seen.add(p.reference);
    payments.push(p);
  }
  payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.reference.localeCompare(b.reference));
  return { exists: true, payments, invalid, duplicates };
}

// ---------------------------------------------------------------------------
// Local log parsing (Activity.swift ActivityScanner.parse)

function addTokens(days, ms, model, planType, t) {
  const day = londonDay(ms);
  let byKey = days.get(day);
  if (!byKey) days.set(day, (byKey = new Map()));
  const key = model + '\u0000' + (planType || '');
  const cur = byKey.get(key);
  if (cur) { cur[2] += t[0]; cur[3] += t[1]; cur[4] += t[2]; cur[5] += t[3]; } else byKey.set(key, [model, planType || null, t[0], t[1], t[2], t[3]]);
}

// days: { "YYYY-MM-DD": [[model, planType, input, cacheRead, cacheWrite, output], ...] }
function daysToJson(days) {
  const out = {};
  for (const [day, byKey] of days) out[day] = [...byKey.values()];
  return out;
}

function lineReader(file, size) {
  const opts = { encoding: 'utf8', highWaterMark: 1 << 20 };
  if (Number.isInteger(size) && size > 0) opts.end = size - 1; // parse exactly what we stat'd
  return readline.createInterface({ input: fs.createReadStream(file, opts), crlfDelay: Infinity });
}

// Claude Code repeats an assistant message once per streamed content block.
// Like the history collector (and unlike the Swift app, which keeps the first
// copy), keep the most complete usage per message id: later copies can carry
// the final output count, and output is the expensive part.
async function parseClaudeFile(file, { size } = {}) {
  const days = new Map();
  if (size === 0) return {};
  const best = new Map(); // message id -> [ms, model, tokens]
  for await (const line of lineReader(file, size)) {
    if (!line.includes('"type":"assistant"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!isObj(j)) continue;
    const msg = j.message;
    if (!isObj(msg) || !isObj(msg.usage)) continue;
    const ts = parseTimestamp(j.timestamp);
    if (ts === null) continue;
    const model = typeof msg.model === 'string' ? msg.model : 'claude';
    if (model.startsWith('<')) continue; // <synthetic>
    const u = msg.usage;
    const t = [intOr0(u.input_tokens), intOr0(u.cache_read_input_tokens), intOr0(u.cache_creation_input_tokens), intOr0(u.output_tokens)];
    const sum = t[0] + t[1] + t[2] + t[3];
    if (sum === 0) continue;
    if (typeof msg.id !== 'string') { addTokens(days, ts, model, null, t); continue; }
    const prev = best.get(msg.id);
    if (!prev || sum > prev[3]) best.set(msg.id, [ts, model, t, sum]);
  }
  for (const [ts, model, t] of best.values()) addTokens(days, ts, model, null, t);
  return daysToJson(days);
}

// Records each event's rate_limits.plan_type. Events without one take the last
// one seen in the file, else the first one seen later, else fallbackPlan.
async function parseCodexFile(file, { size, fallbackPlan = null, planFor = (raw) => raw } = {}) {
  const days = new Map();
  if (size === 0) return {};
  let lastTotal = null; // cumulative: input, cached, cacheWrite, output
  let model = 'gpt-5.6';
  let originSet = false;
  let lastPlan = null;
  let firstPlan = null;
  const PENDING = '\u0001pending';
  for await (const line of lineReader(file, size)) {
    if (!originSet && line.includes('"session_meta"')) {
      let j = null;
      try { j = JSON.parse(line); } catch { /* fall through like Swift */ }
      if (isObj(j) && isObj(j.payload) && typeof j.payload.originator === 'string') { originSet = true; continue; }
    }
    if (line.includes('"turn_context"')) {
      let j = null;
      try { j = JSON.parse(line); } catch { /* fall through */ }
      if (isObj(j) && isObj(j.payload) && typeof j.payload.model === 'string') { model = j.payload.model; continue; }
    }
    if (!line.includes('"token_count"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const p = isObj(j) ? j.payload : null;
    const info = isObj(p) ? p.info : null;
    const tot = isObj(info) ? info.total_token_usage : null;
    if (!isObj(tot)) continue;
    const ts = parseTimestamp(j.timestamp);
    if (ts === null) continue;
    const cur = [intOr0(tot.input_tokens), intOr0(tot.cached_input_tokens), intOr0(tot.cache_write_input_tokens), intOr0(tot.output_tokens)];
    let delta = cur;
    if (lastTotal && cur[0] >= lastTotal[0]) delta = cur.map((v, i) => v - lastTotal[i]);
    lastTotal = cur;
    const t = [Math.max(0, delta[0] - delta[1]), Math.max(0, delta[1]), Math.max(0, delta[2]), Math.max(0, delta[3])];
    const raw = isObj(p.rate_limits) && typeof p.rate_limits.plan_type === 'string' && p.rate_limits.plan_type ? p.rate_limits.plan_type : null;
    if (raw) { lastPlan = planFor(raw); if (!firstPlan) firstPlan = lastPlan; }
    if (t[0] + t[1] + t[2] + t[3] === 0) continue;
    addTokens(days, ts, model, lastPlan || PENDING, t);
  }
  const out = daysToJson(days);
  const resolved = firstPlan || fallbackPlan || null;
  for (const list of Object.values(out)) {
    for (const r of list) if (r[1] === PENDING) r[1] = resolved;
    const merged = new Map(); // a resolved pending entry may now share a key
    for (const r of list) {
      const k = r[0] + '\u0000' + (r[1] || '');
      const m = merged.get(k);
      if (m) { m[2] += r[2]; m[3] += r[3]; m[4] += r[4]; m[5] += r[5]; } else merged.set(k, r);
    }
    list.splice(0, list.length, ...merged.values());
  }
  return out;
}

async function listJsonl(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // Swift: .skipsHiddenFiles
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && path.extname(e.name) === '.jsonl') out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

// ---------------------------------------------------------------------------
// Plans and attribution rules (data/ai-usage/plans/plans.json)

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const PLAN_KEYS = new Set(['id', 'provider', 'name', 'account', 'payer', 'status', 'periods', 'note', 'evidence', 'confirmed', 'source', 'seen']);
const PERIOD_KEYS = new Set(['from', 'to', 'amount', 'currency', 'per', 'label']);
const RULE_KEYS = new Set(['provider', 'profiles', 'planTypes', 'machines', 'from', 'to', 'plan', 'note']);

function stringList(v, max) {
  return Array.isArray(v) && v.length > 0 && v.length <= max && v.every((s) => typeof s === 'string' && s.trim() && s.length <= 80);
}

function normalisePlan(p, where, err) {
  if (!isObj(p)) { err(where, 'must be an object'); return null; }
  let ok = true;
  const bad = (field, msg) => { ok = false; err(`${where}.${field}`, msg); };
  for (const k of Object.keys(p)) if (!PLAN_KEYS.has(k)) bad(k, k === 'price' ? 'replaced by periods' : 'unknown key');
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) bad('id', 'must be lowercase letters, digits and dashes (2-64 chars)');
  if (!has(PROVIDERS, p.provider)) bad('provider', 'must be "claude" or "openai"');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) bad('name', 'must be a non-empty string up to 80 chars');
  if (p.account != null && (typeof p.account !== 'string' || p.account.length > 120)) bad('account', 'must be a string up to 120 chars or null');
  if (p.payer != null && p.payer !== 'you' && p.payer !== 'work') bad('payer', 'must be "you", "work" or null');
  if (p.status != null && p.status !== 'active' && p.status !== 'ended') bad('status', 'must be "active", "ended" or null');
  const periods = [];
  if (p.periods != null) {
    if (!Array.isArray(p.periods) || p.periods.length > 20) bad('periods', 'must be an array of up to 20 periods');
    else p.periods.forEach((q, i) => {
      const at = `periods[${i}]`;
      if (!isObj(q)) { bad(at, 'must be an object'); return; }
      for (const k of Object.keys(q)) if (!PERIOD_KEYS.has(k)) bad(`${at}.${k}`, 'unknown key');
      if (!validDate(q.from)) bad(`${at}.from`, 'must be a date YYYY-MM-DD');
      if (q.to != null && (!validDate(q.to) || (validDate(q.from) && q.to < q.from))) bad(`${at}.to`, 'must be a date on or after from, or null');
      if (q.amount != null && (typeof q.amount !== 'number' || !Number.isFinite(q.amount) || q.amount < 0 || q.amount > 100000)) bad(`${at}.amount`, 'must be a number from 0 to 100000, or null');
      if (typeof q.currency !== 'string' || !/^[A-Z]{3}$/.test(q.currency)) bad(`${at}.currency`, 'must be a 3-letter ISO code like "GBP"');
      if (q.per !== 'month' && q.per !== 'year') bad(`${at}.per`, 'must be "month" or "year"');
      if (q.label != null && (typeof q.label !== 'string' || q.label.length > 80)) bad(`${at}.label`, 'must be a string up to 80 chars');
      periods.push({ from: q.from, to: q.to || null, amount: q.amount == null ? null : q.amount, currency: q.currency, per: q.per, label: q.label || null });
    });
  }
  if (p.note != null && (typeof p.note !== 'string' || p.note.length > 1000)) bad('note', 'must be a string up to 1000 chars');
  if (p.evidence != null && (!Array.isArray(p.evidence) || p.evidence.length > 30 || p.evidence.some((e) => typeof e !== 'string' || !e.trim() || e.length > 300))) bad('evidence', 'must be an array of up to 30 strings');
  if (p.confirmed != null && typeof p.confirmed !== 'boolean') bad('confirmed', 'must be true or false');
  if (!ok) return null;
  return {
    id: p.id, provider: p.provider, name: p.name.trim(), account: p.account == null ? null : p.account.trim() || null,
    payer: p.payer || null, status: p.status || null, periods, note: p.note ? p.note.trim() : null,
    evidence: (p.evidence || []).map((e) => e.trim()), confirmed: p.confirmed === true,
  };
}

function normaliseRule(r, where, err, planIds) {
  if (!isObj(r)) { err(where, 'must be an object'); return null; }
  let ok = true;
  const bad = (field, msg) => { ok = false; err(`${where}.${field}`, msg); };
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) bad(k, 'unknown key');
  if (!has(PROVIDERS, r.provider)) bad('provider', 'must be "claude" or "openai"');
  for (const k of ['profiles', 'planTypes', 'machines']) if (r[k] != null && !stringList(r[k], 20)) bad(k, 'must be a non-empty array of up to 20 strings');
  for (const k of ['from', 'to']) if (r[k] != null && !validDate(r[k])) bad(k, 'must be a date YYYY-MM-DD');
  if (!has(r, 'plan')) bad('plan', 'is required (a plan id, or null for "no plan")');
  else if (r.plan !== null && (typeof r.plan !== 'string' || !planIds.has(r.plan))) bad('plan', `must be one of the plan ids or null, got ${JSON.stringify(r.plan)}`);
  if (r.note != null && (typeof r.note !== 'string' || r.note.length > 300)) bad('note', 'must be a string up to 300 chars');
  if (!ok) return null;
  const out = { provider: r.provider };
  for (const k of ['profiles', 'planTypes', 'machines']) if (r[k]) out[k] = r[k].map((s) => s.trim());
  if (r.from) out.from = r.from;
  if (r.to) out.to = r.to;
  out.plan = r.plan;
  if (r.note) out.note = r.note;
  return out;
}

// Accepts { plans, rules } or a bare plans array (rules then stay as they are).
// Returns { version: 2, plans, rules } or throws with every problem listed.
function validatePlansDoc(body, { existingRules = [] } = {}) {
  const errors = [];
  const err = (where, msg) => { if (errors.length < 30) errors.push(`${where}: ${msg}`); };
  let plansIn;
  let rulesIn = existingRules;
  if (Array.isArray(body)) plansIn = body;
  else if (isObj(body)) {
    for (const k of Object.keys(body)) if (!['version', 'updatedAt', 'plans', 'rules'].includes(k)) err(k, 'unknown key');
    plansIn = body.plans;
    if (body.rules !== undefined) rulesIn = body.rules;
  }
  if (!Array.isArray(plansIn)) throw Object.assign(new Error('body must be {"plans": [...], "rules": [...]} or an array of plans'), { status: 400 });
  if (plansIn.length > PLANS_MAX) err('plans', `at most ${PLANS_MAX} plans`);
  const plans = [];
  const ids = new Set();
  plansIn.forEach((p, i) => {
    const plan = normalisePlan(p, `plans[${i}]`, err);
    if (!plan) return;
    if (ids.has(plan.id)) { err(`plans[${i}].id`, `duplicate id "${plan.id}"`); return; }
    ids.add(plan.id);
    plans.push(plan);
  });
  const rules = [];
  if (!Array.isArray(rulesIn) || rulesIn.length > RULES_MAX) err('rules', `must be an array of up to ${RULES_MAX} rules`);
  else rulesIn.forEach((r, i) => { const rule = normaliseRule(r, `rules[${i}]`, err, ids); if (rule) rules.push(rule); });
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors });
  return { version: 2, plans, rules };
}

async function readPlansDoc(file) {
  const r = await readJson(file);
  if (r.missing) return { exists: false, plans: [], rules: [], error: null };
  if (r.error) return { exists: true, plans: [], rules: [], error: `plans.json ${r.error}` };
  try {
    const doc = validatePlansDoc(r.value);
    return { exists: true, ...doc, error: null };
  } catch (e) {
    return { exists: true, plans: [], rules: [], error: `plans.json: ${e.message}` };
  }
}

function ruleMatches(rule, x, byPlanType) {
  if (rule.provider !== x.provider) return false;
  if (byPlanType ? !(rule.planTypes && x.planType && rule.planTypes.includes(x.planType)) : !!rule.planTypes) return false;
  if (rule.profiles && !rule.profiles.includes(x.profile)) return false;
  if (rule.machines && !(x.machine && rule.machines.some((m) => sameMachine(m, x.machine)))) return false;
  if (rule.from && x.date < rule.from) return false;
  if (rule.to && x.date > rule.to) return false;
  return true;
}

// First matching rule wins. A Codex event's own plan_type wins when a rule maps
// it; otherwise rules without planTypes decide. Returns a plan id or null.
function resolvePlan(rules, x) {
  if (x.planType) for (const r of rules) if (ruleMatches(r, x, true)) return r.plan;
  for (const r of rules) if (ruleMatches(r, x, false)) return r.plan;
  return null;
}

// ---------------------------------------------------------------------------
// Imports (rows only; plans live in plans.json, payments in payments.csv)

const IMPORT_KEYS = new Set(['schema', 'label', 'generatedAt', 'notes', 'rows']);
const ROW_KEYS = new Set(['date', 'provider', 'plan', 'model', 'machine', 'profile', 'tokens', 'cost', 'sessions', 'approx', 'note']);
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const MAX_TOKENS = 1e13;

function validateImport(doc, { rates = createRates(), today = londonDay(Date.now()) } = {}) {
  const errors = [];
  const err = (where, msg) => { if (errors.length < 20) errors.push(`${where}: ${msg}`); };
  const fail = () => ({ ok: false, errors, rows: [], label: null, generatedAt: null });
  if (!isObj(doc)) { err('file', 'must be a JSON object'); return fail(); }
  for (const k of Object.keys(doc)) {
    if (k === 'plans') err(k, 'plans are no longer imported; edit data/ai-usage/plans/plans.json');
    else if (!IMPORT_KEYS.has(k)) err(k, 'unknown top-level key');
  }
  if (doc.schema !== IMPORT_SCHEMA) err('schema', `must be "${IMPORT_SCHEMA}"`);
  if (doc.label != null && (typeof doc.label !== 'string' || doc.label.length > 120)) err('label', 'must be a string up to 120 chars');
  if (doc.generatedAt != null && parseTimestamp(doc.generatedAt) === null) err('generatedAt', 'must be an ISO 8601 date-time with a zone, e.g. 2026-10-01T21:00:00Z');
  if (doc.notes != null && (typeof doc.notes !== 'string' || doc.notes.length > 2000)) err('notes', 'must be a string up to 2000 chars');

  const tomorrow = addDays(today, 1);
  const byKey = new Map();
  if (!Array.isArray(doc.rows)) err('rows', 'must be an array (it may be empty)');
  else if (doc.rows.length > IMPORT_MAX_ROWS) err('rows', `at most ${IMPORT_MAX_ROWS} rows per file`);
  else {
    doc.rows.forEach((r, i) => {
      const at = `rows[${i}]`;
      if (!isObj(r)) { err(at, 'must be an object'); return; }
      let ok = true;
      const bad = (field, msg) => { ok = false; err(`${at}.${field}`, msg); };
      for (const k of Object.keys(r)) if (!ROW_KEYS.has(k)) bad(k, 'unknown key');
      if (!validDate(r.date)) bad('date', 'must be a real calendar date YYYY-MM-DD');
      else if (r.date > tomorrow) bad('date', 'is in the future');
      if (!has(PROVIDERS, r.provider)) bad('provider', 'must be "claude" or "openai"');
      if (r.plan != null && (typeof r.plan !== 'string' || !ID_RE.test(r.plan))) bad('plan', 'must be a plan id or null');
      if (r.model != null && (typeof r.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(r.model))) bad('model', 'must be a model id like "claude-opus-5-5" or null');
      if (r.machine != null && (typeof r.machine !== 'string' || !r.machine.trim() || r.machine.length > 80)) bad('machine', 'must be a machine name or null');
      if (r.profile != null && (typeof r.profile !== 'string' || !r.profile.trim() || r.profile.length > 80)) bad('profile', 'must be a profile name like ".claude" or null');
      if (r.sessions != null && (!isInt(r.sessions) || r.sessions < 0)) bad('sessions', 'must be a non-negative integer or null');
      if (r.approx != null && typeof r.approx !== 'boolean') bad('approx', 'must be true or false');
      if (r.note != null && (typeof r.note !== 'string' || r.note.length > 200)) bad('note', 'must be a string up to 200 chars');
      if (r.cost != null && (typeof r.cost !== 'number' || !Number.isFinite(r.cost) || r.cost < 0 || r.cost > 1e6)) bad('cost', 'must be a USD number from 0 to 1000000, or null');

      const tokens = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null };
      let hasSplit = false;
      if (r.tokens != null) {
        if (!isObj(r.tokens)) bad('tokens', 'must be an object');
        else {
          for (const k of Object.keys(r.tokens)) if (!TOKEN_KEYS.includes(k) && k !== 'total') bad(`tokens.${k}`, 'unknown key');
          for (const k of [...TOKEN_KEYS, 'total']) {
            const v = r.tokens[k];
            if (v == null) continue;
            if (!isInt(v) || v < 0 || v > MAX_TOKENS) { bad(`tokens.${k}`, 'must be a non-negative integer'); continue; }
            tokens[k] = v;
            if (k !== 'total') hasSplit = true;
          }
          const parts = TOKEN_KEYS.filter((k) => tokens[k] !== null);
          const sum = parts.reduce((s, k) => s + tokens[k], 0);
          if (tokens.total === null) { if (parts.length) tokens.total = sum; }
          else if (parts.length === 4 && tokens.total !== sum) bad('tokens.total', `is ${tokens.total} but input+output+cacheRead+cacheWrite is ${sum}`);
          else if (tokens.total < sum) bad('tokens.total', `is less than the listed parts (${sum})`);
        }
      }
      if (r.cost == null && tokens.total === null) bad('cost', 'a row needs a cost, tokens, or both');
      else if (r.cost == null && !hasSplit) bad('cost', 'is missing and tokens has only a total, so it cannot be priced; add input/output/cacheRead/cacheWrite or a cost');
      if (!ok) return;

      const model = r.model || null;
      const machine = r.machine ? shortMachine(r.machine) : null;
      const row = {
        date: r.date, provider: r.provider, plan: r.plan || null, model, machine, profile: r.profile ? r.profile.trim() : null,
        approx: r.approx === true, tokens, cost: r.cost != null ? r.cost : rates.cost(model, tokens, r.provider),
        sessions: r.sessions == null ? null : r.sessions,
      };
      const key = [row.date, row.provider, row.plan || '', row.model || '', machine ? machineKey(machine) : '*', row.profile || ''].join('\u0000');
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, row); return; }
      // Rows with the same key in one file add together.
      for (const k of [...TOKEN_KEYS, 'total']) if (row.tokens[k] !== null) prev.tokens[k] = (prev.tokens[k] || 0) + row.tokens[k];
      prev.cost += row.cost;
      if (row.sessions !== null) prev.sessions = (prev.sessions || 0) + row.sessions;
      prev.approx = prev.approx || row.approx;
    });
  }
  if (errors.length) return fail();
  return { ok: true, errors: [], rows: [...byKey.values()], label: doc.label || null, generatedAt: doc.generatedAt || null };
}

// ---------------------------------------------------------------------------
// Precedence: layers lowest first. A row in a lower layer is dropped when a
// higher layer has any row for the same (date, provider, machine). A higher row
// with no machine covers every machine; a lower row with no machine is dropped
// if a higher layer touches that (date, provider) at all.

function mergeLayers(layers) {
  const exact = new Set();
  const any = new Set();
  const kept = [];
  const dropped = new Map();
  for (let i = layers.length - 1; i >= 0; i--) {
    const rows = layers[i] || [];
    const keys = [];
    for (const r of rows) {
      const dp = r.date + '\u0000' + r.provider;
      const m = r.machine ? machineKey(shortMachine(r.machine)) : '*';
      const covered = exact.has(dp + '\u0000*') || (m === '*' ? any.has(dp) : exact.has(dp + '\u0000' + m));
      if (covered) { dropped.set(r.source, (dropped.get(r.source) || 0) + 1); continue; }
      kept.push(r);
      keys.push([dp, m]);
    }
    for (const [dp, m] of keys) { exact.add(dp + '\u0000' + m); any.add(dp); }
  }
  return { rows: kept, dropped };
}

// History rows win per (machine, date) up to each machine's coveredThrough day.
// After it, live rows take over, matched by (machine, date, provider, profile);
// a live row with no profile (menu bar report) takes over every profile.
// A later day without live rows keeps whatever the CSV has.
function overlayLive(historyRows, liveRows, covered) {
  const after = (r) => { const c = covered[machineKey(shortMachine(r.machine))]; return !c || r.date > c; };
  const live = liveRows.filter(after);
  const cover = new Set();
  for (const r of live) cover.add([machineKey(shortMachine(r.machine)), r.date, r.provider, r.profile || '*'].join('\u0000'));
  const keep = historyRows.filter((r) => {
    if (!after(r)) return true;
    const base = [machineKey(shortMachine(r.machine)), r.date, r.provider].join('\u0000');
    return !cover.has(base + '\u0000*') && !cover.has(base + '\u0000' + (r.profile || ''));
  });
  return { rows: [...keep, ...live], live: live.length, replaced: historyRows.length - keep.length };
}

// ---------------------------------------------------------------------------
// Other Macs' reports (Sync.swift HostReport)

function reportRows(days, { machine, source }) {
  const rows = [];
  let unattributed = 0;
  for (const date of Object.keys(days).sort()) {
    if (!validDate(date)) continue;
    const v = days[date];
    if (!isObj(v)) continue;
    const claude = Math.max(0, numOrNull(v.claude) || 0);
    const codex = Math.max(0, numOrNull(v.codex) || 0);
    const total = Math.max(0, Math.round(numOrNull(v.tokens) || 0));
    const both = claude > 0 && codex > 0;
    const claudeTokens = both ? Math.round(total * claude / (claude + codex)) : (claude > 0 ? total : 0);
    if (claude === 0 && codex === 0) { unattributed += total; continue; }
    for (const [provider, cost, tok] of [['claude', claude, claudeTokens], ['openai', codex, codex > 0 ? total - claudeTokens : 0]]) {
      if (cost <= 0) continue;
      rows.push({
        date, provider, plan: null, model: null, machine, profile: null, source, approx: both,
        tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: tok },
        cost, sessions: null,
      });
    }
  }
  return { rows, unattributed };
}

// ---------------------------------------------------------------------------
// Files

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
const writeJsonAtomic = (file, data, pretty = false) => writeAtomic(file, pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data));

async function readJson(file) {
  try { return { value: JSON.parse(await fsp.readFile(file, 'utf8')) }; } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { error: e instanceof SyntaxError ? 'not valid JSON' : e.code || String(e.message) };
  }
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
    req.on('end', () => (over ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// Same guard server.js uses for state-changing calls: a JSON body forces a CORS
// preflight other sites cannot pass, and any Origin sent must be this host.
function sameOriginJson(req) {
  const origin = req.headers.origin;
  let foreign = false;
  try { foreign = !!origin && new URL(origin).host !== req.headers.host; } catch { foreign = true; }
  return String(req.headers['content-type'] || '').startsWith('application/json') && !foreign;
}

// ---------------------------------------------------------------------------
// FX: USD -> GBP, fetched once a day, last good value kept, else 0.76.

function createFx({ file, url = FX_URL, now = () => Date.now(), fetchRate = null } = {}) {
  let mem = null;
  let loaded = false;
  let inflight = null;
  let lastAttempt = 0;
  fetchRate ||= async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'meridian-ai-usage' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const v = j && j.rates && j.rates.GBP;
    if (typeof v !== 'number' || !(v > 0.3 && v < 3)) throw new Error('no GBP rate');
    return { USDGBP: v, date: validDate(j.date) ? j.date : null };
  };
  const view = (m, today) => ({ USDGBP: m.USDGBP, date: m.date, source: m.source, fetchedAt: m.fetchedAt, stale: m.fetchedDay !== today });
  async function get() {
    if (!loaded) {
      loaded = true;
      const r = file ? await readJson(file) : {};
      if (isObj(r.value) && typeof r.value.USDGBP === 'number') mem = r.value;
    }
    const today = londonDay(now());
    if (mem && mem.fetchedDay === today) return view(mem, today);
    if (jobsEnabled() && !inflight && now() - lastAttempt > 60 * 60 * 1000) {
      lastAttempt = now();
      inflight = fetchRate().then(async (got) => {
        mem = { ...got, source: 'frankfurter.dev (ECB)', fetchedAt: new Date(now()).toISOString(), fetchedDay: today };
        if (file) await writeJsonAtomic(file, mem).catch(() => {});
      }).catch(() => {}).finally(() => { inflight = null; });
    }
    if (inflight) await Promise.race([inflight, new Promise((r) => setTimeout(r, 4000).unref())]);
    if (mem) return view(mem, today);
    return { USDGBP: FX_FALLBACK, date: null, source: 'fallback', fetchedAt: null, stale: true };
  }
  return { get };
}

// ---------------------------------------------------------------------------
// History job runner: scripts/ai-usage-history.js in a child process, never two
// at once. A plans change during a run queues a --rewrite for afterwards.

function createHistoryRunner({ root, script, onDone = () => {}, delayMs = 2 * 60 * 1000, everyMs = 6 * 60 * 60 * 1000, timeoutMs = 10 * 60 * 1000, spawnChild = spawn, now = Date.now, clock = { setTimeout, clearTimeout, setInterval, clearInterval }, kill }) {
  let child = null;
  let startedAt = null;
  let queued = null;
  let last = null;
  let timers = null, stopChild = null;
  function run(args = []) {
    if (!jobsEnabled()) return false;
    if (child) { if (args.includes('--rewrite') && !queued) queued = args; return false; } // only a rewrite is worth queueing
    startedAt = new Date(now()).toISOString();
    let stderr = '';
    try {
      child = spawnChild(process.execPath, [script, ...args], { detached: process.platform !== 'win32', cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    } catch (e) {
      last = { startedAt, finishedAt: new Date(now()).toISOString(), code: null, error: String(e.message || e) };
      child = null;
      return false;
    }
    let timedOut = false;
    stopChild = capProcess(child, { timeout: timeoutMs, detached: true, timers: clock, kill, onTimeout: () => { timedOut = true; } });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', (e) => { stderr += String(e.message || e); });
    child.on('close', (code, signal) => {
      last = { startedAt, finishedAt: new Date(now()).toISOString(), args, code, signal: signal || null, error: timedOut ? 'history job budget exceeded' : code === 0 ? null : stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}` };
      child = null;
      stopChild = null;
      startedAt = null;
      try { onDone(last); } catch { /* ignore */ }
      if (queued) { const next = queued; queued = null; run(next); }
    });
    return true;
  }
  function start() {
    if (!jobsEnabled()) return () => {};
    if (timers) return false;
    const first = clock.setTimeout(() => run(), delayMs);
    const every = clock.setInterval(() => run(), everyMs);
    first.unref(); every.unref();
    timers = [first, every];
    return true;
  }
  function stop() { if (timers) { clock.clearTimeout(timers[0]); clock.clearInterval(timers[1]); } timers = null; queued = null; stopChild?.(); }
  return { run, start, stop, get running() { return !!child; }, get startedAt() { return startedAt; }, get last() { return last; } };
}

// ---------------------------------------------------------------------------
// The ledger

function createLedger(options = {}) {
  const root = options.root || __dirname;
  const home = options.home || os.homedir();
  const dataDir = options.dataDir || path.join(root, 'data', 'ai-usage');
  const historyDir = options.historyDir || path.join(dataDir, 'history');
  const files = {
    reports: dataDir,
    imports: path.join(dataDir, 'import'),
    archive: path.join(dataDir, 'archive'),
    plans: options.plansFile || path.join(dataDir, 'plans', 'plans.json'),
    daily: path.join(historyDir, 'daily-usage.csv'),
    payments: path.join(historyDir, 'payments.csv'),
    state: path.join(historyDir, 'state.json'),
    cache: options.cacheFile || path.join(root, 'cache', 'ai-usage-scan.json'),
    fx: options.fxFile || path.join(root, 'cache', 'ai-usage-fx.json'),
    script: options.historyScript || path.join(root, 'scripts', 'ai-usage-history.js'),
  };
  const roots = options.logRoots || [
    [path.join(home, '.claude', 'projects'), 'claude', '.claude'],
    [path.join(home, '.codex', 'sessions'), 'openai', '.codex'],
  ];
  const hostname = options.hostname || os.hostname();
  const rates = options.rates || createRates({ file: options.ratesFile || path.join(home, '.t3', 'userdata', 'usage-model-rates.json') });
  const now = options.now || (() => Date.now());
  const fx = options.fx || createFx({ file: files.fx, now });

  let writes = Promise.resolve();
  function serial(fn) { const op = writes.then(fn); writes = op.catch(() => {}); return op; }

  let scanCache = null; // { version, files: {path: entry} }
  let cached = null;
  let inflight = null;
  const runner = options.runner || createHistoryRunner({ root, script: files.script, onDone: () => { cached = null; } });

  async function loadScanCache() {
    if (scanCache) return scanCache;
    const r = await readJson(files.cache);
    const v = r.value;
    scanCache = isObj(v) && v.version === PARSER_VERSION && isObj(v.files)
      ? { version: PARSER_VERSION, files: v.files }
      : { version: PARSER_VERSION, files: {} };
    return scanCache;
  }

  async function scanLocal(machine) {
    const t0 = Date.now();
    const cache = await loadScanCache();
    const found = [];
    for (const [dir, provider, profile] of roots) for (const file of await listJsonl(dir)) found.push([file, provider, profile]);
    const live = {};
    let parsed = 0;
    let failed = 0;
    await pool(found, 4, async ([file, provider, profile]) => {
      let st;
      try { st = await fsp.stat(file); } catch { return; }
      const c = cache.files[file];
      if (c && c.size === st.size && c.mtime === st.mtimeMs && c.provider === provider) { live[file] = c; return; }
      try {
        const days = provider === 'claude'
          ? await parseClaudeFile(file, { size: st.size })
          : await parseCodexFile(file, { size: st.size });
        live[file] = { provider, profile, size: st.size, mtime: st.mtimeMs, days };
        parsed++;
      } catch {
        failed++;
        if (c) live[file] = c;
      }
    });

    // Files the tools deleted (Claude Code keeps 30 days) move to the archive.
    const archiveFile = path.join(files.archive, 'local-files.json');
    const archived = await readJson(archiveFile);
    const archive = isObj(archived.value) && isObj(archived.value.files) ? archived.value.files : {};
    const gone = Object.keys(cache.files).filter((f) => !live[f]);
    for (const f of gone) archive[f] = { ...cache.files[f], goneAt: new Date(now()).toISOString() };
    const changed = parsed > 0 || gone.length > 0 || Object.keys(live).length !== Object.keys(cache.files).length;
    cache.files = live;
    if (gone.length) await serial(() => writeJsonAtomic(archiveFile, { machine, note: 'Parsed usage of local log files that no longer exist on disk.', files: archive }));
    if (changed) await serial(() => writeJsonAtomic(files.cache, cache));

    const entries = [...Object.values(live), ...Object.entries(archive).filter(([f]) => !live[f]).map(([, e]) => e)];
    const rows = new Map();
    for (const e of entries) {
      if (!isObj(e.days)) continue;
      const profile = e.profile || (e.provider === 'claude' ? '.claude' : '.codex');
      for (const [date, list] of Object.entries(e.days)) {
        for (const [model, planType, input, cacheRead, cacheWrite, output] of list) {
          const pt = e.provider === 'openai' ? planType || null : null;
          const key = [date, e.provider, profile, model, pt || ''].join('\u0000');
          let r = rows.get(key);
          if (!r) {
            rows.set(key, (r = { date, provider: e.provider, plan: null, planType: pt, model, machine, profile, source: 'local', approx: false,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, sessions: 0 }));
          }
          r.tokens.input += input; r.tokens.output += output; r.tokens.cacheRead += cacheRead; r.tokens.cacheWrite += cacheWrite;
          r.sessions += 1;
        }
      }
    }
    for (const r of rows.values()) {
      r.tokens.total = r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
      r.cost = rates.cost(r.model, r.tokens, r.provider);
    }
    return { rows: [...rows.values()], stats: { files: found.length, parsed, failed, archived: Object.keys(archive).length, ms: Date.now() - t0 } };
  }

  async function loadReports() {
    let names = [];
    try { names = (await fsp.readdir(files.reports)).filter((f) => f.endsWith('.json')).sort(); } catch { /* none */ }
    const out = [];
    for (const f of names) {
      const r = await readJson(path.join(files.reports, f));
      if (!isObj(r.value) || !isObj(r.value.days)) { out.push({ file: f, error: r.error || 'not a menu bar report (no days)' }); continue; }
      out.push({ file: f, report: r.value });
    }
    return out;
  }

  async function reportSource(entry, selfKey) {
    const { report, file } = entry;
    const name = typeof report.name === 'string' && report.name ? report.name : file.replace(/\.json$/, '');
    const host = typeof report.host === 'string' && report.host ? report.host : file.replace(/\.json$/, '');
    const machine = shortMachine(name);
    const id = `report:${machine}`;
    const base = { id, label: `${machine} Mac (menu bar app)`, machine, host, version: report.version || null,
      updatedAt: typeof report.updatedAt === 'number' ? new Date(report.updatedAt * 1000).toISOString() : null };
    if (machineKey(host) === selfKey || machineKey(name) === selfKey) {
      return { source: { ...base, rows: 0, ignored: "This Mac's own report; its local logs are used instead." }, rows: [] };
    }
    // Keep days the rolling 30-day report has dropped.
    const archiveFile = path.join(files.archive, `report-${host.replace(/[^A-Za-z0-9._-]/g, '-')}.json`);
    const prev = await readJson(archiveFile);
    const kept = isObj(prev.value) && isObj(prev.value.days) ? prev.value.days : {};
    const days = { ...kept, ...report.days };
    if (JSON.stringify(days) !== JSON.stringify(kept)) {
      if (jobsEnabled()) await serial(() => writeJsonAtomic(archiveFile, { name, host, note: 'Every day this Mac has reported, latest report wins.', days }));
    }
    const { rows, unattributed } = reportRows(days, { machine, source: id });
    return { source: { ...base, reportDays: Object.keys(report.days).length, ...(unattributed ? { unattributedTokens: unattributed } : {}) }, rows };
  }

  async function loadImports() {
    if (jobsEnabled()) await fsp.mkdir(files.imports, { recursive: true }).catch(() => {});
    let names = [];
    try { names = (await fsp.readdir(files.imports)).filter((f) => f.endsWith('.json')).sort(); } catch { /* none */ }
    const today = londonDay(now());
    const out = [];
    for (const f of names) {
      const id = `import:${f}`;
      const full = path.join(files.imports, f);
      let error = null;
      let result = null;
      try {
        const st = await fsp.stat(full);
        if (!st.isFile()) error = 'not a file';
        else if (st.size > IMPORT_MAX_BYTES) error = `file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`;
        else {
          let doc;
          try { doc = JSON.parse(await fsp.readFile(full, 'utf8')); } catch (e) { error = `not valid JSON (${e.message})`; }
          if (!error) {
            result = validateImport(doc, { rates, today });
            if (!result.ok) error = `${result.errors.length}${result.errors.length >= 20 ? '+' : ''} problem(s): ${result.errors.join('; ')}`;
          }
        }
      } catch (e) { error = e.code || String(e.message); }
      const rows = error ? [] : result.rows.map((r) => ({ ...r, source: id }));
      const dates = rows.map((r) => r.date).sort();
      out.push({ id, rows, source: { id, label: (result && result.label) || f, generatedAt: (result && result.generatedAt) || null,
        from: dates[0] || null, through: dates[dates.length - 1] || null, rows: rows.length, error } });
    }
    return out;
  }

  async function readState() {
    const r = await readJson(files.state);
    return isObj(r.value) ? r.value : {};
  }

  function historyStatus(state) {
    const machines = {};
    for (const [m, s] of Object.entries(isObj(state.machines) ? state.machines : {})) {
      machines[m] = { lastSuccess: s.lastSuccess || null, coveredThrough: s.coveredThrough || null, lastAttempt: s.lastAttempt || null, error: s.error || null };
    }
    const last = runner.last;
    return {
      running: runner.running,
      startedAt: runner.startedAt,
      lastRun: state.lastRun || null,
      ...(last && last.error ? { lastExitError: last.error } : {}),
      machines,
    };
  }

  async function build() {
    rates.load(); // before any pricing, history rows included
    const sources = [];
    const reports = await loadReports();
    const selfKey = machineKey(hostname);
    const self = reports.find((r) => r.report && (machineKey(r.report.host) === selfKey || machineKey(r.report.name) === selfKey));
    const machine = shortMachine(self ? self.report.name : hostname.replace(/\.local$/i, ''));

    const plansDoc = await readPlansDoc(files.plans);
    if (plansDoc.error) sources.push({ id: 'plans', label: 'plans.json', rows: 0, error: plansDoc.error });
    const rules = plansDoc.rules;

    // 1. History CSV
    const [daily, state] = await Promise.all([readDailyCsv(files.daily), readState()]);
    const covered = {};
    for (const [m, s] of Object.entries(isObj(state.machines) ? state.machines : {})) if (s && validDate(s.coveredThrough)) covered[machineKey(m)] = s.coveredThrough;
    for (const r of daily.rows) { // no state for a machine: trust the CSV up to the day before its last day
      const k = machineKey(r.machine);
      if (!has(covered, k)) covered[k] = null;
    }
    for (const k of Object.keys(covered)) {
      if (covered[k] !== null) continue;
      const last = daily.rows.filter((r) => machineKey(r.machine) === k).reduce((m, r) => (r.date > m ? r.date : m), '');
      covered[k] = last ? addDays(last, -1) : null;
    }
    const grouped = new Map();
    for (const r of daily.rows) {
      const plan = resolvePlan(rules, { provider: r.provider, profile: r.profile, date: r.date, planType: r.plan_type || null, machine: r.machine });
      const key = [r.date, r.machine, r.provider, r.profile, r.model, plan || ''].join('\u0000');
      let g = grouped.get(key);
      if (!g) {
        grouped.set(key, (g = { date: r.date, provider: r.provider, plan, model: r.model, machine: r.machine, profile: r.profile || null, source: 'history', approx: false,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, sessions: 0 }));
      }
      g.tokens.input += r.input; g.tokens.output += r.output; g.tokens.cacheRead += r.cache_read; g.tokens.cacheWrite += r.cache_write;
      g.tokens.total += r.total_tokens;
      g.sessions += r.sessions;
    }
    const historyRows = [...grouped.values()];
    for (const r of historyRows) r.cost = rates.cost(r.model, r.tokens, r.provider);

    // 2. Live: this Mac's logs and other Macs' menu bar reports
    let local = { rows: [], stats: {} };
    try {
      if (jobsEnabled()) local = await scanLocal(machine);
    } catch (e) {
      sources.push({ id: 'local', label: "This Mac's logs", machine, rows: 0, error: String(e.message || e) });
    }
    const reportOut = [];
    for (const entry of reports) {
      if (entry.error) { reportOut.push({ source: { id: `report:${entry.file}`, label: entry.file, rows: 0, error: entry.error }, rows: [] }); continue; }
      try { reportOut.push(await reportSource(entry, selfKey)); } catch (e) {
        reportOut.push({ source: { id: `report:${entry.file}`, label: entry.file, rows: 0, error: String(e.message || e) }, rows: [] });
      }
    }
    const liveRows = [...local.rows, ...reportOut.flatMap((r) => r.rows)];
    for (const r of liveRows) r.plan = resolvePlan(rules, { provider: r.provider, profile: r.profile, date: r.date, planType: r.planType || null, machine: r.machine });
    const overlay = overlayLive(historyRows, liveRows, covered);

    // 3. Imports
    const imports = await loadImports();
    for (const r of imports.flatMap((i) => i.rows)) {
      if (!r.plan) r.plan = resolvePlan(rules, { provider: r.provider, profile: r.profile, date: r.date, planType: null, machine: r.machine });
    }

    const { rows, dropped } = mergeLayers([overlay.rows, ...imports.filter((i) => !i.source.error).map((i) => i.rows)]);
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.provider.localeCompare(b.provider) || String(a.machine).localeCompare(String(b.machine))
      || String(a.profile).localeCompare(String(b.profile)) || String(a.model).localeCompare(String(b.model)) || String(a.plan).localeCompare(String(b.plan)));

    const used = new Map();
    for (const r of rows) used.set(r.source, (used.get(r.source) || 0) + 1);
    const span = (src) => { const d = rows.filter((r) => r.source === src).map((r) => r.date); return { from: d[0] || null, through: d[d.length - 1] || null }; };
    const hDates = daily.rows.map((r) => r.date).sort();
    sources.unshift({ id: 'history', label: 'Usage history (daily-usage.csv)', from: hDates[0] || null, through: hDates[hDates.length - 1] || null,
      csvRows: daily.rows.length, rows: used.get('history') || 0, replacedByLive: overlay.replaced,
      coveredThrough: Object.fromEntries(Object.entries(state.machines || {}).map(([m, s]) => [m, (s && s.coveredThrough) || null])),
      ...(daily.invalid ? { invalidRows: daily.invalid } : {}), ...(daily.error ? { error: daily.error } : {}), ...(!daily.exists ? { error: 'daily-usage.csv not found; run scripts/ai-usage-history.js --seed' } : {}) });
    if (!sources.some((s) => s.id === 'local')) {
      sources.push({ id: 'local', label: "This Mac's logs (live, after the history)", machine, ...span('local'), rows: used.get('local') || 0,
        ms: local.stats.ms, files: local.stats.files, parsed: local.stats.parsed, failed: local.stats.failed,
        rates: rates.source, ratesFetchedAt: rates.fetchedAt });
    }
    for (const r of reportOut) { if (!r.source.ignored && !r.source.error) Object.assign(r.source, span(r.source.id), { rows: used.get(r.source.id) || 0 }); sources.push(r.source); }
    for (const i of imports) sources.push(i.source);
    for (const s of sources) if (dropped.get(s.id)) s.superseded = dropped.get(s.id);
    const known = new Set(plansDoc.plans.map((p) => p.id));
    for (const i of imports) {
      const unknown = [...new Set(i.rows.map((r) => r.plan).filter((p) => p && !known.has(p)))];
      if (unknown.length) i.source.warnings = [`unknown plan id(s): ${unknown.join(', ')}`];
    }

    const payments = await readPaymentsCsv(files.payments);
    sources.push({ id: 'payments', label: 'Payments (payments.csv)', rows: payments.payments.length,
      ...(payments.invalid ? { invalidRows: payments.invalid } : {}), ...(payments.duplicates ? { duplicateReferences: payments.duplicates } : {}),
      ...(payments.error ? { error: payments.error } : {}) });

    const seen = new Map();
    const models = {};
    for (const r of rows) {
      r.cost = round6(r.cost);
      delete r.planType;
      if (r.plan) { const s = seen.get(r.plan); if (!s) seen.set(r.plan, { from: r.date, through: r.date }); else s.through = r.date; }
      if (r.model && !models[r.model]) {
        const hit = rates.lookupFor(r.model, r.provider);
        models[r.model] = { label: modelLabel(r.model), provider: r.provider, pricedAs: hit.key, pricing: hit.from };
      }
    }

    return {
      generatedAt: new Date(now()).toISOString(),
      currency: 'USD',
      fx: await fx.get(),
      machine,
      providers: PROVIDERS,
      plans: plansDoc.plans.map((p) => ({ ...p, source: 'plans.json', seen: seen.get(p.id) || null })),
      planRules: rules,
      payments: payments.payments,
      history: historyStatus(state),
      rows,
      sources,
      models,
    };
  }

  async function getLedger({ force = false } = {}) {
    if (!force && cached && now() - cached.at < CACHE_MS) return cached.value;
    if (inflight) return inflight;
    inflight = build().then((value) => { cached = { at: now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  }

  async function ledgerBody(force, gzip) {
    const value = await getLedger({ force });
    value.history = historyStatus(await readState()); // the job can finish between rebuilds
    const json = JSON.stringify(value);
    if (!gzip) return { body: json };
    return { body: await new Promise((resolve, reject) => zlib.gzip(json, (e, b) => (e ? reject(e) : resolve(b)))), gzip: true };
  }

  function startHistory() { return runner.start(); }
  function runHistory(args) { return runner.run(args); }

  async function handle(req, res, url) {
    const u = url instanceof URL ? url : new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p !== '/api/ai-usage/ledger' && p !== '/api/ai-usage/plans' && p !== '/api/ai-usage/refresh') return false;
    try {
      if (p === '/api/ai-usage/ledger') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return true; }
        const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
        const out = await ledgerBody(u.searchParams.get('force') === '1', gzip);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(out.gzip ? { 'Content-Encoding': 'gzip' } : {}) });
        res.end(out.body);
        return true;
      }
      if (p === '/api/ai-usage/refresh') {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return true; }
        if (!sameOriginJson(req)) { sendJson(res, 403, { ok: false, error: 'not allowed' }); return true; }
        req.resume();
        const started = runner.running ? false : runner.run();
        sendJson(res, 202, { ok: true, running: true, started, startedAt: runner.startedAt });
        return true;
      }
      if (req.method === 'GET') {
        const r = await readPlansDoc(files.plans);
        if (r.error) { sendJson(res, 500, { ok: false, error: r.error }); return true; }
        sendJson(res, 200, { version: 2, plans: r.plans, rules: r.rules });
        return true;
      }
      if (req.method === 'PUT') {
        if (!sameOriginJson(req)) { sendJson(res, 403, { ok: false, error: 'not allowed' }); return true; }
        let body;
        try { body = JSON.parse(await readBody(req, BODY_LIMIT)); } catch (e) {
          sendJson(res, e.status || 400, { ok: false, error: e.status ? e.message : 'body is not valid JSON' });
          return true;
        }
        const current = await readPlansDoc(files.plans);
        const doc = validatePlansDoc(body, { existingRules: current.rules });
        await serial(() => writeJsonAtomic(files.plans, { version: 2, updatedAt: new Date(now()).toISOString(), plans: doc.plans, rules: doc.rules }, true));
        cached = null;
        runner.run(['--rewrite']); // recompute plan and api_value_usd in daily-usage.csv
        sendJson(res, 200, { ok: true, ...doc });
        return true;
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { ok: false, error: String(e.message || e), ...(e.errors ? { errors: e.errors } : {}) });
    }
    return true;
  }

  return { getLedger, handle, startHistory, runHistory, invalidate: () => { cached = null; }, files, runner };
}

const defaultLedger = createLedger({ dataDir: path.join(DATA_DIR, 'ai-usage'), cacheFile: path.join(CACHE_DIR, 'ai-usage-scan.json'), fxFile: path.join(CACHE_DIR, 'ai-usage-fx.json') });

module.exports = {
  getLedger: (opts) => defaultLedger.getLedger(opts),
  handle: (req, res, url) => defaultLedger.handle(req, res, url),
  startHistory: () => defaultLedger.startHistory(),
  stopHistory: () => defaultLedger.runner.stop(),
  invalidate: () => defaultLedger.invalidate(),
  createLedger,
  createRates,
  createFx,
  createHistoryRunner,
  rateCandidates,
  validateImport,
  validatePlansDoc,
  readPlansDoc,
  resolvePlan,
  mergeLayers,
  overlayLive,
  reportRows,
  parseClaudeFile,
  parseCodexFile,
  modelLabel,
  shortMachine,
  sameMachine,
  codexPlanName,
  londonDay,
  addDays,
  validDate,
  parseCsv,
  toCsv,
  readDailyCsv,
  readPaymentsCsv,
  normalisePayment,
  writeAtomic,
  writeJsonAtomic,
  readJson,
  round6,
  DAILY_COLUMNS,
  PAYMENT_COLUMNS,
  IMPORT_SCHEMA,
};
