'use strict';
// This preload enables only fixture delegations, never normal boot or collectors.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const runtime = require('../../runtime');
const root = process.env.MERIDIAN_UNIT_ROOT;
if (!runtime.SANDBOX || !process.env.NODE_TEST_CONTEXT || !root) throw new Error('delegation preload requires an isolated sandbox test');
const fixture = path.dirname(runtime.DATA_DIR);
const inside = file => fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep);
if (!inside(runtime.DATA_DIR) || !inside(runtime.CONFIG_FILE) || !inside(fixture)) throw new Error('delegation fixtures must stay in the unit root');
const workdir = path.join(fixture, 'workspace');
if (!inside(workdir)) throw new Error('feedback workspace must be a fixture');
const spawn = cp.spawn, execFile = cp.execFile, nativeSpawn = cp.ChildProcess.prototype.spawn;
runtime.installGuards();
// The original unit guard still wraps both calls and is inherited by Node children.
function permitted(fn) {
  cp.ChildProcess.prototype.spawn = nativeSpawn;
  try { return fn(); } finally { cp.ChildProcess.prototype.spawn = () => { throw runtime.jobsOffError(); }; }
}
cp.execFile = (bin, args, ...rest) => {
  if (bin !== '/usr/bin/diff' || !args.slice(-2).every(file => file === '/dev/null' || inside(file))) throw runtime.jobsOffError();
  return permitted(() => execFile(bin, args, ...rest));
};
runtime.sandboxDelegations = {
  workdir,
  allows: req => req.method === 'POST' && /^(?:\/api\/todos\/[a-f0-9-]+\/delegate|\/api\/feedback|\/api\/refresh|\/api\/delegations\/[\w.-]+\/(?:cancel|undo|archive))$/.test(req.url),
  spawn(_bin, args, options) {
    const report = args[args.indexOf('-o') + 1];
    if (!report || !inside(path.dirname(report)) || !inside(options.cwd)) throw runtime.jobsOffError();
    return permitted(() => spawn(process.execPath, [path.join(__dirname, '../fixtures/delegation-cli.cjs'),
      path.join(fixture, 'plan.json'), report, options.cwd], options));
  },
};
