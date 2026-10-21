import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify, isDeepStrictEqual } from 'node:util';
import { inflateSync } from 'node:zlib';
import { calculateLedger, MAX_AMOUNT_CENTS } from './public/split.js';
import { CONTENT_TEXT_FIELDS, CONTENT_IMAGE_FIELDS, normalizeContent, isContentImageSource } from './public/content.js';
import { SESSION_TTL_SECONDS, loadSigningKey, issueJwt, verifyJwt, sessionIdHash, validateSessionRegistry, pruneSessions } from './auth.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 32 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;
const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MEDIA_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|webp)$/;
const COOKIE_NAME = 'dinner_session';
const AUDIT_LIMIT = 10000;
const EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COLORS = ['#C9683F', '#50837A', '#6883A1', '#A2789F'];
const LEGACY_DEMO_MEMBERS = [
  { id: 'lin', name: '小林', note: '一起吃饭 · 乘车', color: COLORS[0], order: 0 },
  { id: 'yu', name: '小雨', note: '一起吃饭', color: COLORS[1], order: 1 },
  { id: 'jie', name: '阿杰', note: '不喝酒 · 乘车', color: COLORS[2], order: 2 },
  { id: 'ke', name: '可可', note: '一起吃饭', color: COLORS[3], order: 3 },
];
const LEGACY_DEMO_EXPENSES = [
  { id: 'dinner', title: '餐费', note: '四人一起享用的晚餐', icon: 'dinner', amountCents: 36000, participantIds: ['lin', 'yu', 'jie', 'ke'] },
  { id: 'drinks', title: '酒水', note: '三人分摊，阿杰不喝酒', icon: 'wine', amountCents: 12000, participantIds: ['lin', 'yu', 'ke'] },
  { id: 'parking', title: '停车费', note: '由小林和阿杰两位乘车人分摊', icon: 'car', amountCents: 2000, participantIds: ['lin', 'jie'] },
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

class ApiError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    Object.assign(this, { status, error, extra });
  }
}

async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}

async function verifyPassword(password, account) {
  const calculated = await scrypt(password, account.salt, 64);
  const expected = Buffer.from(account.hash, 'hex');
  return calculated.length === expected.length && timingSafeEqual(calculated, expected);
}

async function seedState(initialAdminPassword) {
  if (typeof initialAdminPassword !== 'string' || initialAdminPassword.length < 12 || initialAdminPassword.length > 256) {
    throw new Error('首次启动必须设置 ADMIN_PASSWORD，长度为 12–256 个字符。');
  }
  return {
    version: 1,
    ledgerSchemaVersion: 2,
    simpleLedgerVersion: 1,
    content: normalizeContent(),
    members: [],
    expenses: [],
    currentGathering: newGathering(normalizeContent().texts.gatheringName),
    gatherings: [],
    advances: [],
    auditLogs: [],
    authSessions: [],
    accounts: [{ id: randomUUID(), username: 'admin', role: 'admin', ...await passwordRecord(initialAdminPassword) }],
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function knownKeys(value, allowed, label) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ApiError(422, 'validation_error', `${label}包含未知字段或格式不正确。`);
  }
}

function contentPatch(body, current) {
  knownKeys(body, ['version', 'texts', 'images'], '页面内容');
  if (!Number.isSafeInteger(body.version)) throw new ApiError(422, 'validation_error', '请提交当前页面版本。');
  if (body.version !== current.version) {
    throw new ApiError(409, 'content_version_conflict', '页面已被其他管理员修改，已载入最新内容，请检查后重新保存。', { content: current });
  }
  if (body.texts === undefined && body.images === undefined) throw new ApiError(422, 'validation_error', '请提供需要保存的页面文字或图片。');
  const next = structuredClone(current);
  if (body.texts !== undefined) {
    knownKeys(body.texts, CONTENT_TEXT_FIELDS.map(field => field.key), '页面文字');
    for (const [key, value] of Object.entries(body.texts)) {
      const field = CONTENT_TEXT_FIELDS.find(item => item.key === key);
      next.texts[key] = requireText(value, field.label, 1, field.maxLength);
      if (!field.multiline && /[\r\n]/.test(value)) throw new ApiError(422, 'validation_error', `${field.label}不能包含换行。`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ApiError(422, 'validation_error', `${field.label}包含无效控制字符。`);
    }
  }
  if (body.images !== undefined) {
    knownKeys(body.images, CONTENT_IMAGE_FIELDS.map(field => field.key), '页面图片');
    for (const [key, value] of Object.entries(body.images)) {
      knownKeys(value, ['src', 'alt', 'fit', 'position'], '图片设置');
      const field = CONTENT_IMAGE_FIELDS.find(item => item.key === key);
      if (value.src !== undefined) {
        if (!isContentImageSource(value.src, field.allowEmpty)) throw new ApiError(422, 'validation_error', '请选择本站已上传的图片。');
        next.images[key].src = value.src;
      }
      if (value.alt !== undefined) {
        next.images[key].alt = requireText(value.alt, '图片说明', 0, 120);
        if (/[\r\n\u0000-\u001f\u007f]/.test(value.alt)) throw new ApiError(422, 'validation_error', '图片说明不能包含换行或控制字符。');
      }
      if (value.fit !== undefined) {
        if (!['contain', 'cover'].includes(value.fit)) throw new ApiError(422, 'validation_error', '图片显示方式无效。');
        next.images[key].fit = value.fit;
      }
      if (value.position !== undefined) {
        if (!['center', 'top', 'bottom'].includes(value.position)) throw new ApiError(422, 'validation_error', '图片对齐方式无效。');
        next.images[key].position = value.position;
      }
    }
  }
  next.version += 1;
  return next;
}

function validDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= 16000 && height <= 16000 && width * height <= 25_000_000;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8;
  let header;
  let end = false;
  let palette = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false;
    if (!header && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (header || length !== 13) return false;
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
      const depth = data[8], color = data[9];
      const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!validDimensions(width, height) || !allowed[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || data[12] > 1) return false;
      header = { width, height, depth, channels: ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color], color, interlace: data[12] };
    } else if (type === 'PLTE') {
      if (length < 3 || length > 768 || length % 3) return false;
      palette = true;
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') {
      if (length || offset + 12 !== bytes.length) return false;
      end = true;
      break;
    } else if (type[0] === type[0].toUpperCase()) return false;
    offset += length + 12;
  }
  if (!end || !compressed.length || (header.color === 3 && !palette)) return false;
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x) / dx));
    const count = Math.max(0, Math.ceil((header.height - y) / dy));
    return { size: width ? 1 + Math.ceil(width * header.channels * header.depth / 8) : 0, count };
  });
  const expected = rows.reduce((sum, row) => sum + row.size * row.count, 0);
  if (expected > 100 * 1024 * 1024) return false;
  let pixels;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); } catch { return false; }
  if (pixels.length !== expected) return false;
  let rowOffset = 0;
  for (const row of rows) for (let i = 0; row.size && i < row.count; i += 1) {
    if (pixels[rowOffset] > 4) return false;
    rowOffset += row.size;
  }
  return true;
}

