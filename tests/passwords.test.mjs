import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';

const salt = 'password-test-salt';
const hash = scryptSync('test-secret-password', salt, 64).toString('hex');
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-password-test-'));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 2, ledgerSchemaVersion: 2, members: [], expenses: [], accounts: [{ id: 'admin', username: 'admin', role: 'admin', salt, hash }, { id: 'editor', username: 'editor', role: 'editor', salt, hash }] }));
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
  const post = (route, auth, body) => request(route, { method: 'POST', auth, body });
  async function restart() { await new Promise(resolve => server.close(resolve)); await start(); }
  return { dataDir, request, login, post, read, restart, get server() { return server; }, get base() { return base; } };
}

test('changing a password requires current password, preserves other data and durably revokes all own devices', async t => {
  const f = await fixture(t), admin = await f.login(), anotherAdmin = await f.login(), editor = await f.login('editor');
  assert.equal((await f.post('/api/account/password', admin, { currentPassword: 'wrong', newPassword: 'new-secret-password' })).status, 403);
  assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, 'admin');
  const before = await f.read();
  assert.equal((await f.post('/api/account/password', { ...admin, csrfToken: 'bad' }, { currentPassword: 'test-secret-password', newPassword: 'new-secret-password' })).status, 403);
  for (const newPassword of ['', 'short', 'x'.repeat(257)]) assert.equal((await f.post('/api/account/password', admin, { currentPassword: 'test-secret-password', newPassword })).status, 422);
  assert.equal((await f.post('/api/account/password', admin, { currentPassword: 'test-secret-password', newPassword: 'test-secret-password' })).data.error, 'password_unchanged');
  assert.deepEqual(await f.read(), before);
  const result = await f.post('/api/account/password', admin, { currentPassword: 'test-secret-password', newPassword: 'new-secret-password' });
  assert.equal(result.status, 200);
  assert.equal(result.data.sessionRevoked, true);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  const after = await f.read();
  for (const key of ['version', 'members', 'expenses', 'content', 'gatherings', 'currentGathering', 'advances']) assert.deepEqual(after[key], before[key]);
  assert.notEqual(after.accounts[0].salt, before.accounts[0].salt);
  assert.notEqual(after.accounts[0].hash, before.accounts[0].hash);
  assert.deepEqual(after.accounts[1], before.accounts[1]);
  assert.equal(JSON.stringify(after).includes('new-secret-password'), false);
  assert.equal(after.auditLogs.at(-1).action, 'password.changed');
  await f.restart();
  for (const auth of [admin, anotherAdmin]) assert.deepEqual((await f.request('/api/session', { auth })).data, { user: null });
  assert.equal((await f.request('/api/session', { auth: editor })).data.user.id, 'editor');
  assert.equal((await f.post('/api/login', null, { username: 'admin', password: 'test-secret-password' })).status, 401);
  assert.equal((await f.login('admin', 'new-secret-password')).user.id, 'admin');
});

