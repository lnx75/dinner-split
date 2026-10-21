import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';
import { SIGNING_KEY_FILENAME } from '../auth.mjs';
import { calculateLedger } from '../public/split.js';

const salt = 'bill-test-salt';
const hash = scryptSync('test-secret-password', salt, 64).toString('hex');
const original = {
  version: 13, ledgerSchemaVersion: 2,
  members: [{ id: 'a', name: '甲', order: 0, color: '#C9683F', avatarUrl: '' }, { id: 'b', name: '乙', order: 1, color: '#50837A', avatarUrl: '' }, { id: 'c', name: '丙', order: 2, color: '#6883A1', avatarUrl: '' }],
  expenses: [{ id: 'dinner', title: '晚餐', amountCents: 1001, participantIds: ['a', 'b', 'c'] }],
  accounts: [{ id: 'admin', username: 'admin', role: 'admin', salt, hash }, { id: 'editor', username: 'editor', role: 'editor', salt, hash }],
};
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-bill-test-'));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(original));
  let server, base;
  async function start() { server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; }
  await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, auth, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(username = 'admin', password = 'test-secret-password') {
    const result = await request('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(result.status, 200, result.data.message);
    return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const state = async () => (await request('/api/state')).data;
  async function write(route, auth, body = {}, method = 'POST') { return request(route, { method, auth, body: { version: (await state()).version, ...body } }); }
  async function restart(update) { await new Promise(resolve => server.close(resolve)); if (update) { const saved = await read(); await update(saved); await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(saved)); } await start(); }
  return { dataDir, request, login, state, write, read, restart, get server() { return server; }, get base() { return base; } };
}

test('single-bill migration unlocks old finalized bills and preserves history, credentials, JWT and CSRF without changing version', async t => {
  const f = await fixture(t);
  const migrated = await f.read();
  for (const key of ['version', 'members', 'expenses', 'accounts']) assert.deepEqual(migrated[key], original[key]);
  assert.equal(migrated.currentGathering.status, 'open');
  assert.match(migrated.currentGathering.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(migrated.gatherings, []);
  assert.deepEqual(migrated.advances, []);
  assert.equal(migrated.simpleLedgerVersion, 1);
  const auth = await f.login();
  const before = await f.read();
  const signingKey = await fs.readFile(path.join(f.dataDir, SIGNING_KEY_FILENAME));
  const finalized = { ...before.currentGathering, status: 'finalized', finalizedAt: '2026-10-20T10:00:00.000Z' };
  const historical = { gathering: { ...finalized, id: 'legacy-history' }, members: before.members, expenses: before.expenses, advances: before.advances, version: before.version };
  await f.restart(saved => { delete saved.simpleLedgerVersion; saved.currentGathering = finalized; saved.gatherings = [historical]; });
  const after = await f.read();
  assert.equal(after.version, before.version);
  assert.deepEqual(after.currentGathering, { ...finalized, status: 'open', finalizedAt: null });
  assert.deepEqual(after.gatherings, [historical]);
  for (const key of ['members', 'expenses', 'advances', 'content', 'auditLogs']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.authSessions, before.authSessions);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, SIGNING_KEY_FILENAME)), signingKey);
  assert.deepEqual((await f.request('/api/session', { auth })).data, { user: auth.user, csrfToken: auth.csrfToken });
  assert.equal((await f.write('/api/admin/members', auth, { name: '迁移后新增' })).status, 201);
  const exposed = await f.state();
  assert.equal('gatherings' in exposed, false);
  assert.equal('authSessions' in exposed, false);
  const migratedOnce = await f.read();
  await f.restart();
  assert.deepEqual(await f.read(), migratedOnce);
});

