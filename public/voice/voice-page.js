// Voice prototype pages (6 Oct 2026): wires /voice/index.html (laptop: the
// draft to edit, plus the call panel) and /voice/call.html (phone: a call
// screen with a live preview). Each page has the elements it needs; anything
// missing is skipped. Logic lives in voice-core.js.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ENGINE_KEY = 'meridian.voice.engine', VOICE_KEY = 'meridian.voice.voice';
  let draftId = params.get('id') || '';
  let sync = null, call = null, status = null, editors = {};
  let engine = params.get('engine') || localStorage.getItem(ENGINE_KEY) || 'live';

  // ---- toast
  let toastTimer;
  function toast(text, action) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div'); el.className = 'toast';
    el.innerHTML = `<span>${VC.esc(text)}</span>`;
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { el.remove(); action.run(); }; el.append(b); }
    document.body.append(el);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), action ? 9000 : 4000);
  }

  // ---- the draft
  const FIELDS = ['to', 'subject', 'where', 'body'];
  for (const f of FIELDS) {
    const el = $('f-' + f);
    if (el) editors[f] = VC.editor(el, f, { getSync: () => sync, onToast: toast });
  }

  function render(d, history) {
    document.title = (d.title || 'Draft') + ' · Voice';
    if ($('title')) $('title').textContent = d.title || 'Draft';
    if ($('kind')) $('kind').textContent = { email: 'Email', slack: 'Slack message', text: 'Text', note: 'Note', notion: 'Notion page' }[d.kind] || d.kind;
    document.body.dataset.kind = d.kind;
    for (const f of FIELDS) editors[f]?.set(d[f] ?? '');
    if ($('preview')) {
      const parts = [];
      if (d.to) parts.push(`<div class="pv-to"><span class="dim">To</span> ${VC.spansHTML(VC.authorship(history, 'to', d.to))}</div>`);
      if (d.subject) parts.push(`<div class="pv-subject">${VC.spansHTML(VC.authorship(history, 'subject', d.subject))}</div>`);
      parts.push(`<div class="pv-body">${VC.spansHTML(VC.authorship(history, 'body', d.body || '')) || '<span class="dim">Nothing written yet.</span>'}</div>`);
      $('preview').innerHTML = parts.join('');
    }
    if ($('last')) {
      const w = VC.who(d.lastBy);
      $('last').innerHTML = d.rev > 1 ? `Last change: <span class="w w-${w.cls}">${VC.esc(w.label)}</span>, ${VC.esc((d.lastFields || []).join(', ') || 'created')} at ${VC.clock(d.updated)}` : `Started by ${VC.esc(VC.who(d.createdBy).label)} at ${VC.clock(d.created)}`;
    }
    if ($('pick') && !$('pick').querySelector(`option[value="${d.id}"]`)) loadPicker();
    if ($('pick')) $('pick').value = d.id;
  }

  function switchTo(id) {
    if (sync) sync.close();
    draftId = id;
    const u = new URL(location.href); u.searchParams.set('id', id); history.replaceState(null, '', u);
    if ($('phone')) { const p = new URL('/voice/call.html?id=' + id, location.href); $('phone').href = p.href; $('phone').textContent = p.host + p.pathname + p.search; }
    if ($('laptop')) { $('laptop').href = '/voice/index.html?id=' + id; }
    document.body.classList.toggle('nodraft', !id);
    if (!id) return;
    sync = VC.openDraft(id, render);
  }

  async function loadPicker() {
    const pick = $('pick'); if (!pick) return;
    const { drafts } = await VC.api('GET', '/api/drafts?limit=25');
    pick.innerHTML = '<option value="">Choose a draft…</option>' + drafts.map((d) => `<option value="${d.id}">${VC.esc(d.title)} · ${VC.esc(d.kind)}</option>`).join('');
    if (draftId) pick.value = draftId;
  }
  $('pick')?.addEventListener('change', (e) => e.target.value && switchTo(e.target.value));
  $('new')?.addEventListener('click', async () => {
    const { draft } = await VC.api('POST', '/api/drafts', { kind: 'email', by: 'you' });
    await loadPicker(); switchTo(draft.id); editors.body?.ta.focus();
  });

  // Fade the "just changed" highlight.
  setInterval(() => { if (sync?.draft) { for (const f of FIELDS) editors[f]?.paint(); if ($('preview')) render(sync.draft, sync.history); } }, 5000);

  // ---- engines and voices
  function paintEngines() {
    const seg = $('engines'); if (!seg || !status) return;
    seg.innerHTML = Object.entries(status.engines).map(([id, e]) => `<button data-e="${id}" aria-pressed="${id === engine}" title="${VC.esc(e.note)}">${VC.esc(e.label)}</button>`).join('');
    const vs = $('voice');
    if (vs) {
      const saved = localStorage.getItem(VOICE_KEY + '.' + engine);
      vs.innerHTML = status.engines[engine].voices.map((v) => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
      if (saved && status.engines[engine].voices.includes(saved)) vs.value = saved;
    }
    if ($('enote')) $('enote').textContent = status.engines[engine].note;
  }
  $('engines')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-e]'); if (!b || call) return;
    engine = b.dataset.e; localStorage.setItem(ENGINE_KEY, engine); paintEngines();
  });
  $('voice')?.addEventListener('change', (e) => localStorage.setItem(VOICE_KEY + '.' + engine, e.target.value));

  // ---- captions
  let open = null;
  function caption(by, text, final) {
    const box = $('captions'); if (!box) return;
    if (!open || open.dataset.by !== by) { open = document.createElement('p'); open.className = 'c-' + by; open.dataset.by = by; box.append(open); }
    if (final) { open.textContent = text; open = null; } else open.textContent += text;
    while (box.children.length > 30) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }
  function toolNote(name, args, result, err) {
    const box = $('captions'); if (!box) return;
    const p = document.createElement('p'); p.className = 'c-tool';
    p.textContent = (err ? '✕ ' : '✓ ') + name + (err ? ': ' + err.message : '');
    box.append(p); open = null; box.scrollTop = box.scrollHeight;
  }

  // ---- the call
  const talk = $('talk');
  const setState = (text, state) => { if ($('status')) $('status').textContent = text; if (talk) talk.dataset.state = state; document.body.dataset.call = state; };
  let meterTimer;
  function meter() {
    if (!call || !$('meter')) return;
    const s = call.seconds, est = call.estimate();
    $('meter').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ≈ $${est.dollars.toFixed(2)}`;
  }
  async function toggle() {
    if (call) { const c = call; call = null; await c.end(); return; }
    if (!status?.ready) { toast('No OpenAI key yet. See the note below.'); return; }
    try {
      call = await VC.startCall({
        engine, voice: $('voice')?.value, draftId: () => draftId, switchTo: (id) => { loadPicker(); switchTo(id); },
        onStatus: setState, onCaption: caption, onTool: toolNote,
        onLevel: (l) => talk?.style.setProperty('--lvl', l.toFixed(3)),
        onEnd: (sum) => {
          call = null; clearInterval(meterTimer);
          if ($('meter')) $('meter').textContent = `${Math.floor(sum.seconds / 60)}:${String(sum.seconds % 60).padStart(2, '0')} · ≈ $${sum.cost.dollars.toFixed(2)} (${sum.cost.note})`;
          console.info('voice call ended', sum);
          refreshStatus();
        },
      });
      clearInterval(meterTimer); meterTimer = setInterval(meter, 1000);
      if ($('mute')) $('mute').disabled = false;
    } catch (e) {
      call = null; setState('Could not start: ' + e.message, 'idle'); toast(e.message);
    }
  }
  talk?.addEventListener('click', toggle);
  let muted = false;
  $('mute')?.addEventListener('click', (e) => { if (!call) return; muted = !muted; call.mute(muted); e.currentTarget.setAttribute('aria-pressed', muted); });
  addEventListener('keydown', (e) => { if (e.code === 'Space' && e.altKey) { e.preventDefault(); toggle(); } });

  // ---- demo: the colours with no voice
  $('demo')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await VC.demo({ draftId: () => draftId, switchTo: (id) => { loadPicker(); switchTo(id); } }, caption); }
    catch (err) { toast('Demo stopped: ' + err.message); }
    b.disabled = false;
  });

  async function refreshStatus() {
    try { status = await VC.api('GET', '/api/voice/status'); } catch (e) { status = null; }
    if ($('keywarn')) $('keywarn').hidden = Boolean(status?.ready);
    if ($('today') && status) $('today').textContent = `Today: ${status.today.calls} of ${status.limits.dailyCalls} calls, ${status.today.minutes} min. Hangs up after ${status.limits.maxMinutes} min, or ${status.limits.idleMinutes} min of silence.`;
    if (status && !status.engines[engine]) engine = 'live';
    paintEngines();
  }

  refreshStatus();
  loadPicker().catch(() => {});
  switchTo(draftId);
})();
