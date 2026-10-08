'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_ATTACHMENTS = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
  ['image/tiff', 'tiff'],
  ['image/bmp', 'bmp'],
]);

function safeStem(value, fallback) {
  const stem = path.basename(String(value || ''), path.extname(String(value || '')))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return stem || fallback;
}

function decodeImageData(attachment) {
  const data = String(attachment && attachment.data || '');
  const match = data.match(/^data:(image\/(?:png|jpeg|gif|webp|avif|heic|heif|tiff|bmp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('attachments must be image files such as PNG, JPEG, GIF, WebP, or HEIC');
  const type = match[1].toLowerCase();
  const encoded = match[2].replace(/\s/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('each image must be 5 MB or smaller');
  return { type, bytes };
}

async function saveAttachments(attachments, { root, id }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('attach up to 4 images');

  const dir = path.join(root, id);
  const saved = [];
  try {
    await fsp.mkdir(dir, { recursive: true });
    for (const [index, attachment] of attachments.entries()) {
      const { type, bytes } = decodeImageData(attachment);
      const extension = IMAGE_TYPES.get(type);
      const stem = safeStem(attachment && attachment.name, 'image');
      const filename = `${String(index + 1).padStart(2, '0')}-${stem}.${extension}`;
      const file = path.join(dir, filename);
      await fsp.writeFile(file, bytes, { flag: 'wx' });
      saved.push({ filename, path: file, type, bytes: bytes.length });
    }
    return saved;
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function promptFor(saved) {
  if (!saved.length) return '';
  return 'Attached images (open these local files when reviewing the request):\n'
    + saved.map((item) => `- ${item.path}`).join('\n');
}

module.exports = { MAX_ATTACHMENTS, MAX_BYTES, saveAttachments, promptFor };
