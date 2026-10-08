'use strict';
const runtime = require('./runtime');
const JOBS_ENABLED = runtime.connectorEnabled('artwork');
const { jobsOffError } = runtime;

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

async function fetchArtworkImage(imageId, request = fetch) {
  if (!JOBS_ENABLED) throw jobsOffError();
  if (!/^[a-f0-9-]{36}$/.test(imageId)) throw new Error('Invalid artwork image');
  const response = await request(`https://www.artic.edu/iiif/2/${imageId}/full/1600,/0/default.jpg`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.artic.edu/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) {
    throw new Error('Museum image unavailable');
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Museum image too large');
  }
  // Count the stream too: a missing or incorrect Content-Length is common.
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('Museum image too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { fetchArtworkImage };
