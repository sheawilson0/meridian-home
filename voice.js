'use strict';
const runtime = require('./runtime');
const JOBS_ENABLED = runtime.connectorEnabled('voice');

// Voice (6 Oct 2026): Meridian's own voice, for talking through a draft while
// it changes on screen. The page (/voice, or /voice/call on the phone) opens a
// WebRTC call straight to OpenAI. Only the session setup comes through here,
// so the API key stays on this Mac and never reaches a browser.
//
// Two engines to compare:
//   live      GPT-Live-1: a full-duplex voice that hands thinking and tools to
//             a backend model (GPT-6.1 Sol). $0.05 a minute plus the backend.
//   realtime  gpt-realtime-2.1 (and -mini): one speech-to-speech model.
// Both get the same small set of draft tools as plain functions. The page
// runs them against /api/drafts as "Voice", so every change lands in the
// draft's history ({rev, by, at, field, before, after}) and any open draft tab
// sees it live. GPT-Live's backend can't use MCP, and running the tools in the
// page means the voice never needs a public address or Meridian's token.
//
// The key comes from the daemon's environment (OPENAI_API_KEY) or the macOS
// Keychain item `meridian-openai`. Calls are capped per day, and the page hangs
// up after `maxMinutes` or a few silent minutes, because GPT-Live bills by the
// clock. Each finished call is logged to data/voice-usage.jsonl.
//
//   GET  /api/voice/status    { ready, keySource, engines, limits, today }
//   POST /api/voice/session   { engine, voice, draftId, sdp } -> { sdp, engine, by, sessionId }
//   POST /api/voice/usage     { engine, seconds, usage }  after a call ends

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

const ENGINES = {
  live: { label: 'Live', model: 'gpt-live-1', backend: 'gpt-6.1-sol', by: 'Voice · Live',
    voices: ['marin', 'meridian', 'quartz', 'willow', 'vesper', 'cedar'], note: 'GPT-Live-1 · $0.05/min + Sol' },
  realtime: { label: 'Realtime', model: 'gpt-realtime-2.1', by: 'Voice · Realtime',
    voices: ['marin', 'cedar', 'alloy', 'verse', 'shimmer'], note: 'gpt-realtime-2.1 · ≈ $0.08/min' },
  'realtime-mini': { label: 'Mini', model: 'gpt-realtime-2.1-mini', by: 'Voice · Mini',
    voices: ['marin', 'cedar', 'alloy', 'verse', 'shimmer'], note: '2.1 mini · ≈ $0.03/min' },
};

const FIELDS = ['to', 'cc', 'subject', 'title', 'where', 'body'];

