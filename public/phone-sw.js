'use strict';
// Opt-in phone shell. Never cache an API response, token, draft or Stash file.
const PREFIX = 'meridian-phone-shell-';
const INDEX = PREFIX + 'index';
const FONTS = PREFIX + 'fonts';
const ACTIVE = '/__meridian-phone-shell__';
const PAGES = new Set(['/dashboard/phone', '/phone', '/tell']);
const FILES = ['/phone.html', '/phone.js', '/phone.css', '/themes/nothing-phone.css', '/feel.js', '/feel.css'];
let refreshing = null;
let disabled = false;
const controllers = new Set();

async function bounded(request, timeout = 8000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  controllers.add(controller);
  try {
    const response = await fetch(request, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Shell unavailable');
    // Include the body in the deadline, not just the response headers.
    const body = await response.arrayBuffer(), headers = new Headers(response.headers);
    headers.delete('Content-Encoding'); headers.delete('Content-Length');
    return new Response(body, { status: response.status, headers });
  } finally { clearTimeout(timer); controllers.delete(controller); }
}

async function active() {
  const index = await caches.open(INDEX), response = await index.match(ACTIVE);
  return response ? response.text() : null;
}

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (disabled) return null;
    const responses = await Promise.all(FILES.map((p) => bounded(p)));
    const texts = await Promise.all(responses.map((r) => r.clone().text()));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(texts)));
    const version = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
    const name = PREFIX + version, previous = await active();
    if (disabled) return null;
    if (previous === name) return name;
    const cache = await caches.open(name);
    // Pin every script and style to one complete snapshot, even during an update.
    const html = texts[0].replace(/(src|href)="([^"]+)"/g, (all, attr, url) => FILES.slice(1).includes(url) ? `${attr}="${url}?phone-shell=${version}"` : all);
    await Promise.all(FILES.map((p, i) => cache.put(p, i ? responses[i] : new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    if (disabled) return null;
    const index = await caches.open(INDEX);
    await index.put(ACTIVE, new Response(name));
    if (previous) {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) if (PAGES.has(new URL(client.url).pathname)) client.postMessage({ type: 'phone-shell-updated' });
    }
    return name;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

self.addEventListener('install', (event) => {
  event.waitUntil(refresh().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'phone-shell-disable') return;
  disabled = true;
  for (const controller of controllers) controller.abort();
  // Finish any writes before purging, so an in-flight refresh cannot refill it.
  event.waitUntil((refreshing || Promise.resolve()).catch(() => {}).then(() => caches.keys())
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX)).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (disabled || request.method !== 'GET') return;
  if (url.origin === self.location.origin) {
    // Everything outside this small shell, including all API reads, goes to the network.
    if (request.mode === 'navigate' && PAGES.has(url.pathname)) {
      event.respondWith((async () => {
        const name = await active();
        const cached = name && await (await caches.open(name)).match('/phone.html');
        if (cached) return cached;
        return fetch(request);
      })());
      if (url.searchParams.get('sw') !== 'off') event.waitUntil(refresh().catch(() => {}));
      return;
    }
    const version = url.searchParams.get('phone-shell');
    if (FILES.slice(1).includes(url.pathname) && /^[a-f0-9]{64}$/.test(version || '')) {
      event.respondWith((async () => {
        const response = await (await caches.open(PREFIX + version)).match(url.pathname);
        // Never substitute a different version of JS into an older HTML snapshot.
        return response || Response.error();
      })());
    }
    return;
  }
  // Fonts are public, immutable resources. Their failure must not block the shell.
  if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    event.respondWith((async () => {
      const client = event.clientId && await self.clients.get(event.clientId);
      if (!client || !PAGES.has(new URL(client.url).pathname)) return fetch(request);
      const cache = await caches.open(FONTS), cached = await cache.match(request);
      if (cached) return cached;
      try { const response = await bounded(request, 1200); await cache.put(request, response.clone()); return response; }
      catch { return url.hostname === 'fonts.googleapis.com' ? new Response('', { headers: { 'Content-Type': 'text/css' } }) : Response.error(); }
    })());
  }
});
