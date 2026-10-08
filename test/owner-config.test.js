'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrationKeys, missingKeys, warnOwnerConfig } = require('../owner-config');

test('fresh or empty installs are quiet, records trigger one masked warning, migrated owners are quiet', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-warning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [], warn = line => lines.push(line);
  warnOwnerConfig({}, dir, warn); assert.deepEqual(lines, []);
  fs.writeFileSync(path.join(dir, 'todos.json'), JSON.stringify({ todos: [] }));
  warnOwnerConfig({}, dir, warn); assert.deepEqual(lines, []);
  fs.writeFileSync(path.join(dir, 'todos.json'), JSON.stringify({ todos: [{ title: 'never print this record' }] }));
  warnOwnerConfig({}, dir, warn); assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('calendar.workEmail'));
  assert.ok(!lines[0].includes('never print')); assert.ok(!lines[0].includes('\n'));
  warnOwnerConfig(structuredClone(migrationKeys), dir, warn); assert.equal(lines.length, 1);
});

test('explicit disabling values count as configured and partial objects report missing leaves', () => {
  const config = structuredClone(migrationKeys);
  config.heartHealth = null; config.preferences.sources = []; config.exampleappFeedback.cli = '';
  assert.deepEqual(missingKeys(config), []);
  delete config.journal.tracks.uni;
  assert.deepEqual(missingKeys(config), ['journal.tracks.uni']);
});
