'use strict';

const { validatePlace } = require('./place');

// Keep setup fields and copy together so the dashboard can build its form.
const SCHEMA = {
  calendar: { needs: [{ key: 'icsUrls', label: 'Calendar links', kind: 'list', required: true, placeholder: 'https://example.com/calendar.ics', help: 'One link per line. In Google Calendar it’s under Settings, your calendar, “Secret address in iCal format”.' }], reason: 'Needs a calendar link.' },
  github: { needs: [{ key: 'account', label: 'GitHub account', kind: 'text', required: true, placeholder: 'your-account', help: 'Install gh and sign in first with gh auth login.' }], reason: 'Needs the gh command, signed in.' },
  ai: { needs: [], reason: 'Needs Claude Code or Codex on this computer.' },
  aiUsage: { needs: [], reason: 'Needs Claude Code or Codex on this computer.' },
  git: { needs: [{ key: 'roots', label: 'Project folders', kind: 'list', required: true, placeholder: '/home/you/projects', help: 'Folders that hold your projects, one per line.' }], reason: 'Needs git and a folder of projects.' },
  tailscale: { needs: [], reason: 'Needs Tailscale, signed in.' },
  linkMetadata: { needs: [] },
  almanac: { needs: [
    { key: 'name', label: 'Town or city', kind: 'text', required: true, placeholder: 'Edinburgh', help: 'The name shown with the weather.' },
    { key: 'latitude', label: 'Latitude', kind: 'text', required: true, placeholder: '55.953', help: 'Use where I am fills this in.' },
    { key: 'longitude', label: 'Longitude', kind: 'text', required: true, placeholder: '-3.188', help: 'Use where I am fills this in.' },
    { key: 'timezone', label: 'Timezone', kind: 'text', required: true, placeholder: 'Europe/London', help: 'Filled in from this computer.' },
  ], reason: 'Needs a place for the weather and sky.' },
  notify: { needs: [
    { key: 'topic', label: 'ntfy topic', kind: 'secret', required: true, help: 'Pick a name nobody would guess. Meridian keeps it and never shows it again.' },
    { key: 'url', label: 'ntfy server', kind: 'url', required: false, placeholder: 'https://ntfy.sh' },
  ], reason: 'Needs a private ntfy topic.' },
  previews: { needs: [], platform: 'darwin', reason: 'Needs Google Chrome, on a Mac.' },
  todoRank: { needs: [], reason: 'Needs Claude Code on this computer.' },
  tell: { needs: [], reason: 'Needs Claude Code on this computer.' },
  delegations: { needs: [], reason: 'Needs Claude Code or Codex on this computer.' },
  board: { needs: [], reason: 'Set board.dir in config to an existing Markdown folder.' },
  preferences: { needs: [], reason: 'Set preferences.sources in config to existing files.' },
  fleet: { needs: [], reason: 'Set fleet.services or fleet.sites in config.' },
  brain: { needs: [], reason: 'Set brain.graphPath in config to an existing graph file.' },
  threads: { needs: [], reason: 'Set threads.url in config.' },
  ledger: { needs: [], reason: 'Set ledger.dir in config to an existing folder.' },
  meetings: { needs: [], reason: 'Set meetings.dir in config to an existing folder.' },
  drift: { needs: [], reason: 'A LifeOS/AGENTS.md file is needed in your home folder.' },
  intake: { needs: [], reason: 'An external automation must supply brief-intake.json.' },
  exampleappFeedback: { needs: [], reason: 'Set exampleappFeedback.stateFile and cli in config.' },
  campaignSnapshot: { needs: [], reason: 'Set campaignSnapshot.dashboardUrl in config.' },
  heartHealth: { needs: [], live: false, reason: 'Set heartHealth.cli in config to an installed collector.' },
  localServers: { needs: [], reason: 'Install lsof.' },
  system: { needs: [], reason: 'Install df.' },
  artwork: { needs: [], live: false, reason: 'Supply a brief-art collection in the profile data folder.' },
  money: { needs: [], live: false, reason: 'Use the Money setup to connect accounts.' },
  voice: { needs: [], live: false, reason: 'Supply OPENAI_API_KEY or a configured macOS Keychain service.' },
  stashEnrichment: { needs: [] },
  stashSummary: { needs: [], live: false, reason: 'Set stash.summary in config to an installed agent or command.' },
  nudges: { needs: [], reason: 'Set nudges.enabled in config to enable meeting reminders.' },
  journalExport: { needs: [], reason: 'Set journal.vaultDir in config to an existing folder.' },
};

