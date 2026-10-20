import { constants, createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { calculateLedger } from '../public/split.js';
import { validateSessionRegistry } from '../auth.mjs';
import { validGathering } from '../server.mjs';

export const BACKUP_PREFIX = 'dinner-split-backup-';
const KEY_FILE = '.jwt-signing-key';
const STATUS_FILE = 'backup-status.json';
const LOCK_NAME = '.dinner-split-backup.lock';
const ARCHIVE_NAME = /^dinner-split-backup-\d{8}T\d{9}Z-[a-f0-9]{8}\.tar\.gz$/;
const MEDIA_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|webp)$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 100000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, candidate) => candidate === parent || candidate.startsWith(parent + path.sep);
const fail = code => Object.assign(new Error(code), { backupCode: code });
const summaries = {
  invalid_options: '备份配置无效。', unsafe_path: '备份目录或文件路径不安全。',
  locked: '已有备份任务运行，本次未重复执行。', invalid_state: '账本数据校验失败。',
  invalid_key: '登录验证密钥校验失败。', invalid_media: '图片数据校验失败。',
  invalid_archive: '备份文件完整性校验失败。', archive_limit: '备份超过安全处理上限。',
  missing_data: '备份所需数据不完整。', restore_exists: '恢复目录已存在，未覆盖任何数据。',
};
export function safeError(error) { return summaries[error?.backupCode] || '备份操作未完成，请检查磁盘空间、目录权限和服务日志。'; }

async function privateDirectory(directory, { create = false } = {}) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe_path');
  return fs.realpath(directory);
}
async function readRegular(filename, maximum = MAX_FILE_BYTES) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw fail('unsafe_path');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev || opened.size > maximum) throw fail('unsafe_path');
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw fail('archive_limit');
    return { bytes, stat: opened };
  } finally { await handle.close(); }
}
function parseState(bytes) {
  try {
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!state || typeof state !== 'object' || Array.isArray(state) || !Number.isSafeInteger(state.version) || state.version < 1 ||
        !Array.isArray(state.members) || !Array.isArray(state.expenses) || !Array.isArray(state.accounts) || !state.accounts.some(account => account?.role === 'admin')) throw new Error();
    const ids = new Set(), usernames = new Set();
    for (const account of state.accounts) {
      if (!account || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.id) || ids.has(account.id) ||
          typeof account.username !== 'string' || !/^[A-Za-z0-9_.-]{2,32}$/.test(account.username) || usernames.has(account.username.toLowerCase()) ||
          !['admin', 'editor'].includes(account.role) || typeof account.salt !== 'string' || !/^[a-f0-9]{32}$/.test(account.salt) ||
          typeof account.hash !== 'string' || !/^[a-f0-9]{128}$/.test(account.hash)) throw new Error();
      ids.add(account.id); usernames.add(account.username.toLowerCase());
    }
    if (state.advances !== undefined && !Array.isArray(state.advances)) throw new Error();
    if (!calculateLedger(state).balanced) throw new Error();
    if (state.authSessions !== undefined) {
      validateSessionRegistry(state.authSessions);
      if (state.authSessions.some(session => !ids.has(session.accountId))) throw new Error();
    }
    const gatheringIds = new Set();
    if (state.currentGathering !== undefined) {
      if (!validGathering(state.currentGathering)) throw new Error();
      gatheringIds.add(state.currentGathering.id);
    }
    if (state.gatherings !== undefined) {
      if (!Array.isArray(state.gatherings)) throw new Error();
      for (const saved of state.gatherings) {
        if (!saved || !validGathering(saved.gathering) || saved.gathering.status !== 'finalized' || gatheringIds.has(saved.gathering.id) ||
            !Number.isSafeInteger(saved.version) || saved.version < 1 || !Array.isArray(saved.members) || !Array.isArray(saved.expenses) || !Array.isArray(saved.advances)) throw new Error();
        gatheringIds.add(saved.gathering.id);
        if (!calculateLedger(saved).balanced) throw new Error();
      }
    }
    if (state.auditLogs !== undefined && (!Array.isArray(state.auditLogs) || state.auditLogs.some(event =>
      !event || typeof event !== 'object' || Array.isArray(event) || typeof event.id !== 'string' || !MEDIA_NAME.test(`${event.id}.png`) ||
      typeof event.createdAt !== 'string' || typeof event.username !== 'string' || !['admin', 'editor', null].includes(event.role) ||
      typeof event.action !== 'string' || typeof event.summary !== 'string' || typeof event.ip !== 'string' || typeof event.loginIp !== 'string'))) throw new Error();
    return state;
  } catch { throw fail('invalid_state'); }
}
function referencedMedia(state) {
  const names = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['avatarUrl', 'src'].includes(key) && typeof item === 'string' && item.startsWith('/media/')) {
        const name = item.slice(7);
        if (!MEDIA_NAME.test(name)) throw fail('invalid_media');
        names.add(`uploads/${name}`);
      } else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(state);
  return names;
}
function validEntryName(name) { return typeof name === 'string' && (name === 'state.json' || name === KEY_FILE || name === 'manifest.json' || (name.startsWith('uploads/') && MEDIA_NAME.test(name.slice(8)))); }
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle.close(); }
}
async function writePrivate(filename, bytes) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function tarHeader(name, size, time) {
  const header = Buffer.alloc(512);
  const put = (text, start, length) => header.write(text, start, length, 'ascii');
  const octal = (number, start, length) => put(number.toString(8).padStart(length - 1, '0') + '\0', start, length);
  put(name, 0, 100); octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(Math.floor(time / 1000), 136, 12);
  header.fill(32, 148, 156); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}
