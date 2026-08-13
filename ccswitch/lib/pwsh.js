// pwsh.js — 「优先 pwsh、缺席回退 powershell」的唯一判定点（issue #338，CommonJS 版）
// 判据与 config-sync/lib/pwsh.mjs 完全一致（issue #387 补齐三态同步，此前只搬了两态、
// 未同步 #364 的三态探测，见该 issue 挂账 3）：定位器/候选路径/注册表判定只认**退出码**，
// 不解析输出文案（中文 Windows stderr 是 GBK，任何文案正则都会死，2026-08-13 实证）。
// 两个文件分属 config-sync 与 ccswitch 两棵独立部署树，不互相 import；改判据时两处一起改。
//
// 调用点约束（issue #387 挂账 4）：本文件三态下会返回**带空格的绝对路径**
// （`C:\Program Files\PowerShell\7\pwsh.exe`）。任何调用点若把返回值做字符串插值拼进
// shell 命令行（`` `${PS} ...` `` 交给 execSync/cmd.exe），不加引号就会被拆成多个 token
// 而崩——调用点必须走 execFileSync/spawnSync 的数组参数形式，或显式给返回值加引号。
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// 探测用途的 spawn 超时，量级与 config-sync/lib/pwsh.mjs 一致（issue #387 挂账 5 同款）。
const PROBE_TIMEOUT_MS = 5000;

const DEFAULT_INSTALL_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const DEFAULT_INSTALL_PATH_X86 = 'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe';
const REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions';
const REGISTRY_KEY_WOW64 = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\PowerShellCore\\InstalledVersions';

// 第二兜底：注册表 InstalledVersions 下每个子键的 InstallLocation（64 位、WOW6432Node
// 32 位两个视图都查）。查不到 / reg.exe 不可用一律返回 []。
function queryPwshRegistryPaths(spawnSyncFn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS) {
  if (process.platform !== 'win32') return [];
  const paths = [];
  for (const key of [REGISTRY_KEY, REGISTRY_KEY_WOW64]) {
    try {
      const r = spawnSyncFn('reg', ['query', key, '/s', '/v', 'InstallLocation'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: timeoutMs,
      });
      if (r.error !== undefined || r.status !== 0 || !r.stdout) continue;
      for (const line of String(r.stdout).split(/\r?\n/)) {
        const m = line.match(/InstallLocation\s+REG_SZ\s+(.+)$/);
        if (m) paths.push(`${m[1].trim().replace(/\\+$/, '')}\\pwsh.exe`);
      }
    } catch (_) { /* 这个视图查不到，继续试另一个 */ }
  }
  return paths;
}

// 三态探测：'path'（PATH 直接命中）/ 'fallback'（PATH 未命中，兜底候选存在且真跑通）/
// 'missing'（两处都没有）。探测手段全部可注入，测试不碰真机 PATH/文件系统/注册表。
function detectPwshState({
  locator = process.platform === 'win32' ? 'where' : 'which',
  spawnSyncFn = spawnSync,
  existsSyncFn = fs.existsSync,
  candidatePaths = process.platform === 'win32' ? [DEFAULT_INSTALL_PATH, DEFAULT_INSTALL_PATH_X86] : [],
  registryQueryFn = queryPwshRegistryPaths,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  try {
    const r = spawnSyncFn(locator, ['pwsh'], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, timeout: timeoutMs,
    });
    if (r.error === undefined && r.status === 0) return { state: 'path', resolvedPath: 'pwsh' };
  } catch (_) { /* 定位器不可用 ⇒ 继续往下试兜底 */ }

  const candidates = [...candidatePaths, ...registryQueryFn(spawnSyncFn, timeoutMs)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!existsSyncFn(candidate)) continue;
      const r = spawnSyncFn(candidate, ['-NoProfile', '-Command', 'exit 0'], {
        encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, timeout: timeoutMs,
      });
      if (r.error === undefined && r.status === 0) return { state: 'fallback', resolvedPath: candidate };
    } catch (_) { /* 这个候选跑不通，继续试下一个 */ }
  }

  return { state: 'missing', resolvedPath: null };
}

// 返回：'pwsh'（PATH 命中，字面量）/ 兜底候选的绝对路径（可能带空格，见头注调用点约束）/
// 'powershell.exe'|'powershell'（两处都没有 ⇒ 缺席回退）。
function pickPwsh(overrides) {
  const { state, resolvedPath } = detectPwshState(overrides);
  if (state === 'missing') return process.platform === 'win32' ? 'powershell.exe' : 'powershell';
  return resolvedPath;
}

module.exports = { pickPwsh, detectPwshState, queryPwshRegistryPaths, DEFAULT_INSTALL_PATH_X86 };
