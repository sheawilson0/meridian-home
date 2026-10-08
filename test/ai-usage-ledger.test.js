'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const L = require('../ai-usage-ledger');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);
const ts = (day, hour = 12) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const PLANS_FILE = path.join(__dirname, 'fixtures', 'ledger', 'plans.json');

async function tempDir(t, name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `meridian-ai-usage-${name}-`));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const fakeFx = { get: async () => ({ USDGBP: 0.75, date: '2026-10-01', source: 'test', fetchedAt: null, stale: false }) };
const fakeRunner = () => {
  const calls = [];
  return { calls, run: (args = []) => { calls.push(args); return true; }, start: () => true, running: false, startedAt: null, last: null };
};

test('rate candidates follow the Swift lookup order', () => {
  assert.deepEqual(L.rateCandidates('claude-haiku-4-5-20251001'),
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-haiku-4', 'claude-haiku', 'claude']);
  assert.deepEqual(L.rateCandidates('gpt-5.6-sol'), ['gpt-5.6-sol', 'gpt-5.6', 'gpt']);
  assert.deepEqual(L.rateCandidates('o3'), ['o3']);
});

test('rate lookup prefers the table per candidate, then built-ins, then the provider default', () => {
  const rates = L.createRates({ document: {
    'claude-opus-5': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 },
    'gpt-5.6': { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6 },
    'broken': { input_cost_per_token: 'x', output_cost_per_token: 1 },
  } });
  assert.deepEqual([rates.lookup('claude-opus-5-5').key, rates.lookup('claude-opus-5-5').from], ['claude-opus-5', 'table']);
  assert.deepEqual([rates.lookup('gpt-5.6-sol-high').key, rates.lookup('gpt-5.6-sol-high').from], ['gpt-5.6-sol', 'built-in']);
  assert.equal(rates.lookup('gpt-5.6').rate.input, 4e-6);
  near(rates.lookup('gpt-5.6').rate.cacheRead, 4e-7);
  near(rates.lookup('gpt-5.6').rate.cacheWrite, 5e-6);
  assert.deepEqual([rates.lookup('gpt-9-nova').key, rates.lookup('gpt-9-nova').from], ['gpt-5.6', 'default']);
  assert.equal(rates.lookup('gpt-9-nova').rate.output, 30e-6); // built-in gpt-5.6, not the table's
  assert.deepEqual([rates.lookup('claude-zephyr-9').key, rates.lookup('claude-zephyr-9').from], ['claude-opus-5', 'default']);
  assert.equal(rates.lookup('broken').from, 'default');
  assert.equal(rates.lookupFor(null, 'openai').key, 'gpt-5.6');
  assert.equal(rates.lookupFor('unknown', 'claude').key, 'claude-opus-5');
});

