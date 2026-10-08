#!/usr/bin/env node
// Prints what Owner actually worked on today, per project, from the real
// session transcripts (Claude Code and Codex) plus git commits. Deterministic,
// no AI: it extracts what Owner asked for and what the agent said it finished,
// so the nightly ledger agent has material to write English from.
// Usage: node scripts/day-in-english.js [YYYY-MM-DD] [--json]
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const cp = require('child_process');
const HOME = os.homedir();
const args = process.argv.slice(2); const asJson = args.includes('--json');
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);
const dayStart = new Date(day + 'T00:00:00').getTime(), dayEnd = dayStart + 86400e3;

const clean = (t) => String(t || '').replace(/\b[A-Za-z0-9_#-]{40,}\b/g, '[redacted]').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/g, '').replace(/\[Image:[^\]]*\]/g, '').replace(/\[Attached image[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
const isReal = (t) => t && t.length > 12 && !/^(continue|ok|yes|no|go|do it|thanks?|you working)\b/i.test(t) && !/^\[Request interrupted/.test(t) && !/^#|^AGENTS\.md|environment_context|<environment|^Reply with exactly|^\[redacted\]/.test(t) && !/^base directory for this skill|use this skill whenever|system-reminder|<command-name>|task-notification|<\/usage>/i.test(t) && !/^[-*\u2022]\s/.test(t);
const projectOf = (cwd) => { const p = String(cwd || '').replace(HOME, '~'); const parts = p.split('/').filter(Boolean); const i = parts.indexOf('Developer'); if (i >= 0 && parts[i + 1]) return parts[i + 1] === 'Example Agency' && parts[i + 2] ? parts[i + 2] : parts[i + 1]; if (p.includes('LifeOS/command-centre')) return 'Meridian'; if (p.includes('LifeOS')) return 'LifeOS'; return parts.pop() || 'home'; };

const sessions = [];
// Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl
const cdir = path.join(HOME, '.claude', 'projects');
for (const slug of fs.existsSync(cdir) ? fs.readdirSync(cdir) : []) {
  const d = path.join(cdir, slug); let files = []; try { files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of files) {
    const full = path.join(d, f); const st = fs.statSync(full); if (st.mtimeMs < dayStart) continue;
    const asks = [], dones = []; let cwd = null, first = null, last = null;
    for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
      if (!line) continue; let j; try { j = JSON.parse(line); } catch { continue; }
      const ts = j.timestamp ? Date.parse(j.timestamp) : null; if (ts && (ts < dayStart || ts >= dayEnd)) continue;
      if (j.cwd && !cwd) cwd = j.cwd; if (ts) { first = first || ts; last = ts; }
      const c = j.message && j.message.content; const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
      if (j.type === 'user' && !j.isMeta && Array.isArray(c) ? !c.some((x) => x.type === 'tool_result') : j.type === 'user') { const t = clean(text); if (isReal(t)) asks.push(t); }
      if (j.type === 'assistant' && text) dones.push(clean(text));
    }
    if (asks.length || dones.length) sessions.push({ tool: 'claude', project: projectOf(cwd || slug.replace(/^-Users-example-?/, '~/').replace(/-/g, '/')), cwd, first, last, asks, done: dones.filter((t) => t.length > 40).slice(-1)[0] || '' });
  }
}
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
const xdir = path.join(HOME, '.codex', 'sessions', ...day.split('-'));
for (const f of fs.existsSync(xdir) ? fs.readdirSync(xdir).filter((f) => f.endsWith('.jsonl')) : []) {
  const asks = [], dones = []; let cwd = null, first = null, last = null;
  for (const line of fs.readFileSync(path.join(xdir, f), 'utf8').split('\n')) {
    if (!line) continue; let j; try { j = JSON.parse(line); } catch { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : null; if (ts) { first = first || ts; last = ts; }
    const p = j.payload || {};
    if (j.type === 'session_meta' && p.cwd) cwd = p.cwd;
    if (j.type === 'event_msg' && p.type === 'user_message') { const t = clean(p.message); if (isReal(t)) asks.push(t); }
    if (j.type === 'event_msg' && p.type === 'agent_message') dones.push(clean(p.message));
    if (j.type === 'response_item' && p.type === 'message' && p.role === 'assistant') dones.push(clean((p.content || []).map((x) => x.text || '').join(' ')));
  }
  if (asks.length) sessions.push({ tool: 'codex', project: /^Automation:/.test(asks[0]) ? 'Automations' : projectOf(cwd), cwd, first, last, asks, done: dones.filter((t) => t.length > 40).slice(-1)[0] || '' });
}
// git commits today, per repo under ~/Developer (two levels) and Meridian
const commits = {};
const repos = []; for (const base of [path.join(HOME, 'Developer'), path.join(HOME, 'Developer', 'Example Agency'), path.join(HOME, 'LifeOS', 'command-centre')]) { try { for (const n of fs.readdirSync(base)) if (fs.existsSync(path.join(base, n, '.git'))) repos.push(path.join(base, n)); } catch { /* none */ } }
for (const r of repos) { try { const out = cp.execFileSync('git', ['-C', r, 'log', `--since=${day} 00:00`, `--until=${day} 23:59:59`, '--format=%s', '--no-merges'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (out) commits[projectOf(r)] = out.split('\n'); } catch { /* skip */ } }

const byProject = new Map();
for (const s of sessions) { if (!byProject.has(s.project)) byProject.set(s.project, { project: s.project, sessions: [], commits: commits[s.project] || [] }); byProject.get(s.project).sessions.push(s); }
for (const [p, list] of Object.entries(commits)) if (!byProject.has(p)) byProject.set(p, { project: p, sessions: [], commits: list });
const groups = [...byProject.values()].sort((a, b) => (b.sessions.length + b.commits.length) - (a.sessions.length + a.commits.length));
if (asJson) { console.log(JSON.stringify({ day, groups }, null, 1)); process.exit(0); }
const hm = (t) => t ? new Date(t).toTimeString().slice(0, 5) : '';
console.log(`# What Owner worked on — ${day}\n`);
for (const g of groups) {
  console.log(`## ${g.project}  (${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'}${g.commits.length ? `, ${g.commits.length} commit${g.commits.length === 1 ? '' : 's'}` : ''})`);
  for (const s of g.sessions.sort((a, b) => (a.first || 0) - (b.first || 0))) {
    if (!s.asks.length && !s.done) continue;
    const asked = s.asks.slice(0, 3).map((a) => '"' + a.slice(0, 180) + '"').join(' | ');
    console.log(`- ${hm(s.first)}–${hm(s.last)} ${s.tool}${asked ? ': asked → ' + asked : ''}`);
    if (s.done) console.log(`  finished → ${s.done.slice(0, 260)}`);
  }
  for (const c of g.commits) console.log(`- commit: ${c}`);
  console.log('');
}
