#!/usr/bin/env node
// scripts/flow.mjs —— 闭环自动流转器（#480/#478 改造：换 orca 原生 + 合并权落地）
//
// 架构一句话：**原生消息只做「唤醒 + 寻址」，GitHub 仍是判定与账本的唯一真相源。**
//
// 双输入通道（任一通道单独可用，缺一条不炸）：
//   ① 原生通道：`orca orchestration check --wait --types worker_done,escalation,question`
//      ——替代旧的 `sleep(interval)` 轮询；worker_done 是门铃（payload 只带 reviewId 不带判定），
//      escalation 是「上帅」的 native 侧信号。
//   ② GitHub 兜底通道：check --wait 超时即兜底轮询一轮（`terminal create` 起的、没有 dispatch
//      身份的执行者，完工/判定信号照旧从 GitHub comments/reviews 读出）。
//   check --wait 不是替代状态机，它替代的是 sleep(interval)：两个唤醒源汇进同一套
//   `fingerprint + actedOn` 幂等状态机，不维护两套状态。
//
// 判定真相源（用户拍板 2026-08-15，三条依据写进 PR 正文）：
//   审官把「判定：红 N 项」/「复核结论：绿」写进 GitHub review 正文 = 唯一真相源；
//   worker_done 的 payload 只带 reviewId，作用仅是门铃；流转器收到门铃 → GitHub 重放
//   → JUDGMENT_LINE_RE（scripts/lib/judgment.mjs，行首锚定）判红绿。兜底通道走同一条路径。
//   禁止搜全文：判定行以外的正文（含引用的代码块）一律不算数。
//
// 审官标注行（同进 judgment.mjs 单一真相源，行首锚定）：
//   「上帅：<原因>」→ 停手叫人（review 侧兜底，对应原生 escalation 消息）
//   「同一处未修好」→ 报帅换人信号（#480 S3-1：换人判据从数轮次改成审官标注驱动，不自动换人）
//   「新引入」→ 继续闭环
//   硬兜底 6 轮：只防无限踢皮球，触发上帅，不自动换人（#480 S3-3）。
//
// 合并权（#478，落点 = GitHub 标签 merge/auto，与撤回标签「等你」同域，兜底通道也读得到）：
//   三条件硬查，缺一不合：①最新 review 判定行绿 ②CI 全绿（statusCheckRollup 全部 SUCCESS
//   且至少一条 check——0 条 check ≠ 全绿）③PR 带 merge/auto 标签。
//   外加：带「等你」标签 → 撤回不合（反向不做）；合并前重查一次 mergeable（#478 实战教训：
//   #467 判绿后、合并前被 #466 撞成 CONFLICTING），非 MERGEABLE → 走打回流程；合并失败一律
//   打回人工（comment 写明失败原因 + 打「等你」标签 + 停手不重试）。默认等用户终审——没勾
//   自动合的绿 PR 报帅终审，不自动合。
//
// 流转器停摆可被发现：每轮结束原子写 _flow/heartbeat.json（同 saveState 口径），看门狗
// （#471）读它判「该发生而没发生」。格式契约（本单只写文件 + 立约，看门狗改动在 #471）：
//   {
//     "ts": "<ISO 时间>",              // 本轮结束时刻
//     "round": 42,                     // 轮次（进程内 + 状态文件持久）
//     "lastWakeSource": "native:worker_done" | "native:escalation" | "native:question"
//                        | "github-poll" | "startup" | "snapshot",
//     "pendingCount": 2,               // 有待帅处置的 PR 数（= 该发生而没发生的候选）
//     "prs": [{ "number": 456, "state": "approved", "sinceMs": 12345 }]  // 在途 PR 当前态与停留时长
//   }
//   看门狗判据示例（#471 实现）：state=approved 但 merge 迟迟不发生、且 heartbeat 不再更新
//   （ts 太老）或 pendingCount 长期不为 0 → 报警。
//
// 活性判据禁令（#497 第四轮，实证 #500）：流转器盯工人的活性判据**禁止使用任何屏面形态**——
// 包括屏面指纹、cursor 增量、tui-idle。三者已被实证会被 spinner 动画整体骗过（#500：转圈挂死
// 45 秒涨 21 行全屏面都像活的，恢复后 30 秒 143 行真实内容）。合法判据只有「该发生的事有没有
// 发生」：工人接活超 N 分钟无新 commit、push 后超 N 分钟无新 review、_flow/heartbeat.json 的
// ts 停止更新。实现归 #471，本单只立约。
//
// 保留不动：fingerprint + actedOn 幂等去重、pendingShuai 待帅记账、存量清点（GitHub 重放）、
//   退出码口径、--dry-run / --snapshot-dir 测试通道、isCompletionComment 兜底（无 dispatch
//   身份的工人完工信号）、JUDGMENT_LINE_RE 判定入口、pickReviewer 选型序与 model-routing.toml。
//
// 删掉换原生（#480 对照表）：
//   isCompletionComment 当主通道 → worker_done 门铃（comment 兜底保留）
//   搜 review「上帅：」当主通道 → escalation 消息（review 行兜底保留）
//   sleep(300s) 轮询 → check --wait --timeout-ms N
//   pickUniqueTerminal / findReviewerTerminal（按 title 猜终端、三级反查）→ worker-show --dispatch
//     的 worker.agent_terminal_handle（不猜终端）。#480 实测纠正：send --to dispatch: 是收件箱不是
//     推送——闲置工人不主动 check，投了等于扔进真空且不报错；返工/复核必须 task-create + worker-start --terminal
//   waitTerminalReady / verifyStarted / injectAndVerify（读 cursor、补回车、验开工，约 60 行）
//     → worker-start receipt 的 ready（送达由 orca 保证，不自己读 cursor 补回车）
//   起审官走 worktree create --agent --prompt（自称「受控例外，随 #480 退役」——就是现在）
//     → task-create + worker-start --task <id> --worktree current --agent <cli> --model <id>
//       （Claude 族按 model-routing.toml 真相源走两步：terminal create --command "reclaude ..."
//        再 worker-start --terminal 收口拿 dispatch——dispatch 身份是硬要求，启动通道随 provider）
//
// 映射不出 dispatch 就退回 GitHub 通道，不报错停手：指令投递目标（返工→工人、复核→审官）
//   解析不到 dispatch id 时，输出指令文本 + 挂待帅处置（「找不到 X dispatch——待帅转交」），
//   流转器继续值守其他 PR，不崩不重试狂发。
//
// 退出码（与 watchdog 同口径）：0 扫完 0 需流转 / 1 有动作、报帅或待帅处置 /
// 2 NO_TARGETS（本轮没查成）/ 3 基础设施失败（gh/orca 拉不到、参数错）。
//
// 用法：
//   node scripts/flow.mjs                     值守模式：存量清点一轮 → check --wait（原生门铃，
//                                             默认 300s 超时即 GitHub 兜底轮询）循环
//   node scripts/flow.mjs --once              跑单轮后退出（给测试用）
//   node scripts/flow.mjs --interval 300      check --wait 超时毫秒/秒数（= 兜底轮询间隔）
//   node scripts/flow.mjs --run <runId>       orca orchestration run-use 绑定的 Run（信箱台同款）
//   node scripts/flow.mjs --state-file <path> 状态文件位置（默认 _flow/state.json）
//   node scripts/flow.mjs --heartbeat-file <path> heartbeat 位置（默认 _flow/heartbeat.json）
//   node scripts/flow.mjs --dry-run           只输出动作与将执行的命令，不碰 orca/gh 写操作
//   node scripts/flow.mjs --explain           对每个在途 PR 输出「当前态 + 下一步 + 卡在哪」，
//                                             帅照着人肉执行（只读，不动作）
//   node scripts/flow.mjs --snapshot-dir <dir> 从录制的 gh/orca JSON 快照跑（测试/复现用）
//   node scripts/flow.mjs --repo <nameWithOwner> 显式指定仓库（默认 gh repo view 推断）
//
// 快照目录可选文件（round-N/ 子目录同 watchdog 约定）：
//   prs.json / pr-<N>-comments.json / pr-<N>-reviews.json / pr-<N>.json（gh 侧）
//   orca-messages.json（原生信箱本轮投递的消息，可缺省） / orca-tasks.json（task-list 镜像）

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { judgmentFromReview, isCompletionComment, reviewAnnotations, mergePolicyFromComment, JUDGMENT_LINE_RE_EXPORT as JUDGMENT_LINE_RE } from './lib/judgment.mjs';
import { classifyPr } from './calibrate.mjs';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('./lib/smol-toml.cjs');

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_STATE = join(ROOT, '_flow', 'state.json');
const DEFAULT_HEARTBEAT = join(ROOT, '_flow', 'heartbeat.json');
const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
const ORCA_TIMEOUT_MS = 30000;
const GH_TIMEOUT_MS = 30000;
const CHECK_KEEPALIVE_SLACK_MS = 15000; // check --wait 每 15s 一条 keepalive，spawnSync 超时留余量
const STALE_24H_MS = 24 * 60 * 60 * 1000;

// 合并权标签（#478 拍板：落点 = GitHub 标签，与撤回标签同域）
export const MERGE_AUTO_LABEL = 'merge/auto';
export const WAIT_YOU_LABEL = '等你';
// 硬兜底轮次（#480 S3-3：只防无限踢皮球，触发上帅，不自动换人）
export const RED_FALLBACK_ROUNDS = 6;
// 合并权链断报警阈值（#497 第四轮：comment auto 但 PR 无标签超此时长 → 待帅处置）
export const CHAIN_BROKEN_MS = 15 * 60 * 1000;

// ══════════════════════════════════════════════════════════════════════
// 参数
// ══════════════════════════════════════════════════════════════════════

function printUsage() {
  console.log(`用法：
  node scripts/flow.mjs [--once] [--interval 秒] [--run <runId>] [--state-file <path>]
                        [--heartbeat-file <path>] [--dry-run] [--explain]
                        [--snapshot-dir <目录>] [--repo <nameWithOwner>]

  --once              跑单轮后退出（给测试用）
  --interval <秒>     check --wait 超时（默认 300——超时即 GitHub 兜底轮询）
  --run <runId>       orca orchestration run-use 绑定该 Run（信箱台同款，每轮自夺回）
  --state-file <path> 状态文件位置（默认 _flow/state.json）
  --heartbeat-file <path> heartbeat 位置（默认 _flow/heartbeat.json）
  --dry-run           只输出动作与将执行的命令，不碰 orca/gh 写操作（目标解析仍跑）
  --explain           对每个在途 PR 输出「当前态 + 下一步 + 卡在哪」，只读不动作
  --snapshot-dir <目录> 从录制的 gh/orca JSON 快照跑（测试/复现用），跑完即退出
  --repo <nameWithOwner> 显式指定仓库（默认 gh repo view 推断）`);
}

function parseArgs(argv) {
  const args = {
    once: false, interval: 300, run: null, stateFile: DEFAULT_STATE,
    heartbeatFile: DEFAULT_HEARTBEAT, dryRun: false, explain: false,
    snapshotDir: null, repo: null,
  };
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
      case '--run': args.run = argv[++i] || ''; break;
      case '--state-file': args.stateFile = resolve(process.cwd(), argv[++i] || ''); break;
      case '--heartbeat-file': args.heartbeatFile = resolve(process.cwd(), argv[++i] || ''); break;
      case '--dry-run': args.dryRun = true; break;
      case '--explain': args.explain = true; break;
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
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
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
  try {
    return { ok: true, json: JSON.parse(r.out) };
  } catch (e) {
    return { ok: false, error: `orca 输出不是 JSON：${e.message}` };
  }
}