test('administrator reset verifies administrator password, excludes editors, and only revokes the target account', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor'), editorTwo = await f.login('editor');
  assert.equal((await f.post('/api/admin/accounts/editor/password', editor, { adminPassword: 'test-secret-password', newPassword: 'target-new-secret' })).status, 403);
  assert.equal((await f.post('/api/admin/accounts/editor/password', admin, { adminPassword: 'wrong', newPassword: 'target-new-secret' })).status, 403);
  const result = await f.post('/api/admin/accounts/editor/password', admin, { adminPassword: 'test-secret-password', newPassword: 'target-new-secret' });
  assert.equal(result.status, 200);
  assert.equal(result.data.sessionRevoked, false);
  assert.equal(result.headers.has('set-cookie'), false);
  await f.restart();
  for (const auth of [editor, editorTwo]) assert.deepEqual((await f.request('/api/session', { auth })).data, { user: null });
  assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, 'admin');
  const fresh = await f.login('editor', 'target-new-secret');
  assert.equal(fresh.user.role, 'editor');
  const logs = (await f.request('/api/admin/logs', { auth: admin })).data.logs;
  assert.ok(logs.some(log => log.action === 'password.reset' && log.username === 'admin'));
  for (const secret of ['target-new-secret', 'test-secret-password', salt, hash]) assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('device management only exposes own sessions, rejects other accounts and persists revocations', async t => {
  const f = await fixture(t), admin = await f.login(), otherAdmin = await f.login(), editor = await f.login('editor');
  assert.equal((await f.request('/api/account/sessions')).status, 401);
  const sessions = (await f.request('/api/account/sessions', { auth: admin })).data.sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter(session => session.current).length, 1);
  assert.ok(sessions.every(session => Object.keys(session).sort().join(',') === 'current,expiresAt,id,issuedAt,loginIp'));
  const editorId = (await f.request('/api/account/sessions', { auth: editor })).data.sessions[0].id;
  assert.equal((await f.request(`/api/account/sessions/${editorId}`, { method: 'DELETE', auth: admin, body: {} })).status, 404);
  const otherId = sessions.find(session => !session.current).id;
  assert.equal((await f.request(`/api/account/sessions/${otherId}`, { method: 'DELETE', auth: { ...admin, csrfToken: 'bad' }, body: {} })).status, 403);
  assert.equal((await f.request(`/api/account/sessions/${otherId}`, { method: 'DELETE', auth: admin, body: {} })).data.sessionRevoked, false);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: otherAdmin })).data, { user: null });
  assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, 'admin');
  assert.equal((await f.post('/api/account/sessions/revoke-all', admin, {})).data.sessionRevoked, true);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: admin })).data, { user: null });
  assert.equal((await f.request('/api/session', { auth: editor })).data.user.id, 'editor');
});

test('password verification attempts are limited without revoking a legitimate active cookie', async t => {
  const f = await fixture(t), admin = await f.login();
  for (let i = 0; i < 10; i++) assert.equal((await f.post('/api/account/password', admin, { currentPassword: 'wrong', newPassword: 'new-secret-password' })).status, 403);
  const before = await f.read();
  for (let i = 0; i < 3; i++) assert.equal((await f.post('/api/account/password', admin, { currentPassword: 'test-secret-password', newPassword: 'new-secret-password' })).status, 429);
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, 'admin');
});

test('failed password persistence does not update credentials, sessions or audit history', async t => {
  const f = await fixture(t), admin = await f.login();
  const before = await f.read(), filename = path.join(f.dataDir, 'state.json'), saved = path.join(f.dataDir, 'saved.json');
  await fs.rename(filename, saved); await fs.mkdir(filename);
  try {
    assert.equal((await f.post('/api/account/password', admin, { currentPassword: 'test-secret-password', newPassword: 'new-secret-password' })).status, 500);
    assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, 'admin');
  } finally { await fs.rmdir(filename); await fs.rename(saved, filename); }
  assert.deepEqual(await f.read(), before);
  await f.restart();
  assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, 'admin');
  await f.login();
});

test('a delayed password request cannot overwrite a password reset performed while its body arrives', async t => {
  const f = await fixture(t), admin = await f.login(), editor = await f.login('editor');
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  f.server.once('request', () => ready());
  const delayed = http.request(new URL('/api/account/password', f.base), { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json', Cookie: editor.cookie, 'X-CSRF-Token': editor.csrfToken } });
  const finished = new Promise((resolve, reject) => { delayed.once('error', reject); delayed.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); });
  delayed.write('{"currentPassword":');
  await started;
  assert.equal((await f.post('/api/admin/accounts/editor/password', admin, { adminPassword: 'test-secret-password', newPassword: 'admin-reset-secret' })).status, 200);
  const after = await f.read();
  delayed.end('"test-secret-password","newPassword":"late-overwrite-secret"}');
  assert.equal(await finished, 401);
  assert.deepEqual(await f.read(), after);
  await f.login('editor', 'admin-reset-secret');
});
