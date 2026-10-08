'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { MAX_BYTES, saveAttachments, promptFor } = require('../feedback-attachments');

function dataUrl(type, value) {
  return `data:${type};base64,${Buffer.from(value).toString('base64')}`;
}

test('stores feedback images and gives the agent local paths', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-feedback-images-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const saved = await saveAttachments([
    { name: 'Screen shot.png', type: 'image/png', data: dataUrl('image/png', 'first') },
    { name: 'reference.jpg', type: 'image/jpeg', data: dataUrl('image/jpeg', 'second') },
  ], { root, id: 'feedback-one' });

  assert.equal(saved.length, 2);
  assert.match(saved[0].filename, /^01-screen-shot\.png$/);
  assert.equal(await fsp.readFile(saved[1].path, 'utf8'), 'second');
  assert.match(promptFor(saved), /Attached images/);
  assert.match(promptFor(saved), /feedback-one/);
});

test('rejects oversized or unsupported feedback images', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-feedback-image-errors-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oversized = Buffer.alloc(MAX_BYTES + 1).toString('base64');

  await assert.rejects(
    () => saveAttachments([{ name: 'too-big.png', data: `data:image/png;base64,${oversized}` }], { root, id: 'too-big' }),
    /5 MB or smaller/,
  );
  await assert.rejects(
    () => saveAttachments([{ name: 'not-image.txt', data: dataUrl('text/plain', 'nope') }], { root, id: 'not-image' }),
    /attachments must be image/,
  );
});
