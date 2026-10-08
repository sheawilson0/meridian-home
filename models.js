'use strict';
const runtime = require('./runtime');
const { JOBS_ENABLED } = runtime;

// The models Meridian can hand work to. One list, in data/models.json, so a
// new model is a data change rather than an edit in three files (server.js,
// the brief and the command centre each kept their own copy until Oct 2026).
// Both front ends read it through GET /api/engines.
//
// Newer models arrive in two places before anyone tells Meridian: the Codex
// CLI's model catalog, and the model ids in Owner's own Claude and Codex
// session logs. discover() lists any id from either that is not on the list
// yet; adopt() adds one, optionally retiring the model it replaces so old
// saved picks, presets and the default move up with it. Nothing is adopted
// automatically: an id only runs once it is on the list.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'X-high'], ['max', 'Max']];
const KIND_FOR = { OpenAI: 'codex', Anthropic: 'claude' };
const effortLabel = (effort) => (EFFORT_LABELS.find(([e]) => e === effort) || [effort, effort])[1];

// Seeds data/models.json on first run and fills any field a hand edit drops.
const DEFAULTS = {
  version: 1,
  models: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', maker: 'OpenAI', kind: 'codex', efforts: EFFORTS, rank: 1 },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', maker: 'OpenAI', kind: 'codex', efforts: EFFORTS, rank: 2 },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', maker: 'OpenAI', kind: 'codex', efforts: EFFORTS, rank: 3 },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', maker: 'Anthropic', kind: 'claude', efforts: EFFORTS, rank: 1 },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', maker: 'Anthropic', kind: 'claude', efforts: EFFORTS, rank: 2 },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', maker: 'Anthropic', kind: 'claude', efforts: EFFORTS, rank: 3 },
  ],
  // Retired id -> the id that replaced it. Followed on every resolve, so a
  // pick saved as gpt-6-sol keeps running, as GPT-6.1 Sol.
  retired: { 'gpt-6-sol': 'gpt-6.1-sol' },
  presets: [
    { label: 'Luna High', hint: 'Small fixes', model: 'gpt-6-luna', effort: 'high' },
    { label: 'Sol Medium', hint: 'Bigger changes', model: 'gpt-6.1-sol', effort: 'medium' },
  ],
  // Luna for quick work, per the routing guidance in ~/CONTEXT.md.
  default: { model: 'gpt-6-luna', effort: 'high' },
};

// Picker labels older clients and saved runs still send. Fixed history, so
// it stays in code; the targets go through `retired` like any other id.
const LEGACY_LABELS = {
  'GPT-5.6 Sol light': ['gpt-6-sol', 'low'],
  'GPT-5.6 Luna max': ['gpt-6-luna', 'max'],
  'GPT-6 Sol Light': ['gpt-6-sol', 'low'],
  'GPT-6 Luna High': ['gpt-6-luna', 'high'],
  'GPT-6 Sol': ['gpt-6-sol', 'medium'],
  'GPT-6 Luna': ['gpt-6-luna', 'medium'],
  'Astro': ['gpt-6-astra', 'high'],
  'Fable': ['claude-fable-5-1', 'high'],
  'GPT-Opus 5.5': ['claude-opus-5-5', 'high'],
};

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/i;
// The ledger records 'claude' and 'gpt-5.6' when a log has no model line;
// those are parse fallbacks, not models, so log ids must look like real ones.
const LOG_ID_RE = /^(claude-[a-z]+-\d[\w.-]*|gpt-\d+(\.\d+)?-[a-z][\w.-]*|o\d[\w.-]*)$/i;

function clean(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }

