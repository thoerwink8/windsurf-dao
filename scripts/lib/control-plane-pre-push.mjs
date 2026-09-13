#!/usr/bin/env node
// git pre-push 入口（#1165）。现役工人走 git push，不靠 Claude/Cursor PreToolUse。
// 只问 decideControlPlane，不复制分类。崩了 fail-closed（exit 1）。

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectEvidence,
  decideControlPlane,
  probeControlPlane,
} from './control-plane-gate.mjs';

function shortCommit() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function drainStdin() {
  return new Promise((resolveDone) => {
    if (process.stdin.isTTY || process.stdin.readableEnded || process.stdin.destroyed) {
      resolveDone();
      return;
    }
    process.stdin.on('data', () => {});
    process.stdin.on('end', resolveDone);
    process.stdin.on('error', resolveDone);
  });
}

export function runPrePush({
  env = process.env,
  cmd = 'git push',
  probe = null,
  evidence = null,
} = {}) {
  const p = probe || probeControlPlane({ env });
  const ev = evidence || collectEvidence({ env, commit: shortCommit() });
  return decideControlPlane({ cmd, probe: p, evidence: ev });
}

async function main() {
  await drainStdin();
  try {
    const d = runPrePush({ env: process.env });
    if (d.block) {
      console.error(d.message || '控制面不可达，拦下 git push');
      process.exit(1);
    }
    if (d.note) console.error(d.note);
    process.exit(0);
  } catch (e) {
    console.error(`控制面闸崩了（fail-closed）：${String(e && e.message ? e.message : e).slice(0, 160)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
