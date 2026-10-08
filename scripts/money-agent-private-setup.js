#!/usr/bin/env node
'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'));
const { setupPrivateAccess } = require('../money-agent-setup');
setupPrivateAccess({ baseUrl: config.money?.agentUrl, meridianDir: path.resolve(__dirname, '..'), configDir: path.join(os.homedir(), '.config', 'meridian-money') }).then(result => {
  console.log('Home Money access configured: money.read + receivables.write. No token is displayed.');
  console.log('Future authorized Home tasks: node ' + result.runnerFile + ' (JSON-RPC on stdin).');
  console.log('Revoke: node ' + path.resolve(__dirname, 'money-setup.js') + ' agent-revoke codex-home');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
