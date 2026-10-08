'use strict';
const runtime = require('./runtime');
const { JOBS_ENABLED } = runtime;

// Stash: everything Owner keeps to come back to. Screenshots, images, links,
// notes, quotes, colours and files, sent from either Mac, the phone or the page.
// It lives on the Home Mac (always on, where Meridian runs); the Main Mac sends
// to it over Tailscale and holds an outbox while Home is asleep.
//
// One JSON index plus the files, no dependencies:
//   data/stash/items.json     the items, newest last, plus seenAt and space order
//   data/stash/vectors.json   Vision fingerprints for "same vibe", kept apart because they're big
//   data/stash/files/         originals, <id>.<ext>
//   data/stash/thumbs/        <id>.jpg, 900 px on the long side
//
// Images go through scripts/stash-vision (Apple Vision on this Mac): text in the
// picture, labels, main colours, a fingerprint and the thumbnail. Links get their
// page title and preview image, or a headless Chrome screenshot when there isn't one.
// Deleting keeps the item for 30 days so undo always works.
//
// Notes (and long quotes) get a one-line summary from a cheap model
// (stash-summary.js), made when they're saved and again when the words change.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { needsSummary, summaryKey } = require('./stash-summary');
const { checkPublicUrl, publicLookup } = require('./public-network');

const TRASH_DAYS = 30;
const MAX_FILE = 80 * 1024 * 1024;
const KINDS = ['image', 'link', 'note', 'quote', 'colour', 'file', 'video'];
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif']);
const VIDEO_EXT = new Set(['mov', 'mp4', 'm4v', 'webm']);
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/avif': 'avif', 'image/bmp': 'bmp', 'application/pdf': 'pdf', 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm', 'text/plain': 'txt' };
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
Object.assign(EXT_MIME, { jpeg: 'image/jpeg', tif: 'image/tiff', m4v: 'video/mp4', md: 'text/markdown', svg: 'image/svg+xml', zip: 'application/zip' });
const SOURCES = ['screenshot', 'clipboard', 'page', 'drop', 'paste', 'note', 'tray', 'upload', 'import', 'phone', 'share', 'capture', 'agent'];

const clean = (v, max = 500) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const ID_RE = /^[a-z0-9]{8,20}$/;
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());
const HEX_RE = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function cleanUrl(v) {
  const s = clean(v, 4000);
  if (!s) return '';
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}
function cleanSpaces(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(list.map((s) => clean(s, 40).replace(/^#/, '')).filter(Boolean))].slice(0, 12);
}
function cleanPage(p) {
  if (!p || typeof p !== 'object') return null;
  const url = cleanUrl(p.url);
  const title = clean(p.title, 300);
  return url || title ? { url, title, app: clean(p.app, 60) } : null;
}
function extOf(name, type) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,6})$/);
  if (m) return m[1];
  return MIME_EXT[String(type || '').toLowerCase()] || 'bin';
}

// ---------------------------------------------------------------- colours

function hexToHsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
// Plain colour words for search ("blue posters") and the swatch labels.
function colourName(hex) {
  const { h, s, l } = hexToHsl(hex);
  if (l < 0.13) return 'black';
  if (l > 0.92 && s < 0.35) return 'white';
  if (s < 0.13) return l > 0.8 ? 'white' : 'grey';
  if (h < 14 || h >= 340) return 'red';
  if (h < 42) return l < 0.42 && s < 0.75 ? 'brown' : 'orange';
  if (h < 66) return l < 0.35 ? 'brown' : 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}
const COLOURS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'black', 'white', 'grey'];
const COLOUR_ALIAS = { gray: 'grey', violet: 'purple', navy: 'blue', cyan: 'teal', turquoise: 'teal', gold: 'yellow', beige: 'brown', magenta: 'pink' };

function normalHex(s) {
  const m = String(s).trim().match(HEX_RE);
  if (!m) return null;
  const v = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return '#' + v.toLowerCase();
}

// ---------------------------------------------------------------- search

const KIND_WORDS = {
  image: 'image', images: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', pic: 'image', pics: 'image',
  screenshot: 'screenshot', screenshots: 'screenshot', shot: 'screenshot', shots: 'screenshot',
  link: 'link', links: 'link', site: 'link', sites: 'link', website: 'link', websites: 'link', page: 'link', pages: 'link', url: 'link', urls: 'link',
  note: 'note', notes: 'note', quote: 'quote', quotes: 'quote',
  colour: 'colour', colours: 'colour', color: 'colour', colors: 'colour', swatch: 'colour', swatches: 'colour',
  file: 'file', files: 'file', pdf: 'file', pdfs: 'file', video: 'video', videos: 'video',
};
const KIND_LABEL = { image: 'Images', screenshot: 'Screenshots', link: 'Links', note: 'Notes', quote: 'Quotes', colour: 'Colours', file: 'Files', video: 'Videos' };
const FILLER = new Set(['from', 'with', 'of', 'the', 'a', 'an', 'in', 'on', 'about', 'my', 'and', 'that', 'for', 'to', 'at', 'some', 'any', 'all']);
const DAY = 86400e3;

