#!/usr/bin/env node
'use strict';
// Serve a contributor's front end without allowing browser writes upstream.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(arg('--root', path.join(__dirname, '../../public')));
const port = Number(arg('--port', '5160'));
const upstream = new URL(arg('--upstream', 'http://127.0.0.1:4980'));
if (upstream.protocol !== 'http:' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use an HTTP upstream and a valid local port');
const latency = Number(arg('--latency', '0'));
const pages = { '/': 'brief-dia.html', '/command': 'command.html', '/dashboard': 'command.html', '/dashboard-classic': 'dashboard.html', '/phone': 'phone.html', '/dashboard/phone': 'phone.html', '/tell': 'phone.html', '/draft': 'draft.html', '/drafts': 'drafts.html', '/stash-sort': 'stash-sort.html', '/connect': 'connect.html', '/quick': 'quick.html', '/story/': 'story/index.html' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"dev proxy is read-only"}'); return; }
  const u = new URL(req.url, 'http://fixture');
  let decoded;
  try { decoded = decodeURIComponent(u.pathname); } catch { res.writeHead(400); res.end(); return; }
  const file = path.resolve(root, pages[decoded] || '.' + decoded);
  if ((file === root || file.startsWith(root + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
  }
  const forward = () => {
    if (res.destroyed) return;
    const headers = { ...req.headers, host: upstream.host }; delete headers.origin; delete headers.referer;
    const call = http.request(upstream, { path: req.url, method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    call.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"dev upstream unavailable"}'); });
    res.on('close', () => call.destroy()); call.end();
  };
  if (latency > 0) setTimeout(forward, latency); else forward();
});
server.listen(port, '127.0.0.1', () => console.log(`Read-only preview: http://127.0.0.1:${port}/command?lab`));
