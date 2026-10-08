#!/usr/bin/env node
// Meridian — Owner's command centre daemon. Zero dependencies.
// Solar noon for the whole operation: one glance shows what's live,
// what's moving, and what needs Owner.
//
// Binds 127.0.0.1 plus the Tailscale 100.x address. Never public.

'use strict';

const runtime = require('./runtime');
runtime.installGuards();
const firstRun = require('./first-run');
const CONFIG_FILE = runtime.CONFIG_FILE;
const CONFIG = readConfig(CONFIG_FILE);
if (process.env.MERIDIAN_PORT !== undefined) CONFIG.port = Number(process.env.MERIDIAN_PORT);
firstRun.seedDemo();
const enabled = runtime.connectorEnabled;
const { DATA_DIR, CACHE_DIR, STORAGE_ROOT, JOBS_ENABLED } = runtime;
if (!runtime.portableProfile()) require('./owner-config').warnOwnerConfig(CONFIG, DATA_DIR);
// Only the isolated test preload supplies this seam; normal boot cannot use it.
const sandboxDelegations = runtime.SANDBOX ? runtime.sandboxDelegations : null;

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { execFile, spawn } = require('child_process');
const { createRefresh, createSources } = require('./refresh');
const { execute, workContext } = require('./process-runner');
const { resultStatus, createResultRecorder } = require('./delegation-results');
const { createStore: createProjectsStore } = require('./projects-store');
const { createStore: createLinksStore } = require('./links-store');
const { createStore: createJournalStore } = require('./journal-store');
const { createStore: createTodosStore } = require('./todos-store');

const { saveAttachments, promptFor } = require('./feedback-attachments');
const modelsLib = require('./models');
const localShare = require('./local-share');
const runChanges = require('./run-changes');
const dailyArt = require('./brief-art');
const briefIcon = require('./brief-icon');
const almanac = require('./almanac');
const aiUsageLedger = require('./ai-usage-ledger');
const { fetchArtworkImage } = require('./art-images');
const heartHealth = require('./heart-health').createCollector(CONFIG.heartHealth || {});
const calendarIcs = require('./calendar-ics');
const calendarsLib = require('./calendars-store');
const { createConnect } = require('./connect');
const { createDemo } = require('./demo');
const meetingNudges = require('./meeting-nudges');
const briefLearning = require('./brief-learning');
const fleetPauseLib = require('./fleet-pause');
const githubLib = require('./github');
const { createCapture } = require('./capture');
const draftsLib = require('./drafts');
const { createGrants, bearer } = require('./mcp-grants');
const agentLib = require('./agent');
const { createStash, ID_RE: STASH_ID } = require('./stash');
const { createSummariser } = require('./stash-summary');
const { createStashTools } = require('./stash-tools');
const { createMoney } = require('./money');
const moneyLib = require('./money');
const { createTell } = require('./tell');
const { createVoice } = require('./voice');
const { createRanker } = require('./todo-rank');
const pings = require('./pings');
const { widgetView } = require('./widget');
const { readBrainSummary } = require('./brain-summary');
const { phoneState } = require('./phone-state');

const ROOT = __dirname;
const HOME = os.homedir();
const artRatings = require('./art-ratings').createStore(path.join(DATA_DIR, 'art-ratings.json'), dailyArt.collection);
const FEEDBACK_ATTACHMENT_ROOT = path.join(DATA_DIR, 'feedback-attachments');
const FEEDBACK_BODY_LIMIT = 32 * 1024 * 1024;
const fileQueues = new Map();
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
const projectsStore = createProjectsStore(path.join(DATA_DIR, 'projects.json'));
const linksStore = createLinksStore(path.join(DATA_DIR, 'links.json'), { defaultCategories: CONFIG.links?.categories });
const journalStore = createJournalStore(path.join(DATA_DIR, 'journal.json'), { defaultAreas: CONFIG.journal?.areas });
const todosStore = createTodosStore(path.join(DATA_DIR, 'todos.json'));
const NOTIFY_LOG_FILE = path.join(DATA_DIR, 'notifications.json');

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
  if (!JOBS_ENABLED || !firstRunCommandAvailable(cmd)) return Promise.resolve(null);
  return execute(cmd, args, { timeout: opts.timeout || 8000, cwd: opts.cwd, env: opts.env, maxBuffer: 4 * 1024 * 1024 })
    .then(result => result.stdout.toString(), error => {
      if (!opts.ignoreFailure && !(cmd === 'lsof' && error.code === 'ENOENT')) workContext.getStore()?.errors.push(`${cmd} failed (${error.code || error.signal || 'cancelled'})`);
      return null;
    });
}

function firstRunCommandAvailable(cmd) {
  if (['launchctl', 'plutil', '/usr/bin/security', '/usr/bin/qlmanage', '/usr/bin/swiftc', 'sips', 'open'].includes(cmd) && process.platform !== 'darwin') return false;
  if (cmd.startsWith('/Applications/') && process.platform !== 'darwin') return false;
  return firstRun.executable(cmd);
}

function fetchUrl(url, { timeout = 4000, headers = {}, method = 'GET', body = null, maxBytes = 512 * 1024 } = {}) {
  if (!JOBS_ENABLED) return Promise.resolve({ status: 0, ms: 0, body: '' });
  return new Promise((resolve) => {
    const started = Date.now();
    let req, timer;
    const finish = (status = 0, body = '', location) => { clearTimeout(timer); resolve({ status, ms: Date.now() - started, body, location }); };
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) { finish(); return; }
      const mod = u.protocol === 'https:' ? https : http;
      req = mod.request(u, { method, headers, timeout }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); res.destroy(); finish(); } else chunks.push(c);
        });
        res.on('end', () => finish(res.statusCode, Buffer.concat(chunks).toString('utf8'), res.headers.location));
        res.on('error', () => finish());
        res.on('aborted', () => finish());
      });
      req.on('error', () => finish());
      const abort = () => { req.destroy(); finish(); };
      req.on('timeout', abort);
      timer = setTimeout(abort, timeout);
      if (body) req.write(body);
      req.end();
    } catch { if (req) req.destroy(); finish(); }
  });
}

// Same as fetchUrl but keeps the bytes. Used for favicons, which are images
// and are often on the tailnet, where a public favicon service cannot reach.
function fetchBinary(url, { timeout = 5000, redirects = 3 } = {}) {
  if (!JOBS_ENABLED) return Promise.resolve(null);
  return new Promise((resolve) => {
    let mod;
    try {
      const protocol = new URL(url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') { resolve(null); return; }
      mod = protocol === 'https:' ? https : http;
    } catch { resolve(null); return; }
    const req = mod.request(url, { timeout, headers: { 'User-Agent': 'Meridian/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { resolve(null); return; }
        resolve(fetchBinary(next, { timeout, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 512 * 1024) chunks.push(c); });
      res.on('end', () => resolve({ type: String(res.headers['content-type'] || '').split(';')[0], buffer: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function ago(ts) { return Date.now() - ts; }

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------- board

async function collectBoard() {
  if (runtime.portableProfile() && !enabled('board')) return { cards: [] };
  const dir = CONFIG.board.dir;
  const out = [];
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return { cards: [], error: 'board dir unreadable' }; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let text;
    try { text = await fsp.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = {};
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    out.push({
      id: fm.id || f.replace(/\.md$/, ''),
      title: fm.title || f,
      status: fm.status || 'unknown',
      needsYou: fm.needsYou === 'true',
      agentReady: fm.agentReady === 'true',
      updated: fm.updated || fm.created || null,
      link: fm.link || null,
      file: f,
    });
  }
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return { cards: out };
}

// A deliberately small, fixed catalogue of preference sources. This is kept
// separate from the general filesystem and repo collectors so the preference
// view never becomes an arbitrary file-reading endpoint.
const PREFERENCE_SOURCES = (CONFIG.preferences?.sources || []).map(source => ({
  ...source,
  path: source.path.startsWith('~/') ? path.join(HOME, source.path.slice(2)) : path.resolve(ROOT, source.path),
}));

function extractPreferenceSections(text, headings) {
  const wanted = new Set(headings);
  const sections = [];
  let current = null;
  let inFence = false;
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = raw.match(/^#{1,3}\s+(.+?)\s*#*$/);
    if (heading) {
      current = wanted.has(heading[1].trim()) ? { heading: heading[1].trim(), sourceLine: index + 1, lines: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current || !raw.trim()) continue;
    if (inFence || /^\s*\|/.test(raw) || /^\s*---+\s*$/.test(raw)) continue;
    const line = raw.trim();
    // Avoid accidentally rendering token-like blobs while preserving prose of
    // any length from the explicitly approved sections.
    if (/^[A-Za-z0-9+/_=-]{80,}$/.test(line)) continue;
    current.lines.push(line);
  }
  return sections.filter((section) => section.lines.length);
}

async function collectPreferences() {
  if (runtime.portableProfile() && !enabled('preferences')) return { sources: [], generatedAt: new Date().toISOString() };
  const sources = [];
  for (const source of PREFERENCE_SOURCES) {
    try {
      const text = await fsp.readFile(source.path, 'utf8');
      const sections = extractPreferenceSections(text, source.headings);
      if (sections.length) sources.push({ path: source.path, scope: source.scope, label: source.label, sections });
    } catch {
      // A missing optional project source should not make the view fail.
    }
  }
  return { sources, generatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- AI ops

function decodeProjectDir(name) {
  // -Users-example-Projects-atlas-board -> best-effort path tail
  return name.replace(/^-Users-example-?/, '').replace(/-/g, '/') || 'home';
}

// Where a Claude session ran: the first line that names its working folder.
async function headCwd(file) {
  try {
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    const m = buf.toString('utf8', 0, bytesRead).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } catch { return null; }
}

async function tailSummary(file) {
  // Cheap read of the last chunk of a Claude session jsonl, looking for a summary line.
  try {
    const st = await fsp.stat(file);
    const size = st.size;
    const len = Math.min(size, 64 * 1024);
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    await fh.close();
    const text = buf.toString('utf8');
    const matches = [...text.matchAll(/"type":"summary","summary":"((?:[^"\\]|\\.)*)"/g)];
    if (matches.length) return JSON.parse('"' + matches[matches.length - 1][1] + '"');
  } catch { /* fine */ }
  return null;
}

async function headPrompt(file) {
  // First real user prompt of a Claude session. Parsed line by line rather
  // than regexed, so injected skill listings and tool results do not win.
  try {
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.startsWith('{') || !line.includes('"user"')) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.type !== 'user' || parsed.isMeta || !parsed.message) continue;
      const content = parsed.message.content;
      if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) continue;
      const raw = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : '';
      const text = cleanPromptText(raw);
      if (text) return text;
    }
  } catch { /* fine */ }
  return null;
}

// First real instruction of a Codex rollout. Same job as headPrompt, but the
// rollout format wraps the text in an event_msg payload.
async function codexPrompt(file) {
  try {
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line || !line.includes('"user_message"')) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const text = cleanPromptText(parsed.payload && parsed.payload.message);
      if (text) return text;
    }
  } catch { /* fine */ }
  return null;
}

// Strip the machinery around a prompt so what is left is what Owner typed.
function cleanPromptText(value) {
  const text = String(value || '')
    .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, ' ')
    .replace(/\[Image:[^\]]*\]/g, ' ')
    .replace(/\[Attached image[^\]]*\]/g, ' ')
    .replace(/\b[A-Za-z0-9_#-]{40,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 10) return null;
  if (/^(caveat:|automation:|environment_context|#|agents\.md|base directory for this skill)/i.test(text)) return null;
  if (/use this skill|system-reminder|<command-name>|task-notification|reply with exactly/i.test(text)) return null;
  if (/^[-*\u2022]\s/.test(text)) return null; // a bulleted block is almost always injected context, not an ask
  if (!/[a-z]/.test(text) || /^[A-Za-z0-9_#+/=-]{24,}$/.test(text.split(' ')[0] || '')) return null;
  if (/^(continue|ok|yes|no|go|do it|thanks|thank you)\b/i.test(text) && text.length < 40) return null;
  return text.slice(0, 300);
}

// The agent's closing message: the nearest thing to "what got done". Read from
// the tail so a long session costs the same as a short one.
async function lastOutcome(file, tool) {
  try {
    const st = await fsp.stat(file);
    const len = Math.min(st.size, 220 * 1024);
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    await fh.close();
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.startsWith('{')) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      let text = null;
      if (tool === 'claude' && parsed.type === 'assistant' && parsed.message) {
        const content = parsed.message.content;
        text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : content;
      } else if (tool === 'codex' && parsed.payload && parsed.payload.type === 'agent_message') {
        text = parsed.payload.message;
      }
      if (!text) continue;
      const clean = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length <= 60) continue;
      // Refusals, clarifying questions and meta-chatter describe no work done.
      if (/^(this appears to be|i won'?t|i can'?t|i cannot|i'?m not able|there is no |there'?s no |i don'?t see|which |what |do you want|shall i|would you like)/i.test(clean)) continue;
      // An opener is what a running session ends on; it is not an outcome.
      if (/^(i'?ll |let me |i'?m going to |i am going to |starting |first,? |now (i'?ll|let)|next,? i)/i.test(clean)) continue;
      if (/prompt injection/i.test(clean)) continue;
      return clean.slice(0, 400);
    }
  } catch { /* fine */ }
  return null;
}

async function collectAI() {
  if (runtime.portableProfile() && !enabled('ai')) return { sessions: [], liveCount: 0, todayCount: 0 };
  const sessions = [];
  const cutoff = Date.now() - 48 * 3600 * 1000;

  // Claude Code
  const claudeRoot = path.join(HOME, '.claude', 'projects');
  let dirs = [];
  try { dirs = await fsp.readdir(claudeRoot); } catch { /* fine */ }
  for (const d of dirs) {
    let files = [];
    try { files = await fsp.readdir(path.join(claudeRoot, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(claudeRoot, d, f);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      sessions.push({
        tool: 'claude',
        project: decodeProjectDir(d),
        last: st.mtimeMs,
        started: Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs),
        live: ago(st.mtimeMs) < 3 * 60 * 1000,
        file: full,
        id: f.replace(/\.jsonl$/, ''),
        summary: null,
      });
    }
  }

  // Codex
  const now = new Date();
  for (let back = 0; back < 2; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    const dir = path.join(HOME, '.codex', 'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'));
    let files = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      let project = 'codex', cwd = null;
      try {
        const fh = await fsp.open(full, 'r');
        const buf = Buffer.alloc(4096);
        await fh.read(buf, 0, 4096, 0);
        await fh.close();
        const m = buf.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) {
          cwd = JSON.parse('"' + m[1] + '"');
          project = cwd.replace(HOME + '/', '').replace(HOME, 'home');
          if (project.includes('command-centre/meridian/delegations/')) project = 'Meridian delegation';
        }
      } catch { /* fine */ }
      sessions.push({
        tool: 'codex', project, cwd, id: (f.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [null])[0], last: st.mtimeMs,
        started: Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs),
        live: ago(st.mtimeMs) < 3 * 60 * 1000, file: full, summary: null,
      });
    }
  }

  sessions.sort((a, b) => b.last - a.last);
  const top = sessions.slice(0, 24);
  await Promise.all(top.filter((s) => s.tool === 'claude').slice(0, 15)
    .map(async (s) => {
      s.summary = await tailSummary(s.file);
      s.prompt = await headPrompt(s.file);
      s.cwd = await headCwd(s.file);
      s.did = await lastOutcome(s.file, 'claude');
    }));
  await Promise.all(top.filter((s) => s.tool === 'codex').slice(0, 12)
    .map(async (s) => {
      s.prompt = await codexPrompt(s.file);
      s.did = await lastOutcome(s.file, 'codex');
    }));
  for (const s of top) delete s.file;
  return {
    sessions: top,
    liveCount: sessions.filter((s) => s.live).length,
    todayCount: sessions.filter((s) => s.last >= startOfToday()).length,
  };
}

// ---------------------------------------------------------------- fleet

const latencyHistory = new Map(); // name -> [ms,...]
const probeStates = new Map(); // name -> confirmed state and consecutive checks

async function probeTarget(t) {
  const r = await fetchUrl(t.url, { timeout: 5000 });
  const rawUp = r.status >= 200 && r.status < 500 && r.status !== 0;
  const previous = probeStates.get(t.name) || { confirmedUp: rawUp, failures: 0, successes: 0 };
  if (rawUp) { previous.successes += 1; previous.failures = 0; }
  else { previous.failures += 1; previous.successes = 0; }
  if (previous.confirmedUp && previous.failures >= 2) previous.confirmedUp = false;
  if (!previous.confirmedUp && previous.successes >= 2) previous.confirmedUp = true;
  probeStates.set(t.name, previous);
  const up = previous.confirmedUp;
  const hist = latencyHistory.get(t.name) || [];
  hist.push(rawUp ? r.ms : -1);
  while (hist.length > 48) hist.shift();
  latencyHistory.set(t.name, hist);
  return { ...t, up, rawUp, ms: r.ms, status: r.status, history: hist.slice() };
}

// "Sites and services" with pause (fleet-pause.js). A paused item is not
// probed and carries up:true, so every `!x.up` down count (brief, command
// centre, classic dashboard, nightly ledger) skips it; `paused` tells the
// UI to show it as paused rather than up.
const fleetPause = fleetPauseLib.createFleetPause({
  uid: process.getuid(),
  agentsDir: path.join(HOME, 'Library', 'LaunchAgents'),
  auditRoot: path.join(STORAGE_ROOT, 'audit'),
  file: path.join(DATA_DIR, 'fleet-paused.json'),
  selfPort: CONFIG.port || 4980,
});

function fleetEntry(name) {
  const services = CONFIG.fleet.services || []; const sites = CONFIG.fleet.sites || [];
  return services.find((t) => t.name === name) || sites.find((t) => t.name === name) || null;
}

async function collectFleet() {
  if (runtime.portableProfile() && !enabled('fleet')) return { services: [], sites: [], agents: [] };
  const out = await run('launchctl', ['list']);
  const servicesCfg = CONFIG.fleet.services || []; const sitesCfg = CONFIG.fleet.sites || [];
  const info = await fleetPause.annotate({ services: servicesCfg, sites: sitesCfg, launchctlList: out || '' })
    .catch((e) => { console.error('fleet pause annotate failed:', e && e.message || e); return new Map(); });
  const item = (kind) => async (t) => {
    const i = info.get(t.name) || { kind, label: null, pausable: true, paused: false, pauseMode: 'probe', matchedBy: null };
    const meta = { kind: i.kind, label: i.label, pausable: i.pausable, paused: i.paused, pauseMode: i.pauseMode, matchedBy: i.matchedBy };
    if (i.paused) return { ...t, ...meta, up: true, rawUp: null, ms: null, status: null, history: [] };
    return { ...(await probeTarget(t)), ...meta };
  };
  const [services, sites] = await Promise.all([
    Promise.all(servicesCfg.map(item('service'))),
    Promise.all(sitesCfg.map(item('site'))),
  ]);
  // launchd agents
  const agents = [];
  if (out) {
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\t(\S+)\t((?:uk|com)\.example\.[\w.-]+)$/);
      if (m) agents.push({ label: m[3], pid: m[1] === '-' ? null : Number(m[1]), exitStatus: Number(m[2]) });
    }
  }
  const paused = [...services, ...sites].filter((x) => x.paused).length;
  const down = [...services, ...sites].filter((x) => !x.paused && !x.up).length;
  return { services, sites, agents, paused, down };
}

// ---------------------------------------------------------------- git

let repoCache = { at: 0, repos: [] };

async function discoverRepos() {
  const roots = CONFIG.git.roots.map((r) => r.replace('~', HOME));
  const found = new Set();
  for (const root of roots) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    if (fs.existsSync(path.join(root, '.git'))) found.add(root);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(root, e.name);
      if (fs.existsSync(path.join(p, '.git'))) { found.add(p); continue; }
      // one level deeper
      let subs = [];
      try { subs = await fsp.readdir(p, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (!s.isDirectory() || s.name.startsWith('.') || s.name === 'node_modules') continue;
        const sp = path.join(p, s.name);
        if (fs.existsSync(path.join(sp, '.git'))) found.add(sp);
      }
    }
  }
  return [...found];
}

async function repoInfo(repo) {
  const [branch, porcelain, log, track] = await Promise.all([
    run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']),
    run('git', ['-C', repo, 'status', '--porcelain']),
    run('git', ['-C', repo, 'log', '-1', '--format=%s%x1f%ct']),
    run('git', ['-C', repo, 'rev-list', '--left-right', '--count', '@{u}...HEAD'], { ignoreFailure: true }),
  ]);
  if (branch === null) return null;
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  let subject = null; let commitTs = 0;
  if (log) { const [s, ct] = log.trim().split('\x1f'); subject = s; commitTs = Number(ct) * 1000; }
  let behind = null; let ahead = null;
  if (track) { const [b, a] = track.trim().split(/\s+/).map(Number); behind = b; ahead = a; }
  return {
    path: repo,
    name: repo.replace(HOME + '/', ''),
    branch: (branch || '').trim(),
    dirty, subject, commitTs, ahead, behind,
  };
}

async function collectGit(force = false) {
  if (runtime.portableProfile() && !enabled('git')) return { repos: [] };
  if (!force && Date.now() - repoCache.at < 4 * 60 * 1000) return repoCache;
  const repos = await discoverRepos();
  const infos = (await Promise.all(repos.map(repoInfo))).filter(Boolean);
  infos.sort((a, b) => (b.dirty > 0 ? 1 : 0) - (a.dirty > 0 ? 1 : 0) || b.commitTs - a.commitTs);
  repoCache = { at: Date.now(), repos: infos };
  return repoCache;
}

// ---------------------------------------------------------------- brain

let brainCache = { at: 0, data: null };
let brainIndexCache = { mtimeMs: 0, nodes: [], byId: new Map() };

async function loadBrainIndex() {
  if (runtime.portableProfile() && !enabled('brain')) return { byId: new Map(), nodes: [] };
  const stat = await fsp.stat(CONFIG.brain.graphPath);
  if (brainIndexCache.nodes.length && brainIndexCache.mtimeMs === stat.mtimeMs) return brainIndexCache;
  const graph = JSON.parse(await fsp.readFile(CONFIG.brain.graphPath, 'utf8'));
  const nodes = (graph.nodes || []).filter((node) => node.kind === 'file').map((node) => ({
    id: String(node.id || ''),
    name: String(node.name || path.basename(String(node.id || ''))),
    realm: String(node.realm || 'LifeOS'),
    kind: String(node.kind || 'file'),
    ext: String(node.ext || '').toLowerCase(),
    mt: Number(node.mt || 0),
    url: typeof node.url === 'string' ? node.url : null,
    preview: typeof node.md === 'string' ? node.md : null,
  }));
  brainIndexCache = { mtimeMs: stat.mtimeMs, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
  return brainIndexCache;
}

function scoreBrainNode(node, terms, query) {
  const name = node.name.toLowerCase();
  const id = node.id.toLowerCase();
  const realm = node.realm.toLowerCase();
  let score = 0;
  if (name === query) score += 100;
  if (name.startsWith(query)) score += 55;
  if (name.includes(query)) score += 34;
  for (const term of terms) {
    if (name.startsWith(term)) score += 18;
    else if (name.includes(term)) score += 12;
    if (id.includes(term)) score += 6;
    if (realm.includes(term)) score += 3;
  }
  return score;
}

async function searchBrain(query, realm, kind, limit) {
  const index = await loadBrainIndex();
  const q = String(query || '').trim().toLowerCase().slice(0, 160);
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index.nodes
    .filter((node) => (!realm || node.realm === realm) && (!kind || node.ext === kind || node.kind === kind))
    .map((node) => ({ node, score: scoreBrainNode(node, terms, q) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
    .slice(0, limit)
    .map(({ node }) => ({ id: node.id, name: node.name, realm: node.realm, kind: node.kind, ext: node.ext, mt: node.mt, url: node.url }));
}

async function collectBrain() {
  if (runtime.portableProfile() && !enabled('brain')) return {};
  if (brainCache.data && Date.now() - brainCache.at < 10 * 60 * 1000) return brainCache.data;
  try {
    const data = await readBrainSummary(CONFIG.brain.graphPath, { signal: workContext.getStore()?.signal });
    brainCache = { at: Date.now(), data };
  } catch {
    brainCache = { at: Date.now(), data: { nodes: 0, links: 0, realms: [], error: 'graph unreadable' } };
  }
  return brainCache.data;
}

// ---------------------------------------------------------------- threads

async function collectThreads() {
  if (runtime.portableProfile() && !enabled('threads')) return { tasks: [] };
  let token = null;
  try {
    token = JSON.parse(fs.readFileSync(CONFIG.threads.configPath, 'utf8')).token || null;
  } catch { /* fine */ }
  const headers = token ? { Authorization: 'Bearer ' + token, 'X-Auth-Token': token } : {};
  const r = await fetchUrl(CONFIG.threads.url + '/api/tasks', { headers, timeout: 3000 });
  if (r.status !== 200) return { up: false, tasks: [] };
  try {
    const parsed = JSON.parse(r.body);
    const tasks = Array.isArray(parsed) ? parsed : parsed.tasks || [];
    return { up: true, tasks: tasks.slice(0, 40) };
  } catch { return { up: true, tasks: [] }; }
}

// ---------------------------------------------------------------- brief feedback

const BRIEF_FEEDBACK_FILE = path.join(DATA_DIR, 'brief-feedback.json');
const BRIEF_INTAKE_FILE = path.join(DATA_DIR, 'brief-intake.json');

const INTAKE_STATUSES = new Set(['new', 'queued', 'rejected', 'snoozed', 'delegated', 'done']);
const INTAKE_SOURCES = new Set(['outlook', 'slack']);

function normaliseBriefIntakeItem(input) {
  const id = String(input && input.id || '').trim().slice(0, 500);
  const source = String(input && input.source || '').trim().toLowerCase();
  if (!id || !INTAKE_SOURCES.has(source)) return null;
  const priority = ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal';
  const status = INTAKE_STATUSES.has(input.status) ? input.status : 'new';
  return {
    id,
    source,
    title: String(input.title || 'Untitled incoming work').trim().slice(0, 180),
    summary: String(input.summary || input.request || '').trim().slice(0, 4000),
    request: String(input.request || input.summary || '').trim().slice(0, 4000),
    from: String(input.from || input.sender || '').trim().slice(0, 180),
    fromEmail: (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.fromEmail || '').trim()) ? String(input.fromEmail).trim().toLowerCase().slice(0, 254) : null),
    avatarUrl: String(input.avatarUrl || input.avatar || '').trim().slice(0, 2000) || null,
    receivedAt: input.receivedAt || input.createdAt || null,
    url: String(input.url || input.webLink || '').trim().slice(0, 2000) || null,
    priority,
    confidence: String(input.confidence || 'medium').trim().slice(0, 30),
    actionable: input.actionable !== false,
    status,
    projectId: String(input.projectId || '').trim() || null,
    queuedAt: input.queuedAt || null,
    // Set by the Daily brief automation when it sees Owner replied (feeds
    // brief-learning.json). Never cleared here.
    respondedAt: input.respondedAt || null,
  };
}

// The automations also write `invites` and `meetings` (Outlook invitations
// and online meetings, see meeting-nudges.js) and may add other top-level
// keys. Meridian rewrites this file when it queues items, so everything it
// does not own is carried through untouched.
const INTAKE_OWN_KEYS = new Set(['version', 'updatedAt', 'window', 'items', 'invites', 'meetings']);

async function readBriefIntake() {
  try {
    const saved = JSON.parse(await fsp.readFile(BRIEF_INTAKE_FILE, 'utf8'));
    const extra = {};
    for (const [k, v] of Object.entries(saved && typeof saved === 'object' ? saved : {})) if (!INTAKE_OWN_KEYS.has(k)) extra[k] = v;
    return {
      version: 1,
      updatedAt: saved.updatedAt || null,
      window: saved.window || null,
      items: Array.isArray(saved.items) ? saved.items.map(normaliseBriefIntakeItem).filter(Boolean).slice(0, 40) : [],
      invites: Array.isArray(saved.invites) ? saved.invites.slice(0, 80) : [],
      meetings: Array.isArray(saved.meetings) ? saved.meetings.slice(0, 80) : [],
      extra,
    };
  } catch {
    return { version: 1, updatedAt: null, window: null, items: [], invites: [], meetings: [], extra: {} };
  }
}

async function writeBriefIntake(data) {
  await fsp.mkdir(path.dirname(BRIEF_INTAKE_FILE), { recursive: true });
  await writeJsonAtomic(BRIEF_INTAKE_FILE, {
    ...(data.extra || {}),
    version: 1,
    updatedAt: data.updatedAt || new Date().toISOString(),
    window: data.window || null,
    items: data.items.map(normaliseBriefIntakeItem).filter(Boolean).slice(0, 40),
    invites: Array.isArray(data.invites) ? data.invites : [],
    meetings: Array.isArray(data.meetings) ? data.meetings : [],
  });
}

async function collectBriefIntake() {
  const intake = await readBriefIntake();
  return {
    updatedAt: intake.updatedAt,
    window: intake.window,
    items: intake.items,
    pending: intake.items.filter((item) => item.actionable && ['new', 'queued', 'delegated'].includes(item.status)).length,
  };
}

function intakeProjectNote(item) {
  const source = item.source === 'outlook' ? 'Outlook email' : 'Slack message';
  const sender = item.from ? ` from ${item.from}` : '';
  const received = item.receivedAt ? `\nReceived: ${item.receivedAt}` : '';
  return `${source}${sender}.${received}\n\n${item.request || item.summary || 'No request text was supplied.'}`;
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'request';
}

function syncBriefIntake() {
  return queueFile(BRIEF_INTAKE_FILE, async () => {
    const intake = await readBriefIntake();
    const existing = await projectsStore.read();
    const bySource = new Map(existing.projects
      .filter((project) => project.source && project.sourceId)
      .map((project) => [`${project.source}:${project.sourceId}`, project]));
    const changes = new Map();

    for (const item of intake.items) {
      if (!item.actionable || !['new', 'queued'].includes(item.status) || item.projectId) continue;
      const key = `${item.source}:${item.id}`;
      let project = bySource.get(key);
      if (!project) {
        project = await projectsStore.create({
          title: item.title,
          note: intakeProjectNote(item),
          status: 'inbox',
          priority: item.priority,
          brief: true,
          delegate: true,
          source: item.source,
          sourceId: item.id,
          sourceUrl: item.url,
          sourceFrom: item.from,
          sourceReceivedAt: item.receivedAt,
        });
        bySource.set(key, project);
      }
      item.projectId = project.id;
      item.status = 'queued';
      item.queuedAt = item.queuedAt || new Date().toISOString();
      changes.set(key, item);
    }

    if (changes.size) {
      const latest = await readBriefIntake();
      for (const item of latest.items) {
        const queued = changes.get(`${item.source}:${item.id}`);
        if (!queued || item.projectId || !item.actionable || !['new', 'queued'].includes(item.status)) continue;
        item.projectId = queued.projectId; item.status = 'queued'; item.queuedAt = queued.queuedAt;
      }
      await writeBriefIntake(latest);
    }
    return { intake: await collectBriefIntake(), projects: await projectsStore.read() };
  });
}

function markBriefIntakeDelegated(projectId) {
  return queueFile(BRIEF_INTAKE_FILE, async () => {
    const intake = await readBriefIntake();
    let changed = false;
    for (const item of intake.items) {
      if (item.projectId === projectId && item.status === 'queued') {
        item.status = 'delegated';
        changed = true;
      }
    }
    if (changed) await writeBriefIntake(intake);
  });
}

async function collectBriefFeedback() {
  try {
    const saved = JSON.parse(await fsp.readFile(BRIEF_FEEDBACK_FILE, 'utf8'));
    return {
      completed: Array.isArray(saved.completed) ? saved.completed : [],
      rejected: Array.isArray(saved.rejected) ? saved.rejected : [],
      skipped: saved.skipped && typeof saved.skipped === 'object' ? saved.skipped : {},
    };
  } catch {
    return { completed: [], rejected: [], skipped: {} };
  }
}

function saveBriefFeedback(id, action) {
  return queueFile(BRIEF_FEEDBACK_FILE, async () => {
    const feedback = await collectBriefFeedback();
    const today = new Date().toISOString().slice(0, 10);
    if (action === 'complete' && !feedback.completed.includes(id)) feedback.completed.push(id);
    if (action === 'reject' && !feedback.rejected.includes(id)) feedback.rejected.push(id);
    if (action === 'skip') {
      const skipped = Array.isArray(feedback.skipped[today]) ? feedback.skipped[today] : [];
      if (!skipped.includes(id)) skipped.push(id);
      feedback.skipped = { [today]: skipped };
    }
    await fsp.mkdir(path.dirname(BRIEF_FEEDBACK_FILE), { recursive: true });
    await writeJsonAtomic(BRIEF_FEEDBACK_FILE, feedback);
    return feedback;
  });
}

// ---------------------------------------------------------------- ExampleApp feedback

// A separate runner grades feedback left in the ExampleApp app and writes a
// state file. Meridian only reads that file and forwards Owner's choices to the
// runner's CLI. Everything in the file is treated as untrusted.
const JSF_VISIBLE = new Set(['ready', 'graded', 'needs-you', 'failed']);
const JSF_WORKING = new Set(['queued', 'working', 'revising']);
const JSF_STATUSES = new Set([...JSF_VISIBLE, ...JSF_WORKING, 'merged', 'dropped']);
const JSF_ACTIONS = new Set(['test', 'merge', 'revise', 'build', 'drop', 'dismiss', 'run']);
const JSF_NOTE_ACTIONS = new Set(['revise', 'build', 'drop']);
const JSF_EMPTY = { items: [], working: 0, lastRun: null, updatedAt: null };
const jsfPending = new Set();

function jsfConfig() {
  const cfg = CONFIG.exampleappFeedback || {};
  return {
    stateFile: cfg.stateFile || '',
    cli: cfg.cli || '',
    node: cfg.node || process.execPath,
  };
}

function jsfText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : null;
}

function jsfIso(value) {
  const text = jsfText(value, 60);
  const ms = text ? Date.parse(text) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// GitHub links must point at github.com. Preview links only need https.
function jsfUrl(value, githubOnly = true) {
  const text = jsfText(value, 800);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (githubOnly && (url.hostname !== 'github.com' || !text.startsWith('https://github.com/'))) return null;
    return url.href;
  } catch { return null; }
}

function jsfItem(raw) {
  const issue = raw.issue;
  if (!Number.isInteger(issue) || issue <= 0) return null;
  if (!JSF_STATUSES.has(raw.status)) return null;
  const prNumber = raw.pr && typeof raw.pr === 'object' ? raw.pr.number : null;
  return {
    issue,
    issueUrl: jsfUrl(raw.issueUrl),
    title: jsfText(raw.title, 200) || `Feedback #${issue}`,
    message: jsfText(raw.message, 8000) || '',
    from: jsfText(raw.from, 120),
    view: raw.view === 'agency' || raw.view === 'client' ? raw.view : null,
    page: jsfText(raw.page, 300),
    receivedAt: jsfIso(raw.receivedAt),
    status: raw.status,
    stars: Number.isInteger(raw.stars) && raw.stars >= 1 && raw.stars <= 5 ? raw.stars : null,
    verdict: ['build', 'grade-only', 'needs-human'].includes(raw.verdict) ? raw.verdict : null,
    summary: jsfText(raw.summary, 2000),
    reasoning: jsfText(raw.reasoning, 2000),
    change: jsfText(raw.change, 2000),
    pr: Number.isInteger(prNumber) && prNumber > 0
      ? { number: prNumber, url: jsfUrl(raw.pr.url), branch: jsfText(raw.pr.branch, 200) }
      : null,
    checks: raw.checks === 'passed' || raw.checks === 'failed' ? raw.checks : null,
    model: jsfText(raw.model, 80),
    ranAt: jsfIso(raw.ranAt),
    seenAt: jsfIso(raw.seenAt),
    error: jsfText(raw.error, 1000),
  };
}

// Cheap: one local file read, no network. A missing file means no items.
// A malformed file throws, so the collector keeps its last good value.
async function collectExampleappFeedback() {
  if (runtime.portableProfile() && !enabled('exampleappFeedback')) return { ...JSF_EMPTY };
  let text;
  try {
    text = await fsp.readFile(jsfConfig().stateFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ...JSF_EMPTY };
    throw e;
  }
  if (text.length > 5 * 1024 * 1024) throw new Error('ExampleApp state file is too large');
  const data = JSON.parse(text);
  const seenIssues = new Set();
  const rows = [];
  for (const raw of (Array.isArray(data && data.items) ? data.items : []).slice(0, 1000)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = jsfItem(raw);
    if (!item || seenIssues.has(item.issue)) continue;
    seenIssues.add(item.issue);
    rows.push({ item, seen: Boolean(raw.seenAt) });
  }
  const items = rows
    .filter((row) => !row.seen && JSF_VISIBLE.has(row.item.status))
    .map((row) => row.item)
    .sort((a, b) => (b.stars || 0) - (a.stars || 0) || String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .slice(0, 50);
  const run = data && data.lastRun && typeof data.lastRun === 'object' ? data.lastRun : null;
  return {
    items,
    working: rows.filter((row) => JSF_WORKING.has(row.item.status)).length,
    lastRun: run ? {
      startedAt: jsfIso(run.startedAt),
      finishedAt: jsfIso(run.finishedAt),
      processed: Number.isInteger(run.processed) && run.processed >= 0 ? run.processed : null,
      error: jsfText(run.error, 1000),
    } : null,
    updatedAt: jsfIso(data && data.updatedAt),
  };
}

// Calls the runner's CLI with an args array (never a shell string) and
// resolves with its one-line JSON answer, or an { ok: false } explanation.
function runExampleappCli(action, issue, note) {
  const { cli, node } = jsfConfig();
  if (!fs.existsSync(cli)) return Promise.resolve({ ok: false, error: `The ExampleApp runner CLI was not found at ${cli}` });
  const args = [cli, action];
  if (action !== 'run') args.push(String(issue));
  if (note) args.push('--note', note);
  args.push('--json');
  return new Promise((resolve) => {
    execFile(node, args, { timeout: 60000, maxBuffer: 1024 * 1024, cwd: path.dirname(cli) }, (err, stdout, stderr) => {
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      let answer = null;
      try { answer = JSON.parse(lines[lines.length - 1] || ''); } catch { /* not JSON */ }
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
        if (err || answer.ok !== true) {
          resolve({ ...answer, ok: false, error: jsfText(answer.error, 1000) || 'The ExampleApp runner reported a failure.' });
        } else {
          resolve(answer);
        }
        return;
      }
      const detail = jsfText(String(stderr || '').trim().split(/\r?\n/).pop(), 300);
      if (err && err.killed) resolve({ ok: false, error: 'The ExampleApp runner did not answer within 60 seconds.' });
      else resolve({ ok: false, error: detail ? `The ExampleApp runner failed: ${detail}` : 'The ExampleApp runner gave no answer.' });
    });
  });
}

// ---------------------------------------------------------------- calendar

let calCache = { at: 0, events: [], configured: false };
let calendarVersion = 0;
// Up next reads the first CAL_LIMIT events from 6 h ago to windowDays ahead.
// Was 40 for two feeds; classes and added calendars need more room (the
// daily WIP alone is 8 a week).
const CAL_LIMIT = 80;

// Parsing lives in calendar-ics.js: join links, Owner's response, organiser,
// recurring series. His addresses: the work account plus the owner of any
// Google "secret address" feed (his PARTSTAT there is on the Gmail address).
const WORK_EMAIL = (CONFIG.calendar && CONFIG.calendar.workEmail) ?? '';
function selfEmails() {
  const extra = Array.isArray(CONFIG.calendar && CONFIG.calendar.selfEmails) ? CONFIG.calendar.selfEmails : [];
  return [...new Set([WORK_EMAIL, ...extra, ...calendars.urls().map((u) => calendarIcs.ownerFromFeedUrl(u)).filter(Boolean)].filter(Boolean).map((e) => String(e).toLowerCase()))];
}

function parseIcsFeed(text, label) {
  return calendarIcs.parseIcsFeed(text, label, { now: Date.now(), windowDays: (CONFIG.calendar && CONFIG.calendar.windowDays) || 7, selfEmails: selfEmails() });
}

function calendarFeeds() {
  // Accepts a single icsUrl, an icsUrls array of strings, or
  // { url, label } entries. A bare string used to get no label at all (or
  // "cal1"); calendars-store.js now names it from its host.
  const cal = CONFIG.calendar || {};
  return [cal.icsUrl, ...(cal.icsUrls || [])].filter(Boolean).map((f) => typeof f === 'string' ? { url: f, label: null } : f);
}

// Feeds from config.json (read-only) and data/calendars.json (added on the
// Connect page), plus the class timetable (calendars-store.js). Every event
// carries `calendar` and `color`; `cal` is kept for the page and nudges.
const calendars = calendarsLib.createCalendars({ file: path.join(DATA_DIR, 'calendars.json'), configFeeds: calendarFeeds });
calendars.load().catch((e) => console.error('calendars: load failed', e.message));

async function collectCalendar() {
  if (runtime.portableProfile() && !enabled('calendar')) return { events: [], configured: false, calendars: [] };
  if (calCache.at && Date.now() - calCache.at < ((CONFIG.calendar && CONFIG.calendar.refreshMinutes) || 10) * 60 * 1000) return calCache;
  const now = Date.now(), version = calendarVersion;
  const got = await calendars.collect({ parse: parseIcsFeed, from: now - 6 * 3600 * 1000, to: now + ((CONFIG.calendar && CONFIG.calendar.windowDays) || 7) * 86400000 });
  if (!got.configured) return { configured: false, events: [], calendars: [] };
  got.events.sort((a, b) => a.ts - b.ts);
  calCache = { at: version === calendarVersion ? Date.now() : 0, configured: true, events: got.events.slice(0, CAL_LIMIT), calendars: got.calendars };
  return calCache;
}

// After a calendar change: fetch again and push the new state straight away.
async function refreshCalendarNow() {
  calendarVersion++;
  calCache.at = 0;
  connectInfo.bust();
  if (runtime.portableProfile()) {
    runtime.updateConnectors(firstRun.connectorStatus(CONFIG));
    syncPortableJobs();
  }
  await refreshState();
}

// ---------------------------------------------------------------- Campaign Snapshot

let campaignSnapshotCache = { at: 0, data: null };

function toCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function normaliseSmokingDay(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.day || ''))) return null;
  const count = toCount(day.count);
  const fullJourney = toCount(day.fullJourney);
  const afterReactions = toCount(day.afterReactions);
  const atSnapshot = toCount(day.atSnapshot);
  if ([count, fullJourney, afterReactions, atSnapshot].some((n) => n === null)) return null;
  return {
    day: String(day.day), count, fullJourney, afterReactions, atSnapshot,
  };
}

function normaliseReactionAnswer(answer) {
  if (!answer || !answer.key || !answer.question || !Array.isArray(answer.items)) return null;
  const items = answer.items.map((item) => ({
    label: String(item.label || ''), count: toCount(item.count),
  })).filter((item) => item.label && item.count !== null);
  if (!items.length) return null;
  return { key: String(answer.key), question: String(answer.question), items };
}

function normaliseReactionDay(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.day || ''))) return null;
  const mappings = [
    ['surprised', 'surprisedYes', 'surprisedAnswered'],
    ['rethink', 'rethinkYes', 'rethinkAnswered'],
    ['next_cigarette', 'nextCigaretteYes', 'nextCigaretteAnswered'],
  ];
  const answers = {};
  for (const [key, yesField, answeredField] of mappings) {
    const yes = toCount(day[yesField]);
    const answered = toCount(day[answeredField]);
    if (yes !== null && answered !== null && answered >= yes) answers[key] = { yes, answered };
  }
  return { day: String(day.day), answers };
}

