#!/usr/bin/env node
// scripts/test-impact-map.mjs —— 查「测试 → 它碰过哪些本仓文件」的影响地图
//
// 判据与设计前提在 scripts/lib/test-impact.mjs 头部。
//
// **本文件不再建图**（2026-09-06 用户拍板，整段删掉「预建地图」这个机制）。
// 原来这里有 `build`（逐套跑测试采覆盖率，实测 1 分 50 秒）和 `health`（健康度判定）。
// 两个一起构成了一笔税：每加一个测试文件，图就被判成不健康，下一个人得先付 110 秒才能继续。
// 实测代价是帅位一轮里为它烧掉 5.5 分钟，然后干脆退回全量档——**快档越贵，人越不用快档**。
//
// 现在地图是 `dao-check` 跑测试时的副产物（跑哪套采哪套，实测只贵 8%），
// 而「不在图里」由 affectedTests 规则 ④ 兜住：不知道就跑。于是不需要建、也不需要判健康。
//
// 用法只剩一个：
//   node scripts/test-impact-map.mjs show           打印地图概况（排查用）

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedTests, MAP_VERSION } from './lib/test-impact.mjs';

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), '..');

// 地图是**本机派生数据，不进 git**（2026-09-06 用户拍板，照行业通行做法改回来）。
//
// 首版提交进了仓里，两条都踩：
//  · Nx/Bazel 提交的是「声明」（BUILD 文件），依赖图每次现算；Datadog/Azure 的覆盖率式
//    TIA 确实要存，但存在服务端/流水线产物里，键在基线分支的那次跑，**不在版本库**。
//  · 更打脸的是本仓自己的判例：`gen-index.mjs` 开头写着「MEMORY.md 是这个仓唯一的
//    并发冲突点——两位主帅各写各的不会撞，撞的永远是这个共用索引」。
//    66KB 的派生 JSON 提交进去就是第二个，而且它没法人工合并。
//
// 落 `~/.dao/test-impact/`，与 provider-health.json / preflight / ledger 同类。
// CI 是全新 clone，没有地图 ⇒ affected 自动退全量——**这正是已拍板的分层**（CI 全量、本地快档），
// 不需要额外机制去保证 CI 拿到地图。
export const MAP_PATH = process.env.DAO_IMPACT_MAP
  || join(homedir(), '.dao', 'test-impact', 'map.json');

export function listTests(root = REPO_ROOT) {
  const dir = join(root, 'tests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.test\.(js|mjs|cjs)$/i.test(f)).sort().map((f) => `tests/${f}`);
}

export function readMap(p = MAP_PATH) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function gitOut(args, root = REPO_ROOT) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

function cmdShow() {
  const map = readMap();
  if (!map) { console.error(`地图不在：${MAP_PATH}`); return 1; }
  const n = Object.keys(map.entries || {}).length;
  console.log(`版本 ${map.version} / 建于 ${map.builtAt} / HEAD ${String(map.head).slice(0, 8)} / ${n} 套`);
  const rank = Object.entries(map.entries).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  for (const [t, s] of rank) console.log(`  ${String(s.length).padStart(3)} 依赖  ${t}`);
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'show';
  if (cmd === 'show') return cmdShow();
  // build / health 已删（2026-09-06）：地图改成 dao-check 跑测试的副产物，不再需要建、也不判健康。
  // 老调用会打到这里——明说去哪，别只回一句「用法」让人以为敲错了。
  if (cmd === 'build' || cmd === 'health') {
    console.error(`${cmd} 已删：影响地图现在是 dao-check 跑测试时的副产物，不用建、也不判健康。`);
    console.error('要让图变全：跑一次 node scripts/dao-check.mjs --full（顺手把每套的依赖都采一遍）。');
    return 2;
  }
  console.error('用法：node scripts/test-impact-map.mjs show');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) process.exit(main());

export { affectedTests, MAP_VERSION };
