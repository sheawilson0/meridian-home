'use strict';
const runtime = require('./runtime');
const JOBS_ENABLED = runtime.connectorEnabled('artwork');
// The brief's icon is today's painting: cropped square with the Meridian mark
// on top, white or ink by the contrast behind it. Compositing is a tiny
// CoreGraphics tool (scripts/brief-icon.swift), compiled here on first use.
// Outputs are cached per painting under cache/brief-icon/.
//
// Served before Meridian's auth check, like /api/daily-art: favicons and
// apple-touch-icons cannot carry the page token, and this is only a museum image.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const dailyArt = require('./brief-art');

const ROOT = __dirname;
const CACHE_DIR = path.join(runtime.CACHE_DIR, 'brief-icon');
const SWIFT_SRC = path.join(ROOT, 'scripts', 'brief-icon.swift');
const SWIFT_BIN = path.join(ROOT, 'scripts', 'brief-icon');
const FALLBACK_SVG = path.join(ROOT, 'public', 'meridian-icon.svg');
const DESIGN = 1; // bump when the look changes, so every cached icon rebuilds
const SIZES = [32, 180, 192, 512];
const KEEP = 5; // paintings kept in the cache
const CACHE_CONTROL = 'public, max-age=3600';

let state = null; // { key, art, meta, files: { svg, 32, 180, 192, 512 } }
let pending = null;
let compiling = null;

const log = (message) => console.error('brief icon: ' + message);

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.message += stderr ? ': ' + String(stderr).trim().slice(0, 300) : ''; reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

// Built once per source change. Pinned to macOS 13 because the toolchain's
// default target can be newer than the OS it runs on.
async function binary() {
  const [src, bin] = await Promise.all([fsp.stat(SWIFT_SRC), fsp.stat(SWIFT_BIN).catch(() => null)]);
  if (bin && bin.mtimeMs >= src.mtimeMs) return SWIFT_BIN;
  compiling ||= (async () => {
    const tmp = `${SWIFT_BIN}.${process.pid}.tmp`;
    const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    await run('/usr/bin/swiftc', ['-O', '-target', `${arch}-apple-macos13`, SWIFT_SRC, '-o', tmp], 180000);
    await fsp.rename(tmp, SWIFT_BIN);
    return SWIFT_BIN;
  })().finally(() => { compiling = null; });
  return compiling;
}

// Today's painting, or the saved favourite if the daily one is missing.
function source() {
  let current = null;
  try { current = dailyArt.readCurrent(); } catch { /* unreadable: fall through */ }
  const file = current && dailyArt.currentImage(current);
  if (file && fs.existsSync(file)) return { key: `${current.art.i}-d${DESIGN}`, art: current.art, file };
  const favourite = path.join(runtime.DATA_DIR, 'brief-art', 'favourite.jpg');
  try {
    const stat = fs.statSync(favourite);
    return { key: `favourite-${Math.floor(stat.mtimeMs)}-d${DESIGN}`, art: dailyArt.collection.find(art => art.favourite) || null, file: favourite };
  } catch { return null; }
}

// ---------------------------------------------------------------- SVG

// Continuous-corner rounded square, matching the PNGs (superellipse, n = 5).
function squircle(size, steps = 96) {
  const half = size / 2, e = 2 / 5, points = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    points.push(`${(half + half * Math.sign(c) * Math.abs(c) ** e).toFixed(2)} ${(half + half * Math.sign(s) * Math.abs(s) ** e).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hexColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;

// Same design as icon-32.png, as a vector over a small embedded JPEG, so it is
// crisp in tabs at any density and in the command centre's shelf.
function svgFor(meta, thumb) {
  const S = 64;
  const mark = meta.geometry?.small || { box: 0.8, stroke: 2.4 };
  const inner = meta.geometry?.scrimInner ?? 0.12, outer = meta.geometry?.scrimOuter ?? 0.62;
  const box = S * mark.box, offset = ((S - box) / 2).toFixed(3), scale = (box / 24).toFixed(5);
  const ink = hexColor(meta.markColor, '#ffffff'), dot = hexColor(meta.dotColor, ink);
  const scrim = Number(meta.scrim) || 0;
  const stops = [];
  for (let t = 0; t <= 1.0001; t += 0.125) {
    stops.push(`<stop offset="${t.toFixed(3)}" stop-color="${hexColor(meta.scrimColor, '#000000')}" stop-opacity="${(scrim * (1 - smoothstep(inner, outer, t * outer))).toFixed(3)}"/>`);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `<defs><clipPath id="b"><path d="${squircle(S)}"/></clipPath>`,
    scrim > 0 ? `<radialGradient id="s" cx="${S / 2}" cy="${S / 2}" r="${(S * outer).toFixed(2)}" gradientUnits="userSpaceOnUse">${stops.join('')}</radialGradient>` : '',
    '</defs>',
    `<g clip-path="url(#b)"><image width="${S}" height="${S}" href="data:image/jpeg;base64,${thumb.toString('base64')}"/>`,
    scrim > 0 ? `<rect width="${S}" height="${S}" fill="url(#s)"/>` : '',
    '</g>',
    `<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${ink}" stroke-width="${mark.stroke}">`,
    `<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v16.8"/><circle cx="12" cy="4.4" r="2" fill="${dot}" stroke="none"/>`,
    '</g></svg>\n',
  ].join('');
}

// ---------------------------------------------------------------- build

