#!/usr/bin/env node
'use strict';

// Check the install without starting jobs, reading credentials or running tools.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const executable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } };

function findTool(name, preferred, env) {
  const candidates = [...preferred, ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((p) => path.join(p, name))];
  return candidates.find(executable) || null;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish('busy'));
    socket.once('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'free' : 'unknown'));
    socket.setTimeout(750, () => finish('unknown'));
  });
}

async function diagnose({ root = ROOT, env = process.env, home = os.homedir(), nodeVersion = process.versions.node, platform = process.platform, probePort = portInUse } = {}) {
  const rows = [];
  const add = (status, check, detail) => rows.push({ status, check, detail });
  // Inspect the separately owned boot integration; never import its guards.
  let bootOverrides = false;
  try {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(root, 'runtime.js'), 'utf8');
    bootOverrides = /require\(['"]\.\/runtime['"]\)/.test(server) && ['MERIDIAN_CONFIG', 'MERIDIAN_DATA', 'MERIDIAN_JOBS', 'MERIDIAN_SANDBOX'].every((key) => runtime.includes(key));
  } catch {}
  const jobsOff = bootOverrides && (env.MERIDIAN_JOBS === 'off' || env.MERIDIAN_SANDBOX === '1');
  const major = Number(nodeVersion.split('.')[0]);
  add(major >= 22 ? 'OK' : 'FAIL', 'Node', major >= 22 ? `${nodeVersion}, Node 22 or newer is available.` : 'Use Node 22 or newer.');
  const configFile = env.MERIDIAN_CONFIG ? path.resolve(env.MERIDIAN_CONFIG) : path.join(root, 'config.json');
  let config;
  function read(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(parsed)) throw new Error('config must be an object');
    return parsed;
  }
  try { config = read(configFile); add('OK', 'Config', 'config.json is readable JSON. Values are kept private.'); }
  catch {
    try { config = read(configFile + '.bak'); add('WARN', 'Config', 'Using the backup. Repair the primary config before starting.'); }
    catch { add('FAIL', 'Config', 'No usable config or backup. Copy config.example.json to your private config.json.'); }
  }

  if (config) {
    const required = [
      ['board.dir', (c) => object(c.board) && typeof c.board.dir === 'string' && c.board.dir.length > 0],
      ['fleet', (c) => object(c.fleet)],
      ['git.roots', (c) => object(c.git) && Array.isArray(c.git.roots) && c.git.roots.every((p) => typeof p === 'string')],
      ['brain.graphPath', (c) => object(c.brain) && typeof c.brain.graphPath === 'string' && c.brain.graphPath.length > 0],
      ['threads.url', (c) => object(c.threads) && typeof c.threads.url === 'string'],
      ['threads.configPath', (c) => object(c.threads) && typeof c.threads.configPath === 'string'],
      ['vaultInbox', (c) => typeof c.vaultInbox === 'string' && c.vaultInbox.length > 0],
    ];
    const missing = required.filter(([, valid]) => !valid(config)).map(([key]) => key);
    add(missing.length ? 'FAIL' : 'OK', 'Legacy settings', missing.length ? `Missing or invalid: ${missing.join(', ')}. See docs/open-source/config.md.` : 'The nested settings the current server assumes are present.');
    for (const key of ['services', 'sites']) {
      const entries = config.fleet && config.fleet[key];
      if (entries !== undefined && (!Array.isArray(entries) || entries.some((e) => !object(e) || typeof e.name !== 'string' || typeof e.url !== 'string'))) add('FAIL', `fleet.${key}`, 'Use an array of objects with name and url strings.');
    }
    const cal = config.calendar;
    if (cal !== undefined && (!object(cal) || (cal.icsUrls !== undefined && (!Array.isArray(cal.icsUrls) || cal.icsUrls.some((e) => typeof e !== 'string' && (!object(e) || typeof e.url !== 'string')))) || (cal.selfEmails !== undefined && !Array.isArray(cal.selfEmails)))) add('FAIL', 'Calendar settings', 'Check calendar, icsUrls and selfEmails against the config reference.');
    const notify = config.notify;
    if (jobsOff) add('OK', 'Pushes', 'Disabled with jobs off. Review notification defaults before a normal boot.');
    else if (!object(notify) || !notify.topic) add('WARN', 'Pushes', 'The current boot code creates a topic and enables ntfy when topic is missing, even if enabled was false.');
    else add(notify.enabled === false ? 'OK' : 'WARN', 'Pushes', notify.enabled === false ? 'Pushes are disabled.' : 'Pushes may send titles to an external ntfy server. Review this before starting.');
    add('WARN', 'Personal defaults', 'University classes, calendar identity, prompts and local collectors still have personal defaults. This is release groundwork.');
  }

  const rawPort = env.MERIDIAN_PORT || (config && config.port) || 4980;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) add('FAIL', 'Port', 'Choose an integer from 1 to 65535.');
  else {
    const state = await probePort(port);
    add(state === 'free' ? 'OK' : 'WARN', 'Port', state === 'free' ? `Loopback port ${port} refused a connection, so no listener was found.` : state === 'busy' ? `Loopback port ${port} is already in use. It may be your existing Meridian.` : `Could not determine whether loopback port ${port} is available.`);
  }
  add(bootOverrides ? 'OK' : 'WARN', 'Boot overrides', bootOverrides ? 'The perf-server runtime integration is present. This checks its source, not its runtime isolation guarantees.' : 'MERIDIAN_PORT, MERIDIAN_DATA, MERIDIAN_CONFIG and MERIDIAN_JOBS=off require the perf-server changes. Check the merged server before relying on them.');
  if (jobsOff) add('OK', 'Review mode', 'Jobs-off/sandbox mode is loopback-only and refuses writes with HTTP 503; it is not an editable empty install.');
  const dataDir = bootOverrides && env.MERIDIAN_DATA ? path.resolve(env.MERIDIAN_DATA) : path.join(root, 'data');
  const artFile = path.join(dataDir, 'brief-art', 'collection.json');
  try {
    const art = JSON.parse(fs.readFileSync(artFile, 'utf8'));
    if (!object(art) || !Array.isArray(art.artworks)) throw new Error('invalid collection');
    add('OK', 'Brief artwork', 'The required legacy collection exists. Its image rights still need review.');
  } catch (e) {
    if (jobsOff && e.code === 'ENOENT') add('WARN', 'Brief artwork', 'No catalogue in the selected data directory. The merged jobs-off mode tolerates an absent catalogue; normal boot still requires it.');
    else add('FAIL', 'Brief artwork', 'The brief-art collection is absent or invalid. Normal boot imports it before it can start; an unmerged jobs-off flag does not fix this. Do not copy private data to fix it.');
  }
  try { fs.accessSync(root, fs.constants.W_OK); add('OK', 'Storage', 'The checkout is writable. Legacy modules still write under data/, cache/ and ledger/.'); }
  catch { add('FAIL', 'Storage', 'The checkout is not writable. Check ownership and the storage plan.'); }

  const claude = path.join(home, '.local', 'bin', 'claude');
  const tools = [
    ['Tailscale', 'tailscale', ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'], 'Private remote access and local sharing need Tailscale.'],
    ['Claude CLI', 'claude', [claude], 'Tell, ranking and note summaries need Claude CLI and a login.'],
    ['Codex CLI', 'codex', [path.join(home, '.local', 'bin', 'codex'), path.join(home, '.npm-global', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'], 'Codex delegation and model discovery need the CLI and a login.'],
    ['GitHub CLI', 'gh', ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'], 'GitHub status needs gh and a login.'],
    ['Git', 'git', [], 'Repository status needs git.'],
    ['Chrome', 'chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], 'Link screenshot previews need desktop Chrome at the configured legacy path.'],
    ['Swift compiler', 'swiftc', ['/usr/bin/swiftc'], 'Stash image OCR and visual similarity need macOS, Swift and the Apple Vision SDK.'],
  ];
  for (const [label, name, preferred, unavailable] of tools) {
    const found = findTool(name, preferred, env);
    let detail = found ? 'Executable found; it was not run. Login, service and SDK readiness are not verified.' : unavailable;
    let status = found ? 'OK' : 'WARN';
    if (found && preferred.length && !preferred.includes(found) && ['Tailscale', 'Claude CLI', 'Codex CLI', 'Chrome'].includes(label)) {
      status = 'WARN'; detail = 'Found on PATH, but the current server uses fixed candidate paths. Connector configuration is still needed.';
    }
    if (label === 'Swift compiler' && platform !== 'darwin') { status = 'WARN'; detail = unavailable; }
    add(status, label, detail);
  }
  if (platform !== 'darwin') add('WARN', 'Operating system', 'Core JSON stores and browser pages can be portable; launchd, Keychain, Quick Look and Apple Vision need macOS. Linux support is not verified.');
  add('OK', 'Core', 'To-dos, shelf, journal, drafts and text/file Stash do not require an AI login. Startup blockers above must be resolved first.');
  return { rows, exitCode: rows.some((r) => r.status === 'FAIL') ? 1 : 0 };
}

if (require.main === module) {
  diagnose().then(({ rows, exitCode }) => {
    console.log('Meridian doctor: read-only checks, no credentials or external requests.');
    for (const row of rows) console.log(`${row.status.padEnd(4)} ${row.check}: ${row.detail}`);
    console.log(exitCode ? 'Startup is blocked. Fix the FAIL rows; WARN rows describe optional or unfinished support.' : 'No checked startup blockers. Review WARN rows before enabling integrations.');
    process.exitCode = exitCode;
  }).catch(() => { console.error('Doctor could not finish its checks. No config values were printed.'); process.exitCode = 1; });
}

module.exports = { diagnose, portInUse };