function validJpeg(bytes) {
  if (bytes.length < 30 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2, frame = false, scan = false, entropy = false;
  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset + 1 >= bytes.length) return false;
      if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; continue; }
      entropy = false;
    }
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (!marker || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || ![8, 12, 16].includes(bytes[offset + 2]) || !validDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false;
      const components = bytes[offset + 7];
      if (!components || components > 4 || length !== 8 + components * 3) return false;
      frame = true;
    }
    if (marker === 0xda) {
      const components = bytes[offset + 2];
      if (!frame || !components || length !== 6 + components * 2) return false;
      scan = true;
      entropy = true;
    }
    offset += length;
  }
  return false;
}

function validWebp(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let offset = 12, image = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length || offset + 8 + length + (length % 2) > bytes.length) return false;
    if (type === 'VP8 ') {
      if (length < 10 || !data.subarray(3, 6).equals(Buffer.from('9d012a', 'hex')) || (data[0] & 1) || !validDimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff)) return false;
      image = true;
    } else if (type === 'VP8L') {
      if (length < 6 || data[0] !== 0x2f || data[4] >> 5 !== 0) return false;
      const width = 1 + (data[1] | ((data[2] & 0x3f) << 8));
      const height = 1 + ((data[2] >> 6) | (data[3] << 2) | ((data[4] & 0xf) << 10));
      if (!validDimensions(width, height)) return false;
      image = true;
    } else if (type === 'VP8X') {
      if (length !== 10 || (data[0] & 0x02) || !validDimensions(1 + data.readUIntLE(4, 3), 1 + data.readUIntLE(7, 3))) return false;
    } else if (['ANIM', 'ANMF'].includes(type)) return false;
    offset += 8 + length + (length % 2);
  }
  return image && offset === bytes.length;
}

async function readImage(request) {
  const mimeType = (request.headers['content-type'] || '').trim().toLowerCase();
  if (!UPLOAD_TYPES[mimeType]) throw new ApiError(415, 'image_type', '请上传 PNG、JPEG 或 WebP 图片。');
  if (Number(request.headers['content-length']) > IMAGE_LIMIT) throw new ApiError(413, 'image_too_large', '图片不能超过 5 MB。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > IMAGE_LIMIT) throw new ApiError(413, 'image_too_large', '图片不能超过 5 MB。');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const validate = { 'image/png': validPng, 'image/jpeg': validJpeg, 'image/webp': validWebp }[mimeType];
  if (!validate(bytes)) throw new ApiError(422, 'invalid_image', '图片内容损坏、格式不匹配或尺寸过大，请重新选择图片。');
  return { bytes, mimeType, extension: UPLOAD_TYPES[mimeType] };
}

function publicState(state) {
  return { version: state.version, members: state.members, expenses: state.expenses, currentGathering: state.currentGathering, advances: state.advances };
}

function beijingDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0, 4) !== '0000' &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function newGathering(name = '我的聚餐', date = beijingDate()) {
  return { id: randomUUID(), name: name || '我的聚餐', date, status: 'open', createdAt: new Date().toISOString(), finalizedAt: null };
}

export function validGathering(value) {
  return plainObject(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 80 && validDate(value.date) &&
    ['open', 'finalized'].includes(value.status) && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
    (value.status === 'open' ? value.finalizedAt === null : typeof value.finalizedAt === 'string' && Number.isFinite(Date.parse(value.finalizedAt)));
}

function requirePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) throw new ApiError(422, 'validation_error', '密码长度应为 8–256 个字符。');
  return value;
}


function publicAccount(account) {
  return { id: account.id, username: account.username, role: account.role };
}

function requireText(value, label, min = 1, max = 40) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ApiError(422, 'validation_error', `${label}应为 ${min}–${max} 个字符。`);
  }
  return value.trim();
}

function accountUsername(value) {
  const username = requireText(value, '账户名', 2, 32);
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new ApiError(422, 'validation_error', '账户名仅支持字母、数字、点、下划线和短横线。');
  return username;
}

function memberFields(body, current = {}) {
  const name = body.name === undefined ? current.name : requireText(body.name, '姓名', 1, 20);
  const note = body.note === undefined ? (current.note ?? '') : requireText(body.note, '备注', 0, 80);
  const color = body.color === undefined ? (current.color ?? COLORS[0]) : body.color;
  const avatarUrl = body.avatarUrl === undefined ? (current.avatarUrl ?? '') : body.avatarUrl;
  if (typeof color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(color)) {
    throw new ApiError(422, 'validation_error', '请选择有效的人物颜色。');
  }
  if (!name) throw new ApiError(422, 'validation_error', '请输入姓名。');
  if (typeof avatarUrl !== 'string' || (avatarUrl !== '' && (!avatarUrl.startsWith('/media/') || !MEDIA_NAME.test(avatarUrl.slice('/media/'.length))))) {
    throw new ApiError(422, 'validation_error', '请使用本站上传的头像图片。');
  }
  return { name, note, color, avatarUrl };
}

function expenseTitle(value) {
  const title = requireText(value, '费用名称', 1, 40);
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) throw new ApiError(422, 'validation_error', '费用名称不能包含换行或控制字符。');
  return title;
}

function expenseAllocation(body, state) {
  if (!Number.isSafeInteger(body.amountCents) || body.amountCents < 0 || body.amountCents > MAX_AMOUNT_CENTS) {
    throw new ApiError(422, 'validation_error', '金额必须为整数分，范围为 ¥0.00–¥1,000,000.00。');
  }
  if (!Array.isArray(body.participantIds) || body.participantIds.some(id => typeof id !== 'string' || !state.members.some(member => member.id === id)) || new Set(body.participantIds).size !== body.participantIds.length) {
    throw new ApiError(422, 'validation_error', '请选择有效且不重复的分摊人。');
  }
  if (body.amountCents > 0 && body.participantIds.length === 0) throw new ApiError(422, 'validation_error', '有金额的费用至少需要一位分摊人。');
  return { amountCents: body.amountCents, participantIds: body.participantIds };
}

