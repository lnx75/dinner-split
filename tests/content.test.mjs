import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';
import { CONTENT_TEXT_FIELDS, DEFAULT_CONTENT } from '../public/content.js';

// A complete 2×2 RGBA PNG with valid chunks, CRCs and compressed scanlines.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiKKKK9g8s/9k=', 'base64');
const WEBP = Buffer.from('UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoCAAIAAUAmJZACdLoAA5gA/vSIh/VcnYnxw/ubHOLZDAAA', 'base64');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-content-test-'));
  const dataDir = path.join(temporary, 'data');
  const publicDir = path.join(temporary, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>fixture</title>');
  await fs.mkdir(dataDir);
  const salt = 'page-content-fixture';
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1, ledgerSchemaVersion: 2,
    members: ['lin', 'yu', 'jie', 'ke'].map((id, order) => ({ id, name: id, note: '', color: '#C9683F', order })),
    expenses: [{ id: 'dinner', title: '餐费', note: '', icon: 'dinner', amountCents: 36000, participantIds: ['lin', 'yu', 'jie', 'ke'] }],
    accounts: [{ id: randomUUID(), username: 'admin', role: 'admin', salt, hash: scryptSync('test-only-admin-password', salt, 64).toString('hex') }],
  }));
  let server, base;
  async function start() {
    server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, publicDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const request = async (route, { method = 'GET', body, bytes, auth, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(!['GET', 'HEAD'].includes(method) ? { Origin: base, 'Content-Type': bytes ? 'image/png' : 'application/json' } : {}),
        ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken } : {}),
        ...headers,
      },
      body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const raw = Buffer.from(await response.arrayBuffer());
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { data = raw; }
    return { response, data, raw };
  };
  const login = async (username = 'admin', password = 'test-only-admin-password') => {
    const { response, data } = await request('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200, data.message);
    return { ...data, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const restart = async update => {
    await new Promise(resolve => server.close(resolve));
    if (update) {
      const statePath = path.join(dataDir, 'state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      await update(state);
      await fs.writeFile(statePath, JSON.stringify(state));
    }
    await start();
  };
  return { request, login, restart, dataDir, publicDir, get server() { return server; }, get base() { return base; } };
}

test('page content is public, while only administrators with CSRF may edit or upload', async t => {
  const { request, login } = await fixture(t);
  const content = (await request('/api/content')).data;
  assert.deepEqual(content, DEFAULT_CONTENT);
  assert.equal(Object.keys(content.texts).length, CONTENT_TEXT_FIELDS.length);
  assert.equal('content' in (await request('/api/state')).data, false);
  const patch = { version: 1, texts: { brandName: '小聚' } };
  assert.equal((await request('/api/admin/content', { method: 'PATCH', body: patch })).response.status, 401);
  assert.equal((await request('/api/admin/images', { method: 'POST', bytes: PNG })).response.status, 401);
  const admin = await login();
  assert.equal((await request('/api/admin/content', { method: 'PATCH', auth: admin, body: patch, headers: { 'X-CSRF-Token': 'wrong' } })).response.status, 403);
  assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes: PNG, headers: { Origin: 'https://elsewhere.example' } })).response.status, 403);
  await request('/api/admin/accounts', { method: 'POST', auth: admin, body: { username: 'editor1', password: 'example-editor-password', role: 'editor' } });
  const editor = await login('editor1', 'example-editor-password');
  assert.equal((await request('/api/admin/content', { method: 'PATCH', auth: editor, body: patch })).response.status, 403);
  assert.equal((await request('/api/admin/images', { method: 'POST', auth: editor, bytes: PNG })).response.status, 403);
  assert.equal((await request('/api/content', { auth: editor })).response.status, 200);
});

