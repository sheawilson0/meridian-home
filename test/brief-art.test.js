'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
function fixture(t, fetchImage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-art-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'data', 'brief-art'); fs.mkdirSync(root, { recursive: true });
  const collection = [{ i: '11111111-1111-1111-1111-111111111111', t: 'First' }, { i: '22222222-2222-2222-2222-222222222222', t: 'Second' }];
  fs.writeFileSync(path.join(root, 'collection.json'), JSON.stringify({ artworks: collection }));
  const previous = { date: '2000-01-01', art: collection[0], file: collection[0].i + '.jpg' };
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify(previous));
  fs.writeFileSync(path.join(root, previous.file), 'previous image');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../brief-art.js'), 'utf8'), {
    module, __dirname: dir, Buffer, console, Intl, Date,
    require: name => name === './art-images' ? { fetchArtworkImage: fetchImage }
      : name === './runtime' ? { JOBS_ENABLED: true, connectorEnabled: () => true, DATA_DIR: path.join(dir, 'data') } : require(name),
  });
  return { source: module.exports, previous, root };
}
test('Home advances its painting without Main, coalesces refreshes, and keeps the selected day', async t => {
  let calls = 0;
  const { source } = fixture(t, async () => { calls++; return Buffer.from('new image'); });
  await Promise.all([source.refresh(), source.refresh()]);
  assert.equal(source.readCurrent().art.t, 'Second');
  assert.equal(fs.readFileSync(source.currentImage(), 'utf8'), 'new image');
  await source.refresh(); assert.equal(calls, 1);
});
test('an unavailable museum image retains the last working painting and state', async t => {
  const { source, previous } = fixture(t, async () => { throw new Error('offline'); });
  await assert.rejects(source.refresh(), /offline/);
  assert.equal(JSON.stringify(source.readCurrent()), JSON.stringify(previous));
  assert.equal(fs.readFileSync(source.currentImage(), 'utf8'), 'previous image');
});
