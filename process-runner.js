'use strict';

const { execFile } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const workContext = new AsyncLocalStorage();

function signalProcess(child, signal, { detached = false, kill = process.kill.bind(process), platform = process.platform } = {}) {
  if (!child?.pid) return;
  try { if (detached && platform !== 'win32') kill(-child.pid, signal); else child.kill(signal); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
}

// execFile's timeout sends TERM once. A wall-clock KILL also covers children
// that ignore TERM, including descendants in a detached process group.
function createProcessRunner({ execute = execFile, kill = process.kill.bind(process), timers = { setTimeout, clearTimeout }, platform = process.platform } = {}) {
  return function run(file, args, options = {}) {
    const { timeout = 8000, signal = workContext.getStore()?.signal, ...rest } = options;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('collector cancelled')); return; }
      let child, timer, settled = false;
      const stop = () => signalProcess(child, 'SIGKILL', { detached: true, kill, platform });
      const finish = (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout, stderr });
      };
      try {
        child = execute(file, args, { ...rest, detached: platform !== 'win32', timeout, killSignal: 'SIGKILL' }, finish);
        if (!settled) {
          timer = timers.setTimeout(stop, timeout);
          signal?.addEventListener('abort', stop, { once: true });
          if (signal?.aborted) stop();
        }
      } catch (e) { finish(e); }
    });
  };
}

// Keep single-flight ownership until close confirms the child has stopped.
function capProcess(child, { timeout, graceMs = 2000, detached = false, timers = { setTimeout, clearTimeout }, kill, platform, onTimeout = () => {} }) {
  let force, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signalProcess(child, 'SIGTERM', { detached, kill, platform });
    force = timers.setTimeout(() => signalProcess(child, 'SIGKILL', { detached, kill, platform }), graceMs);
    force.unref?.();
  };
  const timer = timers.setTimeout(() => { onTimeout(); stop(); }, timeout);
  timer.unref?.();
  child.once('close', () => { timers.clearTimeout(timer); timers.clearTimeout(force); });
  return stop;
}

module.exports = { createProcessRunner, execute: createProcessRunner(), capProcess, signalProcess, workContext };
