import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBackup, verifyArchive, safeError } from '../scripts/backup.mjs';

const media = '9785775d-dae3-4834-bc58-810df293d67a.png';
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-backup-test-'));
  const dataDir = path.join(base, 'data');
  const backupDir = path.join(base, 'backups');
  await fs.mkdir(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  const state = {
    version: 42, members: [{ id: 'member-1', avatarUrl: `/media/${media}` }], expenses: [],
    accounts: [{ id: 'fixture-admin', username: 'fixture-admin', role: 'admin', salt: '12'.repeat(16), hash: scryptSync('Fixture-only-pass-123', '12'.repeat(16), 64).toString('hex') }],
    content: { images: { illustration: { src: `/media/${media}` } } },
    currentGathering: { id: 'active-gathering', name: 'Current fixture', date: '2026-10-20', status: 'open', createdAt: '2026-10-20T00:00:00.000Z', finalizedAt: null },
    advances: [],
    gatherings: [{ gathering: { id: 'history-gathering', name: 'Historical fixture', date: '2026-10-19', status: 'finalized', createdAt: '2026-10-19T00:00:00.000Z', finalizedAt: '2026-10-19T02:00:00.000Z' }, members: [{ id: 'old-member', avatarUrl: `/media/${media}` }], expenses: [], advances: [], version: 40 }],
    authSessions: [{ accountId: 'fixture-admin', idHash: 'ab'.repeat(32), csrfToken: 'cd'.repeat(24), loginIp: '127.0.0.1', issuedAt: 1792454400, expiresAt: 1792454400 + 30 * 86400 }],
  };
  const stateBytes = Buffer.from(JSON.stringify(state, null, 2));
  const key = randomBytes(32);
  await fs.writeFile(path.join(dataDir, 'state.json'), stateBytes, { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, '.jwt-signing-key'), key, { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, 'uploads', media), Buffer.from('immutable fixture image'), { mode: 0o600 });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, dataDir, backupDir, stateBytes, key };
}
const status = async dataDir => JSON.parse(await fs.readFile(path.join(dataDir, 'backup-status.json'), 'utf8'));
async function changedArchive(archive, destination, change) {
  const tar = gunzipSync(await fs.readFile(archive));
  change(tar);
  await fs.writeFile(destination, gzipSync(tar), { mode: 0o600 });
  return destination;
}
function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}

test('verified snapshot preserves the exact state, JWT key, immutable images and private modes; offline restore never overwrites', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDir, '.state-crash.tmp'), 'not included');
  await fs.writeFile(path.join(f.dataDir, 'uploads', `.${media}.tmp`), 'incomplete upload');
  const originalKey = await fs.readFile(path.join(f.dataDir, '.jwt-signing-key'));
  const result = await createBackup(f);
  assert.match(path.basename(result.archive), /^dinner-split-backup-\d{8}T\d{9}Z-[a-f0-9]{8}\.tar\.gz$/);
  assert.equal(result.backupCount, 1);
  assert.equal(result.retentionDays, 14);
  assert.equal(result.lastError, null);
  const verification = await verifyArchive(result.archive);
  assert.equal(verification.fileCount, 3);
  assert.equal(verification.mediaCount, 1);
  const restored = path.join(f.base, 'restored');
  await verifyArchive(result.archive, { restoreTo: restored });
  assert.deepEqual(await fs.readFile(path.join(restored, 'state.json')), f.stateBytes);
  assert.deepEqual(await fs.readFile(path.join(restored, '.jwt-signing-key')), originalKey);
  assert.equal(await fs.readFile(path.join(restored, 'uploads', media), 'utf8'), 'immutable fixture image');
  assert.deepEqual((await fs.readdir(restored)).sort(), ['.jwt-signing-key', 'state.json', 'uploads']);
  await assert.rejects(verifyArchive(result.archive, { restoreTo: restored }), error => error.backupCode === 'restore_exists');
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'state.json')), f.stateBytes);
  if (process.platform !== 'win32') {
    for (const filename of [result.archive, path.join(f.dataDir, 'backup-status.json'), path.join(restored, 'state.json'), path.join(restored, '.jwt-signing-key')]) assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    for (const directory of [f.backupDir, restored, path.join(restored, 'uploads')]) assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  const saved = await status(f.dataDir);
  assert.equal(saved.latestSizeBytes, (await fs.stat(result.archive)).size);
  assert.equal(saved.lastSuccessAt, result.lastSuccessAt);
  assert.equal(saved.lastAttemptAt, result.lastAttemptAt);
  assert.ok(saved.verifiedAt);
  assert.deepEqual(Object.keys(saved).sort(), ['backupCount', 'lastAttemptAt', 'lastError', 'lastSuccessAt', 'latestSizeBytes', 'retentionDays', 'verifiedAt']);
  const tar = spawnSync('tar', ['-tzf', result.archive], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  assert.deepEqual(tar.stdout.trim().split('\n').sort(), ['.jwt-signing-key', 'manifest.json', 'state.json', `uploads/${media}`].sort());
});