test('cost maths matches the Swift formula', () => {
  const rates = L.createRates();
  const t = { input: 1000, output: 2000, cacheRead: 1_000_000, cacheWrite: 10_000 };
  near(rates.cost('claude-opus-5-5', t), 1000 * 5e-6 + 2000 * 25e-6 + 1_000_000 * 0.5e-6 + 10_000 * 6.25e-6);
  near(rates.cost('claude-opus-5-5', t), 0.6175);
  near(rates.cost('gpt-5.5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), 5 + 30 + 0.5);
  near(rates.cost(null, { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude'), 5);
});

test('friendly model labels and machine names', () => {
  const cases = {
    'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-1': 'Fable 5.1', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5': 'Opus 5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5', 'claude-3-5-sonnet-20241022': 'Sonnet 3.5', 'claude': 'Claude',
    'gpt-6-sol': 'GPT-6 Sol', 'gpt-5.6': 'GPT-5.6', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-5.1-codex-max': 'GPT-5.1 Codex Max', 'o3-mini': 'o3 Mini',
  };
  for (const [id, label] of Object.entries(cases)) assert.equal(L.modelLabel(id), label, id);
  assert.equal(L.codexPlanName('self_serve_business_prolite'), 'Business Pro Lite');
  assert.equal(L.shortMachine('Owner’s MacBook Pro Main'), 'Main');
  assert.equal(L.shortMachine('Example-MacBook-Pro-Home.local'), 'Home');
  assert.ok(L.sameMachine('Example-MacBook-Pro-Main.local', 'Main'));
});

test('London days, including across BST midnight', () => {
  assert.equal(L.londonDay(Date.parse('2026-09-30T23:30:00Z')), '2026-10-01'); // 00:30 BST
  assert.equal(L.londonDay(Date.parse('2026-12-31T23:30:00Z')), '2026-12-31'); // GMT
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
});

test('CSV round trip keeps commas, quotes and newlines', () => {
  const rows = [{ a: 'plain', b: 'with, comma', c: 'say "hi"' }, { a: '', b: 'line\nbreak', c: '£15 + £3' }];
  const text = L.toCsv(['a', 'b', 'c'], rows);
  const back = L.parseCsv(text);
  assert.deepEqual(back.header, ['a', 'b', 'c']);
  assert.deepEqual(back.rows, rows);
  assert.deepEqual(L.parseCsv('x,y\r\n1,2\r\n').rows, [{ x: '1', y: '2' }]);
});

test('Claude transcripts: most complete copy per message id, skip synthetic and empty usage', async (t) => {
  const dir = await tempDir(t, 'claude');
  const file = path.join(dir, 's.jsonl');
  const msg = (id, model, usage, day = '2026-09-30') => ({ type: 'assistant', timestamp: ts(day), message: { id, model, usage } });
  const u = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 };
  fs.writeFileSync(file, jsonl([
    { type: 'user', entrypoint: 'cli', timestamp: ts('2026-09-30'), message: { content: 'hi' } },
    msg('a', 'claude-opus-5-5', { ...u, output_tokens: 1 }), // first streamed copy
    msg('a', 'claude-opus-5-5', u), // the complete one wins
    msg('a', 'claude-opus-5-5', { ...u, output_tokens: 2 }),
    msg('b', '<synthetic>', u),
    msg('c', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 0 }),
    msg('d', 'claude-fable-5-1', { ...u, output_tokens: 7.5 }),
    { type: 'assistant', timestamp: ts('2026-10-01'), message: { usage: u } },
    '{"type":"assistant", broken',
  ]));
  const days = await L.parseClaudeFile(file, { size: fs.statSync(file).size });
  assert.deepEqual(days['2026-09-30'].sort(), [
    ['claude-fable-5-1', null, 10, 100, 20, 0],
    ['claude-opus-5-5', null, 10, 100, 20, 5],
  ]);
  assert.deepEqual(days['2026-10-01'], [['claude', null, 10, 100, 20, 5]]);
});

test('Codex sessions: cumulative deltas, resets, turn model and per-event plan_type', async (t) => {
  const dir = await tempDir(t, 'codex');
  const file = path.join(dir, 'rollout.jsonl');
  const tc = (input, cached, output, plan, day = '2026-09-30') => ({ timestamp: ts(day), type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } },
    rate_limits: plan ? { plan_type: plan } : null } });
  fs.writeFileSync(file, jsonl([
    { timestamp: ts('2026-09-30'), type: 'session_meta', payload: { originator: 'codex_exec' } },
    tc(100, 40, 10, null),
    { timestamp: ts('2026-09-30'), type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    tc(300, 140, 30, 'plus'),
    tc(300, 140, 30, 'plus'),
    tc(50, 0, 5, 'self_serve_business_prolite', '2026-10-01'),
  ]));
  const days = await L.parseCodexFile(file, { size: fs.statSync(file).size });
  assert.deepEqual(days['2026-09-30'].sort(), [
    ['gpt-5.6', 'plus', 60, 40, 0, 10],
    ['gpt-6-sol', 'plus', 100, 100, 0, 20],
  ]);
  assert.deepEqual(days['2026-10-01'], [['gpt-6-sol', 'self_serve_business_prolite', 50, 0, 0, 5]]);
});

test('other Macs: provider-split cost, tokens split by cost and flagged approx', () => {
  const { rows, unattributed } = L.reportRows({
    '2026-09-29': { claude: 30, codex: 10, tokens: 1000 },
    '2026-09-30': { claude: 0, codex: 5, tokens: 400 },
    '2026-10-01': { claude: 0, codex: 0, tokens: 77 },
    'junk': { claude: 1 },
  }, { machine: 'Main', source: 'report:Main' });
  assert.deepEqual(rows.map((r) => [r.date, r.provider, r.cost, r.tokens.total, r.approx, r.profile]), [
    ['2026-09-29', 'claude', 30, 750, true, null],
    ['2026-09-29', 'openai', 10, 250, true, null],
    ['2026-09-30', 'openai', 5, 400, false, null],
  ]);
  assert.equal(unattributed, 77);
});

test('plans file: the five plans and rules validate', async () => {
  const doc = await L.readPlansDoc(PLANS_FILE);
  assert.equal(doc.error, null);
  assert.deepEqual(doc.plans.map((p) => p.id).sort(), ['chatgpt-business', 'chatgpt-plus', 'claude-pro-gmail', 'claude-pro-ulster', 'claude-team']);
  for (const p of doc.plans) for (const q of p.periods) assert.equal(q.currency, 'GBP');
});

test('attribution rules: plan_type wins, then profiles, then dates', async () => {
  const { rules } = await L.readPlansDoc(PLANS_FILE);
  const plan = (provider, date, profile, planType = null) => L.resolvePlan(rules, { provider, date, profile, planType, machine: 'Main' });
  assert.equal(plan('claude', '2026-03-01', 'Claude Desktop'), 'claude-pro-gmail');
  assert.equal(plan('claude', '2026-07-05', '.claude-work'), 'claude-team');
  assert.equal(plan('claude', '2026-08-30', '.claude_work_home'), 'claude-team');
  assert.equal(plan('claude', '2026-08-24', '.claude'), 'claude-pro-gmail');
  assert.equal(plan('claude', '2026-08-25', '.claude'), 'claude-team');
  assert.equal(plan('claude', '2026-10-01', null), 'claude-team'); // menu bar report rows have no profile
  assert.equal(plan('openai', '2026-08-06', '.codex'), 'chatgpt-plus');
  assert.equal(plan('openai', '2026-08-07', '.codex'), 'chatgpt-business');
  assert.equal(plan('openai', '2026-06-10', '.codex', 'team'), 'chatgpt-business'); // the event's plan_type beats the date
  assert.equal(plan('openai', '2026-09-01', '.codex', 'plus'), 'chatgpt-plus');
  assert.equal(plan('openai', '2026-04-07', '.codex', 'free'), null);
  assert.equal(plan('openai', '2026-09-20', '.codex', 'enterprise'), 'chatgpt-business'); // unmapped plan_type: dates decide
});

test('plans validation for PUT', () => {
  const plan = { id: 'claude-x', provider: 'claude', name: ' Claude X ', account: 'Org', payer: 'you', status: 'active',
    periods: [{ from: '2026-01-01', to: null, amount: 18, currency: 'GBP', per: 'month', label: 'Pro' }], note: 'n', evidence: ['e'], confirmed: true, source: 'plans.json', seen: null };
  const rule = { provider: 'claude', from: '2026-01-01', plan: 'claude-x' };
  const ok = L.validatePlansDoc({ plans: [plan], rules: [rule] });
  assert.equal(ok.plans[0].name, 'Claude X');
  assert.equal(ok.plans[0].source, undefined);
  assert.deepEqual(ok.rules, [rule]);
  // A bare array keeps the existing rules.
  assert.deepEqual(L.validatePlansDoc([plan], { existingRules: [rule] }).rules, [rule]);
  const bad = (body, re) => assert.throws(() => L.validatePlansDoc(body), re);
  bad({}, /body must be/);
  bad({ plans: [plan, plan] }, /duplicate id/);
  bad({ plans: [{ ...plan, payer: 'boss' }] }, /payer/);
  bad({ plans: [{ ...plan, price: { amount: 1 } }] }, /price: replaced by periods/);
  bad({ plans: [{ ...plan, periods: [{ from: '2026-02-01', to: '2026-01-01', currency: 'GBP', per: 'month' }] }] }, /periods\[0\]\.to/);
  bad({ plans: [{ ...plan, periods: [{ from: '2026-02-01', currency: 'gbp', per: 'week' }] }] }, /currency[\s\S]*per/);
  bad({ plans: [plan], rules: [{ provider: 'claude', plan: 'nope' }] }, /rules\[0\]\.plan/);
  bad({ plans: [plan], rules: [{ provider: 'claude', profiles: [] , plan: null }] }, /profiles/);
  bad({ plans: [plan], rules: [{ provider: 'claude' }] }, /plan: is required/);
  bad({ plans: [{ ...plan, token: 'sk-x' }] }, /token: unknown key/);
});

test('merge precedence: imports replace lower rows per date, provider and machine', () => {
  const row = (source, date, provider, machine, cost) => ({ source, date, provider, machine, cost });
  const live = [
    row('history', '2026-09-29', 'claude', 'Home', 1),
    row('history', '2026-09-29', 'openai', 'Home', 2),
    row('report:Main', '2026-09-29', 'claude', 'Main', 3),
    row('report:Main', '2026-09-29', 'openai', 'Main', 4),
    row('history', '2026-09-30', 'claude', 'Home', 5),
  ];
  const a = [
    row('import:a', '2026-09-29', 'claude', 'Main', 30),
    row('import:a', '2026-09-29', 'openai', null, 40),
    row('import:a', '2026-09-30', 'claude', 'Web', 50),
  ];
  const b = [row('import:b', '2026-09-29', 'claude', 'owner’s macbook pro main', 300)];
  const { rows, dropped } = L.mergeLayers([live, a, b]);
  assert.deepEqual(rows.map((r) => `${r.source} ${r.date} ${r.provider} ${r.machine}`).sort(), [
    'history 2026-09-29 claude Home',
    'history 2026-09-30 claude Home',
    'import:a 2026-09-29 openai null',
    'import:a 2026-09-30 claude Web',
    'import:b 2026-09-29 claude owner’s macbook pro main',
  ]);
  assert.equal(dropped.get('history'), 1);
  assert.equal(dropped.get('report:Main'), 2);
  assert.equal(dropped.get('import:a'), 1);
});

test('live rows take over only after each machine’s covered day', () => {
  const h = (machine, date, provider, profile) => ({ machine, date, provider, profile, source: 'history' });
  const history = [
    h('Home', '2026-09-30', 'claude', '.claude'), h('Home', '2026-10-01', 'claude', '.claude'), h('Home', '2026-10-01', 'claude', 'Claude Desktop'),
    h('Main', '2026-09-30', 'openai', '.codex'), h('Main', '2026-10-01', 'openai', '.codex'), h('Main', '2026-10-01', 'openai', '.codex_p'),
    h('Main', '2026-10-01', 'claude', '.claude'),
  ];
  const live = [
    { ...h('Home', '2026-09-30', 'claude', '.claude'), source: 'local' }, // covered: ignored
    { ...h('Home', '2026-10-01', 'claude', '.claude'), source: 'local' },
    { ...h('Main', '2026-10-01', 'openai', null), source: 'report:Main' }, // no profile: replaces every profile
  ];
  const out = L.overlayLive(history, live, { home: '2026-09-30', main: '2026-09-30' });
  const got = out.rows.map((r) => `${r.source} ${r.machine} ${r.date} ${r.provider} ${r.profile}`).sort();
  assert.deepEqual(got, [
    'history Home 2026-09-30 claude .claude',
    'history Home 2026-10-01 claude Claude Desktop', // the live scan never reads Claude Desktop
    'history Main 2026-09-30 openai .codex',
    'history Main 2026-10-01 claude .claude', // no live Claude row for Main that day: the CSV stays
    'local Home 2026-10-01 claude .claude',
    'report:Main Main 2026-10-01 openai null',
  ]);
  assert.equal(out.replaced, 3);
});

test('the example in docs/open-source/ai-usage-import.md is valid', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'open-source', 'ai-usage-import.md'), 'utf8');
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(doc)[1]);
  const rates = L.createRates();
  const result = L.validateImport(example, { rates, today: '2026-10-01' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 2);
  const priced = result.rows.find((r) => r.machine === 'Web');
  near(priced.cost, rates.cost('gpt-6-sol', priced.tokens, 'openai'));
  assert.equal(priced.profile, 'ChatGPT web');
  assert.equal(result.rows.find((r) => r.machine === 'Phone').cost, 2.1);
});