// The tools the voice can use. The page runs them (public/voice/voice-core.js).
const TOOLS = [
  { name: 'draft_read', description: 'Read the draft as it is right now, including anything Owner just typed. Call this before editing if you have not read it in the last few turns.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'draft_replace_text', description: 'Change part of the draft: replace an exact piece of its current text with new text. Use for most edits, so Owner sees only what you changed. `find` must match the current text exactly, with enough words to be unique.',
    parameters: { type: 'object', properties: { field: { type: 'string', enum: FIELDS, description: 'Default body.' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'], additionalProperties: false } },
  { name: 'draft_set_field', description: 'Replace a whole field: the recipients (to, cc), subject, title, where (Notion location), or the whole body when writing it for the first time.',
    parameters: { type: 'object', properties: { field: { type: 'string', enum: FIELDS }, value: { type: 'string' } }, required: ['field', 'value'], additionalProperties: false } },
  { name: 'draft_append', description: 'Add a new paragraph to the end of the body.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'draft_create', description: 'Start a new draft and switch to it, when Owner asks for something that is not the draft on screen.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['email', 'slack', 'text', 'note', 'notion'] }, to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['kind'], additionalProperties: false } },
];

const EDITING = `You are working on a draft with Owner in Meridian, his dashboard. He can see the draft on screen while you talk, and he edits it too, so his changes can appear between your turns.
- Make changes with the tools. Prefer draft_replace_text for small, targeted edits so he sees exactly what you changed. Write a whole body only when starting from nothing.
- Read the draft (draft_read) before editing if you haven't just read it.
- Write plain text: blank lines between paragraphs, no markdown headings. Emails get a greeting and a sign-off. British spelling.
- Never send anything. Meridian holds the words; Owner sends.`;

function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function draftSnapshot(d) {
  if (!d) return 'No draft is open yet. If Owner wants to write something, use draft_create.';
  const lines = [`The draft on screen (id ${d.id}, a ${d.kind}):`];
  for (const f of ['to', 'cc', 'subject', 'where']) if (d[f]) lines.push(`${f}: ${d[f]}`);
  lines.push('body:', d.body ? String(d.body).slice(0, 6000) : '(empty)');
  return lines.join('\n');
}

// The session we ask OpenAI for. soul is Owner's data/soul.md (the voice he's shaping), trimmed.
function sessionConfig(engineId, { voice, draft, soul = '' } = {}) {
  const e = ENGINES[engineId];
  if (!e) throw fail('unknown engine ' + engineId);
  const v = e.voices.includes(voice) ? voice : e.voices[0];
  const persona = soul ? `How Owner wants you to sound:\n${String(soul).slice(0, 2500)}\n\n` : '';
  const tools = TOOLS.map((t) => ({ type: 'function', ...t }));
  if (engineId === 'live') {
    return {
      model: e.model,
      instructions: `${persona}You are Meridian, Owner's voice in his dashboard. Speak briefly and naturally, like a colleague at the next desk. You don't edit anything yourself: hand every request to read, write or change the draft to the backend, then say in a few words what changed. Don't read the whole draft aloud unless he asks.`,
      audio: { output: { voice: v } },
      delegation: { type: 'responses', responses: { model: e.backend, instructions: `${EDITING}\n\n${draftSnapshot(draft)}`, tools, tool_choice: 'auto' } },
    };
  }
  return {
    type: 'realtime',
    model: e.model,
    instructions: `${persona}You are Meridian, Owner's voice in his dashboard. Speak briefly and naturally. Say in a few words what you changed; don't read the whole draft aloud unless he asks.\n\n${EDITING}\n\n${draftSnapshot(draft)}`,
    audio: { output: { voice: v } },
    tools,
    tool_choice: 'auto',
  };
}

function keychainKey(service = 'meridian-openai') {
  if (process.platform !== 'darwin' || !require('./first-run').executable('/usr/bin/security')) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

function createVoice({ dataDir, drafts, readSoul = async () => '', config = {}, env = process.env, getKeychainKey = keychainKey, fetchImpl = fetch, now = () => Date.now() }) {
  const limits = { dailyCalls: Number(config.dailyCalls) || 12, maxMinutes: Number(config.maxMinutes) || 15, idleMinutes: Number(config.idleMinutes) || 3 };
  const usageFile = path.join(dataDir, 'voice-usage.jsonl');
  let calls = { day: '', count: 0 };
  let cached = { at: 0, key: '', source: null };

  const today = () => new Date(now()).toISOString().slice(0, 10);
  async function key() {
    if (!JOBS_ENABLED) return { key: '', source: null };
    if (env.OPENAI_API_KEY) return { key: env.OPENAI_API_KEY, source: 'env' };
    if (now() - cached.at < 5 * 60 * 1000 && cached.key) return cached;
    const k = await getKeychainKey(config.keychainService || 'meridian-openai');
    cached = { at: now(), key: k, source: k ? 'keychain' : null };
    return cached;
  }

  async function minutesToday() {
    try {
      const day = today();
      return (await fsp.readFile(usageFile, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((u) => u && String(u.at).startsWith(day)).reduce((s, u) => s + (Number(u.seconds) || 0) / 60, 0);
    } catch { return 0; }
  }

  async function status() {
    const k = await key();
    const day = today();
    return { ready: Boolean(k.key), keySource: k.source, limits,
      engines: Object.fromEntries(Object.entries(ENGINES).map(([id, e]) => [id, { label: e.label, voices: e.voices, note: e.note, by: e.by }])),
      today: { calls: calls.day === day ? calls.count : 0, minutes: Math.round(await minutesToday() * 10) / 10 } };
  }

  async function createSession({ engine, voice, draftId, sdp }) {
    if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 20000) throw fail('an SDP offer is required');
    const e = ENGINES[engine];
    if (!e) throw fail('unknown engine');
    const k = await key();
    if (!k.key) throw fail('no OpenAI key yet: add it to the Keychain as meridian-openai', 503);
    const day = today();
    if (calls.day !== day) calls = { day, count: 0 };
    if (calls.count >= limits.dailyCalls) throw fail(`that's ${limits.dailyCalls} calls today, the daily cap`, 429);
    let draft = null;
    if (draftId) draft = await drafts.get(String(draftId)).catch(() => null);
    const session = sessionConfig(engine, { voice, draft, soul: await readSoul().catch(() => '') });
    calls.count += 1;
    if (engine === 'live') {
      const r = await fetchImpl('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${k.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
      });
      const text = await r.text();
      if (!r.ok) throw fail(`OpenAI said ${r.status}: ${text.slice(0, 400)}`, 502);
      const j = JSON.parse(text);
      return { engine, by: e.by, sessionId: j.session?.id || null, sdp: j.transport?.sdp, limits };
    }
    const fd = new FormData();
    fd.set('sdp', sdp);
    fd.set('session', JSON.stringify(session));
    const r = await fetchImpl('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${k.key}` }, body: fd });
    const text = await r.text();
    if (!r.ok) throw fail(`OpenAI said ${r.status}: ${text.slice(0, 400)}`, 502);
    const loc = r.headers.get?.('location') || '';
    return { engine, by: e.by, sessionId: loc.split('/').pop() || null, sdp: text, limits };
  }

  async function logUsage({ engine, seconds, usage, draftId }) {
    const row = { at: new Date(now()).toISOString(), engine: ENGINES[engine] ? engine : 'unknown', seconds: Math.max(0, Math.min(6 * 3600, Number(seconds) || 0)),
      ...(draftId ? { draftId: String(draftId).slice(0, 20) } : {}), ...(usage && typeof usage === 'object' ? { usage: JSON.parse(JSON.stringify(usage).slice(0, 4000)) } : {}) };
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.appendFile(usageFile, JSON.stringify(row) + '\n');
    return row;
  }

  // Called after the daemon's own authorized() check (this Mac or the tailnet).
  async function handle(req, res, url, { jsonBody, sendJson }) {
    const p = url.pathname;
    if (!p.startsWith('/api/voice/')) return false;
    try {
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) throw fail('cross-site request', 403);
      }
      if (p === '/api/voice/status' && req.method === 'GET') return sendJson(res, 200, await status()), true;
      if (p === '/api/voice/session' && req.method === 'POST') return sendJson(res, 201, await createSession(await jsonBody(req, 40000))), true;
      if (p === '/api/voice/usage' && req.method === 'POST') return sendJson(res, 200, { ok: true, row: await logUsage(await jsonBody(req, 20000)) }), true;
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      sendJson(res, e.statusCode || 500, { ok: false, error: String(e.message || e) });
    }
    return true;
  }

  return { status, createSession, logUsage, handle, limits };
}

module.exports = { createVoice, sessionConfig, ENGINES, TOOLS };