test('corrupt data, missing referenced media, malformed keys and unsafe uploads preserve the previous successful backup and status', async t => {
  const f = await fixture(t);
  const good = await createBackup(f);
  const previous = await status(f.dataDir);
  const cases = [
    async () => fs.writeFile(path.join(f.dataDir, 'state.json'), '{incomplete'),
    async () => fs.unlink(path.join(f.dataDir, 'uploads', media)),
    async () => fs.writeFile(path.join(f.dataDir, '.jwt-signing-key'), Buffer.alloc(31)),
    async () => fs.symlink(path.join(f.dataDir, 'state.json'), path.join(f.dataDir, 'uploads', '203f830d-e809-4c8d-bb23-f83df94bd216.png')),
    async () => fs.mkdir(path.join(f.dataDir, 'uploads', '203f830d-e809-4c8d-bb23-f83df94bd216.png')),
  ];
  for (let index = 0; index < cases.length; index++) {
    await fs.writeFile(path.join(f.dataDir, 'state.json'), f.stateBytes);
    await fs.writeFile(path.join(f.dataDir, '.jwt-signing-key'), f.key);
    await fs.rm(path.join(f.dataDir, 'uploads'), { recursive: true, force: true });
    await fs.mkdir(path.join(f.dataDir, 'uploads'), { mode: 0o700 });
    await fs.writeFile(path.join(f.dataDir, 'uploads', media), 'immutable fixture image');
    await cases[index]();
    await assert.rejects(createBackup({ ...f, now: new Date(Date.now() + 1000 + index) }));
    const failed = await status(f.dataDir);
    assert.equal(failed.lastSuccessAt, previous.lastSuccessAt);
    assert.equal(failed.latestSizeBytes, previous.latestSizeBytes);
    assert.equal(failed.verifiedAt, previous.verifiedAt);
    assert.equal(failed.backupCount, 1);
    assert.ok(failed.lastError);
    assert.ok(!failed.lastError.includes(f.base));
    assert.deepEqual((await fs.readdir(f.backupDir)), [path.basename(good.archive)]);
  }
});

test('snapshot directory separation, symbolic links and concurrent locks are enforced without changing the previous success status', async t => {
  const f = await fixture(t);
  const good = await createBackup(f);
  const previous = await fs.readFile(path.join(f.dataDir, 'backup-status.json'));
  await assert.rejects(createBackup({ ...f, backupDir: f.dataDir }), error => error.backupCode === 'unsafe_path');
  await assert.rejects(createBackup({ ...f, backupDir: path.join(f.dataDir, 'recursive-backups') }), error => error.backupCode === 'unsafe_path');
  const linked = path.join(f.base, 'linked-backups');
  await fs.symlink(f.backupDir, linked);
  await assert.rejects(createBackup({ ...f, backupDir: linked }), error => error.backupCode === 'unsafe_path');
  await fs.mkdir(path.join(f.backupDir, '.dinner-split-backup.lock'));
  await assert.rejects(createBackup(f), error => error.backupCode === 'locked');
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'backup-status.json')), previous);
  await fs.rm(path.join(f.backupDir, '.dinner-split-backup.lock'), { recursive: true });
  const outcomes = await Promise.allSettled([createBackup(f), createBackup(f)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.backupCode, 'locked');
  assert.ok(await fs.stat(good.archive));
});

test('retention removes only expired canonical backups, keeps unrelated files and always publishes a verified newest success', async t => {
  const f = await fixture(t);
  const first = await createBackup(f);
  const old = new Date(Date.now() - 15 * 86400000);
  await fs.utimes(first.archive, old, old);
  const unrecognized = path.join(f.backupDir, 'manual-backup.tar.gz');
  await fs.writeFile(unrecognized, 'manual content');
  await fs.utimes(unrecognized, old, old);
  const recentName = 'dinner-split-backup-20000101T010101001Z-aabbccdd.tar.gz';
  await fs.copyFile(first.archive, path.join(f.backupDir, recentName));
  const result = await createBackup(f);
  await assert.rejects(fs.stat(first.archive), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrecognized, 'utf8'), 'manual content');
  assert.ok(await fs.stat(path.join(f.backupDir, recentName)));
  assert.ok(await verifyArchive(result.archive));
  assert.equal(result.backupCount, 2);
});