function dateRange(word, now) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  const monday = today - ((d.getDay() + 6) % 7) * DAY;
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  switch (word) {
    case 'today': return [today, Infinity, 'Today'];
    case 'yesterday': return [today - DAY, today, 'Yesterday'];
    case 'this week': return [monday, Infinity, 'This week'];
    case 'last week': return [monday - 7 * DAY, monday, 'Last week'];
    case 'this month': return [month, Infinity, 'This month'];
    case 'last month': return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), month, 'Last month'];
    case 'this year': return [new Date(d.getFullYear(), 0, 1).getTime(), Infinity, 'This year'];
    default: return null;
  }
}

// Loose phrases become filters he can see and remove: "blue screenshots last week",
// "quotes from vitsoe", "#moodboard", "site:dribbble.com", "\"exact words\"".
function parseQuery(q, now = Date.now()) {
  let rest = ` ${String(q || '').toLowerCase()} `;
  const chips = [];
  const filters = { kinds: new Set(), colours: new Set(), spaces: new Set(), sites: new Set(), from: null, range: null, phrases: [], words: [] };
  rest = rest.replace(/"([^"]+)"/g, (_, p) => { filters.phrases.push(p.trim()); chips.push({ type: 'phrase', label: `“${p.trim()}”`, raw: `"${p}"` }); return ' '; });
  for (const w of ['this week', 'last week', 'this month', 'last month', 'this year', 'yesterday', 'today']) {
    const re = new RegExp(`(^|\\s)${w}(?=\\s)`);
    if (re.test(rest)) { const r = dateRange(w, now); filters.range = r; chips.push({ type: 'date', label: r[2], raw: w }); rest = rest.replace(re, ' '); break; }
  }
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^#(.+)/))) { filters.spaces.add(m[1]); chips.push({ type: 'space', label: '#' + m[1], raw: tok }); continue; }
    if ((m = tok.match(/^site:(.+)/))) { filters.sites.add(m[1].replace(/^www\./, '')); chips.push({ type: 'site', label: m[1], raw: tok }); continue; }
    if ((m = tok.match(/^from:(main|home|phone|iphone)$/))) { filters.from = m[1] === 'iphone' ? 'phone' : m[1]; chips.push({ type: 'from', label: 'From ' + filters.from, raw: tok }); continue; }
    if (KIND_WORDS[tok]) { const k = KIND_WORDS[tok]; if (!filters.kinds.has(k)) chips.push({ type: 'kind', label: KIND_LABEL[k], raw: tok, value: k }); filters.kinds.add(k); continue; }
    const c = COLOUR_ALIAS[tok] || tok;
    if (COLOURS.includes(c)) { filters.colours.add(c); chips.push({ type: 'colour', label: c, raw: tok, value: c }); continue; }
    if (/^[a-z0-9-]+\.[a-z]{2,}(\.[a-z]{2,})?$/.test(tok)) { filters.sites.add(tok.replace(/^www\./, '')); chips.push({ type: 'site', label: tok, raw: tok }); continue; }
    filters.words.push(tok);
  }
  // "quotes from vitsoe": the little words only matter when they're all there is.
  if (filters.words.some((w) => !FILLER.has(w))) filters.words = filters.words.filter((w) => !FILLER.has(w));
  return { filters, chips };
}

function haystack(it) {
  return [it.title, it.summary, it.note, it.text, it.ocr, it.url, it.domain, it.name, it.page?.title, it.page?.url, it.page?.app,
    ...(it.labels || []).map((l) => l.id.replace(/_/g, ' ')), ...(it.spaces || []), ...(it.palette || []).map((p) => p.hex)].join(' \n').toLowerCase();
}
function wordHit(hay, w) {
  if (hay.includes(w)) return true;
  if (w.length > 3 && w.endsWith('s') && hay.includes(w.slice(0, -1))) return true;
  return false;
}
function matches(it, f) {
  if (f.kinds.size) {
    const shot = it.source === 'screenshot' || (it.labels || []).some((l) => l.id === 'screenshot');
    const ok = [...f.kinds].some((k) => (k === 'screenshot' ? it.kind === 'image' && shot : it.kind === k));
    if (!ok) return false;
  }
  if (f.colours.size) {
    const names = new Set((it.palette || []).filter((p) => p.weight >= 0.06).map((p) => p.name || colourName(p.hex)));
    if (it.kind === 'colour' && it.hex) names.add(colourName(it.hex));
    if (![...f.colours].every((c) => names.has(c))) return false;
  }
  if (f.spaces.size && ![...f.spaces].every((s) => (it.spaces || []).some((x) => x.toLowerCase() === s))) return false;
  if (f.sites.size && ![...f.sites].some((s) => (it.domain || '').includes(s) || domainOf(it.page?.url).includes(s))) return false;
  if (f.from && String(it.from || '').toLowerCase() !== f.from) return false;
  if (f.range && !(it.created >= f.range[0] && it.created < f.range[1])) return false;
  if (f.phrases.length || f.words.length) {
    const hay = haystack(it);
    if (!f.phrases.every((p) => hay.includes(p))) return false;
    if (!f.words.every((w) => wordHit(hay, w))) return false;
  }
  return true;
}
function score(it, f) {
  if (!f.words.length && !f.phrases.length) return 0;
  const strong = [it.title, it.summary, it.note, it.text, ...(it.spaces || [])].join(' ').toLowerCase();
  return [...f.words, ...f.phrases].reduce((n, w) => n + (strong.includes(w) ? 3 : 1), 0);
}

