'use strict';
/* The test card (7 Oct 2026): only in a tester's copy of Meridian (tester/server.js
   adds it to the page). It shows the task they're on, takes Done or Skip and the
   one-question ease rating, follows Owner when he moves them on from the console,
   asks the closing questions, and stands in for the phone notification when a
   pretend agent finishes. Every step is marked in the recording. */
(function(){
  const T=window.MERIDIAN_TESTER; if(!T)return;
  const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tasks=T.tasks||[]; const N=tasks.length;
  let me={task:null,seq:{},finished:null,mode:T.mode};
  let phase='task';            // task | rate | thanks
  let rated=null;              // the task number waiting for a rating
  let folded=sessionStorage.getItem('tt.folded')==='1';
  const mark=(name,data)=>{ try{ window.meridianMark&&window.meridianMark(name,data); }catch{} };
  async function post(p,b){ const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(b||{})}); const j=await r.json().catch(()=>({})); if(!r.ok||j.ok===false)throw new Error(j.error||'Something went wrong'); return j; }
  const taskOf=(n)=>tasks.find(t=>t.n===n);

  const card=document.createElement('aside'); card.className='tt'; card.setAttribute('aria-label','Test');
  document.body.appendChild(card);
  const note=document.createElement('div'); note.className='tt-note'; note.setAttribute('role','status');
  document.body.appendChild(note);

  function head(label){
    return `<header class="tt-h"><button type="button" class="tt-fold" data-tt="fold" aria-expanded="${!folded}"><span class="tt-k">${esc(label)}</span><span class="tt-chev" aria-hidden="true"></span></button>${T.recording?`<button type="button" class="tt-rec" data-tt="stoprec" title="Recording your clicks and typing on this page. Click to stop."><i></i>Recording</button>`:''}</header>`;
  }
  function render(){
    const t=me.task&&!me.task.ended?taskOf(me.task.n):null;
    card.classList.toggle('folded',folded);
    if(phase==='thanks'||(me.finished&&phase!=='rate')){
      card.innerHTML=head('Test finished')+`<div class="tt-b"><p class="tt-t">Thanks${T.name?', '+esc(T.name):''}. That’s everything.</p><p class="tt-x">Feel free to keep looking around. Nothing you do here is sent anywhere.</p>
        <div class="tt-a"><button type="button" class="tt-btn" data-tt="fold">Hide this</button><button type="button" class="tt-link" data-tt="forget">Delete everything I did</button></div></div>`;
      return;
    }
    if(phase==='rate'&&rated){
      const q=T.seq||{text:'Overall, how difficult or easy did you find this task?',low:'Very difficult',high:'Very easy'};
      card.innerHTML=head(`Task ${rated} of ${N}`)+`<div class="tt-b"><p class="tt-q">${esc(q.text)}</p>
        <div class="tt-scale" role="group" aria-label="${esc(q.text)}">${[1,2,3,4,5,6,7].map(v=>`<button type="button" data-seq="${v}" aria-label="${v} of 7">${v}</button>`).join('')}</div>
        <div class="tt-ends"><span>${esc(q.low)}</span><span>${esc(q.high)}</span></div>
        <div class="tt-a"><button type="button" class="tt-link" data-tt="noseq">Skip this</button></div></div>`;
      return;
    }
    if(!t){
      const waiting=me.task&&me.task.ended&&me.task.n<N;
      card.innerHTML=head(T.mode==='self'?'Meridian test':'Meridian test')+`<div class="tt-b">${T.mode==='self'
        ?`<p class="tt-t">${waiting?'Ready for the next one?':`${N} things to try, then a few questions.`}</p><p class="tt-x">About ten minutes. Say what you think in the box as you go: what’s confusing is the useful part.</p><div class="tt-a"><button type="button" class="tt-btn primary" data-tt="next">${waiting?'Next task':'Start'}</button></div>`
        :`<p class="tt-t">Have a look around.</p><p class="tt-x">Owner will give you things to try. They’ll show up here.</p>`}</div>`;
      return;
    }
    card.innerHTML=head(`Task ${t.n} of ${N}`)+`<div class="tt-b"><p class="tt-t">${esc(t.title)}</p><p class="tt-x">${esc(t.text)}</p>
      ${t.ask==='text'?`<textarea class="tt-in" id="tt-answer" rows="3" placeholder="Type your answer"></textarea>`:''}
      ${t.button?`<a class="tt-btn wide" href="${esc(t.button.href)}">${esc(t.button.label)}</a>`:''}
      <div class="tt-a"><button type="button" class="tt-btn primary" data-tt="done">Done</button><button type="button" class="tt-btn" data-tt="skip">Skip</button>${T.mode==='self'?`<button type="button" class="tt-link" data-tt="say">Say something</button>`:''}</div>
      <form class="tt-say" hidden><textarea class="tt-in" rows="2" placeholder="What’s on your mind? Confusing, surprising, nice…"></textarea><button type="submit" class="tt-btn">Send</button></form></div>`;
  }

  async function start(n){
    if(n>N){ openFinal(); return; }
    const t=taskOf(n); me.task={n,at:Date.now()}; phase='task'; render();
    mark('task',{n,title:t&&t.title,state:'start'});
    try{ const j=await post('/t-api/task',{n,state:'start'}); if(j.me)me={...me,...j.me}; }catch{}
  }
  async function finishTask(state){
    const t=me.task&&taskOf(me.task.n); if(!t)return;
    const answer=document.getElementById('tt-answer')?.value||'';
    mark('task',{n:t.n,title:t.title,state});
    me.task={...me.task,ended:Date.now(),outcome:state};
    try{ await post('/t-api/task',{n:t.n,state,answer}); }catch{}
    if(state==='done'&&t.seq){ rated=t.n; phase='rate'; render(); return; }
    start(t.n+1);
  }

  card.addEventListener('click',async e=>{
    const sv=e.target.closest('[data-seq]');
    if(sv&&rated){ const n=rated, v=Number(sv.dataset.seq); rated=null; mark('seq',{n,value:v}); post('/t-api/seq',{n,value:v}).catch(()=>{}); start(n+1); return; }
    const b=e.target.closest('[data-tt]'); if(!b)return; const a=b.dataset.tt;
    if(a==='fold'){ folded=!folded; sessionStorage.setItem('tt.folded',folded?'1':'0'); render(); return; }
    if(a==='done'||a==='skip'){ finishTask(a); return; }
    if(a==='noseq'){ const n=rated; rated=null; start(n+1); return; }
    if(a==='next'){ start(me.task&&me.task.ended?me.task.n+1:(me.task?me.task.n:1)); return; }
    if(a==='say'){ const f=card.querySelector('.tt-say'); f.hidden=!f.hidden; if(!f.hidden)f.querySelector('textarea').focus(); return; }
    if(a==='stoprec'){ if(!confirm('Stop recording? Owner will only have what was recorded so far.'))return; try{ await post('/t-api/consent',{record:false}); location.reload(); }catch(err){ alert(err.message); } return; }
    if(a==='forget'){ if(!confirm('Delete your test copy, your recording and your answers? This can’t be undone.'))return; try{ await post('/t-api/forget'); try{Object.keys(localStorage).filter(k=>k.indexOf('meridian.')===0).forEach(k=>localStorage.removeItem(k));sessionStorage.clear();}catch{} location.href='/welcome'; }catch(err){ alert(err.message); } return; }
  });
  card.addEventListener('submit',async e=>{
    if(!e.target.classList.contains('tt-say'))return; e.preventDefault();
    const box=e.target.querySelector('textarea'); const text=box.value.trim(); if(!text)return;
    try{ await post('/t-api/note',{text}); mark('say',{text}); box.value=''; e.target.hidden=true; flash('Sent to Owner'); }catch(err){ flash(err.message); }
  });

  // ---------- the closing questions
  function openFinal(){
    if(document.querySelector('.tt-final'))return;
    phase='task'; mark('final',{state:'open'});
    const qs=T.final||[]; const ans={};
    const scr=document.createElement('div'); scr.className='tt-final'; scr.setAttribute('role','dialog'); scr.setAttribute('aria-modal','true'); scr.setAttribute('aria-label','A few questions');
    const q=(x)=>{
      if(x.kind==='scale')return `<fieldset class="tt-fq" data-q="${x.id}"><legend>${esc(x.text)}</legend><div class="tt-scale">${[1,2,3,4,5,6,7].map(v=>`<button type="button" data-v="${v}">${v}</button>`).join('')}</div><div class="tt-ends"><span>${esc(x.low)}</span><span>${esc(x.high)}</span></div></fieldset>`;
      if(x.kind==='choice'||x.kind==='multi')return `<fieldset class="tt-fq" data-q="${x.id}" data-kind="${x.kind}"><legend>${esc(x.text)}</legend><div class="tt-pills">${x.options.map(o=>`<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>${x.why?`<textarea class="tt-in" data-why rows="2" placeholder="Why? (optional)"></textarea>`:''}</fieldset>`;
      return `<fieldset class="tt-fq" data-q="${x.id}"><legend>${esc(x.text)}</legend><textarea class="tt-in" data-text rows="3"></textarea></fieldset>`;
    };
    scr.innerHTML=`<div class="tt-sheet"><h2>A few questions</h2><p class="tt-x">Last bit. Short answers are fine, and you can skip any of them.</p>${qs.map(q).join('')}<div class="tt-a end"><span class="tt-x" id="tt-fmsg"></span><button type="button" class="tt-btn primary" data-f="send">Send answers</button></div></div>`;
    document.body.appendChild(scr);
    scr.addEventListener('click',async e=>{
      const v=e.target.closest('[data-v]');
      if(v){ const fs=v.closest('[data-q]'); const id=fs.dataset.q; const kind=fs.dataset.kind;
        if(kind==='multi'){ v.classList.toggle('on'); ans[id]=[...fs.querySelectorAll('[data-v].on')].map(b=>b.dataset.v); }
        else{ fs.querySelectorAll('[data-v]').forEach(b=>b.classList.toggle('on',b===v)); ans[id]=/^\d$/.test(v.dataset.v)&&!kind?Number(v.dataset.v):v.dataset.v; }
        return; }
      if(e.target.closest('[data-f="send"]')){
        scr.querySelectorAll('[data-q]').forEach(fs=>{ const t=fs.querySelector('[data-text]'); if(t&&t.value.trim())ans[fs.dataset.q]=t.value.trim(); const w=fs.querySelector('[data-why]'); if(w&&w.value.trim())ans.weekWhy=w.value.trim(); });
        const btn=e.target.closest('[data-f]'); btn.disabled=true;
        try{ await post('/t-api/answers',{answers:ans}); mark('final',{state:'sent'}); scr.remove(); me.finished=Date.now(); phase='thanks'; folded=false; render(); }
        catch(err){ document.getElementById('tt-fmsg').textContent=err.message; btn.disabled=false; }
      }
    });
    setTimeout(()=>scr.classList.add('on'),20);
  }

  // ---------- when a pretend agent finishes: what the phone would buzz with
  let noteTimer=0;
  function flash(text,action){
    note.innerHTML=`<i></i><span>${text}</span>${action?`<button type="button">${esc(action.label)}</button>`:''}`;
    note.classList.add('on'); clearTimeout(noteTimer); noteTimer=setTimeout(()=>note.classList.remove('on'),action?14000:3500);
    if(action)note.querySelector('button').onclick=()=>{ note.classList.remove('on'); action.run(); };
  }
  function runDone(d){
    mark('agent-done',{id:d.id,title:d.title});
    flash(`<b>${esc(d.model||'Your agent')}</b> finished “${esc(d.title||'')}”`,{label:'Open report',run:()=>{ mark('open-report',{id:d.id,from:'notification'}); window.open('/delegations/'+encodeURIComponent(d.id)+'/REPORT.md','_blank','noopener'); }});
  }

  // ---------- the live line to the server: Owner moving tasks on, agents finishing
  function listen(){
    const es=new EventSource('/t-api/events');
    es.addEventListener('me',e=>{ try{ const m=JSON.parse(e.data); me={...me,...m};
      if(m.task&&!m.task.ended&&phase==='rate'&&rated&&m.task.n!==rated){ rated=null; phase='task'; }
      if(m.finished&&phase!=='rate')phase='thanks'; if(!m.finished&&phase==='thanks')phase='task';
      render(); }catch{} });
    es.addEventListener('task',e=>{ try{ const d=JSON.parse(e.data); me.task=d.task; rated=null; phase='task'; if(d.task){ mark('task',{n:d.task.n,title:taskOf(d.task.n)?.title,state:'start',by:'moderator'}); if(folded){ folded=false; sessionStorage.setItem('tt.folded','0'); } } render(); }catch{} });
    es.addEventListener('run',e=>{ try{ runDone(JSON.parse(e.data)); }catch{} });
    es.addEventListener('finish',()=>openFinal());
  }
  render(); listen();
})();
