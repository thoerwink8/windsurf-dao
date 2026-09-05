#!/usr/bin/env node
// host/skills/tool-use-gate/hooks/tool-use-gate.mjs —— PreToolUse 钩子：正要跑 Bash 的那一刻，把两条工具使用判据推到眼前。
//
// 改这个文件前必须知道的六条（与 ask-gate 同口径，见那边文件头；这里只写本闸特有的）：
//
// 1. 它**永不拦**。走 hookSpecificOutput.additionalContext，不是 exit 2、不是
//    permissionDecision:deny。拦错了会挡住正常工作。崩了 = 不注入 = 退回没有本闸时的样子。
//
// 2. 退出码必须永远 0，任何异常都得吞掉。不许写 stderr——stderr + 非零在别的 hook
//    语义里会变成拦截。
//
// 3. PreToolUse 的裸 stdout 会被宿主丢掉，必须自己吐 JSON（ask-gate 文件头第 3 条，
//    实证 claude.exe 2.1.261）。没命中就什么都不吐，连空 JSON 都不要。
//
// 4. additionalContext 纠的是下一次；当场那一层靠 systemMessage。两条都不拦动作。
//
// 5. 本文件不 spawn。谁要在这里加 spawnSync/spawn，必须带 windowsHide: true
//    （#807 曾删掉 windowsHide，每轮对话闪一个控制台窗——判例 platform-adapter-deleted-while-still-used）。
//
// 6. 真响的挂载面是随仓 `.claude/settings.json` 的 PreToolUse（ask-gate 2026-09-05 实证：
//    插件 hooks.json 一次都没响）。本目录的 hooks.json 是 A 类声明，给 onboard Junction
//    与 CI 建链用，不是承重墙。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const OWN_REPO = resolve(dirname(HERE), '..', '..', '..', '..');

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit({ context, warning }) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
  if (warning) out.systemMessage = warning;
  process.stdout.write(JSON.stringify(out));
}

async function main() {
  const event = (() => {
    try { return JSON.parse(readStdin()) || {}; } catch { return {}; }
  })();

  const tool = String(event.tool_name || event.toolName || '');
  const libPath = join(OWN_REPO, 'scripts', 'lib', 'tool-use-gate.mjs');
  if (!existsSync(libPath)) return;
  const S = await import('file://' + libPath.replace(/\\/g, '/'));

  if (!S.BASH_TOOLS.includes(tool)) return;

  const command = S.bashCommand(event.tool_input || event.toolInput || {});
  const notes = S.classifyBash(command);
  const context = S.renderToolUseGate(notes);
  if (!context) return;

  emit({ context, warning: S.renderWarning(notes) });
}

main().catch(() => { /* 崩了就不注入，退回没有本闸时的样子 */ });
