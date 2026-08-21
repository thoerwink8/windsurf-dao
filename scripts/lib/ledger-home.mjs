// scripts/lib/ledger-home.mjs —— 账本本机落点（ledger 本机化拍板：事件不进 git）
//
// 写落点 = 本机 ~/.dao/ledger/events/（LEDGER_EVENTS_DIR 可覆盖，测试/排障用）。
// 仓内 ledger/events/ 里已合并的历史事件保留不动，当种子：第一次用账本命令时
// 复制到本机落点（幂等，同名跳过——文件名 <ulid>-<machine>.json 由事件内容决定，
// 同名即同一事件，跳过安全）。跨机汇聚不走 git，方向是 dao-hub 按需拉取
// （见 docs/dianjiangtai-design.md A 节；机制未实现前，要带走旧机事件就手动拷目录）。

import os from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 本机账本目录：LEDGER_EVENTS_DIR 覆盖优先，否则 <home>/.dao/ledger/events。 */
export function defaultLedgerDir({ home = os.homedir(), env = process.env } = {}) {
  const override = env && env.LEDGER_EVENTS_DIR;
  if (override) return { dir: resolve(override), overridden: true };
  return { dir: join(home, '.dao', 'ledger', 'events'), overridden: false };
}

/** 把 source 里缺失的事件文件拷进 dir（同名跳过）。source 不在 = 没种子可播，不是错。 */
export function seedLedgerDir({ dir, source } = {}) {
  const out = { seeded: 0, skipped: 0, sourceFound: false, source: source || null };
  if (!source || !existsSync(source)) return out;
  out.sourceFound = true;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source)) {
    if (!name.endsWith('.json')) continue;
    const to = join(dir, name);
    if (existsSync(to)) {
      out.skipped += 1;
      continue;
    }
    copyFileSync(join(source, name), to);
    out.seeded += 1;
  }
  return out;
}

/**
 * 账本命令的默认落点：建目录 + 播种子后返回。
 * 显式覆盖（LEDGER_EVENTS_DIR）时不播种子——覆盖方自己负责目录内容（测试依赖这点）。
 */
export function ensureLocalLedger({ root, home, env } = {}) {
  const { dir, overridden } = defaultLedgerDir({ home, env });
  mkdirSync(dir, { recursive: true });
  const source = root ? join(root, 'ledger', 'events') : null;
  const seed = overridden
    ? { seeded: 0, skipped: 0, sourceFound: false, source }
    : seedLedgerDir({ dir, source });
  return { dir, overridden, ...seed };
}
