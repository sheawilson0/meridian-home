'use strict';

// Stash for agents and note summaries (6 Oct 2026): stash-summary.js,
// stash-tools.js, the summary queue in stash.js, capture into Stash.

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStash } = require('../stash');
const { createSummariser, needsSummary, summaryKey, tidy } = require('../stash-summary');
const { createStashTools, redact } = require('../stash-tools');
const { createCapture } = require('../capture');
const { mcpMessage } = require('../drafts');

const LONG = 'Hi Daniel,\n\nApologies this is late. Here are my project directions before Thursday: Meridian as the lead, an ambient agent second.';

async function setup({ summarise, summaryDelayMs = 0 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stash-agents-'));
  const clock = { now: Date.parse('2026-10-06T12:00:00Z') };
  const calls = [];
  const s = createStash({ dir, now: () => clock.now, log: () => {}, fetch: async () => null, quicklook: false, summaryDelayMs,
    summarise: summarise === undefined ? async (it) => { calls.push(it.text); return { summary: 'Sum: ' + it.text.split('\n')[0].slice(0, 30), by: 'test' }; } : summarise });
  return { dir, clock, s, calls };
}

test('which notes need a summary, and tidy keeps it to one short line', () => {
  assert.equal(needsSummary({ kind: 'note', text: 'Ring the venue' }), false, 'a short line is its own summary');
  assert.equal(needsSummary({ kind: 'note', text: 'one\ntwo' }), true);
  assert.equal(needsSummary({ kind: 'note', text: 'x'.repeat(91) }), true);
  assert.equal(needsSummary({ kind: 'quote', text: 'x'.repeat(200) }), false);
  assert.equal(needsSummary({ kind: 'quote', text: 'x'.repeat(300) }), true);
  assert.equal(needsSummary({ kind: 'image', text: 'x'.repeat(300) }), false);
  assert.equal(needsSummary({ kind: 'note', text: LONG, deleted: 1 }), false);
  assert.notEqual(summaryKey({ text: 'a' }), summaryKey({ text: 'b' }));
  assert.notEqual(summaryKey({ text: 'a' }), summaryKey({ text: 'a', title: 't' }), 'a new title is a new summary');
  assert.equal(tidy('Summary: "Email to Sam about Thursday."\nsecond line'), 'Email to Sam about Thursday');
  const long = tidy('word '.repeat(40));
  assert.ok(long.length <= 96 && long.endsWith('…'));
});

test('the summariser engine is a setting: claude with a model, a command, or off', async () => {
  const seen = [];
  const settings = { engine: 'claude', model: 'haiku' };
  const sum = createSummariser({ settings: () => settings, runClaude: async (o) => { seen.push(o.args); return { summary: 'Packing list for Lisbon.' }; }, run: async (o) => { seen.push(o.argv); return 'From jet\n'; } });
  assert.deepEqual(await sum.summarise({ kind: 'note', text: LONG }), { summary: 'Packing list for Lisbon', by: 'claude haiku' });
  assert.equal(seen[0][seen[0].indexOf('--model') + 1], 'haiku');
  assert.equal(seen[0][seen[0].indexOf('--tools') + 1], '', 'no tools for the model');
  Object.assign(settings, { engine: 'command', command: ['/opt/jet', '--fast'] });
  assert.deepEqual(await sum.summarise({ kind: 'note', text: LONG }), { summary: 'From jet', by: 'command /opt/jet' });
  assert.deepEqual(seen[1], ['/opt/jet', '--fast']);
  settings.engine = 'off';
  assert.equal(await sum.summarise({ kind: 'note', text: LONG }), null);
});

test('notes get a summary on save, a new one after an edit, none when short; the backfill catches old ones', async () => {
  const { s, calls, dir } = await setup();
  const short = (await s.addText({ text: 'Ring the venue' })).item;
  const long = (await s.addText({ text: LONG })).item;
  await s.settle();
  assert.equal((await s.get(long.id)).summary, 'Sum: Hi Daniel,');
  assert.equal((await s.get(short.id)).summary, undefined);
  assert.equal(calls.length, 1);
  await s.patch(long.id, { note: 'just a note on it' });
  await s.settle();
  assert.equal(calls.length, 1, 'a note on it is not the words');
  await s.patch(long.id, { text: 'Shopping\nmilk, eggs' });
  await s.settle();
  assert.equal((await s.get(long.id)).summary, 'Sum: Shopping');
  await s.patch(long.id, { text: 'milk' });
  await s.settle();
  assert.equal((await s.get(long.id)).summary, undefined, 'short again, so the old line goes');
  // Owner writes his own line; it stands.
  await s.patch(long.id, { text: LONG });
  await s.settle();
  await s.patch(long.id, { summary: 'My own words' });
  await s.settle();
  assert.equal((await s.get(long.id)).summary, 'My own words');
  assert.equal(calls.length, 3);
  // Search finds a note by its summary.
  assert.equal((await s.list({ q: 'own words' })).items[0].id, long.id);
  // Backfill: an index written before summaries existed.
  const idx = path.join(dir, 'items.json');
  const raw = JSON.parse(await fsp.readFile(idx, 'utf8'));
  for (const it of raw.items) { delete it.summary; delete it.summaryKey; }
  await fsp.writeFile(idx, JSON.stringify(raw));
  const fresh = []; const again = createStash({ dir, log: () => {}, fetch: async () => null, quicklook: false, summarise: async (it) => { fresh.push(it.text); return { summary: 'Backfilled', by: 'test' }; } });
  await again.load(); await again.settle();
  assert.deepEqual(fresh, [LONG]);
  assert.equal((await again.get(long.id)).summary, 'Backfilled');
});

test('edits wait for typing to stop; a failed summary is not retried until the words change', async () => {
  let fail = true; let n = 0;
  const { s } = await setup({ summaryDelayMs: 400, summarise: async () => { n++; if (fail) throw new Error('model down'); return { summary: 'OK', by: 't' }; } });
  const it = (await s.addText({ text: LONG })).item;
  await s.settle();
  assert.equal(n, 1);
  await s.patch(it.id, { pinned: true });
  await s.settle();
  assert.equal(n, 1, 'no retry for the same words');
  fail = false;
  await s.patch(it.id, { text: LONG + '\nmore' });
  await s.patch(it.id, { text: LONG + '\nmore words' });
  assert.equal(n, 1, 'not yet: still typing');
  await new Promise((r) => setTimeout(r, 450));
  await s.settle();
  assert.equal(n, 2, 'one run for the burst');
  assert.equal((await s.get(it.id)).summary, 'OK');
});

test('kept marks a thing as sorted, and can be taken off again', async () => {
  const { s } = await setup({ summarise: null });
  const it = (await s.addText({ text: 'Keep me' })).item;
  assert.equal((await s.patch(it.id, { kept: true })).item.kept, Date.parse('2026-10-06T12:00:00Z'));
  assert.equal((await s.patch(it.id, { kept: false })).item.kept, undefined);
});

test('redact blanks card numbers, sort codes and IBANs but leaves dates and phone numbers', () => {
  assert.equal(redact('card 4111 1111 1111 1111 exp'), 'card [card number hidden] exp');
  assert.equal(redact('sort code 20-00-00 acc'), 'sort code [sort code hidden] acc');
  assert.equal(redact('GB29 NWBK 6016 1331 9268 19'), '[IBAN hidden]');
  assert.equal(redact('on 2026-10-06 call 07700 900123'), 'on 2026-10-06 call 07700 900123');
  assert.equal(redact('order 1234 5678 9012 3456'), 'order 1234 5678 9012 3456', 'not a real card number');
});

test('agent tools: search, get with the picture, spaces; private things and deleted ones stay hidden', async () => {
  const { s, dir } = await setup();
  const ref = (await s.addText({ text: 'Editorial posters with huge type\nSwiss grid, red accents', spaces: ['Design inspiration'] })).item;
  const secret = (await s.addText({ text: 'Bank details: 20-00-00 12345678', spaces: ['private'] })).item;
  const gone = (await s.addText({ text: 'Old posters I binned' })).item;
  await s.remove(gone.id);
  const card = (await s.addText({ text: 'Card 4111111111111111 for the posters order' })).item;
  await s.settle();
  // A picture: give the poster a thumbnail on disk.
  await fsp.writeFile(path.join(dir, 'thumbs', ref.id + '.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'items.json'), 'utf8'));
  raw.items.find((x) => x.id === ref.id).thumb = true;
  await fsp.writeFile(path.join(dir, 'items.json'), JSON.stringify(raw));
  const s2 = createStash({ dir, log: () => {}, fetch: async () => null, quicklook: false });
  const tools = createStashTools(s2, { base: () => 'https://home.example.ts.net' });
  const call = async (name, args, by = 'Claude') => (await mcpMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, by)).result;

  const found = (await call('stash_search', { query: 'posters' })).structuredContent;
  assert.deepEqual(found.items.map((i) => i.id).sort(), [ref.id, card.id].sort(), 'not the private one, not the deleted one');
  const r = found.items.find((i) => i.id === ref.id);
  assert.deepEqual(r.spaces, ['Design inspiration']);
  assert.equal(r.open, `https://home.example.ts.net/command#stash/${ref.id}`);
  assert.equal(r.thumbnail, `https://home.example.ts.net/api/stash/${ref.id}/thumb`);
  assert.match(found.items.find((i) => i.id === card.id).excerpt, /\[card number hidden\]/);
  assert.equal((await call('stash_search', { space: 'design inspiration' })).structuredContent.total, 1);
  assert.equal((await call('stash_search', { query: 'bank' })).structuredContent.total, 0);
  assert.equal((await call('stash_search', { since: '2026-10-07' })).structuredContent.total, 0);
  assert.equal((await call('stash_search', { since: 'soon' })).isError, true);

  const got = await call('stash_get', { id: ref.id });
  assert.equal(got.structuredContent.text, 'Editorial posters with huge type\nSwiss grid, red accents');
  assert.equal(got.structuredContent._images, undefined, 'the bytes are not in the JSON');
  assert.deepEqual(got.content[1], { type: 'image', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), mimeType: 'image/jpeg' });
  assert.equal((await call('stash_get', { id: ref.id, image: false })).content.length, 1);
  assert.equal((await call('stash_get', { id: secret.id })).isError, true, 'private');
  assert.equal((await call('stash_get', { id: gone.id })).isError, true, 'deleted');

  const spaces = (await call('stash_spaces', {})).structuredContent;
  assert.deepEqual(spaces.spaces, [{ name: 'Design inspiration', items: 1 }], 'the private space is not listed');
  assert.equal(spaces.total, 2);
});

test('note_add saves a note from the agent, with spaces, and has an hourly limit', async () => {
  const { s } = await setup({ summarise: null });
  const tools = createStashTools(s, { base: () => '' });
  const call = async (args) => (await mcpMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'note_add', arguments: args } }, 'Dot')).result;
  const r = (await call({ text: 'Try a serif for the uni poster', spaces: ['#uni', 'idea'] })).structuredContent;
  const it = await s.get(r.saved);
  assert.equal(it.kind, 'note');
  assert.equal(it.source, 'agent');
  assert.equal(it.agent, 'Dot');
  assert.deepEqual(it.spaces, ['uni', 'idea']);
  assert.equal((await call({ text: '  ' })).isError, true);
  for (let i = 0; i < 29; i++) await call({ text: 'note ' + i });
  const over = await call({ text: 'one too many' });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /30 notes in the last hour/);
});

