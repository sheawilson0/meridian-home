'use strict';
const runtime = require('./runtime');
const JOBS_ENABLED = runtime.connectorEnabled('money');
const { jobsOffError } = runtime;

// The Money tab's daemon side (3 Oct 2026). Once a day it reads the Monzo
// Google Sheets export and Trading 212's read-only API into data/money/, and
// keeps one portfolio snapshot per day. The page asks for it all behind a
// passcode of its own, on top of Meridian's Tailscale-only access.
//
// Rules this file keeps:
//   - Nothing here goes into /api/state or the SSE stream: every device gets
//     /api/state, and the Mac app keeps it in localStorage. Money only leaves
//     through /api/money, and only to a device holding an unlocked session.
//   - Credentials live in data/money/credentials.json (0600) and are never
//     sent back to the page, logged or put in an error message.
//   - Trading 212 is read with GET requests only. There is no route that
//     could place, change or cancel an order.
//   - Every file in data/money/ is written 0600; the folder is 0700.
//
// Files: credentials.json, settings.json (sheet id, refresh hour), rules.json
// (what counts as salary, own-account transfers, investing), lock.json
// (scrypt hash + hashed sessions), monzo.json (the last full read of the
// sheet), t212.json (account, positions, orders, dividends, transfers),
// history.json (one portfolio row per day, never trimmed), accounts.json
// (balances typed in by hand), status.json (last run per source).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const core = require('./public/money-core');
const receivables = require('./receivables');
const moneyAgent = require('./money-agent');

const COOKIE = 'meridian_money';
const SHORT_MS = 12 * 3600e3;
const REMEMBER_MS = 30 * 86400e3;
const BODY_LIMIT = 20000;
const T212_HOSTS = { live: 'live.trading212.com', demo: 'demo.trading212.com' };
const SUB_STATUS = ['cancelled', 'paused', 'hidden', 'active'];
const TX_TAGS = ['one-off', 'normal', 'leave-out'];
const PALETTES = ['meaning', 'pastel', 'today', 'bright', 'mono'];
// Who can write the adviser note. Codex models run on the ChatGPT plan, Claude ones on the Claude plan.
const ADVISERS = {
  'gpt-6-luna': { name: 'GPT-6 Luna', kind: 'codex', effort: 'high' },
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', kind: 'codex', effort: 'medium' },
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', kind: 'claude', effort: 'high' },
  'claude-opus-5-5': { name: 'Opus 5.5', kind: 'claude', effort: 'medium' },
};
const ADVISOR_MODEL = 'gpt-6-luna';
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const SCHEDULES = ['off', 'weekly', 'daily'];
const ACCOUNT_KINDS = ['current', 'savings', 'isa', 'lisa', 'pension', 'investments', 'credit', 'other'];

