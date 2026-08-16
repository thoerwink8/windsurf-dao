#!/usr/bin/env node
// PreToolUse 入口。逻辑在 scripts/lib/dispatch-gate.mjs，这里只转调，避免两份闸。
import { runAsHook } from '../../../../scripts/lib/dispatch-gate.mjs';
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
