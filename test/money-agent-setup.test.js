'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setupPrivateAccess, withAgentAdminLock } = require('../money-agent-setup');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'money-private-setup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, meridianDir: path.join(root, 'meridian'), configDir: path.join(root, 'private'), tokenFactory: () => 'mock'.repeat(10) + 'abc' };
}
test('user helper stores mock token privately, emits no secret, preserves other grants and creates scoped launcher', async t => {
  const options = await fixture(t); const dir = path.join(options.meridianDir, 'data', 'money'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'agents.json'), JSON.stringify({ tokens: [{ name: 'legacy', h: 'a'.repeat(64) }], audit: [{ action: 'old' }] }));
  const result = await setupPrivateAccess(options); assert.ok(!JSON.stringify(result).includes(options.tokenFactory()));
  assert.equal((await fs.stat(options.configDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.tokenFile)).mode & 0o777, 0o600); assert.equal((await fs.stat(result.runnerFile)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(result.tokenFile, 'utf8')).trim(), options.tokenFactory());
  const launcher = await fs.readFile(result.runnerFile, 'utf8'); assert.ok(launcher.includes('MERIDIAN_MONEY_URL')); assert.ok(launcher.includes('codex-home.token')); assert.ok(!launcher.includes(options.tokenFactory()));
  const doc = JSON.parse(await fs.readFile(path.join(dir, 'agents.json'))); assert.equal(doc.tokens[0].name, 'legacy'); assert.deepEqual(doc.tokens[1].scopes, ['money.read', 'receivables.write']);
  assert.equal(doc.tokens[1].h, crypto.createHash('sha256').update(options.tokenFactory()).digest('hex')); assert.equal(doc.audit.length, 2); assert.ok(!JSON.stringify(doc).includes(options.tokenFactory()));
  assert.equal((await fs.stat(path.join(dir, 'agents.json'))).mode & 0o777, 0o600);
  await assert.rejects(setupPrivateAccess(options), /already has a grant/);
  assert.equal((await fs.readFile(result.tokenFile, 'utf8')).trim(), options.tokenFactory());
});
test('existing private files and unsafe directories refuse setup without any grant', async t => {
  const options = await fixture(t); await fs.mkdir(options.configDir, { mode: 0o700 }); const file = path.join(options.configDir, 'codex-home.token'); await fs.writeFile(file, 'EXISTING');
  await assert.rejects(setupPrivateAccess(options), /Refusing to overwrite/); assert.equal(await fs.readFile(file, 'utf8'), 'EXISTING');
  await fs.unlink(file); await fs.chmod(options.configDir, 0o755); await assert.rejects(setupPrivateAccess(options), /mode 700/);
  await assert.rejects(fs.stat(path.join(options.meridianDir, 'data', 'money', 'agents.json')), { code: 'ENOENT' });
});
test('malformed grants fail closed; concurrent setup is refused before credential generation', async t => {
  const options = await fixture(t); const dir = path.join(options.meridianDir, 'data', 'money'); await fs.mkdir(dir, { recursive: true });
  const grantFile = path.join(dir, 'agents.json'); await fs.writeFile(grantFile, 'broken'); await assert.rejects(setupPrivateAccess(options), /could not be read safely/); assert.equal(await fs.readFile(grantFile, 'utf8'), 'broken');
  await fs.unlink(grantFile);
  await withAgentAdminLock(dir, async () => { await assert.rejects(setupPrivateAccess({ ...options, tokenFactory: () => { throw new Error('must not generate'); } }), /Another Money access setup/); });
});
test('invalid mock token creates neither private files nor grant', async t => {
  const options = await fixture(t); await assert.rejects(setupPrivateAccess({ ...options, tokenFactory: () => 'bad' }), /Token creation failed/);
  assert.deepEqual(await fs.readdir(options.configDir), []);
  await assert.rejects(fs.stat(path.join(options.meridianDir, 'data', 'money', 'agents.json')), { code: 'ENOENT' });
});
