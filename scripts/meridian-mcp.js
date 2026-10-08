#!/usr/bin/env node
'use strict';

// Meridian's agent tools over stdio (4 Oct 2026): drafts that open in the Mac
// app's side panel, opening a page there, and adding a to-do. A thin bridge:
// each JSON-RPC line goes to the daemon's POST /mcp and the reply comes back,
// so the tools themselves live in one place (drafts.js).
//
//   claude mcp add meridian -- node ~/Meridian/scripts/meridian-mcp.js
//   codex mcp add meridian -- node ~/Meridian/scripts/meridian-mcp.js
//
// MERIDIAN_URL    the daemon (default http://127.0.0.1:4980; on the Main Mac,
//                 the Home Mac's https://…ts.net address)
// MERIDIAN_TOKEN  a scoped grant, or the legacy owner token
// MERIDIAN_AGENT  legacy attribution (a scoped grant supplies its own name)
//
// A cloud agent (a ChatGPT Dot) can't run this; it needs /mcp at a public
// https address instead. Existing owner URLs still work; grants require Bearer headers.

const readline = require('readline');
const { requestError } = require('../mcp-protocol');

const BASE = (process.env.MERIDIAN_URL || 'http://127.0.0.1:4980').replace(/\/+$/, '');
const q = new URLSearchParams({ as: process.env.MERIDIAN_AGENT || 'agent' });
const ENDPOINT = `${BASE}/mcp?${q}`;

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let protocolVersion;

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  const invalid = requestError(msg);
  if (invalid) { out(invalid); return; }
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (process.env.MERIDIAN_TOKEN) headers.Authorization = 'Bearer ' + process.env.MERIDIAN_TOKEN;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    const r = await fetch(ENDPOINT, { method: 'POST', headers, body: line });
    if (r.status === 202) return;
    if (r.status === 401 || r.status === 403) {
      const denied = await r.json().catch(() => null);
      if (denied?.jsonrpc === '2.0' && denied.error || Array.isArray(denied) && denied.every(m => m?.jsonrpc === '2.0')) { out(denied); return; }
    }
    if (!r.ok) throw new Error(r.status === 403 ? 'Meridian refused the connection (set MERIDIAN_TOKEN off the tailnet)' : 'Meridian answered ' + r.status);
    const reply = await r.json();
    if (msg.method === 'initialize' && reply.result?.protocolVersion) protocolVersion = reply.result.protocolVersion;
    out(reply);
  } catch (e) {
    if (msg && typeof msg === 'object' && msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Can't reach Meridian at ${BASE}: ${e.message || e}` } });
  }
});
