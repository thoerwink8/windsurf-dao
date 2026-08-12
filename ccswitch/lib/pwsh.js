// pwsh.js — 「优先 pwsh、缺席回退 powershell」的唯一判定点（issue #338，CommonJS 版）
// 判据与 config-sync/lib/pwsh.mjs 完全一致：只认 where/which 的**退出码**，不解析输出
// 文案（中文 Windows stderr 是 GBK，任何文案正则都会死，2026-08-13 实证）。两个文件
// 分属 config-sync 与 ccswitch 两棵独立部署树，不互相 import；改判据时两处一起改。
'use strict';

const { spawnSync } = require('node:child_process');

function pickPwsh() {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(locator, ['pwsh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    if (r.error === undefined && r.status === 0) return 'pwsh';
  } catch (_) { /* 定位器不可用 ⇒ 按缺席走回退 */ }
  return process.platform === 'win32' ? 'powershell.exe' : 'powershell';
}

module.exports = { pickPwsh };
