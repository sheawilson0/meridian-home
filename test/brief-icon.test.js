'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const moduleStub = { exports: {} };
// These pure checks do not need the private painting collection or Swift.
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../brief-icon.js'), 'utf8'), {
  module: moduleStub, __dirname: path.join(__dirname, '..'), Buffer, console, URL,
  require: name => name === './brief-art' ? { collection: [], readCurrent: () => null } : name === './runtime' ? require('../runtime') : require(name),
});
const briefIcon = moduleStub.exports;

const options = { port: 4980, hosts: ['studio.example.invalid'] };

test('recognises the brief on this daemon, and nothing else', () => {
  for (const url of ['https://studio.example.invalid/', 'https://studio.example.invalid/?t=x', 'http://127.0.0.1:4980/', 'http://localhost:4980/brief-dia.html']) {
    assert.equal(briefIcon.isBriefUrl(url, options), true, url);
  }
  for (const url of ['https://studio.example.invalid:11443/', 'https://studio.example.invalid/dashboard', 'http://127.0.0.1:4785/', 'https://github.com/', 'ftp://127.0.0.1:4980/', 'not a url']) {
    assert.equal(briefIcon.isBriefUrl(url, options), false, url);
  }
});

test('the SVG carries the decided colours, scrim and embedded crop', () => {
  const meta = { markColor: '#141416', dotColor: '#141416', scrim: 0.2, scrimColor: '#ffffff', geometry: { small: { box: 0.8, stroke: 2.4 }, scrimInner: 0.12, scrimOuter: 0.62 } };
  const svg = briefIcon.svgFor(meta, Buffer.from('jpeg'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/);
  assert.match(svg, /stroke="#141416" stroke-width="2.4"/);
  assert.match(svg, /href="data:image\/jpeg;base64,anBlZw=="/);
  assert.match(svg, /<radialGradient id="s"[^>]*><stop offset="0.000" stop-color="#ffffff" stop-opacity="0.200"\/>/);
  assert.doesNotMatch(briefIcon.svgFor({ ...meta, scrim: 0 }, Buffer.from('x')), /radialGradient/);
  // Anything odd in the metadata falls back to safe values rather than leaking into markup.
  assert.match(briefIcon.svgFor({ markColor: '"><script>', dotColor: null }, Buffer.from('x')), /stroke="#ffffff"[\s\S]*fill="#ffffff"/);
});

test('only its own routes are handled; bad sizes are refused', async () => {
  const call = (url, method = 'GET') => new Promise((resolve) => {
    const res = { headersSent: false, writeHead(status) { this.status = status; }, end() { resolve(this.status); } };
    briefIcon.handle({ method, headers: {} }, res, new URL(url, 'http://x')).then((handled) => { if (!handled) resolve('unhandled'); });
  });
  assert.equal(await call('/api/daily-art'), 'unhandled');
  assert.equal(await call('/brief-icon.png?size=64'), 400);
  assert.equal(await call('/brief-icon.svg', 'POST'), 405);
});
