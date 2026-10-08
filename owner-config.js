'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only key names belong here. The old values stay in the private migration.
const migrationKeys = {
  money: { approvedClaims: { version: null, claims: null }, agentUrl: null },
  journal: { areas: null, tracks: { uni: null, work: null }, areaAliases: null },
  links: { categories: null, categoryRules: null },
  nudges: { skip: null },
  heartHealth: { project: null, scope: null, hostname: null, dashboardUrl: null, cli: null, from: null, answersFrom: null },
  preferences: { sources: null },
  exampleappFeedback: { stateFile: null, cli: null },
  calendar: { workEmail: null },
};

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function missingKeys(config, keys = migrationKeys, prefix = '') {
  const missing = [];
  for (const [key, value] of Object.entries(keys)) {
    const name = prefix ? prefix + '.' + key : key;
    if (!Object.hasOwn(config, key)) {
      if (object(value)) missing.push(...missingKeys({}, value, name));
      else missing.push(name);
    } else if (object(value) && object(config[key])) missing.push(...missingKeys(config[key], value, name));
  }
  return missing;
}

function hasRecords(dataDir) {
  for (const name of ['todos.json', 'links.json', 'journal.json', 'projects.json', 'calendars.json', 'drafts.json', 'stash/items.json', 'money/claims.json']) {
    try {
      const file = path.join(dataDir, name);
      if (fs.statSync(file).size > 16 * 1024 * 1024) return true;
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const records = value => Array.isArray(value) ? value.length > 0 : object(value) && Object.values(value).some(child => object(child) || Array.isArray(child) ? records(child) : false);
      if (records(doc)) return true;
    } catch {}
  }
  return false;
}

function warnOwnerConfig(config, dataDir, warn = console.warn) {
  const missing = missingKeys(config);
  if (missing.length && hasRecords(dataDir)) warn('Meridian: existing records found; missing migrated config keys: ' + missing.join(', ') + '. Review the owner config migration before continuing.');
  return missing;
}

module.exports = { migrationKeys, missingKeys, hasRecords, warnOwnerConfig };
