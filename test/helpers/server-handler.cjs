'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const draftsLib = require('../../drafts');
const { createGrants, bearer } = require('../../mcp-grants');
const { createStash } = require('../../stash');
const { createStashTools } = require('../../stash-tools');
const { freePort, NOW, TOKEN, MCP_TOKEN, repo } = require('./sandbox-server.cjs');

// The sandbox's 503 gate hides Origin/MCP. Evaluate the existing handler seam
// with real stores but no imports, collectors, job constructors or boot section.
// Replace these marker slices with exported helpers when S2/S3/S4 land.
async function startHandler(fixture, state, hooks = {}) {
  const source = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    if (a < 0 || b <= a) throw new Error('Missing server contract seam: ' + start);
    return source.slice(a, b);
  };
  const drafts = draftsLib.createDrafts({ file: path.join(fixture.data, 'drafts.json'), now: () => NOW });
  const refuse = () => { throw new Error('Contract fixture must not start an effect'); };
  const tools = draftsLib.createTools(drafts, { open: refuse, browse: refuse, addTodo: refuse, overview: refuse, ...hooks });
  tools.push(...createStashTools(createStash({ dir: path.join(fixture.data, 'stash') }), { base: () => '', hiddenSpaces: () => ['private'] }));
  const port = await freePort();
  const mcpGrants = createGrants({ dataDir: fixture.data });
  const context = vm.createContext({ http, crypto, zlib, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    state, stateSnapshot: null, console, JOBS_ENABLED: true, draftsLib, mcpGrants, bearer,
    runtime: { DEMO: false, portableProfile: () => false },
    CONFIG: { port, token: TOKEN, mcpToken: MCP_TOKEN, tailscale: { hostname: 'fixture.example.ts.net' } },
    tailnetCache: { info: null }, almanac: { handle: async () => false }, briefIcon: { handle: async () => false },
  });
  vm.runInContext([
    section('function serializedState(', '// A second daemon reads'),
    section('const sseClients =', 'const ART_CACHE_DIR'),
    section('function jsonBody(', 'function queueFile('),
    section('const server = http.createServer', '// ---------------------------------------------------------------- command centre helpers'),
    'this.server = server;',
  ].join('\n'), context);
  context.draftRoutes = draftsLib.createRoutes({ drafts, tools, jsonBody: context.jsonBody, sendJson: context.sendJson,
    open: refuse, token: TOKEN, mcpToken: MCP_TOKEN, grants: mcpGrants });
  await new Promise((resolve, reject) => { context.server.once('error', reject); context.server.listen(port, '127.0.0.1', resolve); });
  return { base: `http://127.0.0.1:${port}`, port, context, broadcast: (name, data) => context.broadcastEvent(name, data),
    stop: async () => { context.server.closeAllConnections(); await new Promise(resolve => context.server.close(resolve)); } };
}

module.exports = { startHandler };
