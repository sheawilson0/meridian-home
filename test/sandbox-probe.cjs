'use strict';

// Loaded in the fixture daemon before server.js, never in the live daemon.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const counts = { children: 0, outbound: 0, timers: 0 };
const forbidden = (kind) => () => { counts[kind]++; throw new Error('unexpected ' + kind); };
const cp = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = forbidden('children');
cp.ChildProcess.prototype.spawn = forbidden('children');
for (const mod of [require('node:http'), require('node:https')]) {
  mod.request = forbidden('outbound'); mod.get = forbidden('outbound');
}
require('node:net').Socket.prototype.connect = forbidden('outbound');
require('node:tls').connect = forbidden('outbound');
globalThis.fetch = forbidden('outbound');
for (const name of ['setInterval', 'setTimeout']) {
  const original = globalThis[name];
  globalThis[name] = (...args) => {
    const caller = new Error().stack.split('\n')[2];
    if (caller.includes(root) && !caller.includes(__filename)) counts.timers++;
    return original(...args);
  };
}
process.on('SIGTERM', () => {
  process.stdout.write('SANDBOX_COUNTS ' + JSON.stringify(counts) + '\n', () => process.exit(0));
});
