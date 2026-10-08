'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const L = require('../ai-usage-ledger');
const H = require('../scripts/ai-usage-history');
const { spawnSync } = require('node:child_process');
const python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
const pythonAvailable = spawnSync(python, ['--version']).status === 0;
const needsPython = { skip: !pythonAvailable && 'Python 3 is needed for the collector fixture, no live logs are read' };

const ROOT = path.join(__dirname, '..');
const COLLECTOR = path.join(ROOT, 'scripts', 'ai-usage-collect.py');
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

async function tempDir(t, name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `meridian-ai-history-${name}-`));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const event = (o) => ({ key: o.key || Math.random().toString(36), provider: 'Codex', profile: '.codex', session: 's1', timestamp: '2026-09-30T12:00:00Z', model: 'gpt-6-sol', tokens: [1, 2, 3, 4], ...o });
const row = (o) => ({ date: '2026-09-30', machine: 'Main', provider: 'openai', profile: '.codex', model: 'gpt-6-sol', plan_type: '', plan: '', input: 10, cache_read: 0, cache_write: 0, output: 0, total_tokens: 10, events: 1, sessions: 1, api_value_usd: 0, ...o });

test('events become London-day rows with distinct sessions; plan_type is kept for Codex only', () => {
  const rows = H.eventsToRows([
    event({ timestamp: '2026-09-30T23:30:00Z', session: 'a', plan_type: 'team' }), // 00:30 BST on 1 Oct
    event({ timestamp: '2026-10-01T08:00:00Z', session: 'a', plan_type: 'team' }),
    event({ timestamp: '2026-10-01T09:00:00Z', session: 'b', plan_type: 'team' }),
    event({ timestamp: '2026-10-01T09:00:00Z', session: 'c', plan_type: 'plus' }),
    event({ provider: 'Claude Code', profile: '.claude', model: 'claude-opus-5-5', plan_type: 'team' }),
    event({ timestamp: '2026-09-20T12:00:00Z' }), // before the window
    event({ provider: 'Gemini' }),
  ], { machine: 'Main', from: '2026-09-21' });
  const by = Object.fromEntries(rows.map((r) => [`${r.date} ${r.provider} ${r.plan_type}`, r]));
  assert.equal(by['2026-10-01 openai team'].events, 3);
  assert.equal(by['2026-10-01 openai team'].sessions, 2);
  assert.equal(by['2026-10-01 openai team'].total_tokens, 30);
  assert.equal(by['2026-10-01 openai plus'].events, 1);
  assert.equal(by['2026-09-30 claude '].plan_type, '');
  assert.equal(rows.length, 3);
  assert.equal(rows.skipped, 1);
});

test('upsert: only the window changes, and a provider-day total never goes down', () => {
  const existing = [
    row({ date: '2026-09-01', total_tokens: 100, input: 100 }), // outside the window
    row({ date: '2026-09-25', total_tokens: 50, input: 50 }), // the rescan finds more: replaced
    row({ date: '2026-09-26', provider: 'claude', profile: '.claude', total_tokens: 500, input: 500 }), // transcripts deleted: kept
    row({ date: '2026-09-27', total_tokens: 70, input: 70, plan_type: 'team' }), // same total: existing kept
    row({ date: '2026-09-28', profile: '.codex_p', total_tokens: 5, input: 5 }), // moves profile: no double count
    row({ date: '2026-09-28', profile: '.codex', total_tokens: 20, input: 20 }),
    row({ date: '2026-09-25', machine: 'Home', total_tokens: 1, input: 1 }), // other machine
  ];
  const fresh = [
    row({ date: '2026-09-25', total_tokens: 80, input: 80 }),
    row({ date: '2026-09-26', provider: 'claude', profile: '.claude', total_tokens: 200, input: 200 }),
    row({ date: '2026-09-27', total_tokens: 70, input: 70, plan_type: '' }),
    row({ date: '2026-09-28', profile: '.codex', total_tokens: 26, input: 26 }), // the moved event plus 1 new token
    row({ date: '2026-09-29', total_tokens: 9, input: 9 }),
  ];
  const up = H.upsert(existing, fresh, { machine: 'Main', from: '2026-09-21', to: '2026-10-01' });
  const got = up.rows.map((r) => `${r.machine} ${r.date} ${r.provider} ${r.profile} ${r.total_tokens}${r.plan_type ? ' ' + r.plan_type : ''}`).sort();
  assert.deepEqual(got, [
    'Home 2026-09-25 openai .codex 1',
    'Main 2026-09-01 openai .codex 100',
    'Main 2026-09-25 openai .codex 80',
    'Main 2026-09-26 claude .claude 500',
    'Main 2026-09-27 openai .codex 70 team',
    'Main 2026-09-28 openai .codex 26',
    'Main 2026-09-29 openai .codex 9',
  ]);
  assert.deepEqual([up.replaced, up.added, up.unchanged, up.kept, up.keptTokens], [2, 1, 1, 1, 300]);
  // A full-history window (seed) protects old days the same way.
  assert.equal(H.upsert(existing, [], { machine: 'Main' }).rows.length, existing.length);
});

