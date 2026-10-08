#!/usr/bin/env node
'use strict';

// Money tab setup, run on the Home Mac (3 Oct 2026).
//
//   node scripts/money-setup.js import-hermes   copy the Google sign-in and Trading 212 key Hermes already has
//   node scripts/money-setup.js t212            type a new Trading 212 key and secret (hidden), test it, save it
//   node scripts/money-setup.js reset-lock      forgot the passcode: clears it and signs every device out
//   node scripts/money-setup.js refresh         read Monzo and Trading 212 now
//   node scripts/money-setup.js agent-token main   make a read-only token for an agent on another Mac (printed once)
//   node scripts/money-setup.js agent-revoke main  stop that token working
//   node scripts/money-setup.js agent-token codex-home money.read,receivables.write  scoped grant (printed once)
//
// Secrets go to data/money/credentials.json (0600) and are never printed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { createMoney, readJson, writeJson } = require('../money');
const { parseScopes } = require('../money-agent');
const { withAgentAdminLock } = require('../money-agent-setup');

const DIR = path.join(__dirname, '..', 'data', 'money');
const F = (n) => path.join(DIR, n + '.json');
const money = createMoney({ dir: DIR });

function hidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

async function importHermes() {
  const home = path.join(os.homedir(), '.hermes');
  const all = await readJson(F('credentials'), {});
  try {
    const g = JSON.parse(fs.readFileSync(path.join(home, 'google_token.json'), 'utf8'));
    if (g.refresh_token && g.client_id) { all.google = { client_id: g.client_id, client_secret: g.client_secret, refresh_token: g.refresh_token, token_uri: g.token_uri || 'https://oauth2.googleapis.com/token', from: 'hermes', added: new Date().toISOString() }; console.log('Google: copied from Hermes'); }
  } catch { console.log('Google: no Hermes token found'); }
  try {
    const env = {}; for (const l of fs.readFileSync(path.join(home, '.env'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#')) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
    if (env.T212_API_KEY && env.T212_API_SECRET) { all.t212 = { key: env.T212_API_KEY, secret: env.T212_API_SECRET, env: 'live', from: 'hermes', added: new Date().toISOString() }; console.log('Trading 212: copied from Hermes'); }
  } catch { console.log('Trading 212: no Hermes key found'); }
  await writeJson(F('credentials'), all);
}

async function t212() {
  const key = await hidden('Trading 212 API key: ');
  const secret = await hidden('Trading 212 API secret: ');
  if (!key || !secret) { console.log('Both are needed. Nothing saved.'); process.exit(2); }
  try { await money.pullT212({ key, secret, env: 'live' }); } catch (e) { console.log('Not saved: ' + e.message); process.exit(1); }
  const all = await readJson(F('credentials'), {}); all.t212 = { key, secret, env: 'live', added: new Date().toISOString() };
  await writeJson(F('credentials'), all); console.log('Saved. Reading the account now…');
  const out = await money.refresh('setup'); console.log(JSON.stringify(out.t212));
}

async function resetLock() {
  const doc = await readJson(F('lock'), {}); await writeJson(F('lock'), { sessions: [], resetAt: Date.now(), was: !!doc.hash });
  console.log('Passcode cleared and every device signed out. Open the Money tab to choose a new one.');
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'import-hermes') await importHermes();
  else if (cmd === 't212') await t212();
  else if (cmd === 'reset-lock') await resetLock();
  else if (cmd === 'agent-token' || cmd === 'agent-revoke') {
    const name = String(process.argv[3] || '').trim(); if (!/^[\w-]{2,30}$/.test(name)) { console.log('Give it a name, like main'); process.exit(2); }
    await withAgentAdminLock(DIR, async () => {
    const doc = await readJson(F('agents'), { tokens: [] }); doc.tokens = (doc.tokens || []).filter((x) => x.name !== name);
    const at = new Date().toISOString(); doc.audit = doc.audit || [];
    if (cmd === 'agent-token') {
      const scopes = parseScopes(process.argv[4]);
      const tok = require('crypto').randomBytes(32).toString('base64url');
      doc.tokens.push({ name, scopes, h: require('crypto').createHash('sha256').update(tok).digest('hex'), created: at });
      doc.audit.push({ at, action: 'grant-or-rotate', name, scopes });
      await writeJson(F('agents'), doc); console.log(tok);
    } else {
      doc.audit.push({ at, action: 'revoke', name });
      await writeJson(F('agents'), doc); console.log('Revoked ' + name);
    }
    });
  }
  else if (cmd === 'refresh') console.log(JSON.stringify(await money.refresh('cli'), null, 1));
  else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 11).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(cmd ? 1 : 0); }
})().catch((e) => { console.error(e.message); process.exit(1); });
