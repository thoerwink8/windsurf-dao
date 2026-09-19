#!/usr/bin/env node
// host/conventions/stamp.mjs —— T37：真相源侧的版本戳（生成 / 校验 core.md 的版本戳）。
//
//   node host/conventions/stamp.mjs            # 校验：core.md 内容与版本戳对得上、条数 ≤ 上限
//   node host/conventions/stamp.mjs --json
//   node host/conventions/stamp.mjs --write    # 改过 core.md 后重算戳（version 不动；升版由人改 conventions.json）
//   node host/conventions/stamp.mjs --print    # 打印子仓要贴的那行约定块
//
// 判据全在 kit/conventions-core.mjs（纯函数，单测覆盖）；本文件只读写盘。
// 三态：绿 / 红 / 没查成。「读不到 core.md」是没查成，不是绿。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_RULE_LIMIT, coreStamp, countCoreRules } from './kit/conventions-core.mjs';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const CORE = join(DIR, 'core.md');
const PIN = join(DIR, 'conventions.json');

function readPin() {
  if (!existsSync(PIN)) return { ok: true, pin: null };
  try { return { ok: true, pin: JSON.parse(readFileSync(PIN, 'utf8')) }; }
  catch (e) { return { ok: false, error: `版本戳文件读不成（${PIN}）：${String(e.message || e).slice(0, 120)}` }; }
}

function judge({ text, pin }) {
  const { sha256 } = coreStamp(text);
  const rules = countCoreRules(text);
  if (!pin) return { state: 'unscanned', why: '没有 conventions.json——没查成（取不到 ≠ 没有约定）', sha256, rules };
  if (pin.sha256 !== sha256) return { state: 'red', why: `core.md 内容变了但版本戳没重算（算得 ${sha256.slice(0, 8)}，戳是 ${String(pin.sha256).slice(0, 8)}）——跑 --write`, sha256, rules, version: pin.version };
  if (rules > CORE_RULE_LIMIT) return { state: 'red', why: `不可协商层 ${rules} 条 > 上限 ${CORE_RULE_LIMIT}——进这层要举证`, sha256, rules, version: pin.version };
  if (rules < 1) return { state: 'red', why: '不可协商层一条都没有——core.md 是不是被清空了', sha256, rules, version: pin.version };
  return { state: 'green', why: `约定 v${pin.version}：${rules} 条不可协商层，版本戳一致`, sha256, rules, version: pin.version };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  if (!existsSync(CORE)) { process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: 'core.md 读不到' }) : '? 约定脊柱 — core.md 读不到（没查成）'}\n`); process.exit(1); }
  const text = readFileSync(CORE, 'utf8');
  const { ok, pin, error } = readPin();
  if (!ok) { process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: error }) : `? 约定脊柱 — ${error}`}\n`); process.exit(1); }

  if (argv.includes('--print')) {
    const version = (pin && pin.version) || 1;
    process.stdout.write(`<!-- dao-conventions: v${version} sha256:${coreStamp(text).sha256} -->\n`);
    return;
  }

  if (argv.includes('--write')) {
    const { sha256 } = coreStamp(text);
    const next = { version: (pin && pin.version) || 1, sha256 };
    writeFileSync(PIN, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`✓ 版本戳已重算：v${next.version} sha256:${sha256.slice(0, 8)}（${PIN}）\n`);
    return;
  }

  const verdict = judge({ text, pin });
  if (json) process.stdout.write(`${JSON.stringify({ ...verdict, limit: CORE_RULE_LIMIT }, null, 2)}\n`);
  else {
    const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
    process.stdout.write(`${mark} 约定脊柱 — ${verdict.why}\n`);
    if (verdict.state === 'green') process.stdout.write(`   子仓要贴的块：node host/conventions/stamp.mjs --print\n`);
  }
  process.exit(verdict.state === 'green' ? 0 : 1);
}

main();
