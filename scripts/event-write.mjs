#!/usr/bin/env node
// scripts/event-write.mjs —— 点将台事件写入工具（派单/结单/归因/政策/套餐等）
//
// 一事件一文件：<账本目录>/<ulid>-<machine>.json（默认本机 ~/.dao/ledger/events，不进 git）；
// 写一次即不可变（已存在/同内容均拒绝，
// 纠错另立 attr.retract）。类型闭集与必填字段派生自 schemas/events.schema.json（唯一权威）。
// [闭集镜子开始]  下面这份清单是 schemas/events.schema.json 的 oneOf[].title 派生注释，不是第二份权威。
//   加/删类型改的是 schema，这几行必须跟着同步；对不上时 tests/session-events.test.js 报红。
//   job.opened / job.dispatch / job.meter / job.handoff / job.closed / job.override / job.explore /
//   attr.rule / attr.llm / attr.human / attr.retract / policy.patch / sub.usage / incident /
//   audit.bypass / audit.stale / session.state / decision.pending / decision.resolved /
//   session.milestone
// [闭集镜子结束]
//
// 用法（通用：任何 --key value 进 payload，值先试 JSON 解析，失败按字符串）：
//   node scripts/event-write.mjs --type job.dispatch --job-id dj-001 --model deepseek-v4-flash \
//       --identity 协调者 --work-type 写码 --model-version DeepSeek-V4-Flash-0731 \
//       --terminal pi --decision-id <id> --ts 2026-08-15T10:00:00+08:00
//   node scripts/event-write.mjs --type job.closed --job-id dj-001 --success true --rework false \
//       --usd-cash 1.23 --usd-economic 1.23 --merged-by deepseek-v4-flash --ts ...
//   node scripts/event-write.mjs --type attr.rule --job-id dj-001 --model deepseek-v4-flash \
//       --model-share 0.3 --brief-share 0.7 --coord-share 0 --env-share 0 --overrun-attr null \
//       --confidence 0.9 --evidence '["<event_id>"]' --why "换模型同时改任务书才通过（L0 规则7）" --ts ...
//   node scripts/event-write.mjs --type job.meter --job-id dj-001 --model deepseek-v4-flash \
//       --token-in 12000 --token-out 3000 --cache-hit 4000 --usd-cash 0.05 --ts ...
//   node scripts/event-write.mjs --type policy.patch --summary "..." --changed-files '["policy/models.yml"]' --ts ...
//   node scripts/event-write.mjs --type session.state --session-id s-001 --identity 帅 --phase 沉默 \
//       --doing "在盯 W1 交卷" --next "串行合三张卡" --blocked false --pending-decision-id null \
//       --digest 0f1e2d3c4b5a6978 --repo windsurf-dao --refs '["#891"]' --ts ...
//   node scripts/event-write.mjs --type decision.pending --decision-id d-001 --question "先合哪张卡？" \
//       --options '[{"label":"W1 先合","description":"schema 是另两张的地基"},{"label":"等三张齐"}]' \
//       --recommend "W1 先合" --urgency 急 --why "另两张都读它派生的闭集" --ts ...
//   node scripts/event-write.mjs --type decision.resolved --target-decision-id d-001 \
//       --chosen '["W1 先合"]' --by 用户 --note "当场拍" --ts ...
//   node scripts/event-write.mjs --type session.milestone --kind commit --repo windsurf-dao \
//       --milestone-key commit:a1b2c3d --commit a1b2c3d --evidence "exit_code=0；git 探头查到了" --ts ...
//
// 选项：--dir <目录>（默认本机 ~/.dao/ledger/events）--machine <机器名>（默认本机 hostname）
//       --seq N（默认自动：本机最大 seq + 1）--schema <schema 路径>

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { writeEvent, nextSeq } from './lib/event-writer.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function valueOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 值先试 JSON 解析（数字/布尔/null/数组/对象），失败按字符串 */
function coerce(v) {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const type = valueOf('type');
if (!type) {
  process.stderr.write('缺 --type（事件类型，见 schema oneOf 闭集）\n');
  process.exit(1);
}
const dir = valueOf('dir') ? resolve(ROOT, valueOf('dir')) : ensureLocalLedger({ root: ROOT }).dir;
const machine = valueOf('machine') || os.hostname();
const ts = valueOf('ts');
if (!ts) {
  process.stderr.write('缺 --ts（ISO8601 带时区）\n');
  process.exit(1);
}
const schema = JSON.parse(readFileSync(resolve(ROOT, valueOf('schema') || 'schemas/events.schema.json'), 'utf8'));

const payload = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--') || i + 1 >= process.argv.length) continue;
  const key = a.slice(2).replace(/-/g, '_'); // --job-id → job_id
  if (['type', 'dir', 'machine', 'ts', 'seq', 'schema'].includes(key)) continue;
  payload[key] = coerce(process.argv[i + 1]);
  i++;
}

const seq = valueOf('seq') !== undefined ? Number(valueOf('seq')) : nextSeq(dir, machine);

const { path, event } = writeEvent({ dir, type, ts, machine, seq, payload, schema });
process.stdout.write(JSON.stringify({ path, event }, null, 2) + '\n');
