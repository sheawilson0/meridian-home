'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createCapture, idTime } = require('../capture');

async function setup(start = Date.parse('2026-10-02T09:00:00.500Z')) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'capture-'));
  const clock = { now: start };
  const c = createCapture({ inbox: path.join(dir, 'Inbox'), trashDir: path.join(dir, 'trash', 'inbox'), now: () => clock.now });
  return { dir, clock, c, inbox: path.join(dir, 'Inbox'), trash: path.join(dir, 'trash', 'inbox') };
}

test('capture returns its id; undo moves it to the trash within 30 minutes', async () => {
  const { c, clock, inbox, trash } = await setup();
  const r = await c.capture('  Ring the venue  ');
  assert.equal(r.ok, true);
  assert.equal(r.id, '2026-10-02T09-00-00');
  assert.equal(r.file, path.join(inbox, 'capture-2026-10-02T09-00-00.md'));
  assert.match(await fsp.readFile(r.file, 'utf8'), /source: meridian\n---\n\nRing the venue\n$/);
  const second = await c.capture('Same second');
  assert.equal(second.id, '2026-10-02T09-00-00-2', 'no overwrite in the same second');
  clock.now += 29 * 60000;
  const u = await c.undo(r.id);
  assert.equal(u.ok, true);
  assert.equal(u.trashed, path.join(trash, 'capture-2026-10-02T09-00-00.md'));
  await assert.rejects(fsp.access(r.file));
  await assert.rejects(c.undo(r.id), (e) => e.statusCode === 404, 'gone already');
});

test('undo refuses old captures, bad ids and files Meridian did not write', async () => {
  const { c, clock, inbox, dir } = await setup();
  const r = await c.capture('Old');
  clock.now += 31 * 60000;
  await assert.rejects(c.undo(r.id), (e) => e.statusCode === 409 && /30 minutes/.test(e.message));
  for (const bad of ['../../etc/passwd', '2026-10-02T09-00-00/../../x', '2026-13-40T09-00-00', '', null, '2026-10-02T09:00:00', '2026-10-02T09-00-00-999']) {
    await assert.rejects(c.undo(bad), (e) => e.statusCode === 400, String(bad));
  }
  // A hand-made note with a capture-style name is left alone.
  const fresh = await setup();
  await fsp.mkdir(fresh.inbox, { recursive: true });
  await fsp.writeFile(path.join(fresh.inbox, 'capture-2026-10-02T09-00-00.md'), '---\nsource: obsidian\n---\nmine');
  await assert.rejects(fresh.c.undo('2026-10-02T09-00-00'), (e) => e.statusCode === 409);
  // A symlink in the Inbox is not followed.
  await fsp.writeFile(path.join(dir, 'outside.md'), '---\nsource: meridian\n---\n');
  await fsp.symlink(path.join(dir, 'outside.md'), path.join(inbox, 'capture-2026-10-02T09-30-00.md'));
  clock.now = Date.parse('2026-10-02T09-30-00'.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3Z'));
  await assert.rejects(c.undo('2026-10-02T09-30-00'), (e) => e.statusCode === 409);
  assert.equal(idTime('2026-10-02T09-00-00'), Date.parse('2026-10-02T09:00:00Z'));
});