test('window: last success minus 2 days or 10 days back, whichever is earlier', () => {
  assert.equal(H.windowFrom({ lastSuccess: '2026-10-01T05:00:00Z' }, '2026-10-01'), '2026-09-21');
  assert.equal(H.windowFrom({ lastSuccess: '2026-09-10T05:00:00Z' }, '2026-10-01'), '2026-09-08'); // Main was away: backfill
  assert.equal(H.windowFrom({}, '2026-10-01'), null); // never scanned: everything
});

test('finalise recomputes plan and API value from plans.json and the rates', async () => {
  const { rules } = await L.readPlansDoc(path.join(__dirname, 'fixtures', 'ledger', 'plans.json'));
  const rows = H.finalise([
    row({ date: '2026-07-01', plan_type: 'team', plan: 'stale', input: 1e6, total_tokens: 0, api_value_usd: 99 }),
    row({ date: '2026-07-01', plan_type: '', input: 1e6, total_tokens: 0 }),
    row({ date: '2026-03-01', provider: 'claude', profile: 'Claude Desktop', model: 'claude-opus-4-6', input: 1e6 }),
  ], { rules, rates: L.createRates() });
  assert.deepEqual(rows.map((r) => [r.date, r.plan, r.api_value_usd, r.total_tokens]), [
    ['2026-03-01', 'claude-pro-gmail', 5, 1e6],
    ['2026-07-01', 'chatgpt-plus', 5, 1e6],
    ['2026-07-01', 'chatgpt-business', 5, 1e6],
  ]);
});

test('payments from the Sol files: mapped, deduped by reference, existing text kept', () => {
  assert.equal(H.isoDate('July 27, 2026'), '2026-07-27');
  assert.equal(H.isoDate('2026-04-09'), '2026-04-09');
  const sol = path.join(__dirname, 'fixtures', 'ledger');
  const { rows, warnings } = H.solPayments(JSON.parse(fs.readFileSync(path.join(sol, 'payments.json'))), JSON.parse(fs.readFileSync(path.join(sol, 'work-billing.json'))));
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 18);
  const sum = (f) => rows.filter(f).reduce((s, r) => s + r.amount, 0);
  assert.equal(sum((r) => r.currency === 'GBP' && r.status === 'paid'), 244); // synthetic paid total
  assert.equal(sum((r) => r.currency === 'USD'), 12);
  assert.equal(rows.find((r) => r.reference === 'fixture-unverified').status, 'unverified');
  assert.ok(rows.every((r) => L.normalisePayment(r)), 'every seeded payment validates');
  assert.ok(!rows.some((r) => /@/.test(r.account + r.note)), 'no email addresses');
  const first = H.appendPayments('', rows.slice(0, 2));
  const handEdited = first.text + '2026-10-01,,openai,Manual,you,GBP,1,invoice,paid,hand-1,"typed by, hand"\n';
  const again = H.appendPayments(handEdited, rows);
  assert.equal(again.added, 16);
  assert.ok(again.text.startsWith(handEdited));
  assert.equal(H.appendPayments(again.text, rows).added, 0);
});

test('lock: a second run while one holds the lock is refused', async (t) => {
  const dir = await tempDir(t, 'lock');
  const lock = path.join(dir, '.lock');
  let inner;
  await H.withLock(lock, async () => {
    inner = await H.withLock(lock, async () => 'ran').catch((e) => e.code);
  });
  assert.equal(inner, 'LOCKED');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(await H.withLock(lock, async () => 'ok'), 'ok');
});

