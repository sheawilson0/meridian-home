#!/usr/bin/env node
// Prints today's raw activity as markdown on stdout. Deterministic, no AI.
// The nightly ledger prompt embeds this; it is also the fallback entry if
// the model call fails.

'use strict';
const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const state = JSON.parse(await get('http://127.0.0.1:4980/api/state'));
  const day = new Date().toISOString().slice(0, 10);
  const hm = (t) => new Date(t).toTimeString().slice(0, 5);
  const out = [];

  out.push(`# Raw activity — ${day}`, '');

  out.push('## Timeline');
  const evs = (state.pulse && state.pulse.events) || [];
  if (!evs.length) out.push('- (no recorded events)');
  for (const e of evs) out.push(`- ${hm(e.t)} [${e.kind}] ${e.label}`);
  out.push('');

  out.push('## Agent sessions (last 48h, newest first)');
  for (const s of state.ai.sessions.slice(0, 15)) {
    out.push(`- ${s.tool} · ${s.project} · last active ${hm(s.last)}${s.live ? ' · LIVE' : ''}${s.summary ? ' · summary: ' + s.summary : ''}`);
    if (s.prompt) out.push(`  task: "${s.prompt}"`);
  }
  out.push('');

  out.push('## Repos with uncommitted work');
  for (const r of state.git.repos.filter((r) => r.dirty > 0)) {
    out.push(`- ${r.name} (${r.branch}): ${r.dirty} dirty files, last commit "${r.subject}"`);
  }
  out.push('');

  out.push('## Board');
  for (const c of state.board.cards.slice(0, 15)) {
    out.push(`- [${c.status}]${c.needsYou ? ' [NEEDS OWNER]' : ''} ${c.title}`);
  }
  out.push('');

  out.push('## Unrouted in LifeOS root');
  const strays = (state.drift && state.drift.strays) || [];
  if (!strays.length) out.push('- none, root matches AGENTS.md routing');
  for (const n of strays) out.push(`- NEEDS ROUTING: "${n}" sits in the LifeOS root but is not in the AGENTS.md routing table. Owner decides where it lives.`);
  out.push('');

  const downs = [...state.fleet.services, ...state.fleet.sites].filter((x) => !x.up && !x.paused);
  const flags = (state.fleet.agents || []).filter((a) => a.exitStatus !== 0);
  out.push('## Fleet flags');
  if (!downs.length && !flags.length) out.push('- all green');
  for (const d of downs) out.push(`- DOWN: ${d.name}`);
  for (const f of flags) out.push(`- launchd exit ${f.exitStatus}: ${f.label}`);

  console.log(out.join('\n'));
})().catch((e) => { console.error(e.message); process.exit(1); });
