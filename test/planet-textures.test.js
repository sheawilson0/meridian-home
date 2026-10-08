'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loader() {
  const source = fs.readFileSync(path.join(__dirname, '../public/command.js'), 'utf8');
  const images = [], styles = new Map();
  class Image extends EventTarget {
    constructor() { super(); this.complete = false; this.naturalWidth = 0; images.push(this); }
    fail() { this.onerror?.(); }
    load() { this.complete = true; this.naturalWidth = 1024; this.dispatchEvent(new Event('load')); }
  }
  const context = vm.createContext({ Image, queueMicrotask, document: { documentElement: { style: { setProperty: (k, v) => styles.set(k, v) } } } });
  vm.runInContext(source.slice(source.indexOf('const planetImages='), source.indexOf('const PLANET_FS=')), context);
  return { load: context.planetTexture, images, styles };
}

test('WebP alone loads and serves both renderer and cached previews', async () => {
  const l = loader(), received = [];
  assert.match(l.load('earth', im => received.push(im)), /earth\.webp/);
  assert.equal(l.images[0].src, '/img/planets/earth.webp');
  l.images[0].load();
  l.load('earth', im => received.push(im));
  await new Promise(queueMicrotask);
  assert.equal(l.images.length, 1);
  assert.deepEqual(received, [l.images[0], l.images[0]]);
  assert.equal(l.styles.size, 0, 'no original requested on success');
});

test('failed WebP never requests excluded original maps', () => {
  for (const name of ['moon', 'saturn-ring']) {
    const l = loader();
    l.load(name);
    const im = l.images[0];
    im.fail();
    assert.equal(im.src, `/img/planets/${name}.webp`);
    assert.equal(im.onerror, null);
    assert.equal(l.styles.size, 0);
    assert.ok(fs.existsSync(path.join(__dirname, '../public/img/planets', name + '.webp')));
    assert.ok(!fs.existsSync(path.join(__dirname, '../public/img/planets', name + (name === 'saturn-ring' ? '.png' : '.jpg'))));
  }
});
