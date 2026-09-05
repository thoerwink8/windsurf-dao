#!/usr/bin/env node
// scripts/lib/cursor-context-hook.mjs —— Cursor 钩子薄适配层（#707）
//
// 改这个文件前必须知道的三条：
//   1. 只报不拦：永远 exit 0 + {"continue": true}。Cursor 的 beforeSubmitPrompt / sessionStart
//      只认 stdout JSON，纯文本输出会被当 invalid JSON 丢弃（[盘]/[卫] 行进不了会话上下文，
//      #707 验收 6 实测）。本适配层挂在 .cursor/hooks.json 上，把子脚本的输出包成 JSON。
//   2. 不复制任何判定逻辑：子脚本（board-hook）的 stdout 原样包进
//      additional_context——Cursor 唯一能把文本注入会话上下文的字段（源码实测：
//      executeHookForStep 的响应里 additional_context 被拼进下一轮 prompt 上下文）。
//   3. 输出区分「查过」和「没查成」：子脚本没跑成 / 超时输出可辨认的「没查成」行，
//      不许静默（「没查成」≠「查过没事」）。

import { spawnSync } from 'node:child_process';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..', '..');

// 必须小于 .cursor/hooks.json 里 sessionStart / beforeSubmitPrompt 的 timeout(60s)：
// 宁可自己先报「没查成」，也不让宿主超时把整条 hook 当失败杀掉。
const CHILD_TIMEOUT_MS = 55000;

/** 子脚本 spec → 绝对路径。文件名 = scripts/lib 下；带分隔符 = 相对仓库根。 */
export function resolveChild(childArg) {
  const name = String(childArg || '').trim();
  if (!name) return null;
  if (isAbsolute(name)) return name;
  if (/[\\/]/.test(name)) return resolve(ROOT, name);
  return join(SCRIPT_DIR, name);
}

/**
 * 跑子脚本并把 stdout 包进 Cursor 响应（exec 可注入，测试不碰真机）。
 * @returns {string} stdout JSON 一行（永远 continue: true）
 */
export function wrapChild({ child, exec = null } = {}) {
  const fail = (msg) => JSON.stringify({ continue: true, additional_context: `[钩] ${msg}（≠ 查过没事）` });
  if (!child) return fail('子脚本没指定：argv[2] 要是 scripts/lib 下文件名或相对仓库根路径');
  const r = exec
    ? exec(child)
    : spawnSync(process.execPath, [child], { windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], // 不继承 Cursor 经管道喂进来的载荷 stdin
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || ROOT,
        },
        timeout: CHILD_TIMEOUT_MS,
      });
  if (r.error || (r.status !== 0 && r.status != null)) {
    const timedOut = String(r.error?.code || r.error?.message || '').includes('TIMEDOUT') || String(r.error?.message || '').toLowerCase().includes('timed out');
    const tail = String(r.stderr || '').trim() || String(r.stdout || '').trim() || r.error?.message || '';
    const why = timedOut ? '子脚本超时没查成' : `子脚本没跑成（${r.error?.message || `exit ${r.status}`}）`;
    return fail(`${why}${tail ? `：${tail.slice(-160)}` : ''}`);
  }
  const text = String(r.stdout || '').trim();
  if (!text) return JSON.stringify({ continue: true });
  return JSON.stringify({ continue: true, additional_context: text });
}

function main() {
  try {
    const child = resolveChild(process.argv[2]);
    process.stdout.write(`${wrapChild({ child })}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ continue: true, additional_context: `[钩] 适配层没查成：${String(e?.message || e).slice(0, 200)}（≠ 查过没事）` })}\n`);
  }
  process.exit(0);
}

// 只被命令行直跑（hook 面）时开工；被测试 import 时只导出纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