async function collectSmokingSnapshot() {
  if (runtime.portableProfile() && !enabled('campaignSnapshot')) return null;
  const cfg = CONFIG.campaignSnapshot || {};
  if (!cfg.dashboardUrl) return { configured: false, stats: null, daily: [] };
  const refreshMs = (Number(cfg.refreshMinutes) || 10) * 60 * 1000;
  if (campaignSnapshotCache.data && Date.now() - campaignSnapshotCache.at < refreshMs) {
    return campaignSnapshotCache.data;
  }

  const result = await fetchUrl(cfg.dashboardUrl, {
    timeout: 8000,
    headers: { Accept: 'application/json' },
  });
  if (result.status !== 200) {
    if (campaignSnapshotCache.data) {
      return { ...campaignSnapshotCache.data, stale: true, error: 'dashboard fetch failed' };
    }
    return { configured: true, stats: null, daily: [], error: 'dashboard fetch failed' };
  }

  try {
    const payload = JSON.parse(result.body);
    const funnel = payload.funnel || {};
    const total = toCount(funnel.capturedSnapshots ?? payload.totalCompletions);
    const full = toCount(funnel.completeProfiles);
    const reactionsOnly = toCount(funnel.reactionsOnly);
    const demographicsStarted = toCount(funnel.demographicsStarted);
    const atSnapshot = toCount(funnel.snapshotOnly);
    if ([total, full, reactionsOnly, demographicsStarted, atSnapshot].some((n) => n === null)) {
      throw new Error('funnel totals missing');
    }
    const afterReactions = reactionsOnly + demographicsStarted;
    if (total !== full + afterReactions + atSnapshot) {
      throw new Error('funnel totals do not reconcile');
    }
    const daily = (Array.isArray(payload.daily) ? payload.daily : [])
      .map(normaliseSmokingDay)
      .filter(Boolean)
      .sort((a, b) => a.day.localeCompare(b.day));
    const reactionAnswers = (Array.isArray(payload.answers) ? payload.answers : [])
      .map(normaliseReactionAnswer).filter(Boolean);
    const reactionDaily = (Array.isArray(payload.usage && payload.usage.days) ? payload.usage.days : [])
      .map(normaliseReactionDay).filter(Boolean).sort((a, b) => a.day.localeCompare(b.day));
    const data = {
      configured: true,
      dashboardUrl: cfg.dashboardPage || cfg.dashboardUrl,
      generatedAt: payload.generatedAt || null,
      scopeLabel: String(payload.scopeLabel || 'All responses'),
      stats: { total, full, afterReactions, atSnapshot },
      daily,
      reactionAnswers,
      reactionDaily,
      latestDay: daily[daily.length - 1] || null,
      stale: false,
    };
    campaignSnapshotCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    if (campaignSnapshotCache.data) {
      return { ...campaignSnapshotCache.data, stale: true, error: error.message };
    }
    return { configured: true, stats: null, daily: [], error: error.message };
  }
}

// ---------------------------------------------------------------- ledger

async function collectLedger() {
  if (runtime.portableProfile() && !enabled('ledger')) return { entries: [], now: '', latest: null };
  const dir = (CONFIG.ledger && CONFIG.ledger.dir) || path.join(STORAGE_ROOT, 'ledger');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return { entries: [], latest: null, now: null }; }
  const entries = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
  let latest = null;
  if (entries.length) {
    try {
      const text = await fsp.readFile(path.join(dir, entries[0]), 'utf8');
      latest = { name: entries[0], date: entries[0].slice(0, 10), excerpt: text.slice(0, 4000) };
    } catch { /* fine */ }
  }
  let now = null;
  try { now = (await fsp.readFile(path.join(dir, 'NOW.md'), 'utf8')).slice(0, 4000); } catch { /* fine */ }
  return {
    entries: entries.slice(0, 14).map((n) => ({ name: n, date: n.slice(0, 10) })),
    latest,
    now,
    schedule: (CONFIG.ledger && CONFIG.ledger.schedule) || null,
  };
}

// ---------------------------------------------------------------- meetings

