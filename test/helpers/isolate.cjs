'use strict';
// A missing stub must fail before it reaches a contributor's files or services.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const repo = path.resolve(__dirname, '../..');
const realHome = os.userInfo().homedir;
// A Node child of a guarded test shares its parent's fixture root (and only the parent removes it).
const inheritedRoot = process.env.MERIDIAN_UNIT_ROOT;
const root = inheritedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-unit-'));
process.env.MERIDIAN_UNIT_ROOT = root;
const remove = fs.rmSync.bind(fs);
fs.mkdirSync(path.join(root, 'home'), { recursive: true });
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;
process.env.TZ = 'Europe/London';
if (!inheritedRoot) process.on('exit', () => remove(root, { recursive: true, force: true }));

function check(value, write = false) {
  if (typeof value === 'number' || value == null) return;
  const file = path.resolve(value instanceof URL ? require('node:url').fileURLToPath(value) : String(value));
  const relative = path.relative(repo, file);
  if ((file === realHome || file.startsWith(realHome + path.sep)) && file !== repo && !file.startsWith(repo + path.sep) && file !== root && !file.startsWith(root + path.sep)) throw new Error('Unit isolation: use the temporary home instead of personal files');
  if (/^(data|cache|logs)(\/|\\|$)/.test(relative) || relative === 'config.json') throw new Error('Unit isolation: use a fixture instead of application data');
  if (write && file !== root && !file.startsWith(root + path.sep)) throw new Error('Unit isolation: writes must stay in the temporary fixture directory');
}
const writes = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'chmod', 'utimes', 'truncate'];
const reads = ['exists', 'readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'readlink'];
for (const [obj, suffix] of [[fs, ''], [fs, 'Sync'], [fsp, '']]) {
  for (const name of [...reads, ...writes]) {
    const key = name + suffix, original = obj[key]; if (!original) continue;
    obj[key] = function (file, ...args) { check(file, writes.includes(name)); return original.call(this, file, ...args); };
  }
  for (const name of ['rename', 'copyFile']) {
    const key = name + suffix, original = obj[key]; if (!original) continue;
    obj[key] = function (from, to, ...args) { check(from, name === 'rename'); check(to, true); return original.call(this, from, to, ...args); };
  }
  const key = 'open' + suffix, original = obj[key];
  if (original) obj[key] = function (file, flags, ...args) { check(file, typeof flags === 'number' ? flags !== 0 : /[wa+]/.test(flags || 'r')); return original.call(this, file, flags, ...args); };
}
for (const [key, write] of [['createReadStream', false], ['createWriteStream', true]]) {
  const original = fs[key]; fs[key] = function (file, ...args) { check(file, write); return original.call(this, file, ...args); };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const raw = args[0], o = Array.isArray(raw) ? raw[0] : raw;
  const port = typeof o === 'object' ? Number(o.port) : Number(o);
  const host = typeof o === 'object' ? o.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (port === 4980 || (host && !['localhost', '127.0.0.1', '::1'].includes(host))) throw new Error('Unit isolation: only local fixture servers are allowed');
  return connect.apply(this, args);
};
for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = cp[key];
  cp[key] = function (bin, ...args) {
    const permitted = bin === process.execPath || ['/usr/bin/false', '/usr/bin/python3', 'python3', '/usr/bin/diff'].includes(bin) || String(bin).startsWith(root + path.sep) && String(bin).endsWith('/missing-chrome');
    if (!permitted || key === 'exec' || key === 'execSync') throw new Error('Unit isolation: external command needs a stub');
    // A Node child runs under the same guard, even when the test passes its own environment.
    if (bin === process.execPath) {
      if (!Array.isArray(args[0])) args.unshift([]);
      args[0] = ['--require', __filename, ...args[0]];
      const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
      if (at > 0 && args[at].env) args[at] = { ...args[at], env: { ...args[at].env, MERIDIAN_UNIT_ROOT: root } };
    }
    return original.call(this, bin, ...args);
  };
}
