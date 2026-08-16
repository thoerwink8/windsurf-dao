// 派工闸门（#546 #517）：拦裸 orca 派工命令。
//
// Claude Code 的命令型 hook：只有 exit 2 拦得住动作；崩溃 / exit 1 / 超时在宿主眼里全是放行。
// 所以本文件任何异常都转成 exit 2（fail-closed）。「崩了」和「判通过」不许同形。
// 用法：hook 读 stdin 的 PreToolUse JSON；测试也可 argv 传入命令。

import { readFileSync } from 'node:fs';

export const GATE_HINT = [
  '派工只走 node scripts/dao.mjs dispatch（用法：node scripts/dao.mjs dispatch --help）。',
  '逃生口：node scripts/dao.mjs raw -- <命令>（会留痕）。',
].join('');

export function normalizeCmd(cmd) {
  return String(cmd || '').replace(/\s+/g, ' ').trim();
}

export function extractHookCommand(event) {
  if (event == null) return '';
  if (typeof event === 'string') {
    const t = event.trim();
    if (!t) return '';
    if (t.startsWith('{')) {
      try { return extractHookCommand(JSON.parse(t)); }
      catch { return t; }
    }
    return t;
  }
  if (typeof event !== 'object') return '';
  const input = event.tool_input || event.toolInput || event.input || {};
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return input.command;
    if (typeof input.cmd === 'string') return input.cmd;
  }
  if (typeof event.command === 'string') return event.command;
  return '';
}

export function commandFromHookInput(stdinText, argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const dd = args.indexOf('--');
  if (dd >= 0 && args[dd + 1]) return args.slice(dd + 1).join(' ');
  const text = String(stdinText || '').trim();
  if (!text) return '';
  return extractHookCommand(text);
}

/** 裸 orca 派工动作。dao.mjs 自己的 dispatch/raw/worker-start 不拦。 */
export function isDispatchBypass(cmd) {
  const s = normalizeCmd(cmd);
  if (!s) return false;
  if (/\bdao\.mjs\b/.test(s) && /\braw\b/.test(s)) return false;
  if (/\bdao\.mjs\b/.test(s)) return false;
  if (!/(^|[\\/\s])orca(\.exe|\.cmd)?\b/i.test(s)) return false;
  if (/\borchestration\s+worker-start\b/.test(s)) return true;
  if (/\borchestration\s+task-create\b/.test(s)) return true;
  if (/\borchestration\s+dispatch\b/.test(s)) return true;
  return false;
}

export function decideGate(cmd) {
  if (!isDispatchBypass(cmd)) return { block: false, command: normalizeCmd(cmd) };
  return {
    block: true,
    command: normalizeCmd(cmd),
    message: `拦下裸 orca 派工：${normalizeCmd(cmd)}\n${GATE_HINT}`,
  };
}

export function runAsHook({ stdinText = '', argv = [], env = process.env } = {}) {
  try {
    const crash = env && (env.DISPATCH_GATE_CRASH === '1' || env.DISPATCH_GATE_CRASH === 'true');
    if (crash) throw new Error('dispatch-gate 故意崩（DISPATCH_GATE_CRASH）');
    const cmd = commandFromHookInput(stdinText, argv);
    const decision = decideGate(cmd);
    if (decision.block) return { exit: 2, stderr: decision.message, command: decision.command };
    return { exit: 0, stderr: '', command: decision.command };
  } catch (e) {
    return {
      exit: 2,
      stderr: `dispatch-gate 崩了，按拦下处理（fail-closed）：${e && e.message ? e.message : e}`,
    };
  }
}

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const invoked = process.argv[1] && /dispatch-gate\.mjs$/.test(String(process.argv[1]).replace(/\\/g, '/'));
if (invoked) {
  const stdinText = readStdinSync();
  const r = runAsHook({ stdinText, argv: process.argv.slice(2), env: process.env });
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exit(r.exit);
}
