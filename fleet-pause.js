'use strict';
const { JOBS_ENABLED, jobsOffError } = require('./runtime');

// Pause for "Sites and services". Owner stopped using some of the local
// daemons Meridian probes; they showed as down forever. Pausing one stops
// the probe, keeps it out of every down count, and, when a launchd job runs
// it, stops that job too:
//   pause:  plist backed up to audit/<date>-paused/, launchctl disable (so a
//           reboot does not bring it back), launchctl bootout.
//   resume: launchctl enable, launchctl bootstrap the plist (restored from
//           the backup if the original has gone).
// A service with no launchd job (only a probe in config.json) and every
// live site pause by not probing. Meridian's own jobs are never paused.
//
// The job behind a service is found, in order, by: a `label` on its
// config.json fleet entry; the launchd job owning the PID that listens on
// its port; a job whose arguments or environment name that port; a job
// whose label or program path contains every significant word of its name
// ("Iris" -> ~/.iris/server.js). Anything ambiguous matches nothing.
// State: data/fleet-paused.json.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execute } = require('./process-runner');

const PROTECTED = /\.meridian($|[-.])/;
const STOPWORDS = new Set(['the', 'daemon', 'server', 'service', 'static', 'app', 'site', 'local', 'web', 'and', 'for', 'helios', 'mac']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const RESOLVE_MS = 5 * 60 * 1000;

function exec(bin, args, timeout = 10000) {
  if (!JOBS_ENABLED) return Promise.reject(jobsOffError());
  if ((bin === 'launchctl' && process.platform !== 'darwin') || !require('./first-run').executable(bin)) return Promise.resolve({ ok: false, code: 127, stdout: '', stderr: '' });
  return execute(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 })
    .then(r => ({ ok: true, code: 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }),
      e => ({ ok: false, code: e.code ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
}

function portOf(url) {
  try {
    const u = new URL(url);
    return { port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), local: LOCAL_HOSTS.has(u.hostname) };
  } catch { return { port: null, local: false }; }
}

function words(value) { return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

// `launchctl list` -> Map pid -> label.
function pidLabels(out) {
  const map = new Map();
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^(\d+)\t\S+\t(\S+)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

// Pure. target: { name, url, label? }; jobs: [{ label, plist, program, args, env }].
function matchJob(target, jobs, { pidLabel = null } = {}) {
  const usable = (jobs || []).filter((j) => j && j.label && !PROTECTED.test(j.label));
  if (target.label) { const j = usable.find((x) => x.label === target.label); return j ? { job: j, by: 'config' } : null; }
  if (pidLabel) { const j = usable.find((x) => x.label === pidLabel); if (j) return { job: j, by: 'pid' }; }
  const { port, local } = portOf(target.url);
  if (!local) return null;
  if (port) {
    const re = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`);
    const hits = usable.filter((j) => [...(j.args || []), ...Object.values(j.env || {})].some((v) => re.test(String(v))));
    if (hits.length === 1) return { job: hits[0], by: 'port' };
    if (hits.length > 1) return null;
  }
  const want = words(target.name).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (!want.length) return null;
  const hits = usable.filter((j) => {
    const have = new Set([...words(j.label), ...words(j.program), ...(j.args || []).flatMap(words)]);
    return want.every((w) => have.has(w));
  });
  return hits.length === 1 ? { job: hits[0], by: 'name' } : null;
}

function createFleetPause({ uid, agentsDir, auditRoot, file, selfPort, runner = exec, now = () => Date.now(), platform = process.platform }) {
  let chain = Promise.resolve();
  function serialise(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }
  const plistCache = new Map(); // path -> { mtimeMs, job }
  const resolved = new Map(); // name -> { at, match }

  async function readPaused() {
    try { const doc = JSON.parse(await fsp.readFile(file, 'utf8')); return doc && doc.items && typeof doc.items === 'object' ? doc.items : {}; } catch { return {}; }
  }
  async function writePaused(items) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ note: 'Fleet items Owner paused. Not probed, never counted as down. Resume with POST /api/fleet/resume {name}.', items }, null, 2) + '\n');
      await fsp.rename(tmp, file);
    } finally { await fsp.unlink(tmp).catch(() => {}); }
  }

  async function jobs() {
    if (platform !== 'darwin') return [];
    let names = [];
    try { names = (await fsp.readdir(agentsDir)).filter((n) => n.endsWith('.plist')); } catch { return []; }
    const out = [];
    for (const n of names) {
      const full = path.join(agentsDir, n);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      const hit = plistCache.get(full);
      if (hit && hit.mtimeMs === st.mtimeMs) { if (hit.job) out.push(hit.job); continue; }
      const r = await runner('plutil', ['-convert', 'json', '-o', '-', full], 5000);
      let job = null;
      if (r.ok) {
        try {
          const p = JSON.parse(r.stdout);
          const args = Array.isArray(p.ProgramArguments) ? p.ProgramArguments.map(String) : [];
          job = { label: String(p.Label || ''), plist: full, program: String(p.Program || args.find((a) => /\.(js|mjs|cjs|py|sh|rb)$/.test(a)) || args[0] || ''), args, env: p.EnvironmentVariables && typeof p.EnvironmentVariables === 'object' ? p.EnvironmentVariables : {}, cwd: p.WorkingDirectory || null };
          if (!job.label) job = null;
        } catch { job = null; }
      }
      plistCache.set(full, { mtimeMs: st.mtimeMs, job });
      if (job) out.push(job);
    }
    return out;
  }

  async function listenerPid(port) {
    if (platform !== 'darwin') return null;
    const r = await runner('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 4000);
    const pid = Number(String(r.stdout || '').trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  // Per fleet item: { kind, label, plist, pausable, paused, pauseMode, matchedBy }.
  async function annotate({ services = [], sites = [], launchctlList = '' }) {
    const paused = await readPaused();
    const pids = pidLabels(launchctlList);
    let list = null;
    const info = new Map();
    for (const [kind, items] of [['service', services], ['site', sites]]) {
      for (const t of items) {
        const { port, local } = portOf(t.url);
        const self = local && port === selfPort;
        const rec = paused[t.name];
        let match = null;
        if (kind === 'service' && local && !rec) {
          const cached = resolved.get(t.name);
          if (cached && now() - cached.at < RESOLVE_MS && cached.url === t.url) match = cached.match;
          else {
            list = list || await jobs();
            const pid = port ? await listenerPid(port) : null;
            match = matchJob(t, list, { pidLabel: pid ? pids.get(pid) || null : null });
            resolved.set(t.name, { at: now(), url: t.url, match });
          }
        }
        const label = rec ? rec.label || null : match ? match.job.label : null;
        const plist = rec ? rec.plist || null : match ? match.job.plist : null;
        const isSelf = self || Boolean(label && PROTECTED.test(label));
        info.set(t.name, {
          kind, label, plist,
          pausable: !isSelf,
          paused: Boolean(rec),
          pauseMode: label && plist ? 'launchd' : 'probe',
          matchedBy: rec ? (rec.mode === 'launchd' ? 'paused' : null) : match ? match.by : null,
        });
      }
    }
    return info;
  }

  const target = (uidLabel) => `gui/${uid}/${uidLabel}`;
  const notLoaded = (r) => r.code === 3 || r.code === 113 || /no such process|could not find|not loaded|not find specified service/i.test(r.stderr);

  async function backupPlist(label, plist) {
    const day = new Date(now()).toISOString().slice(0, 10);
    const dir = path.join(auditRoot, `${day}-paused`);
    await fsp.mkdir(dir, { recursive: true });
    const src = await fsp.readFile(plist);
    let dest = path.join(dir, `${label}.plist`);
    try {
      const existing = await fsp.readFile(dest);
      if (Buffer.compare(existing, src) === 0) return dest;
      dest = path.join(dir, `${label}.${new Date(now()).toISOString().replace(/[:.]/g, '-')}.plist`);
    } catch { /* first backup */ }
    await fsp.writeFile(dest, src);
    return dest;
  }

  // item: the fleet entry ({ name, url }) and its annotate() info.
  async function pauseNow(item, info) {
    if (!info || !info.pausable) throw Object.assign(new Error(`${item.name} cannot be paused`), { statusCode: 409 });
    const paused = await readPaused();
    if (paused[item.name]) return { ok: true, name: item.name, paused: true, already: true, ...paused[item.name] };
    const rec = { name: item.name, kind: info.kind, url: item.url, mode: 'probe', label: null, plist: null, backup: null, at: new Date(now()).toISOString() };
    if (info.label && info.plist) {
      if (PROTECTED.test(info.label)) throw Object.assign(new Error('that is Meridian itself'), { statusCode: 409 });
      const backup = await backupPlist(info.label, info.plist);
      Object.assign(rec, { mode: 'launchd', label: info.label, plist: info.plist, backup });
      paused[item.name] = rec;
      await writePaused(paused);
      const dis = await runner('launchctl', ['disable', target(info.label)]);
      const out = await runner('launchctl', ['bootout', target(info.label)], 20000);
      if (!out.ok && !notLoaded(out)) {
        if (dis.ok) await runner('launchctl', ['enable', target(info.label)]);
        delete paused[item.name];
        await writePaused(paused);
        throw new Error(`launchctl bootout failed: ${(out.stderr || out.stdout || 'no output').trim().slice(0, 300)}`);
      }
      Object.assign(rec, { mode: 'launchd', label: info.label, plist: info.plist, backup, disabled: dis.ok, wasLoaded: out.ok });
    }
    paused[item.name] = rec;
    await writePaused(paused);
    resolved.delete(item.name);
    return { ok: true, name: item.name, paused: true, ...rec };
  }

  async function resumeNow(name) {
    const paused = await readPaused();
    const rec = paused[name];
    if (!rec) throw Object.assign(new Error(`${name} is not paused`), { statusCode: 409 });
    let started = null;
    if (platform === 'darwin' && rec.mode === 'launchd' && rec.label && rec.plist) {
      if (!fs.existsSync(rec.plist)) {
        if (!rec.backup || !fs.existsSync(rec.backup)) throw new Error(`the plist for ${rec.label} has gone and there is no backup`);
        await fsp.copyFile(rec.backup, rec.plist);
      }
      await runner('launchctl', ['enable', target(rec.label)]);
      const r = await runner('launchctl', ['bootstrap', `gui/${uid}`, rec.plist], 20000);
      if (!r.ok) {
        const loaded = await runner('launchctl', ['print', target(rec.label)]);
        if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout || 'no output').trim().slice(0, 300)}`);
      }
      started = rec.label;
    }
    delete paused[name];
    await writePaused(paused);
    resolved.delete(name);
    return { ok: true, name, paused: false, started };
  }

  const pause = (item, info) => serialise(() => pauseNow(item, info));
  const resume = (name) => serialise(() => resumeNow(name));
  return { annotate, pause, resume, readPaused, jobs };
}

module.exports = { createFleetPause, matchJob, pidLabels, portOf, PROTECTED };
