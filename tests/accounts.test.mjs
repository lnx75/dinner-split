import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createApp } from '../server.mjs';

async function fixture(t, create = createApp) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-accounts-test-'));
  let server;
  let base;
  async function start() {
    server = await create({ initialAdminPassword: 'test-only-admin-password', dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, auth, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method, headers: {
        ...(method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken } : {}), ...headers,
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(username = 'admin', password = 'test-only-admin-password') {
    const result = await request('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(result.status, 200, result.data.message);
    return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  async function createAccount(auth, username, role = 'editor', password = 'test-account-secret') {
    const result = await request('/api/admin/accounts', { method: 'POST', auth, body: { username, role, password } });
    assert.equal(result.status, 201, result.data.message);
    return result.data.accounts.find(account => account.username === username);
  }
  const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  async function restart() {
    await new Promise(resolve => server.close(resolve));
    await start();
  }
  return { request, login, createAccount, read, restart, dataDir, get server() { return server; }, get base() { return base; } };
}

test('only administrators with CSRF can edit accounts; validation and uniqueness failures change nothing', async t => {
  const { request, login, createAccount, read } = await fixture(t);
  const admin = await login();
  const target = await createAccount(admin, 'editor-one');
  const editor = await login('editor-one', 'test-account-secret');
  const route = `/api/admin/accounts/${target.id}`;
  const before = await read();
  assert.equal((await request(route, { method: 'PATCH', body: { username: 'renamed' } })).status, 401);
  assert.equal((await request(route, { method: 'PATCH', auth: editor, body: { role: 'admin' } })).status, 403);
  assert.equal((await request(route, { method: 'PATCH', auth: admin, headers: { 'X-CSRF-Token': 'wrong' }, body: { username: 'renamed' } })).status, 403);
  for (const body of [
    {}, { username: '' }, { username: 'a' }, { username: 'a'.repeat(33) }, { username: '含中文' },
    { username: 'has space' }, { username: 'a\nb' }, { username: null },
    { role: null }, { role: 'viewer' }, { role: true },
    { password: 'do-not-change-secret' }, { salt: 'do-not-change-salt' }, { hash: 'do-not-change-hash' },
    { id: 'do-not-change-id' }, { version: 20 }, { username: 'renamed', extra: true },
  ]) {
    assert.equal((await request(route, { method: 'PATCH', auth: admin, body })).status, 422, JSON.stringify(body));
  }
  const duplicate = await request(route, { method: 'PATCH', auth: admin, body: { username: 'ADMIN' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, 'username_exists');
  assert.equal((await request('/api/admin/accounts/missing-id', { method: 'PATCH', auth: admin, body: { role: 'editor' } })).status, 404);
  assert.deepEqual(await read(), before);
  assert.equal((await request('/api/session', { auth: editor })).data.user.username, 'editor-one');
});

test('renaming an account preserves its password record, existing ledger, page and uploads across restart', async t => {
  const { request, login, createAccount, read, restart, dataDir } = await fixture(t);
  const admin = await login();
  const target = await createAccount(admin, 'editor-one');
  const targetLogin1 = await login('editor-one', 'test-account-secret');
  const targetLogin2 = await login('editor-one', 'test-account-secret');
  const member = await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: '现有朋友' } });
  assert.equal(member.status, 201);
  assert.equal((await request('/api/admin/expenses', { method: 'POST', auth: admin, body: { version: member.data.version, title: '现有餐费', amountCents: 901, participantIds: [member.data.members[0].id] } })).status, 201);
  const keptFile = path.join(dataDir, 'uploads', 'existing-private-file');
  await fs.writeFile(keptFile, 'unchanged upload');
  const before = await read();
  const result = await request(`/api/admin/accounts/${target.id}`, { method: 'PATCH', auth: admin, body: { username: '  renamed.editor  ' } });
  assert.equal(result.status, 200, result.data.message);
  assert.deepEqual(result.data, { account: { id: target.id, username: 'renamed.editor', role: 'editor' }, sessionRevoked: false });
  assert.equal(result.headers.has('set-cookie'), false);
  for (const auth of [targetLogin1, targetLogin2]) assert.deepEqual((await request('/api/session', { auth })).data, { user: null });
  const after = await read();
  const oldAccount = before.accounts.find(account => account.id === target.id);
  assert.deepEqual(after.accounts.find(account => account.id === target.id), { ...oldAccount, username: 'renamed.editor' });
  for (const key of ['version', 'ledgerSchemaVersion', 'members', 'expenses', 'content']) assert.deepEqual(after[key], before[key], key);
  assert.equal(await fs.readFile(keptFile, 'utf8'), 'unchanged upload');
  assert.equal(after.auditLogs.length, before.auditLogs.length + 1);
  const event = after.auditLogs.at(-1);
  assert.equal(event.action, 'account.updated');
  assert.equal(event.username, 'admin');
  assert.match(event.summary, /账户名.*editor-one.*renamed\.editor/);
  for (const secret of ['test-account-secret', oldAccount.salt, oldAccount.hash, admin.csrfToken, targetLogin1.cookie]) assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'editor-one', password: 'test-account-secret' } })).status, 401);
  assert.equal((await login('renamed.editor', 'test-account-secret')).user.id, target.id);
  await restart();
  assert.equal((await login('renamed.editor', 'test-account-secret')).user.role, 'editor');
  const reloaded = await read();
  assert.deepEqual(reloaded.accounts, after.accounts);
  for (const key of ['version', 'members', 'expenses', 'content']) assert.deepEqual(reloaded[key], before[key], key);
});