test('strict archive verification rejects tampering, traversal, links, duplicated entries, excessive entry sizes and malformed gzip', async t => {
  const f = await fixture(t);
  const good = await createBackup(f);
  const cases = [
    tar => { tar[512] ^= 1; }, // payload does not match manifest hash
    tar => { tar.fill(0, 0, 100); tar.write('../state.json', 0, 'ascii'); checksum(tar.subarray(0, 512)); },
    tar => { tar.fill(0, 0, 100); tar.write('/state.json', 0, 'ascii'); checksum(tar.subarray(0, 512)); },
    tar => { tar[156] = 50; tar.write('state.json', 157, 'ascii'); checksum(tar.subarray(0, 512)); },
    tar => { tar[156] = 49; tar.write('state.json', 157, 'ascii'); checksum(tar.subarray(0, 512)); },
    tar => { tar[156] = 120; checksum(tar.subarray(0, 512)); },
    tar => { tar.write('evil-prefix', 345, 'ascii'); checksum(tar.subarray(0, 512)); },
    tar => { tar.write((65 * 1024 * 1024).toString(8).padStart(11, '0') + '\0', 124, 'ascii'); checksum(tar.subarray(0, 512)); },
    tar => { const second = 512 + Math.ceil(f.stateBytes.length / 512) * 512; tar.fill(0, second, second + 100); tar.write('state.json', second, 'ascii'); checksum(tar.subarray(second, second + 512)); },
    tar => { tar[tar.length - 1] = 1; },
  ];
  for (let index = 0; index < cases.length; index++) {
    const filename = await changedArchive(good.archive, path.join(f.base, `bad-${index}.tar.gz`), cases[index]);
    const restoreTo = path.join(f.base, `should-not-exist-${index}`);
    await assert.rejects(verifyArchive(filename, { restoreTo }));
    await assert.rejects(fs.stat(restoreTo), { code: 'ENOENT' });
  }
  const corrupt = path.join(f.base, 'not-gzip.tar.gz');
  await fs.writeFile(corrupt, 'not gzip');
  await assert.rejects(verifyArchive(corrupt));
  const link = path.join(f.base, 'linked-archive');
  await fs.symlink(good.archive, link);
  await assert.rejects(verifyArchive(link));
  assert.ok(await verifyArchive(good.archive));
});

test('backup and restore CLIs emit safe summaries without account data, keys, or filesystem paths', async t => {
  const f = await fixture(t);
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8' });
  const created = run('scripts/backup.mjs', ['--data-dir', f.dataDir, '--backup-dir', f.backupDir, '--retain-days', '14']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).ok, true);
  const files = (await fs.readdir(f.backupDir)).filter(name => name.endsWith('.tar.gz'));
  const verified = run('scripts/restore-backup.mjs', ['--verify', path.join(f.backupDir, files[0])]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).fileCount, 3);
  const failed = run('scripts/backup.mjs', ['--data-dir', f.dataDir, '--backup-dir', f.dataDir]);
  assert.equal(failed.status, 1);
  for (const output of [created.stdout, created.stderr, verified.stdout, verified.stderr, failed.stdout, failed.stderr]) {
    assert.ok(!output.includes(f.base));
    assert.ok(!output.includes('fixture-admin'));
    assert.ok(!output.includes(f.key.toString('hex')));
    assert.ok(!output.includes('fixture-only-not-a-real-password-hash'));
  }
  assert.ok(!safeError(new Error('private filesystem error')).includes('private filesystem error'));
  for (const script of ['backup.mjs', 'restore-backup.mjs']) {
    const original = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', script);
    const alias = path.join(f.base, `alias-${script}`);
    await fs.symlink(original, alias);
    const aliased = spawnSync(process.execPath, [alias, '--invalid-option'], { encoding: 'utf8' });
    // A silent zero exit here would mean main-entry detection skipped the CLI.
    assert.equal(aliased.status, 1, `${script} must run when invoked through a symlink`);
    assert.ok(aliased.stderr.trim());
  }
});


test('backup rejects syntactically valid JSON that cannot represent a restorable ledger, accounts, history or login registry', async t => {
  const f = await fixture(t);
  const good = await createBackup(f);
  const original = JSON.parse(f.stateBytes.toString());
  const changes = [
    () => ({}),
    value => { value.version = 0; return value; },
    value => { value.accounts[0].role = 'editor'; return value; },
    value => { value.accounts[0].hash = 'damaged'; return value; },
    value => { value.accounts[0].salt = ''; return value; },
    value => { value.members = {}; return value; },
    value => { value.expenses = [{ id: 'expense-1', amountCents: 1, participantIds: ['missing-member'] }]; return value; },
    value => { value.authSessions[0].csrfToken = 'damaged'; return value; },
    value => { value.authSessions[0].accountId = 'missing-account'; return value; },
    value => { value.currentGathering.date = '2026-02-30'; return value; },
    value => { value.currentGathering.status = 'finalized'; return value; },
    value => { value.gatherings[0].gathering.status = 'open'; value.gatherings[0].gathering.finalizedAt = null; return value; },
    value => { value.gatherings[0].gathering.id = value.currentGathering.id; return value; },
    value => { value.gatherings[0].advances = [{ id: 'advance-1', memberId: 'missing', expenseId: 'missing', amountCents: 1 }]; return value; },
  ];
  for (const change of changes) {
    await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify(change(structuredClone(original))));
    await assert.rejects(createBackup(f), error => error.backupCode === 'invalid_state');
    assert.equal((await status(f.dataDir)).lastSuccessAt, good.lastSuccessAt);
  }
  // Existing pre-history releases remain recoverable and are upgraded only by
  // the application after an administrator elects to run the restored copy.
  const legacy = structuredClone(original);
  for (const key of ['currentGathering', 'gatherings', 'advances', 'authSessions']) delete legacy[key];
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify(legacy));
  const result = await createBackup(f);
  assert.ok(await verifyArchive(result.archive));
});
