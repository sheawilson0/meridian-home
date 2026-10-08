#!/usr/bin/env node
'use strict';

// Dev only. Real pages and a guarded daemon, with fictional records and no network.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startSandbox, NOW, DRAFT_ID, repo } = require('../../test/helpers/sandbox-server.cjs');

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TABS = ['home', 'shelf', 'stash', 'usage', 'money', 'dogfood', 'journal', 'system', 'brief'];
const CUSTOM = ['look', 'home', 'side', 'spaces', 'more'];
let interrupted = false;
const shots = [];
const add = (name, route, ready, action, viewport = DESKTOP) => shots.push({ name, route, ready, action, viewport });
for (const tab of TABS) add('command-' + tab, '/command#' + tab, '#v-' + tab, async page => {
  await page.locator(`#tabs [data-tab="${tab}"]`).click();
  await page.waitForFunction(id => document.querySelector('#tabs [data-tab="' + id + '"]')?.getAttribute('aria-current') === 'page', tab);
});
add('command-settings', '/command', '#v-home', async page => { await page.locator('#foot-cog').click(); await page.locator('#setpop.on').waitFor(); });
for (const tab of CUSTOM) add('command-customise-' + tab, '/command', '#v-home', async page => {
  await page.locator('#foot-cog').click(); await page.locator('#set-body .set-tile').first().click();
  await page.locator('#custom.on').waitFor(); await page.locator('#custom-tabs [data-ctab="' + tab + '"]').click();
  await page.locator('#custom-body').waitFor();
});
add('command-palette', '/command', '#v-home', async page => { await page.keyboard.press('Meta+k'); await page.locator('#pal.on').waitFor(); });
add('command-capture', '/command', '#v-home', async page => { await page.keyboard.press('>'); await page.locator('#pal.on').waitFor(); });
add('command-add-link', '/command#shelf', '#v-shelf', async page => { await page.keyboard.press('n'); await page.locator('#sheet-link.on').waitFor(); });
add('command-log-fix', '/command', '#v-home', async page => { await page.keyboard.press('f'); await page.locator('#sheet-fix.on').waitFor(); });
add('command-shortcuts', '/command', '#v-home', async page => { await page.keyboard.press('?'); await page.locator('#sheet-keys.on').waitFor(); });
add('command-add-stash', '/command#stash', '#st-grid', async page => { await page.locator('#st-add').click(); await page.locator('#sheet-stash.on').waitFor(); });
add('command-stash-detail', '/command#stash', '#st-grid', async page => { await page.locator('#st-grid .st-card').first().click(); await page.locator('#st-detail.on').waitFor(); });
add('command-demo-home', '/command?demo=1', '#v-home');
add('phone-today', '/phone', '#s-today', undefined, PHONE);
add('phone-tell', '/phone', '#s-today', async page => { await page.locator('#tell-open').click(); await page.locator('#sh-tell.on').waitFor(); }, PHONE);
add('phone-drawer', '/phone', '#s-today', async page => { await page.locator('[data-sheet="sh-menu"]').click(); await page.locator('#sh-menu.on').waitFor(); }, PHONE);
add('phone-command-drawer', '/command', '#v-home', async page => { await page.locator('#side-show').click(); await page.waitForFunction(() => document.body.classList.contains('drawer-open')); }, PHONE);
for (const [name, route, ready] of [['draft', '/draft?id=' + DRAFT_ID, '#f-body'], ['drafts', '/drafts', '#out a.item'], ['stash-sort', '/stash-sort', '#deck .card']]) {
  add(name + '-desktop', route, ready);
  add(name + '-phone', route, ready, undefined, PHONE);
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') result.help = true;
    else if (['--output', '--compare'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) result[key.slice(2)] = path.resolve(args[++i]);
    else throw new Error('Unknown or incomplete option: ' + key);
  }
  result.output ||= path.join(os.tmpdir(), 'meridian-visual-' + Date.now());
  if (result.compare === result.output) throw new Error('Baseline and output directories must differ');
  return result;
}

