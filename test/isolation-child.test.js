'use strict';
// Node children of a guarded test are guarded too (lead review, 8 Oct 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

test('a Node child cannot read the real home folder or the repo config', () => {
  const realHome = os.userInfo().homedir;
  for (const env of [undefined, { PATH: process.env.PATH }]) {
    for (const file of [path.join(realHome, '.zshrc'), path.join(__dirname, '..', 'config.json')]) {
      const r = cp.spawnSync(process.execPath, ['-e', `try{require('fs').readFileSync(${JSON.stringify(file)});console.log('READ')}catch(e){console.log(e.message)}`], { encoding: 'utf8', ...(env ? { env } : {}) });
      assert.doesNotMatch(r.stdout, /^READ/m, `child read ${file}`);
      assert.match(r.stdout, /Unit isolation/);
    }
  }
});