test('role changes revoke every target session and freshly authenticated permissions take effect immediately', async t => {
  const { request, login, createAccount, read } = await fixture(t);
  const admin = await login();
  const target = await createAccount(admin, 'editor-one');
  const oldEditor1 = await login('editor-one', 'test-account-secret');
  const oldEditor2 = await login('editor-one', 'test-account-secret');
  const route = `/api/admin/accounts/${target.id}`;
  const before = await read();
  const promoted = await request(route, { method: 'PATCH', auth: admin, body: { role: 'admin' } });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.account.role, 'admin');
  assert.equal(promoted.data.sessionRevoked, false);
  for (const auth of [oldEditor1, oldEditor2]) assert.equal((await request('/api/admin/logs', { auth })).status, 401);
  const newAdmin1 = await login('editor-one', 'test-account-secret');
  const newAdmin2 = await login('editor-one', 'test-account-secret');
  assert.equal((await request('/api/admin/logs', { auth: newAdmin1 })).status, 200);
  assert.equal((await request(route, { method: 'PATCH', auth: admin, body: { role: 'editor' } })).status, 200);
  for (const auth of [newAdmin1, newAdmin2]) assert.equal((await request('/api/admin/logs', { auth })).status, 401);
  const newEditor = await login('editor-one', 'test-account-secret');
  assert.equal((await request('/api/admin/logs', { auth: newEditor })).status, 403);
  assert.equal((await request('/api/admin/members', { method: 'POST', auth: newEditor, body: { version: before.version, name: '编辑者新增' } })).status, 201);
  const after = await read();
  const events = after.auditLogs.filter(event => event.action === 'account.updated');
  assert.equal(events.length, 2);
  assert.match(events[0].summary, /权限编辑者 → 管理员/);
  assert.match(events[1].summary, /权限管理员 → 编辑者/);
  const original = before.accounts.find(account => account.id === target.id);
  assert.deepEqual(after.accounts.find(account => account.id === target.id), original);
});