test('import validator rejects bad files and explains why', () => {
  const ok = { schema: L.IMPORT_SCHEMA, rows: [] };
  const errs = (doc) => L.validateImport(doc, { today: '2026-10-01' }).errors.join('\n');
  assert.equal(L.validateImport(ok).ok, true);
  assert.match(errs([]), /must be a JSON object/);
  assert.match(errs({ ...ok, schema: 'v2' }), /schema/);
  assert.match(errs({ ...ok, extra: 1 }), /extra: unknown top-level key/);
  assert.match(errs({ ...ok, plans: [] }), /plans\.json/);
  assert.match(errs({ ...ok, rows: {} }), /rows: must be an array/);
  const row = { date: '2026-09-30', provider: 'claude', cost: 1 };
  assert.equal(L.validateImport({ ...ok, rows: [row] }, { today: '2026-10-01' }).ok, true);
  assert.match(errs({ ...ok, rows: [{ ...row, date: '2026-02-30' }] }), /rows\[0\]\.date/);
  assert.match(errs({ ...ok, rows: [{ ...row, date: '2026-10-05' }] }), /future/);
  assert.match(errs({ ...ok, rows: [{ ...row, provider: 'chatgpt' }] }), /provider/);
  assert.match(errs({ ...ok, rows: [{ ...row, cost: -1 }] }), /cost/);
  assert.match(errs({ ...ok, rows: [{ ...row, colour: 'red' }] }), /colour: unknown key/);
  assert.match(errs({ ...ok, rows: [{ ...row, tokens: { input: -5 } }] }), /tokens\.input/);
  assert.match(errs({ ...ok, rows: [{ ...row, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 5 } }] }), /tokens\.total/);
  assert.match(errs({ ...ok, rows: [{ date: '2026-09-30', provider: 'claude', tokens: { total: 5 } }] }), /cannot be priced/);
  assert.match(errs({ ...ok, rows: [{ date: '2026-09-30', provider: 'claude' }] }), /needs a cost, tokens/);
  const mixed = L.validateImport({ ...ok, rows: [row, { ...row, provider: 'x' }] }, { today: '2026-10-01' });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.rows, []);
});

