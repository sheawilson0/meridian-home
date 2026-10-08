'use strict';
/* Meridian command centre. Plain JS, no build step. It reads the same
   /api/state stream as the morning brief. Looks, tab order and the sidebar are
   saved in the browser and mirrored to the server so every device matches. */

/* ---------- basics ---------- */
const $=(id)=>document.getElementById(id);
// The state stream re-sends everything every 45 s. Writing only what changed keeps focus, hover and animations where they are.
const setHTML=(el,h)=>{ if(el&&el.__h!==h){ el.innerHTML=h; el.__h=h; } };
const setText=(el,t)=>{ if(el&&el.textContent!==t)el.textContent=t; };
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=new URLSearchParams(location.search).get('t');
// Demo mode swaps every API call for made-up data, for screen recordings. Device only.
const DEMO=new URLSearchParams(location.search).has('demo')||(()=>{ try{ return localStorage.getItem('meridian.demo')==='1'; }catch{ return false; } })();
// Who the page greets. Demo mode never shows the real name; a tester's copy (tester/server.js) greets them by theirs.
const youName=()=>DEMO||state?.setup?.demo?(window.MERIDIAN_TESTER?.name||'Sam'):prefs.name||(state?.setup?'':'Owner');
// Where the weather is. The almanac reads one place; only the owner's install is Belfast by default.
const placeName=()=>state?.location?.name||(state?.setup?'Outside':'Belfast');
// "Morning, Sam." with a name, "Morning." without one.
const greetTo=(word)=>`${word}${youName()?', '+esc(youName()):''}`;
// A fresh install (state.setup, a portable profile) starts with only the parts that work without an account,
// and the rest appear as their connector is switched on. The owner's install has no setup key, so nothing changes there.
const connOn=(n)=>!n||!state?.setup||state.setup.connectors?.[n]?.enabled===true;
const TAB_NEEDS={money:'money',dogfood:'delegations',usage:'aiUsage'}, HOME_NEEDS={dog:['delegations'],usage:['aiUsage'],live:['fleet','ai','delegations','localServers']};
// Opened inside /labs/home.html: the lab sends looks and layouts to try, and nothing is ever saved or sent.
const LAB=new URLSearchParams(location.search).has('lab');
if(LAB){ const f=window.fetch; window.fetch=(u,o={})=>/^(GET|HEAD)$/i.test(o.method||'GET')?f(u,o):Promise.resolve(new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}})); }
let labLook=null;
const api=(p)=>{ if(DEMO&&p.startsWith('/api/'))p='/api/demo/'+p.slice(5); return token?p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(token):p; };
async function send(p,body,method='POST'){
  const r=await fetch(api(p),{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j.ok===false)throw new Error(j.error||('Request failed ('+r.status+')'));
  return j;
}
const root=document.documentElement;
const pad=(n)=>String(n).padStart(2,'0');
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const isoDay=(d=new Date())=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const startOfDay=(ts)=>{const d=new Date(ts);d.setHours(0,0,0,0);return d.getTime();};
const daysUntil=(iso)=>Math.round((startOfDay(Date.parse(iso+'T12:00:00'))-startOfDay(Date.now()))/86400e3);
const hm=(ts)=>{const d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes());};
const shortDate=(ts)=>{const d=new Date(ts);return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`;};
function dayWord(ts){ const d=startOfDay(ts),t=startOfDay(Date.now()); if(d===t)return 'Today'; if(d===startOfDay(Date.now()+86400e3))return 'Tomorrow'; const x=new Date(ts); return `${DAYS[x.getDay()].slice(0,3)} ${x.getDate()}`; }
const hours=(m)=>!m?'':m>=60?(m/60).toFixed(1).replace(/\.0$/,'')+' h':Math.round(m)+' min';
function ago(ts){ if(!ts)return ''; const s=Math.max(0,(Date.now()-ts)/1000); if(s<60)return 'just now'; if(s<3600)return Math.round(s/60)+' min ago'; if(s<86400)return Math.round(s/3600)+' h ago'; return Math.round(s/86400)+' d ago'; }
function hostOf(url){ try{const u=new URL(url);return u.host.replace(/^www\./,'')+(u.pathname!=='/'?u.pathname.replace(/\/$/,''):'');}catch{return url;} }
const typing=(e)=>{const t=e.target;return !!t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));};
const isMobile=()=>matchMedia('(max-width:760px)').matches;
// iOS leaves fixed bottom sheets under the on-screen keyboard: --kb lifts them above it, --vvh caps their height.
if(window.visualViewport){ const vv=visualViewport; const fit=()=>{ const kb=vv.scale>1.01?0:Math.max(0,Math.round(innerHeight-vv.height-vv.offsetTop)); root.style.setProperty('--kb',kb+'px'); root.style.setProperty('--vvh',Math.round(innerHeight-kb)+'px'); };
  vv.addEventListener('resize',fit); vv.addEventListener('scroll',fit); fit(); }
const onHomeMac=()=>/^(127\.0\.0\.1|localhost)$/.test(location.hostname);
const looksLikeUrl=(s)=>/^https?:\/\/\S+$/i.test(String(s||'').trim());
const cap=(s,n)=>{s=String(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s;};
function sig(v){ return JSON.stringify(v); }

// Live data. Declared up here because the looks read today's colours on boot.
let state=null, links={categories:[],links:[]}, journal=null, ledger=null, almanac=null, es=null;
let view=null; const mru=[];

/* ---------- icons ---------- */
const IC={
  star:'<path d="m12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z"/>',
  home:'<path d="M4 11.2 12 4.8l8 6.4V19a1.6 1.6 0 0 1-1.6 1.6H15v-5.2H9v5.2H5.6A1.6 1.6 0 0 1 4 19z"/>',
  shelf:'<path d="M3 20.2h18"/><rect x="4.5" y="5" width="4" height="15.2" rx="1"/><rect x="10" y="8.5" width="4" height="11.7" rx="1"/><path d="m15.4 9.4 3.4-.9 2.6 10.6-3.4.9z"/>',
  usage:'<path d="M3 20h18"/><path d="M6.5 16v-4M11 16V6.5M15.5 16v-6M20 16V9"/>',
  dogfood:'<path d="M3 12.6h18l-1.7 5.3a2 2 0 0 1-1.9 1.4H6.6a2 2 0 0 1-1.9-1.4z"/><path d="M7.8 12.6c.3-1.9 2-3.2 4.2-3.2s3.9 1.3 4.2 3.2"/><path d="M10 6.2h.01M13.5 5.4h.01M16 7.2h.01"/>',
  journal:'<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M9 8h6"/>',
  system:'<rect x="3" y="4" width="18" height="12" rx="2.2"/><path d="M8 20h8M12 16v4"/><path d="M7 10h.01M10 10h4"/>',
  next:'<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  todo:'<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.2 1.2 2.3-2.4M3.5 12l1.2 1.2 2.3-2.4M3.5 18l1.2 1.2 2.3-2.4"/>',
  pin:'<path d="M12 16.5V21M8.5 3.5h7l-1 6.5 3 3h-11l3-3z"/>',
  unpin:'<path d="M12 16.5V21M8.5 3.5h7l-1 6.5 3 3h-11l3-3z"/><path d="m4 4 16 16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="M18 6 6 18M6 6l12 12"/>',
  dots:'<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  check:'<path d="m5 12.5 4.2 4.2L19 7"/>',
  chev:'<path d="m6 9 6 6 6-6"/>',
  out:'<path d="M8 7h9v9"/><path d="M7 17 17 7"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit:'<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  refresh:'<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  report:'<path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  reply:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  archive:'<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  agent:'<rect x="4" y="7.5" width="16" height="11.5" rx="3"/><path d="M12 3.5v4M9 13h.01M15 13h.01"/>',
  bolt:'<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  terminal:'<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 2.8 2.5-2.8 2.5M13 15h3.5"/>',
  globe:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5S9.6 6 12 3.5z"/>',
  sparkle:'<path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5z"/><path d="M18.5 15.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5z"/>',
  table:'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  chart:'<path d="M3 20h18"/><path d="M6.5 16v-4M11 16V6.5M15.5 16v-6M20 16V9"/>',
  sidebar:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeoff:'<path d="M3 3l18 18M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.5 6.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.5 0 2.9-.4 4.1-1"/>',
  up:'<path d="m6 15 6-6 6 6"/>', down:'<path d="m6 9 6 6 6-6"/>',
  link:'<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  sliders:'<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/>',
  mac:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  search:'<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  bell:'<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  belloff:'<path d="M6 16V11a6 6 0 0 1 9.4-4.9M18 11v5l1.5 2H9"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="m4 4 16 16"/>',
  github:'<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  brief:'<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><circle cx="12" cy="9.5" r="3"/><path d="M8 15.5h8M9.5 18h5"/>',
  grip:'<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  share:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5S9.6 6 12 3.5z"/>',
  pause:'<rect x="6.5" y="5" width="3.5" height="14" rx="1.2"/><rect x="14" y="5" width="3.5" height="14" rx="1.2"/>',
  undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  note:'<path d="M5 4h10l4 4v12H5z"/><path d="M14 4v5h5M8 13h8M8 17h5"/>',
  palette:'<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2.5-1.5H17a4 4 0 0 0 4-4c0-4.5-4-8-9-8z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
  swipe:'<rect x="8" y="4" width="8" height="16" rx="2"/><path d="m5 9-3 3 3 3M19 9l3 3-3 3"/>',
  stash:'<path d="M12 3.5v7.2M9 7.9l3 3 3-3"/><path d="M4 14h4.3a3.7 3.7 0 0 0 7.4 0H20"/><path d="M8.2 6.2H6.8a2 2 0 0 0-1.9 1.5L4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4l-.9-6.3a2 2 0 0 0-1.9-1.5h-1.4"/>',
  keys:'<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  gridS:'<rect x="3.5" y="3.5" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="3.5" width="4.5" height="4.5" rx="1"/><rect x="16" y="3.5" width="4.5" height="4.5" rx="1"/><rect x="3.5" y="9.75" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1"/><rect x="16" y="9.75" width="4.5" height="4.5" rx="1"/><rect x="3.5" y="16" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="16" width="4.5" height="4.5" rx="1"/><rect x="16" y="16" width="4.5" height="4.5" rx="1"/>',
  gridM:'<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.6"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.6"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.6"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.6"/>',
  gridL:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/>',
  play:'<path d="M7 4.5v15l12.5-7.5z"/>',
  trend:'<path d="M3 17l5.5-5.5 4 4L21 7"/><path d="M15 7h6v6"/>',
  pie:'<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  pot:'<path d="M7 4h10M8 4v2.5c0 .8-.6 1.3-1.2 1.8C5.6 9.3 5 10.6 5 12v6a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18v-6c0-1.4-.6-2.7-1.8-3.7-.6-.5-1.2-1-1.2-1.8V4"/><path d="M5 13h14"/>',
  bank:'<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20.5h17"/>',
  pin:'<path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  bulb:'<path d="M9 17.5h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.9 1.1.9 1.9v.3h5.4v-.3c0-.8.3-1.4.9-1.9A6 6 0 0 0 12 3z"/>',
  left:'<path d="m15 6-6 6 6 6"/>', right:'<path d="m9 6 6 6-6 6"/>',
  money:'<circle cx="9" cy="9" r="5.5"/><path d="M15.2 9.7a5.5 5.5 0 1 1-5.5 5.5"/><path d="M9 7v4M7.4 9h3.2"/>',
  flag:'<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  snooze:'<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z"/>',
  briefcase:'<rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3.5 12.5h17"/>',
  cap:'<path d="m2.5 9.5 9.5-4.5 9.5 4.5-9.5 4.5z"/><path d="M6.5 11.5v4.2c1.5 1.4 3.4 2.1 5.5 2.1s4-.7 5.5-2.1v-4.2M21.5 9.5v5"/>',
  person:'<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.2c.9-3.6 3.8-5.7 7.2-5.7s6.3 2.1 7.2 5.7"/>',
  personF:'<circle cx="12" cy="8" r="4" fill="currentColor" stroke="none"/><path d="M4.5 21c.6-4.2 3.6-6.6 7.5-6.6s6.9 2.4 7.5 6.6z" fill="currentColor" stroke="none"/>',
  briefcaseF:'<path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M6 7h12a2.5 2.5 0 0 1 2.5 2.5V12h-17V9.5A2.5 2.5 0 0 1 6 7zM3.5 13.6h17v3.4A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z" fill="currentColor" stroke="none"/>',
  capF:'<path d="m1.8 9.5 10.2-4.9 10.2 4.9-10.2 4.9z" fill="currentColor" stroke="none"/><path d="M6.3 12.2v3.6c1.6 1.4 3.5 2.1 5.7 2.1s4.1-.7 5.7-2.1v-3.6L12 15z" fill="currentColor" stroke="none"/><path d="M21.6 10v4.6"/>',
  allspF:'<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="3.4" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="3.4" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="3.4" fill="currentColor" stroke="none"/>',
  allsp:'<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><circle cx="8" cy="16" r="3"/><circle cx="16" cy="16" r="3"/>',
  lock:'<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
};
const icon=(n,cls='')=>`<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[n]||''}</svg>`;
window.monoFallback=(img)=>{ const s=document.createElement('span'); s.className=(img.className||'')+' mono-mark'; s.textContent=img.dataset.mono||'?'; img.replaceWith(s); };
function favImg(l,cls='fav'){ const mono=(l.title||'?').trim().charAt(0).toUpperCase(); return `<img class="${cls}" alt="" loading="lazy" src="${api('/api/favicon?link='+encodeURIComponent(l.id))}" data-mono="${esc(mono)}" onerror="monoFallback(this)">`; }
// Previews render in headless Chrome on the Home Mac. 404 with Retry-After
// means "still shooting", so keep asking for a while before giving up.
window.shotRetry=(img)=>{ const n=Number(img.dataset.tries||0); if(n>=8){ img.remove(); return; } img.dataset.tries=String(n+1); const base=(img.dataset.base||img.getAttribute('src')||'').split('&v=')[0]; img.dataset.base=base; img.removeAttribute('src'); setTimeout(()=>{ if(img.isConnected)img.src=base+(base.includes('?')?'&':'?')+'v='+Date.now(); },3500+n*1500); };
const shot=(src)=>`<img alt="" loading="lazy" src="${esc(src)}" onload="this.classList.add('in')" onerror="shotRetry(this)">`;

/* ---------- tabs, prefs and looks ---------- */
const TAB_DEFS=[
  {id:'home',label:'Home',icon:'home'},
  {id:'shelf',label:'Shelf',icon:'shelf'},
  {id:'stash',label:'Stash',icon:'stash'},
  {id:'usage',label:'AI usage',icon:'usage'},
  {id:'money',label:'Money',icon:'money'},
  {id:'dogfood',label:'Dogfood',icon:'dogfood'},
  {id:'journal',label:'Journal',icon:'journal'},
  {id:'system',label:'System',icon:'system'},
  {id:'brief',label:'Brief',icon:'brief'},
];
const ACCENTS=[
  {name:'Yellow',hex:'#f6c93a',ink:'#1d1606'},{name:'Red',hex:'#ff5247',ink:'#2b0503'},{name:'Clay',hex:'#ee8a62',ink:'#2a1206'},{name:'Mint',hex:'#5fd3a5',ink:'#04231a'},
  {name:'Sky',hex:'#6db4ff',ink:'#061a33'},{name:'Lilac',hex:'#b7a1ff',ink:'#170d33'},{name:'Rose',hex:'#ff8fb1',ink:'#33101c'},{name:'Chalk',hex:'#ececec',ink:'#111111'},
];
// Type pairings. Fonts load only when picked; "today" borrows the almanac's typeface.
const TYPES=[
  {id:'editorial',name:'Editorial',title:'Fraunces',sample:'italic 500 24px Fraunces'},
  {id:'clean',name:'Clean',title:'Outfit'},
  {id:'grotesk',name:'Grotesk',title:'Space Grotesk',css:'family=Space+Grotesk:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600'},
  {id:'serif',name:'Serif',title:'Newsreader',css:'family=Newsreader:opsz,wght@6..72,400..600&family=Inter+Tight:wght@400;500;600'},
  {id:'mono',name:'Mono',title:'IBM Plex Mono'},
  {id:'today',name:"Today's",title:null},
];
const PREF_KEY='meridian.cc.prefs';
const DEFAULTS={
  look:{surface:'ink',radius:'soft',density:'comfortable',type:'editorial',tint:'accent',accentStyle:'quiet',glass:'solid',inset:'inset',hero:'earthview',sel:'glow',flash:'glow'},
  accent:'#f6c93a', grain:0,
  side:{mode:'docked',side:'left',width:252,hide:'float',last:'docked',liveOpen:true},
  tabs:{order:TAB_DEFS.map(t=>t.id),hidden:[]},
  // Groups decide a link's Space; links:{id:spaceId} holds the ones moved by hand.
  spaces:{list:[
    {id:'personal',name:'Personal',color:'#5fd3a5',groups:['Personal','Meridian']},
    {id:'work',name:'Work',color:'#6db4ff',groups:['Example Agency','ExampleApp','Example Campaign','Tools']},
    {id:'uni',name:'Uni',color:'#b7a1ff',groups:['Uni']},
  ],links:{}},
  strip:'auto', labs:{webTabs:false}, webTabs:[],
  updated:0,
};
function merge(a,b){ const out={...a}; for(const [k,v] of Object.entries(b||{})){ out[k]=(v&&typeof v==='object'&&!Array.isArray(v)&&a&&a[k]&&typeof a[k]==='object'&&!Array.isArray(a[k]))?merge(a[k],v):v; } return out; }
// Older saved looks: "round" corners became squircles, grain went from on/off to a slider.
function migrate(p){ if(p.look?.radius==='round')p.look.radius='squircle'; if(p.look?.hero==='dawn')p.look.hero='dusk'; // 4 October: Dawn went
  if(p.look&&'grain' in p.look){ if(p.look.grain==='on'&&!p.grain)p.grain=35; delete p.look.grain; } if(p.look)delete p.look.tintStrength;
  if(Array.isArray(p.tabs?.order))p.tabs.order=[...new Set(p.tabs.order)]; // a drag that met a redraw could save a tab twice
  // Stash arrived on 2 October: it goes after the shelf rather than at the end.
  if(Array.isArray(p.tabs?.order)&&!p.tabs.order.includes('stash')){ const i=p.tabs.order.indexOf('shelf'); p.tabs.order.splice(i<0?p.tabs.order.length:i+1,0,'stash'); }
  // Money arrived on 3 October: after AI usage.
  // 3 October: Up next is always Stack.
  if(p.look?.hnext&&p.look.hnext!=='stack')p.look.hnext='stack';
  // 4 October: the Up next headline kept Wash, Line and Open.
  if(p.look?.nxs&&!['wash','line','open'].includes(p.look.nxs))delete p.look.nxs;
  if(Array.isArray(p.tabs?.order)&&!p.tabs.order.includes('money')){ const i=p.tabs.order.indexOf('usage'); p.tabs.order.splice(i<0?p.tabs.order.length:i+1,0,'money'); }
  // 3 October: Spaces read All, Personal, Work, Uni. Only the untouched original order is moved, once.
  const sl=p.spaces?.list; if(Array.isArray(sl)&&!p.spaces.order){ if(sl.map(x=>x.id).join()==='work,uni,personal')p.spaces.list=[sl[2],sl[0],sl[1]]; p.spaces.order=2; }
  return p; }
function loadPrefs(){ try{ return migrate(merge(DEFAULTS,JSON.parse(localStorage.getItem(PREF_KEY)||window.__meridianStash?.[PREF_KEY]||'{}'))); }catch{ return merge(DEFAULTS,{}); } }
let prefs=loadPrefs();
const SPACE_KEY='meridian.cc.space';
let spaceId=(()=>{ try{ return localStorage.getItem(SPACE_KEY)||'all'; }catch{ return 'all'; } })();
function savePrefs({sync=true}={}){
  if(LAB){ applyPrefs(); return; }
  prefs.updated=Date.now();
  try{ localStorage.setItem(PREF_KEY,JSON.stringify(prefs)); }catch{}
  applyPrefs();
  // A failed save used to vanish, leaving changes on this device only. Say so, at most once a minute.
  if(sync){ clearTimeout(savePrefs.t); savePrefs.t=setTimeout(()=>send('/api/command/prefs',prefs,'PUT').catch(err=>{ if(Date.now()-(savePrefs.warned||0)<60e3)return; savePrefs.warned=Date.now(); toast('Settings saved on this device only: '+String(err?.message||err)); }),700); }
}
function loadFont(css){ if(!css||document.querySelector(`link[data-fontcss="${CSS.escape(css)}"]`))return; const l=document.createElement('link'); l.rel='stylesheet'; l.href='https://fonts.googleapis.com/css2?'+css+'&display=swap'; l.dataset.fontcss=css; document.head.appendChild(l); }
function applyType(){
  const t=TYPES.find(x=>x.id===prefs.look.type)||TYPES[0]; loadFont(t.css);
  const tf=almanac?.items?.typeface; if(tf?.family){ root.style.setProperty('--f-today',`'${tf.family}',var(--f-body)`); if(prefs.look.type==='today'&&tf.cssUrl&&!document.querySelector('link[data-font]')){ const l=document.createElement('link'); l.rel='stylesheet'; l.href=tf.cssUrl; l.dataset.font=tf.family; document.head.appendChild(l); } }
}
// "Today's" accent: the boldest of the day's Wada colours, so the accent changes every morning with the almanac.
function todayAccent(){
  const c=almanac?.items?.colours?.colours||[]; if(!c.length)return ACCENTS[0];
  const hsl=(h)=>{ const n=parseInt(h.slice(1),16), r=(n>>16&255)/255, g=(n>>8&255)/255, b=(n&255)/255; const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2; const s=mx===mn?0:(mx-mn)/(1-Math.abs(2*l-1)); return {s,l,lum:.2126*r+.7152*g+.0722*b}; };
  const best=c.map(x=>({hex:x.hex,...hsl(x.hex)})).sort((a,b)=>(b.s-Math.abs(b.l-.58)*1.4)-(a.s-Math.abs(a.l-.58)*1.4))[0];
  return {hex:best.hex,ink:best.lum>.5?'#111111':'#ffffff'};
}
// A look option, with whatever the lab is trying on top.
const lookOpt=(k)=>labLook?.look?.[k]??prefs.look[k];
function applyPrefs(){
  const look={...prefs.look,...labLook?.look};
  for(const k of applyPrefs.keys||[])if(!(k in look))delete root.dataset[k]; // a lab option that's been taken off
  for(const [k,v] of Object.entries(look))root.dataset[k]=v; applyPrefs.keys=Object.keys(look);
  const want=labLook?.accent||prefs.accent; let a=want==='today'?todayAccent():ACCENTS.find(x=>x.hex===want)||ACCENTS[0];
  // In a Space, the accent can take the Space's colour, so you can tell at a glance you're not in All.
  const sp=activeSpace(); if(sp&&lookOpt('spaceaccent')!=='off'){ const hex=spColor(sp); const n=parseInt(hex.slice(1),16); const lum=(.2126*(n>>16&255)+.7152*(n>>8&255)+.0722*(n&255))/255; a={hex,ink:lum>.55?'#111111':'#ffffff'}; }
  root.style.setProperty('--accent',a.hex); root.style.setProperty('--accent-ink',a.ink);
  root.style.setProperty('--grain',String(Math.max(0,Math.min(100,Number(prefs.grain)||0))/100));
  root.dataset.side=prefs.side.side; root.dataset.spacespos=lookOpt('spacespos')||'bottom';
  root.dataset.sidemode=isMobile()?'docked':prefs.side.mode;
  root.style.setProperty('--side-w',Math.max(208,Math.min(380,prefs.side.width||252))+'px'); $('side-resize').setAttribute('aria-valuenow',String(Math.max(208,Math.min(380,prefs.side.width||252))));
  if(look.surface==='nothing')loadFont('family=Doto:ROND,wght@0..100,500..900&family=Space+Grotesk:wght@400;500;600&family=Space+Mono:wght@400;700'); // its own type, see /themes/nothing.css
  applyTint(); applyType(); dayLine(); if(window.feelReady)feelApply();
  requestAnimationFrame(()=>{ const m=document.querySelector('meta[name=theme-color]'); if(m)m.content=getComputedStyle(root).getPropertyValue('--frame').trim()||'#000'; });
}
function applyTint(){
  const c=almanac?.items?.colours?.colours; const sp=activeSpace();
  if(c&&c.length)c.slice(0,4).forEach((x,i)=>root.style.setProperty('--day-'+(i+1),x.hex));
  applyBackdrop();
  root.dataset.activeSpace=sp?sp.id:'all'; if(sp)root.style.setProperty('--space',spColor(sp)); else root.style.removeProperty('--space');
  for(const x of spaceList())root.style.setProperty('--sp-'+x.id,spColor(x)); // tags and calendar lines use these
  if(sp&&prefs.look.tint!=='off'){ root.style.setProperty('--tint',spColor(sp)); root.style.setProperty('--tint-2',spColor(sp)); }
  else if(prefs.look.tint==='today'&&c&&c.length){ root.style.setProperty('--tint',c[0].hex); root.style.setProperty('--tint-2',(c[1]||c[0]).hex); }
  else{ root.style.removeProperty('--tint'); root.style.removeProperty('--tint-2'); }
}
// Smoke, Aurora and Mist sit on a blurred wash of the day's picture (Aurora uses today's colours instead).
function applyBackdrop(){
  const app=$('app'); if(!app)return; let d=$('backdrop');
  if(!d){ d=document.createElement('div'); d.className='backdrop'; d.id='backdrop'; d.setAttribute('aria-hidden','true'); app.prepend(d); }
  const it=almanac?.items; if(!it)return;
  const mode=lookOpt('hero'); const pick=[mode==='picture'?it.picture:null,it.earthView,it.picture,it.earth].find(x=>x&&!x.error&&x.image);
  root.style.setProperty('--art',pick?`url("${api(typeof pick.image==='string'?pick.image:pick.image.url)}")`:'none');
}
// Opened inside the Meridian Mac app: leave room for the traffic lights.
if(new URLSearchParams(location.search).has('app'))root.dataset.app='1';
const visibleTabs=()=>{ const order=[...prefs.tabs.order.filter(id=>TAB_DEFS.some(t=>t.id===id)),...TAB_DEFS.map(t=>t.id).filter(id=>!prefs.tabs.order.includes(id))]; return order.filter(id=>(!prefs.tabs.hidden.includes(id)&&connOn(TAB_NEEDS[id]))||id==='home').map(id=>TAB_DEFS.find(t=>t.id===id)); };
applyPrefs();

/* ---------- data ---------- */
function absorb(s,{cached=false}={}){ if(window.feelReady&&!cached)feelWatch(s); state=s; if(s.links){ links=s.links; if(!cached)stash('links',links); } renderSide(); renderStrip(); if(view!=='usage'&&view!=='money')VIEWS[view]?.update?.(); if(!cached)stash('state',s); setOffline(cached?s.at:0); markStale(cached); setupChanged(s); }
/* ---------- welcome and Connect (fresh installs only) ---------- */
// A new install (state.setup) gets four first steps on Home until they're done or put away, and a Connect sheet that
// switches connectors on through /api/setup, so nobody has to edit config.json. The owner's install never sees either.
const showWelcome=()=>Boolean(state?.setup&&!state.setup.demo&&!prefs.welcomeDone);
function welcomeSteps(){
  const c=state.setup.connectors||{};
  return [
    {id:'name',done:Boolean(prefs.name),t:prefs.name?`Hello, ${prefs.name}`:'Tell Meridian your name',s:prefs.name?'Change it any time in Customise.':'For the greeting at the top.',act:prefs.name?'':'Add'},
    {id:'todo',done:(state.todos||[]).length>0,t:'Add your first to-do',s:'Type it into To do and press Enter.',act:'Add one'},
    {id:'link',done:(links.links||[]).length>0,t:'Save a link you use every day',s:'Paste one anywhere on the page, or press N.',act:'Add a link'},
    {id:'cal',done:c.calendar?.enabled===true,t:'Connect your calendar',s:'An ICS link from Google, Outlook or iCloud.',act:'Connect'},
  ];
}
function renderWelcome(){
  const el=$('h-welcome'); if(!el||!state?.setup)return;
  const steps=welcomeSteps(), n=steps.filter(x=>x.done).length;
  setHTML(el,`<div class="ch">${icon('sparkle')}<h2>Welcome to Meridian</h2><span class="sub">${n===steps.length?'All set':`${n} of ${steps.length} done`} · everything stays on this computer</span><span class="end"><button class="btn sm ghost" type="button" data-wl="connect">Connect more</button>${n===steps.length?`<button class="btn sm primary" type="button" data-wl="close">Done</button>`:`<button class="ibtn" type="button" data-wl="close" data-tip="Put this away|Connect more stays in search and Customise" aria-label="Put the welcome away">${icon('close')}</button>`}</span></div>
    <div class="wl-steps">${steps.map(x=>`<div class="row wl-step${x.done?' done':''}" data-step="${x.id}"><span class="ck" aria-hidden="true">${x.done?icon('check'):''}</span><div class="main"><div class="t">${esc(x.t)}</div><div class="s">${esc(x.s)}</div></div>${!x.done&&x.act?`<span class="acts" style="opacity:1"><button class="btn sm" type="button" data-wl="${x.id}">${esc(x.act)}</button></span>`:''}</div>`).join('')}</div>`);
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-wl]'); if(!b||!$('h-welcome')?.contains(b))return;
  const a=b.dataset.wl;
  if(a==='close'){ prefs.welcomeDone=true; savePrefs(); VIEWS.home.mount($('v-home')); VIEWS.home.update(); return; }
  if(a==='connect')return openConnect();
  if(a==='cal')return openConnect('calendar');
  if(a==='todo'){ $('h-todo-in')?.focus(); return; }
  if(a==='link')return openLinkSheet({pinned:true});
  if(a==='name'){ const row=b.closest('.wl-step'); const main=row.querySelector('.main');
    main.innerHTML=`<form class="wl-name"><input placeholder="Your first name" maxlength="40" aria-label="Your name" autocomplete="given-name"></form>`; b.parentElement.remove();
    const f=main.querySelector('form'), inp=f.querySelector('input'); inp.focus();
    f.addEventListener('submit',ev=>{ ev.preventDefault(); const v=inp.value.trim(); if(!v)return; prefs.name=v; savePrefs(); VIEWS.home.update(); });
    inp.addEventListener('keydown',ev=>{ if(ev.key==='Escape'){ ev.stopPropagation(); renderWelcome(); } });
  }
});
// The connectors worth offering in the dashboard, in order, with what each one adds. The rest live in config.json
// (docs/open-source/fresh-profile.md); /api/setup describes their needs either way.
const CONNECT=[
  ['calendar','next','Calendar','Up next and meeting reminders'],
  ['github','github','GitHub','Your repos, and pull requests waiting on you'],
  ['ai','bolt','Agent sessions','What Claude Code and Codex are working on, in Live now'],
  ['aiUsage','usage','AI usage','What your AI tools have done and what it would cost'],
  ['delegations','agent','Hand work to an agent','Send a to-do to Claude or Codex and follow it'],
  ['todoRank','todo','To-do order','Claude puts your to-dos in a sensible order'],
  ['git','terminal','Projects','Recent work across your Git projects'],
  ['tailscale','share','Tailscale','Open Meridian on your phone and other computers'],
  ['linkMetadata','link','Link titles and icons','Fetched from the pages you save'],
  ['previews','image','Link previews','Screenshots of the links you save'],
  ['almanac','sparkle','Almanac','Weather, the moon and something new each day'],
  ['notify','bell','Phone reminders','Through ntfy, a free notification app'],
];
async function openConnect(focus){
  let data; try{ const r=await fetch(api('/api/setup')); if(!r.ok)throw new Error(r.status); data=await r.json(); }catch{ toast("Couldn't load the connectors"); return; }
  $('sheet-connect')?.remove();
  const box=document.createElement('div'); box.className='sheet sheet-connect'; box.id='sheet-connect'; box.setAttribute('role','dialog'); box.setAttribute('aria-label','Connect');
  const field=(name,f)=>{ const id=`cn-${name}-${f.key}`;
    const input=f.kind==='list'?`<textarea id="${id}" name="${f.key}" rows="2" placeholder="${esc(f.placeholder||'')}"${f.required?' required':''}></textarea>`
      :`<input id="${id}" name="${f.key}" type="${f.kind==='secret'?'password':f.kind==='url'?'url':'text'}" placeholder="${esc(f.placeholder||'')}"${f.required?' required':''} autocomplete="off" spellcheck="false">`;
    return `<div class="field"><label for="${id}">${esc(f.label)}</label>${input}${f.help?`<small class="hint">${esc(f.help)}</small>`:''}</div>`; };
  const row=([name,ic,label,what])=>{ const c=data.connectors[name]; if(!c)return '';
    const mac=c.platform==='darwin'&&!/Mac/i.test(navigator.platform);
    const why=!c.enabled&&!c.needs?.length&&c.reason&&c.reason!=='disabled'&&c.reason!=='demo'?c.reason:''; // with fields, the fields explain
    return `<div class="cn-row${c.enabled?' on':''}" data-cn="${name}"><span class="cn-ic">${icon(ic)}</span>
      <div class="main"><div class="t">${esc(label)}${c.enabled?'<span class="cn-on">On</span>':''}</div><div class="s">${esc(what)}</div>${why?`<div class="s cn-why">${esc(why)}</div>`:''}
        ${!c.enabled&&c.needs?.length?`<form class="cn-fields" hidden>${c.needs.map(f=>field(name,f)).join('')}<div class="foot"><span class="grow"></span><button type="button" class="btn sm ghost" data-cn-cancel>Cancel</button><button class="btn sm primary">Switch on</button></div></form>`:''}</div>
      <span class="acts"><button type="button" class="btn sm${c.enabled?' ghost':''}" data-cn-act${mac?' disabled title="Only on a Mac"':''}>${c.enabled?'Turn off':'Switch on'}</button></span></div>`; };
  box.innerHTML=`<h3>Connect your things<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
    <p class="cn-lede">Each one is off until you switch it on, and nothing leaves this computer unless you connect it.</p>
    <div class="cn-list">${CONNECT.map(row).join('')}</div>
    <p class="hint" style="margin-top:14px">More connectors, like folders of notes and your own services, are set in config.json.</p>`;
  const put=async(name,body)=>{ const r=await fetch(api('/api/setup/connectors/'+name),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({})); if(!r.ok)throw new Error(j.error||"That didn't work"); return j; };
  // The server refreshes the new source in the background: look again shortly so Home fills in.
  const after=async(name,j,on)=>{ await loadState(); setTimeout(loadState,1500); setTimeout(loadState,5000); if(on&&!j.enabled)toast(j.reason&&j.reason!=='disabled'?j.reason:"It's saved, but something it needs is missing");
    else toast(on?(j.needsRestart?'On. Restart Meridian to finish.':'On'):'Off'); openConnect(name); };
  box.addEventListener('click',async e=>{
    const r=e.target.closest('.cn-row'); if(!r)return; const name=r.dataset.cn, c=data.connectors[name];
    if(e.target.closest('[data-cn-cancel]')){ r.querySelector('.cn-fields').hidden=true; r.querySelector('[data-cn-act]').hidden=false; return; }
    const b=e.target.closest('[data-cn-act]'); if(!b)return;
    const form=r.querySelector('.cn-fields');
    if(!c.enabled&&form){ form.hidden=false; b.hidden=true; form.querySelector('input,textarea')?.focus(); return; }
    b.disabled=true; try{ const j=await put(name,{enabled:!c.enabled}); await after(name,j,!c.enabled); }catch(err){ toast(err.message); b.disabled=false; }
  });
  box.addEventListener('submit',async e=>{
    e.preventDefault(); const form=e.target, r=form.closest('.cn-row'), name=r.dataset.cn, settings={};
    for(const f of data.connectors[name].needs){ const v=form.elements[f.key]?.value.trim()||''; if(!v)continue; settings[f.key]=f.kind==='list'?v.split(/\n+/).map(x=>x.trim()).filter(Boolean):v; }
    const go=form.querySelector('.primary'); go.disabled=true;
    try{ const j=await put(name,{enabled:true,settings}); await after(name,j,true); }catch(err){ toast(err.message); go.disabled=false; }
  });
  // The weather needs a place: the browser already knows the timezone, and can offer where you are.
  const alm=box.querySelector('[data-cn="almanac"] .cn-fields');
  if(alm){ const tz=alm.elements.timezone; if(tz&&!tz.value)tz.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'';
    if(navigator.geolocation&&alm.elements.latitude){ const b=document.createElement('button'); b.type='button'; b.className='btn sm ghost'; b.innerHTML=`${icon('pin')}Use where I am`;
      b.addEventListener('click',()=>{ b.disabled=true; navigator.geolocation.getCurrentPosition(p=>{ alm.elements.latitude.value=p.coords.latitude.toFixed(4); alm.elements.longitude.value=p.coords.longitude.toFixed(4); b.disabled=false; alm.elements.name?.focus(); },()=>{ toast("Couldn't get your location. Type the numbers instead."); b.disabled=false; },{timeout:10000}); });
      alm.querySelector('.foot').prepend(b); } }
  document.body.appendChild(box); openSheet('sheet-connect');
  if(focus){ const r=box.querySelector(`[data-cn="${focus}"]`); r?.scrollIntoView({block:'nearest'}); if(!data.connectors[focus]?.enabled)r?.querySelector('[data-cn-act]')?.click(); }
}
// Switching a connector on or off (a fresh install) changes which tabs and Home cards exist: rebuild them.
let setupSig;
function setupChanged(s){
  const sig=s.setup?JSON.stringify(Object.entries(s.setup.connectors||{}).filter(([,c])=>c.enabled).map(([k])=>k)):'';
  if(sig===setupSig)return; const first=setupSig===undefined; setupSig=sig; if(first&&!sig)return;
  renderTabs();
  if(!visibleTabs().some(t=>t.id===view))go('home');
  else if(view==='home'){ VIEWS.home.mount($('v-home')); VIEWS.home.update(); }
}
// A quiet "updated 3 h ago" on a section whose source has stopped refreshing, and nothing at all when it's
// fresh (8 Oct 2026: only when something's actually stale). Offline has its own banner, so the tags step aside.
const STALE_AT={calendar:'#h-next-card .ch',fleet:'#h-live-card .ch',links:'#h-shelf-sec .sec-h'};
function markStale(offline){
  const src=state?.sources||{};
  for(const [k,sel] of Object.entries(STALE_AT)){
    const head=document.querySelector(sel); if(!head)continue;
    const v=src[k], old=!offline&&v&&(v.error||v.stale)&&v.lastSuccess&&Date.now()-v.lastSuccess>15*60e3;
    let tag=head.querySelector('.stale-tag');
    if(!old){ tag?.remove(); continue; }
    if(!tag){ tag=document.createElement('span'); tag.className='stale-tag'; head.insertBefore(tag,head.querySelector('.end')); }
    tag.textContent='updated '+ago(v.lastSuccess); tag.dataset.tip=`Couldn't refresh|Showing what it had at ${hm(v.lastSuccess)}`;
  }
}
// The last good copy of everything, so the page still works if the Home Mac is asleep.
const STASH='meridian.cc.stash.';
function stash(k,v){ clearTimeout(stash['t'+k]); stash['t'+k]=setTimeout(()=>{ try{ localStorage.setItem(STASH+k,JSON.stringify(v)); }catch{} },1500); }
function unstash(k){ try{ return JSON.parse(localStorage.getItem(STASH+k)||window.__meridianStash?.[STASH+k]||'null'); }catch{ return null; } }
function setOffline(at){ let b=$('offline'); if(!at){ b?.remove(); document.body.classList.remove('is-offline'); return; } if(!b){ b=document.createElement('div'); b.id='offline'; b.className='offline'; document.body.appendChild(b); } document.body.classList.add('is-offline'); b.innerHTML=`${icon('system')}<span>Home Mac offline. Showing what you last saw, ${esc(dayWord(at))} ${hm(at)}.</span>`; }
async function loadState(){ try{ const r=await fetch(api('/api/state')); if(!r.ok)throw new Error(r.status); absorb(await r.json()); setConn('live'); return true; }catch{ setConn('down','offline'); const c=unstash('state'); if(c&&!state)absorb(c,{cached:true}); return false; } }
function stream(){
  if(!('EventSource' in window))return setInterval(loadState,30000);
  if(es)return;
  es=new EventSource(api('/api/stream'));
  es.addEventListener('state',e=>{ try{ absorb(JSON.parse(e.data)); setConn('live'); }catch{} });
  es.addEventListener('nudge',e=>{ try{ nudge(JSON.parse(e.data)); }catch{} });
  es.addEventListener('stash',e=>{ try{ stEvent(JSON.parse(e.data)); }catch{} });
  es.addEventListener('panel',e=>{ try{ panelEvent(JSON.parse(e.data)); }catch{} });
  es.onerror=()=>setConn('down','reconnecting');
}
// The stream re-sends the whole state every 45 s, so in a browser it closes after 30 s
// in the background and reopens on return (which sends the latest state at once).
// Not in the Mac app: its hidden window still turns nudges into notifications.
let esIdle=0;
document.addEventListener('visibilitychange',()=>{
  if(root.dataset.app||!('EventSource' in window))return; clearTimeout(esIdle);
  if(!document.hidden){ if(!es){ stream(); stEvent(); } return; }
  esIdle=setTimeout(()=>{ es?.close(); es=null; },30000);
});
// An agent opened a draft or a page for Owner (drafts.js): in the Mac app, a tab in the side panel
// beside this page; anywhere else, a toast that opens it.
function panelEvent(d){
  if(!d||!d.url)return;
  const url=new URL(d.url,location.href).href, A=window.MeridianApp, draft=d.action==='draft';
  if(typeof A?.panel==='function')return void Promise.resolve(A.panel('new',{kind:draft?'doc':'web',url,mode:'split'})).catch(err=>toast(String(err?.message||err)));
  toast(draft?`Draft ready: ${d.title||'untitled'}`:'Your agent opened a page',{action:{label:'Open',run:()=>window.open(url,'_blank','noopener')}});
}
function setConn(mode,text){ const c=$('conn'); c.className='conn '+mode+updClass(); $('conntext').textContent=text||('live · '+hm(Date.now())); c.dataset.tip=updTip()||(mode==='live'?`Live|Last updated ${hm(Date.now())}${window.MeridianApp?.checkUpdate?' · click to check for updates':''}`:(text||mode)); }
// Updates (Meridian.app 1.5, Updater.swift): the live dot doubles as the update button. With a newer version
// published on the Home Mac, two circling arrows wrap the dot; a click offers it, and Update now installs it and
// restarts the app. With nothing new, a click checks. Only in the Mac app.
var upd=null;   // var: setConn can run before this line does
const updBusy=()=>upd?.phase==='downloading'||upd?.phase==='installing';
function updClass(){ return (upd?.available?' upd':'')+(updBusy()||upd?.phase==='checking'?' updating':''); }
function updTip(){ if(!upd)return '';
  if(updBusy())return 'Updating Meridian…|It restarts in a moment';
  if(upd.phase==='failed'&&upd.available)return `Update didn't finish|${upd.error||''} Click to try again`;
  if(upd.available)return `Update ready · Meridian ${upd.latest}|${upd.notes?upd.notes+' · ':''}click to install`;
  return ''; }
function setUpd(u){ upd=u||null; const c=$('conn'); if(!c)return; for(const k of ['upd','updating'])c.classList.remove(k); c.className+=updClass(); if(updTip())c.dataset.tip=updTip(); else if(c.classList.contains('live'))setConn('live'); }
function offerUpdate(){ const n=upd.runningTerminals||0;
  toast(`Meridian ${upd.latest} is ready${upd.notes?`: ${upd.notes}`:''}. It restarts to finish${n?`, closing ${n} running terminal${n>1?'s':''}`:''}.`,{action:{label:'Update now',run:installUpdate}}); }
async function installUpdate(){ setUpd({...upd,phase:'downloading'}); try{ await window.MeridianApp.installUpdate(); toast('Restarting Meridian…'); }catch(err){ setUpd({...upd,phase:'failed',error:String(err?.message||err)}); toast(String(err?.message||err)); } }
(()=>{ const A=window.MeridianApp, c=$('conn'); if(!A?.checkUpdate||!c)return;
  c.querySelector('i').innerHTML='<svg class="upd-ring" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';
  c.setAttribute('role','button'); c.tabIndex=0; c.setAttribute('aria-label','Connection and updates');
  const go=async()=>{ if(updBusy())return; if(upd?.available)return offerUpdate();
    setUpd({...(upd||{}),phase:'checking'}); const u=await A.checkUpdate().catch(()=>null); setUpd(u);
    if(u?.available)offerUpdate(); else toast(u?`You're up to date · Meridian ${u.current}`:'Couldn\'t reach the Home Mac to check'); };
  c.addEventListener('click',go); c.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } });
  addEventListener('meridianupdate',e=>setUpd(e.detail));
  A.updateStatus().then(setUpd).catch(()=>{});
})();
setInterval(()=>{ if($('conn').classList.contains('live'))setConn('live'); },30000);
async function loadLinks(){ try{ const r=await fetch(api('/api/links')); if(!r.ok)throw new Error(r.status); links=await r.json(); stash('links',links); renderSide(); VIEWS[view]?.update?.(); }catch{ const c=unstash('links'); if(c&&!(links.links||[]).length){ links=c; renderSide(); VIEWS[view]?.update?.(); } } }
async function loadJournal(){ try{ journal=await (await fetch(api('/api/journal'))).json(); if(view==='journal')VIEWS.journal.update(); }catch{} }
async function loadLedger(force){
  try{
    const r=await fetch(api('/api/ai-usage/ledger'+(force?'?force=1':'')));
    if(r.ok){ ledger=await r.json(); stash('ledger',ledger); }
    else{ // older daemon: fall back to the menu bar app's per-Mac totals
      const j=await (await fetch(api('/api/ai-usage'))).json(); ledger=ledgerFromReports(j.hosts||[]);
    }
  }catch{ ledger=ledger||unstash('ledger')||{rows:[],plans:[],sources:[]}; }
  if(view==='usage')VIEWS.usage.update(); if(view==='home')VIEWS.home.update();
}
function ledgerFromReports(hosts){
  const rows=[];
  for(const h of hosts){ const machine=/main/i.test(h.name||'')?'Main':/home/i.test(h.name||'')?'Home':(h.name||'Mac');
    for(const [date,d] of Object.entries(h.days||{})){ const tot=(d.claude||0)+(d.codex||0);
      for(const [prov,key] of [['claude','claude'],['openai','codex']]){ const cost=d[key]||0; if(!cost)continue;
        rows.push({date,provider:prov,plan:null,model:null,machine,source:'report',approx:true,cost,tokens:{total:tot?Math.round((d.tokens||0)*cost/tot):0}}); } } }
  return {rows,plans:[],models:{},sources:hosts.map(h=>({id:'report:'+h.name,label:h.name,rows:Object.keys(h.days||{}).length}))};
}
async function loadAlmanac(){ try{ const r=await fetch(api('/api/almanac')); if(!r.ok)return; almanac=await r.json(); stash('almanac',almanac); applyPrefs(); if(view==='home')VIEWS.home.update(); }catch{ if(!almanac){ almanac=unstash('almanac'); if(almanac){ applyTint(); if(view==='home')VIEWS.home.update(); } } } }
async function syncPrefsFromServer(){
  try{ const r=await fetch(api('/api/command/prefs')); if(!r.ok)return; const j=await r.json(); const server=j.prefs||j;
    if(server&&Number(server.updated)>Number(prefs.updated||0)){ prefs=migrate(merge(DEFAULTS,server)); try{localStorage.setItem(PREF_KEY,JSON.stringify(prefs));}catch{} applyPrefs(); renderSide(); if(customOpen())renderCustom(); }
  }catch{}
}
const noteUsage=(v)=>{ const k=v+':'+Math.floor(Date.now()/600000); if(noteUsage[k])return; noteUsage[k]=1; fetch(api('/api/usage'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:v})}).catch(()=>{}); };

// A meeting is about to start: toast with Join, and a native notification in the Mac app.
function nudge(n){
  const when=n.minutes>1?`in ${n.minutes} min`:'starting now'; const join=n.joinUrl?()=>window.open(n.joinUrl,'_blank','noopener'):null;
  toast(`${n.title}, ${when}`,{action:join?{label:'Join',run:join}:undefined,ms:20000});
  try{ if(window.MeridianApp?.notify)window.MeridianApp.notify({title:n.title,body:n.minutes>1?`Starts in ${n.minutes} minutes`:'Starting now',url:n.joinUrl||''}); }catch{}
}

/* ---------- router + most-recently-used ---------- */
function go(id){ if(!TAB_DEFS.some(t=>t.id===id))id='home'; if(location.hash!=='#'+id)history.pushState(null,'','#'+id); show(id); }
function show(id){
  if(!TAB_DEFS.some(t=>t.id===id))id='home';
  if(view===id){ if(isMobile())setDrawer(false); return; }
  if(id!=='stash')stClose(true); // an open stash item would otherwise sit over the next tab
  if(view)miniCache.delete(view);
  view=id;
  const i=mru.indexOf(id); if(i>=0)mru.splice(i,1); mru.unshift(id);
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('on',v.dataset.view===id));
  const V=VIEWS[id];
  if(!V.mounted){ V.mount($('v-'+id)); V.mounted=true; }
  V.update?.(true);
  renderTabs();
  document.title='Meridian · '+TAB_DEFS.find(t=>t.id===id).label;
  $('page').scrollTop=0; if(isMobile())scrollTo(0,0); // the window scrolls on a phone
  noteUsage(id);
  if(isMobile())setDrawer(false);
}
// #stash/<id> opens one stashed thing (the Mac app's tray links straight to them).
function route(){ const [tab,sub]=(location.hash.slice(1)||'home').split('?')[0].split('/'); show(tab); if(tab==='stash'&&sub)stOpen(sub); else if(ST.open)stClose(true); }
addEventListener('popstate',route); addEventListener('hashchange',route);
document.addEventListener('click',e=>{ const g=e.target.closest('[data-go]'); if(g){ e.preventDefault(); go(g.dataset.go); } });

/* ---------- sidebar ---------- */
function topShelf(){ return (links.links||[]).filter(l=>l.pinned).sort((a,b)=>(a.pinOrder||0)-(b.pinOrder||0)||String(a.created).localeCompare(String(b.created))); }
// In the Mac app, outside links open in its browser pane (Peek by default); ⌘-click goes to your browser.
function openUrl(url,e,mode){ const A=window.MeridianApp; if(A&&A.browse){ A.browse(url,e&&(e.metaKey||e.ctrlKey||e.button===1)?{mode:'browser'}:mode?{mode}:undefined); return; } window.open(url,'_blank','noopener'); }
function openLink(l,e){ const url=linkUrl(l); openUrl(url,e);
  fetch(api('/api/links/'+l.id+'/open'),{method:'POST'}).catch(()=>{}); l.opens=(l.opens||0)+1; l.lastOpened=new Date().toISOString(); }
const linkUrl=(l)=>l.url;
// How a device reaches a dev server: its Tailscale share first, then its tailnet
// address, and localhost only when Owner is sitting at the Home Mac.
const serverUrl=(s)=>s.shareUrl||(onHomeMac()?s.localUrl:(s.reachable||s.tailUrl||s.localUrl));
const homeOnly=(s)=>!s.shareUrl&&!s.reachable&&!s.tailUrl;
let sideSig='';
function liveServers(){ return groupServers(state?.local?.servers||[]).filter(s=>!s.ignored); }
function renderSide(){
  const top=topShelf().filter(inSpace).slice(0,8);
  const dock=(lookOpt('spacespos')||'bottom')==='bottom', son=spacesOn(); setHTML($('spaces'),son&&!dock?spacesHTML():''); setHTML($('spaces-dock'),son&&dock?spacesHTML(true):''); renderWebTabs();
  const eh=document.querySelector('.ess-h'); if(eh)eh.textContent=activeSpace()?activeSpace().name+' shelf':'Top shelf';
  const s1=sig([spaceId,top.map(l=>[l.id,l.title,l.health&&l.health.up]),(state?.local?.servers||[]).map(s=>[s.port,s.title,s.project,s.shareUrl,s.ignored]),prefs.side.liveOpen]);
  if(s1!==sideSig){ sideSig=s1;
    $('ess').innerHTML=top.map(l=>`<button class="ess-tile" data-link="${esc(l.id)}" data-tip="${esc(l.title)}|${esc(hostOf(l.url))}" aria-label="${esc(l.title)}">${favImg(l,'')}${l.health&&l.check!==false&&!l.health.up?'<i class="st"></i>':''}</button>`).join('')
      +(top.length<8?`<button class="ess-tile ess-add" id="ess-add" data-tip="Add to the top shelf|or paste a link anywhere" aria-label="Add to the top shelf">${icon('plus')}</button>`:'');
    const servers=liveServers();
    $('live-n').textContent=servers.length||'';
    $('live-h').classList.toggle('closed',!prefs.side.liveOpen);
    $('side-live').hidden=!prefs.side.liveOpen;
    // Ten is plenty in the sidebar; System has the full list.
    $('side-live').innerHTML=(servers.slice(0,10).map(s=>`<a class="sl" href="${esc(serverUrl(s))}" target="_blank" rel="noopener" data-port="${s.port}" data-tip="${esc(s.title&&!/^Directory listing/i.test(s.title)?s.title:serverName(s))}|${esc(s.shareUrl?'On Tailscale · '+hostOf(s.shareUrl):homeOnly(s)?'Only on the Home Mac':'On your tailnet')}"><span class="p">:${s.port}</span><span class="t">${esc(serverName(s))}</span><i class="ts${s.shareUrl||!homeOnly(s)?' on':''}"></i><span class="acts"><button type="button" data-sact="${s.shareUrl?'copy':'share'}" aria-label="${s.shareUrl?'Copy Tailscale link':'Put on Tailscale'}" data-tip="${s.shareUrl?'Copy Tailscale link':'Put on Tailscale'}">${icon(s.shareUrl?'copy':'share')}</button><button type="button" data-sact="stop" aria-label="Stop" data-tip="Stop it">${icon('close')}</button></span></a>`).join('')+(servers.length>10?`<button class="sl dim" data-go="system"><span class="p"></span><span class="t">All ${servers.length} in System</span></button>`:''))||'<div class="sl dim">Nothing running</div>';
  }
  renderTabs();
}
/* dev server actions, shared by the sidebar, the shelf and System */
const findServer=(port)=>(state?.local?.servers||[]).find(x=>x.port===Number(port));
async function shareServer(s,{open=false}={}){
  toast(`Putting :${s.port} on Tailscale…`);
  try{ const j=await send('/api/local/share',{port:s.port}); s.shareUrl=j.url; sideSig=''; renderSide(); try{ await navigator.clipboard.writeText(j.url); }catch{} toast(`On Tailscale. Link copied: ${hostOf(j.url)}`); if(open)window.open(j.url,'_blank','noopener'); loadState(); return j.url; }
  catch(err){ toast(err.message); }
}
async function unshareServer(s){
  // Links an agent made weren't created by Meridian, so they need a deliberate "anyway".
  if(!s.shareOwned&&!confirm(`An agent session put :${s.port} on Tailscale, not Meridian. Take the link down anyway? Anyone using ${hostOf(s.shareUrl)} will lose it.`))return;
  try{ await send('/api/local/unshare',{port:s.port,force:!s.shareOwned}); toast(`:${s.port} is off Tailscale`); loadState(); }catch(err){ toast(err.message); } }
async function stopServer(s){
  if(!confirm(`Stop ${serverName(s)} on :${s.port}?`))return;
  try{ await send('/api/local/stop',{port:s.port}); toast(`Stopped ${serverName(s)}`); state.local.servers=state.local.servers.filter(x=>x.port!==s.port); sideSig=''; renderSide(); VIEWS[view]?.update?.(true); }catch(err){ toast(err.message); }
}
async function ignoreServer(s,ignored=true){
  try{ await send('/api/local/ignore',{port:s.port,project:s.project,ignored}); s.ignored=ignored; sideSig=''; renderSide(); VIEWS[view]?.update?.(true);
    if(ignored)toast(`Hidden ${serverName(s)}. It still runs.`,{undo:()=>ignoreServer(s,false)}); }catch(err){ toast(err.message); }
}
async function copyServer(s){ const u=serverUrl(s); try{ await navigator.clipboard.writeText(u); toast('Copied '+hostOf(u)); }catch{ toast('Copy failed'); } }
function saveServer(s){ openLinkSheet({url:s.shareUrl||s.tailUrl||s.localUrl,title:s.title&&!/^Directory listing/i.test(s.title)?s.title:serverName(s),category:s.category||'',pinned:false}); }
function serverMenu(x,y,s){
  menu(x,y,[
    {label:'Open',icon:'out',act:()=>homeOnly(s)&&!onHomeMac()?shareServer(s,{open:true}):openUrl(serverUrl(s))},
    {label:s.shareUrl?'Copy Tailscale link':'Copy link',icon:'copy',act:()=>copyServer(s)},
    s.shareUrl?{label:'Take off Tailscale',icon:'share',act:()=>unshareServer(s)}:{label:'Put on Tailscale',icon:'share',act:()=>shareServer(s)},
    {label:'Save to the shelf',icon:'plus',act:()=>saveServer(s)},
    'hr',
    {label:s.ignored?'Show in lists again':'Hide from lists',icon:s.ignored?'eye':'eyeoff',act:()=>ignoreServer(s,!s.ignored)},
    {label:'Stop it',icon:'stop',danger:true,act:()=>stopServer(s)},
  ]);
}
// One handler for server rows and tiles anywhere: [data-port] with [data-sact] buttons.
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-sact]'); const host=e.target.closest('[data-port]'); if(!host)return;
  const s=findServer(host.dataset.port); if(!s)return;
  if(b){ e.preventDefault(); e.stopPropagation(); const a=b.dataset.sact; if(a==='share')shareServer(s); if(a==='unshare')unshareServer(s); if(a==='copy')copyServer(s); if(a==='stop')stopServer(s); if(a==='save')saveServer(s); if(a==='hide')ignoreServer(s,!s.ignored); if(a==='menu'){ const r=b.getBoundingClientRect(); serverMenu(r.left,r.bottom+6,s); } return; }
  // A server that only listens on the Home Mac can't open from another device until it's shared.
  if(host.tagName==='A'&&homeOnly(s)&&!onHomeMac()){ e.preventDefault(); shareServer(s,{open:true}); }
},true);
document.addEventListener('contextmenu',e=>{ const host=e.target.closest('[data-port]'); if(!host)return; const s=findServer(host.dataset.port); if(!s)return; e.preventDefault(); serverMenu(e.clientX,e.clientY,s); });

function serverName(s){ const p=String(s.project||''); const last=p.split('/').pop(); return /^(web|app|site|client|frontend|public|dist|src|www)$/i.test(last)?p.replace(/^Developer\//,''):(last||s.title||s.command); }
function groupServers(servers){ const seen=new Map(); for(const s of servers){ const k=(s.project||'')+'|'+(s.title||s.command); if(!seen.has(k))seen.set(k,s); } return [...seen.values()].sort((a,b)=>a.port-b.port); }
function tabBadge(id){
  if(!state)return '';
  if(id==='dogfood'){ const n=feedbackRuns().filter(r=>['running','queued','stalled'].includes(r.status)).length; return n?`<span aria-hidden="true" class="n hot">${n}</span>`:''; }
  if(id==='system'){ const f=state.fleet||{}; const n=[...(f.services||[]),...(f.sites||[])].filter(x=>!x.up&&!x.paused).length; return n?`<span aria-hidden="true" class="n alert">${n}<span class="sfx"> down</span></span>`:''; }
  if(id==='shelf')return `<span aria-hidden="true" class="n">${(links.links||[]).length||''}</span>`;
  if(id==='stash')return ST.fresh?`<span aria-hidden="true" class="n hot" data-tip="New since you last looked">${ST.fresh}</span>`:`<span aria-hidden="true" class="n">${ST.data?.counts?.all||''}</span>`;
  return '';
}
function renderTabs(){
  const pv=prefs.side.tabStyle==='previews'&&!isMobile()&&root.dataset.sidemode!=='compact';
  $('tabs').classList.toggle('pv',pv);
  setHTML($('tabs'),visibleTabs().map((t,i)=>pv
    ?`<button class="tab tabpv${t.id===view?' on':''}" data-tab="${t.id}" aria-current="${t.id===view?'page':'false'}" ${root.dataset.sidemode==='compact'?`aria-label="${esc(t.label)}"`:''}><span class="thumb" aria-hidden="true"><span class="mini" data-mini="${t.id}"></span></span><span class="cap">${icon(t.icon)}<span class="lbl">${esc(t.label)}</span>${tabBadge(t.id)}</span></button>`
    :`<button class="tab${t.id===view?' on':''}" data-tab="${t.id}" aria-current="${t.id===view?'page':'false'}" data-tip="${esc(t.label)}${i<9?'|Press '+(i+1):''}" ${root.dataset.sidemode==='compact'?`aria-label="${esc(t.label)}"`:''}>${icon(t.icon)}<span class="lbl">${esc(t.label)}</span>${tabBadge(t.id)}<span class="k" aria-hidden="true">${i<9?i+1:''}</span></button>`).join(''));
  if(pv)paintMinis();
}
// Live miniatures of each view for the Previews tab style: a scaled copy of the
// real page with every id and data attribute stripped, so nothing in it can be
// mistaken for the live element by a handler or a querySelector.
const miniCache=new Map();
// What a miniature copies: the markup plus anything typed, which innerHTML doesn't include.
function miniSource(v){ return v.innerHTML+'\0'+[...v.querySelectorAll('input,textarea,select')].map(el=>el.type==='checkbox'||el.type==='radio'?el.checked:el.value).join('\0'); }
function miniOf(id){
  const v=$('v-'+id); const V=VIEWS[id]; if(!v||!V)return null;
  if(!V.mounted){ try{ V.mount(v); V.mounted=true; V.update?.(true); }catch{ return null; } }
  if(id!==view&&miniCache.has(id))return miniCache.get(id);
  const source=miniSource(v), cached=miniCache.get(id); if(cached?.__source===source)return cached;
  const c=v.cloneNode(true); c.classList.add('on'); c.style.animation='none';
  [c,...c.querySelectorAll('*')].forEach(el=>{ el.removeAttribute('id'); for(const a of [...el.attributes])if(a.name.startsWith('data-')||a.name==='title'||a.name==='href'||a.name==='onerror'||a.name==='onload')el.removeAttribute(a.name); });
  c.querySelectorAll('textarea,input').forEach(x=>x.setAttribute('tabindex','-1'));
  c.__source=source; miniCache.set(id,c); return c;
}
function paintMinis(){
  document.querySelectorAll('#tabs .mini').forEach(m=>{ const id=m.dataset.mini;
    // The brief lives in a frame that can't be copied, so its miniature is today's painting.
    if(id==='brief'){ if(!m.firstChild){ m.style.transform='none'; m.style.inset='0'; m.innerHTML=`<img alt="" src="${api('/api/daily-art/image')}" style="width:100%;height:100%;object-fit:cover;display:block">`; } return; }
    const c=miniOf(id); if(!c)return; const w=m.parentElement.clientWidth||110; const scale=w/Math.max(900,$('page').clientWidth||1100);
    m.style.setProperty('--s',scale);
    // Reuse the same snapshot until its page changes or the minute refresh expires it.
    if(m.__copy!==c){ m.replaceChildren(c.cloneNode(true)); m.__copy=c; }
    m.firstChild.style.width=Math.max(900,$('page').clientWidth||1100)+'px'; });
}
function refreshMinis(){
  // A minute tick only needs a new snapshot when its source actually changed.
  for(const [id,c] of miniCache){ const v=$('v-'+id); if(!v||c.__source!==miniSource(v))miniCache.delete(id); }
  paintMinis();
}
// Refresh the copy of the view he just left, and the rest now and then.
setInterval(()=>{ if(prefs.side.tabStyle==='previews')refreshMinis(); },60000);
$('tabs').addEventListener('click',e=>{ const t=e.target.closest('[data-tab]'); if(t&&!dragJustEnded())go(t.dataset.tab); });
$('tabs').addEventListener('contextmenu',e=>{ const t=e.target.closest('[data-tab]'); if(!t)return; e.preventDefault(); const id=t.dataset.tab;
  menu(e.clientX,e.clientY,[{label:'Open',icon:'out',act:()=>go(id)},id==='home'?null:{label:'Hide this tab',icon:'eyeoff',act:()=>{ prefs.tabs.hidden=[...new Set([...prefs.tabs.hidden,id])]; savePrefs(); renderTabs(); toast('Hidden. Bring it back in Customise.',{undo:()=>{ prefs.tabs.hidden=prefs.tabs.hidden.filter(x=>x!==id); savePrefs(); renderTabs(); }}); }},'hr',{label:'Customise tabs',icon:'edit',act:()=>openCustom('side')}]); });
$('ess').addEventListener('click',e=>{ if(dragJustEnded())return; if(e.target.closest('#ess-add'))return openLinkSheet({pinned:true}); const t=e.target.closest('[data-link]'); if(!t)return; const l=links.links.find(x=>x.id===t.dataset.link); if(l)openLink(l,e); });
$('ess').addEventListener('contextmenu',e=>{ const t=e.target.closest('[data-link]'); if(!t)return; e.preventDefault(); linkMenu(e.clientX,e.clientY,t.dataset.link); });
$('live-tog').addEventListener('click',()=>{ prefs.side.liveOpen=!prefs.side.liveOpen; savePrefs(); sideSig=''; renderSide(); });
$('brand').addEventListener('click',()=>go('home'));
$('search-open').addEventListener('click',()=>palOpen());
$('custom-open').addEventListener('click',()=>openCustom());
// The cog at the bottom of the sidebar: everything that used to be three buttons.
function cogMenu(){ const r=$('foot-cog').getBoundingClientRect(); menu(r.left,r.top-8,[
  {head:'Customise'},
  {label:'Look',icon:'palette',act:()=>openCustom('look')},
  {label:'Home',icon:'home',act:()=>openCustom('home')},
  {label:'Sidebar and tabs',icon:'sidebar',act:()=>openCustom('side')},
  {label:'Spaces',icon:'allsp',act:()=>openCustom('spaces')},
  {label:'General',icon:'sliders',act:()=>openCustom('more')},
  'hr',
  {label:'Shortcuts',icon:'keys',act:()=>openKeys()},
  {label:'Morning brief',icon:'brief',act:()=>{ location.href='/'+(token?'?t='+encodeURIComponent(token):''); }},
  'hr',
  {label:DEMO?'Turn demo mode off':'Demo mode',icon:'sparkle',act:()=>setDemo(!DEMO)},
]); }
// Click: Settings in the middle of the screen. Right-click: the short menu, for demo mode and the brief.
$('foot-cog').addEventListener('click',()=>openSettings());
$('foot-cog').addEventListener('contextmenu',e=>{ e.preventDefault(); cogMenu(); });
$('keys-open').addEventListener('click',openKeys);

// Drag to reorder (the top shelf, the tab list, lists in Customise), with a mouse or trackpad. The item you pick up
// follows the pointer and leaves a gap; the others slide out of the way as you go, so you can see where it'll land.
// preventDefault on pointerdown stops the browser from starting a native image drag, which kills the pointer stream.
let dragEndedAt=0; const dragJustEnded=()=>Date.now()-dragEndedAt<250;
function sortable(container,itemSel,{axis='x',onDrop,handle}={}){
  container.addEventListener('pointerdown',e=>{
    // Mouse and trackpad only: on a phone a swipe to scroll began a drag, reordered the tile and saved it.
    if(e.button!==0||e.pointerType!=='mouse')return;
    const item=e.target.closest(itemSel); if(!item||!container.contains(item))return;
    if(handle&&!e.target.closest(handle))return;
    if(e.target.closest('.hover-acts,input,[data-thide],[data-hhide]'))return;
    e.preventDefault();
    const sx=e.clientX, sy=e.clientY; let ghost=null, started=false, lastSwap=0;
    const keyOf=(x)=>x.dataset.id||x.dataset.link||x.dataset.tab||x.dataset.hsec||x.dataset.key;
    const parent=item.parentElement; const home=item.nextSibling;
    const items=()=>[...parent.children].filter(x=>x.matches(itemSel)&&keyOf(x));
    const before=items().map(keyOf).join();
    // Where an item sits in the layout, ignoring any slide that's still running.
    const box=(x)=>{ const r=x.getBoundingClientRect(); const m=new DOMMatrixReadOnly(getComputedStyle(x).transform); return {l:r.left-m.m41,t:r.top-m.m42,w:r.width,h:r.height}; };
    const flip=(fn)=>{ const list=items().filter(x=>x!==item); const was=new Map(list.map(x=>[x,box(x)])); fn();
      for(const x of list){ const a=was.get(x), b=box(x); const dx=a.l-b.l, dy=a.t-b.t; if(!dx&&!dy)continue;
        x.getAnimations().forEach(an=>an.cancel());
        x.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'none'}],{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:260,easing:'cubic-bezier(.3,1.25,.4,1)'}); } };
    // A refresh can redraw the list mid-drag. Then the item in hand is a stale copy: putting it back would save a duplicate.
    const alive=()=>item.isConnected&&item.parentElement===parent;
    const move=(ev)=>{
      if(!alive())return end({type:'pointercancel'});
      if(!started){ if(Math.hypot(ev.clientX-sx,ev.clientY-sy)<5)return; started=true;
        const r=item.getBoundingClientRect(); ghost=item.cloneNode(true); ghost.classList.add('sort-ghost');
        // Out of its list the copy loses the list's styles, so it takes the ones it had.
        const cs=getComputedStyle(item); for(const p of ['background','borderRadius','padding','display','alignItems','gap','fontSize','fontWeight','fontFamily','color'])ghost.style[p]=cs[p];
        Object.assign(ghost.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
        ghost._dx=sx-r.left; ghost._dy=sy-r.top; document.body.appendChild(ghost);
        item.classList.add('sort-gap'); document.documentElement.classList.add('grabbing'); }
      ghost.style.left=(ev.clientX-ghost._dx)+'px'; ghost.style.top=(ev.clientY-ghost._dy)+'px';
      if(Date.now()-lastSwap<90)return;
      // The item under the pointer makes room: moving forward you land after it, moving back you land before it.
      const list=items(); const over=list.find(x=>{ if(x===item)return false; const b=box(x); return ev.clientX>=b.l&&ev.clientX<=b.l+b.w&&ev.clientY>=b.t&&ev.clientY<=b.t+b.h; });
      if(!over)return;
      const fwd=list.indexOf(over)>list.indexOf(item); const b=box(over);
      const past=axis==='x'?(fwd?ev.clientX>b.l+b.w*.3:ev.clientX<b.l+b.w*.7):(fwd?ev.clientY>b.t+b.h*.3:ev.clientY<b.t+b.h*.7);
      if(!past)return;
      lastSwap=Date.now(); flip(()=>parent.insertBefore(item,fwd?over.nextSibling:over));
    };
    const end=(ev)=>{
      removeEventListener('pointermove',move); removeEventListener('pointerup',end); removeEventListener('pointercancel',end); removeEventListener('keydown',esc,true);
      document.documentElement.classList.remove('grabbing');
      if(!started)return;
      dragEndedAt=Date.now();
      if(!alive()){ ghost?.remove(); item.classList.remove('sort-gap'); return; }
      const cancel=ev.type==='pointercancel'||ev.type==='keydown';
      if(cancel)flip(()=>parent.insertBefore(item,home&&home.parentNode===parent?home:null));
      // The picked-up copy settles into the gap before the real one comes back.
      const r=item.getBoundingClientRect(); const g=ghost;
      g.animate([{left:g.style.left,top:g.style.top},{left:r.left+'px',top:r.top+'px'}],{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:160,easing:'cubic-bezier(.2,.9,.25,1)',fill:'forwards'}).finished.catch(()=>{}).then(()=>{ g.remove(); item.classList.remove('sort-gap'); });
      const ids=[...new Set(items().map(keyOf))];
      if(!cancel&&ids.join()!==before)setTimeout(()=>onDrop(ids,parent),170);
    };
    const esc=(ev)=>{ if(ev.key==='Escape'){ ev.preventDefault(); ev.stopPropagation(); end(ev); } };
    addEventListener('pointermove',move); addEventListener('pointerup',end); addEventListener('pointercancel',end); addEventListener('keydown',esc,true);
  });
}
async function savePinOrder(ids){
  const byId=new Map(links.links.map(l=>[l.id,l])); ids.forEach((id,i)=>{ const l=byId.get(id); if(l)l.pinOrder=i; });
  sideSig=''; renderSide(); VIEWS[view]?.update?.(true);
  try{ await send('/api/links/pin-order',{ids}); }catch(err){ toast('Could not save the order: '+err.message); loadLinks(); }
}
sortable($('ess'),'.ess-tile[data-link]',{axis:'x',onDrop:(ids)=>savePinOrder(mergePinOrder(ids))});
sortable($('tabs'),'.tab',{axis:'y',onDrop:(ids)=>{ const hidden=prefs.tabs.order.filter(id=>!ids.includes(id)); prefs.tabs.order=[...ids,...hidden]; savePrefs(); renderTabs(); }});

// Sidebar modes: docked, compact rail, float (peeks from the edge) and off.
function setSideMode(mode){ if(!['docked','compact','float','off'].includes(mode))return; if(['docked','compact'].includes(mode))prefs.side.last=mode; prefs.side.mode=mode; savePrefs(); document.body.classList.remove('peek'); if((mode==='float'||mode==='off')&&$('side').contains(document.activeElement))$('side-show').focus({preventScroll:true}); if(customOpen())renderCustom(); }
function toggleSidebar(){
  if(isMobile())return setDrawer(!document.body.classList.contains('drawer-open'));
  const m=prefs.side.mode; if(m==='docked'||m==='compact')setSideMode(prefs.side.hide||'float'); else setSideMode(prefs.side.last||'docked');
}
$('side-hide').addEventListener('click',toggleSidebar);
$('side-show').addEventListener('click',()=>{ if(isMobile())return setDrawer(true); setSideMode(prefs.side.last||'docked'); });
let peekT=0;
$('edge').addEventListener('mouseenter',()=>{ clearTimeout(peekT); document.body.classList.add('peek'); });
$('side').addEventListener('mouseenter',()=>clearTimeout(peekT));
$('side').addEventListener('mouseleave',()=>{ if(prefs.side.mode!=='float'&&prefs.side.mode!=='off')return; clearTimeout(peekT); peekT=setTimeout(()=>document.body.classList.remove('peek'),280); });
$('side-resize').addEventListener('pointerdown',e=>{ e.preventDefault(); const right=prefs.side.side==='right';
  const move=(ev)=>{ let w=Math.max(208,Math.min(380,right?innerWidth-ev.clientX:ev.clientX)); if(ev.shiftKey)w=[208,252,320].reduce((a,b)=>Math.abs(b-w)<Math.abs(a-w)?b:a); prefs.side.width=Math.round(w); root.style.setProperty('--side-w',prefs.side.width+'px'); $('side-resize').setAttribute('aria-valuenow',String(prefs.side.width)); };
  const up=()=>{ removeEventListener('pointermove',move); removeEventListener('pointerup',up); savePrefs(); };
  addEventListener('pointermove',move); addEventListener('pointerup',up); });
$('side-resize').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(e.key))return;
  e.preventDefault(); const direction=prefs.side.side==='right'?-1:1;
  const w=e.key==='Home'?208:e.key==='End'?380:e.key==='Enter'?252:(prefs.side.width||252)+(e.key==='ArrowRight'?8:-8)*direction;
  prefs.side.width=Math.max(208,Math.min(380,w)); root.style.setProperty('--side-w',prefs.side.width+'px'); $('side-resize').setAttribute('aria-valuenow',String(prefs.side.width)); savePrefs();
});
$('side-resize').addEventListener('dblclick',()=>{ prefs.side.width=252; root.style.setProperty('--side-w','252px'); $('side-resize').setAttribute('aria-valuenow','252'); savePrefs(); });
let drawerFocus=null;
function setDrawer(open){
  const was=document.body.classList.contains('drawer-open'); document.body.classList.toggle('drawer-open',open);
  if(open&&!was){ drawerFocus=document.activeElement; $('side').querySelector('button')?.focus({preventScroll:true}); }
  if(!open&&was){ if(drawerFocus?.isConnected)drawerFocus.focus({preventScroll:true}); drawerFocus=null; }
}
$('side').addEventListener('focusin',()=>{ if(['float','off'].includes(root.dataset.sidemode))document.body.classList.add('peek'); });
$('side').addEventListener('focusout',e=>{ if(!$('side').contains(e.relatedTarget)&&!$('side').matches(':hover'))document.body.classList.remove('peek'); });
// With the drawer open, a tap anywhere on the shrunken page closes it.
$('page').addEventListener('click',e=>{ if(document.body.classList.contains('drawer-open')){ e.preventDefault(); e.stopPropagation(); setDrawer(false); } },true);
addEventListener('resize',()=>{ root.dataset.sidemode=isMobile()?'docked':prefs.side.mode; });

/* ---------- shared bits: menus, toasts, sheets ---------- */
let menuEl=null;
function closeMenu(){ if(menuEl){ menuEl.remove(); menuEl=null; } }
function menu(x,y,items){
  closeMenu(); menuEl=document.createElement('div'); menuEl.className='menu';
  const list=items.filter(Boolean);
  menuEl.innerHTML=list.map((it,i)=>it==='hr'?'<hr>':it.head?`<div class="mh">${esc(it.head)}</div>`:`<button type="button" data-i="${i}" class="${it.danger?'danger':''}">${icon(it.icon||'chev')}${esc(it.label)}</button>`).join('');
  document.body.appendChild(menuEl);
  const r=menuEl.getBoundingClientRect(); menuEl.style.left=Math.min(x,innerWidth-r.width-10)+'px'; menuEl.style.top=Math.min(y,innerHeight-r.height-10)+'px';
  menuEl.addEventListener('click',e=>{ const b=e.target.closest('[data-i]'); if(!b)return; const it=list[Number(b.dataset.i)]; closeMenu(); it.act&&it.act(); });
}
document.addEventListener('pointerdown',e=>{ if(menuEl&&!menuEl.contains(e.target))closeMenu(); },true);
function toast(msg,{undo,action,ms=4200}={}){
  const t=$('toast'), opener=document.activeElement; const hide=()=>{ t.classList.remove('on'); if(t.contains(document.activeElement)&&opener?.isConnected)opener.focus({preventScroll:true}); t.querySelectorAll('button').forEach(b=>b.inert=true); }; $('toast-t').textContent=msg; t.querySelectorAll('button').forEach(x=>x.remove());
  const add=(label,fn)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=label; b.onclick=()=>{ hide(); fn(); }; t.appendChild(b); };
  if(action)add(action.label,action.run); if(undo)add('Undo',undo);
  t.classList.add('on'); clearTimeout(toast.t); toast.t=setTimeout(hide,undo||action?Math.max(ms,8000):ms);
}
/* tooltips: designed ones, not the browser's grey boxes. Any title= becomes data-tip. */
const tipx=document.createElement('div'); tipx.className='tipx'; tipx.setAttribute('role','tooltip'); tipx.setAttribute('aria-hidden','true'); document.body.appendChild(tipx);
let tipEl=null, tipT=0;
function hideTip(){ clearTimeout(tipT); tipEl=null; tipx.classList.remove('on'); tipx.setAttribute('aria-hidden','true'); }
function showTip(el){
  // Docked tabs already show their names; the tip only earns its place on the compact rail.
  if(!el.isConnected||(el.classList.contains('tab')&&root.dataset.sidemode!=='compact'))return; const [t,sub]=String(el.dataset.tip).split('|'); tipx.innerHTML=esc(t)+(sub?`<small>${esc(sub)}</small>`:''); tipx.classList.add('on'); tipx.removeAttribute('aria-hidden');
  const r=el.getBoundingClientRect(), w=tipx.offsetWidth, h=tipx.offsetHeight; const compact=root.dataset.sidemode==='compact'; const inSide=!!el.closest('.side')&&!isMobile()&&(compact||!el.closest('.ess')); const right=prefs.side.side!=='right';
  let x,y; if(el.closest('.ess')&&!compact){ x=r.left+r.width/2-w/2; y=r.bottom+8; } else if(inSide){ x=right?r.right+10:r.left-w-10; y=r.top+r.height/2-h/2; } else { x=r.left+r.width/2-w/2; y=r.top-h-8; if(y<8)y=r.bottom+8; }
  tipx.style.left=Math.max(8,Math.min(innerWidth-w-8,x))+'px'; tipx.style.top=Math.max(8,Math.min(innerHeight-h-8,y))+'px';
}
document.addEventListener('pointerover',e=>{ if(e.pointerType==='touch')return; const el=e.target.closest('[data-tip]'); if(el===tipEl)return; hideTip(); if(!el)return; tipEl=el; tipT=setTimeout(()=>showTip(el),el.closest('.side')?220:450); });
document.addEventListener('pointerdown',hideTip,true); addEventListener('scroll',hideTip,true); addEventListener('blur',hideTip);
function tipify(scope=document){ scope.querySelectorAll('[title]').forEach(el=>{ if(el.closest('svg')||el.tagName==='LINK')return; if(!el.dataset.tip)el.dataset.tip=el.title; if(el.matches('button,a[href],iframe,[role=button],[role=radio],[role=slider]')&&!el.getAttribute('aria-label')&&!el.textContent.trim())el.setAttribute('aria-label',el.title.split('|')[0]); el.removeAttribute('title'); }); scope.querySelectorAll('.sec-h h3').forEach(el=>el.setAttribute('aria-level','2')); scope.querySelectorAll('button[data-tip],a[href][data-tip],[role=button][data-tip]').forEach(el=>{ if(!el.getAttribute('aria-label')&&!el.textContent.trim())el.setAttribute('aria-label',el.dataset.tip.split('|')[0]); }); }
new MutationObserver(()=>{ cancelAnimationFrame(tipify.r); tipify.r=requestAnimationFrame(()=>tipify()); }).observe(document.body,{childList:true,subtree:true});
tipify();

function openSheet(id){ closeOverlays(); $(id).classList.add('on'); $('scrim').classList.add('on'); window.MeridianA11y?.open($(id)); setTimeout(()=>$(id).querySelector('textarea,input:not([type=hidden])')?.focus(),60); }
// Focus left inside a closed overlay would be invisible and would swallow the next key, so it goes back to the page.
function closeOverlays(){ $('pal-in').setAttribute('aria-expanded','false'); document.querySelectorAll('.sheet.on,.drawer-r.on,.pal.on').forEach(x=>{ x.classList.remove('on'); if(x.contains(document.activeElement))document.activeElement.blur(); }); $('scrim').classList.remove('on'); setDrawer(false); closeMenu(); closeColourPicker(); window.MeridianA11y?.close(); document.dispatchEvent(new Event('overlays-closed')); }
$('scrim').addEventListener('click',closeOverlays);
document.addEventListener('click',e=>{ if(e.target.closest('[data-close]'))closeOverlays(); });

/* ---------- link sheet: add, edit, remove ---------- */
let lsWhere='top';
function setWhere(v){ lsWhere=v; $('ls-where').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===v))); }
$('ls-where').addEventListener('click',e=>{ const b=e.target.closest('[data-v]'); if(b)setWhere(b.dataset.v); });
function openLinkSheet(pre={}){
  const editing=!!pre.id; const sp=activeSpace(); if(!editing&&!pre.category&&sp&&sp.groups?.length)pre={...pre,category:sp.groups[0]};
  $('ls-title').textContent=editing?'Edit link':'Add to the shelf';
  $('ls-save').textContent=editing?'Save':'Add';
  $('ls-del').hidden=!editing;
  $('ls-id').value=pre.id||''; $('ls-url').value=pre.url||''; $('ls-name').value=pre.title||''; $('ls-cat').value=pre.category||''; $('ls-note').value=pre.note||'';
  $('ls-cats').innerHTML=[...new Set([...(links.categories||[]),...(links.links||[]).map(l=>l.category)])].filter(Boolean).map(c=>`<option value="${esc(c)}">`).join('');
  setWhere(editing?(pre.pinned?'top':'shelf'):pre.pinned===true?'top':pre.pinned===false?'shelf':(topShelf().length<8?'top':'shelf'));
  openSheet('sheet-link');
  if(pre.url&&!pre.title)fetchMeta(pre.url);
  setTimeout(()=>(pre.url?$('ls-name'):$('ls-url')).focus(),80);
}
async function fetchMeta(url){
  if(!looksLikeUrl(url))return;
  $('ls-name').placeholder='Looking up the page title…';
  try{ const j=await (await fetch(api('/api/link-meta?url='+encodeURIComponent(url)))).json();
    if(j.title&&!$('ls-name').value&&$('ls-url').value.trim()===url)$('ls-name').value=j.title;
    if(j.category&&!$('ls-cat').value)$('ls-cat').value=j.category;
  }catch{} finally{ $('ls-name').placeholder='Fills in from the page'; }
}
$('ls-url').addEventListener('change',()=>fetchMeta($('ls-url').value.trim()));
$('ls-url').addEventListener('paste',()=>setTimeout(()=>fetchMeta($('ls-url').value.trim()),0));
$('sheet-link').addEventListener('submit',async e=>{
  e.preventDefault();
  let url=$('ls-url').value.trim(); if(url&&!/^https?:\/\//i.test(url))url='https://'+url;
  const id=$('ls-id').value; const pinned=lsWhere==='top';
  const body={url,title:$('ls-name').value.trim(),category:$('ls-cat').value.trim()||'Tools',note:$('ls-note').value.trim(),pinned};
  const existing=id&&links.links.find(l=>l.id===id);
  if(pinned&&(!existing||!existing.pinned))body.pinOrder=Math.max(-1,...topShelf().map(l=>l.pinOrder||0))+1;
  $('ls-save').disabled=true;
  try{ if(id)await send('/api/links/'+id,body,'PATCH'); else await send('/api/links',body);
    closeOverlays(); toast(id?'Saved':(pinned?'On the top shelf':'On the shelf')); await loadLinks();
  }catch(err){ toast(err.message); } finally{ $('ls-save').disabled=false; }
});
// Paste: one tap fills the link (the phone's way in; desktop too). Safari shows its own Paste bubble.
async function clipText(){ if(!navigator.clipboard?.readText)throw new Error('This browser can\u2019t read the clipboard. Press \u2318V in the box.'); return (await navigator.clipboard.readText()).trim(); }
$('ls-paste').addEventListener('click',async()=>{
  let t=''; try{ t=await clipText(); }catch(err){ toast(err.name==='NotAllowedError'?'Clipboard access blocked. Press \u2318V in the box instead.':err.message); $('ls-url').focus(); return; }
  if(!t){ toast('Nothing on the clipboard'); return; }
  if(!looksLikeUrl(t)&&!/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)){ toast('That isn\u2019t a link'); return; }
  $('ls-url').value=t; $('ls-name').value=''; fetchMeta(t); $('ls-name').focus();
});
$('ls-del').addEventListener('click',()=>{ const id=$('ls-id').value; closeOverlays(); removeLink(id); });
async function removeLink(id){
  const l=links.links.find(x=>x.id===id); if(!l)return;
  links.links=links.links.filter(x=>x.id!==id); sideSig=''; renderSide(); VIEWS[view]?.update?.(true);
  try{ await send('/api/links/'+id,undefined,'DELETE'); }catch(err){ toast(err.message); return loadLinks(); }
  toast(`Removed ${l.title}`,{undo:async()=>{ const {id:_,opens,lastOpened,created,updated,health,...keep}=l; await send('/api/links',keep).catch(()=>{}); loadLinks(); }});
}
async function patchLink(id,patch,msg){
  const l=links.links.find(x=>x.id===id); if(l)Object.assign(l,patch); sideSig=''; renderSide(); VIEWS[view]?.update?.(true);
  try{ await send('/api/links/'+id,patch,'PATCH'); if(msg)toast(msg); }catch(err){ toast(err.message); } loadLinks();
}
function linkMenu(x,y,id){
  const l=links.links.find(v=>v.id===id); if(!l)return;
  menu(x,y,[
    {label:'Open',icon:'out',act:()=>openLink(l)},
    {label:'Copy link',icon:'copy',act:async()=>{ try{ await navigator.clipboard.writeText(l.url); toast('Copied'); }catch{ toast('Copy failed'); } }},
    'hr',
    l.pinned?{label:'Move off the top shelf',icon:'unpin',act:()=>patchLink(id,{pinned:false},'Moved to the shelf')}
            :{label:'Put on the top shelf',icon:'pin',act:()=>patchLink(id,{pinned:true,pinOrder:Math.max(-1,...topShelf().map(v=>v.pinOrder||0))+1},'On the top shelf')},
    {label:'Edit',icon:'edit',act:()=>openLinkSheet(l)},
    ...(spacesOn()&&spaceList().length?['hr',...spaceList().map(sp=>({label:(spaceOf(l)===sp.id?'✓ ':'')+'In '+sp.name,icon:'dot',act:()=>setLinkSpace(l.id,sp.id)}))]:[]),
    l.preview!==false?{label:'Refresh preview',icon:'refresh',act:()=>{ fetch(api('/api/preview?link='+id+'&refresh=1')).then(()=>{ shelfSig=''; homeShelfSig=''; VIEWS[view]?.update?.(true); }); toast('Taking a fresh screenshot'); }}:null,
    'hr',
    {label:'Remove',icon:'trash',danger:true,act:()=>removeLink(id)},
  ]);
}

// Paste or drop a URL anywhere to add it. Typing fields keep normal paste.
document.addEventListener('paste',e=>{ if(typing(e))return; if(view==='stash'){ stPaste(e); return; } const t=(e.clipboardData?.getData('text')||'').trim(); if(looksLikeUrl(t)){ e.preventDefault(); openLinkSheet({url:t}); } });
let dragDepth=0;
const hasUrl=(e)=>[...(e.dataTransfer?.types||[])].some(t=>t==='text/uri-list'||t==='text/plain');
const hasFiles=(e)=>[...(e.dataTransfer?.types||[])].includes('Files');
// On the Stash tab anything can be dropped (files too); everywhere else a URL goes to the shelf.
document.addEventListener('dragenter',e=>{ const st=view==='stash'; if(st?!(hasUrl(e)||hasFiles(e)):(!hasUrl(e)||hasFiles(e)))return; dragDepth++; $('drophint').textContent=st?'Drop to stash it':'Drop to add it to the shelf'; $('drophint').classList.add('on'); });
document.addEventListener('dragleave',()=>{ dragDepth=Math.max(0,dragDepth-1); if(!dragDepth)$('drophint').classList.remove('on'); });
document.addEventListener('dragover',e=>{ if(hasUrl(e)||(view==='stash'&&hasFiles(e)))e.preventDefault(); });
document.addEventListener('drop',e=>{ dragDepth=0; $('drophint').classList.remove('on'); if(e.target.closest('textarea,.composer,.sheet'))return; if(view==='stash'){ e.preventDefault(); stDrop(e.dataTransfer); return; } const t=(e.dataTransfer?.getData('text/uri-list')||e.dataTransfer?.getData('text/plain')||'').split('\n')[0].trim(); if(looksLikeUrl(t)){ e.preventDefault(); openLinkSheet({url:t}); } });

/* ---------- dogfood composer (the brief's loop, reusable) ---------- */
// The model list comes from the server (GET /api/engines) so the brief, this page and
// the runner always agree. This is only the fallback for when that request fails.
let MODELS=[
  {id:'gpt-6-astra',name:'GPT-6 Astra',maker:'OpenAI'},{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',maker:'OpenAI'},{id:'gpt-6-luna',name:'GPT-6 Luna',maker:'OpenAI'},
  {id:'claude-fable-5-1',name:'Fable 5.1',maker:'Anthropic'},{id:'claude-opus-5-5',name:'Opus 5.5',maker:'Anthropic'},{id:'claude-sonnet-5-5',name:'Sonnet 5.5',maker:'Anthropic'},
];
let EFFORTS=[['low','Low'],['medium','Med'],['high','High'],['xhigh','X-high'],['max','Max']];
let DEFAULT_PICK={model:'gpt-6-luna',effort:'high'}, DISCOVERED=[];
const PICK_KEY='meridian.model.dogfood';
const RENAMED={'gpt-6-sol':'gpt-6.1-sol'};
async function loadEngines(){
  try{ const r=await fetch(api('/api/engines')); if(!r.ok)return; const j=await r.json();
    if(Array.isArray(j.models)&&j.models.length)MODELS=j.models.slice().sort((a,b)=>(a.maker||'').localeCompare(b.maker||'')*-1||(a.rank??99)-(b.rank??99));
    if(Array.isArray(j.efforts)&&j.efforts.length)EFFORTS=j.efforts.map(([v,l])=>[v,l==='Medium'?'Med':l]);
    if(j.default?.model)DEFAULT_PICK=j.default; DISCOVERED=Array.isArray(j.discovered)?j.discovered.filter(d=>!d.older):[];
    document.querySelectorAll('.picker').forEach(drawPicker);
  }catch{}
}
function getPick(){ try{ const p=JSON.parse(localStorage.getItem(PICK_KEY)||'null'); if(p){ if(RENAMED[p.model])p.model=RENAMED[p.model]; if(MODELS.some(m=>m.id===p.model)&&EFFORTS.some(([e])=>e===p.effort))return p; } }catch{} return {...DEFAULT_PICK}; }
function setPick(p){ try{ localStorage.setItem(PICK_KEY,JSON.stringify(p)); }catch{} document.querySelectorAll('.picker').forEach(syncPicker); }
const modelName=(id)=>MODELS.find(m=>m.id===id)?.name||id;
const discoveredName=(d)=>d.name||String(d.id).replace(/^claude-/,'').replace(/^gpt-/,'GPT-').replace(/-(\d)-(\d)$/,' $1.$2').replace(/-/g,' ').replace(/\b([a-z])/g,c=>c.toUpperCase());
// Starred models sit at the top of the list; the stars sync with the rest of your prefs.
const starred=()=>(Array.isArray(prefs.pickStars)?prefs.pickStars:[]).filter(id=>MODELS.some(m=>m.id===id));
const effortLabel=(v)=>(EFFORTS.find(([e])=>e===v)||['',v])[1];
function drawPicker(host){
  const stars=starred();
  const opt=(m)=>{ const on=stars.includes(m.id); return `<div class="opt" role="group" data-pickrow="${esc(m.id)}"><span class="nm" role="radio" tabindex="0" data-model="${esc(m.id)}">${esc(m.name)}</span><button type="button" class="star" data-star="${esc(m.id)}" aria-pressed="${on}" aria-label="${on?'Unstar':'Star'} ${esc(m.name)}" data-tip="${on?'Unstar':'Star it|keeps it at the top'}">${icon('star')}</button>${icon('check')}</div>`; };
  const groups=[...(stars.length?[['Starred',stars.map(id=>MODELS.find(m=>m.id===id))]]:[]),...[...new Set(MODELS.map(m=>m.maker))].map(g=>[g,MODELS.filter(m=>m.maker===g&&!stars.includes(m.id))])].filter(([,ms])=>ms.length);
  host.innerHTML=`<button type="button" class="btn sm ghost" data-trig aria-haspopup="dialog" aria-expanded="${host.classList.contains('open')}"><span data-n></span><span class="dim" data-e></span>${icon('chev')}</button>
    <div class="pop" role="dialog" aria-label="Choose a model">
      <div role="radiogroup" aria-label="Model">${groups.map(([g,ms])=>`<div class="grp">${esc(g)}</div>${ms.map(opt).join('')}`).join('')}</div>
      ${DISCOVERED.length?`<div class="grp">Spotted in your sessions</div>${DISCOVERED.slice(0,4).map(d=>`<div class="opt newm"><span>${esc(discoveredName(d))}<small>${esc(d.id)}</small></span><button type="button" class="btn sm" data-adopt="${esc(d.id)}">Add</button></div>`).join('')}`:''}
      <div class="effort" style="--n:${EFFORTS.length}"><p>Reasoning</p>
        <div class="meter" role="slider" tabindex="0" aria-label="Reasoning" aria-valuemin="0" aria-valuemax="${EFFORTS.length-1}">${EFFORTS.map(([v,l],i)=>`<span data-effort="${esc(v)}" aria-hidden="true" style="--i:${i}"><i></i></span>`).join('')}</div>
        <div class="ticks">${EFFORTS.map(([v,l])=>`<span data-tick="${esc(v)}">${esc(l)}</span>`).join('')}</div></div>
    </div>`;
  syncPicker(host);
}
function mountPicker(host){
  drawPicker(host);
  const pickModel=(id)=>setPick({...getPick(),model:id});
  const pickLevel=(i)=>{ const e=EFFORTS[Math.max(0,Math.min(EFFORTS.length-1,i))]; if(e&&e[0]!==getPick().effort)setPick({...getPick(),effort:e[0]}); };
  // The reasoning bars work like a slider: click one, drag across them, or use the arrow keys.
  const levelAt=(m,x)=>{ const r=m.getBoundingClientRect(); return Math.floor((x-r.left)/r.width*EFFORTS.length); };
  host.addEventListener('pointerdown',e=>{ const m=e.target.closest('.meter'); if(!m)return; e.preventDefault(); m.focus(); m.setPointerCapture(e.pointerId); pickLevel(levelAt(m,e.clientX));
    const move=(ev)=>pickLevel(levelAt(m,ev.clientX)); const up=()=>{ m.removeEventListener('pointermove',move); m.removeEventListener('pointerup',up); m.removeEventListener('pointercancel',up); };
    m.addEventListener('pointermove',move); m.addEventListener('pointerup',up); m.addEventListener('pointercancel',up); });
  host.addEventListener('keydown',e=>{
    if(e.target.matches('.meter')){ const d={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[e.key]; const i=EFFORTS.findIndex(([v])=>v===getPick().effort);
      if(d){ e.preventDefault(); pickLevel(i+d); } else if(e.key==='Home'||e.key==='End'){ e.preventDefault(); pickLevel(e.key==='Home'?0:EFFORTS.length-1); } return; }
    if(e.target.matches('.nm[data-model]')&&['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key)){ e.preventDefault(); const options=[...host.querySelectorAll('.nm[data-model]')],i=options.indexOf(e.target),d=['ArrowDown','ArrowRight'].includes(e.key)?1:-1; const next=options[(i+d+options.length)%options.length]; if(next){ pickModel(next.dataset.model); next.focus(); } return; }
    if((e.key==='Enter'||e.key===' ')&&e.target.matches('.nm[data-model]')){ e.preventDefault(); pickModel(e.target.dataset.model); } });
  host.addEventListener('click',async e=>{ e.stopPropagation();
    if(e.target.closest('[data-trig]')){ const open=!host.classList.contains('open'); document.querySelectorAll('.picker.open').forEach(p=>{ p.classList.remove('open'); p.querySelector('[data-trig]').setAttribute('aria-expanded','false'); }); host.classList.toggle('open',open); host.querySelector('[data-trig]').setAttribute('aria-expanded',String(open));
      if(open){ const r=host.getBoundingClientRect(); host.classList.toggle('down',r.top<360); } return; }
    const ad=e.target.closest('[data-adopt]'); if(ad){ const d=DISCOVERED.find(x=>x.id===ad.dataset.adopt); ad.disabled=true; try{ await send('/api/engines/adopt',{id:d.id,name:discoveredName(d),maker:d.maker||(/^claude/.test(d.id)?'Anthropic':'OpenAI')}); toast(`${discoveredName(d)} added`); await loadEngines(); }catch(err){ toast(err.message); ad.disabled=false; } return; }
    const st=e.target.closest('[data-star]'); if(st){ const id=st.dataset.star, list=starred(); prefs.pickStars=list.includes(id)?list.filter(x=>x!==id):[...list,id]; savePrefs();
      document.querySelectorAll('.picker').forEach(drawPicker); host.classList.add('open'); host.querySelector('[data-trig]').setAttribute('aria-expanded','true'); host.querySelector(`[data-star="${CSS.escape(id)}"]`)?.focus({preventScroll:true}); return; }
    const m=e.target.closest('[data-model],[data-pickrow]'); if(m){ pickModel(m.dataset.model||m.dataset.pickrow); return; }
  });
}
function syncPicker(host){ const p=getPick(); const n=host.querySelector('[data-n]'); if(!n)return; n.textContent=modelName(p.model); host.querySelector('[data-e]').textContent=effortLabel(p.effort);
  host.querySelectorAll('[data-model]').forEach(b=>{ const selected=b.dataset.model===p.model; b.setAttribute('aria-checked',String(selected)); b.tabIndex=selected?0:-1; b.closest('.opt').dataset.checked=String(selected); });
  const lvl=EFFORTS.findIndex(([v])=>v===p.effort); const m=host.querySelector('.meter');
  if(m){ m.setAttribute('aria-valuenow',String(lvl)); m.setAttribute('aria-valuetext',effortLabel(p.effort)); m.querySelectorAll('[data-effort]').forEach((b,i)=>b.classList.toggle('on',i<=lvl)); }
  host.querySelectorAll('[data-tick]').forEach(t=>t.classList.toggle('on',t.dataset.tick===p.effort)); }
document.addEventListener('click',()=>document.querySelectorAll('.picker.open').forEach(p=>{ p.classList.remove('open'); p.querySelector('[data-trig]').setAttribute('aria-expanded','false'); }));

const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/heic','image/heif']);
// ctx: a function returning the tab name to mention, or null for none.
function mountComposer(host,{compact=false,ctx=null,placeholder}={}){
  const files=[]; let ctxOn=!!ctx;
  host.innerHTML=`<textarea maxlength="8000" aria-label="Log a fix" placeholder="${esc(placeholder||'Something bugging you? Say what should change. Paste a screenshot if it helps.')}" style="${compact?'min-height:76px':''}"></textarea>
    <div class="thumbs"></div>
    <div class="bar">
      <button type="button" class="btn sm ghost" data-attach title="Attach images">${icon('image')}<span>Image</span></button><input type="file" accept="image/*" multiple hidden>
      ${ctx?`<button type="button" class="ctxchip" data-ctx aria-pressed="true" title="Tell the agent where you were">${icon('pin')}<span></span></button>`:''}
      <span class="grow"></span><div class="picker"></div><button type="button" class="btn primary" data-send>${compact?'Send':'Send to agent'}</button>
    </div>
    <p class="status-line" role="status" aria-live="polite"></p>`;
  const ta=host.querySelector('textarea'), thumbs=host.querySelector('.thumbs'), status=host.querySelector('.status-line'), input=host.querySelector('input[type=file]');
  mountPicker(host.querySelector('.picker'));
  const say=(t,st='')=>{ status.textContent=t; status.dataset.state=st; };
  const syncCtx=()=>{ const c=host.querySelector('[data-ctx]'); if(!c)return; c.setAttribute('aria-pressed',String(ctxOn)); c.querySelector('span').textContent=ctxOn?(compact?ctx():`About the ${ctx()} tab`):'No context'; };
  syncCtx(); host._syncCtx=syncCtx;
  const draw=()=>{ thumbs.innerHTML=files.map((f,i)=>`<div class="thumb"><img alt="" src="${f.url}"><button type="button" data-rm="${i}" aria-label="Remove image">${icon('close')}</button></div>`).join(''); };
  const add=(list)=>{ for(const f of list){ if(!IMAGE_TYPES.has(String(f.type).toLowerCase())){ say('That file type is not an image I can send.','error'); continue; } if(f.size>5*1024*1024){ say('Images need to be under 5 MB.','error'); continue; } if(files.length>=4){ say('Up to 4 images.','error'); break; } files.push({file:f,url:URL.createObjectURL(f)}); } draw(); };
  host.addEventListener('click',e=>{
    if(e.target.closest('[data-attach]'))input.click();
    const rm=e.target.closest('[data-rm]'); if(rm){ const [f]=files.splice(Number(rm.dataset.rm),1); URL.revokeObjectURL(f.url); draw(); }
    if(e.target.closest('[data-ctx]')){ ctxOn=!ctxOn; syncCtx(); }
    if(e.target.closest('[data-send]'))submit();
  });
  input.addEventListener('change',()=>{ add([...input.files]); input.value=''; });
  ta.addEventListener('paste',e=>{ const list=[...(e.clipboardData?.items||[])].map(i=>i.kind==='file'?i.getAsFile():null).filter(Boolean); if(list.length){ e.preventDefault(); add(list); } });
  ta.addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); submit(); } });
  host.addEventListener('dragover',e=>{ if([...(e.dataTransfer?.types||[])].includes('Files'))e.preventDefault(); });
  host.addEventListener('drop',e=>{ const list=[...(e.dataTransfer?.files||[])]; if(list.length){ e.preventDefault(); e.stopPropagation(); add(list); } });
  const read=(f)=>new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res({name:f.name||'pasted-image.png',type:f.type,data:r.result}); r.onerror=()=>rej(new Error('Could not read an image')); r.readAsDataURL(f); });
  async function submit(){
    let text=ta.value.trim();
    if(!text&&!files.length){ say('Add a note or an image first.','error'); ta.focus(); return; }
    if(ctx&&ctxOn)text+=`\n\n(Logged from the Meridian command centre, ${ctx()} tab: public/command.html and public/command.js, served at /dashboard.)`;
    const btn=host.querySelector('[data-send]'); btn.disabled=true; say('Sending…');
    try{
      const attachments=await Promise.all(files.map(f=>read(f.file)));
      const j=await send('/api/feedback',{text,...getPick(),attachments});
      ta.value=''; files.splice(0).forEach(f=>URL.revokeObjectURL(f.url)); draw();
      say(`Sent. ${j.model} is on it.`,'sent'); setTimeout(()=>{ if(status.dataset.state==='sent')say(''); },6000);
      host.dispatchEvent(new CustomEvent('sent',{bubbles:true}));
      loadState();
    }catch(err){ say(err.message||'Not sent. Try again.','error'); }
    finally{ btn.disabled=false; }
  }
  host._fill=(t)=>{ ta.value=t; ta.focus(); ta.setSelectionRange(t.length,t.length); };
  host._focus=()=>ta.focus();
  return host;
}
const feedbackRuns=()=>((state?.delegations?.runs)||[]).filter(r=>r.kind==='feedback').sort((a,b)=>(b.started||0)-(a.started||0));
const RUN_STATES={running:['Working','working'],queued:['Sent','working'],stalled:['Needs a look','problem'],failed:['Failed','problem'],cancelled:['Cancelled',''],done:['Done','done']};
function runHTML(r){
  let [label,klass]=RUN_STATES[r.status]||RUN_STATES.queued; const done=r.status==='done'; if(r.undoneAt){ label='Undone'; klass=''; }
  const took=r.finished&&r.started?Math.max(1,Math.round((r.finished-r.started)/60000)):0;
  const live=['running','queued'].includes(r.status)?` · ${Math.max(1,Math.round((Date.now()-r.started)/60000))} min so far`:'';
  return `<div class="run" data-run="${esc(r.id)}"><div class="head"><div class="main"><div class="title">${esc(r.title)}</div><div class="meta">${esc(r.model||'')} · ${esc(dayWord(r.started))} ${hm(r.started)}${done&&took?` · took ${took} min`:''}${live}</div></div><span class="badge ${klass}"><i class="dot"></i>${label}</span></div>
    ${r.changes&&r.changes.files&&r.changes.files.length?`<div class="chg">${r.undoneAt?'Undone '+esc(dayWord(r.undoneAt))+' '+hm(r.undoneAt)+' · ':''}Changed ${r.changes.files.length} file${r.changes.files.length>1?'s':''}: ${r.changes.files.slice(0,3).map(f=>`<code>${esc(String(f.path).split('/').pop())}</code> <span class="add">+${f.added||0}</span> <span class="del">−${f.removed||0}</span>`).join(', ')}${r.changes.files.length>3?` and ${r.changes.files.length-3} more`:''} · <a href="${api('/delegations/'+encodeURIComponent(r.id)+'/changes.diff')}" target="_blank" rel="noopener">See the diff</a></div>`:''}
    <div class="acts">${done?`<button type="button" class="btn sm" data-ract="report">${icon('report')}Read summary</button>${r.undoable&&!r.undoneAt?`<button type="button" class="btn sm ghost" data-ract="undo">${icon('undo')}Undo</button>`:''}${(r.files||[]).find(f=>/\.html?$/i.test(f))?`<button type="button" class="btn sm ghost" data-ract="preview">${icon('out')}Preview beside</button>`:''}<button type="button" class="btn sm ghost" data-ract="follow">${icon('reply')}Follow up</button><button type="button" class="btn sm ghost" data-ract="archive">${icon('archive')}Archive</button>`:''}${['running','stalled','queued'].includes(r.status)?`<button type="button" class="btn sm ghost" data-ract="cancel">Cancel</button>`:''}${['failed','stalled','cancelled'].includes(r.status)?`<button type="button" class="btn sm ghost" data-ract="retry">${icon('refresh')}Try again</button>`:''}</div>
    <div class="report" hidden></div></div>`;
}
// One handler for every runs list, wherever it is mounted.
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-ract]'); if(!b)return; const row=b.closest('[data-run]'); const id=row.dataset.run; const r=feedbackRuns().find(x=>x.id===id);
  const act=b.dataset.ract;
  if(act==='report'){ const box=row.querySelector('.report'); if(!box.hidden){ box.hidden=true; return; } box.hidden=false; box.textContent='Loading…'; if(DEMO){ box.textContent='This is demo data, so there is no real summary to read.'; return; }
    try{ const t=await (await fetch(api('/delegations/'+encodeURIComponent(id)+'/REPORT.md'),{cache:'no-store'})).text(); box.innerHTML=mdLite(t); }catch{ box.textContent='Could not load the summary.'; } return; }
  if(act==='preview'){ const f=(r?.files||[]).find(x=>/\.html?$/i.test(x)); if(f)openUrl(new URL(api('/delegations/'+encodeURIComponent(id)+'/'+encodeURIComponent(f)),location.href).href,null,'split'); return; }
  if(act==='follow'||act==='retry'){ const text=act==='follow'?`Follow-up on "${r?.title||''}": `:(r?.title||''); openFix(text); return; }
  if(act==='undo'){ const n=r?.changes?.files?.length||0; if(!confirm(`Undo "${r?.title||'this fix'}"? This puts back ${n} file${n===1?'':'s'} as they were before the agent ran.`))return; b.disabled=true;
    try{ const j=await send('/api/delegations/'+encodeURIComponent(id)+'/undo',{}); toast((j.conflicts&&j.conflicts.length?`Undone, except ${j.conflicts.length} file${j.conflicts.length>1?'s':''} changed since`:'Undone. Everything is back as it was.')+(j.needsRestart?' Meridian needs a restart to pick it up.':'')); loadState(); }catch(err){ toast(err.message); b.disabled=false; } return; }
  if(act==='cancel'||act==='archive'){ b.disabled=true; try{ await send('/api/delegations/'+encodeURIComponent(id)+'/'+act,{}); toast(act==='archive'?'Archived':'Cancelled'); loadState(); }catch(err){ toast(err.message); b.disabled=false; } }
});
function mdLite(md){
  const inline=(s)=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/(^|\s)(https?:\/\/[^\s<]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return String(md||'').split(/\n{2,}/).map(b=>{ b=b.trim(); if(!b)return '';
    if(/^#{1,4}\s/.test(b)){ const [h,...rest]=b.split('\n'); return `<h3>${inline(h.replace(/^#+\s*/,''))}</h3>`+(rest.length?mdLite(rest.join('\n')):''); }
    if(/^[-*]\s/m.test(b)&&b.split('\n').every(l=>/^\s*([-*]|\d+\.)\s/.test(l)||/^\s{2,}/.test(l)))return '<ul>'+b.split('\n').filter(l=>/^\s*([-*]|\d+\.)\s/.test(l)).map(l=>`<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/,''))}</li>`).join('')+'</ul>';
    return `<p>${inline(b).replace(/\n/g,'<br>')}</p>`; }).join('');
}
let fixHost=null, fixFrom='Home';
function openFix(prefill){
  fixFrom=TAB_DEFS.find(t=>t.id===view)?.label||'Home';
  if(!fixHost)fixHost=mountComposer(document.querySelector('[data-composer="sheet"]'),{ctx:()=>fixFrom});
  fixHost._syncCtx?.();
  openSheet('sheet-fix'); if(prefill)setTimeout(()=>fixHost._fill(prefill),80);
}
document.addEventListener('sent',e=>{ if(e.target.closest('#sheet-fix'))setTimeout(closeOverlays,900); });

/* ---------- views ---------- */
const VIEWS={};

/* HOME. What's next, what to do, and the things he opens most. */
const GREETINGS={morning:["Here's where things stand.","Nothing is on fire.","Coffee first, then this.","The day is still yours."],afternoon:["Here's what's moving.","Still plenty of day left.","The middle stretch.","Here's the state of play."],evening:["Here's how it landed.","That's the day.","Winding down.","Enough for one day."],night:["Still up, then.","The quiet hours.","This can wait until morning."]};
function greetWord(){ const h=new Date().getHours(); return h<5?'Late one':h<12?'Morning':h<18?'Afternoon':'Evening'; }
const STANDING_NOISE=/uncommitted files|dirty files|worktree|no implementation outcome|no recorded|no outcome|the board (holds|has) \d+|is current as of|launchd|unrouted|sessions? ran/i;
const PROPER=/^(slack|outlook|github|vercel|workos|posthog|next\.js|nextjs|claude|codex|meta|figma|powerpoint|tailscale|obsidian|apple|google|monzo|jordan|owner)$/i;
function standingSentences(md,limit=3){
  const names=[...String(md||'').matchAll(/^##\s+(.+)$/gm)].map(m=>m[1].trim()); const out=[];
  for(const block of String(md||'').split(/^##\s+/m).slice(1)){
    const nl=block.indexOf('\n'); const name=block.slice(0,nl<0?block.length:nl).trim();
    if(/^(fleet|attention|atlas board)$/i.test(name))continue;
    const body=block.slice(nl+1).replace(/\s+/g,' ').trim();
    let text=(body.split(/(?<=[.!?])\s+/).find(x=>x.length>12&&!STANDING_NOISE.test(x))||'').trim(); if(!text)continue;
    const first=(text.match(/^[\w.]+/)||[''])[0]; const keep=PROPER.test(first)||names.some(n=>n.toLowerCase()===first.toLowerCase());
    if(new RegExp('^'+name.split(' ')[0].replace(/[^\w]/g,'')+'\\b','i').test(text))out.push(text.replace(/\.$/,'')+'.');
    else{ if(!keep)text=text.charAt(0).toLowerCase()+text.slice(1); out.push(`${name} ${text.replace(/\.$/,'')}.`); }
    if(out.length>=limit)break;
  }
  return out;
}
function downList(){ const f=state?.fleet||{}; return [...(f.services||[]),...(f.sites||[])].filter(x=>!x.up&&!x.paused).map(x=>x.name); }
function andList(a){ return a.length<2?a.join(''):a.slice(0,-1).join(', ')+' and '+a[a.length-1]; }
function briefTodos(){
  if(!state)return [];
  const fb=state.briefFeedback||{completed:[],rejected:[],skipped:{}}; const today=isoDay();
  const hidden=new Set([...(fb.completed||[]),...(fb.rejected||[]),...((fb.skipped&&fb.skipped[today])||[])]);
  const intake=new Map(((state.briefIntake||{}).items||[]).filter(i=>i.projectId).map(i=>[i.projectId,i]));
  const rank=(p)=>p==='high'?2:p==='normal'?1:0;
  return ((state.projects&&state.projects.projects)||[]).filter(c=>c.brief&&c.status!=='done'&&!hidden.has('project:'+c.id)).map(p=>{ const i=intake.get(p.id);
    return {id:p.id,title:p.title,source:p.source||i?.source||'meridian',from:p.sourceFrom||i?.from||'',url:p.sourceUrl||i?.url||'',when:p.sourceReceivedAt||i?.receivedAt||p.updated,priority:p.priority,body:i?.summary||p.note||'',avatar:[p.sourceAvatarUrl,i?.avatarUrl].find(u=>/^https:\/\//.test(u||''))||'',fromEmail:i?.fromEmail||''};
  }).sort((a,b)=>rank(b.priority)-rank(a.priority)||String(b.when||'').localeCompare(String(a.when||'')));
}
const SRC_LABEL={outlook:'Outlook',slack:'Slack',meridian:'Meridian',teams:'Teams','work review':'Work review',chatgpt:'ChatGPT',email:'Email',other:'Elsewhere'};
let homeShelfSig='', homeComposer=null;
const HOME_SECS=[['shelf','Top shelf','shelf'],['dog','Dogfood','dogfood'],['usage','AI usage','usage'],['live','Live now','bolt'],['alm','Almanac','sparkle']];
const homeOrder=()=>{ const ids=HOME_SECS.map(x=>x[0]); const o=(prefs.homeOrder||[]).filter(id=>ids.includes(id)); return [...o,...ids.filter(id=>!o.includes(id))]; };
VIEWS.home={
  // One layout (Classic: cards line up by row). The Up next style decides whether deadlines get their own card.
  mount(el){
    const dlOwn=(lookOpt('hnext')||'stack')!=='stack';
    const S={
      next:`<section class="card" id="h-next-card"><div class="ch">${icon('next')}<h2>Up next</h2><span class="sub" id="h-next-sub"></span><span class="end"><button class="ibtn" id="h-push" aria-label="Phone reminders"></button>${dlOwn?'':`<button class="ibtn" id="h-dl-add" data-tip="Add a deadline" aria-label="Add a deadline">${icon('plus')}</button>`}</span></div><div id="h-next"></div></section>`,
      todo:`<section class="card" id="h-todo-card"><div class="ch">${icon('todo')}<h2>To do</h2><span class="sub" id="h-todo-sub"></span></div>
        <form id="h-todo-form" style="margin:0 0 10px"><input id="h-todo-in" placeholder="Add a to-do and press Enter" maxlength="300"></form><div id="h-todo"></div></section>`,
      dl:dlOwn?`<section class="card" id="h-dl-card"><div class="ch">${icon('flag')}<h2>Deadlines</h2><span class="sub" id="h-dl-sub"></span><span class="end"><button class="ibtn" id="h-dl-add" data-tip="Add a deadline" aria-label="Add a deadline">${icon('plus')}</button></span></div><div id="h-dl"></div></section>`:'',
      shelf:`<section id="h-shelf-sec"><div class="sec-h" style="margin-top:14px"><h3>Top shelf</h3><span class="sub">Your most-used links</span><span class="end"><button class="ibtn" id="h-add" data-tip="Add a link|or paste one anywhere" aria-label="Add a link">${icon('plus')}</button><button class="ibtn" data-go="shelf" data-tip="Open the shelf" aria-label="Open the shelf">${icon('out')}</button></span></div><div class="shelf-top" id="h-shelf"></div></section>`,
      dog:`<section class="card"><div class="ch">${icon('dogfood')}<h2>Dogfood</h2><span class="sub">Log it and an agent makes the change</span><span class="end"><button class="btn sm ghost" data-go="dogfood">All fixes</button></span></div><div class="composer" id="h-composer"></div><div class="rows" id="h-runs" style="margin-top:10px"></div></section>`,
      usage:`<section class="card" id="h-usage"></section>`,
      live:`<section class="card" id="h-live-card"><div class="ch">${icon('bolt')}<h2>Live now</h2></div><div id="h-live"></div></section>`,
      alm:`<section><div class="sec-h"><h3>Almanac</h3><span class="sub" id="h-alm-sub">Something new every day</span></div><div class="alm" id="h-alm"></div></section>`,
    };
    // Sections hidden in Customise (the eye icons) aren't built at all; the cards left in the bottom row share it equally.
    const hid=new Set([...(prefs.homeHidden||[]),...Object.keys(HOME_NEEDS).filter(k=>!HOME_NEEDS[k].some(connOn))]); const cell=(cls,...ks)=>{ ks=ks.filter(k=>S[k]&&!hid.has(k)); return ks.length?`<div class="hcell ${cls}">${ks.map(k=>S[k]).join('')}</div>`:''; };
    // Below Up next and To do, sections follow your order from Customise. The shelf and the almanac take a whole row;
    // cards next to each other share one.
    const rows=[]; let run=[]; const flush=()=>{ if(run.length)rows.push(run.map(k=>cell('c'+(12/run.length),k)).join('')); run=[]; };
    for(const k of homeOrder()){ if(hid.has(k)||!S[k])continue; if(k==='shelf'||k==='alm'){ flush(); rows.push(cell('c12',k)); } else run.push(k); } flush();
    el.innerHTML=`<header class="hero" id="h-hero"><div class="bg" id="h-bg"></div><div class="meta" id="h-meta"></div><h1 id="h-greet"></h1><p class="line" id="h-line"></p><div class="credit" id="h-credit"></div></header>
    <div class="grid hgrid">${showWelcome()?`<div class="hcell c12"><section class="card" id="h-welcome"></section></div>`:''}${cell('c7','next')+cell('c5','todo','dl')+rows.join('')}</div>`;
    // Hidden sections leave no element behind, so the updaters below get a stand-in.
    for(const id of ['h-shelf','h-composer','h-runs','h-usage','h-live','h-alm','h-add'])if(!$(id)){ const d=document.createElement('div'); d.id=id; d.hidden=true; el.appendChild(d); }
    homeShelfSig=''; homeRunsSig=''; watchCredit();
    homeComposer=mountComposer($('h-composer'),{compact:true,ctx:()=>'Home'});
    $('h-add').addEventListener('click',()=>openLinkSheet({pinned:true}));
    $('h-dl-add').addEventListener('click',openDeadlineSheet);
    $('h-push').addEventListener('click',async()=>{ const on=!state?.notify?.enabled; try{ await send('/api/notify',{enabled:on},'PATCH'); state.notify.enabled=on; homePush(); toast(on?'Phone reminders on: meetings 10 minutes and 1 minute before, plus finished runs':'Phone reminders off'); }catch(err){ toast(err.message); } });
    $('h-todo-form').addEventListener('submit',async e=>{ e.preventDefault(); const t=$('h-todo-in').value.trim(); if(!t)return; $('h-todo-in').value=''; try{ await send('/api/todos',{title:t}); toast('Added'); loadState(); }catch(err){ toast(err.message); } });
    $('h-todo').addEventListener('click',todoClick);
    $('h-todo').addEventListener('mouseover',todoPoint); $('h-todo').addEventListener('focusin',todoPoint);
    $('h-todo').addEventListener('contextmenu',e=>{ const row=e.target.closest('.row.todo'); if(!row)return; e.preventDefault(); if(row.dataset.todo){ const t=(state.todos||[]).find(x=>x.id===row.dataset.todo); if(t)todoMenu(e.clientX,e.clientY,t); } else { const b=briefTodos().find(x=>x.id===row.dataset.brief); if(b)briefMenu(e.clientX,e.clientY,b); } });
    $('h-next').addEventListener('click',dlClick); $('h-dl')?.addEventListener('click',dlClick);
    bindShelfTiles($('h-shelf'));
    $('h-alm').addEventListener('click',e=>{ const t=e.target.closest('[data-alm]'); if(t)openAlmanac(t.dataset.alm); });
  },
  update(){
    if(!state)return;
    homeHero(); homeNext(); homeTodo(); homeShelf(); homeRuns(); homeUsage(); homeLive(); homeAlmanac(); renderWelcome();
  },
};
function homeHero(){
  const d=new Date(); const h=d.getHours(); const part=h<5?'night':h<12?'morning':h<18?'afternoon':h<23?'evening':'night';
  const pool=GREETINGS[part]; const seed=Number(isoDay(d).replace(/-/g,''))+h;
  setHTML($('h-greet'),`${greetTo(greetWord())}<span class="stop">.</span>`);
  const standing=standingSentences(state.ledger?.now||'');
  setText($('h-line'),standing.length?standing.join(' '):pool[seed%pool.length]);
  const sky=almanac?.items?.sky; const bits=[`${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`];
  if(sky&&!sky.error&&sky.now){ bits.push(`${esc(placeName())} ${Math.round(sky.now.temp)}° · ${String(sky.now.label||'').toLowerCase()}`); if(sky.today?.sunset)bits.push((Date.now()<Date.parse(isoDay()+'T'+sky.today.sunset)?'Sunset ':'Sun set at ')+sky.today.sunset); }
  const live=state.ai?.liveCount||0; if(live)bits.push(`${live} agent${live>1?'s':''} working`);
  const down=downList(); if(down.length)bits.push(`${down.length} down`);
  setHTML($('h-meta'),bits.map(b=>`<span>${esc(b)}</span>`).join(''));
  paintHero(); if(window.feelReady&&FEEL())feelSky();
}
// Fixed gradients for the header, made here, so there's nothing to license. Dusk is after the Lenny and Friends Summit thumbnail.
const SET_GRADIENTS={
  dusk:{name:'Dusk',style:'horizon',img:'/img/hero-dusk.jpg',c:['#1d0b33','#2c2d6d','#3d448a','#6a3a6e','#993861','#c03135','#f47322']},
};
// What the header shows right now. Mix picks one of the headers you chose, by the day or by the visit; Planet and
// Your photo name the planet or the photo. One of: earthview picture earth globe week colours dusk custom photo:<id> off.
const HERO_PLANETS={photo:'earth',globe:'globe',week:'week'};
let heroVisit=null;
function heroNow(){
  let k=lookOpt('hero')||'earthview';
  if(k==='mix'){ const list=(prefs.heroMix||[]).filter(heroOk); if(!list.length)return 'earthview';
    const n=lookOpt('mixevery')==='visit'?(heroVisit??=Math.floor(Math.random()*1e6)):Math.floor(Date.parse(isoDay()+'T12:00:00Z')/864e5);
    return list[n%list.length]; }
  if(k==='earth')return HERO_PLANETS[lookOpt('planet')]||'earth';
  if(k==='photo'){ const ph=heroPhotos(); const p=ph.find(x=>x.id===prefs.heroPhoto)||ph[0]; return p?'photo:'+p.id:'off'; }
  return k;
}
// A photo's crop, 0 (top) to 100 (bottom). 0 is a real answer, so no || here.
const cropY=(p)=>{ const y=Number(p?.y); return Number.isFinite(y)?Math.max(0,Math.min(100,y)):50; };
const heroPhotos=()=>(Array.isArray(prefs.heroPhotos)?prefs.heroPhotos:[]).filter(p=>/^[0-9a-f]{12}$/.test(p?.id||''));
const heroOk=(k)=>k.startsWith('photo:')?heroPhotos().some(p=>'photo:'+p.id===k):k==='custom'?!!prefs.gradient:['earthview','picture','earth','globe','week','colours','dusk'].includes(k);
// Paints the header: a photo (the day's finds or yours), a gradient, or a planet drawn live. Then it decides how the
// bottom meets the page (prefs.look.hedge) and whether it moves (prefs.look.hmove).
// Header motion pauses once the header scrolls away.
let heroIO=null;
function heroWatch(hero){ if(heroIO?.el===hero)return; heroIO?.disconnect(); heroIO=new IntersectionObserver(([e])=>hero.classList.toggle('offscreen',!e.isIntersecting)); heroIO.el=hero; heroIO.observe(hero); }
// A system preference change stops a planet already running, as well as the next one.
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{ if($('h-hero'))paintHero(); });
function paintHero(){
  const hero=$('h-hero'), bg=$('h-bg'); if(!hero||!bg)return;
  const key=heroNow(); const it=almanac?.items||{}; const set=SET_GRADIENTS[key]; const own=key==='custom'?ownGradient():null;
  const moving=lookOpt('hmove')==='move'&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  hero.style.setProperty('--hgrain',String(own?own.grain/100:0));
  hero.classList.toggle('setimg',!!set?.img); hero.style.removeProperty('--hpos');
  if(!(key==='globe'||key==='week'))stopPlanet();
  if(!bg.querySelector('.slide'))bg.insertAdjacentHTML('afterbegin','<i class="slide"></i>');   // moving sweeps and Dusk slide this copy
  heroWatch(hero);
  if(!(key==='colours'||key==='custom')||!moving)bg.querySelectorAll('.blob').forEach(x=>x.remove());
  let kind='img', cols=null, credit='', flow=false;
  const show=(src,css)=>{ hero.classList.remove('noimg'); if(bg.dataset.src===src){ bg.classList.add('in'); return; } bg.dataset.src=src; bg.classList.remove('in');
    const im=new Image(); im.onload=()=>{ if(bg.dataset.src!==src)return; bg.style.backgroundImage=css; bg.classList.add('in'); heroTone(hero,{img:im}); }; im.src=src; };
  if(key==='off'){ kind='none'; bg.style.backgroundImage=''; bg.dataset.src=''; hero.classList.add('noimg'); }
  else if(key==='globe'||key==='week'){
    kind='space'; const body=key==='globe'?'earth':WEEK_BODY[new Date().getDay()]; const B=BODIES[body];
    hero.classList.remove('noimg'); bg.style.backgroundImage=''; bg.dataset.src=key; bg.classList.add('in'); hero.dataset.tone='dark'; // space is black: light words, whatever the last header was
    if(!startPlanet(bg,body,moving)){ const p=it.earth; if(p&&!p.error){ bg.style.backgroundImage=`url("${api(imgUrl(p.image))}")`; } }
    credit=key==='globe'?`The Earth, turning<br><span class="dim2">Maps: Solar System Scope, CC BY 4.0</span>`:`${esc(DAYS[new Date().getDay()])} is ${esc(B.day)}<br><span class="dim2">${esc(B.name)} · maps: Solar System Scope, CC BY 4.0</span>`; }
  else if(key.startsWith('photo:')){ const p=heroPhotos().find(x=>'photo:'+x.id===key); const src=api(p.url||`/api/command/hero-photo/${p.id}`);
    hero.style.setProperty('--hpos',`center ${cropY(p)}%`); show(src,`url("${src}")`); }
  else if(set?.img){ kind='grad'; cols=set.c; show(set.img,`url("${set.img}")`); credit=`<span class="dim2">${esc(set.name)}</span>`; }
  else if(key==='colours'||own){ const c=own?own.stops:(it.colours?.colours||[]).map(c=>c.hex);
    if(c.length){ kind='grad'; cols=c; const style=own?own.style:lookOpt('herograd')||'linear', angle=own?own.angle:115;
      hero.classList.remove('noimg'); bg.dataset.src=key+c.join(); bg.classList.add('in');
      if(moving&&style==='mesh'){ bg.style.backgroundImage=`linear-gradient(${c[1%c.length]},${c[1%c.length]})`; meshBlobs(bg,c); } else{ bg.querySelectorAll('.blob').forEach(x=>x.remove()); bg.style.backgroundImage=colourGradient(c,style,angle); flow=moving; }
      heroTone(hero,{stops:c,style,angle});
      if(!own)credit=`${esc((it.colours.colours||[]).map(c=>c.name).join(', '))}<br><span class="dim2">Today's colours · Wada no. ${esc(it.colours.number||'')}</span>`; }
    else{ kind='none'; hero.classList.add('noimg'); bg.style.backgroundImage=''; bg.dataset.src=''; } }
  else{ const pick=key==='earthview'?it.earthView:key==='picture'?it.picture:key==='earth'?it.earth:null; const src=pick&&!pick.error?imgUrl(pick.image):null;
    if(key==='earth')kind='space';
    if(src){ show(api(src),`url("${api(src)}")`); credit=almanacCredit(key,pick); } else{ kind='none'; hero.classList.add('noimg'); bg.style.backgroundImage=''; bg.dataset.src=''; } }
  if(set?.img)heroTone(hero,{stops:cols});
  // Fade is the default (Owner's favourite, 4 Oct). The old Auto, which deepened gradients, now just means Fade.
  const want=lookOpt('hedge'); hero.dataset.edge=['edge','deepen'].includes(want)?want:'fade'; hero.dataset.kind=kind;
  hero.classList.toggle('moving',moving&&(kind==='img'||kind==='grad'));
  // Zooming a sweep or a horizon looks the same as standing still, so moving gradients slide their colours through instead.
  hero.classList.toggle('flow',flow);
  setHTML($('h-credit'),credit);
}
// Your gradient or today's colours, moving: the mesh's four pools of colour drift about on their own clocks.
function meshBlobs(bg,c){
  const spots=[[12,18,120,160,'14%','10%',23],[88,12,110,150,'-12%','14%',29],[75,95,120,160,'-16%','-12%',31],[25,100,100,140,'14%','-16%',37]];
  if(bg.dataset.blobs===c.join()&&bg.querySelector('.blob'))return;
  bg.querySelectorAll('.blob').forEach(x=>x.remove()); bg.dataset.blobs=c.join();
  bg.insertAdjacentHTML('afterbegin',spots.map(([x,y,w,h,dx,dy,t],i)=>`<i class="blob" style="--c:${c[i%c.length]};left:${x}%;top:${y}%;width:${w}%;height:${h}%;--dx:${dx};--dy:${dy};--t:${t}s;--d:-${i*7}s"></i>`).join(''));
}
// The header's own colour, for Deepen (a dark shade of it to sink into), and whether the words over it need to be
// dark (only on Edge, where nothing darkens the bottom). Gradients are worked out from their stops; pictures are sampled.
const hexRgb=(h)=>{ const n=parseInt(String(h).slice(1),16); return [n>>16&255,n>>8&255,n&255]; };
function rgbHsl([r,g,b]){ r/=255; g/=255; b/=255; const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2, d=mx-mn; if(!d)return [0,0,l];
  const s=d/(1-Math.abs(2*l-1)); const h=mx===r?((g-b)/d+6)%6:mx===g?(b-r)/d+2:(r-g)/d+4; return [h*60,s,l]; }
const lumOf=([r,g,b])=>{ const f=(v)=>{ v/=255; return v<=.03928?v/12.92:((v+.055)/1.055)**2.4; }; return .2126*f(r)+.7152*f(g)+.0722*f(b); };
function gradAt(stops,style,angle,x,y,w,h){
  const c=stops.map(hexRgb); if(c.length<2)return c[0]||[0,0,0];
  if(style==='mesh')return c.slice(0,4).reduce((a,v)=>a.map((s,i)=>s+v[i]/Math.min(4,c.length)),[0,0,0]);
  const a=(style==='horizon'?180:angle)*Math.PI/180, len=Math.abs(w*Math.sin(a))+Math.abs(h*Math.cos(a));
  const t=Math.max(0,Math.min(1,((x-w/2)*Math.sin(a)-(y-h/2)*Math.cos(a))/len+.5))/(style==='horizon'?.88:1);
  const f=Math.min(1,t)*(c.length-1), i=Math.min(c.length-2,Math.floor(f)), k=f-i; return c[i].map((v,j)=>v+(c[i+1][j]-v)*k);
}
function heroTone(hero,{stops,style='horizon',angle=180,img}){
  let px=[];
  if(img){ try{ const cv=document.createElement('canvas'); cv.width=48; cv.height=24; const g=cv.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0,48,24);
      const d=g.getImageData(0,0,48,24).data; for(let y=0;y<24;y++)for(let x=0;x<48;x++){ const i=(y*48+x)*4; px.push({x:x/48,y:y/24,c:[d[i],d[i+1],d[i+2]]}); } }catch{ return; } }
  else if(stops?.length){ for(let y=0;y<12;y++)for(let x=0;x<24;x++)px.push({x:x/24,y:y/12,c:gradAt(stops,style,angle,x/24*1000,y/12*300,1000,300)}); }
  if(!px.length)return;
  // Deepen sinks into the most colourful part of the lower half, darkened, so the hue survives.
  const low=px.filter(p=>p.y>.4).map(p=>({c:p.c,hsl:rgbHsl(p.c)})).sort((a,b)=>b.hsl[1]*(1-Math.abs(b.hsl[2]-.5))-a.hsl[1]*(1-Math.abs(a.hsl[2]-.5)));
  const [hh,ss]=low.length?low[Math.floor(low.length*.1)].hsl:[0,0];
  root.style.setProperty('--deep1',`hsl(${hh.toFixed(0)} ${Math.round(Math.min(.9,Math.max(.35,ss*1.15))*100)}% 52%)`);
  root.style.setProperty('--deep2',`hsl(${hh.toFixed(0)} ${Math.round(Math.min(.7,ss)*100)}% 9%)`);
  // Behind the greeting and the line: the left two thirds of the bottom half.
  const txt=px.filter(p=>p.x<.62&&p.y>.45&&p.y<.92); const lum=txt.reduce((s,p)=>s+lumOf(p.c),0)/(txt.length||1);
  hero.dataset.tone=lum>.42?'light':'dark';
}
// Planets for the header, drawn live: a sphere wrapped in a map, lit from the upper left, turning slowly when the header
// moves. The week's are the ones the days are named after (Tiw is Mars, Woden Mercury, Thor Jupiter, Frigg Venus).
// x, y and r place it in the header: centre as a share of the width and height, radius as a share of the height.
const BODIES={
  earth:{name:'The Earth',tex:'earth',clouds:'earth-clouds',tilt:-23.4,atm:[.38,.62,1],spin:180,at:[.74,.92,1.05]},
  sun:{name:'The Sun',day:"the Sun's day",tex:'sun',sun:true,spin:600,at:[.86,.95,.95]},
  moon:{name:'The Moon',day:"the Moon's day",tex:'moon',tilt:-6.7,spin:140,at:[.76,.78,.78]},
  mars:{name:'Mars',day:"Mars's day",tex:'mars',tilt:-25,atm:[.95,.55,.4],spin:110,at:[.75,.85,.9]},
  mercury:{name:'Mercury',day:"Mercury's day",tex:'mercury',tilt:-2,spin:150,at:[.76,.8,.8]},
  jupiter:{name:'Jupiter',day:"Jupiter's day",tex:'jupiter',tilt:-3,atm:[.95,.8,.6],spin:70,at:[.74,.98,1.15]},
  venus:{name:'Venus',day:"Venus's day",tex:'venus',tilt:-3,atm:[1,.86,.6],spin:240,at:[.75,.85,.9]},
  saturn:{name:'Saturn',day:"Saturn's day",tex:'saturn',ring:'saturn-ring',tilt:-20,spin:80,at:[.78,.56,.36]},
};
const WEEK_BODY=['sun','moon','mars','mercury','jupiter','venus','saturn'];
const planetImages=new Map();
// Share the WebP map with thumbnails.
function planetTexture(name,ready){
  let im=planetImages.get(name);
  if(!im){ im=new Image(); planetImages.set(name,im);
    im.onerror=null;
    im.src=`/img/planets/${name}.webp`; }
  if(ready){ if(im.complete&&im.naturalWidth)queueMicrotask(()=>ready(im)); else im.addEventListener('load',()=>ready(im),{once:true}); }
  return `var(--planet-${name},url('/img/planets/${name}.webp'))`;
}
const PLANET_FS=`precision highp float;
uniform vec2 uRes,uC; uniform float uR,uLon,uCloud,uHasCloud,uHasRing,uSun; uniform vec3 uAtm,uL; uniform mat3 uM;
uniform sampler2D uTex,uClouds,uRing;
const float PI=3.14159265;
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
vec2 uvOf(vec3 p,float off){ return vec2(fract((atan(p.x,p.z)+off)/(2.0*PI)+0.5),0.5-asin(clamp(p.y,-1.0,1.0))/PI); }
void main(){
  vec2 d=(gl_FragCoord.xy-uC)/uR; float r2=dot(d,d);
  float h=hash(floor(gl_FragCoord.xy/2.0)); vec3 col=vec3(step(0.9975,h)*(h-0.9975)*300.0*0.55);
  vec3 axis=uM*vec3(0.0,1.0,0.0);
  vec4 ring=vec4(0.0); float rt=-1e9;
  if(uHasRing>0.5){ rt=-(d.x*axis.x+d.y*axis.y)/axis.z; vec3 P=vec3(d,rt); float rr=length(P);
    if(rr>1.24&&rr<2.27){ ring=texture2D(uRing,vec2((rr-1.24)/1.03,0.5)); float b=dot(P,uL),c=dot(P,P)-1.0,q=b*b-c;
      float lit=(q>0.0&&-b+sqrt(q)>0.0)?0.12:1.0; ring.rgb*=lit*(0.55+0.45*abs(dot(axis,uL))); } }
  if(r2<1.0){
    float z=sqrt(1.0-r2); vec3 n=vec3(d,z); vec3 p=n*uM;
    vec3 tex=texture2D(uTex,uvOf(p,uLon)).rgb;
    if(uSun>0.5){ col=tex*1.55*(0.5+0.5*pow(z,0.45)); }
    else{ float dif=smoothstep(-0.12,0.45,dot(n,uL)); vec3 s=tex;
      if(uHasCloud>0.5){ float cl=texture2D(uClouds,uvOf(p,uLon+uCloud)).r; s=mix(s,vec3(1.0),cl*0.85); }
      col=s*(dif*1.12+0.025);
      float rim=pow(1.0-z,2.4); col+=uAtm*rim*(dif*0.9+0.08)*0.85; }
    if(ring.a>0.0&&rt>z)col=mix(col,ring.rgb,ring.a);
  } else {
    float r=sqrt(r2);
    if(uSun>0.5)col+=vec3(1.0,0.55,0.18)*(exp(-(r-1.0)*3.2)*0.75+exp(-(r-1.0)*16.0)*0.6);
    else if(dot(uAtm,uAtm)>0.0)col+=uAtm*exp(-(r-1.0)*34.0)*(0.25+0.75*max(dot(normalize(vec3(d,0.25)),uL),0.0))*0.7;
    if(ring.a>0.0)col=mix(col,ring.rgb,ring.a);
  }
  gl_FragColor=vec4(col,1.0);
}`;
let heroPlanet=null;
function stopPlanet(){ if(!heroPlanet)return; heroPlanet.stop(); heroPlanet=null; }
function startPlanet(bg,body,moving){
  if(heroPlanet&&heroPlanet.body===body&&heroPlanet.canvas.isConnected&&heroPlanet.canvas.parentElement===bg){ heroPlanet.moving(moving); return true; }
  stopPlanet(); const B=BODIES[body]; const cv=document.createElement('canvas'); cv.className='planet'; cv.setAttribute('aria-hidden','true');
  const gl=cv.getContext('webgl',{alpha:false,antialias:false,premultipliedAlpha:false}); if(!gl)return false;
  const sh=(type,src)=>{ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); return s; };
  const prog=gl.createProgram(); gl.attachShader(prog,sh(gl.VERTEX_SHADER,'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}')); gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,PLANET_FS)); gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS))return false;
  gl.useProgram(prog); const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const aLoc=gl.getAttribLocation(prog,'a'); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc,2,gl.FLOAT,false,0,0);
  const U=(n)=>gl.getUniformLocation(prog,n);
  // A blank texture until the map arrives, so the first frames are a dark ball rather than nothing.
  const tex=(unit,name)=>{ const t=gl.createTexture(); gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([20,20,24,name?255:0]));
    for(const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,unit===2?gl.CLAMP_TO_EDGE:gl.REPEAT],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,k,v); // ring maps have a non-power-of-two height: WebGL 1 draws a repeating non-power-of-two texture black
    if(name)planetTexture(name,im=>{ if(dead)return; gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,t); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,im); draw(); });
    return t; };
  let dead=false, live=moving, frame=0, last=0, onScreen=true; const t0=performance.now();
  tex(0,B.tex); tex(1,B.clouds); tex(2,B.ring);
  gl.uniform1i(U('uTex'),0); gl.uniform1i(U('uClouds'),1); gl.uniform1i(U('uRing'),2);
  gl.uniform1f(U('uHasCloud'),B.clouds?1:0); gl.uniform1f(U('uHasRing'),B.ring?1:0); gl.uniform1f(U('uSun'),B.sun?1:0);
  gl.uniform3fv(U('uAtm'),B.atm||[0,0,0]); const L=[-.62,.38,.68], ll=Math.hypot(...L); gl.uniform3fv(U('uL'),L.map(v=>v/ll));
  // Tip the axis sideways by the planet's tilt and toward us by 14°, so we look down a little on the north and rings open up.
  const tz=(B.tilt||0)*Math.PI/180, tx=14*Math.PI/180, cz=Math.cos(tz), sz=Math.sin(tz), cx=Math.cos(tx), sx=Math.sin(tx);
  gl.uniformMatrix3fv(U('uM'),false,new Float32Array([cz,sz,0, -sz*cx,cz*cx,sx, sz*sx,-cz*sx,cx]));
  const size=()=>{ const r=cv.getBoundingClientRect(), k=Math.min(2,devicePixelRatio||1); const w=Math.max(1,Math.round(r.width*k)), h=Math.max(1,Math.round(r.height*k));
    if(cv.width!==w||cv.height!==h){ cv.width=w; cv.height=h; gl.viewport(0,0,w,h); }
    // Kept to the right of the greeting: nothing (rings included) starts left of 62% of the width.
    const [ax,ay,ar]=B.at, R=B.ring?Math.min(h*ar,w*.09):Math.max(h*ar,w*ar*.2); gl.uniform2f(U('uC'),Math.max(w*ax,w*.62+R*(B.ring?2.1:.95)),h*(1-ay)); gl.uniform1f(U('uR'),R); draw(); };
  // Still, the Earth shows Europe and Africa; moving, it turns west to east at about 30 frames a second, and only on screen.
  const uLon=U('uLon'), uCloud=U('uCloud');
  function draw(){ if(dead)return; const s=live?(performance.now()-t0)/1000:0; const w=2*Math.PI/B.spin;
    gl.uniform1f(uLon,(B.tex==='earth'?.2:0)-s*w); gl.uniform1f(uCloud,-s*w*.18); gl.drawArrays(gl.TRIANGLES,0,3); }
  const tick=(now)=>{ frame=0; if(dead||!live||!onScreen)return; if(!cv.isConnected){ scene.stop(); return; } frame=requestAnimationFrame(tick); if(now-last<33)return; last=now; draw(); };
  const run=()=>{ if(!frame&&!dead&&live&&onScreen)frame=requestAnimationFrame(tick); };
  const ro=new ResizeObserver(size); ro.observe(cv); const io=new IntersectionObserver(([e])=>{ onScreen=e.isIntersecting; run(); }); io.observe(cv);
  bg.appendChild(cv); size(); run();
  const scene={body,canvas:cv,moving(v){ live=v; draw(); run(); },stop(){ dead=true; cancelAnimationFrame(frame); ro.disconnect(); io.disconnect(); cv.remove(); gl.getExtension('WEBGL_lose_context')?.loseContext(); if(heroPlanet===scene)heroPlanet=null; }};
  heroPlanet=scene; return true;
}
// Your own header gradient: two to six colours, a layout, an angle and some grain. Saved in prefs.gradient.
const ownGradient=()=>{ const g=prefs.gradient||{}; const stops=(Array.isArray(g.stops)&&g.stops.length>=2?g.stops:SET_GRADIENTS.dusk.c).filter(x=>/^#[0-9a-f]{6}$/i.test(x)).slice(0,6);
  return {stops,style:['linear','mesh','horizon'].includes(g.style)?g.style:'horizon',angle:Number.isFinite(+g.angle)?+g.angle:180,grain:Math.max(0,Math.min(100,+g.grain||0))}; };
function openGradientMaker(){
  // Opened from Customise, closing it any way (Cancel, Use it, Esc) goes back there, to the same place.
  const back=customOpen(); closeOverlays(); let g=JSON.parse(JSON.stringify(ownGradient()));
  let box=$('sheet-grad'); if(!box){ box=document.createElement('div'); box.className='sheet sheet-grad'; box.id='sheet-grad'; document.body.appendChild(box);
    new MutationObserver(()=>{ if(box.classList.contains('on')||!box.dataset.back)return; delete box.dataset.back; queueMicrotask(()=>{ if(!document.querySelector('.sheet.on,.pal.on,.drawer-r.on'))openCustom(); }); }).observe(box,{attributes:true,attributeFilter:['class']}); }
  if(back)box.dataset.back='1'; else delete box.dataset.back;
  const draw=()=>{
    box.innerHTML=`<h3>Your own header<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
      <div class="gm-pv" style="--hgrain:${g.grain/100};background-image:${colourGradient(g.stops,g.style,g.angle)}"><b>${greetTo('Good evening')}<span>.</span></b></div>
      <div class="gm-row"><label>Start from</label><div class="gm-chips">${[['dusk','Dusk'],['today',"Today's colours"]].map(([k,l])=>`<button type="button" class="chip" data-gm-from="${k}">${l}</button>`).join('')}</div></div>
      <div class="gm-row"><label>Colours</label><div class="gm-stops">${g.stops.map((c,i)=>`<span class="gm-stop" style="background:${c}"><button type="button" class="gm-pick" data-gm-pick="${i}" data-tip="Colour ${i+1}|${c}" aria-label="Colour ${i+1}"></button>${g.stops.length>2?`<button type="button" data-gm-del="${i}" aria-label="Remove">${icon('close')}</button>`:''}</span>`).join('')}${g.stops.length<6?`<button type="button" class="gm-add" data-gm-add aria-label="Add a colour">${icon('plus')}</button>`:''}</div></div>
      <div class="gm-row"><label>Layout</label><div class="seg">${[['linear','Sweep'],['mesh','Mesh'],['horizon','Horizon']].map(([v,l])=>`<button type="button" data-gm-style="${v}" aria-pressed="${g.style===v}">${l}</button>`).join('')}</div></div>
      ${g.style==='linear'?`<div class="gm-row"><label>Angle</label><div class="range"><input type="range" min="0" max="360" step="5" value="${g.angle}" data-gm-angle style="--v:${g.angle/3.6}%"><output>${g.angle}°</output></div></div>`:''}
      <div class="gm-row"><label>Grain</label><div class="range"><input type="range" min="0" max="100" step="1" value="${g.grain}" data-gm-grain style="--v:${g.grain}%"><output>${g.grain}</output></div></div>
      <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary" data-gm-save>Use it</button></div>`;
  };
  const pv=()=>{ const el=box.querySelector('.gm-pv'); if(el){ el.style.backgroundImage=colourGradient(g.stops,g.style,g.angle); el.style.setProperty('--hgrain',g.grain/100); } };
  draw();
  box.oninput=e=>{ const t=e.target;
    if(t.dataset.gmStop!=null){ g.stops[+t.dataset.gmStop]=t.value; t.parentElement.style.background=t.value; pv(); }
    if(t.dataset.gmAngle!=null){ g.angle=+t.value; t.style.setProperty('--v',(g.angle/3.6)+'%'); t.nextElementSibling.textContent=g.angle+'°'; pv(); }
    if(t.dataset.gmGrain!=null){ g.grain=+t.value; t.style.setProperty('--v',g.grain+'%'); t.nextElementSibling.textContent=g.grain; pv(); } };
  box.onclick=e=>{ const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.gmFrom){ const k=b.dataset.gmFrom; g.stops=k==='today'?(almanac?.items?.colours?.colours||[]).map(c=>c.hex).slice(0,6):SET_GRADIENTS[k].c.slice(0,6); if(g.stops.length<2)g.stops=SET_GRADIENTS.dusk.c.slice(); g.style=k==='today'?'linear':'horizon'; draw(); return; }
    if(b.dataset.gmPick!=null){ const i=+b.dataset.gmPick; openColourPicker(b,g.stops[i],{onInput:(hx)=>{ g.stops[i]=hx; b.parentElement.style.background=hx; b.dataset.tip=`Colour ${i+1}|${hx}`; pv(); }}); return; }
    if(b.dataset.gmDel!=null){ e.preventDefault(); g.stops.splice(+b.dataset.gmDel,1); draw(); return; }
    if(b.dataset.gmAdd!=null){ g.stops.push(g.stops[g.stops.length-1]); draw(); return; }
    if(b.dataset.gmStyle){ g.style=b.dataset.gmStyle; draw(); return; }
    if(b.dataset.gmSave!=null){ histStart('your own header'); prefs.gradient=g; prefs.look.hero='custom'; savePrefs(); histEnd(); closeOverlays(); if(view==='home')homeHero(); if(customOpen())renderCustom(); toast('Your header is set'); }
  };
  openSheet('sheet-grad');
}
// Your photos for the header. Each is shrunk to a 2600px JPEG here before it's sent, so phone photos upload quickly
// and lose their location data. The list lives in prefs.heroPhotos; the files in data/hero-photos on the Mac.
async function shrinkPhoto(file){
  const url=URL.createObjectURL(file);
  try{ const im=await new Promise((ok,no)=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=()=>no(new Error(`${file.name||'That file'} isn't a picture Meridian can open`)); i.src=url; });
    const k=Math.min(1,2600/Math.max(im.naturalWidth,im.naturalHeight)); const c=document.createElement('canvas'); c.width=Math.round(im.naturalWidth*k); c.height=Math.round(im.naturalHeight*k);
    c.getContext('2d').drawImage(im,0,0,c.width,c.height); return await new Promise(ok=>c.toBlob(ok,'image/jpeg',.88)); }
  finally{ URL.revokeObjectURL(url); }
}
function openPhotoSheet(){
  const back=customOpen(); closeOverlays();
  let box=$('sheet-photo'); if(!box){ box=document.createElement('div'); box.className='sheet sheet-photo'; box.id='sheet-photo'; document.body.appendChild(box);
    new MutationObserver(()=>{ if(box.classList.contains('on')||!box.dataset.back)return; delete box.dataset.back; queueMicrotask(()=>{ if(!document.querySelector('.sheet.on,.pal.on,.drawer-r.on'))openCustom(); }); }).observe(box,{attributes:true,attributeFilter:['class']}); }
  if(back)box.dataset.back='1'; else delete box.dataset.back;
  let busy=0;
  const url=(p)=>api(p.url||`/api/command/hero-photo/${p.id}`);
  const draw=()=>{ const ph=heroPhotos(); const cur=ph.find(x=>x.id===prefs.heroPhoto)||ph[0];
    box.innerHTML=`<h3>Your photos<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
      ${cur?`<div class="gm-pv" style="background-image:url('${url(cur)}');background-position:center ${cropY(cur)}%"><b>${greetTo('Good evening')}<span>.</span></b></div>
      <div class="gm-row"><label>Crop</label><div class="range"><input type="range" min="0" max="100" step="1" value="${cropY(cur)}" data-ph-y style="--v:${cropY(cur)}%" aria-label="Which part shows"><output>${cropY(cur)<34?'Top':cropY(cur)>66?'Bottom':'Middle'}</output></div></div>`:''}
      <div class="ph-grid">${ph.map(p=>`<div class="ph" role="button" tabindex="0" data-ph="${p.id}" aria-pressed="${p.id===cur?.id}" style="background-image:url('${url(p)}');background-position:center ${cropY(p)}%"><button type="button" class="ibtn" data-ph-del="${p.id}" data-tip="Remove this photo" aria-label="Remove">${icon('trash')}</button></div>`).join('')}
        <button type="button" class="ph-add" data-ph-add>${busy?'Adding…':`${icon('plus')}<br>Add a photo<br><span class="dim2">or drop one here</span>`}</button></div>
      <input type="file" accept="image/*" multiple hidden data-ph-file>
      <p class="hint">${ph.length>1?'Pick one, or choose Mix in Customise to have them take turns.':'Landscape photos work best. Add a few and Mix can rotate through them.'}</p>
      <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Close</button>${cur?'<button type="button" class="btn primary" data-ph-use>Use it</button>':''}</div>`; };
  const add=async(files)=>{ files=[...files].filter(f=>/^image\//.test(f.type)||/\.(heic|jpe?g|png|webp)$/i.test(f.name)); if(!files.length)return;
    busy++; draw(); let added=0;
    for(const f of files){ if(heroPhotos().length>=60){ toast('That’s 60 photos, the most it keeps. Remove some to add more.'); break; } try{ const blob=await shrinkPhoto(f);
        const r=await fetch(api('/api/command/hero-photo'),{method:'POST',headers:{'X-Meridian-Upload':'1','Content-Type':'image/jpeg'},body:blob}); const j=await r.json().catch(()=>({}));
        if(!r.ok||!j.ok||!j.id)throw new Error(j.error||(LAB?'Photos don\'t upload in lab mode':`Upload failed (${r.status})`));
        prefs.heroPhotos=[...heroPhotos(),{id:j.id,url:j.url,name:String(f.name||'').replace(/\.[^.]+$/,'').slice(0,40),y:50}]; prefs.heroPhoto=j.id; added++; }
      catch(err){ toast(String(err.message||err)); } }
    busy--; if(added){ savePrefs(); if(view==='home')homeHero(); } draw(); };
  draw();
  box.oninput=e=>{ const t=e.target; if(t.dataset.phY==null)return; const p=heroPhotos().find(x=>x.id===prefs.heroPhoto)||heroPhotos()[0]; if(!p)return;
    p.y=+t.value; t.style.setProperty('--v',p.y+'%'); t.nextElementSibling.textContent=p.y<34?'Top':p.y>66?'Bottom':'Middle';
    box.querySelector('.gm-pv').style.backgroundPosition=`center ${p.y}%`; const tile=box.querySelector(`.ph[data-ph="${p.id}"]`); if(tile)tile.style.backgroundPosition=`center ${p.y}%`;
    clearTimeout(box.t); box.t=setTimeout(()=>{ savePrefs(); if(view==='home')homeHero(); },250); };
  box.onclick=async e=>{
    if(e.target.closest('[data-ph-add]')){ box.querySelector('[data-ph-file]').click(); return; }
    const del=e.target.closest('[data-ph-del]'); if(del){ e.stopPropagation(); const id=del.dataset.phDel; const list=heroPhotos(); const at=list.findIndex(x=>x.id===id); const gone=list[at];
      const wasSel=prefs.heroPhoto===id, mixAt=(prefs.heroMix||[]).indexOf('photo:'+id);
      prefs.heroPhotos=list.filter(x=>x.id!==id); prefs.heroMix=(prefs.heroMix||[]).filter(k=>k!=='photo:'+id); if(wasSel)prefs.heroPhoto=prefs.heroPhotos[0]?.id;
      savePrefs(); if(view==='home')homeHero(); draw();
      // The file goes once the toast has gone without an Undo. Undo puts back just this photo, where it was, so anything
      // added in the meantime stays, and it's picked and in Mix again if it was before.
      let undone=false; toast('Photo removed',{undo:()=>{ undone=true; if(!gone||heroPhotos().some(x=>x.id===id))return;
        const now=heroPhotos(); now.splice(Math.min(at,now.length),0,gone); prefs.heroPhotos=now; if(wasSel)prefs.heroPhoto=id;
        if(mixAt>=0){ const m=[...(prefs.heroMix||[])]; m.splice(Math.min(mixAt,m.length),0,'photo:'+id); prefs.heroMix=m; }
        savePrefs(); if(view==='home')homeHero(); if(box.classList.contains('on'))draw(); }});
      setTimeout(()=>{ if(!undone&&!heroPhotos().some(x=>x.id===id))fetch(api('/api/command/hero-photo/'+id),{method:'DELETE'}).catch(()=>{}); },12000); return; }
    const t=e.target.closest('[data-ph]'); if(t){ prefs.heroPhoto=t.dataset.ph; savePrefs(); if(view==='home')homeHero(); draw(); return; }
    if(e.target.closest('[data-ph-use]')){ histStart('your photo'); prefs.look.hero='photo'; savePrefs(); histEnd(); closeOverlays(); if(view==='home')homeHero(); if(customOpen())renderCustom(); toast('Your header is set'); } };
  // Only the tile itself: Enter on its Remove button should remove, not pick.
  box.onkeydown=e=>{ const t=e.target.matches?.('[data-ph]')?e.target:null; if(t&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); t.click(); } };
  box.onchange=e=>{ if(e.target.dataset.phFile!=null){ add(e.target.files); e.target.value=''; } };
  box.ondragover=e=>{ if([...(e.dataTransfer?.types||[])].includes('Files')){ e.preventDefault(); box.classList.add('drag'); } };
  box.ondragleave=e=>{ if(!box.contains(e.relatedTarget))box.classList.remove('drag'); };
  box.ondrop=e=>{ e.preventDefault(); e.stopPropagation(); box.classList.remove('drag'); if(e.dataTransfer?.files?.length)add(e.dataTransfer.files); };
  openSheet('sheet-photo');
}
// Today's colours (or a set) as a header: a sweep, a mesh, or a horizon.
function colourGradient(c,style,angle=115){
  const at=(i)=>c[i%c.length];
  if(style==='mesh')return `radial-gradient(60% 80% at 12% 18%,${at(0)},transparent 62%),radial-gradient(55% 75% at 88% 12%,${at(1)},transparent 60%),radial-gradient(60% 80% at 75% 95%,${at(2)},transparent 62%),radial-gradient(50% 70% at 25% 100%,${at(3)},transparent 60%),linear-gradient(${at(1)},${at(1)})`;
  // Horizon ends at 88% so the warm last colour still shows before the banner fades out.
  if(style==='horizon')return `linear-gradient(180deg,${c.map((x,i)=>`${x} ${Math.round(i/(c.length-1||1)*88)}%`).join(',')})`;
  return `linear-gradient(${angle}deg,${c.map((x,i)=>`${x} ${Math.round(i/(c.length-1||1)*100)}%`).join(',')})`;
}
// The banner's credit is an extra for when there's room: it steps aside whenever it would touch the greeting or the
// line under it (a narrow window, the side panel open, a long line, the banner shrinking as you scroll).
let creditWatch=null, creditFrame=0;
function fitCredit(){ const c=$('h-credit'); if(!c)return; const cr=c.getBoundingClientRect();
  const hit=!!c.textContent.trim()&&['h-meta','h-greet','h-line'].some(id=>{ const el=$(id); if(!el?.textContent.trim())return false;
    const r=document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].some(t=>t.width&&t.right+24>cr.left&&t.bottom+10>cr.top&&t.top-10<cr.bottom); });
  c.classList.toggle('off',hit); }
function watchCredit(){ const h=$('h-hero'); if(!h)return; creditWatch?.forEach(o=>o.disconnect());
  const soon=()=>{ cancelAnimationFrame(creditFrame); creditFrame=requestAnimationFrame(fitCredit); };
  const ro=new ResizeObserver(soon); ['h-hero','h-greet','h-line','h-credit'].forEach(id=>ro.observe($(id)));
  const mo=new MutationObserver(soon); mo.observe(h,{childList:true,characterData:true,subtree:true});
  h.addEventListener('transitionend',soon); creditWatch=[ro,mo]; }
function almanacCredit(mode,p){
  if(mode==='earthview')return `<a href="${esc(p.mapUrl||'#')}" target="_blank" rel="noopener">${esc(p.place||[p.region,p.country].filter(Boolean).join(', ')||'Earth View')}</a><br><span class="dim2">Google Earth View</span>`;
  if(mode==='picture')return `<a href="${esc(p.filePage||'#')}" target="_blank" rel="noopener">${esc(cap(p.title||'Picture of the day',70))}</a><br><span class="dim2">${esc(cap(p.attribution||'Wikimedia Commons',60))}</span>`;
  if(mode==='earth')return `The whole Earth, ${esc(p.takenAt?shortDate(Date.parse(p.takenAt)):'this week')}<br><span class="dim2">NASA EPIC · DSCOVR</span>`;
  return '';
}
function joinBtn(e,big){ if(!e.joinUrl)return ''; const soon=e.ts-Date.now()<15*60000&&(e.end||e.ts)>Date.now(); return `<a class="btn ${big&&soon?'primary':'sm ghost'} join" href="${esc(e.joinUrl)}" target="_blank" rel="noopener" data-tip="Join the meeting">${icon('out')}${/teams/i.test(e.joinUrl)?'Join Teams':'Join'}</a>`; }
function homePush(){ const on=!!state?.notify?.enabled; const b=$('h-push'); if(!b)return; b.classList.toggle('on',on); b.setAttribute('aria-pressed',String(on)); setHTML(b,icon(on?'bell':'belloff')); b.dataset.tip=on?'Phone reminders are on|Meetings 10 min and 1 min before':'Phone reminders are off|Click to get meetings on your phone'; }
const normTitle=(t)=>String(t||'').replace(/\s+/g,' ').trim().toLowerCase();
// A calendar's colour. "By area" gives it its Space's colour (Outlook is work, Classes is uni, the rest personal),
// so one colour means one part of life everywhere; "by source" keeps the colour set in Connect.
function calArea(e){ const n=`${e.calendar||''} ${e.cal||''}`; return /outlook|teams|exchange|work/i.test(n)?'work':/class|uni|ulster|timetable/i.test(n)?'uni':'personal'; }
function calColor(e){ if((lookOpt('calcol')||'area')==='area'){ const sp=spaceList().find(s=>s.id===calArea(e)); if(sp)return spColor(sp); } return e.color||'var(--dim2)'; }
function homeNext(){
  homePush();
  const mode=lookOpt('hnext')||'stack';
  const seen=new Set(); const evs=(state.calendar?.events||[]).filter(e=>(e.end||e.ts)>=Date.now()&&e.response!=='declined').sort((a,b)=>a.ts-b.ts).filter(e=>{ const k=e.ts+'|'+String(e.title).trim().toLowerCase(); if(seen.has(k))return false; seen.add(k); return true; });
  const today=isoDay();
  const dls=(state.deadlines||[]).filter(d=>!d.done&&!d.archived&&!(d.snoozedUntil&&d.snoozedUntil>today)&&daysUntil(d.due)>=0).sort((a,b)=>a.due.localeCompare(b.due));
  const invites=(state.invites||[]).filter(i=>Date.parse(i.end||i.start)>=Date.now()).sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  setText($('h-next-sub'),state.calendar?.configured?`${evs.length} in the next week`:'calendar not connected');
  const waiting=new Set(invites.map(i=>i.calendarId).filter(Boolean));
  const pending=(e)=>e.response==='needsAction'||waiting.has(e.id)?'<span class="tag warn">Not accepted</span>':e.response==='tentative'?'<span class="tag">Maybe</span>':'';
  const out=[];
  // His standing daily meeting never takes the headline (he asked the brief never to remind him); it stays in the list with its Join link.
  const skipRe=(state.nudges?.skip||[]).map(x=>{ try{ return new RegExp(x,'i'); }catch{ return null; } }).filter(Boolean);
  const routine=(e)=>skipRe.some(r=>r.test(String(e.title).trim()));
  const hi=evs.findIndex(e=>!routine(e)); if(hi>0)evs.unshift(...evs.splice(hi,1));
  // A repeating meeting shows once, at its next occurrence, so the daily one can't fill the list.
  const seenSeries=new Set(); const once=[]; for(const e of evs){ const k=e.recurring||routine(e)?(e.uid||e.title):null; if(k&&seenSeries.has(k))continue; if(k)seenSeries.add(k); once.push(e); } evs.splice(0,evs.length,...once);
  const dlOwn=!!$('h-dl');
  const soonWord=(f)=>{ const inMin=Math.round((f.ts-Date.now())/60000); return f.ts<=Date.now()?'on now':inMin>0&&inMin<120?`in ${inMin} min`:inMin<24*60&&startOfDay(f.ts)===startOfDay(Date.now())?`in ${Math.round(inMin/60)} h`:''; };
  const metaOf=(f)=>{ const mins=f.end?Math.round((f.end-f.ts)/60000):0; return esc([mins&&!f.allDay?hours(mins):'',f.organizer||''].filter(Boolean).join(' · ')); };
  // An invite shows on the meeting itself (with Reply), and the invites left over are grouped by title, so a weekly series is one line.
  const inviteFor=(e)=>invites.find(i=>(i.calendarId&&i.calendarId===e.id)||(Date.parse(i.start)===e.ts&&normTitle(i.title)===normTitle(e.title)));
  const reply=(e,cls='btn sm')=>{ const i=inviteFor(e); return i?.url?`<a class="${cls}" href="${esc(i.url)}" target="_blank" rel="noopener" data-tip="Reply in Outlook">${icon('reply')}Reply</a>`:''; };
  const repeats=(e)=>e.recurring?`<span class="rep" data-tip="Repeats">${icon('refresh')}</span>`:'';
  const col=(e)=>esc(calColor(e));
  const srcTip=(e)=>esc(e.calendar||e.cal||'');
  const used=new Set(evs.map(inviteFor).filter(Boolean));
  const loose=[]; for(const i of invites){ if(used.has(i))continue; const g=loose.find(x=>normTitle(x.title)===normTitle(i.title)); if(g)g.dates.push(Date.parse(i.start)); else loose.push({...i,dates:[Date.parse(i.start)]}); }
  const waitingHTML=()=>loose.length?`<div class="sec-h" style="margin:18px 0 6px"><h3 style="font-size:16px">Waiting for your reply</h3><span class="sub">not on your calendar until you accept</span></div><div class="rows">`+loose.slice(0,3).map(i=>`<div class="row"><span class="when-col">${i.dates.slice(0,2).map(d=>esc(dayWord(d))).join(', ')}${i.dates.length>2?' +'+(i.dates.length-2):''}</span><div class="main"><div class="t">${esc(i.title)}</div><div class="s">${esc(i.organizer||'')} · ${hm(i.dates[0])}</div></div><span class="acts" style="opacity:1">${i.url?`<a class="btn sm" href="${esc(i.url)}" target="_blank" rel="noopener">Reply in Outlook</a>`:''}${i.joinUrl?`<a class="ibtn" href="${esc(i.joinUrl)}" target="_blank" rel="noopener" data-tip="Join link">${icon('out')}</a>`:''}</span></div>`).join('')+'</div>':'';
  if(!evs.length)out.push('<div class="empty">Nothing on the calendar this week.</div>');
  else if(mode==='stack'){
    // The next meeting with its time big, a coloured line for where it's from, a countdown and every action on it.
    // The rest is a small agenda: the day is written once, on its first meeting, instead of on every row.
    const [f,...rest]=evs; const sw=soonWord(f);
    // The headline's style (prefs.look.nxs): Wash, Line or Open.
    const nxs=lookOpt('nxs')||'wash';
    const big=`${f.allDay?'All day':hm(f.ts)}<small>${esc(dayWord(f.ts))}</small>`;
    out.push(`<div class="nx nx-${nxs}" style="--c:${col(f)}" data-tip="${srcTip(f)}"><div class="nx-t">${big}</div><div class="nx-m">${sw?`<span class="when">${esc(sw)}</span>`:''}<span class="what">${esc(f.title)}</span><span class="how">${metaOf(f)} ${pending(f)}${repeats(f)}</span><div class="nx-a">${joinBtn(f,true)}${reply(f,'btn')}</div></div></div>`);
    let day=''; out.push('<div class="mag">'+rest.slice(0,5).map(e=>{ const dw=dayWord(e.ts); const first=dw!==day; day=dw;
      return `<div class="row mag-row${first?' first':''}"><span class="mag-d">${first?esc(dw):''}</span><span class="mag-t">${e.allDay?'All day':hm(e.ts)}</span><i class="ag-bar sm" style="--c:${col(e)}" data-tip="${srcTip(e)}"></i><div class="main"><div class="t">${esc(e.title)} ${pending(e)}${repeats(e)}</div></div><span class="acts">${reply(e)}${joinBtn(e)}</span></div>`; }).join('')+'</div>');
    out.push(waitingHTML());
    if(dls.length&&!dlOwn)out.push(`<div class="sec-h" style="margin:18px 0 6px"><h3 style="font-size:16px">Deadlines</h3></div>`+deadlineRows(dls.slice(0,4)));
  }else if(mode==='agenda'){
    let day=''; const rows=[];
    evs.slice(0,8).forEach((e,i)=>{ const dw=dayWord(e.ts); if(dw!==day){ day=dw; const dd=new Date(e.ts); rows.push(`<div class="ag-day"><b>${esc(dw)}</b><span>${esc(DAYS[dd.getDay()])} ${dd.getDate()} ${esc(MONTHS[dd.getMonth()].slice(0,3))}</span></div>`); }
      const mins=e.end?Math.round((e.end-e.ts)/60000):0;
      rows.push(`<div class="ag-row${i===0?' is-next':''}" style="--c:${col(e)}"><span class="ag-t">${e.allDay?'All day':hm(e.ts)}<small>${mins&&!e.allDay?hours(mins):''}</small></span><i class="ag-bar" data-tip="${srcTip(e)}"></i><div class="main"><div class="t">${esc(e.title)}</div><div class="s">${esc(e.organizer||'')} ${pending(e)}${repeats(e)}</div></div>${i===0&&soonWord(e)?`<span class="ag-when">${esc(soonWord(e))}</span>`:''}<span class="acts"${i===0?' style="opacity:1"':''}>${reply(e)}${joinBtn(e,i===0)}</span></div>`); });
    out.push(`<div class="agenda">${rows.join('')}</div>`, waitingHTML());
  }else{
    const [f,...rest]=evs;
    if(mode==='timeline'){
      const t0=startOfDay(Date.now()); const tday=(state.calendar?.events||[]).filter(e=>!e.allDay&&startOfDay(e.ts)===t0&&e.response!=='declined');
      let a=Math.min(8,new Date().getHours()),b=20; for(const e of tday){ a=Math.min(a,new Date(e.ts).getHours()); b=Math.max(b,Math.ceil(((e.end||e.ts+3600e3)-t0)/3600e3)); } b=Math.min(24,b);
      const pos=(ts)=>Math.max(0,Math.min(100,((ts-t0)/3600e3-a)/(b-a)*100));
      const ticks=[]; for(let hh=a;hh<=b;hh+=2)ticks.push(`<span style="left:${pos(t0+hh*3600e3)}%">${pad(hh)}</span>`);
      const blocks=tday.map(e=>`<i class="tl-ev${(e.end||e.ts)<Date.now()?' past':''}" style="left:${pos(e.ts)}%;width:max(6px,${pos(e.end||e.ts+1800e3)-pos(e.ts)}%);--c:${col(e)}" data-tip="${esc(hm(e.ts)+' '+e.title)}"></i>`).join('');
      const left=tday.filter(e=>(e.end||e.ts)>Date.now()).length;
      out.push(`<div class="tl"><div class="tl-track">${blocks}<b class="tl-now" style="left:${pos(Date.now())}%"></b></div><div class="tl-ticks">${ticks.join('')}</div><div class="tl-cap">${left?`${left} more today`:'Nothing else today'}</div></div>`);
    }
    out.push(`<div class="spot" style="--c:${col(f)}"><div class="spot-t">${f.allDay?'All day':hm(f.ts)}<small>${esc(dayWord(f.ts))}</small></div><div class="spot-m">${soonWord(f)?`<span class="when">${esc(soonWord(f))}</span>`:''}<span class="what">${esc(f.title)}</span><span class="how">${metaOf(f)} ${pending(f)}</span><div class="spot-a">${joinBtn(f,true)}${reply(f,'btn')}</div></div></div>`);
    out.push('<div class="rows">'+rest.slice(0,mode==='timeline'?3:4).map(e=>`<div class="row"><span class="when-col">${esc(dayWord(e.ts))} ${e.allDay?'':hm(e.ts)}</span><i class="ag-bar sm" style="--c:${col(e)}"></i><div class="main"><div class="t">${esc(e.title)} ${pending(e)}${repeats(e)}</div></div><span class="acts">${reply(e)}${joinBtn(e)}</span></div>`).join('')+'</div>', waitingHTML());
  }
  setHTML($('h-next'),out.join(''));
  if(dlOwn)homeDeadlines(dls);
}
// Deadlines: days left, a bar that fills as the date gets close, and Done on hover. Calendar ones are read-only.
function deadlineRows(list){
  return '<div class="rows">'+list.map(d=>{ const n=daysUntil(d.due); const dd=new Date(d.due+'T12:00:00'); const fill=Math.max(4,Math.min(100,100-n/30*100));
    return `<div class="row dl-row${n<=3?' close':''}" data-dl="${esc(d.id)}"><span class="due-n">${n===0?'Today':n+'d'}<small>${DAYS[dd.getDay()].slice(0,3)} ${dd.getDate()}</small></span><div class="main"><div class="t">${esc(d.title)}</div><div class="s">${esc([d.area,d.note].filter(Boolean).join(' · '))}</div><span class="dl-bar"><i style="width:${fill}%"></i></span></div>${d.fromCalendar?'':`<span class="acts"><button class="ibtn" data-dl-act="done" data-tip="Done">${icon('check')}</button></span>`}</div>`; }).join('')+'</div>';
}
function homeDeadlines(dls){
  $('h-dl-sub').textContent=dls.length?`${dls.length} coming up`:'';
  $('h-dl').innerHTML=dls.length?deadlineRows(dls.slice(0,5)):'<div class="empty">No deadlines. Add one with +.</div>';
}
async function dlClick(e){
  const b=e.target.closest('[data-dl-act]'); if(!b)return; const id=b.closest('[data-dl]').dataset.dl;
  try{ await send('/api/deadlines/'+id,{done:true},'PATCH'); toast('Done',{undo:()=>send('/api/deadlines/'+id,{done:false},'PATCH').then(loadState)}); loadState(); }catch(err){ toast(err.message); }
}
const PRIO={now:'Now',next:'Next',later:'Later'};
let todoEditing=false;
// Home's To do: your own to-dos and what the brief pulled in from Outlook and Slack, in the order todo-rank.js
// suggests (Do first, then the rest). Chips filter by source, and the card at the top previews whichever row
// you point at. All again on every load.
let todoFilter='all', todoFocus='', todoVisible=[], todoShowAll=false;
const TODO_FIRST=3, TODO_THEN=5;
const srcMark=s=>s==='outlook'||s==='slack'?`<svg class="srcm" aria-hidden="true"><use href="#src-${s}"/></svg>`:'';
const nameHue=n=>{ let h=0; for(const c of String(n||''))h=(h*31+c.charCodeAt(0))%360; return h; };
const nameInitials=n=>String(n||'').split(/\s+/).filter(w=>/^[a-z0-9]/i.test(w)).slice(0,2).map(w=>w[0].toUpperCase()).join('');
// Slack photos by sender name, so Avery's emails get the face her Slack messages have.
let photoMemo={s:null,m:new Map()};
function briefPhotos(){
  if(photoMemo.s===state)return photoMemo.m; const m=new Map();
  for(const i of (state.briefIntake&&state.briefIntake.items)||[])if(i.from&&/^https:\/\//.test(i.avatarUrl||''))m.set(i.from.trim().toLowerCase(),i.avatarUrl);
  photoMemo={s:state,m}; return m;
}
const PERSONAL_MAIL=/^(gmail|googlemail|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail)\./i;
const siteOf=d=>{ const p=d.toLowerCase().split('.'); return p.slice(/\.(co|org|ac|gov)\.uk$/.test(d)?-3:-2).join('.'); };
// A real picture where there is one: their Slack photo, else their company's own logo. Initials otherwise.
function facePic(b){
  if(b.avatar)return {url:b.avatar};
  const slack=b.from&&briefPhotos().get(b.from.trim().toLowerCase()); if(slack)return {url:slack};
  const dom=String(b.fromEmail||'').split('@')[1]||'';
  if(dom&&!PERSONAL_MAIL.test(dom))return {url:api('/api/favicon?url='+encodeURIComponent('https://'+siteOf(dom))),logo:true};
  // Outlook shows people as "First Last"; a one-word sender is nearly always a company (Vercel, OpenAI, Hotjar).
  if(b.source==='outlook'&&/^[A-Za-z][A-Za-z0-9]{2,}$/.test(b.from||''))return {url:api('/api/favicon?url='+encodeURIComponent('https://'+b.from.toLowerCase()+'.com')),logo:true};
  return {};
}
function faceHTML(b,cls='',badge=false){
  const who=b.from||SRC_LABEL[b.source]||b.source||'', pic=facePic(b);
  return `<span class="face${cls?' '+cls:''}" style="--h:${nameHue(who)}" title="${esc(who)}"><b>${esc(nameInitials(who)||'·')}</b>${pic.url?`<img${pic.logo?' class="logo"':''} src="${esc(pic.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:''}${badge&&srcMark(b.source)?`<i class="fbadge">${srcMark(b.source)}</i>`:''}</span>`;
}
function briefRun(id){
  const runs=((state.delegations&&state.delegations.runs)||[]).filter(r=>r.projectId===id&&!['failed','cancelled'].includes(r.status));
  return runs.sort((a,b)=>(b.started||0)-(a.started||0))[0]||null;
}
const runWord=r=>r?(r.status==='done'?'Report ready':r.status==='stalled'?'Needs a look':'Working')+' · '+modelName(r.model||'Agent'):'';
// Where a hand-off is up to, on its row. Once the report is in, the words open it.
const runBit=r=>r.status==='done'&&r.id?`<button type="button" class="run ok runlink" data-run="${esc(r.id)}" data-tip="Open the agent's report">${esc(runWord(r))}</button>`:`<span class="run${r.status==='done'?' ok':''}">${esc(runWord(r))}</span>`;
const dlgBtn=kind=>`<button class="dlg" data-${kind}-act="agent" data-tip="Delegate to ${esc(modelName(getPick().model))}">${icon('agent')}<span>Delegate</span></button>`;
const fullWhen=w=>{ const t=Date.parse(w); return isNaN(t)?'':shortDate(t)+' at '+hm(t); };
// The model's order: id -> {urgency, reason, i}. Empty until the first run lands, and then Home groups as before.
function todoRankMap(){ const m=new Map(); ((state.todoRank&&state.todoRank.items)||[]).forEach((x,i)=>m.set(x.id,{...x,i})); return m; }
function ownRow(t,o={}){
  const bits=[o.why?`<span class="why">${esc(o.why)}</span>`:'',o.prio&&t.priority==='now'?'<span class="prio now">Now</span>':'',t.delegation?runBit(t.delegation):''].filter(Boolean);
  return `<div class="row todo" data-todo="${esc(t.id)}"><button class="tick" data-todo-done="${esc(t.id)}" data-tip="Done" aria-label="Rowan done">${icon('check')}</button><div class="main"><div class="t edit" data-edit="todo">${esc(t.title)}</div>${bits.length?`<div class="s">${bits.join(' · ')}</div>`:''}</div>
    <span class="acts">${dlgBtn('todo')}<button class="ibtn" data-todo-act="menu" data-tip="More">${icon('dots')}</button></span></div>`;
}
function briefRow(b,o={}){
  const run=briefRun(b.id), src=SRC_LABEL[b.source]||b.source||'';
  const open=b.url?`<a class="ibtn" href="${esc(b.url)}" target="_blank" rel="noopener" data-tip="Open in ${esc(src||'the source')}">${icon('out')}</a>`:'';
  const bits=[o.why?`<span class="why">${esc(o.why)}</span>`:'',run?runBit(run):''].filter(Boolean);
  return `<div class="row todo" data-brief="${esc(b.id)}"><button class="tick" data-brief-done="${esc(b.id)}" data-tip="Done" aria-label="Rowan done">${icon('check')}</button><div class="main"><div class="t edit" data-edit="brief">${esc(b.title)}</div>${bits.length?`<div class="s">${bits.join(' · ')}</div>`:''}</div>
    <span class="slot">${faceHTML(b,'sm',true)}</span><span class="acts">${dlgBtn('brief')}${open}<button class="ibtn" data-brief-act="menu" data-tip="More">${icon('dots')}</button></span></div>`;
}
// The preview: who, where from, when, why now, and what they asked. Information only; the row has the buttons.
function todoPeekHTML(){
  const id=todoVisible.includes(todoFocus)?todoFocus:todoVisible[0]; if(!id)return '';
  const r=todoRankMap().get(id), why=r&&r.reason?`<div class="why">${esc(r.reason)}</div>`:'';
  const b=briefTodos().find(x=>x.id===id);
  if(b){ const src=SRC_LABEL[b.source]||b.source||'', run=briefRun(b.id);
    return `<div class="tpanel"><div class="tp-h">${faceHTML(b)}<div><b>${esc(b.from||src)}</b><span>${srcMark(b.source)}${esc(src)}${b.when?' · '+esc(fullWhen(b.when)):''}${run?` · <em class="run${run.status==='done'?' ok':''}">${esc(runWord(run))}</em>`:''}</span></div></div>${why}<p>${esc(b.body||b.title)}</p></div>`; }
  const t=(state.todos||[]).find(x=>x.id===id); if(!t)return '';
  return `<div class="tpanel"><div class="tp-h"><span class="face you">${icon('todo')}</span><div><b>Yours</b><span>Added ${esc(shortDate(Date.parse(t.created)||Date.now()))}${t.priority==='now'?' · marked Now':''}${t.delegation?' · '+esc(runWord(t.delegation)):''}</span></div></div>${why}${t.note?`<p>${esc(t.note)}</p>`:''}</div>`;
}
function homeTodo(){
  if(todoEditing)return; // never redraw under a to-do he is typing into
  const own=(state.todos||[]).filter(t=>!t.done), brief=briefTodos(), rank=todoRankMap();
  setText($('h-todo-sub'),(own.length+brief.length?`${own.length+brief.length} open`:'')+(state.todoRank&&state.todoRank.running?' · sorting…':''));
  const srcs=['outlook','slack','teams'].filter(s=>brief.some(b=>b.source===s));
  if(todoFilter!=='all'&&todoFilter!=='mine'&&!srcs.includes(todoFilter))todoFilter='all';
  const chip=(id,label,n,mark='')=>`<button class="tchip${todoFilter===id?' on':''}" data-tf="${id}" aria-pressed="${todoFilter===id}">${mark}${esc(label)}<span>${n}</span></button>`;
  const chips=own.length+brief.length?`<div class="tchips">${chip('all','All',own.length+brief.length)}${chip('mine','Yours',own.length)}${srcs.map(s=>chip(s,SRC_LABEL[s],brief.filter(b=>b.source===s).length,srcMark(s))).join('')}</div>`:'';
  const items=[...own.map(t=>({k:'todo',id:t.id,t})),...brief.map(b=>({k:'brief',id:b.id,b,src:b.source}))]
    .filter(x=>todoFilter==='all'||(todoFilter==='mine'?x.k==='todo':x.k==='brief'&&x.src===todoFilter));
  const row=(x,o={})=>x.k==='todo'?ownRow(x.t,o):briefRow(x.b,o);
  const grp=(h,list,o={})=>list.length?`<div class="tg"><div class="tg-h">${h}<span>${list.length}</span></div><div class="rows">${list.map(x=>row(x,{...o,why:o.why?rank.get(x.id)?.reason:''})).join('')}</div></div>`:'';
  let shown=items, html='';
  if(rank.size){
    items.sort((a,b)=>(rank.get(a.id)?.i??1e3)-(rank.get(b.id)?.i??1e3));
    if(todoFilter==='all'&&!todoShowAll)shown=items.slice(0,TODO_FIRST+TODO_THEN);
    html=grp('Do first',shown.slice(0,TODO_FIRST),{why:true})+grp('Then',shown.slice(TODO_FIRST));
  }else{
    // Before the first ranking: Now, the rest of yours, then the inbox.
    const now=items.filter(x=>x.k==='todo'&&x.t.priority==='now'), mine=items.filter(x=>x.k==='todo'&&x.t.priority!=='now'), inbox=items.filter(x=>x.k==='brief');
    const inboxShown=todoFilter==='all'&&!todoShowAll?inbox.slice(0,5):inbox; shown=[...now,...mine,...inboxShown];
    html=grp('Now',now)+grp('Yours',mine,{prio:true})+grp('From your inbox',inboxShown);
  }
  todoVisible=shown.map(x=>x.id);
  const more=items.length-shown.length;
  const foot=more>0?`<button class="btn sm ghost tmore" data-tmore="1">${more} more</button>`:todoShowAll&&todoFilter==='all'?`<button class="btn sm ghost tmore" data-tmore="0">Show fewer</button>`:'';
  if(!own.length&&!brief.length)html='<div class="empty">Nothing open. Enjoy it.</div>';
  setHTML($('h-todo'),chips+todoPeekHTML()+html+foot);
}
// The preview follows whichever row the pointer or keyboard is on.
function todoPoint(e){
  if(todoEditing)return;
  const row=e.target.closest('.row.todo'); if(!row)return; const id=row.dataset.brief||row.dataset.todo;
  if(!id||id===todoFocus)return; todoFocus=id; const old=$('h-todo').querySelector('.tpanel'); if(!old)return;
  old.outerHTML=todoPeekHTML(); $('h-todo').__h=null;
}
// Click straight on the words to fix them. Enter saves, Escape puts them back.
function editInline(el,save){
  if(el.isContentEditable)return; const before=el.textContent; todoEditing=true; hideTip();
  el.contentEditable='plaintext-only'; el.classList.add('editing'); el.focus();
  const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(r);
  let done=false; const finish=async(keep)=>{ if(done)return; done=true; el.contentEditable='false'; el.classList.remove('editing'); todoEditing=false; const v=el.textContent.replace(/\s+/g,' ').trim();
    if(!keep||!v||v===before){ el.textContent=before; return; } try{ await save(v); toast('Saved'); loadState(); }catch(err){ el.textContent=before; toast(err.message); } };
  el.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){ e.preventDefault(); finish(true); } if(e.key==='Escape'){ e.preventDefault(); finish(false); } });
  el.addEventListener('blur',()=>finish(true),{once:true});
}
async function handToAgent(kind,id,title){
  const p=getPick(); toast(`Handing it to ${modelName(p.model)}…`); feelRocket(kind,id,title);
  try{ if(kind==='todo')await send('/api/todos/'+id+'/delegate',{model:p.model,effort:p.effort}); else await send('/api/delegate',{projectId:id,title,model:p.model,effort:p.effort}); toast(`${modelName(p.model)} is on it. ${prefs.strip==='off'?'Follow it in System.':'It shows along the bottom while it works.'}`); loadState(); }catch(err){ toast(err.message); }
}
function todoMenu(x,y,t){
  menu(x,y,[
    {label:'Edit',icon:'edit',act:()=>{ const el=document.querySelector(`[data-todo="${CSS.escape(t.id)}"] [data-edit]`); if(el)editInline(el,v=>send('/api/todos/'+t.id,{title:v},'PATCH')); }},
    'hr',
    ...['now','next','later'].map(p=>({label:(t.priority===p?'✓ ':'')+PRIO[p],icon:p==='now'?'bolt':p==='later'?'pause':'arrow',act:()=>send('/api/todos/'+t.id,{priority:p},'PATCH').then(loadState).catch(err=>toast(err.message))})),
    'hr',
    {label:`Hand to ${modelName(getPick().model)}`,icon:'agent',act:()=>handToAgent('todo',t.id,t.title)},
    {label:'Delete',icon:'trash',danger:true,act:async()=>{ try{ await send('/api/todos/'+t.id,undefined,'DELETE'); loadState(); toast('Deleted',{undo:async()=>{ await send('/api/todos',{title:t.title,priority:t.priority,note:t.note}).catch(()=>{}); loadState(); }}); }catch(err){ toast(err.message); } }},
  ]);
}
function briefMenu(x,y,b){
  menu(x,y,[
    {label:'Edit',icon:'edit',act:()=>{ const el=document.querySelector(`[data-brief="${CSS.escape(b.id)}"] [data-edit]`); if(el)editInline(el,v=>send('/api/projects/'+b.id,{title:v},'PATCH')); }},
    b.url?{label:`Open in ${SRC_LABEL[b.source]||'the source'}`,icon:'out',act:()=>openUrl(b.url)}:null,
    {label:`Hand to ${modelName(getPick().model)}`,icon:'agent',act:()=>handToAgent('brief',b.id,b.title)},
    'hr',
    {label:'Done',icon:'check',act:()=>send('/api/brief-feedback',{id:'project:'+b.id,action:'complete'}).then(loadState)},
    {label:'Not for me',icon:'close',danger:true,act:()=>send('/api/brief-feedback',{id:'project:'+b.id,action:'reject'}).then(loadState)},
  ]);
}
async function todoClick(e){
  const rl=e.target.closest('[data-run]'); if(rl){ openUrl(new URL(api('/delegations/'+encodeURIComponent(rl.dataset.run)+'/REPORT.md'),location.href).href,null,'split'); return; }
  const ed=e.target.closest('[data-edit]');
  if(ed&&!e.target.closest('a,button')){ const row=ed.closest('.row'); if(row.dataset.todo)editInline(ed,v=>send('/api/todos/'+row.dataset.todo,{title:v},'PATCH')); else editInline(ed,v=>send('/api/projects/'+row.dataset.brief,{title:v},'PATCH')); return; }
  const tf=e.target.closest('[data-tf]'); if(tf){ todoFilter=tf.dataset.tf; todoFocus=''; todoShowAll=false; return homeTodo(); }
  const tm=e.target.closest('[data-tmore]'); if(tm){ todoShowAll=tm.dataset.tmore==='1'; return homeTodo(); }
  const ta=e.target.closest('[data-todo-act]'), ba=e.target.closest('[data-brief-act]');
  if(ta){ const t=(state.todos||[]).find(x=>x.id===ta.closest('[data-todo]').dataset.todo); if(!t)return; if(ta.dataset.todoAct==='agent')return handToAgent('todo',t.id,t.title); const r=ta.getBoundingClientRect(); return todoMenu(r.left,r.bottom+6,t); }
  if(ba){ const b=briefTodos().find(x=>x.id===ba.closest('[data-brief]').dataset.brief); if(!b)return; if(ba.dataset.briefAct==='agent')return handToAgent('brief',b.id,b.title); const r=ba.getBoundingClientRect(); return briefMenu(r.left,r.bottom+6,b); }
  const b=e.target.closest('[data-todo-done],[data-brief-done]'); if(!b)return;
  const row=b.closest('.row'); b.classList.add('ticked');
  // Lab: the line crosses it off, a burst of dots and the chime, then the list moves on.
  const fx=FEEL()?Feel.done(b,row.querySelector('.t')):null; if(!fx){ row.style.transition='opacity .3s'; row.style.opacity='.35'; }
  try{
    if(b.dataset.todoDone){ const id=b.dataset.todoDone; await send('/api/todos/'+id,{done:true},'PATCH'); toast('Done',{undo:()=>send('/api/todos/'+id,{done:false},'PATCH').then(loadState)}); }
    else{ await send('/api/brief-feedback',{id:'project:'+b.dataset.briefDone,action:'complete'}); toast('Done'); }
    await fx; loadState();
  }catch(err){ row.style.opacity=''; b.classList.remove('ticked'); if(fx)Feel.undone(b,row.querySelector('.t')); toast(err.message); }
}
function tileHTML(l,{small=false}={}){
  const pv=state?.capabilities?.previews!==false&&l.preview!==false;
  const down=l.health&&l.check!==false&&!l.health.up;
  return `<article class="ltile${small?' sm':''}" data-id="${esc(l.id)}" tabindex="0" title="${esc(l.title)}">
    <div class="shot"><span class="big-mark">${esc((l.title||'?').trim().charAt(0).toUpperCase())}</span>${pv?shot(api('/api/preview?link='+encodeURIComponent(l.id))):''}${down?`<span class="status"><i class="dot down"></i>Down</span>`:''}</div>
    <div class="lb">${favImg(l)}<div class="lt"><b>${esc(l.title)}</b><span>${esc(hostOf(l.url))}</span></div></div>
    <div class="hover-acts"><button type="button" data-tact="pin" title="${l.pinned?'Off the top shelf':'Put on the top shelf'}" aria-label="${l.pinned?'Unpin':'Pin'}">${icon(l.pinned?'unpin':'pin')}</button><button type="button" data-tact="menu" title="More" aria-label="More">${icon('dots')}</button></div></article>`;
}
function bindShelfTiles(container){
  container.addEventListener('click',e=>{
    if(dragJustEnded())return;
    const tile=e.target.closest('.ltile'); if(!tile)return; const id=tile.dataset.id; const l=links.links.find(x=>x.id===id); if(!l)return;
    const a=e.target.closest('[data-tact]');
    if(a){ e.stopPropagation(); if(a.dataset.tact==='pin')patchLink(id,l.pinned?{pinned:false}:{pinned:true,pinOrder:Math.max(-1,...topShelf().map(v=>v.pinOrder||0))+1},l.pinned?'Moved to the shelf':'On the top shelf'); else{ const r=a.getBoundingClientRect(); linkMenu(r.left,r.bottom+6,id); } return; }
    openLink(l,e);
  });
  container.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const t=e.target.closest('.ltile'); const l=t&&links.links.find(x=>x.id===t.dataset.id); if(l)openLink(l); } });
  container.addEventListener('contextmenu',e=>{ const t=e.target.closest('.ltile'); if(!t)return; e.preventDefault(); linkMenu(e.clientX,e.clientY,t.dataset.id); });
}
const homeShelfMode=()=>{ const m=lookOpt('hshelf'); return ['row','scroll','fit','dock'].includes(m)?m:'scroll'; };
function homeShelf(){
  // Wrap is the original. Row keeps it to one line of six with a "more" tile, Scroll slides sideways,
  // Fit squeezes every pinned link into one line, Dock drops the previews for favicon chips, Off hides it.
  const mode=homeShelfMode(); const all=topShelf().filter(inSpace);
  let top=all; let more=0;
  if(mode==='row'&&all.length>6){ top=all.slice(0,5); more=all.length-5; }
  const s=sig([spaceId,mode,top.map(l=>[l.id,l.title,l.pinned,l.health&&l.health.up,l.pinOrder]),more]);
  if(s===homeShelfSig)return; homeShelfSig=s;
  $('h-shelf').style.setProperty('--n',String(Math.max(1,top.length))); $('h-shelf').dataset.mode=mode;
  $('h-shelf').innerHTML=top.length?top.map(l=>tileHTML(l)).join('')+(more?`<button type="button" class="shelf-more" data-go="shelf"><b>+${more}</b><span>more on the shelf</span></button>`:''):`<button class="shelf-drop" id="h-shelf-empty">Paste a link, drop one here, or press N</button>`;
  $('h-shelf-empty')?.addEventListener('click',()=>openLinkSheet({pinned:true}));
}
// The lab (/labs/home.html) posts looks and layouts to try. They sit on top of the saved prefs and are never saved.
if(LAB){
  addEventListener('message',e=>{ const m=e.data; if(e.origin!==location.origin||m?.type!=='meridian-lab')return;
    labLook={look:m.look||{},accent:m.accent||null,spaces:m.spaces||null}; applyPrefs(); sideSig=''; renderSide();
    if(view==='home'&&state){ const y=$('page').scrollTop; VIEWS.home.mount($('v-home')); VIEWS.home.update(); $('page').scrollTop=m.top?0:y; }
  });
  parent.postMessage({type:'meridian-lab-ready'},location.origin);
}
// Scroll header: pull down at the top and the banner grows tall; scroll down and it settles back, then eases away.
(()=>{ const pg=$('page'); const on=()=>root.dataset.hhero==='scroll'&&view==='home'; let ty=null;
  const grow=(v)=>{ const h=$('h-hero'); if(h&&h.classList.contains('tall')!==v)h.classList.toggle('tall',v); };
  // It only grows on a deliberate pull: the page has to have been resting at the top, then about two notches up.
  let topSince=0, pull=0, pullT=0;
  pg.addEventListener('wheel',e=>{ if(!on())return; const tall=$('h-hero')?.classList.contains('tall');
    if(e.deltaY>4&&tall){ e.preventDefault(); grow(false); pull=0; return; }
    if(pg.scrollTop>0||tall){ topSince=0; pull=0; return; }
    if(!topSince){ topSince=Date.now(); return; } if(Date.now()-topSince<400)return;
    if(e.deltaY<0){ pull+=-e.deltaY; clearTimeout(pullT); pullT=setTimeout(()=>{ pull=0; },500); if(pull>260){ pull=0; grow(true); } } },{passive:false});
  pg.addEventListener('touchstart',e=>{ ty=e.touches[0].clientY; },{passive:true});
  pg.addEventListener('touchmove',e=>{ if(!on()||ty==null)return; const dy=e.touches[0].clientY-ty; if(dy>120&&pg.scrollTop<=0)grow(true); else if(dy<-20)grow(false); },{passive:true});
  pg.addEventListener('scroll',()=>{ if(on())root.style.setProperty('--hs',String(Math.min(1,pg.scrollTop/320))); },{passive:true});
})();
// The day line: a thin meridian down the sidebar edge, coloured night to day to night, with a dot at the time now.
// It's the Meridian mark (a line and a dot) used as a clock.
function dayLine(){
  let d=$('dayline'); if(root.dataset.dayline!=='on'){ d?.remove(); return; }
  if(!d){ d=document.createElement('div'); d.id='dayline'; d.className='dayline'; d.innerHTML='<i class="dl-dot"></i>'; $('side').appendChild(d); }
  const sky=almanac?.items?.sky?.today||{}; const frac=(t)=>{ const m=String(t||'').match(/(\d{1,2}):(\d{2})/); return m?(+m[1]*60+ +m[2])/1440:null; };
  const now=new Date(); const f=(now.getHours()*60+now.getMinutes())/1440; const rise=frac(sky.sunrise)??.3, set=frac(sky.sunset)??.78;
  d.style.setProperty('--rise',(rise*100)+'%'); d.style.setProperty('--set',(set*100)+'%'); d.style.setProperty('--now',(f*100)+'%');
  d.dataset.tip=`${hm(now)}|${sky.sunrise?'Sunrise '+sky.sunrise+' · ':''}${sky.sunset?'sunset '+sky.sunset:''}`;
}
setInterval(dayLine,60e3);
sortable(document.body,'#h-shelf .ltile, #s-top .ltile',{axis:'x',onDrop:(ids)=>savePinOrder(mergePinOrder(ids))});
let homeRunsSig='';
function homeRuns(){ const runs=feedbackRuns().slice(0,3); const s=sig([runs.map(r=>[r.id,r.status]),runs.some(r=>r.status==='running')?Math.floor(Date.now()/60000):0]); if(s===homeRunsSig)return; if([...document.querySelectorAll('#h-runs .report')].some(r=>!r.hidden))return; homeRunsSig=s; $('h-runs').innerHTML=runs.map(runHTML).join(''); }
function homeLive(){
  const sessions=(state.ai?.sessions||[]).filter(s=>s.live); const down=downList(); const servers=groupServers(state.local?.servers||[]);
  const rings=window.feelReady&&FEEL()?feelLive():''; // lab: rings instead of dots
  const rows=[...(rings?[]:sessions).slice(0,3).map(s=>`<div class="row"><i class="dot ok pulse"></i><div class="main"><div class="t">${esc(String(s.project||'').split('/').pop()||s.tool)}</div><div class="s">${esc(cap(s.did||s.prompt||s.tool,80))}</div></div></div>`),
    ...down.map(n=>`<div class="row"><i class="dot down"></i><div class="main"><div class="t">${esc(n)}</div><div class="s">down</div></div></div>`)];
  const rv=(state.github?.reviews||[]).length; if(rv)rows.push(`<div class="row" data-go="system" style="cursor:pointer"><i class="dot warn"></i><div class="main"><div class="t">${rv} PR${rv>1?'s':''} waiting for your review</div><div class="s">GitHub</div></div></div>`);
  setHTML($('h-live'),rings+(rows.length?'<div class="rows">'+rows.join('')+'</div>':rings?'':'<div class="empty">No agents running and nothing down.</div>')+`<div style="margin-top:10px"><button class="btn sm ghost" data-go="system">${servers.length} dev server${servers.length===1?'':'s'} on this Mac</button></div>`);
}

/* ---------- AI usage maths (shared by Home and the Usage tab) ---------- */
// API value is priced in dollars because that is how the providers price it.
// Plans are paid in pounds. fx converts value to pounds for the "back" multiple.
const PROV={claude:{label:'Claude',color:'var(--claude)'},openai:{label:'ChatGPT',color:'var(--openai)'}};
const PAYER={you:{label:'You',color:'var(--you)'},work:{label:'Work',color:'var(--work)'}};
const usd=(v,{exact}={})=>{ v=Number(v)||0; if(!exact&&v>=10000)return '$'+(v/1000).toFixed(v>=100000?0:1).replace(/\.0$/,'')+'k'; if(v>=100||exact)return '$'+Math.round(v).toLocaleString('en-GB'); return '$'+v.toFixed(v<10?2:1); };
const gbp=(v,{exact}={})=>{ v=Number(v)||0; if(!exact&&v>=10000)return '£'+(v/1000).toFixed(v>=100000?0:1).replace(/\.0$/,'')+'k'; if(v>=100)return '£'+Math.round(v).toLocaleString('en-GB'); return '£'+(Math.round(v*100)/100).toFixed(v%1?2:0); };
const money=usd;
const compact=(n)=>{ n=Number(n)||0; if(n>=1e9)return (n/1e9).toFixed(n>=1e10?0:1).replace(/\.0$/,'')+'B'; if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,'')+'M'; if(n>=1e3)return (n/1e3).toFixed(n>=1e4?0:1).replace(/\.0$/,'')+'K'; return String(Math.round(n)); };
const tokTotal=(r)=>{ const t=r.tokens||{}; return t.total!=null?t.total:(t.input||0)+(t.output||0)+(t.cacheRead||0)+(t.cacheWrite||0); };
const fxRate=()=>Number(ledger?.fx?.USDGBP)||0.76;
const RANGE_DAYS={'7d':7,'30d':30,'90d':90};
function firstDay(){ const ds=[...(ledger?.rows||[]).map(r=>r.date),...(ledger?.plans||[]).flatMap(p=>(p.periods||[]).map(x=>x.from))].filter(Boolean).sort(); return ds[0]||isoDay(); }
// Inclusive [from, to] for a range, optionally the same-length window before it.
function rangeSpan(range,shift=0){
  const today=isoDay();
  if(range==='all')return {from:firstDay(),to:today};
  const n=RANGE_DAYS[range]||30; const end=new Date(Date.now()-shift*n*86400e3);
  return {from:isoDay(new Date(end.getTime()-(n-1)*86400e3)),to:isoDay(end)};
}
const daysIn=(span)=>Math.round((Date.parse(span.to)-Date.parse(span.from))/86400e3)+1;
function filterRows(rows,{range,provider,plan,shift=0}){
  const {from,to}=rangeSpan(range,shift);
  return rows.filter(r=>r.date>=from&&r.date<=to&&(provider==='all'||r.provider===provider)&&(plan==='all'||r.plan===plan));
}
function sumRows(rows){ const s={cost:0,tokens:0,input:0,output:0,cacheRead:0,cacheWrite:0,byProv:{claude:{cost:0,tokens:0},openai:{cost:0,tokens:0}}};
  for(const r of rows){ const t=tokTotal(r); s.cost+=r.cost||0; s.tokens+=t; const k=r.tokens||{}; s.input+=k.input||0; s.output+=k.output||0; s.cacheRead+=k.cacheRead||0; s.cacheWrite+=k.cacheWrite||0;
    const p=s.byProv[r.provider]||(s.byProv[r.provider]={cost:0,tokens:0}); p.cost+=r.cost||0; p.tokens+=t; }
  return s; }
// What a plan costs per day on a given date, in pounds, or null if the price is unknown.
function planDaily(p,date){
  for(const per of (p.periods||[])){ if(date<per.from||(per.to&&date>per.to))continue; if(per.amount==null)return null; const a=Number(per.amount)*(per.currency==='USD'?fxRate():1); return per.per==='year'?a/365:a*12/365; }
  return 0;
}
// Seat cost spread across the days a plan was live, so any window gets its fair share.
function planCost(p,span){ let sum=0, unknown=false; for(let t=Date.parse(span.from+'T12:00:00'),end=Date.parse(span.to+'T12:00:00');t<=end;t+=86400e3){ const d=planDaily(p,isoDay(new Date(t))); if(d==null)unknown=true; else sum+=d; } return {sum,unknown}; }
const planActiveIn=(p,span)=>(p.periods||[]).some(x=>x.from<=span.to&&(!x.to||x.to>=span.from));
const planLabel=(p)=>p?`${p.name}${p.account?' · '+p.account:''}`:'';
const planShort=(p)=>p.name==='Claude Pro'?`Claude Pro · ${String(p.account||'').replace(/^Personal \((.+)\)$/,'$1').replace(/ University$/,'')}`:p.name;
function priceLine(p){ const cur=(p.periods||[]).slice().sort((a,b)=>String(b.from).localeCompare(String(a.from)))[0]; if(!cur||cur.amount==null)return 'Price not known';
  const sym=cur.currency==='USD'?'$':'£'; return cur.per==='year'?`${sym}${cur.amount} a year (${sym}${Math.round(cur.amount/12)} a month)`:`${sym}${cur.amount} a month`; }
function homeUsage(){
  const el=$('h-usage');
  if(!ledger){ el.innerHTML=`<div class="ch">${icon('usage')}<h2>AI usage</h2></div><div class="empty">Loading…</div>`; return; }
  // The ledger changes on its own timer, not with every state event.
  const day=isoDay(); if(el.__ledger===ledger&&el.__day===day)return; el.__ledger=ledger; el.__day=day;
  const rows=filterRows(ledger.rows||[],{range:'7d',provider:'all',plan:'all'}); const s=sumRows(rows);
  const prev=sumRows(filterRows(ledger.rows||[],{range:'7d',provider:'all',plan:'all',shift:1}));
  const span=rangeSpan('7d'); const paid=(ledger.plans||[]).reduce((a,p)=>a+planCost(p,span).sum,0);
  const days=[...Array(7)].map((_,i)=>isoDay(new Date(Date.now()-(6-i)*86400e3)));
  const per=days.map(d=>({c:rows.filter(r=>r.date===d&&r.provider==='claude').reduce((a,r)=>a+(r.cost||0),0),o:rows.filter(r=>r.date===d&&r.provider==='openai').reduce((a,r)=>a+(r.cost||0),0)}));
  const max=Math.max(1,...per.map(p=>p.c+p.o));
  el.innerHTML=`<div class="ch">${icon('usage')}<h2>AI usage</h2><span class="end"><button class="btn sm ghost" data-go="usage">Open</button></span></div>
    <div class="stat"><div class="lab">Last 7 days at API prices</div><div class="val">${usd(s.cost)}</div><div class="delta">${compact(s.tokens)} tokens${paid?` · <b>${Math.round(s.cost*fxRate()/paid)}×</b> what the plans cost`:''}${deltaText(s.cost,prev.cost,'the week before')}</div></div>
    <svg viewBox="0 0 140 44" style="width:100%;height:56px;margin-top:12px" role="img" aria-label="Daily API value, last 7 days">${per.map((p,i)=>{ const x=i*20+3, w=14; const hc=p.c/max*42, ho=p.o/max*42; return `<rect x="${x}" y="${44-hc}" width="${w}" height="${hc}" rx="${Math.min(2,hc/2)}" fill="var(--claude)"/><rect x="${x}" y="${44-hc-ho}" width="${w}" height="${Math.max(0,ho-1.5)}" rx="${Math.min(2,ho/2)}" fill="var(--openai)"/>`; }).join('')}</svg>
    <div class="split" style="margin-top:8px"><span class="k"><i style="background:var(--claude)"></i>Claude <b>${usd(s.byProv.claude.cost)}</b></span><span class="k"><i style="background:var(--openai)"></i>ChatGPT <b>${usd(s.byProv.openai.cost)}</b></span></div>`;
}
function deltaText(now,before,label){ if(!before)return ''; if(before<now*0.1)return ` · up from ${usd(before)} ${label}`; const d=Math.round((now-before)/before*100); return ` · <b>${d>=0?'+':''}${d}%</b> on ${label}`; }

/* ---------- almanac ---------- */
const ALM_ORDER=['earthView','colours','typeface','sky','moon','onThisDay','picture','poem','earth','article'];
const imgUrl=(x)=>typeof x==='string'?x:(x&&x.url)||'';
function almTile(key,it){
  if(!it||it.error)return '';
  const ph=(x)=>`<div class="ph"><img alt="" loading="lazy" decoding="async" src="${esc(api(imgUrl(x)))}"></div>`;   // lazy: the almanac is usually below the fold
  switch(key){
    case 'earthView': return `<button class="alm-tile img" data-alm="earthView">${ph(it.image)}<span class="k">Earth View</span><span class="v">${esc(it.region||it.country||'Somewhere')}<small>${esc(it.region?it.country||'':'')}</small></span></button>`;
    case 'picture': return `<button class="alm-tile img" data-alm="picture">${ph(it.image)}<span class="k">Picture of the day</span><span class="v">${esc(cap(it.title,48))}</span></button>`;
    case 'earth': return `<button class="alm-tile img" data-alm="earth" style="background:#000">${ph(it.image)}<span class="k">The whole Earth</span><span class="v">${esc(it.takenAt?shortDate(Date.parse(it.takenAt)):'This week')}<small>From ${Math.round((it.distanceKm||1.5e6)/1e5)/10} million km</small></span></button>`;
    case 'colours': return `<button class="alm-tile sw" data-alm="colours"><div class="swatches">${(it.colours||[]).map(c=>`<i style="background:${esc(c.hex)}"></i>`).join('')}</div><span class="k">Colours</span><span class="v">${esc((it.colours||[]).slice(0,2).map(c=>c.name).join(' and '))}<small>Wada, no. ${esc(it.number)}</small></span></button>`;
    case 'typeface': return `<button class="alm-tile" data-alm="typeface"><span class="aa" style="font-family:'${esc(it.family)}',var(--f-body)">Aa</span><span class="k">Typeface</span><span class="v" style="font-family:'${esc(it.family)}',var(--f-body);font-size:18px">${esc(it.family)}<small style="font-family:var(--f-body)">${esc(it.category||'')}</small></span></button>`;
    case 'sky': { const n=it.now||{}, d=it.today||{};
      return `<button class="alm-tile img" data-alm="sky"><div class="sky" style="background:${skyGradient(n)}"></div><span class="k">${esc(placeName())}</span><span class="v">${n.temp!=null?Math.round(n.temp)+'° ':''}${esc(n.label||'')}<small>${d.sunset?'Sunset '+esc(d.sunset):''}${d.rainChance?` · ${d.rainChance}% rain`:''}</small></span></button>`; }
    case 'moon': return `<button class="alm-tile" data-alm="moon">${moonSVG(it,54,'moon')}<span class="k">Moon</span><span class="v">${esc(it.phase||'')}<small>${it.illumination!=null?Math.round(it.illumination)+'% lit':''}</small></span></button>`;
    case 'onThisDay': { const e=(it.events||[])[0]; if(!e)return ''; return `<button class="alm-tile" data-alm="onThisDay"><span class="k">On this day</span><span class="v" style="font-size:13.5px">${esc(e.yearLabel||e.year)}<small style="font-size:12.5px;color:var(--body)">${esc(cap(e.text,92))}</small></span></button>`; }
    case 'poem': return `<button class="alm-tile" data-alm="poem"><span class="k">A short poem</span><span class="v" style="font-family:var(--f-display);font-style:italic;font-weight:400;font-size:16px">${esc(cap(it.title,40))}<small style="font-family:var(--f-body);font-style:normal">${esc(it.author||'')}</small></span></button>`;
    case 'article': return `<button class="alm-tile" data-alm="article"><span class="k">Featured article</span><span class="v">${esc(cap(it.title,50))}</span></button>`;
  }
  return '';
}
// A sky tile tinted by the real weather in Belfast, not an illustration.
function skyGradient(n){
  const cloud=Math.min(1,(n.cloud??50)/100); const wet=['drizzle','rain','showers','storm','snow'].includes(n.kind);
  if(n.isDay===false)return wet||cloud>.7?'linear-gradient(180deg,#141821 0%,#262b37 100%)':'linear-gradient(180deg,#0a1230 0%,#1d2756 70%,#323460 100%)';
  if(wet)return 'linear-gradient(180deg,#56606e 0%,#8c96a2 100%)';
  if(cloud>.7)return 'linear-gradient(180deg,#77838f 0%,#b5bec7 100%)';
  return `linear-gradient(180deg,#2f74d0 0%,${cloud>.35?'#a9c4e0':'#8fc3f1'} 100%)`;
}
function moonSVG(it,size=54,cls=''){
  const ill=Math.max(0,Math.min(100,Number(it.illumination??50)))/100; const waxing=!!it.waxing;
  // Lit limb is a half circle; the terminator is an ellipse whose width follows the phase.
  const r=25, rx=Math.abs(1-2*ill)*r; const limb=waxing?1:0; const term=ill>.5?limb:1-limb;
  return `<svg class="${cls}" viewBox="0 0 54 54" width="${size}" height="${size}" aria-hidden="true"><circle cx="27" cy="27" r="${r}" fill="#2b2b2e"/><path d="M27 2A${r} ${r} 0 0 ${limb} 27 52A${rx} ${r} 0 0 ${term} 27 2z" fill="#ebe6d8"/></svg>`;
}
let almSig='';
function homeAlmanac(){
  const items=almanac?.items; if(!items){ $('h-alm').innerHTML='<div class="empty">The almanac arrives with the first fetch of the day.</div>'; return; }
  const heroKey={earthview:'earthView',picture:'picture',earth:'earth'}[heroNow()];
  const s=sig([almanac.date,heroKey]); if(s===almSig)return; almSig=s;
  const keys=ALM_ORDER.filter(k=>items[k]&&!items[k].error&&k!==heroKey).slice(0,6);
  $('h-alm').innerHTML=keys.map(k=>almTile(k,items[k])).join('');
  const t=items.typeface; if(t?.cssUrl&&!document.querySelector('link[data-font]')){ const l=document.createElement('link'); l.rel='stylesheet'; l.href=t.cssUrl; l.dataset.font=t.family; document.head.appendChild(l); }
}
function openAlmanac(key){
  const it=almanac?.items?.[key]; if(!it)return;
  document.getElementById('sheet-alm')?.remove();
  const box=document.createElement('div'); box.className='sheet'; box.id='sheet-alm';
  const img=(x,alt='')=>`<img alt="${esc(alt)}" src="${esc(api(imgUrl(x)))}" style="width:100%;border-radius:12px;display:block;margin-bottom:14px">`;
  const ext=(href,label)=>href?`<a href="${esc(href)}" target="_blank" rel="noopener" style="text-decoration:underline;text-underline-offset:3px">${esc(label)}</a>`:'';
  let body='';
  if(key==='earthView')body=`${img(it.image)}<p style="font-size:17px">${esc(it.place||'')}</p><p class="dim" style="margin-top:6px">${ext(it.mapUrl,'Open in Google Maps')} · ${esc(it.credit||'')}</p>`;
  else if(key==='picture')body=`${img(it.image)}<p style="font-size:17px">${esc(it.title||'')}</p><p style="margin-top:6px;color:var(--body)">${esc(it.description||'')}</p><p class="dim" style="margin-top:8px">${esc(it.attribution||'')} · ${ext(it.filePage,'Wikimedia Commons')}</p>`;
  else if(key==='earth')body=`${img(it.image)}<p>${esc(it.caption||'')}</p><p class="dim" style="margin-top:6px">Taken ${esc(it.takenAt?shortDate(Date.parse(it.takenAt))+' at '+hm(Date.parse(it.takenAt)):'')} · ${esc(it.credit||'')}</p>`;
  else if(key==='colours')body=`<div style="display:flex;height:150px;border-radius:14px;overflow:hidden;margin-bottom:14px">${(it.colours||[]).map(c=>`<div style="flex:1;background:${esc(c.hex)}"></div>`).join('')}</div><div class="rows">${(it.colours||[]).map(c=>`<div class="row"><i style="width:14px;height:14px;border-radius:4px;background:${esc(c.hex)}"></i><div class="main"><div class="t">${esc(c.name)}</div></div><button class="btn sm ghost" data-copy="${esc(c.hex)}">${esc(c.hex)}</button></div>`).join('')}</div><p class="dim" style="margin-top:12px">Combination ${esc(it.number)} from Sanzo Wada's Dictionary of Color Combinations, 1933. Pick Today's colours under Sidebar glow in Customise to wear it.</p>`;
  else if(key==='typeface')body=`<div style="font-family:'${esc(it.family)}',var(--f-body);font-size:64px;line-height:1;margin-bottom:8px">Aa Gg Rr</div><div style="font-family:'${esc(it.family)}',var(--f-body);font-size:24px;line-height:1.25;margin-bottom:14px">Sphinx of black quartz, judge my vow.</div><p><b style="font-weight:500">${esc(it.family)}</b>${it.designer?' by '+esc(it.designer):''} · ${esc(it.category||'')}</p><p class="dim" style="margin-top:6px">${esc(it.note||'')} ${ext(it.specimenUrl,'Google Fonts')}</p>`;
  else if(key==='sky'){ const n=it.now||{}, d=it.today||{}; body=`<div style="height:120px;border-radius:14px;background:${skyGradient(n)};margin-bottom:14px"></div><p style="font-size:20px">${esc(it.summary||'')}</p><p class="dim" style="margin-top:6px">${[d.sunrise?'Sunrise '+d.sunrise:'',d.sunset?'Sunset '+d.sunset:'',d.daylight?d.daylight+' of daylight':'',it.tomorrow?.label?'Tomorrow: '+String(it.tomorrow.label).toLowerCase()+(it.tomorrow.rainChance?`, ${it.tomorrow.rainChance}% chance of rain`:''):''].filter(Boolean).map(esc).join(' · ')}</p>
    ${(it.hours||[]).length?`<div style="display:flex;gap:6px;margin-top:14px;overflow:auto">${it.hours.map(h=>`<div style="min-width:52px;text-align:center;padding:8px 4px;border-radius:10px;background:var(--well)"><div class="mono dim">${esc(h.time)}</div><div style="font-weight:500;margin-top:4px">${Math.round(h.temp)}°</div><div class="dim" style="font-size:11px">${h.rainChance?h.rainChance+'%':''}</div></div>`).join('')}</div>`:''}`; }
  else if(key==='moon')body=`<div style="display:flex;gap:20px;align-items:center">${moonSVG(it,110)}<div><p style="font-size:20px">${esc(it.phase||'')}</p><p class="dim">${Math.round(it.illumination)}% lit · ${Number(it.age).toFixed(1)} days old</p><p class="dim">${it.nextFull?'Full moon '+esc(shortDate(Date.parse(it.nextFull.date))):''}${it.nextNew?' · new moon '+esc(shortDate(Date.parse(it.nextNew.date))):''}</p></div></div>`;
  else if(key==='onThisDay')body=`<div class="rows">${(it.events||[]).map(e=>`<a class="row" href="${esc(e.link||'#')}" target="_blank" rel="noopener" style="align-items:flex-start"><span class="due-n" style="min-width:64px">${esc(e.yearLabel||e.year)}</span><div class="main"><div style="white-space:normal">${esc(e.text)}</div></div></a>`).join('')}</div><p class="dim" style="margin-top:10px">${esc(it.credit||'')}</p>`;
  else if(key==='poem')body=`<p style="font-family:var(--f-display);font-style:italic;font-size:24px;margin-bottom:12px">${esc(it.title)}</p><div style="white-space:pre-line;font-size:15.5px;line-height:1.75;color:var(--body)">${esc((it.lines||[]).join('\n'))}</div><p class="dim" style="margin-top:12px">${esc(it.credit||it.author||'')}</p>`;
  else if(key==='article')body=`${it.image?img(it.image):''}<p style="font-size:17px">${esc(it.title)}</p><p style="margin-top:6px;color:var(--body)">${esc(it.extract||'')}</p><p style="margin-top:8px">${ext(it.link,'Read on Wikipedia')}</p>`;
  const titles={earthView:'Earth View',picture:'Picture of the day',earth:'The whole Earth',colours:"Today's colours",typeface:'Typeface of the day',sky:placeName()+' sky',moon:'The moon',onThisDay:'On this day',poem:'A short poem',article:'Featured article'};
  box.innerHTML=`<h3>${esc(titles[key]||'Almanac')}<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>${body}`;
  box.addEventListener('click',async e=>{ const c=e.target.closest('[data-copy]'); if(c){ try{ await navigator.clipboard.writeText(c.dataset.copy); toast('Copied '+c.dataset.copy); }catch{} } });
  document.body.appendChild(box); openSheet('sheet-alm');
}

/* SHELF. Links with previews; the top shelf is what he reaches for daily. */
let shelfQ='', shelfSig='';
const shelfClosed=new Set(JSON.parse(localStorage.getItem('meridian.cc.closedGroups')||'[]'));
VIEWS.shelf={
  mount(el){
    el.innerHTML=`<div class="vhead"><div><h1>Shelf</h1><p>Everything you keep coming back to. The top shelf is for the ones you open every day. Paste or drop a URL anywhere to add it.</p></div>
      <div class="vtools"><label class="shelf-search">${icon('search')}<input id="s-q" placeholder="Search the shelf" autocomplete="off"></label><button class="btn primary" id="s-add">${icon('plus')}Add a link</button></div></div>
      <div class="s-space" id="s-space"></div><div class="sec-h" style="margin-top:6px"><h3>Top shelf</h3><span class="sub desk-only">Drag to reorder. Right-click for more.</span></div><div class="shelf-top" id="s-top"></div>
      <div id="s-lately-w"><div class="sec-h"><h3>Lately</h3><span class="sub">Opened recently, not on the top shelf</span></div><div class="shelf-sm" id="s-lately"></div></div>
      <div id="s-groups"></div>
      <div id="s-live-w"><div class="sec-h"><h3>Live on this Mac</h3><span class="sub">Dev servers running right now. Save one to keep it.</span></div><div class="shelf-sm" id="s-live"></div></div>`;
    $('s-q').addEventListener('input',e=>{ shelfQ=e.target.value; shelfSig=''; VIEWS.shelf.update(); });
    $('s-q').addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.target.value=''; shelfQ=''; shelfSig=''; VIEWS.shelf.update(); e.target.blur(); } if(e.key==='Enter'){ const first=el.querySelector('.ltile'); const l=first&&links.links.find(x=>x.id===first.dataset.id); if(l)openLink(l); } });
    $('s-add').addEventListener('click',()=>openLinkSheet({}));
    ['s-top','s-lately','s-groups'].forEach(id=>bindShelfTiles($(id)));
    $('s-groups').addEventListener('click',e=>{ if(dragJustEnded())return; const m=e.target.closest('[data-group-menu]'); if(m){ const r=m.getBoundingClientRect(); groupMenu(r.left,r.bottom+6,m.dataset.groupMenu); return; }
      const t=e.target.closest('[data-group-tog]'); if(!t)return; const g=t.dataset.groupTog; shelfClosed.has(g)?shelfClosed.delete(g):shelfClosed.add(g); localStorage.setItem('meridian.cc.closedGroups',JSON.stringify([...shelfClosed])); shelfSig=''; VIEWS.shelf.update(); });
    $('s-groups').addEventListener('contextmenu',e=>{ const h=e.target.closest('.group-h'); if(!h)return; e.preventDefault(); groupMenu(e.clientX,e.clientY,h.parentElement.dataset.key); });
    sortable($('s-groups'),'.grp',{axis:'y',handle:'.group-h .grab',onDrop:saveGroupOrder});
  },
  update(){
    const q=shelfQ.trim().toLowerCase();
    const match=(l)=>!q||[l.title,l.url,l.note,l.category,...(l.tags||[])].join(' ').toLowerCase().includes(q);
    const sp=activeSpace(); const all=(links.links||[]).filter(match).filter(l=>q||inSpace(l));
    const servers=liveServers();
    $('s-space').innerHTML=sp&&!q?`<span class="spnote" style="--c:${esc(spColor(sp))}"><i></i>${esc(sp.name)} space</span><button type="button" class="btn sm ghost" data-space="all">Show everything</button>`:'';
    const s=sig([q,spaceId,all.map(l=>[l.id,l.title,l.pinned,l.pinOrder,l.category,l.health&&l.health.up,l.lastOpened]),links.categories,servers.map(x=>[x.port,x.title,x.shareUrl]),[...shelfClosed]]);
    if(s===shelfSig)return; shelfSig=s;
    const top=topShelf().filter(match).filter(l=>q||inSpace(l));
    $('s-top').innerHTML=top.map(l=>tileHTML(l)).join('')+(q?'':`<button class="shelf-drop" id="s-top-add">${icon('plus')}&nbsp; Add to the top shelf</button>`);
    $('s-top-add')?.addEventListener('click',()=>openLinkSheet({pinned:true}));
    const lately=all.filter(l=>!l.pinned&&l.lastOpened).sort((a,b)=>String(b.lastOpened).localeCompare(String(a.lastOpened))).slice(0,6);
    // Lately only earns its row once the shelf is big enough that recent things get lost in the groups.
    $('s-lately-w').hidden=!lately.length||!!q||all.filter(l=>!l.pinned).length<10; $('s-lately').innerHTML=lately.map(l=>tileHTML(l,{small:true})).join('');
    const groups=new Map(); for(const l of all.filter(l=>!l.pinned||q)){ const g=l.category||'Other'; if(!groups.has(g))groups.set(g,[]); groups.get(g).push(l); }
    const order=[...(links.categories||[]),...[...groups.keys()].filter(g=>!(links.categories||[]).includes(g))];
    $('s-groups').innerHTML=order.filter(g=>groups.has(g)).map(g=>{ const list=groups.get(g).sort((a,b)=>(b.opens||0)-(a.opens||0)||a.title.localeCompare(b.title)); const closed=shelfClosed.has(g)&&!q;
      return `<section class="grp" data-key="${esc(g)}"><div class="group-h${closed?' closed':''}"><span class="grab" data-tip="Drag to reorder groups">${icon('grip')}</span><button class="tog" data-group-tog="${esc(g)}">${icon('chev')}<b>${esc(g)}</b><span class="n">${list.length}</span></button><button class="ibtn gm" data-group-menu="${esc(g)}" aria-label="Group options" data-tip="Rename or remove">${icon('dots')}</button></div>${closed?'':`<div class="shelf-sm">${list.map(l=>tileHTML(l,{small:true})).join('')}</div>`}</section>`; }).join('')
      ||(q?`<div class="empty" style="margin-top:20px">Nothing on the shelf matches "${esc(shelfQ)}".</div>`:'');
    $('s-live-w').hidden=!!q||!servers.length;
    $('s-live').innerHTML=servers.map(sv=>`<a class="ltile sm" href="${esc(serverUrl(sv))}" target="_blank" rel="noopener" data-port="${sv.port}"><div class="shot"><span class="big-mark">:${sv.port}</span>${state?.capabilities?.previews!==false?shot(api('/api/preview?port='+sv.port)):''}<span class="status"><i class="dot ${sv.shareUrl||!homeOnly(sv)?'ok':''}"></i>${sv.shareUrl?'On Tailscale':homeOnly(sv)?'Home Mac only':'Tailnet'}</span></div><div class="lb"><span class="mono-mark fav" style="font-size:9px">${sv.port}</span><div class="lt"><b>${esc(sv.title&&!/^Directory listing/i.test(sv.title)?sv.title:serverName(sv))}</b><span>${esc(sv.project||'')}</span></div></div><div class="hover-acts">${sv.shareUrl?`<button type="button" data-sact="copy" aria-label="Copy Tailscale link" data-tip="Copy Tailscale link">${icon('copy')}</button>`:`<button type="button" data-sact="share" aria-label="Put on Tailscale" data-tip="Put on Tailscale">${icon('share')}</button>`}<button type="button" data-sact="save" aria-label="Save to the shelf" data-tip="Save to the shelf">${icon('plus')}</button><button type="button" data-sact="stop" aria-label="Stop it" data-tip="Stop it">${icon('close')}</button></div></a>`).join('');
  },
};

async function saveGroupOrder(ids){ const cats=[...ids,...(links.categories||[]).filter(c=>!ids.includes(c))]; links.categories=cats; shelfSig=''; VIEWS.shelf.update(true); try{ await send('/api/links/categories',{categories:cats},'PUT'); }catch(err){ toast(err.message); loadLinks(); } }
// Rename in place: the group title becomes a field. Enter saves, Escape puts it back.
function renameGroupInline(g){
  const sec=[...document.querySelectorAll('#s-groups .grp')].find(x=>x.dataset.key===g); const b=sec?.querySelector('.tog b'); if(!b)return;
  const inp=document.createElement('input'); inp.value=g; inp.className='grp-rename'; inp.setAttribute('aria-label','Group name'); b.replaceWith(inp); inp.focus(); inp.select();
  let done=false; const finish=async(save)=>{ if(done)return; done=true; const to=inp.value.trim(); if(!save||!to||to===g){ shelfSig=''; VIEWS.shelf.update(true); return; }
    try{ await send('/api/links/rename-category',{from:g,to}); toast(`Renamed to ${to}`); }catch(err){ toast(err.message); } loadLinks(); };
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter')finish(true); if(e.key==='Escape')finish(false); });
  inp.addEventListener('click',e=>e.stopPropagation()); inp.addEventListener('blur',()=>finish(true));
}
function groupMenu(x,y,g){
  menu(x,y,[
    {label:'Rename group',icon:'edit',act:()=>renameGroupInline(g)},
    {label:'Move to the top',icon:'up',act:()=>saveGroupOrder([g,...(links.categories||[]).filter(c=>c!==g)])},
    'hr',
    {label:'Remove group',icon:'trash',danger:true,act:async()=>{ const n=(links.links||[]).filter(l=>(l.category||'Other')===g).length; if(n&&!confirm(`Remove "${g}"? Its ${n} link${n>1?'s':''} move to Other.`))return; try{ await send('/api/links/remove-category',{name:g,moveTo:'Other'}); toast(`Removed ${g}`); loadLinks(); }catch(err){ toast(err.message); } }},
  ]);
}

/* AI USAGE. Three questions: what the plans cost and who pays, what the same
   work would cost at API prices, and where the tokens went. */
let uRange=localStorage.getItem('meridian.cc.uRange')||'30d', uProv='all', uPayer=localStorage.getItem('meridian.cc.uPayer')||'all', uPlan='all', uMetric='cost', uTable=false, uPayAll=false;
VIEWS.usage={
  mount(el){
    el.innerHTML=`<div class="vhead"><div><h1>AI usage</h1><p>What your plans cost, what the same work would cost at API prices, and where the tokens went.</p></div><div class="vtools"><button class="btn ghost" id="u-refresh">${icon('refresh')}<span>Rescan both Macs</span></button><button class="btn ghost" id="u-plans">${icon('edit')}Plans</button></div></div>
      <div class="ufilters" id="u-filters"></div><div class="ufilters" id="u-planrow"></div>
      <div class="grid" id="u-body"></div>`;
    el.addEventListener('click',e=>{ const b=e.target.closest('[data-f]'); if(!b)return; const [k,v]=b.dataset.f.split(':');
      if(k==='range'){ uRange=v; localStorage.setItem('meridian.cc.uRange',v); } if(k==='prov')uProv=v; if(k==='payer'){ uPayer=v; localStorage.setItem('meridian.cc.uPayer',v); } if(k==='plan')uPlan=v; VIEWS.usage.update(); });
    $('u-refresh').addEventListener('click',async()=>{ const b=$('u-refresh'); b.disabled=true; b.querySelector('span').textContent='Rescanning…';
      try{ await send('/api/ai-usage/refresh',{}); toast('Rescanning both Macs. This takes a minute.'); }catch{ await loadLedger(true); }
      setTimeout(async()=>{ await loadLedger(true); b.disabled=false; b.querySelector('span').textContent='Rescan both Macs'; },45000); });
    $('u-plans').addEventListener('click',openPlansSheet);
    $('u-body').addEventListener('click',e=>{ const m=e.target.closest('[data-metric]'); if(m){ uMetric=m.dataset.metric; VIEWS.usage.update(); } if(e.target.closest('[data-utable]')){ uTable=!uTable; VIEWS.usage.update(); } if(e.target.closest('[data-payall]')){ uPayAll=!uPayAll; VIEWS.usage.update(); } const pc=e.target.closest('[data-plancard]'); if(pc&&!e.target.closest('button')){ uPlan=uPlan===pc.dataset.plancard?'all':pc.dataset.plancard; VIEWS.usage.update(); } });
  },
  update(){
    if(!ledger){ $('u-body').innerHTML='<div class="c12 empty">Reading your usage…</div>'; return; }
    const allPlans=(ledger.plans||[]).filter(p=>(uProv==='all'||p.provider===uProv)&&(uPayer==='all'||p.payer===uPayer));
    if(uPlan!=='all'&&!allPlans.some(p=>p.id===uPlan))uPlan='all';
    const plans=allPlans.filter(p=>uPlan==='all'||p.id===uPlan);
    const seg=(k,opts,cur)=>`<div class="seg" role="group">${opts.map(([v,l])=>`<button type="button" data-f="${k}:${v}" aria-pressed="${v===cur}">${l}</button>`).join('')}</div>`;
    $('u-filters').innerHTML=seg('range',[['7d','7 days'],['30d','30 days'],['90d','3 months'],['all','All time']],uRange)+seg('prov',[['all','Both'],['claude','Claude'],['openai','ChatGPT']],uProv)+seg('payer',[['all','Everyone'],['work','Work'],['you','Mine']],uPayer);
    const order=(p)=>(p.status==='ended'?1:0);
    $('u-planrow').innerHTML=allPlans.length?[`<button type="button" class="chip" data-f="plan:all" aria-pressed="${uPlan==='all'}">All plans</button>`,...allPlans.slice().sort((a,b)=>order(a)-order(b)).map(p=>`<button type="button" class="chip${p.status==='ended'?' ended':''}" data-f="plan:${esc(p.id)}" aria-pressed="${p.id===uPlan}"><i class="sw" style="background:${PROV[p.provider]?.color}"></i>${esc(planShort(p))}<span class="c">${p.payer==='work'?'work':p.status==='ended'?'ended':'you'}</span></button>`)].join(''):'';
    const span=rangeSpan(uRange), prevSpan=rangeSpan(uRange,1), nDays=daysIn(span);
    const payerOk=(r)=>uPayer==='all'||allPlans.some(p=>p.id===r.plan);
    const rows=filterRows(ledger.rows||[],{range:uRange,provider:uProv,plan:uPlan}).filter(payerOk); const s=sumRows(rows);
    const prev=uRange==='all'?null:sumRows(filterRows(ledger.rows||[],{range:uRange,provider:uProv,plan:uPlan,shift:1}).filter(payerOk));
    const costs=plans.map(p=>({p,...planCost(p,span)})); const you=costs.filter(c=>c.p.payer==='you').reduce((a,c)=>a+c.sum,0), work=costs.filter(c=>c.p.payer==='work').reduce((a,c)=>a+c.sum,0);
    const paid=you+work; const valueGBP=s.cost*fxRate(); const back=paid?valueGBP/paid:null; const unknown=costs.some(c=>c.unknown&&planActiveIn(c.p,span));
    const label={'7d':'the last 7 days','30d':'the last 30 days','90d':'the last 3 months','all':'all time'}[uRange];
    const prevLabel={'7d':'the week before','30d':'the 30 days before','90d':'the 3 months before'}[uRange]||'';
    const provs=uProv==='all'?['claude','openai']:[uProv];
    const out=[];
    out.push(`<section class="card c5 stat"><div class="lab">At API prices, ${label}</div><div class="val big">${usd(s.cost)}</div><div class="delta">About ${gbp(valueGBP)}${prev?deltaText(s.cost,prev.cost,prevLabel):''}</div>
      <div class="split">${provs.map(p=>`<span class="k"><i style="background:${PROV[p].color}"></i>${PROV[p].label} <b>${usd(s.byProv[p]?.cost||0)}</b></span>`).join('')}</div></section>`);
    out.push(`<section class="card c7"><div class="paidgrid">
      <div class="stat"><div class="lab">Plans cost</div><div class="val">${gbp(paid)}</div><div class="delta">${unknown?'Some seat prices unknown · ':''}${nDays} day${nDays>1?'s':''}, spread evenly</div>
        <div class="split">${['you','work'].map(k=>`<span class="k"><i style="background:${PAYER[k].color}"></i>${k==='you'?'You paid':'Work pays'} <b>${gbp(k==='you'?you:work)}</b></span>`).join('')}</div></div>
      <div class="stat"><div class="lab">Value back</div><div class="val">${back?(back>=10?Math.round(back):back.toFixed(1))+'×':'–'}</div><div class="delta">${back?`Every £1 on plans did ${gbp(back)} of API work`:'Add plan prices to see this'}</div></div></div>
      ${paid?`<div class="vsbar" role="img" aria-label="Plans against API value" title="Plans ${gbp(paid)} against ${gbp(valueGBP)} of API value"><span style="width:${Math.max(1.5,Math.min(100,paid/Math.max(valueGBP,paid)*100)).toFixed(2)}%"></span></div><div class="vscap"><span>Plans ${gbp(paid)}</span><span>API value ${gbp(valueGBP)}</span></div>`:''}</section>`);
    out.push(`<section class="card c8"><div class="ch">${icon('chart')}<h2>${uMetric==='cost'?'Daily value':'Daily tokens'}</h2><span class="sub">${uRange==='all'&&nDays>120?'by week':'by day'}</span><span class="end"><div class="seg"><button type="button" data-metric="cost" aria-pressed="${uMetric==='cost'}">Value</button><button type="button" data-metric="tokens" aria-pressed="${uMetric==='tokens'}">Tokens</button></div><button class="ibtn${uTable?' on':''}" data-utable aria-pressed="${uTable}" title="Show as a table" aria-label="Show as a table">${icon('table')}</button></span></div>${uTable?usageTable(rows):`<div class="chart" id="u-chart"></div>`}</section>`);
    out.push(`<section class="card c4"><div class="ch">${icon('sparkle')}<h2>Worth knowing</h2></div>${insightsHTML(rows,s,costs,span)}</section>`);
    out.push(`<section class="c12"><div class="sec-h" style="margin-top:12px"><h3>Plans</h3><span class="sub">Click one to filter everything to it</span><span class="end"><button class="btn sm ghost" onclick="openPlansSheet()">${icon('edit')}Edit prices</button></span></div><div class="plangrid">${allPlans.slice().sort((a,b)=>order(a)-order(b)||(b.payer==='work')-(a.payer==='work')).map(p=>planCard(p,span)).join('')||'<div class="empty">No plans yet.</div>'}</div></section>`);
    out.push(`<section class="card c7"><div class="ch">${icon('agent')}<h2>By model</h2><span class="sub">${s.cost?'share of API value':''}</span></div>${modelTable(rows,s)}</section>`);
    out.push(`<section class="card c5">${mixHTML(s)}</section>`);
    out.push(`<section class="card c7"><div class="ch">${icon('usage')}<h2>Spend by month</h2><span class="sub">what the plans cost, ${uPlan==='all'?'all plans':esc(planShort(plans[0]||{}))}</span></div><div class="chart" id="u-months" style="height:210px"></div><div class="split" style="margin-top:12px">${['you','work'].map(k=>`<span class="k"><i style="background:${PAYER[k].color}"></i>${k==='you'?'You':'Work'}</span>`).join('')}</div></section>`);
    out.push(`<section class="card c5"><div class="ch">${icon('report')}<h2>Receipts</h2><span class="sub">verified payments</span></div>${paymentsHTML(plans)}</section>`);
    const h=ledger.history;
    out.push(`<div class="c12 srcline">${h?`<span><i class="dot ${h.running?'warn':'ok'}"></i>${h.running?'Rescanning now':'History'}${h.lastRun?' · last scan '+esc(ago(Date.parse(h.lastRun))):''}</span>${Object.entries(h.machines||{}).map(([m,x])=>`<span><i class="dot ${x.error?'down':'ok'}"></i>${esc(m)} Mac${x.lastSuccess?' · scanned '+esc(ago(Date.parse(x.lastSuccess))):''}${x.error?' · '+esc(cap(x.error,60)):''}</span>`).join('')}`:''}
      ${(ledger.sources||[]).filter(x=>!h||x.error).map(x=>`<span><i class="dot ${x.error?'down':'ok'}"></i>${esc(x.label||x.id)}${x.through?' · through '+esc(shortDate(Date.parse(x.through))):''}${x.error?' · '+esc(x.error):''}</span>`).join('')}
      <span>$1 = £${fxRate().toFixed(3)}${ledger.fx?.date?' on '+esc(shortDate(Date.parse(ledger.fx.date))):''}</span>${DEMO?'':`<span><a href="/downloads/ai-usage-2026/index.html" style="text-decoration:underline;text-underline-offset:3px">Sol's 2026 report</a></span>`}</div>`);
    $('u-body').innerHTML=out.join('');
    if(!uTable)drawUsageChart($('u-chart'),rows,provs,span);
    drawMonths($('u-months'),plans);
  },
};
function planCard(p,span){
  const rows=(ledger.rows||[]).filter(r=>r.plan===p.id); const inRange=rows.filter(r=>r.date>=span.from&&r.date<=span.to);
  const v=inRange.reduce((a,r)=>a+(r.cost||0),0); const t=inRange.reduce((a,r)=>a+tokTotal(r),0); const c=planCost(p,span);
  const last=rows.map(r=>r.date).sort().pop(); const back=c.sum?v*fxRate()/c.sum:null;
  const live=planActiveIn(p,span);
  return `<article class="plancard${uPlan===p.id?' on':''}${p.status==='ended'?' ended':''}" data-plancard="${esc(p.id)}" tabindex="0">
    <div class="pc-h"><i style="background:${PROV[p.provider]?.color}"></i><b>${esc(p.name)}</b><span class="tag ${p.payer==='work'?'work-pay':'you-pay'}">${p.payer==='work'?'Work pays':'You pay'}</span></div>
    <div class="pc-a">${esc(p.account||'')} · <b style="font-weight:500;color:var(--body)">${esc(priceLine(p))}</b>${p.status==='ended'?' · ended':''}</div>
    <div class="pc-v">${live&&(v||c.sum)?`<span><b>${usd(v)}</b> API value</span><span><b>${c.unknown&&!c.sum?'?':gbp(c.sum)}</b> paid</span>${back?`<span><b>${back>=10?Math.round(back):back.toFixed(1)}×</b> back</span>`:''}`:'<span class="dim">Nothing in this range</span>'}</div>
    <div class="pc-f">${live&&c.sum?`In ${esc(rangeWords())}`:''}${t?(live&&c.sum?' · ':'')+compact(t)+' tokens':''}${last?' · last used '+esc(shortDate(Date.parse(last))):/ulster/i.test(p.account||'')?' · web only':''}</div></article>`;
}
const rangeWords=()=>({'7d':'the last 7 days','30d':'the last 30 days','90d':'the last 3 months','all':'all, since February'}[uRange]);
function insightsHTML(rows,s,costs,span){
  const tips=[]; const today=isoDay(); const month=isoDay(new Date(Date.now()-29*86400e3));
  for(const p of (ledger.plans||[])){ if(p.payer!=='you'||p.status==='ended')continue; const used=(ledger.rows||[]).filter(r=>r.plan===p.id).map(r=>r.date).sort().pop();
    if(!used||used<month){ const pr=priceLine(p); tips.push(`<b>${esc(planShort(p))}</b> is still billed (${esc(pr.toLowerCase())}) but ${used?`hasn't been used by your agents since ${esc(shortDate(Date.parse(used)))}`:'has no agent usage on record'}. Worth cancelling, unless you use it on the web.`); } }
  const wk=(ledger.plans||[]).filter(p=>p.payer==='work'); if(wk.length){ const sp={from:month,to:today}; const wv=(ledger.rows||[]).filter(r=>r.date>=month&&wk.some(p=>p.id===r.plan)).reduce((a,r)=>a+(r.cost||0),0); const wc=wk.reduce((a,p)=>a+planCost(p,sp).sum,0);
    if(wv&&wc)tips.push(`In the last 30 days your work seats did <b>${usd(wv)}</b> of API work for about <b>${gbp(wc)}</b>. That's ${Math.round(wv*fxRate()/wc)}× what ${DEMO?'work':'Example Agency'} pays.`); }
  const by=new Map(); rows.forEach(r=>{ if(r.model)by.set(r.model,(by.get(r.model)||0)+(r.cost||0)); }); const top=[...by].sort((a,b)=>b[1]-a[1])[0];
  if(top&&s.cost)tips.push(`<b>${esc(ledger.models?.[top[0]]?.label||top[0])}</b> is ${Math.round(top[1]/s.cost*100)}% of the value in this range.`);
  const days=new Map(); rows.forEach(r=>days.set(r.date,(days.get(r.date)||0)+(r.cost||0))); const best=[...days].sort((a,b)=>b[1]-a[1])[0];
  if(best)tips.push(`Busiest day: <b>${esc(DAYS[new Date(best[0]+'T12:00').getDay()])} ${esc(shortDate(Date.parse(best[0])))}</b>, ${usd(best[1])} at API prices.`);
  return tips.length?'<ul class="tips">'+tips.slice(0,4).map(t=>`<li>${t}</li>`).join('')+'</ul>':'<div class="empty">Nothing stands out yet.</div>';
}
function bucketRows(rows,provs,span){
  const days=[]; for(let t=Date.parse(span.from+'T12:00:00'),end=Date.parse(span.to+'T12:00:00');t<=end;t+=86400e3)days.push(isoDay(new Date(t)));
  const weekly=days.length>120; const val=(r)=>uMetric==='cost'?(r.cost||0):tokTotal(r);
  const keyOf=(d)=>{ if(!weekly)return d; const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()-((x.getDay()+6)%7)); return isoDay(x); };
  const map=new Map(), buckets=[];
  for(const d of days){ const k=keyOf(d); if(!map.has(k)){ const b={key:k,weekly,v:{}}; provs.forEach(p=>b.v[p]=0); map.set(k,b); buckets.push(b); } }
  for(const r of rows){ const b=map.get(keyOf(r.date)); if(b&&b.v[r.provider]!=null)b.v[r.provider]+=val(r); }
  return buckets;
}
function niceMax(v){ if(v<=0)return 1; const p=Math.pow(10,Math.floor(Math.log10(v))); const n=v/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
// Stacked columns: 2px surface gap between segments, 4px rounded data-end on top, square at the baseline.
function stackedColumns(host,buckets,series,{fmt,label,tipTitle}){
  const W=Math.max(320,host.clientWidth), H=host.clientHeight||230, padL=48, padB=24, padT=8;
  const tot=buckets.map(x=>series.reduce((a,s)=>a+(x.v[s.key]||0),0)); const max=niceMax(Math.max(...tot,0));
  const iw=W-padL-6, ih=H-padB-padT; const bw=iw/Math.max(1,buckets.length); const w=Math.max(2,Math.min(24,bw*.7));
  const ticks=[0,.5,1].map(f=>f*max);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><g class="grid">${ticks.map(t=>`<line x1="${padL}" x2="${W-6}" y1="${padT+ih-t/max*ih}" y2="${padT+ih-t/max*ih}"/>`).join('')}</g><g class="axis">${ticks.map(t=>`<text x="${padL-8}" y="${padT+ih-t/max*ih+3}" text-anchor="end">${fmt(t)}</text>`).join('')}`;
  const every=Math.ceil(buckets.length/7);
  // Every nth tick, plus the last one unless it would sit on top of the one before.
  buckets.forEach((x,i)=>{ const last=i===buckets.length-1; if(i%every===0&&!(i>0&&!last&&buckets.length-1-i<every*.6)||last)svg+=`<text x="${padL+i*bw+bw/2}" y="${H-6}" text-anchor="${last&&buckets.length>8?'end':'middle'}">${esc(x.tick)}</text>`; });
  svg+='</g><g>';
  buckets.forEach((x,i)=>{ const cx=padL+i*bw+(bw-w)/2; let y=padT+ih; const segs=series.filter(s=>(x.v[s.key]||0)>0);
    svg+=`<g class="col" data-i="${i}">`;
    segs.forEach((s,si)=>{ const h=x.v[s.key]/max*ih; const gap=si>0?2:0; const hh=Math.max(0,h-gap); y-=h; const top=si===segs.length-1; const r=top?Math.min(4,hh/2,w/2):0; const bottom=y+h-gap;
      svg+=r?`<path d="M${cx} ${bottom}V${y+r}a${r} ${r} 0 0 1 ${r}-${r}h${w-2*r}a${r} ${r} 0 0 1 ${r} ${r}V${bottom}z" fill="${s.color}"/>`:`<rect x="${cx}" y="${y}" width="${w}" height="${hh}" fill="${s.color}"/>`; });
    svg+=`<rect class="hit" x="${padL+i*bw}" y="${padT}" width="${bw}" height="${ih}"/></g>`; });
  host.innerHTML=svg+'</g></svg>';
  const tip=$('tip');
  host.querySelectorAll('.col').forEach(g=>{
    const show=(ev)=>{ const x=buckets[Number(g.dataset.i)]; host.querySelectorAll('.col').forEach(c=>c.classList.toggle('dim',c!==g));
      const lines=(x.lines||series.map(s=>({color:s.color,label:s.label,v:x.v[s.key]||0}))).filter(l=>l.v||!x.lines);
      tip.innerHTML=`<div class="d">${esc(tipTitle(x))}</div>`+lines.map(l=>`<div class="l"><i style="background:${l.color}"></i><b>${fmt(l.v,true)}</b><span>${esc(l.label)}</span></div>`).join('')+(series.length>1?`<div class="l"><i style="background:transparent"></i><b>${fmt(series.reduce((a,s)=>a+(x.v[s.key]||0),0),true)}</b><span>Total</span></div>`:'');
      tip.classList.add('on'); const tw=tip.offsetWidth, th=tip.offsetHeight; const r=g.getBoundingClientRect(); const px=ev.clientX||r.left+r.width/2, py=ev.clientY||r.top;
      tip.style.left=Math.min(innerWidth-tw-10,px+14)+'px'; tip.style.top=Math.max(10,py-th-12)+'px'; };
    g.addEventListener('pointermove',show); g.addEventListener('pointerenter',show);
    g.addEventListener('pointerleave',()=>{ tip.classList.remove('on'); host.querySelectorAll('.col').forEach(c=>c.classList.remove('dim')); });
  });
}
function drawUsageChart(host,rows,provs,span){
  const b=bucketRows(rows,provs,span);
  b.forEach(x=>{ const d=new Date(x.key+'T12:00:00'); x.tick=b.length<=8?DAYS[d.getDay()].slice(0,3):`${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`; });
  const fmt=uMetric==='cost'?(v)=>usd(v):(v)=>compact(v);
  stackedColumns(host,b,provs.map(p=>({key:p,label:PROV[p].label,color:PROV[p].color})),{fmt,label:uMetric==='cost'?'API value by provider':'Tokens by provider',tipTitle:(x)=>{ const d=new Date(x.key+'T12:00:00'); return `${x.weekly?'Week of ':''}${DAYS[d.getDay()].slice(0,3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`; }});
}
function drawMonths(host,plans){
  if(!host)return; if(!plans.length){ host.innerHTML='<div class="empty">No plans to show.</div>'; return; }
  const start=firstDay().slice(0,7); const months=[]; for(let d=new Date(start+'-01T12:00:00');isoDay(d).slice(0,7)<=isoDay().slice(0,7);d.setMonth(d.getMonth()+1))months.push(isoDay(d).slice(0,7));
  const buckets=months.map(m=>{ const from=m+'-01'; const endD=new Date(from+'T12:00:00'); endD.setMonth(endD.getMonth()+1); endD.setDate(0); const to=isoDay(endD)<isoDay()?isoDay(endD):isoDay();
    const v={you:0,work:0}; const lines=[]; for(const p of plans){ const c=planCost(p,{from,to}).sum; if(c){ v[p.payer==='work'?'work':'you']+=c; lines.push({color:PAYER[p.payer==='work'?'work':'you'].color,label:planShort(p),v:c}); } }
    return {key:m,v,lines,tick:MONTHS[Number(m.slice(5))-1].slice(0,3),partial:to===isoDay()}; });
  stackedColumns(host,buckets,[{key:'you',label:'You',color:PAYER.you.color},{key:'work',label:'Work',color:PAYER.work.color}],{fmt:(v,exact)=>gbp(v,{exact}),label:'Plan cost by month, you and work',tipTitle:(x)=>`${MONTHS[Number(x.key.slice(5))-1]} ${x.key.slice(0,4)}${x.partial?', so far':''}`});
}
function usageTable(rows){
  const days=[...new Set(rows.map(r=>r.date))].sort().reverse();
  return `<div style="max-height:260px;overflow:auto"><table class="mtable"><thead><tr><th>Day</th><th class="num">Claude</th><th class="num">ChatGPT</th><th class="num">Tokens</th></tr></thead><tbody>${days.map(d=>{ const dr=rows.filter(r=>r.date===d); const c=dr.filter(r=>r.provider==='claude').reduce((a,r)=>a+(r.cost||0),0), o=dr.filter(r=>r.provider==='openai').reduce((a,r)=>a+(r.cost||0),0);
    return `<tr><td>${esc(shortDate(Date.parse(d)))}</td><td class="num">${usd(c)}</td><td class="num">${usd(o)}</td><td class="num">${compact(dr.reduce((a,r)=>a+tokTotal(r),0))}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function mixHTML(s){
  const parts=[['Cache reads',s.cacheRead],['Cache writes',s.cacheWrite],['Input',s.input],['Output',s.output]];
  const tot=parts.reduce((a,[,v])=>a+v,0);
  if(!tot)return `<div class="ch">${icon('sparkle')}<h2>Token mix</h2></div><div class="empty">No token split for this range.</div>`;
  return `<div class="ch">${icon('sparkle')}<h2>Token mix</h2></div>${parts.map(([l,v])=>`<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px"><span class="dim">${l}</span><span style="font-variant-numeric:tabular-nums">${compact(v)} · ${v/tot<.01&&v?'<1':Math.round(v/tot*100)}%</span></div><span class="share"><i style="width:${Math.max(v?.6:0,v/tot*100).toFixed(1)}%;background:var(--body)"></i></span></div>`).join('')}
    <p class="dim" style="font-size:12.5px;margin-top:6px">Agents reread their whole context every turn, so cache reads are most of it. They are also the cheapest tokens, about a tenth of the input price.</p>`;
}
function modelTable(rows,s){
  const by=new Map(); for(const r of rows){ const k=r.model||('unknown:'+r.provider); const m=by.get(k)||{model:r.model,provider:r.provider,cost:0,tokens:0,output:0}; m.cost+=r.cost||0; m.tokens+=tokTotal(r); m.output+=r.tokens?.output||0; by.set(k,m); }
  const list=[...by.values()].sort((a,b)=>b.cost-a.cost); if(!list.length)return '<div class="empty">No usage in this range.</div>';
  const lab=(m)=>m.model?(ledger.models?.[m.model]?.label||m.model):`${PROV[m.provider]?.label||m.provider}, model not recorded`;
  return `<table class="mtable"><thead><tr><th>Model</th><th class="num">Tokens</th><th class="num hide-sm">Output</th><th class="num">Value</th><th class="hide-sm"><span class="a11y-only">Share of value</span></th></tr></thead><tbody>${list.slice(0,10).map(m=>`<tr><td><span class="model"><i style="background:${PROV[m.provider]?.color||'var(--dim)'}"></i>${esc(lab(m))}</span></td><td class="num">${compact(m.tokens)}</td><td class="num hide-sm">${m.output?compact(m.output):'–'}</td><td class="num">${usd(m.cost)}</td><td class="hide-sm" style="width:22%"><span class="share"><i style="width:${s.cost?(m.cost/s.cost*100).toFixed(1):0}%;background:${PROV[m.provider]?.color||'var(--dim)'}"></i></span></td></tr>`).join('')}</tbody></table>`
    +(list.length>10?`<p class="dim" style="font-size:12.5px;margin-top:8px">${list.length-10} smaller models not shown.</p>`:'');
}
function paymentsHTML(plans){
  const ids=new Set(plans.map(p=>p.id)); const all=(ledger.payments||[]).filter(x=>uPlan==='all'?(uProv==='all'||!x.plan||plans.some(p=>p.id===x.plan)):ids.has(x.plan)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  if(!all.length)return '<div class="empty">No receipts on record for this filter.</div>';
  const list=uPayAll?all:all.slice(0,6);
  const byId=new Map((ledger.plans||[]).map(p=>[p.id,p]));
  const paidGBP=all.filter(x=>x.status==='paid'&&x.currency==='GBP').reduce((a,x)=>a+Number(x.amount||0),0), paidUSD=all.filter(x=>x.status==='paid'&&x.currency==='USD').reduce((a,x)=>a+Number(x.amount||0),0);
  return `<p class="dim" style="font-size:13px;margin:-4px 0 10px">${gbp(paidGBP)}${paidUSD?` and ${usd(paidUSD,{exact:true})}`:''} paid and checked against receipts.</p><div class="rows">${list.map(x=>{ const p=byId.get(x.plan); return `<div class="row"><span class="when-col" style="min-width:58px">${esc(shortDate(Date.parse(x.date)))}</span><div class="main"><div class="t">${esc(p?planShort(p):(x.kind==='api-credit'?'API credit':x.account||''))}</div><div class="s">${esc(x.kind==='invoice'?'Invoice':x.kind==='api-credit'?'Credit top-up':'Subscription')}${x.status!=='paid'?' · '+esc(x.status):''}</div></div><span class="r" style="color:var(--ink)">${x.currency==='USD'?usd(x.amount,{exact:true}):gbp(x.amount,{exact:true})}</span></div>`; }).join('')}</div>${all.length>6?`<button class="btn sm ghost" data-payall style="margin-top:8px">${uPayAll?'Show fewer':`Show all ${all.length}`}</button>`:''}`;
}
function openPlansSheet(){
  const plans=(ledger?.plans||[]);
  const box=document.createElement('form'); box.className='sheet'; box.id='sheet-plans'; document.getElementById('sheet-plans')?.remove();
  const cur=(p)=>(p.periods||[]).slice().sort((a,b)=>String(b.from).localeCompare(String(a.from)))[0]||{};
  box.innerHTML=`<h3>Plan prices<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
    <p class="dim" style="font-size:13px;margin-bottom:14px">The current price for each plan, before tax. Changing one updates every chart from that plan's latest start date. Older price periods stay as they are.</p>
    ${plans.map((p,i)=>{ const c=cur(p); return `<div class="field"><label>${esc(planLabel(p))} · ${p.payer==='work'?'work pays':'you pay'}</label><div class="field-row" style="grid-template-columns:1fr 1fr"><input data-pi="${i}" data-k="amount" inputmode="decimal" value="${c.amount!=null?esc(c.amount):''}" placeholder="£ amount" aria-label="Amount"><div class="seg" data-pi="${i}" data-k="per"><button type="button" data-v="month" aria-pressed="${c.per!=='year'}">a month</button><button type="button" data-v="year" aria-pressed="${c.per==='year'}">a year</button></div></div></div>`; }).join('')||'<div class="empty">No plans yet.</div>'}
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit"${plans.length?'':' disabled'}>Save</button></div>`;
  box.addEventListener('click',e=>{ const b=e.target.closest('.seg[data-k="per"] [data-v]'); if(!b)return; b.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); });
  box.addEventListener('submit',async e=>{ e.preventDefault(); const next=plans.map(p=>JSON.parse(JSON.stringify(p)));
    next.forEach((p,i)=>{ const c=cur(p); const per=(p.periods||[]).find(x=>x.from===c.from); if(!per)return; const v=box.querySelector(`input[data-pi="${i}"]`).value.trim(); const n=parseFloat(v.replace(/[^0-9.]/g,'')); per.amount=Number.isFinite(n)?n:null; per.per=box.querySelector(`.seg[data-pi="${i}"] [aria-pressed="true"]`)?.dataset.v||'month'; p.confirmed=true; });
    try{ await send('/api/ai-usage/plans',next,'PUT'); closeOverlays(); toast('Prices saved'); loadLedger(true); }catch(err){ toast(err.message); } });
  document.body.appendChild(box); openSheet('sheet-plans');
}
window.openPlansSheet=openPlansSheet;

/* MONEY (3 Oct 2026). The Monzo Google Sheets export and Trading 212, read once a
   day on the Home Mac (money.js) and shown behind a passcode of its own. The maths
   lives in money-core.js, shared with the daemon and the MCP server. Nothing here
   goes in localStorage: close the page and the numbers go with it.
   Round 2 (same day): what Owner tells it (notes, one-offs, trips, regular payment
   statuses) lives in context.json; rent by the term is spread over the dates it
   pays for (plans.json); an advisor note from Opus once a day; colour palettes. */
const MC=window.MoneyCore;
const MN={data:null,status:null,at:0,busy:false,period:localStorage.getItem('meridian.cc.mPeriod')||'payday',cat:'',q:'',txKind:localStorage.getItem('meridian.cc.mTx')||'spend',day:'',trip:'',shown:40,allPos:false,t2p:'all',openGroup:'',gran:localStorage.getItem('meridian.cc.mGran')||'week',seenSince:null,noteId:'',showStale:false,hide:localStorage.getItem('meridian.cc.mHide')==='1',error:'',asking:false};
// Colours have jobs. Families: needs cool, wants warm, other grey, so the trend
// chart and the donut agree. In is green, spent is coral, put away is blue.
const M_PALETTES={
  meaning:{name:'Needs and wants',hint:'Needs cool, wants warm, the rest grey',io:['#3fd68f','#ff7a59','#5b9dff'],grouped:true,groups:{need:'#5b7cfa',want:'#ff8a4c',other:'#8e8e94'},cats:{Rent:'#5b7cfa',Bills:'#4fb3d9',Groceries:'#2fc4a0',Transport:'#7aa7ff','Personal care':'#8fd3e8',Houdemoold:'#58c7c0',Education:'#9db6ff','Eating out':'#ff8a4c',Entertainment:'#ff6fa3',Shopping:'#ffb547',Holidays:'#ffd84d',Hobbies:'#ff9e7a',Gifts:'#f77fd0',Gym:'#ffc78a',AI:'#e8774f',Family:'#f2a3a3',Charity:'#f5c26b',General:'#9a9aa2','Student loan':'#3fd68f'}},
  pastel:{name:'Pastel',hint:'The same families, softer',io:['#9fe0c0','#f4b19c','#a9c3f2'],grouped:true,groups:{need:'#a9bdf5',want:'#f6c1a0',other:'#b9b9c0'},cats:{Rent:'#a9bdf5',Bills:'#a6d8ea',Groceries:'#a3e2cf',Transport:'#bcd2ff','Personal care':'#c6e6f2',Houdemoold:'#ade0db',Education:'#cbd7ff','Eating out':'#f6c1a0',Entertainment:'#f5b3cd',Shopping:'#f7d9a0',Holidays:'#f7e7a1',Hobbies:'#f6c9b5',Gifts:'#f1bfe3',Gym:'#f7dcb8',AI:'#efb79f',Family:'#f2c6c6',Charity:'#f2dcae',General:'#c4c4ca','Student loan':'#9fe0c0'}},
  today:{name:"Today's colours",hint:'From the almanac: a new Wada pair every day',grouped:true,dynamic:true},
  bright:{name:'Bright',hint:'Every category its own strong colour',io:['#22e39b','#ff6a3d','#3d9bff'],groups:{need:'#3d9bff',want:'#ff6a3d',other:'#b8b8c0'},cats:{Groceries:'#22e39b','Eating out':'#ff6a3d',Transport:'#3d9bff',Entertainment:'#a66bff',Shopping:'#ff4fa0',Holidays:'#ffd23d',Rent:'#7c6cff',Bills:'#2fd6e8',General:'#b8b8c0',Gym:'#b6f03c','Personal care':'#ff8be0',Gifts:'#ff9f2e',Hobbies:'#3ef0c8',Family:'#ffb37a',Charity:'#7ee36e',AI:'#ff7a45','Student loan':'#22e39b'}},
  mono:{name:'Ink and accent',hint:'Greys, with the biggest category in your accent',io:['var(--ink)','var(--accent)','var(--dim)'],mono:true,groups:{need:'#d4d4d8',want:'var(--accent)',other:'#6a6a70'}},
};
// Today's colours: the almanac's two main Wada colours become the needs and
// wants families, in steps of lightness. Falls back to Needs and wants.
function hexHsl(h){ h=h.replace('#',''); const r=parseInt(h.slice(0,2),16)/255,g=parseInt(h.slice(2,4),16)/255,b=parseInt(h.slice(4,6),16)/255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b); let H=0,S=0; const L=(mx+mn)/2;
  if(mx!==mn){ const d=mx-mn; S=L>.5?d/(2-mx-mn):d/(mx+mn); H=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4; H*=60; } return [H,S*100,L*100]; }
function todayPalette(){
  const c=(almanac?.items?.colours?.colours||[]).map(x=>x.hex).filter(x=>/^#[0-9a-f]{6}$/i.test(x)); if(c.length<2)return null;
  const fam=(hex,i)=>{ const [h,s]=hexHsl(hex); return `hsl(${Math.round(h)} ${Math.max(38,Math.min(80,s))}% ${[58,66,50,72,62,54,76][i%7]}%)`; };
  const cats={}; MC.NEEDS.forEach((k,i)=>cats[k]=fam(c[0],i)); MC.WANTS.forEach((k,i)=>cats[k]=fam(c[1],i)); cats.General='#9a9aa2';
  return {...M_PALETTES.today,io:['#3fd68f','#ff7a59','#5b9dff'],groups:{need:fam(c[0],0),want:fam(c[1],0),other:'#8e8e94'},cats,names:(almanac.items.colours.colours||[]).slice(0,2).map(x=>x.name)};
}
const mPal=()=>{ const id=MN.data?.settings?.palette; if(id==='today')return todayPalette()||M_PALETTES.meaning; return M_PALETTES[id]||M_PALETTES.meaning; };
const famCol=(g)=>mPal().groups?.[g]||({need:'#5b7cfa',want:'#ff8a4c',other:'#8e8e94'})[g];
// Mono: the biggest category in the accent, the rest in steps of grey. Grouped: an
// unknown category still lands in the right family (cool, warm or grey).
function catCol(c){ const p=mPal(); if(p.mono){ const v=MN.view; const i=v?v.s.categories.findIndex(x=>x.name===c):-1; if(i===0)return 'var(--accent)'; return ['#d4d4d8','#a8a8ae','#86868c','#6a6a70','#55555b'][Math.max(0,Math.min(4,i-1))]||'#55555b'; }
  if(p.cats[c])return p.cats[c]; if(c==='Other')return '#626268';
  const h=[...String(c)].reduce((a,ch)=>a+ch.charCodeAt(0),0);
  if(p.grouped){ const g=MC.groupOf(c); return g==='need'?`hsl(${195+h%35} 60% 62%)`:g==='want'?`hsl(${12+h%38} 85% 64%)`:`hsl(0 0% ${55+h%20}%)`; }
  return `hsl(${h%360} 45% 62%)`; }
const sgbp=(v,o)=>(v<0?'−':'')+gbp(Math.abs(v),o);
const amt=(v,o)=>`<span class="amt">${sgbp(v,o)}</span>`;
const KIND_TAG={pot:'pot',internal:'own account',invest:'invested',income:'in',planned:'rent, spread',ignore:'left out'};
async function loadMoney(){
  try{ const r=await fetch(api('/api/money')); const j=await r.json().catch(()=>({}));
    if(r.status===401){ MN.data=null; MN.status={setup:!!j.setup,unlocked:false}; }
    else if(r.ok){ if(!DEMO&&!LAB&&!j.approvedClaimsSeeded) { const seeded=await send('/api/money/receivables',{action:'seed-approved'}); j.receivables=seeded.claims; j.senders=seeded.senders; j.approvedClaimsSeeded=seeded.approvedClaimsSeeded; } MN.data=j; MN.status={setup:true,unlocked:true}; MN.at=Date.now(); MN.error='';
      // What's new is measured from the last visit, fixed for this page; the visit is recorded a few seconds in.
      if(MN.seenSince===null){ MN.seenSince=j.settings?.seenAt||''; setTimeout(()=>{ if(view==='money'&&MN.data)send('/api/money/seen',{},'PUT').catch(()=>{}); },5000); } }
    else throw new Error(j.error||('Money returned '+r.status));
  }catch(err){ MN.error=String(err.message||err); if(!MN.status)MN.status={setup:true,unlocked:false,offline:true}; }
  if(view==='money')VIEWS.money.update();
}
async function moneyRefresh(){
  if(MN.busy)return; MN.busy=true; VIEWS.money.update();
  try{ const j=await send('/api/money/refresh',{}); if(j.data)MN.data=j.data; const bad=['monzo','t212'].filter(k=>j.result?.[k]&&!j.result[k].ok);
    toast(bad.length?`Updated, but ${bad.map(k=>k==='t212'?'Trading 212':'Monzo').join(' and ')} didn't come through`:'Money is up to date'); }
  catch(err){ toast(err.message); if(/locked/i.test(err.message))loadMoney(); }
  MN.busy=false; VIEWS.money.update();
}
// Save something Owner told it, then redraw with the new context.
async function moneyContext(patch,msg){ try{ const j=await send('/api/money/context',patch,'PATCH'); if(j.context&&MN.data)MN.data.context=j.context; if(msg)toast(msg); VIEWS.money.update(); return true; }catch(err){ toast(err.message); return false; } }
VIEWS.money={
  mount(el){
    el.innerHTML='<div id="m-root"></div>';
    el.addEventListener('click',moneyClick);
    el.addEventListener('submit',moneySubmit);
    el.addEventListener('input',e=>{ if(e.target.id==='m-q'){ MN.q=e.target.value; MN.shown=40; clearTimeout(MN.qt); MN.qt=setTimeout(()=>{ if($('m-tx'))$('m-tx').innerHTML=txListHTML(); if($('m-txsum'))$('m-txsum').innerHTML=txSumHTML(); if($('m-chips'))$('m-chips').innerHTML=txChips(); },120); } });
  },
  update(shown){
    // Fresh numbers when the tab opens, at most every 5 minutes; the server reads its sources once a day.
    if(shown&&(!MN.status||Date.now()-MN.at>300e3))loadMoney();
    const el=$('m-root'); if(!el)return;
    root.classList.toggle('m-hiding',MN.hide&&view==='money');
    if(!MN.status){ el.innerHTML=`<div class="vhead"><div><h1>Money</h1><p>Opening…</p></div></div>`; return; }
    if(!MN.status.unlocked){ el.innerHTML=moneyLockHTML(); setTimeout(()=>$('m-pass')?.focus(),40); return; }
    const io=mPal().io; el.style.setProperty('--m-in',io[0]); el.style.setProperty('--m-out',io[1]); el.style.setProperty('--m-save',io[2]);
    const y=$('page').scrollTop; el.innerHTML=moneyHTML(); $('page').scrollTop=y;
    moneyCharts();
  },
};
function moneyLockHTML(){
  const s=MN.status; const first=!s.setup;
  return `<div class="m-lock"><div class="card m-lockcard">
    <div class="m-lockic">${icon('lock')}</div>
    <h1>${first?'Choose a passcode':'Money is locked'}</h1>
    <p>${first?'Money has its own passcode on top of Tailscale, so nobody glancing at your screen or holding your phone can open it. At least 6 characters.':'Type your passcode to see your spending and investments.'}</p>
    ${s.offline?`<p class="m-warn">Can't reach the Home Mac right now. ${esc(MN.error)}</p>`:''}
    <form id="m-unlock" data-first="${first?1:0}" autocomplete="on">
      <input type="text" name="username" value="Meridian Money" autocomplete="username" hidden>
      <input type="password" id="m-pass" placeholder="Passcode" autocomplete="${first?'new-password':'current-password'}" required minlength="${first?6:1}" aria-label="Passcode">
      ${first?'<input type="password" id="m-pass2" placeholder="Same again" autocomplete="new-password" required aria-label="Passcode again">':''}
      <label class="m-check"><input type="checkbox" id="m-remember" ${first||localStorage.getItem('meridian.cc.mRemember')!=='0'?'checked':''}> Keep this device unlocked for 30 days</label>
      <button class="btn primary" type="submit">${first?'Set passcode':'Unlock'}</button>
      <div class="m-err" id="m-err" role="alert"></div>
    </form>
    ${first?'':'<p class="m-fine">Forgot it? On the Home Mac, run <code>node scripts/money-setup.js reset-lock</code> in the Meridian folder, then choose a new one here.</p>'}
  </div></div>`;
}
function moneyPeriods(P){ const hasPay=MC.paydays(P).length>0; return MC.PERIODS.filter(p=>p.id!=='payday'||hasPay); }
const monthName=(k)=>`${MONTHS[Number(k.slice(5,7))-1]} ${k.slice(0,4)}`;
function moneyHTML(){
  const D=MN.data; const ctx=D.context||{}; const P=MC.prepare(D.monzo.transactions,D.rules,{context:ctx,plans:D.plans,receivables:D.receivables}); const today=isoDay();
  const periods=moneyPeriods(P); if(!MN.period.startsWith('m:')&&!periods.some(p=>p.id===MN.period))MN.period=periods[0].id;
  const sp=MC.periodSpan(MN.period,P,today); const s=MC.summarize(P,sp); const pv=sp.prev?MC.summarize(P,sp.prev):null; const rec=MC.recurring(P,today);
  MN.view={P,sp,s,pv,rec};
  const st=D.status||{}; const t=D.t212; const pulled=D.monzo.pulledAt?Date.parse(D.monzo.pulledAt):0;
  const plans=Object.values(D.plans||{}); const costPlans=plans.filter(p=>p.kind!=='income'); const incomePlans=plans.filter(p=>p.kind==='income');
  const head=[]; const out=[];
  head.push(`<div class="vhead"><div><h1>Money</h1><p>Where it comes from and where it goes. Read from Monzo and Trading 212 once a day${pulled?`, last at ${esc(dayWord(pulled).toLowerCase()==='today'?hm(pulled):dayWord(pulled)+' '+hm(pulled))}`:''}. Press ⌘K and type £ to search it from anywhere.</p></div>
    <div class="vtools"><button class="btn ghost" id="m-refresh"${MN.busy?' disabled':''}>${icon('refresh')}<span>${MN.busy?'Updating…':'Update now'}</span></button><button class="ibtn${MN.hide?' on':''}" data-m="hide" title="${MN.hide?'Show amounts':'Hide amounts'}|For screen sharing">${icon(MN.hide?'eyeoff':'eye')}</button><button class="ibtn" data-m="lock" title="Lock">${icon('lock')}</button><button class="ibtn" data-m="more" title="Settings">${icon('dots')}</button></div></div>`);
  // The period follows you down the page: everything below it depends on it.
  const custom=MN.period.startsWith('m:');
  head.push(`<div class="ufilters m-sticky"><div class="seg m-periods" role="group">${periods.map(p=>`<button type="button" data-mp="${p.id}" aria-pressed="${p.id===MN.period}">${esc(p.label)}</button>`).join('')}</div>${custom?`<button type="button" class="chip" data-mp="${esc(periods[0].id)}" aria-pressed="true">${esc(monthName(MN.period.slice(2)))}${icon('close')}</button>`:''}<span class="m-span">${esc(spanWords(sp))}</span><span class="m-stickyamt">in <b>${amt(s.earned)}</b> · spent <b>${amt(s.spent)}</b></span></div>`);
  if(st.monzo&&!st.monzo.ok)out.push(`<div class="m-note">${icon('bolt')}<span>Monzo didn't update: ${esc(st.monzo.error)}. Showing what was read before.</span></div>`);
  // 1. The three numbers
  const dd=(x)=>x.steady-x.spread; const dSpent=pv&&dd(pv)>20?Math.round((dd(s)-dd(pv))/dd(pv)*100):null;
  const loanName=(incomePlans[0]?.name||'student loan').toLowerCase();
  out.push(`<section class="card c4 stat"><div class="lab">Money in</div><div class="val m-big">${amt(s.earned)}</div><div class="delta">${s.salary?`<b>${amt(s.salary)}</b> salary`:'No salary in this range'}${s.spreadIn?` · ${amt(s.spreadIn)} ${esc(loanName)}, spread over the term`:''}${s.otherIn?` · ${amt(s.otherIn)} from elsewhere`:''}${s.internal>0?` · ${amt(s.internal)} moved over from your own accounts, not counted`:''}</div></section>`);
  out.push(`<section class="card c4 stat"><div class="lab">Spent</div><div class="val m-big">${amt(s.spent)}</div><div class="delta">${s.lumps?`<b>${amt(s.steady)}</b> day to day, ${amt(s.lumps)} in one-offs`:''}${dSpent!=null&&sp.prev?`${s.lumps?'. ':''}<b>${dSpent>=0?'+':''}${dSpent}%</b>${s.lumps||s.spread?' day to day, leaving rent aside,':''} on ${esc(sp.prevLabel)}`:''}${s.spread?`. Includes ${amt(s.spread)} of rent, spread over the term`:''}</div>
    ${s.earned?`<div class="vsbar m-vs" title="How much of what came in was spent"><span style="width:${Math.max(1.5,Math.min(100,s.spent/Math.max(s.earned,s.spent)*100)).toFixed(1)}%"></span></div>`:''}</section>`);
  out.push(`<section class="card c4 stat"><div class="lab">Left over</div><div class="val m-big ${s.left<0?'m-neg':'m-pos'}">${amt(s.left)}</div><div class="delta">${s.saved?`${amt(s.saved)} ${s.saved<0?'taken out of':'into'} pots`:''}${s.saved&&s.invested?' · ':''}${s.invested?`${amt(s.invested)} ${s.invested<0?'taken out of':'into'} investments`:''}${!s.saved&&!s.invested?'In less spent':''}</div></section>`);
  // 2. What changed, then what the adviser thinks
  out.push(`<section class="card c12 m-newscard" id="m-glance">${newsHTML(P)}</section>`);
  out.push(`<section class="card c12 m-adv" id="m-adv">${adviceHTML()}</section>`);
  // 3. The trend, and anything worth knowing about it
  out.push(`<section class="card c8"><div class="ch">${icon('trend')}<h2>Spending over time</h2><span class="sub">needs and wants, one-offs marked</span><span class="end"><div class="seg" role="group">${M_GRANS.map(([k,l])=>`<button type="button" data-mgran="${k}" aria-pressed="${(MN.gran||'week')===k}">${l}</button>`).join('')}</div></span></div><div class="chart m-trend" id="m-chart"></div><div class="split m-trendk" style="margin-top:10px">${['need','want','other'].map(g=>`<span class="k"><i style="background:${famCol(g)}"></i>${{need:'Needs',want:'Wants',other:'Other'}[g]}</span>`).join('')}<span class="k"><i class="m-k-oneoff"></i>One-off</span><span class="k"><i class="m-k-avg"></i>Typical ${{day:'day',week:'week',month:'month'}[MN.gran||'week']}</span></div></section>`);
  const tips=MC.insights(P,sp,s,pv,{prevSpan:sp.prev,recurring:rec.filter(r=>subState(r).counts),prevLabel:sp.prevLabel,fmt:(v)=>`<span class="amt">${gbp(v)}</span>`});
  out.push(`<section class="card c4"><div class="ch">${icon('bulb')}<h2>Worth knowing</h2></div>${tips.length?'<ul class="tips">'+tips.slice(0,5).map(x=>`<li>${x.text}</li>`).join('')+'</ul>':'<div class="empty">Nothing stands out yet.</div>'}</section>`);
  // 4. Where it went (the summary of the period lives here now) and the places
  out.push(`<section class="card c7">${whereHTML(P,sp,s)}</section>`);
  const shops=s.merchants.filter(m=>m.spent>0&&!m.spread).slice(0,8);
  out.push(`<section class="card c5"><div class="ch">${icon('pin')}<h2>Top places</h2><span class="sub">${esc(sp.label)}</span></div>${shops.length?`<div class="rows">${shops.map(m=>`<div class="row" data-mq="${esc(m.name)}" style="cursor:pointer"><span class="m-dot" style="background:${catCol(m.cat)}"></span><div class="main"><div class="t">${esc(m.name)}</div><div class="s">${esc(m.cat)} · ${m.count} payment${m.count>1?'s':''}</div></div><span class="r" style="color:var(--ink)">${amt(m.spent)}</span></div>`).join('')}</div>`:'<div class="empty">Nothing yet.</div>'}</section>`);
  out.push(`<section class="card c12"><div class="ch">${icon('next')}<h2>Month by month</h2><span class="sub">rent and the loan spread over their terms. Click a month to open it</span></div><div class="chart" id="m-months" style="height:220px"></div><div class="split" style="margin-top:10px"><span class="k"><i style="background:var(--m-in)"></i>In</span><span class="k"><i style="background:var(--m-out)"></i>Spent</span><span class="k"><i style="background:var(--m-save)"></i>Put away (new money, not money moved over from your other account)</span></div></section>`);
  // 5. Plans and plans-to-be
  for(const plan of costPlans)out.push(`<section class="card c6">${planHTML(plan,P,incomePlans)}</section>`);
  out.push(`<section class="card ${costPlans.length?'c6':'c12'}">${tripsHTML(P)}</section>`);
  // 6. What you own and what keeps going out
  out.push(`<section class="card c7">${t212HTML(t,st.t212,D.history||[])}</section>`);
  out.push(`<section class="card c5">${recurringHTML(rec)}</section>`);
  const all=MC.summarize(P,MC.periodSpan('all',P,today));
  out.push(`<section class="card c7">${accountsHTML(P,t)}</section>`);
  out.push(`<div class="c5 m-stack">${owedHTML(P)}<section class="card"><div class="ch">${icon('pot')}<h2>Pots</h2><span class="sub">moved in since ${esc(shortDate(Date.parse(all.from)))}</span></div>${all.pots.length?`<div class="rows">${all.pots.map(x=>{ const now=s.pots.find(y=>y.name===x.name); return `<div class="row"><div class="main"><div class="t">${esc(x.name)}</div><div class="s">${now?`${amt(now.amount)} ${esc(sp.label)}`:'nothing '+esc(sp.label)}</div></div><span class="r" style="color:var(--ink)">${amt(x.amount)}</span></div>`; }).join('')}</div><p class="m-fine">Only what's moved since the export began, not the pot balance.</p>`:'<div class="empty">No pot transfers.</div>'}</section></div>`);
  // 7. Every payment
  out.push(`<section class="card c12" id="m-paycard"><div class="ch">${icon('table')}<h2>Payments</h2><span class="end"><div class="seg" role="group">${[['spend','Spending'],['in','Money in'],['all','Everything']].map(([k,l])=>`<button type="button" data-mtx="${k}" aria-pressed="${MN.txKind===k}">${l}</button>`).join('')}</div><label class="m-search">${icon('search')}<input id="m-q" placeholder="Search names, notes, amounts" value="${esc(MN.q)}" autocomplete="off" spellcheck="false" aria-label="Search payments"></label></span></div>
    <div class="m-chips" id="m-chips">${txChips()}</div><div class="m-sumline" id="m-txsum">${txSumHTML()}</div><div id="m-tx">${txListHTML()}</div></section>`);
  const tStat=st.t212;
  out.push(`<div class="c12 srcline"><span><i class="dot ${st.monzo?.ok===false?'down':'ok'}"></i>Monzo sheet${st.monzo?.through?' · through '+esc(shortDate(Date.parse(st.monzo.through))):''}${pulled?' · read '+esc(ago(pulled)):''}</span><span><i class="dot ${tStat?.ok?'ok':tStat?'down':'warn'}"></i>Trading 212${tStat?.ok?' · read '+esc(ago(Date.parse(tStat.at))):tStat?' · '+esc(tStat.code==='key-rejected'?'key needs replacing':cap(tStat.error||'',60)):' · not connected'}</span><span>Updates every day at ${pad(D.settings?.refreshHour??6)}:00</span><span>Only on this tab, never in the brief or other devices' caches</span></div>`);
  return head.join('')+`<div class="grid m-grid">${out.join('')}</div>`;
}
const spanWords=(sp)=>sp.id==='all'?`${shortDate(Date.parse(sp.from))} to today`:sp.to===isoDay()?`${shortDate(Date.parse(sp.from))} to today`:`${shortDate(Date.parse(sp.from))} to ${shortDate(Date.parse(sp.to))}`;
const dailyCats=(s)=>s.categories.filter(c=>c.spent>0).slice(0,5).map(c=>c.name).concat(s.categories.filter(c=>c.spent>0).length>5?['Other']:[]);

/* the adviser */
const ADV_STALE_DAYS=14;
const advName=(id)=>(MN.data?.advisers||[]).find(a=>a.id===id)?.name||id;
function adviceHTML(){
  const A=MN.data.advice||{}; const notes=A.notes||[]; const S=MN.data.adviser||{schedule:'weekly',model:'gpt-6-luna',effort:'high',weekday:1};
  const note=notes.find(n=>n.id===MN.noteId)||notes[0]; const running=A.running||MN.asking;
  const age=note?(Date.now()-Date.parse(note.at))/86400e3:0; const stale=note&&age>ADV_STALE_DAYS&&!MN.showStale&&note===notes[0];
  const sched=S.schedule==='off'?'New notes only when you ask':S.schedule==='daily'?`A new note every morning from ${esc(advName(S.model))}`:`A new note every ${DAYS[S.weekday]} from ${esc(advName(S.model))}`;
  const hist=notes.length>1?`<div class="m-hist-chips">${notes.slice(0,5).map(n=>`<button type="button" class="chip${n===note?' on':''}" data-mnote="${esc(n.id)}" aria-pressed="${n===note}">${esc(advName(n.model).replace(/^GPT-6(\.1)? /,''))} · ${esc(dayWord(Date.parse(n.at)))}</button>`).join('')}</div>`:'';
  const err=A.lastError&&(!notes[0]||Date.parse(A.lastError.at)>Date.parse(notes[0].at))?`<div class="m-note">${icon('bolt')}<span>The last try with ${esc(advName(A.lastError.model))} didn't work: ${esc(A.lastError.error)}</span></div>`:'';
  const busy=running?`<div class="m-thinking"><span class="m-spin"></span>${esc(advName(running.model||S.model))} is reading your numbers${running.since?`, started ${esc(ago(running.since))}`:''}. Carry on looking around; the note lands here.</div>`:'';
  const head=`<div class="ch">${icon('sparkle')}<h2>Your adviser</h2>${note?`<span class="sub">${esc(advName(note.model))}${note.review?', second opinion':''} · ${esc(dayWord(Date.parse(note.at)))} ${esc(hm(Date.parse(note.at)))}</span>`:''}<span class="end">${hist}</span></div>`;
  const foot=`<div class="m-advf"><span>${sched}. Not regulated advice, just a second pair of eyes.</span><span class="end"><button class="btn sm ghost" data-m="notes">${icon('edit')}Tell it something</button><button class="btn sm ghost" data-m="advmenu"${running?' disabled':''}>${icon('sparkle')}${running?'Thinking…':note?'Ask again':'Ask now'}${icon('chev')}</button></span></div>`;
  if(!note)return head+err+busy+(running?'':'<p class="dim" style="font-size:14px">No note yet. Ask for one, or wait for the next scheduled one.</p>')+foot;
  if(stale)return head+err+busy+`<div class="m-stale"><p>Your last note is from ${esc(shortDate(Date.parse(note.at)))}, so it's probably out of date.</p><span><button class="btn sm" data-m="advmenu">${icon('sparkle')}Ask for a new one</button><button class="btn sm ghost" data-m="showstale">Show it anyway</button></span></div>`+foot;
  const a=note.advice; const col=(k,label,list)=>list.length?`<div class="m-advc m-adv-${k}"><h3>${label}</h3><ul>${list.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'';
  return head+err+busy+`<p class="m-advh">${esc(a.headline)}</p><div class="m-advg">${col('good','Going well',a.going_well)}${col('watch','Keep an eye on',a.watch)}${col('try','Try this',a.try)}</div>`+foot;
}
async function moneyAdvise(model,{review=false,effort}={}){
  if(MN.asking)return; MN.asking={model,since:Date.now()}; MN.showStale=false; MN.noteId=''; VIEWS.money.update();
  const before=MN.data.advice?.notes?.[0]?.id;
  try{ const j=await send('/api/money/advice',{model,review,effort}); if(j.advice)MN.data.advice=j.advice; }catch(err){ toast(err.message); MN.asking=false; VIEWS.money.update(); return; }
  // Codex can take a few minutes: check every 5 seconds and let Owner carry on meanwhile.
  const poll=async()=>{ try{ const j=await (await fetch(api('/api/money/advice'))).json(); if(j.advice&&MN.data){ MN.data.advice=j.advice;
      if(!j.advice.running){ MN.asking=false; const n=j.advice.notes?.[0]; if(n&&n.id!==before)toast(`New note from ${advName(n.model)}`,{action:view==='money'?undefined:{label:'Show',run:()=>go('money')}}); else if(j.advice.lastError)toast("The adviser didn't answer: "+j.advice.lastError.error); if(view==='money')VIEWS.money.update(); return; } }
    }catch{} if(view==='money'&&$('m-adv'))$('m-adv').innerHTML=adviceHTML(); setTimeout(poll,5000); };
  setTimeout(poll,4000);
}
function adviceMenu(btn){
  const r=btn.getBoundingClientRect(); const S=MN.data.adviser||{}; const list=MN.data.advisers||[]; const latest=MN.data.advice?.notes?.[0]; const note=(MN.data.advice?.notes||[]).find(n=>n.id===MN.noteId)||latest;
  menu(r.right-230,r.bottom+6,[
    ...list.map(a=>({label:`Ask ${a.name}${a.id===S.model?' (usual)':''}`,icon:'sparkle',act:()=>moneyAdvise(a.id)})),
    {label:'Ask GPT-6 Luna, extra high thinking',icon:'sparkle',act:()=>moneyAdvise('gpt-6-luna',{effort:'xhigh'})},
    latest?'hr':null,
    latest?{label:`Second opinion from ${latest.model.startsWith('claude')?'GPT-6 Luna':'Opus 5.5'}`,icon:'reply',act:()=>moneyAdvise(latest.model.startsWith('claude')?'gpt-6-luna':'claude-opus-5-5',{review:true})}:null,
    'hr',
    {label:'Schedule and model…',icon:'sliders',act:openAdviserSheet},
    note?{label:'Remove this note',icon:'trash',danger:true,act:async()=>{ try{ const j=await send('/api/money/advice',{id:note.id},'DELETE'); MN.data.advice=j.advice; MN.noteId=''; VIEWS.money.update(); toast('Note removed'); }catch(err){ toast(err.message); } }}:null,
  ]);
}
function openAdviserSheet(){
  const S={...(MN.data.adviser||{})}; const list=MN.data.advisers||[];
  const box=moneySheet('sheet-madv',`${sheetHead('Your adviser')}
    <p class="dim" style="font-size:13px;margin-bottom:12px">GPT models run on your ChatGPT plan, Claude ones on your Claude plan. A note takes from under a minute to a few. Notes older than ${ADV_STALE_DAYS} days fold away until you ask again.</p>
    <div class="field"><label>How often</label><div class="seg" id="ma-sched">${[['off','Only when I ask'],['weekly','Weekly'],['daily','Every morning']].map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${S.schedule===k}">${l}</button>`).join('')}</div></div>
    <div class="field-row"><div class="field"><label for="ma-day">Which day</label><select id="ma-day">${DAYS.map((d,i)=>`<option value="${i}"${S.weekday===i?' selected':''}>${d}</option>`).join('')}</select></div>
      <div class="field"><label for="ma-hour">From</label><select id="ma-hour">${[5,6,7,8,9,10,12,18].map(h=>`<option value="${h}"${(S.hour??7)===h?' selected':''}>${pad(h)}:00</option>`).join('')}</select></div></div>
    <div class="field"><label for="ma-model">Model</label><select id="ma-model">${list.map(a=>`<option value="${a.id}"${S.model===a.id?' selected':''}>${esc(a.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Thinking</label><div class="seg" id="ma-effort">${[['low','Low'],['medium','Medium'],['high','High'],['xhigh','Extra high']].map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${S.effort===k}">${l}</button>`).join('')}</div></div>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async b=>{ const pick=(id)=>b.querySelector(`#${id} [aria-pressed="true"]`)?.dataset.v; const j=await send('/api/money/adviser',{schedule:pick('ma-sched'),weekday:Number($('ma-day').value),hour:Number($('ma-hour').value),model:$('ma-model').value,effort:pick('ma-effort')},'PUT'); MN.data.adviser=j.adviser; closeOverlays(); toast('Saved'); VIEWS.money.update(); });
  box.addEventListener('click',e=>{ const x=e.target.closest('.seg [data-v]'); if(!x)return; x.parentElement.querySelectorAll('button').forEach(y=>y.setAttribute('aria-pressed',String(y===x))); });
}
/* rent by the term, with the student loan that pays for it */
function planHTML(plan,P,incomePlans=[]){
  const today=isoDay(); const ins=plan.instalments||[]; const total=ins.reduce((a,i)=>a+i.amount,0);
  const paid=(i)=>!!i.paid||P.some(t=>t.planned&&!t.planned.income&&t.planned.from===i.from);
  const next=ins.find(i=>!paid(i));
  const pd=MC.paydays(P); const step=MC.payInterval(pd); let left=0;
  if(next&&pd.length){ for(let d=MC.addDays(pd[pd.length-1],step);d<next.due;d=MC.addDays(d,step))if(d>today)left++; }
  const coming=next?incomePlans.flatMap(p=>(p.instalments||[]).filter(i=>i.due>today&&i.due<=next.due).map(i=>({...i,name:p.name}))):[];
  const inSum=coming.reduce((a,i)=>a+i.amount,0); const need=next?Math.max(0,next.amount-inSum):0;
  const days=next?Math.max(0,MC.daysBetween(today,next.due)):0;
  const contract=ins.length?{from:ins[0].from,to:ins[ins.length-1].to}:null; const perDay=contract?total/Math.max(1,MC.daysBetween(contract.from,contract.to)):0;
  const pend=(plan.pending||[]).filter(x=>!x.done);
  let plan2='';
  if(next){ plan2=inSum>=next.amount?`The ${esc(coming.map(c=>c.name.toLowerCase())[0])} on ${esc(shortDate(Date.parse(coming[0].due)))} covers it, with ${amt(inSum-next.amount)} to spare.`
    :coming.length?`${coming.map(c=>`${amt(c.amount)} ${esc(c.name.toLowerCase())} lands ${esc(shortDate(Date.parse(c.due)))}`).join(', ')}, so you're ${amt(need)} short.${left?` Put aside <b>${amt(need/left)}</b> from each of your ${left} paydays before then.`:''}`
    :left?`Put aside <b>${amt(need/left)}</b> from each of your ${left} paydays before then.`:''; }
  return `<div class="ch">${icon('home')}<h2>${esc(plan.name)}</h2><span class="sub">${amt(total)} for the year</span><span class="end"><button class="ibtn" data-mplan="${esc(plan.id)}" title="Edit the plan">${icon('edit')}</button></span></div>
    ${next?`<div class="stat"><div class="lab">Next payment</div><div class="val">${amt(next.amount)}</div><div class="delta">${esc(shortDate(Date.parse(next.due)))} ${esc(next.due.slice(0,4))} · in ${days} day${days===1?'':'s'}</div></div>${plan2?`<div class="m-next"><span>${plan2}</span></div>`:''}`:'<div class="empty">All paid for this contract.</div>'}
    ${pend.map((x,n)=>`<div class="m-note m-pend">${icon('bolt')}<span>Waiting on: ${esc(x.text)}${x.since?` <b>${MC.daysBetween(x.since,today)} day${MC.daysBetween(x.since,today)===1?'':'s'}</b> so far.`:''}</span><button type="button" class="btn sm ghost" data-mplan="${esc(plan.id)}">Sorted</button></div>`).join('')}
    <div class="rows m-ins">${ins.map(i=>`<div class="row"><span class="m-tick${paid(i)?' on':''}">${paid(i)?icon('check'):''}</span><div class="main"><div class="t">${esc(shortDate(Date.parse(i.from)))} to ${esc(shortDate(Date.parse(i.to)))}</div><div class="s">${paid(i)?'Paid':'Due '+esc(shortDate(Date.parse(i.due)))+' '+esc(i.due.slice(0,4))}</div></div><span class="r" style="color:var(--ink)">${amt(i.amount)}</span></div>`).join('')}</div>
    ${incomePlans.map(p=>`<div class="m-sub">${esc(p.name)}</div><div class="rows m-ins">${(p.instalments||[]).map(i=>{ const got=i.due<=today; return `<div class="row"><span class="m-tick${got?' on':''}">${got?icon('check'):''}</span><div class="main"><div class="t">${esc(shortDate(Date.parse(i.due)))} ${esc(i.due.slice(0,4))}</div><div class="s">${got?'Paid in':'Coming'}</div></div><span class="r" style="color:var(--ink)">+${amt(i.amount)}</span></div>`; }).join('')}</div>`).join('')}
    ${contract?`<p class="m-fine">Works out at ${amt(perDay)} a day across the contract (${esc(shortDate(Date.parse(contract.from)))} to ${esc(shortDate(Date.parse(contract.to)))}). ${esc(plan.note||'')}</p>`:''}`;
}
/* trips and highlights */
const TRIP_KINDS={holiday:'Holiday',visit:'Seeing mates',night:'Night out',other:'Other'};
function tripsHTML(P){
  const trips=MN.data.context?.trips||[];
  const spent=(id)=>P.filter(t=>t.trip===id&&t.kind==='spend').reduce((a,t)=>a-t.amount,0);
  const loose=P.filter(t=>t.kind==='spend'&&!t.trip&&!t.synthetic&&t.cat==='Holidays'&&t.date>=MC.addDays(isoDay(),-365));
  const looseSum=loose.reduce((a,t)=>a-t.amount,0);
  const sorted=trips.slice().sort((a,b)=>String(b.from||'9999').localeCompare(String(a.from||'9999')));
  return `<div class="ch">${icon('globe')}<h2>Trips and highlights</h2><span class="end"><button class="btn sm ghost" data-mtripedit="">${icon('plus')}New</button></span></div>
    ${sorted.length?`<div class="rows">${sorted.map(x=>{ const v=spent(x.id); const n=P.filter(t=>t.trip===x.id&&!t.synthetic).length; const soon=x.from&&x.from>isoDay(); return `<div class="row m-hov" data-mtrip="${esc(x.id)}" style="cursor:pointer"><span class="m-dot" style="background:${catCol('Holidays')}"></span><div class="main"><div class="t">${esc(x.name)}${x.with?` <span class="dim" style="font-weight:400">with ${esc(x.with)}</span>`:''} ${x.kind&&x.kind!=='holiday'?`<span class="tag">${esc(TRIP_KINDS[x.kind])}</span>`:''}${soon?'<span class="tag">coming up</span>':''}</div><div class="s">${x.from?esc(shortDate(Date.parse(x.from)))+(x.to&&x.to!==x.from?' to '+esc(shortDate(Date.parse(x.to))):'')+' '+esc(x.from.slice(0,4)):'No dates yet'} · ${n} payment${n===1?'':'s'}${x.budget?` · ${amt(x.budget)} ${soon?'expected':'budget'}${v<x.budget?`, ${amt(x.budget-v)} to go`:''}`:''}</div>${x.budget?`<span class="share" style="margin-top:6px;max-width:260px"><i style="width:${Math.min(100,v/x.budget*100).toFixed(1)}%;background:${v>x.budget?'var(--bad)':catCol('Holidays')}"></i></span>`:''}${x.note?`<div class="m-mynote">${icon('note')}<span class="m-blurtext">${esc(cap(x.note,140))}</span></div>`:''}</div><span class="acts"><button class="ibtn" data-mtripedit="${esc(x.id)}" title="Edit">${icon('edit')}</button></span><span class="r" style="color:var(--ink)">${amt(v)}</span></div>`; }).join('')}</div>`:'<p class="dim" style="font-size:13.5px">No trips yet. Make one for a holiday, a weekend seeing mates or a big night out, then add payments to it from their edit button.</p>'}
    ${loose.length?`<button type="button" class="m-loose" data-mtrip="unassigned">${amt(looseSum)} in Holidays over the last year isn't on a trip yet (${loose.length} payment${loose.length>1?'s':''}). Show them</button>`:''}`;
}
/* regular payments, with what Owner has said about each */
function subState(r){ const m=MN.data?.context?.subs?.[r.name.toLowerCase()]; const st=m?.status||'active';
  const again=st==='cancelled'&&m.since&&r.last>m.since;
  return {m,st,again,counts:st==='active'&&!r.lapsed||again}; }
function recurringHTML(rec){
  const groups={live:[],paused:[],late:[],cancelled:[]};
  for(const r of rec){ const x=subState(r); if(x.st==='hidden')continue; if(x.again||x.st==='active'&&!r.lapsed)groups.live.push([r,x]); else if(x.st==='paused')groups.paused.push([r,x]); else if(x.st==='cancelled')groups.cancelled.push([r,x]); else groups.late.push([r,x]); }
  const total=groups.live.reduce((a,[r])=>a+r.monthly,0);
  const sec=(k,label,list)=>list.length?`${label?`<div class="m-sub">${label}</div>`:''}<div class="rows${k!=='live'?' m-gone':''}">${list.map(([r,x])=>recRow(r,x)).join('')}</div>`:'';
  return `<div class="ch">${icon('refresh')}<h2>Regular payments</h2><span class="sub">${groups.live.length?`about ${amt(total)} a month`:''}</span></div>
    ${groups.live.length?sec('live','',groups.live):'<div class="empty">Nothing repeating right now.</div>'}
    ${sec('paused','Paused',groups.paused)}${sec('late','Stopped, or late',groups.late)}
    ${groups.cancelled.length?`<details class="m-det"><summary>${icon('chev')}Cancelled (${groups.cancelled.length})</summary>${sec('cancelled','',groups.cancelled)}</details>`:''}
    <p class="m-fine">Hover one to mark it cancelled, paused or hidden. Only the ones still going count in the total.</p>`;
}
function recRow(r,x){
  const when=x.again?`Charged again on ${shortDate(Date.parse(r.last))} after you cancelled`:x.st==='paused'?(x.m.until?`Paused until ${shortDate(Date.parse(x.m.until))}`:'Paused'):x.st==='cancelled'?`Cancelled ${shortDate(Date.parse(x.m.since))}`:r.lapsed?'last '+shortDate(Date.parse(r.last)):'next about '+shortDate(Date.parse(r.next));
  return `<div class="row m-hov"><span class="m-dot" style="background:${catCol(r.cat)}"></span><div class="main"><div class="t">${esc(r.name)}</div><div class="s">${r.every==='week'?'Weekly':r.every==='year'?'Yearly':'Monthly'} · <span${x.again?' class="m-warn"':''}>${esc(when)}</span>${x.m?.note?` · <span class="m-blurtext">${esc(x.m.note)}</span>`:''}</div></div><span class="acts"><button class="ibtn" data-msub="${esc(r.name)}" title="Cancelled, paused, hide…">${icon('dots')}</button></span><span class="r" style="color:var(--ink)">${amt(r.amount)}</span></div>`;
}
function subMenu(btn){
  const name=btn.dataset.msub; const k=name.toLowerCase(); const cur=MN.data.context?.subs?.[k]; const r=btn.getBoundingClientRect();
  const set=(v,msg)=>moneyContext({subs:{[name]:v}},msg);
  menu(r.left-170,r.bottom+6,[
    cur&&cur.status!=='active'?{label:'Still paying it',icon:'refresh',act:()=>set(null,`${name} counts again`)}:null,
    cur?.status!=='cancelled'?{label:'I cancelled it',icon:'close',act:()=>set({status:'cancelled',since:isoDay(),note:cur?.note},`${name} marked cancelled. If it charges again, you'll see it here`)}:null,
    cur?.status!=='paused'?{label:'Paused or frozen…',icon:'pause',act:()=>openSubSheet(name,'paused')}:null,
    {label:'Add a note…',icon:'note',act:()=>openSubSheet(name,cur?.status||'active')},
    'hr',
    {label:'Hide it',icon:'eyeoff',danger:true,act:()=>set({status:'hidden',since:isoDay(),note:cur?.note},`${name} hidden. Bring it back from ⋯ → Hidden payments`)},
  ]);
}
function openSubSheet(name,status){
  const cur=MN.data.context?.subs?.[name.toLowerCase()]||{};
  moneySheet('sheet-msub',`${sheetHead(esc(name))}
    <div class="field"><label>Status</label><div class="seg" id="ms-status">${[['active','Still paying'],['paused','Paused'],['cancelled','Cancelled']].map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${status===k}">${l}</button>`).join('')}</div></div>
    <div class="field"><label for="ms-until">Back on (optional)</label><input id="ms-until" type="date" value="${esc(cur.until||'')}"></div>
    <div class="field"><label for="ms-note">Note</label><input id="ms-note" value="${esc(cur.note||'')}" placeholder="Frozen while I'm in Belfast"></div>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async box=>{ const st=box.querySelector('#ms-status [aria-pressed="true"]')?.dataset.v||'active'; const ok=await moneyContext({subs:{[name]:{status:st,since:cur.since||isoDay(),until:$('ms-until').value,note:$('ms-note').value}}}); if(ok)closeOverlays(); });
  $('ms-status').addEventListener('click',e=>{ const b=e.target.closest('[data-v]'); if(!b)return; b.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); });
}

function txMatches(t,q){ if(!q)return true; const n=q.toLowerCase().replace(/^£/,''); return [t.name,t.notes,t.myNote,t.cat,t.description,t.type].some(x=>String(x||'').toLowerCase().includes(n))||Math.abs(t.amount).toFixed(2).startsWith(n); }
/* payments */
function txFiltered(){
  const v=MN.view; if(!v)return [];
  const kindOk=(t)=>MN.trip?(MN.trip==='unassigned'?t.kind==='spend'&&!t.trip&&t.cat==='Holidays':t.trip===MN.trip):MN.cat?t.cat===MN.cat&&t.kind==='spend':MN.txKind==='spend'?(t.kind==='spend'||t.kind==='planned'&&t.amount<0):MN.txKind==='in'?t.amount>0&&t.kind!=='pot':true;
  const dayOk=(t)=>!MN.day||(MN.day.length>10?t.date>=MN.day.slice(0,10)&&t.date<=MN.day.slice(11):t.date===MN.day);
  const inSpan=(t)=>MN.trip||MN.day||MN.q?true:t.date>=v.sp.from&&t.date<=v.sp.to;
  return v.P.filter(t=>!t.synthetic&&inSpan(t)&&dayOk(t)&&kindOk(t)&&txMatches(t,MN.q.trim())).reverse();
}
function txChips(){
  const trip=(MN.data.context?.trips||[]).find(x=>x.id===MN.trip);
  return [MN.cat?`<button type="button" class="chip" data-mcat="${esc(MN.cat)}" aria-pressed="true"><i class="sw" style="background:${catCol(MN.cat)}"></i>${esc(MN.cat)}${icon('close')}</button>`:'',
    MN.day?`<button type="button" class="chip" data-mday="" aria-pressed="true">${esc(MN.day.length>10?'Week of '+shortDate(Date.parse(MN.day.slice(0,10))):dayWord(Date.parse(MN.day+'T12:00:00')))}${icon('close')}</button>`:'',
    MN.trip?`<button type="button" class="chip" data-mtrip="" aria-pressed="true">${esc(MN.trip==='unassigned'?'Holidays not on a trip':trip?.name||'Trip')}${icon('close')}</button>`:'',
    MN.q?`<span class="m-span">Searching everything, not just ${esc(MN.view?.sp?.label||'this period')}</span>`:''].join('');
}
function txListHTML(){
  const list=txFiltered(); if(!MN.view)return '';
  if(!list.length)return `<div class="empty">${MN.q?'Nothing matches that.':'No payments here.'}</div>`;
  const trips=new Map((MN.data.context?.trips||[]).map(x=>[x.id,x.name]));
  let last=''; const rows=[];
  for(const t of list.slice(0,MN.shown)){
    if(t.date!==last){ last=t.date; rows.push(`<div class="m-day">${esc(dayWord(Date.parse(t.date+'T12:00:00')))}${daysUntil(t.date)<-6?' '+esc(MONTHS[Number(t.date.slice(5,7))-1].slice(0,3)):''}${t.date.slice(0,4)!==isoDay().slice(0,4)?' '+t.date.slice(0,4):''}</div>`); }
    const owed=(t.split||[]).filter(x=>!x.settled).reduce((a,x)=>a+x.amount,0);
    const tags=[t.kind!=='spend'?(t.planned?.income?'loan':KIND_TAG[t.kind]||t.kind):'',t.oneOff===true&&t.kind==='spend'?'one-off':'',t.trip?trips.get(t.trip):'',t.feel==='love'?'best buy':t.feel==='regret'?'regret':'',t.split?(owed?'owed back':'split, settled'):'',t.repays?'paid back by '+t.repays.who:''].filter(Boolean).map(x=>`<span class="tag${x==='regret'?' m-tag-regret':x==='best buy'?' m-tag-love':''}">${esc(x)}</span>`).join('');
    const sub=[esc(t.cat),t.time?esc(t.time):'',t.local?`<span class="amt">${esc(t.local.currency)} ${Math.abs(t.local.amount).toFixed(2)}</span>`:'',t.planned?`spread ${esc(shortDate(Date.parse(t.planned.from)))} to ${esc(shortDate(Date.parse(t.planned.to)))}`:'',t.notes?`<span class="m-blurtext">${esc(cap(t.notes,60))}</span>`:''].filter(Boolean).join(' · ');
    rows.push(`<div class="row m-txr m-hov"><span class="m-dot" style="background:${t.kind==='spend'?catCol(t.cat):'var(--dim2)'}"></span><div class="main"><div class="t">${esc(t.name||t.type)} ${tags}</div><div class="s">${sub}</div>${t.myNote?`<div class="m-mynote">${icon('note')}<span class="m-blurtext">${esc(t.myNote)}</span></div>`:''}</div>
      <span class="acts">${t.kind==='spend'&&t.amount<0?`<button class="ibtn" data-moneoff="${esc(t.id)}" title="${t.oneOff===true?'Count it day to day':'Rowan as a one-off'}|${t.oneOff===true?'Back in day-to-day spending':'Kept apart from day-to-day spending'}">${icon(t.oneOff===true?'undo':'bolt')}</button>`:''}<button class="ibtn" data-mtxedit="${esc(t.id)}" title="Note, category, trip, split…">${icon('edit')}</button></span>
      <span class="r m-amt ${t.amount>0?'m-plus':''}">${t.amount>0?'+':''}${amt(t.amount)}</span></div>`);
  }
  return `<div class="rows">${rows.join('')}</div>${list.length>MN.shown?`<button class="btn sm ghost" data-m="more-tx" style="margin-top:10px">Show more (${list.length-MN.shown} left)</button>`:''}`;
}
// One line over the list saying what it adds up to, so a search or a trip has a total.
function txSumHTML(){
  let list=txFiltered(); if(!MN.view)return '';
  const planned=list.filter(t=>t.kind==='planned'); list=list.filter(t=>t.kind!=='planned');
  const out=list.filter(t=>t.amount<0).reduce((a,t)=>a-t.amount,0), inn=list.filter(t=>t.amount>0).reduce((a,t)=>a+t.amount,0);
  if(!list.length)return '';
  const big=list.filter(t=>t.amount<0).sort((a,b)=>a.amount-b.amount)[0]; const dates=list.map(t=>t.date).sort();
  return `<b>${out?amt(out)+' out':''}${out&&inn?' · ':''}${inn?amt(inn)+' in':''}</b> across ${list.length} payment${list.length>1?'s':''}, ${esc(shortDate(Date.parse(dates[0])))} to ${esc(shortDate(Date.parse(dates[dates.length-1])))}${big&&list.length>2?`. Biggest: ${esc(cap(big.name,24))} ${amt(-big.amount)}`:''}${planned.length?`. Rent payments shown but counted over their terms`:''}.`;
}
// Splits: who still owes Owner for what.
async function moneyClaim(body){
  try { const j=await send('/api/money/receivables',body); MN.data.receivables=j.claims; MN.data.senders=j.senders; VIEWS.money.update(); return true; }
  catch(err){ toast(err.message); return false; }
}
function claimSenderOptions(selected=''){
  return `<option value="">Manual review only</option>`+(MN.data.senders||[]).map(s=>`<option value="${esc(s.id)}" ${s.id===selected?'selected':''}>${esc(s.names.join(' / '))} · ${esc(s.id)}</option>`).join('');
}
function openClaimSheet(id){
  const c=(MN.data.receivables||[]).find(c=>c.id===id);
  const box=moneySheet('sheet-mclaim',`${sheetHead(c?'Verify repayment sender':'Add money owed')}
    ${c?`<p>${esc(c.who)} · ${amt(c.amount)}</p>`:`<div class="field"><label for="mc-who">Who owes you?</label><input id="mc-who" required maxlength="80"></div><div class="field"><label for="mc-amount">Amount in GBP</label><input id="mc-amount" type="number" min="0.01" step="0.01" required></div><div class="field"><label for="mc-note">What is it for?</label><textarea id="mc-note" maxlength="400"></textarea></div>`}
    <div class="field"><label for="mc-sender">Verified bank sender</label><select id="mc-sender">${claimSenderOptions(c?.sender?.id)}</select></div><p class="m-fine">Confirm the sender from your bank records. Names alone cannot verify a repayment. Missing sender IDs or posting status need manual review.</p><div class="m-err" role="alert"></div><div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${c?'Verify sender':'Add claim'}</button></div>`, async()=>{
      const senderId=$('mc-sender').value;
      if(c&&!senderId){toast('Choose a verified bank sender');return;}
      if(await moneyClaim(c?{action:'link',id:c.id,senderId}:{action:'create',who:$('mc-who').value,amount:$('mc-amount').value,note:$('mc-note').value,...(senderId?{senderId}:{})}))closeOverlays();
    });
  return box;
}
function owedHTML(P){
  const rows=P.filter(t=>t.split&&t.split.length);
  const claims=MN.data.receivables||[];
  const open=rows.flatMap(t=>t.split.filter(x=>!x.settled).map(x=>({...x,t})));
  const total=open.reduce((a,x)=>a+x.amount,0)+claims.filter(c=>!c.settled).reduce((a,c)=>a+c.amount,0);
  const claimRow=c=>`<div class="row"><div class="main"><div class="t">${esc(c.who)}${c.settled?' · paid back':''}</div><div class="s m-blurtext">${esc(c.note)}</div><div class="s">${c.sender?'Sender: '+esc(c.sender.name):'Sender unverified · manual review only'}${c.matchedTransactionId?' · matched transaction '+esc(c.matchedTransactionId):''}</div>${(c.review||[]).length&&!c.settled?`<div class="s">Review: ${(c.review||[]).map(r=>esc(r.reason)+' ('+esc(r.transactionId)+')').join('; ')}</div>`:''}</div><span class="r">${amt(c.amount)}</span><span class="acts">${!c.settled?`<button class="btn sm ghost" data-mclaimlink="${esc(c.id)}">Link sender</button>`:''}<button class="btn sm ghost" data-mclaimact="${esc(c.id)}" data-action="${c.settled?'undo':'settle'}">${c.settled?'Undo':'Paid back'}</button></span></div>`;
  return `<section class="card"><div class="ch">${icon('reply')}<h2>Owed to you</h2><span class="sub">${amt(total)}</span><button class="btn sm ghost" data-mclaimadd>Add claim</button></div>
    <div class="rows">${claims.filter(c=>!c.settled).map(claimRow).join('')}${open.map(x=>`<div class="row m-hov" data-mtxedit="${esc(x.t.id)}" style="cursor:pointer"><div class="main"><div class="t">${esc(x.who)}</div><div class="s m-blurtext">${esc(cap(x.t.myNote||x.t.name,60))} · ${esc(shortDate(Date.parse(x.t.date)))}</div></div><span class="r">${amt(x.amount)}</span></div>`).join('')}</div>
    ${!total?'<p class="dim">Nobody owes you anything right now.</p>':''}
    ${claims.some(c=>c.settled)?`<div class="m-sub">Paid back</div><div class="rows">${claims.filter(c=>c.settled).map(claimRow).join('')}</div>`:''}
    ${(()=>{const back=rows.flatMap(t=>t.split.filter(x=>x.auto).map(x=>({...x,t})));return back.length?`<div class="m-sub">Split repayments</div><div class="rows">${back.map(x=>`<div class="row" data-mtxedit="${esc(x.t.id)}"><div class="main"><div class="t">${esc(x.who)}</div><div class="s">${esc(shortDate(Date.parse(x.auto.date)))} · spotted in Monzo</div></div><span class="r">${amt(x.auto.amount)}</span></div>`).join('')}</div>`:'';})()}
    <p class="m-fine">Standalone claims need no original payment. Automatic settlement requires one new posted GBP transfer, a verified sender and an exact amount. Undo keeps the repayment audit trail.</p></section>`;
}
function openTxSheet(id){
  const t=MN.view.P.find(x=>x.id===id); if(!t)return; const c=MN.data.context?.tx?.[id]||{};
  const cats=[...new Set(MN.view.P.filter(x=>!x.synthetic).map(x=>x.cat))].sort();
  const trips=MN.data.context?.trips||[];
  const tag=c.tag||'auto'; const split=(c.split||[]).map(x=>({...x}));
  const srow=(x,i)=>`<div class="m-splitrow" data-i="${i}"><input data-k="who" value="${esc(x.who||'')}" placeholder="Who" aria-label="Who"><input data-k="amount" inputmode="decimal" value="${x.amount??''}" placeholder="£ they owe" aria-label="Amount"><label class="m-check"><input type="checkbox" data-k="settled" ${x.settled?'checked':''}> Paid back</label><button type="button" class="ibtn" data-sdel="${i}" aria-label="Remove">${icon('trash')}</button></div>`;
  const box=moneySheet('sheet-mtx',`${sheetHead(`${esc(t.name)} <span class="dim" style="font-style:normal;font-size:15px">${amt(t.amount)} · ${esc(shortDate(Date.parse(t.date)))}</span>`)}
    <div class="field"><label for="mt-note">What was it?</label><textarea id="mt-note" rows="2" placeholder="Restocking the kitchen after moving back">${esc(c.note||'')}</textarea></div>
    <div class="field-row"><div class="field"><label>Counts as</label><div class="seg" id="mt-tag">${[['auto',t.amount<=-200?'Auto (one-off)':'Auto'],['normal','Day to day'],['one-off','One-off'],['leave-out','Leave it out']].map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${tag===k}">${l}</button>`).join('')}</div></div>
      <div class="field"><label>How do you feel about it?</label><div class="seg" id="mt-feel">${[['','No view'],['love','Best buy'],['regret','Regret it']].map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${(c.feel||'')===k}">${l}</button>`).join('')}</div></div></div>
    <div class="field-row"><div class="field"><label for="mt-cat">Category</label><input id="mt-cat" list="mt-cats" value="${esc(c.cat||'')}" placeholder="${esc(t.category||t.cat)}"><datalist id="mt-cats">${cats.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></div>
      <div class="field"><label for="mt-trip">Trip</label><select id="mt-trip"><option value="">${t.trip&&!c.trip?'Auto: '+esc(trips.find(x=>x.id===t.trip)?.name||''):'Auto'}</option><option value="none"${c.trip==='none'?' selected':''}>Not a trip</option>${trips.map(x=>`<option value="${esc(x.id)}"${c.trip===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}</select></div></div>
    <div class="field"><label>Split it</label><div id="mt-split">${split.map(srow).join('')}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px"><button type="button" class="btn sm ghost" id="mt-sadd">${icon('plus')}Add someone</button>${t.amount<0?`<button type="button" class="btn sm ghost" id="mt-seven">Share it evenly</button>`:''}</div></div>
    <p class="dim" style="font-size:12.5px">Notes go to your adviser too, so it knows why a week looked odd.</p>
    <div class="m-err" role="alert"></div>
    <div class="foot">${Object.keys(c).length?'<button type="button" class="btn ghost danger" id="mt-clear">Clear</button>':''}<span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async b=>{ const v=b.querySelector('#mt-tag [aria-pressed="true"]')?.dataset.v; const feel=b.querySelector('#mt-feel [aria-pressed="true"]')?.dataset.v||'';
      const sp=[...b.querySelectorAll('.m-splitrow')].map(el=>({who:el.querySelector('[data-k=who]').value.trim(),amount:parseFloat(el.querySelector('[data-k=amount]').value.replace(/[^0-9.]/g,''))||0,settled:el.querySelector('[data-k=settled]').checked})).filter(x=>x.who&&x.amount>0);
      const ok=await moneyContext({tx:{[id]:{note:$('mt-note').value,tag:v==='auto'?'':v,cat:$('mt-cat').value,trip:$('mt-trip').value,feel,split:sp}}},'Saved'); if(ok)closeOverlays(); });
  box.addEventListener('click',e=>{ const x=e.target.closest('.seg [data-v]'); if(x){ x.parentElement.querySelectorAll('button').forEach(y=>y.setAttribute('aria-pressed',String(y===x))); return; }
    if(e.target.closest('#mt-sadd')){ split.push({}); $('mt-split').insertAdjacentHTML('beforeend',srow({},split.length-1)); $('mt-split').lastElementChild.querySelector('input').focus(); return; }
    if(e.target.closest('#mt-seven')){ const rows=[...box.querySelectorAll('.m-splitrow')]; if(!rows.length){ toast('Add the people first'); return; } const each=Math.round(Math.abs(t.amount)/(rows.length+1)*100)/100; rows.forEach(r=>{ r.querySelector('[data-k=amount]').value=each.toFixed(2); }); return; }
    const d=e.target.closest('[data-sdel]'); if(d)d.closest('.m-splitrow').remove(); });
  $('mt-clear')?.addEventListener('click',async()=>{ if(await moneyContext({tx:{[id]:null}},'Cleared'))closeOverlays(); });
}
function openTripSheet(id){
  const trips=(MN.data.context?.trips||[]).map(x=>({...x})); const cur=trips.find(x=>x.id===id)||{kind:'holiday'};
  const box=moneySheet('sheet-mtrip',`${sheetHead(id?'Edit':'New trip or highlight')}
    <div class="field"><label>What kind</label><div class="seg" id="mtr-kind">${Object.entries(TRIP_KINDS).map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${(cur.kind||'holiday')===k}">${l}</button>`).join('')}</div></div>
    <div class="field-row"><div class="field"><label for="mtr-name">Name</label><input id="mtr-name" value="${esc(cur.name||'')}" placeholder="Skiing, Leeds weekend…" required></div><div class="field"><label for="mtr-with">With</label><input id="mtr-with" value="${esc(cur.with||'')}" placeholder="Jack"></div></div>
    <div class="field-row"><div class="field"><label for="mtr-from">From</label><input id="mtr-from" type="date" value="${esc(cur.from||'')}"></div><div class="field"><label for="mtr-to">To</label><input id="mtr-to" type="date" value="${esc(cur.to||'')}"></div></div>
    <div class="field-row"><div class="field"><label for="mtr-budget">Budget or rough cost</label><input id="mtr-budget" inputmode="decimal" value="${cur.budget??''}" placeholder="£"></div><div class="field"><label for="mtr-note">Note</label><input id="mtr-note" value="${esc(cur.note||'')}"></div></div>
    <p class="dim" style="font-size:12.5px">Holiday payments, and anything paid in another currency, inside these dates join on their own. Add others from a payment's edit button.</p>
    <div class="m-err" role="alert"></div>
    <div class="foot">${id?'<button type="button" class="btn ghost danger" id="mtr-del">Delete</button>':''}<span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async b=>{ const t={id:cur.id,kind:b.querySelector('#mtr-kind [aria-pressed="true"]')?.dataset.v||'holiday',name:$('mtr-name').value,with:$('mtr-with').value,from:$('mtr-from').value,to:$('mtr-to').value,budget:parseFloat($('mtr-budget').value.replace(/[^0-9.]/g,''))||null,note:$('mtr-note').value};
      const next=id?trips.map(x=>x.id===id?t:x):[...trips,t]; if(await moneyContext({trips:next},'Saved'))closeOverlays(); });
  box.addEventListener('click',e=>{ const x=e.target.closest('.seg [data-v]'); if(x)x.parentElement.querySelectorAll('button').forEach(y=>y.setAttribute('aria-pressed',String(y===x))); });
  $('mtr-del')?.addEventListener('click',async()=>{ if(!confirm(`Delete "${cur.name}"? Its payments stay, just not grouped.`))return; if(await moneyContext({trips:trips.filter(x=>x.id!==id)},'Deleted'))closeOverlays(); });
}
function openNotesSheet(){
  const ctx=MN.data.context||{}; const notes=(ctx.notes||[]).map(x=>({...x}));
  const row=(n,i)=>`<div class="m-noterow" data-i="${i}"><textarea data-k="text" rows="2" placeholder="Something that explains a week or a month">${esc(n.text||'')}</textarea><div class="m-nd"><input data-k="from" type="date" value="${esc(n.from||'')}" aria-label="From"><input data-k="to" type="date" value="${esc(n.to||'')}" aria-label="To"><button type="button" class="ibtn" data-del="${i}" aria-label="Remove">${icon('trash')}</button></div></div>`;
  const box=moneySheet('sheet-mnotes',`${sheetHead('What your adviser should know')}
    <div class="field"><label for="mn-prof">About you</label><textarea id="mn-prof" rows="4">${esc(ctx.profile||'')}</textarea></div>
    <div class="field"><label>Notes, with dates if they're about a stretch of time</label><div id="mn-rows">${notes.map(row).join('')}</div><button type="button" class="btn sm ghost" id="mn-add" style="margin-top:6px">${icon('plus')}Add a note</button></div>
    <p class="dim" style="font-size:12.5px">Only your adviser and agents you connect read these. They stay on the Home Mac.</p>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async ()=>{ const list=[...document.querySelectorAll('#mn-rows .m-noterow')].map(el=>{ const g=(k)=>el.querySelector(`[data-k="${k}"]`).value.trim(); return {id:notes[Number(el.dataset.i)]?.id,text:g('text'),from:g('from'),to:g('to')}; }).filter(n=>n.text);
      if(await moneyContext({profile:$('mn-prof').value,notes:list},'Saved. Ask again to get a fresh note'))closeOverlays(); });
  box.addEventListener('click',e=>{ if(e.target.closest('#mn-add')){ notes.push({}); $('mn-rows').insertAdjacentHTML('beforeend',row({},notes.length-1)); $('mn-rows').lastElementChild.querySelector('textarea').focus(); } const d=e.target.closest('[data-del]'); if(d)d.closest('.m-noterow').remove(); });
}
function openPlanSheet(id){
  const plan=JSON.parse(JSON.stringify(MN.data.plans?.[id]||{})); if(!plan.id)return;
  const box=moneySheet('sheet-mplan',`${sheetHead(esc(plan.name))}
    <p class="dim" style="font-size:13px;margin-bottom:12px">Your statement is the source of truth. If the discount comes through, change the instalment it comes off and tick it below.</p>
    ${(plan.instalments||[]).map((i,n)=>`<div class="m-insrow" data-n="${n}"><span>${esc(shortDate(Date.parse(i.from)))} to ${esc(shortDate(Date.parse(i.to)))}</span><input data-k="due" type="date" value="${esc(i.due||'')}" aria-label="Due"><input data-k="amount" inputmode="decimal" value="${i.amount}" aria-label="Amount"></div>`).join('')}
    ${(plan.pending||[]).map((x,n)=>`<label class="m-check" style="margin-top:12px"><input type="checkbox" data-pend="${n}" ${x.done?'checked':''}> ${esc(x.text)} <b>Done</b></label>`).join('')}
    <div class="field" style="margin-top:12px"><label for="mp-note">Note</label><input id="mp-note" value="${esc(plan.note||'')}"></div>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async b=>{ b.querySelectorAll('.m-insrow').forEach(el=>{ const i=plan.instalments[Number(el.dataset.n)]; i.due=el.querySelector('[data-k=due]').value||i.due; const a=parseFloat(el.querySelector('[data-k=amount]').value.replace(/[^0-9.]/g,'')); if(a>0)i.amount=a; });
      b.querySelectorAll('[data-pend]').forEach(el=>{ plan.pending[Number(el.dataset.pend)].done=el.checked; }); plan.note=$('mp-note').value;
      const j=await send('/api/money/plans',{...MN.data.plans,[id]:plan},'PUT'); MN.data.plans=j.plans; closeOverlays(); toast('Plan saved'); VIEWS.money.update(); });
  return box;
}
function openPaletteSheet(){
  const cur=MN.data.settings?.palette in M_PALETTES?MN.data.settings.palette:'meaning'; const cats=['Rent','Bills','Groceries','Transport','Eating out','Entertainment','Shopping','Holidays'];
  const box=moneySheet('sheet-mpal',`${sheetHead('Colours')}
    <p class="dim" style="font-size:13px;margin-bottom:12px">Every set keeps the same jobs: needs in one family, wants in another, the rest grey; green for money in, coral for money out, blue for money put away. Click one to try it; it sticks on every device.</p>
    <div class="m-pals">${Object.entries(M_PALETTES).map(([k,p0])=>{ const p=k==='today'?todayPalette():p0; if(!p)return ''; return `<button type="button" class="m-pal${k===cur?' on':''}" data-pal="${k}"><b>${esc(p0.name)}</b><small>${esc(k==='today'&&p.names?`${p.names.join(' and ')}, from today's almanac`:p0.hint||'')}</small><span class="m-sw">${(p.mono?['var(--accent)','#d4d4d8','#a8a8ae','#86868c','#6a6a70','#55555b','#55555b','#55555b']:cats.map(c=>p.cats[c])).map(c=>`<i style="background:${c}"></i>`).join('')}</span><span class="m-sw m-io">${p.io.map(c=>`<i style="background:${c}"></i>`).join('')}</span></button>`; }).join('')}</div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn primary" data-close>Done</button></div>`,async()=>closeOverlays());
  box.addEventListener('click',async e=>{ const b=e.target.closest('[data-pal]'); if(!b)return; box.querySelectorAll('.m-pal').forEach(x=>x.classList.toggle('on',x===b));
    MN.data.settings={...MN.data.settings,palette:b.dataset.pal}; VIEWS.money.update(); send('/api/money/settings',{palette:b.dataset.pal},'PUT').catch(err=>toast(err.message)); });
}
const T2_PERIODS=[['all','All time'],['3m','3 months'],['1m','1 month'],['1w','1 week']];
function t212Groups(t){
  const pos=t.positions||[]; const byT=new Map(pos.map(p=>[p.ticker,p]));
  const orders=(t.orders||[]).filter(o=>o.side!=='SELL'&&o.price).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const firstBuy=(tk)=>orders.find(o=>o.ticker===tk);
  const sinceFirst=(p)=>{ const f=firstBuy(p.ticker); return f&&p.currentPrice?{pct:(p.currentPrice/f.price-1)*100,date:f.date}:null; };
  // No emoji, and no "Owner's" in front: it's his dashboard.
  const clean=(n)=>String(n).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu,'').replace(/^Owner[’']s\s+/i,'').replace(/\s+/g,' ').trim().replace(/^./,c=>c.toUpperCase());
  // What Owner told it about buys Trading 212's history doesn't show (context.lots).
  const told=(MN.data?.context?.lots||[]);
  const groups=(t.pies||[]).map(pie=>({kind:'pie',id:'pie-'+pie.id,name:clean(pie.name),value:pie.value+(pie.cash||0),cost:pie.invested,gain:pie.result,lots:told.filter(l=>l.pie===pie.id||l.pieName&&clean(pie.name).toLowerCase().includes(l.pieName.toLowerCase())).map(l=>({date:l.date,value:l.value,side:'BUY',from:'you'})),
    items:pie.instruments.map(i=>({ticker:i.ticker,name:byT.get(i.ticker)?.name||i.ticker,value:i.value,cost:i.invested,gain:i.result,since:byT.get(i.ticker)?sinceFirst(byT.get(i.ticker)):null})).sort((a,b)=>b.value-a.value)}));
  for(const p of pos){ const outside=(p.quantity||0)-(p.inPies||0); if(outside<=1e-6||p.value==null)continue; const f=outside/(p.quantity||1);
    const mine=told.filter(l=>l.ticker===p.ticker).map(l=>({date:l.date,value:l.value,side:'BUY',from:'you'})); const lastMine=mine.map(l=>l.date).sort().pop()||'';
    const lots=[...mine,...(t.orders||[]).filter(o=>o.ticker===p.ticker&&o.date>lastMine)].sort((a,b)=>a.date.localeCompare(b.date));
    groups.push({kind:'holding',id:'h-'+p.ticker,ticker:p.ticker,name:p.name,value:p.value*f,cost:(p.cost||0)*f,gain:(p.ppl||0)*f,since:sinceFirst(p),lots}); }
  return groups.sort((a,b)=>b.value-a.value);
}
function t212Period(t,history){
  const a=t.account; const id=MN.t2p||'all';
  if(id==='all')return {gain:a.unrealised+(a.realised||0),base:a.cost,label:'all time'};
  const days={'3m':91,'1m':30,'1w':7}[id]; const from=MC.addDays(isoDay(),-days);
  const then=[...history].filter(h=>h.date<=from).pop();
  if(!then)return {none:true,first:history[0]?.date,label:T2_PERIODS.find(x=>x[0]===id)[1].toLowerCase()};
  const gain=(a.value-a.cost)-(then.value-then.cost); return {gain,base:then.value,label:'in the last '+T2_PERIODS.find(x=>x[0]===id)[1].toLowerCase()};
}
// Trading 212: worth and gain up top, how the money's split across what you
// hold, then each holding with what went in against what it's worth now.
const T2_COLS=['#3fd68f','#5b9dff','#ffb547','#b7a1ff','#ff6fa3','#2fd6e8','#c2e07a','#ff8a4c'];
function t212HTML(t,st,history){
  const head=`<div class="ch">${icon('chart')}<h2>Trading 212</h2>${t?`<span class="sub">${t.source==='api'&&t.asOf===isoDay()?'read today':'as of '+esc(shortDate(Date.parse(t.asOf)))}</span>`:''}${t?`<span class="end"><div class="seg" role="group">${T2_PERIODS.map(([k,l])=>`<button type="button" data-mt2p="${k}" aria-pressed="${(MN.t2p||'all')===k}">${l}</button>`).join('')}</div></span>`:''}</div>`;
  const keyBad=st&&st.code==='key-rejected';
  const fix=keyBad||!st?`<div class="m-note">${icon('bolt')}<span>${keyBad?'Trading 212 turned down the saved API key, so these numbers are from the last good read.':'Not connected yet.'} <button type="button" class="m-link" data-m="t212key">Add a new read-only key</button></span></div>`:st&&!st.ok?`<div class="m-note">${icon('bolt')}<span>${esc(st.error)}</span></div>`:'';
  if(!t)return head+fix+'<div class="empty">No portfolio yet.</div>';
  const a=t.account; const per=t212Period(t,history); const groups=t212Groups(t);
  const pct=(g,b)=>b?` (${g>=0?'+':''}${(g/b*100).toFixed(1)}%)`:'';
  const sinceAll=groups.filter(g=>g.since).reduce((x,g)=>({w:x.w+g.value,s:x.s+g.since.pct*g.value}),{w:0,s:0});
  const totV=groups.reduce((x,g)=>x+g.value,0)||1; const scale=Math.max(1,...groups.map(g=>Math.max(g.value,g.cost||0)));
  const col=(i)=>T2_COLS[i%T2_COLS.length];
  // Bullet bar: grey is what went in; the coloured part is what it's worth, green past it, red short of it.
  const bullet=(g)=>{ const c=g.cost||0, v=g.value; const lo=Math.min(c,v)/scale*100, hi=Math.max(c,v)/scale*100;
    return `<span class="m-bullet"><i class="m-b-in" style="width:${(c/scale*100).toFixed(1)}%"></i><i class="m-b-${v>=c?'up':'down'}" style="left:${lo.toFixed(1)}%;width:${Math.max(0.6,hi-lo).toFixed(1)}%"></i></span>`; };
  const row=(g,i)=>{ const open=MN.openGroup===g.id; const canOpen=g.kind==='pie'||(g.lots||[]).length||g.since;
    const onRecord=(g.lots||[]).filter(o=>o.side!=='SELL').reduce((x,o)=>x+(o.value||0),0);
    return `<div class="m-grp${open?' open':''}" id="m-${esc(g.id)}"><button type="button" class="m-grph" ${canOpen?`data-mgroup="${esc(g.id)}"`:''}><span class="m-gn">${canOpen?icon('chev'):''}<i class="m-gsw" style="background:${col(i)}"></i><b>${esc(g.name)}</b>${g.kind==='pie'?`<span class="tag">pie · ${g.items.length}</span>`:''}</span><span class="m-gv">${amt(g.value)}<small>put in ${amt(g.cost)}</small></span><span class="m-gg ${g.gain<0?'m-neg':'m-pos'}">${g.gain>=0?'+':''}${amt(g.gain)}<small>${esc(pct(g.gain,g.cost))}</small></span>${bullet(g)}</button>
      ${open?(g.kind==='pie'?`<div class="m-gbody">${(g.lots||[]).length?`<p class="m-fine" style="margin:0 0 8px">${g.lots.map(l=>`${amt(l.value)} on ${esc(shortDate(Date.parse(l.date)))} ${esc(l.date.slice(0,4))}`).join(', ')}, from what you told me.</p>`:''}<div class="m-gi m-gih"><span>In this pie</span><span>Worth</span><span>Put in</span><span>Gain</span></div>${g.items.map(x=>`<div class="m-gi"><span>${esc(x.name)}</span><span>${amt(x.value)}</span><span class="dim">${amt(x.cost)}</span><span class="${x.gain<0?'m-neg':'m-pos'}">${x.gain>=0?'+':''}${amt(x.gain)}</span></div>`).join('')}</div>`
        :`<div class="m-gbody">${g.since?`<p class="m-fine" style="margin:0 0 8px">Price ${g.since.pct>=0?'up':'down'} <b>${Math.abs(g.since.pct).toFixed(1)}%</b> since your first buy on ${esc(shortDate(Date.parse(g.since.date)))}.</p>`:''}${(g.lots||[]).length?`<div class="m-gi m-gih"><span>Money in</span><span>Amount</span><span></span><span></span></div>${g.lots.map(o=>`<div class="m-gi"><span>${o.side==='SELL'?'Sold':'Bought'} ${esc(shortDate(Date.parse(o.date)))} ${esc(o.date.slice(0,4))}</span><span>${amt(o.value||0)}</span><span class="dim">${o.from==='you'?'from you':o.from==='AUTOINVEST'?'auto':''}</span><span></span></div>`).join('')}`:''}
          ${onRecord&&g.cost&&onRecord<g.cost*0.9?`<p class="m-fine">Trading 212's order history only lists ${amt(onRecord)} of the ${amt(g.cost)} you've put in. Tell me the rest and I'll show it.</p>`:''}</div>`):''}</div>`; };
  const snaps=(history||[]).length;
  return head+fix+`<div class="m-t212"><div class="stat"><div class="lab">Worth</div><div class="val m-big">${amt(a.value)}</div><div class="delta">${per.none?`Not enough history for ${esc(per.label)} yet: daily readings began ${per.first?esc(shortDate(Date.parse(per.first))):'today'}.`:`<b class="${per.gain<0?'m-neg':'m-pos'}">${per.gain>=0?'+':''}${amt(per.gain)}${esc(pct(per.gain,per.base))}</b> ${esc(per.label)}, new money left out`} · put in ${amt(a.cost)}${a.cash>=1?` · ${amt(a.cash)} cash`:''}</div>
      ${sinceAll.w?`<div class="delta">Prices are up <b>${(sinceAll.s/sinceAll.w).toFixed(1)}%</b> since your first buys, value-weighted.<span class="m-why" title="Why the two numbers differ|Adding money bit by bit makes the overall % look smaller, because the newest money hasn't had time to grow. Price since first buy shows how the things you picked have done.">${icon('sparkle')}</span></div>`:''}</div>
    <div class="m-alloc"><div class="lab">How it's split</div><div class="m-allocbar">${groups.map((g,i)=>`<span style="flex:${(g.value/totV).toFixed(4)};background:${col(i)}" title="${esc(g.name)}|${Math.round(g.value/totV*100)}%"></span>`).join('')}</div>
      <div class="m-allock">${groups.slice(0,6).map((g,i)=>`<span><i style="background:${col(i)}"></i>${esc(cap(g.name,26))} <b>${Math.round(g.value/totV*100)}%</b></span>`).join('')}</div>
      ${snaps>=5?`<div class="m-hist" id="m-hist"></div>`:`<p class="m-fine">A value line appears once there are a few days of readings (${snaps} so far, one a day since ${history[0]?esc(shortDate(Date.parse(history[0].date))):'today'}).</p>`}</div></div>
    <div class="m-grps"><div class="m-grph m-grph-h"><span>Holding</span><span>Worth</span><span>Gain</span><span class="m-bk"><i class="m-b-in"></i>put in <i class="m-b-up"></i>gain <i class="m-b-down"></i>loss</span></div>${groups.map(row).join('')}</div>`;
}
function accountsHTML(P,t){
  const acc=MN.data.accounts||[]; const all=MC.summarize(P,MC.periodSpan('all',P,isoDay()));
  const total=(t?.account?.value||0)+acc.reduce((s,a)=>s+(a.kind==='credit'?-Math.abs(a.balance):a.balance),0);
  return `<div class="ch">${icon('bank')}<h2>Accounts</h2><span class="end"><button class="btn sm ghost" data-m="accounts">${icon('edit')}Edit balances</button></span></div>
    <div class="stat" style="margin-bottom:12px"><div class="lab">What Meridian can see</div><div class="val">${amt(total)}</div><div class="delta">Trading 212 plus balances you've typed in${acc.length?'':'. Add your LISA, savings or other cards to fill this out'}</div></div>
    <div class="rows">${t?`<div class="row"><span class="m-dot" style="background:var(--m-in)"></span><div class="main"><div class="t">Trading 212</div><div class="s">${t.source==='api'?'read every day':'as of '+esc(shortDate(Date.parse(t.asOf)))}</div></div><span class="r" style="color:var(--ink)">${amt(t.account.value)}</span></div>`:''}
    ${acc.map(a=>`<div class="row"><span class="m-dot" style="background:${a.kind==='credit'?'var(--m-out)':'var(--m-save)'}"></span><div class="main"><div class="t">${esc(a.name)}</div><div class="s">${esc(ACC_KINDS[a.kind]||a.kind)} · as of ${esc(shortDate(Date.parse(a.asOf)))}${a.note?` · <span class="m-blurtext">${esc(a.note)}</span>`:''}</div></div><span class="r" style="color:var(--ink)">${amt(a.kind==='credit'?-Math.abs(a.balance):a.balance)}</span></div>`).join('')}</div>
    ${all.destinations.length?`<div class="m-sub">Paid in from Monzo since ${esc(shortDate(Date.parse(all.from)))}</div><div class="rows">${all.destinations.map(x=>`<div class="row"><div class="main"><div class="t">${esc(x.name)}</div></div><span class="r">${amt(x.amount)}</span></div>`).join('')}</div>`:''}`;
}
const ACC_KINDS={current:'Current account',savings:'Savings',isa:'ISA',lisa:'Lifetime ISA',pension:'Pension',investments:'Investments',credit:'Credit card (owed)',other:'Other'};

/* charts */
const M_GRANS=[['day','Day'],['week','Week'],['month','Month']];
// Buckets for the trend: the last 5 weeks of days, 16 weeks, or every month on
// record. Day-to-day spending by family; one-offs kept aside as markers.
function trendBuckets(P,gran){
  const today=isoDay(); const wk=(d)=>{ const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()-((x.getDay()+6)%7)); return isoDay(x); };
  const first=P.find(t=>!t.synthetic)?.date||today;
  let start=gran==='day'?MC.addDays(today,-34):gran==='week'?wk(MC.addDays(today,-7*15)):(first.slice(0,7)+'-01');
  if(start<first&&gran!=='month')start=gran==='week'?wk(first):first;
  const keyOf=(d)=>gran==='day'?d:gran==='week'?wk(d):d.slice(0,7)+'-01';
  const map=new Map(); const out=[];
  for(let d=start;d<=today;d=MC.addDays(d,1)){ const k=keyOf(d); if(!map.has(k)){ const b={key:k,from:d,to:d,need:0,want:0,other:0,oneoffs:[]}; map.set(k,b); out.push(b); } map.get(k).to=d; }
  for(const t of P){ if(t.kind!=='spend'||t.date<start||t.date>today)continue; const b=map.get(keyOf(t.date)); if(!b)continue;
    if(t.amount<0&&!t.synthetic&&MC.isLump(t)){ b.oneoffs.push(t); continue; }
    b[MC.groupOf(t.cat)]-=t.amount; }
  out.forEach(b=>{ for(const g of ['need','want','other'])b[g]=Math.max(0,b[g]); b.total=b.need+b.want+b.other; b.partial=b.to===today&&gran!=='day'; });
  return out;
}
// A smooth line through points that never overshoots (monotone cubic).
function smoothPath(pts,move=true){
  if(!pts.length)return ''; if(pts.length===1)return `${move?'M':'L'}${pts[0][0]} ${pts[0][1]}`;
  const n=pts.length, dx=[], m=[], t=[];
  for(let i=0;i<n-1;i++){ dx[i]=pts[i+1][0]-pts[i][0]; m[i]=(pts[i+1][1]-pts[i][1])/(dx[i]||1); }
  t[0]=m[0]; t[n-1]=m[n-2]; for(let i=1;i<n-1;i++)t[i]=m[i-1]*m[i]<=0?0:(m[i-1]+m[i])/2;
  for(let i=0;i<n-1;i++){ if(m[i]===0){ t[i]=0; t[i+1]=0; continue; } const a=t[i]/m[i], b=t[i+1]/m[i], h=Math.hypot(a,b); if(h>3){ t[i]=3*a/h*m[i]; t[i+1]=3*b/h*m[i]; } }
  let d=`${move?'M':'L'}${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for(let i=0;i<n-1;i++){ const h=dx[i]/3; d+=`C${(pts[i][0]+h).toFixed(1)} ${(pts[i][1]+t[i]*h).toFixed(1)} ${(pts[i+1][0]-h).toFixed(1)} ${(pts[i+1][1]-t[i+1]*h).toFixed(1)} ${pts[i+1][0].toFixed(1)} ${pts[i+1][1].toFixed(1)}`; }
  return d;
}
function trendChart(host){
  const v=MN.view; const gran=MN.gran||'week'; const b=trendBuckets(v.P,gran); if(b.length<2){ host.innerHTML='<div class="empty">Not enough history for this yet.</div>'; return; }
  const W=Math.max(320,host.clientWidth), H=host.clientHeight||240, padL=48, padR=10, padT=26, padB=24; const iw=W-padL-padR, ih=H-padT-padB;
  const full=b.filter(x=>!x.partial); const avg=full.length?full.reduce((a,x)=>a+x.total,0)/full.length:0;
  const max=niceMax(Math.max(...b.map(x=>x.total),avg,1)); const X=(i)=>padL+(b.length===1?iw/2:i/(b.length-1)*iw), Y=(val)=>padT+ih-val/max*ih;
  const layers=[['need'],['need','want'],['need','want','other']];
  const tops=layers.map(ks=>b.map((x,i)=>[X(i),Y(ks.reduce((a,k)=>a+x[k],0))]));
  const base=b.map((x,i)=>[X(i),Y(0)]);
  const area=(top,bot)=>smoothPath(top)+`L${top[top.length-1][0].toFixed(1)} ${bot[bot.length-1][1].toFixed(1)}`+smoothPath(bot.slice().reverse(),false).replace(/^L/,'L')+'Z';
  const fams=['need','want','other'];
  let defs=''; let shapes='';
  fams.forEach((g,i)=>{ defs+=`<linearGradient id="mtg-${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${famCol(g)}" stop-opacity=".62"/><stop offset="1" stop-color="${famCol(g)}" stop-opacity=".22"/></linearGradient>`;
    shapes+=`<path d="${area(tops[i],i?tops[i-1]:base)}" fill="url(#mtg-${g})"/><path d="${smoothPath(tops[i])}" fill="none" stroke="${famCol(g)}" stroke-width="${i===2?2.2:1.4}" stroke-linejoin="round" stroke-linecap="round"${i<2?' opacity=".8"':''}/>`; });
  // The selected period, as a soft band.
  const sp=v.sp; const i0=b.findIndex(x=>x.to>=sp.from), i1=b.length-1-[...b].reverse().findIndex(x=>x.from<=sp.to);
  const band=i0>=0&&i1>=i0&&!(i0===0&&i1===b.length-1)?`<rect x="${(X(i0)-(i0?iw/(b.length-1)/2:0)).toFixed(1)}" y="${padT}" width="${Math.max(6,X(i1)-X(i0)+(iw/(b.length-1))*((i0?0.5:0)+(i1<b.length-1?0.5:0))).toFixed(1)}" height="${ih}" fill="var(--ink)" opacity=".04" rx="6"/>`:'';
  const ticks=[0,.5,1].map(f=>f*max); const every=Math.max(1,Math.ceil(b.length/(W<520?4:7)));
  const lab=(x)=>{ const d=new Date(x.key+'T12:00:00'); return gran==='month'?MONTHS[d.getMonth()].slice(0,3):`${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`; };
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending over time, needs and wants"><defs>${defs}</defs>${band}<g class="grid">${ticks.map(t=>`<line x1="${padL}" x2="${W-padR}" y1="${Y(t)}" y2="${Y(t)}"/>`).join('')}</g><g class="axis">${ticks.map(t=>`<text x="${padL-8}" y="${Y(t)+3}" text-anchor="end">${gbp(t)}</text>`).join('')}${b.map((x,i)=>i%every===0||i===b.length-1?`<text x="${X(i)}" y="${H-6}" text-anchor="${i===b.length-1?'end':i===0?'start':'middle'}">${esc(lab(x))}</text>`:'').join('')}</g>${shapes}`;
  if(avg)svg+=`<line x1="${padL}" x2="${W-padR}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="var(--dim)" stroke-dasharray="3 5" stroke-width="1.2"/>`;
  // One-offs sit in a lane along the top so they don't flatten everything else.
  b.forEach((x,i)=>{ if(!x.oneoffs.length)return; const sum=x.oneoffs.reduce((a,t)=>a-t.amount,0); svg+=`<line x1="${X(i)}" x2="${X(i)}" y1="${padT-8}" y2="${Y(x.total)}" stroke="var(--dim2)" stroke-dasharray="2 3"/><circle cx="${X(i)}" cy="${padT-12}" r="${Math.min(8,3+Math.sqrt(sum)/8).toFixed(1)}" fill="var(--m-out)" opacity=".9"/>`; });
  const last=b.length-1; svg+=`<circle cx="${X(last)}" cy="${Y(b[last].total)}" r="3.5" fill="var(--page)" stroke="${famCol('other')}" stroke-width="2"/>`;
  svg+=`<line class="m-guide" x1="0" x2="0" y1="${padT}" y2="${padT+ih}" stroke="var(--ink)" stroke-opacity=".25" style="display:none"/>`;
  svg+=b.map((x,i)=>`<rect class="m-hit" data-i="${i}" x="${(X(i)-iw/(b.length-1)/2).toFixed(1)}" y="0" width="${(iw/(b.length-1)).toFixed(1)}" height="${H}" fill="transparent" style="cursor:pointer"/>`).join('');
  host.innerHTML=svg+'</svg>';
  const tip=$('tip'); const guide=host.querySelector('.m-guide');
  const title=(x)=>{ const d=new Date(x.key+'T12:00:00'); return gran==='month'?`${MONTHS[d.getMonth()]} ${d.getFullYear()}`:gran==='week'?`Week of ${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`:`${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`; };
  host.querySelectorAll('.m-hit').forEach(r=>{ const i=Number(r.dataset.i); const x=b[i];
    const show=(ev)=>{ guide.style.display=''; guide.setAttribute('x1',X(i)); guide.setAttribute('x2',X(i));
      tip.innerHTML=`<div class="d">${esc(title(x))}${x.partial?', so far':''}</div>`+[['need','Needs'],['want','Wants'],['other','Other']].map(([g,l])=>`<div class="l"><i style="background:${famCol(g)}"></i><b>${gbp(x[g],{exact:true})}</b><span>${l}</span></div>`).join('')+`<div class="l"><i style="background:transparent"></i><b>${gbp(x.total,{exact:true})}</b><span>Day to day</span></div>`+x.oneoffs.map(t=>`<div class="l"><i style="background:var(--m-out)"></i><b>${gbp(-t.amount,{exact:true})}</b><span>${esc(cap(t.name,24))}, one-off</span></div>`).join('')+'<div class="l" style="opacity:.6"><span>Click to see these payments</span></div>';
      tip.classList.add('on'); const tw=tip.offsetWidth, th=tip.offsetHeight; tip.style.left=Math.min(innerWidth-tw-10,ev.clientX+14)+'px'; tip.style.top=Math.max(10,ev.clientY-th-12)+'px'; };
    r.addEventListener('pointermove',show); r.addEventListener('pointerenter',show);
    r.addEventListener('pointerleave',()=>{ tip.classList.remove('on'); guide.style.display='none'; });
    r.addEventListener('click',()=>{ tip.classList.remove('on'); if(gran==='month'){ MN.period='m:'+x.key.slice(0,7); MN.day=''; VIEWS.money.update(); return; }
      MN.day=gran==='week'?`${x.from}:${x.to}`:x.key; MN.cat=''; MN.trip=''; MN.shown=40; VIEWS.money.update(); $('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}); }); });
}
function moneyCharts(){
  const v=MN.view; if(!v)return;
  const host=$('m-chart'); if(host)trendChart(host);
  const mh=$('m-months'); if(mh)monthColumns(mh,MC.monthly(v.P,isoDay()));
  const hh=$('m-hist'); if(hh)valueLine(hh,MN.data.history||[]);
}
// Where it went: a donut of categories, needs against wants, and the period in a line.
function whereHTML(P,sp,s){
  const cats=s.categories.filter(c=>c.spent>0); const tot=cats.reduce((a,c)=>a+c.spent,0)||1;
  if(!cats.length)return `<div class="ch">${icon('pie')}<h2>Where it went</h2></div><div class="empty">No spending ${esc(sp.label)}.</div>`;
  const R=62, r=44, C=74; let a0=-Math.PI/2; const arcs=cats.map(c=>{ const a1=a0+c.spent/tot*Math.PI*2; const gap=cats.length>1?0.018:0; const s0=a0+gap, s1=Math.max(s0+0.001,a1-gap);
    const p=(ang,rad)=>[(C+rad*Math.cos(ang)).toFixed(2),(C+rad*Math.sin(ang)).toFixed(2)]; const big=s1-s0>Math.PI?1:0;
    const d=`M${p(s0,R)}A${R} ${R} 0 ${big} 1 ${p(s1,R)}L${p(s1,r)}A${r} ${r} 0 ${big} 0 ${p(s0,r)}Z`; a0=a1;
    return `<path d="${d}" fill="${catCol(c.name)}" data-mcat="${esc(c.name)}" class="m-arc${MN.cat&&MN.cat!==c.name?' dim':''}"><title>${esc(c.name)}</title></path>`; }).join('');
  const grp={need:0,want:0,other:0}; cats.forEach(c=>grp[MC.groupOf(c.name)]+=c.spent);
  const list=P.filter(t=>t.kind==='spend'&&!t.synthetic&&t.amount<0&&t.date>=sp.from&&t.date<=sp.to);
  const typical=list.length?MC.median(list.map(t=>-t.amount)):0;
  return `<div class="ch">${icon('pie')}<h2>Where it went</h2><span class="sub">${esc(sp.label)} · ${cats.reduce((x,c)=>x+(c.count||0),0)} payments</span></div>
    <div class="m-where"><div class="m-donut"><svg viewBox="0 0 148 148" role="img" aria-label="Spending by category">${arcs}</svg><div class="m-dc"><b>${amt(s.spent)}</b><span>spent</span></div></div>
      <div class="m-fams">${['need','want','other'].filter(g=>grp[g]>0).map(g=>`<div class="m-fam"><span><i style="background:${famCol(g)}"></i>${{need:'Needs',want:'Wants',other:'Other'}[g]}</span><b>${Math.round(grp[g]/tot*100)}%</b><small>${amt(grp[g])}</small></div>`).join('')}
        <p class="m-fine">Needs keep life running: rent, bills, food, getting about. Wants are the choices.${typical?` A typical payment was ${amt(typical)}.`:''}</p></div></div>
    <div class="m-cats">${cats.map(c=>`<button type="button" class="m-cat${MN.cat===c.name?' on':''}" data-mcat="${esc(c.name)}"><span class="m-cn"><i style="background:${catCol(c.name)}"></i>${esc(c.name)}<small>${c.count||''}</small></span><span class="m-pct">${(c.spent/tot*100).toFixed(c.spent/tot<0.01?1:0)}%</span><b>${amt(c.spent)}</b></button>`).join('')}</div>`;
}
// In and out side by side for each month, a thin put-away bar beside them.
function monthColumns(host,months){
  if(!months.length){ host.innerHTML='<div class="empty">No months yet.</div>'; return; }
  const W=Math.max(320,host.clientWidth), H=host.clientHeight||220, padL=52, padB=24, padT=8; const iw=W-padL-6, ih=H-padB-padT;
  const max=niceMax(Math.max(...months.map(m=>Math.max(m.earned,m.spent,m.putAway)),1)); const bw=iw/months.length; const w=Math.max(4,Math.min(26,bw*.3));
  const y=(v)=>padT+ih-Math.max(0,v)/max*ih; const ticks=[0,.5,1].map(f=>f*max);
  const bar=(x,v,col,ww=w)=>{ const h=Math.max(0,v)/max*ih; if(h<=0)return ''; const r=Math.min(4,h/2,ww/2); return `<path d="M${x} ${padT+ih}V${padT+ih-h+r}a${r} ${r} 0 0 1 ${r}-${r}h${ww-2*r}a${r} ${r} 0 0 1 ${r} ${r}V${padT+ih}z" fill="${col}"/>`; };
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in and spent by month"><g class="grid">${ticks.map(t=>`<line x1="${padL}" x2="${W-6}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g><g class="axis">${ticks.map(t=>`<text x="${padL-8}" y="${y(t)+3}" text-anchor="end">${gbp(t)}</text>`).join('')}${months.map((m,i)=>`<text x="${padL+i*bw+bw/2}" y="${H-6}" text-anchor="middle"${MN.period==='m:'+m.month?' class="on"':''}>${MONTHS[Number(m.month.slice(5))-1].slice(0,3)}</text>`).join('')}</g>`;
  months.forEach((m,i)=>{ const cx=padL+i*bw+bw/2; svg+=`<g class="col${MN.period==='m:'+m.month?' picked':''}" data-i="${i}" style="cursor:pointer">${bar(cx-w-2,m.earned,'var(--m-in)')}${bar(cx+2,m.spent,'var(--m-out)')}${bar(cx+w+5,m.putAway,'var(--m-save)',Math.max(3,w*.35))}<rect class="hit" x="${padL+i*bw}" y="${padT}" width="${bw}" height="${ih}"/></g>`; });
  host.innerHTML=svg+'</svg>';
  const tip=$('tip');
  host.querySelectorAll('.col').forEach(g=>{ const m=months[Number(g.dataset.i)];
    const show=(ev)=>{ host.querySelectorAll('.col').forEach(c=>c.classList.toggle('dim',c!==g));
      tip.innerHTML=`<div class="d">${MONTHS[Number(m.month.slice(5))-1]} ${m.month.slice(0,4)}${m.month===isoDay().slice(0,7)?', so far':''}</div>`+[['var(--m-in)','In',m.earned],['var(--m-out)','Spent',m.spent],['var(--m-save)','Put away, new money',m.putAway],['transparent','Left over',m.left]].map(([c,l,v])=>`<div class="l"><i style="background:${c}"></i><b>${sgbp(v,{exact:true})}</b><span>${l}</span></div>`).join('')+(m.movedIn?`<div class="l" style="opacity:.7"><i style="background:transparent"></i><b>${sgbp(m.movedIn,{exact:true})}</b><span>moved over from your other account</span></div>`:'')+'<div class="l" style="opacity:.6"><span>Click to open this month</span></div>';
      tip.classList.add('on'); const tw=tip.offsetWidth, th=tip.offsetHeight; tip.style.left=Math.min(innerWidth-tw-10,ev.clientX+14)+'px'; tip.style.top=Math.max(10,ev.clientY-th-12)+'px'; };
    g.addEventListener('pointermove',show); g.addEventListener('pointerenter',show);
    g.addEventListener('pointerleave',()=>{ tip.classList.remove('on'); host.querySelectorAll('.col').forEach(c=>c.classList.remove('dim')); });
    g.addEventListener('click',()=>{ tip.classList.remove('on'); MN.period='m:'+m.month; MN.day=''; MN.shown=40; VIEWS.money.update(); $('page').scrollTo({top:0,behavior:'smooth'}); }); });
}
// The portfolio's worth, day by day, from the daily readings only.
function valueLine(host,hist){
  const days={'3m':91,'1m':30,'1w':7}[MN.t2p||'all']; const from=days?MC.addDays(isoDay(),-days):null;
  const V=hist.filter(h=>Number.isFinite(h.value)&&(!from||h.date>=from)); if(V.length<2){ host.innerHTML=''; return; }
  const W=Math.max(220,host.clientWidth), H=70, pad=4; const x0=Date.parse(V[0].date), x1=Date.parse(V[V.length-1].date)||x0+1;
  const vs=V.map(h=>h.value); const lo=Math.min(...vs)*.995, hi=Math.max(...vs)*1.005;
  const pts=V.map(h=>[pad+(Date.parse(h.date)-x0)/Math.max(1,x1-x0)*(W-2*pad), H-pad-(h.value-lo)/Math.max(1,hi-lo)*(H-2*pad)]);
  const up=V[V.length-1].value>=V[0].value;
  host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px" role="img" aria-label="Value by day"><path d="${smoothPath(pts)}" fill="none" stroke="${up?'var(--good)':'var(--bad)'}" stroke-width="2" stroke-linecap="round"/></svg><div class="m-fine">Value since ${esc(shortDate(x0))}</div>`;
}
/* clicks, forms and sheets */
function moneyClick(e){
  if(e.target.closest('[data-mclaimadd]')){openClaimSheet();return;}
  const cl=e.target.closest('[data-mclaimlink]'); if(cl){openClaimSheet(cl.dataset.mclaimlink);return;}
  const ca=e.target.closest('[data-mclaimact]'); if(ca){moneyClaim({action:ca.dataset.action,id:ca.dataset.mclaimact});return;}
  if(e.target.closest('#m-refresh')){ moneyRefresh(); return; }
  const p=e.target.closest('[data-mp]'); if(p){ MN.period=p.dataset.mp; if(!MN.period.startsWith('m:'))localStorage.setItem('meridian.cc.mPeriod',MN.period); MN.shown=40; MN.day=''; VIEWS.money.update(); return; }
  const x=e.target.closest('[data-mtx]'); if(x){ MN.txKind=x.dataset.mtx; localStorage.setItem('meridian.cc.mTx',MN.txKind); MN.shown=40; MN.cat=''; MN.trip=''; MN.day=''; VIEWS.money.update(); return; }
  const gr2=e.target.closest('[data-mgran]'); if(gr2){ MN.gran=gr2.dataset.mgran; localStorage.setItem('meridian.cc.mGran',MN.gran); VIEWS.money.update(); return; }
  const t2=e.target.closest('[data-mt2p]'); if(t2){ MN.t2p=t2.dataset.mt2p; VIEWS.money.update(); return; }
  const gr=e.target.closest('[data-mgroup]'); if(gr){ MN.openGroup=MN.openGroup===gr.dataset.mgroup?'':gr.dataset.mgroup; VIEWS.money.update(); return; }
  const nt=e.target.closest('[data-mnote]'); if(nt){ MN.noteId=nt.dataset.mnote; MN.showStale=true; $('m-adv').innerHTML=adviceHTML(); return; }
  const sb=e.target.closest('[data-msub]'); if(sb){ subMenu(sb); return; }
  const te=e.target.closest('[data-mtxedit]'); if(te){ openTxSheet(te.dataset.mtxedit); return; }
  const oo=e.target.closest('[data-moneoff]'); if(oo){ const t=MN.view.P.find(y=>y.id===oo.dataset.moneoff); const c=MN.data.context?.tx?.[t.id]||{}; moneyContext({tx:{[t.id]:{...c,tag:t.oneOff===true?'normal':'one-off'}}},t.oneOff===true?`${t.name} counts as day to day`:`${t.name} kept apart as a one-off`); return; }
  const tre=e.target.closest('[data-mtripedit]'); if(tre){ openTripSheet(tre.dataset.mtripedit); return; }
  const tr=e.target.closest('[data-mtrip]'); if(tr){ MN.trip=MN.trip===tr.dataset.mtrip?'':tr.dataset.mtrip; MN.cat=''; MN.day=''; MN.q=''; MN.shown=80; VIEWS.money.update(); if(MN.trip)$('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}); return; }
  const pl=e.target.closest('[data-mplan]'); if(pl){ openPlanSheet(pl.dataset.mplan); return; }
  const dy=e.target.closest('[data-mday]'); if(dy){ MN.day=''; VIEWS.money.update(); return; }
  const c=e.target.closest('[data-mcat]'); if(c){ MN.cat=MN.cat===c.dataset.mcat?'':c.dataset.mcat; MN.trip=''; MN.shown=40; VIEWS.money.update(); if(MN.cat)$('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}); return; }
  const q=e.target.closest('[data-mq]'); if(q){ MN.q=q.dataset.mq; MN.cat=''; MN.trip=''; MN.shown=40; VIEWS.money.update(); $('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}); return; }
  const b=e.target.closest('[data-m]'); if(!b)return; const k=b.dataset.m;
  if(k==='hide'){ MN.hide=!MN.hide; localStorage.setItem('meridian.cc.mHide',MN.hide?'1':'0'); VIEWS.money.update(); }
  if(k==='lock')moneyLock();
  if(k==='advmenu')adviceMenu(b);
  if(k==='toadv')$('m-adv')?.scrollIntoView({behavior:'smooth',block:'start'});
  if(k==='showstale'){ MN.showStale=true; $('m-adv').innerHTML=adviceHTML(); }
  if(k==='notes')openNotesSheet();
  if(k==='more-tx'){ MN.shown+=80; $('m-tx').innerHTML=txListHTML(); }
  if(k==='t212key')openT212Sheet();
  if(k==='accounts')openAccountsSheet();
  if(k==='more'){ const r=b.getBoundingClientRect(); const hidden=Object.entries(MN.data.context?.subs||{}).filter(([,v])=>v.status==='hidden');
    menu(r.left-170,r.bottom+6,[
    {label:'Colours',icon:'palette',act:openPaletteSheet},
    {label:'Adviser schedule and model',icon:'sparkle',act:openAdviserSheet},
    {label:'What your adviser should know',icon:'note',act:openNotesSheet},
    {label:'What counts as what',icon:'sliders',act:openRulesSheet},
    {label:'Balances',icon:'edit',act:openAccountsSheet},
    {label:'Trading 212 key',icon:'keys',act:openT212Sheet},
    hidden.length?{label:`Hidden payments (${hidden.length})`,icon:'eye',act:()=>{ const rr=b.getBoundingClientRect(); menu(rr.left-170,rr.bottom+6,hidden.map(([name])=>({label:'Show '+name.replace(/\b\w/g,ch=>ch.toUpperCase()),icon:'eye',act:()=>moneyContext({subs:{[name]:null}},'Showing it again')}))); }}:null,
    {label:'Change passcode',icon:'lock',act:openPasscodeSheet},
    'hr',
    {label:'Lock every device',icon:'lock',danger:true,act:()=>moneyLock(true)},
  ]); }
}
async function moneyLock(all){ try{ await send('/api/money/lock',all?{all:true}:{}); }catch{} MN.data=null; MN.view=null; MN.status={setup:true,unlocked:false}; toast(all?'Money is locked on every device':'Money is locked'); VIEWS.money.update(); }
async function moneySubmit(e){
  if(e.target.id!=='m-unlock')return; e.preventDefault();
  const first=e.target.dataset.first==='1'; const pass=$('m-pass').value; const remember=$('m-remember').checked; const err=$('m-err'); err.textContent='';
  localStorage.setItem('meridian.cc.mRemember',remember?'1':'0');
  if(first&&pass!==$('m-pass2').value){ err.textContent="Those two don't match."; return; }
  const btn=e.target.querySelector('button[type=submit]'); btn.disabled=true;
  try{ await send(first?'/api/money/setup':'/api/money/unlock',{passcode:pass,remember}); MN.status={setup:true,unlocked:true}; MN.at=0; await loadMoney(); }
  catch(x){ err.textContent=x.message; $('m-pass').select(); }
  btn.disabled=false;
}
function moneySheet(id,html,onSubmit){
  document.getElementById(id)?.remove(); const box=document.createElement('form'); box.className='sheet m-sheet'; box.id=id; box.autocomplete='off'; box.innerHTML=html;
  box.addEventListener('submit',async ev=>{ ev.preventDefault(); const btn=box.querySelector('button[type=submit]'); if(btn)btn.disabled=true; try{ await onSubmit(box); }catch(err){ const m=box.querySelector('.m-err'); if(m)m.textContent=err.message; else toast(err.message); } if(btn)btn.disabled=false; });
  document.body.appendChild(box); mDates(box); openSheet(id); return box;
}
/* A date picker in Meridian's own style, standing in for the browser's. Each
   date input becomes hidden (it still holds YYYY-MM-DD for the form) with a
   button beside it. In a pair of dates the second one shows the range. */
function mDates(scope){
  scope.querySelectorAll('input[type=date]').forEach(inp=>{
    const b=document.createElement('button'); b.type='button'; b.className='m-date'; b.setAttribute('aria-label',inp.getAttribute('aria-label')||'Pick a date');
    const lab=()=>{ b.innerHTML=`${icon('next')}<span>${inp.value?`${Number(inp.value.slice(8))} ${MONTHS[Number(inp.value.slice(5,7))-1].slice(0,3)} ${inp.value.slice(0,4)}`:'Pick a date'}</span>`; b.classList.toggle('empty',!inp.value); };
    inp.type='hidden'; inp.after(b); lab(); inp.addEventListener('change',lab);
    b.addEventListener('click',e=>{ e.stopPropagation(); mCal(inp,b); });
  });
}
function mCal(inp,btn){
  document.querySelector('.m-cal')?.remove();
  const row=btn.closest('.field-row,.m-nd'); const all=row?[...row.querySelectorAll('input[type=hidden]')].filter(x=>x.nextElementSibling?.classList.contains('m-date')):[];
  const other=all.length===2?all.find(x=>x!==inp):null; const isTo=other&&all.indexOf(inp)===1;
  let ym=(inp.value||(isTo&&other.value)||isoDay()).slice(0,7);
  const pop=document.createElement('div'); pop.className='m-cal'; document.body.appendChild(pop);
  const draw=()=>{ const [y,m]=ym.split('-').map(Number); const first=new Date(y,m-1,1); const lead=(first.getDay()+6)%7; const n=new Date(y,m,0).getDate(); const today=isoDay();
    const lo=isTo?other.value:inp.value, hi=isTo?inp.value:(other?.value||'');
    let cells=''; for(let i=0;i<lead;i++)cells+='<span></span>';
    for(let d=1;d<=n;d++){ const iso=`${y}-${pad(m)}-${pad(d)}`; const cls=[iso===inp.value?'on':'',iso===today?'today':'',lo&&hi&&iso>lo&&iso<hi?'mid':'',other&&iso===other.value?'m-edge':''].filter(Boolean).join(' '); cells+=`<button type="button" data-d="${iso}" class="${cls}">${d}</button>`; }
    pop.innerHTML=`<div class="m-calh"><button type="button" data-step="-1" aria-label="Previous month">${icon('left')}</button><b>${MONTHS[m-1]} ${y}</b><button type="button" data-step="1" aria-label="Next month">${icon('right')}</button></div><div class="m-calw">${['M','T','W','T','F','S','S'].map(x=>`<span>${x}</span>`).join('')}</div><div class="m-cald">${cells}</div><div class="m-calf"><button type="button" data-d="${today}">Today</button>${inp.value?'<button type="button" data-clear>Clear</button>':''}</div>`; };
  const place=()=>{ const r=btn.getBoundingClientRect(); const w=pop.offsetWidth, h=pop.offsetHeight; pop.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left))+'px'; pop.style.top=(r.bottom+h+8>innerHeight?Math.max(8,r.top-h-6):r.bottom+6)+'px'; };
  draw(); place();
  pop.addEventListener('click',e=>{ e.stopPropagation(); const s=e.target.closest('[data-step]'); if(s){ const [y,m]=ym.split('-').map(Number); const d=new Date(y,m-1+Number(s.dataset.step),1); ym=`${d.getFullYear()}-${pad(d.getMonth()+1)}`; draw(); return; }
    const d=e.target.closest('[data-d]'); if(d){ inp.value=d.dataset.d; inp.dispatchEvent(new Event('change')); if(!isTo&&other&&other.value&&other.value<inp.value){ other.value=''; other.dispatchEvent(new Event('change')); } close(); return; }
    if(e.target.closest('[data-clear]')){ inp.value=''; inp.dispatchEvent(new Event('change')); close(); } });
  const close=()=>{ pop.remove(); document.removeEventListener('pointerdown',out,true); document.removeEventListener('keydown',esc_,true); };
  const out=(e)=>{ if(!pop.contains(e.target)&&e.target!==btn&&!btn.contains(e.target))close(); };
  const esc_=(e)=>{ if(e.key==='Escape'){ e.stopPropagation(); close(); } };
  setTimeout(()=>{ document.addEventListener('pointerdown',out,true); document.addEventListener('keydown',esc_,true); },0);
}
const sheetHead=(t)=>`<h3><span>${t}</span><span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>`;
function openT212Sheet(){
  moneySheet('sheet-t212',`${sheetHead('Trading 212 key')}
    <p class="dim" style="font-size:13px;margin-bottom:12px">In the Trading 212 app: Settings, then API (Beta), then Generate API key. Call it Meridian. Turn on only the read permissions (account data, portfolio, history) and leave orders off. Leave the IP limit off, or the Home Mac stops getting in whenever your home IP address changes. Meridian only ever reads with it.</p>
    <div class="field"><label for="t2-key">API key</label><input id="t2-key" autocomplete="off" spellcheck="false" required></div>
    <div class="field"><label for="t2-sec">API secret</label><input id="t2-sec" type="password" autocomplete="new-password" required></div>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Test and save</button></div>`,
    async box=>{ box.querySelector('button[type=submit]').textContent='Testing…'; try{ const j=await send('/api/money/t212-key',{key:$('t2-key').value,secret:$('t2-sec').value}); if(j.data)MN.data=j.data; closeOverlays(); toast('Trading 212 is connected'); VIEWS.money.update(); }finally{ const b=box.querySelector('button[type=submit]'); if(b)b.textContent='Test and save'; } });
}
function openRulesSheet(){
  const r=MN.data?.rules||{}; const lines=(a)=>esc((a||[]).join('\n'));
  moneySheet('sheet-mrules',`${sheetHead('What counts as what')}
    <p class="dim" style="font-size:13px;margin-bottom:12px">One name per line. A payment matches when its name contains the text. Anything not listed is spending, and money in counts as income when Monzo files it under Income.</p>
    <div class="field-row"><div class="field"><label>Salary (sets your paydays)</label><textarea id="mr-salary" rows="3">${lines(r.salary)}</textarea></div><div class="field"><label>Your own accounts (not spending)</label><textarea id="mr-internal" rows="3">${lines(r.internal)}</textarea></div></div>
    <div class="field-row"><div class="field"><label>Investing and saving elsewhere</label><textarea id="mr-invest" rows="3">${lines(r.invest)}</textarea></div><div class="field"><label>Leave out completely</label><textarea id="mr-ignore" rows="3">${lines(r.ignore)}</textarea></div></div>
    <div class="field"><label>Put a payee in a different category (name = category)</label><textarea id="mr-cats" rows="3">${esc(Object.entries(r.categories||{}).map(([k,v])=>k+' = '+v).join('\n'))}</textarea></div>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async ()=>{ const list=(id)=>$(id).value.split('\n').map(s=>s.trim()).filter(Boolean); const categories={}; for(const l of $('mr-cats').value.split('\n')){ const i=l.indexOf('='); if(i>0)categories[l.slice(0,i).trim()]=l.slice(i+1).trim(); }
      const j=await send('/api/money/rules',{salary:list('mr-salary'),internal:list('mr-internal'),invest:list('mr-invest'),ignore:list('mr-ignore'),categories},'PUT'); MN.data.rules=j.rules; closeOverlays(); toast('Saved'); VIEWS.money.update(); });
}
function openAccountsSheet(){
  const acc=(MN.data?.accounts||[]).map(a=>({...a}));
  const row=(a,i)=>`<div class="m-accrow" data-i="${i}"><input data-k="name" value="${esc(a.name||'')}" placeholder="Name, like Moneybox LISA" aria-label="Name"><select data-k="kind" aria-label="Kind">${Object.entries(ACC_KINDS).map(([k,l])=>`<option value="${k}"${a.kind===k?' selected':''}>${l}</option>`).join('')}</select><input data-k="balance" inputmode="decimal" value="${a.balance!=null?esc(a.balance):''}" placeholder="£" aria-label="Balance"><input data-k="asOf" type="date" value="${esc(a.asOf||isoDay())}" aria-label="As of"><button type="button" class="ibtn" data-del="${i}" aria-label="Remove">${icon('trash')}</button><input data-k="note" class="m-accnote" value="${esc(a.note||'')}" placeholder="Note (optional)" aria-label="Note"></div>`;
  const box=moneySheet('sheet-macc',`${sheetHead('Balances')}
    <p class="dim" style="font-size:13px;margin-bottom:12px">For accounts Meridian can't read on its own: a LISA, savings, another bank, a credit card. Update a balance whenever you like; the old one is kept so you can see it change.</p>
    <div id="macc-rows">${acc.map(row).join('')}</div>
    <button type="button" class="btn sm ghost" id="macc-add" style="margin-top:6px">${icon('plus')}Add an account</button>
    <div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async ()=>{ const rows=[...document.querySelectorAll('#macc-rows .m-accrow')].map(el=>{ const g=(k)=>el.querySelector(`[data-k="${k}"]`).value.trim(); const a=acc[Number(el.dataset.i)]||{}; return {id:a.id,name:g('name'),kind:g('kind'),balance:parseFloat(g('balance').replace(/[^0-9.-]/g,'')),asOf:g('asOf'),note:g('note')}; }).filter(a=>a.name);
      const j=await send('/api/money/accounts',{accounts:rows},'PUT'); MN.data.accounts=j.accounts; closeOverlays(); toast('Balances saved'); VIEWS.money.update(); });
  box.addEventListener('click',e=>{ if(e.target.closest('#macc-add')){ acc.push({kind:'savings',asOf:isoDay()}); $('macc-rows').insertAdjacentHTML('beforeend',row(acc[acc.length-1],acc.length-1)); $('macc-rows').lastElementChild.querySelector('input').focus(); }
    const d=e.target.closest('[data-del]'); if(d)d.closest('.m-accrow').remove(); });
  if(!acc.length)box.querySelector('#macc-add').click();
}
function openPasscodeSheet(){
  moneySheet('sheet-mpass',`${sheetHead('Change passcode')}
    <div class="field"><label for="mp-cur">Current passcode</label><input id="mp-cur" type="password" autocomplete="current-password" required></div>
    <div class="field-row"><div class="field"><label for="mp-new">New passcode</label><input id="mp-new" type="password" autocomplete="new-password" minlength="6" required></div><div class="field"><label for="mp-new2">Same again</label><input id="mp-new2" type="password" autocomplete="new-password" required></div></div>
    <p class="dim" style="font-size:12.5px">Every other device is signed out.</p><div class="m-err" role="alert"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Change it</button></div>`,
    async ()=>{ if($('mp-new').value!==$('mp-new2').value)throw new Error("The new ones don't match."); await send('/api/money/passcode',{current:$('mp-cur').value,next:$('mp-new').value}); closeOverlays(); toast('Passcode changed'); });
}
/* ⌘K: type £ (from anywhere) to search money. On the Money tab, money comes first
   without the £. "june" opens June, "june in" its money in, "june out" its
   spending; categories, trips, regular payments and payments match by name or note. */
const MONTH_RE=/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(20\d\d))?(?:\s+(in|out|income|spent|spending|spend))?$/i;
function palMoney(q){
  const ql=q.trim().toLowerCase(); const tile=(ic)=>`<span class="pal-k">${icon(ic)}</span>`; const items=[];
  if(!MN.data){ if(!MN.status)loadMoney(); return [{g:'Money',tile:tile('lock'),t:MN.status&&!MN.status.unlocked?'Unlock Money to search it':'Open Money',sub:'your passcode keeps it private',verb:'Open',run:()=>go('money')}]; }
  const D=MN.data; const P=MN.view?.P||MC.prepare(D.monzo.transactions,D.rules,{context:D.context,plans:D.plans,receivables:D.receivables});
  const open=(fn)=>()=>{ go('money'); fn(); VIEWS.money.update(); };
  const m=MONTH_RE.exec(ql);
  if(m){ const mi=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3)); const months=MC.monthly(P,isoDay()); const want=m[2]?[m[2]]:[...new Set(months.map(x=>x.month.slice(0,4)))].reverse();
    for(const yr of want){ const key=`${yr}-${pad(mi+1)}`; const row=months.find(x=>x.month===key); if(!row)continue; const dir=m[3]?/^in/.test(m[3])?'in':'spend':'';
      items.push({g:'Months',tile:tile('chart'),t:`${MONTHS[mi]} ${yr}${dir==='in'?', money in':dir?', spending':''}`,sub:`in ${gbp(row.earned)} · spent ${gbp(row.spent)} · left ${sgbp(row.left)}`,verb:'Open',run:open(()=>{ MN.period='m:'+key; MN.cat=''; MN.trip=''; MN.day=''; MN.q=''; if(dir){ MN.txKind=dir; setTimeout(()=>$('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}),120); } })}); } }
  for(const p of MC.PERIODS)if(ql&&p.label.toLowerCase().includes(ql))items.push({g:'Money',tile:tile('money'),t:p.label,sub:'Money',verb:'Open',run:open(()=>{ MN.period=p.id; })});
  if(!ql)items.push({g:'Money',tile:tile('money'),t:'Open Money',sub:'type a month, place, trip or note',verb:'Open',run:()=>go('money')});
  const cats=[...new Set(P.filter(t=>t.kind==='spend'&&!t.synthetic).map(t=>t.cat))];
  cats.filter(c=>ql&&c.toLowerCase().includes(ql)).forEach(c=>items.push({g:'Categories',tile:`<span class="pal-k"><i style="width:12px;height:12px;border-radius:4px;background:${catCol(c)}"></i></span>`,t:c,sub:'show its payments',verb:'Show',run:open(()=>{ MN.cat=c; MN.trip=''; MN.q=''; setTimeout(()=>$('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}),120); })}));
  (D.context?.trips||[]).filter(t=>ql&&[t.name,t.with,t.note].some(x=>String(x||'').toLowerCase().includes(ql))).forEach(t=>{ const v=P.filter(x=>x.trip===t.id&&x.kind==='spend').reduce((a,x)=>a-x.amount,0);
    items.push({g:'Trips',tile:tile('globe'),t:t.name,sub:`${gbp(v)}${t.with?' · with '+t.with:''}`,verb:'Show',run:open(()=>{ MN.trip=t.id; MN.cat=''; MN.q=''; setTimeout(()=>$('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}),120); })}); });
  if(ql.length>=2){ const hits=P.filter(t=>!t.synthetic&&txMatches(t,ql)).reverse();
    if(hits.length){ const out=hits.filter(t=>t.amount<0).reduce((a,t)=>a-t.amount,0); items.push({g:'Payments',tile:tile('search'),t:`All ${hits.length} payment${hits.length>1?'s':''} matching "${q.trim()}"`,sub:out?`${gbp(out)} out`:'',verb:'Show',run:open(()=>{ MN.q=q.trim(); MN.cat=''; MN.trip=''; MN.day=''; MN.txKind='all'; setTimeout(()=>$('m-paycard')?.scrollIntoView({behavior:'smooth',block:'start'}),120); })}); }
    hits.slice(0,8).forEach(t=>items.push({g:'Payments',tile:`<span class="pal-k"><i style="width:12px;height:12px;border-radius:4px;background:${catCol(t.cat)}"></i></span>`,t:`${t.name} ${t.amount>0?'+':''}${sgbp(t.amount)}`,sub:[shortDate(Date.parse(t.date))+' '+t.date.slice(0,4),t.myNote||t.notes||t.cat].filter(Boolean).join(' · '),verb:'Open',run:open(()=>setTimeout(()=>openTxSheet(t.id),150))})); }
  // Investments: pies, single holdings, and what's inside each pie.
  if(ql.length>=2&&D.t212){ const groups=t212Groups(D.t212); const inv=[];
    groups.forEach(g=>{ if(g.name.toLowerCase().includes(ql))inv.push({g,label:g.name,sub:`${gbp(g.value)} · ${g.gain>=0?'+':''}${sgbp(g.gain)} · put in ${gbp(g.cost)}${g.kind==='pie'?' · pie':''}`}); if(g.kind==='pie')g.items.forEach(i=>{ if(i.name.toLowerCase().includes(ql)||i.ticker.toLowerCase().startsWith(ql))inv.push({g,label:i.name,sub:`${gbp(i.value)} · ${i.gain>=0?'+':''}${sgbp(i.gain)} · in ${g.name}`}); }); });
    inv.slice(0,8).forEach(x=>items.push({g:'Investments',tile:tile('chart'),t:x.label,sub:x.sub,verb:'Show',run:open(()=>{ MN.openGroup=x.g.id; setTimeout(()=>document.getElementById('m-'+x.g.id)?.scrollIntoView({behavior:'smooth',block:'center'}),150); })})); }
  items.push(...[{g:'Money',tile:tile('refresh'),t:'Update money now',sub:'Monzo and Trading 212',verb:'Run',run:()=>{ go('money'); moneyRefresh(); }},{g:'Money',tile:tile('sparkle'),t:'Ask the adviser',sub:advName(D.adviser?.model||'gpt-6-luna'),verb:'Run',run:()=>{ go('money'); moneyAdvise(D.adviser?.model); }},{g:'Money',tile:tile(MN.hide?'eye':'eyeoff'),t:MN.hide?'Show amounts':'Hide amounts',sub:'for screen sharing',verb:'Run',run:()=>{ go('money'); MN.hide=!MN.hide; localStorage.setItem('meridian.cc.mHide',MN.hide?'1':'0'); VIEWS.money.update(); }}].filter(i=>!ql||i.t.toLowerCase().includes(ql)));
  return items.slice(0,30);
}


/* At a glance: a few plain sentences from the numbers (and the adviser's own
   glance when its note is fresh), for the top of Money and for ⌘K £. */
function moneyGlance(){
  const D=MN.data; if(!D)return '';
  const P=MN.view?.P||MC.prepare(D.monzo.transactions,D.rules,{context:D.context,plans:D.plans,receivables:D.receivables}); const today=isoDay();
  const sp=MC.periodSpan('payday',P,today); const s=MC.summarize(P,sp); const bits=[];
  bits.push(`${sp.id==='payday'?'Since payday':'This month'} you've had ${gbp(s.earned)} in and spent ${gbp(s.spent)}, so ${s.left<0?'you\'re '+gbp(-s.left)+' over':gbp(s.left)+' is left'}.`);
  const rent=Object.values(D.plans||{}).find(p=>p.kind!=='income'); if(rent){ const paid=(i)=>!!i.paid||P.some(t=>t.planned&&!t.planned.income&&t.planned.from===i.from); const n=(rent.instalments||[]).find(i=>!paid(i)); if(n){ const a=rentAside(rent,n,P); bits.push(`Next rent is ${gbp(n.amount)} on ${shortDate(Date.parse(n.due))}${a.per?`; ${gbp(a.per)} from each payday covers it`:a.covered?', and the loan covers it':''}.`); } }
  const t=D.t212; if(t)bits.push(`Investments are worth ${gbp(t.account.value)}, ${t.account.unrealised>=0?'up':'down'} ${gbp(Math.abs(t.account.unrealised))} on what you put in.`);
  const owed=P.filter(x=>x.split).flatMap(x=>x.split.filter(y=>!y.settled)).concat((MN.data.receivables||[]).filter(c=>!c.settled)); if(owed.length)bits.push(`${owed.map(o=>o.who).join(' and ')} owe${owed.length>1?'':'s'} you ${gbp(owed.reduce((a,o)=>a+o.amount,0))}.`);
  const note=D.advice?.notes?.[0]; const adv=note&&note.advice.glance&&(Date.now()-Date.parse(note.at))/86400e3<=8?note.advice.glance:'';
  return {facts:bits.join(' '),adviser:adv,by:adv?advName(note.model):''};
}
// What to put aside from each payday for an instalment, after any loan that lands first.
function rentAside(plan,next,P){
  const today=isoDay(); const pd=MC.paydays(P); const step=MC.payInterval(pd); let left=0;
  if(pd.length)for(let d=MC.addDays(pd[pd.length-1],step);d<next.due;d=MC.addDays(d,step))if(d>today)left++;
  const coming=Object.values(MN.data.plans||{}).filter(p=>p.kind==='income').flatMap(p=>(p.instalments||[]).filter(i=>i.due>today&&i.due<=next.due).map(i=>({...i,name:p.name})));
  const inSum=coming.reduce((a,i)=>a+i.amount,0); const need=Math.max(0,next.amount-inSum);
  return {left,coming,inSum,need,per:left&&need?need/left:0,covered:inSum>=next.amount};
}
// Since the last visit: who paid, what landed, anything big, anything due.
function whatsNew(P){
  const D=MN.data; const since=(MN.seenSince||new Date(Date.now()-7*864e5).toISOString()).slice(0,10); const today=isoDay(); const items=[]; const soon=[];
  const fresh=P.filter(t=>!t.synthetic&&t.date>=since);
  for(const t of fresh){
    if(t.repays)items.push({ic:'reply',tone:'good',date:t.date,html:`<b>${esc(t.repays.who)}</b> paid you back ${amt(t.amount)} for ${esc(cap(t.repays.for,40))}. Ticked off.`,id:t.repays.txId});
    else if(t.salary)items.push({ic:'money',tone:'good',date:t.date,html:`Payday: ${amt(t.amount)} from ${esc(t.name)}.`});
    else if(t.kind==='planned'&&!t.planned.income)items.push({ic:'home',date:t.date,html:`Rent paid: ${amt(-t.amount)} for ${esc(shortDate(Date.parse(t.planned.from)))} to ${esc(shortDate(Date.parse(t.planned.to)))}, counted a day at a time.`});
    else if(t.kind==='spend'&&t.amount<=-100)items.push({ic:'bolt',date:t.date,html:`${esc(t.name)}: ${amt(-t.amount)}${t.trip?` (${esc((D.context?.trips||[]).find(x=>x.id===t.trip)?.name||'')})`:''}.`,id:t.id});
  }
  for(const p of Object.values(D.plans||{}).filter(p=>p.kind==='income'))for(const i of p.instalments||[])if(i.due>=since&&i.due<=today)items.push({ic:'money',tone:'good',date:i.due,html:`${esc(p.name)}: ${amt(i.amount)} due in your other account.`});
  for(const r of MN.view?.rec||[]){ const x=subState(r); if(x.again&&r.last>=since)items.push({ic:'bolt',tone:'bad',date:r.last,html:`${esc(r.name)} charged ${amt(r.amount)} after you cancelled it.`}); }
  const note=D.advice?.notes?.[0]; if(note&&note.date>=since)items.push({ic:'sparkle',date:note.date,html:`New note from ${esc(advName(note.model))}: ${esc(cap(note.advice.headline,110))}`,adv:true});
  const h=D.history||[]; const then=[...h].filter(x=>x.date<=since).pop(); const t=D.t212;
  if(t&&then){ const d=(t.account.value-t.account.cost)-(then.value-then.cost); if(Math.abs(d)>=5)items.push({ic:'chart',tone:d>0?'good':'bad',date:today,html:`Investments ${d>0?'up':'down'} ${amt(Math.abs(d))} since then, leaving new money out. Now ${amt(t.account.value)}.`}); }
  // Coming up, whether new or not.
  for(const p of Object.values(D.plans||{}).filter(p=>p.kind!=='income')){ const paid=(i)=>!!i.paid||P.some(x=>x.planned&&!x.planned.income&&x.planned.from===i.from); const n=(p.instalments||[]).find(i=>!paid(i)); if(n&&MC.daysBetween(today,n.due)<=21)soon.push({ic:'home',html:`${esc(p.name)}: ${amt(n.amount)} due ${esc(shortDate(Date.parse(n.due)))}.`});
    for(const x of (p.pending||[]).filter(x=>!x.done&&x.since&&MC.daysBetween(x.since,today)>=7))soon.push({ic:'bolt',html:`Still waiting on: ${esc(cap(x.text,70))} (${MC.daysBetween(x.since,today)} days).`}); }
  for(const tr of D.context?.trips||[])if(tr.from&&tr.from>=today&&MC.daysBetween(today,tr.from)<=21)soon.push({ic:'globe',html:`${esc(tr.name)} starts ${esc(shortDate(Date.parse(tr.from)))}.`});
  return {since,items:items.sort((a,b)=>b.date.localeCompare(a.date)),soon};
}
// On the page: only what changed since the last visit, and who owes you. The
// full summary sentence lives in ⌘K £, where there are no big numbers above it.
// Icon colour: green when it went your way, red when it didn't, grey otherwise.
function newsHTML(P){
  const w=whatsNew(P);
  const owed=P.filter(x=>x.split).flatMap(x=>x.split.filter(y=>!y.settled).map(y=>({...y,t:x}))).concat((MN.data.receivables||[]).filter(c=>!c.settled).map(c=>({...c,t:{myNote:c.note,name:c.who}})));
  const row=(x)=>`<div class="m-new${x.tone?' '+x.tone:''}"${x.id?` data-mtxedit="${esc(x.id)}"`:x.adv?' data-m="toadv"':''}>${icon(x.ic)}<span>${x.html}</span>${x.date?`<small>${esc(dayWord(Date.parse(x.date+'T12:00:00')))}</small>`:''}</div>`;
  const owing=owed.map(o=>({ic:'reply',html:`<b>${esc(o.who)}</b> owes you ${amt(o.amount)} for ${esc(cap(o.t.myNote||o.t.name,50))}.`,id:o.t.id}));
  const empty=!w.items.length&&!owing.length&&!w.soon.length;
  return `<div class="ch">${icon('bell')}<h2>What's new</h2><span class="sub">since you last looked, ${esc(shortDate(Date.parse(w.since)))}</span></div>
    ${empty?'<p class="dim" style="font-size:13.5px">Nothing new since then.</p>':''}
    ${w.items.length?`<div class="m-news">${w.items.slice(0,8).map(row).join('')}</div>`:''}
    ${owing.length||w.soon.length?`<div class="m-news m-news2">${[...owing,...w.soon].map(row).join('')}</div>`:''}`;
}/* DOGFOOD. */
let dfFilter='all', dfSig='';
VIEWS.dogfood={
  mount(el){
    el.innerHTML=`<div class="vhead"><div><h1>Dogfood</h1><p>Something bugging you in Meridian or any of your tools? Log it here and an agent makes the change. Press F from anywhere.</p></div></div>
      <div class="grid"><section class="card c12"><div class="composer" id="df-composer"></div></section>
      <section class="c12"><div class="sec-h"><h3>Fixes</h3><span class="sub" id="df-sub"></span><span class="end"><div class="seg" id="df-filter"><button type="button" data-v="open">Open</button><button type="button" data-v="done">Done</button><button type="button" data-v="all">All</button></div></span></div><div class="card nest" style="--nest-pad:8px"><div id="df-runs" class="nest-list"></div></div></section></div>`;
    mountComposer($('df-composer'),{placeholder:'This is bugging me… Say where it is and what should change. Paste screenshots straight in.'});
    $('df-filter').addEventListener('click',e=>{ const b=e.target.closest('[data-v]'); if(b){ dfFilter=b.dataset.v; dfSig=''; $('df-runs').querySelectorAll('.report').forEach(r=>r.hidden=true); VIEWS.dogfood.update(); } });
  },
  update(){
    const runs=feedbackRuns(); const open=runs.filter(r=>r.status!=='done'); const done=runs.filter(r=>r.status==='done');
    const list=dfFilter==='open'?open:dfFilter==='done'?done:runs;
    $('df-filter').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===dfFilter)));
    $('df-sub').textContent=`${open.length} open · ${done.length} done`;
    const s=sig([dfFilter,list.map(r=>[r.id,r.status,Math.floor(Date.now()/60000)])]); if(s===dfSig)return;
    if([...document.querySelectorAll('#df-runs .report')].some(r=>!r.hidden))return; // never wipe a summary he is reading
    dfSig=s;
    $('df-runs').innerHTML=list.length?list.map(runHTML).join(''):`<div class="empty" style="padding:14px">${dfFilter==='open'?'Nothing in progress. Everything you logged is done.':'Nothing here yet.'}</div>`;
  },
};

/* JOURNAL. Written for him from the nightly ledger; this view only reads. */
let jTrack='all', jQ='', jAll=false, jSig=''; const jOpen=new Set();
function summarise(t,max=190){ const c=String(t||'').replace(/^(here'?s?|so|right|ok(ay)?|done)[,:. ]+/i,'').trim(); if(!c)return ''; const parts=c.split(/(?<=[.!?])\s+/); let out=parts[0]||c; for(let i=1;i<parts.length&&out.length<70;i++)out+=' '+parts[i]; out=out.trim(); return out.length>max?out.slice(0,max).replace(/\s+\S*$/,'')+'…':out; }
function timelineHTML(items){
  const dayStart=startOfDay(Date.now()); const liveCut=Date.now()-6*60000;
  const main=items.filter(i=>i.name!=='Automations'&&((i.minutes||0)>=5||(i.commits||[]).length)).sort((a,b)=>(a.first||0)-(b.first||0));
  if(!main.length)return '<div class="empty">Nothing recorded yet today.</div>';
  const total=main.reduce((a,i)=>a+(i.minutes||0),0);
  return (total?`<div class="daybar">${main.filter(i=>i.minutes).map(i=>`<span class="${esc(i.track)}" style="flex:${i.minutes}" role="img" aria-label="${esc(i.name)} · ${hours(i.minutes)}" title="${esc(i.name)} · ${hours(i.minutes)}"></span>`).join('')}</div><div class="dim" style="font-size:12px;margin-bottom:8px">${hours(total)} across ${main.length} project${main.length>1?'s':''}</div>`:'')
    +'<div class="tl">'+main.map(i=>{ const ask=(i.asks||[])[0]; const did=i.did?summarise(i.did,210):''; const head=did||(ask?'You asked: '+summarise(ask):((i.commits||[]).slice(-1)[0]?.subject||'Working session')); const now=(i.last||0)>liveCut;
      return `<div class="tlrow ${esc(i.track)}${now?' now':''}"><span class="when">${i.first?(i.first-dayStart<60000?'all day':hm(i.first)):''}</span><span class="rail"><i></i></span><div><div class="p"><b>${esc(i.name)}</b><span>${now?'working now':(i.last?hm(i.last):'')}</span></div><div class="s">${esc(head)}</div>${did&&ask?`<div class="m">${esc(summarise(ask,110))}</div>`:''}</div><div class="aside">${i.minutes?`<span class="tag">${hours(i.minutes)}</span>`:''}<span class="tag ${esc(i.track)}">${esc(i.track)}</span></div></div>`; }).join('')+'</div>';
}
function areaMark(e){ const area=String(e.area||'').toLowerCase(); const l=(links.links||[]).find(x=>String(x.category||'').toLowerCase()===area)||(links.links||[]).find(x=>area&&String(x.title||'').toLowerCase().includes(area)); const mono=(e.area||e.title||'?').trim().charAt(0).toUpperCase();
  return `<span class="mk">${l?`<img alt="" src="${api('/api/favicon?link='+l.id)}" data-mono="${esc(mono)}" onerror="monoFallback(this)">`:esc(mono)}</span>`; }
let jArea='all';
const TRACK_LABEL={work:'Work',uni:'Uni',personal:'Personal'};
const dayLabel=(date)=>{ if(date===isoDay())return 'Today'; if(date===isoDay(new Date(Date.now()-86400e3)))return 'Yesterday'; const d=new Date(date+'T12:00'); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
VIEWS.journal={
  mount(el){
    el.innerHTML=`<div class="vhead"><div><h1>Journal</h1><p>What you worked on, written for you each night from your sessions and commits. Add your own, fix anything that's off, export a term.</p></div>
      <div class="vtools"><label class="shelf-search">${icon('search')}<input id="j-q" placeholder="Search the journal"></label><button class="btn ghost" id="j-export">${icon('report')}Export</button><button class="btn primary" id="j-add">${icon('plus')}Add an entry</button></div></div>
      <div class="ufilters"><div class="seg" id="j-tracks"></div><div class="areachips" id="j-areas"></div></div>
      <div class="jstats" id="j-stats"></div>
      <section class="card" id="j-today-card" style="margin-top:12px"><div class="ch">${icon('bolt')}<h2>Today so far</h2><span class="sub">becomes entries tonight</span></div><div id="j-today"></div></section>
      <div id="j-list"></div>`;
    $('j-tracks').addEventListener('click',e=>{ const b=e.target.closest('[data-t]'); if(b){ jTrack=b.dataset.t; jArea='all'; jSig=''; VIEWS.journal.update(); } });
    $('j-areas').addEventListener('click',e=>{ const b=e.target.closest('[data-area]'); if(b){ jArea=jArea===b.dataset.area?'all':b.dataset.area; jSig=''; VIEWS.journal.update(); } });
    $('j-q').addEventListener('input',e=>{ jQ=e.target.value; jSig=''; VIEWS.journal.update(); });
    $('j-add').addEventListener('click',()=>openEntrySheet({}));
    $('j-export').addEventListener('click',openExportSheet);
    $('j-list').addEventListener('click',e=>{
      if(e.target.closest('#j-all')){ jAll=!jAll; jSig=''; VIEWS.journal.update(); return; }
      const act=e.target.closest('[data-jact]'); const en=e.target.closest('.jentry');
      if(act&&en){ const entry=journal.entries.find(x=>x.id===en.dataset.id); if(!entry)return; if(act.dataset.jact==='edit')openEntrySheet(entry); if(act.dataset.jact==='del')deleteEntry(entry); if(act.dataset.jact==='copy'){ navigator.clipboard.writeText(entry.body||entry.title).then(()=>toast('Copied')); } return; }
      if(en&&!e.target.closest('a')){ en.classList.toggle('open'); en.classList.contains('open')?jOpen.add(en.dataset.id):jOpen.delete(en.dataset.id); }
    });
    loadJournal();
  },
  update(){
    const entries=(journal?.entries||[]).map(e=>({...e,track:e.track||'personal'}));
    $('j-tracks').innerHTML=[['all','Everything'],['work','Work'],['uni','Uni'],['personal','Personal']].map(([v,l])=>`<button type="button" data-t="${v}" aria-pressed="${v===jTrack}">${l}</button>`).join('');
    const items=(state?.journalToday?.items||[]).filter(i=>jTrack==='all'||i.track===jTrack);
    $('j-today').innerHTML=timelineHTML(items); $('j-today-card').hidden=!items.length&&!!jQ;
    if(!journal){ $('j-list').innerHTML='<div class="empty" style="margin-top:20px">Loading…</div>'; return; }
    const js=sig([jTrack,jArea,jQ,jAll,entries.length,entries.map(e=>e.updated).sort().pop()]); if(js===jSig)return; jSig=js;
    const pool=entries.filter(e=>jTrack==='all'||e.track===jTrack);
    const areas=new Map(); pool.forEach(e=>areas.set(e.area,(areas.get(e.area)||0)+1));
    $('j-areas').innerHTML=[...areas].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([a,n])=>`<button type="button" class="chip" data-area="${esc(a)}" aria-pressed="${jArea===a}">${esc(a)}<span class="c">${n}</span></button>`).join('');
    const week=isoDay(new Date(Date.now()-6*86400e3)); const wk=entries.filter(e=>e.date>=week); const mins=(l)=>l.reduce((a,e)=>a+(e.minutes||0),0);
    $('j-stats').innerHTML=`<span class="jstat"><b>${wk.length}</b> this week</span>`+['work','uni','personal'].map(t=>{ const l=wk.filter(e=>e.track===t); return l.length?`<span class="jstat"><span class="tag ${t}">${TRACK_LABEL[t]}</span><b>${l.length}</b>${mins(l)?' · '+hours(mins(l)):''}</span>`:''; }).join('')+`<span class="jstat"><b>${entries.length}</b> in all</span>`;
    const q=jQ.trim().toLowerCase();
    const shown=pool.filter(e=>(jArea==='all'||e.area===jArea)&&(!q||[e.title,e.body,e.area,...(e.tags||[])].join(' ').toLowerCase().includes(q))).sort((a,b)=>b.date.localeCompare(a.date)||String(b.created).localeCompare(String(a.created)));
    const days=new Map(); shown.forEach(e=>{ if(!days.has(e.date))days.set(e.date,[]); days.get(e.date).push(e); });
    const filtered=jArea!=='all'||!!q; const all=[...days]; const list=jAll||filtered?all:all.filter(([d])=>d>=week); const hidden=all.length-list.length;
    const src=(e)=>e.source==='ledger'?'From the nightly ledger':e.source==='agent'?'Backfilled by an agent':e.source==='auto'?'Logged automatically':'Added by you';
    $('j-list').innerHTML=(list.length?list:all.slice(0,1)).map(([date,es])=>{ const m=mins(es);
      return `<div class="jday"><div class="dh"><b>${dayLabel(date)}</b><span>${es.length} entr${es.length>1?'ies':'y'}${m?' · '+hours(m):''}</span></div><div class="card nest">${es.map(e=>`<div class="jentry${jOpen.has(e.id)?' open':''}" data-id="${esc(e.id)}"><div class="line">${areaMark(e)}<span class="sum">${esc(e.title)}</span>${jArea==='all'?`<span class="tag">${esc(e.area)}</span>`:''}${jTrack==='all'?`<span class="tag ${esc(e.track)}">${esc(TRACK_LABEL[e.track]||e.track)}</span>`:''}${e.minutes?`<span class="tag">${hours(e.minutes)}</span>`:''}</div><div class="more">${e.body&&e.body!==e.title?`<div style="white-space:pre-line">${esc(e.body)}</div>`:''}<div class="f"><span>${src(e)}</span><span class="grow" style="flex:1"></span><button type="button" class="btn sm ghost" data-jact="copy">${icon('copy')}Copy</button><button type="button" class="btn sm ghost" data-jact="edit">${icon('edit')}Edit</button><button type="button" class="btn sm ghost danger" data-jact="del">${icon('trash')}Delete</button></div></div></div>`).join('')}</div></div>`; }).join('')
      +(hidden>0?`<div style="margin-top:18px"><button class="btn ghost" id="j-all">Show ${hidden} earlier day${hidden>1?'s':''}</button></div>`:(jAll&&all.length>7?`<div style="margin-top:18px"><button class="btn ghost" id="j-all">Back to the last 7 days</button></div>`:''))
      +(!shown.length?`<div class="empty" style="margin-top:20px">${filtered?'Nothing matches.':'Nothing yet. Tonight\'s ledger writes the first entries, or add one yourself.'}</div>`:'');
  },
};
function openEntrySheet(en){
  const editing=!!en.id; const areas=[...new Set([...(journal?.areas||[]),...(journal?.entries||[]).map(e=>e.area)])].filter(Boolean);
  document.getElementById('sheet-entry')?.remove();
  const box=document.createElement('form'); box.className='sheet'; box.id='sheet-entry';
  let track=en.track||(jTrack!=='all'?jTrack:'work');
  box.innerHTML=`<h3>${editing?'Edit entry':'Add an entry'}<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
    <div class="field"><label for="je-t">What happened</label><input id="je-t" required maxlength="160" value="${esc(en.title||'')}" placeholder="One line, like the ones written for you"></div>
    <div class="field"><label for="je-b">Detail</label><textarea id="je-b" maxlength="8000" placeholder="Optional">${esc(en.body&&en.body!==en.title?en.body:'')}</textarea></div>
    <div class="field-row"><div class="field"><label for="je-a">Project</label><input id="je-a" list="je-areas" value="${esc(en.area||(jArea!=='all'?jArea:''))}" placeholder="${DEMO?'Northwind':'Example Agency'}"><datalist id="je-areas">${areas.map(a=>`<option value="${esc(a)}">`).join('')}</datalist></div>
      <div class="field"><label for="je-d">Day</label><input id="je-d" type="date" value="${esc(en.date||isoDay())}"></div></div>
    <div class="field-row"><div class="field"><label>Track</label><div class="seg" id="je-tr">${['work','uni','personal'].map(t=>`<button type="button" data-v="${t}" aria-pressed="${t===track}">${TRACK_LABEL[t]}</button>`).join('')}</div></div>
      <div class="field"><label for="je-m">Time spent</label><input id="je-m" inputmode="decimal" value="${en.minutes?Math.round(en.minutes/6)/10:''}" placeholder="Hours, optional"></div></div>
    <div class="foot">${editing?`<button type="button" class="btn ghost danger" id="je-del">Delete</button>`:''}<span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${editing?'Save':'Add'}</button></div>`;
  box.querySelector('#je-tr').addEventListener('click',e=>{ const b=e.target.closest('[data-v]'); if(!b)return; track=b.dataset.v; box.querySelectorAll('#je-tr button').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); });
  box.querySelector('#je-del')?.addEventListener('click',()=>{ closeOverlays(); deleteEntry(en); });
  box.addEventListener('submit',async e=>{ e.preventDefault();
    const title=box.querySelector('#je-t').value.trim(); const body=box.querySelector('#je-b').value.trim(); const h=parseFloat(box.querySelector('#je-m').value);
    const payload={title,body:body||title,area:box.querySelector('#je-a').value.trim()||'Personal',date:box.querySelector('#je-d').value||isoDay(),track,minutes:Number.isFinite(h)?Math.round(h*60):null};
    try{ if(editing)await send('/api/journal/'+en.id,payload,'PATCH'); else await send('/api/journal',payload); closeOverlays(); toast(editing?'Saved':'Added to the journal'); jSig=''; await loadJournal(); }catch(err){ toast(err.message); } });
  document.body.appendChild(box); openSheet('sheet-entry');
}
async function deleteEntry(en){
  journal.entries=journal.entries.filter(x=>x.id!==en.id); jSig=''; VIEWS.journal.update();
  try{ await send('/api/journal/'+en.id,undefined,'DELETE'); }catch(err){ toast(err.message); return loadJournal(); }
  toast('Entry deleted',{undo:async()=>{ const {id,created,updated,...keep}=en; try{ await send('/api/journal',keep); }catch{} jSig=''; loadJournal(); }});
}
function openExportSheet(){
  document.getElementById('sheet-export')?.remove();
  const box=document.createElement('form'); box.className='sheet'; box.id='sheet-export';
  const first=(journal?.entries||[]).map(e=>e.date).sort()[0]||isoDay();
  let track=jTrack, format='md';
  box.innerHTML=`<h3>Export the journal<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
    <p class="dim" style="font-size:13px;margin-bottom:14px">A time report by project and by day. Markdown for reading or sending, CSV for a spreadsheet.</p>
    <div class="field"><label>Range</label><div class="seg" id="jx-pre"><button type="button" data-v="week">This week</button><button type="button" data-v="month">This month</button><button type="button" data-v="term">Since September</button><button type="button" data-v="all">Everything</button></div></div>
    <div class="field-row"><div class="field"><label for="jx-f">From</label><input id="jx-f" type="date" value="${isoDay(new Date(Date.now()-6*86400e3))}"></div><div class="field"><label for="jx-t">To</label><input id="jx-t" type="date" value="${isoDay()}"></div></div>
    <div class="field-row"><div class="field"><label>Track</label><div class="seg" id="jx-tr">${[['all','All'],['work','Work'],['uni','Uni'],['personal','Personal']].map(([v,l])=>`<button type="button" data-v="${v}" aria-pressed="${v===track}">${l}</button>`).join('')}</div></div>
      <div class="field"><label>Format</label><div class="seg" id="jx-fm"><button type="button" data-v="md" aria-pressed="true">Markdown</button><button type="button" data-v="csv" aria-pressed="false">CSV</button></div></div></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" id="jx-copy">${icon('copy')}Copy</button><button class="btn primary" type="submit">${icon('report')}Download</button></div>`;
  const pick=(id,cb)=>box.querySelector(id).addEventListener('click',e=>{ const b=e.target.closest('[data-v]'); if(!b)return; box.querySelectorAll(id+' button').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); cb(b.dataset.v); });
  pick('#jx-tr',v=>track=v); pick('#jx-fm',v=>format=v);
  pick('#jx-pre',v=>{ const now=new Date(); const f=v==='week'?new Date(Date.now()-6*86400e3):v==='month'?new Date(now.getFullYear(),now.getMonth(),1):v==='term'?new Date(now.getMonth()>=8?now.getFullYear():now.getFullYear()-1,8,1):new Date(first+'T12:00'); box.querySelector('#jx-f').value=isoDay(f); box.querySelector('#jx-t').value=isoDay(); });
  const url=()=>api(`/api/journal/report?from=${box.querySelector('#jx-f').value}&to=${box.querySelector('#jx-t').value}&track=${track}&format=${format}`);
  box.addEventListener('submit',e=>{ e.preventDefault(); const a=document.createElement('a'); a.href=url(); a.download=`journal-${track}-${box.querySelector('#jx-f').value}.${format}`; document.body.appendChild(a); a.click(); a.remove(); });
  box.querySelector('#jx-copy').addEventListener('click',async()=>{ try{ const t=await (await fetch(url())).text(); await navigator.clipboard.writeText(t); toast('Copied the report'); }catch{ toast('Copy failed'); } });
  document.body.appendChild(box); openSheet('sheet-export');
}

let ySig='', yShowHidden=false;
/* SYSTEM. Dev servers, live agents and the fleet, for the occasional check. */
VIEWS.system={
  mount(el){
    el.innerHTML=`<div class="vhead"><div><h1>System</h1><p>What's running on the Home Mac, what's down, and which agents are working. Put anything on Tailscale so it opens from every device.</p></div></div>
      <div class="grid"><section class="card c7"><div class="ch">${icon('system')}<h2>On this Mac</h2><span class="sub" id="y-srv-sub"></span><span class="end"><button class="btn sm ghost" id="y-hidden"></button></span></div><div class="rows" id="y-srv"></div></section>
      <div class="c5 stack"><section class="card"><div class="ch">${icon('agent')}<h2>Agents</h2><span class="sub" id="y-ag-sub"></span></div><div class="rows" id="y-ag"></div></section>
      <section class="card"><div class="ch">${icon('globe')}<h2>Sites and services</h2><span class="sub" id="y-fl-sub"></span></div><p class="dim" style="font-size:13px;margin:-6px 0 10px">Checked every few minutes: is it up, and how fast does it answer. Pause old experiments so they stop showing as down.</p><div id="y-fl"></div></section></div>
      <section class="card c12" id="y-gh-card"><div class="ch">${icon('github')}<h2>GitHub</h2><span class="sub" id="y-gh-sub"></span><span class="end"><button class="btn sm ghost" id="y-gh-help">What's a PR?</button></span></div>
        <div class="callout" id="y-gh-explain" hidden>${icon('sparkle')}<span><b>A pull request (PR)</b> is a proposed change: a branch of commits you ask to merge into the main code. <b>Review</b> is someone reading it and approving or asking for changes. <b>Checks</b> are the automatic tests and builds that run on it (green passed, red failed). <b>Merging</b> puts it into main, which on your sites usually means it deploys.</span></div>
        <div class="ghgrid" id="y-gh"></div></section></div>`;
    $('y-gh-help').addEventListener('click',()=>{ $('y-gh-explain').hidden=!$('y-gh-explain').hidden; });
    $('y-fl').addEventListener('click',async e=>{ const b=e.target.closest('[data-fleet]'); if(!b)return; e.preventDefault(); const [act,name]=[b.dataset.fleet,b.dataset.name]; b.disabled=true;
      try{ await send('/api/fleet/'+act,{name}); toast(act==='pause'?`Paused ${name}. It won't count as down.`:`${name} is running again`,act==='pause'?{undo:()=>send('/api/fleet/resume',{name}).then(loadState)}:{}); loadState(); }catch(err){ toast(err.message); b.disabled=false; } });
    $('y-hidden').addEventListener('click',()=>{ yShowHidden=!yShowHidden; ySig=''; VIEWS.system.update(); });
  },
  update(){
    if(!state)return;
    const ys=sig([yShowHidden,state.github?.at,state.local?.servers,(state.ai?.sessions||[]).map(x=>[x.project,x.live,x.did]),state.fleet&&[...(state.fleet.services||[]),...(state.fleet.sites||[])].map(x=>[x.name,x.up,x.paused,Math.round((x.ms||0)/50)])]); if(ys===ySig)return; ySig=ys;
    const every=groupServers(state.local?.servers||[]); const hiddenN=every.filter(s=>s.ignored).length; const servers=every.filter(s=>yShowHidden||!s.ignored);
    $('y-srv-sub').textContent=`${every.length-hiddenN} running${every.filter(s=>s.shareUrl).length?` · ${every.filter(s=>s.shareUrl).length} on Tailscale`:''}`;
    $('y-hidden').hidden=!hiddenN; $('y-hidden').textContent=yShowHidden?'Hide the hidden':`${hiddenN} hidden`;
    $('y-srv').innerHTML=servers.map(s=>{ const name=s.title&&!/^Directory listing/i.test(s.title)?s.title:serverName(s); const where=s.shareUrl?`On Tailscale · ${hostOf(s.shareUrl)}`:homeOnly(s)?'Only on the Home Mac':'On your tailnet';
      return `<div class="row${s.ignored?' ignored':''}" data-port="${s.port}" style="${s.ignored?'opacity:.5':''}"><span class="when-col" style="min-width:56px">:${s.port}</span><div class="main"><div class="t">${esc(name)}</div><div class="s"><i class="dot ${s.shareUrl||!homeOnly(s)?'ok':''}" style="margin-right:6px;vertical-align:1px"></i>${esc(where)} · ${esc(s.project||s.cwd||'')}</div></div>
        <span class="acts"><a class="ibtn" href="${esc(serverUrl(s))}" target="_blank" rel="noopener" data-tip="Open">${icon('out')}</a>${s.shareUrl?`<button class="ibtn" data-sact="copy" data-tip="Copy Tailscale link">${icon('copy')}</button><button class="ibtn" data-sact="unshare" data-tip="Take off Tailscale">${icon('share')}</button>`:`<button class="ibtn" data-sact="share" data-tip="Put on Tailscale">${icon('share')}</button>`}<button class="ibtn" data-sact="save" data-tip="Save to the shelf">${icon('plus')}</button><button class="ibtn" data-sact="hide" data-tip="${s.ignored?'Show in lists again':'Hide from lists'}">${icon(s.ignored?'eye':'eyeoff')}</button><button class="ibtn" data-sact="stop" data-tip="Stop it">${icon('stop')}</button></span></div>`; }).join('')||'<div class="empty">Nothing listening.</div>';
    const ses=(state.ai?.sessions||[]).slice().sort((a,b)=>(b.last||0)-(a.last||0)); const live=ses.filter(s=>s.live);
    $('y-ag-sub').textContent=`${live.length} working`;
    $('y-ag').innerHTML=ses.slice(0,8).map(s=>`<div class="row"><i class="dot ${s.live?'ok pulse':''}"></i><div class="main"><div class="t">${esc(String(s.project||'').split('/').pop()||s.tool)} <span class="dim" style="font-weight:400">· ${esc(s.tool)}</span></div><div class="s">${esc(cap(s.did||s.prompt||'',90))}</div></div><span class="r">${s.live?'now':esc(ago(s.last))}</span></div>`).join('')||'<div class="empty">No sessions today.</div>';
    const gh=state.github; const prRow=(p)=>`<a class="row" href="${esc(p.url)}" target="_blank" rel="noopener"><i class="dot ${p.checks==='passing'?'ok':p.checks==='failing'?'down':p.checks==='pending'?'warn':''}" data-tip="${esc(p.checks?'Checks '+p.checks:'No checks')}"></i><div class="main"><div class="t">${esc(p.title)}</div><div class="s">${esc(String(p.repo||'').split('/').pop())} #${esc(p.number)}${p.draft?' · draft':''}${p.reviewDecision==='APPROVED'?' · approved':p.reviewDecision==='CHANGES_REQUESTED'?' · changes asked for':''}${p.author&&p.author!==gh.user?' · '+esc(p.author):''}</div></div><span class="r">${esc(ago(Date.parse(p.updatedAt)))}</span></a>`;
    if(!gh){ $('y-gh-card').hidden=true; } else { $('y-gh-card').hidden=false; const fail=(gh.failing||[]);
      const rv=gh.reviews||[];
      $('y-gh-sub').textContent=gh.error?gh.error:`${(gh.prs||[]).length} open · ${rv.length?rv.length+' waiting for you':'nobody waiting on you'}${fail.length?` · ${fail.length} failing`:''}`;
      const col=(title,list,empty)=>`<div><div class="fl-h">${esc(title)}</div><div class="rows">${list.length?list.slice(0,6).map(prRow).join(''):`<div class="empty" style="font-size:13px">${esc(empty)}</div>`}</div></div>`;
      // An empty "waiting for you" column only squeezed the other two; the header already says so.
      $('y-gh').classList.toggle('two',!rv.length);
      $('y-gh').innerHTML=(rv.length?col('Waiting for your review',rv,''):'')+col('Your open PRs',gh.prs||[],'No open pull requests.')+col('Merged this week',gh.merged||[],'Nothing merged this week.')
        +(fail.length?`<div style="grid-column:1/-1"><div class="fl-h">Failing on main</div><div class="rows">${fail.slice(0,4).map(x=>`<a class="row" href="${esc(x.url)}" target="_blank" rel="noopener"><i class="dot down"></i><div class="main"><div class="t">${esc(x.workflow||'Build')} failed</div><div class="s">${esc(x.repo)} · ${esc(x.branch||'main')}</div></div><span class="r">${esc(ago(Date.parse(x.at)))}</span></a>`).join('')}</div></div>`:''); }
    const f=state.fleet||{}; const sites=(f.sites||[]).slice(), services=(f.services||[]).slice();
    const down=[...sites,...services].filter(x=>!x.up&&!x.paused).length;
    $('y-fl-sub').textContent=down?`${down} down`:'all up';
    const spark=(h)=>{ const v=(h||[]).slice(-36); if(!v.length)return ''; const max=Math.max(200,...v.filter(n=>n>0)); return `<svg class="spark" viewBox="0 0 ${v.length*3} 16" aria-hidden="true">${v.map((n,i)=>n<0?`<rect x="${i*3}" y="13" width="2" height="3" rx="1" fill="var(--bad)"/>`:`<rect x="${i*3}" y="${16-Math.max(2,n/max*16)}" width="2" height="${Math.max(2,n/max*16)}" rx="1" fill="var(--dim2)"/>`).join('')}</svg>`; };
    const row=(x,svc)=>`<div class="row fl${x.paused?' paused':''}"><i class="dot ${x.paused?'':x.up?'ok':'down'}"></i><a class="main" href="${esc(x.url)}" target="_blank" rel="noopener"><div class="t">${esc(x.name)}</div><div class="s">${esc(hostOf(x.url))}</div></a>${x.paused?'':spark(x.history)}<span class="r">${x.paused?'paused':x.up?x.ms+' ms':'down'}</span>${!svc||x.pausable===false?'':`<span class="acts"><button class="btn sm ghost" data-fleet="${x.paused?'resume':'pause'}" data-name="${esc(x.name)}">${icon(x.paused?'arrow':'pause')}${x.paused?'Resume':'Pause'}</button></span>`}</div>`;
    services.sort((a,b)=>(a.paused-b.paused)||(a.up-b.up));
    $('y-fl').innerHTML=`<div class="fl-h">Your live sites</div><div class="rows">${sites.map(x=>row(x,false)).join('')||'<div class="empty">None set up.</div>'}</div><div class="fl-h">On the Home Mac</div><div class="rows">${services.map(x=>row(x,true)).join('')||'<div class="empty">None set up.</div>'}</div>`;
  },
};

/* BRIEF. The morning brief inside the command centre, to compare with opening it on its own. */
VIEWS.brief={
  mount(el){ if(DEMO){ el.innerHTML=`<div class="vhead"><div><h1>Brief</h1><p>The morning brief isn't part of demo mode. Click Demo in the sidebar, or press ${esc(pageKeyLabel(pageKey('demo')))}, to see it.</p></div></div>`; return; } el.innerHTML=`<div class="briefwrap"><h1 class="a11y-only">Brief</h1><iframe id="brief-frame" title="Morning brief" src="${api('/?embed=1'+(LAB?'&lab=1':''))}" loading="lazy"></iframe><a class="btn sm ghost briefout" href="/${LAB?'?lab=1':''}" target="_blank" rel="noopener">${icon('out')}Open on its own</a></div>`; },
  update(){},
};

/* ---------- deadlines sheet ---------- */
function openDeadlineSheet(){
  const box=document.createElement('form'); box.className='sheet'; box.id='sheet-dl'; document.getElementById('sheet-dl')?.remove();
  box.innerHTML=`<h3>Add a deadline<span class="end"><button type="button" class="ibtn" data-close aria-label="Close">${icon('close')}</button></span></h3>
    <div class="field"><label for="dl-t">What is due</label><input id="dl-t" required maxlength="160"></div>
    <div class="field-row"><div class="field"><label for="dl-d">Due</label><input id="dl-d" type="date" required value="${isoDay(new Date(Date.now()+7*86400e3))}"></div><div class="field"><label>Track</label><div class="seg" id="dl-tr"><button type="button" data-v="uni" aria-pressed="true">Uni</button><button type="button" data-v="work" aria-pressed="false">Work</button><button type="button" data-v="personal" aria-pressed="false">Personal</button></div></div></div>
    <div class="field"><label for="dl-n">Note</label><input id="dl-n" placeholder="Optional"></div>
    <div class="foot"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Add</button></div>`;
  let track='uni';
  box.querySelector('#dl-tr').addEventListener('click',e=>{ const b=e.target.closest('[data-v]'); if(!b)return; track=b.dataset.v; box.querySelectorAll('#dl-tr button').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); });
  box.addEventListener('submit',async e=>{ e.preventDefault(); try{ await send('/api/deadlines',{title:box.querySelector('#dl-t').value.trim(),due:box.querySelector('#dl-d').value,track,note:box.querySelector('#dl-n').value.trim()}); closeOverlays(); toast('Deadline added'); loadState(); }catch(err){ toast(err.message); } });
  document.body.appendChild(box); openSheet('sheet-dl');
}

/* ---------- colour picker ---------- */
// Like Figma's: a square for how light and how strong, a strip for the hue, and a hex box you can type or paste into.
// It changes things as you drag. Click outside, press Esc or Enter, or Done, and it closes keeping the colour.
const hexToRgb=(h)=>{ const n=parseInt(h.slice(1),16); return [n>>16&255,n>>8&255,n&255]; };
const rgbToHex=(r,g,b)=>'#'+[r,g,b].map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');
function hexToHsv(h){ const [r,g,b]=hexToRgb(h).map(x=>x/255); const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn;
  let hu=0; if(d){ hu=mx===r?((g-b)/d)%6:mx===g?(b-r)/d+2:(r-g)/d+4; hu*=60; if(hu<0)hu+=360; } return {h:hu,s:mx?d/mx:0,v:mx}; }
function hsvToHex({h,s,v}){ const f=(n)=>{ const k=(n+h/60)%6; return v-v*s*Math.max(0,Math.min(k,4-k,1)); }; return rgbToHex(f(5)*255,f(3)*255,f(1)*255); }
const cleanHex=(x)=>{ let s=String(x||'').trim().replace(/^#/,''); if(/^[0-9a-f]{3}$/i.test(s))s=s.split('').map(c=>c+c).join(''); return /^[0-9a-f]{6}$/i.test(s)?'#'+s.toLowerCase():null; };
let cpEl=null, cpDone=null;
function closeColourPicker(){ if(!cpEl)return; const d=cpDone; window.MeridianA11y?.close(cpEl); cpEl.remove(); cpEl=null; cpDone=null; removeEventListener('pointerdown',cpOutside,true); removeEventListener('keydown',cpKey,true); d&&d(); }
function cpOutside(e){ if(cpEl&&!cpEl.contains(e.target)&&!e.target.closest('[data-cp-anchor]')){ closeColourPicker(); } }
function cpKey(e){ if(!cpEl)return; if(e.key==='Escape'||(e.key==='Enter'&&e.target.closest?.('.cp-hex')==null)){ e.preventDefault(); e.stopPropagation(); closeColourPicker(); } }
function openColourPicker(anchor,hex,{onInput,onDone}={}){
  if(cpEl&&cpEl._anchor===anchor){ closeColourPicker(); return; }
  closeColourPicker();
  let c=hexToHsv(cleanHex(hex)||'#888888');
  const el=document.createElement('div'); el.className='cpick'; el._anchor=anchor; anchor.setAttribute('data-cp-anchor','');
  el.innerHTML=`<div class="cp-sv"><i class="cp-knob"></i></div><div class="cp-hue"><i class="cp-knob"></i></div>
    <div class="cp-row"><span class="cp-now"></span><label class="cp-hexwrap"><span>#</span><input class="cp-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Hex colour"></label>${window.EyeDropper?`<button type="button" class="ibtn cp-drop" data-tip="Pick from the screen" aria-label="Pick from the screen"><svg class="ico" viewBox="0 0 24 24"><path d="m14 7 3 3M5 19l1.5-.5L17 8a2.1 2.1 0 0 0-3-3L3.5 15.5 3 17z"/></svg></button>`:''}<button type="button" class="btn sm cp-done">Done</button></div>`;
  document.body.appendChild(el); cpEl=el; cpDone=onDone; el.setAttribute('aria-label','Choose a colour'); window.MeridianA11y?.open(el);
  const sv=el.querySelector('.cp-sv'), hue=el.querySelector('.cp-hue'), inp=el.querySelector('.cp-hex');
  const paint=(fromHex)=>{ const hx=hsvToHex(c); sv.style.background=`linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${c.h} 100% 50%))`;
    const k1=sv.firstChild; k1.style.left=(c.s*100)+'%'; k1.style.top=((1-c.v)*100)+'%'; k1.style.background=hx;
    const k2=hue.firstChild; k2.style.left=(c.h/360*100)+'%'; k2.style.background=`hsl(${c.h} 100% 50%)`;
    el.querySelector('.cp-now').style.background=hx; if(!fromHex)inp.value=hx.slice(1); return hx; };
  const emit=(fromHex)=>{ const hx=paint(fromHex); onInput&&onInput(hx); };
  const drag=(area,fn)=>area.addEventListener('pointerdown',e=>{ e.preventDefault(); area.setPointerCapture(e.pointerId);
    const at=(ev)=>{ const r=area.getBoundingClientRect(); fn(Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(ev.clientY-r.top)/r.height))); emit(); };
    at(e); const mv=(ev)=>at(ev); const up=()=>{ area.removeEventListener('pointermove',mv); area.removeEventListener('pointerup',up); }; area.addEventListener('pointermove',mv); area.addEventListener('pointerup',up); });
  drag(sv,(x,y)=>{ c.s=x; c.v=1-y; }); drag(hue,(x)=>{ c.h=x*360; });
  inp.addEventListener('input',()=>{ const h=cleanHex(inp.value); if(h){ c=hexToHsv(h); emit(true); } });
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); const h=cleanHex(inp.value); if(h){ c=hexToHsv(h); emit(); } closeColourPicker(); } });
  inp.addEventListener('paste',()=>setTimeout(()=>{ const h=cleanHex(inp.value); if(h){ c=hexToHsv(h); emit(); } },0));
  el.querySelector('.cp-done').addEventListener('click',closeColourPicker);
  el.querySelector('.cp-drop')?.addEventListener('click',async()=>{ try{ const r=await new EyeDropper().open(); const h=cleanHex(r.sRGBHex); if(h){ c=hexToHsv(h); emit(); } }catch{} });
  paint();
  // Beside the anchor, kept on screen.
  const a=anchor.getBoundingClientRect(), w=el.offsetWidth, h=el.offsetHeight;
  let left=a.left+a.width/2-w/2, top=a.bottom+8; if(top+h>innerHeight-10)top=a.top-h-8;
  el.style.left=Math.max(10,Math.min(innerWidth-w-10,left))+'px'; el.style.top=Math.max(10,top)+'px';
  setTimeout(()=>{ inp.focus(); inp.select(); },30);
  addEventListener('pointerdown',cpOutside,true); addEventListener('keydown',cpKey,true);
}

/* ---------- customise ---------- */
// Five pages so everything has one place: how it looks, Home, the sidebar, Spaces, and the rest.
const CUSTOM_TABS=[['look','Look'],['home','Home'],['side','Sidebar'],['spaces','Spaces'],['more','General']];
const CTAB_KEY='meridian.cc.customTab';
let customTab=(()=>{ try{ const t=localStorage.getItem(CTAB_KEY); return CUSTOM_TABS.some(x=>x[0]===t)?t:'look'; }catch{ return 'look'; } })();
const customScroll={}; let spOpen=null, resetAsk=false;
const customOpen=()=>$('custom').classList.contains('on');
// Opens where you left it: the same page, scrolled to the same place. A page can be asked for by name.
function openCustom(tab){ closeOverlays(); if(typeof tab==='string'&&CUSTOM_TABS.some(x=>x[0]===tab))setCustomTab(tab,{quiet:true}); resetAsk=false; renderCustom(); $('custom').classList.add('on'); window.MeridianA11y?.open($('custom'),{modal:false}); $('custom-body').scrollTop=customScroll[customTab]||0; if(customTab==='home'&&view!=='home')go('home'); }
function setCustomTab(t,{quiet=false}={}){ customScroll[customTab]=$('custom-body').scrollTop; customTab=t; try{ localStorage.setItem(CTAB_KEY,t); }catch{} if(quiet)return; resetAsk=false; renderCustom(); $('custom-body').scrollTop=customScroll[t]||0; if(t==='home'&&view!=='home')go('home'); }
$('custom-tabs').addEventListener('keydown',e=>{
  const tab=e.target.closest('[data-ctab]'); if(!tab)return;
  const i=CUSTOM_TABS.findIndex(x=>x[0]===tab.dataset.ctab);
  const next=e.key==='Home'?0:e.key==='End'?CUSTOM_TABS.length-1:e.key==='ArrowRight'?(i+1)%CUSTOM_TABS.length:e.key==='ArrowLeft'?(i+CUSTOM_TABS.length-1)%CUSTOM_TABS.length:null;
  if(next===null)return; e.preventDefault(); setCustomTab(CUSTOM_TABS[next][0]); $('custom-tabs').querySelector('[aria-selected="true"]')?.focus();
});
$('custom-tabs').addEventListener('click',e=>{ const b=e.target.closest('[data-ctab]'); if(b&&b.dataset.ctab!==customTab)setCustomTab(b.dataset.ctab); });
$('custom-body').addEventListener('scroll',()=>{ customScroll[customTab]=$('custom-body').scrollTop; },{passive:true});

// Something you can only see on Home takes you there, scrolled to it, with a short glow round it.
const WHERE={hero:'#h-hero',herograd:'#h-hero',hedge:'#h-hero',hmove:'#h-hero',planet:'#h-hero',mixevery:'#h-hero',hhero:'#h-hero',hnext:'#h-next-card',nxs:'#h-next-card',calcol:'#h-next-card',hshelf:'#h-shelf-sec'};
function showWhere(key){
  const sel=WHERE[key]; if(!sel&&key!=='home')return;
  const was=view; if(view!=='home')go('home'); if(!sel)return;
  setTimeout(()=>{ const el=document.querySelector(sel); if(!el)return;
    if(sel==='#h-hero')(isMobile()?window:$('page')).scrollTo({top:0,behavior:'smooth'}); else el.scrollIntoView({block:'center',behavior:'smooth'});
    el.classList.remove('c-flash'); void el.offsetWidth; el.classList.add('c-flash'); },was==='home'?30:160);
}

// Undo and redo for everything in Customise. Each step keeps prefs from before and after the change.
// Clicks are a step each; a slider or typing a name folds into one step.
// Kept in memory only and capped, so it costs next to nothing; a reload starts it fresh.
const hist={back:[],fwd:[]};
const prefsSnap=()=>JSON.stringify(prefs,(k,v)=>k==='updated'?undefined:v);
let histOpen=null;
function histStart(label){ if(!histOpen)histOpen={before:prefsSnap(),label}; else if(label&&!histOpen.label)histOpen.label=label; }
function histEnd(label){ const h=histOpen; histOpen=null; if(!h)return; const after=prefsSnap(); if(after===h.before)return; histPush({before:h.before,after,label:label||h.label||'the change'}); }
function histPush(step){ hist.back.push(step); if(hist.back.length>25)hist.back.shift(); hist.fwd=[]; histSave(); }
function histSave(){ histButtons(); }
function histButtons(){ const u=hist.back[hist.back.length-1], r=hist.fwd[hist.fwd.length-1];
  $('c-undo').disabled=!u; $('c-undo').dataset.tip=u?`Undo ${u.label}|⌘Z`:'Nothing to undo';
  $('c-redo').disabled=!r; $('c-redo').dataset.tip=r?`Redo ${r.label}|⇧⌘Z`:'Nothing to redo'; }
function histGo(dir){
  if(histOpen){ clearTimeout(histEnd.t); histEnd(); } // a slider still settling is its own step, recorded before undo picks one
  const from=dir<0?hist.back:hist.fwd, to=dir<0?hist.fwd:hist.back; const s=from.pop(); if(!s)return; to.push(s); const v=dir<0?s.before:s.after;
  if(s.app)Promise.resolve(window.MeridianApp?.set(s.app,v)).then(()=>{ if(customOpen())renderCustom(); }).catch(err=>toast(String(err?.message||err)));
  else swapPrefs(v);
  histSave(); toast(`${dir<0?'Undone':'Redone'}: ${s.label}`);
}
// Puts a whole set of prefs back and redraws everything they touch. Web tabs and links moved by hand aren't settings, so they
// stay as they are; nor do your photos, shortcuts and starred models, which change outside the drawer and have their own undo.
function swapPrefs(json){
  const next=JSON.parse(json); next.webTabs=prefs.webTabs; if(next.spaces&&prefs.spaces)next.spaces.links=prefs.spaces.links; const mode=prefs.side.mode;
  for(const k of ['heroPhotos','heroPhoto','keys','pickStars'])next[k]=prefs[k];
  if(Array.isArray(next.heroMix)){ const ids=new Set(heroPhotos().map(p=>'photo:'+p.id)); next.heroMix=next.heroMix.filter(k=>!k.startsWith('photo:')||ids.has(k)); }
  prefs=migrate(merge(DEFAULTS,next)); savePrefs(); if(prefs.side.mode!==mode)setSideMode(prefs.side.mode);
  if(spaceId!=='all'&&!activeSpace())setSpace('all',{quiet:true});
  sideSig=''; renderSide(); miniCache.clear(); renderTabs(); stripSig=''; renderStrip();
  if(view==='home'&&state){ VIEWS.home.mount($('v-home')); VIEWS.home.update(); }
  if(customOpen())renderCustom();
}
$('c-undo').addEventListener('click',()=>histGo(-1));
$('c-redo').addEventListener('click',()=>histGo(1));
document.addEventListener('keydown',e=>{ if(!customOpen()||!(e.metaKey||e.ctrlKey)||e.altKey||e.key.toLowerCase()!=='z'||e.target.closest?.('input:not([type=range]):not([type=color]),textarea'))return; e.preventDefault(); histGo(e.shiftKey?1:-1); });
// Every change in the drawer is recorded on its way in, before the handlers below run.
const optLabel=(el)=>el.closest('[data-hist]')?.dataset.hist||(el.closest('.sp-ed')?(el.closest('.sp-ed').querySelector('.sp-head b').textContent+' Space'):'')||el.closest('.opt-g')?.querySelector(':scope>label')?.textContent?.trim()||'';
$('custom-body').addEventListener('click',e=>{
  if(e.target.closest('[data-ckey="demo"],[data-sp-open]'))return;
  const ap=e.target.closest('.seg[data-appkey] [data-v]'); const A=window.MeridianApp;
  if(ap){ if(A?.settings){ const k=ap.closest('.seg').dataset.appkey; let v=ap.dataset.v; if(v==='true')v=true; if(v==='false')v=false; if(k==='sleepAfter')v=Number(v); const before=A.settings[k]; if(String(before)!==String(v))histPush({app:k,before,after:v,label:optLabel(ap)||'the app setting'}); } return; }
  if(histOpen){ clearTimeout(histEnd.t); histEnd(); } // typing that's still settling is its own step
  histStart(optLabel(e.target)); setTimeout(()=>histEnd(),0);
},true);
$('custom-body').addEventListener('input',e=>{ histStart(optLabel(e.target)); clearTimeout(histEnd.t); histEnd.t=setTimeout(()=>histEnd(),700); },true);
histButtons();

const SURFACES=[
  {id:'ink',name:'Ink',hint:'Black, grey cards',c:['#0c0c0d','#000','#1c1c1e']},
  {id:'graphite',name:'Graphite',hint:'Grey, black cards',c:['#131315','#222225','#0b0b0c']},
  {id:'hairline',name:'Hairline',hint:'The original lines',c:['#000','#000','#000'],line:true},
  {id:'daylight',name:'Daylight',hint:'Light, white cards',c:['#dddde1','#f2f2f4','#ffffff']},
  {id:'onyx',name:'Onyx',hint:'All black, cards lit from above',c:['#000','#000','#151517']},
  {id:'smoke',name:'Smoke',hint:'Glass over today’s picture',c:['#1d1f24','rgba(40,44,52,.6)','rgba(70,74,84,.7)']},
  {id:'nothing',name:'Nothing',hint:'Black, white, one red, in dots',c:['#000','#000','#111112']},
];
// Looks still being tried in /labs/home.html. Customise only shows one if it's the look in use.
const LAB_SURFACES=[
  {id:'petrol',name:'Petrol',hint:'Deep blue-green',c:['#071214','#040b0c','#12252a']},
];
// Little drawings of what an option does: a frame with blocks in it. Each part is [left, top, width, height] in %,
// then a kind (s sidebar, t text, a accent, h header, p floating panel, f floating, g glow) and any extra style.
const pv=(parts,cls='')=>`<span class="vpv ${cls}" aria-hidden="true">${parts.map(([l,t,w,h,k='',st=''])=>`<i class="${k}" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%;${st}"></i>`).join('')}</span>`;
const PAGE=[[27,6,70,88]], SIDE=[[0,0,24,100,'s']];
const DRAW={
  mode:{docked:[...SIDE,...PAGE],compact:[[0,0,9,100,'s'],[12,6,85,88]],float:[[3,6,94,88],[6,12,22,76,'s f']],off:[[3,6,94,88]]},
  side:{left:[...SIDE,...PAGE],right:[[76,0,24,100,'s'],[3,6,70,88]]},
  tint:{off:[...SIDE,...PAGE],accent:[...SIDE,[0,0,24,100,'g'],...PAGE],today:[...SIDE,[0,0,24,100,'g','background:linear-gradient(180deg,var(--day-1,#c66) ,var(--day-2,#68c) 45%,transparent 80%);opacity:.6'],...PAGE]},
  inset:{inset:[...SIDE,[27,6,70,88]],flush:[...SIDE,[24,0,76,100,'','border-radius:0']]},
  glass:{solid:[[8,16,84,8,'t'],[8,36,84,8,'t'],[8,56,84,8,'t'],[8,76,60,8,'t'],[22,22,56,56,'p']],frosted:[[8,16,84,8,'t'],[8,36,84,8,'t'],[8,56,84,8,'t'],[8,76,60,8,'t'],[22,22,56,56,'p fr']]},
  density:{comfortable:[[8,10,84,18],[8,40,84,18],[8,70,84,18]],compact:[[8,8,84,12],[8,26,84,12],[8,44,84,12],[8,62,84,12],[8,80,84,12]]},
  accentStyle:{quiet:[[10,30,80,40],[16,44,8,12,'a','border-radius:50%'],[30,46,40,8,'t']],tint:[[10,30,80,40,'','background:color-mix(in oklab,var(--accent) 22%,var(--well-hi))'],[30,46,40,8,'t']],bold:[[10,30,80,40,'a'],[30,46,40,8,'t','background:var(--accent-ink)']]},
  hhero:{banner:[[0,0,100,30,'h'],[8,38,36,8,'t'],[6,54,42,40],[52,54,42,40]],tall:[[0,0,100,62,'h'],[8,44,40,9,'t','background:#fff;opacity:.8'],[6,70,42,30],[52,70,42,30]],scroll:[[0,0,100,30,'h'],[0,30,100,18,'h','opacity:.35'],[8,56,36,8,'t'],[6,70,42,30],[52,70,42,30]]},
  hnext:{stack:[[8,8,84,40,'a','opacity:.5'],[8,56,84,14],[8,76,84,14]],agenda:[[8,10,14,12,'t'],[26,8,66,16],[8,40,14,12,'t'],[26,38,66,16],[8,70,14,12,'t'],[26,68,66,16]],spotlight:[[8,8,84,84,'a','opacity:.5'],[16,24,40,10,'t'],[16,42,56,16,'t']],timeline:[[6,48,88,4,'t'],[10,30,12,40],[28,30,22,40,'a','opacity:.6'],[56,30,10,40],[74,30,16,40]]},
  nxs:{wash:[[8,14,84,44,'','background:linear-gradient(120deg,color-mix(in oklab,#4f8cff 45%,var(--well-hi)),var(--well-hi))'],[14,24,22,14,'t'],[42,26,40,8,'t'],[8,68,84,8],[8,82,84,8]],
    line:[[8,14,84,44],[8,14,3,44,'','background:#4f8cff'],[16,24,22,14,'t'],[44,26,38,8,'t'],[8,68,84,8],[8,82,84,8]],
    open:[[8,18,30,18,'t'],[8,42,60,8,'t','opacity:.7'],[8,68,84,8],[8,82,84,8]]},
  hshelf:{scroll:[[6,28,20,44],[29,28,20,44],[52,28,20,44],[75,28,20,44],[98,28,20,44]],row:[[6,30,19,40],[28,30,19,40],[50,30,19,40],[72,30,19,40]],fit:[[6,10,26,36],[37,10,26,36],[68,10,26,36],[6,54,26,36],[37,54,26,36]],dock:[[16,62,68,26,'','border-radius:6px'],[22,67,10,16,'t'],[36,67,10,16,'t'],[50,67,10,16,'t'],[64,67,10,16,'t']]},
  sel:{glow:[[18,20,64,60,'','box-shadow:0 0 0 1px color-mix(in oklab,var(--accent) 60%,transparent),0 0 12px 1px color-mix(in oklab,var(--accent) 40%,transparent)']],
    tint:[[18,20,64,60,'','background:color-mix(in oklab,var(--accent) 26%,var(--well-hi))']],
    lift:[[18,14,64,60,'','box-shadow:0 6px 10px -3px rgba(0,0,0,.6),inset 0 -2px 0 var(--accent)']],
    outline:[[18,20,64,60,'','outline:1.5px solid var(--accent);outline-offset:1px']]},
  flash:{glow:[[14,18,72,64,'','box-shadow:0 0 14px 3px color-mix(in oklab,var(--accent) 35%,transparent)']],wash:[[14,18,72,64,'','background:color-mix(in oklab,var(--accent) 22%,var(--well-hi))']],
    lift:[[14,10,72,64,'','box-shadow:0 8px 12px -4px rgba(0,0,0,.6)']],off:[[14,18,72,64]]},
  spacespos:{bottom:[[0,0,30,100,'s'],[4,10,22,8,'t'],[4,26,22,6,'t','opacity:.5'],[4,36,22,6,'t','opacity:.5'],[4,84,4,8,'a'],[10,84,4,8,'t'],[16,84,4,8,'t'],[33,6,64,88]],top:[[0,0,30,100,'s'],[4,10,22,8,'t'],[4,24,7,8,'a','border-radius:4px'],[12,24,7,8,'t','border-radius:4px'],[20,24,6,8,'t','border-radius:4px'],[4,42,22,6,'t','opacity:.5'],[4,52,22,6,'t','opacity:.5'],[33,6,64,88]]},
};
// The header thumbnails are the real thing: today's pictures, the set gradients and your own.
function heroPv(v){
  const it=almanac?.items||{}; const set=SET_GRADIENTS[v]; let bg='', inner='', cls='';
  const words=`<i class="w" style="left:9%;top:56%;width:48%;height:10%"></i><i class="w" style="left:9%;top:73%;width:30%;height:7%;opacity:.55"></i>`;
  if(v==='earth')v=HERO_PLANETS[lookOpt('planet')]||'earth';
  if(v==='photo'){ const ph=heroPhotos(); const p=ph.find(x=>x.id===prefs.heroPhoto)||ph[0]; v=p?'photo:'+p.id:''; }
  if(v==='mix'){ const list=(prefs.heroMix||[]).filter(heroOk).slice(0,4); inner=`<span class="mixs">${list.map(k=>`<b style="background:${heroPvBg(k)||'var(--well)'}"></b>`).join('')}</span>`; bg=list.length?' ':''; }
  else if(v==='globe'||v==='week'){ const b=BODIES[v==='globe'?'earth':WEEK_BODY[new Date().getDay()]]; cls=' space'; bg=' ';
    inner=b.tex==='saturn'?`<i class="orb" style="right:22%;top:24%;width:30%;aspect-ratio:1;background-image:${planetTexture(b.tex)}"></i><i style="position:absolute;right:10%;top:44%;width:54%;height:12%;border-radius:50%;border:2px solid rgba(220,200,160,.55);transform:rotate(-14deg)"></i>`
      :`<i class="orb" style="right:${b.sun?-14:8}%;top:${b.sun?6:18}%;width:${b.sun?60:44}%;aspect-ratio:1;background-image:${planetTexture(b.tex)}${b.sun?';box-shadow:0 0 14px 4px rgba(255,140,40,.55)':''}"></i>`; }
  else bg=heroPvBg(v);
  return `<span class="vpv vhero${cls}${bg?'':' none'}" aria-hidden="true"${bg.trim()?` style="background:${bg}"`:''}>${inner}${words}</span>`;
}
// A header's look as one CSS background, for thumbnails.
function heroPvBg(v){
  const it=almanac?.items||{}; const set=SET_GRADIENTS[v];
  if(v==='custom'){ const g=ownGradient(); return colourGradient(g.stops,g.style,g.angle); }
  if(set?.img)return `url('${set.img}') center/cover`;
  if(v==='colours'){ const c=(it.colours?.colours||[]).map(x=>x.hex); return c.length?colourGradient(c,lookOpt('herograd')||'linear'):''; }
  if(v.startsWith('photo:')){ const p=heroPhotos().find(x=>'photo:'+x.id===v); return p?`url('${api(p.url||'/api/command/hero-photo/'+p.id)}') center ${cropY(p)}%/cover`:''; }
  if(v==='globe'||v==='week')return `#000 ${planetTexture(v==='globe'?'earth':BODIES[WEEK_BODY[new Date().getDay()]].tex)} center/auto 100%`;
  const p=v==='earthview'?it.earthView:v==='picture'?it.picture:v==='earth'?it.earth:null; const src=p&&!p.error?imgUrl(p.image):'';
  return src?`url('${api(src)}') center/cover`:'';
}
// Everything Mix can choose from.
const MIX_CHOICES=()=>[['earthview','Earth View'],['picture','Picture'],['earth',"Today's Earth"],['globe','Earth, turning'],['week','Planet of the day'],['colours',"Today's colours"],['dusk','Dusk'],
  ...(prefs.gradient?[['custom','Your gradient']]:[]),...heroPhotos().map((p,i)=>['photo:'+p.id,p.name||`Photo ${i+1}`])];
// Where the header meets the page, drawn on the header you have.
function edgePv(v){
  const k=heroNow(); const bg=(k!=='off'&&heroPvBg(k))||'linear-gradient(180deg,#2a1a4a,#d9467a 55%,#f7845e 80%,#ffcf8a)';
  if(v==='auto')v=/gradient|hero-dusk/.test(bg)?'deepen':'fade';
  const fade='-webkit-mask-image:linear-gradient(#000 20%,transparent 95%);mask-image:linear-gradient(#000 20%,transparent 95%)';
  const base=`<i style="left:0;top:0;width:100%;height:${v==='edge'?80:100}%;border-radius:0;background:${bg};${v==='fade'?fade:''}"></i>`;
  const deep=v==='deepen'?`<i style="left:0;top:0;width:100%;height:100%;border-radius:0;background:linear-gradient(#fff 25%,var(--deep1,#7a3050) 70%,var(--deep2,#1a0c12));mix-blend-mode:multiply"></i>`:'';
  return `<span class="vpv vhero" aria-hidden="true">${base}${deep}<i class="w" style="left:9%;top:56%;width:48%;height:10%"></i></span>`;
}
function renderCustom(){
  const focus=$('custom').contains(document.activeElement)?document.activeElement:null;
  const group=focus?.closest('[data-key],[data-appkey]');
  const focusKey=focus&&{id:focus.id,tag:focus.tagName,data:{...focus.dataset},group:group&&{...group.dataset}};
  // Every row can be locked (it stops being a choice) or trimmed (hover an option, press × to stop offering it).
  // A row with drawings (draw) shows each option as a small picture of what it does.
  const C=prefs.custom||{};
  const seg=(key,opts,cur,scope='look',draw)=>{ const id=scope+'.'+key; const hid=C.hidden?.[id]||[]; if(!opts.some(([v])=>v===cur))cur=opts[0][0];
    if(C.locked?.[id]){ const o=opts.find(([v])=>v===cur); return `<div class="seg-row"><div class="seg locked"><span>${o[1]}</span></div><button type="button" class="ibtn seg-lock on" data-unlock="${id}" data-tip="Locked|Click to make it a choice again">${icon('lock')}</button></div>`; }
    const vis=opts.filter(([v])=>!hid.includes(v)||v===cur);
    const x=(v)=>v!==cur&&vis.length>2?`<i class="seg-x" data-hide-opt="${id}|${v}" data-tip="Stop offering this">${icon('close')}</i>`:'';
    const more=hid.length?`<button type="button" class="seg-more" data-unhide="${id}">Show ${hid.length} removed</button>`:'';
    if(draw)return `<div class="vcards" style="--n:${Math.min(vis.length,4)}" data-scope="${scope}" data-key="${key}">${vis.map(([v,l])=>`<button type="button" class="vcard" data-v="${v}" aria-pressed="${v===cur}">${typeof draw==='function'?draw(v):pv(draw[v]||[])}<span>${l}</span>${x(v)}</button>`).join('')}</div>${more}`;
    return `<div class="seg-row"><div class="seg" data-scope="${scope}" data-key="${key}">${vis.map(([v,l])=>`<button type="button" data-v="${v}" aria-pressed="${v===cur}">${l}${x(v)}</button>`).join('')}</div><button type="button" class="ibtn seg-lock" data-lock="${id}" data-tip="Lock it|Keep this and stop offering the rest">${icon('lock')}</button></div>${more}`; };
  const L=prefs.look; const tf=almanac?.items?.typeface?.family;
  const corner={sharp:4,soft:9,squircle:16};
  const head=(t)=>`<h4 class="c-h">${t}</h4>`;
  const pages={
    look:()=>{ TYPES.forEach(t=>loadFont(t.css)); applyType(); return head('Colour')+`
    <div class="opt-g"><label class="lab-row">Look${C.locked?.['look.surface']?`<button type="button" class="ibtn seg-lock on" data-unlock="look.surface" data-tip="Locked|Click to choose again">${icon('lock')}</button>`:`<button type="button" class="ibtn seg-lock" data-lock="look.surface" data-tip="Lock it|Keep this look and hide the rest">${icon('lock')}</button>`}</label><div class="surfaces">${[...SURFACES,...LAB_SURFACES.filter(x=>x.id===L.surface)].filter(s=>s.id===L.surface||(!C.locked?.['look.surface']&&!(C.hidden?.['look.surface']||[]).includes(s.id))).map(s=>`<button type="button" class="surf" data-surface="${s.id}" aria-pressed="${L.surface===s.id}">${s.id!==L.surface?`<i class="seg-x surf-x" data-hide-opt="look.surface|${s.id}" data-tip="Stop offering this look">${icon('close')}</i>`:''}<div class="pv" style="background:${s.c[0]}"><div class="s" style="background:${s.c[0]};${s.line?'box-shadow:inset -1px 0 rgba(255,255,255,.18)':''}"></div><div class="m" style="background:${s.c[1]};${s.line?'box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)':''}"><i style="background:${s.c[2]};${s.line?'box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)':''}"></i><i style="background:${s.c[2]};${s.line?'box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)':''}"></i></div></div>${s.name}<small>${s.hint}</small></button>`).join('')}</div></div>
    <div class="opt-g"><label>Accent</label><div class="swatch-row">${ACCENTS.map(a=>`<button type="button" class="swatch" data-accent="${a.hex}" data-tip="${a.name}" aria-label="${a.name}" aria-pressed="${prefs.accent===a.hex}" style="background:${a.hex}"></button>`).join('')}<button type="button" class="swatch" data-accent="today" data-tip="Today's|The boldest of the day's colours" aria-label="Today's colour" aria-pressed="${prefs.accent==='today'}" style="background:conic-gradient(${(almanac?.items?.colours?.colours||[{hex:'#f6c93a'},{hex:'#ff5247'},{hex:'#6db4ff'}]).map(c=>c.hex).join(',')})"></button></div>${activeSpace()&&lookOpt('spaceaccent')!=='off'?`<p class="hint">You're in ${esc(activeSpace().name)}, so buttons wear its colour for now. Your accent shows in All.</p>`:''}</div>
    <div class="opt-g"><label>How much accent</label>${seg('accentStyle',[['quiet','Quiet'],['tint','Tinted'],['bold','Bold']],L.accentStyle,'look',DRAW.accentStyle)}<p class="hint">Quiet keeps it to dots and buttons. Tinted washes the active tab and toggles. Bold fills them.</p></div>
    <div class="opt-g"><label>Sidebar glow</label>${seg('tint',[['off','Off'],['accent','Accent'],['today',"Today's colours"]],L.tint,'look',DRAW.tint)}<p class="hint">Today's colours come from the day's Wada combination in the almanac, so the frame changes every morning.</p></div>`
    +head('Type and shape')+`
    <div class="opt-g"><label>Type</label><div class="typegrid">${TYPES.map(t=>{ const fam=t.id==='today'?(tf||'Fraunces'):t.title; const ital=t.id==='editorial'?'font-style:italic;':''; return `<button type="button" class="typecard" data-type="${t.id}" aria-pressed="${L.type===t.id}"><b style="font-family:'${esc(fam)}',var(--f-body);${ital}">Aa</b><span>${esc(t.name)}</span><span class="dim2">${esc(t.id==='today'?(tf||'from the almanac'):t.title)}</span></button>`; }).join('')}</div></div>
    <div class="opt-g"><label>Corners</label><div class="cornerrow">${[['sharp','Sharp'],['soft','Soft'],['squircle','Squircle']].map(([v,l])=>`<button type="button" class="cornerbtn" data-corner="${v}" aria-pressed="${L.radius===v}"><i style="border-top-left-radius:${corner[v]}px;${v==='squircle'?'corner-shape:squircle;border-top-left-radius:20px':''}"></i>${l}</button>`).join('')}</div>${CSS.supports('corner-shape','squircle')?'':'<p class="hint">This browser draws squircles as soft rounds.</p>'}</div>
    <div class="opt-g"><label>Density</label>${seg('density',[['comfortable','Comfortable'],['compact','Compact']],L.density,'look',DRAW.density)}</div>`
    +head('Finish')+`
    <div class="opt-g"><label>Window</label>${seg('inset',[['inset','Inset page'],['flush','Edge to edge']],L.inset,'look',DRAW.inset)}</div>
    <div class="opt-g"><label>Floating panels</label>${seg('glass',[['solid','Solid'],['frosted','Frosted glass']],L.glass,'look',DRAW.glass)}<p class="hint">Search, menus and sheets.</p></div>
    <div class="opt-g"><label>Selected</label>${seg('sel',[['glow','Glow'],['tint','Tint'],['lift','Lift'],['outline','Outline']],L.sel||'glow','look',DRAW.sel)}<p class="hint">How a picked option shows, here and in other choices like this.</p></div>
    <div class="opt-g"><label>Change highlight</label>${seg('flash',[['glow','Glow'],['wash','Wash'],['lift','Lift'],['off','None']],L.flash||'glow','look',DRAW.flash)}<p class="hint">When a change lands somewhere else, like Home, this is how it points it out.</p></div>
    <div class="opt-g"><label>Effect</label>${seg('fx',[['none','None'],['edge','Edge light']],L.fx||'none')}</div>
    <div class="opt-g"><label>Grain</label><div class="range"><input type="range" min="0" max="100" step="1" id="c-grain" value="${Number(prefs.grain)||0}" style="--v:${Number(prefs.grain)||0}%" aria-label="Grain"><output id="c-grain-v">${Number(prefs.grain)||0}</output></div></div>`; },
    home:()=>`<p class="c-where">${icon('home')}<span>These change Home. Each one scrolls to what it changes.</span></p>
    <div class="opt-g"><label>Header image</label>${seg('hero',[['earthview','Earth View'],['picture','Picture'],['earth','Planet'],['colours',"Today's colours"],['dusk','Dusk'],['photo','Your photo'],['custom','Your gradient'],['mix','Mix'],['off','Off']],L.hero,'look',heroPv)}
      ${L.hero==='custom'?`<button type="button" class="btn c-grad" id="c-grad">${icon('palette')}Edit your gradient</button>`:''}
      ${L.hero==='photo'?`<button type="button" class="btn c-grad" id="c-photo">${icon('image')}Your photos</button>`:''}
      ${L.hero==='colours'?`<div class="c-sub"><label>Blend</label>${seg('herograd',[['linear','Sweep'],['mesh','Mesh'],['horizon','Horizon']],L.herograd||'linear')}</div>`:''}
      ${L.hero==='earth'?`<div class="c-sub"><label>Planet</label>${seg('planet',[['photo',"Today's Earth"],['globe','Earth, turning'],['week','Planet of the day']],L.planet||'photo')}</div><p class="hint">Today's Earth is NASA's photo from a million miles out. Planet of the day follows the names of the days: the Sun on Sunday, the Moon on Monday, then Mars, Mercury, Jupiter, Venus and Saturn.</p>`:''}
      ${L.hero==='mix'?`<div class="c-sub"><label>Changes</label>${seg('mixevery',[['day','Every day'],['visit','Every visit']],L.mixevery||'day')}</div><div class="mixpick" id="c-mix">${MIX_CHOICES().map(([k,l])=>`<button type="button" data-mix="${esc(k)}" aria-pressed="${(prefs.heroMix||[]).includes(k)}">${heroPv(k)}<span>${esc(l)}</span></button>`).join('')}</div><p class="hint">Pick the headers to take turns.</p>`:''}</div>
    <div class="opt-g"><label>Where it meets the page</label>${seg('hedge',[['fade','Fade'],['edge','Edge'],['deepen','Deepen']],['edge','deepen'].includes(L.hedge)?L.hedge:'fade','look',edgePv)}<p class="hint">Fade lets the picture melt into the page. Edge keeps the full colour almost to the bottom, and the words turn dark on a light header. Deepen darkens the header's own colours into the page.</p></div>
    <div class="opt-g"><label>Motion</label>${seg('hmove',[['still','Still'],['move','Moving']],L.hmove||'still')}<p class="hint">Moving drifts photos and gradients slowly and turns the planets. It stays still if your Mac is set to reduce motion.</p></div>
    <div class="opt-g"><label>Header size</label>${seg('hhero',[['banner','Banner'],['tall','Tall'],['scroll','Grows']],L.hhero||'banner','look',DRAW.hhero)}<p class="hint">Grows makes the banner tall when you pull down at the top of the page, and settles it when you scroll down.</p></div>
    <div class="opt-g"><label>Next meeting</label>${seg('nxs',[['wash','Wash'],['line','Line'],['open','Open']],L.nxs||'wash','look',DRAW.nxs)}<p class="hint">How the first thing in Up next stands out.</p></div>
    <div class="opt-g"><label>Top shelf on Home</label>${seg('hshelf',[['scroll','Scroll'],['row','One row'],['fit','Fit'],['dock','Dock']],homeShelfMode(),'look',DRAW.hshelf)}</div>
    <div class="opt-g"><label>On Home</label><div class="tablist-edit" id="c-home">${homeOrder().map(id=>{ const [,l,ic]=HOME_SECS.find(x=>x[0]===id); const off=(prefs.homeHidden||[]).includes(id); return `<div class="te${off?' off':''}" data-hsec="${id}"><span class="grip" aria-hidden="true">${icon('grip')}</span>${icon(ic)}<span>${l}</span><button type="button" class="ibtn" data-hhide="${id}" data-tip="${off?'Show it on Home':'Hide it from Home'}" aria-label="${off?'Show':'Hide'}">${icon(off?'eyeoff':'eye')}</button></div>`; }).join('')}</div><p class="hint">Drag to reorder. Up next and To do stay at the top; cards next to each other share a row.</p></div>`,
    side:()=>{ const order=[...prefs.tabs.order.filter(id=>TAB_DEFS.some(t=>t.id===id)),...TAB_DEFS.map(t=>t.id).filter(id=>!prefs.tabs.order.includes(id))];
      return `<div class="opt-g" style="margin-top:6px"><label>Sidebar</label>${seg('mode',[['docked','Docked'],['compact','Compact'],['float','Float'],['off','Hidden']],prefs.side.mode,'side',DRAW.mode)}<p class="hint">Float tucks it away until your pointer reaches the edge. ⌘S toggles it, \\ switches to compact.</p></div>
    <div class="opt-g"><label>Which side</label>${seg('side',[['left','Left'],['right','Right']],prefs.side.side,'side',DRAW.side)}</div>
    <div class="opt-g"><label>When hidden with ⌘S</label>${seg('hide',[['float','Peek from the edge'],['off','Stay hidden']],prefs.side.hide,'side')}</div>
    <div class="opt-g"><label>Tab style</label>${seg('tabStyle',[['list','List'],['previews','Previews']],prefs.side.tabStyle||'list','side')}<p class="hint">Previews shows a live miniature of each tab above its name.</p></div>
    <div class="opt-g"><label>Tabs</label><div class="tablist-edit" id="c-tabs">${order.map(id=>{ const t=TAB_DEFS.find(x=>x.id===id); const off=prefs.tabs.hidden.includes(id)&&id!=='home';
      return `<div class="te${off?' off':''}" data-tab="${id}"><span class="grip" aria-hidden="true">${icon('grip')}</span>${icon(t.icon)}<span>${esc(t.label)}</span>${id==='home'?'<span style="width:30px"></span>':`<button type="button" class="ibtn" data-thide="${id}" data-tip="${off?'Show this tab':'Hide this tab'}" aria-label="${off?'Show':'Hide'}">${icon(off?'eyeoff':'eye')}</button>`}</div>`; }).join('')}</div><p class="hint">Drag to reorder. You can also drag tabs in the sidebar, or right-click one to hide it.</p></div>
    <div class="opt-g"><label>Day line</label>${seg('dayline',[['off','Off'],['on','On']],L.dayline||'off')}<p class="hint">A line down the sidebar edge from midnight to midnight, with a dot for now.</p></div>`; },
    spaces:()=>{ const pos=L.spacespos||'bottom';
      const show=`<div class="opt-g"><label>Spaces</label>${seg('spaces',[['hidden','Hidden'],['shown','In the sidebar']],L.spaces||'hidden')}<p class="hint">Hidden for now while we work out what Spaces are for. Hidden, everything shows as All; your Spaces and their groups are kept.</p></div>`;
      if(!spacesOn())return show;
      return show+spacesEditor()+head('How they show')+`
    <div class="opt-g"><label>Where they sit</label>${seg('spacespos',[['bottom','Bottom, as icons'],['top','Under search']],pos,'look',DRAW.spacespos)}
      ${pos==='bottom'?`<div class="c-sub"><label>Icons</label>${seg('spaceicons',[['filled','Filled'],['outline','Outline']],L.spaceicons||'filled')}</div>`:''}
      ${pos==='top'?`<div class="c-sub"><label>Style</label>${seg('spacestyle',[['pills','Pills'],['segment','Segmented'],['tabs','Underline'],['dots','Dots']],L.spacestyle||'pills')}</div>`:''}</div>
    <div class="opt-g"><label>In a Space</label>${seg('spaceaccent',[['on','Accent follows the Space'],['off','Keep my accent']],L.spaceaccent||'on')}<p class="hint">Buttons and highlights take the Space's colour, so you can tell you're not in All.</p></div>
    <div class="opt-g"><label>Calendar colours</label>${seg('calcol',[['area','By Space'],['source','By calendar']],L.calcol||'area')}<p class="hint">In Up next, by Space gives Outlook Work's colour, Classes Uni's and Google Personal's.</p></div>`; },
    more:()=>moreCustom()+appSection()+labsSection()+(FEEL()?feelCustom(seg,head):'')+resetSection(),
  };
  $('custom-tabs').innerHTML=CUSTOM_TABS.map(([id,l])=>`<button type="button" role="tab" id="custom-tab-${id}" data-ctab="${id}" aria-controls="custom-body" tabindex="${id===customTab?0:-1}" aria-selected="${id===customTab}">${l}</button>`).join('');
  $('custom-body').setAttribute('aria-labelledby','custom-tab-'+customTab);
  $('custom-body').innerHTML=(pages[customTab]||pages.look)();
  histButtons();
  // A rebuilt settings row keeps the same control under the keyboard.
  if(focusKey){
    const matches=(el,data)=>Object.entries(data).every(([k,v])=>el?.dataset[k]===v);
    const next=focusKey.id?$(focusKey.id):[...$('custom').querySelectorAll(focusKey.tag)].find(el=>matches(el,focusKey.data)&&(!focusKey.group||matches(el.closest('[data-key],[data-appkey]'),focusKey.group)));
    (next||$('custom-tabs').querySelector('[aria-selected="true"]'))?.focus({preventScroll:true});
  }
}
function resetSection(){
  return `<div class="opt-g c-reset"><label>Start again</label>${resetAsk?`<div class="reset-ask"><p>Put the look, Home and sidebar settings back to how they started? Your tabs, Spaces and own header stay as they are, and Undo brings the rest back.</p><div class="reset-btns"><button type="button" class="btn sm ghost" id="c-reset-no">Keep my settings</button><button type="button" class="btn sm danger-fill" id="c-reset-yes" data-hist="the reset">Reset</button></div></div>`
    :`<button type="button" class="btn ghost" id="c-reset">Reset to defaults…</button>`}</div>`;
}
// Settings that belong to the Mac app itself, set through its bridge. Only shown inside the app.
function appSection(){
  const A=window.MeridianApp; if(!A||!A.settings)return '';
  const st=A.settings; const seg=(key,opts,cur)=>`<div class="seg" data-appkey="${key}">${opts.map(([v,l])=>`<button type="button" data-v="${v}" aria-pressed="${String(v)===String(cur)}">${l}</button>`).join('')}</div>`;
  const v12=!!A.recordShortcuts;
  setTimeout(notifLine,0);
  return `<div class="opt-g" style="margin-top:26px"><label style="font-size:13px;color:var(--ink)">Mac app <span class="dim2" style="font-weight:400">v${esc(A.version||'')}</span></label></div>
    ${v12?'':`<div class="opt-g"><label>Show and hide from anywhere</label>${seg('hotkey',[['opt+x','⌥X'],['off','Off']],st.hotkey==='off'?'off':'opt+x')}<p class="hint">Or leave it off and set your own in Raycast.</p></div>`}
    ${A.panel?`<div class="opt-g"><label>Put unused tabs to sleep</label>${seg('sleepAfter',[[1,'After an hour'],[4,'4 hours'],[12,'12 hours'],[24,'A day'],[0,'Never']],st.sleepAfter??12)}<p class="hint">A browser tab you haven't looked at for this long lets go of its page to save memory, and loads again when you pick it. Tabs playing sound stay awake. Terminals never sleep.</p></div>`:''}
    ${A.panel&&'tabPreviews' in st?`<div class="opt-g"><label>Side panel tabs</label>${seg('tabPreviews',[['false','Just the name'],['true','With a preview']],String(!!st.tabPreviews))}<p class="hint">With a preview, hovering a tab you're not on shows a small snapshot of the page or terminal.</p></div>`:''}
    ${A.browse?`<div class="opt-g"><label>Open links</label>${seg('links',[['peek','Peek'],['split','Side by side'],['browser','Your browser']],st.links||'peek')}<p class="hint">Peek floats the page over Meridian. ⌘\\ puts it beside, ⌘⇧↵ fills the window. ⌘-click always uses your browser.</p></div>`:''}
    <div class="opt-g"><label>Window buttons</label>${seg('windowControls',[['standard','Standard'],['hover','On hover'],['inset','In the sidebar'],['hidden','Hidden']],st.windowControls)}<p class="hint">Hidden still closes with ⌘W and minimises with ⌘M.</p></div>
    <div class="opt-g"><label>Full screen</label>${seg('fullscreen',[['native','macOS full screen'],['borderless','Fill the screen']],st.fullscreen)}<p class="hint">macOS full screen gives Meridian its own Space, the same as Raycast's full screen. Fill the screen covers this desktop instead.</p></div>
    <div class="opt-g"><label>Morning brief popup</label><div class="notif-row">${seg('briefPopup',[['true','On'],['false','Off']],String(st.briefPopup))}${A.showBriefPopup?'<button type="button" class="btn sm ghost" id="c-brief-now">Show it now</button>':''}</div><p class="hint">A small card in the corner at 9:00 on weekdays. Show it now for a preview.</p></div>
    ${A.notifications?`<div class="opt-g"><label>Notifications</label><div class="notif-row"><span id="c-notif">Checking…</span><button type="button" class="btn sm ghost" id="c-notif-test">Send a test</button></div><p class="hint">Meeting reminders arrive 10 minutes and 1 minute before.</p></div>`:''}`;
}
addEventListener('meridianapp',()=>{ if(customOpen())renderCustom(); });
$('custom-body').addEventListener('input',e=>{ if(e.target.id!=='c-grain')return; const v=Number(e.target.value); prefs.grain=v; e.target.style.setProperty('--v',v+'%'); $('c-grain-v').textContent=v; root.style.setProperty('--grain',String(v/100)); clearTimeout(renderCustom.g); renderCustom.g=setTimeout(()=>savePrefs(),300); });
$('custom-body').addEventListener('click',e=>{
  if(dragJustEnded())return;
  const ap=e.target.closest('.seg[data-appkey] [data-v]'); if(ap&&window.MeridianApp){ const k=ap.closest('.seg').dataset.appkey; let v=ap.dataset.v; if(v==='true')v=true; if(v==='false')v=false; if(k==='sleepAfter')v=Number(v); Promise.resolve(window.MeridianApp.set(k,v)).then(()=>renderCustom()).catch(err=>toast(String(err&&err.message||err))); return; }
  if(e.target.closest('#c-grad')){ openGradientMaker(); return; }
  if(e.target.closest('#c-photo')){ openPhotoSheet(); return; }
  const mx=e.target.closest('[data-mix]'); if(mx){ const k=mx.dataset.mix; const m=new Set(prefs.heroMix||[]); m.has(k)?m.delete(k):m.add(k); prefs.heroMix=[...m]; savePrefs(); renderCustom(); if(view==='home')homeHero(); showWhere('hero'); return; }
  if(e.target.closest('#c-keys')){ openKeys(); return; }
  const cu=(prefs.custom=prefs.custom||{}); cu.locked=cu.locked||{}; cu.hidden=cu.hidden||{};
  const lk=e.target.closest('[data-lock]'); if(lk){ cu.locked[lk.dataset.lock]=true; savePrefs(); renderCustom(); toast('Locked. Click the lock to make it a choice again'); return; }
  const ul=e.target.closest('[data-unlock]'); if(ul){ delete cu.locked[ul.dataset.unlock]; savePrefs(); renderCustom(); return; }
  const ho=e.target.closest('[data-hide-opt]'); if(ho){ e.stopPropagation(); const [id,v]=ho.dataset.hideOpt.split('|'); cu.hidden[id]=[...new Set([...(cu.hidden[id]||[]),v])]; savePrefs(); renderCustom(); return; }
  const uh=e.target.closest('[data-unhide]'); if(uh){ delete cu.hidden[uh.dataset.unhide]; savePrefs(); renderCustom(); return; }
  const hh=e.target.closest('[data-hhide]'); if(hh){ const id=hh.dataset.hhide; const h=new Set(prefs.homeHidden||[]); h.has(id)?h.delete(id):h.add(id); prefs.homeHidden=[...h]; savePrefs(); renderCustom(); if(view==='home'&&state){ VIEWS.home.mount($('v-home')); VIEWS.home.update(); } else showWhere('home'); return; }
  const sf=e.target.closest('.surf[data-surface]'); if(sf){ prefs.look.surface=sf.dataset.surface; savePrefs(); renderCustom(); return; }
  const ac=e.target.closest('[data-accent]'); if(ac){ prefs.accent=ac.dataset.accent; savePrefs(); renderCustom(); return; }
  const ty=e.target.closest('.typecard[data-type]'); if(ty){ prefs.look.type=ty.dataset.type; savePrefs(); renderCustom(); return; }
  const co=e.target.closest('[data-corner]'); if(co){ prefs.look.radius=co.dataset.corner; savePrefs(); renderCustom(); return; }
  const b=e.target.closest('[data-key] [data-v]'); if(b){ const g=b.closest('[data-key]'); const k=g.dataset.key, v=b.dataset.v;
    if(g.dataset.scope==='side'){ if(k==='mode')return setSideMode(v); prefs.side[k]=v; } else prefs.look[k]=v;
    if(k==='hero'&&v==='custom'&&!prefs.gradient){ savePrefs(); renderCustom(); openGradientMaker(); return; }
    if(k==='hero'&&v==='photo'&&!heroPhotos().length){ savePrefs(); renderCustom(); openPhotoSheet(); return; }
    if(k==='hero'&&v==='mix'&&!(prefs.heroMix||[]).length)prefs.heroMix=['earthview','earth','week','colours','dusk'];
    savePrefs(); renderCustom(); if(['spaces','spacespos','spaceaccent','spaceicons'].includes(k)){ sideSig=''; renderSide(); shelfSig=''; homeShelfSig=''; VIEWS[view]?.update?.(true); } if(['hnext','nxs','hshelf','calcol'].includes(k)&&view==='home'&&state){ VIEWS.home.mount($('v-home')); VIEWS.home.update(); } else if(['hero','herograd','hedge','hmove','planet','mixevery'].includes(k)&&view==='home')homeHero(); if(k==='hero')applyBackdrop(); if(k==='tabStyle'){ miniCache.clear(); renderTabs(); } showWhere(k); return; }
  const hd=e.target.closest('[data-thide]'); if(hd){ const id=hd.dataset.thide; prefs.tabs.hidden=prefs.tabs.hidden.includes(id)?prefs.tabs.hidden.filter(x=>x!==id):[...prefs.tabs.hidden,id]; savePrefs(); renderCustom(); renderTabs(); return; }
  // Reset asks first, keeps what took effort to set up (tabs, Spaces, your own header), and Undo brings the rest back.
  if(e.target.closest('#c-reset')){ resetAsk=true; renderCustom(); return; }
  if(e.target.closest('#c-reset-no')){ resetAsk=false; renderCustom(); return; }
  if(e.target.closest('#c-reset-yes')){ resetAsk=false; const mode=prefs.side.mode; prefs=merge(DEFAULTS,{tabs:prefs.tabs,spaces:prefs.spaces,gradient:prefs.gradient,heroPhotos:prefs.heroPhotos,heroPhoto:prefs.heroPhoto,heroMix:prefs.heroMix,webTabs:prefs.webTabs,labs:prefs.labs,strip:prefs.strip,keys:prefs.keys,pickStars:prefs.pickStars}); savePrefs(); if(prefs.side.mode!==mode)setSideMode(prefs.side.mode); renderCustom(); sideSig=''; renderSide(); renderTabs(); if(view==='home'&&state){ VIEWS.home.mount($('v-home')); VIEWS.home.update(); } toast('Back to the defaults',{undo:()=>histGo(-1)}); }
});
sortable($('custom-body'),'.te',{axis:'y',onDrop:(ids,list)=>{
  if(list.id==='c-home'){ histStart('Home order'); prefs.homeOrder=ids; savePrefs(); histEnd(); renderCustom(); if(view==='home'&&state){ VIEWS.home.mount($('v-home')); VIEWS.home.update(); } else showWhere('home'); return; }
  histStart('Tab order'); prefs.tabs.order=[...ids,...prefs.tabs.order.filter(id=>!ids.includes(id))]; savePrefs(); histEnd(); renderCustom(); renderTabs(); }});

/* ---------- settings ---------- */
// The cog opens this, in the middle like ⌘K: each part of Customise as a small picture, and a search that finds any
// single setting and takes you straight to it.
const PAGE_NAMES={look:'Look',home:'Home',side:'Sidebar',spaces:'Spaces',more:'General'};
const PAGE_ICONS={look:'palette',home:'home',side:'sidebar',spaces:'allsp',more:'sliders'};
function settingsIndex(){
  const A=window.MeridianApp;
  const s=[
    ['look','Look','theme surface colour color background ink graphite hairline daylight light dark onyx smoke'],['look','Accent','colour color highlight yellow red'],['look','How much accent','quiet tinted bold'],
    ['look','Sidebar glow','tint glow today colours wada'],['look','Type','font typeface fraunces serif mono grotesk'],['look','Corners','radius rounded squircle sharp soft'],
    ['look','Density','compact comfortable spacing'],['look','Window','inset edge to edge flush'],['look','Floating panels','glass frosted solid blur'],
    ['look','Selected','selection picked glow tint lift outline'],['look','Change highlight','flash glow wash lift'],['look','Effect','edge light'],['look','Grain','noise texture film'],
    ['home','Header image','banner earth view picture planet sun moon mars saturn jupiter turning globe gradient colours color today dusk hero your own photo upload image wallpaper background mix rotate shuffle'],['home','Where it meets the page','header fade deepen edge blur gradient bottom dark'],['home','Motion','header moving animated drift turn still'],['home','Header size','banner tall grows scroll'],['home','Next meeting','up next card style wash line open blue box headline'],
    ['home','Top shelf on Home','links tiles dock row fit scroll'],['home','On Home','sections order reorder hide show dogfood ai usage live almanac'],
    ['side','Sidebar','docked compact float hidden'],['side','Which side','left right'],['side','When hidden with ⌘S','peek edge'],['side','Tab style','previews list miniature'],
    ['side','Tabs','reorder order hide'],['side','Day line','midnight time'],
    ['spaces','Your Spaces','space name rename colour groups work personal uni add remove'],['spaces','Where they sit','icons pills position filled outline'],
    ['spaces','In a Space','accent follows'],['spaces','Calendar colours','calendar outlook google up next'],
    ['more','Keyboard shortcuts','keys hotkeys'],['more','Agents strip','bar bottom agents working'],['more','Accounts and calendars','connect outlook google'],
    ['more','Demo mode','screen recording fake'],['more','Start again','reset defaults'],
  ];
  if(A?.settings)s.push(['more','Window buttons','traffic lights close minimise'],['more','Full screen','borderless space'],['more','Morning brief popup','9:00 card'],
    ...(A.notifications?[['more','Notifications','meeting reminders alerts']]:[]),...(A.browse?[['more','Open links','peek side by side browser']]:[]),...(A.panel?[['more','Put unused tabs to sleep','memory sleep browser tabs'],['more','Side panel tabs','preview snapshot hover thumbnail']]:[]));
  return s.map(([page,label,kw])=>({page,label,kw}));
}
function goSetting(page,label){
  openCustom(page);
  setTimeout(()=>{ const g=[...$('custom-body').querySelectorAll('.opt-g')].find(x=>x.querySelector(':scope>label')?.textContent.trim().startsWith(label)); if(!g)return;
    g.scrollIntoView({block:'center',behavior:'smooth'}); g.classList.remove('c-flash'); void g.offsetWidth; g.classList.add('c-flash'); },90);
}
function settingsTiles(){
  const sp=spaceList();
  return [
    {id:'look',t:'Look',s:'Colour, type, corners',pv:pv([...SIDE,...PAGE,[32,16,22,12,'a'],[32,36,60,8,'t'],[32,52,44,8,'t']])},
    {id:'home',t:'Home',s:'Header, shelf, sections',pv:heroPv(lookOpt('hero')||'earthview')},
    {id:'side',t:'Sidebar',s:'Mode, side, tabs',pv:pv(DRAW.mode[prefs.side.mode]||DRAW.mode.docked)},
    {id:'spaces',t:'Spaces',s:'Names, colours, groups',pv:pv(sp.slice(0,4).map((x,i)=>[14+i*19,34,14,32,'',`border-radius:50%;background:${x.color}`]))},
    {id:'more',t:'General',s:'Strip, demo, the app',pv:`<span class="vpv set-ic" aria-hidden="true">${icon('sliders')}</span>`},
    {id:'keys',t:'Shortcuts',s:'See and change keys',pv:`<span class="vpv set-ic" aria-hidden="true">${icon('keys')}</span>`,run:()=>openKeys()},
    {id:'connect',t:'Accounts',s:'Calendars and mail',pv:`<span class="vpv set-ic" aria-hidden="true">${icon('globe')}</span>`,run:()=>{ location.href='/connect'+location.search; }},
    {id:'brief',t:'Morning brief',s:'Open today’s',pv:`<span class="vpv set-ic" aria-hidden="true">${icon('brief')}</span>`,run:()=>{ location.href='/'+(token?'?t='+encodeURIComponent(token):''); }},
  ];
}
let setItems=[], setSel=0;
function setRender(){
  for(const name of ['role','aria-expanded','aria-controls','aria-activedescendant'])$('set-in').removeAttribute(name); clearTimeout(setHover);
  const q=$('set-in').value.trim().toLowerCase();
  if(!q){ setItems=settingsTiles().map(x=>({...x,run:x.run||(()=>openCustom(x.id))}));
    $('set-body').innerHTML=`<div class="set-grid">${setItems.map((x,n)=>`<button type="button" class="set-tile${n===setSel?' sel':''}" data-n="${n}">${x.pv}<b>${esc(x.t)}</b><span>${esc(x.s)}</span></button>`).join('')}</div><div class="set-peek" id="set-peek"></div>`; setPeek(); return; }
  const words=q.split(/\s+/).filter(Boolean);
  const score=(x)=>{ const l=x.label.toLowerCase(); if(l.startsWith(q))return 0; if(l.split(/\s+/).some(w=>w.startsWith(q)))return 1; if(l.includes(q))return 2; if(x.kw.includes(q)||(PAGE_NAMES[x.page]||'').toLowerCase().startsWith(q))return 3;
    // "header colour", "tab order": every word somewhere in the name, the keywords or the page.
    const hay=`${l} ${x.kw} ${(PAGE_NAMES[x.page]||'').toLowerCase()}`; if(words.length>1&&words.every(w=>hay.includes(w)))return 4; return 9; };
  const extra=settingsTiles().filter(x=>x.run).map(x=>({page:'',label:x.t,kw:x.s.toLowerCase(),run:x.run,ic:{keys:'keys',connect:'globe',brief:'brief'}[x.id]}));
  setItems=[...settingsIndex(),...extra].map(x=>[x,score(x)]).filter(([,n])=>n<9).sort((a,b)=>a[1]-b[1]).map(([x])=>x).slice(0,30);
  setSel=Math.min(setSel,Math.max(0,setItems.length-1));
  $('set-body').innerHTML=setItems.length?`<div class="res" id="set-results" role="listbox" aria-label="Settings results">${setItems.map((x,n)=>`<div class="it${n===setSel?' sel':''}" id="set-option-${n}" data-n="${n}" role="option" aria-selected="${n===setSel}"><span class="pal-k">${icon(x.ic||PAGE_ICONS[x.page])}</span><span class="t">${esc(x.label)}<small>${x.page?'Customise · '+PAGE_NAMES[x.page]:'Opens on its own'}</small></span><span class="go">Open <kbd>↵</kbd></span></div>`).join('')}</div>`
    :`<div class="empty" style="padding:18px 20px">No setting matches “${esc(q)}”.</div>`;
  $('set-in').setAttribute('role','combobox'); $('set-in').setAttribute('aria-expanded','true'); $('set-in').setAttribute('aria-controls','set-results');
  const selected=$('set-body').querySelector('.sel');
  if(selected)$('set-in').setAttribute('aria-activedescendant',selected.id); else $('set-in').removeAttribute('aria-activedescendant');
  selected?.scrollIntoView({block:'nearest'});
}
function setRun(n){ const x=setItems[n]; if(!x)return; closeOverlays(); if(x.run)x.run(); else goSetting(x.page,x.label); }
function openSettings(){ closeOverlays(); setSel=0; $('set-in').value=''; setRender(); $('setpop').classList.add('on'); $('scrim').classList.add('on'); window.MeridianA11y?.open($('setpop')); setTimeout(()=>$('set-in').focus(),20); }
$('set-in').addEventListener('input',()=>{ setSel=0; setRender(); });
$('set-in').addEventListener('keydown',e=>{ const q=$('set-in').value.trim(); const cols=q?1:4;
  const step={ArrowDown:cols,ArrowUp:-cols,ArrowRight:q?0:1,ArrowLeft:q?0:-1}[e.key];
  if(step){ e.preventDefault(); setSel=Math.max(0,Math.min(setItems.length-1,setSel+step)); setRender(); }
  else if(e.key==='Enter'){ e.preventDefault(); setRun(setSel); } });
$('set-body').addEventListener('click',e=>{ const g=e.target.closest('[data-setgo]'); if(g){ const [page,label]=g.dataset.setgo.split('|'); closeOverlays(); goSetting(page,label); return; } const b=e.target.closest('[data-n]'); if(b)setRun(Number(b.dataset.n)); });
// A tile only takes over the list below once the pointer settles on it, and heading down takes longer to count,
// so crossing other tiles on the way to the chips leaves them alone. Search results follow the pointer at once.
let setHover=0;
$('set-body').addEventListener('mousemove',e=>{ clearTimeout(setHover); const b=e.target.closest('[data-n]'); if(!b)return; const n=Number(b.dataset.n); if(n===setSel)return;
  const pick=()=>{ setSel=n; $('set-body').querySelectorAll('[data-n]').forEach(x=>x.classList.toggle('sel',Number(x.dataset.n)===n)); setPeek(); };
  if(!b.classList.contains('set-tile'))return pick(); setHover=setTimeout(pick,e.movementY>Math.abs(e.movementX)?450:140); });
$('set-body').addEventListener('mouseleave',()=>clearTimeout(setHover));
// Browsing, for when you don't know what a setting is called: the tile you're on lists everything inside it, and each name goes straight there.
function setPeek(){ const el=$('set-peek'); const x=setItems[setSel]; if(!el||!x)return;
  const inside=PAGE_NAMES[x.id]?settingsIndex().filter(s=>s.page===x.id):[];
  el.innerHTML=inside.length?`<span class="set-peek-h">In ${esc(PAGE_NAMES[x.id])}</span>${inside.map(s=>`<button type="button" class="set-chip" data-setgo="${esc(s.page)}|${esc(s.label)}">${esc(s.label)}</button>`).join('')}`
    :`<span class="set-peek-h">${esc(x.t)}</span><span class="set-peek-s">${esc(x.s)}. Opens on its own.</span>`; }

/* ---------- palette ---------- */
// Grouped like a launcher, with an icon for every kind of thing. Links show their
// favicon with a small link badge so you can tell a link from a tab at a glance.
let palItems=[], palSel=0, palMode='search';
const PAL_GROUPS=['Tabs','Top shelf','Links','On this Mac','Commands','Looks','Go to'];
function palIndex(q){
  const ql=q.trim().toLowerCase(); const items=[];
  const tile=(ic)=>`<span class="pal-k">${icon(ic)}</span>`;
  const linkTile=(l)=>`<span class="pal-k">${favImg(l,'')}<span class="badge-ico">${icon('link')}</span></span>`;
  visibleTabs().forEach((t,i)=>items.push({g:'Tabs',tile:tile(t.icon),t:t.label,h:String(i+1),verb:'Go',run:()=>go(t.id)}));
  (links.links||[]).forEach(l=>items.push({g:l.pinned?'Top shelf':'Links',tile:linkTile(l),t:l.title,sub:hostOf(l.url),h:l.category||'',verb:'Open',run:()=>openLink(l)}));
  if(ql)ST.all.slice(0,400).forEach(it=>items.push({g:'Stash',tile:`<span class="pal-k">${it.thumb?`<img alt="" src="${stThumb(it)}" style="width:18px;height:18px;border-radius:5px;object-fit:cover">`:icon(it.kind==='link'?'link':it.kind==='image'?'image':'note')}</span>`,t:stTitle(it),sub:[it.domain,ago(it.created)].filter(Boolean).join(' · '),h:[it.note,it.text&&it.title?cap(it.text,60):'',...(it.spaces||[])].filter(Boolean).join(' '),verb:'Open',run:()=>{ go('stash'); stOpen(it.id); }}));
  liveServers().forEach(s=>items.push({g:'On this Mac',tile:`<span class="pal-k">${icon('system')}<span class="badge-ico">${icon(s.shareUrl||!homeOnly(s)?'share':'mac')}</span></span>`,t:s.title&&!/^Directory listing/i.test(s.title)?s.title:serverName(s),sub:':'+s.port,h:s.shareUrl?'Tailscale':'',verb:'Open',run:()=>homeOnly(s)&&!onHomeMac()?shareServer(s,{open:true}):window.open(serverUrl(s),'_blank','noopener')}));
  items.push(
    {g:'Commands',tile:tile('dogfood'),t:'Log a fix',sub:'Dogfood',h:'F',verb:'Run',run:()=>openFix()},
    {g:'Commands',tile:tile('plus'),t:'Add a link',sub:'to the shelf',h:'N',verb:'Run',run:()=>openLinkSheet({})},
    {g:'Commands',tile:tile('note'),t:'Capture a note or to-do',sub:'press > from anywhere',h:'>',verb:'Run',run:()=>setTimeout(openCapture,10)},
    {g:'Commands',tile:tile('sliders'),t:'Customise',h:',',verb:'Open',run:()=>openCustom()},
    {g:'Commands',tile:tile('sliders'),t:'Settings',sub:'search every setting',verb:'Open',run:()=>setTimeout(openSettings,10)},
    // A switch, not a page: toggles straight from search (and outranks the Customise entry, left out below).
    {g:'Commands',tile:tile('sparkle'),t:'Demo mode',sub:(DEMO?'On':'Off')+' · made-up data for recordings',kw:'demo fake recording screen',h:pageKey('demo')!=='off'?pageKeyLabel(pageKey('demo')):'',verb:DEMO?'Turn off':'Turn on',run:()=>setDemo(!DEMO)},
    ...(ql?settingsIndex().filter(x=>!/^demo mode$/i.test(x.label)).map(x=>({g:'Settings',tile:tile(PAGE_ICONS[x.page]),t:x.label,sub:'Customise · '+PAGE_NAMES[x.page],kw:x.kw,verb:'Open',run:()=>goSetting(x.page,x.label)})):[]),
    {g:'Commands',tile:tile('sidebar'),t:'Show or hide the sidebar',h:'⌘S',verb:'Run',run:toggleSidebar},
    {g:'Commands',tile:tile('sidebar'),t:'Compact sidebar',h:'\\',verb:'Run',run:()=>setSideMode(prefs.side.mode==='compact'?'docked':'compact')},
    ...(spacesOn()?['all',...spaceList().map(x=>x.id)]:[]).map((id,i)=>{ const sp=spaceList().find(x=>x.id===id); return {g:'Commands',tile:`<span class="pal-k"><i style="width:12px;height:12px;border-radius:4px;${sp?'background:'+spColor(sp):'box-shadow:inset 0 0 0 1.5px var(--dim)'}"></i></span>`,t:sp?`${sp.name} space`:'All spaces',sub:'switch Space',h:'⌃'+(i+1),verb:'Switch',run:()=>setSpace(id)}; }),
    ...(window.MeridianApp?.panel?[{g:'Commands',tile:tile('terminal'),t:'Terminal',sub:'show or hide it in the side panel',h:panelKey('terminal'),verb:'Open',run:()=>panelCall('toggle',{kind:'terminal'})},
      {g:'Commands',tile:tile('terminal'),t:'New terminal',sub:'side panel',h:panelKey('newTerminal'),verb:'Open',run:()=>panelCall('new',{kind:'terminal'})},
      {g:'Commands',tile:tile('globe'),t:'New browser tab',sub:'side panel',h:panelKey('newTab'),verb:'Open',run:()=>panelCall('new',{kind:'web'})},
      {g:'Commands',tile:tile('sidebar'),t:'Show or hide the side panel',sub:'browser and terminal tabs',h:panelKey('panel'),verb:'Run',run:()=>panelCall('toggle')}]:[]),
    ...(window.MeridianApp?.openTodos?[{g:'Commands',tile:tile('todo'),t:'Quick to-dos',sub:'the small to-do window',h:keyLabel(window.MeridianApp.settings?.shortcuts?.todos),verb:'Open',run:()=>window.MeridianApp.openTodos()}]:[]),
    {g:'Commands',tile:tile('globe'),t:'Connect accounts and calendars',sub:'/connect',verb:'Open',run:()=>{ location.href='/connect'+location.search; }},
    {g:'Commands',tile:tile('refresh'),t:'Rescan AI usage',sub:'both Macs',verb:'Run',run:()=>{ go('usage'); $('u-refresh')?.click(); }},
    {g:'Commands',tile:tile('money'),t:'Update money',sub:'Monzo and Trading 212',verb:'Run',run:()=>{ go('money'); if(MN.status?.unlocked)moneyRefresh(); }},
    {g:'Commands',tile:tile('lock'),t:'Lock money',sub:'this device',verb:'Run',run:()=>moneyLock()},
    {g:'Commands',tile:tile('money'),t:'Search money',sub:'months, places, trips, notes',h:'£',verb:'Run',run:()=>setTimeout(()=>{ palOpen(); $('pal-in').value='£ '; palUpdate(); },10)},
    ...SURFACES.map(x=>({g:'Looks',tile:`<span class="pal-k"><i style="width:16px;height:16px;border-radius:5px;background:${x.c[2]};box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.25)"></i></span>`,t:`${x.name} look`,sub:x.hint,verb:'Use',run:()=>{ prefs.look.surface=x.id; savePrefs(); }})),
    ...ACCENTS.map(x=>({g:'Looks',tile:`<span class="pal-k"><i style="width:14px;height:14px;border-radius:50%;background:${x.hex}"></i></span>`,t:`${x.name} accent`,verb:'Use',run:()=>{ prefs.accent=x.hex; savePrefs(); }})),
    {g:'Go to',tile:tile('journal'),t:'Morning brief',sub:'/',verb:'Go',run:()=>{ location.href='/'; }},
    ...(state?.setup&&!state.setup.demo?[{g:'Commands',tile:tile('link'),t:'Connect your things',sub:'calendar, GitHub, agents and more',kw:'connectors settings setup',verb:'Open',run:()=>openConnect()},{g:'Commands',tile:tile('sparkle'),t:'Show the welcome',sub:'the first steps on Home',verb:'Show',run:()=>{ prefs.welcomeDone=false; savePrefs(); go('home'); VIEWS.home.mount($('v-home')); VIEWS.home.update(); }}]:[]),
    // Pages that had no way in (routes census, 8 Oct): reachable from search, not given space on screen.
    ...(window.MERIDIAN_TESTER||DEMO?[]:[['edit','Drafts','every draft, sent and archived','/drafts'],['flag','Projects','your work, in view','/projects'],['swipe','Sort the Stash','swipe to keep or delete','/stash-sort']]
      .map(([ic,t,sub,url])=>({g:'Go to',tile:tile(ic),t,sub,verb:'Go',run:()=>{ location.href=url+(LAB?'?lab':''); }}))),
  );
  if(!ql)return items.filter(i=>i.g==='Tabs'||i.g==='Top shelf'||(i.g==='Commands'&&['Log a fix','Add a link','Capture a note'].includes(i.t)));
  const score=(i)=>{ const t=i.t.toLowerCase(), h=[i.sub,i.h,i.kw].join(' ').toLowerCase(); if(t.startsWith(ql))return 0; if(t.split(/[\s·/-]+/).some(w=>w.startsWith(ql)))return 1; if(t.includes(ql))return 2; if(h.includes(ql))return 3; return 9; };
  const ranked=items.map(i=>[i,score(i)]).filter(([,x])=>x<9).sort((a,b)=>a[1]-b[1]).slice(0,40);
  // Groups appear in the order of their best match; items keep their rank inside a group.
  const gOrder=[...new Set(ranked.map(([i])=>i.g))];
  return gOrder.flatMap(g=>ranked.filter(([i])=>i.g===g).map(([i])=>i));
}
// Capture: to-do first (that's the one Owner reaches for), inbox second. Both can be undone from the toast.
function palCapture(text){
  return [
    {g:'Capture',tile:`<span class="pal-k">${icon('todo')}</span>`,t:'Add to your to-do list',sub:'shows on Home',verb:'Add',run:async()=>{ if(!text)return; try{ const j=await send('/api/todos',{title:text}); loadState(); toast('Added to your to-do list',{undo:async()=>{ try{ await send('/api/todos/'+j.todo.id,undefined,'DELETE'); loadState(); toast('Taken off your list'); }catch(err){ toast(err.message); } }}); }catch(err){ toast(err.message); } }},
    {g:'Capture',tile:`<span class="pal-k">${icon('stash')}</span>`,t:looksLikeUrl(text)?'Stash the link':'Stash it',sub:'keep it in your stash',verb:'Stash',run:()=>{ if(text)stAddText(text,{source:'capture'}); }},
    // Captures land in Stash since 6 Oct (state.captureTo), where this would only repeat "Stash it".
    ...(state?.captureTo==='stash'?[]:[{g:'Capture',tile:`<span class="pal-k">${icon('note')}</span>`,t:'Send to your inbox',sub:'as a note in the vault',verb:'Send',run:async()=>{ if(!text)return; try{ const j=await send('/api/capture',{text}); toast('In your inbox',{undo:j.id?async()=>{ try{ await send('/api/capture/'+encodeURIComponent(j.id)+'/undo',{}); toast('Taken back out of your inbox'); }catch(err){ toast(err.message); } }:undefined}); }catch(err){ toast(err.message); } }}]),
  ];
}
// A link typed or pasted into ⌘K: open it first, capture it second. In the Mac app it opens as a new tab in the side
// panel when you already have web tabs there, otherwise in a Peek.
const palUrl=(q)=>{ const t=q.trim(); return looksLikeUrl(t)?t:/^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(t)?'https://'+t:''; };
function linkMode(){ const A=window.MeridianApp; if(!A?.browse||A.settings?.links==='browser')return null;
  const b=A.browser||{}; if(!(b.tabs||[]).some(t=>t.kind==='web'&&!t.transient))return 'peek';
  return b.open&&b.mode!=='peek'?b.mode:'split'; }
function palLink(url){ const A=window.MeridianApp; const mode=linkMode(); const fav=webFav(url);
  const inbox=palCapture(url).find(i=>i.verb==='Send');
  return [
    {g:'Link',tile:`<span class="pal-k">${fav?`<img alt="" src="${esc(fav)}" data-mono="${esc(hostOf(url).charAt(0).toUpperCase())}" onerror="monoFallback(this)">`:icon('globe')}</span>`,t:`Open ${hostOf(url)}`,
      sub:!A?.browse?'in a new browser tab':!mode?'in your browser':mode==='peek'?'in a Peek':'as a new tab in the side panel',verb:'Open',run:()=>mode?A.browse(url,{mode}):openUrl(url)},
    {...inbox,g:'Link',t:'Capture it',sub:'as a note in your inbox'},
    ...(A?.browse&&mode?[{g:'Link',tile:'<span class="pal-k">'+icon('out')+'</span>',t:'Open in your browser',sub:'leaves Meridian',verb:'Open',run:()=>openUrl(url,null,'browser')}]:[]),
  ];
}
// Capture straight from anywhere: press > (shift + full stop) and type.
function openCapture(){ palOpen(); $('pal-in').value='> '; palUpdate(); }
function palRender(){
  const q=$('pal-in').value; const cap=q.trim().startsWith('>'); const text=q.trim().slice(1).trim();
  let html=''; let last=null;
  if(cap)html+=`<div class="capture${text?'':' empty'}">${text?esc(text):'Type your note after the &gt;'}</div>`;
  // Money's summary heads the list when you type £: to read, not to pick.
  if(!cap&&q.trimStart().startsWith('£')&&MN.data){ const g=moneyGlance(); html+=`<div class="pal-glance"><div class="grp" style="padding:0 0 6px">At a glance</div><p class="m-blurtext">${esc(g.adviser||g.facts)}</p>${g.adviser?`<small class="m-blurtext">${esc(g.facts)}</small>`:''}</div>`; }
  palItems.forEach((it,n)=>{ if(it.g!==last&&!cap){ html+=`<div class="grp">${esc(it.g)}</div>`; last=it.g; }
    html+=`<div class="it${n===palSel?' sel':''}" id="pal-option-${n}" data-n="${n}" role="option" aria-selected="${n===palSel}">${it.tile||''}<span class="t">${esc(it.t)}${it.sub?`<small>${esc(it.sub)}</small>`:''}</span><span class="h">${esc(it.h||'')}</span><span class="go">${esc(it.verb||'Open')} <kbd>↵</kbd></span></div>`; });
  $('pal-res').innerHTML=html||'<div class="empty" style="padding:18px 14px">Nothing matches. Start with &gt; to capture a note instead.</div>';
  const selected=$('pal-res').querySelector('.it.sel');
  if(selected)$('pal-in').setAttribute('aria-activedescendant',selected.id); else $('pal-in').removeAttribute('aria-activedescendant');
  selected?.scrollIntoView({block:'nearest'});
}
function palUpdate(){ const q=$('pal-in').value; const cap=q.trim().startsWith('>'); const money=q.trimStart().startsWith('£');
  palItems=cap?palCapture(q.trim().slice(1).trim()):money?palMoney(q.trimStart().slice(1)):palIndex(q);
  // On the Money tab, money matches come first without the £.
  if(!cap&&!money&&view==='money'&&q.trim()&&MN.data){ const mi=palMoney(q).filter(i=>i.g!=='Money'||/^(Update|Ask|Show|Hide)/.test(i.t)); palItems=[...mi,...palItems]; }
  const url=!cap&&!money&&palUrl(q); if(url)palItems=[...palLink(url),...palItems.filter(i=>i.g!=='Commands')];
  palSel=0; palRender(); }
function palOpen(){ closeOverlays(); $('pal').classList.add('on'); $('pal-in').setAttribute('aria-expanded','true'); $('scrim').classList.add('on'); window.MeridianA11y?.open($('pal')); $('pal-in').value=''; palUpdate(); setTimeout(()=>$('pal-in').focus(),20); }
$('pal-in').addEventListener('input',palUpdate);
$('pal-in').addEventListener('keydown',e=>{ if(e.key==='ArrowDown'){ e.preventDefault(); palSel=Math.min(palItems.length-1,palSel+1); palRender(); } else if(e.key==='ArrowUp'){ e.preventDefault(); palSel=Math.max(0,palSel-1); palRender(); } else if(e.key==='Enter'){ e.preventDefault(); const it=palItems[palSel]; closeOverlays(); it&&it.run(); } });
$('pal-res').addEventListener('keydown',e=>{ if(['ArrowUp','ArrowDown','Enter'].includes(e.key)){ e.preventDefault(); $('pal-in').dispatchEvent(new KeyboardEvent('keydown',{key:e.key,bubbles:true})); } });
$('pal-res').addEventListener('click',e=>{ const r=e.target.closest('[data-n]'); if(!r)return; const it=palItems[Number(r.dataset.n)]; closeOverlays(); it&&it.run(); });
$('pal-res').addEventListener('mousemove',e=>{ const r=e.target.closest('[data-n]'); if(!r)return; const n=Number(r.dataset.n); if(n!==palSel){ palSel=n; $('pal-res').querySelectorAll('.it').forEach(x=>{ const on=Number(x.dataset.n)===n; x.classList.toggle('sel',on); x.setAttribute('aria-selected',String(on)); if(on)$('pal-in').setAttribute('aria-activedescendant',x.id); }); } });

/* STASH. Screenshots, links, notes and bits worth keeping. Things arrive from
   either Mac (Meridian.app's shortcuts and menu bar tray), the phone, or straight
   onto this page. They live on the Home Mac (stash.js); the list is searched there,
   text in pictures and all. */
const ST={data:null,all:[],q:'',kind:'',space:'',order:'new',size:localStorage.getItem('meridian.cc.stashSize')||'m',
  fresh:0,seenBefore:null,open:null,vibe:null,els:new Map(),cols:0,loading:0,ways:localStorage.getItem('meridian.cc.stashWays')};
const ST_KEYS={screenshot:'⌃⌥S',clipboard:'⌃⌥V',page:'⌃⌥L',tray:'⌃⌥N'};
const stKeys=()=>({...ST_KEYS,...(window.MeridianApp?.stashKeys||{})});
const ST_KINDS=[['screenshot','Screenshots'],['image','Images'],['link','Links'],['note','Notes'],['quote','Quotes'],['colour','Colours'],['file','Files'],['video','Videos']];
const ST_SOURCE={screenshot:'Screenshot',clipboard:'Clipboard',page:'Page',drop:'Dropped in',paste:'Pasted',note:'Note',tray:'Menu bar',upload:'Uploaded',import:'From your mind',phone:'Phone',share:'Shared',capture:'Captured',agent:'From an agent'};
const stThumb=(it)=>api(`/api/stash/${it.id}/thumb?v=${it.updated}`);
const stFile=(it,dl)=>api(`/api/stash/${it.id}/file${dl?'?download=1':''}`);
const stShot=(it)=>it.kind==='image'&&(it.source==='screenshot'||(it.labels||[]).some(l=>l.id==='screenshot'));
const stFrom=()=>/iPhone|iPad|Android/i.test(navigator.userAgent)?'phone':'';
function stTitle(it){
  if(it.title)return it.title;
  if(it.kind==='note'||it.kind==='quote')return it.summary||cap(it.text,90);
  if(it.kind==='link')return it.domain||it.url;
  if(it.kind==='colour')return it.hex;
  if(it.name)return it.name;
  return stShot(it)?'Screenshot':it.kind==='video'?'Video':it.kind==='file'?'File':'Image';
}
function stWhen(ts){ const d=new Date(ts); return `${dayWord(ts)}${startOfDay(ts)<startOfDay(Date.now()-6*86400e3)?' '+MONTHS[d.getMonth()].slice(0,3):''}, ${hm(ts)}`; }
const stBytes=(n)=>!n?'':n>=1048576?(n/1048576).toFixed(n>=10485760?0:1)+' MB':Math.max(1,Math.round(n/1024))+' KB';

async function loadStash(){
  const t=++ST.loading;
  const qs=new URLSearchParams({q:ST.q,kind:ST.kind,space:ST.space,order:ST.order,limit:'500'});
  const plain=!ST.q&&!ST.kind&&!ST.space&&ST.order==='new';
  try{
    const r=await fetch(api('/api/stash?'+qs)); if(!r.ok)throw new Error(r.status); const j=await r.json();
    if(t!==ST.loading)return;
    ST.data=j; ST.fresh=j.fresh||0; if(ST.seenBefore==null)ST.seenBefore=j.seenAt||0;
    if(plain){ ST.all=j.items; stash('stashlist',j); }
    else if(!ST.all.length) loadStashAll();
  }catch{ if(!ST.data){ const c=unstash('stashlist'); if(c){ ST.data=c; ST.all=c.items||[]; } } }
  renderTabs(); if(view==='stash')VIEWS.stash.update();
}
async function loadStashAll(){ try{ const j=await (await fetch(api('/api/stash?limit=500'))).json(); ST.all=j.items||[]; ST.fresh=j.fresh||0; renderTabs(); }catch{} }
// Something changed on the Home Mac: another device stashed, or a picture finished reading.
let stEventT=0;
function stEvent(e){ clearTimeout(stEventT); stEventT=setTimeout(()=>{ loadStash(); if(ST.open&&e&&e.id===ST.open.id&&e.action==='update')stOpen(e.id,{refresh:true}); },e&&e.action==='update'?600:150); }
function stMarkSeen(){ clearTimeout(stMarkSeen.t); stMarkSeen.t=setTimeout(()=>{ if(view!=='stash'||document.hidden)return; ST.fresh=0; ST.seenMark=Date.now(); renderTabs(); send('/api/stash/seen',{at:ST.seenMark}).catch(()=>{}); },1500); }

/* ---- adding: text, links and files, from paste, drop, the Add sheet or > */
async function stAddText(text,{source='paste',quiet=false}={}){
  text=String(text||'').trim(); if(!text)return null;
  try{ const j=await send('/api/stash',{text,source,from:stFrom()}); if(!quiet)stToast(j); loadStash(); return j; }catch(err){ toast(err.message); return null; }
}
async function stUpload(files,{source='drop'}={}){
  files=[...files].filter(f=>f&&f.size>=0); if(!files.length)return;
  const big=files.filter(f=>f.size>80*1048576); if(big.length)toast(`${big.length===1?big[0].name:big.length+' files'} ${big.length===1?'is':'are'} over 80 MB, so ${big.length===1?'it stays':'they stay'} out`);
  const ok=files.filter(f=>f.size<=80*1048576); if(!ok.length)return;
  if(ok.length>1||ok[0].size>4*1048576)toast(`Stashing ${ok.length>1?ok.length+' things':ok[0].name||'it'}…`,{ms:20000});
  const done=[];
  for(const f of ok){
    const qs=new URLSearchParams({name:f.name||'',type:f.type||'',source,from:stFrom()});
    try{ const r=await fetch(api('/api/stash/file?'+qs),{method:'POST',headers:{'X-Stash':'1','Content-Type':f.type||'application/octet-stream'},body:f}); const j=await r.json().catch(()=>({})); if(!r.ok||j.ok===false)throw new Error(j.error||('Upload failed ('+r.status+')')); done.push(j); }
    catch(err){ toast(err.message); }
  }
  if(done.length===1)stToast(done[0]); else if(done.length)toast(`Stashed ${done.length} things`,{undo:async()=>{ for(const j of done)if(!j.duplicate)await send('/api/stash/'+j.item.id,undefined,'DELETE').catch(()=>{}); loadStash(); }});
  loadStash();
}
function stToast(j){
  if(!j?.item)return;
  if(j.duplicate){ toast('Already in your stash',{action:{label:'Show',run:()=>{ go('stash'); stOpen(j.item.id); }}}); return; }
  const what={image:'Picture',link:'Link',note:'Note',quote:'Quote',colour:'Colour',file:'File',video:'Video'}[j.item.kind]||'It';
  toast(`${what} stashed`,{undo:async()=>{ try{ await send('/api/stash/'+j.item.id,undefined,'DELETE'); loadStash(); toast('Taken back out'); }catch(err){ toast(err.message); } }});
}
// Paste on the Stash tab: pictures and files upload, links and text are stashed as they are.
function stPaste(e){
  if($('st-detail')?.classList.contains('on'))return;
  const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);
  if(files.length){ e.preventDefault(); stUpload(files,{source:'paste'}); return; }
  const t=(e.clipboardData?.getData('text')||'').trim(); if(t){ e.preventDefault(); stAddText(t,{source:'paste'}); }
}
function stDrop(dt){
  const files=[...(dt?.files||[])];
  if(files.length)return stUpload(files,{source:'drop'});
  const u=(dt?.getData('text/uri-list')||'').split('\n').map(s=>s.trim()).find(s=>s&&!s.startsWith('#'));
  const t=u||(dt?.getData('text/plain')||'').trim();
  if(t)stAddText(t,{source:'drop'});
}

/* ---- the grid */
function stCardSig(it){ return [it.id,it.updated,it.title,it.pending?1:0,it.pinned?1:0,ST.seenBefore!=null&&it.created>ST.seenBefore?1:0].join('|'); }
function stMedia(it){
  if(it.thumb)return `<img alt="" loading="lazy" decoding="async" src="${stThumb(it)}" onload="this.classList.add('in')" onerror="this.remove()">`;
  if(it.pending)return `<span class="st-reading">${it.kind==='link'?'Fetching the page':'Reading it'}</span>`;
  return '';
}
function stCardHTML(it){
  const fresh=ST.seenBefore!=null&&it.created>ST.seenBefore?'<i class="st-new" data-tip="New since you last looked"></i>':'';
  const pin=it.pinned?`<span class="st-pin" data-tip="Pinned to the top">${icon('pin')}</span>`:'';
  const acts=`<div class="hover-acts"><button type="button" data-sact="copy" aria-label="Copy" data-tip="Copy">${icon('copy')}</button>${it.url||it.file?`<button type="button" data-sact="open" aria-label="Open" data-tip="${it.kind==='link'?'Open the page':'Open'}">${icon('out')}</button>`:''}<button type="button" data-sact="delete" aria-label="Delete" data-tip="Delete">${icon('trash')}</button></div>`;
  const meta=`<span class="st-meta">${esc([stShot(it)?'Screenshot':ST_SOURCE[it.source]||'',it.from?'from '+it.from:'',ago(it.created)].filter(Boolean).join(' · '))}</span>`;
  const ar=it.tw&&it.th?`${it.tw}/${it.th}`:it.w&&it.h?`${it.w}/${it.h}`:'4/3';
  const k=it.kind;
  let body='';
  if(k==='image'||k==='video'||(k==='file'&&(it.thumb||it.pending))){
    body=`<div class="st-media${it.thumb?'':' empty'}" style="aspect-ratio:${ar}">${stMedia(it)}${k==='video'?`<span class="st-badge">${icon('play')}Video</span>`:k==='file'?`<span class="st-badge">${esc((it.file||'').split('.').pop().toUpperCase())}</span>`:''}${meta}</div>${it.title||it.name&&k!=='image'?`<div class="st-cap">${esc(it.title||it.name)}</div>`:''}`;
  } else if(k==='link'){
    const lar=it.tw&&it.th?Math.max(.45,Math.min(1.1,it.th/it.tw)):.56;
    body=`<div class="st-media${it.thumb?'':' empty'}" style="aspect-ratio:1/${lar.toFixed(3)}">${stMedia(it)||`<span class="big-mark">${esc((it.domain||'?').charAt(0).toUpperCase())}</span>`}</div>
      <div class="lb">${it.icon?`<img class="fav" alt="" src="${api('/api/stash/'+it.id+'/icon')}" onerror="monoFallback(this)" data-mono="${esc((it.domain||'?').charAt(0).toUpperCase())}">`:`<span class="fav mono-mark">${esc((it.domain||'?').charAt(0).toUpperCase())}</span>`}<div class="lt"><b>${esc(it.title||it.domain)}</b><span>${esc(it.domain)}</span></div></div>`;
  } else if(k==='note'){
    // A note leads with its title, or the one-line summary Meridian wrote (stash-summary.js); the words sit under it, shorter.
    const head=it.title||it.summary;
    body=`${head?`<div class="st-sum">${esc(head)}</div>`:''}<div class="st-note${head?' short':''}">${esc(it.text)}</div>${it.from||it.source?`<div class="st-foot">${esc([ST_SOURCE[it.source]||'',it.agent?it.agent:'',it.from?'from '+it.from:'',ago(it.created)].filter(Boolean).join(' · '))}</div>`:''}`;
  } else if(k==='quote'){
    body=`<blockquote class="st-quote">${esc(it.text)}</blockquote><div class="st-foot">${it.domain?esc(it.domain):'Quote'}${it.page?.title?` · ${esc(cap(it.page.title,60))}`:''}</div>`;
  } else if(k==='colour'){
    const light=(()=>{ const n=parseInt((it.hex||'#000').slice(1),16); return ((n>>16&255)*299+(n>>8&255)*587+(n&255)*114)/1000>150; })();
    body=`<div class="st-colour${light?' light':''}" style="background:${esc(it.hex)}"><b>${esc(it.hex)}</b><span>${esc(it.title||'')}</span></div>`;
  } else {
    body=`<div class="st-file">${icon('report')}<b>${esc(it.name||stTitle(it))}</b><span>${esc(stBytes(it.bytes))}</span></div>`;
  }
  return `<article class="st-card k-${k}${it.pending?' pending':''}" data-id="${it.id}" tabindex="0">${body}${fresh}${pin}${acts}</article>`;
}
// Masonry without a library: each card goes in the shortest column, using the
// picture's real shape so nothing jumps when it loads.
function stEstimate(it,w){
  const r=it.tw&&it.th?it.th/it.tw:it.w&&it.h?it.h/it.w:.75;
  switch(it.kind){
    case 'image': case 'video': return w*Math.max(.3,Math.min(2.6,r))+(it.title?34:0);
    case 'link': return w*Math.max(.45,Math.min(1.1,it.thumb?r:.56))+62;
    case 'note': case 'quote': { const cpl=Math.max(14,(w-34)/(it.kind==='quote'?9.4:7.6)); const lines=String(it.text||'').split('\n').reduce((n,l)=>n+Math.max(1,Math.ceil(l.length/cpl)),0); const head=it.kind==='note'&&(it.title||it.summary); return Math.min(it.kind==='quote'?11:head?5:14,lines)*(it.kind==='quote'?26:21.5)+70+(head?Math.ceil(head.length*7.8/(w-34))*20+8:0); }
    case 'colour': return w*.62;
    default: return it.thumb?w*Math.max(.3,Math.min(1.6,r))+34:120;
  }
}
function stLayout(force){
  const grid=$('st-grid'); if(!grid||!ST.data)return;
  const list=ST.vibe?ST.vibe.items:ST.data.items;
  const W=grid.clientWidth||1000; const gap=W<560?10:14; const min={s:150,m:220,l:320}[ST.size]||220;
  const n=Math.max(W<560&&ST.size!=='l'?2:1,Math.floor((W+gap)/(min+gap)));
  const sigNow=list.map(i=>i.id).join(',')+'|'+n;
  if(!force&&grid.dataset.sig===sigNow)return;
  grid.dataset.sig=sigNow; grid.style.setProperty('--g',gap+'px');
  const colW=(W-gap*(n-1))/n; const hs=Array(n).fill(0);
  const cols=Array.from({length:n},()=>{ const c=document.createElement('div'); c.className='st-col'; return c; });
  for(const it of list){ const el=ST.els.get(it.id); if(!el)continue; let j=0; for(let i=1;i<n;i++)if(hs[i]<hs[j]-1)j=i; cols[j].appendChild(el); hs[j]+=stEstimate(it,colW)+gap; }
  grid.replaceChildren(...cols);
}
function stRenderGrid(){
  const list=ST.vibe?ST.vibe.items:ST.data.items;
  const keep=new Set(); let changed=false;
  for(const it of list){ const s=stCardSig(it); keep.add(it.id); const old=ST.els.get(it.id); if(old&&old.dataset.sig===s)continue;
    const t=document.createElement('template'); t.innerHTML=stCardHTML(it).trim(); const el=t.content.firstElementChild; el.dataset.sig=s;
    if(old)old.replaceWith(el); ST.els.set(it.id,el); changed=true; }
  for(const id of [...ST.els.keys()])if(!keep.has(id)){ ST.els.get(id).remove(); ST.els.delete(id); changed=true; }
  // Leave unchanged cards in their columns, including their focus and decoded images.
  const grid=$('st-grid'), key=list.map(it=>it.id).join(',')+'|'+ST.size+'|'+(grid.clientWidth||1000);
  if(changed||grid.__layoutKey!==key){ stLayout(true); grid.__layoutKey=key; }
}
function stWaysHTML(){
  const k=stKeys(); const inApp=!!window.MeridianApp;
  const way=(key,t,s,act)=>`<div class="st-way">${key}<b>${t}</b><span>${s}</span>${act||''}</div>`;
  const kb=(x)=>x?`<kbd>${esc(x)}</kbd>`:'<kbd class="off">off</kbd>';
  return `<div class="st-ways-grid">
    ${way(kb(k.screenshot),'Screenshot','Drag a box anywhere. It lands here with the page you were on.',inApp?`<button class="btn sm ghost" data-st-native="screenshot">Try it</button>`:'')}
    ${way(kb(k.clipboard),'Clipboard','Whatever you last copied: a picture, link, text or file. From Raycast’s history, copy an item with ⌘↵, then press this.')}
    ${way(kb(k.page),'This page','The browser tab you’re looking at, title and all.')}
    ${way(`<span class="st-way-ic">${icon('stash')}</span>`,'Menu bar','Click the tray icon for a drop zone and a quick note, or drop things straight onto it. '+kb(k.tray)+' opens it.')}
    ${way(kb('⌘V'),'Right here','Paste or drop anything on this tab. Press &gt; anywhere in Meridian to stash a note.')}
  </div><p class="st-ways-foot">Shortcuts work on any Mac running Meridian.app. If the Home Mac is asleep, things wait on the Mac you’re using and send when it’s back.</p>`;
}
function stChips(){
  const d=ST.data; if(!d)return;
  const chips=[...(d.chips||[]).map(c=>`<button class="st-fchip" data-st-unchip="${esc(c.raw)}">${c.type==='colour'?`<i class="sw" style="background:${esc(c.value)}"></i>`:''}${esc(c.label)}${icon('close')}</button>`),
    ...(ST.vibe?[`<button class="st-fchip" data-st-unvibe>Same vibe as ${esc(cap(ST.vibe.title,40))}${icon('close')}</button>`]:[])];
  setHTML($('st-chips'),chips.join('')); $('st-chips').hidden=!chips.length;
  const n=ST.vibe?ST.vibe.items.length:d.total; const all=d.counts?.all||0;
  setText($('st-count'),ST.vibe||ST.q||ST.kind||ST.space?`${n} of ${all}`:`${all} ${all===1?'thing':'things'}`);
  const c=d.counts||{};
  setHTML($('st-kinds'),`<button class="chip" data-st-kind="" aria-pressed="${!ST.kind}">Everything<span class="c">${all||''}</span></button>`+ST_KINDS.filter(([k])=>c[k]||ST.kind===k).map(([k,l])=>`<button class="chip" data-st-kind="${k}" aria-pressed="${ST.kind===k}">${l}<span class="c">${c[k]||0}</span></button>`).join(''));
  const sp=d.spaces||[];
  $('st-spaces').hidden=!sp.length; setHTML($('st-spaces'),sp.length?`<span class="lab">Spaces</span>`+sp.map(s=>`<button class="chip" data-st-space="${esc(s.name)}" aria-pressed="${ST.space.toLowerCase()===s.name.toLowerCase()}">${esc(s.name)}<span class="c">${s.n}</span></button>`).join(''):'');
  $('st-order').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===ST.order)));
  $('st-size').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===ST.size)));
  const fresh=(d.items||[]).filter(it=>ST.seenBefore!=null&&it.created>ST.seenBefore);
  const from=[...new Set(fresh.map(it=>it.from).filter(Boolean))];
  $('st-fresh').hidden=!fresh.length||!!(ST.q||ST.kind||ST.space||ST.vibe);
  setHTML($('st-fresh'),fresh.length?`<i></i>${fresh.length} new${from.length?' from '+esc(andList(from)):''} since you last looked`:'');
}
VIEWS.stash={
  mount(el){
    el.innerHTML=`<div class="vhead"><div><h1>Stash</h1><p>Screenshots, links, notes and anything else worth keeping. Send things here from either Mac or your phone, then find them by what’s in them.</p></div>
      <div class="vtools"><button class="btn ghost" id="st-ways-tog">${icon('keys')}Ways in</button>${window.MERIDIAN_TESTER||DEMO?'':`<button class="btn ghost" id="st-sort" data-tip="Sort|Go through one at a time: keep or delete">${icon('swipe')}Sort</button>`}<button class="btn primary" id="st-add">${icon('plus')}Add</button></div></div>
      <div class="st-ways card" id="st-ways" hidden></div>
      <div class="st-search"><label class="st-q">${icon('search')}<input id="st-q" placeholder="Search your stash" autocomplete="off" spellcheck="false" aria-label="Search your stash"><span class="st-count mono" id="st-count"></span></label><div class="st-chips" id="st-chips" hidden></div></div>
      <div class="st-bar"><div class="st-kinds" id="st-kinds"></div><div class="st-end">
        <div class="seg" id="st-order"><button data-v="new" aria-pressed="true" data-tip="Newest first">Newest</button><button data-v="shuffle" aria-pressed="false" data-tip="Rediscover|Today's shuffle of everything">Shuffle</button></div>
        <div class="seg st-size" id="st-size"><button data-v="s" aria-label="Small" data-tip="Small">${icon('gridS')}</button><button data-v="m" aria-label="Medium" data-tip="Medium">${icon('gridM')}</button><button data-v="l" aria-label="Large" data-tip="Large">${icon('gridL')}</button></div>
      </div></div>
      <div class="st-spaces" id="st-spaces" hidden></div>
      <div class="st-fresh" id="st-fresh" hidden></div>
      <div class="st-grid" id="st-grid"></div>
      <div class="st-empty" id="st-empty" hidden></div>`;
    const q=$('st-q');
    q.addEventListener('input',()=>{ clearTimeout(q.t); q.t=setTimeout(()=>{ ST.q=q.value; ST.vibe=null; loadStash(); },140); });
    q.addEventListener('keydown',e=>{ if(e.key==='Escape'&&q.value){ e.stopPropagation(); q.value=''; ST.q=''; loadStash(); } if(e.key==='Enter'){ const first=ST.vibe?ST.vibe.items[0]:ST.data?.items?.[0]; if(first)stOpen(first.id); } if(e.key==='ArrowDown'){ e.preventDefault(); $('st-grid').querySelector('.st-card')?.focus(); } });
    $('st-ways-tog').addEventListener('click',()=>{ const box=$('st-ways'); box.hidden=!box.hidden; ST.ways=box.hidden?'off':'on'; localStorage.setItem('meridian.cc.stashWays',ST.ways); if(!box.hidden)box.innerHTML=stWaysHTML(); });
    $('st-add').addEventListener('click',()=>openStashSheet());
    // Swipe to sort (6 Oct prototype), kept on 8 Oct. Lab mode carries over so a test sort saves nothing.
    // The tester server has no sorter page, and demo mode must not open the real Stash.
    $('st-sort')?.addEventListener('click',()=>{ location.href='/stash-sort'+(LAB?'?lab':''); });
    el.addEventListener('click',e=>{
      const nat=e.target.closest('[data-st-native]'); if(nat){ window.MeridianApp?.stash?.(nat.dataset.stNative)?.catch?.(err=>toast(String(err?.message||err))); return; }
      const kb=e.target.closest('[data-st-kind]'); if(kb){ ST.kind=ST.kind===kb.dataset.stKind?'':kb.dataset.stKind; ST.vibe=null; loadStash(); return; }
      const sb=e.target.closest('[data-st-space]'); if(sb){ ST.space=ST.space===sb.dataset.stSpace?'':sb.dataset.stSpace; ST.vibe=null; loadStash(); return; }
      const ob=e.target.closest('#st-order button'); if(ob){ ST.order=ob.dataset.v; ST.vibe=null; loadStash(); return; }
      const zb=e.target.closest('#st-size button'); if(zb){ ST.size=zb.dataset.v; localStorage.setItem('meridian.cc.stashSize',ST.size); stChips(); stLayout(true); return; }
      const uc=e.target.closest('[data-st-unchip]'); if(uc){ const raw=uc.dataset.stUnchip; const v=` ${$('st-q').value} `.replace(new RegExp('\\s'+raw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=\\s)','i'),' ').replace(/\s+/g,' ').trim(); $('st-q').value=v; ST.q=v; loadStash(); return; }
      if(e.target.closest('[data-st-unvibe]')){ ST.vibe=null; VIEWS.stash.update(); return; }
      const a=e.target.closest('[data-sact]'); const card=e.target.closest('.st-card');
      if(a&&card){ e.stopPropagation(); const it=stFind(card.dataset.id); if(!it)return; if(a.dataset.sact==='copy')stCopy(it); if(a.dataset.sact==='open')stOpenSource(it); if(a.dataset.sact==='delete')stDelete(it); return; }
      if(card)stOpen(card.dataset.id);
    });
    el.addEventListener('contextmenu',e=>{ const card=e.target.closest('.st-card'); if(!card)return; e.preventDefault(); const it=stFind(card.dataset.id); if(it)stMenu(e.clientX,e.clientY,it); });
    $('st-grid').addEventListener('keydown',e=>{ const c=e.target.closest('.st-card'); if(!c)return; if(e.key==='Enter'||e.key===' '){ e.preventDefault(); stOpen(c.dataset.id); } });
    let rt=0; new ResizeObserver(()=>{ cancelAnimationFrame(rt); rt=requestAnimationFrame(()=>stLayout()); }).observe($('st-grid'));
  },
  update(force){
    if(force){ if(ST.seenMark){ ST.seenBefore=ST.seenMark; ST.seenMark=null; } loadStash(); stMarkSeen(); }
    if(!ST.data){ $('st-grid').innerHTML='<div class="empty">Opening your stash…</div>'; return; }
    const d=ST.data; const list=ST.vibe?ST.vibe.items:d.items;
    stChips();
    const few=(d.counts?.all||0)<6;
    if(ST.ways!=='off'&&(few||ST.ways==='on')&&$('st-ways').hidden){ $('st-ways').hidden=false; $('st-ways').innerHTML=stWaysHTML(); }
    $('st-empty').hidden=!!list.length;
    $('st-empty').innerHTML=list.length?'':(d.counts?.all?`Nothing in your stash matches${ST.q?` “${esc(ST.q)}”`:' that'}.${ST.q?' Try fewer words, or a colour, like <b>blue</b>.':''}`:`<b>Nothing here yet.</b> Paste something now, or press ${esc(stKeys().screenshot||'⌃⌥S')} on your Mac.`);
    stRenderGrid();
  },
};
const stFind=(id)=>(ST.vibe?.items||[]).find(i=>i.id===id)||(ST.data?.items||[]).find(i=>i.id===id)||ST.all.find(i=>i.id===id)||(ST.open?.id===id?ST.open:null);
// Warm an original after the pointer settles. The click still reads fresh item details.
const stWarmImages=new Map(); let stWarmTimer=0, stWarmBusy=false;
function stWarmImage(card){
  if(document.hidden||navigator.connection?.saveData||!card.isConnected)return;
  const it=stFind(card.dataset.id); if(!it||it.kind!=='image'||!it.file||!it.bytes||it.bytes>4*1024*1024||stWarmBusy)return;
  const src=stFile(it); if(stWarmImages.has(src))return;
  const im=new Image(); im.decoding='async'; stWarmBusy=true;
  if(stWarmImages.size>=2)stWarmImages.delete(stWarmImages.keys().next().value);
  stWarmImages.set(src,im); im.src=src; im.decode().catch(()=>stWarmImages.delete(src)).finally(()=>{ stWarmBusy=false; });
}
function stWarmIntent(e){
  if(e.pointerType==='touch')return; const card=e.target.closest?.('.st-card');
  if(!card||card.contains(e.relatedTarget))return;
  clearTimeout(stWarmTimer); stWarmTimer=setTimeout(()=>stWarmImage(card),120);
}
function stWarmLeave(e){ const card=e.target.closest?.('.st-card'); if(card&&!card.contains(e.relatedTarget))clearTimeout(stWarmTimer); }
document.addEventListener('pointerenter',stWarmIntent,true); document.addEventListener('pointerleave',stWarmLeave,true);
document.addEventListener('focusin',stWarmIntent); document.addEventListener('focusout',stWarmLeave);
function stMenu(x,y,it){
  menu(x,y,[
    {label:'Open',icon:'eye',act:()=>stOpen(it.id)},
    it.url?{label:it.kind==='link'?'Open the page':'Open where it came from',icon:'out',act:()=>window.open(it.url,'_blank','noopener')}:null,
    {label:it.kind==='image'?'Copy the picture':it.kind==='link'?'Copy the link':'Copy',icon:'copy',act:()=>stCopy(it)},
    it.similar?{label:'Same vibe',icon:'sparkle',act:()=>stVibe(it)}:null,
    it.kind==='link'?{label:'Add to the shelf',icon:'shelf',act:()=>openLinkSheet({url:it.url,title:it.title,pinned:false})}:null,
    {label:it.pinned?'Unpin':'Pin to the top',icon:it.pinned?'unpin':'pin',act:()=>stPatch(it.id,{pinned:!it.pinned},it.pinned?'Unpinned':'Pinned to the top')},
    'hr',
    {label:'Delete',icon:'trash',danger:true,act:()=>stDelete(it)},
  ]);
}
async function stPatch(id,p,msg){ try{ const j=await send('/api/stash/'+id,p,'PATCH'); if(ST.open?.id===id)Object.assign(ST.open,j.item); if(msg)toast(msg); loadStash(); return j.item; }catch(err){ toast(err.message); } }
async function stDelete(it){
  try{ await send('/api/stash/'+it.id,undefined,'DELETE'); if(ST.open?.id===it.id)stClose(); if(ST.vibe)ST.vibe.items=ST.vibe.items.filter(x=>x.id!==it.id); loadStash();
    toast('Deleted',{undo:async()=>{ try{ await send('/api/stash/'+it.id+'/restore',{}); loadStash(); toast('Put back'); }catch(err){ toast(err.message); } }}); }catch(err){ toast(err.message); }
}
function stOpenSource(it){ window.open(it.kind==='link'||!it.file?it.url:stFile(it),'_blank','noopener'); }
// Copy as the thing itself: pictures as PNG, links as the URL, notes as text, colours as hex.
async function stCopy(it){
  try{
    if(it.kind==='image'){
      const png=fetch(stFile(it)).then(r=>r.blob()).then(async b=>{ if(b.type==='image/png')return b; const bm=await createImageBitmap(b); const c=document.createElement('canvas'); c.width=bm.width; c.height=bm.height; c.getContext('2d').drawImage(bm,0,0); return await new Promise(res=>c.toBlob(res,'image/png')); });
      await navigator.clipboard.write([new ClipboardItem({'image/png':png})]); toast('Picture copied'); return;
    }
    const text=it.kind==='link'?it.url:it.kind==='colour'?it.hex:it.kind==='note'||it.kind==='quote'?it.text:(it.url||location.origin+stFile(it));
    await navigator.clipboard.writeText(text); toast(it.kind==='colour'?`${it.hex} copied`:'Copied');
  }catch{ toast('Copy failed'); }
}
async function stVibe(it){
  try{ const j=await (await fetch(api('/api/stash/'+it.id+'/similar'))).json(); ST.vibe={id:it.id,title:stTitle(it),items:[it,...(j.items||[])]}; stClose(); if(view!=='stash')go('stash'); VIEWS.stash.update(); $('page').scrollTop=0; }catch{ toast('Couldn’t find similar things'); }
}

/* ---- one item, full size */
async function stOpen(id,{refresh=false}={}){
  let it=stFind(id);
  if(!refresh&&ST.open?.id===id&&$('st-detail')?.classList.contains('on'))return;
  try{ const j=await (await fetch(api('/api/stash/'+id))).json(); if(j.ok)it=j.item; }catch{}
  if(!it){ toast('That isn’t in your stash any more'); return; }
  ST.open=it; stDetail(it, refresh);
  if(location.hash!=='#stash/'+id)history.replaceState(null,'','#stash/'+id);
}
function stClose(keepHash){
  const d=$('st-detail'); if(!d||!d.classList.contains('on'))return;
  d.classList.remove('on'); window.MeridianA11y?.close(d); ST.open=null; d.querySelector('video')?.pause(); if(d.contains(document.activeElement))document.activeElement.blur();
  if(!keepHash&&location.hash.startsWith('#stash/'))history.replaceState(null,'','#stash');
  setTimeout(()=>{ if(!d.classList.contains('on'))d.querySelector('.st-d-media').innerHTML=''; },250);
}
// Where the caret sits in a field as [start,end], or put it back. Works for textareas and plain-text contenteditable.
function stCaret(el,set){
  if('selectionStart' in el){ if(!set)return [el.selectionStart,el.selectionEnd]; el.setSelectionRange(...set); return; }
  const s=getSelection();
  if(!set){ if(!s.rangeCount||!el.contains(s.anchorNode))return null; const r=s.getRangeAt(0), pre=document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer,r.startOffset); const a=pre.toString().length; return [a,a+r.toString().length]; }
  const t=el.firstChild; if(!t||t.nodeType!==3)return; const n=t.length, r=document.createRange(); r.setStart(t,Math.min(set[0],n)); r.setEnd(t,Math.min(set[1],n)); s.removeAllRanges(); s.addRange(r);
}
function stNeighbour(dir){ if(!ST.open)return; const list=ST.vibe?ST.vibe.items:(ST.data?.items||ST.all); const i=list.findIndex(x=>x.id===ST.open.id); const n=list[i+dir]; if(n)stOpen(n.id); }
function stDetail(it,refresh){
  let d=$('st-detail');
  if(!d){ d=document.createElement('div'); d.id='st-detail'; d.className='st-detail'; d.setAttribute('role','dialog'); d.setAttribute('aria-label','Stashed item'); document.body.appendChild(d);
    d.addEventListener('click',e=>{ if(e.target===d||e.target.closest('[data-st-close]'))return stClose();
      const b=e.target.closest('[data-dact]'); if(!b||!ST.open)return; const o=ST.open; const a=b.dataset.dact;
      if(a==='prev')stNeighbour(-1); if(a==='next')stNeighbour(1); if(a==='copy')stCopy(o); if(a==='open')stOpenSource(o); if(a==='download')window.open(stFile(o,true),'_blank');
      if(a==='vibe')stVibe(o); if(a==='shelf'){ stClose(true); openLinkSheet({url:o.url,title:o.title,pinned:false}); } if(a==='delete')stDelete(o); if(a==='refresh'){ send('/api/stash/'+o.id+'/refresh',{}).then(()=>toast('Reading it again')).catch(err=>toast(err.message)); }
      if(a==='pin')stPatch(o.id,{pinned:!o.pinned},o.pinned?'Unpinned':'Pinned to the top').then(()=>stDetail(ST.open,true));
      if(a==='hex')navigator.clipboard.writeText(b.dataset.hex).then(()=>toast(b.dataset.hex+' copied'),()=>toast('Copy failed'));
      if(a==='find'){ const w=b.dataset.q; stClose(); go('stash'); $('st-q').value=w; ST.q=w; ST.vibe=null; loadStash(); }
      if(a==='ocr'){ navigator.clipboard.writeText(o.ocr||'').then(()=>toast('Text copied'),()=>toast('Copy failed')); }
      if(a==='more'){ b.closest('.st-d-ocr').classList.add('all'); b.remove(); }
      if(a==='unspace'){ const sp=(o.spaces||[]).filter(s=>s!==b.dataset.s); stPatch(o.id,{spaces:sp}).then(()=>stDetail(ST.open,true)); }
    });
  }
  const k=it.kind; const list=ST.vibe?ST.vibe.items:(ST.data?.items||ST.all); const i=list.findIndex(x=>x.id===it.id);
  const ar=it.w&&it.h?`${it.w}/${it.h}`:'';
  let media='';
  if(k==='image')media=`<img class="st-d-img" alt="${esc(it.summary||it.title||it.name||'Stashed image')}" src="${stFile(it)}" ${ar?`style="aspect-ratio:${ar}"`:''}>`;
  else if(k==='video')media=`<video class="st-d-img" src="${stFile(it)}" controls playsinline preload="metadata"></video>`;
  else if(k==='file'&&/pdf/.test(it.mime||''))media=`<iframe class="st-d-pdf" src="${stFile(it)}" title="${esc(stTitle(it))}"></iframe>`;
  else if(k==='file')media=it.thumb?`<img class="st-d-img" alt="" src="${stThumb(it)}">`:`<div class="st-d-file">${icon('report')}<b>${esc(it.name||'File')}</b><span>${esc(stBytes(it.bytes))}</span></div>`;
  else if(k==='link')media=`<a class="st-d-link" href="${esc(it.url)}" target="_blank" rel="noopener">${it.thumb?`<img alt="" src="${stThumb(it)}">`:`<span class="big-mark">${esc((it.domain||'?').charAt(0).toUpperCase())}</span>`}<span class="go">${icon('out')}Open ${esc(it.domain)}</span></a>${it.description?`<p class="st-d-desc">${esc(it.description)}</p>`:''}`;
  else if(k==='note'||k==='quote')media=`<textarea class="st-d-text ${k}" id="st-d-text" spellcheck="true" aria-label="${k==='quote'?'Quote':'Note'}">${esc(it.text)}</textarea>`;
  else if(k==='colour'){ const {r,g,b}=(()=>{ const n=parseInt(it.hex.slice(1),16); return {r:n>>16&255,g:n>>8&255,b:n&255}; })(); media=`<div class="st-d-colour" style="background:${esc(it.hex)}"></div><div class="st-d-vals"><button class="btn sm ghost" data-dact="hex" data-hex="${esc(it.hex)}">${esc(it.hex)}</button><button class="btn sm ghost" data-dact="hex" data-hex="rgb(${r}, ${g}, ${b})">rgb(${r}, ${g}, ${b})</button></div>`; }
  const page=it.page&&(it.page.url||it.page.title)&&it.kind!=='link'?it.page:null;
  const src=[stShot(it)?'Screenshot':ST_SOURCE[it.source]||'',it.from?'from '+it.from:'',stWhen(it.created)].filter(Boolean).join(' · ');
  const pal=(it.palette||[]).filter(p=>p.weight>=.03);
  const labels=(it.labels||[]).filter(l=>l.id!=='screenshot').slice(0,8);
  const ocr=it.ocr&&it.ocr.trim().length>2?it.ocr.trim():'';
  const side=`<div class="st-d-nav"><button class="ibtn" data-dact="prev" aria-label="Previous" data-tip="Previous|←" ${i<=0?'disabled':''}>${icon('left')}</button><button class="ibtn" data-dact="next" aria-label="Next" data-tip="Next|→" ${i<0||i>=list.length-1?'disabled':''}>${icon('right')}</button><span class="grow"></span><button class="ibtn" data-dact="pin" aria-label="${it.pinned?'Unpin':'Pin to the top'}" data-tip="${it.pinned?'Unpin':'Pin to the top'}" aria-pressed="${!!it.pinned}">${icon(it.pinned?'unpin':'pin')}</button><button class="ibtn" data-st-close aria-label="Close" data-tip="Close|Esc">${icon('close')}</button></div>
    <div class="st-d-title" id="st-d-title" role="textbox" aria-multiline="false" aria-label="Stash title" contenteditable="plaintext-only" spellcheck="false" data-ph="${esc(k==='note'||k==='quote'?it.summary||'Add a title':stTitle(it))}">${esc(it.title||'')}</div>
    <div class="st-d-src">${esc(src)}</div>
    ${page?`<a class="st-d-page" href="${esc(page.url||'#')}" target="_blank" rel="noopener">${icon('globe')}<span><b>${esc(page.title||hostOf(page.url))}</b>${page.url?`<small>${esc(hostOf(page.url))}</small>`:''}</span></a>`:''}
    ${k==='quote'&&it.url&&!page?`<a class="st-d-page" href="${esc(it.url)}" target="_blank" rel="noopener">${icon('globe')}<span><b>${esc(it.domain)}</b></span></a>`:''}
    <textarea class="st-d-note" id="st-d-note" aria-label="Stash note" placeholder="Add a note" rows="2">${esc(it.note||'')}</textarea>
    <div class="st-d-sec"><h4>Spaces</h4><div class="st-d-spaces">${(it.spaces||[]).map(s=>`<span class="chip">${esc(s)}<button data-dact="unspace" data-s="${esc(s)}" aria-label="Take out of ${esc(s)}">${icon('close')}</button></span>`).join('')}<input id="st-d-space" aria-label="Add to a space" list="st-d-spaces" placeholder="${(it.spaces||[]).length?'Add another':'Add to a space'}" autocomplete="off"><datalist id="st-d-spaces">${(ST.data?.spaces||[]).filter(s=>!(it.spaces||[]).includes(s.name)).map(s=>`<option value="${esc(s.name)}">`).join('')}</datalist></div></div>
    ${pal.length?`<div class="st-d-sec"><h4>Colours</h4><div class="st-d-pal">${pal.map(p=>`<button data-dact="hex" data-hex="${esc(p.hex)}" style="background:${esc(p.hex)};flex:${Math.max(.6,p.weight*6).toFixed(2)}" data-tip="${esc(p.hex)}|${esc(p.name||'')} · click to copy"></button>`).join('')}</div><div class="st-d-tags">${[...new Set(pal.filter(p=>p.weight>=.06).map(p=>p.name))].map(n=>`<button class="tag" data-dact="find" data-q="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>`:''}
    ${ocr?`<div class="st-d-sec st-d-ocr"><h4>${k==='image'?'Text in the picture':'Text'}<button class="btn sm ghost" data-dact="ocr">${icon('copy')}Copy</button></h4><div class="txt">${esc(ocr)}</div>${ocr.length>420?'<button class="more" data-dact="more">Show all</button>':''}</div>`:''}
    ${labels.length?`<div class="st-d-sec"><h4>Looks like</h4><div class="st-d-tags">${labels.map(l=>`<button class="tag" data-dact="find" data-q="${esc(l.id.replace(/_/g,' '))}">${esc(l.id.replace(/_/g,' '))}</button>`).join('')}</div></div>`:''}
    ${it.pending?`<div class="st-d-sec dim" style="font-size:12.5px">Still ${k==='link'?'fetching the page':'reading the picture'}. This updates by itself.</div>`:''}
    <div class="st-d-acts">
      <button class="btn sm" data-dact="copy">${icon('copy')}Copy</button>
      ${it.url||it.file?`<button class="btn sm" data-dact="open">${icon('out')}Open</button>`:''}
      ${it.file?`<button class="btn sm ghost" data-dact="download">${icon('down')}Download</button>`:''}
      ${it.similar?`<button class="btn sm ghost" data-dact="vibe">${icon('sparkle')}Same vibe</button>`:''}
      ${k==='link'?`<button class="btn sm ghost" data-dact="shelf">${icon('shelf')}Add to the shelf</button>`:''}
      ${k!=='note'&&k!=='quote'&&k!=='colour'?`<button class="btn sm ghost" data-dact="refresh" data-tip="Read it again|New thumbnail, text and colours">${icon('refresh')}</button>`:''}
      <span class="grow"></span><button class="btn sm ghost danger" data-dact="delete">${icon('trash')}Delete</button>
    </div>`;
  const same=refresh&&d.dataset.id===it.id;
  if(!same)d.innerHTML=`<div class="st-d-box"><div class="st-d-media st-k-${k}"></div><aside class="st-d-side"></aside></div>`;
  const keepFocus=same&&document.activeElement&&d.contains(document.activeElement)?document.activeElement.id:null;
  // A refresh lands while you type (saving the note sends one back), so the title and note carry over as they are
  // if they're in use or still waiting to save: same letters, same caret, no jump to the start.
  const live=same?[...d.querySelectorAll('.st-d-side textarea[id],.st-d-side [contenteditable][id]')].filter(el=>el===document.activeElement||el.t):[];
  const at=live.includes(document.activeElement)?stCaret(document.activeElement):null, top=document.activeElement?.scrollTop;
  if(!same)d.querySelector('.st-d-media').innerHTML=media;
  d.querySelector('.st-d-side').innerHTML=side; d.dataset.id=it.id;
  live.forEach(el=>$(el.id)?.replaceWith(el));
  if(keepFocus&&$(keepFocus)){ const el=$(keepFocus); el.focus(); if(at){ stCaret(el,at); el.scrollTop=top; } }
  d.classList.add('on'); window.MeridianA11y?.open(d);
  // Edits save themselves: title on Enter or leaving it, note and text a moment after typing stops.
  const title=$('st-d-title');
  if(!title.bound){ title.bound=1;
  title.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){ e.preventDefault(); title.blur(); } if(e.key==='Escape'){ title.textContent=ST.open?.title||''; title.blur(); } });
  title.addEventListener('blur',()=>{ const v=title.textContent.trim(); if(ST.open&&v!==(ST.open.title||''))stPatch(ST.open.id,{title:v}); }); }
  const autosave=(el,key)=>{ if(!el||el.bound)return; el.bound=1; el.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Escape')el.blur(); }); el.addEventListener('input',()=>{ clearTimeout(el.t); el.t=setTimeout(()=>{ el.t=0; if(ST.open)stPatch(ST.open.id,{[key]:el.value}); },700); }); el.addEventListener('blur',()=>{ clearTimeout(el.t); el.t=0; if(ST.open&&el.value!==(ST.open[key]||''))stPatch(ST.open.id,{[key]:el.value}); }); };
  autosave($('st-d-note'),'note'); if(!same)autosave($('st-d-text'),'text');
  const sp=$('st-d-space');
  sp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'&&sp.value.trim()&&ST.open){ e.preventDefault(); const v=sp.value.trim(); stPatch(ST.open.id,{spaces:[...(ST.open.spaces||[]),v]},`Added to ${v}`).then(()=>{ stDetail(ST.open,true); $('st-d-space')?.focus(); }); } if(e.key==='Escape')sp.blur(); });
}
// The detail view takes the keyboard while it's open: arrows move, Escape closes, Delete deletes.
document.addEventListener('keydown',e=>{
  if(!$('st-detail')?.classList.contains('on'))return;
  if(typing(e)){ return; }
  if(e.key==='Escape'){ e.preventDefault(); e.stopImmediatePropagation(); stClose(); return; }
  if(e.key==='ArrowLeft'||e.key==='ArrowUp'){ e.preventDefault(); e.stopImmediatePropagation(); stNeighbour(-1); return; }
  if(e.key==='ArrowRight'||e.key==='ArrowDown'){ e.preventDefault(); e.stopImmediatePropagation(); stNeighbour(1); return; }
  if((e.key==='Backspace'||e.key==='Delete')&&ST.open){ e.preventDefault(); e.stopImmediatePropagation(); stDelete(ST.open); return; }
  if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&e.key.length===1)e.stopImmediatePropagation();   // no tab jumps behind the overlay
});

/* ---- the Add sheet: write a note, paste a link, or pick files (the phone's way in) */
function openStashSheet(prefill=''){
  openSheet('sheet-stash'); const ta=$('ss-text'); ta.value=prefill; setTimeout(()=>ta.focus(),70);
}
$('ss-files').addEventListener('click',stFilePicker);
// Paste: whatever's on the clipboard, picture or words. In the Mac app the native capture does it (no prompt).
$('ss-paste').addEventListener('click',async()=>{
  const A=window.MeridianApp;
  if(A?.stash){ try{ await A.stash('clipboard'); closeOverlays(); setTimeout(loadStash,800); }catch(err){ toast(String(err?.message||err)); } return; }
  try{
    if(navigator.clipboard?.read){
      const items=await navigator.clipboard.read(), files=[]; let text='';
      for(const it of items){ const img=it.types.find(t=>t.startsWith('image/')); if(img){ const b=await it.getType(img); files.push(new File([b],'pasted-image.'+(img.split('/')[1]||'png'),{type:img})); } else if(!text&&it.types.includes('text/plain'))text=(await (await it.getType('text/plain')).text()).trim(); }
      if(files.length){ closeOverlays(); stUpload(files,{source:'paste'}); return; }
      if(text){ const j=await stAddText(text,{source:'paste'}); if(j)closeOverlays(); return; }
      toast('Nothing on the clipboard'); return;
    }
    const t=await clipText(); if(!t){ toast('Nothing on the clipboard'); return; }
    const j=await stAddText(t,{source:'paste'}); if(j)closeOverlays();
  }catch(err){ toast(err.name==='NotAllowedError'?'Clipboard access blocked. Press \u2318V in the box instead.':err.message); $('ss-text').focus(); }
});
function stFilePicker(){ const i=document.createElement('input'); i.type='file'; i.multiple=true; i.onchange=()=>{ stUpload(i.files,{source:'upload'}); closeOverlays(); }; i.click(); }
$('sheet-stash').addEventListener('submit',async e=>{ e.preventDefault(); const t=$('ss-text').value.trim(); if(!t)return; const j=await stAddText(t,{source:'note'}); if(j){ $('ss-text').value=''; closeOverlays(); } });
$('ss-text').addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); $('sheet-stash').requestSubmit(); } });
$('ss-text').addEventListener('paste',e=>{ const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean); if(files.length){ e.preventDefault(); stUpload(files,{source:'paste'}); closeOverlays(); } });
$('sheet-stash').addEventListener('dragover',e=>e.preventDefault());
$('sheet-stash').addEventListener('drop',e=>{ e.preventDefault(); e.stopPropagation(); if(e.dataTransfer?.files?.length){ stUpload(e.dataTransfer.files,{source:'drop'}); closeOverlays(); } else stDrop(e.dataTransfer); });

/* ---------- tab switcher: hold ⌥ (or Ctrl), tap Tab ---------- */
let sw=null;
function switcherList(){ const vis=visibleTabs().map(t=>t.id); return [...mru.filter(id=>vis.includes(id)),...vis.filter(id=>!mru.includes(id))]; }
function switcherStep(dir){
  if(!sw){ sw={list:switcherList(),i:0}; }
  sw.i=(sw.i+dir+sw.list.length)%sw.list.length;
  $('switcher').innerHTML=sw.list.map((id,n)=>{ const t=TAB_DEFS.find(x=>x.id===id); return `<div class="sw-it${n===sw.i?' sel':''}">${icon(t.icon)}<span>${esc(t.label)}</span></div>`; }).join('');
  $('switcher').classList.add('on');
}
function switcherCommit(){ if(!sw)return; const id=sw.list[sw.i]; sw=null; $('switcher').classList.remove('on'); go(id); }

/* ---------- keyboard ---------- */
// The dashboard's own shortcuts, changeable in the ? sheet and saved with your other settings (prefs.keys).
// A key is written like "f", ">", "mod+k" (⌘ or ⌃), "alt+shift+p".
const PAGE_KEYS=[
  {id:'search',g:'Get around',label:'Search or jump',def:'mod+k',run:()=>$('pal').classList.contains('on')?closeOverlays():palOpen()},
  {id:'sidebar',g:'Get around',label:'Show or hide the sidebar',def:'mod+s',run:()=>toggleSidebar()},
  {id:'compact',g:'Get around',label:'Compact sidebar',def:'\\',run:()=>setSideMode(prefs.side.mode==='compact'?'docked':'compact')},
  {id:'last',g:'Get around',label:'Last tab',def:'`',run:()=>{ if(mru[1])go(mru[1]); }},
  {id:'fix',g:'Do things',label:'Log a fix',def:'f',run:()=>openFix()},
  {id:'link',g:'Do things',label:'Add a link',def:'n',run:()=>openLinkSheet({})},
  {id:'capture',g:'Do things',label:'Capture a to-do, note or stash',def:'>',run:()=>openCapture()},
  {id:'shelf',g:'Do things',label:'Search the shelf',def:'/',run:()=>{ go('shelf'); setTimeout(()=>$('s-q')?.focus(),40); }},
  {id:'settings',g:'Settings',label:'Settings',def:'mod+,',run:()=>$('setpop').classList.contains('on')?closeOverlays():openSettings()},
  {id:'custom',g:'Settings',label:'Customise',def:',',run:()=>customOpen()?closeOverlays():openCustom()},
  {id:'keys',g:'Settings',label:'Show these shortcuts',def:'?',run:()=>openKeys()},
  {id:'demo',g:'Settings',label:'Demo mode on or off',def:'mod+shift+d',run:()=>{ toast(DEMO?'Demo mode off':'Demo mode on'); setDemo(!DEMO); }},
  {id:'terminal',g:'Side panel',label:'Terminal (on the dashboard)',def:'t',app:true,run:()=>panelCall('toggle',{kind:'terminal'})},
  {id:'browser',g:'Side panel',label:'Browser (on the dashboard)',def:'b',app:true,run:()=>panelCall('toggle',{kind:'web'})},
];
const pageKey=(id)=>prefs.keys?.[id]||PAGE_KEYS.find(x=>x.id===id)?.def||'off';
function keySpec(e){
  if(['Shift','Control','Alt','Meta','CapsLock','Fn','Dead'].includes(e.key))return '';
  const mod=e.metaKey||e.ctrlKey; let k=e.key;
  // With ⌘ or ⌥ held, e.key turns into symbols, so the physical key decides.
  if(mod||e.altKey)k=/^Key[A-Z]$/.test(e.code)?e.code.slice(3):/^Digit\d$/.test(e.code)?e.code.slice(5):(KEY_CODES[e.code]||k);
  k=k===' '?'space':k.length===1?k.toLowerCase():k.toLowerCase();
  return (mod?'mod+':'')+(e.altKey?'alt+':'')+((mod||e.altKey)&&e.shiftKey?'shift+':'')+k;
}
function pageKeyLabel(spec){
  if(!spec||spec==='off')return 'Off';
  const parts=spec.split('+'); const k=parts.pop();
  const name={space:'Space',enter:'↵',escape:'Esc',tab:'Tab',backspace:'⌫',arrowup:'↑',arrowdown:'↓',arrowleft:'←',arrowright:'→'}[k]||(k.length===1?k.toUpperCase():k);
  return parts.map(p=>({mod:'⌘',alt:'⌥',shift:'⇧'}[p]||'')).join('')+name;
}
// Keys a page shortcut can't take: they already mean something everywhere.
const KEY_TAKEN={'mod+c':'copy','mod+v':'paste','mod+x':'cut','mod+a':'select all','mod+z':'undo','mod+w':'close the window','mod+q':'quit','mod+r':'reload','mod+t':'a new tab','mod+n':'a new window','mod+l':'the address bar','mod+f':'find',escape:'closing things',tab:'moving between fields',enter:'pressing buttons'};
// Keys a page shortcut can't take because typing and the built-in switchers need them: ⌘⌫ and ⌥← edit text, ⌥Tab and ⌃Tab
// switch tabs, ⌃1–9 switch Spaces. Checked when recording and again when a saved key is pressed.
function keyReserved(spec){
  if(KEY_TAKEN[spec])return KEY_TAKEN[spec];
  if(/^(mod\+|alt\+|mod\+alt\+)(shift\+)?(backspace|delete|arrowleft|arrowright|arrowup|arrowdown)$/.test(spec))return 'editing text';
  if(/^(mod\+|alt\+)(shift\+)?tab$/.test(spec))return 'the tab switcher';
  if(/^mod\+[1-9]$/.test(spec))return 'switching Spaces';
  return '';
}
let pageRec=null;
function startPageRec(id){ if(recording)stopRecord(); pageRec=id; renderKeys(); }
// While choosing a key, every press goes here first.
document.addEventListener('keydown',e=>{
  if(!pageRec)return;
  if(!keysOpen()){ pageRec=null; return; } // the sheet closed under it: the key is for the page
  e.preventDefault(); e.stopImmediatePropagation();
  const id=pageRec, spec=keySpec(e); if(!spec)return;
  const plain=!/[+]/.test(spec);
  if(spec==='escape'){ pageRec=null; renderKeys(); return; }
  if(spec==='backspace'||spec==='delete'){ pageRec=null; prefs.keys={...(prefs.keys||{}),[id]:'off'}; savePrefs(); renderKeys(); toast(`${PAGE_KEYS.find(x=>x.id===id).label}: off`); return; }
  const why=keyReserved(spec)||(plain&&/^[1-9]$/.test(spec)?'going to a tab':'');
  if(why){ const b=document.querySelector(`[data-sc="pg:${id}"] .kbtn`); if(b)b.textContent=`${pageKeyLabel(spec)} is for ${why}`; return; }
  const clash=PAGE_KEYS.find(x=>x.id!==id&&pageKey(x.id)===spec);
  if(clash){ const b=document.querySelector(`[data-sc="pg:${id}"] .kbtn`); if(b)b.textContent=`${pageKeyLabel(spec)} is ${clash.label}`; return; }
  pageRec=null; prefs.keys={...(prefs.keys||{}),[id]:spec}; savePrefs(); renderKeys(); toast(`${PAGE_KEYS.find(x=>x.id===id).label}: ${pageKeyLabel(spec)}`);
},true);
addEventListener('blur',()=>{ if(pageRec){ pageRec=null; if(keysOpen())renderKeys(); } });
document.addEventListener('keydown',e=>{
  const mod=e.metaKey||e.ctrlKey;
  if(e.key==='Tab'&&(e.altKey||(e.ctrlKey&&!e.metaKey))){ e.preventDefault(); switcherStep(e.shiftKey?-1:1); return; }
  // ⌃1 is All, then each Space in order.
  if(spacesOn()&&e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&/^Digit[1-9]$/.test(e.code)){ const id=['all',...spaceList().map(x=>x.id)][Number(e.code.slice(5))-1]; if(id){ e.preventDefault(); setSpace(id); } return; }
  if(e.key==='Escape'){ if(sw){ sw=null; $('switcher').classList.remove('on'); return; } const pop=document.querySelectorAll('.picker.open'); if(pop.length){ e.preventDefault(); pop.forEach(p=>{ p.classList.remove('open'); const b=p.querySelector('[data-trig]'); b.setAttribute('aria-expanded','false'); b.focus({preventScroll:true}); }); return; } if(document.querySelector('.sheet.on,.drawer-r.on,.pal.on')||document.body.classList.contains('drawer-open')||menuEl){ e.preventDefault(); closeOverlays(); } return; }
  const spec=keySpec(e); const pk=spec&&!keyReserved(spec)&&PAGE_KEYS.find(x=>pageKey(x.id)===spec&&(!x.app||panelOn()));
  // With ⌘ or ⌃ they work even while typing, like ⌘K always has.
  if(pk&&mod){ e.preventDefault(); pk.run(); return; }
  if(typing(e)||mod)return;
  if(document.querySelector('.sheet.on,.drawer-r.on,.pal.on,.picker.open'))return;
  if(!e.altKey&&/^[1-9]$/.test(e.key)){ const t=visibleTabs()[Number(e.key)-1]; if(t){ e.preventDefault(); go(t.id); } return; }
  if(pk){ e.preventDefault(); pk.run(); }
});
document.addEventListener('keyup',e=>{ if(sw&&(e.key==='Alt'||e.key==='Control'||(!e.altKey&&!e.ctrlKey)))switcherCommit(); });
addEventListener('blur',()=>{ if(sw)switcherCommit(); });

/* ---------- mobile: swipe in from the left edge ---------- */
let touchX=null;
addEventListener('touchstart',e=>{ const t=e.touches[0]; touchX=isMobile()&&t.clientX<24&&!document.body.classList.contains('drawer-open')?t.clientX:null; },{passive:true});
addEventListener('touchmove',e=>{ if(touchX==null)return; if(e.touches[0].clientX-touchX>50){ touchX=null; setDrawer(true); } },{passive:true});

/* ---------- spaces ---------- */
// Work, Uni and Personal: each has its own top shelf and glow. A link belongs to
// the Space that holds its group, unless it was moved there by hand.
// Demo mode has its own made-up groups, so it gets matching Spaces and never edits the real ones.
var DEMO_SPACES=[ // var, so applyTint can ask for Spaces before this line runs
{id:'personal',name:'Personal',color:'#5fd3a5',groups:['Personal','Fieldnotes']},{id:'work',name:'Work',color:'#6db4ff',groups:['Northwind','Tidepool','Tools']},{id:'uni',name:'Uni',color:'#b7a1ff',groups:['Uni']}];
// A Space's colour, with the lab's palette preview on top.
function spColor(s){ return labLook?.spaces?.[s.id]||s.color; }
function spaceList(){ return DEMO?(DEMO_SPACES||[]):(prefs.spaces?.list||[]).filter(s=>s&&s.id); }
// 5 October: Spaces are hidden while we decide what they're for (spacesOn). Hidden reads as All everywhere;
// the Spaces themselves, their groups and colours are kept, and Customise → Spaces brings the switcher back.
const spacesOn=()=>lookOpt('spaces')==='shown';
function activeSpace(){ return spaceId==='all'||!spacesOn()?null:spaceList().find(s=>s.id===spaceId)||null; }
function spaceOf(l){ const o=prefs.spaces?.links?.[l.id]; if(o&&spaceList().some(s=>s.id===o))return o; return spaceList().find(s=>(s.groups||[]).includes(l.category))?.id||null; }
function inSpace(l){ const s=activeSpace(); return !s||spaceOf(l)===s.id; }
function setSpace(id,{quiet=false}={}){
  if(id!=='all'&&!spaceList().some(s=>s.id===id))id='all';
  if(id===spaceId)return; spaceId=id; try{ localStorage.setItem(SPACE_KEY,id); }catch{}
  applyPrefs(); sideSig=''; renderSide(); shelfSig=''; homeShelfSig=''; VIEWS[view]?.update?.(true);
  if(!quiet){ const s=activeSpace(); toast(s?`${s.name} space`:'All spaces'); }
}
function stepSpace(d){ const ids=['all',...spaceList().map(s=>s.id)]; const i=Math.max(0,ids.indexOf(spaceId)); setSpace(ids[(i+d+ids.length)%ids.length],{quiet:true}); }
function setLinkSpace(id,sid){ prefs.spaces.links={...(prefs.spaces.links||{}),[id]:sid}; savePrefs(); sideSig=''; renderSide(); shelfSig=''; homeShelfSig=''; VIEWS[view]?.update?.(true); const s=spaceList().find(x=>x.id===sid); toast(`Moved to ${s?s.name:'All'}`); }
// The top shelf is one order across every Space, so a drag inside one Space only swaps that Space's slots.
function mergePinOrder(ids){ const full=topShelf().map(l=>l.id); const set=new Set(ids); const slots=full.map((id,i)=>set.has(id)?i:-1).filter(i=>i>=0); if(slots.length!==ids.length)return ids; const out=full.slice(); ids.forEach((id,k)=>{ out[slots[k]]=id; }); return out; }
const SPACE_ICONS={all:'allsp',personal:'person',work:'briefcase',uni:'cap'};
const spaceIcon=(id)=>SPACE_ICONS[id]?icon(SPACE_ICONS[id]+(lookOpt('spaceicons')!=='outline'?'F':'')):'<i></i>';
function spacesHTML(dock){
  const list=spaceList(); if(!list.length)return '';
  if(dock){ const d=(id,name,color,i)=>`<button type="button" class="spd${spaceId===id?' on':''}" data-space="${esc(id)}" style="--c:${esc(color)}" data-tip="${esc(name)}|⌃${i+1}" aria-label="${esc(name)}" aria-pressed="${spaceId===id}">${spaceIcon(id)}</button>`;
    return d('all','All','var(--ink)',0)+list.map((s,i)=>d(s.id,s.name,spColor(s),i+1)).join(''); }
  const b=(id,name,color,i)=>`<button type="button" class="spc${spaceId===id?' on':''}" data-space="${esc(id)}" style="--c:${esc(color)}" data-tip="${esc(name)}|⌃${i+1}" aria-pressed="${spaceId===id}"><i></i><span>${esc(name)}</span></button>`;
  return b('all','All','var(--dim)',0)+list.map((s,i)=>b(s.id,s.name,spColor(s),i+1)).join('');
}
document.addEventListener('click',e=>{ const b=e.target.closest('[data-space]'); if(b&&!b.closest('#custom'))setSpace(b.dataset.space,{quiet:true}); });
$('spaces').addEventListener('contextmenu',e=>{ e.preventDefault(); menu(e.clientX,e.clientY,[{label:'Edit spaces',icon:'sliders',act:()=>{ openCustom(); setTimeout(()=>$('c-spaces')?.scrollIntoView({block:'start',behavior:'smooth'}),80); }}]); });
// A two-finger swipe sideways on the sidebar moves between Spaces, like Arc.
let swipeX=0, swipeAt=0, swipeT=0;
$('side').addEventListener('wheel',e=>{ if(Math.abs(e.deltaX)<=Math.abs(e.deltaY)*1.5||!spacesOn()||spaceList().length<1)return; const now=Date.now(); if(now-swipeAt<450)return;
  swipeX+=e.deltaX; clearTimeout(swipeT); swipeT=setTimeout(()=>{ swipeX=0; },180);
  if(Math.abs(swipeX)>80){ stepSpace(swipeX>0?1:-1); swipeX=0; swipeAt=now; } },{passive:true});
function calTag(e){ const name=e.calendar||''; return name?`<span class="caltag" style="--c:${esc(e.color||'var(--dim)')}"><i></i>${esc(name)}</span>`:''; }

/* ---------- agents strip ---------- */
// A slim bar along the bottom of the page: which agents are working right now.
// Agents that report in from elsewhere (a tester's own, over MCP) keep their own names.
const AGENT_LABEL={claude:'Claude',codex:'Codex',chatgpt:'ChatGPT',cursor:'Cursor',copilot:'Copilot',gemini:'Gemini',agent:'Agent'};
const agentLabel=(t)=>AGENT_LABEL[t]||'Agent';
function stripItems(){
  if(!state)return [];
  const runs=((state.delegations&&state.delegations.runs)||[]).filter(r=>['running','queued'].includes(r.status))
    .map(r=>({k:'run',id:r.id,raw:r,tool:/gpt|codex|luna|openai|o\d/i.test(r.model||'')?'codex':'claude',name:r.model||'Agent',what:r.title||''}));
  const ses=(state.ai?.sessions||[]).filter(s=>s.live)
    .map(s=>({k:'ses',id:s.id||s.started,raw:s,tool:AGENT_LABEL[s.tool]?s.tool:'claude',name:stripName(s.project),what:s.did||s.prompt||''}));
  return [...runs,...ses];
}
// "Developer" or "home" says nothing; an automation's folder name becomes words.
function stripName(p){ const last=String(p||'').split('/').filter(Boolean).pop()||''; if(/^(developer|home|documents|desktop|tmp|private|~)$/i.test(last))return ''; const w=last.replace(/[-_]+/g,' ').replace(/\s+\d+$/,'').trim(); return w.charAt(0).toUpperCase()+w.slice(1); }
let stripSig='';
function renderStrip(){
  const el=$('agentstrip'); if(!el)return;
  const mode=prefs.strip||'auto'; const items=mode==='off'?[]:stripItems();
  const s=sig([mode,items.map(i=>[i.k,i.id,i.name,cap(i.what,80)]),window.feelReady&&FEEL()?[feelOpt('rings'),Math.floor(Date.now()/60000)]:0]); if(s===stripSig)return; stripSig=s;
  const on=mode!=='off'&&(items.length>0||mode==='always'); el.hidden=!on; root.toggleAttribute('data-strip-on',on);
  const chip=(i)=>`<button type="button" class="as-it" data-strip="${i.k}" data-sid="${esc(i.id)}" data-tip="${esc(i.name||agentLabel(i.tool))}|${esc(cap(i.what,160))}">${window.feelReady&&FEEL()?feelStripRing(i):'<i class="dot ok pulse"></i>'}<b class="${i.tool}">${agentLabel(i.tool)}</b>${i.name?`<span class="nm">${esc(i.name)}</span>`:''}${i.what?`<span class="wh">${esc(cap(i.what,70))}</span>`:''}</button>`;
  el.innerHTML=`<div class="as-bar">${items.length?items.slice(0,4).map(chip).join('')+(items.length>4?`<button type="button" class="as-it more" data-strip="ses">+${items.length-4} more</button>`:''):'<span class="as-none"><i class="dot"></i>No agents working</span>'}</div>`;
}
// Click a chip to see where that agent is working: the to-do or note it came from, its folder, what it has
// written so far, and buttons to open each. "+N more" still goes to System.
let stripPop=null;
const closeStripPop=()=>{ stripPop?.remove(); stripPop=null; };
const tildePath=p=>String(p||'').replace(/^\/Users\/[^/]+/,'~');
function stripPopHTML(i){
  const head=`<div class="ap-h"><i class="dot ok pulse"></i><b class="${i.tool}">${agentLabel(i.tool)}</b><span>${esc(i.name||'')}</span><button type="button" class="ibtn" data-ap="close" aria-label="Close">${icon('close')}</button></div>`;
  const row=(k,v)=>v?`<div class="ap-r"><span>${k}</span><div>${v}</div></div>`:'';
  if(i.k==='run'){
    const r=i.raw, t=r.todoId&&(state.todos||[]).find(x=>x.id===r.todoId), b=r.projectId&&briefTodos().find(x=>x.id===r.projectId);
    const named=(w,x)=>x.title===r.title?w:`${w} · ${esc(x.title)}`;
    const from=r.kind==='feedback'?'Dogfood feedback':t?named('Your to-do',t):b?named(esc(SRC_LABEL[b.source]||'Inbox'),b):r.todoId?'A to-do (since ticked off)':'Delegated';
    const files=(r.files||[]).map(f=>`<button type="button" class="btn sm ghost" data-ap="file" data-f="${esc(f)}">${icon('out')}${esc(f)}</button>`).join('');
    return head+`<div class="ap-t">${esc(r.title||'')}</div>`
      +row('From',from)+row('Started',`${esc(dayWord(r.started))} ${hm(r.started)} · ${Math.max(1,Math.round((Date.now()-r.started)/60000))} min so far`)
      +row('Folder',`<code>Meridian/delegations/${esc(r.id)}</code>`)+row('Written',files||'<span class="dim">Nothing yet</span>')
      +`<div class="ap-a"><button type="button" class="btn sm" data-ap="reveal">${icon('mac')}Show in Finder</button>${r.kind==='feedback'?`<button type="button" class="btn sm ghost" data-ap="dogfood">Open in Dogfood</button>`:t||b?`<button type="button" class="btn sm ghost" data-ap="todo">Show the to-do</button>`:''}<button type="button" class="btn sm ghost" data-ap="stop">Stop</button></div>`;
  }
  const s=i.raw;
  return head+row('Folder',s.cwd?`<code>${esc(tildePath(s.cwd))}</code>`:esc(s.project||''))+row('Started',`${esc(dayWord(s.started))} ${hm(s.started)}`)
    +row('Asked',s.prompt?esc(cap(s.prompt,220)):'')+row('Latest',s.did?esc(cap(s.did,220)):'')
    +`<div class="ap-a">${s.cwd?`<button type="button" class="btn sm" data-ap="reveal">${icon('mac')}Show in Finder</button>`:''}${s.id?`<button type="button" class="btn sm ghost" data-ap="resume">${icon('terminal')}Copy resume command</button>`:''}<button type="button" class="btn sm ghost" data-ap="system">All sessions</button></div>`;
}
function openStripPop(btn){
  const i=stripItems().find(x=>x.k===btn.dataset.strip&&String(x.id)===btn.dataset.sid); if(!i){ go('system'); return; }
  closeStripPop(); hideTip(); stripPop=document.createElement('div'); stripPop.className='as-pop'; stripPop.setAttribute('role','dialog');
  stripPop.innerHTML=stripPopHTML(i); document.body.appendChild(stripPop);
  const r=btn.getBoundingClientRect(), w=stripPop.offsetWidth;
  stripPop.style.left=Math.max(10,Math.min(r.left,innerWidth-w-10))+'px'; stripPop.style.bottom=(innerHeight-r.top+8)+'px';
  stripPop.addEventListener('click',async e=>{
    const b=e.target.closest('[data-ap]'); if(!b)return; const a=b.dataset.ap;
    if(a==='close'){ closeStripPop(); return; }
    if(a==='file'){ openUrl(new URL(api('/delegations/'+encodeURIComponent(i.id)+'/'+encodeURIComponent(b.dataset.f)),location.href).href,null,'split'); return; }
    if(a==='reveal'){ try{ await send('/api/reveal',i.k==='run'?{run:i.id}:{session:i.id}); toast('Opened in Finder'); }catch(err){ toast(err.message); } return; }
    if(a==='resume'){ const s=i.raw, cmd=(s.cwd?`cd ${JSON.stringify(s.cwd)} && `:'')+(s.tool==='codex'?`codex resume ${s.id}`:`claude --resume ${s.id}`); try{ await navigator.clipboard.writeText(cmd); toast('Copied. Paste it in a terminal'); }catch{ toast('Copy failed'); } return; }
    if(a==='stop'){ if(!confirm(`Stop "${i.raw.title||'this run'}"?`))return; b.disabled=true; try{ await send('/api/delegations/'+encodeURIComponent(i.id)+'/cancel',{}); toast('Stopped'); closeStripPop(); loadState(); }catch(err){ toast(err.message); b.disabled=false; } return; }
    closeStripPop();
    if(a==='dogfood')go('dogfood'); else if(a==='system')go('system');
    else if(a==='todo'){ const id=i.raw.todoId||i.raw.projectId; todoFilter='all'; todoShowAll=true; go('home'); VIEWS.home?.update?.();
      setTimeout(()=>{ const row=$('h-todo')?.querySelector(`[data-todo="${CSS.escape(id)}"],[data-brief="${CSS.escape(id)}"]`); if(!row)return; row.scrollIntoView({block:'center',behavior:'smooth'}); row.classList.add('flash'); setTimeout(()=>row.classList.remove('flash'),1600); },120); }
  });
}
$('agentstrip').addEventListener('click',e=>{ const b=e.target.closest('[data-strip]'); if(!b)return; if(b.classList.contains('more')){ go('system'); return; } if(stripPop&&stripPop.dataset.for===b.dataset.sid){ closeStripPop(); return; } openStripPop(b); if(stripPop)stripPop.dataset.for=b.dataset.sid; });
document.addEventListener('pointerdown',e=>{ if(stripPop&&!stripPop.contains(e.target)&&!e.target.closest('#agentstrip'))closeStripPop(); },true);
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&stripPop)closeStripPop(); });

/* ---------- feel (lab, 8 Oct 2026) ---------- */
// The picks from the Nothing rebuild: sounds, the tick, the sky arc, agent rings, Launch into Standby, rockets.
// On in lab only (/command?lab, and the board at /design/nothing-picks) until Owner picks; then prefs.labs.feel.
// The choices are look keys, so the board's lab messages can try them on: feelsound, feeltick, feelsky, feelrings,
// feelpomo, feelrockets. See /feel.js.
const FEEL_DEF={sound:'key',tick:'dots',sky:'hero',rings:'time',pomo:'off',rockets:'both'};
const FEEL=()=>LAB||!!prefs.labs?.feel;
const feelOpt=(k)=>FEEL()?(lookOpt('feel'+k)||FEEL_DEF[k]):'off';
window.Feel?.init({opt:(k)=>feelOpt(k==='tickfx'?'tick':k),data:feelStandbyData});
// How long jobs like this one usually take you, in minutes: delegated runs by model family, sessions by tool.
function feelUsual(kind,tool){
  if(kind==='run')return Feel.usual(((state?.delegations?.runs)||[]).filter(r=>r.finished&&r.status==='done'&&(/gpt|codex|luna|sol|openai/i.test(r.model||'')?'codex':'claude')===tool).map(r=>(r.finished-r.started)/60000),8);
  return Feel.usual((state?.ai?.sessions||[]).filter(s=>!s.live&&s.tool===tool&&s.last&&s.started).map(s=>(s.last-s.started)/60000),25);
}
function feelAgents(){ return stripItems().map(i=>({...i,who:i.name||agentLabel(i.tool),started:Number(i.raw.started)||Date.now(),usual:feelUsual(i.k,i.tool)})); }
function feelRingWords(a,g){ const mode=feelOpt('rings'), u=Math.round(g.u), el=Math.round(g.el);
  if(mode==='pulse')return `${el} min so far`;
  if(mode==='honest')return `${el} min · jobs like this take about ${u}`;
  return el>u?`<span class="over">${el-u} min longer than usual</span> · ${el} min so far`:`${el} of about ${u} min`; }
function feelStandbyData(){
  const sky=almanac?.items?.sky; const evs=(state?.calendar?.events||[]).filter(e=>!e.allDay&&(e.end||e.ts)>=Date.now()&&e.response!=='declined').sort((a,b)=>a.ts-b.ts);
  const open=(state?.todos||[]).filter(t=>!t.done).length+(state?briefTodos().length:0);
  return {rise:sky?.today?.sunrise,set:sky?.today?.sunset,temp:sky?.now?.temp,weather:sky?.now?.label,next:evs[0]&&{title:evs[0].title,ts:evs[0].ts},todo:open,agents:feelAgents()};
}
// The sky arc sits in the Home header, with the time in dots under it.
function feelSky(){
  const hero=$('h-hero'); let el=$('feel-sky'); if(!hero)return;
  if(feelOpt('sky')==='off'){ el?.remove(); return; }
  if(!el||el.parentElement!==hero){ el?.remove(); el=document.createElement('div'); el.id='feel-sky'; el.className='feel-sky'; el.setAttribute('aria-hidden','true'); el.innerHTML='<canvas></canvas><div class="fs-t"></div><div class="fs-l"></div>'; hero.appendChild(el); }
  const t=almanac?.items?.sky?.today||{}, now=new Date();
  Feel.skyArc(el.querySelector('canvas'),{rise:t.sunrise,set:t.sunset,now});
  setHTML(el.querySelector('.fs-t'),Feel.colon(hm(now)));
  setHTML(el.querySelector('.fs-l'),t.sunrise?`Sunrise <b>${esc(t.sunrise)}</b> · Sunset <b>${esc(t.sunset)}</b>`:'');
}
setInterval(()=>{ if(FEEL()&&view==='home'&&!document.hidden)feelSky(); },20e3);
// Live now as rings: running jobs and live sessions, each timed against your usual.
function feelLive(){
  const ags=feelAgents(), mode=feelOpt('rings'); if(!ags.length)return '';
  return ags.slice(0,4).map(a=>{ const g=Feel.progress(a.started,a.usual,mode); return `<div class="feel-rrow" data-tip="${esc(agentLabel(a.tool))}|${esc(cap(a.what,160))}"><div class="fr-w">${Feel.ringSVG({...g,mode,size:52})}<span>${esc(g.label)}</span></div><div class="main"><div class="t">${esc(a.who)}${a.what?` · <span class="dim">${esc(cap(a.what,60))}</span>`:''}</div><div class="s">${feelRingWords(a,g)}</div></div></div>`; }).join('');
}
function feelStripRing(i){ const mode=feelOpt('rings'); const g=Feel.progress(Number(i.raw.started)||Date.now(),feelUsual(i.k,i.tool),mode); return Feel.ringSVG({...g,mode,size:18}); }
// A job handed to an agent launches a rocket to the strip; when a run finishes, a lander comes down on its to-do.
function feelRocket(kind,id,title){ if(!FEEL())return; const from=document.querySelector(`[data-${kind}="${CSS.escape(id)}"] .tick`)||document.querySelector(`[data-${kind}="${CSS.escape(id)}"]`); const strip=$('agentstrip');
  if(from)Feel.rocket(from,strip&&!strip.hidden?strip.querySelector('.as-bar')||strip:{x:innerWidth/2,y:innerHeight+30},{label:title}); }
let feelRunning=null;
function feelWatch(s){ if(!FEEL())return; const runs=(s?.delegations?.runs)||[]; const now=new Set(runs.filter(r=>['running','queued'].includes(r.status)).map(r=>r.id));
  if(feelRunning)for(const id of feelRunning){ if(now.has(id))continue; const r=runs.find(x=>x.id===id); if(!r||r.status!=='done')continue; feelLand(r); }
  feelRunning=now; }
function feelLand(r){ const row=r.todoId&&document.querySelector(`[data-todo="${CSS.escape(r.todoId)}"]`)||r.projectId&&document.querySelector(`[data-brief="${CSS.escape(r.projectId)}"]`);
  const vis=row&&row.getBoundingClientRect().top>0&&row.getBoundingClientRect().bottom<innerHeight;
  if(!Feel.lander(vis?row:$('agentstrip')?.hidden===false?$('agentstrip'):{x:innerWidth-140,y:innerHeight-70},{label:r.title}))Feel.play('chime'); }
function feelLaunch(){ if(!FEEL())return; closeOverlays(); Feel.launch({data:feelStandbyData}); }
if(FEEL())PAGE_KEYS.push({id:'standby',g:'Do things',label:'Launch into Standby (lab)',def:'l',run:feelLaunch});
// Called from applyPrefs: lab looks and Customise changes land straight away.
function feelApply(){ root.classList.toggle('feel-on',FEEL()); if(typeof view!=='undefined'&&view==='home'&&state){ feelSky(); homeLive(); } stripSig=''; if(typeof renderStrip==='function'&&state)renderStrip(); }
function feelCustom(seg,head){ const L=prefs.look, c=(k)=>lookOpt('feel'+k)||FEEL_DEF[k];
  return head('Lab: picks from the Nothing rebuild')+`
    <div class="opt-g"><label>Sound</label>${seg('feelsound',[['off','Off'],['key','Key moments'],['all','Every button']],c('sound'))}<p class="hint">Key moments: the chime when you tick something off, Launch, Standby, rockets. Every button adds the little tick on each press, like the rebuild.</p></div>
    <div class="opt-g"><label>Ticking a to-do</label>${seg('feeltick',[['dots','Cross off + dots'],['pixels','Cross off + pixels'],['plain','Just the tick']],c('tick'))}</div>
    <div class="opt-g"><label>Sky arc</label>${seg('feelsky',[['hero','In the header'],['off','Off']],c('sky'))}<p class="hint">The sun's path from sunrise to sunset, with the time in dots.</p></div>
    <div class="opt-g"><label>Agent rings</label>${seg('feelrings',[['time','Against your usual'],['honest','Never quite full'],['pulse','Just busy']],c('rings'))}<p class="hint">How far along a job is, timed against how long jobs like it have taken you, not the agent's own guess.</p></div>
    <div class="opt-g"><label>Rockets</label>${seg('feelrockets',[['both','Rocket and lander'],['rocket','Rocket only'],['lander','Lander only'],['off','Off']],c('rockets'))}</div>
    <div class="opt-g"><label>Standby</label>${seg('feelpomo',[['off','No timer'],['on','With a focus timer']],c('pomo'))}<button type="button" class="btn ghost" id="c-feel-launch" style="margin-top:8px">${icon('bolt')}Launch into Standby</button><p class="hint">Press L from anywhere. Any key or a tap lands it.</p></div>`; }
document.addEventListener('click',e=>{ if(e.target.closest('#c-feel-launch'))feelLaunch(); });
// The board drives the lab: try a tick, a rocket, a lander or Standby without touching real data.
if(LAB)addEventListener('message',e=>{ const m=e.data; if(e.origin!==location.origin||m?.type!=='meridian-feel')return;
  if(m.act==='launch')feelLaunch(); else if(m.act==='land')Feel.land();
  else if(m.act==='rocket'){ const row=document.querySelector('#h-todo .row.todo'); if(row)Feel.rocket(row.querySelector('.tick')||row,$('agentstrip')?.hidden===false?$('agentstrip'):{x:innerWidth/2,y:innerHeight+30},{label:row.querySelector('.t')?.textContent}); }
  else if(m.act==='lander'){ const row=document.querySelector('#h-todo .row.todo'); if(!Feel.lander(row||{x:innerWidth/2,y:innerHeight/2},{label:'Done'}))Feel.play('chime'); }
  else if(m.act==='tick'){ const row=document.querySelector('#h-todo .row.todo:not(.feel-done)'); if(row)Feel.done(row.querySelector('.tick'),row.querySelector('.t')).then(()=>setTimeout(()=>Feel.undone(row.querySelector('.tick'),row.querySelector('.t')),1400)); }
});
if(FEEL()&&new URLSearchParams(location.search).has('standby'))setTimeout(feelLaunch,800);
window.feelReady=true; feelApply();

/* ---------- shortcuts from anywhere (Mac app) ---------- */
const SHORTCUTS=[
  {id:'toggle',label:'Show or hide Meridian',hint:'From any app'},
  {id:'todos',label:'Quick to-dos',hint:'A small window with just your to-dos'},
  {id:'saveLink',label:'Save the page you’re on',hint:'Copies its link and adds it to the Shelf'},
];
// The side panel's shortcuts inside Meridian (app 1.3.1). Recorded the same way, saved as key.<id>.
const PANEL_KEYS=[
  {id:'panel',label:'Show or hide the side panel',hint:'On the tab you used last'},
  {id:'terminal',label:'Show or hide the terminal',hint:'Opens one if there isn’t one'},
  {id:'newTerminal',label:'New terminal',hint:'Another shell beside the others'},
  {id:'newTab',label:'New browser tab',hint:'With the address ready to type'},
  {id:'nextTab',label:'Next tab',hint:'In the side panel'},
  {id:'prevTab',label:'Previous tab',hint:'In the side panel'},
  {id:'copyURL',label:'Copy the page’s address',hint:'From the side panel’s browser tab'},
];
const KEY_CODES={Space:'space',Enter:'return',Tab:'tab',Backquote:'`',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',Semicolon:';',Quote:"'",Comma:',',Period:'.',Slash:'/',Backslash:'\\'};
// From the physical key (e.code), because ⌥ changes e.key into symbols.
function specFromEvent(e){
  const c=e.code||''; const k=/^Key[A-Z]$/.test(c)?c.slice(3).toLowerCase():/^Digit\d$/.test(c)?c.slice(5):/^F\d{1,2}$/.test(c)?c.toLowerCase():KEY_CODES[c];
  if(!k)return null;
  const m=[e.ctrlKey&&'ctrl',e.altKey&&'opt',e.shiftKey&&'shift',e.metaKey&&'cmd'].filter(Boolean);
  if(!m.length&&!/^f\d/.test(k))return null;
  return [...(m.length===4?['hyper']:m),k].join('+');
}
function keyLabel(spec){
  if(!spec||spec==='off')return 'Off';
  const parts=String(spec).split('+'); const k=parts.pop(); const sym={ctrl:'⌃',opt:'⌥',shift:'⇧',cmd:'⌘'};
  const mods=parts.includes('hyper')?'Hyper ':parts.map(p=>sym[p]||'').join('');
  return mods+({space:'Space',return:'↵',enter:'↵',tab:'⇥',escape:'Esc'}[k]||k.toUpperCase());
}
const appShortcuts=()=>{ const st=window.MeridianApp?.settings||{}; return st.shortcuts||{toggle:st.hotkey||'off'}; };
let recording=null, recordT=0;
async function startRecord(id){
  const A=window.MeridianApp; if(!A?.recordShortcuts)return;
  recording=id; renderKeys(); try{ await A.recordShortcuts(true); }catch{}
  clearTimeout(recordT); recordT=setTimeout(()=>{ if(recording)stopRecord(); },15000);
}
async function stopRecord(){ clearTimeout(recordT); recording=null; try{ await window.MeridianApp?.recordShortcuts?.(false); }catch{} if(keysOpen())renderKeys(); }
async function setShortcut(id,spec){
  const A=window.MeridianApp; const pk=id.startsWith('p:'); const s=pk?PANEL_KEYS.find(x=>'p:'+x.id===id):SHORTCUTS.find(x=>x.id===id);
  try{ await A.set(pk?'key.'+id.slice(2):'shortcut.'+id,spec); toast(spec==='off'?`${s.label}: off`:`${s.label}: ${keyLabel(spec)}`); }
  catch(err){ toast(String(err?.message||err)); document.querySelector(`[data-sc="${id}"] .kbtn`)?.classList.add('bad'); }
}
// While recording, every key goes to the recorder first, before the page's own shortcuts.
document.addEventListener('keydown',e=>{
  if(!recording)return;
  if(!keysOpen()){ stopRecord(); return; }
  e.preventDefault(); e.stopImmediatePropagation();
  if(['Shift','Control','Alt','Meta','CapsLock','Fn'].includes(e.key))return;
  const id=recording;
  if(e.key==='Escape'&&!e.ctrlKey&&!e.altKey&&!e.metaKey){ stopRecord(); return; }
  if((e.key==='Backspace'||e.key==='Delete')&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey){ stopRecord().then(()=>setShortcut(id,'off')).then(()=>keysOpen()&&renderKeys()); return; }
  const spec=specFromEvent(e);
  if(!spec){ const b=document.querySelector(`[data-sc="${id}"] .kbtn`); if(b){ b.textContent='Add ⌘, ⌥, ⌃ or Hyper'; } return; }
  stopRecord().then(()=>setShortcut(id,spec)).then(()=>keysOpen()&&renderKeys());
},true);
addEventListener('blur',()=>{ if(recording)stopRecord(); });
// Closing the sheet (its button, the scrim, Esc) ends either kind of recording, so the next key you type isn't taken as a shortcut.
document.addEventListener('overlays-closed',()=>{ pageRec=null; if(recording)stopRecord(); });
const keysOpen=()=>$('sheet-keys').classList.contains('on');

/* ---------- web tabs in the sidebar (lab) ---------- */
// Pages kept from the Mac app's browser pane. They open beside the dashboard.
let browserNow=null;
const webTabsOn=()=>!!prefs.labs?.webTabs&&!!window.MeridianApp?.browse;
function webFav(u){ try{ const h=new URL(u).hostname; return /\.ts\.net$|^(127\.|localhost|100\.)/.test(h)?'':`https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=64`; }catch{ return ''; } }
function renderWebTabs(){
  const on=webTabsOn(); const list=on?(prefs.webTabs||[]):[];
  $('web-h').hidden=!on; $('side-web').hidden=!on;
  if(!on)return;
  $('side-web').innerHTML=list.map((t,i)=>{ const f=webFav(t.url); const mono=esc((t.title||hostOf(t.url)).trim().charAt(0).toUpperCase());
    return `<button type="button" class="tab wtab${browserNow?.open&&browserNow.url===t.url?' on':''}" data-wt="${i}" data-tip="${esc(t.title||hostOf(t.url))}|${esc(hostOf(t.url))}">${f?`<img class="wfav" alt="" src="${esc(f)}" data-mono="${mono}" onerror="monoFallback(this)">`:`<span class="mono-mark wfav">${mono}</span>`}<span class="lbl">${esc(t.title||hostOf(t.url))}</span><span class="wx" data-wt-x="${i}" aria-label="Remove">${icon('close')}</span></button>`; }).join('')
    ||'<div class="sl dim">Press Keep in the browser pane to put a page here.</div>';
}
$('side-web').addEventListener('click',e=>{ const x=e.target.closest('[data-wt-x]'); const list=prefs.webTabs||[];
  if(x){ e.stopPropagation(); const t=list[Number(x.dataset.wtX)]; prefs.webTabs=list.filter(v=>v!==t); savePrefs(); renderWebTabs(); toast('Removed from the sidebar',{undo:()=>{ prefs.webTabs=[t,...(prefs.webTabs||[])]; savePrefs(); renderWebTabs(); }}); return; }
  const b=e.target.closest('[data-wt]'); if(b)openUrl(list[Number(b.dataset.wt)].url,e,'split'); });
$('side-web').addEventListener('contextmenu',e=>{ const b=e.target.closest('[data-wt]'); if(!b)return; e.preventDefault(); const t=(prefs.webTabs||[])[Number(b.dataset.wt)];
  menu(e.clientX,e.clientY,[{label:'Open beside',icon:'sidebar',act:()=>openUrl(t.url,null,'split')},{label:'Peek',icon:'eye',act:()=>openUrl(t.url,null,'peek')},{label:'Open in your browser',icon:'out',act:()=>openUrl(t.url,null,'browser')},'hr',{label:'Remove',icon:'trash',danger:true,act:()=>{ prefs.webTabs=(prefs.webTabs||[]).filter(v=>v!==t); savePrefs(); renderWebTabs(); }}]); });
window.__meridianBrowserKeep=({url,title}={})=>{
  if(!url)return; if(!prefs.labs?.webTabs){ toast('Turn on web tabs in Customise to keep pages in the sidebar'); return; }
  prefs.webTabs=[{url,title:title||hostOf(url),added:Date.now()},...(prefs.webTabs||[]).filter(t=>t.url!==url)].slice(0,12); savePrefs(); renderWebTabs(); toast('Kept in the sidebar');
};
addEventListener('meridianbrowser',e=>{ browserNow=e.detail||null; if(webTabsOn())renderWebTabs(); });

/* ---------- browser and terminal (the Mac app's side panel, 1.3) ---------- */
// The panel's tabs live in its own strip. The page has one button for it, top right, the mirror of the sidebar's:
// it shows the panel on the tab you used last (or a new one). T and B do the same from the keyboard.
const panelOn=()=>!!window.MeridianApp?.panel;
const panelCall=(action,o)=>Promise.resolve(window.MeridianApp.panel(action,o)).catch(err=>toast(String(err?.message||err)));
const panelKey=(n)=>{ const v=window.MeridianApp?.settings?.panelKeys?.[n]; return v&&v!=='off'?keyLabel(v):''; };
function renderPanelBtn(){ const b=$('panel-btn'); b.hidden=!panelOn(); if(b.hidden)return; b.dataset.tip=`Show the side panel|${[panelKey('panel'),'browser and terminal'].filter(Boolean).join(' · ')}`; }
$('panel-btn').addEventListener('click',()=>panelCall('toggle'));
addEventListener('meridianapp',renderPanelBtn); renderPanelBtn();

/* ---------- demo mode ---------- */
// Reload rather than assign location.href: the address always ends in #view, and assigning the same address with a
// hash only jumps to the fragment, so the switch was saved but never took effect until the next reload.
function setDemo(on){ try{ on?localStorage.setItem('meridian.demo','1'):localStorage.removeItem('meridian.demo'); }catch{}
  const u=new URL(location.href); u.searchParams.delete('demo'); history.replaceState(history.state,'',u.href);
  document.body.classList.add('demo-swap'); setTimeout(()=>location.reload(),140); }
if(DEMO){ root.dataset.demo='1'; $('demo-tag').hidden=false; }
$('demo-tag').addEventListener('click',()=>setDemo(false));

/* ---------- more of Customise: Spaces, the strip, labs, demo ---------- */
// One Space open at a time: a proper name field, a palette (or any colour), and its Shelf groups.
// Opening a Space switches to it, so its colour and glow show in the sidebar while you edit it.
function spacesEditor(){
  const cats=[...new Set([...(links.categories||[]),...(links.links||[]).map(l=>l.category)])].filter(Boolean); const list=spaceList();
  const ownCol=(c)=>!ACCENTS.some(a=>a.hex===String(c).toLowerCase());
  return `<div class="opt-g" id="c-spaces" style="margin-top:6px"><label>Your Spaces</label>${list.map(s=>{ const open=spOpen===s.id; const n=(s.groups||[]).length;
    return `<div class="sp-ed${open?' open':''}" data-sp="${esc(s.id)}">
      <button type="button" class="sp-head" data-sp-open aria-expanded="${open}"><i class="sp-dot" style="background:${esc(s.color)}"></i><b>${esc(s.name)}</b><span class="sp-n">${n?`${n} group${n>1?'s':''}`:'No groups yet'}</span>${icon('chev','sp-chev')}</button>
      ${open?`<div class="sp-body">
        <div class="sp-f"><label for="sp-n-${esc(s.id)}">Name</label><input id="sp-n-${esc(s.id)}" class="sp-name" data-sp-name value="${esc(s.name)}" maxlength="24" autocomplete="off" spellcheck="false"></div>
        <div class="sp-f"><label>Colour</label><div class="swatch-row">${ACCENTS.map(a=>`<button type="button" class="swatch" data-sp-col="${a.hex}" data-tip="${a.name}" aria-label="${a.name}" aria-pressed="${String(s.color).toLowerCase()===a.hex}" style="background:${a.hex}"></button>`).join('')}<button type="button" class="swatch sp-own${ownCol(s.color)?' on':''}" data-sp-pick data-tip="Any colour|Pick one or type a hex code" aria-label="Pick any colour"${ownCol(s.color)?` style="background:${esc(s.color)}"`:''}>${icon('plus')}</button></div></div>
        <div class="sp-f"><label>Shelf groups in it</label><div class="sp-groups">${cats.map(c=>{ const owner=list.find(x=>(x.groups||[]).includes(c)); const mine=owner?.id===s.id; return `<button type="button" class="chipb${mine?' on':''}" data-sp-group="${esc(c)}" aria-pressed="${mine}"${owner&&!mine?` data-tip="In ${esc(owner.name)} now|Click to move it here"`:''}>${esc(c)}</button>`; }).join('')}</div></div>
        <div class="sp-foot"><button type="button" class="btn sm ghost danger" data-sp-del>${icon('trash')}Remove ${esc(s.name)}</button></div>
      </div>`:''}</div>`; }).join('')}
    <button type="button" class="btn sm ghost" id="c-sp-add">${icon('plus')}Add a Space</button>
    <p class="hint">Each Space has its own top shelf and glow. Switch with ⌃1–${list.length+1}, a two-finger swipe on the sidebar, or the Space buttons.</p></div>`;
}
function moreCustom(){
  const cseg=(key,opts,cur)=>`<div class="seg" data-ckey="${key}">${opts.map(([v,l])=>`<button type="button" data-v="${v}" aria-pressed="${String(v)===String(cur)}">${l}</button>`).join('')}</div>`;
  return `<div class="opt-g" style="margin-top:6px"><label>Keyboard shortcuts</label><button type="button" class="btn ghost" id="c-keys">${icon('keys')}See and change shortcuts</button><p class="hint">They have their own sheet, with search. Press ? from anywhere.</p></div>`
    +`<div class="opt-g"><label>Agents strip</label>${cseg('strip',[['auto','When working'],['always','Always'],['off','Off']],prefs.strip||'auto')}<p class="hint">A slim bar along the bottom showing which agents are working right now.</p></div>`
    +`<div class="opt-g"><label>Accounts and calendars</label><a class="btn ghost" href="/connect${esc(location.search)}">${icon('globe')}Open Connect</a><p class="hint">What Meridian can see, your calendars and class timetable, and anything not set up yet.</p></div>`
    +`<div class="opt-g"><label>Demo mode</label>${cseg('demo',[['off','Off'],['on','On']],DEMO?'on':'off')}<p class="hint">Made-up data for screen recordings. Only on this device, and nothing you do in it is saved. ${esc(pageKeyLabel(pageKey('demo')))} switches it from anywhere, and the Demo badge in the sidebar turns it off.</p></div>`;
}
function labsSection(){
  if(!window.MeridianApp?.browse)return '';
  const on=!!prefs.labs?.webTabs;
  return `<div class="opt-g"><label>Labs: web tabs in the sidebar</label><div class="seg" data-ckey="webTabs"><button type="button" data-v="off" aria-pressed="${!on}">Off</button><button type="button" data-v="on" aria-pressed="${on}">On</button></div><p class="hint">An experiment. Keep a page from the browser pane (⌘↵) and it sits under your tabs, opening beside the dashboard.</p></div>`;
}
async function notifLine(){
  const A=window.MeridianApp, el=$('c-notif'); if(!el||!A?.notifications)return;
  try{ const r=await A.notifications(); el.textContent={authorized:'Allowed',provisional:'Allowed quietly',denied:'Turned off in System Settings → Notifications',notDetermined:'Not asked yet. Send a test to allow them'}[r?.status]||String(r?.status||'Unknown'); el.dataset.st=r?.status||''; }catch{ el.textContent='Unknown'; }
}
$('custom-body').addEventListener('click',async e=>{
  if(e.target.closest('#c-brief-now')){ try{ await window.MeridianApp.showBriefPopup(); }catch(err){ toast(String(err?.message||err)); } return; }
  if(e.target.closest('#c-notif-test')){ try{ await window.MeridianApp.testNotification(); toast('Sent. It should appear in a moment.'); }catch(err){ toast(String(err?.message||err)); } setTimeout(notifLine,1200); return; }
  const cs=e.target.closest('.seg[data-ckey] [data-v]'); if(cs){ const k=cs.closest('.seg').dataset.ckey, v=cs.dataset.v;
    if(k==='strip'){ prefs.strip=v; savePrefs(); stripSig=''; renderStrip(); renderCustom(); }
    if(k==='demo'){ if((v==='on')!==DEMO)setDemo(v==='on'); }
    if(k==='webTabs'){ prefs.labs={...(prefs.labs||{}),webTabs:v==='on'}; savePrefs(); renderWebTabs(); try{ await window.MeridianApp?.set?.('webTabs',v==='on'); }catch{} renderCustom(); }
    return; }
  const ed=e.target.closest('.sp-ed'); const list=spaceList();
  if(DEMO&&(ed||e.target.closest('#c-sp-add'))){ toast('Spaces can’t be changed in demo mode'); return; }
  if(e.target.closest('#c-sp-add')){ const used=new Set(list.map(s=>s.color)); const c=(ACCENTS.find(a=>!used.has(a.hex))||ACCENTS[0]).hex; const id='s'+Date.now().toString(36);
    prefs.spaces.list=[...list,{id,name:'New space',color:c,groups:[]}]; spOpen=id; savePrefs(); setSpace(id,{quiet:true}); renderCustom(); renderSide(); setTimeout(()=>{ const inp=document.querySelector('.sp-ed.open .sp-name'); inp?.focus(); inp?.select(); },40); return; }
  if(!ed)return; const sp=list.find(s=>s.id===ed.dataset.sp); if(!sp)return;
  if(e.target.closest('[data-sp-open]')){ spOpen=spOpen===sp.id?null:sp.id; if(spOpen)setSpace(sp.id,{quiet:true}); renderCustom(); return; }
  // Any colour: the picker changes the Space as you drag, and the whole visit is one undo step.
  const pk=e.target.closest('[data-sp-pick]'); if(pk){ const before=prefsSnap(), label=`${sp.name} Space colour`;
    openColourPicker(pk,sp.color,{onInput:(hx)=>{ sp.color=hx; ed.querySelector('.sp-dot').style.background=hx; pk.classList.add('on'); pk.style.background=hx; ed.querySelectorAll('[data-sp-col]').forEach(b=>b.setAttribute('aria-pressed','false')); savePrefs(); applyTint(); sideSig=''; renderSide(); },
      onDone:()=>{ const after=prefsSnap(); if(after!==before)histPush({before,after,label}); if(customOpen())renderCustom(); }}); return; }
  const col=e.target.closest('[data-sp-col]'); if(col){ sp.color=col.dataset.spCol; savePrefs(); applyTint(); renderCustom(); sideSig=''; renderSide(); return; }
  const g=e.target.closest('[data-sp-group]'); if(g){ const c=g.dataset.spGroup; const mine=(sp.groups||[]).includes(c);
    list.forEach(s=>{ s.groups=(s.groups||[]).filter(x=>x!==c); }); if(!mine)sp.groups.push(c); savePrefs(); renderCustom(); sideSig=''; renderSide(); shelfSig=''; homeShelfSig=''; VIEWS[view]?.update?.(true); return; }
  if(e.target.closest('[data-sp-del]')){ const before=prefs.spaces.list.slice(); prefs.spaces.list=list.filter(s=>s!==sp); spOpen=null; if(spaceId===sp.id)setSpace('all',{quiet:true}); savePrefs(); renderCustom(); sideSig=''; renderSide(); toast(`Removed ${sp.name}`,{undo:()=>{ prefs.spaces.list=before; savePrefs(); renderCustom(); sideSig=''; renderSide(); }}); }
});
// Names change as you type, without redrawing the drawer.
const spOf=(el)=>spaceList().find(s=>s.id===el.closest('.sp-ed')?.dataset.sp);
$('custom-body').addEventListener('input',e=>{ if(DEMO)return;
  const n=e.target.closest('[data-sp-name]'); if(n){ const sp=spOf(n); const v=n.value.trim(); if(sp&&v){ sp.name=v; n.closest('.sp-ed').querySelector('.sp-head b').textContent=v; savePrefs(); sideSig=''; renderSide(); } return; }
});
$('custom-body').addEventListener('change',e=>{ const n=e.target.closest('[data-sp-name]'); if(n){ const sp=spOf(n); if(sp&&!n.value.trim())n.value=sp.name; } });
$('custom-body').addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.closest('[data-sp-name]')){ e.preventDefault(); e.target.blur(); } });

/* ---------- shortcuts sheet ---------- */
// Built from the live settings, so a changed shortcut shows as it is now. The search matches what a shortcut
// does, its group or its keys ("terminal", "tab", "⌘").
function keyGroups(){
  const A=window.MeridianApp; const sc=appShortcuts(); const n=spacesOn()?spaceList().length:0;
  // Rows: [label, keys, plain text?, id]. An id makes the row changeable: "pg:" for the dashboard's own, "p:" for the
  // side panel's, and a bare id for the Mac app's keys that work from any app.
  const page=(g)=>PAGE_KEYS.filter(x=>x.g===g&&!x.app).map(x=>[x.label,pageKey(x.id),false,'pg:'+x.id]);
  const g=[
    {t:'Get around',reset:'page',rows:[...page('Get around'),['Go to tab','1 – 9'],['Tab switcher','⌥ Tab'],
      ...(n?[['All, then each Space','⌃1 – ⌃'+(n+1)],['Next or previous Space','swipe on the sidebar',true]]:[])]},
    {t:'Do things',rows:[...page('Do things'),['Add a URL','paste it anywhere',true],['Close anything','Esc']]},
    {t:'Settings',rows:page('Settings')},
  ];
  // The Mac app's keys are listed in a browser too, so you know they're there.
  const PANEL_DEFAULTS={panel:'⌥⌘B',terminal:'⌃`',newTerminal:'⌃⇧`',newTab:'⌘T',nextTab:'⌘⇧]',prevTab:'⌘⇧[',copyURL:'⌘⇧C'};
  const extra=[['Close the tab','⌘W'],['Peek or beside the page','⌘\\'],['Fill the window','⌘⇧↵'],['Edit the address','⌘L'],['Open an address in a Peek','⌘⇧O'],['Clear the terminal','⌘K'],['Jump a word in the terminal','⌥← ⌥→']];
  if(A?.panel){ const pk=A.settings?.panelKeys||{};
    g.push({t:'Side panel',reset:'panel',rows:[...PANEL_KEYS.map(s=>[s.label,pk[s.id]||'off',false,'p:'+s.id]),...PAGE_KEYS.filter(x=>x.app).map(x=>[x.label,pageKey(x.id),false,'pg:'+x.id]),...extra]}); }
  else if(A?.browse)g.push({t:'Browser',rows:[['Peek or beside the page','⌘\\'],['Fill the window','⌘⇧↵'],['Close the browser','⌘W'],['Open an address','⌘⇧O']]});
  else g.push({t:'Side panel',app:true,rows:[...PANEL_KEYS.map(s=>[s.label,PANEL_DEFAULTS[s.id]||'']),['Terminal (on the dashboard)','T'],['Browser (on the dashboard)','B'],...extra]});
  if(A)g.push({t:'From any app',reset:A.recordShortcuts?'global':'',rows:SHORTCUTS.map(s=>A.recordShortcuts?[s.label,sc[s.id]||'off',false,s.id]:[s.label,keyLabel(sc[s.id])])});
  else g.push({t:'From any app',app:true,rows:SHORTCUTS.map(s=>[s.label,keyLabel(GLOBAL_DEFAULTS[s.id])])});
  return g;
}
// The sheet is where shortcuts are changed: click a key, press the new one (Esc cancels, ⌫ turns it off).
// Putting a group back to its defaults asks first, in place.
const GLOBAL_DEFAULTS={toggle:'opt+x',todos:'hyper+t',saveLink:'hyper+c'};
let keysConfirm='';
function keyCell(id,spec){
  const pg=id.startsWith('pg:'); const rec=pg?pageRec===id.slice(3):recording===id, off=spec==='off';
  return `<span class="kedit">${!off&&!rec?`<button type="button" class="kx" data-sc-off="${esc(id)}" data-tip="Turn this shortcut off" aria-label="Turn off">${icon('close')}</button>`:''}<button type="button" class="kbtn${rec?' rec':''}${off&&!rec?' off':''}" aria-label="${esc(rec?'Press the new keys…':(pg?pageKeyLabel(spec):keyLabel(spec)))}: change this shortcut">${rec?'Press the new keys…':esc(pg?pageKeyLabel(spec):keyLabel(spec))}</button>${rec?'':`<span class="kpen">${icon('edit')}</span>`}</span>`;
}
function resetLine(g){
  if(!g.reset)return '';
  if(keysConfirm!==g.reset)return `<button type="button" class="keys-edit" data-keys-reset="${g.reset}">Reset to defaults</button>`;
  const what=g.reset==='panel'?`all ${PANEL_KEYS.length}`:g.reset==='page'?'every Meridian shortcut':`to ${Object.values(GLOBAL_DEFAULTS).map(keyLabel).join(', ')}`;
  return `<span class="keys-confirm">Put ${what} back?<button type="button" class="keys-edit danger" data-keys-reset-yes="${g.reset}">Reset</button><button type="button" class="keys-edit" data-keys-reset-no>Cancel</button></span>`;
}
function renderKeys(){
  const q=($('keys-q').value||'').trim().toLowerCase();
  const html=keyGroups().map(g=>{ const rows=g.rows.filter(([l,k,,id])=>!q||(g.t+' '+l+' '+(id?keyLabel(k):k)).toLowerCase().includes(q));
    if(!rows.length)return '';
    return `<h4><span>${esc(g.t)}${g.app?'<small>In the Mac app</small>':''}</span>${resetLine(g)}</h4><div class="keys-grid${g.app?' app':''}">${rows.map(([l,k,plain,id])=>`<div${id?` class="kr" data-sc="${esc(id)}" data-tip="Click to change|Then press the new keys. Esc cancels, ⌫ turns it off"`:''}>${esc(l)} ${id?keyCell(id,k):plain?`<span class="dim">${esc(k)}</span>`:`<kbd>${esc(k)}</kbd>`}</div>`).join('')}</div>`; }).join('');
  $('keys-list').innerHTML=html||`<p class="dim keys-none">No shortcut matches “${esc(q)}”.</p>`;
}
function openKeys(){ keysConfirm=''; pageRec=null; $('keys-q').value=''; renderKeys(); openSheet('sheet-keys'); setTimeout(()=>$('keys-q').focus(),60); }
$('keys-q').addEventListener('input',renderKeys);
$('keys-q').addEventListener('keydown',e=>{ if(e.key==='Escape'&&e.target.value){ e.stopPropagation(); e.target.value=''; renderKeys(); } });
$('keys-list').addEventListener('click',async e=>{
  const A=window.MeridianApp;
  const off=e.target.closest('[data-sc-off]'); if(off){ const id=off.dataset.scOff; if(id.startsWith('pg:')){ prefs.keys={...(prefs.keys||{}),[id.slice(3)]:'off'}; savePrefs(); } else await setShortcut(id,'off'); renderKeys(); return; }
  const sc=e.target.closest('[data-sc]'); if(sc){ const id=sc.dataset.sc;
    if(id.startsWith('pg:')){ pageRec===id.slice(3)?(pageRec=null,renderKeys()):startPageRec(id.slice(3)); return; }
    pageRec=null; recording===id?stopRecord():startRecord(id); return; }
  const r=e.target.closest('[data-keys-reset]'); if(r){ keysConfirm=r.dataset.keysReset; renderKeys(); return; }
  if(e.target.closest('[data-keys-reset-no]')){ keysConfirm=''; renderKeys(); return; }
  const y=e.target.closest('[data-keys-reset-yes]'); if(!y)return; keysConfirm='';
  if(y.dataset.keysResetYes==='page'){ const was=prefs.keys; prefs.keys={}; savePrefs(); renderKeys(); toast('Meridian shortcuts are back to the defaults',{undo:()=>{ prefs.keys=was; savePrefs(); renderKeys(); }}); return; }
  if(!A)return;
  if(y.dataset.keysResetYes==='panel'){ try{ await A.set('panelKeys','default'); toast('Side panel shortcuts are back to the defaults'); }catch(err){ toast(String(err?.message||err)); } }
  else{ const errs=[]; for(const [id,spec] of Object.entries(GLOBAL_DEFAULTS)){ try{ await A.set('shortcut.'+id,spec); }catch(err){ errs.push(String(err?.message||err)); } }
    toast(errs.length?errs[0]:'Shortcuts from any app are back to the defaults'); }
  renderKeys();
});
addEventListener('meridianapp',()=>{ if($('sheet-keys').classList.contains('on'))renderKeys(); });

/* ---------- boot ---------- */
renderSide();
route();
// State carries the shelf already; older or offline daemons still get the separate read.
loadState().then(ok=>{ if(!ok||!state?.links)loadLinks(); stream(); });
loadLedger(); loadAlmanac(); syncPrefsFromServer(); loadEngines(); if(view!=='stash')loadStash();
setInterval(()=>{ if(!document.hidden)loadLedger(); },10*60000); setInterval(loadAlmanac,30*60000);
setInterval(()=>{ if(view==='dogfood'||view==='home')VIEWS[view].update(); },60000);
