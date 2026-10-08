'use strict';

// The Money tab: the maths (money-core.js), reading the Monzo sheet and
// Trading 212 (money.js), and the lock in front of it all.

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const C = require('../public/money-core');
const { createMoney, monzoRows, sheetDate, sheetTime, t212Positions, t212Orders, t212Account, cleanAccounts } = require('../money');

const RULES = { salary: ['Acme Ltd'], internal: ['Me Elsewhere'], invest: ['Index Broker'], categories: { 'Big Landlord': 'Rent' } };
const tx = (date, name, amount, category = 'General', type = 'Card payment') => ({ id: date + name + amount, date, time: '12:00', type, name, category, amount });
const SAMPLE = [
  tx('2026-08-28', 'Acme Ltd', 1800, 'Income', 'Faster payment'),
  tx('2026-08-29', 'Tesco', -40, 'Groceries'),
  tx('2026-09-01', 'Big Landlord', -700, 'General', 'Faster payment'),
  tx('2026-09-02', 'Rainy Pot', -5, 'Savings', 'Pot transfer'),
  tx('2026-09-03', 'Me Elsewhere', 500, 'Transfers', 'Faster payment'),
  tx('2026-09-04', 'Index Broker', -200, 'Savings', 'Faster payment'),
  tx('2026-09-05', 'Tesco', 10, 'Groceries'), // a refund
  tx('2026-09-10', 'Acme Ltd', 60, 'Income', 'Faster payment'), // expenses back, not a payday
  tx('2026-09-28', 'Acme Ltd', 1800, 'Income', 'Faster payment'),
  tx('2026-09-30', 'Tesco', -30, 'Groceries'),
  tx('2026-10-02', 'Streamly', -9.99, 'Entertainment'),
];

test('every payment gets the right kind and category', () => {
  const P = C.prepare(SAMPLE, RULES);
  const k = (name) => P.find((t) => t.name === name).kind;
  assert.equal(k('Acme Ltd'), 'income'); assert.equal(k('Rainy Pot'), 'pot'); assert.equal(k('Me Elsewhere'), 'internal'); assert.equal(k('Index Broker'), 'invest'); assert.equal(k('Tesco'), 'spend');
  assert.equal(P.find((t) => t.name === 'Big Landlord').cat, 'Rent');
});

test('paydays skip small salary-name payments and ones too close together', () => {
  assert.deepEqual(C.paydays(C.prepare(SAMPLE, RULES)), ['2026-08-28', '2026-09-28']);
});

test('a period sums in, out, refunds, pots and investing separately', () => {
  const P = C.prepare(SAMPLE, RULES);
  const s = C.summarize(P, { from: '2026-08-28', to: '2026-09-27' });
  assert.equal(s.earned, 1860); assert.equal(s.salary, 1800); assert.equal(s.otherIn, 60);
  assert.equal(s.spent, 730); assert.equal(s.refunds, 10); assert.equal(s.lumps, 700); assert.equal(s.steady, 30);
  assert.equal(s.saved, 5); assert.equal(s.invested, 200); assert.equal(s.internal, 500); assert.equal(s.left, 1130);
  assert.deepEqual(s.categories.map((c) => [c.name, c.spent]), [['Rent', 700], ['Groceries', 30]]);
});

test('"since payday" starts on the last payday and compares with the same point before', () => {
  const P = C.prepare(SAMPLE, RULES);
  const sp = C.periodSpan('payday', P, '2026-10-03');
  assert.equal(sp.from, '2026-09-28'); assert.equal(sp.to, '2026-10-03');
  assert.deepEqual(sp.prev, { from: '2026-08-28', to: '2026-09-02' });
  const m = C.periodSpan('month', P, '2026-10-03'); assert.equal(m.from, '2026-10-01'); assert.equal(m.end, '2026-10-31'); assert.deepEqual(m.prev, { from: '2026-09-01', to: '2026-09-03' });
  const l = C.periodSpan('last', P, '2026-01-15'); assert.equal(l.from, '2025-12-01'); assert.equal(l.to, '2025-12-31');
  assert.equal(C.periodSpan('payday', [], '2026-10-03').id, 'month', 'no salary rule: falls back to the month');
});