async function settle(page) {
  for (const frame of page.frames()) {
    await frame.evaluate(async () => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            await document.fonts.ready;
            const visible = [...document.images].filter(img => { const r = img.getBoundingClientRect(); return r.width && r.height && r.top < innerHeight && r.bottom > 0; });
            // Lazy images outside the viewport must not hold a capture open.
            await Promise.all(visible.map(img => img.decode().catch(() => {})));
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Visible assets did not settle')), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
    });
  }
  await page.waitForTimeout(200);
}

async function pixels(page, left, right) {
  return page.evaluate(async sources => {
    const decode = src => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('Invalid comparison PNG')); img.src = src; });
    const [a, b] = await Promise.all(sources.map(decode));
    if (a.width !== b.width || a.height !== b.height) return { status: 'size-changed', baseline: [a.width, a.height], current: [b.width, b.height] };
    const data = image => { const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; };
    const x = data(a), y = data(b); let changed = 0, absolute = 0;
    for (let i = 0; i < x.length; i += 4) {
      let different = false;
      for (let channel = 0; channel < 4; channel++) { const diff = Math.abs(x[i + channel] - y[i + channel]); absolute += diff; different ||= diff !== 0; }
      if (different) changed++;
    }
    return { status: changed ? 'different' : 'equal', changedPixels: changed, totalPixels: a.width * a.height,
      percent: changed * 100 / (a.width * a.height), meanChannelDifference: absolute / x.length };
  }, ['data:image/png;base64,' + left.toString('base64'), 'data:image/png;base64,' + right.toString('base64')]);
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/dev/visual-baseline.cjs --output <dir> [--compare <baseline-dir>]\nSet PLAYWRIGHT_CORE_PATH to a dev-only playwright-core installation. Captures ' + shots.length + ' WebKit shots.');
    return;
  }
  let pw;
  try { pw = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    console.log('SKIP: Playwright is not installed. Set PLAYWRIGHT_CORE_PATH to a dev-only installation.'); return;
  }
  let browser;
  // Own signal cleanup: Playwright's default SIGINT handler exits the process
  // before our daemon/root teardown can finish.
  try { browser = await pw.webkit.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); }
  catch (error) {
    if (!/Executable doesn't exist|browserType.launch:.*not found/.test(error.message)) throw error;
    console.log('SKIP: WebKit is not installed in the dev tooling browser cache.'); return;
  }
  let sandbox;
  const interrupt = () => { interrupted = true; void browser.close().catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const start = performance.now();
  const manifest = { version: 1, browser: 'webkit', browserVersion: browser.version(), platform: process.platform,
    frozenAt: new Date(NOW).toISOString(), timezone: 'Europe/London', locale: 'en-GB', reducedMotion: 'reduce',
    deviceScaleFactor: 1, fixture: 'demo-derived-disk-v1', shots: [] };
  try {
    const previous = opts.compare ? JSON.parse(await fs.readFile(path.join(opts.compare, 'manifest.json'), 'utf8')) : null;
    if (previous) {
      for (const key of ['version', 'browser', 'browserVersion', 'platform', 'frozenAt', 'timezone', 'locale', 'reducedMotion', 'deviceScaleFactor', 'fixture']) {
        if (previous[key] !== manifest[key]) throw new Error('Baseline environment differs: ' + key);
      }
    }
    await fs.mkdir(opts.output, { recursive: true });
    // Refuse to overwrite another run's evidence.
    if ((await fs.readdir(opts.output)).length) throw new Error('Output directory must be empty: ' + opts.output);
    sandbox = await startSandbox();
    const base = new URL(sandbox.base);
    for (const shot of shots) {
      if (interrupted) throw new Error('Capture interrupted');
      const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 1, locale: 'en-GB',
        timezoneId: 'Europe/London', reducedMotion: 'reduce', colorScheme: 'dark', serviceWorkers: 'block', hasTouch: shot.viewport === PHONE });
      const record = { name: shot.name, file: shot.name + '.png', viewport: shot.viewport, status: 'pass', errors: [], blockedWrites: [], blockedExternal: [] };
      try {
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.origin !== base.origin) { record.blockedExternal.push(url.origin); return route.abort('blockedbyclient'); }
          if (!['GET', 'HEAD'].includes(req.method())) {
            record.blockedWrites.push({ method: req.method(), path: url.pathname });
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"visual fixture is read-only"}' });
          }
          if (req.isNavigationRequest() && !url.searchParams.has('lab')) { url.searchParams.set('lab', '1'); return route.continue({ url: url.href }); }
          return route.continue();
        });
        await context.addInitScript(({ now }) => {
          const RealDate = Date;
          window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
          window.__visualRejections = [];
          addEventListener('unhandledrejection', event => window.__visualRejections.push(String(event.reason?.message || event.reason)));
        }, { now: NOW });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => record.errors.push(error.message));
        const url = new URL(shot.route, base); url.searchParams.set('lab', '1');
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        // A visible mount alone can still contain its loading placeholder.
        if (url.pathname === '/command') await page.waitForFunction(() => typeof state !== 'undefined' && !!state?.at);
        if (url.pathname === '/phone') await page.waitForFunction(() => typeof S !== 'undefined' && !!S?.at);
        await page.locator(shot.ready).first().waitFor();
        if (shot.action) await shot.action(page);
        if (shot.name === 'command-brief') {
          const frame = page.locator('#v-brief iframe'); await frame.waitFor();
          await page.waitForFunction(() => document.querySelector('#v-brief iframe')?.contentDocument?.readyState === 'complete');
        }
        await settle(page);
        record.errors.push(...await page.evaluate(() => window.__visualRejections));
        if (record.errors.length || record.blockedWrites.length) throw new Error('Page error or unexpected write: ' + JSON.stringify({ errors: record.errors, writes: record.blockedWrites }));
        record.url = new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash;
        record.state = await page.evaluate(() => {
          const el = document.activeElement;
          return { focus: { id: el?.id || '', tag: el?.tagName || '', selectionStart: el?.selectionStart ?? null, selectionEnd: el?.selectionEnd ?? null },
            scroll: { x: scrollX, y: scrollY, page: document.querySelector('#page')?.scrollTop ?? null },
            hash: location.hash, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
        });
        const png = await page.screenshot({ path: path.join(opts.output, record.file), animations: 'disabled', caret: 'hide' });
        record.sha256 = crypto.createHash('sha256').update(png).digest('hex');
        if (previous) {
          const match = previous.shots.find(row => row.name === shot.name);
          if (!match || match.status !== 'pass') record.comparison = { status: 'missing-baseline' };
          else {
            if (!/^[a-z0-9-]+\.png$/.test(match.file)) throw new Error('Invalid baseline shot filename');
            const left = await fs.readFile(path.join(opts.compare, match.file));
            const comparePage = await context.newPage();
            try { record.comparison = await pixels(comparePage, left, png); } finally { await comparePage.close(); }
          }
          console.log(`${record.name}: ${record.comparison.status}, ${record.comparison.changedPixels ?? 'n/a'} pixels (${(record.comparison.percent ?? 0).toFixed(4)}%)`);
        } else console.log('CAPTURE ' + record.name);
      } catch (error) { record.status = 'fail'; record.failure = error.message; console.error('FAIL ' + record.name + ': ' + error.message); }
      finally { await context.close(); }
      record.blockedExternal = [...new Set(record.blockedExternal)].sort();
      manifest.shots.push(record);
      await fs.writeFile(path.join(opts.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    manifest.removedShots = previous?.shots.filter(row => !shots.some(shot => shot.name === row.name)).map(row => row.name) || [];
    await sandbox.stop();
    const logs = sandbox.logs();
    manifest.sandbox = JSON.parse(logs.output.match(/SANDBOX_COUNTS (.+)/)?.[1] || 'null');
    if (!manifest.sandbox || Object.values(manifest.sandbox).some(count => count !== 0) || logs.errors) throw new Error('Sandbox reported an unexpected effect or request error');
    manifest.elapsedMs = Math.round(performance.now() - start);
    await fs.writeFile(path.join(opts.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const failures = manifest.shots.filter(row => row.status !== 'pass' || row.comparison && row.comparison.status !== 'equal').length + manifest.removedShots.length;
    console.log(`${manifest.shots.length} shots, ${failures} failures/differences, ${(manifest.elapsedMs / 1000).toFixed(2)} s. Output: ${opts.output}`);
    process.exitCode = failures ? 1 : 0;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try { if (sandbox) await sandbox.stop(); } finally { await browser.close(); }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = interrupted ? 130 : 1; });
