// Voice prototype (6 Oct 2026), shared by /voice/index.html (laptop) and
// /voice/call.html (phone). Four parts:
//   1. who wrote what: replays a draft's history ({rev, by, at, field, before,
//      after}, from drafts.js) word by word, so every piece of text carries the
//      name of whoever last wrote it, and paints it in their colour.
//   2. live sync: the draft's event stream, plus a textarea Owner can type in
//      while the voice edits, with his typing rebased onto the voice's changes.
//   3. the call: WebRTC to OpenAI, set up by /api/voice/session (voice.js) so
//      the key stays on Home.
//   4. the tools the voice calls, run here against /api/drafts as "Voice · …".
// Nothing here touches drafts.js or draft.html; it only uses /api/drafts.
'use strict';

const VC = (() => {
  // ------------------------------------------------------------ 1. who wrote what

  // Colour classes. The draft-review design may settle on its own; these are in voice.css as --w-*.
  function who(by) {
    const b = String(by || '');
    if (!b || /^you$/i.test(b)) return { cls: 'you', label: 'You' };
    if (/^dot\b/i.test(b)) return { cls: 'dot', label: b };
    if (/^voice/i.test(b)) return { cls: 'voice', label: b };
    return { cls: 'agent', label: b };
  }

  const isSpace = (c) => c === undefined || /\s/.test(c);
  const tokens = (s) => s.match(/\s+|\S+/g) || [];

  // a → b as [{t:'=', s}, {t:'-', s}, {t:'+', s}]: trims the shared start and
  // end (snapped to whole words), then a word-level LCS on what's left.
  function diff(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a === b) return a ? [{ t: '=', s: a }] : [];
    const n = Math.min(a.length, b.length);
    let p = 0;
    while (p < n && a[p] === b[p]) p++;
    while (p > 0 && !isSpace(a[p - 1]) && (!isSpace(a[p]) || !isSpace(b[p]))) p--;
    let s = 0;
    while (s < n - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    while (s > 0 && !isSpace(a[a.length - s]) && (!isSpace(a[a.length - s - 1]) || !isSpace(b[b.length - s - 1]))) s--;
    const out = [];
    const push = (t, str) => { if (!str) return; const last = out[out.length - 1]; if (last && last.t === t) last.s += str; else out.push({ t, s: str }); };
    push('=', a.slice(0, p));
    const A = tokens(a.slice(p, a.length - s)), B = tokens(b.slice(p, b.length - s));
    if (A.length * B.length > 2.5e6) { push('-', A.join('')); push('+', B.join('')); }
    else {
      const W = B.length + 1, L = new Uint32Array((A.length + 1) * W);
      for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
        L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      let i = 0, j = 0;
      while (i < A.length && j < B.length) {
        if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
        else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) push('-', A[i++]);
        else push('+', B[j++]);
      }
      while (i < A.length) push('-', A[i++]);
      while (j < B.length) push('+', B[j++]);
    }
    push('=', b.slice(b.length - s));
    return tidy(out);
  }

  // A lone space kept between two changes splits one rewrite into word-sized
  // pieces. Fold it into the change, then group each run of changes as one
  // delete and one insert.
  function tidy(ops) {
    const out = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      const between = o.t === '=' && /^\s+$/.test(o.s) && i > 0 && i < ops.length - 1 && ops[i - 1].t !== '=' && ops[i + 1].t !== '=';
      if (o.t === '=' && !between) { out.push({ ...o }); continue; }
      let run = out[out.length - 1];
      if (!run || run.t === '=') { run = { t: 'run', del: '', ins: '' }; out.push(run); }
      if (between) { run.del += o.s; run.ins += o.s; } else if (o.t === '-') run.del += o.s; else run.ins += o.s;
    }
    return out.flatMap((o) => (o.t !== 'run' ? [o] : [...(o.del ? [{ t: '-', s: o.del }] : []), ...(o.ins ? [{ t: '+', s: o.ins }] : [])]));
  }

  // owners[i] says who wrote character i. Apply one change, crediting new text to `m`.
  function applyOps(owners, ops, m) {
    const out = []; let i = 0;
    for (const o of ops) {
      if (o.t === '=') { for (let k = 0; k < o.s.length; k++) out.push(owners[i + k] ?? 0); i += o.s.length; }
      else if (o.t === '-') i += o.s.length;
      else for (let k = 0; k < o.s.length; k++) out.push(m);
    }
    return out;
  }

  // Spans [{text, by, at}] for one field. `current` is what's on screen; if it
  // has moved on from the last history entry (Owner typing, or an edit the
  // history hasn't caught up with), the difference goes to `pendingBy`.
  function authorship(history, field, current, pendingBy = 'you') {
    const metas = [{ by: '', at: null }];
    let text = '', owners = [];
    for (const e of history || []) {
      if (e.field !== field) continue;
      if (e.before !== text) { text = e.before || ''; owners = new Array(text.length).fill(0); }
      const m = metas.push({ by: e.by, at: e.at }) - 1;
      owners = applyOps(owners, diff(text, e.after), m);
      text = e.after || '';
    }
    if (current != null && current !== text) {
      const m = metas.push({ by: pendingBy, at: new Date().toISOString(), pending: true }) - 1;
      owners = applyOps(owners, diff(text, current), m);
      text = current;
    }
    const spans = [];
    for (let i = 0; i < text.length; i++) {
      const last = spans[spans.length - 1];
      if (last && last.m === owners[i]) last.text += text[i];
      else spans.push({ m: owners[i], text: text[i], ...metas[owners[i]] });
    }
    return spans;
  }

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const FRESH_MS = 25000;

  function spansHTML(spans) {
    const now = Date.now();
    return spans.map((s) => {
      const w = who(s.by);
      const fresh = s.at && now - Date.parse(s.at) < FRESH_MS ? ' fresh' : '';
      const title = s.by ? `${w.label}${s.at ? ', ' + clock(s.at) : ''}` : 'Before history began';
      return `<span class="w w-${s.by ? w.cls : 'old'}${fresh}" title="${esc(title)}">${esc(s.text)}</span>`;
    }).join('');
  }

  // Where position `pos` in a ends up in b, given ops a → b.
  // after: a position on the edge of an insertion lands after it, not before.
  function mapPos(ops, pos, after = false) {
    let ai = 0, bi = 0;
    for (const o of ops) {
      const len = o.s.length;
      if (o.t === '+') { if (ai < pos || (after && ai === pos)) bi += len; continue; }
      const inside = after ? pos < ai + len : pos <= ai + len;
      if (o.t === '=') { if (inside) return bi + (pos - ai); ai += len; bi += len; }
      else { if (inside) return bi; ai += len; }
    }
    return bi;
  }

  // Owner typed (base → mine) while the voice changed it (base → theirs). Put
  // his one splice on top of theirs if it doesn't overlap; null if it does.
  function rebase(base, mine, theirs) {
    if (theirs === base) return mine;
    if (mine === base) return theirs;
    const n = Math.min(base.length, mine.length);
    let p = 0; while (p < n && base[p] === mine[p]) p++;
    let s = 0; while (s < n - p && base[base.length - 1 - s] === mine[mine.length - 1 - s]) s++;
    const start = p, end = base.length - s, ins = mine.slice(p, mine.length - s);
    const ops = diff(base, theirs);
    let ai = 0;
    for (const o of ops) {
      if (o.t === '+') { if (ai > start && ai < end) return null; continue; }
      if (o.t === '-' && start < ai + o.s.length && end > ai) return null;
      if (o.t === '-' && start === end && start > ai && start < ai + o.s.length) return null;
      ai += o.s.length;
    }
    const ns = mapPos(ops, start, start < end), ne = Math.max(ns, mapPos(ops, end));
    return theirs.slice(0, ns) + ins + theirs.slice(ne);
  }

  // ------------------------------------------------------------ 2. live sync

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  }

  // One draft, kept current. onChange(draft, history) after every change from anyone.
  function openDraft(id, onChange) {
    const st = { id, draft: null, history: [], es: null, closed: false };
    let pending = null;
    async function refresh(d) {
      const h = await api('GET', `/api/drafts/${id}/history`).catch(() => ({ history: st.history }));
      st.draft = d || (await api('GET', `/api/drafts/${id}`)).draft;
      st.history = h.history || [];
      onChange(st.draft, st.history);
    }
    st.ready = refresh();
    st.es = new EventSource(`/api/drafts/${id}/stream`);
    st.es.addEventListener('draft', (e) => {
      const d = JSON.parse(e.data);
      if (st.draft && d.rev === st.draft.rev) return;
      clearTimeout(pending); pending = setTimeout(() => refresh(d), 60);
    });
    st.close = () => { st.closed = true; st.es?.close(); };
    return st;
  }

  // A textarea with the coloured text drawn behind it. Owner types in the
  // textarea (its own text is transparent); the layer behind shows who wrote what.
  function editor(root, field, { getSync, onToast } = {}) {
    root.classList.add('ed');
    root.innerHTML = '<div class="ed-back" aria-hidden="true"></div><textarea class="ed-ta" rows="1" spellcheck="true"></textarea>';
    const back = root.querySelector('.ed-back'), ta = root.querySelector('.ed-ta');
    ta.placeholder = root.dataset.placeholder || '';
    let base = '', dirty = false, timer = null, saving = null;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    function paint() {
      const s = getSync();
      back.innerHTML = spansHTML(authorship(s?.history, field, ta.value, 'you')) + '​\n';
      grow();
    }
    async function save() {
      const s = getSync(); if (!s?.draft) return;
      dirty = false;
      const theirs = s.draft[field] ?? '';
      let next = rebase(base, ta.value, theirs);
      if (next == null) {
        const mine = ta.value;
        next = theirs;
        onToast?.('Your typing clashed with an edit from ' + who(s.draft.lastBy).label + '. Kept theirs.', { label: 'Put mine back', run: () => api('PATCH', `/api/drafts/${s.id}`, { [field]: mine, by: 'you' }) });
        set(theirs, true);
        return;
      }
      if (next === theirs) { set(theirs, true); return; }
      saving = api('PATCH', `/api/drafts/${s.id}`, { [field]: next, by: 'you' }).then((j) => { base = j.draft[field] ?? ''; }).catch((e) => onToast?.('Not saved: ' + e.message)).finally(() => { saving = null; });
      await saving;
    }
    function set(value, force) {
      if (dirty && !force) return;          // his typing wins until it's saved, then rebases
      const old = ta.value;
      base = value;
      if (old !== value) {
        const focused = document.activeElement === ta;
        const a = ta.selectionStart, b = ta.selectionEnd;
        const ops = diff(old, value);
        ta.value = value;
        if (focused) ta.setSelectionRange(mapPos(ops, a), mapPos(ops, b));
      }
      paint();
    }
    ta.addEventListener('input', () => { dirty = true; paint(); clearTimeout(timer); timer = setTimeout(save, 450); });
    ta.addEventListener('blur', () => { if (dirty) { clearTimeout(timer); save(); } });
    new ResizeObserver(grow).observe(root);
    return { set, paint, get value() { return ta.value; }, get dirty() { return dirty; }, flush: () => (dirty ? save() : saving), ta };
  }

  // ------------------------------------------------------------ 4. the tools

  const FIELDS = ['to', 'cc', 'subject', 'title', 'where', 'body'];
  function readable(d) {
    return { id: d.id, kind: d.kind, to: d.to, cc: d.cc, subject: d.subject, where: d.where, title: d.title, body: d.body, status: d.status, approved: d.status === 'ready' && d.approvedRev === d.rev };
  }

  // ctx: { draftId(), by, switchTo(id), space }
  async function runTool(name, args, ctx) {
    const id = ctx.draftId();
    const need = () => { if (!id) throw new Error('No draft is open. Use draft_create first.'); return id; };
    const fresh = async () => (await api('GET', `/api/drafts/${need()}`)).draft;
    const field = (f) => { const x = f || 'body'; if (!FIELDS.includes(x)) throw new Error('field must be one of ' + FIELDS.join(', ')); return x; };
    switch (name) {
      case 'draft_read': return readable(await fresh());
      case 'draft_replace_text': {
        const f = field(args.field), d = await fresh(), text = d[f] || '', find = String(args.find || '');
        if (!find) throw new Error('find is empty');
        const count = text.split(find).length - 1;
        if (count === 0) throw new Error(`That text isn't in the ${f} any more (Owner may have changed it). Call draft_read and try again.`);
        if (count > 1) throw new Error(`That text appears ${count} times in the ${f}. Include more words so it's unique.`);
        const j = await api('PATCH', `/api/drafts/${d.id}`, { [f]: text.replace(find, () => String(args.replace ?? '')), by: ctx.by });
        return { ok: true, field: f, rev: j.draft.rev };
      }
      case 'draft_set_field': {
        const f = field(args.field);
        const j = await api('PATCH', `/api/drafts/${need()}`, { [f]: String(args.value ?? ''), by: ctx.by });
        return { ok: true, field: f, rev: j.draft.rev };
      }
      case 'draft_append': {
        const d = await fresh();
        const body = (d.body || '').replace(/\s+$/, '');
        const j = await api('PATCH', `/api/drafts/${d.id}`, { body: (body ? body + '\n\n' : '') + String(args.text || '').trim(), by: ctx.by });
        return { ok: true, rev: j.draft.rev };
      }
      case 'draft_create': {
        const { kind = 'email', to = '', subject = '', body = '' } = args;
        const j = await api('POST', '/api/drafts', { kind, to, subject, body, by: ctx.by, ...(ctx.space ? { space: ctx.space } : {}) });
        ctx.switchTo(j.draft.id);
        return { ok: true, id: j.draft.id, note: 'Now on screen.' };
      }
      default: throw new Error('unknown tool ' + name);
    }
  }

  // ------------------------------------------------------------ 3. the call

  // opts: { engine, voice, draftId(), switchTo(id), onStatus(text, state), onCaption(who, text, final), onLevel(0..1), onTool(name, args, result|error), onEnd(summary) }
  async function startCall(opts) {
    const t0 = Date.now();
    const status = (t, s) => opts.onStatus?.(t, s);
    status('Connecting…', 'connecting');
    const pc = new RTCPeerConnection();
    const audio = new Audio(); audio.autoplay = true; audio.playsInline = true;
    pc.addEventListener('track', (e) => { audio.srcObject = e.streams[0] || new MediaStream([e.track]); audio.play().catch(() => status('Tap anywhere to hear the voice', 'live')); });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
    const dc = pc.createDataChannel('oai-events');

    // Mic level, for the ring and the silence timer.
    let lastHeard = Date.now();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 512;
    ac.createMediaStreamSource(mic).connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const meter = () => { an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; const rms = Math.sqrt(sum / buf.length); if (rms > 0.02) lastHeard = Date.now(); opts.onLevel?.(Math.min(1, rms * 8)); raf = requestAnimationFrame(meter); };
    meter();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== 'complete') await new Promise((res) => { const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); res(); } }; pc.addEventListener('icegatheringstatechange', done); setTimeout(res, 3000); });
    let session;
    try {
      session = await api('POST', '/api/voice/session', { engine: opts.engine, voice: opts.voice, draftId: opts.draftId(), sdp: pc.localDescription.sdp });
    } catch (e) { cleanup(); throw e; }
    await pc.setRemoteDescription({ type: 'answer', sdp: session.sdp });

    const live = opts.engine === 'live';
    const ctx = { draftId: opts.draftId, by: session.by, switchTo: opts.switchTo };
    const seen = new Set();
    let usage = null, waitingCreate = false, ended = false, closedResolve = null;
    const send = (o) => { if (dc.readyState === 'open') dc.send(JSON.stringify(o)); };
    const log = [];

    async function call(callId, name, argsText) {
      if (!callId || seen.has(callId)) return;
      seen.add(callId);
      let args = {}; try { args = typeof argsText === 'string' ? JSON.parse(argsText || '{}') : (argsText || {}); } catch { /* bad JSON: run with nothing */ }
      let output;
      try { const r = await runTool(name, args, ctx); output = r; opts.onTool?.(name, args, r); }
      catch (e) { output = { error: String(e.message || e) }; opts.onTool?.(name, args, null, e); }
      const item = { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) };
      if (live) { send({ type: 'response.item.create', item }); send({ type: 'response.create' }); }
      else { send({ type: 'conversation.item.create', item }); waitingCreate = true; }
    }

    // Function calls can arrive nested (GPT-Live wraps the backend's events), so look anywhere.
    function findCalls(o, depth = 0) {
      if (!o || typeof o !== 'object' || depth > 5) return;
      if (o.type === 'function_call' && o.call_id && o.name && (o.arguments != null)) call(o.call_id, o.name, o.arguments);
      for (const v of Object.values(o)) if (v && typeof v === 'object') findCalls(v, depth + 1);
    }

    dc.addEventListener('message', ({ data }) => {
      let ev; try { ev = JSON.parse(data); } catch { return; }
      log.push(ev.type); if (log.length > 400) log.shift();
      const type = String(ev.type || '');
      if (type === 'session.started' || type === 'session.created') status('Listening', 'live');
      if (type === 'error' || type.endsWith('.failed')) { console.warn('voice', ev); status('Error: ' + (ev.error?.message || type), 'live'); }
      if (type === 'response.function_call_arguments.done') call(ev.call_id, ev.name, ev.arguments);
      else findCalls(ev);
      if (/transcript/.test(type) && (ev.delta || ev.transcript)) {
        const by = /input|user/.test(type) ? 'you' : 'voice';
        if (ev.delta) opts.onCaption?.(by, ev.delta, false);
        else opts.onCaption?.(by, ev.transcript, true);
        lastHeard = Date.now();
      }
      if (type === 'response.done') {
        const u = ev.response?.usage;
        if (u) usage = addUsage(usage, u);
        if (waitingCreate) { waitingCreate = false; send({ type: 'response.create' }); }
      }
      if (type === 'session.closed') { if (ev.usage) usage = ev.usage; closedResolve?.(); }
    });
    dc.addEventListener('open', () => status('Listening', 'live'));
    pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && !ended) end('dropped'); });

    const limits = session.limits || { maxMinutes: 15, idleMinutes: 3 };
    const tick = setInterval(() => {
      if (Date.now() - t0 > limits.maxMinutes * 60000) end('limit');
      else if (Date.now() - lastHeard > limits.idleMinutes * 60000) end('silence');
    }, 5000);

    function cleanup() {
      cancelAnimationFrame(raf); clearInterval(tick);
      mic.getTracks().forEach((t) => t.stop());
      try { ac.close(); } catch { /* already closed */ }
      try { dc.close(); } catch { /* already closed */ }
      try { pc.close(); } catch { /* already closed */ }
      audio.srcObject = null;
    }

    async function end(reason = 'hung up') {
      if (ended) return; ended = true;
      status(reason === 'hung up' ? 'Ending…' : `Ending (${reason})…`, 'ending');
      if (live && dc.readyState === 'open') {
        send({ type: 'session.close' });
        await new Promise((res) => { closedResolve = res; setTimeout(res, 4000); });
      }
      cleanup();
      const seconds = Math.round((Date.now() - t0) / 1000);
      api('POST', '/api/voice/usage', { engine: opts.engine, seconds, usage, draftId: opts.draftId() }).catch(() => {});
      const summary = { engine: opts.engine, seconds, usage, reason, cost: estimate(opts.engine, seconds, usage), events: log.slice(-40) };
      status(`Ended (${reason})`, 'idle');
      opts.onEnd?.(summary);
      return summary;
    }

    return { end, mute(on) { mic.getAudioTracks().forEach((t) => { t.enabled = !on; }); }, get seconds() { return Math.round((Date.now() - t0) / 1000); }, estimate: () => estimate(opts.engine, Math.round((Date.now() - t0) / 1000), usage), session };
  }

  function addUsage(a, u) {
    const out = a ? { ...a } : {};
    const bump = (k, v) => { out[k] = (out[k] || 0) + (Number(v) || 0); };
    bump('input_audio', u.input_token_details?.audio_tokens);
    bump('input_text', u.input_token_details?.text_tokens);
    bump('input_cached', u.input_token_details?.cached_tokens);
    bump('output_audio', u.output_token_details?.audio_tokens);
    bump('output_text', u.output_token_details?.text_tokens);
    return out;
  }

  // Rough dollars. GPT-Live: the clock ($0.05/min); backend tokens aren't in the
  // browser's view, so they're left out. Realtime: OpenAI's audio token prices,
  // text guessed at a tenth of audio.
  function estimate(engine, seconds, usage) {
    if (engine === 'live') return { dollars: seconds / 60 * 0.05, note: 'voice only; Sol tokens extra (a few cents)' };
    const rate = engine === 'realtime-mini' ? { ia: 10, it: 0.6, ic: 0.3, oa: 20, ot: 2.4 } : { ia: 32, it: 4, ic: 0.4, oa: 64, ot: 16 };
    if (!usage) return { dollars: seconds / 60 * (engine === 'realtime-mini' ? 0.03 : 0.08), note: 'guess from time' };
    const M = 1e6;
    const d = ((usage.input_audio || 0) - (usage.input_cached || 0)) / M * rate.ia + (usage.input_text || 0) / M * rate.it + (usage.input_cached || 0) / M * rate.ic + (usage.output_audio || 0) / M * rate.oa + (usage.output_text || 0) / M * rate.ot;
    return { dollars: Math.max(0, d), note: 'from token counts' };
  }

  // ------------------------------------------------------------ demo (no voice, no API)

  // Plays a short scripted call so the colours can be seen without spending
  // anything. It writes for real, as "Voice · Demo", into a draft in the
  // voice-demo space (create one, or use the open one).
  async function demo(ctx, onCaption) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const say = async (t) => { onCaption?.('voice', t, true); await wait(900 + t.length * 18); };
    const c = { ...ctx, by: 'Voice · Demo', space: 'voice-demo' };
    if (!ctx.draftId()) {
      await say("Let's start an email to Sam about Thursday.");
      await runTool('draft_create', { kind: 'email', to: 'Sam <sam@example.com>', subject: 'Thursday', body: 'Hi Sam,\n\nThanks for sending the brief over. I can do Thursday afternoon, from about two.\n\nWould it help if I brought the early sketches? They are rough, but they show the direction.\n\nBest,\nOwner' }, c);
      await wait(1500);
    }
    await say('I made the second paragraph a bit warmer.');
    const d = await runTool('draft_read', {}, c);
    const body = d.body || '';
    const para = body.split(/\n\n/)[2] || body.split(/\n\n/)[1];
    if (para) await runTool('draft_replace_text', { find: para, replace: "I'll bring the early sketches too. They're rough, but they'll give you a feel for where it's heading." }, c);
    await wait(1800);
    await say('Want me to add a line about the deadline? I\'ve put one at the end. Change anything you like.');
    await runTool('draft_append', { text: 'P.S. If Friday works better for the review, just say.' }, c);
  }

  return { who, diff, authorship, spansHTML, rebase, mapPos, api, openDraft, editor, runTool, startCall, estimate, demo, esc, clock };
})();

if (typeof module !== 'undefined') module.exports = VC;
