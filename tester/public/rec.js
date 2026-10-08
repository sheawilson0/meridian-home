// Usability-test recorder (7 Oct 2026). Records the participant's session
// with rrweb so the researcher can replay it later, plus our own log of every click
// (what it was on, whether it looked clickable) and every route change.
// Loaded after the rrweb record bundle (window.rrwebRecord.record, or
// window.rrweb.record from the full bundle); reads window.MERIDIAN_TESTER.
//
// Events go to /t-api/rec in batches every 4 s or 300 events, and with a
// beacon when the page is hidden or closed. A failed batch is tried once
// more on the next tick, then dropped: the page must never wait on this or
// see an error from it.
//
// The overlay marks tasks with meridianMark('task', {n, title, state}).
(function () {
  'use strict';
  const cfg = window.MERIDIAN_TESTER || {};
  const lib = window.rrwebRecord || window.rrweb;
  const record = lib && lib.record;
  const noop = () => Promise.resolve();
  if (cfg.recording !== true || typeof record !== 'function') {
    window.meridianMark = window.meridianMark || function () {};
    window.meridianRec = window.meridianRec || { session: null, flush: noop };
    return;
  }

  const URL_ = '/t-api/rec';
  const EVERY = 4000, BATCH = 300, CAP = 1.5e6;
  const SESSION = /^[a-z0-9-]{8,80}$/;
  const invite = String(cfg.invite || 'anon').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'anon';

  // The session and batch count live in sessionStorage, so a reload carries
  // on the same recording (rrweb takes a fresh snapshot) without reusing seq.
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const hex4 = () => { try { return crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0'); } catch { return Math.random().toString(16).slice(2, 6).padEnd(4, '0'); } };
  let session = typeof cfg.session === 'string' && SESSION.test(cfg.session) ? cfg.session : store.get('meridian-rec:' + invite);
  if (!session || !SESSION.test(session)) session = (invite + '-' + Date.now().toString(36) + '-' + hex4()).slice(0, 80);
  store.set('meridian-rec:' + invite, session);
  const seqKey = 'meridian-rec-seq:' + session;
  let seq = Math.max(0, parseInt(store.get(seqKey), 10) || 0);

  let buf = [], retry = [], queue = [], started = false, stopped = false, timer = null, stopRecording = null;

  // ------------------------------------------------------------ sending
  // Bodies of at most CAP characters; a single event bigger than that (a
  // large full snapshot) goes on its own.
  function bodies(events) {
    const out = [];
    const make = (evs) => {
      const b = { session, invite, seq, events: evs };
      if (seq === 0) b.meta = { ua: navigator.userAgent, w: innerWidth, h: innerHeight, href: location.pathname + location.hash, started: Date.now() };
      const json = JSON.stringify(b);
      if (json.length > CAP && evs.length > 1) { const half = evs.length >> 1; make(evs.slice(0, half)); make(evs.slice(half)); return; }
      out.push(json); seq += 1;
    };
    if (events.length) make(events);
    store.set(seqKey, String(seq));
    return out;
  }

  function post(json, again) {
    return fetch(URL_, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: json })
      .then((r) => {
        if (r.status === 413) stop(); // the recording is full: stop sending
        else if (!r.ok && r.status >= 500 && again) retry.push(json);
      })
      .catch(() => { if (again) retry.push(json); });
  }

  function flush() {
    try {
      const tryAgain = retry; retry = [];
      const out = bodies(buf.splice(0));
      return Promise.all([...tryAgain.map((j) => post(j, false)), ...out.map((j) => post(j, true))]).then(() => {});
    } catch { return Promise.resolve(); }
  }

  // Page going away: beacons survive the unload. One too big for a beacon
  // (about 64 KB) falls back to a plain POST, which may or may not land.
  // Some browsers refuse a JSON-typed beacon, so text/plain is the second
  // try: the server reads the body as JSON whatever its type.
  function beacon(json) {
    if (!navigator.sendBeacon || json.length >= 6e4) return false;
    for (const type of ['application/json', 'text/plain;charset=UTF-8']) {
      try { if (navigator.sendBeacon(URL_, new Blob([json], { type }))) return true; } catch { /* try the next */ }
    }
    return false;
  }
  function flushBeacon() {
    try {
      const all = [...retry, ...bodies(buf.splice(0))]; retry = [];
      for (const json of all) if (!beacon(json)) post(json, false);
    } catch { /* never in the way */ }
  }

  // ------------------------------------------------------------ marks
  function addCustom(name, data) {
    if (stopped) return;
    if (!started) { if (queue.length < 500) queue.push([name, data]); return; }
    try { record.addCustomEvent(name, data); } catch { /* not recording after all */ }
  }
  function drain() {
    started = true;
    const q = queue; queue = [];
    for (const [n, d] of q) addCustom(n, d);
  }
  window.meridianMark = (name, data) => { try { addCustom(String(name), data == null ? {} : data); } catch { /* ignore */ } };

  // ------------------------------------------------------------ clicks
  const TAGS = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'OPTION'];
  const ROLES = ['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'link', 'checkbox', 'switch', 'radio', 'option'];
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const clickable = (el) => {
    if (TAGS.includes(el.tagName)) return true;
    if (ROLES.includes(el.getAttribute('role'))) return true;
    if (el.isContentEditable || el.onclick) return true;
    const ti = el.getAttribute('tabindex');
    if (ti != null && Number(ti) >= 0) return true;
    for (const a of el.getAttributeNames()) if (a === 'data-go' || /^data-(.+-)?act$/.test(a)) return true;
    return false;
  };
  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
    return tag + id + cls;
  }
  function pathOf(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 4; n = n.parentElement) {
      parts.unshift(describe(n));
      if (n.id || n === document.body) break;
    }
    return parts.join(' > ');
  }
  function labelOf(target, hit) {
    for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
      const v = n.getAttribute('aria-label') || (n.getAttribute('data-tip') || '').split('|')[0] || n.getAttribute('title') || n.getAttribute('alt');
      if (clip(v)) return clip(v);
      if (n === hit || n === document.body) break;
    }
    const el = hit || target;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return clip(el.getAttribute('placeholder') || (/^(button|submit|reset)$/.test(el.type) ? el.value : '') || el.name);
    const text = el.textContent || '';
    return hit || text.length <= 120 ? clip(text) : ''; // not a whole panel's text
  }

  function onClick(e) {
    try {
      if (!e.isTrusted) return; // the app's own el.click() calls
      let target = e.composedPath ? e.composedPath()[0] : e.target;
      if (target && target.nodeType !== 1) target = target.parentElement;
      if (!target || !target.tagName) return;
      let hit = null;
      for (let n = target; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) if (clickable(n)) { hit = n; break; }
      let interactive = Boolean(hit);
      if (!interactive) { try { interactive = getComputedStyle(target).cursor === 'pointer'; } catch { /* detached */ } }
      let x = e.clientX, y = e.clientY;
      if (!e.detail && !x && !y) { const r = (hit || target).getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; } // keyboard
      const el = hit || target;
      addCustom('click', { x: Math.round(x), y: Math.round(y), label: labelOf(target, hit), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
        interactive, hash: location.hash, path: pathOf(el) });
    } catch { /* never in the way */ }
  }

  // ------------------------------------------------------------ start
  function stop() {
    stopped = true;
    try { if (stopRecording) stopRecording(); } catch { /* ignore */ }
    clearInterval(timer);
  }
  try {
    stopRecording = record({
      emit(event) {
        if (stopped) return;
        buf.push(event);
        if (!started && event.type === 2) setTimeout(drain, 0); // full snapshot: recording has begun
        if (buf.length >= BATCH) flush();
      },
      maskInputOptions: { password: true },
      recordCanvas: false,
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
      blockClass: 'rr-block',
      ignoreClass: 'rr-ignore',
      inlineStylesheet: true,
      collectFonts: false,
      errorHandler: () => true, // rrweb's own errors stay out of the page
    });
  } catch { stopped = true; }
  if (!stopped) timer = setInterval(flush, EVERY);

  addEventListener('click', onClick, true);
  addEventListener('hashchange', () => addCustom('nav', { hash: location.hash }));
  // A click that opens a new tab (a report, a link) changes nothing here, but it wasn't dead.
  const open = window.open;
  window.open = function (url) { try { addCustom('open', { url: String(url || '').slice(0, 300) }); } catch { /* never in the way */ } return open.apply(this, arguments); };
  addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a && (a.target === '_blank' || e.metaKey || e.ctrlKey)) addCustom('open', { url: a.href.slice(0, 300) }); });
  addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushBeacon(); });

  window.meridianRec = { session, flush };
})();
