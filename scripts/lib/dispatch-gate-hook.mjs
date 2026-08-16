#!/usr/bin/env node
// PreToolUse 入口（随仓 .claude/settings.json 挂载，#553）。
// 逻辑唯一一份在 ./dispatch-gate.mjs（本仓第二把闸不存在），这里只做 stdin 读取与退出码转发。
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
if (r.stderr) process.stderr.write(`${r.stderr}\n`);
process.exit(r.exit);
