import { parseAmount, formatMoney, calculateLedger } from './split.js';
import { captureExpenseDrafts, inspectDraft, reconcileDrafts, gatheringKey } from './draft-sync.js';
import { CONTENT_TEXT_FIELDS, DEFAULT_CONTENT, isContentImageSource } from './content.js';

const $ = id => document.getElementById(id);
const paths = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  shield:'<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7"/><path d="M12 7v5l3 2"/>',
  chevron:'<path d="m6 9 6 6 6-6"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>',
  people:'<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M21 20v-3a6 6 0 0 0-4-5.65"/>',
  receipt:'<path d="M5 3v18l3-2 4 2 4-2 3 2V3l-3 2-4-2-4 2z"/><path d="M9 9h6M9 13h6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  arrow:'<path d="M6 18 18 6M7 6h11v11"/>',
  dinner:'<path d="M4 3v6a3 3 0 0 0 6 0V3M7 3v18M20 21V3c-4 2-5 5-5 9h5"/>',
  drink:'<path d="M7 3h10l1 6a6 6 0 0 1-12 0zM12 15v6M8 21h8M6.5 8h11"/>',
  parking:'<path d="m5 7 2-4h10l2 4 2 4v7H3v-7zM3 10h18M5 18v3M19 18v3M6 14h2M16 14h2"/>',
  coins:'<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v4c0 1.7 2.7 3 6 3 1 0 2-.1 3-.4M3 10v4c0 1.7 2.7 3 6 3M3 14v4c0 1.7 2.7 3 6 3"/><ellipse cx="16" cy="14" rx="5" ry="2.5"/><path d="M11 14v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.receipt}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const moneyDigits = cents => formatMoney(cents).replace('¥', '');
const colorClass = (member, index = 0) => ({'#c9683f':'amber','#50837a':'green','#6883a1':'blue','#a2789f':'purple'}[String(member.color).toLowerCase()] || ['green','purple','blue','amber'][index % 4]);
const kind = expense => /酒|wine|drink/i.test(`${expense.title} ${expense.icon}`) ? 'drink' : /停车|car|parking/i.test(`${expense.title} ${expense.icon}`) ? 'parking' : /餐|food|dinner/i.test(`${expense.title} ${expense.icon}`) ? 'dinner' : 'receipt';
const expenseTitle = expense => expense?.title || '';
const expensePaidCents = id => (state?.advances||[]).filter(item=>item.expenseId===id).reduce((sum,item)=>sum+item.amountCents,0);
const avatarSource = member => typeof member?.avatarUrl === 'string' && /^\/media\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|webp)$/.test(member.avatarUrl) ? member.avatarUrl : '';
const avatarMarkup = (member, classes='') => `<div class="avatar ${classes}" aria-hidden="true">${avatarSource(member)?`<img src="${esc(avatarSource(member))}" alt="">`:esc(member.name?.slice(-1)||'人')}</div>`;
const copyContent = value => structuredClone(value);
let content = copyContent(DEFAULT_CONTENT), contentDraft = copyContent(DEFAULT_CONTENT), contentLoaded = false;
let adminTab = 'expenses', ledgerTab = 'expenses', contentSaving = false, contentSaveFailed = false, contentConflict = null, pendingLeave = null, uploadGeneration = 0;
const contentUploads = new Set();
let contentPreviewField = 'heroTitleLine1';
let state = null, user = null, csrfToken = '', ledger = null, accounts = [], currentView = 'ledger';
let saveTimer, toastTimer, savingPromise = null, saveFailed = false, detailMemberId = null, editMemberId = null;
const dirty = new Map(), revisions = new Map(), invalidInputs = new Map();
let participantExpenseId = null, participantDraft = new Set(), editExpenseId = null;
let memberAvatarDraft = '', memberAvatarUploading = false, memberAvatarGeneration = 0, memberSaving = false;
let authIdentity = '', auditLogs = [], auditLoading = false, auditError = '', auditHasMore = false, auditBefore = null, auditGeneration = 0;
let editAccountId = null, accountSaving = false, accountEditGeneration = 0, accountListGeneration = 0;
let syncError='',serverState=null, pendingRemote=null, recovery=null, syncRunning=false, lastSyncAt=null, quitting=false, resettingAccountId=null, editAdvanceId=null;
const pendingWrites=new Set(),editedForms=new Set();
const adminTabs=['expenses','members','gatherings','accounts','security','content','backups','logs'];
const ledgerTabs=['expenses','people','settlement'];
const canEditLedger=()=>canManageLedger()&&state?.currentGathering?.status!=='finalized'&&!quitting&&!recovery;
const editableDialogs=['participants-dialog','member-dialog','expense-dialog','account-dialog','advance-dialog','reset-password-dialog'];
let releasesLoaded = false, releasesLoading = false, releaseLoadAttempt = 0;
const isAdmin = () => user?.role === 'admin';
const canManageLedger = () => ['admin','editor'].includes(user?.role);
const canAccessAdminTab = tab => adminTabs.includes(tab)&&canManageLedger()&&(isAdmin()||['expenses','members','security'].includes(tab));
const beijingTime = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });
$('people-grid').innerHTML = '<div class="loading-card">正在准备聚餐账单…</div>';
$('expense-grid').innerHTML = '<div class="loading-card">正在读取费用…</div>';

