'use strict';
const runtime = require('./runtime');
const JOBS_ENABLED = runtime.connectorEnabled('artwork');
const { DATA_DIR } = runtime;
// The brief owns its daily painting on Home, independent of either desktop.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fetchArtworkImage } = require('./art-images');
const root = path.join(DATA_DIR, 'brief-art');
const collection = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'collection.json'))).artworks; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
})();
function readCurrent() {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function currentImage(current = readCurrent()) {
  return current && /^[a-f0-9-]{36}\.jpg$/.test(current.file) ? path.join(root, current.file) : null;
}
let pending;
function refresh() {
  if (!JOBS_ENABLED || !collection.length) return Promise.resolve(readCurrent());
  if (pending) return pending;
  pending = (async () => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const previous = readCurrent();
    if (previous?.date === date && fs.existsSync(currentImage(previous))) return previous;
    const index = collection.findIndex(art => art.i === previous?.art.i);
    let lastError;
    for (let offset = 1; offset <= collection.length; offset++) {
      const art = collection[(index + offset) % collection.length];
      if (art.i === previous?.art.i) continue;
      try {
        const bytes = await fetchArtworkImage(art.i);
        const file = art.i + '.jpg';
        await fsp.writeFile(path.join(root, file), bytes);
        const current = { version: 1, date, art, file, updatedAt: new Date().toISOString() };
        await fsp.writeFile(path.join(root, 'current.json.tmp'), JSON.stringify(current, null, 2) + '\n');
        await fsp.rename(path.join(root, 'current.json.tmp'), path.join(root, 'current.json'));
        return current;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('No painting available; retained previous image');
  })().finally(() => { pending = null; });
  return pending;
}
module.exports = { collection, readCurrent, currentImage, refresh };
