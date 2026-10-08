'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/command.js'), 'utf8');
const start = source.indexOf('function show(id){'), end = source.indexOf('// #stash/', start);
assert.ok(start >= 0 && end > start);
test('choosing the current phone tab closes the drawer without remounting the view', () => {
  let open = true;
  const context = { TAB_DEFS: [{ id: 'home' }], view: 'home', isMobile: () => true, setDrawer: value => { open = value; } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  context.show('home'); assert.equal(open, false);
});
test('choosing the current desktop tab leaves the sidebar mode alone', () => {
  const context = { TAB_DEFS: [{ id: 'home' }], view: 'home', isMobile: () => false, setDrawer: () => { throw new Error('desktop sidebar changed'); } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  context.show('home');
});

const legacy = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8').split('\n').find(line => line.startsWith('function noteUsage(v)'));
test('classic lab navigation never sends usage telemetry', () => {
  const context = { URLSearchParams, location: { search: '?lab' }, fetch: () => { throw new Error('lab attempted a write'); } };
  vm.createContext(context); vm.runInContext(legacy, context); context.noteUsage('home');
});
test('classic usage telemetry remains deduplicated during ordinary navigation', () => {
  let calls = 0;
  const context = { URLSearchParams, location: { search: '' }, Date, usageSent: {}, api: p => p, fetch: () => { calls++; return Promise.resolve(); } };
  vm.createContext(context); vm.runInContext(legacy, context); context.noteUsage('home'); context.noteUsage('home');
  assert.equal(calls, 1);
});

const drafts = fs.readFileSync(path.join(__dirname, '../public/drafts.html'), 'utf8');
test('draft links retain lab while keeping ordinary links unchanged', () => {
  const item = drafts.slice(drafts.indexOf('function item(d){'), drafts.indexOf('// Archived drafts'));
  for (const search of ['', '?lab']) {
    const context = { qs: new URLSearchParams(search), encodeURIComponent, esc: s => s, WORD: {}, status: () => '', ic: () => '', when: () => '' };
    vm.createContext(context); vm.runInContext(item, context);
    const html = context.item({ id: 'a b', kind: 'note', title: 'Fixture' });
    assert.ok(html.includes('href="/draft?id=a%20b' + (search ? '&lab=1' : '') + '"'));
  }
});
test('switching draft archive views retains lab in the selected layout', () => {
  const setView = drafts.split('\n').find(line => line.startsWith('function setView(v)'));
  for (const search of ['', '?lab']) {
    let target;
    const context = { qs: new URLSearchParams(search), location: { pathname: '/drafts' }, history: { replaceState: (state, title, url) => { target = url; } }, draw: () => {} };
    vm.createContext(context); vm.runInContext(setView, context);
    context.setView('archived'); assert.equal(target, '?view=archived' + (search ? '&lab=1' : ''));
    context.setView('live'); assert.equal(target, '/drafts' + (search ? '?lab=1' : ''));
  }
});
test('the Brief tab retains lab in its frame and standalone link', () => {
  const brief = source.slice(source.indexOf('VIEWS.brief={'), source.indexOf('/* ---------- deadlines sheet'));
  for (const lab of [false, true]) {
    const context = { VIEWS: {}, DEMO: false, LAB: lab, api: p => p + '&t=fixture', icon: () => '' };
    vm.createContext(context); vm.runInContext(brief, context);
    const el = {}; context.VIEWS.brief.mount(el);
    assert.ok(el.innerHTML.includes('src="/?embed=1' + (lab ? '&lab=1' : '') + '&t=fixture"'));
    assert.ok(el.innerHTML.includes('href="/' + (lab ? '?lab=1' : '') + '"'));
  }
});

test('Stash omits the sorter for testers and demo mode, and preserves owner and lab navigation', () => {
  const stash = source.slice(source.indexOf('VIEWS.stash={'), source.indexOf('const stFind='));
  for (const tester of [false, true]) for (const demo of [false, true]) for (const lab of [false, true]) {
    const hidden = tester || demo;
    const elements = new Map();
    const el = { innerHTML: '', addEventListener() {} };
    const context = {
      VIEWS: {}, window: tester ? { MERIDIAN_TESTER: { invite: 'fixture' } } : {}, LAB: lab, DEMO: demo,
      location: {}, icon: () => '', ST: {},
      ResizeObserver: class { observe() {} },
      $: id => {
        if (id === 'st-sort' && !el.innerHTML.includes('id="st-sort"')) return null;
        if (!elements.has(id)) elements.set(id, { addEventListener: (type, fn) => { elements.get(id)[type] = fn; } });
        return elements.get(id);
      },
    };
    vm.createContext(context); vm.runInContext(stash, context); context.VIEWS.stash.mount(el);
    assert.equal(el.innerHTML.includes('id="st-sort"'), !hidden);
    assert.ok(el.innerHTML.includes('id="st-add"'));
    assert.ok(el.innerHTML.includes('id="st-ways-tog"'));
    if (!hidden) {
      elements.get('st-sort').click();
      assert.equal(context.location.href, '/stash-sort' + (lab ? '?lab' : ''));
    }
  }
});
