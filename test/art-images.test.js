'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchArtworkImage } = require('../art-images');
const id = '0faa1fea-aaaa-83bf-8324-8b7f90266dd2';

test('requests museum JPEGs with the required referer and returns image bytes', async () => {
  const bytes = await fetchArtworkImage(id, async (url, options) => {
    assert.equal(url, `https://www.artic.edu/iiif/2/${id}/full/1600,/0/default.jpg`);
    assert.equal(options.headers.Referer, 'https://www.artic.edu/');
    assert.ok(options.headers['User-Agent']);
    assert.ok(options.signal);
    return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
  });
  assert.deepEqual([...bytes], [255, 216, 255]);
});

test('rejects invalid IDs, failed responses and HTML instead of displaying broken images', async () => {
  await assert.rejects(fetchArtworkImage('../config.json', () => assert.fail('must not request')), /Invalid/);
  await assert.rejects(fetchArtworkImage(id, async () => new Response('Forbidden', { status: 403 })), /unavailable/);
  await assert.rejects(fetchArtworkImage(id, async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })), /unavailable/);
});