async function collectMeetings() {
  if (runtime.portableProfile() && !enabled('meetings')) return { items: [] };
  const dir = CONFIG.meetings && CONFIG.meetings.dir;
  if (!dir) return { meetings: [] };
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return { meetings: [] }; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let title = f.replace(/\.md$/, ''); let date = null;
    try {
      const text = await fsp.readFile(path.join(dir, f), 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const t = fm[1].match(/^title:\s*(.+)$/m); if (t) title = t[1].trim();
        const d = fm[1].match(/^date:\s*(.+)$/m); if (d) date = d[1].trim();
      }
      if (!title || title === f.replace(/\.md$/, '')) {
        const h = text.match(/^#\s+(.+)$/m); if (h) title = h[1].trim();
      }
    } catch { continue; }
    if (!date) { const m = f.match(/^(\d{4}-\d{2}-\d{2})/); if (m) date = m[1]; }
    out.push({ file: f, title, date: date || '' });
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { meetings: out.slice(0, 10), total: out.length };
}

// ---------------------------------------------------------------- delegations
// Delegated work from the morning brief. Each run gets a sandbox
// folder under delegations/; the selected model works only in its scoped workspace and leaves REPORT.md.

// The CLI moved between installs; take the first that exists so delegations
// do not fail silently on a stale path.
const CODEX_BIN = [path.join(HOME, '.local', 'bin', 'codex'), path.join(HOME, '.npm-global', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']
  .find((p) => fs.existsSync(p)) || path.join(HOME, '.local', 'bin', 'codex');
const CLAUDE_BIN = path.join(HOME, '.local', 'bin', 'claude');

// The model list lives in data/models.json (models.js), shared with both
// front ends through GET /api/engines. The brief sends { model: id, effort };
// the run is recorded as "Name · Effort". Retired ids (gpt-6-sol) and legacy
// picker labels still resolve, so older clients and saved runs keep working.
// An empty model means the default; an id that is not on the list is refused,
// so a model Meridian has only discovered never reaches a CLI.
const { EFFORTS } = modelsLib;
const modelRegistry = modelsLib.createRegistry({
  file: path.join(DATA_DIR, 'models.json'),
  codexBin: CODEX_BIN,
  scanCache: path.join(CACHE_DIR, 'ai-usage-scan.json'),
});
const resolveEngine = (modelKey, effort) => modelRegistry.resolve(modelKey, effort);
const defaultModelLabel = () => { try { return modelRegistry.resolve('').who; } catch { return 'Default model'; } };
// The September dashboard still picks from plain labels in state.engines.
const engineLabels = () => [...new Set([defaultModelLabel(), ...modelRegistry.current().presets.map((pr) => { try { return resolveEngine(pr.model, pr.effort).who; } catch { return null; } })].filter(Boolean))];

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Dogfood undo: write what a finished feedback run changed (run-changes.js).
// Called from the run's exit hook and, for runs that ended while Meridian was
// restarting, from collectDelegations.
const changesInFlight = new Set();
async function recordRunChanges(id, dir, { announce = false } = {}) {
  if (changesInFlight.has(id) || !runChanges.hasSnapshot(dir)) return null;
  changesInFlight.add(id);
  try {
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch { /* fine */ }
    const record = await runChanges.computeChanges(meta.workdir || ROOT, dir, { extra: meta.concurrent && meta.concurrent.length ? { concurrent: meta.concurrent } : {} });
    if (announce && state.at) { state.delegations = await collectForState('delegations', collectDelegations, state.delegations); broadcast(); }
    return record;
  } catch (error) {
    console.error('run changes failed', id, error.message);
    return null;
  } finally {
    changesInFlight.delete(id);
  }
}

async function undoDelegation(id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('bad delegation id');
  const dir = path.join(STORAGE_ROOT, 'delegations', id);
  const metaPath = path.join(dir, 'meta.json');
  let meta;
  try { meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')); } catch { throw new Error('delegation not found'); }
  if (meta.kind !== 'feedback') throw new Error('only Dogfood fixes can be undone');
  const fail = (message, code = 409, extra = {}) => Object.assign(new Error(message), { statusCode: code, ...extra });
  if (meta.undoneAt) throw fail('this fix has already been undone');
  if (activeDelegations.has(id) || (meta.status === 'running' && pidAlive(Number(meta.pid)) && (meta.lifecycleVersion || !fs.existsSync(path.join(dir, 'REPORT.md'))))) throw fail('the fix is still running');
  if (!runChanges.hasSnapshot(dir)) throw fail('this run started before Meridian kept snapshots, so it cannot be undone here');
  if (changesInFlight.has(id)) throw fail('still working out what this run changed; try again in a moment');
  if (!runChanges.readChanges(dir)) await recordRunChanges(id, dir);
  const changes = runChanges.readChanges(dir);
  if (!changes) throw fail('could not work out what this run changed', 500);
  if (!changes.total.files) throw fail('this run did not change any files');
  changesInFlight.add(id);
  let result;
  try { result = await runChanges.undo(meta.workdir || ROOT, dir); } finally { changesInFlight.delete(id); }
  if (!result.restored.length) throw fail('every file has changed since the run finished, so nothing was undone', 409, { conflicts: result.conflicts });
  meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  meta.undoneAt = Date.now();
  meta.undo = result;
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  // Restored server-side modules only take effect after a restart.
  const needsRestart = result.restored.some((rel) => /^[^/]+\.js$/.test(rel));
  return { id, undoneAt: meta.undoneAt, restored: result.restored, conflicts: result.conflicts, needsRestart };
}
const pendingProjectDelegations = new Set();
const activeDelegations = new Map();
const delegationRegistry = new Map();
const recordDelegationExit = createResultRecorder({ queue: queueFile, write: writeJsonAtomic });

async function finishDelegation(id, dir, code, signal, error = null, feedback = false) {
  try {
    await recordDelegationExit(dir, code, signal, error);
    if (feedback) await recordRunChanges(id, dir);
    await refreshState();
  } catch (e) { console.error('delegation result failed', id, e.message); }
}

async function markDelegationFailed(dir, error) {
  if (fs.existsSync(path.join(dir, 'REPORT.md'))) return;
  try {
    const metaPath = path.join(dir, 'meta.json');
    await queueFile(metaPath, async () => {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (meta.status === 'cancelled' || meta.finishedAt != null) return;
      meta.status = 'failed';
      meta.error = String(error && (error.message || error) || 'delegation failed').slice(0, 1000);
      await writeJsonAtomic(metaPath, meta);
    });
  } catch { /* keep the original run record if failure reporting also fails */ }
}

async function collectDelegations() {
  if (runtime.portableProfile() && !enabled('delegations')) return { runs: [] };
  const dir = path.join(STORAGE_ROOT, 'delegations');
  let ids = [];
  try { ids = await fsp.readdir(dir); } catch { return { runs: [] }; }
  const runs = [];
  for (const id of ids) {
    const d = path.join(dir, id);
    let st;
    try { st = await fsp.stat(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(d, 'meta.json'), 'utf8')); } catch { /* fine */ }
    let finished = null;
    try { finished = (await fsp.stat(path.join(d, 'REPORT.md'))).mtimeMs; } catch { /* not finished */ }
    const hasReport = finished !== null;
    let logM = 0;
    try { logM = (await fsp.stat(path.join(d, 'run.log'))).mtimeMs; } catch { /* fine */ }
    let files = [];
    try {
      files = (await fsp.readdir(d)).filter((f) => !['meta.json', 'run.log', 'before', 'changes.json', 'changes.diff'].includes(f));
    } catch { /* fine */ }
    const status = resultStatus(meta, { hasReport, logM, alive: activeDelegations.has(id) || pidAlive(Number(meta.pid)) });
    if (meta.finishedAt != null) finished = meta.finishedAt;
    else if (meta.lifecycleVersion) finished = null;
    // Dogfood undo. A run that ended while Meridian was down never hit its
    // exit hook, so its change record is written here, once.
    let changes = null;
    let settled = false;
    if (meta.kind === 'feedback') {
      settled = !activeDelegations.has(id) && (status === 'done' || status === 'failed' || status === 'cancelled' || (status === 'stalled' && !pidAlive(Number(meta.pid))));
      changes = runChanges.readChanges(d);
      if (!changes && settled && runChanges.hasSnapshot(d)) void recordRunChanges(id, d, { announce: true });
    }
    runs.push({
      id,
      title: meta.title || id,
      card: meta.card || null,
      projectId: meta.projectId || null,
      kind: meta.kind || 'delegation',
      todoId: meta.todoId || null,
      source: meta.source || null,
      requestFile: meta.requestFile || null,
      model: meta.model || defaultModelLabel(),
      started: meta.started || st.birthtimeMs,
      finished,
      exitCode: meta.exitCode ?? null,
      signal: meta.signal || null,
      finishedAt: meta.finishedAt ?? null,
      result: meta.result || null,
      archivedAt: meta.archivedAt || null,
      effort: meta.effort || null,
      status,
      error: meta.error || null,
      files,
      changes,
      undoable: Boolean(changes && changes.total.files && settled && !meta.undoneAt),
      undoneAt: meta.undoneAt || null,
    });
  }
  runs.sort((a, b) => b.started - a.started);
  delegationRegistry.clear();
  for (const run of runs) delegationRegistry.set(run.id, run);
  return { runs: runs.filter(run => !run.archivedAt).slice(0, 8) };
}

function signalDelegation(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function cancelDelegation(id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('bad delegation id');
  const dir = path.join(STORAGE_ROOT, 'delegations', id);
  const metaPath = path.join(dir, 'meta.json');
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch {
    throw new Error('delegation not found');
  }
  if (meta.status === 'cancelled') return { id, status: 'cancelled' };
  if (meta.status === 'failed' || meta.finishedAt != null || (!meta.lifecycleVersion && fs.existsSync(path.join(dir, 'REPORT.md')))) {
    throw new Error('delegation is no longer running');
  }

  await queueFile(metaPath, async () => {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    if (meta.finishedAt != null) throw new Error('delegation is no longer running');
    meta.status = 'cancelled';
    meta.cancelled = Date.now();
    await writeJsonAtomic(metaPath, meta);
  });

  const active = activeDelegations.get(id);
  const pid = active?.child.pid || Number(meta.pid);
  if (pid) {
    try { signalDelegation(pid, 'SIGTERM'); } catch (error) { console.error('delegation stop failed', id, error.message); }
    if (active) {
      const forceStop = setTimeout(() => {
        if (activeDelegations.get(id) !== active) return;
        try { signalDelegation(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error('delegation force stop failed', id, error.message); }
      }, 2000);
      forceStop.unref();
    }
  }
  return { id, status: 'cancelled' };
}

async function archiveDelegation(id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('bad delegation id');
  const dir = path.join(STORAGE_ROOT, 'delegations', id);
  const metaPath = path.join(dir, 'meta.json');
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch {
    throw new Error('delegation not found');
  }
  if (meta.kind !== 'feedback') throw new Error('only feedback runs can be archived');
  if (meta.archivedAt) return { id, status: 'archived' };
  if ((meta.lifecycleVersion && meta.finishedAt == null) || !fs.existsSync(path.join(dir, 'REPORT.md'))) throw new Error('feedback is not complete');

  meta.archivedAt = Date.now();
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  return { id, status: 'archived' };
}

async function startDelegation(cardFile, title, modelKey, projectId = null, options = {}) {
  const engine = resolveEngine(modelKey, EFFORTS.includes(options.effort) ? options.effort : null);
  const isFeedback = options.kind === 'feedback';
  let card;
  let project = null;
  if (projectId) {
    const projects = (await projectsStore.read()).projects;
    project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error('project not found');
    if (project.delegate === false) throw new Error('project is not marked agent ready');
    title = project.title;
    card = `# ${project.title}\n\nStatus: ${project.status}\nPriority: ${project.priority}\n\n${project.note || 'No additional brief supplied.'}`;
  } else if (isFeedback) {
    card = String(options.request || '').trim();
    if (!card) throw new Error('feedback request required');
  } else if (options.card) {
    card = String(options.card).trim();
    if (!card) throw new Error('card text required');
  } else {
    const cardPath = path.join(CONFIG.board.dir, cardFile);
    card = await fsp.readFile(cardPath, 'utf8');
  }
  const idBase = isFeedback ? 'feedback-' + slugify(title) : (projectId ? 'project-' + projectId : cardFile ? cardFile.replace(/\.md$/, '') : 'todo-' + slugify(title));
  const id = idBase + '-' + Date.now().toString(36);
  const dir = path.join(STORAGE_ROOT, 'delegations', id);
  await fsp.mkdir(dir, { recursive: true });
  const workdir = isFeedback ? sandboxDelegations?.workdir || ROOT : dir;
  // Dogfood undo: copy what a feedback run could edit before it starts
  // (about 40 ms for Meridian). A failed snapshot costs the Undo button, not
  // the fix. Runs already editing the same workdir are noted, because their
  // edits will show up in this run's changes too.
  let snapshot = null;
  let snapshotError = null;
  const concurrent = isFeedback ? [...activeDelegations].filter(([, a]) => a.feedback).map(([other]) => other) : [];
  if (isFeedback) {
    try { snapshot = await runChanges.snapshot(workdir, dir); } catch (error) { snapshotError = String(error && error.message || error).slice(0, 300); }
  }
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    title,
    card: cardFile || null,
    projectId,
    todoId: options.todoId || null,
    kind: isFeedback ? 'feedback' : 'delegation',
    source: project && project.source || options.source || null,
    requestFile: options.requestFile || null,
    started: Date.now(),
    model: engine.who,
    modelId: engine.id,
    effort: engine.effort,
    status: 'running', lifecycleVersion: 1,
    ...(isFeedback ? { workdir, snapshot, snapshotError, concurrent } : {}),
  }, null, 2));

  // Codex writes REPORT.md itself via -o; Claude has no such flag, so it is
  // told to write REPORT.md with its own file tools. Keep the closing line
  // matched to the engine.
  const reportPath = path.join(dir, 'REPORT.md');
  const closing = engine.kind === 'codex'
    ? `- Finish by summarising, in your final message, what you made, the choices
  you took, and the open questions Owner should answer. That summary is saved
  as ${reportPath} automatically.`
    : `- When you are done, write ${reportPath} that
  summarises what you made, the choices you took, and the open questions Owner
  should answer. This is the last thing you do.`;

  const sourceDescription = project && project.source === 'outlook'
    ? 'It came from an Outlook email.'
    : project && project.source === 'slack'
      ? 'It came from Slack.'
      : 'It came from Meridian.';
  const prompt = isFeedback
    ? `You are ${engine.who}, implementing a change the owner requested through
Meridian's Dogfooding section, where he logs fixes to his own tools.

Rules:
- Read this project's CONTRIBUTING.md first.
- Work only inside ${ROOT} for the
  implementation. You may read other LifeOS files for context, but do not edit
  them.
- Make the requested change, not just a plan. Keep the diff minimal and focused.
- Do not send email or Slack messages, change mailbox state, deploy, commit, or
  make unrelated refactors.
- Run the relevant syntax checks or tests before finishing.
- The request has already been logged at ${options.requestFile || 'the Meridian feedback inbox'}.
${closing}

THE REQUEST:

${card}`
    : `You are ${engine.who}, taking a first pass at a task the owner delegated
from his Meridian morning brief. ${sourceDescription} The full card is below.

Rules:
- Work ONLY inside the current working directory. Do not touch anything
  outside it. This is a sandbox; the deliverable is files.
- Produce the most useful reviewable first pass the card implies: for design
  work, a self-contained HTML mockup (or two variants); for writing, the
  draft; for planning, the plan as markdown. Real content, no placeholders.
- If the card is visual, read and follow
  this project's CONTRIBUTING.md. Absolutely no
  grid or graph-paper backgrounds, no emojis in UI, no all-caps labels.
- Writing style: plain confident language, no em dashes, no AI-tell phrases.
${closing}

THE CARD:

${card}`;

  const env = {
    ...process.env,
    PATH: [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(HOME, '.npm-global', 'bin'),
      path.join(HOME, '.local', 'bin'),
      process.env.PATH || '',
    ].filter(Boolean).join(path.delimiter),
  };
  const log = fs.openSync(path.join(dir, 'run.log'), 'a');

  let bin, args;
  if (engine.kind === 'codex') {
    bin = CODEX_BIN;
    args = [
      'exec', '-m', engine.model, '-s', 'workspace-write',
      '-C', workdir, '--add-dir', dir, '--skip-git-repo-check',
      '-c', `model_reasoning_effort=${engine.effort || 'medium'}`,
      '-o', reportPath, '-',
    ];
  } else {
    bin = CLAUDE_BIN;
    // Headless, scoped to the run dir or Meridian workspace. stream-json keeps run.log ticking so
    // the running/stalled check (which watches run.log's mtime) stays accurate.
    args = [
      '-p', '--model', engine.model,
      '--effort', engine.effort,
      '--permission-mode', 'bypassPermissions',
      '--add-dir', workdir,
      '--add-dir', dir,
      '--output-format', 'stream-json', '--verbose',
    ];
  }

  const child = (sandboxDelegations?.spawn || spawn)(bin, args, {
    detached: true, cwd: workdir, stdio: ['pipe', log, log], env,
  });
  const active = { child, dir, feedback: isFeedback };
  activeDelegations.set(id, active);
  let didSpawn = false;
  const launched = new Promise((resolve, reject) => {
    child.once('spawn', () => {
      didSpawn = true;
      try {
        const metaPath = path.join(dir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.pid = child.pid;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
      } catch { /* the run can still be stopped while Meridian stays up */ }
      resolve();
    });
    child.on('error', (error) => {
      activeDelegations.delete(id);
      if (!didSpawn) { void finishDelegation(id, dir, null, null, error, isFeedback); reject(error); }
      else void markDelegationFailed(dir, error);
    });
  });
  child.stdin.on('error', (error) => { void markDelegationFailed(dir, error); });
  child.on('exit', (code, signal) => {
    activeDelegations.delete(id);
    void finishDelegation(id, dir, code, signal, null, isFeedback);
  });
  try {
    child.stdin.end(prompt);
    await launched;
  } catch (error) {
    await markDelegationFailed(dir, error);
    throw new Error(`could not start delegation: ${String(error && (error.message || error) || error)}`);
  } finally {
    child.unref();
    fs.closeSync(log);
  }
  return id;
}

// ---------------------------------------------------------------- pulse (today's activity)

// Journal backfill: a Codex run (Luna, high effort) that reads the ledgers,
// git history and session logs, writes journal-backfill.json in the run dir,
// validates it with scripts/journal-import.js and applies it. Shows up under
// Agents like any other delegation.
async function startJournalBackfill(from) {
  const engine = resolveEngine('gpt-6-luna', 'high');
  const id = 'journal-backfill-' + Date.now().toString(36);
  const dir = path.join(STORAGE_ROOT, 'delegations', id);
  await fsp.mkdir(dir, { recursive: true });
  const title = `Backfill the journal from ${from}`;
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ title, card: null, projectId: null, kind: 'journal', source: 'meridian', started: Date.now(), model: engine.who, modelId: engine.id, effort: engine.effort, status: 'running', lifecycleVersion: 1 }, null, 2));
  const brief = await fsp.readFile(path.join(ROOT, 'scripts', 'journal-backfill-prompt.md'), 'utf8');
  const reportPath = path.join(dir, 'REPORT.md');
  const prompt = brief
    .replace(/\{\{FROM\}\}/g, from)
    .replace(/\{\{TO\}\}/g, new Date(Date.now() - 86400e3).toISOString().slice(0, 10))
    .replace(/\{\{RUN_DIR\}\}/g, dir)
    .replace(/\{\{MERIDIAN\}\}/g, ROOT)
    .replace(/\{\{HOME\}\}/g, HOME)
    .replace(/\{\{REPORT\}\}/g, reportPath);
  const env = { ...process.env, PATH: ['/usr/local/bin', '/opt/homebrew/bin', path.join(HOME, '.local', 'bin'), path.join(HOME, '.npm-global', 'bin'), process.env.PATH || ''].filter(Boolean).join(path.delimiter) };
  const log = fs.openSync(path.join(dir, 'run.log'), 'a');
  const child = spawn(CODEX_BIN, ['exec', '-m', engine.model, '-s', 'workspace-write', '-C', dir, '--add-dir', dir, '--add-dir', DATA_DIR, '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', '-o', reportPath, '-'], { detached: true, cwd: dir, stdio: ['pipe', log, log], env });
  activeDelegations.set(id, { child, dir, feedback: false });
  child.once('spawn', () => {
    void queueFile(path.join(dir, 'meta.json'), async () => {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
      await writeJsonAtomic(path.join(dir, 'meta.json'), { ...meta, pid: child.pid });
    }).catch(error => console.error('journal pid record failed', error.message));
  });
  child.on('error', (error) => { activeDelegations.delete(id); void finishDelegation(id, dir, null, null, error); });
  child.on('exit', (code, signal) => { activeDelegations.delete(id); void finishDelegation(id, dir, code, signal); });
  child.stdin.on('error', (error) => { void markDelegationFailed(dir, error); });
  child.stdin.end(prompt);
  child.unref();
  fs.closeSync(log);
  return id;
}

async function collectPulse(git, ai, board) {
  const events = [];
  const since = startOfToday();

  // commits today across dirty-or-recent repos
  const repos = git.repos.slice(0, 20);
  await Promise.all(repos.map(async (repo) => {
    const out = await run('git', ['-C', repo.path, 'log', '--since=midnight', '--format=%ct%x1f%s', '-n', '30']);
    if (!out) return;
    for (const line of out.split('\n').filter(Boolean)) {
      const [ct, s] = line.split('\x1f');
      events.push({ t: Number(ct) * 1000, kind: 'commit', label: repo.name.split('/').pop() + ': ' + s });
    }
  }));

  for (const s of ai.sessions) {
    if (s.last >= since) events.push({ t: s.last, kind: s.tool, label: (s.tool === 'claude' ? 'Claude · ' : 'Codex · ') + s.project });
  }
  for (const c of board.cards) {
    const ts = Date.parse(c.updated);
    if (ts && ts >= since) events.push({ t: ts, kind: 'board', label: 'Board · ' + c.title });
  }
  events.sort((a, b) => a.t - b.t);
  return { events: events.slice(-80) };
}

// ---------------------------------------------------------------- system

async function collectSystem() {
  if (runtime.portableProfile() && !enabled('system')) return {};
  const df = await run('df', ['-k', '/']);
  let diskFreeGb = null;
  if (df) {
    const cols = df.trim().split('\n').pop().split(/\s+/);
    diskFreeGb = Math.round(Number(cols[3]) / 1024 / 1024);
  }
  return {
    host: os.hostname().replace('.local', ''),
    uptimeH: Math.round(os.uptime() / 3600),
    load: os.loadavg()[0].toFixed(1),
    diskFreeGb,
  };
}

// ---------------------------------------------------------------- drift

// The LifeOS root must only hold entries the routing table in AGENTS.md
// accounts for. Anything else is unrouted and needs Owner to decide its home.
async function collectDrift() {
  if (runtime.portableProfile() && !enabled('drift')) return { strays: [] };
  const root = path.join(HOME, 'LifeOS');
  try {
    const agents = await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const strays = entries
      .filter((e) => !e.name.startsWith('.') && !e.name.endsWith('.md'))
      .filter((e) => !agents.includes(e.name))
      .map((e) => e.name);
    return { strays };
  } catch {
    return { strays: [], error: 'root or AGENTS.md unreadable' };
  }
}

// ---------------------------------------------------------------- tailnet

// Where this Mac lives on the tailnet. Used to turn 127.0.0.1:PORT previews
// into URLs the other Mac and the phone can open.
const TAILSCALE_BIN = process.platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale';
let tailnetCache = { at: 0, info: null };

async function collectTailnet() {
  if (!enabled('tailscale')) return { host: CONFIG.tailscale?.hostname || null, ip: null, servePort: CONFIG.port || 4980 };
  if (tailnetCache.info && ago(tailnetCache.at) < 10 * 60 * 1000) return tailnetCache.info;
  const info = { host: null, ip: null, servePort: CONFIG.port || 4980 };
  const cfg = CONFIG.tailscale || {};
  if (cfg.hostname) info.host = cfg.hostname;
  // TAILSCALE_BE_CLI: under launchd the app binary otherwise tries to start
  // the GUI, and this silently fell back to config.json.
  const out = await run(TAILSCALE_BIN, ['status', '--json'], { timeout: 4000, env: localShare.CLI_ENV });
  if (out) {
    try {
      const j = JSON.parse(out);
      if (j.Self) {
        info.host = info.host || String(j.Self.DNSName || '').replace(/\.$/, '') || null;
        info.ip = (j.Self.TailscaleIPs || []).find((a) => /^100\./.test(a)) || null;
      }
    } catch { /* ignore */ }
  }
  if (!info.ip) info.ip = bindAddresses().find((a) => a.startsWith('100.')) || null;
  tailnetCache = { at: Date.now(), info };
  return info;
}

// ---------------------------------------------------------------- local servers

// Dev servers listening on this Mac right now. These are the things Owner
// opens over Tailscale to test from the other Mac before anything has a
// Vercel URL. The dashboard offers to promote them into saved links.
const DEV_PROCESSES = /^(node|next-server|bun|deno|python[\d.]*|Python|uvicorn|gunicorn|flask|ruby|puma|php|php-fpm|go|hugo|caddy|java|dotnet|cargo|vite|astro|webpack|esbuild|http-server|serve|live-server|ollama)$/i;
const IGNORED_PORTS = new Set([4980]);
let localCache = { at: 0, servers: [] };

// Tailscale Serve links for them (local-share.js), and the list of ones Owner
// keeps running but has hidden. Every port that is listening counts as taken
// when picking an HTTPS port, not just the dev servers.
async function listeningPorts() {
  const out = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'n'], { timeout: 6000 });
  const ports = new Set();
  for (const line of String(out || '').split('\n')) { const m = line.match(/^n.*:(\d+)$/); if (m) ports.add(Number(m[1])); }
  return ports;
}
const serveShares = localShare.createShares({ bin: TAILSCALE_BIN, file: path.join(DATA_DIR, 'local-shares.json'), listeningPorts });
const localIgnore = localShare.createIgnoreList(path.join(DATA_DIR, 'local-ignore.json'));

// The detected list for a port, re-scanning once when the 20 s cache has not
// seen it yet, so a server started a moment ago can be shared or stopped.
async function localServersWith(port) {
  let servers = await collectLocalServers(await collectTailnet());
  if (!servers.some((sv) => sv.port === port)) { localCache.at = 0; servers = await collectLocalServers(await collectTailnet()); }
  return servers;
}

// After a share, unshare, stop or ignore: re-read now and push to every client.
async function refreshLocal() {
  localCache.at = 0;
  serveShares.invalidate();
  const servers = await collectLocalServers(await collectTailnet());
  if (state.at) { state.local = { servers }; broadcast(); }
  return servers;
}

function shortProject(cwd) {
  if (!cwd) return null;
  const rel = cwd.startsWith(HOME) ? cwd.slice(HOME.length + 1) : cwd;
  const parts = rel.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || rel;
}

function guessCategory(text) {
  const t = String(text || '').toLowerCase();
  for (const [pattern, label] of CONFIG.links?.categoryRules || [['meridian', 'Meridian']]) if (new RegExp(pattern, 'i').test(t)) return label;
  return null;
}

async function collectLocalServers(tailnet) {
  if (runtime.portableProfile() && !enabled('localServers')) return [];
  if (!JOBS_ENABLED) return state.local?.servers || [];
  if (ago(localCache.at) < 20 * 1000) return localCache.servers;
  const out = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'], { timeout: 6000 });
  if (!out) return localCache.servers;
  const procs = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    const tag = line[0]; const val = line.slice(1);
    if (tag === 'p') { current = { pid: Number(val), command: '', binds: [] }; procs.set(current.pid, current); }
    else if (tag === 'c' && current) current.command = val;
    else if (tag === 'n' && current) current.binds.push(val);
  }
  const candidates = [];
  for (const proc of procs.values()) {
    if (!DEV_PROCESSES.test(proc.command)) continue;
    const ports = new Map();
    for (const b of proc.binds) {
      const m = b.match(/^(.*):(\d+)$/);
      if (!m) continue;
      const port = Number(m[2]);
      if (IGNORED_PORTS.has(port) || port < 1024) continue;
      const host = m[1];
      const prev = ports.get(port) || { loopbackOnly: true };
      if (host !== '127.0.0.1' && host !== '[::1]' && host !== 'localhost') prev.loopbackOnly = false;
      ports.set(port, prev);
    }
    for (const [port, meta] of ports) candidates.push({ pid: proc.pid, command: proc.command, port, loopbackOnly: meta.loopbackOnly });
  }
  const seen = new Set();
  const servers = [];
  await Promise.all(candidates.map(async (c) => {
    if (seen.has(c.port)) return; seen.add(c.port);
    const [cwdOut, probe] = await Promise.all([
      run('lsof', ['-p', String(c.pid), '-a', '-d', 'cwd', '-Fn'], { timeout: 3000 }),
      fetchUrl(`http://127.0.0.1:${c.port}/`, { timeout: 1500 }),
    ]);
    if (!probe.status) return; // not HTTP, or refused
    const cwd = cwdOut ? (cwdOut.split('\n').find((l) => l.startsWith('n')) || '').slice(1) : null;
    const titleMatch = probe.body.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;
    // Ephemeral-port helpers with no page title are tooling, not previews.
    if (!title && c.loopbackOnly && c.port >= 49152) return;
    const project = shortProject(cwd);
    const tailHost = tailnet && (tailnet.host || tailnet.ip);
    servers.push({
      port: c.port, pid: c.pid, command: c.command, cwd, project, title,
      status: probe.status, ms: probe.ms, loopbackOnly: c.loopbackOnly,
      localUrl: `http://127.0.0.1:${c.port}/`,
      tailUrl: tailHost && !c.loopbackOnly ? `http://${tailHost}:${c.port}/` : null,
      tailIpUrl: tailnet && tailnet.ip && !c.loopbackOnly ? `http://${tailnet.ip}:${c.port}/` : null,
      category: guessCategory(`${cwd || ''} ${title || ''}`),
    });
  }));
  servers.sort((a, b) => a.port - b.port);
  // shareUrl / shareHttpsPort / shareOwned / reachable, then ignored.
  await serveShares.annotate(servers);
  localIgnore.annotate(servers, await localIgnore.read().catch(() => []));
  localCache = { at: Date.now(), servers };
  return servers;
}

