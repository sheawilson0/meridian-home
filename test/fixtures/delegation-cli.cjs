'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [planFile, report, workdir] = process.argv.slice(2);
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(workdir)) throw new Error('wrong fixture workspace');
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (plan.ignoreTerm) process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', async () => {
  if (plan.reportBefore) fs.writeFileSync(report, 'Fixture report\n');
  if (plan.edit) fs.writeFileSync(path.join(workdir, 'example.txt'), 'After\n');
  fs.writeFileSync(report + '.ready', String(process.pid));
  if (plan.hold) {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(report + '.release') && Date.now() < deadline) await sleep(20);
  } else await sleep(plan.sleep || 50);
  if (plan.reportAfter) fs.writeFileSync(report, 'Fixture report\n');
  fs.writeFileSync(report + '.exiting', 'exiting');
  if (plan.signal) process.kill(process.pid, plan.signal);
  else process.exit(plan.code || 0);
});
