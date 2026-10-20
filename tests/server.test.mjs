import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';
import { calculateLedger } from '../public/split.js';

// Explicit test data; the application itself starts with an empty ledger.
const DEMO_MEMBERS = [
  { id: 'lin', name: '小林', note: '一起吃饭 · 乘车', color: '#C9683F', order: 0 },
  { id: 'yu', name: '小雨', note: '一起吃饭', color: '#50837A', order: 1 },
  { id: 'jie', name: '阿杰', note: '不喝酒 · 乘车', color: '#6883A1', order: 2 },
  { id: 'ke', name: '可可', note: '一起吃饭', color: '#A2789F', order: 3 },
];
const DEMO_EXPENSES = [
  { id: 'dinner', title: '餐费', note: '四人一起享用的晚餐', icon: 'dinner', amountCents: 36000, participantIds: ['lin', 'yu', 'jie', 'ke'] },
  { id: 'drinks', title: '酒水', note: '三人分摊，阿杰不喝酒', icon: 'wine', amountCents: 12000, participantIds: ['lin', 'yu', 'ke'] },
  { id: 'parking', title: '停车费', note: '由小林和阿杰两位乘车人分摊', icon: 'car', amountCents: 2000, participantIds: ['lin', 'jie'] },
];
const accountSalt = 'fixture-account-salt';
const accountHash = scryptSync('test-only-admin-password', accountSalt, 64).toString('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC', 'base64');

