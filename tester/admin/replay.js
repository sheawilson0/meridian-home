// Replay page for the usability test (7 Oct 2026): /replay.html?s=<session>.
// Plays the rrweb recording with the vendored rrweb-player, draws a strip of
// task bands and click dots under it, and lists tasks and clicks on the
// right; anything in the strip or the lists seeks the player. Data comes
// from /admin-api/recordings/<session>/events and /summary (tester/recordings.js).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const session = new URLSearchParams(location.search).get('s') || '';
  const CONTROLLER = 80; // rrweb-player's control bar
  const LEAD = 1500; // seek this far before a click
  const OUTCOME = { done: ['c-done', 'Done'], stuck: ['c-stuck', 'Stuck'], skip: ['c-skip', 'Skipped'], 'moved on': ['c-moved', 'Moved on'], unfinished: ['c-unfinished', 'Unfinished'] };
  let player = null, sum = null, total = 0, now = 0, vw = 1280, vh = 800, filter = 'all', current = -1;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function clock(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }
  const note = (text) => { $('player').innerHTML = `<p class="note">${esc(text)}</p>`; };
  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'no such recording' : 'the server said ' + r.status);
    return r.json();
  }

  // ------------------------------------------------------------ header and lists
  function header() {
    const started = new Date(sum.started);
    // The admin server may add the participant's name to the summary.
    const named = sum.name && sum.name !== sum.invite;
    $('who').textContent = named ? sum.name : sum.invite || 'Session';
    $('when').textContent = (named ? sum.invite + ' · ' : '') + (sum.started ? started.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    $('when').title = session;
    document.title = `Replay · ${named ? sum.name : sum.invite || session}`;
    const v = sum.viewport && sum.viewport.w ? `${sum.viewport.w}×${sum.viewport.h}` : '–';
    const fact = (k, val, cls = '') => `<div class="${cls}"><dt>${k}</dt><dd>${esc(val)}</dd></div>`;
    $('facts').innerHTML = fact('Length', clock(sum.ms)) + fact('Viewport', v) + fact('Clicks', sum.counts.clicks) + fact('Rage', sum.counts.rage, 'rage') + fact('Dead', sum.counts.dead, 'dead');
  }

  function taskList() {
    $('tasks').innerHTML = sum.tasks.length ? sum.tasks.map((t, i) => {
      const [cls, word] = OUTCOME[t.outcome] || ['c-unfinished', t.outcome];
      return `<li class="${cls}" data-task="${i}" title="Jump to the start"><span class="n">${esc(t.n)}</span>
        <span class="t"><div class="title">${esc(t.title || 'Task ' + t.n)}</div><div class="out">${esc(word)}</div></span><span class="ms">${clock(t.ms)}</span></li>`;
    }).join('') : '<li class="none">No tasks marked</li>';
  }

  function clickList() {
    const rows = sum.clicks.map((c, i) => [c, i]).filter(([c]) => filter === 'all' || c[filter]);
    $('clicks').innerHTML = rows.length ? rows.map(([c, i]) => `<li data-i="${i}" title="${esc(c.path)}">
      <span class="time">${clock(c.t)}</span>
      <span class="what"><div class="label${c.label ? '' : ' empty'}">${esc(c.label || c.path || c.tag || 'click')}</div><div class="where">${esc(c.hash || '#')}${c.interactive ? '' : ' · not clickable'}</div></span>
      <span class="badges">${c.rage ? '<span class="badge rage">Rage</span>' : ''}${c.dead ? '<span class="badge dead">Dead</span>' : ''}</span></li>`).join('')
      : `<li class="none">${filter === 'all' ? 'No clicks recorded' : 'None'}</li>`;
    current = -1; follow();
  }

  // ------------------------------------------------------------ strip
  const pct = (ms) => (total ? Math.max(0, Math.min(100, (ms / total) * 100)) : 0);
  function strip() {
    $('lane-tasks').innerHTML = sum.tasks.map((t, i) => {
      const [cls, word] = OUTCOME[t.outcome] || ['c-unfinished', t.outcome];
      const left = pct(t.start), width = Math.max(0.3, pct(t.end == null ? total : t.end) - left);
      return `<div class="band ${cls}" data-task="${i}" style="left:${left}%;width:${width}%" title="${esc(`Task ${t.n} · ${t.title} · ${word} · ${clock(t.ms)}`)}">Task ${esc(t.n)}</div>`;
    }).join('');
    $('lane-dots').innerHTML = sum.clicks.map((c, i) => `<i class="pt${c.rage ? ' rage' : c.dead ? ' dead' : ''}" data-i="${i}" style="left:${pct(c.t)}%"
      title="${esc(`${clock(c.t)} · ${c.label || c.tag}${c.rage ? ' · rage' : ''}${c.dead ? ' · dead' : ''}`)}"></i>`).join('');
    paintHead();
  }
  function paintHead() { $('head').style.left = pct(now) + '%'; follow(); }

  // The list row for the latest click at or before the playhead.
  function follow() {
    const c = sum ? sum.clicks : [];
    let lo = 0, hi = c.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid].t <= now + 50) lo = mid + 1; else hi = mid; }
    const i = lo - 1;
    if (i === current) return;
    const old = $('clicks').querySelector('li.now');
    if (old) old.classList.remove('now');
    const row = i >= 0 && $('clicks').querySelector(`li[data-i="${i}"]`);
    if (row) row.classList.add('now');
    current = i;
  }

  function seek(ms, play) {
    if (!player) return;
    now = Math.max(0, Math.min(total, ms));
    player.goto(now, play);
    paintHead();
  }

  // ------------------------------------------------------------ player
  function size() {
    const stage = $('stage'), cs = getComputedStyle(stage);
    const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    const availH = innerHeight - stage.getBoundingClientRect().top - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - CONTROLLER - 104; // strip and legend
    let w = Math.min(availW, vw), h = (w * vh) / vw;
    if (h > availH && availH > 240) { h = availH; w = (h * vw) / vh; }
    return { width: Math.floor(w), height: Math.floor(h) };
  }
  function fit() {
    const s = size();
    $('strip').style.width = s.width + 'px';
    $('legend').style.width = s.width + 'px';
    return s;
  }

  // Pictures in a recording point at the tester's address, which may be off the internet by
  // now and needs their cookie anyway. This console serves the same pictures, so point them here.
  function rehome(events) {
    const meta = events.find((e) => e.type === 4 && e.data && e.data.href);
    let from = ''; try { from = new URL(meta.data.href).origin; } catch { return events; }
    if (!from || from === location.origin) return events;
    return JSON.parse(JSON.stringify(events).split(from).join(location.origin));
  }

  // Owner's notes from the console, on the timeline and in the list.
  function noteList() {
    const list = (sum.notes || []).map((n) => ({ ...n, t: n.at - sum.started }));
    $('notes-h').hidden = !list.length;
    $('notes').innerHTML = list.map((n, i) => `<li data-n="${i}" title="Jump here"><span class="time">${clock(n.t)}</span><span class="what"><div class="label">${esc(n.text)}</div><div class="where">${esc(n.by === 'tester' ? 'From ' + (sum.name || 'the tester') : 'Your note')}${n.task ? ' · task ' + esc(n.task) : ''}</div></span></li>`).join('');
    sum._notes = list;
  }

  function mount(events) {
    events = rehome(events);
    const meta = events.find((e) => e.type === 4 && e.data && e.data.width);
    if (meta) { vw = meta.data.width; vh = meta.data.height; } else if (sum.viewport && sum.viewport.w) { vw = sum.viewport.w; vh = sum.viewport.h; }
    $('player').innerHTML = '';
    $('strip').hidden = false; $('legend').hidden = false;
    player = new rrwebPlayer.Player({
      target: $('player'),
      props: {
        events, ...fit(), autoPlay: false, skipInactive: true, speedOption: [1, 2, 4], speed: 1, showController: true,
        inactiveColor: '#262b35', tags: { click: 'transparent', nav: 'transparent', task: 'transparent' }, // the strip below shows these
        mouseTail: { duration: 700, lineCap: 'round', lineWidth: 3, strokeStyle: 'rgba(143, 176, 255, .6)' },
        UNSAFE_replayCanvas: false,
        // The player pauses CSS animations whenever it's paused and rebuilds
        // the page on every seek, so an entrance animation (the dashboard's
        // views fade in from opacity 0) would freeze on its first, invisible
        // frame. Animations end at once instead.
        insertStyleRules: ['*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; }'],
      },
    });
    total = player.getMetaData().totalTime;
    player.addEventListener('ui-update-current-time', (d) => { now = d.payload; paintHead(); });
    strip();
    let raf = 0;
    addEventListener('resize', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { player.$set(fit()); requestAnimationFrame(() => player.triggerResize()); });
    });
  }

  // ------------------------------------------------------------ wiring
  $('strip').addEventListener('click', (e) => {
    const dot = e.target.closest('.pt'), band = e.target.closest('.band');
    if (dot) return seek(sum.clicks[dot.dataset.i].t - LEAD, true);
    if (band) return seek(sum.tasks[band.dataset.task].start, true);
    const r = $('strip').getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * total);
  });
  $('tasks').addEventListener('click', (e) => { const li = e.target.closest('li[data-task]'); if (li) seek(sum.tasks[li.dataset.task].start, true); });
  $('notes').addEventListener('click', (e) => { const li = e.target.closest('li[data-n]'); if (li) seek(sum._notes[li.dataset.n].t - 5000, true); });
  $('clicks').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) seek(sum.clicks[li.dataset.i].t - LEAD, true); });
  // Hovering a row lights its dot.
  const hot = (e, on) => { const li = e.target.closest && e.target.closest('li[data-i]'); const dot = li && $('lane-dots').querySelector(`.pt[data-i="${li.dataset.i}"]`); if (dot) dot.classList.toggle('hot', on); };
  $('clicks').addEventListener('mouseover', (e) => hot(e, true));
  $('clicks').addEventListener('mouseout', (e) => hot(e, false));
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b || !sum) return;
    filter = b.dataset.f;
    for (const x of $('filters').children) x.setAttribute('aria-pressed', String(x === b));
    clickList();
  });
  addEventListener('keydown', (e) => {
    if (!player || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(now - 5000); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(now + 5000); }
  });

  async function load() {
    if (!/^[a-z0-9-]{8,80}$/.test(session)) return note('Add ?s=<session> to the address to replay a session.');
    const base = '/admin-api/recordings/' + encodeURIComponent(session);
    let events;
    try {
      const [a, b] = await Promise.all([getJson(base + '/events'), getJson(base + '/summary')]);
      events = a.events || [];
      sum = b.summary;
    } catch (e) { return note('Could not load this recording: ' + e.message + '.'); }
    header(); taskList(); noteList(); clickList();
    if (events.length < 2 || !events.some((e) => e.type === 2)) return note('Nothing to replay yet: the page snapshot hasn’t arrived.');
    if (typeof rrwebPlayer === 'undefined') return note('The player didn’t load (/vendor/rrweb/rrweb-player-2.1.7.min.js).');
    try { mount(events); } catch (e) { note('The player couldn’t start: ' + e.message); }
  }
  load();
})();
