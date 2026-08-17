#!/usr/bin/env node
// scripts/flow.mjs —— 闭环自动流转器（issue #455 实现，2026-08-15 融合改造瘦身）
//
// 分工（fusion-verdict.md 拍板）：首发完工发现 = 门铃（Monitor 挂
// `orca orchestration check --wait --types worker_done,...`，见 dispatch skill）；
// 本脚本降为备份通道（轮询默认 300s）+ 审读闭环——重放 GitHub 确定性信号推导当前态，
// 返工/复核/乒乓报帅/终审报帅。审官由 worker-done 按需起（#586），本器不再起审官。
// 看门狗（scripts/watchdog.mjs）管事故（屏面异常），
// 三者正交：不要把完工检测塞回看门狗，也不要把屏面特征（如「待授权」）塞进本脚本。
// 规格源 = issue #455 正文 + 全部评论 + fusion-verdict.md。
//
// 触发源只用 GitHub 确定性信号，不靠屏面猜测：
//   ① review 判定行：「判定：红 N 项」「复核结论：绿/红 N 项」——
//      解析逻辑与 scripts/calibrate.mjs 共用 scripts/lib/judgment.mjs（唯一真相源，不复制两份）
//   ② 完工 comment：行首「完工」「返工(完成|处置)」（完工报告/完工自报/返工完成/返工处置）
//   ③ PR MERGED 状态
//
// 决策规则（②）：
//   - 工人完工且待审    → 不起审官（#586：worker-done 已按需起）
//   - 审官红 N 项       → 输出注入工人返工的指令文本（机械转发，不做内容判断）
//   - 复核绿            → 报帅终审（终审+校准+合并归档归帅，不自动合并）
//   - 乒乓两轮仍红      → 报帅换人（换人决策归帅）
//   - 判定行缺失/格式不符 → 报帅分诊（「没查成」≠「无需流转」）
//
// 执行注入（③）：
//   - 验开工：增量判据为主（read 记 nextCursor → send → read --cursor，有新输出
//     = token 在动）；回显判据为辅（TUI 回显注入文本头）。被吞第一处置补一记裸回车
//     （#455 连带教训：输入框残留，第二遍全文同样堆积），仍无 → fail-visible 报帅。
//   - 注入目标确定性定位：返工注入按任务卡 worktree 内唯一候选终端（排除审官句柄
//     与 shell），选不出唯一目标就报帅，不挑第一个。
//   - 复核注入：优先记录句柄，其次记录审官卡，兜底反查「审官·」子卡；全找不到
//     报「待帅接手复核」。
//
// 帅保留四类判断不得自动化（④）：报警分诊 / 换人 / 弹窗放行 / 终审合并。
// 「新工位问、闭环内不问」：自动注入只覆盖闭环内流转；新工位（无完工信号）
// 不出任何自动动作。
//
// 待帅处置常驻行（对抗审红 3）：有待帅事项（复核绿待终审 / 判定行缺失待分诊 /
// 乒乓仍红待换人 / 注入失败待接手 / 找不到审官待接手 / 选不出审官）的 PR，每轮都
// 输出「[flow] 待帅处置：#N（原因）」且 exit 1——「0 需流转」只允许用在真没有待办时；
// 待办不能因报过一次就转绿。记账字段 = rec.pendingShuai（四轮复核红 1，独立于注入闸）。
//
// 存量清点（#455 的 prime 吞存量教训）：本脚本不做「只监听新事件」——
// 每轮对每个在途 PR 重放全部信号（comments+reviews）推导当前态；首次启动
// （状态文件为空）即等价于存量清点，存量里已有的完工/判定会被识别并动作，
// 不会被吞。状态文件 _flow/state.json 只是「已处理信号」游标缓存（GitHub 才是
// 真相源），可丢可重算：删掉重跑即重新清点。
// 心跳（#580 补 #497 欠账）：live 每轮写 _flow/heartbeat.json，字段照 watchdog
// 消费端契约。快照默认不写。三态：新鲜 / 过期 / 从未存在。
// #595：live 心跳带 revision（current / behind / unknown）。落后或查不成必须报警。
//
// 退出码（与 watchdog 同口径）：0 扫完 0 需流转 / 1 有动作、报帅或待帅处置 /
// 2 NO_TARGETS（本轮没查成）/ 3 基础设施失败（gh/orca 拉不到、参数错）。
//
// 用法：
//   node scripts/flow.mjs                     轮询模式（默认每 300s 一轮——备份通道；
//                                             首发完工由门铃 check --wait 接管，供 Monitor 挂载）
//   node scripts/flow.mjs --once              跑单轮后退出（给测试用）
//   node scripts/flow.mjs --interval 300      轮询间隔秒数
//   node scripts/flow.mjs --state-file <path> 状态文件位置（默认 _flow/state.json）
//   node scripts/flow.mjs --dry-run           只输出动作与将执行的命令，不碰 orca 写操作
//                                             （目标解析仍跑——快照/实读，测试可覆盖）
//   node scripts/flow.mjs --snapshot-dir <dir> 从录制的 gh/orca JSON 快照跑（测试/复现用）
//   node scripts/flow.mjs --repo <nameWithOwner> 显式指定仓库（默认 gh repo view 推断）
//
// 快照目录可选文件（round-N/ 子目录同 watchdog 约定）：
//   prs.json / issue-<N>-comments.json / pr-<N>-comments.json / pr-<N>-reviews.json / pr-<N>.json（gh 侧）
//   orca-worktrees.json / orca-terminals.json（orca 侧，可缺省为无数据）

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { judgmentFromReview, isCompletionComment } from './lib/judgment.mjs';
import { classifyPr } from './calibrate.mjs';
import { parseOrcaStdout } from './lib/orca-stdout.mjs';
import {
  writeJobDispatch, writeJobClosed, workerJobId, reviewerJobId,
  loadLedgerContext, beijingIsoFrom, verdictStatsFromReviews,
  scopeOverridesFor, linkAliasesToSuccessor,
} from './lib/ledger-job.mjs';
import { readLedgerEvents } from './lib/ledger-query.mjs';
import {
  recordStartupRevision, checkGuardRevision, formatRevisionAlarm, attachRevision,
} from './lib/guard-revision.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_STATE = join(ROOT, '_flow', 'state.json');
const ORCA_TIMEOUT_MS = 30000;
const GH_TIMEOUT_MS = 30000;
const VERIFY_WAIT_MS = 2500;      // 注入后等待新输出的静默时间
const STALE_24H_MS = 24 * 60 * 60 * 1000;

let _ledgerCtx = null;
function ledgerCtx() {
  if (!_ledgerCtx) _ledgerCtx = loadLedgerContext({ root: ROOT });
  return _ledgerCtx;
}

function ledgerTs(input) {
  try { return beijingIsoFrom(input || new Date()); }
  catch { return beijingIsoFrom(new Date()); }
}

function ledgerEventsOrEmpty(ctx) {
  const listed = readLedgerEvents(ctx.dir);
  return listed.unscanned ? [] : listed.events;
}