// ---------------------------------------------------------------- link health

const linkHealth = new Map();
const LINK_CHECK_MS = 5 * 60 * 1000;

async function collectLinks() {
  if (!enabled('linkMetadata')) return linksStore.read();
  const data = await linksStore.read();
  const due = data.links.filter((l) => l.check !== false && ago((linkHealth.get(l.id) || { at: 0 }).at) > LINK_CHECK_MS);
  await Promise.all(due.slice(0, 24).map(async (l) => {
    const r = await fetchUrl(l.url, { timeout: 5000, headers: { 'User-Agent': 'Meridian/1.0 link check' } });
    const up = r.status >= 200 && r.status < 500 && r.status !== 0;
    linkHealth.set(l.id, { at: Date.now(), up, status: r.status, ms: r.ms });
  }));
  return {
    categories: data.categories,
    links: data.links.map((l) => ({ ...l, health: linkHealth.get(l.id) || null })),
  };
}

// ---------------------------------------------------------------- favicons

const FAVICON_DIR = path.join(CACHE_DIR, 'favicons');
const FAVICON_TTL = 14 * 24 * 3600 * 1000;
const faviconMisses = new Map();

async function faviconFor(origin, refresh = false) {
  const key = origin.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80);
  const file = path.join(FAVICON_DIR, key);
  if (!refresh || !enabled('linkMetadata')) {
    try {
      const st = await fsp.stat(file);
      if (!enabled('linkMetadata') || ago(st.mtimeMs) < FAVICON_TTL) {
        const meta = JSON.parse(await fsp.readFile(file + '.json', 'utf8'));
        return { type: meta.type, buffer: await fsp.readFile(file) };
      }
    } catch { /* not cached */ }
    const missedAt = faviconMisses.get(origin);
    if (missedAt && ago(missedAt) < 6 * 3600 * 1000) return null;
  }
  if (!enabled('linkMetadata')) return null;
  // Prefer whatever the page declares, fall back to the well-known path.
  const candidates = [];
  const page = await fetchUrl(origin + '/', { timeout: 4000 });
  if (page.status && page.body) {
    for (const m of page.body.matchAll(/<link[^>]+rel=["']?[^"'>]*icon[^"'>]*["']?[^>]*>/gi)) {
      const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
      if (!href) continue;
      try { candidates.push(new URL(href, origin + '/').href); } catch { /* skip */ }
    }
  }
  candidates.push(origin + '/favicon.ico', origin + '/favicon.png', origin + '/icon.svg', origin + '/apple-touch-icon.png');
  for (const url of candidates.slice(0, 6)) {
    const got = await fetchBinary(url);
    if (!got || !got.buffer.length) continue;
    const type = got.type && /^image\//.test(got.type) ? got.type : (url.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon');
    if (!/^image\//.test(type)) continue;
    try {
      await fsp.mkdir(FAVICON_DIR, { recursive: true });
      await fsp.writeFile(file, got.buffer);
      await fsp.writeFile(file + '.json', JSON.stringify({ type, origin, at: Date.now() }));
    } catch { /* cache is best effort */ }
    faviconMisses.delete(origin);
    return { type, buffer: got.buffer };
  }
  faviconMisses.set(origin, Date.now());
  return null;
}

// ---------------------------------------------------------------- previews

// Screenshots of links and dev servers via the installed Chrome in headless
// mode. Chrome's updater keeps the process alive after the shot is written,
// so we watch for the file to settle and then kill the process ourselves.
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PREVIEW_DIR = path.join(CACHE_DIR, 'previews');
const PREVIEW_TTL = 6 * 60 * 60 * 1000;
const previewJobs = new Map();
let previewActive = 0;
const previewQueue = [];
const HAS_CHROME = process.platform === 'darwin' && fs.existsSync(CHROME_BIN) && (runtime.portableProfile() ? JOBS_ENABLED : enabled('previews'));

function runPreviewJob(fn) {
  return new Promise((resolve) => {
    previewQueue.push(async () => { try { resolve(await fn()); } catch { resolve(false); } });
    drainPreviews();
  });
}
function drainPreviews() {
  while (previewActive < 2 && previewQueue.length) {
    const job = previewQueue.shift();
    previewActive++;
    job().finally(() => { previewActive--; drainPreviews(); });
  }
}

// Dev servers often answer "/" with a meta-refresh to the real app. Chrome's
// --screenshot gives up on that navigation, so check the targets ourselves.
async function resolveMetaRefresh(url) {
  const seen = new Set();
  for (let hop = 0; hop < 6; hop++) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(u.protocol) || seen.has(u.href)) return null;
    seen.add(u.href);
    const r = await fetchUrl(u.href, { timeout: 3000 });
    const m = r.body && r.body.slice(0, 4000).match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']\s*\d+\s*;\s*url=([^"'>\s]+)/i);
    const next = [301, 302, 303, 307, 308].includes(r.status) ? r.location : m && m[1];
    if (!next) return u.href;
    try { url = new URL(next, u).href; } catch { return null; }
  }
  return null;
}

const previewFailed = new Map(); // key -> timestamp of last failed render

async function screenshot(url, out) {
  if (!enabled('previews') || !HAS_CHROME) return false;
  url = await resolveMetaRefresh(url);
  if (!url) return false;
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-chrome-'));
  const tmp = out + '.part.png';
  try { await fsp.unlink(tmp); } catch { /* none */ }
  const child = spawn(CHROME_BIN, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-component-update', '--disable-background-networking', '--disable-extensions', '--disable-sync',
    '--mute-audio', '--force-dark-mode', '--user-data-dir=' + profile, '--window-size=1280,800',
    '--timeout=8000', '--screenshot=' + tmp, url,
  ], { stdio: 'ignore' });
  const started = Date.now();
  const ok = await new Promise((resolve) => {
    let lastSize = -1; let stable = 0; let finished = false; let settleTimer;
    child.on('error', () => { finished = true; clearInterval(iv); clearTimeout(settleTimer); resolve(false); });
    const iv = setInterval(async () => {
      let st = null;
      try { st = await fsp.stat(tmp); } catch { /* not yet */ }
      if (st && st.size > 0) { if (st.size === lastSize) stable++; else { stable = 0; lastSize = st.size; } }
      if (finished) return;
      const exited = child.exitCode !== null || child.signalCode !== null;
      if (stable >= 2 || exited || Date.now() - started > 20000) {
        finished = true;
        clearInterval(iv);
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        settleTimer = setTimeout(async () => {
          try { const s = await fsp.stat(tmp); if (s.size > 0) { await fsp.rename(tmp, out); resolve(true); return; } } catch { /* none */ }
          resolve(false);
        }, 150);
      }
    }, 300);
  });
  await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  if (!ok) await fsp.rm(tmp, { force: true }).catch(() => {});
  return ok;
}

// Returns the cached preview path (possibly stale) and kicks off a refresh
// when needed. When nothing is cached, waits for the first render.
async function preview(key, url, force = false) {
  const file = path.join(PREVIEW_DIR, key.replace(/[^\w.-]/g, '_') + '.png');
  let st = null;
  try { st = await fsp.stat(file); } catch { /* none */ }
  if (!enabled('previews')) return st ? file : null;
  const fresh = st && ago(st.mtimeMs) < PREVIEW_TTL;
  if (st && fresh && !force) return file;
  const failedAt = previewFailed.get(key) || 0;
  if (!force && !st && ago(failedAt) < 10 * 60 * 1000) return null; // gave up recently; do not respawn Chrome on every retry
  if (!previewJobs.has(key)) {
    const p = runPreviewJob(() => screenshot(url, file)).then((ok) => { if (ok) previewFailed.delete(key); else previewFailed.set(key, Date.now()); return ok; }).finally(() => previewJobs.delete(key));
    previewJobs.set(key, p);
  }
  if (st && !force) return file; // serve stale while refreshing
  if (!force) return 'pending'; // first render runs in the background; the client retries
  const ok = await previewJobs.get(key);
  return ok ? file : null;
}

