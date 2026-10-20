import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_ACCOUNT_LIMIT = 10;
export const SESSION_TOTAL_LIMIT = 1000;
export const SIGNING_KEY_FILENAME = '.jwt-signing-key';
const ISSUER = 'dinner-split';
const AUDIENCE = 'dinner-split-session';
const HEADER = { alg: 'HS256', typ: 'JWT' };
const KEY_LENGTH = 32;
const TOKEN_LIMIT = 2048;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export async function loadSigningKey(dataDir) {
  const filename = path.join(dataDir, SIGNING_KEY_FILENAME);
  try {
    const handle = await fs.open(filename, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(KEY_LENGTH));
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Existing damaged or permissive key files must never be silently replaced.
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== KEY_LENGTH ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
    throw new Error('JWT 签名密钥无效：必须为独立的 32 字节文件，权限为 0600。');
  }
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('JWT 签名密钥读取失败。');
    const key = await handle.readFile();
    if (key.length !== KEY_LENGTH) throw new Error('JWT 签名密钥长度无效。');
    return key;
  } finally { await handle.close(); }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

function decode(segment, maximum) {
  if (!segment || segment.length > maximum || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid encoding');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('noncanonical encoding');
  return bytes;
}

function parse(segment, maximum) {
  const text = utf8.decode(decode(segment, maximum));
  const value = JSON.parse(text);
  // Tokens issued by this application are canonical JSON. This also rejects
  // duplicate claims, escaped property names and parser-dependent whitespace.
  if (JSON.stringify(value) !== text) throw new Error('noncanonical JSON');
  return value;
}

export function sessionIdHash(jti) { return createHash('sha256').update(jti).digest('hex'); }

export function issueJwt(key, accountId, now = Math.floor(Date.now() / 1000)) {
  const claims = { iss: ISSUER, aud: AUDIENCE, sub: accountId, jti: randomBytes(32).toString('hex'), iat: now, exp: now + SESSION_TTL_SECONDS };
  const input = `${encode(HEADER)}.${encode(claims)}`;
  return { token: `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`, claims };
}

export function verifyJwt(token, key, now = Math.floor(Date.now() / 1000)) {
  try {
    if (typeof token !== 'string' || token.length > TOKEN_LIMIT) return null;
    const segments = token.split('.');
    if (segments.length !== 3) return null;
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    const header = parse(headerSegment, 128);
    if (!exactKeys(header, ['alg', 'typ']) || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const signature = decode(signatureSegment, 43);
    const expected = createHmac('sha256', key).update(`${headerSegment}.${payloadSegment}`).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const claims = parse(payloadSegment, 1536);
    if (!exactKeys(claims, ['iss', 'aud', 'sub', 'jti', 'iat', 'exp']) ||
        claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
        typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sub) ||
        typeof claims.jti !== 'string' || !/^[a-f0-9]{64}$/.test(claims.jti) ||
        !Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > now ||
        !Number.isSafeInteger(claims.exp) || claims.exp !== claims.iat + SESSION_TTL_SECONDS || claims.exp <= now) return null;
    return claims;
  } catch { return null; }
}

export function validateSessionRegistry(sessions) {
  if (!Array.isArray(sessions) || sessions.length > SESSION_TOTAL_LIMIT) throw new Error('私有数据文件无效：登录会话格式不正确。');
  const ids = new Set();
  for (const session of sessions) {
    if (!exactKeys(session, ['accountId', 'idHash', 'csrfToken', 'loginIp', 'issuedAt', 'expiresAt']) ||
        typeof session.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session.accountId) ||
        typeof session.idHash !== 'string' || !/^[a-f0-9]{64}$/.test(session.idHash) || ids.has(session.idHash) ||
        typeof session.csrfToken !== 'string' || !/^[a-f0-9]{48}$/.test(session.csrfToken) ||
        typeof session.loginIp !== 'string' || (session.loginIp !== 'unknown' && !isIP(session.loginIp)) ||
        !Number.isSafeInteger(session.issuedAt) || session.issuedAt < 0 ||
        !Number.isSafeInteger(session.expiresAt) || session.expiresAt !== session.issuedAt + SESSION_TTL_SECONDS) {
      throw new Error('私有数据文件无效：登录会话格式不正确。');
    }
    ids.add(session.idHash);
  }
}

export function pruneSessions(sessions, accounts, now = Math.floor(Date.now() / 1000)) {
  const accountIds = new Set(accounts.map(account => account.id));
  const counts = new Map();
  // Registry order is issuance order, including tokens issued within one second.
  // Keep the newest ten sessions per account and the newest 1,000 overall.
  return sessions.filter(session => session.expiresAt > now && accountIds.has(session.accountId)).reverse().filter(session => {
    const count = counts.get(session.accountId) || 0;
    counts.set(session.accountId, count + 1);
    return count < SESSION_ACCOUNT_LIMIT;
  }).slice(0, SESSION_TOTAL_LIMIT).reverse();
}