test('content saves merge safely, reject unknown keys and keep independent ledger versions', async t => {
  const { request, login } = await fixture(t);
  const admin = await login();
  const [page, ledger] = await Promise.all([
    request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: 1, texts: { brandName: '  小聚  ', loginDescription: '第一行\n第二行' }, images: { sidebar: { fit: 'cover', position: 'top' } } } }),
    request('/api/expenses/dinner', { method: 'PATCH', auth: admin, body: { version: 1, amountCents: 36001, participantIds: ['lin', 'yu', 'jie', 'ke'] } }),
  ]);
  assert.equal(page.response.status, 200, page.data.message);
  assert.equal(ledger.response.status, 200, ledger.data.message);
  assert.equal(page.data.version, 2);
  assert.equal(page.data.texts.brandName, '小聚');
  assert.equal(page.data.texts.loginDescription, '第一行\n第二行');
  assert.equal(page.data.images.sidebar.src, DEFAULT_CONTENT.images.sidebar.src);
  assert.equal(page.data.images.sidebar.fit, 'cover');
  assert.equal(ledger.data.version, 2);
  assert.equal((await request('/api/content')).data.version, 2);

  const conflict = await request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: 1, texts: { brandName: '过期修改' } } });
  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.data.content, page.data);
  assert.equal('state' in conflict.data, false);
  const concurrent = await Promise.all([
    request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: 2, texts: { brandName: '一起吃' } } }),
    request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: 2, texts: { brandName: '吃一桌' } } }),
  ]);
  assert.deepEqual(concurrent.map(result => result.response.status).sort(), [200, 409]);
  assert.equal((await request('/api/state')).data.version, 2);

  const invalid = [
    { unknown: true }, { texts: { nonexistent: '文字' } }, { texts: [] }, { texts: { brandName: '' } },
    { texts: { brandName: 'x'.repeat(31) } }, { texts: { brandName: 'a\nb' } }, { texts: { brandName: 'a\u0000b' } },
    { texts: { brandName: { html: 'x' } } }, { images: { unknown: {} } }, { images: { sidebar: { fit: 'stretch' } } },
    { images: { sidebar: { position: 'left' } } }, { images: { sidebar: { src: '' } } },
    { images: { sidebar: { src: 'https://elsewhere.example/image.png' } } },
    { images: { sidebar: { src: 'data:image/svg+xml,<svg/>' } } },
    { images: { brand: { src: '/media/12345678-1234-4123-8123-123456789012.png' } } },
    { images: { sidebar: { unknown: 'x' } } },
  ];
  for (const fields of invalid) {
    const result = await request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: 3, ...fields } });
    assert.equal(result.response.status, 422, JSON.stringify(fields));
  }
  const reset = await request('/api/admin/content', { method: 'PATCH', auth: admin, body: { version: 3, images: { brand: { src: '', alt: '' } } } });
  assert.equal(reset.response.status, 200);
  assert.equal((await request('/api/state')).data.expenses[0].amountCents, 36001);
});

test('migration adds page defaults and preserves old money, members, accounts and passwords', async t => {
  const { request, login, restart, dataDir } = await fixture(t);
  const original = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  await restart(state => {
    delete state.content;
    state.version = 37;
    state.members[0].name = '老朋友';
    state.expenses[0].amountCents = 45678;
  });
  const ledger = (await request('/api/state')).data;
  assert.equal(ledger.version, 37);
  assert.equal(ledger.members[0].name, '老朋友');
  assert.equal(ledger.expenses[0].amountCents, 45678);
  assert.deepEqual((await request('/api/content')).data, DEFAULT_CONTENT);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.accounts, original.accounts);
  assert.equal((await login()).user.role, 'admin');
  await restart(state => { state.content = { version: 8, texts: { brandName: '已有品牌' } }; });
  const upgraded = (await request('/api/content')).data;
  assert.equal(upgraded.version, 8);
  assert.equal(upgraded.texts.brandName, '已有品牌');
  assert.equal(upgraded.texts.expensesHeading, DEFAULT_CONTENT.texts.expensesHeading);
  assert.equal((await request('/api/state')).data.version, 37);
});

