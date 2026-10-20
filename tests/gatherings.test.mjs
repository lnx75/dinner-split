import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';
import { calculateLedger } from '../public/split.js';

const salt = 'gathering-test-salt';
const hash = scryptSync('test-secret-password', salt, 64).toString('hex');
const original = {
  version: 13, ledgerSchemaVersion: 2,
  members: [{ id: 'a', name: '甲', order: 0, color: '#C9683F', avatarUrl: '' }, { id: 'b', name: '乙', order: 1, color: '#50837A', avatarUrl: '' }, { id: 'c', name: '丙', order: 2, color: '#6883A1', avatarUrl: '' }],
  expenses: [{ id: 'dinner', title: '晚餐', amountCents: 1001, participantIds: ['a', 'b', 'c'] }],
  accounts: [{ id: 'admin', username: 'admin', role: 'admin', salt, hash }, { id: 'editor', username: 'editor', role: 'editor', salt, hash }],
};
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-gathering-test-'));
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

test('gathering migration preserves ledger, credentials, active JWT and CSRF without changing version', async t => {
  const f = await fixture(t);
  const migrated = await f.read();
  for (const key of ['version', 'members', 'expenses', 'accounts']) assert.deepEqual(migrated[key], original[key]);
  assert.equal(migrated.currentGathering.status, 'open');
  assert.match(migrated.currentGathering.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(migrated.gatherings, []);
  assert.deepEqual(migrated.advances, []);
  const auth = await f.login();
  const before = await f.read();
  await f.restart(saved => { delete saved.currentGathering; delete saved.gatherings; delete saved.advances; });
  const after = await f.read();
  assert.deepEqual(after.authSessions, before.authSessions);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual((await f.request('/api/session', { auth })).data, { user: auth.user, csrfToken: auth.csrfToken });
  assert.equal((await f.write('/api/admin/members', auth, { name: '迁移后新增' })).status, 201);
  const exposed = await f.state();
  assert.equal('gatherings' in exposed, false);
  assert.equal('authSessions' in exposed, false);
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

test('finalizing locks every ledger route and archived snapshots survive the next gathering unchanged', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  let state = await f.state();
  const id = state.currentGathering.id;
  assert.equal((await f.request('/api/gatherings')).status, 401);
  assert.equal((await f.write(`/api/admin/gatherings/${id}/finalize`, editor)).status, 403);
  assert.equal((await f.write('/api/admin/gatherings', admin, { name: '下一餐', date: '2026-10-21', carryMembers: true })).data.error, 'gathering_open');
  assert.equal((await f.write(`/api/admin/gatherings/${id}`, admin, { name: '生日聚餐', date: '2026-10-20' }, 'PATCH')).status, 200);
  assert.equal((await f.write('/api/admin/advances', editor, { expenseId: 'dinner', memberId: 'a', amountCents: 10 })).status, 201);
  const advanceId = (await f.state()).advances[0].id;
  assert.equal((await f.write(`/api/admin/gatherings/${id}/finalize`, admin)).status, 200);
  const locked = await f.state();
  for (const [route, method, body, auth] of [
    ['/api/admin/expenses', 'POST', { title: '不能新增' }, editor],
    ['/api/admin/expenses/dinner', 'PATCH', { title: '不能改名' }, editor],
    ['/api/admin/expenses/dinner', 'DELETE', {}, admin],
    ['/api/expenses/dinner', 'PATCH', { amountCents: 10, participantIds: ['a'] }, editor],
    ['/api/admin/members', 'POST', { name: '不能新增' }, editor],
    ['/api/admin/members/a', 'PATCH', { name: '不能改' }, editor],
    ['/api/admin/members/a', 'DELETE', {}, admin],
    ['/api/admin/advances', 'POST', { expenseId: 'dinner', memberId: 'a', amountCents: 1001 }, editor],
    [`/api/admin/advances/${advanceId}`, 'PATCH', { amountCents: 20 }, editor],
    [`/api/admin/advances/${advanceId}`, 'DELETE', {}, admin],
    [`/api/admin/gatherings/${id}`, 'PATCH', { name: '不能改聚餐' }, admin],
  ]) assert.equal((await f.write(route, auth, body, method)).data.error, 'gathering_finalized', route);
  assert.deepEqual(await f.state(), locked);
  const avatar = await f.request('/api/member-avatars', { method: 'POST', auth: editor, body: {} });
  assert.equal(avatar.data.error, 'gathering_finalized');
  assert.deepEqual(avatar.data.state, locked);
  assert.equal((await f.write('/api/admin/gatherings', admin, { name: '下一餐', date: '2026-10-21', carryMembers: true })).status, 201);
  state = await f.state();
  assert.equal(state.currentGathering.status, 'open');
  assert.notEqual(state.currentGathering.id, id);
  assert.equal(state.version, locked.version + 1);
  assert.deepEqual(state.members, locked.members);
  assert.deepEqual(state.expenses, []);
  assert.deepEqual(state.advances, []);
  const history = (await f.request(`/api/gatherings/${id}`, { auth: editor })).data;
  assert.deepEqual(history, { gathering: locked.currentGathering, members: locked.members, expenses: locked.expenses, advances: locked.advances, version: locked.version });
  assert.equal((await f.write(`/api/admin/gatherings/${id}/reopen`, admin)).data.error, 'history_read_only');
  assert.equal((await f.write('/api/admin/members/a', editor, { version: locked.version, name: '旧页面迟到修改' }, 'PATCH')).data.error, 'version_conflict');
  assert.equal((await f.write('/api/admin/members/a', editor, { name: '新聚餐改名' }, 'PATCH')).status, 200);
  await f.restart();
  assert.deepEqual((await f.request(`/api/gatherings/${id}`, { auth: admin })).data, history);
  const list = (await f.request('/api/gatherings', { auth: editor })).data.gatherings;
  assert.equal(list.length, 2);
  assert.equal(list[0].archived, false);
  assert.equal(list[1].archived, true);
  assert.equal(list[1].totalCents, 1001);
});

test('reopen unlocks current gathering and validation or concurrent saves never archive partial data', async t => {
  const f = await fixture(t), admin = await f.login();
  const id = (await f.state()).currentGathering.id;
  await f.write(`/api/admin/gatherings/${id}/finalize`, admin);
  const before = await f.read();
  for (const date of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-1-1']) assert.equal((await f.write('/api/admin/gatherings', admin, { name: '下一餐', date, carryMembers: false })).status, 422);
  assert.deepEqual(await f.read(), before);
  const parallel = await Promise.all([0, 1].map(i => f.request('/api/admin/gatherings', { method: 'POST', auth: admin, body: { version: before.version, name: `下一餐${i}`, date: '2026-11-01', carryMembers: false } })));
  assert.deepEqual(parallel.map(result => result.status).sort(), [201, 409]);
  assert.equal((await f.read()).gatherings.length, 1);
  assert.deepEqual((await f.state()).members, []);
  const newId = (await f.state()).currentGathering.id;
  await f.write(`/api/admin/gatherings/${newId}/finalize`, admin);
  await f.write(`/api/admin/gatherings/${newId}/reopen`, admin);
  assert.equal((await f.state()).currentGathering.status, 'open');
  assert.equal((await f.write('/api/admin/members', admin, { name: '可编辑' })).status, 201);
});

test('advance concurrent writes enforce versions and file persistence failure leaves all state intact', async t => {
  const f = await fixture(t), admin = await f.login();
  const version = (await f.state()).version;
  const results = await Promise.all(['a', 'b'].map(memberId => f.request('/api/admin/advances', { method: 'POST', auth: admin, body: { version, expenseId: 'dinner', memberId, amountCents: 1001 } })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const before = await f.read(), filename = path.join(f.dataDir, 'state.json'), saved = path.join(f.dataDir, 'saved.json');
  await fs.rename(filename, saved); await fs.mkdir(filename);
  try {
    assert.equal((await f.write(`/api/admin/gatherings/${before.currentGathering.id}/finalize`, admin)).status, 500);
    assert.equal((await f.state()).currentGathering.status, 'open');
  } finally { await fs.rmdir(filename); await fs.rename(saved, filename); }
  assert.deepEqual(await f.read(), before);
});

test('backup status is administrator only and never discloses internal paths or raw operational errors', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  assert.equal((await f.request('/api/admin/backups')).status, 401);
  assert.equal((await f.request('/api/admin/backups', { auth: editor })).status, 403);
  assert.deepEqual((await f.request('/api/admin/backups', { auth: admin })).data, { configured: false });
  await fs.writeFile(path.join(f.dataDir, 'backup-status.json'), JSON.stringify({ lastSuccessAt: '2026-10-20T10:00:00Z', lastAttemptAt: '2026-10-20T10:00:00Z', verifiedAt: '2026-10-20T10:00:00Z', backupCount: 1, retentionDays: 30, latestSizeBytes: 1234, lastError: '/root/private/file secret-value', archivePath: '/root/private/file' }));
  const status = (await f.request('/api/admin/backups', { auth: admin })).data;
  assert.equal(status.configured, true);
  assert.equal(status.backupCount, 1);
  assert.equal(JSON.stringify(status).includes('/root'), false);
  assert.equal(JSON.stringify(status).includes('secret-value'), false);
});
