'use strict';

// "Add your calendar link" for testers (7 Oct 2026): a published Outlook,
// Google or iCloud calendar (.ics) read once into their sandbox. The address
// comes from someone on the internet and is fetched from the Home Mac, so it
// is kept on a short lead: HTTPS only, the big calendar hosts only, every
// address it resolves to must be public, redirects are re-checked, and the
// answer is capped in size and time. Nothing is kept but the next week's
// events, and the link itself is never stored.

const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const https = require('https');
const { Worker } = require('worker_threads');

const HOSTS = [/^outlook\.office365\.com$/, /^outlook\.office\.com$/, /^outlook\.live\.com$/, /^calendar\.google\.com$/, /^p\d{1,3}-caldav\.icloud\.com$/, /^p\d{1,3}-calendars\.icloud\.com$/];
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT = 12000;      // one request
const DEADLINE = 25000;     // the whole import: lookups, redirects, the body and reading it
const PARSE_MS = 5000;
const MAX_EVENTS = 5000;

// Addresses that aren't the public internet: this Mac, the LAN, the tailnet, link-local, multicast,
// and IPv4 written as IPv6. BlockList parses each form (expanded, compressed) the same way.
const PRIVATE = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, n, 'ipv4');
// IPv4 written as IPv6 (::ffff:127.0.0.1) is checked against the IPv4 list by BlockList itself.
for (const [a, n] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, n, 'ipv6');
function privateIp(ip) {
  const t = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!t) return true;
  try { return PRIVATE.check(ip, t); } catch { return true; }
}

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://')); } catch { throw Object.assign(new Error('that isn’t a web address'), { statusCode: 400 }); }
  if (u.protocol !== 'https:') throw Object.assign(new Error('the link has to start with https://'), { statusCode: 400 });
  if (u.port && u.port !== '443') throw Object.assign(new Error('that calendar address isn’t one this test can read'), { statusCode: 400 });
  if (!HOSTS.some((re) => re.test(u.hostname))) throw Object.assign(new Error('only Outlook, Google and iCloud calendar links work in this test'), { statusCode: 400 });
  return u;
}

// One GET, pinned to an address we checked, so DNS can't change between the check and the connection.
async function getOnce(u, run) {
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (run.dead) throw Object.assign(new Error('the calendar took too long'), { statusCode: 504 });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw Object.assign(new Error('that calendar address isn’t reachable from here'), { statusCode: 400 });
  const pinned = addrs[0];
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', servername: u.hostname, timeout: TIMEOUT,
      headers: { 'User-Agent': 'Meridian-test/1.0 (calendar import)', Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1' },
      lookup: (_h, _o, cb) => cb(null, pinned.address, pinned.family) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve({ redirect: new URL(res.headers.location, u).href }); return; }
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(`the calendar answered ${res.statusCode}; check the link is the published .ics one`), { statusCode: 400 })); return; }
      let size = 0; const chunks = []; let done = false;
      const cut = () => { if (!done) { done = true; reject(Object.assign(new Error('the calendar stopped part way; try again'), { statusCode: 502 })); } };
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); if (!done) { done = true; reject(Object.assign(new Error('that calendar is too big for this test'), { statusCode: 400 })); } return; } chunks.push(c); });
      res.on('end', () => { if (!done) { done = true; resolve({ text: Buffer.concat(chunks).toString('utf8') }); } });
      res.on('aborted', cut); res.on('error', cut); res.on('close', cut);
    });
    run.req = req;
    req.on('timeout', () => req.destroy(Object.assign(new Error('the calendar took too long to answer'), { statusCode: 504 })));
    req.on('error', reject);
    req.end();
  });
}

function parseOffThread(text, label, now, days, run) {
  return new Promise((resolve, reject) => {
    if (run.dead) return reject(Object.assign(new Error('the calendar took too long'), { statusCode: 504 }));
    const w = new Worker(path.join(__dirname, 'ics-worker.js'), { workerData: { text, label, now, days }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    run.worker = w;
    const t = setTimeout(() => { w.terminate(); reject(Object.assign(new Error('that calendar is too complicated to read here'), { statusCode: 400 })); }, PARSE_MS);
    w.once('message', (v) => { clearTimeout(t); w.terminate(); resolve(v); });
    w.once('error', () => { clearTimeout(t); reject(Object.assign(new Error('couldn’t read that calendar'), { statusCode: 400 })); });
  });
}

async function fetchOnce(raw, { now, days, label }, run) {
  let u = checkUrl(raw);
  for (let hop = 0; hop < 3; hop++) {
    if (run.dead) throw Object.assign(new Error('the calendar took too long'), { statusCode: 504 });
    const r = await getOnce(u, run);
    if (r.redirect) { u = checkUrl(r.redirect); continue; }
    if (!/BEGIN:VCALENDAR/.test(r.text.slice(0, 2000))) throw Object.assign(new Error('that link isn’t a calendar file (.ics)'), { statusCode: 400 });
    if ((r.text.match(/BEGIN:VEVENT/g) || []).length > MAX_EVENTS) throw Object.assign(new Error('that calendar is too big for this test'), { statusCode: 400 });
    return parseOffThread(r.text, label, now, days, run);
  }
  throw Object.assign(new Error('too many redirects'), { statusCode: 400 });
}

async function fetchCalendar(raw, { now = Date.now(), days = 7, label = 'Your calendar' } = {}) {
  // Past the deadline everything stops: the request in flight, the worker, and any redirect not yet followed.
  const run = { dead: false, req: null, worker: null };
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => {
    run.dead = true;
    try { run.req && run.req.destroy(); } catch { /* gone */ }
    try { run.worker && run.worker.terminate(); } catch { /* gone */ }
    reject(Object.assign(new Error('the calendar took too long'), { statusCode: 504 }));
  }, DEADLINE); });
  const work = fetchOnce(raw, { now, days, label }, run);
  work.catch(() => {});   // after the deadline its failure has nowhere to go
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

module.exports = { fetchCalendar, checkUrl, privateIp, HOSTS };