test('regular payments: steady amounts on a steady gap, and lapsed ones flagged', () => {
  const list = [];
  for (const m of ['05', '06', '07', '08', '09']) list.push(tx(`2026-${m}-08`, 'Streamly', -9.99, 'Entertainment'));
  for (const m of ['03', '04', '05']) list.push(tx(`2026-${m}-14`, 'Old Thing', -5, 'Bills'));
  for (const d of ['2026-09-01', '2026-09-09', '2026-09-12', '2026-09-20']) list.push(tx(d, 'Tesco', -(10 + Number(d.slice(8))), 'Groceries'));
  const rec = C.recurring(C.prepare(list, {}), '2026-10-03');
  const s = rec.find((x) => x.name === 'Streamly');
  assert.equal(s.every, 'month'); assert.equal(s.amount, 9.99); assert.equal(s.next, '2026-10-08'); assert.equal(s.lapsed, false);
  assert.equal(rec.find((x) => x.name === 'Old Thing').lapsed, true);
  assert.ok(!rec.some((x) => x.name === 'Tesco'), 'shopping that varies is not a subscription');
});

test('insights spread steady spending but count one-off lumps once', () => {
  const P = C.prepare(SAMPLE, RULES); const sp = C.periodSpan('payday', P, '2026-10-03');
  const tips = C.insights(P, sp, C.summarize(P, sp), C.summarize(P, sp.prev), { prevSpan: sp.prev, fmt: (v) => '£' + Math.round(v) });
  assert.ok(tips.some((t) => t.k === 'pace'));
  assert.ok(!tips.some((t) => /&lt;|<script/.test(t.text)));
});

test('the Monzo sheet: serial dates, times, local currency and notes', () => {
  assert.equal(sheetDate(46297), '2026-10-02'); assert.equal(sheetDate('02/10/2026'), '2026-10-02'); assert.equal(sheetTime(0.5941550925925926), '14:16');
  const rows = monzoRows([
    ['Transaction ID', 'Date', 'Time', 'Type', 'Name', 'Emoji', 'Category', 'Amount', 'Currency', 'Local amount', 'Local currency', 'Notes and #tags', 'Address', 'Receipt', 'Description', 'Category split'],
    ['tx_1', 46297, 0.5, 'Card payment', 'Cafe', '', 'Eating out', -4.5, 'GBP', -5.2, 'EUR', '#work lunch', '', '', 'CAFE PARIS', ''],
    ['tx_2', 'not a date', 0.5, 'Card payment', 'Bad', '', 'General', -1, 'GBP', -1, 'GBP', '', '', '', '', ''],
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: 'tx_1', date: '2026-10-02', time: '12:00', type: 'Card payment', name: 'Cafe', category: 'Eating out', amount: -4.5, account: 'Monzo', currency: 'GBP', local: { amount: -5.2, currency: 'EUR' }, notes: '#work lunch', description: 'CAFE PARIS' });
});

test('Trading 212: both position formats come out in pounds', () => {
  const orders = t212Orders([{ order: { id: 1, ticker: 'ABCl_EQ', status: 'FILLED', side: 'BUY', instrument: { ticker: 'ABCl_EQ', name: 'ABC Fund' } }, fill: { quantity: 2, filledAt: '2026-09-01T10:00:00Z', walletImpact: { netValue: 100 } } }]);
  assert.deepEqual(orders.map((o) => [o.date, o.name, o.value]), [['2026-09-01', 'ABC Fund', 100]]);
  const old = t212Positions([{ ticker: 'ABCl_EQ', quantity: 2, averagePrice: 50, currentPrice: 55, ppl: 9, fxPpl: 1 }], orders);
  assert.equal(old[0].name, 'ABC Fund'); assert.equal(old[0].value, 110); assert.equal(old[0].ppl, 10);
  const now = t212Positions([{ instrument: { ticker: 'X_US_EQ', name: 'X Corp', currency: 'USD' }, quantity: 1, walletImpact: { currentValue: 80, totalCost: 75, unrealizedProfitLoss: 5, fxImpact: -1 } }]);
  assert.deepEqual([now[0].name, now[0].value, now[0].cost, now[0].ppl], ['X Corp', 80, 75, 5]);
  assert.deepEqual(t212Account({ totalValue: 1022.21, cash: { availableToTrade: 0, reservedForOrders: 0, inPies: 0.04 }, investments: { currentValue: 1022.17, totalCost: 1010.94, unrealizedProfitLoss: 11.27, realizedProfitLoss: 0 } }).value, 1022.21);
});

