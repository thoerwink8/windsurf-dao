// pwsh.mjs — 「优先 pwsh、缺席回退 powershell」的唯一判定点（issue #338）
//
// 为什么必须集中成一个函数：本批把仓内 PowerShell 调用面全部切到「优先 pwsh、缺席回退
// powershell 5.1」，而判据只有一条（见下），散在每处各写一遍只会各漂各的。
//
// 判定只认 where/which 的**退出码**，不解析输出文案——中文 Windows 的 stderr 是 GBK 被
// utf8 解码后的乱码，任何文案正则都会死（2026-08-13 实证，与 dao-roster.mjs 同款判据；
// 打回记录见 issue #339 订正评论）。定位器自身不可用（error/status==null）按缺席处理。
//
// 返回：'pwsh'（在）或 'powershell.exe'/'powershell'（缺席回退；win32 带 .exe 与既有
// execFileSync 行为逐字节一致）。
import { spawnSync } from 'node:child_process';

export function pickPwsh() {
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
