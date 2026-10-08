'use strict';
/* Feel (8 Oct 2026): the parts of the Nothing rebuild (/design/nothing/rebuild.html) that Owner picked, made to
   work on the real dashboard and the phone. Sounds, the tick that crosses off with a pixel burst and the chime,
   the sky arc, agent rings that time a job against your own history, Launch into Standby, and rockets.
   Being tried in lab first (/command?lab, board at /design/nothing-picks/). Every look can use it; the colours
   come from the page's own --accent and --ink.

   Feel.init({opt}) once. opt(key) returns the current choice for: sound (off|key|all), tickfx (dots|pixels|plain),
   rings (time|honest|pulse), pomo (off|on), rockets (off|rocket|lander|both). Reduced motion turns off the
   moving parts and keeps the sounds, which have their own off switch. */
(function(){
const RM=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const DPR=Math.min(2,window.devicePixelRatio||1);
const pad=n=>String(n).padStart(2,'0');
let opt=()=>undefined;
const css=(name,fb)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fb;
const rgb=(c)=>{ const m=String(c).match(/^#([0-9a-f]{6})$/i); if(m){ const n=parseInt(m[1],16); return `${n>>16&255},${n>>8&255},${n&255}`; }
  const r=String(c).match(/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/); return r?`${r[1]},${r[2]},${r[3]}`:'255,255,255'; };
const accent=()=>rgb(css('--accent','#d71921')), ink=()=>rgb(css('--ink','#ffffff'));

/* ---------- sound: tiny synthesised notes, straight from the rebuild ---------- */
let AC=null;
const ac=()=>{ if(!AC){ try{ AC=new (window.AudioContext||window.webkitAudioContext)(); }catch{ return null; } } if(AC.state==='suspended')AC.resume().catch(()=>{}); return AC; };
// The first press anywhere wakes the audio, so a chime that arrives later (an agent landing) can play.
addEventListener('pointerdown',()=>{ if(opt('sound')&&opt('sound')!=='off')ac(); },{capture:true,once:true});
const soundOn=(level='key')=>{ const s=opt('sound')||'off'; return s==='all'||(s==='key'&&level==='key'); };
function blip(f,d,type,vol,when=0){ const a=ac(); if(!a)return; const t=a.currentTime+when;
  const o=a.createOscillator(), g=a.createGain(), lp=a.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=4200;
  o.type=type; o.frequency.setValueAtTime(f,t); o.frequency.exponentialRampToValueAtTime(f*.6,t+d);
  g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.0001,t+d);
  o.connect(lp).connect(g).connect(a.destination); o.start(t); o.stop(t+d+.02); }
function noise(len,from,to,peak=.22){ const a=ac(); if(!a)return; const t=a.currentTime;
  const b=a.createBuffer(1,Math.round(a.sampleRate*len),a.sampleRate), d=b.getChannelData(0); for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
  const s=a.createBufferSource(); s.buffer=b; const bp=a.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=2.5;
  bp.frequency.setValueAtTime(from,t); bp.frequency.exponentialRampToValueAtTime(to,t+len);
  const g=a.createGain(); g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(peak,t+len*.25); g.gain.exponentialRampToValueAtTime(.0001,t+len);
  s.connect(bp).connect(g).connect(a.destination); s.start(t); s.stop(t+len); }
const SOUNDS={
  tick:()=>blip(2100,.03,'square',.035),                                   // a button
  type:()=>blip(2400+Math.random()*400,.015,'square',.012),                // a key in a text box
  chime:()=>{ blip(880,.07,'triangle',.08); blip(1320,.09,'triangle',.07,.07); }, // the two-note chime: done
  wake:()=>{ blip(523,.18,'sine',.06); blip(784,.22,'sine',.05,.06); blip(1046,.3,'sine',.04,.12); },
  launch:()=>noise(1.4,200,2600),
  land:()=>noise(1.4,2400,180),
  rocket:()=>{ noise(.7,260,3200,.16); blip(140,.18,'sine',.09); },
  lander:()=>{ noise(1,2200,300,.12); blip(1320,.09,'triangle',.06,.85); blip(880,.12,'triangle',.07,.94); },
  end:()=>{ [0,.16,.32].forEach((w,i)=>{ blip(880,.07,'triangle',.08,w+i*.02); blip(1320,.09,'triangle',.07,w+.07); }); }, // a focus block is over
};
const UI=new Set(['tick','type']);
function play(name){ if(!soundOn(UI.has(name)?'ui':'key'))return; try{ SOUNDS[name]?.(); }catch{} }
// With sound on everything, every button gives the little tick, the way the rebuild did.
document.addEventListener('pointerdown',e=>{ if(opt('sound')==='all'&&e.target.closest('button,[role=button],a.btn')&&!e.target.closest('.tick,[data-feel-quiet]'))play('tick'); },true);
document.addEventListener('keydown',e=>{ if(opt('sound')==='all'&&e.key.length===1&&!e.metaKey&&!e.ctrlKey&&e.target.matches?.('input,textarea,[contenteditable]'))play('type'); },true);

/* ---------- one canvas over everything for bursts, rockets and the warp ---------- */
const FX={c:null,x:null,parts:[],craft:[],warp:null,raf:0,last:0};
function fxCanvas(){ if(FX.c)return; const c=FX.c=document.createElement('canvas'); c.className='feel-fx'; c.setAttribute('aria-hidden','true'); document.body.appendChild(c); size(); addEventListener('resize',size); }
function size(){ if(!FX.c)return; FX.c.width=innerWidth*DPR; FX.c.height=innerHeight*DPR; FX.x=FX.c.getContext('2d'); FX.x.setTransform(DPR,0,0,DPR,0,0); }
function kick(){ fxCanvas(); if(!FX.raf){ FX.last=performance.now(); FX.raf=requestAnimationFrame(frame); } }
function frame(now){ if(RM()){ FX.parts=[]; FX.craft=[]; FX.warp=null; } const dt=Math.min(.05,(now-FX.last)/1000); FX.last=now; const x=FX.x; x.clearRect(0,0,innerWidth,innerHeight);
  drawWarp(x,dt); drawParts(x,dt); drawCraft(x,dt);
  if(FX.parts.length||FX.craft.length||FX.warp)FX.raf=requestAnimationFrame(frame); else { FX.raf=0; x.clearRect(0,0,innerWidth,innerHeight); } }
const snap=(v,g)=>Math.round(v/g)*g;
function dot(x,cx,cy,r,col,a,square){ x.fillStyle=`rgba(${col},${Math.max(0,Math.min(1,a))})`; if(square){ x.fillRect(cx-r,cy-r,r*2,r*2); return; } x.beginPath(); x.arc(cx,cy,r,0,6.283); x.fill(); }
function drawParts(x,dt){ FX.parts=FX.parts.filter(p=>p.life>0);
  for(const p of FX.parts){ p.x+=p.vx*dt; p.y+=p.vy*dt; p.vy+=(p.g??260)*dt; p.vx*=.97; p.life-=dt*(p.fade??1.4);
    // snapped to a grid so it stays dot-matrix
    const g=p.square?5:4; dot(x,snap(p.x,g),snap(p.y,g),p.r??1.8,p.col,p.life,p.square); } }

/* ---------- ticking a to-do: the line crosses it off, a pixel burst and the chime ---------- */
function burst(cx,cy,{n=26,spread=190,square=false}={}){ if(RM())return; kick(); const a=accent(), w=ink();
  for(let i=0;i<n;i++){ const ang=Math.random()*6.283, v=60+Math.random()*spread; FX.parts.push({x:cx,y:cy,vx:Math.cos(ang)*v,vy:Math.sin(ang)*v,life:1,col:i%3===0?a:w,square,r:square?2:1.8}); } }
// btn: the round tick. text: the words to cross off. Resolves when the row has had its moment, so the
// caller can redraw the list after it rather than under it.
function done(btn,text){
  const style=opt('tickfx')||'dots';
  if(text&&style!=='plain'&&!text.querySelector('.feel-x')){ const s=document.createElement('span'); s.className='feel-x'; while(text.firstChild)s.appendChild(text.firstChild); text.appendChild(s); }
  text?.closest('.row,li')?.classList.add('feel-done');
  btn?.classList.add('feel-ticked');
  play('chime');
  if(btn&&style!=='plain'){ const r=btn.getBoundingClientRect(); burst(r.left+r.width/2,r.top+r.height/2,{square:style==='pixels'}); }
  return new Promise(res=>setTimeout(res,style==='plain'||RM()?120:620));
}
function undone(btn,text){ text?.closest('.row,li')?.classList.remove('feel-done'); btn?.classList.remove('feel-ticked'); const s=text?.querySelector('.feel-x'); if(s){ while(s.firstChild)text.insertBefore(s.firstChild,s); s.remove(); } play('tick'); }

/* ---------- the sky arc: dots from sunrise to sunset, the sun where it is now, the meridian through noon ---------- */
const mins=(t)=>{ const m=String(t||'').match(/(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:null; };
function skyArc(c,{rise='07:00',set='19:00',now=new Date(),dots=81,big=false}={}){
  const r=c.getBoundingClientRect(); if(!r.width||!r.height)return;
  if(c.width!==Math.round(r.width*DPR)||c.height!==Math.round(r.height*DPR)){ c.width=Math.round(r.width*DPR); c.height=Math.round(r.height*DPR); }
  const x=c.getContext('2d'); x.setTransform(DPR,0,0,DPR,0,0); x.clearRect(0,0,r.width,r.height);
  const w=ink(), a=accent(); const R0=mins(rise)??420, S0=mins(set)??1140;
  const cx=r.width/2, cy=r.height-4, RX=r.width/2-14, RY=r.height-16; const m=now.getHours()*60+now.getMinutes()+now.getSeconds()/60;
  const f=Math.max(0,Math.min(1,(m-R0)/(S0-R0))); const up=m>=R0&&m<=S0; const dr=big?2.4:1.7;
  for(let i=0;i<dots;i++){ const p=i/(dots-1), ang=Math.PI*(1-p); dot(x,cx+Math.cos(ang)*RX,cy-Math.sin(ang)*RY,dr,w,up&&p<=f?.85:.18); }
  for(let y=cy;y>cy-RY-8;y-=7)dot(x,cx,y,big?1.6:1.2,w,.14); // the meridian: straight up through noon
  x.fillStyle=`rgba(${w},.5)`; x.fillRect(0,cy,r.width,1);
  // At night the sun waits below the horizon, at the end it set or the start it rises from.
  const night=!up, fx=night?(m>S0?1:0):f, ang=Math.PI*(1-fx); const sx=cx+Math.cos(ang)*RX, sy=night?cy+7:cy-Math.sin(ang)*RY;
  if(up){ const g=x.createRadialGradient(sx,sy,0,sx,sy,big?34:22); g.addColorStop(0,`rgba(${a},.55)`); g.addColorStop(1,`rgba(${a},0)`); x.fillStyle=g; x.beginPath(); x.arc(sx,sy,big?34:22,0,6.283); x.fill(); }
  dot(x,sx,sy,up?(big?9:6):(big?5:4),a,up?1:.45);
}

/* ---------- agent rings: 36 dots, lit as the job goes ---------- */
// How far along is a guess. Agents' own guesses run short, so Meridian times each one against how long jobs
// like it have taken you before, and says so when it's running long.
//   time:   elapsed over your usual; past it, a second lap in red counts the overrun
//   honest: creeps towards full but never gets there until it's done (1 - e^-t)
//   pulse:  no progress at all, just a dot going round while it's busy
function ringSVG({p=0,over=0,mode='time',size=96,spin=0}={}){ if(RM())spin=0; const N=36, R=size*.44, c=size/2, rr=Math.max(1.3,size*.022); let s='';
  const on=Math.round(Math.min(1,p)*N), ov=Math.round(Math.min(1,over)*N);
  for(let i=0;i<N;i++){ const a=-Math.PI/2+i/N*Math.PI*2, x=(c+Math.cos(a)*R).toFixed(1), y=(c+Math.sin(a)*R).toFixed(1);
    let fill='var(--feel-ring-off,rgba(255,255,255,.18))', r=rr, cls='', op=1;
    if(mode==='pulse'){ const head=Math.floor(spin*N)%N, d=(head-i+N)%N; if(d<6){ fill=d===0?'var(--accent)':'var(--ink)'; op=d===0?1:(1-d/6)*.8; if(!d)r=rr*1.5; } }
    else{ if(i<on)fill='var(--ink)'; if(i<ov)fill='var(--accent)'; if(i===on&&p<1){ fill='var(--accent)'; r=rr*1.5; cls=' class="feel-head"'; } }
    s+=`<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" style="fill:${fill}${op<1?';opacity:'+op.toFixed(2):''}"${cls}/>`; }
  return `<svg class="feel-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${s}</svg>`; }
// What a ring should say for a job that started at `started`, given the usual length in minutes.
function progress(started,usual,mode,now=Date.now()){ const el=Math.max(0,(now-started)/60000), u=Math.max(1,usual||20);
  if(mode==='honest')return {p:1-Math.exp(-el/u),over:0,el,u,label:Math.round((1-Math.exp(-el/u))*100)+'%'};
  const label=el<100?Math.round(el)+'m':Math.floor(el/60)+'h';
  if(mode==='pulse')return {p:0,over:0,el,u,spin:(now/2400)%1,label};
  return {p:Math.min(1,el/u),over:el>u?Math.min(1,(el-u)/u):0,el,u,label}; }
// The usual length: the middle of how long the finished ones took (a minute or more, the last 40).
function usual(durationsMin,fallback=20){ const d=durationsMin.filter(x=>x>=1&&x<600).slice(-40).sort((a,b)=>a-b); if(d.length<3)return fallback; return d[Math.floor(d.length/2)]; }

/* ---------- Launch: the page warps away into Standby, and lands back ---------- */
function warp(dir){ if(RM())return; kick(); FX.warp={t:1.3,dir,stars:Array.from({length:260},()=>({a:Math.random()*6.283,d:Math.random()*.2,s:.4+Math.random()*1.2}))}; }
function drawWarp(x,dt){ const W=FX.warp; if(!W)return; W.t-=dt; if(W.t<=0){ FX.warp=null; return; } const k=Math.sin(Math.max(0,W.t)/1.3*Math.PI);
  const cx=innerWidth/2, cy=innerHeight/2, M=Math.hypot(cx,cy), w=ink(); x.fillStyle=`rgba(0,0,0,${k*.7})`; x.fillRect(0,0,innerWidth,innerHeight);
  for(const s of W.stars){ s.d+=dt*s.s*(W.dir>0?1.1:-1.1)*(0.4+k); if(s.d>1.1)s.d=0; if(s.d<0)s.d=1.1;
    const r1=s.d*M, r2=Math.max(0,s.d-.06*k*s.s)*M, steps=Math.max(1,Math.round((r1-r2)/6));
    for(let j=0;j<=steps;j++){ const r=r2+(r1-r2)*j/steps; dot(x,cx+Math.cos(s.a)*r,cy+Math.sin(s.a)*r,1.4,'255,255,255',k*(j/steps)); } } }

/* ---------- Standby: a quiet screen for a second monitor, an iPad on the desk, or a phone on its side ---------- */
// data() gives {name, rise, set, temp, weather, next:{title,ts}, todo:n, agents:[{who,what,started,usual}]}.
const SB={el:null,on:false,timer:0,lock:null,data:()=>({}),pomo:null,drift:0};
function sbBuild(){ if(SB.el)return SB.el; const el=SB.el=document.createElement('div'); el.className='feel-sb'; el.setAttribute('role','dialog'); el.setAttribute('aria-label','Standby');
  el.innerHTML=`<div class="sb-in"><div class="sb-top"><span class="sb-lab" data-sb="date"></span><span class="sb-lab" data-sb="wx"></span></div>
    <div class="sb-sky"><canvas data-sb="sky"></canvas></div>
    <div class="sb-clock" data-sb="clock"></div>
    <div class="sb-pomo" data-sb="pomo" hidden><div class="sb-pomo-ring" data-sb="pring"></div><div class="sb-pomo-t" data-sb="pt"></div></div>
    <div class="sb-micro" data-sb="micro"></div>
    <div class="sb-rings" data-sb="rings"></div>
    <div class="sb-foot"><button type="button" class="sb-btn" data-sb="focus">Focus 25</button><span class="sb-lab sb-hint">Tap anywhere to land</span></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click',e=>{ const f=e.target.closest('[data-sb="focus"]'); if(f){ e.stopPropagation(); togglePomo(); return; } land(); });
  return el; }
const q=(k)=>SB.el.querySelector(`[data-sb="${k}"]`);
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function sbPaint(){ if(!SB.on)return; const d=SB.data()||{}, now=new Date(), h=now.getHours();
  SB.el.classList.toggle('night',h>=23||h<6); // late at night everything goes dim red
  q('date').innerHTML=`<b>${DAYS[now.getDay()]} ${pad(now.getDate())} ${MON[now.getMonth()]}</b>`;
  q('wx').innerHTML=d.temp!=null?`${Math.round(d.temp)}° <b>${esc(d.weather||'')}</b>`:'';
  q('clock').innerHTML=`${pad(h)}<span class="feel-colon sb-colon"></span>${pad(now.getMinutes())}`;
  skyArc(q('sky'),{rise:d.rise,set:d.set,now,big:true,dots:61});
  const nx=d.next, nm=nx?Math.round((nx.ts-Date.now())/60000):null;
  const bits=[];
  if(nx&&nm!=null&&nm>-5&&nm<24*60)bits.push(`● ${esc(cap(nx.title,38))} <span class="rd">${nm<=0?'now':nm<60?nm+' min':Math.floor(nm/60)+' h '+pad(nm%60)}</span>`);
  if(d.todo!=null)bits.push(`${d.todo} to do`);
  const ag=d.agents||[]; bits.push(ag.length?`${ag.length} agent${ag.length>1?'s':''} <span class="pl">working</span>`:'agents <span class="pl">idle</span>');
  q('micro').innerHTML=bits.join(' · ');
  const mode=opt('rings')||'time';
  q('rings').innerHTML=ag.slice(0,3).map(a=>{ const g=progress(a.started,a.usual,mode); return `<div class="sb-ring">${ringSVG({...g,mode,size:84})}<span class="sb-pc">${g.label}</span><div><b>${esc(a.who)}</b><span>${esc(cap(a.what,40))}</span></div></div>`; }).join('');
  q('focus').hidden=opt('pomo')!=='on'; if(opt('pomo')!=='on'&&SB.pomo)SB.pomo=null; pomoPaint();
  // Shift a few pixels each minute so nothing sits still on an OLED.
  const m=now.getMinutes(); SB.el.querySelector('.sb-in').style.transform=RM()?'':`translate(${(m%5-2)*3}px,${(Math.floor(m/5)%5-2)*3}px)`;
}
function pomoPaint(){ const box=q('pomo'); const P=SB.pomo; SB.el.classList.toggle('pomo-on',!!P); box.hidden=!P; q('focus').textContent=P?'Stop focus':'Focus 25'; if(!P)return;
  const left=Math.max(0,P.end-Date.now()), s=Math.ceil(left/1000); q('pt').innerHTML=pad(Math.floor(s/60))+'<span class="feel-colon"></span>'+pad(s%60);
  q('pring').innerHTML=ringSVG({p:1-left/P.len,mode:'time',size:220}); if(!left&&!P.rang){ P.rang=1; play('end'); setTimeout(()=>{ if(SB.pomo===P){ SB.pomo=null; pomoPaint(); } },4000); } }
function togglePomo(){ SB.pomo=SB.pomo?null:{end:Date.now()+25*60e3,len:25*60e3}; play(SB.pomo?'launch':'tick'); pomoPaint(); }
async function lockScreen(on){ try{ if(on&&'wakeLock' in navigator&&!SB.lock){ SB.lock=await navigator.wakeLock.request('screen'); SB.lock.addEventListener?.('release',()=>{ SB.lock=null; }); } else if(!on&&SB.lock){ await SB.lock.release(); SB.lock=null; } }catch{} }
document.addEventListener('visibilitychange',()=>{ if(SB.on&&!document.hidden)lockScreen(true); });
// Launch: the dashboard warps, then Standby fades up. Land: back the other way.
function launch({data}={}){ if(SB.on)return; if(data)SB.data=data; sbBuild(); play('launch'); warp(1); SB.on=true; document.documentElement.classList.add('feel-launching');
  setTimeout(()=>{ SB.el.classList.add('on'); document.documentElement.classList.remove('feel-launching'); document.documentElement.classList.add('feel-standby'); sbPaint(); },RM()?0:650);
  clearInterval(SB.timer); SB.timer=setInterval(sbPaint,1000); lockScreen(true); document.dispatchEvent(new CustomEvent('feel-standby',{detail:true})); }
function land(){ if(!SB.on)return; SB.on=false; clearInterval(SB.timer); lockScreen(false); play('wake'); SB.el.classList.remove('on'); document.documentElement.classList.remove('feel-standby'); warp(-1); document.dispatchEvent(new CustomEvent('feel-standby',{detail:false})); }
addEventListener('keydown',e=>{ if(SB.on&&!e.metaKey&&!e.ctrlKey){ e.preventDefault(); e.stopImmediatePropagation(); if(e.key===' '&&opt('pomo')==='on')togglePomo(); else land(); } },true);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cap=(s,n)=>{ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1).trimEnd()+'…':s; };

/* ---------- rockets: a job goes off to an agent, and a lander brings it back ---------- */
// A 7×11 rocket and a 9×8 lander, drawn in dots. 1 = body, 2 = accent.
const ROCKET=['...2...','..111..','..1.1..','.11111.','.11111.','.11111.','.11111.','2111112','22.1.22','2.....2','.......'];
const LANDER=['...111...','..11111..','..1.1.1..','..11111..','.2111112.','..1...1..','.1.....1.','11.....11'];
function sprite(x,rows,cx,cy,ang,g,colA,colW,alpha=1){ const h=rows.length, w=rows[0].length; x.save(); x.translate(cx,cy); x.rotate(ang);
  for(let j=0;j<h;j++)for(let i=0;i<w;i++){ const c=rows[j][i]; if(c==='.')continue; dot(x,(i-(w-1)/2)*g,(j-(h-1)/2)*g,g*.42,c==='2'?colA:colW,alpha); } x.restore(); }
const centre=(el)=>{ const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; };
// from and to are elements or {x,y}. The rocket arcs up and over, dropping a trail of dots.
function rocket(from,to,{label}={}){ const m=opt('rockets')||'off'; if(m!=='rocket'&&m!=='both')return; play('rocket'); if(RM())return;
  const a=from.nodeType?centre(from):from, b=to?.nodeType?centre(to):to||{x:innerWidth/2,y:innerHeight+40};
  kick(); FX.craft.push({kind:'rocket',a,b,t:0,dur:1.5,c:{x:(a.x+b.x)/2+(b.x>a.x?-1:1)*Math.min(240,Math.abs(b.x-a.x)*.4),y:Math.min(a.y,b.y)-Math.max(160,Math.abs(b.x-a.x)*.3)},label}); }
// The lander comes down on its target, fires its thruster, settles and chimes.
function lander(to,{label}={}){ const m=opt('rockets')||'off'; if(m!=='lander'&&m!=='both')return false; play('lander'); if(RM())return true;
  const b=to?.nodeType?centre(to):to||{x:innerWidth-120,y:innerHeight-60}; kick(); FX.craft.push({kind:'lander',b,t:0,dur:1.6,label}); return true; }
const ease=t=>1-Math.pow(1-t,3), easeIn=t=>t*t;
function drawCraft(x,dt){ const A=accent(), W=ink();
  FX.craft=FX.craft.filter(c=>c.t<c.dur+.2);
  for(const c of FX.craft){ c.t+=dt; const k=Math.min(1,c.t/c.dur);
    if(c.kind==='rocket'){ const u=easeIn(k)*.85+k*.15, ix=(1-u)*(1-u)*c.a.x+2*(1-u)*u*c.c.x+u*u*c.b.x, iy=(1-u)*(1-u)*c.a.y+2*(1-u)*u*c.c.y+u*u*c.b.y;
      const dx=2*(1-u)*(c.c.x-c.a.x)+2*u*(c.b.x-c.c.x), dy=2*(1-u)*(c.c.y-c.a.y)+2*u*(c.b.y-c.c.y), ang=Math.atan2(dy,dx)+Math.PI/2;
      if(k<1){ sprite(x,ROCKET,ix,iy,ang,4,A,W); for(let i=0;i<2;i++)FX.parts.push({x:ix-Math.sin(ang)*18+(Math.random()-.5)*6,y:iy+Math.cos(ang)*18+(Math.random()-.5)*6,vx:(Math.random()-.5)*30,vy:(Math.random()-.5)*30,g:0,life:.8,fade:1.6,col:Math.random()<.4?A:W,r:1.4}); }
      else if(!c.puffed){ c.puffed=1; burst(c.b.x,c.b.y,{n:14,spread:110}); } }
    else{ const k2=ease(k), ix=c.b.x, iy=c.b.y-18-(1-k2)*Math.max(220,c.b.y*.8); const thr=k<.95;
      sprite(x,LANDER,ix,iy,0,4,A,W);
      if(thr)for(let i=0;i<2;i++)FX.parts.push({x:ix+(Math.random()-.5)*8,y:iy+16,vx:(Math.random()-.5)*40,vy:60+Math.random()*80,g:0,life:.6,fade:2,col:Math.random()<.5?A:W,r:1.4});
      if(k>=1&&!c.puffed){ c.puffed=1; for(let i=0;i<16;i++){ const s=i<8?-1:1; FX.parts.push({x:ix,y:iy+14,vx:s*(40+Math.random()*90),vy:-Math.random()*30,g:60,life:.9,col:W,r:1.4}); } } }
    if(c.label&&c.kind==='lander'&&k<1){ const iy=c.b.y-18-(1-ease(k))*Math.max(220,c.b.y*.8); x.font='400 10px "Space Mono",ui-monospace,monospace'; x.fillStyle=`rgba(${W},.75)`; x.fillText(String(c.label).toUpperCase(),c.b.x+22,iy+4); } } }

window.Feel={init(o){ if(o?.opt)opt=o.opt; if(o?.data)SB.data=o.data; return this; },colon:(t)=>String(t).replace(':','<span class="feel-colon"></span>'),play,done,undone,burst,skyArc,ringSVG,progress,usual,launch,land,rocket,lander,
  get standing(){ return SB.on; }, paint:()=>sbPaint()};
})();