async function trackedFetch(path,options={}) {
  const writing=options.method&&options.method!=='GET';
  if(writing&&quitting&&path!=='/api/logout')throw new Error('正在退出登录，请稍候。');
  const request=fetch(path,options);
  if(writing)pendingWrites.add(request);
  try{return await request;}finally{pendingWrites.delete(request);}
}
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await trackedFetch(path, { method, credentials:'same-origin', headers:{ ...(body ? {'Content-Type':'application/json'} : {}), ...(method !== 'GET' ? {'x-csrf-token':csrfToken} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
  } catch(error) { if(quitting)throw error;throw Object.assign(new Error('连接中断，修改尚未保存。请检查网络后重试。'), {status:0}); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Object.assign(new Error(result.message || '操作未完成，请稍后重试。'), {status:response.status, data:result});
    if (response.status === 401 && path !== '/api/login') { user = null; csrfToken = ''; renderAuth(); }
    throw error;
  }
  return result;
}
function draftSnapshot(base=serverState||state) {
  const raw=new Map([...invalidInputs.keys()].map(id=>[id,document.querySelector(`[data-amount="${CSS.escape(id)}"]`)?.value??'']));
  return captureExpenseDrafts(base,state,dirty.keys(),raw);
}
function modalEditing() { return editableDialogs.some(id=>$(id).open)||$('draft-dialog').open||$('logout-dialog').open; }
function localPending() { return editedForms.size||dirty.size||invalidInputs.size||savingPromise||pageContentDirty()||contentSaving||contentUploads.size||memberAvatarUploading||memberSaving||accountSaving||modalEditing(); }
function renderSync() {
  $('sync-time').textContent=syncError?syncError:lastSyncAt?`上次同步 ${new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(lastSyncAt)}`:'等待同步';
  $('sync-refresh').disabled=syncRunning;
  $('remote-update').hidden=!pendingRemote&&!recovery;
  $('remote-update-message').textContent=recovery?'草稿已保留，请处理与最新账单的差异。':'其他人更新了账单，当前编辑已保留。';
}
function acceptRemote(remote) {
  state=structuredClone(remote);serverState=structuredClone(remote);pendingRemote=null;recovery=null;lastSyncAt=new Date();
  renderExpenses();renderAdmin();renderSync();renderGatheringAdmin();
}
function receiveConflict(remote) {
  clearTimeout(saveTimer);
  const drafts=recovery?.drafts||draftSnapshot();
  pendingRemote=remote;
  recovery={remote,drafts};saveFailed=true;
  saveStatus('账单有更新 · 草稿已保留','error');updateExpenseControls();renderSync();
  if(!quitting&&!modalEditing())openDraftRecovery();
}
function openDraftRecovery() {
  if(!pendingRemote&&!recovery)return;
  const remote=pendingRemote||recovery.remote,drafts=recovery?.drafts||draftSnapshot();
  if(!drafts.length){if(modalEditing()||pageContentDirty()||editedForms.size){toast('请先保存或清空当前表单，关闭编辑窗口，再载入最新账单。');return;}recovery=null;acceptRemote(remote);toast('已同步最新账单');return;}
  recovery={remote,drafts};clearTimeout(saveTimer);
  $('draft-list').innerHTML=drafts.map(draft=>{
    const item=inspectDraft(remote,draft),names=draft.participantIds.map(id=>state.members.find(m=>m.id===id)?.name||'已删除成员').join('、')||'无人参与';
    return `<article class="draft-card"><h3>${esc(draft.title)}</h3><div class="draft-comparison"><div><small>你的草稿</small><strong>${draft.raw!==null?esc(draft.raw):formatMoney(draft.amountCents)}</strong><span>${esc(names)}</span></div><div><small>服务器最新</small><strong>${item.expense?formatMoney(item.expense.amountCents):'已删除'}</strong><span>${item.expense?esc(item.expense.participantIds.map(id=>remote.members.find(m=>m.id===id)?.name||'未知成员').join('、')):''}</span></div></div>${item.conflicts.length?`<p class="draft-warning">${esc(item.conflicts.join('、'))}已被其他人修改，请确认。</p>`:''}${item.reason?`<p class="draft-warning">${esc(item.reason)} 你仍可复制上面的输入。</p>`:''}${draft.raw!==null?'<p class="admin-form-note">含未通过校验的原始金额，恢复后需先修正。</p>':''}<label class="check-label"><input type="checkbox" data-restore-draft="${esc(draft.id)}" ${item.canRestore?'':'disabled'}>恢复我修改的字段</label></article>`;
  }).join('');showError('draft-error','');if(!$('draft-dialog').open)$('draft-dialog').showModal();
}
async function syncRemote(manual=false) {
  if(!state||syncRunning||document.hidden&&!manual||quitting)return;
  syncRunning=true;renderSync();
  try{
    const [remote,remoteContent]=await Promise.all([api('/api/state'),api('/api/content')]);
    lastSyncAt=new Date();syncError='';
    if(remote.version>(serverState?.version||0)){
      if(localPending()){if(!pendingRemote||remote.version>=pendingRemote.version)pendingRemote=remote;if(recovery&&remote.version>=recovery.remote.version)recovery.remote=remote;}
      else acceptRemote(remote);
    }
    if(remoteContent.version>content.version&&!pageContentDirty()&&!contentSaving&&!contentUploads.size){content=copyContent(remoteContent);contentLoaded=true;resetContentDraft();applyContent();}
    if(manual){if(pendingRemote)openDraftRecovery();else toast('已同步最新账单');}
  }catch(error){if(manual)toast(error.message);syncError='同步失败 · 可手动重试';}
  finally{syncRunning=false;renderSync();}
}
function showError(id, message) { $(id).textContent = message; $(id).hidden = !message; }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; },3500); }
function saveStatus(message, status='') { $('save-status').textContent = message; $('save-status').dataset.status = status; }
function openLogin() { showError('login-error',''); $('login-dialog').showModal(); }
function renderAuth() {
  const identity = user ? `${user.id}:${user.username}:${user.role}` : '';
  if (identity !== authIdentity) { authIdentity = identity; accounts = []; accountListGeneration++; closeAccountEditor(); resetAuditLogs(); }
  $('accounts-section').hidden = !isAdmin();
  adminTabs.forEach(tab=>{$(`${tab}-tab`).hidden=!canAccessAdminTab(tab);});
  if(!canAccessAdminTab(adminTab))adminTab='expenses';
  renderAdminTabs();
  $('history-nav').hidden=!user;
  document.querySelectorAll('[data-admin-shortcut]').forEach(button=>{button.hidden=!canManageLedger();});
  $('guest-banner').hidden = Boolean(user);
  $('auth-button').innerHTML = `${icon(user ? 'people' : 'lock')}<span>${user ? `${esc(user.username)} · 退出` : '登录编辑'}</span>`;
  $('expense-edit-hint').textContent = state?.currentGathering?.status==='finalized'?'账单已定稿 · 只读':user?'修改后自动保存':'登录后可编辑';
  $('admin-nav').querySelector('.nav-lock').innerHTML = icon(canManageLedger() ? 'arrow' : 'lock');
  if (state) {renderAdmin();renderGatheringAdmin();renderAdvances();}
  if (state) updateExpenseControls();
  updateContentStatus();
  if (!canManageLedger() && currentView === 'admin') switchView('ledger');
  if(!user){$('gathering-list').innerHTML='';$('history-detail-content').innerHTML='';if($('history-detail-dialog').open)$('history-detail-dialog').close();$('sessions-list').innerHTML='';$('backup-status').innerHTML='';if(currentView==='history')switchView('ledger');}
}
function emptyCard(message, actionLabel='打开管理后台',tab='expenses') {
  return `<div class="empty-card"><span class="empty-card-icon">${icon('people')}</span><h3>${esc(message)}</h3><button class="button button-outline" type="button" data-open-admin-tab="${esc(tab)}" data-open-add-form>${esc(actionLabel)}</button></div>`;
}
function renderSummary() {
  if (!state) return;
  renderBreadcrumb();
  ledger = calculateLedger(state);
  $('current-gathering-label').textContent=state.currentGathering?`${state.currentGathering.name} · ${state.currentGathering.date}`:content.texts.gatheringName;
  $('current-gathering-status').textContent=state.currentGathering?.status==='finalized'?'已定稿':'进行中';
  const showPeople = state.expenses.length > 0;
  $('people-section').hidden = !showPeople;
  ['people','settlement'].forEach(tab=>{$(`ledger-${tab}-tab`).hidden=!showPeople;});
  if(!showPeople&&ledgerTab!=='expenses')ledgerTab='expenses';
  renderLedgerTabs();
  $('hero-total').textContent = moneyDigits(ledger.totalCents);
  $('hero-total').classList.toggle('is-large', moneyDigits(ledger.totalCents).length > 8);
  $('bar-total').textContent = formatMoney(ledger.totalCents);
  $('bar-allocated').textContent = formatMoney(ledger.allocatedCents);
  $('balance-result').classList.toggle('unbalanced', !ledger.balanced);
  $('balance-label').textContent = ledger.balanced ? '分账已核对' : '金额尚未配平';
  $('balance-difference').textContent = `差额 ${formatMoney(Math.abs(ledger.differenceCents))}`;
  $('people-grid').innerHTML = !showPeople ? '' : ledger.people.length ? ledger.people.map((person,index) => `<article class="person-card color-${colorClass(person,index)}"><div class="person-top">${avatarMarkup(person)}<span class="person-index">${String(index+1).padStart(2,'0')}</span></div><button class="person-name" data-person="${esc(person.id)}" aria-label="查看${esc(person.name)}的费用明细">${esc(person.name)}${icon('arrow')}</button>${person.note?`<p class="person-note">${esc(person.note)}</p>`:''}<div class="person-amount-label">分摊份额</div><div class="person-amount ${moneyDigits(person.totalCents).length>8?'is-large':''}"><span>¥</span>${moneyDigits(person.totalCents)}</div><div class="person-net"><span>已垫付 ${formatMoney(person.paidCents||0)}</span><strong>${ledger.settlementReady?'':'暂算'}${(person.netCents||0)>0?'应收':'待付'} ${formatMoney(Math.abs(person.netCents??-person.totalCents))}</strong></div><div class="person-divider"></div><div class="person-chips">${person.items.map(item => `<span class="person-chip ${item.participating?'':'absent'}">${esc(expenseTitle(item))}</span>`).join('')}</div></article>`).join('') : emptyCard('还没有聚餐成员','在后台添加成员','members');
  ledger.expenses.forEach(expense => {
    const card = document.querySelector(`[data-expense="${CSS.escape(expense.id)}"]`);
    if (!card) return;
    card.querySelector('.participants-count').textContent = `${expense.participantCount} 人分摊`;
    const names=[...state.members].sort((a,b)=>a.order-b.order).filter(member=>expense.participantIds.includes(member.id)).map(member=>member.name);
    card.querySelector('.participants-summary').textContent=names.length?names.join('、'):'尚未选择参与人';
    const range = expense.remainderCents ? `${formatMoney(expense.baseCents)}–${formatMoney(expense.baseCents+1)}` : formatMoney(expense.baseCents);
    card.querySelector('.expense-allocation').innerHTML = `<span${expense.remainderCents ? ' class="has-remainder"' : ''}>${expense.remainderCents ? `含 ${expense.remainderCents} 分尾差` : '每人分摊'}</span><strong>${expense.participantCount ? range : '暂无分摊'}</strong>`;
    card.classList.toggle('is-pending', dirty.has(expense.id));
  });
  renderAdvances();
  if (!showPeople && $('detail-dialog').open) { $('detail-dialog').close(); detailMemberId = null; }
  else if ($('detail-dialog').open && detailMemberId) renderDetail(detailMemberId);
}
function renderExpenses() {
  $('expense-edit-hint').textContent=state.currentGathering?.status==='finalized'?'账单已定稿 · 只读':user?'修改后自动保存':'登录后可编辑';
  if($('participants-dialog').open)$('participants-dialog').close();
  invalidInputs.clear();
  $('expense-grid').innerHTML = state.expenses.length ? state.expenses.map(expense => `<article class="expense-card" data-expense="${esc(expense.id)}" data-kind="${kind(expense)}"><div class="expense-top"><span class="expense-icon">${icon(kind(expense))}</span><h3 class="expense-title">${esc(expenseTitle(expense))}</h3></div><div class="expense-amount-group"><label class="field-caption" for="amount-${esc(expense.id)}">费用金额<span class="currency-hint">人民币 / 元</span></label><div class="amount-control"><span aria-hidden="true">¥</span><input class="amount-input" id="amount-${esc(expense.id)}" data-amount="${esc(expense.id)}" type="text" inputmode="decimal" value="${(expense.amountCents/100).toFixed(2)}" maxlength="12" aria-describedby="error-${esc(expense.id)}" ${user?'':'disabled'} autocomplete="off"></div><div class="field-error" id="error-${esc(expense.id)}" role="alert" hidden></div></div><div class="expense-participants-group"><div class="participants-caption"><span>参与分摊</span><span class="participants-count"></span></div><p class="participants-summary"></p><button type="button" class="button button-outline participant-picker-button" data-select-participants="${esc(expense.id)}">${icon('people')}<span>${user?'选择参与人':'查看参与人'}</span></button></div><div class="expense-allocation"></div></article>`).join('') : emptyCard('还没有费用项目','在后台添加费用');
  updateExpenseControls(); renderSummary();
}
function updateExpenseControls() {
  document.querySelectorAll('[data-amount]').forEach(input => { input.disabled = !canEditLedger(); });
  document.querySelectorAll('[data-select-participants] span').forEach(span=>{span.textContent=canEditLedger()?'选择参与人':'查看参与人';});
}
function fieldError(expenseId,message) {
  const input = document.querySelector(`[data-amount="${CSS.escape(expenseId)}"]`);
  if (!input) return;
  input.setAttribute('aria-invalid',String(Boolean(message)));
  input.closest('.amount-control').classList.toggle('invalid',Boolean(message));
  showError(`error-${expenseId}`,message);
  if (message) invalidInputs.set(expenseId,message); else invalidInputs.delete(expenseId);
}
function markDirty(expense) {
  const revision = (revisions.get(expense.id)||0)+1;
  revisions.set(expense.id,revision); dirty.set(expense.id,revision); saveFailed = false;
  saveStatus('等待保存…','saving'); renderSummary();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { flushSaves().catch(()=>{}); },500);
}
async function flushSaves() {
  clearTimeout(saveTimer);
  if(quitting)return;
  if(recovery)throw new Error('请先处理保留的草稿，再继续保存。');
  if(savingPromise){await savingPromise;if(dirty.size&&!recovery)return flushSaves();return;}
  if(!dirty.size)return;
  if(!canEditLedger())throw new Error(user?'当前账单不可编辑。':'登录后才能保存修改。');
  savingPromise=(async()=>{
    while(dirty.size&&!quitting&&!recovery){
      const entry=[...dirty.entries()].find(([id])=>!invalidInputs.has(id));
      if(!entry)break;
      const [expenseId,revision]=entry,expense=state.expenses.find(item=>item.id===expenseId);
      if(!expense){dirty.delete(expenseId);continue;}
      const body={amountCents:expense.amountCents,participantIds:[...expense.participantIds],version:state.version};
      saveStatus('正在保存…','saving');
      try{
        const remote=await api(`/api/expenses/${encodeURIComponent(expenseId)}`,{method:'PATCH',body});
        if((revisions.get(expenseId)||0)===revision)dirty.delete(expenseId);
        const nextBase=structuredClone(serverState||state),savedExpense=nextBase.expenses.find(item=>item.id===expenseId);
        if(savedExpense)Object.assign(savedExpense,{amountCents:body.amountCents,participantIds:[...body.participantIds]});
        const drafts=draftSnapshot(nextBase), restored=reconcileDrafts(remote,drafts,new Set(drafts.filter(d=>inspectDraft(remote,d).canRestore).map(d=>d.id)));
        state=restored.state;serverState=structuredClone(remote);lastSyncAt=new Date();
        if(pendingRemote&&pendingRemote.version<=remote.version)pendingRemote=null;
        renderSummary();renderSync();
      }catch(error){
        saveFailed=true;
        if(error.status===409&&error.data.state)receiveConflict(error.data.state);
        else{
          const notice=error.status===401?'登录已过期。草稿仍保留，重新登录后可比较最新账单再恢复。':`${error.message} 当前输入仍保留。`;
          $('global-error').innerHTML=`${esc(notice)} <button class="save-retry" id="retry-save">${error.status===401?'重新登录':'重试保存'}</button>`;$('global-error').hidden=false;saveStatus('尚未保存','error');renderSummary();
        }
        throw error;
      }
    }
    if(!recovery){saveFailed=false;showError('global-error','');saveStatus(invalidInputs.size?'请检查金额输入':dirty.size?'尚未保存':'全部修改已保存',invalidInputs.size||dirty.size?'error':'');}
  })();
  try{await savingPromise;}finally{savingPromise=null;}
}
function renderDetail(memberId) {
  const person = ledger.people.find(item => item.id === memberId);
  if (!person) { $('detail-dialog').close(); return; }
  detailMemberId = memberId;
  $('detail-content').innerHTML = `${avatarMarkup(person,`detail-avatar color-${colorClass(person)}`)}<h2 id="detail-heading">${esc(person.name)}的费用明细</h2>${person.note?`<p class="dialog-description">${esc(person.note)}</p>`:''}<div class="detail-caption">分摊份额 · 人民币</div><div class="detail-total ${moneyDigits(person.totalCents).length>8?'is-large':''}"><span>¥</span>${moneyDigits(person.totalCents)}</div><div class="detail-list">${person.items.length?person.items.map(item => {
    const expense = state.expenses.find(exp => exp.id===item.expenseId);
    return `<div class="detail-row ${item.participating?'':'absent'}"><span class="expense-icon">${icon(kind(expense))}</span><div><div class="detail-row-title">${esc(expenseTitle(item))}${item.remainderExtra?'<span class="remainder-pill">尾差 +¥0.01</span>':''}</div><div class="detail-row-note">${item.participating ? `总额 ${formatMoney(expense.amountCents)} · ${item.participantCount} 人分摊${item.remainderExtra ? `<br>基础份额 ${formatMoney(item.baseCents)} + 尾差 ¥0.01` : ''}` : '本笔未参与分摊'}</div></div><strong class="detail-row-amount">${item.participating?formatMoney(item.amountCents):'—'}</strong></div>`;
  }).join(''):'<p class="detail-empty">暂无费用记录</p>'}</div><div class="detail-payment-summary"><div><span>已记录垫付</span><strong>${formatMoney(person.paidCents||0)}</strong></div><div><span>${ledger.settlementReady?'':'暂算'}${(person.netCents||0)>0?'应收':'待付'}</span><strong>${formatMoney(Math.abs(person.netCents??-person.totalCents))}</strong></div>${!ledger.settlementReady?'<p>垫付尚未录全，净额暂供参考。</p>':''}</div>`;
}
function renderLedgerTabs() {
  ledgerTabs.forEach(tab=>{
    const active=ledgerTab===tab;
    $(`ledger-${tab}-tab`).classList.toggle('active',active);
    $(`ledger-${tab}-tab`).setAttribute('aria-selected',String(active));
    $(`ledger-${tab}-tab`).tabIndex=active?0:-1;
    $(`ledger-${tab}-panel`).hidden=!active;
  });
}
function setLedgerTab(tab,focus=false) {
  if(!ledgerTabs.includes(tab)||(tab!=='expenses'&&!state?.expenses.length))return;
  ledgerTab=tab;renderLedgerTabs();
  if(focus)$(`ledger-${tab}-tab`).focus();
}
function nextNavigationTab(tabs,current,key) {
  if(!tabs.length)return null;
  if(key==='Home')return tabs[0];
  if(key==='End')return tabs.at(-1);
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return null;
  const forward=['ArrowRight','ArrowDown'].includes(key);
  return tabs[(Math.max(0,tabs.indexOf(current))+(forward?1:-1)+tabs.length)%tabs.length];
}
function renderBreadcrumb() {
  const labels={expenses:'费用管理',members:'聚餐成员',gatherings:'聚餐管理',accounts:'登录账户',security:'账户安全',content:'页面编辑',backups:'自动备份',logs:'操作日志'};
  const parent=currentView==='admin'?'管理后台':currentView==='ledger'?'当前聚餐':'聚餐空间';
  const title=currentView==='admin'?labels[adminTab]:currentView==='history'?'聚餐历史':currentView==='releases'?'更新日志':state?.currentGathering?.name||content.texts.gatheringName;
  document.querySelector('.breadcrumb').innerHTML=`${esc(parent)} <span>/</span> <strong>${esc(title)}</strong>`;
}
function switchView(view) {
  if (!['ledger','admin','releases','history'].includes(view) || (view==='admin'&&!canManageLedger()) || (view==='history'&&!user)) return;
  currentView=view;
  ['ledger','admin','releases','history'].forEach(key=>{
    $(`${key}-view`).hidden=view!==key;
    $(`${key}-nav`).classList.toggle('active',view===key);
    if(view===key)$(`${key}-nav`).setAttribute('aria-current','page');else $(`${key}-nav`).removeAttribute('aria-current');
  });
  renderBreadcrumb();
  if(view==='releases')loadReleases();
  if(view==='history')loadGatherings();
  window.scrollTo({top:0,behavior:'instant'});
}
function releaseDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return '';
  const date=new Date(`${value}T00:00:00Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)return '';
  return `<time datetime="${esc(value)}">${Number(value.slice(0,4))} 年 ${Number(value.slice(5,7))} 月 ${Number(value.slice(8))} 日</time>`;
}
function releaseChanges(changes) {
  return `<ul class="release-changes">${changes.map(change=>`<li>${esc(change)}</li>`).join('')}</ul>`;
}
async function loadReleases() {
  if(releasesLoaded||releasesLoading)return;
  releasesLoading=true;
  $('releases-error').hidden=true;$('releases-status').hidden=false;
  $('releases-status').textContent='正在加载更新记录…';$('releases-retry').disabled=true;
  try {
    const attempt=releaseLoadAttempt++;
    const {CURRENT_VERSION,RELEASES}=await import(attempt?`./releases.js?retry=${attempt}`:'./releases.js');
    if(typeof CURRENT_VERSION!=='string'||!Array.isArray(RELEASES)||!RELEASES.length)throw new Error('invalid releases');
    const records=RELEASES.filter(item=>item&&typeof item.version==='string'&&typeof item.title==='string'&&Array.isArray(item.changes)&&item.changes.every(change=>typeof change==='string'));
    const current=records.find(item=>item.version===CURRENT_VERSION);
    if(!current)throw new Error('missing current release');
    $('current-release').innerHTML=`<article class="release-current-card" aria-labelledby="current-release-heading"><div class="release-current-top"><span class="release-current-label">当前版本</span><span class="release-version">${esc(current.version)}</span>${releaseDate(current.date)}</div><h2 id="current-release-heading">${esc(current.title)}</h2>${releaseChanges(current.changes)}</article>`;
    const history=records.filter(item=>item!==current);
    $('release-history-list').innerHTML=history.map(item=>`<details class="release-history-card"><summary><span class="release-history-meta"><strong>${esc(item.version)}</strong>${releaseDate(item.date)}</span><span class="release-history-title">${esc(item.title)}</span><span class="release-expand" aria-hidden="true">${icon('chevron')}</span></summary>${releaseChanges(item.changes)}</details>`).join('');
    $('release-history').hidden=!history.length;
    releasesLoaded=true;$('releases-status').hidden=true;
  } catch {
    $('releases-status').hidden=true;$('releases-error').hidden=false;
    $('releases-error-message').textContent='更新记录暂时无法加载，请稍后重试。';
  } finally {releasesLoading=false;$('releases-retry').disabled=false;}
}
async function openReleases() {
  if(currentView==='releases'){loadReleases();return;}
  if(invalidInputs.size){toast('请先修正标红的金额，再查看更新日志。');return;}
  try {await flushSaves();switchView('releases');}
  catch(error){toast(`查看更新日志前需要完成保存：${error.message}`);}
}
function renderAdmin() {
  if(!state)return;
  ['member-form','expense-form'].forEach(id=>$(id).querySelectorAll('input,select,button').forEach(el=>el.disabled=!canEditLedger()));
  $('admin-expenses').innerHTML=state.expenses.length?state.expenses.map(expense=>`<div class="admin-row"><span class="expense-icon">${icon(kind(expense))}</span><div class="admin-row-info"><strong>${esc(expense.title)}</strong><p>${formatMoney(expense.amountCents)} · ${expense.participantIds.length} 人分摊</p></div><div class="admin-row-actions"><button class="admin-edit" ${canEditLedger()?'':'disabled'} data-edit-expense="${esc(expense.id)}">改名</button>${isAdmin()?`<button class="admin-delete" ${canEditLedger()?'':'disabled'} data-delete-expense="${esc(expense.id)}">删除</button>`:''}</div></div>`).join(''):'<p class="admin-empty">尚未添加费用，请在下方输入自定义费用名称。</p>';
  $('admin-members').innerHTML = state.members.length?[...state.members].sort((a,b)=>a.order-b.order).map((member,index) => `<div class="admin-row">${avatarMarkup(member,`admin-member-avatar color-${colorClass(member,index)}`)}<div class="admin-row-info"><strong>${esc(member.name)}</strong><p>${member.note?`${esc(member.note)} · `:''}尾差顺序 ${index+1}</p></div><div class="admin-row-actions"><button class="admin-edit" ${canEditLedger()?'':'disabled'} data-edit-member="${esc(member.id)}">编辑</button>${isAdmin()?`<button class="admin-delete" ${canEditLedger()?'':'disabled'} data-delete-member="${esc(member.id)}">删除</button>`:''}</div></div>`).join(''):'<p class="admin-empty">尚未添加成员，请在下方填写成员姓名。</p>';
  $('admin-accounts').innerHTML = isAdmin() ? accounts.map(account => `<div class="admin-row"><div class="avatar admin-member-avatar">${icon('people')}</div><div class="admin-row-info"><strong>${esc(account.username)}</strong><p>${account.id===user?.id?'当前登录账户':'由管理员分配'}</p></div><span class="admin-role">${account.role==='admin'?'管理员':'编辑者'}</span><div class="admin-row-actions"><button class="admin-edit" data-edit-account="${esc(account.id)}">编辑</button><button class="admin-edit" data-reset-password="${esc(account.id)}">重设密码</button><button class="admin-delete" data-delete-account="${esc(account.id)}" ${account.id===user?.id?'disabled':''}>删除</button></div></div>`).join('') : '';
}
async function adminAction(action,form=null) {
  showError('admin-error','');
  const button = form?.querySelector('[type="submit"]');
  if (button) button.disabled=true;
  try { await flushSaves(); if(invalidInputs.size)throw new Error('请先修正金额，或放弃修改。');await action();serverState=structuredClone(state);renderGatheringAdmin(); renderExpenses(); renderAdmin(); toast('管理设置已保存'); if(form){form.reset();editedForms.delete(form.id);} }
  catch(error) { showError('admin-error',error.message); if(error.status===409 && error.data.state) receiveConflict(error.data.state); }
  finally { if(button) button.disabled=false; }
}
function pageContentDirty() {
  return JSON.stringify({texts:contentDraft.texts,images:contentDraft.images}) !== JSON.stringify({texts:content.texts,images:content.images});
}
function setContentImage(element, image) {
  if (!element) return;
  const valid = isContentImageSource(image.src, true);
  element.hidden = !image.src || !valid;
  if (image.src && valid) element.src = image.src; else element.removeAttribute('src');
  element.alt = image.alt || '';
  element.style.objectFit = image.fit === 'cover' ? 'cover' : 'contain';
  element.style.objectPosition = ['top','bottom'].includes(image.position) ? image.position : 'center';
}
function applyContent() {
  document.title = content.texts.documentTitle;
  document.querySelectorAll('[data-content]').forEach(element => {
    if (Object.hasOwn(content.texts,element.dataset.content)) element.textContent=content.texts[element.dataset.content];
  });
  document.querySelector('.brand').setAttribute('aria-label',`${content.texts.brandName}首页`);
  setContentImage($('sidebar-image'),content.images.sidebar);
  setContentImage($('brand-image'),content.images.brand);
  $('brand-mark').hidden=Boolean(content.images.brand.src);
  renderBreadcrumb();
  if(state) renderSummary();
}
function updateContentStatus() {
  const pending=pageContentDirty(), busy=contentSaving||Boolean(contentUploads.size), canSave=user?.role==='admin'&&contentLoaded;
  $('content-dirty-dot').hidden=!pending;
  const previewStatus=document.querySelector('.content-preview-top>span');
  previewStatus.textContent=!contentLoaded?'默认内容预览':pending?'预览未保存':'已保存的内容';
  previewStatus.dataset.saved=String(contentLoaded&&!pending);
  $('content-version').textContent=`页面版本 ${content.version}`;
  const status=$('content-editor-status');
  status.textContent=contentSaving?'正在保存页面…':contentUploads.size?'正在上传图片…':!contentLoaded?'页面内容尚未加载':contentConflict?'版本冲突 · 草稿已保留':contentSaveFailed?'保存失败 · 草稿已保留':pending?'有未保存的修改':'内容已保存';
  status.dataset.status=!contentLoaded||contentSaveFailed||contentConflict?'error':busy?'saving':pending?'dirty':'';
  $('content-save').disabled=!canSave||busy||!pending||Boolean(contentConflict);
  $('content-revert').disabled=contentSaving||(!pending&&!contentUploads.size);
  $('content-defaults').disabled=contentSaving||!contentLoaded;
  $('content-overwrite').disabled=!canSave||busy;
  $('content-use-latest').disabled=contentSaving;
  $('content-form').querySelectorAll('[data-content-field],[data-image-setting]').forEach(input=>{input.disabled=contentSaving||!canSave;});
  document.querySelectorAll('[data-upload-image]').forEach(input=>{
    input.disabled=contentSaving||!canSave||contentUploads.has(input.dataset.uploadImage);
    input.closest('.content-upload-label').dataset.disabled=String(input.disabled);
  });
  document.querySelectorAll('[data-reset-image],[data-remove-image]').forEach(button=>{button.disabled=contentSaving||!canSave;});
}
function renderContentEditor() {
  const groups=[...new Set(CONTENT_TEXT_FIELDS.map(field=>field.group))];
  const previousOpen=[...$('content-text-fields').querySelectorAll('details[open]')].map(element=>element.dataset.group);
  $('content-text-fields').innerHTML=groups.map((group,index)=>`<section class="content-editor-card"><details data-group="${esc(group)}" ${previousOpen.length?previousOpen.includes(group)?'open':'':index<2?'open':''}><summary><span>${String(index+1).padStart(2,'0')} · ${esc(group)}</span></summary><div class="content-fields-grid">${CONTENT_TEXT_FIELDS.filter(field=>field.group===group).map(field=>`<label class="content-field ${field.multiline||field.maxLength>100?'content-field-wide':''}"><span class="content-field-caption"><span>${esc(field.label)}</span><small id="count-${esc(field.key)}">${contentDraft.texts[field.key].length}/${field.maxLength}</small></span>${field.multiline?`<textarea data-content-field="${esc(field.key)}" name="${esc(field.key)}" maxlength="${field.maxLength}" required rows="3" aria-describedby="count-${esc(field.key)}">${esc(contentDraft.texts[field.key])}</textarea>`:`<input data-content-field="${esc(field.key)}" name="${esc(field.key)}" maxlength="${field.maxLength}" value="${esc(contentDraft.texts[field.key])}" required aria-describedby="count-${esc(field.key)}">`}</label>`).join('')}</div></details></section>`).join('');
  $('content-image-fields').innerHTML=['sidebar','brand'].map(key=>{
    const image=contentDraft.images[key];
    return `<div class="content-image-editor"><div class="content-image-heading"><strong>${key==='sidebar'?'侧栏插画':'品牌标志'}</strong><small>${key==='sidebar'?'左下角 · 正方形画框':'可选 · 替换左上角图标'}</small></div><div class="content-image-row"><div class="content-image-thumbnail"><img id="thumbnail-${key}" alt="${esc(image.alt)}" ${image.src?`src="${esc(image.src)}"`:'hidden'}><span id="empty-${key}" class="content-image-empty" aria-hidden="true" ${image.src?'hidden':''}>✳</span></div><div class="content-image-tools"><label class="button button-outline content-upload-label"><span id="upload-label-${key}">选择图片</span><input id="upload-${key}" data-upload-image="${key}" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传${key==='sidebar'?'侧栏插画':'品牌标志'}"></label><button class="button button-outline" type="button" data-reset-image="${key}">恢复默认</button>${key==='brand'?'<button class="button button-outline" type="button" data-remove-image="brand">移除标志</button>':''}<p id="upload-hint-${key}" class="content-upload-hint">${key==='sidebar'?'建议使用接近正方形的图片。完整显示可保留画面。':'未上传时显示原有品牌图标。'}<br>选图后仍需点击「保存页面」。</p></div></div><div class="content-image-controls"><label>显示方式<select data-image-setting="fit" data-image-key="${key}"><option value="contain" ${image.fit==='contain'?'selected':''}>完整显示原图</option><option value="cover" ${image.fit==='cover'?'selected':''}>填满画框（可能裁切）</option></select></label><label>图片对齐<select data-image-setting="position" data-image-key="${key}"><option value="center" ${image.position==='center'?'selected':''}>居中</option><option value="top" ${image.position==='top'?'selected':''}>顶部</option><option value="bottom" ${image.position==='bottom'?'selected':''}>底部</option></select></label><label class="content-image-alt">图片替代文字<input data-image-setting="alt" data-image-key="${key}" maxlength="120" value="${esc(image.alt)}" placeholder="向无法看到图片的人描述画面"></label></div></div>`;
  }).join('');
  renderContentPreview();updateContentStatus();
}
function renderContentPreview() {
  const texts=contentDraft.texts;
  const mapping={'preview-brand-name':'brandName','preview-workspace':'workspaceLabel','preview-title-first':'heroTitleLine1','preview-title-second':'heroTitleLine2','preview-people-heading':'peopleHeading','preview-expenses-heading':'expensesHeading'};
  Object.entries(mapping).forEach(([id,key])=>{$(id).textContent=texts[key];});
  const activeField=CONTENT_TEXT_FIELDS.find(field=>field.key===contentPreviewField)||CONTENT_TEXT_FIELDS[0];
  $('preview-field-label').textContent=`当前文字 · ${activeField.label}`;
  $('preview-field-value').textContent=texts[activeField.key];
  setContentImage($('preview-sidebar-image'),contentDraft.images.sidebar);
  setContentImage($('preview-brand-image'),contentDraft.images.brand);
  $('preview-brand-mark').hidden=Boolean(contentDraft.images.brand.src);
  ['sidebar','brand'].forEach(key=>{
    setContentImage($(`thumbnail-${key}`),contentDraft.images[key]);
    if($(`empty-${key}`))$(`empty-${key}`).hidden=Boolean(contentDraft.images[key].src);
  });
}
function renderAdminTabs() {
  renderBreadcrumb();
  adminTabs.forEach(key=>{
    const active=key===adminTab&&canAccessAdminTab(key);
    $(`${key}-tab`).classList.toggle('active',active);
    $(`${key}-tab`).setAttribute('aria-selected',String(active));
    $(`${key}-tab`).tabIndex=active?0:-1;
    $(`${key}-panel`).hidden=!active;
  });
}
function setAdminTab(tab) {
  if(!canAccessAdminTab(tab))return;
  adminTab=tab;renderAdminTabs();
  if(tab==='content')updateContentStatus();
  if(tab==='gatherings')renderGatheringAdmin();if(tab==='security')loadSessions();if(tab==='backups')loadBackups();
  if(tab==='logs'&&!auditLogs.length&&!auditLoading)loadAuditLogs();
}
function resetAuditLogs() {
  auditGeneration++;auditLogs=[];auditLoading=false;auditError='';auditHasMore=false;auditBefore=null;
  renderAuditLogs();
}
function auditTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? beijingTime.format(date) : '时间未知';
}
function renderAuditLogs() {
  const permitted=isAdmin();
  const visibleLogs=permitted?auditLogs:[];
  $('audit-list').innerHTML=visibleLogs.length?visibleLogs.map(entry=>`<article class="audit-log-card"><div class="audit-log-top"><time datetime="${esc(entry.createdAt)}">${esc(auditTime(entry.createdAt))}</time><span class="audit-log-account">${icon('people')}<strong>${esc(entry.username||'未知账号')}</strong><span>${entry.role==='admin'?'管理员':entry.role==='editor'?'编辑者':'访客'}</span></span></div><p class="audit-log-summary">${esc(entry.summary||entry.action||'操作记录')}</p><div class="audit-log-network"><span>登录 IP <code>${esc(entry.loginIp||entry.ip||'未记录')}</code></span>${entry.ip&&entry.loginIp&&entry.ip!==entry.loginIp?`<span>操作 IP <code>${esc(entry.ip)}</code></span>`:''}</div></article>`).join(''):`<div class="audit-empty"><span class="empty-card-icon">${icon('receipt')}</span><h3>${auditLoading?'正在读取操作记录…':auditError?'暂时无法读取日志':'暂无操作日志'}</h3><p>${auditLoading?'请稍候':auditError?'请点击刷新重试。':'新的登录和管理操作会显示在这里。'}</p></div>`;
  showError('audit-error',permitted?auditError:'');
  $('audit-status').textContent=!permitted?'':auditLoading?'正在读取…':visibleLogs.length?`已显示 ${visibleLogs.length} 条记录${auditHasMore?'':' · 已全部加载'}`:'';
  $('audit-list').setAttribute('aria-busy',String(permitted&&auditLoading));
  $('audit-refresh').disabled=!permitted||auditLoading;
  $('audit-more').hidden=!permitted||!auditHasMore;
  $('audit-more').disabled=auditLoading;
  $('audit-more').textContent=auditLoading?'正在加载…':'加载更早记录';
}
async function loadAuditLogs(more=false) {
  if(!isAdmin()||auditLoading||(more&&!auditHasMore))return;
  const generation=++auditGeneration,identity=authIdentity;
  auditLoading=true;auditError='';renderAuditLogs();
  try {
    const query=new URLSearchParams({limit:'50'});
    if(more&&auditBefore)query.set('before',auditBefore);
    const result=await api(`/api/admin/logs?${query}`);
    if(generation!==auditGeneration||identity!==authIdentity||!isAdmin())return;
    if(!Array.isArray(result.logs))throw new Error('日志返回格式异常，请刷新重试。');
    const entries=result.logs.filter(entry=>entry&&typeof entry==='object');
    auditLogs=more?[...auditLogs,...entries.filter(entry=>!auditLogs.some(existing=>existing.id===entry.id))]:entries;
    auditBefore=typeof result.nextBefore==='string'?result.nextBefore:null;
    auditHasMore=Boolean(result.hasMore&&auditBefore);
  } catch(error) {
    if(generation!==auditGeneration||identity!==authIdentity||!isAdmin())return;
    auditError=error.message;
  } finally {
    if(generation===auditGeneration&&identity===authIdentity&&isAdmin()){auditLoading=false;renderAuditLogs();}
  }
}
function resetContentDraft(source=content) {
  uploadGeneration++;
  contentUploads.clear();
  contentDraft=copyContent(source);contentDraft.version=content.version;
  contentConflict=null;contentSaveFailed=false;
  $('content-conflict').hidden=true;showError('content-editor-error','');renderContentEditor();
}
function requestContentLeave(action) {
  if(contentSaving){toast('页面正在保存，请稍候。');return;}
  if(!pageContentDirty()&&!contentUploads.size){action();return;}
  pendingLeave=action;
  $('content-leave-dialog').showModal();
}
function contentLoadError(message) {
  $('content-load-message').textContent=`${contentLoaded?'页面内容刷新失败，仍显示上次读取的内容。':'页面内容读取失败，当前展示默认内容。'}${message}`;
  $('retry-content').hidden=false;
  $('content-load-error').hidden=false;
  updateContentStatus();
}
async function reloadContent() {
  const button=$('retry-content');button.disabled=true;
  try {
    content=copyContent(await api('/api/content'));contentLoaded=true;resetContentDraft();applyContent();$('content-load-error').hidden=true;$('retry-content').hidden=false;toast('已载入页面内容');
  } catch(error){contentLoadError(error.message);}
  finally{button.disabled=false;}
}
async function saveContent(confirmedVersion=null) {
  if(contentSaving||contentUploads.size||!contentLoaded||user?.role!=='admin')return;
  if(contentConflict&&confirmedVersion===null){toast('请先选择如何处理最新版本和当前草稿。');return;}
  for(const field of CONTENT_TEXT_FIELDS) {
    const input=$('content-form').querySelector(`[data-content-field="${field.key}"]`);
    input.setCustomValidity(input.value.trim()?'':'请填写内容，不能只输入空格。');
  }
  const invalid=$('content-form').querySelector(':invalid');
  if(invalid){const section=invalid.closest('details');if(section)section.open=true;invalid.focus();$('content-form').reportValidity();return;}
  const payload=copyContent(contentDraft);
  payload.version=confirmedVersion??content.version;
  Object.keys(payload.texts).forEach(key=>{payload.texts[key]=payload.texts[key].trim();});
  Object.values(payload.images).forEach(image=>{image.alt=image.alt.trim();});
  contentSaving=true;contentSaveFailed=false;showError('content-editor-error','');updateContentStatus();
  try {
    content=copyContent(await api('/api/admin/content',{method:'PATCH',body:payload}));contentLoaded=true;
    contentDraft=copyContent(content);contentConflict=null;$('content-conflict').hidden=true;$('content-load-error').hidden=true;
    applyContent();renderContentEditor();toast('页面内容已保存，所有人将看到更新后的内容');saveStatus('页面内容已保存');
  } catch(error) {
    contentSaveFailed=true;
    if(error.status===409&&error.data.content){contentConflict=copyContent(error.data.content);$('content-conflict').hidden=false;showError('content-editor-error','');toast('页面已在其他窗口更新，请选择如何处理草稿');$('content-conflict').scrollIntoView({block:'nearest',behavior:'instant'});}
    else {
      showError('content-editor-error',`${error.message} 当前草稿已保留。`);toast('页面尚未保存，当前草稿已保留');
      if(error.status===401){$('content-load-message').textContent='登录已过期。页面草稿仍保留在本窗口，重新登录并进入「页面编辑」后可继续保存。';$('retry-content').hidden=true;$('content-load-error').hidden=false;}
    }
  } finally {contentSaving=false;updateContentStatus();}
}
async function uploadContentImage(key,file,input) {
  if(!isAdmin()||!file||contentSaving||contentUploads.has(key))return;
  showError('content-editor-error','');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){showError('content-editor-error','请选择 PNG、JPEG 或 WebP 图片。');toast('请选择 PNG、JPEG 或 WebP 图片');input.value='';return;}
  if(file.size>5*1024*1024||!file.size){showError('content-editor-error','图片不能为空，且每张不能超过 5 MB。');toast('图片不能为空，且每张不能超过 5 MB');input.value='';return;}
  const generation=uploadGeneration;
  contentUploads.add(key);updateContentStatus();$(`upload-label-${key}`).textContent='正在上传…';
  try {
    const previewData=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片无法读取，请重新选择。'));reader.readAsDataURL(file);});
    const decoded=new Image();decoded.src=previewData;await decoded.decode();
    if(!decoded.naturalWidth||!decoded.naturalHeight)throw new Error('图片无法读取，请重新选择。');
    if(generation!==uploadGeneration)return;
    const response=await trackedFetch('/api/admin/images',{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'x-csrf-token':csrfToken},body:file});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(result.message||'图片上传失败，请稍后重试。'),{status:response.status});
    if(!isContentImageSource(result.url))throw new Error('上传结果无效，请重试。');
    if(generation!==uploadGeneration)return;
    contentDraft.images[key].src=result.url;contentSaveFailed=false;renderContentPreview();toast('图片已加入草稿，请保存页面');
    $(`upload-hint-${key}`).textContent=`已上传 ${file.name}，点击「保存页面」后生效。`;
  } catch(error) {
    if(generation!==uploadGeneration)return;
    showError('content-editor-error',`${error.message||'图片无法读取，请换一张有效图片。'} 原有草稿已保留。`);toast('图片未能上传，原有草稿已保留');
    if(error.status===401){user=null;csrfToken='';renderAuth();$('content-load-message').textContent='登录已过期，页面草稿仍保留。重新登录后可以继续上传并保存。';$('retry-content').hidden=true;$('content-load-error').hidden=false;}
  } finally {
    if(generation===uploadGeneration){contentUploads.delete(key);input.value='';$(`upload-label-${key}`).textContent='选择图片';updateContentStatus();}
  }
}
$('content-form').addEventListener('input',event=>{
  const input=event.target;
  if(input.dataset.contentField){
    contentDraft.texts[input.dataset.contentField]=input.value;contentPreviewField=input.dataset.contentField;input.setCustomValidity('');
    const field=CONTENT_TEXT_FIELDS.find(item=>item.key===input.dataset.contentField);
    $(`count-${field.key}`).textContent=`${input.value.length}/${field.maxLength}`;
  } else if(input.dataset.imageSetting)contentDraft.images[input.dataset.imageKey][input.dataset.imageSetting]=input.value;
  else return;
  contentSaveFailed=false;renderContentPreview();updateContentStatus();
});
$('content-form').addEventListener('focusin',event=>{if(event.target.dataset.contentField){contentPreviewField=event.target.dataset.contentField;renderContentPreview();}});
$('content-form').addEventListener('change',event=>{
  const input=event.target;
  if(input.dataset.uploadImage)uploadContentImage(input.dataset.uploadImage,input.files[0],input);
  else if(input.dataset.imageSetting){contentDraft.images[input.dataset.imageKey][input.dataset.imageSetting]=input.value;contentSaveFailed=false;renderContentPreview();updateContentStatus();}
});
$('content-form').addEventListener('click',event=>{
  const reset=event.target.closest('[data-reset-image]'),remove=event.target.closest('[data-remove-image]');
  if(!reset&&!remove)return;
  const key=reset?.dataset.resetImage||remove.dataset.removeImage;
  if(contentUploads.has(key)){toast('这张图片正在上传，请稍候再操作。');return;}
  contentDraft.images[key]=copyContent(DEFAULT_CONTENT.images[key]);renderContentEditor();
});
$('content-form').addEventListener('submit',event=>{event.preventDefault();saveContent();});
$('content-defaults').addEventListener('click',()=>{resetContentDraft(DEFAULT_CONTENT);toast('已恢复默认内容到草稿，保存后生效');});
$('content-revert').addEventListener('click',()=>{resetContentDraft();toast('已撤销未保存的页面修改');});
$('content-use-latest').addEventListener('click',()=>{
  if(!contentConflict)return;content=copyContent(contentConflict);resetContentDraft();applyContent();toast('已载入最新页面内容');
});
$('content-overwrite').addEventListener('click',()=>{if(contentConflict)saveContent(contentConflict.version);});
$('retry-content').addEventListener('click',()=>requestContentLeave(reloadContent));
function requestAdminTab(tab,focus=false) {
  if(!canAccessAdminTab(tab))return;
  const action=()=>{setAdminTab(tab);if(focus)$(`${tab}-tab`).focus();};
  if(adminTab==='content'&&tab!=='content')requestContentLeave(action);else action();
}
adminTabs.forEach(tab=>$(`${tab}-tab`).addEventListener('click',()=>requestAdminTab(tab)));
$('audit-refresh').addEventListener('click',()=>loadAuditLogs());
$('audit-more').addEventListener('click',()=>loadAuditLogs(true));
document.querySelector('.admin-tabs').addEventListener('keydown',event=>{
  const tabs=adminTabs.filter(tab=>canAccessAdminTab(tab));
  const tab=nextNavigationTab(tabs,adminTab,event.key);
  if(!tab)return;event.preventDefault();
  requestAdminTab(tab,true);
});
ledgerTabs.forEach(tab=>$(`ledger-${tab}-tab`).addEventListener('click',()=>setLedgerTab(tab)));
$('ledger-tabs').addEventListener('keydown',event=>{
  const tabs=ledgerTabs.filter(tab=>!$(`ledger-${tab}-tab`).hidden);
  const tab=nextNavigationTab(tabs,ledgerTab,event.key);
  if(!tab)return;event.preventDefault();setLedgerTab(tab,true);
});
$('content-stay').addEventListener('click',()=>{$('content-leave-dialog').close();pendingLeave=null;});
$('content-discard-leave').addEventListener('click',()=>{const action=pendingLeave;pendingLeave=null;resetContentDraft();$('content-leave-dialog').close();if(action)action();});
$('content-leave-dialog').addEventListener('cancel',()=>{pendingLeave=null;});