async function fixture(t, { demo = true } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-split-test-'));
  const publicDir = path.join(temporary, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>fixture</title>');
  const dataDir = path.join(temporary, 'private');
  if (demo) {
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 1, ledgerSchemaVersion: 2,
      members: DEMO_MEMBERS, expenses: DEMO_EXPENSES,
      accounts: [{ id: randomUUID(), username: 'admin', role: 'admin', salt: accountSalt, hash: accountHash }],
    }));
  }
  let server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, publicDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const request = async (route, { method = 'GET', body, bytes, auth, origin = base, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(method !== 'GET' ? { Origin: origin, 'Content-Type': bytes ? 'image/png' : 'application/json' } : {}),
        ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken } : {}),
        ...headers,
      },
      body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  };
  const login = async (username = 'admin', password = 'test-only-admin-password') => {
    const { response, data } = await request('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200, data.message);
    return { ...data, cookie: response.headers.get('set-cookie').split(';')[0], setCookie: response.headers.get('set-cookie') };
  };
  const restart = async update => {
    await new Promise(resolve => server.close(resolve));
    if (update) {
      const statePath = path.join(dataDir, 'state.json');
      const stored = JSON.parse(await fs.readFile(statePath, 'utf8'));
      await update(stored);
      await fs.writeFile(statePath, JSON.stringify(stored));
    }
    server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, publicDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  return { request, login, restart, dataDir, publicDir, temporary, get server() { return server; }, get base() { return base; } };
}

test('public view, authentication, CSRF, concurrency, persistence and admin boundaries', async t => {
  const { request, login, dataDir, publicDir, temporary } = await fixture(t);
  let state = (await request('/api/state')).data;
  assert.equal(state.version, 1);
  assert.equal(state.expenses.reduce((sum, item) => sum + item.amountCents, 0), 50000);
  assert.equal(JSON.stringify(state).includes('accounts'), false);
  assert.equal(JSON.stringify(state).includes('test-only'), false);
  assert.deepEqual((await request('/api/session')).data, { user: null });

  const patch = { amountCents: 36001, participantIds: ['lin', 'yu', 'jie', 'ke'], version: state.version };
  assert.equal((await request('/api/expenses/dinner', { method: 'PATCH', body: patch })).response.status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).response.status, 401);
  assert.equal((await request('/api/login', { method: 'POST', origin: 'https://untrusted.example', body: { username: 'admin', password: 'test-only-admin-password' } })).response.status, 403);
  const admin = await login();
  assert.equal(admin.user.role, 'admin');
  assert.match(admin.setCookie, /HttpOnly/);
  assert.match(admin.setCookie, /SameSite=Strict/);
  assert.equal((await request('/api/session', { auth: admin })).data.csrfToken, admin.csrfToken);
  assert.equal((await request('/api/expenses/dinner', { method: 'PATCH', body: patch, auth: admin, headers: { 'X-CSRF-Token': 'wrong' } })).response.status, 403);
  assert.equal((await request('/api/expenses/dinner', { method: 'PATCH', body: patch, auth: admin, origin: 'http://evil.example' })).response.status, 403);

  // Two browser tabs editing the same version cannot overwrite each other silently.
  const concurrent = await Promise.all([
    request('/api/expenses/dinner', { method: 'PATCH', body: patch, auth: admin }),
    request('/api/expenses/dinner', { method: 'PATCH', body: { ...patch, amountCents: 36002 }, auth: admin }),
  ]);
  assert.deepEqual(concurrent.map(result => result.response.status).sort(), [200, 409]);
  state = concurrent.find(result => result.response.status === 200).data;
  const conflict = concurrent.find(result => result.response.status === 409).data;
  assert.equal(conflict.state.version, state.version);
  assert.equal(state.version, 2);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(stored.expenses[0].amountCents, state.expenses[0].amountCents);
  assert.equal(stored.accounts.length, 1);
  assert.equal('password' in stored.accounts[0], false);
  assert.equal(JSON.stringify(stored).includes('test-only-admin-password'), false);
  assert.equal(stored.accounts[0].hash.length, 128);

  assert.equal((await request('/api/expenses/dinner', { method: 'PATCH', body: { ...patch, version: state.version, participantIds: [] }, auth: admin })).response.status, 422);
  assert.equal((await request('/api/expenses/dinner', { method: 'PATCH', body: { ...patch, version: state.version, amountCents: 1.5 }, auth: admin })).response.status, 422);
  assert.equal((await request('/api/expenses/dinner', { method: 'PATCH', body: { ...patch, version: state.version, participantIds: ['lin', 'fake'] }, auth: admin })).response.status, 422);

  const created = await request('/api/admin/accounts', { method: 'POST', auth: admin, body: { username: 'editor1', password: 'editor-pass-123', role: 'editor' } });
  assert.equal(created.response.status, 201);
  const editorAccount = created.data.accounts.find(account => account.username === 'editor1');
  assert.deepEqual(Object.keys(editorAccount).sort(), ['id', 'role', 'username']);
  const editor = await login('editor1', 'editor-pass-123');
  assert.equal((await request('/api/admin/accounts', { auth: editor })).response.status, 403);
  assert.equal((await request('/api/admin/members/lin', { method: 'DELETE', auth: editor, body: { version: state.version } })).response.status, 403);
  const editorPatch = await request('/api/expenses/drinks', { method: 'PATCH', auth: editor, body: { amountCents: 12001, participantIds: ['lin', 'ke'], version: state.version } });
  assert.equal(editorPatch.response.status, 200);
  state = editorPatch.data;

  const newMember = await request('/api/admin/members', { method: 'POST', auth: admin, body: { name: '新朋友', note: '测试', color: '#123456', version: state.version } });
  assert.equal(newMember.response.status, 201);
  state = newMember.data;
  const newId = state.members.at(-1).id;
  assert.equal(state.members.at(-1).order, 4);
  const editedMember = await request(`/api/admin/members/${newId}`, { method: 'PATCH', auth: admin, body: { name: '朋友', version: state.version } });
  assert.equal(editedMember.response.status, 200);
  state = editedMember.data;
  assert.equal(state.members.at(-1).name, '朋友');
  const deletedMember = await request(`/api/admin/members/${newId}`, { method: 'DELETE', auth: admin, body: { version: state.version } });
  assert.equal(deletedMember.response.status, 200);
  state = deletedMember.data;
  assert.equal(state.members.length, 4);

  // Deleting an account also invalidates an already issued session.
  assert.equal((await request(`/api/admin/accounts/${editorAccount.id}`, { method: 'DELETE', auth: admin })).response.status, 200);
  assert.deepEqual((await request('/api/session', { auth: editor })).data, { user: null });
  assert.equal((await request('/api/expenses/drinks', { method: 'PATCH', auth: editor, body: { amountCents: 0, participantIds: [], version: state.version } })).response.status, 401);
  assert.equal((await request(`/api/admin/accounts/${admin.user.id}`, { method: 'DELETE', auth: admin })).response.status, 422);
  assert.equal((await request('/api/register', { method: 'POST', body: {} })).response.status, 404);

  // Neither private files, source files, dotfiles nor symlink escapes are served.
  await fs.writeFile(path.join(temporary, 'secret.txt'), 'private-secret');
  await fs.symlink(path.join(temporary, 'secret.txt'), path.join(publicDir, 'escaped.txt'));
  for (const route of ['/data/state.json', '/server.mjs', '/.env', '/%2e%2e/server.mjs', '/escaped.txt']) {
    assert.equal((await request(route)).response.status, 404, route);
  }
  const root = await request('/');
  assert.equal(root.response.status, 200);
  assert.match(root.response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await request('/api/logout', { method: 'POST', auth: admin })).response.status, 200);
  assert.deepEqual((await request('/api/session', { auth: admin })).data, { user: null });
});

