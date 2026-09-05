#!/usr/bin/env node
// scripts/test-impact-map.mjs —— 建/查「测试 → 它碰过哪些本仓文件」的影响地图
//
// 判据与设计前提在 scripts/lib/test-impact.mjs 头部，本文件只管采集与落盘。
//
// 用法：
//   node scripts/test-impact-map.mjs build          逐套跑测试 + 采覆盖率，重建地图（慢，分钟级）
//   node scripts/test-impact-map.mjs build --only a.test.js,b.test.js   只重建这几套（增量补图）
//   node scripts/test-impact-map.mjs show           打印地图概况
//   node scripts/test-impact-map.mjs health         只做健康度判定（给 dao-check 用，退出码 0/1）
//
// 建图什么时候跑：每日 cron 的全量那一次顺手重建（那次本来就要跑全部测试，白捡）。
// 平时新增测试后可以 `build --only <新文件>` 增量补，不用等一天。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { affectedTests, buildMap, filesFromCoverage, IGNORED_IN_MAP, mapHealth, MAP_VERSION } from './lib/test-impact.mjs';

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

/** 跑一套测试并采覆盖率 → 它碰过的本仓文件。跑失败也照样回收（失败的套也有依赖信息）。 */
export function sampleOne(testFile, { root = REPO_ROOT } = {}) {
  const covDir = mkdtempSync(join(tmpdir(), 'ti-cov-'));
  const readLog = join(covDir, 'reads.txt');
  const recorder = join(root, 'tests', 'helpers', 'record-reads.mjs');
  try {
    spawnSync(process.execPath, ['--test', join(root, testFile)], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300000,
      env: {
        ...process.env,
        NODE_V8_COVERAGE: covDir,
        // 覆盖率只看得见执行过的 JS；数据文件（json/md/toml…）靠这个钩子记。
        // 两者都经 NODE_OPTIONS/环境继承罩住 spawn 出去的 CLI。
        DAO_READ_LOG: readLog,
        DAO_READ_ROOT: root,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${pathToFileURL(recorder).href}`.trim(),
      },
    });
    const docs = [];
    for (const f of existsSync(covDir) ? readdirSync(covDir) : []) {
      if (f === 'reads.txt') continue;
      try { docs.push(JSON.parse(readFileSync(join(covDir, f), 'utf8'))); } catch { /* 半截文件跳过 */ }
    }
    const files = filesFromCoverage(docs, root);
    if (existsSync(readLog)) {
      for (const l of readFileSync(readLog, 'utf8').split('\n')) {
        const rel = l.trim();
        if (rel && !IGNORED_IN_MAP.some((re) => re.test(rel))) files.add(rel);
      }
    }
    files.delete(testFile);           // 自己不算依赖
    return { ok: docs.length > 0, files: [...files], coverageDocs: docs.length };
  } finally {
    try { rmSync(covDir, { recursive: true, force: true }); } catch { /* 清不掉不影响判定 */ }
  }
}

function cmdBuild(argv) {
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const all = listTests();
  const targets = only ? only.map((f) => (f.startsWith('tests/') ? f : `tests/${f}`)) : all;
  if (targets.length === 0) { console.error('一套测试都没扫到——本次没查成，不是「没有测试」'); return 2; }

  const prev = readMap();
  const entries = only && prev && prev.entries ? { ...prev.entries } : {};
  let noSample = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    process.stderr.write(`\r建图 ${i + 1}/${targets.length} ${t.padEnd(46)}`);
    const r = sampleOne(t);
    if (!r.ok) { noSample++; continue; }        // 一份覆盖率都没落 = 没采成，不写空数组冒充「无依赖」
    entries[t] = r.files;
  }
  process.stderr.write('\n');
  // 只重建部分时，把已删测试从旧图里剔掉
  for (const k of Object.keys(entries)) if (!all.includes(k)) delete entries[k];

  const map = buildMap({ entries, head: gitOut(['rev-parse', 'HEAD']) });
  mkdirSync(dirname(MAP_PATH), { recursive: true });
  writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
  const n = Object.keys(map.entries).length;
  console.log(`影响地图已写：${n} 套测试，平均依赖 ${(Object.values(map.entries).reduce((s, a) => s + a.length, 0) / (n || 1)).toFixed(1)} 个文件${noSample ? `；${noSample} 套没采到覆盖率（未入图，健康检查会报）` : ''}`);
  return 0;
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

function cmdHealth() {
  const map = readMap();
  const all = listTests();
  let dist = null;
  if (map && map.head) {
    const c = gitOut(['rev-list', '--count', `${map.head}..HEAD`]);
    dist = c == null ? null : Number(c);
  }
  const h = mapHealth({ map, allTests: all, headDistance: dist });
  if (h.ok) { console.log(`影响地图健康：${Object.keys(map.entries).length} 套在图、落后 HEAD ${dist ?? '?'} 个提交`); return 0; }
  for (const p of h.problems) console.error(`地图不健康：${p}`);
  return 1;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'show';
  if (cmd === 'build') return cmdBuild(argv);
  if (cmd === 'show') return cmdShow();
  if (cmd === 'health') return cmdHealth();
  console.error('用法：node scripts/test-impact-map.mjs build|show|health');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) process.exit(main());

export { affectedTests, mapHealth, MAP_VERSION };
