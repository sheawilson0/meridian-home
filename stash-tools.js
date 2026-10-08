'use strict';

// Stash for agents (6 Oct 2026). Owner wants to say "design this, look in my
// Stash for inspiration" and have the agent find what he saved instead of
// searching for it again. These join the tools on Meridian's /mcp (drafts.js),
// the same list the Dot, Claude and Codex see.
//
//   stash_search   find things: words, #space, kind, colour, site, dates
//   stash_get      one thing in full, with its picture inline so the agent can look at it
//   stash_spaces   the spaces and how many of each kind there are
//   note_add       save a thought as a note (the one write)
//
// What an agent never sees:
// - anything in a space named "private" (config stash.agentHiddenSpaces), so
//   Owner can keep a screenshot or note to himself
// - deleted things, even within the 30 days they can still be put back
// - card numbers, sort codes and IBANs in text read off a picture or typed in
//   a note, which are blanked as a backstop
// - the original files: an agent on the tailnet gets an address for them, and
//   the Dot (on the internet, through Funnel) gets the thumbnail inline. /mcp is
//   still the only path Funnel serves.

const fsp = require('fs/promises');
const { colourName } = require('./stash');

const KINDS = ['image', 'screenshot', 'link', 'note', 'quote', 'colour', 'file', 'video'];
const DAY = 86400e3;
const NOTE_LIMIT = 30;           // notes an agent may add an hour, all agents together
const THUMB_MAX = 1.5 * 1024 * 1024;

const fail = (m) => Object.assign(new Error(m), { statusCode: 400 });
const squash = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t; };

// ---------------------------------------------------------------- redaction

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
function redact(s) {
  if (!s) return s;
  return String(s)
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, '[IBAN hidden]')
    .replace(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card number hidden]' : m))
    .replace(/(?<![\d-])\d{2}-\d{2}-\d{2}(?![\d-])/g, '[sort code hidden]');
}

// ---------------------------------------------------------------- shaping

const isShot = (it) => it.kind === 'image' && (it.source === 'screenshot' || (it.labels || []).some((l) => l.id === 'screenshot'));

function titleOf(it) {
  if (it.title) return it.title;
  if (it.kind === 'note' || it.kind === 'quote') return it.summary || squash(it.text, 90);
  if (it.kind === 'link') return it.domain || it.url;
  if (it.kind === 'colour') return it.hex;
  return it.name || (isShot(it) ? 'Screenshot' : it.kind === 'video' ? 'Video' : it.kind === 'file' ? 'File' : 'Image');
}
function coloursOf(it) {
  const names = (it.palette || []).filter((p) => p.weight >= 0.06).map((p) => p.name || colourName(p.hex));
  if (it.kind === 'colour' && it.hex) names.unshift(colourName(it.hex));
  return [...new Set(names)];
}