// Shots are 1280×800 PNGs (120–600 KB) shown in tiles under 400 px wide, so
// tiles get an 800 px JPEG made once per shot with macOS's sips.
const thumbJobs = new Map();
async function previewThumb(file) {
  if (!enabled('previews')) {
    const thumb = file.replace(/\.png$/, '.thumb.jpg');
    if (await fsp.stat(thumb).catch(() => null)) return { file: thumb, type: 'image/jpeg' };
    return { file, type: 'image/png' };
  }
  const thumb = file.replace(/\.png$/, '.thumb.jpg');
  try {
    const [src, dst] = await Promise.all([fsp.stat(file), fsp.stat(thumb).catch(() => null)]);
    if (!dst || dst.mtimeMs < src.mtimeMs) {
      if (!thumbJobs.has(thumb)) {
        const part = thumb.replace(/\.jpg$/, '.part.jpg');
        thumbJobs.set(thumb, new Promise((resolve, reject) => execFile('/usr/bin/sips', ['-Z', '800', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', file, '--out', part], { timeout: 15000 }, (e) => (e ? reject(e) : resolve())))
          .then(() => fsp.rename(part, thumb)).finally(() => thumbJobs.delete(thumb)));
      }
      await thumbJobs.get(thumb);
    }
    return { file: thumb, type: 'image/jpeg' };
  } catch {
    return { file, type: 'image/png' };
  }
}

// ---------------------------------------------------------------- journal automation

// Coarse track for a journal entry from its text. Rules live in
// config.json → journal.tracks so Owner can tune them without code.
const DEFAULT_TRACK_RULES = {
  uni: ['\\buni\\b', 'university', 'module', 'lecture', 'coursework'],
  work: ['client', 'outlook', 'slack', 'agency'],
};
function trackRules() {
  const cfg = (CONFIG.journal && CONFIG.journal.tracks) || {};
  const out = {};
  for (const t of ['uni', 'work']) out[t] = (cfg[t] || DEFAULT_TRACK_RULES[t]).map((r) => new RegExp(r, 'i'));
  return out;
}
function classifyTrack(text) {
  const rules = trackRules();
  const t = String(text || '');
  if (rules.uni.some((r) => r.test(t))) return 'uni';
  if (rules.work.some((r) => r.test(t))) return 'work';
  return 'personal';
}

// Ledger headings drift ("LifeOS, Atlas, Helios and portfolio site"). Fold the
// common ones into stable area names so the filter chips stay useful.
const AREA_CANON = (CONFIG.journal?.areaAliases || [['meridian', 'Meridian'], ['personal', 'Personal']])
  .map(([pattern, label]) => [new RegExp(pattern, 'i'), label]);
function canonicalArea(heading) {
  const h = String(heading || '').trim();
  for (const [re, name] of AREA_CANON) if (re.test(h)) return name;
  return h;
}

// Split a nightly ledger's "What happened" section into one entry per area.
function ledgerToEntries(date, text) {
  const section = text.split(/^## What happened\s*$/m)[1];
  if (!section) return [];
  const body = section.split(/^## /m)[0];
  const parts = body.split(/^### /m).slice(1);
  const entries = [];
  for (const part of parts) {
    const [heading, ...rest] = part.split('\n');
    const rawArea = heading.trim();
    const area = canonicalArea(rawArea);
    const paragraph = rest.join('\n').trim().replace(/\n{3,}/g, '\n\n');
    if (!area || !paragraph) continue;
    if (/^(daily planning|meridian ledger)$/i.test(rawArea) && paragraph.length < 160) continue; // housekeeping noise
    if (/^the nightly ledger was updated\.?$/i.test(paragraph)) continue;
    // Status lines are loose ends, not things done. Keep them out of the journal.
    const STATUS_ONLY = /^(the (main )?(worktree|vault|repo(sitory)?)[^.]*(remains|has|still has)[^.]*dirty|[^.]*(is|are|remain(s)?) down\b|the board (holds|has) \d+ ideas|[^.]*no outcome (is|was) recorded|[^.]*purpose and outcomes? (are|is|were) not recorded|[^.]*(their|its) outcomes? (is|are|were) not recorded)/i;
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    if (sentences.length <= 2 && STATUS_ONLY.test(sentences[0])) continue;
    // The headline is what got done. Sentences about which agent ran when are
    // secondary; they stay in the body and the client shows a small note.
    const AGENT_LEAD = /^(claude( code)?|codex|(claude|codex) and (claude|codex)|a (claude|codex) session|agents?)\b[^.]*\b(ran|sessions?|worked|remained live|both worked|logged|opened)\b/i;
    const pick = sentences.find((s) => !STATUS_ONLY.test(s) && !AGENT_LEAD.test(s)) || sentences.find((s) => !STATUS_ONLY.test(s)) || sentences[0];
    let firstSentence = pick.replace(/\s+/g, ' ');
    if (AGENT_LEAD.test(firstSentence)) {
      // Nothing better available: keep the substance, drop the agent framing.
      const m = firstSentence.match(/(?:task text concerns|working on|to|for)\s+([^.]{8,})\.?$/i);
      firstSentence = m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).replace(/\.$/, '') : `Worked on ${area}`;
    }
    const title = firstSentence.length > 150 ? firstSentence.slice(0, 147).replace(/\s+\S*$/, '') + '…' : firstSentence;
    entries.push({
      date, area, title, body: paragraph, track: classifyTrack(rawArea + ' ' + area + ' ' + paragraph),
      source: 'ledger', sourceRef: `${date}#${rawArea}`, tags: [],
    });
  }
  return entries;
}

const importedLedgers = new Set();
async function syncJournalFromLedger() {
  const dir = (CONFIG.ledger && CONFIG.ledger.dir) || path.join(STORAGE_ROOT, 'ledger');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return 0; }
  const today = new Date().toISOString().slice(0, 10);
  const dates = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, 10)).filter((d) => d !== today && !importedLedgers.has(d));
  if (!dates.length) return 0;
  const existing = await journalStore.read();
  const have = new Set(existing.entries.filter((e) => e.source === 'ledger' && e.sourceRef).map((e) => e.sourceRef.split('#')[0]));
  const inputs = [];
  for (const d of dates) {
    if (have.has(d)) { importedLedgers.add(d); continue; }
    try { inputs.push(...ledgerToEntries(d, await fsp.readFile(path.join(dir, d + '.md'), 'utf8'))); } catch { /* skip */ }
    importedLedgers.add(d);
  }
  if (!inputs.length) return 0;
  const added = await journalStore.createMany(inputs);
  if (added.length) { console.log(`journal: imported ${added.length} entries from ${dates.length} ledger day(s)`); exportJournalDays(added.map((e) => e.date)).catch(() => {}); }
  return added.length;
}

// Live digest of today, grouped by project, for the Journal's "Today so far"
// block. Deterministic; tonight's ledger becomes the persisted entries.
function todaySoFar(pulse, ai, delegations) {
  const since = startOfToday();
  const groups = new Map();
  const g = (name) => { if (!groups.has(name)) groups.set(name, { name, commits: [], sessions: { claude: 0, codex: 0 }, minutes: 0, first: null, last: null, asks: [], did: null }); return groups.get(name); };
  for (const e of (pulse && pulse.events) || []) {
    if (e.kind !== 'commit') continue;
    const i = e.label.indexOf(': ');
    const repo = i > 0 ? e.label.slice(0, i) : 'commits';
    const grp = g(repo); grp.commits.push({ t: e.t, subject: i > 0 ? e.label.slice(i + 2) : e.label });
    grp.first = Math.min(grp.first || e.t, e.t); grp.last = Math.max(grp.last || 0, e.t);
  }
  for (const s of (ai && ai.sessions) || []) {
    if (s.last < since) continue;
    let name = String(s.project || '').split('/').pop() || s.project || 'session';
    // A Codex automation names its temp dir after the prompt. Those are the
    // scheduled runs, not Owner working, so they get their own line.
    const automation = /^[a-z0-9]+(-[a-z0-9]+){3,}$/.test(name) || /^\.tmp|^tmp/.test(name);
    if (automation) name = 'Automations';
    const grp = g(name); grp.sessions[s.tool] = (grp.sessions[s.tool] || 0) + 1;
    if (!automation) {
      // What Owner asked for, and the last thing the agent said it did. The
      // nightly ledger turns these into proper English; until then this is
      // still far more use than a session count.
      if (s.prompt && !grp.asks.includes(s.prompt)) grp.asks.push(s.prompt);
      // Several sessions per project. The fullest closing summary is the one
      // worth showing; openers and one-liners lose to it.
      if (s.did && s.did.length > (grp.did || '').length) grp.did = s.did;
    }
    // Session files are touched across the day, so first-to-last is an upper bound. Cap one session at three hours.
    const from = Math.max(s.started, since);
    grp.minutes += Math.min(180, Math.max(1, Math.round((s.last - from) / 60000)));
    grp.first = Math.min(grp.first || from, from); grp.last = Math.max(grp.last || 0, s.last);
  }
  const runs = ((delegations && delegations.runs) || []).filter((r) => r.started >= since).map((r) => ({ title: r.title, status: r.status, model: r.model }));
  const items = [...groups.values()]
    .map((x) => ({ ...x, asks: x.asks.slice(0, 3), track: classifyTrack(x.name + ' ' + x.commits.map((c) => c.subject).join(' ')) }))
    .sort((a, b) => (b.minutes || 0) - (a.minutes || 0) || (b.last || 0) - (a.last || 0));
  return { date: new Date().toISOString().slice(0, 10), items, delegations: runs };
}

// A to-do handed to a model carries the run id. Reflect the run's status back
// onto the to-do so the card can show "working" or "report ready" without the
// dashboard having to join the two lists itself.
async function syncTodoDelegations(delegations) {
  const runs = [...delegationRegistry.values()];
  const data = await todosStore.read();
  for (const todo of data.todos) {
    const id = todo.delegation && todo.delegation.id;
    if (!id) continue;
    const run = runs.find((r) => r.id === id);
    if (!run || run.status === todo.delegation.status) continue;
    await todosStore.update(todo.id, {
      delegation: { ...todo.delegation, status: run.status, files: run.files || [] },
    });
  }
  return todosStore.sort((await todosStore.read()).todos);
}

// ---------------------------------------------------------------- journal → vault

// Every day with entries becomes one Markdown file in the vault, rewritten
// whenever that day's entries change. Agents and Obsidian can read it.
function vaultJournalDir() {
  return (CONFIG.journal && CONFIG.journal.vaultDir) || path.join(path.dirname(CONFIG.vaultInbox), 'Journal', 'daybook');
}
async function exportJournalDays(dates) {
  if (runtime.portableProfile() && !enabled('journalExport')) return undefined;
  const wanted = [...new Set((dates || []).filter(Boolean))];
  if (!wanted.length) return;
  const data = await journalStore.read();
  const dir = vaultJournalDir();
  await fsp.mkdir(dir, { recursive: true });
  for (const date of wanted) {
    const file = path.join(dir, `${date}.md`);
    const entries = data.entries.filter((e) => e.date === date);
    if (!entries.length) { try { await fsp.unlink(file); } catch { /* none */ } continue; }
    const total = entries.reduce((a, e) => a + (e.minutes || 0), 0);
    const out = ['---', `date: ${date}`, 'source: meridian-journal', `entries: ${entries.length}`, total ? `minutes: ${total}` : null, '---', '', `# ${date}`, ''].filter((l) => l !== null);
    for (const track of ['work', 'uni', 'personal']) {
      const list = entries.filter((e) => e.track === track);
      if (!list.length) continue;
      out.push(`## ${track.charAt(0).toUpperCase() + track.slice(1)}`, '');
      for (const e of list) {
        out.push(`### ${e.title}`, `Area: ${e.area}${e.minutes ? ` · ${e.minutes} min` : ''}${e.tags && e.tags.length ? ` · ${e.tags.map((t) => '#' + t).join(' ')}` : ''}`, '');
        if (e.body) out.push(e.body, '');
      }
    }
    await writeAtomic(file, out.join('\n'));
  }
}

// Time report for a client or tutor: hours per area per day, plus the lines.
function journalReport(data, { from, to, track, format }) {
  const entries = data.entries.filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!track || track === 'all' || e.track === track)).sort((a, b) => a.date.localeCompare(b.date));
  const hrs = (m) => (m / 60).toFixed(2);
  if (format === 'csv') {
    const rows = [['date', 'area', 'track', 'title', 'minutes', 'hours']];
    for (const e of entries) rows.push([e.date, e.area, e.track, e.title, e.minutes || 0, hrs(e.minutes || 0)]);
    return rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n') + '\n';
  }
  const byArea = new Map();
  for (const e of entries) { const a = byArea.get(e.area) || { minutes: 0, days: new Set(), n: 0 }; a.minutes += e.minutes || 0; a.days.add(e.date); a.n++; byArea.set(e.area, a); }
  const total = entries.reduce((a, e) => a + (e.minutes || 0), 0);
  const out = [`# Time report${from || to ? ` · ${from || 'start'} to ${to || 'today'}` : ''}${track && track !== 'all' ? ` · ${track}` : ''}`, '', `Prepared from the owner's Meridian journal on ${new Date().toISOString().slice(0, 10)}. ${entries.length} entries, ${hrs(total)} hours logged.`, '', '## By project', '', '| Project | Days | Entries | Hours |', '|---|---:|---:|---:|'];
  for (const [area, a] of [...byArea].sort((x, y) => y[1].minutes - x[1].minutes)) out.push(`| ${area} | ${a.days.size} | ${a.n} | ${hrs(a.minutes)} |`);
  out.push(`| **Total** | | ${entries.length} | **${hrs(total)}** |`, '', '## By day', '');
  let day = null;
  for (const e of entries) {
    if (e.date !== day) { day = e.date; const dm = entries.filter((x) => x.date === day).reduce((a, x) => a + (x.minutes || 0), 0); out.push(`### ${day}${dm ? ` · ${hrs(dm)} h` : ''}`, ''); }
    out.push(`- **${e.area}**: ${e.title}${e.minutes ? ` (${hrs(e.minutes)} h)` : ''}`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- deadlines

const DEADLINES_FILE = path.join(DATA_DIR, 'deadlines.json');
async function readDeadlines() {
  try { const j = JSON.parse(await fsp.readFile(DEADLINES_FILE, 'utf8')); return Array.isArray(j.items) ? j.items : []; } catch { return []; }
}
async function writeDeadlines(items) {
  await writeJsonAtomic(DEADLINES_FILE, { version: 1, items });
}
function normaliseDeadline(input, existing = {}) {
  const title = String(input.title === undefined ? existing.title : input.title || '').trim().slice(0, 160);
  if (!title) throw new Error('title required');
  const due = String(input.due === undefined ? existing.due : input.due || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due must be YYYY-MM-DD');
  const track = String(input.track === undefined ? existing.track : input.track || 'uni').trim().toLowerCase();
  if (!['work', 'uni', 'personal'].includes(track)) throw new Error('track must be work, uni or personal');
  return {
    id: existing.id || crypto.randomUUID(), title, due, track,
    area: String(input.area === undefined ? existing.area : input.area || '').trim().slice(0, 40) || null,
    note: String(input.note === undefined ? existing.note : input.note || '').trim().slice(0, 1000),
    done: input.done === undefined ? Boolean(existing.done) : Boolean(input.done),
    // Snooze hides it from Home until that day; archive puts it away without calling it done.
    snoozedUntil: (() => { const v = input.snoozedUntil === undefined ? existing.snoozedUntil : input.snoozedUntil; return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; })(),
    archived: input.archived === undefined ? Boolean(existing.archived) : Boolean(input.archived),
    created: existing.created || new Date().toISOString(), updated: new Date().toISOString(),
  };
}
// Calendar all-day events that read like deadlines are surfaced too, read-only.
function calendarDeadlines(calendar) {
  return ((calendar && calendar.events) || []).filter((e) => /\b(due|deadline|submission|submit|hand[- ]?in|exam)\b/i.test(e.title)).map((e) => ({
    id: 'cal:' + e.ts + ':' + e.title, title: e.title, due: new Date(e.ts).toISOString().slice(0, 10), track: /exam|assignment|essay|coursework|module/i.test(e.title) ? 'uni' : 'work', area: e.cal || 'Calendar', note: '', done: false, fromCalendar: true,
  }));
}

// ---------------------------------------------------------------- push to phone (ntfy)

// Meridian posts to an ntfy topic; the ntfy app on the phone subscribes to it.
// The topic is a random secret stored in config.json → notify.topic. Messages
// stay short and contain no private text beyond titles Owner already sees.
function ensureNotifyConfig() {
  if (CONFIG.notify && CONFIG.notify.topic) return;
  CONFIG.notify = { provider: 'ntfy', url: 'https://ntfy.sh', topic: 'meridian-' + crypto.randomBytes(9).toString('base64url'), enabled: true, events: ['delegation', 'fleet', 'deadline'] };
  void saveConfig().catch((e) => console.error('could not save notify config', e.message));
}
// Every push passes pings.js first: kinds Owner switched off, the same words
// twice in 6 hours, and quiet hours (held, then sent as one summary). Meeting
// nudges have their own switch (config.json → nudges.enabled) as well.
// `actions` become ntfy buttons (view or http), which the iPhone ntfy app shows.
const heldPings = pings.createHeld(path.join(DATA_DIR, 'pings-held.json'));
async function notify(title, message, { tags = [], priority = 3, click = null, event = null, actions = null } = {}) {
  if (!enabled('notify')) return false;
  const n = CONFIG.notify || {};
  if (!n.topic || n.enabled === false) return false;
  const { verdict, why } = pings.decide({ rules: n, event, priority, title, message, history: await readNotificationLog(), now: Date.now() });
  if (verdict === 'hold') { await heldPings.add({ title, message, event, click }); await recordNotification({ title, message, event, ok: false, held: true }); return false; }
  if (verdict !== 'send') { if (why === 'sent already') console.log(`push skipped (${why}): ${title}`); return false; }
  return sendPush(n, { title, message, tags, priority, click, event, actions });
}
// JSON publishing: titles with "·" or "→" can't go in an HTTP header.
async function sendPush(n, { title, message, tags = [], priority = 3, click = null, event = null, actions = null }) {
  if (!enabled('notify')) return false;
  const body = { topic: n.topic, title, message, priority: Number(priority) || 3, tags };
  if (click) body.click = click;
  if (Array.isArray(actions) && actions.length) body.actions = actions.slice(0, 3);
  const r = await fetchUrl(`${n.url || 'https://ntfy.sh'}/`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, timeout: 6000 });
  const ok = r.status >= 200 && r.status < 300;
  await recordNotification({ title, message, event, ok, status: r.status });
  return ok;
}
// When quiet hours end, whatever was held goes out as one ping.
async function releaseHeldPings() {
  if (!enabled('notify')) return false;
  const n = CONFIG.notify || {};
  if (!n.topic || n.enabled === false) return;
  const held = await heldPings.take(n);
  const s = pings.summary(held);
  if (s) await sendPush(n, { title: s.title, message: s.message, click: s.click || phoneUrl(), tags: ['sunrise'], event: 'summary' });
}
let notificationWrite = Promise.resolve();
async function readNotificationLog() {
  try { const value = JSON.parse(await fsp.readFile(NOTIFY_LOG_FILE, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; }
}
function recordNotification(entry) {
  notificationWrite = notificationWrite.then(async () => {
    const history = await readNotificationLog();
    history.push({ ...entry, time: Date.now() });
    await fsp.writeFile(NOTIFY_LOG_FILE, JSON.stringify(history.slice(-500), null, 2) + '\n');
  }).catch((e) => console.error('notification history failed:', e.message));
  return notificationWrite;
}
const dashboardUrl = () => `https://${(CONFIG.tailscale && CONFIG.tailscale.hostname) || '127.0.0.1:4980'}/dashboard`;
// The phone layout lives inside the dashboard's Home Screen scope, so a ping opens in the app.
const phoneUrl = () => dashboardUrl() + '/phone';

// Fire notifications on transitions only: a site going down (or back up), a
// delegation finishing or failing, a deadline within 24 hours (once a day).
let lastFleet = null; let lastRuns = null; let lastDeadlinePing = null;
async function notifyTransitions(fleet, delegations, deadlines) {
  try {
    const probes = [...(fleet.services || []), ...(fleet.sites || [])].filter((p) => !p.paused);
    if (lastFleet) {
      for (const p of probes) {
        const prev = lastFleet.get(p.name);
        if (prev === undefined || prev === p.up) continue;
        await notify(p.up ? `${p.name} is back up` : `${p.name} is down`, p.up ? `${p.ms} ms · ${p.url}` : `${p.status ? 'HTTP ' + p.status : 'No response'} · ${p.url}`, { tags: [p.up ? 'white_check_mark' : 'rotating_light'], priority: p.up ? 2 : 4, click: dashboardUrl() + '#fleet', event: 'fleet' });
      }
    }
    lastFleet = new Map(probes.map((p) => [p.name, p.up]));
    const runs = (delegations && delegations.runs) || [];
    if (lastRuns) {
      for (const r of runs) {
        const prev = lastRuns.get(r.id);
        if (prev && prev !== r.status && ['done', 'failed', 'stalled'].includes(r.status)) {
          await notify(r.status === 'done' ? 'Agent finished' : `Agent ${r.status}`, `${r.title} · ${r.model}`, { tags: [r.status === 'done' ? 'robot' : 'warning'], priority: r.status === 'done' ? 3 : 4, click: dashboardUrl() + '#agents', event: 'delegation' });
        }
      }
    }
    lastRuns = new Map(runs.map((r) => [r.id, r.status]));
    const today = new Date().toISOString().slice(0, 10);
    if (lastDeadlinePing !== today && new Date().getHours() >= 8) {
      lastDeadlinePing = today;
      const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
      const soon = deadlines.filter((d) => !d.done && !d.archived && !(d.snoozedUntil && d.snoozedUntil > today) && d.due >= today && d.due <= tomorrow);
      if (soon.length) await notify(soon.length === 1 ? `Due ${soon[0].due === today ? 'today' : 'tomorrow'}: ${soon[0].title}` : `${soon.length} deadlines in the next day`, soon.map((d) => `${d.due === today ? 'Today' : 'Tomorrow'} · ${d.title}`).join('\n'), { tags: ['calendar'], priority: 4, click: dashboardUrl() + '#today', event: 'deadline' });
    }
  } catch (e) { console.error('notify failed', e.message); }
}

// ---------------------------------------------------------------- usage

// Which views Owner actually opens, by day. Link opens are counted in the
// links store; this covers the dashboard views so unused ones can go.
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
// 'brief' is the command centre's Brief tab; 'brief-standalone' counts GET /
// (the brief on its own), so the two can be compared.
const USAGE_VIEWS = new Set(['today', 'links', 'journal', 'projects', 'agents', 'fleet', 'home', 'shelf', 'usage', 'dogfood', 'system', 'brief', 'brief-standalone', 'phone', 'phone-today', 'phone-agents', 'phone-money', 'phone-more', 'phone-tell']);
async function readUsage() {
  try { const j = JSON.parse(await fsp.readFile(USAGE_FILE, 'utf8')); return { days: j.days || {} }; } catch { return { days: {} }; }
}
// Serialised: the page and GET / can both record at once.
let usageWrite = Promise.resolve();
function recordUsage(view) {
  const next = usageWrite.then(() => recordUsageNow(view));
  usageWrite = next.catch(() => {});
  return next;
}
// One standalone-brief open per client per 10 minutes, matching the command
// centre's own noteUsage throttle. Only browsers count, not link checks.
const briefOpens = new Map();
function noteStandaloneBrief(req) {
  if (!JOBS_ENABLED) return;
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla/.test(ua)) return;
  const who = `${req.socket.remoteAddress || ''}|${ua}`;
  const bucket = Math.floor(Date.now() / 600000);
  if (briefOpens.get(who) === bucket) return;
  briefOpens.set(who, bucket);
  if (briefOpens.size > 500) briefOpens.clear();
  recordUsage('brief-standalone').catch((e) => console.error('usage record failed:', e.message));
}
async function recordUsageNow(view) {
  if (!USAGE_VIEWS.has(view)) throw new Error('bad view');
  const data = await readUsage();
  const day = new Date().toISOString().slice(0, 10);
  data.days[day] = data.days[day] || {};
  data.days[day][view] = (data.days[day][view] || 0) + 1;
  const keep = Object.keys(data.days).sort().slice(-90);
  data.days = Object.fromEntries(keep.map((k) => [k, data.days[k]]));
  await fsp.mkdir(path.dirname(USAGE_FILE), { recursive: true });
  await fsp.writeFile(USAGE_FILE, JSON.stringify(data, null, 2) + '\n');
  return data;
}
async function usageSummary() {
  const data = await readUsage();
  const since = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const week = {}; const all = {};
  for (const [day, views] of Object.entries(data.days)) {
    for (const [v, n] of Object.entries(views)) { all[v] = (all[v] || 0) + n; if (day >= since) week[v] = (week[v] || 0) + n; }
  }
  return { week, all, days: Object.keys(data.days).length };
}

// ---------------------------------------------------------------- meetings: invites and nudges

// meeting-nudges.js. Defaults: on, 10 and 1 minutes before, and never the
// daily 09:15 Example Agency WIP (Owner asked never to be reminded of it).
// Override with config.json → nudges: { enabled, minutes, skip }.
const nudgeSettings = () => meetingNudges.nudgeConfig(CONFIG.nudges);
let nudgeInputs = { events: [], invites: [], unmatched: [] };
const nudger = meetingNudges.createNudger({
  file: path.join(DATA_DIR, 'nudges.json'),
  announce: (n) => broadcastEvent('nudge', { id: n.id, title: n.title, start: n.start, minutes: n.minutes, joinUrl: n.joinUrl }),
  send: (n) => notify(n.title, n.body, { tags: ['calendar'], priority: n.minutes <= 1 ? 5 : 4, click: n.joinUrl || dashboardUrl(), event: 'meeting' }),
});
async function nudgeTick() {
  if (!enabled('nudges')) return;
  try {
    const cfg = nudgeSettings();
    const sent = await nudger.tick(meetingNudges.nudgeCandidates(nudgeInputs, cfg), cfg);
    for (const n of sent) console.log(`nudge: ${n.title} (${n.minutes} min) push=${n.pushed}`);
  } catch (e) { console.error('nudge tick failed:', e && e.message || e); }
}

// ---------------------------------------------------------------- brief learning

// brief-learning.js: what Owner does with intake items, per sender and
// channel, rewritten whenever an outcome changes. The Daily brief reads it.
const learning = briefLearning.createLearning(path.join(DATA_DIR, 'brief-learning.json'));
let delegatedProjects = { at: 0, ids: [] };
async function delegatedProjectIds() {
  if (Date.now() - delegatedProjects.at < 5 * 60 * 1000) return delegatedProjects.ids;
  const dir = path.join(STORAGE_ROOT, 'delegations');
  const ids = new Set();
  for (const id of await fsp.readdir(dir).catch(() => [])) {
    try { const meta = JSON.parse(await fsp.readFile(path.join(dir, id, 'meta.json'), 'utf8')); if (meta.projectId) ids.add(meta.projectId); } catch { /* not a run */ }
  }
  delegatedProjects = { at: Date.now(), ids: [...ids] };
  return delegatedProjects.ids;
}
async function updateLearning(intakeItems, feedback, projects) {
  try {
    await learning.update({ intakeItems, feedback, projects, delegatedProjectIds: await delegatedProjectIds() });
  } catch (e) { console.error('brief learning failed:', e && e.message || e); }
}

// ---------------------------------------------------------------- GitHub

const github = githubLib.createGithub();

// ---------------------------------------------------------------- connect page and demo mode

// GET /api/connect (connect.js): what Meridian found on this Mac and what is
// still missing. Calendar feeds arrive masked; the ntfy topic is never read out.
const connectInfo = createConnect({
  enabled: runtime.portableProfile() ? enabled : null,
  github: () => github.get(),
  ghBin: githubLib.findGh(),
  tailnet: () => collectTailnet(),
  calendars: () => calendars.list(),
  notify: () => (CONFIG.notify ? { provider: CONFIG.notify.provider || 'ntfy', topic: Boolean(CONFIG.notify.topic), enabled: CONFIG.notify.enabled !== false } : null),
  lastPush: async () => (await readNotificationLog()).slice(-1)[0] || null,
  ledger: async () => {
    const lg = (state && state.ledger && state.at) ? state.ledger : await collectLedger();
    const job = ((state && state.fleet && state.fleet.agents) || []).find((a) => a.label === 'uk.example.meridian-ledger');
    return lg && lg.latest ? { date: lg.latest.date, schedule: lg.schedule, exitStatus: job ? job.exitStatus : null } : null;
  },
  intake: async () => { const bi = await readBriefIntake(); return bi.updatedAt ? { updatedAt: bi.updatedAt, items: bi.items.length, sources: (bi.window && bi.window.sources) || [] } : null; },
  inbox: CONFIG.vaultInbox,
  chrome: HAS_CHROME,
});

// /api/demo/* (demo.js): made-up data for screen recordings. It never sees
// Meridian's state; the model list is the only real thing handed in.
const demo = createDemo({ engines: () => ({ labels: engineLabels(), default: defaultModelLabel() }) });

// ---------------------------------------------------------------- capture

// Captures land in Stash as notes since 6 Oct 2026; config capture.to = "vault" puts them back in the vault Inbox.
const captureTo = () => (CONFIG.capture && CONFIG.capture.to) || 'stash';
const captures = createCapture({ inbox: CONFIG.vaultInbox, trashDir: path.join(DATA_DIR, 'trash', 'inbox'), stash: () => stash, to: captureTo });
// Drafts written with an agent, shown in the Mac app's side panel (drafts.js). `panel` events on
// /api/stream tell the command centre to open them; it hands them to MeridianApp.panel.
const drafts = draftsLib.createDrafts({ file: path.join(DATA_DIR, 'drafts.json') });
const openDraft = (d) => broadcastEvent('panel', { action: 'draft', id: d.id, title: d.title, url: '/draft?id=' + d.id });
const draftTools = draftsLib.createTools(drafts, {
  open: openDraft,
  browse: (url) => broadcastEvent('panel', { action: 'browse', url }),
  addTodo: async (input, check) => { const t = await todosStore.create(input, check); refreshState(); return t; },
  overview: async () => { const json = await agentView(); return { json, md: agentLib.markdown(json) }; },
});
// The dashboard for agents (agent.js): /api/agent, /agent.md and the meridian_overview tool.
async function agentView() {
  return agentLib.summarize(state, { drafts: await drafts.list({ limit: 10 }), base: state.tailnet?.host ? 'https://' + state.tailnet.host : '' });
}
const mcpGrants = createGrants({ dataDir: DATA_DIR });
const draftRoutes = draftsLib.createRoutes({ drafts, tools: draftTools, jsonBody, sendJson, open: openDraft, token: CONFIG.token, mcpToken: CONFIG.mcpToken, grants: mcpGrants });
// Meridian's own voice (voice.js): /api/voice/* sets up a WebRTC call to OpenAI for /voice/index.html and
// /voice/call.html, with the key kept here. The page runs the draft tools itself, as "Voice".
const voice = createVoice({ dataDir: DATA_DIR, drafts, config: CONFIG.voice || {},
  readSoul: () => fsp.readFile(path.join(DATA_DIR, 'soul.md'), 'utf8') });

// ---------------------------------------------------------------- stash

// Screenshots, links, notes and files kept from either Mac or the phone (stash.js).
// Every change goes out on the SSE stream as a `stash` event so open pages update.
const stash = createStash({
  dir: path.join(DATA_DIR, 'stash'),
  preview: (key, url) => preview(key, url, true),
  visionSrc: path.join(ROOT, 'scripts', 'stash-vision.swift'),
  visionBin: path.join(ROOT, 'scripts', 'stash-vision'),
  onChange: (e) => broadcastEvent('stash', e),
  // One-line summaries for notes (stash-summary.js): config stash.summary picks the model.
  summarise: enabled('stashSummary') ? createSummariser({ settings: () => (CONFIG.stash && CONFIG.stash.summary) || {}, claudeBin: CLAUDE_BIN, cwd: DATA_DIR }).summarise : null,
});
stash.load().catch((e) => console.error('stash: load failed', e.message));
// Stash on /mcp, beside the draft tools (stash-tools.js). Things in a "private" space stay out of it.
draftTools.push(...createStashTools(stash, {
  base: () => (state.tailnet?.host ? 'https://' + state.tailnet.host : ''),
  hiddenSpaces: () => (CONFIG.stash && CONFIG.stash.agentHiddenSpaces) || ['private'],
}));

// ---------------------------------------------------------------- money

// Monzo's sheet and Trading 212, read once a day (money.js). Behind its own
// passcode and never part of state or the stream.
const money = createMoney({ dir: path.join(DATA_DIR, 'money'), approvedClaims: () => CONFIG.money?.approvedClaims || {} });

// ---------------------------------------------------------------- tell

// One box for anything Owner wants changed, from the phone or the Action Button (tell.js).
// Notes about money go into the Money tab's own notes, never anywhere else.
const moneyNotes = {
  add: (note) => queueFile(money.files('context'), async () => {
    const cur = await moneyLib.readJson(money.files('context'), {});
    const id = 'tell-' + crypto.randomBytes(4).toString('hex');
    await moneyLib.writeJson(money.files('context'), moneyLib.cleanContext({ notes: [{ id, ...note }, ...(cur.notes || [])] }, cur));
    return id;
  }),
  remove: (id) => queueFile(money.files('context'), async () => {
    const cur = await moneyLib.readJson(money.files('context'), {});
    await moneyLib.writeJson(money.files('context'), moneyLib.cleanContext({ notes: (cur.notes || []).filter((n) => n.id !== id) }, cur));
  }),
};
// Meridian fixes from Tell go through the same Dogfood route as the dashboard's box.
function selfJson(method, route, body) {
  if (!JOBS_ENABLED) return Promise.reject(runtime.jobsOffError());
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: CONFIG.port || 4980, path: route, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ } if (res.statusCode >= 400 || j.ok === false) reject(new Error(j.error || `HTTP ${res.statusCode}`)); else resolve(j); });
    });
    req.on('error', reject); req.end(data);
  });
}
const tell = createTell({
  dir: DATA_DIR,
  getState: () => state,
  todos: todosStore, drafts, captures, notify, moneyNotes,
  addDeadline: (input) => queueFile(DEADLINES_FILE, async () => { const items = await readDeadlines(); const item = normaliseDeadline(input); items.push(item); await writeDeadlines(items); return item; }),
  removeDeadline: (id) => queueFile(DEADLINES_FILE, async () => { const items = await readDeadlines(); await writeDeadlines(items.filter((d) => d.id !== id)); }),
  startFix: (text) => selfJson('POST', '/api/feedback', { text }),
  refresh: () => { void refreshState(); },
  soulDefault: (() => { try { return fs.readFileSync(path.join(ROOT, 'soul.default.md'), 'utf8'); } catch { return ''; } })(),
  model: () => (CONFIG.tell && CONFIG.tell.model) || 'sonnet',
  phoneUrl: () => phoneUrl(),
  claudeBin: CLAUDE_BIN,
});
// todo-rank.js: Home's to-dos in order of urgency, with a reason each. Reranks in the background.
const ranker = createRanker({
  dir: DATA_DIR,
  getState: () => state,
  model: () => (CONFIG.tell && CONFIG.tell.model) || 'sonnet',
  claudeBin: CLAUDE_BIN,
  onChange: () => { void refreshState(); },
});

// ---------------------------------------------------------------- state assembly

let state = { at: 0 };
let stateSnapshot = null;
const sources = createSources({ onError: (name, error) => console.error(`collector ${name} failed:`, error.message || error) });
const refreshState = createRefresh(() => JOBS_ENABLED && !runtime.portableProfile() ? refreshLiveState() : runtime.portableProfile() ? refreshPortableState() : refreshDiskState());
let diskRefresh;

function invalidateState() { stateSnapshot = null; }

async function collectForState(name, fn, fallback) {
  void refreshState();
  const value = await sources.collect(name, fn, { fallback, retained: fallback !== undefined });
  state.sources = { ...state.sources, ...sources.snapshot() };
  return value;
}

// HTTP reads and new stream clients share the broadcast's exact snapshot.
function serializedState(view) {
  if (!stateSnapshot || stateSnapshot.value !== state) {
    const json = JSON.stringify(state);
    stateSnapshot = { value: state, json, event: 'event: state\ndata: ' + json + '\n\n', gzip: null };
  }
  if (view !== 'phone') return stateSnapshot;
  return stateSnapshot.phone ||= { value: state, json: JSON.stringify(phoneState(state)), gzip: null };
}

// A second daemon reads saved records without syncing, probing or learning.
// Missing collector snapshots stay empty until the normal daemon updates them.
function refreshDiskState() {
  if (diskRefresh) return diskRefresh;
  const read = async (name, fn, fallback) => {
    const lastAttempt = Date.now();
    try {
      const value = await fn();
      sources.observe(name, { lastAttempt, lastSuccess: Date.now(), durationMs: Date.now() - lastAttempt });
      return value;
    } catch (error) {
      sources.observe(name, { lastAttempt, durationMs: Date.now() - lastAttempt, error: error.code || error.message });
      return fallback;
    }
  };
  const disk = (name, file, fallback) => read(name, async () => JSON.parse(await fsp.readFile(path.join(DATA_DIR, file), 'utf8')), fallback);
  diskRefresh = (async () => {
    const [projects, links, todos, deadlines, briefIntake, briefFeedback, workBrief, notifyHistory] = await Promise.all([
      read('projects', () => projectsStore.read(), { projects: [] }), read('links', () => linksStore.read(), { links: [] }),
      read('todos', () => todosStore.read(), { todos: [] }), read('savedDeadlines', readDeadlines, []),
      disk('syncedIntake', 'brief-intake.json', { items: [], pending: 0 }), disk('briefFeedback', 'brief-feedback.json', { items: [] }),
      disk('workBrief', 'work-brief.json', null), read('notifyHistory', readNotificationLog, []),
    ]);
    const delegations = sandboxDelegations ? await read('delegations', collectDelegations, { runs: [] }) : { runs: [] };
    const syncedTodos = sandboxDelegations ? await syncTodoDelegations(delegations) : todosStore.sort(todos.todos);
    for (const name of ['board', 'ai', 'fleet', 'git', 'brain', 'threads', 'calendar', 'pulse', 'system', 'ledger', 'meetings', 'drift', ...(sandboxDelegations ? [] : ['delegations']), 'campaignSnapshot', 'exampleappFeedback', 'tailnet', 'localServers']) sources.observe(name, { error: 'collectors disabled' });
    const health = heartHealth.collect();
    sources.observe('heartHealth', heartHealth.source());
    sources.observe('github', github.source());
    sources.observe('todoRank', ranker.source());
    state = {
      at: Date.now(), sources: sources.snapshot(), machine: CONFIG.machine, location: runtime.portableProfile() ? { name: runtime.configuredPlace()?.name || '' } : CONFIG.location,
      board: { cards: [] }, projects, links, todos: syncedTodos, deadlines,
      ai: { sessions: [], liveCount: 0, todayCount: 0 }, fleet: { services: [], sites: [], agents: [] },
      git: { repos: [] }, brain: {}, threads: { tasks: [] }, calendar: { events: [], configured: false },
      pulse: { events: [] }, system: {}, ledger: { entries: [], now: '', latest: null }, meetings: { items: [] },
      drift: { strays: [] }, delegations, briefIntake, briefFeedback, workBrief,
      campaignSnapshot: null, heartHealth: health, exampleappFeedback: { ...JSF_EMPTY },
      tailnet: await collectTailnet(), local: { servers: [] }, notifyHistory,
      engines: engineLabels(), defaultModel: defaultModelLabel(), capabilities: { previews: false },
      journalToday: {}, todoRank: ranker.peek(), captureTo: captureTo(), notify: null,
      vaultJournalDir: CONFIG.vaultInbox ? vaultJournalDir() : null, invites: [], outlookMeetings: [],
      nudges: { ...nudgeSettings(), push: false }, github: github.get(),
    };
    if (runtime.portableProfile()) {
      if (runtime.DEMO) {
        const fictional = await read('demo', () => fsp.readFile(path.join(DATA_DIR, 'demo-state.json'), 'utf8').then(JSON.parse), {});
        state = { ...fictional, ...state, calendar: fictional.calendar, ai: fictional.ai, fleet: fictional.fleet,
          git: fictional.git, pulse: fictional.pulse, github: fictional.github, journalToday: fictional.journalToday };
      }
      for (const name of Object.keys(state.sources)) {
        if (state.sources[name].error === 'ENOENT' || state.sources[name].error === 'collectors disabled') sources.observe(name, { error: null });
      }
      state.sources = sources.snapshot();
      state.setup = runtime.setup();
      state.notify = CONFIG.notify ? { ...CONFIG.notify, topic: undefined, quiet: pings.quietOf(CONFIG.notify) } : null;
    }
    broadcast();
    return state;
  })().finally(() => { diskRefresh = null; });
  return diskRefresh;
}

async function refreshPortableState() {
  await refreshDiskState();
  const collectors = {
    board: ['board', collectBoard], ai: ['ai', collectAI], fleet: ['fleet', collectFleet], git: ['git', collectGit],
    brain: ['brain', collectBrain], threads: ['threads', collectThreads], calendar: ['calendar', collectCalendar],
    system: ['system', collectSystem], ledger: ['ledger', collectLedger], meetings: ['meetings', collectMeetings],
    drift: ['drift', collectDrift], delegations: ['delegations', collectDelegations], campaignSnapshot: ['campaignSnapshot', collectSmokingSnapshot],
    exampleappFeedback: ['exampleappFeedback', collectExampleappFeedback], tailscale: ['tailnet', collectTailnet],
  };
  for (const [name, [key, collect]] of Object.entries(collectors)) {
    if (enabled(name)) state[key] = await sources.collect(name, collect, { fallback: state[key], deadline: Date.now() + 15000 });
  }
  if (enabled('localServers')) state.local = { servers: await collectLocalServers(state.tailnet) };
  if (enabled('linkMetadata')) state.links = await collectLinks();
  if (enabled('todoRank')) ranker.maybeRefresh();
  state.github = enabled('github') ? github.get() : { at: null, user: null, prs: [], reviews: [], merged: [], failing: [], error: null };
  state.capabilities.previews = enabled('previews') && HAS_CHROME;
  state.setup = runtime.setup();
  state.sources = sources.snapshot();
  broadcast();
  return state;
}