test('typed-in balances keep their history', () => {
  const a = cleanAccounts([{ name: 'LISA', kind: 'lisa', balance: 100, asOf: '2026-09-01' }], [], '2026-09-01');
  const b = cleanAccounts([{ ...a[0], balance: 150, asOf: '2026-10-01' }], a, '2026-10-01');
  assert.equal(b[0].id, a[0].id); assert.deepEqual(b[0].history.map((h) => h.balance), [100, 150]);
  assert.throws(() => cleanAccounts([{ name: '', balance: 1 }]));
  assert.throws(() => cleanAccounts([{ name: 'X', balance: 'lots' }]));
});

// ---------------------------------------------------------------- the lock, end to end

function fakeUpstream() {
  const calls = [];
  const request = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (url.includes('oauth2')) return { status: 200, json: { access_token: 'a', expires_in: 3600 } };
    if (url.includes('/values/')) return { status: 200, json: { values: [['Transaction ID', 'Date', 'Time', 'Type', 'Name', 'Category', 'Amount', 'Currency'], ['tx_1', 46297, 0.5, 'Card payment', 'Cafe', 'Eating out', -4.5, 'GBP']] } };
    if (url.includes('sheets.googleapis.com')) return { status: 200, json: { sheets: [{ properties: { title: 'Personal Account Transactions' } }] } };
    if (url.includes('trading212.com')) return { status: 401, json: null };
    return { status: 404, json: null };
  };
  return { request, calls };
}
async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-'));
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ google: { client_id: 'c', client_secret: 's', refresh_token: 'SECRET-REFRESH' }, t212: { key: 'SECRET-KEY', secret: 'SECRET-SECRET', env: 'live' } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ monzo: { sheetId: 'sheet1' } }));
  const up = fakeUpstream();
  const money = createMoney({ dir, approvedClaims: () => ({ version: 'fixture-v1', claims: [{ key: 'person', who: 'Taylor Reed', amount: 40.25, note: 'Synthetic repayment', senderNames: [] }, { key: 'expenses', who: 'Example Agency expenses', amount: 80.50, note: 'Synthetic expenses', senderNames: ['example agency'], category: 'Income' }] }), request: up.request, wait: async () => {}, log: { warn() {} } });
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); if (!(await money.handle(req, res, url))) { res.writeHead(418); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (p, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null), set, text: '' };
  };
  return { dir, money, server, call, up, forget: () => { cookie = ''; } };
}

test('locked until a passcode is set and typed; data never carries a secret', async () => {
  const h = await harness();
  try {
    let r = await h.call('/api/money/status'); assert.deepEqual([r.json.setup, r.json.unlocked], [false, false]);
    r = await h.call('/api/money'); assert.equal(r.status, 401); assert.equal(r.json.locked, true);
    r = await h.call('/api/money/setup', { passcode: '123' }); assert.equal(r.status, 400, 'too short');
    r = await h.call('/api/money/setup', { passcode: 'correct horse', remember: false });
    assert.equal(r.status, 200); assert.match(r.set, /HttpOnly/); assert.match(r.set, /SameSite=Strict/); assert.match(r.set, /Path=\/api\/money/);
    r = await h.call('/api/money/setup', { passcode: 'another one' }); assert.equal(r.status, 409, 'cannot be set twice');
    r = await h.call('/api/money/refresh', {});
    assert.equal(r.json.result.monzo.ok, true); assert.equal(r.json.result.t212.code, 'key-rejected');
    assert.equal(r.json.data.monzo.transactions.length, 1);
    const all = JSON.stringify(r.json); assert.ok(!/SECRET/.test(all), 'no credential in anything sent to the page');
    assert.ok(h.up.calls.every((c) => !c.url.includes('trading212') || c.method === 'GET'), 'Trading 212 is only ever read');
    for (const f of ['lock.json', 'monzo.json', 'status.json']) assert.equal(fs.statSync(path.join(h.dir, f)).mode & 0o077, 0, `${f} is private`);

    h.forget();
    r = await h.call('/api/money'); assert.equal(r.status, 401, 'a new device starts locked');
    r = await h.call('/api/money/unlock', { passcode: 'wrong' }); assert.equal(r.status, 401);
    r = await h.call('/api/money/unlock', { passcode: 'correct horse' }, 'POST', { Origin: 'http://evil.example' }); assert.equal(r.status, 403, 'other sites cannot post here');
    r = await h.call('/api/money/unlock', { passcode: 'correct horse', remember: true }); assert.equal(r.status, 200); assert.match(r.set, /Max-Age=2592000/);
    r = await h.call('/api/money'); assert.equal(r.status, 200);
    r = await h.call('/api/money/lock', {}); assert.equal(r.status, 200);
    r = await h.call('/api/money'); assert.equal(r.status, 401, 'locking ends the session');
  } finally { h.server.close(); }
});

