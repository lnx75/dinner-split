import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_VERSION, RELEASES } from '../public/releases.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value) {
  if (typeof value !== 'string' || !versionPattern.test(value)) {
    throw new Error(`版本号必须为无前导零的三段整数：${value}`);
  }
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error(`版本号超出安全整数范围：${value}`);
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export async function checkVersion() {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  parseVersion(manifest.version);
  if (!Array.isArray(RELEASES) || RELEASES.length === 0) throw new Error('发布记录不能为空');
  if (manifest.version !== CURRENT_VERSION || CURRENT_VERSION !== RELEASES[0].version) {
    throw new Error('package.json 版本必须与最新发布记录及当前展示版本一致');
  }

  const seen = new Set();
  let previous;
  for (const release of RELEASES) {
    const parts = parseVersion(release.version);
    if (seen.has(release.version)) throw new Error(`发布记录的版本号重复：${release.version}`);
    seen.add(release.version);
    if (!validDate(release.date)) throw new Error(`发布日期无效：${release.version}`);
    if (typeof release.title !== 'string' || !release.title.trim() || !Array.isArray(release.changes) || !release.changes.length || release.changes.some(change => typeof change !== 'string' || !change.trim())) {
      throw new Error(`发布说明不完整：${release.version}`);
    }
    if (previous && compareVersions(previous.parts, parts) <= 0) throw new Error('发布记录必须按版本号从新到旧排列');
    if (previous && previous.date < release.date) throw new Error('发布记录日期必须从新到旧排列，最新版本必须使用最新发布日期');
    previous = { parts, date: release.date };
  }
  console.log(`版本检查通过：${CURRENT_VERSION}，${RELEASES.length} 条发布记录`);
}

const invokedFile = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedFile === fileURLToPath(import.meta.url)) await checkVersion();