async function build(src, dir) {
  const bin = await binary();
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(tmp, { recursive: true });
  try {
    const { stdout } = await run(bin, [src.file, tmp], 30000);
    const meta = JSON.parse(stdout);
    await Promise.all(SIZES.map(size => fsp.access(path.join(tmp, `icon-${size}.png`))));
    const thumb = await fsp.readFile(path.join(tmp, 'thumb.jpg'));
    await fsp.writeFile(path.join(tmp, 'icon.svg'), svgFor(meta, thumb));
    // meta.json last: its presence marks a complete build.
    await fsp.writeFile(path.join(tmp, 'meta.json'), JSON.stringify({ ...meta, design: DESIGN, art: src.art, builtAt: new Date().toISOString() }, null, 2) + '\n');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
  } catch (error) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

const etagOf = (body) => `"bi-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;

async function load(src, dir) {
  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const files = {};
  const svg = await fsp.readFile(path.join(dir, 'icon.svg'));
  files.svg = { body: svg, type: 'image/svg+xml', etag: etagOf(svg) };
  for (const size of SIZES) {
    const body = await fsp.readFile(path.join(dir, `icon-${size}.png`));
    files[size] = { body, type: 'image/png', etag: etagOf(body) };
  }
  return { key: src.key, art: src.art, meta, files };
}

// Keep the last few paintings; leave samples/ and anything mid-build alone.
async function prune(keep) {
  const entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'samples') continue;
    const full = path.join(CACHE_DIR, entry.name);
    const stat = await fsp.stat(full);
    if (entry.name.includes('.tmp-')) { if (Date.now() - stat.mtimeMs > 3600e3) await fsp.rm(full, { recursive: true, force: true }); continue; }
    dirs.push({ full, mtime: stat.mtimeMs });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const { full } of dirs.slice(KEEP)) if (full !== keep) await fsp.rm(full, { recursive: true, force: true });
}

// (Re)build for the current painting. Cheap when nothing changed.
function refresh() {
  if (process.platform !== 'darwin') return Promise.resolve(state);
  if (pending) return pending;
  pending = (async () => {
    const src = source();
    if (!src) return null;
    if (state?.key === src.key) return state;
    const dir = path.join(CACHE_DIR, src.key);
    if (!fs.existsSync(path.join(dir, 'meta.json'))) {
      if (!JOBS_ENABLED || process.platform !== 'darwin' || !fs.existsSync('/usr/bin/swiftc')) return null;
      await build(src, dir);
    }
    state = await load(src, dir);
    if (JOBS_ENABLED) prune(dir).catch(error => log('prune: ' + error.message));
    return state;
  })().finally(() => { pending = null; });
  return pending;
}

// The current icon set, rebuilding first if the painting has moved on. If a
// rebuild fails, yesterday's icon is better than none.
async function current() {
  if (process.platform !== 'darwin') return state;
  const src = source();
  if (state && (!src || state.key === src.key)) return state;
  try { return await refresh(); }
  catch (error) { log(error.message); return state; }
}

// ---------------------------------------------------------------- serve

function fresh(req, etag) {
  const header = req.headers['if-none-match'];
  return Boolean(header) && header.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag);
}

// kind: 'svg' or one of SIZES.
async function send(req, res, kind = 'svg', { cacheControl = CACHE_CONTROL } = {}) {
  const icons = await current();
  let icon = icons?.files[kind];
  if (!icon && kind === 'svg') {
    try { const body = await fsp.readFile(FALLBACK_SVG); icon = { body, type: 'image/svg+xml', etag: etagOf(body) }; cacheControl = 'no-cache'; }
    catch { /* nothing to fall back to */ }
  }
  if (!icon) { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('icon unavailable'); return; }
  const headers = { 'Content-Type': icon.type, 'Cache-Control': cacheControl, ETag: icon.etag, 'X-Content-Type-Options': 'nosniff' };
  if (icon.type === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  if (fresh(req, icon.etag)) { res.writeHead(304, headers); res.end(); return; }
  headers['Content-Length'] = icon.body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : icon.body);
}

// GET /brief-icon.svg and /brief-icon.png?size=32|180|192|512. Returns true if handled.
async function handle(req, res, url = new URL(req.url, 'http://x')) {
  const p = url.pathname;
  if (p !== '/brief-icon.svg' && p !== '/brief-icon.png') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('method not allowed'); return true; }
  let kind = 'svg';
  if (p === '/brief-icon.png') {
    kind = Number(url.searchParams.get('size') || 32);
    if (!SIZES.includes(kind)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(`size must be one of ${SIZES.join(', ')}`); return true; }
  }
  try { await send(req, res, kind); }
  catch (error) {
    log(error.message);
    if (!res.headersSent) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('icon unavailable'); }
  }
  return true;
}

// True when a link points at this daemon's brief (loopback, a local address or
// this Mac's Tailscale name), so /api/favicon can serve today's icon instead of
// its 14-day cache. Other ports on the same host are other apps.
function isBriefUrl(target, { port = 4980, hosts = [] } = {}) {
  let url;
  try { url = new URL(target); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || !['/', '/brief-dia.html'].includes(url.pathname)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const linkPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const names = new Set([os.hostname().replace(/\.local$/i, '').toLowerCase()]);
  for (const name of hosts) if (name) names.add(String(name).toLowerCase());
  if (names.has(host) || (host.endsWith('.ts.net') && names.has(host.split('.')[0]))) {
    return linkPort === port || (url.protocol === 'https:' && linkPort === 443);
  }
  const local = new Set(['localhost', '127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) local.add(a.address.toLowerCase());
  return local.has(host) && linkPort === port;
}

// Build at boot, then check every few minutes (reading one small JSON file);
// requests also rebuild on demand when the painting changes.
function start(intervalMs = 5 * 60 * 1000) {
  if (!JOBS_ENABLED || process.platform !== 'darwin') return () => {};
  const tick = () => { refresh().catch(error => log(error.message)); };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { handle, send, refresh, start, isBriefUrl, svgFor, SIZES, CACHE_DIR };