test('import rows with the same key add together, machines are shortened', () => {
  const r = L.validateImport({ schema: L.IMPORT_SCHEMA, rows: [
    { date: '2026-09-30', provider: 'openai', model: 'gpt-6-sol', machine: 'Owner’s MacBook Pro Main', tokens: { input: 10 }, cost: 1, sessions: 1 },
    { date: '2026-09-30', provider: 'openai', model: 'gpt-6-sol', machine: 'Main', tokens: { input: 5, output: 2 }, cost: 0.5 },
  ] }, { today: '2026-10-01' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].machine, 'Main');
  assert.deepEqual(r.rows[0].tokens, { input: 15, output: 2, cacheRead: null, cacheWrite: null, total: 17 });
  assert.equal(r.rows[0].cost, 1.5);
});

test('payments: validated, deduped by reference, sorted', async (t) => {
  const dir = await tempDir(t, 'payments');
  const file = path.join(dir, 'payments.csv');
  const row = (date, reference, extra = {}) => ({ date, plan: 'chatgpt-plus', provider: 'openai', account: 'Personal', payer: 'you', currency: 'GBP', amount: 20, kind: 'subscription', status: 'paid', reference, note: 'a, "b"', ...extra });
  fs.writeFileSync(file, L.toCsv(L.PAYMENT_COLUMNS, [row('2026-06-09', 'r2'), row('2026-05-09', 'r1'), row('2026-07-09', 'r1'), row('2026-08-09', 'r3', { kind: 'gift' }), row('2026-09-09', 'r4', { payer: '', plan: '' })]));
  const out = await L.readPaymentsCsv(file);
  assert.deepEqual(out.payments.map((p) => p.reference), ['r1', 'r2', 'r4']);
  assert.equal(out.duplicates, 1);
  assert.equal(out.invalid, 1);
  assert.equal(out.payments[0].note, 'a, "b"');
  assert.equal(out.payments[2].payer, null);
  assert.equal(out.payments[2].plan, null);
});

