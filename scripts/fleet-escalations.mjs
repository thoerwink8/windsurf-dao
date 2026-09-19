#!/usr/bin/env node
// scripts/fleet-escalations.mjs —— T39 ④ 指挥官侧：读裁决收件箱 + 机械裁决 + 报告。
//
//   node scripts/fleet-escalations.mjs            # 人读报告（每条给一个机械决定；躺太久的判红）
//   node scripts/fleet-escalations.mjs --json
//
// 判据全在 scripts/lib/escalation-inbox.mjs（纯函数，单测覆盖）；本文件只读盘。
// 收件箱是**派生数据**，落 `~/.dao/fleet-escalations/`（不进 git）；上报侧在 packages/fleet 的 escalate 活动。
// 三态：绿 / 红 / 没查成。**红 = 有单子躺太久没人看**。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { judgeEscalationInbox } from './lib/escalation-inbox.mjs';

const DIR = process.env.DAO_FLEET_ESCALATION_DIR || join(homedir(), '.dao', 'fleet-escalations');

function readInbox(dir) {
  if (!existsSync(dir)) return { ok: true, items: [], missing: true };
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); }
  catch (e) { return { ok: false, error: `收件箱读不成（${dir}）：${String(e.message || e).slice(0, 120)}` }; }
  const items = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      items.push({ path, name, payload });
    } catch (e) {
      return { ok: false, error: `收件箱里有读不成的条目（${name}）：${String(e.message || e).slice(0, 120)}` };
    }
  }
  return { ok: true, items, missing: false };
}

function main() {
  const json = process.argv.includes('--json');
  const dirIdx = process.argv.indexOf('--dir');
  const dir = dirIdx >= 0 ? process.argv[dirIdx + 1] : DIR;
  const cur = readInbox(dir);
  if (!cur.ok) {
    process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: cur.error }) : `? 裁决收件箱 — ${cur.error}`}\n`);
    process.exit(1);
  }
  const verdict = judgeEscalationInbox({ items: cur.items, now: Date.now() });
  if (json) {
    process.stdout.write(`${JSON.stringify({ dir, missing: cur.missing, total: cur.items.length, verdict }, null, 2)}\n`);
  } else {
    const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
    process.stdout.write(`${mark} 裁决收件箱（${dir}）— ${verdict.why}\n`);
    for (const j of verdict.judged || []) {
      process.stdout.write(`   ${j.payload?.taskId || j.name} → ${j.verdict.decision}：${j.verdict.why}\n`);
    }
    if (cur.missing) process.stdout.write('   （收件箱还没建：本机没上报过，不是没查成）\n');
  }
  process.exit(verdict.state === 'green' ? 0 : 1);
}

main();