function normalizeColor(value) { return {green:'#50837A',purple:'#A2789F',amber:'#C9683F',blue:'#6883A1'}[value]||value; }

$('expense-grid').addEventListener('input',event => {
  const input=event.target.closest('[data-amount]'); if(!input||!canEditLedger()) return;
  const expense=state.expenses.find(item=>item.id===input.dataset.amount);
  try {
    const amount=parseAmount(input.value);
    if(amount<expensePaidCents(expense.id))throw new Error(`金额不能低于已记录垫付 ${formatMoney(expensePaidCents(expense.id))}。请先调整垫付记录。`);
    if(amount>0&&!expense.participantIds.length)throw new Error('请先点击「选择参与人」并确认至少一位参与人，再填写金额。');
    fieldError(expense.id,'');
    if(amount!==expense.amountCents){expense.amountCents=amount;markDirty(expense);}
    else if(!dirty.size&&!savingPromise&&!invalidInputs.size)saveStatus('全部修改已保存');
  }
  catch(error) { fieldError(expense.id,`${error.message} 总计沿用上一次有效金额。`); saveStatus('请检查金额输入','error'); }
});
$('expense-grid').addEventListener('focusout',event => {
  const input=event.target.closest('[data-amount]'); if(!input||invalidInputs.has(input.dataset.amount)) return;
  const expense=state.expenses.find(item=>item.id===input.dataset.amount); input.value=(expense.amountCents/100).toFixed(2);
});
function updateParticipantDraft() {
  const expense=state.expenses.find(item=>item.id===participantExpenseId);
  if(!expense)return;
  $('participants-selected-count').textContent=`已选 ${participantDraft.size} 人`;
  showError('participants-error','');
  const selected=[...state.members].sort((a,b)=>a.order-b.order).filter(member=>participantDraft.has(member.id));
  const remainder=selected.length?expense.amountCents%selected.length:0;
  $('participants-remainder').textContent=remainder?`本笔尾差 ${remainder} 分，由${selected.slice(0,remainder).map(member=>member.name).join('、')}各多分摊 ¥0.01。`:'';
}
function openParticipants(expenseId) {
  const expense=state.expenses.find(item=>item.id===expenseId);if(!expense)return;
  participantExpenseId=expenseId;participantDraft=new Set(expense.participantIds);
  $('participants-heading').textContent=`${expense.title} · ${user?'选择参与人':'参与人'}`;
  const members=[...state.members].sort((a,b)=>a.order-b.order);
  $('participants-list').innerHTML=members.length?members.map((member,index)=>`<label class="participant-option"><input type="checkbox" data-picker-member="${esc(member.id)}" ${participantDraft.has(member.id)?'checked':''} ${canEditLedger()?'':'disabled'}><span class="checkbox-box">${icon('check')}</span>${avatarMarkup(member,`picker-avatar color-${colorClass(member,index)}`)}<span class="participant-option-name">${esc(member.name)}</span></label>`).join(''):'<p class="admin-empty">暂无成员，请先由管理员在后台添加。</p>';
  $('participants-all').disabled=!canEditLedger()||!members.length;
  $('participants-clear').disabled=!canEditLedger()||!members.length;
  $('participants-confirm').hidden=!canEditLedger();
  updateParticipantDraft();$('participants-dialog').showModal();
}
$('expense-grid').addEventListener('click',event=>{const button=event.target.closest('[data-select-participants]');if(button)openParticipants(button.dataset.selectParticipants);});
$('participants-list').addEventListener('change',event=>{const input=event.target.closest('[data-picker-member]');if(!input||!canEditLedger())return;if(input.checked)participantDraft.add(input.dataset.pickerMember);else participantDraft.delete(input.dataset.pickerMember);updateParticipantDraft();});
function setAllParticipants(selected) {
  if(!canEditLedger())return;
  participantDraft=new Set(selected?state.members.map(member=>member.id):[]);
  $('participants-list').querySelectorAll('[data-picker-member]').forEach(input=>{input.checked=selected;});updateParticipantDraft();
}
$('participants-all').addEventListener('click',()=>setAllParticipants(true));
$('participants-clear').addEventListener('click',()=>setAllParticipants(false));
$('participants-form').addEventListener('submit',event=>{
  event.preventDefault();if(!canEditLedger())return;
  const expense=state.expenses.find(item=>item.id===participantExpenseId);if(!expense){$('participants-dialog').close();return;}
  const ids=[...state.members].sort((a,b)=>a.order-b.order).filter(member=>participantDraft.has(member.id)).map(member=>member.id);
  const amountInput=document.querySelector(`[data-amount="${CSS.escape(expense.id)}"]`);
  let enteredAmount=null;try{enteredAmount=parseAmount(amountInput.value);}catch{}
  if(enteredAmount!==null&&enteredAmount<expensePaidCents(expense.id)){showError('participants-error','费用金额不能低于已记录的垫付，请先调整金额或垫付记录。');return;}
  if((enteredAmount??expense.amountCents)>0&&!ids.length){showError('participants-error','有金额的费用至少需要一位参与人。');return;}
  const changed=JSON.stringify([...expense.participantIds].sort())!==JSON.stringify([...ids].sort())||(enteredAmount!==null&&enteredAmount!==expense.amountCents);
  expense.participantIds=ids;
  if(enteredAmount!==null){expense.amountCents=enteredAmount;fieldError(expense.id,'');}
  if(changed)markDirty(expense);
  $('participants-dialog').close();
});
$('participants-dialog').addEventListener('close',()=>{participantExpenseId=null;participantDraft.clear();});