test('advances conserve cents, support editor create/update, refuse overpayment and protect linked records', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  assert.equal((await f.write('/api/admin/advances', editor, { expenseId: 'dinner', memberId: 'a', amountCents: 500, note: '甲先付' })).status, 201);
  let state = await f.state();
  let ledger = calculateLedger(state);
  assert.equal(ledger.paidCents, 500);
  assert.equal(ledger.unrecordedCents, 501);
  assert.equal(ledger.settlementReady, false);
  assert.deepEqual(ledger.settlements, []);
  const first = state.advances[0];
  assert.equal((await f.write(`/api/admin/advances/${first.id}`, editor, { amountCents: 501 }, 'PATCH')).status, 200);
  assert.equal((await f.write('/api/admin/advances', editor, { expenseId: 'dinner', memberId: 'b', amountCents: 500 })).status, 201);
  ledger = calculateLedger(await f.state());
  assert.equal(ledger.settlementReady, true);
  assert.equal(ledger.people.reduce((sum, person) => sum + person.netCents, 0), 0);
  assert.deepEqual(ledger.people.map(person => person.totalCents), [334, 334, 333]);
  assert.deepEqual(ledger.people.map(person => person.netCents), [167, 166, -333]);
  assert.deepEqual(ledger.settlements, [{ fromMemberId: 'c', toMemberId: 'a', amountCents: 167 }, { fromMemberId: 'c', toMemberId: 'b', amountCents: 166 }]);
  const before = await f.read();
  for (const fields of [{ amountCents: 1 }, { amountCents: 0 }, { amountCents: 0.5 }, { memberId: 'missing', amountCents: 1 }, { expenseId: 'missing', amountCents: 1 }]) {
    assert.equal((await f.write('/api/admin/advances', editor, { expenseId: 'dinner', memberId: 'a', ...fields })).status, 422);
  }
  assert.equal((await f.write(`/api/admin/advances/${first.id}`, editor, {}, 'DELETE')).status, 403);
  assert.equal((await f.write('/api/expenses/dinner', admin, { amountCents: 1000, participantIds: ['a', 'b', 'c'] }, 'PATCH')).data.error, 'advance_exceeds_expense');
  assert.equal((await f.write('/api/admin/members/a', admin, {}, 'DELETE')).data.error, 'advance_exists');
  assert.equal((await f.write('/api/admin/expenses/dinner', admin, {}, 'DELETE')).data.error, 'advance_exists');
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.write(`/api/admin/advances/${first.id}`, admin, {}, 'DELETE')).status, 200);
  assert.equal(calculateLedger(await f.state()).settlementReady, false);
});

test('removed archive, gathering management and backup routes return 404 without exposing or changing private snapshots', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  const current = await f.state();
  const historical = { gathering: { ...current.currentGathering, id: 'legacy-private-id', status: 'finalized', finalizedAt: '2026-10-20T10:00:00.000Z' }, members: current.members, expenses: current.expenses, advances: current.advances, version: current.version };
  await f.restart(saved => { saved.gatherings = [historical]; });
  const before = await f.read();
  for (const auth of [undefined, editor, admin]) {
    for (const [route, method] of [
      ['/api/gatherings', 'GET'], ['/api/gatherings/legacy-private-id', 'GET'],
      ['/api/admin/gatherings', 'GET'], ['/api/admin/gatherings', 'POST'],
      [`/api/admin/gatherings/${current.currentGathering.id}`, 'PATCH'],
      [`/api/admin/gatherings/${current.currentGathering.id}/finalize`, 'POST'],
      [`/api/admin/gatherings/${current.currentGathering.id}/reopen`, 'POST'],
      ['/api/admin/backups', 'GET'],
    ]) {
      const result = await f.request(route, { method, auth, body: method === 'GET' ? undefined : { version: current.version } });
      assert.equal(result.status, 404, `${method} ${route}`);
      assert.equal(JSON.stringify(result.data).includes('legacy-private-id'), false);
    }
  }
  assert.deepEqual(await f.read(), before);
  assert.equal('gatherings' in await f.state(), false);
});

