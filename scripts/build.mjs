import { mkdir, readdir, rm, cp, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersion } from './check-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = [
  'server.mjs', 'auth.mjs', 'public', 'scripts', 'tests', 'package.json',
  'README.md', 'VERSIONING.md', 'LICENSE', 'SECURITY.md',
  'Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', '.gitignore',
  '启动分账工具.command', '启动分账工具.bat',
];
await checkVersion();
async function check(entry) {
  const full = path.join(root, entry);
  const { stat } = await import('node:fs/promises');
  if ((await stat(full)).isDirectory()) {
    for (const file of await readdir(full)) await check(path.join(entry, file));
  } else if (/\.(m?js)$/.test(entry)) {
    const result = spawnSync(process.execPath, ['--check', full], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`语法检查失败：${entry}`);
  }
}
for (const entry of sourcePaths) {
  await access(path.join(root, entry));
  await check(entry);
}
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of sourcePaths) await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
console.log('构建完成：dist/（完整可运行项目，不含运行数据）');
