// scripts/lib/orca-run.mjs —— spawn orca 的唯一真源（审查修复：7 处拷贝收编成 1 份）
//
// 收编前 runOrca/runCmd 在 watchdog.mjs / dao.mjs / inbox-station.mjs / flow.mjs /
// board-hook.mjs / dao-check.mjs / dao-mode.mjs 各有一份拷贝，其中 board-hook 的
// shell 回落、dao-mode 与 dao-check 的全部拷贝缺 windowsHide: true（#695 同款弹窗隐患）。
//
// 两个导出：
//   runOrcaRaw  —— 要 raw spawnSync 结果的调用方（board-hook / dao-check 自己解析 stdout）
//   runOrca     —— 要归一化 {ok, json, error, sentPlaintext} 的调用方（其余全部）
//
// 行为口径（收编时逐份核对后的统一版）：
// - 先按精确文件名 spawn（win 下 orca.exe，不过 shell，参数里的中文/分号不会被 shell
//   再解析一次）；只有找不到可执行文件（spawn error）才退到 shell 拼单条命令试一次。
// - 两条路径都带 windowsHide: true（#695：后台轮询不许弹黑窗）与 timeout。
// - 归一化：orca 的非零退出把结构化错误 JSON 打在 stdout（实测 terminal_handle_stale 的
//   {ok:false, error:{code,message}} 在 stdout、stderr 为空）——先试解析，拿到 error 原样
//   透传（错误码不丢，#580 审读红②返工）；拿不到再回落 stderr/exit N 字符串。
//
// 例外：host/skills/dao-mode/hooks/dao-mode.mjs 作为 Claude 插件分发（CLAUDE_PLUGIN_ROOT
// 场景仓外没有 scripts/lib），必须自包含——它的本地拷贝与本文件行为对齐并注释指向这里。

import { spawnSync } from 'node:child_process';
import { parseOrcaStdout } from './orca-stdout.mjs';

/**
 * 跑一次 orca，返回 raw spawnSync 结果（{error, status, stdout, stderr}）。
 * direct spawn 失败（找不到可执行文件）才 shell 回落；两条路径都 windowsHide + timeout。
 */
export function runOrcaRaw(args, { timeout = 30000, cwd } = {}) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout, ...(cwd ? { cwd } : {}) };
  const direct = spawnSync(process.platform === 'win32' ? 'orca.exe' : 'orca', args, opts);
  if (!direct.error) return direct;
  const line = ['orca', ...args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`)].join(' ');
  return spawnSync(line, { ...opts, shell: true });
}

/**
 * 跑一次 orca，归一化成 {ok, json, error, sentPlaintext}。
 * error 保留结构化对象（{code, message}）或字符串——要人读文本用 orca-error.mjs 的
 * orcaErrorText 转。errorSlice 只截字符串回落形态的长度。
 */
export function runOrca(cmdArgs, { timeout = 30000, cwd, errorSlice = 240 } = {}) {
  const r = runOrcaRaw(cmdArgs, { timeout, cwd });
  if (r.error || r.status !== 0) {
    if (r.stdout) {
      const parsed = parseOrcaStdout(r.stdout);
      if (parsed.ok && parsed.json?.error) return { ok: false, error: parsed.json.error, json: parsed.json };
      if (parsed.ok && parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
    }
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, errorSlice) };
  }
  const parsed = parseOrcaStdout(r.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
  return { ok: true, json: parsed.json, sentPlaintext: !!parsed.sentPlaintext };
}