test('no-op saves preserve sessions and logs; self edits revoke sessions while protecting the final administrator', async t => {
  const { request, login, createAccount, read } = await fixture(t);
  let admin = await login();
  const otherSession = await login();
  const route = `/api/admin/accounts/${admin.user.id}`;
  const before = await read();
  const unchanged = await request(route, { method: 'PATCH', auth: admin, body: { username: '  admin ', role: 'admin' } });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.data, { account: admin.user, sessionRevoked: false });
  assert.equal(unchanged.headers.has('set-cookie'), false);
  assert.deepEqual(await read(), before);
  assert.equal((await request('/api/admin/logs', { auth: otherSession })).status, 200);
  const lastAdmin = await request(route, { method: 'PATCH', auth: admin, body: { username: 'not-saved', role: 'editor' } });
  assert.equal(lastAdmin.status, 422);
  assert.equal(lastAdmin.data.error, 'last_admin');
  assert.deepEqual(await read(), before);
  const renamed = await request(route, { method: 'PATCH', auth: admin, body: { username: 'renamed-admin' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.sessionRevoked, true);
  assert.match(renamed.headers.get('set-cookie'), /Max-Age=0/);
  for (const auth of [admin, otherSession]) assert.deepEqual((await request('/api/session', { auth })).data, { user: null });
  const renameEvent = (await read()).auditLogs.at(-1);
  assert.equal(renameEvent.username, 'admin');
  assert.equal(renameEvent.role, 'admin');
  admin = await login('renamed-admin');
  await createAccount(admin, 'second-admin', 'admin');
  const downgraded = await request(route, { method: 'PATCH', auth: admin, body: { role: 'editor' } });
  assert.equal(downgraded.status, 200, downgraded.data.message);
  assert.equal(downgraded.data.account.role, 'editor');
  assert.equal(downgraded.data.sessionRevoked, true);
  assert.equal((await request('/api/admin/accounts', { auth: admin })).status, 401);
  const editor = await login('renamed-admin');
  assert.equal(editor.user.role, 'editor');
  assert.equal((await request('/api/admin/accounts', { auth: editor })).status, 403);
});

test('concurrent self-demotions preserve one administrator and competing renames preserve unique usernames', async t => {
  const { request, login, createAccount, read } = await fixture(t);
  const firstAdmin = await login();
  const secondAccount = await createAccount(firstAdmin, 'second-admin', 'admin');
  const secondAdmin = await login('second-admin', 'test-account-secret');
  const before = await read();
  const results = await Promise.all([firstAdmin, secondAdmin].map(auth => request(`/api/admin/accounts/${auth.user.id}`, { method: 'PATCH', auth, body: { role: 'editor' } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 422]);
  assert.equal(results.find(result => result.status === 422).data.error, 'last_admin');
  const after = await read();
  assert.equal(after.accounts.filter(account => account.role === 'admin').length, 1);
  assert.equal(after.auditLogs.length, before.auditLogs.length + 1);
  const remainingAdmin = results[0].status === 200 ? secondAdmin : firstAdmin;
  const targets = await Promise.all(['editor-one', 'editor-two'].map(username => createAccount(remainingAdmin, username)));
  const beforeNames = await read();
  const renames = await Promise.all(targets.map((account, i) => request(`/api/admin/accounts/${account.id}`, { method: 'PATCH', auth: remainingAdmin, body: { username: i ? 'SAME-NAME' : 'same-name' } })));
  assert.deepEqual(renames.map(result => result.status).sort(), [200, 409]);
  const final = await read();
  assert.equal(new Set(final.accounts.map(account => account.username.toLowerCase())).size, final.accounts.length);
  assert.equal(final.auditLogs.length, beforeNames.auditLogs.length + 1);
  assert.equal(final.version, before.version);
  assert.equal(secondAccount.id, secondAdmin.user.id);
});

test('failed account persistence changes neither data, logs nor the target sessions', async t => {
  const { request, login, createAccount, read, dataDir } = await fixture(t);
  const admin = await login();
  const target = await createAccount(admin, 'editor-one');
  const editor = await login('editor-one', 'test-account-secret');
  const before = await read();
  const statePath = path.join(dataDir, 'state.json');
  const savedPath = path.join(dataDir, 'state.saved.json');
  await fs.rename(statePath, savedPath);
  await fs.mkdir(statePath);
  try {
    assert.equal((await request(`/api/admin/accounts/${target.id}`, { method: 'PATCH', auth: admin, body: { username: 'not-committed', role: 'admin' } })).status, 500);
    assert.deepEqual((await request('/api/session', { auth: editor })).data.user, editor.user);
    assert.equal((await request('/api/admin/logs', { auth: editor })).status, 403);
    assert.deepEqual((await request('/api/admin/logs', { auth: admin })).data.logs.map(event => event.id), [...before.auditLogs].reverse().map(event => event.id));
    assert.deepEqual((await request('/api/admin/accounts', { auth: admin })).data.accounts, before.accounts.map(({ id, username, role }) => ({ id, username, role })));
  } finally {
    await fs.rmdir(statePath);
    await fs.rename(savedPath, statePath);
  }
  assert.deepEqual(await read(), before);
});

test('an account edit whose body finishes after its administrator is demoted cannot mutate state or logs', async t => {
  const f = await fixture(t);
  const firstAdmin = await f.login();
  const second = await f.createAccount(firstAdmin, 'second-admin', 'admin');
  const secondAdmin = await f.login('second-admin', 'test-account-secret');
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const observe = incoming => { if (incoming.headers['x-test-delayed'] === 'account-edit') markStarted(); };
  f.server.on('request', observe);
  const delayed = http.request(new URL(`/api/admin/accounts/${second.id}`, f.base), { method: 'PATCH', headers: {
    Origin: f.base, 'Content-Type': 'application/json', Cookie: firstAdmin.cookie,
    'X-CSRF-Token': firstAdmin.csrfToken, 'X-Test-Delayed': 'account-edit',
  } });
  const finished = new Promise((resolve, reject) => {
    delayed.once('error', reject);
    delayed.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
  });
  delayed.write('{"username":');
  await started;
  f.server.off('request', observe);
  assert.equal((await f.request(`/api/admin/accounts/${firstAdmin.user.id}`, { method: 'PATCH', auth: secondAdmin, body: { role: 'editor' } })).status, 200);
  const before = await f.read();
  delayed.end('"not-authorized"}');
  assert.equal(await finished, 401);
  assert.deepEqual(await f.read(), before);
});

test('login racing an account edit rejects a retired username and returns the latest role and audit identity', async t => {
  // Gate the actual asynchronous password calculation, rather than relying on timing.
  const originalScrypt = crypto.scrypt;
  let gate = null;
  const mock = t.mock.method(crypto, 'scrypt', (...args) => {
    if (gate && args[0] === 'test-account-secret') {
      const waiting = gate;
      gate = null;
      waiting.release = () => originalScrypt(...args);
      waiting.started();
      return;
    }
    return originalScrypt(...args);
  });
  syncBuiltinESMExports();
  let gatedCreateApp;
  try {
    ({ createApp: gatedCreateApp } = await import(`../server.mjs?account-login-test=${crypto.randomUUID()}`));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  const f = await fixture(t, gatedCreateApp);
  const admin = await f.login();
  const target = await f.createAccount(admin, 'editor-one');
  async function gatedLogin(username, patch) {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const waiting = { started, release: null };
    gate = waiting;
    const pending = f.request('/api/login', { method: 'POST', body: { username, password: 'test-account-secret' } });
    await ready;
    const changed = await f.request(`/api/admin/accounts/${target.id}`, { method: 'PATCH', auth: admin, body: patch });
    waiting.release();
    assert.equal(changed.status, 200);
    return pending;
  }
  assert.equal((await gatedLogin('editor-one', { username: 'renamed-editor' })).status, 401);
  let result = await gatedLogin('renamed-editor', { role: 'admin' });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.role, 'admin');
  let event = (await f.read()).auditLogs.at(-1);
  assert.equal(event.action, 'login.succeeded');
  assert.equal(event.username, 'renamed-editor');
  assert.equal(event.role, 'admin');
  const priorCookie = result.headers.get('set-cookie').split(';')[0];
  result = await gatedLogin('renamed-editor', { role: 'editor' });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.role, 'editor');
  event = (await f.read()).auditLogs.at(-1);
  assert.equal(event.role, 'editor');
  assert.deepEqual((await f.request('/api/session', { auth: { cookie: priorCookie } })).data, { user: null });
  const freshAuth = { cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: result.data.csrfToken };
  assert.equal((await f.request('/api/admin/logs', { auth: freshAuth })).status, 403);
  assert.equal((await f.request('/api/session', { auth: freshAuth })).data.user.role, 'editor');
});
