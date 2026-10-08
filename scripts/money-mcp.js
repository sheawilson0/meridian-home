#!/usr/bin/env node
'use strict';

// Meridian Money as an MCP server (3 Oct 2026), so any agent (Claude Code,
// Codex, Hermes or whatever comes next) can ask about spending and the
// portfolio. Stdio only; scoped remote grants can also edit local receivables.
// Legacy local reads use the files the daemon already
// wrote in data/money/: never credentials.json, never the network, never
// Trading 212 itself, so an agent can't trade or see a key.
//
// Add it to an agent with, for example:
//   claude mcp add meridian-money -- node ~/Meridian/scripts/money-mcp.js
//   codex mcp add meridian-money -- node ~/Meridian/scripts/money-mcp.js
//
// The passcode on the Money tab doesn't apply here: anything that can run
// this script can already read those files as you. Only add it to agents you
// would let read your bank statement.
//
// On another Mac (the Main MacBook) it reads over Tailscale instead: set
// MERIDIAN_MONEY_URL (the Home Mac's Meridian address) and MERIDIAN_MONEY_TOKEN
// (from `node scripts/money-setup.js agent-token main` on the Home Mac). The
// Legacy tokens are read-only. A grant with receivables.write also opens the
// dedicated agent receivables route; it never authorizes browser write routes.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { negotiateVersion, requestError, toolDefinition } = require('../mcp-protocol');
const C = require('../public/money-core');

