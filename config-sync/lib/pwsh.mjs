// pwsh.mjs — 「优先 pwsh、缺席回退 powershell」的唯一判定点（issue #338）
//
// 为什么必须集中成一个函数：本批把仓内 PowerShell 调用面全部切到「优先 pwsh、缺席回退
// powershell 5.1」，而判据只有一条（见下），散在每处各写一遍只会各漂各的。
//
// 三态探测（issue #364）：单纯查 PATH（where/which）在「装完 PS7 但没开新终端/长驻进程」
// 时会假阴性——机器级 PATH 更新要新进程才继承，已开的终端/进程拿的是装机前的旧 PATH，
// 与 dao-roster.mjs 的假阴性同族（#337：探测环境陈旧 ≠ 目标缺席）。detectPwshState()
// 在 PATH 查不到时再兜底探默认安装路径 + 注册表，候选存在**且** `-NoProfile -Command
// exit 0` 真跑通才算数——只看文件存在不算（存在但损坏的安装包不该被判「已装」）。
//
// 判定只认退出码，不解析输出文案——中文 Windows 的 stderr 是 GBK 被 utf8 解码后的乱码，
// 任何文案正则都会死（2026-08-13 实证，与 dao-roster.mjs 同款判据；打回记录见
// issue #339 订正评论）。定位器/候选路径自身不可用（error/status==null/文件不存在）
// 一律按缺席处理，不炸，继续试下一个候选。
//
// issue #387（PR #386 对抗审挂账）收账：探测 spawn 补 timeout（挂死的 pwsh.exe/reg.exe
// 不再无限期拖住 doctor）；候选路径 + 注册表查询补 x86/WOW6432Node 视图（32 位安装不再漏
// 探）；测试补齐「文件存在但真跑不通」「PATH 命中与兜底候选重叠」两处判别力盲区，见
// tests/doctor-pwsh-detect.tests.js。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// 探测用途的 spawn 超时（issue #387 挂账 5）：这仨调用是「问一下装没装」，不是业务
// 调用，卡死的 pwsh.exe / reg.exe 不该无限期拖住 pickPwsh()/doctor。消费方的
// execFileSync 早就带 30000/60000ms，探测层反而没有——补齐同一量级但更短，因为探测
// 只需要「跑得动」不需要跑完真实工作。
const PROBE_TIMEOUT_MS = 5000;

const DEFAULT_INSTALL_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
// x86 变体（issue #387 挂账 6）：64 位 Windows 上装 32 位 PowerShell 7 落在
// `Program Files (x86)`，默认候选原来只查 64 位路径，漏探这一支。
export const DEFAULT_INSTALL_PATH_X86 = 'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe';
const REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions';
// WOW6432Node：64 位系统上 32 位程序的注册表视图，32 位 pwsh 装完只写在这一支，
// 不写主视图——只查 REGISTRY_KEY 会漏探（同一颗 issue #387 挂账 6）。
const REGISTRY_KEY_WOW64 = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\PowerShellCore\\InstalledVersions';

// 第二兜底：注册表 InstalledVersions 下每个子键的 InstallLocation。查不到 / reg.exe
// 不可用一律返回 []——这是兜底的兜底，缺席不影响第一兜底（默认安装路径）继续工作。
// 64 位、32 位（WOW6432Node）两个视图都查，一个键查不到不影响另一个。
export function queryPwshRegistryPaths(spawnSyncFn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS) {
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

// 三态探测：'path'（PATH 直接命中）/ 'fallback'（PATH 未命中，兜底候选存在且真跑通——
// 已装，只是当前进程的 PATH 未刷新）/ 'missing'（两处都没有）。
// 探测手段全部可注入（locator/spawnSyncFn/existsSyncFn/candidatePaths/registryQueryFn），
// 测试不碰真机 PATH / 文件系统 / 注册表。
export function detectPwshState({
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

// 返回：'pwsh'（PATH 命中，字面量，行为与既有 execFileSync 调用逐字节一致）/
// 兜底候选的绝对路径（PATH 未命中但兜底探到真能跑，直接把绝对路径交给调用方，
// 调用方无需关心「是从 PATH 找到的还是兜底找到的」）/ 'powershell.exe'|'powershell'
// （两处都没有 ⇒ 缺席回退；这条语义不变，issue #364 只是让「找到」覆盖面更宽）。
export function pickPwsh(overrides) {
  const { state, resolvedPath } = detectPwshState(overrides);
  if (state === 'missing') return process.platform === 'win32' ? 'powershell.exe' : 'powershell';
  return resolvedPath;
}