function noteJudgmentClosedLedger(pr, reviews, { success, dryRun }) {
  if (dryRun) return '';
  const ctx = ledgerCtx();
  const events = ledgerEventsOrEmpty(ctx);
  const issueNumber = ticketIssueNumber(pr);
  const overrides = scopeOverridesFor(events, {
    jobId: workerJobId(pr.number),
    prNumber: pr.number,
    issueNumber,
  });
  const stats = verdictStatsFromReviews(reviews, { overrides });
  const last = [...(reviews || [])].reverse().find(r => r && (r.submittedAt || r.submitted_at));
  const ts = ledgerTs((last && (last.submittedAt || last.submitted_at)) || new Date());
  const payload = {
    ts,
    success: Boolean(success),
    rework: (stats.workerRework || 0) > 0,
    prNumber: pr.number,
    redFlags: stats.redFlags,
    verdictRounds: stats.verdictRounds,
    workerRework: stats.workerRework,
    marshalRounds: stats.marshalRounds,
    triggeredBy: stats.triggeredBy,
    attributionSource: stats.attributionSource,
    attributionNote: stats.attributionNote,
    extra: { source: 'flow', issue_number: issueNumber },
  };
  const cls = classifyPr(pr);
  if (cls.model) {
    writeJobDispatch({
      ...ctx,
      ts,
      jobId: workerJobId(pr.number),
      model: cls.model,
      identity: '工人',
      workType: cls.taskType || '写码',
      terminal: 'flow',
      prNumber: pr.number,
      extra: { source: 'flow', issue_number: issueNumber },
    });
  }
  const links = [
    ...linkAliasesToSuccessor({
      ctx, ts, events, successorJobId: workerJobId(pr.number),
      issueNumber, prNumber: pr.number, model: cls.model, identity: '工人',
    }),
    ...linkAliasesToSuccessor({
      ctx, ts, events, successorJobId: reviewerJobId(pr.number),
      issueNumber, prNumber: pr.number, model: cls.model, identity: '审官',
    }),
  ];
  const worker = writeJobClosed({
    ...ctx, ...payload,
    jobId: workerJobId(pr.number),
    mergedBy: cls.model || 'unknown',
  });
  const reviewer = writeJobClosed({
    ...ctx, ...payload,
    jobId: reviewerJobId(pr.number),
    mergedBy: 'reviewer',
  });
  const bits = [];
  for (const [side, r] of [['工人', worker], ['审官', reviewer]]) {
    if (!r.ok) bits.push(`${side}closed失败:${r.error}`);
    else if (r.skipped) bits.push(`${side}closed已在`);
    else bits.push(`${side}closed已写`);
  }
  const linked = links.filter(r => r && r.ok && !r.skipped).length;
  if (linked) bits.push(`接续${linked}`);
  return bits.length ? `（账本 ${bits.join('，')}）` : '';
}

function noteWorkerMergedLedger(pr, dryRun) {
  if (dryRun || !pr) return '';
  const ctx = ledgerCtx();
  const cls = classifyPr(pr);
  const ts = ledgerTs(pr.mergedAt || pr.closedAt || new Date());
  const events = ledgerEventsOrEmpty(ctx);
  const issueNumber = ticketIssueNumber(pr);
  if (cls.model) {
    writeJobDispatch({
      ...ctx,
      ts,
      jobId: workerJobId(pr.number),
      model: cls.model,
      identity: '工人',
      workType: cls.taskType || '写码',
      terminal: 'flow',
      prNumber: pr.number,
      extra: { source: 'flow', issue_number: issueNumber },
    });
  }
  linkAliasesToSuccessor({
    ctx, ts, events, successorJobId: workerJobId(pr.number),
    issueNumber, prNumber: pr.number, model: cls.model, identity: '工人',
  });
  linkAliasesToSuccessor({
    ctx, ts, events, successorJobId: reviewerJobId(pr.number),
    issueNumber, prNumber: pr.number, model: cls.model, identity: '审官',
  });
  const worker = writeJobClosed({
    ...ctx,
    ts,
    jobId: workerJobId(pr.number),
    success: true,
    rework: false,
    mergedBy: cls.model || 'unknown',
    prNumber: pr.number,
    extra: { source: 'flow', issue_number: issueNumber },
  });
  const hasReviewDispatch = events.some(e => e && e.type === 'job.dispatch' && e.job_id === reviewerJobId(pr.number));
  const reviewer = hasReviewDispatch ? writeJobClosed({
    ...ctx,
    ts,
    jobId: reviewerJobId(pr.number),
    success: true,
    rework: false,
    mergedBy: 'reviewer',
    prNumber: pr.number,
    extra: { source: 'flow', issue_number: issueNumber },
  }) : null;
  const bits = [];
  for (const [side, r] of [['工人', worker], ['审官', reviewer]]) {
    if (!r) continue;
    if (!r.ok) bits.push(`${side}closed失败:${r.error}`);
    else if (r.skipped) bits.push(`${side}closed已在`);
    else bits.push(`${side}closed已写`);
  }
  return bits.length ? `（账本 ${bits.join('，')}）` : '';
}

// ══════════════════════════════════════════════════════════════════════
// 参数
// ══════════════════════════════════════════════════════════════════════

function printUsage() {
  console.log(`用法：
  node scripts/flow.mjs [--once] [--interval 秒] [--state-file <path>] [--dry-run]
                        [--snapshot-dir <目录>] [--repo <nameWithOwner>]

  --once              跑单轮后退出（给测试用）
  --interval <秒>     轮询间隔（默认 300——备份通道；首发完工由门铃 check --wait 接管）
  --state-file <path> 状态文件位置（默认 _flow/state.json）
  --dry-run           只输出动作与将执行的命令，不碰 orca 写操作（目标解析仍跑）
  --snapshot-dir <目录> 从录制的 gh/orca JSON 快照跑（测试/复现用），跑完即退出
  --repo <nameWithOwner> 显式指定仓库（默认 gh repo view 推断）`);
}

function parseArgs(argv) {
  const args = { once: false, interval: 300, stateFile: DEFAULT_STATE, dryRun: false, snapshotDir: null, repo: null };
  const take = (i, name) => {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`参数 ${name} 需要正整数`);
      process.exit(3);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--once': args.once = true; break;
      case '--interval': args.interval = take(i++, '--interval'); break;
      case '--state-file': args.stateFile = resolve(process.cwd(), argv[++i] || ''); break;
      case '--dry-run': args.dryRun = true; break;
      case '--snapshot-dir': args.snapshotDir = resolve(process.cwd(), argv[++i] || ''); break;
      case '--repo': args.repo = argv[++i] || ''; break;
      case '--help': printUsage(); process.exit(0); break;
      default:
        console.error(`未知参数: ${a}`);
        printUsage();
        process.exit(3);
    }
  }
  return args;
}

// ══════════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════════

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runCmd(cmd, args, timeout = 30000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (r.error || r.status !== 0) {
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 300) };
  }
  return { ok: true, out: r.stdout };
}

