'use strict';
// User-run local administration only. Never exposed as an agent API/MCP tool.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJson } = require('./money');
async function withAgentAdminLock(dir, fn) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agents-admin.lock');
  let lock;
  try { lock = await fs.open(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another Money access setup is running, or an earlier setup was interrupted. No grant changed.'); throw e; }
  try { return await fn(); } finally { await lock.close(); await fs.unlink(file); }
}
async function readGrants(file) {
  try { const doc = JSON.parse(await fs.readFile(file, 'utf8')); if (!Array.isArray(doc.tokens)) throw new Error('invalid grant document'); return doc; }
  catch (e) { if (e.code === 'ENOENT') return { tokens: [] }; throw new Error('Money grants could not be read safely; nothing changed'); }
}
async function setupPrivateAccess({ meridianDir, configDir, baseUrl = 'http://127.0.0.1:4980', tokenFactory = () => crypto.randomBytes(32).toString('base64url') }) {
  const name = 'codex-home'; const scopes = ['money.read', 'receivables.write'];
  const moneyDir = path.join(meridianDir, 'data', 'money');
  return withAgentAdminLock(moneyDir, async () => {
    const grantFile = path.join(moneyDir, 'agents.json'); const doc = await readGrants(grantFile);
    if (doc.tokens.some(t => t.name === name)) throw new Error('codex-home already has a grant. Refusing to replace it; revoke it intentionally before setting up again.');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(configDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('The private setup directory must be owned by you and have mode 700');
    const tokenFile = path.join(configDir, 'codex-home.token'); const runnerFile = path.join(configDir, 'run.cjs');
    for (const file of [tokenFile, runnerFile]) { try { await fs.lstat(file); throw new Error('Private access files already exist. Refusing to overwrite them.'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    const token = tokenFactory();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Token creation failed');
    const runner = "'use strict';\nconst fs = require('node:fs');\nprocess.env.MERIDIAN_MONEY_URL = " + JSON.stringify(baseUrl) + ";\nprocess.env.MERIDIAN_MONEY_TOKEN = fs.readFileSync(" + JSON.stringify(tokenFile) + ", 'utf8').trim();\nrequire(" + JSON.stringify(path.join(meridianDir, 'scripts', 'money-mcp.js')) + ");\n";
    const created = [];
    try {
      // Rowan files for cleanup only after exclusive creation succeeds.
      for (const [file, data] of [[tokenFile, token + '\n'], [runnerFile, runner]]) {
        const handle = await fs.open(file, 'wx', 0o600); created.push(file);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      }
      const at = new Date().toISOString();
      doc.tokens.push({ name, scopes, h: crypto.createHash('sha256').update(token).digest('hex'), created: at });
      doc.audit = doc.audit || []; doc.audit.push({ at, action: 'grant', name, scopes, source: 'private-home-setup' });
      await writeJson(grantFile, doc);
    } catch (e) { for (const file of created) await fs.unlink(file).catch(() => {}); throw new Error('Private setup failed; check local filesystem permissions before retrying'); }
    return { name, scopes, runnerFile, tokenFile };
  });
}
module.exports = { withAgentAdminLock, setupPrivateAccess };
