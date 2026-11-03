import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const WINDOW = 15 * 60_000;
const CAPACITY = 5000;
const POLICY = { ip: { limit: 5, window: WINDOW }, account: { limit: 10, window: WINDOW }, global: { limit: 60, window: 60_000 } };

// Reserve before password hashing so concurrent requests cannot race the budget.
// Persist separately from the ledger; restarting must not reset a failed-login lock.
export async function createLoginLimiter(dataDir, { now = Date.now } = {}) {
  const filename = path.join(dataDir, 'login-limits.json');
  let buckets = {};
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('登录限流文件格式无效。');
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (saved.schema !== 1 || !Array.isArray(saved.buckets) || saved.buckets.length > CAPACITY) throw new Error('登录限流文件格式无效。');
    for (const entry of saved.buckets) {
      if (!entry || !/^(ip|account|global):[a-f0-9]{64}$/.test(entry.key) || !Number.isSafeInteger(entry.count) || entry.count < 0 || !Number.isSafeInteger(entry.resetAt) || typeof entry.blockedLogged !== 'boolean') throw new Error('登录限流文件格式无效。');
      if (entry.resetAt > now()) buckets[entry.key] = entry;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let queue = Promise.resolve();
  const enqueue = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  const keyFor = (kind, value) => `${kind}:${createHash('sha256').update(value).digest('hex')}`;
  async function save(next) {
    const temporary = path.join(dataDir, `.login-limits-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ schema: 1, buckets: Object.values(next) }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
      buckets = next;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return {
    reserve(ip, username) { return enqueue(async () => {
      const time = now();
      const next = Object.fromEntries(Object.entries(buckets).filter(([, entry]) => entry.resetAt > time));
      const keys = [keyFor('ip', ip), keyFor('account', username.toLowerCase()), keyFor('global', 'all')];
      const blocked = keys.map(key => next[key]).filter(Boolean).find(entry => entry.count >= POLICY[entry.key.split(':')[0]].limit);
      if (blocked || Object.keys(next).length + keys.filter(key => !next[key]).length > CAPACITY) {
        const resetAt = blocked?.resetAt || Math.min(...Object.values(next).map(entry => entry.resetAt));
        const logBlocked = Boolean(blocked && !blocked.blockedLogged);
        if (logBlocked) { next[blocked.key] = { ...blocked, blockedLogged: true }; await save(next); }
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - time) / 1000)), logBlocked };
      }
      const receipt = keys.map(key => {
        const kind = key.split(':')[0], entry = next[key] || { key, count: 0, resetAt: time + POLICY[kind].window, blockedLogged: false };
        next[key] = { ...entry, count: entry.count + 1 };
        return { key, resetAt: next[key].resetAt };
      });
      await save(next);
      return { allowed: true, receipt };
    }); },
    succeeded(receipt) { return enqueue(async () => {
      const next = structuredClone(buckets);
      for (const { key, resetAt } of receipt) {
        // Successful authentication releases only its own reservation; it must
        // never clear earlier failures or the global CPU protection budget.
        const entry = next[key];
        if (!key.startsWith('global:') && entry?.resetAt === resetAt) {
          if (entry.count <= 1) delete next[key]; else entry.count--;
        }
      }
      await save(next);
    }); },
  };
}
