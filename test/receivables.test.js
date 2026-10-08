'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../receivables');
const at = '2026-10-04T17:00:00.000Z';
const old = { id:'salary-old', name:'Example Agency', counterpartyId:'bank-employer', category:'Income', amount:1800, date:'2026-09-28', time:'12:00', currency:'GBP', status:'posted', type:'Faster payment' };
const credit = (overrides={}) => ({ id:'repayment-new', name:'Example Agency', counterpartyId:'bank-employer', amount:80.50, date:'2026-10-05', time:'12:00', currency:'GBP', status:'posted', type:'Faster payment', firstSeenAt:'2026-10-05T12:01:00Z', ...overrides });
const approved = { version: 'fixture-v1', claims: [
 { key: 'fixture-person', who: 'Taylor Reed', amount: 40.25, note: 'Synthetic repayment', senderNames: ['taylor reed'] },
 { key: 'fixture-expenses', who: 'Example Agency expenses', amount: 80.50, note: 'Synthetic expenses, awaiting submission', senderNames: ['example agency'], category: 'Income' },
] };
function fixture(){ const d={claims:[]}; R.create(d,{who:'Employer expenses',amount:80.50,senderId:old.counterpartyId},[old],at); return d; }
test('approved claims deduplicate, stay unpaid and resolve only actual bank IDs',()=>{
 const d={claims:[]}; R.seed(d,[old,{...old,id:'dad-history',name:'Taylor Reed',counterpartyId:'bank-father'}],at,approved); R.seed(d,[old],at,approved);
 assert.equal(d.claims.length,2); assert.deepEqual(d.claims.map(c=>[c.amount,c.settled]),[[40.25,false],[80.50,false]]);
 assert.equal(d.claims[0].sender.id,'bank-father'); assert.equal(d.claims[1].sender.id,'bank-employer'); assert.match(d.claims[1].note,/awaiting submission/);
 const unverified={claims:[]};R.seed(unverified,[{...old,counterpartyId:undefined}],at,approved);assert.equal(unverified.claims[1].sender,null);
 const ambiguous={claims:[]};R.seed(ambiguous,[old,{...old,id:'salary-two',counterpartyId:'second-bank-id'}],at,approved);assert.equal(ambiguous.claims[1].sender,null);
});
test('one exact verified new posted transfer settles with audit; repeat is idempotent and undo reserves the credit',()=>{
 const d=fixture();R.reconcile(d,[old,credit()]);const c=d.claims[0];assert.equal(c.settled,true);assert.equal(c.matchedTransactionId,'repayment-new');assert.equal(c.history.length,1);
 R.reconcile(d,[credit()]);assert.equal(c.history.length,1);R.act(d,{id:c.id,action:'undo'},[], '2026-10-06T12:00:00Z');assert.equal(c.settled,false);assert.equal(c.matchedTransactionId,undefined);
 R.reconcile(d,[credit()]);assert.equal(c.settled,false);assert.equal(c.history.length,2);
 R.create(d,{who:'Another claim',amount:80.50,senderId:old.counterpartyId},[old],at);R.reconcile(d,[credit()]);assert.equal(d.claims[1].settled,false,'undone credit cannot pay another claim');
});
test('historical, baseline, missing import time, same-minute and pre-creation payments never clear claims',()=>{
 for(const t of [credit({date:'2026-09-01'}),credit({id:old.id}),credit({firstSeenAt:undefined}),credit({date:'2026-10-04',time:'17:00'}),credit({firstSeenAt:at})]){const d=fixture();R.reconcile(d,[t]);assert.equal(d.claims[0].settled,false);}
});
test('wrong sender, partial amount, non-GBP, pending, refunds and ordinary salary require review',()=>{
 for(const changes of [{counterpartyId:'other'},{counterpartyId:undefined},{amount:80.49},{amount:95},{currency:'USD'},{currency:undefined},{status:'pending'},{status:undefined},{type:'Card payment'},{salary:true},{notes:'Monthly payroll'}]){ const d=fixture();R.reconcile(d,[credit(changes)]);assert.equal(d.claims[0].settled,false,JSON.stringify(changes));assert.ok(d.claims[0].review.length);}
 const d=fixture();R.reconcile(d,[credit({amount:1800,salary:true})]);assert.equal(d.claims[0].settled,false);
});
test('multiple claims, unverified alternative, multiple transfers and existing splits do not silently settle',()=>{
 let d=fixture();R.create(d,{who:'Other',amount:80.50,senderId:old.counterpartyId},[old],at);R.reconcile(d,[credit()]);assert.ok(d.claims.every(c=>!c.settled));
 d=fixture();R.create(d,{who:'Unverified',amount:80.50},[old],at);R.reconcile(d,[credit()]);assert.ok(d.claims.every(c=>!c.settled));
 d=fixture();R.reconcile(d,[credit(),credit({id:'second'})]);assert.equal(d.claims[0].settled,false);
 d=fixture();R.reconcile(d,[credit()],{tx:{purchase:{split:[{who:'Example Agency',amount:80.50,settled:false}]}}});assert.equal(d.claims[0].settled,false);
});
test('manual settlement, undo, verified linking and validation',()=>{
 const d=fixture(); const c=d.claims[0];R.act(d,{id:c.id,action:'settle'},[],at);R.act(d,{id:c.id,action:'settle'},[],at);assert.equal(c.history.length,1);R.act(d,{id:c.id,action:'undo'},[],at);assert.equal(c.settled,false);
 assert.throws(()=>R.act(d,{id:c.id,action:'link',senderId:'invented'},[old],at));R.act(d,{id:c.id,action:'link',senderId:old.counterpartyId},[old],at);assert.equal(c.sender.id,old.counterpartyId);
 assert.throws(()=>R.create(d,{who:'X',amount:-5},[],at));assert.throws(()=>R.create(d,{who:'X',amount:5,senderId:'invented'},[],at));
});

