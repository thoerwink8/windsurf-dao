#!/usr/bin/env node
// 推一把卡住的工人。**垫片**——正式的家是 issue #1056 的对账循环，合并时本脚本退役。
//
// 为什么需要它：`agent-stall-watch` 现在查得出卡死了（d4872eb1 放开了被退役 orca 挡住的
// mirasim 采样面），但它对非审官会话的处置只有 `escalate`——报帅，不动手
// （见 scripts/lib/liveness.mjs 的 routeSilent）。于是盘面上会一直挂着「某某静默 N 分钟」，
// 没有任何东西让它继续。
//
// 而 2026-09-06 实测：卡住的工人**没死**。record.json 里 `runState: incomplete` /
// `runDetail: pi turn stalled past 30 minutes`，但最后一条 turn 是 `phase: done`，
// 正文停在「设计已对齐…」——它跑完一轮在等下一句话，没人说话就被 30 分钟计时判成卡死。
// 所以处置是**说一句「继续」**，不是重派：重派会丢掉它已经读完的上下文，白烧一遍额度。
// 当天五个（#1007 #1017 #1052 #1055 #1056）推完全部回到 running。
//
// 探测面不自己造：卡死清单从 mirasim 落盘的 record.json 直接读（它是会话的所有者），
// 只做一件 agent-stall-watch 没做的事——发那一句话。
//
//   node scripts/nudge-stalled.mjs                  列出卡住的派工树，不动手
//   node scripts/nudge-stalled.mjs --go             逐个推一把
//   node scripts/nudge-stalled.mjs --go --only 1056 只推一个

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from './lib/mirasim-runtime.mjs';

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const SESSIONS = '/home/orca/.mirasim/sessions';

const CONTINUE = [
  '继续。你上一轮跑完就停在那儿等指令了，任务没做完——接着做，别重新开始。',
  '先说一句你现在做到哪、下一步动哪个文件，然后直接动手。',
  '做完照任务书交卷（提交 + 推分支 + PR 正文写验收）。',
].join('\n');

/** 树路径反查 issue 号（`.../dao-1056` → 1056）。对不上回 null，不猜。 */
function issueOfTree(workdir) {
  const m = /(?:^|\/)dao-(\d+)(?:-\d+)?$/.exec(String(workdir || ''));
  return m ? Number(m[1]) : null;
}

function readRecords(root) {
  let agents;
  try {
    agents = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) {
    console.error(`[推一把] 会话档案读不了 ${root}：${String(e.message || e)}——没查成，不动手`);
    process.exit(2);
  }
  const out = [];
  let seen = 0;
  for (const agent of agents) {
    let ids = [];
    try { ids = readdirSync(join(root, agent), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { continue; }
    for (const id of ids) {
      seen += 1;
      try { out.push({ agent, ...JSON.parse(readFileSync(join(root, agent, id, 'record.json'), 'utf8')) }); } catch { /* 还没落盘 */ }
    }
  }
  // 「扫完是 0」和「没扫到」必须分得开，否则会把没查成当成「没有卡死的」。
  if (seen === 0) {
    console.error(`[推一把] ${root} 下一个会话目录都没扫到——不是「没有工人」，是没扫成`);
    process.exit(2);
  }
  return out;
}

// 按树取**最近那条**记录判：旧的 running 盖不住新的 incomplete（dao-1017 实咬——
// running 停在 11:31、incomplete 停在 11:49，按「有活就算活」会漏掉真正卡住的那条）。
const records = readRecords(SESSIONS);
const latest = new Map();
for (const r of records) {
  if (!r.workdir || issueOfTree(r.workdir) == null) continue;
  if (!existsSync(r.workdir)) continue; // 树已经清掉了就不是「没人管」，是收拾过了
  const at = Date.parse(r.updatedAt || '') || 0;
  const prev = latest.get(r.workdir);
  if (!prev || at > prev.at) latest.set(r.workdir, { at, rec: r });
}

const stalled = [...latest.values()]
  .filter(x => x.rec.runState === 'incomplete')
  .filter(x => !only || String(issueOfTree(x.rec.workdir)) === String(only))
  .sort((a, b) => a.at - b.at);

if (!stalled.length) { console.log('[推一把] 没有卡住的派工树'); process.exit(0); }

for (const { rec } of stalled) {
  const issue = issueOfTree(rec.workdir);
  const agent = rec.agent || 'pi';
  if (!GO) { console.log(`[推一把·预览] #${issue} ${agent} ${rec.workdir}（${rec.runDetail || rec.runState}）`); continue; }
  try {
    const rt = createRuntime({ homeDir: '/home/orca' });
    const r = await rt.startSession({ agent, workdir: rec.workdir, prompt: CONTINUE });
    console.log(`[推一把] #${issue} 推了：${r.sessionKey}`);
  } catch (e) {
    // 推不动就如实说，不吞——下一轮 agent-stall-watch 还会把它报出来。
    console.error(`[推一把] #${issue} 推不动：${String(e.message || e).slice(0, 160)}`);
  }
}
