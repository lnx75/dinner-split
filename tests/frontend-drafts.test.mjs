import test from 'node:test';
import assert from 'node:assert/strict';
import {captureExpenseDrafts,inspectDraft,reconcileDrafts} from '../public/draft-sync.js';
const fixture=()=>({version:1,currentGathering:{id:'g1',status:'open'},members:[{id:'a'},{id:'b'},{id:'c'}],expenses:[{id:'food',title:'餐费',amountCents:100,participantIds:['a','b']},{id:'drink',title:'酒水',amountCents:200,participantIds:['b','c']}]});
test('conflict retains every local draft and raw invalid amount',()=>{
  const base=fixture(),local=structuredClone(base);local.expenses[0].amountCents=123;local.expenses[1].participantIds=['a'];
  const drafts=captureExpenseDrafts(base,local,['food','drink'],new Map([['drink','abc']]));
  assert.equal(drafts.length,2);assert.equal(drafts[1].raw,'abc');assert.equal(drafts[0].base.amountCents,100);assert.equal(drafts[1].participantsChanged,true);
  assert.deepEqual(base,fixture());
});
test('restoring an amount draft preserves someone else’s participant changes and title',()=>{
  const base=fixture(),local=structuredClone(base);local.expenses[0].amountCents=123;
  const drafts=captureExpenseDrafts(base,local,['food']),remote=fixture();remote.expenses[0].participantIds=['c'];remote.expenses[0].title='最新餐费';
  const result=reconcileDrafts(remote,drafts,new Set(['food']));
  assert.equal(result.state.expenses[0].amountCents,123);assert.deepEqual(result.state.expenses[0].participantIds,['c']);assert.equal(result.state.expenses[0].title,'最新餐费');
});
test('restoring participants preserves latest amount and detects same-field conflicts',()=>{
  const base=fixture(),local=structuredClone(base);local.expenses[0].participantIds=['b'];
  const draft=captureExpenseDrafts(base,local,['food'])[0],remote=fixture();remote.expenses[0].amountCents=999;remote.expenses[0].participantIds=['c'];
  assert.deepEqual(inspectDraft(remote,draft).conflicts,['参与人']);
  const result=reconcileDrafts(remote,[draft],new Set(['food']));assert.equal(result.state.expenses[0].amountCents,999);assert.deepEqual(result.state.expenses[0].participantIds,['b']);
});
test('server selection discards only chosen drafts, without mutating source snapshots',()=>{
  const base=fixture(),local=structuredClone(base);local.expenses[0].amountCents=123;local.expenses[1].amountCents=456;
  const drafts=captureExpenseDrafts(base,local,['food','drink']),remote=fixture(),result=reconcileDrafts(remote,drafts,new Set(['drink']));
  assert.equal(result.state.expenses[0].amountCents,100);assert.equal(result.state.expenses[1].amountCents,456);assert.deepEqual(remote,fixture());
});
for(const [reason,mutate] of [
  ['deleted expense',remote=>remote.expenses.shift()],
  ['different gathering',remote=>remote.currentGathering.id='g2'],
  ['finalized gathering',remote=>remote.currentGathering.status='finalized'],
  ['removed participant',remote=>remote.members=remote.members.filter(m=>m.id!=='c')]
])test(`a ${reason} cannot be restored or resurrected`,()=>{
  const base=fixture(),local=structuredClone(base);local.expenses[0].amountCents=123;local.expenses[0].participantIds=['c'];
  const draft=captureExpenseDrafts(base,local,['food'])[0],remote=fixture();mutate(remote);
  assert.equal(inspectDraft(remote,draft).canRestore,false);assert.throws(()=>reconcileDrafts(remote,[draft],new Set(['food'])));
});
test('raw input survives recovery even when last valid amount was unchanged',()=>{
  const base=fixture(),draft=captureExpenseDrafts(base,base,[],new Map([['food','12..3']]))[0];
  const remote=fixture();remote.expenses[0].amountCents=300;
  const result=reconcileDrafts(remote,[draft],new Set(['food']));assert.equal(result.rawInputs.get('food'),'12..3');assert.equal(result.state.expenses[0].amountCents,300);
});
test('cannot restore a positive amount onto a latest expense with no participants',()=>{
  const base=fixture(),local=structuredClone(base);local.expenses[0].amountCents=123;const draft=captureExpenseDrafts(base,local,['food'])[0],remote=fixture();remote.expenses[0].amountCents=0;remote.expenses[0].participantIds=[];
  assert.equal(inspectDraft(remote,draft).canRestore,false);
});
test('new remote advances prevent restoring an amount below recorded payments',()=>{
  const base=fixture();base.expenses[0].amountCents=300;const local=structuredClone(base);local.expenses[0].amountCents=100;
  const draft=captureExpenseDrafts(base,local,['food'])[0],remote=structuredClone(base);remote.advances=[{id:'paid',expenseId:'food',memberId:'a',amountCents:200}];
  const inspection=inspectDraft(remote,draft);assert.equal(inspection.canRestore,false);assert.match(inspection.reason,/垫付/);assert.throws(()=>reconcileDrafts(remote,[draft],new Set(['food'])));assert.equal(remote.expenses[0].amountCents,300);
});