function createStashTools(stash, { base = () => '', hiddenSpaces = () => ['private'], now = () => Date.now() } = {}) {
  const hidden = (it) => {
    const h = (hiddenSpaces() || []).map((s) => String(s).toLowerCase());
    return (it.spaces || []).some((s) => h.includes(String(s).toLowerCase()));
  };
  const links = (it) => {
    const b = base();
    if (!b) return {};
    const out = { open: `${b}/command#stash/${it.id}` };
    if (it.thumb) out.thumbnail = `${b}/api/stash/${it.id}/thumb`;
    if (it.file) out.original = `${b}/api/stash/${it.id}/file`;
    return out;
  };

  // One line each in a search: enough to choose, never the bytes.
  function brief(it) {
    const o = { id: it.id, kind: isShot(it) ? 'screenshot' : it.kind, title: redact(titleOf(it)) };
    if (it.summary) o.summary = redact(it.summary);
    else if (it.kind === 'link' && it.description) o.summary = squash(it.description, 200);
    if ((it.kind === 'note' || it.kind === 'quote') && it.text) o.excerpt = redact(squash(it.text, 280));
    if (it.note) o.ownersNote = redact(squash(it.note, 280));
    if (it.url) o.url = it.url;
    if (it.page?.url && it.page.url !== it.url) o.from = { url: it.page.url, title: it.page.title || '' };
    if (it.hex) o.hex = it.hex;
    const colours = coloursOf(it); if (colours.length) o.colours = colours;
    const labels = (it.labels || []).filter((l) => l.id !== 'screenshot').slice(0, 5).map((l) => l.id.replace(/_/g, ' ')); if (labels.length) o.looksLike = labels;
    if (it.hasText || it.ocr) o.hasTextInPicture = true;
    if (it.spaces?.length) o.spaces = it.spaces;
    if (it.pinned) o.pinned = true;
    o.saved = new Date(it.created).toISOString();
    o.hasPicture = !!it.thumb;
    return Object.assign(o, links(it));
  }

  function dayStart(v, name) {
    if (v === undefined || v === null || v === '') return null;
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T00:00:00' : String(v));
    if (!Number.isFinite(t)) throw fail(`${name} must be a date like 2026-09-30`);
    return t;
  }

  async function visible(id) {
    let it;
    try { it = await stash.get(String(id || '')); } catch { it = null; }
    if (!it || it.deleted || hidden(it)) throw Object.assign(new Error('nothing in the stash with that id'), { statusCode: 404 });
    return it;
  }

  const recent = [];   // when agents added notes, for the hourly limit

  return [
    { name: 'stash_search',
      description: 'Search Owner\'s Stash: the screenshots, images, links, notes, quotes, colours and files he has saved to come back to. Use it when he says "look in my Stash", asks for his inspiration, references or notes on something, or before asking him to find something again. '
        + 'query is loose words matched against titles, notes, summaries, text in pictures, page titles and what Vision saw in the picture. It also understands "#space", a colour ("blue"), a kind ("screenshots", "links", "quotes"), "site:dribbble.com", "\\"exact words\\"" and "this week" / "last month". Leave it empty for the newest things. '
        + 'Returns short descriptions, not the files: call stash_get on the ones worth a closer look to see the picture.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "editorial type posters" or "blue #moodboard"' },
        kind: { type: 'string', enum: KINDS },
        space: { type: 'string', description: 'Only things in this space (see stash_spaces)' },
        since: { type: 'string', description: 'Saved on or after this date, YYYY-MM-DD' },
        before: { type: 'string', description: 'Saved before this date, YYYY-MM-DD' },
        limit: { type: 'number', description: 'Default 20, at most 50' },
      } },
      async run(a) {
        const since = dayStart(a.since, 'since'); const before = dayStart(a.before, 'before');
        if (a.kind && !KINDS.includes(a.kind)) throw fail('kind must be one of ' + KINDS.join(', '));
        const r = await stash.list({ q: String(a.query || '').slice(0, 300), kind: a.kind || '', space: a.space ? String(a.space).slice(0, 40) : '', limit: 1000 });
        const found = r.items.filter((it) => !hidden(it) && (since === null || it.created >= since) && (before === null || it.created < before));
        const limit = Math.max(1, Math.min(50, Number(a.limit) || 20));
        return {
          total: found.length,
          understood: r.chips.length ? r.chips.map((c) => c.label) : undefined,
          items: found.slice(0, limit).map(brief),
          more: found.length > limit ? `${found.length - limit} more; narrow the query or raise limit` : undefined,
        };
      } },
    { name: 'stash_get',
      description: 'One thing from Owner\'s Stash in full: the whole note or quote, all the text read off a picture, the link\'s page description, colours with hex values, its spaces and where it came from. For pictures, link previews and files with a preview, the image comes back with it (set image to false to skip it). Addresses for the original only work on Owner\'s tailnet.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, image: { type: 'boolean', description: 'Include the picture (default true)' } }, required: ['id'] },
      async run(a) {
        const it = await visible(a.id);
        const o = brief(it);
        delete o.excerpt;
        if (it.text) o.text = redact(it.text);
        if (it.ocr && it.ocr.trim().length > 2) o.textInPicture = redact(it.ocr.trim());
        if (it.description) o.pageDescription = it.description;
        if (it.site) o.site = it.site;
        if (it.note) o.ownersNote = redact(it.note);
        if (it.palette?.length) o.palette = it.palette.filter((p) => p.weight >= 0.03).map((p) => ({ hex: p.hex, name: p.name || colourName(p.hex), share: Math.round(p.weight * 100) / 100 }));
        if (it.w && it.h) o.size = `${it.w}×${it.h}`;
        if (it.name) o.fileName = it.name;
        if (it.mime && it.file) o.fileType = it.mime;
        if (it.agent) o.addedBy = it.agent;
        if (a.image !== false && it.thumb) {
          const f = await stash.filePath(it.id, 'thumb');
          const buf = f && await fsp.readFile(f.file).catch(() => null);
          if (buf && buf.length <= THUMB_MAX) { o.picture = 'attached below (a preview, at most 900 px)'; o._images = [{ data: buf.toString('base64'), mimeType: 'image/jpeg' }]; }
        }
        return o;
      } },
    { name: 'stash_spaces',
      description: 'The spaces Owner sorts his Stash into (like "Design inspiration" or "Shopping"), with how many things are in each, and how many of each kind there are overall.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const r = await stash.list({ limit: 1000 });
        const shown = r.items.filter((it) => !hidden(it));
        const spaces = new Map(); const kinds = {};
        for (const it of shown) {
          const k = isShot(it) ? 'screenshot' : it.kind;
          kinds[k] = (kinds[k] || 0) + 1;
          for (const s of it.spaces || []) spaces.set(s, (spaces.get(s) || 0) + 1);
        }
        const order = r.spaces.map((s) => s.name).filter((n) => spaces.has(n));
        return { total: shown.length, kinds, spaces: order.map((name) => ({ name, items: spaces.get(name) })) };
      } },
    { name: 'note_add',
      description: 'Save a thought to Owner\'s Stash as a note, when he asks you to note, remember or jot something down for him. Optionally put it in spaces (for example ["uni"] or ["idea"]). It gets a one-line summary by itself. Not for to-dos (use todo_add) or drafts (use draft_create).',
      inputSchema: { type: 'object', properties: {
        text: { type: 'string', description: 'The note, in Owner\'s words where you have them' },
        title: { type: 'string' },
        spaces: { type: 'array', items: { type: 'string' }, description: 'Spaces to put it in, without the #' },
      }, required: ['text'] },
      async run(a, by, check) {
        const text = String(a.text || '').trim();
        if (!text) throw fail('text is empty');
        if (text.length > 20000) throw fail('text is too long (20,000 characters at most)');
        const t = now();
        while (recent.length && recent[0] < t - 3600e3) recent.shift();
        if (recent.length >= NOTE_LIMIT) throw fail(`agents have added ${NOTE_LIMIT} notes in the last hour; wait, or ask Owner`);
        const spaces = (Array.isArray(a.spaces) ? a.spaces : a.spaces ? [a.spaces] : []).map((s) => String(s).replace(/^#/, '').trim()).filter(Boolean);
        const r = await stash.addText({ text, kind: 'note', title: a.title ? String(a.title) : '', spaces, source: 'agent', agent: by || 'agent' }, { publicOnly: true, check });
        recent.push(t);
        return { saved: r.item.id, spaces: r.item.spaces, ...links(r.item) };
      } },
  ];
}

module.exports = { createStashTools, redact, titleOf };