test('Owed to you renders standalone amounts, existing splits, verification, review and undo',()=>{
 const fs=require('node:fs'), vm=require('node:vm'); const source=fs.readFileSync(require('node:path').join(__dirname,'../public/command.js'),'utf8');
 const code=source.slice(source.indexOf('function owedHTML(P){'),source.indexOf('function openTxSheet(id)'));
 const sandbox={MN:{data:{receivables:[{id:'dad',who:'Dad / Taylor Reed',amount:40.25,note:'Confirmed',settled:false,sender:null,review:[{transactionId:'check',reason:'Sender unverified'}]},{id:'expenses',who:'Example Agency expenses',amount:80.50,note:'awaiting submission',settled:true,sender:{name:'Employer'},matchedTransactionId:'repayment'}]}},icon:()=>'',esc:x=>String(x||''),amt:x=>Number(x).toFixed(2),cap:x=>x,shortDate:()=>'',Date};
 vm.createContext(sandbox);vm.runInContext(code,sandbox);
 const html=sandbox.owedHTML([{id:'purchase',date:'2026-09-14',name:'Present',split:[{who:'Casey',amount:22.4},{who:'Morgan',amount:22.4}]}]);
 for(const word of ['Dad / Taylor Reed','40.25','80.50','Casey','Morgan','85.05','Add claim','Link sender','Undo','awaiting submission','repayment','Sender unverified'])assert.ok(html.includes(word),word);
});

test('approved bootstrap runs once and respects removed claims and manual settlement',()=>{
 const doc={claims:[]};R.seed(doc,[old],at,approved);const id=doc.claims[0].id;R.act(doc,{id,action:'settle'},[],at);R.seed(doc,[old],at,approved);assert.equal(doc.claims[0].settled,true);
 doc.claims.splice(1,1);R.seed(doc,[old],at,approved);assert.equal(doc.claims.length,1,'removed expense claim is not re-created');
 assert.equal(doc.approvedSeedVersion,'fixture-v1');
});

