'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const { prFrom, checksFrom, failingFromRuns, createGithub } = require('../github');

test('prFrom and checksFrom map the GraphQL search nodes', () => {
  const pr = prFrom({ number: 18, title: 'Journey polish', url: 'https://github.com/Example-Agency/demo-coach/pull/18', state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-10-01T10:00:00Z', author: { login: 'example-owner' }, repository: { nameWithOwner: 'Example-Agency/demo-coach' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } });
  assert.deepEqual(pr, { repo: 'Example-Agency/demo-coach', number: 18, title: 'Journey polish', url: 'https://github.com/Example-Agency/demo-coach/pull/18', state: 'open', draft: true, checks: 'failing', reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-10-01T10:00:00Z', author: 'example-owner', mergedAt: null });
  assert.equal(prFrom({}), null, 'non-PR search hits are dropped');
  assert.deepEqual(['SUCCESS', 'ERROR', 'EXPECTED', 'PENDING', null].map(checksFrom), ['passing', 'failing', 'pending', 'pending', null]);
});

test('failingFromRuns keeps workflows whose latest default-branch run failed', () => {
  const since = Date.parse('2026-09-29T00:00:00Z');
  const run = (o) => ({ head_branch: 'main', status: 'completed', workflow_id: 1, name: 'CI', html_url: `https://x/${o.id}`, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z', conclusion: 'success', ...o });
  const out = failingFromRuns('o/r', 'main', [
    run({ id: 1, conclusion: 'failure', created_at: '2026-10-01T09:00:00Z' }),
    run({ id: 2, conclusion: 'success', created_at: '2026-10-01T11:00:00Z' }), // CI fixed since
    run({ id: 3, workflow_id: 2, name: 'Deploy', conclusion: 'failure', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:03:00Z' }),
    run({ id: 4, workflow_id: 3, name: 'Old', conclusion: 'failure', created_at: '2026-09-20T12:00:00Z' }),
    run({ id: 5, workflow_id: 4, name: 'Branch', head_branch: 'feature', conclusion: 'failure' }),
    run({ id: 6, workflow_id: 5, name: 'Running', status: 'in_progress', conclusion: null }),
  ], since);
  assert.deepEqual(out, [{ repo: 'o/r', branch: 'main', url: 'https://x/3', workflow: 'Deploy', at: '2026-10-01T12:03:00Z', conclusion: 'failure' }]);
});

test('createGithub keeps the last good value and reports the error', async () => {
  let fail = false;
  const runner = async (bin, args) => {
    if (fail) return { ok: false, code: 4, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n' };
    if (args[1] === 'graphql') return { ok: true, stdout: JSON.stringify({ data: { viewer: { login: 'me' }, mine: { nodes: [] }, reviews: { nodes: [] }, merged: { nodes: [] } } }) };
    return { ok: true, stdout: '[]' };
  };
  const g = createGithub({ bin: 'gh', runner, now: () => Date.parse('2026-10-02T08:00:00Z') });
  const v = await g.refresh();
  assert.equal(v.user, 'me');
  assert.equal(v.error, null);
  assert.deepEqual(Object.keys(v).slice(0, 7), ['at', 'user', 'prs', 'reviews', 'merged', 'failing', 'repos']);
  fail = true;
  const w = await g.refresh();
  assert.equal(w.user, 'me');
  assert.match(w.error, /gh auth login/);
});

test('partial GitHub outages keep failed checks per repo and expose stale data', async () => {
  let eventsFail = false; let actionsFail = false; let fixed = false;
  const ok = (value) => ({ ok: true, stdout: JSON.stringify(value) });
  const runner = async (bin, args) => {
    const route = args[1];
    if (route === 'graphql') return ok({ data: { viewer: { login: 'me' }, mine: { nodes: [] }, reviews: { nodes: [] }, merged: { nodes: [] } } });
    if (route.startsWith('users/') && eventsFail === 'shape') return ok({});
    if (route.startsWith('users/')) return eventsFail ? { ok: false, stderr: 'events unavailable' } : ok(['one', 'two'].map((repo) => ({ type: 'PushEvent', repo: { name: 'me/' + repo }, created_at: '2026-10-02T07:00:00Z' })));
    if (!route.includes('/actions/')) return ok({ default_branch: 'main', archived: false });
    if (actionsFail === 'shape' && route.includes('/one/')) return ok(null);
    if (actionsFail && route.includes('/one/')) return { ok: false, stderr: 'Actions unavailable' };
    return ok([{ head_branch: 'main', status: 'completed', name: 'CI', created_at: '2026-10-02T07:00:00Z', conclusion: fixed ? 'success' : 'failure' }]);
  };
  const g = createGithub({ runner, now: () => Date.parse('2026-10-02T08:00:00Z') });
  assert.equal((await g.refresh()).failing.length, 2);
  actionsFail = true; fixed = true;
  const partial = await g.refresh();
  assert.deepEqual(partial.failing.map((r) => r.repo), ['me/one']);
  assert.equal(partial.stale, true);
  assert.match(partial.error, /me\/one: Actions unavailable/);
  eventsFail = true;
  const events = await g.refresh();
  assert.deepEqual(events.failing.map((r) => r.repo), ['me/one']);
  assert.equal(events.repos, 2);
  assert.match(events.error, /events unavailable/);
  eventsFail = 'shape'; actionsFail = 'shape';
  const malformed = await g.refresh();
  assert.deepEqual(malformed.failing.map((r) => r.repo), ['me/one']);
  assert.equal(malformed.repos, 2);
  assert.match(malformed.error, /unreadable events/);
  assert.match(malformed.error, /unreadable workflow runs/);
  eventsFail = false; actionsFail = false;
  const recovered = await g.refresh();
  assert.deepEqual(recovered.failing, []);
  assert.equal(recovered.error, null);
  assert.equal(recovered.stale, false);
});

test('background source timings preserve retained data and expose a hung runner without overlap', async () => {
  let time = 1000, calls = 0, expire;
  const github = createGithub({ now: () => time, runner: () => { calls++; return new Promise(() => {}); },
    timers: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} } });
  const p = github.refresh(); await Promise.resolve(); time += 300000; expire(); await p;
  assert.equal(github.source().lastAttempt, 1000); assert.equal(github.source().lastSuccess, null); assert.equal(github.source().durationMs, 300000);
  assert.match(github.source().error, /budget/); assert.equal(github.source().stale, false);
  await github.refresh(); assert.equal(calls, 1); assert.match(github.source().error, /still running/);
});
