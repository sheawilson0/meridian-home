'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reportingWindow, summarise, createCollector } = require('../heart-health');

test('campaign window keeps launch day as the end date advances', () => {
  for (const now of ['2026-09-26T12:00:00Z', '2026-10-12T12:00:00Z']) {
    const window = reportingWindow(new Date(now), '2026-09-16');
    assert.equal(window.from, '2026-09-16');
    assert.equal(window.to, now.slice(0, 10));
    assert.equal(window.live, true);
  }
});

test('includes launch-day buckets and exposes the separate answer-tracking start', () => {
  const views = { summary: [{ vercel_analytics_pageview_count_sum: 3 }], data: [{ timestamp: '2026-09-15T23:00:00Z', vercel_analytics_pageview_count_sum: 3 }] };
  const empty = { summary: [], data: [] };
  const result = summarise(views, empty, empty, reportingWindow(new Date('2026-09-26T12:00:00Z'), '2026-09-16'), undefined, { answersFrom: '2026-09-21' });
  assert.equal(result.daily[0].day, '2026-09-16');
  assert.equal(result.daily[0].pageviews, 3);
  assert.equal(result.daily.length, 11);
  assert.equal(result.tracking.answersFrom, '2026-09-21');
});

test('repeated client refreshes share the ten-minute limit and failures retain data', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-09-26T12:00:00Z'), calls = 0, fail = false;
  const collector = createCollector({ from: '2026-09-16', file: path.join(dir, 'report.json'), now: () => new Date(time), query: async () => {
    calls++;
    if (fail) throw new Error('rate limited');
    return { summary: [], data: [] };
  } });
  await collector.refresh();
  const generatedAt = collector.collect().generatedAt;
  await Promise.all([collector.refresh(), collector.refresh()]);
  assert.equal(calls, 3);
  time += 600001;
  fail = true;
  await collector.refresh();
  assert.equal(calls, 6);
  assert.equal(collector.collect().generatedAt, generatedAt);
  assert.equal(collector.collect().stale, true);
});

test('hung queries are erroring with cached freshness and never overlap later refreshes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-health-hung-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.json'); let time = Date.parse('2026-09-26T12:00:00Z'), calls = 0;
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date(time - 1000).toISOString(), window: { to: '2026-09-26' } }));
  let expire;
  const collector = createCollector({ file, now: () => new Date(time), timers: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} },
    query: () => { calls++; return new Promise(() => {}); } });
  const p = collector.refresh(); await Promise.resolve(); time += 45000; expire(); await p;
  assert.equal(calls, 3); assert.equal(collector.source().stale, true); assert.equal(collector.source().lastSuccess, time - 46000);
  assert.equal(collector.source().durationMs, 45000); assert.match(collector.source().error, /budget/);
  time += 600001; await collector.refresh(); assert.equal(calls, 3); assert.match(collector.source().error, /still running/);
});

test('rate_limited waits for the next London day, including BST and GMT, then resumes normal retries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-health-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [start, midnight] of [['2026-10-08T12:00:00Z', '2026-10-08T23:00:00Z'], ['2026-10-25T12:00:00Z', '2026-10-26T00:00:00Z'], ['2026-03-28T12:00:00Z', '2026-03-29T00:00:00Z']]) {
    const file = path.join(dir, start.slice(0, 10) + '.json');
    let time = Date.parse(start), calls = 0, failure = 'rate_limited';
    fs.writeFileSync(file, JSON.stringify({ generatedAt: start, window: { to: start.slice(0, 10) }, stats: { pageviews: 42 } }));
    const collector = createCollector({ file, now: () => new Date(time), query: async () => {
      calls++;
      if (failure) throw Object.assign(new Error('CLI failed'), { stderr: failure });
      return { summary: [], data: [] };
    } });
    await collector.refresh();
    const attempt = collector.source().lastAttempt;
    assert.equal(calls, 3); assert.equal(collector.collect().stats.pageviews, 42);
    assert.match(collector.collect().error, /quota/); assert.equal(collector.source().stale, true);
    time += 600001; await collector.refresh(); assert.equal(calls, 3);
    time = Date.parse(midnight) - 1; await collector.refresh(); assert.equal(calls, 3);
    assert.equal(collector.source().lastAttempt, attempt);
    failure = 'ordinary failure'; time++; await collector.refresh(); assert.equal(calls, 6);
    await collector.refresh(); assert.equal(calls, 6);
    failure = null; time += 600001; await collector.refresh(); assert.equal(calls, 9);
    assert.equal(collector.collect().error, null);
    time += 600001; failure = 'ordinary failure'; await collector.refresh(); assert.equal(calls, 12);
    time += 600001; await collector.refresh(); assert.equal(calls, 15);
  }
});

test('unconfigured client analytics never executes a query or writes a cache', async () => {
 const collector = createCollector({ file: '/missing/example-report.json' });
 await collector.refresh(); assert.deepEqual(collector.collect(), { configured: false, dashboardUrl: '', stale: false, error: null });
});