test('uploaded images and content survive restart; media is typed and cannot escape private storage', async t => {
  const { request, login, restart, dataDir } = await fixture(t);
  const admin = await login();
  const upload = await request('/api/admin/images', { method: 'POST', auth: admin, bytes: PNG });
  assert.equal(upload.response.status, 201, upload.data.message);
  assert.match(upload.data.url, /^\/media\/[a-f0-9-]{36}\.png$/);
  assert.equal(upload.data.mimeType, 'image/png');
  const patch = await request('/api/admin/content', { method: 'PATCH', auth: admin, body: {
    version: 1, texts: { brandName: '重启仍保留' }, images: { sidebar: { src: upload.data.url, alt: '新插画', fit: 'contain', position: 'bottom' } },
  } });
  assert.equal(patch.response.status, 200, patch.data.message);
  assert.equal((await request('/api/state')).data.version, 1);
  const image = await request(upload.data.url);
  assert.equal(image.response.status, 200);
  assert.equal(image.response.headers.get('content-type'), 'image/png');
  assert.equal(image.response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(image.raw, PNG);
  const head = await request(upload.data.url, { method: 'HEAD' });
  assert.equal(head.response.status, 200);
  assert.equal(Number(head.response.headers.get('content-length')), PNG.length);
  assert.equal(head.raw.length, 0);
  const escapedName = '11111111-1111-4111-8111-111111111111.png';
  await fs.symlink(path.join(dataDir, 'state.json'), path.join(dataDir, 'uploads', escapedName));
  for (const route of ['/media/' + escapedName, '/media/%2e%2e%2fstate.json', '/media/.hidden.png', '/media/state.json', '/data/uploads/' + path.basename(upload.data.url)]) {
    assert.equal((await request(route)).response.status, 404, route);
  }
  await restart();
  assert.deepEqual((await request('/api/content')).data, patch.data);
  assert.deepEqual((await request(upload.data.url)).raw, PNG);
  assert.equal((await login()).user.role, 'admin');
});

test('image upload rejects unsupported, spoofed, truncated, corrupt and oversized data', async t => {
  const { request, login, dataDir } = await fixture(t);
  const admin = await login();
  for (const mime of ['image/svg+xml', 'text/html', 'application/octet-stream', 'image/gif']) {
    assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes: PNG, headers: { 'Content-Type': mime } })).response.status, 415);
  }
  const corrupt = Buffer.from(PNG);
  corrupt[45] ^= 1;
  for (const bytes of [PNG.subarray(0, 33), corrupt, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
    assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes })).response.status, 422);
  }
  assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes: PNG, headers: { 'Content-Type': 'image/jpeg' } })).response.status, 422);
  assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).response.status, 413);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads')), []);
});

test('complete JPEG and WebP uploads retain their bytes and MIME types', async t => {
  const { request, login } = await fixture(t);
  const admin = await login();
  for (const [bytes, mimeType, extension] of [[JPEG, 'image/jpeg', 'jpg'], [WEBP, 'image/webp', 'webp']]) {
    const upload = await request('/api/admin/images', { method: 'POST', auth: admin, bytes, headers: { 'Content-Type': mimeType } });
    assert.equal(upload.response.status, 201, upload.data.message);
    assert.equal(upload.data.mimeType, mimeType);
    assert.ok(upload.data.url.endsWith('.' + extension));
    const served = await request(upload.data.url);
    assert.equal(served.response.headers.get('content-type'), mimeType);
    assert.deepEqual(served.raw, bytes);
    assert.equal((await request('/api/admin/images', { method: 'POST', auth: admin, bytes: bytes.subarray(0, bytes.length - 3), headers: { 'Content-Type': mimeType } })).response.status, 422);
  }
});

test('logging out during a slow image upload prevents file creation', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const observe = incoming => { if (incoming.headers['x-test-upload'] === 'delayed-image') markStarted(); };
  f.server.on('request', observe);
  const upload = http.request(new URL('/api/admin/images', f.base), {
    method: 'POST', headers: { Origin: f.base, 'Content-Type': 'image/png', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken, 'X-Test-Upload': 'delayed-image' },
  });
  const finished = new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
  });
  upload.write(PNG.subarray(0, 16));
  await started;
  f.server.off('request', observe);
  assert.equal((await f.request('/api/logout', { method: 'POST', auth: admin })).response.status, 200);
  upload.end(PNG.subarray(16));
  assert.equal(await finished, 401);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'uploads')), []);
});
