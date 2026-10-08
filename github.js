'use strict';
const runtime = require('./runtime');
const jobsEnabled = () => runtime.connectorEnabled('github');

// GitHub at a glance, through the `gh` CLI Owner is already logged in to on
// this Mac (account example-owner, token in the login keychain). Every 10
// minutes: his open PRs, PRs waiting on his review, his PRs merged in the
// last 7 days, and default-branch workflows whose latest run in the last 3
// days failed, on repos he pushed to in the last 14 days. Search covers his
// own repos and every org he belongs to (Example Agency's included).
//
// gh reads its token from the keychain via /usr/bin/security, which works
// from a launchd user agent; PATH is set here because launchd's is bare.

const { execute } = require('./process-runner');
const { createSources } = require('./refresh');
const fs = require('fs');

const GH_BINS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '' };
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function findGh() { return GH_BINS.find((b) => fs.existsSync(b)) || 'gh'; }

function exec(bin, args, timeout = 20000) {
  return execute(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: ENV })
    .then(r => ({ ok: true, code: 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }),
      e => ({ ok: false, code: e.code ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
}

const PR_FIELDS = 'number title url state isDraft reviewDecision updatedAt mergedAt author { login } repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';
const QUERY = `query($mine: String!, $reviews: String!, $merged: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  reviews: search(query: $reviews, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  merged: search(query: $merged, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
}`;

function checksFrom(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'SUCCESS') return 'passing';
  if (s === 'FAILURE' || s === 'ERROR') return 'failing';
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending';
  return null;
}

function prFrom(node) {
  if (!node || !node.number || !node.repository) return null;
  const commit = node.commits && node.commits.nodes && node.commits.nodes[0] && node.commits.nodes[0].commit;
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: String(node.title || ''),
    url: node.url,
    state: String(node.state || '').toLowerCase() || null,
    draft: Boolean(node.isDraft),
    checks: checksFrom(commit && commit.statusCheckRollup && commit.statusCheckRollup.state),
    reviewDecision: node.reviewDecision || null,
    updatedAt: node.updatedAt || null,
    author: (node.author && node.author.login) || null,
    mergedAt: node.mergedAt || null,
  };
}

// Latest completed run per workflow on the branch since `sinceMs`; the
// ones that failed. A later green run means it is fixed, so it is left out.
function failingFromRuns(repo, branch, runs, sinceMs) {
  const latest = new Map();
  for (const r of runs || []) {
    if (!r || r.head_branch !== branch || r.status !== 'completed') continue;
    if (!(Date.parse(r.created_at) >= sinceMs)) continue;
    const k = r.workflow_id || r.name;
    const prev = latest.get(k);
    if (!prev || String(r.created_at) > String(prev.created_at)) latest.set(k, r);
  }
  return [...latest.values()].filter((r) => FAILED.has(r.conclusion)).map((r) => ({
    repo, branch, url: r.html_url, workflow: r.name || r.display_title || 'workflow', at: r.updated_at || r.created_at, conclusion: r.conclusion,
  }));
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function createGithub({ bin = findGh(), runner = exec, now = () => Date.now(), maxRepos = 20, timers } = {}) {
  let value = { at: null, user: null, prs: [], reviews: [], merged: [], failing: [], error: null };
  let running = null;
  let recentRepos = new Map();
  const sources = createSources({ now, timers, onError: (_name, error) => { value = { ...value, stale: true, error: String(error.message || error) }; } });
  sources.observe('github', {});

  async function api(args, timeout) {
    const r = await runner(bin, ['api', ...args], timeout);
    if (!r.ok) throw new Error((r.stderr || r.stdout || `gh exited ${r.code}`).trim().split('\n')[0].slice(0, 240));
    try { return JSON.parse(r.stdout || 'null'); } catch { throw new Error('gh returned unreadable JSON'); }
  }

  async function refresh() {
    if (!jobsEnabled()) return value;
    if (running) return running;
    running = sources.collect('github', async () => {
      const t = now();
      const day = (ms) => new Date(t - ms).toISOString().slice(0, 10);
      try {
        const g = await api(['graphql', '-f', `query=${QUERY}`,
          '-f', 'mine=is:pr is:open author:@me archived:false sort:updated-desc',
          '-f', 'reviews=is:pr is:open review-requested:@me archived:false sort:updated-desc',
          '-f', `merged=is:pr is:merged author:@me merged:>=${day(7 * 86400000)} sort:updated-desc`], 30000);
        if (g && g.errors && !g.data) throw new Error(String(g.errors[0] && g.errors[0].message || 'GraphQL error').slice(0, 240));
        const d = (g && g.data) || {};
        const list = (k) => ((d[k] && d[k].nodes) || []).map(prFrom).filter(Boolean);
        const user = d.viewer && d.viewer.login;
        const prs = list('mine'); const reviews = list('reviews'); const merged = list('merged');

        // Repos he pushed to in 14 days: his push events, plus his PRs' repos.
        const errors = [];
        let events;
        try {
          events = await api([`users/${user}/events?per_page=100`], 20000);
          if (!Array.isArray(events)) throw new Error('unreadable events');
        } catch (e) { events = null; errors.push('GitHub events: ' + e.message); }
        const since14 = t - 14 * 86400000;
        const recent = events ? new Map() : new Map(recentRepos);
        for (const e of Array.isArray(events) ? events : []) {
          if (e.type !== 'PushEvent' || !e.repo || !(Date.parse(e.created_at) >= since14)) continue;
          if (!recent.has(e.repo.name) || e.created_at > recent.get(e.repo.name)) recent.set(e.repo.name, e.created_at);
        }
        for (const p of [...prs, ...merged]) if (p.author === user && !recent.has(p.repo) && Date.parse(p.updatedAt) >= since14) recent.set(p.repo, p.updatedAt);
        recentRepos = recent;
        const repos = [...recent.entries()].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, maxRepos).map(([r]) => r);
        const since3 = t - 3 * 86400000;
        const failing = (await pool(repos, 4, async (repo) => {
          try {
            const info = await api([`repos/${repo}`, '--jq', '{default_branch: .default_branch, archived: .archived}'], 15000);
            if (info?.archived) return [];
            if (!info?.default_branch) throw new Error('unreadable repository');
            const runs = await api([`repos/${repo}/actions/runs?branch=${encodeURIComponent(info.default_branch)}&per_page=30&created=${encodeURIComponent('>=' + day(3 * 86400000))}`, '--jq', '.workflow_runs'], 15000);
            if (!Array.isArray(runs)) throw new Error('unreadable workflow runs');
            return failingFromRuns(repo, info.default_branch, runs, since3);
          } catch (e) {
            errors.push(repo + ': ' + e.message);
            return value.failing.filter((r) => r.repo === repo);
          }
        })).flat().sort((a, b) => String(b.at).localeCompare(String(a.at)));
        value = { at: new Date(t).toISOString(), user, prs, reviews, merged, failing, repos: repos.length, error: errors.length ? errors.sort().join('; ') : null, stale: errors.length > 0 };
      } catch (e) {
        value = { ...value, stale: true, error: String(e.message || e), errorAt: new Date(t).toISOString() };
      }
      return value;
    }, { deadline: now() + 5 * 60000, fallback: value, retained: Boolean(value.at), describe: v => ({ error: v.error, stale: Boolean(v.stale && v.at) }) }).finally(() => { running = null; });
    return running;
  }

  return { refresh, get: () => value, source: () => sources.snapshot().github };
}

module.exports = { createGithub, prFrom, checksFrom, failingFromRuns, QUERY, findGh };
