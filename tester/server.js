'use strict';

// Meridian for testers (7 Oct 2026). A separate little server that lets people
// outside the tailnet try Meridian over a call: the real command centre page,
// fed by their own sandbox of made-up data (sandbox.js), never by Meridian's.
//
//   127.0.0.1:4985  the public side. Tailscale Funnel puts it on the internet at
//                   :8443/ (beside the real /mcp). Everything needs an invite
//                   cookie, which /t/<invite> sets; without one it's a 404.
//   127.0.0.1:4986  the console for Owner: invites, live view, tasks, notes,
//                   replays, and the switch that puts the public side online.
//                   Tailnet only (tailscale serve), and refuses Funnel traffic.
//
// It reads nothing of Meridian's except the page's code (public/command.*),
// the almanac and the day's painting (both from the Home daemon, GET only,
// with the weather's town taken out) and the model list's names. Files:
// data/tester/ (invites.json, sandboxes/, recordings/, settings.json, secret).
//
//   node tester/server.js        (uk.example.meridian-tester keeps it running)

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const demo = require('../demo');
const { createSandboxes, cleanPrefs } = require('./sandbox');
const { createInvites } = require('./invites');
const { createAi } = require('./ai');
const { fetchCalendar } = require('./ics');
const { handleMcp } = require('./mcp');
const tasks = require('./tasks');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const TPUB = path.join(__dirname, 'public');
const TADMIN = path.join(__dirname, 'admin');
const DATA = process.env.TESTER_DATA || path.join(ROOT, 'data', 'tester');
const PORT = Number(process.env.TESTER_PORT || 4985);
const ADMIN_PORT = Number(process.env.TESTER_ADMIN_PORT || 4986);
const MAIN = { host: '127.0.0.1', port: Number(process.env.MERIDIAN_PORT || 4980) };
const TAILSCALE = process.env.TAILSCALE_BIN || '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const CLAUDE = process.env.CLAUDE_BIN || path.join(process.env.HOME || '', '.local/bin/claude');
const FUNNEL_PORT = 8443;
const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- settings and secrets

const SETTINGS_FILE = path.join(DATA, 'settings.json');
const SETTINGS_DEFAULT = { publicBase: '', adminBase: '', ai: { on: true, model: 'sonnet', reportModel: 'sonnet' }, posthog: { key: '', host: 'https://eu.i.posthog.com' } };
let settings = SETTINGS_DEFAULT;
try { settings = { ...SETTINGS_DEFAULT, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* defaults */ }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 }); }

const SECRET_FILE = path.join(DATA, 'secret');
let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }

// The tailnet name, for the links on the console, unless settings name another.
let tailHost = '';
execFile(TAILSCALE, ['status', '--json'], { timeout: 8000 }, (err, out) => {
  try { tailHost = String(JSON.parse(out).Self.DNSName || '').replace(/\.$/, ''); } catch { /* not on Tailscale */ }
});
const publicBase = () => settings.publicBase || (tailHost ? `https://${tailHost}:${FUNNEL_PORT}` : `http://127.0.0.1:${PORT}`);
// The same tester side on Owner's own devices only (tailscale serve :44443), for trying it before it's public.
const PREVIEW_PORT = 44443; const ADMIN_SERVE_PORT = 43443;
const previewBase = () => settings.previewBase || (tailHost ? `https://${tailHost}:${PREVIEW_PORT}` : `http://127.0.0.1:${PORT}`);

// ---------------------------------------------------------------- the parts

const ENGINES = {
  models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', maker: 'OpenAI', kind: 'codex', efforts: ['low', 'medium', 'high', 'xhigh'], rank: 1 },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', maker: 'OpenAI', kind: 'codex', efforts: ['low', 'medium', 'high', 'xhigh'], rank: 2 },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', maker: 'Anthropic', kind: 'claude', efforts: ['low', 'medium', 'high', 'xhigh'], rank: 1 },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', maker: 'Anthropic', kind: 'claude', efforts: ['low', 'medium', 'high', 'xhigh'], rank: 2 },
  ],
  presets: [{ label: 'Opus High', hint: 'Most things', model: 'claude-opus-5-5', effort: 'high' }, { label: 'Luna High', hint: 'Quick jobs', model: 'gpt-6-luna', effort: 'high' }],
  default: { model: 'claude-opus-5-5', effort: 'high' },
  efforts: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'X-high']],
  discovered: [],
};

const invites = createInvites({ file: path.join(DATA, 'invites.json') });
// demo.js answers the read-only things a sandbox doesn't change (AI usage, GitHub, link titles…).
const demoWorld = demo.createDemo({ engines: () => ({ labels: ENGINES.models.map((x) => x.name), default: ENGINES.models[2].name }) });
const ai = createAi({ claudeBin: CLAUDE, model: settings.ai.model, reportModel: settings.ai.reportModel });
const sandboxes = createSandboxes({
  dir: path.join(DATA, 'sandboxes'),
  models: () => ENGINES.models,
  onChange: (id) => pushState(id),
  onRunDone: (id, run) => { tell(id, 'run', { id: run.id, title: run.title, model: run.model }); live('run', { invite: id, title: run.title, model: run.model }); },
  // A written report costs a model call, so 30 an hour per tester; past that they get the stand-in.
  writeReport: (x) => (settings.ai.on && allow('report:' + x.invite, 30) ? ai.report(x) : Promise.resolve(null)),
});
let recordings = null;
try { recordings = require('./recordings').createRecordings({ dir: path.join(DATA, 'recordings') }); } catch (e) { console.error('recordings unavailable:', e.message); }

// ---------------------------------------------------------------- helpers

const clean = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };

function sendJson(res, code, value) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(JSON.stringify(value));
}
function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(text);
}
const notFound = (res) => sendText(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
const NOT_FOUND = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Meridian</title><body style="background:#000;color:#8e8e94;font:15px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>This is a private test. If Owner sent you a link, open that one.</p></body>';

function readBody(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => { if (over) return; size += c.length; if (size > limit) { over = true; return; } chunks.push(c); });
    req.on('end', () => { if (over) return reject(Object.assign(new Error('too large'), { statusCode: 413 })); resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
async function jsonBody(req, limit) {
  const t = await readBody(req, limit);
  if (!t.trim()) return {};
  try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : {}; } catch { throw Object.assign(new Error('send JSON'), { statusCode: 400 }); }
}

// The cookie carries the invite's generation, which "Delete everything I did" moves on, so old cookies stop working.
const sign = (id, gen = 0) => crypto.createHmac('sha256', SECRET).update(`invite:${id}:${gen}`).digest('base64url').slice(0, 32);
function cookieInvite(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mt=([a-z0-9]{4,40})\.([\w-]{32})/);
  if (!m) return null;
  const inv = invites.get(m[1]); if (!inv) return null;
  const a = Buffer.from(sign(inv.id, inv.gen || 0)); const b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return inv;
}
// A request belongs to the generation it was let in under. After any wait (a slow body, a model call),
// check that's still true before it changes anything: Delete everything may have happened meanwhile.
const current = (inv, gen, { consent = true } = {}) => { const x = invites.get(inv.id); return Boolean(x && (x.gen || 0) === gen && (!consent || x.consent)); };
const loopbackHost = (req) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''));
function setCookie(res, req, inv) {
  res.setHeader('Set-Cookie', `mt=${inv.id}.${sign(inv.id, inv.gen || 0)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${loopbackHost(req) ? '' : '; Secure'}`);
}
function clearCookie(res, req) { res.setHeader('Set-Cookie', `mt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${loopbackHost(req) ? '' : '; Secure'}`); }

