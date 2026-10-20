import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';
import { SESSION_TTL_SECONDS, SIGNING_KEY_FILENAME, loadSigningKey, issueJwt, verifyJwt, sessionIdHash, pruneSessions, validateSessionRegistry } from '../auth.mjs';

const salt = 'persistent-auth-test-salt';
const hash = scryptSync('test-only-admin-password', salt, 64).toString('hex');
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function sign(key, header, claims) {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-persistent-auth-'));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 7, ledgerSchemaVersion: 2, members: [], expenses: [],
    accounts: [{ id: 'auth-admin', username: 'admin', role: 'admin', salt, hash }],
  }));
  let server;
  let base;
  async function start() {
    server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, auth, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: {
      ...(method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken } : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(username = 'admin', password = 'test-only-admin-password', auth) {
    const result = await request('/api/login', { method: 'POST', body: { username, password }, auth });
    assert.equal(result.status, 200, result.data.message);
    return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0], setCookie: result.headers.get('set-cookie') };
  }
  const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  async function restart(update) {
    await new Promise(resolve => server.close(resolve));
    if (update) {
      const state = await read();
      await update(state);
      await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state));
    }
    await start();
  }
  return { dataDir, request, login, read, restart };
}

test('JWT validation fixes algorithm, claims, canonical encoding, signature and absolute 30-day expiry', () => {
  const key = randomBytes(32);
  const { token, claims } = issueJwt(key, 'test-admin', 1700000000);
  const header = { alg: 'HS256', typ: 'JWT' };
  assert.deepEqual(verifyJwt(token, key, claims.iat), claims);
  assert.deepEqual(verifyJwt(token, key, claims.exp - 1), claims);
  assert.equal(verifyJwt(token, key, claims.exp), null);
  assert.equal(verifyJwt(token, key, claims.iat - 1), null);
  assert.equal(claims.exp - claims.iat, 30 * 24 * 3600);
  for (const modified of [
    { ...claims, iss: 'other-app' }, { ...claims, aud: 'other-audience' },
    { ...claims, aud: [claims.aud] }, { ...claims, sub: '' }, { ...claims, sub: 1 },
    { ...claims, jti: 'short' }, { ...claims, iat: claims.iat + 1.5 },
    { ...claims, exp: claims.exp + 1 }, { ...claims, exp: String(claims.exp) },
    { ...claims, nbf: claims.iat + 60 }, { ...claims, nbf: claims.iat - 60 },
    { ...claims, role: 'admin' }, { ...claims, iat: -1, exp: SESSION_TTL_SECONDS - 1 },
  ]) assert.equal(verifyJwt(sign(key, header, modified), key, claims.iat), null, JSON.stringify(modified));
  for (const modified of [{ alg: 'none', typ: 'JWT' }, { alg: 'HS384', typ: 'JWT' }, { alg: 'HS256' }, { ...header, kid: 'another-key' }, { ...header, typ: 'jwt' }]) {
    assert.equal(verifyJwt(sign(key, modified, claims), key, claims.iat), null);
  }
  for (const malformed of [
    '', 'old-opaque-cookie', `${token}.extra`, token.replace(/.$/, '='), `${token.slice(0, -2)}AA`,
    sign(randomBytes(32), header, claims), sign(key, header, JSON.stringify(claims).replace('{', '{ ')),
    sign(key, header, JSON.stringify(claims).replace('{', '{"iss":"untrusted",')),
    `${encode(header)}.${encode('{invalid-json}')}.AA`, 'a'.repeat(2049),
  ]) assert.equal(verifyJwt(malformed, key, claims.iat), null, malformed);
});