test('login rate limit blocks guessing after ten failed attempts', async t => {
  const { request } = await fixture(t);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: `wrong-${i}` } })).response.status, 401);
  }
  const blocked = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'test-only-admin-password' } });
  assert.equal(blocked.response.status, 429);
  assert.ok(Number(blocked.response.headers.get('retry-after')) > 0);
});

test('logging out while a request body is arriving prevents its delayed mutation', async t => {
  const { request, login, server, base } = await fixture(t);
  const admin = await login();
  let uploadStarted;
  const started = new Promise(resolve => { uploadStarted = resolve; });
  const observe = incoming => {
    if (incoming.headers['x-test-upload'] === 'delayed') uploadStarted();
  };
  server.on('request', observe);
  const upload = http.request(new URL('/api/expenses/dinner', base), {
    method: 'PATCH',
    headers: {
      Origin: base, 'Content-Type': 'application/json', Cookie: admin.cookie,
      'X-CSRF-Token': admin.csrfToken, 'X-Test-Upload': 'delayed',
    },
  });
  const finished = new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('response', response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
  });
  upload.write('{"amountCents":');
  await started;
  server.off('request', observe);
  assert.equal((await request('/api/logout', { method: 'POST', auth: admin })).response.status, 200);
  upload.end('99999,"participantIds":["lin"],"version":1}');
  assert.equal(await finished, 401);
  assert.equal((await request('/api/state')).data.expenses[0].amountCents, 36000);
});