const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function fields(name) {
  const schema = Object.hasOwn(SCHEMA, name) && SCHEMA[name];
  if (!schema) throw Object.assign(new Error('Unknown connector'), { statusCode: 404 });
  return { needs: schema.needs, live: schema.live !== false, platform: schema.platform || 'any' };
}

function validate(name, input, config, { calendarConfigured = false, savedCalendar = false, calendarUrl } = {}) {
  const { needs } = fields(name);
  if (!object(input) || Object.keys(input).some(key => !['enabled', 'settings'].includes(key))) throw fail('Send enabled and settings');
  if (typeof input.enabled !== 'boolean') throw fail('enabled must be a boolean');
  const settings = input.settings === undefined ? {} : input.settings;
  if (!object(settings)) throw fail('settings must be an object');
  if (Object.keys(settings).some(key => !needs.some(field => field.key === key))) throw fail('Unknown setting');
  const patch = {};
  for (const field of needs) {
    if (!Object.hasOwn(settings, field.key)) continue;
    let value = settings[field.key];
    if (field.kind === 'bool') {
      if (typeof value !== 'boolean') throw fail(`${field.key} must be a boolean`);
    } else if (field.kind === 'list') {
      if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 4000 || /[\u0000-\u001f]/.test(item))) throw fail(`${field.key} must be a list of up to 20 values`);
      value = [...new Set(value.map(item => item.trim()))];
      if (name === 'calendar') value = value.map(calendarUrl);
    } else {
      if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u001f]/.test(value)) throw fail(`${field.key} must be text`);
      value = value.trim();
      if (field.kind === 'url' && value) {
        let url;
        try { url = new URL(value); } catch { throw fail(`${field.key} must be a valid HTTPS URL`); }
        if (url.protocol !== 'https:' || url.username || url.password) throw fail(`${field.key} must be a valid HTTPS URL`);
        value = url.href;
      }
      if (name === 'github' && value && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) throw fail('account must be a GitHub account name');
      if (name === 'notify' && field.key === 'topic' && value && !/^[a-z\d_-]{1,200}$/i.test(value)) throw fail('topic must use letters, numbers, underscores or hyphens');
    }
    if (name === 'almanac' && ['latitude', 'longitude'].includes(field.key)) {
      if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw fail(`${field.key} must be a number`);
      value = Number(value);
    }
    patch[field.key] = value;
  }
  const section = { ...(config[name === 'almanac' ? 'place' : name] || {}), ...patch };
  if (name === 'almanac' && (input.enabled || Object.keys(section).length)) {
    try { validatePlace(section); }
    catch (error) { throw fail(error.message); }
  }
  if (input.enabled) {
    for (const field of needs.filter(field => field.required)) {
      const value = section[field.key];
      const present = name === 'almanac' && ['latitude', 'longitude'].includes(field.key) ? typeof value === 'number' && Number.isFinite(value) : field.kind === 'bool' ? typeof value === 'boolean' : field.kind === 'list' ? Array.isArray(value) && value.length > 0 : typeof value === 'string' && Boolean(value.trim());
      if (!present && !(name === 'calendar' && (savedCalendar || !Object.hasOwn(patch, 'icsUrls') && calendarConfigured))) throw fail(`${field.key} is required`);
    }
  }
  return { enabled: input.enabled, patch };
}

module.exports = { SCHEMA, fields, validate };
