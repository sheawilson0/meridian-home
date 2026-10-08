'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runtime = require('./runtime');
const { validatePlace } = require('./place');

function executable(name) {
  if (!name) return false;
  const candidates = name.includes('/') ? [name] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name));
  return candidates.some(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}
const exists = file => Boolean(file && fs.existsSync(file));

// No command or account lookup runs while deciding what a profile can use.
function connectorStatus(config) {
  const home = os.homedir(), mac = process.platform === 'darwin';
  const claude = executable(path.join(home, '.local/bin/claude'));
  const codex = [path.join(home, '.local/bin/codex'), path.join(home, '.npm-global/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'].some(executable);
  const requirements = {
    board: exists(config.board?.dir), preferences: (config.preferences?.sources || []).some(s => exists(s.path)),
    ai: exists(path.join(home, '.claude/projects')) || exists(path.join(home, '.codex/sessions')),
    fleet: Boolean(config.fleet?.services?.length || config.fleet?.sites?.length),
    git: Boolean(config.git?.roots?.some(exists)) && executable('git'), brain: exists(config.brain?.graphPath),
    threads: Boolean(config.threads?.url), calendar: Boolean(config.calendar?.icsUrl || config.calendar?.icsUrls?.length || savedFeeds()),
    ledger: exists(config.ledger?.dir), meetings: exists(config.meetings?.dir), drift: exists(path.join(home, 'LifeOS/AGENTS.md')),
    intake: exists(path.join(runtime.DATA_DIR, 'brief-intake.json')), delegations: claude || codex,
    exampleappFeedback: exists(config.exampleappFeedback?.stateFile) && exists(config.exampleappFeedback?.cli),
    campaignSnapshot: Boolean(config.campaignSnapshot?.dashboardUrl), heartHealth: exists(config.heartHealth?.cli),
    tailscale: executable(mac ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale'),
    localServers: executable('lsof'), system: executable('df'), github: Boolean(config.github?.account) && (executable('gh') || executable('/opt/homebrew/bin/gh') || executable('/usr/local/bin/gh')),
    linkMetadata: true, previews: mac && executable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    artwork: exists(path.join(runtime.DATA_DIR, 'brief-art/collection.json')), almanac: true,
    aiUsage: exists(path.join(home, '.claude/projects')) || exists(path.join(home, '.codex/sessions')),
    money: exists(path.join(runtime.DATA_DIR, 'money/credentials.json')), tell: claude, todoRank: claude,
    voice: Boolean(process.env.OPENAI_API_KEY) || mac && executable('/usr/bin/security') && Boolean(config.voice?.keychainService),
    stashEnrichment: true, stashSummary: config.stash?.summary?.engine === 'command' ? executable(config.stash.summary.command?.[0] || '') : config.stash?.summary?.engine === 'claude' && claude,
    notify: Boolean(config.notify?.topic), nudges: config.nudges?.enabled === true,
    journalExport: exists(config.journal?.vaultDir),
  };
  return Object.fromEntries(Object.entries(requirements).map(([name, configured]) => {
    const requested = config.connectors?.[name]?.enabled === true && (name !== 'notify' || config.notify?.enabled === true);
    return [name, { enabled: !runtime.DEMO && runtime.JOBS_ENABLED && requested && Boolean(configured), configured: Boolean(configured),
      reason: runtime.DEMO ? 'demo' : !runtime.JOBS_ENABLED ? 'jobs off' : !requested ? 'disabled' : !configured ? 'missing configuration or tool' : null }];
  }));
}

function savedFeeds() {
  try { return JSON.parse(fs.readFileSync(path.join(runtime.DATA_DIR, 'calendars.json'), 'utf8')).feeds?.length > 0; }
  catch { return false; }
}

function validate(config) {
  validatePlace(config.place);
  for (const key of ['board', 'fleet', 'git', 'brain', 'threads', 'calendar', 'journal', 'notify', 'stash', 'connectors']) {
    if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) throw new Error(`Config ${key} must be an object`);
  }
  for (const [key, value] of [['fleet.services', config.fleet.services], ['fleet.sites', config.fleet.sites], ['git.roots', config.git.roots], ['calendar.icsUrls', config.calendar.icsUrls]]) {
    if (!Array.isArray(value)) throw new Error(`Config ${key} must be an array`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Config port must be between 1 and 65535');
  for (const [name, value] of Object.entries(config.connectors)) {
    if (!value || typeof value.enabled !== 'boolean') throw new Error(`Config connectors.${name}.enabled must be a boolean`);
  }
}

function safeConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
  // Empty source paths never point at another profile's checkout data.
  config.board = { dir: '' }; config.brain = { graphPath: '' }; config.threads = { url: '', configPath: '' };
  config.vaultInbox = path.join(runtime.DATA_DIR, 'inbox');
  config.ledger = { dir: '', schedule: '' }; config.exampleappFeedback = { stateFile: '', cli: '', node: '' };
  config.journal.vaultDir = path.join(runtime.DATA_DIR, 'journal/daybook');
  config.notify.topic = '';
  config.profile = { version: 1, kind: runtime.DEMO ? 'demo' : 'empty' };
  config.connectors = {};
  for (const name of Object.keys(connectorStatus(config))) config.connectors[name] = { enabled: false };
  return config;
}

function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

function save(file, config) {
  validate(config);
  const text = JSON.stringify(config, null, 2) + '\n';
  atomic(file + '.bak', text); atomic(file, text);
}

function load(file, { log = console } = {}) {
  const fresh = !fs.existsSync(file);
  let config;
  // A backup belongs to an existing install even when its primary was lost.
  if (fresh && !fs.existsSync(file + '.bak')) config = safeConfig();
  else {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      log.error('CONFIG READ FAILED, trying backup:', error.message);
      config = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      log.error('CONFIG RECOVERED from', file + '.bak');
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be a JSON object');
  const portable = config.profile?.version === 1 && ['empty', 'demo'].includes(config.profile.kind);
  if (portable) validate(config);
  if (process.env.MERIDIAN_PORT !== undefined) {
    const port = Number(process.env.MERIDIAN_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MERIDIAN_PORT must be between 1 and 65535');
  }
  if (fresh && portable && runtime.JOBS_ENABLED) {
    fs.mkdirSync(runtime.DATA_DIR, { recursive: true, mode: 0o700 });
    save(file, config);
  }
  runtime.configure({ portable, fresh, place: portable ? validatePlace(config.place) : null, connectors: portable ? connectorStatus(config) : {} });
  return config;
}

// Seed the existing fictional world into the same stores used by the core.
function seedDemo() {
  if (!runtime.DEMO || !runtime.JOBS_ENABLED) return;
  const demo = require('./demo'), now = Date.now(), world = demo.world;
  const put = (name, value) => atomic(path.join(runtime.DATA_DIR, name), JSON.stringify(value) + '\n');
  put('todos.json', { version: 1, todos: world.todos(now) });
  put('links.json', { version: 1, ...world.links(now) });
  put('deadlines.json', { version: 1, items: world.deadlines(now) });
  put('projects.json', world.intake(now).projects);
  put('brief-intake.json', world.intake(now).briefIntake);
  put('journal.json', { version: 1, ...world.journal(now) });
  put('stash/items.json', { version: 1, seenAt: now, spaces: [], items: world.stashItems(now).filter(it => ['note', 'quote', 'link', 'colour'].includes(it.kind)) });
  put('drafts.json', { version: 1, drafts: [] });
  put('demo-state.json', demo.buildState(now));
}

module.exports = { load, save, seedDemo, connectorStatus, savedFeeds, executable };