test('a fresh server instance reloads saved data and hashed accounts', async t => {
  const { request, login, dataDir, publicDir } = await fixture(t);
  const admin = await login();
  const updated = await request('/api/expenses/parking', {
    method: 'PATCH', auth: admin,
    body: { amountCents: 2001, participantIds: ['lin', 'jie'], version: 1 },
  });
  assert.equal(updated.response.status, 200);
  const second = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, publicDir });
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => second.close(resolve)));
  const base = `http://127.0.0.1:${second.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.version, 2);
  assert.equal(state.expenses.find(expense => expense.id === 'parking').amountCents, 2001);
  const response = await fetch(base + '/api/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-only-admin-password' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, 'admin');
});

test('fresh projects have an empty ledger and retain the default administrator', async t => {
  const { request, login } = await fixture(t, { demo: false });
  const state = (await request('/api/state')).data;
  assert.equal(state.version, 1);
  assert.deepEqual(state.members, []);
  assert.deepEqual(state.expenses, []);
  assert.equal(calculateLedger(state).balanced, true);
  assert.equal(calculateLedger(state).totalCents, 0);
  assert.equal((await login()).user.role, 'admin');
});

test('custom expense CRUD respects permissions, versions, validation and exact cent allocation', async t => {
  const { request, login } = await fixture(t, { demo: false });
  const newExpense = { version: 1, title: '包间服务费', amountCents: 0, participantIds: [] };
  assert.equal((await request('/api/admin/expenses', { method: 'POST', body: newExpense })).response.status, 401);
  const admin = await login();
  assert.equal((await request('/api/admin/expenses', { method: 'POST', auth: admin, body: newExpense, headers: { 'X-CSRF-Token': 'invalid' } })).response.status, 403);
  await request('/api/admin/accounts', { method: 'POST', auth: admin, body: { username: 'editor1', password: 'editor-pass-123', role: 'editor' } });
  const editor = await login('editor1', 'editor-pass-123');
  assert.equal((await request('/api/admin/expenses', { method: 'POST', auth: editor, body: newExpense, headers: { 'X-CSRF-Token': 'invalid' } })).response.status, 403);
  for (const fields of [
    { title: '' }, { title: 'x'.repeat(41) }, { title: 'a\nb' }, { title: 'a\u0000b' },
    { amountCents: 1, participantIds: [] }, { amountCents: 1.5 }, { amountCents: 100_000_001 },
    { participantIds: ['missing'] }, { title: '费用', unexpected: true },
  ]) {
    assert.equal((await request('/api/admin/expenses', { method: 'POST', auth: admin, body: { ...newExpense, ...fields } })).response.status, 422, JSON.stringify(fields));
  }
  let created = await request('/api/admin/expenses', { method: 'POST', auth: editor, body: { version: 1, title: '  包间服务费  ' } });
  assert.equal(created.response.status, 201, created.data.message);
  let state = created.data;
  const feeId = state.expenses[0].id;
  assert.match(feeId, /^[a-f0-9-]{36}$/);
  assert.equal(state.expenses[0].title, '包间服务费');
  assert.equal(state.expenses[0].amountCents, 0);
  assert.deepEqual(state.expenses[0].participantIds, []);
  for (const name of ['甲', '乙', '丙']) {
    created = await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: state.version, name } });
    assert.equal(created.response.status, 201);
    state = created.data;
  }
  const ids = state.members.map(member => member.id);
  assert.equal((await request('/api/expenses/' + feeId, { method: 'PATCH', auth: editor, body: { version: state.version, amountCents: 10001, participantIds: [ids[0], ids[0]] } })).response.status, 422);
  const changed = await request('/api/expenses/' + feeId, { method: 'PATCH', auth: editor, body: { version: state.version, amountCents: 10001, participantIds: ids } });
  assert.equal(changed.response.status, 200);
  state = changed.data;
  const ledger = calculateLedger(state);
  assert.deepEqual(ledger.people.map(person => person.totalCents), [3334, 3334, 3333]);
  assert.equal(ledger.allocatedCents, 10001);
  assert.equal(ledger.balanced, true);
  const renamed = await request('/api/admin/expenses/' + feeId, { method: 'PATCH', auth: editor, body: { version: state.version, title: '编辑者修改费用名' } });
  assert.equal(renamed.response.status, 200);
  state = renamed.data;
  assert.equal((await request('/api/admin/expenses/' + feeId, { method: 'DELETE', auth: editor, body: { version: state.version } })).response.status, 403);
  const concurrent = await Promise.all([
    request('/api/admin/expenses/' + feeId, { method: 'PATCH', auth: admin, body: { version: state.version, title: '餐厅服务费' } }),
    request('/api/admin/expenses/' + feeId, { method: 'PATCH', auth: admin, body: { version: state.version, title: '聚会服务费' } }),
  ]);
  assert.deepEqual(concurrent.map(result => result.response.status).sort(), [200, 409]);
  state = concurrent.find(result => result.response.status === 200).data;
  assert.equal(calculateLedger(state).allocatedCents, 10001);
  assert.equal((await request('/api/admin/expenses/' + feeId, { method: 'DELETE', auth: admin, body: { version: state.version - 1 } })).response.status, 409);
  const deleted = await request('/api/admin/expenses/' + feeId, { method: 'DELETE', auth: admin, body: { version: state.version } });
  assert.equal(deleted.response.status, 200);
  state = deleted.data;
  assert.deepEqual(state.expenses, []);
  for (const id of ids) {
    const deletedMember = await request('/api/admin/members/' + id, { method: 'DELETE', auth: admin, body: { version: state.version } });
    assert.equal(deletedMember.response.status, 200);
    state = deletedMember.data;
  }
  assert.deepEqual(state.members, []);
  assert.equal(calculateLedger(state).balanced, true);
});

test('member avatars use existing local uploads and persist without disappearing on name edits', async t => {
  const { request, login, restart, dataDir } = await fixture(t, { demo: false });
  const admin = await login();
  const invalidAvatars = ['https://elsewhere.example/avatar.png', 'data:image/png;base64,abc', '/assets/shared-table.svg', '/media/../state.json', '/media/11111111-1111-4111-8111-111111111111.png', null];
  for (const avatarUrl of invalidAvatars) {
    assert.equal((await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: '朋友', avatarUrl } })).response.status, 422);
  }
  const upload = await request('/api/admin/images', { method: 'POST', auth: admin, bytes: PNG });
  assert.equal(upload.response.status, 201);
  const create = await request('/api/admin/members', { method: 'POST', auth: admin, body: { version: 1, name: '朋友', avatarUrl: upload.data.url } });
  assert.equal(create.response.status, 201, create.data.message);
  const person = create.data.members[0];
  assert.equal(person.avatarUrl, upload.data.url);
  const rename = await request('/api/admin/members/' + person.id, { method: 'PATCH', auth: admin, body: { version: 2, name: '老朋友' } });
  assert.equal(rename.response.status, 200);
  assert.equal(rename.data.members[0].avatarUrl, upload.data.url);
  const escapedName = '11111111-1111-4111-8111-111111111111.png';
  await fs.symlink(path.join(dataDir, 'state.json'), path.join(dataDir, 'uploads', escapedName));
  for (const avatarUrl of invalidAvatars) {
    assert.equal((await request('/api/admin/members/' + person.id, { method: 'PATCH', auth: admin, body: { version: 3, avatarUrl } })).response.status, 422);
  }
  await restart();
  assert.equal((await request('/api/state')).data.members[0].avatarUrl, upload.data.url);
  const newAdmin = await login();
  const removed = await request('/api/admin/members/' + person.id, { method: 'PATCH', auth: newAdmin, body: { version: 3, avatarUrl: '' } });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.data.members[0].avatarUrl, '');
});

test('legacy untouched sample is backed up and cleared once; customized data and accounts are preserved', async t => {
  const { request, login, restart, dataDir } = await fixture(t);
  const initial = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  let legacyBytes;
  await restart(state => {
    delete state.ledgerSchemaVersion;
    state.members.forEach(member => { delete member.avatarUrl; });
    state.extraUserSetting = { retained: true };
    state.content.texts.brandName = '保留品牌';
    legacyBytes = JSON.stringify(state);
  });
  const empty = (await request('/api/state')).data;
  assert.equal(empty.version, 2);
  assert.deepEqual(empty.members, []);
  assert.deepEqual(empty.expenses, []);
  const backups = (await fs.readdir(dataDir)).filter(name => name.startsWith('state.before-empty-ledger-v2-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(dataDir, backups[0]), 'utf8'), legacyBytes);
  assert.equal((await request('/api/content')).data.texts.brandName, '保留品牌');
  let saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.accounts, initial.accounts);
  assert.deepEqual(saved.extraUserSetting, { retained: true });
  assert.equal((await login()).user.role, 'admin');
  await restart();
  assert.equal((await request('/api/state')).data.version, 2);
  assert.equal((await fs.readdir(dataDir)).filter(name => name.startsWith('state.before-empty-ledger-v2-')).length, 1);
  for (const customize of [
    state => { state.expenses[0].amountCents += 1; },
    state => { state.members[0].name = '真实朋友'; },
    state => { state.expenses.push({ id: 'custom', title: '甜点', note: '', icon: 'dinner', amountCents: 0, participantIds: [] }); },
  ]) {
    await restart(state => {
      delete state.ledgerSchemaVersion;
      state.version = 37;
      state.members = structuredClone(DEMO_MEMBERS);
      state.expenses = structuredClone(DEMO_EXPENSES);
      customize(state);
    });
    const retained = (await request('/api/state')).data;
    assert.equal(retained.version, 37);
    assert.equal(retained.members.length, 4);
    assert.equal(retained.members.every(member => member.avatarUrl === ''), true);
    saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
    assert.deepEqual(saved.accounts, initial.accounts);
    assert.equal(saved.content.texts.brandName, '保留品牌');
    assert.equal((await fs.readdir(dataDir)).filter(name => name.startsWith('state.before-empty-ledger-v2-')).length, 1);
  }
});