function readCookie(request) {
  return (request.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
}

function cookie(value, request, publicOrigin, maxAge = SESSION_TTL_SECONDS) {
  const secure = request.socket.encrypted || publicOrigin?.protocol === 'https:';
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function configuredPublicOrigin(value) {
  if (value === undefined) return null;
  let parsed;
  try { parsed = typeof value === 'string' ? new URL(value) : null; } catch { /* rejected below */ }
  if (!parsed || /[\s\u0000-\u001f\u007f]/.test(value) || !/^https?:\/\/[^/?#\\]+\/?$/i.test(value) ||
      !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PUBLIC_ORIGIN 必须为不含账户、路径、查询或片段的 HTTP(S) 站点地址。');
  }
  return parsed;
}

function configuredTrustProxy(value) {
  if (value === undefined) return false;
  if (value !== 'loopback') throw new Error('TRUST_PROXY 仅支持 loopback，或不设置以直接记录连接 IP。');
  return true;
}

function normalizedIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

function requestIp(request, trustProxy) {
  const remote = normalizedIp(request.socket.remoteAddress);
  const loopback = remote === '::1' || (isIP(remote || '') === 4 && remote.startsWith('127.'));
  // The explicitly trusted loopback proxy must overwrite this single-IP header.
  const forwarded = trustProxy && loopback ? normalizedIp(request.headers['x-dinner-client-ip']) : null;
  return forwarded || remote || 'unknown';
}

function auditText(value, maximum) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum);
}

function money(cents) { return `¥${(cents / 100).toFixed(2)}`; }

async function readJson(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'content_type', '请使用 JSON 格式提交。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'body_too_large', '提交的数据过大。');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new ApiError(400, 'invalid_json', 'JSON 数据格式不正确。');
  }
}

function checkOrigin(request, publicOrigin) {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError(403, 'origin_rejected', '仅允许当前站点提交修改。');
  }
  if (publicOrigin) {
    // A configured origin is authoritative; client-supplied forwarding headers are not.
    if (origin !== publicOrigin.origin || request.headers.host !== publicOrigin.host) {
      throw new ApiError(403, 'origin_rejected', '仅允许当前站点提交修改。');
    }
    return;
  }
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { /* rejected below */ }
  const protocol = request.socket.encrypted ? 'https:' : 'http:';
  if (!parsed || parsed.protocol !== protocol || parsed.host !== request.headers.host || parsed.pathname !== '/') {
    throw new ApiError(403, 'origin_rejected', '仅允许当前站点提交修改。');
  }
}