test('clearing a bill is admin-only, checks CSRF and version, keeps members and accounts, and rotates the bill identity without archiving', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  assert.equal((await f.write('/api/admin/advances', editor, { expenseId: 'dinner', memberId: 'a', amountCents: 100 })).status, 201);
  const before = await f.read();
  const version = before.version;
  assert.equal((await f.request('/api/admin/bill/reset', { method: 'POST', body: { version } })).status, 401);
  assert.equal((await f.request('/api/admin/bill/reset', { method: 'POST', auth: editor, body: { version } })).status, 403);
  assert.equal((await f.request('/api/admin/bill/reset', { method: 'POST', auth: admin, body: { version }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/api/admin/bill/reset', { method: 'POST', auth: admin, body: { version: version - 1 } })).data.error, 'version_conflict');
  assert.equal((await f.request('/api/admin/bill/reset', { method: 'POST', auth: admin, body: { version, carryMembers: false } })).status, 422);
  assert.deepEqual(await f.read(), before);
  const cleared = await f.request('/api/admin/bill/reset', { method: 'POST', auth: admin, body: { version } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.version, version + 1);
  assert.notEqual(cleared.data.currentGathering.id, before.currentGathering.id);
  assert.equal(cleared.data.currentGathering.status, 'open');
  assert.deepEqual(cleared.data.expenses, []);
  assert.deepEqual(cleared.data.advances, []);
  assert.deepEqual(cleared.data.members, before.members);
  const saved = await f.read();
  for (const key of ['members', 'accounts', 'content', 'authSessions', 'gatherings']) assert.deepEqual(saved[key], before[key]);
  assert.equal(saved.auditLogs.at(-1).action, 'bill.cleared');
  assert.equal(saved.auditLogs.at(-1).username, 'admin');
  assert.equal((await f.request('/api/session', { auth: admin })).status, 200);
  assert.equal((await f.request('/api/admin/expenses', { method: 'POST', auth: editor, body: { version, title: '旧页面迟到提交', amountCents: 100, participantIds: ['a'] } })).data.error, 'version_conflict');
  assert.deepEqual(await f.read(), saved);
  await f.restart();
  assert.deepEqual(await f.read(), saved);
});

test('parallel bill resets commit once, and a persistence failure keeps the complete bill and audit log intact', async t => {
  const f = await fixture(t), admin = await f.login();
  assert.equal((await f.write('/api/admin/advances', admin, { expenseId: 'dinner', memberId: 'a', amountCents: 1001 })).status, 201);
  const beforeFailure = await f.read(), filename = path.join(f.dataDir, 'state.json'), saved = path.join(f.dataDir, 'saved.json');
  const publicBeforeFailure = await f.state();
  await fs.rename(filename, saved); await fs.mkdir(filename);
  try {
    assert.equal((await f.write('/api/admin/bill/reset', admin)).status, 500);
    assert.deepEqual(await f.state(), publicBeforeFailure);
  } finally { await fs.rmdir(filename); await fs.rename(saved, filename); }
  assert.deepEqual(await f.read(), beforeFailure);
  const results = await Promise.all([0, 1].map(() => f.request('/api/admin/bill/reset', { method: 'POST', auth: admin, body: { version: beforeFailure.version } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const after = await f.read();
  assert.equal(after.version, beforeFailure.version + 1);
  assert.equal(after.auditLogs.filter(event => event.action === 'bill.cleared').length, 1);
  assert.deepEqual(after.expenses, []);
  assert.deepEqual(after.advances, []);
  assert.deepEqual(after.gatherings, beforeFailure.gatherings);
});

test('dish amounts and participants save atomically, and a late member owes only for later selected dishes', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  await f.write('/api/admin/bill/reset', admin);
  assert.equal((await f.write('/api/admin/members', editor, { name: '丁' })).status, 201);
  const early = await f.state();
  assert.equal(early.members.length, 4);
  assert.equal((await f.write('/api/admin/expenses', editor, { title: '我和甲吃的菜', amountCents: 1001, participantIds: ['a', 'b'] })).status, 201);
  let state = await f.state();
  const firstId = state.expenses[0].id;
  const firstExpense = structuredClone(state.expenses[0]);
  assert.equal((await f.write('/api/admin/members', editor, { name: '晚到的戊' })).status, 201);
  state = await f.state();
  const lateId = state.members.at(-1).id;
  assert.equal(state.members.length, 5);
  assert.deepEqual(state.expenses[0], firstExpense);
  assert.equal(state.expenses[0].participantIds.includes(lateId), false);
  assert.equal(calculateLedger(state).people.find(person => person.id === lateId).totalCents, 0);
  const allIds = state.members.map(member => member.id);
  assert.equal((await f.write('/api/admin/expenses', editor, { title: '后上的菜', amountCents: 1002, participantIds: allIds })).status, 201);
  state = await f.state();
  let ledger = calculateLedger(state);
  assert.equal(ledger.totalCents, 2003);
  assert.equal(ledger.allocatedCents, ledger.totalCents);
  assert.deepEqual(ledger.people.map(person => person.totalCents), [702, 701, 200, 200, 200]);
  assert.equal(ledger.people.find(person => person.id === lateId).totalCents, 200);
  assert.equal((await f.write(`/api/admin/expenses/${firstId}`, editor, { title: '修改整道菜', amountCents: 1003, participantIds: ['a', lateId] }, 'PATCH')).status, 200);
  state = await f.state();
  assert.deepEqual(state.expenses[0], { ...firstExpense, title: '修改整道菜', amountCents: 1003, participantIds: ['a', lateId] });
  ledger = calculateLedger(state);
  assert.equal(ledger.allocatedCents, 2005);
  assert.deepEqual(ledger.people.map(person => person.totalCents), [703, 201, 200, 200, 701]);
  assert.equal((await f.write(`/api/admin/expenses/${firstId}`, editor, {}, 'DELETE')).status, 403);
});

test('invalid atomic expense saves reject the entire edit without changing name, amount, participants or audit history', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  const invalid = [
    { title: '改名不应部分保存', amountCents: 300, participantIds: [] },
    { title: '改名不应部分保存', amountCents: 300, participantIds: ['missing'] },
    { title: '改名不应部分保存', amountCents: 300, participantIds: ['a', 'a'] },
    { title: '改名不应部分保存', amountCents: 0.5, participantIds: ['a'] },
    { title: '', amountCents: 300, participantIds: ['a'] },
  ];
  const before = await f.read();
  for (const fields of invalid) {
    assert.equal((await f.write('/api/admin/expenses', editor, fields)).status, 422);
    assert.equal((await f.write('/api/admin/expenses/dinner', editor, fields, 'PATCH')).status, 422);
    assert.deepEqual(await f.read(), before);
  }
  assert.equal((await f.write('/api/admin/expenses/dinner', editor, {}, 'PATCH')).status, 422);
  assert.equal((await f.request('/api/admin/expenses/dinner', { method: 'PATCH', body: { version: before.version, title: '未登录' } })).status, 401);
  assert.equal((await f.request('/api/admin/expenses/dinner', { method: 'PATCH', auth: editor, headers: { 'X-CSRF-Token': '' }, body: { version: before.version, title: '缺少CSRF' } })).status, 403);
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.write('/api/admin/advances', editor, { expenseId: 'dinner', memberId: 'a', amountCents: 900 })).status, 201);
  const paid = await f.read();
  assert.equal((await f.write('/api/admin/expenses/dinner', editor, { title: '原子保护', amountCents: 899, participantIds: ['b'] }, 'PATCH')).data.error, 'advance_exceeds_expense');
  assert.deepEqual(await f.read(), paid);
  assert.equal((await f.write('/api/admin/expenses/dinner', editor, { title: '只改名称' }, 'PATCH')).status, 200);
  const renamed = await f.state();
  assert.equal(renamed.expenses[0].title, '只改名称');
  assert.equal(renamed.expenses[0].amountCents, 1001);
  assert.deepEqual(renamed.expenses[0].participantIds, ['a', 'b', 'c']);
  assert.equal((await f.write('/api/admin/expenses', admin, { title: '兼容旧请求' })).status, 201);
  const legacy = (await f.state()).expenses.at(-1);
  assert.equal(legacy.amountCents, 0);
  assert.deepEqual(legacy.participantIds, []);
});

test('concurrent advance and full expense writes enforce versions without partial overwrites', async t => {
  const f = await fixture(t), admin = await f.login();
  const version = (await f.state()).version;
  const results = await Promise.all(['a', 'b'].map(memberId => f.request('/api/admin/advances', { method: 'POST', auth: admin, body: { version, expenseId: 'dinner', memberId, amountCents: 1001 } })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const before = await f.state();
  const edits = [{ title: '甲的保存', amountCents: 1002, participantIds: ['a'] }, { title: '乙的保存', amountCents: 1003, participantIds: ['b'] }];
  const saves = await Promise.all(edits.map(edit => f.request('/api/admin/expenses/dinner', { method: 'PATCH', auth: admin, body: { version: before.version, ...edit } })));
  assert.deepEqual(saves.map(result => result.status).sort(), [200, 409]);
  const committed = edits[saves.findIndex(result => result.status === 200)];
  const after = await f.state();
  for (const key of ['title', 'amountCents', 'participantIds']) assert.deepEqual(after.expenses[0][key], committed[key]);
  assert.equal(after.version, before.version + 1);
});
