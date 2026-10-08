'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('daily activity passes shell metacharacters in repo names literally to git', () => {
  const name = 'repo$(security_marker)"`security_marker`';
  const home = '/isolated-security-home';
  const expected = path.join(home, 'Developer', name);
  const calls = [], output = [];
  const stop = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'day-in-english.js'), 'utf8');
  const mockFs = {
    existsSync: (file) => file === path.join(expected, '.git'),
    readdirSync: (dir) => dir === path.join(home, 'Developer') ? [name] : [],
  };
  const child = {
    execSync: () => assert.fail('a repository path must not enter a shell'),
    execFileSync(bin, args, options) {
      calls.push([bin, Array.from(args), options.encoding, Array.from(options.stdio)]);
      return 'First subject\nSecond subject\n';
    },
  };
  const ctx = vm.createContext({
    require: (module) => ({ fs: mockFs, path, os: { homedir: () => home }, child_process: child })[module],
    process: { argv: ['node', 'script', '2026-10-08', '--json'], exit: () => { throw stop; } },
    console: { log: (text) => output.push(text) },
  });
  try { vm.runInContext(source, ctx); } catch (error) { if (error !== stop) throw error; }
  assert.deepEqual(calls, [['git', ['-C', expected, 'log', '--since=2026-10-08 00:00', '--until=2026-10-08 23:59:59', '--format=%s', '--no-merges'], 'utf8', ['ignore', 'pipe', 'ignore']]]);
  assert.deepEqual(JSON.parse(output[0]).groups[0].commits, ['First subject', 'Second subject']);
});
