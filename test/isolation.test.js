'use strict';
require('./helpers/isolate.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const realHome = require('node:os').userInfo().homedir;
test('unit isolation refuses app data and live service access before doing IO', () => {
  const root = path.join(__dirname, '..');
  assert.throws(() => fs.readFileSync(path.join(root, 'data', 'todos.json')), /Unit isolation/);
  assert.throws(() => fs.existsSync(path.join(realHome, 'Meridian', 'data', 'todos.json')), /Unit isolation/);
  assert.throws(() => fs.writeFileSync(path.join(root, 'config.json'), 'fixture'), /Unit isolation/);
  assert.throws(() => net.createConnection({ host: '127.0.0.1', port: 4980 }), /Unit isolation/);
  assert.throws(() => net.createConnection({ host: 'example.com', port: 443 }), /Unit isolation/);
  assert.throws(() => cp.spawn('launchctl', ['list']), /Unit isolation/);
});
