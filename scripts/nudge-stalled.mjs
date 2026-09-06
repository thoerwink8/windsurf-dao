#!/usr/bin/env node
// 推一把卡住的工人。**垫片**——正式的家是 issue #1056 的对账循环，合并时本脚本退役。
//
// 为什么需要它：盘面上会一直挂着「某某静默 N 分钟」，却没有任何东西让它继续——
// 发现和处置之间断了一截。（原文这里指的是 agent-stall-watch 的 escalate 只报帅不动手；
// 那一层 2026-09-06 已整层删除，见 chain:agent-stall#7。今天的发现面是
// scripts/progress-watch.mjs 的盘面推进量，同样只叫醒帅位、不动手，缺口没变。）
//
// 而 2026-09-06 实测：卡住的工人**没死**。record.json 里 `runState: incomplete` /
// `runDetail: pi turn stalled past 30 minutes`，但最后一条 turn 是 `phase: done`，
// 正文停在「设计已对齐…」——它跑完一轮在等下一句话，没人说话就被 30 分钟计时判成卡死。
// 所以处置是**说一句「继续」**，不是重派：重派会丢掉它已经读完的上下文，白烧一遍额度。
// 当天五个（#1007 #1017 #1052 #1055 #1056）推完全部回到 running。
//
// 探测面不自己造：卡死清单从 mirasim 落盘的 record.json 直接读（它是会话的所有者）。
// 这也是屏面指纹层删掉之后**会话级**判卡的唯一去处——progress-watch 看的是盘面对象
// （PR / issue / 复审票），看不见「某个会话跑完一轮在等话」。两个面互补，别合并。
//
//   node scripts/nudge-stalled.mjs                  列出卡住的派工树，不动手
//   node scripts/nudge-stalled.mjs --go             逐个推一把
//   node scripts/nudge-stalled.mjs --go --only 1056 只推一个

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRuntime } from './lib/mirasim-runtime.mjs';
import { shouldSkipNudge } from './lib/nudge-skip.mjs';

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const SESSIONS = '/home/orca/.mirasim/sessions';

const CONTINUE = [
  '继续。你上一轮跑完就停在那儿等指令了，任务没做完——接着做，别重新开始。',
  '先说一句你现在做到哪、下一步动哪个文件，然后直接动手。',
  '做完照任务书交卷（提交 + 推分支 + PR 正文写验收）。',
].join('\n');

// 审官的活是「判」不是「写」，交卷方式也不同，所以不能给它上面那套话。
// 上一轮多半是撞上游满载中断的（Selected model is at capacity），不是它判完了。
const REVIEW_CONTINUE = [
  '继续审。你上一轮没跑完就中断了（多半是上游满载），审查还没交卷——接着审，别重新开始。',
  '先说一句你已经看过哪些文件、还剩什么没看，然后接着看。',
  '判完照审官任务书交卷：逐条给判定，判绿或判红都要落到 PR review 上，别只在会话里说。',
].join('\n');

/**
 * 树路径反查它在盘面上的身份。两种树都要认：
 *   `.../dao-1056`         工人树      → {kind:'工人', n:1056}
 *   `.../dao-review-pr-1040` 审官树    → {kind:'审官', n:1040}
 * 认不出回 null，不猜——临时会话没有单号，也就没有重派路径，不该被推。
 *
 * 审官树一开始漏了，而那正是最要命的一类：审官卡死 ⇒ 没有判绿 ⇒ **什么都合不了**。
 * 2026-09-06 实测两个审官（PR #1018 / #1040）双双停在
 * 「Selected model is at capacity」，当天一张 PR 都没合就是这么来的。
 */
function idOfTree(workdir) {
  const s = String(workdir || '');
  const r = /(?:^|\/)dao-review-pr-(\d+)$/.exec(s);
  if (r) return { kind: '审官', n: Number(r[1]), label: `PR #${r[1]}` };
  const w = /(?:^|\/)dao-(\d+)(?:-\d+)?$/.exec(s);
  if (w) return { kind: '工人', n: Number(w[1]), label: `#${w[1]}` };
  return null;
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
  if (!r.workdir || idOfTree(r.workdir) == null) continue;
  if (!existsSync(r.workdir)) continue; // 树已经清掉了就不是「没人管」，是收拾过了
  const at = Date.parse(r.updatedAt || '') || 0;
  const prev = latest.get(r.workdir);
  if (!prev || at > prev.at) latest.set(r.workdir, { at, rec: r });
}

const stalled = [...latest.values()]
  .filter(x => x.rec.runState === 'incomplete')
  .filter(x => !only || String(idOfTree(x.rec.workdir).n) === String(only))
  .sort((a, b) => a.at - b.at);

if (!stalled.length) { console.log('[推一把] 没有卡住的树'); process.exit(0); }

function readGhState(kind, n) {
  const args = kind === '审官'
    ? ['pr', 'view', String(n), '--json', 'state', '-q', '.state']
    : ['issue', 'view', String(n), '--json', 'state', '-q', '.state'];
  const env = { ...process.env, NO_COLOR: '1', GH_NO_COLOR: '1', TERM: 'dumb' };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  delete env.CLICOLOR;
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 20000, windowsHide: true, env });
  if (r.status !== 0) return { unscanned: true, state: null };
  return { unscanned: false, state: String(r.stdout || '').trim() };
}

for (const { rec } of stalled) {
  const id = idOfTree(rec.workdir);
  const agent = rec.agent || 'pi';
  const who = `${id.kind} ${id.label}`;
  const gh = readGhState(id.kind, id.n);
  const skip = shouldSkipNudge({
    kind: id.kind,
    issueState: id.kind === '工人' ? gh.state : null,
    prState: id.kind === '审官' ? gh.state : null,
    issueUnscanned: id.kind === '工人' && gh.unscanned,
    prUnscanned: id.kind === '审官' && gh.unscanned,
  });
  if (skip.skip) {
    console.log(`[推一把·跳过] ${who}（${skip.why}）`);
    continue;
  }
  if (!GO) { console.log(`[推一把·预览] ${who} ${agent}（${rec.runDetail || rec.runState}）`); continue; }
  try {
    const rt = createRuntime({ homeDir: '/home/orca' });
    // 审官不能给「接着写代码」那套话——它的活是判，交卷方式也不同。
    const prompt = id.kind === '审官' ? REVIEW_CONTINUE : CONTINUE;
    const r = await rt.startSession({ agent, workdir: rec.workdir, prompt });
    console.log(`[推一把] ${who} 推了：${r.sessionKey}`);
  } catch (e) {
    // 推不动就如实说，不吞——它下一轮还在 incomplete，本命令再跑一次照样看得见。
    console.error(`[推一把] ${who} 推不动：${String(e.message || e).slice(0, 160)}`);
  }
}