$('people-grid').addEventListener('click',event => { const button=event.target.closest('[data-person]'); if(button){renderDetail(button.dataset.person);$('detail-dialog').showModal();} });
document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.closeDialog).close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{ if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();} }));
$('banner-login').addEventListener('click',openLogin);
async function logout(discard=false) {
  if(!user){openLogin();return;}
  if(!discard&&(localPending()||$('participants-dialog').open)){showError('logout-error','');$('logout-dialog').showModal();return;}
  quitting=true;clearTimeout(saveTimer);uploadGeneration++;memberAvatarGeneration++;contentUploads.clear();memberAvatarUploading=false;memberSaving=false;updateContentStatus();$('logout-discard').disabled=true;showError('logout-error','');
  try{
    await Promise.allSettled([...pendingWrites,...(savingPromise?[savingPromise]:[])]);
    await api('/api/logout',{method:'POST',body:{}});
    user=null;csrfToken='';clearLocalEdits();
    try{acceptRemote(await api('/api/state'));}catch{if(serverState)acceptRemote(serverState);}
    renderAuth();switchView('ledger');saveStatus('浏览模式');toast('已退出登录');
  }catch(error){showError('logout-error',error.message);if(!$('logout-dialog').open)$('logout-dialog').showModal();}
  finally{quitting=false;$('logout-discard').disabled=false;updateExpenseControls();}
}
function clearLocalEdits(){
  clearTimeout(saveTimer);editedForms.clear();dirty.clear();revisions.clear();invalidInputs.clear();recovery=null;pendingRemote=null;saveFailed=false;
  pendingLeave=null;memberAvatarGeneration++;memberAvatarUploading=false;memberSaving=false;memberAvatarDraft='';editMemberId=null;
  contentUploads.clear();contentSaving=false;resetContentDraft();
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
  ['password-form','reset-password-form','member-form','expense-form','advance-form'].forEach(id=>$(id).reset());
  showError('global-error','');renderSync();
}
$('auth-button').addEventListener('click',()=>{if(!user)openLogin();else logout();});
$('logout-discard').addEventListener('click',()=>logout(true));
$('login-form').addEventListener('submit',async event=> {
  event.preventDefault();const form=event.currentTarget;const button=form.querySelector('[type="submit"]');button.disabled=true;showError('login-error','');
  try {const values=Object.fromEntries(new FormData(form));const result=await api('/api/login',{method:'POST',body:values});user=result.user;csrfToken=result.csrfToken;renderAuth();if(contentLoaded){$('content-load-error').hidden=true;$('retry-content').hidden=false;}$('login-dialog').close();form.reset();toast(`欢迎回来，${user.username}`);saveStatus('已登录 · 可编辑');const remote=await api('/api/state');if(dirty.size||invalidInputs.size||recovery){receiveConflict(remote);openDraftRecovery();}else acceptRemote(remote);}
  catch(error){if($('login-dialog').open)showError('login-error',error.message);else showError('global-error',error.message);}
  finally{button.disabled=false;}
});
$('global-error').addEventListener('click',event=> {if(event.target.id==='retry-save'){if(!user)openLogin();else if(recovery)openDraftRecovery();else flushSaves().catch(()=>{});}});
$('ledger-nav').addEventListener('click',()=>requestContentLeave(()=>switchView('ledger')));
$('releases-nav').addEventListener('click',()=>requestContentLeave(openReleases));
$('releases-retry').addEventListener('click',loadReleases);
async function openAdmin(tab=null,openAddForm=false) {
  if(!user){openLogin();return;}if(!canManageLedger())return;
  tab=tab??(canAccessAdminTab(adminTab)?adminTab:'expenses');
  if(!canAccessAdminTab(tab))return;
  if(invalidInputs.size){toast('请先修正标红的金额，再打开管理后台。');return;}
  const identity=authIdentity;
  try{
    await flushSaves();if(isAdmin())await loadAccounts();if(identity!==authIdentity||!canManageLedger())return;
    const action=()=>{
      if(identity!==authIdentity||!canAccessAdminTab(tab))return;
      renderAdmin();setAdminTab(tab);switchView('admin');
      if(openAddForm){
        const formId={expenses:'expense',members:'member',accounts:'account'}[tab];
        if(formId){$(`${formId}-add-details`).open=true;$(`${formId}-form`).querySelector('input').focus();}
      }
    };
    if(currentView==='admin'&&adminTab===tab)action();else requestContentLeave(action);
  }
  catch(error){showError('global-error',error.message);}
}
$('admin-nav').addEventListener('click',()=>openAdmin());
document.addEventListener('click',event=>{const button=event.target.closest('[data-open-admin-tab],[data-open-admin]');if(button)openAdmin(button.dataset.openAdminTab||null,button.hasAttribute('data-open-add-form'));});
$('member-form').addEventListener('submit',event=>{event.preventDefault();if(!canEditLedger())return;const form=event.currentTarget;const values=Object.fromEntries(new FormData(form));values.color=normalizeColor(values.color);adminAction(async()=>{state=await api('/api/admin/members',{method:'POST',body:{...values,version:state.version}});},form);});
$('account-form').addEventListener('submit',event=>{event.preventDefault();if(!isAdmin())return;const form=event.currentTarget,identity=authIdentity;const values=Object.fromEntries(new FormData(form));adminAction(async()=>{const result=await api('/api/admin/accounts',{method:'POST',body:values});if(identity===authIdentity&&isAdmin()){accountListGeneration++;accounts=result.accounts;}},form);});
$('expense-form').addEventListener('submit',event=>{event.preventDefault();if(!canEditLedger())return;const form=event.currentTarget;const title=form.elements.title.value;adminAction(async()=>{state=await api('/api/admin/expenses',{method:'POST',body:{version:state.version,title,amountCents:0,participantIds:[]}});},form);});
$('admin-expenses').addEventListener('click',event=>{
  if(!canEditLedger())return;
  const edit=event.target.closest('[data-edit-expense]'),remove=event.target.closest('[data-delete-expense]');
  if(edit){const expense=state.expenses.find(item=>item.id===edit.dataset.editExpense);editExpenseId=expense.id;$('expense-edit-form').elements.title.value=expense.title;showError('expense-edit-error','');$('expense-dialog').showModal();}
  if(remove&&isAdmin()){const expense=state.expenses.find(item=>item.id===remove.dataset.deleteExpense);if(confirm(`删除费用「${expense.title}」？所有人的应付金额将重新计算。`))adminAction(async()=>{state=await api(`/api/admin/expenses/${encodeURIComponent(expense.id)}`,{method:'DELETE',body:{version:state.version}});});}
});
$('expense-edit-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!canEditLedger())return;const form=event.currentTarget,button=form.querySelector('[type="submit"]'),expenseId=editExpenseId,title=form.elements.title.value;button.disabled=true;showError('expense-edit-error','');
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正账单中的金额，或放弃修改。');state=await api(`/api/admin/expenses/${encodeURIComponent(expenseId)}`,{method:'PATCH',body:{version:state.version,title}});serverState=structuredClone(state);renderExpenses();renderAdmin();$('expense-dialog').close();toast('费用名称已更新');}
  catch(error){if(error.status===409&&error.data.state)receiveConflict(error.data.state);showError('expense-edit-error',error.message);}
  finally{button.disabled=false;}
});
function renderMemberAvatarPreview() {
  const member={name:$('member-edit-form').elements.name.value,avatarUrl:memberAvatarDraft};
  $('member-avatar-preview').innerHTML=avatarSource(member)?`<img src="${esc(avatarSource(member))}" alt="">`:esc(member.name.slice(-1)||'人');
  $('member-avatar-preview').className=`avatar member-avatar-preview color-${colorClass({color:$('member-edit-form').elements.color.value})}`;
  $('member-avatar-remove').disabled=memberSaving||memberAvatarUploading||!memberAvatarDraft;
  $('member-avatar-input').disabled=memberSaving||memberAvatarUploading;
  $('member-avatar-upload-label').dataset.disabled=String(memberSaving||memberAvatarUploading);
  $('member-edit-form').querySelector('[type="submit"]').disabled=memberSaving||memberAvatarUploading;
}
function openMemberEditor(member) {
  memberAvatarGeneration++;memberAvatarUploading=false;memberSaving=false;editMemberId=member.id;memberAvatarDraft=avatarSource(member);
  const form=$('member-edit-form');form.elements.name.value=member.name;form.elements.note.value=member.note||'';form.elements.color.value=member.color.toUpperCase();if(!form.elements.color.value)form.elements.color.value='#50837A';
  $('member-avatar-input').value='';$('member-avatar-status').textContent='PNG / JPEG / WebP，最多 5 MB';showError('member-edit-error','');renderMemberAvatarPreview();$('member-dialog').showModal();
}
$('admin-members').addEventListener('click',event=> {
  if(!canEditLedger())return;
  const edit=event.target.closest('[data-edit-member]'),remove=event.target.closest('[data-delete-member]');
  if(edit){const member=state.members.find(item=>item.id===edit.dataset.editMember);if(member)openMemberEditor(member);}
  if(remove&&isAdmin()){const member=state.members.find(item=>item.id===remove.dataset.deleteMember);if(confirm(`删除聚餐成员「${member.name}」？其参与的费用将由其余参与者重新分摊。`))adminAction(async()=>{state=await api(`/api/admin/members/${encodeURIComponent(member.id)}`,{method:'DELETE',body:{version:state.version}});});}
});
$('member-edit-form').addEventListener('input',event=>{if(['name','color'].includes(event.target.name))renderMemberAvatarPreview();});
$('member-avatar-remove').addEventListener('click',()=>{if(memberAvatarUploading||memberSaving)return;memberAvatarDraft='';$('member-avatar-status').textContent='保存成员后移除头像';renderMemberAvatarPreview();});
$('member-avatar-input').addEventListener('change',async event=>{
  const input=event.target,file=input.files[0];if(!canEditLedger()||!file||memberAvatarUploading||memberSaving)return;showError('member-edit-error','');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size||file.size>5*1024*1024){showError('member-edit-error','请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。');input.value='';return;}
  const generation=memberAvatarGeneration,memberId=editMemberId;memberAvatarUploading=true;$('member-avatar-status').textContent='正在上传头像…';renderMemberAvatarPreview();
  try{
    const response=await trackedFetch('/api/member-avatars',{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'x-csrf-token':csrfToken},body:file});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(result.message||'头像上传失败，请重试。'),{status:response.status});
    if(generation!==memberAvatarGeneration||memberId!==editMemberId||!$('member-dialog').open)return;
    if(!avatarSource({avatarUrl:result.url}))throw new Error('上传结果无效，请重新选择头像。');
    memberAvatarDraft=result.url;$('member-avatar-status').textContent='头像已上传，保存成员后生效';
  }catch(error){
    if(generation!==memberAvatarGeneration)return;showError('member-edit-error',error.message);$('member-avatar-status').textContent='上传失败，原头像保留';
    if(error.status===401){user=null;csrfToken='';renderAuth();}
  }finally{if(generation===memberAvatarGeneration){memberAvatarUploading=false;input.value='';renderMemberAvatarPreview();}}
});
$('member-dialog').addEventListener('close',()=>{memberAvatarGeneration++;memberAvatarUploading=false;editMemberId=null;});
$('member-edit-form').addEventListener('submit',async event=> {
  event.preventDefault();if(!canEditLedger()||memberAvatarUploading||memberSaving||!editMemberId)return;
  const form=event.currentTarget,memberId=editMemberId,generation=memberAvatarGeneration,values={...Object.fromEntries(new FormData(event.currentTarget)),avatarUrl:memberAvatarDraft};memberSaving=true;renderMemberAvatarPreview();showError('member-edit-error','');
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正账单中的金额，或放弃修改。');state=await api(`/api/admin/members/${encodeURIComponent(memberId)}`,{method:'PATCH',body:{...values,version:state.version}});serverState=structuredClone(state);renderExpenses();renderAdmin();if(generation===memberAvatarGeneration){$('member-dialog').close();toast('成员信息已更新');}}
  catch(error){
    if(error.status===409&&error.data.state){receiveConflict(error.data.state);if(generation===memberAvatarGeneration)showError('member-edit-error','账单已更新，成员输入仍保留。关闭此窗口处理最新账单后，可再次编辑成员。');}
    else if(generation===memberAvatarGeneration)showError('member-edit-error',error.message);
  }
  finally{if(generation===memberAvatarGeneration){memberSaving=false;renderMemberAvatarPreview();}}
});

