import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';

const salt = 'proxy-test-account';
const hash = scryptSync('test-only-admin-password', salt, 64).toString('hex');
const credentials = { username: 'admin', password: 'test-only-admin-password' };

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-proxy-'));
  const dataDir = path.join(temporary, 'private');
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1, ledgerSchemaVersion: 2, members: [], expenses: [],
    accounts: [{ id: 'proxy-admin', username: 'admin', role: 'admin', salt, hash }],
  }));
  const server = await createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route = '/api/login', { headers = {}, body = credentials, method = 'POST' } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers,
        data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(body));
  });
  return { request, base };
}

test('explicit HTTPS origin supports a loopback reverse proxy and issues Secure session cookies', async t => {
  const origin = 'https://split.example';
  const { request } = await fixture(t, { publicOrigin: origin });
  const headers = { Host: 'split.example', Origin: origin };
  const login = await request('/api/login', { headers });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /; Secure(?:;|$)/);
  assert.match(login.headers['set-cookie'][0], /; HttpOnly;/);
  const authHeaders = {
    ...headers, Cookie: login.headers['set-cookie'][0].split(';')[0],
    'X-CSRF-Token': login.data.csrfToken,
  };
  const member = await request('/api/admin/members', {
    headers: authHeaders, body: { version: 1, name: '部署测试' },
  });
  assert.equal(member.status, 201);
  assert.equal(member.data.members[0].name, '部署测试');
  const logout = await request('/api/logout', { headers: authHeaders, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /; Max-Age=0; Secure$/);
});

test('configured origins require the exact Origin and Host and never trust forwarding headers', async t => {
  const origin = 'https://split.example';
  const { request } = await fixture(t, { publicOrigin: origin });
  for (const headers of [
    { Host: 'split.example' },
    { Host: 'split.example', Origin: 'http://split.example' },
    { Host: 'split.example', Origin: 'https://evil.example' },
    { Host: 'split.example', Origin: `${origin}/` },
    { Host: 'split.example', Origin: `${origin}?query=1` },
    { Host: '127.0.0.1', Origin: origin },
    { Host: 'split.example:444', Origin: origin },
    { Host: 'split.example', Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'split.example', Origin: 'http://split.example', 'X-Forwarded-Proto': 'https' },
    { Host: 'wrong.example', Origin: origin, 'X-Forwarded-Host': 'split.example', 'X-Forwarded-Proto': 'https' },
  ]) {
    const result = await request('/api/login', { headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(result.data.error, 'origin_rejected');
  }
  // The explicit origin is authoritative even when an untrusted header disagrees.
  const accepted = await request('/api/login', {
    headers: { Host: 'split.example', Origin: origin, 'X-Forwarded-Proto': 'http' },
  });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers['set-cookie'][0], /; Secure$/);
});

test('an explicitly configured HTTP origin preserves HTTP cookies and checks the configured port', async t => {
  const { request } = await fixture(t, { publicOrigin: 'http://split.example:8080' });
  const login = await request('/api/login', {
    headers: { Host: 'split.example:8080', Origin: 'http://split.example:8080', 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.headers['set-cookie'][0], /; Secure/);
  assert.equal((await request('/api/login', {
    headers: { Host: 'split.example', Origin: 'http://split.example:8080' },
  })).status, 403);
  assert.equal((await request('/api/login', {
    headers: { Host: 'split.example:8080', Origin: 'https://split.example:8080' },
  })).status, 403);
});

test('without configuration local HTTP behavior remains unchanged and spoofed HTTPS is rejected', async t => {
  const previous = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  let local;
  try { local = await fixture(t); } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
  }
  const login = await local.request('/api/login', { headers: { Origin: local.base, 'X-Forwarded-Proto': 'https' } });
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.headers['set-cookie'][0], /; Secure/);
  assert.equal((await local.request('/api/login')).status, 200);
  assert.equal((await local.request('/api/login', {
    headers: { Origin: local.base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' },
  })).status, 403);
});

test('PUBLIC_ORIGIN environment configuration is applied when no option is supplied', async t => {
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = 'https://split.example';
  let configured;
  try { configured = await fixture(t); } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
  }
  const login = await configured.request('/api/login', { headers: { Host: 'split.example', Origin: 'https://split.example' } });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /; Secure$/);
});

test('invalid public origin configurations fail before creating private data', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-origin-invalid-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, 'not-created');
  for (const publicOrigin of [
    '', null, 123, 'split.example', 'ftp://split.example', 'https://user:password@split.example',
    'https://split.example/path', 'https://split.example/path/..', 'https://split.example?query=1',
    'https://split.example#fragment', ' https://split.example', 'https://split.example\\path',
    'https://split.\nexample',
  ]) {
    await assert.rejects(createApp({ initialAdminPassword: 'test-only-admin-password', dataDir, publicOrigin }), /PUBLIC_ORIGIN/, String(publicOrigin));
  }
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});
