import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC', 'base64');

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-audit-test-'));
  let server;
  let base;
  async function start() {
    server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, ...options });
    await new Promise(resolve => server.listen(0, options.listenHost || '127.0.0.1', resolve));
    base = `http://${options.listenHost || '127.0.0.1'}:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, bytes, auth, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method, headers: {
        ...(method !== 'GET' ? { Origin: base, 'Content-Type': bytes ? 'image/png' : 'application/json' } : {}),
        ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken } : {}), ...headers,
      }, body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(username = 'admin', password = 'test-only-admin-password', headers) {
    const result = await request('/api/login', { method: 'POST', body: { username, password }, headers });
    assert.equal(result.status, 200, result.data.message);
    return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  async function restart(update) {
    await new Promise(resolve => server.close(resolve));
    if (update) {
      const stored = await read();
      await update(stored);
      await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(stored));
    }
    await start();
  }
  return { request, login, read, restart, dataDir };
}

test('editors create and update expenses/members/avatars but cannot delete, change pages/accounts or read logs', async t => {
  const { request, login } = await fixture(t);
  const admin = await login();
  assert.equal((await request('/api/admin/accounts', { method: 'POST', auth: admin, body: { username: 'editor1', password: 'editor-secret-123', role: 'editor' } })).status, 201);
  const editor = await login('editor1', 'editor-secret-123');
  assert.equal((await request('/api/admin/logs')).status, 401);
  assert.equal((await request('/api/admin/logs', { auth: editor })).status, 403);
  assert.equal((await request('/api/admin/accounts', { auth: editor })).status, 403);
  assert.equal((await request('/api/admin/accounts', { method: 'POST', auth: editor, body: {} })).status, 403);
  assert.equal((await request('/api/admin/accounts/some-account', { method: 'DELETE', auth: editor })).status, 403);
  assert.equal((await request('/api/admin/content', { method: 'PATCH', auth: editor, body: {} })).status, 403);
  assert.equal((await request('/api/admin/images', { method: 'POST', auth: editor, bytes: PNG })).status, 403);
  assert.equal((await request('/api/member-avatars', { method: 'POST', bytes: PNG })).status, 401);
  assert.equal((await request('/api/member-avatars', { method: 'POST', auth: editor, bytes: PNG, headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
  const upload = await request('/api/member-avatars', { method: 'POST', auth: editor, bytes: PNG });
  assert.equal(upload.status, 201);
  let result = await request('/api/admin/members', { method: 'POST', auth: editor, body: { version: 1, name: '小王', avatarUrl: upload.data.url } });
  assert.equal(result.status, 201, result.data.message);
  let state = result.data;
  const memberId = state.members[0].id;
  result = await request(`/api/admin/members/${memberId}`, { method: 'PATCH', auth: editor, body: { version: state.version, name: '老王', note: '乘车', avatarUrl: '' } });
  assert.equal(result.status, 200);
  state = result.data;
  assert.equal(state.members[0].avatarUrl, '');
  result = await request('/api/admin/expenses', { method: 'POST', auth: editor, body: { version: state.version, title: '餐费', amountCents: 10001, participantIds: [memberId] } });
  assert.equal(result.status, 201);
  state = result.data;
  const expenseId = state.expenses[0].id;
  result = await request(`/api/admin/expenses/${expenseId}`, { method: 'PATCH', auth: editor, body: { version: state.version, title: '晚餐' } });
  assert.equal(result.status, 200);
  state = result.data;
  result = await request(`/api/expenses/${expenseId}`, { method: 'PATCH', auth: editor, body: { version: state.version, amountCents: 12001, participantIds: [memberId] } });
  assert.equal(result.status, 200);
  state = result.data;
  for (const route of [`/api/admin/expenses/${expenseId}`, `/api/admin/members/${memberId}`]) {
    assert.equal((await request(route, { method: 'DELETE', auth: editor, body: { version: state.version } })).status, 403);
  }
  const logs = (await request('/api/admin/logs', { auth: admin })).data.logs;
  assert.equal(logs[0].username, 'editor1');
  assert.equal(logs[0].role, 'editor');
  assert.match(logs[0].summary, /晚餐.*100\.01.*120\.01.*老王/);
  assert.ok(logs.some(event => event.action === 'member.updated' && /姓名.*小王.*老王.*备注.*头像/.test(event.summary)));
  assert.ok(logs.some(event => event.action === 'avatar.uploaded'));
  assert.ok(logs.every(event => !event.action.endsWith('.deleted')));
  result = await request(`/api/admin/expenses/${expenseId}`, { method: 'DELETE', auth: admin, body: { version: state.version } });
  assert.equal(result.status, 200);
  result = await request(`/api/admin/members/${memberId}`, { method: 'DELETE', auth: admin, body: { version: result.data.version } });
  assert.equal(result.status, 200);
  const deletionLogs = (await request('/api/admin/logs', { auth: admin })).data.logs.slice(0, 2);
  assert.deepEqual(deletionLogs.map(event => event.action), ['member.deleted', 'expense.deleted']);
  assert.ok(deletionLogs.every(event => event.username === 'admin'));
});

test('audit events persist, do not leak secrets, paginate stably and never change ledger/content versions', async t => {
  const { request, login, read, restart } = await fixture(t);
  const ledgerBefore = (await request('/api/state')).data;
  const contentBefore = (await request('/api/content')).data;
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'nonexistent', password: 'wrong-secret-never-store' } })).status, 401);
  const admin = await login();
  let result = await request('/api/admin/accounts', { method: 'POST', auth: admin, body: { username: 'editor2', password: 'editor-secret-never-store', role: 'editor' } });
  assert.equal(result.status, 201);
  const editorId = result.data.accounts.find(account => account.username === 'editor2').id;
  assert.equal((await request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: contentBefore.version, texts: { brandName: '聚餐记账' } } })).status, 200);
  assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes: PNG })).status, 201);
  assert.equal((await request(`/api/admin/accounts/${editorId}`, { method: 'DELETE', auth: admin })).status, 200);
  const all = (await request('/api/admin/logs', { auth: admin })).data;
  const originalIds = all.logs.map(event => event.id);
  assert.equal(new Set(originalIds).size, originalIds.length);
  assert.deepEqual(all.logs.map(event => event.action), ['account.deleted', 'image.uploaded', 'content.updated', 'account.created', 'login.succeeded', 'login.failed']);
  assert.ok(all.logs.every(event => Object.keys(event).sort().join(',') === 'action,createdAt,id,ip,loginIp,role,summary,username'));
  assert.ok(all.logs.every(event => !Number.isNaN(Date.parse(event.createdAt))));
  assert.ok(all.logs.every(event => event.ip === '127.0.0.1' && event.loginIp === '127.0.0.1'));
  assert.equal(all.logs.at(-1).username, 'nonexistent');
  assert.equal(all.logs.at(-1).role, null);
  const serialized = JSON.stringify(all);
  for (const secret of ['test-only-admin-password', 'wrong-secret-never-store', 'editor-secret-never-store', admin.csrfToken, admin.cookie.split('=')[1], 'csrfToken', 'salt', 'hash', 'password']) assert.equal(serialized.includes(secret), false, secret);
  const publicState = (await request('/api/state')).data;
  assert.equal('auditLogs' in publicState, false);
  assert.deepEqual(publicState, ledgerBefore);
  assert.equal((await request('/api/content')).data.version, contentBefore.version + 1);
  const page1 = (await request('/api/admin/logs?limit=2', { auth: admin })).data;
  assert.equal(page1.logs.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextBefore, page1.logs[1].id);
  // A new event cannot move the anchor or duplicate rows in the next page.
  await login();
  const page2 = (await request(`/api/admin/logs?limit=2&before=${page1.nextBefore}`, { auth: admin })).data;
  assert.deepEqual(page2.logs.map(event => event.id), originalIds.slice(2, 4));
  const page3 = (await request(`/api/admin/logs?limit=2&before=${page2.nextBefore}`, { auth: admin })).data;
  assert.deepEqual(page3.logs.map(event => event.id), originalIds.slice(4));
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextBefore, null);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'before=bad', `before=${randomUUID()}`, 'extra=true']) {
    assert.equal((await request('/api/admin/logs?' + query, { auth: admin })).status, 422, query);
  }
  assert.equal((await request('/api/logout', { method: 'POST', auth: admin })).status, 200);
  assert.equal((await read()).auditLogs.at(-1).action, 'logout');
  const beforeRestart = await read();
  await restart();
  const adminAgain = await login();
  const afterRestart = (await request('/api/admin/logs', { auth: adminAgain })).data.logs;
  assert.deepEqual(afterRestart.slice(1).map(event => event.id), [...beforeRestart.auditLogs].reverse().map(event => event.id));
  assert.equal((await request('/api/state')).data.version, ledgerBefore.version);
});

test('trusted loopback proxy logs validated client and login IP, rejecting forged forwarding chains', async t => {
  const { request, login } = await fixture(t, { trustProxy: 'loopback' });
  const admin = await login('admin', 'test-only-admin-password', { 'X-Dinner-Client-IP': '203.0.113.17', 'X-Forwarded-For': '198.51.100.200' });
  let result = await request('/api/admin/members', { method: 'POST', auth: admin, headers: { 'X-Dinner-Client-IP': '2001:db8::17' }, body: { version: 1, name: '访客' } });
  assert.equal(result.status, 201);
  let logs = (await request('/api/admin/logs', { auth: admin })).data.logs;
  assert.equal(logs[0].ip, '2001:db8::17');
  assert.equal(logs[0].loginIp, '203.0.113.17');
  assert.equal(logs[1].ip, '203.0.113.17');
  for (const ip of ['203.0.113.1, 198.51.100.2', 'evil', '203.0.113.1:123', '[2001:db8::17]']) {
    assert.equal((await request('/api/login', { method: 'POST', headers: { 'X-Dinner-Client-IP': ip, 'X-Forwarded-For': '198.51.100.200' }, body: { username: 'invalid', password: 'wrong' } })).status, 401);
  }
  logs = (await request('/api/admin/logs', { auth: admin })).data.logs;
  assert.ok(logs.slice(0, 4).every(event => event.ip === '127.0.0.1'));
});

test('default direct connection ignores spoofed proxy headers and invalid proxy configuration fails early', async t => {
  const { request, login } = await fixture(t);
  const admin = await login('admin', 'test-only-admin-password', { 'X-Dinner-Client-IP': '203.0.113.17', 'X-Forwarded-For': '198.51.100.200' });
  const logs = (await request('/api/admin/logs', { auth: admin })).data.logs;
  assert.equal(logs[0].ip, '127.0.0.1');
  for (const trustProxy of [true, '*', 'all', '', '127.0.0.1']) {
    await assert.rejects(createApp({ initialAdminPassword: 'test-only-admin-password', dataDir: '/not-created-by-invalid-proxy', trustProxy }), /TRUST_PROXY/);
  }
});

test('audit migration preserves existing data and versions, and retains the most recent 10000 events', async t => {
  const { request, login, restart, read } = await fixture(t);
  const admin = await login();
  const created = await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: '现有成员' } });
  assert.equal(created.status, 201);
  const original = await read();
  await restart(stored => { delete stored.auditLogs; });
  const migrated = await read();
  assert.deepEqual({ ...migrated, auditLogs: undefined }, { ...original, auditLogs: undefined });
  assert.deepEqual(migrated.auditLogs, []);
  await restart(stored => {
    stored.auditLogs = Array.from({ length: 10000 }, (_, i) => ({ id: randomUUID(), createdAt: new Date(1700000000000 + i).toISOString(), username: 'historic', role: 'admin', action: 'login.succeeded', summary: `历史记录 ${i}`, ip: '127.0.0.1', loginIp: '127.0.0.1' }));
  });
  const stored = await read();
  await login();
  const trimmed = await read();
  assert.equal(trimmed.auditLogs.length, 10000);
  assert.equal(trimmed.auditLogs[0].id, stored.auditLogs[1].id);
  assert.equal(trimmed.auditLogs.at(-1).username, 'admin');
  assert.equal(trimmed.version, original.version);
  assert.equal(trimmed.content.version, original.content.version);
});

test('failed and conflicting mutations add no audit entries, while concurrent successful writes retain every event', async t => {
  const { request, login, read } = await fixture(t);
  const admin = await login();
  const before = await read();
  assert.equal((await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: '' } })).status, 422);
  assert.equal((await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 0, name: '过期提交' } })).status, 409);
  assert.equal((await read()).auditLogs.length, before.auditLogs.length);
  const concurrent = await Promise.all(Array.from({ length: 4 }, (_, i) => request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: `并发成员 ${i}` } })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409, 409, 409]);
  const after = await read();
  assert.equal(after.auditLogs.length, before.auditLogs.length + 1);
  assert.equal(after.auditLogs.at(-1).action, 'member.created');
  const logins = await Promise.all(Array.from({ length: 4 }, (_, i) => request('/api/login', { method: 'POST', body: { username: `bad-${i}`, password: 'wrong' } })));
  assert.ok(logins.every(result => result.status === 401));
  const final = await read();
  assert.equal(final.auditLogs.length, after.auditLogs.length + 4);
  assert.deepEqual(final.auditLogs.slice(-4).map(event => event.username).sort(), ['bad-0', 'bad-1', 'bad-2', 'bad-3']);
  assert.equal(final.version, after.version);
});


test('even configured proxy mode does not trust headers received over a non-loopback connection', async t => {
  const address = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address;
  if (!address) return t.skip('No non-loopback IPv4 interface is available.');
  const { request, login } = await fixture(t, { trustProxy: 'loopback', listenHost: address });
  const admin = await login('admin', 'test-only-admin-password', { 'X-Dinner-Client-IP': '203.0.113.17' });
  const logs = (await request('/api/admin/logs', { auth: admin })).data.logs;
  assert.equal(logs[0].ip, address);
  assert.equal(logs[0].loginIp, address);
});

test('a persistence failure commits neither changes nor audit events and removes any uploaded image', async t => {
  const { request, login, read, dataDir } = await fixture(t);
  const admin = await login();
  const before = await read();
  const statePath = path.join(dataDir, 'state.json');
  const backupPath = path.join(dataDir, 'state.saved.json');
  await fs.rename(statePath, backupPath);
  await fs.mkdir(statePath);
  try {
    assert.equal((await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: '不能提交' } })).status, 500);
    assert.equal((await request('/api/member-avatars', { method: 'POST', auth: admin, bytes: PNG })).status, 500);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads')), []);
    const logs = (await request('/api/admin/logs', { auth: admin })).data.logs;
    assert.deepEqual(logs.map(event => event.id), before.auditLogs.map(event => event.id).reverse());
    assert.deepEqual((await request('/api/state')).data.members, []);
  } finally {
    await fs.rmdir(statePath);
    await fs.rename(backupPath, statePath);
  }
  assert.deepEqual(await read(), before);
});


test('normal and oversized login failures share the IP budget and repeated 429 responses do not append logs', async t => {
  const { request, login, read } = await fixture(t, { trustProxy: 'loopback' });
  const admin = await login();
  for (const [ip, oversized] of [['203.0.113.31', false], ['203.0.113.32', true]]) {
    for (let i = 0; i < 10; i += 1) {
      const body = oversized
        ? i % 2 ? { username: 'admin', password: 'p'.repeat(257) } : { username: 'u'.repeat(81), password: 'wrong' }
        : { username: `unknown-${i}`, password: 'wrong' };
      assert.equal((await request('/api/login', { method: 'POST', headers: { 'X-Dinner-Client-IP': ip }, body })).status, 401);
    }
    const headers = { 'X-Dinner-Client-IP': ip };
    const blocked = await request('/api/login', { method: 'POST', headers, body: { username: 'admin', password: 'test-only-admin-password' } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const beforeRepeated = await read();
    const repeated = await Promise.all(Array.from({ length: 12 }, (_, i) => request('/api/login', { method: 'POST', headers, body: i % 2 ? { username: 'u'.repeat(81), password: 'wrong' } : { username: 'admin', password: 'p'.repeat(257) } })));
    assert.ok(repeated.every(result => result.status === 429));
    assert.deepEqual(await read(), beforeRepeated);
    const logs = (await request('/api/admin/logs', { auth: admin })).data.logs.filter(event => event.ip === ip);
    assert.equal(logs.length, 11);
    assert.equal(logs.filter(event => event.summary === '登录失败：账户或密码不正确').length, 10);
    assert.equal(logs.filter(event => event.summary.includes('暂时限制')).length, 1);
  }
});
