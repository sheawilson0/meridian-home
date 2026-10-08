#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const base = new URL(arg('--base-url', process.env.MERIDIAN_TEST_URL || 'http://127.0.0.1:5160'));
const output = path.resolve(arg('--output', path.join(os.tmpdir(), 'meridian-e2e-' + Date.now())));
const fault = arg('--fault', 'none');
assert.ok(['none', 'api-500', 'disconnect'].includes(fault), 'unknown fault mode');
let pw;
try { pw = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core'); }
catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  console.log('SKIP: playwright-core is not installed. Set PLAYWRIGHT_CORE_PATH to a dev-only installation.');
  process.exit(0);
}
await fs.mkdir(output, { recursive: true });
const results = [];
let draftId;
try { const r = await fetch(new URL('/api/drafts?limit=200', base), { signal: AbortSignal.timeout(7000) }); if (r.ok) draftId = (await r.json()).drafts?.[0]?.id; } catch { /* page checks report unavailable APIs */ }
const requested = arg('--browser', 'chromium,webkit').split(',');
const widths = arg('--widths', '1280,390,375').split(',').map(Number);
const lab = (route) => { const u = new URL(route, base); u.searchParams.set('lab', '1'); return u.href; };
for (const engine of requested) {
  assert.ok(['chromium', 'webkit'].includes(engine), 'unknown browser');
  let browser;
  try { browser = await pw[engine].launch({ headless: true }); }
  catch (e) {
    if (/Executable doesn't exist|browserType.launch:.*not found/.test(e.message)) {
      results.push({ engine, status: 'skip', reason: 'Browser binary is not installed. Install it in the dev tooling directory.' });
      continue;
    }
    throw e;
  }
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 800 }, serviceWorkers: 'block' });
      const blockedWrites = [];
      let disconnected = false;
      let active;
      // Guard all frames and popups too. No action can write to the supplied server.
      await context.route('**/*', async (route) => {
        const req = route.request(); const u = new URL(req.url());
        if (!['GET', 'HEAD'].includes(req.method())) {
          blockedWrites.push({ method: req.method(), path: u.pathname });
          return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"smoke harness is read-only"}' });
        }
        if (req.isNavigationRequest()) {
          if (u.origin !== base.origin) return route.abort('blockedbyclient');
          if (!u.searchParams.has('lab')) {
            active?.errors.push({ type: 'lab-navigation', path: u.pathname });
            u.searchParams.set('lab', '1'); return route.continue({ url: u.href });
          }
        }
        if (u.origin === base.origin && u.pathname.startsWith('/api/')) {
          if (disconnected) return route.abort('connectionrefused');
          if (fault === 'api-500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"QA simulated outage"}' });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on('response', r => { if (r.status() >= 400) active?.errors.push({ type: 'http', status: r.status(), path: new URL(r.url()).pathname }); });
      page.on('pageerror', e => active?.errors.push({ type: 'pageerror', message: e.message }));
      page.on('console', msg => { if (msg.type() === 'error') active?.errors.push({ type: 'console', message: msg.text() }); });
      await context.addInitScript(() => {
        window.__qaSse = { opened: 0, errors: 0 };
        const Source = window.EventSource;
        window.EventSource = class extends Source { constructor(...args) { super(...args); this.addEventListener('open', () => window.__qaSse.opened++); this.addEventListener('error', () => window.__qaSse.errors++); } };
        window.__qaRejections = [];
        addEventListener('unhandledrejection', e => window.__qaRejections.push(String(e.reason?.message || e.reason)));
      });
      const check = async (name, action) => {
        const start = performance.now();
        active = { engine, width, fault, name, status: 'pass', errors: [] };
        try { await action(); }
        catch (e) { active.status = 'fail'; active.failure = e.message; }
        const rejection = await page.evaluate(() => window.__qaRejections || []).catch(() => []);
        active.errors.push(...rejection.map(message => ({ type: 'unhandledrejection', message })));
        await page.evaluate(() => { window.__qaRejections = []; }).catch(() => {});
        active.expectedNetworkErrors = fault === 'none' ? [] : active.errors.filter(e => e.type === 'http' || e.type === 'console' && /Failed to load resource/i.test(e.message));
        if (active.errors.some(e => !active.expectedNetworkErrors.includes(e))) active.status = 'fail';
        active.state = await page.evaluate(() => ({ sse: window.__qaSse, connection: document.getElementById('conntext')?.innerText, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth })).catch(() => ({}));
        active.ms = Math.round(performance.now() - start);
        active.screenshot = path.join(output, `${engine}-${width}-${fault}-${name.replace(/[^a-z0-9-]/gi, '-')}.png`);
        await page.screenshot({ path: active.screenshot }).catch(e => { active.screenshotError = e.message; });
        results.push(active); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n'); console.log(`${active.status.toUpperCase()} ${engine} ${width} ${name} ${active.ms}ms`);
        active = null;
      };
      const meaningful = async (selector = 'body') => {
        await page.waitForFunction(sel => {
          const el = document.querySelector(sel); const text = el?.innerText?.trim() || '';
          return text.length > 12 && !/^(Loading…|Opening your stash…)$/i.test(text);
        }, selector);
      };
      const overflow = async () => {
        const d = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(d.scroll <= d.width + 1, `horizontal overflow: ${d.scroll}px at ${d.width}px`);
      };
      try {
        await check('command-load', async () => {
          await page.goto(lab('/command'), { waitUntil: 'domcontentloaded' });
          await meaningful('#v-home'); await page.waitForTimeout(1200); await overflow();
        });
        if (fault === 'disconnect') await check('offline-cache-and-sse-reconnect', async () => {
          await page.waitForFunction(() => !!localStorage.getItem('meridian.cc.stash.state'), null, { timeout: 7000 });
          await context.setOffline(true); await page.waitForTimeout(300); await context.setOffline(false);
          disconnected = true;
          try {
            await page.reload({ waitUntil: 'domcontentloaded' }); await meaningful('#v-home');
            assert.ok(await page.evaluate(() => !!localStorage.getItem('meridian.cc.stash.state')), 'no cached state after a successful load');
            await page.waitForTimeout(600);
            assert.match(await page.locator('#conntext').innerText(), /offline|reconnecting/);
          } finally { disconnected = false; }
          await page.waitForFunction(() => window.__qaSse.opened > 0, null, { timeout: 20000 });
          await page.waitForFunction(() => /^live/.test(document.getElementById('conntext')?.innerText || ''), null, { timeout: 20000 });
        });
        if (fault === 'none') {
          const tabs = await page.locator('#tabs [data-tab]').evaluateAll(es => es.map(e => e.dataset.tab));
          for (const tab of tabs) await check(`tab-${tab}`, async () => {
            if (width < 500) await page.locator('#side-show').click();
            await page.locator(`#tabs [data-tab="${tab}"]`).click();
            if (width < 500) await page.waitForFunction(() => !document.body.classList.contains('drawer-open'));
            if (tab === 'brief') { await page.locator('#v-brief').waitFor(); assert.ok(await page.locator('#v-brief iframe').count() || (await page.locator('#v-brief').innerText()).includes('demo mode'), 'Brief did not render'); }
            else await meaningful('#v-' + tab);
            await page.waitForTimeout(600); await overflow();
          });
          await check('command-palette', async () => {
            await page.keyboard.press('Meta+k'); await page.locator('#pal.on').waitFor(); await meaningful('#pal-res'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in');
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#pal.on').count(), 0);
          });
          await check('customise', async () => {
            if (width < 500) await page.locator('#side-show').click();
            await page.locator('#foot-cog').click(); await page.locator('#setpop.on').waitFor();
            await page.locator('#set-body .set-tile').first().click(); await page.locator('#custom.on').waitFor(); await meaningful('#custom-body');
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#custom.on').count(), 0);
          });
          await check('capture', async () => {
            await page.keyboard.press('>'); await page.locator('#pal.on').waitFor();
            assert.match(await page.locator('#pal-in').inputValue(), /^>/); await meaningful('#pal-res'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.press('Escape');
          });
          await check('stash-search-and-item', async () => {
            await page.goto(lab('/command#stash'), { waitUntil: 'domcontentloaded' });
            await page.locator('#st-q').waitFor();
            await page.locator('#st-q').fill('qa-no-match-2099');
            await page.locator('#st-empty:not([hidden])').waitFor(); await meaningful('#st-empty');
            await page.locator('#st-q').fill('');
            await page.waitForTimeout(800);
            const cards = page.locator('#st-grid .st-card');
            if (!await cards.count()) { results.push({ engine, width, name: 'stash-item', status: 'skip', reason: 'No Stash items in the supplied dataset.' }); return; }
            await cards.first().click(); await page.locator('#st-detail.on').waitFor(); await meaningful('#st-detail');
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#st-detail.on').count(), 0);
          });
        }
        const pages = fault === 'disconnect' ? ['/phone', '/drafts', '/stash-sort'] : ['/phone', '/drafts', ...(draftId ? ['/draft?id=' + encodeURIComponent(draftId)] : []), '/stash-sort', '/', '/connect', '/quick', '/dashboard-classic', '/story/'];
        if (!draftId && fault === 'none') results.push({ engine, width, name: 'existing-draft', status: 'skip', reason: 'No drafts in the supplied dataset.' });
        for (const route of pages) {
          await check('page-' + route.replace(/[/?=]/g, '-'), async () => {
            await page.goto(lab(route), { waitUntil: 'domcontentloaded' });
            await meaningful(); await page.waitForTimeout(1500); await overflow();
            if (route === '/stash-sort') assert.ok((await page.locator('a[aria-label="Back to Stash"]').getAttribute('href')).includes('lab'), 'Stash back link lost lab');
            if (route === '/drafts') {
              await meaningful('#out');
              if (fault === 'none') {
                await page.locator('[data-arch]').click();
                assert.equal(new URL(page.url()).searchParams.get('view'), 'archived', 'archive view did not open');
                assert.ok(new URL(page.url()).searchParams.has('lab'), 'archive navigation lost lab');
                await meaningful('#out');
                await page.locator('[data-arch]').click();
                assert.ok(new URL(page.url()).searchParams.has('lab'), 'live draft navigation lost lab');
                const first = page.locator('#out a.item').first();
                if (await first.count()) {
                  assert.ok(new URL(await first.getAttribute('href'), base).searchParams.has('lab'), 'draft link lost lab');
                  await first.click(); await page.waitForTimeout(800);
                  assert.ok(new URL(page.url()).searchParams.has('lab'), 'draft navigation lost lab');
                  await page.locator('#f-body').waitFor(); assert.ok(await page.locator('#title').count() || await page.locator('#f-to').count(), 'draft editor did not render');
                } else results.push({ engine, width, name: 'existing-draft', status: 'skip', reason: 'No active drafts in supplied dataset.' });
              }
            }
            if (route === '/phone' && fault === 'none') {
              for (const tab of ['agents', 'money', 'more', 'today']) {
                await page.locator(`.tab[data-go="${tab}"]`).click(); await page.waitForTimeout(300); await meaningful();
              }
            }
          });
        }
        results.push({ engine, width, name: 'write-guard', status: 'pass', blockedWrites });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
const fails = results.filter(r => r.status === 'fail');
console.log(`${results.filter(r => r.status === 'pass').length} passed, ${fails.length} failed, ${results.filter(r => r.status === 'skip').length} skipped. Evidence: ${output}`);
process.exitCode = fails.length ? 1 : 0;