async function* tarStream(staging, names, timestamp) {
  for (const name of names) {
    const { bytes } = await readRegular(path.join(staging, name));
    yield tarHeader(name, bytes.length, timestamp);
    yield bytes;
    const padding = (512 - bytes.length % 512) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}
function tarString(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  const bytes = end < 0 ? raw : raw.subarray(0, end);
  if (bytes.some(byte => byte < 32 || byte > 126)) throw fail('invalid_archive');
  return bytes.toString('ascii');
}
function tarNumber(header, start, length) {
  const value = tarString(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw fail('invalid_archive');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw fail('invalid_archive');
  return number;
}
function parseHeader(header) {
  const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (sum !== tarNumber(header, 148, 8) || tarString(header, 257, 6) !== 'ustar' || tarString(header, 263, 2) !== '00') throw fail('invalid_archive');
  // Only simple regular ustar entries are accepted. No symlinks, hardlinks,
  // devices, PAX/GNU extension records, directory records or prefix paths.
  if (header[156] !== 48 || tarString(header, 157, 100) || tarString(header, 345, 155)) throw fail('invalid_archive');
  const name = tarString(header, 0, 100);
  if (!validEntryName(name)) throw fail('invalid_archive');
  const size = tarNumber(header, 124, 12);
  if (size > MAX_FILE_BYTES) throw fail('archive_limit');
  return { name, size };
}
async function extractStrict(archive, staging) {
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_TOTAL_BYTES) throw fail('invalid_archive');
  const seen = new Set();
  let buffer = Buffer.alloc(0), entry = null, chunks = [], remaining = 0, padding = 0;
  let total = 0, zeroBlocks = 0, ended = false;
  const source = createReadStream(archive);
  const gunzip = createGunzip();
  source.pipe(gunzip);
  // Keep errors from the source attached to the consuming stream.
  source.on('error', error => gunzip.destroy(error));
  try {
    for await (const chunk of gunzip) {
      total += chunk.length;
      if (total > MAX_TOTAL_BYTES) throw fail('archive_limit');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length) {
        if (ended) {
          if (buffer.some(byte => byte !== 0)) throw fail('invalid_archive');
          buffer = Buffer.alloc(0); break;
        }
        if (entry) {
          if (remaining) {
            const length = Math.min(remaining, buffer.length);
            chunks.push(buffer.subarray(0, length)); buffer = buffer.subarray(length); remaining -= length;
            if (remaining) break;
            const bytes = Buffer.concat(chunks, entry.size);
            const target = path.join(staging, entry.name);
            if (entry.name.startsWith('uploads/')) await fs.mkdir(path.dirname(target), { mode: 0o700, recursive: true });
            await writePrivate(target, bytes);
            chunks = [];
          }
          if (padding) {
            const length = Math.min(padding, buffer.length);
            if (buffer.subarray(0, length).some(byte => byte !== 0)) throw fail('invalid_archive');
            buffer = buffer.subarray(length); padding -= length;
            if (padding) break;
          }
          entry = null;
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) { zeroBlocks++; if (zeroBlocks === 2) ended = true; continue; }
        if (zeroBlocks) throw fail('invalid_archive');
        entry = parseHeader(header);
        if (seen.has(entry.name) || seen.size >= MAX_FILES) throw fail('invalid_archive');
        seen.add(entry.name); remaining = entry.size; padding = (512 - entry.size % 512) % 512;
        if (remaining === 0) {
          const target = path.join(staging, entry.name);
          if (entry.name.startsWith('uploads/')) await fs.mkdir(path.dirname(target), { mode: 0o700, recursive: true });
          await writePrivate(target, Buffer.alloc(0));
        }
      }
    }
    if (!ended || buffer.length || entry || zeroBlocks < 2) throw fail('invalid_archive');
    return seen;
  } finally { source.destroy(); gunzip.destroy(); }
}
async function verifyExtracted(staging, names) {
  if (!names.has('manifest.json') || !names.has('state.json') || !names.has(KEY_FILE)) throw fail('missing_data');
  let manifest;
  try { manifest = JSON.parse((await readRegular(path.join(staging, 'manifest.json'))).bytes.toString('utf8')); } catch { throw fail('invalid_archive'); }
  if (manifest?.formatVersion !== 1 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files) || manifest.files.length !== names.size - 1) throw fail('invalid_archive');
  const expected = new Set();
  for (const item of manifest.files) {
    if (!item || !validEntryName(item.path) || item.path === 'manifest.json' || expected.has(item.path) || !names.has(item.path) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw fail('invalid_archive');
    expected.add(item.path);
    const { bytes } = await readRegular(path.join(staging, item.path));
    if (bytes.length !== item.sizeBytes || hash(bytes) !== item.sha256) throw fail('invalid_archive');
  }
  const state = parseState((await readRegular(path.join(staging, 'state.json'))).bytes);
  if ((await readRegular(path.join(staging, KEY_FILE))).bytes.length !== 32) throw fail('invalid_key');
  for (const name of referencedMedia(state)) if (!names.has(name)) throw fail('invalid_media');
  return { createdAt: manifest.createdAt, fileCount: names.size - 1, mediaCount: [...names].filter(name => name.startsWith('uploads/')).length };
}