async function loadAccounts() {
  if(!isAdmin())return;
  const identity=authIdentity,generation=++accountListGeneration;
  const result=await api('/api/admin/accounts');
  if(identity===authIdentity&&generation===accountListGeneration&&isAdmin())accounts=result.accounts;
}
function closeAccountEditor() {
  accountEditGeneration++;editAccountId=null;accountSaving=false;
  if($('account-dialog').open)$('account-dialog').close();
  $('account-edit-form').reset();showError('account-edit-error','');
  $('account-edit-form').elements.role.querySelector('option[value="editor"]').disabled=false;
  $('account-edit-note').textContent='';$('account-edit-save').disabled=false;
}
function updateAccountEditNote() {
  const account=accounts.find(item=>item.id===editAccountId);if(!account)return;
  const self=account.id===user?.id,form=$('account-edit-form');
  const lastAdmin=account.role==='admin'&&accounts.filter(item=>item.role==='admin').length===1;
  const changed=form.elements.username.value.trim()!==account.username||form.elements.role.value!==account.role;
  $('account-edit-note').textContent=`${lastAdmin?'至少保留一位管理员，此账户不能改为编辑者。 ':''}${self?'保存修改后你将退出登录，请用最新用户名和原密码重新登录。':'保存修改后，该账户需要用最新用户名和原密码重新登录。'}`;
  $('account-edit-save').textContent=self&&changed?'保存并退出登录':'保存账户';
}
function openAccountEditor(account) {
  if(!isAdmin())return;
  closeAccountEditor();editAccountId=account.id;
  const form=$('account-edit-form');form.elements.username.value=account.username;form.elements.role.value=account.role;
  form.elements.role.querySelector('option[value="editor"]').disabled=account.role==='admin'&&accounts.filter(item=>item.role==='admin').length===1;
  updateAccountEditNote();$('account-dialog').showModal();
}
function accountSessionEnded() {
  user=null;csrfToken='';accounts=[];accountListGeneration++;
  clearTimeout(saveTimer);editedForms.clear();dirty.clear();revisions.clear();invalidInputs.clear();recovery=null;pendingRemote=null;saveFailed=false;
  pendingLeave=null;participantDraft.clear();participantExpenseId=null;editExpenseId=null;
  memberAvatarGeneration++;memberAvatarUploading=false;memberSaving=false;memberAvatarDraft='';editMemberId=null;
  ['account-dialog','member-dialog','expense-dialog','participants-dialog','content-leave-dialog','detail-dialog'].forEach(id=>{if($(id).open)$(id).close();});
  ['account-form','account-edit-form','member-form','member-edit-form','expense-form','expense-edit-form','participants-form','login-form'].forEach(id=>$(id).reset());
  $('detail-content').innerHTML='';detailMemberId=null;$('participants-list').innerHTML='';
  $('member-avatar-preview').innerHTML='';$('member-avatar-input').value='';
  contentSaving=false;resetContentDraft();resetAuditLogs();showError('admin-error','');showError('global-error','');
  renderAuth();renderExpenses();switchView('ledger');saveStatus('浏览模式');
  toast('账户已更新。请使用最新用户名和原密码重新登录。');
}
$('account-edit-form').addEventListener('input',updateAccountEditNote);
$('account-edit-form').addEventListener('change',updateAccountEditNote);
$('account-dialog').addEventListener('close',()=>{accountEditGeneration++;editAccountId=null;accountSaving=false;$('account-edit-form').reset();showError('account-edit-error','');});
$('account-edit-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!isAdmin()||accountSaving||!editAccountId)return;
  const identity=authIdentity,generation=accountEditGeneration,accountId=editAccountId,form=event.currentTarget;
  const body={username:form.elements.username.value.trim(),role:form.elements.role.value};
  accountSaving=true;$('account-edit-save').disabled=true;showError('account-edit-error','');
  try {
    await flushSaves();if(invalidInputs.size)throw new Error('请先修正账单中的金额，或放弃修改。');if(identity!==authIdentity||!isAdmin())return;
    const result=await api(`/api/admin/accounts/${encodeURIComponent(accountId)}`,{method:'PATCH',body});
    if(identity!==authIdentity||!isAdmin())return;
    if(result.sessionRevoked){accountSessionEnded();return;}
    await loadAccounts();if(identity!==authIdentity||!isAdmin())return;
    renderAdmin();if(generation===accountEditGeneration){closeAccountEditor();toast('账户信息已更新，密码保持不变');}
  } catch(error) {
    if(identity===authIdentity&&isAdmin()&&generation===accountEditGeneration)showError('account-edit-error',error.message);
  } finally {
    if(generation===accountEditGeneration){accountSaving=false;$('account-edit-save').disabled=false;}
  }
});
$('admin-accounts').addEventListener('click',event=>{
  if(!isAdmin())return;
  const edit=event.target.closest('[data-edit-account]'),remove=event.target.closest('[data-delete-account]');
  if(edit){const account=accounts.find(item=>item.id===edit.dataset.editAccount);if(account)openAccountEditor(account);}
  if(remove){const account=accounts.find(item=>item.id===remove.dataset.deleteAccount),identity=authIdentity;if(account&&confirm(`删除登录账户「${account.username}」？该账户将立即无法继续编辑。`))adminAction(async()=>{const result=await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`,{method:'DELETE',body:{}});if(identity===authIdentity&&isAdmin()){accountListGeneration++;accounts=result.accounts;}});}
});
function renderAdvances() {
  if(!state||!ledger)return;
  $('settlement-section').hidden=!state.expenses.length;
  $('add-advance').hidden=!canEditLedger();
  const advances=state.advances||[];
  $('settlement-summary').innerHTML=`<div><span>总费用</span><strong>${formatMoney(ledger.totalCents)}</strong></div><div><span>已记录垫付</span><strong>${formatMoney(ledger.paidCents||0)}</strong></div><div><span>尚未记录</span><strong>${formatMoney(ledger.unrecordedCents??ledger.totalCents)}</strong></div>`;
  $('settlement-plan').innerHTML=settlementMarkup(state,ledger);
  $('advance-list').innerHTML=advances.length?advances.map(item=>`<article class="advance-row"><span class="expense-icon">${icon('coins')}</span><div class="admin-row-info"><strong>${esc(state.members.find(m=>m.id===item.memberId)?.name||'未知成员')} · ${formatMoney(item.amountCents)}</strong><p>${esc(state.expenses.find(e=>e.id===item.expenseId)?.title||'费用')}${item.note?` · ${esc(item.note)}`:''}</p></div>${canEditLedger()?`<div class="admin-row-actions"><button class="admin-edit" data-edit-advance="${esc(item.id)}">编辑</button>${isAdmin()?`<button class="admin-delete" data-delete-advance="${esc(item.id)}">删除</button>`:''}</div>`:''}</article>`).join(''):'<p class="admin-empty">还没有垫付记录。记录实际付款人后，可核对每个人应收或待付的金额。</p>';
}
function settlementMarkup(source,calculated) {
  if(!calculated.totalCents)return '<p class="settlement-notice">尚无费用，无需结算。</p>';
  if(!calculated.settlementReady)return '<p class="settlement-notice">垫付未录全，暂不生成结算建议。卡片净额仅反映已记录的垫付。</p>';
  if(!calculated.settlements?.length)return '<p class="settlement-notice success">所有人的垫付与分摊份额相抵，无需互相转账。</p>';
  return `<div class="settlement-ready"><strong>结算建议</strong><p>根据已记录的垫付与分摊计算，供线下核对；不代表已经收付款。</p>${calculated.settlements.map(item=>`<div class="settlement-transfer"><span>${esc(source.members.find(m=>m.id===item.fromMemberId)?.name||'成员')} <span aria-hidden="true">→</span> ${esc(source.members.find(m=>m.id===item.toMemberId)?.name||'成员')}</span><strong>${formatMoney(item.amountCents)}</strong></div>`).join('')}</div>`;
}
function openAdvanceEditor(id=null) {
  if(!canEditLedger())return;
  const entry=(state.advances||[]).find(item=>item.id===id),form=$('advance-form');editAdvanceId=entry?.id||null;form.reset();
  $('advance-heading').textContent=entry?'编辑垫付记录':'记录垫付';
  form.elements.expenseId.innerHTML=state.expenses.map(item=>`<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');
  form.elements.memberId.innerHTML=[...state.members].sort((a,b)=>a.order-b.order).map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  if(entry){form.elements.expenseId.value=entry.expenseId;form.elements.memberId.value=entry.memberId;form.elements.amount.value=(entry.amountCents/100).toFixed(2);form.elements.note.value=entry.note||'';}
  showError('advance-error','');updateAdvanceCapacity();$('advance-dialog').showModal();
}
function updateAdvanceCapacity(){
  const expense=state?.expenses.find(item=>item.id===$('advance-form').elements.expenseId.value);
  const paid=(state?.advances||[]).filter(item=>item.expenseId===expense?.id&&item.id!==editAdvanceId).reduce((sum,item)=>sum+item.amountCents,0);
  $('advance-capacity').textContent=expense?`本笔费用 ${formatMoney(expense.amountCents)}，其余垫付已记 ${formatMoney(paid)}，最多可录 ${formatMoney(expense.amountCents-paid)}。`:'请先添加费用与聚餐成员。';
}
function renderGatheringAdmin(){
  if(!state)return;
  const gathering=state.currentGathering,finalized=gathering?.status==='finalized';
  $('gathering-admin-summary').innerHTML=gathering?`<div class="card-heading"><h3>${esc(gathering.name)}</h3><span class="status-pill">${finalized?'已定稿':'进行中'}</span></div><p>${esc(gathering.date)} · 总费用 ${formatMoney(calculateLedger(state).totalCents)}</p>${finalized?`<p class="admin-form-note">定稿后成员、费用和垫付记录均已锁定。解锁会允许修改，已分享的结算金额可能变化。</p><button class="button button-outline" type="button" data-reopen-gathering>解锁本次账单</button>`:`<form id="gathering-edit-form" class="gathering-edit-form"><label>聚餐名称<input name="name" required maxlength="60" value="${esc(gathering.name)}"></label><label>日期<input name="date" type="date" required value="${esc(gathering.date)}"></label><div class="gathering-edit-actions"><button class="button button-outline" type="submit">保存名称与日期</button><button class="text-button" type="button" data-reset-form="gathering-edit-form">取消修改</button></div></form><p class="admin-form-note">${calculateLedger(state).settlementReady?'定稿会锁定当前账单。':'垫付尚未录全，定稿只锁定账单，不会生成完整结算方案。'}</p><button class="button button-primary" type="button" data-finalize-gathering>定稿并锁定本次账单</button>`}`:'正在加载聚餐信息…';
  $('gathering-form').querySelector('[type="submit"]').disabled=!isAdmin()||!finalized;
  $('new-gathering-note').textContent=finalized?'新建后，本次账单会归档，后续只能查看。':'请先将本次聚餐定稿，再开始下一次聚餐。';
  if(!$('gathering-form').elements.date.value)$('gathering-form').elements.date.value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
async function gatheringAction(path,body={}) {
  showError('gathering-error','');
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正金额，或放弃本地修改。');const remote=await api(path,{method:'POST',body:{version:state.version,...body}});dirty.clear();revisions.clear();recovery=null;acceptRemote(remote);toast('聚餐设置已保存');}
  catch(error){if(error.status===409&&error.data.state)receiveConflict(error.data.state);showError('gathering-error',error.message);}
}
async function loadGatherings(){
  if(!user)return;
  $('history-refresh').disabled=true;showError('history-error','');
  const identity=authIdentity;
  try{const result=await api('/api/gatherings');if(identity!==authIdentity)return;$('gathering-list').innerHTML=result.gatherings.length?result.gatherings.map(item=>`<article class="gathering-card"><div class="card-heading"><span class="status-pill">${item.archived?'已归档':item.status==='finalized'?'已定稿':'当前聚餐'}</span><time>${esc(item.date)}</time></div><h2>${esc(item.name)}</h2><div class="gathering-total">${formatMoney(item.totalCents)}</div><p>${item.memberCount} 位成员 · ${item.expenseCount} 笔费用</p><button class="button button-outline" type="button" data-view-gathering="${esc(item.id)}">查看账单明细</button></article>`).join(''):'<p class="admin-empty">暂无聚餐记录。</p>';}
  catch(error){showError('history-error',error.message);}finally{$('history-refresh').disabled=false;}
}
async function openHistoryDetail(id){
  const identity=authIdentity;
  try{
    const result=await api(`/api/gatherings/${encodeURIComponent(id)}`);if(identity!==authIdentity||!user)return;
    const calculated=calculateLedger(result),gathering=result.gathering;
    $('history-detail-content').innerHTML=`<span class="status-pill">${gathering.id!==state.currentGathering?.id?'历史归档 · 只读':gathering.status==='finalized'?'已定稿 · 只读':'当前账单快照 · 只读'}</span><h2 id="history-detail-heading">${esc(gathering.name)}</h2><p class="dialog-description">${esc(gathering.date)} · 总费用 ${formatMoney(calculated.totalCents)}</p><div class="history-people">${calculated.people.map(person=>`<article class="history-person"><div class="card-heading">${avatarMarkup(person,`small-avatar color-${colorClass(person)}`)}<strong>${esc(person.name)}</strong></div><div class="history-person-amount">分摊 ${formatMoney(person.totalCents)}</div><p>已垫付 ${formatMoney(person.paidCents||0)} · ${(person.netCents||0)>0?'应收':'待付'} ${formatMoney(Math.abs(person.netCents??-person.totalCents))}</p><details><summary>分摊明细</summary>${person.items.filter(item=>item.participating).map(item=>`<div class="history-detail-row"><span>${esc(item.title)}</span><strong>${formatMoney(item.amountCents)}</strong></div>`).join('')||'<p>未参与费用</p>'}</details></article>`).join('')}</div><h3>费用项目</h3><div class="history-expenses">${result.expenses.map(item=>`<article class="management-card"><div class="card-heading"><strong>${esc(item.title)}</strong><strong>${formatMoney(item.amountCents)}</strong></div><p>${esc(item.participantIds.map(memberId=>result.members.find(member=>member.id===memberId)?.name||'成员').join('、'))||'无人参与'}</p></article>`).join('')||'<p class="admin-empty">暂无费用</p>'}</div><h3>垫付记录</h3>${(result.advances||[]).map(item=>`<div class="history-detail-row"><span>${esc(result.members.find(m=>m.id===item.memberId)?.name||'成员')} · ${esc(result.expenses.find(e=>e.id===item.expenseId)?.title||'费用')}${item.note?`<small>${esc(item.note)}</small>`:''}</span><strong>${formatMoney(item.amountCents)}</strong></div>`).join('')||'<p class="admin-empty">暂无垫付记录</p>'}${settlementMarkup(result,calculated)}<p class="history-balance">总费用 ${formatMoney(calculated.totalCents)} = 分摊之和 ${formatMoney(calculated.allocatedCents)} · 差额 ${formatMoney(Math.abs(calculated.differenceCents))}</p>`;
    $('history-detail-dialog').showModal();
  }catch(error){toast(error.message);}
}
async function loadSessions(){
  if(!user)return;const identity=authIdentity;$('sessions-refresh').disabled=true;showError('sessions-error','');
  try{const result=await api('/api/account/sessions');if(identity!==authIdentity)return;$('sessions-list').innerHTML=result.sessions.map(item=>`<article class="session-row"><div><strong>${esc(item.loginIp||'未知 IP')} ${item.current?'<span class="status-pill">当前登录</span>':''}</strong><p>登录 ${esc(auditTime(Number(item.issuedAt)*1000))}<br>到期 ${esc(auditTime(Number(item.expiresAt)*1000))}</p></div><button class="admin-delete" type="button" data-revoke-session="${esc(item.id)}" data-current-session="${Boolean(item.current)}">${item.current?'退出当前设备':'撤销登录'}</button></article>`).join('')||'<p class="admin-empty">没有有效登录记录。</p>';}
  catch(error){showError('sessions-error',error.message);}finally{$('sessions-refresh').disabled=false;}
}
async function finishSecurityLogout(message){
  user=null;csrfToken='';clearLocalEdits();try{acceptRemote(await api('/api/state'));}catch{if(serverState)acceptRemote(serverState);}renderAuth();switchView('ledger');saveStatus('浏览模式');toast(message);
}
async function loadBackups(){
  if(!isAdmin())return;const identity=authIdentity;$('backups-refresh').disabled=true;showError('backups-error','');
  try{
    const status=await api('/api/admin/backups');if(identity!==authIdentity||!isAdmin())return;
    const last=status.lastSuccessAt?new Date(status.lastSuccessAt):null,stale=last&&Date.now()-last.getTime()>36*60*60*1000;
    const warning=!status.configured?'尚未配置自动备份。':status.lastError?'最近一次备份失败，请检查服务器备份任务。':!last?'等待首次成功备份。':stale?'已超过 36 小时没有成功备份，请检查备份任务。':'';
    $('backup-status').innerHTML=`<div class="card-heading"><h3>${warning?'需要关注':'自动备份正常'}</h3><span class="status-pill">${status.configured?'已配置':'未配置'}</span></div>${warning?`<p class="backup-warning" role="status">${esc(warning)}</p>`:''}<dl class="backup-facts"><div><dt>最近成功</dt><dd>${status.lastSuccessAt?esc(auditTime(status.lastSuccessAt)):'尚无记录'}</dd></div><div><dt>最近尝试</dt><dd>${status.lastAttemptAt?esc(auditTime(status.lastAttemptAt)):'尚无记录'}</dd></div><div><dt>完整性验证</dt><dd>${status.verifiedAt?esc(auditTime(status.verifiedAt)):'尚无记录'}</dd></div><div><dt>已保留备份</dt><dd>${Number(status.backupCount)||0} 份 · 保留 ${Number(status.retentionDays)||0} 天</dd></div><div><dt>最新备份大小</dt><dd>${status.latestSizeBytes?`${(status.latestSizeBytes/1024/1024).toFixed(2)} MB`:'尚无记录'}</dd></div></dl>${status.lastError?`<p class="form-error">${esc(status.lastError)}</p>`:''}<p class="admin-form-note">自动备份保存在本服务器。服务器之外的副本仍需单独安排；此处不提供含账户资料的备份文件下载。</p>`;
  }catch(error){showError('backups-error',error.message);}finally{$('backups-refresh').disabled=false;}
}
$('sync-refresh').addEventListener('click',()=>syncRemote(true));$('review-update').addEventListener('click',openDraftRecovery);
$('draft-use-server').addEventListener('click',()=>$('draft-list').querySelectorAll('[data-restore-draft]').forEach(input=>input.checked=false));
$('draft-use-local').addEventListener('click',()=>$('draft-list').querySelectorAll('[data-restore-draft]').forEach(input=>input.checked=!input.disabled));
$('draft-confirm').addEventListener('click',async()=>{
  if(!recovery)return;showError('draft-error','');
  const selected=new Set([...$('draft-list').querySelectorAll('[data-restore-draft]:checked')].map(input=>input.dataset.restoreDraft));
  try{
    // Refresh immediately before applying a choice, so deleted/finalized drafts cannot be restored.
    const latest=await api('/api/state'),original=recovery.drafts;
    if(latest.version!==recovery.remote.version){pendingRemote=latest;recovery.remote=latest;openDraftRecovery();showError('draft-error','账单刚刚又有更新，请根据最新数据重新确认。');return;}
    const result=reconcileDrafts(latest,original,selected);clearTimeout(saveTimer);dirty.clear();invalidInputs.clear();revisions.clear();
    serverState=structuredClone(latest);state=result.state;recovery=null;pendingRemote=null;saveFailed=false;$('draft-dialog').close();
    renderExpenses();renderAdmin();renderGatheringAdmin();
    for(const id of result.restored){const draft=original.find(item=>item.id===id),inspection=inspectDraft(latest,draft);if(inspection.merged.amountCents!==inspection.expense.amountCents||JSON.stringify(inspection.merged.participantIds)!==JSON.stringify(inspection.expense.participantIds)){revisions.set(id,1);dirty.set(id,1);}if(result.rawInputs.has(id)){const input=document.querySelector(`[data-amount="${CSS.escape(id)}"]`);input.value=result.rawInputs.get(id);fieldError(id,'原始输入已恢复，请检查金额后再保存。');}}
    renderSummary();renderSync();saveStatus(invalidInputs.size?'草稿已恢复 · 请检查金额':dirty.size?'正在恢复草稿…':'已同步最新账单',invalidInputs.size?'error':'');
    if(dirty.size)flushSaves().catch(()=>{});
  }catch(error){showError('draft-error',error.message);}
});
$('add-advance').addEventListener('click',()=>openAdvanceEditor());$('advance-form').elements.expenseId.addEventListener('change',updateAdvanceCapacity);
$('advance-dialog').addEventListener('close',()=>{editAdvanceId=null;$('advance-form').reset();});
$('advance-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!canEditLedger())return;const form=event.currentTarget,button=form.querySelector('[type="submit"]'),id=editAdvanceId;button.disabled=true;showError('advance-error','');
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正账单中的金额。');const values=Object.fromEntries(new FormData(form)),amountCents=parseAmount(values.amount);if(amountCents<=0)throw new Error('垫付金额必须大于零。');const remote=await api(`/api/admin/advances${id?`/${encodeURIComponent(id)}`:''}`,{method:id?'PATCH':'POST',body:{version:state.version,expenseId:values.expenseId,memberId:values.memberId,amountCents,note:values.note}});$('advance-dialog').close();acceptRemote(remote);toast('垫付记录已保存');}
  catch(error){if(error.status===409&&error.data.state)receiveConflict(error.data.state);showError('advance-error',error.message);}finally{button.disabled=false;}
});
$('advance-list').addEventListener('click',event=>{const edit=event.target.closest('[data-edit-advance]'),remove=event.target.closest('[data-delete-advance]');if(edit)openAdvanceEditor(edit.dataset.editAdvance);if(remove&&isAdmin()&&canEditLedger()&&confirm('删除这笔垫付记录？结算建议会重新计算。'))adminAction(async()=>{state=await api(`/api/admin/advances/${encodeURIComponent(remove.dataset.deleteAdvance)}`,{method:'DELETE',body:{version:state.version}});});});
$('gathering-admin-summary').addEventListener('click',event=>{if(!isAdmin())return;if(event.target.closest('[data-finalize-gathering]')&&confirm('定稿后，本次成员、费用和垫付记录都将锁定。确认定稿？'))gatheringAction(`/api/admin/gatherings/${encodeURIComponent(state.currentGathering.id)}/finalize`);if(event.target.closest('[data-reopen-gathering]')&&confirm('解锁后结算金额可能变化，确认重新允许编辑？'))gatheringAction(`/api/admin/gatherings/${encodeURIComponent(state.currentGathering.id)}/reopen`);});
$('gathering-admin-summary').addEventListener('submit',async event=>{
  if(event.target.id!=='gathering-edit-form')return;event.preventDefault();if(!isAdmin())return;const form=event.target,button=form.querySelector('[type="submit"]');button.disabled=true;showError('gathering-error','');
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正账单中的金额，或放弃修改。');const values=Object.fromEntries(new FormData(form));const remote=await api(`/api/admin/gatherings/${encodeURIComponent(state.currentGathering.id)}`,{method:'PATCH',body:{version:state.version,...values}});editedForms.delete('gathering-edit-form');acceptRemote(remote);toast('聚餐信息已更新');}catch(error){if(error.status===409&&error.data.state)receiveConflict(error.data.state);showError('gathering-error',error.message);}finally{button.disabled=false;}
});
$('gathering-form').addEventListener('submit',event=>{event.preventDefault();if(!isAdmin())return;const form=event.currentTarget;if(confirm('将本次聚餐归档并开始新账单？归档后的账单将仅可查看。')){editedForms.delete('gathering-form');gatheringAction('/api/admin/gatherings',{name:form.elements.name.value,date:form.elements.date.value,carryMembers:form.elements.carryMembers.checked});}});
$('history-nav').addEventListener('click',()=>{if(!user){openLogin();return;}requestContentLeave(()=>switchView('history'));});$('history-refresh').addEventListener('click',loadGatherings);
$('gathering-list').addEventListener('click',event=>{const button=event.target.closest('[data-view-gathering]');if(button)openHistoryDetail(button.dataset.viewGathering);});
$('sessions-refresh').addEventListener('click',loadSessions);$('backups-refresh').addEventListener('click',loadBackups);
$('password-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!user)return;const form=event.currentTarget,button=form.querySelector('[type="submit"]');showError('password-error','');
  if(form.elements.newPassword.value!==form.elements.confirmPassword.value){showError('password-error','两次输入的新密码不一致。');return;}
  if(!confirm('修改密码会退出此账号的全部设备，确认继续？'))return;button.disabled=true;
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正金额，或放弃修改并重新登录后再修改密码。');await api('/api/account/password',{method:'POST',body:{currentPassword:form.elements.currentPassword.value,newPassword:form.elements.newPassword.value}});form.reset();await finishSecurityLogout('密码已修改，请使用新密码重新登录。');}
  catch(error){showError('password-error',error.message);}finally{button.disabled=false;}
});
$('admin-accounts').addEventListener('click',event=>{const button=event.target.closest('[data-reset-password]');if(!button||!isAdmin())return;const account=accounts.find(item=>item.id===button.dataset.resetPassword);if(!account)return;resettingAccountId=account.id;$('reset-password-form').reset();$('reset-password-description').textContent=`重设「${account.username}」的密码会退出该账号的全部设备。请输入你自己的管理员密码进行验证。`;showError('reset-password-error','');$('reset-password-dialog').showModal();});
$('reset-password-dialog').addEventListener('close',()=>{resettingAccountId=null;$('reset-password-form').reset();});
$('reset-password-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!isAdmin()||!resettingAccountId)return;const form=event.currentTarget,button=form.querySelector('[type="submit"]'),id=resettingAccountId;showError('reset-password-error','');
  if(form.elements.newPassword.value!==form.elements.confirmPassword.value){showError('reset-password-error','两次输入的新密码不一致。');return;}button.disabled=true;
  try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正账单金额。');const result=await api(`/api/admin/accounts/${encodeURIComponent(id)}/password`,{method:'POST',body:{adminPassword:form.elements.adminPassword.value,newPassword:form.elements.newPassword.value}});$('reset-password-dialog').close();if(result.sessionRevoked)await finishSecurityLogout('密码已重设，请使用新密码重新登录。');else toast('密码已重设，该账户的全部设备已退出。');}
  catch(error){showError('reset-password-error',error.message);}finally{button.disabled=false;}
});
$('sessions-list').addEventListener('click',async event=>{const button=event.target.closest('[data-revoke-session]');if(!button||!user)return;const current=button.dataset.currentSession==='true';if(current&&localPending()){showError('sessions-error','当前有未保存的输入，请用右上角退出并放弃修改，或先完成保存。');return;}if(!confirm(current?'确认退出当前设备？':'确认撤销这次登录？'))return;button.disabled=true;try{await api(`/api/account/sessions/${encodeURIComponent(button.dataset.revokeSession)}`,{method:'DELETE',body:{}});if(current)await finishSecurityLogout('当前设备已退出登录。');else{toast('已撤销该次登录。');loadSessions();}}catch(error){showError('sessions-error',error.message);button.disabled=false;}});
$('sessions-revoke-all').addEventListener('click',async()=>{if(!user||!confirm('确认退出该账号的全部设备（包括当前设备）？'))return;try{await flushSaves();if(invalidInputs.size)throw new Error('请先修正金额，或使用右上角退出并放弃修改。');await api('/api/account/sessions/revoke-all',{method:'POST',body:{}});await finishSecurityLogout('该账号的全部设备已退出。');}catch(error){showError('sessions-error',error.message);}});
document.addEventListener('click',event=>{const reset=event.target.closest('[data-reset-form]');if(!reset)return;const id=reset.dataset.resetForm;editedForms.delete(id);if(id==='gathering-edit-form')renderGatheringAdmin();else $(id).reset();toast('已清空未提交的表单输入');});
document.addEventListener('input',event=>{const form=event.target.closest('form');if(form&&['member-form','expense-form','gathering-form','gathering-edit-form'].includes(form.id))editedForms.add(form.id);});
window.addEventListener('focus',()=>syncRemote());document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncRemote();});
setInterval(()=>syncRemote(),5000);