// ---------------------------------------------------------------- small helpers

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 1) + '\n', { mode: 0o600 });
    await fsp.rename(tmp, file);
  } finally { await fsp.unlink(tmp).catch(() => {}); }
  await fsp.chmod(file, 0o600).catch(() => {});
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
    req.on('end', () => {
      if (over) { reject(Object.assign(new Error('body too large'), { status: 413 })); return; }
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(Object.assign(new Error('body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function sameOriginJson(req) {
  const origin = req.headers.origin; let foreign = false;
  try { foreign = !!origin && new URL(origin).host !== req.headers.host; } catch { foreign = true; }
  return String(req.headers['content-type'] || '').startsWith('application/json') && !foreign;
}
function sendJson(req, res, code, value, headers = {}) {
  const json = JSON.stringify(value);
  const base = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ...headers };
  if (json.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.writeHead(code, { ...base, 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(json)); return;
  }
  res.writeHead(code, base); res.end(json);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function scrypt(pass, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pass).normalize('NFKC'), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));
}

// A tiny https client: method GET unless a body is given. Never logs headers.
function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeout = 25000, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const fail = (e) => { clearTimeout(timer); reject(e); req.destroy(e); };
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: { 'User-Agent': 'Meridian/1 (personal dashboard)', Accept: 'application/json', ...headers } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { fail(new Error('response too large')); res.destroy(); } else chunks.push(c); });
      res.on('end', () => {
        clearTimeout(timer);
        if (!res.complete) { reject(new Error('incomplete response')); return; }
        const text = Buffer.concat(chunks).toString('utf8'); let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: text.slice(0, 400) });
      });
      res.on('aborted', () => fail(new Error('incomplete response')));
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
      res.on('close', () => { if (!res.complete) fail(new Error('incomplete response')); });
      if (Number(res.headers['content-length']) > maxBytes) { fail(new Error('response too large')); res.destroy(); }
    });
    const timer = setTimeout(() => fail(new Error('timed out')), timeout);
    req.setTimeout(timeout, () => fail(new Error('timed out')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- Monzo (Google Sheets)

// Sheets hands dates back as serial day numbers (UNFORMATTED_VALUE).
function sheetDate(v) {
  if (typeof v === 'number' && v > 20000) { const ms = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400e3; return new Date(ms).toISOString().slice(0, 10); }
  const s = String(v || '').trim(); let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function sheetTime(v) {
  if (typeof v === 'number') { const mins = Math.round((v % 1) * 1440); return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`; }
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : '';
}
// Rows (header first) from one tab of the Monzo export into transactions.
function monzoRows(values, account = 'Monzo') {
  if (!Array.isArray(values) || values.length < 2) return [];
  const H = values[0].map((h) => String(h).trim()); const ix = (n) => H.indexOf(n);
  const need = ['Date', 'Amount', 'Name']; if (need.some((n) => ix(n) < 0)) return [];
  const get = (r, n) => (ix(n) >= 0 ? r[ix(n)] : undefined);
  const out = [];
  for (const r of values.slice(1)) {
    const date = sheetDate(get(r, 'Date')); const amount = Number(get(r, 'Amount'));
    if (!date || !Number.isFinite(amount)) continue;
    const t = { id: String(get(r, 'Transaction ID') || sha(JSON.stringify(r)).slice(0, 16)), date, time: sheetTime(get(r, 'Time')), type: String(get(r, 'Type') || ''), name: String(get(r, 'Name') || '').trim(), category: String(get(r, 'Category') || 'General'), amount: r2(amount), account };
    t.currency = String(get(r, 'Currency') || '').trim();
    const sender = get(r, 'Counterparty ID') || get(r, 'Sender ID');
    if (sender) t.counterpartyId = String(sender).trim();
    const status = get(r, 'Status'); if (status) t.status = String(status).trim();
    const lc = String(get(r, 'Local currency') || ''); const la = Number(get(r, 'Local amount'));
    if (lc && lc !== String(get(r, 'Currency') || 'GBP') && Number.isFinite(la)) t.local = { amount: la, currency: lc };
    const notes = String(get(r, 'Notes and #tags') || '').trim(); if (notes) t.notes = notes.slice(0, 300);
    const desc = String(get(r, 'Description') || '').trim(); if (desc && desc !== t.name) t.description = desc.slice(0, 120);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- Trading 212

// Positions in pounds. The current API (/equity/positions) gives walletImpact
// directly; the older /equity/portfolio only gives P/L, so cost comes from
// the order history there.
const invalidT212 = () => Object.assign(new Error('Trading 212 returned invalid data'), { code: 't212-invalid' });
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
function positionList(raw) {
  const list = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(list)) throw invalidT212();
  for (const p of list) {
    if (!p || typeof (p.instrument?.ticker || p.ticker) !== 'string' || !(p.instrument?.ticker || p.ticker) || !numeric(p.quantity)) throw invalidT212();
    if (p.currentPrice != null && !numeric(p.currentPrice)) throw invalidT212();
    if (p.walletImpact) {
      const w = p.walletImpact;
      if (!numeric(w.currentValue) || !numeric(w.totalCost) || (w.unrealizedProfitLoss != null && !numeric(w.unrealizedProfitLoss)) || (w.fxImpact != null && !numeric(w.fxImpact))) throw invalidT212();
    } else if (!numeric(p.ppl) || !numeric(p.currentPrice) || (p.fxPpl != null && !numeric(p.fxPpl))) throw invalidT212();
  }
  return list;
}
function t212Positions(raw, orders = []) {
  const list = positionList(raw);
  const names = new Map(); const cost = new Map();
  for (const o of orders) { if (o.ticker && o.name) names.set(o.ticker, o.name); if (o.ticker && Number.isFinite(o.value)) cost.set(o.ticker, (cost.get(o.ticker) || 0) + (o.side === 'SELL' ? -o.value : o.value)); }
  return list.map((p) => {
    const ins = p.instrument || {}; const ticker = ins.ticker || p.ticker || '';
    const w = p.walletImpact;
    if (w && Number.isFinite(Number(w.currentValue))) {
      return { ticker, name: ins.name || names.get(ticker) || prettyTicker(ticker), quantity: Number(p.quantity) || 0, currentPrice: Number(p.currentPrice) || null, value: r2(w.currentValue), cost: r2(w.totalCost), ppl: r2(w.unrealizedProfitLoss ?? (w.currentValue - w.totalCost)), fx: w.fxImpact == null ? null : r2(w.fxImpact), currency: ins.currency || null, since: p.createdAt || null, inPies: Number(p.quantityInPies) || 0 };
    }
    const c = cost.get(ticker); const ppl = Number(p.ppl) || 0; const fx = Number(p.fxPpl) || 0;
    return { ticker, name: names.get(ticker) || prettyTicker(ticker), quantity: Number(p.quantity) || 0, currentPrice: Number(p.currentPrice) || null, value: c == null ? null : r2(c + ppl + fx), cost: c == null ? null : r2(c), ppl: r2(ppl + fx), fx: p.fxPpl == null ? null : r2(fx), currency: null, since: p.initialFillDate || null, inPies: Number(p.pieQuantity) || 0 };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}
const prettyTicker = (t) => String(t || '').replace(/_(US_)?EQ$/, '').replace(/[a-z]$/, '');
function t212Orders(items) {
  return (items || []).map((it) => {
    const o = it.order || it; const f = it.fill || {}; const w = f.walletImpact || {};
    const value = Number.isFinite(Number(w.netValue)) ? Number(w.netValue) : Number(o.filledValue ?? o.value);
    return { id: String(o.id || f.id || ''), date: String(f.filledAt || o.createdAt || o.dateCreated || '').slice(0, 10), ticker: o.ticker || o.instrument?.ticker || '', name: o.instrument?.name || '', side: o.side || (Number(o.filledQuantity ?? o.quantity) < 0 ? 'SELL' : 'BUY'), status: o.status || '', value: Number.isFinite(value) ? r2(Math.abs(value)) : null, quantity: Number(f.quantity ?? o.filledQuantity ?? o.quantity) || 0, price: Number.isFinite(Number(f.price ?? o.fillPrice)) ? Number(f.price ?? o.fillPrice) : null, currency: o.instrument?.currency || null, from: o.initiatedFrom || '' };
  }).filter((o) => o.date && (!o.status || o.status === 'FILLED'));
}
// Pies: the list gives money in and value; each pie's detail gives its name and
// what's in it. Holdings in a pie are shown inside it, not one by one.
function t212Pies(list, details = {}) {
  return (Array.isArray(list) ? list : []).map((p) => {
    const d = details[p.id] || {}; const r = p.result || {};
    return { id: p.id, name: d.settings?.name || `Pie ${p.id}`, icon: d.settings?.icon || null, invested: r2(r.priceAvgInvestedValue), value: r2(r.priceAvgValue), result: r2(r.priceAvgResult), cash: r2(p.cash),
      instruments: (d.instruments || []).map((i) => ({ ticker: i.ticker, quantity: Number(i.ownedQuantity) || 0, invested: r2(i.result?.priceAvgInvestedValue), value: r2(i.result?.priceAvgValue), result: r2(i.result?.priceAvgResult), share: Number(i.currentShare) || 0 })) };
  });
}
function t212Account(summary) {
  const s = summary; const inv = s?.investments; const cash = s?.cash;
  // Only the headline numbers are required: Trading 212 has left the smaller fields out before, and the code below copes.
  const okIf = (v) => v == null || numeric(v);
  if (!s || !inv || typeof inv !== 'object' || !(numeric(s.totalValue) || numeric(inv.currentValue)) || !['currentValue', 'totalCost', 'unrealizedProfitLoss', 'realizedProfitLoss'].every((k) => okIf(inv[k]))
    || !(cash == null || numeric(cash) || (typeof cash === 'object' && ['availableToTrade', 'reservedForOrders', 'inPies'].every((k) => okIf(cash[k]))))) throw invalidT212();
  const cashTotal = typeof cash === 'number' ? cash : (Number(cash?.availableToTrade) || 0) + (Number(cash?.reservedForOrders) || 0) + (Number(cash?.inPies) || 0);
  return { currency: s.currency || 'GBP', value: r2(s.totalValue ?? (Number(inv.currentValue || 0) + cashTotal)), invested: r2(inv.currentValue), cost: r2(inv.totalCost), cash: r2(cashTotal), unrealised: r2(inv.unrealizedProfitLoss), realised: r2(inv.realizedProfitLoss) };
}

// ---------------------------------------------------------------- validation

function cleanRules(body) {
  const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, 100);
  const cats = {};
  for (const [k, v] of Object.entries(body?.categories || {}).slice(0, 200)) { const kk = String(k).trim().slice(0, 80); const vv = String(v || '').trim().slice(0, 40); if (kk && vv) cats[kk] = vv; }
  return { salary: list(body?.salary), internal: list(body?.internal), invest: list(body?.invest), ignore: list(body?.ignore), categories: cats };
}
function cleanAccounts(list, previous = [], today = isoDay(Date.now())) {
  if (!Array.isArray(list)) throw Object.assign(new Error('accounts must be a list'), { status: 400 });
  const prev = new Map((previous || []).map((a) => [a.id, a]));
  return list.slice(0, 30).map((a) => {
    const name = String(a?.name || '').trim().slice(0, 60); if (!name) throw Object.assign(new Error('every account needs a name'), { status: 400 });
    const balance = Number(a.balance); if (!Number.isFinite(balance) || Math.abs(balance) > 1e8) throw Object.assign(new Error(`${name}: balance is not a number`), { status: 400 });
    const id = /^[a-z0-9]{6,16}$/.test(String(a.id || '')) ? a.id : crypto.randomBytes(5).toString('hex');
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(a.asOf || '')) ? a.asOf : today;
    const old = prev.get(id); const history = (old?.history || []).slice(-400);
    if (!old || old.balance !== r2(balance) || old.asOf !== asOf) { const i = history.findIndex((h) => h.date === asOf); if (i >= 0) history.splice(i, 1); history.push({ date: asOf, balance: r2(balance) }); history.sort((x, y) => x.date.localeCompare(y.date)); }
    return { id, name, kind: ACCOUNT_KINDS.includes(a.kind) ? a.kind : 'other', balance: r2(balance), asOf, note: String(a.note || '').trim().slice(0, 120), history };
  });
}

// What Owner has told Meridian about his money (context.json). A patch merges in:
// tx and subs entries set to null are removed; trips, notes and profile replace.
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const text = (v, n) => String(v ?? '').trim().slice(0, n);
function cleanContext(patch, cur = {}) {
  const out = { tx: { ...(cur.tx || {}) }, subs: { ...(cur.subs || {}) }, trips: cur.trips || [], notes: cur.notes || [], profile: cur.profile || '', lots: cur.lots || [] };
  for (const [id, v] of Object.entries(patch?.tx || {}).slice(0, 200)) {
    const k = text(id, 80); if (!k) continue;
    if (v === null) { delete out.tx[k]; continue; }
    const e = { ...(out.tx[k] || {}) };
    if ('note' in v) e.note = text(v.note, 300) || undefined;
    if ('tag' in v) e.tag = TX_TAGS.includes(v.tag) ? v.tag : undefined;
    if ('cat' in v) e.cat = text(v.cat, 40) || undefined;
    if ('trip' in v) e.trip = text(v.trip, 40) || undefined;
    if ('feel' in v) e.feel = ['love', 'regret'].includes(v.feel) ? v.feel : undefined;
    if ('split' in v) { const sp = (Array.isArray(v.split) ? v.split : []).slice(0, 8).map((x) => ({ who: text(x.who, 40), amount: r2(x.amount), settled: !!x.settled })).filter((x) => x.who && x.amount > 0); e.split = sp.length ? sp : undefined; }
    for (const x of Object.keys(e)) if (e[x] === undefined) delete e[x];
    if (Object.keys(e).length) out.tx[k] = e; else delete out.tx[k];
  }
  for (const [name, v] of Object.entries(patch?.subs || {}).slice(0, 100)) {
    const k = text(name, 80).toLowerCase(); if (!k) continue;
    if (v === null || v.status === 'active' && !v.note) { delete out.subs[k]; continue; }
    out.subs[k] = { status: SUB_STATUS.includes(v.status) ? v.status : 'active', since: day(v.since) || isoDay(Date.now()), ...(day(v.until) ? { until: v.until } : {}), ...(text(v.note, 200) ? { note: text(v.note, 200) } : {}) };
  }
  if (Array.isArray(patch?.trips)) out.trips = patch.trips.slice(0, 60).map((t) => ({ id: /^[a-z0-9-]{3,40}$/.test(String(t.id || '')) ? t.id : 'trip-' + crypto.randomBytes(3).toString('hex'), name: text(t.name, 60) || 'Trip', kind: ['holiday', 'visit', 'night', 'other'].includes(t.kind) ? t.kind : 'holiday', from: day(t.from), to: day(t.to), with: text(t.with, 80), budget: Number.isFinite(Number(t.budget)) && Number(t.budget) > 0 ? r2(t.budget) : null, note: text(t.note, 200) }));
  if (Array.isArray(patch?.notes)) out.notes = patch.notes.slice(0, 80).map((n) => ({ id: /^[a-z0-9-]{3,40}$/.test(String(n.id || '')) ? n.id : 'note-' + crypto.randomBytes(3).toString('hex'), text: text(n.text, 400), from: day(n.from), to: day(n.to) })).filter((n) => n.text);
  if ('profile' in (patch || {})) out.profile = text(patch.profile, 1200);
  // Buys Trading 212's history doesn't show, as Owner remembers them.
  out.lots = Array.isArray(patch?.lots) ? patch.lots.slice(0, 60).map((l) => ({ ...(text(l.ticker, 30) ? { ticker: text(l.ticker, 30) } : {}), ...(text(l.pieName, 40) ? { pieName: text(l.pieName, 40) } : {}), date: day(l.date), value: r2(l.value), note: text(l.note, 120) })).filter((l) => l.date && l.value > 0 && (l.ticker || l.pieName)) : (cur.lots || []);
  return out;
}
// Payment plans (plans.json): rent by the term, as the accommodation statement shows it.
function cleanPlans(body) {
  const out = {};
  for (const [id, p] of Object.entries(body || {}).slice(0, 10)) {
    if (!/^[a-z0-9-]{2,30}$/.test(id) || !p) continue;
    out[id] = { id, kind: p.kind === 'income' ? 'income' : 'cost', name: text(p.name, 60) || 'Plan', payee: text(p.payee, 60), category: text(p.category, 40) || 'Rent', note: text(p.note, 300), source: text(p.source, 200),
      instalments: (Array.isArray(p.instalments) ? p.instalments : []).slice(0, 24).map((i) => ({ due: day(i.due), from: day(i.from), to: day(i.to), amount: r2(i.amount), ref: text(i.ref, 30), ...(day(i.paid) ? { paid: i.paid } : {}), ...(text(i.status, 40) ? { status: text(i.status, 40) } : {}) })).filter((i) => i.from && i.to && i.amount > 0),
      pending: (Array.isArray(p.pending) ? p.pending : []).slice(0, 10).map((x) => ({ text: text(x.text, 200), amount: Number.isFinite(Number(x.amount)) ? r2(x.amount) : null, since: day(x.since), done: !!x.done })).filter((x) => x.text) };
  }
  return out;
}

// ---------------------------------------------------------------- the advisor

// What the advisor sees: totals, categories, places, notes and plans. No
// transaction ids, no account numbers, nothing it doesn't need.
function adviceInput(b, today = isoDay(Date.now())) {
  const P = core.prepare(b.monzo.transactions, b.rules, { context: b.context, plans: b.plans });
  const sum = (sp) => { const s = core.summarize(P, sp); return { from: sp.from, to: sp.to, moneyIn: s.earned, salary: s.salary, otherIn: s.otherIn, spent: s.spent, dayToDay: s.steady, oneOffs: s.lumps, rentSpread: s.spread, toPots: s.saved, invested: s.invested, leftOver: s.left, categories: s.categories.slice(0, 10).map((c) => [c.name, c.spent]), places: s.merchants.filter((m) => !m.spread).slice(0, 10).map((m) => [m.name, m.spent, m.count]) }; };
  const pay = core.periodSpan('payday', P, today); const pd = core.paydays(P);
  const prevPay = pd.length > 1 ? { from: pd[pd.length - 2], to: core.addDays(pd[pd.length - 1], -1) } : null;
  const subs = core.recurring(P, today).map((r) => ({ ...r, mine: b.context?.subs?.[r.name.toLowerCase()] || null })).filter((r) => r.mine?.status !== 'hidden');
  const plans = Object.values(b.plans || {}).map((p) => ({ name: p.name, kind: p.kind, note: p.note, pending: p.pending, instalments: p.instalments.map((i) => ({ ...i, paid: !!i.paid || !!P.find((t) => t.planned && t.planned.from === i.from) || (p.kind === 'income' && i.due <= today) })) }));
  return {
    today, profile: b.context?.profile || '', notesFromOwner: (b.context?.notes || []).map((n) => ({ text: n.text, from: n.from, to: n.to })),
    paydays: pd.slice(-6), sincePayday: sum(pay), lastFullPayMonth: prevPay ? sum(prevPay) : null,
    lastCalendarMonth: sum(core.periodSpan('last', P, today)), months: core.monthly(P).slice(-6),
    regularPayments: subs.map((r) => ({ name: r.name, amount: r.amount, every: r.every, perMonth: r.monthly, last: r.last, lapsed: r.lapsed, status: r.mine?.status || 'active', note: r.mine?.note || '' })),
    plans, trips: (b.context?.trips || []).map((t) => ({ name: t.name, from: t.from, to: t.to, with: t.with, budget: t.budget, spent: r2(P.filter((x) => x.trip === t.id).reduce((a, x) => a - x.amount, 0)) })),
    paymentNotes: P.filter((t) => !t.synthetic && (t.myNote || t.oneOff === true || t.feel || t.split)).slice(-50).map((t) => ({ date: t.date, name: t.name, amount: t.amount, note: t.myNote || '', oneOff: !!t.oneOff, ...(t.feel ? { feel: t.feel === 'love' ? 'best buy' : 'regret' } : {}), ...(t.split ? { splitWith: t.split } : {}) })),
    portfolio: b.t212 ? { value: b.t212.account.value, paid: b.t212.account.cost, gain: b.t212.account.unrealised, asOf: b.t212.asOf } : null,
    otherAccounts: (b.accounts || []).map((a) => ({ name: a.name, kind: a.kind, balance: a.balance, asOf: a.asOf, note: a.note })),
  };
}
const ADVICE_SCHEMA = { type: 'object', additionalProperties: false, required: ['headline', 'glance', 'going_well', 'watch', 'try'], properties: {
  headline: { type: 'string' }, glance: { type: 'string' }, going_well: { type: 'array', items: { type: 'string' } }, watch: { type: 'array', items: { type: 'string' } }, try: { type: 'array', items: { type: 'string' } } } };
function advicePrompt(input) {
  return `You are Owner's personal finance adviser. Owner says money doesn't mean much to him and wants you to make sense of it: what he's doing well, what to watch, and what to aim for.

Read the JSON below. Amounts are GBP. Rent is paid by the term; it is already spread over the days each instalment covers ("rentSpread"), so a term's payment does not make one month look awful. "oneOffs" are big or tagged one-off purchases kept apart from day-to-day spending. Pots and investing are savings, not spending. Transfers between his own accounts are left out. Use his notes and profile for context, and don't scold him for things his notes explain.

Write like a sharp, friendly adviser talking to him across a table: plain words, specific £ figures from the data, no jargon, no lecturing, no emojis, no em dashes. Every item is one sentence of at most 22 words. Don't invent numbers or facts that aren't in the data. The data stops today, so never treat months that haven't happened as missing income. In regularPayments, lapsed true means it hasn't charged when expected (probably stopped); status says what Owner marked (cancelled, paused). Look forward: next rent instalment, money coming in before it (paydays and student loan instalments in "plans" with kind income), regular payments. Rent and the student loan are both spread over the dates they cover. If "anotherAdviserSaid" is present, that's a note from a different model: give your own view, and say briefly where you'd disagree.

Return:
- headline: one sentence, the overall picture right now.
- glance: two or three short sentences Owner can skim from the search bar without opening Money: where things stand, the next thing that matters, anything he needs to know.
- going_well: 2 or 3 things.
- watch: 2 or 3 things to keep an eye on.
- try: 2 or 3 concrete actions, each with a number where possible (for example how much to put aside each payday).

DATA
${JSON.stringify(input)}`;
}
function runAdviser(prompt, { model = ADVISOR_MODEL, effort } = {}) {
  const a = ADVISERS[model] || ADVISERS[ADVISOR_MODEL];
  return a.kind === 'codex' ? runCodex(prompt, { model, effort: effort || a.effort }) : runClaude(prompt, { model, effort: effort || a.effort });
}
const AGENT_PATH = () => [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':');
function runCodex(prompt, { model, effort = 'high', timeout = 600e3 } = {}) {
  const { spawn } = require('child_process');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-advice-'));
  const schema = path.join(cwd, 'schema.json'); const outFile = path.join(cwd, 'out.json');
  fs.writeFileSync(schema, JSON.stringify(ADVICE_SCHEMA));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(os.homedir(), '.local', 'bin', 'codex'), ['exec', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--output-schema', schema, '-o', outFile, '-'], { cwd, env: { ...process.env, PATH: AGENT_PATH() }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the adviser took too long')); }, timeout);
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', () => {
      clearTimeout(t);
      try { resolve({ advice: JSON.parse(fs.readFileSync(outFile, 'utf8')), cost: null }); }
      catch { reject(new Error('adviser: no answer from ' + model + (err ? ' (' + err.trim().split('\n').pop().slice(0, 120) + ')' : ''))); }
      finally { fs.rm(cwd, { recursive: true, force: true }, () => {}); }
    });
    child.stdin.end(prompt);
  });
}
function runClaude(prompt, { model = 'claude-opus-5-5', effort = 'medium', timeout = 600e3 } = {}) {
  const { spawn } = require('child_process');
  const bin = path.join(os.homedir(), '.local', 'bin', 'claude');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-advice-'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--model', model, '--tools', '', '--effort', effort, '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json', '--json-schema', JSON.stringify(ADVICE_SCHEMA)], { cwd, env: { ...process.env, PATH: AGENT_PATH() }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the advisor took too long')); }, timeout);
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', () => {
      clearTimeout(t); fs.rm(cwd, { recursive: true, force: true }, () => {});
      try { const j = JSON.parse(out); if (j.is_error || !j.structured_output) throw new Error(String(j.result || 'no answer').slice(0, 160)); resolve({ advice: j.structured_output, cost: j.total_cost_usd || null }); }
      catch (e) { reject(new Error('advisor: ' + (e.message || err.slice(0, 160)))); }
    });
    child.stdin.end(prompt);
  });
}
function cleanAdvice(a) {
  const list = (x) => (Array.isArray(x) ? x : []).map((v) => text(v, 240)).filter(Boolean).slice(0, 3);
  return { headline: text(a?.headline, 240), glance: text(a?.glance, 420), going_well: list(a?.going_well), watch: list(a?.watch), try: list(a?.try) };
}

// ---------------------------------------------------------------- the store

function createMoney({ dir, now = () => Date.now(), request = httpsRequest, log = console, wait = sleep, model = runAdviser, approvedClaims = () => ({}) } = {}) {
  const F = (n) => path.join(dir, n + '.json');
  let running = null; let timer = null;
  let lockChain = Promise.resolve();
  function serialiseLock(fn) {
    const run = lockChain.then(fn);
    lockChain = run.catch(() => {});
    return run;
  }
  let claimsChain = Promise.resolve();
  function serialiseClaims(fn) { const run = claimsChain.then(fn); claimsChain = run.catch(() => {}); return run; }
  async function claimsDoc() { return { claims: [], ...(await readJson(F('receivables'), {})) }; }
  const fails = { n: 0, until: 0 };
  let token = null; // Google access token { value, exp }

  async function creds() { return readJson(F('credentials'), {}); }
  async function settings() { return { refreshHour: 6, ...(await readJson(F('settings'), {})) }; }
  // okAt is the last success, kept through failures, so the daily run knows what it still owes.
  async function setStatus(source, value) { const s = await readJson(F('status'), {}); const at = new Date(now()).toISOString(); s[source] = { ...value, at, okAt: value.ok ? at : s[source]?.okAt || null }; await writeJson(F('status'), s); }

  // ---- Google
  async function googleToken() {
    if (token && token.exp > now() + 60e3) return token.value;
    const g = (await creds()).google;
    if (!g?.refresh_token || !g?.client_id) throw Object.assign(new Error('Google is not connected'), { code: 'google-missing' });
    const body = new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret || '', refresh_token: g.refresh_token, grant_type: 'refresh_token' }).toString();
    const r = await request(g.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
    if (r.status !== 200 || !r.json?.access_token) throw Object.assign(new Error(`Google sign-in failed (${r.status}${r.json?.error ? ', ' + r.json.error : ''})`), { code: 'google-auth' });
    token = { value: r.json.access_token, exp: now() + (Number(r.json.expires_in) || 3000) * 1000 };
    return token.value;
  }
  async function google(url) {
    const r = await request(url, { headers: { Authorization: 'Bearer ' + await googleToken() } });
    if (r.status !== 200) throw Object.assign(new Error(`Google returned ${r.status}${r.json?.error?.status ? ' ' + r.json.error.status : ''}`), { code: 'google-' + r.status });
    return r.json;
  }
  async function pullMonzo() {
    const st = await settings();
    let sheetId = st.monzo?.sheetId;
    if (!sheetId) { // find the export by name once, then remember it
      const q = new URLSearchParams({ q: "name contains 'Monzo Transactions' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields: 'files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '5' });
      const found = (await google('https://www.googleapis.com/drive/v3/files?' + q)).files || [];
      if (!found.length) throw Object.assign(new Error('No "Monzo Transactions" sheet in Google Drive'), { code: 'sheet-missing' });
      sheetId = found[0].id; await writeJson(F('settings'), { ...(await readJson(F('settings'), {})), monzo: { ...(st.monzo || {}), sheetId } });
    }
    const meta = await google(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`);
    const tabs = (meta.sheets || []).map((s) => s.properties.title);
    const all = []; const accounts = [];
    for (const title of tabs) {
      const v = await google(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(title)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
      const label = title.replace(/\s*Transactions$/i, '').replace(/^Personal Account$/i, 'Monzo').trim() || 'Monzo';
      const rows = monzoRows(v.values || [], label);
      if (rows.length) { all.push(...rows); accounts.push({ tab: title, account: label, rows: rows.length }); }
    }
    if (!all.length) throw Object.assign(new Error('The Monzo sheet had no transactions in it'), { code: 'sheet-empty' });
    // Keep anything the sheet has since dropped: Monzo's export only ever adds rows.
    const before = await readJson(F('monzo'), { transactions: [] });
    const byId = new Map((before.transactions || []).map((t) => [t.id, t])); for (const t of all) byId.set(t.id, { ...t, firstSeenAt: byId.get(t.id)?.firstSeenAt || new Date(now()).toISOString() });
    const transactions = [...byId.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    await writeJson(F('monzo'), { pulledAt: new Date(now()).toISOString(), accounts, transactions });
    await serialiseClaims(async () => { const doc = await claimsDoc(); const context = await readJson(F('context'), {}); const prepared = core.prepare(transactions, await readJson(F('rules'), {})); receivables.reconcile(doc, prepared, context); await writeJson(F('receivables'), doc); });
    const last = transactions[transactions.length - 1];
    await setStatus('monzo', { ok: true, rows: transactions.length, through: last?.date || null });
    return { rows: transactions.length };
  }

  // ---- Trading 212
  async function t212Get(pathname, c) {
    const host = T212_HOSTS[c.env] || T212_HOSTS.live;
    const p = pathname.startsWith('/api/v0') ? pathname : '/api/v0' + pathname;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await request(`https://${host}${p}`, { headers: { Authorization: 'Basic ' + Buffer.from(`${c.key}:${c.secret}`).toString('base64') } });
      if (r.status === 429) { const reset = Number(r.headers?.['x-ratelimit-reset']); const ms = reset ? Math.max(1000, reset * 1000 - now()) : 6000; await wait(Math.min(ms, 65000)); continue; }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(r.status === 401 ? 'Trading 212 turned the API key down (401). It may have been revoked or expired, so it needs replacing.' : 'Trading 212 refused the key from this address (403). If the key is limited to certain IP addresses, add the Home Mac\'s.'), { code: 'key-rejected', status: r.status });
      if (r.status !== 200) throw Object.assign(new Error(`Trading 212 returned ${r.status} for ${pathname.split('?')[0]}`), { code: 't212-' + r.status });
      if (!r.json || typeof r.json !== 'object') throw invalidT212();
      return r.json;
    }
    throw Object.assign(new Error('Trading 212 kept rate-limiting'), { code: 't212-429' });
  }
  async function pages(first, c, max = 40) {
    const items = []; let next = first; let n = 0;
    while (next && n < max) { const j = await t212Get(next, c); if (!Array.isArray(j.items) || (j.nextPagePath != null && typeof j.nextPagePath !== 'string')) throw invalidT212(); items.push(...j.items); next = j?.nextPagePath || null; n++; if (next) await wait(3200); } // 20 a minute
    return items;
  }
  async function pullT212(override) {
    const c = override || (await creds()).t212;
    if (!c?.key || !c?.secret) throw Object.assign(new Error('No Trading 212 API key yet'), { code: 't212-missing' });
    const summary = await t212Get('/equity/account/summary', c);
    const account = t212Account(summary);
    if (override) return { ok: true }; // a key test: one read, nothing saved
    await wait(1100);
    let rawPositions = null;
    try { rawPositions = await t212Get('/equity/positions', c); } catch (e) { if (e.code === 'key-rejected' || e.code === 't212-invalid') throw e; rawPositions = await t212Get('/equity/portfolio', c); }
    positionList(rawPositions);
    const before = await readJson(F('t212'), {});
    // The full order history once, then only the newest pages each day.
    const deep = !before.orders?.length || before.orders.some((o) => o.price === undefined);
    const ordersRaw = await pages('/equity/history/orders?limit=50', c, deep ? 40 : 2);
    const seen = new Map((before.orders || []).map((o) => [o.id, o])); for (const o of t212Orders(ordersRaw)) seen.set(o.id, o);
    const orders = [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
    let dividends = before.dividends || []; let transfers = before.transfers || [];
    try {
      await wait(3200); const d = await pages('/equity/history/dividends?limit=50', c, deep ? 20 : 2);
      const dm = new Map(dividends.map((x) => [x.ref, x])); for (const x of d) { const ref = String(x.reference || `${x.ticker}-${x.paidOn}`); dm.set(ref, { ref, date: String(x.paidOn || '').slice(0, 10), ticker: x.ticker || '', amount: r2(x.amount) }); }
      dividends = [...dm.values()].sort((a, b) => b.date.localeCompare(a.date));
      await wait(3200); const t = await pages('/equity/history/transactions?limit=50', c, deep ? 20 : 2);
      const tm = new Map(transfers.map((x) => [x.ref, x])); for (const x of t) { const ref = String(x.reference || `${x.type}-${x.dateTime}-${x.amount}`); tm.set(ref, { ref, date: String(x.dateTime || x.date || '').slice(0, 10), type: String(x.type || ''), amount: r2(x.amount) }); }
      transfers = [...tm.values()].sort((a, b) => b.date.localeCompare(a.date));
    } catch (e) { if (e.code === 'key-rejected' || e.code === 't212-invalid') throw e; log.warn?.('money: t212 history', e.message); }
    const positions = t212Positions(rawPositions, orders);
    let pies = before.pies || [];
    try {
      await wait(1500); const list = await t212Get('/equity/pies', c); if (!Array.isArray(list)) throw invalidT212(); const details = {};
      for (const p of (Array.isArray(list) ? list : []).slice(0, 12)) { await wait(5500); try { details[p.id] = await t212Get('/equity/pies/' + p.id, c); } catch (e) { if (e.code === 'key-rejected' || e.code === 't212-invalid') throw e; } }
      pies = t212Pies(list, details);
    } catch (e) { if (e.code === 'key-rejected' || e.code === 't212-invalid') throw e; log.warn?.('money: t212 pies', e.message); }
    const at = new Date(now()).toISOString();
    await writeJson(F('t212'), { pulledAt: at, asOf: isoDay(now()), source: 'api', account, positions, pies, orders: orders.slice(0, 2000), dividends, transfers });
    await snapshot({ date: isoDay(now()), value: account.value, cost: account.cost, cash: account.cash, unrealised: account.unrealised, source: 'api' });
    await setStatus('t212', { ok: true, value: account.value, positions: positions.length });
    return { value: account.value };
  }
  async function snapshot(row) {
    const h = await readJson(F('history'), { t212: [] }); const list = h.t212 || [];
    const i = list.findIndex((x) => x.date === row.date); if (i >= 0) list[i] = row; else list.push(row);
    list.sort((a, b) => a.date.localeCompare(b.date)); h.t212 = list; await writeJson(F('history'), h);
  }

  // ---- the daily run
  async function refresh(reason = 'manual') {
    if (!JOBS_ENABLED) throw jobsOffError();
    if (running) return running;
    running = (async () => {
      const out = { reason, at: new Date(now()).toISOString() };
      for (const [k, fn] of [['monzo', pullMonzo], ['t212', pullT212]]) {
        try { out[k] = { ok: true, ...(await fn()) }; } catch (e) { out[k] = { ok: false, code: e.code || 'error', error: e.message }; await setStatus(k, { ok: false, code: e.code || 'error', error: e.message }).catch(() => {}); }
      }
      return out;
    })().finally(() => { running = null; });
    return running;
  }
  // Once a day, after refreshHour (06:00 by default) so the morning has
  // yesterday's spending. Missed runs (the Mac asleep) catch up on wake.
  // Due when a source hasn't succeeded since the latest refreshHour (today's, or
  // yesterday's before it comes round). A source that failed waits 3 hours
  // before trying again, so a dead key isn't retried every 15 minutes.
  async function due() {
    const st = await settings(); const s = await readJson(F('status'), {});
    const has = await creds(); if (!has.google && !has.t212) return false;
    const d = new Date(now()); const mark = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(st.refreshHour ?? 6)).getTime();
    const since = now() >= mark ? mark : mark - 86400e3;
    const owed = (x) => !x || !x.okAt || Date.parse(x.okAt) < since;
    const waited = (x) => !x?.at || x.ok || now() - Date.parse(x.at) > 3 * 3600e3;
    return [['monzo', !!has.google], ['t212', !!has.t212]].some(([k, on]) => on && owed(s[k]) && waited(s[k]));
  }
  function start() {
    if (!JOBS_ENABLED) return;
    const tick = () => due().then(async (d) => {
      if (d) await refresh('daily');
      const a = await adviceDue();
      if (a) await advise({ reason: 'scheduled', model: a.model, effort: a.effort }).catch((e) => log.warn?.('money: adviser', e.message));
    }).catch((e) => log.warn?.('money: daily run', e.message));
    setTimeout(tick, 30e3).unref?.();
    timer = setInterval(tick, 15 * 60e3); timer.unref?.();
  }

  // ---- the lock
  async function lockDoc() { return readJson(F('lock'), { sessions: [] }); }
  async function session(req) {
    const t = cookies(req)[COOKIE]; if (!t || t.length < 20) return null;
    const doc = await lockDoc(); const h = sha(t);
    const s = (doc.sessions || []).find((x) => x.h === h && x.expires > now());
    return s || null;
  }
  async function newSession(req, res, remember) {
    const doc = await lockDoc(); const t = crypto.randomBytes(32).toString('base64url');
    const ms = remember ? REMEMBER_MS : SHORT_MS;
    const ua = String(req.headers['user-agent'] || ''); const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Meridian/i.test(ua) ? 'Mac app' : /Macintosh/.test(ua) ? 'Mac' : 'Browser';
    doc.sessions = (doc.sessions || []).filter((x) => x.expires > now()).slice(-20);
    doc.sessions.push({ h: sha(t), created: now(), expires: now() + ms, remember: !!remember, device });
    await writeJson(F('lock'), doc);
    const secure = String(req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/api/money; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ms / 1000)}${secure}`);
    return now() + ms;
  }
  const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/api/money; HttpOnly; SameSite=Strict; Max-Age=0`);
  async function checkPass(pass) {
    const doc = await lockDoc(); if (!doc.hash) return false;
    const k = await scrypt(pass, doc.salt); const want = Buffer.from(doc.hash, 'hex');
    return k.length === want.length && crypto.timingSafeEqual(k, want);
  }
  async function setPassNow(pass, { keepSessions = false } = {}) {
    const doc = await lockDoc(); const salt = crypto.randomBytes(16).toString('hex');
    doc.salt = salt; doc.hash = (await scrypt(pass, salt)).toString('hex'); doc.changed = now();
    if (!keepSessions) doc.sessions = [];
    await writeJson(F('lock'), doc);
  }
  const passOk = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 200;

  // ---- what the page gets
  async function bundle() {
    const [m, t, h, a, rules, status, st, c, context, plans, advice] = await Promise.all([readJson(F('monzo'), {}), readJson(F('t212'), {}), readJson(F('history'), {}), readJson(F('accounts'), { accounts: [] }), readJson(F('rules'), {}), readJson(F('status'), {}), settings(), creds(), readJson(F('context'), {}), readJson(F('plans'), {}), readJson(F('advice'), null)]);
    const claims = await claimsDoc();
    return {
      approvedClaimsSeeded: !!claims.approvedSeedVersion,
      receivables: claims.claims,
      senders: receivables.senderOptions(m.transactions || []),
      at: new Date(now()).toISOString(),
      monzo: { pulledAt: m.pulledAt || null, accounts: m.accounts || [], transactions: m.transactions || [] },
      t212: t.account ? { pulledAt: t.pulledAt, asOf: t.asOf, source: t.source, account: t.account, positions: t.positions || [], pies: t.pies || [], orders: (t.orders || []).slice(0, 400), dividends: (t.dividends || []).slice(0, 100), transfers: (t.transfers || []).slice(0, 200) } : null,
      history: h.t212 || [],
      accounts: a.accounts || [],
      rules: cleanRules(rules),
      status: { monzo: status.monzo || null, t212: status.t212 || null, running: !!running },
      connected: { google: !!c.google?.refresh_token, t212: !!c.t212?.key, sheet: !!st.monzo?.sheetId },
      settings: { refreshHour: Number(st.refreshHour ?? 6), seenAt: st.seenAt || null, palette: PALETTES.includes(st.palette) ? st.palette : 'meaning' },
      context: cleanContext({}, context), plans: cleanPlans(plans),
      advice: adviceView(advice),
      adviser: adviserSettings(st), advisers: Object.entries(ADVISERS).map(([id, a]) => ({ id, ...a })),
    };
  }

  // ---- the adviser: on a schedule (weekly by default) or when asked, by the
  // model Owner picks. advice.json keeps the last 12 notes, newest first.
  let advising = null;
  function adviceDoc(raw) {
    if (!raw) return { notes: [] };
    if (Array.isArray(raw.notes)) return raw;
    return { notes: raw.advice ? [{ id: 'n-' + Date.parse(raw.at || 0).toString(36), at: raw.at, date: raw.date, model: raw.model || 'claude-opus-5-5', effort: null, reason: raw.reason, advice: raw.advice, cost: raw.cost }] : [] };
  }
  function adviceView(raw) {
    const d = adviceDoc(raw);
    return { notes: d.notes, latest: d.notes[0] || null, running: advising ? { model: advising.model, since: advising.since } : null, lastError: d.lastError || null,
      // older shape, for anything still reading it
      ...(d.notes[0] ? { at: d.notes[0].at, advice: d.notes[0].advice, model: d.notes[0].model } : {}) };
  }
  function adviserSettings(st) {
    const a = st.adviser || {}; const m = ADVISERS[a.model] ? a.model : ADVISOR_MODEL;
    return { schedule: SCHEDULES.includes(a.schedule) ? a.schedule : 'weekly', weekday: Number.isInteger(a.weekday) ? a.weekday : 1, hour: Number.isInteger(a.hour) ? a.hour : 7, model: m, effort: EFFORTS.includes(a.effort) ? a.effort : ADVISERS[m].effort };
  }
  function advise({ reason = 'asked', model: m = ADVISOR_MODEL, effort, review = false } = {}) {
    if (advising) return advising.promise;
    if (!ADVISERS[m]) m = ADVISOR_MODEL;
    const job = { model: m, since: now() };
    job.promise = (async () => {
      const t0 = now();
      try {
        const b = await bundle(); if (!b.monzo.transactions.length) throw new Error('No Monzo data yet');
        const input = adviceInput(b, isoDay(now()));
        const prev = adviceDoc(await readJson(F('advice'), null));
        if (review && prev.notes[0]) input.anotherAdviserSaid = { by: ADVISERS[prev.notes[0].model]?.name || prev.notes[0].model, date: prev.notes[0].date, ...prev.notes[0].advice };
        const r = await model(advicePrompt(input), { model: m, effort });
        const note = { id: 'n-' + now().toString(36), at: new Date(now()).toISOString(), date: isoDay(now()), model: m, effort: effort || ADVISERS[m].effort, reason, review: !!review, advice: cleanAdvice(r.advice), cost: r.cost ?? null, ms: now() - t0 };
        const doc = adviceDoc(await readJson(F('advice'), null)); doc.notes = [note, ...doc.notes].slice(0, 12); delete doc.lastError;
        await writeJson(F('advice'), doc); return note;
      } catch (e) {
        const doc = adviceDoc(await readJson(F('advice'), null)); doc.lastError = { at: new Date(now()).toISOString(), model: m, error: String(e.message || e).slice(0, 200) };
        await writeJson(F('advice'), doc).catch(() => {}); throw e;
      }
    })().finally(() => { advising = null; });
    advising = job; return job.promise;
  }
  // Scheduled notes: weekly on the chosen weekday (Monday by default) or daily,
  // after the morning read. A missed week catches up on the next tick.
  async function adviceDue() {
    const st = await settings(); const a = adviserSettings(st); if (a.schedule === 'off') return null;
    const s = await readJson(F('status'), {}); if (!s.monzo?.okAt) return null;
    const d = new Date(now()); if (d.getHours() < Math.max(a.hour, Number(st.refreshHour ?? 6))) return null;
    const last = adviceDoc(await readJson(F('advice'), null)).notes.find((n) => n.reason === 'scheduled' || n.reason === 'daily');
    const age = last ? (now() - Date.parse(last.at)) / 86400e3 : Infinity;
    if (a.schedule === 'daily') return !last || last.date !== isoDay(now()) ? a : null;
    return (d.getDay() === a.weekday && age > 1) || age > 7.5 ? a : null;
  }

  // ---- routes
  async function handleNow(req, res, url) {
    const p = url.pathname;
    if (p !== '/api/money' && !p.startsWith('/api/money/')) return false;
    try {
      if (req.headers.authorization && p !== '/api/money/agent' && !p.startsWith('/api/money/agent/')) {
        sendJson(req, res, 403, { ok: false, error: 'not allowed' }); return true;
      }
      const doc = await lockDoc(); const s = await session(req);
      // Dedicated agent namespace, checked before browser sessions. Even an
      // unlocked cookie cannot rescue an invalid token or broaden its scopes.
      if (p === '/api/money/agent' || p.startsWith('/api/money/agent/')) {
        const tok = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1] || '';
        const authenticate = async () => moneyAgent.principal(await readJson(F('agents'), { tokens: [] }), tok, now());
        const agent = await authenticate();
        if (!agent) { await wait(300); sendJson(req, res, 401, { ok: false, error: 'not allowed' }); return true; }
        const isRead = req.method === 'GET' && (p === '/api/money/agent' || p === '/api/money/agent/receivables');
        const isWrite = req.method === 'POST' && p === '/api/money/agent/receivables';
        const scope = isRead ? 'money.read' : isWrite ? 'receivables.write' : null;
        if (!scope || !agent.scopes.includes(scope)) { sendJson(req, res, 403, { ok: false, error: 'not allowed' }); return true; }
        if (isRead) {
          if (p === '/api/money/agent') sendJson(req, res, 200, await bundle());
          else { const doc = await claimsDoc(); const m = await readJson(F('monzo'), {}); sendJson(req, res, 200, { ok: true, at: new Date(now()).toISOString(), claims: doc.claims, senders: receivables.senderOptions(m.transactions || []) }); }
          return true;
        }
        if (!sameOriginJson(req)) { sendJson(req, res, 403, { ok: false, error: 'not allowed' }); return true; }
        const body = moneyAgent.claimInput(await readBody(req));
        const result = await serialiseClaims(async () => {
          // Recheck at execution time so queued requests cannot survive revocation.
          const current = await authenticate();
          if (!current || !current.scopes.includes('receivables.write')) throw Object.assign(new Error('not allowed'), { status: 403 });
          const doc = await claimsDoc(); const m = await readJson(F('monzo'), {}); const txs = m.transactions || []; const at = new Date(now()).toISOString();
          const beforeClaims = new Map(doc.claims.map(c => [c.id, JSON.parse(JSON.stringify(c))]));
          if (body.action !== 'create') receivables.act(doc, body, txs, at);
          const claim = body.action === 'create' ? receivables.create(doc, body, txs, at) : doc.claims.find(c => c.id === body.id);
          // Store the audit with the record in one atomic write: no successful
          // agent mutation can commit without its actor and before/after evidence.
          doc.agentAudit = doc.agentAudit || [];
          doc.agentAudit.push({ id: crypto.randomUUID(), at, agent: current.name, scope: 'receivables.write', action: body.action, claimId: claim.id, before: beforeClaims.get(claim.id) || null, after: JSON.parse(JSON.stringify(claim)) });
          await writeJson(F('receivables'), doc);
          return { ok: true, claim, at };
        });
        sendJson(req, res, 200, result); return true;
      }
      if (p === '/api/money/status' && req.method === 'GET') { sendJson(req, res, 200, { ok: true, setup: !!doc.hash, unlocked: !!s, until: s?.expires || null, remember: !!s?.remember }); return true; }
      if (req.method !== 'GET' && !sameOriginJson(req)) { sendJson(req, res, 403, { ok: false, error: 'not allowed' }); return true; }

      if (p === '/api/money/setup' && req.method === 'POST') {
        if (doc.hash) { sendJson(req, res, 409, { ok: false, error: 'A passcode is already set' }); return true; }
        const b = await readBody(req); if (!passOk(b.passcode)) { sendJson(req, res, 400, { ok: false, error: 'Use at least 6 characters' }); return true; }
        await setPassNow(b.passcode); const until = await newSession(req, res, b.remember !== false);
        sendJson(req, res, 200, { ok: true, until }); return true;
      }
      if (p === '/api/money/unlock' && req.method === 'POST') {
        if (fails.until > now()) { sendJson(req, res, 429, { ok: false, error: `Too many tries. Wait ${Math.ceil((fails.until - now()) / 1000)} seconds.`, wait: fails.until - now() }); return true; }
        const b = await readBody(req);
        if (!doc.hash || !(await checkPass(String(b.passcode || '')))) {
          fails.n++; if (fails.n >= 5) fails.until = now() + Math.min(15 * 60e3, 30e3 * 2 ** (fails.n - 5));
          await wait(400);
          sendJson(req, res, 401, { ok: false, error: 'That isn\'t it' }); return true;
        }
        fails.n = 0; fails.until = 0;
        const until = await newSession(req, res, !!b.remember);
        sendJson(req, res, 200, { ok: true, until }); return true;
      }
      if (p === '/api/money/lock' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const t = cookies(req)[COOKIE];
        doc.sessions = b.all && s ? [] : (doc.sessions || []).filter((x) => x.h !== sha(t || ''));
        await writeJson(F('lock'), doc); clearCookie(res);
        sendJson(req, res, 200, { ok: true }); return true;
      }

      // Everything below needs an unlocked session.
      if (!s) { sendJson(req, res, 401, { ok: false, locked: true, setup: !!doc.hash, error: 'Locked' }); return true; }

      if (p === '/api/money' && req.method === 'GET') { sendJson(req, res, 200, await bundle()); return true; }
      if (p === '/api/money/refresh' && req.method === 'POST') {
        req.resume(); const out = await refresh('manual');
        sendJson(req, res, 200, { ok: true, result: out, data: await bundle() }); return true;
      }
      if (p === '/api/money/receivables' && req.method === 'POST') {
        const b = await readBody(req);
        const result = await serialiseClaims(async () => {
          const doc = await claimsDoc(); const m = await readJson(F('monzo'), {}); const txs = m.transactions || []; const at = new Date(now()).toISOString();
          if (b.action === 'seed-approved') receivables.seed(doc, txs, at, approvedClaims());
          else if (b.action === 'create') receivables.create(doc, b, txs, at);
          else receivables.act(doc, b, txs, at);
          await writeJson(F('receivables'), doc); return { approvedClaimsSeeded: !!doc.approvedSeedVersion, claims: doc.claims, senders: receivables.senderOptions(txs) };
        });
        sendJson(req, res, 200, { ok: true, ...result }); return true;
      }
      if (p === '/api/money/accounts' && req.method === 'PUT') {
        const b = await readBody(req); const before = await readJson(F('accounts'), { accounts: [] });
        const accounts = cleanAccounts(b.accounts, before.accounts, isoDay(now()));
        await writeJson(F('accounts'), { updated: new Date(now()).toISOString(), accounts });
        sendJson(req, res, 200, { ok: true, accounts }); return true;
      }
      if (p === '/api/money/rules' && req.method === 'PUT') {
        const rules = cleanRules(await readBody(req)); await writeJson(F('rules'), rules);
        sendJson(req, res, 200, { ok: true, rules }); return true;
      }
      if (p === '/api/money/t212-key' && req.method === 'POST') {
        const b = await readBody(req); const key = String(b.key || '').trim(); const secret = String(b.secret || '').trim();
        if (!key || !secret || key.length > 300 || secret.length > 300) { sendJson(req, res, 400, { ok: false, error: 'Paste both the key and the secret' }); return true; }
        const c = { key, secret, env: 'live', added: new Date(now()).toISOString() };
        try { await pullT212(c); } catch (e) { sendJson(req, res, 400, { ok: false, error: e.message }); return true; }
        const all = await creds(); all.t212 = c; await writeJson(F('credentials'), all);
        const out = await refresh('new key');
        sendJson(req, res, 200, { ok: true, result: out, data: await bundle() }); return true;
      }
      if (p === '/api/money/passcode' && req.method === 'POST') {
        const b = await readBody(req);
        if (!(await checkPass(String(b.current || '')))) { sendJson(req, res, 401, { ok: false, error: 'The current passcode isn\'t right' }); return true; }
        if (!passOk(b.next)) { sendJson(req, res, 400, { ok: false, error: 'Use at least 6 characters' }); return true; }
        await setPassNow(b.next); const until = await newSession(req, res, !!s.remember);
        sendJson(req, res, 200, { ok: true, until }); return true;
      }
      if (p === '/api/money/settings' && req.method === 'PUT') {
        const b = await readBody(req); const cur = await readJson(F('settings'), {});
        const h = Number(b.refreshHour); if (Number.isInteger(h) && h >= 0 && h <= 23) cur.refreshHour = h;
        if (PALETTES.includes(b.palette)) cur.palette = b.palette;
        await writeJson(F('settings'), cur); sendJson(req, res, 200, { ok: true, settings: { refreshHour: Number(cur.refreshHour ?? 6), palette: cur.palette || 'meaning' } }); return true;
      }
      // What's new is everything since the last visit: the page says when it's been looked at.
      if (p === '/api/money/seen' && req.method === 'PUT') {
        req.resume(); const cur = await readJson(F('settings'), {}); cur.seenAt = new Date(now()).toISOString(); await writeJson(F('settings'), cur);
        sendJson(req, res, 200, { ok: true, seenAt: cur.seenAt }); return true;
      }
      if (p === '/api/money/context' && req.method === 'PATCH') {
        const context = cleanContext(await readBody(req, 60000), await readJson(F('context'), {}));
        await writeJson(F('context'), context); sendJson(req, res, 200, { ok: true, context }); return true;
      }
      if (p === '/api/money/plans' && req.method === 'PUT') {
        const plans = cleanPlans(await readBody(req, 60000)); await writeJson(F('plans'), plans);
        sendJson(req, res, 200, { ok: true, plans }); return true;
      }
      if (p === '/api/money/advice' && req.method === 'GET') { sendJson(req, res, 200, { ok: true, advice: adviceView(await readJson(F('advice'), null)) }); return true; }
      if (p === '/api/money/advice' && req.method === 'POST') {
        // Starts the note and answers at once: Codex can take a few minutes, and the page polls.
        const b = await readBody(req).catch(() => ({}));
        const m = ADVISERS[b.model] ? b.model : adviserSettings(await settings()).model;
        if (!advising) advise({ reason: b.review ? 'review' : 'asked', model: m, effort: EFFORTS.includes(b.effort) ? b.effort : undefined, review: !!b.review }).catch((e) => log.warn?.('money: adviser', e.message));
        sendJson(req, res, 202, { ok: true, advice: adviceView(await readJson(F('advice'), null)) }); return true;
      }
      if (p === '/api/money/advice' && req.method === 'DELETE') {
        const b = await readBody(req).catch(() => ({})); const doc = adviceDoc(await readJson(F('advice'), null));
        doc.notes = b.all ? [] : doc.notes.filter((n) => n.id !== b.id); delete doc.lastError;
        await writeJson(F('advice'), doc); sendJson(req, res, 200, { ok: true, advice: adviceView(doc) }); return true;
      }
      if (p === '/api/money/adviser' && req.method === 'PUT') {
        const b = await readBody(req); const cur = await readJson(F('settings'), {}); const a = { ...(cur.adviser || {}) };
        if (SCHEDULES.includes(b.schedule)) a.schedule = b.schedule; if (ADVISERS[b.model]) a.model = b.model; if (EFFORTS.includes(b.effort)) a.effort = b.effort;
        if (Number.isInteger(b.weekday) && b.weekday >= 0 && b.weekday <= 6) a.weekday = b.weekday;
        if (Number.isInteger(b.hour) && b.hour >= 0 && b.hour <= 23) a.hour = b.hour;
        cur.adviser = a; await writeJson(F('settings'), cur); sendJson(req, res, 200, { ok: true, adviser: adviserSettings(cur) }); return true;
      }
      sendJson(req, res, 404, { ok: false, error: 'not found' }); return true;
    } catch (e) {
      sendJson(req, res, e.status || 500, { ok: false, error: e.status ? e.message : p.startsWith('/api/money/agent') ? 'Money agent request failed' : 'Money hit an error: ' + String(e.message || e).slice(0, 160) });
      return true;
    }
  }

  const setPass = (pass, options) => serialiseLock(() => setPassNow(pass, options));
  const lockRoutes = new Set(['/api/money/setup', '/api/money/unlock', '/api/money/lock', '/api/money/passcode']);
  const handle = (req, res, url) => req.method === 'POST' && lockRoutes.has(url.pathname) ? serialiseLock(() => handleNow(req, res, url)) : handleNow(req, res, url);

  return { handle, start, due, advise, adviceDue, refresh, pullMonzo, pullT212, bundle, setPass, snapshot, files: F, dir };
}

module.exports = { httpsRequest, createMoney, t212Pies, ADVISERS, cleanContext, cleanPlans, adviceInput, advicePrompt, cleanAdvice, ADVICE_SCHEMA, monzoRows, sheetDate, sheetTime, t212Positions, t212Orders, t212Account, cleanRules, cleanAccounts, writeJson, readJson, COOKIE };