test('FX: fetched once a day, cached on disk, last good value then 0.76', async (t) => {
  const dir = await tempDir(t, 'fx');
  const file = path.join(dir, 'fx.json');
  let clock = Date.parse('2026-10-01T09:00:00Z');
  let calls = 0;
  let fail = false;
  const fetchRate = async () => { calls++; if (fail) throw new Error('offline'); return { USDGBP: 0.75565, date: '2026-10-01' }; };
  const fx = L.createFx({ file, now: () => clock, fetchRate });
  assert.equal((await fx.get()).USDGBP, 0.75565);
  await fx.get();
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).USDGBP, 0.75565);
  clock += 24 * 3600 * 1000; fail = true;
  const stale = await L.createFx({ file, now: () => clock, fetchRate }).get();
  assert.deepEqual([stale.USDGBP, stale.stale], [0.75565, true]);
  const none = await L.createFx({ file: path.join(dir, 'missing.json'), now: () => clock, fetchRate }).get();
  assert.deepEqual([none.USDGBP, none.source], [0.76, 'fallback']);
});

test('history runner: one child at a time, a rewrite queues behind a run', async (t) => {
  const dir = await tempDir(t, 'runner');
  const script = path.join(dir, 'job.js');
  const log = path.join(dir, 'log.txt');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(log)}, (process.argv[2] || 'scan') + '\\n'); setTimeout(() => {}, 150);`);
  let done = 0;
  const finished = new Promise((resolve) => {
    const runner = L.createHistoryRunner({ root: dir, script, onDone: () => { if (++done === 2) resolve(runner); } });
    assert.equal(runner.run(), true);
    assert.equal(runner.running, true);
    assert.equal(runner.run(), false); // already running: not stacked
    assert.equal(runner.run(['--rewrite']), false); // queued
  });
  const runner = await finished;
  assert.equal(runner.running, false);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['scan', '--rewrite']);
  assert.equal(runner.last.code, 0);
});

test('end to end: history CSV, live overlay, report, import, plans, payments and HTTP routes', async (t) => {
  const dir = await tempDir(t, 'e2e');
  const home = path.join(dir, 'home');
  const dataDir = path.join(dir, 'data', 'ai-usage');
  const hist = path.join(dataDir, 'history');
  const claudeDir = path.join(home, '.claude', 'projects', 'p');
  for (const d of [claudeDir, hist, path.join(dataDir, 'plans'), path.join(dataDir, 'import')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(PLANS_FILE, path.join(dataDir, 'plans', 'plans.json'));
  const u = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 };
  fs.writeFileSync(path.join(claudeDir, 'a.jsonl'), jsonl([
    { type: 'assistant', timestamp: ts('2026-09-29'), message: { id: 'm1', model: 'claude-opus-5-5', usage: u } }, // covered by the CSV: ignored
    { type: 'assistant', timestamp: ts('2026-10-01'), message: { id: 'm2', model: 'claude-opus-5-5', usage: u } },
  ]));
  const csvRow = (date, machine, provider, profile, model, planType, tokens) => ({ date, machine, provider, profile, model, plan_type: planType, plan: 'stale',
    input: tokens, cache_read: 0, cache_write: 0, output: 0, total_tokens: tokens, events: 1, sessions: 1, api_value_usd: 999 });
  fs.writeFileSync(path.join(hist, 'daily-usage.csv'), L.toCsv(L.DAILY_COLUMNS, [
    csvRow('2026-03-01', 'Main', 'claude', 'Claude Desktop', 'claude-opus-4-6', '', 1000000),
    csvRow('2026-09-29', 'Home', 'claude', '.claude', 'claude-opus-5-5', '', 2000000),
    csvRow('2026-09-29', 'Main', 'openai', '.codex', 'gpt-6-sol', 'team', 3000000),
    csvRow('2026-09-30', 'Main', 'claude', '.claude', 'claude-opus-5-5', '', 1000000),
    csvRow('2026-10-01', 'Home', 'claude', '.claude', 'claude-opus-5-5', '', 5), // partial today: the live scan wins
  ]));
  fs.writeFileSync(path.join(hist, 'state.json'), JSON.stringify({ version: 1, lastRun: { mode: 'scan', ok: true },
    machines: { Home: { lastSuccess: '2026-10-01T05:00:00Z', coveredThrough: '2026-09-30' }, Main: { lastSuccess: '2026-10-01T05:00:00Z', coveredThrough: '2026-09-30', error: null } } }));
  fs.writeFileSync(path.join(hist, 'payments.csv'), L.toCsv(L.PAYMENT_COLUMNS, [
    { date: '2026-09-09', plan: 'chatgpt-plus', provider: 'openai', account: 'Personal', payer: 'you', currency: 'GBP', amount: 20, kind: 'subscription', status: 'paid', reference: 'p1', note: '' }]));
  const report = (name, host, days) => JSON.stringify({ name, host, version: '1.1.4', updatedAt: 1790892391, days });
  fs.writeFileSync(path.join(dataDir, 'Test-Home.json'), report('Test’s MacBook Pro Home', 'Test-Home', { '2026-10-01': { claude: 999, codex: 0, tokens: 1 } }));
  fs.writeFileSync(path.join(dataDir, 'Test-Main.json'), report('Test’s MacBook Pro Main', 'Test-Main', {
    '2026-09-29': { claude: 0, codex: 77, tokens: 7 }, // covered by the CSV: ignored
    '2026-10-01': { claude: 0, codex: 4, tokens: 400 } }));
  fs.writeFileSync(path.join(dataDir, 'import', '2026-10-01-a.json'), JSON.stringify({ schema: L.IMPORT_SCHEMA,
    rows: [{ date: '2026-09-30', provider: 'claude', machine: 'Main', model: 'claude-opus-5-5', tokens: { input: 1000000 } }] }));

  const runner = fakeRunner();
  // A rate table that only loads from disk: the first build must price history rows with it.
  const ratesFile = path.join(dir, 'rates.json');
  fs.writeFileSync(ratesFile, JSON.stringify({ document: { 'gpt-6-sol': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } } }));
  const opts = { root: dir, home, dataDir, hostname: 'Test-Home.local', rates: L.createRates({ file: ratesFile }), now: () => Date.parse('2026-10-01T20:00:00Z'), fx: fakeFx, runner };
  const ledger = L.createLedger(opts);
  const out = await ledger.getLedger();

  const pick = (r) => `${r.date} ${r.provider} ${r.machine} ${r.profile} ${r.model} ${r.plan} ${r.source} ${r.cost}`;
  assert.deepEqual(out.rows.map(pick), [
    '2026-03-01 claude Main Claude Desktop claude-opus-4-6 claude-pro-gmail history 5',
    '2026-09-29 claude Home .claude claude-opus-5-5 claude-team history 10',
    '2026-09-29 openai Main .codex gpt-6-sol chatgpt-business history 3',
    '2026-09-30 claude Main null claude-opus-5-5 claude-team import:2026-10-01-a.json 5',
    '2026-10-01 claude Home .claude claude-opus-5-5 claude-team local 0.0075',
    '2026-10-01 openai Main null null chatgpt-business report:Main 4',
  ]);
  const src = Object.fromEntries(out.sources.map((s) => [s.id, s]));
  assert.equal(src.history.csvRows, 5);
  assert.equal(src.history.replacedByLive, 1);
  assert.equal(src.history.superseded, 1);
  assert.equal(src['report:Home'].rows, 0);
  assert.deepEqual(out.fx, await fakeFx.get());
  assert.equal(out.payments.length, 1);
  assert.equal(out.history.machines.Main.coveredThrough, '2026-09-30');
  assert.equal(out.plans.find((p) => p.id === 'claude-team').seen.from, '2026-09-29');
  assert.equal(out.planRules.length > 0, true);
  assert.equal(out.models['claude-opus-5-5'].label, 'Opus 5.5');

  // HTTP routes.
  const server = http.createServer(async (req, res) => {
    if (!(await ledger.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'content-type': 'application/json' };
  const led = await fetch(base + '/api/ai-usage/ledger', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(led.headers.get('content-encoding'), 'gzip');
  assert.equal((await led.json()).rows.length, 6); // fetch gunzips
  const plans = await (await fetch(base + '/api/ai-usage/plans')).json();
  assert.equal(plans.plans.length, 5);
  plans.plans.find((p) => p.id === 'claude-team').confirmed = true;
  const put = await fetch(base + '/api/ai-usage/plans', { method: 'PUT', headers: json, body: JSON.stringify(plans) });
  assert.equal(put.status, 200);
  assert.deepEqual(runner.calls.at(-1), ['--rewrite']);
  const bad = await fetch(base + '/api/ai-usage/plans', { method: 'PUT', headers: json, body: JSON.stringify({ plans: [{ id: 'x' }] }) });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(base + '/api/ai-usage/plans', { method: 'PUT', headers: { ...json, origin: 'https://evil.example' }, body: '[]' })).status, 403);
  await Promise.all(Array.from({ length: 6 }, (_, i) => fetch(base + '/api/ai-usage/plans', { method: 'PUT', headers: json,
    body: JSON.stringify({ ...plans, plans: plans.plans.map((p) => (p.id === 'claude-team' ? { ...p, note: `n${i}` } : p)) }) })));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'plans', 'plans.json'), 'utf8'));
  assert.equal(saved.plans.length, 5);
  assert.match(saved.plans.find((p) => p.id === 'claude-team').note, /^n\d$/);
  const refresh = await fetch(base + '/api/ai-usage/refresh', { method: 'POST', headers: json, body: '{}' });
  assert.equal(refresh.status, 202);
  assert.deepEqual(await refresh.json(), { ok: true, running: true, started: true, startedAt: null });
  assert.equal((await fetch(base + '/api/ai-usage/refresh', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/api/ai-usage/ledger', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/ai-usage/other')).status, 404);
});

test('history timeout and stop kill the group, retaining the flight until close', () => {
  const { EventEmitter } = require('node:events');
  let time = 0, id = 0; const pending = new Map(), children = [], signals = [];
  const clock = {
    setTimeout(fn, ms) { const timer = { id: ++id, unref() {} }; pending.set(timer, { fn, at: time + ms }); return timer; },
    clearTimeout(timer) { pending.delete(timer); }, setInterval() { throw Error('not started'); }, clearInterval() {},
  };
  const advance = ms => { time += ms; for (const [timer, task] of [...pending]) if (task.at <= time) { pending.delete(timer); task.fn(); } };
  const runner = L.createHistoryRunner({ root: '/tmp', script: 'fake', timeoutMs: 100, clock, now: () => time,
    kill: (...args) => signals.push(args), spawnChild: () => {
      const child = new EventEmitter(); child.pid = 900 + children.length; child.stderr = new EventEmitter(); children.push(child); return child;
    } });
  assert.equal(runner.run(), true); runner.run(['--rewrite']); advance(100);
  assert.deepEqual(signals[0], [-900, 'SIGTERM']); assert.equal(runner.running, true); assert.equal(children.length, 1);
  advance(2000); assert.deepEqual(signals[1], [-900, 'SIGKILL']); assert.equal(runner.run(), false);
  children[0].emit('close', null, 'SIGKILL'); assert.equal(runner.last.error, 'history job budget exceeded'); assert.equal(runner.last.signal, 'SIGKILL');
  assert.equal(children.length, 2); assert.equal(runner.running, true);
  runner.run(['--rewrite']); runner.stop(); advance(2000); children[1].emit('close', null, 'SIGKILL');
  assert.equal(children.length, 2); assert.equal(runner.running, false); assert.equal(pending.size, 0);
});