test('five wrong tries make you wait', async () => {
  const h = await harness();
  try {
    await h.call('/api/money/setup', { passcode: 'correct horse' }); h.forget();
    for (let i = 0; i < 5; i++) assert.equal((await h.call('/api/money/unlock', { passcode: 'nope' + i })).status, 401);
    const r = await h.call('/api/money/unlock', { passcode: 'correct horse' }); assert.equal(r.status, 429);
  } finally { h.server.close(); }
});

test('the daemon wires money in without putting it in state', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /money\.handle\(req, res, url\)/);
  assert.ok(!/state\.money|money\.bundle\(/.test(src), 'money is never part of /api/state');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'command.js'), 'utf8');
  const block = page.slice(page.indexOf('/* MONEY'), page.indexOf('/* DOGFOOD'));
  assert.ok(block.length > 1000 && !/stash\(['"]money|localStorage\.setItem\([^)]*data/.test(block), 'money data is never cached in localStorage');
});

test('the daily run: once after 06:00, a failed source waits 3 hours, nothing without credentials', async () => {
  const { writeJson } = require('../money');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-due-'));
  let t = new Date(2026, 9, 3, 3, 12).getTime(); const iso = (ms) => new Date(ms).toISOString();
  const money = createMoney({ dir, now: () => t });
  assert.equal(await money.due(), false, 'no credentials, nothing to do');
  await writeJson(path.join(dir, 'credentials.json'), { google: { refresh_token: 'x', client_id: 'y' }, t212: { key: 'k', secret: 's' } });
  assert.equal(await money.due(), true, 'never run');
  const ran = t;
  await writeJson(path.join(dir, 'status.json'), { monzo: { ok: true, at: iso(ran), okAt: iso(ran) }, t212: { ok: false, at: iso(ran), okAt: null } });
  assert.equal(await money.due(), false, 'Monzo read since yesterday 06:00; Trading 212 failed just now');
  t = new Date(2026, 9, 3, 6, 15).getTime();
  assert.equal(await money.due(), true, "a 3am read doesn't count as today's");
  await writeJson(path.join(dir, 'status.json'), { monzo: { ok: true, at: iso(t), okAt: iso(t) }, t212: { ok: false, at: iso(t), okAt: null } });
  t += 2 * 3600e3; assert.equal(await money.due(), false, 'failed key: waits');
  t += 1.5 * 3600e3; assert.equal(await money.due(), true, 'and tries again after 3 hours');
});

// ---------------------------------------------------------------- round 2: context, plans, trips, the adviser

const { cleanContext, cleanPlans, adviceInput, cleanAdvice } = require('../money');
const PLAN = { rent: { id: 'rent', name: 'Accommodation', payee: 'Big Landlord', category: 'Rent', instalments: [{ due: '2026-09-01', from: '2026-09-01', to: '2026-09-11', amount: 700 }, { due: '2026-12-01', from: '2026-09-11', to: '2026-12-20', amount: 990 }] } };

test('rent paid by the term is spread over the days it covers', () => {
  const P = C.prepare(SAMPLE, RULES, { plans: PLAN });
  const paid = P.find((t) => t.name === 'Big Landlord' && !t.synthetic);
  assert.equal(paid.kind, 'planned'); assert.deepEqual(paid.planned, { plan: 'Accommodation', from: '2026-09-01', to: '2026-09-11', income: false });
  const s = C.summarize(P, { from: '2026-09-01', to: '2026-09-05' });
  assert.equal(s.spread, 5 * 70 + 0, '£70 a day for the first instalment'); assert.equal(s.planned, 700, 'the payment itself is noted, not counted');
  assert.ok(!C.recurring(P, '2026-10-03').some((r) => r.name === 'Accommodation'), 'spread rows are not a subscription');
  const months = C.monthly(P, '2026-10-03'); assert.equal(months[months.length - 1].month, '2026-10', 'no future months from rent spread ahead');
  assert.ok(Math.abs(months.find((m) => m.month === '2026-09').spent - (700 + 9.9 * 20 + 30 - 10)) < 0.05, 'September carries its share of rent');
});

test("what Owner says about a payment changes how it's counted", () => {
  const tesco = SAMPLE.find((t) => t.name === 'Tesco' && t.amount === -30);
  const ctx = cleanContext({ tx: { [tesco.id]: { tag: 'one-off', note: 'Restock after moving back', cat: 'Houdemoold' } }, trips: [{ id: 'trip-ski', name: 'Ski', from: '2026-09-29', to: '2026-10-05' }] });
  const P = C.prepare([...SAMPLE, { ...tx('2026-10-01', 'Chalet Cafe', -12, 'Eating out'), local: { amount: -14, currency: 'EUR' } }, tx('2026-10-02', 'Ski Hire', -80, 'Holidays')], RULES, { context: ctx });
  const t = P.find((x) => x.id === tesco.id);
  assert.deepEqual([t.oneOff, t.myNote, t.cat], [true, 'Restock after moving back', 'Houdemoold']);
  assert.equal(P.find((x) => x.name === 'Ski Hire').trip, 'trip-ski'); assert.equal(P.find((x) => x.name === 'Chalet Cafe').trip, 'trip-ski', 'paid abroad inside the dates');
  assert.equal(P.find((x) => x.name === 'Streamly').trip, undefined, 'a subscription in pounds stays out of the trip');
  const s = C.summarize(P, { from: '2026-09-28', to: '2026-10-03' }); assert.equal(s.lumps, 30); assert.deepEqual(s.trips, [{ id: 'trip-ski', spent: 92 }]);
  const off = cleanContext({ tx: { [tesco.id]: { tag: 'leave-out' } } }, ctx); assert.equal(C.prepare(SAMPLE, RULES, { context: off }).find((x) => x.id === tesco.id).kind, 'ignore');
  assert.deepEqual(cleanContext({ tx: { [tesco.id]: null } }, ctx).tx, {}, 'null clears it');
});

test('context and plans are cleaned before they are saved', () => {
  const c = cleanContext({ subs: { 'CrossFit Wirral': { status: 'paused', note: 'x'.repeat(500) }, Nope: { status: 'active' } }, notes: [{ text: '' }, { text: 'Moved', from: 'bad' }], profile: 'p' });
  assert.equal(c.subs['crossfit wirral'].status, 'paused'); assert.equal(c.subs['crossfit wirral'].note.length, 200); assert.ok(!c.subs.nope);
  assert.equal(c.notes.length, 1); assert.equal(c.notes[0].from, null);
  const p = cleanPlans({ rent: { name: 'R', instalments: [{ from: '2026-09-01', to: '2026-10-01', amount: '100.555' }, { from: 'x', to: 'y', amount: 1 }] }, 'Bad Id!': {} });
  assert.deepEqual(Object.keys(p), ['rent']); assert.equal(p.rent.instalments.length, 1); assert.equal(p.rent.instalments[0].amount, 100.56);
});

test('the adviser gets totals and notes, never ids; its answer is trimmed', () => {
  const b = { monzo: { transactions: SAMPLE }, rules: RULES, context: cleanContext({ profile: 'Student', notes: [{ text: 'Moved back' }] }), plans: PLAN, accounts: [], t212: null };
  const input = adviceInput(b, '2026-10-03'); const json = JSON.stringify(input);
  assert.ok(!/"id"|tx_|2026-08-28Acme/.test(json), 'no transaction ids'); assert.equal(input.profile, 'Student'); assert.equal(input.plans[0].instalments[0].paid, true);
  const a = cleanAdvice({ headline: 'h', going_well: ['a', 'b', 'c', 'd'], watch: 'nope', try: [1, ''] });
  assert.deepEqual(a, { headline: 'h', glance: '', going_well: ['a', 'b', 'c'], watch: [], try: ['1'] });
});

test('asking the adviser goes through the lock and saves one note', async () => {
  const h = await harness();
  try {
    let prompt = '';
    const money = createMoney({ dir: h.dir, wait: async () => {}, log: { warn() {} }, model: async (p, o) => { prompt = p; return { advice: { headline: 'Fine', going_well: ['ok'], watch: [], try: [] }, cost: 0.01 }; } });
    const server = http.createServer(async (req, res) => { await money.handle(req, res, new URL(req.url, 'http://x')); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, cookie, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/money/advice', {})).status, 401, 'locked');
    const set = (await post('/api/money/setup', { passcode: 'correct horse' })).headers.get('set-cookie').split(';')[0];
    fs.writeFileSync(path.join(h.dir, 'monzo.json'), JSON.stringify({ transactions: SAMPLE }));
    let r = await post('/api/money/context', { notes: [{ text: 'Moved back to uni' }] }, set, 'PATCH'); assert.equal((await r.json()).context.notes[0].text, 'Moved back to uni');
    r = await post('/api/money/advice', { model: 'claude-sonnet-5-5' }, set); assert.equal(r.status, 202, 'starts and answers at once');
    let note = null; for (let i = 0; i < 50 && !note; i++) { await new Promise((ok) => setTimeout(ok, 20)); note = (await (await fetch(base + '/api/money/advice', { headers: { Cookie: set } })).json()).advice.latest; }
    assert.equal(note.advice.headline, 'Fine'); assert.equal(note.model, 'claude-sonnet-5-5'); assert.match(prompt, /Moved back to uni/); assert.ok(!/SECRET/.test(prompt), 'no credentials in the prompt');
    const b = await (await fetch(base + '/api/money', { headers: { Cookie: set } })).json(); assert.equal(b.advice.latest.advice.headline, 'Fine'); assert.equal(b.adviser.schedule, 'weekly');
    r = await post('/api/money/advice', { id: note.id }, set, 'DELETE'); assert.equal((await r.json()).advice.notes.length, 0, 'a note can be removed');
    r = await post('/api/money/adviser', { schedule: 'off', model: 'gpt-6-luna' }, set, 'PUT'); assert.deepEqual([(await r.json()).adviser.schedule], ['off']);
    assert.equal(await money.adviceDue(), null, 'off means no scheduled notes');
    server.close();
  } finally { h.server.close(); }
});

test('a student loan plan is money in, spread over the term; moving money into pots is not new saving', () => {
  const loan = { loan: { id: 'loan', kind: 'income', name: 'Student loan', payee: 'Student Loans', category: 'Student loan', instalments: [{ due: '2026-09-21', from: '2026-09-21', to: '2026-10-01', amount: 100 }] } };
  const P = C.prepare([...SAMPLE, tx('2026-09-21', 'Student Loans Co', 100, 'Income', 'Faster payment')], RULES, { plans: loan });
  assert.equal(P.find((t) => t.name === 'Student Loans Co').kind, 'planned', 'the real payment is not counted twice');
  const s = C.summarize(P, { from: '2026-09-21', to: '2026-09-25' }); assert.equal(s.spreadIn, 50); assert.equal(s.earned, 50);
  const months = C.monthly([tx('2026-04-01', 'Me Elsewhere', 1000, 'Transfers', 'Faster payment'), tx('2026-04-02', 'Rainy Pot', -900, 'Savings', 'Pot transfer'), tx('2026-05-02', 'Rainy Pot', -50, 'Savings', 'Pot transfer')].map((t) => ({ ...t, kind: t.type === 'Pot transfer' ? 'pot' : 'internal', cat: t.category })), '2026-06-01');
  assert.deepEqual(months.map((m) => [m.month, m.saved, m.movedIn, m.putAway]), [['2026-04', 900, 1000, 0], ['2026-05', 50, 0, 50]]);
  assert.equal(C.groupOf('Rent'), 'need'); assert.equal(C.groupOf('Eating out'), 'want'); assert.equal(C.groupOf('General'), 'other');
});

test('pies group their holdings', () => {
  const { t212Pies } = require('../money');
  const pies = t212Pies([{ id: 1, cash: 0.1, result: { priceAvgInvestedValue: 100, priceAvgValue: 110, priceAvgResult: 10 } }], { 1: { settings: { name: 'Chips' }, instruments: [{ ticker: 'MU_US_EQ', ownedQuantity: 0.5, currentShare: 0.4, result: { priceAvgInvestedValue: 40, priceAvgValue: 44, priceAvgResult: 4 } }] } });
  assert.deepEqual([pies[0].name, pies[0].value, pies[0].instruments[0].ticker, pies[0].instruments[0].value], ['Chips', 110, 'MU_US_EQ', 44]);
});

test('a split pays itself off when the money arrives from that person', () => {
  const buy = tx('2026-09-14', 'Allsaints', -67.2, 'Shopping');
  const back = tx('2026-10-01', 'MORGAN EXAMPLE', 22.4, 'Income', 'Faster payment');
  const ctx = { tx: { [buy.id]: { note: "Finn's present", split: [{ who: 'Morgan', amount: 22.4, settled: false }, { who: 'Casey', amount: 22.4, settled: false }] } } };
  const P = C.prepare([buy, back, tx('2026-10-02', 'Someone Else', 22.4, 'Income')], {}, { context: ctx });
  const b = P.find((t) => t.id === buy.id);
  assert.deepEqual(b.split.map((x) => [x.who, x.settled, !!x.auto]), [['Morgan', true, true], ['Casey', false, false]]);
  const r = P.find((t) => t.id === back.id); assert.equal(r.kind, 'spend', 'money back, not income'); assert.equal(r.repays.who, 'Morgan');
  assert.equal(ctx.tx[buy.id].split[0].settled, false, 'the saved context is not changed');
});

test('simultaneous setup, unlocks, logouts and passcode changes serialise the lock', async () => {
  const h = await harness();
  try {
    const setup = await Promise.all([h.call('/api/money/setup', { passcode: 'correct horse' }), h.call('/api/money/setup', { passcode: 'different horse' })]);
    assert.deepEqual(setup.map((r) => r.status), [200, 409]);
    const unlocked = await Promise.all(Array.from({ length: 12 }, () => h.call('/api/money/unlock', { passcode: 'correct horse' })));
    assert.ok(unlocked.every((r) => r.status === 200));
    const tokens = unlocked.map((r) => r.set.split(';')[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'lock.json'))).sessions.length, 13);
    const active = await Promise.all(tokens.map((Cookie) => h.call('/api/money/status', undefined, 'GET', { Cookie })));
    assert.ok(active.every((r) => r.json.unlocked));
    const logged = await Promise.all(tokens.slice(0, 6).map((Cookie) => h.call('/api/money/lock', {}, 'POST', { Cookie })));
    assert.ok(logged.every((r) => r.status === 200));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'lock.json'))).sessions.length, 7);
    const changed = await Promise.all(['next horse one', 'next horse two'].map((next) => h.call('/api/money/passcode', { current: 'correct horse', next }, 'POST', { Cookie: tokens[6] })));
    assert.deepEqual(changed.map((r) => r.status), [200, 401]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'lock.json'))).sessions.length, 1);
  } finally { h.server.closeAllConnections(); await new Promise((r) => h.server.close(r)); fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('invalid Trading 212 successes preserve balances, holdings and history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-invalid-'));
  const summary = { totalValue: 110, cash: { availableToTrade: 10, reservedForOrders: 0, inPies: 0 }, investments: { currentValue: 100, totalCost: 90, unrealizedProfitLoss: 10, realizedProfitLoss: 0 } };
  const positions = [{ instrument: { ticker: 'X_EQ' }, quantity: 1, walletImpact: { currentValue: 100, totalCost: 90 } }];
  let badRoute = ''; let bad = null;
  const request = async (url) => ({ status: 200, json: url.includes(badRoute) && badRoute ? bad : url.includes('/summary') ? summary : url.includes('/positions') ? positions : url.includes('/pies') ? [] : { items: [] } });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ t212: { key: 'k', secret: 's' } }));
  const money = createMoney({ dir, request, wait: async () => {}, log: { warn() {} } });
  try {
    await money.pullT212();
    const before = fs.readFileSync(path.join(dir, 't212.json'), 'utf8');
    const history = fs.readFileSync(path.join(dir, 'history.json'), 'utf8');
    for (const [route, values] of [['/summary', [null, '<html>no JSON</html>', {}, { ...summary, totalValue: null, investments: {} }, { ...summary, cash: { availableToTrade: 'oops' } }]], ['/positions', [null, {}, [null], [{}], [{ ...positions[0], quantity: 'many' }], [{ ...positions[0], walletImpact: { currentValue: null, totalCost: 90 } }]]], ['/history/orders', [null, {}]]]) {
      badRoute = route;
      for (bad of values) {
        const out = await money.refresh();
        assert.equal(out.t212.ok, false, route + ': ' + JSON.stringify(bad));
        assert.equal(out.t212.code, 't212-invalid');
        assert.equal(fs.readFileSync(path.join(dir, 't212.json'), 'utf8'), before);
        assert.equal(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'), history);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'))).t212.ok, false);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Money HTTPS client caps bytes and elapsed time even when chunks keep arriving', async (t) => {
  const { mockHttps } = require('./http-fixture');
  const { httpsRequest } = require('../money');
  let mode = 'oversized';
  mockHttps(t, 'request', (res, req, ready) => {
    if (mode === 'declared oversized') res.headers['content-length'] = 50;
    ready();
    if (mode === 'oversized') { res.write('123456'); res.write('123456'); }
    else if (mode === 'slow') {
      const timer = setInterval(() => res.write(' '), 5);
      req.on('close', () => clearInterval(timer));
    } else if (mode === 'aborted') { res.write('{'); res.emit('aborted'); }
    else if (mode === 'good') { res.complete = true; res.end('{"ok":true}'); }
  });
  for (mode of ['oversized', 'declared oversized']) await assert.rejects(httpsRequest('https://example.test/', { maxBytes: 10 }), /too large/);
  mode = 'slow';
  await assert.rejects(httpsRequest('https://example.test/', { timeout: 35 }), /timed out/);
  mode = 'aborted';
  await assert.rejects(httpsRequest('https://example.test/'), /incomplete/);
  mode = 'good';
  assert.deepEqual((await httpsRequest('https://example.test/')).json, { ok: true });
});

