// The console for running Meridian tests (7 Oct 2026), tailnet only. Make an
// invite per person, send them the link, then follow along: who's on, which
// task they're on (and move them to the next), every click as it happens,
// your notes against the clock, their ratings and closing answers, and a
// replay of each session afterwards. The switch at the top puts the tester
// side on the internet (Tailscale Funnel) and takes it off again.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const hms = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const ago = (t) => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };

  let O = { invites: [], tasks: {}, final: [] };
  let sel = location.hash.slice(1) || null;
  const sessions = {};
  const byId = (id) => O.invites.find((x) => x.id === id);
  const nameOf = (id) => (byId(id) || {}).name || id;

  async function api(p, method = 'GET', body) {
    const r = await fetch(p, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Meridian-Admin': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'Failed (' + r.status + ')');
    return j;
  }
  let toastT = 0;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600); }
  async function copy(text, what) { try { await navigator.clipboard.writeText(text); toast('Copied ' + (what || '')); } catch { prompt('Copy this:', text); } }

  // ---------------------------------------------------------------- what to send them
  // Plain words, ready to paste into Teams, Slack or a text.
  function message(x) {
    if (x.mode === 'self') return `Hi ${x.name}, could you give me ten minutes this week for my uni project? It's a test version of Meridian, the dashboard I've been building: ${x.link}\n\nBest on a laptop rather than your phone. A card in the corner gives you a few things to try, and there are some quick questions at the end. The data's all made up, so nothing touches your real stuff. If anything's confusing, say so in the box, because that's what I most want to know.\n\nThanks, Owner`;
    return `Hi ${x.name}, thanks again for doing this. Here's the link for Thursday: ${x.link}\n\nOpen it on your laptop just before the call, in Chrome, Edge or Safari (not your phone). The first page explains what it is and asks if it's OK to record your clicks. It takes about 20 minutes and I'll talk you through it on Zoom.\n\nOwner`;
  }

  // ---------------------------------------------------------------- the public switch
  async function pubStatus() {
    try { paintPub(await api('/admin-api/public')); } catch (e) { paintPub({ error: e.message }); }
  }
  function paintPub(s) {
    const box = $('pub'), btn = $('pub-btn');
    box.classList.toggle('on', Boolean(s.on));
    $('pub-t').innerHTML = s.error && !s.on ? `Couldn’t check Tailscale: ${esc(s.error)}` : s.on ? `On the internet at <span class="mono">${esc(s.url)}</span>` : 'Testers can’t reach it yet (only your devices can)';
    btn.hidden = false; btn.textContent = s.on ? 'Take it offline' : 'Go public'; btn.className = 'btn sm' + (s.on ? '' : ' primary'); btn.disabled = false;
    btn.onclick = async () => {
      if (!s.on && !confirm(`This puts the tester pages on the internet at ${s.url || 'port 8443'} with Tailscale Funnel. Without an invite link, every page there is a “private test” notice; with one, it’s that person’s test copy (made-up data, never your real Meridian). The Dot’s /mcp stays as it is.\n\nGo public?`)) return;
      btn.disabled = true; btn.textContent = s.on ? 'Taking it offline…' : 'Going public…';
      try { const r = await api('/admin-api/public', 'POST', { on: !s.on }); paintPub(r); toast(r.error ? r.error : r.on ? 'Public. Check the link from your phone on 5G.' : 'Offline'); }
      catch (e) { toast(e.message); pubStatus(); }
    };
  }

  // ---------------------------------------------------------------- people
  function renderPeople() {
    const list = O.invites.slice().sort((a, b) => b.created - a.created);
    $('pempty').hidden = list.length > 0;
    $('plist').innerHTML = list.map((x) => {
      const n = x.tasks.length;
      const st = x.finished ? 'Finished' : x.task ? `Task ${x.task.n} of ${n}${x.task.ended ? ' · ' + x.task.outcome : ''}` : x.consent ? 'In, not started' : x.opened ? 'Opened the link' : 'Not opened yet';
      return `<li data-id="${esc(x.id)}" class="${x.id === sel ? 'on' : ''}"><i class="dot${x.online ? ' on' : ''}" title="${x.online ? 'Online now' : 'Last seen ' + ago(x.lastSeen)}"></i><span class="nm">${esc(x.name)}</span><span class="md">${x.mode === 'self' ? 'Own time' : 'Call'}</span><span class="st">${esc(st)}</span></li>`;
    }).join('');
  }
  $('plist').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (!li) return; sel = li.dataset.id; location.hash = sel; renderPeople(); renderMain(); });
  $('new-btn').addEventListener('click', () => { $('newform').hidden = !$('newform').hidden; if (!$('newform').hidden) $('nf-name').focus(); });
  $('nf-cancel').addEventListener('click', () => { $('newform').hidden = true; });
  $('newform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = document.querySelector('input[name=nf-mode]:checked').value, world = document.querySelector('input[name=nf-world]:checked').value;
    try { const j = await api('/admin-api/invites', 'POST', { name: $('nf-name').value.trim(), mode, world }); upsert(j.invite); sel = j.invite.id; location.hash = sel; $('newform').hidden = true; $('nf-name').value = ''; renderPeople(); renderMain(); }
    catch (err) { toast(err.message); }
  });
  function upsert(x) { if (!x) return; const i = O.invites.findIndex((y) => y.id === x.id); if (x.removed) { if (i >= 0) O.invites.splice(i, 1); return; } if (i >= 0) O.invites[i] = x; else O.invites.push(x); }

  // ---------------------------------------------------------------- one person
  function taskRows(x) {
    const log = x.taskLog || [];
    return x.tasks.map((t) => {
      const starts = log.filter((l) => l.n === t.n && l.state === 'start');
      const start = starts.length ? starts[starts.length - 1].at : null;
      const end = start ? log.find((l) => l.n === t.n && l.at >= start && l.state !== 'start') : null;
      const now = x.task && x.task.n === t.n && !x.task.ended;
      const out = end ? (end.state === 'done' ? '<span class="ok">Done</span>' : end.state === 'skip' ? '<span class="sk">Skipped</span>' : end.state === 'stuck' ? '<span class="sk">Stuck</span>' : 'Moved on') : now ? 'On it' : '';
      const time = start ? dur((end ? end.at : Date.now()) - start) : '';
      const seq = x.seq && x.seq[t.n] ? ` · ease ${x.seq[t.n]}/7` : '';
      const ans = end && end.answer ? `<div class="look" style="color:var(--text)">“${esc(end.answer)}”</div>` : '';
      return `<li class="${now ? 'now' : ''}"><span class="n">${t.n}</span><span class="t"><b>${esc(t.title)}</b> <span style="color:var(--muted)">${esc(t.text)}</span></span><span class="res">${out}${time ? ` <span class="mono">${time}</span>` : ''}${seq}</span><button type="button" class="btn sm${now ? '' : ' ghost'}" data-start="${t.n}">${now ? 'Again' : 'Start'}</button><div class="look">Look for: ${esc(t.look || '')}</div>${ans}</li>`;
    }).join('');
  }
  function answersHtml(x) {
    if (!x.answers) return '<p style="color:var(--muted)">Not yet. They come in when the tester sends the closing questions.</p>';
    const a = x.answers;
    const rows = O.final.map((q) => { const v = a[q.id]; if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return ''; return `<div><dt>${esc(q.text)}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v)}${q.kind === 'scale' ? ' / 7' : ''}${q.id === 'week' && a.weekWhy ? ' · ' + esc(a.weekWhy) : ''}</dd></div>`; }).join('');
    return `<div class="row" style="margin-bottom:10px"><span class="score">${x.umux == null ? '–' : x.umux}</span><span style="color:var(--muted)">UMUX-Lite, on the SUS scale (68 is about average)</span></div><dl class="qa">${rows}</dl>`;
  }
  function notesHtml(x) {
    const list = (x.notes || []).slice().reverse();
    return list.length ? `<ol class="notes">${list.map((n) => `<li><span class="tm">${hms(n.at)}</span><span>${n.by === 'tester' ? `<span class="by">${esc(x.name)}</span>` : n.tag ? `<span class="by" style="color:var(--muted)">${esc(n.tag)}</span>` : ''}${esc(n.text)}${n.task ? ` <span style="color:var(--faint)">· task ${n.task}</span>` : ''}</span></li>`).join('')}</ol>` : '';
  }
  async function loadSessions(id) {
    try { const j = await api('/admin-api/recordings?invite=' + encodeURIComponent(id)); sessions[id] = j.sessions || []; if (sel === id) paintSessions(id); } catch { /* none */ }
  }
  function paintSessions(id) {
    const el = $('sessions'); if (!el) return;
    const list = sessions[id] || [];
    el.innerHTML = list.length ? list.map((s) => `<li><a href="/replay.html?s=${encodeURIComponent(s.session)}" target="_blank" rel="noopener"><span>${new Date(s.started).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span class="mono">${dur((s.last || s.started) - s.started)}</span><span class="mono">${(s.count || 0).toLocaleString()} events</span><span style="margin-left:auto;color:var(--accent)">Replay →</span></a></li>`).join('') : '<li style="color:var(--muted)">No recordings yet. Each page load they make while recording is one session.</li>';
  }

  function renderMain() {
    const x = sel && byId(sel);
    if (!x) { $('main').innerHTML = '<p class="empty big">Pick someone on the left, or make a new invite.</p>'; return; }
    const preview = O.previewBase ? x.link.replace(O.publicBase, O.previewBase) : x.link;
    const cur = x.task && !x.task.ended ? x.task.n : x.task ? x.task.n : 0;
    $('main').innerHTML = `
      <div class="hd"><div><h1>${esc(x.name)}</h1><div class="meta">${x.mode === 'self' ? 'On their own time' : 'On a call with you'} · ${x.world === 'blank' ? 'blank Meridian' : 'Sam’s day'} · ${x.online ? '<b style="color:var(--good)">online now</b>' : 'last seen ' + ago(x.lastSeen)}${x.consent ? ` · ${x.consent.record ? 'recording on' : 'said no to recording'}` : ''}</div></div>
        <div class="row"><button type="button" class="btn" data-act="message">Copy a message to send</button></div></div>
      <div class="card"><h3>Links</h3><div class="links">
        <span>For ${esc(x.name)}</span><code title="${esc(x.link)}">${esc(x.link)}</code><button type="button" class="btn sm" data-copy="${esc(x.link)}">Copy</button>
        <span>Try it yourself</span><code title="${esc(preview)}">${esc(preview)}</code><a class="btn sm" href="${esc(preview)}" target="_blank" rel="noopener">Open</a>
        <span>Their agent</span><code title="${esc(x.agentUrl)}">${esc(x.agentUrl)}</code><button type="button" class="btn sm" data-copy="${esc(x.agentUrl)}">Copy</button>
      </div><p style="color:var(--faint);font-size:12px;margin-top:8px">“Try it yourself” works on your own devices even while the public link is off. Opening either link makes you this tester on that device, and counts as them in the recordings.</p></div>
      <div class="card"><h3>Tasks <span class="end">${x.mode === 'self' ? 'They move themselves on.' : 'Their card follows you.'}</span></h3><ol class="tasks">${taskRows(x)}</ol>
        <div class="bigrow"><button type="button" class="btn primary" data-next="${cur + 1}">${cur ? (cur >= x.tasks.length ? 'Closing questions' : `Next: task ${cur + 1}`) : 'Start task 1'}</button><button type="button" class="btn" data-act="finish">Ask the closing questions now</button><button type="button" class="btn ghost" data-act="untask">Clear the card</button></div></div>
      <div class="card"><h3>Your notes <span class="end">Time-stamped, and shown on the replay</span></h3>
        <form class="notebox" id="noteform"><input id="note-in" placeholder="What did they say or do? Enter saves" autocomplete="off"><button class="btn">Add</button></form>
        <div class="tags">${['Confused', 'Hesitated', 'Liked', 'Wanted', 'Bug', 'Quote'].map((t) => `<button type="button" data-tag="${t}">${t}</button>`).join('')}</div>${notesHtml(x)}</div>
      <div class="card"><h3>Closing answers</h3>${answersHtml(x)}</div>
      <div class="card"><h3>Recordings</h3><ol class="sessions" id="sessions"><li style="color:var(--muted)">Loading…</li></ol></div>
      <div class="card"><h3>Their Meridian</h3><div class="danger-zone">
        <button type="button" class="btn" data-act="reset-sam">Reset to Sam’s day</button><button type="button" class="btn" data-act="reset-blank">Reset to blank</button>
        <button type="button" class="btn" data-act="restart">Restart their tasks</button><button type="button" class="btn" data-act="token">New agent link</button>
        <a class="btn" href="/admin-api/invites/${esc(x.id)}/export">Export everything (JSON)</a><button type="button" class="btn danger" data-act="delete">Delete invite and data</button></div></div>`;
    paintSessions(x.id); loadSessions(x.id);
  }

  $('main').addEventListener('click', async (e) => {
    const x = sel && byId(sel); if (!x) return;
    const c = e.target.closest('[data-copy]'); if (c) return copy(c.dataset.copy, 'the link');
    const st = e.target.closest('[data-start]'); if (st) return setTask(x, Number(st.dataset.start));
    const nx = e.target.closest('[data-next]'); if (nx) { const n = Number(nx.dataset.next); return n > x.tasks.length ? act(x, 'finish') : setTask(x, n); }
    const tg = e.target.closest('[data-tag]'); if (tg) { const v = $('note-in').value.trim(); return addNote(x, v || tg.dataset.tag, tg.dataset.tag); }
    const a = e.target.closest('[data-act]'); if (a) return act(x, a.dataset.act);
  });
  $('main').addEventListener('submit', (e) => { if (e.target.id !== 'noteform') return; e.preventDefault(); const v = $('note-in').value.trim(); if (v) addNote(byId(sel), v); });
  async function setTask(x, n) { try { const j = await api(`/admin-api/invites/${x.id}/task`, 'POST', { n }); upsert(j.invite); renderPeople(); renderMain(); } catch (err) { toast(err.message); } }
  async function addNote(x, text, tag) { try { await api(`/admin-api/invites/${x.id}/note`, 'POST', { text, tag }); $('note-in').value = ''; $('note-in').focus(); } catch (err) { toast(err.message); } }
  async function act(x, a) {
    try {
      if (a === 'message') return copy(message(x), 'the message');
      if (a === 'finish') { await api(`/admin-api/invites/${x.id}/finish`, 'POST', {}); return toast('Closing questions sent to their screen'); }
      if (a === 'untask') return setTask(x, 0);
      if (a === 'reset-sam' || a === 'reset-blank') { if (!confirm(`Reset ${x.name}’s Meridian to ${a === 'reset-sam' ? 'Sam’s day' : 'blank'}? Everything they added or changed goes.`)) return; await api(`/admin-api/invites/${x.id}/reset`, 'POST', { world: a === 'reset-sam' ? 'sam' : 'blank' }); return toast('Reset'); }
      if (a === 'restart') { if (!confirm(`Clear ${x.name}’s task progress, ratings and answers? Notes and recordings stay.`)) return; await api(`/admin-api/invites/${x.id}/restart`, 'POST', {}); return toast('Tasks restarted'); }
      if (a === 'token') { if (!confirm('Make a new agent link? The old one stops working.')) return; await api(`/admin-api/invites/${x.id}/agent-token`, 'POST', {}); return toast('New agent link made'); }
      if (a === 'delete') { if (!confirm(`Delete ${x.name}’s invite, test copy, recordings, notes and answers? This can’t be undone.`)) return; await api(`/admin-api/invites/${x.id}`, 'DELETE'); upsert({ id: x.id, removed: true }); sel = null; location.hash = ''; renderPeople(); renderMain(); return toast('Deleted'); }
    } catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------------------- live
  function feed(inv, cls, text) {
    const li = document.createElement('li'); li.className = 'new';
    li.innerHTML = `<span class="tm">${hm(Date.now())}</span><span><span class="who">${esc(nameOf(inv))}</span> <span class="${cls}">${text}</span></span>`;
    $('feed').prepend(li);
    while ($('feed').children.length > 300) $('feed').lastChild.remove();
    $('feed-sub').textContent = O.invites.filter((x) => x.online).map((x) => x.name).join(', ') || 'Nobody on';
  }
  function listen() {
    const es = new EventSource('/admin-api/live');
    const on = (k, fn) => es.addEventListener(k, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    on('hello', (d) => { (d.invites || []).forEach(upsert); renderPeople(); if (sel) renderMain(); });
    on('invite', (d) => { upsert(d); renderPeople(); if (d.id === sel) renderMain(); });
    on('presence', (d) => { const x = byId(d.invite); if (!x) return; const was = x.online; x.online = d.online; x.lastSeen = d.lastSeen || x.lastSeen; if (was !== d.online) feed(d.invite, 'k', d.online ? 'opened Meridian' : 'left Meridian'); renderPeople(); if (d.invite === sel) renderMain(); });
    on('task', (d) => { const x = byId(d.invite); if (!x) return; x.task = d.task; if (d.log) x.taskLog = [...(x.taskLog || []), d.log]; const l = d.log; if (l) feed(d.invite, 'task', `${l.state === 'start' ? 'started' : l.state === 'done' ? 'finished' : l.state === 'skip' ? 'skipped' : l.state} task ${l.n}${l.by === 'moderator' ? ' (you)' : ''}${l.answer ? `: “${esc(l.answer)}”` : ''}`); renderPeople(); if (d.invite === sel) renderMain(); });
    on('seq', (d) => { const x = byId(d.invite); if (!x) return; x.seq = { ...(x.seq || {}), [d.n]: d.value }; feed(d.invite, 'task', `rated task ${d.n}: ${d.value}/7`); if (d.invite === sel) renderMain(); });
    on('note', (d) => { const x = byId(d.invite); if (!x) return; x.notes = [...(x.notes || []), d.note]; if (d.note.by === 'tester') feed(d.invite, 'note', `said: “${esc(d.note.text)}”`); if (d.invite === sel) renderMain(); });
    on('answers', (d) => { const x = byId(d.invite); if (!x) return; x.answers = d.answers; x.umux = d.umux; x.finished = Date.now(); feed(d.invite, 'task', `sent the closing answers${d.umux != null ? ` (UMUX-Lite ${d.umux})` : ''}`); renderPeople(); if (d.invite === sel) renderMain(); });
    on('rec', (d) => {
      if (d.tag === 'click') feed(d.invite, 'k', `clicked <b>${esc((d.data && (d.data.label || d.data.tag)) || 'something')}</b>${d.data && d.data.interactive === false ? ' <span style="color:var(--warn)">(not clickable)</span>' : ''} <span style="color:var(--faint)">${esc((d.data && d.data.hash) || '')}</span>`);
      else if (d.tag === 'nav') feed(d.invite, 'k', `went to ${esc((d.data && d.data.hash) || '')}`);
      if (d.invite === sel && !sessions[sel]?.some((s) => s.session === d.session)) loadSessions(sel);
    });
    on('run', (d) => feed(d.invite, 'k', `’s agent finished “${esc(d.title)}”`));
    on('mcp', (d) => { if (d.method === 'tools/call') feed(d.invite, 'k', `’s agent (${esc(d.by)}) used <b>${esc(d.tool || '?')}</b>`); else if (d.method === 'initialize') feed(d.invite, 'k', `connected an agent (${esc(d.by)})`); });
    on('tell', (d) => feed(d.invite, 'k', `brought in ${Object.entries(d.counts || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`));
  }

  // ---------------------------------------------------------------- settings
  $('set-btn').addEventListener('click', () => {
    $('s-ph').value = ''; $('s-ph').placeholder = O.posthog && O.posthog.set ? 'Set. Paste a new key to change it' : 'phc_…';
    $('s-ai').checked = Boolean(O.ai && O.ai.on);
    document.querySelectorAll('input[name=s-host]').forEach((r) => { r.checked = r.value === ((O.posthog && O.posthog.host) || 'https://eu.i.posthog.com'); });
    $('settings').showModal();
  });
  $('s-save').addEventListener('click', async () => {
    const body = { ai: { on: $('s-ai').checked } };
    const key = $('s-ph').value.trim(); const host = document.querySelector('input[name=s-host]:checked').value;
    if (key || (O.posthog && O.posthog.set)) body.posthog = { key: key || undefined, host };
    if (key === '' && O.posthog && O.posthog.set) delete body.posthog;
    try { const j = await api('/admin-api/settings', 'POST', body); O.ai = j.ai; O.posthog = j.posthog; $('settings').close(); toast('Saved'); } catch (err) { toast(err.message); }
  });

  async function boot() {
    try { O = await api('/admin-api/overview'); } catch (e) { $('main').innerHTML = `<p class="empty big">Couldn’t reach the test server: ${esc(e.message)}</p>`; return; }
    renderPeople(); renderMain(); pubStatus(); listen();
    setInterval(() => { renderPeople(); }, 30000);
  }
  boot();
})();
