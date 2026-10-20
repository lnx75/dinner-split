import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {parseAmount,formatMoney,calculateLedger} from '../public/split.js';
import {CONTENT_TEXT_FIELDS,DEFAULT_CONTENT,isContentImageSource} from '../public/content.js';
import {captureExpenseDrafts,inspectDraft,reconcileDrafts,gatheringKey} from '../public/draft-sync.js';
const source=(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'');
test('page markup provides unique IDs for every static frontend element reference',async()=>{
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]),present=new Set(ids);
  assert.equal(present.size,ids.length,'Duplicate IDs make navigation and form targeting ambiguous');
  for(const [,id] of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(present.has(id),`Missing frontend element #${id}`);
});
function fixture(version=1){return {version,currentGathering:{id:'g1',name:'聚餐',date:'2026-10-20',status:'open'},members:[{id:'a',name:'甲',order:0,color:'#50837A'},{id:'b',name:'乙',order:1,color:'#A2789F'}],expenses:[{id:'food',title:'餐费',amountCents:100,participantIds:['a','b']},{id:'drink',title:'酒水',amountCents:200,participantIds:['a','b']}],advances:[]};}
function harness(handler=async path=>path==='/api/content'?DEFAULT_CONTENT:fixture()){
  const nodes=new Map(),intervals=[],calls=[];
  const node=key=>{
    if(nodes.has(key))return nodes.get(key);
    const listeners=new Map(),attrs=new Map();
    const element={id:key,textContent:'',innerHTML:'',value:'',hidden:false,disabled:false,open:false,checked:false,dataset:{},style:{},files:[],className:'',listeners,classList:{add(){},remove(){},toggle(){}},
      addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},setAttribute(k,v){attrs.set(k,v);},removeAttribute(k){attrs.delete(k);},getAttribute(k){return attrs.get(k);},
      querySelector(query){return node(`${key} ${query}`);},querySelectorAll(){return [];},closest(){return node(`${key} parent`);},focus(){},scrollIntoView(){},setCustomValidity(){},reportValidity(){return true;},reset(){this.value='';},getBoundingClientRect(){return {left:0,right:1,top:0,bottom:1};},
      showModal(){this.open=true;},close(){this.open=false;for(const fn of listeners.get('close')||[])fn({target:this});}}
    element.elements=new Proxy({}, {get:(_,name)=>node(`${key}.${String(name)}`)});nodes.set(key,element);return element;
  };
  const query=selector=>{const found=selector.match(/^\[data-amount="(.+)"\]$/);if(found){const item=node(`amount-${found[1]}`);item.dataset.amount=found[1];return item;}return node(selector);};
  const document={hidden:false,getElementById:node,querySelector:query,querySelectorAll(selector){if(selector==='[data-amount]')return [...nodes.values()].filter(n=>n.dataset.amount);if(selector==='dialog[open]')return [...nodes.values()].filter(n=>n.open&&n.id.endsWith('-dialog'));return [];},addEventListener(){}};
  const context=vm.createContext({console,structuredClone,parseAmount,formatMoney,calculateLedger,CONTENT_TEXT_FIELDS,DEFAULT_CONTENT,isContentImageSource,captureExpenseDrafts,inspectDraft,reconcileDrafts,gatheringKey,document,CSS:{escape:x=>x},URLSearchParams,Map,Set,Date,Intl,Promise,window:{addEventListener(){},scrollTo(){}},setInterval:fn=>intervals.push(fn),setTimeout:()=>1,clearTimeout(){},confirm:()=>true,fetch:async(path,options)=>{calls.push({path,options});const result=await handler(path,options);return {ok:result?.status?result.status<400:true,status:result?.status||200,json:async()=>structuredClone(result?.body??result)};}});
  vm.runInContext(source,context);
  const evaluate=expression=>vm.runInContext(expression,context);
  context.fixture=fixture();evaluate("state=structuredClone(fixture);serverState=structuredClone(fixture);user={id:'u1',username:'editor',role:'editor'};csrfToken='csrf';contentLoaded=true;authIdentity='u1:editor:editor';");
  return {context,evaluate,node,query,calls,intervals};
}
test('5-second/focus synchronization accepts new remote state when nobody is editing',async()=>{
  const remote=fixture(2);remote.expenses[0].amountCents=500;const app=harness(async path=>path==='/api/content'?DEFAULT_CONTENT:remote);
  assert.equal(app.intervals.length,1);await app.evaluate('syncRemote()');assert.equal(app.evaluate('state.version'),2);assert.equal(app.evaluate('state.expenses[0].amountCents'),500);assert.equal(app.evaluate('pendingRemote'),null);
});
test('remote refresh preserves multiple unsaved drafts and an invalid amount verbatim',async()=>{
  const app=harness(async path=>path==='/api/content'?DEFAULT_CONTENT:fixture(2));
  app.query('[data-amount="drink"]').value='oops';app.evaluate("state.expenses[0].amountCents=123;dirty.set('food',1);invalidInputs.set('drink','invalid');");
  await app.evaluate('syncRemote()');assert.equal(app.evaluate('state.version'),1);assert.equal(app.evaluate('state.expenses[0].amountCents'),123);assert.equal(app.query('[data-amount="drink"]').value,'oops');assert.equal(app.evaluate('pendingRemote.version'),2);
});
test('refresh defers replacing an open participant picker or page-content draft',async()=>{
  const app=harness(async path=>path==='/api/content'?DEFAULT_CONTENT:fixture(2));app.node('participants-dialog').open=true;
  await app.evaluate('syncRemote()');assert.equal(app.evaluate('state.version'),1);assert.equal(app.node('participants-dialog').open,true);
  app.node('participants-dialog').open=false;app.evaluate("contentDraft.texts.brandName='未保存文字'");await app.evaluate('syncRemote()');assert.equal(app.evaluate('contentDraft.texts.brandName'),'未保存文字');assert.equal(app.evaluate('state.version'),1);
});
test('a 409 preserves both amount drafts and their original baselines',async()=>{
  const app=harness(async path=>path.startsWith('/api/expenses/')?{status:409,body:{message:'conflict',state:fixture(2)}}:fixture(2));
  app.evaluate("state.expenses[0].amountCents=123;state.expenses[1].amountCents=456;dirty.set('food',1);dirty.set('drink',1);revisions.set('food',1);revisions.set('drink',1)");
  await assert.rejects(app.evaluate('flushSaves()'));
  assert.equal(app.evaluate('dirty.size'),2);assert.equal(app.evaluate('recovery.drafts.length'),2);assert.equal(app.evaluate('recovery.drafts[0].base.amountCents'),100);assert.equal(app.evaluate('recovery.drafts[1].amountCents'),456);assert.equal(app.evaluate('state.expenses[0].amountCents'),123);
});
test('invalid input no longer prevents logout; user explicitly discards, then server state replaces drafts',async()=>{
  const app=harness(async path=>path==='/api/logout'?{}:fixture());app.query('[data-amount="food"]').value='bad';app.evaluate("invalidInputs.set('food','invalid');contentDraft.texts.brandName='未保存文字'");
  await app.evaluate('logout()');assert.equal(app.node('logout-dialog').open,true);assert.equal(app.calls.length,0);assert.equal(app.evaluate('user.username'),'editor');
  await app.evaluate('logout(true)');assert.equal(app.evaluate('user'),null);assert.equal(app.evaluate('invalidInputs.size'),0);assert.equal(app.evaluate('pageContentDirty()'),false);assert.equal(app.evaluate('state.expenses[0].amountCents'),100);assert.equal(app.calls.filter(c=>c.path==='/api/logout').length,1);
});
test('logout waits for an in-flight write and blocks new writes during the transition',async()=>{
  let release;const waiting=new Promise(resolve=>release=resolve);const app=harness(async path=>path==='/api/pending'?waiting:path==='/api/logout'?{}:fixture());
  const pending=app.evaluate("api('/api/pending',{method:'POST',body:{}})");const logout=app.evaluate('logout(true)');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(app.calls.some(c=>c.path==='/api/logout'),false);
  await assert.rejects(app.evaluate("api('/api/new-write',{method:'POST',body:{}})"));release({});await pending;await logout;assert.equal(app.evaluate('user'),null);assert.equal(app.calls.filter(c=>c.path==='/api/logout').length,1);
});
test('a stale poll response cannot roll a recently saved state backwards',async()=>{
  const app=harness(async path=>path==='/api/content'?DEFAULT_CONTENT:fixture(1));app.evaluate('serverState.version=3;state.version=3');await app.evaluate('syncRemote()');assert.equal(app.evaluate('state.version'),3);
});
test('history inspection uses an independent read-only model',async()=>{
  const history=fixture(9);history.gathering={id:'old',name:'过去的聚餐',date:'2026-10-01',status:'finalized'};const app=harness(async()=>history);
  await app.evaluate("openHistoryDetail('old')");assert.equal(app.evaluate('state.currentGathering.id'),'g1');assert.equal(app.evaluate('state.version'),1);assert.equal(app.node('history-detail-dialog').open,true);assert.match(app.node('history-detail-content').innerHTML,/历史归档 · 只读/);
});
for(const field of ['amount','participants'])test(`an in-flight ${field} edit reverted to the old value is preserved and submitted`,async()=>{
  let release;const waiting=new Promise(resolve=>release=resolve),remote=fixture(),sent=[];
  const app=harness(async(path,options)=>{
    if(!path.startsWith('/api/expenses/'))return remote;
    const body=JSON.parse(options.body);sent.push(body);if(sent.length===1)await waiting;
    Object.assign(remote.expenses[0],{amountCents:body.amountCents,participantIds:body.participantIds});remote.version++;
    return structuredClone(remote);
  });
  app.evaluate(field==='amount'?"state.expenses[0].amountCents=200":"state.expenses[0].participantIds=['a']");app.evaluate("dirty.set('food',1);revisions.set('food',1)");
  const saving=app.evaluate('flushSaves()');await new Promise(resolve=>setImmediate(resolve));
  app.evaluate(field==='amount'?"state.expenses[0].amountCents=100":"state.expenses[0].participantIds=['a','b']");app.evaluate("dirty.set('food',2);revisions.set('food',2)");release();await saving;
  assert.equal(sent.length,2);
  if(field==='amount'){assert.deepEqual(sent.map(item=>item.amountCents),[200,100]);assert.equal(app.evaluate('state.expenses[0].amountCents'),100);}
  else{assert.deepEqual(sent.map(item=>item.participantIds),[['a'],['a','b']]);assert.equal(app.evaluate('state.expenses[0].participantIds.length'),2);}
  assert.equal(app.evaluate('dirty.size'),0);
});
test('local amount cannot drop below existing advance records or poison ledger calculations',async()=>{
  const app=harness();app.evaluate("state.advances=[{id:'p1',expenseId:'food',memberId:'a',amountCents:80}]");
  const input=app.query('[data-amount="food"]');input.value='0.50';
  await app.node('expense-grid').listeners.get('input')[0]({target:{closest:()=>input}});
  assert.equal(app.evaluate('state.expenses[0].amountCents'),100);assert.equal(app.evaluate('dirty.size'),0);assert.equal(app.evaluate("invalidInputs.has('food')"),true);
});
test('reviewing a remote update does not discard an unfinished gathering name form',async()=>{
  const app=harness();app.evaluate("pendingRemote=structuredClone(state);pendingRemote.version=2;editedForms.add('gathering-edit-form')");
  app.node('gathering-edit-form.name').value='还在修改的名称';app.evaluate('openDraftRecovery()');
  assert.equal(app.evaluate('state.version'),1);assert.equal(app.node('gathering-edit-form.name').value,'还在修改的名称');assert.equal(app.evaluate('pendingRemote.version'),2);
});
test('a delayed poll from a previous gathering cannot replace a newly created gathering',async()=>{
  const app=harness(async path=>path==='/api/content'?DEFAULT_CONTENT:fixture(10));
  app.evaluate("state.version=12;state.currentGathering.id='new-gathering';serverState=structuredClone(state)");await app.evaluate('syncRemote()');
  assert.equal(app.evaluate('state.version'),12);assert.equal(app.evaluate('state.currentGathering.id'),'new-gathering');
});
test('bill tabs preserve pending amount input and keep the total reconciliation visible',()=>{
  const app=harness();app.query('[data-amount="food"]').value='12..3';
  app.evaluate("dirty.set('drink',1);invalidInputs.set('food','invalid');renderSummary();setLedgerTab('people');setLedgerTab('settlement')");
  assert.equal(app.query('[data-amount="food"]').value,'12..3');assert.equal(app.evaluate('dirty.size'),1);assert.equal(app.evaluate('invalidInputs.size'),1);
  assert.equal(app.evaluate('state.version'),1);assert.equal(app.node('ledger-settlement-panel').hidden,false);assert.equal(app.node('ledger-expenses-panel').hidden,true);
  assert.equal(app.node('ledger-settlement-tab').getAttribute('aria-selected'),'true');assert.equal(app.node('ledger-settlement-tab').tabIndex,0);assert.equal(app.node('ledger-people-tab').tabIndex,-1);
  assert.equal(app.node('bar-total').textContent,'¥3.00');assert.equal(app.node('bar-allocated').textContent,'¥3.00');
});
test('navigation breadcrumbs track the current gathering and selected management page safely',()=>{
  const app=harness();app.evaluate("state.currentGathering.name='<周末聚餐>';renderSummary()");
  assert.match(app.node('.breadcrumb').innerHTML,/当前聚餐/);assert.match(app.node('.breadcrumb').innerHTML,/&lt;周末聚餐&gt;/);
  app.evaluate("user.role='admin';switchView('admin');setAdminTab('accounts')");
  assert.match(app.node('.breadcrumb').innerHTML,/管理后台/);assert.match(app.node('.breadcrumb').innerHTML,/登录账户/);
  app.evaluate("setAdminTab('security')");assert.match(app.node('.breadcrumb').innerHTML,/账户安全/);
});
test('summary updates keep exactly one bill panel active, and an empty bill returns to expenses',()=>{
  const app=harness();app.evaluate("renderSummary();setLedgerTab('people');renderSummary()");
  assert.equal(app.node('ledger-people-panel').hidden,false);assert.equal(app.node('ledger-expenses-panel').hidden,true);assert.equal(app.node('ledger-settlement-panel').hidden,true);
  app.evaluate('state.expenses=[];renderSummary()');
  assert.equal(app.evaluate('ledgerTab'),'expenses');assert.equal(app.node('ledger-expenses-panel').hidden,false);assert.equal(app.node('ledger-people-tab').hidden,true);assert.equal(app.node('ledger-settlement-tab').hidden,true);
  assert.equal(app.node('people-section').hidden,true);assert.equal(app.node('people-grid').innerHTML,'');
  app.evaluate("setLedgerTab('people')");assert.equal(app.evaluate('ledgerTab'),'expenses');
});
test('editors can manage fees and members but cannot open administrator settings',()=>{
  const app=harness();app.evaluate('renderAuth()');
  for(const tab of ['expenses','members','security']){assert.equal(app.node(`${tab}-tab`).hidden,false);app.evaluate(`setAdminTab('${tab}')`);assert.equal(app.evaluate('adminTab'),tab);}
  for(const tab of ['accounts','gatherings','content','backups','logs']){assert.equal(app.node(`${tab}-tab`).hidden,true);app.evaluate(`requestAdminTab('${tab}')`);assert.equal(app.evaluate('adminTab'),'security');assert.equal(app.node(`${tab}-panel`).hidden,true);}
});
test('downgrading or logging out hides the previously selected administrator panel',()=>{
  const app=harness();app.evaluate("user.role='admin';renderAuth();setAdminTab('accounts')");assert.equal(app.node('accounts-panel').hidden,false);
  app.evaluate("user.role='editor';renderAuth()");assert.equal(app.evaluate('adminTab'),'expenses');assert.equal(app.node('accounts-panel').hidden,true);assert.equal(app.node('accounts-section').hidden,true);
  app.evaluate('user=null;renderAuth()');for(const tab of ['expenses','members','accounts','security'])assert.equal(app.node(`${tab}-panel`).hidden,true);
});
test('new administrator tabs and contextual shortcuts retain the page-content leave safeguard',async()=>{
  const app=harness(async path=>path==='/api/admin/accounts'?{accounts:[]}:fixture());
  app.evaluate("user.role='admin';renderAuth();switchView('admin');setAdminTab('content');contentDraft.texts.brandName='尚未保存的新名字';requestAdminTab('expenses')");
  assert.equal(app.node('content-leave-dialog').open,true);assert.equal(app.evaluate('adminTab'),'content');assert.equal(app.node('expenses-panel').hidden,true);
  app.node('content-leave-dialog').close();app.evaluate('pendingLeave=null');await app.evaluate("openAdmin('members')");
  assert.equal(app.node('content-leave-dialog').open,true);assert.equal(app.evaluate('adminTab'),'content');assert.equal(app.evaluate('contentDraft.texts.brandName'),'尚未保存的新名字');
});
test('bill tab keyboard navigation synchronizes selected state and administrator navigation skips forbidden tabs',()=>{
  const app=harness();app.evaluate('renderAuth();renderSummary()');
  const key=(element,key)=>element.listeners.get('keydown')[0]({key,preventDefault(){}});
  key(app.node('ledger-tabs'),'ArrowRight');assert.equal(app.evaluate('ledgerTab'),'people');assert.equal(app.node('ledger-people-tab').getAttribute('aria-selected'),'true');
  key(app.node('ledger-tabs'),'End');assert.equal(app.evaluate('ledgerTab'),'settlement');
  key(app.node('.admin-tabs'),'ArrowDown');assert.equal(app.evaluate('adminTab'),'members');
  key(app.node('.admin-tabs'),'ArrowDown');assert.equal(app.evaluate('adminTab'),'security');
  key(app.node('.admin-tabs'),'Home');assert.equal(app.evaluate('adminTab'),'expenses');
});
