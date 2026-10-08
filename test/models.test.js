'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createRegistry, suggestName } = require('../models');

async function tmp() { return fsp.mkdtemp(path.join(os.tmpdir(), 'meridian-models-')); }

function registry(dir, extra = {}) {
  return createRegistry({
    file: path.join(dir, 'models.json'),
    codexBin: null,
    codexCache: path.join(dir, 'models_cache.json'),
    scanCache: path.join(dir, 'scan.json'),
    logRoots: [[path.join(dir, 'claude'), 'claude'], [path.join(dir, 'codex'), 'codex']],
    ...extra,
  });
}

test('seeds the list and resolves ids, retired ids, legacy labels and run labels', async () => {
  const dir = await tmp();
  const r = registry(dir);
  assert.ok(r.current().models.some((m) => m.id === 'claude-sonnet-5-5'));
  assert.ok(fs.existsSync(path.join(dir, 'models.json')), 'models.json written on first read');

  assert.deepEqual([r.resolve('').id, r.resolve('').effort], ['gpt-6-luna', 'high']);
  assert.equal(r.resolve('gpt-6-sol').model, 'gpt-6.1-sol', 'retired id runs its replacement');
  assert.equal(r.resolve('gpt-6-sol').who, 'GPT-6.1 Sol · High');
  assert.deepEqual([r.resolve('GPT-6 Sol').model, r.resolve('GPT-6 Sol').effort], ['gpt-6.1-sol', 'medium']);
  assert.deepEqual([r.resolve('GPT-5.6 Sol light').model, r.resolve('GPT-5.6 Sol light').effort], ['gpt-6.1-sol', 'low']);
  assert.deepEqual([r.resolve('GPT-6 Luna · High').model, r.resolve('GPT-6 Luna · High').effort], ['gpt-6-luna', 'high']);
  assert.equal(r.resolve('GPT-6 Sol · X-high').model, 'gpt-6.1-sol');
  assert.equal(r.resolve('GPT-6 Sol · X-high').effort, 'xhigh');
  const sonnet = r.resolve('claude-sonnet-5-5', 'medium');
  assert.deepEqual([sonnet.kind, sonnet.model, sonnet.who], ['claude', 'claude-sonnet-5-5', 'Sonnet 5.5 · Medium']);
  assert.throws(() => r.resolve('gpt-9-nova'), /not on Meridian's model list/);
  assert.throws(() => r.resolve('gpt-6-luna', 'ultra'), /cannot run at ultra/);
});

test('engines() has the fixed shape, makers grouped and ranked', async () => {
  const dir = await tmp();
  const e = await registry(dir).engines();
  assert.deepEqual(Object.keys(e).slice(0, 5), ['models', 'presets', 'default', 'efforts', 'discovered']);
  assert.deepEqual(e.models.map((m) => m.id), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(e.default, { model: 'gpt-6-luna', effort: 'high' });
  assert.deepEqual(e.presets.map((p) => [p.label, p.model, p.effort]), [['Luna High', 'gpt-6-luna', 'high'], ['Sol Medium', 'gpt-6.1-sol', 'medium']]);
  assert.deepEqual(e.efforts[0], ['low', 'Low']);
  assert.deepEqual(e.discovered, []);
});

test('a hand edit of models.json takes effect without a restart', async () => {
  const dir = await tmp();
  const r = registry(dir);
  r.current();
  const file = path.join(dir, 'models.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.models.push({ id: 'gpt-6-terra', name: 'GPT-6 Terra', maker: 'OpenAI', efforts: ['low', 'high'], rank: 9 });
  fs.writeFileSync(file, JSON.stringify(doc));
  const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t);
  assert.equal(r.resolve('gpt-6-terra', 'low').kind, 'codex');
  assert.throws(() => r.resolve('gpt-6-terra', 'max'), /cannot run at max/);
});

test('adopt adds a model, and with replaces retires the old one everywhere', async () => {
  const dir = await tmp();
  const r = registry(dir);
  await assert.rejects(() => r.adopt({ id: 'gpt-6-luna', name: 'x', maker: 'OpenAI' }), /already on the list/);
  await assert.rejects(() => r.adopt({ id: 'gpt-6.2-luna', maker: 'Google' }), /maker must be/);
  await assert.rejects(() => r.adopt({ id: 'gpt-6.2-luna', maker: 'OpenAI', replaces: 'gpt-1' }), /not on the list/);

  const out = await r.adopt({ id: 'gpt-6.2-luna', name: 'GPT-6.2 Luna', maker: 'OpenAI', replaces: 'gpt-6-luna' });
  assert.deepEqual(out.retired, { 'gpt-6-luna': 'gpt-6.2-luna' });
  const e = await r.engines();
  assert.deepEqual(e.models.filter((m) => m.maker === 'OpenAI').map((m) => m.id), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-luna']);
  assert.deepEqual(e.default, { model: 'gpt-6.2-luna', effort: 'high' });
  assert.equal(e.presets[0].model, 'gpt-6.2-luna');
  assert.equal(r.resolve('gpt-6-luna').model, 'gpt-6.2-luna', 'old saved picks follow');
  assert.equal(r.resolve('GPT-6 Luna High').model, 'gpt-6.2-luna', 'legacy labels follow');
  assert.equal(r.resolve('').model, 'gpt-6.2-luna');

  await r.adopt({ id: 'claude-haiku-5', maker: 'Anthropic' });
  const haiku = (await r.engines()).models.find((m) => m.id === 'claude-haiku-5');
  assert.equal(haiku.name, 'Haiku 5');
  assert.equal(haiku.kind, 'claude');
  assert.equal(haiku.rank, 4);
  // Survives a fresh registry over the same file.
  assert.equal(registry(dir).resolve('gpt-6-sol').model, 'gpt-6.1-sol');
  assert.equal(registry(dir).resolve('gpt-6-luna').model, 'gpt-6.2-luna');
});

test('discover lists unknown ids from the Codex catalog and session logs, newest first', async () => {
  const dir = await tmp();
  const recent = Date.now() - 2 * 86400e3;
  const day = new Date(recent).toISOString().slice(0, 10);
  await fsp.writeFile(path.join(dir, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 0, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'gpt-6.2-luna', display_name: 'GPT-6.2-Luna', visibility: 'list', priority: 1, description: 'Newer fast model.', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 3 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 6 },
  ] }));
  // One Claude log the ledger has parsed, one it has not (sniffed directly).
  await fsp.mkdir(path.join(dir, 'claude', 'proj'), { recursive: true });
  const parsed = path.join(dir, 'claude', 'proj', 'a.jsonl');
  const fresh = path.join(dir, 'claude', 'proj', 'b.jsonl');
  await fsp.writeFile(parsed, '{}\n');
  await fsp.writeFile(fresh, [
    JSON.stringify({ type: 'user', message: { content: 'say "model":"claude-fake-9"' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-6' } }),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
  ].join('\n') + '\n');
  for (const f of [parsed, fresh]) fs.utimesSync(f, new Date(recent), new Date(recent));
  const st = fs.statSync(parsed);
  await fsp.writeFile(path.join(dir, 'scan.json'), JSON.stringify({ version: 3, files: {
    [parsed]: { provider: 'claude', size: st.size, mtime: st.mtimeMs, days: { [day]: [['claude-opus-5', null, 1, 0, 0, 1], ['claude', null, 1, 0, 0, 1]], '2020-01-01': [['claude-ancient-1', null, 1, 0, 0, 1]] } },
  } }));
  await fsp.mkdir(path.join(dir, 'codex', '2026'), { recursive: true });
  const cx = path.join(dir, 'codex', '2026', 'r.jsonl');
  await fsp.writeFile(cx, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.2-luna' } }) + '\n');

  const r = registry(dir);
  const { discovered } = await r.discover({ force: true });
  const ids = discovered.map((d) => d.id);
  assert.ok(!ids.includes('gpt-6.1-sol'), 'listed models are not discovered');
  assert.ok(!ids.includes('gpt-6-sol'), 'retired models are not discovered');
  assert.ok(!ids.includes('gpt-reserve'), 'hidden catalog entries are skipped');
  assert.ok(!ids.includes('claude'), 'parse fallbacks are not models');
  assert.ok(!ids.includes('claude-fake-9'), 'only real assistant model fields count');
  assert.ok(!ids.includes('claude-ancient-1'), 'outside the 14-day window');
  assert.ok(!ids.includes('<synthetic>'));

  const luna = discovered.find((d) => d.id === 'gpt-6.2-luna');
  assert.equal(luna.name, 'GPT-6.2 Luna');
  assert.equal(luna.older, false);
  assert.equal(luna.replaces, 'gpt-6-luna');
  assert.deepEqual(luna.efforts, ['low', 'high']);
  assert.deepEqual(luna.seen.map((s) => s.source).sort(), ['codex-catalog', 'codex-logs']);

  const sonnet6 = discovered.find((d) => d.id === 'claude-sonnet-6');
  assert.deepEqual([sonnet6.maker, sonnet6.kind, sonnet6.name, sonnet6.older, sonnet6.replaces], ['Anthropic', 'claude', 'Sonnet 6', false, 'claude-sonnet-5-5']);

  assert.equal(discovered.find((d) => d.id === 'claude-opus-5').older, true);
  assert.equal(discovered.find((d) => d.id === 'gpt-5.6-terra').older, true);
  assert.ok(ids.indexOf('gpt-5.6-terra') > ids.indexOf('gpt-6.2-luna'), 'older ones sort last');

  // Adopting uses the catalog's effort list and drops it from discovered.
  await r.adopt({ id: 'gpt-6.2-luna', name: 'GPT-6.2 Luna', maker: 'OpenAI', replaces: 'gpt-6-luna' });
  const e = await r.engines();
  assert.deepEqual(e.models.find((m) => m.id === 'gpt-6.2-luna').efforts, ['low', 'high']);
  assert.ok(!e.discovered.some((d) => d.id === 'gpt-6.2-luna'));
});

test('suggestName', () => {
  assert.equal(suggestName('gpt-6.1-sol', 'GPT-6.1-Sol'), 'GPT-6.1 Sol');
  assert.equal(suggestName('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(suggestName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(suggestName('gpt-6-astra'), 'GPT-6 Astra');
});
