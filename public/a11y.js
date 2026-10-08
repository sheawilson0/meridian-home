'use strict';
// Keep overlay focus together on desktop and phone, without changing their appearance.
(function(){
let active=null, blocked=[]; const stack=[];
const controls='button:not(:disabled),a[href],input:not(:disabled):not([type=hidden]),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"]),[contenteditable]';
const visible=el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest('[inert]');
function release(){ for(const el of blocked)el.inert=false; blocked=[]; }
function block(el){
  for(let branch=el;branch&&branch!==document.body;branch=branch.parentElement){
    for(const sibling of branch.parentElement.children){ if(sibling!==branch&&!sibling.inert&&!sibling.matches('script,style,link,.scrim,[role=status]')){ sibling.inert=true; blocked.push(sibling); } }
  }
}
function semantics(el){
  if(el.tagName!=='FORM')return el;
  if(!el.parentElement.classList.contains('a11y-dialog')){ const box=document.createElement('div'); box.className='a11y-dialog'; box.style.display='contents'; el.before(box); box.appendChild(el); }
  return el.parentElement;
}
function open(el,{modal=true}={}){
  if(active===el)return;
  if(active)semantics(active).removeAttribute('aria-modal'); release();
  stack.push({el,opener:document.activeElement,modal}); active=el;
  const owner=semantics(el); owner.removeAttribute('aria-hidden'); owner.setAttribute('role','dialog'); owner.setAttribute('aria-modal',String(modal)); el.tabIndex=-1;
  if(!owner.hasAttribute('aria-label')&&!owner.hasAttribute('aria-labelledby')){
    const heading=el.querySelector('h1,h2,h3'); if(heading){ if(!heading.id)heading.id=el.id+'-heading'; owner.setAttribute('aria-labelledby',heading.id); }
  }
  // Block sibling branches, including sheets nested inside the phone's app shell.
  if(modal)block(el);
  queueMicrotask(()=>{ if(active!==el)return; const target=el.querySelector('textarea,input:not([type=hidden]),button:not(:disabled)'); (target||el).focus({preventScroll:true}); });
}
function close(el){
  const index=el?stack.findIndex(x=>x.el===el):0; if(index<0||!stack.length)return;
  const back=stack[index].opener;
  for(const frame of stack.splice(index)){ const owner=semantics(frame.el); owner.removeAttribute('aria-modal'); if(owner!==frame.el)owner.setAttribute('aria-hidden','true'); }
  release(); active=stack.at(-1)?.el||null;
  if(active){ const modal=stack.at(-1).modal; semantics(active).setAttribute('aria-modal',String(modal)); if(modal)block(active); }
  if(back?.isConnected&&visible(back))back.focus({preventScroll:true});
}
document.addEventListener('keydown',e=>{
  if(!active||!stack.at(-1).modal||e.key!=='Tab')return;
  const items=[...active.querySelectorAll(controls)].filter(visible);
  const first=items[0],last=items.at(-1),current=document.activeElement;
  if(!first){ e.preventDefault(); active.focus(); }
  else if(e.shiftKey&&(current===first||current===active||!active.contains(current))){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey&&(current===last||current===active||!active.contains(current))){ e.preventDefault(); first.focus(); }
},true);
window.MeridianA11y={open,close};

const style=document.createElement('style');
style.textContent='.a11y-skip:not(:focus){position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}.a11y-skip:focus{position:fixed;left:12px;top:12px;z-index:10000;padding:10px 14px;background:var(--card,#fff);color:var(--ink,#000);border-radius:6px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}';
document.head.appendChild(style);
const main=document.querySelector('main,[role=main]');
if(main){
  if(!main.id)main.id='main-content';
  const skip=document.createElement('a'); skip.className='a11y-skip'; skip.href='#'+main.id; skip.textContent='Skip to content';
  skip.addEventListener('click',e=>{ e.preventDefault(); main.tabIndex=-1; main.focus({preventScroll:true}); }); document.body.prepend(skip);
}
})();