function unwrap(json, pathKey, topKey) {
  const viaPath = json?.result?.[pathKey];
  if (Array.isArray(viaPath)) return viaPath;
  if (Array.isArray(json?.[topKey])) return json[topKey];
  return null;
}

// 原子写（state 与 heartbeat 同口径）：先写 .tmp 再 rename，看门狗读到的要么旧要么新，不会半截。
function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, path);
}

function hasLabel(pr, name) {
  return Array.isArray(pr?.labels) && pr.labels.some(l => (l.name || l) === name);
}

// ══════════════════════════════════════════════════════════════════════
// orca JSON 返回字段提取（#497 第四轮：真实返回契约，防「自造夹具自洽」）
//
// 真实返回已采集到 tests/fixtures/orca-returns/（采集时间 2026-08-15 22:41-22:44
// 北京时；task-create 为本会话实跑，其余见 PR 正文）。字段路径以实测/帅核实为准：
//   task-create    → result.task.id（实测三次一致；result.id 是 RPC id、json.task.id 不存在——
//                    旧代码两路全错，taskId 恒 null 使整个闭环一行都跑不起来）
//   worker-start   → result.dispatch.id | result.dispatchId（帅核实 ✅）
//   worker-show    → result.worker.agent_terminal_handle（实测 ✅）
//   dispatch-show  → result.dispatch.id（帅核实 ✅）
//   task-list      → result.tasks（实测 ✅）
//   worktree create→ result.worktree.id（实测 ✅）
//   terminal create→ result.terminal.handle（实测 ✅）
// 任何消费点不得在别处再写一份提取链——改这里一处，tests 用真实夹具锁住。
// ══════════════════════════════════════════════════════════════════════
export function taskIdFromTaskCreate(json) { return json?.result?.task?.id || null; }
export function dispatchIdFromWorkerStart(json) { return json?.result?.dispatch?.id || json?.result?.dispatchId || null; }
export function handleFromWorkerShow(json) { return json?.result?.worker?.agent_terminal_handle || json?.result?.worker?.agentTerminalHandle || null; }
export function dispatchIdFromDispatchShow(json) { return json?.result?.dispatchId || json?.result?.dispatch?.id || json?.dispatchId || null; }
export function worktreeIdFromWorktreeCreate(json) { return json?.result?.worktree?.id || null; }
export function terminalHandleFromTerminalCreate(json) { return json?.result?.terminal?.handle || null; }

// ══════════════════════════════════════════════════════════════════════
// 信号提取（纯函数，快照与 live 共用）
// ══════════════════════════════════════════════════════════════════════

// 完工信号：PR comment 首行命中「完工」或「返工(完成|处置)」——GitHub 兜底通道；
// 有 dispatch 身份的工人走 worker_done 门铃（nativeCompletionSignals），两路汇进同一状态机。
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

// worker_done 门铃映射出的完工信号（dispatchMap 建好 taskId→PR 后，每个已映射的
// 工人 worker_done 补一条 completion 事件，id 用 dispatchId 去重）。GitHub 侧没有完工 comment
// 时，门铃就是完工信号；两边都有也不重复动作（deriveState 对连续 completion 幂等）。
// 审官的 worker_done 只是门铃（payload 带 reviewId），不是完工信号——跳过。
// at 用空串：完工事件必须排在 review 之前（工人先完工、审官后评审）。
function nativeCompletionSignals(messages, dispatchMap) {
  const out = [];
  for (const m of messages || []) {
    if (String(m.type || '').toLowerCase() !== 'worker_done') continue;
    const taskId = m.task_id || m.taskId || m.payload?.taskId || null;
    if (!taskId) continue;
    const pr = dispatchMap.prByTaskId[taskId];
    if (!pr) continue; // 映射不出 dispatch 就退回 GitHub 通道，不报错停手
    const entry = (dispatchMap.tasksByPr?.[pr] || []).find(e => e.taskId === taskId);
    if (entry?.isReviewer) continue; // 审官门铃不是完工
    out.push({
      type: 'completion',
      id: `w:${m.dispatch_id || m.dispatchId || taskId}`,
      at: '',
      body: `worker_done：${m.subject || ''}`,
      viaNative: true,
    });
  }
  return out;
}

function reviewSignals(reviews) {
  const out = [];
  for (const r of reviews || []) {
    if (!r || r.id == null) continue;
    const v = judgmentFromReview(r.body);
    const ann = reviewAnnotations(r.body);
    out.push({
      type: 'review', id: `r:${r.id}`, at: r.submittedAt || '', body: r.body,
      verdict: v, url: r.url || null,
      shangShuai: ann.shangShuai, sameSpot: ann.sameSpot, newIntroduced: ann.newIntroduced,
    });
  }
  return out;
}