function normalise(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const models = (Array.isArray(src.models) ? src.models : DEFAULTS.models).map((m) => {
    const maker = KIND_FOR[m && m.maker] ? m.maker : (m && m.kind === 'claude' ? 'Anthropic' : 'OpenAI');
    const efforts = EFFORTS.filter((e) => (Array.isArray(m && m.efforts) ? m.efforts : EFFORTS).includes(e));
    return { id: clean(m && m.id, 80), name: clean(m && m.name, 40) || clean(m && m.id, 40), maker, kind: KIND_FOR[maker], efforts: efforts.length ? efforts : EFFORTS.slice(), rank: Number.isFinite(Number(m && m.rank)) ? Number(m.rank) : 99 };
  }).filter((m) => ID_RE.test(m.id));
  const known = new Set(models.map((m) => m.id));
  const retired = {};
  for (const [from, to] of Object.entries(src.retired && typeof src.retired === 'object' ? src.retired : DEFAULTS.retired)) {
    if (ID_RE.test(from) && ID_RE.test(String(to)) && !known.has(from)) retired[from] = String(to);
  }
  const presets = (Array.isArray(src.presets) ? src.presets : DEFAULTS.presets)
    .map((p) => ({ label: clean(p && p.label, 40), hint: clean(p && p.hint, 60), model: clean(p && p.model, 80), effort: EFFORTS.includes(p && p.effort) ? p.effort : 'high' }))
    .filter((p) => p.label && p.model);
  const def = src.default && typeof src.default === 'object' ? src.default : DEFAULTS.default;
  return {
    version: 1,
    models,
    retired,
    presets,
    default: { model: clean(def.model, 80) || DEFAULTS.default.model, effort: EFFORTS.includes(def.effort) ? def.effort : 'high' },
    updatedAt: src.updatedAt || null,
  };
}

// Display order: makers in the order they first appear, then rank.
function sorted(models) {
  const makers = [...new Set(models.map((m) => m.maker))];
  return models.slice().sort((a, b) => makers.indexOf(a.maker) - makers.indexOf(b.maker) || a.rank - b.rank);
}

// "GPT-6.1-Sol" -> "GPT-6.1 Sol"; "claude-sonnet-5-5" -> "Sonnet 5.5".
function suggestName(id, displayName) {
  if (displayName) return clean(displayName.replace(/(\d)-(?=[A-Za-z])/g, '$1 '), 40);
  const c = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (c) return `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}${c[3] ? '.' + c[3] : ''}`;
  const g = String(id).match(/^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/i);
  if (g) return `GPT-${g[1]} ${g[2][0].toUpperCase()}${g[2].slice(1)}`;
  return clean(id, 40);
}

// Family and version, for "is this newer than what we list?".
function family(id) {
  const c = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (c) return { maker: 'Anthropic', family: c[1].toLowerCase(), version: Number(`${c[2]}.${c[3] || 0}`) };
  const g = String(id).match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?/i);
  if (g) return { maker: 'OpenAI', family: (g[2] || '').toLowerCase(), version: Number(g[1]) };
  return { maker: /^claude/i.test(id) ? 'Anthropic' : 'OpenAI', family: '', version: NaN };
}

