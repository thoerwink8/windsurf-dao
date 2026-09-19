#!/usr/bin/env node
// scripts/dao-format.mjs —— 机械项的**带依赖**入口（#1460 T35 第 2 步）。
//
//   node scripts/dao-format.mjs            # 对「相对 origin/master 改动过的文件」跑：先 dao-fix（零依赖），再 prettier
//   node scripts/dao-format.mjs --check    # 只查不改（该修就 exit 1）
//
// 分工：`dao-fix.mjs` 零依赖（行尾/尾随空白/末行换行），**没有 prettier 也能用**；
// 本文件在它之上加 prettier（代码风格），**只对改动文件**跑——避免整仓重排那种巨大 diff。
// prettier 不在（没装 node_modules）时明确报「没查成」，不许当绿。

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...opts });
/** prettier 用**它的 JS 入口**跑（node <bin>）：Windows 上直接 spawn  需要 shell
 *  （Node 的安全修复之后不让），而 npx.cmd 同样踩这个坑——JS 入口两边都稳。 */
const PRETTIER_BIN = 'node_modules/prettier/bin/prettier.cjs';
const hasPrettier = () => run(process.execPath, [PRETTIER_BIN, '--version']).status === 0;

const changed = (() => {
  const r = run('git', ['diff', '--name-only', 'origin/master...HEAD']);
  return r.status === 0
    ? String(r.stdout || '')
        .split('\n')
        .filter(Boolean)
    : [];
})();
if (!changed.length) {
  process.stdout.write('没有改动文件（相对 origin/master）——无事可做\n');
  process.exit(0);
}

// ① 零依赖那半（行尾/尾随空白/末行换行）
const fix = run(process.execPath, ['scripts/dao-fix.mjs', ...(CHECK ? ['--check'] : []), '--changed']);
process.stdout.write(String(fix.stdout || ''));

// ② prettier 那半：只对改动文件；不在就报没查成
const exts = /\.(mjs|cjs|js|json|md|ya?ml)$/i;
const targets = changed.filter(f => exts.test(f));
let prettierState = 'skipped';
if (targets.length) {
  if (!hasPrettier()) {
    prettierState = 'unscanned';
    process.stdout.write('? prettier 不在（没装 node_modules）——代码风格这半**没查成**（不是绿）。装法：npm i\n');
  } else {
    const r = run(process.execPath, [PRETTIER_BIN, ...(CHECK ? ['--check'] : ['--write']), ...targets]);
    prettierState = r.status === 0 ? (CHECK ? 'clean' : 'formatted') : 'would-fix';
    if (r.status !== 0) process.stdout.write(String(r.stdout || r.stderr || '').slice(0, 2000));
  }
}

const bad = fix.status !== 0 || prettierState === 'would-fix' || prettierState === 'unscanned';
process.stdout.write(`\n机械项（带依赖）：prettier ${prettierState}（目标 ${targets.length} 个）\n`);
process.exit(CHECK && bad ? 1 : 0);