async function refreshLiveState() {
  const deadline = Date.now() + 15000;
  try {
    // All phases share one deadline. Failures keep the last successful value.
    const safe = (name, fn, fallback, options = {}) => sources.collect(name, fn, {
      deadline, fallback, ...options,
    });
    const [syncedIntake, tailnet] = await Promise.all([
      safe('syncedIntake', syncBriefIntake, { intake: (state && state.briefIntake) || { items: [], pending: 0 }, projects: (state && state.projects) || [] }),
      safe('tailnet', collectTailnet, state.tailnet || { host: null, ip: null }, { retained: Boolean(state.tailnet), cached: Boolean(tailnetCache.info && Date.now() - tailnetCache.at < 10 * 60000) }),
    ]);
    const [board, ai, fleet, git, brain, threads, calendarRaw, system, ledger, meetings, drift, delegations, briefFeedback, campaignSnapshot, local, links, exampleappFeedback] = await Promise.all([
      safe('board', collectBoard, (state.board ?? { cards: [] }), { retained: state.board !== undefined }),
      safe('ai', collectAI, (state.ai ?? { sessions: [], liveCount: 0, todayCount: 0 }), { retained: state.ai !== undefined }),
      safe('fleet', collectFleet, (state.fleet ?? { services: [], sites: [], agents: [] }), { retained: state.fleet !== undefined }),
      safe('git', collectGit, (state.git ?? { repos: [] }), { retained: state.git !== undefined, cached: Date.now() - repoCache.at < 4 * 60000 }),
      safe('brain', collectBrain, (state.brain ?? {}), { retained: state.brain !== undefined, cached: Boolean(brainCache.data && Date.now() - brainCache.at < 10 * 60000), describe: value => ({ error: value.error || null }) }),
      safe('threads', collectThreads, (state.threads ?? { tasks: [] }), { retained: state.threads !== undefined, describe: value => ({ error: value.up === false ? 'Threads fetch failed' : null }) }),
      safe('calendar', collectCalendar, (state.calendar ?? { events: [], configured: false }), { retained: state.calendar !== undefined, cached: Boolean(calCache.at && Date.now() - calCache.at < ((CONFIG.calendar && CONFIG.calendar.refreshMinutes) || 10) * 60000), describe: value => ({ error: value.calendars?.some(c => !c.hidden && c.ok === false) ? 'calendar feed refresh failed' : null, stale: value.calendars?.some(c => !c.hidden && c.ok === false && calendars.status(c.id)?.lastOk != null) || false }) }),
      safe('system', collectSystem, (state.system ?? {}), { retained: state.system !== undefined }),
      safe('ledger', collectLedger, (state.ledger ?? { entries: [], now: '', latest: null }), { retained: state.ledger !== undefined }),
      safe('meetings', collectMeetings, (state.meetings ?? { items: [] }), { retained: state.meetings !== undefined }),
      safe('drift', collectDrift, (state.drift ?? { strays: [] }), { retained: state.drift !== undefined }),
      safe('delegations', collectDelegations, (state.delegations ?? { runs: [] }), { retained: state.delegations !== undefined }),
      safe('briefFeedback', collectBriefFeedback, (state.briefFeedback ?? { items: [] }), { retained: state.briefFeedback !== undefined }),
      safe('campaignSnapshot', collectSmokingSnapshot, (state.campaignSnapshot ?? null), { retained: state.campaignSnapshot !== undefined, cached: Boolean(campaignSnapshotCache.data && Date.now() - campaignSnapshotCache.at < (Number(CONFIG.campaignSnapshot?.refreshMinutes) || 10) * 60000), describe: value => ({ error: value?.error || null, stale: value?.stale || false }) }),
      safe('localServers', () => collectLocalServers(tailnet), (state && state.local && state.local.servers) || [], { retained: Boolean(state.local), cached: Date.now() - localCache.at < 20000 }),
      safe('links', collectLinks, (state.links ?? { links: [], categories: [] }), { retained: state.links !== undefined }),
      safe('exampleappFeedback', collectExampleappFeedback, (state.exampleappFeedback ?? { ...JSF_EMPTY }), { retained: state.exampleappFeedback !== undefined }),
    ]);
    // Join links and invite status from the automations onto the calendar,
    // plus the invites list (meeting-nudges.js). calCache stays untouched.
    const intakeRaw = await safe('intakeRaw', readBriefIntake, { items: [], invites: state.invites || [], meetings: state.outlookMeetings || [] });
    const meetingsMerged = meetingNudges.mergeMeetings((calendarRaw && calendarRaw.events) || [], intakeRaw, { now: Date.now() });
    const calendar = { ...calendarRaw, events: meetingsMerged.events };
    nudgeInputs = { events: meetingsMerged.events, invites: meetingsMerged.invites, unmatched: meetingsMerged.unmatched };
    await safe('learning', () => updateLearning(intakeRaw.items, briefFeedback, (syncedIntake.projects && syncedIntake.projects.projects) || []), null);
    const pulse = await safe('pulse', () => collectPulse(git, ai, board), (state.pulse ?? { events: [] }), { retained: state.pulse !== undefined });
    await safe('journalSync', syncJournalFromLedger, null);
    const journalToday = todaySoFar(pulse, ai, delegations);
    const todos = await safe('todos', () => syncTodoDelegations(delegations), (state.todos ?? []), { retained: state.todos !== undefined });
    const deadlines = [...(await safe('savedDeadlines', readDeadlines, [])), ...calendarDeadlines(calendar)].sort((a, b) => a.due.localeCompare(b.due));
    await safe('notifyTransitions', () => notifyTransitions(fleet, delegations, deadlines), null);
    const notifyHistory = await safe('notifyHistory', readNotificationLog, (state.notifyHistory ?? []), { retained: state.notifyHistory !== undefined });
    const health = heartHealth.collect();
    const githubState = github.get();
    const todoRank = ranker.peek();
    const workBrief = await safe('workBrief', async () => JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'work-brief.json'), 'utf8')), state.workBrief || null, { retained: Boolean(state.workBrief) });
    sources.observe('heartHealth', heartHealth.source());
    sources.observe('github', github.source());
    sources.observe('todoRank', ranker.source());
    state = {
      at: Date.now(), sources: sources.snapshot(), machine: CONFIG.machine, location: CONFIG.location,
      board, projects: syncedIntake.projects, ai, fleet, git: { repos: git.repos }, brain, threads, calendar, pulse, system,
      ledger, meetings, drift, delegations, briefFeedback, briefIntake: syncedIntake.intake, campaignSnapshot, heartHealth: health,
      workBrief,
      exampleappFeedback,
      tailnet, local: { servers: local }, links, notifyHistory,
      engines: engineLabels(), defaultModel: defaultModelLabel(),
      capabilities: { previews: HAS_CHROME },
      journalToday, deadlines, todos, todoRank, captureTo: (CONFIG.capture && CONFIG.capture.to) || 'stash',
      // The topic is the ntfy secret, so it stays off the state stream (the Connect page shows it on purpose).
      notify: CONFIG.notify ? { provider: CONFIG.notify.provider || 'ntfy', url: CONFIG.notify.url || 'https://ntfy.sh', enabled: CONFIG.notify.enabled !== false, events: CONFIG.notify.events || [], muted: CONFIG.notify.muted || [], quiet: pings.quietOf(CONFIG.notify) } : null,
      vaultJournalDir: vaultJournalDir(),
      invites: meetingsMerged.invites,
      outlookMeetings: meetingsMerged.unmatched,
      nudges: { ...nudgeSettings(), push: Boolean(CONFIG.notify && CONFIG.notify.topic && CONFIG.notify.enabled !== false) },
      github: githubState,
    };
    try { ranker.maybeRefresh(); } catch (e) { console.error('todo-rank', e.message); }
    broadcast();
  } catch (e) {
    console.error('refresh failed', e);
  }
  return state;
}

// ---------------------------------------------------------------- SSE

const sseClients = new Set();
const SSE_MAX_BYTES = 2 * 1024 * 1024;
const SSE_MAX_WAIT = 60000;

function dropSse(client) {
  sseClients.delete(client); client.pending = null; client.close();
}

function sendSse(client, payload, isState = false) {
  const buffered = client.buffered();
  if (buffered + (client.pending ? Buffer.byteLength(client.pending) : 0) > SSE_MAX_BYTES || Buffer.byteLength(payload) > SSE_MAX_BYTES || (client.blockedAt && Date.now() - client.blockedAt > SSE_MAX_WAIT)) { dropSse(client); return; }
  if (client.blockedAt || client.needsDrain()) {
    client.blockedAt = client.blockedAt || Date.now();
    if (isState) {
      if (buffered + Buffer.byteLength(payload) > SSE_MAX_BYTES) { dropSse(client); return; }
      client.pending = payload;
      return;
    }
  }
  if (buffered + (client.pending ? Buffer.byteLength(client.pending) : 0) + Buffer.byteLength(payload) > SSE_MAX_BYTES) { dropSse(client); return; }
  try {
    if (!client.write(payload)) client.blockedAt = client.blockedAt || Date.now();
    if (client.buffered() > SSE_MAX_BYTES) dropSse(client);
  } catch { dropSse(client); }
}

function drainSse(client) {
  if (!sseClients.has(client)) return;
  if (client.buffered() > 0 || client.needsDrain()) return;
  client.blockedAt = 0;
  const pending = client.pending; client.pending = null;
  if (pending) sendSse(client, pending, true);
}

function sweepSse() {
  for (const client of sseClients) {
    if (client.buffered() > SSE_MAX_BYTES || (client.blockedAt && Date.now() - client.blockedAt > SSE_MAX_WAIT)) dropSse(client);
    else drainSse(client);
  }
}

function broadcast() {
  invalidateState();
  const payload = serializedState().event;
  for (const client of sseClients) sendSse(client, payload, true);
}

// A named event alongside the state stream (e.g. `nudge`).
function broadcastEvent(name, data) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) sendSse(client, payload);
}

// ---------------------------------------------------------------- gzip

// The phone reaches Meridian over Tailscale, often on mobile data, and the
// state alone is ~185 KB of JSON (~38 KB gzipped). Text goes out gzipped
// whenever the client asks for it.
const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
const GZIP_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.md', '.txt', '.webmanifest']);
const gzipped = new Map(); // static file -> { etag, body }, rebuilt when the file changes
const gzip = (buf) => new Promise((resolve, reject) => zlib.gzip(buf, (e, out) => (e ? reject(e) : resolve(out))));

async function sendJsonGzip(req, res, status, value, headers = {}) {
  const json = JSON.stringify(value);
  if (!acceptsGzip(req) || json.length < 1024) { res.writeHead(status, { 'Content-Type': 'application/json', Vary: 'Accept-Encoding', ...headers }); res.end(json); return; }
  const body = await gzip(json);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ...headers });
  res.end(body);
}

async function sendState(req, res, view) {
  const snapshot = serializedState(view);
  const headers = { 'Content-Type': 'application/json', Vary: 'Accept-Encoding' };
  if (view === 'phone') headers['Cache-Control'] = 'no-store';
  if (!acceptsGzip(req) || snapshot.json.length < 1024) { res.writeHead(200, headers); res.end(snapshot.json); return; }
  // Concurrent reads share the same compression job, including its result.
  snapshot.gzip ||= gzip(snapshot.json).catch((error) => { snapshot.gzip = null; throw error; });
  const body = await snapshot.gzip;
  res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
  res.end(body);
}

// An SSE client whose stream is gzipped: each event is flushed straight
// through so it arrives as soon as it is sent.
function gzipEventStream(res) {
  const z = zlib.createGzip();
  const client = {
    blockedAt: 0, pending: null,
    write(s) { const ok = z.write(s); z.flush(zlib.constants.Z_SYNC_FLUSH, () => drainSse(client)); return ok && !res.writableNeedDrain; },
    buffered() { return z.writableLength + z.readableLength + res.writableLength; },
    needsDrain() { return z.writableNeedDrain || res.writableNeedDrain; },
    close() { z.destroy(); res.destroy(); },
  };
  // A small compressed frame may never reach the socket's drain threshold.
  // Its write callback still tells us when the bytes have left the queue.
  z.on('data', (chunk) => { if (!res.write(chunk, () => drainSse(client))) z.pause(); });
  z.on('error', () => dropSse(client));
  z.on('drain', () => drainSse(client));
  res.on('drain', () => { z.resume(); drainSse(client); });
  return client;
}

function plainEventStream(res) {
  const client = {
    blockedAt: 0, pending: null,
    write(s) { return res.write(s, () => drainSse(client)); },
    buffered() { return res.writableLength; },
    needsDrain() { return res.writableNeedDrain; },
    close() { res.destroy(); },
  };
  res.on('drain', () => drainSse(client));
  return client;
}

// ---------------------------------------------------------------- http

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function isTailnet(req) {
  const raw = req.socket.remoteAddress || '';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  const match = address.match(/^100\.(\d+)\.\d+\.\d+$/);
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return false;
    if (u.host.toLowerCase() === String(req.headers.host || '').toLowerCase()) return true;
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === (CONFIG.port || 4980)) return true;
    const hosts = [CONFIG.tailscale && CONFIG.tailscale.hostname, tailnetCache.info && tailnetCache.info.host].filter(Boolean).map((h) => h.toLowerCase().replace(/\.$/, ''));
    return hosts.includes(u.hostname) && (u.protocol === 'https:' ? !u.port || u.port === '443' : Number(u.port || 80) === (CONFIG.port || 4980));
  } catch { return false; }
}

// Tailscale Serve hands tailnet requests over from 127.0.0.1 (X-Forwarded-For a 100.x address); Funnel would hand
// internet ones over the same way, marked Tailscale-Funnel-Request. Those need the token like anyone else.
function authorized(req, url) {
  // An explicit grant never inherits owner access merely because it arrived locally.
  if (mcpGrants.recognizes(bearer(req)) || mcpGrants.recognizes(url.searchParams.get('t')) || mcpGrants.recognizes(req.headers['x-meridian-token'])) return false;
  if ((isLoopback(req) && !draftsLib.fromInternet(req)) || isTailnet(req)) return true;
  if (!CONFIG.token) return false;
  const t = url.searchParams.get('t') || req.headers['x-meridian-token'];
  if (typeof t !== 'string' || typeof CONFIG.token !== 'string') return false;
  const given = Buffer.from(t), token = Buffer.from(CONFIG.token);
  return given.length === token.length && crypto.timingSafeEqual(given, token);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const ART_CACHE_DIR = path.join(CACHE_DIR, 'art');

function fetchArt(imageId) {
  if (!enabled('artwork')) return Promise.reject(runtime.jobsOffError());
  const url = `https://www.artic.edu/iiif/2/${imageId}/full/1400,/0/default.jpg`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Referer: 'https://www.artic.edu/',
      },
    }, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        reject(new Error('art upstream returned ' + upstream.statusCode));
        return;
      }
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => resolve(Buffer.concat(chunks)));
      upstream.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('art upstream timed out')));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((e) => {
    console.error('request failed:', e);
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'request failed' })); }
    else res.destroy();
  });
});

function connectorForRoute(p, method) {
  if (p.startsWith('/api/local/share') || p.startsWith('/api/local/unshare')) return 'tailscale';
  if (p === '/api/local/stop') return 'localServers';
  if (p === '/api/fleet/pause' || p === '/api/fleet/resume') return 'fleet';
  if (p.startsWith('/api/delegate') || p.startsWith('/api/delegations/') && method !== 'GET' || p === '/api/feedback' || /\/api\/(todos|projects)\/[^/]+\/delegate$/.test(p)) return 'delegations';
  if (p.startsWith('/api/exampleapp-feedback/') && method !== 'GET') return 'exampleappFeedback';
  if (p === '/api/journal/backfill') return 'delegations';
  if (p === '/api/tell' && method === 'POST' || p.startsWith('/api/tell/') && /\/(apply|replan|undo)$/.test(p)) return 'tell';
  if (p.startsWith('/api/voice/') && method !== 'GET') return 'voice';
  if (p.startsWith('/api/money/') && /\/(refresh|advice|t212-key|google|oauth)/.test(p)) return 'money';
  if (p === '/api/notify/test') return 'notify';
  return null;
}

