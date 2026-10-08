'use strict';
const runtime = require('./runtime');
const jobsEnabled = () => runtime.connectorEnabled('tailscale');
const { jobsOffError } = runtime;

// Dev servers on this Mac, made reachable from Owner's other Mac and phone.
// Most of them listen on 127.0.0.1 only, so the tailnet cannot open them
// directly; Tailscale Serve proxies an HTTPS port on the ts.net name to the
// local port instead. Owner asks agents for these links rather than localhost.
//
// Owner already has hand-made and agent-made mappings (:443 is Meridian
// itself). Meridian only ever removes a mapping it created, recorded in
// data/local-shares.json, and only while that mapping still points at the
// same local port with nothing else on it. The exception is an explicit
// force (unshare with force:true, Oct 2026): it removes whatever proxies to
// the port, after the caller has backed up `serve status --json`.
//
// Also the ignore list for servers Owner keeps running but does not want in
// his lists. Ignored servers stay in state flagged `ignored`; the UI decides.

const fsp = require('fs/promises');
const path = require('path');
const { execute } = require('./process-runner');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function validPort(value) {
  const port = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer from 1 to 65535');
  return port;
}

// `tailscale serve status --json` -> one row per handler that proxies to a
// local port, plus every port Serve already holds.
function parseServeStatus(doc) {
  const mappings = [];
  const usedPorts = new Set();
  const src = doc && typeof doc === 'object' ? doc : {};
  for (const key of Object.keys(src.TCP || {})) if (/^\d+$/.test(key)) usedPorts.add(Number(key));
  for (const [hostPort, conf] of Object.entries(src.Web || {})) {
    const m = hostPort.match(/^(.+):(\d+)$/);
    if (!m) continue;
    const host = m[1];
    const httpsPort = Number(m[2]);
    usedPorts.add(httpsPort);
    const handlers = Object.entries((conf && conf.Handlers) || {});
    for (const [route, h] of handlers) {
      if (!h || typeof h.Proxy !== 'string') continue;
      let target;
      try { target = new URL(/^\w+:\/\//.test(h.Proxy) ? h.Proxy : `http://${h.Proxy}`); } catch { continue; }
      if (!LOOPBACK.has(target.hostname)) continue;
      const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
      mappings.push({
        httpsPort, path: route, host, proxy: h.Proxy, targetPort,
        handlers: handlers.length,
        url: `https://${host}${httpsPort === 443 ? '' : ':' + httpsPort}${route}`,
      });
    }
  }
  return { mappings, usedPorts };
}

// port + 10000 when that is free and still a port; otherwise the first free
// port above 10000.
function pickHttpsPort(port, used) {
  const preferred = port + 10000;
  if (preferred < 65536 && !used.has(preferred)) return preferred;
  for (let p = 10001; p < 65536; p++) if (!used.has(p)) return p;
  throw new Error('no free HTTPS port for Tailscale Serve');
}

// The mapping a server is reached through: a root handler beats a sub-path.
function shareFor(port, mappings) {
  const hits = mappings.filter((m) => m.targetPort === port);
  return hits.find((m) => m.path === '/') || hits[0] || null;
}

// The Mac app's binary only acts as a CLI from a terminal unless told to;
// under launchd it tries to start the GUI instead and prints nothing useful.
const CLI_ENV = { ...process.env, TAILSCALE_BE_CLI: '1' };

function exec(bin, args, timeout = 10000) {
  if (!jobsEnabled()) return Promise.reject(jobsOffError());
  return execute(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: CLI_ENV })
    .then(r => ({ ok: true, code: 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }),
      e => ({ ok: false, code: e.code ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
}

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fsp.rename(tmp, file);
}

function chain() {
  let tail = Promise.resolve();
  return (fn) => { const run = tail.then(fn, fn); tail = run.then(() => {}, () => {}); return run; };
}

function createShares({ bin, file, listeningPorts = async () => new Set(), now = () => Date.now(), cacheMs = 30 * 1000, runner = exec }) {
  let cache = { at: 0, value: null };
  const serialise = chain();

  async function status(force = false) {
    if (!force && cache.value && now() - cache.at < cacheMs) return cache.value;
    const r = await runner(bin, ['serve', 'status', '--json'], 6000);
    if (!r.ok) {
      if (cache.value) return cache.value; // keep the last good read
      throw new Error((r.stderr || 'tailscale serve status failed').trim().slice(0, 300));
    }
    let doc = {};
    try { doc = r.stdout.trim() ? JSON.parse(r.stdout) : {}; } catch { throw new Error('tailscale serve status returned unreadable JSON'); }
    cache = { at: now(), value: parseServeStatus(doc) };
    return cache.value;
  }

  const owned = async () => {
    const doc = await readJsonFile(file, { shares: {} });
    return doc && typeof doc.shares === 'object' && doc.shares ? doc.shares : {};
  };

  // Per-port share info for collectLocalServers.
  async function annotate(servers) {
    let s = null;
    try { s = await status(); } catch { s = null; }
    const mine = await owned().catch(() => ({}));
    for (const sv of servers) {
      const m = s ? shareFor(sv.port, s.mappings) : null;
      sv.shareUrl = m ? m.url : null;
      sv.shareHttpsPort = m ? m.httpsPort : null;
      sv.shareOwned = Boolean(m && mine[sv.port] && mine[sv.port].httpsPort === m.httpsPort);
      sv.reachable = sv.shareUrl || sv.tailUrl || null;
    }
    return servers;
  }

  function share(rawPort) {
    const port = validPort(rawPort);
    return serialise(async () => {
      const s = await status(true);
      const existing = shareFor(port, s.mappings);
      if (existing) {
        const mine = await owned();
        return { ok: true, port, url: existing.url, httpsPort: existing.httpsPort, existing: true, owned: Boolean(mine[port] && mine[port].httpsPort === existing.httpsPort) };
      }
      const used = new Set([...s.usedPorts, ...(await listeningPorts().catch(() => new Set()))]);
      const httpsPort = pickHttpsPort(port, used);
      const r = await runner(bin, ['serve', '--bg', '--yes', `--https=${httpsPort}`, `http://127.0.0.1:${port}`], 15000);
      if (!r.ok) throw new Error(`tailscale serve failed: ${(r.stderr || r.stdout || 'no output').trim().slice(0, 300)}`);
      const after = await status(true);
      const made = after.mappings.find((m) => m.httpsPort === httpsPort && m.targetPort === port);
      if (!made) throw new Error('tailscale serve ran but the mapping did not appear');
      const mine = await owned();
      mine[port] = { httpsPort, url: made.url, at: new Date(now()).toISOString() };
      await writeJsonFile(file, { note: 'Tailscale Serve mappings Meridian created. Meridian only removes these.', shares: mine });
      return { ok: true, port, url: made.url, httpsPort, existing: false, owned: true };
    });
  }

  // Force: remove every mapping that proxies to this port, whoever made it
  // (agents made most of them). `backup(doc)` gets the raw serve status
  // before each removal. A root handler sharing its HTTPS port with other
  // paths is left alone, since turning it off could take the others too.
  async function forceUnshare(port, backup) {
    const r = await runner(bin, ['serve', 'status', '--json'], 6000);
    if (!r.ok) throw new Error((r.stderr || 'tailscale serve status failed').trim().slice(0, 300));
    let doc = {};
    try { doc = r.stdout.trim() ? JSON.parse(r.stdout) : {}; } catch { throw new Error('tailscale serve status returned unreadable JSON'); }
    const hits = parseServeStatus(doc).mappings.filter((m) => m.targetPort === port);
    if (!hits.length) throw Object.assign(new Error(`:${port} is not shared`), { statusCode: 404 });
    const removed = []; const skipped = []; const backups = [];
    for (const m of hits) {
      if (m.path === '/' && m.handlers > 1) { skipped.push({ httpsPort: m.httpsPort, path: m.path, url: m.url, reason: 'shares its HTTPS port with other paths' }); continue; }
      const current = await runner(bin, ['serve', 'status', '--json'], 6000);
      let snapshot = doc;
      try { if (current.ok && current.stdout.trim()) snapshot = JSON.parse(current.stdout); } catch { /* keep the first read */ }
      if (backup) backups.push(await backup(snapshot, { port, httpsPort: m.httpsPort, path: m.path }));
      const args = m.path === '/'
        ? ['serve', '--yes', `--https=${m.httpsPort}`, 'off']
        : ['serve', '--yes', `--https=${m.httpsPort}`, `--set-path=${m.path}`, 'off'];
      const off = await runner(bin, args, 15000);
      if (!off.ok) throw new Error(`tailscale serve off failed: ${(off.stderr || off.stdout || 'no output').trim().slice(0, 300)}`);
      removed.push({ httpsPort: m.httpsPort, path: m.path, url: m.url });
    }
    const after = await status(true);
    const left = after.mappings.filter((m) => removed.some((x) => x.httpsPort === m.httpsPort && x.path === m.path && m.targetPort === port));
    if (left.length) throw new Error(`tailscale serve off ran but ${left.map((m) => m.url).join(', ')} is still there`);
    const mine = await owned();
    if (mine[port]) { delete mine[port]; await writeJsonFile(file, { note: 'Tailscale Serve mappings Meridian created. Meridian only removes these.', shares: mine }); }
    if (!removed.length) throw Object.assign(new Error(`:${port} is only shared on a port it shares with other paths, so it is left alone`), { statusCode: 409, skipped });
    return { ok: true, port, removed: true, forced: true, mappings: removed, skipped, backups };
  }

  function unshare(rawPort, { force = false, backup = null } = {}) {
    const port = validPort(rawPort);
    return serialise(async () => {
      const mine = await owned();
      const record = mine[port];
      if (force) return forceUnshare(port, backup);
      if (!record) {
        const s = await status().catch(() => null);
        const other = s && shareFor(port, s.mappings);
        const error = new Error(other ? `:${port} is shared at ${other.url}, but Meridian did not make that mapping, so it is left alone` : `:${port} is not shared`);
        error.statusCode = 409;
        throw error;
      }
      const forget = async () => { delete mine[port]; await writeJsonFile(file, { note: 'Tailscale Serve mappings Meridian created. Meridian only removes these.', shares: mine }); };
      const s = await status(true);
      const onPort = s.mappings.filter((m) => m.httpsPort === record.httpsPort);
      const webOnPort = [...s.usedPorts].includes(record.httpsPort);
      if (!onPort.length && !webOnPort) { await forget(); return { ok: true, port, removed: false, httpsPort: record.httpsPort, note: 'mapping was already gone' }; }
      // Only a mapping that is still exactly ours: one root handler to this port.
      if (onPort.length !== 1 || onPort[0].handlers !== 1 || onPort[0].path !== '/' || onPort[0].targetPort !== port) {
        await forget();
        const error = new Error(`:${record.httpsPort} has been changed since Meridian shared it, so it is left alone`);
        error.statusCode = 409;
        throw error;
      }
      const r = await runner(bin, ['serve', '--yes', `--https=${record.httpsPort}`, 'off'], 15000);
      if (!r.ok) throw new Error(`tailscale serve off failed: ${(r.stderr || r.stdout || 'no output').trim().slice(0, 300)}`);
      const after = await status(true);
      if (after.mappings.some((m) => m.httpsPort === record.httpsPort)) throw new Error('tailscale serve off ran but the mapping is still there');
      await forget();
      return { ok: true, port, removed: true, httpsPort: record.httpsPort };
    });
  }

  return { status, annotate, share, unshare, owned, invalidate: () => { cache.at = 0; } };
}

// ---- ignore list
// Ports change between runs, so a server with a known project is ignored by
// project + page title; one without a project falls back to its port. A
// request naming only a project (no port) hides every server in it.

function ignoreKey(entry) {
  return entry.match === 'port' ? `port:${entry.port}` : entry.match === 'project' ? `project:${entry.project}` : `title:${entry.project}\u0000${entry.title == null ? '' : entry.title}`;
}

function ignoreMatches(entry, sv) {
  if (entry.match === 'port') return sv.port === entry.port;
  if (sv.project !== entry.project) return false;
  return entry.match === 'project' || (sv.title || null) === (entry.title == null ? null : entry.title);
}

function createIgnoreList(file, { now = () => Date.now() } = {}) {
  const serialise = chain();

  async function read() {
    const doc = await readJsonFile(file, { items: [] });
    return Array.isArray(doc && doc.items) ? doc.items.filter((e) => e && ['port', 'project', 'title'].includes(e.match)) : [];
  }

  function annotate(servers, items) {
    for (const sv of servers) sv.ignored = items.some((e) => ignoreMatches(e, sv));
    return servers;
  }

  // body: { port?, project?, ignored? = true }. `servers` is the live list,
  // used to turn a port into project + title.
  function set(body, servers = []) {
    return serialise(async () => {
      const hasPort = body.port !== undefined && body.port !== null && body.port !== '';
      const port = hasPort ? validPort(body.port) : null;
      const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim().slice(0, 200) : null;
      if (port === null && !project) throw new Error('port or project required');
      const ignored = body.ignored === undefined ? true : body.ignored === true || body.ignored === 'true';
      const live = port !== null ? servers.find((sv) => sv.port === port) : null;
      const target = live || { port, project, title: undefined };
      if (target.project == null && project) target.project = project;
      let items = await read();
      if (ignored) {
        // Title is only known for a live server; otherwise the whole project.
        const entry = target.project
          ? (live ? { match: 'title', project: target.project, title: live.title == null ? null : live.title } : { match: 'project', project: target.project })
          : { match: 'port', port };
        entry.at = new Date(now()).toISOString();
        if (live) entry.label = live.title || live.project || `:${live.port}`;
        items = items.filter((e) => ignoreKey(e) !== ignoreKey(entry)).concat(entry);
        await writeJsonFile(file, { note: 'Dev servers hidden from Meridian lists. They keep running.', items });
        return { ok: true, ignored: true, entry, items };
      }
      // Un-hide everything that would hide this server, whichever way it was keyed.
      const before = items.length;
      items = items.filter((e) => {
        if (target.title !== undefined) return !ignoreMatches(e, { port: target.port, project: target.project, title: target.title });
        if (e.match === 'port') return e.port !== port;
        return !(target.project && e.project === target.project);
      });
      await writeJsonFile(file, { note: 'Dev servers hidden from Meridian lists. They keep running.', items });
      return { ok: true, ignored: false, removed: before - items.length, items };
    });
  }

  return { read, set, annotate };
}

module.exports = { CLI_ENV, createShares, createIgnoreList, parseServeStatus, pickHttpsPort, shareFor, validPort, ignoreMatches };
