'use strict';
// Node 22 resolves `node --test test/` as a module, so fan out explicitly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const isolation = path.join(__dirname, 'helpers', 'isolate.cjs');
const results = [];
for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) {
  test(file, { timeout: 90000 }, async (t) => {
    const start = performance.now();
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'MERIDIAN_TEST_PORT', 'MERIDIAN_TEST_PORT_BASE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const child = spawn(process.execPath, ['--require', isolation, '--test', path.join(__dirname, file)], { env, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    const stop = () => child.kill('SIGTERM'); t.signal.addEventListener('abort', stop, { once: true });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    t.signal.removeEventListener('abort', stop);
    const row = { file, exit, ms: Math.round(performance.now() - start) };
    for (const key of ['tests', 'pass', 'fail', 'skipped']) row[key] = Number(log.match(new RegExp('^# ' + key + ' (\\d+)', 'm'))?.[1] || 0);
    results.push(row); t.diagnostic(JSON.stringify(row));
    assert.equal(exit, 0, log);
  });
}
test.after(() => {
  if (process.env.MERIDIAN_TEST_REPORT) fs.writeFileSync(process.env.MERIDIAN_TEST_REPORT, JSON.stringify(results, null, 2) + '\n');
});