const DIR = process.env.MERIDIAN_MONEY_DIR || path.join(__dirname, '..', 'data', 'money');
const REMOTE = process.env.MERIDIAN_MONEY_URL ? { url: process.env.MERIDIAN_MONEY_URL.replace(/\/+$/, ''), token: process.env.MERIDIAN_MONEY_TOKEN || '' } : null;
if (REMOTE) {
  const u = new URL(REMOTE.url);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(
    (u.protocol === 'https:' && u.hostname === 'localhost' && !u.port) ||
    (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
  )) throw new Error('Use Home Meridian HTTPS or the local Home test/server endpoint');
}
async function agentRequest(route, body) {
  if (!REMOTE || !REMOTE.token) throw new Error('Configure a private Home agent token and URL; local file writes are not supported');
  const r = await fetch(REMOTE.url + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + REMOTE.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(r.status === 401 ? 'Money agent access was revoked or is invalid' : r.status === 403 ? 'Money agent scope does not permit this action' : 'Money agent request rejected (' + r.status + ')');
  return await r.json();
}
let remote = null; let remoteAt = 0;
// The daemon's bundle, reshaped to look like the files it came from.
async function pull() {
  if (!REMOTE) return; // Authenticate every call so revocation takes effect immediately.
  const b = await agentRequest('/api/money/agent');
  remote = { monzo: { pulledAt: b.monzo?.pulledAt, transactions: b.monzo?.transactions || [] }, rules: b.rules || {}, context: b.context || {}, plans: b.plans || {}, t212: b.t212, history: { t212: b.history || [] }, accounts: { accounts: b.accounts || [] }, advice: b.advice || null };
  remoteAt = Date.now();
}
const read = (n, fb) => { if (REMOTE) return remote && remote[n] != null ? remote[n] : fb; try { return JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8')); } catch { return fb; } };
const plain = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const PERIOD = { type: 'string', enum: ['payday', 'month', 'last', '90d', 'all'], description: 'payday = since the last salary landed, month = this calendar month, last = last calendar month, 90d = the last 3 months, all = everything' };

function load() {
  const m = read('monzo', { transactions: [] }); const context = read('context', {});
  return { P: C.prepare(m.transactions || [], read('rules', {}), { context, plans: read('plans', {}) }), context, pulledAt: m.pulledAt || null, today: C.isoDay(new Date()) };
}

const TOOLS = [
  { name: 'money_snapshot', remoteOnly: true, description: 'Read the current stored Home Money snapshot with source timestamps. Requires money.read; does not refresh bank data.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run() { return agentRequest('/api/money/agent'); } },
  { name: 'money_receivables', remoteOnly: true, description: 'Read local money-owed claims and verified imported payer IDs from Home. Requires money.read.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run() { return agentRequest('/api/money/agent/receivables'); } },
  { name: 'money_receivable_write', remoteOnly: true, description: 'When instructed by Owner, create or edit a local GBP money-owed claim, link a payer ID already verified in the bank import, mark settled, or undo settlement. Requires receivables.write. Never modifies bank transactions or transfers/trades money. Use a stable key for create retries. Read back before retrying an ambiguous result.', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { type: 'string', enum: ['create', 'edit', 'link', 'settle', 'undo'] }, id: { type: 'string' }, who: { type: 'string' }, amount: { type: 'number', description: 'Positive GBP amount for create or edit' }, note: { type: 'string' }, senderId: { type: 'string', description: 'Actual verified bank-import ID; never guess from a name' }, key: { type: 'string', description: 'Stable retry key for create' } } },
    async run(body) { const result = await agentRequest('/api/money/agent/receivables', body); remoteAt = 0; return result; } },
  { name: 'money_overview', description: 'Money in, spent, left over, saved and invested for a period, with the biggest categories and places and a few plain-English observations. Amounts in GBP.', inputSchema: { type: 'object', properties: { period: PERIOD } },
    run({ period = 'payday' }) {
      const { P, pulledAt, today } = load(); const sp = C.periodSpan(period, P, today); const s = C.summarize(P, sp); const pv = sp.prev ? C.summarize(P, sp.prev) : null;
      const tips = C.insights(P, sp, s, pv, { prevSpan: sp.prev, prevLabel: sp.prevLabel, recurring: C.recurring(P, today) }).map((t) => plain(t.text));
      return { period: { id: sp.id, from: sp.from, to: sp.to, comparedWith: sp.prev }, dataReadAt: pulledAt, moneyIn: s.earned, salary: s.salary, otherIn: s.otherIn, spent: s.spent, spentDayToDay: s.steady, bigOneOffs: s.lumps, refunds: s.refunds, leftOver: s.left, toPots: s.saved, invested: s.invested,
        previous: pv ? { moneyIn: pv.earned, spent: pv.spent, spentDayToDay: pv.steady } : null, categories: s.categories.slice(0, 12), places: s.merchants.slice(0, 12), observations: tips };
    } },
  { name: 'money_transactions', description: 'Individual Monzo payments, newest first, with any note Owner added (myNote), one-off flags and trips. Rent paid by the term shows as kind planned; its cost is spread daily elsewhere. Filter by dates, a search over names, notes and categories, a category, or a kind (spend, income, pot, internal, invest).', inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, search: { type: 'string' }, category: { type: 'string' }, kind: { type: 'string', enum: ['spend', 'income', 'pot', 'internal', 'invest'] }, limit: { type: 'number', description: 'up to 200, default 50' } } },
    run({ from, to, search, category, kind, limit = 50 }) {
      const { P } = load(); const q = String(search || '').toLowerCase();
      const list = P.filter((t) => !t.synthetic && (!from || t.date >= from) && (!to || t.date <= to) && (!category || t.cat.toLowerCase() === String(category).toLowerCase()) && (!kind || t.kind === kind) && (!q || [t.name, t.notes, t.cat, t.description].some((x) => String(x || '').toLowerCase().includes(q)))).reverse();
      return { total: list.length, transactions: list.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map((t) => ({ date: t.date, time: t.time, name: t.name, category: t.cat, kind: t.kind, amount: t.amount, ...(t.local ? { local: t.local } : {}), ...(t.notes ? { notes: t.notes } : {}), ...(t.myNote ? { myNote: t.myNote } : {}), ...(t.oneOff ? { oneOff: true } : {}), ...(t.trip ? { trip: t.trip } : {}), ...(t.feel ? { feel: t.feel } : {}), ...(t.split ? { split: t.split } : {}) })) };
    } },
  { name: 'money_context', description: "What Owner has told Meridian: a short profile, dated notes that explain odd weeks, trips, regular payments he's cancelled or paused, the rent plan (paid by the term, spread over the dates each instalment covers) and the latest adviser note. Read this before judging his spending.", inputSchema: { type: 'object', properties: {} },
    run() { const { P, context } = load(); const plans = read('plans', {}); const advice = read('advice', null);
      return { profile: context.profile || '', notes: context.notes || [], trips: (context.trips || []).map((t) => ({ ...t, spent: Math.round(P.filter((x) => x.trip === t.id && x.kind === 'spend').reduce((a, x) => a - x.amount, 0) * 100) / 100 })), regularPaymentStatus: context.subs || {},
        plans: Object.values(plans).map((p) => ({ name: p.name, note: p.note, pending: p.pending, instalments: p.instalments.map((i) => ({ ...i, paid: !!i.paid || P.some((t) => t.planned && t.planned.from === i.from) })) })),
        adviser: (() => { const n = advice?.notes?.[0] || advice?.latest || (advice?.advice ? advice : null); return n ? { date: n.date, model: n.model, ...n.advice } : null; })() }; } },
  { name: 'money_months', description: 'Every calendar month: money in, spent, saved to pots, invested and left over.', inputSchema: { type: 'object', properties: {} },
    run() { const { P, today } = load(); return { months: C.monthly(P, today) }; } },
  { name: 'money_regular_payments', description: 'Subscriptions and other regular payments found in Monzo (monthly, weekly, yearly), with the typical amount and the next expected date. lapsed = it hasn\'t come round when expected.', inputSchema: { type: 'object', properties: {} },
    run() { const { P, today, context } = load(); return { payments: C.recurring(P, today).map((r) => ({ ...r, status: context.subs?.[r.name.toLowerCase()] || null })).filter((r) => r.status?.status !== 'hidden') }; } },
  { name: 'money_portfolio', description: 'Trading 212: value, what was paid, gain, cash, each holding, and the daily value history. Read-only; no trading.', inputSchema: { type: 'object', properties: {} },
    run() { const t = read('t212', null); const a = read('accounts', { accounts: [] });
      return { tradingAccount: t ? { asOf: t.asOf, source: t.source, ...t.account, holdings: t.positions, dividends: (t.dividends || []).slice(0, 50) } : null, dailyHistory: (read('history', {}).t212 || []).slice(-120), otherAccounts: (a.accounts || []).map(({ history, ...x }) => x) }; } },
];

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  const invalid = requestError(msg);
  if (invalid) return fail(invalid.id, invalid.error.code, invalid.error.message);
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications
  if (method === 'initialize') return reply(id, { protocolVersion: negotiateVersion(params.protocolVersion), capabilities: { tools: {} }, serverInfo: { name: 'meridian-money', version: '1.0.0' }, instructions: 'Private Home Money snapshots in GBP, refreshed by Meridian. Scoped tokens can also edit local receivables only when Owner instructs. Never transfer/trade money, alter bank transactions, or send financial data elsewhere.' });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(toolDefinition) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params.name); if (!tool) return fail(id, -32602, 'unknown tool ' + params.name);
    try { if (!tool.remoteOnly) await pull(); return reply(id, { content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments || {}), null, 1) }] }); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
  }
  fail(id, -32601, 'method not found');
});