async function handleRequest(req, res) {
  const setupPath = new URL(req.url, 'http://x').pathname;
  if (setupPath === '/api/setup' || setupPath.startsWith('/api/setup/')) {
    if (!runtime.portableProfile()) {
      req.resume(); sendJson(res, 404, { ok: false, error: 'not found' }); return;
    }
    if (!JOBS_ENABLED) {
      req.resume(); sendJson(res, 503, { ok: false, error: 'Meridian jobs are off' }); return;
    }
  }
  if (!JOBS_ENABLED && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sandboxDelegations?.allows(req)) {
    req.resume();
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'Meridian jobs are off' }));
    return;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigin(req)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  let url = new URL(req.url, 'http://x');
  let p = url.pathname;

  // Demo mode (demo.js): /api/demo/<path> answers with made-up data, or names
  // one of a few non-personal GETs (models, almanac, the day's painting, the
  // page's look) to hand on to the real route below. Nothing else falls through.
  if (runtime.DEMO && p.startsWith('/api/demo/')) {
    url.pathname = p.replace('/api/demo/', '/api/');
    p = url.pathname;
  }
  if (!runtime.DEMO && (p === '/api/demo' || p.startsWith('/api/demo/'))) {
    if (!authorized(req, url)) { res.writeHead(403); res.end('forbidden'); return; }
    const through = await demo.handle(req, res, url);
    if (through === true) return;
    url = new URL(through, 'http://x');
    p = url.pathname;
  }

  // The brief reuses the single confirmed desktop image. Never cache a collection.
  if (p === '/api/daily-art' || p === '/api/daily-art/image' || p === '/api/art') {
    if (req.method !== 'GET') { res.writeHead(405); res.end('method not allowed'); return; }
    try {
      const current = dailyArt.readCurrent();
      if (p === '/api/art' && url.searchParams.has('id')) {
        const requested = dailyArt.collection.find(item => item.i === url.searchParams.get('id'));
        if (!requested) { res.writeHead(404); res.end('unknown artwork'); return; }
        const localImage = requested.i === current?.art.i ? dailyArt.currentImage(current)
          : requested.favourite ? path.join(DATA_DIR, 'brief-art', 'favourite.jpg') : null;
        const bytes = localImage ? await fsp.readFile(localImage) : await fetchArtworkImage(requested.i);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
        res.end(bytes);
        return;
      }
      const art = current?.art || dailyArt.collection.find(item => item.favourite);
      if (!art) {
        if (p === '/api/daily-art') sendJson(res, 200, { art: null, date: null, image: null, rating: null });
        else { res.writeHead(404); res.end('no artwork'); }
        return;
      }
      const imagePath = current ? dailyArt.currentImage(current) : path.join(DATA_DIR, 'brief-art', 'favourite.jpg');
      if (p === '/api/daily-art') {
        const saved = await artRatings.read();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ art, date: current?.date || null, image: '/api/daily-art/image?v=' + art.i, rating: saved.ratings[art.i]?.rating || null }));
      } else {
        // ~550 KB: revalidate rather than re-download it on every visit.
        const stat = await fsp.stat(imagePath);
        const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
        const bytes = await fsp.readFile(imagePath);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etag });
        res.end(bytes);
      }
    } catch (error) {
      res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('painting temporarily unavailable');
    }
    return;
  }

  // The almanac (Earth View, Wada colours, weather, moon and friends) is public
  // data served to <img> tags, which cannot carry the page token.
  if (await almanac.handle(req, res, url)) return;
  // The brief's home-screen and shelf icon: today's painting, public like the almanac images.
  if (await briefIcon.handle(req, res, url)) return;

  // Ratings are stored by this daemon and are intentionally available to the
  // same trusted loopback/Tailscale clients as the artwork itself. Keeping
  // this route independent of the page token also fixes cached/PWA clients
  // that were opened on another device without the original query string.
  // /mcp checks its own token for internet requests (the MCP-only one, so a cloud agent never holds the
  // dashboard's), so it comes before the dashboard's check. Everything else is decided by authorized().
  if ((p === '/mcp' || p.startsWith('/mcp/')) && (authorized(req, url) || draftsLib.fromInternet(req) || mcpGrants.recognizes(bearer(req)) || mcpGrants.recognizes(url.searchParams.get('t'))) && await draftRoutes(req, res, url)) return;
  if (!authorized(req, url)) { res.writeHead(403); res.end('forbidden'); return; }
  if (p === '/api/mcp/grants' || p.startsWith('/api/mcp/grants/')) {
    // Grant administration stays with the local/private dashboard owner, outside Funnel.
    if (draftsLib.fromInternet(req) || bearer(req) !== undefined) { res.writeHead(403); res.end('forbidden'); return; }
    if (await mcpGrants.handleAdmin(req, res, url, { jsonBody, sendJson })) return;
    sendJson(res, 404, { ok: false, error: 'not found' }); return;
  }

  if (runtime.portableProfile()) {
    const connector = connectorForRoute(p, req.method);
    if (connector && !enabled(connector)) {
      req.resume(); sendJson(res, 503, { ok: false, error: 'Connector is disabled', connector }); return;
    }
  }

  if (p === '/api/art-ratings' && req.method === 'GET') {
    try {
      const saved = await artRatings.read();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      const current = dailyArt.readCurrent();
      const index = dailyArt.collection.findIndex(art => art.i === current?.art.i);
      const recent = (index < 0 ? [] : dailyArt.collection.slice(Math.max(0, index - 6), index + 1)).reverse().map(art => ({
        artworkId: art.i, title: art.t, artist: art.a, year: art.d, source: art.source,
      }));
      res.end(JSON.stringify({ ...saved, recent }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (p === '/api/art-ratings' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (Object.prototype.hasOwnProperty.call(parsed, 'order')) {
          const order = await artRatings.reorder(parsed.order);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, order }));
          return;
        }
        const artId = String(parsed.artId || '');
        const rating = parsed.rating === null ? null : String(parsed.rating || '');
        const savedRating = await artRatings.set(artId, rating);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, rating: savedRating }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  if (p === '/api/heart-health' && req.method === 'GET') {
    await heartHealth.refresh();
    const report = heartHealth.collect();
    state.heartHealth = report;
    state.sources = { ...state.sources, heartHealth: heartHealth.source() };
    invalidateState();
    res.writeHead(report.stats ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(report));
    return;
  }

  if (p === '/api/state') {
    if (Date.now() - state.at > 60 * 1000) await refreshState();
    await sendState(req, res, url.searchParams.get('view'));
    return;
  }

  if (p === '/api/preferences' && req.method === 'GET') {
    const preferences = await collectPreferences();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(preferences));
    return;
  }

  if (p === '/api/brain/search' && req.method === 'GET') {
    try {
      const limit = Math.max(1, Math.min(40, Number(url.searchParams.get('limit')) || 20));
      const results = await searchBrain(url.searchParams.get('q'), url.searchParams.get('realm'), url.searchParams.get('kind'), limit);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], error: 'brain index unavailable' }));
    }
    return;
  }

  if (p === '/api/brain/preview' && req.method === 'GET') {
    try {
      const index = await loadBrainIndex();
      const node = index.byId.get(String(url.searchParams.get('id') || ''));
      if (!node || !['md', 'txt'].includes(node.ext) || !node.preview) {
        res.writeHead(404); res.end('preview unavailable'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(node.preview.slice(0, 120000));
    } catch {
      res.writeHead(404); res.end('preview unavailable');
    }
    return;
  }

  if (p === '/api/stream') {
    // The full state goes out on every refresh (45 s), so gzip matters most here.
    const gz = acceptsGzip(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    const client = gz ? gzipEventStream(res) : plainEventStream(res);
    sseClients.add(client);
    sendSse(client, 'retry: 5000\n\n');
    if (state.at) sendSse(client, serializedState().event, true);
    res.on('error', () => dropSse(client));
    res.on('close', () => dropSse(client));
    return;
  }

  if (p === '/api/projects' && req.method === 'GET') {
    const projects = await projectsStore.read();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projects));
    return;
  }

  if (p === '/api/projects' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const project = await projectsStore.create(JSON.parse(body || '{}'));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, project }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  const projectMatch = p.match(/^\/api\/projects\/([a-f0-9-]+)$/);
  if (projectMatch && req.method === 'DELETE') {
    const removed = await projectsStore.remove(projectMatch[1]);
    if (!removed) { res.writeHead(404); res.end('not found'); return; }
    refreshState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (projectMatch && req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const project = await projectsStore.update(projectMatch[1], JSON.parse(body || '{}'));
        if (!project) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, project }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- command centre: page titles for new links, and looks that follow Owner between devices
  if (p === '/api/link-meta' && req.method === 'GET') {
    try {
      const page = await pageMeta(url.searchParams.get('url') || '');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...page }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (p === '/api/command/prefs' && req.method === 'GET') {
    let prefs = null;
    try { prefs = JSON.parse(await fsp.readFile(COMMAND_PREFS_FILE, 'utf8')); } catch { /* none saved yet */ }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, prefs }));
    return;
  }
  if (p === '/api/command/prefs' && req.method === 'PUT') {
    // 200 KB: tabs, Spaces, stars, shortcuts and a photo library add up. Too big gets a 413 the page can show, not a dropped socket.
    let body = '', tooBig = false;
    req.on('data', (c) => { if (tooBig) return; body += c; if (body.length > 200000) { tooBig = true; body = ''; } });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'settings too large to save' })); return; }
      try {
        const prefs = JSON.parse(body || '{}');
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('prefs must be an object');
        await queueFile(COMMAND_PREFS_FILE, () => writeJsonAtomic(COMMAND_PREFS_FILE, prefs));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- your own header photos. The page shrinks each one to a JPEG before it
  // uploads; the X-Meridian-Upload header forces a CORS preflight, like Stash's.
  if (p === '/api/command/hero-photo' && req.method === 'POST') {
    try {
      if (!req.headers['x-meridian-upload']) throw Object.assign(new Error('missing X-Meridian-Upload header'), { statusCode: 403 });
      const buffer = await rawBody(req, 15 * 1024 * 1024);
      const ext = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'jpg' : buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
        : buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP' ? 'webp' : null;
      if (!ext) throw Object.assign(new Error('that isn\'t a JPEG, PNG or WebP'), { statusCode: 415 });
      const id = crypto.randomBytes(6).toString('hex');
      // One upload at a time, so two can't both pass the budget check below.
      const turn = heroPhotoQueue.then(async () => {
        await fsp.mkdir(HERO_PHOTO_DIR, { recursive: true });
        await tidyHeroPhotos();
        const names = await fsp.readdir(HERO_PHOTO_DIR);
        let bytes = 0; for (const n of names) bytes += (await fsp.stat(path.join(HERO_PHOTO_DIR, n)).catch(() => ({ size: 0 }))).size;
        if (names.length >= HERO_PHOTO_MAX_FILES || bytes + buffer.length > HERO_PHOTO_MAX_BYTES) throw Object.assign(new Error('no room for more photos: remove some first'), { statusCode: 507 });
        await fsp.writeFile(path.join(HERO_PHOTO_DIR, `${id}.${ext}`), buffer);
      });
      heroPhotoQueue = turn.catch(() => {});
      await turn;
      sendJson(res, 200, { ok: true, id, url: `/api/command/hero-photo/${id}` });
    } catch (e) { sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) }); }
    return;
  }
  { const m = /^\/api\/command\/hero-photo\/([0-9a-f]{12})$/.exec(p);
    if (m && (req.method === 'GET' || req.method === 'DELETE')) {
      // Caught here: a photo deleted between the listing and the read would otherwise reject outside any handler and stop the server.
      try {
        const names = await fsp.readdir(HERO_PHOTO_DIR).catch(() => []);
        const name = names.find(n => n.startsWith(m[1] + '.'));
        if (!name) { res.writeHead(404); res.end('no such photo'); return; }
        if (req.method === 'DELETE') { await fsp.rm(path.join(HERO_PHOTO_DIR, name), { force: true }); sendJson(res, 200, { ok: true }); return; }
        const bytes = await fsp.readFile(path.join(HERO_PHOTO_DIR, name));
        const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[name.split('.').pop()];
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
      } catch (e) {
        if (!res.headersSent) { res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(e.code === 'ENOENT' ? 'no such photo' : 'could not read that photo'); }
      }
      return;
    } }

  // ---- link hub
  if (p === '/api/links' && req.method === 'GET') {
    try {
      const links = await collectLinks();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(links));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ links: [], categories: [], error: String(e.message || e) }));
    }
    return;
  }

  if (p === '/api/links' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const link = await linksStore.create(JSON.parse(body || '{}'));
        state.links = await collectForState('links', collectLinks, state.links); broadcast();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, link }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  if (p === '/api/links/categories' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const categories = await linksStore.setCategories(JSON.parse(body || '{}').categories);
        state.links = await collectForState('links', collectLinks, state.links); broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, categories }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // Shelf categories: rename (merging into an existing one) and remove
  // (moving its links, to "Other" by default). Both go through the store's
  // write chain like every other links.json change.
  if ((p === '/api/links/rename-category' || p === '/api/links/remove-category') && req.method === 'POST') {
    try {
      const body = await jsonBody(req, 4000);
      const result = p.endsWith('rename-category')
        ? await linksStore.renameCategory(body.from, body.to)
        : await linksStore.removeCategory(body.name, body.moveTo);
      state.links = await collectForState('links', collectLinks, state.links); broadcast();
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  const linkMatch = p.match(/^\/api\/links\/([a-f0-9-]+)(\/open)?$/);
  if (linkMatch && linkMatch[2] && req.method === 'POST') {
    const link = await linksStore.touch(linkMatch[1]);
    if (!link) { res.writeHead(404); res.end('not found'); return; }
    if (state.links) { const i = state.links.links.findIndex((l) => l.id === link.id); if (i >= 0) state.links.links[i] = { ...state.links.links[i], ...link }; }
    invalidateState(); // the snapshot cache would otherwise keep the old open count
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, link }));
    return;
  }
  if (linkMatch && !linkMatch[2] && (req.method === 'PATCH' || req.method === 'DELETE')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        if (req.method === 'DELETE') {
          const removed = await linksStore.remove(linkMatch[1]);
          if (!removed) { res.writeHead(404); res.end('not found'); return; }
          linkHealth.delete(linkMatch[1]);
          state.links = await collectForState('links', collectLinks, state.links); broadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const link = await linksStore.update(linkMatch[1], JSON.parse(body || '{}'));
        if (!link) { res.writeHead(404); res.end('not found'); return; }
        linkHealth.delete(link.id); // url may have changed; re-probe on next refresh
        state.links = await collectForState('links', collectLinks, state.links); broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, link }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- previews (screenshots)
  if (p === '/api/preview' && req.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    const linkId = url.searchParams.get('link');
    const port = Number(url.searchParams.get('port'));
    let key = null; let target = null;
    if (linkId && /^[a-f0-9-]+$/.test(linkId)) {
      const data = await linksStore.read();
      const link = data.links.find((l) => l.id === linkId);
      if (link && link.preview !== false) { key = 'link-' + link.id; target = link.url; }
    } else if (port && port > 0 && port < 65536) {
      key = 'port-' + port; target = `http://127.0.0.1:${port}/`;
    }
    if (!key) { res.writeHead(404); res.end('no preview'); return; }
    try {
      const file = await preview(key, target, force);
      if (file === 'pending') { res.writeHead(404, { 'Retry-After': '4', 'Cache-Control': 'no-store' }); res.end('rendering'); return; }
      if (!file) { res.writeHead(404); res.end('preview unavailable'); return; }
      const shot = await previewThumb(file);
      const stat = await fsp.stat(shot.file);
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=600' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': shot.type, 'Cache-Control': 'private, max-age=600', ETag: etag });
      res.end(await fsp.readFile(shot.file));
    } catch { res.writeHead(404); res.end('preview unavailable'); }
    return;
  }

  // ---- journal
  if (p === '/api/journal/backfill' && req.method === 'POST') {
    // Hands the history job to a Codex agent with the brief in scripts/journal-backfill-prompt.md.
    try {
      const id = await startJournalBackfill(url.searchParams.get('from') || '2026-06-01');
      setTimeout(() => { refreshState(); }, 1500);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (p === '/api/journal/sync' && req.method === 'POST') {
    importedLedgers.clear();
    if (url.searchParams.get('reset') === '1') {
      // Re-derive every ledger entry (after a parser or area-name change). Manual and agent entries are untouched.
      const data = await journalStore.read();
      for (const e of data.entries.filter((x) => x.source === 'ledger')) await journalStore.remove(e.id);
    }
    const n = await syncJournalFromLedger();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, added: n }));
    return;
  }
  if (p === '/api/journal' && req.method === 'GET') {
    await sendJsonGzip(req, res, 200, await journalStore.read(), { 'Cache-Control': 'no-store' }); // ~135 KB, a fifth of that gzipped
    return;
  }
  if (p === '/api/journal/report' && req.method === 'GET') {
    const data = await journalStore.read();
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'md';
    const body = journalReport(data, { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined, track: url.searchParams.get('track') || 'work', format });
    res.writeHead(200, { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="time-report.${format}"` });
    res.end(body);
    return;
  }
  if (p === '/api/journal/export-vault' && req.method === 'POST') {
    const data = await journalStore.read();
    await exportJournalDays(data.entries.map((e) => e.date));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dir: vaultJournalDir(), days: new Set(data.entries.map((e) => e.date)).size }));
    return;
  }

  // ---- deadlines
  if (p === '/api/deadlines' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ items: await readDeadlines() }));
    return;
  }
  if (p === '/api/deadlines' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        await queueFile(DEADLINES_FILE, async () => {
          const items = await readDeadlines();
          const item = normaliseDeadline(JSON.parse(body || '{}'));
          items.push(item); await writeDeadlines(items); refreshState();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, item }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  const dlMatch = p.match(/^\/api\/deadlines\/([a-f0-9-]+)$/);
  if (dlMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        await queueFile(DEADLINES_FILE, async () => {
          const items = await readDeadlines();
          const i = items.findIndex((d) => d.id === dlMatch[1]);
          if (i < 0) { res.writeHead(404); res.end('not found'); return; }
          if (req.method === 'DELETE') items.splice(i, 1); else items[i] = normaliseDeadline(JSON.parse(body || '{}'), items[i]);
          await writeDeadlines(items); refreshState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, item: items[i] || null }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- pinned order (one write for the whole list)
  if (p === '/api/links/pin-order' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const list = await linksStore.setPinOrder(JSON.parse(body || '{}').ids);
        refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, links: list.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- favicons
  // Fetched and cached here rather than through a public favicon service,
  // because most of Owner's links are Tailscale hosts that only this Mac can
  // reach. 404 means "no icon", and the dashboard draws a monogram instead.
  if (p === '/api/favicon' && req.method === 'GET') {
    const linkId = url.searchParams.get('link');
    let target = url.searchParams.get('url') || '';
    if (linkId) {
      const data = await linksStore.read();
      const link = data.links.find((l) => l.id === linkId);
      if (!link) { res.writeHead(404); res.end('no link'); return; }
      target = link.url;
    }
    // The brief's icon is today's painting: skip the 14-day favicon cache for it.
    if (briefIcon.isBriefUrl(target, { port: CONFIG.port || 4980, hosts: [CONFIG.tailscale?.hostname] })) {
      await briefIcon.send(req, res, 'svg', { cacheControl: 'no-cache' });
      return;
    }
    let origin;
    try { origin = new URL(target).origin; } catch { res.writeHead(400); res.end('bad url'); return; }
    const icon = await faviconFor(origin, url.searchParams.has('refresh'));
    if (!icon) { res.writeHead(404, { 'Cache-Control': 'public, max-age=900' }); res.end('no icon'); return; }
    res.writeHead(200, { 'Content-Type': icon.type, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    res.end(icon.buffer);
    return;
  }

  // ---- to-dos
  // Owner's own list, as opposed to the derived "needs you" items. Add,
  // reorder, prioritise, tick off, or hand one to a model.
  if (p === '/api/todos' && req.method === 'GET') {
    const data = await todosStore.read();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ todos: todosStore.sort(data.todos) }));
    return;
  }
  if (p === '/api/todos' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const todo = await todosStore.create(JSON.parse(body || '{}'));
        refreshState();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, todo }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  // Urgency order with a reason per to-do (todo-rank.js). POST ranks again now.
  if (p === '/api/todos/rank' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const rank = req.method === 'POST' ? await ranker.refresh() : ranker.peek();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...rank }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (p === '/api/todos/reorder' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const todos = await todosStore.reorder(JSON.parse(body || '{}').ids);
        refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, todos }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  if (p === '/api/todos/clear-done' && req.method === 'POST') {
    const removed = await todosStore.clearDone();
    refreshState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, removed }));
    return;
  }
  const todoDelegateMatch = p.match(/^\/api\/todos\/([a-f0-9-]+)\/delegate$/);
  if (todoDelegateMatch && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = await todosStore.read();
        const todo = data.todos.find((t) => t.id === todoDelegateMatch[1]);
        if (!todo) throw new Error('to-do not found');
        if (todo.delegation && todo.delegation.status === 'running') throw new Error('already running');
        const model = String(JSON.parse(body || '{}').model || defaultModelLabel());
        const card = `# ${todo.title}\n\n${todo.note || 'No further detail was given. Ask for what is missing in the report rather than inventing it.'}`;
        const id = await startDelegation(null, todo.title, model, null, { card, kind: 'todo', todoId: todo.id });
        const updated = await todosStore.update(todo.id, { delegation: { id, model, status: 'running', started: Date.now() } });
        refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, todo: updated }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  const todoMatch = p.match(/^\/api\/todos\/([a-f0-9-]+)$/);
  if (todoMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        if (req.method === 'DELETE') {
          const removed = await todosStore.remove(todoMatch[1]);
          refreshState();
          res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: removed }));
          return;
        }
        const todo = await todosStore.update(todoMatch[1], JSON.parse(body || '{}'));
        if (!todo) { res.writeHead(404); res.end('not found'); return; }
        refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, todo }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- stop a local dev server
  // Owner asked to be able to turn one off from the card. SIGTERM only, never
  // this daemon, and only a port that is actually in the detected list. A
  // Tailscale mapping Meridian made for it goes too; anyone else's stays.
  if (p === '/api/local/stop' && req.method === 'POST') {
    try {
      const port = localShare.validPort((await jsonBody(req, 2000)).port);
      if (port === (CONFIG.port || 4980)) throw new Error('that is Meridian itself');
      const servers = await localServersWith(port);
      const server = servers.find((sv) => sv.port === port);
      if (!server) throw new Error('no dev server on that port');
      if (server.pid === process.pid) throw new Error('that is Meridian itself');
      process.kill(server.pid, 'SIGTERM');
      let unshared = null;
      if ((await serveShares.owned())[port]) unshared = await serveShares.unshare(port).catch((e) => ({ ok: false, error: String(e.message || e) }));
      localCache.at = 0;
      setTimeout(() => { refreshLocal().catch(() => {}); }, 1200);
      sendJson(res, 200, { ok: true, port, pid: server.pid, unshared });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // ---- share a local dev server on the tailnet (Tailscale Serve HTTPS)
  if (p === '/api/local/share' && req.method === 'POST') {
    try {
      const port = localShare.validPort((await jsonBody(req, 2000)).port);
      if (port === (CONFIG.port || 4980)) throw new Error('Meridian is already shared on :443');
      const servers = await localServersWith(port);
      if (!servers.some((sv) => sv.port === port)) throw Object.assign(new Error('no dev server on that port'), { statusCode: 404 });
      const result = await serveShares.share(port);
      await refreshLocal();
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }
  // force:true removes a mapping Meridian did not make (agents made most),
  // after saving `serve status --json` to audit/<date>-serve/. Without it,
  // only Meridian's own mappings go (409 otherwise).
  if (p === '/api/local/unshare' && req.method === 'POST') {
    try {
      const body = await jsonBody(req, 2000);
      const port = localShare.validPort(body.port);
      const force = body.force === true;
      if (force && port === (CONFIG.port || 4980)) throw Object.assign(new Error('that is Meridian itself'), { statusCode: 409 });
      const result = await serveShares.unshare(port, force ? { force: true, backup: backupServeStatus } : {});
      await refreshLocal();
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e), ...(e.skipped ? { skipped: e.skipped } : {}) });
    }
    return;
  }

  // ---- Sites and services: pause / resume (fleet-pause.js)
  if ((p === '/api/fleet/pause' || p === '/api/fleet/resume') && req.method === 'POST') {
    try {
      const name = String((await jsonBody(req, 2000)).name || '');
      const entry = fleetEntry(name);
      if (!entry) throw Object.assign(new Error('no service or site with that name'), { statusCode: 404 });
      let result;
      if (p === '/api/fleet/pause') {
        const info = (await fleetPause.annotate({ services: CONFIG.fleet.services || [], sites: CONFIG.fleet.sites || [], launchctlList: (await run('launchctl', ['list'])) || '' })).get(name);
        result = await fleetPause.pause(entry, info);
      } else {
        result = await fleetPause.resume(name);
      }
      probeStates.delete(name); latencyHistory.delete(name);
      state.fleet = await collectForState('fleet', collectFleet, state.fleet);
      broadcast();
      sendJson(res, 200, { ...result, fleet: state.fleet });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }
  // Hide (or, with ignored:false, un-hide) a server Owner keeps running.
  if (p === '/api/local/ignore' && req.method === 'POST') {
    try {
      const body = await jsonBody(req, 2000);
      const asked = Number.isInteger(Number(body.port)) && body.port !== null && body.port !== '' ? Number(body.port) : null;
      const result = await localIgnore.set(body, asked === null ? await collectLocalServers(await collectTailnet()) : await localServersWith(asked));
      await refreshLocal();
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // ---- models: one list for both front ends, plus newer ids seen locally
  if (p === '/api/engines' && req.method === 'GET') {
    try {
      sendJson(res, 200, await modelRegistry.engines({ force: url.searchParams.get('refresh') === '1' }));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e.message || e) });
    }
    return;
  }
  if (p === '/api/engines/adopt' && req.method === 'POST') {
    try {
      const adopted = await modelRegistry.adopt(await jsonBody(req, 4000));
      if (state.at) { state.engines = engineLabels(); state.defaultModel = defaultModelLabel(); broadcast(); }
      sendJson(res, 200, { ok: true, ...adopted, engines: await modelRegistry.engines() });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // ---- notifications
  if (p === '/api/notify/test' && req.method === 'POST') {
    const ok = await notify('Meridian test', 'Push to phone is working. This came from your Mac over ntfy.', { tags: ['sunny'], click: dashboardUrl() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, topic: CONFIG.notify && CONFIG.notify.topic }));
    return;
  }
  if (p === '/api/notify' && req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      try {
        const patch = JSON.parse(body || '{}');
        CONFIG.notify = CONFIG.notify || {};
        if (patch.enabled !== undefined) CONFIG.notify.enabled = Boolean(patch.enabled);
        if (Array.isArray(patch.events)) CONFIG.notify.events = patch.events.filter((e) => ['delegation', 'fleet', 'deadline'].includes(e));
        // The phone's "What pings you": kinds switched off, and quiet hours.
        if (Array.isArray(patch.muted)) CONFIG.notify.muted = patch.muted.filter((e) => pings.KINDS.includes(e) && e !== 'reminder');
        if (patch.quiet && typeof patch.quiet === 'object') {
          const q = pings.quietOf({ quiet: { ...pings.quietOf(CONFIG.notify), ...patch.quiet } });
          CONFIG.notify.quiet = { on: patch.quiet.on === undefined ? q.on : Boolean(patch.quiet.on), from: q.from, to: q.to };
        }
        await saveConfig();
        refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, notify: { ...CONFIG.notify, topic: undefined, quiet: pings.quietOf(CONFIG.notify) } }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  if (p === '/api/journal.md' && req.method === 'GET') {
    const data = await journalStore.read();
    const md = journalStore.toMarkdown(data, { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="journal.md"' });
    res.end(md);
    return;
  }
  if (p === '/api/journal' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 40000) req.destroy(); });
    req.on('end', async () => {
      try {
        const entry = await journalStore.create(JSON.parse(body || '{}'));
        exportJournalDays([entry.date]).catch(() => {});
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, entry }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  if (p === '/api/journal/areas' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const areas = await journalStore.setAreas(JSON.parse(body || '{}').areas);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, areas }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  const journalMatch = p.match(/^\/api\/journal\/([a-f0-9-]+)$/);
  if (journalMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 40000) req.destroy(); });
    req.on('end', async () => {
      try {
        if (req.method === 'DELETE') {
          const before = (await journalStore.read()).entries.find((e) => e.id === journalMatch[1]);
          const removed = await journalStore.remove(journalMatch[1]);
          if (!removed) { res.writeHead(404); res.end('not found'); return; }
          if (before) exportJournalDays([before.date]).catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const before = (await journalStore.read()).entries.find((e) => e.id === journalMatch[1]);
        const entry = await journalStore.update(journalMatch[1], JSON.parse(body || '{}'));
        if (!entry) { res.writeHead(404); res.end('not found'); return; }
        exportJournalDays([entry.date, before && before.date]).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, entry }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- usage
  if (p === '/api/usage' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(await usageSummary()));
    return;
  }
  if (p === '/api/usage' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', async () => {
      try {
        await recordUsage(String(JSON.parse(body || '{}').view || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---- AI Usage menu bar app: per-machine activity reports, merged for an all-Macs total
  if (p === '/api/ai-usage' && req.method === 'GET') {
    const dir = path.join(DATA_DIR, 'ai-usage');
    let hosts = [];
    try {
      const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try { hosts.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))); } catch {}
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ hosts }));
    return;
  }
  if (p === '/api/ai-usage' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const report = JSON.parse(body || '{}');
        const host = String(report.host || '').replace(/[^A-Za-z0-9._-]/g, '');
        if (!host || typeof report.days !== 'object') throw new Error('host and days required');
        const dir = path.join(DATA_DIR, 'ai-usage');
        await fsp.mkdir(dir, { recursive: true });
        await queueFile(path.join(dir, host + '.json'), () => writeJsonAtomic(path.join(dir, host + '.json'), { ...report, host, receivedAt: Date.now() }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  if (p === '/api/local' && req.method === 'GET') {
    localCache.at = 0;
    const servers = await collectLocalServers(await collectTailnet());
    state.local = { servers };
    invalidateState();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ servers, tailnet: state.tailnet || null }));
    return;
  }

  // Capture into the vault Inbox (capture.js). The id is the file's stamp;
  // POST /api/capture/<id>/undo within 30 minutes moves it to data/trash/inbox/.
  const diskDraftStream = !JOBS_ENABLED && req.method === 'GET' && p.match(/^\/api\/drafts\/([a-f0-9-]+)\/stream$/);
  if (diskDraftStream) {
    const draft = await drafts.get(diskDraftStream[1]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('retry: 3000\n\nevent: draft\ndata: ' + JSON.stringify(draft) + '\n\n');
    return;
  }
  if (await draftRoutes(req, res, url)) return;
  if (await voice.handle(req, res, url, { jsonBody, sendJson })) return;
  if ((p === '/api/agent' || p === '/agent.md' || p === '/agent.txt') && req.method === 'GET') {
    const view = await agentView();
    if (p === '/api/agent') { sendJson(res, 200, view); return; }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(agentLib.markdown(view));
    return;
  }

  if (p === '/api/capture' && req.method === 'POST') {
    try {
      const { text } = await jsonBody(req, 200000);
      sendJson(res, 200, await captures.capture(typeof text === 'string' ? text : ''));
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }
  const captureUndo = p.match(/^\/api\/capture\/([^/]{1,40})\/undo$/);
  if (captureUndo && req.method === 'POST') {
    try {
      let id = '';
      try { id = decodeURIComponent(captureUndo[1]); } catch { throw Object.assign(new Error('bad capture id'), { statusCode: 400 }); }
      sendJson(res, 200, await captures.undo(id));
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // ---- stash (stash.js). JSON writes need a JSON content type and uploads an
  // X-Stash header: both force a CORS preflight, so other sites can't post here.
  if (p === '/api/stash' || p.startsWith('/api/stash/')) {
    const fail = (e) => sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    const isJson = String(req.headers['content-type'] || '').startsWith('application/json');
    try {
      if (p === '/api/stash' && req.method === 'GET') {
        const q = url.searchParams;
        sendJson(res, 200, await stash.list({ q: q.get('q') || '', kind: q.get('kind') || '', space: q.get('space') || '', order: q.get('order') || 'new',
          limit: Math.max(1, Math.min(1000, Number(q.get('limit')) || 300)), offset: Math.max(0, Number(q.get('offset')) || 0) }));
        return;
      }
      if (p === '/api/stash' && req.method === 'POST') {
        if (!isJson) throw Object.assign(new Error('send JSON'), { statusCode: 415 });
        const body = await jsonBody(req, 400000);
        sendJson(res, 200, await stash.addText(body));
        return;
      }
      if (p === '/api/stash/file' && req.method === 'POST') {
        if (!req.headers['x-stash']) throw Object.assign(new Error('missing X-Stash header'), { statusCode: 403 });
        const q = url.searchParams;
        const buffer = await rawBody(req, 80 * 1024 * 1024);
        const page = q.get('pageUrl') || q.get('pageTitle') ? { url: q.get('pageUrl') || '', title: q.get('pageTitle') || '', app: q.get('pageApp') || '' } : null;
        sendJson(res, 200, await stash.addFile(buffer, { name: q.get('name') || '', type: q.get('type') || req.headers['content-type'] || '', source: q.get('source') || 'upload',
          from: q.get('from') || '', note: q.get('note') || '', title: q.get('title') || '', spaces: q.get('spaces') || '', page }));
        return;
      }
      if (p === '/api/stash/seen' && req.method === 'POST') {
        if (!isJson) throw Object.assign(new Error('send JSON'), { statusCode: 415 });
        const body = await jsonBody(req);
        sendJson(res, 200, await stash.markSeen(body.at));
        return;
      }
      if (p === '/api/stash/spaces' && req.method === 'PUT') {
        if (!isJson) throw Object.assign(new Error('send JSON'), { statusCode: 415 });
        const body = await jsonBody(req);
        sendJson(res, 200, await stash.setSpaces(body.order));
        return;
      }
      const m = p.match(/^\/api\/stash\/([a-z0-9]{8,20})(?:\/(file|thumb|icon|similar|restore|refresh))?$/);
      if (!m || !STASH_ID.test(m[1])) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
      const [, id, sub] = m;
      if (!sub && req.method === 'GET') { sendJson(res, 200, { ok: true, item: await stash.get(id) }); return; }
      if (!sub && req.method === 'PATCH') {
        if (!isJson) throw Object.assign(new Error('send JSON'), { statusCode: 415 });
        sendJson(res, 200, await stash.patch(id, await jsonBody(req, 100000)));
        return;
      }
      if (!sub && req.method === 'DELETE') { sendJson(res, 200, await stash.remove(id)); return; }
      if (sub === 'restore' && req.method === 'POST') { sendJson(res, 200, await stash.restore(id)); return; }
      if (sub === 'refresh' && req.method === 'POST') { sendJson(res, 200, await stash.refresh(id)); return; }
      if (sub === 'similar' && req.method === 'GET') { sendJson(res, 200, await stash.similar(id)); return; }
      if (['file', 'thumb', 'icon'].includes(sub) && req.method === 'GET') {
        const f = await stash.filePath(id, sub);
        let st = null;
        try { st = f && await fsp.stat(f.file); } catch { /* gone */ }
        if (!st) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('no ' + sub); return; }
        const headers = { 'Content-Type': f.type, 'Cache-Control': 'private, max-age=86400', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
        if (sub === 'icon' || f.type === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        // SVGs and HTML-ish files download rather than render, so a kept file can't run script on this origin.
        const risky = !/^(image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff)|video\/|application\/pdf|text\/plain)/.test(f.type);
        if (sub === 'file' && (url.searchParams.get('download') === '1' || risky)) headers['Content-Disposition'] = `attachment; filename="${String(f.name || 'stash').replace(/["\\\r\n]/g, '')}"`;
        // Ranges, so videos can seek.
        const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
        if (range && sub === 'file') {
          const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
          if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
          pipeline(fs.createReadStream(f.file, { start, end }), res, (e) => { if (e) console.error('stash stream failed:', e.message); });
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        pipeline(fs.createReadStream(f.file), res, (e) => { if (e) console.error('stash stream failed:', e.message); });
        return;
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) { fail(e); }
    return;
  }

  if (p === '/api/delegate' && req.method === 'POST') {
    try {
      const { file, title, model, projectId, effort, prompt } = await jsonBody(req);
      // "Ask an agent to set this up" on the Connect page sends a written
      // brief instead of a card. It runs inside Meridian like a Dogfood fix
      // (files snapshotted, Undo works, it shows in Dogfood).
      if (!file && !projectId && typeof prompt === 'string') {
        // A JSON body forces a CORS preflight, so no other site can start one.
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('send JSON');
        const request = prompt.trim().slice(0, 8000);
        if (!request) throw new Error('say what to set up');
        const name = String(title || request.split('\n')[0]).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Set up a connection';
        const id = await startDelegation(null, name, model, null, { kind: 'feedback', source: 'meridian-connect', request, effort });
        await refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }
      if (!projectId && (!file || !/^[\w.-]+\.md$/.test(file))) throw new Error('bad delegation source');
      if (projectId && !/^[a-f0-9-]+$/.test(projectId)) throw new Error('bad project id');
      if (projectId && pendingProjectDelegations.has(projectId)) throw new Error('project delegation already starting');
      if (projectId) pendingProjectDelegations.add(projectId);
      try {
        if (projectId) {
          const existing = await collectDelegations();
          if (existing.runs.some((run) => run.projectId === projectId && run.status === 'running')) {
            throw new Error('project delegation already running');
          }
        }
        const id = await startDelegation(file || null, title || file, model, projectId || null, { effort });
        if (projectId) {
          await projectsStore.update(projectId, { status: 'active' });
          await markBriefIntakeDelegated(projectId);
        }
        await refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      } finally {
        if (projectId) pendingProjectDelegations.delete(projectId);
      }
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // ---- show where an agent is working, in Finder
  // The agents strip asks for a run's folder or a live session's. Only folders
  // Meridian already knows about: a delegation by id, or a session in state.
  if (p === '/api/reveal' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      try {
        const q = JSON.parse(body || '{}');
        let dir = null;
        if (q.run) {
          if (!/^[\w.-]+$/.test(String(q.run))) throw new Error('bad run id');
          dir = path.join(STORAGE_ROOT, 'delegations', String(q.run));
        } else if (q.session) {
          const s = (state.ai?.sessions || []).find((x) => x.id === String(q.session));
          dir = s && s.cwd;
        }
        if (!dir || !fs.existsSync(dir)) throw new Error('That folder is not there any more');
        await new Promise((resolve, reject) => execFile('open', [dir], (err) => (err ? reject(err) : resolve())));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dir }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  const cancelMatch = p.match(/^\/api\/delegations\/([\w.-]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    try {
      const run = await cancelDelegation(cancelMatch[1]);
      if (state.at) {
        state.delegations = await collectForState('delegations', collectDelegations, state.delegations);
        broadcast();
      } else {
        await refreshState();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, run }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // Dogfood undo: put back what a finished fix changed (see run-changes.js).
  const undoMatch = p.match(/^\/api\/delegations\/([\w.-]+)\/undo$/);
  if (undoMatch && req.method === 'POST') {
    try {
      const result = await undoDelegation(undoMatch[1]);
      if (state.at) { state.delegations = await collectForState('delegations', collectDelegations, state.delegations); broadcast(); }
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e), ...(e.conflicts ? { conflicts: e.conflicts } : {}) });
    }
    return;
  }

  const archiveMatch = p.match(/^\/api\/delegations\/([\w.-]+)\/archive$/);
  if (archiveMatch && req.method === 'POST') {
    try {
      const run = await archiveDelegation(archiveMatch[1]);
      if (state.at) {
        state.delegations = await collectForState('delegations', collectDelegations, state.delegations);
        broadcast();
      } else {
        await refreshState();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, run }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (p === '/api/feedback' && req.method === 'POST') {
    let body = '';
    let bodyBytes = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      bodyBytes += c.length;
      if (bodyBytes > FEEDBACK_BODY_LIMIT) {
        tooLarge = true;
        body = '';
        return;
      }
      body += c;
    });
    req.on('end', async () => {
      try {
        if (tooLarge) {
          const error = new Error('feedback payload is too large');
          error.statusCode = 413;
          throw error;
        }
        const parsed = JSON.parse(body || '{}');
        const text = String(parsed.text || '').trim().slice(0, 8000);
        const incomingAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
        if (!text && !incomingAttachments.length) throw new Error('feedback request or image required');
        const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        const title = (firstLine || 'Image feedback').replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 120);
        const engine = resolveEngine(String(parsed.model || ''), EFFORTS.includes(parsed.effort) ? parsed.effort : null);
        const model = engine.who;
        const captured = new Date();
        const stamp = captured.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const attachmentId = `${stamp}-${slugify(title)}-${Date.now().toString(36)}`;
        const savedAttachments = await saveAttachments(incomingAttachments, {
          root: FEEDBACK_ATTACHMENT_ROOT,
          id: attachmentId,
        });
        const attachmentPrompt = promptFor(savedAttachments);
        const request = [text || 'Please review the attached image(s) and make the requested change.', attachmentPrompt]
          .filter(Boolean).join('\n\n');
        const logFile = path.join(CONFIG.vaultInbox, `feedback-${stamp}-${slugify(title)}.md`);
        const md = `---\ncaptured: ${captured.toISOString()}\nsource: meridian-feedback\nstatus: agent-ready\nmodel: ${model}\n---\n\n# ${title}\n\n${request}\n`;
        await fsp.mkdir(CONFIG.vaultInbox, { recursive: true });
        await fsp.writeFile(logFile, md);
        const id = await startDelegation(null, title, engine.id, null, {
          effort: engine.effort,
          kind: 'feedback',
          source: 'meridian-feedback',
          request,
          requestFile: logFile,
        });
        await refreshState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, file: logFile, model, attachments: savedAttachments.length }));
      } catch (e) {
        res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  if (p === '/api/brief-feedback' && req.method === 'POST') {
    try {
      const { id, action } = await jsonBody(req);
      if (!id || !/^(board|project|threads|calendar):[\w.-]+$/.test(id)) throw new Error('bad item id');
      if (!['complete', 'reject', 'skip'].includes(action)) throw new Error('bad action');
      state.briefFeedback = await saveBriefFeedback(id, action);
      broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, feedback: state.briefFeedback }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // ExampleApp feedback: forward one of Owner's choices to the runner's CLI.
  if (p === '/api/exampleapp-feedback/action' && req.method === 'POST') {
    // These buttons merge and close pull requests, so only Meridian's own page
    // may press them: a JSON body forces a CORS preflight that other sites
    // cannot pass, and any Origin sent must be one of Meridian's hosts.
    if (!String(req.headers['content-type'] || '').startsWith('application/json') || !allowedOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'not allowed' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      const reply = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { reply(400, { ok: false, error: 'bad request body' }); return; }
      const action = typeof parsed.action === 'string' ? parsed.action : '';
      if (!JSF_ACTIONS.has(action)) { reply(400, { ok: false, error: 'bad action' }); return; }
      const rawIssue = parsed.issue;
      const issue = Number.isInteger(rawIssue) ? rawIssue : /^\d{1,9}$/.test(String(rawIssue ?? '')) ? Number(rawIssue) : NaN;
      if (action !== 'run' && !(Number.isInteger(issue) && issue > 0)) { reply(400, { ok: false, error: 'bad issue' }); return; }
      const note = JSF_NOTE_ACTIONS.has(action) && typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 4000) : '';
      if (action === 'revise' && !note) { reply(400, { ok: false, error: 'say what should change' }); return; }
      const key = action === 'run' ? 'run' : `issue:${issue}`;
      if (jsfPending.has(key)) { reply(409, { ok: false, error: 'Already working on that one. Give it a moment.' }); return; }
      jsfPending.add(key);
      try {
        const answer = await runExampleappCli(action, action === 'run' ? null : issue, note);
        if (answer.ok && action === 'test') {
          const previewUrl = jsfUrl(answer.url, false);
          if (!previewUrl) { reply(502, { ok: false, error: 'The runner did not return a usable https preview link.' }); return; }
          answer.url = previewUrl;
        }
        try {
          state.exampleappFeedback = await collectForState('exampleappFeedback', collectExampleappFeedback, state.exampleappFeedback);
          broadcast();
        } catch (e) { console.error('exampleapp feedback reread failed:', e && e.message || e); }
        reply(answer.ok ? 200 : 502, answer);
      } catch (e) {
        reply(500, { ok: false, error: String(e.message || e) });
      } finally {
        jsfPending.delete(key);
      }
    });
    return;
  }

  if (p === '/api/setup' || p.startsWith('/api/setup/')) {
    const match = p.match(/^\/api\/setup\/connectors\/([a-zA-Z]+)$/);
    try {
      if (p === '/api/setup' && req.method === 'GET') { sendJson(res, 200, setupApi.status()); return; }
      if (match && req.method === 'PUT') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) { sendJson(res, 415, { ok: false, error: 'send JSON' }); return; }
        const result = await setupApi.update(match[1], await jsonBody(req, 64000));
        sendJson(res, 200, result); return;
      }
      sendJson(res, p === '/api/setup' || match ? 405 : 404, { ok: false, error: p === '/api/setup' || match ? 'method not allowed' : 'not found' });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'Could not save connector settings' });
    }
    return;
  }

  // ---- calendars (calendars-store.js). Feed links carry secret tokens, so
  // answers only ever show host + "…". Writes need a JSON body, which forces
  // a CORS preflight, so another site open in a browser can't add a feed.
  if (p === '/api/calendars' || p.startsWith('/api/calendars/')) {
    try {
      if (req.method !== 'GET' && req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('send JSON'), { statusCode: 415 });
      if (p === '/api/calendars' && req.method === 'GET') { sendJson(res, 200, { ok: true, ...(await calendars.list()) }); return; }
      if (p === '/api/calendars' && req.method === 'POST') {
        const feed = await calendars.add(await jsonBody(req, 8000), { parse: parseIcsFeed });
        void refreshCalendarNow();
        sendJson(res, 201, { ok: true, feed });
        return;
      }
      if (p === '/api/calendars/classes' && req.method === 'PUT') {
        const classes = await calendars.setClasses(await jsonBody(req, 60000));
        void refreshCalendarNow();
        sendJson(res, 200, { ok: true, classes });
        return;
      }
      const calMatch = p.match(/^\/api\/calendars\/([a-z0-9]{1,24})$/);
      if (calMatch && req.method === 'PATCH') {
        const out = await calendars.patch(calMatch[1], await jsonBody(req, 4000));
        void refreshCalendarNow();
        sendJson(res, 200, out.classes ? { ok: true, ...out } : { ok: true, feed: out });
        return;
      }
      if (calMatch && req.method === 'DELETE') {
        const out = await calendars.remove(calMatch[1]);
        void refreshCalendarNow();
        sendJson(res, 200, out);
        return;
      }
      sendJson(res, calMatch || p === '/api/calendars' ? 405 : 404, { ok: false, error: calMatch || p === '/api/calendars' ? 'method not allowed' : 'not found' });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // ---- the Connect page's list (connect.js), cached for a minute
  if (p === '/api/connect' && req.method === 'GET') {
    try { sendJson(res, 200, await connectInfo.get({ force: url.searchParams.get('refresh') === '1' })); } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    return;
  }

  if (p === '/api/refresh' && req.method === 'POST') {
    connectInfo.bust();
    repoCache.at = 0; calCache.at = 0; brainCache.at = 0; campaignSnapshotCache.at = 0;
    void github.refresh();
    await refreshState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, at: state.at }));
    return;
  }

  // ledger, meeting, and board card files, served read-only as plain text
  const docMatch = p.match(/^\/(ledger|meetings|board)\/([\w.-]+\.md)$/);
  if (docMatch) {
    const dir = docMatch[1] === 'ledger'
      ? ((CONFIG.ledger && CONFIG.ledger.dir) || path.join(STORAGE_ROOT, 'ledger'))
      : docMatch[1] === 'board' ? CONFIG.board.dir
      : (CONFIG.meetings && CONFIG.meetings.dir);
    if (dir) {
      try {
        const data = await fsp.readFile(path.join(dir, docMatch[2]), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(data);
        return;
      } catch { res.writeHead(404); res.end('not found'); return; }
    }
  }

  // delegation outputs (REPORT.md, mockups) served read-only
  const delMatch = p.match(/^\/delegations\/([\w.-]+)\/([\w.-]+)$/);
  if (delMatch) {
    const full = path.join(STORAGE_ROOT, 'delegations', delMatch[1], delMatch[2]);
    try {
      const data = await fsp.readFile(full);
      const ext = path.extname(full);
      const headers = { 'Content-Type': ext === '.html' ? 'text/html' : (MIME[ext] || 'text/plain; charset=utf-8') };
      const sandbox = CONFIG.delegations?.sandboxPreviews;
      // Keep mockup scripts, but give opted-in previews no dashboard origin.
      if ((sandbox === true || sandbox === 'scripts-off') && ['.html', '.svg', '.xml'].includes(ext.toLowerCase())) {
        headers['Content-Security-Policy'] = sandbox === 'scripts-off' ? 'sandbox' : 'sandbox allow-scripts allow-popups allow-forms allow-modals';
        headers['X-Content-Type-Options'] = 'nosniff';
      }
      res.writeHead(200, headers);
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }

  if (await aiUsageLedger.handle(req, res, url)) return;
  if (await money.handle(req, res, url)) return;
  if (await tell.handle(req, res, url, { jsonBody, sendJson })) return;
  // What a widget shows (widget.js): Scriptable on the phone now, WidgetKit later.
  if (p === '/api/widget' && req.method === 'GET') {
    sendJson(res, 200, widgetView(state, { tells: await tell.recent(20).catch(() => []), drafts: await drafts.list({ limit: 12 }).catch(() => []) }));
    return;
  }

  // static. /dashboard is the command centre since 1 Oct 2026; the September
  // build stays at /dashboard-classic.
  // /connect, /quick and /story added 2 Oct 2026. /story redirects to /story/
  // so the story site's relative links (img/, v/) resolve inside its folder.
  // /dashboard/phone (4 Oct 2026) is the phone layout; command.html sends phones
  // there. It sits under /dashboard so it stays inside the Home Screen app's
  // scope. /tell is the same page opening on Tell, for its own Home Screen icon.
  // /stash-sort (6 Oct 2026) is the swipe-to-sort Stash prototype; nothing links to it yet.
  const PAGES = { '/': '/brief-dia.html', '/dashboard': '/command.html', '/command': '/command.html', '/dashboard-classic': '/dashboard.html',
    '/connect': '/connect.html', '/quick': '/quick.html', '/draft': '/draft.html', '/drafts': '/drafts.html', '/story/': '/story/index.html',
    '/dashboard/phone': '/phone.html', '/phone': '/phone.html', '/tell': '/phone.html', '/stash-sort': '/stash-sort.html' };
  if (p === '/story' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(302, { Location: '/story/' + url.search }); res.end(); return; }
  if (p === '/' && req.method === 'GET' && url.searchParams.get('embed') !== '1') noteStandaloneBrief(req);
  // Decoded, so a file with a space (the Shortcuts in /downloads/shortcuts) can be served. The
  // normalise and startsWith check below still keep it inside public/.
  let file = PAGES[p] || (() => { try { return decodeURIComponent(p); } catch { return p; } })();
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, 'public', file);
  if (!full.startsWith(path.join(ROOT, 'public'))) { res.writeHead(404); res.end(); return; }
  try {
    const stat = await fsp.stat(full);
    const ext = path.extname(full);
    // no-cache only means "revalidate first", and a browser cannot revalidate
    // without a validator. Without these a rebuilt dashboard kept being served
    // from cache, on the phone especially.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = new Date(stat.mtimeMs).toUTCString();
    const fresh = req.headers['if-none-match'] === etag
      || (!req.headers['if-none-match'] && req.headers['if-modified-since'] === lastModified);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache' : 'public, max-age=3600',
    };
    const compressible = GZIP_EXT.has(ext) && stat.size > 1024;
    if (compressible) headers.Vary = 'Accept-Encoding';
    if (fresh) { res.writeHead(304, headers); res.end(); return; }
    if (compressible && acceptsGzip(req)) {
      let hit = gzipped.get(full);
      if (!hit || hit.etag !== etag) { hit = { etag, body: await gzip(await fsp.readFile(full)) }; gzipped.set(full, hit); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      res.end(hit.body);
      return;
    }
    res.writeHead(200, headers);
    res.end(await fsp.readFile(full));
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

// ---------------------------------------------------------------- command centre helpers

// Before each forced Tailscale unshare: the whole serve config, so any
// mapping can be put back by hand.
async function backupServeStatus(doc, { port, httpsPort, path: route }) {
  const now = new Date();
  const dir = path.join(STORAGE_ROOT, 'audit', `${now.toISOString().slice(0, 10)}-serve`);
  await fsp.mkdir(dir, { recursive: true });
  const slug = route && route !== '/' ? '-' + route.replace(/[^\w-]+/g, '_').slice(0, 40) : '';
  const file = path.join(dir, `serve-status-${now.toISOString().replace(/[:.]/g, '-')}-port${port}-https${httpsPort}${slug}.json`);
  await fsp.writeFile(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}

const COMMAND_PREFS_FILE = path.join(DATA_DIR, 'command-prefs.json');
const HERO_PHOTO_DIR = path.join(DATA_DIR, 'hero-photos');
// The page keeps at most 60; the files get a little slack for removals still inside their Undo window.
const HERO_PHOTO_MAX_FILES = 80, HERO_PHOTO_MAX_BYTES = 600 * 1024 * 1024;
let heroPhotoQueue = Promise.resolve();
// Photos uploaded but never saved into the library (a closed tab, a failed save) are deleted once they're a day old.
async function tidyHeroPhotos() {
  let saved; try { saved = JSON.parse(await fsp.readFile(COMMAND_PREFS_FILE, 'utf8')); } catch { return; }
  const keep = new Set((Array.isArray(saved.heroPhotos) ? saved.heroPhotos : []).map(x => x && x.id));
  for (const n of await fsp.readdir(HERO_PHOTO_DIR).catch(() => [])) {
    if (keep.has(n.split('.')[0])) continue;
    const full = path.join(HERO_PHOTO_DIR, n); const st = await fsp.stat(full).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 864e5) await fsp.rm(full, { force: true }).catch(() => {});
  }
}

// Request body as JSON, capped. Rejects rather than destroying the socket so
// the caller can still answer with a JSON error.
function jsonBody(req, limit = 20000) {
  return rawBody(req, limit).then((body) => {
    try { const v = JSON.parse(body.toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch { throw new Error('bad JSON body'); }
  });
}

// The request body as bytes, refused past the limit.
function rawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; } else chunks.push(c); });
    req.on('end', () => { if (over) reject(Object.assign(new Error('that file is too large'), { statusCode: 413 })); else resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function sendJson(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function queueFile(file, fn) {
  const next = (fileQueues.get(file) || Promise.resolve()).catch(() => {}).then(fn);
  fileQueues.set(file, next);
  next.finally(() => { if (fileQueues.get(file) === next) fileQueues.delete(file); }).catch(() => {});
  return next;
}

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(tmp, data); await fsp.rename(tmp, file); }
  finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

async function writeJsonAtomic(file, value) {
  await writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}


function readConfig(file) { return firstRun.load(file, { log: console }); }

function saveConfig() {
  return queueFile(CONFIG_FILE, async () => {
    if (runtime.portableProfile()) { firstRun.save(CONFIG_FILE, CONFIG); return; }
    let previous;
    try { previous = await fsp.readFile(CONFIG_FILE, 'utf8'); JSON.parse(previous); }
    catch (e) { console.error('config backup kept:', e.message); previous = null; }
    if (previous !== null) await writeAtomic(CONFIG_FILE + '.bak', previous);
    await writeJsonAtomic(CONFIG_FILE, CONFIG);
  });
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '–', mdash: '—', hellip: '…' };
function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Title for a link Owner is adding. Fetched here because most of his links are
// Tailscale or localhost addresses that a browser page cannot read across origins.
function fetchPage(target, redirects = 3) {
  if (!enabled('linkMetadata')) return Promise.reject(runtime.jobsOffError());
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { reject(new Error('not a url')); return; }
    if (!['http:', 'https:'].includes(u.protocol)) { reject(new Error('only http and https')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Meridian/1.0', Accept: 'text/html,*/*;q=0.8' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && redirects > 0) {
        r.resume();
        let next;
        try { next = new URL(r.headers.location, u).href; } catch (e) { reject(e); return; }
        fetchPage(next, redirects - 1).then(resolve, reject);
        return;
      }
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { data += c; if (data.length > 300 * 1024) r.destroy(); });
      r.on('close', () => resolve({ status: r.statusCode, url: u.href, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function pageMeta(target) {
  const page = await fetchPage(target);
  const meta = (name) => {
    const tag = (page.body.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i')) || [])[0];
    return tag ? decodeEntities((tag.match(/content=["']([^"']*)["']/i) || [])[1] || '').trim() : '';
  };
  let title = meta('og:title') || decodeEntities((page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  if (title.length > 120) title = title.slice(0, 117).replace(/\s+\S*$/, '') + '…';
  let host = '';
  try { host = new URL(target).host; } catch { /* checked by fetchPage */ }
  const data = await linksStore.read();
  const sibling = data.links.find((l) => { try { return new URL(l.url).host === host; } catch { return false; } });
  return { title, description: meta('og:description') || meta('description'), status: page.status, category: (sibling && sibling.category) || guessCategory(`${target} ${title}`) };
}

// ---------------------------------------------------------------- boot

function bindAddresses() {
  if (!JOBS_ENABLED || runtime.portableProfile()) return ['127.0.0.1'];
  const addrs = ['127.0.0.1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && a.address.startsWith('100.')) addrs.push(a.address);
    }
  }
  return addrs;
}

const portableJobs = new Map();
function syncPortableJobs() {
  if (!runtime.portableProfile() || !JOBS_ENABLED) return;
  const interval = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return () => clearInterval(timer); };
  const jobs = {
    refresh: [Object.values(runtime.setup().connectors).some(c => c.enabled), () => interval(() => { void refreshState(); }, (CONFIG.refreshSeconds || 45) * 1000)],
    github: [enabled('github'), () => interval(() => { void github.refresh().then(() => refreshState()); }, 10 * 60 * 1000)],
    almanac: [enabled('almanac'), () => almanac.start()],
    aiUsage: [enabled('aiUsage'), () => { aiUsageLedger.startHistory(); return () => aiUsageLedger.stopHistory(); }],
    tell: [enabled('tell'), () => { tell.start(); return () => tell.stop(); }],
    notify: [enabled('notify'), () => interval(() => { void releaseHeldPings().catch(e => console.error('held pings:', e.message)); }, 60000)],
    nudges: [enabled('nudges'), () => interval(nudgeTick, 15000)],
  };
  for (const [name, [on, start]] of Object.entries(jobs)) {
    if (on && !portableJobs.has(name)) portableJobs.set(name, start());
    if (!on && portableJobs.has(name)) { portableJobs.get(name)(); portableJobs.delete(name); }
  }
  if (!enabled('todoRank')) ranker.stop();
}

const setupApi = require('./setup-api').createSetup({
  config: CONFIG, file: CONFIG_FILE, queue: queueFile, calendarUrl: calendarsLib.normaliseUrl,
  onChange: async (name) => {
    connectInfo.bust();
    repoCache.at = 0; calCache.at = 0; brainCache.at = 0; campaignSnapshotCache.at = 0;
    calendarVersion++;
    tailnetCache.at = 0;
    syncPortableJobs();
    if (name === 'aiUsage') aiUsageLedger.invalidate();
    if (name === 'github' && enabled('github')) void github.refresh().then(() => refreshState());
    void refreshState();
  },
});

const port = CONFIG.port || 4980;
const addrs = bindAddresses();
let bound = 0;
for (const addr of addrs) {
  const s = addr === addrs[0] ? server : http.createServer(server.listeners('request')[0]);
  s.listen(port, addr, () => {
    bound++;
    console.log(`meridian listening on http://${addr}:${port}`);
  });
  s.on('error', (e) => console.error(`bind ${addr} failed:`, e.message));
}

if (JOBS_ENABLED && !runtime.portableProfile()) {
  void dailyArt.refresh().catch(error => console.error('brief artwork refresh:', error.message));
  setInterval(() => { void dailyArt.refresh().catch(error => console.error('brief artwork refresh:', error.message)); }, 60 * 60 * 1000);
  almanac.start();
  briefIcon.start();
  aiUsageLedger.startHistory();
  money.start();
  ensureNotifyConfig();
  refreshState();
  setInterval(refreshState, (CONFIG.refreshSeconds || 45) * 1000);
  setInterval(sweepSse, 15000);
  // Meeting nudges need finer timing than the 45 s refresh (one is 1 minute
  // before). They read the merged calendar refreshState leaves behind.
  setInterval(nudgeTick, 15 * 1000);
  tell.start();
  setInterval(() => { void releaseHeldPings().catch((e) => console.error('held pings:', e.message)); }, 60 * 1000);
  setTimeout(() => { void github.refresh().then(() => { if (state.at) { state.github = github.get(); state.sources = { ...state.sources, github: github.source() }; broadcast(); } }); }, 8000);
  setInterval(() => { void github.refresh().then(() => { if (state.at) { state.github = github.get(); state.sources = { ...state.sources, github: github.source() }; invalidateState(); } }); }, 10 * 60 * 1000);
} else {
  void refreshState();
  if (runtime.portableProfile() && JOBS_ENABLED) {
    if (enabled('artwork')) { void dailyArt.refresh(); briefIcon.start(); }
    if (enabled('money')) money.start();
    if (enabled('github')) void github.refresh();
    if (enabled('artwork')) setInterval(() => { void dailyArt.refresh(); }, 60 * 60 * 1000);
    syncPortableJobs();
  }
}