// ---------------------------------------------------------------- web pages

async function publicUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    checkPublicUrl(u);
    await new Promise((resolve, reject) => publicLookup(u.hostname.replace(/^\[|\]$/g, ''), {}, (err) => err ? reject(err) : resolve()));
    return true;
  } catch { return false; }
}

function fetchRaw(url, { max = 1024 * 1024, timeout = 8000, redirects = 4, accept = '*/*', publicOnly = false } = {}) {
  return new Promise((resolve) => {
    let mod;
    try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(null); if (publicOnly) checkPublicUrl(u); mod = u.protocol === 'https:' ? https : http; } catch { return resolve(null); }
    // A pooled owner connection could bypass the checked DNS lookup.
    const req = mod.request(url, { ...(publicOnly ? { lookup: publicLookup, agent: false } : {}), timeout, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: accept, 'Accept-Language': 'en-GB,en;q=0.8' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url).href; } catch { return resolve(null); }
        return resolve(fetchRaw(next, { max, timeout, redirects: redirects - 1, accept, publicOnly }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); else req.destroy(); });
      res.on('end', () => resolve({ url, type: String(res.headers['content-type'] || '').split(';')[0].trim(), buffer: Buffer.concat(chunks) }));
      res.on('error', () => resolve(chunks.length ? { url, type: String(res.headers['content-type'] || '').split(';')[0].trim(), buffer: Buffer.concat(chunks) } : null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

// Favicons: anything from 32 px up, nearest 96; 16 px ones only if that's all there is.
const iconScore = (size) => (size < 32 ? 1000 - size : Math.abs(96 - size));

function readPage(html, base) {
  const head = html.slice(0, 400000);
  const meta = (name) => {
    const tags = head.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'gi')) || [];
    for (const t of tags) { const v = (t.match(/content=["']([^"']*)["']/i) || [])[1]; if (v) return decode(v).trim(); }
    return '';
  };
  const abs = (u) => { try { return u ? new URL(decode(u), base).href : ''; } catch { return ''; } };
  let title = meta('og:title') || meta('twitter:title') || decode((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  if (title.length > 160) title = title.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  const icons = [...head.matchAll(/<link[^>]+rel=["']([^"']*icon[^"']*)["'][^>]*>/gi)].map((m) => {
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
    const size = Number(((m[0].match(/sizes=["'](\d+)x/i) || [])[1]) || (/apple-touch/i.test(m[1]) ? 180 : 16));
    return { href: abs(href), size, svg: /\.svg(\?|$)/i.test(href || '') };
  }).filter((i) => i.href && !i.svg).sort((a, b) => iconScore(a.size) - iconScore(b.size));
  return {
    title,
    description: clean(meta('og:description') || meta('twitter:description') || meta('description'), 600),
    image: abs(meta('og:image') || meta('og:image:url') || meta('twitter:image') || meta('twitter:image:src')),
    site: clean(meta('og:site_name'), 80),
    icon: icons[0]?.href || '',
  };
}

// ---------------------------------------------------------------- store

function createStash({ dir, preview = null, onChange = () => {}, now = () => Date.now(), visionBin = null, visionSrc = null, fetch: fetcher = fetchRaw, quicklook = true, summarise = null, summaryDelayMs = 20000, log = (m) => console.error('stash: ' + m) }) {
  const FILES = path.join(dir, 'files');
  const THUMBS = path.join(dir, 'thumbs');
  const INDEX = path.join(dir, 'items.json');
  const VECTORS = path.join(dir, 'vectors.json');
  let data = null;            // { version, seenAt, spaces, items: [] }
  let vectors = {};           // id → Float32Array
  let saving = null, dirty = false, vecDirty = false;

  let loading = null, purging = null, lastPurge = null;
  let purgeFiles = [];

  function load() {
    if (loading) return loading;
    if (data) return Promise.resolve(data);
    loading = (async () => {
      if (JOBS_ENABLED) {
        await fsp.mkdir(FILES, { recursive: true });
        await fsp.mkdir(THUMBS, { recursive: true });
      }
      let parsed;
      try {
        parsed = JSON.parse(await fsp.readFile(INDEX, 'utf8'));
        if (!parsed || !Array.isArray(parsed.items)) throw new SyntaxError('invalid stash index');
      } catch (e) {
        parsed = null;
        if (e.code !== 'ENOENT') {
          if (!(e instanceof SyntaxError)) throw e;
          const backup = `${INDEX}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
          if (JOBS_ENABLED) await fsp.rename(INDEX, backup);
          if (JOBS_ENABLED) log(`corrupt index moved to ${backup}: ${e.message}`);
        }
      }
      data = parsed || { version: 1, seenAt: now(), spaces: [], items: [] };
      try {
        const raw = JSON.parse(await fsp.readFile(VECTORS, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyntaxError('invalid stash vectors');
        for (const [id, b64] of Object.entries(raw)) {
          if (typeof b64 !== 'string') throw new SyntaxError('invalid stash vector');
          const b = Buffer.from(b64, 'base64');
          if (b.length % 4) throw new SyntaxError('invalid stash vector');
          vectors[id] = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') {
          if (!(e instanceof SyntaxError)) throw e;
          const backup = `${VECTORS}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
          if (JOBS_ENABLED) await fsp.rename(VECTORS, backup);
          if (JOBS_ENABLED) log(`corrupt vectors moved to ${backup}: ${e.message}`);
        }
        vectors = {};
      }
      if (JOBS_ENABLED) await purge();
      // Anything left half-done by a restart goes back on the queue, and notes
      // without a summary for their current words get one (the backfill).
      for (const it of data.items) if (!it.deleted && it.pending) queue(it.id);
      for (const it of data.items) if (staleSummary(it)) queueSummary(it.id);
      return data;
    })().catch((e) => { data = null; throw e; }).finally(() => { loading = null; });
    return loading;
  }

  async function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await fsp.writeFile(tmp, text); await fsp.rename(tmp, file); }
    finally { await fsp.unlink(tmp).catch(() => {}); }
  }
  function save() {
    dirty = true;
    if (saving) return saving;
    saving = (async () => {
      try {
        await new Promise((r) => setTimeout(r, 120));
        while (dirty || vecDirty) {
          if (dirty) {
            dirty = false;
            try { await writeAtomic(INDEX, JSON.stringify(data, null, 1) + '\n'); }
            catch (e) { dirty = true; throw e; }
          }
          if (vecDirty) {
            vecDirty = false;
            const out = {};
            for (const [id, v] of Object.entries(vectors)) out[id] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
            try { await writeAtomic(VECTORS, JSON.stringify(out)); }
            catch (e) { vecDirty = true; throw e; }
          }
        }
      } catch (e) { log('save failed: ' + e.message); throw e; }
      finally { saving = null; }
    })();
    return saving;
  }
  const changed = async (action, it) => {
    await purge();
    await save();
    try { onChange({ action, id: it?.id, kind: it?.kind }); } catch { /* listeners never break a write */ }
  };

  function purge() {
    if (purging) return purging;
    if (lastPurge !== null && now() - lastPurge < DAY) return Promise.resolve();
    purging = (async () => {
      const cut = now() - TRASH_DAYS * DAY;
      const gone = data.items.filter((it) => it.deleted && it.deleted < cut);
      if (gone.length) {
        data.items = data.items.filter((it) => !gone.includes(it));
        for (const it of gone) delete vectors[it.id];
        vecDirty = true;
        purgeFiles.push(...gone);
      }
      if (purgeFiles.length) {
        await save();
        for (const it of purgeFiles) await removeFiles(it);
        purgeFiles = [];
      }
      lastPurge = now();
    })().finally(() => { purging = null; });
    return purging;
  }
  async function removeFiles(it) {
    for (const f of [it.file && path.join(dir, it.file), path.join(THUMBS, it.id + '.jpg'), it.icon && path.join(dir, it.icon)]) {
      if (f) await fsp.unlink(f).catch(() => {});
    }
  }

  const byId = (id) => data.items.find((it) => it.id === id);
  const live = () => data.items.filter((it) => !it.deleted);

  // ---- adding things

  function base(input) {
    const t = now();
    return {
      id: newId(), kind: 'note', title: '', note: clean(input.note, 4000), text: '', url: '', domain: '',
      source: SOURCES.includes(input.source) ? input.source : 'paste',
      from: clean(input.from, 30) || null,
      ...(input.agent ? { agent: clean(input.agent, 40) } : {}),
      page: cleanPage(input.page),
      spaces: cleanSpaces(input.spaces),
      pinned: false, created: t, updated: t,
    };
  }

  // Text, a link or a colour. A lone URL becomes a link; text copied from a
  // browser page becomes a quote with that page as its source.
  async function addText(input = {}, { publicOnly = false, check } = {}) {
    await load();
    const raw = String(input.text ?? '').replace(/\r\n/g, '\n').trim();
    const url = cleanUrl(input.url) || (isUrl(raw) && !/\s/.test(raw) ? cleanUrl(raw) : '');
    const it = base(input);
    if (input.title) it.title = clean(input.title, 300);
    const hex = !url && normalHex(raw);
    if (publicOnly) it.publicOnly = true;
    const publicAllowed = !publicOnly || !runtime.connectorEnabled('stashEnrichment') || !(url || input.url) || await publicUrl(url);
    check?.(); // URL checks can await DNS; a revoked grant must not add a note afterwards.
    if (!publicAllowed) {
      Object.assign(it, { kind: 'note', text: (raw || String(input.url)).slice(0, 40000), page: null });
    } else if (url && (!raw || cleanUrl(raw) === url || input.kind === 'link')) {
      // An owner capture may contain private redirect results or a screenshot.
      const existing = live().find((x) => x.kind === 'link' && x.url === url && (!publicOnly || x.publicOnly));
      // Owner saving a link an agent saved first: it becomes his capture, screenshot and all,
      // exactly as if he'd saved it first. One card, not two.
      if (existing && !publicOnly && existing.publicOnly) {
        delete existing.publicOnly; existing.pending = runtime.connectorEnabled('stashEnrichment'); existing.updated = now();
        await changed('update', existing); queue(existing.id);
        return { ok: true, item: existing, duplicate: true };
      }
      if (existing) { await save(); return { ok: true, item: existing, duplicate: true }; }
      Object.assign(it, { kind: 'link', url, domain: domainOf(url), pending: runtime.connectorEnabled('stashEnrichment') });
      if (!it.title && it.page?.url === url && it.page.title) it.title = it.page.title;
    } else if (hex) {
      Object.assign(it, { kind: 'colour', hex, text: hex, title: it.title || colourName(hex) });
    } else {
      if (!raw) throw Object.assign(new Error('nothing to stash'), { statusCode: 400 });
      const kind = ['note', 'quote'].includes(input.kind) ? input.kind : (it.page?.url ? 'quote' : 'note');
      Object.assign(it, { kind, text: raw.slice(0, 40000) });
      if (kind === 'quote') { it.url = it.page?.url || url || ''; it.domain = domainOf(it.url); }
    }
    data.items.push(it);
    await changed('add', it);
    if (it.pending) queue(it.id);
    if (staleSummary(it)) queueSummary(it.id);
    return { ok: true, item: it };
  }

  // Bytes: an image, a PDF, a video or any other file. Same bytes twice is one item.
  async function addFile(buffer, input = {}) {
    await load();
    if (!buffer || !buffer.length) throw Object.assign(new Error('empty file'), { statusCode: 400 });
    if (buffer.length > MAX_FILE) throw Object.assign(new Error('that file is over 80 MB'), { statusCode: 413 });
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = data.items.find((x) => x.sha === sha);
    if (existing && !existing.deleted) { await save(); return { ok: true, item: existing, duplicate: true }; }
    if (existing && existing.deleted) { existing.deleted = null; existing.updated = now(); await changed('restore', existing); return { ok: true, item: existing, duplicate: true }; }
    const it = base(input);
    const ext = extOf(input.name, input.type);
    const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : 'file';
    const rel = path.join('files', `${it.id}.${ext}`);
    await fsp.writeFile(path.join(dir, rel), buffer);
    const name = clean(input.name, 200);
    Object.assign(it, {
      kind, file: rel, sha, bytes: buffer.length, mime: EXT_MIME[ext] || clean(input.type, 80) || 'application/octet-stream',
      name: /^(image|screenshot|clipboard|pasted|untitled)[\w .-]*\.\w+$/i.test(name) || /^Screenshot \d{4}/.test(name) ? '' : name,
      title: clean(input.title, 300), pending: runtime.connectorEnabled('stashEnrichment'),
    });
    if (it.page?.url) { it.url = it.page.url; it.domain = domainOf(it.page.url); }
    data.items.push(it);
    await changed('add', it);
    queue(it.id);
    return { ok: true, item: it };
  }

  // ---- enrichment, one at a time in the background

  const jobs = [];
  let working = false;
  function queue(id) { if (!runtime.connectorEnabled('stashEnrichment')) return; if (!jobs.includes(id)) jobs.push(id); if (!working) void work(); }
  async function work() {
    working = true;
    while (jobs.length) {
      const id = jobs.shift();
      const it = byId(id);
      if (!it || it.deleted) continue;
      try {
        if (it.kind === 'image') await enrichImage(it, path.join(dir, it.file));
        else if (it.kind === 'link') await enrichLink(it);
        else if (it.kind === 'file' || it.kind === 'video') await enrichFile(it);
      } catch (e) { log(`enrich ${id}: ${e.message}`); }
      delete it.pending;
      it.updated = now();
      await changed('update', it).catch((e) => log(`enrich ${id}: ${e.message}`));
    }
    working = false;
  }

  // ---- summaries, one at a time, apart from the picture queue so a slow
  // Vision run never holds up a note. Edits wait summaryDelayMs for typing to stop.

  const sumJobs = [];
  const sumTimers = new Map();
  const sumFailed = new Map();   // id → the words that failed; not again until they change or Meridian restarts
  let summing = false;
  function staleSummary(it) {
    if (!summarise || !it || it.deleted) return false;
    if (!needsSummary(it)) return false;
    return it.summaryKey !== summaryKey(it) && sumFailed.get(it.id) !== summaryKey(it);
  }
  function queueSummary(id, delay = 0) {
    if (!runtime.connectorEnabled('stashSummary') || !summarise) return;
    clearTimeout(sumTimers.get(id));
    sumTimers.delete(id);
    if (delay > 0) {
      const t = setTimeout(() => { sumTimers.delete(id); queueSummary(id); }, delay);
      if (t.unref) t.unref();
      sumTimers.set(id, t);
      return;
    }
    if (!sumJobs.includes(id)) sumJobs.push(id);
    if (!summing) void sumWork();
  }
  async function sumWork() {
    summing = true;
    while (sumJobs.length) {
      const id = sumJobs.shift();
      const it = byId(id);
      if (!staleSummary(it)) continue;
      const key = summaryKey(it);
      try {
        const r = await summarise({ text: it.text, title: it.title, kind: it.kind });
        if (!r) continue;   // summaries are off
        if (it.deleted || summaryKey(it) !== key) continue;   // edited meanwhile; the edit queued its own
        Object.assign(it, { summary: r.summary, summaryKey: key, summaryBy: r.by, summaryAt: now() });
        sumFailed.delete(id);
      } catch (e) {
        log(`summary ${id}: ${e.message}`);
        sumFailed.set(id, key);
        continue;
      }
      await changed('update', it).catch((e) => log(`summary ${id}: ${e.message}`));
    }
    summing = false;
  }
  // A note that got short drops its old summary; the card shows the note itself.
  function dropSummary(it) {
    if (it.summary !== undefined && !needsSummary(it)) { delete it.summary; delete it.summaryKey; delete it.summaryBy; delete it.summaryAt; }
  }

  let compiling = null;
  async function vision() {
    if (process.platform !== 'darwin') return false;
    if (!visionBin || !visionSrc) return null;
    const [src, bin] = await Promise.all([fsp.stat(visionSrc).catch(() => null), fsp.stat(visionBin).catch(() => null)]);
    if (bin && (!src || bin.mtimeMs >= src.mtimeMs)) return visionBin;
    if (!src || !fs.existsSync('/usr/bin/swiftc')) return null;
    compiling ||= (async () => {
      const tmp = `${visionBin}.${process.pid}.tmp`;
      const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
      await exec('/usr/bin/swiftc', ['-O', '-target', `${arch}-apple-macos13`, visionSrc, '-o', tmp], 240000);
      await fsp.rename(tmp, visionBin);
      return visionBin;
    })().catch((e) => { log('vision build failed: ' + e.message); return null; }).finally(() => { compiling = null; });
    return compiling;
  }
  function exec(file, args, timeout = 60000) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { err.message += stderr ? ': ' + String(stderr).trim().slice(0, 300) : ''; reject(err); } else resolve(String(stdout));
      });
    });
  }

  // Vision on an image file; keepText=false for link previews, where the words are the page's, not his.
  async function enrichImage(it, file, { keepText = true } = {}) {
    const bin = await vision();
    if (!bin) return false;
    const thumb = path.join(THUMBS, it.id + '.jpg');
    let r;
    try { r = JSON.parse((await exec(bin, [file, thumb], 90000)).trim().split('\n').pop()); } catch (e) { log(`vision ${it.id}: ${e.message}`); return false; }
    if (!r.ok) return false;
    if (keepText || it.kind === 'image') { it.w = r.w; it.h = r.h; }
    it.thumb = !!r.thumb;
    if (r.thumb) { it.tw = r.w >= r.h ? Math.min(900, r.w) : Math.round(Math.min(900, r.h) * r.w / r.h); it.th = r.w >= r.h ? Math.round(Math.min(900, r.w) * r.h / r.w) : Math.min(900, r.h); }
    it.palette = (r.palette || []).map((p) => ({ hex: p.hex, weight: p.weight, name: colourName(p.hex) }));
    it.labels = (r.labels || []).map((l) => ({ id: l.id, c: l.c }));
    if (keepText) it.ocr = clean(r.text, 20000);
    if (r.featurePrint) { const b = Buffer.from(r.featurePrint, 'base64'); vectors[it.id] = new Float32Array(b.buffer, b.byteOffset, b.length / 4); vecDirty = true; }
    return true;
  }

  async function enrichLink(it) {
    const policy = it.publicOnly ? { publicOnly: true } : {};
    const page = await fetcher(it.url, { ...policy, accept: 'text/html,application/xhtml+xml' });
    let meta = { title: '', description: '', image: '', site: '', icon: '' };
    if (page && /html|xml/.test(page.type || 'text/html')) meta = readPage(page.buffer.toString('utf8'), page.url);
    else if (page && /^image\//.test(page.type)) meta.image = it.url;
    if (!it.title) it.title = meta.title;
    it.description = meta.description;
    it.site = meta.site;
    // Preview: the page's own share image, else a screenshot from headless Chrome.
    let got = false;
    if (meta.image) {
      const img = await fetcher(meta.image, { ...policy, max: 12 * 1024 * 1024, accept: 'image/*' });
      if (img && /^image\//.test(img.type || 'image/')) {
        const tmp = path.join(THUMBS, `${it.id}.og.${extOf('', img.type) === 'bin' ? 'img' : extOf('', img.type)}`);
        await fsp.writeFile(tmp, img.buffer);
        got = await enrichImage(it, tmp, { keepText: false });
        await fsp.unlink(tmp).catch(() => {});
        it.preview = got ? 'og' : undefined;
      }
    }
    // Chrome's later navigations and subresources cannot use the pinned lookup.
    if (!got && preview && !it.publicOnly) {
      try {
        const shot = await preview('stash-' + it.id, it.url);
        if (shot && shot !== 'pending') { got = await enrichImage(it, shot, { keepText: false }); it.preview = got ? 'shot' : undefined; }
      } catch (e) { log(`screenshot ${it.id}: ${e.message}`); }
    }
    if (meta.icon) {
      const ico = await fetcher(meta.icon, { ...policy, max: 256 * 1024, accept: 'image/*' });
      if (ico && ico.buffer.length > 60 && /^image\//.test(ico.type || 'image/')) {
        const rel = path.join('files', `${it.id}.icon`);
        await fsp.writeFile(path.join(dir, rel), ico.buffer);
        it.icon = rel; it.iconType = ico.type || 'image/x-icon';
      }
    }
  }

  // PDFs, videos, documents: Quick Look draws the thumbnail, then Vision reads it like any image.
  async function enrichFile(it) {
    if (!quicklook || process.platform !== 'darwin' || !fs.existsSync('/usr/bin/qlmanage')) return;
    const src = path.join(dir, it.file);
    const out = path.join(THUMBS, `${it.id}.ql`);
    await fsp.mkdir(out, { recursive: true });
    try {
      await exec('/usr/bin/qlmanage', ['-t', '-s', '900', '-o', out, src], 20000);
      const png = (await fsp.readdir(out)).find((f) => f.endsWith('.png'));
      if (png) await enrichImage(it, path.join(out, png), { keepText: it.kind === 'file' });
    } catch (e) { log(`quicklook ${it.id}: ${e.message}`); }
    await fsp.rm(out, { recursive: true, force: true });
  }

  // ---- reading

  // The list leaves out the long text and fingerprints; GET one item for everything.
  function slim(it) {
    const { ocr, sha, ...rest } = it;
    const out = { ...rest, hasText: !!(ocr && ocr.length > 2), labels: (it.labels || []).slice(0, 6) };
    if (out.text && out.text.length > 1200) out.text = out.text.slice(0, 1200) + '…';
    if (vectors[it.id]) out.similar = true;
    return out;
  }

  async function list({ q = '', kind = '', space = '', limit = 300, offset = 0, order = 'new' } = {}) {
    await load();
    const { filters, chips } = parseQuery(q, now());
    if (kind && (KINDS.includes(kind) || kind === 'screenshot')) filters.kinds.add(kind);
    if (space) filters.spaces.add(String(space).toLowerCase());
    const all = live();
    let found = all.filter((it) => matches(it, filters));
    if (order === 'shuffle') {
      // Same order for the whole day, so paging and refreshes don't reshuffle under him.
      const seed = new Date(now()).toDateString();
      const h = (id) => crypto.createHash('md5').update(seed + id).digest().readUInt32BE(0);
      found.sort((a, b) => h(a.id) - h(b.id));
    } else if (filters.words.length || filters.phrases.length) {
      found = found.map((it) => [score(it, filters), it]).sort((a, b) => b[0] - a[0] || b[1].created - a[1].created).map((x) => x[1]);
    } else {
      found.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.created - a.created);
    }
    const counts = { all: all.length };
    for (const it of all) {
      counts[it.kind] = (counts[it.kind] || 0) + 1;
      if (it.kind === 'image' && (it.source === 'screenshot' || (it.labels || []).some((l) => l.id === 'screenshot'))) counts.screenshot = (counts.screenshot || 0) + 1;
    }
    const spaceCounts = new Map();
    for (const it of all) for (const s of it.spaces || []) spaceCounts.set(s, (spaceCounts.get(s) || 0) + 1);
    const ordered = [...(data.spaces || []).filter((s) => spaceCounts.has(s)), ...[...spaceCounts.keys()].filter((s) => !(data.spaces || []).includes(s)).sort()];
    return {
      ok: true, total: found.length, chips, counts,
      spaces: ordered.map((name) => ({ name, n: spaceCounts.get(name) })),
      seenAt: data.seenAt || 0, fresh: all.filter((it) => it.created > (data.seenAt || 0)).length,
      items: found.slice(offset, offset + Math.min(1000, limit)).map(slim),
    };
  }

  async function get(id) {
    await load();
    const it = byId(id);
    if (!it) throw Object.assign(new Error('not in the stash'), { statusCode: 404 });
    const { sha, ...rest } = it;
    return { ...rest, similar: !!vectors[id] };
  }

  async function similar(id, limit = 30) {
    await load();
    const v = vectors[id];
    if (!v) return { ok: true, items: [] };
    const out = [];
    for (const it of live()) {
      const w = vectors[it.id];
      if (!w || it.id === id || w.length !== v.length) continue;
      let d = 0; for (let i = 0; i < v.length; i++) { const x = v[i] - w[i]; d += x * x; }
      out.push([Math.sqrt(d), it]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return { ok: true, items: out.slice(0, limit).map(([d, it]) => ({ ...slim(it), distance: Math.round(d * 1000) / 1000 })) };
  }

  // Paths for the server to stream. Only ever inside the stash folder.
  async function filePath(id, which) {
    await load();
    const it = byId(id);
    if (!it) return null;
    if (which === 'thumb') return it.thumb ? { file: path.join(THUMBS, it.id + '.jpg'), type: 'image/jpeg' } : null;
    if (which === 'icon') return it.icon ? { file: path.join(dir, it.icon), type: it.iconType || 'image/x-icon' } : null;
    if (!it.file) return null;
    return { file: path.join(dir, it.file), type: it.mime || 'application/octet-stream', name: it.name || `${(it.title || 'stash-' + it.id).replace(/[^\w .-]+/g, '').slice(0, 80)}.${it.file.split('.').pop()}` };
  }

  // ---- changing

  async function patch(id, p = {}) {
    await load();
    const it = byId(id);
    if (!it || it.deleted) throw Object.assign(new Error('not in the stash'), { statusCode: 404 });
    if (p.title !== undefined) it.title = clean(p.title, 300);
    if (p.note !== undefined) it.note = clean(p.note, 4000);
    if (p.text !== undefined && ['note', 'quote'].includes(it.kind)) it.text = String(p.text).trim().slice(0, 40000);
    if (p.kind !== undefined && ['note', 'quote'].includes(it.kind) && ['note', 'quote'].includes(p.kind)) it.kind = p.kind;
    if (p.spaces !== undefined) it.spaces = cleanSpaces(p.spaces);
    if (p.pinned !== undefined) it.pinned = !!p.pinned;
    // Swipe to sort (public/stash-sort.html): kept means "seen it, it stays".
    if (p.kept !== undefined) { if (p.kept) it.kept = now(); else delete it.kept; }
    if (p.summary !== undefined && ['note', 'quote'].includes(it.kind)) {
      // Owner rewrote the line himself: it stands until the words change.
      const line = clean(p.summary, 200).replace(/\s+/g, ' ');
      if (line) Object.assign(it, { summary: line, summaryKey: summaryKey(it), summaryBy: 'you', summaryAt: now() }); else { delete it.summary; delete it.summaryKey; }
    }
    dropSummary(it);
    it.updated = now();
    await changed('update', it);
    if (staleSummary(it)) queueSummary(it.id, p.text !== undefined || p.title !== undefined ? summaryDelayMs : 0);
    return { ok: true, item: slim(it) };
  }

  async function remove(id) {
    await load();
    const it = byId(id);
    if (!it || it.deleted) throw Object.assign(new Error('not in the stash'), { statusCode: 404 });
    it.deleted = now();
    await changed('delete', it);
    return { ok: true, id };
  }

  async function restore(id) {
    await load();
    const it = byId(id);
    if (!it || !it.deleted) throw Object.assign(new Error('nothing to put back'), { statusCode: 404 });
    it.deleted = null;
    it.updated = now();
    await changed('restore', it);
    return { ok: true, item: slim(it) };
  }

  async function refresh(id) {
    await load();
    const it = byId(id);
    if (!it || it.deleted) throw Object.assign(new Error('not in the stash'), { statusCode: 404 });
    it.pending = runtime.connectorEnabled('stashEnrichment');
    await changed('update', it);
    queue(id);
    return { ok: true };
  }

  async function markSeen(at = now()) { await load(); await purge(); data.seenAt = Math.max(data.seenAt || 0, Number(at) || now()); await save(); return { ok: true, seenAt: data.seenAt }; }
  async function setSpaces(order) { await load(); await purge(); data.spaces = cleanSpaces(order); await save(); return { ok: true }; }
  async function freshCount() { await load(); return live().filter((it) => it.created > (data.seenAt || 0)).length; }
  async function settle() { while (working || jobs.length || summing || sumJobs.length || saving) await new Promise((r) => setTimeout(r, 25)); await purge(); if (dirty || vecDirty) await save(); }

  return { load, addText, addFile, list, get, similar, filePath, patch, remove, restore, refresh, markSeen, setSpaces, freshCount, settle };
}

module.exports = { createStash, parseQuery, colourName, readPage, normalHex, ID_RE, MAX_FILE };