function runGh(args) {
  const r = runCmd('gh', args, GH_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: `gh ${args[0]} 失败：${r.error}` };
  try {
    return { ok: true, json: JSON.parse(r.out) };
  } catch (e) {
    return { ok: false, error: `gh ${args[0]} 输出不是 JSON：${e.message}` };
  }
}

function runOrca(args) {
  const r = runCmd('orca', args, ORCA_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: r.error };
  const parsed = parseOrcaStdout(r.out);
  if (!parsed.ok) return parsed;
  if (parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
  return { ok: true, json: parsed.json, sentPlaintext: !!parsed.sentPlaintext };
}

function unwrap(json, pathKey, topKey) {
  const viaPath = json?.result?.[pathKey];
  if (Array.isArray(viaPath)) return viaPath;
  if (Array.isArray(json?.[topKey])) return json[topKey];
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// 信号提取（纯函数，快照与 live 共用）
// ══════════════════════════════════════════════════════════════════════

// 完工信号：issue comment 首行命中「完工」或「返工(完成|处置)」。
// #575 ⑥：读关联 issue（标题 #N 或 Closes #N），不读 PR 会话——工人被 push 闸拦住时仍能交棒。
function ticketIssueNumber(pr) {
  const title = String(pr?.title || '');
  const fromTitle = title.match(/#(\d+)/);
  if (fromTitle) return Number(fromTitle[1]);
  const body = String(pr?.body || '');
  const fromClose = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/i.exec(body);
  return fromClose ? Number(fromClose[1]) : null;
}

function completionSignals(comments) {
  const out = [];
  for (const c of comments || []) {
    if (!c || c.id == null) continue;
    if (isCompletionComment(c.body)) {
      out.push({ type: 'completion', id: `c:${c.id}`, at: c.createdAt || '', body: c.body });
    }
  }
  return out;
}

function reviewSignals(reviews) {
  const out = [];
  for (const r of reviews || []) {
    if (!r || r.id == null) continue;
    const v = judgmentFromReview(r.body);
    out.push({
      type: 'review', id: `r:${r.id}`, at: r.submittedAt || '', body: r.body,
      verdict: v, url: r.url || null,
    });
  }
  return out;
}

function orderedSignals(comments, reviews) {
  return [...completionSignals(comments), ...reviewSignals(reviews)]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 由全部信号推导当前态（纯函数，每轮重放——存量清点即此步）：
//   working → awaiting-review（完工，无审）→ rework-needed（红 N，待返工）
//   → awaiting-recheck（返工完成，待复核）→ approved（复核绿）/ pingpong（乒乓两轮仍红）
//   error = 存在判定行缺失/格式不符的 review（报帅分诊，不作为红/绿处理）。
function deriveState(signals) {
  let state = 'working';
  let redReviews = 0;
  let lastRed = null;
  let lastSignalId = null;
  for (const sig of signals) {
    lastSignalId = sig.id;
    if (sig.type === 'completion') {
      if (state === 'working') state = 'awaiting-review';
      else if (state === 'rework-needed') state = 'awaiting-recheck';
      continue;
    }
    const v = sig.verdict;
    // 判定行缺失（kind=null）或格式不符（红绿都判不出）→ 报帅分诊，不作为红/绿处理
    if (!v.kind || v.malformed) { state = 'error'; continue; }
    if (v.green) { state = 'approved'; lastRed = null; continue; }
    redReviews += 1;
    lastRed = v.red;
    // 乒乓两轮仍红 → 报帅换人（第 3 次红判定起不再自动注入返工）
    state = redReviews >= 3 ? 'pingpong' : 'rework-needed';
  }
  return { state, redReviews, lastRed, lastSignalId };
}

// 当前态的待办动作（纯函数）：null = 无需流转（扫完 0 需流转）。
// 注入重试的闸是 actedOn 指纹去重（每个新信号至多一次，不重试狂发）；
// pendingShuai 只记账不 gate——它管「有没有人还欠一个动作」的显示（四轮复核红 1）。
function pendingAction(derived) {
  if (derived.state === 'working') return null;
  if (derived.state === 'awaiting-review') return null; // #586：审官由 worker-done 按需起
  if (derived.state === 'awaiting-recheck') return { kind: 'inject-recheck', round: derived.redReviews };
  if (derived.state === 'rework-needed') return { kind: 'inject-rework', red: derived.lastRed, round: derived.redReviews };
  if (derived.state === 'approved') return { kind: 'report-final' };
  if (derived.state === 'pingpong') return { kind: 'report-switch', round: derived.redReviews };
  return null; // error 态由 malformed review 逐条报帅 + 待帅处置常驻行覆盖
}

// 待帅处置原因（红 3：卡着的 PR 每轮都要显形，不能报一次就转绿）
// rec.pendingShuai = 独立于注入闸的待帅记账（四轮复核红 1）：注入失败 / reviewer-unfound /
// report-unknown / 四类状态原因都经它显示——blocked 管「要不要再注入」（闸已由 fp 去重承担），
// pendingShuai 管「有没有人还欠一个动作」；清除时机与自愈同步（fp 变化重试时清、动作成功时清）。
// thisRoundFailed = 本轮 dry-run 解析失败（预览的本轮量，不落盘）。
function awaitingShuaiReason(derived, rec, thisRoundFailed) {
  if (rec.pendingShuai) return rec.pendingShuai.reason;
  if (derived.state === 'approved') return '复核绿待帅终审';
  if (derived.state === 'error') return '判定行缺失/格式不符待帅分诊';
  if (derived.state === 'pingpong') return '乒乓两轮仍红待帅换人';
  if (thisRoundFailed) return '注入/目标解析失败待帅确认（本轮，未落闸）';
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// 动作文本（决策输出，人读 + 机器可 grep）
// ══════════════════════════════════════════════════════════════════════

function reworkInstruction(pr, red, round, reviewUrl) {
  return [
    `【返工指令 · 闭环自动流转 · 第 ${round} 轮】`,
    `审官对 PR #${pr.number} 判定红 ${red} 项。请读 review：${reviewUrl || `PR #${pr.number} 的最新 review`}`,
    '逐条处置红项；修完 push，并回一条「返工完成」comment 自报。质疑拍板/规格本身要上帅，不自行改判。',
  ].join('\n');
}

function recheckInstruction(pr, round, reviewerLabel) {
  return [
    `【复核指令 · 闭环自动流转 · 第 ${round} 轮返工后 · ${reviewerLabel}】`,
    `工人已完成第 ${round} 轮返工处置。请复核 PR #${pr.number} 最新 diff 与返工自报，`,
    '判定格式「复核结论：绿/红 N 项」写在 review 正文首行。',
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// orca 终端操作（live 用；注入目标解析走 source，dry-run 也能覆盖）
// ══════════════════════════════════════════════════════════════════════

function readTerminalData(handle, cursor) {
  const args = ['terminal', 'read', '--terminal', handle, '--limit', '80', '--json'];
  if (cursor != null) args.push('--cursor', String(cursor));
  const r = runOrca(args);
  if (!r.ok) return { ok: false, error: r.error };
  const t = r.json?.result?.terminal;
  if (!t || typeof t.status !== 'string' || !Array.isArray(t.tail)) return { ok: false, error: 'read 成功响应但 status/tail 字段缺失（结构畸形）' };
  return { ok: true, terminal: t };
}

function defaultFlowIo() {
  return { read: readTerminalData, send: (cmd) => runOrca(cmd), sleep };
}

// 验开工：增量判据为主（cursor 前进 = 有新输出 = token 在动），
// 回显判据为辅且不单独成立——回显命中但 cursor 没动 = 文本还在输入框未提交
// （#455 输入框残留原场景），第一处置补一记裸回车（不是再注入一遍全文）再判。
// 观察 3：只有 send 路径（echoHead 非空）才补回车——--prompt 路径活已交出去，
// 空回车没必要（agent 启动慢时会吃到一记无谓 Enter）。
// #580：补回车后再读必须带 cursor（read --cursor 有新输出），整屏 returnedLineCount
// 几乎永远 > 0，不能当增量。
export function verifyStarted(handle, echoHead, terminalName, io, baselineCursor) {
  const ops = io || defaultFlowIo();
  let prev = baselineCursor;
  if (prev == null) {
    const first = ops.read(handle, null);
    if (!first.ok) return { ok: false, error: `读终端失败：${first.error}` };
    prev = first.terminal.nextCursor;
  }
  ops.sleep(VERIFY_WAIT_MS);
  const second = ops.read(handle, prev);
  if (second.ok && Number(second.terminal.returnedLineCount || 0) > 0) return { ok: true, judge: 'cursor 增量（有新输出）' };
  if (!echoHead) {
    // --prompt 路径：无回显概念，不补回车，直接 fail-visible
    return { ok: false, error: `注入后无新输出（${terminalName}）——疑似未开工` };
  }
  // send 路径：看回显，无论是否回显都补一记裸回车再验增量
  const all = ops.read(handle, null);
  const tailText = all.ok ? all.terminal.tail.map(l => String(l)).join('\n') : '';
  const echoed = tailText.includes(echoHead);
  const afterEnterBase = second.ok && second.terminal.nextCursor != null ? second.terminal.nextCursor : prev;
  ops.send(['terminal', 'send', '--terminal', handle, '--enter', '--json']);
  ops.sleep(VERIFY_WAIT_MS);
  const third = ops.read(handle, afterEnterBase);
  const grew3 = third.ok && Number(third.terminal.returnedLineCount || 0) > 0;
  if (grew3) return { ok: true, judge: echoed ? '回显+补回车（输入框残留提交）' : '补回车后开工' };
  return { ok: false, error: `注入后无新输出（${terminalName}）——疑似吞注入（${echoed ? '回显命中但回车未提交' : '无回显'}）` };
}

// 注入 + 验开工（两步走路径：send 任务文本）
// #580 ④ / 审官红 1：send 前先记 cursor，再 send，再从该 cursor 验增量。
export function injectAndVerify(handle, text, terminalName, io) {
  const ops = io || defaultFlowIo();
  const echoHead = String(text || '').replace(/\r?\n/g, ' ').slice(0, 24).trim();
  const baseline = ops.read(handle, null);
  if (!baseline.ok) return { ok: false, error: `读终端失败：${baseline.error}` };
  const prev = baseline.terminal.nextCursor;
  const sendR = ops.send(['terminal', 'send', '--terminal', handle, '--text', text, '--json']);
  if (!sendR.ok) return { ok: false, error: `terminal send 失败：${sendR.error}` };
  return verifyStarted(handle, echoHead, terminalName, ops, prev);
}

// 流转器自己该做的动作（起审官 / 返工注入 / 复核注入）。报帅终审/换人不是流转器活，
// 心跳缺失时不能拿它们当「有待流转」——那是帅的事（#580 消歧：有条件报）。
export function isFlowWork(action) {
  return !!action && (action.kind === 'inject-rework' || action.kind === 'inject-recheck');
}

// 从 PR 信号列表算出「流转器该做而没人做」的项。watchdog 心跳缺失时用，不猜进程名。
export function pendingFlowItems(prs) {
  const items = [];
  for (const pr of prs || []) {
    const derived = deriveState(orderedSignals(pr.comments, pr.reviews));
    const action = pendingAction(derived);
    if (isFlowWork(action)) items.push({ number: pr.number, kind: action.kind, state: derived.state });
  }
  return items;
}

// 待流转评论源：完工信号在署名 issue，不在 PR 会话（#575 ⑥ / #580 审官红 2）。
// 给了 issueComments 就用它（快照可造 PR号≠issue号）；没给才退回 comments。
export function commentsForPendingScan(pr) {
  if (pr && Object.prototype.hasOwnProperty.call(pr, 'issueComments')) {
    return Array.isArray(pr.issueComments) ? pr.issueComments : [];
  }
  return Array.isArray(pr?.comments) ? pr.comments : [];
}

// ══════════════════════════════════════════════════════════════════════
// 注入目标定位（红 2/红 4：确定性定位，选不出唯一就报帅，不挑第一个）
// ══════════════════════════════════════════════════════════════════════

const SHELL_LIKE = /^(PS |PowerShell|Terminal \d|cmd|bash|zsh)/;

// worktree 里活着的终端里挑唯一注入目标：
//   connected+writable+非 orphaned；排除审官句柄（返工不能注给审官）；
//   排除 shell（title 空 / PS / Terminal N / cmd / bash / zsh —— agent 的 title
//   会被 orca 覆写成对话摘要，不能按「角色·模型」猜，对抗审红 4 实录）。
//   候选恰 1 个 → 用；0 个 → 报错；多个 → 报帅指定（不挑第一个）。
function pickUniqueTerminal(terminals, wtId, excludeHandle) {
  const inWt = (terminals || []).filter(t => t.worktreeId === wtId && t.connected && t.writable && !t.orphaned);
  const candidates = inWt
    .filter(t => t.handle !== excludeHandle)
    .filter(t => {
      const title = (t.title || '').trim();
      return title !== '' && !SHELL_LIKE.test(title);
    });
  if (candidates.length === 1) return { ok: true, terminal: candidates[0] };
  if (candidates.length === 0) {
    const why = inWt.length === 0 ? 'worktree 无活着终端' : `全部 ${inWt.length} 个终端被排除（shell/审官句柄）`;
    return { ok: false, error: `worktree ${wtId} 没有唯一可用终端（${why}）` };
  }
  return { ok: false, error: `worktree ${wtId} 有 ${candidates.length} 个候选终端（${candidates.map(t => t.handle).join('、')}），选不出唯一注入目标——请帅指定，不挑第一个` };
}

// 审官终端反查（红 2）：①起审官时记下的句柄（优先）②记下的审官卡 id
// ③兜底存量反查：任务卡子卡里找「审官」卡（帅手起审官、流转器后启动的场景）。
function findReviewerTerminal(source, pr, rec, workerWt) {
  const termsR = source.orcaTerminals();
  if (!termsR.ok) return { ok: false, error: termsR.error };
  const terms = termsR.terminals;
  if (rec.reviewer?.handle && terms.some(t => t.handle === rec.reviewer.handle)) {
    return { ok: true, terminal: terms.find(t => t.handle === rec.reviewer.handle), via: '起审官记录句柄' };
  }
  if (rec.reviewer?.worktree) {
    const t = pickUniqueTerminal(terms, rec.reviewer.worktree, null);
    if (t.ok) return { ok: true, terminal: t.terminal, via: '起审官记录审官卡' };
  }
  if (workerWt && Array.isArray(workerWt.childWorktreeIds) && workerWt.childWorktreeIds.length > 0) {
    const wtsR = source.orcaWorktrees();
    if (wtsR.ok) {
      const reviewerWt = wtsR.worktrees.find(w => workerWt.childWorktreeIds.includes(w.id) && /审官/.test(w.displayName || ''));
      if (reviewerWt) {
        const t = pickUniqueTerminal(terms, reviewerWt.id, null);
        if (t.ok) return { ok: true, terminal: t.terminal, via: '存量反查（审官· 子卡）' };
      }
    }
  }
  return { ok: false, error: '找不到审官终端（未记录句柄/审官卡，子卡里也没有审官卡）——待帅接手复核' };
}

// ══════════════════════════════════════════════════════════════════════
// 状态文件（游标缓存，GitHub 才是真相源）
// ══════════════════════════════════════════════════════════════════════

function loadState(path) {
  if (!existsSync(path)) return { version: 1, inventoried: false, records: {}, round: 0 };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (!s.records || typeof s.records !== 'object') throw new Error('records 缺失');
    return { version: 1, inventoried: !!s.inventoried, records: s.records, round: Number(s.round) || 0 };
  } catch (e) {
    return { version: 1, inventoried: false, records: {}, round: 0, loadError: String(e.message) };
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** #575 ① / #497：心跳与状态文件同目录（测试写到 tmp，live 写 _flow/heartbeat.json）。 */
function heartbeatPath(stateFile) {
  return join(dirname(stateFile || DEFAULT_STATE), 'heartbeat.json');
}

function writeHeartbeat(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

function heartbeatFromState(state) {
  const prs = [];
  for (const rec of Object.values(state.records || {})) {
    if (!rec || rec.retired || !rec.pendingShuai) continue;
    prs.push({
      number: rec.pr,
      state: rec.pendingShuai.kind || rec.pendingShuai.reason || 'pending',
      sinceMs: rec.pendingShuai.sinceMs ?? null,
    });
  }
  return {
    ts: new Date().toISOString(),
    round: state.round || 0,
    lastWakeSource: 'poll',
    pendingCount: prs.length,
    prs,
  };
}

function freshRecord(pr) {
  return { pr, seenComments: {}, seenReviews: {}, pendingShuai: null, reportedMalformed: {}, reportedStale: false, actedOn: null, reviewer: null, workerWorktree: null };
}

function fingerprint(derived) {
  return `${derived.state}|${derived.redReviews}|${derived.lastSignalId || ''}`;
}

// ══════════════════════════════════════════════════════════════════════
// 数据源（live：gh/orca 实调；快照：录制 JSON；两者接口一致）
// ══════════════════════════════════════════════════════════════════════

function makeLiveSource(repo) {
  return {
    listOpenPrs() {
      const r = runGh(['pr', 'list', '--state', 'open', '--limit', '100', '--json',
        'number,title,isDraft,state,createdAt,updatedAt,mergedAt,headRefName,labels,body']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, prs: r.json };
    },
    getPr(number) {
      const r = runGh(['pr', 'view', String(number), '--json', 'number,title,isDraft,state,createdAt,updatedAt,mergedAt,headRefName,labels,body']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, pr: r.json };
    },
    getComments(number) {
      // #575 ⑥：number 是关联 issue（标题 #N / Closes #N），不是 PR 号。
      // 走 issue comments REST + --paginate；字段映射成 createdAt（完工信号用）。
      const r = runGh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate']);
      if (!r.ok) return { ok: false, error: r.error };
      const comments = (Array.isArray(r.json) ? r.json : []).map(c => ({
        id: c.id,
        body: c.body || '',
        createdAt: c.created_at || c.createdAt || '',
      }));
      return { ok: true, comments };
    },
    getReviews(number) {
      // 红 1（复核）：gh pr view 的 review id 是 GraphQL node id（PRR_...），拼不出真锚点——
      // 返工指令必须给活链接。改走 gh api 直取数字 id + html_url。
      // 注意：--paginate 配 --jq 会逐页输出多段独立 JSON（观察 1：多页时 JSON.parse 必炸）——
      // 所以不带 --jq，让 --paginate 合并成单个数组，字段在 JS 里映射。
      const r = runGh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate']);
      if (!r.ok) return { ok: false, error: r.error };
      const reviews = (Array.isArray(r.json) ? r.json : []).map(rv => ({
        id: rv.id,
        body: rv.body || '',
        submittedAt: rv.submitted_at || '',
        url: rv.html_url || null,
      }));
      return { ok: true, reviews };
    },
    orcaWorktrees() {
      const r = runOrca(['worktree', 'list', '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      const wts = unwrap(r.json, 'worktrees', 'worktrees');
      return Array.isArray(wts) ? { ok: true, worktrees: wts } : { ok: false, error: 'worktree list 结构不认识' };
    },
    orcaTerminals() {
      const r = runOrca(['terminal', 'list', '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      const terms = unwrap(r.json, 'terminals', 'terminals');
      return Array.isArray(terms) ? { ok: true, terminals: terms } : { ok: false, error: 'terminal list 结构不认识' };
    },
  };
}

function readJson(file) {
  if (!existsSync(file)) return { ok: false, error: `缺文件 ${file}` };
  try {
    return { ok: true, json: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, error: `${file} 不是合法 JSON：${String(e.message).split(/\r?\n/)[0]}` };
  }
}

function loadSnapshotRounds(dir) {
  if (!existsSync(dir)) return { ok: false, error: `快照目录不存在：${dir}` };
  const roundSubs = readdirSync(dir).filter(d => /^round-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const dirs = roundSubs.length > 0 ? roundSubs.map(d => join(dir, d)) : [dir];
  return { ok: true, dirs };
}

function makeSnapshotSource(roundDir, repo) {
  return {
    listOpenPrs() {
      const r = readJson(join(roundDir, 'prs.json'));
      if (!r.ok) return r;
      if (!Array.isArray(r.json)) return { ok: false, error: 'prs.json 不是数组' };
      return { ok: true, prs: r.json };
    },
    getPr(number) {
      const r = readJson(join(roundDir, `pr-${number}.json`));
      if (!r.ok) return r;
      return { ok: true, pr: r.json };
    },
    getComments(number) {
      const issueFile = join(roundDir, `issue-${number}-comments.json`);
      const prFile = join(roundDir, `pr-${number}-comments.json`);
      const r = existsSync(issueFile) ? readJson(issueFile) : readJson(prFile);
      return r.ok ? { ok: true, comments: r.json } : { ok: true, comments: [] };
    },
    getReviews(number) {
      const r = readJson(join(roundDir, `pr-${number}-reviews.json`));
      if (!r.ok) return { ok: true, reviews: [] };
      return {
        ok: true,
        // 镜像 live 形态：有 html_url 用真锚点（gh api 口径），没有才退回拼（数字 id 才能拼出活链接）
        reviews: r.json.map(rv => ({
          id: rv.id,
          body: rv.body,
          submittedAt: rv.submitted_at || rv.submittedAt,
          url: rv.html_url || `https://github.com/${repo}/pull/${number}#pullrequestreview-${rv.id}`,
        })),
      };
    },
    orcaWorktrees() {
      const r = readJson(join(roundDir, 'orca-worktrees.json'));
      if (!r.ok) return { ok: true, worktrees: [] };
      const wts = unwrap(r.json, 'worktrees', 'worktrees');
      return Array.isArray(wts) ? { ok: true, worktrees: wts } : { ok: false, error: 'orca-worktrees.json 结构不认识' };
    },
    orcaTerminals() {
      const r = readJson(join(roundDir, 'orca-terminals.json'));
      if (!r.ok) return { ok: true, terminals: [] };
      const terms = unwrap(r.json, 'terminals', 'terminals');
      return Array.isArray(terms) ? { ok: true, terminals: terms } : { ok: false, error: 'orca-terminals.json 结构不认识' };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 动作执行（红 1/2/4/5 落点：目标解析走 source，dry-run 也覆盖解析路径）
// ══════════════════════════════════════════════════════════════════════

function executeAction(action, pr, source, rec, dryRun) {

  if (action.kind === 'inject-rework') {
    const instruction = reworkInstruction(pr, action.red, action.round, action.reviewUrl || null);
    const wtsR = source.orcaWorktrees();
    const workerWt = wtsR.ok ? wtsR.worktrees.find(w => (w.branch || w.git?.branch) === `refs/heads/${pr.headRefName}`) : null;
    const wtErr = !wtsR.ok ? wtsR.error : workerWt ? null : `找不到 branch ${pr.headRefName} 的 worktree`;
    const termsR = source.orcaTerminals();
    let target = null;
    if (workerWt && termsR.ok) target = pickUniqueTerminal(termsR.terminals, workerWt.id, rec.reviewer?.handle || null);
    else if (!termsR.ok) target = { ok: false, error: termsR.error };
    if (dryRun) {
      if (target?.ok) {
        return { ok: true, dry: true, line: `[flow] 动作：返工注入 #${pr.number}（第 ${action.round} 轮，红 ${action.red} 项）（注入目标：工人终端 ${target.terminal.handle}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
      }
      // 观察 1：解析失败不用「动作：」前缀（grep 动作 应只数真实动作），改「预览-阻塞：」
      return { ok: true, dry: true, line: `[flow] 预览-阻塞：#${pr.number}（返工注入——注入目标解析失败：${target?.error || wtErr || '终端列表不可用'}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
    }
    if (!workerWt) return { ok: false, error: `找不到工人终端：${wtErr}` };
    if (!target?.ok) return { ok: false, error: `找不到工人终端：${target.error}` };
    const v = injectAndVerify(target.terminal.handle, instruction, pr.title);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, line: `[flow] 动作：返工注入 #${pr.number}（第 ${action.round} 轮，红 ${action.red} 项）：指令已注入工人终端并验开工（${v.judge}）` };
  }

  if (action.kind === 'inject-recheck') {
    const instruction = recheckInstruction(pr, action.round, action.reviewerLabel || '审官');
    const wtsR = source.orcaWorktrees();
    const workerWt = wtsR.ok ? wtsR.worktrees.find(w => (w.branch || w.git?.branch) === `refs/heads/${pr.headRefName}`) : null;
    const target = wtsR.ok ? findReviewerTerminal(source, pr, rec, workerWt || undefined) : { ok: false, error: wtsR.error };
    // 四轮复核红 1：reviewer-unfound 是「待帅接手复核」的结构性卡住，不是预览工件——
    // dry-run 也走失败路径（写 pendingShuai 常驻），不短路成预览-阻塞
    if (!target?.ok) return { ok: false, error: target.error, needsReport: 'reviewer-unfound' };
    if (dryRun) {
      return { ok: true, dry: true, line: `[flow] 动作：复核注入 #${pr.number}（第 ${action.round} 轮返工后）（复核目标：审官终端 ${target.terminal.handle}${target.via ? '，' + target.via : ''}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
    }
    if (!target?.ok) return { ok: false, error: `找不到审官终端：${target.error}`, needsReport: 'reviewer-unfound' };
    const v = injectAndVerify(target.terminal.handle, instruction, '审官');
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, line: `[flow] 动作：复核注入 #${pr.number}（第 ${action.round} 轮返工后）：复核指令已注入审官终端并验开工（${v.judge}）` };
  }

  return { ok: false, error: `未知动作 ${action.kind}` };
}

// ══════════════════════════════════════════════════════════════════════
// 一轮扫描
// ══════════════════════════════════════════════════════════════════════

// 一轮：返回 { events, noTargets, infraError }；events 是输出行。
// noTargets = 本轮没查成（读不到数据，语义「没扫到」）；infraError = 基础设施失败。
// 两者都要与「扫完 0 需流转」（正常 OK 行）可区分（仓规：数到 0 和没看到样本不是一回事）。
function processOneRound(source, state, args) {
  const events = [];
  const now = Date.now();
  const hbPrs = [];
  let pendingCount = 0;

  const list = source.listOpenPrs();
  if (!list.ok) return { events: [`[flow] NO_TARGETS：${list.error}——本轮没查成`], noTargets: true, infraError: true, heartbeat: emptyHeartbeat(state, now) };
  const open = list.prs;
  const openByNumber = new Map(open.map(p => [p.number, p]));
  const records = state.records;
  let noTargets = false;
  let infraError = false;

  // 退役：上一轮在途、本轮不在 open 列表的 PR → 查终态（MERGED/CLOSED）
  for (const key of Object.keys(records)) {
    const rec = records[key];
    if (openByNumber.has(rec.pr)) continue;
    if (rec.retired) continue;
    const prView = source.getPr(rec.pr);
    const st = prView.ok ? (prView.pr.state || '') : '';
    if (st === 'MERGED') {
      rec.retired = true;
      const bit = noteWorkerMergedLedger(prView.ok ? prView.pr : null, args.dryRun);
      events.push(`[flow] 退役：PR #${rec.pr} MERGED——完工闭环收口（终审+校准+归档归帅）${bit}`);
    } else if (st === 'CLOSED') {
      rec.retired = true;
      events.push(`[flow] 退役：PR #${rec.pr} CLOSED（未合并关闭）`);
    } else if (!prView.ok) {
      noTargets = true;
      events.push(`[flow] NO_TARGETS：读 PR #${rec.pr} 终态失败：${prView.error}——本轮没查成`);
    }
  }

  const awaitingShuai = []; // 红 3：卡着的 PR 每轮常驻显形
  const thisRoundFailed = new Set(); // 三轮复核红 1：本轮解析失败（dry-run 预览，不落盘）

  for (const pr of open) {
    const rec = records[pr.number] || (records[pr.number] = freshRecord(pr.number));
    if (rec.retired) continue;

    const ticket = ticketIssueNumber(pr);
    const commentsR = source.getComments(ticket || pr.number);
    const reviewsR = source.getReviews(pr.number);
    if (!commentsR.ok || !reviewsR.ok) {
      noTargets = true;
      events.push(`[flow] NO_TARGETS：读 PR #${pr.number} 信号失败（${commentsR.ok ? '' : commentsR.error}${reviewsR.ok ? '' : reviewsR.error}）——本轮没查成`);
      continue;
    }
    const comments = commentsR.comments || [];
    const reviews = reviewsR.reviews || [];

    // 判定行缺失/格式不符的 review：逐条报帅（「没查成」，非「无需流转」），不猜红绿
    for (const rv of reviews) {
      if (rec.seenReviews[rv.id]) continue;
      if (rv.id == null) continue;
      const v = judgmentFromReview(rv.body);
      if (v.kind && !v.malformed) continue;
      if (!rec.reportedMalformed[rv.id]) {
        rec.reportedMalformed[rv.id] = true;
        events.push(`[flow] 报帅：判定行缺失/格式不符 #${pr.number}（review id=${rv.id}，无「判定/复核结论」行或红绿都判不出）——本脚本不能确定红绿，没查成，请帅分诊`);
        // 四轮复核红 1：四类状态原因并入 pendingShuai（error 态由 state 兜底也常驻）
        rec.pendingShuai = { kind: 'error', reason: '判定行缺失/格式不符待帅分诊' };
      }
    }

    // 新信号（完工 comment + 全部 review）按时间序重放推导当前态
    const all = orderedSignals(comments, reviews);
    const derived = deriveState(all);
    const fp = fingerprint(derived);
    const lastSig = all[all.length - 1];
    const lastAt = lastSig?.at ? Date.parse(lastSig.at) : Date.parse(pr.updatedAt || pr.createdAt || '');
    const sinceMs = Number.isFinite(lastAt) ? Math.max(0, now - lastAt) : 0;
    hbPrs.push({ number: pr.number, state: derived.state, sinceMs });
    if (pendingAction(derived)) pendingCount += 1;

    // 动作去重：同一指纹只动作一次（重启后存量重放同指纹不重复动作）
    if (rec.actedOn !== fp) {
      // 自愈（三轮复核红 1 + 四轮扩展）：新信号（fp 变化）到来即清除待帅记账给一次重试——
      // fp 去重保证每个新信号至多重试一次，不变成「重试狂发」（首审红 1 底线不破）
      if (rec.pendingShuai) rec.pendingShuai = null;
      const action = pendingAction(derived);
      if (action) {
        if (action.kind === 'report-final') {
          // 复核绿 → 报帅终审（终审 + 校准 + 合并归档归帅，本脚本不自动合并）
          const bit = noteJudgmentClosedLedger(pr, reviews, { success: true, dryRun: args.dryRun });
          events.push(`[flow] 报帅：终审 #${pr.number}（复核结论：绿）——终审 + 校准 + 合并归档归帅，本脚本不自动合并${bit}`);
          rec.pendingShuai = { kind: 'report-final', reason: '复核绿待帅终审' };
          rec.actedOn = fp;
        } else if (action.kind === 'report-switch') {
          // 乒乓两轮仍红 → 报帅换人（换人决策归帅）
          const bit = noteJudgmentClosedLedger(pr, reviews, { success: false, dryRun: args.dryRun });
          events.push(`[flow] 报帅：换人 #${pr.number}（乒乓两轮仍红——两轮返工后第 ${action.round} 次红判定）——换人决策归帅${bit}`);
          rec.pendingShuai = { kind: 'report-switch', reason: '乒乓两轮仍红待帅换人' };
          rec.actedOn = fp;
        } else {
          const extra = {
            reviewUrl: action.kind === 'inject-rework' ? lastReviewUrl(reviews) : null,
            reviewerHandle: rec.reviewer?.handle || null,
            reviewerWorktree: rec.reviewer?.worktree || null,
            reviewerLabel: rec.reviewer?.label || null,
          };
          const exec = executeAction({ ...action, ...extra }, pr, source, rec, args.dryRun);
          if (exec.ok) {
            events.push(exec.line);
            rec.pendingShuai = null; // 动作成功：待帅记账清（四轮复核红 1）
            rec.actedOn = fp;
            if (exec.line.startsWith('[flow] 预览-阻塞')) {
              // dry-run 注入目标解析失败：本轮可见但不落 pendingShuai（三轮复核红 1——
              // 预览不改变值守状态，否则真跑一次预览会把 PR 永久锁死）
              thisRoundFailed.add(pr.number);
            }

          } else {
            // fail-visible：验不过报帅、不重试狂发（#455 连带教训）
            events.push(`[flow] 报帅：${exec.error}——fail-visible，不重试狂发（PR #${pr.number} 待帅处置）`);
            // 待帅记账独立于注入闸（四轮复核红 1）：注入失败 / reviewer-unfound /
            // report-unknown 三处都写 pendingShuai（不 gate 注入，闸已由 fp 去重承担）
            rec.pendingShuai = {
              kind: action.kind,
              reason: exec.needsReport === 'reviewer-unfound' ? '找不到审官终端——待帅接手复核'
                : exec.needsReport === 'report-unknown' ? '选不出审官（缺 model/type 标签或路由表无审查模型）——请帅处置'
                : '注入失败待帅接手（新信号到来自动重试一次）',
            };
            rec.actedOn = fp;
          }
        }
      } else {
        rec.actedOn = fp; // 无需流转：已扫描该态（防止每轮重复推导输出）
      }
    }

    // 新信号记账（动作失败也记账——fail-visible 后不重发，帅持有）
    for (const c of comments) if (c && c.id != null) rec.seenComments[c.id] = true;
    for (const rv of reviews) if (rv && rv.id != null) rec.seenReviews[rv.id] = true;

    // 待帅处置常驻行（红 3）：pendingShuai/approved/error/pingpong/本轮失败每轮显形
    const reason = awaitingShuaiReason(derived, rec, thisRoundFailed.has(pr.number));
    if (reason) awaitingShuai.push({ pr: pr.number, reason });

    // 制度类 PR 停留超 24h 提醒一声（S5 拍板；正文含「体系类改动」段 = 制度类；
    // 用 updatedAt 算停留——天天在推的长战线 PR 不算「停留」，对抗审观察 7）
    if (isInstitutional(pr) && !rec.reportedStale && (pr.updatedAt || pr.createdAt)) {
      const age = Date.now() - Date.parse(pr.updatedAt || pr.createdAt);
      if (age > STALE_24H_MS) {
        rec.reportedStale = true;
        events.push(`[flow] 提醒：制度类 PR #${pr.number} ${pr.title} 已停留超 24h（updatedAt=${pr.updatedAt || pr.createdAt}）——垫片在顶着，请帅安排收口`);
      }
    }
  }

  for (const item of awaitingShuai) {
    events.push(`[flow] 待帅处置：#${item.pr}（${item.reason}）`);
  }

  // 退役记录清除（MERGED/CLOSED 的 PR 不再在途，状态文件不堆积）
  for (const key of Object.keys(records)) {
    if (records[key].retired) delete records[key];
  }

  const scanned = open.length;
  const acted = events.some(e => e.startsWith('[flow] 动作') || e.startsWith('[flow] 预览-阻塞') || e.startsWith('[flow] 报帅') || e.startsWith('[flow] 提醒') || e.startsWith('[flow] 退役') || e.startsWith('[flow] 待帅处置'));
  if (!acted && !noTargets) {
    events.push(`[flow] OK 扫完 ${scanned} 个 PR，0 需流转`);
  }
  return {
    events, noTargets, infraError,
    heartbeat: {
      ts: new Date(now).toISOString(),
      lastWakeSource: 'github-poll',
      pendingCount,
      prs: hbPrs,
    },
  };
}

function emptyHeartbeat(state, now) {
  return {
    ts: new Date(now || Date.now()).toISOString(),
    lastWakeSource: 'github-poll',
    pendingCount: 0,
    prs: [],
  };
}

function lastReviewUrl(reviews) {
  const withUrl = (reviews || []).filter(r => r.url);
  return withUrl.length > 0 ? withUrl[withUrl.length - 1].url : null;
}

// 制度类识别：PR 正文「体系类改动」段为主（PR 模板必答节）；标题兜底只认
// 「制度|体系」不认「拍板」（拍板一词会误伤普通任务 PR，对抗审观察 7）。
function isInstitutional(pr) {
  return /体系类改动/.test(pr.body || '') || /(制度|体系)/.test(pr.title || '');
}

// ══════════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════════

// 纯函数导出（供 tests/flow.tests.js 单测；import 时不执行主流程）
export { deriveState, pendingAction, orderedSignals, completionSignals, reviewSignals, isInstitutional, awaitingShuaiReason, parseOrcaStdout, ticketIssueNumber };

let args = null;
let anyEmitted = false;
let anyNoTargets = false;
let anyInfra = false;
let startupRev = null;

export function main(argv = process.argv.slice(2)) {
  args = parseArgs(argv);
  if (args.snapshotDir) snapshotRun();
  else liveLoop();
  process.exit(anyInfra ? 3 : anyNoTargets ? 2 : anyEmitted ? 1 : 0);
}

function runOneRound(source, state) {
  state.round = (Number(state.round) || 0) + 1;
  const round = processOneRound(source, state, args);
  for (const line of round.events) {
    console.log(line);
    if (line.startsWith('[flow] NO_TARGETS')) anyNoTargets = true;
    else if (!line.startsWith('[flow] OK ')) anyEmitted = true;
  }
  if (round.infraError) anyInfra = true;
  // #575 ① / #580：每轮写心跳，包括 NO_TARGETS——流转器还在跑，缺的是样本不是进程。
  const hb = heartbeatFromState(state);
  if (!args.snapshotDir) {
    const rev = checkGuardRevision({ startup: startupRev, cwd: process.cwd() });
    attachRevision(hb, rev);
    if (rev.alarm) {
      console.log(`[flow] STALE_CODE：${formatRevisionAlarm(rev)}`);
      anyEmitted = true;
    }
  }
  try { writeHeartbeat(heartbeatPath(args.stateFile), hb); }
  catch (e) { console.log(`[flow] HEARTBEAT_WRITE_FAILED：${e && e.message ? e.message : e}——本轮心跳没写成`); }
  saveState(args.stateFile, state);
  return round;
}

function liveLoop() {
  let repo = args.repo;
  if (!repo) {
    const r = runGh(['repo', 'view', '--json', 'nameWithOwner']);
    if (!r.ok) {
      console.log(`[flow] NO_TARGETS：${r.error}——本轮没查成`);
      process.exit(3);
    }
    repo = r.json.nameWithOwner;
  }
  console.log(`# flow live：每 ${args.interval}s 一轮（repo=${repo}${args.dryRun ? '，dry-run 不碰 orca 写操作' : ''}）`);
  startupRev = recordStartupRevision({ cwd: process.cwd() });
  const boot = { ts: new Date().toISOString(), round: 0, lastWakeSource: 'poll', pendingCount: 0, prs: [] };
  const bootRev = checkGuardRevision({ startup: startupRev, cwd: process.cwd() });
  attachRevision(boot, bootRev);
  if (bootRev.alarm) {
    console.log(`[flow] STALE_CODE：${formatRevisionAlarm(bootRev)}`);
    anyEmitted = true;
  }
  try { writeHeartbeat(heartbeatPath(args.stateFile), boot); }
  catch (e) { console.log(`[flow] HEARTBEAT_WRITE_FAILED：${e && e.message ? e.message : e}——启动心跳没写成`); }
  for (;;) {
    const state = loadState(args.stateFile);
    if (state.loadError) {
      console.log(`[flow] NO_TARGETS：状态文件损坏（${state.loadError}）——本轮没查成，先修状态文件`);
      if (args.once) process.exit(2);
      sleep(args.interval * 1000);
      continue;
    }
    if (!state.inventoried) {
      console.log('[flow] 存量清点：首次启动，重放全部在途 PR 信号作为基线（prime 吞存量防线）');
      state.inventoried = true;
    }
    const source = makeLiveSource(repo);
    const round = runOneRound(source, state);
    if (args.once) break;
    sleep(args.interval * 1000);
  }
}

function snapshotRun() {
  const loaded = loadSnapshotRounds(args.snapshotDir);
  if (!loaded.ok) {
    console.log(`[flow] NO_TARGETS：${loaded.error}`);
    process.exit(3);
  }
  const state = loadState(args.stateFile);
  if (state.loadError) {
    console.log(`[flow] NO_TARGETS：状态文件损坏（${state.loadError}）`);
    process.exit(2);
  }
  if (!state.inventoried) {
    console.log('[flow] 存量清点：首次启动，重放全部在途 PR 信号作为基线（prime 吞存量防线）');
    state.inventoried = true;
  }
  const multi = loaded.dirs.length > 1;
  for (const dir of loaded.dirs) {
    if (multi) console.log(`# snapshot round ${basename(dir)}`);
    const source = makeSnapshotSource(dir, args.repo || 'thoerwink8/windsurf-dao');
    runOneRound(source, state);
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === import.meta.filename;
if (isDirectRun) {
  main();
}