test('standalone claims stay behind unlock, persist across reload, deduplicate and leave context and bank rows unchanged', async () => {
  const h = await harness();
  try {
    let r = await h.call('/api/money/receivables', { action:'seed-approved' });assert.equal(r.status,401);
    await h.call('/api/money/setup',{passcode:'claim test password'});
    const context={tx:{purchase:{split:[{who:'Casey',amount:22.4,settled:false},{who:'Morgan',amount:22.4,settled:false}]}}};
    fs.writeFileSync(h.money.files('context'),JSON.stringify(context));
    fs.writeFileSync(h.money.files('monzo'),JSON.stringify({transactions:[{id:'known',date:'2026-09-28',name:'Example Agency',category:'Income',amount:1800,counterpartyId:'verified-bank-sender'}]}));
    const bankBefore=fs.readFileSync(h.money.files('monzo'),'utf8');
    r=await h.call('/api/money/receivables',{action:'seed-approved'});assert.equal(r.status,200);assert.equal(r.json.claims.length,2);
    const claims=r.json.claims;assert.deepEqual(claims.map(c=>[c.amount,c.settled]),[[40.25,false],[80.50,false]]);
    r=await h.call('/api/money/receivables',{action:'seed-approved'});assert.equal(r.json.claims.length,2);
    r=await h.call('/api/money');assert.deepEqual(r.json.receivables,claims);assert.deepEqual(r.json.context.tx,context.tx);
    assert.equal(fs.readFileSync(h.money.files('monzo'),'utf8'),bankBefore);
    assert.equal(fs.statSync(h.money.files('receivables')).mode & 0o077,0);
    r=await h.call('/api/money/receivables',{action:'settle',id:claims[0].id});assert.equal(r.json.claims[0].settled,true);
    r=await h.call('/api/money/receivables',{action:'undo',id:claims[0].id});assert.equal(r.json.claims[0].settled,false);
    r=await h.call('/api/money/receivables',{action:'create',who:'Unrelated',amount:10,senderId:'guessed'});assert.equal(r.status,400);
    await h.call('/api/money/lock',{});r=await h.call('/api/money');assert.equal(r.status,401);
  } finally {h.server.close();}
});