function createRegistry(options = {}) {
  const home = options.home || os.homedir();
  const file = options.file;
  const codexBin = options.codexBin || null;
  const codexCache = options.codexCache || path.join(home, '.codex', 'models_cache.json');
  const scanCache = options.scanCache || null; // the AI usage ledger's per-file parse cache
  const logRoots = options.logRoots || [
    [path.join(home, '.claude', 'projects'), 'claude'],
    [path.join(home, '.codex', 'sessions'), 'codex'],
  ];
  const now = options.now || (() => Date.now());
  const DISCOVER_MS = options.discoverMs || 30 * 60 * 1000;
  const WINDOW_DAYS = 14;

  let data = null;
  let loadedMtime = -1;
  let writeChain = Promise.resolve();
  let discovery = { at: 0, value: null, inflight: null };

  // Synchronous on purpose: resolve() is called from request handlers and
  // must see a hand edit of models.json without a restart.
  function current() {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    if (data && mtime === loadedMtime) return data;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT' && data) return data; // half-written by hand: keep the last good list
    }
    data = normalise(raw || DEFAULTS);
    loadedMtime = mtime;
    if (!raw && JOBS_ENABLED) { try { writeSync(data); } catch { /* read-only checkout: run from defaults */ } }
    return data;
  }

  function writeSync(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
    loadedMtime = fs.statSync(file).mtimeMs;
  }

  // Follows retirements (gpt-6-sol -> gpt-6.1-sol -> ...) to the live id.
  function follow(d, id) {
    let at = id;
    for (let hops = 0; hops < 8 && d.retired[at]; hops++) at = d.retired[at];
    return at;
  }

  // A request to a concrete engine. Empty means the default; a run label such
  // as "GPT-6 Luna · High" resolves by name; anything else must be on the list,
  // so an id Meridian has only discovered never reaches a CLI.
  function resolve(modelKey, effort) {
    const d = current();
    const key = clean(modelKey, 120);
    let [id, fallbackEffort] = LEGACY_LABELS[key] || [key, null];
    if (!id) [id, fallbackEffort] = [d.default.model, d.default.effort];
    let model = d.models.find((m) => m.id === follow(d, id));
    if (!model && key.includes('·')) {
      const [name, label] = key.split('·').map((s) => s.trim());
      model = d.models.find((m) => m.name === name) || (LEGACY_LABELS[name] && d.models.find((m) => m.id === follow(d, LEGACY_LABELS[name][0])));
      const hit = EFFORT_LABELS.find(([, l]) => l.toLowerCase() === String(label || '').toLowerCase());
      if (model && hit) fallbackEffort = hit[0];
    }
    // A default edited out of the list by hand still has to run something.
    if (!model && !key && d.models.length) [model, fallbackEffort] = [sorted(d.models)[0], d.default.effort];
    if (!model) throw new Error(`${key} is not on Meridian's model list`);
    const chosen = effort || fallbackEffort || 'high';
    if (!model.efforts.includes(chosen)) throw new Error(`${model.name} cannot run at ${chosen} reasoning`);
    return { kind: model.kind, model: model.id, name: model.name, efforts: model.efforts, id: model.id, effort: chosen, who: `${model.name} · ${effortLabel(chosen)}` };
  }

  // ---- discovery

  function runCodexCatalog() {
    return new Promise((resolve) => {
      if (!runtime.connectorEnabled('delegations') || !codexBin) { resolve(null); return; }
      execFile(codexBin, ['debug', 'models'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
  }

  async function codexCatalog() {
    let doc = await runCodexCatalog();
    let source = 'codex debug models';
    if (!doc) {
      try { doc = JSON.parse(await fsp.readFile(codexCache, 'utf8')); source = codexCache.replace(home, '~'); } catch { return { source: null, models: [] }; }
    }
    const list = Array.isArray(doc && doc.models) ? doc.models : [];
    return {
      source,
      models: list.filter((m) => m && typeof m.slug === 'string').map((m) => ({
        id: m.slug,
        displayName: typeof m.display_name === 'string' ? m.display_name : null,
        description: typeof m.description === 'string' ? m.description : null,
        visible: m.visibility !== 'hide',
        priority: Number.isFinite(m.priority) ? m.priority : null,
        efforts: Array.isArray(m.supported_reasoning_levels) ? EFFORTS.filter((e) => m.supported_reasoning_levels.some((r) => (r && r.effort) === e || r === e)) : null,
        upgradeTo: m.upgrade && typeof m.upgrade.model === 'string' ? m.upgrade.model : null,
      })),
    };
  }

  async function listJsonl(root, since) {
    const out = [];
    async function walk(dir) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      await Promise.all(entries.map(async (e) => {
        if (e.name.startsWith('.')) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        if (!e.isFile() || !e.name.endsWith('.jsonl')) return;
        try { const st = await fsp.stat(full); if (st.mtimeMs >= since) out.push([full, st]); } catch { /* gone */ }
      }));
    }
    await walk(root);
    return out;
  }

  // Head and tail only: a live session log can be tens of MB, and every
  // assistant line (Claude) or turn (Codex) repeats the model id.
  async function sniffModels(file, size, provider) {
    const found = new Set();
    let fh;
    try {
      fh = await fsp.open(file, 'r');
      const spans = size <= 768 * 1024 ? [[0, size]] : [[0, 256 * 1024], [size - 512 * 1024, 512 * 1024]];
      for (const [start, len] of spans) {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
        for (const line of lines) {
          const marker = provider === 'claude' ? '"type":"assistant"' : '"turn_context"';
          if (!line.includes(marker)) continue;
          let j; try { j = JSON.parse(line); } catch { continue; } // partial line at a span edge
          const id = provider === 'claude' ? j && j.message && j.message.model : j && j.payload && j.payload.model;
          if (typeof id === 'string') found.add(id);
        }
      }
    } catch { /* unreadable: skip */ } finally { if (fh) await fh.close().catch(() => {}); }
    return [...found];
  }

  async function logSightings() {
    const since = now() - WINDOW_DAYS * 86400e3;
    const sinceDay = new Date(since).toISOString().slice(0, 10);
    let cache = {};
    if (scanCache) { try { cache = (JSON.parse(await fsp.readFile(scanCache, 'utf8')).files) || {}; } catch { cache = {}; } }
    const seen = new Map(); // id -> { provider, files:Set, lastSeen }
    const note = (id, provider, file, day) => {
      if (!LOG_ID_RE.test(id)) return;
      const s = seen.get(id) || { provider, files: new Set(), lastSeen: '' };
      s.files.add(file); if (day > s.lastSeen) s.lastSeen = day;
      seen.set(id, s);
    };
    for (const [root, provider] of logRoots) {
      const files = await listJsonl(root, since);
      await Promise.all(files.map(async ([file, st]) => {
        const c = cache[file];
        if (c && c.size === st.size && c.mtime === st.mtimeMs && c.days) {
          for (const [day, rows] of Object.entries(c.days)) {
            if (day < sinceDay || !Array.isArray(rows)) continue;
            for (const r of rows) if (Array.isArray(r) && typeof r[0] === 'string') note(r[0], provider, file, day);
          }
          return;
        }
        const day = new Date(st.mtimeMs).toISOString().slice(0, 10);
        for (const id of await sniffModels(file, st.size, provider)) note(id, provider, file, day);
      }));
    }
    return seen;
  }

  async function discoverNow() {
    const t0 = now();
    const d = current();
    const listed = new Set(d.models.map((m) => m.id));
    const known = new Set([...listed, ...Object.keys(d.retired)]);
    const [catalog, sightings] = await Promise.all([codexCatalog(), logSightings()]);
    const byId = new Map();
    const entry = (id, maker) => {
      if (!byId.has(id)) byId.set(id, { id, name: null, maker, kind: KIND_FOR[maker], efforts: EFFORTS.slice(), description: null, older: false, replaces: null, seen: [] });
      return byId.get(id);
    };
    for (const m of catalog.models) {
      if (!m.visible || known.has(m.id)) continue;
      const e = entry(m.id, 'OpenAI');
      e.name = suggestName(m.id, m.displayName);
      e.description = m.description;
      if (m.efforts && m.efforts.length) e.efforts = m.efforts;
      e.seen.push({ source: 'codex-catalog', where: `Codex model catalog (${catalog.source})`, priority: m.priority });
      if (m.upgradeTo) e.older = true;
    }
    for (const [id, s] of sightings) {
      if (known.has(id) || id.startsWith('<')) continue;
      const maker = s.provider === 'claude' ? 'Anthropic' : 'OpenAI';
      const e = entry(id, maker);
      if (!e.name) e.name = suggestName(id);
      const where = s.provider === 'claude' ? 'Claude Code sessions' : 'Codex sessions';
      e.seen.push({ source: s.provider === 'claude' ? 'claude-logs' : 'codex-logs', where: `${s.files.size} ${where} in the last ${WINDOW_DAYS} days`, sessions: s.files.size, lastSeen: s.lastSeen });
    }
    // Older than what is listed (same family at a higher version, or below
    // every listed version from that maker) is shown but flagged, so the UI
    // can lead with what is actually new.
    for (const e of byId.values()) {
      const f = family(e.id);
      const peers = d.models.filter((m) => m.maker === e.maker).map((m) => ({ id: m.id, ...family(m.id) })).filter((p) => Number.isFinite(p.version));
      if (Number.isFinite(f.version) && peers.length) {
        const same = peers.filter((p) => p.family === f.family);
        if (same.some((p) => p.version > f.version) || f.version < Math.min(...peers.map((p) => p.version))) e.older = true;
        const below = same.filter((p) => p.version < f.version).sort((a, b) => b.version - a.version)[0];
        if (!e.older && below) e.replaces = below.id;
      }
      const upgrader = catalog.models.find((m) => m.upgradeTo === e.id && listed.has(m.id));
      if (!e.older && !e.replaces && upgrader) e.replaces = upgrader.id;
    }
    const lastSeen = (e) => e.seen.reduce((best, s) => (s.lastSeen && s.lastSeen > best ? s.lastSeen : best), '');
    const discovered = [...byId.values()].sort((a, b) => Number(a.older) - Number(b.older) || lastSeen(b).localeCompare(lastSeen(a)) || a.id.localeCompare(b.id));
    return { at: new Date(now()).toISOString(), ms: now() - t0, catalog: catalog.source, discovered };
  }

  async function discover({ force = false } = {}) {
    if (!runtime.connectorEnabled('aiUsage')) return { at: null, ms: 0, catalog: null, discovered: [] };
    if (!force && discovery.value && now() - discovery.at < DISCOVER_MS) return discovery.value;
    if (discovery.inflight) return discovery.inflight;
    discovery.inflight = discoverNow().then((value) => {
      discovery = { at: now(), value, inflight: null };
      return value;
    }, (error) => { discovery.inflight = null; throw error; });
    return discovery.inflight;
  }

  // GET /api/engines. The shape is what both front ends code against.
  async function engines(options = {}) {
    const d = current();
    let found = { discovered: [] };
    try { found = await discover(options); } catch { /* the list still works without discovery */ }
    return {
      models: sorted(d.models),
      presets: d.presets,
      default: { ...d.default, model: follow(d, d.default.model) },
      efforts: EFFORT_LABELS,
      discovered: found.discovered,
      retired: d.retired,
      discoveredAt: found.at || null,
    };
  }

  function serialise(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  // POST /api/engines/adopt. With `replaces`, the new model takes the old
  // one's place in the list, and every preset, the default and any saved pick
  // pointing at the old id now runs the new one.
  function adopt(input = {}) {
    return serialise(async () => {
      const d = normalise(JSON.parse(JSON.stringify(current())));
      const id = clean(input.id, 80);
      if (!ID_RE.test(id)) throw new Error('model id required');
      if (d.models.some((m) => m.id === id)) throw new Error(`${id} is already on the list`);
      const maker = clean(input.maker, 20);
      if (!KIND_FOR[maker]) throw new Error('maker must be OpenAI or Anthropic');
      const name = clean(input.name, 40) || suggestName(id);
      const hint = discovery.value && discovery.value.discovered.find((m) => m.id === id);
      const requested = Array.isArray(input.efforts) ? EFFORTS.filter((e) => input.efforts.includes(e)) : null;
      const efforts = requested && requested.length ? requested : (hint && hint.efforts && hint.efforts.length ? hint.efforts : EFFORTS.slice());
      const replaces = input.replaces ? clean(input.replaces, 80) : null;
      const model = { id, name, maker, kind: KIND_FOR[maker], efforts, rank: 0 };
      delete d.retired[id]; // adopting a retired id brings it back
      if (replaces) {
        const old = d.models.find((m) => m.id === replaces);
        if (!old) throw new Error(`${replaces} is not on the list`);
        model.rank = old.rank;
        d.models = d.models.filter((m) => m.id !== replaces);
        for (const [from, to] of Object.entries(d.retired)) if (to === replaces) d.retired[from] = id;
        d.retired[replaces] = id;
        for (const p of d.presets) if (p.model === replaces) { p.model = id; if (!efforts.includes(p.effort)) p.effort = efforts.includes('high') ? 'high' : efforts[0]; }
        if (d.default.model === replaces) { d.default.model = id; if (!efforts.includes(d.default.effort)) d.default.effort = efforts.includes('high') ? 'high' : efforts[0]; }
      } else {
        model.rank = Math.max(0, ...d.models.filter((m) => m.maker === maker).map((m) => m.rank)) + 1;
      }
      d.models.push(model);
      d.updatedAt = new Date(now()).toISOString();
      const next = normalise(d);
      writeSync(next);
      data = next;
      if (discovery.value) discovery.value = { ...discovery.value, discovered: discovery.value.discovered.filter((m) => m.id !== id) };
      return { model, retired: replaces ? { [replaces]: id } : null };
    });
  }

  return { current, resolve, engines, discover, adopt, follow: (id) => follow(current(), id) };
}

module.exports = { createRegistry, normalise, suggestName, family, EFFORTS, EFFORT_LABELS, LEGACY_LABELS, DEFAULTS };