test('the stable signing key stays private and malformed, permissive or symbolic-link keys fail closed', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-auth-key-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const key = await loadSigningKey(temporary);
  const filename = path.join(temporary, SIGNING_KEY_FILENAME);
  assert.equal(key.length, 32);
  assert.deepEqual(await loadSigningKey(temporary), key);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    await fs.chmod(filename, 0o644);
    await assert.rejects(loadSigningKey(temporary), /JWT/);
    assert.deepEqual(await fs.readFile(filename), key);
    await fs.chmod(filename, 0o600);
  }
  await fs.writeFile(filename, 'invalid');
  await assert.rejects(loadSigningKey(temporary), /JWT/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'invalid');
  await fs.unlink(filename);
  const target = path.join(temporary, 'real-key');
  await fs.writeFile(target, key, { mode: 0o600 });
  await fs.symlink(target, filename);
  await assert.rejects(loadSigningKey(temporary), /JWT/);
});

test('session registry validation and FIFO limits bound persistent login storage', () => {
  const accounts = Array.from({ length: 101 }, (_, i) => ({ id: `account-${i}` }));
  let i = 0;
  const sessions = accounts.flatMap(account => Array.from({ length: 11 }, () => ({
    accountId: account.id, idHash: (++i).toString(16).padStart(64, '0'), csrfToken: 'a'.repeat(48), loginIp: '127.0.0.1',
    issuedAt: 1700000000, expiresAt: 1700000000 + SESSION_TTL_SECONDS,
  })));
  const bounded = pruneSessions(sessions, accounts, 1700000000);
  assert.equal(bounded.length, 1000);
  assert.equal(bounded.at(-1).idHash, sessions.at(-1).idHash);
  assert.equal(new Set(bounded.map(session => session.accountId)).size, 100);
  for (const account of accounts) assert.ok(bounded.filter(session => session.accountId === account.id).length <= 10);
  validateSessionRegistry(bounded);
  assert.deepEqual(pruneSessions(bounded, accounts, 1700000000 + SESSION_TTL_SECONDS), []);
  assert.deepEqual(pruneSessions(bounded, [], 1700000000), []);
  for (const bad of [null, [...bounded, bounded[0]], [{ ...bounded[0], csrfToken: 'bad' }], [{ ...bounded[0], role: 'admin' }], [{ ...bounded[0], loginIp: 'spoof\nip' }]]) {
    assert.throws(() => validateSessionRegistry(bad), /登录会话/);
  }
});

test('persistent JWT and CSRF survive restart while private tokens stay absent from public and audit APIs', async t => {
  const f = await fixture(t);
  const before = await f.read();
  assert.equal(before.version, 7);
  assert.deepEqual(before.authSessions, []);
  const auth = await f.login();
  assert.match(auth.setCookie, /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  const token = auth.cookie.split('=')[1];
  assert.equal(token.split('.').length, 3);
  const stored = await f.read();
  assert.equal(stored.authSessions.length, 1);
  const key = await fs.readFile(path.join(f.dataDir, SIGNING_KEY_FILENAME));
  const claims = verifyJwt(token, key);
  assert.equal(stored.authSessions[0].idHash, sessionIdHash(claims.jti));
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal(JSON.stringify(stored).includes(claims.jti), false);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth })).data, { user: auth.user, csrfToken: auth.csrfToken });
  assert.equal((await f.request('/api/admin/members', { method: 'POST', auth, body: { version: 7, name: '持续登录新增' } })).status, 201);
  for (const route of ['/api/state', '/api/content', '/api/admin/accounts', '/api/admin/logs']) {
    const result = await f.request(route, { auth });
    assert.equal(result.status, 200);
    const text = JSON.stringify(result.data);
    for (const secret of [token, claims.jti, auth.csrfToken, key.toString('base64url'), 'authSessions', 'idHash', 'csrfToken']) assert.equal(text.includes(secret), false, `${route} ${secret}`);
  }
  assert.deepEqual((await f.read()).accounts, before.accounts);
});