test('capture lands in Stash as a note, undo deletes it within 30 minutes, and the vault switch still works', async () => {
  const { s, clock, dir } = await setup({ summarise: null });
  let to = 'stash';
  const c = createCapture({ inbox: path.join(dir, 'Inbox'), trashDir: path.join(dir, 'trash'), now: () => clock.now, stash: () => s, to: () => to });
  const r = await c.capture('  Idea: a widget for deadlines  ');
  assert.equal(r.where, 'stash');
  assert.equal(r.label, 'Saved to Stash');
  const it = await s.get(r.id);
  assert.equal(it.kind, 'note');
  assert.equal(it.source, 'capture');
  assert.equal(it.text, 'Idea: a widget for deadlines');
  await assert.rejects(fsp.readdir(path.join(dir, 'Inbox')), 'nothing written to the vault');
  clock.now += 10 * 60000;
  assert.deepEqual(await c.undo(r.id), { ok: true, id: r.id, trashed: 'stash' });
  assert.ok((await s.get(r.id)).deleted, 'in the 30-day trash, not gone');
  await assert.rejects(c.undo(r.id), (e) => e.statusCode === 404);
  const late = await c.capture('Later thought');
  clock.now += 31 * 60000;
  await assert.rejects(c.undo(late.id), (e) => e.statusCode === 409);
  const mine = (await s.addText({ text: 'Typed on the Stash tab' })).item;
  await assert.rejects(c.undo(mine.id), (e) => e.statusCode === 409 && /not a quick capture/.test(e.message));
  // Switched back: a file in the vault Inbox, as before.
  to = 'vault';
  const v = await c.capture('Back to the vault');
  assert.equal(v.where, 'vault');
  assert.match(await fsp.readFile(v.file, 'utf8'), /Back to the vault/);
  assert.equal((await c.undo(v.id)).ok, true);
});

test('MCP replies carry a tool\'s pictures as image content and leave other tools alone', async () => {
  const tools = [
    { name: 'pic', inputSchema: {}, async run() { return { a: 1, _images: [{ data: 'AAAA', mimeType: 'image/jpeg' }] }; } },
    { name: 'plain', inputSchema: {}, async run() { return { b: 2 }; } },
  ];
  const call = async (name) => (await mcpMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } })).result;
  const pic = await call('pic');
  assert.deepEqual(pic.structuredContent, { a: 1 });
  assert.deepEqual(pic.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
  const plain = await call('plain');
  assert.deepEqual(plain.content, [{ type: 'text', text: JSON.stringify({ b: 2 }, null, 2) }]);
});
