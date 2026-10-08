'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = __dirname;
const DEMO = process.env.MERIDIAN_DEMO === '1';
const demoRoot = DEMO ? fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-demo-')) : null;
// Keep checkout storage for now; a platform directory can be selected here later.
function defaultDataDir() { return path.join(ROOT, 'data'); }
const DATA_DIR = demoRoot ? path.join(demoRoot, 'data') : process.env.MERIDIAN_DATA ? path.resolve(process.env.MERIDIAN_DATA) : defaultDataDir();
const STORAGE_ROOT = demoRoot || (process.env.MERIDIAN_DATA ? path.dirname(DATA_DIR) : ROOT);
const CACHE_DIR = path.join(STORAGE_ROOT, 'cache');
const LOG_DIR = path.join(STORAGE_ROOT, 'logs');
const CONFIG_FILE = demoRoot ? path.join(demoRoot, 'config.json') : process.env.MERIDIAN_CONFIG ? path.resolve(process.env.MERIDIAN_CONFIG) : path.join(ROOT, 'config.json');
const SANDBOX = process.env.MERIDIAN_SANDBOX === '1';
const JOBS_ENABLED = !SANDBOX && process.env.MERIDIAN_JOBS !== 'off';
let profile = null;
function configure(value) { profile = value; }
function updateConnectors(connectors, place = profile?.place) { if (profile?.portable) { profile.connectors = connectors; profile.place = place; } }
function connectorEnabled(name) { return JOBS_ENABLED && (!profile?.portable || profile.connectors[name]?.enabled === true); }
function configuredPlace() { return profile?.portable ? profile.place || null : null; }
function portableProfile() { return Boolean(profile?.portable); }
function setup() { return profile?.portable ? { fresh: profile.fresh, demo: DEMO, connectors: profile.connectors } : null; }
if (demoRoot) {
  process.on('exit', () => fs.rmSync(demoRoot, { recursive: true, force: true }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

function jobsOffError() {
  return Object.assign(new Error('Meridian jobs are off'), { code: 'MERIDIAN_JOBS_OFF', status: 503 });
}

// Install before loading collectors. A missed gate must never reach another
// service, spawn an agent, or change a LaunchAgent in a second daemon.
let guarded = false;
function installGuards() {
  if (JOBS_ENABLED || guarded) return;
  guarded = true;
  const refuse = () => { throw jobsOffError(); };
  const cp = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = refuse;
  cp.ChildProcess.prototype.spawn = refuse;
  for (const mod of [require('node:http'), require('node:https')]) {
    mod.request = refuse;
    mod.get = refuse;
  }
  require('node:net').Socket.prototype.connect = refuse;
  require('node:tls').connect = refuse;
  globalThis.fetch = async () => { throw jobsOffError(); };
  require('node:module').syncBuiltinESMExports();
}

module.exports = { ROOT, DATA_DIR, STORAGE_ROOT, CACHE_DIR, LOG_DIR, CONFIG_FILE, SANDBOX, JOBS_ENABLED, DEMO, defaultDataDir, configure, updateConnectors, connectorEnabled, configuredPlace, portableProfile, setup, jobsOffError, installGuards };
