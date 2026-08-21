#!/usr/bin/env node
// Cursor beforeShellExecution 入口（随仓 .cursor/hooks.json 挂载，#707）。
//
// 改这个文件前必须知道的三条：
//   1. 判定逻辑唯一一份在 ./dispatch-gate.mjs（本仓第二把闸不存在），这里只做
//      协议翻译：Claude Code 用 exit 2 拦；Cursor 只认 stdout JSON 的 permission 字段。
//   2. 为什么不能直挂 dispatch-gate-hook.mjs（#707 实测）：Cursor 在 Windows 上用
//      PowerShell 包装执行钩子（Get-Content -Raw | & { $input | <hook> }），脚本块
//      调用会把子进程退出码吞成 0 —— exit 2 在 Windows 上根本到不了 Cursor；
//      且 failClosed:true + 空 stdout 会把「放行」也拦掉。所以本文件永远 exit 0，
//      拦/放全靠 stdout JSON（两种形态都非空）。
//   3. fail-closed 兜底：拦 → {"permission":"deny"}；崩（runAsHook 的 catch 也是
//      exit 2 + stderr）→ 同样 deny JSON；钩子配置 failClosed:true 再兜超时（124）
//      和本进程起不来（非 0 退出）——那两条路径 Cursor 见空/非 0 会按 failClosed 拦。
import { runAsHook } from './dispatch-gate.mjs';
import { readFileSync } from 'node:fs';

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const r = runAsHook({
  stdinText: readStdinSync(),
  argv: process.argv.slice(2),
  env: process.env,
});

if (r.exit === 0) {
  process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
} else {
  const msg = r.stderr || '派工只走 node scripts/dao.mjs dispatch';
  process.stdout.write(`${JSON.stringify({ permission: 'deny', user_message: msg, agent_message: msg })}\n`);
}
process.exit(0);
