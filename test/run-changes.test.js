'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const rc = require('../run-changes');

async function workspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-undo-'));
  const work = path.join(root, 'work');
  const run = path.join(work, 'delegations', 'feedback-x');
  await fsp.mkdir(path.join(work, 'public'), { recursive: true });
  await fsp.mkdir(path.join(work, 'data'), { recursive: true });
  await fsp.mkdir(path.join(work, 'node_modules', 'x'), { recursive: true });
  await fsp.mkdir(run, { recursive: true });
  await fsp.writeFile(path.join(work, 'server.js'), 'one\ntwo\nthree\n');
  await fsp.writeFile(path.join(work, 'public', 'command.css'), 'body { color: red; }\n');
  await fsp.writeFile(path.join(work, 'public', 'old.html'), '<p>old</p>\n');
  await fsp.writeFile(path.join(work, 'config.json'), '{"token":"secret-1"}\n');
  await fsp.writeFile(path.join(work, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  await fsp.writeFile(path.join(work, 'data', 'links.json'), '{}\n');
  await fsp.writeFile(path.join(work, 'node_modules', 'x', 'index.js'), 'x\n');
  await fsp.writeFile(path.join(work, 'server.js.bak-1002'), 'backup\n');
  await fsp.writeFile(path.join(work, 'public', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  return { work, run };
}

test('snapshot copies only editable text files', async () => {
  const { work, run } = await workspace();
  const snap = await rc.snapshot(work, run);
  const manifest = JSON.parse(await fsp.readFile(path.join(run, 'before', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['config.json', 'public/command.css', 'public/old.html', 'run.sh', 'server.js']);
  assert.equal(snap.files, 5);
  assert.equal(manifest.skipped.binary, 1);
  assert.ok(snap.ms < 2000);
  assert.ok(rc.hasSnapshot(run));
});

test('changes, diff, undo, and conflicts', { skip: !fs.existsSync('/usr/bin/diff') && '/usr/bin/diff is needed for unified diff fixtures' }, async () => {
  const { work, run } = await workspace();
  await rc.snapshot(work, run);
  // What a run might do.
  await fsp.writeFile(path.join(work, 'server.js'), 'one\nTWO\nthree\nfour\n');
  await fsp.writeFile(path.join(work, 'public', 'command.css'), 'body { color: blue; }\n');
  await fsp.writeFile(path.join(work, 'public', 'new.js'), 'a\nb\n');
  await fsp.unlink(path.join(work, 'public', 'old.html'));
  await fsp.writeFile(path.join(work, 'config.json'), '{"token":"secret-2"}\n');
  await fsp.writeFile(path.join(work, 'run.sh'), '#!/bin/sh\necho bye\n');
  await fsp.writeFile(path.join(work, 'data', 'links.json'), '{"changed":true}\n'); // state: ignored
  await fsp.writeFile(path.join(work, 'server.js.bak-run'), 'agent backup\n'); // backups: ignored

  const record = await rc.computeChanges(work, run, { extra: { concurrent: ['feedback-y'] } });
  assert.deepEqual(record.files.map((f) => [f.path, f.status, f.added, f.removed]), [
    ['config.json', 'modified', 1, 1],
    ['public/command.css', 'modified', 1, 1],
    ['public/new.js', 'added', 2, 0],
    ['public/old.html', 'deleted', 0, 1],
    ['run.sh', 'modified', 1, 1],
    ['server.js', 'modified', 2, 1],
  ]);
  assert.deepEqual(record.total, { files: 6, added: 7, removed: 5 });
  const diff = await fsp.readFile(path.join(run, 'changes.diff'), 'utf8');
  assert.match(diff, /^--- a\/server\.js\n\+\+\+ b\/server\.js/m);
  assert.match(diff, /^\+TWO$/m);
  assert.ok(diff.indexOf('a/config.json') < diff.indexOf('a/server.js'), 'diff follows the sorted file list');
  assert.doesNotMatch(diff, /secret-\d/, 'secret files keep their diff text out of changes.diff');
  assert.match(diff, /config\.json[\s\S]*diff withheld/);
  const summary = rc.readChanges(run);
  assert.deepEqual(Object.keys(summary.files[0]), ['path', 'status', 'added', 'removed']);
  assert.deepEqual(summary.concurrent, ['feedback-y']);

  // Owner edits one file after the run finished: that one is a conflict.
  await fsp.writeFile(path.join(work, 'public', 'command.css'), 'body { color: green; }\n');
  const result = await rc.undo(work, run);
  assert.deepEqual(result.restored.sort(), ['config.json', 'public/new.js', 'public/old.html', 'run.sh', 'server.js']);
  assert.deepEqual(result.conflicts, [{ path: 'public/command.css', status: 'modified', reason: 'edited since the run finished' }]);
  assert.equal(await fsp.readFile(path.join(work, 'server.js'), 'utf8'), 'one\ntwo\nthree\n');
  assert.equal(await fsp.readFile(path.join(work, 'public', 'old.html'), 'utf8'), '<p>old</p>\n');
  assert.equal(fs.existsSync(path.join(work, 'public', 'new.js')), false);
  assert.equal(await fsp.readFile(path.join(work, 'config.json'), 'utf8'), '{"token":"secret-1"}\n');
  assert.equal(await fsp.readFile(path.join(work, 'public', 'command.css'), 'utf8'), 'body { color: green; }\n', 'later edit kept');
  assert.equal(fs.statSync(path.join(work, 'run.sh')).mode & 0o777, 0o755, 'mode kept');
  assert.equal(await fsp.readFile(path.join(work, 'data', 'links.json'), 'utf8'), '{"changed":true}\n', 'state untouched');
  assert.deepEqual((await fsp.readdir(path.join(work, 'public'))).filter((f) => f.endsWith('.tmp')), []);
});

test('a run that changed nothing records nothing', async () => {
  const { work, run } = await workspace();
  await rc.snapshot(work, run);
  const record = await rc.computeChanges(work, run);
  assert.deepEqual(record.total, { files: 0, added: 0, removed: 0 });
  assert.equal(await fsp.readFile(path.join(run, 'changes.diff'), 'utf8'), '');
});

test('change paths cannot escape the workdir', async () => {
  const { work, run } = await workspace();
  await rc.snapshot(work, run);
  await fsp.writeFile(path.join(run, 'changes.json'), JSON.stringify({ files: [{ path: '../outside.txt', status: 'added', after: null }] }));
  await assert.rejects(() => rc.undo(work, run), /escapes the workdir/);
});