export async function createApp({ initialAdminPassword = process.env.ADMIN_PASSWORD, dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), publicDir = path.join(ROOT, 'public'), publicOrigin = process.env.PUBLIC_ORIGIN, trustProxy = process.env.TRUST_PROXY } = {}) {
  publicOrigin = configuredPublicOrigin(publicOrigin);
  trustProxy = configuredTrustProxy(trustProxy);
  dataDir = path.resolve(dataDir);
  publicDir = path.resolve(publicDir);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const signingKey = await loadSigningKey(dataDir);
  const statePath = path.join(dataDir, 'state.json');
  const uploadsDir = path.join(dataDir, 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 });
  async function persist(next, guard) {
    const temporary = path.join(dataDir, `.state-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
      guard?.();
      await fs.rename(temporary, statePath);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  let state;
  try {
    const storedBytes = await fs.readFile(statePath);
    state = JSON.parse(storedBytes.toString('utf8'));
    if (!Number.isSafeInteger(state.version) || !Array.isArray(state.accounts) || !state.accounts.some(account => account.role === 'admin')) {
      throw new Error('私有数据文件无效：缺少版本或管理员账户。');
    }
    calculateLedger(state);
    let upgraded = false;
    if (state.authSessions === undefined) {
      state.authSessions = [];
      upgraded = true;
    } else {
      validateSessionRegistry(state.authSessions);
      const active = pruneSessions(state.authSessions, state.accounts);
      if (active.length !== state.authSessions.length) {
        state.authSessions = active;
        upgraded = true;
      }
    }
    if (state.auditLogs === undefined) {
      state.auditLogs = [];
      upgraded = true;
    } else if (!Array.isArray(state.auditLogs) || state.auditLogs.some(event =>
      !plainObject(event) || !EVENT_ID.test(event.id) || typeof event.createdAt !== 'string' ||
      typeof event.username !== 'string' || !['admin', 'editor', null].includes(event.role) ||
      typeof event.action !== 'string' || typeof event.summary !== 'string' ||
      typeof event.ip !== 'string' || typeof event.loginIp !== 'string')) {
      throw new Error('私有数据文件无效：操作日志格式不正确。');
    } else if (state.auditLogs.length > AUDIT_LIMIT) {
      state.auditLogs = state.auditLogs.slice(-AUDIT_LIMIT);
      upgraded = true;
    }
    if (!Number.isInteger(state.ledgerSchemaVersion) || state.ledgerSchemaVersion < 2) {
      const originalMembers = state.members.map(member => {
        const copy = { ...member };
        if (copy.avatarUrl === '') delete copy.avatarUrl;
        return copy;
      });
      if (isDeepStrictEqual(originalMembers, LEGACY_DEMO_MEMBERS) && isDeepStrictEqual(state.expenses, LEGACY_DEMO_EXPENSES)) {
        await fs.writeFile(path.join(dataDir, `state.before-empty-ledger-v2-${randomUUID()}.json`), storedBytes, { mode: 0o600, flag: 'wx' });
        state.members = [];
        state.expenses = [];
        state.version += 1;
      }
      state.ledgerSchemaVersion = 2;
      upgraded = true;
    }
    for (const member of state.members) if (member.avatarUrl === undefined) {
      member.avatarUrl = '';
      upgraded = true;
    }
    const content = normalizeContent(state.content);
    if (JSON.stringify(content) !== JSON.stringify(state.content)) {
      state.content = content;
      upgraded = true;
    }
    if (state.currentGathering === undefined) {
      state.currentGathering = newGathering(state.content.texts.gatheringName);
      upgraded = true;
    }
    if (state.gatherings === undefined) { state.gatherings = []; upgraded = true; }
    if (state.advances === undefined) { state.advances = []; upgraded = true; }
    if (!validGathering(state.currentGathering) || !Array.isArray(state.gatherings) || !Array.isArray(state.advances)) throw new Error('私有数据文件无效：聚餐记录格式不正确。');
    const gatheringIds = new Set([state.currentGathering.id]);
    for (const saved of state.gatherings) {
      if (!plainObject(saved) || !validGathering(saved.gathering) || saved.gathering.status !== 'finalized' || gatheringIds.has(saved.gathering.id) ||
          !Number.isSafeInteger(saved.version) || !Array.isArray(saved.advances)) throw new Error('私有数据文件无效：历史聚餐格式不正确。');
      gatheringIds.add(saved.gathering.id);
      calculateLedger(saved);
    }
    // Keep legacy snapshots private for compatibility, without exposing archive
    // workflows. Existing finalized ledgers become editable during this migration.
    if (state.simpleLedgerVersion !== 1) {
      if (state.currentGathering.status === 'finalized') {
        state.currentGathering.status = 'open';
        state.currentGathering.finalizedAt = null;
      }
      state.simpleLedgerVersion = 1;
      upgraded = true;
    }
    calculateLedger(state);
    if (upgraded) await persist(state);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = await seedState(initialAdminPassword);
    await persist(state);
  }
  const loginAttempts = new Map();
  const passwordAttempts = new Map();
  const dummyAccount = await passwordRecord(randomBytes(24).toString('hex'));
  let mutationQueue = Promise.resolve();
  const enqueue = handler => {
    const operation = mutationQueue.then(handler);
    mutationQueue = operation.catch(() => {});
    return operation;
  };
  const mutate = (handler, guard, afterCommit) => enqueue(async () => {
      const next = structuredClone(state);
      next.authSessions = pruneSessions(next.authSessions, next.accounts);
      const result = await handler(next);
      guard?.();
      await persist(next, guard);
      state = next;
      afterCommit?.();
      return result === 'public' ? publicState(state) : result;
  });
  async function mediaFile(name) {
    if (!MEDIA_NAME.test(name)) throw new ApiError(404, 'not_found', '图片不存在。');
    const filename = path.join(uploadsDir, name);
    const stat = await fs.lstat(filename).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new ApiError(404, 'not_found', '图片不存在。');
    const real = await fs.realpath(filename);
    if (!real.startsWith(await fs.realpath(uploadsDir) + path.sep)) throw new ApiError(404, 'not_found', '图片不存在。');
    return { filename, size: stat.size };
  }
  async function validateAvatar(avatarUrl) {
    if (!avatarUrl) return;
    try { await mediaFile(avatarUrl.slice('/media/'.length)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new ApiError(422, 'validation_error', '所选头像不存在，请重新上传。');
      throw error;
    }
  }
  function getSession(request) {
    const claims = verifyJwt(readCookie(request), signingKey);
    if (!claims) return null;
    const id = sessionIdHash(claims.jti);
    const session = state.authSessions.find(item => item.idHash === id && item.accountId === claims.sub &&
      item.issuedAt === claims.iat && item.expiresAt === claims.exp);
    if (!session) return null;
    const user = state.accounts.find(account => account.id === session.accountId);
    if (!user) return null;
    return { id, session, user };
  }
  function authorize(request, { admin = false, editor = false, csrf = false } = {}) {
    const auth = getSession(request);
    if (!auth) throw new ApiError(401, 'login_required', '请先登录后再修改数据。');
    if (admin && auth.user.role !== 'admin') throw new ApiError(403, 'admin_required', '此操作仅限管理员。');
    if (editor && !['admin', 'editor'].includes(auth.user.role)) throw new ApiError(403, 'editor_required', '此操作仅限管理员或编辑者。');
    if (csrf && request.headers['x-csrf-token'] !== auth.session.csrfToken) {
      throw new ApiError(403, 'csrf_rejected', '登录验证已失效，请刷新后重试。');
    }
    return auth;
  }
  function appendAudit(next, request, auth, action, summary) {
    const ip = requestIp(request, trustProxy);
    next.auditLogs.push({
      id: randomUUID(), createdAt: new Date().toISOString(),
      username: auditText(auth.user?.username ?? auth.username ?? '', 80),
      role: ['admin', 'editor'].includes(auth.user?.role) ? auth.user.role : null,
      action, summary: auditText(summary, 500), ip, loginIp: auth.session?.loginIp || ip,
    });
    if (next.auditLogs.length > AUDIT_LIMIT) next.auditLogs.splice(0, next.auditLogs.length - AUDIT_LIMIT);
  }
  function logFailure(request, username, summary) {
    return mutate(next => appendAudit(next, request, { username }, 'login.failed', summary));
  }
  function participants(expense, current) {
    return expense.participantIds.map(id => current.members.find(member => member.id === id)?.name || '已删除成员').join('、') || '无';
  }
  function checkVersion(body, current) {
    if (!Number.isSafeInteger(body.version)) throw new ApiError(422, 'validation_error', '请提交当前数据版本。');
    if (body.version !== current.version) {
      throw new ApiError(409, 'version_conflict', '数据已被其他人修改，已为你载入最新数据，请重新操作。', { state: publicState(current) });
    }
  }
  function send(response, status, data, extraHeaders = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    response.end(JSON.stringify(data));
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;
      const method = request.method;
      if (!['GET', 'HEAD'].includes(method)) checkOrigin(request, publicOrigin);
      if (pathname === '/api/state' && method === 'GET') return send(response, 200, publicState(state));
      if (pathname === '/api/content' && method === 'GET') return send(response, 200, state.content);
      if (pathname === '/api/session' && method === 'GET') {
        const auth = getSession(request);
        return send(response, 200, auth ? { user: publicAccount(auth.user), csrfToken: auth.session.csrfToken } : { user: null });
      }
      if (pathname === '/api/login' && method === 'POST') {
        const body = await readJson(request);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const key = requestIp(request, trustProxy);
        let attempts = loginAttempts.get(key);
        if (!attempts || attempts.resetAt <= Date.now()) {
          attempts = { count: 0, blockedLogged: false, resetAt: Date.now() + 15 * 60 * 1000 };
          loginAttempts.set(key, attempts);
        }
        if (attempts.count >= 10) {
          // One limit event per IP/window prevents rejected traffic from rewriting
          // the entire state and evicting useful audit history indefinitely.
          if (!attempts.blockedLogged) {
            attempts.blockedLogged = true;
            try { await logFailure(request, username, '登录失败：尝试次数过多，已暂时限制登录'); }
            catch (error) { attempts.blockedLogged = false; throw error; }
          }
          response.setHeader('Retry-After', String(Math.ceil((attempts.resetAt - Date.now()) / 1000)));
          throw new ApiError(429, 'too_many_attempts', '登录尝试次数过多，请 15 分钟后重试。');
        }
        attempts.count += 1;
        if (username.length > 80 || password.length > 256) {
          await logFailure(request, username, '登录失败：账户或密码不正确');
          throw new ApiError(401, 'invalid_credentials', '账户或密码不正确。');
        }
        const account = state.accounts.find(item => item.username === username);
        const valid = await verifyPassword(password, account || dummyAccount);
        const currentLoginAccount = current => account && current.accounts.find(item => item.id === account.id &&
          item.username === username && item.salt === account.salt && item.hash === account.hash);
        if (!account || !valid || !currentLoginAccount(state)) {
          await logFailure(request, username, '登录失败：账户或密码不正确');
          throw new ApiError(401, 'invalid_credentials', '账户或密码不正确。');
        }
        const { token, claims } = issueJwt(signingKey, account.id);
        const csrfToken = randomBytes(24).toString('hex');
        const requireLoginAccount = current => {
          const latest = currentLoginAccount(current);
          if (!latest) throw new ApiError(401, 'invalid_credentials', '账户或密码不正确。');
          return latest;
        };
        const user = await mutate(next => {
          const latest = requireLoginAccount(next);
          const oldAuth = getSession(request);
          if (oldAuth) next.authSessions = next.authSessions.filter(session => session.idHash !== oldAuth.id);
          next.authSessions.push({ accountId: latest.id, idHash: sessionIdHash(claims.jti), csrfToken, loginIp: key, issuedAt: claims.iat, expiresAt: claims.exp });
          next.authSessions = pruneSessions(next.authSessions, next.accounts);
          appendAudit(next, request, { user: latest }, 'login.succeeded', '登录成功');
          return publicAccount(latest);
        }, () => requireLoginAccount(state), () => {
          loginAttempts.delete(key);
        });
        return send(response, 200, { user, csrfToken }, { 'Set-Cookie': cookie(token, request, publicOrigin) });
      }
      if (pathname === '/api/logout' && method === 'POST') {
        authorize(request, { csrf: true });
        await mutate(next => {
          const current = authorize(request, { csrf: true });
          appendAudit(next, request, current, 'logout', '退出登录');
          next.authSessions = next.authSessions.filter(session => session.idHash !== current.id);
        }, () => authorize(request, { csrf: true }));
        return send(response, 200, { user: null }, { 'Set-Cookie': cookie('', request, publicOrigin, 0) });
      }
      if (pathname === '/api/account/sessions' && method === 'GET') {
        const auth = authorize(request);
        const now = Math.floor(Date.now() / 1000);
        return send(response, 200, { sessions: state.authSessions.filter(session => session.accountId === auth.user.id && session.expiresAt > now).map(session => ({
          id: session.idHash, issuedAt: session.issuedAt, expiresAt: session.expiresAt, loginIp: session.loginIp, current: session.idHash === auth.id,
        })).reverse() });
      }
      const sessionMatch = pathname.match(/^\/api\/account\/sessions\/([a-f0-9]{64})$/);
      if ((pathname === '/api/account/sessions/revoke-all' && method === 'POST') || (sessionMatch && method === 'DELETE')) {
        authorize(request, { csrf: true });
        const result = await mutate(next => {
          const auth = authorize(request, { csrf: true });
          const all = pathname.endsWith('/revoke-all');
          const target = all ? null : next.authSessions.find(session => session.idHash === sessionMatch[1] && session.accountId === auth.user.id);
          if (!all && !target) throw new ApiError(404, 'not_found', '该登录会话不存在。');
          next.authSessions = next.authSessions.filter(session => session.accountId !== auth.user.id || (!all && session.idHash !== target.idHash));
          appendAudit(next, request, auth, all ? 'sessions.revoked' : 'session.revoked', all ? '退出本人全部设备' : '退出指定登录设备');
          return { sessionRevoked: all || target.idHash === auth.id };
        }, () => authorize(request, { csrf: true }));
        return send(response, 200, result, result.sessionRevoked ? { 'Set-Cookie': cookie('', request, publicOrigin, 0) } : {});
      }
      const resetPasswordMatch = pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/password$/);
      if ((pathname === '/api/account/password' || resetPasswordMatch) && method === 'POST') {
        const permission = { admin: Boolean(resetPasswordMatch), csrf: true };
        const auth = authorize(request, permission);
        const body = await readJson(request);
        knownKeys(body, resetPasswordMatch ? ['adminPassword', 'newPassword'] : ['currentPassword', 'newPassword'], '密码设置');
        const newPassword = requirePassword(body.newPassword);
        const submittedPassword = resetPasswordMatch ? body.adminPassword : body.currentPassword;
        const key = `${auth.user.id}:${requestIp(request, trustProxy)}`;
        let attempts = passwordAttempts.get(key);
        if (!attempts || attempts.resetAt <= Date.now()) {
          attempts = { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
          passwordAttempts.set(key, attempts);
        }
        if (attempts.count >= 10) {
          response.setHeader('Retry-After', String(Math.ceil((attempts.resetAt - Date.now()) / 1000)));
          throw new ApiError(429, 'too_many_attempts', '密码验证次数过多，请 15 分钟后重试。');
        }
        attempts.count += 1;
        const credentials = { id: auth.user.id, salt: auth.user.salt, hash: auth.user.hash };
        const requireCredentials = current => {
          const latest = authorize(request, permission);
          if (!current.accounts.some(account => account.id === credentials.id && account.salt === credentials.salt && account.hash === credentials.hash)) throw new ApiError(401, 'login_required', '账户已变更，请重新登录。');
          return latest;
        };
        if (typeof submittedPassword !== 'string' || submittedPassword.length > 256 || !await verifyPassword(submittedPassword, auth.user)) {
          await mutate(next => appendAudit(next, request, requireCredentials(next), 'password.failed', '密码操作失败：本人当前密码验证未通过'), () => requireCredentials(state));
          throw new ApiError(403, 'invalid_current_password', '本人当前密码不正确。');
        }
        requireCredentials(state);
        const targetId = resetPasswordMatch ? resetPasswordMatch[1] : auth.user.id;
        const targetBefore = state.accounts.find(account => account.id === targetId);
        if (!targetBefore) throw new ApiError(404, 'not_found', '该账户不存在。');
        if (await verifyPassword(newPassword, targetBefore)) throw new ApiError(422, 'password_unchanged', '新密码不能与原密码相同。');
        const record = await passwordRecord(newPassword);
        const result = await mutate(next => {
          const latestAuth = requireCredentials(next);
          const account = next.accounts.find(item => item.id === targetId);
          if (!account) throw new ApiError(404, 'not_found', '该账户不存在。');
          if (account.salt !== targetBefore.salt || account.hash !== targetBefore.hash) throw new ApiError(409, 'account_changed', '该账户密码已被修改，请重新操作。');
          Object.assign(account, record);
          next.authSessions = next.authSessions.filter(session => session.accountId !== account.id);
          appendAudit(next, request, latestAuth, resetPasswordMatch ? 'password.reset' : 'password.changed', resetPasswordMatch ? `重置账户「${account.username}」密码并退出该账户全部设备` : '修改本人密码并退出全部设备');
          return { sessionRevoked: account.id === latestAuth.user.id };
        }, () => requireCredentials(state), () => passwordAttempts.delete(key));
        return send(response, 200, result, result.sessionRevoked ? { 'Set-Cookie': cookie('', request, publicOrigin, 0) } : {});
      }
      if (pathname === '/api/admin/bill/reset' && method === 'POST') {
        const permission = { admin: true, csrf: true };
        authorize(request, permission);
        const body = await readJson(request);
        knownKeys(body, ['version'], '账单');
        const result = await mutate(next => {
          const auth = authorize(request, permission);
          checkVersion(body, next);
          const expenseCount = next.expenses.length, advanceCount = next.advances.length;
          next.expenses = [];
          next.advances = [];
          next.currentGathering = newGathering(next.currentGathering.name);
          next.version += 1;
          appendAudit(next, request, auth, 'bill.cleared', `清空本次账单（${expenseCount} 道菜品或费用、${advanceCount} 笔垫付），保留全部 ${next.members.length} 位成员`);
          return 'public';
        }, () => authorize(request, permission));
        return send(response, 200, result);
      }
      const advanceMatch = pathname.match(/^\/api\/admin\/advances\/([^/]+)$/);
      if ((pathname === '/api/admin/advances' && method === 'POST') || (advanceMatch && ['PATCH', 'DELETE'].includes(method))) {
        const permission = { admin: method === 'DELETE', editor: true, csrf: true };
        authorize(request, permission);
        const body = await readJson(request);
        knownKeys(body, method === 'DELETE' ? ['version'] : ['version', 'expenseId', 'memberId', 'amountCents', 'note'], '垫付');
        const result = await mutate(next => {
          const auth = authorize(request, permission);
          checkVersion(body, next);
          const existing = advanceMatch ? next.advances.find(item => item.id === advanceMatch[1]) : null;
          if (advanceMatch && !existing) throw new ApiError(404, 'not_found', '该笔垫付不存在。');
          if (method === 'DELETE') {
            next.advances = next.advances.filter(item => item.id !== existing.id);
            appendAudit(next, request, auth, 'advance.deleted', `删除垫付记录（${money(existing.amountCents)}）`);
          } else {
            const fields = { ...existing, ...body };
            const expense = next.expenses.find(item => item.id === fields.expenseId);
            const member = next.members.find(item => item.id === fields.memberId);
            if (!expense || !member || !Number.isSafeInteger(fields.amountCents) || fields.amountCents <= 0 || fields.amountCents > MAX_AMOUNT_CENTS) throw new ApiError(422, 'validation_error', '请选择有效费用、垫付人及大于零的垫付金额。');
            const note = fields.note === undefined ? '' : requireText(fields.note, '垫付备注', 0, 120);
            if (/[\u0000-\u001f\u007f]/.test(note)) throw new ApiError(422, 'validation_error', '垫付备注包含无效控制字符。');
            const paid = next.advances.filter(item => item.expenseId === expense.id && item.id !== existing?.id).reduce((sum, item) => sum + item.amountCents, 0);
            if (paid + fields.amountCents > expense.amountCents) throw new ApiError(422, 'advance_exceeds_expense', '该笔费用的垫付合计不能超过费用金额。');
            if (!existing && next.advances.length >= 1000) throw new ApiError(422, 'advance_limit', '每次聚餐最多支持 1000 笔垫付。');
            const record = { id: existing?.id ?? randomUUID(), expenseId: expense.id, memberId: member.id, amountCents: fields.amountCents, note, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
            if (existing) Object.assign(existing, record); else next.advances.push(record);
            appendAudit(next, request, auth, existing ? 'advance.updated' : 'advance.created', `${existing ? '修改' : '记录'}「${expense.title}」由「${member.name}」垫付 ${money(record.amountCents)}`);
          }
          next.version += 1;
          return 'public';
        }, () => authorize(request, permission));
        return send(response, method === 'POST' ? 201 : 200, result);
      }
      if (pathname === '/api/admin/logs' && method === 'GET') {
        authorize(request, { admin: true });
        const limitText = url.searchParams.get('limit') ?? '50';
        const before = url.searchParams.get('before');
        if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > 100 ||
            (before !== null && !EVENT_ID.test(before)) ||
            [...url.searchParams.keys()].some(key => !['limit', 'before'].includes(key)) ||
            url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('before').length > 1) {
          throw new ApiError(422, 'validation_error', '日志每页数量应为 1–100，且分页标记应为有效的日志 ID。');
        }
        const end = before === null ? state.auditLogs.length : state.auditLogs.findIndex(event => event.id === before);
        if (end < 0) throw new ApiError(422, 'invalid_cursor', '该分页记录已不存在，请刷新日志。');
        const start = Math.max(0, end - Number(limitText));
        const logs = state.auditLogs.slice(start, end).reverse();
        return send(response, 200, { logs, hasMore: start > 0, nextBefore: start > 0 ? logs.at(-1).id : null });
      }
      if (pathname === '/api/admin/content' && method === 'PATCH') {
        authorize(request, { admin: true, csrf: true });
        const body = await readJson(request);
        const content = await mutate(async next => {
          authorize(request, { admin: true, csrf: true });
          const updated = contentPatch(body, next.content);
          for (const image of Object.values(updated.images)) if (image.src.startsWith('/media/')) {
            try { await mediaFile(image.src.slice('/media/'.length)); }
            catch (error) {
              if (error instanceof ApiError && error.status === 404) throw new ApiError(422, 'validation_error', '所选图片不存在，请重新上传。');
              throw error;
            }
          }
          authorize(request, { admin: true, csrf: true });
          next.content = updated;
          const textFields = Object.keys(body.texts || {}).map(key => CONTENT_TEXT_FIELDS.find(field => field.key === key).label);
          const imageFields = Object.keys(body.images || {}).map(key => CONTENT_IMAGE_FIELDS.find(field => field.key === key).label);
          appendAudit(next, request, authorize(request, { admin: true, csrf: true }), 'content.updated', `修改页面：${[...textFields, ...imageFields].join('、') || '页面设置'}`);
          return updated;
        }, () => authorize(request, { admin: true, csrf: true }));
        return send(response, 200, content);
      }
      if (['/api/admin/images', '/api/member-avatars'].includes(pathname) && method === 'POST') {
        const avatar = pathname === '/api/member-avatars';
        const permission = { admin: !avatar, editor: avatar, csrf: true };
        const authorizeUpload = () => {
          const auth = authorize(request, permission);
          return auth;
        };
        authorizeUpload();
        const { bytes, mimeType, extension } = await readImage(request);
        let filename;
        let uploaded;
        try {
          uploaded = await mutate(async next => {
            authorizeUpload();
            const name = `${randomUUID()}.${extension}`;
            filename = path.join(uploadsDir, name);
            const temporary = path.join(uploadsDir, `.${name}.tmp`);
            try {
              await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
              authorizeUpload();
              await fs.rename(temporary, filename);
              const auth = authorizeUpload();
              appendAudit(next, request, auth, avatar ? 'avatar.uploaded' : 'image.uploaded', `上传${avatar ? '成员头像' : '页面图片'}（${mimeType}）`);
              return { url: `/media/${name}`, mimeType };
            } finally {
              await fs.unlink(temporary).catch(() => {});
            }
          }, authorizeUpload);
        } catch (error) {
          if (filename) await fs.unlink(filename).catch(() => {});
          throw error;
        }
        return send(response, 201, uploaded);
      }
      if (pathname === '/api/admin/expenses' && method === 'POST') {
        authorize(request, { editor: true, csrf: true });
        const body = await readJson(request);
        knownKeys(body, ['version', 'title', 'amountCents', 'participantIds'], '费用');
        const result = await mutate(next => {
          authorize(request, { editor: true, csrf: true });
          checkVersion(body, next);
          if (next.expenses.length >= 100) throw new ApiError(422, 'expense_limit', '最多支持 100 笔费用。');
          const title = expenseTitle(body.title);
          const allocation = expenseAllocation({ amountCents: 0, participantIds: [], ...body }, next);
          next.expenses.push({ id: randomUUID(), title, note: '', icon: 'dinner', ...allocation });
          appendAudit(next, request, authorize(request, { editor: true, csrf: true }), 'expense.created', `新增费用「${title}」，金额 ${money(allocation.amountCents)}，参与人：${participants(allocation, next)}`);
          next.version += 1;
          return 'public';
        }, () => authorize(request, { editor: true, csrf: true }));
        return send(response, 201, result);
      }
      const adminExpenseMatch = pathname.match(/^\/api\/admin\/expenses\/([^/]+)$/);
      if (adminExpenseMatch && ['PATCH', 'DELETE'].includes(method)) {
        const permission = { admin: method === 'DELETE', editor: true, csrf: true };
        authorize(request, permission);
        const body = await readJson(request);
        knownKeys(body, method === 'PATCH' ? ['version', 'title', 'amountCents', 'participantIds'] : ['version'], '费用');
        const result = await mutate(next => {
          authorize(request, permission);
          checkVersion(body, next);
          const expense = next.expenses.find(item => item.id === adminExpenseMatch[1]);
          if (!expense) throw new ApiError(404, 'not_found', '该笔费用不存在。');
          const oldTitle = expense.title;
          if (method === 'PATCH') {
            if (body.title === undefined && body.amountCents === undefined && body.participantIds === undefined) throw new ApiError(422, 'validation_error', '请提供需要修改的菜品名称、金额或参与人。');
            const title = body.title === undefined ? expense.title : expenseTitle(body.title);
            const allocation = expenseAllocation({ amountCents: expense.amountCents, participantIds: expense.participantIds, ...body }, next);
            if (next.advances.filter(item => item.expenseId === expense.id).reduce((sum, item) => sum + item.amountCents, 0) > allocation.amountCents) throw new ApiError(422, 'advance_exceeds_expense', '费用金额不能低于已记录的垫付合计，请先调整垫付记录。');
            const oldAmount = expense.amountCents, oldParticipants = participants(expense, next);
            Object.assign(expense, { title, ...allocation });
            appendAudit(next, request, authorize(request, permission), 'expense.updated', `修改菜品或费用「${oldTitle}」→「${title}」：金额 ${money(oldAmount)} → ${money(expense.amountCents)}；参与人 ${oldParticipants} → ${participants(expense, next)}`);
          } else {
            if (next.advances.some(item => item.expenseId === expense.id)) throw new ApiError(422, 'advance_exists', '该费用已有垫付记录，请先删除相关垫付记录。');
            next.expenses = next.expenses.filter(item => item.id !== expense.id);
            appendAudit(next, request, authorize(request, permission), 'expense.deleted', `删除费用「${oldTitle}」（${money(expense.amountCents)}）`);
          }
          next.version += 1;
          return 'public';
        }, () => authorize(request, permission));
        return send(response, 200, result);
      }
      const expenseMatch = pathname.match(/^\/api\/expenses\/([^/]+)$/);
      if (expenseMatch && method === 'PATCH') {
        authorize(request, { csrf: true });
        const body = await readJson(request);
        const result = await mutate(next => {
          authorize(request, { csrf: true });
          checkVersion(body, next);
          const expense = next.expenses.find(item => item.id === expenseMatch[1]);
          if (!expense) throw new ApiError(404, 'not_found', '该笔费用不存在。');
          const oldAmount = expense.amountCents;
          const oldParticipants = participants(expense, next);
          const allocation = expenseAllocation(body, next);
          if (next.advances.filter(item => item.expenseId === expense.id).reduce((sum, item) => sum + item.amountCents, 0) > allocation.amountCents) throw new ApiError(422, 'advance_exceeds_expense', '费用金额不能低于已记录的垫付合计，请先调整垫付记录。');
          Object.assign(expense, allocation);
          appendAudit(next, request, authorize(request, { csrf: true }), 'expense.updated', `修改费用「${expense.title}」：金额 ${money(oldAmount)} → ${money(expense.amountCents)}；参与人 ${oldParticipants} → ${participants(expense, next)}`);
          next.version += 1;
          return 'public';
        }, () => authorize(request, { csrf: true }));
        return send(response, 200, result);
      }
      if (pathname === '/api/admin/members' && method === 'POST') {
        authorize(request, { editor: true, csrf: true });
        const body = await readJson(request);
        const result = await mutate(async next => {
          authorize(request, { editor: true, csrf: true });
          checkVersion(body, next);
          if (next.members.length >= 100) throw new ApiError(422, 'member_limit', '最多支持 100 位分摊人。');
          const fields = memberFields(body);
          await validateAvatar(fields.avatarUrl);
          next.members.push({ id: randomUUID(), ...fields, order: Math.max(-1, ...next.members.map(member => member.order)) + 1 });
          appendAudit(next, request, authorize(request, { editor: true, csrf: true }), 'member.created', `新增聚餐成员「${fields.name}」${fields.avatarUrl ? '，设置头像' : ''}`);
          next.version += 1;
          return 'public';
        }, () => authorize(request, { editor: true, csrf: true }));
        return send(response, 201, result);
      }
      const memberMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)$/);
      if (memberMatch && ['PATCH', 'DELETE'].includes(method)) {
        const permission = { admin: method === 'DELETE', editor: true, csrf: true };
        authorize(request, permission);
        const body = await readJson(request);
        const result = await mutate(async next => {
          authorize(request, permission);
          checkVersion(body, next);
          const member = next.members.find(item => item.id === memberMatch[1]);
          if (!member) throw new ApiError(404, 'not_found', '该人物不存在。');
          const oldName = member.name;
          const changedFields = [];
          if (method === 'PATCH') {
            const fields = memberFields(body, member);
            const labels = { name: '姓名', note: '备注', color: '颜色', avatarUrl: '头像' };
            for (const key of Object.keys(labels)) if (fields[key] !== member[key]) changedFields.push(key === 'name' ? `姓名「${member.name}」→「${fields.name}」` : labels[key]);
            await validateAvatar(fields.avatarUrl);
            Object.assign(member, fields);
          }
          else {
            if (next.advances.some(item => item.memberId === member.id)) throw new ApiError(422, 'advance_exists', '此成员已有垫付记录，请先删除相关垫付记录。');
            const stranded = next.expenses.find(expense => expense.amountCents > 0 && expense.participantIds.length === 1 && expense.participantIds[0] === member.id);
            if (stranded) throw new ApiError(422, 'expense_needs_member', `请先为「${stranded.title}」指定其他分摊人，再删除此人物。`);
            next.members = next.members.filter(item => item.id !== member.id);
            next.expenses.forEach(expense => { expense.participantIds = expense.participantIds.filter(id => id !== member.id); });
          }
          appendAudit(next, request, authorize(request, permission), method === 'PATCH' ? 'member.updated' : 'member.deleted', method === 'PATCH' ? `修改聚餐成员「${oldName}」：${changedFields.join('、') || '保存成员信息'}` : `删除聚餐成员「${oldName}」`);
          next.version += 1;
          return 'public';
        }, () => authorize(request, permission));
        return send(response, 200, result);
      }
      if (pathname === '/api/admin/accounts' && method === 'GET') {
        authorize(request, { admin: true });
        return send(response, 200, { accounts: state.accounts.map(publicAccount) });
      }
      if (pathname === '/api/admin/accounts' && method === 'POST') {
        authorize(request, { admin: true, csrf: true });
        const body = await readJson(request);
        const username = accountUsername(body.username);
        if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new ApiError(422, 'validation_error', '密码长度应为 8–256 个字符。');
        if (!['admin', 'editor'].includes(body.role)) throw new ApiError(422, 'validation_error', '请选择管理员或编辑者角色。');
        const record = await passwordRecord(body.password);
        const result = await mutate(next => {
          authorize(request, { admin: true, csrf: true });
          if (next.accounts.some(account => account.username.toLowerCase() === username.toLowerCase())) throw new ApiError(409, 'username_exists', '该账户名已存在。');
          if (next.accounts.length >= 100) throw new ApiError(422, 'account_limit', '最多支持 100 个账户。');
          next.accounts.push({ id: randomUUID(), username, role: body.role, ...record });
          appendAudit(next, request, authorize(request, { admin: true, csrf: true }), 'account.created', `新增账户「${username}」（${body.role === 'admin' ? '管理员' : '编辑者'}）`);
          return { accounts: next.accounts.map(publicAccount) };
        }, () => authorize(request, { admin: true, csrf: true }));
        return send(response, 201, result);
      }
      const accountMatch = pathname.match(/^\/api\/admin\/accounts\/([^/]+)$/);
      if (accountMatch && method === 'PATCH') {
        authorize(request, { admin: true, csrf: true });
        const body = await readJson(request);
        knownKeys(body, ['username', 'role'], '账户');
        if (!Object.keys(body).length) throw new ApiError(422, 'validation_error', '请提供需要修改的账户名或权限。');
        const username = body.username === undefined ? undefined : accountUsername(body.username);
        if (body.role !== undefined && !['admin', 'editor'].includes(body.role)) throw new ApiError(422, 'validation_error', '请选择管理员或编辑者角色。');
        const result = await mutate(next => {
          const auth = authorize(request, { admin: true, csrf: true });
          const account = next.accounts.find(item => item.id === accountMatch[1]);
          if (!account) throw new ApiError(404, 'not_found', '该账户不存在。');
          const nextUsername = username ?? account.username;
          const nextRole = body.role ?? account.role;
          if (next.accounts.some(item => item.id !== account.id && item.username.toLowerCase() === nextUsername.toLowerCase())) throw new ApiError(409, 'username_exists', '该账户名已存在。');
          if (account.role === 'admin' && nextRole !== 'admin' && next.accounts.filter(item => item.role === 'admin').length <= 1) throw new ApiError(422, 'last_admin', '至少需要保留一个管理员账户。');
          const changes = [];
          if (account.username !== nextUsername) changes.push(`账户名「${account.username}」→「${nextUsername}」`);
          if (account.role !== nextRole) changes.push(`权限${account.role === 'admin' ? '管理员' : '编辑者'} → ${nextRole === 'admin' ? '管理员' : '编辑者'}`);
          const changed = changes.length > 0;
          if (changed) {
            account.username = nextUsername;
            account.role = nextRole;
            next.authSessions = next.authSessions.filter(session => session.accountId !== account.id);
            appendAudit(next, request, auth, 'account.updated', `修改账户「${account.username}」：${changes.join('；')}`);
          }
          return { account: publicAccount(account), sessionRevoked: changed && account.id === auth.user.id };
        }, () => authorize(request, { admin: true, csrf: true }));
        return send(response, 200, result, result.sessionRevoked ? { 'Set-Cookie': cookie('', request, publicOrigin, 0) } : {});
      }
      if (accountMatch && method === 'DELETE') {
        authorize(request, { admin: true, csrf: true });
        const result = await mutate(next => {
          const auth = authorize(request, { admin: true, csrf: true });
          const account = next.accounts.find(item => item.id === accountMatch[1]);
          if (!account) throw new ApiError(404, 'not_found', '该账户不存在。');
          if (account.id === auth.user.id) throw new ApiError(422, 'current_account', '不能删除当前登录账户。');
          if (account.role === 'admin' && next.accounts.filter(item => item.role === 'admin').length <= 1) throw new ApiError(422, 'last_admin', '至少需要保留一个管理员账户。');
          next.accounts = next.accounts.filter(item => item.id !== account.id);
          next.authSessions = next.authSessions.filter(session => session.accountId !== account.id);
          appendAudit(next, request, auth, 'account.deleted', `删除账户「${account.username}」（${account.role === 'admin' ? '管理员' : '编辑者'}）`);
          return { accounts: next.accounts.map(publicAccount) };
        }, () => authorize(request, { admin: true, csrf: true }));
        return send(response, 200, result);
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404, 'not_found', '接口不存在。');
      if (!['GET', 'HEAD'].includes(method)) throw new ApiError(405, 'method_not_allowed', '不支持此请求方式。');
      if (pathname.startsWith('/media/')) {
        const { filename, size } = await mediaFile(pathname.slice('/media/'.length));
        response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)], 'Content-Length': size, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return response.end(method === 'HEAD' ? undefined : await fs.readFile(filename));
      }
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'bad_path', '无效的文件路径。'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(segment => segment.startsWith('.'))) {
        throw new ApiError(404, 'not_found', '文件不存在。');
      }
      const filename = path.resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!filename.startsWith(publicDir + path.sep)) throw new ApiError(404, 'not_found', '文件不存在。');
      const stat = await fs.stat(filename).catch(() => null);
      if (!stat?.isFile()) throw new ApiError(404, 'not_found', '文件不存在。');
      const real = await fs.realpath(filename);
      if (!real.startsWith(await fs.realpath(publicDir) + path.sep)) throw new ApiError(404, 'not_found', '文件不存在。');
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(method === 'HEAD' ? undefined : await fs.readFile(filename));
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof ApiError) return send(response, error.status, { error: error.error, message: error.message, ...error.extra });
      console.error('Request failed:', error.message);
      return send(response, 500, { error: 'internal_error', message: '服务暂时无法完成操作，请稍后重试。' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const cleanup = setInterval(() => {
    const now = Date.now();
    if (state.authSessions.some(session => session.expiresAt <= Math.floor(now / 1000))) {
      mutate(() => {}).catch(error => console.error('Session cleanup failed:', error.message));
    }
    for (const attemptsMap of [loginAttempts, passwordAttempts]) for (const [key, attempts] of attemptsMap) if (attempts.resetAt <= now) attemptsMap.delete(key);
  }, 60_000);
  cleanup.unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须为 1–65535 之间的整数。');
    process.exit(1);
  }
  const host = process.env.HOST || '127.0.0.1';
  const server = await createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT 后重试。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Local: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
