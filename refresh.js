'use strict';

const { workContext } = require('./process-runner');

// Requests arriving during a pass share its promise and queue one more pass.
function createRefresh(run) {
  let inFlight = null, dirty = false;
  return function refresh() {
    if (inFlight) { dirty = true; return inFlight; }
    inFlight = Promise.resolve().then(async () => {
      try {
        let value;
        do { dirty = false; value = await run(); } while (dirty);
        return value;
      } finally { inFlight = null; }
    });
    return inFlight;
  };
}

function createSources({ now = Date.now, timers = { setTimeout, clearTimeout }, onError = () => {} } = {}) {
  const records = new Map(), jobs = new Map(), good = new Map();
  const empty = () => ({ lastAttempt: null, lastSuccess: null, durationMs: null, error: null, stale: false });
  const message = e => String(e?.message || e).slice(0, 1000);
  function snapshot() { return Object.fromEntries([...records].map(([name, r]) => [name, { ...r }])); }
  function observe(name, record) { records.set(name, { ...empty(), ...record }); }

  async function collect(name, fn, { deadline = now() + 15000, fallback, retained = false, cached = false, describe = value => ({ error: value?.error?.message || value?.error || null, stale: value?.stale || false }) } = {}) {
    const previous = records.get(name) || empty();
    const failed = error => {
      const r = records.get(name) || previous;
      records.set(name, { ...r, error: message(error), stale: good.has(name) || retained });
      onError(name, error);
      return good.has(name) ? good.get(name) : fallback;
    };
    // An uncancellable job remains registered until it really settles. Later
    // passes report it immediately, rather than waiting on it again forever.
    const active = jobs.get(name);
    if (active?.timedOut) return failed(new Error('collector still running after budget exceeded'));
    const remaining = deadline - now();
    if (remaining <= 0) return failed(new Error('refresh budget exceeded before collector started'));
    let job = active;
    if (!job) {
      const controller = new AbortController();
      const context = { signal: controller.signal, errors: [] };
      job = { controller, context, started: now(), timedOut: false };
      records.set(name, cached ? previous : { ...previous, lastAttempt: job.started, durationMs: null, error: null });
      job.promise = Promise.resolve().then(() => workContext.run(context, fn));
      jobs.set(name, job);
      job.promise.finally(() => { if (jobs.get(name) === job) jobs.delete(name); }).catch(() => {});
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        job.timedOut = true;
        job.controller.abort();
        reject(new Error('collector budget exceeded'));
      }, remaining);
    });
    try {
      const value = await Promise.race([job.promise, timeout]);
      if (job.timedOut) throw new Error('collector budget exceeded');
      const details = describe(value);
      const error = details.error || job.context.errors.join('; ') || null;
      const r = records.get(name);
      if (!cached) records.set(name, { ...r, durationMs: Math.max(0, now() - job.started),
        lastSuccess: error ? r.lastSuccess : now(), error: error ? message(error) : null, stale: Boolean(details.stale || (error && good.has(name) && value === good.get(name))) });
      if (!error) good.set(name, value);
      return value;
    } catch (e) {
      records.set(name, { ...records.get(name), durationMs: Math.max(0, now() - job.started) });
      return failed(e);
    } finally { timers.clearTimeout(timer); }
  }
  return { collect, snapshot, observe };
}

module.exports = { createRefresh, createSources };
