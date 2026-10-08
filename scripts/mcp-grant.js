#!/usr/bin/env node
'use strict';

// Local administration also works while Meridian is stopped.
const path = require('node:path');
const { createGrants, parseScopes } = require('../mcp-grants');

function main(args) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!['name', 'scopes', 'expires', 'data-dir'].includes(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid option; use --name, --scopes, --expires or --data-dir');
    options[key] = args[++i];
  }
  const [command, id] = positional;
  if (!['create', 'list', 'revoke'].includes(command) || positional.length !== (command === 'revoke' ? 2 : 1) ||
    command !== 'create' && ['name', 'scopes', 'expires'].some(k => options[k] !== undefined)) throw new Error('Usage: mcp-grant.js create --name Dot --scopes read,draft-write [--expires 30d] [--data-dir DIR] | list | revoke <id>');
  const grants = createGrants({ dataDir: path.resolve(options['data-dir'] || process.env.MERIDIAN_DATA || path.join(__dirname, '../data')) });
  if (command === 'list') return { grants: grants.list() };
  if (command === 'revoke') return { grant: grants.revoke(id) };
  let expiresAt = null;
  if (options.expires) {
    const match = options.expires.match(/^([1-9]\d*)([mhd])$/);
    const ms = match && Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]];
    if (!ms || !Number.isFinite(ms) || Date.now() + ms > 8.64e15) throw new Error('--expires must be a duration such as 30m, 12h or 30d');
    expiresAt = new Date(Date.now() + ms).toISOString();
  }
  return grants.create({ name: options.name, scopes: parseScopes(options.scopes), expiresAt });
}

try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
catch (e) { console.error(e.statusCode || e.message.startsWith('Usage:') || e.message.startsWith('--expires') || e.message.startsWith('Invalid option') ? e.message : 'Grant operation failed; check the data directory and permissions'); process.exitCode = 1; }