test('collector: --since skips old files and events, records plan_type, dedupes mirrored profiles', needsPython, async (t) => {
  const home = await tempDir(t, 'home');
  const write = (rel, rows, mtime) => {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, jsonl(rows));
    if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const tc = (timestamp, input, plan) => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } }, rate_limits: { plan_type: plan } } });
  const session = [{ timestamp: '2026-09-29T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    tc('2026-09-19T10:00:00Z', 100, 'team'), tc('2026-09-29T10:00:00Z', 150, 'self_serve_business_prolite')];
  write('.codex/sessions/2026/09/29/a.jsonl', session);
  write('.codex_p/sessions/2026/09/29/a.jsonl', session); // a mirror, like Main's .codex_p
  write('.codex/sessions/2026/09/01/old.jsonl', [tc('2026-09-01T10:00:00Z', 999, 'plus')], Date.parse('2026-09-01T12:00:00Z'));
  write('.claude/projects/p/s.jsonl', [{ type: 'assistant', timestamp: '2026-09-29T11:00:00Z', sessionId: 's', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: null } } }]);
  const { data } = await H.runCollector({ collector: COLLECTOR, home, since: '2026-09-21' });
  assert.equal(data.skipped_files, 1);
  const codex = data.events.filter((e) => e.provider === 'Codex');
  assert.deepEqual(codex.map((e) => [e.profile, e.timestamp.slice(0, 10), e.tokens, e.plan_type]), [['.codex', '2026-09-29', [50, 0, 0, 0], 'self_serve_business_prolite']]);
  const claude = data.events.find((e) => e.provider === 'Claude Code');
  assert.deepEqual(claude.tokens, [3, 0, 0, 4]); // a null count reads as 0
  assert.equal(JSON.stringify(data).includes('"content"'), false);
  const full = await H.runCollector({ collector: COLLECTOR, home });
  assert.equal(full.data.events.filter((e) => e.provider === 'Codex').length, 3);
});

test('scan end to end on this Mac with a fixture home: state, window and CSV', needsPython, async (t) => {
  const dir = await tempDir(t, 'scan');
  const home = path.join(dir, 'home');
  const hist = path.join(dir, 'history');
  const today = L.londonDay(Date.now());
  const at = (daysBack) => new Date(Date.parse(today + 'T12:00:00Z') - daysBack * 86400000).toISOString();
  const f = path.join(home, '.claude', 'projects', 'p', 's.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, jsonl([1, 2].map((d) => ({ type: 'assistant', timestamp: at(d), sessionId: 's', message: { id: `m${d}`, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 10 } } }))));
  const machine = L.shortMachine(os.hostname());
  const old = row({ date: L.addDays(today, -35), machine, provider: 'claude', profile: '.claude', model: 'claude-opus-5-5', total_tokens: 777, input: 777 });
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, 'daily-usage.csv'), L.toCsv(L.DAILY_COLUMNS, [old]));
  const o = H.parseArgs(['--dir', hist, '--home', home, '--machines', machine, '--plans', path.join(__dirname, 'fixtures', 'ledger', 'plans.json'), '--rates', path.join(dir, 'none.json')]);
  const out = await H.scan(o);
  assert.deepEqual(out.errors, []);
  assert.equal(out.machines[machine].window.from, null); // no state yet: full history
  const csv = await L.readDailyCsv(path.join(hist, 'daily-usage.csv'));
  assert.equal(csv.rows.length, 3);
  assert.equal(csv.rows[0].total_tokens, 777); // the 35-day-old row was not in the logs and stays
  assert.ok(csv.rows.every((r) => r.plan === 'claude-team'));
  const state = JSON.parse(fs.readFileSync(path.join(hist, 'state.json'), 'utf8'));
  assert.equal(state.machines[machine].coveredThrough, L.addDays(today, -1));
  assert.equal(state.lastRun.ok, true);
  const second = await H.scan(o);
  assert.equal(second.machines[machine].window.from, L.addDays(today, -10));
  assert.equal((await L.readDailyCsv(path.join(hist, 'daily-usage.csv'))).rows.length, 3);
});