async function freezeArchive(source, destination) {
  const before = await fs.lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_TOTAL_BYTES) throw fail('invalid_archive');
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_TOTAL_BYTES) throw fail('invalid_archive');
    let total = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      total += chunk.length;
      callback(total > MAX_TOTAL_BYTES ? fail('archive_limit') : null, chunk);
    } });
    await pipeline(handle.createReadStream({ autoClose: false }), limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } finally { await handle.close(); }
}

export async function verifyArchive(archive, { restoreTo } = {}) {
  // Copy once with O_NOFOLLOW before parsing to prevent an archive path swap
  // between validation and extraction. No archive-provided paths reach a shell.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dinner-backup-verify-'));
  await fs.chmod(temporary, 0o700);
  let createdTarget = false;
  try {
    const frozen = path.join(temporary, 'archive.tar.gz');
    await freezeArchive(path.resolve(archive), frozen);
    const extracted = path.join(temporary, 'data');
    await fs.mkdir(extracted, { mode: 0o700 });
    const names = await extractStrict(frozen, extracted);
    const summary = await verifyExtracted(extracted, names);
    if (restoreTo !== undefined) {
      const destination = path.resolve(restoreTo);
      // mkdir without recursive is the exclusive claim: existing directories
      // (including empty ones or symlinks) are never modified.
      try { await fs.mkdir(destination, { mode: 0o700 }); createdTarget = destination; }
      catch (error) { if (error.code === 'EEXIST') throw fail('restore_exists'); throw error; }
      for (const name of names) {
        if (name === 'manifest.json') continue;
        if (name.startsWith('uploads/')) await fs.mkdir(path.join(destination, 'uploads'), { mode: 0o700, recursive: true });
        await writePrivate(path.join(destination, name), (await readRegular(path.join(extracted, name))).bytes);
      }
      await fs.mkdir(path.join(destination, 'uploads'), { mode: 0o700, recursive: true });
      createdTarget = false;
    }
    return summary;
  } finally {
    if (createdTarget) await fs.rm(createdTarget, { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function statusWrite(dataDir, stateStat, status) {
  const temporary = path.join(dataDir, `.${STATUS_FILE}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writePrivate(temporary, Buffer.from(JSON.stringify(status, null, 2) + '\n'));
    if (stateStat && typeof process.getuid === 'function' && process.getuid() === 0) await fs.chown(temporary, stateStat.uid, stateStat.gid);
    await fs.rename(temporary, path.join(dataDir, STATUS_FILE));
    await syncDirectory(dataDir);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function previousStatus(dataDir) {
  try {
    const value = JSON.parse((await readRegular(path.join(dataDir, STATUS_FILE), 16384)).bytes.toString('utf8'));
    return {
      lastSuccessAt: typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : null,
      latestSizeBytes: Number.isSafeInteger(value.latestSizeBytes) ? value.latestSizeBytes : 0,
      verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : null,
    };
  } catch { return { lastSuccessAt: null, latestSizeBytes: 0, verifiedAt: null }; }
}
async function archives(backupDir) {
  const output = [];
  for (const name of await fs.readdir(backupDir)) {
    if (!ARCHIVE_NAME.test(name)) continue;
    const stat = await fs.lstat(path.join(backupDir, name));
    if (stat.isFile() && !stat.isSymbolicLink()) output.push({ name, stat });
  }
  return output.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createBackup({ dataDir, backupDir, retainDays = 14, now = new Date() }) {
  if (!dataDir || !backupDir || !Number.isInteger(retainDays) || retainDays < 1 || retainDays > 3650 || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw fail('invalid_options');
  dataDir = await privateDirectory(path.resolve(dataDir));
  const requestedBackupDir = path.resolve(backupDir);
  if (within(dataDir, requestedBackupDir) || within(requestedBackupDir, dataDir)) throw fail('unsafe_path');
  backupDir = await privateDirectory(requestedBackupDir, { create: true });
  if (within(dataDir, backupDir) || within(backupDir, dataDir)) throw fail('unsafe_path');
  await fs.chmod(backupDir, 0o700);
  const lock = path.join(backupDir, LOCK_NAME);
  // A lock is deliberately never auto-stolen. systemd prevents overlap; a
  // leftover lock after a hard kill must be inspected and removed by an admin.
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('locked'); throw error; }
  const previous = await previousStatus(dataDir);
  const status = { ...previous, lastAttemptAt: now.toISOString(), lastError: null, backupCount: 0, retentionDays: retainDays };
  let staging, pending, stateStat;
  try {
    await writePrivate(path.join(lock, 'owner.json'), Buffer.from(JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }) + '\n'));
    stateStat = await fs.lstat(path.join(dataDir, 'state.json'));
    if (!stateStat.isFile() || stateStat.isSymbolicLink()) throw fail('unsafe_path');
    const stateFile = await readRegular(path.join(dataDir, 'state.json'));
    stateStat = stateFile.stat;
    const state = parseState(stateFile.bytes);
    const key = await readRegular(path.join(dataDir, KEY_FILE), 32);
    if (key.bytes.length !== 32 || (process.platform !== 'win32' && (key.stat.mode & 0o777) !== 0o600)) throw fail('invalid_key');
    staging = await fs.mkdtemp(path.join(backupDir, '.snapshot-'));
    await fs.chmod(staging, 0o700);
    await fs.mkdir(path.join(staging, 'uploads'), { mode: 0o700 });
    const files = [];
    let snapshotBytes = 0;
    const add = async (name, bytes) => {
      snapshotBytes += bytes.length + 1024;
      if (files.length >= MAX_FILES - 1 || snapshotBytes > MAX_TOTAL_BYTES - MAX_FILE_BYTES) throw fail('archive_limit');
      files.push({ path: name, sizeBytes: bytes.length, sha256: hash(bytes) });
      await writePrivate(path.join(staging, name), bytes);
    };
    // State is read exactly once before immutable uploads. Concurrent atomic
    // state renames cannot mix revisions, and newly written uploads are safe.
    await add('state.json', stateFile.bytes);
    await add(KEY_FILE, key.bytes);
    const uploads = path.join(dataDir, 'uploads');
    await privateDirectory(uploads);
    for (const name of (await fs.readdir(uploads)).sort()) {
      if (/^\.[a-f0-9-]+\.(png|jpg|webp)\.tmp$/.test(name)) continue;
      if (!MEDIA_NAME.test(name)) throw fail('invalid_media');
      await add(`uploads/${name}`, (await readRegular(path.join(uploads, name))).bytes);
    }
    const names = new Set(files.map(item => item.path));
    for (const name of referencedMedia(state)) if (!names.has(name)) throw fail('invalid_media');
    const manifest = Buffer.from(JSON.stringify({ formatVersion: 1, createdAt: now.toISOString(), files }, null, 2) + '\n');
    await writePrivate(path.join(staging, 'manifest.json'), manifest);
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
    const name = `${BACKUP_PREFIX}${stamp}-${randomBytes(4).toString('hex')}.tar.gz`;
    pending = path.join(backupDir, `.${name}.pending`);
    await pipeline(Readable.from(tarStream(staging, [...files.map(item => item.path), 'manifest.json'], now.getTime())), createGzip({ level: 6 }), createWriteStream(pending, { flags: 'wx', mode: 0o600 }));
    await verifyArchive(pending);
    const handle = await fs.open(pending, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const final = path.join(backupDir, name);
    await fs.rename(pending, final); pending = null;
    await syncDirectory(backupDir);
    // Only our canonical successful archive names are considered. Retain the
    // newest success even if a clock jump makes all files older than the cutoff.
    const entries = await archives(backupDir);
    const cutoff = now.getTime() - retainDays * 86400000;
    for (const entry of entries) {
      if (entry.name !== name && entry.stat.mtimeMs < cutoff) await fs.unlink(path.join(backupDir, entry.name));
    }
    status.lastSuccessAt = now.toISOString(); status.verifiedAt = new Date().toISOString();
    status.latestSizeBytes = (await fs.stat(final)).size;
    status.backupCount = (await archives(backupDir)).length;
    await statusWrite(dataDir, stateStat, status);
    return { ...status, archive: final };
  } catch (error) {
    status.lastError = safeError(error);
    status.backupCount = (await archives(backupDir).catch(() => [])).length;
    await statusWrite(dataDir, stateStat, status).catch(() => {});
    throw error;
  } finally {
    if (pending) await fs.unlink(pending).catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!['--data-dir', '--backup-dir', '--retain-days'].includes(name) || !value || values[name] !== undefined) throw fail('invalid_options');
    values[name] = value;
  }
  if (!values['--data-dir'] || !values['--backup-dir'] || (values['--retain-days'] !== undefined && !/^\d+$/.test(values['--retain-days']))) throw fail('invalid_options');
  return { dataDir: values['--data-dir'], backupDir: values['--backup-dir'], retainDays: Number(values['--retain-days'] || 14) };
}
const invokedFile = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    const result = await createBackup(options(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, lastSuccessAt: result.lastSuccessAt, backupCount: result.backupCount, retentionDays: result.retentionDays, latestSizeBytes: result.latestSizeBytes, verifiedAt: result.verifiedAt }));
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  }
}