function orderedSignals(comments, reviews, native, dispatchMap) {
  return [...completionSignals(comments), ...nativeCompletionSignals(native, dispatchMap || { prByTaskId: {} }), ...reviewSignals(reviews)]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 由全部信号推导当前态（纯函数，每轮重放——存量清点即此步）：
//   working → awaiting-review（完工，无审）→ rework-needed（红 N，待返工）
//   → awaiting-recheck（返工完成，待复核）→ approved（复核绿）
//   switch = 最新 review 标「同一处未修好」（报帅换人信号，不自动换人）
//   shang-shuai = 最新 review 标「上帅：」或 红判定累计 ≥ 6 轮（硬兜底，停手叫人，不再自动流转）
//   error = 存在判定行缺失/格式不符的 review（报帅分诊，不作为红/绿处理）。
// 标注取「最新 review」：帅处置后审官再判，新的判定行接管状态（上帅 只挡「它仍是最近信号」时）。
function deriveState(signals) {
  let state = 'working';
  let redReviews = 0;
  let lastRed = null;
  let lastSignalId = null;
  let latest = null; // 最新 review 的标注
  for (const sig of signals) {
    lastSignalId = sig.id;
    if (sig.type === 'completion') {
      if (state === 'working') state = 'awaiting-review';
      else if (state === 'rework-needed') state = 'awaiting-recheck';
      continue;
    }
    // 标注对任何 review 都适用（上帅：行可单独出现、不写判定行）；每条 review 都刷新
    // latest——最新 review 无标注即清空，避免旧标注粘住新态
    latest = { shangShuai: sig.shangShuai ?? null, sameSpot: !!sig.sameSpot, newIntroduced: !!sig.newIntroduced };
    const v = sig.verdict;
    // 判定行缺失（kind=null）或格式不符（红绿都判不出）→ 报帅分诊，不作为红/绿处理
    if (!v.kind || v.malformed) {
      if (!sig.shangShuai && !sig.sameSpot) state = 'error';
      continue;
    }
    if (v.green) { state = 'approved'; lastRed = null; continue; }
    redReviews += 1;
    lastRed = v.red;
    state = 'rework-needed';
  }
  // 标注覆盖 + 硬兜底（优先级：上帅 > 六轮 > 同一处未修好）
  if (latest?.shangShuai) state = 'shang-shuai';
  else if (redReviews >= RED_FALLBACK_ROUNDS) state = 'shang-shuai';
  else if (latest?.sameSpot) state = 'switch';
  return { state, redReviews, lastRed, lastSignalId, latestAnnotation: latest };
}

// 状态白名单（#497 第五轮：任何 PR 在任何时刻都必须落在某一类里，且要有一个「未归类」兜底类
// 而不是让它消失。白名单外的状态 = 设计时没想到的组合，必须报警——漏掉的永远是没想到的那个）。
// pendingAction 与 awaitingShuaiReason 共用同一集合，两处各自维护就又会不一致。
const KNOWN_FLOW_STATES = new Set([
  'working',          // 工人干活中，无待办
  'awaiting-review',  // 等审官复核（动作：start-reviewer）
  'awaiting-recheck', // 等复核注入（动作：inject-recheck）
  'rework-needed',    // 返工（动作：inject-rework）
  'approved',         // 复核绿（动作：merge-gate）
  'switch',           // 审官标注「同一处未修好」（动作：report-switch）
  'shang-shuai',      // 上帅：停手，报帅覆盖
  'error',            // 判定行缺失：停手，报帅覆盖
]);

// 当前态的待办动作（纯函数）：null = 无需流转（扫完 0 需流转）。
// 注入重试的闸是 actedOn 指纹去重（每个新信号至多一次，不重试狂发）；
// pendingShuai 只记账不 gate——它管「有没有人还欠一个动作」的显示。
function pendingAction(derived) {
  if (derived.state === 'working') return null;
  if (derived.state === 'awaiting-review') return { kind: 'start-reviewer', round: 0 };
  if (derived.state === 'awaiting-recheck') return { kind: 'inject-recheck', round: derived.redReviews };
  if (derived.state === 'rework-needed') return { kind: 'inject-rework', red: derived.lastRed, round: derived.redReviews };
  if (derived.state === 'approved') return { kind: 'merge-gate' };
  if (derived.state === 'switch') return { kind: 'report-switch', round: derived.redReviews };
  if (derived.state === 'shang-shuai' || derived.state === 'error') return null; // 停手/报帅，由 awaitingShuaiReason + 待帅处置常驻行覆盖
  // 白名单外 = 设计时没想到的状态组合：不静默消失，报警待帅分诊
  return { kind: 'unclassified', state: derived.state };
}

// 待帅处置原因（红 3：卡着的 PR 每轮都要显形，不能报一次就转绿）
// rec.pendingShuai = 独立于注入闸的待帅记账；清除时机与自愈同步（fp 变化重试时清、动作成功时清）。
function awaitingShuaiReason(derived, rec, thisRoundFailed) {
  if (rec.pendingShuai) {
    // 链断由 chainWatch 自己的常驻行显形（每轮一条），防止与 PR 循环再各出一条
    if (rec.pendingShuai.kind === 'chain-broken') return null;
    return rec.pendingShuai.reason;
  }
  if (derived.state === 'approved') {
    if (rec.mergeAttempted && !rec.mergeBlocked) return null; // 合并动作已发起，等 GitHub 收口
    return '复核绿待帅终审';
  }
  if (derived.state === 'working') return null; // 工人干活中：无待办（白名单）
  if (derived.state === 'error') return '判定行缺失/格式不符待帅分诊';
  if (derived.state === 'switch') return '审官标注「同一处未修好」待帅换人';
  if (derived.state === 'shang-shuai') {
    if (derived.latestAnnotation?.shangShuai) return `上帅：${derived.latestAnnotation.shangShuai}——停手叫人，不再自动流转`;
    if (derived.redReviews >= RED_FALLBACK_ROUNDS) return `六轮红判定兜底上帅（第 ${derived.redReviews} 次红判定）——停手叫人，不自动换人`;
    return '上帅——停手叫人，不再自动流转';
  }
  if (thisRoundFailed) return '投递/目标解析失败待帅确认（本轮，未落闸）';
  if (KNOWN_FLOW_STATES.has(derived.state)) return null; // 白名单内且动作表覆盖（awaiting-* 动作成功/失败已记账）
  return `落入未归类状态 ${derived.state}——设计时没想到的状态组合，请帅分诊`; // 白名单外：必须给原因，不能 null 消失
}

// ══════════════════════════════════════════════════════════════════════
// 审官选型序（docs/model-routing.toml 真相源）
// ══════════════════════════════════════════════════════════════════════

function loadRouting() {
  if (!existsSync(ROUTING_FILE)) return { ok: false, error: `${ROUTING_FILE} 不存在` };
  try {
    return { ok: true, toml: parseToml(readFileSync(ROUTING_FILE, 'utf8')) };
  } catch (e) {
    return { ok: false, error: `${ROUTING_FILE} 解析失败：${String(e.message || e).split(/\r?\n/)[0]}` };
  }
}

// 审官选型序（规则「审官选型序」+「审查默认换厂商」+ bans[gpt UI 类]）：
//   候选 = roles 含「审查」的模型；UI/复审类 → GPT 禁入；工人是 gpt 厂商 → GPT 排除
//   （审查必换厂商）；结果按「GPT 优先、Claude(Opus) 次之」取第一个。
function pickReviewer(toml, workerModelId, taskType) {
  const models = Array.isArray(toml.models) ? toml.models : [];
  const worker = models.find(m => m.id === workerModelId);
  const workerProvider = worker ? worker.provider : null;
  const uiLike = /UI|复审/.test(taskType || '');
  const isGpt = m => m.provider === 'gpt' || /^gpt/i.test(m.id || '');
  const candidates = models.filter(m => Array.isArray(m.roles) && m.roles.includes('审查'));
  let pool = candidates.filter(m => !(uiLike && isGpt(m)));
  if (workerProvider === 'gpt' || /^gpt/i.test(workerModelId || '')) pool = pool.filter(m => !isGpt(m));
  return pool.find(m => isGpt(m)) || pool.find(m => !isGpt(m)) || null;
}

// 审官启动配方（provider 真相源 = model-routing.toml providers，只允许有 dispatch 身份的路径）：
//   gpt → worker-start --agent codex --model <id>（fresh terminal in current worktree）
//   claude → model-routing.toml 实证：--agent 起不了 reclaude 链，须两步——
//            task-create + worktree create（--setup skip）+ terminal create --command "reclaude --model opus"
//            + worker-start --task <id> --worktree <卡 id> --terminal <handle> 收口拿 dispatch。
//   其他 provider 不在审查角色（pickReviewer 选不到）——不写启动配方，免得命令看似生效实则从未执行。
function reviewerLaunch(reviewer) {
  if (reviewer.provider === 'gpt') return { twoStep: false, agent: 'codex', model: reviewer.id };
  if (reviewer.provider === 'claude') return { twoStep: true, agent: 'claude', model: reviewer.id, command: 'reclaude --model opus' };
  return null;
}

function reviewerLabel(reviewer) {
  return reviewer.provider === 'claude' ? '审官·Claude' : `审官·${reviewer.id}`;
}

// ══════════════════════════════════════════════════════════════════════
// 动作文本（决策输出，人读 + 机器可 grep）
// ══════════════════════════════════════════════════════════════════════

function reviewTaskBook(pr, reviewerLabel) {
  return [
    `【复核任务书 · 闭环自动流转 · ${reviewerLabel}】`,
    `任务 PR：#${pr.number} ${pr.title}`,
    '请审读本 PR 的 diff 与正文（规格源引用、完工自报、验收清单），逐条核对验收标准。',
    '判定格式（机器可读，写在 review 正文首行，行首锚定）：',
    '  首审：「判定：红 N 项」或「判定：绿」',
    '  复核：「复核结论：红 N 项」或「复核结论：绿，可合并」',
    '标注行（review 正文任意位置，行首锚定）：',
    '  「上帅：<原因>」= 质疑拍板/规格本身或需帅决策 → 流转器停手叫人',
    '  「同一处未修好」= 本轮红项与前几轮同一处反复 → 报帅换人信号（不自动换人）',
    '  「新引入」= 本轮红项是新引入的问题 → 继续闭环',
    '同账号不能 request-changes，以 COMMENT 提交 review。红项逐条列明；质疑拍板/规格本身要上帅，不自行改判。',
  ].join('\n');
}

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
// 投递（task-create + worker-start --terminal；#480 实测纠正：send --to dispatch: 是收件箱
// 不是推送——正在干活/已 worker_done 闲置的工人都不会主动 check，等于扔进真空且不报错。
// 正解 = 手册「Preferred Supervised Worker Loop」：复用同一 agent 终端跑后续任务，
// worker-start --task <新> --terminal <handle>，Orca 把新 TASK 块作为终端输入推给工人。
// handle 从 worker-show --dispatch <id> 的 worker.agent_terminal_handle 取——
// 仍然免掉旧代码 pickUniqueTerminal 按 title 猜终端那一整套；verifyStarted 照删（worker-start
// 返回 receipt，送达由 orca 保证）。映射不出就退回 GitHub 通道，不报错停手。)
// ══════════════════════════════════════════════════════════════════════

// 从任务书 spec 提取 PR 号：#N 或 PR #N / 任务 PR：#N。spec 里可能带多个号
// （如「Closes #480 #478」），只认能唯一对应一个 PR 的（任务卡按「#PR号 - 动宾短语」命名，
// 首号通常就是 PR）。返回去重后的号列表。
function extractPrsFromSpec(spec) {
  const out = [];
  const re = /(?:PR\s*)?#(\d+)/g;
  let m;
  while ((m = re.exec(String(spec || '')))) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// 建 taskId→PR / PR→dispatch 映射（live：task-list + dispatch-show；快照：orca-tasks.json）。
// 快照条目形态：{ id, spec, dispatchId }；live 的 dispatchId 经 dispatch-show 取（惰性）。
// 审官任务 = 本脚本 task-create 建的（spec 含「审官任务：#N - 审官·」标记）。
function buildDispatchMap(source, state) {
  const map = { prByTaskId: {}, tasksByPr: {}, dispatchIdFor: source.dispatchIdFor || null };
  const tasksR = source.orcaTasks();
  const tasks = tasksR.ok ? tasksR.tasks : [];
  for (const t of tasks) {
    const id = t.id || t.taskId || null;
    const spec = t.spec || t.title || '';
    if (!id) continue;
    const prs = extractPrsFromSpec(spec);
    const isReviewer = /审官任务/.test(spec);
    for (const n of prs) {
      if (!map.tasksByPr[n]) map.tasksByPr[n] = [];
      map.tasksByPr[n].push({ taskId: id, spec, isReviewer, dispatchId: t.dispatchId || t.dispatch_id || null, agentTerminalHandle: t.agentTerminalHandle || t.agent_terminal_handle || null });
    }
    if (prs.length === 1) map.prByTaskId[id] = prs[0];
    // 有状态文件里记过的 dispatchId（doorbell/worker-start 收的）优先
    const cached = state.dispatchCache?.[id];
    if (cached) {
      for (const n of prs) {
        const entry = map.tasksByPr[n]?.find(e => e.taskId === id);
        if (entry) entry.dispatchId = entry.dispatchId || cached;
      }
    }
  }
  return map;
}

function resolveDispatchId(map, entry) {
  if (!entry) return null;
  if (entry.dispatchId) return entry.dispatchId;
  if (map.dispatchIdFor && entry.taskId) {
    const d = map.dispatchIdFor(entry.taskId);
    if (d) { entry.dispatchId = d; return d; }
  }
  return null;
}

// 找 PR 的工人 dispatch（①rec.workerDispatch 当前工人上下文 ②唯一非审官任务）；
// 多候选/零候选 → null（待帅转交）。
function workerDispatchFor(map, prNumber, rec) {
  if (rec?.workerDispatch) return rec.workerDispatch;
  const list = (map.tasksByPr[prNumber] || []).filter(e => !e.isReviewer);
  if (list.length !== 1) return null;
  return resolveDispatchId(map, list[0]);
}

// 找 PR 的审官 dispatch：①起审官时记的 rec.reviewer.dispatchId ②审官任务候选（唯一）
function reviewerDispatchFor(map, prNumber, rec) {
  if (rec.reviewer?.dispatchId) return rec.reviewer.dispatchId;
  const list = (map.tasksByPr[prNumber] || []).filter(e => e.isReviewer);
  if (list.length !== 1) return null;
  return resolveDispatchId(map, list[0]);
}

// dispatch id → 终端 handle：①map 条目自带（快照便捷）②live worker-show --dispatch
// 的 worker.agent_terminal_handle。取不到 → 待帅转交（不猜终端、不按 title 猜）。
function resolveDeliveryHandle(source, map, dispatchId) {
  if (!dispatchId) return { ok: false, error: '无 dispatch id' };
  for (const pr of Object.keys(map.tasksByPr || {})) {
    const hit = (map.tasksByPr[pr] || []).find(e => e.dispatchId === dispatchId && e.agentTerminalHandle);
    if (hit) return { ok: true, handle: hit.agentTerminalHandle };
  }
  const h = source.workerHandleFor ? source.workerHandleFor(dispatchId) : null;
  if (h) return { ok: true, handle: h };
  return { ok: false, error: `worker-show --dispatch ${dispatchId} 取不到 agentTerminalHandle——待帅转交` };
}

// 投递后续任务：task-create（任务书）→ worker-start --task <新> --terminal <handle>。
// 返回 { taskId, dispatchId }（新 dispatch 上下文，record 里替换旧引用）。
function deliverFollowUp(taskSpec, handle, args) {
  const tc = runOrca(['orchestration', 'task-create', '--spec', taskSpec, '--json']);
  if (!tc.ok) return { ok: false, error: `task-create 失败：${tc.error}` };
  const taskId = taskIdFromTaskCreate(tc.json);
  if (!taskId) return { ok: false, error: 'task-create 成功响应但缺 task id（结构畸形）' };
  const ws = runOrca(['orchestration', 'worker-start', '--task', taskId, '--terminal', handle, '--json']);
  if (!ws.ok) return { ok: false, error: `worker-start --terminal 失败：${ws.error}` };
  const dispatchId = dispatchIdFromWorkerStart(ws.json);
  return { ok: true, taskId, dispatchId };
}

// ══════════════════════════════════════════════════════════════════════
// 合并三条件 + 合并前重查 mergeable + 打回人工（#478 拍板）
// ══════════════════════════════════════════════════════════════════════

// CI 态（纯函数）：statusCheckRollup 全部 SUCCESS 且至少一条 check ——「0 条 check」≠「全绿」
// （仓规：分不开「扫完查出 0 条」和「这次没扫到样本」就会把没查成当查过没事）。
export function ciState(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  const red = [];
  for (const c of list) {
    const ok = c.conclusion === 'SUCCESS' || c.state === 'SUCCESS';
    if (!ok) red.push(c.name || c.context || c.__typename || '?');
  }
  return {
    count: list.length,
    allGreen: list.length > 0 && red.length === 0,
    redNames: red.join('、'),
  };
}

// 合并门（纯函数）：三条件硬查 + 「等你」撤回（#478 Q4）。缺一不合。
//   返回 { ok:true } 或 { ok:false, reason }；reason 直接进报帅/待帅处置行。
export function mergeGate(pr, ci) {
  if (hasLabel(pr, WAIT_YOU_LABEL)) return { ok: false, reason: '带「等你」标签——撤回，不合' };
  if (!hasLabel(pr, MERGE_AUTO_LABEL)) return { ok: false, reason: '无 merge/auto 标签——等用户终审' };
  if (pr.isDraft) return { ok: false, reason: 'PR 仍是 draft——等 ready，不合' };
  if (ci.count === 0) return { ok: false, reason: 'CI 0 条 check——没查成≠全绿，不合' };
  if (!ci.allGreen) return { ok: false, reason: `CI 未全绿（${ci.redNames}）——不合` };
  return { ok: true };
}

// 合并前重查 mergeable（#478 实战教训：#467 判绿后、合并前被 #466 撞成 CONFLICTING）：
//   MERGEABLE → 可合；UNKNOWN → GitHub 还在算，下轮重查（瞬态，不打回误伤）；
//   其余（CONFLICTING/DIRTY/BLOCKED 等）→ 打回人工。
export function mergeableVerdict(mergeable, mergeStateStatus) {
  if (mergeable === 'MERGEABLE') return { ok: true };
  if (mergeable === 'UNKNOWN' || mergeable == null || mergeable === '') {
    return { ok: false, wait: true, reason: `mergeable=${mergeable || '未知'}（GitHub 还在算）——下轮重查` };
  }
  return { ok: false, reason: `mergeable=${mergeable}${mergeStateStatus ? `，mergeStateStatus=${mergeStateStatus}` : ''}——打回人工` };
}

// 合并门第四条（#497 第八轮）：判绿的 commit 必须等于当前 HEAD——审官判绿后又推了几轮，
// 流转器看到「绿 + CI 绿 + 标签」直接合 = 合并未经审读的代码（本单自己就是活样本：
// 审官判绿在 cc53837、HEAD 在 c73b0e4，差一点被合，拦住的是人眼看时间戳不是机制）。
// 数据来源是 GitHub review 对象自带字段（commit_id），不解析文本。
// 取最新一条带判定行的 review（JUDGMENT_LINE_RE 判），不是最新 review（中间可能有不带判定行的普通评论）。
// 四种情形必须分开报：
//   1 相等 → 放行；2 review commit 是 HEAD 祖先 → 不合（判绿后又推 N 个 commit，需重新复核）；
//   3 不在 HEAD 历史（rebase 重写）→ 不合，**不给 N**（A..B 计数在重写后是看起来精确的假数，比不给更糟）；
//   4 commit_id 缺失 / 判不出关系 → 不合（没查成）——禁止「查不到就当通过」。
export function greenCommitVerdict(reviews, headRefOid, isAncestorProbe) {
  const judged = (reviews || []).filter(r => r && r.body && JUDGMENT_LINE_RE.test(r.body));
  if (judged.length === 0) return { ok: false, kind: 'unreadable', reason: '没查到带判定行的 review——没查成' };
  const latest = judged[judged.length - 1];
  const commitId = latest.commitId;
  if (!commitId) return { ok: false, kind: 'unreadable', reason: '判绿 review 的 commit_id 缺失——没查成' };
  if (commitId === headRefOid) return { ok: true };
  const rel = isAncestorProbe(commitId, headRefOid); // { ancestor: true|false|null, count: n|null }
  if (rel && rel.ancestor === true) {
    const n = rel.count ?? revListCount(commitId, headRefOid);
    return { ok: false, kind: 'ahead', reason: `判绿后又推了 ${n} 个 commit，需重新复核`, n };
  }
  if (rel && rel.ancestor === false) {
    return { ok: false, kind: 'rewritten', reason: '判绿的 commit 已被 rebase 重写，与当前 HEAD 无共同历史，需重新复核' };
  }
  return { ok: false, kind: 'unreadable', reason: '判绿 commit 与当前 HEAD 的关系判不出——没查成' };
}

// 祖先判定（仓规：检查逻辑不得复用被检查对象自己的解析逻辑——用 git 外部真相，不 import flow 的提交历史逻辑）：
// git merge-base --is-ancestor <commit> <head>：exit 0 = 祖先；exit 1 = 非祖先；fatal = 对象取不到。
// 对象不在本地（新 clone / rebase 后被 gc）→ fetch 一次再判，仍取不到 → null（判不出，走情形 4）。
// 返回 { ancestor, count }：count 只在 ancestor=true 时有意义（判绿后又推的 commit 数）。
function gitIsAncestor(commit, head, args) {
  const probe = (c, h) => runCmd('git', ['merge-base', '--is-ancestor', c, h]);
  let r = probe(commit, head);
  if (!r.ok && /fatal|unknown revision|not a valid/i.test(r.error)) {
    // 对象不在本地（CI 浅 clone 只取 HEAD / 新 clone / rebase 后被 gc）→ 两个对象都 fetch 一次再判。
    // 只 fetch review commit 不够：浅仓连 headRefOid 对象也没有，probe 仍会 fatal。
    runCmd('git', ['fetch', 'origin', commit, head]);
    r = probe(commit, head);
    if (!r.ok && /fatal|unknown revision|not a valid/i.test(r.error)) return { ancestor: null, count: null };
  }
  if (!r.ok) return { ancestor: false, count: null }; // exit 1 = 非祖先（rebase 重写）
  return { ancestor: true, count: revListCount(commit, head) };
}

function revListCount(from, head) {
  const r = runCmd('git', ['rev-list', '--count', `${from}..${head}`]);
  const n = parseInt(String(r.ok ? r.out : '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// 打回人工（#478 Q5）：comment 写明失败原因 + 打「等你」标签 + 停手不重试（等你 标签天然停手）。
function blockToHuman(lines, pr, reason, args, repo) {
  const body = [
    '【流转器打回人工】',
    `PR #${pr.number} 自动合并失败：${reason}`,
    '已打「等你」标签，流转器停手不重试。冲突/CI 需人工处置（解冲突按「rebase 只做合并不改逻辑」）。',
  ].join('\n');
  if (!args.dryRun) {
    // 正文不走 shell 字符串拼接：先写文件再 --input（本仓 2026-08-15 实测教训）
    const tmp = join(dirname(args.stateFile), `.flow-comment-${pr.number}.json`);
    writeJsonAtomic(tmp, { body });
    runGh(['api', `repos/${repo}/issues/${pr.number}/comments`, '--input', tmp]);
    try { runGh(['pr', 'edit', String(pr.number), '--add-label', WAIT_YOU_LABEL]); } catch { /* label 缺就缺，不重试 */ }
    try { runGh(['label', 'create', WAIT_YOU_LABEL]); } catch { /* 已存在幂等 */ }
  }
  lines.push(`[flow] 打回人工：#${pr.number}（${reason}）——comment + 「等你」标签 + 停手不重试`);
}

// 复核绿的处理（每轮重查，合并只做一次；gate 的输入 CI/标签/mergeable 会在无新信号时变化，
// 所以不走 fp 去重，靠 rec.mergeAttempted / rec.mergeBlocked 防重）
function handleApproved(pr, rec, source, args, repo) {
  const lines = [];
  const gateR = source.getPrGate(pr.number);
  if (!gateR.ok) return { lines: [`[flow] NO_TARGETS：读 PR #${pr.number} 合并门数据失败：${gateR.error}——本轮没查成`], noTargets: true };
  const gpr = gateR.pr;
  const ci = ciState(gpr.statusCheckRollup);
  const gate = mergeGate(gpr, ci);

  if (!gate.ok) {
    // 缺一不合：报帅/待帅处置，不合并。但合并前重查 mergeable 不只属于「准备合并」——
    // 判绿 + 冲突恰恰是最该被看见的状态（#497 第五轮实证：#497 判绿且 CONFLICTING 时走的是
    // 「只通知不合」分支，没到重查那步，结果从所有类别里掉出去，用户以为能终审、真合才发现冲突）。
    // 所以无论走不走自动合都查一次 mergeable 并说清，三态可分：
    //   MERGEABLE → 现状文案（待终审）；CONFLICTING/DIRTY → 冲突提示 + 待帅处置常驻（压过温和文案）；
    //   UNKNOWN → 瞬态（GitHub 还在算），不打回，文案带一句下轮重查。
    const verdict = mergeableVerdict(gpr.mergeable, gpr.mergeStateStatus);
    const reason = `复核结论：绿，${gate.reason}`;
    if (!verdict.ok && !verdict.wait) {
      const conflictNote = `；且 mergeable=${gpr.mergeable}${gpr.mergeStateStatus ? `（${gpr.mergeStateStatus}）` : ''}——有冲突，需 rebase 后才能合`;
      lines.push(`[flow] 报帅：终审 #${pr.number}（${reason}${conflictNote}）`);
      rec.pendingShuai = { kind: 'approved', reason: `复核绿但有冲突，需 rebase 后才能合（${gate.reason}）` };
      return { lines };
    }
    if (verdict.wait) {
      lines.push(`[flow] 报帅：终审 #${pr.number}（${reason}；mergeable 还在算，下轮重查）`);
      rec.pendingShuai = { kind: 'approved', reason: `复核绿待帅终审（${gate.reason}；mergeable 还在算）` };
      return { lines };
    }
    lines.push(`[flow] 报帅：终审 #${pr.number}（${reason}）`);
    rec.pendingShuai = { kind: 'approved', reason: `复核绿待帅终审（${gate.reason}）` };
    return { lines };
  }

  // 三条件齐 → 第四条（#497 第八轮）：判绿的 commit 必须等于当前 HEAD——防合并未经审读的代码
  const reviewsR = source.getReviews(pr.number);
  if (!reviewsR.ok) {
    return { lines: [`[flow] NO_TARGETS：读 PR #${pr.number} reviews 失败：${reviewsR.error}——第四条没查成`], noTargets: true };
  }
  const greenVerdict = greenCommitVerdict(reviewsR.reviews, gpr.headRefOid, gitIsAncestor);
  if (!greenVerdict.ok) {
    const reason = `复核结论：绿，${greenVerdict.reason}`;
    lines.push(`[flow] 报帅：终审 #${pr.number}（${reason}）`);
    rec.pendingShuai = { kind: 'approved', reason: `复核绿但未达合并条件（${greenVerdict.reason}）` };
    return { lines };
  }

  // 四条件齐 → 合并前重查 mergeable
  const verdict = mergeableVerdict(gpr.mergeable, gpr.mergeStateStatus);
  if (!verdict.ok) {
    if (verdict.wait) {
      lines.push(`[flow] 通知：终审 #${pr.number}（复核绿 + CI 全绿 + merge/auto，${verdict.reason}）`);
      rec.pendingShuai = { kind: 'approved', reason: `复核绿待合并（${verdict.reason}）` };
      return { lines };
    }
    rec.mergeBlocked = true;
    rec.pendingShuai = { kind: 'merge-blocked', reason: '合并前重查 mergeable 失败——打回人工，等你 标签停手不重试' };
    blockToHuman(lines, pr, verdict.reason, args, repo);
    return { lines };
  }

  if (rec.mergeBlocked || rec.mergeAttempted) return { lines }; // 停手不重试 / 已尝试过
  rec.mergeAttempted = true;
  rec.pendingShuai = null; // 合并动作已发起：不再欠待帅
  if (args.dryRun) {
    lines.push(`[flow] 动作：合并 #${pr.number}（复核绿 + CI 全绿 + merge/auto + MERGEABLE）：gh pr merge ${pr.number} --squash`);
    return { lines };
  }
  const m = runGh(['pr', 'merge', String(pr.number), '--squash']);
  if (m.ok) {
    lines.push(`[flow] 动作：合并 #${pr.number}（复核绿 + CI 全绿 + merge/auto + MERGEABLE）：gh pr merge ${pr.number} --squash 成功`);
  } else {
    rec.mergeBlocked = true;
    rec.pendingShuai = { kind: 'merge-blocked', reason: '合并失败——打回人工，等你 标签停手不重试' };
    blockToHuman(lines, pr, `gh pr merge 失败：${m.error}`, args, repo);
  }
  return { lines };
}

// 过渡垫片（#498 根治前）：派单时 merge-policy 只写在 worktree 卡备注（dao.mjs dispatchComment），
// 而卡备注是人在用的自由文本，一覆盖就没了。流转器首次发现某 PR 时从对应 worktree 的 comment
// 解析 merge-policy，当场回填 merge/auto 标签到 PR——把易失字段当一次性传递介质，落到不易失的
// GitHub 标签上（回填后真相源就是标签，备注之后被覆写也不影响）。
// 只做一次（rec.policyBackfilled）；merge-policy:manual 或读不到 → 不打标签（安全默认 = 等用户终审）；
// 已存在的标签（帅手工打的）优先，不覆盖。失败方向必须落在安全一侧（不打 = 只是慢）。
function backfillMergePolicy(pr, rec, source, args) {
  const lines = [];
  if (rec.policyBackfilled) return { lines };
  if (hasLabel(pr, MERGE_AUTO_LABEL)) {
    rec.policyBackfilled = true; // 已有标签（帅手工优先），不重复打
    return { lines };
  }
  const wts = source.orcaWorktrees();
  if (!wts.ok) {
    return { lines: [`[flow] NO_TARGETS：读 worktree 列表失败（${wts.error}）——merge-policy 回填没查成`], noTargets: true };
  }
  const wt = wts.worktrees.find(w => w.branch === `refs/heads/${pr.headRefName}`);
  if (!wt) {
    rec.policyBackfilled = true; // 找不到 worktree（外部起的/存量树）——不打标签，安全默认
    return { lines };
  }
  const policy = mergePolicyFromComment(wt.comment);
  if (policy !== 'auto') {
    rec.policyBackfilled = true; // manual / 备注被覆写成人话 / 读不到 → 不打标签（#478 Q1 默认：忘勾自动合只是慢）
    return { lines };
  }
  if (args.dryRun) {
    rec.policyBackfilled = true;
    lines.push(`[flow] 动作：回填 merge/auto 标签 #${pr.number}（worktree comment 读 merge-policy:auto）→ gh pr edit ${pr.number} --add-label ${MERGE_AUTO_LABEL}`);
    return { lines };
  }
  const r = runGh(['pr', 'edit', String(pr.number), '--add-label', MERGE_AUTO_LABEL]);
  if (r.ok) {
    rec.policyBackfilled = true;
    lines.push(`[flow] 动作：回填 merge/auto 标签 #${pr.number}（worktree comment 读 merge-policy:auto）`);
  } else {
    lines.push(`[flow] 报帅：回填 merge/auto 标签 #${pr.number} 失败：${r.error}——下轮重试`);
  }
  return { lines };
}

// 合并权链运行时观察（#497 第四轮：断链报警——治「这一单断了」）
// 断链有两种（见 PR 正文表）：这一单断了（comment 有 merge-policy:auto 但 PR 无标签超 N 分钟）
// 由本观察报警；所有单都会断（dispatch 改了产出格式）由契约测试报警（治第二种）。
// 输出三态必须能分开（仓规）：
//   1 有 merge-policy 树且对应在途 PR 标签齐 → [flow] OK 合并权链：N 棵 auto 树标签齐（OK 前缀，不推 exit）
//   2 一棵带 merge-policy 字段的树都没有 → [flow] 提醒：合并权链没扫到样本（每状态文件一次）——
//     不是「全部正常」，可能是没人走 dao.mjs dispatch，也可能是格式变了
//   3 读不到 worktree 列表 → NO_TARGETS（沿用现有口径）
function chainWatch(source, open, records, state, args) {
  const lines = [];
  const wts = source.orcaWorktrees();
  if (!wts.ok) return { lines: [`[flow] NO_TARGETS：读 worktree 列表失败（${wts.error}）——合并权链观察没查成`], noTargets: true };
  // 带 merge-policy 字段的树 = dispatch 产出的证据（auto 或 manual 都算——manual 也说明链活着）
  const policyTrees = wts.worktrees.filter(w => mergePolicyFromComment(w.comment) != null);
  const autoTrees = policyTrees.filter(w => mergePolicyFromComment(w.comment) === 'auto');
  if (policyTrees.length === 0) {
    if (!state.chainWatchNoSampleReported) {
      state.chainWatchNoSampleReported = true;
      lines.push('[flow] 提醒：合并权链没扫到样本（0 棵带 merge-policy 的树——可能没人走 dao.mjs dispatch，也可能格式变了；契约测试兜格式，本行兜「整链没活动」）');
    }
    return { lines };
  }
  const now = Date.now();
  let healthy = 0;
  const broken = [];
  for (const wt of autoTrees) {
    const branch = String(wt.branch || '').replace(/^refs\/heads\//, '');
    const pr = open.find(p => p.headRefName === branch);
    if (!pr) continue; // 不在途（已合并/关闭/外部树）——无需看标签
    const rec = records[pr.number];
    if (hasLabel(pr, MERGE_AUTO_LABEL)) {
      if (rec?.chainBrokenSince) rec.chainBrokenSince = null; // 标签到位，链恢复
      healthy += 1;
      continue;
    }
    // 有 auto 树但 PR 无标签：记起始时刻，超 N 分钟报警（回填垫片失效/gh 失败/flow 没跑过窗口）
    if (rec) {
      if (!rec.chainBrokenSince) rec.chainBrokenSince = now;
      if (now - rec.chainBrokenSince > CHAIN_BROKEN_MS) {
        broken.push(pr.number);
        rec.pendingShuai = { kind: 'chain-broken', reason: '合并权链断：回填失败（comment 是 merge-policy:auto 但 PR 无 merge/auto 标签超 15 分钟）' };
      }
    }
  }
  for (const n of broken) lines.push(`[flow] 待帅处置：#${n}（合并权链断：回填失败）`);
  if (broken.length === 0) {
    lines.push(`[flow] OK 合并权链：${healthy} 棵 auto 树标签齐`);
  }
  return { lines };
}

// ══════════════════════════════════════════════════════════════════════
// 原生消息处理（live：check --wait 投递；快照：orca-messages.json）
// ══════════════════════════════════════════════════════════════════════

// 处理一批信箱消息：worker_done → 记 dispatch 映射（门铃，GitHub 重放判态）；
// escalation → 上帅记账（停手叫人，映射到 PR 的进 escalations 由 PR 循环落地）；
// question → 报帅待应答；其余 → 报帅备忘。
// 返回 { wakeSource, lines, escalations }。
function processNativeMessages(messages, state, dispatchMap, args) {
  const lines = [];
  const escalations = [];
  let wakeSource = null;
  for (const m of messages || []) {
    const type = String(m.type || '').toLowerCase();
    const taskId = m.task_id || m.taskId || m.payload?.taskId || null;
    const dispatchId = m.dispatch_id || m.dispatchId || null;
    if (type === 'worker_done') {
      wakeSource = wakeSource || 'native:worker_done';
      if (taskId && dispatchId) {
        state.dispatchCache = state.dispatchCache || {};
        if (!state.dispatchCache[taskId]) {
          state.dispatchCache[taskId] = dispatchId;
          lines.push(`[flow] 门铃：worker_done（task=${taskId}，dispatch=${dispatchId}）——触发 GitHub 重放`);
        }
      }
      continue;
    }
    if (type === 'escalation') {
      wakeSource = wakeSource || 'native:escalation';
      const pr = taskId ? dispatchMap.prByTaskId[taskId] : null;
      const reason = `worker 上帅：${m.subject || ''}${m.body ? `（${String(m.body).slice(0, 120)}）` : ''}`;
      if (pr) {
        escalations.push({ pr, reason });
        lines.push(`[flow] 报帅：上帅 #${pr}（${reason}）——停手，不再自动流转`);
      } else {
        lines.push(`[flow] 报帅：收到 escalation（task=${taskId || '?'}）：${reason}——待帅处置（映射不出 PR，退回 GitHub 通道）`);
      }
      continue;
    }
    if (type === 'question') {
      wakeSource = wakeSource || 'native:question';
      lines.push(`[flow] 报帅：工人提问（task=${taskId || '?'}）：${m.subject || ''}——帅用 orca orchestration reply --id ${m.id} 应答`);
      continue;
    }
    // 其他类型（status/merge_ready 等）：报帅备忘，不吞
    lines.push(`[flow] 报帅：信箱消息（type=${type}，task=${taskId || '?'}）：${String(m.subject || '').slice(0, 120)}——请帅处理`);
  }
  return { wakeSource, lines, escalations };
}

// ══════════════════════════════════════════════════════════════════════
// 状态文件（游标缓存，GitHub 才是真相源）
// ══════════════════════════════════════════════════════════════════════

function loadState(path) {
  if (!existsSync(path)) return { version: 1, inventoried: false, round: 0, dispatchCache: {}, chainWatchNoSampleReported: false, records: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (!s.records || typeof s.records !== 'object') throw new Error('records 缺失');
    return {
      version: 1, inventoried: !!s.inventoried, round: Number(s.round) || 0,
      dispatchCache: s.dispatchCache || {}, chainWatchNoSampleReported: !!s.chainWatchNoSampleReported,
      records: s.records,
    };
  } catch (e) {
    return { version: 1, inventoried: false, round: 0, dispatchCache: {}, chainWatchNoSampleReported: false, records: {}, loadError: String(e.message) };
  }
}

function saveState(path, state) {
  writeJsonAtomic(path, state);
}

function freshRecord(pr) {
  return {
    pr, seenComments: {}, seenReviews: {}, pendingShuai: null, reportedMalformed: {},
    reportedStale: false, actedOn: null, reviewer: null, escalated: null,
    workerDispatch: null, // 当前工人 dispatch 上下文（返工投递后更新）
    policyBackfilled: false, // merge-policy 回填只做一次（#498 过渡垫片）
    chainBrokenSince: null,  // 合并权链断计时（comment auto 但 PR 无标签的起始时刻）
    mergeAttempted: false, mergeBlocked: false, stateSince: Date.now(),
  };
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
    // 合并门数据：labels + CI rollup + mergeable + headRefOid（合并前重查一次，防判绿后被撞冲突；
    // headRefOid 供第四条「判绿的 commit == 当前 HEAD」比对，见 greenCommitVerdict）
    getPrGate(number) {
      const r = runGh(['pr', 'view', String(number), '--json', 'labels,isDraft,statusCheckRollup,mergeable,mergeStateStatus,headRefOid']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, pr: r.json };
    },
    getComments(number) {
      const r = runGh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate']);
      if (!r.ok) return { ok: false, error: r.error };
      const comments = (Array.isArray(r.json) ? r.json : []).map(c => ({
        id: c.id, body: c.body || '', createdAt: c.created_at || c.createdAt || '',
      }));
      return { ok: true, comments };
    },
    getReviews(number) {
      const r = runGh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate']);
      if (!r.ok) return { ok: false, error: r.error };
      const reviews = (Array.isArray(r.json) ? r.json : []).map(rv => ({
        id: rv.id, body: rv.body || '', submittedAt: rv.submitted_at || '', url: rv.html_url || null,
        commitId: rv.commit_id || null, // 第四条：判绿的 commit 必须等于当前 HEAD（#497 第八轮）
      }));
      return { ok: true, reviews };
    },
    // task-list 镜像（dispatch 寻址）：spec 含任务书，PR 号从 spec 提取
    orcaTasks() {
      const r = runOrca(['orchestration', 'task-list', '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      const tasks = unwrap(r.json, 'tasks', 'tasks');
      if (!Array.isArray(tasks)) return { ok: false, error: 'task-list 结构不认识' };
      // dispatchId 不随 task-list 给全，按需 dispatch-show（慢路径只发生在投递时）
      const out = tasks.map(t => ({ id: t.id || t.taskId, spec: t.spec || t.title || '', dispatchId: t.dispatch_id || t.dispatchId || null, agentTerminalHandle: t.agentTerminalHandle || t.agent_terminal_handle || null }));
      return { ok: true, tasks: out };
    },
    // worktree 卡备注（#498 过渡垫片读 merge-policy 用；按 branch 匹配）
    orcaWorktrees() {
      const r = runOrca(['worktree', 'list', '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      const wts = unwrap(r.json, 'worktrees', 'worktrees');
      if (!Array.isArray(wts)) return { ok: false, error: 'worktree list 结构不认识' };
      return { ok: true, worktrees: wts.map(w => ({ id: w.id, branch: w.branch || w.git?.branch || null, comment: w.comment || w.git?.comment || null })) };
    },
    dispatchIdFor(taskId) {
      const r = runOrca(['orchestration', 'dispatch-show', '--task', taskId, '--json']);
      if (!r.ok) return null;
      return dispatchIdFromDispatchShow(r.json) || null;
    },
    // dispatch id → 终端 handle（#480 实测纠正：投递走 worker-start --terminal，不用 send --to dispatch）
    workerHandleFor(dispatchId) {
      const r = runOrca(['orchestration', 'worker-show', '--dispatch', dispatchId, '--json']);
      if (!r.ok) return null;
      return handleFromWorkerShow(r.json);
    },
    // live 门铃：check --wait（阻塞替代 sleep）。返回 { ok, messages, deliveryId }；
    // 超时（count 0）也是正常 checkpoint，不是失败。
    checkWait(ackId, timeoutMs) {
      const args = ['orchestration', 'check', '--wait', '--types', 'worker_done,escalation,question',
        '--timeout-ms', String(timeoutMs), '--json'];
      if (ackId) args.push('--ack', ackId);
      const r = runCmd('orca', args, timeoutMs + CHECK_KEEPALIVE_SLACK_MS);
      if (!r.ok) return { ok: false, error: r.error };
      let json;
      try { json = JSON.parse(r.out); } catch (e) { return { ok: false, error: `check --wait 输出不是 JSON：${e.message}` }; }
      const result = json?.result ?? json ?? {};
      const messages = result.messages ?? result.delivery?.messages ?? result.batch?.messages ?? (Array.isArray(result) ? result : []);
      const deliveryId = result.delivery_id ?? result.deliveryId ?? result.delivery?.id ?? result.batch?.id ?? result.ack ?? json.delivery_id ?? null;
      return { ok: true, messages: Array.isArray(messages) ? messages : [], deliveryId: deliveryId || null, timedOut: (messages?.length || 0) === 0 };
    },
    runUse(runId) {
      const r = runOrca(['orchestration', 'run-use', '--id', runId, '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true };
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
    getPrGate(number) {
      // 快照优先 pr-<N>-gate.json（可只含 labels/isDraft/statusCheckRollup/mergeable），
      // 没有则从 pr-<N>.json 取（老夹具无这些字段时按缺失处理）
      const r = readJson(join(roundDir, `pr-${number}-gate.json`));
      if (r.ok) return { ok: true, pr: r.json };
      const r2 = readJson(join(roundDir, `pr-${number}.json`));
      if (!r2.ok) return { ok: true, pr: {} };
      return { ok: true, pr: r2.json };
    },
    getComments(number) {
      const r = readJson(join(roundDir, `pr-${number}-comments.json`));
      return r.ok ? { ok: true, comments: r.json } : { ok: true, comments: [] };
    },
    getReviews(number) {
      const r = readJson(join(roundDir, `pr-${number}-reviews.json`));
      if (!r.ok) return { ok: true, reviews: [] };
      return {
        ok: true,
        reviews: r.json.map(rv => ({
          id: rv.id, body: rv.body,
          submittedAt: rv.submitted_at || rv.submittedAt,
          url: rv.html_url || `https://github.com/${repo}/pull/${number}#pullrequestreview-${rv.id}`,
          commitId: rv.commit_id || rv.commitId || null, // 第四条（#497 第八轮）：快照夹具可带 commit_id/commitId
        })),
      };
    },
    orcaTasks() {
      const r = readJson(join(roundDir, 'orca-tasks.json'));
      if (!r.ok) {
        if (String(r.error).includes('缺文件')) return { ok: true, tasks: [] }; // 无夹具 = 无数据
        return { ok: false, error: r.error }; // 文件在但读不了 → 没查成（不把坏数据当没数据）
      }
      const tasks = Array.isArray(r.json) ? r.json : unwrap(r.json, 'tasks', 'tasks') || [];
      const out = tasks.map(t => ({ id: t.id || t.taskId, spec: t.spec || t.title || '', dispatchId: t.dispatchId || t.dispatch_id || null, agentTerminalHandle: t.agentTerminalHandle || t.agent_terminal_handle || null }));
      return { ok: true, tasks: out };
    },
    orcaWorktrees() {
      const r = readJson(join(roundDir, 'orca-worktrees.json'));
      if (!r.ok) {
        if (String(r.error).includes('缺文件')) return { ok: true, worktrees: [] }; // 无夹具 = 无数据
        return { ok: false, error: r.error }; // 文件在但读不了 → 没查成（链观察态 3）
      }
      const wts = unwrap(r.json, 'worktrees', 'worktrees') || [];
      if (!Array.isArray(wts)) return { ok: false, error: 'orca-worktrees.json 结构不认识' };
      return { ok: true, worktrees: wts.map(w => ({ id: w.id, branch: w.branch || w.git?.branch || null, comment: w.comment || w.git?.comment || null })) };
    },
    dispatchIdFor() { return null; },
    workerHandleFor(dispatchId) {
      // 快照：orca-workers.json（worker-show 镜像）为可选；夹具习惯直接在 orca-tasks.json 条目带 agentTerminalHandle
      const r = readJson(join(roundDir, 'orca-workers.json'));
      if (!r.ok || !Array.isArray(r.json)) return null;
      const hit = r.json.find(w => (w.dispatchId || w.dispatch_id) === dispatchId);
      return hit ? (hit.agentTerminalHandle || hit.agent_terminal_handle || null) : null;
    },
    checkWait() { return { ok: true, messages: [], deliveryId: null, timedOut: true }; },
    runUse() { return { ok: true }; },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 动作执行
// ══════════════════════════════════════════════════════════════════════

function executeAction(action, pr, toml, source, rec, args) {
  const repo = args.repo || 'thoerwink8/windsurf-dao';

  if (action.kind === 'start-reviewer') {
    const cls = classifyPr(pr);
    if (!cls.model) {
      return { ok: false, error: `PR #${pr.number} 缺 model/* 标签（有 type/${cls.taskType || '?'}），不能按选型序确定性选审官`, needsReport: 'report-unknown' };
    }
    const reviewer = pickReviewer(toml, cls.model, cls.taskType);
    if (!reviewer) {
      return { ok: false, error: '按 docs/model-routing.toml 选不出审官（审查角色模型为空）', needsReport: 'report-unknown' };
    }
    const launch = reviewerLaunch(reviewer);
    if (!launch) {
      return { ok: false, error: `审官 ${reviewer.id} 的 provider 无启动配方（${reviewer.provider}）`, needsReport: 'report-unknown' };
    }
    const label = reviewerLabel(reviewer);
    const taskBook = reviewTaskBook(pr, label);
    // 任务卡 spec 带「审官任务」标记 + #PR 号（dispatch 寻址与 task-list 反查用）
    const cardName = `#${pr.number} - ${label}`;
    const taskSpec = `审官任务：${cardName}。任务 PR：#${pr.number} ${pr.title}。${taskBook.replace(/\r?\n/g, ' ').slice(0, 400)}`;
    const steps = [
      `orca orchestration task-create --spec "<审官任务：${cardName}，任务 PR：#${pr.number}>" --json`,
    ];
    if (launch.twoStep) {
      steps.push(
        `orca worktree create --parent-worktree branch:${pr.headRefName} --name "${cardName}" --setup skip --json`,
        `orca terminal create --worktree <新建审官卡 id> --command "${launch.command}" --json`,
        `orca orchestration worker-start --task <task_id> --worktree <审官卡 id> --terminal <handle> --json`,
      );
    } else {
      steps.push(`orca orchestration worker-start --task <task_id> --worktree current --agent ${launch.agent} --model ${launch.model} --json`);
    }
    if (args.dryRun) {
      return {
        ok: true, dry: true,
        line: `[flow] 动作：起审官 #${pr.number}（${label}，model=${reviewer.id}，provider=${reviewer.provider}）：task-create + worker-start`
          + '\n' + steps.map(s => '  ' + s).join('\n')
          + '\n  ' + '注入复核任务书：' + taskBook.replace(/\n/g, '\n  '),
      };
    }
    // live：task-create → worker-start（dispatch 身份硬要求；Claude 族按 routing 两步收口）
    const tc = runOrca(['orchestration', 'task-create', '--spec', taskSpec, '--json']);
    if (!tc.ok) return { ok: false, error: `起审官 task-create 失败：${tc.error}`, needsReport: 'report-unknown' };
    const taskId = taskIdFromTaskCreate(tc.json);
    if (!taskId) return { ok: false, error: '起审官 task-create 成功响应但缺 task id（结构畸形）', needsReport: 'report-unknown' };
    let dispatchId = null;
    if (launch.twoStep) {
      const wtR = runOrca(['worktree', 'create', '--parent-worktree', `branch:${pr.headRefName}`, '--name', cardName, '--setup', 'skip', '--json']);
      if (!wtR.ok) return { ok: false, error: `起审官卡失败：${wtR.error}`, needsReport: 'report-unknown' };
      const wtId = worktreeIdFromWorktreeCreate(wtR.json);
      const termR = runOrca(['terminal', 'create', '--worktree', wtId, '--command', launch.command, '--json']);
      if (!termR.ok) return { ok: false, error: `起审官终端失败：${termR.error}`, needsReport: 'report-unknown' };
      const handle = terminalHandleFromTerminalCreate(termR.json);
      const wsR = runOrca(['orchestration', 'worker-start', '--task', taskId, '--worktree', wtId, '--terminal', handle, '--json']);
      if (!wsR.ok) return { ok: false, error: `起审官 worker-start 失败：${wsR.error}`, needsReport: 'report-unknown' };
      dispatchId = dispatchIdFromWorkerStart(wsR.json);
    } else {
      const wsR = runOrca(['orchestration', 'worker-start', '--task', taskId, '--worktree', 'current', '--agent', launch.agent, '--model', launch.model, '--json']);
      if (!wsR.ok) return { ok: false, error: `起审官 worker-start 失败：${wsR.error}`, needsReport: 'report-unknown' };
      dispatchId = dispatchIdFromWorkerStart(wsR.json);
    }
    return {
      ok: true, taskId, dispatchId, label, taskBook,
      line: `[flow] 动作：起审官 #${pr.number}（${label}，model=${reviewer.id}）：task-create + worker-start（dispatch=${dispatchId || '?'}）`,
    };
  }

  if (action.kind === 'inject-rework') {
    const instruction = reworkInstruction(pr, action.red, action.round, action.reviewUrl || null);
    const map = buildDispatchMap(source, { dispatchCache: {} });
    const dispatchId = workerDispatchFor(map, pr.number, rec);
    if (!dispatchId) {
      if (args.dryRun) {
        // 预览-阻塞：可见但不落闸（旧观察 1 口径——预览不改变值守状态）
        return { ok: true, dry: true, line: `[flow] 预览-阻塞：#${pr.number}（返工注入——投递目标解析失败：找不到工人 dispatch）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
      }
      return { ok: false, error: `找不到 PR #${pr.number} 工人 dispatch（task-list 里 spec 含 #${pr.number} 的非审官任务应为唯一候选）——待帅转交返工指令`, needsReport: 'reviewer-unfound' };
    }
    const target = resolveDeliveryHandle(source, map, dispatchId);
    if (!target.ok) {
      if (args.dryRun) {
        return { ok: true, dry: true, line: `[flow] 预览-阻塞：#${pr.number}（返工注入——投递目标解析失败：${target.error}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
      }
      return { ok: false, error: target.error, needsReport: 'reviewer-unfound' };
    }
    const taskSpec = `返工任务：#${pr.number} 第 ${action.round} 轮返工。${instruction.replace(/\r?\n/g, ' ')}`;
    if (args.dryRun) {
      return {
        ok: true, dry: true,
        line: `[flow] 动作：返工注入 #${pr.number}（第 ${action.round} 轮，红 ${action.red} 项）：task-create + worker-start --task <新> --terminal ${target.handle}（推给闲置工人，非信箱消息）`
          + '\n  ' + `orca orchestration task-create --spec "<返工任务：#${pr.number} 第 ${action.round} 轮>" --json`
          + '\n  ' + `orca orchestration worker-start --task <task_id> --terminal ${target.handle} --json`
          + '\n  ' + instruction.replace(/\n/g, '\n  '),
      };
    }
    const d = deliverFollowUp(taskSpec, target.handle, args);
    if (!d.ok) return { ok: false, error: d.error, needsReport: 'reviewer-unfound' };
    if (d.dispatchId) rec.workerDispatch = d.dispatchId; // 新 dispatch 上下文（后续返工寻址用）
    return { ok: true, taskId: d.taskId, dispatchId: d.dispatchId, line: `[flow] 动作：返工注入 #${pr.number}（第 ${action.round} 轮，红 ${action.red} 项）：task-create + worker-start --terminal ${target.handle}（dispatch=${d.dispatchId || '?'}）` };
  }

  if (action.kind === 'inject-recheck') {
    const instruction = recheckInstruction(pr, action.round, action.reviewerLabel || '审官');
    const map = buildDispatchMap(source, { dispatchCache: {} });
    const dispatchId = reviewerDispatchFor(map, pr.number, rec);
    if (!dispatchId) {
      // reviewer-unfound 是结构性卡住（流转器没起过审官 / task-list 里没有审官卡）——
      // dry-run 也走失败路径写 pendingShuai 常驻，不短路成预览（旧四轮复核红 1 口径）
      return { ok: false, error: '找不到审官 dispatch（未记录起审官 dispatchId，task-list 里也没有审官任务卡）——待帅接手复核', needsReport: 'reviewer-unfound' };
    }
    const target = resolveDeliveryHandle(source, map, dispatchId);
    if (!target.ok) {
      return { ok: false, error: target.error, needsReport: 'reviewer-unfound' };
    }
    const taskSpec = `审官任务：复核 #${pr.number} 第 ${action.round} 轮返工。${instruction.replace(/\r?\n/g, ' ')}`;
    if (args.dryRun) {
      return {
        ok: true, dry: true,
        line: `[flow] 动作：复核注入 #${pr.number}（第 ${action.round} 轮返工后）：task-create + worker-start --task <新> --terminal ${target.handle}（推给审官，非信箱消息）`
          + '\n  ' + `orca orchestration task-create --spec "<审官任务：复核 #${pr.number}>" --json`
          + '\n  ' + `orca orchestration worker-start --task <task_id> --terminal ${target.handle} --json`
          + '\n  ' + instruction.replace(/\n/g, '\n  '),
      };
    }
    const d = deliverFollowUp(taskSpec, target.handle, args);
    if (!d.ok) return { ok: false, error: d.error, needsReport: 'reviewer-unfound' };
    if (rec.reviewer) rec.reviewer.dispatchId = d.dispatchId || rec.reviewer.dispatchId; // 新 dispatch 上下文
    return { ok: true, taskId: d.taskId, dispatchId: d.dispatchId, line: `[flow] 动作：复核注入 #${pr.number}（第 ${action.round} 轮返工后）：task-create + worker-start --terminal ${target.handle}（dispatch=${d.dispatchId || '?'}）` };
  }

  return { ok: false, error: `未知动作 ${action.kind}` };
}

// ══════════════════════════════════════════════════════════════════════
// heartbeat（流转器停摆判据的数据源；看门狗在 #471 读它）
// ══════════════════════════════════════════════════════════════════════

function writeHeartbeat(args, state, round, wakeSource, pendingCount, prs) {
  const hb = {
    ts: new Date().toISOString(),
    round,
    lastWakeSource: wakeSource || 'startup',
    pendingCount,
    prs,
  };
  try {
    writeJsonAtomic(args.heartbeatFile, hb);
  } catch (e) {
    // heartbeat 写失败不崩值守（报一行即可）；看门狗会因 ts 不更新而报警
    console.log(`[flow] heartbeat 写失败：${String(e.message || e).slice(0, 160)}`);
  }
}

function heartbeatPrs(open, records) {
  const now = Date.now();
  return open.map(p => {
    const rec = records[p.number];
    return {
      number: p.number,
      state: rec?.derivedState || 'working',
      sinceMs: rec?.stateSince ? now - rec.stateSince : null,
    };
  });
}

// ══════════════════════════════════════════════════════════════════════
// --explain：对每个在途 PR 输出「当前态 + 下一步该做什么 + 卡在哪」，帅照着人肉执行
// ══════════════════════════════════════════════════════════════════════

const STATE_NEXT = {
  working: '工人开工中——等完工信号（worker_done 门铃 / GitHub 完工 comment）。卡点：超 24h 无动静需帅查工位。',
  'awaiting-review': '已完工无审官——下一步：起审官（task-create + worker-start）。卡点：起审官失败时见待帅处置。',
  'rework-needed': '审官判红——下一步：task-create（返工任务书）+ worker-start --terminal <工人 handle> 推返工。卡点：找不到工人 dispatch/handle 时待帅转交。',
  'awaiting-recheck': '返工完成——下一步：task-create（复核任务书）+ worker-start --terminal <审官 handle> 推复核。卡点：找不到审官 dispatch/handle 时待帅接手。',
  approved: '复核绿——下一步：合并三条件检查（CI 全绿 + merge/auto 标签 + mergeable 重查）。卡点：见下方 gate 原因。',
  switch: '审官标注「同一处未修好」——下一步：帅决定换人（换人决策归帅，不自动换）。',
  'shang-shuai': '上帅（上帅：行 / 六轮兜底 / escalation）——停手。下一步：帅处置；不再自动流转。',
  error: '判定行缺失/格式不符——报帅分诊，不猜红绿。',
};

function explainLine(pr, derived, rec, gateReason) {
  const lines = [`[explain] PR #${pr.number} ${pr.title}：state=${derived.state}${derived.redReviews ? `（红 ${derived.redReviews} 轮）` : ''}`];
  lines.push(`  当前态：${STATE_NEXT[derived.state] || derived.state}`);
  if (rec?.pendingShuai?.reason) lines.push(`  卡在哪：${rec.pendingShuai.reason}`);
  else if (derived.state === 'approved' && gateReason) lines.push(`  卡在哪：${gateReason}`);
  if (derived.state === 'approved') {
    lines.push('  人工可执行：gh pr view ' + pr.number + ' --json statusCheckRollup,mergeable,mergeStateStatus 自查三条件；齐了跑 gh pr merge ' + pr.number + ' --squash');
  }
  return lines;
}

// ══════════════════════════════════════════════════════════════════════
// 一轮扫描
// ══════════════════════════════════════════════════════════════════════

// 一轮：返回 { events, noTargets, infraError, hb }；events 是输出行。hb = heartbeat 数据
// （wakeSource/pendingCount/prs），早退（读不到数据）也带——看门狗靠「ts 不更新」区分
// 「流转器死了」和「流转器活着但没查成」。
function processOneRound(source, state, args, wakeSource, nativeMessages) {
  const events = [];
  const routing = loadRouting();
  const toml = routing.ok ? routing.toml : null;
  if (!routing.ok) {
    return {
      events: [`[flow] NO_TARGETS：${routing.error}——本轮没查成`], noTargets: true, infraError: true,
      hb: { wakeSource: wakeSource || 'github-poll', pendingCount: 0, prs: [] },
    };
  }

  // 原生消息先处理（escalation → 上帅记账；worker_done → dispatch 缓存）
  const dispatchMap = buildDispatchMap(source, state);
  const native = processNativeMessages(nativeMessages || [], state, dispatchMap, args);
  for (const l of native.lines) events.push(l);
  wakeSource = wakeSource || native.wakeSource || 'github-poll';

  const list = source.listOpenPrs();
  if (!list.ok) {
    return {
      events: [`[flow] NO_TARGETS：${list.error}——本轮没查成`], noTargets: true, infraError: true,
      hb: { wakeSource, pendingCount: 0, prs: [] },
    };
  }
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
      events.push(`[flow] 退役：PR #${rec.pr} MERGED——完工闭环收口（合并即归档归帅）`);
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

    const commentsR = source.getComments(pr.number);
    const reviewsR = source.getReviews(pr.number);
    if (!commentsR.ok || !reviewsR.ok) {
      noTargets = true;
      events.push(`[flow] NO_TARGETS：读 PR #${pr.number} 信号失败（${commentsR.ok ? '' : commentsR.error}${reviewsR.ok ? '' : reviewsR.error}）——本轮没查成`);
      continue;
    }
    const comments = commentsR.comments || [];
    const reviews = reviewsR.reviews || [];

    // merge-policy 回填（#498 过渡垫片）：首次发现 PR 时读 worktree 卡备注回填 merge/auto 标签；
    // 幂等（rec.policyBackfilled），不覆盖已存在标签，manual/读不到落安全默认。
    const policy = backfillMergePolicy(pr, rec, source, args);
    for (const l of policy.lines) events.push(l);
    if (policy.noTargets) noTargets = true;

    // 判定行缺失/格式不符的 review：逐条报帅（「没查成」，非「无需流转」），不猜红绿。
    // 带标注行（上帅：/同一处未修好/新引入）的 review 不算缺判定行——标注本身就是要流转器做的事。
    for (const rv of reviews) {
      if (rec.seenReviews[rv.id]) continue;
      if (rv.id == null) continue;
      const v = judgmentFromReview(rv.body);
      const ann = reviewAnnotations(rv.body);
      if (ann.shangShuai || ann.sameSpot || ann.newIntroduced) continue;
      if (v.kind && !v.malformed) continue;
      if (!rec.reportedMalformed[rv.id]) {
        rec.reportedMalformed[rv.id] = true;
        events.push(`[flow] 报帅：判定行缺失/格式不符 #${pr.number}（review id=${rv.id}，无「判定/复核结论」行或红绿都判不出）——本脚本不能确定红绿，没查成，请帅分诊`);
        rec.pendingShuai = { kind: 'error', reason: '判定行缺失/格式不符待帅分诊' };
      }
    }

    // 新信号（完工 comment + 门铃完工 + 全部 review）按时间序重放推导当前态
    const all = orderedSignals(comments, reviews, nativeMessages, dispatchMap);
    const derivedRaw = deriveState(all);
    const fp = fingerprint(derivedRaw);
    let derived = derivedRaw;

    // escalation 上帅记账：消息已到 → 落账并强制 shang-shuai；无新 review 前一直强制，
    // 新 review（= 帅已处置）到达即恢复自动流转
    const newEsc = native.escalations.filter(e => e.pr === pr.number);
    if (newEsc.length > 0) {
      rec.escalated = { at: Date.now(), reason: newEsc[0].reason };
      rec.pendingShuai = { kind: 'shang-shuai', reason: newEsc[0].reason };
      derived = { ...derivedRaw, state: 'shang-shuai' };
    } else if (rec.escalated) {
      const newReview = (reviews || []).some(rv => rv.id != null && !rec.seenReviews[rv.id]);
      if (newReview && derivedRaw.state !== 'shang-shuai') {
        rec.escalated = null;
        rec.pendingShuai = null;
        events.push(`[flow] 上帅解除 #${pr.number}：新 review 到达，恢复自动流转`);
      } else {
        derived = { ...derivedRaw, state: 'shang-shuai' };
      }
    }

    rec.derivedState = derived.state;
    if (fp !== rec.actedOn) rec.stateSince = Date.now();

    // 复核绿：合并门每轮重查（CI/标签/mergeable 会无信号变化），不塞 fp 闸
    if (derived.state === 'approved') {
      if (args.explain) {
        const gateR = source.getPrGate(pr.number);
        const ci = gateR.ok ? ciState(gateR.pr.statusCheckRollup) : ciState(null);
        const gate = gateR.ok ? mergeGate(gateR.pr, ci) : { ok: false, reason: '读合并门数据失败' };
        for (const l of explainLine(pr, derived, rec, gate.ok ? null : gate.reason)) events.push(l);
      } else {
        const h = handleApproved(pr, rec, source, args, args.repo || 'thoerwink8/windsurf-dao');
        for (const l of h.lines) events.push(l);
        if (h.noTargets) noTargets = true;
        rec.actedOn = fp; // 防 stateSince 每轮重置；gate 每轮仍重查
      }
    } else if (args.explain) {
      for (const l of explainLine(pr, derived, rec, null)) events.push(l);
    }

    // 上帅首现报帅（fp 变化时一次；escalation 路径已在消息处理时报过）
    if (!args.explain && derived.state === 'shang-shuai' && rec.actedOn !== fp && rec.pendingShuai?.kind !== 'shang-shuai') {
      const why = derived.latestAnnotation?.shangShuai
        ? `审官上帅：${derived.latestAnnotation.shangShuai}`
        : derived.redReviews >= RED_FALLBACK_ROUNDS
          ? `六轮红判定兜底上帅（第 ${derived.redReviews} 次红判定，不自动换人）`
          : '上帅';
      events.push(`[flow] 报帅：上帅 #${pr.number}（${why}）——停止自动流转，不再自动流转该 PR`);
    }

    // 动作去重：同一指纹只动作一次（重启后存量重放同指纹不重复动作）；--explain 只读不动作
    if (!args.explain && rec.actedOn !== fp && derived.state !== 'approved') {
      // 自愈：新信号（fp 变化）到来即清除待帅记账给一次重试——fp 去重保证每个新信号至多重试一次
      if (rec.pendingShuai && derived.state !== 'shang-shuai' && derived.state !== 'switch' && derived.state !== 'error') rec.pendingShuai = null;
      const action = pendingAction(derived);
      if (action) {
        if (action.kind === 'unclassified') {
          // 白名单外状态：设计时没想到的组合——不静默，报警 + 待帅处置常驻（#497 第五轮）
          events.push(`[flow] 报帅：PR #${pr.number} 落入未归类状态 ${action.state}——设计时没想到的状态组合，请帅分诊`);
          rec.pendingShuai = { kind: 'unclassified', reason: `落入未归类状态 ${action.state}——设计时没想到的状态组合，请帅分诊` };
          rec.actedOn = fp;
        } else if (action.kind === 'report-switch') {
          events.push(`[flow] 报帅：换人 #${pr.number}（审官标注「同一处未修好」，第 ${action.round} 次红判定）——换人决策归帅，不自动换`);
          rec.pendingShuai = { kind: 'report-switch', reason: '审官标注「同一处未修好」待帅换人' };
          rec.actedOn = fp;
        } else if (action.kind === 'start-reviewer') {
          const exec = executeAction(action, pr, toml, source, rec, args);
          if (exec.ok) {
            events.push(exec.line);
            rec.pendingShuai = null;
            rec.actedOn = fp;
            if (action.kind === 'start-reviewer' && exec.taskId) {
              rec.reviewer = { taskId: exec.taskId, dispatchId: exec.dispatchId || null, label: exec.label, taskBook: exec.taskBook };
              state.dispatchCache = state.dispatchCache || {};
              if (exec.dispatchId) state.dispatchCache[exec.taskId] = exec.dispatchId;
            }
          } else {
            events.push(`[flow] 报帅：${exec.error}——fail-visible，不重试狂发（PR #${pr.number} 待帅处置）`);
            rec.pendingShuai = {
              kind: action.kind,
              reason: exec.needsReport === 'reviewer-unfound' ? '找不到投递目标 dispatch——待帅转交' : '起审官失败待帅接手（新信号到来自动重试一次）',
            };
            rec.actedOn = fp;
          }
        } else {
          const extra = {
            reviewUrl: action.kind === 'inject-rework' ? lastReviewUrl(reviews) : null,
            reviewerLabel: rec.reviewer?.label || null,
          };
          const exec = executeAction({ ...action, ...extra }, pr, toml, source, rec, args);
          if (exec.ok) {
            events.push(exec.line);
            rec.pendingShuai = null; // 动作成功：待帅记账清
            rec.actedOn = fp;
            if (exec.taskId && exec.dispatchId) {
              // 新投递的 dispatch 上下文记账（返工/复核后续寻址用）
              state.dispatchCache = state.dispatchCache || {};
              state.dispatchCache[exec.taskId] = exec.dispatchId;
            }
            if (exec.line.startsWith('[flow] 预览-阻塞')) {
              // dry-run 投递目标解析失败：本轮可见但不落 pendingShuai（预览不改变值守状态）
              thisRoundFailed.add(pr.number);
            }
          } else {
            events.push(`[flow] 报帅：${exec.error}——fail-visible，不重试狂发（PR #${pr.number} 待帅处置）`);
            rec.pendingShuai = {
              kind: action.kind,
              reason: exec.needsReport === 'reviewer-unfound' ? '找不到投递目标 dispatch——待帅转交' : '投递失败待帅接手（新信号到来自动重试一次）',
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

    // 待帅处置常驻行（红 3）：pendingShuai/approved/error/switch/shang-shuai/本轮失败每轮显形
    const reason = awaitingShuaiReason(derived, rec, thisRoundFailed.has(pr.number));
    if (reason) awaitingShuai.push({ pr: pr.number, reason });

    // 制度类 PR 停留超 24h 提醒一声（S5 拍板；正文含「体系类改动」段 = 制度类）
    if (isInstitutional(pr) && !rec.reportedStale && (pr.updatedAt || pr.createdAt)) {
      const age = Date.now() - Date.parse(pr.updatedAt || pr.createdAt);
      if (age > STALE_24H_MS) {
        rec.reportedStale = true;
        events.push(`[flow] 提醒：制度类 PR #${pr.number} ${pr.title} 已停留超 24h（updatedAt=${pr.updatedAt || pr.createdAt}）——请帅安排收口`);
      }
    }
  }

  for (const item of awaitingShuai) {
    events.push(`[flow] 待帅处置：#${item.pr}（${item.reason}）`);
  }

  // 合并权链观察（#497 第四轮断链报警）：有在途 PR 才看（链只在有活时才有意义）；explain 只读不加戏
  if (!args.explain && open.length > 0) {
    const watch = chainWatch(source, open, records, state, args);
    for (const l of watch.lines) events.push(l);
    if (watch.noTargets) noTargets = true;
  }

  // 退役记录清除（MERGED/CLOSED 的 PR 不再在途，状态文件不堆积）
  for (const key of Object.keys(records)) {
    if (records[key].retired) delete records[key];
  }

  // heartbeat：每轮结束原子写（格式契约见文件头 + PR 正文；看门狗 #471 读它）
  state.round = (Number(state.round) || 0) + 1;
  const hb = { wakeSource, pendingCount: awaitingShuai.length, prs: heartbeatPrs(open, records) };

  const scanned = open.length;
  const acted = events.some(e => e.startsWith('[flow] 动作') || e.startsWith('[flow] 预览-阻塞') || e.startsWith('[flow] 报帅') || e.startsWith('[flow] 提醒') || e.startsWith('[flow] 退役') || e.startsWith('[flow] 待帅处置') || e.startsWith('[flow] 打回人工') || e.startsWith('[flow] 门铃') || e.startsWith('[flow] 上帅解除'));
  if (!acted && !noTargets) {
    events.push(`[flow] OK 扫完 ${scanned} 个 PR，0 需流转`);
  }
  return { events, noTargets, infraError, hb };
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
export { deriveState, pendingAction, pickReviewer, orderedSignals, completionSignals, reviewSignals, isInstitutional, loadRouting, awaitingShuaiReason, extractPrsFromSpec, runCmd };

let args = null;
let anyEmitted = false;
let anyNoTargets = false;
let anyInfra = false;

export function main(argv = process.argv.slice(2)) {
  args = parseArgs(argv);
  if (args.snapshotDir) snapshotRun();
  else liveLoop();
  process.exit(anyInfra ? 3 : anyNoTargets ? 2 : anyEmitted ? 1 : 0);
}

function runOneRound(source, state, wakeSource, nativeMessages) {
  const round = processOneRound(source, state, args, wakeSource, nativeMessages);
  for (const line of round.events) {
    console.log(line);
    if (line.startsWith('[flow] NO_TARGETS')) anyNoTargets = true;
    else if (!line.startsWith('[flow] OK ')) anyEmitted = true;
  }
  if (round.infraError) anyInfra = true;
  if (!args.explain) {
    writeHeartbeat(args, state, state.round, round.hb.wakeSource, round.hb.pendingCount, round.hb.prs);
    saveState(args.stateFile, state); // explain 只读，不落状态
  }
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
  args.repo = repo;
  const waitMs = args.interval * 1000;
  console.log(`# flow live：check --wait ${args.interval}s 超时即 GitHub 兜底轮询（repo=${repo}${args.dryRun ? '，dry-run 不碰 orca/gh 写操作' : ''}${args.run ? `，run=${args.run}` : ''}）`);
  let lastAck = null;
  let pendingNative = [];
  for (;;) {
    const state = loadState(args.stateFile);
    if (state.loadError) {
      console.log(`[flow] NO_TARGETS：状态文件损坏（${state.loadError}）——本轮没查成，先修状态文件`);
      if (args.once) process.exit(2);
      sleep(waitMs);
      continue;
    }
    if (!state.inventoried) {
      console.log('[flow] 存量清点：首次启动，重放全部在途 PR 信号作为基线（prime 吞存量防线）');
      state.inventoried = true;
    }
    const source = makeLiveSource(repo);
    if (args.run) {
      const used = source.runUse(args.run);
      if (!used.ok) {
        console.log(`[flow] NO_TARGETS：run-use 失败（${used.error}）——本轮没查成`);
        if (args.once) process.exit(2);
        sleep(waitMs);
        continue;
      }
    }
    // 首轮先存量清点（不等门铃），之后上一轮 check --wait 收的消息先处理，再 GitHub 重放判态
    const wake = lastAck === null ? 'startup' : (pendingNative.length > 0 ? 'native' : 'github-poll');
    runOneRound(source, state, wake, pendingNative);
    pendingNative = [];
    if (args.once || args.explain) break;
    const waited = source.checkWait(lastAck, waitMs);
    if (!waited.ok) {
      console.log(`[flow] NO_TARGETS：check --wait 失败（${waited.error}）——本轮没查成`);
      lastAck = null;
      sleep(5000);
      continue;
    }
    lastAck = waited.deliveryId;
    // 门铃消息在下一轮处理（消息本身只负责唤醒 + 寻址，GitHub 重放判态）
    pendingNative = waited.messages || [];
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
    // 快照本轮的信箱投递（orca-messages.json，可缺省）
    const msgsR = readJson(join(dir, 'orca-messages.json'));
    const msgs = msgsR.ok && Array.isArray(msgsR.json) ? msgsR.json : [];
    runOneRound(source, state, msgs.length > 0 ? 'native' : 'github-poll', msgs);
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === import.meta.filename;
if (isDirectRun) {
  main();
}