// A few calls an hour, per tester, for the things that cost something.
const buckets = new Map();
function allow(key, perHour) {
  const now = Date.now(); const list = (buckets.get(key) || []).filter((t) => now - t < HOUR);
  if (list.length >= perHour) { buckets.set(key, list); return false; }
  list.push(now); buckets.set(key, list); return true;
}

// ---------------------------------------------------------------- static files

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

// Only the files the command centre page needs, from Meridian's public folder.
const PAGE_FILES = new Set(['command.css', 'command.js', 'a11y.js', 'money-core.js', 'source-marks.js', 'dashboard-icon.svg', 'dashboard-icon-180.png', 'dashboard-icon-192.png', 'dashboard-icon-512.png', 'meridian-icon.svg', 'img/hero-dusk.jpg']);
const PAGE_DIRS = [/^img\/planets\/[\w-]+\.(jpg|png|webp)$/];

// The page's code names a few real things in defaults and comments. Testers see stand-ins.
const SCRUB = [[/Example Campaign/g, 'Side projects'], [/ExampleApp/g, 'Clients'], [/Example Agency/g, 'Work'], [/Avery/g, 'a colleague'], [/Belfast/g, 'Home'], [/ulster/gi, 'university'],
  [/\bOwner\b/g, 'Sam'], [/\bowner\b/g, 'sam'], [/\bjordan\b/gi, 'jamie']];
const fileCache = new Map();
async function readCached(file, scrub) {
  const st = await fsp.stat(file);
  const hit = fileCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.body;
  let body = await fsp.readFile(file);
  if (scrub) { let s = body.toString('utf8'); for (const [re, to] of SCRUB) s = s.replace(re, to); body = Buffer.from(s); }
  fileCache.set(file, { mtime: st.mtimeMs, body });
  return body;
}
async function serveFile(res, file, { scrub = false, cache = file.startsWith(path.join(PUB, 'img', 'planets') + path.sep) ? 'private, max-age=3600' : 'no-cache' } = {}) {
  try {
    const body = await readCached(file, scrub);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache, ...SEC_HEADERS });
    res.end(body);
  } catch { notFound(res); }
}
// A path inside `dir`, or null. No dot-files, no way out.
function inside(dir, rel) {
  if (!rel || rel.split('/').some((p) => !p || p.startsWith('.'))) return null;
  const full = path.resolve(dir, rel);
  return full.startsWith(dir + path.sep) ? full : null;
}

// ---------------------------------------------------------------- the page

// Owner's look (5 Oct), with the tabs that make no sense here hidden: Money is his,
// Brief and Dogfood are about Meridian itself.
const DEFAULT_PREFS = {
  look: { surface: 'ink', radius: 'squircle', density: 'comfortable', type: 'editorial', tint: 'off', accentStyle: 'quiet', glass: 'frosted', inset: 'inset', hero: 'earth', sel: 'lift', flash: 'lift', hnext: 'stack', hshelf: 'scroll', fx: 'none', calcol: 'area', dayline: 'off', hhero: 'banner', hedge: 'fade', mixevery: 'visit', planet: 'week', hmove: 'move', nxs: 'wash' },
  accent: '#ff5247', grain: 0,
  side: { mode: 'docked', side: 'left', width: 235, hide: 'float', last: 'docked', liveOpen: false, panelOpen: false, tabStyle: 'list' },
  tabs: { order: ['home', 'shelf', 'stash', 'usage', 'journal', 'system', 'brief', 'dogfood', 'money'], hidden: ['brief', 'dogfood', 'money'] },
  strip: 'auto', keys: { search: 'mod+k' }, homeOrder: ['live', 'shelf', 'usage', 'alm'], homeHidden: ['dog'],
  heroMix: ['earthview', 'week', 'colours', 'dusk', 'globe'], pickStars: ['claude-opus-5-5', 'gpt-6-luna'],
};
const prefsFor = (inv) => { const p = sandboxes.prefs(inv.id); return p && p.look ? p : { ...DEFAULT_PREFS, updated: inv.created }; };

function posthogSnippet(inv) {
  const k = settings.posthog && settings.posthog.key;
  if (!k || !/^phc_[\w]{20,80}$/.test(k)) return '';
  const host = /^https:\/\/(eu|us)\.i\.posthog\.com$/.test(settings.posthog.host) ? settings.posthog.host : 'https://eu.i.posthog.com';
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(${safeJson(k)},{api_host:${safeJson(host)},defaults:'2026-05-30',capture_heatmaps:true,person_profiles:'identified_only',session_recording:{maskAllInputs:false,maskInputOptions:{password:true}}});
posthog.identify(${safeJson(inv.id)},{name:${safeJson(inv.name)},mode:${safeJson(inv.mode)}});</script>`;
}

// The page with the tester's card, and the recorder when they said yes. Each load is its own recording.
function inject(html, inv, { dashboard = false } = {}) {
  const recording = Boolean(inv.consent && inv.consent.record);
  const boot = {
    invite: inv.id, name: inv.name, mode: inv.mode, recording,
    session: recording ? `${inv.id}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}` : null,
    tasks: tasks.script(inv.mode), seq: tasks.SEQ, final: tasks.FINAL,
  };
  // The page keeps a copy of its last state in localStorage. A browser used by another tester before
  // (or by this one before Delete everything) drops those copies first.
  const who = safeJson(`${inv.id}:${inv.gen || 0}`);
  const page = dashboard ? `window.__meridianStash={'meridian.cc.prefs':${safeJson(JSON.stringify(prefsFor(inv)))}};try{if(localStorage.getItem('meridian.tester')!==${who}){Object.keys(localStorage).filter(function(k){return k.indexOf('meridian.')===0;}).forEach(function(k){localStorage.removeItem(k);});localStorage.setItem('meridian.tester',${who});}localStorage.setItem('meridian.demo','1');localStorage.setItem('meridian.phone.layout','classic');}catch(e){}` : '';
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8"><script>window.MERIDIAN_TESTER=${safeJson(boot)};${page}</script>`);
  const rec = recording && fs.existsSync(path.join(TPUB, 'rec.js')) ? recScripts() : '';
  return html.replace('</body>', `<link rel="stylesheet" href="/tester/overlay.css">\n<script src="/tester/overlay.js"></script>\n${rec}${recording ? posthogSnippet(inv) : ''}\n</body>`);
}
async function pageHtml(inv) {
  const html = (await readCached(path.join(PUB, 'command.html'), true)).toString('utf8');
  return inject(html.replace(/<title>[^<]*<\/title>/, '<title>Meridian</title>').replace(/<link rel="manifest"[^>]*>/, ''), inv, { dashboard: true });
}
async function connectHtml(inv) { return inject((await readCached(path.join(TPUB, 'connect.html'), false)).toString('utf8'), inv); }
// The recorder's bundle: whichever rrweb record file is vendored, then rec.js.
let recTags = null;
function recScripts() {
  if (recTags !== null) return recTags;
  const dir = path.join(TPUB, 'vendor', 'rrweb');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { /* not vendored */ }
  const rec = ['record.min.js', 'record.umd.min.js', 'rrweb-record.min.js', 'rrweb.min.js'].find((f) => files.includes(f)) || files.find((f) => /record.*\.js$/.test(f));
  recTags = rec ? `<script src="/tester/vendor/rrweb/${rec}"></script>\n<script src="/tester/rec.js"></script>\n` : '';
  return recTags;
}

