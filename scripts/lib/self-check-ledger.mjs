// scripts/lib/self-check-ledger.mjs —— 仓库自检（dao-check）的结果账：跑过一次就记一条，读的人不用再跑。
//
// 为什么有这一层（2026-09-20）：server-check ⑪ 原来是「嵌套再跑一遍 dao-check、60s 预算」，
// 预算的前提（#984：dao-check ~15s）早烂了——服务器实跑 91s——于是 ⑪ 几周来每次都是
// 「60s 超时 → unknown」：烧 60 秒、产出零信息，还把「其实是红」盖成「没查成」。
// 改成：dao-check 自己在出口写一条账（本文件 write），⑪ 只读账（本文件 read）并要求账上的
// HEAD 等于本树当前 HEAD——对不上就是「自检还没跟上这次合并」，不是绿。
//
// 账落 ~/.dao/dao-check/<root 摘要>.json（派生数据不进 git；一树一文件，几棵 worktree 各记各的，
// 不互相覆盖）。写是 best-effort：账写不进去不许把 dao-check 本身弄红。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一树一文件：root 取 realpath 再摘要，同一棵树不管从哪条路径进来都落同一份。 */
export function ledgerPathFor(root, home = homedir()) {
  let real = root;
  try { real = realpathSync(root); } catch { /* 树不存在也给出确定的路径，读的人会判 unknown */ }
  const key = createHash('sha1').update(String(real)).digest('hex').slice(0, 12);
  return join(home, '.dao', 'dao-check', `${key}.json`);
}

/** dao-check 出口调用。record 至少含 { root, head, code, ms, red, green, skip }；ts 由这里补。 */
export function writeSelfCheckRecord(record, { home = homedir() } = {}) {
  const path = ledgerPathFor(record.root, home);
  try {
    mkdirSync(join(home, '.dao', 'dao-check'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...record }, null, 2) + '\n');
    return { ok: true, path };
  } catch (e) {
    return { ok: false, path, reason: e.code || e.message };
  }
}

/**
 * 账的 schema（写方约定，读方独立复核——残缺/伪造的账不许变成绿或红，只能是「没样本」）。
 * 返回问题清单；空数组 = 合格。
 */
export function recordProblems(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['不是对象'];
  const bad = [];
  if (!/^[0-9a-f]{40}$/.test(String(record.head ?? ''))) bad.push('head 不是 40 位 sha');
  if (!Number.isInteger(record.code) || record.code < 0) bad.push('code 不是非负整数');
  if (!Number.isFinite(record.ms) || record.ms < 0) bad.push('ms 不是非负数');
  for (const k of ['red', 'green', 'skip']) {
    if (!Number.isInteger(record[k]) || record[k] < 0) bad.push(`${k} 不是非负整数`);
  }
  if (typeof record.ts !== 'string' || !Number.isFinite(Date.parse(record.ts))) bad.push('ts 不是可解析时间');
  if (typeof record.root !== 'string' || !record.root) bad.push('root 缺失');
  return bad;
}

/** 三态读：文件不在 → probed:false（没样本）；JSON 坏 / schema 不合 → probed:false；否则 record。 */
export function readSelfCheckRecord(root, { home = homedir() } = {}) {
  const path = ledgerPathFor(root, home);
  if (!existsSync(path)) return { probed: false, path, reason: `账不存在（${path}）——这棵树上 dao-check 还没跑过` };
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    return { probed: false, path, reason: `账读不了：${e.message}` };
  }
  const problems = recordProblems(record);
  if (problems.length) return { probed: false, path, reason: `账不是 dao-check 写的完整格式（${problems.join('；')}）——当没样本` };
  return { probed: true, path, record };
}