test('logout and account updates or deletion remain revoked after restart; wrong-CSRF logout does not revoke', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  assert.equal((await f.request('/api/logout', { method: 'POST', auth: admin, headers: { 'X-CSRF-Token': 'wrong' }, body: {} })).status, 403);
  assert.equal((await f.request('/api/session', { auth: admin })).data.user.id, admin.user.id);
  assert.equal((await f.request('/api/logout', { method: 'POST', auth: admin, body: {} })).status, 200);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: admin })).data, { user: null });
  const fresh = await f.login();
  const created = await f.request('/api/admin/accounts', { method: 'POST', auth: fresh, body: { username: 'editor-one', role: 'editor', password: 'editor-secret-test' } });
  const target = created.data.accounts.find(account => account.username === 'editor-one');
  const oldEditor = await f.login('editor-one', 'editor-secret-test');
  assert.equal((await f.request(`/api/admin/accounts/${target.id}`, { method: 'PATCH', auth: fresh, body: { username: 'editor-two', role: 'admin' } })).status, 200);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: oldEditor })).data, { user: null });
  const newEditor = await f.login('editor-two', 'editor-secret-test');
  assert.equal((await f.request(`/api/admin/accounts/${target.id}`, { method: 'DELETE', auth: fresh, body: {} })).status, 200);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: newEditor })).data, { user: null });
  assert.equal((await f.read()).authSessions.some(session => session.accountId === target.id), false);
});

test('failed login or logout persistence does not issue or revoke sessions, including after restart', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  const before = await f.read();
  const filename = path.join(f.dataDir, 'state.json');
  const saved = path.join(f.dataDir, 'state.saved');
  await fs.rename(filename, saved);
  await fs.mkdir(filename);
  try {
    const rejected = await f.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'test-only-admin-password' } });
    assert.equal(rejected.status, 500);
    assert.equal(rejected.headers.has('set-cookie'), false);
    const failedLogout = await f.request('/api/logout', { method: 'POST', auth: admin, body: {} });
    assert.equal(failedLogout.status, 500);
    assert.equal(failedLogout.headers.has('set-cookie'), false);
    assert.deepEqual((await f.request('/api/session', { auth: admin })).data.user, admin.user);
  } finally {
    await fs.rmdir(filename);
    await fs.rename(saved, filename);
  }
  assert.deepEqual(await f.read(), before);
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: admin })).data.user, admin.user);
});

test('different DATA_DIR keys isolate JWTs even with a copied registry, and re-login replaces its prior cookie', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const auth = await first.login();
  await second.restart(async state => { state.authSessions = (await first.read()).authSessions; });
  assert.deepEqual((await second.request('/api/session', { auth })).data, { user: null });
  assert.deepEqual((await first.request('/api/session', { auth: { cookie: 'dinner_session=old-opaque-cookie' } })).data, { user: null });
  const replacement = await first.login('admin', 'test-only-admin-password', auth);
  assert.deepEqual((await first.request('/api/session', { auth })).data, { user: null });
  await first.restart();
  assert.deepEqual((await first.request('/api/session', { auth })).data, { user: null });
  assert.deepEqual((await first.request('/api/session', { auth: replacement })).data.user, replacement.user);
});

test('eleventh login revokes the oldest session durably and expired sessions are removed on restart', async t => {
  const f = await fixture(t);
  const sessions = [];
  for (let i = 0; i < 11; i++) sessions.push(await f.login());
  assert.equal((await f.read()).authSessions.length, 10);
  assert.deepEqual((await f.request('/api/session', { auth: sessions[0] })).data, { user: null });
  await f.restart();
  assert.deepEqual((await f.request('/api/session', { auth: sessions[0] })).data, { user: null });
  assert.equal((await f.request('/api/session', { auth: sessions.at(-1) })).data.user.id, sessions.at(-1).user.id);
  await f.restart(state => {
    for (const session of state.authSessions) {
      session.issuedAt = 1;
      session.expiresAt = 1 + SESSION_TTL_SECONDS;
    }
  });
  assert.deepEqual((await f.read()).authSessions, []);
  assert.deepEqual((await f.request('/api/session', { auth: sessions.at(-1) })).data, { user: null });
});