async function welcomeHtml(inv) {
  let html = (await readCached(path.join(TPUB, 'welcome.html'), false)).toString('utf8');
  return html.replace('<!--BOOT-->', `<script>window.MERIDIAN_TESTER=${safeJson({ invite: inv.id, name: inv.name, mode: inv.mode, consent: inv.consent, ai: settings.ai.on })};</script>`);
}

// ---------------------------------------------------------------- live streams

const streams = new Map();       // invite -> Set of page streams (/api/stream)
const testerStreams = new Map(); // invite -> Set of overlay streams (/t-api/events)
const liveStreams = new Set();   // the console
const pushTimers = new Map();

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC_HEADERS });
  res.write('retry: 4000\n\n');
}
// A reader that stops reading gets cut off rather than queueing state in memory.
const ev = (res, name, data) => { try { if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return; } res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
const STREAMS_EACH = 6; const STREAMS_ALL = 300;
const streamCount = () => [...streams.values(), ...testerStreams.values()].reduce((n, set) => n + set.size, 0) + liveStreams.size;
const tooMany = (map, inv) => (map.get(inv.id)?.size || 0) >= STREAMS_EACH || streamCount() >= STREAMS_ALL;

function pushState(id) {
  clearTimeout(pushTimers.get(id));
  pushTimers.set(id, setTimeout(() => {
    pushTimers.delete(id);
    const set = streams.get(id); if (!set || !set.size) return;
    let s; try { s = sandboxes.state(id); } catch (e) { console.error('state failed', e); return; }
    for (const res of set) ev(res, 'state', s);
  }, 150));
}
function tell(id, name, data) { for (const res of testerStreams.get(id) || []) ev(res, name, data); }
function live(name, data) { for (const res of liveStreams) ev(res, name, data); }
function presence(inv) {
  const pages = (streams.get(inv.id) || new Set()).size;
  return { invite: inv.id, online: pages > 0, pages, lastSeen: inv.lastSeen };
}
function addStream(map, inv, req, res) {
  if (!map.has(inv.id)) map.set(inv.id, new Set());
  map.get(inv.id).add(res);
  const beat = setInterval(() => { try { res.write(': hi\n\n'); } catch { /* gone */ } }, 20000);
  req.on('close', () => { clearInterval(beat); map.get(inv.id)?.delete(res); if (map === streams) { invites.mutate(inv.id, (x) => { x.lastSeen = Date.now(); }); live('presence', presence(inv)); } });
}
// The page's own stream re-sends everything every 45 s, like the real one, so "in 20 min" stays right.
setInterval(() => { for (const id of streams.keys()) pushState(id); }, 45000).unref();

// ---------------------------------------------------------------- the almanac and the painting

function fromMain(pathname, res, edit) {
  const r = http.request({ ...MAIN, method: 'GET', path: pathname, headers: { Accept: '*/*' }, timeout: 15000 }, (u) => {
    if (u.statusCode !== 200) { u.resume(); notFound(res); return; }
    const type = String(u.headers['content-type'] || '');
    if (!edit) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', ...SEC_HEADERS }); u.pipe(res); return; }
    const chunks = []; u.on('data', (c) => chunks.push(c)); u.on('end', () => {
      try { sendJson(res, 200, edit(JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch { notFound(res); }
    });
  });
  r.on('timeout', () => r.destroy());
  r.on('error', () => notFound(res));
  r.end();
}
// The weather names where the Home Mac is; testers get everything else.
const scrubAlmanac = (a) => { if (a && a.items) delete a.items.sky; return a; };

// ---------------------------------------------------------------- the tester's API

const JOURNAL_AREAS = ['Northwind', 'Tidepool', 'Fieldnotes', 'Studio', 'Personal'];

async function testerApi(req, res, url, inv, gen) {
  let p = url.pathname;
  if (p === '/api/demo' || p.startsWith('/api/demo/')) p = '/api' + p.slice('/api/demo'.length);
  const m = req.method;
  if (p === '/api/stream') {
    if (tooMany(streams, inv)) return sendJson(res, 429, { ok: false, error: 'too many open tabs' });
    sse(res); ev(res, 'state', sandboxes.state(inv.id));
    invites.mutate(inv.id, (x) => { x.lastSeen = Date.now(); if (!x.opened) x.opened = Date.now(); });
    addStream(streams, inv, req, res); live('presence', presence(inv));
    return;
  }
  if (m === 'GET' || m === 'HEAD') {
    switch (p) {
      case '/api/state': return sendJson(res, 200, sandboxes.state(inv.id));
      case '/api/todos': return sendJson(res, 200, { todos: sandboxes.state(inv.id).todos });
      case '/api/deadlines': return sendJson(res, 200, { items: sandboxes.view(inv.id, 'deadlines') });
      case '/api/links': return sendJson(res, 200, sandboxes.view(inv.id, 'links'));
      case '/api/journal': return sendJson(res, 200, { version: 1, areas: JOURNAL_AREAS, entries: sandboxes.view(inv.id, 'journal') });
      case '/api/projects': return sendJson(res, 200, { version: 1, projects: sandboxes.view(inv.id, 'projects') });
      case '/api/stash': return sendJson(res, 200, sandboxes.stashList(inv.id, url.searchParams));
      case '/api/command/prefs': return sendJson(res, 200, { prefs: prefsFor(inv) });
      case '/api/engines': return sendJson(res, 200, ENGINES);
      case '/api/almanac': return fromMain('/api/almanac', res, scrubAlmanac);
      case '/api/daily-art/image': return fromMain('/api/daily-art/image', res);
      default: break;
    }
    if (/^\/api\/almanac\/image\/[\w-]+$/.test(p)) return fromMain(p + url.search.replace(/[^?&=\w.-]/g, ''), res);
    const sm = p.match(/^\/api\/stash\/([a-z0-9]{6,40})(?:\/(file|thumb|icon|similar))?$/);
    if (sm) {
      const it = sandboxes.stashItem(inv.id, sm[1]);
      if (!it) return sendJson(res, 404, { ok: false, error: 'not in the stash' });
      if (!sm[2]) return sendJson(res, 200, { ok: true, item: { ...it, ocr: it.hasText ? it.title : '' } });
      if (sm[2] === 'similar') return sendJson(res, 200, { ok: true, items: sandboxes.view(inv.id, 'stash').filter((x) => x.id !== it.id && x.kind === 'image').map((x, i) => ({ ...x, distance: 0.21 + i * 0.07 })) });
      if ((sm[2] === 'thumb' || sm[2] === 'file') && it.palette) return sendText(res, 200, demo.world.stashSvg(it), 'image/svg+xml', { 'Cache-Control': 'private, max-age=3600' });
      return notFound(res);
    }
    // Everything else read-only comes from demo mode's world as it is (usage, GitHub, money, link titles…).
    if (/^\/api\/(command\/hero-photo|money\/(?!status$))/.test(p) && p !== '/api/money') return sendJson(res, 404, { ok: false, error: 'not in this test' });
    const demoUrl = new URL('/api/demo' + p.slice(4) + url.search, 'http://x');
    const r = await demoWorld.handle(req, res, demoUrl);
    if (r !== true) sendJson(res, 404, { ok: false, error: 'not in this test' });
    return;
  }
  // Writes land in the sandbox; anything it doesn't keep is a polite yes that changes nothing.
  if (!allow('w:' + inv.id, 1500)) return sendJson(res, 429, { ok: false, error: 'slow down a little' });
  const body = await jsonBody(req, 200000);
  if (!current(inv, gen)) return sendJson(res, 410, { ok: false, error: 'deleted' });
  const out = sandboxes.write(inv.id, m, p, body);
  if (out) return sendJson(res, out.status || 200, out.json);
  return sendJson(res, 200, { ok: true, demo: true });
}

// Room for more recording: 40 sessions and 300 MB per tester, 3 GB for everyone. Counted in memory
// (read from disk once at start), and each batch's bytes are reserved before it's written, in one step.
const REC_SESSIONS = 40, REC_TESTER = 300 * 1024 * 1024, REC_ALL = 3 * 1024 * 1024 * 1024;
const recUse = { ready: null, all: 0, by: new Map() };   // invite -> { sessions: Set, bytes }
function recInit() {
  if (!recUse.ready) recUse.ready = recordings.list({}).then((list) => { for (const x of list) { const u = recMine(x.invite); u.sessions.add(x.session); u.bytes += x.bytes || 0; recUse.all += x.bytes || 0; } }, () => {});
  return recUse.ready;
}
function recMine(invite) { if (!recUse.by.has(invite)) recUse.by.set(invite, { sessions: new Set(), bytes: 0 }); return recUse.by.get(invite); }
function recReserve(invite, session, bytes) {
  const u = recMine(invite);
  if (!u.sessions.has(session) && u.sessions.size >= REC_SESSIONS) return 'too many recordings for one tester';
  if (u.bytes + bytes > REC_TESTER) return 'recording space for this tester is full';
  if (recUse.all + bytes > REC_ALL) return 'recording space is full';
  u.sessions.add(session); u.bytes += bytes; recUse.all += bytes;
  return null;
}
function recForget(invite) { const u = recUse.by.get(invite); if (u) { recUse.all -= u.bytes; recUse.by.delete(invite); } }

async function tApi(req, res, url, inv, gen) {
  const p = url.pathname; const m = req.method;
  if (p === '/t-api/events' && m === 'GET') {
    if (tooMany(testerStreams, inv)) return sendJson(res, 429, { ok: false, error: 'too many open tabs' });
    sse(res); ev(res, 'me', me(inv));
    addStream(testerStreams, inv, req, res);
    return;
  }
  if (p === '/t-api/me' && m === 'GET') return sendJson(res, 200, me(inv));
  if (m !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  if (p === '/t-api/rec') {
    if (!recordings) return sendJson(res, 503, { ok: false });
    if (!(inv.consent && inv.consent.record)) return sendJson(res, 403, { ok: false, error: 'not recording' });
    const raw = await readBody(req, 3 * 1024 * 1024);   // a 413 stays a 413, so rec.js stops
    let b; try { b = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'send JSON' }); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return sendJson(res, 400, { ok: false, error: 'send JSON' });
    if (b.invite !== inv.id || !String(b.session || '').startsWith(inv.id + '-')) return sendJson(res, 403, { ok: false });
    await recInit();
    if (!current(inv, gen) || !invites.get(inv.id).consent.record) return sendJson(res, 410, { ok: false, error: 'not recording' });
    const room = recReserve(inv.id, b.session, Buffer.byteLength(raw));
    if (room) return sendJson(res, 413, { ok: false, error: room });
    await recordings.append({ session: b.session, invite: inv.id, seq: b.seq, events: b.events, meta: b.meta });
    // Deleted while it was being written: take it away again.
    if (!current(inv, gen)) { await recordings.removeInvite(inv.id).catch(() => {}); recForget(inv.id); return sendJson(res, 410, { ok: false, error: 'deleted' }); }
    // The console's live view: just the clicks and the moments, as they come.
    for (const e of Array.isArray(b.events) ? b.events : []) {
      if (e && e.type === 5 && e.data && ['click', 'nav', 'task'].includes(e.data.tag)) live('rec', { invite: inv.id, session: b.session, t: e.timestamp, tag: e.data.tag, data: e.data.payload });
    }
    return sendJson(res, 200, { ok: true });
  }
  // Delete everything always works, however busy they've been.
  if (p !== '/t-api/forget' && !allow('t:' + inv.id, 600)) return sendJson(res, 429, { ok: false, error: 'slow down a little' });
  const body = await jsonBody(req, 100000);
  // Everything but saying yes (or deleting it all) waits for a yes, from this generation.
  const yes = !['/t-api/consent', '/t-api/forget'].includes(p);
  if (!current(inv, gen, { consent: yes })) return sendJson(res, yes ? 403 : 410, { ok: false, error: yes ? 'start from the welcome page' : 'deleted' });
  const still = () => current(inv, gen);
  switch (p) {
    case '/t-api/consent': {
      invites.mutate(inv.id, (x) => { x.consent = { at: Date.now(), record: Boolean(body.record), ua: clean(req.headers['user-agent'], 200) }; });
      live('invite', publicInvite(invites.get(inv.id)));
      return sendJson(res, 200, { ok: true });
    }
    case '/t-api/task': {
      const n = Number(body.n); const state = ['start', 'done', 'skip', 'stuck'].includes(body.state) ? body.state : null;
      const script = tasks.script(inv.mode);
      if (!state || !Number.isInteger(n) || n < 1 || n > script.length + 1) return sendJson(res, 400, { ok: false, error: 'bad task' });
      if ((inv.taskLog || []).length >= 1000) return sendJson(res, 429, { ok: false, error: 'that’s enough tasks' });
      const x = invites.mutate(inv.id, (y) => {
        y.taskLog.push({ n, state, at: Date.now(), by: 'tester', answer: clean(body.answer, 4000) || undefined });
        if (state === 'start') y.task = { n, at: Date.now() };
        else if (y.task && y.task.n === n) y.task = { n, at: y.task.at, ended: Date.now(), outcome: state };
      });
      live('task', { invite: inv.id, task: x.task, log: x.taskLog.slice(-1)[0] });
      return sendJson(res, 200, { ok: true, me: me(x) });
    }
    case '/t-api/seq': {
      const n = Number(body.n); const v = Number(body.value);
      if (!Number.isInteger(n) || n < 1 || n > 20 || !Number.isInteger(v) || v < 1 || v > 7) return sendJson(res, 400, { ok: false, error: 'bad rating' });
      invites.mutate(inv.id, (y) => { y.seq[n] = v; });
      live('seq', { invite: inv.id, n, value: v });
      return sendJson(res, 200, { ok: true });
    }
    case '/t-api/answers': {
      const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
      const a = {}; for (const q of tasks.FINAL) { const v = given[q.id]; if (v === undefined || v === null) continue;
        if (q.kind === 'scale') { if (Number.isInteger(v) && v >= 1 && v <= 7) a[q.id] = v; }
        else if (q.kind === 'multi') { if (Array.isArray(v)) a[q.id] = v.filter((x) => q.options.includes(x)).slice(0, 10); }
        else if (q.kind === 'choice') { if (q.options.includes(v)) a[q.id] = v; }
        else a[q.id] = clean(v, 4000); }
      if (body.answers && body.answers.weekWhy) a.weekWhy = clean(body.answers.weekWhy, 2000);
      const x = invites.mutate(inv.id, (y) => { y.answers = { ...a, at: Date.now() }; y.finished = Date.now(); });
      live('answers', { invite: inv.id, answers: x.answers, umux: tasks.umuxLite(a.umux1, a.umux2) });
      return sendJson(res, 200, { ok: true });
    }
    case '/t-api/note': {
      const text = clean(body.text, 2000); if (!text) return sendJson(res, 400, { ok: false, error: 'say something first' });
      if ((inv.notes || []).length >= 300) return sendJson(res, 429, { ok: false, error: 'that’s a lot of notes; tell Owner on the call' });
      const x = invites.mutate(inv.id, (y) => { y.notes.push({ at: Date.now(), by: 'tester', task: y.task ? y.task.n : null, text }); });
      live('note', { invite: inv.id, note: x.notes.slice(-1)[0] });
      return sendJson(res, 200, { ok: true });
    }
    case '/t-api/tell': {
      if (!settings.ai.on) return sendJson(res, 503, { ok: false, error: 'sorting is switched off for this test' });
      if (!allow('tell:' + inv.id, 15)) return sendJson(res, 429, { ok: false, error: 'that’s a lot for one hour; try again later' });
      const given = Number(body.now);
      const sorted = await ai.sort({ text: body.text, now: Number.isFinite(given) && Math.abs(given - Date.now()) < 2 * DAY ? given : Date.now(), tz: clean(body.tz, 60) || 'Europe/London' });
      if (!still()) return sendJson(res, 410, { ok: false, error: 'deleted' });   // they pressed Delete everything while it sorted
      if (body.fresh) sandboxes.configure(inv.id, { world: 'blank' });
      const added = bringIn(inv.id, sorted);
      live('tell', { invite: inv.id, counts: count(added) });
      return sendJson(res, 200, { ok: true, added, counts: count(added) });
    }
    case '/t-api/ics': {
      if (!allow('ics:' + inv.id, 10)) return sendJson(res, 429, { ok: false, error: 'try again later' });
      const evs = await fetchCalendar(body.url, { now: Date.now(), days: 7, label: 'Your calendar' });
      if (!still()) return sendJson(res, 410, { ok: false, error: 'deleted' });
      if (body.fresh) sandboxes.configure(inv.id, { world: 'blank' });
      let n = 0;
      for (const e of evs) { try { sandboxes.bring.event(inv.id, { title: e.title, start: new Date(e.ts).toISOString(), end: e.end ? new Date(e.end).toISOString() : null, calendar: 'Your calendar', location: e.location || '', joinUrl: e.joinUrl || '', organizer: e.organizer || '', allDay: e.allDay }); n++; } catch { break; } }
      live('tell', { invite: inv.id, counts: { events: n } });
      return sendJson(res, 200, { ok: true, events: n });
    }
    case '/t-api/world': {
      sandboxes.configure(inv.id, { world: body.world });
      return sendJson(res, 200, { ok: true, world: sandboxes.load(inv.id).world });
    }
    case '/t-api/reset': {
      sandboxes.reset(inv.id, { world: inv.world, name: inv.name, keepPrefs: true });
      return sendJson(res, 200, { ok: true });
    }
    case '/t-api/forget': {
      await forget(inv.id, { keepInvite: true });
      clearCookie(res, req);
      return sendJson(res, 200, { ok: true });
    }
    default: return sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

function bringIn(id, s) {
  const added = { todos: [], asks: [], events: [], deadlines: [], agents: [], notes: [] };
  const tryAdd = (list, fn) => { try { list.push(fn()); } catch { /* full or bad: skip it */ } };
  for (const t of s.todos) tryAdd(added.todos, () => sandboxes.bring.todo(id, { ...t, by: 'tell' }).title);
  for (const a of s.asks) tryAdd(added.asks, () => sandboxes.bring.ask(id, a).title);
  for (const e of s.events) tryAdd(added.events, () => sandboxes.bring.event(id, { ...e, calendar: 'Yours' }).title);
  for (const d of s.deadlines) tryAdd(added.deadlines, () => sandboxes.bring.deadline(id, d).title);
  for (const a of s.agents) tryAdd(added.agents, () => { sandboxes.bring.agent(id, { agent: a.agent, project: a.project || 'work', doing: a.doing }); return `${a.agent}: ${a.doing}`; });
  for (const n of s.notes) tryAdd(added.notes, () => { sandboxes.bring.note(id, { text: n }); return n; });
  return added;
}
const count = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length]));

function me(inv) {
  return { invite: inv.id, name: inv.name, mode: inv.mode, task: inv.task, seq: inv.seq, finished: inv.finished, consent: inv.consent,
    tasks: tasks.script(inv.mode), world: sandboxes.exists(inv.id) ? sandboxes.load(inv.id).world : inv.world,
    agentUrl: `${publicBase()}/x/mcp/${inv.agentToken}`, ai: settings.ai.on };
}

async function forget(id, { keepInvite = false } = {}) {
  // A new generation first, so anything still in flight for them (a sort, a calendar) can't write back.
  invites.mutate(id, (x) => { x.gen = (x.gen || 0) + 1; x.consent = null; });
  if (keepInvite) invites.newAgentToken(id);
  for (const map of [streams, testerStreams]) { for (const r of map.get(id) || []) { try { r.end(); } catch { /* gone */ } } map.delete(id); }
  await sandboxes.remove(id);
  if (recordings) { try { await recInit(); await recordings.removeInvite(id); recForget(id); } catch (e) { console.error('recordings remove failed', e.message); } }
  if (keepInvite) invites.mutate(id, (x) => { x.consent = null; x.task = null; x.seq = {}; x.taskLog = []; x.answers = null; x.notes = []; x.finished = null; x.forgotAt = Date.now(); });
  else invites.remove(id);
  live('invite', keepInvite ? publicInvite(invites.get(id)) : { id, removed: true });
}

// ---------------------------------------------------------------- an agent's report, as a page

function mdToHtml(md) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<i>$2</i>');
  const out = []; let list = false;
  for (const line of String(md).split('\n')) {
    const l = line.trimEnd();
    if (/^\s*[-*] /.test(l)) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (/^# /.test(l)) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (/^## /.test(l)) out.push(`<h2>${inline(l.slice(3))}</h2>`);
    else if (/^### /.test(l)) out.push(`<h3>${inline(l.slice(4))}</h3>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}
function reportPage(r) {
  const when = r.run.finished ? new Date(r.run.finished).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${r.run.title.replace(/[<&]/g, '')} · report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,ital,wght@9..144,1,500&family=Outfit:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400&display=swap">
<link rel="stylesheet" href="/tester/report.css"></head><body><main><div class="who"><i></i>${r.run.model.replace(/[<&]/g, '')} · finished ${when}</div>${mdToHtml(r.markdown || '_Still working…_')}<p class="foot">A report from an agent in a test copy of Meridian.</p></main></body></html>`;
}

// ---------------------------------------------------------------- the public side

async function publicRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /\n');
  if (p === '/favicon.ico') return serveFile(res, path.join(PUB, 'dashboard-icon-192.png'), { cache: 'max-age=86400' });

  // An invite link: remember who this is, then the welcome.
  const tm = p.match(/^\/t\/([a-z0-9]{4,40})\/?$/);
  if (tm) {
    const inv = invites.get(tm[1]);
    if (!inv) return notFound(res);
    setCookie(res, req, inv);
    invites.mutate(inv.id, (x) => { if (!x.opened) x.opened = Date.now(); });
    live('invite', publicInvite(invites.get(inv.id)));
    res.writeHead(302, { Location: '/welcome', 'Cache-Control': 'no-store' }); res.end(); return;
  }

  // The tester's own agent, by its token (no cookie: Codex and ChatGPT don't have one).
  const mm = p.match(/^\/x\/mcp\/([a-z0-9]{24})$/);
  if (mm) {
    const inv = invites.byAgentToken(mm[1]);
    if (!inv) return sendJson(res, 404, { ok: false, error: 'unknown link' });
    let body = null;
    if (req.method === 'POST') { try { body = JSON.parse(await readBody(req, 200000)); } catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); } }
    if (invites.byAgentToken(mm[1]) !== inv || !inv.consent) return sendJson(res, 404, { ok: false, error: 'unknown link' });
    const by = clean(url.searchParams.get('as') || 'agent', 40);
    live('mcp', { invite: inv.id, by, method: body && !Array.isArray(body) ? body.method : 'batch', tool: body && body.params ? body.params.name : null });
    return handleMcp({ req, res, body, sandboxes, invite: inv.id, name: inv.name, by, rate: () => allow('mcp:' + inv.id, 300), sendJson });
  }

  const inv = cookieInvite(req);
  if (!inv) return notFound(res);
  const gen = inv.gen || 0;
  // Every write must come from this page (and the cookie is SameSite=Lax anyway).
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  if (p === '/welcome') return sendText(res, 200, await welcomeHtml(inv), 'text/html; charset=utf-8');
  if (p === '/' || p === '/command' || p === '/dashboard' || p === '/dashboard/phone') {
    if (!inv.consent) { res.writeHead(302, { Location: '/welcome', 'Cache-Control': 'no-store' }); res.end(); return; }
    if (!sandboxes.exists(inv.id)) sandboxes.configure(inv.id, { name: inv.name, world: inv.world });
    return sendText(res, 200, await pageHtml(inv), 'text/html; charset=utf-8');
  }
  if (p === '/connect') {
    if (!inv.consent) { res.writeHead(302, { Location: '/welcome', 'Cache-Control': 'no-store' }); res.end(); return; }
    return sendText(res, 200, await connectHtml(inv), 'text/html; charset=utf-8');
  }
  if (p === '/api' || p.startsWith('/api/')) return inv.consent ? testerApi(req, res, url, inv, gen) : sendJson(res, 403, { ok: false, error: 'start from the welcome page' });
  if (p.startsWith('/t-api/')) return tApi(req, res, url, inv, gen);
  const dm = p.match(/^\/delegations\/(run-[a-f0-9]{10})\/REPORT\.md$/);
  if (dm) {
    const r = sandboxes.report(inv.id, dm[1]);
    if (!r) return notFound(res);
    if (String(req.headers.accept || '').includes('text/html')) return sendText(res, 200, reportPage(r), 'text/html; charset=utf-8');
    return sendText(res, 200, r.markdown || 'Still working…', 'text/markdown; charset=utf-8');
  }
  if (p.startsWith('/tester/')) { const f = inside(TPUB, p.slice('/tester/'.length)); return f ? serveFile(res, f) : notFound(res); }
  const rel = p.slice(1);
  if (PAGE_FILES.has(rel) || PAGE_DIRS.some((re) => re.test(rel))) return serveFile(res, path.join(PUB, rel), { scrub: /\.(js|css|html)$/.test(rel) });
  return notFound(res);
}

// ---------------------------------------------------------------- the console (tailnet only)

function publicInvite(inv) {
  if (!inv) return null;
  const pr = presence(inv);
  return { id: inv.id, name: inv.name, mode: inv.mode, world: inv.world, note: inv.note, created: inv.created, opened: inv.opened, lastSeen: inv.lastSeen, online: pr.online, pages: pr.pages,
    consent: inv.consent, task: inv.task, seq: inv.seq, taskLog: inv.taskLog, answers: inv.answers, umux: inv.answers ? tasks.umuxLite(inv.answers.umux1, inv.answers.umux2) : null,
    notes: inv.notes, finished: inv.finished, link: `${publicBase()}/t/${inv.id}`, agentUrl: `${publicBase()}/x/mcp/${inv.agentToken}`, tasks: tasks.script(inv.mode) };
}

// Tailscale: is the test on the internet? Funnel on :8443 with "/" here, beside the Dot's /mcp.
function ts(args) {
  return new Promise((resolve) => execFile(TAILSCALE, args, { timeout: 20000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })));
}
async function publicStatus() {
  const r = await ts(['funnel', 'status', '--json']);
  let doc = {}; try { doc = JSON.parse(r.out || '{}'); } catch { /* unreadable */ }
  const web = doc.Web || {};
  const key = Object.keys(web).find((k) => k.endsWith(':' + FUNNEL_PORT));
  const handlers = (key && web[key].Handlers) || {};
  const funnel = Boolean(key && doc.AllowFunnel && doc.AllowFunnel[key]);
  const root = handlers['/'] && handlers['/'].Proxy;
  const mcp = handlers['/mcp'] && handlers['/mcp'].Proxy;
  return { ok: r.ok, error: r.ok ? null : r.err.slice(0, 300), on: Boolean(funnel && root && root.includes(':' + PORT)), funnel, root: root || null, mcp: mcp || null, url: publicBase() };
}
async function setPublic(on) {
  const before = await publicStatus();
  const r = on
    ? await ts(['funnel', '--bg', `--https=${FUNNEL_PORT}`, '--set-path=/', `http://127.0.0.1:${PORT}`])
    : await ts(['funnel', `--https=${FUNNEL_PORT}`, '--set-path=/', 'off']);
  const after = await publicStatus();
  // The Dot's /mcp must survive either way.
  const mcpKept = !before.mcp || (after.mcp === before.mcp && after.funnel);
  return { ...after, ran: r.ok, error: r.ok ? (mcpKept ? null : 'the /mcp route changed; check `tailscale funnel status`') : r.err.slice(0, 300) };
}

function adminHost(req) {
  const h = String(req.headers.host || '').toLowerCase();
  if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h)) return true;   // a rebinding attack needs a name of its own, never these
  const names = [settings.adminBase, tailHost && `https://${tailHost}:${ADMIN_SERVE_PORT}`].filter(Boolean).map((u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } });
  return names.includes(h);
}
async function adminRequest(req, res) {
  // Never from the internet, whatever Tailscale is set to.
  if ('tailscale-funnel-request' in req.headers) return notFound(res);
  // Only this Mac's own names for it, so a page elsewhere can't reach it by DNS rebinding.
  if (!adminHost(req)) return sendJson(res, 421, { ok: false, error: 'wrong host' });
  const url = new URL(req.url, 'http://x');
  const p = url.pathname; const m = req.method === 'HEAD' ? 'GET' : req.method;
  if (req.method === 'HEAD' && p.startsWith('/admin-api/')) return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  if (m !== 'GET' && req.headers['x-meridian-admin'] !== '1') return sendJson(res, 403, { ok: false, error: 'forbidden' });

  if (p === '/' || p === '/index.html') return serveFile(res, path.join(TADMIN, 'index.html'));
  if (p.startsWith('/vendor/')) { const f = inside(path.join(TPUB, 'vendor'), p.slice('/vendor/'.length)); return f ? serveFile(res, f, { cache: 'max-age=86400' }) : notFound(res); }
  if (p.startsWith('/tester/')) { const f = inside(TPUB, p.slice('/tester/'.length)); return f ? serveFile(res, f) : notFound(res); }
  // The same pictures the tester's page shows, so replays draw them (replay.js points them here).
  const rel = p.slice(1);
  if (PAGE_FILES.has(rel) || PAGE_DIRS.some((re) => re.test(rel))) return serveFile(res, path.join(PUB, rel), { scrub: /\.(js|css|html)$/.test(rel) });
  if (/^\/api\/(demo\/)?almanac\/image\/[\w-]+$/.test(p)) return fromMain(p.replace('/demo', '') + url.search.replace(/[^?&=\w.-]/g, ''), res);
  if (/^\/api\/(demo\/)?daily-art\/image$/.test(p)) return fromMain('/api/daily-art/image', res);
  const st = p.match(/^\/api\/(?:demo\/)?stash\/(demo\d{4})\/(thumb|file)$/);
  if (st) { const it = demo.world.stashItems(Date.now()).find((x) => x.id === st[1]); return it && it.palette ? sendText(res, 200, demo.world.stashSvg(it), 'image/svg+xml') : notFound(res); }
  if (!p.startsWith('/admin-api/')) { const f = inside(TADMIN, p.slice(1)); return f ? serveFile(res, f) : notFound(res); }

  if (p === '/admin-api/live') {
    sse(res);
    ev(res, 'hello', { invites: invites.all().map(publicInvite) });
    liveStreams.add(res);
    const beat = setInterval(() => { try { res.write(': hi\n\n'); } catch { /* gone */ } }, 20000);
    req.on('close', () => { clearInterval(beat); liveStreams.delete(res); });
    return;
  }
  if (p === '/admin-api/overview' && m === 'GET') {
    return sendJson(res, 200, { invites: invites.all().map(publicInvite), publicBase: publicBase(), previewBase: previewBase(), ai: settings.ai, posthog: { set: Boolean(settings.posthog.key), host: settings.posthog.host }, recordings: Boolean(recordings), tasks: { moderated: tasks.script('moderated'), self: tasks.script('self') }, final: tasks.FINAL });
  }
  if (p === '/admin-api/public') {
    if (m === 'GET') return sendJson(res, 200, await publicStatus());
    if (m !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const b = await jsonBody(req);
    return sendJson(res, 200, await setPublic(Boolean(b.on)));
  }
  if (p === '/admin-api/settings' && m === 'POST') {
    const b = await jsonBody(req);
    if (b.posthog) settings.posthog = { key: /^phc_[\w]{20,80}$/.test(b.posthog.key || '') ? b.posthog.key : '', host: b.posthog.host === 'https://us.i.posthog.com' ? 'https://us.i.posthog.com' : 'https://eu.i.posthog.com' };
    if (b.ai) settings.ai = { ...settings.ai, on: Boolean(b.ai.on) };
    if (typeof b.publicBase === 'string') settings.publicBase = /^https:\/\/[\w.-]+(:\d+)?$/.test(b.publicBase) ? b.publicBase : '';
    saveSettings();
    return sendJson(res, 200, { ok: true, ai: settings.ai, posthog: { set: Boolean(settings.posthog.key), host: settings.posthog.host }, publicBase: publicBase() });
  }
  if (p === '/admin-api/invites' && m === 'POST') {
    const b = await jsonBody(req);
    const inv = invites.create({ name: b.name, mode: b.mode, world: b.world, note: b.note });
    sandboxes.configure(inv.id, { name: inv.name, world: inv.world });
    live('invite', publicInvite(inv));
    return sendJson(res, 201, { ok: true, invite: publicInvite(inv) });
  }
  const im = p.match(/^\/admin-api\/invites\/([a-z0-9]{4,40})(?:\/([\w-]+))?$/);
  if (im) {
    const inv = invites.get(im[1]); if (!inv) return sendJson(res, 404, { ok: false, error: 'no such invite' });
    const sub = im[2] || '';
    if (!sub && m === 'GET') return sendJson(res, 200, { invite: publicInvite(inv) });
    if (!sub && m === 'PATCH') {
      const b = await jsonBody(req); const x = invites.update(inv.id, b);
      if (b.name !== undefined || b.world !== undefined) sandboxes.configure(inv.id, { name: x.name, world: b.world !== undefined ? x.world : undefined });
      live('invite', publicInvite(x)); tell(inv.id, 'me', me(x));
      return sendJson(res, 200, { ok: true, invite: publicInvite(x) });
    }
    if (!sub && m === 'DELETE') { await forget(inv.id); return sendJson(res, 200, { ok: true }); }
    const b = m === 'POST' ? await jsonBody(req) : {};
    if (sub === 'task' && m === 'POST') {
      const n = Number(b.n); const script = tasks.script(inv.mode);
      if (!(n >= 0 && n <= script.length + 1)) return sendJson(res, 400, { ok: false, error: 'bad task' });
      const x = invites.mutate(inv.id, (y) => {
        if (y.task && !y.task.ended && y.task.n !== n) y.taskLog.push({ n: y.task.n, state: 'moved', at: Date.now(), by: 'moderator' });
        y.task = n ? { n, at: Date.now() } : null;
        if (n) y.taskLog.push({ n, state: 'start', at: Date.now(), by: 'moderator' });
      });
      tell(inv.id, 'task', { task: x.task }); live('task', { invite: inv.id, task: x.task, log: x.taskLog.slice(-1)[0] });
      return sendJson(res, 200, { ok: true, invite: publicInvite(x) });
    }
    if (sub === 'note' && m === 'POST') {
      const text = clean(b.text, 2000); if (!text) return sendJson(res, 400, { ok: false, error: 'empty note' });
      const x = invites.mutate(inv.id, (y) => { y.notes.push({ at: Date.now(), by: 'moderator', task: y.task ? y.task.n : null, text, tag: clean(b.tag, 20) || undefined }); });
      live('note', { invite: inv.id, note: x.notes.slice(-1)[0] });
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'finish' && m === 'POST') { tell(inv.id, 'finish', {}); return sendJson(res, 200, { ok: true }); }
    if (sub === 'reset' && m === 'POST') { sandboxes.reset(inv.id, { world: b.world || inv.world, name: inv.name, keepPrefs: false }); return sendJson(res, 200, { ok: true }); }
    if (sub === 'restart' && m === 'POST') {
      const x = invites.mutate(inv.id, (y) => { y.task = null; y.seq = {}; y.taskLog = []; y.answers = null; y.finished = null; });
      tell(inv.id, 'me', me(x)); live('invite', publicInvite(x));
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'agent-token' && m === 'POST') { const x = invites.newAgentToken(inv.id); live('invite', publicInvite(x)); return sendJson(res, 200, { ok: true, agentUrl: publicInvite(x).agentUrl }); }
    if (sub === 'export' && m === 'GET') {
      const sessions = recordings ? await recordings.list({ invite: inv.id }) : [];
      const summaries = [];
      for (const s of sessions) { try { summaries.push(await recordings.summary(s.session)); } catch { /* skip */ } }
      res.setHeader('Content-Disposition', `attachment; filename="meridian-test-${inv.name.toLowerCase().replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json"`);
      return sendJson(res, 200, { invite: publicInvite(inv), sandbox: sandboxes.exists(inv.id) ? sandboxes.load(inv.id) : null, sessions, summaries });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }
  if (p === '/admin-api/recordings' && m === 'GET') {
    if (!recordings) return sendJson(res, 200, { sessions: [] });
    const inv = url.searchParams.get('invite');
    return sendJson(res, 200, { sessions: await recordings.list(inv ? { invite: inv } : {}) });
  }
  const rm = p.match(/^\/admin-api\/recordings\/([a-z0-9-]{8,80})\/(events|summary)$/);
  if (rm && m === 'GET') {
    if (!recordings) return sendJson(res, 404, { ok: false });
    if (rm[2] === 'events') return sendJson(res, 200, { events: await recordings.events(rm[1]) });
    const summary = await recordings.summary(rm[1]);
    const inv = invites.get(summary.invite);
    return sendJson(res, 200, { summary: { ...summary, name: inv ? inv.name : summary.invite, notes: inv ? inv.notes.filter((n) => n.at >= summary.started - 60000 && n.at <= (summary.ended || Date.now()) + 60000) : [] } });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// ---------------------------------------------------------------- start

function guard(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      const code = e.statusCode || 500;
      if (code >= 500) console.error('tester request failed:', req.method, req.url.replace(/\/x\/mcp\/\w+/, '/x/mcp/…').replace(/\/t\/\w+/, '/t/…'), e);
      if (!res.headersSent) sendJson(res, code, { ok: false, error: code >= 500 ? 'something went wrong' : String(e.message || e) });
      else try { res.end(); } catch { /* gone */ }
    });
  };
}

function start() {
  const pub = http.createServer(guard(publicRequest));
  pub.headersTimeout = 20000; pub.requestTimeout = 60000; pub.keepAliveTimeout = 65000;
  const adm = http.createServer(guard(adminRequest));
  pub.listen(PORT, '127.0.0.1', () => console.log(`Meridian tester: public side on http://127.0.0.1:${PORT}`));
  adm.listen(ADMIN_PORT, '127.0.0.1', () => console.log(`Meridian tester: console on http://127.0.0.1:${ADMIN_PORT}`));
  return { pub, adm };
}

if (require.main === module) start();

module.exports = { start, publicRequest, adminRequest, pageHtml, mdToHtml, SCRUB, invites, sandboxes };
