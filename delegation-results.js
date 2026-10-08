'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function resultStatus(meta, { hasReport, logM = 0, now = Date.now(), alive = false } = {}) {
  if (meta.status === 'cancelled') return 'cancelled';
  if (meta.finishedAt != null) return meta.result?.status || (meta.exitCode === 0 && !meta.signal && hasReport ? 'done' : 'failed');
  if (meta.lifecycleVersion) return meta.status === 'failed' ? 'failed' : alive || now - logM < 6 * 60000 ? 'running' : 'stalled';
  return hasReport ? 'done' : meta.status === 'failed' ? 'failed' : now - logM < 6 * 60000 ? 'running' : 'stalled';
}

function createResultRecorder({ now = Date.now, read = file => fsp.readFile(file, 'utf8'),
  exists = file => fsp.stat(file).then(() => true, () => false),
  write = async (file, value) => { const tmp = file + '.exit.tmp'; await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n'); await fsp.rename(tmp, file); },
  queue } = {}) {
  const pending = new Map();
  queue ||= (file, fn) => {
    const job = (pending.get(file) || Promise.resolve()).catch(() => {}).then(fn);
    pending.set(file, job);
    job.finally(() => { if (pending.get(file) === job) pending.delete(file); }).catch(() => {});
    return job;
  };
  return (dir, exitCode, signal, cause = null) => {
    const file = path.join(dir, 'meta.json'), finishedAt = now();
    return queue(file, async () => {
      const meta = JSON.parse(await read(file));
      if (meta.finishedAt != null) return meta;
      const hasReport = await exists(path.join(dir, 'REPORT.md'));
      const status = meta.status === 'cancelled' ? 'cancelled' : exitCode === 0 && !signal && hasReport ? 'done' : 'failed';
      const error = status === 'failed' ? String(cause?.message || cause || (signal ? `agent exited with ${signal}` : exitCode === 0 ? 'agent exited without writing REPORT.md' : `agent exited with code ${exitCode}`)).slice(0, 1000) : null;
      Object.assign(meta, { exitCode, signal: signal || null, finishedAt, status, error,
        result: { status, report: hasReport ? 'REPORT.md' : null, error } });
      await write(file, meta);
      return meta;
    });
  };
}

module.exports = { resultStatus, createResultRecorder };