window.addEventListener('beforeunload',event=>{if(editedForms.size||recovery||dirty.size||savingPromise||invalidInputs.size||pageContentDirty()||contentUploads.size||contentSaving){event.preventDefault();event.returnValue='';}});
window.addEventListener('online',()=>{if(user&&dirty.size)flushSaves().catch(()=>{});});

async function init(){
  applyContent(); renderContentEditor();
  const results = await Promise.allSettled([api('/api/state'),api('/api/session'),api('/api/content')]);
  if(results[2].status==='fulfilled') {
    content=copyContent(results[2].value);contentDraft=copyContent(content);contentLoaded=true;applyContent();renderContentEditor();
  } else contentLoadError(results[2].reason.message);
  try {
    if(results[0].status==='rejected')throw results[0].reason;
    if(results[1].status==='rejected')throw results[1].reason;
    state=results[0].value;serverState=structuredClone(state);lastSyncAt=new Date();user=results[1].value.user;csrfToken=results[1].value.csrfToken||'';
    renderAuth();renderExpenses();renderSync();renderGatheringAdmin();saveStatus(user?'全部修改已保存':'浏览模式');
  } catch(error){showError('global-error',error.message);saveStatus('加载失败','error');$('people-grid').innerHTML='<div class="loading-card">账单暂未加载，请刷新页面重试。</div>';$('expense-grid').innerHTML='';}
}
init();
