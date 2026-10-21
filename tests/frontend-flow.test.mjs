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
test('removed management concepts have no frontend entry points or API calls',async()=>{
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  for(const id of ['history-nav','history-view','gatherings-tab','backups-tab','expenses-tab','ledger-tabs'])assert.ok(!html.includes(`id="${id}"`),id);
  assert.doesNotMatch(source,/\/api\/(?:admin\/)?(?:gatherings|backups)/);
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
test('reviewing a remote update does not discard an unfinished member form',async()=>{
  const app=harness();app.evaluate("pendingRemote=structuredClone(state);pendingRemote.version=2;editedForms.add('member-form')");
  app.node('member-form.name').value='还在修改的名称';app.evaluate('openDraftRecovery()');
  assert.equal(app.evaluate('state.version'),1);assert.equal(app.node('member-form.name').value,'还在修改的名称');assert.equal(app.evaluate('pendingRemote.version'),2);
});
test('a delayed poll from a cleared bill cannot replace the next bill',async()=>{
  const app=harness(async path=>path==='/api/content'?DEFAULT_CONTENT:fixture(10));
  app.evaluate("state.version=12;state.currentGathering.id='new-bill';serverState=structuredClone(state)");await app.evaluate('syncRemote()');
  assert.equal(app.evaluate('state.version'),12);assert.equal(app.evaluate('state.currentGathering.id'),'new-bill');
});
test('opening a person detail preserves pending amount input and leaves totals visible',()=>{
  const app=harness();app.query('[data-amount="food"]').value='12..3';
  app.evaluate("dirty.set('drink',1);invalidInputs.set('food','invalid');renderSummary();renderDetail('a')");
  assert.equal(app.query('[data-amount="food"]').value,'12..3');assert.equal(app.evaluate('dirty.size'),1);assert.equal(app.evaluate('invalidInputs.size'),1);
  assert.equal(app.evaluate('state.version'),1);assert.equal(app.node('people-section').hidden,false);
  assert.equal(app.node('bar-total').textContent,'¥3.00');assert.equal(app.node('bar-allocated').textContent,'¥3.00');
});
test('navigation breadcrumbs track the current bill and selected management page safely',()=>{
  const app=harness();app.evaluate("content.texts.gatheringName='<当前账单>';renderSummary()");
  assert.match(app.node('.breadcrumb').innerHTML,/分账/);assert.match(app.node('.breadcrumb').innerHTML,/&lt;当前账单&gt;/);
  app.evaluate("user.role='admin';switchView('admin');setAdminTab('accounts')");
  assert.match(app.node('.breadcrumb').innerHTML,/管理后台/);assert.match(app.node('.breadcrumb').innerHTML,/登录账户/);
  app.evaluate("setAdminTab('security')");assert.match(app.node('.breadcrumb').innerHTML,/账户安全/);
});
test('a single page shows people with expenses and hides them when the bill is empty',()=>{
  const app=harness();app.evaluate('renderSummary()');assert.equal(app.node('people-section').hidden,false);
  assert.match(app.node('people-grid').innerHTML,/应付合计/);assert.doesNotMatch(app.node('people-grid').innerHTML,/已垫付/);
  app.evaluate('state.expenses=[];renderSummary()');
  assert.equal(app.node('people-section').hidden,true);assert.equal(app.node('people-grid').innerHTML,'');assert.equal(app.node('settlement-section').hidden,true);
  assert.equal(app.node('bar-total').textContent,'¥0.00');assert.equal(app.node('bar-allocated').textContent,'¥0.00');
});
test('editors can edit dish cards and members but cannot open administrator settings',()=>{
  const app=harness();app.evaluate('renderAuth()');
  for(const tab of ['members','security']){assert.equal(app.node(`${tab}-tab`).hidden,false);app.evaluate(`setAdminTab('${tab}')`);assert.equal(app.evaluate('adminTab'),tab);}
  for(const tab of ['accounts','content','logs']){assert.equal(app.node(`${tab}-tab`).hidden,true);app.evaluate(`requestAdminTab('${tab}')`);assert.equal(app.evaluate('adminTab'),'security');assert.equal(app.node(`${tab}-panel`).hidden,true);}
});
test('downgrading or logging out hides the previously selected administrator panel',()=>{
  const app=harness();app.evaluate("user.role='admin';renderAuth();setAdminTab('accounts')");assert.equal(app.node('accounts-panel').hidden,false);
  app.evaluate("user.role='editor';renderAuth()");assert.equal(app.evaluate('adminTab'),'members');assert.equal(app.node('accounts-panel').hidden,true);assert.equal(app.node('accounts-section').hidden,true);
  app.evaluate('user=null;renderAuth()');for(const tab of ['members','accounts','security'])assert.equal(app.node(`${tab}-panel`).hidden,true);
});
test('new administrator tabs and contextual shortcuts retain the page-content leave safeguard',async()=>{
  const app=harness(async path=>path==='/api/admin/accounts'?{accounts:[]}:fixture());
  app.evaluate("user.role='admin';renderAuth();switchView('admin');setAdminTab('content');contentDraft.texts.brandName='尚未保存的新名字';requestAdminTab('members')");
  assert.equal(app.node('content-leave-dialog').open,true);assert.equal(app.evaluate('adminTab'),'content');assert.equal(app.node('members-panel').hidden,true);
  app.node('content-leave-dialog').close();app.evaluate('pendingLeave=null');await app.evaluate("openAdmin('members')");
  assert.equal(app.node('content-leave-dialog').open,true);assert.equal(app.evaluate('adminTab'),'content');assert.equal(app.evaluate('contentDraft.texts.brandName'),'尚未保存的新名字');
});
test('administrator keyboard navigation skips forbidden settings',()=>{
  const app=harness();app.evaluate('renderAuth();renderSummary()');
  const key=(element,key)=>element.listeners.get('keydown')[0]({key,preventDefault(){}});
  key(app.node('.admin-tabs'),'ArrowDown');assert.equal(app.evaluate('adminTab'),'security');
  key(app.node('.admin-tabs'),'ArrowDown');assert.equal(app.evaluate('adminTab'),'members');
  key(app.node('.admin-tabs'),'End');assert.equal(app.evaluate('adminTab'),'security');
  key(app.node('.admin-tabs'),'Home');assert.equal(app.evaluate('adminTab'),'members');
});

test('adding a dish submits name, cents and only selected eaters in one request',async()=>{
  const remote=fixture();const app=harness(async(path,options)=>{
    if(path==='/api/admin/expenses'){const body=JSON.parse(options.body);remote.version++;remote.expenses.push({id:'dish',title:body.title,amountCents:body.amountCents,participantIds:body.participantIds});return remote;}
    return remote;
  });
  await app.evaluate('openExpenseEditor()');assert.equal(app.node('expense-dialog').open,true);assert.equal(app.evaluate('expenseEditorDraft.size'),2);
  app.node('expense-edit-form.title').value=' 鱼香肉丝 ';app.node('expense-edit-form.amount').value='39.99';app.evaluate("expenseEditorDraft=new Set(['a'])");await app.evaluate('saveExpenseEditor()');
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/api/admin/expenses');assert.equal(app.calls[0].options.method,'POST');
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{version:1,title:'鱼香肉丝',amountCents:3999,participantIds:['a']});assert.equal(app.node('expense-dialog').open,false);
  assert.equal(app.evaluate("state.expenses.find(e=>e.id==='dish').amountCents"),3999);
});
test('a late arriving member joins new dish defaults without joining old dishes',async()=>{
  const app=harness();app.evaluate("state.members.push({id:'c',name:'晚到者',order:2,color:'#50837A'})");await app.evaluate('openExpenseEditor()');
  assert.equal(app.evaluate("expenseEditorDraft.has('c')"),true);assert.equal(app.evaluate("state.expenses.some(e=>e.participantIds.includes('c'))"),false);
  app.evaluate('renderSummary()');assert.equal(app.evaluate("ledger.people.find(p=>p.id==='c').totalCents"),0);
});
test('editing a dish sends all three fields atomically and preserves old values until save',async()=>{
  const remote=fixture();const app=harness(async(path,options)=>{const body=JSON.parse(options.body);Object.assign(remote.expenses[0],body);remote.version=2;return remote;});
  await app.evaluate("openExpenseEditor('food')");app.node('expense-edit-form.title').value='新菜名';app.node('expense-edit-form.amount').value='12.34';app.evaluate("expenseEditorDraft=new Set(['b'])");
  assert.equal(app.evaluate('state.expenses[0].amountCents'),100);await app.evaluate('saveExpenseEditor()');
  assert.equal(app.calls[0].path,'/api/admin/expenses/food');assert.equal(app.calls[0].options.method,'PATCH');assert.deepEqual(JSON.parse(app.calls[0].options.body),{version:1,title:'新菜名',amountCents:1234,participantIds:['b']});
});
test('a dish without selected eaters cannot save a positive amount',async()=>{
  const app=harness();await app.evaluate('openExpenseEditor()');app.node('expense-edit-form.title').value='这道我没吃';app.node('expense-edit-form.amount').value='10';app.evaluate('expenseEditorDraft.clear()');await app.evaluate('saveExpenseEditor()');
  assert.equal(app.calls.length,0);assert.equal(app.node('expense-dialog').open,true);assert.equal(app.node('expense-edit-form.amount').value,'10');assert.match(app.node('expense-edit-error').textContent,/勾选/);
});
test('a conflicting dish save keeps the full modal input while deferring remote replacement',async()=>{
  const app=harness(async()=>({status:409,body:{message:'conflict',state:fixture(2)}}));await app.evaluate("openExpenseEditor('food')");
  app.node('expense-edit-form.title').value='未保存的菜名';app.node('expense-edit-form.amount').value='12.30';app.evaluate("expenseEditorDraft=new Set(['b'])");await app.evaluate('saveExpenseEditor()');
  assert.equal(app.node('expense-dialog').open,true);assert.equal(app.node('expense-edit-form.title').value,'未保存的菜名');assert.equal(app.node('expense-edit-form.amount').value,'12.30');assert.equal(app.evaluate("expenseEditorDraft.has('b')"),true);
  assert.equal(app.evaluate('state.version'),1);assert.equal(app.evaluate('recovery.remote.version'),2);assert.match(app.node('expense-edit-error').textContent,/输入已保留/);
});
test('a reset uses the confirmed version, keeps members and removes fees and advances',async()=>{
  const remote=fixture(2);remote.currentGathering.id='next';remote.expenses=[];remote.advances=[];
  const app=harness(async()=>remote);app.evaluate("user.role='admin';state.advances=[{id:'paid',expenseId:'food',memberId:'a',amountCents:100}]");
  await app.evaluate('openResetBill()');assert.equal(app.node('reset-bill-dialog').open,true);assert.match(app.node('reset-bill-summary').textContent,/2 位成员/);assert.match(app.node('reset-bill-summary').textContent,/不能撤销/);
  await app.evaluate('confirmResetBill()');assert.equal(app.calls[0].path,'/api/admin/bill/reset');assert.deepEqual(JSON.parse(app.calls[0].options.body),{version:1});
  assert.equal(app.evaluate('state.members.length'),2);assert.equal(app.evaluate('state.expenses.length'),0);assert.equal(app.evaluate('state.advances.length'),0);assert.equal(app.evaluate('state.currentGathering.id'),'next');assert.equal(app.node('people-section').hidden,true);
});
test('only administrators can reset a bill and a conflict never silently reconfirms new data',async()=>{
  const app=harness(async()=>({status:409,body:{message:'conflict',state:fixture(2)}}));await app.evaluate('openResetBill()');assert.equal(app.node('reset-bill-dialog').open,false);assert.equal(app.calls.length,0);
  app.evaluate("user.role='admin'");await app.evaluate('openResetBill()');await app.evaluate('confirmResetBill()');assert.equal(app.node('reset-bill-dialog').open,true);assert.equal(app.evaluate('resetBillVersion'),1);assert.match(app.node('reset-bill-error').textContent,/取消后核对/);assert.equal(app.evaluate('state.version'),1);
});
test('an expense modal cannot submit into a different cleared bill',async()=>{
  const app=harness();await app.evaluate('openExpenseEditor()');app.node('expense-edit-form.title').value='上一顿的菜';app.node('expense-edit-form.amount').value='10';app.evaluate("state.currentGathering.id='next'");await app.evaluate('saveExpenseEditor()');
  assert.equal(app.calls.length,0);assert.equal(app.node('expense-dialog').open,true);assert.match(app.node('expense-edit-error').textContent,/已被清空/);
});

test('the primary add-dish action is visible after authentication and in browse mode',()=>{
  const app=harness();app.node('add-expense').hidden=true;app.evaluate('renderAuth()');
  assert.equal(app.node('add-expense').hidden,false);assert.equal(app.node('add-expense').disabled,false);
  app.evaluate('user=null;renderAuth()');assert.equal(app.node('add-expense').hidden,false);assert.equal(app.node('add-expense').disabled,false);
});
