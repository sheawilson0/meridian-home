'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchArtworkImage } = require('../art-images');
const id = '0faa1fea-aaaa-83bf-8324-8b7f90266dd2';

test('museum reader refuses oversized Content-Length and cancels the body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(fetchArtworkImage(id, async () => new Response(body, {
    headers: { 'content-type': 'image/jpeg', 'content-length': String(31 * 1024 * 1024) },
  })), /too large/);
  assert.equal(cancelled, true);
});

test('museum reader caps chunked bytes even with a false length and closes the stream', async () => {
  for (const headers of [{}, { 'content-length': '3' }]) {
    let cancelled = false, sent = 0;
    // Reuse one immutable chunk so the test needs only 1 MB of memory.
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({
      pull(controller) { sent++; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(fetchArtworkImage(id, async () => new Response(body, {
      headers: { 'content-type': 'image/jpeg', ...headers },
    })), /too large/);
    assert.equal(cancelled, true);
    assert.ok(sent <= 33, 'the remaining response is never buffered');
  }
});

test('museum reader keeps normal JPEG bytes and rejects an interrupted stream', async () => {
  const bytes = await fetchArtworkImage(id, async () => new Response(new Uint8Array([255, 216, 255]), {
    headers: { 'content-type': 'image/jpeg' },
  }));
  assert.deepEqual([...bytes], [255, 216, 255]);
  await assert.rejects(fetchArtworkImage(id, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('interrupted')); },
  }), { headers: { 'content-type': 'image/jpeg' } })), /interrupted/);
});
