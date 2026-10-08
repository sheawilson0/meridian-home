'use strict';

const fsp = require('node:fs/promises');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

function summariseGraph(graph) {
  const realms = {};
  for (const node of graph.nodes || []) realms[node.realm] = (realms[node.realm] || 0) + 1;
  return {
    nodes: (graph.nodes || []).length,
    links: (graph.links || []).length,
    realms: Object.entries(realms).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
  };
}

// The graph can be tens of megabytes. Parse it away from requests and send
// back only the small summary, rather than cloning the graph between threads.
function readBrainSummary(file, { signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { file } });
    let answered = false;
    const stop = () => { void worker.terminate(); reject(new Error('brain summary budget exceeded')); };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    worker.once('exit', () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); });
    worker.once('message', (message) => {
      answered = true;
      if (message.error) reject(new Error(message.error));
      else resolve(message.value);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (!answered) reject(new Error('brain summary worker exited: ' + code)); });
  });
}

if (!isMainThread) {
  fsp.readFile(workerData.file, 'utf8').then(text => {
    parentPort.postMessage({ value: summariseGraph(JSON.parse(text)) });
  }).catch(error => parentPort.postMessage({ error: error.message }));
}

module.exports = { readBrainSummary, summariseGraph };
