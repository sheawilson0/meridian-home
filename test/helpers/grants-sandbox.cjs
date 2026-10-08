'use strict';

// Admit grant/MCP fixture requests through jobs-off, while retaining process/network guards.
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../../runtime');
const root = process.env.MERIDIAN_UNIT_ROOT;
if (!runtime.SANDBOX || !process.env.NODE_TEST_CONTEXT || !root) throw new Error('Grant preload requires an isolated sandbox test');
for (const file of [runtime.DATA_DIR, runtime.CONFIG_FILE]) {
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Grant fixtures must stay in the unit root');
}
runtime.installGuards();
runtime.sandboxDelegations = {
  allows: req => ['POST', 'DELETE'].includes(req.method) && /^(?:\/mcp(?:\/[A-Za-z0-9_-]+)?|\/api\/mcp\/grants(?:\/[a-f0-9]{16})?)(?:\?|$)/.test(req.url),
};
