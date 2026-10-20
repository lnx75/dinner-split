// Pure draft reconciliation; callers explicitly choose whether to restore each draft.
const copy = value => structuredClone(value);
const sameIds = (a=[],b=[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function gatheringKey(state) { return state?.currentGathering?.id || 'legacy'; }
export function captureExpenseDrafts(base, local, ids=[], rawInputs=new Map()) {
  const selected=new Set([...ids,...rawInputs.keys()]);
  return [...selected].flatMap(id=>{
    const current=local?.expenses?.find(item=>item.id===id), before=base?.expenses?.find(item=>item.id===id);
    if(!current)return [];
    return [{id,title:current.title, gatheringId:gatheringKey(base||local), amountCents:current.amountCents, participantIds:[...current.participantIds], base:before?{amountCents:before.amountCents,participantIds:[...before.participantIds]}:null, amountChanged:!before||current.amountCents!==before.amountCents, participantsChanged:!before||!sameIds(current.participantIds,before.participantIds), raw:rawInputs.get(id)??null}];
  });
}
export function inspectDraft(remote,draft) {
  const expense=remote.expenses.find(item=>item.id===draft.id);
  let reason='';
  if(gatheringKey(remote)!==draft.gatheringId)reason='已经切换到另一场聚餐，不能写入旧草稿。';
  else if(remote.currentGathering?.status==='finalized')reason='聚餐已定稿，不能恢复编辑。';
  else if(!expense)reason='费用已被删除，不能恢复。';
  else if(draft.participantsChanged&&draft.participantIds.some(id=>!remote.members.some(member=>member.id===id)))reason='草稿中的参与人已被删除，请重新选择。';
  const merged=expense?{...copy(expense),...(draft.amountChanged?{amountCents:draft.amountCents}:{}),...(draft.participantsChanged?{participantIds:[...draft.participantIds]}:{})}:null;
  if(!reason&&merged.amountCents>0&&!merged.participantIds.length)reason='最新参与人为空，无法直接恢复有金额的草稿。';
  const paid=(remote.advances||[]).filter(item=>item.expenseId===draft.id).reduce((sum,item)=>sum+item.amountCents,0);
  if(!reason&&merged.amountCents<paid)reason='最新账单已有垫付，草稿金额不能小于已记录的垫付合计。';
  const conflicts=[];
  if(expense&&draft.base){
    if(draft.amountChanged&&expense.amountCents!==draft.base.amountCents&&expense.amountCents!==draft.amountCents)conflicts.push('金额');
    if(draft.participantsChanged&&!sameIds(expense.participantIds,draft.base.participantIds)&&!sameIds(expense.participantIds,draft.participantIds))conflicts.push('参与人');
  }
  return {canRestore:!reason,reason,conflicts,expense,merged};
}
export function reconcileDrafts(remote,drafts,restoreIds) {
  const result=copy(remote), restored=[], rawInputs=new Map();
  for(const draft of drafts){
    if(!restoreIds.has(draft.id))continue;
    const inspection=inspectDraft(remote,draft);
    if(!inspection.canRestore)throw new Error(inspection.reason);
    result.expenses[result.expenses.findIndex(item=>item.id===draft.id)]=inspection.merged;
    if(draft.raw!==null)rawInputs.set(draft.id,draft.raw);
    restored.push(draft.id);
  }
  return {state:result,restored,rawInputs};
}
