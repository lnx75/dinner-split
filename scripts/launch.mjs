import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let opened = false;
server.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  const url = chunk.toString().match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/)?.[0];
  if (url && !opened) {
    opened = true;
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`请在浏览器打开 ${url}`));
    browser.unref();
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
