#!/usr/bin/env node
// scripts/dao-fix.mjs —— 机械项**当场修**入口（#1460 T35 第 1/2 步）。
//
//   node scripts/dao-fix.mjs --changed        # 修「相对 origin/master 改动过的文件」（默认就是这个）
//   node scripts/dao-fix.mjs --check          # 只报不改（有该修的就 exit 1）——给闸用
//   node scripts/dao-fix.mjs --files a.js b.md
//
// 为什么要有它：机械项（行尾 / 尾随空白 / 末行换行）本该由工具在**提交前**消掉，
// 而不是留给审查者报、再进债册子（T34 杠杆 1：机械项根本不该进审查）。
// **零依赖**：只用 Node 与 git，不引入 devDeps（本仓「能少做就不多造」）。
//
// 行尾策略读 `.gitattributes`：声明了 `eol=lf` 或 `-text` 的按它办；
// 没声明的按 LF（本仓实际约定），并在报告里说明——**不猜、但也不静默**。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const filesArg = argv.includes('--files')
  ? argv.slice(argv.indexOf('--files') + 1).filter(x => !x.startsWith('--'))
  : null;

const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** 行尾策略：`.gitattributes` 里 `-text` 或 `eol=lf` 的文件按字节不动/用 LF；其余用 LF。 */
function attributes() {
  const text = (() => {
    try {
      return readFileSync(join(ROOT, '.gitattributes'), 'utf8');
    } catch {
      return '';
    }
  })();
  const binary = [];
  for (const line of text.split('\n')) {
    const m = /^\s*([^#\s]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pattern, flags] = m;
    if (/-text/.test(flags)) binary.push(pattern);
  }
  return { binary };
}

const matches = (pattern, path) => {
  // 只处理本仓用到的两种形态：`*.ext` 与 `dir/**/*.ext`
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')}$`,
  );
  return re.test(path);
};

function changedFiles() {
  try {
    return git(['diff', '--name-only', 'origin/master...HEAD']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fixOne(path, { binary }) {
  if (binary.some(p => matches(p, path))) return { path, state: 'skipped', why: '声明为按字节原样（-text）' };
  let raw;
  try {
    raw = readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return { path, state: 'skipped', why: '读不了（可能是二进制或已删）' };
  }
  if (raw.includes('\u0000')) return { path, state: 'skipped', why: '含 NUL，按二进制跳过' };
  const fixed = `${raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n*$/, '')}\n`;
  if (fixed === raw) return { path, state: 'clean', why: '' };
  const what = [];
  if (/\r\n/.test(raw)) what.push('CRLF→LF');
  if (/[ \t]+$/m.test(raw)) what.push('尾随空白');
  if (!raw.endsWith('\n') || raw.endsWith('\n\n')) what.push('末行换行');
  if (!CHECK) writeFileSync(join(ROOT, path), fixed);
  return { path, state: CHECK ? 'would-fix' : 'fixed', why: what.join('+') };
}

const attr = attributes();
const files = filesArg ?? changedFiles();
if (!files.length) {
  process.stdout.write('没有要处理的文件（相对 origin/master 没有改动；或 --files 没给）\n');
  process.exit(0);
}
const results = files.map(f => fixOne(f, attr));
const dirty = results.filter(r => r.state === 'fixed' || r.state === 'would-fix');
for (const r of results) {
  if (r.state === 'clean') continue;
  process.stdout.write(`${CHECK ? '✗' : '✓'} ${r.path} — ${r.why}\n`);
}
const skipped = results.filter(r => r.state === 'skipped').length;
process.stdout.write(
  `\n机械项：处理 ${files.length} 个文件，${CHECK ? '该修' : '已修'} ${dirty.length}，干净 ${results.filter(r => r.state === 'clean').length}，跳过 ${skipped}\n`,
);
if (CHECK && dirty.length) {
  process.stdout.write('有该修的机械项——跑 `node scripts/dao-fix.mjs --changed` 修掉再提交（别留给审查者）。\n');
  process.exit(1);
}
process.exit(0);