test('import records first observation, persists a verified new match and cannot match it again after a daemon reload',async()=>{
 const fs=require('node:fs'), os=require('node:os'), path=require('node:path'); const {createMoney,writeJson}=require('../money');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meridian-claims-import-'));let clock=Date.parse(at);
 const header=['Transaction ID','Date','Time','Type','Name','Category','Amount','Currency','Counterparty ID','Status'];
 let rows=[header,['old','2026-09-28','12:00','Faster payment','Employer','Income',1800,'GBP','bank-employer','posted']];
 const request=async url=>url.includes('oauth2')?{status:200,json:{access_token:'fixture',expires_in:3600}}:url.includes('/values/')?{status:200,json:{values:rows}}:{status:200,json:{sheets:[{properties:{title:'Personal Account Transactions'}}]}};
 const money=createMoney({dir,now:()=>clock,request,wait:async()=>{}});
 try {
  await writeJson(money.files('credentials'),{google:{client_id:'fixture',client_secret:'fixture',refresh_token:'fixture'}});
  await writeJson(money.files('settings'),{monzo:{sheetId:'fixture'}});
  await money.pullMonzo();const baseline=(await money.bundle()).monzo.transactions;const doc={claims:[]};R.create(doc,{who:'Expenses',amount:80.50,senderId:'bank-employer'},baseline,at);await writeJson(money.files('receivables'),doc);
  clock=Date.parse('2026-10-05T12:01:00Z');rows.push(['new','2026-10-05','12:00','Faster payment','Employer','Income',80.50,'GBP','bank-employer','posted']);
  await money.pullMonzo();let bundle=await money.bundle();assert.equal(bundle.receivables[0].settled,true);assert.equal(bundle.receivables[0].matchedTransactionId,'new');const firstSeen=bundle.monzo.transactions.find(t=>t.id==='new').firstSeenAt;
  clock+=86400000;await money.pullMonzo();bundle=await money.bundle();assert.equal(bundle.monzo.transactions.find(t=>t.id==='new').firstSeenAt,firstSeen);assert.equal(bundle.receivables[0].history.length,1);
  const restarted=createMoney({dir,now:()=>clock,request});assert.equal((await restarted.bundle()).receivables[0].matchedTransactionId,'new');
  assert.equal(fs.statSync(money.files('receivables')).mode&0o077,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('desktop create and sender forms wire submission to the authenticated claims mutation',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');const source=fs.readFileSync(path.join(__dirname,'../public/command.js'),'utf8');
 const code=source.slice(source.indexOf('function claimSenderOptions('),source.indexOf('function owedHTML(P){'));let captured, submitted,closed=false;
 const inputs={'mc-sender':{value:'bank-employer'},'mc-who':{value:'Expenses'},'mc-amount':{value:'80.50'},'mc-note':{value:'June–Sept'}};
 const sandbox={MN:{data:{receivables:[{id:'claim',who:'Expenses',amount:80.50,sender:{id:'bank-employer'}}],senders:[{id:'bank-employer',names:['Employer']}]}},moneySheet:(...args)=>{captured=args;return{};},sheetHead:x=>x,esc:String,amt:String,$:x=>inputs[x],moneyClaim:async body=>{submitted=body;return true;},closeOverlays:()=>{closed=true;},toast:()=>{}};
 vm.createContext(sandbox);vm.runInContext(code,sandbox);sandbox.openClaimSheet();assert.equal(captured.length,3);assert.equal(typeof captured[2],'function');assert.match(captured[1],/type="submit"/);await captured[2]();assert.equal(submitted.action,'create');assert.equal(submitted.senderId,'bank-employer');assert.equal(closed,true);
 sandbox.openClaimSheet('claim');await captured[2]();assert.deepEqual(JSON.parse(JSON.stringify(submitted)),{action:'link',id:'claim',senderId:'bank-employer'});
});

test('unconfigured seeding leaves a new document and existing claims untouched', () => {
 const doc = fixture(); const before = JSON.stringify(doc);
 R.seed(doc, [old], at); assert.equal(JSON.stringify(doc), before);
 const empty = { claims: [] }; R.seed(empty, [], at); assert.deepEqual(empty, { claims: [] });
});
